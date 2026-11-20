import React, { useCallback, useEffect, useState } from 'react';
import { BedDouble, CheckCircle2, ClipboardCheck, Plus, Sparkles, X } from 'lucide-react';
import { apiFetch } from '../lib/api';
import type {
  Admission,
  Bed,
  MedicationAdministration,
  Patient,
  UserContext,
  Ward,
} from '../types';

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

  const canCreateAdmission = user.permissions.includes('ipd.admission.create');
  const canAssignBed = user.permissions.includes('ipd.bed.assign');
  const canGiveMar = user.permissions.includes('ipd.mar.give');
  const canOrderDischarge = user.permissions.includes('ipd.discharge.create');
  const canClearDischarge = user.permissions.includes('ipd.discharge.clear');

  const loadIpd = useCallback(async () => {
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
  }, [loadIpd, canCreateAdmission, user.permissions]);

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

  async function handleClearDischarge(adm: Admission) {
    try {
      await apiFetch(`/api/ipd/admissions/${adm.id}/clear`, { method: 'POST' });
      onNotify(`Financial clearance complete · ${adm.admission_number} discharged`, 'success');
      loadIpd();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  const vacantBeds = beds.filter((b) => b.status === 'vacant' || b.status === 'reserved');
  const dueMarCount = mar.filter((m) => m.status === 'due').length;

  return (
    <div className="space-y-5">
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
                      {ward.ward_type} ward · Daily tariff ${Number(ward.daily_tariff).toFixed(2)}
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
                      <td className="py-3 px-4 text-xs text-slate-700 max-w-[260px]">
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
    </div>
  );
};
