import React, { useCallback, useEffect, useState } from 'react';
import { ArrowRight, CreditCard, Receipt, ShieldAlert, Wallet } from 'lucide-react';
import { apiFetch } from '../../lib/api';
import { useRealtimeSync } from '../../lib/useRealtimeSync';
import {
  DashboardHeader,
  DashboardSkeleton,
  fmtMoney,
  fmtShortTime,
  statusTextTone,
  type RoleDashboardProps,
} from './DashboardPrimitives';

interface CashierDashboardData {
  openShift: {
    id: number;
    opening_float: number;
    expected_cash: number;
    status: string;
    opened_at: string;
  } | null;
  metrics: {
    unpaidInvoiceCount: number;
    outstandingReceivables: number;
    todayReceiptCount: number;
    todayCollectionsTotal: number;
    pendingPaymentBypasses: number;
    shiftOpen: boolean;
    shiftExpectedCash: number;
  };
  todayPaymentsByMethod: Array<{
    method: string;
    tx_count: number;
    total_amount: number;
  }>;
  recentUnpaidInvoices: Array<{
    id: number;
    invoice_number: string;
    total_amount: number;
    paid_amount: number;
    balance_due: number;
    payer_type: string;
    status: string;
    created_at: string;
    mrn: string;
    first_name: string;
    last_name: string;
  }>;
  recentReceipts: Array<{
    id: number;
    receipt_number: string;
    amount: number;
    method: string;
    status: string;
    created_at: string;
    invoice_number: string;
    mrn: string;
    first_name: string;
    last_name: string;
  }>;
}

