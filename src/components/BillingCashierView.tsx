import React, { useCallback, useEffect, useState } from 'react';
import { Check, DollarSign, FileText, Lock, Printer, ShieldAlert, X } from 'lucide-react';
import { apiFetch } from '../lib/api';
import type { ApprovalRequest, CashierShift, Invoice, Patient, UserContext } from '../types';

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

interface BillingCashierViewProps {
  user: UserContext;
  onNotify: (msg: string, type?: 'success' | 'error') => void;
}

export const BillingCashierView: React.FC<BillingCashierViewProps> = ({ user, onNotify }) => {
  const [subTab, setSubTab] = useState<'invoices' | 'approvals' | 'shifts'>('invoices');
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [shifts, setShifts] = useState<CashierShift[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [patients, setPatients] = useState<Patient[]>([]);
  const [services, setServices] = useState<ServiceCatalog[]>([]);

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

  const [approvalTarget, setApprovalTarget] = useState<Invoice | null>(null);
  const [approvalType, setApprovalType] = useState<'discount' | 'refund' | 'void_invoice'>('discount');
  const [approvalAmount, setApprovalAmount] = useState('10.00');
  const [approvalReason, setApprovalReason] = useState('');

  const [receiptPreview, setReceiptPreview] = useState<PrintableReceipt | null>(null);

  const canCreateInvoice = user.permissions.includes('billing.invoice.create');
  const canTakePayment = user.permissions.includes('billing.payment.create');
  const canManageShift = user.permissions.includes('billing.shift.manage');
  const canReconcileShift = user.permissions.includes('billing.shift.reconcile');
  const canRequestApproval = user.permissions.includes('billing.approval.request');
  const canDecideApproval = user.permissions.includes('billing.approval.decide');

  const loadBilling = useCallback(async () => {
    try {
      const [invRes, shfRes, appRes] = await Promise.all([
        apiFetch<{ invoices: Invoice[] }>('/api/billing/invoices'),
        apiFetch<{ shifts: CashierShift[] }>('/api/billing/shifts'),
        apiFetch<{ approvals: ApprovalRequest[] }>('/api/billing/approvals'),
      ]);
      setInvoices(invRes.invoices);
      setShifts(shfRes.shifts);
      setApprovals(appRes.approvals);
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }, [onNotify]);

  useEffect(() => {
    loadBilling();
    if (canCreateInvoice) {
      Promise.all([
        apiFetch<{ patients: Patient[] }>('/api/patients'),
        apiFetch<{ services: ServiceCatalog[] }>('/api/catalog/services'),
      ])
        .then(([pRes, sRes]) => {
          setPatients(pRes.patients);
          setServices(sRes.services);
          if (pRes.patients[0]) setNewInvPatientId(String(pRes.patients[0].id));
          if (sRes.services[0]) setNewInvServiceCode(sRes.services[0].code);
        })
        .catch(() => {});
    }
  }, [loadBilling, canCreateInvoice]);

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
      openReceipt(res.receiptNumber);
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
        <div className="flex items-center gap-1 p-1 bg-slate-200/70 rounded-lg">
          <button
            onClick={() => setSubTab('invoices')}
            className={`px-3.5 py-1.5 text-xs font-medium rounded-md ${
              subTab === 'invoices' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Invoices &amp; Receipts ({invoices.length})
          </button>
          <button
            onClick={() => setSubTab('approvals')}
            className={`px-3.5 py-1.5 text-xs font-medium rounded-md ${
              subTab === 'approvals' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Discounts &amp; Void Approvals ({approvals.filter((a) => a.status === 'pending').length} pending)
          </button>
          <button
            onClick={() => setSubTab('shifts')}
            className={`px-3.5 py-1.5 text-xs font-medium rounded-md ${
              subTab === 'shifts' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Shift Reconciliation ({shifts.length})
          </button>
        </div>

        {canCreateInvoice && (
          <button
            onClick={() => setShowNewInvoice(true)}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md whitespace-nowrap"
          >
            <FileText className="w-3.5 h-3.5" />
            <span>Create Invoice</span>
          </button>
        )}
      </div>

      {subTab === 'invoices' && (
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
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
                        {inv.payments[0]?.receipt_number && (
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
                      <div className="font-mono text-slate-500">{ar.invoice_number}</div>
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

      {/* Printable Immutable Receipt Modal */}
      {receiptPreview && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-lg max-w-md w-full p-6 space-y-4">
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
        </div>
      )}
    </div>
  );
};
