import { Router, type Response } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { execute, getDbConfigSummary, getDialect, nextSequence, query, queryOne, withTransaction } from './db.ts';
import {
  type AuthRequest,
  type AuthUser,
  hasPermission,
  loadUserContext,
  requireAuth,
  requirePermission,
  revokeToken,
  signAccessToken,
  verifyAuditChain,
  writeAuditLog,
} from './auth.ts';
import { broadcastClinicEvent, registerRealtimeClient } from './realtime.ts';

function maskPatientRecord(p: Record<string, unknown>, user: AuthUser): Record<string, unknown> {
  const canSeeClinical = hasPermission(user, 'patient.clinical.read');
  const canSeeGovId =
    hasPermission(user, 'admin.user.manage') ||
    hasPermission(user, 'patient.update') ||
    hasPermission(user, 'audit.read');
  const canSeeInsurance =
    canSeeClinical || hasPermission(user, 'billing.invoice.read') || hasPermission(user, 'patient.update');
  return {
    ...p,
    blood_group: canSeeClinical ? p.blood_group : 'Restricted',
    allergies: canSeeClinical ? p.allergies : 'Restricted (Clinical Role Required)',
    national_id: canSeeGovId ? p.national_id : p.national_id ? '****' : null,
    insurance_number: canSeeInsurance ? p.insurance_number : p.insurance_number ? '****' : null,
  };
}

function canBypassPaymentGate(
  user: AuthUser,
  isEmergencyVisit: boolean,
  bypassFlag: unknown,
  bypassReason: unknown
): { allowed: boolean; reasonText: string } {
  if (isEmergencyVisit) {
    return { allowed: true, reasonText: 'Emergency triage visit automatic payment-gate override' };
  }
  if (Boolean(bypassFlag) && hasPermission(user, 'payment.gate.bypass')) {
    const cleaned = String(bypassReason || '').trim();
    if (cleaned.length >= 5) {
      return { allowed: true, reasonText: cleaned };
    }
  }
  return { allowed: false, reasonText: '' };
}

const ALLERGY_CLASS_MAP: Array<{ triggers: string[]; meds: string[] }> = [
  {
    triggers: ['penicillin', 'beta-lactam', 'amoxicillin', 'ampicillin', 'pcn'],
    meds: ['amoxicillin', 'ampicillin', 'penicillin', 'piperacillin', 'cloxacillin', 'augmentin'],
  },
  {
    triggers: ['sulfa', 'sulfonamide', 'cotrimoxazole', 'bactrim'],
    meds: ['sulfamethoxazole', 'trimethoprim', 'cotrimoxazole', 'sulfasalazine', 'sulfa'],
  },
  {
    triggers: ['aspirin', 'nsaid', 'ibuprofen', 'salicylate'],
    meds: ['aspirin', 'ibuprofen', 'diclofenac', 'naproxen', 'ketorolac', 'indomethacin'],
  },
  {
    triggers: ['macrolide', 'azithromycin', 'erythromycin'],
    meds: ['azithromycin', 'erythromycin', 'clarithromycin'],
  },
  {
    triggers: ['fluoroquinolone', 'ciprofloxacin', 'levofloxacin'],
    meds: ['ciprofloxacin', 'levofloxacin', 'ofloxacin', 'moxifloxacin'],
  },
];

function findAllergyConflicts(allergiesRaw: string | null | undefined, genericName: string): boolean {
  const allergyText = (allergiesRaw || '').toLowerCase().trim();
  if (!allergyText || allergyText === 'none' || allergyText === 'none known' || allergyText === 'nkda') {
    return false;
  }
  const medLower = genericName.toLowerCase();
  for (const group of ALLERGY_CLASS_MAP) {
    const patientHasTrigger = group.triggers.some((t) => allergyText.includes(t));
    const medInClass = group.meds.some((m) => medLower.includes(m));
    if (patientHasTrigger && medInClass) return true;
  }
  const stopWords = new Set(['none', 'known', 'rash', 'hives', 'anaphylaxis', 'bronchospasm', 'allergy', 'drugs', 'mild', 'severe']);
  const tokens = allergyText.split(/[^a-z0-9]+/).filter((t) => t.length >= 4 && !stopWords.has(t));
  return tokens.some((tok) => medLower.includes(tok));
}

const router = Router();
const loginAttemptsByIp = new Map<string, { count: number; resetAt: number }>();
const pending2faChallenges = new Map<string, { userId: number; code: string; email: string; expiresAt: number }>();
const lastAuditViewByUser = new Map<number, number>();

