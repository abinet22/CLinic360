import React, { useCallback, useEffect, useState } from 'react';
import { ArrowRight, BedDouble, BookOpen, Briefcase, Calendar, ClipboardList, CreditCard, FlaskConical, Package, Pill, Scan, Users } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { useRealtimeSync } from '../lib/useRealtimeSync';
import type { UserContext } from '../types';

interface DashboardData {
  metrics: {
    totalPatients: number;
    todayAppointments: number;
    activeQueue: number;
    openVisits: number;
    pendingLabs: number;
    pendingImaging: number;
    pendingPrescriptions: number;
    pendingApprovals: number;
    occupiedBeds: number;
    totalBeds: number;
    revenueTotal: number | null;
    unpaidBalance: number | null;
  };
  recentQueue: Array<{
    id: number;
    ticket_number: string;
    department: string;
    priority: string;
    status: string;
    mrn: string;
    first_name: string;
    last_name: string;
  }>;
  upcomingAppointments: Array<{
    id: number;
    appointment_date: string;
    start_time: string;
    end_time: string;
    visit_type: string;
    status: string;
    mrn: string;
    first_name: string;
    last_name: string;
    doctor_name: string;
  }>;
}

interface DashboardViewProps {
  user: UserContext;
  onNavigate: (tab: string) => void;
}

