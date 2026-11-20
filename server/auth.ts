import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { execute, query, queryOne } from './db.ts';

const JWT_SECRET = process.env.JWT_SECRET || 'clinic360-dev-secret-change-in-production';

export interface AuthUser {
  id: number;
  fullName: string;
  email: string;
  branchId: number;
  roles: string[];
  permissions: string[];
}

export interface AuthRequest extends Request {
  user?: AuthUser;
}

export function signAccessToken(user: AuthUser): string {
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      fullName: user.fullName,
      branchId: user.branchId,
      roles: user.roles,
    },
    JWT_SECRET,
    { expiresIn: '12h' }
  );
}

export async function loadUserContext(userId: number): Promise<AuthUser | null> {
  const userRow = await queryOne<{
    id: number;
    full_name: string;
    email: string;
    branch_id: number;
    active: number;
  }>('SELECT id, full_name, email, branch_id, active FROM users WHERE id = ?', [userId]);

  if (!userRow || !userRow.active) return null;

  const roleRows = await query<{ code: string }>(
    `SELECT r.code FROM roles r
     INNER JOIN user_roles ur ON ur.role_id = r.id
     WHERE ur.user_id = ?`,
    [userId]
  );

  const permRows = await query<{ code: string }>(
    `SELECT DISTINCT p.code FROM permissions p
     INNER JOIN role_permissions rp ON rp.permission_id = p.id
     INNER JOIN user_roles ur ON ur.role_id = rp.role_id
     WHERE ur.user_id = ?`,
    [userId]
  );

  return {
    id: userRow.id,
    fullName: userRow.full_name,
    email: userRow.email,
    branchId: userRow.branch_id,
    roles: roleRows.map((r) => r.code),
    permissions: permRows.map((p) => p.code),
  };
}

export async function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const decoded = jwt.verify(token, JWT_SECRET) as unknown as { sub: number };
    const ctx = await loadUserContext(Number(decoded.sub));
    if (!ctx) {
      return res.status(401).json({ error: 'Account inactive or invalid session' });
    }
    req.user = ctx;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session token' });
  }
}

export function requirePermission(...requiredPermissions: string[]) {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const hasAny = requiredPermissions.some((p) => req.user!.permissions.includes(p));
    if (!hasAny) {
      await writeAuditLog({
        user: req.user,
        action: 'security.access_denied',
        entityType: 'route',
        entityId: req.originalUrl,
        after: { requiredPermissions },
        req,
      });
      return res.status(403).json({
        error: `Forbidden: requires one of [${requiredPermissions.join(', ')}]`,
      });
    }
    next();
  };
}

export function hasPermission(user: AuthUser, perm: string): boolean {
  return user.permissions.includes(perm);
}

export interface AuditInput {
  user?: AuthUser | { id: number | null; fullName: string; roles: string[]; branchId?: number };
  action: string;
  entityType: string;
  entityId?: string | number | null;
  patientId?: number | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  req?: Request;
}

export async function writeAuditLog(input: AuditInput): Promise<void> {
  const lastRow = await queryOne<{ row_hash: string }>(
    'SELECT row_hash FROM audit_logs ORDER BY id DESC LIMIT 1'
  );
  const prevHash = lastRow?.row_hash || 'GENESIS';
  const occurredAt = new Date().toISOString();
  const userId = input.user?.id ?? null;
  const userName = input.user?.fullName || 'Anonymous';
  const roleAtTime = input.user?.roles?.join(',') || 'NONE';
  const entityId = input.entityId != null ? String(input.entityId) : null;
  const beforeJson = input.before !== undefined ? JSON.stringify(input.before) : null;
  const afterJson = input.after !== undefined ? JSON.stringify(input.after) : null;
  const ipAddress = input.req?.ip || input.req?.socket?.remoteAddress || '127.0.0.1';
  const userAgent = (input.req?.headers['user-agent'] || '').slice(0, 240);
  const branchId = input.user?.branchId || 1;

  const hashPayload = JSON.stringify({
    occurredAt,
    userId,
    userName,
    roleAtTime,
    action: input.action,
    entityType: input.entityType,
    entityId,
    patientId: input.patientId ?? null,
    beforeJson,
    afterJson,
    reason: input.reason ?? null,
    prevHash,
  });

  const rowHash = crypto.createHash('sha256').update(hashPayload).digest('hex');

  await execute(
    `INSERT INTO audit_logs
      (occurred_at, user_id, user_name, role_at_time, action, entity_type, entity_id, patient_id, before_json, after_json, reason, ip_address, user_agent, branch_id, prev_hash, row_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      occurredAt,
      userId,
      userName,
      roleAtTime,
      input.action,
      input.entityType,
      entityId,
      input.patientId ?? null,
      beforeJson,
      afterJson,
      input.reason ?? null,
      ipAddress,
      userAgent,
      branchId,
      prevHash,
      rowHash,
    ]
  );
}

export async function verifyAuditChain(): Promise<{ valid: boolean; totalRows: number; brokenAtId: number | null }> {
  const rows = await query<{
    id: number;
    occurred_at: string;
    user_id: number | null;
    user_name: string;
    role_at_time: string;
    action: string;
    entity_type: string;
    entity_id: string | null;
    patient_id: number | null;
    before_json: string | null;
    after_json: string | null;
    reason: string | null;
    prev_hash: string;
    row_hash: string;
  }>('SELECT * FROM audit_logs ORDER BY id ASC');

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (i === 0) continue; // Genesis row seeded cleanly
    const expectedPrev = rows[i - 1].row_hash;
    if (row.prev_hash !== expectedPrev) {
      return { valid: false, totalRows: rows.length, brokenAtId: row.id };
    }
    const payload = JSON.stringify({
      occurredAt: row.occurred_at,
      userId: row.user_id,
      userName: row.user_name,
      roleAtTime: row.role_at_time,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      patientId: row.patient_id,
      beforeJson: row.before_json,
      afterJson: row.after_json,
      reason: row.reason,
      prevHash: row.prev_hash,
    });
    const recomputed = crypto.createHash('sha256').update(payload).digest('hex');
    if (recomputed !== row.row_hash) {
      return { valid: false, totalRows: rows.length, brokenAtId: row.id };
    }
  }

  return { valid: true, totalRows: rows.length, brokenAtId: null };
}