async function postJournalEntry(opts: {
  entryDate?: string;
  sourceType: string;
  sourceId?: number | null;
  description: string;
  postedBy: number;
  lines: Array<{ accountCode: string; debit?: number; credit?: number; memo?: string }>;
}) {
  const normalizedLines = opts.lines
    .map((l) => ({
      accountCode: l.accountCode,
      debit: Number((l.debit || 0).toFixed(2)),
      credit: Number((l.credit || 0).toFixed(2)),
      memo: l.memo || null,
    }))
    .filter((l) => l.debit > 0 || l.credit > 0);

  if (normalizedLines.length < 2) {
    throw new Error('Journal entry requires at least two non-zero lines.');
  }

  const totalDebit = Number(normalizedLines.reduce((s, l) => s + l.debit, 0).toFixed(2));
  const totalCredit = Number(normalizedLines.reduce((s, l) => s + l.credit, 0).toFixed(2));
  if (Math.abs(totalDebit - totalCredit) > 0.01 || totalDebit <= 0) {
    throw new Error(`Unbalanced journal entry (Dr ${totalDebit} != Cr ${totalCredit}).`);
  }

  const codes = [...new Set(normalizedLines.map((l) => l.accountCode))];
  const ph = codes.map(() => '?').join(',');
  const acctRows = await query<{ id: number; code: string }>(`SELECT id, code FROM chart_of_accounts WHERE code IN (${ph})`, codes);
  const acctMap = new Map(acctRows.map((a) => [a.code, a.id]));
  for (const c of codes) {
    if (!acctMap.has(c)) {
      throw new Error(`Chart of Accounts missing code ${c}.`);
    }
  }

  const entryNumber = await nextSequence('JE');
  const entryDate = opts.entryDate || new Date().toISOString().slice(0, 10);
  const jeRes = await execute(
    `INSERT INTO journal_entries (entry_number, entry_date, source_type, source_id, description, total_debit, total_credit, posted_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [entryNumber, entryDate, opts.sourceType, opts.sourceId ?? null, opts.description, totalDebit, totalCredit, opts.postedBy]
  );

  for (const line of normalizedLines) {
    await execute(
      'INSERT INTO journal_lines (entry_id, account_id, debit, credit, memo) VALUES (?, ?, ?, ?, ?)',
      [jeRes.insertId, acctMap.get(line.accountCode)!, line.debit, line.credit, line.memo]
    );
  }

  return { entryId: jeRes.insertId, entryNumber, totalDebit, totalCredit };
}

function revenueAccountForCategory(category: string): string {
  const c = (category || '').toLowerCase();
  if (c === 'lab' || c === 'imaging') return '4020';
  if (c === 'pharmacy') return '4030';
  if (c === 'bed' || c === 'nursing' || c === 'procedure') return '4040';
  return '4010';
}

async function syncMedicineFromBatches(medicineId: number) {
  const today = new Date().toISOString().slice(0, 10);
  const batches = await query<{ qty_on_hand: number; batch_number: string; expiry_date: string }>(
    `SELECT sb.qty_on_hand, sb.batch_number, sb.expiry_date
     FROM stock_batches sb
     INNER JOIN store_items si ON si.id = sb.item_id
     WHERE si.medicine_id = ? AND sb.location = 'dispensary' AND sb.status = 'active' AND sb.qty_on_hand > 0 AND sb.expiry_date >= ?
     ORDER BY sb.expiry_date ASC, sb.id ASC`,
    [medicineId, today]
  );
  const totalQty = batches.reduce((s, b) => s + Number(b.qty_on_hand || 0), 0);
  const earliest = batches[0];
  if (earliest) {
    await execute('UPDATE medicines SET stock_qty = ?, batch_number = ?, expiry_date = ? WHERE id = ?', [
      totalQty,
      earliest.batch_number,
      earliest.expiry_date,
      medicineId,
    ]);
  } else {
    await execute('UPDATE medicines SET stock_qty = ? WHERE id = ?', [totalQty, medicineId]);
  }
}

function specialtyToServiceCode(specialty?: string | null): string {
  const s = (specialty || '').toLowerCase();
  if (s.includes('pediat')) return 'CON-PED';
  if (s.includes('gyn')) return 'CON-GYN';
  if (s.includes('derm')) return 'CON-DERM';
  return 'CON-GEN';
}

async function unlockPaidInvoiceGates(opts: {
  invoiceId: number;
  invoiceNumber: string;
  receiptNumber?: string;
  userId: number;
}) {
  const refLabel = opts.receiptNumber ? ` (${opts.receiptNumber})` : '';

  const consultVisits = await query<{ id: number; visit_number: string; patient_id: number }>(
    "SELECT id, visit_number, patient_id FROM visits WHERE consultation_invoice_id = ? AND workflow_stage = 'awaiting_payment'",
    [opts.invoiceId]
  );
  for (const cv of consultVisits) {
    await execute("UPDATE visits SET workflow_stage = 'paid_awaiting_vitals' WHERE id = ?", [cv.id]);
    const existingTicket = await queryOne<{ id: number }>(
      "SELECT id FROM queue_tickets WHERE visit_id = ? AND status IN ('waiting','called','in_service') ORDER BY id DESC LIMIT 1",
      [cv.id]
    );
    if (existingTicket) {
      await execute(
        "UPDATE queue_tickets SET department = 'TRIAGE', status = 'waiting', notes = 'Paid - Awaiting Vitals' WHERE id = ?",
        [existingTicket.id]
      );
    } else {
      const tNum = await nextSequence('TICKET');
      await execute(
        "INSERT INTO queue_tickets (ticket_number, department, patient_id, visit_id, priority, status, notes, created_by) VALUES (?, 'TRIAGE', ?, ?, 'routine', 'waiting', 'Paid - Awaiting Vitals', ?)",
        [tNum, cv.patient_id, cv.id, opts.userId]
      );
    }
    await createNotification({
      targetRole: 'NUR',
      title: 'Paid - Awaiting Vitals',
      message: `Consultation paid for ${cv.visit_number}${refLabel}. Patient added to Vital Room queue.`,
      severity: 'info',
      entityType: 'visit',
      entityId: cv.id,
    });
  }

  const rxRows = await query<{ id: number; visit_id: number }>(
    "SELECT id, visit_id FROM prescriptions WHERE invoice_id = ? AND status IN ('pending_payment','pending')",
    [opts.invoiceId]
  );
  if (rxRows.length > 0) {
    await execute(
      "UPDATE prescriptions SET status = 'paid_ready_to_dispense' WHERE invoice_id = ? AND status IN ('pending_payment','pending')",
      [opts.invoiceId]
    );
    await createNotification({
      targetRole: 'PHA',
      title: 'Paid - Ready to Dispense',
      message: `Pharmacy invoice ${opts.invoiceNumber} paid${refLabel}. Prescription ready for dispensing.`,
      severity: 'info',
      entityType: 'invoice',
      entityId: opts.invoiceId,
    });
  }

  const labRows = await query<{ id: number }>('SELECT id FROM lab_orders WHERE invoice_id = ?', [opts.invoiceId]);
  if (labRows.length > 0) {
    await createNotification({
      targetRole: 'LAB',
      title: 'Paid - Pending Sample',
      message: `Lab invoice ${opts.invoiceNumber} paid${refLabel}. Orders unlocked for sample collection.`,
      severity: 'info',
      entityType: 'invoice',
      entityId: opts.invoiceId,
    });
  }

  const imgRows = await query<{ id: number }>('SELECT id FROM imaging_orders WHERE invoice_id = ?', [opts.invoiceId]);
  if (imgRows.length > 0) {
    await createNotification({
      targetRole: 'IMG',
      title: 'Paid - Pending Scan',
      message: `Imaging invoice ${opts.invoiceNumber} paid${refLabel}. Orders unlocked for scanning.`,
      severity: 'info',
      entityType: 'invoice',
      entityId: opts.invoiceId,
    });
  }

  return {
    unlockedConsultVisits: consultVisits.length,
    unlockedRx: rxRows.length,
    unlockedLab: labRows.length,
    unlockedImaging: imgRows.length,
  };
}

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
  broadcastClinicEvent('notification:created', {
    targetRole: opts.targetRole,
    title: opts.title,
    severity: opts.severity || 'info',
  });
}

router.get('/health', (_req, res) => {
  res.json({ ok: true, dialect: getDialect(), service: 'Clinic360 API' });
});

router.get('/events/stream', requireAuth, (req: AuthRequest, res: Response) => {
  registerRealtimeClient(req, res, { id: req.user!.id, roles: req.user!.roles });
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

  if (ctx.twoFaEnabled) {
    const challengeId = crypto.randomBytes(12).toString('hex');
    const code = String(crypto.randomInt(100000, 999999));
    pending2faChallenges.set(challengeId, {
      userId: ctx.id,
      code,
      email: ctx.email,
      expiresAt: Date.now() + 10 * 60_000,
    });
    const [localPart, domain] = ctx.email.split('@');
    const maskedEmail = `${localPart.slice(0, 2)}***@${domain || 'clinic360.local'}`;
    await writeAuditLog({
      user: ctx,
      action: 'auth.2fa.challenged',
      entityType: 'user',
      entityId: ctx.id,
      after: { roles: ctx.roles },
      req,
    });
    return res.json({
      requires2fa: true,
      challengeId,
      maskedEmail,
      devVerificationCode: process.env.NODE_ENV === 'production' ? undefined : code,
    });
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

router.post('/auth/verify-2fa', async (req, res) => {
  const { challengeId, code } = req.body || {};
  if (!challengeId || !code) {
    return res.status(400).json({ error: 'Verification challenge and 6-digit code are required.' });
  }
  const challenge = pending2faChallenges.get(String(challengeId));
  if (!challenge || challenge.expiresAt < Date.now()) {
    pending2faChallenges.delete(String(challengeId));
    return res.status(401).json({ error: '2FA challenge expired or invalid. Please sign in again.' });
  }

  const ctx = await loadUserContext(challenge.userId);
  if (!ctx) {
    return res.status(403).json({ error: 'Unable to load user permissions.' });
  }

  if (String(code).trim() !== challenge.code) {
    await writeAuditLog({
      user: ctx,
      action: 'auth.2fa.failed',
      entityType: 'user',
      entityId: ctx.id,
      reason: 'Invalid 6-digit verification code',
      req,
    });
    return res.status(401).json({ error: 'Invalid 6-digit authenticator code.' });
  }

  pending2faChallenges.delete(String(challengeId));
  const token = signAccessToken(ctx);
  await writeAuditLog({
    user: ctx,
    action: 'auth.2fa.verified',
    entityType: 'user',
    entityId: ctx.id,
    req,
  });
  res.json({ token, user: ctx, dialect: getDialect() });
});

router.post('/auth/change-password', requireAuth, async (req: AuthRequest, res: Response) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword || String(newPassword).length < 8) {
    return res.status(400).json({ error: 'Current password and a new password of at least 8 characters are required.' });
  }
  const userRow = await queryOne<{ id: number; password_hash: string }>('SELECT id, password_hash FROM users WHERE id = ?', [
    req.user!.id,
  ]);
  if (!userRow) return res.status(404).json({ error: 'User not found' });

  const match = await bcrypt.compare(String(currentPassword), userRow.password_hash);
  if (!match) {
    return res.status(401).json({ error: 'Current password is incorrect.' });
  }
  if (String(currentPassword) === String(newPassword)) {
    return res.status(400).json({ error: 'New password must be different from your temporary password.' });
  }

  const nextHash = await bcrypt.hash(String(newPassword), 10);
  await execute('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?', [nextHash, req.user!.id]);

  await writeAuditLog({
    user: req.user,
    action: 'auth.password.changed',
    entityType: 'user',
    entityId: req.user!.id,
    req,
  });

  const updatedCtx = await loadUserContext(req.user!.id);
  res.json({ ok: true, user: updatedCtx });
});

router.get('/auth/me', requireAuth, async (req: AuthRequest, res: Response) => {
  res.json({ user: req.user, dialect: getDialect() });
});

router.post('/auth/logout', requireAuth, async (req: AuthRequest, res: Response) => {
  revokeToken(req.authJti, req.authExp);
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
  const pendingRx = await queryOne<{ cnt: number }>(
    "SELECT COUNT(*) AS cnt FROM prescriptions WHERE status IN ('awaiting_stock_check','pending_payment','pending','paid_ready_to_dispense')"
  );
  const pendingApprovals = await queryOne<{ cnt: number }>(
    "SELECT COUNT(*) AS cnt FROM approval_requests WHERE status = 'pending'"
  );
  const occupiedBeds = await queryOne<{ cnt: number }>("SELECT COUNT(*) AS cnt FROM beds WHERE status = 'occupied'");
  const totalBeds = await queryOne<{ cnt: number }>("SELECT COUNT(*) AS cnt FROM beds WHERE status != 'out_of_service'");

  const canSeeFinance =
    hasPermission(user, 'finance.report.view') ||
    hasPermission(user, 'billing.payment.create') ||
    hasPermission(user, 'accounting.ledger.manage');
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
  const search = String(req.query.search ?? req.query.q ?? '').trim();
  const field = String(req.query.field || 'all').toLowerCase();
  const limit = Math.min(200, Math.max(10, Number(req.query.limit || 100)));
  const page = Math.max(1, Number(req.query.page || 1));
  const offset = (page - 1) * limit;
  const canSeeClinical = hasPermission(req.user!, 'patient.clinical.read');

  let whereSql = " WHERE status = 'active'";
  const params: unknown[] = [];

  if (search) {
    const tokens = search.split(/\s+/).filter(Boolean).slice(0, 5);
    for (const tok of tokens) {
      const like = `%${tok}%`;
      const cleanPhone = tok.replace(/[\s\-+()]/g, '');
      const likePhone = cleanPhone ? `%${cleanPhone}%` : like;
      if (field === 'mrn') {
        whereSql += ' AND LOWER(mrn) LIKE LOWER(?)';
        params.push(like);
      } else if (field === 'name') {
        whereSql += ' AND (LOWER(first_name) LIKE LOWER(?) OR LOWER(last_name) LIKE LOWER(?))';
        params.push(like, like);
      } else if (field === 'phone') {
        whereSql +=
          " AND (phone LIKE ? OR REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone, '-', ''), ' ', ''), '+', ''), '(', ''), ')', '') LIKE ?)";
        params.push(like, likePhone);
      } else {
        whereSql +=
          " AND (LOWER(mrn) LIKE LOWER(?) OR LOWER(first_name) LIKE LOWER(?) OR LOWER(last_name) LIKE LOWER(?) OR phone LIKE ? OR REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone, '-', ''), ' ', ''), '+', ''), '(', ''), ')', '') LIKE ?)";
        params.push(like, like, like, like, likePhone);
      }
    }
  }

  const countRow = await queryOne<{ cnt: number }>(`SELECT COUNT(*) AS cnt FROM patients${whereSql}`, params);

  let sql = `SELECT id, mrn, first_name, last_name, sex, date_of_birth, phone, email, address,
                    patient_type, payer_name, insurance_number, status, created_at`;
  if (canSeeClinical) {
    sql += ', blood_group, allergies';
  }
  sql += ` FROM patients${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`;

  const patients = await query(sql, [...params, limit, offset]);
  res.json({ patients, clinicalMasked: !canSeeClinical, total: Number(countRow?.cnt || 0), page, limit });
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

  const result = await withTransaction(async () => {
    const src = await queryOne<{ id: number; mrn: string; status: string }>('SELECT id, mrn, status FROM patients WHERE id = ?', [srcId]);
    const tgt = await queryOne<{ id: number; mrn: string; status: string }>('SELECT id, mrn, status FROM patients WHERE id = ?', [tgtId]);
    if (!src || !tgt || src.status !== 'active' || tgt.status !== 'active') {
      return { ok: false as const, error: 'Both source and target must be active patient records.', httpStatus: 404 };
    }

    const tables = ['appointments', 'visits', 'vitals', 'invoices', 'payments', 'receipts', 'lab_orders', 'imaging_orders', 'prescriptions', 'queue_tickets', 'admissions', 'patient_deposits'];
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

    return { ok: true as const, mergedMrn: src.mrn, intoMrn: tgt.mrn };
  });

  if (!result.ok) {
    return res.status(result.httpStatus).json({ error: result.error });
  }
  res.json(result);
});

router.get('/patients/:id', requireAuth, requirePermission('patient.read'), async (req: AuthRequest, res: Response) => {
  const id = Number(req.params.id);
  const canSeeClinical = hasPermission(req.user!, 'patient.clinical.read');
  const canSeeBilling = hasPermission(req.user!, 'billing.invoice.read');

  const patient = await queryOne<Record<string, unknown>>('SELECT * FROM patients WHERE id = ?', [id]);
  if (!patient) {
    return res.status(404).json({ error: 'Patient not found' });
  }

  const safePatient = maskPatientRecord(patient, req.user!);

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

  const openVisitDocRows = await query<{ doctor_id: number }>(
    "SELECT DISTINCT doctor_id FROM visits WHERE patient_id = ? AND status != 'closed' AND doctor_id IS NOT NULL",
    [id]
  );
  const assignedDoctorIds = openVisitDocRows.map((r) => Number(r.doctor_id));

  res.json({
    patient: safePatient,
    clinicalMasked: !canSeeClinical,
    assignedDoctorIds,
    appointments,
    visits,
    vitals,
    invoices,
    accessHistory,
  });
});

router.post('/patients/:id/break-glass', requireAuth, requirePermission('patient.read'), async (req: AuthRequest, res: Response) => {
  const id = Number(req.params.id);
  const { reason } = req.body || {};
  if (!reason || String(reason).trim().length < 8) {
    return res.status(400).json({ error: 'Emergency break-glass access requires a clinical justification (min 8 characters).' });
  }
  const patient = await queryOne<{ id: number; mrn: string; first_name: string; last_name: string }>(
    'SELECT id, mrn, first_name, last_name FROM patients WHERE id = ?',
    [id]
  );
  if (!patient) return res.status(404).json({ error: 'Patient not found' });

  await createNotification({
    targetRole: 'AUD',
    title: 'Break-Glass Chart Access Logged',
    message: `${req.user!.fullName} invoked Break-Glass access for ${patient.first_name} ${patient.last_name} (${patient.mrn}): ${String(reason).trim()}`,
    severity: 'critical',
    entityType: 'patient',
    entityId: id,
  });
  await createNotification({
    targetRole: 'MGR',
    title: 'Break-Glass Chart Access Alert',
    message: `${req.user!.fullName} opened ${patient.mrn} via Break-Glass override.`,
    severity: 'warning',
    entityType: 'patient',
    entityId: id,
  });

  await writeAuditLog({
    user: req.user,
    action: 'security.break_glass.access',
    entityType: 'patient',
    entityId: id,
    patientId: id,
    reason: String(reason).trim(),
    after: { mrn: patient.mrn },
    req,
  });

  res.json({ ok: true, grantedAt: new Date().toISOString() });
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

  const { patient, ticketNumber } = await withTransaction(async () => {
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

    let tNum: string | null = null;
    if (issue_queue_ticket) {
      tNum = await nextSequence('TICKET');
      await execute(
        "INSERT INTO queue_tickets (ticket_number, department, patient_id, priority, status, created_by) VALUES (?, 'OPD', ?, 'routine', 'waiting', ?)",
        [tNum, patientId, req.user!.id]
      );
    }

    if (charge_registration_card && patient_type !== 'exempt') {
      const invNum = await nextSequence('INV');
      const regSvc = await queryOne<{ unit_price: number }>("SELECT unit_price FROM services WHERE code = 'REG-CARD'");
      const cardFee = Number(regSvc?.unit_price || 15.0);
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

    const createdPatient = await queryOne<Record<string, unknown>>('SELECT * FROM patients WHERE id = ?', [patientId]);
    return { patient: createdPatient ? maskPatientRecord(createdPatient, req.user!) : null, ticketNumber: tNum };
  });

  if (ticketNumber) {
    broadcastClinicEvent('queue:updated', { patientId: (patient as { id?: number })?.id });
  }
  res.status(201).json({ patient, ticketNumber });
});

router.patch('/patients/:id', requireAuth, requirePermission('patient.update'), async (req: AuthRequest, res: Response) => {
  const id = Number(req.params.id);
  const existing = await queryOne<Record<string, unknown>>('SELECT * FROM patients WHERE id = ?', [id]);
  if (!existing) return res.status(404).json({ error: 'Patient not found' });

  const canEditClinical = hasPermission(req.user!, 'patient.clinical.read');
  const fields = canEditClinical
    ? ['phone', 'email', 'address', 'next_of_kin_name', 'next_of_kin_phone', 'blood_group', 'allergies', 'patient_type', 'payer_name', 'insurance_number']
    : ['phone', 'email', 'address', 'next_of_kin_name', 'next_of_kin_phone', 'patient_type', 'payer_name', 'insurance_number'];
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

  const updated = await queryOne<Record<string, unknown>>('SELECT * FROM patients WHERE id = ?', [id]);
  res.json({ patient: updated ? maskPatientRecord(updated, req.user!) : null });
});

// Queue Management
router.get('/queue', requireAuth, requirePermission('queue.manage', 'visit.read', 'patient.read'), async (req, res) => {
  const dept = req.query.department ? String(req.query.department) : null;
  let sql = `
    SELECT q.*, p.mrn, p.first_name, p.last_name, p.sex, p.date_of_birth, p.patient_type,
           v.visit_number, v.specialty, v.workflow_stage,
           d.full_name AS doctor_name,
           ci.id AS consultation_invoice_id,
           ci.invoice_number AS consultation_invoice_number,
           ci.status AS consultation_invoice_status,
           ci.total_amount AS consultation_total_amount,
           ci.paid_amount AS consultation_paid_amount
    FROM queue_tickets q
    INNER JOIN patients p ON p.id = q.patient_id
    LEFT JOIN visits v ON v.id = q.visit_id
    LEFT JOIN users d ON d.id = v.doctor_id
    LEFT JOIN invoices ci ON ci.id = v.consultation_invoice_id
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
  broadcastClinicEvent('queue:updated', { department, patientId: Number(patient_id) });
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
  broadcastClinicEvent('queue:updated', { ticketId: id, status });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// APPOINTMENTS & DOCTOR AVAILABILITY BLOCKS
// ---------------------------------------------------------------------------
router.get('/appointments/blocks', requireAuth, requirePermission('appointment.read'), async (req, res) => {
  const date = req.query.date ? String(req.query.date) : null;
  const doctorId = req.query.doctorId ? Number(req.query.doctorId) : null;
  let sql = `
    SELECT db.*, u.full_name AS doctor_name, u.specialty
    FROM doctor_blocks db
    INNER JOIN users u ON u.id = db.doctor_id
    WHERE 1=1
  `;
  const params: unknown[] = [];
  if (date) {
    sql += ' AND db.block_date = ?';
    params.push(date);
  }
  if (doctorId) {
    sql += ' AND db.doctor_id = ?';
    params.push(doctorId);
  }
  sql += ' ORDER BY db.block_date ASC, db.start_time ASC';
  const blocks = await query(sql, params);
  res.json({ blocks });
});

router.post('/appointments/blocks', requireAuth, requirePermission('appointment.block.manage'), async (req: AuthRequest, res: Response) => {
  const { doctor_id, block_date, start_time = '08:00', end_time = '17:00', block_type = 'unavailable', reason, notes } = req.body || {};
  if (!doctor_id || !block_date || !start_time || !end_time || start_time >= end_time) {
    return res.status(400).json({ error: 'Doctor, date, and valid start/end times are required.' });
  }
  const blockReason = (reason || notes || '').trim() || null;
  const inserted = await execute(
    'INSERT INTO doctor_blocks (doctor_id, block_date, start_time, end_time, block_type, reason, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [Number(doctor_id), block_date, start_time, end_time, block_type, blockReason, req.user!.id]
  );
  await writeAuditLog({
    user: req.user,
    action: 'appointment.block.create',
    entityType: 'doctor_block',
    entityId: inserted.insertId,
    after: { doctor_id, block_date, start_time, end_time, block_type },
    req,
  });
  res.status(201).json({ id: inserted.insertId });
});

router.delete('/appointments/blocks/:id', requireAuth, requirePermission('appointment.block.manage'), async (req: AuthRequest, res: Response) => {
  const id = Number(req.params.id);
  const existing = await queryOne('SELECT id FROM doctor_blocks WHERE id = ?', [id]);
  if (!existing) return res.status(404).json({ error: 'Schedule block not found' });
  await execute('DELETE FROM doctor_blocks WHERE id = ?', [id]);
  await writeAuditLog({
    user: req.user,
    action: 'appointment.block.delete',
    entityType: 'doctor_block',
    entityId: id,
    req,
  });
  res.json({ ok: true });
});

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

  const blockConflict = await queryOne<{ start_time: string; end_time: string; block_type: string; reason: string | null }>(
    `SELECT start_time, end_time, block_type, reason FROM doctor_blocks
     WHERE doctor_id = ? AND block_date = ? AND start_time < ? AND end_time > ?
     LIMIT 1`,
    [doctor_id, appointment_date, end_time, start_time]
  );
  if (blockConflict) {
    return res.status(409).json({
      error: `Clinician unavailable (${blockConflict.block_type.replace('_', ' ')}: ${blockConflict.start_time}–${blockConflict.end_time}${blockConflict.reason ? ` — ${blockConflict.reason}` : ''}).`,
    });
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
  if (existing.status === 'cancelled' || existing.status === 'completed') {
    return res.status(409).json({ error: `Appointment is already ${existing.status} and cannot be modified.` });
  }

  const { status, appointment_date, start_time, end_time, reason } = req.body || {};

  if (appointment_date && start_time && end_time) {
    const blockConflict = await queryOne<{ start_time: string; end_time: string; block_type: string }>(
      `SELECT start_time, end_time, block_type FROM doctor_blocks
       WHERE doctor_id = ? AND block_date = ? AND start_time < ? AND end_time > ?
       LIMIT 1`,
      [existing.doctor_id, appointment_date, end_time, start_time]
    );
    if (blockConflict) {
      return res.status(409).json({
        error: `Selected slot falls inside clinician ${blockConflict.block_type.replace('_', ' ')} block (${blockConflict.start_time}–${blockConflict.end_time}).`,
      });
    }
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

  const { createdVisitId, ticketNumber } = await withTransaction(async () => {
    let visitIdOut: number | null = null;
    let ticketOut: string | null = null;

    if (status) {
      await execute('UPDATE appointments SET status = ? WHERE id = ?', [status, id]);
      if (status === 'checked_in' && existing.status !== 'checked_in') {
        const patient = await queryOne<{ patient_type: string; payer_name: string | null }>(
          'SELECT patient_type, payer_name FROM patients WHERE id = ?',
          [existing.patient_id]
        );
        const doctor = await queryOne<{ full_name: string; specialty: string | null }>(
          'SELECT full_name, specialty FROM users WHERE id = ?',
          [existing.doctor_id]
        );
        const specialty = doctor?.specialty || 'General Medicine';
        const isSelfPay = (patient?.patient_type || 'self-pay') === 'self-pay';

        let consultInvId: number | null = null;
        if (patient && patient.patient_type !== 'exempt') {
          const svcCode = existing.visit_type === 'follow-up' ? 'OPD-FU' : specialtyToServiceCode(specialty);
          const svc = await queryOne<{ code: string; name: string; unit_price: number }>(
            'SELECT code, name, unit_price FROM services WHERE code = ?',
            [svcCode]
          );
          const fee = Number(svc?.unit_price || (existing.visit_type === 'follow-up' ? 25.0 : 45.0));
          const invNum = await nextSequence('INV');
          const invStatus = patient.patient_type === 'insurance' || patient.patient_type === 'credit' ? 'credit_billed' : 'unpaid';
          const invRes = await execute(
            `INSERT INTO invoices (invoice_number, patient_id, payer_type, payer_name, subtotal, discount_amount, total_amount, paid_amount, status, notes, created_by)
             VALUES (?, ?, ?, ?, ?, 0, ?, 0, ?, 'Consultation fee', ?)`,
            [invNum, existing.patient_id, patient.patient_type, patient.payer_name, fee, fee, invStatus, req.user!.id]
          );
          await execute(
            'INSERT INTO invoice_items (invoice_id, service_code, description, category, quantity, unit_price, line_total) VALUES (?, ?, ?, ?, 1, ?, ?)',
            [invRes.insertId, svc?.code || svcCode, svc?.name || `${specialty} Consultation`, 'consultation', fee, fee]
          );
          consultInvId = invRes.insertId;
        }

        const workflowStage = isSelfPay && consultInvId ? 'awaiting_payment' : 'paid_awaiting_vitals';
        const visitNum = await nextSequence('VISIT');
        const vRes = await execute(
          `INSERT INTO visits (visit_number, patient_id, doctor_id, appointment_id, visit_type, specialty, consultation_invoice_id, workflow_stage, triage_priority, chief_complaint, status, created_by)
           VALUES (?, ?, ?, ?, 'scheduled', ?, ?, ?, 'routine', ?, 'triage', ?)`,
          [visitNum, existing.patient_id, existing.doctor_id, id, specialty, consultInvId, workflowStage, existing.reason || 'Scheduled appointment', req.user!.id]
        );
        visitIdOut = vRes.insertId;
        if (consultInvId) {
          await execute('UPDATE invoices SET visit_id = ? WHERE id = ?', [visitIdOut, consultInvId]);
        }

        ticketOut = await nextSequence('TICKET');
        await execute(
          'INSERT INTO queue_tickets (ticket_number, department, patient_id, visit_id, priority, status, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [
            ticketOut,
            workflowStage === 'awaiting_payment' ? 'CSH' : 'TRIAGE',
            existing.patient_id,
            visitIdOut,
            'routine',
            'waiting',
            workflowStage === 'awaiting_payment' ? 'Pending Consultation Payment' : 'Paid - Awaiting Vitals',
            req.user!.id,
          ]
        );

        if (workflowStage === 'paid_awaiting_vitals') {
          await createNotification({
            targetRole: 'NUR',
            title: 'Paid - Awaiting Vitals',
            message: `Scheduled appointment ${visitNum} (${ticketOut}) cleared for triage vitals.`,
            severity: 'info',
            entityType: 'visit',
            entityId: visitIdOut,
          });
        } else {
          await createNotification({
            targetRole: 'CSH',
            title: 'Consultation Payment Due',
            message: `Checked-in appointment ${visitNum} awaiting consultation fee payment.`,
            severity: 'info',
            entityType: 'visit',
            entityId: visitIdOut,
          });
        }
      }
    }

    await writeAuditLog({
      user: req.user,
      action: 'appointment.update',
      entityType: 'appointment',
      entityId: id,
      patientId: Number(existing.patient_id),
      before: { status: existing.status },
      after: { status: status ?? existing.status, createdVisitId: visitIdOut, ticketNumber: ticketOut },
      req,
    });

    return { createdVisitId: visitIdOut, ticketNumber: ticketOut };
  });

  if (createdVisitId) {
    broadcastClinicEvent('visit:updated', { visitId: createdVisitId });
    broadcastClinicEvent('queue:updated', { visitId: createdVisitId });
  }
  res.json({ ok: true, createdVisitId, ticketNumber });
});

// ---------------------------------------------------------------------------
// TRIAGE, VITALS & OPD VISITS
// ---------------------------------------------------------------------------
router.get('/visits', requireAuth, requirePermission('visit.read', 'vitals.read'), async (req: AuthRequest, res: Response) => {
  const stageFilter = req.query.stage ? String(req.query.stage).trim() : '';
  const stages = stageFilter ? stageFilter.split(',').map((s) => s.trim()).filter(Boolean) : [];
  let whereSql = '';
  const params: unknown[] = [];
  if (stages.length > 0) {
    const ph = stages.map(() => '?').join(',');
    whereSql = ` WHERE v.workflow_stage IN (${ph})`;
    params.push(...stages);
  }

  const rows = await query<Record<string, unknown>>(
    `SELECT v.*, p.mrn, p.first_name, p.last_name, p.sex, p.date_of_birth, p.allergies, p.blood_group, p.patient_type,
            u.full_name AS doctor_name,
            ci.invoice_number AS consultation_invoice_number,
            ci.status AS consultation_invoice_status,
            (SELECT COUNT(*) FROM vitals vt WHERE vt.visit_id = v.id) AS vitals_count,
            (SELECT COUNT(*) FROM lab_orders lo WHERE lo.visit_id = v.id AND lo.status IN ('ordered','collected','resulted')) AS pending_lab_count,
            (SELECT COUNT(*) FROM lab_orders lo WHERE lo.visit_id = v.id AND lo.status IN ('verified','amended')) AS verified_lab_count,
            (SELECT COUNT(*) FROM imaging_orders io WHERE io.visit_id = v.id AND io.status IN ('ordered','scheduled','performed','reported_draft')) AS pending_imaging_count,
            (SELECT COUNT(*) FROM imaging_orders io WHERE io.visit_id = v.id AND io.status = 'reported_final') AS final_imaging_count,
            (SELECT COUNT(*) FROM prescriptions pr WHERE pr.visit_id = v.id) AS rx_count
     FROM visits v
     INNER JOIN patients p ON p.id = v.patient_id
     LEFT JOIN users u ON u.id = v.doctor_id
     LEFT JOIN invoices ci ON ci.id = v.consultation_invoice_id${whereSql}
     ORDER BY CASE v.triage_priority WHEN 'emergency' THEN 1 WHEN 'urgent' THEN 2 ELSE 3 END, v.id DESC LIMIT 60`,
    params
  );

  const canSeeClinical = hasPermission(req.user!, 'patient.clinical.read');
  const visits = rows.map((v) => {
    const cleared =
      v.patient_type !== 'self-pay' ||
      !v.consultation_invoice_id ||
      v.consultation_invoice_status === 'paid' ||
      v.workflow_stage !== 'awaiting_payment';
    const pendingDiag = Number(v.pending_lab_count || 0) + Number(v.pending_imaging_count || 0);
    const completedDiag = Number(v.verified_lab_count || 0) + Number(v.final_imaging_count || 0);
    const resultsReady =
      v.workflow_stage === 'results_ready' || (completedDiag > 0 && pendingDiag === 0 && v.status !== 'closed');
    if (!canSeeClinical) {
      return {
        ...v,
        allergies: 'Restricted',
        blood_group: 'Restricted',
        history_notes: null,
        exam_notes: null,
        diagnosis_code: null,
        diagnosis_text: null,
        treatment_plan: null,
        consultation_cleared: cleared,
        results_ready: resultsReady,
      };
    }
    return {
      ...v,
      consultation_cleared: cleared,
      results_ready: resultsReady,
    };
  });
  res.json({ visits, clinicalMasked: !canSeeClinical });
});

router.get('/visits/:id', requireAuth, requirePermission('visit.read', 'vitals.read'), async (req: AuthRequest, res: Response) => {
  const id = Number(req.params.id);
  const canSeeClinical = hasPermission(req.user!, 'patient.clinical.read');
  const visitRow = await queryOne<Record<string, unknown>>(
    `SELECT v.*, p.mrn, p.first_name, p.last_name, p.sex, p.date_of_birth, p.allergies, p.blood_group, p.patient_type,
            u.full_name AS doctor_name,
            ci.invoice_number AS consultation_invoice_number,
            ci.status AS consultation_invoice_status
     FROM visits v
     INNER JOIN patients p ON p.id = v.patient_id
     LEFT JOIN users u ON u.id = v.doctor_id
     LEFT JOIN invoices ci ON ci.id = v.consultation_invoice_id
     WHERE v.id = ?`,
    [id]
  );
  if (!visitRow) return res.status(404).json({ error: 'Visit not found' });

  const [vitals, labOrders, imagingOrders, prescriptions, nursingProcedures] = await Promise.all([
    canSeeClinical ? query('SELECT * FROM vitals WHERE visit_id = ? ORDER BY id DESC', [id]) : Promise.resolve([]),
    query<Record<string, unknown>>(
      `SELECT lo.*, lt.code AS test_code, lt.name AS test_name, lt.unit, lt.reference_range, lt.analyte_template_json,
              i.invoice_number, i.status AS invoice_status
       FROM lab_orders lo
       INNER JOIN lab_tests lt ON lt.id = lo.test_id
       LEFT JOIN invoices i ON i.id = lo.invoice_id
       WHERE lo.visit_id = ?`,
      [id]
    ),
    query<Record<string, unknown>>(
      `SELECT io.*, ic.code AS exam_code, ic.name AS exam_name, ic.modality,
              i.invoice_number, i.status AS invoice_status,
              (SELECT COUNT(*) FROM imaging_attachments ia WHERE ia.imaging_order_id = io.id) AS attachment_count
       FROM imaging_orders io
       INNER JOIN imaging_catalog ic ON ic.id = io.catalog_id
       LEFT JOIN invoices i ON i.id = io.invoice_id
       WHERE io.visit_id = ?`,
      [id]
    ),
    query<Record<string, unknown>>(
      `SELECT pr.*, i.invoice_number, i.status AS invoice_status
       FROM prescriptions pr
       LEFT JOIN invoices i ON i.id = pr.invoice_id
       WHERE pr.visit_id = ?`,
      [id]
    ),
    query(
      `SELECT np.*, s.unit_price, u1.full_name AS ordered_by_name, u2.full_name AS performed_by_name, i.invoice_number, i.status AS invoice_status
       FROM nursing_procedures np
       LEFT JOIN services s ON s.id = np.service_id
       LEFT JOIN users u1 ON u1.id = np.ordered_by
       LEFT JOIN users u2 ON u2.id = np.performed_by
       LEFT JOIN invoices i ON i.id = np.invoice_id
       WHERE np.visit_id = ?
       ORDER BY np.id DESC`,
      [id]
    ),
  ]);

  if (prescriptions.length > 0) {
    const rxIds = prescriptions.map((pr) => pr.id);
    const ph = rxIds.map(() => '?').join(',');
    const allItems = await query<Record<string, unknown>>(
      `SELECT pi.*, m.generic_name, m.strength, m.form, m.stock_qty, m.unit_price AS catalog_unit_price
       FROM prescription_items pi
       INNER JOIN medicines m ON m.id = pi.medicine_id
       WHERE pi.prescription_id IN (${ph})`,
      rxIds
    );
    const itemsByRx = new Map<number, Record<string, unknown>[]>();
    for (const it of allItems) {
      const k = Number(it.prescription_id);
      if (!itemsByRx.has(k)) itemsByRx.set(k, []);
      itemsByRx.get(k)!.push(it);
    }
    for (const pr of prescriptions) {
      pr.items = itemsByRx.get(Number(pr.id)) || [];
    }
  }

  const cleared =
    visitRow.patient_type !== 'self-pay' ||
    !visitRow.consultation_invoice_id ||
    visitRow.consultation_invoice_status === 'paid' ||
    visitRow.workflow_stage !== 'awaiting_payment';
  const pendingDiag =
    labOrders.filter((l) => ['ordered', 'collected', 'resulted'].includes(String(l.status))).length +
    imagingOrders.filter((im) => ['ordered', 'scheduled', 'performed', 'reported_draft'].includes(String(im.status))).length;
  const completedDiag =
    labOrders.filter((l) => ['verified', 'amended'].includes(String(l.status))).length +
    imagingOrders.filter((im) => im.status === 'reported_final').length;
  const baseVisit = {
    ...visitRow,
    consultation_cleared: cleared,
    results_ready: visitRow.workflow_stage === 'results_ready' || (completedDiag > 0 && pendingDiag === 0 && visitRow.status !== 'closed'),
  };
  const visit = canSeeClinical
    ? baseVisit
    : {
        ...baseVisit,
        allergies: 'Restricted',
        blood_group: 'Restricted',
        history_notes: null,
        exam_notes: null,
        diagnosis_code: null,
        diagnosis_text: null,
        treatment_plan: null,
      };

  res.json({
    visit,
    clinicalMasked: !canSeeClinical,
    vitals,
    labOrders: canSeeClinical ? labOrders : labOrders.map((l) => ({ ...l, result_value: null, panel_results_json: null })),
    imagingOrders: canSeeClinical ? imagingOrders : imagingOrders.map((im) => ({ ...im, findings: null, impression: null })),
    prescriptions,
    nursingProcedures,
  });
});

router.post('/visits', requireAuth, requirePermission('visit.create'), async (req: AuthRequest, res: Response) => {
  const {
    patient_id,
    doctor_id,
    appointment_id,
    visit_type = 'walk_in',
    specialty,
    service_code,
    triage_priority = 'routine',
    chief_complaint,
    queue_department,
    generate_consultation_invoice = true,
    collect_payment = false,
    payment_method = 'cash',
    payment_reference,
  } = req.body || {};
  if (!patient_id) return res.status(400).json({ error: 'patient_id is required' });

  const result = await withTransaction(async () => {
    const patient = await queryOne<{ id: number; patient_type: string; payer_name: string | null }>(
      'SELECT id, patient_type, payer_name FROM patients WHERE id = ?',
      [Number(patient_id)]
    );
    if (!patient) return { ok: false as const, error: 'Patient not found', httpStatus: 404 };

    let resolvedSpecialty = specialty ? String(specialty).trim() : 'General Medicine';
    let doctorName: string | null = null;
    if (doctor_id) {
      const doc = await queryOne<{ full_name: string; specialty: string | null }>(
        'SELECT full_name, specialty FROM users WHERE id = ?',
        [Number(doctor_id)]
      );
      if (doc) {
        doctorName = doc.full_name;
        if (doc.specialty && !specialty) {
          resolvedSpecialty = doc.specialty;
        }
      }
    }

    let consultInvId: number | null = null;
    let consultInvNum: string | null = null;
    let consultInvStatus: string | null = null;
    let consultationFee = 0;

    if (generate_consultation_invoice && patient.patient_type !== 'exempt') {
      const svcCode = service_code
        ? String(service_code).trim()
        : visit_type === 'follow_up' || visit_type === 'follow-up'
          ? 'OPD-FU'
          : specialtyToServiceCode(resolvedSpecialty);
      const svc = await queryOne<{ code: string; name: string; unit_price: number }>(
        'SELECT code, name, unit_price FROM services WHERE code = ?',
        [svcCode]
      );
      const fee = Number(svc?.unit_price || (svcCode === 'OPD-FU' ? 25.0 : 45.0));
      consultationFee = fee;
      consultInvNum = await nextSequence('INV');
      consultInvStatus = patient.patient_type === 'insurance' || patient.patient_type === 'credit' ? 'credit_billed' : 'unpaid';
      const invRes = await execute(
        `INSERT INTO invoices (invoice_number, patient_id, payer_type, payer_name, subtotal, discount_amount, total_amount, paid_amount, status, notes, created_by)
         VALUES (?, ?, ?, ?, ?, 0, ?, 0, ?, ?, ?)`,
        [
          consultInvNum,
          patient.id,
          patient.patient_type,
          patient.payer_name,
          fee,
          fee,
          consultInvStatus,
          `${resolvedSpecialty} consultation (${visit_type})`,
          req.user!.id,
        ]
      );
      await execute(
        'INSERT INTO invoice_items (invoice_id, service_code, description, category, quantity, unit_price, line_total) VALUES (?, ?, ?, ?, 1, ?, ?)',
        [invRes.insertId, svc?.code || svcCode, svc?.name || `${resolvedSpecialty} Consultation`, 'consultation', fee, fee]
      );
      consultInvId = invRes.insertId;
    }

    let receiptNumber: string | null = null;
    let paidAtCheckIn = false;
    if (collect_payment && consultInvId && consultInvStatus === 'unpaid' && consultationFee > 0) {
      if (!hasPermission(req.user!, 'billing.payment.create')) {
        return { ok: false as const, error: 'Only Cashiers with payment permission can collect upfront consultation fees.', httpStatus: 403 };
      }
      const openShift = await queryOne<{ id: number }>(
        "SELECT id FROM cashier_shifts WHERE cashier_id = ? AND status = 'open'",
        [req.user!.id]
      );
      if (!openShift) {
        return { ok: false as const, error: 'You must open a Cashier Shift before collecting payments.', httpStatus: 409 };
      }
      const method = String(payment_method || 'cash').trim().toLowerCase();
      const payRes = await execute(
        `INSERT INTO payments (invoice_id, patient_id, shift_id, amount, payment_method, reference_number, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, 'completed', ?)`,
        [consultInvId, patient.id, openShift.id, consultationFee, method, payment_reference || null, req.user!.id]
      );
      receiptNumber = await nextSequence('RCP');
      await execute(
        `INSERT INTO receipts (receipt_number, payment_id, invoice_id, patient_id, amount, payment_method, issued_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [receiptNumber, payRes.insertId, consultInvId, patient.id, consultationFee, method, req.user!.id]
      );
      await execute('UPDATE invoices SET paid_amount = ?, status = ? WHERE id = ?', [consultationFee, 'paid', consultInvId]);
      if (method === 'cash') {
        await execute('UPDATE cashier_shifts SET expected_cash = expected_cash + ? WHERE id = ?', [consultationFee, openShift.id]);
      }
      const cashOrBankAcct = method === 'cash' ? '1010' : '1020';
      await postJournalEntry({
        sourceType: 'payment',
        sourceId: payRes.insertId,
        description: `Walk-in check-in payment ${receiptNumber} for ${consultInvNum}`,
        postedBy: req.user!.id,
        lines: [
          { accountCode: cashOrBankAcct, debit: consultationFee, memo: `${method} receipt ${receiptNumber}` },
          { accountCode: '4010', credit: consultationFee, memo: consultInvNum || 'Consultation' },
        ],
      });
      await writeAuditLog({
        user: req.user,
        action: 'billing.payment.create',
        entityType: 'payment',
        entityId: payRes.insertId,
        patientId: patient.id,
        after: { invoiceId: consultInvId, amount: consultationFee, method, receiptNumber, walkInCheckIn: true },
        req,
      });
      consultInvStatus = 'paid';
      paidAtCheckIn = true;
    }

    const isSelfPay = patient.patient_type === 'self-pay';
    const workflowStage =
      triage_priority === 'emergency' || !isSelfPay || !consultInvId || paidAtCheckIn
        ? 'paid_awaiting_vitals'
        : 'awaiting_payment';

    const requestedDept = typeof queue_department === 'string' ? queue_department.trim().toUpperCase() : '';
    const allowedClearedDepts = new Set(['TRIAGE', 'OPD']);
    const assignedQueueDept =
      workflowStage === 'awaiting_payment'
        ? 'CSH'
        : allowedClearedDepts.has(requestedDept)
          ? requestedDept
          : 'TRIAGE';

    const visitNum = await nextSequence('VISIT');
    const inserted = await execute(
      `INSERT INTO visits (visit_number, patient_id, doctor_id, appointment_id, visit_type, specialty, consultation_invoice_id, workflow_stage, triage_priority, chief_complaint, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'triage', ?)`,
      [
        visitNum,
        patient.id,
        doctor_id ? Number(doctor_id) : null,
        appointment_id ? Number(appointment_id) : null,
        visit_type,
        resolvedSpecialty,
        consultInvId,
        workflowStage,
        triage_priority,
        chief_complaint || null,
        req.user!.id,
      ]
    );

    if (consultInvId) {
      await execute('UPDATE invoices SET visit_id = ? WHERE id = ?', [inserted.insertId, consultInvId]);
    }

    const ticketNum = await nextSequence('TICKET');
    const ticketNotes =
      workflowStage === 'awaiting_payment'
        ? 'Pending Consultation Payment'
        : assignedQueueDept === 'OPD'
          ? 'Cleared - Walk-In OPD Queue'
          : 'Paid - Awaiting Vitals';
    await execute(
      'INSERT INTO queue_tickets (ticket_number, department, patient_id, visit_id, priority, status, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        ticketNum,
        assignedQueueDept,
        patient.id,
        inserted.insertId,
        triage_priority,
        'waiting',
        ticketNotes,
        req.user!.id,
      ]
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
    } else if (workflowStage === 'paid_awaiting_vitals') {
      await createNotification({
        targetRole: 'NUR',
        title: 'Paid - Awaiting Vitals',
        message: `Visit ${visitNum} (${ticketNum}) cleared for ${assignedQueueDept === 'OPD' ? 'OPD consultation' : 'Vital Room triage'}.`,
        severity: 'info',
        entityType: 'visit',
        entityId: inserted.insertId,
      });
    } else {
      await createNotification({
        targetRole: 'CSH',
        title: 'Consultation Payment Due',
        message: `Visit ${visitNum} awaiting consultation payment (${consultInvNum}).`,
        severity: 'info',
        entityType: 'visit',
        entityId: inserted.insertId,
      });
    }

    await writeAuditLog({
      user: req.user,
      action: 'visit.create',
      entityType: 'visit',
      entityId: inserted.insertId,
      patientId: patient.id,
      after: {
        visitNum,
        visit_type,
        specialty: resolvedSpecialty,
        workflowStage,
        queueDepartment: assignedQueueDept,
        consultationInvoiceNumber: consultInvNum,
        receiptNumber,
        triage_priority,
      },
      req,
    });

    return {
      ok: true as const,
      id: inserted.insertId,
      visitNumber: visitNum,
      visitType: visit_type,
      specialty: resolvedSpecialty,
      doctorName,
      workflowStage,
      queueDepartment: assignedQueueDept,
      consultationFee,
      consultationInvoiceId: consultInvId,
      consultationInvoiceNumber: consultInvNum,
      consultationInvoiceStatus: consultInvStatus,
      receiptNumber,
      ticketNumber: ticketNum,
    };
  });

  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error });
  if (result.receiptNumber && result.consultationInvoiceId) {
    broadcastClinicEvent('payment:confirmed', {
      invoiceId: result.consultationInvoiceId,
      invoiceStatus: result.consultationInvoiceStatus,
      receiptNumber: result.receiptNumber,
    });
  }
  broadcastClinicEvent('visit:updated', { visitId: result.id });
  broadcastClinicEvent('queue:updated', { visitId: result.id });
  res.status(201).json(result);
});

router.post('/visits/:id/vitals', requireAuth, requirePermission('vitals.create'), async (req: AuthRequest, res: Response) => {
  const visitId = Number(req.params.id);
  const visit = await queryOne<{
    id: number;
    patient_id: number;
    doctor_id: number | null;
    visit_number: string;
    status: string;
    workflow_stage: string | null;
    triage_priority: string;
    consultation_invoice_id: number | null;
    patient_type: string;
    consultation_invoice_status: string | null;
  }>(
    `SELECT v.id, v.patient_id, v.doctor_id, v.visit_number, v.status, v.workflow_stage, v.triage_priority, v.consultation_invoice_id,
            p.patient_type, ci.status AS consultation_invoice_status
     FROM visits v
     INNER JOIN patients p ON p.id = v.patient_id
     LEFT JOIN invoices ci ON ci.id = v.consultation_invoice_id
     WHERE v.id = ?`,
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
    doctor_id,
    bypass_payment_gate,
    bypass_reason,
  } = req.body || {};

  const consultCleared =
    visit.patient_type !== 'self-pay' ||
    !visit.consultation_invoice_id ||
    visit.consultation_invoice_status === 'paid' ||
    visit.workflow_stage !== 'awaiting_payment';

  if (!consultCleared) {
    const bypassCheck = canBypassPaymentGate(
      req.user!,
      visit.triage_priority === 'emergency' || triage_priority === 'emergency',
      bypass_payment_gate,
      bypass_reason
    );
    if (bypassCheck.allowed) {
      await writeAuditLog({
        user: req.user,
        action: 'payment.gate.bypass',
        entityType: 'visit',
        entityId: visitId,
        patientId: visit.patient_id,
        reason: bypassCheck.reasonText,
        req,
      });
    } else {
      return res.status(402).json({
        error: 'Payment Gate: Self-pay consultation invoice must be paid at Cashier before Vital Room triage.',
      });
    }
  }

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

  const assignedDoctorId = doctor_id ? Number(doctor_id) : visit.doctor_id;
  await execute(
    `UPDATE visits
     SET triage_priority = COALESCE(?, triage_priority),
         chief_complaint = COALESCE(?, chief_complaint),
         doctor_id = COALESCE(?, doctor_id),
         workflow_stage = CASE WHEN workflow_stage IN ('awaiting_payment','paid_awaiting_vitals') THEN 'ready_for_doctor' ELSE workflow_stage END
     WHERE id = ?`,
    [triage_priority || null, chief_complaint || null, doctor_id ? Number(doctor_id) : null, visitId]
  );

  let doctorLabel = 'Doctor';
  if (assignedDoctorId) {
    const docRow = await queryOne<{ full_name: string; specialty: string | null }>(
      'SELECT full_name, specialty FROM users WHERE id = ?',
      [assignedDoctorId]
    );
    if (docRow) doctorLabel = `${docRow.full_name}${docRow.specialty ? ` (${docRow.specialty})` : ''}`;
  }

  const existingTicket = await queryOne<{ id: number }>(
    "SELECT id FROM queue_tickets WHERE visit_id = ? AND status IN ('waiting','called','in_service') ORDER BY id DESC LIMIT 1",
    [visitId]
  );
  if (existingTicket) {
    await execute("UPDATE queue_tickets SET department = 'OPD', status = 'waiting', notes = ? WHERE id = ?", [
      `Ready for ${doctorLabel}`,
      existingTicket.id,
    ]);
  } else {
    const tNum = await nextSequence('TICKET');
    await execute(
      "INSERT INTO queue_tickets (ticket_number, department, patient_id, visit_id, priority, status, notes, created_by) VALUES (?, 'OPD', ?, ?, ?, 'waiting', ?, ?)",
      [tNum, visit.patient_id, visitId, triage_priority || visit.triage_priority || 'routine', `Ready for ${doctorLabel}`, req.user!.id]
    );
  }

  if (earlyWarning || triage_priority === 'emergency') {
    await createNotification({
      targetRole: 'DOC',
      title: 'Early-Warning Vitals Alert',
      message: `Visit ${visit.visit_number} flagged abnormal vitals (SpO2 ${spo2}%, Temp ${temperature}°C) — routed to ${doctorLabel}.`,
      severity: 'critical',
      entityType: 'visit',
      entityId: visitId,
    });
  } else {
    await createNotification({
      targetRole: 'DOC',
      title: 'Ready for Doctor',
      message: `Vitals recorded for ${visit.visit_number}. Patient routed to ${doctorLabel}.`,
      severity: 'info',
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
    after: { bp_systolic, bp_diastolic, temperature, respiratory_rate, spo2, bmi, earlyWarning, workflowStage: 'ready_for_doctor' },
    req,
  });

  broadcastClinicEvent('vitals:recorded', { visitId });
  broadcastClinicEvent('visit:updated', { visitId });
  broadcastClinicEvent('queue:updated', { visitId });
  res.status(201).json({ id: inserted.insertId, bmi, earlyWarningFlag: Boolean(earlyWarning), workflowStage: 'ready_for_doctor' });
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
         status = CASE WHEN status = 'triage' THEN 'in_consultation' ELSE status END,
         workflow_stage = CASE WHEN workflow_stage IN ('awaiting_payment','paid_awaiting_vitals','ready_for_doctor','results_ready') THEN 'in_consultation' ELSE workflow_stage END
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

  broadcastClinicEvent('visit:updated', { visitId });
  res.json({ ok: true });
});

router.post('/visits/:id/close', requireAuth, requirePermission('visit.close'), async (req: AuthRequest, res: Response) => {
  const visitId = Number(req.params.id);
  const visit = await queryOne<{ id: number; patient_id: number; appointment_id: number | null; diagnosis_text: string | null; status: string }>(
    'SELECT id, patient_id, appointment_id, diagnosis_text, status FROM visits WHERE id = ?',
    [visitId]
  );
  if (!visit) return res.status(404).json({ error: 'Visit not found' });
  if (!visit.diagnosis_text?.trim()) {
    return res.status(400).json({ error: 'Diagnosis is required before closing a visit.' });
  }

  await execute("UPDATE visits SET status = 'closed', workflow_stage = 'completed', closed_at = datetime('now'), closed_by = ? WHERE id = ?", [
    req.user!.id,
    visitId,
  ]).catch(async () => {
    await execute("UPDATE visits SET status = 'closed', workflow_stage = 'completed', closed_at = NOW(), closed_by = ? WHERE id = ?", [req.user!.id, visitId]);
  });

  await execute("UPDATE queue_tickets SET status = 'completed' WHERE visit_id = ?", [visitId]);
  if (visit.appointment_id) {
    await execute("UPDATE appointments SET status = 'completed' WHERE id = ? AND status != 'cancelled'", [visit.appointment_id]);
  }

  await writeAuditLog({
    user: req.user,
    action: 'visit.close',
    entityType: 'visit',
    entityId: visitId,
    patientId: visit.patient_id,
    req,
  });
  broadcastClinicEvent('visit:updated', { visitId });
  broadcastClinicEvent('queue:updated', { visitId });
  res.json({ ok: true });
});

router.post('/visits/:id/reopen', requireAuth, requirePermission('visit.reopen'), async (req: AuthRequest, res: Response) => {
  const visitId = Number(req.params.id);
  const { reason } = req.body || {};
  if (!reason?.trim()) return res.status(400).json({ error: 'A formal reason is required to reopen a closed visit.' });

  const visit = await queryOne<{ id: number; patient_id: number }>('SELECT id, patient_id FROM visits WHERE id = ?', [visitId]);
  if (!visit) return res.status(404).json({ error: 'Visit not found' });

  await execute("UPDATE visits SET status = 'in_consultation', workflow_stage = 'in_consultation', reopen_reason = ? WHERE id = ?", [reason.trim(), visitId]);
  await writeAuditLog({
    user: req.user,
    action: 'visit.reopen',
    entityType: 'visit',
    entityId: visitId,
    patientId: visit.patient_id,
    reason: reason.trim(),
    req,
  });
  broadcastClinicEvent('visit:updated', { visitId });
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
    `INSERT INTO invoices (invoice_number, patient_id, visit_id, payer_type, payer_name, subtotal, discount_amount, total_amount, paid_amount, status, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
    [invNum, visit.patient_id, visitId, patient?.patient_type || 'self-pay', patient?.payer_name || null, total, total, invStatus === 'paid' ? total : 0, invStatus, `Laboratory: ${test.name}`, req.user!.id]
  );
  await execute(
    'INSERT INTO invoice_items (invoice_id, service_code, description, category, quantity, unit_price, line_total) VALUES (?, ?, ?, ?, 1, ?, ?)',
    [invRes.insertId, test.code, test.name, 'lab', total, total]
  );

  const orderRes = await execute(
    'INSERT INTO lab_orders (visit_id, patient_id, test_id, invoice_id, ordered_by, status) VALUES (?, ?, ?, ?, ?, ?)',
    [visitId, visit.patient_id, test.id, invRes.insertId, req.user!.id, 'ordered']
  );

  await execute("UPDATE visits SET status = 'awaiting_results', workflow_stage = 'awaiting_diagnostics' WHERE id = ?", [visitId]);

  if (invStatus === 'unpaid') {
    await createNotification({
      targetRole: 'CSH',
      title: 'Diagnostic Payment Due (Lab)',
      message: `${test.name} ordered (${invNum}) — collect payment to unlock Lab.`,
      severity: 'info',
      entityType: 'invoice',
      entityId: invRes.insertId,
    });
  } else {
    await createNotification({
      targetRole: 'LAB',
      title: 'New Cleared Lab Order',
      message: `${test.name} ordered (${invNum}) — ready for sample collection.`,
      severity: 'info',
      entityType: 'lab_order',
      entityId: orderRes.insertId,
    });
  }

  await writeAuditLog({
    user: req.user,
    action: 'order.lab.create',
    entityType: 'lab_order',
    entityId: orderRes.insertId,
    patientId: visit.patient_id,
    after: { test_code: test.code, invoice_number: invNum },
    req,
  });

  broadcastClinicEvent('lab:updated', { visitId, orderId: orderRes.insertId });
  broadcastClinicEvent('visit:updated', { visitId });
  res.status(201).json({ id: orderRes.insertId, invoiceNumber: invNum, invoiceStatus: invStatus });
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
    `INSERT INTO invoices (invoice_number, patient_id, visit_id, payer_type, payer_name, subtotal, discount_amount, total_amount, paid_amount, status, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
    [invNum, visit.patient_id, visitId, patient?.patient_type || 'self-pay', patient?.payer_name || null, total, total, invStatus === 'paid' ? total : 0, invStatus, `Imaging: ${exam.name}`, req.user!.id]
  );
  await execute(
    'INSERT INTO invoice_items (invoice_id, service_code, description, category, quantity, unit_price, line_total) VALUES (?, ?, ?, ?, 1, ?, ?)',
    [invRes.insertId, exam.code, exam.name, 'imaging', total, total]
  );

  const ordRes = await execute(
    'INSERT INTO imaging_orders (visit_id, patient_id, catalog_id, invoice_id, ordered_by, clinical_question, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [visitId, visit.patient_id, exam.id, invRes.insertId, req.user!.id, clinical_question || null, 'ordered']
  );

  await execute("UPDATE visits SET status = 'awaiting_results', workflow_stage = 'awaiting_diagnostics' WHERE id = ?", [visitId]);

  await createNotification({
    targetRole: invStatus === 'unpaid' ? 'CSH' : 'IMG',
    title: invStatus === 'unpaid' ? 'Diagnostic Payment Due (Imaging)' : 'New Imaging Order',
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

  broadcastClinicEvent('imaging:updated', { visitId, orderId: ordRes.insertId });
  broadcastClinicEvent('visit:updated', { visitId });
  res.status(201).json({ id: ordRes.insertId, invoiceNumber: invNum, invoiceStatus: invStatus });
});

router.post('/visits/:id/orders/prescription', requireAuth, requirePermission('prescription.create'), async (req: AuthRequest, res: Response) => {
  const visitId = Number(req.params.id);
  const { items: rawItems, medicine_id, dosage, frequency, duration_days = 5, quantity = 1, instructions, notes } = req.body || {};

  const normalizedItems = Array.isArray(rawItems) && rawItems.length > 0
    ? rawItems
    : medicine_id && dosage && frequency && quantity
      ? [{ medicine_id, dosage, frequency, duration_days, quantity, instructions }]
      : [];

  if (normalizedItems.length === 0) {
    return res.status(400).json({ error: 'At least one prescription item with medicine, dosage, frequency, and quantity is required.' });
  }

  for (const it of normalizedItems) {
    if (!it.medicine_id || !it.dosage || !it.frequency || !Number(it.quantity)) {
      return res.status(400).json({ error: 'Every prescription item requires medicine, dosage, frequency, and positive quantity.' });
    }
  }

  const visit = await queryOne<{ id: number; patient_id: number; status: string }>('SELECT id, patient_id, status FROM visits WHERE id = ?', [visitId]);
  if (!visit) return res.status(404).json({ error: 'Visit not found' });
  if (visit.status === 'closed') return res.status(409).json({ error: 'Cannot prescribe on a closed visit.' });

  const medIds = [...new Set(normalizedItems.map((it) => Number(it.medicine_id)))];
  const ph = medIds.map(() => '?').join(',');
  const medRows = await query<{ id: number; code: string; generic_name: string; strength: string; unit_price: number }>(
    `SELECT id, code, generic_name, strength, unit_price FROM medicines WHERE id IN (${ph})`,
    medIds
  );
  const medMap = new Map(medRows.map((m) => [Number(m.id), m]));
  for (const idCheck of medIds) {
    if (!medMap.has(idCheck)) {
      return res.status(404).json({ error: `Medicine ID ${idCheck} not found` });
    }
  }

  const patient = await queryOne<{ patient_type: string; payer_name: string | null; allergies: string | null }>(
    'SELECT patient_type, payer_name, allergies FROM patients WHERE id = ?',
    [visit.patient_id]
  );

  const rxRes = await execute(
    "INSERT INTO prescriptions (visit_id, patient_id, doctor_id, invoice_id, status, notes) VALUES (?, ?, ?, NULL, 'awaiting_stock_check', ?)",
    [visitId, visit.patient_id, req.user!.id, notes || null]
  );

  for (const it of normalizedItems) {
    const med = medMap.get(Number(it.medicine_id))!;
    const qty = Math.max(1, Number(it.quantity));
    const unitPrice = patient?.patient_type === 'exempt' ? 0 : Number(med.unit_price || 0);
    await execute(
      `INSERT INTO prescription_items (prescription_id, medicine_id, dosage, frequency, duration_days, quantity, selected_qty, external_qty, unit_price, instructions)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [rxRes.insertId, med.id, it.dosage, it.frequency, Number(it.duration_days || 5), qty, qty, unitPrice, it.instructions || null]
    );
  }

  await execute(
    "UPDATE visits SET workflow_stage = CASE WHEN workflow_stage = 'awaiting_diagnostics' THEN workflow_stage ELSE 'awaiting_pharmacy' END WHERE id = ?",
    [visitId]
  );

  await createNotification({
    targetRole: 'PHA',
    title: 'e-Prescription Stock Check Required',
    message: `New Rx #${rxRes.insertId} (${normalizedItems.length} item${normalizedItems.length > 1 ? 's' : ''}) awaiting pharmacy stock confirmation.`,
    severity: 'info',
    entityType: 'prescription',
    entityId: rxRes.insertId,
  });

  await writeAuditLog({
    user: req.user,
    action: 'prescription.create',
    entityType: 'prescription',
    entityId: rxRes.insertId,
    patientId: visit.patient_id,
    after: {
      itemCount: normalizedItems.length,
      medicines: normalizedItems.map((it) => ({ name: medMap.get(Number(it.medicine_id))!.generic_name, quantity: Number(it.quantity) })),
      status: 'awaiting_stock_check',
    },
    req,
  });

  broadcastClinicEvent('pharmacy:updated', { visitId, prescriptionId: rxRes.insertId });
  broadcastClinicEvent('visit:updated', { visitId });
  res.status(201).json({ id: rxRes.insertId, status: 'awaiting_stock_check', patientAllergies: patient?.allergies });
});

router.post('/visits/:id/nursing-procedures', requireAuth, requirePermission('nursing.procedure.perform', 'order.lab.create'), async (req: AuthRequest, res: Response) => {
  const visitId = Number(req.params.id);
  const { service_code, quantity = 1, notes, clinical_notes, perform_now = true } = req.body || {};
  if (!service_code) return res.status(400).json({ error: 'service_code (e.g. NUR-INJ or NUR-NEB) is required.' });

  const result = await withTransaction(async () => {
    const visit = await queryOne<{ id: number; patient_id: number; status: string }>('SELECT id, patient_id, status FROM visits WHERE id = ?', [visitId]);
    if (!visit) return { ok: false as const, error: 'Visit not found', httpStatus: 404 };
    if (visit.status === 'closed') return { ok: false as const, error: 'Cannot bill procedures on a closed visit.', httpStatus: 409 };

    const svc = await queryOne<{ id: number; code: string; name: string; unit_price: number }>(
      'SELECT id, code, name, unit_price FROM services WHERE code = ? AND active = 1',
      [String(service_code).trim()]
    );
    if (!svc) return { ok: false as const, error: 'Nursing procedure service code not found.', httpStatus: 404 };

    const patient = await queryOne<{ patient_type: string; payer_name: string | null }>(
      'SELECT patient_type, payer_name FROM patients WHERE id = ?',
      [visit.patient_id]
    );
    const qty = Math.max(1, Number(quantity || 1));
    const unitPrice = patient?.patient_type === 'exempt' ? 0 : Number(svc.unit_price);
    const total = Number((qty * unitPrice).toFixed(2));
    const invNum = await nextSequence('INV');
    const invStatus =
      patient?.patient_type === 'insurance' || patient?.patient_type === 'credit'
        ? 'credit_billed'
        : patient?.patient_type === 'exempt'
          ? 'paid'
          : 'unpaid';

    const invRes = await execute(
      `INSERT INTO invoices (invoice_number, patient_id, visit_id, payer_type, payer_name, subtotal, discount_amount, total_amount, paid_amount, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      [invNum, visit.patient_id, visitId, patient?.patient_type || 'self-pay', patient?.payer_name || null, total, total, invStatus === 'paid' ? total : 0, invStatus, req.user!.id]
    );
    await execute(
      'INSERT INTO invoice_items (invoice_id, service_code, description, category, quantity, unit_price, line_total) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [invRes.insertId, svc.code, svc.name, 'nursing', qty, unitPrice, total]
    );

    const procStatus = perform_now ? 'completed' : 'ordered';
    const rawNote = String(notes || clinical_notes || '').trim();
    const combinedNote = qty > 1 ? `Qty ${qty}${rawNote ? ` · ${rawNote}` : ''}` : rawNote || null;
    const procRes = await execute(
      `INSERT INTO nursing_procedures (visit_id, patient_id, service_id, service_code, service_name, invoice_id, ordered_by, performed_by, notes, status, performed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${perform_now ? "datetime('now')" : 'NULL'})`,
      [
        visitId,
        visit.patient_id,
        svc.id,
        svc.code,
        svc.name,
        invRes.insertId,
        req.user!.id,
        perform_now ? req.user!.id : null,
        combinedNote,
        procStatus,
      ]
    ).catch(async () => {
      return execute(
        `INSERT INTO nursing_procedures (visit_id, patient_id, service_id, service_code, service_name, invoice_id, ordered_by, performed_by, notes, status, performed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${perform_now ? 'NOW()' : 'NULL'})`,
        [
          visitId,
          visit.patient_id,
          svc.id,
          svc.code,
          svc.name,
          invRes.insertId,
          req.user!.id,
          perform_now ? req.user!.id : null,
          combinedNote,
          procStatus,
        ]
      );
    });

    await writeAuditLog({
      user: req.user,
      action: 'nursing.procedure.perform',
      entityType: 'nursing_procedure',
      entityId: procRes.insertId,
      patientId: visit.patient_id,
      after: { service_code: svc.code, quantity: qty, total, invoiceNumber: invNum, status: procStatus },
      req,
    });

    return { ok: true as const, id: procRes.insertId, invoiceNumber: invNum };
  });

  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error });
  res.status(201).json(result);
});

router.patch('/nursing-procedures/:id/complete', requireAuth, requirePermission('nursing.procedure.perform'), async (req: AuthRequest, res: Response) => {
  const id = Number(req.params.id);
  const existing = await queryOne<{ id: number; patient_id: number }>('SELECT id, patient_id FROM nursing_procedures WHERE id = ?', [id]);
  if (!existing) return res.status(404).json({ error: 'Nursing procedure not found' });
  const { notes, clinical_notes } = req.body || {};
  const finalNote = (notes || clinical_notes || '').trim() || null;
  await execute(
    "UPDATE nursing_procedures SET status = 'completed', performed_by = ?, notes = COALESCE(?, notes), performed_at = datetime('now') WHERE id = ?",
    [req.user!.id, finalNote, id]
  ).catch(async () => {
    await execute(
      "UPDATE nursing_procedures SET status = 'completed', performed_by = ?, notes = COALESCE(?, notes), performed_at = NOW() WHERE id = ?",
      [req.user!.id, finalNote, id]
    );
  });
  await writeAuditLog({
    user: req.user,
    action: 'nursing.procedure.complete',
    entityType: 'nursing_procedure',
    entityId: id,
    patientId: existing.patient_id,
    req,
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// LABORATORY WORKLIST (Two-Step Verify, Multi-Analyte Panels, Reject, Amend)
// ---------------------------------------------------------------------------
router.get('/lab/orders', requireAuth, requirePermission('lab.order.read'), async (_req, res) => {
  const orders = await query(
    `SELECT lo.*, lt.code AS test_code, lt.name AS test_name, lt.sample_type, lt.unit, lt.reference_range, lt.analyte_template_json,
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
  const { action, result_value, abnormal_flag, result_notes, rejection_reason, amend_reason, bypass_payment_gate, panel_results } = req.body || {};

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
    broadcastClinicEvent('lab:updated', { visitId: order.visit_id, orderId: id });
    return res.json({ ok: true });
  }

  // Payment gate check (emergency visits or authorized clinical bypass with reason are logged & permitted)
  if (order.invoice_id) {
    const inv = await queryOne<{ status: string; payer_type: string }>('SELECT status, payer_type FROM invoices WHERE id = ?', [
      order.invoice_id,
    ]);
    const isUnpaidSelfPay = inv && inv.payer_type === 'self-pay' && inv.status !== 'paid';
    if (isUnpaidSelfPay) {
      const bypassCheck = canBypassPaymentGate(
        req.user!,
        visit?.triage_priority === 'emergency',
        bypass_payment_gate,
        req.body?.bypass_reason
      );
      if (bypassCheck.allowed) {
        await writeAuditLog({
          user: req.user,
          action: 'payment.gate.bypass',
          entityType: 'lab_order',
          entityId: id,
          patientId: order.patient_id,
          reason: bypassCheck.reasonText,
          req,
        });
      } else {
        return res.status(402).json({
          error: 'Payment Gate: Self-pay lab invoice must be paid at Cashier before processing (unless authorized emergency bypass with reason).',
        });
      }
    }
  }

  if (action === 'collect') {
    if (!hasPermission(req.user!, 'lab.sample.collect')) return res.status(403).json({ error: 'Missing lab.sample.collect permission' });
    if (!['ordered', 'rejected'].includes(order.status)) {
      return res.status(409).json({ error: `Cannot collect sample from current status '${order.status}'.` });
    }
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
    broadcastClinicEvent('lab:updated', { visitId: order.visit_id, orderId: id });
    return res.json({ ok: true, barcode });
  }

  if (action === 'reject') {
    if (!hasPermission(req.user!, 'lab.sample.collect')) return res.status(403).json({ error: 'Missing lab permission' });
    if (!['ordered', 'collected'].includes(order.status)) {
      return res.status(409).json({ error: `Cannot reject sample from status '${order.status}'.` });
    }
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
    broadcastClinicEvent('lab:updated', { visitId: order.visit_id, orderId: id });
    return res.json({ ok: true });
  }

  if (action === 'recollect') {
    if (order.status !== 'rejected') {
      return res.status(409).json({ error: 'Only rejected samples can be reset for recollection.' });
    }
    await execute("UPDATE lab_orders SET status = 'ordered', sample_barcode = NULL, rejection_reason = NULL WHERE id = ?", [id]);
    await writeAuditLog({
      user: req.user,
      action: 'lab.sample.recollect',
      entityType: 'lab_order',
      entityId: id,
      patientId: order.patient_id,
      req,
    });
    broadcastClinicEvent('lab:updated', { visitId: order.visit_id, orderId: id });
    return res.json({ ok: true });
  }

  if (action === 'enter_result') {
    if (!hasPermission(req.user!, 'lab.result.enter')) return res.status(403).json({ error: 'Missing lab.result.enter permission' });
    if (order.status !== 'collected') {
      return res.status(409).json({ error: 'Sample must be collected before entering lab results.' });
    }
    const validPanel = Array.isArray(panel_results)
      ? panel_results.filter((p: { analyte?: string; value?: string }) => p && p.analyte && String(p.value || '').trim() !== '')
      : [];
    const computedSummary =
      String(result_value || '').trim() ||
      validPanel.map((p: { analyte: string; value: string; unit?: string }) => `${p.analyte}: ${p.value}${p.unit ? ` ${p.unit}` : ''}`).join('; ');
    if (!computedSummary) return res.status(400).json({ error: 'Result value or panel analyte values are required.' });

    const flags = validPanel.map((p: { flag?: string }) => p.flag || 'normal');
    const derivedFlag =
      abnormal_flag ||
      (flags.includes('critical') ? 'critical' : flags.includes('high') ? 'high' : flags.includes('low') ? 'low' : 'normal');
    const panelJson = validPanel.length > 0 ? JSON.stringify(validPanel) : null;

    await execute(
      "UPDATE lab_orders SET result_value = ?, abnormal_flag = ?, result_notes = ?, panel_results_json = ?, status = 'resulted', entered_by = ? WHERE id = ?",
      [computedSummary, derivedFlag, result_notes || null, panelJson, req.user!.id, id]
    );
    await writeAuditLog({
      user: req.user,
      action: 'lab.result.enter',
      entityType: 'lab_order',
      entityId: id,
      patientId: order.patient_id,
      after: { result_value: computedSummary, abnormal_flag: derivedFlag, panel_count: validPanel.length },
      req,
    });
    broadcastClinicEvent('lab:updated', { visitId: order.visit_id, orderId: id });
    return res.json({ ok: true });
  }

  if (action === 'verify') {
    if (!hasPermission(req.user!, 'lab.result.verify')) return res.status(403).json({ error: 'Missing lab.result.verify permission' });
    if (order.status !== 'resulted') {
      return res.status(409).json({ error: `Cannot verify lab order in status '${order.status}'; result must be entered first.` });
    }
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

    const remLab = await queryOne<{ cnt: number }>(
      "SELECT COUNT(*) AS cnt FROM lab_orders WHERE visit_id = ? AND status IN ('ordered','collected','resulted')",
      [order.visit_id]
    );
    const remImg = await queryOne<{ cnt: number }>(
      "SELECT COUNT(*) AS cnt FROM imaging_orders WHERE visit_id = ? AND status IN ('ordered','scheduled','performed','reported_draft')",
      [order.visit_id]
    );
    const allDiagDone = Number(remLab?.cnt || 0) === 0 && Number(remImg?.cnt || 0) === 0;
    if (allDiagDone) {
      await execute(
        "UPDATE visits SET workflow_stage = 'results_ready', status = CASE WHEN status = 'closed' THEN status ELSE 'in_consultation' END WHERE id = ?",
        [order.visit_id]
      );
    }

    await createNotification({
      targetRole: 'DOC',
      title: order.abnormal_flag === 'critical' ? 'CRITICAL Lab Result Released' : allDiagDone ? 'Results Ready — Lab Verified' : 'Lab Result Verified',
      message: `Lab order #${id} verified (${order.result_value}).${allDiagDone ? ' Patient ready for Doctor review.' : ''}`,
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
      after: { resultsReady: allDiagDone },
      req,
    });
    broadcastClinicEvent('lab:updated', { visitId: order.visit_id, orderId: id });
    broadcastClinicEvent('visit:updated', { visitId: order.visit_id, resultsReady: allDiagDone });
    return res.json({ ok: true, resultsReady: allDiagDone });
  }

  if (action === 'amend') {
    if (!hasPermission(req.user!, 'lab.result.verify')) return res.status(403).json({ error: 'Missing lab amendment permission' });
    if (!['verified', 'amended'].includes(order.status)) {
      return res.status(409).json({ error: 'Only verified or amended lab results can be amended.' });
    }
    const validPanel = Array.isArray(panel_results)
      ? panel_results.filter((p: { analyte?: string; value?: string }) => p && p.analyte && String(p.value || '').trim() !== '')
      : [];
    const computedSummary =
      String(result_value || '').trim() ||
      validPanel.map((p: { analyte: string; value: string; unit?: string }) => `${p.analyte}: ${p.value}${p.unit ? ` ${p.unit}` : ''}`).join('; ');
    if (!computedSummary || !amend_reason?.trim()) {
      return res.status(400).json({ error: 'New result value and formal amendment reason are required.' });
    }
    const panelJson = validPanel.length > 0 ? JSON.stringify(validPanel) : null;
    await execute(
      "UPDATE lab_orders SET previous_result_value = result_value, result_value = ?, abnormal_flag = ?, panel_results_json = COALESCE(?, panel_results_json), amend_reason = ?, status = 'amended' WHERE id = ?",
      [computedSummary, abnormal_flag || order.abnormal_flag || 'normal', panelJson, amend_reason.trim(), id]
    );
    await writeAuditLog({
      user: req.user,
      action: 'lab.result.amend',
      entityType: 'lab_order',
      entityId: id,
      patientId: order.patient_id,
      before: { result_value: order.result_value },
      after: { result_value: computedSummary, abnormal_flag },
      reason: amend_reason.trim(),
      req,
    });
    broadcastClinicEvent('lab:updated', { visitId: order.visit_id, orderId: id });
    return res.json({ ok: true });
  }

  res.status(400).json({ error: 'Unsupported lab action' });
});

// ---------------------------------------------------------------------------
// IMAGING / RADIOLOGY WORKLIST & ATTACHMENTS
// ---------------------------------------------------------------------------
router.get('/imaging/orders', requireAuth, requirePermission('imaging.order.read'), async (_req, res) => {
  const orders = await query(
    `SELECT io.*, ic.code AS exam_code, ic.name AS exam_name, ic.modality, ic.body_region,
            p.mrn, p.first_name, p.last_name, p.sex, p.date_of_birth, p.patient_type,
            i.invoice_number, i.status AS invoice_status,
            (SELECT COUNT(*) FROM imaging_attachments ia WHERE ia.imaging_order_id = io.id) AS attachment_count
     FROM imaging_orders io
     INNER JOIN imaging_catalog ic ON ic.id = io.catalog_id
     INNER JOIN patients p ON p.id = io.patient_id
     LEFT JOIN invoices i ON i.id = io.invoice_id
     ORDER BY io.id DESC LIMIT 60`
  );
  res.json({ orders });
});

router.get('/imaging/orders/:id/attachments', requireAuth, requirePermission('imaging.order.read', 'visit.read'), async (req, res) => {
  const orderId = Number(req.params.id);
  const attachments = await query(
    `SELECT ia.*, u.full_name AS uploaded_by_name
     FROM imaging_attachments ia
     LEFT JOIN users u ON u.id = ia.uploaded_by
     WHERE ia.imaging_order_id = ?
     ORDER BY ia.id DESC`,
    [orderId]
  );
  res.json({ attachments });
});

router.post('/imaging/orders/:id/attachments', requireAuth, requirePermission('imaging.exam.perform', 'imaging.report.finalise'), async (req: AuthRequest, res: Response) => {
  const orderId = Number(req.params.id);
  const { file_name, mime_type, data_url, caption } = req.body || {};
  if (!file_name || !mime_type || !data_url) {
    return res.status(400).json({ error: 'file_name, mime_type, and data_url are required.' });
  }
  const allowedMimes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml', 'application/pdf']);
  if (!allowedMimes.has(String(mime_type).trim().toLowerCase()) || !String(data_url).startsWith('data:')) {
    return res.status(400).json({ error: 'Unsupported file format. Only PNG, JPEG, WEBP, GIF, SVG, or PDF data URLs are allowed.' });
  }
  if (String(data_url).length > 4_200_000) {
    return res.status(400).json({ error: 'File exceeds maximum allowed 3 MB attachment limit.' });
  }
  const order = await queryOne<{ id: number; patient_id: number }>('SELECT id, patient_id FROM imaging_orders WHERE id = ?', [orderId]);
  if (!order) return res.status(404).json({ error: 'Imaging order not found' });

  const inserted = await execute(
    'INSERT INTO imaging_attachments (imaging_order_id, file_name, mime_type, data_url, caption, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)',
    [orderId, String(file_name).trim(), String(mime_type).trim(), String(data_url), caption || null, req.user!.id]
  );
  await writeAuditLog({
    user: req.user,
    action: 'imaging.attachment.upload',
    entityType: 'imaging_order',
    entityId: orderId,
    patientId: order.patient_id,
    after: { attachmentId: inserted.insertId, file_name, mime_type },
    req,
  });
  res.status(201).json({ id: inserted.insertId });
});

router.patch('/imaging/orders/:id', requireAuth, requirePermission('imaging.exam.perform', 'imaging.report.finalise'), async (req: AuthRequest, res: Response) => {
  const id = Number(req.params.id);
  const order = await queryOne<{ id: number; visit_id: number; patient_id: number; catalog_id: number; invoice_id: number | null; status: string }>(
    'SELECT * FROM imaging_orders WHERE id = ?',
    [id]
  );
  if (!order) return res.status(404).json({ error: 'Imaging order not found' });

  const visit = await queryOne<{ triage_priority: string }>('SELECT triage_priority FROM visits WHERE id = ?', [order.visit_id]);
  const { action, pregnancy_checked, exam_notes, findings, impression, addendum, bypass_payment_gate, bypass_reason } = req.body || {};

  if (order.invoice_id) {
    const inv = await queryOne<{ status: string; payer_type: string }>('SELECT status, payer_type FROM invoices WHERE id = ?', [
      order.invoice_id,
    ]);
    if (inv && inv.payer_type === 'self-pay' && inv.status !== 'paid') {
      const bypassCheck = canBypassPaymentGate(
        req.user!,
        visit?.triage_priority === 'emergency',
        bypass_payment_gate,
        bypass_reason
      );
      if (bypassCheck.allowed) {
        await writeAuditLog({
          user: req.user,
          action: 'payment.gate.bypass',
          entityType: 'imaging_order',
          entityId: id,
          patientId: order.patient_id,
          reason: bypassCheck.reasonText,
          req,
        });
      } else {
        return res.status(402).json({
          error: 'Payment Gate: Self-pay imaging invoice must be paid at Cashier before scanning (unless authorized emergency bypass with reason).',
        });
      }
    }
  }

  if (action === 'perform') {
    if (!['ordered', 'scheduled'].includes(order.status)) {
      return res.status(409).json({ error: `Cannot perform exam from current status '${order.status}'.` });
    }
    const [cat, pat] = await Promise.all([
      queryOne<{ modality: string }>('SELECT modality FROM imaging_catalog WHERE id = ?', [order.catalog_id]),
      queryOne<{ sex: string; date_of_birth: string }>('SELECT sex, date_of_birth FROM patients WHERE id = ?', [order.patient_id]),
    ]);
    const modality = (cat?.modality || '').toLowerCase();
    const isRadiation = modality.includes('x-ray') || modality.includes('xray') || modality === 'ct';
    if (isRadiation && pat?.sex === 'Female') {
      const dobYear = Number(String(pat.date_of_birth).slice(0, 4));
      const age = dobYear ? new Date().getFullYear() - dobYear : 30;
      if (age >= 12 && age <= 55 && !pregnancy_checked) {
        return res.status(400).json({
          error: 'Radiation Safety Gate: Pregnancy screening check is required before performing X-Ray or CT on female patients aged 12–55.',
        });
      }
    }
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
    broadcastClinicEvent('imaging:updated', { visitId: order.visit_id, orderId: id });
    return res.json({ ok: true });
  }

  if (action === 'finalise') {
    if (!['performed', 'reported_draft'].includes(order.status)) {
      return res.status(409).json({ error: 'Exam scan must be performed before finalising the radiology report.' });
    }
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

    const remLab = await queryOne<{ cnt: number }>(
      "SELECT COUNT(*) AS cnt FROM lab_orders WHERE visit_id = ? AND status IN ('ordered','collected','resulted')",
      [order.visit_id]
    );
    const remImg = await queryOne<{ cnt: number }>(
      "SELECT COUNT(*) AS cnt FROM imaging_orders WHERE visit_id = ? AND status IN ('ordered','scheduled','performed','reported_draft')",
      [order.visit_id]
    );
    const allDiagDone = Number(remLab?.cnt || 0) === 0 && Number(remImg?.cnt || 0) === 0;
    if (allDiagDone) {
      await execute(
        "UPDATE visits SET workflow_stage = 'results_ready', status = CASE WHEN status = 'closed' THEN status ELSE 'in_consultation' END WHERE id = ?",
        [order.visit_id]
      );
    }

    await createNotification({
      targetRole: 'DOC',
      title: allDiagDone ? 'Results Ready — Imaging Finalised' : 'Imaging Report Finalised',
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
      after: { impression: impression.trim(), resultsReady: allDiagDone },
      req,
    });
    broadcastClinicEvent('imaging:updated', { visitId: order.visit_id, orderId: id });
    broadcastClinicEvent('visit:updated', { visitId: order.visit_id, resultsReady: allDiagDone });
    return res.json({ ok: true, resultsReady: allDiagDone });
  }

  if (action === 'addendum') {
    if (order.status !== 'reported_final') {
      return res.status(409).json({ error: 'Addendums can only be added to finalised radiology reports.' });
    }
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
    broadcastClinicEvent('imaging:updated', { visitId: order.visit_id, orderId: id });
    return res.json({ ok: true });
  }

  res.status(400).json({ error: 'Unsupported imaging action' });
});

// Printable Verified Lab Report
router.get('/lab/orders/:id/report', requireAuth, requirePermission('lab.order.read', 'visit.read'), async (req, res) => {
  const id = Number(req.params.id);
  const report = await queryOne(
    `SELECT lo.*, lt.code AS test_code, lt.name AS test_name, lt.sample_type, lt.unit, lt.reference_range,
            p.mrn, p.first_name, p.last_name, p.sex, p.date_of_birth, p.phone,
            v.visit_number, u_ord.full_name AS ordered_by_name,
            u_ent.full_name AS entered_by_name, u_ver.full_name AS verified_by_name
     FROM lab_orders lo
     INNER JOIN lab_tests lt ON lt.id = lo.test_id
     INNER JOIN patients p ON p.id = lo.patient_id
     INNER JOIN visits v ON v.id = lo.visit_id
     LEFT JOIN users u_ord ON u_ord.id = lo.ordered_by
     LEFT JOIN users u_ent ON u_ent.id = lo.entered_by
     LEFT JOIN users u_ver ON u_ver.id = lo.verified_by
     WHERE lo.id = ?`,
    [id]
  );
  if (!report) return res.status(404).json({ error: 'Lab order not found' });
  res.json({ report });
});

// Printable Imaging Report
router.get('/imaging/orders/:id/report', requireAuth, requirePermission('imaging.order.read', 'visit.read'), async (req, res) => {
  const id = Number(req.params.id);
  const report = await queryOne(
    `SELECT io.*, ic.code AS exam_code, ic.name AS exam_name, ic.modality, ic.body_region,
            p.mrn, p.first_name, p.last_name, p.sex, p.date_of_birth,
            v.visit_number, u_ord.full_name AS ordered_by_name,
            u_perf.full_name AS performed_by_name, u_rep.full_name AS reported_by_name
     FROM imaging_orders io
     INNER JOIN imaging_catalog ic ON ic.id = io.catalog_id
     INNER JOIN patients p ON p.id = io.patient_id
     INNER JOIN visits v ON v.id = io.visit_id
     LEFT JOIN users u_ord ON u_ord.id = io.ordered_by
     LEFT JOIN users u_perf ON u_perf.id = io.performed_by
     LEFT JOIN users u_rep ON u_rep.id = io.reported_by
     WHERE io.id = ?`,
    [id]
  );
  if (!report) return res.status(404).json({ error: 'Imaging order not found' });
  res.json({ report });
});

// ---------------------------------------------------------------------------
// PHARMACY DISPENSING (Batched Query + Multi-Batch FEFO + Partial Dispense)
// ---------------------------------------------------------------------------
router.get('/pharmacy/prescriptions', requireAuth, requirePermission('pharmacy.prescription.read'), async (_req, res) => {
  const prescriptions = await query<Record<string, unknown>>(
    `SELECT pr.*, p.mrn, p.first_name, p.last_name, p.allergies, p.patient_type,
            u.full_name AS doctor_name, i.invoice_number, i.status AS invoice_status,
            v.visit_number, v.workflow_stage, v.status AS visit_status
     FROM prescriptions pr
     INNER JOIN patients p ON p.id = pr.patient_id
     INNER JOIN users u ON u.id = pr.doctor_id
     LEFT JOIN visits v ON v.id = pr.visit_id
     LEFT JOIN invoices i ON i.id = pr.invoice_id
     ORDER BY pr.id DESC LIMIT 60`
  );

  if (prescriptions.length > 0) {
    const rxIds = prescriptions.map((p) => p.id);
    const ph = rxIds.map(() => '?').join(',');
    const allItems = await query<Record<string, unknown>>(
      `SELECT pi.*, m.code, m.generic_name, m.strength, m.form, m.stock_qty, m.unit_price AS catalog_unit_price, m.batch_number, m.expiry_date,
              si.id AS store_item_id
       FROM prescription_items pi
       INNER JOIN medicines m ON m.id = pi.medicine_id
       LEFT JOIN store_items si ON si.medicine_id = m.id
       WHERE pi.prescription_id IN (${ph})`,
      rxIds
    );

    const today = new Date().toISOString().slice(0, 10);
    const itemIds = [...new Set(allItems.map((i) => i.store_item_id).filter(Boolean))];
    const batchesByItem = new Map<number, Array<{ id: number; batch_number: string; expiry_date: string; qty_on_hand: number }>>();
    if (itemIds.length > 0) {
      const bPh = itemIds.map(() => '?').join(',');
      const batches = await query<{ id: number; item_id: number; batch_number: string; expiry_date: string; qty_on_hand: number }>(
        `SELECT id, item_id, batch_number, expiry_date, qty_on_hand
         FROM stock_batches
         WHERE item_id IN (${bPh}) AND location = 'dispensary' AND status = 'active' AND qty_on_hand > 0 AND expiry_date >= ?
         ORDER BY expiry_date ASC, id ASC`,
        [...itemIds, today]
      );
      for (const b of batches) {
        if (!batchesByItem.has(b.item_id)) batchesByItem.set(b.item_id, []);
        batchesByItem.get(b.item_id)!.push({
          id: b.id,
          batch_number: b.batch_number,
          expiry_date: b.expiry_date,
          qty_on_hand: b.qty_on_hand,
        });
      }
    }

    const itemsByRx = new Map<number, Record<string, unknown>[]>();
    for (const it of allItems) {
      const storeItemId = Number(it.store_item_id || 0);
      const batches = storeItemId ? batchesByItem.get(storeItemId) || [] : [];
      it.fefo_batches = batches;
      if (storeItemId) {
        it.stock_qty = batches.reduce((s, b) => s + Number(b.qty_on_hand), 0);
      }
      if (!it.unit_price && it.catalog_unit_price) {
        it.unit_price = Number(it.catalog_unit_price);
      }
      const k = Number(it.prescription_id);
      if (!itemsByRx.has(k)) itemsByRx.set(k, []);
      itemsByRx.get(k)!.push(it);
    }
    for (const pr of prescriptions) {
      pr.items = itemsByRx.get(Number(pr.id)) || [];
    }
  }

  res.json({ prescriptions });
});

router.post('/pharmacy/prescriptions/:id/bill', requireAuth, requirePermission('pharmacy.dispense'), async (req: AuthRequest, res: Response) => {
  const id = Number(req.params.id);
  const { items: requestedItems } = req.body || {};

  const result = await withTransaction(async () => {
    const rx = await queryOne<{ id: number; visit_id: number; patient_id: number; invoice_id: number | null; status: string }>(
      'SELECT * FROM prescriptions WHERE id = ?',
      [id]
    );
    if (!rx) return { ok: false as const, error: 'Prescription not found', httpStatus: 404 };
    if (rx.status !== 'awaiting_stock_check' && rx.invoice_id) {
      return { ok: false as const, error: 'Pharmacy invoice has already been generated for this prescription.', httpStatus: 409 };
    }

    const patient = await queryOne<{ patient_type: string; payer_name: string | null }>(
      'SELECT patient_type, payer_name FROM patients WHERE id = ?',
      [rx.patient_id]
    );
    const items = await query<{
      id: number;
      medicine_id: number;
      code: string;
      generic_name: string;
      strength: string;
      quantity: number;
      selected_qty: number | null;
      unit_price: number;
      med_unit_price: number;
      stock_qty: number;
      store_item_id: number | null;
    }>(
      `SELECT pi.id, pi.medicine_id, m.code, m.generic_name, m.strength, pi.quantity, pi.selected_qty,
              pi.unit_price, m.unit_price AS med_unit_price, m.stock_qty, si.id AS store_item_id
       FROM prescription_items pi
       INNER JOIN medicines m ON m.id = pi.medicine_id
       LEFT JOIN store_items si ON si.medicine_id = m.id
       WHERE pi.prescription_id = ?`,
      [id]
    );
    if (items.length === 0) return { ok: false as const, error: 'Prescription has no items.', httpStatus: 400 };

    const selMap = new Map<number, number>();
    if (Array.isArray(requestedItems)) {
      for (const r of requestedItems) {
        if (r?.item_id && r.selected_qty !== undefined && r.selected_qty !== null) {
          selMap.set(Number(r.item_id), Math.max(0, Math.floor(Number(r.selected_qty))));
        }
      }
    }

    const today = new Date().toISOString().slice(0, 10);
    const billLines: Array<{ code: string; desc: string; qty: number; unitPrice: number; lineTotal: number }> = [];
    let totalSelectedQty = 0;

    for (const item of items) {
      const requestedSel = selMap.has(item.id)
        ? Math.min(Number(item.quantity), selMap.get(item.id)!)
        : Number(item.selected_qty ?? item.quantity);

      let avail = Number(item.stock_qty || 0);
      if (item.store_item_id) {
        const batches = await query<{ qty_on_hand: number }>(
          `SELECT qty_on_hand FROM stock_batches
           WHERE item_id = ? AND location = 'dispensary' AND status = 'active' AND qty_on_hand > 0 AND expiry_date >= ?`,
          [item.store_item_id, today]
        );
        avail = batches.reduce((s, b) => s + Number(b.qty_on_hand), 0);
      }

      if (requestedSel > avail) {
        return {
          ok: false as const,
          error: `Selected quantity (${requestedSel}) exceeds available dispensary FEFO stock (${avail}) for ${item.generic_name}.`,
          httpStatus: 409,
        };
      }

      const externalQty = Math.max(0, Number(item.quantity) - requestedSel);
      const unitPrice = patient?.patient_type === 'exempt' ? 0 : Number(item.unit_price || item.med_unit_price || 0);
      await execute('UPDATE prescription_items SET selected_qty = ?, external_qty = ?, unit_price = ? WHERE id = ?', [
        requestedSel,
        externalQty,
        unitPrice,
        item.id,
      ]);

      totalSelectedQty += requestedSel;
      if (requestedSel > 0) {
        billLines.push({
          code: item.code,
          desc: `${item.generic_name} ${item.strength}`,
          qty: requestedSel,
          unitPrice,
          lineTotal: Number((requestedSel * unitPrice).toFixed(2)),
        });
      }
    }

    if (totalSelectedQty === 0) {
      await execute("UPDATE prescriptions SET status = 'dispensed' WHERE id = ?", [id]);
      await writeAuditLog({
        user: req.user,
        action: 'pharmacy.bill.external_only',
        entityType: 'prescription',
        entityId: id,
        patientId: rx.patient_id,
        after: { status: 'dispensed', reason: 'All items marked for external purchase' },
        req,
      });
      return { ok: true as const, status: 'dispensed', allExternal: true, invoiceNumber: null, visitId: rx.visit_id };
    }

    const subtotal = Number(billLines.reduce((s, l) => s + l.lineTotal, 0).toFixed(2));
    const invNum = await nextSequence('INV');
    const invStatus =
      patient?.patient_type === 'insurance' || patient?.patient_type === 'credit'
        ? 'credit_billed'
        : patient?.patient_type === 'exempt'
          ? 'paid'
          : 'unpaid';

    const invRes = await execute(
      `INSERT INTO invoices (invoice_number, patient_id, visit_id, payer_type, payer_name, subtotal, discount_amount, total_amount, paid_amount, status, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
      [
        invNum,
        rx.patient_id,
        rx.visit_id,
        patient?.patient_type || 'self-pay',
        patient?.payer_name || null,
        subtotal,
        subtotal,
        invStatus === 'paid' ? subtotal : 0,
        invStatus,
        `Pharmacy Rx #${id} (${billLines.length} on-site item${billLines.length > 1 ? 's' : ''})`,
        req.user!.id,
      ]
    );
    for (const line of billLines) {
      await execute(
        'INSERT INTO invoice_items (invoice_id, service_code, description, category, quantity, unit_price, line_total) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [invRes.insertId, line.code, line.desc, 'pharmacy', line.qty, line.unitPrice, line.lineTotal]
      );
    }

    const rxStatus = invStatus === 'paid' || invStatus === 'credit_billed' ? 'paid_ready_to_dispense' : 'pending_payment';
    await execute('UPDATE prescriptions SET invoice_id = ?, status = ? WHERE id = ?', [invRes.insertId, rxStatus, id]);

    await createNotification({
      targetRole: rxStatus === 'pending_payment' ? 'CSH' : 'PHA',
      title: rxStatus === 'pending_payment' ? 'Pharmacy Bill Ready at Cashier' : 'Paid - Ready to Dispense',
      message:
        rxStatus === 'pending_payment'
          ? `Pharmacy invoice ${invNum} ($${subtotal.toFixed(2)}) awaiting payment.`
          : `Prescription #${id} (${invNum}) cleared for dispensing.`,
      severity: 'info',
      entityType: 'prescription',
      entityId: id,
    });

    await writeAuditLog({
      user: req.user,
      action: 'pharmacy.bill.create',
      entityType: 'prescription',
      entityId: id,
      patientId: rx.patient_id,
      after: { invoiceNumber: invNum, subtotal, rxStatus, itemCount: billLines.length },
      req,
    });

    return {
      ok: true as const,
      status: rxStatus,
      invoiceId: invRes.insertId,
      invoiceNumber: invNum,
      invoiceStatus: invStatus,
      totalAmount: subtotal,
      visitId: rx.visit_id,
    };
  });

  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error });
  broadcastClinicEvent('pharmacy:updated', { prescriptionId: id, visitId: result.visitId });
  broadcastClinicEvent('visit:updated', { visitId: result.visitId });
  res.status(201).json(result);
});

router.post('/pharmacy/dispense/:id', requireAuth, requirePermission('pharmacy.dispense'), async (req: AuthRequest, res: Response) => {
  const id = Number(req.params.id);
  const { overrideAllergyReason, bypass_payment_gate, complete_visit, items: requestedItems } = req.body || {};

  const result = await withTransaction(async () => {
    const rx = await queryOne<{ id: number; visit_id: number; patient_id: number; invoice_id: number | null; status: string }>(
      'SELECT * FROM prescriptions WHERE id = ?',
      [id]
    );
    if (!rx) return { ok: false as const, error: 'Prescription not found', httpStatus: 404 };
    if (rx.status === 'dispensed') return { ok: false as const, error: 'Prescription already fully dispensed.', httpStatus: 409 };
    if (rx.status === 'awaiting_stock_check') {
      return {
        ok: false as const,
        error: 'Stock Check Required: Confirm available quantities and generate the Pharmacy Bill before dispensing.',
        httpStatus: 409,
      };
    }

    const visit = await queryOne<{ triage_priority: string; diagnosis_text: string | null; status: string; appointment_id: number | null }>(
      'SELECT triage_priority, diagnosis_text, status, appointment_id FROM visits WHERE id = ?',
      [rx.visit_id]
    );

    if (rx.invoice_id) {
      const inv = await queryOne<{ status: string; payer_type: string }>('SELECT status, payer_type FROM invoices WHERE id = ?', [
        rx.invoice_id,
      ]);
      if (inv && inv.payer_type === 'self-pay' && inv.status !== 'paid') {
        const bypassCheck = canBypassPaymentGate(
          req.user!,
          visit?.triage_priority === 'emergency',
          bypass_payment_gate,
          req.body?.bypass_reason
        );
        if (bypassCheck.allowed) {
          await writeAuditLog({
            user: req.user,
            action: 'payment.gate.bypass',
            entityType: 'prescription',
            entityId: id,
            patientId: rx.patient_id,
            reason: bypassCheck.reasonText,
            req,
          });
        } else {
          return {
            ok: false as const,
            error: 'Payment Gate: Self-pay prescription invoice must be paid at Cashier before dispensing.',
            httpStatus: 402,
          };
        }
      }
    }

    const patient = await queryOne<{ allergies: string | null }>('SELECT allergies FROM patients WHERE id = ?', [rx.patient_id]);
    const items = await query<{
      id: number;
      medicine_id: number;
      quantity: number;
      selected_qty: number | null;
      dispensed_qty: number;
      generic_name: string;
      stock_qty: number;
      store_item_id: number | null;
    }>(
      `SELECT pi.id, pi.medicine_id, pi.quantity, pi.selected_qty, pi.dispensed_qty, m.generic_name, m.stock_qty, si.id AS store_item_id
       FROM prescription_items pi
       INNER JOIN medicines m ON m.id = pi.medicine_id
       LEFT JOIN store_items si ON si.medicine_id = m.id
       WHERE pi.prescription_id = ?`,
      [id]
    );

    const requestedMap = new Map<number, number>();
    if (Array.isArray(requestedItems)) {
      for (const r of requestedItems) {
        if (r?.item_id && Number(r.dispense_qty) >= 0) {
          requestedMap.set(Number(r.item_id), Number(r.dispense_qty));
        }
      }
    }

    const today = new Date().toISOString().slice(0, 10);
    const batchAllocations: Array<{ medicine: string; qty: number; batches: Array<{ batch: string; expiry: string; taken: number }> }> = [];

    for (const item of items) {
      const targetOnSiteQty = item.selected_qty !== null && item.selected_qty !== undefined ? Number(item.selected_qty) : Number(item.quantity);
      const remainingToDispense = Math.max(0, targetOnSiteQty - Number(item.dispensed_qty || 0));
      const qtyNow = requestedMap.has(item.id)
        ? Math.min(remainingToDispense, Math.max(0, requestedMap.get(item.id)!))
        : remainingToDispense;

      if (qtyNow <= 0) continue;

      const allergyConflict = findAllergyConflicts(patient?.allergies, item.generic_name);
      if (allergyConflict && String(overrideAllergyReason || '').trim().length < 5) {
        return {
          ok: false as const,
          error: `Allergy Safety Block: Patient has recorded allergy (${patient?.allergies}) conflicting with ${item.generic_name}. Provide a clinical override reason (min 5 chars) to dispense.`,
          httpStatus: 422,
        };
      }

      if (item.store_item_id) {
        const activeBatches = await query<{ id: number; batch_number: string; expiry_date: string; qty_on_hand: number }>(
          `SELECT id, batch_number, expiry_date, qty_on_hand
           FROM stock_batches
           WHERE item_id = ? AND location = 'dispensary' AND status = 'active' AND qty_on_hand > 0 AND expiry_date >= ?
           ORDER BY expiry_date ASC, id ASC`,
          [item.store_item_id, today]
        );
        const totalAvail = activeBatches.reduce((s, b) => s + Number(b.qty_on_hand), 0);
        if (totalAvail < qtyNow) {
          return {
            ok: false as const,
            error: `Insufficient non-expired dispensary stock for ${item.generic_name} (available: ${totalAvail}, requested: ${qtyNow}). Request restock from Store or use partial dispense.`,
            httpStatus: 409,
          };
        }

        let need = qtyNow;
        const usedBatches: Array<{ batch: string; expiry: string; taken: number }> = [];
        for (const b of activeBatches) {
          if (need <= 0) break;
          const take = Math.min(need, Number(b.qty_on_hand));
          const left = Number(b.qty_on_hand) - take;
          await execute("UPDATE stock_batches SET qty_on_hand = ?, status = CASE WHEN ? <= 0 THEN 'depleted' ELSE 'active' END WHERE id = ?", [
            left,
            left,
            b.id,
          ]);
          usedBatches.push({ batch: b.batch_number, expiry: b.expiry_date, taken: take });
          need -= take;
        }
        await syncMedicineFromBatches(item.medicine_id);
        batchAllocations.push({ medicine: item.generic_name, qty: qtyNow, batches: usedBatches });
      } else {
        const stockRes = await execute('UPDATE medicines SET stock_qty = stock_qty - ? WHERE id = ? AND stock_qty >= ?', [
          qtyNow,
          item.medicine_id,
          qtyNow,
        ]);
        if (stockRes.affectedRows === 0) {
          return {
            ok: false as const,
            error: `Insufficient dispensary stock for ${item.generic_name} (requested: ${qtyNow}).`,
            httpStatus: 409,
          };
        }
        batchAllocations.push({ medicine: item.generic_name, qty: qtyNow, batches: [] });
      }

      await execute('UPDATE prescription_items SET dispensed_qty = dispensed_qty + ? WHERE id = ?', [qtyNow, item.id]);
    }

    if (batchAllocations.length === 0) {
      return { ok: false as const, error: 'Specify at least 1 unit to dispense.', httpStatus: 400 };
    }

    const updatedItems = await query<{ quantity: number; selected_qty: number | null; dispensed_qty: number }>(
      'SELECT quantity, selected_qty, dispensed_qty FROM prescription_items WHERE prescription_id = ?',
      [id]
    );
    const allComplete = updatedItems.every((ui) => {
      const target = ui.selected_qty !== null && ui.selected_qty !== undefined ? Number(ui.selected_qty) : Number(ui.quantity);
      return Number(ui.dispensed_qty) >= target;
    });
    const nextStatus = allComplete ? 'dispensed' : 'partial';

    await execute("UPDATE prescriptions SET status = ?, dispensed_at = datetime('now'), dispensed_by = ? WHERE id = ?", [
      nextStatus,
      req.user!.id,
      id,
    ]).catch(async () => {
      await execute('UPDATE prescriptions SET status = ?, dispensed_at = NOW(), dispensed_by = ? WHERE id = ?', [
        nextStatus,
        req.user!.id,
        id,
      ]);
    });

    let visitCompleted = false;
    if (complete_visit && nextStatus === 'dispensed' && visit?.status !== 'closed') {
      await execute("UPDATE visits SET status = 'closed', workflow_stage = 'completed', closed_at = datetime('now'), closed_by = ? WHERE id = ?", [
        req.user!.id,
        rx.visit_id,
      ]).catch(async () => {
        await execute("UPDATE visits SET status = 'closed', workflow_stage = 'completed', closed_at = NOW(), closed_by = ? WHERE id = ?", [
          req.user!.id,
          rx.visit_id,
        ]);
      });
      await execute("UPDATE queue_tickets SET status = 'completed' WHERE visit_id = ?", [rx.visit_id]);
      if (visit?.appointment_id) {
        await execute("UPDATE appointments SET status = 'completed' WHERE id = ? AND status != 'cancelled'", [visit.appointment_id]);
      }
      await writeAuditLog({
        user: req.user,
        action: 'visit.close',
        entityType: 'visit',
        entityId: rx.visit_id,
        patientId: rx.patient_id,
        after: { closedByPharmacy: true, prescriptionId: id },
        req,
      });
      visitCompleted = true;
    }

    await writeAuditLog({
      user: req.user,
      action: allComplete ? 'pharmacy.dispense' : 'pharmacy.dispense.partial',
      entityType: 'prescription',
      entityId: id,
      patientId: rx.patient_id,
      after: { status: nextStatus, visitCompleted, fefoAllocations: batchAllocations },
      reason: overrideAllergyReason || null,
      req,
    });

    return { ok: true as const, status: nextStatus, visitCompleted, visitId: rx.visit_id, fefoAllocations: batchAllocations };
  });

  if (!result.ok) {
    return res.status(result.httpStatus).json({ error: result.error });
  }
  broadcastClinicEvent('pharmacy:updated', { prescriptionId: id, visitId: result.visitId });
  broadcastClinicEvent('visit:updated', { visitId: result.visitId });
  if (result.visitCompleted) {
    broadcastClinicEvent('queue:updated', { visitId: result.visitId });
  }
  res.json(result);
});

// ---------------------------------------------------------------------------
// STORE & FEFO INVENTORY (Main Store, GRN, Requisitions, Expiry Quarantine)
// ---------------------------------------------------------------------------
router.get('/store/overview', requireAuth, requirePermission('store.item.read'), async (_req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const in30 = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const in90 = new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);

  const [items, batches, grns, requisitions, reqItems] = await Promise.all([
    query<Record<string, unknown>>('SELECT * FROM store_items WHERE active = 1 ORDER BY category, name'),
    query<Record<string, unknown>>(
      `SELECT sb.*, si.code AS item_code, si.name AS item_name, si.unit, si.category
       FROM stock_batches sb
       INNER JOIN store_items si ON si.id = sb.item_id
       WHERE sb.qty_on_hand > 0 OR sb.status = 'blocked_expired'
       ORDER BY sb.expiry_date ASC, sb.id ASC`
    ),
    query<Record<string, unknown>>(
      `SELECT gr.*, u.full_name AS received_by_name
       FROM goods_receipts gr
       LEFT JOIN users u ON u.id = gr.received_by
       ORDER BY gr.id DESC LIMIT 30`
    ),
    query<Record<string, unknown>>(
      `SELECT sr.*, u1.full_name AS requested_by_name, u2.full_name AS issued_by_name
       FROM stock_requisitions sr
       LEFT JOIN users u1 ON u1.id = sr.requested_by
       LEFT JOIN users u2 ON u2.id = sr.issued_by
       ORDER BY sr.id DESC LIMIT 40`
    ),
    query<Record<string, unknown>>(
      `SELECT sri.*, si.code AS item_code, si.name AS item_name, si.unit
       FROM stock_requisition_items sri
       INNER JOIN store_items si ON si.id = sri.item_id`
    ),
  ]);

  const batchSummaryByItem = new Map<number, { main: number; disp: number; lab: number; earliest: string | null }>();
  for (const b of batches) {
    if (b.status !== 'active' || Number(b.qty_on_hand) <= 0) continue;
    const itemId = Number(b.item_id);
    if (!batchSummaryByItem.has(itemId)) {
      batchSummaryByItem.set(itemId, { main: 0, disp: 0, lab: 0, earliest: null });
    }
    const entry = batchSummaryByItem.get(itemId)!;
    if (b.location === 'main_store') entry.main += Number(b.qty_on_hand);
    if (b.location === 'dispensary') entry.disp += Number(b.qty_on_hand);
    if (b.location === 'lab') entry.lab += Number(b.qty_on_hand);
    const exp = String(b.expiry_date);
    if (!entry.earliest || exp < entry.earliest) entry.earliest = exp;
  }

  for (const it of items) {
    const s = batchSummaryByItem.get(Number(it.id)) || { main: 0, disp: 0, lab: 0, earliest: null };
    it.main_store_qty = s.main;
    it.dispensary_qty = s.disp;
    it.lab_qty = s.lab;
    it.total_qty = s.main + s.disp + s.lab;
    it.earliest_expiry = s.earliest;
  }

  const reqItemMap = new Map<number, Record<string, unknown>[]>();
  for (const ri of reqItems) {
    const k = Number(ri.requisition_id);
    if (!reqItemMap.has(k)) reqItemMap.set(k, []);
    reqItemMap.get(k)!.push(ri);
  }
  for (const reqRow of requisitions) {
    reqRow.items = reqItemMap.get(Number(reqRow.id)) || [];
  }

  const expiryAlerts = batches.filter(
    (b) => b.status === 'active' && Number(b.qty_on_hand) > 0 && String(b.expiry_date) <= in90
  ).map((b) => ({
    ...b,
    alert_band: String(b.expiry_date) < today ? 'expired' : String(b.expiry_date) <= in30 ? 'critical_30d' : 'warning_90d',
  }));

  res.json({ items, batches, grns, requisitions, expiryAlerts });
});

router.post('/store/grn', requireAuth, requirePermission('store.grn.create'), async (req: AuthRequest, res: Response) => {
  const { supplier_name, invoice_ref, notes, item_id, batch_number, expiry_date, quantity, unit_cost } = req.body || {};
  const qty = Number(quantity || 0);
  const cost = Number(unit_cost || 0);
  if (!supplier_name?.trim() || !item_id || !batch_number?.trim() || !expiry_date || qty <= 0) {
    return res.status(400).json({ error: 'Supplier, item, batch number, expiry date, and positive quantity are required.' });
  }

  const result = await withTransaction(async () => {
    const item = await queryOne<{ id: number; code: string; name: string }>('SELECT id, code, name FROM store_items WHERE id = ?', [
      Number(item_id),
    ]);
    if (!item) return { ok: false as const, error: 'Store item not found', httpStatus: 404 };

    const grnNumber = await nextSequence('GRN');
    const totalCost = Number((qty * cost).toFixed(2));
    const grnRes = await execute(
      'INSERT INTO goods_receipts (grn_number, supplier_name, invoice_ref, total_cost, notes, received_by) VALUES (?, ?, ?, ?, ?, ?)',
      [grnNumber, supplier_name.trim(), invoice_ref || null, totalCost, notes || null, req.user!.id]
    );
    await execute(
      'INSERT INTO grn_items (grn_id, item_id, batch_number, expiry_date, quantity, unit_cost) VALUES (?, ?, ?, ?, ?, ?)',
      [grnRes.insertId, item.id, batch_number.trim(), expiry_date, qty, cost]
    );
    await execute(
      "INSERT INTO stock_batches (item_id, location, batch_number, expiry_date, qty_on_hand, unit_cost, status) VALUES (?, 'main_store', ?, ?, ?, ?, 'active')",
      [item.id, batch_number.trim(), expiry_date, qty, cost]
    );

    if (totalCost > 0) {
      const billNumber = await nextSequence('AP');
      const todayStr = new Date().toISOString().slice(0, 10);
      const dueStr = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
      await execute(
        `INSERT INTO supplier_bills (bill_number, grn_id, supplier_name, invoice_ref, bill_date, due_date, total_amount, paid_amount, status, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'open', ?)`,
        [billNumber, grnRes.insertId, supplier_name.trim(), invoice_ref || null, todayStr, dueStr, totalCost, `Auto-posted from ${grnNumber}`]
      );
      await postJournalEntry({
        sourceType: 'grn',
        sourceId: grnRes.insertId,
        description: `Inventory receipt ${grnNumber} (${supplier_name.trim()})`,
        postedBy: req.user!.id,
        lines: [
          { accountCode: '1200', debit: totalCost, memo: `${item.code} x ${qty}` },
          { accountCode: '2100', credit: totalCost, memo: `${billNumber} payable to ${supplier_name.trim()}` },
        ],
      });
    }

    await writeAuditLog({
      user: req.user,
      action: 'store.grn.create',
      entityType: 'goods_receipt',
      entityId: grnRes.insertId,
      after: { grnNumber, supplier_name, item: item.code, batch_number, expiry_date, qty, totalCost },
      req,
    });

    return { ok: true as const, id: grnRes.insertId, grnNumber };
  });

  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error });
  res.status(201).json(result);
});

