import React from 'react';
import { RefreshCw } from 'lucide-react';

export interface RoleDashboardProps {
  onNavigate: (tab: string, subView?: string) => void;
}

export function fmtMoney(val: number | null | undefined): string {
  const n = Number(val || 0);
  const abs = Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return n < 0 ? `-$${abs}` : `$${abs}`;
}

export function fmtShortTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return String(iso).slice(0, 16).replace('T', ' ');
}

export function statusTextTone(status: string | null | undefined): string {
  const s = String(status || '').toLowerCase();
  if (['emergency', 'critical', 'rejected', 'locked', 'inactive', 'unpaid'].includes(s)) {
    return 'text-red-700 font-semibold';
  }
  if (['urgent', 'pending', 'ordered', 'partial', 'reported_draft', 'pending_payment', 'late', 'due'].includes(s)) {
    return 'text-amber-700 font-semibold';
  }
  if (['verified', 'reported_final', 'completed', 'paid', 'dispensed', 'active', 'ready_for_doctor', 'results_ready'].includes(s)) {
    return 'text-emerald-700 font-semibold';
  }
  return 'text-slate-700 font-medium';
}

export const DashboardSkeleton: React.FC = () => (
  <div className="space-y-6">
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 bg-white border border-slate-200 rounded-lg divide-y sm:divide-y-0 sm:divide-x divide-slate-200">
      {[1, 2, 3, 4].map((idx) => (
        <div key={idx} className="p-5 animate-pulse space-y-2.5">
          <div className="h-3 w-24 bg-slate-200 rounded" />
          <div className="h-7 w-16 bg-slate-200 rounded" />
          <div className="h-3 w-32 bg-slate-100 rounded" />
        </div>
      ))}
    </div>
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <div className="h-64 bg-white border border-slate-200 rounded-lg animate-pulse" />
      <div className="h-64 bg-white border border-slate-200 rounded-lg animate-pulse" />
    </div>
  </div>
);

export const DashboardHeader: React.FC<{
  title: string;
  subtitle: string;
  scopeLabel?: string;
  refreshing: boolean;
  onRefresh: () => void;
  primaryAction?: { label: string; onClick: () => void };
}> = ({ title, subtitle, scopeLabel, refreshing, onRefresh, primaryAction }) => (
  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-white border border-slate-200 rounded-lg px-5 py-4">
    <div className="min-w-0">
      <h1 className="font-display text-base font-bold text-slate-900 truncate">{title}</h1>
      <p className="text-xs text-slate-500 mt-0.5 truncate">
        {subtitle}
        {scopeLabel ? ` · ${scopeLabel}` : ''}
      </p>
    </div>
    <div className="flex items-center gap-2 shrink-0">
      <button
        type="button"
        onClick={onRefresh}
        disabled={refreshing}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-200 hover:bg-slate-50 rounded-md whitespace-nowrap shrink-0 disabled:opacity-60"
      >
        <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
        <span>Refresh</span>
      </button>
      {primaryAction && (
        <button
          type="button"
          onClick={primaryAction.onClick}
          className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium bg-teal-700 hover:bg-teal-800 text-white rounded-md whitespace-nowrap shrink-0"
        >
          <span>{primaryAction.label}</span>
        </button>
      )}
    </div>
  </div>
);
