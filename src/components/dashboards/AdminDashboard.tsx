import React, { useCallback, useEffect, useState } from 'react';
import { ArrowRight, Building2, Lock, ShieldCheck, Users } from 'lucide-react';
import { apiFetch } from '../../lib/api';
import { useAuth } from '../../lib/authContext';
import { useRealtimeSync } from '../../lib/useRealtimeSync';
import {
  DashboardHeader,
  DashboardSkeleton,
  fmtShortTime,
  statusTextTone,
  type RoleDashboardProps,
} from './DashboardPrimitives';

interface AdminDashboardData {
  metrics: {
    totalUsers: number;
    activeUsers: number;
    inactiveUsers: number;
    lockedUsers: number;
    activeHrEmployees: number;
    unlinkedHrEmployees: number;
    accessReviewAlerts: number;
    totalRoles: number;
    activeDepartments: number;
    activeRooms: number;
    activeSessions: number;
    auditEvents24h: number;
  };
  auditIntegrity: {
    valid: boolean;
    totalRows: number;
    brokenAtId: number | null;
  };
  recentAudits: Array<{
    id: number;
    occurred_at: string;
    user_name: string;
    role_at_time: string;
    action: string;
    entity_type: string;
    entity_id: string | null;
    reason: string | null;
  }>;
  accessReviewQueue: Array<{
    employee_id: number;
    employee_number: string;
    full_name: string;
    department_name: string;
    job_position: string;
    hr_status: string;
    access_review_required: number;
    terminated_at: string | null;
    user_id: number | null;
    email: string | null;
    user_active: number | null;
    user_status: string | null;
  }>;
}

