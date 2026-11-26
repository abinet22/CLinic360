import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ArrowRight, CheckCircle2, Package, Pill } from 'lucide-react';
import { apiFetch } from '../../lib/api';
import { useAuth } from '../../lib/authContext';
import { useRealtimeSync } from '../../lib/useRealtimeSync';
import {
  DashboardHeader,
  DashboardSkeleton,
  statusTextTone,
  type RoleDashboardProps,
} from './DashboardPrimitives';

interface PharmacyDashboardData {
  metrics: {
    readyToDispense: number;
    pendingPayment: number;
    dispensedToday: number;
    lowStockCount: number;
    expiringBatchesCount: number;
    pendingRequisitions: number;
  };
  dispenseQueue: Array<{
    id: number;
    visit_id: number;
    status: string;
    created_at: string;
    mrn: string;
    first_name: string;
    last_name: string;
    doctor_name: string | null;
    invoice_number: string | null;
    invoice_status: string | null;
    item_count: number;
  }>;
  lowStockMedicines: Array<{
    id: number;
    code: string;
    generic_name: string;
    strength: string;
    form: string;
    stock_qty: number;
    reorder_level: number;
  }>;
  expiringBatches: Array<{
    id: number;
    batch_number: string;
    location: string;
    expiry_date: string;
    qty_on_hand: number;
    item_code: string;
    item_name: string;
    unit: string;
  }>;
}

