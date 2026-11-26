import React, { useEffect, useState } from 'react';
import { Building2, DoorOpen, Edit3, Plus, Stethoscope, Users, X } from 'lucide-react';
import { apiFetch } from '../../lib/api';
import type {
  ClinicRoomConfig,
  ClinicSettings,
  DepartmentConfig,
  DoctorProfileConfig,
  SpecialtyConfig,
} from '../../types';

type ClinicSubTab = 'clinic_profile' | 'departments' | 'specialties' | 'clinic_rooms' | 'doctors';

interface ClinicConfigPanelProps {
  settings: ClinicSettings;
  departments: DepartmentConfig[];
  specialties: SpecialtyConfig[];
  clinicRooms: ClinicRoomConfig[];
  doctors: DoctorProfileConfig[];
  canManageConfig: boolean;
  onSettingsSaved: (s: ClinicSettings) => void;
  onRefresh: () => void;
  onNotify: (msg: string, type?: 'success' | 'error') => void;
}

export const ClinicConfigPanel: React.FC<ClinicConfigPanelProps> = ({
  settings,
  departments,
  specialties,
  clinicRooms,
  doctors,
  canManageConfig,
  onSettingsSaved,
  onRefresh,
  onNotify,
}) => {
  const [subTab, setSubTab] = useState<ClinicSubTab>('clinic_profile');

  const [profileForm, setProfileForm] = useState({
    clinicName: settings.clinicName || 'Clinic360 Medical Center',
    timezone: settings.timezone || 'UTC',
    legalName: settings.profile?.legalName || 'Clinic360 Healthcare Ltd.',
    facilityCode: settings.profile?.facilityCode || 'C360-MAIN',
    address: settings.profile?.address || '',
    phone: settings.profile?.phone || '',
    email: settings.profile?.email || '',
    operatingHours: settings.profile?.operatingHours || 'Mon-Sat 08:00-20:00',
    taxId: settings.profile?.taxId || '',
  });
  const [savingProfile, setSavingProfile] = useState(false);

  useEffect(() => {
    setProfileForm({
      clinicName: settings.clinicName || 'Clinic360 Medical Center',
      timezone: settings.timezone || 'UTC',
      legalName: settings.profile?.legalName || 'Clinic360 Healthcare Ltd.',
      facilityCode: settings.profile?.facilityCode || 'C360-MAIN',
      address: settings.profile?.address || '',
      phone: settings.profile?.phone || '',
      email: settings.profile?.email || '',
      operatingHours: settings.profile?.operatingHours || 'Mon-Sat 08:00-20:00',
      taxId: settings.profile?.taxId || '',
    });
  }, [settings]);

  // Department Modal
  const [deptModalOpen, setDeptModalOpen] = useState(false);
  const [editingDept, setEditingDept] = useState<DepartmentConfig | null>(null);
  const [deptForm, setDeptForm] = useState({
    code: '',
    name: '',
    category: 'clinical',
    head_name: '',
    description: '',
    active: 1,
  });

  // Specialty Modal
  const [specModalOpen, setSpecModalOpen] = useState(false);
  const [editingSpec, setEditingSpec] = useState<SpecialtyConfig | null>(null);
  const [specForm, setSpecForm] = useState({
    code: '',
    name: '',
    department_id: '',
    consultation_fee: '45',
    description: '',
    active: 1,
  });

  // Clinic Room Modal
  const [roomModalOpen, setRoomModalOpen] = useState(false);
  const [editingRoom, setEditingRoom] = useState<ClinicRoomConfig | null>(null);
  const [roomForm, setRoomForm] = useState({
    room_code: '',
    name: '',
    department_id: '',
    specialty_id: '',
    room_type: 'consultation',
    capacity: '1',
    active: 1,
  });

  async function handleSaveProfile(e: React.FormEvent) {
    e.preventDefault();
    setSavingProfile(true);
    try {
      const res = await apiFetch<{ settings: ClinicSettings }>('/api/admin/settings', {
        method: 'PUT',
        body: JSON.stringify({
          clinicName: profileForm.clinicName,
          timezone: profileForm.timezone,
          profile: {
            legalName: profileForm.legalName,
            facilityCode: profileForm.facilityCode,
            address: profileForm.address,
            phone: profileForm.phone,
            email: profileForm.email,
            operatingHours: profileForm.operatingHours,
            taxId: profileForm.taxId,
          },
        }),
      });
      if (res.settings) onSettingsSaved(res.settings);
      onNotify('Clinic profile updated and audited.', 'success');
    } catch (err) {
      onNotify((err as Error).message, 'error');
    } finally {
      setSavingProfile(false);
    }
  }

  function openDeptModal(d?: DepartmentConfig) {
    if (d) {
      setEditingDept(d);
      setDeptForm({
        code: d.code,
        name: d.name,
        category: d.category || 'clinical',
        head_name: d.head_name || '',
        description: d.description || '',
        active: d.active,
      });
    } else {
      setEditingDept(null);
      setDeptForm({ code: '', name: '', category: 'clinical', head_name: '', description: '', active: 1 });
    }
    setDeptModalOpen(true);
  }

  async function handleSaveDept(e: React.FormEvent) {
    e.preventDefault();
    try {
      if (editingDept) {
        await apiFetch(`/api/admin/departments/${editingDept.id}`, {
          method: 'PUT',
          body: JSON.stringify(deptForm),
        });
        onNotify(`Updated department ${deptForm.name}`, 'success');
      } else {
        await apiFetch('/api/admin/departments', {
          method: 'POST',
          body: JSON.stringify(deptForm),
        });
        onNotify(`Created department ${deptForm.name}`, 'success');
      }
      setDeptModalOpen(false);
      onRefresh();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  function openSpecModal(sp?: SpecialtyConfig) {
    if (sp) {
      setEditingSpec(sp);
      setSpecForm({
        code: sp.code,
        name: sp.name,
        department_id: sp.department_id ? String(sp.department_id) : '',
        consultation_fee: String(sp.consultation_fee ?? 45),
        description: sp.description || '',
        active: sp.active,
      });
    } else {
      setEditingSpec(null);
      setSpecForm({ code: '', name: '', department_id: '', consultation_fee: '45', description: '', active: 1 });
    }
    setSpecModalOpen(true);
  }

  async function handleSaveSpec(e: React.FormEvent) {
    e.preventDefault();
    try {
      const payload = {
        ...specForm,
        department_id: specForm.department_id ? Number(specForm.department_id) : null,
        consultation_fee: Number(specForm.consultation_fee || 0),
      };
      if (editingSpec) {
        await apiFetch(`/api/admin/specialties/${editingSpec.id}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
        onNotify(`Updated specialty ${specForm.name}`, 'success');
      } else {
        await apiFetch('/api/admin/specialties', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        onNotify(`Created specialty ${specForm.name}`, 'success');
      }
      setSpecModalOpen(false);
      onRefresh();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  function openRoomModal(rm?: ClinicRoomConfig) {
    if (rm) {
      setEditingRoom(rm);
      setRoomForm({
        room_code: rm.room_code,
        name: rm.name,
        department_id: rm.department_id ? String(rm.department_id) : '',
        specialty_id: rm.specialty_id ? String(rm.specialty_id) : '',
        room_type: rm.room_type || 'consultation',
        capacity: String(rm.capacity || 1),
        active: rm.active,
      });
    } else {
      setEditingRoom(null);
      setRoomForm({
        room_code: '',
        name: '',
        department_id: '',
        specialty_id: '',
        room_type: 'consultation',
        capacity: '1',
        active: 1,
      });
    }
    setRoomModalOpen(true);
  }

  async function handleSaveRoom(e: React.FormEvent) {
    e.preventDefault();
    try {
      const payload = {
        ...roomForm,
        department_id: roomForm.department_id ? Number(roomForm.department_id) : null,
        specialty_id: roomForm.specialty_id ? Number(roomForm.specialty_id) : null,
        capacity: Math.max(1, Number(roomForm.capacity || 1)),
      };
      if (editingRoom) {
        await apiFetch(`/api/admin/clinic-rooms/${editingRoom.id}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
        onNotify(`Updated room ${roomForm.name}`, 'success');
      } else {
        await apiFetch('/api/admin/clinic-rooms', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        onNotify(`Created room ${roomForm.name}`, 'success');
      }
      setRoomModalOpen(false);
      onRefresh();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  return (
    <div className="space-y-4">
      {/* Sub-navigation */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">
          {(
            [
              ['clinic_profile', 'Clinic Profile', Building2],
              ['departments', `Departments (${departments.length})`, Building2],
              ['specialties', `Specialties (${specialties.length})`, Stethoscope],
              ['clinic_rooms', `Rooms & Units (${clinicRooms.length})`, DoorOpen],
              ['doctors', `Doctor Profiles (${doctors.length})`, Users],
            ] as Array<[ClinicSubTab, string, React.ComponentType<{ className?: string }>]>
          ).map(([key, label, Icon]) => (
            <button
              key={key}
              type="button"
              onClick={() => setSubTab(key)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border ${
                subTab === key
                  ? 'bg-teal-700 text-white border-teal-700'
                  : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              <span>{label}</span>
            </button>
          ))}
        </div>

        {canManageConfig && subTab === 'departments' && (
          <button
            type="button"
            onClick={() => openDeptModal()}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add Department</span>
          </button>
        )}
        {canManageConfig && subTab === 'specialties' && (
          <button
            type="button"
            onClick={() => openSpecModal()}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add Specialty</span>
          </button>
        )}
        {canManageConfig && subTab === 'clinic_rooms' && (
          <button
            type="button"
            onClick={() => openRoomModal()}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add Clinic Room</span>
          </button>
        )}
      </div>

      {/* Clinic Profile */}
      {subTab === 'clinic_profile' && (
        <div className="bg-white border border-slate-200 rounded-lg max-w-3xl">
          <div className="px-6 py-4 border-b border-slate-200">
            <h3 className="font-display text-sm font-semibold text-slate-900">Facility Identity &amp; Profile</h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Displayed across clinical headers, patient receipts, prescriptions, and audit exports.
            </p>
          </div>
          <form onSubmit={handleSaveProfile} className="p-6 space-y-4 text-xs">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block font-medium text-slate-700 mb-1">Facility Display Name *</label>
                <input
                  required
                  disabled={!canManageConfig}
                  value={profileForm.clinicName}
                  onChange={(e) => setProfileForm({ ...profileForm, clinicName: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-300 rounded-md disabled:bg-slate-50"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Legal Entity Name</label>
                <input
                  disabled={!canManageConfig}
                  value={profileForm.legalName}
                  onChange={(e) => setProfileForm({ ...profileForm, legalName: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-300 rounded-md disabled:bg-slate-50"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Facility Code</label>
                <input
                  disabled={!canManageConfig}
                  value={profileForm.facilityCode}
                  onChange={(e) => setProfileForm({ ...profileForm, facilityCode: e.target.value.toUpperCase() })}
                  className="w-full px-3 py-2 font-mono border border-slate-300 rounded-md disabled:bg-slate-50"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Tax / Registration ID</label>
                <input
                  disabled={!canManageConfig}
                  value={profileForm.taxId}
                  onChange={(e) => setProfileForm({ ...profileForm, taxId: e.target.value })}
                  className="w-full px-3 py-2 font-mono border border-slate-300 rounded-md disabled:bg-slate-50"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Contact Phone</label>
                <input
                  disabled={!canManageConfig}
                  value={profileForm.phone}
                  onChange={(e) => setProfileForm({ ...profileForm, phone: e.target.value })}
                  className="w-full px-3 py-2 font-mono border border-slate-300 rounded-md disabled:bg-slate-50"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Official Email</label>
                <input
                  type="email"
                  disabled={!canManageConfig}
                  value={profileForm.email}
                  onChange={(e) => setProfileForm({ ...profileForm, email: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-300 rounded-md disabled:bg-slate-50"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Operating Hours</label>
                <input
                  disabled={!canManageConfig}
                  value={profileForm.operatingHours}
                  onChange={(e) => setProfileForm({ ...profileForm, operatingHours: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-300 rounded-md disabled:bg-slate-50"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">IANA Timezone *</label>
                <input
                  required
                  disabled={!canManageConfig}
                  value={profileForm.timezone}
                  onChange={(e) => setProfileForm({ ...profileForm, timezone: e.target.value })}
                  className="w-full px-3 py-2 font-mono border border-slate-300 rounded-md disabled:bg-slate-50"
                />
              </div>
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">Physical Address</label>
              <input
                disabled={!canManageConfig}
                value={profileForm.address}
                onChange={(e) => setProfileForm({ ...profileForm, address: e.target.value })}
                className="w-full px-3 py-2 border border-slate-300 rounded-md disabled:bg-slate-50"
              />
            </div>
            {canManageConfig && (
              <div className="pt-3 border-t border-slate-200 flex justify-end">
                <button
                  type="submit"
                  disabled={savingProfile}
                  className="px-4 py-2 font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md disabled:opacity-50"
                >
                  {savingProfile ? 'Saving...' : 'Save Clinic Profile'}
                </button>
              </div>
            )}
          </form>
        </div>
      )}

      {/* Departments */}
      {subTab === 'departments' && (
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/70 font-medium text-slate-500">
                  <th className="py-2.5 px-4">Code</th>
                  <th className="py-2.5 px-4">Department</th>
                  <th className="py-2.5 px-4">Category</th>
                  <th className="py-2.5 px-4">Department Head</th>
                  <th className="py-2.5 px-4 text-right">Scoped Staff</th>
                  <th className="py-2.5 px-4 text-right">Active Rooms</th>
                  <th className="py-2.5 px-4">Status</th>
                  {canManageConfig && <th className="py-2.5 px-4 text-right">Edit</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {departments.map((d) => (
                  <tr key={d.id} className="hover:bg-slate-50/70">
                    <td className="py-2.5 px-4 font-mono font-semibold text-teal-800">{d.code}</td>
                    <td className="py-2.5 px-4">
                      <div className="font-medium text-slate-900">{d.name}</div>
                      {d.description && <div className="text-[11px] text-slate-500">{d.description}</div>}
                    </td>
                    <td className="py-2.5 px-4 font-mono uppercase text-slate-600">{d.category}</td>
                    <td className="py-2.5 px-4 text-slate-700">{d.head_name || '—'}</td>
                    <td className="py-2.5 px-4 text-right font-mono tabular-nums">{d.assigned_staff_count ?? 0}</td>
                    <td className="py-2.5 px-4 text-right font-mono tabular-nums">{d.active_room_count ?? 0}</td>
                    <td className="py-2.5 px-4">
                      <span className={d.active ? 'text-emerald-700 font-medium' : 'text-red-700'}>
                        {d.active ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    {canManageConfig && (
                      <td className="py-2.5 px-4 text-right">
                        <button
                          type="button"
                          onClick={() => openDeptModal(d)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-slate-700 border border-slate-200 hover:bg-slate-50 rounded"
                        >
                          <Edit3 className="w-3 h-3" />
                          <span>Edit</span>
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Specialties */}
      {subTab === 'specialties' && (
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/70 font-medium text-slate-500">
                  <th className="py-2.5 px-4">Code</th>
                  <th className="py-2.5 px-4">Medical Specialty</th>
                  <th className="py-2.5 px-4">Parent Department</th>
                  <th className="py-2.5 px-4 text-right">Default Consult Fee</th>
                  <th className="py-2.5 px-4">Status</th>
                  {canManageConfig && <th className="py-2.5 px-4 text-right">Edit</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {specialties.map((sp) => (
                  <tr key={sp.id} className="hover:bg-slate-50/70">
                    <td className="py-2.5 px-4 font-mono font-semibold text-teal-800">{sp.code}</td>
                    <td className="py-2.5 px-4">
                      <div className="font-medium text-slate-900">{sp.name}</div>
                      {sp.description && <div className="text-[11px] text-slate-500">{sp.description}</div>}
                    </td>
                    <td className="py-2.5 px-4 text-slate-700">{sp.department_name || 'Unassigned'}</td>
                    <td className="py-2.5 px-4 text-right font-mono tabular-nums">
                      {settings.currencySymbol || '$'}
                      {Number(sp.consultation_fee || 0).toFixed(2)}
                    </td>
                    <td className="py-2.5 px-4">
                      <span className={sp.active ? 'text-emerald-700 font-medium' : 'text-red-700'}>
                        {sp.active ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    {canManageConfig && (
                      <td className="py-2.5 px-4 text-right">
                        <button
                          type="button"
                          onClick={() => openSpecModal(sp)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-slate-700 border border-slate-200 hover:bg-slate-50 rounded"
                        >
                          <Edit3 className="w-3 h-3" />
                          <span>Edit</span>
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Clinic Rooms & Units */}
      {subTab === 'clinic_rooms' && (
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/70 font-medium text-slate-500">
                  <th className="py-2.5 px-4">Room Code</th>
                  <th className="py-2.5 px-4">Room / Unit Name</th>
                  <th className="py-2.5 px-4">Department</th>
                  <th className="py-2.5 px-4">Specialty</th>
                  <th className="py-2.5 px-4">Type</th>
                  <th className="py-2.5 px-4 text-right">Capacity</th>
                  <th className="py-2.5 px-4">Status</th>
                  {canManageConfig && <th className="py-2.5 px-4 text-right">Edit</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {clinicRooms.map((rm) => (
                  <tr key={rm.id} className="hover:bg-slate-50/70">
                    <td className="py-2.5 px-4 font-mono font-semibold text-teal-800">{rm.room_code}</td>
                    <td className="py-2.5 px-4 font-medium text-slate-900">{rm.name}</td>
                    <td className="py-2.5 px-4 text-slate-700">{rm.department_name || '—'}</td>
                    <td className="py-2.5 px-4 text-slate-600">{rm.specialty_name || 'General'}</td>
                    <td className="py-2.5 px-4 font-mono uppercase text-slate-600">{rm.room_type}</td>
                    <td className="py-2.5 px-4 text-right font-mono tabular-nums">{rm.capacity}</td>
                    <td className="py-2.5 px-4">
                      <span className={rm.active ? 'text-emerald-700 font-medium' : 'text-red-700'}>
                        {rm.active ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    {canManageConfig && (
                      <td className="py-2.5 px-4 text-right">
                        <button
                          type="button"
                          onClick={() => openRoomModal(rm)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-slate-700 border border-slate-200 hover:bg-slate-50 rounded"
                        >
                          <Edit3 className="w-3 h-3" />
                          <span>Edit</span>
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Doctor Profiles */}
      {subTab === 'doctors' && (
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-5 py-3 border-b border-slate-200 bg-slate-50/70 flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="font-semibold text-slate-900">
              OPD Physician Directory &amp; Room Assignments
            </span>
            <span className="text-slate-500">
              HR licence numbers and user room scopes sync automatically. Manage user access in Staff Users.
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/70 font-medium text-slate-500">
                  <th className="py-2.5 px-4">HR ID</th>
                  <th className="py-2.5 px-4">Physician</th>
                  <th className="py-2.5 px-4">Specialty / Dept</th>
                  <th className="py-2.5 px-4">Medical Licence</th>
                  <th className="py-2.5 px-4">Assigned Rooms</th>
                  <th className="py-2.5 px-4 text-right">Active Queue</th>
                  <th className="py-2.5 px-4">Account</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {doctors.map((doc) => (
                  <tr key={doc.id} className="hover:bg-slate-50/70">
                    <td className="py-2.5 px-4 font-mono text-slate-700">{doc.employee_number || '—'}</td>
                    <td className="py-2.5 px-4">
                      <div className="font-medium text-slate-900">{doc.full_name}</div>
                      <div className="text-[11px] font-mono text-slate-500">{doc.email}</div>
                    </td>
                    <td className="py-2.5 px-4 text-slate-700">
                      {doc.specialty || 'General OPD'}
                      {doc.hr_department_name && <span className="text-slate-400"> · {doc.hr_department_name}</span>}
                    </td>
                    <td className="py-2.5 px-4 font-mono text-slate-700">
                      {doc.licence_number || 'Unrecorded'}
                      {doc.licence_expiry && <div className="text-[11px] text-slate-500">Exp: {doc.licence_expiry}</div>}
                    </td>
                    <td className="py-2.5 px-4 text-slate-700">{doc.assigned_rooms || 'Unassigned'}</td>
                    <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-900">
                      {doc.active_visits_count}
                    </td>
                    <td className="py-2.5 px-4">
                      <span className={doc.active && doc.status === 'active' ? 'text-emerald-700 font-medium' : 'text-red-700'}>
                        {doc.active && doc.status === 'active' ? 'Active' : doc.status || 'Inactive'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Department Modal */}
      {deptModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-lg max-w-md w-full">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3 className="font-display text-base font-semibold text-slate-900">
                {editingDept ? `Edit Department · ${editingDept.code}` : 'New Clinic Department'}
              </h3>
              <button type="button" onClick={() => setDeptModalOpen(false)} className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleSaveDept} className="p-6 space-y-3 text-xs">
              {!editingDept && (
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Department Code *</label>
                  <input
                    required
                    value={deptForm.code}
                    onChange={(e) => setDeptForm({ ...deptForm, code: e.target.value.toUpperCase() })}
                    placeholder="e.g. CARD"
                    className="w-full px-3 py-2 font-mono border border-slate-300 rounded-md"
                  />
                </div>
              )}
              <div>
                <label className="block font-medium text-slate-700 mb-1">Department Name *</label>
                <input
                  required
                  value={deptForm.name}
                  onChange={(e) => setDeptForm({ ...deptForm, name: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-300 rounded-md"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Category</label>
                  <select
                    value={deptForm.category}
                    onChange={(e) => setDeptForm({ ...deptForm, category: e.target.value })}
                    className="w-full px-3 py-2 border border-slate-300 rounded-md bg-white"
                  >
                    <option value="clinical">Clinical</option>
                    <option value="diagnostics">Diagnostics</option>
                    <option value="pharmacy">Pharmacy</option>
                    <option value="finance">Finance</option>
                    <option value="administration">Administration</option>
                  </select>
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Department Head</label>
                  <input
                    value={deptForm.head_name}
                    onChange={(e) => setDeptForm({ ...deptForm, head_name: e.target.value })}
                    className="w-full px-3 py-2 border border-slate-300 rounded-md"
                  />
                </div>
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Description</label>
                <input
                  value={deptForm.description}
                  onChange={(e) => setDeptForm({ ...deptForm, description: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-300 rounded-md"
                />
              </div>
              {editingDept && (
                <label className="flex items-center gap-2 cursor-pointer pt-1">
                  <input
                    type="checkbox"
                    checked={Boolean(deptForm.active)}
                    onChange={(e) => setDeptForm({ ...deptForm, active: e.target.checked ? 1 : 0 })}
                  />
                  <span>Department Active</span>
                </label>
              )}
              <div className="pt-3 border-t border-slate-200 flex justify-end gap-2">
                <button type="button" onClick={() => setDeptModalOpen(false)} className="px-4 py-2 border border-slate-300 rounded-md">
                  Cancel
                </button>
                <button type="submit" className="px-4 py-2 font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md">
                  {editingDept ? 'Save Changes' : 'Create Department'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Specialty Modal */}
      {specModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-lg max-w-md w-full">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3 className="font-display text-base font-semibold text-slate-900">
                {editingSpec ? `Edit Specialty · ${editingSpec.code}` : 'New Medical Specialty'}
              </h3>
              <button type="button" onClick={() => setSpecModalOpen(false)} className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleSaveSpec} className="p-6 space-y-3 text-xs">
              {!editingSpec && (
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Specialty Code *</label>
                  <input
                    required
                    value={specForm.code}
                    onChange={(e) => setSpecForm({ ...specForm, code: e.target.value.toUpperCase() })}
                    placeholder="e.g. PEDS"
                    className="w-full px-3 py-2 font-mono border border-slate-300 rounded-md"
                  />
                </div>
              )}
              <div>
                <label className="block font-medium text-slate-700 mb-1">Specialty Name *</label>
                <input
                  required
                  value={specForm.name}
                  onChange={(e) => setSpecForm({ ...specForm, name: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-300 rounded-md"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Department</label>
                  <select
                    value={specForm.department_id}
                    onChange={(e) => setSpecForm({ ...specForm, department_id: e.target.value })}
                    className="w-full px-3 py-2 border border-slate-300 rounded-md bg-white"
                  >
                    <option value="">Unassigned</option>
                    {departments.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Default Consultation Fee</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    required
                    value={specForm.consultation_fee}
                    onChange={(e) => setSpecForm({ ...specForm, consultation_fee: e.target.value })}
                    className="w-full px-3 py-2 font-mono border border-slate-300 rounded-md"
                  />
                </div>
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Description</label>
                <input
                  value={specForm.description}
                  onChange={(e) => setSpecForm({ ...specForm, description: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-300 rounded-md"
                />
              </div>
              {editingSpec && (
                <label className="flex items-center gap-2 cursor-pointer pt-1">
                  <input
                    type="checkbox"
                    checked={Boolean(specForm.active)}
                    onChange={(e) => setSpecForm({ ...specForm, active: e.target.checked ? 1 : 0 })}
                  />
                  <span>Specialty Active</span>
                </label>
              )}
              <div className="pt-3 border-t border-slate-200 flex justify-end gap-2">
                <button type="button" onClick={() => setSpecModalOpen(false)} className="px-4 py-2 border border-slate-300 rounded-md">
                  Cancel
                </button>
                <button type="submit" className="px-4 py-2 font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md">
                  {editingSpec ? 'Save Changes' : 'Create Specialty'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Clinic Room Modal */}
      {roomModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-lg max-w-md w-full">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3 className="font-display text-base font-semibold text-slate-900">
                {editingRoom ? `Edit Clinic Room · ${editingRoom.room_code}` : 'New Clinic Room / Unit'}
              </h3>
              <button type="button" onClick={() => setRoomModalOpen(false)} className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleSaveRoom} className="p-6 space-y-3 text-xs">
              {!editingRoom && (
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Room Code *</label>
                  <input
                    required
                    value={roomForm.room_code}
                    onChange={(e) => setRoomForm({ ...roomForm, room_code: e.target.value.toUpperCase() })}
                    placeholder="e.g. OPD-04"
                    className="w-full px-3 py-2 font-mono border border-slate-300 rounded-md"
                  />
                </div>
              )}
              <div>
                <label className="block font-medium text-slate-700 mb-1">Room / Unit Name *</label>
                <input
                  required
                  value={roomForm.name}
                  onChange={(e) => setRoomForm({ ...roomForm, name: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-300 rounded-md"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Department</label>
                  <select
                    value={roomForm.department_id}
                    onChange={(e) => setRoomForm({ ...roomForm, department_id: e.target.value })}
                    className="w-full px-3 py-2 border border-slate-300 rounded-md bg-white"
                  >
                    <option value="">Unassigned</option>
                    {departments.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Specialty</label>
                  <select
                    value={roomForm.specialty_id}
                    onChange={(e) => setRoomForm({ ...roomForm, specialty_id: e.target.value })}
                    className="w-full px-3 py-2 border border-slate-300 rounded-md bg-white"
                  >
                    <option value="">General</option>
                    {specialties.map((sp) => (
                      <option key={sp.id} value={sp.id}>
                        {sp.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Room Type</label>
                  <select
                    value={roomForm.room_type}
                    onChange={(e) => setRoomForm({ ...roomForm, room_type: e.target.value })}
                    className="w-full px-3 py-2 border border-slate-300 rounded-md bg-white"
                  >
                    <option value="consultation">Consultation</option>
                    <option value="triage">Triage</option>
                    <option value="procedure">Procedure</option>
                    <option value="laboratory">Laboratory</option>
                    <option value="imaging">Imaging</option>
                    <option value="pharmacy">Pharmacy</option>
                  </select>
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Capacity</label>
                  <input
                    type="number"
                    min="1"
                    required
                    value={roomForm.capacity}
                    onChange={(e) => setRoomForm({ ...roomForm, capacity: e.target.value })}
                    className="w-full px-3 py-2 font-mono border border-slate-300 rounded-md"
                  />
                </div>
              </div>
              {editingRoom && (
                <label className="flex items-center gap-2 cursor-pointer pt-1">
                  <input
                    type="checkbox"
                    checked={Boolean(roomForm.active)}
                    onChange={(e) => setRoomForm({ ...roomForm, active: e.target.checked ? 1 : 0 })}
                  />
                  <span>Room Active</span>
                </label>
              )}
              <div className="pt-3 border-t border-slate-200 flex justify-end gap-2">
                <button type="button" onClick={() => setRoomModalOpen(false)} className="px-4 py-2 border border-slate-300 rounded-md">
                  Cancel
                </button>
                <button type="submit" className="px-4 py-2 font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md">
                  {editingRoom ? 'Save Changes' : 'Create Room'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
