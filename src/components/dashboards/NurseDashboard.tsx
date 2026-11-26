import React, { useCallback, useEffect, useState } from 'react';
import { Activity, AlertTriangle, ArrowRight, BedDouble, Pill } from 'lucide-react';
import { apiFetch } from '../../lib/api';
import { useAuth } from '../../lib/authContext';
import { useRealtimeSync } from '../../lib/useRealtimeSync';
import {
  DashboardHeader,
  DashboardSkeleton,
  statusTextTone,
  type RoleDashboardProps,
} from './DashboardPrimitives';

interface NurseDashboardData {
  unitScoped: boolean;
  assignedUnits: Array<{ id: number; roomCode: string; name: string }>;
  metrics: {
    awaitingVitals: number;
    abnormalVitals: number;
    pendingProcedures: number;
    dueMedications: number;
    occupiedBeds: number;
    totalBeds: number;
  };
  triageQueue: Array<{
    visit_id: number;
    visit_number: string;
    triage_priority: string;
    workflow_stage: string;
    chief_complaint: string | null;
    specialty: string | null;
    mrn: string;
    first_name: string;
    last_name: string;
    ticket_number: string | null;
    doctor_name: string | null;
    vitals_count: number;
  }>;
  abnormalVitals: Array<{
    id: number;
    visit_id: number | null;
    bp_systolic: number | null;
    bp_diastolic: number | null;
    temperature: number | null;
    pulse: number | null;
    spo2: number | null;
    early_warning_flag: number;
    mrn: string;
    first_name: string;
    last_name: string;
  }>;
  dueMedications: Array<{
    id: number;
    medicine_name: string;
    dose: string;
    scheduled_time: string;
    mrn: string;
    first_name: string;
    last_name: string;
    ward_name: string | null;
    bed_number: string | null;
  }>;
  wardSnapshot: Array<{
    id: number;
    code: string;
    name: string;
    department: string;
    total_beds: number;
    occupied_beds: number;
    available_beds: number;
  }>;
}

