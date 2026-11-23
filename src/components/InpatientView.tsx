import React, { useCallback, useEffect, useState } from 'react';
import { Activity, BedDouble, CheckCircle2, ClipboardCheck, DollarSign, FileText, Pill, Plus, Printer, Sparkles, Stethoscope, X } from 'lucide-react';
import { apiFetch } from '../lib/api';
import type {
  Admission,
  Bed,
  IpdStatement,
  MedicationAdministration,
  Patient,
  UserContext,
  Ward,
} from '../types';
import { PrintDocumentModal, type PrintDocRequest } from './PrintDocumentModal';
import { WardOccupancyChart } from './WardOccupancyChart';

interface InpatientViewProps {
  user: UserContext;
  onNotify: (msg: string, type?: 'success' | 'error') => void;
}

export const InpatientView: React.FC<InpatientViewProps> = ({ user, onNotify }) => {
  const [subTab, setSubTab] = useState<'beds' | 'admissions' | 'mar'>('beds');
  const [wards, setWards] = useState<Ward[]>([]);
  const [beds, setBeds] = useState<Bed[]>([]);
  const [admissions, setAdmissions] = useState<Admission[]>([]);
  const [mar, setMar] = useState<MedicationAdministration[]>([]);
  const [patients, setPatients] = useState<Patient[]>([]);
  const [loading, setLoading] = useState(true);

  const [showAdmitModal, setShowAdmitModal] = useState(false);
  const [admitForm, setAdmitForm] = useState({
    patient_id: '',
    ward_id: '',
    admission_diagnosis: '',
    initial_medication: '',
    initial_dose: '',
  });

  const [assignTarget, setAssignTarget] = useState<Admission | null>(null);
  const [selectedBedId, setSelectedBedId] = useState('');

  const [dischargeTarget, setDischargeTarget] = useState<Admission | null>(null);
  const [dischargeSummary, setDischargeSummary] = useState('');

  const [withholdTarget, setWithholdTarget] = useState<MedicationAdministration | null>(null);
  const [withholdReason, setWithholdReason] = useState('');

  const [printRequest, setPrintRequest] = useState<PrintDocRequest | null>(null);
  const [forceClearTarget, setForceClearTarget] = useState<{ adm: Admission; reasonNeededMsg: string } | null>(null);
  const [forceReason, setForceReason] = useState('');

  // IPD Clinical Chart Modal
  const [chartAdmission, setChartAdmission] = useState<Admission | null>(null);
  const [chartDetail, setChartDetail] = useState<IpdStatement | null>(null);
  const [chartTab, setChartTab] = useState<'rounds' | 'meds' | 'notes' | 'vitals'>('rounds');
  const [medCatalog, setMedCatalog] = useState<Array<{ id: number; generic_name: string; strength: string }>>([]);
  const [roundForm, setRoundForm] = useState({ subjective: '', objective: '', assessment: '', plan: '' });
  const [medOrderForm, setMedOrderForm] = useState({
    medicine_id: '',
    medicine_name: '',
    dose: '',
    route: 'Oral',
    frequency: 'BID',
    prn: false,
  });
  const [noteForm, setNoteForm] = useState({ note_type: 'Shift Note', note: '' });
  const [ipdVitalForm, setIpdVitalForm] = useState({
    bp_systolic: '120',
    bp_diastolic: '80',
    heart_rate: '76',
    respiratory_rate: '16',
    temperature_c: '36.8',
    spo2: '98',
    weight_kg: '',
    height_cm: '',
    notes: '',
  });

  const canCreateAdmission = user.permissions.includes('ipd.admission.create');
  const canAssignBed = user.permissions.includes('ipd.bed.assign');
  const canGiveMar = user.permissions.includes('ipd.mar.give');
  const canOrderDischarge = user.permissions.includes('ipd.discharge.create');
  const canClearDischarge = user.permissions.includes('ipd.discharge.clear');
  const canBillBed = user.permissions.includes('ipd.bed.bill');
  const canWriteRounds = canCreateAdmission || user.permissions.includes('visit.update');
  const canOrderIpdMeds = canCreateAdmission || user.permissions.includes('prescription.create');
  const canWriteNotes = canGiveMar || canAssignBed || user.permissions.includes('nursing.procedure.perform');
  const canRecordIpdVitals = canGiveMar || user.permissions.includes('vitals.create');

  const loadIpd = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch<{
        wards: Ward[];
        beds: Bed[];
        admissions: Admission[];
        mar: MedicationAdministration[];
      }>('/api/ipd/overview');
      setWards(res.wards);
      setBeds(res.beds);
      setAdmissions(res.admissions);
      setMar(res.mar);
      if (res.wards[0]) {
        setAdmitForm((prev) => (prev.ward_id ? prev : { ...prev, ward_id: String(res.wards[0].id) }));
      }
    } catch (err) {
      onNotify((err as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }, [onNotify]);

  useEffect(() => {
    loadIpd();
    if (canCreateAdmission && user.permissions.includes('patient.read')) {
      apiFetch<{ patients: Patient[] }>('/api/patients')
        .then((pRes) => {
          setPatients(pRes.patients);
          if (pRes.patients[0]) {
            setAdmitForm((prev) => (prev.patient_id ? prev : { ...prev, patient_id: String(pRes.patients[0].id) }));
          }
        })
        .catch(() => {});
    }
    if (canOrderIpdMeds) {
      apiFetch<{ medicines: Array<{ id: number; generic_name: string; strength: string }> }>('/api/catalog/medicines')
        .then((mRes) => setMedCatalog(mRes.medicines || []))
        .catch(() => {});
    }
  }, [loadIpd, canCreateAdmission, canOrderIpdMeds, user.permissions]);

  async function loadChartStatement(admId: number) {
    try {
      const res = await apiFetch<IpdStatement>(`/api/ipd/admissions/${admId}/statement`);
      setChartDetail(res);
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  function openChartModal(adm: Admission) {
    setChartAdmission(adm);
    setChartTab('rounds');
    setChartDetail(null);
    loadChartStatement(adm.id);
  }

  async function handleSaveRound(e: React.FormEvent) {
    e.preventDefault();
    if (!chartAdmission) return;
    try {
      await apiFetch(`/api/ipd/admissions/${chartAdmission.id}/rounds`, {
        method: 'POST',
        body: JSON.stringify(roundForm),
      });
      onNotify('Ward round SOAP note recorded', 'success');
      setRoundForm({ subjective: '', objective: '', assessment: '', plan: '' });
      loadChartStatement(chartAdmission.id);
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleSaveMedOrder(e: React.FormEvent) {
    e.preventDefault();
    if (!chartAdmission) return;
    try {
      const res = await apiFetch<{ scheduledSlots: string[] }>(
        `/api/ipd/admissions/${chartAdmission.id}/medication-orders`,
        {
          method: 'POST',
          body: JSON.stringify({
            medicine_id: medOrderForm.medicine_id ? Number(medOrderForm.medicine_id) : undefined,
            medicine_name: medOrderForm.medicine_name,
            dose: medOrderForm.dose,
            route: medOrderForm.route,
            frequency: medOrderForm.frequency,
            prn: medOrderForm.prn,
          }),
        }
      );
      onNotify(`Medication order added (${res.scheduledSlots.join(', ')} MAR slots generated)`, 'success');
      setMedOrderForm({ medicine_id: '', medicine_name: '', dose: '', route: 'Oral', frequency: 'BID', prn: false });
      loadChartStatement(chartAdmission.id);
      loadIpd();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleSaveNursingNote(e: React.FormEvent) {
    e.preventDefault();
    if (!chartAdmission) return;
    try {
      await apiFetch(`/api/ipd/admissions/${chartAdmission.id}/nursing-notes`, {
        method: 'POST',
        body: JSON.stringify(noteForm),
      });
      onNotify('Nursing note logged to chart', 'success');
      setNoteForm({ note_type: 'Shift Note', note: '' });
      loadChartStatement(chartAdmission.id);
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleSaveIpdVitals(e: React.FormEvent) {
    e.preventDefault();
    if (!chartAdmission) return;
    try {
      await apiFetch(`/api/ipd/admissions/${chartAdmission.id}/vitals`, {
        method: 'POST',
        body: JSON.stringify({
          bp_systolic: ipdVitalForm.bp_systolic ? Number(ipdVitalForm.bp_systolic) : undefined,
          bp_diastolic: ipdVitalForm.bp_diastolic ? Number(ipdVitalForm.bp_diastolic) : undefined,
          heart_rate: ipdVitalForm.heart_rate ? Number(ipdVitalForm.heart_rate) : undefined,
          respiratory_rate: ipdVitalForm.respiratory_rate ? Number(ipdVitalForm.respiratory_rate) : undefined,
          temperature_c: ipdVitalForm.temperature_c ? Number(ipdVitalForm.temperature_c) : undefined,
          spo2: ipdVitalForm.spo2 ? Number(ipdVitalForm.spo2) : undefined,
          weight_kg: ipdVitalForm.weight_kg ? Number(ipdVitalForm.weight_kg) : undefined,
          height_cm: ipdVitalForm.height_cm ? Number(ipdVitalForm.height_cm) : undefined,
          notes: ipdVitalForm.notes || undefined,
        }),
      });
      onNotify('Inpatient vitals recorded', 'success');
      setIpdVitalForm((prev) => ({ ...prev, notes: '' }));
      loadChartStatement(chartAdmission.id);
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleCreateAdmission(e: React.FormEvent) {
    e.preventDefault();
    try {
      const res = await apiFetch<{ admissionNumber: string }>('/api/ipd/admissions', {
        method: 'POST',
        body: JSON.stringify({
          patient_id: Number(admitForm.patient_id),
          ward_id: Number(admitForm.ward_id),
          admission_diagnosis: admitForm.admission_diagnosis,
          initial_medication: admitForm.initial_medication || undefined,
          initial_dose: admitForm.initial_dose || undefined,
        }),
      });
      onNotify(`Admission order ${res.admissionNumber} sent to Ward Nurse`, 'success');
      setShowAdmitModal(false);
      setAdmitForm((prev) => ({
        ...prev,
        admission_diagnosis: '',
        initial_medication: '',
        initial_dose: '',
      }));
      loadIpd();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleAssignBed(e: React.FormEvent) {
    e.preventDefault();
    if (!assignTarget || !selectedBedId) return;
    try {
      await apiFetch(`/api/ipd/admissions/${assignTarget.id}/assign-bed`, {
        method: 'POST',
        body: JSON.stringify({ bed_id: Number(selectedBedId) }),
      });
      onNotify(`Bed assigned for ${assignTarget.admission_number}`, 'success');
      setAssignTarget(null);
      setSelectedBedId('');
      loadIpd();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleUpdateBedStatus(bedId: number, status: 'vacant' | 'cleaning' | 'out_of_service') {
    try {
      await apiFetch(`/api/ipd/beds/${bedId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
      onNotify(`Bed status updated to ${status.replace('_', ' ')}`, 'success');
      loadIpd();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleAdministerMar(marId: number, status: 'given' | 'withheld', reason?: string) {
    try {
      await apiFetch(`/api/ipd/mar/${marId}/administer`, {
        method: 'POST',
        body: JSON.stringify({ status, reason_not_given: reason }),
      });
      onNotify(`MAR dose marked as ${status}`, 'success');
      setWithholdTarget(null);
      setWithholdReason('');
      loadIpd();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleOrderDischarge(e: React.FormEvent) {
    e.preventDefault();
    if (!dischargeTarget) return;
    try {
      await apiFetch(`/api/ipd/admissions/${dischargeTarget.id}/discharge-order`, {
        method: 'POST',
        body: JSON.stringify({ discharge_summary: dischargeSummary }),
      });
      onNotify(`Discharge ordered for ${dischargeTarget.admission_number} · Cashier clearance notified`, 'success');
      setDischargeTarget(null);
      setDischargeSummary('');
      loadIpd();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleAccrueBed(adm: Admission) {
    try {
      const res = await apiFetch<{ invoiceNumber: string; daysToBill: number; total: number; depositApplied: number }>(
        `/api/ipd/admissions/${adm.id}/accrue-bed`,
        { method: 'POST', body: JSON.stringify({}) }
      );
      onNotify(
        `Posted ${res.daysToBill} bed day(s) → ${res.invoiceNumber} ($${res.total.toFixed(2)}${res.depositApplied > 0 ? `, $${res.depositApplied.toFixed(2)} auto-applied from deposit` : ''})`,
        'success'
      );
      loadIpd();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleClearDischarge(adm: Admission, overrideReason?: string) {
    try {
      await apiFetch(`/api/ipd/admissions/${adm.id}/clear`, {
        method: 'POST',
        body: JSON.stringify(overrideReason ? { force_clearance_reason: overrideReason } : {}),
      });
      onNotify(`Financial clearance complete · ${adm.admission_number} discharged`, 'success');
      setForceClearTarget(null);
      setForceReason('');
      loadIpd();
    } catch (err) {
      const msg = (err as Error).message;
      onNotify(msg, 'error');
      if (!overrideReason && (msg.includes('Unbilled') || msg.includes('Outstanding balance'))) {
        setForceClearTarget({ adm, reasonNeededMsg: msg });
      }
    }
  }

  const vacantBeds = beds.filter((b) => b.status === 'vacant' || b.status === 'reserved');
  const dueMarCount = mar.filter((m) => m.status === 'due').length;

  return (
    <div className="space-y-5">
      <WardOccupancyChart wards={wards} beds={beds} admissions={admissions} loading={loading} />

      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-1 p-1 bg-slate-200/70 rounded-lg">
          <button
            onClick={() => setSubTab('beds')}
            className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              subTab === 'beds' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <BedDouble className="w-3.5 h-3.5" />
            <span>Ward Bed Board ({beds.length})</span>
          </button>
          <button
            onClick={() => setSubTab('admissions')}
            className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              subTab === 'admissions' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <ClipboardCheck className="w-3.5 h-3.5" />
            <span>Admissions &amp; Discharge ({admissions.length})</span>
          </button>
          <button
            onClick={() => setSubTab('mar')}
            className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              subTab === 'mar' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Inpatient MAR ({dueMarCount} due)
          </button>
        </div>

        {canCreateAdmission && (
          <button
            onClick={() => setShowAdmitModal(true)}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md whitespace-nowrap"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Order Admission</span>
          </button>
        )}
      </div>

      {/* Ward Bed Board */}
      {subTab === 'beds' && (
        <div className="space-y-5">
          {wards.map((ward) => {
            const wardBeds = beds.filter((b) => b.ward_id === ward.id);
            const occupiedCount = wardBeds.filter((b) => b.status === 'occupied').length;
            return (
              <div key={ward.id} className="bg-white border border-slate-200 rounded-lg overflow-hidden">
                <div className="px-5 py-3.5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2 bg-slate-50/70">
                  <div>
                    <h3 className="font-display text-sm font-semibold text-slate-900">
                      {ward.name} <span className="font-mono text-xs text-slate-500">({ward.code})</span>
                    </h3>
                    <div className="text-xs text-slate-500 capitalize">
                      {(ward as Ward & { department?: string }).department || ward.ward_type || 'Inpatient'} ward · Daily tariff ${Number(ward.daily_tariff).toFixed(2)}
                    </div>
                  </div>
                  <div className="text-xs font-mono text-slate-700 tabular-nums">
                    {occupiedCount} / {wardBeds.length} occupied
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 divide-y sm:divide-y-0 sm:divide-x divide-slate-200">
                  {wardBeds.map((bed) => (
                    <div key={bed.id} className="p-4 flex flex-col justify-between gap-3">
                      <div>
                        <div className="flex items-center justify-between">
                          <span className="font-mono text-sm font-semibold text-slate-900">{bed.bed_number}</span>
                          <span
                            className={`text-xs font-medium capitalize ${
                              bed.status === 'occupied'
                                ? 'text-teal-800'
                                : bed.status === 'cleaning'
                                  ? 'text-amber-700'
                                  : bed.status === 'out_of_service'
                                    ? 'text-red-700'
                                    : 'text-emerald-700'
                            }`}
                          >
                            {bed.status.replace('_', ' ')}
                          </span>
                        </div>

                        {bed.status === 'occupied' && bed.first_name ? (
                          <div className="mt-2 text-xs">
                            <div className="font-medium text-slate-900">
                              {bed.first_name} {bed.last_name}
                            </div>
                            <div className="font-mono text-slate-500 mt-0.5">
                              {bed.mrn} · {bed.admission_number}
                            </div>
                          </div>
                        ) : (
                          <div className="mt-2 text-xs text-slate-500">
                            {bed.status === 'cleaning'
                              ? 'Housekeeping turnover required'
                              : bed.status === 'out_of_service'
                                ? 'Maintenance hold'
                                : 'Ready for patient placement'}
                          </div>
                        )}
                      </div>

                      {canAssignBed && bed.status !== 'occupied' && (
                        <div className="pt-2 border-t border-slate-100 flex items-center gap-2">
                          {bed.status === 'cleaning' && (
                            <button
                              onClick={() => handleUpdateBedStatus(bed.id, 'vacant')}
                              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-emerald-800 border border-emerald-200 hover:bg-emerald-50 rounded"
                            >
                              <Sparkles className="w-3 h-3" />
                              <span>Mark Vacant</span>
                            </button>
                          )}
                          {bed.status === 'vacant' && (
                            <button
                              onClick={() => handleUpdateBedStatus(bed.id, 'out_of_service')}
                              className="px-2.5 py-1 text-xs font-medium text-slate-600 border border-slate-200 hover:bg-slate-50 rounded"
                            >
                              Maintenance Hold
                            </button>
                          )}
                          {bed.status === 'out_of_service' && (
                            <button
                              onClick={() => handleUpdateBedStatus(bed.id, 'vacant')}
                              className="px-2.5 py-1 text-xs font-medium text-teal-800 border border-teal-200 hover:bg-teal-50 rounded"
                            >
                              Restore Vacant
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Admissions & Discharge Table */}
      {subTab === 'admissions' && (
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          {admissions.length === 0 ? (
            <div className="p-10 text-center text-sm text-slate-500">No inpatient admissions recorded.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium text-slate-500">
                    <th className="py-2.5 px-4">Admission</th>
                    <th className="py-2.5 px-4">Patient</th>
                    <th className="py-2.5 px-4">Ward &amp; Bed</th>
                    <th className="py-2.5 px-4">Stay &amp; Billing</th>
                    <th className="py-2.5 px-4">Diagnosis / Summary</th>
                    <th className="py-2.5 px-4">State</th>
                    <th className="py-2.5 px-4 text-right">Workflow</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-sm">
                  {admissions.map((adm) => (
                    <tr key={adm.id} className="hover:bg-slate-50/70">
                      <td className="py-3 px-4 font-mono text-xs">
                        <div className="font-semibold text-slate-900">{adm.admission_number}</div>
                        <div className="text-slate-500">{adm.doctor_name}</div>
                      </td>
                      <td className="py-3 px-4">
                        <div className="font-medium text-slate-900">
                          {adm.first_name} {adm.last_name}
                        </div>
                        <div className="text-xs font-mono text-slate-500">
                          {adm.mrn} · Allergies: {adm.allergies || 'None'}
                        </div>
                      </td>
                      <td className="py-3 px-4 text-xs">
                        <div className="font-medium text-slate-900">{adm.ward_name}</div>
                        <div className="font-mono text-slate-500">{adm.bed_number || 'Unassigned'}</div>
                      </td>
                      <td className="py-3 px-4 text-xs font-mono tabular-nums space-y-0.5">
                        <div className="text-slate-900">
                          Stay {adm.days_stayed ?? 1}d · Billed {adm.bed_days_billed ?? 0}d
                        </div>
                        {(adm.unbilled_days ?? 0) > 0 && (
                          <div className="text-amber-700 font-semibold">
                            Unbilled: {adm.unbilled_days}d (${Number(adm.unbilled_bed_estimate || 0).toFixed(2)})
                          </div>
                        )}
                        <div className="text-slate-500">
                          Dep ${Number(adm.deposit_balance || 0).toFixed(2)} · Due{' '}
                          <span className={(adm.outstanding_invoices || 0) > 0 ? 'text-red-700 font-semibold' : 'text-emerald-700'}>
                            ${Number(adm.outstanding_invoices || 0).toFixed(2)}
                          </span>
                        </div>
                      </td>
                      <td className="py-3 px-4 text-xs text-slate-700 max-w-[230px]">
                        <div>{adm.admission_diagnosis}</div>
                        {adm.discharge_summary && (
                          <div className="mt-1 text-slate-500 truncate">Summary: {adm.discharge_summary}</div>
                        )}
                      </td>
                      <td className="py-3 px-4 text-xs">
                        <span
                          className={
                            adm.status === 'discharged'
                              ? 'text-slate-500'
                              : adm.status === 'discharge_ordered'
                                ? 'text-amber-700 font-semibold'
                                : adm.status === 'ordered'
                                  ? 'text-sky-700 font-semibold'
                                  : 'text-emerald-700 font-semibold'
                          }
                        >
                          {adm.status.replace('_', ' ')}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right whitespace-nowrap space-x-1.5">
                        <button
                          onClick={() => openChartModal(adm)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-teal-800 border border-teal-200 hover:bg-teal-50 rounded"
                        >
                          <Stethoscope className="w-3 h-3" />
                          <span>Chart</span>
                        </button>
                        <button
                          onClick={() => setPrintRequest({ type: 'ipd_statement', admissionId: adm.id })}
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-700 border border-slate-200 hover:bg-slate-50 rounded"
                        >
                          <Printer className="w-3 h-3" />
                          <span>Statement</span>
                        </button>
                        {canBillBed && adm.status !== 'discharged' && (
                          <button
                            onClick={() => handleAccrueBed(adm)}
                            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-teal-800 border border-teal-200 hover:bg-teal-50 rounded"
                          >
                            <DollarSign className="w-3 h-3" />
                            <span>Post Bed Charge</span>
                          </button>
                        )}
                        {canAssignBed && (adm.status === 'ordered' || !adm.bed_id) && (
                          <button
                            onClick={() => {
                              setAssignTarget(adm);
                              const matchBed =
                                vacantBeds.find((b) => b.ward_id === adm.ward_id) || vacantBeds[0];
                              setSelectedBedId(matchBed ? String(matchBed.id) : '');
                            }}
                            className="px-2.5 py-1 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded"
                          >
                            Assign Bed
                          </button>
                        )}
                        {canOrderDischarge && adm.status === 'admitted' && (
                          <button
                            onClick={() => setDischargeTarget(adm)}
                            className="px-2.5 py-1 text-xs font-medium text-slate-800 border border-slate-300 hover:bg-slate-50 rounded"
                          >
                            Order Discharge
                          </button>
                        )}
                        {canClearDischarge && adm.status === 'discharge_ordered' && (
                          <button
                            onClick={() => handleClearDischarge(adm)}
                            className="px-2.5 py-1 text-xs font-medium text-white bg-emerald-700 hover:bg-emerald-800 rounded"
                          >
                            Clear Bill &amp; Discharge
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Medication Administration Record (MAR) */}
      {subTab === 'mar' && (
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          {mar.length === 0 ? (
            <div className="p-10 text-center text-sm text-slate-500">No active inpatient MAR orders.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium text-slate-500">
                    <th className="py-2.5 px-4">Time &amp; Bed</th>
                    <th className="py-2.5 px-4">Patient</th>
                    <th className="py-2.5 px-4">Medication &amp; Dose</th>
                    <th className="py-2.5 px-4">MAR Status</th>
                    {canGiveMar && <th className="py-2.5 px-4 text-right">Nurse Administration</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-sm">
                  {mar.map((entry) => (
                    <tr key={entry.id} className="hover:bg-slate-50/70">
                      <td className="py-3 px-4 font-mono text-xs tabular-nums">
                        <div className="font-semibold text-slate-900">{entry.scheduled_time}</div>
                        <div className="text-slate-500">{entry.bed_number || entry.admission_number}</div>
                      </td>
                      <td className="py-3 px-4">
                        <div className="font-medium text-slate-900">
                          {entry.first_name} {entry.last_name}
                        </div>
                        <div className="text-xs font-mono text-slate-500">{entry.mrn}</div>
                      </td>
                      <td className="py-3 px-4 text-xs">
                        <div className="font-semibold text-slate-900">{entry.medicine_name}</div>
                        <div className="text-slate-600">{entry.dose}</div>
                      </td>
                      <td className="py-3 px-4 text-xs">
                        <span
                          className={
                            entry.status === 'given'
                              ? 'text-emerald-700 font-semibold'
                              : entry.status === 'withheld'
                                ? 'text-amber-700 font-semibold'
                                : 'text-sky-700 font-semibold'
                          }
                        >
                          {entry.status}
                        </span>
                        {entry.administered_by_name && (
                          <div className="text-slate-500">by {entry.administered_by_name}</div>
                        )}
                        {entry.reason_not_given && (
                          <div className="text-amber-800">Reason: {entry.reason_not_given}</div>
                        )}
                      </td>
                      {canGiveMar && (
                        <td className="py-3 px-4 text-right whitespace-nowrap space-x-1.5">
                          {entry.status === 'due' ? (
                            <>
                              <button
                                onClick={() => handleAdministerMar(entry.id, 'given')}
                                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded"
                              >
                                <CheckCircle2 className="w-3 h-3" />
                                <span>Mark Given</span>
                              </button>
                              <button
                                onClick={() => setWithholdTarget(entry)}
                                className="px-2.5 py-1 text-xs font-medium text-amber-800 border border-amber-300 hover:bg-amber-50 rounded"
                              >
                                Withhold
                              </button>
                            </>
                          ) : (
                            <span className="text-xs font-mono text-slate-400">Logged</span>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Create Admission Order Modal */}
      {showAdmitModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-lg max-w-md w-full">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3 className="font-display text-base font-semibold text-slate-900">Order Inpatient Admission</h3>
              <button onClick={() => setShowAdmitModal(false)} className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleCreateAdmission} className="p-6 space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Patient *</label>
                <select
                  required
                  value={admitForm.patient_id}
                  onChange={(e) => setAdmitForm({ ...admitForm, patient_id: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md bg-white"
                >
                  {patients.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.mrn} — {p.first_name} {p.last_name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Target Ward *</label>
                <select
                  required
                  value={admitForm.ward_id}
                  onChange={(e) => setAdmitForm({ ...admitForm, ward_id: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md bg-white"
                >
                  {wards.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name} (${Number(w.daily_tariff).toFixed(2)}/day)
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Admission Diagnosis *</label>
                <input
                  required
                  value={admitForm.admission_diagnosis}
                  onChange={(e) => setAdmitForm({ ...admitForm, admission_diagnosis: e.target.value })}
                  placeholder="Clinical reason for inpatient stay"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Initial MAR Med (Opt)</label>
                  <input
                    value={admitForm.initial_medication}
                    onChange={(e) => setAdmitForm({ ...admitForm, initial_medication: e.target.value })}
                    placeholder="e.g. Ceftriaxone"
                    className="w-full px-3 py-2 text-xs border border-slate-300 rounded-md"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Dose</label>
                  <input
                    value={admitForm.initial_dose}
                    onChange={(e) => setAdmitForm({ ...admitForm, initial_dose: e.target.value })}
                    placeholder="e.g. 1g IV q12h"
                    className="w-full px-3 py-2 text-xs border border-slate-300 rounded-md"
                  />
                </div>
              </div>
              <div className="pt-3 border-t border-slate-200 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowAdmitModal(false)}
                  className="px-4 py-2 text-xs border border-slate-300 rounded-md"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md"
                >
                  Submit Admission Order
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Assign Bed Modal */}
      {assignTarget && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-lg max-w-md w-full">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3 className="font-display text-base font-semibold text-slate-900">
                Assign Bed · {assignTarget.admission_number}
              </h3>
              <button onClick={() => setAssignTarget(null)} className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleAssignBed} className="p-6 space-y-4">
              <div className="text-xs text-slate-600">
                Patient: <strong className="text-slate-900">{assignTarget.first_name} {assignTarget.last_name}</strong> ({assignTarget.mrn})
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Select Vacant Bed</label>
                <select
                  required
                  value={selectedBedId}
                  onChange={(e) => setSelectedBedId(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md bg-white"
                >
                  {vacantBeds.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.ward_name} — {b.bed_number} ({b.status})
                    </option>
                  ))}
                </select>
              </div>
              <div className="pt-3 border-t border-slate-200 flex justify-end gap-2">
                <button type="button" onClick={() => setAssignTarget(null)} className="px-4 py-2 text-xs border border-slate-300 rounded-md">
                  Cancel
                </button>
                <button type="submit" disabled={!selectedBedId} className="px-4 py-2 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md disabled:opacity-40">
                  Confirm Placement
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Discharge Order Modal */}
      {dischargeTarget && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-lg max-w-md w-full">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3 className="font-display text-base font-semibold text-slate-900">
                Order Discharge · {dischargeTarget.admission_number}
              </h3>
              <button onClick={() => setDischargeTarget(null)} className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleOrderDischarge} className="p-6 space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Clinical Discharge Summary *</label>
                <textarea
                  required
                  rows={3}
                  value={dischargeSummary}
                  onChange={(e) => setDischargeSummary(e.target.value)}
                  placeholder="Condition at discharge, home medications, follow-up instructions..."
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-md"
                />
              </div>
              <div className="pt-3 border-t border-slate-200 flex justify-end gap-2">
                <button type="button" onClick={() => setDischargeTarget(null)} className="px-4 py-2 text-xs border border-slate-300 rounded-md">
                  Cancel
                </button>
                <button type="submit" className="px-4 py-2 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-md">
                  Submit &amp; Request Cashier Clearance
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Withhold MAR Modal */}
      {withholdTarget && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-lg max-w-md w-full">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3 className="font-display text-base font-semibold text-slate-900">
                Withhold Dose · {withholdTarget.medicine_name}
              </h3>
              <button onClick={() => setWithholdTarget(null)} className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleAdministerMar(withholdTarget.id, 'withheld', withholdReason);
              }}
              className="p-6 space-y-4"
            >
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Mandatory Clinical Reason *</label>
                <textarea
                  required
                  rows={2}
                  value={withholdReason}
                  onChange={(e) => setWithholdReason(e.target.value)}
                  placeholder="e.g. Patient NPO for procedure, bradycardia, or patient declined"
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-md"
                />
              </div>
              <div className="pt-3 border-t border-slate-200 flex justify-end gap-2">
                <button type="button" onClick={() => setWithholdTarget(null)} className="px-4 py-2 text-xs border border-slate-300 rounded-md">
                  Cancel
                </button>
                <button type="submit" className="px-4 py-2 text-xs font-medium text-white bg-amber-700 hover:bg-amber-800 rounded-md">
                  Record Withheld Dose
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      {/* Discharge Financial Override Modal */}
      {forceClearTarget && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-lg max-w-md w-full">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3 className="font-display text-base font-semibold text-slate-900">
                Financial Clearance Hold · {forceClearTarget.adm.admission_number}
              </h3>
              <button onClick={() => setForceClearTarget(null)} className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleClearDischarge(forceClearTarget.adm, forceReason);
              }}
              className="p-6 space-y-4"
            >
              <div className="p-3 bg-amber-50 border border-amber-200 rounded text-xs text-amber-900">
                {forceClearTarget.reasonNeededMsg}
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Exceptional Manager / Credit Override Reason (if discharging before settlement)
                </label>
                <textarea
                  required
                  rows={2}
                  value={forceReason}
                  onChange={(e) => setForceReason(e.target.value)}
                  placeholder="e.g. Approved deferred payment arrangement by Finance Manager"
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-md"
                />
              </div>
              <div className="pt-3 border-t border-slate-200 flex justify-end gap-2">
                <button type="button" onClick={() => setForceClearTarget(null)} className="px-4 py-2 text-xs border border-slate-300 rounded-md">
                  Go Back &amp; Settle
                </button>
                <button type="submit" className="px-4 py-2 text-xs font-medium text-white bg-amber-700 hover:bg-amber-800 rounded-md">
                  Audit Override &amp; Discharge
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Inpatient Clinical Chart Modal */}
      {chartAdmission && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-lg max-w-4xl w-full max-h-[90vh] flex flex-col">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <div>
                <h3 className="font-display text-base font-semibold text-slate-900">
                  Inpatient Clinical Chart · {chartAdmission.admission_number}
                </h3>
                <div className="text-xs text-slate-500 mt-0.5">
                  {chartAdmission.first_name} {chartAdmission.last_name} ({chartAdmission.mrn}) ·{' '}
                  {chartAdmission.ward_name} {chartAdmission.bed_number || 'Unassigned'} · Dx: {chartAdmission.admission_diagnosis}
                </div>
              </div>
              <button onClick={() => setChartAdmission(null)} className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="px-6 pt-3 border-b border-slate-200 flex flex-wrap gap-1 bg-slate-50/70">
              {(
                [
                  { id: 'rounds', label: `Ward Rounds (${chartDetail?.wardRounds?.length ?? 0})`, Icon: Stethoscope },
                  { id: 'meds', label: `Medication Orders (${chartDetail?.medicationOrders?.length ?? 0})`, Icon: Pill },
                  { id: 'notes', label: `Nursing Notes (${chartDetail?.nursingNotes?.length ?? 0})`, Icon: FileText },
                  { id: 'vitals', label: `IPD Vitals (${chartDetail?.vitals?.length ?? 0})`, Icon: Activity },
                ] as const
              ).map(({ id, label, Icon }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setChartTab(id)}
                  className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium border-b-2 transition-colors ${
                    chartTab === id
                      ? 'border-teal-700 text-teal-800 bg-white'
                      : 'border-transparent text-slate-600 hover:text-slate-900'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  <span>{label}</span>
                </button>
              ))}
            </div>

            <div className="p-6 overflow-y-auto space-y-5 text-xs flex-1">
              {!chartDetail ? (
                <div className="py-10 text-center text-slate-500">Loading inpatient clinical chart...</div>
              ) : (
                <>
                  {chartTab === 'rounds' && (
                    <div className="space-y-4">
                      {canWriteRounds && chartAdmission.status !== 'discharged' && (
                        <form onSubmit={handleSaveRound} className="p-4 bg-slate-50 border border-slate-200 rounded-md space-y-3">
                          <div className="font-semibold text-slate-900">Record Doctor Ward Round (SOAP)</div>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <div>
                              <label className="block text-slate-600 mb-1">Subjective</label>
                              <textarea
                                rows={2}
                                value={roundForm.subjective}
                                onChange={(e) => setRoundForm({ ...roundForm, subjective: e.target.value })}
                                placeholder="Patient symptoms, overnight events..."
                                className="w-full px-2.5 py-1.5 border border-slate-300 rounded bg-white"
                              />
                            </div>
                            <div>
                              <label className="block text-slate-600 mb-1">Objective</label>
                              <textarea
                                rows={2}
                                value={roundForm.objective}
                                onChange={(e) => setRoundForm({ ...roundForm, objective: e.target.value })}
                                placeholder="Physical exam findings, lab trends..."
                                className="w-full px-2.5 py-1.5 border border-slate-300 rounded bg-white"
                              />
                            </div>
                            <div>
                              <label className="block font-medium text-slate-700 mb-1">Assessment *</label>
                              <input
                                required
                                value={roundForm.assessment}
                                onChange={(e) => setRoundForm({ ...roundForm, assessment: e.target.value })}
                                placeholder="Clinical progress & working assessment"
                                className="w-full px-2.5 py-1.5 border border-slate-300 rounded bg-white"
                              />
                            </div>
                            <div>
                              <label className="block font-medium text-slate-700 mb-1">Plan *</label>
                              <input
                                required
                                value={roundForm.plan}
                                onChange={(e) => setRoundForm({ ...roundForm, plan: e.target.value })}
                                placeholder="Medication adjustments, discharge criteria..."
                                className="w-full px-2.5 py-1.5 border border-slate-300 rounded bg-white"
                              />
                            </div>
                          </div>
                          <div className="flex justify-end">
                            <button type="submit" className="px-4 py-1.5 font-medium text-white bg-teal-700 hover:bg-teal-800 rounded">
                              Save Ward Round
                            </button>
                          </div>
                        </form>
                      )}
                      <div className="divide-y divide-slate-200 border border-slate-200 rounded-md">
                        {(!chartDetail.wardRounds || chartDetail.wardRounds.length === 0) ? (
                          <div className="p-6 text-center text-slate-500">No ward rounds documented yet.</div>
                        ) : (
                          chartDetail.wardRounds.map((wr) => (
                            <div key={wr.id} className="p-4 space-y-1.5">
                              <div className="flex justify-between text-slate-500 font-mono">
                                <span className="font-semibold text-slate-800">{wr.doctor_name || 'Attending'}</span>
                                <span>{wr.recorded_at}</span>
                              </div>
                              {wr.subjective && <div><strong className="text-slate-600">S:</strong> {wr.subjective}</div>}
                              {wr.objective && <div><strong className="text-slate-600">O:</strong> {wr.objective}</div>}
                              <div><strong className="text-slate-700">A:</strong> {wr.assessment}</div>
                              <div><strong className="text-slate-700">P:</strong> {wr.plan}</div>
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  )}

                  {chartTab === 'meds' && (
                    <div className="space-y-4">
                      {canOrderIpdMeds && chartAdmission.status !== 'discharged' && (
                        <form onSubmit={handleSaveMedOrder} className="p-4 bg-slate-50 border border-slate-200 rounded-md space-y-3">
                          <div className="font-semibold text-slate-900">Order Inpatient Medication (Auto-Schedules MAR)</div>
                          <div className="grid grid-cols-1 sm:grid-cols-6 gap-2.5">
                            {medCatalog.length > 0 && (
                              <div className="sm:col-span-2">
                                <label className="block text-slate-600 mb-1">Formulary Pick (Opt)</label>
                                <select
                                  value={medOrderForm.medicine_id}
                                  onChange={(e) => {
                                    const picked = medCatalog.find((m) => String(m.id) === e.target.value);
                                    setMedOrderForm((prev) => ({
                                      ...prev,
                                      medicine_id: e.target.value,
                                      medicine_name: picked ? `${picked.generic_name} ${picked.strength}`.trim() : prev.medicine_name,
                                    }));
                                  }}
                                  className="w-full px-2 py-1.5 border border-slate-300 rounded bg-white"
                                >
                                  <option value="">Custom / Free text</option>
                                  {medCatalog.map((m) => (
                                    <option key={m.id} value={m.id}>
                                      {m.generic_name} {m.strength}
                                    </option>
                                  ))}
                                </select>
                              </div>
                            )}
                            <div className={medCatalog.length > 0 ? 'sm:col-span-2' : 'sm:col-span-3'}>
                              <label className="block font-medium text-slate-700 mb-1">Medication Name *</label>
                              <input
                                required
                                value={medOrderForm.medicine_name}
                                onChange={(e) => setMedOrderForm({ ...medOrderForm, medicine_name: e.target.value })}
                                placeholder="e.g. Ceftriaxone 1g"
                                className="w-full px-2.5 py-1.5 border border-slate-300 rounded bg-white"
                              />
                            </div>
                            <div className={medCatalog.length > 0 ? 'sm:col-span-2' : 'sm:col-span-3'}>
                              <label className="block font-medium text-slate-700 mb-1">Dose *</label>
                              <input
                                required
                                value={medOrderForm.dose}
                                onChange={(e) => setMedOrderForm({ ...medOrderForm, dose: e.target.value })}
                                placeholder="e.g. 1g"
                                className="w-full px-2.5 py-1.5 border border-slate-300 rounded bg-white"
                              />
                            </div>
                            <div className="sm:col-span-2">
                              <label className="block text-slate-600 mb-1">Route</label>
                              <select
                                value={medOrderForm.route}
                                onChange={(e) => setMedOrderForm({ ...medOrderForm, route: e.target.value })}
                                className="w-full px-2 py-1.5 border border-slate-300 rounded bg-white"
                              >
                                <option value="Oral">Oral</option>
                                <option value="IV">IV</option>
                                <option value="IM">IM</option>
                                <option value="SC">SC</option>
                                <option value="Topical">Topical</option>
                                <option value="Inhaled">Inhaled</option>
                              </select>
                            </div>
                            <div className="sm:col-span-2">
                              <label className="block text-slate-600 mb-1">Frequency</label>
                              <select
                                value={medOrderForm.frequency}
                                onChange={(e) => setMedOrderForm({ ...medOrderForm, frequency: e.target.value })}
                                className="w-full px-2 py-1.5 border border-slate-300 rounded bg-white"
                              >
                                <option value="OD">OD (08:00)</option>
                                <option value="BID">BID (08:00, 20:00)</option>
                                <option value="TID">TID (08:00, 14:00, 20:00)</option>
                                <option value="QID">QID (06, 12, 18, 23)</option>
                                <option value="STAT">STAT (Immediate)</option>
                                <option value="PRN">PRN (As needed)</option>
                              </select>
                            </div>
                            <div className="sm:col-span-2 flex items-end justify-between gap-2">
                              <label className="inline-flex items-center gap-1.5 py-1.5 cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={medOrderForm.prn}
                                  onChange={(e) => setMedOrderForm({ ...medOrderForm, prn: e.target.checked })}
                                />
                                <span>PRN only</span>
                              </label>
                              <button type="submit" className="px-3.5 py-1.5 font-medium text-white bg-teal-700 hover:bg-teal-800 rounded whitespace-nowrap">
                                Add to MAR
                              </button>
                            </div>
                          </div>
                        </form>
                      )}
                      <div className="divide-y divide-slate-200 border border-slate-200 rounded-md">
                        {(!chartDetail.medicationOrders || chartDetail.medicationOrders.length === 0) ? (
                          <div className="p-6 text-center text-slate-500">No inpatient medication orders yet.</div>
                        ) : (
                          chartDetail.medicationOrders.map((mo) => (
                            <div key={mo.id} className="p-3.5 flex flex-wrap items-center justify-between gap-2">
                              <div>
                                <div className="font-semibold text-slate-900">
                                  {mo.medicine_name} · {mo.dose}
                                </div>
                                <div className="text-slate-500 font-mono">
                                  {mo.route} · {mo.frequency}{mo.prn === 1 ? ' (PRN)' : ''} · Ordered by {mo.ordered_by_name || 'Clinician'}
                                </div>
                              </div>
                              <div className="font-mono text-slate-600">{mo.status} · {mo.created_at}</div>
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  )}

                  {chartTab === 'notes' && (
                    <div className="space-y-4">
                      {canWriteNotes && (
                        <form onSubmit={handleSaveNursingNote} className="p-4 bg-slate-50 border border-slate-200 rounded-md space-y-3">
                          <div className="font-semibold text-slate-900">Log Inpatient Nursing Note</div>
                          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                            <div>
                              <label className="block text-slate-600 mb-1">Note Type</label>
                              <select
                                value={noteForm.note_type}
                                onChange={(e) => setNoteForm({ ...noteForm, note_type: e.target.value })}
                                className="w-full px-2.5 py-1.5 border border-slate-300 rounded bg-white"
                              >
                                <option value="Shift Note">Shift Note</option>
                                <option value="Handover">Handover</option>
                                <option value="Intake/Output">Intake / Output</option>
                                <option value="Wound Care">Wound / IV Site Care</option>
                              </select>
                            </div>
                            <div className="sm:col-span-3">
                              <label className="block font-medium text-slate-700 mb-1">Nursing Observation *</label>
                              <input
                                required
                                value={noteForm.note}
                                onChange={(e) => setNoteForm({ ...noteForm, note: e.target.value })}
                                placeholder="Patient comfortable, IV site patent, output recorded..."
                                className="w-full px-2.5 py-1.5 border border-slate-300 rounded bg-white"
                              />
                            </div>
                          </div>
                          <div className="flex justify-end">
                            <button type="submit" className="px-4 py-1.5 font-medium text-white bg-teal-700 hover:bg-teal-800 rounded">
                              Log Nursing Note
                            </button>
                          </div>
                        </form>
                      )}
                      <div className="divide-y divide-slate-200 border border-slate-200 rounded-md">
                        {(!chartDetail.nursingNotes || chartDetail.nursingNotes.length === 0) ? (
                          <div className="p-6 text-center text-slate-500">No nursing notes recorded yet.</div>
                        ) : (
                          chartDetail.nursingNotes.map((nn) => (
                            <div key={nn.id} className="p-3.5 space-y-1">
                              <div className="flex justify-between font-mono text-slate-500">
                                <span className="font-semibold text-teal-800">{nn.note_type} · {nn.nurse_name || 'Ward Nurse'}</span>
                                <span>{nn.recorded_at}</span>
                              </div>
                              <div className="text-slate-800">{nn.note}</div>
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  )}

                  {chartTab === 'vitals' && (
                    <div className="space-y-4">
                      {canRecordIpdVitals && chartAdmission.status !== 'discharged' && (
                        <form onSubmit={handleSaveIpdVitals} className="p-4 bg-slate-50 border border-slate-200 rounded-md space-y-3">
                          <div className="font-semibold text-slate-900">Record Ward Vitals Chart</div>
                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                            <div>
                              <label className="block text-slate-600 mb-1">BP Systolic</label>
                              <input type="number" value={ipdVitalForm.bp_systolic} onChange={(e) => setIpdVitalForm({ ...ipdVitalForm, bp_systolic: e.target.value })} className="w-full px-2 py-1.5 border border-slate-300 rounded bg-white font-mono" />
                            </div>
                            <div>
                              <label className="block text-slate-600 mb-1">BP Diastolic</label>
                              <input type="number" value={ipdVitalForm.bp_diastolic} onChange={(e) => setIpdVitalForm({ ...ipdVitalForm, bp_diastolic: e.target.value })} className="w-full px-2 py-1.5 border border-slate-300 rounded bg-white font-mono" />
                            </div>
                            <div>
                              <label className="block text-slate-600 mb-1">Temp (°C)</label>
                              <input type="number" step="0.1" value={ipdVitalForm.temperature_c} onChange={(e) => setIpdVitalForm({ ...ipdVitalForm, temperature_c: e.target.value })} className="w-full px-2 py-1.5 border border-slate-300 rounded bg-white font-mono" />
                            </div>
                            <div>
                              <label className="block text-slate-600 mb-1">SpO2 (%)</label>
                              <input type="number" value={ipdVitalForm.spo2} onChange={(e) => setIpdVitalForm({ ...ipdVitalForm, spo2: e.target.value })} className="w-full px-2 py-1.5 border border-slate-300 rounded bg-white font-mono" />
                            </div>
                            <div>
                              <label className="block text-slate-600 mb-1">Pulse (bpm)</label>
                              <input type="number" value={ipdVitalForm.heart_rate} onChange={(e) => setIpdVitalForm({ ...ipdVitalForm, heart_rate: e.target.value })} className="w-full px-2 py-1.5 border border-slate-300 rounded bg-white font-mono" />
                            </div>
                            <div>
                              <label className="block text-slate-600 mb-1">Resp Rate</label>
                              <input type="number" value={ipdVitalForm.respiratory_rate} onChange={(e) => setIpdVitalForm({ ...ipdVitalForm, respiratory_rate: e.target.value })} className="w-full px-2 py-1.5 border border-slate-300 rounded bg-white font-mono" />
                            </div>
                            <div className="sm:col-span-2">
                              <label className="block text-slate-600 mb-1">Ward Observation Notes</label>
                              <input value={ipdVitalForm.notes} onChange={(e) => setIpdVitalForm({ ...ipdVitalForm, notes: e.target.value })} placeholder="Pain score, posture, O2 flow..." className="w-full px-2 py-1.5 border border-slate-300 rounded bg-white" />
                            </div>
                          </div>
                          <div className="flex justify-end">
                            <button type="submit" className="px-4 py-1.5 font-medium text-white bg-teal-700 hover:bg-teal-800 rounded">
                              Record Ward Vitals
                            </button>
                          </div>
                        </form>
                      )}
                      <div className="divide-y divide-slate-200 border border-slate-200 rounded-md">
                        {(!chartDetail.vitals || chartDetail.vitals.length === 0) ? (
                          <div className="p-6 text-center text-slate-500">No vitals recorded for this admission yet.</div>
                        ) : (
                          chartDetail.vitals.map((vt) => {
                            const tempVal = vt.temperature ?? vt.temperature_c;
                            const hrVal = vt.pulse ?? vt.heart_rate;
                            return (
                              <div key={vt.id} className="p-3 flex flex-wrap items-center justify-between gap-2">
                                <div className="font-mono tabular-nums text-slate-800">
                                  BP <strong>{vt.bp_systolic ?? '-'}/{vt.bp_diastolic ?? '-'}</strong> · Temp{' '}
                                  <strong className={Number(tempVal) >= 38.5 ? 'text-red-700' : 'text-slate-900'}>
                                    {tempVal ?? '-'}°C
                                  </strong>{' '}
                                  · Pulse <strong>{hrVal ?? '-'}</strong> · SpO2{' '}
                                  <strong className={Number(vt.spo2) < 92 ? 'text-red-700' : 'text-slate-900'}>
                                    {vt.spo2 ?? '-'}%
                                  </strong>{' '}
                                  · RR <strong>{vt.respiratory_rate ?? '-'}</strong>
                                  {vt.notes && <span className="font-sans text-slate-600"> — {vt.notes}</span>}
                                </div>
                                <div className="font-mono text-slate-400">
                                  {vt.recorded_by_name ? `${vt.recorded_by_name} · ` : ''}
                                  {vt.recorded_at}
                                </div>
                              </div>
                            );
                          })
                        )}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      <PrintDocumentModal request={printRequest} onClose={() => setPrintRequest(null)} />
    </div>
  );
};
