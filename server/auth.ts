import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { execute, getDialect, query, queryOne, withTransaction } from './db.ts';
import { consumeRealtimeTicket } from './realtime.ts';

if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  throw new Error('[Clinic360] FATAL: JWT_SECRET environment variable must be set in production.');
}
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');

const revokedTokens = new Map<string, number>();
const sessionLastSeenTouch = new Map<string, number>();
const auditedRequests = new WeakSet<Request>();

function pruneRevokedTokens() {
  const now = Date.now();
  for (const [jti, expiresAtMs] of revokedTokens.entries()) {
    if (expiresAtMs <= now) {
      revokedTokens.delete(jti);
    }
  }
}

export async function revokeToken(jti?: string | null, expSeconds?: number | null, revokedBy?: number | null): Promise<void> {
  if (!jti) return;
  pruneRevokedTokens();
  const expiresAtMs = expSeconds ? expSeconds * 1000 : Date.now() + 12 * 3600 * 1000;
  revokedTokens.set(jti, expiresAtMs);
  const expiresAtSql = formatUtcSqlDatetime(new Date(expiresAtMs));
  const nowStr = formatUtcSqlDatetime();
  await execute('INSERT INTO revoked_tokens (jti, expires_at) VALUES (?, ?)', [jti, expiresAtSql]).catch(async () => {
    await execute('UPDATE revoked_tokens SET expires_at = ? WHERE jti = ?', [expiresAtSql, jti]).catch(() => {});
  });
  await execute(
    'UPDATE user_sessions SET revoked_at = COALESCE(revoked_at, ?), revoked_by = COALESCE(revoked_by, ?) WHERE jti = ?',
    [nowStr, revokedBy ?? null, jti]
  ).catch(() => {});
}

export async function revokeAllUserSessions(userId: number, revokedBy?: number | null, excludeJti?: string | null): Promise<number> {
  const nowStr = formatUtcSqlDatetime();
  const activeRows = await query<{ jti: string; expires_at: string }>(
    excludeJti
      ? 'SELECT jti, expires_at FROM user_sessions WHERE user_id = ? AND revoked_at IS NULL AND jti != ?'
      : 'SELECT jti, expires_at FROM user_sessions WHERE user_id = ? AND revoked_at IS NULL',
    excludeJti ? [userId, excludeJti] : [userId]
  ).catch(() => []);
  for (const r of activeRows) {
    const expMs = new Date(`${String(r.expires_at).replace(' ', 'T')}Z`).getTime();
    revokedTokens.set(r.jti, Number.isFinite(expMs) ? expMs : Date.now() + 12 * 3600 * 1000);
    await execute('INSERT INTO revoked_tokens (jti, expires_at) VALUES (?, ?)', [r.jti, r.expires_at]).catch(() => {});
  }
  const upd = await execute(
    excludeJti
      ? 'UPDATE user_sessions SET revoked_at = ?, revoked_by = ? WHERE user_id = ? AND revoked_at IS NULL AND jti != ?'
      : 'UPDATE user_sessions SET revoked_at = ?, revoked_by = ? WHERE user_id = ? AND revoked_at IS NULL',
    excludeJti ? [nowStr, revokedBy ?? null, userId, excludeJti] : [nowStr, revokedBy ?? null, userId]
  ).catch(() => ({ affectedRows: 0 }));
  return Number(upd.affectedRows || activeRows.length);
}

export async function isTokenRevoked(jti?: string | null): Promise<boolean> {
  if (!jti) return false;
  const expiresAtMs = revokedTokens.get(jti);
  if (expiresAtMs) {
    if (expiresAtMs <= Date.now()) {
      revokedTokens.delete(jti);
    } else {
      return true;
    }
  }
  const dbRow = await queryOne<{ expires_at: string }>('SELECT expires_at FROM revoked_tokens WHERE jti = ?', [jti]).catch(() => null);
  if (dbRow) {
    const dbExpMs = new Date(`${String(dbRow.expires_at).replace(' ', 'T')}Z`).getTime();
    if (dbExpMs <= Date.now()) {
      await execute('DELETE FROM revoked_tokens WHERE jti = ?', [jti]).catch(() => {});
    } else {
      revokedTokens.set(jti, dbExpMs);
      return true;
    }
  }
  const sessRow = await queryOne<{ revoked_at: string | null; expires_at: string }>(
    'SELECT revoked_at, expires_at FROM user_sessions WHERE jti = ?',
    [jti]
  ).catch(() => null);
  if (sessRow?.revoked_at) {
    const expMs = new Date(`${String(sessRow.expires_at).replace(' ', 'T')}Z`).getTime();
    revokedTokens.set(jti, Number.isFinite(expMs) ? expMs : Date.now() + 3600 * 1000);
    return true;
  }
  if (sessRow?.expires_at) {
    const expMs = new Date(`${String(sessRow.expires_at).replace(' ', 'T')}Z`).getTime();
    if (Number.isFinite(expMs) && expMs <= Date.now()) {
      return true;
    }
  }
  return false;
}

