import { Router, type NextFunction, type Request, type Response } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execute, getDbConfigSummary, getDialect, nextSequence, nowSql, query, queryOne, withTransaction } from './db.ts';
import {
  type AuthRequest,
  type AuthUser,
  assertDifferentUser,
  assertPatientAccess,
  auditAction,
  authorize,
  clearSessionCookie,
  formatClinicDate,
  formatUtcSqlDatetime,
  getLinkedHrEmployeeStatus,
  hasPermission,
  isDoctorOnly,
  issueSessionToken,
  loadUserContext,
  requireAuth,
  requirePermission,
  revokeAllUserSessions,
  revokeToken,
  setSessionCookie,
  validatePasswordPolicy,
  verifyAuditChain,
  writeAuditLog,
} from './auth.ts';
import { broadcastClinicEvent, createRealtimeTicket, registerRealtimeClient } from './realtime.ts';

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
  if (!allergyText || allergyText === 'none' || allergyText === 'none known' || allergyText === 'nkda' || allergyText === 'unknown') {
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

function validateVitalsRanges(v: {
  bp_systolic?: unknown;
  bp_diastolic?: unknown;
  temperature?: unknown;
  pulse?: unknown;
  respiratory_rate?: unknown;
  spo2?: unknown;
  weight_kg?: unknown;
  height_cm?: unknown;
  blood_glucose?: unknown;
}): string | null {
  const checks: Array<[unknown, string, number, number]> = [
    [v.bp_systolic, 'Systolic BP', 40, 280],
    [v.bp_diastolic, 'Diastolic BP', 20, 180],
    [v.temperature, 'Temperature (°C)', 30, 45],
    [v.pulse, 'Pulse (bpm)', 20, 240],
    [v.respiratory_rate, 'Respiratory Rate', 4, 80],
    [v.spo2, 'SpO2 (%)', 40, 100],
    [v.weight_kg, 'Weight (kg)', 0.5, 400],
    [v.height_cm, 'Height (cm)', 30, 250],
    [v.blood_glucose, 'Blood Glucose', 10, 1500],
  ];
  for (const [val, label, min, max] of checks) {
    if (val != null && val !== '') {
      const n = Number(val);
      if (!Number.isFinite(n) || n < min || n > max) {
        return `${label} must be between ${min} and ${max}.`;
      }
    }
  }
  if (v.bp_systolic != null && v.bp_systolic !== '' && v.bp_diastolic != null && v.bp_diastolic !== '') {
    if (Number(v.bp_diastolic) >= Number(v.bp_systolic)) {
      return 'Diastolic BP must be lower than Systolic BP.';
    }
  }
  return null;
}

const router = Router();
for (const method of ['get', 'post', 'put', 'patch', 'delete'] as const) {
  const orig = router[method].bind(router);
  (router as unknown as Record<string, (...args: unknown[]) => unknown>)[method] = (...args: unknown[]) => {
    const [pathArg, ...handlers] = args as [
      unknown,
      ...Array<(req: Request, res: Response, next: NextFunction) => unknown>,
    ];
    const wrapped = handlers.map((fn) => (req: Request, res: Response, next: NextFunction) => {
      try {
        return Promise.resolve(fn(req, res, next)).catch(next);
      } catch (err) {
        next(err);
      }
    });
    return (orig as (...a: unknown[]) => unknown)(pathArg, ...wrapped);
  };
}

const loginAttemptsByIp = new Map<string, { count: number; resetAt: number }>();
const twoFaAttemptsByIp = new Map<string, { count: number; resetAt: number }>();
const passwordResetAttemptsByIp = new Map<string, { count: number; resetAt: number }>();
const lastAuditViewByUser = new Map<number, number>();

function isRateLimited(
  bucket: Map<string, { count: number; resetAt: number }>,
  key: string,
  maxRequests: number,
  windowMs: number
): boolean {
  const now = Date.now();
  if (bucket.size > 2000) {
    for (const [k, v] of bucket.entries()) {
      if (v.resetAt <= now) bucket.delete(k);
    }
  }
  const entry = bucket.get(key);
  if (entry && entry.resetAt > now) {
    if (entry.count >= maxRequests) return true;
    entry.count += 1;
    return false;
  }
  bucket.set(key, { count: 1, resetAt: now + windowMs });
  return false;
}

function parseJsonSetting<T>(raw: string | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return { ...fallback, ...(JSON.parse(raw) as Partial<T>) };
  } catch {
    return fallback;
  }
}

async function getClinicSettings() {
  const rows = await query<{ setting_key: string; setting_value: string }>('SELECT setting_key, setting_value FROM system_settings');
  const map = new Map(rows.map((r) => [r.setting_key, r.setting_value]));
  const parsedLimit = Number(map.get('expense_auto_post_limit') ?? 100);
  return {
    clinicName: map.get('clinic_name') || 'Clinic360 Central Medical Center',
    currencyCode: map.get('currency_code') || 'USD',
    currencySymbol: map.get('currency_symbol') || '$',
    timezone: map.get('timezone') || 'Africa/Addis_Ababa',
    expenseAutoPostLimit: Number.isFinite(parsedLimit) && parsedLimit >= 0 ? parsedLimit : 100,
    profile: parseJsonSetting(map.get('clinic_profile_json'), {
      legalName: 'Clinic360 Central Medical Center Ltd.',
      facilityCode: 'C360-MAIN',
      address: '420 Bole Medhanialem Ave, Suite 100',
      phone: '+1 (555) 234-8900',
      email: 'info@clinic360.local',
      operatingHours: 'Mon-Sat 07:30 - 20:00, Emergency 24/7',
      taxId: 'TIN-004921882',
    }),
    clinical: parseJsonSetting(map.get('clinical_config_json'), {
      mrnPrefix: 'C360-',
      visitPrefix: 'VIS-26-',
      defaultSlotMinutes: 20,
      maxDailyPatientsPerDoctor: 35,
      allowWalkInRegistration: true,
      requireVitalsBeforeConsultation: true,
      requirePaymentBeforeConsultation: true,
      vitalReferenceRanges: {
        bpSystolicMin: 90,
        bpSystolicMax: 140,
        bpDiastolicMin: 60,
        bpDiastolicMax: 90,
        tempMinC: 36.1,
        tempMaxC: 37.8,
        pulseMin: 60,
        pulseMax: 100,
        spo2Min: 95,
      },
      autoAssignRoomBySpecialty: true,
    }),
    billing: parseJsonSetting(map.get('billing_config_json'), {
      defaultTaxRatePct: 0,
      cashierMaxDiscountPct: 10,
      requireShiftForCollection: true,
      allowPartialPayments: true,
      allowInsuranceCreditBilling: true,
      receiptFooterNote: 'Thank you for choosing Clinic360 Central Medical Center.',
    }),
    notifications: parseJsonSetting(map.get('notifications_config_json'), {
      enableInAppAlerts: true,
      enableSmsAlerts: false,
      enableEmailAlerts: true,
      notifyDoctorOnAssignment: true,
      notifyNurseOnPaymentClearance: true,
      notifyAdminOnAccessReview: true,
      criticalLabAlertImmediate: true,
    }),
    documents: parseJsonSetting(map.get('documents_config_json'), {
      prescriptionHeader: 'Clinic360 Outpatient Pharmacy & Medical Prescription',
      labReportHeader: 'Clinic360 Accredited Clinical Laboratory Report',
      radiologyHeader: 'Clinic360 Diagnostic Imaging & Radiology Report',
      invoiceHeader: 'Official Clinic360 Tax Invoice & Statement',
      showClinicStampOnPrint: true,
    }),
    security: parseJsonSetting(map.get('security_config_json'), {
      sessionTimeoutMinutes: 720,
      passwordMinLength: 8,
      requireMixedCasePassword: true,
      maxFailedLoginAttempts: 5,
      lockoutDurationMinutes: 15,
      enforce2faForPrivilegedRoles: true,
      allowMultipleActiveSessions: true,
    }),
    lastBackupVerifiedAt: map.get('last_backup_verified_at') || null,
    lastBackupVerifiedBy: map.get('last_backup_verified_by') || null,
  };
}

async function getClinicToday(): Promise<string> {
  const settings = await getClinicSettings();
  return formatClinicDate(settings.timezone);
}

async function assertOpenAccountingPeriod(dateStr: string) {
  const periodCode = String(dateStr || '').slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(periodCode)) return;
  const closedPeriod = await queryOne<{ period_code: string }>(
    "SELECT period_code FROM accounting_periods WHERE period_code = ? AND status = 'closed' LIMIT 1",
    [periodCode]
  );
  if (closedPeriod) {
    const err = new Error(`Accounting period ${periodCode} is closed. Post to an open period instead.`) as Error & { status?: number };
    err.status = 409;
    throw err;
  }
}

async function postJournalEntry(opts: {
  entryDate?: string;
  sourceType: string;
  sourceId?: number | null;
  description: string;
  postedBy: number;
  reversalOfId?: number | null;
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

  const entryDate = opts.entryDate || (await getClinicToday());
  await assertOpenAccountingPeriod(entryDate);

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
  const jeRes = await execute(
    `INSERT INTO journal_entries (entry_number, entry_date, source_type, source_id, description, total_debit, total_credit, reversal_of_id, posted_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [entryNumber, entryDate, opts.sourceType, opts.sourceId ?? null, opts.description, totalDebit, totalCredit, opts.reversalOfId ?? null, opts.postedBy]
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

async function buildPerLineRevenueLines(
  invoiceId: number,
  targetAmount: number,
  side: 'debit' | 'credit',
  memo: string
): Promise<Array<{ accountCode: string; debit?: number; credit?: number; memo?: string }>> {
  const amt = Number(Number(targetAmount || 0).toFixed(2));
  if (amt <= 0) return [];
  const items = await query<{ category: string; total: number }>(
    'SELECT category, COALESCE(SUM(line_total), 0) AS total FROM invoice_items WHERE invoice_id = ? GROUP BY category',
    [invoiceId]
  );
  const byAcct = new Map<string, number>();
  for (const it of items) {
    const acct = revenueAccountForCategory(it.category);
    byAcct.set(acct, (byAcct.get(acct) || 0) + Number(it.total || 0));
  }
  const entries = [...byAcct.entries()].filter(([, v]) => v > 0);
  const sumRaw = entries.reduce((s, [, v]) => s + v, 0);
  if (entries.length === 0 || sumRaw <= 0) {
    return [{ accountCode: '4010', [side]: amt, memo }];
  }

  const out: Array<{ accountCode: string; debit?: number; credit?: number; memo?: string }> = [];
  let allocated = 0;
  for (let i = 0; i < entries.length; i++) {
    const [acct, val] = entries[i];
    const part = i === entries.length - 1 ? Number((amt - allocated).toFixed(2)) : Number(((amt * val) / sumRaw).toFixed(2));
    if (part > 0) {
      allocated = Number((allocated + part).toFixed(2));
      out.push({ accountCode: acct, [side]: part, memo });
    }
  }
  return out.length > 0 ? out : [{ accountCode: '4010', [side]: amt, memo }];
}

async function hasInvoiceAccrualJE(invoiceId: number): Promise<boolean> {
  const row = await queryOne<{ id: number }>(
    `SELECT je.id
     FROM journal_entries je
     LEFT JOIN insurance_claims ic ON je.source_type = 'ar_claim' AND ic.id = je.source_id
     WHERE (je.source_type IN ('invoice', 'ipd_bed') AND je.source_id = ?) OR ic.invoice_id = ?
     LIMIT 1`,
    [invoiceId, invoiceId]
  );
  return Boolean(row);
}

async function postInvoiceAccrualJE(opts: {
  invoiceId: number;
  invoiceNumber: string;
  payerType: string;
  totalAmount: number;
  postedBy: number;
  sourceType?: string;
  description?: string;
}) {
  const total = Number(Number(opts.totalAmount || 0).toFixed(2));
  if (total <= 0 || opts.payerType === 'exempt') return null;
  const arAcct = opts.payerType === 'insurance' || opts.payerType === 'credit' ? '1100' : '1150';
  const revLines = await buildPerLineRevenueLines(opts.invoiceId, total, 'credit', opts.invoiceNumber);
  return postJournalEntry({
    sourceType: opts.sourceType || 'invoice',
    sourceId: opts.invoiceId,
    description: opts.description || `Invoice accrual ${opts.invoiceNumber}`,
    postedBy: opts.postedBy,
    lines: [{ accountCode: arAcct, debit: total, memo: opts.invoiceNumber }, ...revLines],
  });
}

async function checkActiveClinicianLicence(userId: number): Promise<{ valid: boolean; error?: string }> {
  const contract = await queryOne<{ licence_number: string | null; licence_expiry: string | null; status: string }>(
    'SELECT licence_number, licence_expiry, status FROM staff_contracts WHERE user_id = ? LIMIT 1',
    [userId]
  );
  if (!contract) return { valid: true };
  if (contract.status !== 'active') {
    return { valid: false, error: 'Your employment contract is not active. Contact HR.' };
  }
  if (contract.licence_expiry) {
    const today = await getClinicToday();
    if (contract.licence_expiry < today) {
      return {
        valid: false,
        error: `Practice licence (${contract.licence_number || 'on file'}) expired on ${contract.licence_expiry}. Renew with HR before consulting or prescribing.`,
      };
    }
  }
  return { valid: true };
}

async function recordPaymentGateBypass(opts: {
  visitId: number;
  patientId: number;
  entityType: string;
  entityId: number;
  user: AuthUser;
  reason: string;
  req: Request;
}) {
  await execute(
    `INSERT INTO payment_gate_bypasses (visit_id, patient_id, entity_type, entity_id, set_by, reason, follow_up_status)
     VALUES (?, ?, ?, ?, ?, ?, 'pending_billing')`,
    [opts.visitId, opts.patientId, opts.entityType, opts.entityId, opts.user.id, opts.reason]
  );
  await writeAuditLog({
    user: opts.user,
    action: 'payment.gate.bypass',
    entityType: opts.entityType,
    entityId: opts.entityId,
    patientId: opts.patientId,
    reason: opts.reason,
    after: { visitId: opts.visitId },
    req: opts.req,
  });
}

async function closeVisit(opts: {
  visitId: number;
  user: AuthUser;
  req: Request;
  forcePartialClose?: boolean;
  forceReason?: string;
}): Promise<{ ok: true } | { ok: false; error: string; httpStatus: number }> {
  const visit = await queryOne<{
    id: number;
    patient_id: number;
    appointment_id: number | null;
    diagnosis_text: string | null;
    status: string;
  }>('SELECT id, patient_id, appointment_id, diagnosis_text, status FROM visits WHERE id = ?', [opts.visitId]);
  if (!visit) return { ok: false, error: 'Visit not found', httpStatus: 404 };
  if (visit.status === 'closed') return { ok: true };
  if (!visit.diagnosis_text?.trim()) {
    return { ok: false, error: 'Diagnosis is required before closing a visit.', httpStatus: 400 };
  }

  const [openLab, openImg, openRx] = await Promise.all([
    queryOne<{ cnt: number }>("SELECT COUNT(*) AS cnt FROM lab_orders WHERE visit_id = ? AND status IN ('ordered','collected','resulted')", [opts.visitId]),
    queryOne<{ cnt: number }>("SELECT COUNT(*) AS cnt FROM imaging_orders WHERE visit_id = ? AND status IN ('ordered','scheduled','performed','reported_draft')", [opts.visitId]),
    queryOne<{ cnt: number }>("SELECT COUNT(*) AS cnt FROM prescriptions WHERE visit_id = ? AND status IN ('awaiting_stock_check','pending_payment','pending','paid_ready_to_dispense')", [opts.visitId]),
  ]);

  const remaining = Number(openLab?.cnt || 0) + Number(openImg?.cnt || 0) + Number(openRx?.cnt || 0);
  if (remaining > 0) {
    if (!opts.forcePartialClose) {
      return {
        ok: false,
        error: `Visit has ${remaining} incomplete lab, imaging, or pharmacy order(s). Complete or cancel them first, or provide force_partial_close with reason.`,
        httpStatus: 409,
      };
    }
    if (!opts.forceReason || opts.forceReason.trim().length < 5) {
      return { ok: false, error: 'Partial visit closure requires a formal clinical reason (min 5 characters).', httpStatus: 400 };
    }
  }

  await execute("UPDATE visits SET status = 'closed', workflow_stage = 'completed', closed_at = ?, closed_by = ? WHERE id = ?", [
    nowSql(),
    opts.user.id,
    opts.visitId,
  ]);
  await execute("UPDATE queue_tickets SET status = 'completed' WHERE visit_id = ?", [opts.visitId]);
  if (visit.appointment_id) {
    await execute("UPDATE appointments SET status = 'completed' WHERE id = ? AND status != 'cancelled'", [visit.appointment_id]);
  }

  await writeAuditLog({
    user: opts.user,
    action: 'visit.close',
    entityType: 'visit',
    entityId: opts.visitId,
    patientId: visit.patient_id,
    reason: opts.forcePartialClose ? opts.forceReason || null : null,
    after: { forcedPartial: Boolean(opts.forcePartialClose && remaining > 0), remainingOrders: remaining },
    req: opts.req,
  });

  broadcastClinicEvent('visit:updated', { visitId: opts.visitId });
  broadcastClinicEvent('queue:updated', { visitId: opts.visitId });
  return { ok: true };
}

async function syncMedicineFromBatches(medicineId: number) {
  const today = await getClinicToday();
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
  targetUserId?: number | null;
  title: string;
  message: string;
  severity?: 'info' | 'warning' | 'critical';
  entityType?: string;
  entityId?: number;
}) {
  await execute(
    'INSERT INTO notifications (target_role, target_user_id, title, message, severity, entity_type, entity_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [
      opts.targetRole,
      opts.targetUserId ?? null,
      opts.title,
      opts.message,
      opts.severity || 'info',
      opts.entityType || null,
      opts.entityId ?? null,
    ]
  );
  broadcastClinicEvent('notification:created', {
    targetRole: opts.targetRole,
    targetUserId: opts.targetUserId ?? null,
    title: opts.title,
    severity: opts.severity || 'info',
  });
}

router.get('/health', async (_req, res) => {
  try {
    await queryOne('SELECT 1 AS ok');
    res.json({ ok: true, db: 'connected', dialect: getDialect(), service: 'Clinic360 API' });
  } catch {
    res.status(503).json({ ok: false, db: 'disconnected', dialect: getDialect(), service: 'Clinic360 API' });
  }
});

router.post('/events/ticket', requireAuth, (req: AuthRequest, res: Response) => {
  const ticket = createRealtimeTicket(req.user!.id);
  res.json({ ticket });
});

router.get('/events/stream', requireAuth, (req: AuthRequest, res: Response) => {
  registerRealtimeClient(req, res, { id: req.user!.id, roles: req.user!.roles });
});

router.get('/settings/public', async (_req, res) => {
  const s = await getClinicSettings();
  res.json({
    clinicName: s.clinicName,
    currencyCode: s.currencyCode,
    currencySymbol: s.currencySymbol,
    timezone: s.timezone,
  });
});

router.get('/admin/settings', requireAuth, requirePermission('admin.user.manage', 'admin.config.manage', 'catalog.manage'), async (_req, res) => {
  const settings = await getClinicSettings();
  res.json({ settings });
});

router.put('/admin/settings', requireAuth, requirePermission('admin.user.manage', 'admin.config.manage'), async (req: AuthRequest, res: Response) => {
  const {
    clinicName,
    currencyCode,
    currencySymbol,
    timezone,
    expenseAutoPostLimit,
    profile,
    clinical,
    billing,
    notifications,
    documents,
    security,
  } = req.body || {};
  const updates: Array<[string, string]> = [];
  if (typeof clinicName === 'string' && clinicName.trim()) updates.push(['clinic_name', clinicName.trim()]);
  if (typeof currencyCode === 'string' && currencyCode.trim()) updates.push(['currency_code', currencyCode.trim().toUpperCase()]);
  if (typeof currencySymbol === 'string' && currencySymbol.trim()) updates.push(['currency_symbol', currencySymbol.trim()]);
  if (typeof timezone === 'string' && timezone.trim()) updates.push(['timezone', timezone.trim()]);
  if (expenseAutoPostLimit !== undefined && Number(expenseAutoPostLimit) >= 0) {
    updates.push(['expense_auto_post_limit', String(Number(expenseAutoPostLimit))]);
  }
  if (profile && typeof profile === 'object') updates.push(['clinic_profile_json', JSON.stringify(profile)]);
  if (clinical && typeof clinical === 'object') updates.push(['clinical_config_json', JSON.stringify(clinical)]);
  if (billing && typeof billing === 'object') updates.push(['billing_config_json', JSON.stringify(billing)]);
  if (notifications && typeof notifications === 'object') updates.push(['notifications_config_json', JSON.stringify(notifications)]);
  if (documents && typeof documents === 'object') updates.push(['documents_config_json', JSON.stringify(documents)]);
  if (security && typeof security === 'object') updates.push(['security_config_json', JSON.stringify(security)]);

  for (const [k, v] of updates) {
    const existing = await queryOne('SELECT setting_key FROM system_settings WHERE setting_key = ?', [k]);
    if (existing) {
      await execute('UPDATE system_settings SET setting_value = ?, updated_by = ?, updated_at = ? WHERE setting_key = ?', [
        v,
        req.user!.id,
        nowSql(),
        k,
      ]);
    } else {
      await execute('INSERT INTO system_settings (setting_key, setting_value, updated_by, updated_at) VALUES (?, ?, ?, ?)', [
        k,
        v,
        req.user!.id,
        nowSql(),
      ]);
    }
  }

  await writeAuditLog({
    user: req.user,
    action: 'admin.settings.update',
    entityType: 'system_settings',
    entityId: 'global',
    after: Object.fromEntries(updates.map(([k]) => [k, k.endsWith('_json') ? 'updated' : updates.find(([uk]) => uk === k)?.[1]])),
    req,
  });

  res.json({ settings: await getClinicSettings() });
});

// ---------------------------------------------------------------------------
// AUTHENTICATION & NOTIFICATIONS
// ---------------------------------------------------------------------------
router.get('/auth/demo-accounts', async (_req, res) => {
  if (process.env.NODE_ENV === 'production' && process.env.SEED_DEMO !== 'true') {
    return res.json({ accounts: [] });
  }
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

  const { email, username, password } = req.body || {};
  const identifier = String(email || username || '').trim().toLowerCase();
  if (!identifier || !password) {
    return res.status(400).json({ error: 'Email or username and password are required.' });
  }

  const user = await queryOne<{
    id: number;
    employee_id: number | null;
    full_name: string;
    email: string;
    username: string | null;
    password_hash: string;
    active: number;
    status: string | null;
    failed_attempts: number;
    locked_until: string | null;
    branch_id: number;
  }>('SELECT * FROM users WHERE LOWER(email) = ? OR LOWER(username) = ? LIMIT 1', [identifier, identifier]);

  if (!user) {
    await writeAuditLog({
      action: 'auth.login.failed',
      entityType: 'user',
      entityId: identifier,
      after: { reason: 'unknown_identifier' },
      req,
    });
    return res.status(401).json({ error: 'Invalid credentials.' });
  }

  if (!user.active || user.status === 'inactive') {
    return res.status(403).json({ error: 'Account is deactivated. Contact your administrator.' });
  }
  if (user.status === 'locked') {
    return res.status(423).json({ error: 'Account is locked by administrator.' });
  }

  if (user.locked_until) {
    const lockIso = user.locked_until.includes('T') ? user.locked_until : `${user.locked_until.replace(' ', 'T')}Z`;
    if (new Date(lockIso).getTime() > now) {
      return res.status(423).json({ error: 'Account temporarily locked due to failed logins.' });
    }
  }

  const hrEmp = await getLinkedHrEmployeeStatus(user.id, user.employee_id ?? null);
  if (hrEmp && hrEmp.status !== 'active') {
    await writeAuditLog({
      user: { id: user.id, fullName: user.full_name, roles: [], branchId: user.branch_id },
      action: 'auth.login.blocked_hr_offboarded',
      entityType: 'user',
      entityId: user.id,
      after: { hrEmployeeId: hrEmp.id, hrStatus: hrEmp.status },
      req,
    });
    return res.status(403).json({ error: 'Account access suspended: linked HR employee record is inactive or offboarded.' });
  }

  const settings = await getClinicSettings();
  const maxFailed = Math.max(3, Number(settings.security?.maxFailedLoginAttempts || 5));
  const lockoutMinutes = Math.max(5, Number(settings.security?.lockoutDurationMinutes || 15));
  const sessionMinutes = Math.max(15, Number(settings.security?.sessionTimeoutMinutes || 720));

  const valid = await bcrypt.compare(String(password), user.password_hash);
  if (!valid) {
    const nextFails = user.failed_attempts + 1;
    const shouldLock = nextFails >= maxFailed;
    const lockUntil = shouldLock ? nowSql(new Date(now + lockoutMinutes * 60_000)) : null;
    await execute('UPDATE users SET failed_attempts = ?, locked_until = ?, status = ? WHERE id = ?', [
      nextFails,
      lockUntil,
      shouldLock ? 'locked' : user.status || 'active',
      user.id,
    ]);
    await writeAuditLog({
      user: { id: user.id, fullName: user.full_name, roles: [], branchId: user.branch_id },
      action: 'auth.login.failed',
      entityType: 'user',
      entityId: user.id,
      after: { failedAttempts: nextFails, locked: shouldLock },
      req,
    });
    return res.status(401).json({ error: 'Invalid credentials.' });
  }

  await execute("UPDATE users SET failed_attempts = 0, locked_until = NULL, status = 'active', last_login_at = ? WHERE id = ?", [
    nowSql(),
    user.id,
  ]);

  const ctx = await loadUserContext(user.id);
  if (!ctx) {
    return res.status(403).json({ error: 'Unable to load user permissions or account is inactive.' });
  }

  if (ctx.twoFaEnabled) {
    const challengeId = crypto.randomBytes(12).toString('hex');
    const code = String(crypto.randomInt(100000, 999999));
    const expiresAt = nowSql(new Date(Date.now() + 10 * 60_000));
    await execute(
      'INSERT INTO auth_2fa_challenges (id, user_id, email, code, attempts, expires_at) VALUES (?, ?, ?, ?, 0, ?)',
      [challengeId, ctx.id, ctx.email, code, expiresAt]
    );
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

  if (settings.security?.allowMultipleActiveSessions === false) {
    await revokeAllUserSessions(ctx.id, ctx.id);
  }
  const { token } = await issueSessionToken(ctx, req, sessionMinutes);
  setSessionCookie(req, res, token, sessionMinutes);
  await writeAuditLog({
    user: ctx,
    action: 'auth.login.success',
    entityType: 'user',
    entityId: ctx.id,
    req,
  });

  res.json({
    token,
    user: ctx,
    roles: ctx.roles,
    permissions: ctx.permissions,
    departments: ctx.departments,
    clinic_units: ctx.clinicUnits,
    dashboard_type: ctx.defaultDashboard,
    defaultDashboard: ctx.defaultDashboard,
    authorizedDashboards: ctx.authorizedDashboards,
    dialect: getDialect(),
  });
});

router.post('/auth/verify-2fa', async (req, res) => {
  const ip = req.ip || '127.0.0.1';
  if (isRateLimited(twoFaAttemptsByIp, ip, 15, 60_000)) {
    return res.status(429).json({ error: 'Too many 2FA verification requests. Please wait a minute.' });
  }
  const { challengeId, code } = req.body || {};
  if (!challengeId || !code) {
    return res.status(400).json({ error: 'Verification challenge and 6-digit code are required.' });
  }
  const challenge = await queryOne<{
    id: string;
    user_id: number;
    email: string;
    code: string;
    attempts: number;
    expires_at: string;
  }>('SELECT * FROM auth_2fa_challenges WHERE id = ?', [String(challengeId)]);

  if (!challenge) {
    return res.status(401).json({ error: '2FA challenge expired or invalid. Please sign in again.' });
  }
  const expMs = new Date(`${String(challenge.expires_at).replace(' ', 'T')}Z`).getTime();
  if (expMs < Date.now()) {
    await execute('DELETE FROM auth_2fa_challenges WHERE id = ?', [challenge.id]);
    return res.status(401).json({ error: '2FA challenge expired or invalid. Please sign in again.' });
  }
  if (Number(challenge.attempts) >= 5) {
    await execute('DELETE FROM auth_2fa_challenges WHERE id = ?', [challenge.id]);
    return res.status(429).json({ error: 'Too many invalid 2FA attempts. Sign in again to get a new code.' });
  }

  const ctx = await loadUserContext(challenge.user_id);
  if (!ctx) {
    return res.status(403).json({ error: 'Unable to load user permissions or account is inactive.' });
  }

  if (String(code).trim() !== challenge.code) {
    await execute('UPDATE auth_2fa_challenges SET attempts = attempts + 1 WHERE id = ?', [challenge.id]);
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

  await execute('DELETE FROM auth_2fa_challenges WHERE id = ?', [challenge.id]);
  const settings = await getClinicSettings();
  const sessionMinutes = Math.max(15, Number(settings.security?.sessionTimeoutMinutes || 720));
  if (settings.security?.allowMultipleActiveSessions === false) {
    await revokeAllUserSessions(ctx.id, ctx.id);
  }
  const { token } = await issueSessionToken(ctx, req, sessionMinutes);
  setSessionCookie(req, res, token, sessionMinutes);
  await writeAuditLog({
    user: ctx,
    action: 'auth.2fa.verified',
    entityType: 'user',
    entityId: ctx.id,
    req,
  });
  res.json({
    token,
    user: ctx,
    roles: ctx.roles,
    permissions: ctx.permissions,
    departments: ctx.departments,
    clinic_units: ctx.clinicUnits,
    dashboard_type: ctx.defaultDashboard,
    defaultDashboard: ctx.defaultDashboard,
    authorizedDashboards: ctx.authorizedDashboards,
    dialect: getDialect(),
  });
});

router.post('/auth/forgot-password', async (req, res) => {
  const ip = req.ip || '127.0.0.1';
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (isRateLimited(passwordResetAttemptsByIp, `fp:${ip}`, 10, 60_000) || (email && isRateLimited(passwordResetAttemptsByIp, `fp:${email}`, 5, 60_000))) {
    return res.status(429).json({ error: 'Too many password reset requests. Please wait a minute.' });
  }
  if (!email) return res.status(400).json({ error: 'Email is required.' });

  const user = await queryOne<{ id: number; employee_id: number | null; full_name: string; active: number; status: string | null }>(
    'SELECT id, employee_id, full_name, active, status FROM users WHERE LOWER(email) = ?',
    [email]
  );
  if (!user || !user.active || user.status === 'inactive') {
    return res.json({ ok: true, message: 'If an active account matches that email, a reset token has been generated.' });
  }
  const hrEmp = await getLinkedHrEmployeeStatus(user.id, user.employee_id ?? null);
  if (hrEmp && hrEmp.status !== 'active') {
    return res.json({ ok: true, message: 'If an active account matches that email, a reset token has been generated.' });
  }

  const rawToken = crypto.randomBytes(24).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = nowSql(new Date(Date.now() + 30 * 60_000));
  await execute('INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)', [
    user.id,
    tokenHash,
    expiresAt,
  ]);
  await writeAuditLog({
    user: { id: user.id, fullName: user.full_name, roles: [] },
    action: 'auth.password.reset_requested',
    entityType: 'user',
    entityId: user.id,
    req,
  });

  res.json({
    ok: true,
    message: 'If an active account matches that email, a reset token has been generated.',
    devResetToken: process.env.NODE_ENV === 'production' ? undefined : rawToken,
  });
});

router.post('/auth/reset-password', async (req, res) => {
  const ip = req.ip || '127.0.0.1';
  if (isRateLimited(passwordResetAttemptsByIp, `rp:${ip}`, 15, 60_000)) {
    return res.status(429).json({ error: 'Too many password reset attempts. Please wait a minute.' });
  }
  const { token, newPassword } = req.body || {};
  if (!token || !newPassword) {
    return res.status(400).json({ error: 'Reset token and newPassword are required.' });
  }
  const settings = await getClinicSettings();
  const policyErr = validatePasswordPolicy(String(newPassword), settings.security);
  if (policyErr) {
    return res.status(400).json({ error: policyErr });
  }
  const tokenHash = crypto.createHash('sha256').update(String(token).trim()).digest('hex');
  const rec = await queryOne<{ id: number; user_id: number; expires_at: string; used_at: string | null }>(
    'SELECT id, user_id, expires_at, used_at FROM password_reset_tokens WHERE token_hash = ? LIMIT 1',
    [tokenHash]
  );
  if (!rec || rec.used_at || rec.expires_at <= nowSql()) {
    return res.status(400).json({ error: 'Password reset token is invalid or has expired.' });
  }
  const userRow = await queryOne<{ id: number; employee_id: number | null; active: number; status: string | null }>(
    'SELECT id, employee_id, active, status FROM users WHERE id = ?',
    [rec.user_id]
  );
  if (!userRow || !userRow.active || userRow.status === 'inactive') {
    return res.status(403).json({ error: 'Account is deactivated and cannot complete password reset.' });
  }
  const hrEmp = await getLinkedHrEmployeeStatus(userRow.id, userRow.employee_id ?? null);
  if (hrEmp && hrEmp.status !== 'active') {
    return res.status(403).json({ error: 'Linked HR employee record is not active.' });
  }

  const nextHash = await bcrypt.hash(String(newPassword), 12);
  await withTransaction(async () => {
    await execute('UPDATE users SET password_hash = ?, must_change_password = 0, failed_attempts = 0, locked_until = NULL WHERE id = ?', [
      nextHash,
      rec.user_id,
    ]);
    await execute('UPDATE password_reset_tokens SET used_at = ? WHERE id = ?', [nowSql(), rec.id]);
  });
  await revokeAllUserSessions(rec.user_id, rec.user_id);

  await writeAuditLog({
    action: 'auth.password.reset_completed',
    entityType: 'user',
    entityId: rec.user_id,
    req,
  });
  res.json({ ok: true });
});

router.post('/auth/change-password', requireAuth, async (req: AuthRequest, res: Response) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current password and new password are required.' });
  }
  const settings = await getClinicSettings();
  const policyErr = validatePasswordPolicy(String(newPassword), settings.security);
  if (policyErr) {
    return res.status(400).json({ error: policyErr });
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
    return res.status(400).json({ error: 'New password must be different from your current password.' });
  }

  const nextHash = await bcrypt.hash(String(newPassword), 12);
  await execute('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?', [nextHash, req.user!.id]);
  await revokeAllUserSessions(req.user!.id, req.user!.id, req.authJti ?? null);

  await writeAuditLog({
    user: req.user,
    action: 'auth.password.changed',
    entityType: 'user',
    entityId: req.user!.id,
    req,
  });

  const updatedCtx = await loadUserContext(req.user!.id);
  res.json({
    ok: true,
    user: updatedCtx,
    roles: updatedCtx?.roles ?? [],
    permissions: updatedCtx?.permissions ?? [],
    departments: updatedCtx?.departments ?? [],
    clinic_units: updatedCtx?.clinicUnits ?? [],
    dashboard_type: updatedCtx?.defaultDashboard ?? 'general',
    defaultDashboard: updatedCtx?.defaultDashboard ?? 'general',
    authorizedDashboards: updatedCtx?.authorizedDashboards ?? [],
  });
});

router.get('/auth/me', requireAuth, async (req: AuthRequest, res: Response) => {
  const ctx = req.user!;
  res.json({
    user: ctx,
    roles: ctx.roles,
    permissions: ctx.permissions,
    departments: ctx.departments,
    clinic_units: ctx.clinicUnits,
    dashboard_type: ctx.defaultDashboard,
    defaultDashboard: ctx.defaultDashboard,
    authorizedDashboards: ctx.authorizedDashboards,
    dialect: getDialect(),
  });
});

router.post('/auth/logout', requireAuth, async (req: AuthRequest, res: Response) => {
  await revokeToken(req.authJti, req.authExp, req.user?.id);
  clearSessionCookie(req, res);
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
  const doctorScoped = isDoctorOnly(req.user!);
  const placeholders = roles.map(() => '?').join(',');
  const notifications = doctorScoped
    ? await query(
        `SELECT * FROM notifications
         WHERE (target_user_id = ? OR (target_user_id IS NULL AND target_role = 'ALL'))
         ORDER BY id DESC LIMIT 25`,
        [req.user!.id]
      )
    : await query(
        `SELECT * FROM notifications
         WHERE (target_user_id = ? OR (target_user_id IS NULL AND (target_role IN (${placeholders}) OR target_role = 'ALL')))
         ORDER BY id DESC LIMIT 25`,
        [req.user!.id, ...roles]
      );
  const unreadCount = notifications.filter((n) => (n as { is_read: number }).is_read === 0).length;
  res.json({ notifications, unreadCount });
});

router.post('/notifications/:id/read', requireAuth, async (req: AuthRequest, res: Response) => {
  const roles = req.user!.roles;
  if (roles.length === 0) return res.json({ ok: true });
  const doctorScoped = isDoctorOnly(req.user!);
  const placeholders = roles.map(() => '?').join(',');
  if (doctorScoped) {
    await execute(
      `UPDATE notifications SET is_read = 1
       WHERE id = ? AND (target_user_id = ? OR (target_user_id IS NULL AND target_role = 'ALL'))`,
      [Number(req.params.id), req.user!.id]
    );
  } else {
    await execute(
      `UPDATE notifications SET is_read = 1
       WHERE id = ? AND (target_user_id = ? OR (target_user_id IS NULL AND (target_role IN (${placeholders}) OR target_role = 'ALL')))`,
      [Number(req.params.id), req.user!.id, ...roles]
    );
  }
  res.json({ ok: true });
});

router.post('/notifications/read-all', requireAuth, async (req: AuthRequest, res: Response) => {
  const roles = req.user!.roles;
  if (roles.length > 0) {
    const doctorScoped = isDoctorOnly(req.user!);
    const placeholders = roles.map(() => '?').join(',');
    if (doctorScoped) {
      await execute(
        `UPDATE notifications SET is_read = 1
         WHERE (target_user_id = ? OR (target_user_id IS NULL AND target_role = 'ALL'))`,
        [req.user!.id]
      );
    } else {
      await execute(
        `UPDATE notifications SET is_read = 1
         WHERE (target_user_id = ? OR (target_user_id IS NULL AND (target_role IN (${placeholders}) OR target_role = 'ALL')))`,
        [req.user!.id, ...roles]
      );
    }
  }
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// DASHBOARD & CATALOGS
// ---------------------------------------------------------------------------
router.get('/dashboard', requireAuth, async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const today = await getClinicToday();
  const doctorScoped = isDoctorOnly(user);

  const patientCount = doctorScoped
    ? await queryOne<{ cnt: number }>(
        `SELECT COUNT(DISTINCT p.id) AS cnt FROM patients p
         WHERE p.status = 'active'
           AND (
             EXISTS (SELECT 1 FROM visits v WHERE v.patient_id = p.id AND v.doctor_id = ?)
             OR EXISTS (SELECT 1 FROM appointments a WHERE a.patient_id = p.id AND a.doctor_id = ? AND a.status != 'cancelled')
             OR EXISTS (SELECT 1 FROM admissions adm WHERE adm.patient_id = p.id AND adm.admitting_doctor_id = ? AND adm.status = 'admitted')
           )`,
        [user.id, user.id, user.id]
      )
    : await queryOne<{ cnt: number }>("SELECT COUNT(*) AS cnt FROM patients WHERE status = 'active'");

  const todayAppts = doctorScoped
    ? await queryOne<{ cnt: number }>(
        "SELECT COUNT(*) AS cnt FROM appointments WHERE appointment_date = ? AND status != 'cancelled' AND doctor_id = ?",
        [today, user.id]
      )
    : await queryOne<{ cnt: number }>(
        "SELECT COUNT(*) AS cnt FROM appointments WHERE appointment_date = ? AND status != 'cancelled'",
        [today]
      );

  const activeQueue = doctorScoped
    ? await queryOne<{ cnt: number }>(
        `SELECT COUNT(*) AS cnt FROM queue_tickets q
         INNER JOIN visits v ON v.id = q.visit_id
         WHERE q.status IN ('waiting','called','in_service') AND v.doctor_id = ?`,
        [user.id]
      )
    : await queryOne<{ cnt: number }>(
        "SELECT COUNT(*) AS cnt FROM queue_tickets WHERE status IN ('waiting','called','in_service')"
      );

  const openVisits = doctorScoped
    ? await queryOne<{ cnt: number }>("SELECT COUNT(*) AS cnt FROM visits WHERE status != 'closed' AND doctor_id = ?", [user.id])
    : await queryOne<{ cnt: number }>("SELECT COUNT(*) AS cnt FROM visits WHERE status != 'closed'");

  const pendingLabs = doctorScoped
    ? await queryOne<{ cnt: number }>(
        `SELECT COUNT(*) AS cnt FROM lab_orders lo
         INNER JOIN visits v ON v.id = lo.visit_id
         WHERE lo.status IN ('ordered','collected','resulted') AND v.doctor_id = ?`,
        [user.id]
      )
    : await queryOne<{ cnt: number }>(
        "SELECT COUNT(*) AS cnt FROM lab_orders WHERE status IN ('ordered','collected','resulted')"
      );

  const pendingImaging = doctorScoped
    ? await queryOne<{ cnt: number }>(
        `SELECT COUNT(*) AS cnt FROM imaging_orders io
         INNER JOIN visits v ON v.id = io.visit_id
         WHERE io.status IN ('ordered','scheduled','performed','reported_draft') AND v.doctor_id = ?`,
        [user.id]
      )
    : await queryOne<{ cnt: number }>(
        "SELECT COUNT(*) AS cnt FROM imaging_orders WHERE status IN ('ordered','scheduled','performed','reported_draft')"
      );

  const pendingRx = doctorScoped
    ? await queryOne<{ cnt: number }>(
        `SELECT COUNT(*) AS cnt FROM prescriptions pr
         LEFT JOIN visits v ON v.id = pr.visit_id
         WHERE pr.status IN ('awaiting_stock_check','pending_payment','pending','paid_ready_to_dispense')
           AND (v.doctor_id = ? OR pr.doctor_id = ?)`,
        [user.id, user.id]
      )
    : await queryOne<{ cnt: number }>(
        "SELECT COUNT(*) AS cnt FROM prescriptions WHERE status IN ('awaiting_stock_check','pending_payment','pending','paid_ready_to_dispense')"
      );

  const pendingApprovals = hasPermission(user, 'approval.decide') || hasPermission(user, 'approval.request')
    ? await queryOne<{ cnt: number }>("SELECT COUNT(*) AS cnt FROM approval_requests WHERE status = 'pending'")
    : { cnt: 0 };
  const occupiedBeds = await queryOne<{ cnt: number }>("SELECT COUNT(*) AS cnt FROM beds WHERE status = 'occupied'");
  const totalBeds = await queryOne<{ cnt: number }>("SELECT COUNT(*) AS cnt FROM beds WHERE status != 'out_of_service'");

  const canSeeFinance =
    hasPermission(user, 'finance.report.view') ||
    hasPermission(user, 'billing.payment.create') ||
    hasPermission(user, 'accounting.ledger.manage') ||
    hasPermission(user, 'finance.bank.manage') ||
    hasPermission(user, 'accounting.expense.create');
  let revenueTotal = 0;
  let unpaidBalance = 0;
  let financialSnapshot: {
    totalInvoicedRevenue: number;
    collectedInvoiceRevenue: number;
    unpaidInvoiceBalance: number;
    invoiceCount: number;
    totalExpenses: number;
    paidExpenses: number;
    pendingExpenseCount: number;
    expenseCount: number;
    cashOnHand: number;
    cashVaultBalance: number;
    cashDrawerNet: number;
    bankBalance: number;
  } | null = null;

  if (canSeeFinance) {
    const [revRow, invStats, expStats, cashBankStats, cashGlRow] = await Promise.all([
      queryOne<{ total: number }>(
        "SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE status IN ('completed','refunded')"
      ),
      queryOne<{
        total_invoiced: number;
        total_collected: number;
        unpaid_balance: number;
        invoice_count: number;
      }>(
        `SELECT
           COALESCE(SUM(CASE WHEN status NOT IN ('voided','refunded') THEN total_amount ELSE 0 END), 0) AS total_invoiced,
           COALESCE(SUM(CASE WHEN status NOT IN ('voided','refunded') THEN paid_amount ELSE 0 END), 0) AS total_collected,
           COALESCE(SUM(CASE WHEN status IN ('unpaid','partial') THEN (total_amount - paid_amount) ELSE 0 END), 0) AS unpaid_balance,
           COUNT(CASE WHEN status NOT IN ('voided','refunded') THEN 1 END) AS invoice_count
         FROM invoices`
      ),
      queryOne<{
        total_expenses: number;
        paid_expenses: number;
        pending_count: number;
        voucher_count: number;
      }>(
        `SELECT
           COALESCE(SUM(CASE WHEN status != 'rejected' THEN amount ELSE 0 END), 0) AS total_expenses,
           COALESCE(SUM(CASE WHEN status != 'rejected' THEN (CASE WHEN status = 'paid' AND paid_amount = 0 THEN amount ELSE paid_amount END) ELSE 0 END), 0) AS paid_expenses,
           COUNT(CASE WHEN status = 'pending' THEN 1 END) AS pending_count,
           COUNT(CASE WHEN status != 'rejected' THEN 1 END) AS voucher_count
         FROM expense_vouchers`
      ),
      queryOne<{
        cash_opening: number;
        cash_current: number;
        bank_current: number;
      }>(
        `SELECT
           COALESCE(SUM(CASE WHEN active = 1 AND account_type = 'cash' THEN opening_balance ELSE 0 END), 0) AS cash_opening,
           COALESCE(SUM(CASE WHEN active = 1 AND account_type = 'cash' THEN current_balance ELSE 0 END), 0) AS cash_current,
           COALESCE(SUM(CASE WHEN active = 1 AND account_type = 'bank' THEN current_balance ELSE 0 END), 0) AS bank_current
         FROM finance_cash_bank_accounts`
      ),
      queryOne<{ gl_net: number }>(
        `SELECT COALESCE(SUM(jl.debit - jl.credit), 0) AS gl_net
         FROM journal_lines jl
         INNER JOIN chart_of_accounts coa ON coa.id = jl.account_id
         WHERE coa.code = '1010'
            OR coa.code IN (SELECT DISTINCT coa_code FROM finance_cash_bank_accounts WHERE active = 1 AND account_type = 'cash')`
      ),
    ]);

    revenueTotal = Number(revRow?.total || 0);
    unpaidBalance = Number(invStats?.unpaid_balance || 0);

    const cashVaultOpening = Number(cashBankStats?.cash_opening || 0);
    const cashVaultBalance = Number(cashBankStats?.cash_current || 0);
    const cashGlNet = Number(cashGlRow?.gl_net || 0);
    const cashOnHand = Number((cashVaultOpening + cashGlNet).toFixed(2));
    const cashDrawerNet = Number((cashOnHand - cashVaultBalance).toFixed(2));

    financialSnapshot = {
      totalInvoicedRevenue: Number(Number(invStats?.total_invoiced || 0).toFixed(2)),
      collectedInvoiceRevenue: Number(Number(invStats?.total_collected || 0).toFixed(2)),
      unpaidInvoiceBalance: Number(unpaidBalance.toFixed(2)),
      invoiceCount: Number(invStats?.invoice_count || 0),
      totalExpenses: Number(Number(expStats?.total_expenses || 0).toFixed(2)),
      paidExpenses: Number(Number(expStats?.paid_expenses || 0).toFixed(2)),
      pendingExpenseCount: Number(expStats?.pending_count || 0),
      expenseCount: Number(expStats?.voucher_count || 0),
      cashOnHand,
      cashVaultBalance: Number(cashVaultBalance.toFixed(2)),
      cashDrawerNet,
      bankBalance: Number(Number(cashBankStats?.bank_current || 0).toFixed(2)),
    };
  }

  const recentQueue = hasPermission(user, 'queue.manage') || hasPermission(user, 'visit.read') || hasPermission(user, 'patient.read')
    ? doctorScoped
      ? await query(
          `SELECT q.id, q.ticket_number, q.department, q.priority, q.status, q.created_at,
                  p.mrn, p.first_name, p.last_name
           FROM queue_tickets q
           INNER JOIN patients p ON p.id = q.patient_id
           INNER JOIN visits v ON v.id = q.visit_id
           WHERE q.status IN ('waiting','called','in_service') AND v.doctor_id = ?
           ORDER BY CASE q.priority WHEN 'emergency' THEN 1 WHEN 'urgent' THEN 2 ELSE 3 END, q.id ASC
           LIMIT 8`,
          [user.id]
        )
      : await query(
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
         WHERE a.appointment_date >= ? AND a.status IN ('scheduled','checked_in')${doctorScoped ? ' AND a.doctor_id = ?' : ''}
         ORDER BY a.appointment_date ASC, a.start_time ASC
         LIMIT 8`,
        doctorScoped ? [today, user.id] : [today]
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
      isDoctorScoped: doctorScoped,
    },
    financialSnapshot,
    recentQueue,
    upcomingAppointments,
  });
});

router.get(
  '/dashboard/admin',
  requireAuth,
  requirePermission('admin.user.manage', 'audit.read', 'admin.config.manage'),
  async (_req: AuthRequest, res: Response) => {
    const nowStr = formatUtcSqlDatetime();
    const [
      totalUsersRow,
      activeUsersRow,
      inactiveUsersRow,
      lockedUsersRow,
      hrActiveRow,
      unlinkedHrRow,
      accessReviewRow,
      activeRolesRow,
      activeDeptsRow,
      activeRoomsRow,
      activeSessionsRow,
      audit24hRow,
      recentAudits,
      pendingAccessUsers,
    ] = await Promise.all([
      queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM users'),
      queryOne<{ cnt: number }>("SELECT COUNT(*) AS cnt FROM users WHERE active = 1 AND (status IS NULL OR status = 'active')"),
      queryOne<{ cnt: number }>("SELECT COUNT(*) AS cnt FROM users WHERE active = 0 OR status = 'inactive'"),
      queryOne<{ cnt: number }>(
        "SELECT COUNT(*) AS cnt FROM users WHERE status = 'locked' OR (locked_until IS NOT NULL AND locked_until > ?)",
        [nowStr]
      ),
      queryOne<{ cnt: number }>("SELECT COUNT(*) AS cnt FROM hr_employees WHERE status = 'active'"),
      queryOne<{ cnt: number }>("SELECT COUNT(*) AS cnt FROM hr_employees WHERE status = 'active' AND user_id IS NULL"),
      queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM hr_employees WHERE access_review_required = 1'),
      queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM roles'),
      queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM departments WHERE active = 1'),
      queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM clinic_rooms WHERE active = 1'),
      queryOne<{ cnt: number }>(
        'SELECT COUNT(*) AS cnt FROM user_sessions WHERE revoked_at IS NULL AND expires_at > ?',
        [nowStr]
      ),
      queryOne<{ cnt: number }>(
        'SELECT COUNT(*) AS cnt FROM audit_logs WHERE occurred_at >= ?',
        [formatUtcSqlDatetime(new Date(Date.now() - 24 * 3600_000))]
      ),
      query(
        `SELECT id, occurred_at, user_name, role_at_time, action, entity_type, entity_id, reason
         FROM audit_logs
         ORDER BY id DESC
         LIMIT 12`
      ),
      query(
        `SELECT he.id AS employee_id, he.employee_number, he.full_name, he.department_name, he.job_position, he.status AS hr_status,
                he.access_review_required, he.terminated_at, he.user_id, u.email, u.active AS user_active, u.status AS user_status
         FROM hr_employees he
         LEFT JOIN users u ON u.id = he.user_id
         WHERE he.access_review_required = 1 OR (he.status = 'active' AND he.user_id IS NULL)
         ORDER BY he.access_review_required DESC, he.id DESC
         LIMIT 12`
      ),
    ]);

    const chainCheck = await verifyAuditChain().catch(() => ({ valid: true, totalRows: 0, brokenAtId: null }));

    res.json({
      metrics: {
        totalUsers: Number(totalUsersRow?.cnt || 0),
        activeUsers: Number(activeUsersRow?.cnt || 0),
        inactiveUsers: Number(inactiveUsersRow?.cnt || 0),
        lockedUsers: Number(lockedUsersRow?.cnt || 0),
        activeHrEmployees: Number(hrActiveRow?.cnt || 0),
        unlinkedHrEmployees: Number(unlinkedHrRow?.cnt || 0),
        accessReviewAlerts: Number(accessReviewRow?.cnt || 0),
        totalRoles: Number(activeRolesRow?.cnt || 0),
        activeDepartments: Number(activeDeptsRow?.cnt || 0),
        activeRooms: Number(activeRoomsRow?.cnt || 0),
        activeSessions: Number(activeSessionsRow?.cnt || 0),
        auditEvents24h: Number(audit24hRow?.cnt || 0),
      },
      auditIntegrity: chainCheck,
      recentAudits,
      accessReviewQueue: pendingAccessUsers,
    });
  }
);

router.get(
  '/dashboard/doctor',
  requireAuth,
  requirePermission('visit.read', 'patient.read'),
  async (req: AuthRequest, res: Response) => {
    const user = req.user!;
    const today = await getClinicToday();
    const doctorId = user.id;

    const [
      assignedPatientsRow,
      waitingQueueRow,
      activeConsultsRow,
      resultsReadyRow,
      todayApptsRow,
      pendingLabsRow,
      pendingImagingRow,
      assignedQueue,
      todayAppointments,
      recentConsultations,
      pendingLabResults,
      pendingImagingResults,
    ] = await Promise.all([
      queryOne<{ cnt: number }>(
        `SELECT COUNT(DISTINCT p.id) AS cnt
         FROM patients p
         WHERE p.status = 'active'
           AND (
             EXISTS (SELECT 1 FROM visits v WHERE v.patient_id = p.id AND v.doctor_id = ?)
             OR EXISTS (SELECT 1 FROM doctor_assignments da WHERE da.patient_id = p.id AND da.doctor_id = ? AND da.status = 'active')
             OR EXISTS (SELECT 1 FROM appointments a WHERE a.patient_id = p.id AND a.doctor_id = ? AND a.status != 'cancelled')
             OR EXISTS (SELECT 1 FROM admissions adm WHERE adm.patient_id = p.id AND adm.admitting_doctor_id = ? AND adm.status = 'admitted')
           )`,
        [doctorId, doctorId, doctorId, doctorId]
      ),
      queryOne<{ cnt: number }>(
        `SELECT COUNT(DISTINCT v.id) AS cnt
         FROM visits v
         WHERE v.status != 'closed'
           AND (v.doctor_id = ? OR EXISTS (SELECT 1 FROM doctor_assignments da WHERE da.visit_id = v.id AND da.doctor_id = ? AND da.status = 'active'))
           AND v.workflow_stage IN ('paid_awaiting_vitals','ready_for_doctor','in_consultation')`,
        [doctorId, doctorId]
      ),
      queryOne<{ cnt: number }>(
        `SELECT COUNT(DISTINCT v.id) AS cnt
         FROM visits v
         WHERE v.status != 'closed'
           AND (v.doctor_id = ? OR EXISTS (SELECT 1 FROM doctor_assignments da WHERE da.visit_id = v.id AND da.doctor_id = ? AND da.status = 'active'))`,
        [doctorId, doctorId]
      ),
      queryOne<{ cnt: number }>(
        `SELECT COUNT(DISTINCT v.id) AS cnt
         FROM visits v
         WHERE v.status != 'closed'
           AND v.workflow_stage = 'results_ready'
           AND (v.doctor_id = ? OR EXISTS (SELECT 1 FROM doctor_assignments da WHERE da.visit_id = v.id AND da.doctor_id = ? AND da.status = 'active'))`,
        [doctorId, doctorId]
      ),
      queryOne<{ cnt: number }>(
        `SELECT COUNT(*) AS cnt FROM appointments WHERE appointment_date = ? AND doctor_id = ? AND status != 'cancelled'`,
        [today, doctorId]
      ),
      queryOne<{ cnt: number }>(
        `SELECT COUNT(*) AS cnt
         FROM lab_orders lo
         INNER JOIN visits v ON v.id = lo.visit_id
         WHERE lo.status IN ('ordered','collected','resulted')
           AND (v.doctor_id = ? OR lo.ordered_by = ?)`,
        [doctorId, doctorId]
      ),
      queryOne<{ cnt: number }>(
        `SELECT COUNT(*) AS cnt
         FROM imaging_orders io
         INNER JOIN visits v ON v.id = io.visit_id
         WHERE io.status IN ('ordered','scheduled','performed','reported_draft')
           AND (v.doctor_id = ? OR io.ordered_by = ?)`,
        [doctorId, doctorId]
      ),
      query(
        `SELECT v.id AS visit_id, v.visit_number, v.triage_priority, v.workflow_stage, v.chief_complaint, v.status, v.created_at,
                p.id AS patient_id, p.mrn, p.first_name, p.last_name, p.sex, p.date_of_birth,
                q.ticket_number, q.status AS queue_status,
                (SELECT vt.bp_systolic FROM vitals vt WHERE vt.visit_id = v.id ORDER BY vt.id DESC LIMIT 1) AS bp_systolic,
                (SELECT vt.bp_diastolic FROM vitals vt WHERE vt.visit_id = v.id ORDER BY vt.id DESC LIMIT 1) AS bp_diastolic,
                (SELECT vt.temperature FROM vitals vt WHERE vt.visit_id = v.id ORDER BY vt.id DESC LIMIT 1) AS temperature,
                (SELECT vt.spo2 FROM vitals vt WHERE vt.visit_id = v.id ORDER BY vt.id DESC LIMIT 1) AS spo2,
                (SELECT vt.early_warning_flag FROM vitals vt WHERE vt.visit_id = v.id ORDER BY vt.id DESC LIMIT 1) AS early_warning_flag
         FROM visits v
         INNER JOIN patients p ON p.id = v.patient_id
         LEFT JOIN queue_tickets q ON q.visit_id = v.id AND q.status IN ('waiting','called','in_service')
         WHERE v.status != 'closed'
           AND (v.doctor_id = ? OR EXISTS (SELECT 1 FROM doctor_assignments da WHERE da.visit_id = v.id AND da.doctor_id = ? AND da.status = 'active'))
         ORDER BY CASE v.triage_priority WHEN 'emergency' THEN 1 WHEN 'urgent' THEN 2 ELSE 3 END, v.id ASC
         LIMIT 15`,
        [doctorId, doctorId]
      ),
      query(
        `SELECT a.id, a.appointment_date, a.start_time, a.end_time, a.visit_type, a.status, a.reason,
                p.id AS patient_id, p.mrn, p.first_name, p.last_name
         FROM appointments a
         INNER JOIN patients p ON p.id = a.patient_id
         WHERE a.doctor_id = ? AND a.appointment_date >= ? AND a.status IN ('scheduled','checked_in')
         ORDER BY a.appointment_date ASC, a.start_time ASC
         LIMIT 10`,
        [doctorId, today]
      ),
      query(
        `SELECT v.id, v.visit_number, v.diagnosis_code, v.diagnosis_text, v.status, v.workflow_stage, v.updated_at,
                p.mrn, p.first_name, p.last_name
         FROM visits v
         INNER JOIN patients p ON p.id = v.patient_id
         WHERE v.doctor_id = ?
         ORDER BY v.updated_at DESC, v.id DESC
         LIMIT 8`,
        [doctorId]
      ),
      query(
        `SELECT lo.id, lo.visit_id, lo.status, lo.abnormal_flag, lo.result_value, lo.verified_at, lo.created_at,
                lt.code AS test_code, lt.name AS test_name, lt.unit,
                p.mrn, p.first_name, p.last_name
         FROM lab_orders lo
         INNER JOIN lab_tests lt ON lt.id = lo.test_id
         INNER JOIN visits v ON v.id = lo.visit_id
         INNER JOIN patients p ON p.id = lo.patient_id
         WHERE (v.doctor_id = ? OR lo.ordered_by = ?)
           AND lo.status IN ('ordered','collected','resulted','verified')
         ORDER BY CASE WHEN lo.status = 'verified' THEN 0 ELSE 1 END, lo.id DESC
         LIMIT 10`,
        [doctorId, doctorId]
      ),
      query(
        `SELECT io.id, io.visit_id, io.status, io.impression, io.finalised_at, io.created_at,
                ic.code AS exam_code, ic.name AS exam_name, ic.modality,
                p.mrn, p.first_name, p.last_name
         FROM imaging_orders io
         INNER JOIN imaging_catalog ic ON ic.id = io.catalog_id
         INNER JOIN visits v ON v.id = io.visit_id
         INNER JOIN patients p ON p.id = io.patient_id
         WHERE (v.doctor_id = ? OR io.ordered_by = ?)
           AND io.status IN ('ordered','scheduled','performed','reported_draft','reported_final')
         ORDER BY CASE WHEN io.status = 'reported_final' THEN 0 ELSE 1 END, io.id DESC
         LIMIT 10`,
        [doctorId, doctorId]
      ),
    ]);

    res.json({
      doctorScoped: true,
      metrics: {
        assignedPatients: Number(assignedPatientsRow?.cnt || 0),
        waitingQueue: Number(waitingQueueRow?.cnt || 0),
        activeConsultations: Number(activeConsultsRow?.cnt || 0),
        resultsReady: Number(resultsReadyRow?.cnt || 0),
        todayAppointments: Number(todayApptsRow?.cnt || 0),
        pendingLabs: Number(pendingLabsRow?.cnt || 0),
        pendingImaging: Number(pendingImagingRow?.cnt || 0),
      },
      assignedQueue,
      todayAppointments,
      recentConsultations,
      pendingLabResults,
      pendingImagingResults,
    });
  }
);

router.get(
  '/dashboard/nurse',
  requireAuth,
  requirePermission('vitals.create', 'vitals.read', 'ipd.mar.give', 'ipd.bed.assign'),
  async (req: AuthRequest, res: Response) => {
    const user = req.user!;
    const unitIds = user.clinicUnitIds || [];
    const deptNamesLower = (user.departmentNames || []).map((n) => n.toLowerCase());
    const hasRestrictedScope =
      unitIds.length > 0 &&
      !user.roles.includes('ADM') &&
      !user.roles.includes('MGR') &&
      !user.departmentCodes.includes('TRIAGE') &&
      !user.departmentCodes.includes('WRD');

    const unitPlaceholders = unitIds.map(() => '?').join(',');
    const unitTriageFilter = hasRestrictedScope
      ? ` AND (
            EXISTS (
              SELECT 1 FROM doctor_assignments da
              WHERE da.visit_id = v.id AND da.status = 'active' AND da.clinic_room_id IN (${unitPlaceholders})
            )
            OR EXISTS (
              SELECT 1 FROM clinic_rooms cr
              LEFT JOIN specialties sp ON sp.id = cr.specialty_id
              WHERE cr.id IN (${unitPlaceholders})
                AND (sp.name = v.specialty OR LOWER(cr.room_type) = LOWER(COALESCE(q.department, '')))
            )
          )`
      : '';
    const unitTriageParams = hasRestrictedScope ? [...unitIds, ...unitIds] : [];
    const deptMatchWards =
      deptNamesLower.length > 0 && !user.departmentCodes.includes('TRIAGE') && !user.departmentCodes.includes('WRD') && !user.roles.includes('ADM') && !user.roles.includes('MGR');

    const [
      awaitingVitalsRow,
      abnormalVitalsRow,
      pendingProcRow,
      dueMarRow,
      occupiedBedsRow,
      totalBedsRow,
      triageQueue,
      abnormalVitals,
      pendingProcedures,
      dueMedications,
      wardSnapshot,
    ] = await Promise.all([
      queryOne<{ cnt: number }>(
        `SELECT COUNT(*) AS cnt
         FROM visits v
         LEFT JOIN queue_tickets q ON q.visit_id = v.id AND q.status IN ('waiting','called','in_service')
         WHERE v.status != 'closed'
           AND (
             v.workflow_stage = 'paid_awaiting_vitals'
             OR NOT EXISTS (SELECT 1 FROM vitals vt WHERE vt.visit_id = v.id)
           )${unitTriageFilter}`,
        unitTriageParams
      ),
      queryOne<{ cnt: number }>(
        `SELECT COUNT(*) AS cnt
         FROM vitals vt
         WHERE vt.early_warning_flag = 1
            OR vt.temperature >= 38
            OR vt.spo2 < 94
            OR vt.pulse > 110
            OR vt.pulse < 50
            OR vt.bp_systolic >= 140
            OR vt.bp_systolic <= 90`
      ),
      queryOne<{ cnt: number }>("SELECT COUNT(*) AS cnt FROM nursing_procedures WHERE status = 'pending'"),
      queryOne<{ cnt: number }>("SELECT COUNT(*) AS cnt FROM medication_administrations WHERE status = 'due'"),
      queryOne<{ cnt: number }>("SELECT COUNT(*) AS cnt FROM beds WHERE status = 'occupied'"),
      queryOne<{ cnt: number }>("SELECT COUNT(*) AS cnt FROM beds WHERE status != 'out_of_service'"),
      query(
        `SELECT v.id AS visit_id, v.visit_number, v.triage_priority, v.workflow_stage, v.chief_complaint, v.specialty, v.created_at,
                p.id AS patient_id, p.mrn, p.first_name, p.last_name, p.sex, p.date_of_birth,
                q.ticket_number, q.department, q.status AS queue_status,
                u.full_name AS doctor_name,
                (SELECT COUNT(*) FROM vitals vt WHERE vt.visit_id = v.id) AS vitals_count
         FROM visits v
         INNER JOIN patients p ON p.id = v.patient_id
         LEFT JOIN queue_tickets q ON q.visit_id = v.id AND q.status IN ('waiting','called','in_service')
         LEFT JOIN users u ON u.id = v.doctor_id
         WHERE v.status != 'closed'
           AND (
             v.workflow_stage IN ('paid_awaiting_vitals','ready_for_doctor')
             OR NOT EXISTS (SELECT 1 FROM vitals vt WHERE vt.visit_id = v.id)
           )${unitTriageFilter}
         ORDER BY CASE v.triage_priority WHEN 'emergency' THEN 1 WHEN 'urgent' THEN 2 ELSE 3 END, v.id ASC
         LIMIT 15`,
        unitTriageParams
      ),
      query(
        `SELECT vt.id, vt.visit_id, vt.admission_id, vt.patient_id, vt.bp_systolic, vt.bp_diastolic, vt.temperature,
                vt.pulse, vt.spo2, vt.respiratory_rate, vt.early_warning_flag, vt.recorded_at,
                p.mrn, p.first_name, p.last_name
         FROM vitals vt
         INNER JOIN patients p ON p.id = vt.patient_id
         WHERE vt.early_warning_flag = 1
            OR vt.temperature >= 38
            OR vt.spo2 < 94
            OR vt.pulse > 110
            OR vt.pulse < 50
            OR vt.bp_systolic >= 140
            OR vt.bp_systolic <= 90
         ORDER BY vt.id DESC
         LIMIT 10`
      ),
      query(
        `SELECT np.id, np.visit_id, np.patient_id, np.service_code, np.service_name, np.status, np.created_at,
                p.mrn, p.first_name, p.last_name
         FROM nursing_procedures np
         INNER JOIN patients p ON p.id = np.patient_id
         WHERE np.status = 'pending'
         ORDER BY np.id ASC
         LIMIT 10`
      ),
      query(
        `SELECT ma.id, ma.admission_id, ma.patient_id, ma.medicine_name, ma.dose, ma.scheduled_time, ma.status,
                p.mrn, p.first_name, p.last_name,
                w.name AS ward_name, w.department AS ward_department, b.bed_number
         FROM medication_administrations ma
         INNER JOIN admissions adm ON adm.id = ma.admission_id
         INNER JOIN patients p ON p.id = ma.patient_id
         LEFT JOIN wards w ON w.id = adm.ward_id
         LEFT JOIN beds b ON b.id = adm.bed_id
         WHERE ma.status = 'due' AND adm.status = 'admitted'
         ORDER BY ma.scheduled_time ASC, ma.id ASC
         LIMIT 10`
      ),
      query(
        `SELECT w.id, w.code, w.name, w.department,
                COUNT(b.id) AS total_beds,
                SUM(CASE WHEN b.status = 'occupied' THEN 1 ELSE 0 END) AS occupied_beds,
                SUM(CASE WHEN b.status = 'vacant' THEN 1 ELSE 0 END) AS available_beds
         FROM wards w
         LEFT JOIN beds b ON b.ward_id = w.id AND b.status != 'out_of_service'
         GROUP BY w.id, w.code, w.name, w.department
         ORDER BY w.name ASC`
      ),
    ]);

    const scopedWards = deptMatchWards
      ? (wardSnapshot as Array<{ department?: string; name?: string }>).filter((w) =>
          deptNamesLower.some(
            (dn) =>
              String(w.department || '').toLowerCase().includes(dn) ||
              dn.includes(String(w.department || '').toLowerCase())
          )
        )
      : wardSnapshot;

    res.json({
      unitScoped: hasRestrictedScope || deptMatchWards,
      assignedUnits: user.clinicUnits,
      metrics: {
        awaitingVitals: Number(awaitingVitalsRow?.cnt || 0),
        abnormalVitals: Number(abnormalVitalsRow?.cnt || 0),
        pendingProcedures: Number(pendingProcRow?.cnt || 0),
        dueMedications: Number(dueMarRow?.cnt || 0),
        occupiedBeds: Number(occupiedBedsRow?.cnt || 0),
        totalBeds: Number(totalBedsRow?.cnt || 0),
      },
      triageQueue,
      abnormalVitals,
      pendingProcedures,
      dueMedications,
      wardSnapshot: scopedWards,
    });
  }
);

router.get(
  '/dashboard/cashier',
  requireAuth,
  requirePermission('billing.invoice.read', 'billing.payment.create', 'billing.shift.manage'),
  async (req: AuthRequest, res: Response) => {
    const user = req.user!;
    const today = await getClinicToday();

    const [
      openShift,
      unpaidStatsRow,
      todayCollectionsRow,
      todayPaymentsByMethod,
      pendingBypassesRow,
      recentUnpaidInvoices,
      recentReceipts,
    ] = await Promise.all([
      queryOne(
        `SELECT id, opening_float, expected_cash, status, opened_at
         FROM cashier_shifts
         WHERE cashier_id = ? AND status = 'open'
         ORDER BY id DESC
         LIMIT 1`,
        [user.id]
      ),
      queryOne<{ cnt: number; balance: number }>(
        `SELECT COUNT(*) AS cnt, COALESCE(SUM(total_amount - paid_amount), 0) AS balance
         FROM invoices
         WHERE status IN ('unpaid','partial')`
      ),
      queryOne<{ cnt: number; total: number }>(
        `SELECT COUNT(*) AS cnt, COALESCE(SUM(amount), 0) AS total
         FROM payments
         WHERE status = 'completed' AND substr(created_at, 1, 10) = ?`,
        [today]
      ),
      query(
        `SELECT method, COUNT(*) AS tx_count, COALESCE(SUM(amount), 0) AS total_amount
         FROM payments
         WHERE status = 'completed' AND substr(created_at, 1, 10) = ?
         GROUP BY method
         ORDER BY total_amount DESC`,
        [today]
      ),
      queryOne<{ cnt: number }>(
        "SELECT COUNT(*) AS cnt FROM payment_gate_bypasses WHERE follow_up_status = 'pending_billing'"
      ),
      query(
        `SELECT i.id, i.invoice_number, i.patient_id, i.visit_id, i.total_amount, i.paid_amount,
                (i.total_amount - i.paid_amount) AS balance_due, i.payer_type, i.status, i.created_at,
                p.mrn, p.first_name, p.last_name
         FROM invoices i
         INNER JOIN patients p ON p.id = i.patient_id
         WHERE i.status IN ('unpaid','partial')
         ORDER BY i.id DESC
         LIMIT 12`
      ),
      query(
        `SELECT pm.id, pm.receipt_number, pm.amount, pm.method, pm.reference_no, pm.status, pm.created_at,
                i.invoice_number, p.mrn, p.first_name, p.last_name
         FROM payments pm
         INNER JOIN invoices i ON i.id = pm.invoice_id
         INNER JOIN patients p ON p.id = pm.patient_id
         ORDER BY pm.id DESC
         LIMIT 10`
      ),
    ]);

    res.json({
      openShift: openShift || null,
      metrics: {
        unpaidInvoiceCount: Number(unpaidStatsRow?.cnt || 0),
        outstandingReceivables: Number(Number(unpaidStatsRow?.balance || 0).toFixed(2)),
        todayReceiptCount: Number(todayCollectionsRow?.cnt || 0),
        todayCollectionsTotal: Number(Number(todayCollectionsRow?.total || 0).toFixed(2)),
        pendingPaymentBypasses: Number(pendingBypassesRow?.cnt || 0),
        shiftOpen: Boolean(openShift),
        shiftExpectedCash: Number(Number((openShift as { expected_cash?: number } | null)?.expected_cash || 0).toFixed(2)),
      },
      todayPaymentsByMethod,
      recentUnpaidInvoices,
      recentReceipts,
    });
  }
);

router.get(
  '/dashboard/lab',
  requireAuth,
  requirePermission('lab.order.read', 'lab.sample.collect', 'lab.result.enter', 'lab.result.verify'),
  async (_req: AuthRequest, res: Response) => {
    const today = await getClinicToday();

    const [
      orderedRow,
      collectedRow,
      resultedRow,
      verifiedTodayRow,
      criticalUnackRow,
      rejectedRow,
      pendingWorklist,
      criticalAlerts,
    ] = await Promise.all([
      queryOne<{ cnt: number }>("SELECT COUNT(*) AS cnt FROM lab_orders WHERE status = 'ordered'"),
      queryOne<{ cnt: number }>("SELECT COUNT(*) AS cnt FROM lab_orders WHERE status = 'collected'"),
      queryOne<{ cnt: number }>("SELECT COUNT(*) AS cnt FROM lab_orders WHERE status = 'resulted'"),
      queryOne<{ cnt: number }>(
        "SELECT COUNT(*) AS cnt FROM lab_orders WHERE status IN ('verified','amended') AND substr(COALESCE(verified_at, created_at), 1, 10) = ?",
        [today]
      ),
      queryOne<{ cnt: number }>(
        "SELECT COUNT(*) AS cnt FROM lab_orders WHERE abnormal_flag = 'critical' AND critical_ack_by IS NULL"
      ),
      queryOne<{ cnt: number }>("SELECT COUNT(*) AS cnt FROM lab_orders WHERE status = 'rejected'"),
      query(
        `SELECT lo.id, lo.visit_id, lo.patient_id, lo.sample_barcode, lo.status, lo.abnormal_flag, lo.result_value, lo.created_at,
                lt.code AS test_code, lt.name AS test_name, lt.sample_type, lt.unit,
                p.mrn, p.first_name, p.last_name,
                v.triage_priority,
                i.status AS invoice_status
         FROM lab_orders lo
         INNER JOIN lab_tests lt ON lt.id = lo.test_id
         INNER JOIN patients p ON p.id = lo.patient_id
         LEFT JOIN visits v ON v.id = lo.visit_id
         LEFT JOIN invoices i ON i.id = lo.invoice_id
         WHERE lo.status IN ('ordered','collected','resulted')
         ORDER BY CASE v.triage_priority WHEN 'emergency' THEN 1 WHEN 'urgent' THEN 2 ELSE 3 END, lo.id ASC
         LIMIT 18`
      ),
      query(
        `SELECT lo.id, lo.visit_id, lo.result_value, lo.abnormal_flag, lo.status, lo.verified_at, lo.created_at,
                lt.code AS test_code, lt.name AS test_name, lt.unit,
                p.mrn, p.first_name, p.last_name
         FROM lab_orders lo
         INNER JOIN lab_tests lt ON lt.id = lo.test_id
         INNER JOIN patients p ON p.id = lo.patient_id
         WHERE lo.abnormal_flag IN ('critical','high','low')
         ORDER BY CASE WHEN lo.abnormal_flag = 'critical' AND lo.critical_ack_by IS NULL THEN 0 ELSE 1 END, lo.id DESC
         LIMIT 10`
      ),
    ]);

    res.json({
      metrics: {
        awaitingCollection: Number(orderedRow?.cnt || 0),
        collectedInProgress: Number(collectedRow?.cnt || 0),
        awaitingVerification: Number(resultedRow?.cnt || 0),
        verifiedToday: Number(verifiedTodayRow?.cnt || 0),
        criticalUnacknowledged: Number(criticalUnackRow?.cnt || 0),
        rejectedSamples: Number(rejectedRow?.cnt || 0),
      },
      pendingWorklist,
      criticalAlerts,
    });
  }
);

router.get(
  '/dashboard/radiology',
  requireAuth,
  requirePermission('imaging.order.read', 'imaging.exam.perform', 'imaging.report.finalise'),
  async (_req: AuthRequest, res: Response) => {
    const today = await getClinicToday();

    const [
      orderedRow,
      scheduledRow,
      performedRow,
      draftRow,
      finalisedTodayRow,
      worklist,
      modalityBreakdown,
    ] = await Promise.all([
      queryOne<{ cnt: number }>("SELECT COUNT(*) AS cnt FROM imaging_orders WHERE status = 'ordered'"),
      queryOne<{ cnt: number }>("SELECT COUNT(*) AS cnt FROM imaging_orders WHERE status = 'scheduled'"),
      queryOne<{ cnt: number }>("SELECT COUNT(*) AS cnt FROM imaging_orders WHERE status = 'performed'"),
      queryOne<{ cnt: number }>("SELECT COUNT(*) AS cnt FROM imaging_orders WHERE status = 'reported_draft'"),
      queryOne<{ cnt: number }>(
        "SELECT COUNT(*) AS cnt FROM imaging_orders WHERE status = 'reported_final' AND substr(COALESCE(finalised_at, created_at), 1, 10) = ?",
        [today]
      ),
      query(
        `SELECT io.id, io.visit_id, io.patient_id, io.status, io.findings, io.impression, io.created_at,
                ic.code AS exam_code, ic.name AS exam_name, ic.modality, ic.body_region,
                p.mrn, p.first_name, p.last_name,
                v.triage_priority,
                i.status AS invoice_status
         FROM imaging_orders io
         INNER JOIN imaging_catalog ic ON ic.id = io.catalog_id
         INNER JOIN patients p ON p.id = io.patient_id
         LEFT JOIN visits v ON v.id = io.visit_id
         LEFT JOIN invoices i ON i.id = io.invoice_id
         WHERE io.status IN ('ordered','scheduled','performed','reported_draft')
         ORDER BY CASE v.triage_priority WHEN 'emergency' THEN 1 WHEN 'urgent' THEN 2 ELSE 3 END, io.id ASC
         LIMIT 18`
      ),
      query(
        `SELECT ic.modality, COUNT(*) AS open_count
         FROM imaging_orders io
         INNER JOIN imaging_catalog ic ON ic.id = io.catalog_id
         WHERE io.status IN ('ordered','scheduled','performed','reported_draft')
         GROUP BY ic.modality
         ORDER BY open_count DESC`
      ),
    ]);

    res.json({
      metrics: {
        orderedQueue: Number(orderedRow?.cnt || 0),
        scheduledQueue: Number(scheduledRow?.cnt || 0),
        awaitingReport: Number(performedRow?.cnt || 0),
        draftReports: Number(draftRow?.cnt || 0),
        finalisedToday: Number(finalisedTodayRow?.cnt || 0),
      },
      worklist,
      modalityBreakdown,
    });
  }
);

router.get(
  '/dashboard/pharmacy',
  requireAuth,
  requirePermission('pharmacy.prescription.read', 'pharmacy.dispense'),
  async (_req: AuthRequest, res: Response) => {
    const today = await getClinicToday();
    const thirtyDaysAhead = new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10);

    const [
      readyDispenseRow,
      pendingPaymentRow,
      dispensedTodayRow,
      lowStockRow,
      expiringBatchesRow,
      pendingReqRow,
      dispenseQueue,
      lowStockMedicines,
      expiringBatches,
    ] = await Promise.all([
      queryOne<{ cnt: number }>(
        "SELECT COUNT(*) AS cnt FROM prescriptions WHERE status IN ('paid_ready_to_dispense','awaiting_stock_check','pending')"
      ),
      queryOne<{ cnt: number }>("SELECT COUNT(*) AS cnt FROM prescriptions WHERE status = 'pending_payment'"),
      queryOne<{ cnt: number }>(
        "SELECT COUNT(*) AS cnt FROM prescriptions WHERE status = 'dispensed' AND substr(COALESCE(dispensed_at, created_at), 1, 10) = ?",
        [today]
      ),
      queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM medicines WHERE stock_qty <= reorder_level'),
      queryOne<{ cnt: number }>(
        "SELECT COUNT(*) AS cnt FROM stock_batches WHERE qty_on_hand > 0 AND status = 'active' AND expiry_date <= ?",
        [thirtyDaysAhead]
      ),
      queryOne<{ cnt: number }>("SELECT COUNT(*) AS cnt FROM stock_requisitions WHERE status IN ('pending','approved')").catch(
        () => ({ cnt: 0 })
      ),
      query(
        `SELECT pr.id, pr.visit_id, pr.patient_id, pr.status, pr.notes, pr.created_at,
                p.mrn, p.first_name, p.last_name,
                u.full_name AS doctor_name,
                i.invoice_number, i.status AS invoice_status,
                (SELECT COUNT(*) FROM prescription_items pi WHERE pi.prescription_id = pr.id) AS item_count
         FROM prescriptions pr
         INNER JOIN patients p ON p.id = pr.patient_id
         LEFT JOIN users u ON u.id = pr.doctor_id
         LEFT JOIN invoices i ON i.id = pr.invoice_id
         WHERE pr.status IN ('paid_ready_to_dispense','awaiting_stock_check','pending_payment','pending')
         ORDER BY CASE WHEN pr.status = 'paid_ready_to_dispense' THEN 0 ELSE 1 END, pr.id ASC
         LIMIT 15`
      ),
      query(
        `SELECT id, code, generic_name, strength, form, stock_qty, reorder_level, expiry_date
         FROM medicines
         WHERE stock_qty <= reorder_level
         ORDER BY stock_qty ASC, generic_name ASC
         LIMIT 10`
      ),
      query(
        `SELECT sb.id, sb.batch_number, sb.location, sb.expiry_date, sb.qty_on_hand,
                si.code AS item_code, si.name AS item_name, si.unit
         FROM stock_batches sb
         INNER JOIN store_items si ON si.id = sb.item_id
         WHERE sb.qty_on_hand > 0 AND sb.status = 'active' AND sb.expiry_date <= ?
         ORDER BY sb.expiry_date ASC
         LIMIT 10`,
        [thirtyDaysAhead]
      ),
    ]);

    res.json({
      metrics: {
        readyToDispense: Number(readyDispenseRow?.cnt || 0),
        pendingPayment: Number(pendingPaymentRow?.cnt || 0),
        dispensedToday: Number(dispensedTodayRow?.cnt || 0),
        lowStockCount: Number(lowStockRow?.cnt || 0),
        expiringBatchesCount: Number(expiringBatchesRow?.cnt || 0),
        pendingRequisitions: Number(pendingReqRow?.cnt || 0),
      },
      dispenseQueue,
      lowStockMedicines,
      expiringBatches,
    });
  }
);

router.get(
  '/dashboard/hr',
  requireAuth,
  requirePermission('hr.manage', 'hr.attendance.manage', 'hr.overtime.manage', 'hr.payroll.submit'),
  async (_req: AuthRequest, res: Response) => {
    const today = await getClinicToday();

    const [
      activeStaffRow,
      inactiveStaffRow,
      presentTodayRow,
      lateTodayRow,
      pendingLeaveRow,
      pendingOvertimeRow,
      draftPayrollRow,
      departmentBreakdown,
      pendingLeaveRequests,
      pendingOvertimeList,
      recentPayrollRuns,
    ] = await Promise.all([
      queryOne<{ cnt: number }>("SELECT COUNT(*) AS cnt FROM hr_employees WHERE status = 'active'"),
      queryOne<{ cnt: number }>("SELECT COUNT(*) AS cnt FROM hr_employees WHERE status != 'active'"),
      queryOne<{ cnt: number }>(
        "SELECT COUNT(*) AS cnt FROM hr_attendance WHERE attendance_date = ? AND status IN ('present','late')",
        [today]
      ),
      queryOne<{ cnt: number }>(
        'SELECT COUNT(*) AS cnt FROM hr_attendance WHERE attendance_date = ? AND late_minutes > 0',
        [today]
      ),
      queryOne<{ cnt: number }>("SELECT COUNT(*) AS cnt FROM leave_requests WHERE status = 'pending'"),
      queryOne<{ cnt: number }>("SELECT COUNT(*) AS cnt FROM hr_overtime WHERE status = 'pending'"),
      queryOne<{ cnt: number }>("SELECT COUNT(*) AS cnt FROM payroll_runs WHERE status IN ('draft','submitted','verified','approved')"),
      query(
        `SELECT department_name, COUNT(*) AS staff_count
         FROM hr_employees
         WHERE status = 'active'
         GROUP BY department_name
         ORDER BY staff_count DESC, department_name ASC`
      ),
      query(
        `SELECT lr.id, lr.leave_type, lr.start_date, lr.end_date, lr.days_count, lr.reason, lr.status,
                COALESCE(he.full_name, u.full_name, 'Staff') AS staff_name, he.department_name
         FROM leave_requests lr
         LEFT JOIN hr_employees he ON he.id = lr.employee_id OR (lr.employee_id IS NULL AND he.user_id = lr.user_id)
         LEFT JOIN users u ON u.id = lr.user_id
         WHERE lr.status = 'pending'
         ORDER BY lr.id ASC
         LIMIT 10`
      ),
      query(
        `SELECT ot.id, ot.overtime_date, ot.hours, ot.day_type, ot.computed_amount, ot.reason, ot.status,
                he.full_name AS staff_name, he.department_name
         FROM hr_overtime ot
         INNER JOIN hr_employees he ON he.id = ot.employee_id
         WHERE ot.status = 'pending'
         ORDER BY ot.id ASC
         LIMIT 10`
      ),
      query(
        `SELECT id, run_number, pay_month, total_gross, total_deductions, total_net, status, created_at
         FROM payroll_runs
         ORDER BY id DESC
         LIMIT 6`
      ),
    ]);

    res.json({
      metrics: {
        activeEmployees: Number(activeStaffRow?.cnt || 0),
        inactiveEmployees: Number(inactiveStaffRow?.cnt || 0),
        presentToday: Number(presentTodayRow?.cnt || 0),
        lateToday: Number(lateTodayRow?.cnt || 0),
        pendingLeaves: Number(pendingLeaveRow?.cnt || 0),
        pendingOvertime: Number(pendingOvertimeRow?.cnt || 0),
        openPayrollRuns: Number(draftPayrollRow?.cnt || 0),
      },
      departmentBreakdown,
      pendingLeaveRequests,
      pendingOvertimeList,
      recentPayrollRuns,
    });
  }
);

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

router.get('/doctors/activity', requireAuth, requirePermission('audit.read', 'finance.report.view', 'admin.user.manage'), async (_req, res) => {
  const today = await getClinicToday();
  const doctors = await query(
    `SELECT u.id, u.full_name, u.email, u.specialty,
            (SELECT COUNT(*) FROM visits v WHERE v.doctor_id = u.id AND v.status != 'closed') AS active_visits,
            (SELECT COUNT(*) FROM visits v WHERE v.doctor_id = u.id AND v.status = 'closed') AS completed_visits,
            (SELECT COUNT(*) FROM queue_tickets q INNER JOIN visits v ON v.id = q.visit_id WHERE v.doctor_id = u.id AND q.status IN ('waiting','called','in_service')) AS queue_count,
            (SELECT COUNT(*) FROM appointments a WHERE a.doctor_id = u.id AND a.appointment_date = ? AND a.status != 'cancelled') AS today_appointments
     FROM users u
     INNER JOIN user_roles ur ON ur.user_id = u.id
     INNER JOIN roles r ON r.id = ur.role_id
     WHERE r.code = 'DOC' AND u.active = 1
     ORDER BY active_visits DESC, u.full_name ASC`,
    [today]
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
  const doctorScoped = isDoctorOnly(req.user!);

  let whereSql = " WHERE status = 'active'";
  const params: unknown[] = [];

  if (doctorScoped) {
    whereSql +=
      " AND (EXISTS (SELECT 1 FROM visits v WHERE v.patient_id = patients.id AND v.doctor_id = ?) OR EXISTS (SELECT 1 FROM appointments a WHERE a.patient_id = patients.id AND a.doctor_id = ? AND a.status != 'cancelled') OR EXISTS (SELECT 1 FROM admissions adm WHERE adm.patient_id = patients.id AND adm.admitting_doctor_id = ? AND adm.status = 'admitted'))";
    params.push(req.user!.id, req.user!.id, req.user!.id);
  }

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
                    patient_type, payer_name, insurance_number, dob_estimated, status, created_at`;
  if (canSeeClinical) {
    sql += ', blood_group, allergies';
  }
  sql += ` FROM patients${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`;

  const patients = await query(sql, [...params, limit, offset]);
  res.json({
    patients,
    clinicalMasked: !canSeeClinical,
    isDoctorScoped: doctorScoped,
    total: Number(countRow?.cnt || 0),
    page,
    limit,
  });
});

router.get('/patients/check-duplicate', requireAuth, requirePermission('patient.read'), async (req: AuthRequest, res: Response) => {
  const firstName = String(req.query.first_name || '').trim().toLowerCase();
  const lastName = String(req.query.last_name || '').trim().toLowerCase();
  const dob = String(req.query.date_of_birth || '').trim();
  const phone = String(req.query.phone || '').trim();
  const cleanPhone = phone.replace(/[\s\-+()]/g, '');
  const nationalId = String(req.query.national_id || '').trim().toLowerCase();

  const clauses: string[] = [];
  const params: unknown[] = [];
  if (firstName && lastName && dob) {
    clauses.push('(LOWER(first_name) = ? AND LOWER(last_name) = ? AND date_of_birth = ?)');
    params.push(firstName, lastName, dob);
  }
  if (phone) {
    clauses.push("phone = ? OR REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone, '-', ''), ' ', ''), '+', ''), '(', ''), ')', '') = ?");
    params.push(phone, cleanPhone || phone);
  }
  if (nationalId) {
    clauses.push('(national_id IS NOT NULL AND LOWER(national_id) = ?)');
    params.push(nationalId);
  }
  if (clauses.length === 0) return res.json({ duplicates: [] });

  const candidates = await query<{
    id: number;
    mrn: string;
    first_name: string;
    last_name: string;
    date_of_birth: string;
    phone: string;
    national_id: string | null;
  }>(
    `SELECT id, mrn, first_name, last_name, date_of_birth, phone, national_id
     FROM patients
     WHERE status = 'active' AND (${clauses.join(' OR ')})
     LIMIT 10`,
    params
  );

  const scored = candidates
    .map((c) => {
      let score = 0;
      const cPhoneClean = String(c.phone || '').replace(/[\s\-+()]/g, '');
      if (nationalId && c.national_id && c.national_id.toLowerCase() === nationalId) score += 90;
      if (firstName && lastName && dob && c.first_name.toLowerCase() === firstName && c.last_name.toLowerCase() === lastName && c.date_of_birth === dob) score += 70;
      if (cleanPhone && cPhoneClean === cleanPhone) score += 50;
      return {
        id: c.id,
        mrn: c.mrn,
        first_name: c.first_name,
        last_name: c.last_name,
        date_of_birth: c.date_of_birth,
        phone: c.phone,
        match_score: score,
      };
    })
    .sort((a, b) => b.match_score - a.match_score)
    .slice(0, 5);

  res.json({ duplicates: scored });
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

    const tables = [
      'appointments',
      'visits',
      'vitals',
      'invoices',
      'payments',
      'receipts',
      'lab_orders',
      'imaging_orders',
      'prescriptions',
      'queue_tickets',
      'admissions',
      'patient_deposits',
      'nursing_procedures',
      'medication_orders',
      'medication_administrations',
      'ward_rounds',
      'nursing_notes',
      'insurance_claims',
      'credit_notes',
      'payment_gate_bypasses',
      'patient_payer_history',
      'break_glass_logs',
    ];
    for (const tbl of tables) {
      await execute(`UPDATE ${tbl} SET patient_id = ? WHERE patient_id = ?`, [tgtId, srcId]).catch(() => {});
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

router.get(
  '/patients/:id',
  requireAuth,
  authorize('patient.read', {
    checkDoctorAssignment: true,
    patientIdParam: 'id',
    audit: { action: 'patient.read', entityType: 'patient', entityIdParam: 'id', patientIdParam: 'id', dedupeIfAudited: true },
  }),
  async (req: AuthRequest, res: Response) => {
  const id = Number(req.params.id);
  const patient = await queryOne<Record<string, unknown>>('SELECT * FROM patients WHERE id = ?', [id]);
  if (!patient) {
    return res.status(404).json({ error: 'Patient not found' });
  }

  const access = await assertPatientAccess(req.user!, id);
  if (!access.allowed) {
    return res.status(403).json({
      error: access.reason || 'Break-Glass authorization required to view unassigned patient chart.',
      breakGlassRequired: true,
      patientId: id,
    });
  }

  const canSeeClinical = access.clinicalAuthorized;
  const canSeeBilling = hasPermission(req.user!, 'billing.invoice.read');

  const safePatient = maskPatientRecord(patient, req.user!);

  const doctorScoped = isDoctorOnly(req.user!) && !access.breakGlassActive;

  const appointments = hasPermission(req.user!, 'appointment.read')
    ? await query(
        `SELECT a.*, u.full_name AS doctor_name
         FROM appointments a
         INNER JOIN users u ON u.id = a.doctor_id
         WHERE a.patient_id = ?${doctorScoped ? ' AND a.doctor_id = ?' : ''}
         ORDER BY a.appointment_date DESC, a.start_time DESC`,
        doctorScoped ? [id, req.user!.id] : [id]
      )
    : [];

  const visits = canSeeClinical
    ? await query(
        `SELECT v.*, u.full_name AS doctor_name
         FROM visits v
         LEFT JOIN users u ON u.id = v.doctor_id
         WHERE v.patient_id = ?${doctorScoped ? ' AND v.doctor_id = ?' : ''}
         ORDER BY v.id DESC`,
        doctorScoped ? [id, req.user!.id] : [id]
      )
    : [];

  const vitals = canSeeClinical
    ? doctorScoped
      ? await query(
          `SELECT vt.* FROM vitals vt
           INNER JOIN visits v ON v.id = vt.visit_id
           WHERE vt.patient_id = ? AND v.doctor_id = ?
           ORDER BY vt.id DESC LIMIT 10`,
          [id, req.user!.id]
        )
      : await query('SELECT * FROM vitals WHERE patient_id = ? ORDER BY id DESC LIMIT 10', [id])
    : [];

  const invoices = canSeeBilling
    ? await query('SELECT * FROM invoices WHERE patient_id = ? ORDER BY id DESC', [id])
    : [];

  const accessHistory = hasPermission(req.user!, 'audit.read') || canSeeClinical
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
    breakGlassActive: access.breakGlassActive,
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

  const cleanReason = String(reason).trim();
  const expiresAt = nowSql(new Date(Date.now() + 4 * 3600 * 1000));
  await execute(
    'INSERT INTO break_glass_logs (user_id, patient_id, reason, expires_at) VALUES (?, ?, ?, ?)',
    [req.user!.id, id, cleanReason, expiresAt]
  );

  await createNotification({
    targetRole: 'AUD',
    title: 'Break-Glass Chart Access Logged',
    message: `${req.user!.fullName} invoked Break-Glass access for ${patient.first_name} ${patient.last_name} (${patient.mrn}): ${cleanReason}`,
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
    reason: cleanReason,
    after: { mrn: patient.mrn, expiresAt },
    req,
  });

  res.json({ ok: true, grantedAt: nowSql(), expiresAt });
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
    dob_estimated = false,
    issue_queue_ticket = true,
    charge_registration_card = true,
  } = req.body || {};

  if (!first_name || !last_name || !sex || !date_of_birth || !phone) {
    return res.status(400).json({ error: 'First name, last name, sex, date of birth, and phone are required.' });
  }

  const { patient, ticketNumber } = await withTransaction(async () => {
    const mrn = await nextSequence('MRN');
    const cleanAllergies = String(allergies || '').trim() || 'Unknown';
    const inserted = await execute(
      `INSERT INTO patients (mrn, first_name, last_name, sex, date_of_birth, phone, email, address, next_of_kin_name, next_of_kin_phone, blood_group, allergies, patient_type, payer_name, insurance_number, national_id, dob_estimated, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        cleanAllergies,
        patient_type,
        payer_name || null,
        insurance_number || null,
        national_id || null,
        dob_estimated ? 1 : 0,
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
      await postInvoiceAccrualJE({
        invoiceId: invRes.insertId,
        invoiceNumber: invNum,
        payerType: patient_type,
        totalAmount: cardFee,
        postedBy: req.user!.id,
        description: `Registration card fee ${invNum}`,
      });
    }

    await writeAuditLog({
      user: req.user,
      action: 'patient.create',
      entityType: 'patient',
      entityId: patientId,
      patientId,
      after: { mrn, first_name, last_name, patient_type, dob_estimated: Boolean(dob_estimated) },
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
  const canEditIdentity = hasPermission(req.user!, 'patient.identity.update');
  const canChangePayer = hasPermission(req.user!, 'patient.payer.change');

  const identityFields = ['first_name', 'last_name', 'sex', 'date_of_birth', 'national_id'];
  const payerFields = ['patient_type', 'payer_name', 'insurance_number'];
  const generalFields = canEditClinical
    ? ['phone', 'email', 'address', 'next_of_kin_name', 'next_of_kin_phone', 'blood_group', 'allergies']
    : ['phone', 'email', 'address', 'next_of_kin_name', 'next_of_kin_phone'];

  const requestedIdentityChanges = identityFields.filter((f) => req.body[f] !== undefined && req.body[f] !== existing[f]);
  if (requestedIdentityChanges.length > 0) {
    if (!canEditIdentity) {
      return res.status(403).json({ error: 'Changing patient identity fields requires patient.identity.update permission.' });
    }
    const idReason = String(req.body.identity_change_reason || req.body.reason || '').trim();
    if (idReason.length < 5) {
      return res.status(400).json({ error: 'Identity changes require a formal reason (min 5 characters).' });
    }
  }

  const requestedPayerChanges = payerFields.filter((f) => req.body[f] !== undefined && req.body[f] !== existing[f]);
  let pendingExemptApprovalId: number | null = null;
  if (requestedPayerChanges.length > 0) {
    if (!canChangePayer) {
      return res.status(403).json({ error: 'Changing billing payer category requires patient.payer.change permission.' });
    }
    const payerReason = String(req.body.payer_change_reason || req.body.reason || '').trim();
    if (payerReason.length < 5) {
      return res.status(400).json({ error: 'Payer category changes require a documented reason (min 5 characters).' });
    }
  }

  const updates: string[] = [];
  const params: unknown[] = [];
  const beforeDiff: Record<string, unknown> = {};
  const afterDiff: Record<string, unknown> = {};

  for (const f of [...generalFields, ...requestedIdentityChanges]) {
    if (req.body[f] !== undefined && req.body[f] !== existing[f]) {
      updates.push(`${f} = ?`);
      params.push(req.body[f]);
      beforeDiff[f] = existing[f];
      afterDiff[f] = req.body[f];
    }
  }

  const nextPayerType = req.body.patient_type !== undefined ? String(req.body.patient_type) : String(existing.patient_type);
  const exemptRequested = requestedPayerChanges.includes('patient_type') && nextPayerType === 'exempt' && existing.patient_type !== 'exempt';
  if (exemptRequested && !hasPermission(req.user!, 'approval.decide')) {
    const payerReason = String(req.body.payer_change_reason || req.body.reason || '').trim();
    const appRes = await execute(
      `INSERT INTO approval_requests (request_type, entity_type, entity_id, requested_amount, reason, status, requested_by)
       VALUES ('payer_exempt', 'patient', ?, 0, ?, 'pending', ?)`,
      [id, payerReason, req.user!.id]
    );
    pendingExemptApprovalId = appRes.insertId;
    await createNotification({
      targetRole: 'MGR',
      title: 'Patient Fee Exemption Approval Required',
      message: `${req.user!.fullName} requested exempt status for patient #${id}: ${payerReason}`,
      severity: 'warning',
      entityType: 'approval_request',
      entityId: pendingExemptApprovalId,
    });
  } else if (requestedPayerChanges.length > 0) {
    for (const f of requestedPayerChanges) {
      updates.push(`${f} = ?`);
      params.push(req.body[f]);
      beforeDiff[f] = existing[f];
      afterDiff[f] = req.body[f];
    }
    const payerReason = String(req.body.payer_change_reason || req.body.reason || 'Payer update').trim();
    await execute(
      `INSERT INTO patient_payer_history (patient_id, from_type, to_type, payer_name, reason, changed_by, approved_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        String(existing.patient_type),
        nextPayerType,
        req.body.payer_name ?? existing.payer_name ?? null,
        payerReason,
        req.user!.id,
        nextPayerType === 'exempt' ? req.user!.id : null,
      ]
    );
  }

  if (updates.length > 0) {
    updates.push('updated_by = ?');
    params.push(req.user!.id, id);
    await execute(`UPDATE patients SET ${updates.join(', ')} WHERE id = ?`, params);
    await writeAuditLog({
      user: req.user,
      action: requestedIdentityChanges.length > 0 ? 'patient.identity.update' : 'patient.update',
      entityType: 'patient',
      entityId: id,
      patientId: id,
      reason: String(req.body.identity_change_reason || req.body.payer_change_reason || req.body.reason || '') || null,
      before: beforeDiff,
      after: afterDiff,
      req,
    });
  }

  const updated = await queryOne<Record<string, unknown>>('SELECT * FROM patients WHERE id = ?', [id]);
  res.json({ patient: updated ? maskPatientRecord(updated, req.user!) : null, pendingExemptApprovalId });
});

// Queue Management
router.get('/queue', requireAuth, requirePermission('queue.manage', 'visit.read', 'patient.read'), async (req: AuthRequest, res: Response) => {
  const dept = req.query.department ? String(req.query.department) : null;
  const doctorScoped = isDoctorOnly(req.user!);
  let sql = `
    SELECT q.*, p.mrn, p.first_name, p.last_name, p.sex, p.date_of_birth, p.patient_type,
           v.visit_number, v.specialty, v.workflow_stage, v.doctor_id,
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
  if (doctorScoped) {
    sql += ' AND v.doctor_id = ?';
    params.push(req.user!.id);
  }
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
  if (priority === 'emergency' && !hasPermission(req.user!, 'triage.emergency.set')) {
    return res.status(403).json({ error: 'Setting emergency queue priority requires triage.emergency.set permission.' });
  }
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

router.post('/queue/:dept/call-next', requireAuth, requirePermission('queue.manage'), async (req: AuthRequest, res: Response) => {
  const dept = String(req.params.dept || 'OPD').trim().toUpperCase();
  const nextTicket = await queryOne<Record<string, unknown>>(
    `SELECT * FROM queue_tickets
     WHERE department = ? AND status = 'waiting'
     ORDER BY CASE priority WHEN 'emergency' THEN 1 WHEN 'urgent' THEN 2 ELSE 3 END, id ASC
     LIMIT 1`,
    [dept]
  );
  if (!nextTicket) return res.status(404).json({ error: `No waiting tickets in ${dept} queue.` });

  await execute("UPDATE queue_tickets SET status = 'called', called_at = ? WHERE id = ?", [nowSql(), nextTicket.id]);
  await writeAuditLog({
    user: req.user,
    action: 'queue.ticket.call_next',
    entityType: 'queue_ticket',
    entityId: Number(nextTicket.id),
    patientId: Number(nextTicket.patient_id),
    after: { department: dept, ticketNumber: nextTicket.ticket_number },
    req,
  });
  broadcastClinicEvent('queue:updated', { department: dept, ticketId: nextTicket.id, status: 'called' });
  res.json({ ticket: { ...nextTicket, status: 'called' } });
});

router.patch('/queue/:id/status', requireAuth, requirePermission('queue.manage'), async (req: AuthRequest, res: Response) => {
  const id = Number(req.params.id);
  const { status, priority } = req.body || {};
  const ticket = await queryOne<Record<string, unknown>>('SELECT * FROM queue_tickets WHERE id = ?', [id]);
  if (!ticket) return res.status(404).json({ error: 'Queue ticket not found' });

  if (priority === 'emergency' && ticket.priority !== 'emergency' && !hasPermission(req.user!, 'triage.emergency.set')) {
    return res.status(403).json({ error: 'Escalating queue ticket to emergency requires triage.emergency.set permission.' });
  }

  if (status) {
    await execute(
      "UPDATE queue_tickets SET status = ?, called_at = CASE WHEN ? = 'called' THEN ? ELSE called_at END WHERE id = ?",
      [status, status, nowSql(), id]
    );
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
router.get('/appointments/blocks', requireAuth, requirePermission('appointment.read'), async (req: AuthRequest, res: Response) => {
  const date = req.query.date ? String(req.query.date) : null;
  const doctorScoped = isDoctorOnly(req.user!);
  const doctorId = doctorScoped ? req.user!.id : req.query.doctorId ? Number(req.query.doctorId) : null;
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

router.get('/appointments', requireAuth, requirePermission('appointment.read'), async (req: AuthRequest, res: Response) => {
  const date = req.query.date ? String(req.query.date) : null;
  const doctorScoped = isDoctorOnly(req.user!);
  const doctorId = doctorScoped ? req.user!.id : req.query.doctorId ? Number(req.query.doctorId) : null;

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
  res.json({ appointments, isDoctorScoped: doctorScoped });
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
  if (isDoctorOnly(req.user!) && Number(existing.doctor_id) !== req.user!.id) {
    return res.status(403).json({ error: 'You may only update your own assigned appointments.' });
  }
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
          await postInvoiceAccrualJE({
            invoiceId: invRes.insertId,
            invoiceNumber: invNum,
            payerType: patient.patient_type,
            totalAmount: fee,
            postedBy: req.user!.id,
            description: `Checked-in appointment ${invNum} (${specialty})`,
          });
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
  const statusFilter = req.query.status ? String(req.query.status).trim() : '';
  const doctorIdFilter = req.query.doctor_id ? Number(req.query.doctor_id) : null;
  const dateFilter = req.query.date ? String(req.query.date).trim() : '';
  const limit = Math.min(200, Math.max(10, Number(req.query.limit || 60)));
  const page = Math.max(1, Number(req.query.page || 1));
  const offset = (page - 1) * limit;
  const doctorScoped = isDoctorOnly(req.user!);

  const stages = stageFilter ? stageFilter.split(',').map((s) => s.trim()).filter(Boolean) : [];
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (doctorScoped) {
    clauses.push('v.doctor_id = ?');
    params.push(req.user!.id);
  } else if (doctorIdFilter) {
    clauses.push('v.doctor_id = ?');
    params.push(doctorIdFilter);
  }

  if (stages.length > 0) {
    const ph = stages.map(() => '?').join(',');
    clauses.push(`v.workflow_stage IN (${ph})`);
    params.push(...stages);
  }
  if (statusFilter === 'open') {
    clauses.push("v.status != 'closed'");
  } else if (statusFilter === 'closed') {
    clauses.push("v.status = 'closed'");
  }
  if (dateFilter) {
    clauses.push('substr(v.created_at, 1, 10) = ?');
    params.push(dateFilter);
  }
  const whereSql = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';

  const countRow = await queryOne<{ cnt: number }>(`SELECT COUNT(*) AS cnt FROM visits v${whereSql}`, params);
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
     ORDER BY CASE v.triage_priority WHEN 'emergency' THEN 1 WHEN 'urgent' THEN 2 ELSE 3 END, v.id DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  const canSeeClinical = hasPermission(req.user!, 'patient.clinical.read');
  let activeBreakGlassPatients = new Set<number>();
  if (doctorScoped && rows.length > 0) {
    const bgRows = await query<{ patient_id: number }>(
      'SELECT DISTINCT patient_id FROM break_glass_logs WHERE user_id = ? AND expires_at > ?',
      [req.user!.id, nowSql()]
    ).catch(() => []);
    activeBreakGlassPatients = new Set(bgRows.map((b) => Number(b.patient_id)));
  }

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

    const docAuthorized =
      !doctorScoped ||
      Number(v.doctor_id) === req.user!.id ||
      activeBreakGlassPatients.has(Number(v.patient_id));

    if (!canSeeClinical || !docAuthorized) {
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
        clinical_locked: canSeeClinical && !docAuthorized,
      };
    }
    return {
      ...v,
      consultation_cleared: cleared,
      results_ready: resultsReady,
    };
  });
  res.json({
    visits,
    clinicalMasked: !canSeeClinical,
    isDoctorScoped: doctorScoped,
    total: Number(countRow?.cnt || 0),
    page,
    limit,
  });
});

router.get(
  '/visits/:id',
  requireAuth,
  authorize(['visit.read', 'vitals.read'], {
    checkDoctorAssignment: true,
    visitIdParam: 'id',
    audit: { action: 'visit.read', entityType: 'visit', entityIdParam: 'id' },
  }),
  async (req: AuthRequest, res: Response) => {
  const id = Number(req.params.id);
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

  const access = await assertPatientAccess(req.user!, Number(visitRow.patient_id));
  if (!access.allowed) {
    return res.status(403).json({
      error: access.reason || 'Break-Glass authorization required to view unassigned clinical visit.',
      breakGlassRequired: true,
      patientId: Number(visitRow.patient_id),
    });
  }
  if (isDoctorOnly(req.user!) && Number(visitRow.doctor_id) !== req.user!.id && !access.breakGlassActive) {
    return res.status(403).json({
      error: 'Access denied: this visit is assigned to another clinician.',
      breakGlassRequired: true,
      patientId: Number(visitRow.patient_id),
    });
  }
  const canSeeClinical = access.clinicalAuthorized;
  const canSeeVitals = canSeeClinical || hasPermission(req.user!, 'vitals.read');

  const [vitals, labOrders, imagingOrders, prescriptions, nursingProcedures] = await Promise.all([
    canSeeVitals ? query('SELECT * FROM vitals WHERE visit_id = ? ORDER BY id DESC', [id]) : Promise.resolve([]),
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
    canSeeClinical
      ? query<Record<string, unknown>>(
          `SELECT pr.*, i.invoice_number, i.status AS invoice_status
           FROM prescriptions pr
           LEFT JOIN invoices i ON i.id = pr.invoice_id
           WHERE pr.visit_id = ?`,
          [id]
        )
      : Promise.resolve([]),
    canSeeClinical
      ? query(
          `SELECT np.*, s.unit_price, u1.full_name AS ordered_by_name, u2.full_name AS performed_by_name, i.invoice_number, i.status AS invoice_status
           FROM nursing_procedures np
           LEFT JOIN services s ON s.id = np.service_id
           LEFT JOIN users u1 ON u1.id = np.ordered_by
           LEFT JOIN users u2 ON u2.id = np.performed_by
           LEFT JOIN invoices i ON i.id = np.invoice_id
           WHERE np.visit_id = ?
           ORDER BY np.id DESC`,
          [id]
        )
      : Promise.resolve([]),
  ]);

  if (canSeeClinical && prescriptions.length > 0) {
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
    breakGlassActive: access.breakGlassActive,
    vitals,
    labOrders: canSeeClinical ? labOrders : labOrders.map((l) => ({ ...l, result_value: null, panel_results_json: null })),
    imagingOrders: canSeeClinical ? imagingOrders : imagingOrders.map((im) => ({ ...im, findings: null, impression: null })),
    prescriptions,
    nursingProcedures,
  });
});

router.patch('/visits/:id/assign-doctor', requireAuth, requirePermission('visit.assign_doctor', 'visit.create', 'vitals.create', 'queue.manage'), async (req: AuthRequest, res: Response) => {
  const visitId = Number(req.params.id);
  const { doctor_id, specialty, notes } = req.body || {};
  const doctorId = Number(doctor_id);
  if (!doctorId) {
    return res.status(400).json({ error: 'Valid doctor_id is required to assign an OPD doctor.' });
  }

  const visit = await queryOne<{
    id: number;
    visit_number: string;
    patient_id: number;
    doctor_id: number | null;
    specialty: string | null;
    status: string;
    workflow_stage: string | null;
  }>('SELECT id, visit_number, patient_id, doctor_id, specialty, status, workflow_stage FROM visits WHERE id = ?', [visitId]);
  if (!visit) return res.status(404).json({ error: 'Visit not found' });
  if (visit.status === 'closed') {
    return res.status(409).json({ error: 'Cannot reassign a closed visit.' });
  }

  const doc = await queryOne<{ id: number; full_name: string; specialty: string | null }>(
    `SELECT u.id, u.full_name, u.specialty
     FROM users u
     INNER JOIN user_roles ur ON ur.user_id = u.id
     INNER JOIN roles r ON r.id = ur.role_id
     WHERE u.id = ? AND r.code = 'DOC' AND u.active = 1`,
    [doctorId]
  );
  if (!doc) {
    return res.status(404).json({ error: 'Selected active OPD doctor not found.' });
  }

  const patient = await queryOne<{ mrn: string; first_name: string; last_name: string }>(
    'SELECT mrn, first_name, last_name FROM patients WHERE id = ?',
    [visit.patient_id]
  );
  const resolvedSpecialty = (specialty ? String(specialty).trim() : '') || doc.specialty || visit.specialty || 'General Medicine';

  await execute('UPDATE visits SET doctor_id = ?, specialty = ? WHERE id = ?', [doc.id, resolvedSpecialty, visitId]);
  await execute("UPDATE doctor_assignments SET status = 'reassigned' WHERE visit_id = ? AND status = 'active'", [visitId]);
  await execute(
    'INSERT INTO doctor_assignments (visit_id, patient_id, doctor_id, assigned_by, specialty, status, notes) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [visitId, visit.patient_id, doc.id, req.user!.id, resolvedSpecialty, 'active', notes ? String(notes).trim() : 'OPD doctor assignment']
  );

  const activeTicket = await queryOne<{ id: number; department: string }>(
    "SELECT id, department FROM queue_tickets WHERE visit_id = ? AND status IN ('waiting','called','in_service') ORDER BY id DESC LIMIT 1",
    [visitId]
  );
  if (activeTicket) {
    const noteText = notes ? `${notes} — Assigned to ${doc.full_name}` : `Assigned to ${doc.full_name}`;
    await execute('UPDATE queue_tickets SET notes = ? WHERE id = ?', [noteText, activeTicket.id]);
  }

  await createNotification({
    targetRole: 'DOC',
    targetUserId: doc.id,
    title: 'OPD Patient Assigned',
    message: `${patient ? `${patient.first_name} ${patient.last_name} (${patient.mrn})` : `Visit ${visit.visit_number}`} assigned to ${doc.full_name} (${visit.visit_number}).`,
    severity: 'info',
    entityType: 'visit',
    entityId: visitId,
  });

  await writeAuditLog({
    user: req.user,
    action: 'visit.assign_doctor',
    entityType: 'visit',
    entityId: visitId,
    patientId: visit.patient_id,
    before: { doctor_id: visit.doctor_id, specialty: visit.specialty },
    after: { doctor_id: doc.id, doctor_name: doc.full_name, specialty: resolvedSpecialty },
    req,
  });

  broadcastClinicEvent('visit:updated', { visitId });
  broadcastClinicEvent('queue:updated', { visitId });
  res.json({ ok: true, doctor_id: doc.id, doctor_name: doc.full_name, specialty: resolvedSpecialty });
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
  if (triage_priority === 'emergency' && !hasPermission(req.user!, 'triage.emergency.set')) {
    return res.status(403).json({ error: 'Assigning emergency priority requires triage.emergency.set permission.' });
  }

  const result = await withTransaction(async () => {
    const patient = await queryOne<{ id: number; patient_type: string; payer_name: string | null }>(
      'SELECT id, patient_type, payer_name FROM patients WHERE id = ? AND status = ?',
      [Number(patient_id), 'active']
    );
    if (!patient) return { ok: false as const, error: 'Active patient record not found', httpStatus: 404 };

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
      await postInvoiceAccrualJE({
        invoiceId: consultInvId,
        invoiceNumber: consultInvNum,
        payerType: patient.patient_type,
        totalAmount: fee,
        postedBy: req.user!.id,
        description: `Consultation invoice ${consultInvNum} (${resolvedSpecialty})`,
      });
    }

    let receiptNumber: string | null = null;
    let paidAtCheckIn = false;
    if (collect_payment && consultInvId && consultInvStatus === 'unpaid' && consultationFee > 0) {
      if (!hasPermission(req.user!, 'billing.payment.create')) {
        return { ok: false as const, error: 'Only Cashiers with payment permission can collect upfront consultation fees.', httpStatus: 403 };
      }
      const allowedMethods = new Set(['cash', 'card', 'mobile_money', 'bank_transfer']);
      const method = String(payment_method || 'cash').trim().toLowerCase();
      if (!allowedMethods.has(method)) {
        return { ok: false as const, error: 'Invalid payment method.', httpStatus: 400 };
      }
      const openShift = await queryOne<{ id: number }>(
        "SELECT id FROM cashier_shifts WHERE cashier_id = ? AND status = 'open'",
        [req.user!.id]
      );
      if (!openShift) {
        return { ok: false as const, error: 'You must open a Cashier Shift before collecting payments.', httpStatus: 409 };
      }
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
          { accountCode: '1150', credit: consultationFee, memo: `Clear AR ${consultInvNum}` },
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
    if (doctor_id) {
      await execute(
        'INSERT INTO doctor_assignments (visit_id, patient_id, doctor_id, assigned_by, specialty, status, notes) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [inserted.insertId, patient.id, Number(doctor_id), req.user!.id, resolvedSpecialty, 'active', 'Assigned during visit registration']
      );
    }

    if (triage_priority === 'emergency' && isSelfPay && consultInvId && !paidAtCheckIn) {
      await recordPaymentGateBypass({
        visitId: inserted.insertId,
        patientId: patient.id,
        entityType: 'visit_consultation',
        entityId: inserted.insertId,
        user: req.user!,
        reason: 'Emergency triage visit automatic consultation gate override',
        req,
      });
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
        targetRole: doctor_id ? 'DOC' : 'MGR',
        targetUserId: doctor_id ? Number(doctor_id) : null,
        title: 'Emergency Visit Started',
        message: doctor_id
          ? `Emergency visit ${visitNum} assigned to ${doctorName || 'doctor'} requires immediate assessment.`
          : `Emergency visit ${visitNum} requires immediate OPD doctor assignment.`,
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
      if (doctor_id) {
        await createNotification({
          targetRole: 'DOC',
          targetUserId: Number(doctor_id),
          title: 'OPD Visit Assigned',
          message: `Walk-in visit ${visitNum} assigned to ${doctorName || 'you'} (awaiting triage vitals).`,
          severity: 'info',
          entityType: 'visit',
          entityId: inserted.insertId,
        });
      }
    } else {
      await createNotification({
        targetRole: 'CSH',
        title: 'Consultation Payment Due',
        message: `Visit ${visitNum} awaiting consultation payment (${consultInvNum}).`,
        severity: 'info',
        entityType: 'visit',
        entityId: inserted.insertId,
      });
      if (doctor_id) {
        await createNotification({
          targetRole: 'DOC',
          targetUserId: Number(doctor_id),
          title: 'OPD Visit Assigned (Payment Pending)',
          message: `Walk-in visit ${visitNum} assigned to ${doctorName || 'you'} (awaiting consultation payment).`,
          severity: 'info',
          entityType: 'visit',
          entityId: inserted.insertId,
        });
      }
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
  if (visit.status === 'closed') {
    return res.status(409).json({ error: 'Cannot record vitals on a closed visit.' });
  }

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

  if (triage_priority === 'emergency' && visit.triage_priority !== 'emergency' && !hasPermission(req.user!, 'triage.emergency.set')) {
    return res.status(403).json({ error: 'Elevating visit priority to emergency requires triage.emergency.set permission.' });
  }

  const rangeError = validateVitalsRanges({
    bp_systolic,
    bp_diastolic,
    temperature,
    pulse,
    respiratory_rate,
    spo2,
    weight_kg,
    height_cm,
    blood_glucose,
  });
  if (rangeError) return res.status(400).json({ error: rangeError });

  const hasCoreVital =
    bp_systolic != null || temperature != null || pulse != null || respiratory_rate != null || spo2 != null;
  if (!hasCoreVital) {
    return res.status(400).json({ error: 'At least one core clinical vital (BP, Temp, Pulse, RR, or SpO2) is required.' });
  }

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
      await recordPaymentGateBypass({
        visitId,
        patientId: visit.patient_id,
        entityType: 'visit_consultation',
        entityId: visitId,
        user: req.user!,
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
      targetRole: assignedDoctorId ? 'DOC' : 'MGR',
      targetUserId: assignedDoctorId ? Number(assignedDoctorId) : null,
      title: 'Early-Warning Vitals Alert',
      message: `Visit ${visit.visit_number} flagged abnormal vitals (SpO2 ${spo2}%, Temp ${temperature}°C) — routed to ${doctorLabel}.`,
      severity: 'critical',
      entityType: 'visit',
      entityId: visitId,
    });
  } else if (assignedDoctorId) {
    await createNotification({
      targetRole: 'DOC',
      targetUserId: Number(assignedDoctorId),
      title: 'Ready for Doctor',
      message: `Vitals recorded for ${visit.visit_number}. Patient routed to ${doctorLabel}.`,
      severity: 'info',
      entityType: 'visit',
      entityId: visitId,
    });
  } else {
    await createNotification({
      targetRole: 'REC',
      title: 'Vitals Recorded — Assign OPD Doctor',
      message: `Vitals recorded for ${visit.visit_number}. Ready for OPD doctor assignment.`,
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

router.post('/vitals/:id/correct', requireAuth, requirePermission('vitals.create'), async (req: AuthRequest, res: Response) => {
  const vitalId = Number(req.params.id);
  const existing = await queryOne<{
    id: number;
    visit_id: number | null;
    admission_id: number | null;
    patient_id: number;
    bp_systolic: number | null;
    bp_diastolic: number | null;
    temperature: number | null;
    pulse: number | null;
    respiratory_rate: number | null;
    spo2: number | null;
    weight_kg: number | null;
    height_cm: number | null;
    blood_glucose: number | null;
    recorded_at: string;
  }>('SELECT * FROM vitals WHERE id = ?', [vitalId]);
  if (!existing) return res.status(404).json({ error: 'Vitals entry not found' });

  if (existing.visit_id) {
    const parentVisit = await queryOne<{ status: string }>('SELECT status FROM visits WHERE id = ?', [existing.visit_id]);
    if (parentVisit?.status === 'closed') {
      return res.status(409).json({ error: 'Cannot amend vitals on a closed visit.' });
    }
  }
  if (existing.admission_id) {
    const parentAdm = await queryOne<{ status: string }>('SELECT status FROM admissions WHERE id = ?', [existing.admission_id]);
    if (parentAdm?.status === 'discharged') {
      return res.status(409).json({ error: 'Cannot amend vitals on a discharged admission.' });
    }
  }
  if (isDoctorOnly(req.user!)) {
    const access = await assertPatientAccess(req.user!, existing.patient_id);
    if (!access.allowed) {
      return res.status(403).json({ error: access.reason || 'Access denied: patient vitals are not assigned to you.' });
    }
  }

  const recordedMs = new Date(`${String(existing.recorded_at).replace(' ', 'T')}Z`).getTime();
  if (Number.isFinite(recordedMs) && Date.now() - recordedMs > 24 * 3600 * 1000) {
    return res.status(409).json({ error: 'Vitals correction window (24 hours) has expired. Record a new observation row instead.' });
  }

  const {
    bp_systolic = existing.bp_systolic,
    bp_diastolic = existing.bp_diastolic,
    temperature = existing.temperature,
    pulse = existing.pulse,
    respiratory_rate = existing.respiratory_rate,
    spo2 = existing.spo2,
    weight_kg = existing.weight_kg,
    height_cm = existing.height_cm,
    blood_glucose = existing.blood_glucose,
    notes,
    correction_reason,
  } = req.body || {};
  if (!correction_reason || String(correction_reason).trim().length < 5) {
    return res.status(400).json({ error: 'Correction reason (min 5 characters) is required for vitals amendment.' });
  }

  const rangeError = validateVitalsRanges({
    bp_systolic,
    bp_diastolic,
    temperature,
    pulse,
    respiratory_rate,
    spo2,
    weight_kg,
    height_cm,
    blood_glucose,
  });
  if (rangeError) return res.status(400).json({ error: rangeError });

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
    `INSERT INTO vitals (visit_id, admission_id, patient_id, bp_systolic, bp_diastolic, temperature, pulse, respiratory_rate, spo2, weight_kg, height_cm, bmi, blood_glucose, early_warning_flag, notes, corrected_of_id, correction_reason, recorded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      existing.visit_id,
      existing.admission_id,
      existing.patient_id,
      bp_systolic ?? null,
      bp_diastolic ?? null,
      temperature ?? null,
      pulse ?? null,
      respiratory_rate ?? null,
      spo2 ?? null,
      w,
      h,
      bmi,
      blood_glucose ?? null,
      earlyWarning,
      notes ?? null,
      vitalId,
      String(correction_reason).trim(),
      req.user!.id,
    ]
  );

  await writeAuditLog({
    user: req.user,
    action: 'vitals.correct',
    entityType: 'vitals',
    entityId: inserted.insertId,
    patientId: existing.patient_id,
    before: existing,
    after: { correctedOfId: vitalId, bp_systolic, bp_diastolic, temperature, pulse, respiratory_rate, spo2, bmi },
    reason: String(correction_reason).trim(),
    req,
  });

  if (existing.visit_id) broadcastClinicEvent('vitals:recorded', { visitId: existing.visit_id });
  res.status(201).json({ id: inserted.insertId, correctedOfId: vitalId, bmi, earlyWarningFlag: Boolean(earlyWarning) });
});

router.patch(
  '/visits/:id/consultation',
  requireAuth,
  authorize('visit.update', {
    checkDoctorAssignment: true,
    visitIdParam: 'id',
    audit: { action: 'visit.update', entityType: 'visit', entityIdParam: 'id', captureBody: true, dedupeIfAudited: true },
  }),
  async (req: AuthRequest, res: Response) => {
  const visitId = Number(req.params.id);
  const licenceCheck = await checkActiveClinicianLicence(req.user!.id);
  if (!licenceCheck.valid) {
    return res.status(403).json({ error: licenceCheck.error });
  }

  const visit = await queryOne<{ id: number; patient_id: number; doctor_id: number | null; status: string }>(
    'SELECT id, patient_id, doctor_id, status FROM visits WHERE id = ?',
    [visitId]
  );
  if (!visit) return res.status(404).json({ error: 'Visit not found' });
  if (visit.status === 'closed') {
    return res.status(409).json({ error: 'Visit is closed and locked. Manager approval is required to reopen.' });
  }
  if (
    visit.doctor_id != null &&
    Number(visit.doctor_id) !== req.user!.id &&
    !hasPermission(req.user!, 'visit.reopen') &&
    !req.user!.roles.includes('MGR')
  ) {
    return res.status(403).json({
      error: 'This visit is assigned to another clinician. Reassignment or Manager override is required.',
    });
  }
  if (isDoctorOnly(req.user!) && visit.doctor_id == null) {
    const access = await assertPatientAccess(req.user!, Number(visit.patient_id));
    if (!access.allowed && !access.breakGlassActive) {
      return res.status(403).json({
        error: 'This visit has not been assigned to you yet. OPD Doctor Assignment or Break-Glass is required.',
      });
    }
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

  let followUpAppointmentId: number | null = null;
  if (follow_up_date && /^\d{4}-\d{2}-\d{2}$/.test(String(follow_up_date))) {
    const assignedDoc = visit.doctor_id || req.user!.id;
    const existingFu = await queryOne<{ id: number }>(
      "SELECT id FROM appointments WHERE patient_id = ? AND appointment_date = ? AND status != 'cancelled' LIMIT 1",
      [visit.patient_id, String(follow_up_date)]
    );
    if (!existingFu) {
      const conflict = await queryOne<{ id: number }>(
        "SELECT id FROM appointments WHERE doctor_id = ? AND appointment_date = ? AND status NOT IN ('cancelled','no_show') AND start_time = '09:00' LIMIT 1",
        [assignedDoc, String(follow_up_date)]
      );
      const startTime = conflict ? '14:00' : '09:00';
      const endTime = conflict ? '14:30' : '09:30';
      const fuRes = await execute(
        `INSERT INTO appointments (patient_id, doctor_id, appointment_date, start_time, end_time, visit_type, reason, status, created_by)
         VALUES (?, ?, ?, ?, ?, 'follow-up', ?, 'scheduled', ?)`,
        [visit.patient_id, assignedDoc, String(follow_up_date), startTime, endTime, `Follow-up for ${diagnosis_text || 'consultation'}`, req.user!.id]
      );
      followUpAppointmentId = fuRes.insertId;
    }
  }

  await writeAuditLog({
    user: req.user,
    action: 'visit.update',
    entityType: 'visit',
    entityId: visitId,
    patientId: visit.patient_id,
    after: { diagnosis_code, diagnosis_text, follow_up_date, followUpAppointmentId },
    req,
  });

  broadcastClinicEvent('visit:updated', { visitId });
  res.json({ ok: true, followUpAppointmentId });
});

router.post(
  '/visits/:id/close',
  requireAuth,
  authorize('visit.close', {
    checkDoctorAssignment: true,
    visitIdParam: 'id',
    audit: { action: 'visit.close', entityType: 'visit', entityIdParam: 'id', dedupeIfAudited: true },
  }),
  async (req: AuthRequest, res: Response) => {
  const visitId = Number(req.params.id);
  const { force_partial_close, reason } = req.body || {};
  const result = await closeVisit({
    visitId,
    user: req.user!,
    req,
    forcePartialClose: Boolean(force_partial_close),
    forceReason: reason ? String(reason).trim() : undefined,
  });
  if (!result.ok) {
    return res.status(result.httpStatus).json({ error: result.error });
  }
  res.json({ ok: true });
});

router.post(
  '/visits/:id/reopen',
  requireAuth,
  authorize('visit.reopen', {
    audit: { action: 'visit.reopen', entityType: 'visit', entityIdParam: 'id', dedupeIfAudited: true },
  }),
  async (req: AuthRequest, res: Response) => {
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

router.post(
  '/visits/:id/orders/lab',
  requireAuth,
  authorize('order.lab.create', {
    checkDoctorAssignment: true,
    visitIdParam: 'id',
    audit: { action: 'lab.order.create', entityType: 'lab_order', dedupeIfAudited: true },
  }),
  async (req: AuthRequest, res: Response) => {
  const visitId = Number(req.params.id);
  const { test_id } = req.body || {};
  if (!test_id) return res.status(400).json({ error: 'test_id is required' });

  const result = await withTransaction(async () => {
    const visit = await queryOne<{ id: number; patient_id: number; doctor_id: number | null; status: string }>(
      'SELECT id, patient_id, doctor_id, status FROM visits WHERE id = ?',
      [visitId]
    );
    if (!visit) return { ok: false as const, error: 'Visit not found', httpStatus: 404 };
    if (isDoctorOnly(req.user!) && Number(visit.doctor_id) !== req.user!.id) {
      const access = await assertPatientAccess(req.user!, visit.patient_id);
      if (!access.breakGlassActive) {
        return { ok: false as const, error: 'You may only order lab tests for your own assigned patients.', httpStatus: 403 };
      }
    }
    if (visit.status === 'closed') return { ok: false as const, error: 'Cannot order tests on a closed visit.', httpStatus: 409 };

    const test = await queryOne<{ id: number; code: string; name: string; price: number }>('SELECT * FROM lab_tests WHERE id = ?', [test_id]);
    if (!test) return { ok: false as const, error: 'Lab test not found', httpStatus: 404 };

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
    await postInvoiceAccrualJE({
      invoiceId: invRes.insertId,
      invoiceNumber: invNum,
      payerType: patient?.patient_type || 'self-pay',
      totalAmount: total,
      postedBy: req.user!.id,
      description: `Lab order accrual ${invNum} (${test.name})`,
    });

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

    return { ok: true as const, id: orderRes.insertId, invoiceNumber: invNum, invoiceStatus: invStatus };
  });

  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error });
  broadcastClinicEvent('lab:updated', { visitId, orderId: result.id });
  broadcastClinicEvent('visit:updated', { visitId });
  res.status(201).json(result);
});

router.post(
  '/visits/:id/orders/imaging',
  requireAuth,
  authorize('order.imaging.create', {
    checkDoctorAssignment: true,
    visitIdParam: 'id',
    audit: { action: 'imaging.order.create', entityType: 'imaging_order', dedupeIfAudited: true },
  }),
  async (req: AuthRequest, res: Response) => {
  const visitId = Number(req.params.id);
  const { catalog_id, clinical_question } = req.body || {};
  if (!catalog_id) return res.status(400).json({ error: 'catalog_id is required' });

  const result = await withTransaction(async () => {
    const visit = await queryOne<{ id: number; patient_id: number; doctor_id: number | null; status: string }>(
      'SELECT id, patient_id, doctor_id, status FROM visits WHERE id = ?',
      [visitId]
    );
    if (!visit) return { ok: false as const, error: 'Visit not found', httpStatus: 404 };
    if (isDoctorOnly(req.user!) && Number(visit.doctor_id) !== req.user!.id) {
      const access = await assertPatientAccess(req.user!, visit.patient_id);
      if (!access.breakGlassActive) {
        return { ok: false as const, error: 'You may only order imaging for your own assigned patients.', httpStatus: 403 };
      }
    }
    if (visit.status === 'closed') return { ok: false as const, error: 'Cannot order imaging on a closed visit.', httpStatus: 409 };

    const exam = await queryOne<{ id: number; code: string; name: string; price: number }>('SELECT * FROM imaging_catalog WHERE id = ?', [catalog_id]);
    if (!exam) return { ok: false as const, error: 'Imaging exam not found', httpStatus: 404 };

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
    await postInvoiceAccrualJE({
      invoiceId: invRes.insertId,
      invoiceNumber: invNum,
      payerType: patient?.patient_type || 'self-pay',
      totalAmount: total,
      postedBy: req.user!.id,
      description: `Imaging order accrual ${invNum} (${exam.name})`,
    });

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

    return { ok: true as const, id: ordRes.insertId, invoiceNumber: invNum, invoiceStatus: invStatus };
  });

  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error });
  broadcastClinicEvent('imaging:updated', { visitId, orderId: result.id });
  broadcastClinicEvent('visit:updated', { visitId });
  res.status(201).json(result);
});

router.post(
  '/visits/:id/orders/prescription',
  requireAuth,
  authorize('prescription.create', {
    checkDoctorAssignment: true,
    visitIdParam: 'id',
    audit: { action: 'prescription.create', entityType: 'prescription', dedupeIfAudited: true },
  }),
  async (req: AuthRequest, res: Response) => {
  const visitId = Number(req.params.id);
  const licenceCheck = await checkActiveClinicianLicence(req.user!.id);
  if (!licenceCheck.valid) {
    return res.status(403).json({ error: licenceCheck.error });
  }

  const { items: rawItems, medicine_id, dosage, frequency, duration_days = 5, quantity = 1, instructions, notes, overrideAllergyReason, allergy_override_reason } = req.body || {};

  const normalizedItems = Array.isArray(rawItems) && rawItems.length > 0
    ? rawItems
    : medicine_id && dosage && frequency && quantity
      ? [{ medicine_id, dosage, frequency, duration_days, quantity, instructions }]
      : [];

  if (normalizedItems.length === 0) {
    return res.status(400).json({ error: 'At least one prescription item with medicine, dosage, frequency, and quantity is required.' });
  }

  for (const it of normalizedItems) {
    if (!it.medicine_id || !it.dosage || !it.frequency || Number(it.quantity) <= 0) {
      return res.status(400).json({ error: 'Every prescription item requires medicine, dosage, frequency, and positive quantity.' });
    }
  }

  const visit = await queryOne<{ id: number; patient_id: number; doctor_id: number | null; status: string }>(
    'SELECT id, patient_id, doctor_id, status FROM visits WHERE id = ?',
    [visitId]
  );
  if (!visit) return res.status(404).json({ error: 'Visit not found' });
  if (isDoctorOnly(req.user!) && Number(visit.doctor_id) !== req.user!.id) {
    const access = await assertPatientAccess(req.user!, visit.patient_id);
    if (!access.breakGlassActive) {
      return res.status(403).json({ error: 'You may only prescribe for your own assigned patients.' });
    }
  }
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

  const allergyConflicts = normalizedItems
    .map((it) => medMap.get(Number(it.medicine_id))!.generic_name)
    .filter((name) => findAllergyConflicts(patient?.allergies, name));
  const cleanOverrideReason = String(overrideAllergyReason || allergy_override_reason || '').trim();
  if (allergyConflicts.length > 0 && cleanOverrideReason.length < 5) {
    return res.status(409).json({
      error: `Allergy Warning: Patient has documented allergies (${patient?.allergies}) conflicting with [${allergyConflicts.join(', ')}]. Provide clinical override reason (min 5 chars) to prescribe.`,
      allergyConflicts,
    });
  }

  const rxRes = await execute(
    "INSERT INTO prescriptions (visit_id, patient_id, doctor_id, invoice_id, status, allergy_override_reason, notes) VALUES (?, ?, ?, NULL, 'awaiting_stock_check', ?, ?)",
    [visitId, visit.patient_id, req.user!.id, allergyConflicts.length > 0 ? cleanOverrideReason : null, notes || null]
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
    severity: allergyConflicts.length > 0 ? 'warning' : 'info',
    entityType: 'prescription',
    entityId: rxRes.insertId,
  });

  await writeAuditLog({
    user: req.user,
    action: 'prescription.create',
    entityType: 'prescription',
    entityId: rxRes.insertId,
    patientId: visit.patient_id,
    reason: allergyConflicts.length > 0 ? cleanOverrideReason : null,
    after: {
      itemCount: normalizedItems.length,
      medicines: normalizedItems.map((it) => ({ name: medMap.get(Number(it.medicine_id))!.generic_name, quantity: Number(it.quantity) })),
      allergyConflicts,
      status: 'awaiting_stock_check',
    },
    req,
  });

  broadcastClinicEvent('pharmacy:updated', { visitId, prescriptionId: rxRes.insertId });
  broadcastClinicEvent('visit:updated', { visitId });
  res.status(201).json({ id: rxRes.insertId, status: 'awaiting_stock_check', patientAllergies: patient?.allergies });
});

router.post(
  '/visits/:id/nursing-procedures',
  requireAuth,
  authorize(['nursing.procedure.perform', 'order.lab.create'], { checkDoctorAssignment: true, visitIdParam: 'id' }),
  async (req: AuthRequest, res: Response) => {
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
    await postInvoiceAccrualJE({
      invoiceId: invRes.insertId,
      invoiceNumber: invNum,
      payerType: patient?.patient_type || 'self-pay',
      totalAmount: total,
      postedBy: req.user!.id,
      description: `Nursing procedure accrual ${invNum} (${svc.name})`,
    });

    const procStatus = perform_now ? 'completed' : 'ordered';
    const rawNote = String(notes || clinical_notes || '').trim();
    const combinedNote = qty > 1 ? `Qty ${qty}${rawNote ? ` · ${rawNote}` : ''}` : rawNote || null;
    const procRes = await execute(
      `INSERT INTO nursing_procedures (visit_id, patient_id, service_id, service_code, service_name, invoice_id, ordered_by, performed_by, notes, status, performed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        perform_now ? nowSql() : null,
      ]
    );

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
  const existing = await queryOne<{ id: number; visit_id: number; patient_id: number; invoice_id: number | null; status: string }>(
    'SELECT id, visit_id, patient_id, invoice_id, status FROM nursing_procedures WHERE id = ?',
    [id]
  );
  if (!existing) return res.status(404).json({ error: 'Nursing procedure not found' });
  if (existing.status === 'completed' || existing.status === 'cancelled') {
    return res.status(409).json({ error: `Nursing procedure is already ${existing.status}.` });
  }
  const visit = await queryOne<{ status: string; triage_priority: string }>(
    'SELECT status, triage_priority FROM visits WHERE id = ?',
    [existing.visit_id]
  );
  if (visit?.status === 'closed') {
    return res.status(409).json({ error: 'Cannot complete nursing procedures on a closed visit.' });
  }
  if (existing.invoice_id) {
    const inv = await queryOne<{ status: string; payer_type: string }>('SELECT status, payer_type FROM invoices WHERE id = ?', [
      existing.invoice_id,
    ]);
    if (inv && inv.payer_type === 'self-pay' && inv.status !== 'paid') {
      const bypassCheck = canBypassPaymentGate(
        req.user!,
        visit?.triage_priority === 'emergency',
        req.body?.bypass_payment_gate,
        req.body?.bypass_reason
      );
      if (bypassCheck.allowed) {
        await recordPaymentGateBypass({
          visitId: existing.visit_id,
          patientId: existing.patient_id,
          entityType: 'nursing_procedure',
          entityId: id,
          user: req.user!,
          reason: bypassCheck.reasonText,
          req,
        });
      } else {
        return res.status(402).json({
          error: 'Payment Gate: Self-pay nursing procedure invoice must be paid at Cashier before completion.',
        });
      }
    }
  }
  const { notes, clinical_notes } = req.body || {};
  const finalNote = (notes || clinical_notes || '').trim() || null;
  await execute(
    "UPDATE nursing_procedures SET status = 'completed', performed_by = ?, notes = COALESCE(?, notes), performed_at = ? WHERE id = ?",
    [req.user!.id, finalNote, nowSql(), id]
  );
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

router.post('/orders/:type/:id/cancel', requireAuth, requirePermission('order.lab.create', 'order.imaging.create', 'nursing.procedure.perform', 'approval.decide'), async (req: AuthRequest, res: Response) => {
  const orderType = String(req.params.type);
  const id = Number(req.params.id);
  const reason = String(req.body?.reason || '').trim();
  if (reason.length < 5) {
    return res.status(400).json({ error: 'Cancellation reason (min 5 characters) is required.' });
  }

  const tableMap: Record<string, { table: string; allowedStatuses: string[] }> = {
    lab: { table: 'lab_orders', allowedStatuses: ['ordered'] },
    imaging: { table: 'imaging_orders', allowedStatuses: ['ordered', 'scheduled'] },
    nursing: { table: 'nursing_procedures', allowedStatuses: ['ordered'] },
  };
  const cfg = tableMap[orderType];
  if (!cfg) return res.status(400).json({ error: 'Invalid order type (expected lab, imaging, or nursing).' });

  const result = await withTransaction(async () => {
    const row = await queryOne<{ id: number; visit_id: number; patient_id: number; invoice_id: number | null; status: string }>(
      `SELECT id, visit_id, patient_id, invoice_id, status FROM ${cfg.table} WHERE id = ?`,
      [id]
    );
    if (!row) return { ok: false as const, error: 'Order not found', httpStatus: 404 };
    const visit = await queryOne<{ status: string; doctor_id: number | null }>(
      'SELECT status, doctor_id FROM visits WHERE id = ?',
      [row.visit_id]
    );
    if (visit?.status === 'closed') {
      return { ok: false as const, error: 'Cannot cancel orders on a closed visit.', httpStatus: 409 };
    }
    if (isDoctorOnly(req.user!)) {
      const activeAssign = await queryOne<{ id: number }>(
        "SELECT id FROM doctor_assignments WHERE visit_id = ? AND doctor_id = ? AND status = 'active' LIMIT 1",
        [row.visit_id, req.user!.id]
      ).catch(() => null);
      if (Number(visit?.doctor_id) !== req.user!.id && !activeAssign) {
        const access = await assertPatientAccess(req.user!, row.patient_id);
        if (!access.allowed) {
          return { ok: false as const, error: 'Access denied: order belongs to another clinician.', httpStatus: 403 };
        }
      }
    }
    if (!cfg.allowedStatuses.includes(row.status)) {
      return { ok: false as const, error: `Order cannot be cancelled once in '${row.status}' state.`, httpStatus: 409 };
    }
    if (row.invoice_id) {
      const inv = await queryOne<{ id: number; invoice_number: string; status: string; paid_amount: number; total_amount: number; payer_type: string }>(
        'SELECT * FROM invoices WHERE id = ?',
        [row.invoice_id]
      );
      if (inv && Number(inv.paid_amount) > 0) {
        return { ok: false as const, error: 'Invoice already has payments. Submit a Refund/Void approval request at Cashier instead.', httpStatus: 409 };
      }
      if (inv && inv.status !== 'voided') {
        await execute("UPDATE invoices SET status = 'voided', notes = ? WHERE id = ?", [`Order cancelled: ${reason}`, inv.id]);
        if (await hasInvoiceAccrualJE(inv.id)) {
          const arAcct = inv.payer_type === 'insurance' || inv.payer_type === 'credit' ? '1100' : '1150';
          const revLines = await buildPerLineRevenueLines(inv.id, Number(inv.total_amount), 'debit', `Order cancel void ${inv.invoice_number}`);
          await postJournalEntry({
            sourceType: 'order_cancel_void',
            sourceId: inv.id,
            description: `Void invoice ${inv.invoice_number} on order cancellation (${reason})`,
            postedBy: req.user!.id,
            lines: [...revLines, { accountCode: arAcct, credit: Number(inv.total_amount), memo: `Reverse AR ${inv.invoice_number}` }],
          });
        }
      }
    }
    await execute(`UPDATE ${cfg.table} SET status = 'cancelled' WHERE id = ?`, [id]);
    await writeAuditLog({
      user: req.user,
      action: `order.${orderType}.cancel`,
      entityType: cfg.table,
      entityId: id,
      patientId: row.patient_id,
      reason,
      before: { status: row.status },
      after: { status: 'cancelled' },
      req,
    });
    return { ok: true as const, visitId: row.visit_id };
  });

  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error });
  broadcastClinicEvent('visit:updated', { visitId: result.visitId });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// LABORATORY WORKLIST (Two-Step Verify, Multi-Analyte Panels, Reject, Amend)
// ---------------------------------------------------------------------------
router.get('/lab/orders', requireAuth, requirePermission('lab.order.read'), async (req: AuthRequest, res: Response) => {
  const doctorScoped = isDoctorOnly(req.user!);
  const orders = await query(
    `SELECT lo.*, lt.code AS test_code, lt.name AS test_name, lt.sample_type, lt.unit, lt.reference_range, lt.analyte_template_json,
            p.mrn, p.first_name, p.last_name, p.patient_type, v.triage_priority, v.visit_number, v.doctor_id,
            i.invoice_number, i.status AS invoice_status,
            u_ent.full_name AS entered_by_name, u_ver.full_name AS verified_by_name
     FROM lab_orders lo
     INNER JOIN lab_tests lt ON lt.id = lo.test_id
     INNER JOIN patients p ON p.id = lo.patient_id
     INNER JOIN visits v ON v.id = lo.visit_id
     LEFT JOIN invoices i ON i.id = lo.invoice_id
     LEFT JOIN users u_ent ON u_ent.id = lo.entered_by
     LEFT JOIN users u_ver ON u_ver.id = lo.verified_by
     ${doctorScoped ? "WHERE (v.doctor_id = ? OR EXISTS (SELECT 1 FROM doctor_assignments da WHERE da.visit_id = v.id AND da.doctor_id = ? AND da.status = 'active'))" : ''}
     ORDER BY CASE v.triage_priority WHEN 'emergency' THEN 1 WHEN 'urgent' THEN 2 ELSE 3 END, lo.id DESC LIMIT 60`,
    doctorScoped ? [req.user!.id, req.user!.id] : []
  );
  res.json({ orders, isDoctorScoped: doctorScoped });
});

router.patch('/lab/orders/:id', requireAuth, requirePermission('lab.sample.collect', 'lab.result.enter', 'lab.result.verify', 'lab.sample.recollect', 'lab.critical.ack'), async (req: AuthRequest, res: Response) => {
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
  if (order.status === 'cancelled') {
    return res.status(409).json({ error: 'Cancelled lab order cannot be modified.' });
  }

  const visit = await queryOne<{ triage_priority: string; doctor_id: number | null }>(
    'SELECT triage_priority, doctor_id FROM visits WHERE id = ?',
    [order.visit_id]
  );
  const { action, result_value, abnormal_flag, result_notes, rejection_reason, amend_reason, bypass_payment_gate, panel_results } = req.body || {};

  if (action === 'ack_critical') {
    if (!hasPermission(req.user!, 'lab.critical.ack')) {
      return res.status(403).json({ error: 'Missing lab.critical.ack permission' });
    }
    if (!['resulted', 'verified', 'amended'].includes(order.status)) {
      return res.status(409).json({ error: `Cannot acknowledge critical result while lab order is '${order.status}'.` });
    }
    if (isDoctorOnly(req.user!)) {
      const activeAssign = await queryOne<{ id: number }>(
        "SELECT id FROM doctor_assignments WHERE visit_id = ? AND doctor_id = ? AND status = 'active' LIMIT 1",
        [order.visit_id, req.user!.id]
      ).catch(() => null);
      if (Number(visit?.doctor_id) !== req.user!.id && !activeAssign) {
        const access = await assertPatientAccess(req.user!, order.patient_id);
        if (!access.allowed) {
          return res.status(403).json({ error: 'Access denied: lab order belongs to another clinician.' });
        }
      }
    }
    await execute('UPDATE lab_orders SET critical_ack_by = ?, critical_ack_at = ? WHERE id = ?', [req.user!.id, nowSql(), id]);
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
        await recordPaymentGateBypass({
          visitId: order.visit_id,
          patientId: order.patient_id,
          entityType: 'lab_order',
          entityId: id,
          user: req.user!,
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
    await execute("UPDATE lab_orders SET status = 'collected', sample_barcode = ?, collected_by = ?, collected_at = ? WHERE id = ?", [
      barcode,
      req.user!.id,
      nowSql(),
      id,
    ]);
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
      targetUserId: visit?.doctor_id ?? null,
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
    if (!hasPermission(req.user!, 'lab.sample.recollect', 'lab.sample.collect')) {
      return res.status(403).json({ error: 'Missing lab.sample.recollect permission' });
    }
    if (order.status !== 'rejected') {
      return res.status(409).json({ error: 'Only rejected samples can be reset for recollection.' });
    }
    await execute(
      "UPDATE lab_orders SET status = 'ordered', sample_barcode = NULL, rejection_reason = NULL, collected_by = NULL, collected_at = NULL WHERE id = ?",
      [id]
    );
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
    if (derivedFlag === 'critical') {
      await createNotification({
        targetRole: 'DOC',
        targetUserId: visit?.doctor_id ?? null,
        title: 'CRITICAL Lab Finding Entered',
        message: `Lab order #${id} flagged CRITICAL (${computedSummary}). Pending senior verification.`,
        severity: 'critical',
        entityType: 'lab_order',
        entityId: id,
      });
    }
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
    await execute("UPDATE lab_orders SET status = 'verified', verified_by = ?, verified_at = ? WHERE id = ?", [
      req.user!.id,
      nowSql(),
      id,
    ]);

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
      targetUserId: visit?.doctor_id ?? null,
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
router.get('/imaging/orders', requireAuth, requirePermission('imaging.order.read'), async (req: AuthRequest, res: Response) => {
  const doctorScoped = isDoctorOnly(req.user!);
  const orders = await query(
    `SELECT io.*, ic.code AS exam_code, ic.name AS exam_name, ic.modality, ic.body_region,
            p.mrn, p.first_name, p.last_name, p.sex, p.date_of_birth, p.patient_type,
            v.visit_number, v.doctor_id,
            i.invoice_number, i.status AS invoice_status,
            (SELECT COUNT(*) FROM imaging_attachments ia WHERE ia.imaging_order_id = io.id) AS attachment_count
     FROM imaging_orders io
     INNER JOIN imaging_catalog ic ON ic.id = io.catalog_id
     INNER JOIN patients p ON p.id = io.patient_id
     LEFT JOIN visits v ON v.id = io.visit_id
     LEFT JOIN invoices i ON i.id = io.invoice_id
     ${doctorScoped ? "WHERE (v.doctor_id = ? OR EXISTS (SELECT 1 FROM doctor_assignments da WHERE da.visit_id = v.id AND da.doctor_id = ? AND da.status = 'active'))" : ''}
     ORDER BY io.id DESC LIMIT 60`,
    doctorScoped ? [req.user!.id, req.user!.id] : []
  );
  res.json({ orders, isDoctorScoped: doctorScoped });
});

router.get('/imaging/orders/:id/attachments', requireAuth, requirePermission('imaging.order.read', 'visit.read'), async (req: AuthRequest, res: Response) => {
  const orderId = Number(req.params.id);
  if (isDoctorOnly(req.user!)) {
    const ord = await queryOne<{ visit_id: number | null; patient_id: number; doctor_id: number | null }>(
      `SELECT io.visit_id, io.patient_id, v.doctor_id FROM imaging_orders io LEFT JOIN visits v ON v.id = io.visit_id WHERE io.id = ?`,
      [orderId]
    );
    if (!ord) return res.status(404).json({ error: 'Imaging order not found' });
    const activeAssign = ord.visit_id
      ? await queryOne<{ id: number }>(
          "SELECT id FROM doctor_assignments WHERE visit_id = ? AND doctor_id = ? AND status = 'active' LIMIT 1",
          [ord.visit_id, req.user!.id]
        ).catch(() => null)
      : null;
    if (Number(ord.doctor_id) !== req.user!.id && !activeAssign) {
      const access = await assertPatientAccess(req.user!, ord.patient_id);
      if (!access.allowed) {
        return res.status(403).json({ error: 'Access denied: imaging order belongs to another clinician.' });
      }
    }
  }
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

function validateDataUrlSignature(mimeType: string, dataUrl: string): boolean {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/s);
  if (!match) return false;
  const headerMime = match[1].toLowerCase();
  if (headerMime !== mimeType) return false;
  let buf: Buffer;
  try {
    buf = Buffer.from(match[2].slice(0, 64), 'base64');
  } catch {
    return false;
  }
  if (buf.length < 4) return false;
  if (mimeType === 'image/png') return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  if (mimeType === 'image/jpeg') return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (mimeType === 'image/gif') return buf.slice(0, 3).toString('ascii') === 'GIF';
  if (mimeType === 'image/webp') return buf.slice(0, 4).toString('ascii') === 'RIFF';
  if (mimeType === 'application/pdf') return buf.slice(0, 4).toString('ascii') === '%PDF';
  return false;
}

router.post('/imaging/orders/:id/attachments', requireAuth, requirePermission('imaging.exam.perform', 'imaging.report.finalise'), async (req: AuthRequest, res: Response) => {
  const orderId = Number(req.params.id);
  const { file_name, mime_type, data_url, caption } = req.body || {};
  if (!file_name || !mime_type || !data_url) {
    return res.status(400).json({ error: 'file_name, mime_type, and data_url are required.' });
  }
  const normMime = String(mime_type).trim().toLowerCase();
  const allowedMimes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf']);
  if (!allowedMimes.has(normMime) || !validateDataUrlSignature(normMime, String(data_url))) {
    return res.status(400).json({ error: 'Unsupported or corrupted file payload. Valid PNG, JPEG, WEBP, GIF, or PDF base64 required.' });
  }
  if (String(data_url).length > 4_200_000) {
    return res.status(400).json({ error: 'File exceeds maximum allowed 3 MB attachment limit.' });
  }
  const order = await queryOne<{ id: number; patient_id: number; status: string }>(
    'SELECT id, patient_id, status FROM imaging_orders WHERE id = ?',
    [orderId]
  );
  if (!order) return res.status(404).json({ error: 'Imaging order not found' });
  if (order.status === 'cancelled' || order.status === 'reported_final') {
    return res.status(409).json({ error: `Cannot attach files to an imaging order in '${order.status}' state.` });
  }

  const inserted = await execute(
    'INSERT INTO imaging_attachments (imaging_order_id, file_name, mime_type, data_url, caption, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)',
    [orderId, String(file_name).trim(), normMime, String(data_url), caption || null, req.user!.id]
  );
  await writeAuditLog({
    user: req.user,
    action: 'imaging.attachment.upload',
    entityType: 'imaging_order',
    entityId: orderId,
    patientId: order.patient_id,
    after: { attachmentId: inserted.insertId, file_name, mime_type: normMime },
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
  const { action, pregnancy_checked, exam_notes, findings, impression, addendum, repeat_reason, bypass_payment_gate, bypass_reason } = req.body || {};

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
        await recordPaymentGateBypass({
          visitId: order.visit_id,
          patientId: order.patient_id,
          entityType: 'imaging_order',
          entityId: id,
          user: req.user!,
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
    const isRepeat = order.status === 'performed';
    if (!['ordered', 'scheduled', 'performed'].includes(order.status)) {
      return res.status(409).json({ error: `Cannot perform exam from current status '${order.status}'.` });
    }
    if (isRepeat && !String(repeat_reason || '').trim()) {
      return res.status(400).json({ error: 'A repeat scan reason is required when repeating a performed scan.' });
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
      "UPDATE imaging_orders SET status = 'performed', pregnancy_checked = ?, exam_notes = ?, repeat_reason = COALESCE(?, repeat_reason), performed_by = ? WHERE id = ?",
      [pregnancy_checked ? 1 : 0, exam_notes || null, isRepeat ? String(repeat_reason).trim() : null, req.user!.id, id]
    );
    await writeAuditLog({
      user: req.user,
      action: 'imaging.exam.perform',
      entityType: 'imaging_order',
      entityId: id,
      patientId: order.patient_id,
      after: { pregnancy_checked: Boolean(pregnancy_checked), exam_notes, isRepeat },
      reason: isRepeat ? String(repeat_reason).trim() : null,
      req,
    });
    broadcastClinicEvent('imaging:updated', { visitId: order.visit_id, orderId: id });
    return res.json({ ok: true });
  }

  if (action === 'draft_report') {
    if (!hasPermission(req.user!, 'imaging.report.finalise')) {
      return res.status(403).json({ error: 'Missing imaging.report.finalise permission' });
    }
    if (!['performed', 'reported_draft'].includes(order.status)) {
      return res.status(409).json({ error: 'Exam scan must be performed before saving a draft report.' });
    }
    await execute(
      "UPDATE imaging_orders SET status = 'reported_draft', findings = ?, impression = ?, reported_by = ? WHERE id = ?",
      [findings?.trim() || null, impression?.trim() || null, req.user!.id, id]
    );
    await writeAuditLog({
      user: req.user,
      action: 'imaging.report.draft',
      entityType: 'imaging_order',
      entityId: id,
      patientId: order.patient_id,
      req,
    });
    broadcastClinicEvent('imaging:updated', { visitId: order.visit_id, orderId: id });
    return res.json({ ok: true });
  }

  if (action === 'finalise') {
    if (!hasPermission(req.user!, 'imaging.report.finalise')) {
      return res.status(403).json({ error: 'Missing imaging.report.finalise permission' });
    }
    if (!['performed', 'reported_draft'].includes(order.status)) {
      return res.status(409).json({ error: 'Exam scan must be performed before finalising the radiology report.' });
    }
    if (!findings?.trim() || !impression?.trim()) {
      return res.status(400).json({ error: 'Findings and impression are required to finalise report.' });
    }
    await execute(
      "UPDATE imaging_orders SET status = 'reported_final', findings = ?, impression = ?, reported_by = ?, finalised_at = ? WHERE id = ?",
      [findings.trim(), impression.trim(), req.user!.id, nowSql(), id]
    );

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

    const imgVisit = await queryOne<{ doctor_id: number | null }>('SELECT doctor_id FROM visits WHERE id = ?', [order.visit_id]);
    await createNotification({
      targetRole: 'DOC',
      targetUserId: imgVisit?.doctor_id ?? null,
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

router.get('/lab/orders/:id/report', requireAuth, requirePermission('lab.order.read', 'visit.read'), async (req: AuthRequest, res: Response) => {
  const id = Number(req.params.id);
  const report = await queryOne<Record<string, unknown>>(
    `SELECT lo.*, lt.code AS test_code, lt.name AS test_name, lt.sample_type, lt.unit, lt.reference_range,
            p.mrn, p.first_name, p.last_name, p.sex, p.date_of_birth, p.phone,
            v.visit_number, v.doctor_id, u_ord.full_name AS ordered_by_name,
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
  if (isDoctorOnly(req.user!) && Number(report.doctor_id) !== req.user!.id) {
    const activeAssign = report.visit_id
      ? await queryOne<{ id: number }>(
          "SELECT id FROM doctor_assignments WHERE visit_id = ? AND doctor_id = ? AND status = 'active' LIMIT 1",
          [report.visit_id, req.user!.id]
        ).catch(() => null)
      : null;
    if (!activeAssign) {
      const access = await assertPatientAccess(req.user!, Number(report.patient_id));
      if (!access.allowed) {
        return res.status(403).json({ error: 'Access denied: lab report belongs to another clinician.' });
      }
    }
  }
  res.json({ report });
});

router.get('/imaging/orders/:id/report', requireAuth, requirePermission('imaging.order.read', 'visit.read'), async (req: AuthRequest, res: Response) => {
  const id = Number(req.params.id);
  const report = await queryOne<Record<string, unknown>>(
    `SELECT io.*, ic.code AS exam_code, ic.name AS exam_name, ic.modality, ic.body_region,
            p.mrn, p.first_name, p.last_name, p.sex, p.date_of_birth,
            v.visit_number, v.doctor_id, u_ord.full_name AS ordered_by_name,
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
  if (isDoctorOnly(req.user!) && Number(report.doctor_id) !== req.user!.id) {
    const activeAssign = report.visit_id
      ? await queryOne<{ id: number }>(
          "SELECT id FROM doctor_assignments WHERE visit_id = ? AND doctor_id = ? AND status = 'active' LIMIT 1",
          [report.visit_id, req.user!.id]
        ).catch(() => null)
      : null;
    if (!activeAssign) {
      const access = await assertPatientAccess(req.user!, Number(report.patient_id));
      if (!access.allowed) {
        return res.status(403).json({ error: 'Access denied: imaging report belongs to another clinician.' });
      }
    }
  }
  res.json({ report });
});

// ---------------------------------------------------------------------------
// PHARMACY DISPENSING (Batched Query + Multi-Batch FEFO + COGS + Partial)
// ---------------------------------------------------------------------------
router.get('/pharmacy/prescriptions', requireAuth, requirePermission('pharmacy.prescription.read'), async (req: AuthRequest, res: Response) => {
  const doctorScoped = isDoctorOnly(req.user!);
  const prescriptions = await query<Record<string, unknown>>(
    `SELECT pr.*, p.mrn, p.first_name, p.last_name, p.allergies, p.patient_type,
            u.full_name AS doctor_name, i.invoice_number, i.status AS invoice_status,
            v.visit_number, v.workflow_stage, v.status AS visit_status, v.doctor_id AS visit_doctor_id
     FROM prescriptions pr
     INNER JOIN patients p ON p.id = pr.patient_id
     INNER JOIN users u ON u.id = pr.doctor_id
     LEFT JOIN visits v ON v.id = pr.visit_id
     LEFT JOIN invoices i ON i.id = pr.invoice_id
     ${doctorScoped ? 'WHERE (v.doctor_id = ? OR pr.doctor_id = ?)' : ''}
     ORDER BY pr.id DESC LIMIT 60`,
    doctorScoped ? [req.user!.id, req.user!.id] : []
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

    const today = await getClinicToday();
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
  const settings = await getClinicSettings();
  const today = await getClinicToday();

  const result = await withTransaction(async () => {
    const rx = await queryOne<{ id: number; visit_id: number; patient_id: number; invoice_id: number | null; status: string }>(
      'SELECT * FROM prescriptions WHERE id = ?',
      [id]
    );
    if (!rx) return { ok: false as const, error: 'Prescription not found', httpStatus: 404 };
    if (rx.status !== 'awaiting_stock_check') {
      return { ok: false as const, error: `Prescription cannot be billed in '${rx.status}' status.`, httpStatus: 409 };
    }
    const visit = rx.visit_id
      ? await queryOne<{ status: string }>('SELECT status FROM visits WHERE id = ?', [rx.visit_id])
      : null;
    if (visit?.status === 'closed') {
      return { ok: false as const, error: 'Cannot generate pharmacy bill for a closed visit.', httpStatus: 409 };
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
    const payerType = patient?.patient_type || 'self-pay';
    const invStatus = payerType === 'insurance' || payerType === 'credit' ? 'credit_billed' : payerType === 'exempt' ? 'paid' : 'unpaid';

    const invRes = await execute(
      `INSERT INTO invoices (invoice_number, patient_id, visit_id, payer_type, payer_name, subtotal, discount_amount, total_amount, paid_amount, status, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
      [
        invNum,
        rx.patient_id,
        rx.visit_id,
        payerType,
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

    if (subtotal > 0 && payerType !== 'exempt') {
      await postInvoiceAccrualJE({
        invoiceId: invRes.insertId,
        invoiceNumber: invNum,
        payerType,
        totalAmount: subtotal,
        postedBy: req.user!.id,
      });
    }

    const rxStatus = invStatus === 'paid' || invStatus === 'credit_billed' ? 'paid_ready_to_dispense' : 'pending_payment';
    await execute('UPDATE prescriptions SET invoice_id = ?, status = ? WHERE id = ?', [invRes.insertId, rxStatus, id]);

    await createNotification({
      targetRole: rxStatus === 'pending_payment' ? 'CSH' : 'PHA',
      title: rxStatus === 'pending_payment' ? 'Pharmacy Bill Ready at Cashier' : 'Paid - Ready to Dispense',
      message:
        rxStatus === 'pending_payment'
          ? `Pharmacy invoice ${invNum} (${settings.currencySymbol}${subtotal.toFixed(2)}) awaiting payment.`
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
  const today = await getClinicToday();

  const result = await withTransaction(async () => {
    const rx = await queryOne<{ id: number; visit_id: number; patient_id: number; invoice_id: number | null; status: string }>(
      'SELECT * FROM prescriptions WHERE id = ?',
      [id]
    );
    if (!rx) return { ok: false as const, error: 'Prescription not found', httpStatus: 404 };
    if (rx.status === 'cancelled') {
      return { ok: false as const, error: 'Cancelled prescription cannot be dispensed.', httpStatus: 409 };
    }
    if (rx.status === 'dispensed') return { ok: false as const, error: 'Prescription already fully dispensed.', httpStatus: 409 };
    if (rx.status === 'awaiting_stock_check') {
      return {
        ok: false as const,
        error: 'Stock Check Required: Confirm available quantities and generate the Pharmacy Bill before dispensing.',
        httpStatus: 409,
      };
    }
    if (!['pending_payment', 'paid_ready_to_dispense', 'partially_dispensed', 'pending'].includes(rx.status)) {
      return { ok: false as const, error: `Prescription cannot be dispensed in '${rx.status}' status.`, httpStatus: 409 };
    }

    const visit = await queryOne<{ triage_priority: string; status: string }>('SELECT triage_priority, status FROM visits WHERE id = ?', [
      rx.visit_id,
    ]);

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
          await recordPaymentGateBypass({
            visitId: rx.visit_id,
            patientId: rx.patient_id,
            entityType: 'prescription',
            entityId: id,
            user: req.user!,
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

    const batchAllocations: Array<{ medicine: string; qty: number; batches: Array<{ batch: string; expiry: string; taken: number }> }> = [];
    let totalCogs = 0;

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
        const activeBatches = await query<{ id: number; batch_number: string; expiry_date: string; qty_on_hand: number; unit_cost: number }>(
          `SELECT id, batch_number, expiry_date, qty_on_hand, unit_cost
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
          const upd = await execute(
            "UPDATE stock_batches SET qty_on_hand = qty_on_hand - ?, status = CASE WHEN qty_on_hand - ? <= 0 THEN 'depleted' ELSE 'active' END WHERE id = ? AND qty_on_hand >= ?",
            [take, take, b.id, take]
          );
          if (upd.affectedRows === 0) {
            return { ok: false as const, error: `Concurrent stock update on batch ${b.batch_number}; retry.`, httpStatus: 409 };
          }
          const lineCost = Number((take * Number(b.unit_cost || 0)).toFixed(2));
          totalCogs = Number((totalCogs + lineCost).toFixed(2));
          await execute(
            `INSERT INTO stock_movements (item_id, batch_id, location, movement_type, quantity_change, unit_cost, total_cost, reference_type, reference_id, created_by)
             VALUES (?, ?, 'dispensary', 'dispense', ?, ?, ?, 'prescription', ?, ?)`,
            [item.store_item_id, b.id, -take, Number(b.unit_cost || 0), lineCost, id, req.user!.id]
          );
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

    if (totalCogs > 0) {
      await postJournalEntry({
        sourceType: 'cogs',
        sourceId: id,
        description: `Pharmacy Dispense COGS Rx #${id}`,
        postedBy: req.user!.id,
        lines: [
          { accountCode: '5010', debit: totalCogs, memo: `Rx #${id} COGS` },
          { accountCode: '1200', credit: totalCogs, memo: 'Dispensary inventory consumed' },
        ],
      });
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

    await execute(
      'UPDATE prescriptions SET status = ?, dispensed_at = ?, dispensed_by = ?, allergy_override_reason = COALESCE(?, allergy_override_reason) WHERE id = ?',
      [nextStatus, nowSql(), req.user!.id, overrideAllergyReason?.trim() || null, id]
    );

    let visitCompleted = false;
    if (complete_visit && nextStatus === 'dispensed' && rx.visit_id && visit?.status !== 'closed') {
      const closed = await closeVisit({ visitId: rx.visit_id, user: req.user!, req, forcePartialClose: false });
      visitCompleted = closed.ok;
    }

    await writeAuditLog({
      user: req.user,
      action: allComplete ? 'pharmacy.dispense' : 'pharmacy.dispense.partial',
      entityType: 'prescription',
      entityId: id,
      patientId: rx.patient_id,
      after: { status: nextStatus, visitCompleted, totalCogs, fefoAllocations: batchAllocations },
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
  const today = await getClinicToday();
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

  const expiryAlerts = batches
    .filter((b) => b.status === 'active' && Number(b.qty_on_hand) > 0 && String(b.expiry_date) <= in90)
    .map((b) => ({
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
  const todayStr = await getClinicToday();

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
    const batchRes = await execute(
      "INSERT INTO stock_batches (item_id, location, batch_number, expiry_date, qty_on_hand, unit_cost, status) VALUES (?, 'main_store', ?, ?, ?, ?, 'active')",
      [item.id, batch_number.trim(), expiry_date, qty, cost]
    );

    let jeId: number | null = null;
    if (totalCost > 0) {
      const billNumber = await nextSequence('AP');
      const dueStr = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
      await execute(
        `INSERT INTO supplier_bills (bill_number, grn_id, supplier_name, invoice_ref, bill_date, due_date, total_amount, paid_amount, status, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'open', ?)`,
        [billNumber, grnRes.insertId, supplier_name.trim(), invoice_ref || null, todayStr, dueStr, totalCost, `Auto-posted from ${grnNumber}`]
      );
      const je = await postJournalEntry({
        sourceType: 'grn',
        sourceId: grnRes.insertId,
        description: `Inventory receipt ${grnNumber} (${supplier_name.trim()})`,
        postedBy: req.user!.id,
        lines: [
          { accountCode: '1200', debit: totalCost, memo: `${item.code} x ${qty}` },
          { accountCode: '2100', credit: totalCost, memo: `${billNumber} payable to ${supplier_name.trim()}` },
        ],
      });
      jeId = je.entryId;
    }

    await execute(
      `INSERT INTO stock_movements (item_id, batch_id, location, movement_type, quantity_change, unit_cost, total_cost, reference_type, reference_id, journal_entry_id, created_by)
       VALUES (?, ?, 'main_store', 'grn_receive', ?, ?, ?, 'goods_receipt', ?, ?, ?)`,
      [item.id, batchRes.insertId, qty, cost, totalCost, grnRes.insertId, jeId, req.user!.id]
    );

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
  const today = await getClinicToday();

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
        const upd = await execute(
          "UPDATE stock_batches SET qty_on_hand = qty_on_hand - ?, status = CASE WHEN qty_on_hand - ? <= 0 THEN 'depleted' ELSE 'active' END WHERE id = ? AND qty_on_hand >= ?",
          [take, take, b.id, take]
        );
        if (upd.affectedRows === 0) {
          return { ok: false as const, error: `Concurrent update on batch ${b.batch_number}; retry.`, httpStatus: 409 };
        }
        const destBatchRes = await execute(
          "INSERT INTO stock_batches (item_id, location, batch_number, expiry_date, qty_on_hand, unit_cost, status) VALUES (?, ?, ?, ?, ?, ?, 'active')",
          [ri.item_id, reqRow.to_location, b.batch_number, b.expiry_date, take, b.unit_cost]
        );
        const moveCost = Number((take * Number(b.unit_cost || 0)).toFixed(2));
        await execute(
          `INSERT INTO stock_movements (item_id, batch_id, location, movement_type, quantity_change, unit_cost, total_cost, reference_type, reference_id, created_by)
           VALUES (?, ?, 'main_store', 'transfer_out', ?, ?, ?, 'stock_requisition', ?, ?)`,
          [ri.item_id, b.id, -take, Number(b.unit_cost || 0), moveCost, reqId, req.user!.id]
        );
        await execute(
          `INSERT INTO stock_movements (item_id, batch_id, location, movement_type, quantity_change, unit_cost, total_cost, reference_type, reference_id, created_by)
           VALUES (?, ?, ?, 'transfer_in', ?, ?, ?, 'stock_requisition', ?, ?)`,
          [ri.item_id, destBatchRes.insertId, reqRow.to_location, take, Number(b.unit_cost || 0), moveCost, reqId, req.user!.id]
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

    await execute("UPDATE stock_requisitions SET status = 'issued', issued_by = ?, issued_at = ? WHERE id = ?", [
      req.user!.id,
      nowSql(),
      reqId,
    ]);

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
    const batch = await queryOne<{
      id: number;
      item_id: number;
      batch_number: string;
      location: string;
      qty_on_hand: number;
      unit_cost: number;
      status: string;
    }>('SELECT * FROM stock_batches WHERE id = ?', [batchId]);
    if (!batch) return { ok: false as const, error: 'Stock batch not found', httpStatus: 404 };
    if (batch.status === 'blocked_expired') {
      return { ok: false as const, error: 'Stock batch is already blocked/quarantined.', httpStatus: 409 };
    }

    await execute("UPDATE stock_batches SET status = 'blocked_expired', block_reason = ? WHERE id = ?", [
      reason.trim(),
      batchId,
    ]);

    const item = await queryOne<{ medicine_id: number | null }>('SELECT medicine_id FROM store_items WHERE id = ?', [batch.item_id]);
    if (item?.medicine_id && batch.location === 'dispensary') {
      await syncMedicineFromBatches(item.medicine_id);
    }

    const writeOffVal = Number((Number(batch.qty_on_hand) * Number(batch.unit_cost || 0)).toFixed(2));
    let jeId: number | null = null;
    if (batch.status === 'active' && Number(batch.qty_on_hand) > 0 && writeOffVal > 0) {
      const je = await postJournalEntry({
        sourceType: 'stock_writeoff',
        sourceId: batchId,
        description: `Expired/damaged batch quarantine write-off (${batch.batch_number})`,
        postedBy: req.user!.id,
        lines: [
          { accountCode: '5020', debit: writeOffVal, memo: `Quarantine ${batch.batch_number}: ${reason.trim()}` },
          { accountCode: '1200', credit: writeOffVal, memo: `${batch.qty_on_hand} units blocked` },
        ],
      });
      jeId = je.entryId;
    }

    if (Number(batch.qty_on_hand) > 0) {
      await execute(
        `INSERT INTO stock_movements (item_id, batch_id, location, movement_type, quantity_change, unit_cost, total_cost, reference_type, reference_id, journal_entry_id, created_by)
         VALUES (?, ?, ?, 'write_off', ?, ?, ?, 'stock_batch', ?, ?, ?)`,
        [batch.item_id, batchId, batch.location, -Number(batch.qty_on_hand), Number(batch.unit_cost || 0), writeOffVal, batchId, jeId, req.user!.id]
      );
    }

    await writeAuditLog({
      user: req.user,
      action: 'store.batch.block',
      entityType: 'stock_batch',
      entityId: batchId,
      before: { status: batch.status, qty_on_hand: batch.qty_on_hand },
      after: { status: 'blocked_expired', batch_number: batch.batch_number, writeOffVal },
      reason: reason.trim(),
      req,
    });
    return { ok: true as const, writeOffVal };
  });

  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error });
  res.json(result);
});

// ---------------------------------------------------------------------------
// INPATIENT (IPD) WARDS, BED BOARD, ADMISSIONS, MAR, BED BILLING & DEPOSITS
// ---------------------------------------------------------------------------
router.get('/ipd/overview', requireAuth, requirePermission('ipd.admission.read'), async (req: AuthRequest, res: Response) => {
  const doctorScoped = isDoctorOnly(req.user!);
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
       ${doctorScoped ? 'WHERE a.admitting_doctor_id = ?' : ''}
       ORDER BY a.id DESC LIMIT 30`,
      doctorScoped ? [req.user!.id] : []
    ),
    query(
      `SELECT ma.*, p.mrn, p.first_name, p.last_name, a.admission_number, b.bed_number
       FROM medication_administrations ma
       INNER JOIN admissions a ON a.id = ma.admission_id
       INNER JOIN patients p ON p.id = ma.patient_id
       LEFT JOIN beds b ON b.id = a.bed_id
       WHERE a.status IN ('admitted','discharge_ordered')${doctorScoped ? ' AND a.admitting_doctor_id = ?' : ''}
       ORDER BY ma.id DESC LIMIT 40`,
      doctorScoped ? [req.user!.id] : []
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

  res.json({ wards, beds, admissions, mar, isDoctorScoped: doctorScoped });
});

router.get('/ipd/admissions/:id/statement', requireAuth, requirePermission('ipd.admission.read'), async (req: AuthRequest, res: Response) => {
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
  if (isDoctorOnly(req.user!) && Number(admission.admitting_doctor_id) !== req.user!.id) {
    const access = await assertPatientAccess(req.user!, Number(admission.patient_id));
    if (!access.allowed) {
      return res.status(403).json({
        error: access.reason || 'Access denied: inpatient admission is assigned to another clinician.',
        breakGlassRequired: true,
        patientId: Number(admission.patient_id),
      });
    }
  }

  // Auto-flag overdue scheduled MAR doses created on an earlier date as missed
  const today = await getClinicToday();
  await execute(
    "UPDATE medication_administrations SET status = 'missed' WHERE admission_id = ? AND status = 'due' AND substr(created_at, 1, 10) < ?",
    [admId, today]
  ).catch(() => {});

  const [invoices, deposits, marHistory, medicationOrders, wardRounds, nursingNotes, vitals] = await Promise.all([
    query<Record<string, unknown>>('SELECT * FROM invoices WHERE patient_id = ? ORDER BY id DESC LIMIT 20', [admission.patient_id]),
    query<Record<string, unknown>>('SELECT * FROM patient_deposits WHERE patient_id = ? ORDER BY id DESC', [admission.patient_id]),
    query('SELECT * FROM medication_administrations WHERE admission_id = ? ORDER BY id ASC', [admId]),
    query(
      `SELECT mo.*, u.full_name AS ordered_by_name
       FROM medication_orders mo
       LEFT JOIN users u ON u.id = mo.ordered_by
       WHERE mo.admission_id = ?
       ORDER BY mo.id DESC`,
      [admId]
    ),
    query(
      `SELECT wr.*, u.full_name AS doctor_name
       FROM ward_rounds wr
       LEFT JOIN users u ON u.id = wr.doctor_id
       WHERE wr.admission_id = ?
       ORDER BY wr.id DESC`,
      [admId]
    ),
    query(
      `SELECT nn.*, u.full_name AS nurse_name
       FROM nursing_notes nn
       LEFT JOIN users u ON u.id = nn.nurse_id
       WHERE nn.admission_id = ?
       ORDER BY nn.id DESC`,
      [admId]
    ),
    query(
      `SELECT v.*, u.full_name AS recorded_by_name
       FROM vitals v
       LEFT JOIN users u ON u.id = v.recorded_by
       WHERE v.admission_id = ? OR (v.visit_id IS NOT NULL AND v.visit_id = ?)
       ORDER BY v.id DESC LIMIT 20`,
      [admId, admission.visit_id || -1]
    ),
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

  res.json({ admission, invoices, deposits, marHistory, medicationOrders, wardRounds, nursingNotes, vitals });
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
      status: string;
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
    if (adm.status === 'discharged') {
      return { ok: false as const, error: 'Cannot accrue bed charges on a discharged admission.', httpStatus: 409 };
    }

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
      await postInvoiceAccrualJE({
        invoiceId: invRes.insertId,
        invoiceNumber: invNum,
        payerType: adm.patient_type,
        totalAmount: total,
        postedBy: req.user!.id,
        sourceType: 'ipd_bed',
        description: `Inpatient bed charge ${adm.admission_number} (${daysToBill}d)`,
      });
      if (depositApplied > 0) {
        const receivableAcct = adm.patient_type === 'insurance' || adm.patient_type === 'credit' ? '1100' : '1150';
        await postJournalEntry({
          sourceType: 'deposit_apply',
          sourceId: invRes.insertId,
          description: `Deposit auto-applied to ${invNum}`,
          postedBy: req.user!.id,
          lines: [
            { accountCode: '2010', debit: depositApplied, memo: invNum },
            { accountCode: receivableAcct, credit: depositApplied, memo: 'Receivable offset' },
          ],
        });
      }
    }

    await execute('UPDATE admissions SET bed_days_billed = bed_days_billed + ?, last_bed_billed_at = ? WHERE id = ?', [
      daysToBill,
      nowSql(),
      admId,
    ]);

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
    const orderRes = await execute(
      "INSERT INTO medication_orders (admission_id, patient_id, medicine_name, dose, route, frequency, prn, ordered_by) VALUES (?, ?, ?, ?, 'Oral', 'OD', 0, ?)",
      [resAdm.insertId, Number(patient_id), initial_medication.trim(), initial_dose || 'Per order', req.user!.id]
    );
    await execute(
      "INSERT INTO medication_administrations (admission_id, patient_id, medication_order_id, medicine_name, dose, scheduled_time, status) VALUES (?, ?, ?, ?, ?, '08:00', 'due')",
      [resAdm.insertId, Number(patient_id), orderRes.insertId, initial_medication.trim(), initial_dose || 'Per order']
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

router.post('/ipd/admissions/:id/medication-orders', requireAuth, requirePermission('ipd.admission.create', 'prescription.create'), async (req: AuthRequest, res: Response) => {
  const admId = Number(req.params.id);
  const { medicine_id, medicine_name, dose, route = 'Oral', frequency = 'BID', prn = false } = req.body || {};
  if (!medicine_name?.trim() || !dose?.trim()) {
    return res.status(400).json({ error: 'Medication name and dose are required.' });
  }
  const adm = await queryOne<{ id: number; patient_id: number; admitting_doctor_id: number; status: string }>(
    'SELECT id, patient_id, admitting_doctor_id, status FROM admissions WHERE id = ?',
    [admId]
  );
  if (!adm || adm.status === 'discharged') return res.status(404).json({ error: 'Active admission not found.' });
  if (isDoctorOnly(req.user!) && Number(adm.admitting_doctor_id) !== req.user!.id) {
    const access = await assertPatientAccess(req.user!, adm.patient_id);
    if (!access.allowed) {
      return res.status(403).json({ error: 'Access denied: inpatient admission belongs to another clinician.' });
    }
  }

  const scheduleByFreq: Record<string, string[]> = {
    OD: ['08:00'],
    BID: ['08:00', '20:00'],
    TID: ['08:00', '14:00', '20:00'],
    QID: ['06:00', '12:00', '18:00', '23:00'],
    STAT: [new Date().toISOString().slice(11, 16)],
    PRN: ['PRN'],
  };
  const slots = prn ? ['PRN'] : scheduleByFreq[String(frequency).toUpperCase()] || ['08:00'];

  const orderId = await withTransaction(async () => {
    const inserted = await execute(
      `INSERT INTO medication_orders (admission_id, patient_id, medicine_id, medicine_name, dose, route, frequency, prn, ordered_by, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
      [admId, adm.patient_id, medicine_id ? Number(medicine_id) : null, medicine_name.trim(), dose.trim(), route, frequency, prn ? 1 : 0, req.user!.id]
    );
    for (const slot of slots) {
      await execute(
        "INSERT INTO medication_administrations (admission_id, patient_id, medication_order_id, medicine_name, dose, scheduled_time, status) VALUES (?, ?, ?, ?, ?, ?, 'due')",
        [admId, adm.patient_id, inserted.insertId, medicine_name.trim(), `${dose.trim()} (${route})`, slot]
      );
    }
    await writeAuditLog({
      user: req.user,
      action: 'ipd.medication_order.create',
      entityType: 'medication_order',
      entityId: inserted.insertId,
      patientId: adm.patient_id,
      after: { medicine_name: medicine_name.trim(), dose: dose.trim(), frequency, slots },
      req,
    });
    return inserted.insertId;
  });

  res.status(201).json({ id: orderId, scheduledSlots: slots });
});

router.post('/ipd/admissions/:id/rounds', requireAuth, requirePermission('ipd.admission.create', 'visit.update'), async (req: AuthRequest, res: Response) => {
  const admId = Number(req.params.id);
  const { subjective, objective, assessment, plan } = req.body || {};
  if (!assessment?.trim() || !plan?.trim()) {
    return res.status(400).json({ error: 'Ward round assessment and plan are required.' });
  }
  const adm = await queryOne<{ id: number; patient_id: number; admitting_doctor_id: number; status: string }>(
    'SELECT id, patient_id, admitting_doctor_id, status FROM admissions WHERE id = ?',
    [admId]
  );
  if (!adm) return res.status(404).json({ error: 'Admission not found.' });
  if (adm.status === 'discharged') return res.status(409).json({ error: 'Cannot record ward rounds on a discharged admission.' });
  if (isDoctorOnly(req.user!) && Number(adm.admitting_doctor_id) !== req.user!.id) {
    const access = await assertPatientAccess(req.user!, adm.patient_id);
    if (!access.allowed) {
      return res.status(403).json({ error: 'Access denied: inpatient admission belongs to another clinician.' });
    }
  }

  const inserted = await execute(
    `INSERT INTO ward_rounds (admission_id, patient_id, doctor_id, subjective, objective, assessment, plan)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [admId, adm.patient_id, req.user!.id, subjective?.trim() || null, objective?.trim() || null, assessment.trim(), plan.trim()]
  );
  await writeAuditLog({
    user: req.user,
    action: 'ipd.round.create',
    entityType: 'ward_round',
    entityId: inserted.insertId,
    patientId: adm.patient_id,
    req,
  });
  res.status(201).json({ id: inserted.insertId });
});

router.post('/ipd/admissions/:id/nursing-notes', requireAuth, requirePermission('ipd.mar.give', 'ipd.bed.assign', 'nursing.procedure.perform'), async (req: AuthRequest, res: Response) => {
  const admId = Number(req.params.id);
  const { note_type = 'Shift Note', note } = req.body || {};
  if (!note?.trim()) return res.status(400).json({ error: 'Nursing note content is required.' });
  const adm = await queryOne<{ id: number; patient_id: number; status: string }>(
    'SELECT id, patient_id, status FROM admissions WHERE id = ?',
    [admId]
  );
  if (!adm) return res.status(404).json({ error: 'Admission not found.' });
  if (adm.status === 'discharged') return res.status(409).json({ error: 'Cannot add nursing notes to a discharged admission.' });

  const inserted = await execute(
    'INSERT INTO nursing_notes (admission_id, patient_id, nurse_id, note_type, note) VALUES (?, ?, ?, ?, ?)',
    [admId, adm.patient_id, req.user!.id, String(note_type).trim(), note.trim()]
  );
  await writeAuditLog({
    user: req.user,
    action: 'ipd.nursing_note.create',
    entityType: 'nursing_note',
    entityId: inserted.insertId,
    patientId: adm.patient_id,
    req,
  });
  res.status(201).json({ id: inserted.insertId });
});

router.post('/ipd/admissions/:id/vitals', requireAuth, requirePermission('vitals.create', 'ipd.mar.give'), async (req: AuthRequest, res: Response) => {
  const admId = Number(req.params.id);
  const {
    bp_systolic,
    bp_diastolic,
    heart_rate,
    pulse,
    respiratory_rate,
    temperature_c,
    temperature,
    spo2,
    weight_kg,
    height_cm,
    notes,
  } = req.body || {};
  const adm = await queryOne<{ id: number; patient_id: number; visit_id: number | null; status: string }>(
    'SELECT id, patient_id, visit_id, status FROM admissions WHERE id = ?',
    [admId]
  );
  if (!adm) return res.status(404).json({ error: 'Admission not found.' });
  if (adm.status === 'discharged') return res.status(409).json({ error: 'Cannot record vitals on a discharged admission.' });

  const sys = bp_systolic !== undefined && bp_systolic !== '' ? Number(bp_systolic) : null;
  const dia = bp_diastolic !== undefined && bp_diastolic !== '' ? Number(bp_diastolic) : null;
  const rawHr = pulse ?? heart_rate;
  const hr = rawHr !== undefined && rawHr !== '' ? Number(rawHr) : null;
  const rawTemp = temperature ?? temperature_c;
  const temp = rawTemp !== undefined && rawTemp !== '' ? Number(rawTemp) : null;
  const o2 = spo2 !== undefined && spo2 !== '' ? Number(spo2) : null;
  if (sys !== null && (sys < 40 || sys > 300)) return res.status(400).json({ error: 'Systolic BP out of physiological range (40-300).' });
  if (dia !== null && (dia < 20 || dia > 200)) return res.status(400).json({ error: 'Diastolic BP out of physiological range (20-200).' });
  if (sys !== null && dia !== null && sys <= dia) return res.status(400).json({ error: 'Systolic BP must exceed Diastolic BP.' });
  if (temp !== null && (temp < 25 || temp > 45)) return res.status(400).json({ error: 'Temperature out of range (25-45 °C).' });
  if (o2 !== null && (o2 < 40 || o2 > 100)) return res.status(400).json({ error: 'SpO2 out of range (40-100%).' });
  if (hr !== null && (hr < 20 || hr > 260)) return res.status(400).json({ error: 'Heart rate out of range (20-260 bpm).' });

  const w = weight_kg !== undefined && weight_kg !== '' ? Number(weight_kg) : null;
  const h = height_cm !== undefined && height_cm !== '' ? Number(height_cm) : null;
  const bmi = w && h && h > 0 ? Number((w / ((h / 100) * (h / 100))).toFixed(1)) : null;
  const earlyWarning =
    (o2 !== null && o2 < 92) ||
    (temp !== null && temp >= 38.5) ||
    (sys !== null && (sys >= 160 || sys < 90)) ||
    (hr !== null && (hr > 110 || hr < 50))
      ? 1
      : 0;

  const inserted = await execute(
    `INSERT INTO vitals (visit_id, patient_id, admission_id, bp_systolic, bp_diastolic, pulse, respiratory_rate, temperature, spo2, weight_kg, height_cm, bmi, early_warning_flag, notes, recorded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      adm.visit_id,
      adm.patient_id,
      admId,
      sys,
      dia,
      hr,
      respiratory_rate !== undefined && respiratory_rate !== '' ? Number(respiratory_rate) : null,
      temp,
      o2,
      w,
      h,
      bmi,
      earlyWarning,
      notes || null,
      req.user!.id,
    ]
  );

  await writeAuditLog({
    user: req.user,
    action: 'ipd.vitals.create',
    entityType: 'vitals',
    entityId: inserted.insertId,
    patientId: adm.patient_id,
    req,
  });
  res.status(201).json({ id: inserted.insertId, bmi, earlyWarningFlag: Boolean(earlyWarning) });
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

  const row = await queryOne<{ id: number; patient_id: number; medicine_name: string; status: string; adm_status: string }>(
    `SELECT ma.id, ma.patient_id, ma.medicine_name, ma.status, a.status AS adm_status
     FROM medication_administrations ma
     INNER JOIN admissions a ON a.id = ma.admission_id
     WHERE ma.id = ?`,
    [marId]
  );
  if (!row) return res.status(404).json({ error: 'MAR entry not found' });
  if (row.adm_status === 'discharged') {
    return res.status(409).json({ error: 'Cannot administer MAR medications for a discharged admission.' });
  }
  if (row.status === 'given' || row.status === 'withheld') {
    return res.status(409).json({ error: `MAR entry is already marked '${row.status}'.` });
  }

  await execute(
    'UPDATE medication_administrations SET status = ?, reason_not_given = ?, administered_by_name = ?, administered_at = ? WHERE id = ?',
    [status, reason_not_given || null, req.user!.fullName, nowSql(), marId]
  );

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
  const adm = await queryOne<{ id: number; patient_id: number; admitting_doctor_id: number; admission_number: string; status: string }>(
    'SELECT id, patient_id, admitting_doctor_id, admission_number, status FROM admissions WHERE id = ?',
    [admId]
  );
  if (!adm) return res.status(404).json({ error: 'Admission not found' });
  if (isDoctorOnly(req.user!) && Number(adm.admitting_doctor_id) !== req.user!.id) {
    const access = await assertPatientAccess(req.user!, adm.patient_id);
    if (!access.allowed) {
      return res.status(403).json({ error: 'Access denied: inpatient admission belongs to another clinician.' });
    }
  }
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

router.post('/ipd/admissions/:id/clear', requireAuth, requirePermission('ipd.discharge.clear', 'ipd.discharge.override'), async (req: AuthRequest, res: Response) => {
  const admId = Number(req.params.id);
  const { force_clearance_reason } = req.body || {};

  const result = await withTransaction(async () => {
    const adm = await queryOne<{
      id: number;
      patient_id: number;
      bed_id: number | null;
      bed_days_billed: number;
      admitted_at: string;
      status: string;
      patient_type: string;
    }>(
      `SELECT a.id, a.patient_id, a.bed_id, a.bed_days_billed, a.admitted_at, a.status, p.patient_type
       FROM admissions a
       INNER JOIN patients p ON p.id = a.patient_id
       WHERE a.id = ?`,
      [admId]
    );
    if (!adm) return { ok: false as const, error: 'Admission not found', httpStatus: 404 };
    if (adm.status === 'discharged') {
      return { ok: false as const, error: 'Admission has already been cleared and discharged.', httpStatus: 409 };
    }

    const daysStayed = Math.max(1, Math.ceil((Date.now() - new Date(adm.admitted_at).getTime()) / 86400000));
    const unbilledDays = Math.max(0, daysStayed - Number(adm.bed_days_billed || 0));
    const unpaid = await queryOne<{ bal: number }>(
      "SELECT COALESCE(SUM(total_amount - paid_amount), 0) AS bal FROM invoices WHERE patient_id = ? AND status IN ('unpaid','partial')",
      [adm.patient_id]
    );
    const unpaidBal = Number(unpaid?.bal || 0);

    const hasFinancialGap = (adm.patient_type === 'self-pay' || adm.patient_type === 'credit') && (unbilledDays > 0 || unpaidBal > 0.01);
    if (hasFinancialGap) {
      const approvedOverride = await queryOne<{ id: number }>(
        "SELECT id FROM approval_requests WHERE request_type = 'discharge_override' AND entity_type = 'admission' AND entity_id = ? AND status = 'approved' ORDER BY id DESC LIMIT 1",
        [admId]
      );
      const canSelfOverride = hasPermission(req.user!, 'ipd.discharge.override') && Boolean(force_clearance_reason?.trim());
      if (!approvedOverride && !canSelfOverride) {
        if (unbilledDays > 0) {
          return {
            ok: false as const,
            error: `Unbilled inpatient stay: ${unbilledDays} day(s) of bed tariff not posted yet. Post Bed Charge or obtain Manager/Finance Discharge Override approval.`,
            httpStatus: 409,
          };
        }
        return {
          ok: false as const,
          error: `Outstanding balance of $${unpaidBal.toFixed(2)} remains unpaid. Collect payment, apply deposit, or obtain Discharge Override approval.`,
          httpStatus: 402,
        };
      }
    }

    await execute("UPDATE admissions SET discharge_cleared = 1, status = 'discharged', discharged_at = ? WHERE id = ?", [
      nowSql(),
      admId,
    ]);

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
// SECURE BILLING, SHIFTS, RECEIPTS (REPRINTS), BYPASSES & APPROVALS
// ---------------------------------------------------------------------------
router.get('/billing/shifts', requireAuth, requirePermission('billing.shift.manage', 'billing.shift.reconcile', 'finance.report.view'), async (req: AuthRequest, res: Response) => {
  const isCashierOnly =
    !hasPermission(req.user!, 'finance.report.view') &&
    !req.user!.roles.includes('ADM') &&
    !req.user!.roles.includes('MGR') &&
    !req.user!.roles.includes('ACC');
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

  await execute("UPDATE cashier_shifts SET counted_cash = ?, variance = ?, status = 'closed', closed_at = ?, notes = ? WHERE id = ?", [
    counted,
    variance,
    nowSql(),
    notes || null,
    shift.id,
  ]);

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
  for (const item of items) {
    const qty = Number(item?.quantity ?? 1);
    const price = Number(item?.unit_price ?? 0);
    if (!String(item?.description || '').trim() || !Number.isFinite(qty) || qty <= 0 || !Number.isFinite(price) || price < 0) {
      return res.status(400).json({ error: 'Every invoice line item requires a description, positive quantity, and non-negative unit_price.' });
    }
  }

  const result = await withTransaction(async () => {
    const patient = await queryOne<{ patient_type: string; payer_name: string | null }>(
      'SELECT patient_type, payer_name FROM patients WHERE id = ?',
      [patient_id]
    );
    if (!patient) return { ok: false as const, error: 'Patient not found', httpStatus: 404 };

    const subtotal = items.reduce((sum: number, item: { quantity?: number; unit_price: number }) => {
      return sum + Number(item.quantity ?? 1) * Number(item.unit_price ?? 0);
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
      const qty = Number(item.quantity ?? 1);
      const price = patient.patient_type === 'exempt' ? 0 : Number(item.unit_price ?? 0);
      await execute(
        'INSERT INTO invoice_items (invoice_id, service_code, description, category, quantity, unit_price, line_total) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [invRes.insertId, item.service_code || null, String(item.description).trim(), item.category || 'consultation', qty, price, Number((qty * price).toFixed(2))]
      );
    }

    if (finalTotal > 0 && patient.patient_type !== 'exempt') {
      await postInvoiceAccrualJE({
        invoiceId: invRes.insertId,
        invoiceNumber: invNum,
        payerType: patient.patient_type,
        totalAmount: finalTotal,
        postedBy: req.user!.id,
      });
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
  if (!['cash', 'card', 'mobile_money', 'bank_transfer'].includes(String(payment_method))) {
    return res.status(400).json({ error: 'Invalid payment method.' });
  }

  const result = await withTransaction(async () => {
    const openShift = await queryOne<{ id: number }>("SELECT id FROM cashier_shifts WHERE cashier_id = ? AND status = 'open'", [
      req.user!.id,
    ]);
    if (!openShift) {
      return { ok: false as const, error: 'You must open a Cashier Shift before collecting payments.', httpStatus: 409 };
    }

    const inv = await queryOne<{
      id: number;
      invoice_number: string;
      patient_id: number;
      payer_type: string;
      total_amount: number;
      paid_amount: number;
      status: string;
    }>('SELECT * FROM invoices WHERE id = ?', [invoice_id]);
    if (!inv) return { ok: false as const, error: 'Invoice not found', httpStatus: 404 };
    if (inv.status === 'voided' || inv.status === 'refunded') {
      return { ok: false as const, error: `Cannot pay a ${inv.status} invoice.`, httpStatus: 409 };
    }

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

    const cashOrBankAcct = payment_method === 'cash' ? '1010' : '1020';
    const hasAccrual = await hasInvoiceAccrualJE(inv.id);
    const creditLines = hasAccrual
      ? [
          {
            accountCode: inv.payer_type === 'insurance' || inv.payer_type === 'credit' ? '1100' : '1150',
            credit: payAmount,
            memo: inv.invoice_number,
          },
        ]
      : await buildPerLineRevenueLines(inv.id, payAmount, 'credit', inv.invoice_number);

    await postJournalEntry({
      sourceType: 'payment',
      sourceId: payRes.insertId,
      description: `Cashier payment ${receiptNumber} for ${inv.invoice_number}`,
      postedBy: req.user!.id,
      lines: [{ accountCode: cashOrBankAcct, debit: payAmount, memo: `${payment_method} receipt ${receiptNumber}` }, ...creditLines],
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

    const inv = await queryOne<{
      id: number;
      invoice_number: string;
      patient_id: number;
      payer_type: string;
      total_amount: number;
      paid_amount: number;
      status: string;
    }>('SELECT * FROM invoices WHERE id = ?', [Number(invoice_id)]);
    if (!inv || inv.patient_id !== dep.patient_id) {
      return { ok: false as const, error: 'Matching patient invoice not found.', httpStatus: 404 };
    }
    if (inv.status === 'paid' || inv.status === 'voided' || inv.status === 'refunded') {
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

    const hasAccrual = await hasInvoiceAccrualJE(inv.id);
    const creditLines = hasAccrual
      ? [
          {
            accountCode: inv.payer_type === 'insurance' || inv.payer_type === 'credit' ? '1100' : '1150',
            credit: applyAmt,
            memo: inv.invoice_number,
          },
        ]
      : await buildPerLineRevenueLines(inv.id, applyAmt, 'credit', inv.invoice_number);

    await postJournalEntry({
      sourceType: 'deposit_apply',
      sourceId: inv.id,
      description: `Apply deposit ${dep.deposit_number} to ${inv.invoice_number}`,
      postedBy: req.user!.id,
      lines: [{ accountCode: '2010', debit: applyAmt, memo: dep.deposit_number }, ...creditLines],
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

router.get('/billing/bypasses', requireAuth, requirePermission('billing.invoice.read', 'finance.report.view', 'audit.read'), async (_req, res) => {
  const bypasses = await query(
    `SELECT pgb.*, p.mrn, p.first_name, p.last_name, v.visit_number,
            u1.full_name AS set_by_name, u2.full_name AS resolved_by_name
     FROM payment_gate_bypasses pgb
     INNER JOIN patients p ON p.id = pgb.patient_id
     LEFT JOIN visits v ON v.id = pgb.visit_id
     LEFT JOIN users u1 ON u1.id = pgb.set_by
     LEFT JOIN users u2 ON u2.id = pgb.resolved_by
     ORDER BY CASE WHEN pgb.follow_up_status = 'pending_billing' THEN 0 ELSE 1 END, pgb.id DESC
     LIMIT 80`
  );
  res.json({ bypasses });
});

router.post('/billing/bypasses/:id/resolve', requireAuth, requirePermission('billing.invoice.create', 'billing.payment.create', 'finance.report.view'), async (req: AuthRequest, res: Response) => {
  const id = Number(req.params.id);
  const resolutionNote = String(req.body?.resolution_note || 'Settled / billed post-emergency').trim();
  const row = await queryOne<{ id: number; patient_id: number; follow_up_status: string }>(
    'SELECT id, patient_id, follow_up_status FROM payment_gate_bypasses WHERE id = ?',
    [id]
  );
  if (!row) return res.status(404).json({ error: 'Bypass record not found' });
  if (row.follow_up_status === 'resolved') return res.status(409).json({ error: 'Bypass already resolved.' });

  await execute(
    "UPDATE payment_gate_bypasses SET follow_up_status = 'resolved', resolved_by = ?, resolution_note = ?, resolved_at = ? WHERE id = ?",
    [req.user!.id, resolutionNote, nowSql(), id]
  );
  await writeAuditLog({
    user: req.user,
    action: 'payment.gate.bypass.resolved',
    entityType: 'payment_gate_bypass',
    entityId: id,
    patientId: row.patient_id,
    reason: resolutionNote,
    req,
  });
  res.json({ ok: true });
});

router.get('/billing/approvals', requireAuth, requirePermission('billing.approval.request', 'billing.approval.decide', 'finance.report.view'), async (_req, res) => {
  const approvals = await query(
    `SELECT ar.*, u1.full_name AS requested_by_name, u2.full_name AS decided_by_name,
            i.invoice_number, i.total_amount, a.admission_number,
            COALESCE(p.first_name, p2.first_name, p3.first_name) AS first_name,
            COALESCE(p.last_name, p2.last_name, p3.last_name) AS last_name,
            COALESCE(p.mrn, p2.mrn, p3.mrn) AS mrn
     FROM approval_requests ar
     INNER JOIN users u1 ON u1.id = ar.requested_by
     LEFT JOIN users u2 ON u2.id = ar.decided_by
     LEFT JOIN invoices i ON ar.entity_type = 'invoice' AND i.id = ar.entity_id
     LEFT JOIN patients p ON p.id = i.patient_id
     LEFT JOIN admissions a ON ar.entity_type = 'admission' AND a.id = ar.entity_id
     LEFT JOIN patients p2 ON p2.id = a.patient_id
     LEFT JOIN patients p3 ON ar.entity_type = 'patient' AND p3.id = ar.entity_id
     ORDER BY ar.id DESC LIMIT 50`
  );
  res.json({ approvals });
});

router.post('/billing/approvals', requireAuth, requirePermission('billing.approval.request'), async (req: AuthRequest, res: Response) => {
  const { request_type, entity_type, entity_id, requested_amount, reason } = req.body || {};
  const allowedTypes = ['discount', 'refund', 'void_invoice', 'discharge_override', 'payer_exempt'];
  if (!allowedTypes.includes(String(request_type)) || !entity_id || !reason?.trim()) {
    return res.status(400).json({ error: 'Valid request type, target entity ID, and formal reason are required.' });
  }
  const resolvedEntityType =
    entity_type || (request_type === 'discharge_override' ? 'admission' : request_type === 'payer_exempt' ? 'patient' : 'invoice');

  let parsedAmount: number | null = requested_amount != null && requested_amount !== '' ? Number(requested_amount) : null;
  if (['discount', 'refund'].includes(String(request_type))) {
    if (parsedAmount === null || !Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({ error: `${String(request_type)} requires a positive requested_amount.` });
    }
    parsedAmount = Number(parsedAmount.toFixed(2));
  }

  if (resolvedEntityType === 'invoice') {
    const inv = await queryOne<{ id: number; status: string; subtotal: number; discount_amount: number; paid_amount: number }>(
      'SELECT id, status, subtotal, discount_amount, paid_amount FROM invoices WHERE id = ?',
      [Number(entity_id)]
    );
    if (!inv) return res.status(404).json({ error: 'Target invoice not found.' });
    if (inv.status === 'voided' || inv.status === 'refunded') {
      return res.status(409).json({ error: `Cannot create approval request on a '${inv.status}' invoice.` });
    }
    if (request_type === 'discount' && parsedAmount! > Number(inv.subtotal) - Number(inv.discount_amount || 0) + 0.01) {
      return res.status(400).json({ error: 'Requested discount exceeds remaining invoice subtotal.' });
    }
    if (request_type === 'refund' && parsedAmount! > Number(inv.paid_amount) + 0.01) {
      return res.status(400).json({ error: 'Requested refund exceeds paid amount on invoice.' });
    }
    if (request_type === 'void_invoice' && Number(inv.paid_amount) > 0) {
      return res.status(409).json({ error: 'Paid invoices cannot be voided directly. Submit a Refund request instead.' });
    }
  }

  const inserted = await execute(
    `INSERT INTO approval_requests (request_type, entity_type, entity_id, requested_amount, reason, status, requested_by)
     VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
    [request_type, resolvedEntityType, Number(entity_id), parsedAmount, reason.trim(), req.user!.id]
  );

  await createNotification({
    targetRole: request_type === 'discharge_override' ? 'MGR' : 'ACC',
    title: `Approval Needed: ${String(request_type).replace(/_/g, ' ')}`,
    message: `${req.user!.fullName} requested ${String(request_type).replace(/_/g, ' ')} on ${resolvedEntityType} #${entity_id}.`,
    severity: 'warning',
    entityType: 'approval_request',
    entityId: inserted.insertId,
  });

  await writeAuditLog({
    user: req.user,
    action: 'billing.approval.request',
    entityType: 'approval_request',
    entityId: inserted.insertId,
    after: { request_type, entity_type: resolvedEntityType, entity_id, requested_amount: parsedAmount },
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
      entity_type: string;
      entity_id: number;
      requested_amount: number | null;
      reason: string;
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
      assertDifferentUser(req.user!.id, reqRow.requested_by, 'approval request');
    }

    await execute('UPDATE approval_requests SET status = ?, decided_by = ?, decision_note = ?, decided_at = ? WHERE id = ?', [
      decision,
      req.user!.id,
      decision_note || null,
      nowSql(),
      id,
    ]);

    if (decision === 'approved') {
      if (reqRow.entity_type === 'invoice') {
        const inv = await queryOne<{
          id: number;
          invoice_number: string;
          patient_id: number;
          payer_type: string;
          status: string;
          subtotal: number;
          discount_amount: number;
          total_amount: number;
          paid_amount: number;
        }>(
          'SELECT id, invoice_number, patient_id, payer_type, status, subtotal, discount_amount, total_amount, paid_amount FROM invoices WHERE id = ?',
          [reqRow.entity_id]
        );
        if (inv) {
          if (inv.status === 'voided' || inv.status === 'refunded') {
            return { ok: false as const, error: `Invoice is already ${inv.status}.`, httpStatus: 409 };
          }
          const hasAccrual = await hasInvoiceAccrualJE(inv.id);
          const receivableAcct = inv.payer_type === 'insurance' || inv.payer_type === 'credit' ? '1100' : '1150';

          if (reqRow.request_type === 'discount' && reqRow.requested_amount) {
            const reqDisc = Math.min(Number(inv.subtotal) - Number(inv.discount_amount || 0), Number(reqRow.requested_amount));
            const disc = Number((Number(inv.discount_amount || 0) + reqDisc).toFixed(2));
            const newTotal = Number((Number(inv.subtotal) - disc).toFixed(2));
            const unpaidStatus = inv.payer_type === 'insurance' || inv.payer_type === 'credit' ? 'credit_billed' : 'unpaid';
            const newStatus = Number(inv.paid_amount) >= newTotal ? 'paid' : Number(inv.paid_amount) > 0 ? 'partial' : unpaidStatus;
            await execute('UPDATE invoices SET discount_amount = ?, total_amount = ?, status = ? WHERE id = ?', [
              disc,
              newTotal,
              newStatus,
              inv.id,
            ]);
            if (reqDisc > 0 && hasAccrual) {
              const revDebits = await buildPerLineRevenueLines(inv.id, reqDisc, 'debit', `Discount ${inv.invoice_number}`);
              await postJournalEntry({
                sourceType: 'discount',
                sourceId: reqRow.id,
                description: `Approved discount on ${inv.invoice_number}`,
                postedBy: req.user!.id,
                lines: [...revDebits, { accountCode: receivableAcct, credit: reqDisc, memo: inv.invoice_number }],
              });
            }
            if (newStatus === 'paid') {
              await unlockPaidInvoiceGates({
                invoiceId: inv.id,
                invoiceNumber: inv.invoice_number,
                userId: req.user!.id,
              });
            }
          } else if (reqRow.request_type === 'refund' && Number(inv.paid_amount) > 0) {
            const refundAmt = Number(Math.min(Number(reqRow.requested_amount || inv.paid_amount), Number(inv.paid_amount)).toFixed(2));
            const lastPay = await queryOne<{ id: number; payment_method: string }>(
              "SELECT id, payment_method FROM payments WHERE invoice_id = ? AND status = 'completed' ORDER BY id DESC LIMIT 1",
              [inv.id]
            );
            const refundMethod = lastPay?.payment_method || 'cash';
            const linkedReceipt = lastPay
              ? await queryOne<{ id: number }>('SELECT id FROM receipts WHERE payment_id = ? LIMIT 1', [lastPay.id])
              : null;

            let shiftId: number | null = null;
            if (refundMethod === 'cash') {
              const openShift = await queryOne<{ id: number }>("SELECT id FROM cashier_shifts WHERE status = 'open' ORDER BY id DESC LIMIT 1");
              if (!openShift) {
                return {
                  ok: false as const,
                  error: 'An open cashier shift is required to process cash refund reversals.',
                  httpStatus: 409,
                };
              }
              shiftId = openShift.id;
              await execute('UPDATE cashier_shifts SET expected_cash = expected_cash - ? WHERE id = ?', [refundAmt, openShift.id]);
            }

            const cnNumber = await nextSequence('CN');
            await execute(
              "INSERT INTO payments (invoice_id, patient_id, shift_id, amount, payment_method, reference_number, status, created_by) VALUES (?, ?, ?, ?, ?, ?, 'refunded', ?)",
              [inv.id, inv.patient_id, shiftId, -refundAmt, refundMethod, cnNumber, req.user!.id]
            );
            const revDebits = await buildPerLineRevenueLines(inv.id, refundAmt, 'debit', `Credit Note ${cnNumber}`);
            const je = await postJournalEntry({
              sourceType: 'refund',
              sourceId: inv.id,
              description: `Refund Credit Note ${cnNumber} (${inv.invoice_number})`,
              postedBy: req.user!.id,
              lines: [
                ...revDebits,
                { accountCode: refundMethod === 'cash' ? '1010' : '1020', credit: refundAmt, memo: cnNumber },
              ],
            });
            await execute(
              `INSERT INTO credit_notes (credit_note_number, original_payment_id, receipt_id, invoice_id, patient_id, amount, payment_method, shift_id, journal_entry_id, reason, created_by)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [cnNumber, lastPay?.id ?? null, linkedReceipt?.id ?? null, inv.id, inv.patient_id, refundAmt, refundMethod, shiftId, je.entryId, reqRow.reason, req.user!.id]
            );
            const remPaid = Number((Number(inv.paid_amount) - refundAmt).toFixed(2));
            await execute("UPDATE invoices SET paid_amount = ?, status = CASE WHEN ? <= 0 THEN 'refunded' ELSE 'partial' END WHERE id = ?", [
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
            await execute("UPDATE lab_orders SET status = 'cancelled' WHERE invoice_id = ? AND status IN ('ordered','collected')", [inv.id]);
            await execute("UPDATE imaging_orders SET status = 'cancelled' WHERE invoice_id = ? AND status IN ('ordered','scheduled')", [inv.id]);
            await execute("UPDATE prescriptions SET status = 'cancelled' WHERE invoice_id = ? AND status IN ('draft','pending_payment','pending')", [inv.id]);
            await execute("UPDATE nursing_procedures SET status = 'cancelled' WHERE invoice_id = ? AND status = 'ordered'", [inv.id]);

            if (hasAccrual && Number(inv.total_amount) > 0) {
              const amt = Number(inv.total_amount);
              const revDebits = await buildPerLineRevenueLines(inv.id, amt, 'debit', `Void ${inv.invoice_number}`);
              await postJournalEntry({
                sourceType: 'void_invoice',
                sourceId: inv.id,
                description: `Void unpaid invoice ${inv.invoice_number}`,
                postedBy: req.user!.id,
                lines: [...revDebits, { accountCode: receivableAcct, credit: amt, memo: inv.invoice_number }],
              });
            }
          }
        }
      } else if (reqRow.entity_type === 'admission' && reqRow.request_type === 'discharge_override') {
        await createNotification({
          targetRole: 'WRD',
          title: 'Discharge Override Approved',
          message: `Financial override approved for Admission #${reqRow.entity_id}. Cashier can now clear discharge.`,
          severity: 'info',
          entityType: 'admission',
          entityId: reqRow.entity_id,
        });
      } else if (reqRow.entity_type === 'patient' && reqRow.request_type === 'payer_exempt') {
        const pat = await queryOne<{ id: number; patient_type: string }>('SELECT id, patient_type FROM patients WHERE id = ?', [reqRow.entity_id]);
        if (pat) {
          await execute("UPDATE patients SET patient_type = 'exempt', payer_name = 'Exempt / Charity Care' WHERE id = ?", [pat.id]);
          await execute(
            "INSERT INTO patient_payer_history (patient_id, from_type, to_type, payer_name, reason, changed_by, approved_by) VALUES (?, ?, 'exempt', 'Exempt / Charity Care', ?, ?, ?)",
            [pat.id, pat.patient_type, reqRow.reason, reqRow.requested_by, req.user!.id]
          );
        }
      }
    }

    await createNotification({
      targetRole: 'CSH',
      title: `Request ${decision}`,
      message: `${reqRow.request_type.replace(/_/g, ' ')} request #${id} was ${decision}.`,
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
// ADMINISTRATION, HR EMPLOYEE INTEGRATION, CONFIG, AUDIT LOG & BACKUP
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
  const allPermissions = await query('SELECT id, code, module, description FROM permissions ORDER BY module ASC, code ASC');
  res.json({ roles, rolePerms, allPermissions });
});

router.post('/admin/roles', requireAuth, requirePermission('admin.role.manage'), async (req: AuthRequest, res: Response) => {
  const code = String(req.body?.code || '').trim().toUpperCase().replace(/[^A-Z0-9_]/g, '');
  const name = String(req.body?.name || '').trim();
  const description = String(req.body?.description || '').trim();
  const permissionCodes: string[] = Array.isArray(req.body?.permission_codes) ? req.body.permission_codes : [];
  if (!code || code.length < 2 || code.length > 10 || !name) {
    return res.status(400).json({ error: 'Role code (2-10 alphanumeric characters) and role name are required.' });
  }
  const exists = await queryOne('SELECT id FROM roles WHERE code = ?', [code]);
  if (exists) {
    return res.status(409).json({ error: `Role code ${code} already exists.` });
  }
  const cleanCodes = [...new Set(permissionCodes.map((c) => String(c).trim()).filter(Boolean))];
  const permRows =
    cleanCodes.length > 0
      ? await query<{ id: number; code: string }>(`SELECT id, code FROM permissions WHERE code IN (${cleanCodes.map(() => '?').join(',')})`, cleanCodes)
      : [];

  const createdId = await withTransaction(async () => {
    const ins = await execute('INSERT INTO roles (code, name, description, system_role) VALUES (?, ?, ?, 0)', [
      code,
      name,
      description || null,
    ]);
    for (const p of permRows) {
      await execute('INSERT INTO role_permissions (role_id, permission_id, scope) VALUES (?, ?, ?)', [ins.insertId, p.id, 'all']);
    }
    await writeAuditLog({
      user: req.user,
      action: 'admin.role.create',
      entityType: 'role',
      entityId: ins.insertId,
      after: { code, name, permissionCodes: permRows.map((p) => p.code) },
      req,
    });
    return ins.insertId;
  });
  res.status(201).json({ id: createdId, code, name });
});

router.put('/admin/roles/:code', requireAuth, requirePermission('admin.role.manage'), async (req: AuthRequest, res: Response) => {
  const code = String(req.params.code || '').trim().toUpperCase();
  const name = String(req.body?.name || '').trim();
  const description = String(req.body?.description || '').trim();
  const role = await queryOne<{ id: number; name: string; description: string | null }>('SELECT id, name, description FROM roles WHERE code = ?', [code]);
  if (!role) return res.status(404).json({ error: 'Role not found' });
  if (!name) return res.status(400).json({ error: 'Role name is required.' });
  await execute('UPDATE roles SET name = ?, description = ? WHERE id = ?', [name, description || null, role.id]);
  await writeAuditLog({
    user: req.user,
    action: 'admin.role.update',
    entityType: 'role',
    entityId: role.id,
    before: { name: role.name, description: role.description },
    after: { name, description },
    req,
  });
  res.json({ ok: true });
});

router.put('/admin/roles/:code/permissions', requireAuth, requirePermission('admin.role.manage'), async (req: AuthRequest, res: Response) => {
  const roleCode = String(req.params.code || '').trim().toUpperCase();
  const permissionCodes: string[] = Array.isArray(req.body?.permission_codes) ? req.body.permission_codes : [];
  const role = await queryOne<{ id: number; code: string }>('SELECT id, code FROM roles WHERE code = ?', [roleCode]);
  if (!role) return res.status(404).json({ error: 'Role not found' });

  const cleanCodes = [...new Set(permissionCodes.map((c) => String(c).trim()).filter(Boolean))];
  const permRows =
    cleanCodes.length > 0
      ? await query<{ id: number; code: string }>(
          `SELECT id, code FROM permissions WHERE code IN (${cleanCodes.map(() => '?').join(',')})`,
          cleanCodes
        )
      : [];

  await withTransaction(async () => {
    await execute('DELETE FROM role_permissions WHERE role_id = ?', [role.id]);
    for (const p of permRows) {
      await execute('INSERT INTO role_permissions (role_id, permission_id, scope) VALUES (?, ?, ?)', [role.id, p.id, 'all']);
    }
    await writeAuditLog({
      user: req.user,
      action: 'admin.role.permissions.update',
      entityType: 'role',
      entityId: role.id,
      after: { roleCode, permissionCount: permRows.length, permissionCodes: permRows.map((p) => p.code) },
      req,
    });
  });

  res.json({ ok: true, roleCode, permissionCount: permRows.length });
});

// HR Employee Register Integration (Read-only lookup for System Admin user creation & access review)
router.get('/admin/hr-employees', requireAuth, requirePermission('admin.user.manage', 'audit.read'), async (req: AuthRequest, res: Response) => {
  const search = String(req.query.search || '').trim().toLowerCase();
  const dept = String(req.query.department || '').trim();
  const designation = String(req.query.designation || '').trim();
  const accountFilter = String(req.query.account_filter || 'all').trim();

  const clauses: string[] = ['1=1'];
  const params: unknown[] = [];
  if (search) {
    clauses.push('(LOWER(e.employee_number) LIKE ? OR LOWER(e.full_name) LIKE ? OR LOWER(e.department_name) LIKE ? OR LOWER(e.job_position) LIKE ? OR LOWER(COALESCE(e.email, \'\')) LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like, like, like);
  }
  if (dept) {
    clauses.push('e.department_name = ?');
    params.push(dept);
  }
  if (designation) {
    clauses.push('e.job_position = ?');
    params.push(designation);
  }
  if (accountFilter === 'review_required') {
    clauses.push('e.access_review_required = 1');
  }

  const rows = await query<{
    id: number;
    employee_number: string;
    user_id: number | null;
    full_name: string;
    gender: string;
    phone: string | null;
    email: string | null;
    department_name: string;
    job_position: string;
    employment_type: string;
    status: string;
    terminated_at: string | null;
    termination_reason: string | null;
    access_review_required: number;
    access_reviewed_at: string | null;
  }>(
    `SELECT e.id, e.employee_number, e.user_id, e.full_name, e.gender, e.phone, e.email,
            e.department_name, e.job_position, e.employment_type, e.status,
            e.terminated_at, e.termination_reason, e.access_review_required, e.access_reviewed_at
     FROM hr_employees e
     WHERE ${clauses.join(' AND ')}
     ORDER BY e.access_review_required DESC, e.employee_number ASC`,
    params
  );

  const linkedUsers = await query<{
    id: number;
    employee_id: number | null;
    username: string | null;
    email: string;
    active: number;
    status: string | null;
    role_code: string;
  }>(
    `SELECT u.id, u.employee_id, u.username, u.email, u.active, u.status,
            COALESCE((SELECT GROUP_CONCAT(r.code) FROM user_roles ur INNER JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id), '') AS role_code
     FROM users u`
  );

  const usersByEmpId = new Map<number, typeof linkedUsers>();
  const userById = new Map<number, (typeof linkedUsers)[0]>();
  for (const u of linkedUsers) {
    userById.set(u.id, u);
    if (u.employee_id) {
      const arr = usersByEmpId.get(u.employee_id) || [];
      arr.push(u);
      usersByEmpId.set(u.employee_id, arr);
    }
  }

  const enriched = rows
    .map((e) => {
      const matched = [...(usersByEmpId.get(e.id) || [])];
      if (e.user_id && userById.has(e.user_id) && !matched.some((m) => m.id === e.user_id)) {
        matched.push(userById.get(e.user_id)!);
      }
      const primary = matched[0] || null;
      return {
        ...e,
        has_system_account: matched.length > 0,
        account_count: matched.length,
        linked_user_id: primary?.id ?? null,
        linked_username: primary?.username ?? null,
        linked_email: primary?.email ?? null,
        linked_status: primary ? primary.status || (primary.active ? 'active' : 'inactive') : null,
        linked_roles: primary?.role_code || '',
      };
    })
    .filter((e) => {
      if (accountFilter === 'available') return !e.has_system_account && e.status === 'active';
      if (accountFilter === 'provisioned') return e.has_system_account;
      return true;
    });

  res.json({ employees: enriched });
});

router.post('/admin/hr-employees/:id/complete-access-review', requireAuth, requirePermission('admin.user.manage'), async (req: AuthRequest, res: Response) => {
  const empId = Number(req.params.id);
  const note = String(req.body?.note || '').trim();
  const emp = await queryOne<{ id: number; employee_number: string; full_name: string }>('SELECT id, employee_number, full_name FROM hr_employees WHERE id = ?', [empId]);
  if (!emp) return res.status(404).json({ error: 'HR employee not found' });

  await execute('UPDATE hr_employees SET access_review_required = 0, access_reviewed_at = ?, access_reviewed_by = ? WHERE id = ?', [
    nowSql(),
    req.user!.id,
    empId,
  ]);
  await writeAuditLog({
    user: req.user,
    action: 'admin.hr.access_review_completed',
    entityType: 'hr_employee',
    entityId: empId,
    after: { employee_number: emp.employee_number, full_name: emp.full_name, note: note || 'Access review completed' },
    req,
  });
  res.json({ ok: true });
});

router.get('/admin/users', requireAuth, requirePermission('admin.user.manage', 'audit.read', 'hr.manage'), async (_req, res) => {
  const users = await query<Record<string, unknown>>(
    `SELECT u.id, u.employee_id, u.username, u.full_name, u.email, u.specialty, u.active, u.status,
            u.exception_approved, u.must_change_password, u.two_fa_enabled,
            u.failed_attempts, u.locked_until, u.last_login_at, u.created_at,
            e.employee_number, e.department_name AS hr_department_name, e.job_position AS hr_job_position,
            e.status AS hr_status, e.access_review_required,
            COALESCE((SELECT GROUP_CONCAT(r.code) FROM user_roles ur INNER JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id), '') AS role_code,
            COALESCE((SELECT GROUP_CONCAT(r.name) FROM user_roles ur INNER JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id), '') AS role_name,
            COALESCE((SELECT GROUP_CONCAT(d.name) FROM user_departments ud INNER JOIN departments d ON d.id = ud.department_id WHERE ud.user_id = u.id), '') AS department_names,
            (SELECT COUNT(*) FROM user_sessions us WHERE us.user_id = u.id AND us.revoked_at IS NULL AND us.expires_at > ?) AS active_session_count
     FROM users u
     LEFT JOIN hr_employees e ON e.id = u.employee_id OR e.user_id = u.id
     ORDER BY u.id ASC`,
    [nowSql()]
  );

  const [deptMaps, unitMaps] = await Promise.all([
    query<{ user_id: number; department_id: number }>('SELECT user_id, department_id FROM user_departments').catch(() => []),
    query<{ user_id: number; clinic_room_id: number }>('SELECT user_id, clinic_room_id FROM user_clinic_units').catch(() => []),
  ]);
  const deptIdsByUser = new Map<number, number[]>();
  for (const d of deptMaps) {
    const arr = deptIdsByUser.get(d.user_id) || [];
    arr.push(d.department_id);
    deptIdsByUser.set(d.user_id, arr);
  }
  const unitIdsByUser = new Map<number, number[]>();
  for (const r of unitMaps) {
    const arr = unitIdsByUser.get(r.user_id) || [];
    arr.push(r.clinic_room_id);
    unitIdsByUser.set(r.user_id, arr);
  }

  const enriched = users.map((u) => {
    const uid = Number(u.id);
    const derivedStatus = u.status || (Number(u.active) ? (u.locked_until ? 'locked' : 'active') : 'inactive');
    return {
      ...u,
      status: derivedStatus,
      department_ids: deptIdsByUser.get(uid) || [],
      clinic_unit_ids: unitIdsByUser.get(uid) || [],
    };
  });
  res.json({ users: enriched });
});

router.get('/admin/deployment-status', requireAuth, requirePermission('admin.user.manage', 'admin.backup.manage', 'audit.read'), async (_req, res) => {
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
  const {
    employee_id,
    full_name,
    username,
    email,
    password,
    generate_temp_password,
    role_code,
    role_codes,
    specialty,
    two_fa_enabled,
    department_ids,
    clinic_unit_ids,
    exception_approved = false,
  } = req.body || {};

  const requestedRoles: string[] = Array.isArray(role_codes) && role_codes.length > 0
    ? role_codes.map((c: unknown) => String(c).trim().toUpperCase()).filter(Boolean)
    : role_code
      ? [String(role_code).trim().toUpperCase()]
      : [];

  if (requestedRoles.length === 0) {
    return res.status(400).json({ error: 'At least one system role must be explicitly assigned.' });
  }

  let resolvedFullName = String(full_name || '').trim();
  let resolvedEmail = String(email || '').trim().toLowerCase();
  const empIdNum = employee_id ? Number(employee_id) : null;

  if (empIdNum) {
    const emp = await queryOne<{
      id: number;
      employee_number: string;
      user_id: number | null;
      full_name: string;
      email: string | null;
      department_name: string;
      job_position: string;
      status: string;
    }>('SELECT id, employee_number, user_id, full_name, email, department_name, job_position, status FROM hr_employees WHERE id = ?', [empIdNum]);

    if (!emp) {
      return res.status(404).json({ error: 'Selected HR employee record was not found.' });
    }
    if (emp.status !== 'active') {
      return res.status(409).json({ error: `Cannot provision access for HR employee ${emp.employee_number} (status: ${emp.status}).` });
    }
    const existingLinked = await query<{ id: number }>(
      'SELECT id FROM users WHERE employee_id = ? OR id = ?',
      [emp.id, emp.user_id || -1]
    );
    if (existingLinked.length > 0 && !exception_approved) {
      return res.status(409).json({
        error: `One-Account Rule: HR employee ${emp.employee_number} (${emp.full_name}) already has a linked system account. Enable explicit exception approval if a secondary account is justified.`,
        oneAccountViolation: true,
      });
    }
    resolvedFullName = emp.full_name;
    if (!resolvedEmail && emp.email) {
      resolvedEmail = emp.email.trim().toLowerCase();
    }
  } else if (!exception_approved) {
    return res.status(400).json({ error: 'Selecting an existing HR employee record (employee_id) is required unless explicit exception_approved is set.' });
  }

  if (!resolvedFullName || !resolvedEmail) {
    return res.status(400).json({ error: 'Employee full name and work email are required.' });
  }

  const resolvedUsername = (username ? String(username) : resolvedEmail.split('@')[0])
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '');
  if (!resolvedUsername || resolvedUsername.length < 3) {
    return res.status(400).json({ error: 'A valid username (min 3 characters) is required.' });
  }

  const settings = await getClinicSettings();
  const minPwdLen = Math.max(8, Number(settings.security?.passwordMinLength || 8));
  const rawPassword = generate_temp_password
    ? `C360-${crypto.randomBytes(Math.max(4, Math.ceil(minPwdLen / 2))).toString('hex')}Aa!`
    : String(password || '');
  const pwdPolicyErr = validatePasswordPolicy(rawPassword, settings.security);
  if (pwdPolicyErr) {
    return res.status(400).json({ error: pwdPolicyErr });
  }

  const roleRows = await query<{ id: number; code: string }>(
    `SELECT id, code FROM roles WHERE code IN (${requestedRoles.map(() => '?').join(',')})`,
    requestedRoles
  );
  if (roleRows.length !== new Set(requestedRoles).size) {
    return res.status(400).json({ error: 'One or more invalid role codes.' });
  }

  const [existingEmail, existingUsername] = await Promise.all([
    queryOne<{ id: number }>('SELECT id FROM users WHERE LOWER(email) = ?', [resolvedEmail]),
    queryOne<{ id: number }>('SELECT id FROM users WHERE LOWER(username) = ?', [resolvedUsername]),
  ]);
  if (existingEmail) return res.status(409).json({ error: 'A system user with this email already exists.' });
  if (existingUsername) return res.status(409).json({ error: `Username "${resolvedUsername}" is already in use.` });

  const hasPrivilegedRole = requestedRoles.some((c) => ['ADM', 'ACC', 'MGR'].includes(c));
  const enforce2fa = two_fa_enabled !== undefined ? (two_fa_enabled ? 1 : 0) : hasPrivilegedRole ? 1 : 0;
  const hash = await bcrypt.hash(rawPassword, 12);
  const deptIds = Array.isArray(department_ids) ? [...new Set(department_ids.map(Number).filter(Boolean))] : [];
  const unitIds = Array.isArray(clinic_unit_ids) ? [...new Set(clinic_unit_ids.map(Number).filter(Boolean))] : [];

  const insertedId = await withTransaction(async () => {
    const inserted = await execute(
      `INSERT INTO users (branch_id, department_id, employee_id, username, full_name, email, password_hash, specialty, active, status, exception_approved, must_change_password, two_fa_enabled)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, 1, 'active', ?, 1, ?)`,
      [deptIds[0] ?? null, empIdNum, resolvedUsername, resolvedFullName, resolvedEmail, hash, specialty || null, exception_approved ? 1 : 0, enforce2fa]
    );
    for (const r of roleRows) {
      await execute('INSERT INTO user_roles (user_id, role_id, branch_id) VALUES (?, ?, 1)', [inserted.insertId, r.id]);
    }
    for (let idx = 0; idx < deptIds.length; idx++) {
      await execute('INSERT INTO user_departments (user_id, department_id, is_primary) VALUES (?, ?, ?)', [
        inserted.insertId,
        deptIds[idx],
        idx === 0 ? 1 : 0,
      ]);
    }
    for (const unitId of unitIds) {
      await execute('INSERT INTO user_clinic_units (user_id, clinic_room_id) VALUES (?, ?)', [inserted.insertId, unitId]);
    }
    if (empIdNum) {
      await execute('UPDATE hr_employees SET user_id = COALESCE(user_id, ?), updated_at = ? WHERE id = ?', [
        inserted.insertId,
        nowSql(),
        empIdNum,
      ]);
    }
    await writeAuditLog({
      user: req.user,
      action: 'admin.user.create',
      entityType: 'user',
      entityId: inserted.insertId,
      after: {
        employee_id: empIdNum,
        username: resolvedUsername,
        email: resolvedEmail,
        roles: requestedRoles,
        department_ids: deptIds,
        clinic_unit_ids: unitIds,
        exception_approved: Boolean(exception_approved),
        two_fa_enabled: Boolean(enforce2fa),
      },
      req,
    });
    return inserted.insertId;
  });

  res.status(201).json({
    id: insertedId,
    username: resolvedUsername,
    email: resolvedEmail,
    tempPassword: generate_temp_password ? rawPassword : undefined,
  });
});

router.put('/admin/users/:id', requireAuth, requirePermission('admin.user.manage'), async (req: AuthRequest, res: Response) => {
  const targetId = Number(req.params.id);
  const target = await queryOne<{
    id: number;
    employee_id: number | null;
    username: string | null;
    email: string;
    specialty: string | null;
    two_fa_enabled: number;
  }>('SELECT id, employee_id, username, email, specialty, two_fa_enabled FROM users WHERE id = ?', [targetId]);
  if (!target) return res.status(404).json({ error: 'User not found' });

  const { username, email, specialty, two_fa_enabled, department_ids, clinic_unit_ids } = req.body || {};
  const nextEmail = email ? String(email).trim().toLowerCase() : target.email;
  const nextUsername = username ? String(username).trim().toLowerCase().replace(/[^a-z0-9._-]/g, '') : target.username;
  if (!nextEmail || !nextUsername) {
    return res.status(400).json({ error: 'Valid email and username are required.' });
  }
  const dupEmail = await queryOne('SELECT id FROM users WHERE LOWER(email) = ? AND id != ?', [nextEmail, targetId]);
  if (dupEmail) return res.status(409).json({ error: 'Email already assigned to another user.' });
  const dupUser = await queryOne('SELECT id FROM users WHERE LOWER(username) = ? AND id != ?', [nextUsername, targetId]);
  if (dupUser) return res.status(409).json({ error: 'Username already assigned to another user.' });

  const deptIds = Array.isArray(department_ids) ? [...new Set(department_ids.map(Number).filter(Boolean))] : null;
  const unitIds = Array.isArray(clinic_unit_ids) ? [...new Set(clinic_unit_ids.map(Number).filter(Boolean))] : null;

  await withTransaction(async () => {
    await execute(
      'UPDATE users SET username = ?, email = ?, specialty = ?, two_fa_enabled = ?, department_id = COALESCE(?, department_id), updated_at = ? WHERE id = ?',
      [
        nextUsername,
        nextEmail,
        specialty !== undefined ? specialty || null : target.specialty,
        two_fa_enabled !== undefined ? (two_fa_enabled ? 1 : 0) : target.two_fa_enabled,
        deptIds ? deptIds[0] ?? null : null,
        nowSql(),
        targetId,
      ]
    );
    if (deptIds) {
      await execute('DELETE FROM user_departments WHERE user_id = ?', [targetId]);
      for (let i = 0; i < deptIds.length; i++) {
        await execute('INSERT INTO user_departments (user_id, department_id, is_primary) VALUES (?, ?, ?)', [
          targetId,
          deptIds[i],
          i === 0 ? 1 : 0,
        ]);
      }
    }
    if (unitIds) {
      await execute('DELETE FROM user_clinic_units WHERE user_id = ?', [targetId]);
      for (const uid of unitIds) {
        await execute('INSERT INTO user_clinic_units (user_id, clinic_room_id) VALUES (?, ?)', [targetId, uid]);
      }
    }
    await writeAuditLog({
      user: req.user,
      action: 'admin.user.update',
      entityType: 'user',
      entityId: targetId,
      before: { username: target.username, email: target.email, specialty: target.specialty },
      after: { username: nextUsername, email: nextEmail, specialty, department_ids: deptIds, clinic_unit_ids: unitIds },
      req,
    });
  });

  res.json({ ok: true });
});

router.put('/admin/users/:id/roles', requireAuth, requirePermission('admin.user.manage'), async (req: AuthRequest, res: Response) => {
  const targetId = Number(req.params.id);
  const roleCodes: string[] = Array.isArray(req.body?.role_codes)
    ? [...new Set<string>((req.body.role_codes as unknown[]).map((c) => String(c).trim().toUpperCase()).filter(Boolean))]
    : [];
  if (roleCodes.length === 0) {
    return res.status(400).json({ error: 'At least one role_code must be assigned.' });
  }
  if (targetId === req.user!.id && !roleCodes.includes('ADM')) {
    return res.status(409).json({ error: 'Administrators cannot remove their own ADM role.' });
  }

  const target = await queryOne<{ id: number; email: string }>('SELECT id, email FROM users WHERE id = ?', [targetId]);
  if (!target) return res.status(404).json({ error: 'User not found' });

  const roleRows = await query<{ id: number; code: string }>(
    `SELECT id, code FROM roles WHERE code IN (${roleCodes.map(() => '?').join(',')})`,
    roleCodes
  );
  if (roleRows.length !== roleCodes.length) {
    return res.status(400).json({ error: 'One or more role codes do not exist.' });
  }

  await withTransaction(async () => {
    const prevRoles = await query<{ code: string }>(
      'SELECT r.code FROM user_roles ur INNER JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?',
      [targetId]
    );
    await execute('DELETE FROM user_roles WHERE user_id = ?', [targetId]);
    for (const r of roleRows) {
      await execute('INSERT INTO user_roles (user_id, role_id, branch_id) VALUES (?, ?, 1)', [targetId, r.id]);
    }
    await writeAuditLog({
      user: req.user,
      action: 'admin.user.roles.update',
      entityType: 'user',
      entityId: targetId,
      before: { roles: prevRoles.map((r) => r.code) },
      after: { roles: roleCodes },
      req,
    });
  });

  res.json({ ok: true, roles: roleCodes });
});

router.patch('/admin/users/:id/status', requireAuth, requirePermission('admin.user.manage'), async (req: AuthRequest, res: Response) => {
  const targetId = Number(req.params.id);
  const action = String(req.body?.action || '').trim();
  const reason = String(req.body?.reason || '').trim();
  const allowedActions = new Set(['activate', 'deactivate', 'lock', 'unlock', 'reset_password', 'revoke_sessions']);
  if (!allowedActions.has(action)) {
    return res.status(400).json({ error: 'Invalid status action.' });
  }
  if (targetId === req.user!.id && ['deactivate', 'lock'].includes(action)) {
    return res.status(409).json({ error: 'Administrators cannot lock or deactivate their own active session.' });
  }

  const target = await queryOne<{ id: number; employee_id: number | null; email: string; active: number; status: string | null }>(
    'SELECT id, employee_id, email, active, status FROM users WHERE id = ?',
    [targetId]
  );
  if (!target) return res.status(404).json({ error: 'User not found' });

  let tempPasswordOut: string | undefined;
  let revokedCount = 0;

  if (action === 'activate') {
    const hrEmp = await getLinkedHrEmployeeStatus(targetId, target.employee_id ?? null);
    if (hrEmp && hrEmp.status !== 'active') {
      return res.status(409).json({
        error: `Cannot activate user account: linked HR employee is '${hrEmp.status}'. Reactivate the HR employee record first.`,
      });
    }
    await execute("UPDATE users SET active = 1, status = 'active', failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?", [
      nowSql(),
      targetId,
    ]);
  } else if (action === 'deactivate') {
    await execute("UPDATE users SET active = 0, status = 'inactive', updated_at = ? WHERE id = ?", [nowSql(), targetId]);
    revokedCount = await revokeAllUserSessions(targetId, req.user!.id);
  } else if (action === 'lock') {
    await execute("UPDATE users SET status = 'locked', locked_until = '2099-12-31 23:59:59', updated_at = ? WHERE id = ?", [
      nowSql(),
      targetId,
    ]);
    revokedCount = await revokeAllUserSessions(targetId, req.user!.id);
  } else if (action === 'unlock') {
    const hrEmp = target.active ? await getLinkedHrEmployeeStatus(targetId, target.employee_id ?? null) : null;
    const nextStatus = target.active && (!hrEmp || hrEmp.status === 'active') ? 'active' : 'inactive';
    await execute('UPDATE users SET failed_attempts = 0, locked_until = NULL, status = ?, updated_at = ? WHERE id = ?', [
      nextStatus,
      nowSql(),
      targetId,
    ]);
  } else if (action === 'reset_password') {
    const settings = await getClinicSettings();
    const minPwdLen = Math.max(8, Number(settings.security?.passwordMinLength || 8));
    const requestedPwd = req.body?.new_password ? String(req.body.new_password) : '';
    const tempPwd = requestedPwd
      ? requestedPwd
      : `C360-${crypto.randomBytes(Math.max(4, Math.ceil(minPwdLen / 2))).toString('hex')}Aa!`;
    const pwdPolicyErr = validatePasswordPolicy(tempPwd, settings.security);
    if (pwdPolicyErr) {
      return res.status(400).json({ error: pwdPolicyErr });
    }
    const hash = await bcrypt.hash(tempPwd, 12);
    await execute('UPDATE users SET password_hash = ?, must_change_password = 1, failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?', [
      hash,
      nowSql(),
      targetId,
    ]);
    revokedCount = await revokeAllUserSessions(targetId, req.user!.id);
    tempPasswordOut = tempPwd;
  } else if (action === 'revoke_sessions') {
    revokedCount = await revokeAllUserSessions(targetId, req.user!.id);
  }

  await writeAuditLog({
    user: req.user,
    action: `admin.user.${action}`,
    entityType: 'user',
    entityId: targetId,
    before: { active: Boolean(target.active), status: target.status },
    after: { action, revokedSessions: revokedCount },
    reason: reason || null,
    req,
  });

  res.json({ ok: true, action, revokedSessions: revokedCount, tempPassword: tempPasswordOut });
});

router.post('/admin/users/:id/unlock', requireAuth, requirePermission('admin.user.manage'), async (req: AuthRequest, res: Response) => {
  const targetId = Number(req.params.id);
  const target = await queryOne<{ id: number; email: string; active: number; failed_attempts: number; locked_until: string | null }>(
    'SELECT id, email, active, failed_attempts, locked_until FROM users WHERE id = ?',
    [targetId]
  );
  if (!target) return res.status(404).json({ error: 'User not found' });

  await execute('UPDATE users SET failed_attempts = 0, locked_until = NULL, status = ?, updated_at = ? WHERE id = ?', [
    target.active ? 'active' : 'inactive',
    nowSql(),
    targetId,
  ]);
  await writeAuditLog({
    user: req.user,
    action: 'admin.user.unlock',
    entityType: 'user',
    entityId: targetId,
    before: { failed_attempts: target.failed_attempts, locked_until: target.locked_until },
    after: { failed_attempts: 0, locked_until: null },
    req,
  });
  res.json({ ok: true });
});

router.patch('/admin/users/:id/toggle', requireAuth, requirePermission('admin.user.manage'), async (req: AuthRequest, res: Response) => {
  const targetId = Number(req.params.id);
  if (targetId === req.user!.id) {
    return res.status(409).json({ error: 'Administrators cannot deactivate their own account.' });
  }
  const target = await queryOne<{ id: number; employee_id: number | null; active: number; email: string }>(
    'SELECT id, employee_id, active, email FROM users WHERE id = ?',
    [targetId]
  );
  if (!target) return res.status(404).json({ error: 'User not found' });

  const nextActive = target.active ? 0 : 1;
  if (nextActive === 1) {
    const hrEmp = await getLinkedHrEmployeeStatus(targetId, target.employee_id ?? null);
    if (hrEmp && hrEmp.status !== 'active') {
      return res.status(409).json({
        error: `Cannot activate user account: linked HR employee is '${hrEmp.status}'. Reactivate the HR employee record first.`,
      });
    }
  }
  await execute('UPDATE users SET active = ?, status = ?, updated_at = ? WHERE id = ?', [
    nextActive,
    nextActive ? 'active' : 'inactive',
    nowSql(),
    targetId,
  ]);
  if (!nextActive) {
    await revokeAllUserSessions(targetId, req.user!.id);
  }

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

router.get(
  '/admin/users/:id/sessions',
  requireAuth,
  authorize(['admin.user.manage', 'audit.read'], {
    audit: { action: 'admin.user.sessions.read', entityType: 'user', entityIdParam: 'id' },
  }),
  async (req: AuthRequest, res: Response) => {
  const targetId = Number(req.params.id);
  const sessions = await query(
    `SELECT jti, user_id, ip_address, user_agent, created_at, last_seen_at, expires_at, revoked_at, revoked_by
     FROM user_sessions
     WHERE user_id = ?
     ORDER BY created_at DESC
     LIMIT 30`,
    [targetId]
  );
  res.json({ sessions });
});

router.delete(
  '/admin/users/:id/sessions/:jti',
  requireAuth,
  authorize('admin.user.manage', {
    audit: { action: 'admin.user.session_revoked', entityType: 'user', entityIdParam: 'id', dedupeIfAudited: true },
  }),
  async (req: AuthRequest, res: Response) => {
  const targetId = Number(req.params.id);
  const jti = String(req.params.jti || '').trim();
  const sess = await queryOne<{ jti: string; expires_at: string }>(
    'SELECT jti, expires_at FROM user_sessions WHERE jti = ? AND user_id = ?',
    [jti, targetId]
  );
  if (!sess) return res.status(404).json({ error: 'Session not found for user' });
  const expSec = Math.floor(new Date(`${String(sess.expires_at).replace(' ', 'T')}Z`).getTime() / 1000);
  await revokeToken(jti, Number.isFinite(expSec) ? expSec : undefined, req.user!.id);
  await writeAuditLog({
    user: req.user,
    action: 'admin.user.session_revoked',
    entityType: 'user',
    entityId: targetId,
    after: { jti },
    req,
  });
  res.json({ ok: true });
});

router.delete(
  '/admin/users/:id/sessions',
  requireAuth,
  authorize('admin.user.manage', {
    audit: { action: 'admin.user.sessions_revoked_all', entityType: 'user', entityIdParam: 'id', dedupeIfAudited: true },
  }),
  async (req: AuthRequest, res: Response) => {
  const targetId = Number(req.params.id);
  const revokedCount = await revokeAllUserSessions(targetId, req.user!.id);
  await writeAuditLog({
    user: req.user,
    action: 'admin.user.sessions_revoked_all',
    entityType: 'user',
    entityId: targetId,
    after: { revokedCount },
    req,
  });
  res.json({ ok: true, revokedCount });
});

router.get(
  '/admin/users/:id/activity',
  requireAuth,
  authorize(['admin.user.manage', 'audit.read'], {
    audit: { action: 'admin.user.activity.read', entityType: 'user', entityIdParam: 'id' },
  }),
  async (req: AuthRequest, res: Response) => {
  const targetId = Number(req.params.id);
  const logs = await query(
    'SELECT * FROM audit_logs WHERE user_id = ? ORDER BY id DESC LIMIT 60',
    [targetId]
  );
  res.json({ logs });
});

// Department-scoped operational summary endpoint enforcing department isolation + audit hook
router.get(
  '/departments/:departmentId/overview',
  requireAuth,
  authorize(['visit.read', 'admin.config.manage', 'admin.user.manage', 'audit.read'], {
    checkDepartment: true,
    departmentParam: 'departmentId',
    audit: { action: 'department.overview.read', entityType: 'department', entityIdParam: 'departmentId' },
  }),
  async (req: AuthRequest, res: Response) => {
    const departmentId = Number(req.params.departmentId);
    const dept = await queryOne<Record<string, unknown>>('SELECT * FROM departments WHERE id = ?', [departmentId]);
    if (!dept) return res.status(404).json({ error: 'Department not found' });
    const [rooms, staff] = await Promise.all([
      query('SELECT id, room_code, name, room_type, capacity, active FROM clinic_rooms WHERE department_id = ? ORDER BY room_code ASC', [departmentId]),
      query(
        `SELECT u.id, u.username, u.full_name, u.specialty, u.status
         FROM user_departments ud
         INNER JOIN users u ON u.id = ud.user_id
         WHERE ud.department_id = ? AND u.active = 1
         ORDER BY u.full_name ASC`,
        [departmentId]
      ),
    ]);
    res.json({ department: dept, rooms, staff });
  }
);

// Clinic Configuration: Departments, Specialties, Clinic Rooms & Doctor Profiles
router.get('/admin/departments', requireAuth, requirePermission('admin.user.manage', 'admin.config.manage', 'catalog.manage', 'audit.read', 'hr.manage'), async (_req, res) => {
  const departments = await query(
    `SELECT d.*,
            (SELECT COUNT(*) FROM user_departments ud WHERE ud.department_id = d.id) AS assigned_staff_count,
            (SELECT COUNT(*) FROM clinic_rooms cr WHERE cr.department_id = d.id AND cr.active = 1) AS active_room_count
     FROM departments d
     ORDER BY d.code ASC`
  );
  res.json({ departments });
});

router.post('/admin/departments', requireAuth, requirePermission('admin.user.manage', 'admin.config.manage'), async (req: AuthRequest, res: Response) => {
  const code = String(req.body?.code || '').trim().toUpperCase().replace(/[^A-Z0-9_]/g, '');
  const name = String(req.body?.name || '').trim();
  const category = String(req.body?.category || 'clinical').trim().toLowerCase();
  const headName = String(req.body?.head_name || '').trim();
  const description = String(req.body?.description || '').trim();
  if (!code || !name) return res.status(400).json({ error: 'Department code and name are required.' });
  const dup = await queryOne('SELECT id FROM departments WHERE code = ?', [code]);
  if (dup) return res.status(409).json({ error: `Department code ${code} already exists.` });
  const ins = await execute(
    'INSERT INTO departments (branch_id, code, name, category, head_name, description, active) VALUES (1, ?, ?, ?, ?, ?, 1)',
    [code, name, category || 'clinical', headName || null, description || null]
  );
  await writeAuditLog({
    user: req.user,
    action: 'admin.department.create',
    entityType: 'department',
    entityId: ins.insertId,
    after: { code, name, category, headName },
    req,
  });
  res.status(201).json({ id: ins.insertId });
});

router.put('/admin/departments/:id', requireAuth, requirePermission('admin.user.manage', 'admin.config.manage'), async (req: AuthRequest, res: Response) => {
  const id = Number(req.params.id);
  const existing = await queryOne('SELECT * FROM departments WHERE id = ?', [id]);
  if (!existing) return res.status(404).json({ error: 'Department not found' });
  const { name, category, head_name, description, active } = req.body || {};
  await execute(
    'UPDATE departments SET name = ?, category = ?, head_name = ?, description = ?, active = ? WHERE id = ?',
    [
      String(name || existing.name).trim(),
      String(category || existing.category || 'clinical').trim(),
      head_name !== undefined ? String(head_name || '').trim() || null : existing.head_name,
      description !== undefined ? String(description || '').trim() || null : existing.description,
      active !== undefined ? (Number(active) ? 1 : 0) : existing.active,
      id,
    ]
  );
  await writeAuditLog({
    user: req.user,
    action: 'admin.department.update',
    entityType: 'department',
    entityId: id,
    after: { name, category, head_name, active },
    req,
  });
  res.json({ ok: true });
});

router.get('/admin/specialties', requireAuth, requirePermission('admin.user.manage', 'admin.config.manage', 'catalog.manage', 'visit.read'), async (_req, res) => {
  const specialties = await query(
    `SELECT s.*, d.name AS department_name
     FROM specialties s
     LEFT JOIN departments d ON d.id = s.department_id
     ORDER BY s.name ASC`
  );
  res.json({ specialties });
});

router.post('/admin/specialties', requireAuth, requirePermission('admin.user.manage', 'admin.config.manage'), async (req: AuthRequest, res: Response) => {
  const code = String(req.body?.code || '').trim().toUpperCase().replace(/[^A-Z0-9_]/g, '');
  const name = String(req.body?.name || '').trim();
  const departmentId = req.body?.department_id ? Number(req.body.department_id) : null;
  const description = String(req.body?.description || '').trim();
  const fee = Math.max(0, Number(req.body?.consultation_fee ?? 45));
  if (!code || !name) return res.status(400).json({ error: 'Specialty code and name are required.' });
  const dup = await queryOne('SELECT id FROM specialties WHERE code = ?', [code]);
  if (dup) return res.status(409).json({ error: `Specialty code ${code} already exists.` });
  const ins = await execute(
    'INSERT INTO specialties (code, name, department_id, description, consultation_fee, active) VALUES (?, ?, ?, ?, ?, 1)',
    [code, name, departmentId, description || null, fee]
  );
  await writeAuditLog({
    user: req.user,
    action: 'admin.specialty.create',
    entityType: 'specialty',
    entityId: ins.insertId,
    after: { code, name, fee },
    req,
  });
  res.status(201).json({ id: ins.insertId });
});

router.put('/admin/specialties/:id', requireAuth, requirePermission('admin.user.manage', 'admin.config.manage'), async (req: AuthRequest, res: Response) => {
  const id = Number(req.params.id);
  const existing = await queryOne('SELECT * FROM specialties WHERE id = ?', [id]);
  if (!existing) return res.status(404).json({ error: 'Specialty not found' });
  const { name, department_id, description, consultation_fee, active } = req.body || {};
  await execute(
    'UPDATE specialties SET name = ?, department_id = ?, description = ?, consultation_fee = ?, active = ? WHERE id = ?',
    [
      String(name || existing.name).trim(),
      department_id !== undefined ? (department_id ? Number(department_id) : null) : existing.department_id,
      description !== undefined ? String(description || '').trim() || null : existing.description,
      consultation_fee !== undefined ? Math.max(0, Number(consultation_fee)) : existing.consultation_fee,
      active !== undefined ? (Number(active) ? 1 : 0) : existing.active,
      id,
    ]
  );
  await writeAuditLog({
    user: req.user,
    action: 'admin.specialty.update',
    entityType: 'specialty',
    entityId: id,
    after: { name, consultation_fee, active },
    req,
  });
  res.json({ ok: true });
});

router.get('/admin/clinic-rooms', requireAuth, requirePermission('admin.user.manage', 'admin.config.manage', 'catalog.manage', 'visit.read'), async (_req, res) => {
  const rooms = await query(
    `SELECT cr.*, d.name AS department_name, sp.name AS specialty_name
     FROM clinic_rooms cr
     LEFT JOIN departments d ON d.id = cr.department_id
     LEFT JOIN specialties sp ON sp.id = cr.specialty_id
     ORDER BY cr.room_code ASC`
  );
  res.json({ rooms });
});

router.post('/admin/clinic-rooms', requireAuth, requirePermission('admin.user.manage', 'admin.config.manage'), async (req: AuthRequest, res: Response) => {
  const roomCode = String(req.body?.room_code || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  const name = String(req.body?.name || '').trim();
  const departmentId = req.body?.department_id ? Number(req.body.department_id) : null;
  const specialtyId = req.body?.specialty_id ? Number(req.body.specialty_id) : null;
  const roomType = String(req.body?.room_type || 'consultation').trim().toLowerCase();
  const capacity = Math.max(1, Number(req.body?.capacity || 1));
  if (!roomCode || !name) return res.status(400).json({ error: 'Room code and name are required.' });
  const dup = await queryOne('SELECT id FROM clinic_rooms WHERE room_code = ?', [roomCode]);
  if (dup) return res.status(409).json({ error: `Room code ${roomCode} already exists.` });
  const ins = await execute(
    'INSERT INTO clinic_rooms (room_code, name, department_id, specialty_id, room_type, capacity, active) VALUES (?, ?, ?, ?, ?, ?, 1)',
    [roomCode, name, departmentId, specialtyId, roomType, capacity]
  );
  await writeAuditLog({
    user: req.user,
    action: 'admin.clinic_room.create',
    entityType: 'clinic_room',
    entityId: ins.insertId,
    after: { roomCode, name, roomType, capacity },
    req,
  });
  res.status(201).json({ id: ins.insertId });
});

router.put('/admin/clinic-rooms/:id', requireAuth, requirePermission('admin.user.manage', 'admin.config.manage'), async (req: AuthRequest, res: Response) => {
  const id = Number(req.params.id);
  const existing = await queryOne('SELECT * FROM clinic_rooms WHERE id = ?', [id]);
  if (!existing) return res.status(404).json({ error: 'Clinic room not found' });
  const { name, department_id, specialty_id, room_type, capacity, active } = req.body || {};
  await execute(
    'UPDATE clinic_rooms SET name = ?, department_id = ?, specialty_id = ?, room_type = ?, capacity = ?, active = ? WHERE id = ?',
    [
      String(name || existing.name).trim(),
      department_id !== undefined ? (department_id ? Number(department_id) : null) : existing.department_id,
      specialty_id !== undefined ? (specialty_id ? Number(specialty_id) : null) : existing.specialty_id,
      String(room_type || existing.room_type).trim().toLowerCase(),
      capacity !== undefined ? Math.max(1, Number(capacity)) : existing.capacity,
      active !== undefined ? (Number(active) ? 1 : 0) : existing.active,
      id,
    ]
  );
  await writeAuditLog({
    user: req.user,
    action: 'admin.clinic_room.update',
    entityType: 'clinic_room',
    entityId: id,
    after: { name, room_type, capacity, active },
    req,
  });
  res.json({ ok: true });
});

router.get('/admin/doctors', requireAuth, requirePermission('admin.user.manage', 'admin.config.manage', 'visit.read'), async (_req, res) => {
  const doctors = await query(
    `SELECT u.id, u.username, u.full_name, u.email, u.specialty, u.active, u.status,
            e.employee_number, e.department_name AS hr_department_name, e.licence_number, e.licence_expiry,
            COALESCE((SELECT GROUP_CONCAT(cr.room_code || ' (' || cr.name || ')')
                      FROM user_clinic_units ucu
                      INNER JOIN clinic_rooms cr ON cr.id = ucu.clinic_room_id
                      WHERE ucu.user_id = u.id), '') AS assigned_rooms,
            (SELECT COUNT(*) FROM visits v WHERE v.doctor_id = u.id AND v.status != 'closed') AS active_visits_count
     FROM users u
     INNER JOIN user_roles ur ON ur.user_id = u.id
     INNER JOIN roles r ON r.id = ur.role_id AND r.code = 'DOC'
     LEFT JOIN hr_employees e ON e.id = u.employee_id OR e.user_id = u.id
     ORDER BY u.full_name ASC`
  );
  res.json({ doctors });
});

router.get('/admin/backup-status', requireAuth, requirePermission('admin.user.manage', 'admin.backup.manage', 'audit.read'), async (_req, res) => {
  const cfg = getDbConfigSummary();
  const settings = await getClinicSettings();
  let sqliteFileBytes: number | null = null;
  let sqliteIntegrity = 'n/a';
  if (cfg.dialect === 'sqlite') {
    const dbPath = process.env.SQLITE_PATH ? path.resolve(process.env.SQLITE_PATH) : path.resolve(process.cwd(), 'clinic360.db');
    try {
      const stat = fs.statSync(dbPath);
      sqliteFileBytes = stat.size;
    } catch {
      sqliteFileBytes = null;
    }
    const check = await queryOne<{ integrity_check?: string }>('PRAGMA integrity_check').catch(() => null);
    sqliteIntegrity = check?.integrity_check || 'ok';
  }
  const [patientsCnt, visitsCnt, invoicesCnt, auditCnt, empCnt, userCnt, activeSessCnt] = await Promise.all([
    queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM patients'),
    queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM visits'),
    queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM invoices'),
    queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM audit_logs'),
    queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM hr_employees'),
    queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM users'),
    queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM user_sessions WHERE revoked_at IS NULL AND expires_at > ?', [nowSql()]),
  ]);
  res.json({
    dialect: cfg.dialect,
    mysqlConfigured: cfg.mysqlConfigured,
    sqliteFileBytes,
    sqliteIntegrity,
    lastBackupVerifiedAt: settings.lastBackupVerifiedAt,
    lastBackupVerifiedBy: settings.lastBackupVerifiedBy,
    tableCounts: {
      patients: Number(patientsCnt?.cnt || 0),
      visits: Number(visitsCnt?.cnt || 0),
      invoices: Number(invoicesCnt?.cnt || 0),
      auditLogs: Number(auditCnt?.cnt || 0),
      hrEmployees: Number(empCnt?.cnt || 0),
      users: Number(userCnt?.cnt || 0),
      activeSessions: Number(activeSessCnt?.cnt || 0),
    },
  });
});

router.post('/admin/backup/verify', requireAuth, requirePermission('admin.user.manage', 'admin.backup.manage'), async (req: AuthRequest, res: Response) => {
  const cfg = getDbConfigSummary();
  const chain = await verifyAuditChain();
  let integrityOk = true;
  let integrityDetail = 'MySQL InnoDB engine active';
  if (cfg.dialect === 'sqlite') {
    const check = await queryOne<{ integrity_check?: string }>('PRAGMA integrity_check').catch(() => null);
    integrityOk = (check?.integrity_check || 'ok') === 'ok';
    integrityDetail = check?.integrity_check || 'ok';
  }
  const verifiedAt = nowSql();
  const entries: Array<[string, string]> = [
    ['last_backup_verified_at', verifiedAt],
    ['last_backup_verified_by', req.user!.fullName],
  ];
  for (const [k, v] of entries) {
    const existing = await queryOne('SELECT setting_key FROM system_settings WHERE setting_key = ?', [k]);
    if (existing) {
      await execute('UPDATE system_settings SET setting_value = ?, updated_by = ?, updated_at = ? WHERE setting_key = ?', [
        v,
        req.user!.id,
        verifiedAt,
        k,
      ]);
    } else {
      await execute('INSERT INTO system_settings (setting_key, setting_value, updated_by, updated_at) VALUES (?, ?, ?, ?)', [
        k,
        v,
        req.user!.id,
        verifiedAt,
      ]);
    }
  }
  await writeAuditLog({
    user: req.user,
    action: 'admin.backup.verify',
    entityType: 'system',
    entityId: cfg.dialect,
    after: { integrityOk, integrityDetail, auditChainValid: chain.valid, auditRows: chain.totalRows, verifiedAt },
    req,
  });
  res.json({ ok: true, verifiedAt, integrityOk, integrityDetail, auditChain: chain });
});

router.get('/audit-logs', requireAuth, requirePermission('audit.read'), async (req: AuthRequest, res: Response) => {
  const actionFilter = req.query.action ? String(req.query.action).trim() : '';
  const entityType = req.query.entity_type ? String(req.query.entity_type).trim() : '';
  const userId = req.query.user_id ? Number(req.query.user_id) : null;
  const fromDate = req.query.from ? String(req.query.from).slice(0, 10) : '';
  const toDate = req.query.to ? String(req.query.to).slice(0, 10) : '';
  const limit = Math.min(250, Math.max(10, Number(req.query.limit || 120)));
  const offset = Math.max(0, Number(req.query.offset || 0));

  let sql = 'SELECT * FROM audit_logs WHERE 1=1';
  const params: unknown[] = [];
  if (actionFilter) {
    sql += ' AND (action LIKE ? OR user_name LIKE ? OR entity_type LIKE ?)';
    const like = `%${actionFilter}%`;
    params.push(like, like, like);
  }
  if (entityType) {
    sql += ' AND entity_type = ?';
    params.push(entityType);
  }
  if (userId) {
    sql += ' AND user_id = ?';
    params.push(userId);
  }
  if (fromDate) {
    sql += ' AND occurred_at >= ?';
    params.push(`${fromDate} 00:00:00`);
  }
  if (toDate) {
    sql += ' AND occurred_at <= ?';
    params.push(`${toDate} 23:59:59`);
  }
  sql += ' ORDER BY id DESC LIMIT ? OFFSET ?';
  const logs = await query(sql, [...params, limit, offset]);

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

router.get('/audit-logs/export', requireAuth, requirePermission('audit.read'), async (req: AuthRequest, res: Response) => {
  const fromDate = req.query.from ? String(req.query.from).slice(0, 10) : '2020-01-01';
  const toDate = req.query.to ? String(req.query.to).slice(0, 10) : '2099-12-31';
  const rows = await query<{
    id: number;
    occurred_at: string;
    user_name: string;
    role_at_time: string;
    action: string;
    entity_type: string;
    entity_id: string | null;
    patient_id: number | null;
    reason: string | null;
    ip_address: string | null;
    row_hash: string;
  }>(
    `SELECT id, occurred_at, user_name, role_at_time, action, entity_type, entity_id, patient_id, reason, ip_address, row_hash
     FROM audit_logs
     WHERE occurred_at BETWEEN ? AND ?
     ORDER BY id ASC LIMIT 5000`,
    [`${fromDate} 00:00:00`, `${toDate} 23:59:59`]
  );

  const csvCell = (val: unknown) => {
    const str = String(val ?? '');
    return `"${str.replace(/"/g, '""')}"`;
  };
  const header = ['id', 'occurred_at', 'user_name', 'role_at_time', 'action', 'entity_type', 'entity_id', 'patient_id', 'reason', 'ip_address', 'row_hash'].join(',');
  const lines = rows.map((r) =>
    [r.id, r.occurred_at, r.user_name, r.role_at_time, r.action, r.entity_type, r.entity_id, r.patient_id, r.reason, r.ip_address, r.row_hash]
      .map(csvCell)
      .join(',')
  );

  await writeAuditLog({
    user: req.user,
    action: 'audit.log.exported',
    entityType: 'audit_log',
    after: { fromDate, toDate, rowCount: rows.length },
    req,
  });

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="clinic360-audit-${fromDate}-to-${toDate}.csv"`);
  res.send([header, ...lines].join('\n'));
});

router.get('/audit-logs/exceptions', requireAuth, auditAction({ action: 'audit.exceptions.viewed', entityType: 'audit_log', dedupeIfAudited: true }), requirePermission('audit.read'), async (req: AuthRequest, res: Response) => {
  const exceptions = await query(
    `SELECT * FROM audit_logs
     WHERE action IN (
       'auth.login.failed', 'auth.login.blocked_hr_offboarded', 'auth.2fa.failed', 'auth.password.changed', 'auth.password.reset_completed',
       'security.access_denied', 'security.department_scope_denied', 'security.doctor_assignment_denied',
       'security.segregation_violation_blocked', 'security.break_glass.access',
       'hr.employee.terminated', 'hr.employee.resigned', 'hr.employee.inactive', 'hr.employee.rehired_pending_admin_review',
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
// FULL ACCOUNTING LEDGER (CoA, Journals, Reversals, Periods, AR/AP, Expenses)
// ---------------------------------------------------------------------------
router.get(
  '/accounting/overview',
  requireAuth,
  requirePermission(
    'finance.report.view',
    'accounting.ledger.manage',
    'accounting.expense.create',
    'accounting.expense.approve',
    'finance.coa.manage',
    'finance.payroll.generate',
    'finance.payment.manage',
    'finance.receipt.manage',
    'finance.bank.manage',
    'finance.grv.manage'
  ),
  async (_req, res) => {
    const [
      accounts,
      journals,
      journalLines,
      supplierBills,
      expenseVouchers,
      insuranceClaims,
      creditInvoices,
      periods,
      settings,
      payrollComponents,
      cashBankAccounts,
      cashBankTransfers,
      financePayments,
      financeReceipts,
      grvs,
      approvedHrSubmissions,
      payrollRuns,
      payrollItems,
      hrEmployees,
      storeItems,
    ] = await Promise.all([
      query<{
        id: number;
        code: string;
        name: string;
        account_type: string;
        normal_balance: string;
        active: number;
        parent_id: number | null;
        description: string | null;
        tx_count: number;
      }>(
        `SELECT coa.*,
                (SELECT COUNT(*) FROM journal_lines jl WHERE jl.account_id = coa.id) +
                (SELECT COUNT(*) FROM expense_vouchers ev WHERE ev.account_id = coa.id) +
                (SELECT COUNT(*) FROM chart_of_accounts ch WHERE ch.parent_id = coa.id) AS tx_count
         FROM chart_of_accounts coa
         ORDER BY coa.code ASC`
      ),
      query<Record<string, unknown>>(
        `SELECT je.*, u.full_name AS posted_by_name
         FROM journal_entries je
         LEFT JOIN users u ON u.id = je.posted_by
         ORDER BY je.id DESC LIMIT 100`
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
         ORDER BY sb.id DESC LIMIT 60`
      ),
      query<Record<string, unknown>>(
        `SELECT ev.*, coa.code AS account_code, coa.name AS account_name,
                u1.full_name AS requested_by_name, u2.full_name AS approved_by_name,
                je.entry_number AS journal_entry_number,
                cba.account_name AS cash_bank_account_name
         FROM expense_vouchers ev
         INNER JOIN chart_of_accounts coa ON coa.id = ev.account_id
         LEFT JOIN users u1 ON u1.id = ev.requested_by
         LEFT JOIN users u2 ON u2.id = ev.approved_by
         LEFT JOIN journal_entries je ON je.source_type = 'expense' AND je.source_id = ev.id
         LEFT JOIN finance_cash_bank_accounts cba ON cba.id = ev.cash_bank_account_id
         ORDER BY ev.id DESC LIMIT 80`
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
      query(
        `SELECT ap.*, u.full_name AS closed_by_name
         FROM accounting_periods ap
         LEFT JOIN users u ON u.id = ap.closed_by
         ORDER BY ap.period_code DESC LIMIT 24`
      ),
      getClinicSettings(),
      query('SELECT * FROM payroll_components ORDER BY component_type ASC, code ASC'),
      query('SELECT * FROM finance_cash_bank_accounts ORDER BY account_type ASC, id ASC'),
      query(
        `SELECT t.*, f.account_name AS from_account_name, toAcc.account_name AS to_account_name,
                u.full_name AS created_by_name, je.entry_number AS journal_entry_number
         FROM finance_cash_bank_transfers t
         INNER JOIN finance_cash_bank_accounts f ON f.id = t.from_account_id
         INNER JOIN finance_cash_bank_accounts toAcc ON toAcc.id = t.to_account_id
         LEFT JOIN users u ON u.id = t.created_by
         LEFT JOIN journal_entries je ON je.id = t.journal_entry_id
         ORDER BY t.id DESC LIMIT 60`
      ),
      query(
        `SELECT fp.*, cba.account_name AS cash_bank_account_name, u.full_name AS created_by_name,
                je.entry_number AS journal_entry_number
         FROM finance_payments fp
         INNER JOIN finance_cash_bank_accounts cba ON cba.id = fp.cash_bank_account_id
         LEFT JOIN users u ON u.id = fp.created_by
         LEFT JOIN journal_entries je ON je.id = fp.journal_entry_id
         ORDER BY fp.id DESC LIMIT 100`
      ),
      query(
        `SELECT fr.*, cba.account_name AS cash_bank_account_name, u.full_name AS created_by_name,
                je.entry_number AS journal_entry_number
         FROM finance_receipts fr
         INNER JOIN finance_cash_bank_accounts cba ON cba.id = fr.cash_bank_account_id
         LEFT JOIN users u ON u.id = fr.created_by
         LEFT JOIN journal_entries je ON je.id = fr.journal_entry_id
         ORDER BY fr.id DESC LIMIT 100`
      ),
      query<Record<string, unknown>>(
        `SELECT gr.*, u1.full_name AS received_by_name, u2.full_name AS approved_by_name,
                sb.bill_number, sb.status AS bill_status, sb.paid_amount AS bill_paid_amount
         FROM goods_receipts gr
         LEFT JOIN users u1 ON u1.id = gr.received_by
         LEFT JOIN users u2 ON u2.id = gr.approved_by
         LEFT JOIN supplier_bills sb ON sb.grn_id = gr.id
         ORDER BY gr.id DESC LIMIT 60`
      ),
      query(
        `SELECT hms.*, u.full_name AS submitted_by_name
         FROM hr_monthly_submissions hms
         LEFT JOIN users u ON u.id = hms.submitted_by
         ORDER BY hms.pay_month DESC LIMIT 24`
      ),
      query<Record<string, unknown>>(
        `SELECT pr.*, je.entry_number AS journal_entry_number, pje.entry_number AS payment_journal_entry_number,
                u.full_name AS created_by_name, uv.full_name AS verified_by_name,
                ua.full_name AS approved_by_name, up.full_name AS paid_by_name
         FROM payroll_runs pr
         LEFT JOIN journal_entries je ON je.id = pr.journal_entry_id
         LEFT JOIN journal_entries pje ON pje.id = pr.payment_journal_entry_id
         LEFT JOIN users u ON u.id = pr.created_by
         LEFT JOIN users uv ON uv.id = pr.verified_by
         LEFT JOIN users ua ON ua.id = pr.approved_by
         LEFT JOIN users up ON up.id = pr.paid_by
         ORDER BY pr.id DESC LIMIT 24`
      ),
      query<Record<string, unknown>>('SELECT * FROM payroll_items ORDER BY id ASC'),
      query(
        `SELECT id, employee_number, full_name, department_name, job_position, basic_salary, housing_allowance, status
         FROM hr_employees
         WHERE status = 'active'
         ORDER BY employee_number ASC`
      ),
      query('SELECT id, code, name, category, unit, unit_cost FROM store_items ORDER BY name ASC'),
    ]);

    const acctById = new Map(accounts.map((a) => [a.id, a]));
    const enrichedAccounts = accounts.map((a) => {
      const parent = a.parent_id ? acctById.get(a.parent_id) : null;
      return {
        ...a,
        parent_code: parent?.code || null,
        parent_name: parent?.name || null,
      };
    });

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

    const trialBalance = enrichedAccounts.map((a) => {
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
    const currentNetIncome = Number((totalRevenue - totalExpenses).toFixed(2));

    const assets = trialBalance.filter((a) => a.account_type === 'asset' && a.net_balance !== 0);
    const liabilities = trialBalance.filter((a) => a.account_type === 'liability' && a.net_balance !== 0);
    const equity = trialBalance.filter((a) => a.account_type === 'equity' && a.net_balance !== 0);
    const totalAssets = Number(assets.reduce((s, a) => s + a.net_balance, 0).toFixed(2));
    const totalLiabilities = Number(liabilities.reduce((s, l) => s + l.net_balance, 0).toFixed(2));
    const equityAccountsTotal = Number(equity.reduce((s, eq) => s + eq.net_balance, 0).toFixed(2));
    const totalEquity = Number((equityAccountsTotal + currentNetIncome).toFixed(2));
    const totalLiabilitiesAndEquity = Number((totalLiabilities + totalEquity).toFixed(2));

    const itemsByRun = new Map<number, Record<string, unknown>[]>();
    for (const pi of payrollItems) {
      const k = Number(pi.payroll_run_id);
      if (!itemsByRun.has(k)) itemsByRun.set(k, []);
      itemsByRun.get(k)!.push(pi);
    }
    for (const run of payrollRuns) {
      run.items = itemsByRun.get(Number(run.id)) || [];
    }

    const grnItemsRaw = await query<{ grn_id: number; name: string; quantity: number; batch_number: string; expiry_date: string; unit_cost: number }>(
      `SELECT gi.grn_id, si.name, gi.quantity, gi.batch_number, gi.expiry_date, gi.unit_cost
       FROM grn_items gi
       INNER JOIN store_items si ON si.id = gi.item_id
       ORDER BY gi.id ASC`
    );
    const itemsByGrn = new Map<number, string[]>();
    for (const gi of grnItemsRaw) {
      const gid = Number(gi.grn_id);
      if (!itemsByGrn.has(gid)) itemsByGrn.set(gid, []);
      itemsByGrn.get(gid)!.push(`${gi.name} (${gi.quantity} × $${Number(gi.unit_cost).toFixed(2)})`);
    }
    for (const g of grvs as Array<Record<string, unknown>>) {
      g.items_summary = (itemsByGrn.get(Number(g.id)) || []).join(', ');
    }

    const nowMs = Date.now();
    for (const clm of insuranceClaims) {
      const subMs = new Date(String(clm.submitted_at)).getTime();
      const ageDays = Math.max(0, Math.floor((nowMs - subMs) / 86400000));
      clm.age_days = ageDays;
      clm.age_bucket = ageDays <= 30 ? '0-30d' : ageDays <= 60 ? '31-60d' : ageDays <= 90 ? '61-90d' : '90+d';
    }

    res.json({
      accounts: enrichedAccounts,
      journals,
      trialBalance,
      incomeStatement: {
        revenues,
        expenses,
        totalRevenue,
        totalExpenses,
        netIncome: currentNetIncome,
      },
      balanceSheet: {
        assets,
        liabilities,
        equity,
        currentNetIncome,
        totalAssets,
        totalLiabilities,
        totalEquity,
        totalLiabilitiesAndEquity,
        balanced: Math.abs(totalAssets - totalLiabilitiesAndEquity) < 0.05,
      },
      supplierBills,
      expenseVouchers,
      insuranceClaims,
      unclaimedCreditInvoices: creditInvoices,
      periods,
      expenseAutoPostLimit: settings.expenseAutoPostLimit,
      payrollComponents,
      cashBankAccounts,
      cashBankTransfers,
      financePayments,
      financeReceipts,
      grvs,
      approvedHrSubmissions,
      payrollRuns,
      hrEmployees,
      storeItems,
    });
  }
);

router.post('/accounting/accounts', requireAuth, requirePermission('finance.coa.manage', 'accounting.ledger.manage'), async (req: AuthRequest, res: Response) => {
  const { code, name, account_type, normal_balance, parent_id, description } = req.body || {};
  const cleanCode = String(code || '').trim();
  const cleanName = String(name || '').trim();
  if (!cleanCode || !cleanName || !['asset', 'liability', 'equity', 'revenue', 'expense'].includes(String(account_type))) {
    return res.status(400).json({ error: 'Valid account code, name, and category (asset/liability/equity/revenue/expense) are required.' });
  }
  const dup = await queryOne('SELECT id FROM chart_of_accounts WHERE code = ?', [cleanCode]);
  if (dup) return res.status(409).json({ error: `Account code ${cleanCode} already exists.` });
  const normal =
    normal_balance && ['debit', 'credit'].includes(String(normal_balance))
      ? String(normal_balance)
      : ['asset', 'expense'].includes(String(account_type))
        ? 'debit'
        : 'credit';

  const ins = await execute(
    'INSERT INTO chart_of_accounts (code, name, account_type, normal_balance, parent_id, description, active) VALUES (?, ?, ?, ?, ?, ?, 1)',
    [cleanCode, cleanName, account_type, normal, parent_id ? Number(parent_id) : null, description?.trim() || null]
  );
  await writeAuditLog({
    user: req.user,
    action: 'finance.coa.create',
    entityType: 'chart_of_account',
    entityId: ins.insertId,
    after: { code: cleanCode, name: cleanName, account_type, normal_balance: normal, parent_id: parent_id || null },
    req,
  });
  res.status(201).json({ id: ins.insertId, code: cleanCode });
});

router.put('/accounting/accounts/:id', requireAuth, requirePermission('finance.coa.manage', 'accounting.ledger.manage'), async (req: AuthRequest, res: Response) => {
  const id = Number(req.params.id);
  const acct = await queryOne<{ id: number; code: string; name: string }>('SELECT id, code, name FROM chart_of_accounts WHERE id = ?', [id]);
  if (!acct) return res.status(404).json({ error: 'Account not found.' });
  const { name, account_type, normal_balance, parent_id, description, active } = req.body || {};
  if (parent_id && Number(parent_id) === id) {
    return res.status(400).json({ error: 'Account cannot be its own parent.' });
  }
  await execute(
    `UPDATE chart_of_accounts
     SET name = COALESCE(?, name),
         account_type = COALESCE(?, account_type),
         normal_balance = COALESCE(?, normal_balance),
         parent_id = ?,
         description = COALESCE(?, description),
         active = COALESCE(?, active)
     WHERE id = ?`,
    [
      name?.trim() || null,
      account_type || null,
      normal_balance || null,
      parent_id !== undefined ? (parent_id ? Number(parent_id) : null) : null,
      description !== undefined ? (description?.trim() || null) : null,
      active !== undefined ? (active ? 1 : 0) : null,
      id,
    ]
  );
  await writeAuditLog({
    user: req.user,
    action: 'finance.coa.update',
    entityType: 'chart_of_account',
    entityId: id,
    after: { name, account_type, normal_balance, parent_id, active },
    req,
  });
  res.json({ ok: true });
});

router.patch('/accounting/accounts/:id/toggle', requireAuth, requirePermission('finance.coa.manage', 'accounting.ledger.manage'), async (req: AuthRequest, res: Response) => {
  const id = Number(req.params.id);
  const acct = await queryOne<{ id: number; code: string; active: number }>('SELECT id, code, active FROM chart_of_accounts WHERE id = ?', [id]);
  if (!acct) return res.status(404).json({ error: 'Account not found.' });
  const nextActive = acct.active ? 0 : 1;
  await execute('UPDATE chart_of_accounts SET active = ? WHERE id = ?', [nextActive, id]);
  await writeAuditLog({
    user: req.user,
    action: 'finance.coa.toggle',
    entityType: 'chart_of_account',
    entityId: id,
    after: { code: acct.code, active: nextActive },
    req,
  });
  res.json({ ok: true, active: nextActive });
});

router.delete('/accounting/accounts/:id', requireAuth, requirePermission('finance.coa.manage', 'accounting.ledger.manage'), async (req: AuthRequest, res: Response) => {
  const id = Number(req.params.id);
  const acct = await queryOne<{ id: number; code: string; name: string }>('SELECT id, code, name FROM chart_of_accounts WHERE id = ?', [id]);
  if (!acct) return res.status(404).json({ error: 'Account not found.' });

  const [jlCnt, evCnt, childCnt, cbCnt] = await Promise.all([
    queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM journal_lines WHERE account_id = ?', [id]),
    queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM expense_vouchers WHERE account_id = ?', [id]),
    queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM chart_of_accounts WHERE parent_id = ?', [id]),
    queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM finance_cash_bank_accounts WHERE coa_code = ?', [acct.code]),
  ]);
  if (Number(jlCnt?.cnt || 0) > 0 || Number(evCnt?.cnt || 0) > 0 || Number(childCnt?.cnt || 0) > 0 || Number(cbCnt?.cnt || 0) > 0) {
    return res.status(409).json({
      error: `Cannot delete account ${acct.code}: it is referenced by posted journals, expenses, cash/bank accounts, or child accounts. Deactivate it instead.`,
    });
  }

  await execute('DELETE FROM chart_of_accounts WHERE id = ?', [id]);
  await writeAuditLog({
    user: req.user,
    action: 'finance.coa.delete',
    entityType: 'chart_of_account',
    entityId: id,
    before: acct,
    req,
  });
  res.json({ ok: true });
});

router.post('/accounting/payroll-components', requireAuth, requirePermission('finance.payroll.generate', 'accounting.ledger.manage'), async (req: AuthRequest, res: Response) => {
  const { code, name, component_type, calc_method = 'fixed', default_value = 0, account_code = '5100', is_recurring = true, is_taxable = true, is_pensionable = false } = req.body || {};
  const cleanCode = String(code || '').trim().toUpperCase();
  const cleanName = String(name || '').trim();
  if (!cleanCode || !cleanName || !['earning', 'deduction'].includes(String(component_type))) {
    return res.status(400).json({ error: 'Code, name, and component_type (earning/deduction) are required.' });
  }
  const existing = await queryOne('SELECT id FROM payroll_components WHERE code = ?', [cleanCode]);
  if (existing) return res.status(409).json({ error: `Payroll component ${cleanCode} already exists.` });

  const ins = await execute(
    `INSERT INTO payroll_components (code, name, component_type, calc_method, default_value, account_code, is_recurring, is_taxable, is_pensionable, active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    [cleanCode, cleanName, component_type, calc_method, Number(default_value || 0), account_code, is_recurring ? 1 : 0, is_taxable ? 1 : 0, is_pensionable ? 1 : 0]
  );
  await writeAuditLog({
    user: req.user,
    action: 'finance.payroll_component.create',
    entityType: 'payroll_component',
    entityId: ins.insertId,
    after: { code: cleanCode, name: cleanName, component_type, account_code },
    req,
  });
  res.status(201).json({ id: ins.insertId });
});

router.put('/accounting/payroll-components/:id', requireAuth, requirePermission('finance.payroll.generate', 'accounting.ledger.manage'), async (req: AuthRequest, res: Response) => {
  const id = Number(req.params.id);
  const { name, calc_method, default_value, account_code, is_recurring, is_taxable, is_pensionable, active } = req.body || {};
  await execute(
    `UPDATE payroll_components
     SET name = COALESCE(?, name),
         calc_method = COALESCE(?, calc_method),
         default_value = COALESCE(?, default_value),
         account_code = COALESCE(?, account_code),
         is_recurring = COALESCE(?, is_recurring),
         is_taxable = COALESCE(?, is_taxable),
         is_pensionable = COALESCE(?, is_pensionable),
         active = COALESCE(?, active)
     WHERE id = ?`,
    [
      name?.trim() || null,
      calc_method || null,
      default_value !== undefined ? Number(default_value) : null,
      account_code || null,
      is_recurring !== undefined ? (is_recurring ? 1 : 0) : null,
      is_taxable !== undefined ? (is_taxable ? 1 : 0) : null,
      is_pensionable !== undefined ? (is_pensionable ? 1 : 0) : null,
      active !== undefined ? (active ? 1 : 0) : null,
      id,
    ]
  );
  res.json({ ok: true });
});

router.post('/accounting/periods/close', requireAuth, requirePermission('accounting.period.manage'), async (req: AuthRequest, res: Response) => {
  const periodCode = String(req.body?.period_code || '').trim();
  if (!/^\d{4}-\d{2}$/.test(periodCode)) {
    return res.status(400).json({ error: 'period_code must be formatted as YYYY-MM.' });
  }
  const [yr, mo] = periodCode.split('-').map(Number);
  const startDate = `${periodCode}-01`;
  const endDate = new Date(Date.UTC(yr, mo, 0)).toISOString().slice(0, 10);

  const existing = await queryOne<{ id: number; status: string }>('SELECT id, status FROM accounting_periods WHERE period_code = ?', [periodCode]);
  if (existing?.status === 'closed') {
    return res.status(409).json({ error: `Accounting period ${periodCode} is already closed.` });
  }

  if (existing) {
    await execute("UPDATE accounting_periods SET status = 'closed', closed_by = ?, closed_at = ? WHERE id = ?", [
      req.user!.id,
      nowSql(),
      existing.id,
    ]);
  } else {
    await execute(
      "INSERT INTO accounting_periods (period_code, start_date, end_date, status, closed_by, closed_at) VALUES (?, ?, ?, 'closed', ?, ?)",
      [periodCode, startDate, endDate, req.user!.id, nowSql()]
    );
  }

  await writeAuditLog({
    user: req.user,
    action: 'accounting.period.close',
    entityType: 'accounting_period',
    entityId: periodCode,
    after: { periodCode, startDate, endDate },
    req,
  });

  res.json({ ok: true, periodCode, status: 'closed' });
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
    broadcastClinicEvent('finance:updated', { type: 'journal', entryNumber: posted.entryNumber });
    res.status(201).json(posted);
  } catch (err) {
    const status = (err as Error & { status?: number }).status || 400;
    res.status(status).json({ error: (err as Error).message });
  }
});

router.post('/accounting/journals/:id/reverse', requireAuth, requirePermission('accounting.journal.reverse', 'accounting.ledger.manage'), async (req: AuthRequest, res: Response) => {
  const origId = Number(req.params.id);
  const reason = String(req.body?.reason || '').trim();
  if (reason.length < 5) {
    return res.status(400).json({ error: 'A formal reversal reason (minimum 5 characters) is required.' });
  }

  const result = await withTransaction(async () => {
    const orig = await queryOne<{
      id: number;
      entry_number: string;
      entry_date: string;
      description: string;
      reversal_of_id: number | null;
    }>('SELECT * FROM journal_entries WHERE id = ?', [origId]);
    if (!orig) return { ok: false as const, error: 'Journal entry not found.', httpStatus: 404 };
    if (orig.reversal_of_id) {
      return { ok: false as const, error: 'Cannot reverse an entry that is already a reversal.', httpStatus: 409 };
    }
    const alreadyReversed = await queryOne<{ entry_number: string }>(
      'SELECT entry_number FROM journal_entries WHERE reversal_of_id = ?',
      [origId]
    );
    if (alreadyReversed) {
      return { ok: false as const, error: `Journal entry already reversed by ${alreadyReversed.entry_number}.`, httpStatus: 409 };
    }

    const origLines = await query<{ code: string; debit: number; credit: number; memo: string | null }>(
      `SELECT coa.code, jl.debit, jl.credit, jl.memo
       FROM journal_lines jl
       INNER JOIN chart_of_accounts coa ON coa.id = jl.account_id
       WHERE jl.entry_id = ?`,
      [origId]
    );

    const revJe = await postJournalEntry({
      sourceType: 'reversal',
      sourceId: origId,
      reversalOfId: origId,
      description: `Reversal of ${orig.entry_number}: ${reason}`,
      postedBy: req.user!.id,
      lines: origLines.map((ln) => ({
        accountCode: ln.code,
        debit: Number(ln.credit || 0),
        credit: Number(ln.debit || 0),
        memo: `Reverse ${orig.entry_number}${ln.memo ? ` · ${ln.memo}` : ''}`,
      })),
    });

    await writeAuditLog({
      user: req.user,
      action: 'accounting.journal.reverse',
      entityType: 'journal_entry',
      entityId: revJe.entryId,
      reason,
      after: { reversedEntryId: origId, reversedEntryNumber: orig.entry_number, reversalEntryNumber: revJe.entryNumber },
      req,
    });
    return { ok: true as const, ...revJe };
  });

  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error });
  broadcastClinicEvent('finance:updated', { type: 'journal_reversal', entryId: result.entryId });
  res.status(201).json(result);
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
      `INSERT INTO insurance_claims (claim_number, payer_name, invoice_id, patient_id, billed_amount, settled_amount, status, submitted_at, notes)
       VALUES (?, ?, ?, ?, ?, 0, 'submitted', ?, ?)`,
      [claimNumber, inv.payer_name || 'Insurance Payer', inv.id, inv.patient_id, Number(inv.total_amount), nowSql(), notes || null]
    );

    const alreadyRecognized = await hasInvoiceAccrualJE(inv.id);
    if (!alreadyRecognized && Number(inv.total_amount) > 0) {
      const revLines = await buildPerLineRevenueLines(inv.id, Number(inv.total_amount), 'credit', inv.invoice_number);
      await postJournalEntry({
        sourceType: 'ar_claim',
        sourceId: clmRes.insertId,
        description: `Insurance claim ${claimNumber} (${inv.invoice_number})`,
        postedBy: req.user!.id,
        lines: [{ accountCode: '1100', debit: Number(inv.total_amount), memo: claimNumber }, ...revLines],
      });
    }

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

    await execute('UPDATE insurance_claims SET settled_amount = ?, status = ?, settled_at = ?, notes = COALESCE(?, notes) WHERE id = ?', [
      nextSettled,
      nextStatus,
      nowSql(),
      notes || null,
      claimId,
    ]);

    await execute(
      "UPDATE invoices SET paid_amount = paid_amount + ?, status = CASE WHEN paid_amount + ? >= total_amount - 0.01 THEN 'paid' ELSE 'partial' END WHERE id = ?",
      [apply, apply, clm.invoice_id]
    );

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
    reference_number,
    attachment_ref,
    cash_bank_account_id,
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

  const settings = await getClinicSettings();
  const voucherDate = expense_date ? String(expense_date).slice(0, 10) : await getClinicToday();
  try {
    await assertOpenAccountingPeriod(voucherDate);
  } catch (err) {
    return res.status((err as Error & { status?: number }).status || 409).json({ error: (err as Error).message });
  }

  let cbAcct: { id: number; coa_code: string; account_name: string } | null = null;
  if (cash_bank_account_id) {
    cbAcct = await queryOne<{ id: number; coa_code: string; account_name: string }>(
      'SELECT id, coa_code, account_name FROM finance_cash_bank_accounts WHERE id = ? AND active = 1',
      [Number(cash_bank_account_id)]
    );
  } else {
    const targetCoa = payment_method === 'cash' ? '1010' : '1020';
    cbAcct = await queryOne<{ id: number; coa_code: string; account_name: string }>(
      'SELECT id, coa_code, account_name FROM finance_cash_bank_accounts WHERE coa_code = ? AND active = 1 ORDER BY id ASC LIMIT 1',
      [targetCoa]
    );
  }

  const canApproveOwnUnderLimit = amt <= settings.expenseAutoPostLimit && hasPermission(req.user!, 'accounting.ledger.manage');
  const hasExplicitApprove = hasPermission(req.user!, 'accounting.expense.approve');
  const shouldAutoPost = auto_post !== false && (canApproveOwnUnderLimit || (hasExplicitApprove && amt <= settings.expenseAutoPostLimit));

  const created = await withTransaction(async () => {
    const voucherNumber = await nextSequence('EXP');
    const status = shouldAutoPost ? 'paid' : 'pending';
    const inserted = await execute(
      `INSERT INTO expense_vouchers (voucher_number, expense_date, category, account_id, payee_name, amount, paid_amount, payment_method, cash_bank_account_id, reference_number, attachment_ref, description, status, requested_by, approved_by, paid_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        voucherNumber,
        voucherDate,
        category.trim(),
        acct.id,
        payee_name.trim(),
        amt,
        shouldAutoPost ? amt : 0,
        payment_method,
        cbAcct?.id || null,
        reference_number?.trim() || null,
        attachment_ref?.trim() || null,
        description.trim(),
        status,
        req.user!.id,
        shouldAutoPost ? req.user!.id : null,
        shouldAutoPost ? nowSql() : null,
      ]
    );

    let entryNumber: string | null = null;
    let journalEntryId: number | null = null;
    if (shouldAutoPost) {
      const creditCode = cbAcct?.coa_code || (payment_method === 'cash' ? '1010' : '1020');
      const je = await postJournalEntry({
        entryDate: voucherDate,
        sourceType: 'expense',
        sourceId: inserted.insertId,
        description: `Expense ${voucherNumber}: ${payee_name.trim()} (${category.trim()})`,
        postedBy: req.user!.id,
        lines: [
          { accountCode: acct.code, debit: amt, memo: description.trim() },
          {
            accountCode: creditCode,
            credit: amt,
            memo: `${voucherNumber} · ${cbAcct?.account_name || (payment_method === 'cash' ? 'Petty Cash' : 'Operating Bank')}`,
          },
        ],
      });
      entryNumber = je.entryNumber;
      journalEntryId = je.entryId;

      if (cbAcct) {
        await execute('UPDATE finance_cash_bank_accounts SET current_balance = ROUND(current_balance - ?, 2) WHERE id = ?', [amt, cbAcct.id]);
        const fpNum = await nextSequence('FPV');
        await execute(
          `INSERT INTO finance_payments (payment_number, payment_date, payment_category, payee_name, cash_bank_account_id, payment_method, amount, reference_no, attachment_ref, linked_type, linked_id, notes, journal_entry_id, created_by)
           VALUES (?, ?, 'expense', ?, ?, ?, ?, ?, ?, 'expense', ?, ?, ?, ?)`,
          [fpNum, voucherDate, payee_name.trim(), cbAcct.id, payment_method, amt, reference_number?.trim() || voucherNumber, attachment_ref?.trim() || null, inserted.insertId, description.trim(), je.entryId, req.user!.id]
        );
      }
    } else {
      await createNotification({
        targetRole: 'MGR',
        title: 'Expense Voucher Pending Approval',
        message: `${voucherNumber} for ${settings.currencySymbol}${amt.toFixed(2)} (${payee_name.trim()}) requires approval.`,
        severity: 'warning',
        entityType: 'expense_voucher',
        entityId: inserted.insertId,
      });
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

  broadcastClinicEvent('finance:updated', { type: 'expense', voucherNumber: created.voucherNumber });
  res.status(201).json(created);
});

router.post('/accounting/expenses/:id/decide', requireAuth, requirePermission('accounting.expense.approve', 'accounting.ledger.manage'), async (req: AuthRequest, res: Response) => {
  const id = Number(req.params.id);
  const { decision, cash_bank_account_id } = req.body || {};
  if (!['approved', 'paid', 'rejected'].includes(decision)) {
    return res.status(400).json({ error: 'Decision must be approved, paid (approve & pay immediately), or rejected.' });
  }

  const result = await withTransaction(async () => {
    const ev = await queryOne<{
      id: number;
      voucher_number: string;
      expense_date: string;
      payee_name: string;
      amount: number;
      payment_method: string;
      cash_bank_account_id: number | null;
      reference_number: string | null;
      attachment_ref: string | null;
      description: string;
      status: string;
      requested_by: number;
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
    assertDifferentUser(req.user!.id, ev.requested_by, 'approve or reject an expense voucher you created');

    await assertOpenAccountingPeriod(ev.expense_date || (await getClinicToday()));

    let entryNumber: string | null = null;
    if (decision === 'rejected') {
      await execute("UPDATE expense_vouchers SET status = 'rejected', approved_by = ? WHERE id = ?", [req.user!.id, id]);
    } else if (decision === 'approved') {
      const je = await postJournalEntry({
        entryDate: ev.expense_date,
        sourceType: 'expense',
        sourceId: id,
        description: `Approved Expense Payable ${ev.voucher_number}: ${ev.payee_name}`,
        postedBy: req.user!.id,
        lines: [
          { accountCode: ev.account_code, debit: Number(ev.amount), memo: ev.description },
          { accountCode: '2100', credit: Number(ev.amount), memo: `${ev.voucher_number} payable` },
        ],
      });
      entryNumber = je.entryNumber;
      await execute("UPDATE expense_vouchers SET status = 'approved', approved_by = ? WHERE id = ?", [req.user!.id, id]);
    } else {
      const cbId = cash_bank_account_id ? Number(cash_bank_account_id) : ev.cash_bank_account_id;
      let cbAcct = cbId
        ? await queryOne<{ id: number; coa_code: string; account_name: string }>('SELECT id, coa_code, account_name FROM finance_cash_bank_accounts WHERE id = ? AND active = 1', [cbId])
        : null;
      if (!cbAcct) {
        cbAcct = await queryOne<{ id: number; coa_code: string; account_name: string }>(
          'SELECT id, coa_code, account_name FROM finance_cash_bank_accounts WHERE coa_code = ? AND active = 1 ORDER BY id ASC LIMIT 1',
          [ev.payment_method === 'cash' ? '1010' : '1020']
        );
      }
      const creditCode = cbAcct?.coa_code || (ev.payment_method === 'cash' ? '1010' : '1020');
      const je = await postJournalEntry({
        entryDate: ev.expense_date,
        sourceType: 'expense',
        sourceId: id,
        description: `Expense ${ev.voucher_number}: ${ev.payee_name}`,
        postedBy: req.user!.id,
        lines: [
          { accountCode: ev.account_code, debit: Number(ev.amount), memo: ev.description },
          { accountCode: creditCode, credit: Number(ev.amount), memo: ev.voucher_number },
        ],
      });
      entryNumber = je.entryNumber;
      await execute("UPDATE expense_vouchers SET status = 'paid', paid_amount = ?, cash_bank_account_id = ?, approved_by = ?, paid_at = ? WHERE id = ?", [
        Number(ev.amount),
        cbAcct?.id || null,
        req.user!.id,
        nowSql(),
        id,
      ]);
      if (cbAcct) {
        await execute('UPDATE finance_cash_bank_accounts SET current_balance = ROUND(current_balance - ?, 2) WHERE id = ?', [Number(ev.amount), cbAcct.id]);
        const fpNum = await nextSequence('FPV');
        await execute(
          `INSERT INTO finance_payments (payment_number, payment_date, payment_category, payee_name, cash_bank_account_id, payment_method, amount, reference_no, attachment_ref, linked_type, linked_id, notes, journal_entry_id, created_by)
           VALUES (?, ?, 'expense', ?, ?, ?, ?, ?, ?, 'expense', ?, ?, ?, ?)`,
          [fpNum, ev.expense_date, ev.payee_name, cbAcct.id, ev.payment_method, Number(ev.amount), ev.reference_number || ev.voucher_number, ev.attachment_ref, id, ev.description, je.entryId, req.user!.id]
        );
      }
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
  broadcastClinicEvent('finance:updated', { type: 'expense_decide', id });
  res.json(result);
});

router.post('/accounting/expenses/:id/pay', requireAuth, requirePermission('finance.payment.manage', 'accounting.ledger.manage'), async (req: AuthRequest, res: Response) => {
  const id = Number(req.params.id);
  const { amount, cash_bank_account_id, payment_method = 'bank_transfer', payment_date, reference_no, notes } = req.body || {};
  const payAmt = Number(Number(amount || 0).toFixed(2));
  if (payAmt <= 0) return res.status(400).json({ error: 'Positive payment amount is required.' });
  const payDate = payment_date ? String(payment_date).slice(0, 10) : await getClinicToday();

  const result = await withTransaction(async () => {
    await assertOpenAccountingPeriod(payDate);
    const ev = await queryOne<{
      id: number;
      voucher_number: string;
      payee_name: string;
      amount: number;
      paid_amount: number;
      status: string;
      description: string;
    }>('SELECT * FROM expense_vouchers WHERE id = ?', [id]);
    if (!ev) return { ok: false as const, error: 'Expense voucher not found.', httpStatus: 404 };
    if (!['approved', 'partial'].includes(ev.status)) {
      return { ok: false as const, error: `Expense voucher must be approved before disbursement (current: ${ev.status}).`, httpStatus: 409 };
    }
    const remaining = Number((Number(ev.amount) - Number(ev.paid_amount || 0)).toFixed(2));
    if (remaining <= 0) return { ok: false as const, error: 'Expense voucher is already fully paid.', httpStatus: 409 };
    const actualPay = Math.min(payAmt, remaining);

    let cbAcct = cash_bank_account_id
      ? await queryOne<{ id: number; coa_code: string; account_name: string }>('SELECT id, coa_code, account_name FROM finance_cash_bank_accounts WHERE id = ? AND active = 1', [Number(cash_bank_account_id)])
      : null;
    if (!cbAcct) {
      cbAcct = await queryOne<{ id: number; coa_code: string; account_name: string }>(
        'SELECT id, coa_code, account_name FROM finance_cash_bank_accounts WHERE coa_code = ? AND active = 1 ORDER BY id ASC LIMIT 1',
        [payment_method === 'cash' ? '1010' : '1020']
      );
    }
    if (!cbAcct) return { ok: false as const, error: 'Active Cash/Bank account not found.', httpStatus: 400 };

    const nextPaid = Number((Number(ev.paid_amount || 0) + actualPay).toFixed(2));
    const nextStatus = nextPaid >= Number(ev.amount) - 0.01 ? 'paid' : 'partial';

    const je = await postJournalEntry({
      entryDate: payDate,
      sourceType: 'expense_payment',
      sourceId: id,
      description: `Expense Disbursement ${ev.voucher_number} (${ev.payee_name})`,
      postedBy: req.user!.id,
      lines: [
        { accountCode: '2100', debit: actualPay, memo: `Settle ${ev.voucher_number}` },
        { accountCode: cbAcct.coa_code, credit: actualPay, memo: cbAcct.account_name },
      ],
    });

    await execute('UPDATE expense_vouchers SET paid_amount = ?, status = ?, cash_bank_account_id = ?, paid_at = ? WHERE id = ?', [
      nextPaid,
      nextStatus,
      cbAcct.id,
      nowSql(),
      id,
    ]);
    await execute('UPDATE finance_cash_bank_accounts SET current_balance = ROUND(current_balance - ?, 2) WHERE id = ?', [actualPay, cbAcct.id]);

    const fpNum = await nextSequence('FPV');
    await execute(
      `INSERT INTO finance_payments (payment_number, payment_date, payment_category, payee_name, cash_bank_account_id, payment_method, amount, reference_no, linked_type, linked_id, notes, journal_entry_id, created_by)
       VALUES (?, ?, 'expense', ?, ?, ?, ?, ?, 'expense', ?, ?, ?, ?)`,
      [fpNum, payDate, ev.payee_name, cbAcct.id, payment_method, actualPay, reference_no?.trim() || ev.voucher_number, id, notes?.trim() || ev.description, je.entryId, req.user!.id]
    );

    await writeAuditLog({
      user: req.user,
      action: 'accounting.expense.pay',
      entityType: 'expense_voucher',
      entityId: id,
      after: { voucherNumber: ev.voucher_number, paid: actualPay, status: nextStatus, paymentNumber: fpNum, entryNumber: je.entryNumber },
      req,
    });
    return { ok: true as const, paid: actualPay, status: nextStatus, paymentNumber: fpNum, entryNumber: je.entryNumber };
  });

  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error });
  broadcastClinicEvent('finance:updated', { type: 'expense_pay', id });
  res.json(result);
});

router.post('/accounting/grvs', requireAuth, requirePermission('finance.grv.manage', 'accounting.ledger.manage'), async (req: AuthRequest, res: Response) => {
  const {
    supplier_name,
    invoice_ref,
    delivery_date,
    received_date,
    department_name = 'Main Store',
    attachment_ref,
    notes,
    approve_immediately = true,
    item_id,
    new_item_name,
    new_item_category = 'consumable',
    batch_number,
    expiry_date,
    quantity,
    unit_cost,
  } = req.body || {};

  const qty = Number(quantity || 0);
  const cost = Number(unit_cost || 0);
  if (!supplier_name?.trim() || (!item_id && !new_item_name?.trim()) || !batch_number?.trim() || !expiry_date || qty <= 0 || cost < 0) {
    return res.status(400).json({ error: 'Supplier, item, batch number, expiry date, positive quantity, and valid unit cost are required.' });
  }
  const recDate = received_date ? String(received_date).slice(0, 10) : await getClinicToday();

  const result = await withTransaction(async () => {
    await assertOpenAccountingPeriod(recDate);

    if (invoice_ref?.trim()) {
      const dup = await queryOne<{ grn_number: string }>(
        'SELECT grn_number FROM goods_receipts WHERE LOWER(supplier_name) = LOWER(?) AND LOWER(invoice_ref) = LOWER(?) LIMIT 1',
        [supplier_name.trim(), invoice_ref.trim()]
      );
      if (dup) {
        return {
          ok: false as const,
          error: `Duplicate supplier invoice reference '${invoice_ref.trim()}' for ${supplier_name.trim()} (already in ${dup.grn_number}).`,
          httpStatus: 409,
        };
      }
    }

    let targetItem: { id: number; code: string; name: string } | null = null;
    if (item_id) {
      targetItem = await queryOne<{ id: number; code: string; name: string }>('SELECT id, code, name FROM store_items WHERE id = ?', [Number(item_id)]);
      if (!targetItem) return { ok: false as const, error: 'Store item not found.', httpStatus: 404 };
    } else {
      const genCode = `GRV-${Date.now().toString().slice(-5)}`;
      const itemIns = await execute(
        'INSERT INTO store_items (code, name, category, unit, reorder_level, unit_cost, selling_price) VALUES (?, ?, ?, ?, 10, ?, ?)',
        [genCode, new_item_name.trim(), ['medicine', 'reagent', 'consumable'].includes(new_item_category) ? new_item_category : 'consumable', 'Unit', cost, Number((cost * 1.3).toFixed(2))]
      );
      targetItem = { id: itemIns.insertId, code: genCode, name: new_item_name.trim() };
    }

    const grnNumber = await nextSequence('GRN');
    const totalCost = Number((qty * cost).toFixed(2));
    const appStatus = approve_immediately ? 'approved' : 'pending';

    const grnRes = await execute(
      `INSERT INTO goods_receipts (grn_number, supplier_name, invoice_ref, delivery_date, received_date, department_name, attachment_ref, approval_status, approved_by, approved_at, total_cost, notes, received_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        grnNumber,
        supplier_name.trim(),
        invoice_ref?.trim() || null,
        delivery_date || recDate,
        recDate,
        department_name.trim(),
        attachment_ref?.trim() || null,
        appStatus,
        approve_immediately ? req.user!.id : null,
        approve_immediately ? nowSql() : null,
        totalCost,
        notes?.trim() || null,
        req.user!.id,
      ]
    );

    await execute(
      'INSERT INTO grn_items (grn_id, item_id, batch_number, expiry_date, quantity, unit_cost) VALUES (?, ?, ?, ?, ?, ?)',
      [grnRes.insertId, targetItem.id, batch_number.trim(), expiry_date, qty, cost]
    );

    let billNumber: string | null = null;
    let entryNumber: string | null = null;
    if (approve_immediately) {
      const batchRes = await execute(
        "INSERT INTO stock_batches (item_id, location, batch_number, expiry_date, qty_on_hand, unit_cost, status) VALUES (?, 'main_store', ?, ?, ?, ?, 'active')",
        [targetItem.id, batch_number.trim(), expiry_date, qty, cost]
      );
      let jeId: number | null = null;
      if (totalCost > 0) {
        billNumber = await nextSequence('AP');
        const dueStr = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
        await execute(
          `INSERT INTO supplier_bills (bill_number, grn_id, supplier_name, invoice_ref, bill_date, due_date, total_amount, paid_amount, status, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'open', ?)`,
          [billNumber, grnRes.insertId, supplier_name.trim(), invoice_ref?.trim() || null, recDate, dueStr, totalCost, `Posted from GRV ${grnNumber}`]
        );
        const je = await postJournalEntry({
          entryDate: recDate,
          sourceType: 'grn',
          sourceId: grnRes.insertId,
          description: `Finance GRV ${grnNumber} (${supplier_name.trim()})`,
          postedBy: req.user!.id,
          lines: [
            { accountCode: '1200', debit: totalCost, memo: `${targetItem.code} x ${qty}` },
            { accountCode: '2100', credit: totalCost, memo: `${billNumber} payable to ${supplier_name.trim()}` },
          ],
        });
        jeId = je.entryId;
        entryNumber = je.entryNumber;
      }
      await execute(
        `INSERT INTO stock_movements (item_id, batch_id, location, movement_type, quantity_change, unit_cost, total_cost, reference_type, reference_id, journal_entry_id, created_by)
         VALUES (?, ?, 'main_store', 'grn_receive', ?, ?, ?, 'goods_receipt', ?, ?, ?)`,
        [targetItem.id, batchRes.insertId, qty, cost, totalCost, grnRes.insertId, jeId, req.user!.id]
      );
    }

    await writeAuditLog({
      user: req.user,
      action: 'finance.grv.create',
      entityType: 'goods_receipt',
      entityId: grnRes.insertId,
      after: { grnNumber, supplier_name, invoice_ref, approval_status: appStatus, totalCost, billNumber, entryNumber },
      req,
    });

    return { ok: true as const, id: grnRes.insertId, grnNumber, approval_status: appStatus, billNumber, entryNumber };
  });

  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error });
  res.status(201).json(result);
});

router.post('/accounting/grvs/:id/decide', requireAuth, requirePermission('finance.grv.manage', 'accounting.ledger.manage'), async (req: AuthRequest, res: Response) => {
  const id = Number(req.params.id);
  const { decision, reason } = req.body || {};
  if (!['approved', 'rejected'].includes(decision)) {
    return res.status(400).json({ error: 'Decision must be approved or rejected.' });
  }

  const result = await withTransaction(async () => {
    const grn = await queryOne<{
      id: number;
      grn_number: string;
      supplier_name: string;
      invoice_ref: string | null;
      received_date: string | null;
      total_cost: number;
      approval_status: string;
    }>('SELECT * FROM goods_receipts WHERE id = ?', [id]);
    if (!grn) return { ok: false as const, error: 'GRV not found.', httpStatus: 404 };
    if (grn.approval_status !== 'pending') {
      return { ok: false as const, error: `GRV is already ${grn.approval_status}.`, httpStatus: 409 };
    }

    if (decision === 'rejected') {
      await execute("UPDATE goods_receipts SET approval_status = 'rejected', approved_by = ?, approved_at = ?, rejected_reason = ? WHERE id = ?", [
        req.user!.id,
        nowSql(),
        reason?.trim() || 'Rejected by Finance',
        id,
      ]);
      await writeAuditLog({ user: req.user, action: 'finance.grv.reject', entityType: 'goods_receipt', entityId: id, reason: reason || null, req });
      return { ok: true as const, status: 'rejected' };
    }

    const recDate = grn.received_date || (await getClinicToday());
    await assertOpenAccountingPeriod(recDate);
    const items = await query<{ item_id: number; code: string; batch_number: string; expiry_date: string; quantity: number; unit_cost: number }>(
      'SELECT gi.*, si.code FROM grn_items gi INNER JOIN store_items si ON si.id = gi.item_id WHERE gi.grn_id = ?',
      [id]
    );
    const totalCost = Number(grn.total_cost || 0);
    let billNumber: string | null = null;
    let entryNumber: string | null = null;
    let jeId: number | null = null;

    if (totalCost > 0) {
      billNumber = await nextSequence('AP');
      const dueStr = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
      await execute(
        `INSERT INTO supplier_bills (bill_number, grn_id, supplier_name, invoice_ref, bill_date, due_date, total_amount, paid_amount, status, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'open', ?)`,
        [billNumber, id, grn.supplier_name, grn.invoice_ref || null, recDate, dueStr, totalCost, `Approved GRV ${grn.grn_number}`]
      );
      const je = await postJournalEntry({
        entryDate: recDate,
        sourceType: 'grn',
        sourceId: id,
        description: `Approved GRV ${grn.grn_number} (${grn.supplier_name})`,
        postedBy: req.user!.id,
        lines: [
          { accountCode: '1200', debit: totalCost, memo: `Approved GRV ${grn.grn_number}` },
          { accountCode: '2100', credit: totalCost, memo: `${billNumber} payable to ${grn.supplier_name}` },
        ],
      });
      jeId = je.entryId;
      entryNumber = je.entryNumber;
    }

    for (const ln of items) {
      const bRes = await execute(
        "INSERT INTO stock_batches (item_id, location, batch_number, expiry_date, qty_on_hand, unit_cost, status) VALUES (?, 'main_store', ?, ?, ?, ?, 'active')",
        [ln.item_id, ln.batch_number, ln.expiry_date, ln.quantity, ln.unit_cost]
      );
      await execute(
        `INSERT INTO stock_movements (item_id, batch_id, location, movement_type, quantity_change, unit_cost, total_cost, reference_type, reference_id, journal_entry_id, created_by)
         VALUES (?, ?, 'main_store', 'grn_receive', ?, ?, ?, 'goods_receipt', ?, ?, ?)`,
        [ln.item_id, bRes.insertId, ln.quantity, ln.unit_cost, Number((ln.quantity * ln.unit_cost).toFixed(2)), id, jeId, req.user!.id]
      );
    }

    await execute("UPDATE goods_receipts SET approval_status = 'approved', approved_by = ?, approved_at = ? WHERE id = ?", [req.user!.id, nowSql(), id]);
    await writeAuditLog({
      user: req.user,
      action: 'finance.grv.approve',
      entityType: 'goods_receipt',
      entityId: id,
      after: { grnNumber: grn.grn_number, billNumber, entryNumber },
      req,
    });
    return { ok: true as const, status: 'approved', billNumber, entryNumber };
  });

  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error });
  res.json(result);
});

router.post('/accounting/payments', requireAuth, requirePermission('finance.payment.manage', 'accounting.ledger.manage'), async (req: AuthRequest, res: Response) => {
  const {
    payment_date,
    payment_category,
    payee_name,
    cash_bank_account_id,
    payment_method = 'bank_transfer',
    amount,
    debit_account_code = '5200',
    reference_no,
    attachment_ref,
    linked_type,
    linked_id,
    notes,
  } = req.body || {};

  const payAmt = Number(Number(amount || 0).toFixed(2));
  if (!payment_category?.trim() || !payee_name?.trim() || !cash_bank_account_id || payAmt <= 0) {
    return res.status(400).json({ error: 'Category, payee, cash/bank account, and positive amount are required.' });
  }
  const payDate = payment_date ? String(payment_date).slice(0, 10) : await getClinicToday();

  const result = await withTransaction(async () => {
    await assertOpenAccountingPeriod(payDate);
    const cbAcct = await queryOne<{ id: number; account_name: string; coa_code: string }>(
      'SELECT id, account_name, coa_code FROM finance_cash_bank_accounts WHERE id = ? AND active = 1',
      [Number(cash_bank_account_id)]
    );
    if (!cbAcct) return { ok: false as const, error: 'Active Cash/Bank account not found.', httpStatus: 404 };

    let effectiveDebitCode = String(debit_account_code || '5200');
    let actualPay = payAmt;

    if (linked_type === 'supplier_bill' && linked_id) {
      const bill = await queryOne<{ id: number; bill_number: string; total_amount: number; paid_amount: number }>('SELECT * FROM supplier_bills WHERE id = ?', [Number(linked_id)]);
      if (!bill) return { ok: false as const, error: 'Linked supplier bill not found.', httpStatus: 404 };
      const rem = Number((Number(bill.total_amount) - Number(bill.paid_amount)).toFixed(2));
      if (rem <= 0) return { ok: false as const, error: 'Supplier bill is already fully paid.', httpStatus: 409 };
      if (payAmt > rem + 0.01) return { ok: false as const, error: `Amount exceeds remaining bill balance ($${rem.toFixed(2)}).`, httpStatus: 409 };
      actualPay = Math.min(payAmt, rem);
      const nextPaid = Number((Number(bill.paid_amount) + actualPay).toFixed(2));
      const nextStatus = nextPaid >= Number(bill.total_amount) - 0.01 ? 'paid' : 'partial';
      await execute('UPDATE supplier_bills SET paid_amount = ?, status = ? WHERE id = ?', [nextPaid, nextStatus, bill.id]);
      effectiveDebitCode = '2100';
    } else if (linked_type === 'expense' && linked_id) {
      const ev = await queryOne<{ id: number; voucher_number: string; amount: number; paid_amount: number; status: string }>('SELECT * FROM expense_vouchers WHERE id = ?', [Number(linked_id)]);
      if (!ev) return { ok: false as const, error: 'Linked expense voucher not found.', httpStatus: 404 };
      if (!['approved', 'partial'].includes(ev.status)) {
        return { ok: false as const, error: 'Linked expense voucher must be in approved/partial state.', httpStatus: 409 };
      }
      const rem = Number((Number(ev.amount) - Number(ev.paid_amount || 0)).toFixed(2));
      if (rem <= 0) return { ok: false as const, error: 'Expense voucher is already fully paid.', httpStatus: 409 };
      if (payAmt > rem + 0.01) return { ok: false as const, error: `Amount exceeds remaining expense balance ($${rem.toFixed(2)}).`, httpStatus: 409 };
      actualPay = Math.min(payAmt, rem);
      const nextPaid = Number((Number(ev.paid_amount || 0) + actualPay).toFixed(2));
      const nextStatus = nextPaid >= Number(ev.amount) - 0.01 ? 'paid' : 'partial';
      await execute('UPDATE expense_vouchers SET paid_amount = ?, status = ?, cash_bank_account_id = ?, paid_at = ? WHERE id = ?', [
        nextPaid,
        nextStatus,
        cbAcct.id,
        nowSql(),
        ev.id,
      ]);
      effectiveDebitCode = '2100';
    } else {
      const drAcct = await queryOne<{ id: number }>('SELECT id FROM chart_of_accounts WHERE code = ? AND active = 1', [effectiveDebitCode]);
      if (!drAcct) return { ok: false as const, error: `Active debit COA account ${effectiveDebitCode} not found.`, httpStatus: 400 };
    }

    const fpNum = await nextSequence('FPV');
    const je = await postJournalEntry({
      entryDate: payDate,
      sourceType: 'finance_payment',
      description: `Payment ${fpNum} (${payment_category.trim()}): ${payee_name.trim()}`,
      postedBy: req.user!.id,
      lines: [
        { accountCode: effectiveDebitCode, debit: actualPay, memo: notes?.trim() || `${fpNum} · ${payment_category.trim()}` },
        { accountCode: cbAcct.coa_code, credit: actualPay, memo: `${fpNum} · ${cbAcct.account_name}` },
      ],
    });

    await execute('UPDATE finance_cash_bank_accounts SET current_balance = ROUND(current_balance - ?, 2) WHERE id = ?', [actualPay, cbAcct.id]);
    const ins = await execute(
      `INSERT INTO finance_payments (payment_number, payment_date, payment_category, payee_name, cash_bank_account_id, payment_method, amount, reference_no, attachment_ref, linked_type, linked_id, notes, journal_entry_id, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        fpNum,
        payDate,
        payment_category.trim(),
        payee_name.trim(),
        cbAcct.id,
        payment_method,
        actualPay,
        reference_no?.trim() || null,
        attachment_ref?.trim() || null,
        linked_type || null,
        linked_id ? Number(linked_id) : null,
        notes?.trim() || null,
        je.entryId,
        req.user!.id,
      ]
    );

    await writeAuditLog({
      user: req.user,
      action: 'finance.payment.create',
      entityType: 'finance_payment',
      entityId: ins.insertId,
      after: { paymentNumber: fpNum, payee_name, amount: actualPay, debit_account_code: effectiveDebitCode, entryNumber: je.entryNumber },
      req,
    });
    return { ok: true as const, id: ins.insertId, paymentNumber: fpNum, entryNumber: je.entryNumber };
  });

  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error });
  broadcastClinicEvent('finance:updated', { type: 'payment', paymentNumber: result.paymentNumber });
  res.status(201).json(result);
});

router.post('/accounting/receipts', requireAuth, requirePermission('finance.receipt.manage', 'accounting.ledger.manage'), async (req: AuthRequest, res: Response) => {
  const {
    receipt_date,
    income_category,
    payer_name,
    cash_bank_account_id,
    payment_method = 'bank_transfer',
    amount,
    credit_account_code = '4050',
    reference_no,
    attachment_ref,
    notes,
  } = req.body || {};

  const recAmt = Number(Number(amount || 0).toFixed(2));
  if (!income_category?.trim() || !payer_name?.trim() || !cash_bank_account_id || recAmt <= 0) {
    return res.status(400).json({ error: 'Income category, payer, cash/bank account, and positive amount are required.' });
  }
  const recDate = receipt_date ? String(receipt_date).slice(0, 10) : await getClinicToday();

  const result = await withTransaction(async () => {
    await assertOpenAccountingPeriod(recDate);
    const cbAcct = await queryOne<{ id: number; account_name: string; coa_code: string }>(
      'SELECT id, account_name, coa_code FROM finance_cash_bank_accounts WHERE id = ? AND active = 1',
      [Number(cash_bank_account_id)]
    );
    if (!cbAcct) return { ok: false as const, error: 'Active Cash/Bank account not found.', httpStatus: 404 };

    const crAcct = await queryOne<{ id: number; code: string }>('SELECT id, code FROM chart_of_accounts WHERE code = ? AND active = 1', [
      String(credit_account_code || '4050'),
    ]);
    if (!crAcct) return { ok: false as const, error: `Active credit GL account ${credit_account_code} not found.`, httpStatus: 400 };

    const frNum = await nextSequence('FRV');
    const je = await postJournalEntry({
      entryDate: recDate,
      sourceType: 'finance_receipt',
      description: `General Receipt ${frNum} (${income_category.trim()}): ${payer_name.trim()}`,
      postedBy: req.user!.id,
      lines: [
        { accountCode: cbAcct.coa_code, debit: recAmt, memo: `${frNum} · ${cbAcct.account_name}` },
        { accountCode: crAcct.code, credit: recAmt, memo: notes?.trim() || `${frNum} · ${income_category.trim()}` },
      ],
    });

    await execute('UPDATE finance_cash_bank_accounts SET current_balance = ROUND(current_balance + ?, 2) WHERE id = ?', [recAmt, cbAcct.id]);
    const ins = await execute(
      `INSERT INTO finance_receipts (receipt_number, receipt_date, income_category, payer_name, cash_bank_account_id, payment_method, amount, reference_no, attachment_ref, notes, journal_entry_id, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        frNum,
        recDate,
        income_category.trim(),
        payer_name.trim(),
        cbAcct.id,
        payment_method,
        recAmt,
        reference_no?.trim() || null,
        attachment_ref?.trim() || null,
        notes?.trim() || null,
        je.entryId,
        req.user!.id,
      ]
    );

    await writeAuditLog({
      user: req.user,
      action: 'finance.receipt.create',
      entityType: 'finance_receipt',
      entityId: ins.insertId,
      after: { receiptNumber: frNum, payer_name, amount: recAmt, credit_account_code: crAcct.code, entryNumber: je.entryNumber },
      req,
    });
    return { ok: true as const, id: ins.insertId, receiptNumber: frNum, entryNumber: je.entryNumber };
  });

  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error });
  broadcastClinicEvent('finance:updated', { type: 'receipt', receiptNumber: result.receiptNumber });
  res.status(201).json(result);
});

router.post('/accounting/cash-bank/accounts', requireAuth, requirePermission('finance.bank.manage', 'accounting.ledger.manage'), async (req: AuthRequest, res: Response) => {
  const { account_name, account_type = 'bank', account_number, bank_name, coa_code, opening_balance = 0 } = req.body || {};
  if (!account_name?.trim() || !['cash', 'bank'].includes(String(account_type))) {
    return res.status(400).json({ error: 'Account name and type (cash/bank) are required.' });
  }
  const targetCoa = coa_code?.trim() || (account_type === 'cash' ? '1010' : '1020');
  const coa = await queryOne('SELECT id FROM chart_of_accounts WHERE code = ? AND active = 1', [targetCoa]);
  if (!coa) return res.status(400).json({ error: `COA code ${targetCoa} not found.` });

  const openBal = Number(Number(opening_balance || 0).toFixed(2));
  const ins = await execute(
    `INSERT INTO finance_cash_bank_accounts (account_name, account_type, account_number, bank_name, coa_code, opening_balance, current_balance, active)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
    [account_name.trim(), account_type, account_number?.trim() || null, bank_name?.trim() || null, targetCoa, openBal, openBal]
  );
  await writeAuditLog({
    user: req.user,
    action: 'finance.bank.account.create',
    entityType: 'cash_bank_account',
    entityId: ins.insertId,
    after: { account_name, account_type, coa_code: targetCoa, opening_balance: openBal },
    req,
  });
  broadcastClinicEvent('finance:updated', { type: 'cash_bank_account', id: ins.insertId });
  res.status(201).json({ id: ins.insertId });
});

router.post('/accounting/cash-bank/transfer', requireAuth, requirePermission('finance.bank.manage', 'accounting.ledger.manage'), async (req: AuthRequest, res: Response) => {
  const { from_account_id, to_account_id, amount, transfer_date, reference_no, notes } = req.body || {};
  const amt = Number(Number(amount || 0).toFixed(2));
  if (!from_account_id || !to_account_id || Number(from_account_id) === Number(to_account_id) || amt <= 0) {
    return res.status(400).json({ error: 'Distinct source and destination accounts and positive transfer amount are required.' });
  }
  const trDate = transfer_date ? String(transfer_date).slice(0, 10) : await getClinicToday();

  const result = await withTransaction(async () => {
    await assertOpenAccountingPeriod(trDate);
    const fromAcc = await queryOne<{ id: number; account_name: string; coa_code: string; current_balance: number }>(
      'SELECT * FROM finance_cash_bank_accounts WHERE id = ? AND active = 1',
      [Number(from_account_id)]
    );
    const toAcc = await queryOne<{ id: number; account_name: string; coa_code: string; current_balance: number }>(
      'SELECT * FROM finance_cash_bank_accounts WHERE id = ? AND active = 1',
      [Number(to_account_id)]
    );
    if (!fromAcc || !toAcc) return { ok: false as const, error: 'Source or destination account not found.', httpStatus: 404 };

    const trNum = await nextSequence('TRF');
    const je = await postJournalEntry({
      entryDate: trDate,
      sourceType: 'cash_bank_transfer',
      description: `Fund Transfer ${trNum}: ${fromAcc.account_name} -> ${toAcc.account_name}`,
      postedBy: req.user!.id,
      lines: [
        { accountCode: toAcc.coa_code, debit: amt, memo: `Transfer into ${toAcc.account_name}` },
        { accountCode: fromAcc.coa_code, credit: amt, memo: `Transfer from ${fromAcc.account_name}` },
      ],
    });

    await execute('UPDATE finance_cash_bank_accounts SET current_balance = ROUND(current_balance - ?, 2) WHERE id = ?', [amt, fromAcc.id]);
    await execute('UPDATE finance_cash_bank_accounts SET current_balance = ROUND(current_balance + ?, 2) WHERE id = ?', [amt, toAcc.id]);
    const ins = await execute(
      `INSERT INTO finance_cash_bank_transfers (transfer_number, transfer_date, from_account_id, to_account_id, amount, reference_no, notes, journal_entry_id, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [trNum, trDate, fromAcc.id, toAcc.id, amt, reference_no?.trim() || null, notes?.trim() || null, je.entryId, req.user!.id]
    );

    await writeAuditLog({
      user: req.user,
      action: 'finance.bank.transfer',
      entityType: 'cash_bank_transfer',
      entityId: ins.insertId,
      after: { transferNumber: trNum, from: fromAcc.account_name, to: toAcc.account_name, amount: amt, entryNumber: je.entryNumber },
      req,
    });
    return { ok: true as const, id: ins.insertId, transferNumber: trNum, entryNumber: je.entryNumber };
  });

  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error });
  broadcastClinicEvent('finance:updated', { type: 'cash_bank_transfer', transferNumber: result.transferNumber });
  res.status(201).json(result);
});

// ---------------------------------------------------------------------------
// FILTERABLE REPORTS LIBRARY
// ---------------------------------------------------------------------------
router.get('/reports/:type', requireAuth, async (req: AuthRequest, res: Response) => {
  const type = req.params.type;
  const fromRaw = req.query.from ? String(req.query.from).slice(0, 10) : '2020-01-01';
  const toRaw = req.query.to ? String(req.query.to).slice(0, 10) : '2099-12-31';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromRaw) || !/^\d{4}-\d{2}-\d{2}$/.test(toRaw)) {
    return res.status(400).json({ error: 'Invalid date range format (expected YYYY-MM-DD).' });
  }
  const fromDate = fromRaw;
  const toDate = toRaw;

  const allowedByType: Record<string, string[]> = {
    'daily-cash': ['finance.report.view', 'billing.report.own', 'audit.read'],
    'ar-ageing': ['finance.report.view', 'audit.read', 'accounting.ledger.manage'],
    'opd-diagnoses': ['finance.report.view', 'audit.read', 'visit.read'],
    'my-clinical-reports': ['visit.read', 'finance.report.view', 'audit.read'],
    'lab-turnaround': ['finance.report.view', 'audit.read', 'lab.order.read'],
    'stock-valuation': ['finance.report.view', 'audit.read', 'store.item.read'],
    'payroll-summary': ['finance.report.view', 'accounting.ledger.manage', 'finance.payroll.generate', 'audit.read'],
    'payroll-payments': ['finance.report.view', 'accounting.ledger.manage', 'finance.payroll.generate', 'hr.payroll.pay', 'audit.read'],
    'expense-report': ['finance.report.view', 'accounting.ledger.manage', 'accounting.expense.create', 'audit.read'],
    'grv-report': ['finance.report.view', 'accounting.ledger.manage', 'finance.grv.manage', 'audit.read'],
    'payments-report': ['finance.report.view', 'accounting.ledger.manage', 'finance.payment.manage', 'audit.read'],
    'receipts-report': ['finance.report.view', 'accounting.ledger.manage', 'finance.receipt.manage', 'audit.read'],
    'cash-report': ['finance.report.view', 'accounting.ledger.manage', 'finance.bank.manage', 'audit.read'],
    'bank-report': ['finance.report.view', 'accounting.ledger.manage', 'finance.bank.manage', 'audit.read'],
    'trial-balance': ['finance.report.view', 'accounting.ledger.manage', 'audit.read'],
    'balance-sheet': ['finance.report.view', 'accounting.ledger.manage', 'audit.read'],
  };
  const needed = allowedByType[type];
  if (!needed) return res.status(400).json({ error: 'Unknown report type.' });
  if (!needed.some((p) => hasPermission(req.user!, p))) {
    return res.status(403).json({ error: `Forbidden: requires one of [${needed.join(', ')}]` });
  }

  if (type === 'daily-cash') {
    const canSeeAllCashiers = hasPermission(req.user!, 'finance.report.view') || hasPermission(req.user!, 'audit.read');
    const rows = await query(
      `SELECT substr(pay.created_at, 1, 10) AS payment_date, u.full_name AS cashier_name,
              pay.payment_method, COUNT(*) AS tx_count,
              ROUND(SUM(CASE WHEN pay.status = 'refunded' THEN -pay.amount ELSE pay.amount END), 2) AS total_amount
       FROM payments pay
       LEFT JOIN users u ON u.id = pay.created_by
       WHERE pay.status IN ('completed', 'refunded') AND substr(pay.created_at, 1, 10) BETWEEN ? AND ?${canSeeAllCashiers ? '' : ' AND pay.created_by = ?'}
       GROUP BY substr(pay.created_at, 1, 10), u.full_name, pay.payment_method
       ORDER BY payment_date DESC, cashier_name ASC`,
      canSeeAllCashiers ? [fromDate, toDate] : [fromDate, toDate, req.user!.id]
    );
    return res.json({ reportType: type, fromDate, toDate, ownOnly: !canSeeAllCashiers, rows });
  }

  if (type === 'opd-diagnoses') {
    const doctorScoped = isDoctorOnly(req.user!);
    const rows = await query(
      `SELECT COALESCE(v.diagnosis_code, 'UNSPEC') AS diagnosis_code,
              COALESCE(v.diagnosis_text, v.chief_complaint, 'Pending Assessment') AS diagnosis_text,
              COUNT(*) AS visit_count,
              SUM(CASE WHEN v.triage_priority = 'emergency' THEN 1 ELSE 0 END) AS emergency_count
       FROM visits v
       WHERE substr(v.created_at, 1, 10) BETWEEN ? AND ?${doctorScoped ? ' AND v.doctor_id = ?' : ''}
       GROUP BY COALESCE(v.diagnosis_code, 'UNSPEC'), COALESCE(v.diagnosis_text, v.chief_complaint, 'Pending Assessment')
       ORDER BY visit_count DESC LIMIT 40`,
      doctorScoped ? [fromDate, toDate, req.user!.id] : [fromDate, toDate]
    );
    return res.json({ reportType: type, fromDate, toDate, isDoctorScoped: doctorScoped, rows });
  }

  if (type === 'my-clinical-reports') {
    const doctorScoped = isDoctorOnly(req.user!);
    const rows = await query(
      `SELECT v.id, v.visit_number, substr(v.created_at, 1, 10) AS visit_date,
              p.mrn, p.first_name || ' ' || p.last_name AS patient_name,
              COALESCE(v.diagnosis_code, '-') AS diagnosis_code,
              COALESCE(v.diagnosis_text, v.chief_complaint, 'Pending Assessment') AS diagnosis_text,
              v.treatment_plan, v.status, v.workflow_stage, v.triage_priority,
              COALESCE(u.full_name, 'Unassigned') AS doctor_name,
              (SELECT COUNT(*) FROM lab_orders lo WHERE lo.visit_id = v.id) AS lab_count,
              (SELECT COUNT(*) FROM imaging_orders io WHERE io.visit_id = v.id) AS imaging_count,
              (SELECT COUNT(*) FROM prescriptions pr WHERE pr.visit_id = v.id) AS rx_count
       FROM visits v
       INNER JOIN patients p ON p.id = v.patient_id
       LEFT JOIN users u ON u.id = v.doctor_id
       WHERE substr(v.created_at, 1, 10) BETWEEN ? AND ?${doctorScoped ? ' AND v.doctor_id = ?' : ''}
       ORDER BY v.id DESC LIMIT 100`,
      doctorScoped ? [fromDate, toDate, req.user!.id] : [fromDate, toDate]
    );
    return res.json({ reportType: type, fromDate, toDate, isDoctorScoped: doctorScoped, rows });
  }

  if (type === 'lab-turnaround') {
    const doctorScoped = isDoctorOnly(req.user!);
    const rows = await query(
      `SELECT lo.id, lt.code AS test_code, lt.name AS test_name, p.mrn, p.first_name, p.last_name,
              lo.status, lo.abnormal_flag, lo.created_at, lo.verified_at
       FROM lab_orders lo
       INNER JOIN lab_tests lt ON lt.id = lo.test_id
       INNER JOIN patients p ON p.id = lo.patient_id
       ${doctorScoped ? 'INNER JOIN visits v ON v.id = lo.visit_id' : ''}
       WHERE substr(lo.created_at, 1, 10) BETWEEN ? AND ?${doctorScoped ? " AND (v.doctor_id = ? OR EXISTS (SELECT 1 FROM doctor_assignments da WHERE da.visit_id = v.id AND da.doctor_id = ? AND da.status = 'active'))" : ''}
       ORDER BY lo.id DESC LIMIT 60`,
      doctorScoped ? [fromDate, toDate, req.user!.id, req.user!.id] : [fromDate, toDate]
    );
    return res.json({ reportType: type, fromDate, toDate, isDoctorScoped: doctorScoped, rows });
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

  if (type === 'payroll-summary') {
    const rows = await query(
      `SELECT pr.run_number, pr.pay_month, pr.status,
              COUNT(pi.id) AS headcount,
              pr.total_gross, pr.total_deductions, pr.total_net,
              ROUND(COALESCE(SUM(pi.paid_amount), 0), 2) AS total_paid_to_staff
       FROM payroll_runs pr
       LEFT JOIN payroll_items pi ON pi.payroll_run_id = pr.id
       GROUP BY pr.id
       ORDER BY pr.pay_month DESC, pr.id DESC`
    );
    return res.json({ reportType: type, fromDate, toDate, rows });
  }

  if (type === 'payroll-payments') {
    const rows = await query(
      `SELECT pr.run_number, pr.pay_month, pi.staff_name, pi.role_code,
              pi.base_salary, pi.allowances, pi.overtime_pay, pi.bonus_earnings,
              pi.paye_tax, pi.pension_employee, pi.other_deductions,
              pi.net_pay, pi.paid_amount, ROUND(pi.net_pay - pi.paid_amount, 2) AS balance_due,
              pi.payment_status, pi.payment_method, pi.payment_ref
       FROM payroll_items pi
       INNER JOIN payroll_runs pr ON pr.id = pi.payroll_run_id
       ORDER BY pr.pay_month DESC, pi.staff_name ASC`
    );
    return res.json({ reportType: type, fromDate, toDate, rows });
  }

  if (type === 'expense-report') {
    const rows = await query(
      `SELECT ev.voucher_number, ev.expense_date, ev.category, coa.code AS gl_code, coa.name AS gl_account,
              ev.payee_name, ev.amount, ev.paid_amount, ev.status, ev.payment_method, ev.reference_number
       FROM expense_vouchers ev
       INNER JOIN chart_of_accounts coa ON coa.id = ev.account_id
       WHERE ev.expense_date BETWEEN ? AND ?
       ORDER BY ev.expense_date DESC, ev.id DESC`,
      [fromDate, toDate]
    );
    return res.json({ reportType: type, fromDate, toDate, rows });
  }

  if (type === 'grv-report') {
    const rows = await query(
      `SELECT gr.grn_number, COALESCE(gr.received_date, substr(gr.received_at,1,10)) AS received_date,
              gr.supplier_name, gr.invoice_ref, gr.department_name, gr.approval_status,
              gr.total_cost, sb.bill_number, sb.status AS bill_status, sb.paid_amount
       FROM goods_receipts gr
       LEFT JOIN supplier_bills sb ON sb.grn_id = gr.id
       WHERE COALESCE(gr.received_date, substr(gr.received_at,1,10)) BETWEEN ? AND ?
       ORDER BY gr.id DESC`,
      [fromDate, toDate]
    );
    return res.json({ reportType: type, fromDate, toDate, rows });
  }

  if (type === 'payments-report') {
    const rows = await query(
      `SELECT fp.payment_number, fp.payment_date, fp.payment_category, fp.payee_name,
              cba.account_name, fp.payment_method, fp.amount, fp.reference_no, fp.linked_type
       FROM finance_payments fp
       INNER JOIN finance_cash_bank_accounts cba ON cba.id = fp.cash_bank_account_id
       WHERE fp.payment_date BETWEEN ? AND ?
       ORDER BY fp.payment_date DESC, fp.id DESC`,
      [fromDate, toDate]
    );
    return res.json({ reportType: type, fromDate, toDate, rows });
  }

  if (type === 'receipts-report') {
    const rows = await query(
      `SELECT fr.receipt_number, fr.receipt_date, fr.income_category, fr.payer_name,
              cba.account_name, fr.payment_method, fr.amount, fr.reference_no
       FROM finance_receipts fr
       INNER JOIN finance_cash_bank_accounts cba ON cba.id = fr.cash_bank_account_id
       WHERE fr.receipt_date BETWEEN ? AND ?
       ORDER BY fr.receipt_date DESC, fr.id DESC`,
      [fromDate, toDate]
    );
    return res.json({ reportType: type, fromDate, toDate, rows });
  }

  if (type === 'cash-report' || type === 'bank-report') {
    const acctType = type === 'cash-report' ? 'cash' : 'bank';
    const rows = await query(
      `SELECT cba.account_name, cba.account_type, cba.account_number, cba.bank_name, cba.coa_code,
              cba.opening_balance, cba.current_balance,
              ROUND(COALESCE((SELECT SUM(fr.amount) FROM finance_receipts fr WHERE fr.cash_bank_account_id = cba.id AND fr.receipt_date BETWEEN ? AND ?), 0), 2) AS total_receipts,
              ROUND(COALESCE((SELECT SUM(fp.amount) FROM finance_payments fp WHERE fp.cash_bank_account_id = cba.id AND fp.payment_date BETWEEN ? AND ?), 0), 2) AS total_payments
       FROM finance_cash_bank_accounts cba
       WHERE cba.account_type = ?
       ORDER BY cba.id ASC`,
      [fromDate, toDate, fromDate, toDate, acctType]
    );
    return res.json({ reportType: type, fromDate, toDate, rows });
  }

  if (type === 'trial-balance' || type === 'balance-sheet') {
    const rows = await query(
      `SELECT coa.code, coa.name, coa.account_type, coa.normal_balance,
              ROUND(COALESCE(SUM(jl.debit), 0), 2) AS total_debit,
              ROUND(COALESCE(SUM(jl.credit), 0), 2) AS total_credit,
              ROUND(CASE WHEN coa.normal_balance = 'debit' THEN COALESCE(SUM(jl.debit - jl.credit), 0) ELSE COALESCE(SUM(jl.credit - jl.debit), 0) END, 2) AS net_balance
       FROM chart_of_accounts coa
       LEFT JOIN journal_lines jl ON jl.account_id = coa.id
       ${type === 'balance-sheet' ? "WHERE coa.account_type IN ('asset','liability','equity')" : ''}
       GROUP BY coa.id
       ORDER BY coa.code ASC`
    );
    return res.json({ reportType: type, fromDate, toDate, rows });
  }

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
});

// ---------------------------------------------------------------------------
// HR & PAYROLL (HRO) — Progressive PAYE, Verification & Multi-Stage Workflow
// ---------------------------------------------------------------------------
async function computeProgressivePaye(taxableIncome: number): Promise<number> {
  if (taxableIncome <= 0) return 0;
  const brackets = await query<{ lower_bound: number; upper_bound: number | null; rate: number; deduction: number }>(
    'SELECT lower_bound, upper_bound, rate, deduction FROM tax_brackets WHERE active = 1 ORDER BY lower_bound ASC'
  );
  if (brackets.length === 0) {
    return Number((taxableIncome * 0.15).toFixed(2));
  }
  let matched = brackets[0];
  for (const b of brackets) {
    if (taxableIncome >= Number(b.lower_bound) && (b.upper_bound === null || taxableIncome <= Number(b.upper_bound))) {
      matched = b;
      break;
    }
    if (taxableIncome >= Number(b.lower_bound)) {
      matched = b;
    }
  }
  const tax = Math.max(0, taxableIncome * Number(matched.rate) - Number(matched.deduction));
  return Number(tax.toFixed(2));
}

function computeAttendanceMetrics(checkIn?: string | null, checkOut?: string | null) {
  if (!checkIn || !checkOut || !/^\d{2}:\d{2}/.test(checkIn) || !/^\d{2}:\d{2}/.test(checkOut)) {
    return { hoursWorked: 0, lateMinutes: 0, earlyLeaveMinutes: 0 };
  }
  const [inH, inM] = checkIn.split(':').map(Number);
  const [outH, outM] = checkOut.split(':').map(Number);
  const inTotal = inH * 60 + inM;
  const outTotal = outH * 60 + outM;
  const diffMins = Math.max(0, outTotal - inTotal);
  const hoursWorked = Number((diffMins / 60).toFixed(2));
  const lateMinutes = Math.max(0, inTotal - (8 * 60 + 15));
  const earlyLeaveMinutes = Math.max(0, 17 * 60 - outTotal);
  return { hoursWorked, lateMinutes, earlyLeaveMinutes };
}

router.get(
  '/hr/overview',
  requireAuth,
  requirePermission(
    'hr.manage',
    'hr.attendance.manage',
    'hr.overtime.manage',
    'hr.payroll.submit',
    'hr.leave.request',
    'hr.payroll.verify',
    'hr.payroll.approve',
    'hr.payroll.post',
    'hr.payroll.pay',
    'finance.payroll.generate'
  ),
  async (req: AuthRequest, res: Response) => {
    const isHrManager = hasPermission(req.user!, 'hr.manage', 'hr.attendance.manage', 'hr.overtime.manage', 'hr.payroll.submit');
    const canViewPayroll =
      isHrManager ||
      hasPermission(req.user!, 'hr.payroll.verify', 'hr.payroll.approve', 'hr.payroll.post', 'hr.payroll.pay', 'finance.payroll.generate');

    const leaveRequests = isHrManager
      ? await query(
          `SELECT lr.*,
                  COALESCE(he.full_name, u1.full_name, 'Staff') AS staff_name,
                  he.employee_number,
                  he.department_name,
                  COALESCE((SELECT GROUP_CONCAT(r.code) FROM user_roles ur INNER JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = lr.user_id), 'EMP') AS role_code,
                  u2.full_name AS decided_by_name
           FROM leave_requests lr
           LEFT JOIN hr_employees he ON (he.id = lr.employee_id OR (lr.employee_id IS NULL AND he.user_id = lr.user_id))
           LEFT JOIN users u1 ON u1.id = lr.user_id
           LEFT JOIN users u2 ON u2.id = lr.decided_by
           ORDER BY lr.id DESC LIMIT 120`
        )
      : await query(
          `SELECT lr.*,
                  COALESCE(he.full_name, u1.full_name, 'Staff') AS staff_name,
                  he.employee_number,
                  he.department_name,
                  COALESCE((SELECT GROUP_CONCAT(r.code) FROM user_roles ur INNER JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = lr.user_id), 'EMP') AS role_code,
                  u2.full_name AS decided_by_name
           FROM leave_requests lr
           LEFT JOIN hr_employees he ON (he.id = lr.employee_id OR (lr.employee_id IS NULL AND he.user_id = lr.user_id))
           LEFT JOIN users u1 ON u1.id = lr.user_id
           LEFT JOIN users u2 ON u2.id = lr.decided_by
           WHERE lr.user_id = ?
           ORDER BY lr.id DESC LIMIT 40`,
          [req.user!.id]
        );

    const leaveTypes = await query<{ id: number; code: string; name: string; annual_allowance_days: number; paid: number; description: string | null; active: number }>(
      'SELECT * FROM hr_leave_types WHERE active = 1 ORDER BY id ASC'
    );

    if (!isHrManager && !canViewPayroll) {
      return res.json({
        isHrManager: false,
        canViewPayroll: false,
        employees: [],
        employeeDocuments: [],
        attendance: [],
        leaveTypes,
        leaveBalances: [],
        overtime: [],
        adjustments: [],
        monthlySubmissions: [],
        contracts: [],
        leaveRequests,
        payrollRuns: [],
        staffUsers: [],
        taxBrackets: [],
      });
    }

    const currentYear = String(new Date().getUTCFullYear());
    const [
      employeesRaw,
      employeeDocuments,
      attendance,
      overtime,
      adjustments,
      monthlySubmissions,
      contractsRaw,
      payrollRuns,
      payrollItems,
      staffUsers,
      taxBrackets,
      yearLeaveUsage,
    ] = await Promise.all([
      isHrManager
        ? query<Record<string, unknown>>(
            `SELECT he.*, u.email AS user_email, u.active AS user_active,
                    (SELECT GROUP_CONCAT(r.code) FROM user_roles ur INNER JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = he.user_id) AS role_code,
                    (SELECT COUNT(*) FROM hr_employee_documents doc WHERE doc.employee_id = he.id) AS document_count
             FROM hr_employees he
             LEFT JOIN users u ON u.id = he.user_id
             ORDER BY he.employee_number ASC`
          )
        : Promise.resolve([]),
      isHrManager
        ? query(
            `SELECT doc.*, he.employee_number, he.full_name AS employee_name, u.full_name AS uploaded_by_name
             FROM hr_employee_documents doc
             INNER JOIN hr_employees he ON he.id = doc.employee_id
             LEFT JOIN users u ON u.id = doc.uploaded_by
             ORDER BY doc.id DESC LIMIT 120`
          )
        : Promise.resolve([]),
      isHrManager
        ? query(
            `SELECT att.*, he.employee_number, he.full_name, he.department_name
             FROM hr_attendance att
             INNER JOIN hr_employees he ON he.id = att.employee_id
             ORDER BY att.attendance_date DESC, he.full_name ASC LIMIT 250`
          )
        : Promise.resolve([]),
      isHrManager
        ? query(
            `SELECT ot.*, he.employee_number, he.full_name, he.department_name, u.full_name AS decided_by_name
             FROM hr_overtime ot
             INNER JOIN hr_employees he ON he.id = ot.employee_id
             LEFT JOIN users u ON u.id = ot.decided_by
             ORDER BY ot.overtime_date DESC, ot.id DESC LIMIT 150`
          )
        : Promise.resolve([]),
      isHrManager
        ? query(
            `SELECT adj.*, he.employee_number, he.full_name, he.department_name, u.full_name AS created_by_name
             FROM hr_adjustments adj
             INNER JOIN hr_employees he ON he.id = adj.employee_id
             LEFT JOIN users u ON u.id = adj.created_by
             ORDER BY adj.effective_month DESC, adj.id DESC LIMIT 150`
          )
        : Promise.resolve([]),
      query(
        `SELECT hms.*, u.full_name AS submitted_by_name
         FROM hr_monthly_submissions hms
         LEFT JOIN users u ON u.id = hms.submitted_by
         ORDER BY hms.pay_month DESC LIMIT 24`
      ),
      isHrManager
        ? query<Record<string, unknown>>(
            `SELECT sc.*, u.full_name, u.email, u.specialty, u.active,
                    (SELECT GROUP_CONCAT(r.code) FROM user_roles ur INNER JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id) AS role_code,
                    (SELECT GROUP_CONCAT(r.name) FROM user_roles ur INNER JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id) AS role_name
             FROM staff_contracts sc
             INNER JOIN users u ON u.id = sc.user_id
             ORDER BY sc.employee_code ASC`
          )
        : Promise.resolve([]),
      query<Record<string, unknown>>(
        `SELECT pr.*, je.entry_number AS journal_entry_number, pje.entry_number AS payment_journal_entry_number,
                u.full_name AS created_by_name, uv.full_name AS verified_by_name,
                ua.full_name AS approved_by_name, up.full_name AS paid_by_name
         FROM payroll_runs pr
         LEFT JOIN journal_entries je ON je.id = pr.journal_entry_id
         LEFT JOIN journal_entries pje ON pje.id = pr.payment_journal_entry_id
         LEFT JOIN users u ON u.id = pr.created_by
         LEFT JOIN users uv ON uv.id = pr.verified_by
         LEFT JOIN users ua ON ua.id = pr.approved_by
         LEFT JOIN users up ON up.id = pr.paid_by
         ORDER BY pr.id DESC LIMIT 24`
      ),
      query<Record<string, unknown>>('SELECT * FROM payroll_items ORDER BY id ASC'),
      isHrManager
        ? query(
            `SELECT u.id, u.full_name, u.email,
                    (SELECT GROUP_CONCAT(r.code) FROM user_roles ur INNER JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id) AS role_code,
                    (SELECT GROUP_CONCAT(r.name) FROM user_roles ur INNER JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id) AS role_name
             FROM users u
             WHERE u.active = 1
             ORDER BY u.full_name`
          )
        : Promise.resolve([]),
      query('SELECT * FROM tax_brackets WHERE active = 1 ORDER BY lower_bound ASC'),
      query<{ employee_id: number | null; user_id: number | null; leave_type: string; status: string; days: number }>(
        `SELECT employee_id, user_id, LOWER(leave_type) AS leave_type, status, COALESCE(SUM(days_count), 0) AS days
         FROM leave_requests
         WHERE substr(start_date, 1, 4) = ? AND status IN ('approved','pending')
         GROUP BY employee_id, user_id, LOWER(leave_type), status`,
        [currentYear]
      ),
    ]);

    const nowMs = Date.now();
    const decorateLicence = <T extends Record<string, unknown>>(row: T) => {
      let licenceDaysRemaining: number | null = null;
      if (row.licence_expiry) {
        licenceDaysRemaining = Math.ceil((new Date(String(row.licence_expiry)).getTime() - nowMs) / 86400000);
      }
      return {
        ...row,
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
    };

    const employees = employeesRaw.map(decorateLicence);
    const contracts = contractsRaw.map(decorateLicence);

    const leaveBalances: Array<Record<string, unknown>> = [];
    for (const emp of employeesRaw) {
      if (emp.status !== 'active') continue;
      for (const lt of leaveTypes) {
        if (Number(lt.annual_allowance_days) <= 0) continue;
        let usedDays = 0;
        let pendingDays = 0;
        for (const u of yearLeaveUsage) {
          const matchesEmp = (u.employee_id && Number(u.employee_id) === Number(emp.id)) || (!u.employee_id && emp.user_id && Number(u.user_id) === Number(emp.user_id));
          if (!matchesEmp) continue;
          if (u.leave_type === lt.code.toLowerCase()) {
            if (u.status === 'approved') usedDays += Number(u.days || 0);
            if (u.status === 'pending') pendingDays += Number(u.days || 0);
          }
        }
        leaveBalances.push({
          employee_id: emp.id,
          employee_number: emp.employee_number,
          full_name: emp.full_name,
          department_name: emp.department_name,
          leave_type_code: lt.code,
          leave_type_name: lt.name,
          annual_allowance_days: lt.annual_allowance_days,
          used_days: usedDays,
          pending_days: pendingDays,
          remaining_days: Math.max(0, Number(lt.annual_allowance_days) - usedDays),
        });
      }
    }

    const itemsByRun = new Map<number, Record<string, unknown>[]>();
    for (const pi of payrollItems) {
      const k = Number(pi.payroll_run_id);
      if (!itemsByRun.has(k)) itemsByRun.set(k, []);
      itemsByRun.get(k)!.push(pi);
    }
    for (const run of payrollRuns) {
      run.items = itemsByRun.get(Number(run.id)) || [];
    }

    res.json({
      isHrManager,
      canViewPayroll,
      employees,
      employeeDocuments,
      attendance,
      leaveTypes,
      leaveBalances,
      overtime,
      adjustments,
      monthlySubmissions,
      contracts,
      leaveRequests,
      payrollRuns,
      staffUsers,
      taxBrackets,
    });
  }
);

router.get('/hr/my-payslips', requireAuth, requirePermission('hr.payslip.own', 'hr.leave.request'), async (req: AuthRequest, res: Response) => {
  const payslips = await query(
    `SELECT pi.*, pr.run_number, pr.pay_month, pr.status AS run_status, pr.posted_at, pr.paid_at,
            COALESCE(he.employee_number, sc.employee_code) AS employee_code,
            COALESCE(he.department_name, sc.department_name) AS department_name
     FROM payroll_items pi
     INNER JOIN payroll_runs pr ON pr.id = pi.payroll_run_id
     LEFT JOIN hr_employees he ON (he.id = pi.employee_id OR he.user_id = pi.user_id)
     LEFT JOIN staff_contracts sc ON sc.user_id = pi.user_id
     WHERE pi.user_id = ? AND pr.status IN ('approved','posted','partially_paid','paid')
     ORDER BY pr.pay_month DESC, pr.id DESC LIMIT 24`,
    [req.user!.id]
  );
  res.json({ payslips });
});

router.post('/hr/employees', requireAuth, requirePermission('hr.manage'), async (req: AuthRequest, res: Response) => {
  const {
    user_id,
    employee_number,
    full_name,
    gender = 'unspecified',
    phone,
    email,
    address,
    emergency_contact_name,
    emergency_contact_phone,
    department_name,
    job_position = 'Clinic Staff',
    employment_type = 'full_time',
    hire_date,
    contract_start,
    contract_end,
    basic_salary,
    housing_allowance = 0,
    licence_number,
    licence_expiry,
  } = req.body || {};

  if (!full_name?.trim() || !department_name?.trim() || Number(basic_salary) <= 0) {
    return res.status(400).json({ error: 'Full name, department, and positive basic salary are required.' });
  }

  const todayStr = await getClinicToday();
  const hDate = hire_date || contract_start || todayStr;
  const cStart = contract_start || hire_date || todayStr;
  const empNum = employee_number?.trim() ? employee_number.trim().toUpperCase() : await nextSequence('EMP');

  const dupCode = await queryOne('SELECT id FROM hr_employees WHERE employee_number = ?', [empNum]);
  if (dupCode) return res.status(409).json({ error: `Employee number ${empNum} already exists.` });
  if (user_id) {
    const dupUser = await queryOne('SELECT id FROM hr_employees WHERE user_id = ?', [Number(user_id)]);
    if (dupUser) return res.status(409).json({ error: 'Selected system user is already linked to another employee profile.' });
  }

  const ins = await execute(
    `INSERT INTO hr_employees (
      employee_number, user_id, full_name, gender, phone, email, address,
      emergency_contact_name, emergency_contact_phone, department_name, job_position,
      employment_type, hire_date, contract_start, contract_end, basic_salary, housing_allowance,
      licence_number, licence_expiry, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
    [
      empNum,
      user_id ? Number(user_id) : null,
      full_name.trim(),
      gender,
      phone?.trim() || null,
      email?.trim() || null,
      address?.trim() || null,
      emergency_contact_name?.trim() || null,
      emergency_contact_phone?.trim() || null,
      department_name.trim(),
      job_position.trim(),
      employment_type,
      hDate,
      cStart,
      contract_end || null,
      Number(basic_salary),
      Number(housing_allowance || 0),
      licence_number?.trim() || null,
      licence_expiry || null,
    ]
  );

  if (user_id) {
    const sc = await queryOne<{ id: number }>('SELECT id FROM staff_contracts WHERE user_id = ?', [Number(user_id)]);
    if (sc) {
      await execute(
        `UPDATE staff_contracts SET employee_code = ?, department_name = ?, contract_type = ?, base_salary = ?, housing_allowance = ?, licence_number = ?, licence_expiry = ?, contract_start = ?, contract_end = ?, status = 'active', updated_at = ? WHERE id = ?`,
        [empNum, department_name.trim(), employment_type, Number(basic_salary), Number(housing_allowance || 0), licence_number?.trim() || null, licence_expiry || null, cStart, contract_end || null, nowSql(), sc.id]
      );
    } else {
      await execute(
        `INSERT INTO staff_contracts (user_id, employee_code, department_name, contract_type, base_salary, housing_allowance, licence_number, licence_expiry, contract_start, contract_end, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
        [Number(user_id), empNum, department_name.trim(), employment_type, Number(basic_salary), Number(housing_allowance || 0), licence_number?.trim() || null, licence_expiry || null, cStart, contract_end || null]
      );
    }
  }

  await writeAuditLog({
    user: req.user,
    action: 'hr.employee.create',
    entityType: 'hr_employee',
    entityId: ins.insertId,
    after: { employee_number: empNum, full_name, department_name, job_position, basic_salary },
    req,
  });
  res.status(201).json({ id: ins.insertId, employee_number: empNum });
});

router.put('/hr/employees/:id', requireAuth, requirePermission('hr.manage'), async (req: AuthRequest, res: Response) => {
  const id = Number(req.params.id);
  const existing = await queryOne<{ id: number; user_id: number | null; employee_number: string }>('SELECT id, user_id, employee_number FROM hr_employees WHERE id = ?', [id]);
  if (!existing) return res.status(404).json({ error: 'Employee not found.' });

  const b = req.body || {};
  await execute(
    `UPDATE hr_employees SET
       full_name = COALESCE(?, full_name),
       gender = COALESCE(?, gender),
       phone = COALESCE(?, phone),
       email = COALESCE(?, email),
       address = COALESCE(?, address),
       emergency_contact_name = COALESCE(?, emergency_contact_name),
       emergency_contact_phone = COALESCE(?, emergency_contact_phone),
       department_name = COALESCE(?, department_name),
       job_position = COALESCE(?, job_position),
       employment_type = COALESCE(?, employment_type),
       contract_start = COALESCE(?, contract_start),
       contract_end = ?,
       basic_salary = COALESCE(?, basic_salary),
       housing_allowance = COALESCE(?, housing_allowance),
       licence_number = ?,
       licence_expiry = ?,
       updated_at = ?
     WHERE id = ?`,
    [
      b.full_name?.trim() || null,
      b.gender || null,
      b.phone !== undefined ? (b.phone?.trim() || null) : null,
      b.email !== undefined ? (b.email?.trim() || null) : null,
      b.address !== undefined ? (b.address?.trim() || null) : null,
      b.emergency_contact_name !== undefined ? (b.emergency_contact_name?.trim() || null) : null,
      b.emergency_contact_phone !== undefined ? (b.emergency_contact_phone?.trim() || null) : null,
      b.department_name?.trim() || null,
      b.job_position?.trim() || null,
      b.employment_type || null,
      b.contract_start || null,
      b.contract_end !== undefined ? (b.contract_end || null) : null,
      b.basic_salary !== undefined ? Number(b.basic_salary) : null,
      b.housing_allowance !== undefined ? Number(b.housing_allowance) : null,
      b.licence_number !== undefined ? (b.licence_number?.trim() || null) : null,
      b.licence_expiry !== undefined ? (b.licence_expiry || null) : null,
      nowSql(),
      id,
    ]
  );

  if (existing.user_id) {
    await execute(
      `UPDATE staff_contracts SET
         department_name = COALESCE(?, department_name),
         contract_type = COALESCE(?, contract_type),
         base_salary = COALESCE(?, base_salary),
         housing_allowance = COALESCE(?, housing_allowance),
         licence_number = ?,
         licence_expiry = ?,
         contract_start = COALESCE(?, contract_start),
         contract_end = ?,
         updated_at = ?
       WHERE user_id = ?`,
      [
        b.department_name?.trim() || null,
        b.employment_type || null,
        b.basic_salary !== undefined ? Number(b.basic_salary) : null,
        b.housing_allowance !== undefined ? Number(b.housing_allowance) : null,
        b.licence_number !== undefined ? (b.licence_number?.trim() || null) : null,
        b.licence_expiry !== undefined ? (b.licence_expiry || null) : null,
        b.contract_start || null,
        b.contract_end !== undefined ? (b.contract_end || null) : null,
        nowSql(),
        existing.user_id,
      ]
    );
  }

  await writeAuditLog({
    user: req.user,
    action: 'hr.employee.update',
    entityType: 'hr_employee',
    entityId: id,
    after: b,
    req,
  });
  res.json({ ok: true });
});

router.patch('/hr/employees/:id/status', requireAuth, requirePermission('hr.manage'), async (req: AuthRequest, res: Response) => {
  const id = Number(req.params.id);
  const { status, reason } = req.body || {};
  const nextStatus = String(status || '').trim().toLowerCase();
  if (!['active', 'inactive', 'resigned', 'terminated'].includes(nextStatus)) {
    return res.status(400).json({ error: 'Status must be active, inactive, resigned, or terminated.' });
  }
  const emp = await queryOne<{ id: number; user_id: number | null; employee_number: string; full_name: string; status: string }>(
    'SELECT id, user_id, employee_number, full_name, status FROM hr_employees WHERE id = ?',
    [id]
  );
  if (!emp) return res.status(404).json({ error: 'Employee not found.' });
  if ((nextStatus === 'terminated' || nextStatus === 'resigned') && !reason?.trim()) {
    return res.status(400).json({ error: `Formal reason is required when marking an employee as ${nextStatus}.` });
  }

  const isOffboarded = nextStatus === 'inactive' || nextStatus === 'resigned' || nextStatus === 'terminated';
  const termDate = nextStatus === 'terminated' || nextStatus === 'resigned' ? await getClinicToday() : null;

  // Non-destructive offboarding: find linked system accounts, revoke sessions, and deactivate on any offboarded status without deleting clinical/financial/audit history
  const linkedUsers = await query<{ id: number; email: string }>(
    'SELECT id, email FROM users WHERE employee_id = ? OR id = ?',
    [id, emp.user_id || -1]
  );

  // Re-hire safeguard: keep access_review_required = 1 when transitioning back to 'active' if linked user accounts exist
  const requiresAccessReview = isOffboarded ? 1 : linkedUsers.length > 0 && emp.status !== 'active' ? 1 : 0;

  await execute(
    'UPDATE hr_employees SET status = ?, terminated_at = ?, termination_reason = ?, access_review_required = ?, updated_at = ? WHERE id = ?',
    [nextStatus, termDate, reason?.trim() || null, requiresAccessReview, nowSql(), id]
  );

  let totalRevokedSessions = 0;
  for (const lu of linkedUsers) {
    await execute('UPDATE staff_contracts SET status = ?, updated_at = ? WHERE user_id = ?', [
      nextStatus === 'active' ? 'active' : 'terminated',
      nowSql(),
      lu.id,
    ]);
    if (isOffboarded) {
      await execute("UPDATE users SET active = 0, status = 'inactive', updated_at = ? WHERE id = ?", [nowSql(), lu.id]);
      totalRevokedSessions += await revokeAllUserSessions(lu.id, req.user!.id);
    }
    // Note: when nextStatus === 'active' (re-hire), linked user accounts remain inactive until explicitly reviewed & activated by System Administration.
  }

  if (isOffboarded && linkedUsers.length > 0) {
    await createNotification({
      targetRole: 'ADM',
      title: 'Access Review Required: HR Offboarding',
      message: `HR marked ${emp.employee_number} (${emp.full_name}) as ${nextStatus}. ${linkedUsers.length} linked account(s) deactivated and ${totalRevokedSessions} active session(s) revoked.`,
      severity: 'warning',
      entityType: 'hr_employee',
      entityId: id,
    });
  } else if (nextStatus === 'active' && emp.status !== 'active' && linkedUsers.length > 0) {
    await createNotification({
      targetRole: 'ADM',
      title: 'Re-Hired Staff Access Review Required',
      message: `HR reactivated ${emp.employee_number} (${emp.full_name}). Linked user account(s) remain disabled pending explicit Administrator review and reactivation.`,
      severity: 'warning',
      entityType: 'hr_employee',
      entityId: id,
    });
    await writeAuditLog({
      user: req.user,
      action: 'hr.employee.rehired_pending_admin_review',
      entityType: 'hr_employee',
      entityId: id,
      before: { status: emp.status },
      after: { status: nextStatus, linkedUsers: linkedUsers.map((u) => u.id), userAccountsKeptInactive: true },
      reason: reason?.trim() || null,
      req,
    });
  }

  await writeAuditLog({
    user: req.user,
    action: `hr.employee.${nextStatus}`,
    entityType: 'hr_employee',
    entityId: id,
    before: { status: emp.status },
    after: {
      status: nextStatus,
      terminated_at: termDate,
      access_review_required: Boolean(requiresAccessReview),
      linkedUsers: linkedUsers.map((u) => u.id),
      revokedSessions: totalRevokedSessions,
    },
    reason: reason?.trim() || null,
    req,
  });
  res.json({ ok: true, status: nextStatus, accessReviewRequired: Boolean(requiresAccessReview), revokedSessions: totalRevokedSessions });
});

router.post('/hr/employees/:id/documents', requireAuth, requirePermission('hr.manage'), async (req: AuthRequest, res: Response) => {
  const empId = Number(req.params.id);
  const { doc_type = 'contract', title, file_ref, expiry_date, notes } = req.body || {};
  if (!title?.trim()) return res.status(400).json({ error: 'Document title is required.' });
  const emp = await queryOne('SELECT id FROM hr_employees WHERE id = ?', [empId]);
  if (!emp) return res.status(404).json({ error: 'Employee not found.' });

  const ins = await execute(
    'INSERT INTO hr_employee_documents (employee_id, doc_type, title, file_ref, expiry_date, notes, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [empId, doc_type, title.trim(), file_ref?.trim() || null, expiry_date || null, notes?.trim() || null, req.user!.id]
  );
  await writeAuditLog({
    user: req.user,
    action: 'hr.employee.document.add',
    entityType: 'hr_employee_document',
    entityId: ins.insertId,
    after: { employee_id: empId, doc_type, title },
    req,
  });
  res.status(201).json({ id: ins.insertId });
});

router.delete('/hr/documents/:docId', requireAuth, requirePermission('hr.manage'), async (req: AuthRequest, res: Response) => {
  const docId = Number(req.params.docId);
  const doc = await queryOne('SELECT * FROM hr_employee_documents WHERE id = ?', [docId]);
  if (!doc) return res.status(404).json({ error: 'Document not found.' });
  await execute('DELETE FROM hr_employee_documents WHERE id = ?', [docId]);
  await writeAuditLog({ user: req.user, action: 'hr.employee.document.delete', entityType: 'hr_employee_document', entityId: docId, before: doc, req });
  res.json({ ok: true });
});

router.post('/hr/attendance', requireAuth, requirePermission('hr.attendance.manage', 'hr.manage'), async (req: AuthRequest, res: Response) => {
  const { employee_id, attendance_date, check_in, check_out, status, hours_worked, notes } = req.body || {};
  if (!employee_id || !attendance_date) {
    return res.status(400).json({ error: 'Employee and attendance date are required.' });
  }
  const emp = await queryOne<{ id: number; user_id: number | null }>('SELECT id, user_id FROM hr_employees WHERE id = ?', [Number(employee_id)]);
  if (!emp) return res.status(404).json({ error: 'Employee not found.' });

  const metrics = computeAttendanceMetrics(check_in, check_out);
  const finalHours = hours_worked !== undefined && hours_worked !== '' ? Number(hours_worked) : metrics.hoursWorked;
  const derivedStatus =
    status && ['present', 'late', 'early_departure', 'absent', 'on_leave'].includes(status)
      ? status
      : metrics.lateMinutes > 0
        ? 'late'
        : metrics.earlyLeaveMinutes > 0
          ? 'early_departure'
          : 'present';

  const existing = await queryOne<{ id: number }>('SELECT id FROM hr_attendance WHERE employee_id = ? AND attendance_date = ?', [emp.id, attendance_date]);
  if (existing) {
    await execute(
      `UPDATE hr_attendance
       SET check_in = ?, check_out = ?, hours_worked = ?, status = ?, late_minutes = ?, early_leave_minutes = ?, notes = ?, updated_by = ?, updated_at = ?
       WHERE id = ?`,
      [check_in || null, check_out || null, finalHours, derivedStatus, metrics.lateMinutes, metrics.earlyLeaveMinutes, notes?.trim() || null, req.user!.id, nowSql(), existing.id]
    );
    await writeAuditLog({
      user: req.user,
      action: 'hr.attendance.update',
      entityType: 'hr_attendance',
      entityId: existing.id,
      after: { employee_id: emp.id, attendance_date, status: derivedStatus, hours_worked: finalHours },
      req,
    });
    return res.json({ id: existing.id, updated: true, status: derivedStatus, hours_worked: finalHours });
  }

  const ins = await execute(
    `INSERT INTO hr_attendance (employee_id, user_id, attendance_date, check_in, check_out, hours_worked, status, late_minutes, early_leave_minutes, notes, recorded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [emp.id, emp.user_id, attendance_date, check_in || null, check_out || null, finalHours, derivedStatus, metrics.lateMinutes, metrics.earlyLeaveMinutes, notes?.trim() || null, req.user!.id]
  );
  await writeAuditLog({
    user: req.user,
    action: 'hr.attendance.record',
    entityType: 'hr_attendance',
    entityId: ins.insertId,
    after: { employee_id: emp.id, attendance_date, status: derivedStatus, hours_worked: finalHours },
    req,
  });
  res.status(201).json({ id: ins.insertId, status: derivedStatus, hours_worked: finalHours });
});

router.put('/hr/attendance/:id', requireAuth, requirePermission('hr.attendance.manage', 'hr.manage'), async (req: AuthRequest, res: Response) => {
  const id = Number(req.params.id);
  const prev = await queryOne('SELECT * FROM hr_attendance WHERE id = ?', [id]);
  if (!prev) return res.status(404).json({ error: 'Attendance record not found.' });
  const { check_in, check_out, status, hours_worked, notes } = req.body || {};
  const metrics = computeAttendanceMetrics(check_in, check_out);
  const finalHours = hours_worked !== undefined && hours_worked !== '' ? Number(hours_worked) : metrics.hoursWorked;
  await execute(
    `UPDATE hr_attendance SET check_in = ?, check_out = ?, hours_worked = ?, status = ?, late_minutes = ?, early_leave_minutes = ?, notes = ?, updated_by = ?, updated_at = ? WHERE id = ?`,
    [check_in || null, check_out || null, finalHours, status || 'present', metrics.lateMinutes, metrics.earlyLeaveMinutes, notes?.trim() || null, req.user!.id, nowSql(), id]
  );
  await writeAuditLog({ user: req.user, action: 'hr.attendance.correct', entityType: 'hr_attendance', entityId: id, before: prev, after: { check_in, check_out, status, hours_worked: finalHours, notes }, req });
  res.json({ ok: true });
});

router.post('/hr/leave-types', requireAuth, requirePermission('hr.manage'), async (req: AuthRequest, res: Response) => {
  const { code, name, annual_allowance_days = 0, paid = true, description } = req.body || {};
  const cleanCode = String(code || '').trim().toLowerCase();
  if (!cleanCode || !name?.trim()) return res.status(400).json({ error: 'Code and name are required.' });
  const existing = await queryOne<{ id: number }>('SELECT id FROM hr_leave_types WHERE code = ?', [cleanCode]);
  if (existing) {
    await execute(
      'UPDATE hr_leave_types SET name = ?, annual_allowance_days = ?, paid = ?, description = ?, active = 1 WHERE id = ?',
      [name.trim(), Number(annual_allowance_days || 0), paid ? 1 : 0, description?.trim() || null, existing.id]
    );
    return res.json({ id: existing.id, updated: true });
  }
  const ins = await execute(
    'INSERT INTO hr_leave_types (code, name, annual_allowance_days, paid, description, active) VALUES (?, ?, ?, ?, ?, 1)',
    [cleanCode, name.trim(), Number(annual_allowance_days || 0), paid ? 1 : 0, description?.trim() || null]
  );
  res.status(201).json({ id: ins.insertId });
});

router.post('/hr/contracts', requireAuth, requirePermission('hr.manage'), async (req: AuthRequest, res: Response) => {
  const { user_id, employee_code, department_name, contract_type = 'full_time', base_salary, housing_allowance = 0, licence_number, licence_expiry, contract_start, contract_end } = req.body || {};
  if (!user_id || !employee_code?.trim() || !department_name?.trim() || Number(base_salary) <= 0 || !contract_start) {
    return res.status(400).json({ error: 'Staff member, employee code, department, positive base salary, and start date are required.' });
  }

  const existing = await queryOne<{ id: number }>('SELECT id FROM staff_contracts WHERE user_id = ?', [Number(user_id)]);
  if (existing) {
    await execute(
      `UPDATE staff_contracts SET employee_code = ?, department_name = ?, contract_type = ?, base_salary = ?, housing_allowance = ?, licence_number = ?, licence_expiry = ?, contract_start = ?, contract_end = ?, updated_at = ? WHERE id = ?`,
      [employee_code.trim(), department_name.trim(), contract_type, Number(base_salary), Number(housing_allowance || 0), licence_number || null, licence_expiry || null, contract_start, contract_end || null, nowSql(), existing.id]
    );
    await execute(
      `UPDATE hr_employees SET employee_number = ?, department_name = ?, employment_type = ?, basic_salary = ?, housing_allowance = ?, licence_number = ?, licence_expiry = ?, contract_start = ?, contract_end = ?, updated_at = ? WHERE user_id = ?`,
      [employee_code.trim(), department_name.trim(), contract_type, Number(base_salary), Number(housing_allowance || 0), licence_number || null, licence_expiry || null, contract_start, contract_end || null, nowSql(), Number(user_id)]
    );
    await writeAuditLog({
      user: req.user,
      action: 'hr.contract.update',
      entityType: 'staff_contract',
      entityId: existing.id,
      after: { employee_code, base_salary, licence_expiry, contract_end },
      req,
    });
    return res.json({ id: existing.id, updated: true });
  }

  const inserted = await execute(
    `INSERT INTO staff_contracts (user_id, employee_code, department_name, contract_type, base_salary, housing_allowance, licence_number, licence_expiry, contract_start, contract_end, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
    [Number(user_id), employee_code.trim(), department_name.trim(), contract_type, Number(base_salary), Number(housing_allowance || 0), licence_number || null, licence_expiry || null, contract_start, contract_end || null]
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
  const { user_id, employee_id, leave_type = 'annual', start_date, end_date, reason } = req.body || {};
  if (!start_date || !end_date || !reason?.trim()) {
    return res.status(400).json({ error: 'Start date, end date, and reason are required.' });
  }
  const sMs = new Date(start_date).getTime();
  const eMs = new Date(end_date).getTime();
  if (Number.isNaN(sMs) || Number.isNaN(eMs) || eMs < sMs) {
    return res.status(400).json({ error: 'End date must be on or after start date.' });
  }
  const daysCount = Math.max(1, Math.round((eMs - sMs) / 86400000) + 1);
  if (daysCount > 90) {
    return res.status(400).json({ error: 'Single leave request cannot exceed 90 days.' });
  }

  let resolvedEmpId: number | null = null;
  let resolvedUserId: number | null = req.user!.id;
  if (hasPermission(req.user!, 'hr.manage') && employee_id) {
    const emp = await queryOne<{ id: number; user_id: number | null }>('SELECT id, user_id FROM hr_employees WHERE id = ?', [Number(employee_id)]);
    if (!emp) return res.status(404).json({ error: 'Employee not found.' });
    resolvedEmpId = emp.id;
    resolvedUserId = emp.user_id ?? null;
  } else if (hasPermission(req.user!, 'hr.manage') && user_id) {
    resolvedUserId = Number(user_id);
    const emp = await queryOne<{ id: number }>('SELECT id FROM hr_employees WHERE user_id = ?', [resolvedUserId]);
    resolvedEmpId = emp?.id ?? null;
  } else {
    const emp = await queryOne<{ id: number }>('SELECT id FROM hr_employees WHERE user_id = ?', [req.user!.id]);
    resolvedEmpId = emp?.id ?? null;
  }

  const inserted = await execute(
    "INSERT INTO leave_requests (user_id, employee_id, leave_type, start_date, end_date, days_count, reason, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')",
    [resolvedUserId, resolvedEmpId, String(leave_type).toLowerCase(), start_date, end_date, daysCount, reason.trim()]
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
    after: { resolvedUserId, resolvedEmpId, leave_type, start_date, end_date, daysCount },
    req,
  });
  res.status(201).json({ id: inserted.insertId, daysCount });
});

router.post('/hr/leave/:id/decide', requireAuth, requirePermission('hr.manage'), async (req: AuthRequest, res: Response) => {
  const id = Number(req.params.id);
  const { decision, decision_note } = req.body || {};
  if (!['approved', 'rejected', 'cancelled'].includes(decision)) {
    return res.status(400).json({ error: 'Decision must be approved, rejected, or cancelled.' });
  }
  if (decision === 'rejected' && !decision_note?.trim()) {
    return res.status(400).json({ error: 'A formal rejection reason is required.' });
  }

  const result = await withTransaction(async () => {
    const lr = await queryOne<{ id: number; user_id: number | null; employee_id: number | null; start_date: string; end_date: string; leave_type: string; status: string }>(
      'SELECT * FROM leave_requests WHERE id = ?',
      [id]
    );
    if (!lr) return { ok: false as const, error: 'Leave request not found', httpStatus: 404 };

    if (decision === 'cancelled') {
      if (!['pending', 'approved'].includes(lr.status)) {
        return { ok: false as const, error: 'Only pending or approved leave can be cancelled.', httpStatus: 409 };
      }
      await execute('UPDATE leave_requests SET status = ?, decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?', [
        'cancelled',
        req.user!.id,
        nowSql(),
        decision_note?.trim() || null,
        id,
      ]);
      await execute('DELETE FROM doctor_blocks WHERE source_leave_id = ?', [id]);
      await writeAuditLog({
        user: req.user,
        action: 'hr.leave.cancelled',
        entityType: 'leave_request',
        entityId: id,
        reason: decision_note?.trim() || null,
        req,
      });
      return { ok: true as const, decision: 'cancelled', blocksCreated: 0, conflictingAppointments: [] };
    }

    if (lr.status !== 'pending') return { ok: false as const, error: 'Leave request already decided.', httpStatus: 409 };
    if (lr.user_id) {
      assertDifferentUser(req.user!.id, lr.user_id, 'approve or reject your own leave request');
    }

    await execute('UPDATE leave_requests SET status = ?, decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?', [
      decision,
      req.user!.id,
      nowSql(),
      decision_note?.trim() || null,
      id,
    ]);

    let blocksCreated = 0;
    let conflictingAppointments: Array<{ id: number; appointment_date: string; start_time: string }> = [];
    if (decision === 'approved' && lr.user_id) {
      const isDoc = await queryOne<{ cnt: number }>(
        `SELECT COUNT(*) AS cnt FROM user_roles ur INNER JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ? AND r.code = 'DOC'`,
        [lr.user_id]
      );
      if (Number(isDoc?.cnt || 0) > 0) {
        const start = new Date(`${lr.start_date}T00:00:00Z`);
        const end = new Date(`${lr.end_date}T00:00:00Z`);
        for (let d = new Date(start); d <= end && blocksCreated < 90; d.setUTCDate(d.getUTCDate() + 1)) {
          const dateStr = d.toISOString().slice(0, 10);
          await execute(
            "INSERT INTO doctor_blocks (doctor_id, block_date, start_time, end_time, block_type, reason, source_leave_id, created_by) VALUES (?, ?, '08:00', '17:00', 'leave', ?, ?, ?)",
            [lr.user_id, dateStr, `Approved ${lr.leave_type} leave`, id, req.user!.id]
          );
          blocksCreated++;
        }
        conflictingAppointments = await query<{ id: number; appointment_date: string; start_time: string }>(
          `SELECT id, appointment_date, start_time FROM appointments
           WHERE doctor_id = ? AND appointment_date BETWEEN ? AND ? AND status IN ('scheduled','checked_in')`,
          [lr.user_id, lr.start_date, lr.end_date]
        );
        if (conflictingAppointments.length > 0) {
          await createNotification({
            targetRole: 'REC',
            title: 'Reschedule Needed: Clinician Leave Approved',
            message: `${conflictingAppointments.length} appointment(s) overlap approved leave (${lr.start_date} – ${lr.end_date}).`,
            severity: 'warning',
            entityType: 'leave_request',
            entityId: id,
          });
        }
      }
    }

    await writeAuditLog({
      user: req.user,
      action: `hr.leave.${decision}`,
      entityType: 'leave_request',
      entityId: id,
      after: { decision, blocksCreated, conflictingCount: conflictingAppointments.length },
      reason: decision_note?.trim() || null,
      req,
    });
    return { ok: true as const, decision, blocksCreated, conflictingAppointments };
  });

  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error });
  res.json(result);
});

router.post('/hr/overtime', requireAuth, requirePermission('hr.overtime.manage', 'hr.manage'), async (req: AuthRequest, res: Response) => {
  const { employee_id, overtime_date, hours, day_type = 'regular', rate_multiplier, reason } = req.body || {};
  const hrs = Number(hours || 0);
  if (!employee_id || !overtime_date || hrs <= 0 || !reason?.trim()) {
    return res.status(400).json({ error: 'Employee, overtime date, positive hours, and reason are required.' });
  }
  const emp = await queryOne<{ id: number; user_id: number | null; basic_salary: number }>('SELECT id, user_id, basic_salary FROM hr_employees WHERE id = ?', [Number(employee_id)]);
  if (!emp) return res.status(404).json({ error: 'Employee not found.' });

  const defaultMult = day_type === 'holiday' ? 2.5 : day_type === 'weekend' ? 2.0 : 1.5;
  const mult = Number(rate_multiplier || defaultMult);
  const hourlyRate = Number((Number(emp.basic_salary) / 160).toFixed(2));
  const amount = Number((hrs * hourlyRate * mult).toFixed(2));

  const ins = await execute(
    `INSERT INTO hr_overtime (employee_id, user_id, overtime_date, hours, day_type, rate_multiplier, hourly_rate_snapshot, computed_amount, reason, status, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    [emp.id, emp.user_id, overtime_date, hrs, day_type, mult, hourlyRate, amount, reason.trim(), req.user!.id]
  );
  await writeAuditLog({
    user: req.user,
    action: 'hr.overtime.create',
    entityType: 'hr_overtime',
    entityId: ins.insertId,
    after: { employee_id: emp.id, overtime_date, hours: hrs, day_type, mult, computed_amount: amount },
    req,
  });
  res.status(201).json({ id: ins.insertId, computed_amount: amount });
});

router.post('/hr/overtime/:id/decide', requireAuth, requirePermission('hr.overtime.manage', 'hr.manage'), async (req: AuthRequest, res: Response) => {
  const id = Number(req.params.id);
  const { decision, decision_note } = req.body || {};
  if (!['approved', 'rejected'].includes(decision)) {
    return res.status(400).json({ error: 'Decision must be approved or rejected.' });
  }
  const ot = await queryOne<{ id: number; user_id: number | null; status: string }>('SELECT id, user_id, status FROM hr_overtime WHERE id = ?', [id]);
  if (!ot) return res.status(404).json({ error: 'Overtime record not found.' });
  if (ot.status !== 'pending') return res.status(409).json({ error: 'Overtime record already decided.' });
  if (ot.user_id && ot.user_id === req.user!.id) {
    return res.status(403).json({ error: 'Segregation of duties violation: cannot approve or reject your own overtime.' });
  }

  await execute('UPDATE hr_overtime SET status = ?, decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?', [
    decision,
    req.user!.id,
    nowSql(),
    decision_note?.trim() || null,
    id,
  ]);
  await writeAuditLog({ user: req.user, action: `hr.overtime.${decision}`, entityType: 'hr_overtime', entityId: id, reason: decision_note || null, req });
  res.json({ ok: true, status: decision });
});

router.post('/hr/adjustments', requireAuth, requirePermission('hr.manage', 'hr.payroll.submit'), async (req: AuthRequest, res: Response) => {
  const { employee_id, adjustment_type, category, description, amount, effective_month, effective_date, recurring = false } = req.body || {};
  const amt = Number(Number(amount || 0).toFixed(2));
  if (!employee_id || !['earning', 'deduction'].includes(String(adjustment_type)) || !category?.trim() || !description?.trim() || amt <= 0) {
    return res.status(400).json({ error: 'Employee, type (earning/deduction), category, description, and positive amount are required.' });
  }
  const emp = await queryOne<{ id: number; user_id: number | null }>('SELECT id, user_id FROM hr_employees WHERE id = ?', [Number(employee_id)]);
  if (!emp) return res.status(404).json({ error: 'Employee not found.' });
  const effDate = effective_date || (await getClinicToday());
  const effMonth = effective_month || effDate.slice(0, 7);

  const ins = await execute(
    `INSERT INTO hr_adjustments (employee_id, user_id, adjustment_type, category, description, amount, effective_month, effective_date, recurring, status, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
    [emp.id, emp.user_id, adjustment_type, category.trim(), description.trim(), amt, effMonth, effDate, recurring ? 1 : 0, req.user!.id]
  );
  await writeAuditLog({
    user: req.user,
    action: 'hr.adjustment.create',
    entityType: 'hr_adjustment',
    entityId: ins.insertId,
    after: { employee_id: emp.id, adjustment_type, category, amount: amt, effective_month: effMonth, recurring },
    req,
  });
  res.status(201).json({ id: ins.insertId });
});

router.patch('/hr/adjustments/:id/cancel', requireAuth, requirePermission('hr.manage', 'hr.payroll.submit'), async (req: AuthRequest, res: Response) => {
  const id = Number(req.params.id);
  await execute("UPDATE hr_adjustments SET status = 'cancelled' WHERE id = ?", [id]);
  await writeAuditLog({ user: req.user, action: 'hr.adjustment.cancel', entityType: 'hr_adjustment', entityId: id, req });
  res.json({ ok: true });
});

router.post('/hr/payroll-inputs/submit', requireAuth, requirePermission('hr.payroll.submit', 'hr.manage'), async (req: AuthRequest, res: Response) => {
  const payMonth = String(req.body?.pay_month || new Date().toISOString().slice(0, 7));
  const notes = req.body?.notes ? String(req.body.notes).trim() : null;
  if (!/^\d{4}-\d{2}$/.test(payMonth)) {
    return res.status(400).json({ error: 'pay_month must be formatted as YYYY-MM.' });
  }
  const monthStart = `${payMonth}-01`;
  const [yr, mo] = payMonth.split('-').map(Number);
  const monthEnd = new Date(Date.UTC(yr, mo, 0)).toISOString().slice(0, 10);

  const [emps, attSum, otSum, adjEarn, adjDed] = await Promise.all([
    queryOne<{ cnt: number }>(
      "SELECT COUNT(*) AS cnt FROM hr_employees WHERE status = 'active' AND contract_start <= ? AND (contract_end IS NULL OR contract_end >= ?)",
      [monthEnd, monthStart]
    ),
    queryOne<{ hrs: number }>(
      'SELECT COALESCE(SUM(hours_worked), 0) AS hrs FROM hr_attendance WHERE substr(attendance_date, 1, 7) = ?',
      [payMonth]
    ),
    queryOne<{ amt: number }>(
      "SELECT COALESCE(SUM(computed_amount), 0) AS amt FROM hr_overtime WHERE status = 'approved' AND substr(overtime_date, 1, 7) = ?",
      [payMonth]
    ),
    queryOne<{ amt: number }>(
      "SELECT COALESCE(SUM(amount), 0) AS amt FROM hr_adjustments WHERE status = 'active' AND adjustment_type = 'earning' AND (effective_month = ? OR recurring = 1)",
      [payMonth]
    ),
    queryOne<{ amt: number }>(
      "SELECT COALESCE(SUM(amount), 0) AS amt FROM hr_adjustments WHERE status = 'active' AND adjustment_type = 'deduction' AND (effective_month = ? OR recurring = 1)",
      [payMonth]
    ),
  ]);

  const totalEmployees = Number(emps?.cnt || 0);
  const totalAttendanceHours = Number(Number(attSum?.hrs || 0).toFixed(2));
  const totalOvertimeAmount = Number(Number(otSum?.amt || 0).toFixed(2));
  const totalExtraEarnings = Number(Number(adjEarn?.amt || 0).toFixed(2));
  const totalExtraDeductions = Number(Number(adjDed?.amt || 0).toFixed(2));

  const existing = await queryOne<{ id: number; status: string }>('SELECT id, status FROM hr_monthly_submissions WHERE pay_month = ?', [payMonth]);
  if (existing) {
    if (existing.status === 'processed') {
      return res.status(409).json({ error: `Payroll inputs for ${payMonth} have already been processed into a payroll run.` });
    }
    await execute(
      `UPDATE hr_monthly_submissions
       SET status = 'submitted', total_employees = ?, total_attendance_hours = ?, total_overtime_amount = ?, total_extra_earnings = ?, total_extra_deductions = ?, notes = ?, submitted_by = ?, submitted_at = ?
       WHERE id = ?`,
      [totalEmployees, totalAttendanceHours, totalOvertimeAmount, totalExtraEarnings, totalExtraDeductions, notes, req.user!.id, nowSql(), existing.id]
    );
  } else {
    await execute(
      `INSERT INTO hr_monthly_submissions (pay_month, status, total_employees, total_attendance_hours, total_overtime_amount, total_extra_earnings, total_extra_deductions, notes, submitted_by)
       VALUES (?, 'submitted', ?, ?, ?, ?, ?, ?, ?)`,
      [payMonth, totalEmployees, totalAttendanceHours, totalOvertimeAmount, totalExtraEarnings, totalExtraDeductions, notes, req.user!.id]
    );
  }

  await createNotification({
    targetRole: 'ACC',
    title: 'HR Monthly Payroll Inputs Ready',
    message: `HR submitted ${payMonth} payroll inputs (${totalEmployees} active employees, $${totalOvertimeAmount.toFixed(2)} approved OT) for Finance payroll generation.`,
    severity: 'info',
    entityType: 'hr_monthly_submission',
  });
  await writeAuditLog({
    user: req.user,
    action: 'hr.payroll_inputs.submit',
    entityType: 'hr_monthly_submission',
    entityId: payMonth,
    after: { payMonth, totalEmployees, totalAttendanceHours, totalOvertimeAmount, totalExtraEarnings, totalExtraDeductions },
    req,
  });

  res.json({
    ok: true,
    payMonth,
    totalEmployees,
    totalAttendanceHours,
    totalOvertimeAmount,
    totalExtraEarnings,
    totalExtraDeductions,
  });
});

router.get(
  '/hr/reports/:type',
  requireAuth,
  requirePermission('hr.manage', 'hr.attendance.manage', 'hr.overtime.manage', 'hr.payroll.submit', 'finance.report.view', 'audit.read'),
  async (req: AuthRequest, res: Response) => {
    const type = req.params.type;
    const month = req.query.month ? String(req.query.month).slice(0, 7) : new Date().toISOString().slice(0, 7);

    if (type === 'employees') {
      const rows = await query(
        `SELECT employee_number, full_name, gender, department_name, job_position, employment_type,
                hire_date, contract_start, contract_end, basic_salary, housing_allowance, status
         FROM hr_employees
         ORDER BY department_name ASC, full_name ASC`
      );
      return res.json({ reportType: type, month, rows });
    }
    if (type === 'attendance') {
      const rows = await query(
        `SELECT he.employee_number, he.full_name, he.department_name,
                COUNT(att.id) AS days_logged,
                SUM(CASE WHEN att.status IN ('present','late','early_departure') THEN 1 ELSE 0 END) AS days_present,
                SUM(CASE WHEN att.status = 'absent' THEN 1 ELSE 0 END) AS days_absent,
                SUM(CASE WHEN att.status = 'late' THEN 1 ELSE 0 END) AS late_days,
                ROUND(COALESCE(SUM(att.hours_worked), 0), 2) AS total_hours
         FROM hr_employees he
         LEFT JOIN hr_attendance att ON att.employee_id = he.id AND substr(att.attendance_date, 1, 7) = ?
         GROUP BY he.id
         ORDER BY he.department_name, he.full_name`,
        [month]
      );
      return res.json({ reportType: type, month, rows });
    }
    if (type === 'absenteeism') {
      const rows = await query(
        `SELECT he.employee_number, he.full_name, he.department_name, att.attendance_date, att.status, att.notes
         FROM hr_attendance att
         INNER JOIN hr_employees he ON he.id = att.employee_id
         WHERE substr(att.attendance_date, 1, 7) = ? AND att.status = 'absent'
         ORDER BY att.attendance_date DESC`,
        [month]
      );
      return res.json({ reportType: type, month, rows });
    }
    if (type === 'late') {
      const rows = await query(
        `SELECT he.employee_number, he.full_name, he.department_name, att.attendance_date,
                att.check_in, att.check_out, att.late_minutes, att.early_leave_minutes, att.status
         FROM hr_attendance att
         INNER JOIN hr_employees he ON he.id = att.employee_id
         WHERE substr(att.attendance_date, 1, 7) = ? AND (att.late_minutes > 0 OR att.early_leave_minutes > 0 OR att.status IN ('late','early_departure'))
         ORDER BY att.attendance_date DESC`,
        [month]
      );
      return res.json({ reportType: type, month, rows });
    }
    if (type === 'leave-balances') {
      const yr = month.slice(0, 4);
      const rows = await query(
        `SELECT he.employee_number, he.full_name, he.department_name, lt.name AS leave_type, lt.annual_allowance_days,
                COALESCE((SELECT SUM(lr.days_count) FROM leave_requests lr WHERE (lr.employee_id = he.id OR (lr.employee_id IS NULL AND lr.user_id = he.user_id)) AND LOWER(lr.leave_type) = lt.code AND lr.status = 'approved' AND substr(lr.start_date, 1, 4) = ?), 0) AS used_days
         FROM hr_employees he
         CROSS JOIN hr_leave_types lt
         WHERE he.status = 'active' AND lt.active = 1 AND lt.annual_allowance_days > 0
         ORDER BY he.full_name, lt.id`,
        [yr]
      );
      return res.json({
        reportType: type,
        month,
        rows: rows.map((r) => ({ ...r, remaining_days: Math.max(0, Number(r.annual_allowance_days) - Number(r.used_days)) })),
      });
    }
    if (type === 'leave-utilization') {
      const rows = await query(
        `SELECT COALESCE(he.employee_number, 'USR') AS employee_number,
                COALESCE(he.full_name, u.full_name) AS staff_name,
                he.department_name, lr.leave_type, lr.start_date, lr.end_date, lr.days_count, lr.status, lr.reason
         FROM leave_requests lr
         LEFT JOIN hr_employees he ON (he.id = lr.employee_id OR (lr.employee_id IS NULL AND he.user_id = lr.user_id))
         LEFT JOIN users u ON u.id = lr.user_id
         ORDER BY lr.start_date DESC LIMIT 100`
      );
      return res.json({ reportType: type, month, rows });
    }
    if (type === 'overtime') {
      const rows = await query(
        `SELECT he.employee_number, he.full_name, he.department_name, ot.overtime_date,
                ot.day_type, ot.hours, ot.rate_multiplier, ot.computed_amount, ot.status, ot.reason
         FROM hr_overtime ot
         INNER JOIN hr_employees he ON he.id = ot.employee_id
         WHERE substr(ot.overtime_date, 1, 7) = ?
         ORDER BY ot.overtime_date DESC`,
        [month]
      );
      return res.json({ reportType: type, month, rows });
    }
    if (type === 'earnings-deductions') {
      const rows = await query(
        `SELECT he.employee_number, he.full_name, he.department_name, adj.adjustment_type,
                adj.category, adj.description, adj.amount, adj.effective_month, adj.recurring, adj.status
         FROM hr_adjustments adj
         INNER JOIN hr_employees he ON he.id = adj.employee_id
         WHERE adj.effective_month = ? OR adj.recurring = 1
         ORDER BY adj.adjustment_type, he.full_name`,
        [month]
      );
      return res.json({ reportType: type, month, rows });
    }
    if (type === 'turnover') {
      const rows = await query(
        `SELECT employee_number, full_name, department_name, job_position, employment_type,
                hire_date, status, terminated_at, termination_reason
         FROM hr_employees
         WHERE status IN ('inactive', 'terminated')
         ORDER BY terminated_at DESC, id DESC`
      );
      return res.json({ reportType: type, month, rows });
    }
    return res.status(400).json({ error: 'Unknown HR report type.' });
  }
);

async function generatePayrollRunHandler(req: AuthRequest, res: Response) {
  const payMonth = String(req.body?.pay_month || new Date().toISOString().slice(0, 7));
  if (!/^\d{4}-\d{2}$/.test(payMonth)) {
    return res.status(400).json({ error: 'pay_month must be YYYY-MM.' });
  }
  const monthStart = `${payMonth}-01`;
  const [yr, mo] = payMonth.split('-').map(Number);
  const monthEnd = new Date(Date.UTC(yr, mo, 0)).toISOString().slice(0, 10);

  const result = await withTransaction(async () => {
    const existing = await queryOne<{ id: number; run_number: string }>(
      "SELECT id, run_number FROM payroll_runs WHERE pay_month = ? AND status != 'rejected'",
      [payMonth]
    );
    if (existing) {
      return { ok: false as const, error: `Payroll run for ${payMonth} already exists (${existing.run_number}).`, httpStatus: 409 };
    }

    const employees = await query<{
      id: number;
      user_id: number | null;
      full_name: string;
      role_code: string;
      basic_salary: number;
      housing_allowance: number;
    }>(
      `SELECT he.id, he.user_id, he.full_name,
              COALESCE((SELECT r.code FROM user_roles ur INNER JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = he.user_id ORDER BY ur.role_id ASC LIMIT 1), 'EMP') AS role_code,
              he.basic_salary, he.housing_allowance
       FROM hr_employees he
       WHERE he.status = 'active'
         AND he.contract_start <= ?
         AND (he.contract_end IS NULL OR he.contract_end >= ?)`,
      [monthEnd, monthStart]
    );

    if (employees.length === 0) {
      return { ok: false as const, error: 'No active employees eligible for this pay period.', httpStatus: 400 };
    }

    const [approvedOts, activeAdjs, unpaidLeaves, absentDays] = await Promise.all([
      query<{ id: number; employee_id: number; computed_amount: number }>(
        "SELECT id, employee_id, computed_amount FROM hr_overtime WHERE status = 'approved' AND payroll_run_id IS NULL AND substr(overtime_date, 1, 7) = ?",
        [payMonth]
      ),
      query<{ employee_id: number; adjustment_type: string; category: string; amount: number }>(
        "SELECT employee_id, adjustment_type, category, amount FROM hr_adjustments WHERE status = 'active' AND (effective_month = ? OR recurring = 1)",
        [payMonth]
      ),
      query<{ employee_id: number | null; user_id: number | null; days_count: number }>(
        "SELECT employee_id, user_id, days_count FROM leave_requests WHERE status = 'approved' AND LOWER(leave_type) = 'unpaid' AND substr(start_date, 1, 7) = ?",
        [payMonth]
      ),
      query<{ employee_id: number; cnt: number }>(
        "SELECT employee_id, COUNT(*) AS cnt FROM hr_attendance WHERE status = 'absent' AND substr(attendance_date, 1, 7) = ? GROUP BY employee_id",
        [payMonth]
      ),
    ]);

    const otByEmp = new Map<number, number>();
    const consumedOtIds: number[] = [];
    for (const o of approvedOts) {
      otByEmp.set(Number(o.employee_id), Number(((otByEmp.get(Number(o.employee_id)) || 0) + Number(o.computed_amount || 0)).toFixed(2)));
      consumedOtIds.push(o.id);
    }

    const allowAdjByEmp = new Map<number, number>();
    const bonusByEmp = new Map<number, number>();
    const dedByEmp = new Map<number, number>();
    for (const a of activeAdjs) {
      const eid = Number(a.employee_id);
      if (a.adjustment_type === 'earning') {
        if (['Bonus', 'Incentive', 'Overtime'].includes(a.category)) {
          bonusByEmp.set(eid, Number(((bonusByEmp.get(eid) || 0) + Number(a.amount)).toFixed(2)));
        } else {
          allowAdjByEmp.set(eid, Number(((allowAdjByEmp.get(eid) || 0) + Number(a.amount)).toFixed(2)));
        }
      } else {
        dedByEmp.set(eid, Number(((dedByEmp.get(eid) || 0) + Number(a.amount)).toFixed(2)));
      }
    }

    const absentByEmp = new Map<number, number>(absentDays.map((a) => [Number(a.employee_id), Number(a.cnt || 0)]));

    const runNumber = await nextSequence('PAY');
    let totalGross = 0;
    let totalDed = 0;
    let totalNet = 0;

    const computedLines = [];
    for (const emp of employees) {
      const base = Number(emp.basic_salary);
      const allow = Number((Number(emp.housing_allowance || 0) + (allowAdjByEmp.get(emp.id) || 0)).toFixed(2));
      const otPay = otByEmp.get(emp.id) || 0;
      const bonus = bonusByEmp.get(emp.id) || 0;

      let unpaidLeaveDays = absentByEmp.get(emp.id) || 0;
      for (const ul of unpaidLeaves) {
        if ((ul.employee_id && Number(ul.employee_id) === emp.id) || (!ul.employee_id && emp.user_id && Number(ul.user_id) === emp.user_id)) {
          unpaidLeaveDays += Number(ul.days_count || 0);
        }
      }
      const unpaidDeduction = Number(((unpaidLeaveDays * base) / 22).toFixed(2));
      const otherDed = Number(((dedByEmp.get(emp.id) || 0) + unpaidDeduction).toFixed(2));

      const gross = Number((base + allow + otPay + bonus).toFixed(2));
      const pensionEe = Number((base * 0.07).toFixed(2));
      const pensionEr = Number((base * 0.11).toFixed(2));
      const taxableIncome = Math.max(0, gross - pensionEe);
      const paye = await computeProgressivePaye(taxableIncome);
      const totalEmpDed = Number((paye + pensionEe + otherDed).toFixed(2));
      const net = Math.max(0, Number((gross - totalEmpDed).toFixed(2)));

      totalGross += gross;
      totalDed += totalEmpDed;
      totalNet += net;
      computedLines.push({
        employee_id: emp.id,
        user_id: emp.user_id,
        staff_name: emp.full_name,
        role_code: emp.role_code,
        base_salary: base,
        allowances: allow,
        taxable_allowances: allow,
        overtime_pay: otPay,
        bonus_earnings: bonus,
        pension_employee: pensionEe,
        pension_employer: pensionEr,
        paye_tax: paye,
        other_deductions: otherDed,
        tax_deduction: totalEmpDed,
        net_pay: net,
      });
    }

    const runRes = await execute(
      "INSERT INTO payroll_runs (run_number, pay_month, total_gross, total_deductions, total_net, status, created_by) VALUES (?, ?, ?, ?, ?, 'draft', ?)",
      [runNumber, payMonth, Number(totalGross.toFixed(2)), Number(totalDed.toFixed(2)), Number(totalNet.toFixed(2)), req.user!.id]
    );

    for (const ln of computedLines) {
      await execute(
        `INSERT INTO payroll_items (
          payroll_run_id, user_id, employee_id, staff_name, role_code, base_salary, allowances, taxable_allowances,
          overtime_pay, bonus_earnings, pension_employee, pension_employer, paye_tax, other_deductions, tax_deduction, net_pay, paid_amount, payment_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'unpaid')`,
        [
          runRes.insertId,
          ln.user_id,
          ln.employee_id,
          ln.staff_name,
          ln.role_code,
          ln.base_salary,
          ln.allowances,
          ln.taxable_allowances,
          ln.overtime_pay,
          ln.bonus_earnings,
          ln.pension_employee,
          ln.pension_employer,
          ln.paye_tax,
          ln.other_deductions,
          ln.tax_deduction,
          ln.net_pay,
        ]
      );
    }

    for (const otId of consumedOtIds) {
      await execute('UPDATE hr_overtime SET payroll_run_id = ? WHERE id = ?', [runRes.insertId, otId]);
    }
    await execute("UPDATE hr_monthly_submissions SET status = 'processed' WHERE pay_month = ?", [payMonth]);

    await writeAuditLog({
      user: req.user,
      action: 'hr.payroll.generate',
      entityType: 'payroll_run',
      entityId: runRes.insertId,
      after: { runNumber, payMonth, headcount: computedLines.length, totalGross: Number(totalGross.toFixed(2)), totalNet: Number(totalNet.toFixed(2)) },
      req,
    });

    return { ok: true as const, id: runRes.insertId, runNumber };
  });

  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error });
  res.status(201).json(result);
}

router.post('/hr/payroll/generate', requireAuth, requirePermission('finance.payroll.generate', 'accounting.ledger.manage'), generatePayrollRunHandler);
router.post('/accounting/payroll/generate', requireAuth, requirePermission('finance.payroll.generate', 'accounting.ledger.manage'), generatePayrollRunHandler);

router.put('/hr/payroll/items/:itemId', requireAuth, requirePermission('finance.payroll.generate', 'hr.payroll.verify', 'accounting.ledger.manage'), async (req: AuthRequest, res: Response) => {
  const itemId = Number(req.params.itemId);
  const { allowances, overtime_pay, bonus_earnings, other_deductions } = req.body || {};

  const result = await withTransaction(async () => {
    const item = await queryOne<{
      id: number;
      payroll_run_id: number;
      base_salary: number;
      allowances: number;
      overtime_pay: number;
      bonus_earnings: number;
      other_deductions: number;
      run_status: string;
    }>(
      `SELECT pi.*, pr.status AS run_status FROM payroll_items pi INNER JOIN payroll_runs pr ON pr.id = pi.payroll_run_id WHERE pi.id = ?`,
      [itemId]
    );
    if (!item) return { ok: false as const, error: 'Payroll line item not found.', httpStatus: 404 };
    if (!['draft', 'verified'].includes(item.run_status)) {
      return { ok: false as const, error: 'Can only edit payroll items while run is in draft or verified status.', httpStatus: 409 };
    }

    const base = Number(item.base_salary);
    const nextAllow = allowances !== undefined ? Number(allowances) : Number(item.allowances || 0);
    const nextOt = overtime_pay !== undefined ? Number(overtime_pay) : Number(item.overtime_pay || 0);
    const nextBonus = bonus_earnings !== undefined ? Number(bonus_earnings) : Number(item.bonus_earnings || 0);
    const nextOtherDed = other_deductions !== undefined ? Number(other_deductions) : Number(item.other_deductions || 0);

    const gross = Number((base + nextAllow + nextOt + nextBonus).toFixed(2));
    const pensionEe = Number((base * 0.07).toFixed(2));
    const taxableIncome = Math.max(0, gross - pensionEe);
    const paye = await computeProgressivePaye(taxableIncome);
    const totalEmpDed = Number((paye + pensionEe + nextOtherDed).toFixed(2));
    const net = Math.max(0, Number((gross - totalEmpDed).toFixed(2)));

    await execute(
      `UPDATE payroll_items
       SET allowances = ?, taxable_allowances = ?, overtime_pay = ?, bonus_earnings = ?, other_deductions = ?, paye_tax = ?, tax_deduction = ?, net_pay = ?
       WHERE id = ?`,
      [nextAllow, nextAllow, nextOt, nextBonus, nextOtherDed, paye, totalEmpDed, net, itemId]
    );

    const allItems = await query<{ base_salary: number; allowances: number; overtime_pay: number; bonus_earnings: number; tax_deduction: number; net_pay: number }>(
      'SELECT base_salary, allowances, overtime_pay, bonus_earnings, tax_deduction, net_pay FROM payroll_items WHERE payroll_run_id = ?',
      [item.payroll_run_id]
    );
    const runGross = Number(allItems.reduce((s, r) => s + Number(r.base_salary) + Number(r.allowances) + Number(r.overtime_pay || 0) + Number(r.bonus_earnings || 0), 0).toFixed(2));
    const runDed = Number(allItems.reduce((s, r) => s + Number(r.tax_deduction), 0).toFixed(2));
    const runNet = Number(allItems.reduce((s, r) => s + Number(r.net_pay), 0).toFixed(2));
    await execute('UPDATE payroll_runs SET total_gross = ?, total_deductions = ?, total_net = ? WHERE id = ?', [
      runGross,
      runDed,
      runNet,
      item.payroll_run_id,
    ]);

    await writeAuditLog({
      user: req.user,
      action: 'hr.payroll.item.adjust',
      entityType: 'payroll_item',
      entityId: itemId,
      after: { allowances: nextAllow, overtime_pay: nextOt, bonus_earnings: nextBonus, other_deductions: nextOtherDed, net_pay: net },
      req,
    });
    return { ok: true as const, net_pay: net };
  });

  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error });
  res.json(result);
});

router.post('/hr/payroll/:id/verify', requireAuth, requirePermission('hr.payroll.verify', 'finance.payroll.generate'), async (req: AuthRequest, res: Response) => {
  const runId = Number(req.params.id);
  const run = await queryOne<{ id: number; run_number: string; status: string; created_by: number }>('SELECT * FROM payroll_runs WHERE id = ?', [runId]);
  if (!run) return res.status(404).json({ error: 'Payroll run not found' });
  if (run.status !== 'draft') return res.status(409).json({ error: `Cannot verify payroll in '${run.status}' status.` });
  assertDifferentUser(req.user!.id, run.created_by, 'verify a payroll run you drafted');

  await execute("UPDATE payroll_runs SET status = 'verified', verified_by = ?, verified_at = ? WHERE id = ?", [req.user!.id, nowSql(), runId]);
  await writeAuditLog({
    user: req.user,
    action: 'hr.payroll.verify',
    entityType: 'payroll_run',
    entityId: runId,
    after: { runNumber: run.run_number },
    req,
  });
  res.json({ ok: true });
});

router.post('/hr/payroll/:id/approve', requireAuth, requirePermission('hr.payroll.approve', 'accounting.ledger.manage'), async (req: AuthRequest, res: Response) => {
  const runId = Number(req.params.id);
  const run = await queryOne<{ id: number; run_number: string; status: string; created_by: number; verified_by: number | null }>(
    'SELECT * FROM payroll_runs WHERE id = ?',
    [runId]
  );
  if (!run) return res.status(404).json({ error: 'Payroll run not found' });
  if (!['draft', 'verified'].includes(run.status)) return res.status(409).json({ error: 'Payroll run must be in draft or verified state for approval.' });
  assertDifferentUser(req.user!.id, run.created_by, 'approve a payroll run you drafted');

  await execute("UPDATE payroll_runs SET status = 'approved', approved_by = ?, approved_at = ? WHERE id = ?", [req.user!.id, nowSql(), runId]);
  await writeAuditLog({
    user: req.user,
    action: 'hr.payroll.approve',
    entityType: 'payroll_run',
    entityId: runId,
    after: { runNumber: run.run_number },
    req,
  });
  res.json({ ok: true });
});

router.post('/hr/payroll/:id/reject', requireAuth, requirePermission('hr.payroll.approve', 'hr.payroll.verify', 'accounting.ledger.manage'), async (req: AuthRequest, res: Response) => {
  const runId = Number(req.params.id);
  const reason = String(req.body?.reason || '').trim();
  const run = await queryOne<{ id: number; run_number: string; pay_month: string; status: string }>('SELECT * FROM payroll_runs WHERE id = ?', [runId]);
  if (!run) return res.status(404).json({ error: 'Payroll run not found.' });
  if (!['draft', 'verified'].includes(run.status)) {
    return res.status(409).json({ error: `Cannot reject payroll in '${run.status}' status.` });
  }
  await execute("UPDATE payroll_runs SET status = 'rejected' WHERE id = ?", [runId]);
  await execute('UPDATE hr_overtime SET payroll_run_id = NULL WHERE payroll_run_id = ?', [runId]);
  await execute("UPDATE hr_monthly_submissions SET status = 'submitted' WHERE pay_month = ?", [run.pay_month]);
  await writeAuditLog({ user: req.user, action: 'hr.payroll.reject', entityType: 'payroll_run', entityId: runId, reason: reason || 'Rejected by Finance/Manager', req });
  res.json({ ok: true });
});

router.post('/hr/payroll/:id/post', requireAuth, requirePermission('hr.payroll.post', 'finance.payroll.generate', 'accounting.ledger.manage'), async (req: AuthRequest, res: Response) => {
  const runId = Number(req.params.id);
  const result = await withTransaction(async () => {
    const run = await queryOne<{ id: number; run_number: string; pay_month: string; total_gross: number; total_deductions: number; total_net: number; status: string; journal_entry_id: number | null }>(
      'SELECT * FROM payroll_runs WHERE id = ?',
      [runId]
    );
    if (!run) return { ok: false as const, error: 'Payroll run not found', httpStatus: 404 };
    if (run.journal_entry_id) {
      return { ok: false as const, error: 'Payroll run has already been posted to General Ledger.', httpStatus: 409 };
    }
    if (run.status !== 'approved') {
      return { ok: false as const, error: `Payroll must be approved before GL posting (current: '${run.status}').`, httpStatus: 409 };
    }

    const items = await query<{ paye_tax: number; pension_employee: number; pension_employer: number; other_deductions: number; net_pay: number }>(
      'SELECT paye_tax, pension_employee, pension_employer, other_deductions, net_pay FROM payroll_items WHERE payroll_run_id = ?',
      [runId]
    );
    const totalPaye = Number(items.reduce((s, i) => s + Number(i.paye_tax || 0), 0).toFixed(2));
    const totalPensionEe = Number(items.reduce((s, i) => s + Number(i.pension_employee || 0), 0).toFixed(2));
    const totalPensionEr = Number(items.reduce((s, i) => s + Number(i.pension_employer || 0), 0).toFixed(2));
    const totalOtherDed = Number(items.reduce((s, i) => s + Number(i.other_deductions || 0), 0).toFixed(2));
    const totalNet = Number(items.reduce((s, i) => s + Number(i.net_pay || 0), 0).toFixed(2));
    const totalExpense = Number((Number(run.total_gross) + totalPensionEr - totalOtherDed).toFixed(2));
    const totalPension = Number((totalPensionEe + totalPensionEr).toFixed(2));

    const lines: Array<{ accountCode: string; debit?: number; credit?: number; memo?: string }> = [
      { accountCode: '5100', debit: totalExpense, memo: `Gross $${run.total_gross} + Employer Pension $${totalPensionEr}` },
      { accountCode: '2200', credit: totalNet, memo: `Net salaries payable ${run.pay_month}` },
    ];
    if (totalPaye > 0) lines.push({ accountCode: '2210', credit: totalPaye, memo: `PAYE income tax ${run.pay_month}` });
    if (totalPension > 0) lines.push({ accountCode: '2220', credit: totalPension, memo: `Employee & Employer pension ${run.pay_month}` });

    const je = await postJournalEntry({
      sourceType: 'payroll',
      sourceId: runId,
      description: `Monthly Payroll Accrual ${run.pay_month} (${run.run_number})`,
      postedBy: req.user!.id,
      lines,
    });

    await execute("UPDATE payroll_runs SET status = 'posted', journal_entry_id = ?, posted_at = ? WHERE id = ?", [
      je.entryId,
      nowSql(),
      runId,
    ]);

    await writeAuditLog({
      user: req.user,
      action: 'hr.payroll.post',
      entityType: 'payroll_run',
      entityId: runId,
      after: { runNumber: run.run_number, entryNumber: je.entryNumber, totalExpense, totalNet, totalPaye, totalPension },
      req,
    });

    return { ok: true as const, entryNumber: je.entryNumber };
  });

  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error });
  res.json(result);
});

router.post('/hr/payroll/:id/items/:itemId/pay', requireAuth, requirePermission('hr.payroll.pay', 'finance.payment.manage', 'accounting.ledger.manage'), async (req: AuthRequest, res: Response) => {
  const runId = Number(req.params.id);
  const itemId = Number(req.params.itemId);
  const { amount, cash_bank_account_id, payment_method = 'bank_transfer', payment_date, reference_no, notes } = req.body || {};
  const payAmt = Number(Number(amount || 0).toFixed(2));
  if (payAmt <= 0) return res.status(400).json({ error: 'Positive disbursement amount is required.' });
  const payDate = payment_date ? String(payment_date).slice(0, 10) : await getClinicToday();

  const result = await withTransaction(async () => {
    await assertOpenAccountingPeriod(payDate);
    const run = await queryOne<{ id: number; run_number: string; pay_month: string; status: string }>('SELECT * FROM payroll_runs WHERE id = ?', [runId]);
    if (!run) return { ok: false as const, error: 'Payroll run not found.', httpStatus: 404 };
    if (!['posted', 'partially_paid'].includes(run.status)) {
      return { ok: false as const, error: 'Payroll run must be posted to General Ledger before employee disbursement.', httpStatus: 409 };
    }
    const item = await queryOne<{ id: number; payroll_run_id: number; staff_name: string; net_pay: number; paid_amount: number }>(
      'SELECT * FROM payroll_items WHERE id = ? AND payroll_run_id = ?',
      [itemId, runId]
    );
    if (!item) return { ok: false as const, error: 'Payroll item not found.', httpStatus: 404 };
    const remaining = Number((Number(item.net_pay) - Number(item.paid_amount || 0)).toFixed(2));
    if (remaining <= 0) return { ok: false as const, error: `${item.staff_name} has already been paid in full.`, httpStatus: 409 };
    const actualPay = Math.min(payAmt, remaining);

    let cbAcct = cash_bank_account_id
      ? await queryOne<{ id: number; account_name: string; coa_code: string }>('SELECT id, account_name, coa_code FROM finance_cash_bank_accounts WHERE id = ? AND active = 1', [Number(cash_bank_account_id)])
      : null;
    if (!cbAcct) {
      cbAcct = await queryOne<{ id: number; account_name: string; coa_code: string }>(
        'SELECT id, account_name, coa_code FROM finance_cash_bank_accounts WHERE coa_code = ? AND active = 1 ORDER BY id ASC LIMIT 1',
        [payment_method === 'cash' ? '1010' : '1020']
      );
    }
    if (!cbAcct) return { ok: false as const, error: 'Active Cash/Bank account not found.', httpStatus: 400 };

    const fpNum = await nextSequence('FPV');
    const je = await postJournalEntry({
      entryDate: payDate,
      sourceType: 'payroll_payment',
      sourceId: runId,
      description: `Salary Payment ${fpNum}: ${item.staff_name} (${run.pay_month})`,
      postedBy: req.user!.id,
      lines: [
        { accountCode: '2200', debit: actualPay, memo: `${run.run_number} · ${item.staff_name}` },
        { accountCode: cbAcct.coa_code, credit: actualPay, memo: `${fpNum} · ${cbAcct.account_name}` },
      ],
    });

    const nextPaid = Number((Number(item.paid_amount || 0) + actualPay).toFixed(2));
    const itemStatus = nextPaid >= Number(item.net_pay) - 0.01 ? 'paid' : 'partial';
    await execute(
      'UPDATE payroll_items SET paid_amount = ?, payment_status = ?, payment_method = ?, payment_ref = ?, paid_at = ? WHERE id = ?',
      [nextPaid, itemStatus, payment_method, reference_no?.trim() || fpNum, nowSql(), itemId]
    );
    await execute('UPDATE finance_cash_bank_accounts SET current_balance = ROUND(current_balance - ?, 2) WHERE id = ?', [actualPay, cbAcct.id]);
    await execute(
      `INSERT INTO finance_payments (payment_number, payment_date, payment_category, payee_name, cash_bank_account_id, payment_method, amount, reference_no, linked_type, linked_id, notes, journal_entry_id, created_by)
       VALUES (?, ?, 'salary', ?, ?, ?, ?, ?, 'payroll_item', ?, ?, ?, ?)`,
      [fpNum, payDate, item.staff_name, cbAcct.id, payment_method, actualPay, reference_no?.trim() || fpNum, itemId, notes?.trim() || `Payroll ${run.run_number} (${run.pay_month})`, je.entryId, req.user!.id]
    );

    const unpaidCount = await queryOne<{ cnt: number }>(
      "SELECT COUNT(*) AS cnt FROM payroll_items WHERE payroll_run_id = ? AND payment_status != 'paid'",
      [runId]
    );
    const nextRunStatus = Number(unpaidCount?.cnt || 0) === 0 ? 'paid' : 'partially_paid';
    await execute('UPDATE payroll_runs SET status = ?, paid_by = ?, paid_at = ? WHERE id = ?', [
      nextRunStatus,
      req.user!.id,
      nowSql(),
      runId,
    ]);

    await writeAuditLog({
      user: req.user,
      action: 'hr.payroll.item.pay',
      entityType: 'payroll_item',
      entityId: itemId,
      after: { runNumber: run.run_number, staff_name: item.staff_name, paid: actualPay, itemStatus, paymentNumber: fpNum, entryNumber: je.entryNumber },
      req,
    });
    return { ok: true as const, paid: actualPay, itemStatus, runStatus: nextRunStatus, paymentNumber: fpNum, entryNumber: je.entryNumber };
  });

  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error });
  res.json(result);
});

router.post('/hr/payroll/:id/pay', requireAuth, requirePermission('hr.payroll.pay', 'finance.payment.manage', 'accounting.ledger.manage'), async (req: AuthRequest, res: Response) => {
  const runId = Number(req.params.id);
  const { cash_bank_account_id, payment_method = 'bank_transfer', payment_date, reference_no } = req.body || {};
  const payDate = payment_date ? String(payment_date).slice(0, 10) : await getClinicToday();

  const result = await withTransaction(async () => {
    await assertOpenAccountingPeriod(payDate);
    const run = await queryOne<{ id: number; run_number: string; pay_month: string; total_net: number; status: string }>(
      'SELECT * FROM payroll_runs WHERE id = ?',
      [runId]
    );
    if (!run) return { ok: false as const, error: 'Payroll run not found', httpStatus: 404 };
    if (!['posted', 'partially_paid'].includes(run.status)) {
      return { ok: false as const, error: 'Payroll run must be posted to General Ledger before bank disbursement.', httpStatus: 409 };
    }

    const unpaidItems = await query<{ id: number; staff_name: string; net_pay: number; paid_amount: number }>(
      "SELECT id, staff_name, net_pay, paid_amount FROM payroll_items WHERE payroll_run_id = ? AND payment_status != 'paid'",
      [runId]
    );
    const remainingTotal = Number(unpaidItems.reduce((s, it) => s + Math.max(0, Number(it.net_pay) - Number(it.paid_amount || 0)), 0).toFixed(2));
    if (remainingTotal <= 0) {
      return { ok: false as const, error: 'All employees in this payroll run are already paid.', httpStatus: 409 };
    }

    let cbAcct = cash_bank_account_id
      ? await queryOne<{ id: number; account_name: string; coa_code: string }>('SELECT id, account_name, coa_code FROM finance_cash_bank_accounts WHERE id = ? AND active = 1', [Number(cash_bank_account_id)])
      : null;
    if (!cbAcct) {
      cbAcct = await queryOne<{ id: number; account_name: string; coa_code: string }>(
        'SELECT id, account_name, coa_code FROM finance_cash_bank_accounts WHERE coa_code = ? AND active = 1 ORDER BY id ASC LIMIT 1',
        [payment_method === 'cash' ? '1010' : '1020']
      );
    }
    const creditCode = cbAcct?.coa_code || (payment_method === 'cash' ? '1010' : '1020');

    const fpNum = await nextSequence('FPV');
    const je = await postJournalEntry({
      entryDate: payDate,
      sourceType: 'payroll_payment',
      sourceId: runId,
      description: `Payroll Batch Disbursement ${run.pay_month} (${run.run_number})`,
      postedBy: req.user!.id,
      lines: [
        { accountCode: '2200', debit: remainingTotal, memo: `Clear net salaries payable ${run.run_number}` },
        { accountCode: creditCode, credit: remainingTotal, memo: `${fpNum} · ${cbAcct?.account_name || 'Bank payroll transfer'}` },
      ],
    });

    for (const it of unpaidItems) {
      await execute(
        "UPDATE payroll_items SET paid_amount = net_pay, payment_status = 'paid', payment_method = ?, payment_ref = ?, paid_at = ? WHERE id = ?",
        [payment_method, reference_no?.trim() || fpNum, nowSql(), it.id]
      );
    }
    if (cbAcct) {
      await execute('UPDATE finance_cash_bank_accounts SET current_balance = ROUND(current_balance - ?, 2) WHERE id = ?', [remainingTotal, cbAcct.id]);
      await execute(
        `INSERT INTO finance_payments (payment_number, payment_date, payment_category, payee_name, cash_bank_account_id, payment_method, amount, reference_no, linked_type, linked_id, notes, journal_entry_id, created_by)
         VALUES (?, ?, 'salary', ?, ?, ?, ?, ?, 'payroll_run', ?, ?, ?, ?)`,
        [fpNum, payDate, `All Remaining Staff (${unpaidItems.length})`, cbAcct.id, payment_method, remainingTotal, reference_no?.trim() || run.run_number, runId, `Full batch payroll settlement ${run.pay_month}`, je.entryId, req.user!.id]
      );
    }

    await execute("UPDATE payroll_runs SET status = 'paid', payment_journal_entry_id = ?, paid_by = ?, paid_at = ? WHERE id = ?", [
      je.entryId,
      req.user!.id,
      nowSql(),
      runId,
    ]);
    await writeAuditLog({
      user: req.user,
      action: 'hr.payroll.pay',
      entityType: 'payroll_run',
      entityId: runId,
      after: { runNumber: run.run_number, entryNumber: je.entryNumber, netPaid: remainingTotal, paymentNumber: fpNum },
      req,
    });
    return { ok: true as const, entryNumber: je.entryNumber, paymentNumber: fpNum, netPaid: remainingTotal };
  });
  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error });
  res.json(result);
});

// ---------------------------------------------------------------------------
// MASTER CATALOG MANAGEMENT (ADM / MGR)
// ---------------------------------------------------------------------------
router.get('/catalog/manage/:entity', requireAuth, requirePermission('catalog.manage', 'admin.user.manage'), async (req, res) => {
  const entity = req.params.entity;
  if (entity === 'services') return res.json({ rows: await query('SELECT * FROM services ORDER BY category, code') });
  if (entity === 'lab_tests') return res.json({ rows: await query('SELECT * FROM lab_tests ORDER BY code') });
  if (entity === 'imaging_catalog') return res.json({ rows: await query('SELECT * FROM imaging_catalog ORDER BY code') });
  if (entity === 'medicines') return res.json({ rows: await query('SELECT * FROM medicines ORDER BY generic_name') });
  if (entity === 'wards') return res.json({ rows: await query('SELECT * FROM wards ORDER BY id') });
  return res.status(400).json({ error: 'Invalid catalog entity.' });
});

router.post('/catalog/manage/:entity', requireAuth, requirePermission('catalog.manage'), async (req: AuthRequest, res: Response) => {
  const entity = req.params.entity;
  const b = req.body || {};
  let insertedId = 0;

  if (entity === 'services') {
    if (!b.code?.trim() || !b.name?.trim() || Number(b.unit_price) < 0) return res.status(400).json({ error: 'Code, name, and valid unit_price are required.' });
    const r = await execute('INSERT INTO services (code, name, category, unit_price, active) VALUES (?, ?, ?, ?, 1)', [
      b.code.trim().toUpperCase(), b.name.trim(), b.category || 'consultation', Number(b.unit_price),
    ]);
    insertedId = r.insertId;
  } else if (entity === 'lab_tests') {
    if (!b.code?.trim() || !b.name?.trim() || Number(b.price) < 0) return res.status(400).json({ error: 'Code, name, and valid price are required.' });
    const r = await execute(
      'INSERT INTO lab_tests (code, name, sample_type, unit, reference_range, price, turnaround_mins) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [b.code.trim().toUpperCase(), b.name.trim(), b.sample_type || 'Serum', b.unit || '', b.reference_range || '', Number(b.price), Number(b.turnaround_mins || 60)]
    );
    insertedId = r.insertId;
  } else if (entity === 'imaging_catalog') {
    if (!b.code?.trim() || !b.name?.trim() || Number(b.price) < 0) return res.status(400).json({ error: 'Code, name, and valid price are required.' });
    const r = await execute(
      'INSERT INTO imaging_catalog (code, name, modality, body_region, price) VALUES (?, ?, ?, ?, ?)',
      [b.code.trim().toUpperCase(), b.name.trim(), b.modality || 'X-Ray', b.body_region || 'General', Number(b.price)]
    );
    insertedId = r.insertId;
  } else if (entity === 'medicines') {
    if (!b.code?.trim() || !b.generic_name?.trim() || Number(b.unit_price) < 0) return res.status(400).json({ error: 'Code, generic_name, and valid unit_price are required.' });
    const r = await execute(
      'INSERT INTO medicines (code, generic_name, strength, form, unit_price, stock_qty, reorder_level, batch_number, expiry_date) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)',
      [
        b.code.trim().toUpperCase(),
        b.generic_name.trim(),
        b.strength || '',
        b.form || 'Tablet',
        Number(b.unit_price),
        Number(b.reorder_level || 20),
        b.batch_number || 'INIT-01',
        b.expiry_date || '2028-12-31',
      ]
    );
    insertedId = r.insertId;
  } else if (entity === 'wards') {
    if (!b.code?.trim() || !b.name?.trim() || Number(b.daily_tariff) < 0) return res.status(400).json({ error: 'Code, name, and daily_tariff are required.' });
    const r = await execute('INSERT INTO wards (code, name, department, daily_tariff) VALUES (?, ?, ?, ?)', [
      b.code.trim().toUpperCase(), b.name.trim(), b.department || 'Inpatient', Number(b.daily_tariff),
    ]);
    insertedId = r.insertId;
  } else {
    return res.status(400).json({ error: 'Invalid catalog entity.' });
  }

  await writeAuditLog({
    user: req.user,
    action: `catalog.${entity}.create`,
    entityType: entity,
    entityId: insertedId,
    after: b,
    req,
  });
  res.status(201).json({ id: insertedId });
});

router.put('/catalog/manage/:entity/:id', requireAuth, requirePermission('catalog.manage'), async (req: AuthRequest, res: Response) => {
  const entity = req.params.entity;
  const id = Number(req.params.id);
  const b = req.body || {};

  if (entity === 'services') {
    await execute('UPDATE services SET name = COALESCE(?, name), category = COALESCE(?, category), unit_price = COALESCE(?, unit_price), active = COALESCE(?, active) WHERE id = ?', [
      b.name ?? null, b.category ?? null, b.unit_price !== undefined ? Number(b.unit_price) : null, b.active !== undefined ? (b.active ? 1 : 0) : null, id,
    ]);
  } else if (entity === 'lab_tests') {
    await execute('UPDATE lab_tests SET name = COALESCE(?, name), sample_type = COALESCE(?, sample_type), reference_range = COALESCE(?, reference_range), price = COALESCE(?, price) WHERE id = ?', [
      b.name ?? null, b.sample_type ?? null, b.reference_range ?? null, b.price !== undefined ? Number(b.price) : null, id,
    ]);
  } else if (entity === 'imaging_catalog') {
    await execute('UPDATE imaging_catalog SET name = COALESCE(?, name), modality = COALESCE(?, modality), body_region = COALESCE(?, body_region), price = COALESCE(?, price) WHERE id = ?', [
      b.name ?? null, b.modality ?? null, b.body_region ?? null, b.price !== undefined ? Number(b.price) : null, id,
    ]);
  } else if (entity === 'medicines') {
    await execute('UPDATE medicines SET generic_name = COALESCE(?, generic_name), strength = COALESCE(?, strength), unit_price = COALESCE(?, unit_price), reorder_level = COALESCE(?, reorder_level) WHERE id = ?', [
      b.generic_name ?? null, b.strength ?? null, b.unit_price !== undefined ? Number(b.unit_price) : null, b.reorder_level !== undefined ? Number(b.reorder_level) : null, id,
    ]);
  } else if (entity === 'wards') {
    await execute('UPDATE wards SET name = COALESCE(?, name), department = COALESCE(?, department), daily_tariff = COALESCE(?, daily_tariff) WHERE id = ?', [
      b.name ?? null, b.department ?? null, b.daily_tariff !== undefined ? Number(b.daily_tariff) : null, id,
    ]);
  } else {
    return res.status(400).json({ error: 'Invalid catalog entity.' });
  }

  await writeAuditLog({
    user: req.user,
    action: `catalog.${entity}.update`,
    entityType: entity,
    entityId: id,
    after: b,
    req,
  });
  res.json({ ok: true });
});

export default router;
