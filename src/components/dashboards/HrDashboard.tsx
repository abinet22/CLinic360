import React, { useCallback, useEffect, useState } from 'react';
import { ArrowRight, Briefcase, CalendarClock, Clock, Users } from 'lucide-react';
import { apiFetch } from '../../lib/api';
import { useAuth } from '../../lib/authContext';
import { useRealtimeSync } from '../../lib/useRealtimeSync';
import {
  DashboardHeader,
  DashboardSkeleton,
  fmtMoney,
  statusTextTone,
  type RoleDashboardProps,
} from './DashboardPrimitives';

interface HrDashboardData {
  metrics: {
    activeEmployees: number;
    inactiveEmployees: number;
    presentToday: number;
    lateToday: number;
    pendingLeaves: number;
    pendingOvertime: number;
    openPayrollRuns: number;
  };
  departmentBreakdown: Array<{
    department_name: string;
    staff_count: number;
  }>;
  pendingLeaveRequests: Array<{
    id: number;
    leave_type: string;
    start_date: string;
    end_date: string;
    days_count: number;
    reason: string;
    status: string;
    staff_name: string;
    department_name: string | null;
  }>;
  pendingOvertimeList: Array<{
    id: number;
    overtime_date: string;
    hours: number;
    day_type: string;
    computed_amount: number;
    staff_name: string;
    department_name: string;
  }>;
  recentPayrollRuns: Array<{
    id: number;
    run_number: string;
    pay_month: string;
    total_gross: number;
    total_net: number;
    status: string;
  }>;
}