router.post('/store/requisitions', requireAuth, requirePermission('store.requisition.create'), async (req: AuthRequest, res: Response) => {
  const { to_location = 'dispensary', item_id, requested_qty, notes } = req.body || {};
  const qty = Number(requested_qty || 0);
  if (!['dispensary', 'lab', 'ward'].includes(to_location) || !item_id || qty <= 0) {
    return res.status(400).json({ error: 'Valid destination, store item, and positive quantity are required.' });
  }

  const result = await withTransaction(async () => {
    const item = await queryOne<{ id: number; name: string }>('SELECT id, name FROM store_items WHERE id = ?', [Number(item_id)]);
    if (!item) return { ok: false as const, error: 'Store item not found', httpStatus: 404 };

    const reqNumber = await nextSequence('REQ');
    const reqRes = await execute(
      "INSERT INTO stock_requisitions (req_number, from_location, to_location, status, notes, requested_by) VALUES (?, 'main_store', ?, 'pending', ?, ?)",
      [reqNumber, to_location, notes || null, req.user!.id]
    );
    await execute(
      'INSERT INTO stock_requisition_items (requisition_id, item_id, requested_qty, issued_qty) VALUES (?, ?, ?, 0)',
      [reqRes.insertId, item.id, qty]
    );

    await createNotification({
      targetRole: 'STO',
      title: 'New Store Requisition',
      message: `${reqNumber}: ${to_location} requested ${qty} × ${item.name}.`,
      severity: 'info',
      entityType: 'stock_requisition',
      entityId: reqRes.insertId,
    });

    await writeAuditLog({
      user: req.user,
      action: 'store.requisition.create',
      entityType: 'stock_requisition',
      entityId: reqRes.insertId,
      after: { reqNumber, to_location, item: item.name, qty },
      req,
    });

    return { ok: true as const, id: reqRes.insertId, reqNumber };
  });

  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error });
  res.status(201).json(result);
});

