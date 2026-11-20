import React, { useCallback, useEffect, useState } from 'react';
import { CalendarPlus, Check, Clock, X } from 'lucide-react';
import { apiFetch } from '../lib/api';
import type { Appointment, Patient, UserContext } from '../types';

interface DoctorOption {
  id: number;
  full_name: string;
  specialty: string | null;
}

interface AppointmentsViewProps {
  user: UserContext;
  onNotify: (msg: string, type?: 'success' | 'error') => void;
}

export const AppointmentsView: React.FC<AppointmentsViewProps> = ({ user, onNotify }) => {
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [doctors, setDoctors] = useState<DoctorOption[]>([]);
  const [patients, setPatients] = useState<Patient[]>([]);
  const [dateFilter, setDateFilter] = useState('');
  const [doctorFilter, setDoctorFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [showBookModal, setShowBookModal] = useState(false);

  const todayStr = new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState({
    patient_id: '',
    doctor_id: '',
    appointment_date: todayStr,
    start_time: '11:30',
    end_time: '12:00',
    visit_type: 'consultation',
    reason: '',
  });

  const canCreate = user.permissions.includes('appointment.create');
  const canUpdate = user.permissions.includes('appointment.update');

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (dateFilter) params.set('date', dateFilter);
      if (doctorFilter) params.set('doctorId', doctorFilter);
      const [apptRes, docRes] = await Promise.all([
        apiFetch<{ appointments: Appointment[] }>(`/api/appointments?${params}`),
        apiFetch<{ doctors: DoctorOption[] }>('/api/doctors'),
      ]);
      setAppointments(apptRes.appointments);
      setDoctors(docRes.doctors);
      if (!form.doctor_id && docRes.doctors[0]) {
        setForm((prev) => ({ ...prev, doctor_id: String(docRes.doctors[0].id) }));
      }
    } catch (err) {
      onNotify((err as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }, [dateFilter, doctorFilter, onNotify, form.doctor_id]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    if (canCreate && user.permissions.includes('patient.read')) {
      apiFetch<{ patients: Patient[] }>('/api/patients')
        .then((res) => {
          setPatients(res.patients);
          if (res.patients[0] && !form.patient_id) {
            setForm((prev) => ({ ...prev, patient_id: String(res.patients[0].id) }));
          }
        })
        .catch(() => {});
    }
  }, [canCreate, user.permissions, form.patient_id]);

  async function handleBook(e: React.FormEvent) {
    e.preventDefault();
    try {
      await apiFetch('/api/appointments', {
        method: 'POST',
        body: JSON.stringify({
          ...form,
          patient_id: Number(form.patient_id),
          doctor_id: Number(form.doctor_id),
        }),
      });
      onNotify('Appointment scheduled with overlap verification', 'success');
      setShowBookModal(false);
      setForm((prev) => ({ ...prev, reason: '' }));
      loadData();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleStatusChange(id: number, status: string) {
    try {
      const res = await apiFetch<{ createdVisitId?: number; ticketNumber?: string }>(`/api/appointments/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
      if (status === 'checked_in' && res.ticketNumber) {
        onNotify(`Checked in · OPD Queue ${res.ticketNumber} & consultation bill created`, 'success');
      } else {
        onNotify(`Appointment marked ${status.replace('_', ' ')}`, 'success');
      }
      loadData();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <input
            type="date"
            value={dateFilter}
            onChange={(e) => setDateFilter(e.target.value)}
            className="px-3 py-1.5 text-xs font-mono border border-slate-300 rounded-md bg-white"
          />
          <select
            value={doctorFilter}
            onChange={(e) => setDoctorFilter(e.target.value)}
            className="px-3 py-1.5 text-xs border border-slate-300 rounded-md bg-white"
          >
            <option value="">All Clinicians</option>
            {doctors.map((d) => (
              <option key={d.id} value={d.id}>{d.full_name}</option>
            ))}
          </select>
          {(dateFilter || doctorFilter) && (
            <button
              onClick={() => {
                setDateFilter('');
                setDoctorFilter('');
              }}
              className="text-xs text-slate-500 hover:text-slate-900 underline"
            >
              Clear filters
            </button>
          )}
        </div>

        {canCreate && (
          <button
            onClick={() => setShowBookModal(true)}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md whitespace-nowrap"
          >
            <CalendarPlus className="w-3.5 h-3.5" />
            <span>Book Appointment</span>
          </button>
        )}
      </div>

      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-sm text-slate-500">Loading appointments...</div>
        ) : appointments.length === 0 ? (
          <div className="p-10 text-center">
            <div className="text-sm text-slate-600 mb-3">No appointments scheduled for the selected filters.</div>
            {canCreate && (
              <button
                onClick={() => setShowBookModal(true)}
                className="px-4 py-2 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md"
              >
                Book First Appointment
              </button>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium text-slate-500">
                  <th className="py-2.5 px-4">Date &amp; Slot</th>
                  <th className="py-2.5 px-4">Patient</th>
                  <th className="py-2.5 px-4">Clinician</th>
                  <th className="py-2.5 px-4">Type &amp; Reason</th>
                  <th className="py-2.5 px-4">Status</th>
                  {canUpdate && <th className="py-2.5 px-4 text-right">Workflow Actions</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-sm">
                {appointments.map((a) => (
                  <tr key={a.id} className="hover:bg-slate-50/70">
                    <td className="py-2.5 px-4 font-mono text-xs text-slate-900 tabular-nums whitespace-nowrap">
                      <div>{a.appointment_date}</div>
                      <div className="text-slate-500 flex items-center gap-1 mt-0.5">
                        <Clock className="w-3 h-3" />
                        <span>{a.start_time} – {a.end_time}</span>
                      </div>
                    </td>
                    <td className="py-2.5 px-4">
                      <div className="font-medium text-slate-900">{a.first_name} {a.last_name}</div>
                      <div className="text-xs font-mono text-slate-500">{a.mrn} · {a.phone}</div>
                    </td>
                    <td className="py-2.5 px-4 text-xs">
                      <div className="font-medium text-slate-900">{a.doctor_name}</div>
                      {a.specialty && <div className="text-slate-500">{a.specialty}</div>}
                    </td>
                    <td className="py-2.5 px-4 text-xs text-slate-700">
                      <div className="capitalize font-medium">{a.visit_type}</div>
                      <div className="text-slate-500 truncate max-w-[220px]">{a.reason || '—'}</div>
                    </td>
                    <td className="py-2.5 px-4 text-xs">
                      <span
                        className={
                          a.status === 'checked_in'
                            ? 'text-emerald-700 font-medium'
                            : a.status === 'cancelled' || a.status === 'no_show'
                              ? 'text-red-700'
                              : 'text-slate-700 font-medium'
                        }
                      >
                        {a.status.replace('_', ' ')}
                      </span>
                    </td>
                    {canUpdate && (
                      <td className="py-2.5 px-4 text-right space-x-1.5 whitespace-nowrap">
                        {a.status === 'scheduled' && (
                          <>
                            <button
                              onClick={() => handleStatusChange(a.id, 'checked_in')}
                              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded"
                            >
                              <Check className="w-3 h-3" />
                              <span>Check In</span>
                            </button>
                            <button
                              onClick={() => handleStatusChange(a.id, 'no_show')}
                              className="px-2.5 py-1 text-xs font-medium text-amber-800 border border-amber-200 hover:bg-amber-50 rounded"
                            >
                              No-Show
                            </button>
                            <button
                              onClick={() => handleStatusChange(a.id, 'cancelled')}
                              className="px-2.5 py-1 text-xs font-medium text-red-700 border border-red-200 hover:bg-red-50 rounded"
                            >
                              Cancel
                            </button>
                          </>
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

      {/* Book Modal */}
      {showBookModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-lg max-w-lg w-full">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3 className="font-display text-base font-semibold text-slate-900">Book Appointment</h3>
              <button onClick={() => setShowBookModal(false)} className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleBook} className="p-6 space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Patient *</label>
                <select
                  required
                  value={form.patient_id}
                  onChange={(e) => setForm({ ...form, patient_id: e.target.value })}
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
                <label className="block text-xs font-medium text-slate-700 mb-1">Clinician *</label>
                <select
                  required
                  value={form.doctor_id}
                  onChange={(e) => setForm({ ...form, doctor_id: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md bg-white"
                >
                  {doctors.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.full_name} {d.specialty ? `(${d.specialty})` : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Date *</label>
                  <input
                    type="date"
                    required
                    value={form.appointment_date}
                    onChange={(e) => setForm({ ...form, appointment_date: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Start *</label>
                  <input
                    type="time"
                    required
                    value={form.start_time}
                    onChange={(e) => setForm({ ...form, start_time: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">End *</label>
                  <input
                    type="time"
                    required
                    value={form.end_time}
                    onChange={(e) => setForm({ ...form, end_time: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md font-mono"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Visit Type</label>
                <select
                  value={form.visit_type}
                  onChange={(e) => setForm({ ...form, visit_type: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md bg-white"
                >
                  <option value="consultation">Consultation ($45.00)</option>
                  <option value="follow-up">Follow-up ($25.00)</option>
                  <option value="checkup">General Checkup ($45.00)</option>
                  <option value="procedure">Minor Procedure</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Reason for Visit</label>
                <input
                  value={form.reason}
                  onChange={(e) => setForm({ ...form, reason: e.target.value })}
                  placeholder="Chief complaint or follow-up details"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md"
                />
              </div>
              <div className="pt-4 border-t border-slate-200 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setShowBookModal(false)}
                  className="px-4 py-2 text-xs font-medium text-slate-700 border border-slate-300 rounded-md"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md"
                >
                  Confirm Booking
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