export const CashierDashboard: React.FC<RoleDashboardProps> = ({ onNavigate }) => {
  const [data, setData] = useState<CashierDashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadData = useCallback((isManual = false) => {
    if (isManual) setRefreshing(true);
    apiFetch<CashierDashboardData>('/api/dashboard/cashier')
      .then(setData)
      .catch(() => {})
      .finally(() => {
        setLoading(false);
        setRefreshing(false);
      });
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useRealtimeSync(['payment:confirmed', 'finance:updated', 'visit:updated'], () => loadData());

  if (loading) return <DashboardSkeleton />;

  const m = data?.metrics;

  return (
    <div className="space-y-6">
      <DashboardHeader
        title="Cashier & Billing Desk"
        subtitle="Active cash drawer shift, pending patient invoices, receipts, and payment-gate reconciliation"
        scopeLabel={m?.shiftOpen ? `Shift #${data?.openShift?.id} Open` : 'No Open Shift'}
        refreshing={refreshing}
        onRefresh={() => loadData(true)}
        primaryAction={{
          label: 'Collect Payment',
          onClick: () => onNavigate('billing', 'payments'),
        }}
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 bg-white border border-slate-200 rounded-lg divide-y sm:divide-y-0 sm:divide-x divide-slate-200">
        <div className="p-5">
          <div className="text-xs font-medium text-slate-500 flex items-center justify-between">
            <span>Today&apos;s Collections</span>
            <Receipt className="w-4 h-4 text-teal-700" />
          </div>
          <div className="font-display text-2xl font-bold text-slate-900 mt-1 tabular-nums">
            {fmtMoney(m?.todayCollectionsTotal)}
          </div>
          <div className="text-xs text-slate-500 mt-1 tabular-nums">
            {m?.todayReceiptCount ?? 0} completed receipts today
          </div>
        </div>

        <div className="p-5">
          <div className="text-xs font-medium text-slate-500 flex items-center justify-between">
            <span>Pending Invoices</span>
            <CreditCard className="w-4 h-4 text-amber-600" />
          </div>
          <div className="font-display text-2xl font-bold text-slate-900 mt-1 tabular-nums">
            {m?.unpaidInvoiceCount ?? 0}
          </div>
          <div className="text-xs text-slate-500 mt-1 tabular-nums">
            {fmtMoney(m?.outstandingReceivables)} unpaid balance
          </div>
        </div>

        <div className="p-5">
          <div className="text-xs font-medium text-slate-500 flex items-center justify-between">
            <span>Shift Expected Cash</span>
            <Wallet className="w-4 h-4 text-emerald-700" />
          </div>
          <div className="font-display text-2xl font-bold text-slate-900 mt-1 tabular-nums">
            {m?.shiftOpen ? fmtMoney(m.shiftExpectedCash) : 'Closed'}
          </div>
          <div className="text-xs text-slate-500 mt-1 tabular-nums">
            {m?.shiftOpen
              ? `Float ${fmtMoney(data?.openShift?.opening_float)}`
              : 'Open shift before accepting cash'}
          </div>
        </div>

        <div className="p-5">
          <div className="text-xs font-medium text-slate-500 flex items-center justify-between">
            <span>Payment-Gate Bypasses</span>
            <ShieldAlert className="w-4 h-4 text-red-600" />
          </div>
          <div className="font-display text-2xl font-bold text-slate-900 mt-1 tabular-nums">
            {m?.pendingPaymentBypasses ?? 0}
          </div>
          <div className="text-xs text-slate-500 mt-1">Emergency / approved overrides pending settle</div>
        </div>
      </div>

      {data?.todayPaymentsByMethod && data.todayPaymentsByMethod.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-lg p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-display text-sm font-semibold text-slate-900">Today&apos;s Collections by Payment Method</h2>
            <button
              type="button"
              onClick={() => onNavigate('billing', 'shifts')}
              className="text-xs font-medium text-teal-700 hover:text-teal-800 inline-flex items-center gap-1 whitespace-nowrap"
            >
              <span>Shift Reconciliation</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 divide-x divide-slate-200">
            {data.todayPaymentsByMethod.map((pm, idx) => (
              <div key={pm.method} className={idx > 0 ? 'pl-4' : ''}>
                <div className="text-xs uppercase font-medium text-slate-500">{pm.method}</div>
                <div className="font-display text-lg font-bold text-slate-900 mt-0.5 tabular-nums">
                  {fmtMoney(pm.total_amount)}
                </div>
                <div className="text-xs text-slate-500 tabular-nums">{pm.tx_count} receipts</div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
            <div>
              <h2 className="font-display text-sm font-semibold text-slate-900">Unpaid & Partial Invoices</h2>
              <p className="text-xs text-slate-500">Invoices ready for collection at cashier desk</p>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('billing', 'invoices')}
              className="text-xs font-medium text-teal-700 hover:text-teal-800 inline-flex items-center gap-1 whitespace-nowrap"
            >
              <span>All Invoices</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="divide-y divide-slate-100">
            {!data?.recentUnpaidInvoices?.length ? (
              <div className="p-6 text-center space-y-2">
                <p className="text-xs text-slate-500">All current patient invoices are settled.</p>
                <button
                  type="button"
                  onClick={() => onNavigate('patients', 'visits')}
                  className="px-3 py-1.5 text-xs font-medium border border-slate-200 hover:bg-slate-50 rounded-md text-slate-700"
                >
                  Create Walk-In Visit
                </button>
              </div>
            ) : (
              data.recentUnpaidInvoices.map((inv) => (
                <div key={inv.id} className="px-5 py-3 flex items-center justify-between gap-3 text-xs">
                  <div className="min-w-0">
                    <div className="font-medium text-slate-900 truncate">
                      <span className="font-mono">{inv.invoice_number}</span> · {inv.first_name} {inv.last_name}
                    </div>
                    <div className="text-slate-500 truncate mt-0.5">
                      {inv.mrn} · {inv.payer_type} · Total {fmtMoney(inv.total_amount)}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="font-mono font-semibold text-slate-900 tabular-nums">
                      Due {fmtMoney(inv.balance_due)}
                    </div>
                    <div className={`text-[11px] mt-0.5 ${statusTextTone(inv.status)}`}>{inv.status}</div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
            <div>
              <h2 className="font-display text-sm font-semibold text-slate-900">Recent Payment Receipts</h2>
              <p className="text-xs text-slate-500">Latest confirmed payments and reference numbers</p>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('billing', 'reports')}
              className="text-xs font-medium text-teal-700 hover:text-teal-800 inline-flex items-center gap-1 whitespace-nowrap"
            >
              <span>Payment Reports</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="divide-y divide-slate-100">
            {!data?.recentReceipts?.length ? (
              <div className="p-6 text-center text-xs text-slate-500">No payment receipts recorded yet.</div>
            ) : (
              data.recentReceipts.map((rec) => (
                <div key={rec.id} className="px-5 py-3 flex items-center justify-between gap-3 text-xs">
                  <div className="min-w-0">
                    <div className="font-medium text-slate-900 truncate">
                      <span className="font-mono">{rec.receipt_number}</span> · {rec.first_name} {rec.last_name}
                    </div>
                    <div className="text-slate-500 truncate mt-0.5">
                      {rec.invoice_number} · {rec.method} · {fmtShortTime(rec.created_at)}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="font-mono font-semibold text-emerald-700 tabular-nums">
                      {fmtMoney(rec.amount)}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