router.post('/store/requisitions/:id/issue', requireAuth, requirePermission('store.requisition.issue'), async (req: AuthRequest, res: Response) => {
  const reqId = Number(req.params.id);
  const today = new Date().toISOString().slice(0, 10);

  const result = await withTransaction(async () => {
    const reqRow = await queryOne<{ id: number; req_number: string; to_location: string; status: string }>(
      'SELECT * FROM stock_requisitions WHERE id = ?',
      [reqId]
    );
    if (!reqRow) return { ok: false as const, error: 'Requisition not found', httpStatus: 404 };
    if (reqRow.status !== 'pending') return { ok: false as const, error: 'Requisition already processed.', httpStatus: 409 };

    const reqItems = await query<{ id: number; item_id: number; requested_qty: number; medicine_id: number | null; item_name: string }>(
      `SELECT sri.*, si.medicine_id, si.name AS item_name
       FROM stock_requisition_items sri
       INNER JOIN store_items si ON si.id = sri.item_id
       WHERE sri.requisition_id = ?`,
      [reqId]
    );

    const fefoTransfers: Array<{ item: string; issued: number; batches: string[] }> = [];
    for (const ri of reqItems) {
      const batches = await query<{ id: number; batch_number: string; expiry_date: string; qty_on_hand: number; unit_cost: number }>(
        `SELECT id, batch_number, expiry_date, qty_on_hand, unit_cost
         FROM stock_batches
         WHERE item_id = ? AND location = 'main_store' AND status = 'active' AND qty_on_hand > 0 AND expiry_date >= ?
         ORDER BY expiry_date ASC, id ASC`,
        [ri.item_id, today]
      );
      const avail = batches.reduce((s, b) => s + Number(b.qty_on_hand), 0);
      if (avail < ri.requested_qty) {
        return {
          ok: false as const,
          error: `Insufficient non-expired Main Store stock for ${ri.item_name} (available: ${avail}, requested: ${ri.requested_qty}).`,
          httpStatus: 409,
        };
      }

      let need = ri.requested_qty;
      const movedBatches: string[] = [];
      for (const b of batches) {
        if (need <= 0) break;
        const take = Math.min(need, Number(b.qty_on_hand));
        const left = Number(b.qty_on_hand) - take;
        await execute("UPDATE stock_batches SET qty_on_hand = ?, status = CASE WHEN ? <= 0 THEN 'depleted' ELSE 'active' END WHERE id = ?", [
          left,
          left,
          b.id,
        ]);
        await execute(
          "INSERT INTO stock_batches (item_id, location, batch_number, expiry_date, qty_on_hand, unit_cost, status) VALUES (?, ?, ?, ?, ?, ?, 'active')",
          [ri.item_id, reqRow.to_location, b.batch_number, b.expiry_date, take, b.unit_cost]
        );
        movedBatches.push(`${b.batch_number} (${take})`);
        need -= take;
      }

      await execute('UPDATE stock_requisition_items SET issued_qty = ? WHERE id = ?', [ri.requested_qty, ri.id]);
      if (ri.medicine_id && reqRow.to_location === 'dispensary') {
        await syncMedicineFromBatches(ri.medicine_id);
      }
      fefoTransfers.push({ item: ri.item_name, issued: ri.requested_qty, batches: movedBatches });
    }

    await execute("UPDATE stock_requisitions SET status = 'issued', issued_by = ?, issued_at = datetime('now') WHERE id = ?", [
      req.user!.id,
      reqId,
    ]).catch(async () => {
      await execute("UPDATE stock_requisitions SET status = 'issued', issued_by = ?, issued_at = NOW() WHERE id = ?", [
        req.user!.id,
        reqId,
      ]);
    });

    await createNotification({
      targetRole: reqRow.to_location === 'lab' ? 'LAB' : reqRow.to_location === 'ward' ? 'WRD' : 'PHA',
      title: 'Stock Issued from Main Store',
      message: `${reqRow.req_number} issued to ${reqRow.to_location} via FEFO.`,
      severity: 'info',
      entityType: 'stock_requisition',
      entityId: reqId,
    });

    await writeAuditLog({
      user: req.user,
      action: 'store.requisition.issue',
      entityType: 'stock_requisition',
      entityId: reqId,
      after: { reqNumber: reqRow.req_number, fefoTransfers },
      req,
    });

    return { ok: true as const, fefoTransfers };
  });

  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error });
  res.json(result);
});

