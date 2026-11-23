import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { execute, getDialect, query, queryOne, withTransaction } from './db.ts';

if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  console.warn('[Clinic360] WARNING: JWT_SECRET is not set in production; using ephemeral process secret.');
}
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');

const revokedTokens = new Map<string, number>();

function pruneRevokedTokens() {
  const now = Date.now();
  for (const [jti, expiresAtMs] of revokedTokens.entries()) {
    if (expiresAtMs <= now) {
      revokedTokens.delete(jti);
    }
  }
}

export function revokeToken(jti?: string | null, expSeconds?: number | null) {
  if (!jti) return;
  pruneRevokedTokens();
  const expiresAtMs = expSeconds ? expSeconds * 1000 : Date.now() + 12 * 3600 * 1000;
  revokedTokens.set(jti, expiresAtMs);
}

export function isTokenRevoked(jti?: string | null): boolean {
  if (!jti) return false;
  const expiresAtMs = revokedTokens.get(jti);
  if (!expiresAtMs) return false;
  if (expiresAtMs <= Date.now()) {
    revokedTokens.delete(jti);
    return false;
  }
  return true;
}

export interface AuthUser {
  id: number;
  fullName: string;
  email: string;
  branchId: number;
  mustChangePassword: boolean;
  twoFaEnabled: boolean;
  roles: string[];
  permissions: string[];
}

export interface AuthRequest extends Request {
  user?: AuthUser;
  authJti?: string;
  authExp?: number;
}

export function signAccessToken(user: AuthUser): string {
  const jti = crypto.randomUUID();
  return jwt.sign(
    {
      sub: user.id,
      jti,
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
    must_change_password: number;
    two_fa_enabled: number;
  }>('SELECT id, full_name, email, branch_id, active, must_change_password, two_fa_enabled FROM users WHERE id = ?', [userId]);

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
    mustChangePassword: Boolean(userRow.must_change_password),
    twoFaEnabled: Boolean(userRow.two_fa_enabled),
    roles: roleRows.map((r) => r.code),
    permissions: permRows.map((p) => p.code),
  };
}

export function verifyAccessTokenDetails(token: string): { userId: number; jti?: string; exp?: number } {
  const decoded = jwt.verify(token, JWT_SECRET) as unknown as { sub: number; jti?: string; exp?: number };
  return {
    userId: Number(decoded.sub),
    jti: decoded.jti,
    exp: decoded.exp,
  };
}

export function verifyAccessToken(token: string): number {
  return verifyAccessTokenDetails(token).userId;
}

const PASSWORD_CHANGE_EXEMPT_PATHS = new Set([
  '/auth/change-password',
  '/auth/me',
  '/auth/logout',
  '/notifications',
  '/health',
]);

export async function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const authHeader = req.headers.authorization;
    const queryToken = typeof req.query.token === 'string' ? req.query.token : null;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : queryToken;
    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const details = verifyAccessTokenDetails(token);
    if (isTokenRevoked(details.jti)) {
      return res.status(401).json({ error: 'Session has been signed out. Please log in again.' });
    }
    const ctx = await loadUserContext(details.userId);
    if (!ctx) {
      return res.status(401).json({ error: 'Account inactive or invalid session' });
    }
    if (ctx.mustChangePassword && !PASSWORD_CHANGE_EXEMPT_PATHS.has(req.path)) {
      return res.status(403).json({
        error: 'Password change required before accessing clinic records.',
        mustChangePassword: true,
      });
    }
    req.user = ctx;
    req.authJti = details.jti;
    req.authExp = details.exp;
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

export function formatUtcSqlDatetime(d: Date = new Date()): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

export async function writeAuditLog(input: AuditInput): Promise<void> {
  await withTransaction(async () => {
    const lastRow = await queryOne<{ row_hash: string }>(
      getDialect() === 'mysql'
        ? 'SELECT row_hash FROM audit_logs ORDER BY id DESC LIMIT 1 FOR UPDATE'
        : 'SELECT row_hash FROM audit_logs ORDER BY id DESC LIMIT 1'
    );
    const prevHash = lastRow?.row_hash || 'GENESIS';
    const occurredAt = formatUtcSqlDatetime();
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
  });
}

interface AuditChainRow {
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
}

export async function verifyAuditChain(): Promise<{ valid: boolean; totalRows: number; brokenAtId: number | null }> {
  const BATCH_SIZE = 500;
  let lastId = 0;
  let totalRows = 0;
  let prevRowHash: string | null = null;

  while (true) {
    const rows: AuditChainRow[] = await query<AuditChainRow>(
      'SELECT * FROM audit_logs WHERE id > ? ORDER BY id ASC LIMIT ?',
      [lastId, BATCH_SIZE]
    );

    if (rows.length === 0) break;

    for (const row of rows) {
      totalRows += 1;
      lastId = row.id;
      if (totalRows === 1) {
        if (row.prev_hash !== 'GENESIS') {
          return { valid: false, totalRows, brokenAtId: row.id };
        }
        prevRowHash = row.row_hash;
        continue;
      }
      if (row.prev_hash !== prevRowHash) {
        return { valid: false, totalRows, brokenAtId: row.id };
      }
      const normalizedOccurredAt =
        typeof row.occurred_at === 'string' && row.occurred_at.includes('T')
          ? row.occurred_at.slice(0, 19).replace('T', ' ')
          : row.occurred_at;
      const payload: string = JSON.stringify({
        occurredAt: normalizedOccurredAt,
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
      const recomputed: string = crypto.createHash('sha256').update(payload).digest('hex');
      if (recomputed !== row.row_hash) {
        return { valid: false, totalRows, brokenAtId: row.id };
      }
      prevRowHash = row.row_hash;
    }

    if (rows.length < BATCH_SIZE) break;
  }

  return { valid: true, totalRows, brokenAtId: null };
}