export const HrDashboard: React.FC<RoleDashboardProps> = ({ onNavigate }) => {
  const { hasAnyPermission } = useAuth();
  const [data, setData] = useState<HrDashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadData = useCallback((isManual = false) => {
    if (isManual) setRefreshing(true);
    apiFetch<HrDashboardData>('/api/dashboard/hr')
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

  useRealtimeSync(['hr:updated'], () => loadData());

  if (loading) return <DashboardSkeleton />;

  const m = data?.metrics;

  return (
    <div className="space-y-6">
      <DashboardHeader
        title="Human Resources Workspace"
        subtitle="Official clinic staff register, attendance monitoring, leave & overtime approvals, and payroll readiness"
        refreshing={refreshing}
        onRefresh={() => loadData(true)}
        primaryAction={{
          label: 'Open HR & Staff Register',
          onClick: () => onNavigate('hr'),
        }}
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 bg-white border border-slate-200 rounded-lg divide-y sm:divide-y-0 sm:divide-x divide-slate-200">
        <div className="p-5">
          <div className="text-xs font-medium text-slate-500 flex items-center justify-between">
            <span>Active Clinic Staff</span>
            <Users className="w-4 h-4 text-teal-700" />
          </div>
          <div className="font-display text-2xl font-bold text-slate-900 mt-1 tabular-nums">
            {m?.activeEmployees ?? 0}
          </div>
          <div className="text-xs text-slate-500 mt-1 tabular-nums">
            {m?.inactiveEmployees ?? 0} inactive / terminated
          </div>
        </div>

        <div className="p-5">
          <div className="text-xs font-medium text-slate-500 flex items-center justify-between">
            <span>Today&apos;s Attendance</span>
            <Clock className="w-4 h-4 text-emerald-700" />
          </div>
          <div className="font-display text-2xl font-bold text-slate-900 mt-1 tabular-nums">
            {m?.presentToday ?? 0}
          </div>
          <div className="text-xs text-slate-500 mt-1 tabular-nums">
            {m?.lateToday ?? 0} late arrivals recorded today
          </div>
        </div>

        <div className="p-5">
          <div className="text-xs font-medium text-slate-500 flex items-center justify-between">
            <span>Pending Approvals</span>
            <CalendarClock className="w-4 h-4 text-amber-600" />
          </div>
          <div className="font-display text-2xl font-bold text-slate-900 mt-1 tabular-nums">
            {(m?.pendingLeaves ?? 0) + (m?.pendingOvertime ?? 0)}
          </div>
          <div className="text-xs text-slate-500 mt-1 tabular-nums">
            {m?.pendingLeaves ?? 0} leave · {m?.pendingOvertime ?? 0} overtime requests
          </div>
        </div>

        <div className="p-5">
          <div className="text-xs font-medium text-slate-500 flex items-center justify-between">
            <span>Open Payroll Runs</span>
            <Briefcase className="w-4 h-4 text-slate-500" />
          </div>
          <div className="font-display text-2xl font-bold text-slate-900 mt-1 tabular-nums">
            {m?.openPayrollRuns ?? 0}
          </div>
          <div className="text-xs text-slate-500 mt-1">In draft / verification workflow</div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
            <div>
              <h2 className="font-display text-sm font-semibold text-slate-900">Pending Leave & Overtime Requests</h2>
              <p className="text-xs text-slate-500">Staff requests awaiting HR approval</p>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('hr')}
              className="text-xs font-medium text-teal-700 hover:text-teal-800 inline-flex items-center gap-1 whitespace-nowrap"
            >
              <span>Review in HR</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="divide-y divide-slate-100">
            {!data?.pendingLeaveRequests?.length && !data?.pendingOvertimeList?.length ? (
              <div className="p-6 text-center text-xs text-slate-500">
                No pending leave or overtime approvals.
              </div>
            ) : (
              <>
                {data.pendingLeaveRequests.slice(0, 5).map((lr) => (
                  <div key={`lr-${lr.id}`} className="px-5 py-3 flex items-center justify-between gap-3 text-xs">
                    <div className="min-w-0">
                      <div className="font-medium text-slate-900 truncate">
                        {lr.staff_name} · {lr.leave_type} leave ({lr.days_count}d)
                      </div>
                      <div className="text-slate-500 truncate mt-0.5">
                        {lr.start_date} to {lr.end_date} · {lr.department_name || 'Clinic Staff'}
                      </div>
                    </div>
                    <span className="text-amber-700 font-semibold shrink-0">Pending Leave</span>
                  </div>
                ))}
                {data.pendingOvertimeList.slice(0, 4).map((ot) => (
                  <div key={`ot-${ot.id}`} className="px-5 py-3 flex items-center justify-between gap-3 text-xs">
                    <div className="min-w-0">
                      <div className="font-medium text-slate-900 truncate">
                        {ot.staff_name} · {ot.hours}h ({ot.day_type})
                      </div>
                      <div className="text-slate-500 truncate mt-0.5">
                        {ot.overtime_date} · {ot.department_name}
                      </div>
                    </div>
                    <span className="font-mono text-amber-700 font-semibold shrink-0">
                      {fmtMoney(ot.computed_amount)}
                    </span>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
            <div>
              <h2 className="font-display text-sm font-semibold text-slate-900">Department Headcount & Payroll Runs</h2>
              <p className="text-xs text-slate-500">Active staff distribution and recent monthly runs</p>
            </div>
            {hasAnyPermission('hr.payroll.submit', 'hr.payroll.verify', 'hr.payroll.approve', 'finance.payroll.generate') && (
              <button
                type="button"
                onClick={() => onNavigate('hr', 'payroll')}
                className="text-xs font-medium text-teal-700 hover:text-teal-800 inline-flex items-center gap-1 whitespace-nowrap"
              >
                <span>Payroll Runs</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          <div className="divide-y divide-slate-100">
            {data?.departmentBreakdown?.slice(0, 5).map((dept) => (
              <div key={dept.department_name} className="px-5 py-2.5 flex items-center justify-between text-xs">
                <span className="font-medium text-slate-800">{dept.department_name}</span>
                <span className="font-mono text-slate-700 tabular-nums">{dept.staff_count} active</span>
              </div>
            ))}
            {data?.recentPayrollRuns?.slice(0, 3).map((run) => (
              <div key={run.id} className="px-5 py-2.5 flex items-center justify-between text-xs bg-slate-50/50">
                <div>
                  <span className="font-mono font-medium text-slate-900">{run.run_number}</span>{' '}
                  <span className="text-slate-500">· {run.pay_month}</span>
                </div>
                <div className="text-right">
                  <span className="font-mono text-slate-900 tabular-nums mr-2">{fmtMoney(run.total_net)}</span>
                  <span className={statusTextTone(run.status)}>{run.status}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