router.post('/store/batches/:id/block', requireAuth, requirePermission('store.expiry.manage'), async (req: AuthRequest, res: Response) => {
  const batchId = Number(req.params.id);
  const { reason } = req.body || {};
  if (!reason?.trim()) {
    return res.status(400).json({ error: 'Mandatory quarantine/block reason is required.' });
  }

  const result = await withTransaction(async () => {
    const batch = await queryOne<{ id: number; item_id: number; batch_number: string; location: string; qty_on_hand: number; status: string }>(
      'SELECT * FROM stock_batches WHERE id = ?',
      [batchId]
    );
    if (!batch) return { ok: false as const, error: 'Stock batch not found', httpStatus: 404 };

    await execute("UPDATE stock_batches SET status = 'blocked_expired', block_reason = ? WHERE id = ?", [
      reason.trim(),
      batchId,
    ]);

    const item = await queryOne<{ medicine_id: number | null }>('SELECT medicine_id FROM store_items WHERE id = ?', [batch.item_id]);
    if (item?.medicine_id && batch.location === 'dispensary') {
      await syncMedicineFromBatches(item.medicine_id);
    }

    await writeAuditLog({
      user: req.user,
      action: 'store.batch.block',
      entityType: 'stock_batch',
      entityId: batchId,
      before: { status: batch.status, qty_on_hand: batch.qty_on_hand },
      after: { status: 'blocked_expired', batch_number: batch.batch_number },
      reason: reason.trim(),
      req,
    });
    return { ok: true as const };
  });

  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error });
  res.json(result);
});

// ---------------------------------------------------------------------------
// INPATIENT (IPD) WARDS, BED BOARD, ADMISSIONS, MAR, BED BILLING & DEPOSITS
// ---------------------------------------------------------------------------
router.get('/ipd/overview', requireAuth, requirePermission('ipd.admission.read'), async (_req, res) => {
  const [wards, beds, admissions, mar, deposits, admInvoices] = await Promise.all([
    query('SELECT * FROM wards ORDER BY id ASC'),
    query(
      `SELECT b.*, w.code AS ward_code, w.name AS ward_name, w.daily_tariff,
              a.id AS admission_id, a.admission_number, p.mrn, p.first_name, p.last_name
       FROM beds b
       INNER JOIN wards w ON w.id = b.ward_id
       LEFT JOIN admissions a ON a.bed_id = b.id AND a.status IN ('admitted','discharge_ordered','cleared')
       LEFT JOIN patients p ON p.id = a.patient_id
       ORDER BY w.id ASC, b.bed_number ASC`
    ),
    query<Record<string, unknown>>(
      `SELECT a.*, p.mrn, p.first_name, p.last_name, p.sex, p.allergies, p.patient_type,
              w.name AS ward_name, w.daily_tariff, b.bed_number, u.full_name AS doctor_name
       FROM admissions a
       INNER JOIN patients p ON p.id = a.patient_id
       INNER JOIN wards w ON w.id = a.ward_id
       LEFT JOIN beds b ON b.id = a.bed_id
       INNER JOIN users u ON u.id = a.admitting_doctor_id
       ORDER BY a.id DESC LIMIT 30`
    ),
    query(
      `SELECT ma.*, p.mrn, p.first_name, p.last_name, a.admission_number, b.bed_number
       FROM medication_administrations ma
       INNER JOIN admissions a ON a.id = ma.admission_id
       INNER JOIN patients p ON p.id = ma.patient_id
       LEFT JOIN beds b ON b.id = a.bed_id
       WHERE a.status IN ('admitted','discharge_ordered')
       ORDER BY ma.id DESC LIMIT 40`
    ),
    query<{ patient_id: number; remaining_amount: number }>(
      "SELECT patient_id, remaining_amount FROM patient_deposits WHERE status = 'active' AND remaining_amount > 0"
    ),
    query<{ patient_id: number; total_amount: number; paid_amount: number; status: string }>(
      "SELECT patient_id, total_amount, paid_amount, status FROM invoices WHERE status IN ('unpaid','partial')"
    ),
  ]);

  const depByPatient = new Map<number, number>();
  for (const d of deposits) {
    depByPatient.set(d.patient_id, (depByPatient.get(d.patient_id) || 0) + Number(d.remaining_amount));
  }
  const unpaidByPatient = new Map<number, number>();
  for (const inv of admInvoices) {
    const bal = Math.max(0, Number(inv.total_amount) - Number(inv.paid_amount));
    unpaidByPatient.set(inv.patient_id, (unpaidByPatient.get(inv.patient_id) || 0) + bal);
  }

  const nowMs = Date.now();
  for (const adm of admissions) {
    const startMs = new Date(String(adm.admitted_at)).getTime();
    const endMs = adm.discharged_at ? new Date(String(adm.discharged_at)).getTime() : nowMs;
    const daysStayed = Math.max(1, Math.ceil((endMs - startMs) / 86400000));
    const billedDays = Number(adm.bed_days_billed || 0);
    const unbilledDays = Math.max(0, daysStayed - billedDays);
    adm.days_stayed = daysStayed;
    adm.unbilled_days = unbilledDays;
    adm.unbilled_bed_estimate = Number((unbilledDays * Number(adm.daily_tariff || 0)).toFixed(2));
    adm.deposit_balance = Number((depByPatient.get(Number(adm.patient_id)) || 0).toFixed(2));
    adm.outstanding_invoices = Number((unpaidByPatient.get(Number(adm.patient_id)) || 0).toFixed(2));
  }

  res.json({ wards, beds, admissions, mar });
});