export type DashboardType =
  | 'admin'
  | 'doctor'
  | 'nurse'
  | 'cashier'
  | 'lab'
  | 'radiology'
  | 'pharmacy'
  | 'hr'
  | 'accounting'
  | 'general';

export interface DepartmentInfo {
  id: number;
  code: string;
  name: string;
  category: string | null;
  isPrimary: boolean;
}

export interface ClinicUnitInfo {
  id: number;
  roomCode: string;
  name: string;
  departmentId: number | null;
  roomType: string | null;
}

export interface AuthUser {
  id: number;
  employeeId: number | null;
  username: string | null;
  fullName: string;
  email: string;
  branchId: number;
  status: string;
  mustChangePassword: boolean;
  twoFaEnabled: boolean;
  roles: string[];
  permissions: string[];
  departmentIds: number[];
  departmentCodes: string[];
  departmentNames: string[];
  departments: DepartmentInfo[];
  clinicUnitIds: number[];
  clinicUnits: ClinicUnitInfo[];
  defaultDashboard: DashboardType;
  authorizedDashboards: DashboardType[];
}

export interface AuthRequest extends Request {
  user?: AuthUser;
  authJti?: string;
  authExp?: number;
  departmentScopeIds?: number[] | null;
  doctorAssignmentVerified?: boolean;
}

export interface AuditHookOptions {
  action?: string;
  entityType?: string;
  entityIdParam?: string;
  patientIdParam?: string;
  captureBody?: boolean;
  dedupeIfAudited?: boolean;
}

export interface AuthorizeOptions {
  checkDepartment?: boolean;
  checkDoctorAssignment?: boolean;
  departmentParam?: string;
  visitIdParam?: string;
  patientIdParam?: string;
  audit?: boolean | AuditHookOptions;
}

export function signAccessToken(user: AuthUser, expiresInMinutes = 720): string {
  const jti = crypto.randomUUID();
  return jwt.sign(
    {
      sub: user.id,
      jti,
      email: user.email,
      username: user.username,
      fullName: user.fullName,
      branchId: user.branchId,
      roles: user.roles,
    },
    JWT_SECRET,
    { expiresIn: `${Math.max(15, expiresInMinutes)}m` }
  );
}

