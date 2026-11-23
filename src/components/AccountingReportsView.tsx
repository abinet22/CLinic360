import React, { useCallback, useEffect, useState } from 'react';
import { BookOpen, Check, Download, FileText, Lock, Plus, Printer, RefreshCw, RotateCcw, X } from 'lucide-react';
import { apiFetch } from '../lib/api';
import type {
  AccountingPeriod,
  ChartAccount,
  ExpenseVoucher,
  InsuranceClaim,
  JournalEntry,
  SupplierBill,
  UserContext,
} from '../types';

interface AccountingOverview {
  accounts: ChartAccount[];
  journals: JournalEntry[];
  trialBalance: Array<ChartAccount & { debit_total: number; credit_total: number; net_balance: number }>;
  incomeStatement: {
    revenues: Array<ChartAccount & { net_balance: number }>;
    expenses: Array<ChartAccount & { net_balance: number }>;
    totalRevenue: number;
    totalExpenses: number;
    netIncome: number;
  };
  supplierBills: SupplierBill[];
  expenseVouchers: ExpenseVoucher[];
  insuranceClaims: InsuranceClaim[];
  unclaimedCreditInvoices: Array<{
    id: number;
    invoice_number: string;
    payer_type: string;
    payer_name: string | null;
    total_amount: number;
    mrn: string;
    first_name: string;
    last_name: string;
    created_at: string;
  }>;
  periods?: AccountingPeriod[];
  expenseAutoPostLimit?: number;
}

type SubTab = 'ledger' | 'statements' | 'ar' | 'ap' | 'expenses' | 'reports';
type ReportType = 'daily-cash' | 'opd-diagnoses' | 'lab-turnaround' | 'stock-valuation' | 'ar-ageing';

interface Props {
  user: UserContext;
  onNotify: (msg: string, type?: 'success' | 'error') => void;
}

const REPORT_LABELS: Record<ReportType, string> = {
  'daily-cash': 'Daily Cash Collection by Cashier & Method',
  'opd-diagnoses': 'Outpatient Visits & Top Diagnoses',
  'lab-turnaround': 'Laboratory Turnaround & Verification Status',
  'stock-valuation': 'Inventory Stock Valuation & Expiry',
  'ar-ageing': 'Insurance Accounts Receivable Ageing',
};