router.get('/ipd/admissions/:id/statement', requireAuth, requirePermission('ipd.admission.read'), async (req, res) => {
  const admId = Number(req.params.id);
  const admission = await queryOne<Record<string, unknown>>(
    `SELECT a.*, p.mrn, p.first_name, p.last_name, p.sex, p.date_of_birth, p.phone, p.patient_type, p.payer_name,
            w.name AS ward_name, w.daily_tariff, b.bed_number, u.full_name AS doctor_name
     FROM admissions a
     INNER JOIN patients p ON p.id = a.patient_id
     INNER JOIN wards w ON w.id = a.ward_id
     LEFT JOIN beds b ON b.id = a.bed_id
     INNER JOIN users u ON u.id = a.admitting_doctor_id
     WHERE a.id = ?`,
    [admId]
  );
  if (!admission) return res.status(404).json({ error: 'Admission not found' });

  const [invoices, deposits, marHistory] = await Promise.all([
    query<Record<string, unknown>>('SELECT * FROM invoices WHERE patient_id = ? ORDER BY id DESC LIMIT 20', [admission.patient_id]),
    query<Record<string, unknown>>('SELECT * FROM patient_deposits WHERE patient_id = ? ORDER BY id DESC', [admission.patient_id]),
    query('SELECT * FROM medication_administrations WHERE admission_id = ? ORDER BY id ASC', [admId]),
  ]);

  if (invoices.length > 0) {
    const invIds = invoices.map((i) => i.id);
    const ph = invIds.map(() => '?').join(',');
    const items = await query<Record<string, unknown>>(`SELECT * FROM invoice_items WHERE invoice_id IN (${ph})`, invIds);
    const byInv = new Map<number, Record<string, unknown>[]>();
    for (const it of items) {
      const k = Number(it.invoice_id);
      if (!byInv.has(k)) byInv.set(k, []);
      byInv.get(k)!.push(it);
    }
    for (const inv of invoices) inv.items = byInv.get(Number(inv.id)) || [];
  }

  res.json({ admission, invoices, deposits, marHistory });
});

router.post('/ipd/admissions/:id/accrue-bed', requireAuth, requirePermission('ipd.bed.bill'), async (req: AuthRequest, res: Response) => {
  const admId = Number(req.params.id);
  const requestedDays = req.body?.days ? Number(req.body.days) : null;

  const result = await withTransaction(async () => {
    const adm = await queryOne<{
      id: number;
      admission_number: string;
      patient_id: number;
      visit_id: number | null;
      bed_days_billed: number;
      admitted_at: string;
      daily_tariff: number;
      ward_name: string;
      patient_type: string;
      payer_name: string | null;
    }>(
      `SELECT a.*, w.daily_tariff, w.name AS ward_name, p.patient_type, p.payer_name
       FROM admissions a
       INNER JOIN wards w ON w.id = a.ward_id
       INNER JOIN patients p ON p.id = a.patient_id
       WHERE a.id = ?`,
      [admId]
    );
    if (!adm) return { ok: false as const, error: 'Admission not found', httpStatus: 404 };

    const daysStayed = Math.max(1, Math.ceil((Date.now() - new Date(adm.admitted_at).getTime()) / 86400000));
    const defaultUnbilled = Math.max(1, daysStayed - Number(adm.bed_days_billed || 0));
    const daysToBill = requestedDays && requestedDays > 0 ? requestedDays : defaultUnbilled;

    const total = adm.patient_type === 'exempt' ? 0 : Number((daysToBill * Number(adm.daily_tariff)).toFixed(2));
    const invNum = await nextSequence('INV');
    const baseStatus =
      adm.patient_type === 'insurance' || adm.patient_type === 'credit'
        ? 'credit_billed'
        : adm.patient_type === 'exempt'
          ? 'paid'
          : 'unpaid';

    const invRes = await execute(
      `INSERT INTO invoices (invoice_number, patient_id, visit_id, payer_type, payer_name, subtotal, discount_amount, total_amount, paid_amount, status, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
      [
        invNum,
        adm.patient_id,
        adm.visit_id,
        adm.patient_type,
        adm.payer_name,
        total,
        total,
        baseStatus === 'paid' ? total : 0,
        baseStatus,
        `Inpatient bed tariff (${adm.admission_number})`,
        req.user!.id,
      ]
    );
    await execute(
      "INSERT INTO invoice_items (invoice_id, service_code, description, category, quantity, unit_price, line_total) VALUES (?, 'IPD-BED', ?, 'bed', ?, ?, ?)",
      [invRes.insertId, `${adm.ward_name} Bed Stay (${daysToBill} day${daysToBill > 1 ? 's' : ''})`, daysToBill, adm.daily_tariff, total]
    );

    // Auto-apply active patient advance deposits if self-pay
    let depositApplied = 0;
    if (baseStatus === 'unpaid' && total > 0) {
      const activeDeps = await query<{ id: number; remaining_amount: number }>(
        "SELECT id, remaining_amount FROM patient_deposits WHERE patient_id = ? AND status = 'active' AND remaining_amount > 0 ORDER BY id ASC",
        [adm.patient_id]
      );
      let remDue = total;
      for (const dep of activeDeps) {
        if (remDue <= 0) break;
        const take = Math.min(remDue, Number(dep.remaining_amount));
        const depLeft = Number((Number(dep.remaining_amount) - take).toFixed(2));
        await execute("UPDATE patient_deposits SET remaining_amount = ?, status = CASE WHEN ? <= 0 THEN 'applied' ELSE 'active' END WHERE id = ?", [
          depLeft,
          depLeft,
          dep.id,
        ]);
        depositApplied += take;
        remDue = Number((remDue - take).toFixed(2));
      }
      if (depositApplied > 0) {
        const finalStatus = depositApplied >= total - 0.01 ? 'paid' : 'partial';
        await execute('UPDATE invoices SET paid_amount = ?, status = ? WHERE id = ?', [
          Number(depositApplied.toFixed(2)),
          finalStatus,
          invRes.insertId,
        ]);
      }
    }

    if (total > 0) {
      await postJournalEntry({
        sourceType: 'ipd_bed',
        sourceId: invRes.insertId,
        description: `Inpatient bed charge ${adm.admission_number} (${daysToBill}d)`,
        postedBy: req.user!.id,
        lines: [
          { accountCode: '1100', debit: total, memo: invNum },
          { accountCode: '4040', credit: total, memo: `${adm.ward_name} tariff` },
        ],
      });
      if (depositApplied > 0) {
        await postJournalEntry({
          sourceType: 'deposit_apply',
          sourceId: invRes.insertId,
          description: `Deposit auto-applied to ${invNum}`,
          postedBy: req.user!.id,
          lines: [
            { accountCode: '2010', debit: depositApplied, memo: invNum },
            { accountCode: '1100', credit: depositApplied, memo: 'Receivable offset' },
          ],
        });
      }
    }

    await execute(
      "UPDATE admissions SET bed_days_billed = bed_days_billed + ?, last_bed_billed_at = datetime('now') WHERE id = ?",
      [daysToBill, admId]
    ).catch(async () => {
      await execute('UPDATE admissions SET bed_days_billed = bed_days_billed + ?, last_bed_billed_at = NOW() WHERE id = ?', [
        daysToBill,
        admId,
      ]);
    });

    await writeAuditLog({
      user: req.user,
      action: 'ipd.bed.bill',
      entityType: 'admission',
      entityId: admId,
      patientId: adm.patient_id,
      after: { invoiceNumber: invNum, daysToBill, total, depositApplied },
      req,
    });

    return { ok: true as const, invoiceNumber: invNum, daysToBill, total, depositApplied };
  });

  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error });
  res.status(201).json(result);
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
  const { bed_id, transfer_ward } = req.body || {};
  if (!bed_id) return res.status(400).json({ error: 'bed_id is required' });

  const result = await withTransaction(async () => {
    const adm = await queryOne<{ id: number; patient_id: number; ward_id: number; bed_id: number | null; status: string }>(
      'SELECT * FROM admissions WHERE id = ?',
      [admId]
    );
    const bed = await queryOne<{ id: number; ward_id: number; bed_number: string; status: string }>('SELECT * FROM beds WHERE id = ?', [bed_id]);
    if (!adm || !bed) return { ok: false as const, error: 'Admission or bed not found', httpStatus: 404 };
    if (adm.status === 'discharged') {
      return { ok: false as const, error: 'Cannot assign a bed to a discharged admission.', httpStatus: 409 };
    }
    if (bed.ward_id !== adm.ward_id && !transfer_ward) {
      return { ok: false as const, error: `Bed ${bed.bed_number} belongs to a different ward than the admission.`, httpStatus: 409 };
    }
    if (bed.status !== 'vacant' && bed.status !== 'reserved') {
      return { ok: false as const, error: `Bed ${bed.bed_number} is currently ${bed.status}.`, httpStatus: 409 };
    }

    if (adm.bed_id) {
      await execute("UPDATE beds SET status = 'cleaning' WHERE id = ?", [adm.bed_id]);
    }
    await execute("UPDATE beds SET status = 'occupied' WHERE id = ?", [bed.id]);
    await execute("UPDATE admissions SET bed_id = ?, ward_id = ?, status = 'admitted' WHERE id = ?", [bed.id, bed.ward_id, admId]);

    await writeAuditLog({
      user: req.user,
      action: 'ipd.bed.assign',
      entityType: 'admission',
      entityId: admId,
      patientId: adm.patient_id,
      after: { bed_number: bed.bed_number, ward_id: bed.ward_id },
      req,
    });
    return { ok: true as const };
  });

  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error });
  res.json(result);
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
  const adm = await queryOne<{ id: number; patient_id: number; admission_number: string; status: string }>(
    'SELECT id, patient_id, admission_number, status FROM admissions WHERE id = ?',
    [admId]
  );
  if (!adm) return res.status(404).json({ error: 'Admission not found' });
  if (adm.status !== 'admitted') {
    return res.status(409).json({ error: `Discharge order can only be created from 'admitted' status (current: ${adm.status}).` });
  }

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
  const { force_clearance_reason } = req.body || {};

  const result = await withTransaction(async () => {
    const adm = await queryOne<{
      id: number;
      patient_id: number;
      bed_id: number | null;
      bed_days_billed: number;
      admitted_at: string;
      patient_type: string;
    }>(
      `SELECT a.id, a.patient_id, a.bed_id, a.bed_days_billed, a.admitted_at, p.patient_type
       FROM admissions a
       INNER JOIN patients p ON p.id = a.patient_id
       WHERE a.id = ?`,
      [admId]
    );
    if (!adm) return { ok: false as const, error: 'Admission not found', httpStatus: 404 };

    if (adm.patient_type === 'self-pay' && !force_clearance_reason?.trim()) {
      const daysStayed = Math.max(1, Math.ceil((Date.now() - new Date(adm.admitted_at).getTime()) / 86400000));
      if (Number(adm.bed_days_billed || 0) < daysStayed) {
        return {
          ok: false as const,
          error: `Unbilled inpatient stay: ${daysStayed - Number(adm.bed_days_billed || 0)} day(s) of bed tariff have not been posted yet. Click "Post Bed Charge" first.`,
          httpStatus: 409,
        };
      }
      const unpaid = await queryOne<{ bal: number }>(
        "SELECT COALESCE(SUM(total_amount - paid_amount), 0) AS bal FROM invoices WHERE patient_id = ? AND status IN ('unpaid','partial')",
        [adm.patient_id]
      );
      if (Number(unpaid?.bal || 0) > 0.01) {
        return {
          ok: false as const,
          error: `Outstanding balance of $${Number(unpaid?.bal).toFixed(2)} remains unpaid. Collect payment or apply patient deposit before discharge clearance.`,
          httpStatus: 402,
        };
      }
    }

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
      reason: force_clearance_reason?.trim() || null,
      req,
    });
    return { ok: true as const };
  });

  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error });
  res.json(result);
});

router.patch('/ipd/beds/:id/status', requireAuth, requirePermission('ipd.bed.assign'), async (req: AuthRequest, res: Response) => {
  const bedId = Number(req.params.id);
  const { status } = req.body || {};
  if (!['vacant', 'cleaning', 'out_of_service'].includes(status)) {
    return res.status(400).json({ error: 'Invalid bed status update.' });
  }
  const activeOccupant = await queryOne<{ admission_number: string }>(
    "SELECT admission_number FROM admissions WHERE bed_id = ? AND status IN ('admitted','discharge_ordered','cleared') LIMIT 1",
    [bedId]
  );
  if (activeOccupant) {
    return res.status(409).json({
      error: `Bed is currently occupied by active admission ${activeOccupant.admission_number}. Transfer or discharge patient first.`,
    });
  }
  await execute('UPDATE beds SET status = ? WHERE id = ?', [status, bedId]);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// SECURE BILLING, SHIFTS, RECEIPTS (REPRINTS) & APPROVALS
// ---------------------------------------------------------------------------
router.get('/billing/shifts', requireAuth, requirePermission('billing.shift.manage', 'finance.report.view'), async (req: AuthRequest, res: Response) => {
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

router.get('/billing/invoices', requireAuth, requirePermission('billing.invoice.read'), async (req, res) => {
  const statusFilter = req.query.status ? String(req.query.status).trim() : '';
  const search = req.query.q ? String(req.query.q).trim() : '';
  const limit = Math.min(100, Math.max(10, Number(req.query.limit || 60)));
  const page = Math.max(1, Number(req.query.page || 1));
  const offset = (page - 1) * limit;

  let whereSql = ' WHERE 1=1';
  const params: unknown[] = [];
  if (statusFilter && statusFilter !== 'all') {
    whereSql += ' AND i.status = ?';
    params.push(statusFilter);
  }
  if (search) {
    const like = `%${search}%`;
    whereSql += ' AND (i.invoice_number LIKE ? OR p.mrn LIKE ? OR p.first_name LIKE ? OR p.last_name LIKE ?)';
    params.push(like, like, like, like);
  }

  const countRow = await queryOne<{ cnt: number }>(
    `SELECT COUNT(*) AS cnt FROM invoices i INNER JOIN patients p ON p.id = i.patient_id${whereSql}`,
    params
  );

  const invoices = await query<Record<string, unknown>>(
    `SELECT i.*, p.mrn, p.first_name, p.last_name, p.phone
     FROM invoices i
     INNER JOIN patients p ON p.id = i.patient_id${whereSql}
     ORDER BY i.id DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  if (invoices.length > 0) {
    const invIds = invoices.map((i) => i.id);
    const ph = invIds.map(() => '?').join(',');
    const [allItems, allPayments] = await Promise.all([
      query<Record<string, unknown>>(`SELECT * FROM invoice_items WHERE invoice_id IN (${ph})`, invIds),
      query<Record<string, unknown>>(
        `SELECT pay.*, r.receipt_number, u.full_name AS cashier_name
         FROM payments pay
         LEFT JOIN receipts r ON r.payment_id = pay.id
         LEFT JOIN users u ON u.id = pay.created_by
         WHERE pay.invoice_id IN (${ph})
         ORDER BY pay.id DESC`,
        invIds
      ),
    ]);

    const itemsByInv = new Map<number, Record<string, unknown>[]>();
    for (const it of allItems) {
      const k = Number(it.invoice_id);
      if (!itemsByInv.has(k)) itemsByInv.set(k, []);
      itemsByInv.get(k)!.push(it);
    }

    const paysByInv = new Map<number, Record<string, unknown>[]>();
    for (const py of allPayments) {
      const k = Number(py.invoice_id);
      if (!paysByInv.has(k)) paysByInv.set(k, []);
      paysByInv.get(k)!.push(py);
    }

    for (const inv of invoices) {
      inv.items = itemsByInv.get(Number(inv.id)) || [];
      inv.payments = paysByInv.get(Number(inv.id)) || [];
    }
  }

  res.json({ invoices, total: Number(countRow?.cnt || 0), page, limit });
});

router.post('/billing/invoices', requireAuth, requirePermission('billing.invoice.create'), async (req: AuthRequest, res: Response) => {
  const { patient_id, items, notes } = req.body || {};
  if (!patient_id || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Patient and at least one billable item are required.' });
  }

  const result = await withTransaction(async () => {
    const patient = await queryOne<{ patient_type: string; payer_name: string | null }>(
      'SELECT patient_type, payer_name FROM patients WHERE id = ?',
      [patient_id]
    );
    if (!patient) return { ok: false as const, error: 'Patient not found', httpStatus: 404 };

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

    return { ok: true as const, id: invRes.insertId, invoiceNumber: invNum };
  });

  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error });
  res.status(201).json(result);
});

router.post('/billing/payments', requireAuth, requirePermission('billing.payment.create'), async (req: AuthRequest, res: Response) => {
  const { invoice_id, amount, payment_method = 'cash', reference_number } = req.body || {};
  const payAmount = Number(amount || 0);
  if (!invoice_id || payAmount <= 0) {
    return res.status(400).json({ error: 'Valid invoice_id and positive payment amount are required.' });
  }

  const result = await withTransaction(async () => {
    const openShift = await queryOne<{ id: number }>("SELECT id FROM cashier_shifts WHERE cashier_id = ? AND status = 'open'", [
      req.user!.id,
    ]);
    if (!openShift) {
      return { ok: false as const, error: 'You must open a Cashier Shift before collecting payments.', httpStatus: 409 };
    }

    const inv = await queryOne<{ id: number; invoice_number: string; patient_id: number; total_amount: number; paid_amount: number; status: string }>(
      'SELECT * FROM invoices WHERE id = ?',
      [invoice_id]
    );
    if (!inv) return { ok: false as const, error: 'Invoice not found', httpStatus: 404 };
    if (inv.status === 'voided') return { ok: false as const, error: 'Cannot pay a voided invoice.', httpStatus: 409 };

    const remaining = Number((Number(inv.total_amount) - Number(inv.paid_amount)).toFixed(2));
    if (payAmount > remaining + 0.01) {
      return { ok: false as const, error: `Payment (${payAmount}) exceeds remaining balance (${remaining}).`, httpStatus: 400 };
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

    // Automated double-entry GL posting for collected revenue
    const invFull = await queryOne<{ payer_type: string }>('SELECT payer_type FROM invoices WHERE id = ?', [inv.id]);
    const cashOrBankAcct = payment_method === 'cash' ? '1010' : '1020';
    let creditAcct = '4010';
    if (invFull?.payer_type === 'insurance' || invFull?.payer_type === 'credit') {
      creditAcct = '1100';
    } else {
      const firstItem = await queryOne<{ category: string }>(
        'SELECT category FROM invoice_items WHERE invoice_id = ? ORDER BY line_total DESC LIMIT 1',
        [inv.id]
      );
      if (firstItem) creditAcct = revenueAccountForCategory(firstItem.category);
    }
    await postJournalEntry({
      sourceType: 'payment',
      sourceId: payRes.insertId,
      description: `Cashier payment ${receiptNumber} for ${inv.invoice_number}`,
      postedBy: req.user!.id,
      lines: [
        { accountCode: cashOrBankAcct, debit: payAmount, memo: `${payment_method} receipt ${receiptNumber}` },
        { accountCode: creditAcct, credit: payAmount, memo: inv.invoice_number },
      ],
    });

    let gatesUnlocked = { unlockedConsultVisits: 0, unlockedRx: 0, unlockedLab: 0, unlockedImaging: 0 };
    if (newStatus === 'paid') {
      gatesUnlocked = await unlockPaidInvoiceGates({
        invoiceId: inv.id,
        invoiceNumber: inv.invoice_number,
        receiptNumber,
        userId: req.user!.id,
      });
    }

    await writeAuditLog({
      user: req.user,
      action: 'billing.payment.create',
      entityType: 'payment',
      entityId: payRes.insertId,
      patientId: inv.patient_id,
      after: { invoiceId: inv.id, amount: payAmount, method: payment_method, receiptNumber, gatesUnlocked },
      req,
    });

    return {
      ok: true as const,
      paymentId: payRes.insertId,
      receiptId: rcpRes.insertId,
      receiptNumber,
      invoiceId: inv.id,
      invoiceStatus: newStatus,
      gatesUnlocked,
    };
  });

  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error });
  broadcastClinicEvent('payment:confirmed', { invoiceId: result.invoiceId, invoiceStatus: result.invoiceStatus, receiptNumber: result.receiptNumber });
  if (result.invoiceStatus === 'paid') {
    broadcastClinicEvent('visit:updated', { invoiceId: result.invoiceId });
    broadcastClinicEvent('queue:updated', { invoiceId: result.invoiceId });
    broadcastClinicEvent('lab:updated', { invoiceId: result.invoiceId });
    broadcastClinicEvent('imaging:updated', { invoiceId: result.invoiceId });
    broadcastClinicEvent('pharmacy:updated', { invoiceId: result.invoiceId });
  }
  res.status(201).json(result);
});

router.get('/billing/deposits', requireAuth, requirePermission('billing.invoice.read', 'billing.deposit.create'), async (_req, res) => {
  const deposits = await query(
    `SELECT pd.*, p.mrn, p.first_name, p.last_name, u.full_name AS collected_by_name, a.admission_number
     FROM patient_deposits pd
     INNER JOIN patients p ON p.id = pd.patient_id
     LEFT JOIN users u ON u.id = pd.collected_by
     LEFT JOIN admissions a ON a.id = pd.admission_id
     ORDER BY pd.id DESC LIMIT 50`
  );
  res.json({ deposits });
});

