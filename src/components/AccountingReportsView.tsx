import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowRightLeft,
  BookOpen,
  Check,
  Download,
  Edit3,
  FileText,
  Landmark,
  Lock,
  Package,
  Plus,
  Printer,
  RefreshCw,
  RotateCcw,
  Sliders,
  Trash2,
  Wallet,
  X,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import { FinancePrintModal, type FinancePrintTarget } from './FinancePrintModal';
import type {
  AccountingPeriod,
  BalanceSheetData,
  CashBankAccount,
  CashBankTransfer,
  ChartAccount,
  ExpenseVoucher,
  FinancePayment,
  FinanceReceipt,
  GrvRecord,
  HrMonthlySubmission,
  InsuranceClaim,
  JournalEntry,
  PayrollComponent,
  PayrollItem,
  PayrollRun,
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
  balanceSheet?: BalanceSheetData;
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
  payrollComponents?: PayrollComponent[];
  cashBankAccounts?: CashBankAccount[];
  cashBankTransfers?: CashBankTransfer[];
  financePayments?: FinancePayment[];
  financeReceipts?: FinanceReceipt[];
  grvs?: GrvRecord[];
  approvedHrSubmissions?: HrMonthlySubmission[];
  payrollRuns?: PayrollRun[];
  storeItems?: Array<{ id: number; code: string; name: string; category: string; unit: string; unit_cost: number }>;
}

type SubTab =
  | 'statements'
  | 'coa'
  | 'payroll'
  | 'grvs'
  | 'expenses'
  | 'payments'
  | 'cashbank'
  | 'ledger'
  | 'arap'
  | 'reports';

type ReportType =
  | 'trial-balance'
  | 'balance-sheet'
  | 'payroll-summary'
  | 'payroll-payments'
  | 'expense-report'
  | 'grv-report'
  | 'payments-report'
  | 'receipts-report'
  | 'cash-report'
  | 'bank-report'
  | 'daily-cash'
  | 'ar-ageing'
  | 'opd-diagnoses'
  | 'lab-turnaround'
  | 'stock-valuation';

const REPORT_LABELS: Record<ReportType, string> = {
  'trial-balance': 'Trial Balance (Chart of Accounts)',
  'balance-sheet': 'Balance Sheet (Assets, Liabilities & Equity)',
  'payroll-summary': 'Payroll Summary by Period & Run',
  'payroll-payments': 'Employee Payroll & Salary Payments',
  'expense-report': 'Clinic Expense Vouchers Report',
  'grv-report': 'Goods Received Vouchers (GRV) Report',
  'payments-report': 'General Finance Payments Register (FPV)',
  'receipts-report': 'General Finance Receipts Register (FRV)',
  'cash-report': 'Cash Accounts & Movement Summary',
  'bank-report': 'Bank Accounts & Movement Summary',
  'daily-cash': 'Daily Patient Cashier Collection',
  'ar-ageing': 'Insurance Accounts Receivable Ageing',
  'opd-diagnoses': 'Outpatient Visits & Top Diagnoses',
  'lab-turnaround': 'Laboratory Turnaround & Verification',
  'stock-valuation': 'Inventory Stock Valuation & Expiry',
};

interface Props {
  user: UserContext;
  onNotify: (msg: string, type?: 'success' | 'error') => void;
}

