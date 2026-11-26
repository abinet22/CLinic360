import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, DollarSign, FileText, Lock, Printer, Search, ShieldAlert, UserCheck, UserPlus, Wallet, X } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { useRealtimeSync } from '../lib/useRealtimeSync';
import type { Admission, ApprovalRequest, CashierShift, Invoice, Patient, PatientDeposit, PaymentGateBypass, UserContext } from '../types';

interface DoctorOption {
  id: number;
  full_name: string;
  email: string;
  specialty: string | null;
}

interface ServiceCatalog {
  id: number;
  code: string;
  name: string;
  category: string;
  unit_price: number;
}

interface PrintableReceipt {
  receipt: {
    receipt_number: string;
    invoice_number: string;
    amount: number;
    payment_method: string;
    issued_at: string;
    mrn: string;
    first_name: string;
    last_name: string;
    cashier_name: string;
    total_amount: number;
    paid_amount: number;
    discount_amount: number;
    reprint_count?: number;
  };
  items: Array<{ description: string; quantity: number; unit_price: number; line_total: number }>;
}

interface PaymentReportRow {
  payment_date: string;
  cashier_name: string;
  payment_method: string;
  tx_count: number;
  total_amount: number;
}

interface BillingCashierViewProps {
  user: UserContext;
  onNotify: (msg: string, type?: 'success' | 'error') => void;
  initialSubTab?: 'invoices' | 'payments' | 'deposits' | 'approvals' | 'bypasses' | 'shifts' | 'reports';
}