router.post('/billing/deposits', requireAuth, requirePermission('billing.deposit.create'), async (req: AuthRequest, res: Response) => {
  const { patient_id, admission_id, amount, payment_method = 'cash', reference_number } = req.body || {};
  const depAmt = Number(amount || 0);
  if (!patient_id || depAmt <= 0) {
    return res.status(400).json({ error: 'Patient and positive deposit amount are required.' });
  }

  const result = await withTransaction(async () => {
    const openShift = await queryOne<{ id: number }>("SELECT id FROM cashier_shifts WHERE cashier_id = ? AND status = 'open'", [
      req.user!.id,
    ]);
    if (!openShift) {
      return { ok: false as const, error: 'You must open a Cashier Shift before collecting patient deposits.', httpStatus: 409 };
    }

    const depositNumber = await nextSequence('DEP');
    const depRes = await execute(
      `INSERT INTO patient_deposits (deposit_number, patient_id, admission_id, shift_id, amount, remaining_amount, payment_method, reference_number, status, collected_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
      [depositNumber, Number(patient_id), admission_id ? Number(admission_id) : null, openShift.id, depAmt, depAmt, payment_method, reference_number || null, req.user!.id]
    );

    if (payment_method === 'cash') {
      await execute('UPDATE cashier_shifts SET expected_cash = expected_cash + ? WHERE id = ?', [depAmt, openShift.id]);
    }
    if (admission_id) {
      await execute('UPDATE admissions SET deposit_paid = deposit_paid + ? WHERE id = ?', [depAmt, Number(admission_id)]);
    }

    await postJournalEntry({
      sourceType: 'deposit',
      sourceId: depRes.insertId,
      description: `Patient advance deposit ${depositNumber}`,
      postedBy: req.user!.id,
      lines: [
        { accountCode: payment_method === 'cash' ? '1010' : '1020', debit: depAmt, memo: depositNumber },
        { accountCode: '2010', credit: depAmt, memo: 'Patient deposit liability' },
      ],
    });

    await writeAuditLog({
      user: req.user,
      action: 'billing.deposit.create',
      entityType: 'patient_deposit',
      entityId: depRes.insertId,
      patientId: Number(patient_id),
      after: { depositNumber, amount: depAmt, payment_method, admission_id },
      req,
    });

    return { ok: true as const, id: depRes.insertId, depositNumber };
  });

  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error });
  res.status(201).json(result);
});

router.post('/billing/deposits/:id/apply', requireAuth, requirePermission('billing.deposit.create'), async (req: AuthRequest, res: Response) => {
  const depId = Number(req.params.id);
  const { invoice_id } = req.body || {};
  if (!invoice_id) return res.status(400).json({ error: 'invoice_id is required' });

  const result = await withTransaction(async () => {
    const dep = await queryOne<{ id: number; deposit_number: string; patient_id: number; remaining_amount: number; status: string }>(
      'SELECT * FROM patient_deposits WHERE id = ?',
      [depId]
    );
    if (!dep || dep.status !== 'active' || Number(dep.remaining_amount) <= 0) {
      return { ok: false as const, error: 'Active deposit with positive balance not found.', httpStatus: 404 };
    }

    const inv = await queryOne<{ id: number; invoice_number: string; patient_id: number; total_amount: number; paid_amount: number; status: string }>(
      'SELECT * FROM invoices WHERE id = ?',
      [Number(invoice_id)]
    );
    if (!inv || inv.patient_id !== dep.patient_id) {
      return { ok: false as const, error: 'Matching patient invoice not found.', httpStatus: 404 };
    }
    if (inv.status === 'paid' || inv.status === 'voided') {
      return { ok: false as const, error: 'Invoice is already settled or voided.', httpStatus: 409 };
    }

    const invBal = Number((Number(inv.total_amount) - Number(inv.paid_amount)).toFixed(2));
    const applyAmt = Math.min(invBal, Number(dep.remaining_amount));
    const newDepRem = Number((Number(dep.remaining_amount) - applyAmt).toFixed(2));
    const newPaid = Number((Number(inv.paid_amount) + applyAmt).toFixed(2));
    const newInvStatus = newPaid >= Number(inv.total_amount) - 0.01 ? 'paid' : 'partial';

    await execute("UPDATE patient_deposits SET remaining_amount = ?, status = CASE WHEN ? <= 0 THEN 'applied' ELSE 'active' END WHERE id = ?", [
      newDepRem,
      newDepRem,
      dep.id,
    ]);
    await execute('UPDATE invoices SET paid_amount = ?, status = ? WHERE id = ?', [newPaid, newInvStatus, inv.id]);

    const topItem = await queryOne<{ category: string }>(
      'SELECT category FROM invoice_items WHERE invoice_id = ? ORDER BY line_total DESC LIMIT 1',
      [inv.id]
    );
    const revAcct = topItem ? revenueAccountForCategory(topItem.category) : '4040';
    await postJournalEntry({
      sourceType: 'deposit_apply',
      sourceId: inv.id,
      description: `Apply deposit ${dep.deposit_number} to ${inv.invoice_number}`,
      postedBy: req.user!.id,
      lines: [
        { accountCode: '2010', debit: applyAmt, memo: dep.deposit_number },
        { accountCode: revAcct, credit: applyAmt, memo: inv.invoice_number },
      ],
    });

    let gatesUnlocked = { unlockedConsultVisits: 0, unlockedRx: 0, unlockedLab: 0, unlockedImaging: 0 };
    if (newInvStatus === 'paid') {
      gatesUnlocked = await unlockPaidInvoiceGates({
        invoiceId: inv.id,
        invoiceNumber: inv.invoice_number,
        userId: req.user!.id,
      });
    }

    await writeAuditLog({
      user: req.user,
      action: 'billing.deposit.apply',
      entityType: 'invoice',
      entityId: inv.id,
      patientId: inv.patient_id,
      after: { depositNumber: dep.deposit_number, invoiceNumber: inv.invoice_number, applied: applyAmt, invoiceStatus: newInvStatus },
      req,
    });

    return { ok: true as const, appliedAmount: applyAmt, invoiceId: inv.id, invoiceStatus: newInvStatus, gatesUnlocked };
  });

  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error });
  broadcastClinicEvent('payment:confirmed', { invoiceId: result.invoiceId, invoiceStatus: result.invoiceStatus });
  if (result.invoiceStatus === 'paid') {
    broadcastClinicEvent('visit:updated', { invoiceId: result.invoiceId });
    broadcastClinicEvent('queue:updated', { invoiceId: result.invoiceId });
    broadcastClinicEvent('lab:updated', { invoiceId: result.invoiceId });
    broadcastClinicEvent('imaging:updated', { invoiceId: result.invoiceId });
    broadcastClinicEvent('pharmacy:updated', { invoiceId: result.invoiceId });
  }
  res.json(result);
});

router.get('/billing/receipts/:receiptNumber', requireAuth, requirePermission('billing.receipt.print', 'finance.report.view'), async (req, res) => {
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

router.post('/billing/receipts/:receiptNumber/reprint', requireAuth, requirePermission('billing.receipt.print', 'finance.report.view'), async (req: AuthRequest, res: Response) => {
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

router.get('/billing/approvals', requireAuth, requirePermission('billing.approval.request', 'billing.approval.decide', 'finance.report.view'), async (_req, res) => {
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

  const result = await withTransaction(async () => {
    const reqRow = await queryOne<{
      id: number;
      request_type: string;
      entity_id: number;
      requested_amount: number | null;
      requested_by: number;
      status: string;
    }>('SELECT * FROM approval_requests WHERE id = ?', [id]);

    if (!reqRow) return { ok: false as const, error: 'Approval request not found', httpStatus: 404 };
    if (reqRow.status !== 'pending') return { ok: false as const, error: 'Request already decided.', httpStatus: 409 };

    if (reqRow.requested_by === req.user!.id) {
      await writeAuditLog({
        user: req.user,
        action: 'security.segregation_violation_blocked',
        entityType: 'approval_request',
        entityId: id,
        reason: 'Attempted self-approval',
        req,
      });
      return {
        ok: false as const,
        error: 'Segregation of Duties Violation: You cannot approve your own discount, refund, or void request.',
        httpStatus: 403,
      };
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
      const inv = await queryOne<{
        id: number;
        invoice_number: string;
        patient_id: number;
        payer_type: string;
        subtotal: number;
        discount_amount: number;
        paid_amount: number;
      }>(
        'SELECT id, invoice_number, patient_id, payer_type, subtotal, discount_amount, paid_amount FROM invoices WHERE id = ?',
        [reqRow.entity_id]
      );
      if (inv) {
        if (reqRow.request_type === 'discount' && reqRow.requested_amount) {
          const disc = Math.min(Number(inv.subtotal), Number(inv.discount_amount || 0) + Number(reqRow.requested_amount));
          const newTotal = Number((Number(inv.subtotal) - disc).toFixed(2));
          const unpaidStatus = inv.payer_type === 'insurance' || inv.payer_type === 'credit' ? 'credit_billed' : 'unpaid';
          const newStatus = Number(inv.paid_amount) >= newTotal ? 'paid' : Number(inv.paid_amount) > 0 ? 'partial' : unpaidStatus;
          await execute('UPDATE invoices SET discount_amount = ?, total_amount = ?, status = ? WHERE id = ?', [
            disc,
            newTotal,
            newStatus,
            inv.id,
          ]);
          if (newStatus === 'paid') {
            await unlockPaidInvoiceGates({
              invoiceId: inv.id,
              invoiceNumber: inv.invoice_number,
              userId: req.user!.id,
            });
          }
        } else if (reqRow.request_type === 'refund' && Number(inv.paid_amount) > 0) {
          const refundAmt = Math.min(Number(reqRow.requested_amount || inv.paid_amount), Number(inv.paid_amount));
          const openShift = await queryOne<{ id: number }>("SELECT id FROM cashier_shifts WHERE status = 'open' ORDER BY id DESC LIMIT 1");
          if (!openShift) {
            return {
              ok: false as const,
              error: 'An open cashier shift is required to process cash refund reversals.',
              httpStatus: 409,
            };
          }
          await execute(
            "INSERT INTO payments (invoice_id, patient_id, shift_id, amount, payment_method, reference_number, status, created_by) VALUES (?, ?, ?, ?, 'cash', 'REFUND-REV', 'refunded', ?)",
            [inv.id, inv.patient_id, openShift.id, -refundAmt, req.user!.id]
          );
          await execute('UPDATE cashier_shifts SET expected_cash = expected_cash - ? WHERE id = ?', [refundAmt, openShift.id]);
          const remPaid = Number((Number(inv.paid_amount) - refundAmt).toFixed(2));
          await execute("UPDATE invoices SET paid_amount = ?, status = CASE WHEN ? <= 0 THEN 'voided' ELSE 'partial' END WHERE id = ?", [
            remPaid,
            remPaid,
            inv.id,
          ]);
        } else if (reqRow.request_type === 'void_invoice') {
          if (Number(inv.paid_amount) > 0) {
            return {
              ok: false as const,
              error: 'Paid invoices cannot be voided directly. Submit a Refund approval request instead.',
              httpStatus: 409,
            };
          }
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

    return { ok: true as const, invoiceId: reqRow.entity_id };
  });

  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error });
  broadcastClinicEvent('payment:confirmed', { invoiceId: result.invoiceId });
  broadcastClinicEvent('visit:updated', { invoiceId: result.invoiceId });
  res.json(result);
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

router.get('/admin/users', requireAuth, requirePermission('admin.user.manage', 'audit.read', 'hr.manage'), async (_req, res) => {
  const users = await query(
    `SELECT u.id, u.full_name, u.email, u.specialty, u.active, u.must_change_password, u.two_fa_enabled, u.last_login_at, u.created_at,
            r.code AS role_code, r.name AS role_name
     FROM users u
     LEFT JOIN user_roles ur ON ur.user_id = u.id
     LEFT JOIN roles r ON r.id = ur.role_id
     ORDER BY u.id ASC`
  );
  res.json({ users });
});

router.get('/admin/deployment-status', requireAuth, requirePermission('admin.user.manage', 'audit.read'), async (_req, res) => {
  const cfg = getDbConfigSummary();
  const [patientsCnt, visitsCnt, jeCnt, auditCnt] = await Promise.all([
    queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM patients'),
    queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM visits'),
    queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM journal_entries'),
    queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM audit_logs'),
  ]);
  res.json({
    ...cfg,
    counts: {
      patients: Number(patientsCnt?.cnt || 0),
      visits: Number(visitsCnt?.cnt || 0),
      journalEntries: Number(jeCnt?.cnt || 0),
      auditLogs: Number(auditCnt?.cnt || 0),
    },
  });
});

router.post('/admin/users', requireAuth, requirePermission('admin.user.manage'), async (req: AuthRequest, res: Response) => {
  const { full_name, email, password, role_code, specialty, two_fa_enabled } = req.body || {};
  if (!full_name || !email || !password || !role_code) {
    return res.status(400).json({ error: 'Full name, email, temporary password, and role are required.' });
  }
  const role = await queryOne<{ id: number }>('SELECT id FROM roles WHERE code = ?', [role_code]);
  if (!role) return res.status(400).json({ error: 'Invalid role code' });

  const normalizedEmail = String(email).trim().toLowerCase();
  const existing = await queryOne<{ id: number }>('SELECT id FROM users WHERE email = ?', [normalizedEmail]);
  if (existing) return res.status(409).json({ error: 'A user with this email already exists.' });

  const enforce2fa = two_fa_enabled !== undefined ? (two_fa_enabled ? 1 : 0) : ['ADM', 'ACC', 'MGR'].includes(role_code) ? 1 : 0;
  const hash = await bcrypt.hash(String(password), 10);
  const inserted = await execute(
    'INSERT INTO users (branch_id, full_name, email, password_hash, specialty, must_change_password, two_fa_enabled) VALUES (1, ?, ?, ?, ?, 1, ?)',
    [full_name.trim(), normalizedEmail, hash, specialty || null, enforce2fa]
  );
  await execute('INSERT INTO user_roles (user_id, role_id, branch_id) VALUES (?, ?, 1)', [inserted.insertId, role.id]);

  await writeAuditLog({
    user: req.user,
    action: 'admin.user.create',
    entityType: 'user',
    entityId: inserted.insertId,
    after: { email: normalizedEmail, role_code, must_change_password: true, two_fa_enabled: Boolean(enforce2fa) },
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

  const lastViewed = lastAuditViewByUser.get(req.user!.id) || 0;
  if (Date.now() - lastViewed > 60_000) {
    lastAuditViewByUser.set(req.user!.id, Date.now());
    await writeAuditLog({
      user: req.user,
      action: 'audit.log.viewed',
      entityType: 'audit_log',
      after: { filter: actionFilter || 'all', rowCount: logs.length },
      req,
    });
  }

  res.json({ logs });
});

router.get('/audit-logs/exceptions', requireAuth, requirePermission('audit.read'), async (req: AuthRequest, res: Response) => {
  const exceptions = await query(
    `SELECT * FROM audit_logs
     WHERE action IN (
       'auth.login.failed', 'auth.2fa.failed', 'auth.password.changed',
       'security.access_denied', 'security.segregation_violation_blocked', 'security.break_glass.access',
       'payment.gate.bypass', 'lab.result.amend', 'visit.reopen', 'patient.merge',
       'receipt.reprint', 'billing.approval.approved', 'billing.shift.close'
     )
     ORDER BY id DESC LIMIT 80`
  );
  await writeAuditLog({
    user: req.user,
    action: 'audit.exceptions.viewed',
    entityType: 'audit_log',
    after: { count: exceptions.length },
    req,
  });
  res.json({ exceptions });
});

router.get('/audit-logs/trace', requireAuth, requirePermission('audit.read'), async (req: AuthRequest, res: Response) => {
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
  await writeAuditLog({
    user: req.user,
    action: 'audit.trace.executed',
    entityType: 'audit_log',
    patientId: patientId || undefined,
    after: { targetUserId: userId, targetPatientId: patientId, count: trace.length },
    req,
  });
  res.json({ trace });
});

router.get('/audit-logs/verify', requireAuth, requirePermission('audit.read'), async (req: AuthRequest, res: Response) => {
  const verification = await verifyAuditChain();
  await writeAuditLog({
    user: req.user,
    action: 'audit.chain.verified',
    entityType: 'audit_log',
    after: verification,
    req,
  });
  res.json(verification);
});

// ---------------------------------------------------------------------------
// FULL ACCOUNTING LEDGER (CoA, Journals, Trial Balance, P&L, AR/AP, Expenses)
// ---------------------------------------------------------------------------
router.get('/accounting/overview', requireAuth, requirePermission('finance.report.view', 'accounting.ledger.manage', 'accounting.expense.create'), async (_req, res) => {
  const [accounts, journals, journalLines, supplierBills, expenseVouchers, insuranceClaims, creditInvoices] = await Promise.all([
    query<{ id: number; code: string; name: string; account_type: string; normal_balance: string; active: number }>(
      'SELECT * FROM chart_of_accounts ORDER BY code ASC'
    ),
    query<Record<string, unknown>>(
      `SELECT je.*, u.full_name AS posted_by_name
       FROM journal_entries je
       LEFT JOIN users u ON u.id = je.posted_by
       ORDER BY je.id DESC LIMIT 60`
    ),
    query<{ entry_id: number; account_id: number; code: string; name: string; debit: number; credit: number; memo: string | null }>(
      `SELECT jl.entry_id, jl.account_id, coa.code, coa.name, jl.debit, jl.credit, jl.memo
       FROM journal_lines jl
       INNER JOIN chart_of_accounts coa ON coa.id = jl.account_id`
    ),
    query<Record<string, unknown>>(
      `SELECT sb.*, gr.grn_number
       FROM supplier_bills sb
       LEFT JOIN goods_receipts gr ON gr.id = sb.grn_id
       ORDER BY sb.id DESC LIMIT 50`
    ),
    query<Record<string, unknown>>(
      `SELECT ev.*, coa.code AS account_code, coa.name AS account_name,
              u1.full_name AS requested_by_name, u2.full_name AS approved_by_name,
              je.entry_number AS journal_entry_number
       FROM expense_vouchers ev
       INNER JOIN chart_of_accounts coa ON coa.id = ev.account_id
       LEFT JOIN users u1 ON u1.id = ev.requested_by
       LEFT JOIN users u2 ON u2.id = ev.approved_by
       LEFT JOIN journal_entries je ON je.source_type = 'expense' AND je.source_id = ev.id
       ORDER BY ev.id DESC LIMIT 50`
    ),
    query<Record<string, unknown>>(
      `SELECT ic.*, i.invoice_number, p.mrn, p.first_name, p.last_name
       FROM insurance_claims ic
       INNER JOIN invoices i ON i.id = ic.invoice_id
       INNER JOIN patients p ON p.id = ic.patient_id
       ORDER BY ic.id DESC LIMIT 50`
    ),
    query<Record<string, unknown>>(
      `SELECT i.id, i.invoice_number, i.payer_type, i.payer_name, i.total_amount, i.paid_amount, i.created_at,
              p.mrn, p.first_name, p.last_name
       FROM invoices i
       INNER JOIN patients p ON p.id = i.patient_id
       WHERE i.status = 'credit_billed'
         AND i.id NOT IN (SELECT invoice_id FROM insurance_claims)
       ORDER BY i.id DESC LIMIT 30`
    ),
  ]);

  const linesByEntry = new Map<number, typeof journalLines>();
  const totalsByAccount = new Map<number, { debit: number; credit: number }>();
  for (const ln of journalLines) {
    if (!linesByEntry.has(ln.entry_id)) linesByEntry.set(ln.entry_id, []);
    linesByEntry.get(ln.entry_id)!.push(ln);

    if (!totalsByAccount.has(ln.account_id)) totalsByAccount.set(ln.account_id, { debit: 0, credit: 0 });
    const t = totalsByAccount.get(ln.account_id)!;
    t.debit = Number((t.debit + Number(ln.debit || 0)).toFixed(2));
    t.credit = Number((t.credit + Number(ln.credit || 0)).toFixed(2));
  }
  for (const je of journals) {
    je.lines = linesByEntry.get(Number(je.id)) || [];
  }

  const trialBalance = accounts.map((a) => {
    const t = totalsByAccount.get(a.id) || { debit: 0, credit: 0 };
    const net = a.normal_balance === 'debit' ? Number((t.debit - t.credit).toFixed(2)) : Number((t.credit - t.debit).toFixed(2));
    return {
      ...a,
      debit_total: t.debit,
      credit_total: t.credit,
      net_balance: net,
    };
  });

  const revenues = trialBalance.filter((a) => a.account_type === 'revenue' && a.net_balance !== 0);
  const expenses = trialBalance.filter((a) => a.account_type === 'expense' && a.net_balance !== 0);
  const totalRevenue = Number(revenues.reduce((s, r) => s + r.net_balance, 0).toFixed(2));
  const totalExpenses = Number(expenses.reduce((s, e) => s + e.net_balance, 0).toFixed(2));

  const nowMs = Date.now();
  for (const clm of insuranceClaims) {
    const subMs = new Date(String(clm.submitted_at)).getTime();
    const ageDays = Math.max(0, Math.floor((nowMs - subMs) / 86400000));
    clm.age_days = ageDays;
    clm.age_bucket = ageDays <= 30 ? '0-30d' : ageDays <= 60 ? '31-60d' : ageDays <= 90 ? '61-90d' : '90+d';
  }

  res.json({
    accounts,
    journals,
    trialBalance,
    incomeStatement: {
      revenues,
      expenses,
      totalRevenue,
      totalExpenses,
      netIncome: Number((totalRevenue - totalExpenses).toFixed(2)),
    },
    supplierBills,
    expenseVouchers,
    insuranceClaims,
    unclaimedCreditInvoices: creditInvoices,
  });
});

router.post('/accounting/journal', requireAuth, requirePermission('accounting.ledger.manage'), async (req: AuthRequest, res: Response) => {
  const { entry_date, description, lines } = req.body || {};
  if (!description?.trim() || !Array.isArray(lines) || lines.length < 2) {
    return res.status(400).json({ error: 'Description and at least 2 journal lines are required.' });
  }
  try {
    const posted = await withTransaction(async () => {
      const je = await postJournalEntry({
        entryDate: entry_date,
        sourceType: 'manual',
        description: description.trim(),
        postedBy: req.user!.id,
        lines,
      });
      await writeAuditLog({
        user: req.user,
        action: 'accounting.journal.create',
        entityType: 'journal_entry',
        entityId: je.entryId,
        after: { entryNumber: je.entryNumber, totalDebit: je.totalDebit, description: description.trim() },
        req,
      });
      return je;
    });
    res.status(201).json(posted);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

router.post('/accounting/ap/:id/pay', requireAuth, requirePermission('accounting.ledger.manage'), async (req: AuthRequest, res: Response) => {
  const billId = Number(req.params.id);
  const { amount, payment_method = 'bank_transfer' } = req.body || {};
  const payAmt = Number(amount || 0);
  if (payAmt <= 0) return res.status(400).json({ error: 'Positive payment amount is required.' });

  const result = await withTransaction(async () => {
    const bill = await queryOne<{ id: number; bill_number: string; supplier_name: string; total_amount: number; paid_amount: number; status: string }>(
      'SELECT * FROM supplier_bills WHERE id = ?',
      [billId]
    );
    if (!bill) return { ok: false as const, error: 'Supplier bill not found', httpStatus: 404 };
    const rem = Number((Number(bill.total_amount) - Number(bill.paid_amount)).toFixed(2));
    if (rem <= 0) return { ok: false as const, error: 'Bill is already paid.', httpStatus: 409 };
    const actualPay = Math.min(payAmt, rem);
    const nextPaid = Number((Number(bill.paid_amount) + actualPay).toFixed(2));
    const nextStatus = nextPaid >= Number(bill.total_amount) - 0.01 ? 'paid' : 'partial';

    await execute('UPDATE supplier_bills SET paid_amount = ?, status = ? WHERE id = ?', [nextPaid, nextStatus, billId]);
    const je = await postJournalEntry({
      sourceType: 'ap_payment',
      sourceId: billId,
      description: `Supplier AP payment ${bill.bill_number} (${bill.supplier_name})`,
      postedBy: req.user!.id,
      lines: [
        { accountCode: '2100', debit: actualPay, memo: bill.bill_number },
        { accountCode: payment_method === 'cash' ? '1010' : '1020', credit: actualPay, memo: bill.supplier_name },
      ],
    });
    await writeAuditLog({
      user: req.user,
      action: 'accounting.ap.pay',
      entityType: 'supplier_bill',
      entityId: billId,
      after: { billNumber: bill.bill_number, paid: actualPay, status: nextStatus, entryNumber: je.entryNumber },
      req,
    });
    return { ok: true as const, paid: actualPay, status: nextStatus, entryNumber: je.entryNumber };
  });

  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error });
  res.json(result);
});

router.post('/accounting/ar-claims', requireAuth, requirePermission('accounting.ledger.manage'), async (req: AuthRequest, res: Response) => {
  const { invoice_id, notes } = req.body || {};
  if (!invoice_id) return res.status(400).json({ error: 'invoice_id is required' });

  const result = await withTransaction(async () => {
    const inv = await queryOne<{ id: number; invoice_number: string; patient_id: number; payer_name: string | null; total_amount: number }>(
      'SELECT * FROM invoices WHERE id = ?',
      [Number(invoice_id)]
    );
    if (!inv) return { ok: false as const, error: 'Credit/Insurance invoice not found', httpStatus: 404 };
    const existing = await queryOne('SELECT id FROM insurance_claims WHERE invoice_id = ?', [inv.id]);
    if (existing) return { ok: false as const, error: 'Insurance claim already submitted for this invoice.', httpStatus: 409 };

    const claimNumber = await nextSequence('CLM');
    const clmRes = await execute(
      `INSERT INTO insurance_claims (claim_number, payer_name, invoice_id, patient_id, billed_amount, settled_amount, status, notes)
       VALUES (?, ?, ?, ?, ?, 0, 'submitted', ?)`,
      [claimNumber, inv.payer_name || 'Insurance Payer', inv.id, inv.patient_id, Number(inv.total_amount), notes || null]
    );
    const topItem = await queryOne<{ category: string }>('SELECT category FROM invoice_items WHERE invoice_id = ? ORDER BY line_total DESC LIMIT 1', [inv.id]);
    await postJournalEntry({
      sourceType: 'ar_claim',
      sourceId: clmRes.insertId,
      description: `Insurance claim ${claimNumber} (${inv.invoice_number})`,
      postedBy: req.user!.id,
      lines: [
        { accountCode: '1100', debit: Number(inv.total_amount), memo: claimNumber },
        { accountCode: revenueAccountForCategory(topItem?.category || 'consultation'), credit: Number(inv.total_amount), memo: inv.invoice_number },
      ],
    });
    await writeAuditLog({
      user: req.user,
      action: 'accounting.ar.submit',
      entityType: 'insurance_claim',
      entityId: clmRes.insertId,
      patientId: inv.patient_id,
      after: { claimNumber, invoiceNumber: inv.invoice_number, amount: inv.total_amount },
      req,
    });
    return { ok: true as const, id: clmRes.insertId, claimNumber };
  });

  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error });
  res.status(201).json(result);
});

router.post('/accounting/ar-claims/:id/settle', requireAuth, requirePermission('accounting.ledger.manage'), async (req: AuthRequest, res: Response) => {
  const claimId = Number(req.params.id);
  const { amount, notes } = req.body || {};
  const settleAmt = Number(amount || 0);
  if (settleAmt <= 0) return res.status(400).json({ error: 'Positive settlement amount is required.' });

  const result = await withTransaction(async () => {
    const clm = await queryOne<{
      id: number;
      claim_number: string;
      payer_name: string;
      invoice_id: number;
      patient_id: number;
      billed_amount: number;
      settled_amount: number;
    }>('SELECT * FROM insurance_claims WHERE id = ?', [claimId]);
    if (!clm) return { ok: false as const, error: 'Insurance claim not found', httpStatus: 404 };

    const rem = Number((Number(clm.billed_amount) - Number(clm.settled_amount)).toFixed(2));
    const apply = Math.min(settleAmt, rem);
    if (apply <= 0) return { ok: false as const, error: 'Claim is already fully settled.', httpStatus: 409 };

    const nextSettled = Number((Number(clm.settled_amount) + apply).toFixed(2));
    const nextStatus = nextSettled >= Number(clm.billed_amount) - 0.01 ? 'settled' : 'partial';

    await execute("UPDATE insurance_claims SET settled_amount = ?, status = ?, settled_at = datetime('now'), notes = COALESCE(?, notes) WHERE id = ?", [
      nextSettled,
      nextStatus,
      notes || null,
      claimId,
    ]).catch(async () => {
      await execute('UPDATE insurance_claims SET settled_amount = ?, status = ?, settled_at = NOW(), notes = COALESCE(?, notes) WHERE id = ?', [
        nextSettled,
        nextStatus,
        notes || null,
        claimId,
      ]);
    });

    await execute('UPDATE invoices SET paid_amount = paid_amount + ?, status = CASE WHEN paid_amount + ? >= total_amount - 0.01 THEN \'paid\' ELSE \'partial\' END WHERE id = ?', [
      apply,
      apply,
      clm.invoice_id,
    ]);

    const je = await postJournalEntry({
      sourceType: 'ar_settle',
      sourceId: claimId,
      description: `Insurance claim settlement ${clm.claim_number} (${clm.payer_name})`,
      postedBy: req.user!.id,
      lines: [
        { accountCode: '1020', debit: apply, memo: clm.claim_number },
        { accountCode: '1100', credit: apply, memo: clm.payer_name },
      ],
    });
    await writeAuditLog({
      user: req.user,
      action: 'accounting.ar.settle',
      entityType: 'insurance_claim',
      entityId: claimId,
      patientId: clm.patient_id,
      after: { claimNumber: clm.claim_number, settled: apply, status: nextStatus, entryNumber: je.entryNumber },
      req,
    });
    return { ok: true as const, settled: apply, status: nextStatus, entryNumber: je.entryNumber };
  });

  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error });
  res.json(result);
});

router.post('/accounting/expenses', requireAuth, requirePermission('accounting.ledger.manage', 'accounting.expense.create'), async (req: AuthRequest, res: Response) => {
  const {
    expense_date,
    category,
    account_code = '5200',
    payee_name,
    amount,
    payment_method = 'bank_transfer',
    description,
    auto_post = true,
  } = req.body || {};
  const amt = Number(Number(amount || 0).toFixed(2));
  if (!category?.trim() || !payee_name?.trim() || amt <= 0 || !description?.trim()) {
    return res.status(400).json({ error: 'Category, payee, positive amount, and description are required.' });
  }
  if (!['bank_transfer', 'cash'].includes(String(payment_method))) {
    return res.status(400).json({ error: 'Payment method must be bank_transfer or cash.' });
  }
  const acct = await queryOne<{ id: number; code: string; name: string; account_type: string }>(
    'SELECT id, code, name, account_type FROM chart_of_accounts WHERE code = ? AND active = 1',
    [account_code]
  );
  if (!acct || acct.account_type !== 'expense') {
    return res.status(400).json({ error: 'Select a valid active Expense GL account.' });
  }

  const voucherDate = expense_date ? String(expense_date).slice(0, 10) : new Date().toISOString().slice(0, 10);
  const shouldAutoPost = auto_post !== false;

  const created = await withTransaction(async () => {
    const voucherNumber = await nextSequence('EXP');
    const status = shouldAutoPost ? 'paid' : 'pending';
    const inserted = await execute(
      `INSERT INTO expense_vouchers (voucher_number, expense_date, category, account_id, payee_name, amount, payment_method, description, status, requested_by, approved_by, paid_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${shouldAutoPost ? "datetime('now')" : 'NULL'})`,
      [
        voucherNumber,
        voucherDate,
        category.trim(),
        acct.id,
        payee_name.trim(),
        amt,
        payment_method,
        description.trim(),
        status,
        req.user!.id,
        shouldAutoPost ? req.user!.id : null,
      ]
    ).catch(async () => {
      return execute(
        `INSERT INTO expense_vouchers (voucher_number, expense_date, category, account_id, payee_name, amount, payment_method, description, status, requested_by, approved_by, paid_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${shouldAutoPost ? 'NOW()' : 'NULL'})`,
        [
          voucherNumber,
          voucherDate,
          category.trim(),
          acct.id,
          payee_name.trim(),
          amt,
          payment_method,
          description.trim(),
          status,
          req.user!.id,
          shouldAutoPost ? req.user!.id : null,
        ]
      );
    });

    let entryNumber: string | null = null;
    let journalEntryId: number | null = null;
    if (shouldAutoPost) {
      const je = await postJournalEntry({
        entryDate: voucherDate,
        sourceType: 'expense',
        sourceId: inserted.insertId,
        description: `Expense ${voucherNumber}: ${payee_name.trim()} (${category.trim()})`,
        postedBy: req.user!.id,
        lines: [
          { accountCode: acct.code, debit: amt, memo: description.trim() },
          {
            accountCode: payment_method === 'cash' ? '1010' : '1020',
            credit: amt,
            memo: `${voucherNumber} · ${payment_method === 'cash' ? 'Petty Cash' : 'Operating Bank'}`,
          },
        ],
      });
      entryNumber = je.entryNumber;
      journalEntryId = je.entryId;
    }

    await writeAuditLog({
      user: req.user,
      action: 'accounting.expense.create',
      entityType: 'expense_voucher',
      entityId: inserted.insertId,
      after: {
        voucherNumber,
        expense_date: voucherDate,
        account_code: acct.code,
        payee_name: payee_name.trim(),
        amount: amt,
        payment_method,
        status,
        entryNumber,
      },
      req,
    });

    return { id: inserted.insertId, voucherNumber, status, entryNumber, journalEntryId };
  });

  res.status(201).json(created);
});

router.post('/accounting/expenses/:id/decide', requireAuth, requirePermission('accounting.ledger.manage'), async (req: AuthRequest, res: Response) => {
  const id = Number(req.params.id);
  const { decision } = req.body || {};
  if (!['paid', 'rejected'].includes(decision)) {
    return res.status(400).json({ error: 'Decision must be paid (approve & post) or rejected.' });
  }

  const result = await withTransaction(async () => {
    const ev = await queryOne<{
      id: number;
      voucher_number: string;
      payee_name: string;
      amount: number;
      payment_method: string;
      description: string;
      status: string;
      account_code: string;
    }>(
      `SELECT ev.*, coa.code AS account_code
       FROM expense_vouchers ev
       INNER JOIN chart_of_accounts coa ON coa.id = ev.account_id
       WHERE ev.id = ?`,
      [id]
    );
    if (!ev) return { ok: false as const, error: 'Expense voucher not found', httpStatus: 404 };
    if (ev.status !== 'pending') return { ok: false as const, error: 'Expense voucher already processed.', httpStatus: 409 };

    await execute("UPDATE expense_vouchers SET status = ?, approved_by = ?, paid_at = datetime('now') WHERE id = ?", [
      decision,
      req.user!.id,
      id,
    ]).catch(async () => {
      await execute('UPDATE expense_vouchers SET status = ?, approved_by = ?, paid_at = NOW() WHERE id = ?', [
        decision,
        req.user!.id,
        id,
      ]);
    });

    let entryNumber: string | null = null;
    if (decision === 'paid') {
      const je = await postJournalEntry({
        sourceType: 'expense',
        sourceId: id,
        description: `Expense ${ev.voucher_number}: ${ev.payee_name}`,
        postedBy: req.user!.id,
        lines: [
          { accountCode: ev.account_code, debit: Number(ev.amount), memo: ev.description },
          { accountCode: ev.payment_method === 'cash' ? '1010' : '1020', credit: Number(ev.amount), memo: ev.voucher_number },
        ],
      });
      entryNumber = je.entryNumber;
    }

    await writeAuditLog({
      user: req.user,
      action: `accounting.expense.${decision}`,
      entityType: 'expense_voucher',
      entityId: id,
      after: { voucherNumber: ev.voucher_number, decision, entryNumber },
      req,
    });
    return { ok: true as const, status: decision, entryNumber };
  });

  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error });
  res.json(result);
});

// ---------------------------------------------------------------------------
// FILTERABLE REPORTS LIBRARY
// ---------------------------------------------------------------------------
router.get('/reports/:type', requireAuth, requirePermission('finance.report.view', 'audit.read', 'store.item.read'), async (req: AuthRequest, res: Response) => {
  const type = req.params.type;
  const fromDate = req.query.from ? String(req.query.from).slice(0, 10) : '2020-01-01';
  const toDate = req.query.to ? String(req.query.to).slice(0, 10) : '2099-12-31';

  if (type === 'daily-cash') {
    const rows = await query(
      `SELECT substr(pay.created_at, 1, 10) AS payment_date, u.full_name AS cashier_name,
              pay.payment_method, COUNT(*) AS tx_count, ROUND(SUM(pay.amount), 2) AS total_amount
       FROM payments pay
       LEFT JOIN users u ON u.id = pay.created_by
       WHERE pay.status = 'completed' AND substr(pay.created_at, 1, 10) BETWEEN ? AND ?
       GROUP BY substr(pay.created_at, 1, 10), u.full_name, pay.payment_method
       ORDER BY payment_date DESC, cashier_name ASC`,
      [fromDate, toDate]
    );
    return res.json({ reportType: type, fromDate, toDate, rows });
  }

  if (type === 'opd-diagnoses') {
    const rows = await query(
      `SELECT COALESCE(v.diagnosis_code, 'UNSPEC') AS diagnosis_code,
              COALESCE(v.diagnosis_text, v.chief_complaint, 'Pending Assessment') AS diagnosis_text,
              COUNT(*) AS visit_count,
              SUM(CASE WHEN v.triage_priority = 'emergency' THEN 1 ELSE 0 END) AS emergency_count
       FROM visits v
       WHERE substr(v.created_at, 1, 10) BETWEEN ? AND ?
       GROUP BY COALESCE(v.diagnosis_code, 'UNSPEC'), COALESCE(v.diagnosis_text, v.chief_complaint, 'Pending Assessment')
       ORDER BY visit_count DESC LIMIT 40`,
      [fromDate, toDate]
    );
    return res.json({ reportType: type, fromDate, toDate, rows });
  }

  if (type === 'lab-turnaround') {
    const rows = await query(
      `SELECT lo.id, lt.code AS test_code, lt.name AS test_name, p.mrn, p.first_name, p.last_name,
              lo.status, lo.abnormal_flag, lo.created_at, lo.verified_at
       FROM lab_orders lo
       INNER JOIN lab_tests lt ON lt.id = lo.test_id
       INNER JOIN patients p ON p.id = lo.patient_id
       WHERE substr(lo.created_at, 1, 10) BETWEEN ? AND ?
       ORDER BY lo.id DESC LIMIT 60`,
      [fromDate, toDate]
    );
    return res.json({ reportType: type, fromDate, toDate, rows });
  }

  if (type === 'stock-valuation') {
    const rows = await query(
      `SELECT si.code AS item_code, si.name AS item_name, si.category, sb.location, sb.batch_number,
              sb.expiry_date, sb.qty_on_hand, sb.unit_cost,
              ROUND(sb.qty_on_hand * sb.unit_cost, 2) AS stock_value, sb.status
       FROM stock_batches sb
       INNER JOIN store_items si ON si.id = sb.item_id
       WHERE sb.qty_on_hand > 0 OR sb.status = 'blocked_expired'
       ORDER BY sb.expiry_date ASC`
    );
    return res.json({ reportType: type, fromDate, toDate, rows });
  }

  if (type === 'ar-ageing') {
    const claims = await query<Record<string, unknown>>(
      `SELECT ic.claim_number, ic.payer_name, i.invoice_number, p.mrn, p.first_name, p.last_name,
              ic.billed_amount, ic.settled_amount, ROUND(ic.billed_amount - ic.settled_amount, 2) AS balance_due,
              ic.status, ic.submitted_at
       FROM insurance_claims ic
       INNER JOIN invoices i ON i.id = ic.invoice_id
       INNER JOIN patients p ON p.id = ic.patient_id
       ORDER BY ic.id DESC`
    );
    const nowMs = Date.now();
    const rows = claims.map((c) => {
      const ageDays = Math.max(0, Math.floor((nowMs - new Date(String(c.submitted_at)).getTime()) / 86400000));
      return {
        ...c,
        age_days: ageDays,
        age_bucket: ageDays <= 30 ? '0-30 days' : ageDays <= 60 ? '31-60 days' : ageDays <= 90 ? '61-90 days' : '90+ days',
      };
    });
    return res.json({ reportType: type, fromDate, toDate, rows });
  }

  res.status(400).json({ error: 'Unknown report type.' });
});

// ---------------------------------------------------------------------------
// HR & PAYROLL (HRO)
// ---------------------------------------------------------------------------
router.get('/hr/overview', requireAuth, requirePermission('hr.manage', 'hr.leave.request'), async (req: AuthRequest, res: Response) => {
  const isHrManager = hasPermission(req.user!, 'hr.manage');

  const leaveRequests = isHrManager
    ? await query(
        `SELECT lr.*, u1.full_name AS staff_name, r.code AS role_code, u2.full_name AS decided_by_name
         FROM leave_requests lr
         INNER JOIN users u1 ON u1.id = lr.user_id
         LEFT JOIN user_roles ur ON ur.user_id = u1.id
         LEFT JOIN roles r ON r.id = ur.role_id
         LEFT JOIN users u2 ON u2.id = lr.decided_by
         ORDER BY lr.id DESC LIMIT 60`
      )
    : await query(
        `SELECT lr.*, u1.full_name AS staff_name, r.code AS role_code, u2.full_name AS decided_by_name
         FROM leave_requests lr
         INNER JOIN users u1 ON u1.id = lr.user_id
         LEFT JOIN user_roles ur ON ur.user_id = u1.id
         LEFT JOIN roles r ON r.id = ur.role_id
         LEFT JOIN users u2 ON u2.id = lr.decided_by
         WHERE lr.user_id = ?
         ORDER BY lr.id DESC LIMIT 30`,
        [req.user!.id]
      );

  if (!isHrManager) {
    return res.json({ isHrManager: false, contracts: [], leaveRequests, payrollRuns: [], staffUsers: [] });
  }

  const [contractsRaw, payrollRuns, payrollItems, staffUsers] = await Promise.all([
    query<Record<string, unknown>>(
      `SELECT sc.*, u.full_name, u.email, u.specialty, u.active, r.code AS role_code, r.name AS role_name
       FROM staff_contracts sc
       INNER JOIN users u ON u.id = sc.user_id
       LEFT JOIN user_roles ur ON ur.user_id = u.id
       LEFT JOIN roles r ON r.id = ur.role_id
       ORDER BY sc.employee_code ASC`
    ),
    query<Record<string, unknown>>(
      `SELECT pr.*, je.entry_number AS journal_entry_number, u.full_name AS created_by_name
       FROM payroll_runs pr
       LEFT JOIN journal_entries je ON je.id = pr.journal_entry_id
       LEFT JOIN users u ON u.id = pr.created_by
       ORDER BY pr.id DESC LIMIT 20`
    ),
    query<Record<string, unknown>>('SELECT * FROM payroll_items ORDER BY id ASC'),
    query(
      `SELECT u.id, u.full_name, u.email, r.code AS role_code, r.name AS role_name
       FROM users u
       LEFT JOIN user_roles ur ON ur.user_id = u.id
       LEFT JOIN roles r ON r.id = ur.role_id
       WHERE u.active = 1
       ORDER BY u.full_name`
    ),
  ]);

  const nowMs = Date.now();
  const contracts = contractsRaw.map((c) => {
    let licenceDaysRemaining: number | null = null;
    if (c.licence_expiry) {
      licenceDaysRemaining = Math.ceil((new Date(String(c.licence_expiry)).getTime() - nowMs) / 86400000);
    }
    return {
      ...c,
      licence_days_remaining: licenceDaysRemaining,
      licence_alert:
        licenceDaysRemaining === null
          ? 'none'
          : licenceDaysRemaining <= 0
            ? 'expired'
            : licenceDaysRemaining <= 60
              ? 'expiring_soon'
              : 'valid',
    };
  });

  const itemsByRun = new Map<number, Record<string, unknown>[]>();
  for (const pi of payrollItems) {
    const k = Number(pi.payroll_run_id);
    if (!itemsByRun.has(k)) itemsByRun.set(k, []);
    itemsByRun.get(k)!.push(pi);
  }
  for (const run of payrollRuns) {
    run.items = itemsByRun.get(Number(run.id)) || [];
  }

  res.json({ isHrManager: true, contracts, leaveRequests, payrollRuns, staffUsers });
});

router.post('/hr/contracts', requireAuth, requirePermission('hr.manage'), async (req: AuthRequest, res: Response) => {
  const { user_id, employee_code, department_name, contract_type = 'full_time', base_salary, housing_allowance = 0, licence_number, licence_expiry, contract_start } = req.body || {};
  if (!user_id || !employee_code?.trim() || !department_name?.trim() || Number(base_salary) <= 0 || !contract_start) {
    return res.status(400).json({ error: 'Staff member, employee code, department, positive base salary, and start date are required.' });
  }

  const existing = await queryOne<{ id: number }>('SELECT id FROM staff_contracts WHERE user_id = ?', [Number(user_id)]);
  if (existing) {
    await execute(
      `UPDATE staff_contracts SET employee_code = ?, department_name = ?, contract_type = ?, base_salary = ?, housing_allowance = ?, licence_number = ?, licence_expiry = ?, contract_start = ?, updated_at = datetime('now') WHERE id = ?`,
      [employee_code.trim(), department_name.trim(), contract_type, Number(base_salary), Number(housing_allowance || 0), licence_number || null, licence_expiry || null, contract_start, existing.id]
    ).catch(async () => {
      await execute(
        'UPDATE staff_contracts SET employee_code = ?, department_name = ?, contract_type = ?, base_salary = ?, housing_allowance = ?, licence_number = ?, licence_expiry = ?, contract_start = ?, updated_at = NOW() WHERE id = ?',
        [employee_code.trim(), department_name.trim(), contract_type, Number(base_salary), Number(housing_allowance || 0), licence_number || null, licence_expiry || null, contract_start, existing.id]
      );
    });
    await writeAuditLog({
      user: req.user,
      action: 'hr.contract.update',
      entityType: 'staff_contract',
      entityId: existing.id,
      after: { employee_code, base_salary, licence_expiry },
      req,
    });
    return res.json({ id: existing.id, updated: true });
  }

  const inserted = await execute(
    `INSERT INTO staff_contracts (user_id, employee_code, department_name, contract_type, base_salary, housing_allowance, licence_number, licence_expiry, contract_start, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
    [Number(user_id), employee_code.trim(), department_name.trim(), contract_type, Number(base_salary), Number(housing_allowance || 0), licence_number || null, licence_expiry || null, contract_start]
  );
  await writeAuditLog({
    user: req.user,
    action: 'hr.contract.create',
    entityType: 'staff_contract',
    entityId: inserted.insertId,
    after: { user_id, employee_code, base_salary },
    req,
  });
  res.status(201).json({ id: inserted.insertId });
});

router.post('/hr/leave', requireAuth, requirePermission('hr.leave.request', 'hr.manage'), async (req: AuthRequest, res: Response) => {
  const { user_id, leave_type = 'annual', start_date, end_date, reason } = req.body || {};
  const targetUserId = hasPermission(req.user!, 'hr.manage') && user_id ? Number(user_id) : req.user!.id;
  if (!start_date || !end_date || !reason?.trim()) {
    return res.status(400).json({ error: 'Start date, end date, and reason are required.' });
  }
  const sMs = new Date(start_date).getTime();
  const eMs = new Date(end_date).getTime();
  if (Number.isNaN(sMs) || Number.isNaN(eMs) || eMs < sMs) {
    return res.status(400).json({ error: 'End date must be on or after start date.' });
  }
  const daysCount = Math.max(1, Math.round((eMs - sMs) / 86400000) + 1);
  const inserted = await execute(
    "INSERT INTO leave_requests (user_id, leave_type, start_date, end_date, days_count, reason, status) VALUES (?, ?, ?, ?, ?, ?, 'pending')",
    [targetUserId, leave_type, start_date, end_date, daysCount, reason.trim()]
  );
  await createNotification({
    targetRole: 'HRO',
    title: 'New Staff Leave Request',
    message: `${req.user!.fullName} submitted a ${daysCount}-day ${leave_type} leave request (${start_date} to ${end_date}).`,
    severity: 'info',
    entityType: 'leave_request',
    entityId: inserted.insertId,
  });
  await writeAuditLog({
    user: req.user,
    action: 'hr.leave.request',
    entityType: 'leave_request',
    entityId: inserted.insertId,
    after: { targetUserId, leave_type, start_date, end_date, daysCount },
    req,
  });
  res.status(201).json({ id: inserted.insertId, daysCount });
});

router.post('/hr/leave/:id/decide', requireAuth, requirePermission('hr.manage'), async (req: AuthRequest, res: Response) => {
  const id = Number(req.params.id);
  const { decision } = req.body || {};
  if (!['approved', 'rejected'].includes(decision)) {
    return res.status(400).json({ error: 'Decision must be approved or rejected.' });
  }
  const result = await withTransaction(async () => {
    const lr = await queryOne<{ id: number; user_id: number; start_date: string; end_date: string; leave_type: string; status: string }>(
      'SELECT * FROM leave_requests WHERE id = ?',
      [id]
    );
    if (!lr) return { ok: false as const, error: 'Leave request not found', httpStatus: 404 };
    if (lr.status !== 'pending') return { ok: false as const, error: 'Leave request already decided.', httpStatus: 409 };

    await execute("UPDATE leave_requests SET status = ?, decided_by = ?, decided_at = datetime('now') WHERE id = ?", [
      decision,
      req.user!.id,
      id,
    ]).catch(async () => {
      await execute('UPDATE leave_requests SET status = ?, decided_by = ?, decided_at = NOW() WHERE id = ?', [
        decision,
        req.user!.id,
        id,
      ]);
    });

    let blocksCreated = 0;
    if (decision === 'approved') {
      const isDoc = await queryOne<{ cnt: number }>(
        `SELECT COUNT(*) AS cnt FROM user_roles ur INNER JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ? AND r.code = 'DOC'`,
        [lr.user_id]
      );
      if (Number(isDoc?.cnt || 0) > 0) {
        const start = new Date(`${lr.start_date}T00:00:00Z`);
        const end = new Date(`${lr.end_date}T00:00:00Z`);
        for (let d = new Date(start); d <= end && blocksCreated < 14; d.setUTCDate(d.getUTCDate() + 1)) {
          const dateStr = d.toISOString().slice(0, 10);
          await execute(
            "INSERT INTO doctor_blocks (doctor_id, block_date, start_time, end_time, block_type, reason, created_by) VALUES (?, ?, '08:00', '17:00', 'leave', ?, ?)",
            [lr.user_id, dateStr, `Approved ${lr.leave_type} leave`, req.user!.id]
          );
          blocksCreated++;
        }
      }
    }

    await writeAuditLog({
      user: req.user,
      action: `hr.leave.${decision}`,
      entityType: 'leave_request',
      entityId: id,
      after: { decision, blocksCreated },
      req,
    });
    return { ok: true as const, decision, blocksCreated };
  });

  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error });
  res.json(result);
});

router.post('/hr/payroll/generate', requireAuth, requirePermission('hr.manage'), async (req: AuthRequest, res: Response) => {
  const payMonth = String(req.body?.pay_month || new Date().toISOString().slice(0, 7));

  const result = await withTransaction(async () => {
    const existing = await queryOne<{ id: number; run_number: string }>('SELECT id, run_number FROM payroll_runs WHERE pay_month = ?', [payMonth]);
    if (existing) {
      return { ok: false as const, error: `Payroll run for ${payMonth} already exists (${existing.run_number}).`, httpStatus: 409 };
    }

    const contracts = await query<{
      user_id: number;
      full_name: string;
      role_code: string;
      base_salary: number;
      housing_allowance: number;
    }>(
      `SELECT sc.user_id, u.full_name, COALESCE(r.code, 'STF') AS role_code, sc.base_salary, sc.housing_allowance
       FROM staff_contracts sc
       INNER JOIN users u ON u.id = sc.user_id
       LEFT JOIN user_roles ur ON ur.user_id = u.id
       LEFT JOIN roles r ON r.id = ur.role_id
       WHERE sc.status = 'active' AND u.active = 1`
    );
    if (contracts.length === 0) {
      return { ok: false as const, error: 'No active staff contracts found to run payroll.', httpStatus: 400 };
    }

    const runNumber = await nextSequence('PAY');
    let totalGross = 0;
    let totalDed = 0;
    let totalNet = 0;

    const computedLines = contracts.map((c) => {
      const gross = Number((Number(c.base_salary) + Number(c.housing_allowance || 0)).toFixed(2));
      const tax = Number((gross * 0.15).toFixed(2));
      const net = Number((gross - tax).toFixed(2));
      totalGross += gross;
      totalDed += tax;
      totalNet += net;
      return {
        user_id: c.user_id,
        staff_name: c.full_name,
        role_code: c.role_code,
        base_salary: Number(c.base_salary),
        allowances: Number(c.housing_allowance || 0),
        tax_deduction: tax,
        net_pay: net,
      };
    });

    const runRes = await execute(
      "INSERT INTO payroll_runs (run_number, pay_month, total_gross, total_deductions, total_net, status, created_by) VALUES (?, ?, ?, ?, ?, 'draft', ?)",
      [runNumber, payMonth, Number(totalGross.toFixed(2)), Number(totalDed.toFixed(2)), Number(totalNet.toFixed(2)), req.user!.id]
    );

    for (const ln of computedLines) {
      await execute(
        'INSERT INTO payroll_items (payroll_run_id, user_id, staff_name, role_code, base_salary, allowances, tax_deduction, net_pay) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [runRes.insertId, ln.user_id, ln.staff_name, ln.role_code, ln.base_salary, ln.allowances, ln.tax_deduction, ln.net_pay]
      );
    }

    await writeAuditLog({
      user: req.user,
      action: 'hr.payroll.generate',
      entityType: 'payroll_run',
      entityId: runRes.insertId,
      after: { runNumber, payMonth, headcount: computedLines.length, totalGross: Number(totalGross.toFixed(2)) },
      req,
    });

    return { ok: true as const, id: runRes.insertId, runNumber };
  });

  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error });
  res.status(201).json(result);
});