export const AdminDashboard: React.FC<RoleDashboardProps> = ({ onNavigate }) => {
  const { hasPermission } = useAuth();
  const [data, setData] = useState<AdminDashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadData = useCallback((isManual = false) => {
    if (isManual) setRefreshing(true);
    apiFetch<AdminDashboardData>('/api/dashboard/admin')
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

  useRealtimeSync(['audit:updated', 'hr:updated', 'admin:updated'], () => loadData());

  if (loading) return <DashboardSkeleton />;

  const m = data?.metrics;

  return (
    <div className="space-y-6">
      <DashboardHeader
        title="System Administration Dashboard"
        subtitle="Identity governance, HR-to-User integration, clinic configuration, and audit chain integrity"
        scopeLabel={`${m?.activeSessions ?? 0} Active Sessions`}
        refreshing={refreshing}
        onRefresh={() => loadData(true)}
        primaryAction={
          hasPermission('admin.user.manage')
            ? { label: 'Manage User Accounts', onClick: () => onNavigate('governance', 'users') }
            : undefined
        }
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 bg-white border border-slate-200 rounded-lg divide-y sm:divide-y-0 sm:divide-x divide-slate-200">
        <div className="p-5">
          <div className="text-xs font-medium text-slate-500 flex items-center justify-between">
            <span>Active System Users</span>
            <Users className="w-4 h-4 text-teal-700" />
          </div>
          <div className="font-display text-2xl font-bold text-slate-900 mt-1 tabular-nums">
            {m?.activeUsers ?? 0}
            <span className="text-sm font-normal text-slate-400"> / {m?.totalUsers ?? 0}</span>
          </div>
          <div className="text-xs text-slate-500 mt-1 tabular-nums">
            {m?.inactiveUsers ?? 0} inactive · {m?.lockedUsers ?? 0} locked
          </div>
        </div>

        <div className="p-5">
          <div className="text-xs font-medium text-slate-500 flex items-center justify-between">
            <span>HR Access Governance</span>
            <Lock className="w-4 h-4 text-amber-600" />
          </div>
          <div className="font-display text-2xl font-bold text-slate-900 mt-1 tabular-nums">
            {m?.accessReviewAlerts ?? 0}
          </div>
          <div className="text-xs text-slate-500 mt-1 tabular-nums">
            Access review flags · {m?.unlinkedHrEmployees ?? 0} unlinked active HR staff
          </div>
        </div>

        <div className="p-5">
          <div className="text-xs font-medium text-slate-500 flex items-center justify-between">
            <span>Clinic Structure</span>
            <Building2 className="w-4 h-4 text-slate-500" />
          </div>
          <div className="font-display text-2xl font-bold text-slate-900 mt-1 tabular-nums">
            {m?.activeDepartments ?? 0} Depts
          </div>
          <div className="text-xs text-slate-500 mt-1 tabular-nums">
            {m?.activeRooms ?? 0} clinic units · {m?.totalRoles ?? 0} RBAC roles
          </div>
        </div>

        <div className="p-5">
          <div className="text-xs font-medium text-slate-500 flex items-center justify-between">
            <span>Audit Hash Chain</span>
            <ShieldCheck className="w-4 h-4 text-emerald-700" />
          </div>
          <div
            className={`font-display text-2xl font-bold mt-1 ${
              data?.auditIntegrity?.valid ? 'text-emerald-700' : 'text-red-700'
            }`}
          >
            {data?.auditIntegrity?.valid ? 'Verified' : 'Broken'}
          </div>
          <div className="text-xs text-slate-500 mt-1 tabular-nums">
            {m?.auditEvents24h ?? 0} events (24h) · {data?.auditIntegrity?.totalRows ?? 0} total rows
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
            <div>
              <h2 className="font-display text-sm font-semibold text-slate-900">HR Integration & Access Review</h2>
              <p className="text-xs text-slate-500">Employees requiring account provisioning or offboarding check</p>
            </div>
            {hasPermission('admin.user.manage') && (
              <button
                type="button"
                onClick={() => onNavigate('governance', 'users')}
                className="text-xs font-medium text-teal-700 hover:text-teal-800 inline-flex items-center gap-1 whitespace-nowrap"
              >
                <span>Open Users</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          <div className="divide-y divide-slate-100">
            {!data?.accessReviewQueue?.length ? (
              <div className="p-6 text-center space-y-2">
                <p className="text-xs text-slate-500">All HR staff links and access reviews are up to date.</p>
                {hasPermission('admin.role.manage') && (
                  <button
                    type="button"
                    onClick={() => onNavigate('governance', 'roles')}
                    className="px-3 py-1.5 text-xs font-medium border border-slate-200 hover:bg-slate-50 rounded-md text-slate-700"
                  >
                    Review Roles & Permissions
                  </button>
                )}
              </div>
            ) : (
              data.accessReviewQueue.map((item) => (
                <div key={item.employee_id} className="px-5 py-3 flex items-center justify-between gap-3 text-xs">
                  <div className="min-w-0">
                    <div className="font-medium text-slate-900 truncate">
                      {item.full_name} <span className="font-mono text-slate-400">· {item.employee_number}</span>
                    </div>
                    <div className="text-slate-500 truncate mt-0.5">
                      {item.department_name} · {item.job_position}
                      {item.email ? ` · ${item.email}` : ' · No login account'}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className={item.access_review_required ? 'text-amber-700 font-semibold' : statusTextTone(item.hr_status)}>
                      {item.access_review_required ? 'Review Required' : 'Unlinked HR'}
                    </div>
                    <div className="font-mono text-[11px] text-slate-400 mt-0.5">HR: {item.hr_status}</div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
            <div>
              <h2 className="font-display text-sm font-semibold text-slate-900">Recent Audit Activity</h2>
              <p className="text-xs text-slate-500">Immutable cryptographic trail of system and clinical actions</p>
            </div>
            {hasPermission('audit.read') && (
              <button
                type="button"
                onClick={() => onNavigate('governance', 'audit')}
                className="text-xs font-medium text-teal-700 hover:text-teal-800 inline-flex items-center gap-1 whitespace-nowrap"
              >
                <span>Audit Log</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          <div className="divide-y divide-slate-100">
            {!data?.recentAudits?.length ? (
              <div className="p-6 text-center text-xs text-slate-500">No audit events recorded yet.</div>
            ) : (
              data.recentAudits.map((row) => (
                <div key={row.id} className="px-5 py-2.5 flex items-center justify-between gap-3 text-xs">
                  <div className="min-w-0">
                    <div className="font-mono text-slate-900 truncate">{row.action}</div>
                    <div className="text-slate-500 truncate mt-0.5">
                      {row.user_name} · {row.role_at_time} · {row.entity_type}
                      {row.entity_id ? ` #${row.entity_id}` : ''}
                    </div>
                  </div>
                  <div className="font-mono text-[11px] text-slate-400 shrink-0 tabular-nums">
                    {fmtShortTime(row.occurred_at)}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-lg p-5">
        <div className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-3">
          Administration Shortcuts
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
          {hasPermission('admin.user.manage') && (
            <button
              type="button"
              onClick={() => onNavigate('governance', 'users')}
              className="px-3.5 py-2.5 border border-slate-200 hover:border-teal-600 hover:bg-teal-50/40 rounded-md text-left font-medium text-slate-800 whitespace-nowrap"
            >
              Provision User from HR
            </button>
          )}
          {(hasPermission('admin.role.manage') || hasPermission('admin.user.manage')) && (
            <button
              type="button"
              onClick={() => onNavigate('governance', 'roles')}
              className="px-3.5 py-2.5 border border-slate-200 hover:border-teal-600 hover:bg-teal-50/40 rounded-md text-left font-medium text-slate-800 whitespace-nowrap"
            >
              Configure Role Matrix
            </button>
          )}
          {hasPermission('admin.config.manage') && (
            <button
              type="button"
              onClick={() => onNavigate('governance', 'clinic_config')}
              className="px-3.5 py-2.5 border border-slate-200 hover:border-teal-600 hover:bg-teal-50/40 rounded-md text-left font-medium text-slate-800 whitespace-nowrap"
            >
              Departments & Rooms
            </button>
          )}
          {(hasPermission('admin.backup.manage') || hasPermission('admin.user.manage')) && (
            <button
              type="button"
              onClick={() => onNavigate('governance', 'backup')}
              className="px-3.5 py-2.5 border border-slate-200 hover:border-teal-600 hover:bg-teal-50/40 rounded-md text-left font-medium text-slate-800 whitespace-nowrap"
            >
              Backup & Maintenance
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
