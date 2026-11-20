import { Router, type Response } from 'express';
import bcrypt from 'bcryptjs';
import { execute, getDialect, nextSequence, query, queryOne } from './db.ts';
import {
  type AuthRequest,
  hasPermission,
  loadUserContext,
  requireAuth,
  requirePermission,
  signAccessToken,
  verifyAuditChain,
  writeAuditLog,
} from './auth.ts';

const router = Router();
const loginAttemptsByIp = new Map<string, { count: number; resetAt: number }>();

async function createNotification(opts: {
  targetRole: string;
  title: string;
  message: string;
  severity?: 'info' | 'warning' | 'critical';
  entityType?: string;
  entityId?: number;
}) {
  await execute(
    'INSERT INTO notifications (target_role, title, message, severity, entity_type, entity_id) VALUES (?, ?, ?, ?, ?, ?)',
    [
      opts.targetRole,
      opts.title,
      opts.message,
      opts.severity || 'info',
      opts.entityType || null,
      opts.entityId ?? null,
    ]
  );
}

router.get('/health', (_req, res) => {
  res.json({ ok: true, dialect: getDialect(), service: 'Clinic360 API' });
});

// ---------------------------------------------------------------------------
// AUTHENTICATION & NOTIFICATIONS
// ---------------------------------------------------------------------------
router.get('/auth/demo-accounts', async (_req, res) => {
  const rows = await query<{
    full_name: string;
    email: string;
    specialty: string | null;
    role_code: string;
    role_name: string;
  }>(
    `SELECT u.full_name, u.email, u.specialty, r.code AS role_code, r.name AS role_name
     FROM users u
     INNER JOIN user_roles ur ON ur.user_id = u.id
     INNER JOIN roles r ON r.id = ur.role_id
     WHERE u.active = 1
     ORDER BY u.id ASC`
  );
  res.json({ accounts: rows });
});