router.post('/hr/payroll/:id/post', requireAuth, requirePermission('hr.manage'), async (req: AuthRequest, res: Response) => {
  const runId = Number(req.params.id);
  const result = await withTransaction(async () => {
    const run = await queryOne<{ id: number; run_number: string; pay_month: string; total_gross: number; total_deductions: number; total_net: number; status: string }>(
      'SELECT * FROM payroll_runs WHERE id = ?',
      [runId]
    );
    if (!run) return { ok: false as const, error: 'Payroll run not found', httpStatus: 404 };
    if (run.status === 'posted') return { ok: false as const, error: 'Payroll run is already posted to Accounting.', httpStatus: 409 };

    const je = await postJournalEntry({
      sourceType: 'payroll',
      sourceId: runId,
      description: `Monthly Payroll ${run.pay_month} (${run.run_number})`,
      postedBy: req.user!.id,
      lines: [
        { accountCode: '5100', debit: Number(run.total_gross), memo: `Gross salaries ${run.pay_month}` },
        { accountCode: '2200', credit: Number(run.total_gross), memo: `Net $${run.total_net} + Statutory Tax $${run.total_deductions}` },
      ],
    });

    await execute("UPDATE payroll_runs SET status = 'posted', journal_entry_id = ?, posted_at = datetime('now') WHERE id = ?", [
      je.entryId,
      runId,
    ]).catch(async () => {
      await execute("UPDATE payroll_runs SET status = 'posted', journal_entry_id = ?, posted_at = NOW() WHERE id = ?", [je.entryId, runId]);
    });

    await writeAuditLog({
      user: req.user,
      action: 'hr.payroll.post',
      entityType: 'payroll_run',
      entityId: runId,
      after: { runNumber: run.run_number, entryNumber: je.entryNumber, totalGross: run.total_gross },
      req,
    });

    return { ok: true as const, entryNumber: je.entryNumber };
  });

  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error });
  res.json(result);
});

export default router;
