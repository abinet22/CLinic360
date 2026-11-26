import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Printer } from 'lucide-react';
import type { ExpenseVoucher, FinancePayment, FinanceReceipt, PayrollItem } from '../types';

export type FinancePrintTarget =
  | { kind: 'payslip'; item: PayrollItem; runNumber: string; payMonth: string }
  | { kind: 'payment'; payment: FinancePayment }
  | { kind: 'receipt'; receipt: FinanceReceipt }
  | { kind: 'expense'; expense: ExpenseVoucher };

interface Props {
  target: FinancePrintTarget | null;
  onClose: () => void;
}

export const FinancePrintModal: React.FC<Props> = ({ target, onClose }) => {
  useEffect(() => {
    if (!target) return;
    document.body.classList.add('has-print-modal');
    return () => {
      document.body.classList.remove('has-print-modal');
    };
  }, [target]);

  if (!target) return null;

  const title =
    target.kind === 'payslip'
      ? 'Employee Salary Statement (Payslip)'
      : target.kind === 'payment'
        ? 'Official Finance Payment Voucher'
        : target.kind === 'receipt'
          ? 'Official Finance Receipt Voucher'
          : 'Operational Expense Voucher';

  return createPortal(
    <div className="print-modal-backdrop fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
      <div className="print-modal-card bg-white border border-slate-200 rounded-lg max-w-xl w-full p-8 space-y-5 text-xs">
        <div className="flex items-start justify-between border-b-2 border-slate-900 pb-4">
          <div>
            <div className="font-display text-lg font-bold text-slate-900">Clinic360 Central Medical</div>
            <div className="uppercase tracking-wider font-semibold text-teal-800 mt-0.5">{title}</div>
          </div>
          <div className="flex items-center gap-2 no-print">
            <button
              onClick={() => window.print()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-teal-700 hover:bg-teal-800 text-white rounded-md font-medium"
            >
              <Printer className="w-3.5 h-3.5" />
              <span>Print / PDF</span>
            </button>
            <button
              onClick={onClose}
              className="px-3 py-1.5 border border-slate-200 rounded-md text-slate-700 hover:bg-slate-50"
            >
              Close
            </button>
          </div>
        </div>

        {target.kind === 'payslip' && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 bg-slate-50 p-3.5 border border-slate-200 rounded">
              <div>
                <div className="text-slate-500">Staff Member</div>
                <div className="font-semibold text-slate-900 text-sm">{target.item.staff_name}</div>
                <div className="font-mono text-slate-500">Role: {target.item.role_code}</div>
              </div>
              <div className="text-right">
                <div className="text-slate-500">Pay Period &amp; Batch</div>
                <div className="font-mono font-semibold text-slate-900">{target.payMonth}</div>
                <div className="font-mono text-slate-500">{target.runNumber}</div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="border border-slate-200 rounded p-3 space-y-1.5">
                <div className="font-semibold text-slate-900 border-b border-slate-100 pb-1">Earnings</div>
                <div className="flex justify-between">
                  <span>Basic Salary</span>
                  <span className="font-mono tabular-nums">${Number(target.item.base_salary).toFixed(2)}</span>
                </div>
                <div className="flex justify-between">
                  <span>Allowances</span>
                  <span className="font-mono tabular-nums">${Number(target.item.allowances || 0).toFixed(2)}</span>
                </div>
                <div className="flex justify-between">
                  <span>Overtime Pay</span>
                  <span className="font-mono tabular-nums">${Number(target.item.overtime_pay || 0).toFixed(2)}</span>
                </div>
                <div className="flex justify-between">
                  <span>Bonus / Incentives</span>
                  <span className="font-mono tabular-nums">${Number(target.item.bonus_earnings || 0).toFixed(2)}</span>
                </div>
              </div>
              <div className="border border-slate-200 rounded p-3 space-y-1.5">
                <div className="font-semibold text-slate-900 border-b border-slate-100 pb-1">Deductions</div>
                <div className="flex justify-between">
                  <span>PAYE Tax</span>
                  <span className="font-mono tabular-nums">${Number(target.item.paye_tax ?? 0).toFixed(2)}</span>
                </div>
                <div className="flex justify-between">
                  <span>Employee Pension (7%)</span>
                  <span className="font-mono tabular-nums">${Number(target.item.pension_employee ?? 0).toFixed(2)}</span>
                </div>
                <div className="flex justify-between">
                  <span>Loans / Advances / Other</span>
                  <span className="font-mono tabular-nums">${Number(target.item.other_deductions ?? 0).toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-slate-500 pt-1 border-t border-slate-100">
                  <span>Employer Pension (11%)</span>
                  <span className="font-mono tabular-nums">${Number(target.item.pension_employer ?? 0).toFixed(2)}</span>
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between p-4 bg-teal-50 border border-teal-200 rounded font-mono">
              <div>
                <div className="font-sans font-semibold text-slate-900">Net Salary Payable</div>
                <div className="text-[11px] text-slate-600">
                  Paid: ${Number(target.item.paid_amount || 0).toFixed(2)} · Status: {(target.item.payment_status || 'unpaid').toUpperCase()}
                </div>
              </div>
              <span className="text-lg font-bold text-teal-900 tabular-nums">${Number(target.item.net_pay).toFixed(2)}</span>
            </div>
          </div>
        )}

        {target.kind === 'payment' && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 bg-slate-50 p-3.5 border border-slate-200 rounded">
              <div>
                <div className="text-slate-500">Voucher Number</div>
                <div className="font-mono font-bold text-sm text-teal-800">{target.payment.payment_number}</div>
              </div>
              <div className="text-right">
                <div className="text-slate-500">Payment Date</div>
                <div className="font-mono font-semibold text-slate-900">{target.payment.payment_date}</div>
              </div>
              <div>
                <div className="text-slate-500">Paid To (Payee)</div>
                <div className="font-semibold text-slate-900">{target.payment.payee_name}</div>
              </div>
              <div className="text-right">
                <div className="text-slate-500">Source Account &amp; Method</div>
                <div className="font-medium text-slate-900">
                  {target.payment.cash_bank_account_name} ({target.payment.payment_method.replace('_', ' ')})
                </div>
              </div>
            </div>
            <div className="border border-slate-200 rounded p-4 space-y-2">
              <div className="flex justify-between">
                <span className="text-slate-500">Category</span>
                <span className="capitalize font-medium">{target.payment.payment_category}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Reference #</span>
                <span className="font-mono">{target.payment.reference_no || '—'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">GL Journal #</span>
                <span className="font-mono">{target.payment.journal_entry_number || '—'}</span>
              </div>
              <div className="pt-2 border-t border-slate-100">
                <div className="text-slate-500 mb-0.5">Narration</div>
                <div className="text-slate-800">{target.payment.notes || 'Standard finance disbursement'}</div>
              </div>
            </div>
            <div className="flex items-center justify-between p-4 bg-slate-900 text-white rounded font-mono">
              <span className="font-sans font-semibold">Total Disbursed Amount</span>
              <span className="text-lg font-bold tabular-nums">${Number(target.payment.amount).toFixed(2)}</span>
            </div>
            <div className="grid grid-cols-2 gap-8 pt-6 text-center text-slate-500">
              <div className="border-t border-slate-300 pt-2">Prepared By ({target.payment.created_by_name || 'Finance'})</div>
              <div className="border-t border-slate-300 pt-2">Authorized / Received Signature</div>
            </div>
          </div>
        )}

        {target.kind === 'receipt' && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 bg-slate-50 p-3.5 border border-slate-200 rounded">
              <div>
                <div className="text-slate-500">Receipt Number</div>
                <div className="font-mono font-bold text-sm text-teal-800">{target.receipt.receipt_number}</div>
              </div>
              <div className="text-right">
                <div className="text-slate-500">Receipt Date</div>
                <div className="font-mono font-semibold text-slate-900">{target.receipt.receipt_date}</div>
              </div>
              <div>
                <div className="text-slate-500">Received From (Payer)</div>
                <div className="font-semibold text-slate-900">{target.receipt.payer_name}</div>
              </div>
              <div className="text-right">
                <div className="text-slate-500">Deposited Account</div>
                <div className="font-medium text-slate-900">
                  {target.receipt.cash_bank_account_name} ({target.receipt.payment_method.replace('_', ' ')})
                </div>
              </div>
            </div>
            <div className="border border-slate-200 rounded p-4 space-y-2">
              <div className="flex justify-between">
                <span className="text-slate-500">Income Category</span>
                <span className="capitalize font-medium">{target.receipt.income_category}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Reference #</span>
                <span className="font-mono">{target.receipt.reference_no || '—'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">GL Journal #</span>
                <span className="font-mono">{target.receipt.journal_entry_number || '—'}</span>
              </div>
              <div className="pt-2 border-t border-slate-100">
                <div className="text-slate-500 mb-0.5">Notes</div>
                <div className="text-slate-800">{target.receipt.notes || 'Non-patient institutional receipt'}</div>
              </div>
            </div>
            <div className="flex items-center justify-between p-4 bg-teal-50 border border-teal-200 rounded font-mono">
              <span className="font-sans font-semibold text-slate-900">Total Received</span>
              <span className="text-lg font-bold text-teal-900 tabular-nums">${Number(target.receipt.amount).toFixed(2)}</span>
            </div>
          </div>
        )}

        {target.kind === 'expense' && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 bg-slate-50 p-3.5 border border-slate-200 rounded">
              <div>
                <div className="text-slate-500">Voucher Number</div>
                <div className="font-mono font-bold text-sm text-teal-800">{target.expense.voucher_number}</div>
              </div>
              <div className="text-right">
                <div className="text-slate-500">Expense Date &amp; Status</div>
                <div className="font-mono font-semibold text-slate-900">
                  {target.expense.expense_date} · {target.expense.status.toUpperCase()}
                </div>
              </div>
              <div>
                <div className="text-slate-500">Payee / Vendor</div>
                <div className="font-semibold text-slate-900">{target.expense.payee_name}</div>
              </div>
              <div className="text-right">
                <div className="text-slate-500">Expense GL Account</div>
                <div className="font-mono text-slate-900">
                  {target.expense.account_code} · {target.expense.account_name}
                </div>
              </div>
            </div>
            <div className="border border-slate-200 rounded p-4 space-y-2">
              <div className="flex justify-between">
                <span className="text-slate-500">Category</span>
                <span>{target.expense.category}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Reference / Attachment</span>
                <span className="font-mono">
                  {target.expense.reference_number || '—'} {target.expense.attachment_ref ? `(${target.expense.attachment_ref})` : ''}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Paid / Total</span>
                <span className="font-mono tabular-nums font-semibold">
                  ${Number(target.expense.paid_amount || 0).toFixed(2)} / ${Number(target.expense.amount).toFixed(2)}
                </span>
              </div>
              <div className="pt-2 border-t border-slate-100">
                <div className="text-slate-500 mb-0.5">Description</div>
                <div className="text-slate-800">{target.expense.description}</div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
};