export const AccountingReportsView: React.FC<Props> = ({ user, onNotify }) => {
  const [subTab, setSubTab] = useState<SubTab>('ledger');
  const [overview, setOverview] = useState<AccountingOverview | null>(null);
  const [loading, setLoading] = useState(true);

  const canManage = user.permissions.includes('accounting.ledger.manage');
  const canRecordExpense = canManage || user.permissions.includes('accounting.expense.create');
  const canClosePeriod = canManage || user.permissions.includes('accounting.period.manage');
  const canReverseJournal = canManage || user.permissions.includes('accounting.journal.reverse');

  // Manual Journal Modal
  const [jeModalOpen, setJeModalOpen] = useState(false);
  const [jeDesc, setJeDesc] = useState('');
  const [jeDebitAcct, setJeDebitAcct] = useState('5200');
  const [jeCreditAcct, setJeCreditAcct] = useState('1020');
  const [jeAmount, setJeAmount] = useState('');

  // Accounting Period & Journal Reversal state
  const [periodToClose, setPeriodToClose] = useState(() => new Date().toISOString().slice(0, 7));
  const [closingPeriod, setClosingPeriod] = useState(false);
  const [reverseTarget, setReverseTarget] = useState<JournalEntry | null>(null);
  const [reverseReason, setReverseReason] = useState('');
  const [reversingJournal, setReversingJournal] = useState(false);

  // Expense Voucher Form & Modal
  const [expModalOpen, setExpModalOpen] = useState(false);
  const [expDate, setExpDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [expCategory, setExpCategory] = useState('Utilities & Power');
  const [expAcct, setExpAcct] = useState('5200');
  const [expPayee, setExpPayee] = useState('');
  const [expAmount, setExpAmount] = useState('');
  const [expMethod, setExpMethod] = useState<'bank_transfer' | 'cash'>('bank_transfer');
  const [expDesc, setExpDesc] = useState('');
  const [expSubmitting, setExpSubmitting] = useState(false);

  // Reports Library state
  const [reportType, setReportType] = useState<ReportType>('daily-cash');
  const [fromDate, setFromDate] = useState(() => new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10));
  const [toDate, setToDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [reportRows, setReportRows] = useState<Array<Record<string, unknown>>>([]);
  const [reportLoading, setReportLoading] = useState(false);

  const loadOverview = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch<AccountingOverview>('/api/accounting/overview');
      setOverview(data);
    } catch (err) {
      onNotify((err as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }, [onNotify]);

  const loadReport = useCallback(async () => {
    setReportLoading(true);
    try {
      const res = await apiFetch<{ rows: Array<Record<string, unknown>> }>(
        `/api/reports/${reportType}?from=${encodeURIComponent(fromDate)}&to=${encodeURIComponent(toDate)}`
      );
      setReportRows(Array.isArray(res?.rows) ? res.rows : []);
    } catch (err) {
      onNotify((err as Error).message, 'error');
    } finally {
      setReportLoading(false);
    }
  }, [reportType, fromDate, toDate, onNotify]);

  useEffect(() => {
    loadOverview();
  }, [loadOverview]);

  useEffect(() => {
    if (subTab === 'reports') {
      loadReport();
    }
  }, [subTab, loadReport]);

  async function handlePostJournal(e: React.FormEvent) {
    e.preventDefault();
    const amt = Number(jeAmount || 0);
    if (!jeDesc.trim() || amt <= 0) {
      onNotify('Enter a description and positive journal amount.', 'error');
      return;
    }
    try {
      const res = await apiFetch<{ entryNumber: string }>('/api/accounting/journal', {
        method: 'POST',
        body: JSON.stringify({
          description: jeDesc.trim(),
          lines: [
            { accountCode: jeDebitAcct, debit: amt, memo: jeDesc.trim() },
            { accountCode: jeCreditAcct, credit: amt, memo: jeDesc.trim() },
          ],
        }),
      });
      onNotify(`Journal entry ${res.entryNumber} posted.`);
      setJeModalOpen(false);
      setJeDesc('');
      setJeAmount('');
      loadOverview();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handlePaySupplierBill(bill: SupplierBill) {
    const remaining = Number((Number(bill.total_amount) - Number(bill.paid_amount)).toFixed(2));
    try {
      const res = await apiFetch<{ entryNumber: string; paid: number }>(`/api/accounting/ap/${bill.id}/pay`, {
        method: 'POST',
        body: JSON.stringify({ amount: remaining, payment_method: 'bank_transfer' }),
      });
      onNotify(`Paid $${res.paid.toFixed(2)} on ${bill.bill_number} (GL ${res.entryNumber}).`);
      loadOverview();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleSubmitClaim(invoiceId: number) {
    try {
      const res = await apiFetch<{ claimNumber: string }>('/api/accounting/ar-claims', {
        method: 'POST',
        body: JSON.stringify({ invoice_id: invoiceId }),
      });
      onNotify(`Insurance claim ${res.claimNumber} submitted and posted to AR.`);
      loadOverview();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleSettleClaim(claim: InsuranceClaim) {
    const remaining = Number((Number(claim.billed_amount) - Number(claim.settled_amount)).toFixed(2));
    try {
      const res = await apiFetch<{ entryNumber: string; settled: number }>(`/api/accounting/ar-claims/${claim.id}/settle`, {
        method: 'POST',
        body: JSON.stringify({ amount: remaining }),
      });
      onNotify(`Claim ${claim.claim_number} settled ($${res.settled.toFixed(2)}, GL ${res.entryNumber}).`);
      loadOverview();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleCreateExpense(e: React.FormEvent) {
    e.preventDefault();
    const amt = Number(expAmount || 0);
    if (!expCategory.trim() || !expPayee.trim() || amt <= 0 || !expDesc.trim()) {
      onNotify('Enter category, payee, positive amount, and expense description.', 'error');
      return;
    }
    setExpSubmitting(true);
    try {
      const res = await apiFetch<{ voucherNumber: string; status: string; entryNumber?: string | null }>(
        '/api/accounting/expenses',
        {
          method: 'POST',
          body: JSON.stringify({
            expense_date: expDate,
            category: expCategory.trim(),
            account_code: expAcct,
            payee_name: expPayee.trim(),
            amount: amt,
            payment_method: expMethod,
            description: expDesc.trim(),
            auto_post: true,
          }),
        }
      );
      onNotify(
        res.status === 'pending'
          ? `Expense voucher ${res.voucherNumber} submitted for Manager approval (exceeds auto-post limit).`
          : res.entryNumber
            ? `Expense voucher ${res.voucherNumber} recorded & posted to GL (${res.entryNumber}).`
            : `Expense voucher ${res.voucherNumber} created.`
      );
      setExpModalOpen(false);
      setExpPayee('');
      setExpAmount('');
      setExpDesc('');
      loadOverview();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    } finally {
      setExpSubmitting(false);
    }
  }

  async function handleClosePeriod(e: React.FormEvent) {
    e.preventDefault();
    if (!/^\d{4}-\d{2}$/.test(periodToClose.trim())) {
      onNotify('Enter accounting period in YYYY-MM format.', 'error');
      return;
    }
    setClosingPeriod(true);
    try {
      await apiFetch('/api/accounting/periods/close', {
        method: 'POST',
        body: JSON.stringify({ period_code: periodToClose.trim() }),
      });
      onNotify(`Accounting period ${periodToClose.trim()} closed and locked.`);
      loadOverview();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    } finally {
      setClosingPeriod(false);
    }
  }

  async function handleReverseJournal(e: React.FormEvent) {
    e.preventDefault();
    if (!reverseTarget) return;
    if (reverseReason.trim().length < 5) {
      onNotify('Reversal requires a formal audit reason (min 5 characters).', 'error');
      return;
    }
    setReversingJournal(true);
    try {
      const res = await apiFetch<{ entryNumber: string }>(`/api/accounting/journals/${reverseTarget.id}/reverse`, {
        method: 'POST',
        body: JSON.stringify({ reason: reverseReason.trim() }),
      });
      onNotify(`Posted reversal entry ${res.entryNumber} for ${reverseTarget.entry_number}.`);
      setReverseTarget(null);
      setReverseReason('');
      loadOverview();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    } finally {
      setReversingJournal(false);
    }
  }

  async function handleDecideExpense(id: number, decision: 'paid' | 'rejected') {
    try {
      const res = await apiFetch<{ entryNumber?: string | null }>(`/api/accounting/expenses/${id}/decide`, {
        method: 'POST',
        body: JSON.stringify({ decision }),
      });
      onNotify(
        decision === 'paid'
          ? `Expense approved and posted to GL (${res.entryNumber}).`
          : 'Expense voucher rejected.'
      );
      loadOverview();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  function exportReportCsv() {
    if (reportRows.length === 0) {
      onNotify('No report rows available to export.', 'error');
      return;
    }
    const headers = Object.keys(reportRows[0]);
    const escapeCell = (val: unknown) => {
      const str = val === null || val === undefined ? '' : String(val);
      return str.includes(',') || str.includes('"') || str.includes('\n') ? `"${str.replace(/"/g, '""')}"` : str;
    };
    const csv = [headers.join(','), ...reportRows.map((r) => headers.map((h) => escapeCell(r[h])).join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `clinic360-${reportType}-${fromDate}-to-${toDate}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    onNotify(`Exported ${reportRows.length} rows to CSV.`);
  }

  const totalTbDebit = overview?.trialBalance.reduce((s, r) => s + r.debit_total, 0) || 0;
  const totalTbCredit = overview?.trialBalance.reduce((s, r) => s + r.credit_total, 0) || 0;
  const expenseAccounts = overview?.accounts.filter((a) => a.account_type === 'expense') || [];
  const selectedExpenseAccount = expenseAccounts.find((a) => a.code === expAcct);
  const expPreviewAmt = Number(expAmount || 0) > 0 ? Number(expAmount).toFixed(2) : '0.00';

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-xl font-semibold text-slate-900">Finance Ledger &amp; Operational Reports</h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Double-entry Chart of Accounts, automated GRN/Cashier/Expense/Payroll postings, AR/AP, and exportable reports.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={loadOverview}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-md whitespace-nowrap"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Refresh Ledger</span>
          </button>
          {canRecordExpense && (
            <button
              onClick={() => {
                setSubTab('expenses');
                setExpModalOpen(true);
              }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-md whitespace-nowrap"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Expense Voucher</span>
            </button>
          )}
          {canManage && (
            <button
              onClick={() => setJeModalOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md whitespace-nowrap"
            >
              <BookOpen className="w-3.5 h-3.5" />
              <span>Manual Journal</span>
            </button>
          )}
        </div>
      </div>

      {/* Sub-navigation */}
      <div className="flex flex-wrap gap-1 border-b border-slate-200">
        {(
          [
            ['ledger', 'General Ledger'],
            ['statements', 'Trial Balance & P&L'],
            ['ar', 'Insurance AR & Ageing'],
            ['ap', 'Supplier AP (GRNs)'],
            ['expenses', 'Expense Vouchers'],
            ['reports', 'Reports Library (CSV/PDF)'],
          ] as Array<[SubTab, string]>
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setSubTab(key)}
            className={`px-4 py-2 text-xs font-medium border-b-2 transition-colors whitespace-nowrap ${
              subTab === key
                ? 'border-teal-700 text-teal-800 bg-white'
                : 'border-transparent text-slate-500 hover:text-slate-900'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {loading && !overview ? (
        <div className="bg-white border border-slate-200 rounded-lg p-10 text-center text-sm text-slate-500">
          Loading accounting ledger...
        </div>
      ) : null}

      {/* GENERAL LEDGER */}
      {subTab === 'ledger' && overview && (
        <div className="space-y-4">
          <div className="bg-white border border-slate-200 rounded-lg p-4 flex flex-wrap items-center justify-between gap-4">
            <div className="space-y-1">
              <div className="text-xs font-semibold text-slate-900 flex items-center gap-1.5">
                <Lock className="w-3.5 h-3.5 text-teal-700" />
                <span>Accounting Periods</span>
              </div>
              <div className="flex flex-wrap gap-1.5 text-[11px] font-mono">
                {(overview.periods || []).length === 0 ? (
                  <span className="text-slate-500">All current periods open</span>
                ) : (
                  (overview.periods || []).map((p) => (
                    <span
                      key={p.id}
                      className={`px-2 py-0.5 rounded border ${
                        p.status === 'closed'
                          ? 'bg-slate-100 border-slate-300 text-slate-700'
                          : 'bg-emerald-50 border-emerald-200 text-emerald-700'
                      }`}
                    >
                      {p.period_code}: {p.status.toUpperCase()}
                    </span>
                  ))
                )}
              </div>
            </div>
            {canClosePeriod && (
              <form onSubmit={handleClosePeriod} className="flex items-center gap-2 text-xs">
                <input
                  type="month"
                  value={periodToClose}
                  onChange={(e) => setPeriodToClose(e.target.value)}
                  className="px-2.5 py-1.5 border border-slate-300 rounded-md font-mono"
                />
                <button
                  type="submit"
                  disabled={closingPeriod}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-md disabled:opacity-60"
                >
                  <Lock className="w-3.5 h-3.5" />
                  <span>{closingPeriod ? 'Closing...' : 'Close Period'}</span>
                </button>
              </form>
            )}
          </div>

          <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
              <h2 className="font-display text-sm font-semibold text-slate-900">Posted Journal Entries</h2>
              <span className="text-xs font-mono text-slate-500">{overview.journals.length} entries</span>
            </div>
            <div className="divide-y divide-slate-200">
              {overview.journals.map((je) => {
                const isAlreadyReversed = overview.journals.some((other) => other.reversal_of_id === je.id);
                const canReverseThis = canReverseJournal && !je.reversal_of_id && !isAlreadyReversed;
                return (
                  <div key={je.id} className="p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="font-mono font-semibold text-teal-800">{je.entry_number}</span>
                        <span className="font-mono text-slate-500">{je.entry_date}</span>
                        <span className="text-slate-400">·</span>
                        <span className="uppercase font-mono text-[11px] text-slate-600">{je.source_type}</span>
                        <span className="font-medium text-slate-900">{je.description}</span>
                        {je.reversal_of_id && (
                          <span className="px-1.5 py-0.5 rounded bg-amber-50 border border-amber-200 text-[11px] font-mono text-amber-800">
                            Reversal
                          </span>
                        )}
                        {isAlreadyReversed && (
                          <span className="px-1.5 py-0.5 rounded bg-slate-100 border border-slate-200 text-[11px] font-mono text-slate-600">
                            Reversed
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 text-xs font-mono tabular-nums text-slate-600">
                        <span>
                          Dr ${Number(je.total_debit).toFixed(2)} / Cr ${Number(je.total_credit).toFixed(2)} · {je.posted_by_name}
                        </span>
                        {canReverseThis && (
                          <button
                            onClick={() => {
                              setReverseTarget(je);
                              setReverseReason('');
                            }}
                            className="inline-flex items-center gap-1 px-2 py-1 font-sans text-[11px] font-medium text-slate-700 border border-slate-200 hover:bg-slate-50 rounded"
                          >
                            <RotateCcw className="w-3 h-3" />
                            <span>Reverse</span>
                          </button>
                        )}
                      </div>
                    </div>
                    <table className="w-full text-xs border border-slate-100 rounded">
                      <thead>
                        <tr className="bg-slate-50 text-slate-500 border-b border-slate-100">
                          <th className="py-1.5 px-3 text-left">Account</th>
                          <th className="py-1.5 px-3 text-left">Memo</th>
                          <th className="py-1.5 px-3 text-right">Debit</th>
                          <th className="py-1.5 px-3 text-right">Credit</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {je.lines.map((ln, idx) => (
                          <tr key={idx}>
                            <td className="py-1.5 px-3 font-mono text-slate-800">
                              {ln.code} — {ln.name}
                            </td>
                            <td className="py-1.5 px-3 text-slate-500">{ln.memo || '—'}</td>
                            <td className="py-1.5 px-3 text-right font-mono tabular-nums text-slate-900">
                              {Number(ln.debit) > 0 ? `$${Number(ln.debit).toFixed(2)}` : '—'}
                            </td>
                            <td className="py-1.5 px-3 text-right font-mono tabular-nums text-slate-900">
                              {Number(ln.credit) > 0 ? `$${Number(ln.credit).toFixed(2)}` : '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* TRIAL BALANCE & INCOME STATEMENT */}
      {subTab === 'statements' && overview && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-7 bg-white border border-slate-200 rounded-lg overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
              <h2 className="font-display text-sm font-semibold text-slate-900">Trial Balance (Chart of Accounts)</h2>
              <span className="text-xs font-mono text-emerald-700">
                {Math.abs(totalTbDebit - totalTbCredit) < 0.02 ? 'Balanced' : 'Check Variance'}
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-slate-500">
                    <th className="py-2.5 px-4">Code</th>
                    <th className="py-2.5 px-4">Account Name</th>
                    <th className="py-2.5 px-4">Type</th>
                    <th className="py-2.5 px-4 text-right">Debit</th>
                    <th className="py-2.5 px-4 text-right">Credit</th>
                    <th className="py-2.5 px-4 text-right">Net Balance</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {overview.trialBalance.map((row) => (
                    <tr key={row.id}>
                      <td className="py-2 px-4 font-mono font-semibold text-slate-800">{row.code}</td>
                      <td className="py-2 px-4 text-slate-900">{row.name}</td>
                      <td className="py-2 px-4 uppercase font-mono text-slate-500">{row.account_type}</td>
                      <td className="py-2 px-4 text-right font-mono tabular-nums">${row.debit_total.toFixed(2)}</td>
                      <td className="py-2 px-4 text-right font-mono tabular-nums">${row.credit_total.toFixed(2)}</td>
                      <td className="py-2 px-4 text-right font-mono font-semibold tabular-nums">
                        ${row.net_balance.toFixed(2)}
                      </td>
                    </tr>
                  ))}
                  <tr className="bg-slate-50 font-semibold border-t border-slate-200">
                    <td colSpan={3} className="py-2.5 px-4 text-slate-900">
                      Totals
                    </td>
                    <td className="py-2.5 px-4 text-right font-mono tabular-nums">${totalTbDebit.toFixed(2)}</td>
                    <td className="py-2.5 px-4 text-right font-mono tabular-nums">${totalTbCredit.toFixed(2)}</td>
                    <td className="py-2.5 px-4 text-right font-mono tabular-nums text-emerald-700">$0.00 diff</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div className="lg:col-span-5 bg-white border border-slate-200 rounded-lg overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200">
              <h2 className="font-display text-sm font-semibold text-slate-900">Income Statement (P&amp;L)</h2>
            </div>
            <div className="p-5 space-y-5 text-xs">
              <div>
                <div className="font-semibold text-slate-700 uppercase tracking-wide mb-2">Operating Revenue</div>
                <div className="space-y-1.5">
                  {overview.incomeStatement.revenues.map((r) => (
                    <div key={r.id} className="flex justify-between py-1 border-b border-slate-100">
                      <span className="text-slate-700">
                        <span className="font-mono text-slate-500 mr-2">{r.code}</span>
                        {r.name}
                      </span>
                      <span className="font-mono tabular-nums font-medium">${r.net_balance.toFixed(2)}</span>
                    </div>
                  ))}
                  <div className="flex justify-between pt-1.5 font-semibold text-slate-900">
                    <span>Total Revenue</span>
                    <span className="font-mono tabular-nums">${overview.incomeStatement.totalRevenue.toFixed(2)}</span>
                  </div>
                </div>
              </div>

              <div>
                <div className="font-semibold text-slate-700 uppercase tracking-wide mb-2">Operating Expenses</div>
                <div className="space-y-1.5">
                  {overview.incomeStatement.expenses.map((ex) => (
                    <div key={ex.id} className="flex justify-between py-1 border-b border-slate-100">
                      <span className="text-slate-700">
                        <span className="font-mono text-slate-500 mr-2">{ex.code}</span>
                        {ex.name}
                      </span>
                      <span className="font-mono tabular-nums font-medium">${ex.net_balance.toFixed(2)}</span>
                    </div>
                  ))}
                  <div className="flex justify-between pt-1.5 font-semibold text-slate-900">
                    <span>Total Expenses</span>
                    <span className="font-mono tabular-nums">${overview.incomeStatement.totalExpenses.toFixed(2)}</span>
                  </div>
                </div>
              </div>

              <div className="pt-3 border-t border-slate-200 flex justify-between items-baseline">
                <span className="font-display text-sm font-semibold text-slate-900">Net Operating Surplus</span>
                <span
                  className={`font-mono text-lg font-semibold tabular-nums ${
                    overview.incomeStatement.netIncome >= 0 ? 'text-emerald-700' : 'text-red-700'
                  }`}
                >
                  ${overview.incomeStatement.netIncome.toFixed(2)}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* INSURANCE AR & AGEING */}
      {subTab === 'ar' && overview && (
        <div className="space-y-6">
          {overview.unclaimedCreditInvoices.length > 0 && (
            <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
              <div className="px-5 py-3.5 border-b border-slate-200">
                <h2 className="font-display text-sm font-semibold text-slate-900">
                  Unbatched Credit / Insurance Invoices Ready for Claim Submission
                </h2>
              </div>
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-slate-500">
                    <th className="py-2.5 px-4">Invoice</th>
                    <th className="py-2.5 px-4">Patient</th>
                    <th className="py-2.5 px-4">Payer</th>
                    <th className="py-2.5 px-4 text-right">Amount</th>
                    <th className="py-2.5 px-4 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {overview.unclaimedCreditInvoices.map((inv) => (
                    <tr key={inv.id}>
                      <td className="py-2.5 px-4 font-mono font-medium">{inv.invoice_number}</td>
                      <td className="py-2.5 px-4">
                        {inv.first_name} {inv.last_name} ({inv.mrn})
                      </td>
                      <td className="py-2.5 px-4">{inv.payer_name || inv.payer_type}</td>
                      <td className="py-2.5 px-4 text-right font-mono tabular-nums">${Number(inv.total_amount).toFixed(2)}</td>
                      <td className="py-2.5 px-4 text-right">
                        {canManage && (
                          <button
                            onClick={() => handleSubmitClaim(inv.id)}
                            className="px-2.5 py-1 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded whitespace-nowrap"
                          >
                            Submit Claim &amp; Post AR
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200">
              <h2 className="font-display text-sm font-semibold text-slate-900">Submitted Insurance Claims &amp; Ageing</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-slate-500">
                    <th className="py-2.5 px-4">Claim #</th>
                    <th className="py-2.5 px-4">Payer</th>
                    <th className="py-2.5 px-4">Patient / Invoice</th>
                    <th className="py-2.5 px-4">Age</th>
                    <th className="py-2.5 px-4 text-right">Billed</th>
                    <th className="py-2.5 px-4 text-right">Settled</th>
                    <th className="py-2.5 px-4">Status</th>
                    <th className="py-2.5 px-4 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {overview.insuranceClaims.map((clm) => (
                    <tr key={clm.id}>
                      <td className="py-2.5 px-4 font-mono font-semibold">{clm.claim_number}</td>
                      <td className="py-2.5 px-4 text-slate-900">{clm.payer_name}</td>
                      <td className="py-2.5 px-4">
                        {clm.first_name} {clm.last_name} · <span className="font-mono text-slate-500">{clm.invoice_number}</span>
                      </td>
                      <td className="py-2.5 px-4 font-mono">
                        {clm.age_days ?? 0}d ({clm.age_bucket})
                      </td>
                      <td className="py-2.5 px-4 text-right font-mono tabular-nums">${Number(clm.billed_amount).toFixed(2)}</td>
                      <td className="py-2.5 px-4 text-right font-mono tabular-nums">${Number(clm.settled_amount).toFixed(2)}</td>
                      <td className="py-2.5 px-4 capitalize font-medium text-slate-700">{clm.status}</td>
                      <td className="py-2.5 px-4 text-right">
                        {canManage && clm.status !== 'settled' && (
                          <button
                            onClick={() => handleSettleClaim(clm)}
                            className="px-2.5 py-1 text-xs font-medium text-teal-800 border border-teal-200 bg-teal-50 hover:bg-teal-100 rounded whitespace-nowrap"
                          >
                            Record Settlement
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* SUPPLIER AP */}
      {subTab === 'ap' && overview && (
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-200">
            <h2 className="font-display text-sm font-semibold text-slate-900">Supplier Accounts Payable (Linked to Store GRNs)</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-slate-500">
                  <th className="py-2.5 px-4">Bill #</th>
                  <th className="py-2.5 px-4">Supplier</th>
                  <th className="py-2.5 px-4">GRN / Invoice Ref</th>
                  <th className="py-2.5 px-4">Due Date</th>
                  <th className="py-2.5 px-4 text-right">Total</th>
                  <th className="py-2.5 px-4 text-right">Paid</th>
                  <th className="py-2.5 px-4">Status</th>
                  <th className="py-2.5 px-4 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {overview.supplierBills.map((b) => (
                  <tr key={b.id}>
                    <td className="py-2.5 px-4 font-mono font-semibold">{b.bill_number}</td>
                    <td className="py-2.5 px-4 text-slate-900">{b.supplier_name}</td>
                    <td className="py-2.5 px-4 font-mono text-slate-600">
                      {b.grn_number || 'Direct'} {b.invoice_ref ? `· ${b.invoice_ref}` : ''}
                    </td>
                    <td className="py-2.5 px-4 font-mono">{b.due_date}</td>
                    <td className="py-2.5 px-4 text-right font-mono tabular-nums">${Number(b.total_amount).toFixed(2)}</td>
                    <td className="py-2.5 px-4 text-right font-mono tabular-nums">${Number(b.paid_amount).toFixed(2)}</td>
                    <td className="py-2.5 px-4 capitalize font-medium text-slate-700">{b.status}</td>
                    <td className="py-2.5 px-4 text-right">
                      {canManage && b.status !== 'paid' && (
                        <button
                          onClick={() => handlePaySupplierBill(b)}
                          className="px-2.5 py-1 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded whitespace-nowrap"
                        >
                          Pay Balance
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* EXPENSE VOUCHERS */}
      {subTab === 'expenses' && overview && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="bg-white border border-slate-200 rounded-lg p-4">
              <div className="text-xs text-slate-500">Posted Operational Expenses</div>
              <div className="font-mono text-xl font-semibold text-slate-900 mt-1 tabular-nums">
                $
                {overview.expenseVouchers
                  .filter((e) => e.status === 'paid')
                  .reduce((s, e) => s + Number(e.amount || 0), 0)
                  .toFixed(2)}
              </div>
            </div>
            <div className="bg-white border border-slate-200 rounded-lg p-4">
              <div className="text-xs text-slate-500">Pending Approval</div>
              <div className="font-mono text-xl font-semibold text-amber-700 mt-1 tabular-nums">
                {overview.expenseVouchers.filter((e) => e.status === 'pending').length} voucher(s)
              </div>
            </div>
            <div className="bg-white border border-slate-200 rounded-lg p-4">
              <div className="text-xs text-slate-500">Total Vouchers Recorded</div>
              <div className="font-mono text-xl font-semibold text-teal-800 mt-1 tabular-nums">
                {overview.expenseVouchers.length}
              </div>
            </div>
          </div>

          {canRecordExpense && (
            <div className="bg-white border border-slate-200 rounded-lg p-5">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-4 pb-3 border-b border-slate-100">
                <div>
                  <h2 className="font-display text-sm font-semibold text-slate-900">Record Expense Voucher</h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Operational expenses are automatically posted as balanced double-entry journals to the General Ledger.
                  </p>
                </div>
                <span className="text-[11px] font-mono px-2.5 py-1 rounded bg-teal-50 text-teal-800 border border-teal-200">
                  {overview.expenseAutoPostLimit !== undefined
                    ? `Auto-Post Limit: $${Number(overview.expenseAutoPostLimit).toFixed(2)}`
                    : 'Auto-Post to GL Enabled'}
                </span>
              </div>

              <form onSubmit={handleCreateExpense} className="space-y-4 text-xs">
                <div className="grid grid-cols-1 md:grid-cols-4 gap-3.5">
                  <div>
                    <label className="block font-medium text-slate-700 mb-1">Expense Date *</label>
                    <input
                      type="date"
                      required
                      value={expDate}
                      onChange={(e) => setExpDate(e.target.value)}
                      className="w-full px-3 py-2 border border-slate-300 rounded-md font-mono"
                    />
                  </div>
                  <div>
                    <label className="block font-medium text-slate-700 mb-1">Category *</label>
                    <input
                      required
                      list="expense-categories"
                      value={expCategory}
                      onChange={(e) => setExpCategory(e.target.value)}
                      placeholder="e.g. Utilities & Power"
                      className="w-full px-3 py-2 border border-slate-300 rounded-md"
                    />
                    <datalist id="expense-categories">
                      <option value="Utilities & Power" />
                      <option value="Medical Supplies & Consumables" />
                      <option value="Equipment Maintenance & Repairs" />
                      <option value="Cleaning & Sanitation" />
                      <option value="Office & IT Services" />
                      <option value="Staff Welfare & Training" />
                      <option value="Courier & Logistics" />
                    </datalist>
                  </div>
                  <div className="md:col-span-2">
                    <label className="block font-medium text-slate-700 mb-1">GL Expense Account *</label>
                    <select
                      value={expAcct}
                      onChange={(e) => setExpAcct(e.target.value)}
                      className="w-full px-2.5 py-2 border border-slate-300 rounded-md bg-white"
                    >
                      {expenseAccounts.map((a) => (
                        <option key={a.code} value={a.code}>
                          {a.code} · {a.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-4 gap-3.5">
                  <div className="md:col-span-2">
                    <label className="block font-medium text-slate-700 mb-1">Payee / Vendor *</label>
                    <input
                      required
                      value={expPayee}
                      onChange={(e) => setExpPayee(e.target.value)}
                      placeholder="e.g. City Power Utility, BioMed Repairs Ltd"
                      className="w-full px-3 py-2 border border-slate-300 rounded-md"
                    />
                  </div>
                  <div>
                    <label className="block font-medium text-slate-700 mb-1">Amount ($) *</label>
                    <input
                      type="number"
                      step="0.01"
                      min="0.01"
                      required
                      value={expAmount}
                      onChange={(e) => setExpAmount(e.target.value)}
                      placeholder="0.00"
                      className="w-full px-3 py-2 border border-slate-300 rounded-md font-mono"
                    />
                  </div>
                  <div>
                    <label className="block font-medium text-slate-700 mb-1">Payment Source *</label>
                    <select
                      value={expMethod}
                      onChange={(e) => setExpMethod(e.target.value as 'bank_transfer' | 'cash')}
                      className="w-full px-2.5 py-2 border border-slate-300 rounded-md bg-white"
                    >
                      <option value="bank_transfer">Bank Transfer (1020)</option>
                      <option value="cash">Petty Cash / Till (1010)</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block font-medium text-slate-700 mb-1">Expense Description / Purpose *</label>
                  <input
                    required
                    value={expDesc}
                    onChange={(e) => setExpDesc(e.target.value)}
                    placeholder="Itemized reason, invoice/receipt reference, or department cost center"
                    className="w-full px-3 py-2 border border-slate-300 rounded-md"
                  />
                </div>

                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-2 border-t border-slate-100">
                  <div className="text-[11px] font-mono text-slate-600 bg-slate-50 border border-slate-200 rounded px-3 py-1.5">
                    GL Auto-Entry: <span className="font-semibold text-slate-900">Dr {expAcct}</span> (
                    {selectedExpenseAccount?.name || 'Expense'}) ${expPreviewAmt} /{' '}
                    <span className="font-semibold text-slate-900">
                      Cr {expMethod === 'cash' ? '1010' : '1020'}
                    </span>{' '}
                    ({expMethod === 'cash' ? 'Cash on Hand' : 'Operating Bank'}) ${expPreviewAmt}
                  </div>
                  <button
                    type="submit"
                    disabled={expSubmitting}
                    className="inline-flex items-center justify-center gap-1.5 px-4 py-2 bg-teal-700 hover:bg-teal-800 disabled:opacity-60 text-white rounded-md font-medium whitespace-nowrap"
                  >
                    <Check className="w-3.5 h-3.5" />
                    <span>{expSubmitting ? 'Posting to GL...' : 'Record & Post to GL'}</span>
                  </button>
                </div>
              </form>
            </div>
          )}

          <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
              <h2 className="font-display text-sm font-semibold text-slate-900">Clinic Expense Vouchers</h2>
              <span className="text-xs font-mono text-slate-500">{overview.expenseVouchers.length} vouchers</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-slate-500">
                    <th className="py-2.5 px-4">Voucher #</th>
                    <th className="py-2.5 px-4">Date</th>
                    <th className="py-2.5 px-4">Payee &amp; Description</th>
                    <th className="py-2.5 px-4">GL Account</th>
                    <th className="py-2.5 px-4">Payment &amp; GL Entry</th>
                    <th className="py-2.5 px-4 text-right">Amount</th>
                    <th className="py-2.5 px-4">Status</th>
                    <th className="py-2.5 px-4 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {overview.expenseVouchers.map((ev) => (
                    <tr key={ev.id}>
                      <td className="py-2.5 px-4 font-mono font-semibold text-slate-900">{ev.voucher_number}</td>
                      <td className="py-2.5 px-4 font-mono text-slate-600">{ev.expense_date}</td>
                      <td className="py-2.5 px-4">
                        <div className="font-medium text-slate-900">
                          {ev.payee_name} <span className="text-slate-400 font-normal">· {ev.category}</span>
                        </div>
                        <div className="text-slate-500">{ev.description}</div>
                      </td>
                      <td className="py-2.5 px-4 font-mono text-slate-600">
                        {ev.account_code} · {ev.account_name}
                      </td>
                      <td className="py-2.5 px-4 font-mono text-slate-600">
                        <div>{ev.payment_method === 'cash' ? 'Petty Cash (1010)' : 'Bank Transfer (1020)'}</div>
                        {ev.journal_entry_number && (
                          <div className="text-teal-700 font-semibold">{ev.journal_entry_number}</div>
                        )}
                      </td>
                      <td className="py-2.5 px-4 text-right font-mono tabular-nums font-semibold text-slate-900">
                        ${Number(ev.amount).toFixed(2)}
                      </td>
                      <td className="py-2.5 px-4">
                        <span
                          className={`inline-block px-2 py-0.5 rounded text-[11px] font-medium capitalize ${
                            ev.status === 'paid'
                              ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                              : ev.status === 'rejected'
                                ? 'bg-red-50 text-red-700 border border-red-200'
                                : 'bg-amber-50 text-amber-800 border border-amber-200'
                          }`}
                        >
                          {ev.status === 'paid' ? 'Posted & Paid' : ev.status}
                        </span>
                      </td>
                      <td className="py-2.5 px-4 text-right">
                        {canManage && ev.status === 'pending' && (
                          <div className="inline-flex items-center gap-1.5">
                            <button
                              onClick={() => handleDecideExpense(ev.id, 'paid')}
                              className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-white bg-emerald-700 hover:bg-emerald-800 rounded whitespace-nowrap"
                            >
                              <Check className="w-3 h-3" />
                              <span>Approve &amp; Post</span>
                            </button>
                            <button
                              onClick={() => handleDecideExpense(ev.id, 'rejected')}
                              className="px-2 py-1 text-xs font-medium text-red-700 border border-red-200 hover:bg-red-50 rounded"
                            >
                              Reject
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* FILTERABLE REPORTS LIBRARY */}
      {subTab === 'reports' && (
        <div className="space-y-4">
          <div className="bg-white border border-slate-200 rounded-lg p-4 flex flex-wrap items-end justify-between gap-4 no-print">
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Report Template</label>
                <select
                  value={reportType}
                  onChange={(e) => setReportType(e.target.value as ReportType)}
                  className="px-3 py-1.5 text-xs border border-slate-300 rounded-md bg-white"
                >
                  {(Object.keys(REPORT_LABELS) as ReportType[]).map((key) => (
                    <option key={key} value={key}>
                      {REPORT_LABELS[key]}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">From</label>
                <input
                  type="date"
                  value={fromDate}
                  onChange={(e) => setFromDate(e.target.value)}
                  className="px-2.5 py-1.5 text-xs border border-slate-300 rounded-md font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">To</label>
                <input
                  type="date"
                  value={toDate}
                  onChange={(e) => setToDate(e.target.value)}
                  className="px-2.5 py-1.5 text-xs border border-slate-300 rounded-md font-mono"
                />
              </div>
              <button
                onClick={loadReport}
                className="px-3 py-1.5 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md whitespace-nowrap"
              >
                Run Report
              </button>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={exportReportCsv}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-200 hover:bg-slate-50 rounded-md whitespace-nowrap"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Export CSV</span>
              </button>
              <button
                onClick={() => window.print()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-200 hover:bg-slate-50 rounded-md whitespace-nowrap"
              >
                <Printer className="w-3.5 h-3.5" />
                <span>Print / PDF</span>
              </button>
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FileText className="w-4 h-4 text-teal-700" />
                <h2 className="font-display text-sm font-semibold text-slate-900">{REPORT_LABELS[reportType]}</h2>
              </div>
              <span className="text-xs font-mono text-slate-500">
                {fromDate} to {toDate} · {reportRows.length} rows
              </span>
            </div>
            {reportLoading ? (
              <div className="p-8 text-center text-xs text-slate-500">Generating report...</div>
            ) : reportRows.length === 0 ? (
              <div className="p-8 text-center text-xs text-slate-500">No records match the selected date window.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-slate-500">
                      {Object.keys(reportRows[0]).map((col) => (
                        <th key={col} className="py-2.5 px-4 uppercase tracking-wider font-medium">
                          {col.replace(/_/g, ' ')}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {reportRows.map((row, idx) => (
                      <tr key={idx}>
                        {Object.entries(row).map(([k, val]) => (
                          <td key={k} className="py-2 px-4 font-mono text-slate-800 whitespace-nowrap">
                            {val === null || val === undefined ? '—' : String(val)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* MANUAL JOURNAL MODAL */}
      {jeModalOpen && overview && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-lg w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-display text-base font-semibold text-slate-900">Post Balanced Journal Entry</h3>
              <button onClick={() => setJeModalOpen(false)} className="text-slate-400 hover:text-slate-600">
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handlePostJournal} className="space-y-3.5 text-xs">
              <div>
                <label className="block font-medium text-slate-700 mb-1">Description *</label>
                <input
                  required
                  value={jeDesc}
                  onChange={(e) => setJeDesc(e.target.value)}
                  placeholder="e.g. Monthly bank charges or accrued utility adjustment"
                  className="w-full px-3 py-2 border border-slate-300 rounded-md"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Debit Account *</label>
                  <select
                    value={jeDebitAcct}
                    onChange={(e) => setJeDebitAcct(e.target.value)}
                    className="w-full px-2.5 py-2 border border-slate-300 rounded-md bg-white"
                  >
                    {overview.accounts.map((a) => (
                      <option key={a.code} value={a.code}>
                        {a.code} · {a.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Credit Account *</label>
                  <select
                    value={jeCreditAcct}
                    onChange={(e) => setJeCreditAcct(e.target.value)}
                    className="w-full px-2.5 py-2 border border-slate-300 rounded-md bg-white"
                  >
                    {overview.accounts.map((a) => (
                      <option key={a.code} value={a.code}>
                        {a.code} · {a.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Amount ($) *</label>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  required
                  value={jeAmount}
                  onChange={(e) => setJeAmount(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-md font-mono"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setJeModalOpen(false)}
                  className="px-3 py-1.5 border border-slate-200 rounded-md text-slate-700"
                >
                  Cancel
                </button>
                <button type="submit" className="px-4 py-1.5 bg-teal-700 hover:bg-teal-800 text-white rounded-md font-medium">
                  Post Entry
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* EXPENSE VOUCHER MODAL */}
      {expModalOpen && overview && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-lg w-full max-w-lg p-6">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="font-display text-base font-semibold text-slate-900">New Expense Voucher</h3>
                <p className="text-xs text-slate-500">Automatically posts a balanced debit/credit entry to the General Ledger.</p>
              </div>
              <button onClick={() => setExpModalOpen(false)} className="text-slate-400 hover:text-slate-600">
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleCreateExpense} className="space-y-3.5 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Expense Date *</label>
                  <input
                    type="date"
                    required
                    value={expDate}
                    onChange={(e) => setExpDate(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-md font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Category *</label>
                  <input
                    required
                    list="expense-categories-modal"
                    value={expCategory}
                    onChange={(e) => setExpCategory(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-md"
                  />
                  <datalist id="expense-categories-modal">
                    <option value="Utilities & Power" />
                    <option value="Medical Supplies & Consumables" />
                    <option value="Equipment Maintenance & Repairs" />
                    <option value="Cleaning & Sanitation" />
                    <option value="Office & IT Services" />
                    <option value="Staff Welfare & Training" />
                    <option value="Courier & Logistics" />
                  </datalist>
                </div>
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">GL Expense Account *</label>
                <select
                  value={expAcct}
                  onChange={(e) => setExpAcct(e.target.value)}
                  className="w-full px-2.5 py-2 border border-slate-300 rounded-md bg-white"
                >
                  {expenseAccounts.map((a) => (
                    <option key={a.code} value={a.code}>
                      {a.code} · {a.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Payee / Vendor Name *</label>
                <input
                  required
                  value={expPayee}
                  onChange={(e) => setExpPayee(e.target.value)}
                  placeholder="e.g. City Power Utility"
                  className="w-full px-3 py-2 border border-slate-300 rounded-md"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Amount ($) *</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    required
                    value={expAmount}
                    onChange={(e) => setExpAmount(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-md font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Payment Source *</label>
                  <select
                    value={expMethod}
                    onChange={(e) => setExpMethod(e.target.value as 'bank_transfer' | 'cash')}
                    className="w-full px-2.5 py-2 border border-slate-300 rounded-md bg-white"
                  >
                    <option value="bank_transfer">Bank Transfer (1020)</option>
                    <option value="cash">Petty Cash (1010)</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Description *</label>
                <input
                  required
                  value={expDesc}
                  onChange={(e) => setExpDesc(e.target.value)}
                  placeholder="Operational expense details or invoice ref"
                  className="w-full px-3 py-2 border border-slate-300 rounded-md"
                />
              </div>
              <div className="text-[11px] font-mono text-slate-600 bg-slate-50 border border-slate-200 rounded px-3 py-2">
                Auto-GL: Dr {expAcct} (${expPreviewAmt}) / Cr {expMethod === 'cash' ? '1010' : '1020'} (${expPreviewAmt})
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setExpModalOpen(false)}
                  className="px-3 py-1.5 border border-slate-200 rounded-md text-slate-700"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={expSubmitting}
                  className="px-4 py-1.5 bg-teal-700 hover:bg-teal-800 disabled:opacity-60 text-white rounded-md font-medium"
                >
                  {expSubmitting ? 'Posting...' : 'Record & Post to GL'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      {/* JOURNAL REVERSAL MODAL */}
      {reverseTarget && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-lg w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-display text-base font-semibold text-slate-900">
                Reverse Journal Entry · {reverseTarget.entry_number}
              </h3>
              <button onClick={() => setReverseTarget(null)} className="text-slate-400 hover:text-slate-600">
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleReverseJournal} className="space-y-4 text-xs">
              <div className="p-3 bg-slate-50 border border-slate-200 rounded text-slate-700">
                <div><strong>Description:</strong> {reverseTarget.description}</div>
                <div className="font-mono mt-1">Amount: ${Number(reverseTarget.total_debit).toFixed(2)}</div>
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Reversal Reason (min 5 chars) *</label>
                <textarea
                  rows={2}
                  required
                  minLength={5}
                  value={reverseReason}
                  onChange={(e) => setReverseReason(e.target.value)}
                  placeholder="e.g. Incorrect GL expense account posted; rebooking under 5300"
                  className="w-full px-3 py-2 border border-slate-300 rounded-md"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setReverseTarget(null)}
                  className="px-3 py-1.5 border border-slate-200 rounded-md text-slate-700"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={reversingJournal}
                  className="px-4 py-1.5 bg-slate-900 hover:bg-slate-800 disabled:opacity-60 text-white rounded-md font-medium"
                >
                  {reversingJournal ? 'Posting Reversal...' : 'Post Reversal Entry'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