export const DashboardView: React.FC<DashboardViewProps> = ({ user, onNavigate }) => {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);

  const loadDashboard = useCallback(() => {
    apiFetch<DashboardData>('/api/dashboard')
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    setLoading(true);
    loadDashboard();
  }, [loadDashboard]);

  useRealtimeSync(
    ['visit:updated', 'queue:updated', 'payment:confirmed', 'lab:updated', 'imaging:updated', 'pharmacy:updated'],
    () => {
      loadDashboard();
    }
  );

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 border border-slate-200 rounded-lg bg-white divide-y sm:divide-y-0 sm:divide-x divide-slate-200">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="p-5 animate-pulse">
              <div className="h-3 w-24 bg-slate-200 rounded mb-3" />
              <div className="h-7 w-16 bg-slate-200 rounded" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  const m = data?.metrics;

  return (
    <div className="space-y-6">
      {/* Primary KPI Grid - Single Flat Elevation */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 bg-white border border-slate-200 rounded-lg divide-y sm:divide-y-0 sm:divide-x divide-slate-200">
        <div className="p-5">
          <div className="text-xs font-medium text-slate-500">Registered Patients</div>
          <div className="mt-2 font-mono text-2xl font-semibold text-slate-900 tabular-nums">
            {m?.totalPatients ?? 0}
          </div>
          <div className="mt-1 text-xs text-slate-500">Active clinic registry</div>
        </div>

        <div className="p-5">
          <div className="text-xs font-medium text-slate-500">Today Appointments &amp; Queue</div>
          <div className="mt-2 font-mono text-2xl font-semibold text-slate-900 tabular-nums">
            {m?.todayAppointments ?? 0} <span className="text-sm font-normal text-slate-400">/ {m?.activeQueue ?? 0} waiting</span>
          </div>
          <div className="mt-1 text-xs text-slate-500">OPD &amp; diagnostics flow</div>
        </div>

        <div className="p-5">
          <div className="text-xs font-medium text-slate-500">Clinical Orders &amp; Ward Beds</div>
          <div className="mt-2 font-mono text-2xl font-semibold text-slate-900 tabular-nums">
            {(m?.pendingLabs ?? 0) + (m?.pendingImaging ?? 0) + (m?.pendingPrescriptions ?? 0)}
            <span className="text-sm font-normal text-slate-400"> · {m?.occupiedBeds ?? 0}/{m?.totalBeds ?? 0} beds</span>
          </div>
          <div className="mt-1 text-xs text-slate-500">
            {m?.pendingLabs ?? 0} Lab · {m?.pendingImaging ?? 0} Imaging · {m?.pendingPrescriptions ?? 0} Rx
          </div>
        </div>

        <div className="p-5">
          {m?.revenueTotal !== null && m?.revenueTotal !== undefined ? (
            <>
              <div className="text-xs font-medium text-slate-500">Collected / Unpaid Balance</div>
              <div className="mt-2 font-mono text-2xl font-semibold text-slate-900 tabular-nums">
                ${m.revenueTotal.toFixed(2)}
              </div>
              <div className="mt-1 text-xs text-amber-700 font-mono tabular-nums">
                ${(m.unpaidBalance ?? 0).toFixed(2)} outstanding · {m.pendingApprovals} approvals
              </div>
            </>
          ) : (
            <>
              <div className="text-xs font-medium text-slate-500">Open Clinical Visits</div>
              <div className="mt-2 font-mono text-2xl font-semibold text-slate-900 tabular-nums">
                {m?.openVisits ?? 0}
              </div>
              <div className="mt-1 text-xs text-slate-500">Financial figures restricted</div>
            </>
          )}
        </div>
      </div>

      {/* Quick Workflow Access */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {user.permissions.includes('patient.read') && (
          <button
            onClick={() => onNavigate('patients')}
            className="text-left p-4 bg-white border border-slate-200 hover:border-teal-600 rounded-lg transition-colors"
          >
            <Users className="w-4 h-4 text-teal-700 mb-2" />
            <div className="text-sm font-medium text-slate-900">Patients &amp; Queue</div>
            <div className="text-xs text-slate-500 mt-0.5">MRN &amp; intake</div>
          </button>
        )}
        {user.permissions.includes('appointment.read') && (
          <button
            onClick={() => onNavigate('appointments')}
            className="text-left p-4 bg-white border border-slate-200 hover:border-teal-600 rounded-lg transition-colors"
          >
            <Calendar className="w-4 h-4 text-teal-700 mb-2" />
            <div className="text-sm font-medium text-slate-900">Appointments</div>
            <div className="text-xs text-slate-500 mt-0.5">Schedules &amp; check-in</div>
          </button>
        )}
        {(user.permissions.includes('visit.read') || user.permissions.includes('vitals.read')) && (
          <button
            onClick={() => onNavigate('clinical')}
            className="text-left p-4 bg-white border border-slate-200 hover:border-teal-600 rounded-lg transition-colors"
          >
            <ClipboardList className="w-4 h-4 text-teal-700 mb-2" />
            <div className="text-sm font-medium text-slate-900">Triage &amp; OPD</div>
            <div className="text-xs text-slate-500 mt-0.5">Vitals &amp; consults</div>
          </button>
        )}
        {user.permissions.includes('lab.order.read') && (
          <button
            onClick={() => onNavigate('diagnostics')}
            className="text-left p-4 bg-white border border-slate-200 hover:border-teal-600 rounded-lg transition-colors"
          >
            <FlaskConical className="w-4 h-4 text-teal-700 mb-2" />
            <div className="text-sm font-medium text-slate-900">Laboratory</div>
            <div className="text-xs text-slate-500 mt-0.5">Samples &amp; 2-person verify</div>
          </button>
        )}
        {user.permissions.includes('imaging.order.read') && (
          <button
            onClick={() => onNavigate('diagnostics')}
            className="text-left p-4 bg-white border border-slate-200 hover:border-teal-600 rounded-lg transition-colors"
          >
            <Scan className="w-4 h-4 text-teal-700 mb-2" />
            <div className="text-sm font-medium text-slate-900">Imaging</div>
            <div className="text-xs text-slate-500 mt-0.5">X-ray, US &amp; reports</div>
          </button>
        )}
        {user.permissions.includes('pharmacy.prescription.read') && (
          <button
            onClick={() => onNavigate('diagnostics')}
            className="text-left p-4 bg-white border border-slate-200 hover:border-teal-600 rounded-lg transition-colors"
          >
            <Pill className="w-4 h-4 text-teal-700 mb-2" />
            <div className="text-sm font-medium text-slate-900">Pharmacy</div>
            <div className="text-xs text-slate-500 mt-0.5">Dispense &amp; FEFO</div>
          </button>
        )}
        {user.permissions.includes('store.item.read') && (
          <button
            onClick={() => onNavigate('store')}
            className="text-left p-4 bg-white border border-slate-200 hover:border-teal-600 rounded-lg transition-colors"
          >
            <Package className="w-4 h-4 text-teal-700 mb-2" />
            <div className="text-sm font-medium text-slate-900">Store &amp; FEFO</div>
            <div className="text-xs text-slate-500 mt-0.5">GRN, batches &amp; expiry</div>
          </button>
        )}
        {user.permissions.includes('ipd.admission.read') && (
          <button
            onClick={() => onNavigate('ipd')}
            className="text-left p-4 bg-white border border-slate-200 hover:border-teal-600 rounded-lg transition-colors"
          >
            <BedDouble className="w-4 h-4 text-teal-700 mb-2" />
            <div className="text-sm font-medium text-slate-900">Inpatient &amp; Beds</div>
            <div className="text-xs text-slate-500 mt-0.5">Bed board &amp; MAR</div>
          </button>
        )}
        {user.permissions.includes('billing.invoice.read') && (
          <button
            onClick={() => onNavigate('billing')}
            className="text-left p-4 bg-white border border-slate-200 hover:border-teal-600 rounded-lg transition-colors"
          >
            <CreditCard className="w-4 h-4 text-teal-700 mb-2" />
            <div className="text-sm font-medium text-slate-900">Cashier &amp; Billing</div>
            <div className="text-xs text-slate-500 mt-0.5">Shifts &amp; receipts</div>
          </button>
        )}
        {(user.permissions.includes('finance.report.view') || user.permissions.includes('accounting.ledger.manage')) && (
          <button
            onClick={() => onNavigate('accounting')}
            className="text-left p-4 bg-white border border-slate-200 hover:border-teal-600 rounded-lg transition-colors"
          >
            <BookOpen className="w-4 h-4 text-teal-700 mb-2" />
            <div className="text-sm font-medium text-slate-900">Finance &amp; Reports</div>
            <div className="text-xs text-slate-500 mt-0.5">Ledger, P&amp;L &amp; CSV</div>
          </button>
        )}
        {(user.permissions.includes('hr.manage') || user.permissions.includes('hr.leave.request')) && (
          <button
            onClick={() => onNavigate('hr')}
            className="text-left p-4 bg-white border border-slate-200 hover:border-teal-600 rounded-lg transition-colors"
          >
            <Briefcase className="w-4 h-4 text-teal-700 mb-2" />
            <div className="text-sm font-medium text-slate-900">HR &amp; Payroll</div>
            <div className="text-xs text-slate-500 mt-0.5">Licences, leave &amp; pay</div>
          </button>
        )}
      </div>

      {/* Live Operations Split */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Active Queue */}
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
            <h2 className="font-display text-sm font-semibold text-slate-900">Active Department Queue</h2>
            {user.permissions.includes('patient.read') && (
              <button
                onClick={() => onNavigate('patients')}
                className="text-xs font-medium text-teal-700 hover:text-teal-800 inline-flex items-center gap-1"
              >
                <span>Open Queue</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          {!data?.recentQueue?.length ? (
            <div className="p-8 text-center text-sm text-slate-500">
              No patients currently waiting in queue.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 text-xs font-medium text-slate-500 bg-slate-50/60">
                    <th className="py-2.5 px-4">Ticket</th>
                    <th className="py-2.5 px-4">Patient</th>
                    <th className="py-2.5 px-4">Dept</th>
                    <th className="py-2.5 px-4">Priority / State</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-sm">
                  {data.recentQueue.map((q) => (
                    <tr key={q.id} className="hover:bg-slate-50/70">
                      <td className="py-2.5 px-4 font-mono text-xs font-medium text-slate-900 tabular-nums">
                        {q.ticket_number}
                      </td>
                      <td className="py-2.5 px-4">
                        <div className="font-medium text-slate-900">{q.first_name} {q.last_name}</div>
                        <div className="text-xs font-mono text-slate-500 tabular-nums">{q.mrn}</div>
                      </td>
                      <td className="py-2.5 px-4 text-xs text-slate-600 font-mono">{q.department}</td>
                      <td className="py-2.5 px-4 text-xs">
                        <span className={q.priority === 'emergency' ? 'text-red-700 font-semibold' : q.priority === 'urgent' ? 'text-amber-700 font-medium' : 'text-slate-600'}>
                          {q.priority}
                        </span>
                        <span className="mx-1.5 text-slate-300">·</span>
                        <span className="text-slate-600">{q.status.replace('_', ' ')}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Upcoming Appointments */}
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
            <h2 className="font-display text-sm font-semibold text-slate-900">Scheduled Appointments</h2>
            {user.permissions.includes('appointment.read') && (
              <button
                onClick={() => onNavigate('appointments')}
                className="text-xs font-medium text-teal-700 hover:text-teal-800 inline-flex items-center gap-1"
              >
                <span>View Schedule</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          {!data?.upcomingAppointments?.length ? (
            <div className="p-8 text-center text-sm text-slate-500">
              No upcoming appointments scheduled or accessible for your role.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 text-xs font-medium text-slate-500 bg-slate-50/60">
                    <th className="py-2.5 px-4">Date &amp; Time</th>
                    <th className="py-2.5 px-4">Patient</th>
                    <th className="py-2.5 px-4">Clinician</th>
                    <th className="py-2.5 px-4">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-sm">
                  {data.upcomingAppointments.map((a) => (
                    <tr key={a.id} className="hover:bg-slate-50/70">
                      <td className="py-2.5 px-4 font-mono text-xs text-slate-800 tabular-nums whitespace-nowrap">
                        {a.appointment_date} · {a.start_time}
                      </td>
                      <td className="py-2.5 px-4">
                        <div className="font-medium text-slate-900">{a.first_name} {a.last_name}</div>
                        <div className="text-xs font-mono text-slate-500">{a.mrn}</div>
                      </td>
                      <td className="py-2.5 px-4 text-xs text-slate-600">{a.doctor_name}</td>
                      <td className="py-2.5 px-4 text-xs">
                        <span className={a.status === 'checked_in' ? 'text-emerald-700 font-medium' : 'text-slate-700'}>
                          {a.status.replace('_', ' ')}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
