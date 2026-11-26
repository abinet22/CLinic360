import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ArrowRight, CheckCircle2, FlaskConical, TestTube2 } from 'lucide-react';
import { apiFetch } from '../../lib/api';
import { useRealtimeSync } from '../../lib/useRealtimeSync';
import {
  DashboardHeader,
  DashboardSkeleton,
  statusTextTone,
  type RoleDashboardProps,
} from './DashboardPrimitives';

interface LabDashboardData {
  metrics: {
    awaitingCollection: number;
    collectedInProgress: number;
    awaitingVerification: number;
    verifiedToday: number;
    criticalUnacknowledged: number;
    rejectedSamples: number;
  };
  pendingWorklist: Array<{
    id: number;
    visit_id: number;
    sample_barcode: string | null;
    status: string;
    abnormal_flag: string | null;
    result_value: string | null;
    test_code: string;
    test_name: string;
    sample_type: string;
    unit: string | null;
    mrn: string;
    first_name: string;
    last_name: string;
    triage_priority: string | null;
    invoice_status: string | null;
  }>;
  criticalAlerts: Array<{
    id: number;
    result_value: string | null;
    abnormal_flag: string | null;
    status: string;
    test_code: string;
    test_name: string;
    unit: string | null;
    mrn: string;
    first_name: string;
    last_name: string;
  }>;
}

export const LabDashboard: React.FC<RoleDashboardProps> = ({ onNavigate }) => {
  const [data, setData] = useState<LabDashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadData = useCallback((isManual = false) => {
    if (isManual) setRefreshing(true);
    apiFetch<LabDashboardData>('/api/dashboard/lab')
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

  useRealtimeSync(['lab:updated', 'payment:confirmed', 'visit:updated'], () => loadData());

  if (loading) return <DashboardSkeleton />;

  const m = data?.metrics;

  return (
    <div className="space-y-6">
      <DashboardHeader
        title="Clinical Laboratory Workspace"
        subtitle="Sample collection queue, analyzer result entry, dual verification, and critical values"
        scopeLabel={`${m?.rejectedSamples ?? 0} Rejected Samples`}
        refreshing={refreshing}
        onRefresh={() => loadData(true)}
        primaryAction={{
          label: 'Open Lab Worklist',
          onClick: () => onNavigate('diagnostics', 'lab'),
        }}
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 bg-white border border-slate-200 rounded-lg divide-y sm:divide-y-0 sm:divide-x divide-slate-200">
        <div className="p-5">
          <div className="text-xs font-medium text-slate-500 flex items-center justify-between">
            <span>Awaiting Collection</span>
            <TestTube2 className="w-4 h-4 text-teal-700" />
          </div>
          <div className="font-display text-2xl font-bold text-slate-900 mt-1 tabular-nums">
            {m?.awaitingCollection ?? 0}
          </div>
          <div className="text-xs text-slate-500 mt-1 tabular-nums">
            {m?.collectedInProgress ?? 0} collected · in analysis
          </div>
        </div>

        <div className="p-5">
          <div className="text-xs font-medium text-slate-500 flex items-center justify-between">
            <span>Pending Verification</span>
            <FlaskConical className="w-4 h-4 text-amber-600" />
          </div>
          <div className="font-display text-2xl font-bold text-slate-900 mt-1 tabular-nums">
            {m?.awaitingVerification ?? 0}
          </div>
          <div className="text-xs text-slate-500 mt-1">Results awaiting verifier sign-off</div>
        </div>

        <div className="p-5">
          <div className="text-xs font-medium text-slate-500 flex items-center justify-between">
            <span>Verified Today</span>
            <CheckCircle2 className="w-4 h-4 text-emerald-700" />
          </div>
          <div className="font-display text-2xl font-bold text-slate-900 mt-1 tabular-nums">
            {m?.verifiedToday ?? 0}
          </div>
          <div className="text-xs text-slate-500 mt-1">Released to ordering physicians</div>
        </div>

        <div className="p-5">
          <div className="text-xs font-medium text-slate-500 flex items-center justify-between">
            <span>Critical Unacknowledged</span>
            <AlertTriangle className="w-4 h-4 text-red-600" />
          </div>
          <div className="font-display text-2xl font-bold text-red-700 mt-1 tabular-nums">
            {m?.criticalUnacknowledged ?? 0}
          </div>
          <div className="text-xs text-slate-500 mt-1">Panic values awaiting clinician ack</div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
            <div>
              <h2 className="font-display text-sm font-semibold text-slate-900">Active Specimen & Result Queue</h2>
              <p className="text-xs text-slate-500">Ordered, collected, and resulted tests ordered by urgency</p>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('diagnostics', 'lab')}
              className="text-xs font-medium text-teal-700 hover:text-teal-800 inline-flex items-center gap-1 whitespace-nowrap"
            >
              <span>Process Tests</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="divide-y divide-slate-100">
            {!data?.pendingWorklist?.length ? (
              <div className="p-6 text-center text-xs text-slate-500">
                No pending laboratory orders at this moment.
              </div>
            ) : (
              data.pendingWorklist.map((row) => (
                <div key={row.id} className="px-5 py-3 flex items-center justify-between gap-3 text-xs">
                  <div className="min-w-0">
                    <div className="font-medium text-slate-900 truncate">
                      {row.test_name} <span className="font-mono text-slate-400">· {row.test_code}</span>
                    </div>
                    <div className="text-slate-500 truncate mt-0.5">
                      {row.first_name} {row.last_name} ({row.mrn}) · {row.sample_type}
                      {row.sample_barcode ? ` · ${row.sample_barcode}` : ''}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className={statusTextTone(row.status)}>{row.status}</div>
                    <div className="font-mono text-[11px] text-slate-400 mt-0.5">
                      {row.triage_priority || 'routine'} · {row.invoice_status || 'cleared'}
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
              <h2 className="font-display text-sm font-semibold text-slate-900">Abnormal & Critical Values</h2>
              <p className="text-xs text-slate-500">Out-of-range results flagged for review and verification</p>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('diagnostics', 'lab')}
              className="text-xs font-medium text-teal-700 hover:text-teal-800 inline-flex items-center gap-1 whitespace-nowrap"
            >
              <span>Review Alerts</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="divide-y divide-slate-100">
            {!data?.criticalAlerts?.length ? (
              <div className="p-6 text-center text-xs text-slate-500">No abnormal or critical lab alerts.</div>
            ) : (
              data.criticalAlerts.map((item) => (
                <div key={item.id} className="px-5 py-3 flex items-center justify-between gap-3 text-xs">
                  <div className="min-w-0">
                    <div className="font-medium text-slate-900 truncate">
                      {item.test_name} · {item.first_name} {item.last_name}
                    </div>
                    <div className="font-mono text-slate-600 mt-0.5">
                      {item.mrn} · Result: {item.result_value || 'Pending'} {item.unit || ''}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className={statusTextTone(item.abnormal_flag)}>{item.abnormal_flag}</div>
                    <div className="font-mono text-[11px] text-slate-400 mt-0.5">{item.status}</div>
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