export const PharmacyDashboard: React.FC<RoleDashboardProps> = ({ onNavigate }) => {
  const { hasPermission } = useAuth();
  const [data, setData] = useState<PharmacyDashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadData = useCallback((isManual = false) => {
    if (isManual) setRefreshing(true);
    apiFetch<PharmacyDashboardData>('/api/dashboard/pharmacy')
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

  useRealtimeSync(['pharmacy:updated', 'payment:confirmed', 'store:updated'], () => loadData());

  if (loading) return <DashboardSkeleton />;

  const m = data?.metrics;

  return (
    <div className="space-y-6">
      <DashboardHeader
        title="Pharmacy & Dispensary Workspace"
        subtitle="Prescription dispensing queue, FEFO batch expiry watch, and medicine reorder alerts"
        scopeLabel={`${m?.pendingRequisitions ?? 0} Open Store Requisitions`}
        refreshing={refreshing}
        onRefresh={() => loadData(true)}
        primaryAction={{
          label: 'Open Dispensary Queue',
          onClick: () => onNavigate('diagnostics', 'pharmacy'),
        }}
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 bg-white border border-slate-200 rounded-lg divide-y sm:divide-y-0 sm:divide-x divide-slate-200">
        <div className="p-5">
          <div className="text-xs font-medium text-slate-500 flex items-center justify-between">
            <span>Ready to Dispense</span>
            <Pill className="w-4 h-4 text-teal-700" />
          </div>
          <div className="font-display text-2xl font-bold text-slate-900 mt-1 tabular-nums">
            {m?.readyToDispense ?? 0}
          </div>
          <div className="text-xs text-slate-500 mt-1 tabular-nums">
            {m?.pendingPayment ?? 0} awaiting cashier settlement
          </div>
        </div>

        <div className="p-5">
          <div className="text-xs font-medium text-slate-500 flex items-center justify-between">
            <span>Dispensed Today</span>
            <CheckCircle2 className="w-4 h-4 text-emerald-700" />
          </div>
          <div className="font-display text-2xl font-bold text-slate-900 mt-1 tabular-nums">
            {m?.dispensedToday ?? 0}
          </div>
          <div className="text-xs text-slate-500 mt-1">Completed outpatient orders</div>
        </div>

        <div className="p-5">
          <div className="text-xs font-medium text-slate-500 flex items-center justify-between">
            <span>Low-Stock Medicines</span>
            <Package className="w-4 h-4 text-amber-600" />
          </div>
          <div className="font-display text-2xl font-bold text-slate-900 mt-1 tabular-nums">
            {m?.lowStockCount ?? 0}
          </div>
          <div className="text-xs text-slate-500 mt-1">At or below reorder threshold</div>
        </div>

        <div className="p-5">
          <div className="text-xs font-medium text-slate-500 flex items-center justify-between">
            <span>Expiring Batches (30d)</span>
            <AlertTriangle className="w-4 h-4 text-red-600" />
          </div>
          <div className="font-display text-2xl font-bold text-red-700 mt-1 tabular-nums">
            {m?.expiringBatchesCount ?? 0}
          </div>
          <div className="text-xs text-slate-500 mt-1">FEFO quarantine review required</div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
            <div>
              <h2 className="font-display text-sm font-semibold text-slate-900">Prescription Dispensing Queue</h2>
              <p className="text-xs text-slate-500">Cleared prescriptions and pending payment scripts</p>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('diagnostics', 'pharmacy')}
              className="text-xs font-medium text-teal-700 hover:text-teal-800 inline-flex items-center gap-1 whitespace-nowrap"
            >
              <span>Dispense</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="divide-y divide-slate-100">
            {!data?.dispenseQueue?.length ? (
              <div className="p-6 text-center text-xs text-slate-500">
                No prescriptions pending in the dispensing queue.
              </div>
            ) : (
              data.dispenseQueue.map((rx) => (
                <div key={rx.id} className="px-5 py-3 flex items-center justify-between gap-3 text-xs">
                  <div className="min-w-0">
                    <div className="font-medium text-slate-900 truncate">
                      Rx #{rx.id} · {rx.first_name} {rx.last_name}{' '}
                      <span className="font-mono text-slate-400">· {rx.mrn}</span>
                    </div>
                    <div className="text-slate-500 truncate mt-0.5">
                      {rx.item_count} item(s) · {rx.doctor_name || 'OPD Physician'}
                      {rx.invoice_number ? ` · ${rx.invoice_number}` : ''}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className={statusTextTone(rx.status)}>{rx.status.replace(/_/g, ' ')}</div>
                    <div className="font-mono text-[11px] text-slate-400 mt-0.5">
                      {rx.invoice_status || 'cleared'}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
            <div>
              <h2 className="font-display text-sm font-semibold text-slate-900">Stock Reorder & FEFO Alerts</h2>
              <p className="text-xs text-slate-500">Low dispensary balances and batches expiring within 30 days</p>
            </div>
            {hasPermission('store.item.read') && (
              <button
                type="button"
                onClick={() => onNavigate('store')}
                className="text-xs font-medium text-teal-700 hover:text-teal-800 inline-flex items-center gap-1 whitespace-nowrap"
              >
                <span>Store & FEFO</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          <div className="divide-y divide-slate-100">
            {!data?.lowStockMedicines?.length && !data?.expiringBatches?.length ? (
              <div className="p-6 text-center text-xs text-slate-500">
                All dispensary stock levels and batch expiries are healthy.
              </div>
            ) : (
              <>
                {data.lowStockMedicines.slice(0, 5).map((med) => (
                  <div key={`med-${med.id}`} className="px-5 py-3 flex items-center justify-between gap-3 text-xs">
                    <div className="min-w-0">
                      <div className="font-medium text-slate-900 truncate">
                        {med.generic_name} {med.strength} ({med.form})
                      </div>
                      <div className="font-mono text-slate-500 mt-0.5">{med.code}</div>
                    </div>
                    <div className="text-right shrink-0 font-mono tabular-nums">
                      <span className="text-amber-700 font-semibold">{med.stock_qty}</span>
                      <span className="text-slate-400"> / min {med.reorder_level}</span>
                    </div>
                  </div>
                ))}
                {data.expiringBatches.slice(0, 4).map((b) => (
                  <div key={`bat-${b.id}`} className="px-5 py-3 flex items-center justify-between gap-3 text-xs">
                    <div className="min-w-0">
                      <div className="font-medium text-slate-900 truncate">
                        {b.item_name} <span className="font-mono text-slate-400">· {b.batch_number}</span>
                      </div>
                      <div className="text-slate-500 truncate mt-0.5">
                        {b.location} · {b.qty_on_hand} {b.unit}
                      </div>
                    </div>
                    <span className="font-mono text-red-700 font-semibold shrink-0">Exp {b.expiry_date}</span>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