export const NurseDashboard: React.FC<RoleDashboardProps> = ({ onNavigate }) => {
  const { hasPermission } = useAuth();
  const [data, setData] = useState<NurseDashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadData = useCallback((isManual = false) => {
    if (isManual) setRefreshing(true);
    apiFetch<NurseDashboardData>('/api/dashboard/nurse')
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
    ['visit:updated', 'queue:updated', 'payment:confirmed', 'ipd:updated'],
    () => loadData()
  );

  if (loading) return <DashboardSkeleton />;

  const m = data?.metrics;
  const scopeText =
    data?.unitScoped && data.assignedUnits.length > 0
      ? `Unit Scope: ${data.assignedUnits.map((u) => u.roomCode).join(', ')}`
      : 'Triage & Ward Nursing Station';

  return (
    <div className="space-y-6">
      <DashboardHeader
        title="Nursing & Triage Station"
        subtitle="OPD triage vitals queue, early warning clinical alerts, nursing procedures, and ward beds"
        scopeLabel={scopeText}
        refreshing={refreshing}
        onRefresh={() => loadData(true)}
        primaryAction={{
          label: 'Record Vital Signs',
          onClick: () => onNavigate('clinical', 'vitals_only'),
        }}
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 bg-white border border-slate-200 rounded-lg divide-y sm:divide-y-0 sm:divide-x divide-slate-200">
        <div className="p-5">
          <div className="text-xs font-medium text-slate-500 flex items-center justify-between">
            <span>Awaiting Vitals / Triage</span>
            <Activity className="w-4 h-4 text-teal-700" />
          </div>
          <div className="font-display text-2xl font-bold text-slate-900 mt-1 tabular-nums">
            {m?.awaitingVitals ?? 0}
          </div>
          <div className="text-xs text-slate-500 mt-1 tabular-nums">
            {m?.pendingProcedures ?? 0} pending procedures
          </div>
        </div>

        <div className="p-5">
          <div className="text-xs font-medium text-slate-500 flex items-center justify-between">
            <span>Abnormal Vitals Alerts</span>
            <AlertTriangle className="w-4 h-4 text-red-600" />
          </div>
          <div className="font-display text-2xl font-bold text-red-700 mt-1 tabular-nums">
            {m?.abnormalVitals ?? 0}
          </div>
          <div className="text-xs text-slate-500 mt-1">Flagged fever, hypoxia, BP, or pulse</div>
        </div>

        <div className="p-5">
          <div className="text-xs font-medium text-slate-500 flex items-center justify-between">
            <span>Due Inpatient MAR</span>
            <Pill className="w-4 h-4 text-amber-600" />
          </div>
          <div className="font-display text-2xl font-bold text-slate-900 mt-1 tabular-nums">
            {m?.dueMedications ?? 0}
          </div>
          <div className="text-xs text-slate-500 mt-1">Scheduled doses awaiting administration</div>
        </div>

        <div className="p-5">
          <div className="text-xs font-medium text-slate-500 flex items-center justify-between">
            <span>Ward Bed Occupancy</span>
            <BedDouble className="w-4 h-4 text-slate-500" />
          </div>
          <div className="font-display text-2xl font-bold text-slate-900 mt-1 tabular-nums">
            {m?.occupiedBeds ?? 0}
            <span className="text-sm font-normal text-slate-400"> / {m?.totalBeds ?? 0}</span>
          </div>
          <div className="text-xs text-slate-500 mt-1">Active beds occupied</div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
            <div>
              <h2 className="font-display text-sm font-semibold text-slate-900">Triage & Vitals Queue</h2>
              <p className="text-xs text-slate-500">Cleared visits waiting for nursing vitals or doctor handoff</p>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('clinical', 'vitals_only')}
              className="text-xs font-medium text-teal-700 hover:text-teal-800 inline-flex items-center gap-1 whitespace-nowrap"
            >
              <span>Vitals Station</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="divide-y divide-slate-100">
            {!data?.triageQueue?.length ? (
              <div className="p-6 text-center space-y-2">
                <p className="text-xs text-slate-500">No patients waiting for triage vitals right now.</p>
                <button
                  type="button"
                  onClick={() => onNavigate('patients', 'patients')}
                  className="px-3 py-1.5 text-xs font-medium border border-slate-200 hover:bg-slate-50 rounded-md text-slate-700"
                >
                  View Clinic Queue
                </button>
              </div>
            ) : (
              data.triageQueue.map((row) => (
                <div key={row.visit_id} className="px-5 py-3 flex items-center justify-between gap-3 text-xs">
                  <div className="min-w-0">
                    <div className="font-medium text-slate-900 truncate">
                      {row.first_name} {row.last_name}{' '}
                      <span className="font-mono text-slate-400">· {row.mrn}</span>
                    </div>
                    <div className="text-slate-500 truncate mt-0.5">
                      {row.ticket_number ? `${row.ticket_number} · ` : ''}
                      {row.chief_complaint || row.specialty || 'Triage screening'}
                      {row.doctor_name ? ` · ${row.doctor_name}` : ''}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className={statusTextTone(row.triage_priority)}>{row.triage_priority}</div>
                    <div className="font-mono text-[11px] text-slate-400 mt-0.5">
                      {row.vitals_count > 0 ? 'Vitals recorded' : 'Needs vitals'}
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
              <h2 className="font-display text-sm font-semibold text-slate-900">Abnormal Vitals & Due MAR</h2>
              <p className="text-xs text-slate-500">Clinical warning flags and upcoming inpatient doses</p>
            </div>
            {hasPermission('ipd.admission.read') && (
              <button
                type="button"
                onClick={() => onNavigate('ipd')}
                className="text-xs font-medium text-teal-700 hover:text-teal-800 inline-flex items-center gap-1 whitespace-nowrap"
              >
                <span>Inpatient Wards</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          <div className="divide-y divide-slate-100">
            {!data?.abnormalVitals?.length && !data?.dueMedications?.length ? (
              <div className="p-6 text-center text-xs text-slate-500">No abnormal vitals or due doses pending.</div>
            ) : (
              <>
                {data.abnormalVitals.slice(0, 5).map((vt) => (
                  <div key={`vt-${vt.id}`} className="px-5 py-3 flex items-center justify-between gap-3 text-xs">
                    <div className="min-w-0">
                      <div className="font-medium text-slate-900 truncate">
                        {vt.first_name} {vt.last_name} <span className="font-mono text-slate-400">· {vt.mrn}</span>
                      </div>
                      <div className="font-mono text-slate-600 mt-0.5 tabular-nums">
                        BP {vt.bp_systolic ?? '—'}/{vt.bp_diastolic ?? '—'} · Temp {vt.temperature ?? '—'}°C · SpO2{' '}
                        {vt.spo2 ?? '—'}% · HR {vt.pulse ?? '—'}
                      </div>
                    </div>
                    <span className="text-red-700 font-semibold shrink-0">Early Warning</span>
                  </div>
                ))}
                {data.dueMedications.slice(0, 4).map((mar) => (
                  <div key={`mar-${mar.id}`} className="px-5 py-3 flex items-center justify-between gap-3 text-xs">
                    <div className="min-w-0">
                      <div className="font-medium text-slate-900 truncate">
                        {mar.medicine_name} ({mar.dose})
                      </div>
                      <div className="text-slate-500 truncate mt-0.5">
                        {mar.first_name} {mar.last_name} · {mar.ward_name || 'Ward'} {mar.bed_number || ''}
                      </div>
                    </div>
                    <span className="text-amber-700 font-semibold font-mono shrink-0">{mar.scheduled_time}</span>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      </div>

      {data?.wardSnapshot && data.wardSnapshot.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
            <h2 className="font-display text-sm font-semibold text-slate-900">Ward Bed Capacity</h2>
            {hasPermission('ipd.admission.read') && (
              <button
                type="button"
                onClick={() => onNavigate('ipd')}
                className="text-xs font-medium text-teal-700 hover:text-teal-800 inline-flex items-center gap-1 whitespace-nowrap"
              >
                <span>Open Ward Map</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-slate-200">
            {data.wardSnapshot.map((w) => (
              <div key={w.id} className="p-4 text-xs">
                <div className="font-semibold text-slate-900">{w.name}</div>
                <div className="text-slate-500 mt-0.5">{w.department}</div>
                <div className="font-mono text-slate-700 mt-2 tabular-nums">
                  Occupied {w.occupied_beds ?? 0} / {w.total_beds ?? 0} · Vacant {w.available_beds ?? 0}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