export const BillingCashierView: React.FC<BillingCashierViewProps> = ({ user, onNotify, initialSubTab }) => {
  const [subTab, setSubTab] = useState<'invoices' | 'payments' | 'deposits' | 'approvals' | 'bypasses' | 'shifts' | 'reports'>(
    initialSubTab || 'invoices'
  );
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [invTotal, setInvTotal] = useState(0);
  const [invPage, setInvPage] = useState(1);
  const [invSearch, setInvSearch] = useState('');
  const [invStatus, setInvStatus] = useState('all');

  const [payReportFrom, setPayReportFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return d.toISOString().slice(0, 10);
  });
  const [payReportTo, setPayReportTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [payReportRows, setPayReportRows] = useState<PaymentReportRow[]>([]);
  const [payReportOwnOnly, setPayReportOwnOnly] = useState(true);
  const [payReportLoading, setPayReportLoading] = useState(false);

  const [deposits, setDeposits] = useState<PatientDeposit[]>([]);
  const [shifts, setShifts] = useState<CashierShift[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [bypasses, setBypasses] = useState<PaymentGateBypass[]>([]);
  const [resolveTarget, setResolveTarget] = useState<PaymentGateBypass | null>(null);
  const [resolveNote, setResolveNote] = useState('');
  const [patients, setPatients] = useState<Patient[]>([]);
  const [doctors, setDoctors] = useState<DoctorOption[]>([]);
  const [admissions, setAdmissions] = useState<Admission[]>([]);
  const [services, setServices] = useState<ServiceCatalog[]>([]);

  const [showCheckIn, setShowCheckIn] = useState(false);
  const [checkInMode, setCheckInMode] = useState<'existing' | 'new'>('existing');
  const [checkInSearch, setCheckInSearch] = useState('');
  const [checkInPatientId, setCheckInPatientId] = useState('');
  const [checkInVisitType, setCheckInVisitType] = useState<'walk_in' | 'scheduled' | 'follow_up'>('walk_in');
  const [checkInSpecialty, setCheckInSpecialty] = useState('General Medicine');
  const [checkInDoctorId, setCheckInDoctorId] = useState('');
  const [checkInPriority, setCheckInPriority] = useState<'routine' | 'urgent' | 'emergency'>('routine');
  const [checkInComplaint, setCheckInComplaint] = useState('');
  const [newPatientForm, setNewPatientForm] = useState({
    first_name: '',
    last_name: '',
    sex: 'Female',
    date_of_birth: '1993-04-12',
    phone: '',
    next_of_kin_name: '',
    next_of_kin_phone: '',
    patient_type: 'self-pay',
    payer_name: '',
    insurance_number: '',
  });

  const [openingFloat, setOpeningFloat] = useState('200.00');
  const [countedCash, setCountedCash] = useState('');
  const [shiftNotes, setShiftNotes] = useState('');

  const [payTarget, setPayTarget] = useState<Invoice | null>(null);
  const [payAmount, setPayAmount] = useState('');
  const [payMethod, setPayMethod] = useState('cash');
  const [payRef, setPayRef] = useState('');

  const [showNewInvoice, setShowNewInvoice] = useState(false);
  const [newInvPatientId, setNewInvPatientId] = useState('');
  const [newInvServiceCode, setNewInvServiceCode] = useState('');

  const [showNewDeposit, setShowNewDeposit] = useState(false);
  const [depForm, setDepForm] = useState({
    patient_id: '',
    admission_id: '',
    amount: '250.00',
    payment_method: 'cash',
    reference_number: '',
  });

  const [applyDepTarget, setApplyDepTarget] = useState<PatientDeposit | null>(null);
  const [applyInvoiceId, setApplyInvoiceId] = useState('');

  const [approvalTarget, setApprovalTarget] = useState<Invoice | null>(null);
  const [approvalType, setApprovalType] = useState<'discount' | 'refund' | 'void_invoice'>('discount');
  const [approvalAmount, setApprovalAmount] = useState('10.00');
  const [approvalReason, setApprovalReason] = useState('');

  const [receiptPreview, setReceiptPreview] = useState<PrintableReceipt | null>(null);

  const canReadInvoices = user.permissions.includes('billing.invoice.read');
  const canCreateInvoice = user.permissions.includes('billing.invoice.create');
  const canTakePayment = user.permissions.includes('billing.payment.create');
  const canCreateDeposit = user.permissions.includes('billing.deposit.create');
  const canManageShift = user.permissions.includes('billing.shift.manage');
  const canReconcileShift = user.permissions.includes('billing.shift.reconcile');
  const canRequestApproval = user.permissions.includes('billing.approval.request');
  const canDecideApproval = user.permissions.includes('billing.approval.decide');
  const canViewReports =
    user.permissions.includes('finance.report.view') ||
    user.permissions.includes('billing.report.own') ||
    user.permissions.includes('audit.read');
  const canPrintReceipt =
    user.permissions.includes('billing.receipt.print') || user.permissions.includes('finance.report.view');

  useEffect(() => {
    if (initialSubTab) {
      setSubTab(initialSubTab);
    }
  }, [initialSubTab]);

  useEffect(() => {
    if (!receiptPreview) return;
    document.body.classList.add('has-print-modal');
    return () => {
      document.body.classList.remove('has-print-modal');
    };
  }, [receiptPreview]);

  const loadBilling = useCallback(async () => {
    try {
      const qs = new URLSearchParams({
        page: String(invPage),
        limit: '25',
        status: invStatus,
      });
      if (invSearch.trim()) qs.set('q', invSearch.trim());

      const [invRes, depRes, shfRes, appRes, bypRes] = await Promise.all([
        canReadInvoices
          ? apiFetch<{ invoices: Invoice[]; total?: number }>(`/api/billing/invoices?${qs}`).catch(() => ({
              invoices: [] as Invoice[],
              total: 0,
            }))
          : Promise.resolve({ invoices: [] as Invoice[], total: 0 }),
        canReadInvoices || canCreateDeposit
          ? apiFetch<{ deposits: PatientDeposit[] }>('/api/billing/deposits').catch(() => ({ deposits: [] as PatientDeposit[] }))
          : Promise.resolve({ deposits: [] as PatientDeposit[] }),
        canManageShift || canReconcileShift || canReadInvoices
          ? apiFetch<{ shifts: CashierShift[] }>('/api/billing/shifts').catch(() => ({ shifts: [] as CashierShift[] }))
          : Promise.resolve({ shifts: [] as CashierShift[] }),
        canReadInvoices || canRequestApproval || canDecideApproval
          ? apiFetch<{ approvals: ApprovalRequest[] }>('/api/billing/approvals').catch(() => ({ approvals: [] as ApprovalRequest[] }))
          : Promise.resolve({ approvals: [] as ApprovalRequest[] }),
        canReadInvoices || canTakePayment
          ? apiFetch<{ bypasses: PaymentGateBypass[] }>('/api/billing/bypasses').catch(() => ({ bypasses: [] as PaymentGateBypass[] }))
          : Promise.resolve({ bypasses: [] as PaymentGateBypass[] }),
      ]);
      setInvoices(invRes.invoices || []);
      setInvTotal(typeof invRes.total === 'number' ? invRes.total : (invRes.invoices || []).length);
      setDeposits(depRes.deposits || []);
      setShifts(shfRes.shifts || []);
      setApprovals(appRes.approvals || []);
      setBypasses(bypRes.bypasses || []);
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }, [
    onNotify,
    invPage,
    invStatus,
    invSearch,
    canReadInvoices,
    canCreateDeposit,
    canManageShift,
    canReconcileShift,
    canRequestApproval,
    canDecideApproval,
    canTakePayment,
  ]);

  const loadPaymentReport = useCallback(async () => {
    if (!canViewReports) return;
    setPayReportLoading(true);
    try {
      const res = await apiFetch<{ ownOnly?: boolean; rows: PaymentReportRow[] }>(
        `/api/reports/daily-cash?from=${encodeURIComponent(payReportFrom)}&to=${encodeURIComponent(payReportTo)}`
      );
      setPayReportRows(res.rows || []);
      setPayReportOwnOnly(Boolean(res.ownOnly));
    } catch (err) {
      onNotify((err as Error).message, 'error');
    } finally {
      setPayReportLoading(false);
    }
  }, [canViewReports, payReportFrom, payReportTo, onNotify]);

  useEffect(() => {
    loadBilling();
  }, [loadBilling]);

  useEffect(() => {
    if (subTab === 'reports' && canViewReports) {
      loadPaymentReport();
    }
  }, [subTab, canViewReports, loadPaymentReport]);

  useRealtimeSync(
    ['payment:confirmed', 'visit:updated', 'lab:updated', 'imaging:updated', 'pharmacy:updated'],
    () => {
      loadBilling();
      if (subTab === 'reports' && canViewReports) loadPaymentReport();
    }
  );

  const loadReferenceData = useCallback(async () => {
    if (!(canCreateInvoice || canCreateDeposit || user.permissions.includes('visit.create'))) return;
    try {
      const [pRes, sRes, dRes, ipdRes] = await Promise.all([
        apiFetch<{ patients: Patient[] }>('/api/patients?limit=80'),
        apiFetch<{ services: ServiceCatalog[] }>('/api/catalog/services'),
        apiFetch<{ doctors: DoctorOption[] }>('/api/doctors').catch(() => ({ doctors: [] as DoctorOption[] })),
        user.permissions.includes('ipd.admission.read')
          ? apiFetch<{ admissions: Admission[] }>('/api/ipd/overview')
          : Promise.resolve({ admissions: [] as Admission[] }),
      ]);
      setPatients(pRes.patients || []);
      setServices(sRes.services || []);
      setDoctors(dRes.doctors || []);
      setAdmissions(ipdRes.admissions || []);
      if (pRes.patients[0]) {
        setNewInvPatientId((prev) => prev || String(pRes.patients[0].id));
        setCheckInPatientId((prev) => prev || String(pRes.patients[0].id));
        setDepForm((prev) => (prev.patient_id ? prev : { ...prev, patient_id: String(pRes.patients[0].id) }));
      }
      if (dRes.doctors[0]) {
        setCheckInDoctorId((prev) => prev || String(dRes.doctors[0].id));
      }
      if (sRes.services[0]) setNewInvServiceCode((prev) => prev || sRes.services[0].code);
    } catch {
      // ignore
    }
  }, [canCreateInvoice, canCreateDeposit, user.permissions]);

  useEffect(() => {
    loadReferenceData();
  }, [loadReferenceData]);

  async function handleFrontDeskCheckIn(e: React.FormEvent) {
    e.preventDefault();
    try {
      let targetPatientId = Number(checkInPatientId);
      if (checkInMode === 'new') {
        if (!newPatientForm.first_name.trim() || !newPatientForm.last_name.trim() || !newPatientForm.phone.trim()) {
          onNotify('First name, last name, and phone are required for new EMR registration.', 'error');
          return;
        }
        const created = await apiFetch<{ patient: Patient }>('/api/patients', {
          method: 'POST',
          body: JSON.stringify({
            ...newPatientForm,
            issue_queue_ticket: false,
            charge_registration_card: false,
          }),
        });
        targetPatientId = created.patient.id;
      }

      if (!targetPatientId) {
        onNotify('Select or register a patient first.', 'error');
        return;
      }

      const visitRes = await apiFetch<{
        id: number;
        visitNumber: string;
        workflowStage: string;
        consultationInvoiceId: number | null;
        consultationInvoiceNumber: string | null;
        consultationInvoiceStatus: string | null;
        ticketNumber: string;
      }>('/api/visits', {
        method: 'POST',
        body: JSON.stringify({
          patient_id: targetPatientId,
          doctor_id: checkInDoctorId ? Number(checkInDoctorId) : null,
          visit_type: checkInVisitType,
          specialty: checkInSpecialty,
          triage_priority: checkInPriority,
          chief_complaint: checkInComplaint || `${checkInSpecialty} consultation`,
          generate_consultation_invoice: true,
        }),
      });

      onNotify(
        `Visit ${visitRes.visitNumber} (${visitRes.ticketNumber}) started · ${
          visitRes.workflowStage === 'awaiting_payment'
            ? `Invoice ${visitRes.consultationInvoiceNumber} awaiting payment`
            : 'Paid / Cleared — Awaiting Vitals'
        }`,
        'success'
      );
      setShowCheckIn(false);
      setCheckInComplaint('');
      setNewPatientForm({
        first_name: '',
        last_name: '',
        sex: 'Female',
        date_of_birth: '1993-04-12',
        phone: '',
        next_of_kin_name: '',
        next_of_kin_phone: '',
        patient_type: 'self-pay',
        payer_name: '',
        insurance_number: '',
      });
      await loadReferenceData();
      const invRes = await apiFetch<{ invoices: Invoice[]; total?: number }>('/api/billing/invoices?page=1&limit=25&status=all');
      setInvoices(invRes.invoices || []);
      setInvTotal(typeof invRes.total === 'number' ? invRes.total : (invRes.invoices || []).length);

      if (visitRes.consultationInvoiceId && visitRes.consultationInvoiceStatus === 'unpaid' && canTakePayment) {
        const createdInv = (invRes.invoices || []).find((i) => i.id === visitRes.consultationInvoiceId);
        if (createdInv) {
          setPayTarget(createdInv);
          setPayAmount(Number(createdInv.total_amount).toFixed(2));
        }
      }
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  const myOpenShift = shifts.find((s) => s.cashier_id === user.id && s.status === 'open');

  async function handleOpenShift() {
    try {
      await apiFetch('/api/billing/shifts/open', {
        method: 'POST',
        body: JSON.stringify({ opening_float: Number(openingFloat) }),
      });
      onNotify('Cashier shift opened', 'success');
      loadBilling();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleCloseShift(shiftId: number) {
    try {
      const res = await apiFetch<{ variance: number }>('/api/billing/shifts/close', {
        method: 'POST',
        body: JSON.stringify({
          shift_id: shiftId,
          counted_cash: Number(countedCash || 0),
          notes: shiftNotes || undefined,
        }),
      });
      onNotify(`Shift closed · Cash variance: $${res.variance.toFixed(2)}`, 'success');
      setCountedCash('');
      setShiftNotes('');
      loadBilling();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleReconcileShift(shiftId: number) {
    try {
      await apiFetch(`/api/billing/shifts/${shiftId}/reconcile`, { method: 'POST' });
      onNotify(`Shift #${shiftId} reconciled by Finance`, 'success');
      loadBilling();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleCreateInvoice(e: React.FormEvent) {
    e.preventDefault();
    const svc = services.find((s) => s.code === newInvServiceCode);
    if (!svc || !newInvPatientId) return;
    try {
      const res = await apiFetch<{ invoiceNumber: string }>('/api/billing/invoices', {
        method: 'POST',
        body: JSON.stringify({
          patient_id: Number(newInvPatientId),
          items: [
            {
              service_code: svc.code,
              description: svc.name,
              category: svc.category,
              quantity: 1,
              unit_price: svc.unit_price,
            },
          ],
        }),
      });
      onNotify(`Created invoice ${res.invoiceNumber}`, 'success');
      setShowNewInvoice(false);
      loadBilling();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleCollectPayment(e: React.FormEvent) {
    e.preventDefault();
    if (!payTarget) return;
    try {
      const res = await apiFetch<{ receiptNumber: string }>('/api/billing/payments', {
        method: 'POST',
        body: JSON.stringify({
          invoice_id: payTarget.id,
          amount: Number(payAmount),
          payment_method: payMethod,
          reference_number: payRef || null,
        }),
      });
      onNotify(`Payment collected · Receipt ${res.receiptNumber} issued`, 'success');
      setPayTarget(null);
      setPayRef('');
      loadBilling();
      if (canPrintReceipt) {
        openReceipt(res.receiptNumber);
      }
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function openReceipt(receiptNumber: string) {
    try {
      const data = await apiFetch<PrintableReceipt>(`/api/billing/receipts/${receiptNumber}`);
      setReceiptPreview(data);
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleReprintReceipt(receiptNumber: string) {
    try {
      const res = await apiFetch<{ reprintCount: number }>(`/api/billing/receipts/${receiptNumber}/reprint`, {
        method: 'POST',
      });
      setReceiptPreview((prev) =>
        prev ? { ...prev, receipt: { ...prev.receipt, reprint_count: res.reprintCount } } : prev
      );
      onNotify(`Reprint Copy #${res.reprintCount} logged to audit trail`, 'success');
      window.print();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleSubmitApproval(e: React.FormEvent) {
    e.preventDefault();
    if (!approvalTarget) return;
    try {
      await apiFetch('/api/billing/approvals', {
        method: 'POST',
        body: JSON.stringify({
          request_type: approvalType,
          entity_id: approvalTarget.id,
          requested_amount: approvalType === 'discount' || approvalType === 'refund' ? Number(approvalAmount) : null,
          reason: approvalReason,
        }),
      });
      onNotify('Approval request submitted to Finance/Manager', 'success');
      setApprovalTarget(null);
      setApprovalReason('');
      loadBilling();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleDecideApproval(id: number, decision: 'approved' | 'rejected') {
    try {
      await apiFetch(`/api/billing/approvals/${id}/decide`, {
        method: 'POST',
        body: JSON.stringify({ decision, decision_note: `${decision} via Finance queue` }),
      });
      onNotify(`Request ${decision}`, 'success');
      loadBilling();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleCollectDeposit(e: React.FormEvent) {
    e.preventDefault();
    try {
      const res = await apiFetch<{ depositNumber: string }>('/api/billing/deposits', {
        method: 'POST',
        body: JSON.stringify({
          patient_id: Number(depForm.patient_id),
          admission_id: depForm.admission_id ? Number(depForm.admission_id) : null,
          amount: Number(depForm.amount),
          payment_method: depForm.payment_method,
          reference_number: depForm.reference_number || null,
        }),
      });
      onNotify(`Advance deposit ${res.depositNumber} recorded`, 'success');
      setShowNewDeposit(false);
      setDepForm((p) => ({ ...p, reference_number: '' }));
      loadBilling();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleApplyDeposit(e: React.FormEvent) {
    e.preventDefault();
    if (!applyDepTarget || !applyInvoiceId) return;
    try {
      const res = await apiFetch<{ appliedAmount: number; invoiceStatus: string }>(
        `/api/billing/deposits/${applyDepTarget.id}/apply`,
        {
          method: 'POST',
          body: JSON.stringify({ invoice_id: Number(applyInvoiceId) }),
        }
      );
      onNotify(`Applied $${res.appliedAmount.toFixed(2)} from ${applyDepTarget.deposit_number} (${res.invoiceStatus})`, 'success');
      setApplyDepTarget(null);
      setApplyInvoiceId('');
      loadBilling();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleResolveBypass(e: React.FormEvent) {
    e.preventDefault();
    if (!resolveTarget) return;
    try {
      await apiFetch(`/api/billing/bypasses/${resolveTarget.id}/resolve`, {
        method: 'POST',
        body: JSON.stringify({ resolution_note: resolveNote.trim() || 'Resolved via Cashier billing follow-up' }),
      });
      onNotify(`Emergency bypass #${resolveTarget.id} marked resolved`, 'success');
      setResolveTarget(null);
      setResolveNote('');
      loadBilling();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  return (
    <div className="space-y-5">
      {/* Shift Status & Controls */}
      {canManageShift && (
        <div className="bg-white border border-slate-200 rounded-lg p-4 flex flex-wrap items-center justify-between gap-4">
          {myOpenShift ? (
            <>
              <div className="text-xs">
                <div className="font-semibold text-slate-900">
                  Active Cashier Shift #{myOpenShift.id} · Expected Cash:{' '}
                  <span className="font-mono text-teal-800 tabular-nums">
                    ${Number(myOpenShift.expected_cash).toFixed(2)}
                  </span>
                </div>
                <div className="text-slate-500 mt-0.5 font-mono">
                  Opened {myOpenShift.opened_at} · Float ${Number(myOpenShift.opening_float).toFixed(2)}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="number"
                  step="0.01"
                  value={countedCash}
                  onChange={(e) => setCountedCash(e.target.value)}
                  placeholder="Counted cash ($)"
                  className="w-32 px-3 py-1.5 text-xs font-mono border border-slate-300 rounded-md"
                />
                <input
                  value={shiftNotes}
                  onChange={(e) => setShiftNotes(e.target.value)}
                  placeholder="Variance note (if any)"
                  className="w-44 px-3 py-1.5 text-xs border border-slate-300 rounded-md"
                />
                <button
                  onClick={() => handleCloseShift(myOpenShift.id)}
                  className="px-3.5 py-1.5 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-md whitespace-nowrap"
                >
                  Close Shift
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="text-xs text-amber-800 font-medium">
                No open cashier shift. Open a shift before collecting payments.
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  step="0.01"
                  value={openingFloat}
                  onChange={(e) => setOpeningFloat(e.target.value)}
                  className="w-28 px-3 py-1.5 text-xs font-mono border border-slate-300 rounded-md"
                />
                <button
                  onClick={handleOpenShift}
                  className="px-4 py-1.5 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md whitespace-nowrap"
                >
                  Open Shift
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Navigation & Actions */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-200/70 rounded-lg">
          {canReadInvoices && (
            <button
              onClick={() => setSubTab('invoices')}
              className={`px-3.5 py-1.5 text-xs font-medium rounded-md ${
                subTab === 'invoices' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Invoices &amp; Receipts ({invTotal})
            </button>
          )}
          {(canTakePayment || canReadInvoices) && (
            <button
              onClick={() => setSubTab('payments')}
              className={`px-3.5 py-1.5 text-xs font-medium rounded-md ${
                subTab === 'payments' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Payments
            </button>
          )}
          {(canCreateDeposit || canReadInvoices) && (
            <button
              onClick={() => setSubTab('deposits')}
              className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium rounded-md ${
                subTab === 'deposits' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Wallet className="w-3.5 h-3.5" />
              <span>Patient Deposits ({deposits.filter((d) => d.status === 'active').length})</span>
            </button>
          )}
          {(canRequestApproval || canDecideApproval || canReadInvoices) && (
            <button
              onClick={() => setSubTab('approvals')}
              className={`px-3.5 py-1.5 text-xs font-medium rounded-md ${
                subTab === 'approvals' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Approvals ({approvals.filter((a) => a.status === 'pending').length} pending)
            </button>
          )}
          {(canTakePayment || canReadInvoices) && (
            <button
              onClick={() => setSubTab('bypasses')}
              className={`px-3.5 py-1.5 text-xs font-medium rounded-md ${
                subTab === 'bypasses' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Gate Bypasses ({bypasses.filter((b) => b.follow_up_status === 'pending_billing').length} open)
            </button>
          )}
          {(canManageShift || canReconcileShift) && (
            <button
              onClick={() => setSubTab('shifts')}
              className={`px-3.5 py-1.5 text-xs font-medium rounded-md ${
                subTab === 'shifts' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Shift Reconciliation ({shifts.length})
            </button>
          )}
          {canViewReports && (
            <button
              onClick={() => setSubTab('reports')}
              className={`px-3.5 py-1.5 text-xs font-medium rounded-md ${
                subTab === 'reports' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Payment Reports
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {user.permissions.includes('visit.create') && (
            <button
              onClick={() => setShowCheckIn(true)}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md whitespace-nowrap"
            >
              <UserCheck className="w-3.5 h-3.5" />
              <span>Front Desk Check-In</span>
            </button>
          )}
          {canCreateDeposit && (
            <button
              onClick={() => setShowNewDeposit(true)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-teal-800 bg-white border border-teal-300 hover:bg-teal-50 rounded-md whitespace-nowrap"
            >
              <Wallet className="w-3.5 h-3.5" />
              <span>Collect Deposit</span>
            </button>
          )}
          {canCreateInvoice && (
            <button
              onClick={() => setShowNewInvoice(true)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-md whitespace-nowrap"
            >
              <FileText className="w-3.5 h-3.5" />
              <span>Create Invoice</span>
            </button>
          )}
        </div>
      </div>

      {subTab === 'invoices' && (
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="p-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
            <div className="relative flex-1 min-w-[220px] max-w-sm">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                value={invSearch}
                onChange={(e) => {
                  setInvSearch(e.target.value);
                  setInvPage(1);
                }}
                placeholder="Search invoice #, MRN, or patient..."
                className="w-full pl-9 pr-3 py-1.5 text-xs border border-slate-300 rounded-md"
              />
            </div>
            <div className="flex items-center gap-2 text-xs">
              <select
                value={invStatus}
                onChange={(e) => {
                  setInvStatus(e.target.value);
                  setInvPage(1);
                }}
                className="px-2.5 py-1.5 text-xs border border-slate-300 rounded-md bg-white"
              >
                <option value="all">All Statuses</option>
                <option value="unpaid">Unpaid</option>
                <option value="partial">Partial</option>
                <option value="paid">Paid</option>
                <option value="credit_billed">Credit / Insurance</option>
                <option value="voided">Voided</option>
              </select>
              <span className="font-mono text-slate-500">
                Page {invPage} · {invTotal} total
              </span>
              <button
                disabled={invPage <= 1}
                onClick={() => setInvPage((p) => Math.max(1, p - 1))}
                className="px-2.5 py-1 border border-slate-200 rounded disabled:opacity-40 hover:bg-slate-50"
              >
                Prev
              </button>
              <button
                disabled={invPage * 25 >= invTotal}
                onClick={() => setInvPage((p) => p + 1)}
                className="px-2.5 py-1 border border-slate-200 rounded disabled:opacity-40 hover:bg-slate-50"
              >
                Next
              </button>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium text-slate-500">
                  <th className="py-2.5 px-4">Invoice</th>
                  <th className="py-2.5 px-4">Patient</th>
                  <th className="py-2.5 px-4">Line Items</th>
                  <th className="py-2.5 px-4 text-right">Total / Paid</th>
                  <th className="py-2.5 px-4">Status</th>
                  <th className="py-2.5 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-sm">
                {invoices.map((inv) => {
                  const balance = Math.max(0, Number(inv.total_amount) - Number(inv.paid_amount));
                  return (
                    <tr key={inv.id} className="hover:bg-slate-50/70">
                      <td className="py-3 px-4 font-mono text-xs">
                        <div className="font-semibold text-slate-900">{inv.invoice_number}</div>
                        <div className="text-slate-500 capitalize">{inv.payer_type}</div>
                      </td>
                      <td className="py-3 px-4">
                        <div className="font-medium text-slate-900">{inv.first_name} {inv.last_name}</div>
                        <div className="text-xs font-mono text-slate-500">{inv.mrn}</div>
                      </td>
                      <td className="py-3 px-4 text-xs text-slate-600 max-w-[260px]">
                        {inv.items.map((it) => `${it.description} ($${Number(it.line_total).toFixed(2)})`).join(' · ')}
                      </td>
                      <td className="py-3 px-4 text-right font-mono text-xs tabular-nums whitespace-nowrap">
                        <div className="font-semibold text-slate-900">${Number(inv.total_amount).toFixed(2)}</div>
                        <div className="text-slate-500">
                          Paid ${Number(inv.paid_amount).toFixed(2)}
                          {inv.discount_amount > 0 && ` (-$${Number(inv.discount_amount).toFixed(2)})`}
                        </div>
                      </td>
                      <td className="py-3 px-4 text-xs">
                        <span
                          className={
                            inv.status === 'paid'
                              ? 'text-emerald-700 font-semibold'
                              : inv.status === 'voided'
                                ? 'text-slate-400 line-through'
                                : inv.status === 'credit_billed'
                                  ? 'text-sky-700 font-medium'
                                  : 'text-amber-700 font-semibold'
                          }
                        >
                          {inv.status.replace('_', ' ')}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right whitespace-nowrap space-x-1.5">
                        {canTakePayment && balance > 0 && inv.status !== 'voided' && (
                          <button
                            onClick={() => {
                              setPayTarget(inv);
                              setPayAmount(balance.toFixed(2));
                            }}
                            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded"
                          >
                            <DollarSign className="w-3 h-3" />
                            <span>Pay</span>
                          </button>
                        )}
                        {canRequestApproval && inv.status !== 'voided' && (
                          <button
                            onClick={() => {
                              setApprovalTarget(inv);
                              setApprovalType(inv.status === 'paid' ? 'refund' : 'discount');
                              setApprovalAmount(inv.status === 'paid' ? Number(inv.paid_amount).toFixed(2) : '10.00');
                            }}
                            className="px-2.5 py-1 text-xs font-medium text-slate-700 border border-slate-200 hover:bg-slate-50 rounded"
                          >
                            {inv.status === 'paid' ? 'Refund' : 'Waive / Void'}
                          </button>
                        )}
                        {inv.payments[0]?.receipt_number && canPrintReceipt && (
                          <button
                            onClick={() => openReceipt(inv.payments[0].receipt_number!)}
                            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-700 border border-slate-200 hover:bg-slate-50 rounded"
                          >
                            <Printer className="w-3 h-3" />
                            <span>Receipt</span>
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {subTab === 'deposits' && (
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-5 py-3 bg-slate-50 border-b border-slate-200 text-xs text-slate-600 flex items-center justify-between">
            <span>Advance Patient Deposits &amp; Inpatient Wallet Credits (automatically offset bed tariffs or apply manually to unpaid invoices)</span>
          </div>
          {deposits.length === 0 ? (
            <div className="p-10 text-center text-sm text-slate-500">No advance deposits recorded yet.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium text-slate-500">
                    <th className="py-2.5 px-4">Deposit No</th>
                    <th className="py-2.5 px-4">Patient</th>
                    <th className="py-2.5 px-4">Linked Admission</th>
                    <th className="py-2.5 px-4 text-right">Deposited</th>
                    <th className="py-2.5 px-4 text-right">Remaining Credit</th>
                    <th className="py-2.5 px-4">Method &amp; Status</th>
                    {canCreateDeposit && <th className="py-2.5 px-4 text-right">Action</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-xs">
                  {deposits.map((d) => (
                    <tr key={d.id} className="hover:bg-slate-50/70">
                      <td className="py-3 px-4 font-mono font-semibold text-slate-900">
                        <div>{d.deposit_number}</div>
                        <div className="text-[11px] font-normal text-slate-400">{d.created_at}</div>
                      </td>
                      <td className="py-3 px-4">
                        <div className="font-medium text-slate-900">{d.first_name} {d.last_name}</div>
                        <div className="font-mono text-slate-500">{d.mrn}</div>
                      </td>
                      <td className="py-3 px-4 font-mono text-slate-600">{d.admission_number || 'General Wallet'}</td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums">${Number(d.amount).toFixed(2)}</td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums font-semibold text-teal-800">
                        ${Number(d.remaining_amount).toFixed(2)}
                      </td>
                      <td className="py-3 px-4 capitalize">
                        <span className={d.status === 'active' ? 'text-emerald-700 font-semibold' : 'text-slate-500'}>
                          {d.status}
                        </span>
                        <span className="text-slate-400"> · {d.payment_method.replace('_', ' ')}</span>
                      </td>
                      {canCreateDeposit && (
                        <td className="py-3 px-4 text-right">
                          {d.status === 'active' && Number(d.remaining_amount) > 0 && (
                            <button
                              onClick={() => {
                                setApplyDepTarget(d);
                                const candidate = invoices.find(
                                  (inv) => inv.patient_id === d.patient_id && (inv.status === 'unpaid' || inv.status === 'partial')
                                );
                                setApplyInvoiceId(candidate ? String(candidate.id) : '');
                              }}
                              className="px-2.5 py-1 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded"
                            >
                              Apply to Invoice
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {subTab === 'approvals' && (
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-5 py-3 bg-slate-50 border-b border-slate-200 text-xs text-slate-600 flex items-center gap-2">
            <ShieldAlert className="w-4 h-4 text-teal-700" />
            <span>
              Segregation of Duties Enforced: A cashier or requester cannot approve their own discount, refund, or void request.
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium text-slate-500">
                  <th className="py-2.5 px-4">Type &amp; Invoice</th>
                  <th className="py-2.5 px-4">Patient</th>
                  <th className="py-2.5 px-4">Amount / Reason</th>
                  <th className="py-2.5 px-4">Requested By</th>
                  <th className="py-2.5 px-4">Status</th>
                  {canDecideApproval && <th className="py-2.5 px-4 text-right">Finance / Mgr Decision</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-sm">
                {approvals.map((ar) => (
                  <tr key={ar.id} className="hover:bg-slate-50/70">
                    <td className="py-3 px-4 text-xs">
                      <div className="font-semibold text-slate-900 capitalize">{ar.request_type.replace('_', ' ')}</div>
                      <div className="font-mono text-slate-500">
                        {ar.invoice_number || ar.admission_number || `${ar.entity_type} #${ar.entity_id}`}
                      </div>
                    </td>
                    <td className="py-3 px-4 text-xs">
                      <div className="font-medium text-slate-900">{ar.first_name} {ar.last_name}</div>
                      <div className="font-mono text-slate-500">{ar.mrn}</div>
                    </td>
                    <td className="py-3 px-4 text-xs">
                      {ar.requested_amount !== null && (
                        <div className="font-mono font-semibold text-slate-900">-${Number(ar.requested_amount).toFixed(2)}</div>
                      )}
                      <div className="text-slate-600">{ar.reason}</div>
                    </td>
                    <td className="py-3 px-4 text-xs text-slate-700">{ar.requested_by_name}</td>
                    <td className="py-3 px-4 text-xs">
                      <span className={ar.status === 'approved' ? 'text-emerald-700 font-medium' : ar.status === 'rejected' ? 'text-red-700 font-medium' : 'text-amber-700 font-semibold'}>
                        {ar.status}
                      </span>
                      {ar.decided_by_name && <div className="text-slate-400">by {ar.decided_by_name}</div>}
                    </td>
                    {canDecideApproval && (
                      <td className="py-3 px-4 text-right space-x-1.5 whitespace-nowrap">
                        {ar.status === 'pending' && (
                          <>
                            <button
                              onClick={() => handleDecideApproval(ar.id, 'approved')}
                              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-white bg-emerald-700 hover:bg-emerald-800 rounded"
                            >
                              <Check className="w-3 h-3" />
                              <span>Approve</span>
                            </button>
                            <button
                              onClick={() => handleDecideApproval(ar.id, 'rejected')}
                              className="px-2.5 py-1 text-xs font-medium text-red-700 border border-red-200 hover:bg-red-50 rounded"
                            >
                              Reject
                            </button>
                          </>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {subTab === 'bypasses' && (
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-5 py-3 bg-slate-50 border-b border-slate-200 text-xs text-slate-600 flex items-center gap-2">
            <ShieldAlert className="w-4 h-4 text-amber-700" />
            <span>
              Emergency payment-gate bypasses logged by clinicians or diagnostics must be reconciled with billing settlement.
            </span>
          </div>
          {bypasses.length === 0 ? (
            <div className="p-10 text-center text-sm text-slate-500">No emergency payment-gate bypasses recorded.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/70 font-medium text-slate-500">
                    <th className="py-2.5 px-4">Order / Visit</th>
                    <th className="py-2.5 px-4">Patient</th>
                    <th className="py-2.5 px-4">Clinical Bypass Reason</th>
                    <th className="py-2.5 px-4">Authorized By</th>
                    <th className="py-2.5 px-4">Follow-Up Status</th>
                    {canTakePayment && <th className="py-2.5 px-4 text-right">Billing Action</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {bypasses.map((b) => (
                    <tr key={b.id} className="hover:bg-slate-50/70">
                      <td className="py-3 px-4 font-mono">
                        <div className="font-semibold text-slate-900 uppercase">{b.entity_type} #{b.entity_id}</div>
                        <div className="text-slate-500">{b.visit_number || `Visit #${b.visit_id}`}</div>
                      </td>
                      <td className="py-3 px-4">
                        <div className="font-medium text-slate-900">{b.first_name} {b.last_name}</div>
                        <div className="font-mono text-slate-500">{b.mrn}</div>
                      </td>
                      <td className="py-3 px-4 text-slate-700 max-w-xs">{b.reason}</td>
                      <td className="py-3 px-4 text-slate-700">
                        <div>{b.set_by_name || `User #${b.set_by}`}</div>
                        <div className="font-mono text-[11px] text-slate-400">{b.created_at}</div>
                      </td>
                      <td className="py-3 px-4">
                        <span className={b.follow_up_status === 'resolved' ? 'text-emerald-700 font-semibold' : 'text-amber-700 font-semibold'}>
                          {b.follow_up_status === 'resolved' ? 'Resolved' : 'Pending Billing'}
                        </span>
                        {b.resolution_note && <div className="text-slate-500 mt-0.5">{b.resolution_note}</div>}
                      </td>
                      {canTakePayment && (
                        <td className="py-3 px-4 text-right">
                          {b.follow_up_status === 'pending_billing' && (
                            <button
                              onClick={() => {
                                setResolveTarget(b);
                                setResolveNote('');
                              }}
                              className="px-2.5 py-1 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded"
                            >
                              Resolve Follow-Up
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {subTab === 'shifts' && (
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium text-slate-500">
                <th className="py-2.5 px-4">Shift</th>
                <th className="py-2.5 px-4">Cashier</th>
                <th className="py-2.5 px-4 text-right">Float</th>
                <th className="py-2.5 px-4 text-right">Expected Cash</th>
                <th className="py-2.5 px-4 text-right">Counted / Variance</th>
                <th className="py-2.5 px-4">Status</th>
                {canReconcileShift && <th className="py-2.5 px-4 text-right">Finance Action</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-xs">
              {shifts.map((s) => (
                <tr key={s.id}>
                  <td className="py-3 px-4 font-mono">#{s.id} · {s.opened_at}</td>
                  <td className="py-3 px-4 font-medium text-slate-900">{s.cashier_name}</td>
                  <td className="py-3 px-4 text-right font-mono tabular-nums">${Number(s.opening_float).toFixed(2)}</td>
                  <td className="py-3 px-4 text-right font-mono tabular-nums font-semibold">${Number(s.expected_cash).toFixed(2)}</td>
                  <td className="py-3 px-4 text-right font-mono tabular-nums">
                    {s.counted_cash !== null ? `$${Number(s.counted_cash).toFixed(2)} (${Number(s.variance || 0).toFixed(2)})` : '—'}
                  </td>
                  <td className="py-3 px-4 capitalize font-medium">
                    <span className={s.status === 'reconciled' ? 'text-emerald-700' : s.status === 'closed' ? 'text-amber-700' : 'text-teal-800'}>
                      {s.status}
                    </span>
                  </td>
                  {canReconcileShift && (
                    <td className="py-3 px-4 text-right">
                      {s.status === 'closed' && (
                        <button
                          onClick={() => handleReconcileShift(s.id)}
                          className="px-2.5 py-1 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded"
                        >
                          Reconcile
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {subTab === 'payments' && (
        <div className="space-y-5">
          <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <div className="px-5 py-3.5 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold text-slate-900">Collectible Invoices &amp; Cashier Desk</h2>
                <p className="text-xs text-slate-500">Collect outstanding self-pay balances and reprint issued receipts.</p>
              </div>
              <div className="relative min-w-[220px]">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  value={invSearch}
                  onChange={(e) => {
                    setInvSearch(e.target.value);
                    setInvPage(1);
                  }}
                  placeholder="Filter by invoice #, MRN, patient..."
                  className="w-full pl-9 pr-3 py-1.5 text-xs border border-slate-300 rounded-md bg-white"
                />
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/70 font-medium text-slate-500">
                    <th className="py-2.5 px-4">Invoice</th>
                    <th className="py-2.5 px-4">Patient</th>
                    <th className="py-2.5 px-4 text-right">Total</th>
                    <th className="py-2.5 px-4 text-right">Balance Due</th>
                    <th className="py-2.5 px-4">Status</th>
                    <th className="py-2.5 px-4 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {invoices
                    .filter((i) => i.status !== 'voided')
                    .map((inv) => {
                      const balance = Math.max(0, Number(inv.total_amount) - Number(inv.paid_amount));
                      return (
                        <tr key={inv.id} className="hover:bg-slate-50/70">
                          <td className="py-3 px-4 font-mono font-semibold text-slate-900">{inv.invoice_number}</td>
                          <td className="py-3 px-4">
                            <div className="font-medium text-slate-900">{inv.first_name} {inv.last_name}</div>
                            <div className="font-mono text-slate-500">{inv.mrn}</div>
                          </td>
                          <td className="py-3 px-4 text-right font-mono tabular-nums">${Number(inv.total_amount).toFixed(2)}</td>
                          <td className="py-3 px-4 text-right font-mono tabular-nums font-semibold text-slate-900">
                            ${balance.toFixed(2)}
                          </td>
                          <td className="py-3 px-4 capitalize font-medium text-slate-700">{inv.status.replace('_', ' ')}</td>
                          <td className="py-3 px-4 text-right space-x-1.5 whitespace-nowrap">
                            {canTakePayment && balance > 0 && (
                              <button
                                onClick={() => {
                                  setPayTarget(inv);
                                  setPayAmount(balance.toFixed(2));
                                }}
                                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded"
                              >
                                <DollarSign className="w-3 h-3" />
                                <span>Collect Payment</span>
                              </button>
                            )}
                            {inv.payments[0]?.receipt_number && canPrintReceipt && (
                              <button
                                onClick={() => openReceipt(inv.payments[0].receipt_number!)}
                                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-700 border border-slate-200 hover:bg-slate-50 rounded"
                              >
                                <Printer className="w-3 h-3" />
                                <span>Receipt</span>
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {subTab === 'reports' && (
        <div className="space-y-5">
          <div className="bg-white border border-slate-200 rounded-lg p-5 flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="font-display text-base font-semibold text-slate-900">
                {payReportOwnOnly ? 'My Payment Collections Report' : 'Daily Cash & Payment Report'}
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                {payReportOwnOnly
                  ? 'Scoped to payments recorded by your cashier account.'
                  : 'Clinic-wide payment collections aggregated by cashier, date, and payment method.'}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <label className="text-slate-600">From</label>
              <input
                type="date"
                value={payReportFrom}
                onChange={(e) => setPayReportFrom(e.target.value)}
                className="px-2.5 py-1.5 border border-slate-300 rounded font-mono"
              />
              <label className="text-slate-600">To</label>
              <input
                type="date"
                value={payReportTo}
                onChange={(e) => setPayReportTo(e.target.value)}
                className="px-2.5 py-1.5 border border-slate-300 rounded font-mono"
              />
              <button
                type="button"
                onClick={() => loadPaymentReport()}
                className="px-3 py-1.5 font-medium text-white bg-teal-700 hover:bg-teal-800 rounded"
              >
                Refresh
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="bg-white border border-slate-200 rounded-lg p-4">
              <div className="text-xs text-slate-500">Total Transactions</div>
              <div className="text-xl font-display font-semibold text-slate-900 mt-1 tabular-nums">
                {payReportRows.reduce((s, r) => s + Number(r.tx_count || 0), 0)}
              </div>
            </div>
            <div className="bg-white border border-slate-200 rounded-lg p-4">
              <div className="text-xs text-slate-500">Net Collected</div>
              <div className="text-xl font-display font-semibold text-teal-800 mt-1 font-mono tabular-nums">
                ${payReportRows.reduce((s, r) => s + Number(r.total_amount || 0), 0).toFixed(2)}
              </div>
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            {payReportLoading ? (
              <div className="p-8 text-center text-sm text-slate-500">Loading payment report...</div>
            ) : payReportRows.length === 0 ? (
              <div className="p-10 text-center text-sm text-slate-500">No completed payments recorded in this date range.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50/70 font-medium text-slate-500">
                      <th className="py-2.5 px-4">Date</th>
                      <th className="py-2.5 px-4">Cashier</th>
                      <th className="py-2.5 px-4">Payment Method</th>
                      <th className="py-2.5 px-4 text-right">Tx Count</th>
                      <th className="py-2.5 px-4 text-right">Net Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {payReportRows.map((row, idx) => (
                      <tr key={idx} className="hover:bg-slate-50/70">
                        <td className="py-3 px-4 font-mono text-slate-700">{row.payment_date}</td>
                        <td className="py-3 px-4 font-medium text-slate-900">{row.cashier_name || 'Cashier'}</td>
                        <td className="py-3 px-4 capitalize text-slate-700">{row.payment_method.replace('_', ' ')}</td>
                        <td className="py-3 px-4 text-right font-mono tabular-nums">{row.tx_count}</td>
                        <td className="py-3 px-4 text-right font-mono tabular-nums font-semibold text-slate-900">
                          ${Number(row.total_amount).toFixed(2)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Collect Payment Modal */}
      {payTarget && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-lg max-w-md w-full">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3 className="font-display text-base font-semibold text-slate-900">
                Collect Payment · {payTarget.invoice_number}
              </h3>
              <button onClick={() => setPayTarget(null)} className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleCollectPayment} className="p-6 space-y-4">
              <div className="text-xs text-slate-600">
                Patient: <strong className="text-slate-900">{payTarget.first_name} {payTarget.last_name}</strong> ({payTarget.mrn})
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Amount ($)</label>
                <input
                  type="number"
                  step="0.01"
                  required
                  value={payAmount}
                  onChange={(e) => setPayAmount(e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-md"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Payment Method</label>
                <select
                  value={payMethod}
                  onChange={(e) => setPayMethod(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md bg-white"
                >
                  <option value="cash">Cash</option>
                  <option value="card">Card / POS</option>
                  <option value="mobile_money">Mobile Money</option>
                  <option value="bank_transfer">Bank Transfer</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Reference Number (Optional)</label>
                <input
                  value={payRef}
                  onChange={(e) => setPayRef(e.target.value)}
                  placeholder="POS auth or transfer ref"
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-md"
                />
              </div>
              <div className="pt-3 border-t border-slate-200 flex justify-end gap-2">
                <button type="button" onClick={() => setPayTarget(null)} className="px-4 py-2 text-xs border border-slate-300 rounded-md">
                  Cancel
                </button>
                <button type="submit" className="px-4 py-2 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md">
                  Record Payment &amp; Issue Receipt
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Create Invoice Modal */}
      {showNewInvoice && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-lg max-w-md w-full">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3 className="font-display text-base font-semibold text-slate-900">Create Service Invoice</h3>
              <button onClick={() => setShowNewInvoice(false)} className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleCreateInvoice} className="p-6 space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Patient</label>
                <select
                  value={newInvPatientId}
                  onChange={(e) => setNewInvPatientId(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md bg-white"
                >
                  {patients.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.mrn} — {p.first_name} {p.last_name} ({p.patient_type})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Billable Service</label>
                <select
                  value={newInvServiceCode}
                  onChange={(e) => setNewInvServiceCode(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md bg-white"
                >
                  {services.map((s) => (
                    <option key={s.id} value={s.code}>
                      {s.name} — ${Number(s.unit_price).toFixed(2)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="pt-3 border-t border-slate-200 flex justify-end gap-2">
                <button type="button" onClick={() => setShowNewInvoice(false)} className="px-4 py-2 text-xs border border-slate-300 rounded-md">
                  Cancel
                </button>
                <button type="submit" className="px-4 py-2 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md">
                  Create Invoice
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Request Approval Modal */}
      {approvalTarget && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-lg max-w-md w-full">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3 className="font-display text-base font-semibold text-slate-900">
                Request Approval · {approvalTarget.invoice_number}
              </h3>
              <button onClick={() => setApprovalTarget(null)} className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleSubmitApproval} className="p-6 space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Request Type</label>
                <select
                  value={approvalType}
                  onChange={(e) => setApprovalType(e.target.value as 'discount' | 'refund' | 'void_invoice')}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md bg-white"
                >
                  <option value="discount">Discount / Courtesy Waiver</option>
                  <option value="refund">Patient Refund Reversal</option>
                  <option value="void_invoice">Void Invoice</option>
                </select>
              </div>
              {(approvalType === 'discount' || approvalType === 'refund') && (
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    {approvalType === 'refund' ? 'Refund Amount ($)' : 'Discount Amount ($)'}
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    required
                    value={approvalAmount}
                    onChange={(e) => setApprovalAmount(e.target.value)}
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-md"
                  />
                </div>
              )}
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Mandatory Reason *</label>
                <textarea
                  rows={2}
                  required
                  value={approvalReason}
                  onChange={(e) => setApprovalReason(e.target.value)}
                  placeholder="Explain waiver or void reason for audit log"
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-md"
                />
              </div>
              <div className="pt-3 border-t border-slate-200 flex justify-end gap-2">
                <button type="button" onClick={() => setApprovalTarget(null)} className="px-4 py-2 text-xs border border-slate-300 rounded-md">
                  Cancel
                </button>
                <button type="submit" className="px-4 py-2 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-md">
                  Submit for Finance/Mgr Approval
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Collect Advance Deposit Modal */}
      {showNewDeposit && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-lg max-w-md w-full">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3 className="font-display text-base font-semibold text-slate-900">Collect Patient Advance Deposit</h3>
              <button onClick={() => setShowNewDeposit(false)} className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleCollectDeposit} className="p-6 space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Patient *</label>
                <select
                  required
                  value={depForm.patient_id}
                  onChange={(e) => setDepForm({ ...depForm, patient_id: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md bg-white"
                >
                  {patients.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.mrn} — {p.first_name} {p.last_name}
                    </option>
                  ))}
                </select>
              </div>
              {admissions.length > 0 && (
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Link to IPD Admission (Optional)</label>
                  <select
                    value={depForm.admission_id}
                    onChange={(e) => setDepForm({ ...depForm, admission_id: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md bg-white"
                  >
                    <option value="">General Patient Wallet</option>
                    {admissions
                      .filter((a) => a.status !== 'discharged')
                      .map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.admission_number} — {a.first_name} {a.last_name}
                        </option>
                      ))}
                  </select>
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Deposit Amount ($) *</label>
                  <input
                    type="number"
                    step="0.01"
                    min="1"
                    required
                    value={depForm.amount}
                    onChange={(e) => setDepForm({ ...depForm, amount: e.target.value })}
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-md"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Method</label>
                  <select
                    value={depForm.payment_method}
                    onChange={(e) => setDepForm({ ...depForm, payment_method: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md bg-white"
                  >
                    <option value="cash">Cash</option>
                    <option value="card">Card / POS</option>
                    <option value="mobile_money">Mobile Money</option>
                    <option value="bank_transfer">Bank Transfer</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Reference Number (Optional)</label>
                <input
                  value={depForm.reference_number}
                  onChange={(e) => setDepForm({ ...depForm, reference_number: e.target.value })}
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-md"
                />
              </div>
              <div className="pt-3 border-t border-slate-200 flex justify-end gap-2">
                <button type="button" onClick={() => setShowNewDeposit(false)} className="px-4 py-2 text-xs border border-slate-300 rounded-md">
                  Cancel
                </button>
                <button type="submit" className="px-4 py-2 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md">
                  Record Deposit
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Apply Deposit to Invoice Modal */}
      {applyDepTarget && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-lg max-w-md w-full">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3 className="font-display text-base font-semibold text-slate-900">
                Apply Deposit · {applyDepTarget.deposit_number}
              </h3>
              <button onClick={() => setApplyDepTarget(null)} className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleApplyDeposit} className="p-6 space-y-4">
              <div className="text-xs text-slate-600">
                Available Credit: <strong className="font-mono text-teal-800">${Number(applyDepTarget.remaining_amount).toFixed(2)}</strong> for{' '}
                <strong className="text-slate-900">{applyDepTarget.first_name} {applyDepTarget.last_name}</strong>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Select Patient Invoice to Offset *</label>
                <select
                  required
                  value={applyInvoiceId}
                  onChange={(e) => setApplyInvoiceId(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md bg-white"
                >
                  <option value="">-- Choose unpaid/partial invoice --</option>
                  {invoices
                    .filter(
                      (inv) =>
                        inv.patient_id === applyDepTarget.patient_id &&
                        (inv.status === 'unpaid' || inv.status === 'partial')
                    )
                    .map((inv) => (
                      <option key={inv.id} value={inv.id}>
                        {inv.invoice_number} — Balance ${(Number(inv.total_amount) - Number(inv.paid_amount)).toFixed(2)}
                      </option>
                    ))}
                </select>
              </div>
              <div className="pt-3 border-t border-slate-200 flex justify-end gap-2">
                <button type="button" onClick={() => setApplyDepTarget(null)} className="px-4 py-2 text-xs border border-slate-300 rounded-md">
                  Cancel
                </button>
                <button type="submit" disabled={!applyInvoiceId} className="px-4 py-2 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md disabled:opacity-40">
                  Apply Deposit Credit
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Printable Immutable Receipt Modal */}
      {receiptPreview &&
        createPortal(
          <div className="print-modal-backdrop fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
            <div className="print-modal-card bg-white border border-slate-200 rounded-lg max-w-md w-full p-6 space-y-4">
              <div className="flex items-start justify-between border-b border-slate-200 pb-3">
                <div>
                  <div className="font-display font-bold text-base text-slate-900">Clinic360 Central Medical</div>
                  <div className="text-xs text-slate-500">
                    Official Payment Receipt
                    {Number(receiptPreview.receipt.reprint_count || 0) > 0 && (
                      <span className="ml-2 font-mono font-semibold text-amber-800">
                        · REPRINT COPY #{receiptPreview.receipt.reprint_count}
                      </span>
                    )}
                  </div>
                </div>
                <button onClick={() => setReceiptPreview(null)} className="no-print text-slate-400 hover:text-slate-700">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="text-xs space-y-1.5 font-mono">
                <div className="flex justify-between">
                  <span className="text-slate-500">Receipt No:</span>
                  <span className="font-semibold text-slate-900">{receiptPreview.receipt.receipt_number}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Invoice No:</span>
                  <span>{receiptPreview.receipt.invoice_number}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Patient:</span>
                  <span>{receiptPreview.receipt.first_name} {receiptPreview.receipt.last_name} ({receiptPreview.receipt.mrn})</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Method:</span>
                  <span className="uppercase">{receiptPreview.receipt.payment_method.replace('_', ' ')}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Issued At:</span>
                  <span>{receiptPreview.receipt.issued_at}</span>
                </div>
              </div>
              <div className="border-t border-b border-slate-200 py-3 space-y-1.5 text-xs">
                {receiptPreview.items.map((it, idx) => (
                  <div key={idx} className="flex justify-between">
                    <span>{it.description} × {it.quantity}</span>
                    <span className="font-mono tabular-nums">${Number(it.line_total).toFixed(2)}</span>
                  </div>
                ))}
              </div>
              <div className="flex justify-between items-center font-mono text-sm font-bold text-slate-900">
                <span>Amount Paid</span>
                <span className="tabular-nums">${Number(receiptPreview.receipt.amount).toFixed(2)}</span>
              </div>
              <div className="text-xs text-slate-500 flex items-center gap-1.5">
                <Lock className="w-3.5 h-3.5" />
                <span>Cashier: {receiptPreview.receipt.cashier_name} · Immutable sequential receipt</span>
              </div>
              <div className="no-print pt-2 flex justify-end gap-2">
                <button
                  onClick={() => handleReprintReceipt(receiptPreview.receipt.receipt_number)}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-700 border border-slate-300 hover:bg-slate-50 rounded-md"
                >
                  <Printer className="w-3.5 h-3.5" />
                  <span>Log Reprint (Copy)</span>
                </button>
                <button
                  onClick={() => window.print()}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md"
                >
                  <Printer className="w-3.5 h-3.5" />
                  <span>Print Original</span>
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}

      {/* Stage 1: Front Desk Check-In & Consultation Billing Modal */}
      {showCheckIn && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <div>
                <h3 className="font-display text-base font-semibold text-slate-900">
                  Front Desk Registration &amp; Consultation Check-In
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Lookup patient or create new EMR, select specialty &amp; doctor, and generate consultation fee invoice.
                </p>
              </div>
              <button onClick={() => setShowCheckIn(false)} className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleFrontDeskCheckIn} className="p-6 space-y-5">
              <div className="flex items-center gap-2 p-1 bg-slate-100 rounded-md w-fit">
                <button
                  type="button"
                  onClick={() => setCheckInMode('existing')}
                  className={`px-3 py-1.5 text-xs font-medium rounded ${
                    checkInMode === 'existing' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
                  }`}
                >
                  Existing Patient Lookup
                </button>
                <button
                  type="button"
                  onClick={() => setCheckInMode('new')}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded ${
                    checkInMode === 'new' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
                  }`}
                >
                  <UserPlus className="w-3.5 h-3.5" />
                  <span>New Patient EMR</span>
                </button>
              </div>

              {checkInMode === 'existing' ? (
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Search Patient (Name, Phone, or MRN)
                    </label>
                    <input
                      value={checkInSearch}
                      onChange={(e) => {
                        const val = e.target.value;
                        setCheckInSearch(val);
                        const match = patients.find((p) => {
                          const q = val.toLowerCase();
                          return (
                            p.mrn.toLowerCase().includes(q) ||
                            `${p.first_name} ${p.last_name}`.toLowerCase().includes(q) ||
                            p.phone.toLowerCase().includes(q)
                          );
                        });
                        if (match) setCheckInPatientId(String(match.id));
                      }}
                      placeholder="Type MRN, phone number, or full name..."
                      className="w-full px-3 py-2 text-xs border border-slate-300 rounded-md"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Selected Patient *</label>
                    <select
                      required
                      value={checkInPatientId}
                      onChange={(e) => setCheckInPatientId(e.target.value)}
                      className="w-full px-3 py-2 text-xs border border-slate-300 rounded-md bg-white"
                    >
                      {patients
                        .filter((p) => {
                          if (!checkInSearch.trim()) return true;
                          const q = checkInSearch.toLowerCase();
                          return (
                            p.mrn.toLowerCase().includes(q) ||
                            `${p.first_name} ${p.last_name}`.toLowerCase().includes(q) ||
                            p.phone.toLowerCase().includes(q)
                          );
                        })
                        .map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.mrn} — {p.first_name} {p.last_name} · {p.phone} ({p.patient_type})
                          </option>
                        ))}
                    </select>
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-3.5 bg-slate-50 border border-slate-200 rounded-md">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">First Name *</label>
                    <input
                      required
                      value={newPatientForm.first_name}
                      onChange={(e) => setNewPatientForm({ ...newPatientForm, first_name: e.target.value })}
                      className="w-full px-3 py-1.5 text-xs border border-slate-300 rounded-md bg-white"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Last Name *</label>
                    <input
                      required
                      value={newPatientForm.last_name}
                      onChange={(e) => setNewPatientForm({ ...newPatientForm, last_name: e.target.value })}
                      className="w-full px-3 py-1.5 text-xs border border-slate-300 rounded-md bg-white"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Sex *</label>
                    <select
                      value={newPatientForm.sex}
                      onChange={(e) => setNewPatientForm({ ...newPatientForm, sex: e.target.value })}
                      className="w-full px-3 py-1.5 text-xs border border-slate-300 rounded-md bg-white"
                    >
                      <option value="Female">Female</option>
                      <option value="Male">Male</option>
                      <option value="Other">Other</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Date of Birth *</label>
                    <input
                      type="date"
                      required
                      value={newPatientForm.date_of_birth}
                      onChange={(e) => setNewPatientForm({ ...newPatientForm, date_of_birth: e.target.value })}
                      className="w-full px-3 py-1.5 text-xs border border-slate-300 rounded-md bg-white font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Phone *</label>
                    <input
                      required
                      value={newPatientForm.phone}
                      onChange={(e) => setNewPatientForm({ ...newPatientForm, phone: e.target.value })}
                      placeholder="+1-555-0199"
                      className="w-full px-3 py-1.5 text-xs border border-slate-300 rounded-md bg-white font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Payer Type</label>
                    <select
                      value={newPatientForm.patient_type}
                      onChange={(e) => setNewPatientForm({ ...newPatientForm, patient_type: e.target.value })}
                      className="w-full px-3 py-1.5 text-xs border border-slate-300 rounded-md bg-white"
                    >
                      <option value="self-pay">Self-Pay (Cash-Before-Service)</option>
                      <option value="insurance">Insurance</option>
                      <option value="credit">Corporate Credit</option>
                      <option value="exempt">Exempt</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Emergency Contact Name</label>
                    <input
                      value={newPatientForm.next_of_kin_name}
                      onChange={(e) => setNewPatientForm({ ...newPatientForm, next_of_kin_name: e.target.value })}
                      className="w-full px-3 py-1.5 text-xs border border-slate-300 rounded-md bg-white"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Emergency Contact Phone</label>
                    <input
                      value={newPatientForm.next_of_kin_phone}
                      onChange={(e) => setNewPatientForm({ ...newPatientForm, next_of_kin_phone: e.target.value })}
                      className="w-full px-3 py-1.5 text-xs border border-slate-300 rounded-md bg-white font-mono"
                    />
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Visit Type</label>
                  <select
                    value={checkInVisitType}
                    onChange={(e) => setCheckInVisitType(e.target.value as 'walk_in' | 'scheduled' | 'follow_up')}
                    className="w-full px-3 py-2 text-xs border border-slate-300 rounded-md bg-white"
                  >
                    <option value="walk_in">Walk-In Consultation</option>
                    <option value="scheduled">Scheduled Appointment</option>
                    <option value="follow_up">OPD Follow-up Review</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Medical Specialty</label>
                  <select
                    value={checkInSpecialty}
                    onChange={(e) => {
                      const nextSpec = e.target.value;
                      setCheckInSpecialty(nextSpec);
                      const matchingDoc = doctors.find((d) => (d.specialty || '').toLowerCase().includes(nextSpec.toLowerCase().split(' ')[0]));
                      if (matchingDoc) setCheckInDoctorId(String(matchingDoc.id));
                    }}
                    className="w-full px-3 py-2 text-xs border border-slate-300 rounded-md bg-white"
                  >
                    <option value="General Medicine">General Medicine ($45.00)</option>
                    <option value="Pediatrics">Pediatrics ($55.00)</option>
                    <option value="Gynecology">Gynecology ($65.00)</option>
                    <option value="Dermatology">Dermatology ($60.00)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Assigned Doctor</label>
                  <select
                    value={checkInDoctorId}
                    onChange={(e) => setCheckInDoctorId(e.target.value)}
                    className="w-full px-3 py-2 text-xs border border-slate-300 rounded-md bg-white"
                  >
                    <option value="">Any Available Doctor</option>
                    {doctors.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.full_name} {d.specialty ? `(${d.specialty})` : ''}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Triage Priority</label>
                  <select
                    value={checkInPriority}
                    onChange={(e) => setCheckInPriority(e.target.value as 'routine' | 'urgent' | 'emergency')}
                    className="w-full px-3 py-2 text-xs border border-slate-300 rounded-md bg-white"
                  >
                    <option value="routine">Routine (Cash-Before-Service)</option>
                    <option value="urgent">Urgent (Cash-Before-Service)</option>
                    <option value="emergency">Emergency (Immediate Triage Override)</option>
                  </select>
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-slate-700 mb-1">Reason for Visit / Chief Complaint</label>
                  <input
                    value={checkInComplaint}
                    onChange={(e) => setCheckInComplaint(e.target.value)}
                    placeholder="e.g. Persistent fever & cough for 3 days"
                    className="w-full px-3 py-2 text-xs border border-slate-300 rounded-md"
                  />
                </div>
              </div>

              <div className="pt-3 border-t border-slate-200 flex justify-end gap-2">
                <button type="button" onClick={() => setShowCheckIn(false)} className="px-4 py-2 text-xs border border-slate-300 rounded-md">
                  Cancel
                </button>
                <button type="submit" className="px-4 py-2 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md">
                  Generate Consultation Bill &amp; Check In
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      {/* Resolve Payment Gate Bypass Modal */}
      {resolveTarget && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-lg max-w-md w-full">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3 className="font-display text-base font-semibold text-slate-900">
                Resolve Bypass · {resolveTarget.entity_type.toUpperCase()} #{resolveTarget.entity_id}
              </h3>
              <button onClick={() => setResolveTarget(null)} className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleResolveBypass} className="p-6 space-y-4">
              <div className="text-xs text-slate-600">
                Patient: <strong className="text-slate-900">{resolveTarget.first_name} {resolveTarget.last_name}</strong> ({resolveTarget.mrn})
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Billing Resolution Note *</label>
                <textarea
                  rows={2}
                  required
                  value={resolveNote}
                  onChange={(e) => setResolveNote(e.target.value)}
                  placeholder="e.g. Settled via Receipt RCP-00012 or billed to corporate insurance"
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-md"
                />
              </div>
              <div className="pt-3 border-t border-slate-200 flex justify-end gap-2">
                <button type="button" onClick={() => setResolveTarget(null)} className="px-4 py-2 text-xs border border-slate-300 rounded-md">
                  Cancel
                </button>
                <button type="submit" className="px-4 py-2 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md">
                  Mark Resolved
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
