import React, { useCallback, useEffect, useState } from 'react';
import { ArrowRight, Calendar, FlaskConical, Stethoscope, Users } from 'lucide-react';
import { apiFetch } from '../../lib/api';
import { useAuth } from '../../lib/authContext';
import { useRealtimeSync } from '../../lib/useRealtimeSync';
import {
  DashboardHeader,
  DashboardSkeleton,
  statusTextTone,
  type RoleDashboardProps,
} from './DashboardPrimitives';

interface DoctorDashboardData {
  doctorScoped: boolean;
  metrics: {
    assignedPatients: number;
    waitingQueue: number;
    activeConsultations: number;
    resultsReady: number;
    todayAppointments: number;
    pendingLabs: number;
    pendingImaging: number;
  };
  assignedQueue: Array<{
    visit_id: number;
    visit_number: string;
    triage_priority: string;
    workflow_stage: string;
    chief_complaint: string | null;
    status: string;
    patient_id: number;
    mrn: string;
    first_name: string;
    last_name: string;
    ticket_number: string | null;
    bp_systolic: number | null;
    bp_diastolic: number | null;
    temperature: number | null;
    spo2: number | null;
    early_warning_flag: number | null;
  }>;
  todayAppointments: Array<{
    id: number;
    appointment_date: string;
    start_time: string;
    end_time: string;
    visit_type: string;
    status: string;
    mrn: string;
    first_name: string;
    last_name: string;
  }>;
  recentConsultations: Array<{
    id: number;
    visit_number: string;
    diagnosis_code: string | null;
    diagnosis_text: string | null;
    status: string;
    workflow_stage: string;
    mrn: string;
    first_name: string;
    last_name: string;
  }>;
  pendingLabResults: Array<{
    id: number;
    visit_id: number;
    status: string;
    abnormal_flag: string | null;
    result_value: string | null;
    test_code: string;
    test_name: string;
    unit: string | null;
    mrn: string;
    first_name: string;
    last_name: string;
  }>;
  pendingImagingResults: Array<{
    id: number;
    visit_id: number;
    status: string;
    impression: string | null;
    exam_code: string;
    exam_name: string;
    modality: string;
    mrn: string;
    first_name: string;
    last_name: string;
  }>;
}

