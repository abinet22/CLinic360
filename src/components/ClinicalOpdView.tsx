import React, { useCallback, useEffect, useState } from 'react';
import { Activity, AlertTriangle, BedDouble, CheckCircle2, FlaskConical, Lock, Pill, Scan, Unlock, X } from 'lucide-react';
import { apiFetch } from '../lib/api';
import type { ImagingCatalogItem, UserContext, Visit, VitalsRecord, Ward } from '../types';

interface LabTestCatalog {
  id: number;
  code: string;
  name: string;
  price: number;
}

interface MedicineCatalog {
  id: number;
  code: string;
  generic_name: string;
  strength: string;
  stock_qty: number;
  unit_price: number;
}

interface ClinicalOpdViewProps {
  user: UserContext;
  onNotify: (msg: string, type?: 'success' | 'error') => void;
}

export const ClinicalOpdView: React.FC<ClinicalOpdViewProps> = ({ user, onNotify }) => {
  const [visits, setVisits] = useState<Visit[]>([]);
  const [selectedVisitId, setSelectedVisitId] = useState<number | null>(null);
  const [visitDetail, setVisitDetail] = useState<{
    visit: Visit;
    vitals: VitalsRecord[];
    labOrders: Array<{
      id: number;
      test_name: string;
      status: string;
      result_value: string | null;
      previous_result_value: string | null;
      abnormal_flag: string | null;
      critical_ack_at: string | null;
      invoice_status: string | null;
    }>;
    imagingOrders: Array<{
      id: number;
      exam_name: string;
      modality: string;
      status: string;
      impression: string | null;
      invoice_status: string | null;
    }>;
    prescriptions: Array<{ id: number; status: string; invoice_status: string | null; items: Array<{ generic_name: string; strength: string; dosage: string; frequency: string; quantity: number }> }>;
  } | null>(null);

  const [labCatalog, setLabCatalog] = useState<LabTestCatalog[]>([]);
  const [imagingCatalog, setImagingCatalog] = useState<ImagingCatalogItem[]>([]);
  const [medCatalog, setMedCatalog] = useState<MedicineCatalog[]>([]);
  const [wards, setWards] = useState<Ward[]>([]);

  const [vitalsForm, setVitalsForm] = useState({
    bp_systolic: '120',
    bp_diastolic: '80',
    temperature: '36.8',
    pulse: '76',
    respiratory_rate: '16',
    spo2: '98',
    weight_kg: '70',
    height_cm: '170',
    triage_priority: 'routine',
    notes: '',
  });

  const [consultForm, setConsultForm] = useState({
    chief_complaint: '',
    history_notes: '',
    exam_notes: '',
    diagnosis_code: '',
    diagnosis_text: '',
    treatment_plan: '',
    follow_up_date: '',
  });

  const [selectedLabId, setSelectedLabId] = useState('');
  const [selectedImagingId, setSelectedImagingId] = useState('');
  const [imagingQuestion, setImagingQuestion] = useState('');
  const [rxForm, setRxForm] = useState({
    medicine_id: '',
    dosage: '1 tablet',
    frequency: 'Twice daily',
    duration_days: '5',
    quantity: '10',
  });
  const [reopenReason, setReopenReason] = useState('');
  const [showAdmitModal, setShowAdmitModal] = useState(false);
  const [admitWardId, setAdmitWardId] = useState('');
  const [admitDx, setAdmitDx] = useState('');

  const canVitals = user.permissions.includes('vitals.create');
  const canUpdateVisit = user.permissions.includes('visit.update');
  const canCloseVisit = user.permissions.includes('visit.close');
  const canReopenVisit = user.permissions.includes('visit.reopen');
  const canOrderLab = user.permissions.includes('order.lab.create');
  const canOrderImaging = user.permissions.includes('order.imaging.create');
  const canPrescribe = user.permissions.includes('prescription.create');
  const canAdmit = user.permissions.includes('ipd.admission.create');

  const loadVisits = useCallback(async () => {
    try {
      const res = await apiFetch<{ visits: Visit[] }>('/api/visits');
      setVisits(res.visits);
      if (!selectedVisitId && res.visits[0]) {
        setSelectedVisitId(res.visits[0].id);
      }
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }, [onNotify, selectedVisitId]);

  const loadVisitDetail = useCallback(async (id: number) => {
    try {
      const res = await apiFetch<NonNullable<typeof visitDetail>>(`/api/visits/${id}`);
      setVisitDetail(res);
      setConsultForm({
        chief_complaint: res.visit.chief_complaint || '',
        history_notes: res.visit.history_notes || '',
        exam_notes: res.visit.exam_notes || '',
        diagnosis_code: res.visit.diagnosis_code || '',
        diagnosis_text: res.visit.diagnosis_text || '',
        treatment_plan: res.visit.treatment_plan || '',
        follow_up_date: res.visit.follow_up_date || '',
      });
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }, [onNotify]);

  useEffect(() => {
    loadVisits();
    Promise.all([
      apiFetch<{ labTests: LabTestCatalog[] }>('/api/catalog/lab-tests'),
      apiFetch<{ imagingCatalog: ImagingCatalogItem[] }>('/api/catalog/imaging'),
      apiFetch<{ medicines: MedicineCatalog[] }>('/api/catalog/medicines'),
    ])
      .then(([labs, imgs, meds]) => {
        setLabCatalog(labs.labTests);
        setImagingCatalog(imgs.imagingCatalog);
        setMedCatalog(meds.medicines);
        if (labs.labTests[0]) setSelectedLabId(String(labs.labTests[0].id));
        if (imgs.imagingCatalog[0]) setSelectedImagingId(String(imgs.imagingCatalog[0].id));
        if (meds.medicines[0]) setRxForm((p) => ({ ...p, medicine_id: String(meds.medicines[0].id) }));
      })
      .catch(() => {});

    if (canAdmit && user.permissions.includes('ipd.admission.read')) {
      apiFetch<{ wards: Ward[] }>('/api/ipd/overview')
        .then((res) => {
          setWards(res.wards);
          if (res.wards[0]) setAdmitWardId(String(res.wards[0].id));
        })
        .catch(() => {});
    }
  }, [loadVisits, canAdmit, user.permissions]);

  useEffect(() => {
    if (selectedVisitId) loadVisitDetail(selectedVisitId);
  }, [selectedVisitId, loadVisitDetail]);

  async function handleSaveVitals(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedVisitId) return;
    try {
      const res = await apiFetch<{ bmi: number | null; earlyWarningFlag: boolean }>(
        `/api/visits/${selectedVisitId}/vitals`,
        {
          method: 'POST',
          body: JSON.stringify({
            ...vitalsForm,
            bp_systolic: Number(vitalsForm.bp_systolic),
            bp_diastolic: Number(vitalsForm.bp_diastolic),
            temperature: Number(vitalsForm.temperature),
            pulse: Number(vitalsForm.pulse),
            respiratory_rate: Number(vitalsForm.respiratory_rate),
            spo2: Number(vitalsForm.spo2),
            weight_kg: Number(vitalsForm.weight_kg),
            height_cm: Number(vitalsForm.height_cm),
          }),
        }
      );
      onNotify(
        `Vitals recorded (BMI ${res.bmi ?? '-'})${res.earlyWarningFlag ? ' · Early-warning vitals alert flagged' : ''}`,
        'success'
      );
      loadVisitDetail(selectedVisitId);
      loadVisits();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleSaveConsult(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedVisitId) return;
    try {
      await apiFetch(`/api/visits/${selectedVisitId}/consultation`, {
        method: 'PATCH',
        body: JSON.stringify(consultForm),
      });
      onNotify('Consultation notes saved', 'success');
      loadVisitDetail(selectedVisitId);
      loadVisits();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleOrderLab() {
    if (!selectedVisitId || !selectedLabId) return;
    try {
      const res = await apiFetch<{ invoiceNumber: string }>(`/api/visits/${selectedVisitId}/orders/lab`, {
        method: 'POST',
        body: JSON.stringify({ test_id: Number(selectedLabId) }),
      });
      onNotify(`Lab test ordered · Invoice ${res.invoiceNumber} created`, 'success');
      loadVisitDetail(selectedVisitId);
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleOrderImaging() {
    if (!selectedVisitId || !selectedImagingId) return;
    try {
      const res = await apiFetch<{ invoiceNumber: string }>(`/api/visits/${selectedVisitId}/orders/imaging`, {
        method: 'POST',
        body: JSON.stringify({
          catalog_id: Number(selectedImagingId),
          clinical_question: imagingQuestion || undefined,
        }),
      });
      onNotify(`Imaging ordered · Invoice ${res.invoiceNumber} created`, 'success');
      setImagingQuestion('');
      loadVisitDetail(selectedVisitId);
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleAckCriticalLab(orderId: number) {
    if (!selectedVisitId) return;
    try {
      await apiFetch(`/api/lab/orders/${orderId}`, {
        method: 'PATCH',
        body: JSON.stringify({ action: 'ack_critical' }),
      });
      onNotify('Critical lab result acknowledged & logged', 'success');
      loadVisitDetail(selectedVisitId);
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleAdmitFromVisit(e: React.FormEvent) {
    e.preventDefault();
    if (!visitDetail) return;
    try {
      const res = await apiFetch<{ admissionNumber: string }>('/api/ipd/admissions', {
        method: 'POST',
        body: JSON.stringify({
          patient_id: visitDetail.visit.patient_id,
          visit_id: visitDetail.visit.id,
          ward_id: Number(admitWardId),
          admission_diagnosis: admitDx || visitDetail.visit.diagnosis_text || 'Inpatient observation',
        }),
      });
      onNotify(`Inpatient admission ${res.admissionNumber} ordered`, 'success');
      setShowAdmitModal(false);
      setAdmitDx('');
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleOrderRx(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedVisitId || !rxForm.medicine_id) return;
    try {
      const res = await apiFetch<{ invoiceNumber: string }>(`/api/visits/${selectedVisitId}/orders/prescription`, {
        method: 'POST',
        body: JSON.stringify({
          ...rxForm,
          medicine_id: Number(rxForm.medicine_id),
          duration_days: Number(rxForm.duration_days),
          quantity: Number(rxForm.quantity),
        }),
      });
      onNotify(`Prescription created · Invoice ${res.invoiceNumber} sent to Cashier`, 'success');
      loadVisitDetail(selectedVisitId);
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleCloseVisit() {
    if (!selectedVisitId) return;
    try {
      await apiFetch(`/api/visits/${selectedVisitId}/close`, { method: 'POST' });
      onNotify('Visit closed and locked', 'success');
      loadVisitDetail(selectedVisitId);
      loadVisits();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleReopenVisit() {
    if (!selectedVisitId || !reopenReason.trim()) return;
    try {
      await apiFetch(`/api/visits/${selectedVisitId}/reopen`, {
        method: 'POST',
        body: JSON.stringify({ reason: reopenReason }),
      });
      setReopenReason('');
      onNotify('Closed visit reopened and audited', 'success');
      loadVisitDetail(selectedVisitId);
      loadVisits();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  const v = visitDetail?.visit;
  const isClosed = v?.status === 'closed';

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
      {/* Left Visit List */}
      <div className="lg:col-span-4 bg-white border border-slate-200 rounded-lg overflow-hidden self-start">
        <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
          <h2 className="font-display text-sm font-semibold text-slate-900">OPD &amp; Triage Visits</h2>
          <span className="text-xs font-mono text-slate-500">{visits.length}</span>
        </div>
        <div className="divide-y divide-slate-100 max-h-[680px] overflow-y-auto">
          {visits.map((item) => (
            <button
              key={item.id}
              onClick={() => setSelectedVisitId(item.id)}
              className={`w-full text-left p-4 transition-colors ${
                selectedVisitId === item.id ? 'bg-teal-50/70' : 'hover:bg-slate-50'
              }`}
            >
              <div className="flex items-center justify-between text-xs font-mono">
                <span className="font-semibold text-slate-900">{item.visit_number}</span>
                <span className={item.triage_priority === 'emergency' ? 'text-red-700 font-semibold' : item.triage_priority === 'urgent' ? 'text-amber-700 font-medium' : 'text-slate-500'}>
                  {item.triage_priority} · {item.status.replace('_', ' ')}
                </span>
              </div>
              <div className="mt-1 font-medium text-sm text-slate-900">
                {item.first_name} {item.last_name}
              </div>
              <div className="text-xs text-slate-500 truncate mt-0.5">
                {item.mrn} · {item.chief_complaint || 'No chief complaint'}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Right Consultation & Triage Workspace */}
      <div className="lg:col-span-8 space-y-6">
        {!v ? (
          <div className="bg-white border border-slate-200 rounded-lg p-10 text-center text-sm text-slate-500">
            Select a visit from the left panel to record triage vitals or conduct consultation.
          </div>
        ) : (
          <>
            {/* Patient Clinical Header */}
            <div className="bg-white border border-slate-200 rounded-lg p-5 flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2 text-xs font-mono text-slate-500">
                  <span>{v.visit_number}</span>
                  <span>·</span>
                  <span>{v.mrn}</span>
                  <span>·</span>
                  <span className="capitalize">{v.patient_type}</span>
                </div>
                <h2 className="font-display text-lg font-semibold text-slate-900 mt-1">
                  {v.first_name} {v.last_name}
                </h2>
                <div className="text-xs text-slate-600 mt-1">
                  <span>{v.sex} · DOB {v.date_of_birth} · Blood {v.blood_group || 'Unknown'}</span>
                  <span className="mx-2 text-slate-300">|</span>
                  <span className={v.allergies && v.allergies !== 'None known' ? 'text-red-700 font-semibold' : 'text-slate-600'}>
                    Allergies: {v.allergies || 'None known'}
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-2">
                {!isClosed && canAdmit && (
                  <button
                    onClick={() => {
                      setAdmitDx(v.diagnosis_text || v.chief_complaint || '');
                      setShowAdmitModal(true);
                    }}
                    className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-teal-800 border border-teal-300 hover:bg-teal-50 rounded-md"
                  >
                    <BedDouble className="w-3.5 h-3.5" />
                    <span>Admit to Ward</span>
                  </button>
                )}
                {!isClosed && canCloseVisit && (
                  <button
                    onClick={handleCloseVisit}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-md"
                  >
                    <Lock className="w-3.5 h-3.5" />
                    <span>Close &amp; Lock Visit</span>
                  </button>
                )}
                {isClosed && (
                  <div className="text-xs font-medium text-slate-700 flex items-center gap-1.5">
                    <Lock className="w-3.5 h-3.5 text-slate-500" />
                    <span>Visit Locked</span>
                  </div>
                )}
              </div>
            </div>

            {/* Manager Reopen Box when closed */}
            {isClosed && canReopenVisit && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 flex flex-wrap items-center gap-3">
                <Unlock className="w-4 h-4 text-amber-800 shrink-0" />
                <input
                  value={reopenReason}
                  onChange={(e) => setReopenReason(e.target.value)}
                  placeholder="Enter mandatory audit reason to reopen closed visit..."
                  className="flex-1 min-w-[240px] px-3 py-1.5 text-xs border border-amber-300 rounded bg-white"
                />
                <button
                  onClick={handleReopenVisit}
                  className="px-3.5 py-1.5 text-xs font-medium text-white bg-amber-700 hover:bg-amber-800 rounded"
                >
                  Reopen Visit
                </button>
              </div>
            )}

            {/* Vitals & Triage Capture + History */}
            <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="font-display text-sm font-semibold text-slate-900 flex items-center gap-2">
                  <Activity className="w-4 h-4 text-teal-700" />
                  <span>Triage &amp; Vitals</span>
                </h3>
              </div>

              {visitDetail.vitals.length > 0 && (
                <div className="divide-y divide-slate-100 border border-slate-200 rounded-md">
                  {visitDetail.vitals.map((vt) => (
                    <div key={vt.id} className="p-3 flex flex-wrap items-center justify-between gap-2 text-xs">
                      <div className="font-mono tabular-nums text-slate-800">
                        BP <strong className="text-slate-900">{vt.bp_systolic}/{vt.bp_diastolic}</strong> · Temp{' '}
                        <strong className={Number(vt.temperature) >= 38.5 ? 'text-red-700' : 'text-slate-900'}>{vt.temperature}°C</strong> · Pulse{' '}
                        <strong>{vt.pulse}</strong> · SpO2{' '}
                        <strong className={Number(vt.spo2) < 92 ? 'text-red-700' : 'text-slate-900'}>{vt.spo2}%</strong> · BMI{' '}
                        <strong>{vt.bmi ?? '-'}</strong>
                      </div>
                      <div className="flex items-center gap-2">
                        {vt.early_warning_flag === 1 && (
                          <span className="inline-flex items-center gap-1 text-red-700 font-semibold">
                            <AlertTriangle className="w-3.5 h-3.5" />
                            <span>Early Warning</span>
                          </span>
                        )}
                        <span className="font-mono text-slate-400">{vt.recorded_at}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {canVitals && !isClosed && (
                <form onSubmit={handleSaveVitals} className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2">
                  <div>
                    <label className="block text-xs text-slate-600 mb-1">BP Systolic</label>
                    <input type="number" value={vitalsForm.bp_systolic} onChange={(e) => setVitalsForm({ ...vitalsForm, bp_systolic: e.target.value })} className="w-full px-2.5 py-1.5 text-xs font-mono border border-slate-300 rounded" />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-600 mb-1">BP Diastolic</label>
                    <input type="number" value={vitalsForm.bp_diastolic} onChange={(e) => setVitalsForm({ ...vitalsForm, bp_diastolic: e.target.value })} className="w-full px-2.5 py-1.5 text-xs font-mono border border-slate-300 rounded" />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-600 mb-1">Temp (°C)</label>
                    <input type="number" step="0.1" value={vitalsForm.temperature} onChange={(e) => setVitalsForm({ ...vitalsForm, temperature: e.target.value })} className="w-full px-2.5 py-1.5 text-xs font-mono border border-slate-300 rounded" />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-600 mb-1">SpO2 (%)</label>
                    <input type="number" value={vitalsForm.spo2} onChange={(e) => setVitalsForm({ ...vitalsForm, spo2: e.target.value })} className="w-full px-2.5 py-1.5 text-xs font-mono border border-slate-300 rounded" />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-600 mb-1">Pulse (bpm)</label>
                    <input type="number" value={vitalsForm.pulse} onChange={(e) => setVitalsForm({ ...vitalsForm, pulse: e.target.value })} className="w-full px-2.5 py-1.5 text-xs font-mono border border-slate-300 rounded" />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-600 mb-1">Weight (kg)</label>
                    <input type="number" step="0.1" value={vitalsForm.weight_kg} onChange={(e) => setVitalsForm({ ...vitalsForm, weight_kg: e.target.value })} className="w-full px-2.5 py-1.5 text-xs font-mono border border-slate-300 rounded" />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-600 mb-1">Height (cm)</label>
                    <input type="number" step="0.1" value={vitalsForm.height_cm} onChange={(e) => setVitalsForm({ ...vitalsForm, height_cm: e.target.value })} className="w-full px-2.5 py-1.5 text-xs font-mono border border-slate-300 rounded" />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-600 mb-1">Triage Priority</label>
                    <select value={vitalsForm.triage_priority} onChange={(e) => setVitalsForm({ ...vitalsForm, triage_priority: e.target.value })} className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded bg-white">
                      <option value="routine">Routine</option>
                      <option value="urgent">Urgent</option>
                      <option value="emergency">Emergency</option>
                    </select>
                  </div>
                  <div className="col-span-2 sm:col-span-4 flex justify-end">
                    <button type="submit" className="px-4 py-1.5 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded">
                      Record Vitals &amp; Compute BMI
                    </button>
                  </div>
                </form>
              )}
            </div>

            {/* OPD Consultation Notes */}
            <div className="bg-white border border-slate-200 rounded-lg p-5">
              <h3 className="font-display text-sm font-semibold text-slate-900 mb-4">OPD Clinical Consultation</h3>
              <form onSubmit={handleSaveConsult} className="space-y-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Chief Complaint</label>
                  <input
                    disabled={!canUpdateVisit || isClosed}
                    value={consultForm.chief_complaint}
                    onChange={(e) => setConsultForm({ ...consultForm, chief_complaint: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md disabled:bg-slate-50"
                  />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">History of Present Illness</label>
                    <textarea
                      rows={3}
                      disabled={!canUpdateVisit || isClosed}
                      value={consultForm.history_notes}
                      onChange={(e) => setConsultForm({ ...consultForm, history_notes: e.target.value })}
                      className="w-full px-3 py-2 text-xs border border-slate-300 rounded-md disabled:bg-slate-50"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Physical Examination</label>
                    <textarea
                      rows={3}
                      disabled={!canUpdateVisit || isClosed}
                      value={consultForm.exam_notes}
                      onChange={(e) => setConsultForm({ ...consultForm, exam_notes: e.target.value })}
                      className="w-full px-3 py-2 text-xs border border-slate-300 rounded-md disabled:bg-slate-50"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">ICD-10 Code</label>
                    <input
                      disabled={!canUpdateVisit || isClosed}
                      value={consultForm.diagnosis_code}
                      onChange={(e) => setConsultForm({ ...consultForm, diagnosis_code: e.target.value })}
                      placeholder="e.g. J20.9"
                      className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-md disabled:bg-slate-50"
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="block text-xs font-medium text-slate-700 mb-1">Diagnosis *</label>
                    <input
                      disabled={!canUpdateVisit || isClosed}
                      value={consultForm.diagnosis_text}
                      onChange={(e) => setConsultForm({ ...consultForm, diagnosis_text: e.target.value })}
                      placeholder="Primary diagnosis required before closing visit"
                      className="w-full px-3 py-2 text-xs border border-slate-300 rounded-md disabled:bg-slate-50"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Treatment Plan</label>
                  <textarea
                    rows={2}
                    disabled={!canUpdateVisit || isClosed}
                    value={consultForm.treatment_plan}
                    onChange={(e) => setConsultForm({ ...consultForm, treatment_plan: e.target.value })}
                    className="w-full px-3 py-2 text-xs border border-slate-300 rounded-md disabled:bg-slate-50"
                  />
                </div>
                {canUpdateVisit && !isClosed && (
                  <div className="flex justify-end pt-1">
                    <button type="submit" className="px-4 py-2 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md">
                      Save Consultation Notes
                    </button>
                  </div>
                )}
              </form>
            </div>

            {/* Orders: Lab, Imaging & Pharmacy */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-3">
                <h3 className="font-display text-sm font-semibold text-slate-900 flex items-center gap-2">
                  <FlaskConical className="w-4 h-4 text-teal-700" />
                  <span>Laboratory Orders</span>
                </h3>
                {canOrderLab && !isClosed && (
                  <div className="flex gap-2">
                    <select
                      value={selectedLabId}
                      onChange={(e) => setSelectedLabId(e.target.value)}
                      className="flex-1 px-2.5 py-1.5 text-xs border border-slate-300 rounded bg-white"
                    >
                      {labCatalog.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name} (${Number(t.price).toFixed(2)})
                        </option>
                      ))}
                    </select>
                    <button
                      onClick={handleOrderLab}
                      className="px-3 py-1.5 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded whitespace-nowrap"
                    >
                      Order Lab
                    </button>
                  </div>
                )}
                <div className="divide-y divide-slate-100 border border-slate-200 rounded-md text-xs">
                  {visitDetail.labOrders.length === 0 ? (
                    <div className="p-3 text-slate-500">No lab tests ordered for this visit.</div>
                  ) : (
                    visitDetail.labOrders.map((lo) => (
                      <div key={lo.id} className="p-2.5 flex justify-between items-center gap-2">
                        <div>
                          <div className="font-medium text-slate-900">{lo.test_name}</div>
                          <div className="text-slate-500 font-mono">
                            {lo.status} · Bill {lo.invoice_status || 'n/a'}
                          </div>
                          {lo.previous_result_value && (
                            <div className="text-[11px] text-amber-700 font-mono">
                              Amended (prev: {lo.previous_result_value})
                            </div>
                          )}
                        </div>
                        <div className="text-right space-y-1">
                          {lo.result_value && (
                            <div className={`font-mono font-semibold ${lo.abnormal_flag === 'critical' ? 'text-red-700' : 'text-slate-900'}`}>
                              {lo.result_value} {lo.abnormal_flag && lo.abnormal_flag !== 'normal' ? `(${lo.abnormal_flag})` : ''}
                            </div>
                          )}
                          {lo.abnormal_flag === 'critical' && !lo.critical_ack_at && canUpdateVisit && (
                            <button
                              onClick={() => handleAckCriticalLab(lo.id)}
                              className="px-2 py-0.5 text-[11px] font-medium text-white bg-red-700 hover:bg-red-800 rounded"
                            >
                              Ack Critical
                            </button>
                          )}
                          {lo.critical_ack_at && (
                            <div className="text-[11px] text-emerald-700 inline-flex items-center gap-1">
                              <CheckCircle2 className="w-3 h-3" />
                              <span>Acked</span>
                            </div>
                          )}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-3">
                <h3 className="font-display text-sm font-semibold text-slate-900 flex items-center gap-2">
                  <Scan className="w-4 h-4 text-teal-700" />
                  <span>Imaging Orders</span>
                </h3>
                {canOrderImaging && !isClosed && (
                  <div className="space-y-2">
                    <div className="flex gap-2">
                      <select
                        value={selectedImagingId}
                        onChange={(e) => setSelectedImagingId(e.target.value)}
                        className="flex-1 px-2.5 py-1.5 text-xs border border-slate-300 rounded bg-white"
                      >
                        {imagingCatalog.map((im) => (
                          <option key={im.id} value={im.id}>
                            [{im.modality}] {im.name} (${Number(im.price).toFixed(2)})
                          </option>
                        ))}
                      </select>
                      <button
                        onClick={handleOrderImaging}
                        className="px-3 py-1.5 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded whitespace-nowrap"
                      >
                        Order Scan
                      </button>
                    </div>
                    <input
                      value={imagingQuestion}
                      onChange={(e) => setImagingQuestion(e.target.value)}
                      placeholder="Clinical question (e.g. Rule out pneumonia)"
                      className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded"
                    />
                  </div>
                )}
                <div className="divide-y divide-slate-100 border border-slate-200 rounded-md text-xs">
                  {visitDetail.imagingOrders.length === 0 ? (
                    <div className="p-3 text-slate-500">No imaging exams ordered for this visit.</div>
                  ) : (
                    visitDetail.imagingOrders.map((io) => (
                      <div key={io.id} className="p-2.5 space-y-1">
                        <div className="flex justify-between items-center">
                          <span className="font-medium text-slate-900">[{io.modality}] {io.exam_name}</span>
                          <span className="font-mono text-slate-500">{io.status.replace('_', ' ')} · Bill {io.invoice_status || 'n/a'}</span>
                        </div>
                        {io.impression && (
                          <div className="text-slate-700">Impression: <strong>{io.impression}</strong></div>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div className="md:col-span-2 bg-white border border-slate-200 rounded-lg p-5 space-y-3">
                <h3 className="font-display text-sm font-semibold text-slate-900 flex items-center gap-2">
                  <Pill className="w-4 h-4 text-teal-700" />
                  <span>Prescriptions</span>
                </h3>
                {canPrescribe && !isClosed && (
                  <form onSubmit={handleOrderRx} className="space-y-2">
                    <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
                      <select
                        value={rxForm.medicine_id}
                        onChange={(e) => setRxForm({ ...rxForm, medicine_id: e.target.value })}
                        className="sm:col-span-2 px-2.5 py-1.5 text-xs border border-slate-300 rounded bg-white"
                      >
                        {medCatalog.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.generic_name} {m.strength} (${Number(m.unit_price).toFixed(2)} · Stock: {m.stock_qty})
                          </option>
                        ))}
                      </select>
                      <input
                        value={rxForm.dosage}
                        onChange={(e) => setRxForm({ ...rxForm, dosage: e.target.value })}
                        placeholder="Dosage"
                        className="px-2 py-1.5 text-xs border border-slate-300 rounded"
                      />
                      <div className="flex gap-2">
                        <input
                          value={rxForm.frequency}
                          onChange={(e) => setRxForm({ ...rxForm, frequency: e.target.value })}
                          placeholder="Frequency"
                          className="flex-1 px-2 py-1.5 text-xs border border-slate-300 rounded"
                        />
                        <input
                          type="number"
                          min={1}
                          value={rxForm.quantity}
                          onChange={(e) => setRxForm({ ...rxForm, quantity: e.target.value })}
                          placeholder="Qty"
                          className="w-16 px-2 py-1.5 text-xs font-mono border border-slate-300 rounded"
                        />
                      </div>
                    </div>
                    <button
                      type="submit"
                      className="px-4 py-1.5 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded"
                    >
                      Prescribe &amp; Send to Cashier/Pharmacy
                    </button>
                  </form>
                )}
                <div className="divide-y divide-slate-100 border border-slate-200 rounded-md text-xs">
                  {visitDetail.prescriptions.length === 0 ? (
                    <div className="p-3 text-slate-500">No prescriptions issued for this visit.</div>
                  ) : (
                    visitDetail.prescriptions.map((pr) => (
                      <div key={pr.id} className="p-2.5">
                        <div className="flex justify-between font-mono text-slate-500">
                          <span>Rx #{pr.id} · {pr.status}</span>
                          <span>Bill {pr.invoice_status || 'n/a'}</span>
                        </div>
                        {pr.items.map((it, idx) => (
                          <div key={idx} className="mt-1 font-medium text-slate-900">
                            {it.generic_name} {it.strength} — {it.dosage}, {it.frequency} (Qty {it.quantity})
                          </div>
                        ))}
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Admit Patient to Ward Modal */}
      {showAdmitModal && v && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-lg max-w-md w-full">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3 className="font-display text-base font-semibold text-slate-900">
                Admit {v.first_name} {v.last_name}
              </h3>
              <button onClick={() => setShowAdmitModal(false)} className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleAdmitFromVisit} className="p-6 space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Target Ward *</label>
                <select
                  required
                  value={admitWardId}
                  onChange={(e) => setAdmitWardId(e.target.value)}
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
                  value={admitDx}
                  onChange={(e) => setAdmitDx(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md"
                />
              </div>
              <div className="pt-3 border-t border-slate-200 flex justify-end gap-2">
                <button type="button" onClick={() => setShowAdmitModal(false)} className="px-4 py-2 text-xs border border-slate-300 rounded-md">
                  Cancel
                </button>
                <button type="submit" className="px-4 py-2 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md">
                  Submit Admission Order
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