router.post('/auth/login', async (req, res) => {
  const ip = req.ip || '127.0.0.1';
  const now = Date.now();
  const ipRate = loginAttemptsByIp.get(ip);
  if (ipRate && ipRate.resetAt > now && ipRate.count > 25) {
    return res.status(429).json({ error: 'Too many login requests. Please wait a minute.' });
  }
  loginAttemptsByIp.set(ip, {
    count: (ipRate && ipRate.resetAt > now ? ipRate.count : 0) + 1,
    resetAt: ipRate && ipRate.resetAt > now ? ipRate.resetAt : now + 60_000,
  });

  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  const user = await queryOne<{
    id: number;
    full_name: string;
    email: string;
    password_hash: string;
    active: number;
    failed_attempts: number;
    locked_until: string | null;
    branch_id: number;
  }>('SELECT * FROM users WHERE email = ?', [String(email).trim().toLowerCase()]);

  if (!user) {
    await writeAuditLog({
      action: 'auth.login.failed',
      entityType: 'user',
      entityId: String(email),
      after: { reason: 'unknown_email' },
      req,
    });
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  if (!user.active) {
    return res.status(403).json({ error: 'Account is deactivated. Contact your administrator.' });
  }

  if (user.locked_until && new Date(user.locked_until).getTime() > now) {
    return res.status(423).json({ error: 'Account temporarily locked due to failed logins.' });
  }

  const valid = await bcrypt.compare(String(password), user.password_hash);
  if (!valid) {
    const nextFails = user.failed_attempts + 1;
    const lockUntil = nextFails >= 5 ? new Date(now + 15 * 60_000).toISOString() : null;
    await execute('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?', [
      nextFails,
      lockUntil,
      user.id,
    ]);
    await writeAuditLog({
      user: { id: user.id, fullName: user.full_name, roles: [], branchId: user.branch_id },
      action: 'auth.login.failed',
      entityType: 'user',
      entityId: user.id,
      after: { failedAttempts: nextFails },
      req,
    });
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  await execute("UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = datetime('now') WHERE id = ?", [
    user.id,
  ]).catch(async () => {
    await execute('UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = NOW() WHERE id = ?', [
      user.id,
    ]);
  });

  const ctx = await loadUserContext(user.id);
  if (!ctx) {
    return res.status(403).json({ error: 'Unable to load user permissions.' });
  }
  const token = signAccessToken(ctx);
  await writeAuditLog({
    user: ctx,
    action: 'auth.login.success',
    entityType: 'user',
    entityId: ctx.id,
    req,
  });

  res.json({ token, user: ctx, dialect: getDialect() });
});

router.get('/auth/me', requireAuth, async (req: AuthRequest, res: Response) => {
  res.json({ user: req.user, dialect: getDialect() });
});

router.post('/auth/logout', requireAuth, async (req: AuthRequest, res: Response) => {
  await writeAuditLog({
    user: req.user,
    action: 'auth.logout',
    entityType: 'user',
    entityId: req.user?.id,
    req,
  });
  res.json({ ok: true });
});

router.get('/notifications', requireAuth, async (req: AuthRequest, res: Response) => {
  const roles = req.user!.roles;
  if (roles.length === 0) return res.json({ notifications: [], unreadCount: 0 });
  const placeholders = roles.map(() => '?').join(',');
  const notifications = await query(
    `SELECT * FROM notifications WHERE target_role IN (${placeholders}) OR target_role = 'ALL' ORDER BY id DESC LIMIT 25`,
    roles
  );
  const unreadCount = notifications.filter((n) => (n as { is_read: number }).is_read === 0).length;
  res.json({ notifications, unreadCount });
});

router.post('/notifications/:id/read', requireAuth, async (req, res) => {
  await execute('UPDATE notifications SET is_read = 1 WHERE id = ?', [Number(req.params.id)]);
  res.json({ ok: true });
});

router.post('/notifications/read-all', requireAuth, async (req: AuthRequest, res: Response) => {
  const roles = req.user!.roles;
  if (roles.length > 0) {
    const placeholders = roles.map(() => '?').join(',');
    await execute(`UPDATE notifications SET is_read = 1 WHERE target_role IN (${placeholders})`, roles);
  }
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// DASHBOARD & CATALOGS
// ---------------------------------------------------------------------------
router.get('/dashboard', requireAuth, async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const today = new Date().toISOString().slice(0, 10);

  const patientCount = await queryOne<{ cnt: number }>("SELECT COUNT(*) AS cnt FROM patients WHERE status = 'active'");
  const todayAppts = await queryOne<{ cnt: number }>(
    "SELECT COUNT(*) AS cnt FROM appointments WHERE appointment_date = ? AND status != 'cancelled'",
    [today]
  );
  const activeQueue = await queryOne<{ cnt: number }>(
    "SELECT COUNT(*) AS cnt FROM queue_tickets WHERE status IN ('waiting','called','in_service')"
  );
  const openVisits = await queryOne<{ cnt: number }>("SELECT COUNT(*) AS cnt FROM visits WHERE status != 'closed'");
  const pendingLabs = await queryOne<{ cnt: number }>(
    "SELECT COUNT(*) AS cnt FROM lab_orders WHERE status IN ('ordered','collected','resulted')"
  );
  const pendingImaging = await queryOne<{ cnt: number }>(
    "SELECT COUNT(*) AS cnt FROM imaging_orders WHERE status IN ('ordered','scheduled','performed','reported_draft')"
  );
  const pendingRx = await queryOne<{ cnt: number }>("SELECT COUNT(*) AS cnt FROM prescriptions WHERE status = 'pending'");
  const pendingApprovals = await queryOne<{ cnt: number }>(
    "SELECT COUNT(*) AS cnt FROM approval_requests WHERE status = 'pending'"
  );
  const occupiedBeds = await queryOne<{ cnt: number }>("SELECT COUNT(*) AS cnt FROM beds WHERE status = 'occupied'");
  const totalBeds = await queryOne<{ cnt: number }>("SELECT COUNT(*) AS cnt FROM beds WHERE status != 'out_of_service'");

  const canSeeFinance = hasPermission(user, 'billing.invoice.read') || hasPermission(user, 'finance.report.view');
  let revenueTotal = 0;
  let unpaidBalance = 0;
  if (canSeeFinance) {
    const revRow = await queryOne<{ total: number }>(
      "SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE status = 'completed'"
    );
    const unpaidRow = await queryOne<{ total: number }>(
      "SELECT COALESCE(SUM(total_amount - paid_amount), 0) AS total FROM invoices WHERE status IN ('unpaid','partial')"
    );
    revenueTotal = Number(revRow?.total || 0);
    unpaidBalance = Number(unpaidRow?.total || 0);
  }

  const recentQueue = hasPermission(user, 'queue.manage') || hasPermission(user, 'visit.read') || hasPermission(user, 'patient.read')
    ? await query(
        `SELECT q.id, q.ticket_number, q.department, q.priority, q.status, q.created_at,
                p.mrn, p.first_name, p.last_name
         FROM queue_tickets q
         INNER JOIN patients p ON p.id = q.patient_id
         WHERE q.status IN ('waiting','called','in_service')
         ORDER BY CASE q.priority WHEN 'emergency' THEN 1 WHEN 'urgent' THEN 2 ELSE 3 END, q.id ASC
         LIMIT 8`
      )
    : [];

  const upcomingAppointments = hasPermission(user, 'appointment.read')
    ? await query(
        `SELECT a.id, a.appointment_date, a.start_time, a.end_time, a.visit_type, a.status, a.reason,
                p.mrn, p.first_name, p.last_name, u.full_name AS doctor_name
         FROM appointments a
         INNER JOIN patients p ON p.id = a.patient_id
         INNER JOIN users u ON u.id = a.doctor_id
         WHERE a.appointment_date >= ? AND a.status IN ('scheduled','checked_in')
         ORDER BY a.appointment_date ASC, a.start_time ASC
         LIMIT 8`,
        [today]
      )
    : [];

  res.json({
    metrics: {
      totalPatients: Number(patientCount?.cnt || 0),
      todayAppointments: Number(todayAppts?.cnt || 0),
      activeQueue: Number(activeQueue?.cnt || 0),
      openVisits: Number(openVisits?.cnt || 0),
      pendingLabs: Number(pendingLabs?.cnt || 0),
      pendingImaging: Number(pendingImaging?.cnt || 0),
      pendingPrescriptions: Number(pendingRx?.cnt || 0),
      pendingApprovals: Number(pendingApprovals?.cnt || 0),
      occupiedBeds: Number(occupiedBeds?.cnt || 0),
      totalBeds: Number(totalBeds?.cnt || 0),
      revenueTotal: canSeeFinance ? revenueTotal : null,
      unpaidBalance: canSeeFinance ? unpaidBalance : null,
    },
    recentQueue,
    upcomingAppointments,
  });
});

router.get('/catalog/services', requireAuth, async (_req, res) => {
  const services = await query('SELECT * FROM services WHERE active = 1 ORDER BY category, name');
  res.json({ services });
});

router.get('/catalog/lab-tests', requireAuth, async (_req, res) => {
  const labTests = await query('SELECT * FROM lab_tests ORDER BY name');
  res.json({ labTests });
});

router.get('/catalog/imaging', requireAuth, async (_req, res) => {
  const imagingCatalog = await query('SELECT * FROM imaging_catalog ORDER BY modality, name');
  res.json({ imagingCatalog });
});

router.get('/catalog/medicines', requireAuth, async (_req, res) => {
  const medicines = await query('SELECT * FROM medicines ORDER BY generic_name');
  res.json({ medicines });
});

router.get('/doctors', requireAuth, async (_req, res) => {
  const doctors = await query(
    `SELECT u.id, u.full_name, u.email, u.specialty
     FROM users u
     INNER JOIN user_roles ur ON ur.user_id = u.id
     INNER JOIN roles r ON r.id = ur.role_id
     WHERE r.code = 'DOC' AND u.active = 1
     ORDER BY u.full_name`
  );
  res.json({ doctors });
});

// ---------------------------------------------------------------------------
// PATIENTS, DUPLICATE CHECK, MERGE & QUEUE
// ---------------------------------------------------------------------------
router.get('/patients', requireAuth, requirePermission('patient.read'), async (req: AuthRequest, res: Response) => {
  const search = String(req.query.q || '').trim();
  const canSeeClinical = hasPermission(req.user!, 'patient.clinical.read');

  let sql = `SELECT id, mrn, first_name, last_name, sex, date_of_birth, phone, email, address,
                    patient_type, payer_name, insurance_number, status, created_at`;
  if (canSeeClinical) {
    sql += ', blood_group, allergies';
  }
  sql += " FROM patients WHERE status = 'active'";
  const params: unknown[] = [];

  if (search) {
    const like = `%${search}%`;
    sql += ' AND (mrn LIKE ? OR first_name LIKE ? OR last_name LIKE ? OR phone LIKE ?)';
    params.push(like, like, like, like);
  }
  sql += ' ORDER BY id DESC LIMIT 100';

  const patients = await query(sql, params);
  res.json({ patients, clinicalMasked: !canSeeClinical });
});

router.get('/patients/check-duplicate', requireAuth, requirePermission('patient.read'), async (req: AuthRequest, res: Response) => {
  const { first_name, last_name, date_of_birth, phone } = req.query;
  const matches = await query(
    `SELECT id, mrn, first_name, last_name, date_of_birth, phone
     FROM patients
     WHERE status = 'active'
       AND ((LOWER(first_name) = LOWER(?) AND LOWER(last_name) = LOWER(?) AND date_of_birth = ?)
            OR phone = ?)
     LIMIT 5`,
    [String(first_name || ''), String(last_name || ''), String(date_of_birth || ''), String(phone || '')]
  );
  res.json({ duplicates: matches });
});

router.post('/patients/merge', requireAuth, requirePermission('patient.merge'), async (req: AuthRequest, res: Response) => {
  const { source_patient_id, target_patient_id, reason } = req.body || {};
  const srcId = Number(source_patient_id);
  const tgtId = Number(target_patient_id);
  if (!srcId || !tgtId || srcId === tgtId || !reason?.trim()) {
    return res.status(400).json({ error: 'Distinct source_patient_id, target_patient_id, and formal reason are required.' });
  }

  const src = await queryOne<{ id: number; mrn: string; status: string }>('SELECT id, mrn, status FROM patients WHERE id = ?', [srcId]);
  const tgt = await queryOne<{ id: number; mrn: string; status: string }>('SELECT id, mrn, status FROM patients WHERE id = ?', [tgtId]);
  if (!src || !tgt || src.status !== 'active' || tgt.status !== 'active') {
    return res.status(404).json({ error: 'Both source and target must be active patient records.' });
  }

  const tables = ['appointments', 'visits', 'vitals', 'invoices', 'payments', 'receipts', 'lab_orders', 'imaging_orders', 'prescriptions', 'queue_tickets', 'admissions'];
  for (const tbl of tables) {
    await execute(`UPDATE ${tbl} SET patient_id = ? WHERE patient_id = ?`, [tgtId, srcId]);
  }
  await execute("UPDATE patients SET status = 'merged', merged_into_id = ?, updated_by = ? WHERE id = ?", [tgtId, req.user!.id, srcId]);

  await writeAuditLog({
    user: req.user,
    action: 'patient.merge',
    entityType: 'patient',
    entityId: tgtId,
    patientId: tgtId,
    before: { sourceMrn: src.mrn, sourceId: srcId },
    after: { targetMrn: tgt.mrn, targetId: tgtId },
    reason: reason.trim(),
    req,
  });

  res.json({ ok: true, mergedMrn: src.mrn, intoMrn: tgt.mrn });
});

router.get('/patients/:id', requireAuth, requirePermission('patient.read'), async (req: AuthRequest, res: Response) => {
  const id = Number(req.params.id);
  const canSeeClinical = hasPermission(req.user!, 'patient.clinical.read');
  const canSeeBilling = hasPermission(req.user!, 'billing.invoice.read');

  const patient = await queryOne<Record<string, unknown>>('SELECT * FROM patients WHERE id = ?', [id]);
  if (!patient) {
    return res.status(404).json({ error: 'Patient not found' });
  }

  const safePatient = canSeeClinical
    ? patient
    : { ...patient, blood_group: 'Restricted', allergies: 'Restricted (Clinical Role Required)' };

  const appointments = hasPermission(req.user!, 'appointment.read')
    ? await query(
        `SELECT a.*, u.full_name AS doctor_name
         FROM appointments a
         INNER JOIN users u ON u.id = a.doctor_id
         WHERE a.patient_id = ?
         ORDER BY a.appointment_date DESC, a.start_time DESC`,
        [id]
      )
    : [];

  const visits = canSeeClinical
    ? await query(
        `SELECT v.*, u.full_name AS doctor_name
         FROM visits v
         LEFT JOIN users u ON u.id = v.doctor_id
         WHERE v.patient_id = ?
         ORDER BY v.id DESC`,
        [id]
      )
    : [];

  const vitals = canSeeClinical
    ? await query('SELECT * FROM vitals WHERE patient_id = ? ORDER BY id DESC LIMIT 10', [id])
    : [];

  const invoices = canSeeBilling
    ? await query('SELECT * FROM invoices WHERE patient_id = ? ORDER BY id DESC', [id])
    : [];

  const accessHistory = hasPermission(req.user!, 'audit.read') || hasPermission(req.user!, 'patient.clinical.read')
    ? await query(
        'SELECT id, occurred_at, user_name, role_at_time, action FROM audit_logs WHERE patient_id = ? ORDER BY id DESC LIMIT 15',
        [id]
      )
    : [];

  await writeAuditLog({
    user: req.user,
    action: 'patient.read',
    entityType: 'patient',
    entityId: id,
    patientId: id,
    req,
  });

  res.json({
    patient: safePatient,
    clinicalMasked: !canSeeClinical,
    appointments,
    visits,
    vitals,
    invoices,
    accessHistory,
  });
});

router.post('/patients', requireAuth, requirePermission('patient.create'), async (req: AuthRequest, res: Response) => {
  const {
    first_name,
    last_name,
    sex,
    date_of_birth,
    phone,
    email,
    address,
    next_of_kin_name,
    next_of_kin_phone,
    blood_group,
    allergies,
    patient_type = 'self-pay',
    payer_name,
    insurance_number,
    national_id,
    issue_queue_ticket = true,
    charge_registration_card = true,
  } = req.body || {};

  if (!first_name || !last_name || !sex || !date_of_birth || !phone) {
    return res.status(400).json({ error: 'First name, last name, sex, date of birth, and phone are required.' });
  }

  const mrn = await nextSequence('MRN');
  const inserted = await execute(
    `INSERT INTO patients (mrn, first_name, last_name, sex, date_of_birth, phone, email, address, next_of_kin_name, next_of_kin_phone, blood_group, allergies, patient_type, payer_name, insurance_number, national_id, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      mrn,
      first_name.trim(),
      last_name.trim(),
      sex,
      date_of_birth,
      phone.trim(),
      email || null,
      address || null,
      next_of_kin_name || null,
      next_of_kin_phone || null,
      blood_group || null,
      allergies || 'None known',
      patient_type,
      payer_name || null,
      insurance_number || null,
      national_id || null,
      req.user!.id,
    ]
  );

  const patientId = inserted.insertId;

  let ticketNumber: string | null = null;
  if (issue_queue_ticket) {
    ticketNumber = await nextSequence('TICKET');
    await execute(
      "INSERT INTO queue_tickets (ticket_number, department, patient_id, priority, status, created_by) VALUES (?, 'OPD', ?, 'routine', 'waiting', ?)",
      [ticketNumber, patientId, req.user!.id]
    );
  }

  if (charge_registration_card && patient_type !== 'exempt') {
    const invNum = await nextSequence('INV');
    const cardFee = 15.0;
    const invStatus = patient_type === 'insurance' || patient_type === 'credit' ? 'credit_billed' : 'unpaid';
    const invRes = await execute(
      `INSERT INTO invoices (invoice_number, patient_id, payer_type, payer_name, subtotal, discount_amount, total_amount, paid_amount, status, notes, created_by)
       VALUES (?, ?, ?, ?, ?, 0, ?, 0, ?, 'Registration card fee', ?)`,
      [invNum, patientId, patient_type, payer_name || null, cardFee, cardFee, invStatus, req.user!.id]
    );
    await execute(
      "INSERT INTO invoice_items (invoice_id, service_code, description, category, quantity, unit_price, line_total) VALUES (?, 'REG-CARD', 'New Patient Registration Card', 'registration', 1, ?, ?)",
      [invRes.insertId, cardFee, cardFee]
    );
  }

  await writeAuditLog({
    user: req.user,
    action: 'patient.create',
    entityType: 'patient',
    entityId: patientId,
    patientId,
    after: { mrn, first_name, last_name, patient_type },
    req,
  });

  const patient = await queryOne('SELECT * FROM patients WHERE id = ?', [patientId]);
  res.status(201).json({ patient, ticketNumber });
});

router.patch('/patients/:id', requireAuth, requirePermission('patient.update'), async (req: AuthRequest, res: Response) => {
  const id = Number(req.params.id);
  const existing = await queryOne<Record<string, unknown>>('SELECT * FROM patients WHERE id = ?', [id]);
  if (!existing) return res.status(404).json({ error: 'Patient not found' });

  const fields = ['phone', 'email', 'address', 'next_of_kin_name', 'next_of_kin_phone', 'blood_group', 'allergies', 'patient_type', 'payer_name', 'insurance_number'];
  const updates: string[] = [];
  const params: unknown[] = [];
  const beforeDiff: Record<string, unknown> = {};
  const afterDiff: Record<string, unknown> = {};

  for (const f of fields) {
    if (req.body[f] !== undefined && req.body[f] !== existing[f]) {
      updates.push(`${f} = ?`);
      params.push(req.body[f]);
      beforeDiff[f] = existing[f];
      afterDiff[f] = req.body[f];
    }
  }

  if (updates.length > 0) {
    updates.push('updated_by = ?');
    params.push(req.user!.id, id);
    await execute(`UPDATE patients SET ${updates.join(', ')} WHERE id = ?`, params);
    await writeAuditLog({
      user: req.user,
      action: 'patient.update',
      entityType: 'patient',
      entityId: id,
      patientId: id,
      before: beforeDiff,
      after: afterDiff,
      req,
    });
  }

  const updated = await queryOne('SELECT * FROM patients WHERE id = ?', [id]);
  res.json({ patient: updated });
});

// Queue Management
router.get('/queue', requireAuth, requirePermission('queue.manage', 'visit.read', 'patient.read'), async (req, res) => {
  const dept = req.query.department ? String(req.query.department) : null;
  let sql = `
    SELECT q.*, p.mrn, p.first_name, p.last_name, p.sex, p.date_of_birth, p.patient_type
    FROM queue_tickets q
    INNER JOIN patients p ON p.id = q.patient_id
    WHERE q.status IN ('waiting','called','in_service')
  `;
  const params: unknown[] = [];
  if (dept && dept !== 'ALL') {
    sql += ' AND q.department = ?';
    params.push(dept);
  }
  sql += " ORDER BY CASE q.priority WHEN 'emergency' THEN 1 WHEN 'urgent' THEN 2 ELSE 3 END, q.id ASC";
  const tickets = await query(sql, params);
  res.json({ tickets });
});

router.post('/queue', requireAuth, requirePermission('queue.manage'), async (req: AuthRequest, res: Response) => {
  const { patient_id, department = 'OPD', priority = 'routine', notes } = req.body || {};
  if (!patient_id) return res.status(400).json({ error: 'patient_id is required' });
  const ticketNumber = await nextSequence('TICKET');
  const inserted = await execute(
    'INSERT INTO queue_tickets (ticket_number, department, patient_id, priority, status, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [ticketNumber, department, patient_id, priority, 'waiting', notes || null, req.user!.id]
  );
  await writeAuditLog({
    user: req.user,
    action: 'queue.ticket.create',
    entityType: 'queue_ticket',
    entityId: inserted.insertId,
    patientId: Number(patient_id),
    after: { ticketNumber, department, priority },
    req,
  });
  res.status(201).json({ id: inserted.insertId, ticketNumber });
});

router.patch('/queue/:id/status', requireAuth, requirePermission('queue.manage'), async (req: AuthRequest, res: Response) => {
  const id = Number(req.params.id);
  const { status, priority } = req.body || {};
  const ticket = await queryOne<Record<string, unknown>>('SELECT * FROM queue_tickets WHERE id = ?', [id]);
  if (!ticket) return res.status(404).json({ error: 'Queue ticket not found' });

  if (status) {
    await execute("UPDATE queue_tickets SET status = ?, called_at = CASE WHEN ? = 'called' THEN datetime('now') ELSE called_at END WHERE id = ?", [
      status,
      status,
      id,
    ]).catch(async () => {
      await execute('UPDATE queue_tickets SET status = ?, called_at = IF(? = "called", NOW(), called_at) WHERE id = ?', [
        status,
        status,
        id,
      ]);
    });
  }
  if (priority) {
    await execute('UPDATE queue_tickets SET priority = ? WHERE id = ?', [priority, id]);
  }
  await writeAuditLog({
    user: req.user,
    action: 'queue.ticket.update',
    entityType: 'queue_ticket',
    entityId: id,
    patientId: Number(ticket.patient_id),
    before: { status: ticket.status, priority: ticket.priority },
    after: { status: status ?? ticket.status, priority: priority ?? ticket.priority },
    req,
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// APPOINTMENTS
// ---------------------------------------------------------------------------
router.get('/appointments', requireAuth, requirePermission('appointment.read'), async (req, res) => {
  const date = req.query.date ? String(req.query.date) : null;
  const doctorId = req.query.doctorId ? Number(req.query.doctorId) : null;

  let sql = `
    SELECT a.*, p.mrn, p.first_name, p.last_name, p.phone, p.patient_type,
           u.full_name AS doctor_name, u.specialty
    FROM appointments a
    INNER JOIN patients p ON p.id = a.patient_id
    INNER JOIN users u ON u.id = a.doctor_id
    WHERE 1=1
  `;
  const params: unknown[] = [];
  if (date) {
    sql += ' AND a.appointment_date = ?';
    params.push(date);
  }
  if (doctorId) {
    sql += ' AND a.doctor_id = ?';
    params.push(doctorId);
  }
  sql += ' ORDER BY a.appointment_date ASC, a.start_time ASC';
  const appointments = await query(sql, params);
  res.json({ appointments });
});

router.post('/appointments', requireAuth, requirePermission('appointment.create'), async (req: AuthRequest, res: Response) => {
  const { patient_id, doctor_id, appointment_date, start_time, end_time, visit_type = 'consultation', reason } = req.body || {};
  if (!patient_id || !doctor_id || !appointment_date || !start_time || !end_time) {
    return res.status(400).json({ error: 'Patient, doctor, date, start time, and end time are required.' });
  }
  if (start_time >= end_time) {
    return res.status(400).json({ error: 'End time must be after start time.' });
  }

  const overlap = await queryOne<{ id: number; start_time: string; end_time: string }>(
    `SELECT id, start_time, end_time FROM appointments
     WHERE doctor_id = ? AND appointment_date = ?
       AND status NOT IN ('cancelled','no_show')
       AND start_time < ? AND end_time > ?
     LIMIT 1`,
    [doctor_id, appointment_date, end_time, start_time]
  );

  if (overlap) {
    return res.status(409).json({
      error: `Doctor already has a booking from ${overlap.start_time} to ${overlap.end_time} on ${appointment_date}.`,
    });
  }

  const inserted = await execute(
    `INSERT INTO appointments (patient_id, doctor_id, appointment_date, start_time, end_time, visit_type, reason, status, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', ?)`,
    [patient_id, doctor_id, appointment_date, start_time, end_time, visit_type, reason || null, req.user!.id]
  );

  await writeAuditLog({
    user: req.user,
    action: 'appointment.create',
    entityType: 'appointment',
    entityId: inserted.insertId,
    patientId: Number(patient_id),
    after: { doctor_id, appointment_date, start_time, end_time, visit_type },
    req,
  });

  res.status(201).json({ id: inserted.insertId });
});

router.patch('/appointments/:id', requireAuth, requirePermission('appointment.update'), async (req: AuthRequest, res: Response) => {
  const id = Number(req.params.id);
  const existing = await queryOne<Record<string, unknown>>('SELECT * FROM appointments WHERE id = ?', [id]);
  if (!existing) return res.status(404).json({ error: 'Appointment not found' });

  const { status, appointment_date, start_time, end_time, reason } = req.body || {};

  if (appointment_date && start_time && end_time) {
    const overlap = await queryOne<{ id: number }>(
      `SELECT id FROM appointments
       WHERE doctor_id = ? AND appointment_date = ? AND id != ?
         AND status NOT IN ('cancelled','no_show')
         AND start_time < ? AND end_time > ?
       LIMIT 1`,
      [existing.doctor_id, appointment_date, id, end_time, start_time]
    );
    if (overlap) {
      return res.status(409).json({ error: 'Selected slot conflicts with an existing appointment.' });
    }
    await execute(
      'UPDATE appointments SET appointment_date = ?, start_time = ?, end_time = ?, reason = COALESCE(?, reason) WHERE id = ?',
      [appointment_date, start_time, end_time, reason || null, id]
    );
  }

  let createdVisitId: number | null = null;
  let ticketNumber: string | null = null;

  if (status) {
    await execute('UPDATE appointments SET status = ? WHERE id = ?', [status, id]);
    if (status === 'checked_in' && existing.status !== 'checked_in') {
      const visitNum = await nextSequence('VISIT');
      const vRes = await execute(
        `INSERT INTO visits (visit_number, patient_id, doctor_id, appointment_id, triage_priority, chief_complaint, status, created_by)
         VALUES (?, ?, ?, ?, 'routine', ?, 'triage', ?)`,
        [visitNum, existing.patient_id, existing.doctor_id, id, existing.reason || 'Scheduled appointment', req.user!.id]
      );
      createdVisitId = vRes.insertId;
      ticketNumber = await nextSequence('TICKET');
      await execute(
        "INSERT INTO queue_tickets (ticket_number, department, patient_id, visit_id, priority, status, created_by) VALUES (?, 'OPD', ?, ?, 'routine', 'waiting', ?)",
        [ticketNumber, existing.patient_id, createdVisitId, req.user!.id]
      );

      const patient = await queryOne<{ patient_type: string; payer_name: string | null }>(
        'SELECT patient_type, payer_name FROM patients WHERE id = ?',
        [existing.patient_id]
      );
      if (patient && patient.patient_type !== 'exempt') {
        const invNum = await nextSequence('INV');
        const fee = existing.visit_type === 'follow-up' ? 25.0 : 45.0;
        const invStatus = patient.patient_type === 'insurance' || patient.patient_type === 'credit' ? 'credit_billed' : 'unpaid';
        const invRes = await execute(
          `INSERT INTO invoices (invoice_number, patient_id, visit_id, payer_type, payer_name, subtotal, discount_amount, total_amount, paid_amount, status, created_by)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?, 0, ?, ?)`,
          [invNum, existing.patient_id, createdVisitId, patient.patient_type, patient.payer_name, fee, fee, invStatus, req.user!.id]
        );
        await execute(
          'INSERT INTO invoice_items (invoice_id, service_code, description, category, quantity, unit_price, line_total) VALUES (?, ?, ?, ?, 1, ?, ?)',
          [invRes.insertId, existing.visit_type === 'follow-up' ? 'OPD-FU' : 'OPD-CONS', `${existing.visit_type} Consultation`, 'consultation', fee, fee]
        );
      }

      await createNotification({
        targetRole: 'NUR',
        title: 'Appointment Checked In',
        message: `Queue ${ticketNumber} is ready for triage vitals.`,
        severity: 'info',
        entityType: 'visit',
        entityId: createdVisitId,
      });
    }
  }

  await writeAuditLog({
    user: req.user,
    action: 'appointment.update',
    entityType: 'appointment',
    entityId: id,
    patientId: Number(existing.patient_id),
    before: { status: existing.status },
    after: { status: status ?? existing.status, createdVisitId, ticketNumber },
    req,
  });

  res.json({ ok: true, createdVisitId, ticketNumber });
});

// ---------------------------------------------------------------------------
// TRIAGE, VITALS & OPD VISITS
// ---------------------------------------------------------------------------
router.get('/visits', requireAuth, requirePermission('visit.read', 'vitals.read'), async (_req, res) => {
  const visits = await query(
    `SELECT v.*, p.mrn, p.first_name, p.last_name, p.sex, p.date_of_birth, p.allergies, p.blood_group, p.patient_type,
            u.full_name AS doctor_name
     FROM visits v
     INNER JOIN patients p ON p.id = v.patient_id
     LEFT JOIN users u ON u.id = v.doctor_id
     ORDER BY CASE v.triage_priority WHEN 'emergency' THEN 1 WHEN 'urgent' THEN 2 ELSE 3 END, v.id DESC LIMIT 60`
  );
  res.json({ visits });
});

router.get('/visits/:id', requireAuth, requirePermission('visit.read', 'vitals.read'), async (req: AuthRequest, res: Response) => {
  const id = Number(req.params.id);
  const visit = await queryOne<Record<string, unknown>>(
    `SELECT v.*, p.mrn, p.first_name, p.last_name, p.sex, p.date_of_birth, p.allergies, p.blood_group, p.patient_type,
            u.full_name AS doctor_name
     FROM visits v
     INNER JOIN patients p ON p.id = v.patient_id
     LEFT JOIN users u ON u.id = v.doctor_id
     WHERE v.id = ?`,
    [id]
  );
  if (!visit) return res.status(404).json({ error: 'Visit not found' });

  const vitals = await query('SELECT * FROM vitals WHERE visit_id = ? ORDER BY id DESC', [id]);
  const labOrders = await query(
    `SELECT lo.*, lt.code AS test_code, lt.name AS test_name, lt.unit, lt.reference_range, i.status AS invoice_status
     FROM lab_orders lo
     INNER JOIN lab_tests lt ON lt.id = lo.test_id
     LEFT JOIN invoices i ON i.id = lo.invoice_id
     WHERE lo.visit_id = ?`,
    [id]
  );
  const imagingOrders = await query(
    `SELECT io.*, ic.code AS exam_code, ic.name AS exam_name, ic.modality, i.status AS invoice_status
     FROM imaging_orders io
     INNER JOIN imaging_catalog ic ON ic.id = io.catalog_id
     LEFT JOIN invoices i ON i.id = io.invoice_id
     WHERE io.visit_id = ?`,
    [id]
  );
  const prescriptions = await query(
    `SELECT pr.*, i.status AS invoice_status
     FROM prescriptions pr
     LEFT JOIN invoices i ON i.id = pr.invoice_id
     WHERE pr.visit_id = ?`,
    [id]
  );
  for (const pr of prescriptions as Array<Record<string, unknown>>) {
    pr.items = await query(
      `SELECT pi.*, m.generic_name, m.strength, m.form
       FROM prescription_items pi
       INNER JOIN medicines m ON m.id = pi.medicine_id
       WHERE pi.prescription_id = ?`,
      [pr.id]
    );
  }

  res.json({ visit, vitals, labOrders, imagingOrders, prescriptions });
});

router.post('/visits', requireAuth, requirePermission('visit.create'), async (req: AuthRequest, res: Response) => {
  const { patient_id, doctor_id, triage_priority = 'routine', chief_complaint } = req.body || {};
  if (!patient_id) return res.status(400).json({ error: 'patient_id is required' });
  const visitNum = await nextSequence('VISIT');
  const inserted = await execute(
    `INSERT INTO visits (visit_number, patient_id, doctor_id, triage_priority, chief_complaint, status, created_by)
     VALUES (?, ?, ?, ?, ?, 'triage', ?)`,
    [visitNum, patient_id, doctor_id || null, triage_priority, chief_complaint || null, req.user!.id]
  );
  if (triage_priority === 'emergency') {
    await createNotification({
      targetRole: 'DOC',
      title: 'Emergency Visit Started',
      message: `Emergency visit ${visitNum} requires immediate assessment.`,
      severity: 'critical',
      entityType: 'visit',
      entityId: inserted.insertId,
    });
  }
  await writeAuditLog({
    user: req.user,
    action: 'visit.create',
    entityType: 'visit',
    entityId: inserted.insertId,
    patientId: Number(patient_id),
    after: { visitNum, triage_priority },
    req,
  });
  res.status(201).json({ id: inserted.insertId, visitNumber: visitNum });
});

router.post('/visits/:id/vitals', requireAuth, requirePermission('vitals.create'), async (req: AuthRequest, res: Response) => {
  const visitId = Number(req.params.id);
  const visit = await queryOne<{ id: number; patient_id: number; visit_number: string; status: string }>(
    'SELECT id, patient_id, visit_number, status FROM visits WHERE id = ?',
    [visitId]
  );
  if (!visit) return res.status(404).json({ error: 'Visit not found' });

  const {
    bp_systolic,
    bp_diastolic,
    temperature,
    pulse,
    respiratory_rate,
    spo2,
    weight_kg,
    height_cm,
    blood_glucose,
    triage_priority,
    chief_complaint,
    notes,
  } = req.body || {};

  const w = weight_kg ? Number(weight_kg) : null;
  const h = height_cm ? Number(height_cm) : null;
  const bmi = w && h && h > 0 ? Number((w / ((h / 100) * (h / 100))).toFixed(1)) : null;

  const earlyWarning =
    (spo2 && Number(spo2) < 92) ||
    (temperature && Number(temperature) >= 38.5) ||
    (bp_systolic && (Number(bp_systolic) >= 160 || Number(bp_systolic) < 90)) ||
    (pulse && (Number(pulse) > 110 || Number(pulse) < 50))
      ? 1
      : 0;

  const inserted = await execute(
    `INSERT INTO vitals (visit_id, patient_id, bp_systolic, bp_diastolic, temperature, pulse, respiratory_rate, spo2, weight_kg, height_cm, bmi, blood_glucose, early_warning_flag, notes, recorded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      visitId,
      visit.patient_id,
      bp_systolic || null,
      bp_diastolic || null,
      temperature || null,
      pulse || null,
      respiratory_rate || null,
      spo2 || null,
      w,
      h,
      bmi,
      blood_glucose || null,
      earlyWarning,
      notes || null,
      req.user!.id,
    ]
  );

  if (triage_priority || chief_complaint) {
    await execute(
      'UPDATE visits SET triage_priority = COALESCE(?, triage_priority), chief_complaint = COALESCE(?, chief_complaint) WHERE id = ?',
      [triage_priority || null, chief_complaint || null, visitId]
    );
  }

  if (earlyWarning || triage_priority === 'emergency') {
    await createNotification({
      targetRole: 'DOC',
      title: 'Early-Warning Vitals Alert',
      message: `Visit ${visit.visit_number} flagged abnormal vitals (SpO2 ${spo2}%, Temp ${temperature}°C).`,
      severity: 'critical',
      entityType: 'visit',
      entityId: visitId,
    });
  }

  await writeAuditLog({
    user: req.user,
    action: 'vitals.create',
    entityType: 'vitals',
    entityId: inserted.insertId,
    patientId: visit.patient_id,
    after: { bp_systolic, bp_diastolic, temperature, spo2, bmi, earlyWarning },
    req,
  });

  res.status(201).json({ id: inserted.insertId, bmi, earlyWarningFlag: Boolean(earlyWarning) });
});

router.patch('/visits/:id/consultation', requireAuth, requirePermission('visit.update'), async (req: AuthRequest, res: Response) => {
  const visitId = Number(req.params.id);
  const visit = await queryOne<{ id: number; patient_id: number; status: string }>('SELECT id, patient_id, status FROM visits WHERE id = ?', [
    visitId,
  ]);
  if (!visit) return res.status(404).json({ error: 'Visit not found' });
  if (visit.status === 'closed') {
    return res.status(409).json({ error: 'Visit is closed and locked. Manager approval is required to reopen.' });
  }

  const { chief_complaint, history_notes, exam_notes, diagnosis_code, diagnosis_text, treatment_plan, follow_up_date } = req.body || {};

  await execute(
    `UPDATE visits
     SET doctor_id = COALESCE(doctor_id, ?),
         chief_complaint = COALESCE(?, chief_complaint),
         history_notes = COALESCE(?, history_notes),
         exam_notes = COALESCE(?, exam_notes),
         diagnosis_code = COALESCE(?, diagnosis_code),
         diagnosis_text = COALESCE(?, diagnosis_text),
         treatment_plan = COALESCE(?, treatment_plan),
         follow_up_date = COALESCE(?, follow_up_date),
         status = CASE WHEN status = 'triage' THEN 'in_consultation' ELSE status END
     WHERE id = ?`,
    [
      req.user!.id,
      chief_complaint ?? null,
      history_notes ?? null,
      exam_notes ?? null,
      diagnosis_code ?? null,
      diagnosis_text ?? null,
      treatment_plan ?? null,
      follow_up_date ?? null,
      visitId,
    ]
  );

  await writeAuditLog({
    user: req.user,
    action: 'visit.update',
    entityType: 'visit',
    entityId: visitId,
    patientId: visit.patient_id,
    after: { diagnosis_code, diagnosis_text },
    req,
  });

  res.json({ ok: true });
});

router.post('/visits/:id/close', requireAuth, requirePermission('visit.close'), async (req: AuthRequest, res: Response) => {
  const visitId = Number(req.params.id);
  const visit = await queryOne<{ id: number; patient_id: number; diagnosis_text: string | null; status: string }>(
    'SELECT id, patient_id, diagnosis_text, status FROM visits WHERE id = ?',
    [visitId]
  );
  if (!visit) return res.status(404).json({ error: 'Visit not found' });
  if (!visit.diagnosis_text?.trim()) {
    return res.status(400).json({ error: 'Diagnosis is required before closing a visit.' });
  }

  await execute("UPDATE visits SET status = 'closed', closed_at = datetime('now'), closed_by = ? WHERE id = ?", [
    req.user!.id,
    visitId,
  ]).catch(async () => {
    await execute("UPDATE visits SET status = 'closed', closed_at = NOW(), closed_by = ? WHERE id = ?", [req.user!.id, visitId]);
  });

  await execute("UPDATE queue_tickets SET status = 'completed' WHERE visit_id = ?", [visitId]);

  await writeAuditLog({
    user: req.user,
    action: 'visit.close',
    entityType: 'visit',
    entityId: visitId,
    patientId: visit.patient_id,
    req,
  });
  res.json({ ok: true });
});

router.post('/visits/:id/reopen', requireAuth, requirePermission('visit.reopen'), async (req: AuthRequest, res: Response) => {
  const visitId = Number(req.params.id);
  const { reason } = req.body || {};
  if (!reason?.trim()) return res.status(400).json({ error: 'A formal reason is required to reopen a closed visit.' });

  const visit = await queryOne<{ id: number; patient_id: number }>('SELECT id, patient_id FROM visits WHERE id = ?', [visitId]);
  if (!visit) return res.status(404).json({ error: 'Visit not found' });

  await execute("UPDATE visits SET status = 'in_consultation', reopen_reason = ? WHERE id = ?", [reason.trim(), visitId]);
  await writeAuditLog({
    user: req.user,
    action: 'visit.reopen',
    entityType: 'visit',
    entityId: visitId,
    patientId: visit.patient_id,
    reason: reason.trim(),
    req,
  });
  res.json({ ok: true });
});

router.post('/visits/:id/orders/lab', requireAuth, requirePermission('order.lab.create'), async (req: AuthRequest, res: Response) => {
  const visitId = Number(req.params.id);
  const { test_id } = req.body || {};
  if (!test_id) return res.status(400).json({ error: 'test_id is required' });

  const visit = await queryOne<{ id: number; patient_id: number; status: string }>('SELECT id, patient_id, status FROM visits WHERE id = ?', [visitId]);
  if (!visit) return res.status(404).json({ error: 'Visit not found' });
  if (visit.status === 'closed') return res.status(409).json({ error: 'Cannot order tests on a closed visit.' });

  const test = await queryOne<{ id: number; code: string; name: string; price: number }>('SELECT * FROM lab_tests WHERE id = ?', [test_id]);
  if (!test) return res.status(404).json({ error: 'Lab test not found' });

  const patient = await queryOne<{ patient_type: string; payer_name: string | null }>(
    'SELECT patient_type, payer_name FROM patients WHERE id = ?',
    [visit.patient_id]
  );

  const invNum = await nextSequence('INV');
  const invStatus = patient?.patient_type === 'insurance' || patient?.patient_type === 'credit'
    ? 'credit_billed'
    : patient?.patient_type === 'exempt'
      ? 'paid'
      : 'unpaid';
  const total = patient?.patient_type === 'exempt' ? 0 : Number(test.price);
  const invRes = await execute(
    `INSERT INTO invoices (invoice_number, patient_id, visit_id, payer_type, payer_name, subtotal, discount_amount, total_amount, paid_amount, status, created_by)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
    [invNum, visit.patient_id, visitId, patient?.patient_type || 'self-pay', patient?.payer_name || null, total, total, invStatus === 'paid' ? total : 0, invStatus, req.user!.id]
  );
  await execute(
    'INSERT INTO invoice_items (invoice_id, service_code, description, category, quantity, unit_price, line_total) VALUES (?, ?, ?, ?, 1, ?, ?)',
    [invRes.insertId, test.code, test.name, 'lab', total, total]
  );

  const orderRes = await execute(
    'INSERT INTO lab_orders (visit_id, patient_id, test_id, invoice_id, ordered_by, status) VALUES (?, ?, ?, ?, ?, ?)',
    [visitId, visit.patient_id, test.id, invRes.insertId, req.user!.id, 'ordered']
  );

  await writeAuditLog({
    user: req.user,
    action: 'order.lab.create',
    entityType: 'lab_order',
    entityId: orderRes.insertId,
    patientId: visit.patient_id,
    after: { test_code: test.code, invoice_number: invNum },
    req,
  });

  res.status(201).json({ id: orderRes.insertId, invoiceNumber: invNum });
});

router.post('/visits/:id/orders/imaging', requireAuth, requirePermission('order.imaging.create'), async (req: AuthRequest, res: Response) => {
  const visitId = Number(req.params.id);
  const { catalog_id, clinical_question } = req.body || {};
  if (!catalog_id) return res.status(400).json({ error: 'catalog_id is required' });

  const visit = await queryOne<{ id: number; patient_id: number; status: string }>('SELECT id, patient_id, status FROM visits WHERE id = ?', [visitId]);
  if (!visit) return res.status(404).json({ error: 'Visit not found' });
  if (visit.status === 'closed') return res.status(409).json({ error: 'Cannot order imaging on a closed visit.' });

  const exam = await queryOne<{ id: number; code: string; name: string; price: number }>('SELECT * FROM imaging_catalog WHERE id = ?', [catalog_id]);
  if (!exam) return res.status(404).json({ error: 'Imaging exam not found' });

  const patient = await queryOne<{ patient_type: string; payer_name: string | null }>(
    'SELECT patient_type, payer_name FROM patients WHERE id = ?',
    [visit.patient_id]
  );

  const invNum = await nextSequence('INV');
  const invStatus = patient?.patient_type === 'insurance' || patient?.patient_type === 'credit'
    ? 'credit_billed'
    : patient?.patient_type === 'exempt'
      ? 'paid'
      : 'unpaid';
  const total = patient?.patient_type === 'exempt' ? 0 : Number(exam.price);
  const invRes = await execute(
    `INSERT INTO invoices (invoice_number, patient_id, visit_id, payer_type, payer_name, subtotal, discount_amount, total_amount, paid_amount, status, created_by)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
    [invNum, visit.patient_id, visitId, patient?.patient_type || 'self-pay', patient?.payer_name || null, total, total, invStatus === 'paid' ? total : 0, invStatus, req.user!.id]
  );
  await execute(
    'INSERT INTO invoice_items (invoice_id, service_code, description, category, quantity, unit_price, line_total) VALUES (?, ?, ?, ?, 1, ?, ?)',
    [invRes.insertId, exam.code, exam.name, 'imaging', total, total]
  );

  const ordRes = await execute(
    'INSERT INTO imaging_orders (visit_id, patient_id, catalog_id, invoice_id, ordered_by, clinical_question, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [visitId, visit.patient_id, exam.id, invRes.insertId, req.user!.id, clinical_question || null, 'ordered']
  );

  await createNotification({
    targetRole: 'IMG',
    title: 'New Imaging Order',
    message: `${exam.name} ordered (${invNum}).`,
    severity: 'info',
    entityType: 'imaging_order',
    entityId: ordRes.insertId,
  });

  await writeAuditLog({
    user: req.user,
    action: 'imaging.order.create',
    entityType: 'imaging_order',
    entityId: ordRes.insertId,
    patientId: visit.patient_id,
    after: { exam_code: exam.code, invoice_number: invNum },
    req,
  });

  res.status(201).json({ id: ordRes.insertId, invoiceNumber: invNum });
});

router.post('/visits/:id/orders/prescription', requireAuth, requirePermission('prescription.create'), async (req: AuthRequest, res: Response) => {
  const visitId = Number(req.params.id);
  const { medicine_id, dosage, frequency, duration_days = 5, quantity = 1, instructions, notes } = req.body || {};
  if (!medicine_id || !dosage || !frequency || !quantity) {
    return res.status(400).json({ error: 'Medicine, dosage, frequency, and quantity are required.' });
  }

  const visit = await queryOne<{ id: number; patient_id: number; status: string }>('SELECT id, patient_id, status FROM visits WHERE id = ?', [visitId]);
  if (!visit) return res.status(404).json({ error: 'Visit not found' });
  if (visit.status === 'closed') return res.status(409).json({ error: 'Cannot prescribe on a closed visit.' });

  const med = await queryOne<{ id: number; code: string; generic_name: string; strength: string; unit_price: number }>(
    'SELECT * FROM medicines WHERE id = ?',
    [medicine_id]
  );
  if (!med) return res.status(404).json({ error: 'Medicine not found' });

  const patient = await queryOne<{ patient_type: string; payer_name: string | null; allergies: string | null }>(
    'SELECT patient_type, payer_name, allergies FROM patients WHERE id = ?',
    [visit.patient_id]
  );

  const lineTotal = patient?.patient_type === 'exempt' ? 0 : Number(med.unit_price) * Number(quantity);
  const invNum = await nextSequence('INV');
  const invStatus = patient?.patient_type === 'insurance' || patient?.patient_type === 'credit'
    ? 'credit_billed'
    : patient?.patient_type === 'exempt'
      ? 'paid'
      : 'unpaid';

  const invRes = await execute(
    `INSERT INTO invoices (invoice_number, patient_id, visit_id, payer_type, payer_name, subtotal, discount_amount, total_amount, paid_amount, status, created_by)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
    [invNum, visit.patient_id, visitId, patient?.patient_type || 'self-pay', patient?.payer_name || null, lineTotal, lineTotal, invStatus === 'paid' ? lineTotal : 0, invStatus, req.user!.id]
  );
  await execute(
    'INSERT INTO invoice_items (invoice_id, service_code, description, category, quantity, unit_price, line_total) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [invRes.insertId, med.code, `${med.generic_name} ${med.strength}`, 'pharmacy', quantity, med.unit_price, lineTotal]
  );

  const rxRes = await execute(
    "INSERT INTO prescriptions (visit_id, patient_id, doctor_id, invoice_id, status, notes) VALUES (?, ?, ?, ?, 'pending', ?)",
    [visitId, visit.patient_id, req.user!.id, invRes.insertId, notes || null]
  );
  await execute(
    'INSERT INTO prescription_items (prescription_id, medicine_id, dosage, frequency, duration_days, quantity, instructions) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [rxRes.insertId, med.id, dosage, frequency, duration_days, quantity, instructions || null]
  );

  await writeAuditLog({
    user: req.user,
    action: 'prescription.create',
    entityType: 'prescription',
    entityId: rxRes.insertId,
    patientId: visit.patient_id,
    after: { medicine: med.generic_name, quantity, invoiceNumber: invNum },
    req,
  });

  res.status(201).json({ id: rxRes.insertId, invoiceNumber: invNum, patientAllergies: patient?.allergies });
});

// ---------------------------------------------------------------------------
// LABORATORY WORKLIST (Two-Step Verify, Reject, Amend, Emergency Gate Bypass)
// ---------------------------------------------------------------------------
router.get('/lab/orders', requireAuth, requirePermission('lab.order.read'), async (_req, res) => {
  const orders = await query(
    `SELECT lo.*, lt.code AS test_code, lt.name AS test_name, lt.sample_type, lt.unit, lt.reference_range,
            p.mrn, p.first_name, p.last_name, p.patient_type, v.triage_priority,
            i.invoice_number, i.status AS invoice_status,
            u_ent.full_name AS entered_by_name, u_ver.full_name AS verified_by_name
     FROM lab_orders lo
     INNER JOIN lab_tests lt ON lt.id = lo.test_id
     INNER JOIN patients p ON p.id = lo.patient_id
     INNER JOIN visits v ON v.id = lo.visit_id
     LEFT JOIN invoices i ON i.id = lo.invoice_id
     LEFT JOIN users u_ent ON u_ent.id = lo.entered_by
     LEFT JOIN users u_ver ON u_ver.id = lo.verified_by
     ORDER BY CASE v.triage_priority WHEN 'emergency' THEN 1 WHEN 'urgent' THEN 2 ELSE 3 END, lo.id DESC LIMIT 60`
  );
  res.json({ orders });
});

router.patch('/lab/orders/:id', requireAuth, requirePermission('lab.sample.collect', 'lab.result.enter', 'lab.result.verify', 'visit.read'), async (req: AuthRequest, res: Response) => {
  const id = Number(req.params.id);
  const order = await queryOne<{
    id: number;
    visit_id: number;
    patient_id: number;
    status: string;
    invoice_id: number | null;
    result_value: string | null;
    entered_by: number | null;
    abnormal_flag: string | null;
  }>('SELECT * FROM lab_orders WHERE id = ?', [id]);
  if (!order) return res.status(404).json({ error: 'Lab order not found' });

  const visit = await queryOne<{ triage_priority: string }>('SELECT triage_priority FROM visits WHERE id = ?', [order.visit_id]);
  const { action, result_value, abnormal_flag, result_notes, rejection_reason, amend_reason, bypass_payment_gate } = req.body || {};

  // Critical result acknowledgement by doctor does not hit payment gate
  if (action === 'ack_critical') {
    await execute("UPDATE lab_orders SET critical_ack_by = ?, critical_ack_at = datetime('now') WHERE id = ?", [req.user!.id, id]).catch(async () => {
      await execute('UPDATE lab_orders SET critical_ack_by = ?, critical_ack_at = NOW() WHERE id = ?', [req.user!.id, id]);
    });
    await writeAuditLog({
      user: req.user,
      action: 'lab.critical.ack',
      entityType: 'lab_order',
      entityId: id,
      patientId: order.patient_id,
      req,
    });
    return res.json({ ok: true });
  }

  // Payment gate check (emergency visits or explicit emergency bypass are logged & permitted)
  if (order.invoice_id) {
    const inv = await queryOne<{ status: string; payer_type: string }>('SELECT status, payer_type FROM invoices WHERE id = ?', [
      order.invoice_id,
    ]);
    const isUnpaidSelfPay = inv && inv.payer_type === 'self-pay' && inv.status !== 'paid';
    if (isUnpaidSelfPay) {
      if (visit?.triage_priority === 'emergency' || bypass_payment_gate) {
        await writeAuditLog({
          user: req.user,
          action: 'payment.gate.bypass',
          entityType: 'lab_order',
          entityId: id,
          patientId: order.patient_id,
          reason: 'Emergency clinical bypass of self-pay lab payment gate',
          req,
        });
      } else {
        return res.status(402).json({
          error: 'Payment Gate: Self-pay lab invoice must be paid at Cashier before processing (unless emergency bypass).',
        });
      }
    }
  }

  if (action === 'collect') {
    if (!hasPermission(req.user!, 'lab.sample.collect')) return res.status(403).json({ error: 'Missing lab.sample.collect permission' });
    const barcode = `SMP-${String(id).padStart(6, '0')}`;
    await execute("UPDATE lab_orders SET status = 'collected', sample_barcode = ? WHERE id = ?", [barcode, id]);
    await writeAuditLog({
      user: req.user,
      action: 'lab.sample.collect',
      entityType: 'lab_order',
      entityId: id,
      patientId: order.patient_id,
      after: { barcode },
      req,
    });
    return res.json({ ok: true, barcode });
  }

  if (action === 'reject') {
    if (!hasPermission(req.user!, 'lab.sample.collect')) return res.status(403).json({ error: 'Missing lab permission' });
    if (!rejection_reason?.trim()) return res.status(400).json({ error: 'Rejection reason is required.' });
    await execute("UPDATE lab_orders SET status = 'rejected', rejection_reason = ? WHERE id = ?", [rejection_reason.trim(), id]);
    await createNotification({
      targetRole: 'DOC',
      title: 'Lab Sample Rejected',
      message: `Lab order #${id} rejected: ${rejection_reason.trim()}`,
      severity: 'warning',
      entityType: 'lab_order',
      entityId: id,
    });
    await writeAuditLog({
      user: req.user,
      action: 'lab.sample.reject',
      entityType: 'lab_order',
      entityId: id,
      patientId: order.patient_id,
      reason: rejection_reason.trim(),
      req,
    });
    return res.json({ ok: true });
  }

  if (action === 'recollect') {
    await execute("UPDATE lab_orders SET status = 'ordered', sample_barcode = NULL, rejection_reason = NULL WHERE id = ?", [id]);
    await writeAuditLog({
      user: req.user,
      action: 'lab.sample.recollect',
      entityType: 'lab_order',
      entityId: id,
      patientId: order.patient_id,
      req,
    });
    return res.json({ ok: true });
  }

  if (action === 'enter_result') {
    if (!hasPermission(req.user!, 'lab.result.enter')) return res.status(403).json({ error: 'Missing lab.result.enter permission' });
    if (!result_value) return res.status(400).json({ error: 'Result value is required.' });
    await execute("UPDATE lab_orders SET result_value = ?, abnormal_flag = ?, result_notes = ?, status = 'resulted', entered_by = ? WHERE id = ?", [
      result_value,
      abnormal_flag || 'normal',
      result_notes || null,
      req.user!.id,
      id,
    ]);
    await writeAuditLog({
      user: req.user,
      action: 'lab.result.enter',
      entityType: 'lab_order',
      entityId: id,
      patientId: order.patient_id,
      after: { result_value, abnormal_flag },
      req,
    });
    return res.json({ ok: true });
  }

  if (action === 'verify') {
    if (!hasPermission(req.user!, 'lab.result.verify')) return res.status(403).json({ error: 'Missing lab.result.verify permission' });
    if (!order.result_value) return res.status(400).json({ error: 'Cannot verify before result is entered.' });
    if (order.entered_by === req.user!.id) {
      return res.status(403).json({
        error: 'Two-Person Verification Rule: The verifier cannot be the same technician who entered the result. Sign in as Senior Lab Verifier (lab2@clinic360.local).',
      });
    }
    await execute("UPDATE lab_orders SET status = 'verified', verified_by = ?, verified_at = datetime('now') WHERE id = ?", [
      req.user!.id,
      id,
    ]).catch(async () => {
      await execute("UPDATE lab_orders SET status = 'verified', verified_by = ?, verified_at = NOW() WHERE id = ?", [req.user!.id, id]);
    });
    await createNotification({
      targetRole: 'DOC',
      title: order.abnormal_flag === 'critical' ? 'CRITICAL Lab Result Released' : 'Lab Result Verified',
      message: `Lab order #${id} verified (${order.result_value}).`,
      severity: order.abnormal_flag === 'critical' ? 'critical' : 'info',
      entityType: 'lab_order',
      entityId: id,
    });
    await writeAuditLog({
      user: req.user,
      action: 'lab.result.verify',
      entityType: 'lab_order',
      entityId: id,
      patientId: order.patient_id,
      req,
    });
    return res.json({ ok: true });
  }

  if (action === 'amend') {
    if (!hasPermission(req.user!, 'lab.result.verify')) return res.status(403).json({ error: 'Missing lab amendment permission' });
    if (!result_value || !amend_reason?.trim()) {
      return res.status(400).json({ error: 'New result value and formal amendment reason are required.' });
    }
    await execute(
      "UPDATE lab_orders SET previous_result_value = result_value, result_value = ?, abnormal_flag = ?, amend_reason = ?, status = 'amended' WHERE id = ?",
      [result_value, abnormal_flag || order.abnormal_flag || 'normal', amend_reason.trim(), id]
    );
    await writeAuditLog({
      user: req.user,
      action: 'lab.result.amend',
      entityType: 'lab_order',
      entityId: id,
      patientId: order.patient_id,
      before: { result_value: order.result_value },
      after: { result_value, abnormal_flag },
      reason: amend_reason.trim(),
      req,
    });
    return res.json({ ok: true });
  }

  res.status(400).json({ error: 'Unsupported lab action' });
});

// ---------------------------------------------------------------------------
// IMAGING / RADIOLOGY WORKLIST
// ---------------------------------------------------------------------------
router.get('/imaging/orders', requireAuth, requirePermission('imaging.order.read'), async (_req, res) => {
  const orders = await query(
    `SELECT io.*, ic.code AS exam_code, ic.name AS exam_name, ic.modality, ic.body_region,
            p.mrn, p.first_name, p.last_name, p.sex, p.date_of_birth, p.patient_type,
            i.invoice_number, i.status AS invoice_status
     FROM imaging_orders io
     INNER JOIN imaging_catalog ic ON ic.id = io.catalog_id
     INNER JOIN patients p ON p.id = io.patient_id
     LEFT JOIN invoices i ON i.id = io.invoice_id
     ORDER BY io.id DESC LIMIT 60`
  );
  res.json({ orders });
});

router.patch('/imaging/orders/:id', requireAuth, requirePermission('imaging.exam.perform', 'imaging.report.finalise'), async (req: AuthRequest, res: Response) => {
  const id = Number(req.params.id);
  const order = await queryOne<{ id: number; patient_id: number; invoice_id: number | null; status: string }>(
    'SELECT * FROM imaging_orders WHERE id = ?',
    [id]
  );
  if (!order) return res.status(404).json({ error: 'Imaging order not found' });

  const { action, pregnancy_checked, exam_notes, findings, impression, addendum } = req.body || {};

  if (order.invoice_id) {
    const inv = await queryOne<{ status: string; payer_type: string }>('SELECT status, payer_type FROM invoices WHERE id = ?', [
      order.invoice_id,
    ]);
    if (inv && inv.payer_type === 'self-pay' && inv.status !== 'paid') {
      return res.status(402).json({ error: 'Payment Gate: Self-pay imaging invoice must be paid at Cashier before scanning.' });
    }
  }

  if (action === 'perform') {
    await execute(
      "UPDATE imaging_orders SET status = 'performed', pregnancy_checked = ?, exam_notes = ?, performed_by = ? WHERE id = ?",
      [pregnancy_checked ? 1 : 0, exam_notes || null, req.user!.id, id]
    );
    await writeAuditLog({
      user: req.user,
      action: 'imaging.exam.perform',
      entityType: 'imaging_order',
      entityId: id,
      patientId: order.patient_id,
      after: { pregnancy_checked: Boolean(pregnancy_checked), exam_notes },
      req,
    });
    return res.json({ ok: true });
  }

  if (action === 'finalise') {
    if (!findings?.trim() || !impression?.trim()) {
      return res.status(400).json({ error: 'Findings and impression are required to finalise report.' });
    }
    await execute(
      "UPDATE imaging_orders SET status = 'reported_final', findings = ?, impression = ?, reported_by = ?, finalised_at = datetime('now') WHERE id = ?",
      [findings.trim(), impression.trim(), req.user!.id, id]
    ).catch(async () => {
      await execute(
        "UPDATE imaging_orders SET status = 'reported_final', findings = ?, impression = ?, reported_by = ?, finalised_at = NOW() WHERE id = ?",
        [findings.trim(), impression.trim(), req.user!.id, id]
      );
    });
    await createNotification({
      targetRole: 'DOC',
      title: 'Imaging Report Finalised',
      message: `Imaging order #${id} report is finalised and ready for review.`,
      severity: 'info',
      entityType: 'imaging_order',
      entityId: id,
    });
    await writeAuditLog({
      user: req.user,
      action: 'imaging.report.finalise',
      entityType: 'imaging_order',
      entityId: id,
      patientId: order.patient_id,
      after: { impression: impression.trim() },
      req,
    });
    return res.json({ ok: true });
  }

  if (action === 'addendum') {
    if (!addendum?.trim()) return res.status(400).json({ error: 'Addendum text is required.' });
    await execute('UPDATE imaging_orders SET addendum = ? WHERE id = ?', [addendum.trim(), id]);
    await writeAuditLog({
      user: req.user,
      action: 'imaging.report.addendum',
      entityType: 'imaging_order',
      entityId: id,
      patientId: order.patient_id,
      after: { addendum: addendum.trim() },
      req,
    });
    return res.json({ ok: true });
  }

  res.status(400).json({ error: 'Unsupported imaging action' });
});

// ---------------------------------------------------------------------------
// PHARMACY DISPENSING
// ---------------------------------------------------------------------------
router.get('/pharmacy/prescriptions', requireAuth, requirePermission('pharmacy.prescription.read'), async (_req, res) => {
  const prescriptions = await query(
    `SELECT pr.*, p.mrn, p.first_name, p.last_name, p.allergies, p.patient_type,
            u.full_name AS doctor_name, i.invoice_number, i.status AS invoice_status
     FROM prescriptions pr
     INNER JOIN patients p ON p.id = pr.patient_id
     INNER JOIN users u ON u.id = pr.doctor_id
     LEFT JOIN invoices i ON i.id = pr.invoice_id
     ORDER BY pr.id DESC LIMIT 60`
  );
  for (const pr of prescriptions as Array<Record<string, unknown>>) {
    pr.items = await query(
      `SELECT pi.*, m.code, m.generic_name, m.strength, m.form, m.stock_qty, m.batch_number, m.expiry_date
       FROM prescription_items pi
       INNER JOIN medicines m ON m.id = pi.medicine_id
       WHERE pi.prescription_id = ?`,
      [pr.id]
    );
  }
  res.json({ prescriptions });
});

router.post('/pharmacy/dispense/:id', requireAuth, requirePermission('pharmacy.dispense'), async (req: AuthRequest, res: Response) => {
  const id = Number(req.params.id);
  const { overrideAllergyReason, bypass_payment_gate } = req.body || {};
  const rx = await queryOne<{ id: number; visit_id: number; patient_id: number; invoice_id: number | null; status: string }>(
    'SELECT * FROM prescriptions WHERE id = ?',
    [id]
  );
  if (!rx) return res.status(404).json({ error: 'Prescription not found' });
  if (rx.status === 'dispensed') return res.status(409).json({ error: 'Prescription already dispensed.' });

  const visit = await queryOne<{ triage_priority: string }>('SELECT triage_priority FROM visits WHERE id = ?', [rx.visit_id]);

  if (rx.invoice_id) {
    const inv = await queryOne<{ status: string; payer_type: string }>('SELECT status, payer_type FROM invoices WHERE id = ?', [
      rx.invoice_id,
    ]);
    if (inv && inv.payer_type === 'self-pay' && inv.status !== 'paid') {
      if (visit?.triage_priority === 'emergency' || bypass_payment_gate) {
        await writeAuditLog({
          user: req.user,
          action: 'payment.gate.bypass',
          entityType: 'prescription',
          entityId: id,
          patientId: rx.patient_id,
          reason: 'Emergency clinical bypass at Pharmacy',
          req,
        });
      } else {
        return res.status(402).json({ error: 'Payment Gate: Self-pay prescription invoice must be paid at Cashier before dispensing.' });
      }
    }
  }

  const patient = await queryOne<{ allergies: string | null }>('SELECT allergies FROM patients WHERE id = ?', [rx.patient_id]);
  const items = await query<{ id: number; medicine_id: number; quantity: number; generic_name: string; stock_qty: number }>(
    `SELECT pi.id, pi.medicine_id, pi.quantity, m.generic_name, m.stock_qty
     FROM prescription_items pi
     INNER JOIN medicines m ON m.id = pi.medicine_id
     WHERE pi.prescription_id = ?`,
    [id]
  );

  const allergyText = (patient?.allergies || '').toLowerCase();
  for (const item of items) {
    const medLower = item.generic_name.toLowerCase();
    const penicillinConflict = allergyText.includes('penicillin') && (medLower.includes('amoxicillin') || medLower.includes('penicillin'));
    if (penicillinConflict && !overrideAllergyReason) {
      return res.status(422).json({
        error: `Allergy Safety Block: Patient has recorded allergy (${patient?.allergies}) conflicting with ${item.generic_name}.`,
      });
    }
    if (item.stock_qty < item.quantity) {
      return res.status(409).json({
        error: `Insufficient dispensary stock for ${item.generic_name} (available: ${item.stock_qty}, requested: ${item.quantity}).`,
      });
    }
  }

  for (const item of items) {
    await execute('UPDATE medicines SET stock_qty = stock_qty - ? WHERE id = ?', [item.quantity, item.medicine_id]);
    await execute('UPDATE prescription_items SET dispensed_qty = ? WHERE id = ?', [item.quantity, item.id]);
  }

  await execute("UPDATE prescriptions SET status = 'dispensed', dispensed_at = datetime('now'), dispensed_by = ? WHERE id = ?", [
    req.user!.id,
    id,
  ]).catch(async () => {
    await execute("UPDATE prescriptions SET status = 'dispensed', dispensed_at = NOW(), dispensed_by = ? WHERE id = ?", [
      req.user!.id,
      id,
    ]);
  });

  await writeAuditLog({
    user: req.user,
    action: 'pharmacy.dispense',
    entityType: 'prescription',
    entityId: id,
    patientId: rx.patient_id,
    after: { items: items.map((i) => ({ medicine: i.generic_name, qty: i.quantity })) },
    reason: overrideAllergyReason || null,
    req,
  });

  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// INPATIENT (IPD) WARDS, BED BOARD, ADMISSIONS & MAR
// ---------------------------------------------------------------------------
router.get('/ipd/overview', requireAuth, requirePermission('ipd.admission.read'), async (_req, res) => {
  const wards = await query('SELECT * FROM wards ORDER BY id ASC');
  const beds = await query(
    `SELECT b.*, w.code AS ward_code, w.name AS ward_name, w.daily_tariff,
            a.id AS admission_id, a.admission_number, p.mrn, p.first_name, p.last_name
     FROM beds b
     INNER JOIN wards w ON w.id = b.ward_id
     LEFT JOIN admissions a ON a.bed_id = b.id AND a.status IN ('admitted','discharge_ordered','cleared')
     LEFT JOIN patients p ON p.id = a.patient_id
     ORDER BY w.id ASC, b.bed_number ASC`
  );
  const admissions = await query(
    `SELECT a.*, p.mrn, p.first_name, p.last_name, p.sex, p.allergies,
            w.name AS ward_name, b.bed_number, u.full_name AS doctor_name
     FROM admissions a
     INNER JOIN patients p ON p.id = a.patient_id
     INNER JOIN wards w ON w.id = a.ward_id
     LEFT JOIN beds b ON b.id = a.bed_id
     INNER JOIN users u ON u.id = a.admitting_doctor_id
     ORDER BY a.id DESC LIMIT 30`
  );
  const mar = await query(
    `SELECT ma.*, p.mrn, p.first_name, p.last_name, a.admission_number, b.bed_number
     FROM medication_administrations ma
     INNER JOIN admissions a ON a.id = ma.admission_id
     INNER JOIN patients p ON p.id = ma.patient_id
     LEFT JOIN beds b ON b.id = a.bed_id
     WHERE a.status IN ('admitted','discharge_ordered')
     ORDER BY ma.id DESC LIMIT 40`
  );
  res.json({ wards, beds, admissions, mar });
});

router.post('/ipd/admissions', requireAuth, requirePermission('ipd.admission.create'), async (req: AuthRequest, res: Response) => {
  const { patient_id, visit_id, ward_id, admission_diagnosis, initial_medication, initial_dose } = req.body || {};
  if (!patient_id || !ward_id || !admission_diagnosis?.trim()) {
    return res.status(400).json({ error: 'Patient, ward, and admission diagnosis are required.' });
  }
  const admNum = await nextSequence('ADM');
  const resAdm = await execute(
    `INSERT INTO admissions (admission_number, patient_id, visit_id, admitting_doctor_id, ward_id, admission_diagnosis, status)
     VALUES (?, ?, ?, ?, ?, ?, 'ordered')`,
    [admNum, Number(patient_id), visit_id ? Number(visit_id) : null, req.user!.id, Number(ward_id), admission_diagnosis.trim()]
  );

  if (initial_medication?.trim()) {
    await execute(
      "INSERT INTO medication_administrations (admission_id, patient_id, medicine_name, dose, scheduled_time, status) VALUES (?, ?, ?, ?, '08:00', 'due')",
      [resAdm.insertId, Number(patient_id), initial_medication.trim(), initial_dose || 'Per order']
    );
  }

  await createNotification({
    targetRole: 'WRD',
    title: 'New Admission Order',
    message: `${admNum} ordered for ward bed allocation.`,
    severity: 'info',
    entityType: 'admission',
    entityId: resAdm.insertId,
  });

  await writeAuditLog({
    user: req.user,
    action: 'ipd.admission.create',
    entityType: 'admission',
    entityId: resAdm.insertId,
    patientId: Number(patient_id),
    after: { admNum, ward_id },
    req,
  });

  res.status(201).json({ id: resAdm.insertId, admissionNumber: admNum });
});

router.post('/ipd/admissions/:id/assign-bed', requireAuth, requirePermission('ipd.bed.assign'), async (req: AuthRequest, res: Response) => {
  const admId = Number(req.params.id);
  const { bed_id } = req.body || {};
  if (!bed_id) return res.status(400).json({ error: 'bed_id is required' });

  const adm = await queryOne<{ id: number; patient_id: number; bed_id: number | null }>('SELECT * FROM admissions WHERE id = ?', [admId]);
  const bed = await queryOne<{ id: number; bed_number: string; status: string }>('SELECT * FROM beds WHERE id = ?', [bed_id]);
  if (!adm || !bed) return res.status(404).json({ error: 'Admission or bed not found' });
  if (bed.status !== 'vacant' && bed.status !== 'reserved') {
    return res.status(409).json({ error: `Bed ${bed.bed_number} is currently ${bed.status}.` });
  }

  if (adm.bed_id) {
    await execute("UPDATE beds SET status = 'cleaning' WHERE id = ?", [adm.bed_id]);
  }
  await execute("UPDATE beds SET status = 'occupied' WHERE id = ?", [bed.id]);
  await execute("UPDATE admissions SET bed_id = ?, status = 'admitted' WHERE id = ?", [bed.id, admId]);

  await writeAuditLog({
    user: req.user,
    action: 'ipd.bed.assign',
    entityType: 'admission',
    entityId: admId,
    patientId: adm.patient_id,
    after: { bed_number: bed.bed_number },
    req,
  });
  res.json({ ok: true });
});

router.post('/ipd/mar/:id/administer', requireAuth, requirePermission('ipd.mar.give'), async (req: AuthRequest, res: Response) => {
  const marId = Number(req.params.id);
  const { status, reason_not_given } = req.body || {};
  if (!['given', 'withheld'].includes(status)) {
    return res.status(400).json({ error: 'Status must be given or withheld' });
  }
  if (status === 'withheld' && !reason_not_given?.trim()) {
    return res.status(400).json({ error: 'A clinical reason is required when withholding medication.' });
  }

  const row = await queryOne<{ id: number; patient_id: number; medicine_name: string }>(
    'SELECT * FROM medication_administrations WHERE id = ?',
    [marId]
  );
  if (!row) return res.status(404).json({ error: 'MAR entry not found' });

  await execute(
    "UPDATE medication_administrations SET status = ?, reason_not_given = ?, administered_by_name = ?, administered_at = datetime('now') WHERE id = ?",
    [status, reason_not_given || null, req.user!.fullName, marId]
  ).catch(async () => {
    await execute(
      'UPDATE medication_administrations SET status = ?, reason_not_given = ?, administered_by_name = ?, administered_at = NOW() WHERE id = ?',
      [status, reason_not_given || null, req.user!.fullName, marId]
    );
  });

  await writeAuditLog({
    user: req.user,
    action: 'ipd.mar.give',
    entityType: 'medication_administration',
    entityId: marId,
    patientId: row.patient_id,
    after: { medicine_name: row.medicine_name, status, reason_not_given },
    req,
  });
  res.json({ ok: true });
});

router.post('/ipd/admissions/:id/discharge-order', requireAuth, requirePermission('ipd.discharge.create'), async (req: AuthRequest, res: Response) => {
  const admId = Number(req.params.id);
  const { discharge_summary } = req.body || {};
  if (!discharge_summary?.trim()) return res.status(400).json({ error: 'Discharge summary is required.' });
  const adm = await queryOne<{ id: number; patient_id: number; admission_number: string }>('SELECT * FROM admissions WHERE id = ?', [admId]);
  if (!adm) return res.status(404).json({ error: 'Admission not found' });

  await execute("UPDATE admissions SET discharge_summary = ?, status = 'discharge_ordered' WHERE id = ?", [
    discharge_summary.trim(),
    admId,
  ]);

  await createNotification({
    targetRole: 'CSH',
    title: 'IPD Discharge Clearance Needed',
    message: `${adm.admission_number} has a discharge order awaiting financial clearance.`,
    severity: 'warning',
    entityType: 'admission',
    entityId: admId,
  });

  await writeAuditLog({
    user: req.user,
    action: 'ipd.discharge.create',
    entityType: 'admission',
    entityId: admId,
    patientId: adm.patient_id,
    req,
  });
  res.json({ ok: true });
});

router.post('/ipd/admissions/:id/clear', requireAuth, requirePermission('ipd.discharge.clear'), async (req: AuthRequest, res: Response) => {
  const admId = Number(req.params.id);
  const adm = await queryOne<{ id: number; patient_id: number; bed_id: number | null }>('SELECT * FROM admissions WHERE id = ?', [admId]);
  if (!adm) return res.status(404).json({ error: 'Admission not found' });

  await execute("UPDATE admissions SET discharge_cleared = 1, status = 'discharged', discharged_at = datetime('now') WHERE id = ?", [
    admId,
  ]).catch(async () => {
    await execute("UPDATE admissions SET discharge_cleared = 1, status = 'discharged', discharged_at = NOW() WHERE id = ?", [admId]);
  });

  if (adm.bed_id) {
    await execute("UPDATE beds SET status = 'cleaning' WHERE id = ?", [adm.bed_id]);
  }

  await writeAuditLog({
    user: req.user,
    action: 'ipd.discharge.clear',
    entityType: 'admission',
    entityId: admId,
    patientId: adm.patient_id,
    req,
  });
  res.json({ ok: true });
});

router.patch('/ipd/beds/:id/status', requireAuth, requirePermission('ipd.bed.assign'), async (req: AuthRequest, res: Response) => {
  const bedId = Number(req.params.id);
  const { status } = req.body || {};
  if (!['vacant', 'cleaning', 'out_of_service'].includes(status)) {
    return res.status(400).json({ error: 'Invalid bed status update.' });
  }
  await execute('UPDATE beds SET status = ? WHERE id = ?', [status, bedId]);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// SECURE BILLING, SHIFTS, RECEIPTS (REPRINTS) & APPROVALS
// ---------------------------------------------------------------------------
router.get('/billing/shifts', requireAuth, requirePermission('billing.shift.manage', 'finance.report.view', 'billing.invoice.read'), async (req: AuthRequest, res: Response) => {
  const isCashierOnly = req.user!.roles.includes('CSH') && !req.user!.roles.includes('ACC') && !req.user!.roles.includes('MGR');
  let sql = `
    SELECT cs.*, u.full_name AS cashier_name
    FROM cashier_shifts cs
    INNER JOIN users u ON u.id = cs.cashier_id
  `;
  const params: unknown[] = [];
  if (isCashierOnly) {
    sql += ' WHERE cs.cashier_id = ?';
    params.push(req.user!.id);
  }
  sql += ' ORDER BY cs.id DESC LIMIT 20';
  const shifts = await query(sql, params);
  res.json({ shifts });
});

router.post('/billing/shifts/open', requireAuth, requirePermission('billing.shift.manage'), async (req: AuthRequest, res: Response) => {
  const existingOpen = await queryOne<{ id: number }>("SELECT id FROM cashier_shifts WHERE cashier_id = ? AND status = 'open'", [
    req.user!.id,
  ]);
  if (existingOpen) {
    return res.status(409).json({ error: 'You already have an open cashier shift.' });
  }
  const openingFloat = Number(req.body?.opening_float || 0);
  const inserted = await execute(
    "INSERT INTO cashier_shifts (cashier_id, opening_float, expected_cash, status) VALUES (?, ?, ?, 'open')",
    [req.user!.id, openingFloat, openingFloat]
  );
  await writeAuditLog({
    user: req.user,
    action: 'billing.shift.open',
    entityType: 'cashier_shift',
    entityId: inserted.insertId,
    after: { openingFloat },
    req,
  });
  res.status(201).json({ id: inserted.insertId });
});

router.post('/billing/shifts/close', requireAuth, requirePermission('billing.shift.manage'), async (req: AuthRequest, res: Response) => {
  const { shift_id, counted_cash, notes } = req.body || {};
  const shift = await queryOne<{ id: number; cashier_id: number; expected_cash: number; status: string }>(
    'SELECT * FROM cashier_shifts WHERE id = ?',
    [shift_id]
  );
  if (!shift || shift.status !== 'open') return res.status(404).json({ error: 'Open shift not found.' });
  if (shift.cashier_id !== req.user!.id && !hasPermission(req.user!, 'finance.report.view')) {
    return res.status(403).json({ error: 'Can only close your own cashier shift.' });
  }

  const counted = Number(counted_cash ?? 0);
  const variance = Number((counted - Number(shift.expected_cash)).toFixed(2));
  if (Math.abs(variance) > 0.01 && !notes?.trim()) {
    return res.status(400).json({
      error: `Cash variance of $${variance.toFixed(2)} detected. Enter a variance explanation note before closing shift.`,
    });
  }

  await execute(
    "UPDATE cashier_shifts SET counted_cash = ?, variance = ?, status = 'closed', closed_at = datetime('now'), notes = ? WHERE id = ?",
    [counted, variance, notes || null, shift.id]
  ).catch(async () => {
    await execute(
      "UPDATE cashier_shifts SET counted_cash = ?, variance = ?, status = 'closed', closed_at = NOW(), notes = ? WHERE id = ?",
      [counted, variance, notes || null, shift.id]
    );
  });

  if (Math.abs(variance) > 0.01) {
    await createNotification({
      targetRole: 'ACC',
      title: 'Cashier Shift Variance',
      message: `Shift #${shift.id} closed with variance $${variance.toFixed(2)}.`,
      severity: 'warning',
      entityType: 'cashier_shift',
      entityId: shift.id,
    });
  }

  await writeAuditLog({
    user: req.user,
    action: 'billing.shift.close',
    entityType: 'cashier_shift',
    entityId: shift.id,
    after: { expected_cash: shift.expected_cash, counted_cash: counted, variance },
    reason: notes || null,
    req,
  });

  res.json({ ok: true, variance });
});

router.post('/billing/shifts/:id/reconcile', requireAuth, requirePermission('billing.shift.reconcile'), async (req: AuthRequest, res: Response) => {
  const shiftId = Number(req.params.id);
  const shift = await queryOne<{ id: number; status: string }>('SELECT id, status FROM cashier_shifts WHERE id = ?', [shiftId]);
  if (!shift || shift.status !== 'closed') {
    return res.status(409).json({ error: 'Only closed shifts can be reconciled by Finance.' });
  }
  await execute("UPDATE cashier_shifts SET status = 'reconciled', reconciled_by = ? WHERE id = ?", [req.user!.id, shiftId]);
  await writeAuditLog({
    user: req.user,
    action: 'billing.shift.reconcile',
    entityType: 'cashier_shift',
    entityId: shiftId,
    req,
  });
  res.json({ ok: true });
});

router.get('/billing/invoices', requireAuth, requirePermission('billing.invoice.read'), async (_req, res) => {
  const invoices = await query(
    `SELECT i.*, p.mrn, p.first_name, p.last_name, p.phone
     FROM invoices i
     INNER JOIN patients p ON p.id = i.patient_id
     ORDER BY i.id DESC LIMIT 80`
  );
  for (const inv of invoices as Array<Record<string, unknown>>) {
    inv.items = await query('SELECT * FROM invoice_items WHERE invoice_id = ?', [inv.id]);
    inv.payments = await query(
      `SELECT pay.*, r.receipt_number, u.full_name AS cashier_name
       FROM payments pay
       LEFT JOIN receipts r ON r.payment_id = pay.id
       LEFT JOIN users u ON u.id = pay.created_by
       WHERE pay.invoice_id = ?
       ORDER BY pay.id DESC`,
      [inv.id]
    );
  }
  res.json({ invoices });
});

router.post('/billing/invoices', requireAuth, requirePermission('billing.invoice.create'), async (req: AuthRequest, res: Response) => {
  const { patient_id, items, notes } = req.body || {};
  if (!patient_id || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Patient and at least one billable item are required.' });
  }

  const patient = await queryOne<{ patient_type: string; payer_name: string | null }>(
    'SELECT patient_type, payer_name FROM patients WHERE id = ?',
    [patient_id]
  );
  if (!patient) return res.status(404).json({ error: 'Patient not found' });

  const subtotal = items.reduce((sum: number, item: { quantity?: number; unit_price: number }) => {
    return sum + Number(item.quantity || 1) * Number(item.unit_price || 0);
  }, 0);

  const invNum = await nextSequence('INV');
  const invStatus = patient.patient_type === 'insurance' || patient.patient_type === 'credit'
    ? 'credit_billed'
    : patient.patient_type === 'exempt'
      ? 'paid'
      : 'unpaid';
  const finalTotal = patient.patient_type === 'exempt' ? 0 : Number(subtotal.toFixed(2));

  const invRes = await execute(
    `INSERT INTO invoices (invoice_number, patient_id, payer_type, payer_name, subtotal, discount_amount, total_amount, paid_amount, status, notes, created_by)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
    [invNum, patient_id, patient.patient_type, patient.payer_name, finalTotal, finalTotal, invStatus === 'paid' ? finalTotal : 0, invStatus, notes || null, req.user!.id]
  );

  for (const item of items) {
    const qty = Number(item.quantity || 1);
    const price = patient.patient_type === 'exempt' ? 0 : Number(item.unit_price || 0);
    await execute(
      'INSERT INTO invoice_items (invoice_id, service_code, description, category, quantity, unit_price, line_total) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [invRes.insertId, item.service_code || null, item.description, item.category || 'consultation', qty, price, Number((qty * price).toFixed(2))]
    );
  }

  await writeAuditLog({
    user: req.user,
    action: 'billing.invoice.create',
    entityType: 'invoice',
    entityId: invRes.insertId,
    patientId: Number(patient_id),
    after: { invoiceNumber: invNum, totalAmount: finalTotal, status: invStatus },
    req,
  });

  res.status(201).json({ id: invRes.insertId, invoiceNumber: invNum });
});

router.post('/billing/payments', requireAuth, requirePermission('billing.payment.create'), async (req: AuthRequest, res: Response) => {
  const { invoice_id, amount, payment_method = 'cash', reference_number } = req.body || {};
  const payAmount = Number(amount || 0);
  if (!invoice_id || payAmount <= 0) {
    return res.status(400).json({ error: 'Valid invoice_id and positive payment amount are required.' });
  }

  const openShift = await queryOne<{ id: number }>("SELECT id FROM cashier_shifts WHERE cashier_id = ? AND status = 'open'", [
    req.user!.id,
  ]);
  if (!openShift) {
    return res.status(409).json({ error: 'You must open a Cashier Shift before collecting payments.' });
  }

  const inv = await queryOne<{ id: number; invoice_number: string; patient_id: number; total_amount: number; paid_amount: number; status: string }>(
    'SELECT * FROM invoices WHERE id = ?',
    [invoice_id]
  );
  if (!inv) return res.status(404).json({ error: 'Invoice not found' });
  if (inv.status === 'voided') return res.status(409).json({ error: 'Cannot pay a voided invoice.' });

  const remaining = Number((Number(inv.total_amount) - Number(inv.paid_amount)).toFixed(2));
  if (payAmount > remaining + 0.01) {
    return res.status(400).json({ error: `Payment (${payAmount}) exceeds remaining balance (${remaining}).` });
  }

  const payRes = await execute(
    `INSERT INTO payments (invoice_id, patient_id, shift_id, amount, payment_method, reference_number, status, created_by)
     VALUES (?, ?, ?, ?, ?, ?, 'completed', ?)`,
    [inv.id, inv.patient_id, openShift.id, payAmount, payment_method, reference_number || null, req.user!.id]
  );

  const receiptNumber = await nextSequence('RCP');
  const rcpRes = await execute(
    `INSERT INTO receipts (receipt_number, payment_id, invoice_id, patient_id, amount, payment_method, issued_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [receiptNumber, payRes.insertId, inv.id, inv.patient_id, payAmount, payment_method, req.user!.id]
  );

  const newPaid = Number((Number(inv.paid_amount) + payAmount).toFixed(2));
  const newStatus = newPaid >= Number(inv.total_amount) - 0.01 ? 'paid' : 'partial';
  await execute('UPDATE invoices SET paid_amount = ?, status = ? WHERE id = ?', [newPaid, newStatus, inv.id]);

  if (payment_method === 'cash') {
    await execute('UPDATE cashier_shifts SET expected_cash = expected_cash + ? WHERE id = ?', [payAmount, openShift.id]);
  }

  if (newStatus === 'paid') {
    await createNotification({
      targetRole: 'LAB',
      title: 'Payment Gate Opened',
      message: `Invoice ${inv.invoice_number} paid (${receiptNumber}). Orders released for processing.`,
      severity: 'info',
      entityType: 'invoice',
      entityId: inv.id,
    });
    await createNotification({
      targetRole: 'PHA',
      title: 'Payment Gate Opened',
      message: `Invoice ${inv.invoice_number} paid (${receiptNumber}). Prescription cleared for dispensing.`,
      severity: 'info',
      entityType: 'invoice',
      entityId: inv.id,
    });
  }

  await writeAuditLog({
    user: req.user,
    action: 'billing.payment.create',
    entityType: 'payment',
    entityId: payRes.insertId,
    patientId: inv.patient_id,
    after: { invoiceId: inv.id, amount: payAmount, method: payment_method, receiptNumber },
    req,
  });

  res.status(201).json({
    paymentId: payRes.insertId,
    receiptId: rcpRes.insertId,
    receiptNumber,
    invoiceStatus: newStatus,
  });
});

router.get('/billing/receipts/:receiptNumber', requireAuth, requirePermission('billing.invoice.read'), async (req, res) => {
  const receipt = await queryOne(
    `SELECT r.*, i.invoice_number, i.total_amount, i.paid_amount, i.discount_amount,
            p.mrn, p.first_name, p.last_name, p.phone, u.full_name AS cashier_name
     FROM receipts r
     INNER JOIN invoices i ON i.id = r.invoice_id
     INNER JOIN patients p ON p.id = r.patient_id
     INNER JOIN users u ON u.id = r.issued_by
     WHERE r.receipt_number = ?`,
    [req.params.receiptNumber]
  );
  if (!receipt) return res.status(404).json({ error: 'Receipt not found' });
  const items = await query('SELECT * FROM invoice_items WHERE invoice_id = ?', [(receipt as { invoice_id: number }).invoice_id]);
  res.json({ receipt, items });
});

router.post('/billing/receipts/:receiptNumber/reprint', requireAuth, requirePermission('billing.invoice.read'), async (req: AuthRequest, res: Response) => {
  const rcp = await queryOne<{ id: number; patient_id: number; reprint_count: number }>(
    'SELECT id, patient_id, reprint_count FROM receipts WHERE receipt_number = ?',
    [req.params.receiptNumber]
  );
  if (!rcp) return res.status(404).json({ error: 'Receipt not found' });
  const nextCount = Number(rcp.reprint_count || 0) + 1;
  await execute('UPDATE receipts SET reprint_count = ? WHERE id = ?', [nextCount, rcp.id]);
  await writeAuditLog({
    user: req.user,
    action: 'receipt.reprint',
    entityType: 'receipt',
    entityId: req.params.receiptNumber,
    patientId: rcp.patient_id,
    after: { copyNumber: nextCount },
    req,
  });
  res.json({ reprintCount: nextCount });
});

router.get('/billing/approvals', requireAuth, requirePermission('billing.approval.request', 'billing.approval.decide', 'billing.invoice.read'), async (_req, res) => {
  const approvals = await query(
    `SELECT ar.*, u1.full_name AS requested_by_name, u2.full_name AS decided_by_name,
            i.invoice_number, i.total_amount, p.first_name, p.last_name, p.mrn
     FROM approval_requests ar
     INNER JOIN users u1 ON u1.id = ar.requested_by
     LEFT JOIN users u2 ON u2.id = ar.decided_by
     LEFT JOIN invoices i ON ar.entity_type = 'invoice' AND i.id = ar.entity_id
     LEFT JOIN patients p ON p.id = i.patient_id
     ORDER BY ar.id DESC LIMIT 40`
  );
  res.json({ approvals });
});

router.post('/billing/approvals', requireAuth, requirePermission('billing.approval.request'), async (req: AuthRequest, res: Response) => {
  const { request_type, entity_id, requested_amount, reason } = req.body || {};
  if (!request_type || !entity_id || !reason?.trim()) {
    return res.status(400).json({ error: 'Request type, invoice ID, and formal reason are required.' });
  }
  const inserted = await execute(
    `INSERT INTO approval_requests (request_type, entity_type, entity_id, requested_amount, reason, status, requested_by)
     VALUES (?, 'invoice', ?, ?, ?, 'pending', ?)`,
    [request_type, entity_id, requested_amount ? Number(requested_amount) : null, reason.trim(), req.user!.id]
  );

  await createNotification({
    targetRole: 'ACC',
    title: `Approval Needed: ${request_type.replace('_', ' ')}`,
    message: `${req.user!.fullName} requested ${request_type.replace('_', ' ')} on invoice #${entity_id}.`,
    severity: 'warning',
    entityType: 'approval_request',
    entityId: inserted.insertId,
  });

  await writeAuditLog({
    user: req.user,
    action: 'billing.approval.request',
    entityType: 'approval_request',
    entityId: inserted.insertId,
    after: { request_type, invoice_id: entity_id, requested_amount },
    reason: reason.trim(),
    req,
  });
  res.status(201).json({ id: inserted.insertId });
});

router.post('/billing/approvals/:id/decide', requireAuth, requirePermission('billing.approval.decide'), async (req: AuthRequest, res: Response) => {
  const id = Number(req.params.id);
  const { decision, decision_note } = req.body || {};
  if (!['approved', 'rejected'].includes(decision)) {
    return res.status(400).json({ error: 'Decision must be approved or rejected.' });
  }

  const reqRow = await queryOne<{
    id: number;
    request_type: string;
    entity_id: number;
    requested_amount: number | null;
    requested_by: number;
    status: string;
  }>('SELECT * FROM approval_requests WHERE id = ?', [id]);

  if (!reqRow) return res.status(404).json({ error: 'Approval request not found' });
  if (reqRow.status !== 'pending') return res.status(409).json({ error: 'Request already decided.' });

  if (reqRow.requested_by === req.user!.id) {
    await writeAuditLog({
      user: req.user,
      action: 'security.segregation_violation_blocked',
      entityType: 'approval_request',
      entityId: id,
      reason: 'Attempted self-approval',
      req,
    });
    return res.status(403).json({
      error: 'Segregation of Duties Violation: You cannot approve your own discount, refund, or void request.',
    });
  }

  await execute(
    "UPDATE approval_requests SET status = ?, decided_by = ?, decision_note = ?, decided_at = datetime('now') WHERE id = ?",
    [decision, req.user!.id, decision_note || null, id]
  ).catch(async () => {
    await execute('UPDATE approval_requests SET status = ?, decided_by = ?, decision_note = ?, decided_at = NOW() WHERE id = ?', [
      decision,
      req.user!.id,
      decision_note || null,
      id,
    ]);
  });

  if (decision === 'approved') {
    const inv = await queryOne<{ id: number; patient_id: number; subtotal: number; paid_amount: number }>(
      'SELECT id, patient_id, subtotal, paid_amount FROM invoices WHERE id = ?',
      [reqRow.entity_id]
    );
    if (inv) {
      if (reqRow.request_type === 'discount' && reqRow.requested_amount) {
        const disc = Math.min(Number(reqRow.requested_amount), Number(inv.subtotal));
        const newTotal = Number((Number(inv.subtotal) - disc).toFixed(2));
        const newStatus = Number(inv.paid_amount) >= newTotal ? 'paid' : Number(inv.paid_amount) > 0 ? 'partial' : 'unpaid';
        await execute('UPDATE invoices SET discount_amount = ?, total_amount = ?, status = ? WHERE id = ?', [
          disc,
          newTotal,
          newStatus,
          inv.id,
        ]);
      } else if (reqRow.request_type === 'refund' && Number(inv.paid_amount) > 0) {
        const refundAmt = Math.min(Number(reqRow.requested_amount || inv.paid_amount), Number(inv.paid_amount));
        const openShift = await queryOne<{ id: number }>("SELECT id FROM cashier_shifts WHERE status = 'open' ORDER BY id DESC LIMIT 1");
        if (openShift) {
          await execute(
            "INSERT INTO payments (invoice_id, patient_id, shift_id, amount, payment_method, reference_number, status, created_by) VALUES (?, ?, ?, ?, 'cash', 'REFUND-REV', 'refunded', ?)",
            [inv.id, inv.patient_id, openShift.id, -refundAmt, req.user!.id]
          );
          await execute('UPDATE cashier_shifts SET expected_cash = expected_cash - ? WHERE id = ?', [refundAmt, openShift.id]);
        }
        const remPaid = Number((Number(inv.paid_amount) - refundAmt).toFixed(2));
        await execute("UPDATE invoices SET paid_amount = ?, status = CASE WHEN ? <= 0 THEN 'voided' ELSE 'partial' END WHERE id = ?", [
          remPaid,
          remPaid,
          inv.id,
        ]);
      } else if (reqRow.request_type === 'void_invoice') {
        await execute("UPDATE invoices SET status = 'voided' WHERE id = ?", [inv.id]);
      }
    }
  }

  await createNotification({
    targetRole: 'CSH',
    title: `Request ${decision}`,
    message: `${reqRow.request_type.replace('_', ' ')} request #${id} was ${decision}.`,
    severity: decision === 'approved' ? 'info' : 'warning',
    entityType: 'approval_request',
    entityId: id,
  });

  await writeAuditLog({
    user: req.user,
    action: `billing.approval.${decision}`,
    entityType: 'approval_request',
    entityId: id,
    reason: decision_note || null,
    req,
  });

  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// ADMINISTRATION, AUDIT LOG, EXCEPTIONS & TRACE
// ---------------------------------------------------------------------------
router.get('/admin/roles', requireAuth, requirePermission('admin.role.manage', 'admin.user.manage', 'audit.read'), async (_req, res) => {
  const roles = await query(
    `SELECT r.*, COUNT(rp.permission_id) AS permission_count
     FROM roles r
     LEFT JOIN role_permissions rp ON rp.role_id = r.id
     GROUP BY r.id
     ORDER BY r.id ASC`
  );
  const rolePerms = await query<{ role_id: number; code: string; module: string; scope: string }>(
    `SELECT rp.role_id, p.code, p.module, rp.scope
     FROM role_permissions rp
     INNER JOIN permissions p ON p.id = rp.permission_id`
  );
  res.json({ roles, rolePerms });
});

router.get('/admin/users', requireAuth, requirePermission('admin.user.manage', 'audit.read'), async (_req, res) => {
  const users = await query(
    `SELECT u.id, u.full_name, u.email, u.specialty, u.active, u.last_login_at, u.created_at,
            r.code AS role_code, r.name AS role_name
     FROM users u
     LEFT JOIN user_roles ur ON ur.user_id = u.id
     LEFT JOIN roles r ON r.id = ur.role_id
     ORDER BY u.id ASC`
  );
  res.json({ users });
});

router.post('/admin/users', requireAuth, requirePermission('admin.user.manage'), async (req: AuthRequest, res: Response) => {
  const { full_name, email, password, role_code, specialty } = req.body || {};
  if (!full_name || !email || !password || !role_code) {
    return res.status(400).json({ error: 'Full name, email, temporary password, and role are required.' });
  }
  const role = await queryOne<{ id: number }>('SELECT id FROM roles WHERE code = ?', [role_code]);
  if (!role) return res.status(400).json({ error: 'Invalid role code' });

  const normalizedEmail = String(email).trim().toLowerCase();
  const existing = await queryOne<{ id: number }>('SELECT id FROM users WHERE email = ?', [normalizedEmail]);
  if (existing) return res.status(409).json({ error: 'A user with this email already exists.' });

  const hash = await bcrypt.hash(String(password), 10);
  const inserted = await execute(
    'INSERT INTO users (branch_id, full_name, email, password_hash, specialty, must_change_password) VALUES (1, ?, ?, ?, ?, 1)',
    [full_name.trim(), normalizedEmail, hash, specialty || null]
  );
  await execute('INSERT INTO user_roles (user_id, role_id, branch_id) VALUES (?, ?, 1)', [inserted.insertId, role.id]);

  await writeAuditLog({
    user: req.user,
    action: 'admin.user.create',
    entityType: 'user',
    entityId: inserted.insertId,
    after: { email: normalizedEmail, role_code },
    req,
  });

  res.status(201).json({ id: inserted.insertId });
});

router.patch('/admin/users/:id/toggle', requireAuth, requirePermission('admin.user.manage'), async (req: AuthRequest, res: Response) => {
  const targetId = Number(req.params.id);
  if (targetId === req.user!.id) {
    return res.status(409).json({ error: 'Administrators cannot deactivate their own account.' });
  }
  const target = await queryOne<{ id: number; active: number; email: string }>('SELECT id, active, email FROM users WHERE id = ?', [
    targetId,
  ]);
  if (!target) return res.status(404).json({ error: 'User not found' });

  const nextActive = target.active ? 0 : 1;
  await execute('UPDATE users SET active = ? WHERE id = ?', [nextActive, targetId]);

  await writeAuditLog({
    user: req.user,
    action: nextActive ? 'admin.user.activate' : 'admin.user.deactivate',
    entityType: 'user',
    entityId: targetId,
    before: { active: Boolean(target.active) },
    after: { active: Boolean(nextActive) },
    req,
  });

  res.json({ ok: true, active: Boolean(nextActive) });
});

router.get('/audit-logs', requireAuth, requirePermission('audit.read'), async (req: AuthRequest, res: Response) => {
  const actionFilter = req.query.action ? String(req.query.action).trim() : '';
  let sql = 'SELECT * FROM audit_logs WHERE 1=1';
  const params: unknown[] = [];
  if (actionFilter) {
    sql += ' AND (action LIKE ? OR user_name LIKE ? OR entity_type LIKE ?)';
    const like = `%${actionFilter}%`;
    params.push(like, like, like);
  }
  sql += ' ORDER BY id DESC LIMIT 120';
  const logs = await query(sql, params);
  res.json({ logs });
});

router.get('/audit-logs/exceptions', requireAuth, requirePermission('audit.read'), async (_req, res) => {
  const exceptions = await query(
    `SELECT * FROM audit_logs
     WHERE action IN (
       'auth.login.failed', 'security.access_denied', 'security.segregation_violation_blocked',
       'payment.gate.bypass', 'lab.result.amend', 'visit.reopen', 'patient.merge',
       'receipt.reprint', 'billing.approval.approved', 'billing.shift.close'
     )
     ORDER BY id DESC LIMIT 60`
  );
  res.json({ exceptions });
});

router.get('/audit-logs/trace', requireAuth, requirePermission('audit.read'), async (req, res) => {
  const patientId = req.query.patientId ? Number(req.query.patientId) : null;
  const userId = req.query.userId ? Number(req.query.userId) : null;
  if (!patientId && !userId) return res.json({ trace: [] });

  let sql = 'SELECT * FROM audit_logs WHERE 1=1';
  const params: unknown[] = [];
  if (patientId) {
    sql += ' AND patient_id = ?';
    params.push(patientId);
  }
  if (userId) {
    sql += ' AND user_id = ?';
    params.push(userId);
  }
  sql += ' ORDER BY id ASC LIMIT 150';
  const trace = await query(sql, params);
  res.json({ trace });
});

router.get('/audit-logs/verify', requireAuth, requirePermission('audit.read'), async (_req, res) => {
  const verification = await verifyAuditChain();
  res.json(verification);
});

export default router;