export async function issueSessionToken(
  user: AuthUser,
  req?: Request,
  expiresInMinutes = 720
): Promise<{ token: string; jti: string; expiresAt: string }> {
  const ttlMinutes = Math.max(15, expiresInMinutes);
  const jti = crypto.randomUUID();
  const token = jwt.sign(
    {
      sub: user.id,
      jti,
      email: user.email,
      username: user.username,
      fullName: user.fullName,
      branchId: user.branchId,
      roles: user.roles,
    },
    JWT_SECRET,
    { expiresIn: `${ttlMinutes}m` }
  );
  const nowStr = formatUtcSqlDatetime();
  const expiresAt = formatUtcSqlDatetime(new Date(Date.now() + ttlMinutes * 60_000));
  const ipAddress = req?.ip || req?.socket?.remoteAddress || '127.0.0.1';
  const userAgent = String(req?.headers['user-agent'] || '').slice(0, 240);
  await execute(
    `INSERT INTO user_sessions (jti, user_id, ip_address, user_agent, created_at, last_seen_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [jti, user.id, ipAddress, userAgent, nowStr, nowStr, expiresAt]
  ).catch(() => {});
  return { token, jti, expiresAt };
}

export const CLINIC_SESSION_COOKIE = 'clinic360_session';

export function parseCookies(cookieHeader?: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const rawVal = part.slice(eq + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(rawVal);
    } catch {
      out[key] = rawVal;
    }
  }
  return out;
}

function isHttpsRequest(req: Request): boolean {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  return req.secure || forwardedProto === 'https';
}

export function setSessionCookie(req: Request, res: Response, token: string, ttlMinutes = 720): void {
  const maxAgeSec = Math.max(900, Math.floor(ttlMinutes * 60));
  const attrs = isHttpsRequest(req)
    ? `HttpOnly; Path=/; Max-Age=${maxAgeSec}; SameSite=None; Secure; Partitioned`
    : `HttpOnly; Path=/; Max-Age=${maxAgeSec}; SameSite=Lax`;
  res.append('Set-Cookie', `${CLINIC_SESSION_COOKIE}=${encodeURIComponent(token)}; ${attrs}`);
}

export function clearSessionCookie(req: Request, res: Response): void {
  const attrs = isHttpsRequest(req)
    ? 'HttpOnly; Path=/; Max-Age=0; SameSite=None; Secure; Partitioned'
    : 'HttpOnly; Path=/; Max-Age=0; SameSite=Lax';
  res.append('Set-Cookie', `${CLINIC_SESSION_COOKIE}=; ${attrs}`);
}

export function validatePasswordPolicy(
  password: string,
  security?: { passwordMinLength?: number; requireMixedCasePassword?: boolean }
): string | null {
  const minLen = Math.max(8, Number(security?.passwordMinLength || 8));
  if (!password || password.length < minLen) {
    return `Password must be at least ${minLen} characters.`;
  }
  if (password.length > 128) {
    return 'Password cannot exceed 128 characters.';
  }
  if (security?.requireMixedCasePassword !== false) {
    if (!/[a-z]/.test(password) || !/[A-Z]/.test(password)) {
      return 'Password must include both uppercase and lowercase letters.';
    }
  }
  return null;
}

export async function getLinkedHrEmployeeStatus(userId: number, employeeId: number | null): Promise<{ id: number; status: string } | null> {
  return queryOne<{ id: number; status: string }>(
    'SELECT id, status FROM hr_employees WHERE id = ? OR user_id = ? LIMIT 1',
    [employeeId || -1, userId]
  ).catch(() => null);
}

export function resolveAuthorizedDashboards(roles: string[], permissions: string[]): DashboardType[] {
  const permSet = new Set(permissions);
  const roleSet = new Set(roles);
  const out: DashboardType[] = [];

  if (roleSet.has('ADM') || permSet.has('admin.user.manage')) out.push('admin');
  if (roleSet.has('DOC') || (permSet.has('visit.read') && permSet.has('prescription.create'))) out.push('doctor');
  if (roleSet.has('NUR') || roleSet.has('WRD') || permSet.has('vitals.create') || permSet.has('ipd.mar.give')) out.push('nurse');
  if (roleSet.has('CSH') || roleSet.has('REC') || permSet.has('billing.payment.create') || permSet.has('billing.shift.manage')) out.push('cashier');
  if (roleSet.has('LAB') || permSet.has('lab.sample.collect') || permSet.has('lab.result.enter')) out.push('lab');
  if (roleSet.has('IMG') || permSet.has('imaging.exam.perform') || permSet.has('imaging.report.finalise')) out.push('radiology');
  if (roleSet.has('PHA') || roleSet.has('STO') || permSet.has('pharmacy.dispense')) out.push('pharmacy');
  if (roleSet.has('HRO') || permSet.has('hr.manage')) out.push('hr');
  if (roleSet.has('ACC') || permSet.has('accounting.ledger.manage')) out.push('accounting');
  if (roleSet.has('MGR') || roleSet.has('AUD') || out.length === 0) out.push('general');

  return [...new Set(out)];
}

export function resolveDefaultDashboard(roles: string[], permissions: string[]): DashboardType {
  const rolePriority: Array<[string, DashboardType]> = [
    ['ADM', 'admin'],
    ['MGR', 'general'],
    ['DOC', 'doctor'],
    ['NUR', 'nurse'],
    ['WRD', 'nurse'],
    ['CSH', 'cashier'],
    ['REC', 'cashier'],
    ['LAB', 'lab'],
    ['IMG', 'radiology'],
    ['PHA', 'pharmacy'],
    ['STO', 'pharmacy'],
    ['HRO', 'hr'],
    ['ACC', 'accounting'],
    ['AUD', 'general'],
  ];
  for (const [roleCode, dash] of rolePriority) {
    if (roles.includes(roleCode)) {
      return dash;
    }
  }
  const authorized = resolveAuthorizedDashboards(roles, permissions);
  return authorized[0] || 'general';
}

export async function loadUserContext(userId: number): Promise<AuthUser | null> {
  const userRow = await queryOne<{
    id: number;
    employee_id: number | null;
    username: string | null;
    full_name: string;
    email: string;
    branch_id: number;
    active: number;
    status: string | null;
    locked_until: string | null;
    must_change_password: number;
    two_fa_enabled: number;
  }>(
    `SELECT id, employee_id, username, full_name, email, branch_id, active, status, locked_until, must_change_password, two_fa_enabled
     FROM users WHERE id = ?`,
    [userId]
  );

  if (!userRow || !userRow.active) return null;
  if (userRow.status === 'inactive' || userRow.status === 'locked') return null;
  if (userRow.locked_until) {
    const lockIso = userRow.locked_until.includes('T') ? userRow.locked_until : `${userRow.locked_until.replace(' ', 'T')}Z`;
    if (new Date(lockIso).getTime() > Date.now()) return null;
  }

  const hrRow = await getLinkedHrEmployeeStatus(userId, userRow.employee_id ?? null);
  if (hrRow && hrRow.status !== 'active') return null;

  const [roleRows, permRows, deptRows, unitRows] = await Promise.all([
    query<{ code: string }>(
      `SELECT r.code FROM roles r
       INNER JOIN user_roles ur ON ur.role_id = r.id
       WHERE ur.user_id = ?`,
      [userId]
    ),
    query<{ code: string }>(
      `SELECT DISTINCT p.code FROM permissions p
       INNER JOIN role_permissions rp ON rp.permission_id = p.id
       INNER JOIN user_roles ur ON ur.role_id = rp.role_id
       WHERE ur.user_id = ?`,
      [userId]
    ),
    query<{ id: number; code: string; name: string; category: string | null; is_primary: number }>(
      `SELECT d.id, d.code, d.name, d.category, ud.is_primary FROM departments d
       INNER JOIN user_departments ud ON ud.department_id = d.id
       WHERE ud.user_id = ? AND d.active = 1
       ORDER BY ud.is_primary DESC, d.name ASC`,
      [userId]
    ).catch(() => []),
    query<{ id: number; room_code: string; name: string; department_id: number | null; room_type: string | null }>(
      `SELECT cr.id, cr.room_code, cr.name, cr.department_id, cr.room_type
       FROM clinic_rooms cr
       INNER JOIN user_clinic_units ucu ON ucu.clinic_room_id = cr.id
       WHERE ucu.user_id = ? AND cr.active = 1
       ORDER BY cr.room_code ASC`,
      [userId]
    ).catch(() => []),
  ]);

  const roles = roleRows.map((r) => r.code);
  const permissions = permRows.map((p) => p.code);
  const departments: DepartmentInfo[] = deptRows.map((d) => ({
    id: Number(d.id),
    code: d.code,
    name: d.name,
    category: d.category ?? null,
    isPrimary: Boolean(d.is_primary),
  }));
  const clinicUnits: ClinicUnitInfo[] = unitRows.map((u) => ({
    id: Number(u.id),
    roomCode: u.room_code,
    name: u.name,
    departmentId: u.department_id !== null ? Number(u.department_id) : null,
    roomType: u.room_type ?? null,
  }));
  const defaultDashboard = resolveDefaultDashboard(roles, permissions);
  const authorizedDashboards = resolveAuthorizedDashboards(roles, permissions);

  return {
    id: userRow.id,
    employeeId: userRow.employee_id ?? null,
    username: userRow.username ?? null,
    fullName: userRow.full_name,
    email: userRow.email,
    branchId: userRow.branch_id,
    status: userRow.status || 'active',
    mustChangePassword: Boolean(userRow.must_change_password),
    twoFaEnabled: Boolean(userRow.two_fa_enabled),
    roles,
    permissions,
    departmentIds: departments.map((d) => d.id),
    departmentCodes: departments.map((d) => d.code),
    departmentNames: departments.map((d) => d.name),
    departments,
    clinicUnitIds: clinicUnits.map((u) => u.id),
    clinicUnits,
    defaultDashboard,
    authorizedDashboards,
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
  '/settings/public',
]);

export async function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const sseTicket = req.path === '/events/stream' && typeof req.query.ticket === 'string' ? req.query.ticket : null;
    if (sseTicket) {
      const ticketUserId = consumeRealtimeTicket(sseTicket);
      if (!ticketUserId) {
        return res.status(401).json({ error: 'Realtime stream ticket expired or invalid' });
      }
      const ctx = await loadUserContext(ticketUserId);
      if (!ctx) {
        return res.status(401).json({ error: 'Account inactive or invalid session' });
      }
      req.user = ctx;
      return next();
    }

    const authHeader = req.headers.authorization;
    const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
    const cookieToken = !bearerToken ? parseCookies(req.headers.cookie)[CLINIC_SESSION_COOKIE] || null : null;
    const token = bearerToken || cookieToken;
    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!bearerToken && cookieToken && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method.toUpperCase())) {
      const originHeader = typeof req.headers.origin === 'string' ? req.headers.origin : '';
      const refererHeader = typeof req.headers.referer === 'string' ? req.headers.referer : '';
      const requestHost = String(req.headers['x-forwarded-host'] || req.headers.host || '')
        .split(',')[0]
        .trim()
        .toLowerCase();
      const checkOrigin = originHeader || refererHeader;
      if (checkOrigin && requestHost) {
        try {
          if (new URL(checkOrigin).host.toLowerCase() !== requestHost) {
            return res.status(403).json({ error: 'Cross-site request blocked.' });
          }
        } catch {
          return res.status(403).json({ error: 'Invalid request origin.' });
        }
      }
    }
    const details = verifyAccessTokenDetails(token);
    if (await isTokenRevoked(details.jti)) {
      return res.status(401).json({ error: 'Session has been signed out or revoked. Please log in again.' });
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
    if (details.jti) {
      const lastTouch = sessionLastSeenTouch.get(details.jti) || 0;
      if (Date.now() - lastTouch > 60_000) {
        sessionLastSeenTouch.set(details.jti, Date.now());
        execute('UPDATE user_sessions SET last_seen_at = ? WHERE jti = ?', [formatUtcSqlDatetime(), details.jti]).catch(() => {});
      }
    }
    req.user = ctx;
    req.authJti = details.jti;
    req.authExp = details.exp;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session token' });
  }
}

const SENSITIVE_FIELD_PATTERN = /password|secret|token|jwt|hash|pin|cvv|passcode/i;

function redactSensitive(value: unknown, depth = 0): unknown {
  if (depth > 4 || value == null) return value;
  if (Array.isArray(value)) return value.slice(0, 25).map((item) => redactSensitive(item, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_FIELD_PATTERN.test(k) ? '[REDACTED]' : redactSensitive(v, depth + 1);
    }
    return out;
  }
  return value;
}

function attachAuditHook(req: AuthRequest, res: Response, options: AuditHookOptions) {
  let capturedEntityId: string | number | null = null;
  const origJson = res.json.bind(res);
  res.json = ((body?: unknown) => {
    if (body && typeof body === 'object') {
      const b = body as Record<string, unknown>;
      const candidate = b.id ?? b.visitId ?? b.patientId ?? (typeof b.user === 'object' && b.user ? (b.user as Record<string, unknown>).id : undefined);
      if (candidate !== undefined && candidate !== null) {
        capturedEntityId = typeof candidate === 'number' || typeof candidate === 'string' ? candidate : String(candidate);
      }
    }
    return origJson(body);
  }) as Response['json'];

  res.once('finish', () => {
    if (res.statusCode < 200 || res.statusCode >= 400) return;
    if (res.locals?.auditSkip) return;
    if (options.dedupeIfAudited && auditedRequests.has(req)) return;

    const rawPath = (req.baseUrl + (req.route?.path || req.path || '')).replace(/^\/api\/?/, '');
    const derivedAction = `api.${req.method.toLowerCase()}.${rawPath.replace(/[/:]+/g, '.').replace(/^\.+|\.+$/g, '') || 'root'}`;
    const action = options.action || derivedAction;
    const entityType = options.entityType || (rawPath.split('/')[0] || 'endpoint');
    const entityId =
      res.locals?.auditEntityId ??
      (options.entityIdParam ? req.params?.[options.entityIdParam] : undefined) ??
      req.params?.id ??
      req.params?.visitId ??
      req.params?.patientId ??
      req.params?.departmentId ??
      req.params?.code ??
      capturedEntityId ??
      null;
    const rawPatientId =
      res.locals?.auditPatientId ??
      (options.patientIdParam ? req.params?.[options.patientIdParam] : undefined) ??
      req.params?.patientId ??
      req.body?.patient_id ??
      null;
    const patientId = rawPatientId && Number(rawPatientId) > 0 ? Number(rawPatientId) : null;

    const afterPayload =
      res.locals?.auditAfter !== undefined
        ? res.locals.auditAfter
        : {
            method: req.method,
            path: req.originalUrl,
            statusCode: res.statusCode,
            ...(options.captureBody && req.body && Object.keys(req.body).length > 0 ? { body: redactSensitive(req.body) } : {}),
          };

    void writeAuditLog({
      user: req.user,
      action,
      entityType,
      entityId,
      patientId,
      before: res.locals?.auditBefore,
      after: afterPayload,
      reason: res.locals?.auditReason ?? (req.body?.reason ? String(req.body.reason) : null),
      req,
    }).catch((err) => {
      console.error('[Clinic360] Audit hook write failed:', err instanceof Error ? err.message : err);
    });
  });
}

export function auditAction(options: AuditHookOptions = {}) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    attachAuditHook(req, res, options);
    next();
  };
}

export function requirePermission(...requiredPermissions: string[]) {
  return authorize(requiredPermissions);
}

async function resolveTargetVisit(visitId: number) {
  return queryOne<{ id: number; patient_id: number; doctor_id: number | null }>(
    'SELECT id, patient_id, doctor_id FROM visits WHERE id = ?',
    [visitId]
  );
}

async function resolveDepartmentIdByNameOrCode(val: string): Promise<number | null> {
  const cleaned = val.trim();
  if (!cleaned) return null;
  const row = await queryOne<{ id: number }>(
    'SELECT id FROM departments WHERE UPPER(code) = UPPER(?) OR LOWER(name) = LOWER(?) LIMIT 1',
    [cleaned, cleaned]
  ).catch(() => null);
  return row ? Number(row.id) : null;
}

export function authorize(
  permission: string | string[],
  options: AuthorizeOptions = {}
) {
  const required = (Array.isArray(permission) ? permission : [permission]).filter(Boolean);
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const hasAny = required.length > 0 && required.some((p) => req.user!.permissions.includes(p));
    if (!hasAny) {
      await writeAuditLog({
        user: req.user,
        action: 'security.access_denied',
        entityType: 'route',
        entityId: req.originalUrl,
        after: { requiredPermissions: required, method: req.method },
        req,
      }).catch(() => {});
      return res.status(403).json({
        error: `Forbidden: requires one of [${required.join(', ')}]`,
      });
    }

    const isUnscopedAdmin = req.user.roles.includes('ADM') || req.user.roles.includes('MGR');
    req.departmentScopeIds = isUnscopedAdmin ? null : req.user.departmentIds;

    if (options.checkDepartment && !isUnscopedAdmin && req.user.departmentIds.length > 0) {
      const deptParamKey = options.departmentParam || 'departmentId';
      const rawId =
        req.params?.[deptParamKey] ??
        req.params?.deptId ??
        req.query?.department_id ??
        req.query?.departmentId ??
        req.body?.department_id ??
        req.body?.departmentId;
      let targetDeptId = rawId !== undefined && rawId !== '' ? Number(rawId) : 0;

      if (!targetDeptId) {
        const rawDeptLabel = req.params?.department ?? req.query?.department ?? req.body?.department;
        if (typeof rawDeptLabel === 'string' && rawDeptLabel.trim() && rawDeptLabel.trim().toUpperCase() !== 'ALL') {
          const resolvedId = await resolveDepartmentIdByNameOrCode(rawDeptLabel);
          if (resolvedId) {
            targetDeptId = resolvedId;
          } else {
            const upperLabel = rawDeptLabel.trim().toUpperCase();
            const lowerLabel = rawDeptLabel.trim().toLowerCase();
            const matchesCodeOrName =
              req.user.departmentCodes.some((c) => c.toUpperCase() === upperLabel) ||
              req.user.departmentNames.some((n) => n.toLowerCase() === lowerLabel);
            if (!matchesCodeOrName) {
              await writeAuditLog({
                user: req.user,
                action: 'security.department_scope_denied',
                entityType: 'department',
                entityId: rawDeptLabel.trim(),
                after: { userDepartmentIds: req.user.departmentIds, userDepartmentCodes: req.user.departmentCodes, path: req.originalUrl },
                req,
              }).catch(() => {});
              return res.status(403).json({ error: 'Access denied for this department scope.' });
            }
          }
        }
      }

      if (targetDeptId > 0 && !req.user.departmentIds.includes(targetDeptId)) {
        await writeAuditLog({
          user: req.user,
          action: 'security.department_scope_denied',
          entityType: 'department',
          entityId: targetDeptId,
          after: { userDepartmentIds: req.user.departmentIds, path: req.originalUrl },
          req,
        }).catch(() => {});
        return res.status(403).json({ error: 'Access denied for this department scope.' });
      }
    }

    if (options.checkDoctorAssignment && isDoctorOnly(req.user)) {
      const routePattern = `${req.baseUrl}${req.route?.path || req.path || ''}`;
      const rawVisitId =
        (options.visitIdParam ? req.params?.[options.visitIdParam] : undefined) ??
        req.params?.visitId ??
        (routePattern.includes('/visits/') ? req.params?.id : undefined) ??
        req.body?.visit_id ??
        req.query?.visit_id;
      const visitId = rawVisitId !== undefined && rawVisitId !== '' ? Number(rawVisitId) : 0;

      const rawPatientId =
        (options.patientIdParam ? req.params?.[options.patientIdParam] : undefined) ??
        req.params?.patientId ??
        (routePattern.includes('/patients/') ? req.params?.id : undefined) ??
        req.body?.patient_id ??
        req.query?.patient_id;
      const patientId = rawPatientId !== undefined && rawPatientId !== '' ? Number(rawPatientId) : 0;

      if (visitId > 0) {
        const visitRow = await resolveTargetVisit(visitId);
        if (visitRow) {
          const [activeAssign, activeBg] = await Promise.all([
            queryOne<{ id: number }>(
              "SELECT id FROM doctor_assignments WHERE visit_id = ? AND doctor_id = ? AND status = 'active' LIMIT 1",
              [visitId, req.user.id]
            ).catch(() => null),
            queryOne<{ id: number }>(
              'SELECT id FROM break_glass_logs WHERE patient_id = ? AND user_id = ? AND expires_at > ? ORDER BY id DESC LIMIT 1',
              [visitRow.patient_id, req.user.id, formatUtcSqlDatetime()]
            ).catch(() => null),
          ]);
          let assignedToDoctor = Number(visitRow.doctor_id) === req.user.id || Boolean(activeAssign);
          if (!assignedToDoctor && visitRow.doctor_id == null) {
            const patientAccess = await assertPatientAccess(req.user, visitRow.patient_id);
            assignedToDoctor = patientAccess.allowed;
          }
          if (!assignedToDoctor && !activeBg) {
            await writeAuditLog({
              user: req.user,
              action: 'security.doctor_assignment_denied',
              entityType: 'visit',
              entityId: visitId,
              patientId: visitRow.patient_id,
              after: { assignedDoctorId: visitRow.doctor_id, path: req.originalUrl },
              req,
            }).catch(() => {});
            return res.status(403).json({
              error: 'Access denied: patient visit is not assigned to you.',
              breakGlassRequired: true,
              patientId: visitRow.patient_id,
            });
          }
          req.doctorAssignmentVerified = true;
        }
      } else if (patientId > 0) {
        const patientExists = await queryOne<{ id: number }>('SELECT id FROM patients WHERE id = ?', [patientId]);
        if (patientExists) {
          const access = await assertPatientAccess(req.user, patientId);
          if (!access.allowed) {
            await writeAuditLog({
              user: req.user,
              action: 'security.doctor_assignment_denied',
              entityType: 'patient',
              entityId: patientId,
              patientId,
              after: { path: req.originalUrl },
              req,
            }).catch(() => {});
            return res.status(403).json({
              error: access.reason || 'Access denied: patient is not assigned to you.',
              breakGlassRequired: true,
              patientId,
            });
          }
          req.doctorAssignmentVerified = true;
        }
      }
    }

    if (options.audit) {
      const auditOpts: AuditHookOptions = typeof options.audit === 'object' ? options.audit : {};
      attachAuditHook(req, res, auditOpts);
    }

    next();
  };
}

export function hasPermission(user: AuthUser, ...perms: string[]): boolean {
  return perms.some((perm) => user.permissions.includes(perm));
}

export function assertDifferentUser(actorId: number, creatorId: number | null | undefined, label: string): void {
  if (creatorId != null && Number(actorId) === Number(creatorId)) {
    const err = new Error(`Segregation of Duties Violation: Cannot self-approve or double-verify your own ${label}.`) as Error & { status?: number };
    err.status = 403;
    throw err;
  }
}

export function isDoctorOnly(user: AuthUser): boolean {
  return user.roles.includes('DOC') && !user.roles.includes('MGR') && !user.roles.includes('ADM') && !user.roles.includes('AUD');
}

export async function assertPatientAccess(
  user: AuthUser,
  patientId: number
): Promise<{ allowed: boolean; clinicalAuthorized: boolean; breakGlassActive: boolean; reason?: string }> {
  const canSeeClinical = hasPermission(user, 'patient.clinical.read');
  if (!canSeeClinical) {
    return { allowed: true, clinicalAuthorized: false, breakGlassActive: false };
  }

  // Non-DOC clinical service roles (NUR, WRD, PHA, LAB, IMG) & MGR/ADM oversight
  if (!isDoctorOnly(user)) {
    return { allowed: true, clinicalAuthorized: true, breakGlassActive: false };
  }

  const nowStr = formatUtcSqlDatetime();
  const [visitRow, assignRow, apptRow, admRow, bgRow] = await Promise.all([
    queryOne<{ id: number }>(
      `SELECT id FROM visits
       WHERE patient_id = ? AND doctor_id = ?
       LIMIT 1`,
      [patientId, user.id]
    ),
    queryOne<{ id: number }>(
      `SELECT id FROM doctor_assignments
       WHERE patient_id = ? AND doctor_id = ? AND status = 'active'
       LIMIT 1`,
      [patientId, user.id]
    ).catch(() => null),
    queryOne<{ id: number }>(
      `SELECT id FROM appointments WHERE patient_id = ? AND doctor_id = ? AND status IN ('scheduled','checked_in','completed') LIMIT 1`,
      [patientId, user.id]
    ),
    queryOne<{ id: number }>(
      `SELECT id FROM admissions WHERE patient_id = ? AND admitting_doctor_id = ? AND status != 'discharged' LIMIT 1`,
      [patientId, user.id]
    ),
    queryOne<{ id: number }>(
      `SELECT id FROM break_glass_logs WHERE patient_id = ? AND user_id = ? AND expires_at > ? ORDER BY id DESC LIMIT 1`,
      [patientId, user.id, nowStr]
    ).catch(() => null),
  ]);

  if (visitRow || assignRow || apptRow || admRow) {
    return { allowed: true, clinicalAuthorized: true, breakGlassActive: false };
  }
  if (bgRow) {
    return { allowed: true, clinicalAuthorized: true, breakGlassActive: true };
  }

  return {
    allowed: false,
    clinicalAuthorized: false,
    breakGlassActive: false,
    reason: 'Break-Glass clinical justification required to open a patient chart you are not assigned to treat.',
  };
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

export function formatClinicDate(timezone = 'Africa/Addis_Ababa', d: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

export async function writeAuditLog(input: AuditInput): Promise<void> {
  if (input.req) {
    auditedRequests.add(input.req);
  }
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
      ipAddress,
      userAgent,
      branchId,
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
  ip_address: string | null;
  user_agent: string | null;
  branch_id: number;
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
      } else if (row.prev_hash !== prevRowHash) {
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
        ipAddress: row.ip_address ?? '127.0.0.1',
        userAgent: row.user_agent ?? '',
        branchId: Number(row.branch_id ?? 1),
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
