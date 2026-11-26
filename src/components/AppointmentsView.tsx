import React, { useCallback, useEffect, useState } from 'react';
import { CalendarDays, CalendarOff, CalendarPlus, Check, Clock, List, Trash2, X } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { useRealtimeSync } from '../lib/useRealtimeSync';
import type { Appointment, DoctorBlock, Patient, UserContext } from '../types';

interface DoctorOption {
  id: number;
  full_name: string;
  specialty: string | null;
}

interface AppointmentsViewProps {
  user: UserContext;
  onNotify: (msg: string, type?: 'success' | 'error') => void;
}

const GRID_HOURS = ['08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00'];

export const AppointmentsView: React.FC<AppointmentsViewProps> = ({ user, onNotify }) => {
  const todayStr = new Date().toISOString().slice(0, 10);

  const [viewMode, setViewMode] = useState<'table' | 'calendar'>('table');
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [blocks, setBlocks] = useState<DoctorBlock[]>([]);
  const [doctors, setDoctors] = useState<DoctorOption[]>([]);
  const [patients, setPatients] = useState<Patient[]>([]);
  const [dateFilter, setDateFilter] = useState('');
  const [calendarDate, setCalendarDate] = useState(todayStr);
  const [doctorFilter, setDoctorFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [showBookModal, setShowBookModal] = useState(false);
  const [showBlockModal, setShowBlockModal] = useState(false);

  const [form, setForm] = useState({
    patient_id: '',
    doctor_id: '',
    appointment_date: todayStr,
    start_time: '11:30',
    end_time: '12:00',
    visit_type: 'consultation',
    reason: '',
  });

  const [blockForm, setBlockForm] = useState({
    doctor_id: '',
    block_date: todayStr,
    start_time: '13:00',
    end_time: '17:00',
    block_type: 'off_duty' as 'leave' | 'off_duty' | 'surgery' | 'unavailable',
    reason: '',
  });

  const isDoctorOnly =
    user.roles.includes('DOC') &&
    !user.roles.includes('MGR') &&
    !user.roles.includes('ADM') &&
    !user.roles.includes('AUD');
  const canCreate = user.permissions.includes('appointment.create');
  const canUpdate = user.permissions.includes('appointment.update');
  const canManageBlocks = user.permissions.includes('appointment.block.manage');

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      const effectiveDate = viewMode === 'calendar' ? calendarDate : dateFilter;
      if (effectiveDate) params.set('date', effectiveDate);
      if (doctorFilter) params.set('doctorId', doctorFilter);
      const [apptRes, docRes, blkRes] = await Promise.all([
        apiFetch<{ appointments: Appointment[] }>(`/api/appointments?${params}`),
        apiFetch<{ doctors: DoctorOption[] }>('/api/doctors'),
        apiFetch<{ blocks: DoctorBlock[] }>(`/api/appointments/blocks?${params}`),
      ]);
      setAppointments(apptRes.appointments);
      setDoctors(docRes.doctors);
      setBlocks(blkRes.blocks);
      if (docRes.doctors[0]) {
        const firstDocId = String(docRes.doctors[0].id);
        setForm((prev) => (prev.doctor_id ? prev : { ...prev, doctor_id: firstDocId }));
        setBlockForm((prev) => (prev.doctor_id ? prev : { ...prev, doctor_id: firstDocId }));
      }
    } catch (err) {
      onNotify((err as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }, [viewMode, calendarDate, dateFilter, doctorFilter, onNotify]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useRealtimeSync(['visit:updated', 'queue:updated', 'payment:confirmed'], () => {
    loadData();
  });

  useEffect(() => {
    if (canCreate && user.permissions.includes('patient.read')) {
      apiFetch<{ patients: Patient[] }>('/api/patients')
        .then((res) => {
          setPatients(res.patients);
          if (res.patients[0]) {
            setForm((prev) => (prev.patient_id ? prev : { ...prev, patient_id: String(res.patients[0].id) }));
          }
        })
        .catch(() => {});
    }
  }, [canCreate, user.permissions]);

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
      onNotify('Appointment scheduled with overlap & availability verification', 'success');
      setShowBookModal(false);
      setForm((prev) => ({ ...prev, reason: '' }));
      loadData();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleCreateBlock(e: React.FormEvent) {
    e.preventDefault();
    try {
      await apiFetch('/api/appointments/blocks', {
        method: 'POST',
        body: JSON.stringify({
          ...blockForm,
          doctor_id: Number(blockForm.doctor_id),
        }),
      });
      onNotify('Clinician schedule block saved', 'success');
      setShowBlockModal(false);
      setBlockForm((prev) => ({ ...prev, reason: '' }));
      loadData();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleDeleteBlock(blockId: number) {
    try {
      await apiFetch(`/api/appointments/blocks/${blockId}`, { method: 'DELETE' });
      onNotify('Clinician schedule block removed', 'success');
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

  function openPrefilledBooking(doctorId: number, hourStr: string) {
    const startH = Number(hourStr.slice(0, 2));
    const endH = String(startH + 1).padStart(2, '0');
    setForm((prev) => ({
      ...prev,
      doctor_id: String(doctorId),
      appointment_date: calendarDate,
      start_time: hourStr,
      end_time: `${endH}:00`,
    }));
    setShowBookModal(true);
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="inline-flex items-center p-0.5 bg-slate-200/70 rounded-md">
            <button
              onClick={() => setViewMode('table')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded whitespace-nowrap ${
                viewMode === 'table' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <List className="w-3.5 h-3.5" />
              <span>List</span>
            </button>
            <button
              onClick={() => setViewMode('calendar')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded whitespace-nowrap ${
                viewMode === 'calendar' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <CalendarDays className="w-3.5 h-3.5" />
              <span>Calendar Grid</span>
            </button>
          </div>

          {viewMode === 'table' ? (
            <input
              type="date"
              value={dateFilter}
              onChange={(e) => setDateFilter(e.target.value)}
              className="px-3 py-1.5 text-xs font-mono border border-slate-300 rounded-md bg-white"
            />
          ) : (
            <input
              type="date"
              value={calendarDate}
              onChange={(e) => setCalendarDate(e.target.value)}
              className="px-3 py-1.5 text-xs font-mono border border-slate-300 rounded-md bg-white"
            />
          )}

          {!isDoctorOnly && (
            <select
              value={doctorFilter}
              onChange={(e) => setDoctorFilter(e.target.value)}
              className="px-3 py-1.5 text-xs border border-slate-300 rounded-md bg-white"
            >
              <option value="">All Clinicians</option>
              {doctors.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.full_name}
                </option>
              ))}
            </select>
          )}

          {viewMode === 'table' && (dateFilter || (!isDoctorOnly && doctorFilter)) && (
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

        <div className="flex flex-wrap items-center gap-2">
          {canManageBlocks && (
            <button
              onClick={() => {
                setBlockForm((prev) => ({
                  ...prev,
                  block_date: viewMode === 'calendar' ? calendarDate : todayStr,
                }));
                setShowBlockModal(true);
              }}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-md whitespace-nowrap"
            >
              <CalendarOff className="w-3.5 h-3.5 text-amber-700" />
              <span>Block Availability / Leave</span>
            </button>
          )}
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
      </div>

      {/* Active Clinician Blocks Strip */}
      {blocks.length > 0 && (
        <div className="bg-amber-50/70 border border-amber-200 rounded-lg p-3.5">
          <div className="text-xs font-semibold text-amber-900 mb-2 flex items-center gap-1.5">
            <CalendarOff className="w-3.5 h-3.5 text-amber-700" />
            <span>Clinician Unavailability &amp; Leave Blocks ({blocks.length})</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {blocks.map((b) => (
              <div
                key={b.id}
                className="bg-white border border-amber-200 rounded px-3 py-2 flex items-center justify-between gap-2 text-xs"
              >
                <div className="min-w-0">
                  <div className="font-medium text-slate-900 truncate">{b.doctor_name}</div>
                  <div className="font-mono text-[11px] text-amber-800">
                    {b.block_date} · {b.start_time}–{b.end_time} · {b.block_type.replace('_', ' ')}
                  </div>
                  {b.reason && <div className="text-[11px] text-slate-500 truncate">{b.reason}</div>}
                </div>
                {canManageBlocks && (
                  <button
                    onClick={() => handleDeleteBlock(b.id)}
                    title="Remove schedule block"
                    className="p-1 text-slate-400 hover:text-red-700 shrink-0"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {viewMode === 'calendar' ? (
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between bg-slate-50/70">
            <div className="text-xs font-semibold text-slate-900">
              Daily Clinician Schedule Grid · <span className="font-mono">{calendarDate}</span>
            </div>
            <div className="text-[11px] text-slate-500">
              Click any open slot to schedule an appointment
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-slate-500 font-medium">
                  <th className="py-2.5 px-3 w-20 font-mono">Time</th>
                  {(isDoctorOnly
                    ? doctors.filter((d) => d.id === user.id)
                    : doctorFilter
                      ? doctors.filter((d) => String(d.id) === doctorFilter)
                      : doctors
                  ).map((doc) => (
                    <th key={doc.id} className="py-2.5 px-3 min-w-[210px] border-l border-slate-200">
                      <div className="text-slate-900 font-semibold">{doc.full_name}</div>
                      {doc.specialty && <div className="text-[11px] font-normal text-slate-500">{doc.specialty}</div>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {GRID_HOURS.map((hour) => {
                  const hourNum = Number(hour.slice(0, 2));
                  const nextHourStr = `${String(hourNum + 1).padStart(2, '0')}:00`;
                  const visibleDocs = isDoctorOnly
                    ? doctors.filter((d) => d.id === user.id)
                    : doctorFilter
                      ? doctors.filter((d) => String(d.id) === doctorFilter)
                      : doctors;

                  return (
                    <tr key={hour}>
                      <td className="py-2.5 px-3 font-mono text-slate-500 align-top bg-slate-50/50">
                        {hour}
                      </td>
                      {visibleDocs.map((doc) => {
                        const slotAppts = appointments.filter(
                          (a) =>
                            a.doctor_id === doc.id &&
                            a.appointment_date === calendarDate &&
                            a.status !== 'cancelled' &&
                            a.start_time < nextHourStr &&
                            a.end_time > hour
                        );
                        const slotBlocks = blocks.filter(
                          (b) =>
                            b.doctor_id === doc.id &&
                            b.block_date === calendarDate &&
                            b.start_time < nextHourStr &&
                            b.end_time > hour
                        );

                        return (
                          <td key={doc.id} className="p-2 border-l border-slate-200 align-top">
                            <div className="space-y-1.5 min-h-[42px]">
                              {slotBlocks.map((blk) => (
                                <div
                                  key={`blk-${blk.id}`}
                                  className="px-2 py-1.5 bg-amber-50 border border-amber-200 rounded text-[11px]"
                                >
                                  <div className="font-semibold text-amber-900 uppercase">
                                    {blk.block_type.replace('_', ' ')} ({blk.start_time}–{blk.end_time})
                                  </div>
                                  <div className="text-amber-800 truncate">{blk.reason || 'Blocked'}</div>
                                </div>
                              ))}

                              {slotAppts.map((a) => (
                                <div
                                  key={`appt-${a.id}`}
                                  className={`px-2 py-1.5 border rounded text-[11px] ${
                                    a.status === 'checked_in'
                                      ? 'bg-emerald-50 border-emerald-200'
                                      : 'bg-teal-50/60 border-teal-200'
                                  }`}
                                >
                                  <div className="flex items-center justify-between gap-1 font-mono text-slate-600">
                                    <span>{a.start_time}–{a.end_time}</span>
                                    <span className="capitalize font-sans font-medium">{a.status.replace('_', ' ')}</span>
                                  </div>
                                  <div className="font-semibold text-slate-900 truncate">
                                    {a.first_name} {a.last_name}
                                  </div>
                                  {a.status === 'scheduled' && canUpdate && (
                                    <button
                                      onClick={() => handleStatusChange(a.id, 'checked_in')}
                                      className="mt-1 text-[10px] font-medium text-teal-800 underline hover:text-teal-950"
                                    >
                                      Check In
                                    </button>
                                  )}
                                </div>
                              ))}

                              {slotBlocks.length === 0 && slotAppts.length === 0 && canCreate && (
                                <button
                                  onClick={() => openPrefilledBooking(doc.id, hour)}
                                  className="w-full h-9 border border-dashed border-slate-200 hover:border-teal-600 hover:bg-teal-50/40 rounded text-[11px] text-slate-400 hover:text-teal-800 transition-colors"
                                >
                                  + Book {hour}
                                </button>
                              )}
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
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
      )}

      {/* Book Appointment Modal */}
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

      {/* Block Clinician Availability Modal */}
      {showBlockModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-lg max-w-md w-full">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3 className="font-display text-base font-semibold text-slate-900">Block Clinician Availability</h3>
              <button onClick={() => setShowBlockModal(false)} className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleCreateBlock} className="p-6 space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Clinician *</label>
                <select
                  required
                  value={blockForm.doctor_id}
                  onChange={(e) => setBlockForm({ ...blockForm, doctor_id: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md bg-white"
                >
                  {doctors.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.full_name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Block Type *</label>
                <select
                  value={blockForm.block_type}
                  onChange={(e) =>
                    setBlockForm({
                      ...blockForm,
                      block_type: e.target.value as 'leave' | 'off_duty' | 'surgery' | 'unavailable',
                    })
                  }
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md bg-white"
                >
                  <option value="off_duty">Off Duty / Ward Rounds</option>
                  <option value="leave">Leave / Annual Time Off</option>
                  <option value="surgery">Theater / Procedure Block</option>
                  <option value="unavailable">Unavailable</option>
                </select>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Date *</label>
                  <input
                    type="date"
                    required
                    value={blockForm.block_date}
                    onChange={(e) => setBlockForm({ ...blockForm, block_date: e.target.value })}
                    className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-md"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Start *</label>
                  <input
                    type="time"
                    required
                    value={blockForm.start_time}
                    onChange={(e) => setBlockForm({ ...blockForm, start_time: e.target.value })}
                    className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-md"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">End *</label>
                  <input
                    type="time"
                    required
                    value={blockForm.end_time}
                    onChange={(e) => setBlockForm({ ...blockForm, end_time: e.target.value })}
                    className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-md"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Reason / Notes</label>
                <input
                  value={blockForm.reason}
                  onChange={(e) => setBlockForm({ ...blockForm, reason: e.target.value })}
                  placeholder="e.g. CME conference, surgical schedule"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md"
                />
              </div>
              <div className="pt-4 border-t border-slate-200 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setShowBlockModal(false)}
                  className="px-4 py-2 text-xs font-medium text-slate-700 border border-slate-300 rounded-md"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 text-xs font-medium text-white bg-amber-700 hover:bg-amber-800 rounded-md"
                >
                  Save Schedule Block
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