export const AccountingReportsView: React.FC<Props> = ({ user, onNotify }) => {
  const [subTab, setSubTab] = useState<SubTab>('statements');
  const [overview, setOverview] = useState<AccountingOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [printTarget, setPrintTarget] = useState<FinancePrintTarget | null>(null);

  const canManage = user.permissions.includes('accounting.ledger.manage');
  const canManageCoa = canManage || user.permissions.includes('finance.coa.manage');
  const canPayrollGen = canManage || user.permissions.includes('finance.payroll.generate');
  const canVerifyPayroll = user.permissions.includes('hr.payroll.verify') || user.permissions.includes('finance.payroll.generate');
  const canApprovePayroll = canManage || user.permissions.includes('hr.payroll.approve');
  const canPostPayroll = canManage || user.permissions.includes('hr.payroll.post') || user.permissions.includes('finance.payroll.generate');
  const canPayPayroll = canManage || user.permissions.includes('hr.payroll.pay') || user.permissions.includes('finance.payment.manage');
  const canGrv = canManage || user.permissions.includes('finance.grv.manage');
  const canPay = canManage || user.permissions.includes('finance.payment.manage');
  const canReceipt = canManage || user.permissions.includes('finance.receipt.manage');
  const canBank = canManage || user.permissions.includes('finance.bank.manage');
  const canRecordExpense = canManage || user.permissions.includes('accounting.expense.create');
  const canApproveExpense = canManage || user.permissions.includes('accounting.expense.approve');
  const canClosePeriod = canManage || user.permissions.includes('accounting.period.manage');
  const canReverseJournal = canManage || user.permissions.includes('accounting.journal.reverse');

  // Chart of Accounts state
  const [coaTypeFilter, setCoaTypeFilter] = useState('all');
  const [coaModalOpen, setCoaModalOpen] = useState(false);
  const [editingCoa, setEditingCoa] = useState<ChartAccount | null>(null);
  const [coaCode, setCoaCode] = useState('');
  const [coaName, setCoaName] = useState('');
  const [coaType, setCoaType] = useState<ChartAccount['account_type']>('expense');
  const [coaNormal, setCoaNormal] = useState<'debit' | 'credit'>('debit');
  const [coaParentId, setCoaParentId] = useState('');
  const [coaDesc, setCoaDesc] = useState('');

  // Payroll state
  const [payMonth, setPayMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [compModalOpen, setCompModalOpen] = useState(false);
  const [compCode, setCompCode] = useState('');
  const [compName, setCompName] = useState('');
  const [compType, setCompType] = useState<'earning' | 'deduction'>('earning');
  const [compCalc, setCompCalc] = useState<'fixed' | 'percentage' | 'manual'>('fixed');
  const [compVal, setCompVal] = useState('0');
  const [compCoa, setCompCoa] = useState('5100');
  const [editPayItem, setEditPayItem] = useState<PayrollItem | null>(null);
  const [editAllow, setEditAllow] = useState('0');
  const [editOt, setEditOt] = useState('0');
  const [editBonus, setEditBonus] = useState('0');
  const [editOtherDed, setEditOtherDed] = useState('0');
  const [payItemModal, setPayItemModal] = useState<{ runId: number; item: PayrollItem } | null>(null);
  const [payItemAmt, setPayItemAmt] = useState('');
  const [payItemCbId, setPayItemCbId] = useState('');
  const [payItemMethod, setPayItemMethod] = useState<'bank_transfer' | 'cash'>('bank_transfer');
  const [payItemRef, setPayItemRef] = useState('');
  const [rejectRunTarget, setRejectRunTarget] = useState<PayrollRun | null>(null);
  const [rejectRunReason, setRejectRunReason] = useState('');

  // GRV state
  const [grvSupplier, setGrvSupplier] = useState('');
  const [grvInvRef, setGrvInvRef] = useState('');
  const [grvDelDate, setGrvDelDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [grvRecDate, setGrvRecDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [grvDept, setGrvDept] = useState('Main Store');
  const [grvAttach, setGrvAttach] = useState('');
  const [grvItemId, setGrvItemId] = useState('');
  const [grvNewName, setGrvNewName] = useState('');
  const [grvNewCat, setGrvNewCat] = useState<'medicine' | 'reagent' | 'consumable'>('consumable');
  const [grvBatch, setGrvBatch] = useState('');
  const [grvExpiry, setGrvExpiry] = useState(() => new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10));
  const [grvQty, setGrvQty] = useState('10');
  const [grvCost, setGrvCost] = useState('5.00');
  const [grvApproveNow, setGrvApproveNow] = useState(true);
  const [grvNotes, setGrvNotes] = useState('');

  // Expense state
  const [expDate, setExpDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [expCategory, setExpCategory] = useState('Utilities & Power');
  const [expAcct, setExpAcct] = useState('5200');
  const [expPayee, setExpPayee] = useState('');
  const [expAmount, setExpAmount] = useState('');
  const [expMethod, setExpMethod] = useState<'bank_transfer' | 'cash'>('bank_transfer');
  const [expCbId, setExpCbId] = useState('');
  const [expRefNo, setExpRefNo] = useState('');
  const [expAttach, setExpAttach] = useState('');
  const [expDesc, setExpDesc] = useState('');
  const [expAutoPost, setExpAutoPost] = useState(true);
  const [expPayModal, setExpPayModal] = useState<ExpenseVoucher | null>(null);
  const [expPayAmt, setExpPayAmt] = useState('');
  const [expPayCbId, setExpPayCbId] = useState('');
  const [expPayRef, setExpPayRef] = useState('');

  // General Payments & Receipts state
  const [pmtSubMode, setPmtSubMode] = useState<'payments' | 'receipts'>('payments');
  const [gpDate, setGpDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [gpCat, setGpCat] = useState('utility');
  const [gpLinked, setGpLinked] = useState('');
  const [gpPayee, setGpPayee] = useState('');
  const [gpCbId, setGpCbId] = useState('');
  const [gpMethod, setGpMethod] = useState<'bank_transfer' | 'cash'>('bank_transfer');
  const [gpAmount, setGpAmount] = useState('');
  const [gpDebitCoa, setGpDebitCoa] = useState('5200');
  const [gpRef, setGpRef] = useState('');
  const [gpAttach, setGpAttach] = useState('');
  const [gpNotes, setGpNotes] = useState('');

  const [grDate, setGrDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [grCat, setGrCat] = useState('grant');
  const [grPayer, setGrPayer] = useState('');
  const [grCbId, setGrCbId] = useState('');
  const [grMethod, setGrMethod] = useState<'bank_transfer' | 'cash'>('bank_transfer');
  const [grAmount, setGrAmount] = useState('');
  const [grCreditCoa, setGrCreditCoa] = useState('4050');
  const [grRef, setGrRef] = useState('');
  const [grNotes, setGrNotes] = useState('');

  // Cash & Bank state
  const [cbModalOpen, setCbModalOpen] = useState(false);
  const [cbName, setCbName] = useState('');
  const [cbType, setCbType] = useState<'cash' | 'bank'>('bank');
  const [cbAcctNo, setCbAcctNo] = useState('');
  const [cbBankName, setCbBankName] = useState('');
  const [cbCoaCode, setCbCoaCode] = useState('1020');
  const [cbOpening, setCbOpening] = useState('0');
  const [trFromId, setTrFromId] = useState('');
  const [trToId, setTrToId] = useState('');
  const [trDate, setTrDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [trAmt, setTrAmt] = useState('');
  const [trRef, setTrRef] = useState('');
  const [trNotes, setTrNotes] = useState('');

  // Manual Journal & Periods
  const [jeModalOpen, setJeModalOpen] = useState(false);
  const [jeDesc, setJeDesc] = useState('');
  const [jeDebitAcct, setJeDebitAcct] = useState('5200');
  const [jeCreditAcct, setJeCreditAcct] = useState('1020');
  const [jeAmount, setJeAmount] = useState('');
  const [periodToClose, setPeriodToClose] = useState(() => new Date().toISOString().slice(0, 7));
  const [closingPeriod, setClosingPeriod] = useState(false);
  const [reverseTarget, setReverseTarget] = useState<JournalEntry | null>(null);
  const [reverseReason, setReverseReason] = useState('');

  // Reports state
  const [reportType, setReportType] = useState<ReportType>('trial-balance');
  const [fromDate, setFromDate] = useState(() => new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10));
  const [toDate, setToDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [reportRows, setReportRows] = useState<Array<Record<string, unknown>>>([]);
  const [reportLoading, setReportLoading] = useState(false);

  const loadOverview = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch<AccountingOverview>('/api/accounting/overview');
      setOverview(data);
      const cbList = data.cashBankAccounts || [];
      if (cbList.length > 0) {
        const firstId = String(cbList[0].id);
        setGpCbId((p) => p || firstId);
        setGrCbId((p) => p || firstId);
        setTrFromId((p) => p || firstId);
        setTrToId((p) => p || (cbList[1] ? String(cbList[1].id) : firstId));
      }
      if ((data.storeItems || []).length > 0) {
        setGrvItemId((p) => p || String(data.storeItems![0].id));
      }
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

  // --- Handlers ---
  function openNewCoaModal() {
    setEditingCoa(null);
    setCoaCode('');
    setCoaName('');
    setCoaType('expense');
    setCoaNormal('debit');
    setCoaParentId('');
    setCoaDesc('');
    setCoaModalOpen(true);
  }

  function openEditCoaModal(a: ChartAccount) {
    setEditingCoa(a);
    setCoaCode(a.code);
    setCoaName(a.name);
    setCoaType(a.account_type);
    setCoaNormal(a.normal_balance);
    setCoaParentId(a.parent_id ? String(a.parent_id) : '');
    setCoaDesc(a.description || '');
    setCoaModalOpen(true);
  }

  async function handleSaveCoa(e: React.FormEvent) {
    e.preventDefault();
    try {
      if (editingCoa) {
        await apiFetch(`/api/accounting/accounts/${editingCoa.id}`, {
          method: 'PUT',
          body: JSON.stringify({
            name: coaName.trim(),
            account_type: coaType,
            normal_balance: coaNormal,
            parent_id: coaParentId ? Number(coaParentId) : null,
            description: coaDesc.trim() || null,
          }),
        });
        onNotify(`Updated COA account ${editingCoa.code}.`);
      } else {
        await apiFetch('/api/accounting/accounts', {
          method: 'POST',
          body: JSON.stringify({
            code: coaCode.trim(),
            name: coaName.trim(),
            account_type: coaType,
            normal_balance: coaNormal,
            parent_id: coaParentId ? Number(coaParentId) : null,
            description: coaDesc.trim() || null,
          }),
        });
        onNotify(`Created COA account ${coaCode.trim()}.`);
      }
      setCoaModalOpen(false);
      loadOverview();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleToggleCoa(a: ChartAccount) {
    try {
      await apiFetch(`/api/accounting/accounts/${a.id}/toggle`, { method: 'PATCH' });
      onNotify(`Account ${a.code} ${a.active ? 'deactivated' : 'activated'}.`);
      loadOverview();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleDeleteCoa(a: ChartAccount) {
    try {
      await apiFetch(`/api/accounting/accounts/${a.id}`, { method: 'DELETE' });
      onNotify(`Deleted unused COA account ${a.code}.`);
      loadOverview();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleGeneratePayroll() {
    try {
      const res = await apiFetch<{ runNumber: string }>('/api/accounting/payroll/generate', {
        method: 'POST',
        body: JSON.stringify({ pay_month: payMonth }),
      });
      onNotify(`Generated payroll draft ${res.runNumber} for ${payMonth}.`);
      loadOverview();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleSavePayrollComponent(e: React.FormEvent) {
    e.preventDefault();
    try {
      await apiFetch('/api/accounting/payroll-components', {
        method: 'POST',
        body: JSON.stringify({
          code: compCode.trim(),
          name: compName.trim(),
          component_type: compType,
          calc_method: compCalc,
          default_value: Number(compVal || 0),
          account_code: compCoa,
        }),
      });
      onNotify(`Created payroll component ${compCode.trim().toUpperCase()}.`);
      setCompCode('');
      setCompName('');
      loadOverview();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleSavePayrollItemAdjustment(e: React.FormEvent) {
    e.preventDefault();
    if (!editPayItem) return;
    try {
      await apiFetch(`/api/hr/payroll/items/${editPayItem.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          allowances: Number(editAllow || 0),
          overtime_pay: Number(editOt || 0),
          bonus_earnings: Number(editBonus || 0),
          other_deductions: Number(editOtherDed || 0),
        }),
      });
      onNotify(`Recalculated payslip for ${editPayItem.staff_name}.`);
      setEditPayItem(null);
      loadOverview();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handlePayrollAction(runId: number, action: 'verify' | 'approve' | 'post' | 'pay') {
    try {
      const res = await apiFetch<{ entryNumber?: string }>(`/api/hr/payroll/${runId}/${action}`, {
        method: 'POST',
      });
      onNotify(
        res.entryNumber ? `Payroll ${action} completed (GL ${res.entryNumber}).` : `Payroll run ${action} completed.`
      );
      loadOverview();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleRejectPayrollRun(e: React.FormEvent) {
    e.preventDefault();
    if (!rejectRunTarget) return;
    try {
      await apiFetch(`/api/hr/payroll/${rejectRunTarget.id}/reject`, {
        method: 'POST',
        body: JSON.stringify({ reason: rejectRunReason.trim() }),
      });
      onNotify(`Payroll run ${rejectRunTarget.run_number} rejected and released for correction.`);
      setRejectRunTarget(null);
      setRejectRunReason('');
      loadOverview();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handlePayPayrollItem(e: React.FormEvent) {
    e.preventDefault();
    if (!payItemModal) return;
    try {
      const res = await apiFetch<{ paymentNumber: string; entryNumber: string; paid: number }>(
        `/api/hr/payroll/${payItemModal.runId}/items/${payItemModal.item.id}/pay`,
        {
          method: 'POST',
          body: JSON.stringify({
            amount: Number(payItemAmt),
            cash_bank_account_id: payItemCbId ? Number(payItemCbId) : undefined,
            payment_method: payItemMethod,
            reference_no: payItemRef.trim() || undefined,
          }),
        }
      );
      onNotify(`Salary payment ${res.paymentNumber} ($${res.paid.toFixed(2)}) posted (${res.entryNumber}).`);
      setPayItemModal(null);
      loadOverview();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleCreateGrv(e: React.FormEvent) {
    e.preventDefault();
    try {
      const res = await apiFetch<{ grnNumber: string; approval_status: string; billNumber?: string | null }>(
        '/api/accounting/grvs',
        {
          method: 'POST',
          body: JSON.stringify({
            supplier_name: grvSupplier.trim(),
            invoice_ref: grvInvRef.trim() || null,
            delivery_date: grvDelDate,
            received_date: grvRecDate,
            department_name: grvDept.trim(),
            attachment_ref: grvAttach.trim() || null,
            notes: grvNotes.trim() || null,
            approve_immediately: grvApproveNow,
            item_id: grvItemId ? Number(grvItemId) : undefined,
            new_item_name: !grvItemId ? grvNewName.trim() : undefined,
            new_item_category: !grvItemId ? grvNewCat : undefined,
            batch_number: grvBatch.trim(),
            expiry_date: grvExpiry,
            quantity: Number(grvQty),
            unit_cost: Number(grvCost),
          }),
        }
      );
      onNotify(
        res.billNumber
          ? `GRV ${res.grnNumber} approved & posted to inventory + AP (${res.billNumber}).`
          : `GRV ${res.grnNumber} saved as pending review.`
      );
      setGrvInvRef('');
      setGrvBatch('');
      setGrvNewName('');
      setGrvNotes('');
      loadOverview();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleDecideGrv(id: number, decision: 'approved' | 'rejected') {
    try {
      const res = await apiFetch<{ billNumber?: string | null }>(`/api/accounting/grvs/${id}/decide`, {
        method: 'POST',
        body: JSON.stringify({ decision }),
      });
      onNotify(
        decision === 'approved'
          ? `GRV approved & posted to inventory${res.billNumber ? ` (${res.billNumber})` : ''}.`
          : 'GRV rejected.'
      );
      loadOverview();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleCreateExpense(e: React.FormEvent) {
    e.preventDefault();
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
            amount: Number(expAmount),
            payment_method: expMethod,
            cash_bank_account_id: expCbId ? Number(expCbId) : undefined,
            reference_number: expRefNo.trim() || null,
            attachment_ref: expAttach.trim() || null,
            description: expDesc.trim(),
            auto_post: expAutoPost,
          }),
        }
      );
      onNotify(
        res.entryNumber
          ? `Expense ${res.voucherNumber} posted & paid (${res.entryNumber}).`
          : `Expense ${res.voucherNumber} created (${res.status}).`
      );
      setExpPayee('');
      setExpAmount('');
      setExpRefNo('');
      setExpAttach('');
      setExpDesc('');
      loadOverview();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleDecideExpense(id: number, decision: 'approved' | 'paid' | 'rejected') {
    try {
      const res = await apiFetch<{ entryNumber?: string | null }>(`/api/accounting/expenses/${id}/decide`, {
        method: 'POST',
        body: JSON.stringify({ decision }),
      });
      onNotify(
        decision === 'approved'
          ? `Expense approved to AP (${res.entryNumber}).`
          : decision === 'paid'
            ? `Expense approved & disbursed (${res.entryNumber}).`
            : 'Expense voucher rejected.'
      );
      loadOverview();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handlePayExpense(e: React.FormEvent) {
    e.preventDefault();
    if (!expPayModal) return;
    try {
      const res = await apiFetch<{ paymentNumber: string; paid: number }>(`/api/accounting/expenses/${expPayModal.id}/pay`, {
        method: 'POST',
        body: JSON.stringify({
          amount: Number(expPayAmt),
          cash_bank_account_id: expPayCbId ? Number(expPayCbId) : undefined,
          reference_no: expPayRef.trim() || undefined,
        }),
      });
      onNotify(`Disbursed $${res.paid.toFixed(2)} via ${res.paymentNumber}.`);
      setExpPayModal(null);
      loadOverview();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleCreateGeneralPayment(e: React.FormEvent) {
    e.preventDefault();
    try {
      let linked_type: string | undefined;
      let linked_id: number | undefined;
      if (gpLinked.includes(':')) {
        const [t, idStr] = gpLinked.split(':');
        linked_type = t;
        linked_id = Number(idStr);
      }
      const res = await apiFetch<{ paymentNumber: string; entryNumber: string }>('/api/accounting/payments', {
        method: 'POST',
        body: JSON.stringify({
          payment_date: gpDate,
          payment_category: gpCat,
          payee_name: gpPayee.trim(),
          cash_bank_account_id: Number(gpCbId),
          payment_method: gpMethod,
          amount: Number(gpAmount),
          debit_account_code: gpDebitCoa,
          reference_no: gpRef.trim() || null,
          attachment_ref: gpAttach.trim() || null,
          linked_type,
          linked_id,
          notes: gpNotes.trim() || null,
        }),
      });
      onNotify(`Payment voucher ${res.paymentNumber} posted (GL ${res.entryNumber}).`);
      setGpLinked('');
      setGpPayee('');
      setGpAmount('');
      setGpRef('');
      setGpAttach('');
      setGpNotes('');
      loadOverview();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleCreateGeneralReceipt(e: React.FormEvent) {
    e.preventDefault();
    try {
      const res = await apiFetch<{ receiptNumber: string; entryNumber: string }>('/api/accounting/receipts', {
        method: 'POST',
        body: JSON.stringify({
          receipt_date: grDate,
          income_category: grCat,
          payer_name: grPayer.trim(),
          cash_bank_account_id: Number(grCbId),
          payment_method: grMethod,
          amount: Number(grAmount),
          credit_account_code: grCreditCoa,
          reference_no: grRef.trim() || null,
          notes: grNotes.trim() || null,
        }),
      });
      onNotify(`Receipt voucher ${res.receiptNumber} recorded (GL ${res.entryNumber}).`);
      setGrPayer('');
      setGrAmount('');
      setGrRef('');
      setGrNotes('');
      loadOverview();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleCreateCashBankAccount(e: React.FormEvent) {
    e.preventDefault();
    try {
      await apiFetch('/api/accounting/cash-bank/accounts', {
        method: 'POST',
        body: JSON.stringify({
          account_name: cbName.trim(),
          account_type: cbType,
          account_number: cbAcctNo.trim() || null,
          bank_name: cbBankName.trim() || null,
          coa_code: cbCoaCode,
          opening_balance: Number(cbOpening || 0),
        }),
      });
      onNotify(`Added ${cbType} account "${cbName.trim()}".`);
      setCbModalOpen(false);
      setCbName('');
      setCbAcctNo('');
      setCbBankName('');
      setCbOpening('0');
      loadOverview();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleTransferFunds(e: React.FormEvent) {
    e.preventDefault();
    try {
      const res = await apiFetch<{ transferNumber: string; entryNumber: string }>('/api/accounting/cash-bank/transfer', {
        method: 'POST',
        body: JSON.stringify({
          from_account_id: Number(trFromId),
          to_account_id: Number(trToId),
          amount: Number(trAmt),
          transfer_date: trDate,
          reference_no: trRef.trim() || null,
          notes: trNotes.trim() || null,
        }),
      });
      onNotify(`Transfer ${res.transferNumber} completed (GL ${res.entryNumber}).`);
      setTrAmt('');
      setTrRef('');
      setTrNotes('');
      loadOverview();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

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

  async function handleClosePeriod(e: React.FormEvent) {
    e.preventDefault();
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
  const activeAccounts = useMemo(() => (overview?.accounts || []).filter((a) => a.active === 1), [overview?.accounts]);
  const expenseAccounts = useMemo(() => activeAccounts.filter((a) => a.account_type === 'expense'), [activeAccounts]);
  const revenueAccounts = useMemo(() => activeAccounts.filter((a) => a.account_type === 'revenue'), [activeAccounts]);
  const cashBankAccounts = useMemo(() => overview?.cashBankAccounts || [], [overview?.cashBankAccounts]);

  const filteredCoa = useMemo(() => {
    const list = overview?.accounts || [];
    return coaTypeFilter === 'all' ? list : list.filter((a) => a.account_type === coaTypeFilter);
  }, [overview?.accounts, coaTypeFilter]);

  const openBills = useMemo(
    () => (overview?.supplierBills || []).filter((b) => b.status !== 'paid'),
    [overview?.supplierBills]
  );
  const payableExpenses = useMemo(
    () => (overview?.expenseVouchers || []).filter((ev) => ev.status === 'approved' || ev.status === 'partial'),
    [overview?.expenseVouchers]
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 no-print">
        <div>
          <h1 className="font-display text-xl font-semibold text-slate-900">Finance &amp; Accounting Management</h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Chart of Accounts, Payroll Processing, GRVs, Expenses, Payments &amp; Receipts, Cash &amp; Bank, and Financial Statements.
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
      <div className="flex flex-wrap gap-1 border-b border-slate-200 no-print">
        {(
          [
            ['statements', 'Statements & Balance Sheet'],
            ['coa', 'Chart of Accounts'],
            ['payroll', 'Payroll Processing'],
            ['grvs', 'GRV Management'],
            ['expenses', 'Expense Vouchers'],
            ['payments', 'Payments & Receipts'],
            ['cashbank', 'Cash & Bank'],
            ['ledger', 'GL & Periods'],
            ['arap', 'AR & AP'],
            ['reports', 'Financial Reports'],
          ] as Array<[SubTab, string]>
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setSubTab(key)}
            className={`px-3.5 py-2 text-xs font-medium border-b-2 transition-colors whitespace-nowrap ${
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
          Loading Finance workspace...
        </div>
      ) : null}

      {/* 1. STATEMENTS & BALANCE SHEET */}
      {subTab === 'statements' && overview && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <div className="lg:col-span-7 bg-white border border-slate-200 rounded-lg overflow-hidden">
              <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
                <h2 className="font-display text-sm font-semibold text-slate-900">Trial Balance</h2>
                <span className="text-xs font-mono text-emerald-700">
                  {Math.abs(totalTbDebit - totalTbCredit) < 0.02 ? 'Balanced' : 'Check Variance'}
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-slate-500">
                      <th className="py-2 px-4">Code</th>
                      <th className="py-2 px-4">Account Name</th>
                      <th className="py-2 px-4">Type</th>
                      <th className="py-2 px-4 text-right">Debit</th>
                      <th className="py-2 px-4 text-right">Credit</th>
                      <th className="py-2 px-4 text-right">Balance</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {overview.trialBalance.map((row) => (
                      <tr key={row.id}>
                        <td className="py-1.5 px-4 font-mono font-semibold text-slate-800">{row.code}</td>
                        <td className="py-1.5 px-4 text-slate-900">{row.name}</td>
                        <td className="py-1.5 px-4 uppercase font-mono text-slate-500">{row.account_type}</td>
                        <td className="py-1.5 px-4 text-right font-mono tabular-nums">${row.debit_total.toFixed(2)}</td>
                        <td className="py-1.5 px-4 text-right font-mono tabular-nums">${row.credit_total.toFixed(2)}</td>
                        <td className="py-1.5 px-4 text-right font-mono font-semibold tabular-nums">
                          ${row.net_balance.toFixed(2)}
                        </td>
                      </tr>
                    ))}
                    <tr className="bg-slate-50 font-semibold border-t border-slate-200">
                      <td colSpan={3} className="py-2 px-4 text-slate-900">
                        Totals
                      </td>
                      <td className="py-2 px-4 text-right font-mono tabular-nums">${totalTbDebit.toFixed(2)}</td>
                      <td className="py-2 px-4 text-right font-mono tabular-nums">${totalTbCredit.toFixed(2)}</td>
                      <td className="py-2 px-4 text-right font-mono tabular-nums text-emerald-700">$0.00 diff</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <div className="lg:col-span-5 space-y-6">
              <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
                <div className="px-5 py-3.5 border-b border-slate-200">
                  <h2 className="font-display text-sm font-semibold text-slate-900">Income Statement (P&amp;L)</h2>
                </div>
                <div className="p-5 space-y-4 text-xs">
                  <div>
                    <div className="font-semibold text-slate-700 uppercase tracking-wide mb-1.5">Operating Revenue</div>
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
                  <div>
                    <div className="font-semibold text-slate-700 uppercase tracking-wide mb-1.5">Operating Expenses</div>
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
                  <div className="pt-2.5 border-t border-slate-200 flex justify-between items-baseline">
                    <span className="font-display text-sm font-semibold text-slate-900">Net Operating Surplus</span>
                    <span
                      className={`font-mono text-base font-semibold tabular-nums ${
                        overview.incomeStatement.netIncome >= 0 ? 'text-emerald-700' : 'text-red-700'
                      }`}
                    >
                      ${overview.incomeStatement.netIncome.toFixed(2)}
                    </span>
                  </div>
                </div>
              </div>

              {overview.balanceSheet && (
                <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
                  <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
                    <h2 className="font-display text-sm font-semibold text-slate-900">Balance Sheet</h2>
                    <span
                      className={`text-xs font-mono font-semibold ${
                        overview.balanceSheet.balanced ? 'text-emerald-700' : 'text-red-700'
                      }`}
                    >
                      {overview.balanceSheet.balanced ? 'Assets = Liab + Equity' : 'Check Equation'}
                    </span>
                  </div>
                  <div className="p-5 space-y-4 text-xs">
                    <div>
                      <div className="font-semibold text-slate-700 uppercase tracking-wide mb-1">Assets</div>
                      {overview.balanceSheet.assets.map((a) => (
                        <div key={a.id} className="flex justify-between py-1 border-b border-slate-100">
                          <span>
                            <span className="font-mono text-slate-500 mr-2">{a.code}</span>
                            {a.name}
                          </span>
                          <span className="font-mono tabular-nums">${a.net_balance.toFixed(2)}</span>
                        </div>
                      ))}
                      <div className="flex justify-between pt-1.5 font-semibold text-slate-900">
                        <span>Total Assets</span>
                        <span className="font-mono tabular-nums">${overview.balanceSheet.totalAssets.toFixed(2)}</span>
                      </div>
                    </div>
                    <div>
                      <div className="font-semibold text-slate-700 uppercase tracking-wide mb-1">Liabilities</div>
                      {overview.balanceSheet.liabilities.map((l) => (
                        <div key={l.id} className="flex justify-between py-1 border-b border-slate-100">
                          <span>
                            <span className="font-mono text-slate-500 mr-2">{l.code}</span>
                            {l.name}
                          </span>
                          <span className="font-mono tabular-nums">${l.net_balance.toFixed(2)}</span>
                        </div>
                      ))}
                      <div className="flex justify-between pt-1.5 font-semibold text-slate-900">
                        <span>Total Liabilities</span>
                        <span className="font-mono tabular-nums">${overview.balanceSheet.totalLiabilities.toFixed(2)}</span>
                      </div>
                    </div>
                    <div>
                      <div className="font-semibold text-slate-700 uppercase tracking-wide mb-1">Equity &amp; Current Earnings</div>
                      {overview.balanceSheet.equity.map((eq) => (
                        <div key={eq.id} className="flex justify-between py-1 border-b border-slate-100">
                          <span>
                            <span className="font-mono text-slate-500 mr-2">{eq.code}</span>
                            {eq.name}
                          </span>
                          <span className="font-mono tabular-nums">${eq.net_balance.toFixed(2)}</span>
                        </div>
                      ))}
                      <div className="flex justify-between py-1 border-b border-slate-100">
                        <span>Current Period Net Income</span>
                        <span className="font-mono tabular-nums">${overview.balanceSheet.currentNetIncome.toFixed(2)}</span>
                      </div>
                      <div className="flex justify-between pt-2 border-t border-slate-200 font-semibold text-slate-900">
                        <span>Total Liabilities &amp; Equity</span>
                        <span className="font-mono tabular-nums text-teal-800">
                          ${overview.balanceSheet.totalLiabilitiesAndEquity.toFixed(2)}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 2. CHART OF ACCOUNTS */}
      {subTab === 'coa' && overview && (
        <div className="space-y-4">
          <div className="bg-white border border-slate-200 rounded-lg p-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-xs">
              <label className="font-medium text-slate-700">Account Category:</label>
              <select
                value={coaTypeFilter}
                onChange={(e) => setCoaTypeFilter(e.target.value)}
                className="px-2.5 py-1.5 border border-slate-300 rounded-md bg-white"
              >
                <option value="all">All Categories ({overview.accounts.length})</option>
                <option value="asset">Assets</option>
                <option value="liability">Liabilities</option>
                <option value="equity">Equity</option>
                <option value="revenue">Revenue</option>
                <option value="expense">Expenses</option>
              </select>
            </div>
            {canManageCoa && (
              <button
                onClick={openNewCoaModal}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Add Account</span>
              </button>
            )}
          </div>

          <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-slate-500">
                    <th className="py-2.5 px-4">Code</th>
                    <th className="py-2.5 px-4">Account Name &amp; Parent</th>
                    <th className="py-2.5 px-4">Category</th>
                    <th className="py-2.5 px-4">Normal</th>
                    <th className="py-2.5 px-4">Status</th>
                    <th className="py-2.5 px-4 text-right">Activity</th>
                    {canManageCoa && <th className="py-2.5 px-4 text-right">Actions</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredCoa.map((a) => (
                    <tr key={a.id} className={!a.active ? 'opacity-60' : ''}>
                      <td className="py-2.5 px-4 font-mono font-semibold text-slate-900">{a.code}</td>
                      <td className="py-2.5 px-4">
                        <div className="font-medium text-slate-900">
                          {a.parent_code ? <span className="text-slate-400 mr-1.5">↳</span> : null}
                          {a.name}
                        </div>
                        {(a.parent_code || a.description) && (
                          <div className="text-[11px] text-slate-500">
                            {a.parent_code ? `Parent: ${a.parent_code} · ${a.parent_name}` : ''}
                            {a.parent_code && a.description ? ' · ' : ''}
                            {a.description || ''}
                          </div>
                        )}
                      </td>
                      <td className="py-2.5 px-4 font-mono uppercase text-slate-600">{a.account_type}</td>
                      <td className="py-2.5 px-4 capitalize text-slate-600">{a.normal_balance}</td>
                      <td className="py-2.5 px-4 font-mono font-semibold">
                        <span className={a.active ? 'text-emerald-700' : 'text-slate-400'}>
                          {a.active ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                      <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-600">
                        {a.tx_count ?? 0} ref(s)
                      </td>
                      {canManageCoa && (
                        <td className="py-2.5 px-4 text-right whitespace-nowrap">
                          <div className="inline-flex items-center gap-1.5">
                            <button
                              onClick={() => openEditCoaModal(a)}
                              className="px-2 py-1 text-xs font-medium text-slate-700 border border-slate-200 hover:bg-slate-50 rounded"
                            >
                              Edit
                            </button>
                            <button
                              onClick={() => handleToggleCoa(a)}
                              className="px-2 py-1 text-xs font-medium text-amber-800 border border-amber-200 hover:bg-amber-50 rounded"
                            >
                              {a.active ? 'Deactivate' : 'Activate'}
                            </button>
                            <button
                              onClick={() => handleDeleteCoa(a)}
                              className="p-1 text-red-600 hover:text-red-800 border border-red-200 rounded"
                              title="Delete unused account"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* 3. PAYROLL PROCESSING */}
      {subTab === 'payroll' && overview && (
        <div className="space-y-4">
          {/* HR Submitted Monthly Inputs Banner */}
          {(overview.approvedHrSubmissions || []).length > 0 && (
            <div className="bg-white border border-slate-200 rounded-lg p-4">
              <div className="text-xs font-semibold text-slate-900 mb-2">HR-Submitted Monthly Payroll Inputs</div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
                {(overview.approvedHrSubmissions || []).slice(0, 6).map((s) => (
                  <div key={s.id} className="p-3 bg-slate-50 border border-slate-200 rounded flex items-center justify-between gap-2">
                    <div>
                      <div className="font-mono font-semibold text-teal-800">{s.pay_month}</div>
                      <div className="text-slate-600">
                        {s.total_employees} staff · OT ${Number(s.total_overtime_amount).toFixed(2)} · Earn $
                        {Number(s.total_extra_earnings).toFixed(2)} · Ded ${Number(s.total_extra_deductions).toFixed(2)}
                      </div>
                    </div>
                    <span className="font-mono uppercase text-[11px] font-semibold text-slate-700">{s.status}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="bg-white border border-slate-200 rounded-lg p-4 flex flex-wrap items-end justify-between gap-3">
            {canPayrollGen ? (
              <div className="flex flex-wrap items-end gap-3 text-xs">
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Payroll Month</label>
                  <input
                    type="month"
                    value={payMonth}
                    onChange={(e) => setPayMonth(e.target.value)}
                    className="px-3 py-1.5 border border-slate-300 rounded-md font-mono"
                  />
                </div>
                <button
                  onClick={handleGeneratePayroll}
                  className="px-4 py-1.5 text-white bg-teal-700 hover:bg-teal-800 rounded-md font-medium whitespace-nowrap"
                >
                  Generate Payroll Run
                </button>
                <button
                  onClick={() => setCompModalOpen(true)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-slate-700 border border-slate-200 hover:bg-slate-50 rounded-md font-medium"
                >
                  <Sliders className="w-3.5 h-3.5" />
                  <span>Payroll Components ({(overview.payrollComponents || []).length})</span>
                </button>
              </div>
            ) : (
              <div className="text-xs font-medium text-slate-700">Payroll Verification, Approval &amp; Disbursement</div>
            )}
            <div className="text-xs font-mono text-slate-500">
              Draft → Verify → Approve → Post GL (5100/2200/2210/2220) → Pay Staff (2200/Cash-Bank)
            </div>
          </div>

          {(overview.payrollRuns || []).map((run) => (
            <div key={run.id} className="bg-white border border-slate-200 rounded-lg overflow-hidden">
              <div className="px-5 py-3.5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3 text-xs">
                <div className="space-y-1">
                  <div>
                    <span className="font-mono font-semibold text-teal-800 mr-2">{run.run_number}</span>
                    <span className="font-semibold text-slate-900">Period {run.pay_month}</span>
                    <span className="ml-2 font-mono uppercase text-[11px] font-semibold text-slate-700">{run.status}</span>
                    <span className="mx-2 text-slate-300">·</span>
                    <span className="font-mono tabular-nums">
                      Gross ${Number(run.total_gross).toFixed(2)} · Ded ${Number(run.total_deductions).toFixed(2)} · Net $
                      {Number(run.total_net).toFixed(2)}
                    </span>
                  </div>
                  <div className="text-[11px] text-slate-500 font-mono">
                    Created: {run.created_by_name || '—'}
                    {run.verified_by_name ? ` · Verified: ${run.verified_by_name}` : ''}
                    {run.approved_by_name ? ` · Approved: ${run.approved_by_name}` : ''}
                    {run.journal_entry_number ? ` · Accrual JE: ${run.journal_entry_number}` : ''}
                    {run.payment_journal_entry_number ? ` · Batch Pay JE: ${run.payment_journal_entry_number}` : ''}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {run.status === 'draft' && canVerifyPayroll && (
                    <button
                      onClick={() => handlePayrollAction(run.id, 'verify')}
                      className="px-3 py-1.5 text-white bg-sky-700 hover:bg-sky-800 rounded font-medium"
                    >
                      Verify
                    </button>
                  )}
                  {(run.status === 'draft' || run.status === 'verified') && canApprovePayroll && (
                    <button
                      onClick={() => handlePayrollAction(run.id, 'approve')}
                      className="px-3 py-1.5 text-white bg-indigo-700 hover:bg-indigo-800 rounded font-medium"
                    >
                      Approve
                    </button>
                  )}
                  {(run.status === 'draft' || run.status === 'verified') && canApprovePayroll && (
                    <button
                      onClick={() => {
                        setRejectRunReason('');
                        setRejectRunTarget(run);
                      }}
                      className="px-3 py-1.5 text-red-700 border border-red-200 hover:bg-red-50 rounded font-medium"
                    >
                      Reject
                    </button>
                  )}
                  {run.status === 'approved' && canPostPayroll && (
                    <button
                      onClick={() => handlePayrollAction(run.id, 'post')}
                      className="px-3 py-1.5 text-white bg-emerald-700 hover:bg-emerald-800 rounded font-medium"
                    >
                      Post to GL
                    </button>
                  )}
                  {(run.status === 'posted' || run.status === 'partially_paid') && canPayPayroll && (
                    <button
                      onClick={() => handlePayrollAction(run.id, 'pay')}
                      className="px-3 py-1.5 text-white bg-teal-700 hover:bg-teal-800 rounded font-medium"
                    >
                      Pay All Remaining
                    </button>
                  )}
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-slate-500">
                      <th className="py-2 px-4">Employee</th>
                      <th className="py-2 px-4 text-right">Base</th>
                      <th className="py-2 px-4 text-right">Allow</th>
                      <th className="py-2 px-4 text-right">OT</th>
                      <th className="py-2 px-4 text-right">Bonus</th>
                      <th className="py-2 px-4 text-right">PAYE + Pen + Ded</th>
                      <th className="py-2 px-4 text-right">Net Pay</th>
                      <th className="py-2 px-4 text-right">Paid</th>
                      <th className="py-2 px-4 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {run.items.map((it) => {
                      const rem = Math.max(0, Number((Number(it.net_pay) - Number(it.paid_amount || 0)).toFixed(2)));
                      return (
                        <tr key={it.id}>
                          <td className="py-2 px-4">
                            <span className="font-medium text-slate-900">{it.staff_name}</span>
                            <span className="ml-1.5 font-mono text-slate-400">{it.role_code}</span>
                          </td>
                          <td className="py-2 px-4 text-right font-mono tabular-nums">${Number(it.base_salary).toFixed(2)}</td>
                          <td className="py-2 px-4 text-right font-mono tabular-nums">${Number(it.allowances).toFixed(2)}</td>
                          <td className="py-2 px-4 text-right font-mono tabular-nums">${Number(it.overtime_pay || 0).toFixed(2)}</td>
                          <td className="py-2 px-4 text-right font-mono tabular-nums">${Number(it.bonus_earnings || 0).toFixed(2)}</td>
                          <td className="py-2 px-4 text-right font-mono tabular-nums">${Number(it.tax_deduction).toFixed(2)}</td>
                          <td className="py-2 px-4 text-right font-mono font-semibold tabular-nums">${Number(it.net_pay).toFixed(2)}</td>
                          <td className="py-2 px-4 text-right font-mono tabular-nums">
                            <span className={it.payment_status === 'paid' ? 'text-emerald-700 font-semibold' : 'text-slate-600'}>
                              ${Number(it.paid_amount || 0).toFixed(2)}
                            </span>
                          </td>
                          <td className="py-2 px-4 text-right whitespace-nowrap">
                            <div className="inline-flex items-center gap-1.5">
                              {(run.status === 'draft' || run.status === 'verified') && canPayrollGen && (
                                <button
                                  onClick={() => {
                                    setEditPayItem(it);
                                    setEditAllow(String(it.allowances || 0));
                                    setEditOt(String(it.overtime_pay || 0));
                                    setEditBonus(String(it.bonus_earnings || 0));
                                    setEditOtherDed(String(it.other_deductions || 0));
                                  }}
                                  className="inline-flex items-center gap-1 px-2 py-1 text-slate-700 border border-slate-200 hover:bg-slate-50 rounded"
                                >
                                  <Edit3 className="w-3 h-3" />
                                  <span>Adjust</span>
                                </button>
                              )}
                              {(run.status === 'posted' || run.status === 'partially_paid') && rem > 0 && canPayPayroll && (
                                <button
                                  onClick={() => {
                                    setPayItemModal({ runId: run.id, item: it });
                                    setPayItemAmt(rem.toFixed(2));
                                    setPayItemCbId(cashBankAccounts[0] ? String(cashBankAccounts[0].id) : '');
                                    setPayItemRef('');
                                  }}
                                  className="px-2 py-1 text-white bg-teal-700 hover:bg-teal-800 rounded font-medium"
                                >
                                  Pay Salary
                                </button>
                              )}
                              <button
                                onClick={() =>
                                  setPrintTarget({ kind: 'payslip', item: it, runNumber: run.run_number, payMonth: run.pay_month })
                                }
                                className="inline-flex items-center gap-1 px-2 py-1 text-slate-700 border border-slate-200 hover:bg-slate-50 rounded"
                              >
                                <Printer className="w-3 h-3" />
                                <span>Payslip</span>
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 4. GRV MANAGEMENT */}
      {subTab === 'grvs' && overview && (
        <div className="space-y-6">
          {canGrv && (
            <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
              <div className="flex items-center gap-2 pb-2 border-b border-slate-100">
                <Package className="w-4 h-4 text-teal-700" />
                <h2 className="font-display text-sm font-semibold text-slate-900">
                  Register Goods Received Voucher (GRV)
                </h2>
              </div>
              <form onSubmit={handleCreateGrv} className="space-y-3 text-xs">
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                  <div>
                    <label className="block font-medium text-slate-700 mb-1">Supplier Name *</label>
                    <input
                      required
                      value={grvSupplier}
                      onChange={(e) => setGrvSupplier(e.target.value)}
                      placeholder="e.g. MedSupply Diagnostics Ltd"
                      className="w-full px-3 py-2 border border-slate-300 rounded-md"
                    />
                  </div>
                  <div>
                    <label className="block font-medium text-slate-700 mb-1">Supplier Invoice Ref #</label>
                    <input
                      value={grvInvRef}
                      onChange={(e) => setGrvInvRef(e.target.value)}
                      placeholder="Unique per supplier"
                      className="w-full px-3 py-2 border border-slate-300 rounded-md font-mono"
                    />
                  </div>
                  <div>
                    <label className="block font-medium text-slate-700 mb-1">Delivery Date</label>
                    <input
                      type="date"
                      value={grvDelDate}
                      onChange={(e) => setGrvDelDate(e.target.value)}
                      className="w-full px-2.5 py-2 border border-slate-300 rounded-md font-mono"
                    />
                  </div>
                  <div>
                    <label className="block font-medium text-slate-700 mb-1">Received Date *</label>
                    <input
                      type="date"
                      required
                      value={grvRecDate}
                      onChange={(e) => setGrvRecDate(e.target.value)}
                      className="w-full px-2.5 py-2 border border-slate-300 rounded-md font-mono"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
                  <div className="lg:col-span-2">
                    <label className="block font-medium text-slate-700 mb-1">Store Item (or select Create New)</label>
                    <select
                      value={grvItemId}
                      onChange={(e) => setGrvItemId(e.target.value)}
                      className="w-full px-2.5 py-2 border border-slate-300 rounded-md bg-white"
                    >
                      <option value="">+ Create New Store Item</option>
                      {(overview.storeItems || []).map((si) => (
                        <option key={si.id} value={si.id}>
                          {si.code} · {si.name} ({si.unit})
                        </option>
                      ))}
                    </select>
                  </div>
                  {!grvItemId && (
                    <>
                      <div>
                        <label className="block font-medium text-slate-700 mb-1">New Item Name *</label>
                        <input
                          required
                          value={grvNewName}
                          onChange={(e) => setGrvNewName(e.target.value)}
                          className="w-full px-3 py-2 border border-slate-300 rounded-md"
                        />
                      </div>
                      <div>
                        <label className="block font-medium text-slate-700 mb-1">Category</label>
                        <select
                          value={grvNewCat}
                          onChange={(e) => setGrvNewCat(e.target.value as typeof grvNewCat)}
                          className="w-full px-2.5 py-2 border border-slate-300 rounded-md bg-white"
                        >
                          <option value="consumable">Consumable</option>
                          <option value="medicine">Medicine</option>
                          <option value="reagent">Lab Reagent</option>
                        </select>
                      </div>
                    </>
                  )}
                  <div>
                    <label className="block font-medium text-slate-700 mb-1">Department</label>
                    <input
                      value={grvDept}
                      onChange={(e) => setGrvDept(e.target.value)}
                      className="w-full px-3 py-2 border border-slate-300 rounded-md"
                    />
                  </div>
                  <div>
                    <label className="block font-medium text-slate-700 mb-1">Attachment / Delivery Note Ref</label>
                    <input
                      value={grvAttach}
                      onChange={(e) => setGrvAttach(e.target.value)}
                      placeholder="DN-2026-01"
                      className="w-full px-3 py-2 border border-slate-300 rounded-md font-mono"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 items-end">
                  <div>
                    <label className="block font-medium text-slate-700 mb-1">Batch # *</label>
                    <input
                      required
                      value={grvBatch}
                      onChange={(e) => setGrvBatch(e.target.value)}
                      className="w-full px-3 py-2 border border-slate-300 rounded-md font-mono"
                    />
                  </div>
                  <div>
                    <label className="block font-medium text-slate-700 mb-1">Expiry Date *</label>
                    <input
                      type="date"
                      required
                      value={grvExpiry}
                      onChange={(e) => setGrvExpiry(e.target.value)}
                      className="w-full px-2.5 py-2 border border-slate-300 rounded-md font-mono"
                    />
                  </div>
                  <div>
                    <label className="block font-medium text-slate-700 mb-1">Quantity *</label>
                    <input
                      type="number"
                      min="1"
                      required
                      value={grvQty}
                      onChange={(e) => setGrvQty(e.target.value)}
                      className="w-full px-3 py-2 border border-slate-300 rounded-md font-mono"
                    />
                  </div>
                  <div>
                    <label className="block font-medium text-slate-700 mb-1">Unit Cost ($) *</label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      required
                      value={grvCost}
                      onChange={(e) => setGrvCost(e.target.value)}
                      className="w-full px-3 py-2 border border-slate-300 rounded-md font-mono"
                    />
                  </div>
                  <div>
                    <label className="block font-medium text-slate-700 mb-1">Notes</label>
                    <input
                      value={grvNotes}
                      onChange={(e) => setGrvNotes(e.target.value)}
                      placeholder="Optional"
                      className="w-full px-3 py-2 border border-slate-300 rounded-md"
                    />
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-100">
                  <label className="inline-flex items-center gap-2 text-slate-700 font-medium">
                    <input
                      type="checkbox"
                      checked={grvApproveNow}
                      onChange={(e) => setGrvApproveNow(e.target.checked)}
                    />
                    <span>Approve &amp; Post to Inventory + Supplier AP Immediately (Dr 1200 / Cr 2100)</span>
                  </label>
                  <button
                    type="submit"
                    className="px-4 py-2 bg-teal-700 hover:bg-teal-800 text-white rounded-md font-medium whitespace-nowrap"
                  >
                    Register GRV (${(Number(grvQty || 0) * Number(grvCost || 0)).toFixed(2)})
                  </button>
                </div>
              </form>
            </div>
          )}

          <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
              <h2 className="font-display text-sm font-semibold text-slate-900">Goods Received Vouchers Register</h2>
              <span className="text-xs font-mono text-slate-500">{(overview.grvs || []).length} GRVs</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-slate-500">
                    <th className="py-2.5 px-4">GRV #</th>
                    <th className="py-2.5 px-4">Dates &amp; Dept</th>
                    <th className="py-2.5 px-4">Supplier &amp; Invoice Ref</th>
                    <th className="py-2.5 px-4">Items</th>
                    <th className="py-2.5 px-4 text-right">Total Cost</th>
                    <th className="py-2.5 px-4">Approval &amp; AP Bill</th>
                    <th className="py-2.5 px-4 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {(overview.grvs || []).map((g) => (
                    <tr key={g.id}>
                      <td className="py-2.5 px-4 font-mono font-semibold text-teal-800">{g.grn_number}</td>
                      <td className="py-2.5 px-4 font-mono text-slate-600">
                        <div>{g.received_date || g.received_at?.slice(0, 10)}</div>
                        <div className="text-[11px] font-sans text-slate-500">{g.department_name || 'Main Store'}</div>
                      </td>
                      <td className="py-2.5 px-4">
                        <div className="font-medium text-slate-900">{g.supplier_name}</div>
                        <div className="font-mono text-[11px] text-slate-500">
                          {g.invoice_ref || 'No inv ref'} {g.attachment_ref ? `· ${g.attachment_ref}` : ''}
                        </div>
                      </td>
                      <td className="py-2.5 px-4 text-slate-600 max-w-xs">{g.items_summary || '—'}</td>
                      <td className="py-2.5 px-4 text-right font-mono tabular-nums font-semibold">
                        ${Number(g.total_cost).toFixed(2)}
                      </td>
                      <td className="py-2.5 px-4 font-mono">
                        <span
                          className={`capitalize font-semibold ${
                            g.approval_status === 'approved'
                              ? 'text-emerald-700'
                              : g.approval_status === 'rejected'
                                ? 'text-red-700'
                                : 'text-amber-700'
                          }`}
                        >
                          {g.approval_status}
                        </span>
                        {g.bill_number && (
                          <div className="text-[11px] text-slate-500">
                            {g.bill_number} ({g.bill_status})
                          </div>
                        )}
                      </td>
                      <td className="py-2.5 px-4 text-right">
                        {canGrv && g.approval_status === 'pending' && (
                          <div className="inline-flex items-center gap-1.5">
                            <button
                              onClick={() => handleDecideGrv(g.id, 'approved')}
                              className="px-2.5 py-1 text-white bg-emerald-700 hover:bg-emerald-800 rounded font-medium"
                            >
                              Approve &amp; Post
                            </button>
                            <button
                              onClick={() => handleDecideGrv(g.id, 'rejected')}
                              className="px-2.5 py-1 text-red-700 border border-red-200 hover:bg-red-50 rounded font-medium"
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

      {/* 5. EXPENSE VOUCHERS */}
      {subTab === 'expenses' && overview && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="bg-white border border-slate-200 rounded-lg p-4">
              <div className="text-xs text-slate-500">Disbursed Operational Expenses</div>
              <div className="font-mono text-xl font-semibold text-slate-900 mt-1 tabular-nums">
                $
                {overview.expenseVouchers
                  .reduce((s, e) => s + Number(e.paid_amount || (e.status === 'paid' ? e.amount : 0)), 0)
                  .toFixed(2)}
              </div>
            </div>
            <div className="bg-white border border-slate-200 rounded-lg p-4">
              <div className="text-xs text-slate-500">Approved Payable / Pending Approval</div>
              <div className="font-mono text-xl font-semibold text-amber-700 mt-1 tabular-nums">
                {overview.expenseVouchers.filter((e) => ['pending', 'approved', 'partial'].includes(e.status)).length} voucher(s)
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
              <div className="flex flex-wrap items-center justify-between gap-2 mb-4 pb-2 border-b border-slate-100">
                <h2 className="font-display text-sm font-semibold text-slate-900">Record Expense Voucher</h2>
                <span className="text-xs font-mono text-slate-500">
                  Auto-Post Limit: ${Number(overview.expenseAutoPostLimit || 0).toFixed(2)}
                </span>
              </div>
              <form onSubmit={handleCreateExpense} className="space-y-3 text-xs">
                <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
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
                      value={expCategory}
                      onChange={(e) => setExpCategory(e.target.value)}
                      className="w-full px-3 py-2 border border-slate-300 rounded-md"
                    />
                  </div>
                  <div className="md:col-span-2">
                    <label className="block font-medium text-slate-700 mb-1">Expense GL Account *</label>
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
                <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
                  <div className="md:col-span-2">
                    <label className="block font-medium text-slate-700 mb-1">Payee / Vendor *</label>
                    <input
                      required
                      value={expPayee}
                      onChange={(e) => setExpPayee(e.target.value)}
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
                      className="w-full px-3 py-2 border border-slate-300 rounded-md font-mono"
                    />
                  </div>
                  <div>
                    <label className="block font-medium text-slate-700 mb-1">Payment Method</label>
                    <select
                      value={expMethod}
                      onChange={(e) => setExpMethod(e.target.value as 'bank_transfer' | 'cash')}
                      className="w-full px-2.5 py-2 border border-slate-300 rounded-md bg-white"
                    >
                      <option value="bank_transfer">Bank Transfer</option>
                      <option value="cash">Petty Cash</option>
                    </select>
                  </div>
                  <div>
                    <label className="block font-medium text-slate-700 mb-1">Cash/Bank Account</label>
                    <select
                      value={expCbId}
                      onChange={(e) => setExpCbId(e.target.value)}
                      className="w-full px-2.5 py-2 border border-slate-300 rounded-md bg-white"
                    >
                      <option value="">Default Account</option>
                      {cashBankAccounts.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.account_name} (${Number(c.current_balance).toFixed(2)})
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                  <div>
                    <label className="block font-medium text-slate-700 mb-1">Invoice / Ref #</label>
                    <input
                      value={expRefNo}
                      onChange={(e) => setExpRefNo(e.target.value)}
                      className="w-full px-3 py-2 border border-slate-300 rounded-md font-mono"
                    />
                  </div>
                  <div>
                    <label className="block font-medium text-slate-700 mb-1">Attachment Ref</label>
                    <input
                      value={expAttach}
                      onChange={(e) => setExpAttach(e.target.value)}
                      className="w-full px-3 py-2 border border-slate-300 rounded-md font-mono"
                    />
                  </div>
                  <div className="md:col-span-2">
                    <label className="block font-medium text-slate-700 mb-1">Description *</label>
                    <input
                      required
                      value={expDesc}
                      onChange={(e) => setExpDesc(e.target.value)}
                      className="w-full px-3 py-2 border border-slate-300 rounded-md"
                    />
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-100">
                  <label className="inline-flex items-center gap-2 text-slate-700 font-medium">
                    <input type="checkbox" checked={expAutoPost} onChange={(e) => setExpAutoPost(e.target.checked)} />
                    <span>Auto-post &amp; pay immediately if within approval limit (uncheck to route as Pending)</span>
                  </label>
                  <button
                    type="submit"
                    className="px-4 py-2 bg-teal-700 hover:bg-teal-800 text-white rounded-md font-medium whitespace-nowrap"
                  >
                    Submit Expense Voucher
                  </button>
                </div>
              </form>
            </div>
          )}

          <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-slate-500">
                    <th className="py-2.5 px-4">Voucher #</th>
                    <th className="py-2.5 px-4">Date</th>
                    <th className="py-2.5 px-4">Payee &amp; Description</th>
                    <th className="py-2.5 px-4">GL Account</th>
                    <th className="py-2.5 px-4 text-right">Amount / Paid</th>
                    <th className="py-2.5 px-4">Status</th>
                    <th className="py-2.5 px-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {overview.expenseVouchers.map((ev) => {
                    const paid = Number(ev.paid_amount ?? (ev.status === 'paid' ? ev.amount : 0));
                    const rem = Math.max(0, Number((Number(ev.amount) - paid).toFixed(2)));
                    return (
                      <tr key={ev.id}>
                        <td className="py-2.5 px-4 font-mono font-semibold text-slate-900">{ev.voucher_number}</td>
                        <td className="py-2.5 px-4 font-mono text-slate-600">{ev.expense_date}</td>
                        <td className="py-2.5 px-4">
                          <div className="font-medium text-slate-900">
                            {ev.payee_name} · <span className="text-slate-500 font-normal">{ev.category}</span>
                          </div>
                          <div className="text-slate-500">
                            {ev.description} {ev.reference_number ? `· Ref ${ev.reference_number}` : ''}
                          </div>
                        </td>
                        <td className="py-2.5 px-4 font-mono text-slate-600">
                          {ev.account_code} · {ev.account_name}
                        </td>
                        <td className="py-2.5 px-4 text-right font-mono tabular-nums">
                          <div className="font-semibold text-slate-900">${Number(ev.amount).toFixed(2)}</div>
                          <div className="text-[11px] text-slate-500">Paid: ${paid.toFixed(2)}</div>
                        </td>
                        <td className="py-2.5 px-4 font-mono capitalize font-semibold">
                          <span
                            className={
                              ev.status === 'paid'
                                ? 'text-emerald-700'
                                : ev.status === 'rejected'
                                  ? 'text-red-700'
                                  : 'text-amber-700'
                            }
                          >
                            {ev.status}
                          </span>
                        </td>
                        <td className="py-2.5 px-4 text-right whitespace-nowrap">
                          <div className="inline-flex items-center gap-1.5">
                            {canApproveExpense && ev.status === 'pending' && (
                              <>
                                <button
                                  onClick={() => handleDecideExpense(ev.id, 'approved')}
                                  className="px-2 py-1 text-indigo-800 border border-indigo-200 hover:bg-indigo-50 rounded font-medium"
                                >
                                  Approve Payable
                                </button>
                                <button
                                  onClick={() => handleDecideExpense(ev.id, 'paid')}
                                  className="px-2 py-1 text-white bg-emerald-700 hover:bg-emerald-800 rounded font-medium"
                                >
                                  Approve &amp; Pay
                                </button>
                                <button
                                  onClick={() => handleDecideExpense(ev.id, 'rejected')}
                                  className="px-2 py-1 text-red-700 border border-red-200 hover:bg-red-50 rounded"
                                >
                                  Reject
                                </button>
                              </>
                            )}
                            {canPay && (ev.status === 'approved' || ev.status === 'partial') && rem > 0 && (
                              <button
                                onClick={() => {
                                  setExpPayModal(ev);
                                  setExpPayAmt(rem.toFixed(2));
                                  setExpPayCbId(cashBankAccounts[0] ? String(cashBankAccounts[0].id) : '');
                                  setExpPayRef('');
                                }}
                                className="px-2.5 py-1 text-white bg-teal-700 hover:bg-teal-800 rounded font-medium"
                              >
                                Disburse (${rem.toFixed(2)})
                              </button>
                            )}
                            <button
                              onClick={() => setPrintTarget({ kind: 'expense', expense: ev })}
                              className="inline-flex items-center gap-1 px-2 py-1 text-slate-700 border border-slate-200 hover:bg-slate-50 rounded"
                            >
                              <Printer className="w-3 h-3" />
                              <span>Print</span>
                            </button>
                          </div>
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

      {/* 6. GENERAL PAYMENTS & RECEIPTS */}
      {subTab === 'payments' && overview && (
        <div className="space-y-4">
          <div className="bg-white border border-slate-200 rounded-lg p-3.5 flex items-center justify-between">
            <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg text-xs">
              <button
                onClick={() => setPmtSubMode('payments')}
                className={`px-3 py-1.5 rounded-md font-medium transition-colors ${
                  pmtSubMode === 'payments' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
                }`}
              >
                General Payments ({(overview.financePayments || []).length})
              </button>
              <button
                onClick={() => setPmtSubMode('receipts')}
                className={`px-3 py-1.5 rounded-md font-medium transition-colors ${
                  pmtSubMode === 'receipts' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
                }`}
              >
                General Receipts ({(overview.financeReceipts || []).length})
              </button>
            </div>
            <div className="text-xs font-mono text-slate-500">
              {pmtSubMode === 'payments' ? 'Voucher series FPV · Credits Cash/Bank' : 'Voucher series FRV · Debits Cash/Bank'}
            </div>
          </div>

          {pmtSubMode === 'payments' ? (
            <>
              {canPay && (
                <div className="bg-white border border-slate-200 rounded-lg p-5">
                  <div className="flex items-center gap-2 mb-3 pb-2 border-b border-slate-100">
                    <Wallet className="w-4 h-4 text-teal-700" />
                    <h2 className="font-display text-sm font-semibold text-slate-900">Record General Payment Voucher (FPV)</h2>
                  </div>
                  <form onSubmit={handleCreateGeneralPayment} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs items-end">
                    <div>
                      <label className="block font-medium text-slate-700 mb-1">Link Payable (Optional)</label>
                      <select
                        value={gpLinked}
                        onChange={(e) => {
                          const val = e.target.value;
                          setGpLinked(val);
                          if (val.startsWith('supplier_bill:')) {
                            const bill = openBills.find((b) => String(b.id) === val.split(':')[1]);
                            if (bill) {
                              setGpCat('supplier');
                              setGpPayee(bill.supplier_name);
                              setGpAmount((Number(bill.total_amount) - Number(bill.paid_amount)).toFixed(2));
                              setGpRef(bill.bill_number);
                            }
                          } else if (val.startsWith('expense:')) {
                            const ev = payableExpenses.find((x) => String(x.id) === val.split(':')[1]);
                            if (ev) {
                              setGpCat('expense');
                              setGpPayee(ev.payee_name);
                              setGpAmount((Number(ev.amount) - Number(ev.paid_amount || 0)).toFixed(2));
                              setGpRef(ev.voucher_number);
                            }
                          }
                        }}
                        className="w-full px-2.5 py-2 border border-slate-300 rounded-md bg-white"
                      >
                        <option value="">Standalone / Unlinked Payment</option>
                        {openBills.map((b) => (
                          <option key={`sb-${b.id}`} value={`supplier_bill:${b.id}`}>
                            AP {b.bill_number} · {b.supplier_name} (Due ${(Number(b.total_amount) - Number(b.paid_amount)).toFixed(2)})
                          </option>
                        ))}
                        {payableExpenses.map((ev) => (
                          <option key={`ev-${ev.id}`} value={`expense:${ev.id}`}>
                            EXP {ev.voucher_number} · {ev.payee_name} (Due ${(Number(ev.amount) - Number(ev.paid_amount || 0)).toFixed(2)})
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block font-medium text-slate-700 mb-1">Payment Date *</label>
                      <input
                        type="date"
                        required
                        value={gpDate}
                        onChange={(e) => setGpDate(e.target.value)}
                        className="w-full px-2.5 py-2 border border-slate-300 rounded-md font-mono"
                      />
                    </div>
                    <div>
                      <label className="block font-medium text-slate-700 mb-1">Category *</label>
                      <select
                        value={gpCat}
                        onChange={(e) => setGpCat(e.target.value)}
                        className="w-full px-2.5 py-2 border border-slate-300 rounded-md bg-white"
                      >
                        <option value="supplier">Supplier Payment</option>
                        <option value="expense">Expense Settlement</option>
                        <option value="utility">Utility Payment</option>
                        <option value="rent">Rent / Lease</option>
                        <option value="salary">Salary / Contractor</option>
                        <option value="other">Other Disbursement</option>
                      </select>
                    </div>
                    <div>
                      <label className="block font-medium text-slate-700 mb-1">Payee Name *</label>
                      <input
                        required
                        value={gpPayee}
                        onChange={(e) => setGpPayee(e.target.value)}
                        className="w-full px-3 py-2 border border-slate-300 rounded-md"
                      />
                    </div>
                    <div>
                      <label className="block font-medium text-slate-700 mb-1">Cash / Bank Account *</label>
                      <select
                        required
                        value={gpCbId}
                        onChange={(e) => setGpCbId(e.target.value)}
                        className="w-full px-2.5 py-2 border border-slate-300 rounded-md bg-white"
                      >
                        {cashBankAccounts.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.account_name} (${Number(c.current_balance).toFixed(2)})
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block font-medium text-slate-700 mb-1">Method</label>
                      <select
                        value={gpMethod}
                        onChange={(e) => setGpMethod(e.target.value as 'bank_transfer' | 'cash')}
                        className="w-full px-2.5 py-2 border border-slate-300 rounded-md bg-white"
                      >
                        <option value="bank_transfer">Bank Transfer / Cheque</option>
                        <option value="cash">Cash</option>
                      </select>
                    </div>
                    <div>
                      <label className="block font-medium text-slate-700 mb-1">Amount ($) *</label>
                      <input
                        type="number"
                        step="0.01"
                        min="0.01"
                        required
                        value={gpAmount}
                        onChange={(e) => setGpAmount(e.target.value)}
                        className="w-full px-3 py-2 border border-slate-300 rounded-md font-mono"
                      />
                    </div>
                    <div>
                      <label className="block font-medium text-slate-700 mb-1">Debit GL Account (if unlinked)</label>
                      <select
                        disabled={Boolean(gpLinked)}
                        value={gpDebitCoa}
                        onChange={(e) => setGpDebitCoa(e.target.value)}
                        className="w-full px-2.5 py-2 border border-slate-300 rounded-md bg-white disabled:bg-slate-100"
                      >
                        {activeAccounts.map((a) => (
                          <option key={a.code} value={a.code}>
                            {a.code} · {a.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block font-medium text-slate-700 mb-1">Reference #</label>
                      <input
                        value={gpRef}
                        onChange={(e) => setGpRef(e.target.value)}
                        className="w-full px-3 py-2 border border-slate-300 rounded-md font-mono"
                      />
                    </div>
                    <div>
                      <label className="block font-medium text-slate-700 mb-1">Attachment Ref</label>
                      <input
                        value={gpAttach}
                        onChange={(e) => setGpAttach(e.target.value)}
                        className="w-full px-3 py-2 border border-slate-300 rounded-md font-mono"
                      />
                    </div>
                    <div>
                      <label className="block font-medium text-slate-700 mb-1">Notes</label>
                      <input
                        value={gpNotes}
                        onChange={(e) => setGpNotes(e.target.value)}
                        className="w-full px-3 py-2 border border-slate-300 rounded-md"
                      />
                    </div>
                    <div>
                      <button
                        type="submit"
                        className="w-full px-4 py-2 bg-teal-700 hover:bg-teal-800 text-white rounded-md font-medium"
                      >
                        Post Payment Voucher
                      </button>
                    </div>
                  </form>
                </div>
              )}

              <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50 text-slate-500">
                        <th className="py-2.5 px-4">Voucher #</th>
                        <th className="py-2.5 px-4">Date</th>
                        <th className="py-2.5 px-4">Payee &amp; Category</th>
                        <th className="py-2.5 px-4">Account &amp; Method</th>
                        <th className="py-2.5 px-4">GL / Ref</th>
                        <th className="py-2.5 px-4 text-right">Amount</th>
                        <th className="py-2.5 px-4 text-right">Voucher</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {(overview.financePayments || []).map((fp) => (
                        <tr key={fp.id}>
                          <td className="py-2.5 px-4 font-mono font-semibold text-teal-800">{fp.payment_number}</td>
                          <td className="py-2.5 px-4 font-mono">{fp.payment_date}</td>
                          <td className="py-2.5 px-4">
                            <div className="font-medium text-slate-900">{fp.payee_name}</div>
                            <div className="text-slate-500 capitalize">{fp.payment_category}</div>
                          </td>
                          <td className="py-2.5 px-4">
                            <div>{fp.cash_bank_account_name}</div>
                            <div className="text-[11px] font-mono text-slate-500">{fp.payment_method}</div>
                          </td>
                          <td className="py-2.5 px-4 font-mono text-slate-600">
                            {fp.journal_entry_number || '—'} {fp.reference_no ? `· ${fp.reference_no}` : ''}
                          </td>
                          <td className="py-2.5 px-4 text-right font-mono tabular-nums font-semibold">
                            ${Number(fp.amount).toFixed(2)}
                          </td>
                          <td className="py-2.5 px-4 text-right">
                            <button
                              onClick={() => setPrintTarget({ kind: 'payment', payment: fp })}
                              className="inline-flex items-center gap-1 px-2 py-1 text-slate-700 border border-slate-200 hover:bg-slate-50 rounded"
                            >
                              <Printer className="w-3 h-3" />
                              <span>Print</span>
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          ) : (
            <>
              {canReceipt && (
                <div className="bg-white border border-slate-200 rounded-lg p-5">
                  <div className="flex items-center gap-2 mb-3 pb-2 border-b border-slate-100">
                    <Wallet className="w-4 h-4 text-teal-700" />
                    <h2 className="font-display text-sm font-semibold text-slate-900">Record General Receipt Voucher (FRV)</h2>
                  </div>
                  <form onSubmit={handleCreateGeneralReceipt} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs items-end">
                    <div>
                      <label className="block font-medium text-slate-700 mb-1">Receipt Date *</label>
                      <input
                        type="date"
                        required
                        value={grDate}
                        onChange={(e) => setGrDate(e.target.value)}
                        className="w-full px-2.5 py-2 border border-slate-300 rounded-md font-mono"
                      />
                    </div>
                    <div>
                      <label className="block font-medium text-slate-700 mb-1">Income Category *</label>
                      <select
                        value={grCat}
                        onChange={(e) => setGrCat(e.target.value)}
                        className="w-full px-2.5 py-2 border border-slate-300 rounded-md bg-white"
                      >
                        <option value="grant">Institutional Grant</option>
                        <option value="donation">Charitable Donation</option>
                        <option value="rental">Facility / Pharmacy Sublease</option>
                        <option value="miscellaneous">Miscellaneous Income</option>
                        <option value="refund_recovery">Supplier / Expense Refund</option>
                      </select>
                    </div>
                    <div>
                      <label className="block font-medium text-slate-700 mb-1">Payer Name *</label>
                      <input
                        required
                        value={grPayer}
                        onChange={(e) => setGrPayer(e.target.value)}
                        className="w-full px-3 py-2 border border-slate-300 rounded-md"
                      />
                    </div>
                    <div>
                      <label className="block font-medium text-slate-700 mb-1">Deposit Cash/Bank Account *</label>
                      <select
                        required
                        value={grCbId}
                        onChange={(e) => setGrCbId(e.target.value)}
                        className="w-full px-2.5 py-2 border border-slate-300 rounded-md bg-white"
                      >
                        {cashBankAccounts.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.account_name} (${Number(c.current_balance).toFixed(2)})
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block font-medium text-slate-700 mb-1">Method</label>
                      <select
                        value={grMethod}
                        onChange={(e) => setGrMethod(e.target.value as 'bank_transfer' | 'cash')}
                        className="w-full px-2.5 py-2 border border-slate-300 rounded-md bg-white"
                      >
                        <option value="bank_transfer">Bank Transfer</option>
                        <option value="cash">Cash</option>
                      </select>
                    </div>
                    <div>
                      <label className="block font-medium text-slate-700 mb-1">Amount ($) *</label>
                      <input
                        type="number"
                        step="0.01"
                        min="0.01"
                        required
                        value={grAmount}
                        onChange={(e) => setGrAmount(e.target.value)}
                        className="w-full px-3 py-2 border border-slate-300 rounded-md font-mono"
                      />
                    </div>
                    <div>
                      <label className="block font-medium text-slate-700 mb-1">Credit GL Revenue Account</label>
                      <select
                        value={grCreditCoa}
                        onChange={(e) => setGrCreditCoa(e.target.value)}
                        className="w-full px-2.5 py-2 border border-slate-300 rounded-md bg-white"
                      >
                        {(revenueAccounts.length > 0 ? revenueAccounts : activeAccounts).map((a) => (
                          <option key={a.code} value={a.code}>
                            {a.code} · {a.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block font-medium text-slate-700 mb-1">Reference #</label>
                      <input
                        value={grRef}
                        onChange={(e) => setGrRef(e.target.value)}
                        className="w-full px-3 py-2 border border-slate-300 rounded-md font-mono"
                      />
                    </div>
                    <div className="lg:col-span-3">
                      <label className="block font-medium text-slate-700 mb-1">Notes</label>
                      <input
                        value={grNotes}
                        onChange={(e) => setGrNotes(e.target.value)}
                        className="w-full px-3 py-2 border border-slate-300 rounded-md"
                      />
                    </div>
                    <div>
                      <button
                        type="submit"
                        className="w-full px-4 py-2 bg-teal-700 hover:bg-teal-800 text-white rounded-md font-medium"
                      >
                        Record Receipt Voucher
                      </button>
                    </div>
                  </form>
                </div>
              )}

              <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50 text-slate-500">
                        <th className="py-2.5 px-4">Receipt #</th>
                        <th className="py-2.5 px-4">Date</th>
                        <th className="py-2.5 px-4">Payer &amp; Category</th>
                        <th className="py-2.5 px-4">Account &amp; Method</th>
                        <th className="py-2.5 px-4">GL / Ref</th>
                        <th className="py-2.5 px-4 text-right">Amount</th>
                        <th className="py-2.5 px-4 text-right">Voucher</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {(overview.financeReceipts || []).map((fr) => (
                        <tr key={fr.id}>
                          <td className="py-2.5 px-4 font-mono font-semibold text-teal-800">{fr.receipt_number}</td>
                          <td className="py-2.5 px-4 font-mono">{fr.receipt_date}</td>
                          <td className="py-2.5 px-4">
                            <div className="font-medium text-slate-900">{fr.payer_name}</div>
                            <div className="text-slate-500 capitalize">{fr.income_category}</div>
                          </td>
                          <td className="py-2.5 px-4">
                            <div>{fr.cash_bank_account_name}</div>
                            <div className="text-[11px] font-mono text-slate-500">{fr.payment_method}</div>
                          </td>
                          <td className="py-2.5 px-4 font-mono text-slate-600">
                            {fr.journal_entry_number || '—'} {fr.reference_no ? `· ${fr.reference_no}` : ''}
                          </td>
                          <td className="py-2.5 px-4 text-right font-mono tabular-nums font-semibold text-emerald-700">
                            ${Number(fr.amount).toFixed(2)}
                          </td>
                          <td className="py-2.5 px-4 text-right">
                            <button
                              onClick={() => setPrintTarget({ kind: 'receipt', receipt: fr })}
                              className="inline-flex items-center gap-1 px-2 py-1 text-slate-700 border border-slate-200 hover:bg-slate-50 rounded"
                            >
                              <Printer className="w-3 h-3" />
                              <span>Print</span>
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* 7. CASH & BANK MANAGEMENT */}
      {subTab === 'cashbank' && overview && (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-display text-sm font-semibold text-slate-900">Treasury, Cash &amp; Bank Accounts</h2>
            {canBank && (
              <button
                onClick={() => setCbModalOpen(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Add Cash / Bank Account</span>
              </button>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {cashBankAccounts.map((acc) => (
              <div key={acc.id} className="bg-white border border-slate-200 rounded-lg p-4 space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-mono uppercase text-teal-800 font-semibold">{acc.account_type}</span>
                  <span className="font-mono text-slate-500">GL {acc.coa_code}</span>
                </div>
                <div className="font-display text-sm font-semibold text-slate-900 flex items-center gap-2">
                  <Landmark className="w-4 h-4 text-slate-400" />
                  <span>{acc.account_name}</span>
                </div>
                <div className="text-xs text-slate-500 font-mono">
                  {acc.bank_name || 'Clinic Till'} {acc.account_number ? `· ${acc.account_number}` : ''}
                </div>
                <div className="pt-2 border-t border-slate-100 flex items-baseline justify-between">
                  <span className="text-xs text-slate-500">Current Balance</span>
                  <span className="font-mono text-lg font-semibold text-slate-900 tabular-nums">
                    ${Number(acc.current_balance).toFixed(2)}
                  </span>
                </div>
              </div>
            ))}
          </div>

          {canBank && cashBankAccounts.length >= 2 && (
            <div className="bg-white border border-slate-200 rounded-lg p-5">
              <div className="flex items-center gap-2 mb-3 pb-2 border-b border-slate-100">
                <ArrowRightLeft className="w-4 h-4 text-teal-700" />
                <h3 className="font-display text-sm font-semibold text-slate-900">Internal Cash ↔ Bank Fund Transfer (TRF)</h3>
              </div>
              <form onSubmit={handleTransferFunds} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3 text-xs items-end">
                <div>
                  <label className="block font-medium text-slate-700 mb-1">From Account *</label>
                  <select
                    required
                    value={trFromId}
                    onChange={(e) => setTrFromId(e.target.value)}
                    className="w-full px-2.5 py-2 border border-slate-300 rounded-md bg-white"
                  >
                    {cashBankAccounts.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.account_name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">To Account *</label>
                  <select
                    required
                    value={trToId}
                    onChange={(e) => setTrToId(e.target.value)}
                    className="w-full px-2.5 py-2 border border-slate-300 rounded-md bg-white"
                  >
                    {cashBankAccounts.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.account_name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Transfer Date *</label>
                  <input
                    type="date"
                    required
                    value={trDate}
                    onChange={(e) => setTrDate(e.target.value)}
                    className="w-full px-2.5 py-2 border border-slate-300 rounded-md font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Amount ($) *</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    required
                    value={trAmt}
                    onChange={(e) => setTrAmt(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-md font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Deposit Slip / Ref</label>
                  <input
                    value={trRef}
                    onChange={(e) => setTrRef(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-md font-mono"
                  />
                </div>
                <div>
                  <button
                    type="submit"
                    className="w-full px-4 py-2 bg-teal-700 hover:bg-teal-800 text-white rounded-md font-medium"
                  >
                    Post Transfer
                  </button>
                </div>
              </form>
            </div>
          )}

          <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200">
              <h3 className="font-display text-sm font-semibold text-slate-900">Internal Transfers Log</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-slate-500">
                    <th className="py-2.5 px-4">Transfer #</th>
                    <th className="py-2.5 px-4">Date</th>
                    <th className="py-2.5 px-4">From → To</th>
                    <th className="py-2.5 px-4">Ref &amp; GL</th>
                    <th className="py-2.5 px-4 text-right">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {(overview.cashBankTransfers || []).map((t) => (
                    <tr key={t.id}>
                      <td className="py-2.5 px-4 font-mono font-semibold text-teal-800">{t.transfer_number}</td>
                      <td className="py-2.5 px-4 font-mono">{t.transfer_date}</td>
                      <td className="py-2.5 px-4">
                        {t.from_account_name} → <strong>{t.to_account_name}</strong>
                      </td>
                      <td className="py-2.5 px-4 font-mono text-slate-500">
                        {t.journal_entry_number || '—'} {t.reference_no ? `· ${t.reference_no}` : ''}
                      </td>
                      <td className="py-2.5 px-4 text-right font-mono tabular-nums font-semibold">
                        ${Number(t.amount).toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* 8. GL & ACCOUNTING PERIODS */}
      {subTab === 'ledger' && overview && (
        <div className="space-y-4">
          <div className="bg-white border border-slate-200 rounded-lg p-4 flex flex-wrap items-center justify-between gap-4">
            <div className="space-y-1">
              <div className="text-xs font-semibold text-slate-900 flex items-center gap-1.5">
                <Lock className="w-3.5 h-3.5 text-teal-700" />
                <span>Accounting Periods (Closed Periods Block Back-Dated Postings)</span>
              </div>
              <div className="flex flex-wrap gap-2 text-[11px] font-mono">
                {(overview.periods || []).length === 0 ? (
                  <span className="text-slate-500">All periods currently open</span>
                ) : (
                  (overview.periods || []).map((p) => (
                    <span
                      key={p.id}
                      className={p.status === 'closed' ? 'text-slate-700 font-semibold' : 'text-emerald-700 font-semibold'}
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
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-md"
                >
                  <Lock className="w-3.5 h-3.5" />
                  <span>{closingPeriod ? 'Closing...' : 'Close & Lock Period'}</span>
                </button>
              </form>
            )}
          </div>

          <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
              <h2 className="font-display text-sm font-semibold text-slate-900">Posted General Ledger Journals</h2>
              <span className="text-xs font-mono text-slate-500">{overview.journals.length} entries</span>
            </div>
            <div className="divide-y divide-slate-200">
              {overview.journals.map((je) => {
                const isAlreadyReversed = overview.journals.some((other) => other.reversal_of_id === je.id);
                const canReverseThis = canReverseJournal && !je.reversal_of_id && !isAlreadyReversed;
                return (
                  <div key={je.id} className="p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2 mb-2 text-xs">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono font-semibold text-teal-800">{je.entry_number}</span>
                        <span className="font-mono text-slate-500">{je.entry_date}</span>
                        <span className="uppercase font-mono text-[11px] text-slate-600">{je.source_type}</span>
                        <span className="font-medium text-slate-900">{je.description}</span>
                        {je.reversal_of_id && <span className="font-mono text-amber-800 font-semibold">[Reversal]</span>}
                        {isAlreadyReversed && <span className="font-mono text-slate-500">[Reversed]</span>}
                      </div>
                      <div className="flex items-center gap-3 font-mono tabular-nums text-slate-600">
                        <span>
                          Dr ${Number(je.total_debit).toFixed(2)} / Cr ${Number(je.total_credit).toFixed(2)}
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
                            <td className="py-1.5 px-3 text-right font-mono tabular-nums">
                              {Number(ln.debit) > 0 ? `$${Number(ln.debit).toFixed(2)}` : '—'}
                            </td>
                            <td className="py-1.5 px-3 text-right font-mono tabular-nums">
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

      {/* 9. AR & AP */}
      {subTab === 'arap' && overview && (
        <div className="space-y-6">
          {overview.unclaimedCreditInvoices.length > 0 && (
            <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
              <div className="px-5 py-3.5 border-b border-slate-200">
                <h2 className="font-display text-sm font-semibold text-slate-900">Unbatched Credit / Insurance Invoices</h2>
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
                            className="px-2.5 py-1 text-white bg-teal-700 hover:bg-teal-800 rounded font-medium"
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
              <h2 className="font-display text-sm font-semibold text-slate-900">Insurance Accounts Receivable Claims</h2>
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
                      <td className="py-2.5 px-4">{clm.payer_name}</td>
                      <td className="py-2.5 px-4">
                        {clm.first_name} {clm.last_name} · <span className="font-mono text-slate-500">{clm.invoice_number}</span>
                      </td>
                      <td className="py-2.5 px-4 font-mono">
                        {clm.age_days ?? 0}d ({clm.age_bucket})
                      </td>
                      <td className="py-2.5 px-4 text-right font-mono tabular-nums">${Number(clm.billed_amount).toFixed(2)}</td>
                      <td className="py-2.5 px-4 text-right font-mono tabular-nums">${Number(clm.settled_amount).toFixed(2)}</td>
                      <td className="py-2.5 px-4 capitalize font-medium">{clm.status}</td>
                      <td className="py-2.5 px-4 text-right">
                        {canManage && clm.status !== 'settled' && (
                          <button
                            onClick={() => handleSettleClaim(clm)}
                            className="px-2.5 py-1 text-teal-800 border border-teal-200 bg-teal-50 hover:bg-teal-100 rounded font-medium"
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

          <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200">
              <h2 className="font-display text-sm font-semibold text-slate-900">Supplier Accounts Payable Bills</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-slate-500">
                    <th className="py-2.5 px-4">Bill #</th>
                    <th className="py-2.5 px-4">Supplier</th>
                    <th className="py-2.5 px-4">GRN / Ref</th>
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
                      <td className="py-2.5 px-4">{b.supplier_name}</td>
                      <td className="py-2.5 px-4 font-mono text-slate-600">
                        {b.grn_number || 'Direct'} {b.invoice_ref ? `· ${b.invoice_ref}` : ''}
                      </td>
                      <td className="py-2.5 px-4 font-mono">{b.due_date}</td>
                      <td className="py-2.5 px-4 text-right font-mono tabular-nums">${Number(b.total_amount).toFixed(2)}</td>
                      <td className="py-2.5 px-4 text-right font-mono tabular-nums">${Number(b.paid_amount).toFixed(2)}</td>
                      <td className="py-2.5 px-4 capitalize font-medium">{b.status}</td>
                      <td className="py-2.5 px-4 text-right">
                        {canManage && b.status !== 'paid' && (
                          <button
                            onClick={() => handlePaySupplierBill(b)}
                            className="px-2.5 py-1 text-white bg-teal-700 hover:bg-teal-800 rounded font-medium"
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
        </div>
      )}

      {/* 10. FINANCIAL REPORTS */}
      {subTab === 'reports' && (
        <div className="space-y-4">
          <div className="bg-white border border-slate-200 rounded-lg p-4 flex flex-wrap items-end justify-between gap-4 no-print">
            <div className="flex flex-wrap items-end gap-3 text-xs">
              <div>
                <label className="block font-medium text-slate-700 mb-1">Report Template</label>
                <select
                  value={reportType}
                  onChange={(e) => setReportType(e.target.value as ReportType)}
                  className="px-3 py-1.5 border border-slate-300 rounded-md bg-white"
                >
                  {(Object.keys(REPORT_LABELS) as ReportType[]).map((key) => (
                    <option key={key} value={key}>
                      {REPORT_LABELS[key]}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">From</label>
                <input
                  type="date"
                  value={fromDate}
                  onChange={(e) => setFromDate(e.target.value)}
                  className="px-2.5 py-1.5 border border-slate-300 rounded-md font-mono"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">To</label>
                <input
                  type="date"
                  value={toDate}
                  onChange={(e) => setToDate(e.target.value)}
                  className="px-2.5 py-1.5 border border-slate-300 rounded-md font-mono"
                />
              </div>
              <button
                onClick={loadReport}
                className="px-3 py-1.5 text-white bg-teal-700 hover:bg-teal-800 rounded-md font-medium whitespace-nowrap"
              >
                Run Report
              </button>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={exportReportCsv}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-200 hover:bg-slate-50 rounded-md"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Export CSV</span>
              </button>
              <button
                onClick={() => window.print()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-200 hover:bg-slate-50 rounded-md"
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
                          <td key={k} className="py-2 px-4 font-mono text-slate-800 whitespace-nowrap tabular-nums">
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

      {/* MODALS */}
      {coaModalOpen && overview && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4 no-print">
          <div className="bg-white border border-slate-200 rounded-lg w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-display text-base font-semibold text-slate-900">
                {editingCoa ? `Edit COA Account · ${editingCoa.code}` : 'New Chart of Accounts Entry'}
              </h3>
              <button onClick={() => setCoaModalOpen(false)} className="text-slate-400 hover:text-slate-600">
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleSaveCoa} className="space-y-3 text-xs">
              {!editingCoa && (
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Account Code *</label>
                  <input
                    required
                    value={coaCode}
                    onChange={(e) => setCoaCode(e.target.value)}
                    placeholder="e.g. 5240"
                    className="w-full px-3 py-2 border border-slate-300 rounded-md font-mono"
                  />
                </div>
              )}
              <div>
                <label className="block font-medium text-slate-700 mb-1">Account Name *</label>
                <input
                  required
                  value={coaName}
                  onChange={(e) => setCoaName(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-md"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Category *</label>
                  <select
                    value={coaType}
                    onChange={(e) => {
                      const t = e.target.value as ChartAccount['account_type'];
                      setCoaType(t);
                      setCoaNormal(t === 'asset' || t === 'expense' ? 'debit' : 'credit');
                    }}
                    className="w-full px-2.5 py-2 border border-slate-300 rounded-md bg-white"
                  >
                    <option value="asset">Asset</option>
                    <option value="liability">Liability</option>
                    <option value="equity">Equity</option>
                    <option value="revenue">Revenue</option>
                    <option value="expense">Expense</option>
                  </select>
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Normal Balance</label>
                  <select
                    value={coaNormal}
                    onChange={(e) => setCoaNormal(e.target.value as 'debit' | 'credit')}
                    className="w-full px-2.5 py-2 border border-slate-300 rounded-md bg-white"
                  >
                    <option value="debit">Debit</option>
                    <option value="credit">Credit</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Parent Account (Optional)</label>
                <select
                  value={coaParentId}
                  onChange={(e) => setCoaParentId(e.target.value)}
                  className="w-full px-2.5 py-2 border border-slate-300 rounded-md bg-white"
                >
                  <option value="">Top-Level Account</option>
                  {overview.accounts
                    .filter((a) => !editingCoa || a.id !== editingCoa.id)
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.code} · {a.name}
                      </option>
                    ))}
                </select>
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Description</label>
                <input
                  value={coaDesc}
                  onChange={(e) => setCoaDesc(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-md"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setCoaModalOpen(false)} className="px-3 py-1.5 border border-slate-200 rounded-md">
                  Cancel
                </button>
                <button type="submit" className="px-4 py-1.5 bg-teal-700 hover:bg-teal-800 text-white rounded-md font-medium">
                  Save Account
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {compModalOpen && overview && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4 no-print">
          <div className="bg-white border border-slate-200 rounded-lg w-full max-w-2xl max-h-[90vh] overflow-y-auto p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-display text-base font-semibold text-slate-900">Payroll Earnings &amp; Deductions Setup</h3>
              <button onClick={() => setCompModalOpen(false)} className="text-slate-400 hover:text-slate-600">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="border border-slate-200 rounded overflow-hidden">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-slate-500">
                    <th className="py-2 px-3">Code</th>
                    <th className="py-2 px-3">Name</th>
                    <th className="py-2 px-3">Type</th>
                    <th className="py-2 px-3">Method</th>
                    <th className="py-2 px-3">GL</th>
                    <th className="py-2 px-3 text-right">Default</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {(overview.payrollComponents || []).map((pc) => (
                    <tr key={pc.id}>
                      <td className="py-2 px-3 font-mono font-semibold">{pc.code}</td>
                      <td className="py-2 px-3">{pc.name}</td>
                      <td className="py-2 px-3 capitalize">{pc.component_type}</td>
                      <td className="py-2 px-3 capitalize">{pc.calc_method}</td>
                      <td className="py-2 px-3 font-mono">{pc.account_code}</td>
                      <td className="py-2 px-3 text-right font-mono tabular-nums">{pc.default_value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <form onSubmit={handleSavePayrollComponent} className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs pt-2 border-t border-slate-200">
              <input
                required
                value={compCode}
                onChange={(e) => setCompCode(e.target.value)}
                placeholder="Code (e.g. MEAL)"
                className="px-2.5 py-2 border border-slate-300 rounded font-mono"
              />
              <input
                required
                value={compName}
                onChange={(e) => setCompName(e.target.value)}
                placeholder="Component Name"
                className="px-2.5 py-2 border border-slate-300 rounded"
              />
              <select
                value={compType}
                onChange={(e) => setCompType(e.target.value as 'earning' | 'deduction')}
                className="px-2.5 py-2 border border-slate-300 rounded bg-white"
              >
                <option value="earning">Earning</option>
                <option value="deduction">Deduction</option>
              </select>
              <select
                value={compCalc}
                onChange={(e) => setCompCalc(e.target.value as 'fixed' | 'percentage' | 'manual')}
                className="px-2.5 py-2 border border-slate-300 rounded bg-white"
              >
                <option value="fixed">Fixed Amount</option>
                <option value="percentage">Percentage</option>
                <option value="manual">Manual Per Employee</option>
              </select>
              <input
                type="number"
                step="0.01"
                value={compVal}
                onChange={(e) => setCompVal(e.target.value)}
                placeholder="Default Value"
                className="px-2.5 py-2 border border-slate-300 rounded font-mono"
              />
              <select
                value={compCoa}
                onChange={(e) => setCompCoa(e.target.value)}
                className="px-2.5 py-2 border border-slate-300 rounded bg-white"
              >
                {activeAccounts.map((a) => (
                  <option key={a.code} value={a.code}>
                    {a.code} · {a.name}
                  </option>
                ))}
              </select>
              <div className="col-span-2 sm:col-span-3 flex justify-end">
                <button type="submit" className="px-4 py-1.5 bg-teal-700 hover:bg-teal-800 text-white rounded-md font-medium">
                  Add Component
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {editPayItem && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4 no-print">
          <div className="bg-white border border-slate-200 rounded-lg w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-display text-base font-semibold text-slate-900">
                Adjust Employee Pay · {editPayItem.staff_name}
              </h3>
              <button onClick={() => setEditPayItem(null)} className="text-slate-400 hover:text-slate-600">
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleSavePayrollItemAdjustment} className="space-y-3 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Allowances ($)</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={editAllow}
                    onChange={(e) => setEditAllow(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Overtime Pay ($)</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={editOt}
                    onChange={(e) => setEditOt(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Bonus / Incentives ($)</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={editBonus}
                    onChange={(e) => setEditBonus(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Other Deductions ($)</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={editOtherDed}
                    onChange={(e) => setEditOtherDed(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded font-mono"
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setEditPayItem(null)} className="px-3 py-1.5 border border-slate-200 rounded-md">
                  Cancel
                </button>
                <button type="submit" className="px-4 py-1.5 bg-teal-700 hover:bg-teal-800 text-white rounded-md font-medium">
                  Recalculate &amp; Save
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {payItemModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4 no-print">
          <div className="bg-white border border-slate-200 rounded-lg w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-display text-base font-semibold text-slate-900">
                Disburse Salary · {payItemModal.item.staff_name}
              </h3>
              <button onClick={() => setPayItemModal(null)} className="text-slate-400 hover:text-slate-600">
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handlePayPayrollItem} className="space-y-3 text-xs">
              <div>
                <label className="block font-medium text-slate-700 mb-1">Payment Amount ($)</label>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  required
                  value={payItemAmt}
                  onChange={(e) => setPayItemAmt(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded font-mono"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Cash / Bank Account</label>
                <select
                  value={payItemCbId}
                  onChange={(e) => setPayItemCbId(e.target.value)}
                  className="w-full px-2.5 py-2 border border-slate-300 rounded bg-white"
                >
                  {cashBankAccounts.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.account_name} (${Number(c.current_balance).toFixed(2)})
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Method</label>
                  <select
                    value={payItemMethod}
                    onChange={(e) => setPayItemMethod(e.target.value as 'bank_transfer' | 'cash')}
                    className="w-full px-2.5 py-2 border border-slate-300 rounded bg-white"
                  >
                    <option value="bank_transfer">Bank Transfer</option>
                    <option value="cash">Cash</option>
                  </select>
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Reference #</label>
                  <input
                    value={payItemRef}
                    onChange={(e) => setPayItemRef(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded font-mono"
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setPayItemModal(null)} className="px-3 py-1.5 border border-slate-200 rounded-md">
                  Cancel
                </button>
                <button type="submit" className="px-4 py-1.5 bg-teal-700 hover:bg-teal-800 text-white rounded-md font-medium">
                  Confirm Salary Payment
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {rejectRunTarget && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4 no-print">
          <div className="bg-white border border-slate-200 rounded-lg w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-display text-base font-semibold text-slate-900">
                Reject Payroll Run · {rejectRunTarget.run_number}
              </h3>
              <button onClick={() => setRejectRunTarget(null)} className="text-slate-400 hover:text-slate-600">
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleRejectPayrollRun} className="space-y-3 text-xs">
              <textarea
                rows={2}
                required
                value={rejectRunReason}
                onChange={(e) => setRejectRunReason(e.target.value)}
                placeholder="Reason for rejecting payroll run..."
                className="w-full px-3 py-2 border border-slate-300 rounded-md"
              />
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setRejectRunTarget(null)} className="px-3 py-1.5 border border-slate-200 rounded-md">
                  Cancel
                </button>
                <button type="submit" className="px-4 py-1.5 bg-red-700 hover:bg-red-800 text-white rounded-md font-medium">
                  Reject Run
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {expPayModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4 no-print">
          <div className="bg-white border border-slate-200 rounded-lg w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-display text-base font-semibold text-slate-900">
                Disburse Expense · {expPayModal.voucher_number}
              </h3>
              <button onClick={() => setExpPayModal(null)} className="text-slate-400 hover:text-slate-600">
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handlePayExpense} className="space-y-3 text-xs">
              <div>
                <label className="block font-medium text-slate-700 mb-1">Disbursement Amount ($)</label>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  required
                  value={expPayAmt}
                  onChange={(e) => setExpPayAmt(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded font-mono"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Cash / Bank Account</label>
                <select
                  value={expPayCbId}
                  onChange={(e) => setExpPayCbId(e.target.value)}
                  className="w-full px-2.5 py-2 border border-slate-300 rounded bg-white"
                >
                  {cashBankAccounts.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.account_name} (${Number(c.current_balance).toFixed(2)})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Reference #</label>
                <input
                  value={expPayRef}
                  onChange={(e) => setExpPayRef(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded font-mono"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setExpPayModal(null)} className="px-3 py-1.5 border border-slate-200 rounded-md">
                  Cancel
                </button>
                <button type="submit" className="px-4 py-1.5 bg-teal-700 hover:bg-teal-800 text-white rounded-md font-medium">
                  Confirm Disbursement
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {cbModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4 no-print">
          <div className="bg-white border border-slate-200 rounded-lg w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-display text-base font-semibold text-slate-900">Add Cash / Bank Account</h3>
              <button onClick={() => setCbModalOpen(false)} className="text-slate-400 hover:text-slate-600">
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleCreateCashBankAccount} className="space-y-3 text-xs">
              <div>
                <label className="block font-medium text-slate-700 mb-1">Account Name *</label>
                <input
                  required
                  value={cbName}
                  onChange={(e) => setCbName(e.target.value)}
                  placeholder="e.g. Clinic Reserve Bank Account"
                  className="w-full px-3 py-2 border border-slate-300 rounded"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Account Type</label>
                  <select
                    value={cbType}
                    onChange={(e) => {
                      const t = e.target.value as 'cash' | 'bank';
                      setCbType(t);
                      setCbCoaCode(t === 'cash' ? '1010' : '1020');
                    }}
                    className="w-full px-2.5 py-2 border border-slate-300 rounded bg-white"
                  >
                    <option value="bank">Bank Account</option>
                    <option value="cash">Cash Account</option>
                  </select>
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Linked GL Code</label>
                  <select
                    value={cbCoaCode}
                    onChange={(e) => setCbCoaCode(e.target.value)}
                    className="w-full px-2.5 py-2 border border-slate-300 rounded bg-white"
                  >
                    {activeAccounts
                      .filter((a) => a.account_type === 'asset')
                      .map((a) => (
                        <option key={a.code} value={a.code}>
                          {a.code} · {a.name}
                        </option>
                      ))}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Bank Name</label>
                  <input
                    value={cbBankName}
                    onChange={(e) => setCbBankName(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Account #</label>
                  <input
                    value={cbAcctNo}
                    onChange={(e) => setCbAcctNo(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded font-mono"
                  />
                </div>
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Opening Balance ($)</label>
                <input
                  type="number"
                  step="0.01"
                  value={cbOpening}
                  onChange={(e) => setCbOpening(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded font-mono"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setCbModalOpen(false)} className="px-3 py-1.5 border border-slate-200 rounded-md">
                  Cancel
                </button>
                <button type="submit" className="px-4 py-1.5 bg-teal-700 hover:bg-teal-800 text-white rounded-md font-medium">
                  Save Account
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {jeModalOpen && overview && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4 no-print">
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
                    {activeAccounts.map((a) => (
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
                    {activeAccounts.map((a) => (
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
                <button type="button" onClick={() => setJeModalOpen(false)} className="px-3 py-1.5 border border-slate-200 rounded-md">
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

      {reverseTarget && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4 no-print">
          <div className="bg-white border border-slate-200 rounded-lg w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-display text-base font-semibold text-slate-900">
                Reverse Journal Entry · {reverseTarget.entry_number}
              </h3>
              <button onClick={() => setReverseTarget(null)} className="text-slate-400 hover:text-slate-600">
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleReverseJournal} className="space-y-3 text-xs">
              <div>
                <label className="block font-medium text-slate-700 mb-1">Reversal Reason (min 5 chars) *</label>
                <textarea
                  rows={2}
                  required
                  minLength={5}
                  value={reverseReason}
                  onChange={(e) => setReverseReason(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-md"
                />
              </div>
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setReverseTarget(null)} className="px-3 py-1.5 border border-slate-200 rounded-md">
                  Cancel
                </button>
                <button type="submit" className="px-4 py-1.5 bg-slate-900 hover:bg-slate-800 text-white rounded-md font-medium">
                  Post Reversal Entry
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <FinancePrintModal target={printTarget} onClose={() => setPrintTarget(null)} />
    </div>
  );
};
