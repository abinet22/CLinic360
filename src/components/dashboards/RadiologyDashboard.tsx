import React, { useCallback, useEffect, useState } from 'react';
import { ArrowRight, CheckCircle2, FileText, Scan } from 'lucide-react';
import { apiFetch } from '../../lib/api';
import { useRealtimeSync } from '../../lib/useRealtimeSync';
import {
  DashboardHeader,
  DashboardSkeleton,
  statusTextTone,
  type RoleDashboardProps,
} from './DashboardPrimitives';

interface RadiologyDashboardData {
  metrics: {
    orderedQueue: number;
    scheduledQueue: number;
    awaitingReport: number;
    draftReports: number;
    finalisedToday: number;
  };
  worklist: Array<{
    id: number;
    visit_id: number;
    status: string;
    findings: string | null;
    impression: string | null;
    exam_code: string;
    exam_name: string;
    modality: string;
    body_region: string;
    mrn: string;
    first_name: string;
    last_name: string;
    triage_priority: string | null;
    invoice_status: string | null;
  }>;
  modalityBreakdown: Array<{
    modality: string;
    open_count: number;
  }>;
}

export const RadiologyDashboard: React.FC<RoleDashboardProps> = ({ onNavigate }) => {
  const [data, setData] = useState<RadiologyDashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadData = useCallback((isManual = false) => {
    if (isManual) setRefreshing(true);
    apiFetch<RadiologyDashboardData>('/api/dashboard/radiology')
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

  useRealtimeSync(['imaging:updated', 'payment:confirmed', 'visit:updated'], () => loadData());

  if (loading) return <DashboardSkeleton />;

  const m = data?.metrics;

  return (
    <div className="space-y-6">
      <DashboardHeader
        title="Radiology & Imaging Workspace"
        subtitle="Exam scheduling, performed imaging studies, draft reads, and finalised reports"
        refreshing={refreshing}
        onRefresh={() => loadData(true)}
        primaryAction={{
          label: 'Open Imaging Worklist',
          onClick: () => onNavigate('diagnostics', 'imaging'),
        }}
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 bg-white border border-slate-200 rounded-lg divide-y sm:divide-y-0 sm:divide-x divide-slate-200">
        <div className="p-5">
          <div className="text-xs font-medium text-slate-500 flex items-center justify-between">
            <span>Ordered & Scheduled</span>
            <Scan className="w-4 h-4 text-teal-700" />
          </div>
          <div className="font-display text-2xl font-bold text-slate-900 mt-1 tabular-nums">
            {(m?.orderedQueue ?? 0) + (m?.scheduledQueue ?? 0)}
          </div>
          <div className="text-xs text-slate-500 mt-1 tabular-nums">
            {m?.orderedQueue ?? 0} ordered · {m?.scheduledQueue ?? 0} scheduled
          </div>
        </div>

        <div className="p-5">
          <div className="text-xs font-medium text-slate-500 flex items-center justify-between">
            <span>Performed / Awaiting Report</span>
            <FileText className="w-4 h-4 text-amber-600" />
          </div>
          <div className="font-display text-2xl font-bold text-slate-900 mt-1 tabular-nums">
            {m?.awaitingReport ?? 0}
          </div>
          <div className="text-xs text-slate-500 mt-1">Studies ready for radiologist read</div>
        </div>

        <div className="p-5">
          <div className="text-xs font-medium text-slate-500 flex items-center justify-between">
            <span>Draft Reports</span>
            <FileText className="w-4 h-4 text-slate-500" />
          </div>
          <div className="font-display text-2xl font-bold text-slate-900 mt-1 tabular-nums">
            {m?.draftReports ?? 0}
          </div>
          <div className="text-xs text-slate-500 mt-1">Pending final sign-off</div>
        </div>

        <div className="p-5">
          <div className="text-xs font-medium text-slate-500 flex items-center justify-between">
            <span>Finalised Today</span>
            <CheckCircle2 className="w-4 h-4 text-emerald-700" />
          </div>
          <div className="font-display text-2xl font-bold text-slate-900 mt-1 tabular-nums">
            {m?.finalisedToday ?? 0}
          </div>
          <div className="text-xs text-slate-500 mt-1">Signed reports available to OPD</div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
            <div>
              <h2 className="font-display text-sm font-semibold text-slate-900">Imaging Examination Queue</h2>
              <p className="text-xs text-slate-500">Ordered, performed, and draft studies prioritized by triage</p>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('diagnostics', 'imaging')}
              className="text-xs font-medium text-teal-700 hover:text-teal-800 inline-flex items-center gap-1 whitespace-nowrap"
            >
              <span>Open Studies</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="divide-y divide-slate-100">
            {!data?.worklist?.length ? (
              <div className="p-6 text-center text-xs text-slate-500">No open imaging studies in the queue.</div>
            ) : (
              data.worklist.map((row) => (
                <div key={row.id} className="px-5 py-3 flex items-center justify-between gap-3 text-xs">
                  <div className="min-w-0">
                    <div className="font-medium text-slate-900 truncate">
                      {row.exam_name}{' '}
                      <span className="font-mono text-slate-400">
                        · {row.modality} · {row.body_region}
                      </span>
                    </div>
                    <div className="text-slate-500 truncate mt-0.5">
                      {row.first_name} {row.last_name} ({row.mrn}) · {row.exam_code}
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
          <div className="px-5 py-3.5 border-b border-slate-200">
            <h2 className="font-display text-sm font-semibold text-slate-900">Open Modality Load</h2>
            <p className="text-xs text-slate-500">Active queue grouped by equipment type</p>
          </div>
          <div className="divide-y divide-slate-100">
            {!data?.modalityBreakdown?.length ? (
              <div className="p-6 text-center text-xs text-slate-500">No active studies across modalities.</div>
            ) : (
              data.modalityBreakdown.map((item) => (
                <div key={item.modality} className="px-5 py-3 flex items-center justify-between text-xs">
                  <span className="font-medium text-slate-900">{item.modality}</span>
                  <span className="font-mono font-semibold text-slate-800 tabular-nums">{item.open_count} open</span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