export const DoctorDashboard: React.FC<RoleDashboardProps> = ({ onNavigate }) => {
  const { user } = useAuth();
  const [data, setData] = useState<DoctorDashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadData = useCallback((isManual = false) => {
    if (isManual) setRefreshing(true);
    apiFetch<DoctorDashboardData>('/api/dashboard/doctor')
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

  useRealtimeSync(
    ['visit:updated', 'queue:updated', 'lab:updated', 'imaging:updated', 'appointment:updated'],
    () => loadData()
  );

  if (loading) return <DashboardSkeleton />;

  const m = data?.metrics;

  return (
    <div className="space-y-6">
      <DashboardHeader
        title="Physician Clinical Dashboard"
        subtitle={`Assigned OPD caseload for ${user.fullName}`}
        scopeLabel="Strict Doctor-Patient Scope"
        refreshing={refreshing}
        onRefresh={() => loadData(true)}
        primaryAction={{
          label: 'Open OPD Consultations',
          onClick: () => onNavigate('clinical', 'consultations'),
        }}
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 bg-white border border-slate-200 rounded-lg divide-y sm:divide-y-0 sm:divide-x divide-slate-200">
        <div className="p-5">
          <div className="text-xs font-medium text-slate-500 flex items-center justify-between">
            <span>My Waiting Queue</span>
            <Stethoscope className="w-4 h-4 text-teal-700" />
          </div>
          <div className="font-display text-2xl font-bold text-slate-900 mt-1 tabular-nums">
            {m?.waitingQueue ?? 0}
          </div>
          <div className="text-xs text-slate-500 mt-1 tabular-nums">
            {m?.activeConsultations ?? 0} open visits · {m?.resultsReady ?? 0} results ready
          </div>
        </div>

        <div className="p-5">
          <div className="text-xs font-medium text-slate-500 flex items-center justify-between">
            <span>My Assigned Patients</span>
            <Users className="w-4 h-4 text-slate-500" />
          </div>
          <div className="font-display text-2xl font-bold text-slate-900 mt-1 tabular-nums">
            {m?.assignedPatients ?? 0}
          </div>
          <div className="text-xs text-slate-500 mt-1">Active clinic panel</div>
        </div>

        <div className="p-5">
          <div className="text-xs font-medium text-slate-500 flex items-center justify-between">
            <span>Today&apos;s Appointments</span>
            <Calendar className="w-4 h-4 text-slate-500" />
          </div>
          <div className="font-display text-2xl font-bold text-slate-900 mt-1 tabular-nums">
            {m?.todayAppointments ?? 0}
          </div>
          <div className="text-xs text-slate-500 mt-1">Scheduled OPD slots</div>
        </div>

        <div className="p-5">
          <div className="text-xs font-medium text-slate-500 flex items-center justify-between">
            <span>Pending Diagnostics</span>
            <FlaskConical className="w-4 h-4 text-amber-600" />
          </div>
          <div className="font-display text-2xl font-bold text-slate-900 mt-1 tabular-nums">
            {(m?.pendingLabs ?? 0) + (m?.pendingImaging ?? 0)}
          </div>
          <div className="text-xs text-slate-500 mt-1 tabular-nums">
            {m?.pendingLabs ?? 0} lab · {m?.pendingImaging ?? 0} imaging orders
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
            <div>
              <h2 className="font-display text-sm font-semibold text-slate-900">Assigned Consultation Queue</h2>
              <p className="text-xs text-slate-500">Patients assigned directly to you, prioritized by triage</p>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('clinical', 'consultations')}
              className="text-xs font-medium text-teal-700 hover:text-teal-800 inline-flex items-center gap-1 whitespace-nowrap"
            >
              <span>Consult</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="divide-y divide-slate-100">
            {!data?.assignedQueue?.length ? (
              <div className="p-6 text-center space-y-2">
                <p className="text-xs text-slate-500">No patients currently waiting in your assigned queue.</p>
                <button
                  type="button"
                  onClick={() => onNavigate('patients', 'patients')}
                  className="px-3 py-1.5 text-xs font-medium border border-slate-200 hover:bg-slate-50 rounded-md text-slate-700"
                >
                  Browse My Patient Panel
                </button>
              </div>
            ) : (
              data.assignedQueue.map((v) => (
                <div key={v.visit_id} className="px-5 py-3 flex items-center justify-between gap-3 text-xs">
                  <div className="min-w-0">
                    <div className="font-medium text-slate-900 truncate">
                      {v.first_name} {v.last_name}{' '}
                      <span className="font-mono text-slate-400">· {v.mrn}</span>
                    </div>
                    <div className="text-slate-500 truncate mt-0.5">
                      {v.ticket_number ? `${v.ticket_number} · ` : ''}
                      {v.chief_complaint || 'OPD evaluation'}
                      {v.bp_systolic != null ? ` · BP ${v.bp_systolic}/${v.bp_diastolic}` : ''}
                      {v.spo2 != null ? ` · SpO2 ${v.spo2}%` : ''}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className={statusTextTone(v.triage_priority)}>{v.triage_priority}</div>
                    <div className="font-mono text-[11px] text-slate-400 mt-0.5">{v.workflow_stage}</div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
            <div>
              <h2 className="font-display text-sm font-semibold text-slate-900">Diagnostic Orders & Results</h2>
              <p className="text-xs text-slate-500">Lab and radiology updates for your assigned visits</p>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('clinical', 'lab_requests')}
              className="text-xs font-medium text-teal-700 hover:text-teal-800 inline-flex items-center gap-1 whitespace-nowrap"
            >
              <span>Order / Review</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="divide-y divide-slate-100">
            {!data?.pendingLabResults?.length && !data?.pendingImagingResults?.length ? (
              <div className="p-6 text-center text-xs text-slate-500">
                No pending or recently verified lab or imaging orders.
              </div>
            ) : (
              <>
                {data.pendingLabResults.slice(0, 5).map((lab) => (
                  <div key={`lab-${lab.id}`} className="px-5 py-3 flex items-center justify-between gap-3 text-xs">
                    <div className="min-w-0">
                      <div className="font-medium text-slate-900 truncate">
                        {lab.test_name} <span className="font-mono text-slate-400">· {lab.test_code}</span>
                      </div>
                      <div className="text-slate-500 truncate mt-0.5">
                        {lab.first_name} {lab.last_name} ({lab.mrn})
                        {lab.result_value ? ` · ${lab.result_value} ${lab.unit || ''}` : ''}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className={statusTextTone(lab.abnormal_flag === 'critical' ? 'critical' : lab.status)}>
                        {lab.abnormal_flag && lab.abnormal_flag !== 'normal'
                          ? `${lab.status} (${lab.abnormal_flag})`
                          : lab.status}
                      </div>
                    </div>
                  </div>
                ))}
                {data.pendingImagingResults.slice(0, 4).map((img) => (
                  <div key={`img-${img.id}`} className="px-5 py-3 flex items-center justify-between gap-3 text-xs">
                    <div className="min-w-0">
                      <div className="font-medium text-slate-900 truncate">
                        {img.exam_name} <span className="font-mono text-slate-400">· {img.modality}</span>
                      </div>
                      <div className="text-slate-500 truncate mt-0.5">
                        {img.first_name} {img.last_name} ({img.mrn})
                        {img.impression ? ` · ${img.impression}` : ''}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className={statusTextTone(img.status)}>{img.status}</div>
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
          <h2 className="font-display text-sm font-semibold text-slate-900">Upcoming Assigned Appointments</h2>
          <button
            type="button"
            onClick={() => onNavigate('appointments')}
            className="text-xs font-medium text-teal-700 hover:text-teal-800 inline-flex items-center gap-1 whitespace-nowrap"
          >
            <span>My Schedule</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="divide-y divide-slate-100">
          {!data?.todayAppointments?.length ? (
            <div className="p-6 text-center text-xs text-slate-500">No upcoming appointments assigned.</div>
          ) : (
            data.todayAppointments.map((appt) => (
              <div key={appt.id} className="px-5 py-3 flex items-center justify-between gap-3 text-xs">
                <div className="min-w-0">
                  <div className="font-medium text-slate-900 truncate">
                    {appt.first_name} {appt.last_name}{' '}
                    <span className="font-mono text-slate-400">· {appt.mrn}</span>
                  </div>
                  <div className="text-slate-500 truncate mt-0.5">{appt.visit_type}</div>
                </div>
                <div className="text-right shrink-0">
                  <div className="font-mono text-slate-900 tabular-nums">
                    {appt.appointment_date} {appt.start_time}
                  </div>
                  <div className={`text-[11px] mt-0.5 ${statusTextTone(appt.status)}`}>{appt.status}</div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};
