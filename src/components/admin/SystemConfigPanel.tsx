import React, { useCallback, useEffect, useState } from 'react';
import { Bell, CheckCircle2, CreditCard, Database, FileText, Lock, ShieldCheck, Stethoscope } from 'lucide-react';
import { apiFetch } from '../../lib/api';
import type { BackupStatusResponse, ClinicSettings } from '../../types';

export type SystemConfigSection =
  | 'clinical_config'
  | 'billing_config'
  | 'notifications_config'
  | 'documents_config'
  | 'security_config'
  | 'backup';

interface SystemConfigPanelProps {
  section: SystemConfigSection;
  settings: ClinicSettings;
  canManageConfig: boolean;
  canManageBackup: boolean;
  onSettingsSaved: (s: ClinicSettings) => void;
  onNotify: (msg: string, type?: 'success' | 'error') => void;
}

export const SystemConfigPanel: React.FC<SystemConfigPanelProps> = ({
  section,
  settings,
  canManageConfig,
  canManageBackup,
  onSettingsSaved,
  onNotify,
}) => {
  const [saving, setSaving] = useState(false);

  const [clinical, setClinical] = useState({
    mrnPrefix: settings.clinical?.mrnPrefix || 'MRN-',
    visitPrefix: settings.clinical?.visitPrefix || 'VIS-',
    defaultSlotMinutes: settings.clinical?.defaultSlotMinutes ?? 20,
    maxDailyPatientsPerDoctor: settings.clinical?.maxDailyPatientsPerDoctor ?? 35,
    allowWalkInRegistration: settings.clinical?.allowWalkInRegistration ?? true,
    requireVitalsBeforeConsultation: settings.clinical?.requireVitalsBeforeConsultation ?? true,
    requirePaymentBeforeConsultation: settings.clinical?.requirePaymentBeforeConsultation ?? true,
    autoAssignRoomBySpecialty: settings.clinical?.autoAssignRoomBySpecialty ?? true,
    bpSystolicMin: settings.clinical?.vitalReferenceRanges?.bpSystolicMin ?? 90,
    bpSystolicMax: settings.clinical?.vitalReferenceRanges?.bpSystolicMax ?? 140,
    bpDiastolicMin: settings.clinical?.vitalReferenceRanges?.bpDiastolicMin ?? 60,
    bpDiastolicMax: settings.clinical?.vitalReferenceRanges?.bpDiastolicMax ?? 90,
    tempMinC: settings.clinical?.vitalReferenceRanges?.tempMinC ?? 36.1,
    tempMaxC: settings.clinical?.vitalReferenceRanges?.tempMaxC ?? 37.8,
    pulseMin: settings.clinical?.vitalReferenceRanges?.pulseMin ?? 60,
    pulseMax: settings.clinical?.vitalReferenceRanges?.pulseMax ?? 100,
    spo2Min: settings.clinical?.vitalReferenceRanges?.spo2Min ?? 95,
  });

  const [billing, setBilling] = useState({
    currencyCode: settings.currencyCode || 'USD',
    currencySymbol: settings.currencySymbol || '$',
    expenseAutoPostLimit: settings.expenseAutoPostLimit ?? 500,
    defaultTaxRatePct: settings.billing?.defaultTaxRatePct ?? 0,
    cashierMaxDiscountPct: settings.billing?.cashierMaxDiscountPct ?? 10,
    requireShiftForCollection: settings.billing?.requireShiftForCollection ?? true,
    allowPartialPayments: settings.billing?.allowPartialPayments ?? true,
    allowInsuranceCreditBilling: settings.billing?.allowInsuranceCreditBilling ?? true,
    receiptFooterNote: settings.billing?.receiptFooterNote || 'Thank you for choosing Clinic360.',
  });

  const [notifications, setNotifications] = useState({
    enableInAppAlerts: settings.notifications?.enableInAppAlerts ?? true,
    enableSmsAlerts: settings.notifications?.enableSmsAlerts ?? false,
    enableEmailAlerts: settings.notifications?.enableEmailAlerts ?? false,
    notifyDoctorOnAssignment: settings.notifications?.notifyDoctorOnAssignment ?? true,
    notifyNurseOnPaymentClearance: settings.notifications?.notifyNurseOnPaymentClearance ?? true,
    notifyAdminOnAccessReview: settings.notifications?.notifyAdminOnAccessReview ?? true,
    criticalLabAlertImmediate: settings.notifications?.criticalLabAlertImmediate ?? true,
  });

  const [documents, setDocuments] = useState({
    prescriptionHeader: settings.documents?.prescriptionHeader || 'Clinic360 Outpatient Prescription',
    labReportHeader: settings.documents?.labReportHeader || 'Clinic360 Accredited Clinical Laboratory',
    radiologyHeader: settings.documents?.radiologyHeader || 'Clinic360 Diagnostic Imaging Report',
    invoiceHeader: settings.documents?.invoiceHeader || 'Official Medical Service Receipt',
    showClinicStampOnPrint: settings.documents?.showClinicStampOnPrint ?? true,
  });

  const [security, setSecurity] = useState({
    sessionTimeoutMinutes: settings.security?.sessionTimeoutMinutes ?? 480,
    passwordMinLength: settings.security?.passwordMinLength ?? 8,
    requireMixedCasePassword: settings.security?.requireMixedCasePassword ?? false,
    maxFailedLoginAttempts: settings.security?.maxFailedLoginAttempts ?? 5,
    lockoutDurationMinutes: settings.security?.lockoutDurationMinutes ?? 15,
    enforce2faForPrivilegedRoles: settings.security?.enforce2faForPrivilegedRoles ?? true,
    allowMultipleActiveSessions: settings.security?.allowMultipleActiveSessions ?? true,
  });

  const [backupStatus, setBackupStatus] = useState<BackupStatusResponse | null>(null);
  const [verifyReport, setVerifyReport] = useState<{
    verifiedAt: string;
    integrityOk: boolean;
    integrityDetail: string;
    auditChain: { valid: boolean; totalRows: number; brokenAtId: number | null };
  } | null>(null);
  const [verifyingBackup, setVerifyingBackup] = useState(false);

  useEffect(() => {
    setClinical({
      mrnPrefix: settings.clinical?.mrnPrefix || 'MRN-',
      visitPrefix: settings.clinical?.visitPrefix || 'VIS-',
      defaultSlotMinutes: settings.clinical?.defaultSlotMinutes ?? 20,
      maxDailyPatientsPerDoctor: settings.clinical?.maxDailyPatientsPerDoctor ?? 35,
      allowWalkInRegistration: settings.clinical?.allowWalkInRegistration ?? true,
      requireVitalsBeforeConsultation: settings.clinical?.requireVitalsBeforeConsultation ?? true,
      requirePaymentBeforeConsultation: settings.clinical?.requirePaymentBeforeConsultation ?? true,
      autoAssignRoomBySpecialty: settings.clinical?.autoAssignRoomBySpecialty ?? true,
      bpSystolicMin: settings.clinical?.vitalReferenceRanges?.bpSystolicMin ?? 90,
      bpSystolicMax: settings.clinical?.vitalReferenceRanges?.bpSystolicMax ?? 140,
      bpDiastolicMin: settings.clinical?.vitalReferenceRanges?.bpDiastolicMin ?? 60,
      bpDiastolicMax: settings.clinical?.vitalReferenceRanges?.bpDiastolicMax ?? 90,
      tempMinC: settings.clinical?.vitalReferenceRanges?.tempMinC ?? 36.1,
      tempMaxC: settings.clinical?.vitalReferenceRanges?.tempMaxC ?? 37.8,
      pulseMin: settings.clinical?.vitalReferenceRanges?.pulseMin ?? 60,
      pulseMax: settings.clinical?.vitalReferenceRanges?.pulseMax ?? 100,
      spo2Min: settings.clinical?.vitalReferenceRanges?.spo2Min ?? 95,
    });
    setBilling({
      currencyCode: settings.currencyCode || 'USD',
      currencySymbol: settings.currencySymbol || '$',
      expenseAutoPostLimit: settings.expenseAutoPostLimit ?? 500,
      defaultTaxRatePct: settings.billing?.defaultTaxRatePct ?? 0,
      cashierMaxDiscountPct: settings.billing?.cashierMaxDiscountPct ?? 10,
      requireShiftForCollection: settings.billing?.requireShiftForCollection ?? true,
      allowPartialPayments: settings.billing?.allowPartialPayments ?? true,
      allowInsuranceCreditBilling: settings.billing?.allowInsuranceCreditBilling ?? true,
      receiptFooterNote: settings.billing?.receiptFooterNote || 'Thank you for choosing Clinic360.',
    });
    setNotifications({
      enableInAppAlerts: settings.notifications?.enableInAppAlerts ?? true,
      enableSmsAlerts: settings.notifications?.enableSmsAlerts ?? false,
      enableEmailAlerts: settings.notifications?.enableEmailAlerts ?? false,
      notifyDoctorOnAssignment: settings.notifications?.notifyDoctorOnAssignment ?? true,
      notifyNurseOnPaymentClearance: settings.notifications?.notifyNurseOnPaymentClearance ?? true,
      notifyAdminOnAccessReview: settings.notifications?.notifyAdminOnAccessReview ?? true,
      criticalLabAlertImmediate: settings.notifications?.criticalLabAlertImmediate ?? true,
    });
    setDocuments({
      prescriptionHeader: settings.documents?.prescriptionHeader || 'Clinic360 Outpatient Prescription',
      labReportHeader: settings.documents?.labReportHeader || 'Clinic360 Accredited Clinical Laboratory',
      radiologyHeader: settings.documents?.radiologyHeader || 'Clinic360 Diagnostic Imaging Report',
      invoiceHeader: settings.documents?.invoiceHeader || 'Official Medical Service Receipt',
      showClinicStampOnPrint: settings.documents?.showClinicStampOnPrint ?? true,
    });
    setSecurity({
      sessionTimeoutMinutes: settings.security?.sessionTimeoutMinutes ?? 480,
      passwordMinLength: settings.security?.passwordMinLength ?? 8,
      requireMixedCasePassword: settings.security?.requireMixedCasePassword ?? false,
      maxFailedLoginAttempts: settings.security?.maxFailedLoginAttempts ?? 5,
      lockoutDurationMinutes: settings.security?.lockoutDurationMinutes ?? 15,
      enforce2faForPrivilegedRoles: settings.security?.enforce2faForPrivilegedRoles ?? true,
      allowMultipleActiveSessions: settings.security?.allowMultipleActiveSessions ?? true,
    });
  }, [settings]);

  const loadBackupStatus = useCallback(async () => {
    try {
      const res = await apiFetch<BackupStatusResponse>('/api/admin/backup-status');
      setBackupStatus(res);
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }, [onNotify]);

  useEffect(() => {
    if (section === 'backup') {
      loadBackupStatus();
    }
  }, [section, loadBackupStatus]);

  async function savePartialSettings(payload: Record<string, unknown>, message: string) {
    setSaving(true);
    try {
      const res = await apiFetch<{ settings: ClinicSettings }>('/api/admin/settings', {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      if (res.settings) onSettingsSaved(res.settings);
      onNotify(message, 'success');
    } catch (err) {
      onNotify((err as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  }

  async function handleRunBackupVerify() {
    setVerifyingBackup(true);
    try {
      const res = await apiFetch<{
        ok: boolean;
        verifiedAt: string;
        integrityOk: boolean;
        integrityDetail: string;
        auditChain: { valid: boolean; totalRows: number; brokenAtId: number | null };
      }>('/api/admin/backup/verify', { method: 'POST' });
      setVerifyReport(res);
      onNotify(
        res.integrityOk && res.auditChain.valid
          ? 'Database integrity & SHA-256 audit chain verified clean.'
          : 'Integrity verification detected an issue.',
        res.integrityOk && res.auditChain.valid ? 'success' : 'error'
      );
      loadBackupStatus();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    } finally {
      setVerifyingBackup(false);
    }
  }

  if (section === 'clinical_config') {
    return (
      <div className="bg-white border border-slate-200 rounded-lg max-w-3xl">
        <div className="px-6 py-4 border-b border-slate-200 flex items-center gap-2.5">
          <Stethoscope className="w-4 h-4 text-teal-700" />
          <div>
            <h3 className="font-display text-sm font-semibold text-slate-900">Clinical Workflow &amp; Vital Thresholds</h3>
            <p className="text-xs text-slate-500">Controls MRN numbering, triage gates, scheduling slots, and normal vital limits.</p>
          </div>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            savePartialSettings(
              {
                clinical: {
                  mrnPrefix: clinical.mrnPrefix,
                  visitPrefix: clinical.visitPrefix,
                  defaultSlotMinutes: Number(clinical.defaultSlotMinutes),
                  maxDailyPatientsPerDoctor: Number(clinical.maxDailyPatientsPerDoctor),
                  allowWalkInRegistration: clinical.allowWalkInRegistration,
                  requireVitalsBeforeConsultation: clinical.requireVitalsBeforeConsultation,
                  requirePaymentBeforeConsultation: clinical.requirePaymentBeforeConsultation,
                  autoAssignRoomBySpecialty: clinical.autoAssignRoomBySpecialty,
                  vitalReferenceRanges: {
                    bpSystolicMin: Number(clinical.bpSystolicMin),
                    bpSystolicMax: Number(clinical.bpSystolicMax),
                    bpDiastolicMin: Number(clinical.bpDiastolicMin),
                    bpDiastolicMax: Number(clinical.bpDiastolicMax),
                    tempMinC: Number(clinical.tempMinC),
                    tempMaxC: Number(clinical.tempMaxC),
                    pulseMin: Number(clinical.pulseMin),
                    pulseMax: Number(clinical.pulseMax),
                    spo2Min: Number(clinical.spo2Min),
                  },
                },
              },
              'Clinical configuration saved.'
            );
          }}
          className="p-6 space-y-5 text-xs"
        >
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
            <div>
              <label className="block font-medium text-slate-700 mb-1">MRN Prefix</label>
              <input
                disabled={!canManageConfig}
                value={clinical.mrnPrefix}
                onChange={(e) => setClinical({ ...clinical, mrnPrefix: e.target.value })}
                className="w-full px-3 py-2 font-mono border border-slate-300 rounded-md disabled:bg-slate-50"
              />
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">Visit Prefix</label>
              <input
                disabled={!canManageConfig}
                value={clinical.visitPrefix}
                onChange={(e) => setClinical({ ...clinical, visitPrefix: e.target.value })}
                className="w-full px-3 py-2 font-mono border border-slate-300 rounded-md disabled:bg-slate-50"
              />
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">Slot Duration (min)</label>
              <input
                type="number"
                min={5}
                max={120}
                disabled={!canManageConfig}
                value={clinical.defaultSlotMinutes}
                onChange={(e) => setClinical({ ...clinical, defaultSlotMinutes: Number(e.target.value) })}
                className="w-full px-3 py-2 font-mono border border-slate-300 rounded-md disabled:bg-slate-50"
              />
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">Max Daily / Doctor</label>
              <input
                type="number"
                min={1}
                disabled={!canManageConfig}
                value={clinical.maxDailyPatientsPerDoctor}
                onChange={(e) => setClinical({ ...clinical, maxDailyPatientsPerDoctor: Number(e.target.value) })}
                className="w-full px-3 py-2 font-mono border border-slate-300 rounded-md disabled:bg-slate-50"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 p-3.5 bg-slate-50 border border-slate-200 rounded-md">
            {(
              [
                ['allowWalkInRegistration', 'Allow walk-in patient registration & queue tickets'],
                ['requireVitalsBeforeConsultation', 'Require nurse/cashier vitals before doctor consult'],
                ['requirePaymentBeforeConsultation', 'Enforce cash-before-service payment clearance gate'],
                ['autoAssignRoomBySpecialty', 'Auto-suggest clinic room by doctor specialty'],
              ] as const
            ).map(([k, lbl]) => (
              <label key={k} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  disabled={!canManageConfig}
                  checked={clinical[k]}
                  onChange={(e) => setClinical({ ...clinical, [k]: e.target.checked })}
                />
                <span className="text-slate-700">{lbl}</span>
              </label>
            ))}
          </div>

          <div>
            <div className="font-semibold text-slate-900 mb-2">Vital Signs Reference Ranges (Abnormal Flag Thresholds)</div>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
              <div>
                <label className="block text-[11px] text-slate-500 mb-1">Systolic Min/Max</label>
                <div className="flex gap-1">
                  <input
                    type="number"
                    disabled={!canManageConfig}
                    value={clinical.bpSystolicMin}
                    onChange={(e) => setClinical({ ...clinical, bpSystolicMin: Number(e.target.value) })}
                    className="w-full px-2 py-1.5 font-mono border border-slate-300 rounded"
                  />
                  <input
                    type="number"
                    disabled={!canManageConfig}
                    value={clinical.bpSystolicMax}
                    onChange={(e) => setClinical({ ...clinical, bpSystolicMax: Number(e.target.value) })}
                    className="w-full px-2 py-1.5 font-mono border border-slate-300 rounded"
                  />
                </div>
              </div>
              <div>
                <label className="block text-[11px] text-slate-500 mb-1">Diastolic Min/Max</label>
                <div className="flex gap-1">
                  <input
                    type="number"
                    disabled={!canManageConfig}
                    value={clinical.bpDiastolicMin}
                    onChange={(e) => setClinical({ ...clinical, bpDiastolicMin: Number(e.target.value) })}
                    className="w-full px-2 py-1.5 font-mono border border-slate-300 rounded"
                  />
                  <input
                    type="number"
                    disabled={!canManageConfig}
                    value={clinical.bpDiastolicMax}
                    onChange={(e) => setClinical({ ...clinical, bpDiastolicMax: Number(e.target.value) })}
                    className="w-full px-2 py-1.5 font-mono border border-slate-300 rounded"
                  />
                </div>
              </div>
              <div>
                <label className="block text-[11px] text-slate-500 mb-1">Temp (°C) Min/Max</label>
                <div className="flex gap-1">
                  <input
                    type="number"
                    step="0.1"
                    disabled={!canManageConfig}
                    value={clinical.tempMinC}
                    onChange={(e) => setClinical({ ...clinical, tempMinC: Number(e.target.value) })}
                    className="w-full px-2 py-1.5 font-mono border border-slate-300 rounded"
                  />
                  <input
                    type="number"
                    step="0.1"
                    disabled={!canManageConfig}
                    value={clinical.tempMaxC}
                    onChange={(e) => setClinical({ ...clinical, tempMaxC: Number(e.target.value) })}
                    className="w-full px-2 py-1.5 font-mono border border-slate-300 rounded"
                  />
                </div>
              </div>
              <div>
                <label className="block text-[11px] text-slate-500 mb-1">Pulse (bpm) Min/Max</label>
                <div className="flex gap-1">
                  <input
                    type="number"
                    disabled={!canManageConfig}
                    value={clinical.pulseMin}
                    onChange={(e) => setClinical({ ...clinical, pulseMin: Number(e.target.value) })}
                    className="w-full px-2 py-1.5 font-mono border border-slate-300 rounded"
                  />
                  <input
                    type="number"
                    disabled={!canManageConfig}
                    value={clinical.pulseMax}
                    onChange={(e) => setClinical({ ...clinical, pulseMax: Number(e.target.value) })}
                    className="w-full px-2 py-1.5 font-mono border border-slate-300 rounded"
                  />
                </div>
              </div>
              <div>
                <label className="block text-[11px] text-slate-500 mb-1">SpO2 Min (%)</label>
                <input
                  type="number"
                  disabled={!canManageConfig}
                  value={clinical.spo2Min}
                  onChange={(e) => setClinical({ ...clinical, spo2Min: Number(e.target.value) })}
                  className="w-full px-2 py-1.5 font-mono border border-slate-300 rounded"
                />
              </div>
            </div>
          </div>

          {canManageConfig && (
            <div className="pt-3 border-t border-slate-200 flex justify-end">
              <button
                type="submit"
                disabled={saving}
                className="px-4 py-2 font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Save Clinical Configuration'}
              </button>
            </div>
          )}
        </form>
      </div>
    );
  }

  if (section === 'billing_config') {
    return (
      <div className="bg-white border border-slate-200 rounded-lg max-w-3xl">
        <div className="px-6 py-4 border-b border-slate-200 flex items-center gap-2.5">
          <CreditCard className="w-4 h-4 text-teal-700" />
          <div>
            <h3 className="font-display text-sm font-semibold text-slate-900">Billing, Cashier &amp; General Ledger Controls</h3>
            <p className="text-xs text-slate-500">Currency rules, shift enforcement, discount limits, and expense approval gates.</p>
          </div>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            savePartialSettings(
              {
                currencyCode: billing.currencyCode,
                currencySymbol: billing.currencySymbol,
                expenseAutoPostLimit: Number(billing.expenseAutoPostLimit),
                billing: {
                  defaultTaxRatePct: Number(billing.defaultTaxRatePct),
                  cashierMaxDiscountPct: Number(billing.cashierMaxDiscountPct),
                  requireShiftForCollection: billing.requireShiftForCollection,
                  allowPartialPayments: billing.allowPartialPayments,
                  allowInsuranceCreditBilling: billing.allowInsuranceCreditBilling,
                  receiptFooterNote: billing.receiptFooterNote,
                },
              },
              'Billing configuration saved.'
            );
          }}
          className="p-6 space-y-4 text-xs"
        >
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block font-medium text-slate-700 mb-1">Currency Code</label>
              <input
                required
                disabled={!canManageConfig}
                value={billing.currencyCode}
                onChange={(e) => setBilling({ ...billing, currencyCode: e.target.value.toUpperCase() })}
                className="w-full px-3 py-2 font-mono border border-slate-300 rounded-md disabled:bg-slate-50"
              />
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">Currency Symbol</label>
              <input
                required
                disabled={!canManageConfig}
                value={billing.currencySymbol}
                onChange={(e) => setBilling({ ...billing, currencySymbol: e.target.value })}
                className="w-full px-3 py-2 font-mono border border-slate-300 rounded-md disabled:bg-slate-50"
              />
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">Expense Auto-Post Limit</label>
              <input
                type="number"
                min={0}
                disabled={!canManageConfig}
                value={billing.expenseAutoPostLimit}
                onChange={(e) => setBilling({ ...billing, expenseAutoPostLimit: Number(e.target.value) })}
                className="w-full px-3 py-2 font-mono border border-slate-300 rounded-md disabled:bg-slate-50"
              />
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">Default Tax Rate (%)</label>
              <input
                type="number"
                min={0}
                max={100}
                step="0.5"
                disabled={!canManageConfig}
                value={billing.defaultTaxRatePct}
                onChange={(e) => setBilling({ ...billing, defaultTaxRatePct: Number(e.target.value) })}
                className="w-full px-3 py-2 font-mono border border-slate-300 rounded-md disabled:bg-slate-50"
              />
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">Cashier Max Discount (%)</label>
              <input
                type="number"
                min={0}
                max={100}
                step="1"
                disabled={!canManageConfig}
                value={billing.cashierMaxDiscountPct}
                onChange={(e) => setBilling({ ...billing, cashierMaxDiscountPct: Number(e.target.value) })}
                className="w-full px-3 py-2 font-mono border border-slate-300 rounded-md disabled:bg-slate-50"
              />
            </div>
          </div>

          <div className="space-y-2 p-3.5 bg-slate-50 border border-slate-200 rounded-md">
            {(
              [
                ['requireShiftForCollection', 'Require open Cashier Shift before accepting payments'],
                ['allowPartialPayments', 'Allow partial installment payments on open invoices'],
                ['allowInsuranceCreditBilling', 'Enable corporate / insurance credit billing workflows'],
              ] as const
            ).map(([k, lbl]) => (
              <label key={k} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  disabled={!canManageConfig}
                  checked={billing[k]}
                  onChange={(e) => setBilling({ ...billing, [k]: e.target.checked })}
                />
                <span className="text-slate-700">{lbl}</span>
              </label>
            ))}
          </div>

          <div>
            <label className="block font-medium text-slate-700 mb-1">Official Receipt Footer Note</label>
            <input
              disabled={!canManageConfig}
              value={billing.receiptFooterNote}
              onChange={(e) => setBilling({ ...billing, receiptFooterNote: e.target.value })}
              className="w-full px-3 py-2 border border-slate-300 rounded-md disabled:bg-slate-50"
            />
          </div>

          {canManageConfig && (
            <div className="pt-3 border-t border-slate-200 flex justify-end">
              <button
                type="submit"
                disabled={saving}
                className="px-4 py-2 font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Save Billing Settings'}
              </button>
            </div>
          )}
        </form>
      </div>
    );
  }

  if (section === 'notifications_config') {
    return (
      <div className="bg-white border border-slate-200 rounded-lg max-w-2xl">
        <div className="px-6 py-4 border-b border-slate-200 flex items-center gap-2.5">
          <Bell className="w-4 h-4 text-teal-700" />
          <div>
            <h3 className="font-display text-sm font-semibold text-slate-900">Notification Channels &amp; Routing</h3>
            <p className="text-xs text-slate-500">Configure automated operational and security event alerts.</p>
          </div>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            savePartialSettings({ notifications }, 'Notification preferences saved.');
          }}
          className="p-6 space-y-3 text-xs"
        >
          {(
            [
              ['enableInAppAlerts', 'Enable real-time SSE in-app alerts across staff workspaces'],
              ['enableSmsAlerts', 'Enable SMS gateway dispatch hooks (when configured)'],
              ['enableEmailAlerts', 'Enable transactional email alert hooks'],
              ['notifyDoctorOnAssignment', 'Notify OPD Doctor immediately upon patient assignment'],
              ['notifyNurseOnPaymentClearance', 'Notify Triage Nurse when consultation invoice is cleared'],
              ['notifyAdminOnAccessReview', 'Notify System Admin when HR deactivates/terminates an employee'],
              ['criticalLabAlertImmediate', 'Send critical-severity alert immediately on abnormal lab values'],
            ] as const
          ).map(([k, lbl]) => (
            <label key={k} className="flex items-center gap-2.5 p-2.5 border border-slate-200 rounded-md cursor-pointer hover:bg-slate-50">
              <input
                type="checkbox"
                disabled={!canManageConfig}
                checked={notifications[k]}
                onChange={(e) => setNotifications({ ...notifications, [k]: e.target.checked })}
              />
              <span className="text-slate-800">{lbl}</span>
            </label>
          ))}
          {canManageConfig && (
            <div className="pt-3 border-t border-slate-200 flex justify-end">
              <button
                type="submit"
                disabled={saving}
                className="px-4 py-2 font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Save Notification Rules'}
              </button>
            </div>
          )}
        </form>
      </div>
    );
  }

  if (section === 'documents_config') {
    return (
      <div className="bg-white border border-slate-200 rounded-lg max-w-2xl">
        <div className="px-6 py-4 border-b border-slate-200 flex items-center gap-2.5">
          <FileText className="w-4 h-4 text-teal-700" />
          <div>
            <h3 className="font-display text-sm font-semibold text-slate-900">Document &amp; Print Headers</h3>
            <p className="text-xs text-slate-500">Standard headers printed on prescriptions, lab reports, radiology reports, and receipts.</p>
          </div>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            savePartialSettings({ documents }, 'Document templates saved.');
          }}
          className="p-6 space-y-4 text-xs"
        >
          <div>
            <label className="block font-medium text-slate-700 mb-1">Prescription Header</label>
            <input
              disabled={!canManageConfig}
              value={documents.prescriptionHeader}
              onChange={(e) => setDocuments({ ...documents, prescriptionHeader: e.target.value })}
              className="w-full px-3 py-2 border border-slate-300 rounded-md disabled:bg-slate-50"
            />
          </div>
          <div>
            <label className="block font-medium text-slate-700 mb-1">Laboratory Report Header</label>
            <input
              disabled={!canManageConfig}
              value={documents.labReportHeader}
              onChange={(e) => setDocuments({ ...documents, labReportHeader: e.target.value })}
              className="w-full px-3 py-2 border border-slate-300 rounded-md disabled:bg-slate-50"
            />
          </div>
          <div>
            <label className="block font-medium text-slate-700 mb-1">Radiology / Imaging Report Header</label>
            <input
              disabled={!canManageConfig}
              value={documents.radiologyHeader}
              onChange={(e) => setDocuments({ ...documents, radiologyHeader: e.target.value })}
              className="w-full px-3 py-2 border border-slate-300 rounded-md disabled:bg-slate-50"
            />
          </div>
          <div>
            <label className="block font-medium text-slate-700 mb-1">Invoice &amp; Receipt Header</label>
            <input
              disabled={!canManageConfig}
              value={documents.invoiceHeader}
              onChange={(e) => setDocuments({ ...documents, invoiceHeader: e.target.value })}
              className="w-full px-3 py-2 border border-slate-300 rounded-md disabled:bg-slate-50"
            />
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              disabled={!canManageConfig}
              checked={documents.showClinicStampOnPrint}
              onChange={(e) => setDocuments({ ...documents, showClinicStampOnPrint: e.target.checked })}
            />
            <span className="text-slate-800">Include verified facility seal and timestamp footer on printed clinical reports</span>
          </label>
          {canManageConfig && (
            <div className="pt-3 border-t border-slate-200 flex justify-end">
              <button
                type="submit"
                disabled={saving}
                className="px-4 py-2 font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Save Document Templates'}
              </button>
            </div>
          )}
        </form>
      </div>
    );
  }

  if (section === 'security_config') {
    return (
      <div className="bg-white border border-slate-200 rounded-lg max-w-2xl">
        <div className="px-6 py-4 border-b border-slate-200 flex items-center gap-2.5">
          <Lock className="w-4 h-4 text-teal-700" />
          <div>
            <h3 className="font-display text-sm font-semibold text-slate-900">Authentication, Lockout &amp; Session Policies</h3>
            <p className="text-xs text-slate-500">Enforced server-side during authentication, password changes, and JWT verification.</p>
          </div>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            savePartialSettings({ security }, 'Security policies saved.');
          }}
          className="p-6 space-y-4 text-xs"
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block font-medium text-slate-700 mb-1">Session Lifetime (minutes)</label>
              <input
                type="number"
                min={15}
                max={1440}
                disabled={!canManageConfig}
                value={security.sessionTimeoutMinutes}
                onChange={(e) => setSecurity({ ...security, sessionTimeoutMinutes: Number(e.target.value) })}
                className="w-full px-3 py-2 font-mono border border-slate-300 rounded-md disabled:bg-slate-50"
              />
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">Minimum Password Length</label>
              <input
                type="number"
                min={8}
                max={64}
                disabled={!canManageConfig}
                value={security.passwordMinLength}
                onChange={(e) => setSecurity({ ...security, passwordMinLength: Number(e.target.value) })}
                className="w-full px-3 py-2 font-mono border border-slate-300 rounded-md disabled:bg-slate-50"
              />
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">Max Failed Login Attempts</label>
              <input
                type="number"
                min={3}
                max={15}
                disabled={!canManageConfig}
                value={security.maxFailedLoginAttempts}
                onChange={(e) => setSecurity({ ...security, maxFailedLoginAttempts: Number(e.target.value) })}
                className="w-full px-3 py-2 font-mono border border-slate-300 rounded-md disabled:bg-slate-50"
              />
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">Lockout Duration (minutes)</label>
              <input
                type="number"
                min={1}
                max={240}
                disabled={!canManageConfig}
                value={security.lockoutDurationMinutes}
                onChange={(e) => setSecurity({ ...security, lockoutDurationMinutes: Number(e.target.value) })}
                className="w-full px-3 py-2 font-mono border border-slate-300 rounded-md disabled:bg-slate-50"
              />
            </div>
          </div>

          <div className="space-y-2 p-3.5 bg-slate-50 border border-slate-200 rounded-md">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                disabled={!canManageConfig}
                checked={security.requireMixedCasePassword}
                onChange={(e) => setSecurity({ ...security, requireMixedCasePassword: e.target.checked })}
              />
              <span>Require uppercase, lowercase, and numeric characters in staff passwords</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                disabled={!canManageConfig}
                checked={security.enforce2faForPrivilegedRoles}
                onChange={(e) => setSecurity({ ...security, enforce2faForPrivilegedRoles: e.target.checked })}
              />
              <span>Enforce 2FA verification for ADM, ACC, and MGR accounts</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                disabled={!canManageConfig}
                checked={security.allowMultipleActiveSessions}
                onChange={(e) => setSecurity({ ...security, allowMultipleActiveSessions: e.target.checked })}
              />
              <span>Allow concurrent active sessions across multiple terminals</span>
            </label>
          </div>

          {canManageConfig && (
            <div className="pt-3 border-t border-slate-200 flex justify-end">
              <button
                type="submit"
                disabled={saving}
                className="px-4 py-2 font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Save Security Policy'}
              </button>
            </div>
          )}
        </form>
      </div>
    );
  }

  // Backup & Maintenance Section
  return (
    <div className="space-y-4 max-w-4xl">
      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <Database className="w-4 h-4 text-teal-700" />
            <div>
              <h3 className="font-display text-sm font-semibold text-slate-900">Backup Readiness &amp; Database Integrity</h3>
              <p className="text-xs text-slate-500">
                Verify database page integrity, SHA-256 append-only audit log chain, and active staff sessions.
              </p>
            </div>
          </div>
          {canManageBackup && (
            <button
              type="button"
              disabled={verifyingBackup}
              onClick={handleRunBackupVerify}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-md disabled:opacity-50"
            >
              <ShieldCheck className="w-3.5 h-3.5" />
              <span>{verifyingBackup ? 'Verifying...' : 'Run Integrity & Backup Check'}</span>
            </button>
          )}
        </div>

        {backupStatus && (
          <div className="p-6 space-y-5 text-xs">
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
              <div className="p-3.5 border border-slate-200 rounded-md">
                <div className="text-slate-500">Active Engine</div>
                <div className="font-mono font-semibold text-sm text-slate-900 mt-1 uppercase">
                  {backupStatus.dialect}
                </div>
                <div className="text-[11px] text-slate-500 mt-0.5">
                  MySQL Configured: {backupStatus.mysqlConfigured ? 'Yes' : 'No (Local SQLite)'}
                </div>
              </div>
              <div className="p-3.5 border border-slate-200 rounded-md">
                <div className="text-slate-500">Engine Integrity</div>
                <div className="font-mono font-semibold text-sm text-emerald-700 mt-1 uppercase">
                  {backupStatus.sqliteIntegrity}
                </div>
                <div className="text-[11px] font-mono text-slate-500 mt-0.5 tabular-nums">
                  {backupStatus.sqliteFileBytes !== null
                    ? `${(backupStatus.sqliteFileBytes / 1024).toFixed(1)} KB on disk`
                    : 'Managed InnoDB storage'}
                </div>
              </div>
              <div className="p-3.5 border border-slate-200 rounded-md">
                <div className="text-slate-500">Last Verified</div>
                <div className="font-mono font-semibold text-slate-900 mt-1 tabular-nums">
                  {backupStatus.lastBackupVerifiedAt ? backupStatus.lastBackupVerifiedAt.slice(0, 16) : 'Not verified yet'}
                </div>
                <div className="text-[11px] text-slate-500 mt-0.5">
                  {backupStatus.lastBackupVerifiedBy ? `By ${backupStatus.lastBackupVerifiedBy}` : 'Run check above'}
                </div>
              </div>
              <div className="p-3.5 border border-slate-200 rounded-md">
                <div className="text-slate-500">Active Login Sessions</div>
                <div className="font-mono font-semibold text-sm text-teal-800 mt-1 tabular-nums">
                  {backupStatus.tableCounts.activeSessions}
                </div>
                <div className="text-[11px] text-slate-500 mt-0.5">Tracked JTI tokens</div>
              </div>
            </div>

            <div>
              <div className="font-semibold text-slate-900 mb-2">Core Table Record Inventory</div>
              <div className="grid grid-cols-2 sm:grid-cols-6 gap-2.5 font-mono">
                {(
                  [
                    ['Patients', backupStatus.tableCounts.patients],
                    ['Visits', backupStatus.tableCounts.visits],
                    ['Invoices', backupStatus.tableCounts.invoices],
                    ['HR Staff', backupStatus.tableCounts.hrEmployees],
                    ['Users', backupStatus.tableCounts.users],
                    ['Audit Rows', backupStatus.tableCounts.auditLogs],
                  ] as const
                ).map(([lbl, cnt]) => (
                  <div key={lbl} className="p-2.5 bg-slate-50 border border-slate-200 rounded text-center">
                    <div className="text-[11px] font-sans text-slate-500">{lbl}</div>
                    <div className="text-sm font-semibold text-slate-900 tabular-nums mt-0.5">{cnt}</div>
                  </div>
                ))}
              </div>
            </div>

            {verifyReport && (
              <div
                className={`p-4 rounded-md border flex items-start gap-3 ${
                  verifyReport.integrityOk && verifyReport.auditChain.valid
                    ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                    : 'bg-red-50 border-red-200 text-red-900'
                }`}
              >
                <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <div className="font-semibold">
                    Verification Run Completed · {verifyReport.verifiedAt}
                  </div>
                  <div>
                    Storage Check: <span className="font-mono">{verifyReport.integrityDetail}</span> · Audit Hash Chain:{' '}
                    <span className="font-mono">
                      {verifyReport.auditChain.valid
                        ? `Valid (${verifyReport.auditChain.totalRows} rows)`
                        : `Broken at ID #${verifyReport.auditChain.brokenAtId}`}
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
