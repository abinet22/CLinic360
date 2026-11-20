import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Eye, GitMerge, Plus, Search, UserPlus, X } from 'lucide-react';
import { apiFetch } from '../lib/api';
import type { Patient, QueueTicket, UserContext } from '../types';

interface PatientsQueueViewProps {
  user: UserContext;
  onNotify: (msg: string, type?: 'success' | 'error') => void;
}

interface PatientDetailPayload {
  patient: Patient;
  clinicalMasked: boolean;
  appointments: Array<{ id: number; appointment_date: string; start_time: string; doctor_name: string; status: string }>;
  visits: Array<{ id: number; visit_number: string; diagnosis_text: string | null; status: string; created_at: string; doctor_name: string | null }>;
  vitals: Array<{ id: number; bp_systolic: number | null; bp_diastolic: number | null; temperature: number | null; spo2: number | null; recorded_at: string }>;
  invoices: Array<{ id: number; invoice_number: string; total_amount: number; paid_amount: number; status: string; created_at: string }>;
  accessHistory: Array<{ id: number; occurred_at: string; user_name: string; role_at_time: string; action: string }>;
}

export const PatientsQueueView: React.FC<PatientsQueueViewProps> = ({ user, onNotify }) => {
  const [subTab, setSubTab] = useState<'patients' | 'queue'>('patients');
  const [search, setSearch] = useState('');
  const [patients, setPatients] = useState<Patient[]>([]);
  const [clinicalMasked, setClinicalMasked] = useState(false);
  const [tickets, setTickets] = useState<QueueTicket[]>([]);
  const [deptFilter, setDeptFilter] = useState('ALL');
  const [loading, setLoading] = useState(true);

  const [showRegister, setShowRegister] = useState(false);
  const [duplicates, setDuplicates] = useState<Array<{ id: number; mrn: string; first_name: string; last_name: string; phone: string }>>([]);
  const [form, setForm] = useState({
    first_name: '',
    last_name: '',
    sex: 'Female',
    date_of_birth: '1992-05-14',
    phone: '',
    email: '',
    address: '',
    next_of_kin_name: '',
    next_of_kin_phone: '',
    blood_group: 'O+',
    allergies: 'None known',
    patient_type: 'self-pay',
    payer_name: '',
    insurance_number: '',
    issue_queue_ticket: true,
    charge_registration_card: true,
  });

  const [selectedDetail, setSelectedDetail] = useState<PatientDetailPayload | null>(null);
  const [showMerge, setShowMerge] = useState(false);
  const [mergeSourceId, setMergeSourceId] = useState('');
  const [mergeTargetId, setMergeTargetId] = useState('');
  const [mergeReason, setMergeReason] = useState('');

  const canCreate = user.permissions.includes('patient.create');
  const canQueue = user.permissions.includes('queue.manage');
  const canMerge = user.permissions.includes('patient.merge');

  const loadPatients = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch<{ patients: Patient[]; clinicalMasked: boolean }>(
        `/api/patients?q=${encodeURIComponent(search)}`
      );
      setPatients(res.patients);
      setClinicalMasked(res.clinicalMasked);
    } catch (err) {
      onNotify((err as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }, [search, onNotify]);

  const loadQueue = useCallback(async () => {
    try {
      const res = await apiFetch<{ tickets: QueueTicket[] }>(`/api/queue?department=${deptFilter}`);
      setTickets(res.tickets);
    } catch {
      // ignore if role doesn't have queue access
    }
  }, [deptFilter]);

  useEffect(() => {
    loadPatients();
  }, [loadPatients]);

  useEffect(() => {
    loadQueue();
  }, [loadQueue]);

  async function checkDuplicates() {
    if (!form.first_name && !form.phone) return;
    try {
      const params = new URLSearchParams({
        first_name: form.first_name,
        last_name: form.last_name,
        date_of_birth: form.date_of_birth,
        phone: form.phone,
      });
      const res = await apiFetch<{ duplicates: typeof duplicates }>(`/api/patients/check-duplicate?${params}`);
      setDuplicates(res.duplicates);
    } catch {
      // ignore
    }
  }

  async function handleCreatePatient(e: React.FormEvent) {
    e.preventDefault();
    try {
      const res = await apiFetch<{ patient: Patient; ticketNumber: string | null }>('/api/patients', {
        method: 'POST',
        body: JSON.stringify(form),
      });
      onNotify(
        `Registered ${res.patient.first_name} ${res.patient.last_name} (${res.patient.mrn})${res.ticketNumber ? ` · Queue ${res.ticketNumber}` : ''}`,
        'success'
      );
      setShowRegister(false);
      setDuplicates([]);
      setForm({
        ...form,
        first_name: '',
        last_name: '',
        phone: '',
        email: '',
        address: '',
        next_of_kin_name: '',
        next_of_kin_phone: '',
        payer_name: '',
        insurance_number: '',
      });
      loadPatients();
      loadQueue();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function openPatientDetail(id: number) {
    try {
      const detail = await apiFetch<PatientDetailPayload>(`/api/patients/${id}`);
      setSelectedDetail(detail);
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function updateTicketStatus(ticketId: number, status?: string, priority?: string) {
    try {
      await apiFetch(`/api/queue/${ticketId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status, priority }),
      });
      loadQueue();
      onNotify('Queue ticket updated', 'success');
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function issueQuickTicket(patientId: number, department = 'OPD') {
    try {
      const res = await apiFetch<{ ticketNumber: string }>('/api/queue', {
        method: 'POST',
        body: JSON.stringify({ patient_id: patientId, department, priority: 'routine' }),
      });
      onNotify(`Issued queue ticket ${res.ticketNumber} (${department})`, 'success');
      loadQueue();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleMergePatients(e: React.FormEvent) {
    e.preventDefault();
    try {
      const res = await apiFetch<{ mergedMrn: string; intoMrn: string }>('/api/patients/merge', {
        method: 'POST',
        body: JSON.stringify({
          source_patient_id: Number(mergeSourceId),
          target_patient_id: Number(mergeTargetId),
          reason: mergeReason,
        }),
      });
      onNotify(`Merged ${res.mergedMrn} into primary chart ${res.intoMrn}`, 'success');
      setShowMerge(false);
      setMergeReason('');
      loadPatients();
      loadQueue();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  return (
    <div className="space-y-5">
      {/* Sub-navigation & Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-1 p-1 bg-slate-200/70 rounded-lg">
          <button
            onClick={() => setSubTab('patients')}
            className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              subTab === 'patients' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Patient Registry ({patients.length})
          </button>
          <button
            onClick={() => setSubTab('queue')}
            className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              subTab === 'queue' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Department Queue ({tickets.length})
          </button>
        </div>

        <div className="flex items-center gap-2">
          {canMerge && patients.length >= 2 && (
            <button
              onClick={() => {
                setMergeSourceId(String(patients[patients.length - 1]?.id || ''));
                setMergeTargetId(String(patients[0]?.id || ''));
                setShowMerge(true);
              }}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-md whitespace-nowrap"
            >
              <GitMerge className="w-3.5 h-3.5" />
              <span>Merge Duplicates</span>
            </button>
          )}
          {canCreate && (
            <button
              onClick={() => setShowRegister(true)}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md transition-colors whitespace-nowrap"
            >
              <UserPlus className="w-3.5 h-3.5" />
              <span>Register Patient</span>
            </button>
          )}
        </div>
      </div>

      {subTab === 'patients' && (
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="p-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
            <div className="relative flex-1 min-w-[260px] max-w-md">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by MRN, patient name, or phone..."
                className="w-full pl-9 pr-3 py-2 text-sm border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
              />
            </div>
            {clinicalMasked && (
              <div className="text-xs text-slate-500">
                Clinical fields (allergies, blood group) masked for your role
              </div>
            )}
          </div>

          {loading ? (
            <div className="p-8 text-center text-sm text-slate-500">Loading patient records...</div>
          ) : patients.length === 0 ? (
            <div className="p-10 text-center">
              <div className="text-sm text-slate-600 mb-3">No matching patient records found.</div>
              {canCreate && (
                <button
                  onClick={() => setShowRegister(true)}
                  className="px-4 py-2 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md"
                >
                  Register New Patient
                </button>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium text-slate-500">
                    <th className="py-2.5 px-4">MRN</th>
                    <th className="py-2.5 px-4">Patient Name</th>
                    <th className="py-2.5 px-4">Demographics</th>
                    <th className="py-2.5 px-4">Phone</th>
                    <th className="py-2.5 px-4">Payer Type</th>
                    {!clinicalMasked && <th className="py-2.5 px-4">Allergies / Blood</th>}
                    <th className="py-2.5 px-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-sm">
                  {patients.map((p) => (
                    <tr key={p.id} className="hover:bg-slate-50/80">
                      <td className="py-2.5 px-4 font-mono text-xs font-medium text-teal-800 tabular-nums whitespace-nowrap">
                        {p.mrn}
                      </td>
                      <td className="py-2.5 px-4 font-medium text-slate-900 whitespace-nowrap">
                        {p.first_name} {p.last_name}
                      </td>
                      <td className="py-2.5 px-4 text-xs text-slate-600 whitespace-nowrap">
                        <span>{p.sex}</span>
                        <span className="mx-1.5 text-slate-300">·</span>
                        <span className="font-mono tabular-nums">{p.date_of_birth}</span>
                      </td>
                      <td className="py-2.5 px-4 font-mono text-xs text-slate-700 tabular-nums whitespace-nowrap">
                        {p.phone}
                      </td>
                      <td className="py-2.5 px-4 text-xs text-slate-700 whitespace-nowrap">
                        <span className="capitalize font-medium">{p.patient_type}</span>
                        {p.payer_name && <span className="text-slate-500"> · {p.payer_name}</span>}
                      </td>
                      {!clinicalMasked && (
                        <td className="py-2.5 px-4 text-xs">
                          <span className={p.allergies && p.allergies !== 'None known' ? 'text-red-700 font-medium' : 'text-slate-500'}>
                            {p.allergies || 'None known'}
                          </span>
                          {p.blood_group && (
                            <span className="text-slate-400 font-mono"> · {p.blood_group}</span>
                          )}
                        </td>
                      )}
                      <td className="py-2.5 px-4 text-right whitespace-nowrap space-x-2">
                        <button
                          onClick={() => openPatientDetail(p.id)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-700 hover:text-teal-800 border border-slate-200 hover:border-teal-600 rounded"
                        >
                          <Eye className="w-3 h-3" />
                          <span>360° Record</span>
                        </button>
                        {canQueue && (
                          <button
                            onClick={() => issueQuickTicket(p.id, 'OPD')}
                            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-teal-800 hover:bg-teal-50 border border-teal-200 rounded"
                          >
                            <Plus className="w-3 h-3" />
                            <span>Queue</span>
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

      {subTab === 'queue' && (
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="p-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-md">
              {['ALL', 'OPD', 'LAB', 'PHA', 'CSH'].map((d) => (
                <button
                  key={d}
                  onClick={() => setDeptFilter(d)}
                  className={`px-3 py-1 text-xs font-medium rounded ${
                    deptFilter === d ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {d}
                </button>
              ))}
            </div>
            <div className="text-xs text-slate-500">Ordered by triage priority (Emergency &gt; Urgent &gt; Routine)</div>
          </div>

          {tickets.length === 0 ? (
            <div className="p-10 text-center text-sm text-slate-500">No active tickets in this department queue.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium text-slate-500">
                    <th className="py-2.5 px-4">Ticket</th>
                    <th className="py-2.5 px-4">Department</th>
                    <th className="py-2.5 px-4">Patient</th>
                    <th className="py-2.5 px-4">Priority</th>
                    <th className="py-2.5 px-4">Status</th>
                    {canQueue && <th className="py-2.5 px-4 text-right">Queue Controls</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-sm">
                  {tickets.map((t) => (
                    <tr key={t.id} className="hover:bg-slate-50/70">
                      <td className="py-2.5 px-4 font-mono text-xs font-semibold text-slate-900 tabular-nums">
                        {t.ticket_number}
                      </td>
                      <td className="py-2.5 px-4 font-mono text-xs text-slate-600">{t.department}</td>
                      <td className="py-2.5 px-4">
                        <div className="font-medium text-slate-900">{t.first_name} {t.last_name}</div>
                        <div className="text-xs font-mono text-slate-500">{t.mrn}</div>
                      </td>
                      <td className="py-2.5 px-4 text-xs">
                        <span className={t.priority === 'emergency' ? 'text-red-700 font-semibold' : t.priority === 'urgent' ? 'text-amber-700 font-medium' : 'text-slate-600'}>
                          {t.priority}
                        </span>
                      </td>
                      <td className="py-2.5 px-4 text-xs text-slate-700">
                        {t.status.replace('_', ' ')}
                      </td>
                      {canQueue && (
                        <td className="py-2.5 px-4 text-right space-x-1.5 whitespace-nowrap">
                          {t.status === 'waiting' && (
                            <button
                              onClick={() => updateTicketStatus(t.id, 'called')}
                              className="px-2.5 py-1 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded"
                            >
                              Call Next
                            </button>
                          )}
                          {t.status === 'called' && (
                            <button
                              onClick={() => updateTicketStatus(t.id, 'in_service')}
                              className="px-2.5 py-1 text-xs font-medium text-white bg-sky-700 hover:bg-sky-800 rounded"
                            >
                              Start Service
                            </button>
                          )}
                          <button
                            onClick={() => updateTicketStatus(t.id, 'completed')}
                            className="px-2.5 py-1 text-xs font-medium text-slate-700 border border-slate-200 hover:bg-slate-50 rounded"
                          >
                            Complete
                          </button>
                          {t.priority !== 'emergency' && (
                            <button
                              onClick={() => updateTicketStatus(t.id, undefined, 'urgent')}
                              className="px-2.5 py-1 text-xs font-medium text-amber-800 border border-amber-200 hover:bg-amber-50 rounded"
                            >
                              Prioritize
                            </button>
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

      {/* Register Patient Modal */}
      {showRegister && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3 className="font-display text-base font-semibold text-slate-900">New Patient Registration</h3>
              <button onClick={() => setShowRegister(false)} className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleCreatePatient} className="p-6 space-y-4">
              {duplicates.length > 0 && (
                <div className="p-3 bg-amber-50 border border-amber-200 rounded-md text-xs text-amber-900 flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
                  <div>
                    <div className="font-semibold">Potential Duplicate Patient Found</div>
                    {duplicates.map((d) => (
                      <div key={d.id} className="mt-0.5 font-mono">
                        {d.mrn} — {d.first_name} {d.last_name} ({d.phone})
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">First Name *</label>
                  <input
                    required
                    value={form.first_name}
                    onBlur={checkDuplicates}
                    onChange={(e) => setForm({ ...form, first_name: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Last Name *</label>
                  <input
                    required
                    value={form.last_name}
                    onBlur={checkDuplicates}
                    onChange={(e) => setForm({ ...form, last_name: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Sex *</label>
                  <select
                    value={form.sex}
                    onChange={(e) => setForm({ ...form, sex: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md bg-white"
                  >
                    <option value="Female">Female</option>
                    <option value="Male">Male</option>
                    <option value="Other">Other</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Date of Birth *</label>
                  <input
                    type="date"
                    required
                    value={form.date_of_birth}
                    onBlur={checkDuplicates}
                    onChange={(e) => setForm({ ...form, date_of_birth: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Phone *</label>
                  <input
                    required
                    value={form.phone}
                    onBlur={checkDuplicates}
                    onChange={(e) => setForm({ ...form, phone: e.target.value })}
                    placeholder="+1-555-0190"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Patient Payer Type</label>
                  <select
                    value={form.patient_type}
                    onChange={(e) => setForm({ ...form, patient_type: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md bg-white"
                  >
                    <option value="self-pay">Self-Pay</option>
                    <option value="insurance">Insurance</option>
                    <option value="credit">Credit (Company / NGO)</option>
                    <option value="exempt">Exempt (Staff / Free Care)</option>
                  </select>
                </div>
                {(form.patient_type === 'insurance' || form.patient_type === 'credit') && (
                  <>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">Insurer / Payer Name</label>
                      <input
                        value={form.payer_name}
                        onChange={(e) => setForm({ ...form, payer_name: e.target.value })}
                        className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">Policy / Member Number</label>
                      <input
                        value={form.insurance_number}
                        onChange={(e) => setForm({ ...form, insurance_number: e.target.value })}
                        className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md font-mono"
                      />
                    </div>
                  </>
                )}
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Blood Group</label>
                  <select
                    value={form.blood_group}
                    onChange={(e) => setForm({ ...form, blood_group: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md bg-white"
                  >
                    {['O+', 'O-', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'Unknown'].map((bg) => (
                      <option key={bg} value={bg}>{bg}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Known Allergies</label>
                  <input
                    value={form.allergies}
                    onChange={(e) => setForm({ ...form, allergies: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-slate-700 mb-1">Residential Address</label>
                  <input
                    value={form.address}
                    onChange={(e) => setForm({ ...form, address: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md"
                  />
                </div>
              </div>

              <div className="pt-2 flex flex-wrap gap-5 text-xs text-slate-700">
                <label className="inline-flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={form.issue_queue_ticket}
                    onChange={(e) => setForm({ ...form, issue_queue_ticket: e.target.checked })}
                  />
                  <span>Issue OPD queue ticket immediately</span>
                </label>
                <label className="inline-flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={form.charge_registration_card}
                    onChange={(e) => setForm({ ...form, charge_registration_card: e.target.checked })}
                  />
                  <span>Generate $15.00 registration card invoice</span>
                </label>
              </div>

              <div className="pt-4 border-t border-slate-200 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setShowRegister(false)}
                  className="px-4 py-2 text-xs font-medium text-slate-700 border border-slate-300 rounded-md hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md"
                >
                  Save Patient &amp; Generate MRN
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Patient 360 Record Modal */}
      {selectedDetail && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-lg max-w-4xl w-full max-h-[90vh] overflow-y-auto">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <div>
                <h3 className="font-display text-base font-semibold text-slate-900">
                  {selectedDetail.patient.first_name} {selectedDetail.patient.last_name}
                </h3>
                <div className="text-xs text-slate-500 font-mono mt-0.5">
                  {selectedDetail.patient.mrn} · {selectedDetail.patient.sex} · DOB {selectedDetail.patient.date_of_birth} · {selectedDetail.patient.phone}
                </div>
              </div>
              <button onClick={() => setSelectedDetail(null)} className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 space-y-6">
              {/* Summary Strip */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 pb-5 border-b border-slate-200 text-xs">
                <div>
                  <div className="text-slate-500">Payer Category</div>
                  <div className="mt-1 font-medium text-slate-900 capitalize">
                    {selectedDetail.patient.patient_type}
                    {selectedDetail.patient.payer_name ? ` (${selectedDetail.patient.payer_name})` : ''}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500">Blood Group</div>
                  <div className="mt-1 font-mono font-medium text-slate-900">
                    {selectedDetail.patient.blood_group || 'Not recorded'}
                  </div>
                </div>
                <div className="col-span-2">
                  <div className="text-slate-500">Recorded Allergies</div>
                  <div className={`mt-1 font-medium ${selectedDetail.patient.allergies && !selectedDetail.clinicalMasked && selectedDetail.patient.allergies !== 'None known' ? 'text-red-700' : 'text-slate-900'}`}>
                    {selectedDetail.patient.allergies || 'None known'}
                  </div>
                </div>
              </div>

              {selectedDetail.clinicalMasked ? (
                <div className="p-4 bg-slate-50 border border-slate-200 rounded-md text-xs text-slate-600">
                  Clinical encounters, vitals, and diagnostic notes are hidden because your assigned role does not hold clinical read permissions.
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div>
                    <h4 className="text-xs font-semibold text-slate-900 mb-2.5">OPD Visits &amp; Diagnoses</h4>
                    {selectedDetail.visits.length === 0 ? (
                      <div className="text-xs text-slate-500">No recorded visits yet.</div>
                    ) : (
                      <div className="divide-y divide-slate-100 border border-slate-200 rounded-md">
                        {selectedDetail.visits.map((v) => (
                          <div key={v.id} className="p-3 text-xs">
                            <div className="flex justify-between font-mono text-slate-500">
                              <span>{v.visit_number}</span>
                              <span>{v.status}</span>
                            </div>
                            <div className="font-medium text-slate-900 mt-1">
                              {v.diagnosis_text || 'Diagnosis pending'}
                            </div>
                            <div className="text-slate-500 mt-0.5">{v.doctor_name || 'Unassigned'}</div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div>
                    <h4 className="text-xs font-semibold text-slate-900 mb-2.5">Recent Vitals</h4>
                    {selectedDetail.vitals.length === 0 ? (
                      <div className="text-xs text-slate-500">No vitals recorded.</div>
                    ) : (
                      <div className="divide-y divide-slate-100 border border-slate-200 rounded-md">
                        {selectedDetail.vitals.map((vt) => (
                          <div key={vt.id} className="p-3 text-xs font-mono tabular-nums">
                            <div className="text-slate-900">
                              BP {vt.bp_systolic ?? '-'}/{vt.bp_diastolic ?? '-'} · Temp {vt.temperature ?? '-'}°C · SpO2 {vt.spo2 ?? '-'}%
                            </div>
                            <div className="text-slate-500 mt-0.5">{vt.recorded_at}</div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {selectedDetail.invoices.length > 0 && (
                <div>
                  <h4 className="text-xs font-semibold text-slate-900 mb-2.5">Patient Billing Ledger</h4>
                  <div className="border border-slate-200 rounded-md overflow-hidden">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-slate-50 border-b border-slate-200 text-slate-500">
                        <tr>
                          <th className="py-2 px-3">Invoice</th>
                          <th className="py-2 px-3 text-right">Total</th>
                          <th className="py-2 px-3 text-right">Paid</th>
                          <th className="py-2 px-3">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {selectedDetail.invoices.map((inv) => (
                          <tr key={inv.id}>
                            <td className="py-2 px-3 font-mono">{inv.invoice_number}</td>
                            <td className="py-2 px-3 text-right font-mono tabular-nums">${Number(inv.total_amount).toFixed(2)}</td>
                            <td className="py-2 px-3 text-right font-mono tabular-nums">${Number(inv.paid_amount).toFixed(2)}</td>
                            <td className="py-2 px-3 capitalize">{inv.status.replace('_', ' ')}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {selectedDetail.accessHistory.length > 0 && (
                <div>
                  <h4 className="text-xs font-semibold text-slate-900 mb-2 flex items-center gap-1.5">
                    <CheckCircle2 className="w-3.5 h-3.5 text-teal-700" />
                    <span>Record Access Audit Trail (Who Viewed This Patient)</span>
                  </h4>
                  <div className="border border-slate-200 rounded-md divide-y divide-slate-100 text-xs">
                    {selectedDetail.accessHistory.slice(0, 6).map((h) => (
                      <div key={h.id} className="px-3 py-2 flex items-center justify-between text-slate-600">
                        <span>
                          <strong className="text-slate-900">{h.user_name}</strong> ({h.role_at_time}) — <span className="font-mono">{h.action}</span>
                        </span>
                        <span className="font-mono text-slate-400 tabular-nums">{h.occurred_at}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      {/* Merge Duplicate Patients Modal */}
      {showMerge && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-lg max-w-md w-full">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3 className="font-display text-base font-semibold text-slate-900">Merge Duplicate Patient Charts</h3>
              <button onClick={() => setShowMerge(false)} className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleMergePatients} className="p-6 space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Duplicate Chart (Source — will be archived) *</label>
                <select
                  required
                  value={mergeSourceId}
                  onChange={(e) => setMergeSourceId(e.target.value)}
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-md bg-white"
                >
                  {patients.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.mrn} — {p.first_name} {p.last_name} ({p.phone})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Primary Chart (Target — receives all history) *</label>
                <select
                  required
                  value={mergeTargetId}
                  onChange={(e) => setMergeTargetId(e.target.value)}
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-md bg-white"
                >
                  {patients.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.mrn} — {p.first_name} {p.last_name} ({p.phone})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Mandatory Audit Reason *</label>
                <textarea
                  required
                  rows={2}
                  value={mergeReason}
                  onChange={(e) => setMergeReason(e.target.value)}
                  placeholder="Confirm identity verification across both MRNs"
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-md"
                />
              </div>
              <div className="pt-3 border-t border-slate-200 flex justify-end gap-2">
                <button type="button" onClick={() => setShowMerge(false)} className="px-4 py-2 text-xs border border-slate-300 rounded-md">
                  Cancel
                </button>
                <button type="submit" className="px-4 py-2 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-md">
                  Execute Audited Merge
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
