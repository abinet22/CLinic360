import React, { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  CheckCircle2,
  Edit3,
  Eye,
  KeyRound,
  Lock,
  Power,
  Search,
  Shield,
  Trash2,
  Unlock,
  UserPlus,
  X,
} from 'lucide-react';
import { apiFetch } from '../../lib/api';
import type {
  AuditLog,
  ClinicRoomConfig,
  DepartmentConfig,
  HrEmployeeAdminOption,
  StaffUserRow,
  UserContext,
  UserSessionRow,
} from '../../types';

interface RoleOption {
  id: number;
  code: string;
  name: string;
  description: string;
}

interface UserManagementPanelProps {
  currentUser: UserContext;
  users: StaffUserRow[];
  roles: RoleOption[];
  departments: DepartmentConfig[];
  clinicRooms: ClinicRoomConfig[];
  canManageUsers: boolean;
  onRefresh: () => void;
  onNotify: (msg: string, type?: 'success' | 'error') => void;
}

export const UserManagementPanel: React.FC<UserManagementPanelProps> = ({
  currentUser,
  users,
  roles,
  departments,
  clinicRooms,
  canManageUsers,
  onRefresh,
  onNotify,
}) => {
  const [userSearch, setUserSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive' | 'locked'>('all');

  const [hrEmployees, setHrEmployees] = useState<HrEmployeeAdminOption[]>([]);
  const [hrSearch, setHrSearch] = useState('');
  const [hrAccountFilter, setHrAccountFilter] = useState<'available' | 'all' | 'provisioned'>('available');

  // Create User from HR Modal
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [selectedEmp, setSelectedEmp] = useState<HrEmployeeAdminOption | null>(null);
  const [createForm, setCreateForm] = useState({
    username: '',
    email: '',
    password: '',
    generate_temp_password: true,
    role_codes: [] as string[],
    department_ids: [] as number[],
    clinic_unit_ids: [] as number[],
    specialty: '',
    two_fa_enabled: false,
    exception_approved: false,
  });

  // One-time credential display modal
  const [issuedCreds, setIssuedCreds] = useState<{ title: string; username: string; email: string; tempPassword: string } | null>(null);

  // View Details Modal
  const [viewTarget, setViewTarget] = useState<StaffUserRow | null>(null);

  // Edit User Profile / Scope Modal
  const [editTarget, setEditTarget] = useState<StaffUserRow | null>(null);
  const [editForm, setEditForm] = useState({
    username: '',
    email: '',
    specialty: '',
    two_fa_enabled: false,
    department_ids: [] as number[],
    clinic_unit_ids: [] as number[],
  });

  // Edit Roles Modal
  const [rolesTarget, setRolesTarget] = useState<StaffUserRow | null>(null);
  const [editRoleCodes, setEditRoleCodes] = useState<string[]>([]);

  // Sessions Modal
  const [sessionsTarget, setSessionsTarget] = useState<StaffUserRow | null>(null);
  const [sessions, setSessions] = useState<UserSessionRow[]>([]);

  // Activity Modal
  const [activityTarget, setActivityTarget] = useState<StaffUserRow | null>(null);
  const [activityLogs, setActivityLogs] = useState<AuditLog[]>([]);

  const loadHrEmployees = useCallback(async () => {
    try {
      const qs = new URLSearchParams();
      if (hrSearch.trim()) qs.set('search', hrSearch.trim());
      qs.set('account_filter', 'all');
      const res = await apiFetch<{ employees: HrEmployeeAdminOption[] }>(`/api/admin/hr-employees?${qs.toString()}`);
      setHrEmployees(res.employees || []);
    } catch {
      // ignore if user lacks permission
    }
  }, [hrSearch]);

  useEffect(() => {
    loadHrEmployees();
  }, [loadHrEmployees, users.length]);

  const reviewRequiredEmployees = hrEmployees.filter((e) => Number(e.access_review_required) === 1);

  const filteredUsers = users.filter((u) => {
    if (statusFilter !== 'all' && u.status !== statusFilter) return false;
    if (!userSearch.trim()) return true;
    const q = userSearch.trim().toLowerCase();
    return (
      u.full_name.toLowerCase().includes(q) ||
      u.email.toLowerCase().includes(q) ||
      (u.username || '').toLowerCase().includes(q) ||
      (u.employee_number || '').toLowerCase().includes(q) ||
      (u.hr_department_name || u.department_names || '').toLowerCase().includes(q) ||
      (u.hr_job_position || '').toLowerCase().includes(q) ||
      u.role_code.toLowerCase().includes(q)
    );
  });

  const modalHrList = hrEmployees.filter((e) => {
    if (hrAccountFilter === 'available') return !e.has_system_account && e.status === 'active';
    if (hrAccountFilter === 'provisioned') return e.has_system_account;
    return true;
  });

  function selectEmployeeForAccount(emp: HrEmployeeAdminOption) {
    setSelectedEmp(emp);
    const baseEmail = (emp.email || `${emp.full_name.toLowerCase().replace(/[^a-z0-9]+/g, '.')}@clinic360.local`).toLowerCase();
    const baseUser = baseEmail.split('@')[0].replace(/[^a-z0-9._-]/g, '');
    const matchedDept = departments.find((d) => d.name.toLowerCase() === emp.department_name.toLowerCase());
    setCreateForm({
      username: emp.has_system_account ? `${baseUser}2` : baseUser,
      email: emp.has_system_account ? `${baseUser}2@${baseEmail.split('@')[1] || 'clinic360.local'}` : baseEmail,
      password: '',
      generate_temp_password: true,
      role_codes: [],
      department_ids: matchedDept ? [matchedDept.id] : [],
      clinic_unit_ids: [],
      specialty: emp.job_position || '',
      two_fa_enabled: false,
      exception_approved: false,
    });
  }

  async function handleCreateUser(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedEmp) {
      onNotify('Select an employee from the HR register first.', 'error');
      return;
    }
    if (createForm.role_codes.length === 0) {
      onNotify('Explicitly assign at least one system role.', 'error');
      return;
    }
    try {
      const res = await apiFetch<{ id: number; username: string; email: string; tempPassword?: string }>('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({
          employee_id: selectedEmp.id,
          username: createForm.username,
          email: createForm.email,
          password: createForm.generate_temp_password ? undefined : createForm.password,
          generate_temp_password: createForm.generate_temp_password,
          role_codes: createForm.role_codes,
          department_ids: createForm.department_ids,
          clinic_unit_ids: createForm.clinic_unit_ids,
          specialty: createForm.specialty || selectedEmp.job_position,
          two_fa_enabled: createForm.two_fa_enabled,
          exception_approved: createForm.exception_approved,
        }),
      });
      setShowCreateModal(false);
      setSelectedEmp(null);
      if (res.tempPassword) {
        setIssuedCreds({
          title: 'System Account Activated',
          username: res.username,
          email: res.email,
          tempPassword: res.tempPassword,
        });
      }
      onNotify(`System access provisioned for ${selectedEmp.full_name} (${res.username})`, 'success');
      onRefresh();
      loadHrEmployees();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  function openEditUser(u: StaffUserRow) {
    setEditTarget(u);
    setEditForm({
      username: u.username || u.email.split('@')[0],
      email: u.email,
      specialty: u.specialty || '',
      two_fa_enabled: Boolean(u.two_fa_enabled),
      department_ids: u.department_ids || [],
      clinic_unit_ids: u.clinic_unit_ids || [],
    });
  }

  async function handleSaveEditUser(e: React.FormEvent) {
    e.preventDefault();
    if (!editTarget) return;
    try {
      await apiFetch(`/api/admin/users/${editTarget.id}`, {
        method: 'PUT',
        body: JSON.stringify(editForm),
      });
      onNotify(`Updated account configuration for ${editTarget.full_name}`, 'success');
      setEditTarget(null);
      onRefresh();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleStatusAction(
    u: StaffUserRow,
    action: 'activate' | 'deactivate' | 'lock' | 'unlock' | 'reset_password' | 'revoke_sessions'
  ) {
    try {
      const res = await apiFetch<{ ok: boolean; revokedSessions: number; tempPassword?: string }>(
        `/api/admin/users/${u.id}/status`,
        {
          method: 'PATCH',
          body: JSON.stringify({ action }),
        }
      );
      if (action === 'reset_password' && res.tempPassword) {
        setIssuedCreds({
          title: `Temporary Password Reset · ${u.full_name}`,
          username: u.username || u.email,
          email: u.email,
          tempPassword: res.tempPassword,
        });
      } else {
        const labelMap: Record<string, string> = {
          activate: 'Account activated',
          deactivate: `Account deactivated (${res.revokedSessions} session(s) revoked)`,
          lock: `Account locked (${res.revokedSessions} session(s) revoked)`,
          unlock: 'Account unlocked',
          revoke_sessions: `Revoked ${res.revokedSessions} active session(s)`,
        };
        onNotify(`${u.full_name}: ${labelMap[action] || 'Updated'}`, 'success');
      }
      onRefresh();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function openSessions(u: StaffUserRow) {
    setSessionsTarget(u);
    try {
      const res = await apiFetch<{ sessions: UserSessionRow[] }>(`/api/admin/users/${u.id}/sessions`);
      setSessions(res.sessions || []);
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleRevokeSession(userId: number, jti: string) {
    try {
      await apiFetch(`/api/admin/users/${userId}/sessions/${jti}`, { method: 'DELETE' });
      onNotify('Session revoked immediately.', 'success');
      const res = await apiFetch<{ sessions: UserSessionRow[] }>(`/api/admin/users/${userId}/sessions`);
      setSessions(res.sessions || []);
      onRefresh();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function openActivity(u: StaffUserRow) {
    setActivityTarget(u);
    try {
      const res = await apiFetch<{ logs: AuditLog[] }>(`/api/admin/users/${u.id}/activity`);
      setActivityLogs(res.logs || []);
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleCompleteAccessReview(emp: HrEmployeeAdminOption) {
    try {
      await apiFetch(`/api/admin/hr-employees/${emp.id}/complete-access-review`, {
        method: 'POST',
        body: JSON.stringify({ note: 'Administrator verified offboarding access closure' }),
      });
      onNotify(`Completed access review for ${emp.employee_number} (${emp.full_name})`, 'success');
      loadHrEmployees();
      onRefresh();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleSaveRoles(e: React.FormEvent) {
    e.preventDefault();
    if (!rolesTarget) return;
    try {
      await apiFetch(`/api/admin/users/${rolesTarget.id}/roles`, {
        method: 'PUT',
        body: JSON.stringify({ role_codes: editRoleCodes }),
      });
      onNotify(`Updated roles for ${rolesTarget.full_name}`, 'success');
      setRolesTarget(null);
      onRefresh();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  return (
    <div className="space-y-5">
      {/* Offboarding Access Review Alert Section */}
      {reviewRequiredEmployees.length > 0 && canManageUsers && (
        <div className="bg-amber-50/70 border border-amber-200 rounded-lg overflow-hidden">
          <div className="px-5 py-3 border-b border-amber-200 flex items-center justify-between">
            <div>
              <div className="text-xs font-semibold text-amber-900">
                Offboarding Access Review Required ({reviewRequiredEmployees.length})
              </div>
              <div className="text-xs text-amber-800">
                HR deactivated or terminated the following staff members. Active login sessions were revoked automatically; confirm system access closure below.
              </div>
            </div>
          </div>
          <div className="divide-y divide-amber-200/70 text-xs">
            {reviewRequiredEmployees.map((emp) => (
              <div key={emp.id} className="px-5 py-2.5 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <span className="font-mono font-semibold text-slate-900">{emp.employee_number}</span>
                  <span className="mx-1.5 text-slate-400">·</span>
                  <span className="font-medium text-slate-900">{emp.full_name}</span>
                  <span className="mx-1.5 text-slate-400">·</span>
                  <span className="text-slate-700">{emp.department_name} ({emp.job_position})</span>
                  <span className="mx-1.5 text-slate-400">·</span>
                  <span className="font-mono uppercase text-red-700">HR: {emp.status}</span>
                  {emp.linked_username && (
                    <>
                      <span className="mx-1.5 text-slate-400">·</span>
                      <span className="font-mono text-slate-700">Account: {emp.linked_username} ({emp.linked_status})</span>
                    </>
                  )}
                </div>
                <button
                  onClick={() => handleCompleteAccessReview(emp)}
                  className="inline-flex items-center gap-1 px-3 py-1.5 font-medium text-amber-900 bg-white border border-amber-300 hover:bg-amber-100 rounded"
                >
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>Confirm Access Review</span>
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* User Directory Toolbar */}
      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div className="p-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2 flex-1">
            <div className="relative flex-1 min-w-[220px] max-w-sm">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                value={userSearch}
                onChange={(e) => setUserSearch(e.target.value)}
                placeholder="Search Employee ID, name, username, dept, role..."
                className="w-full pl-9 pr-3 py-1.5 text-xs border border-slate-300 rounded-md"
              />
            </div>
            <div className="flex items-center border border-slate-200 rounded-md overflow-hidden text-xs">
              {(['all', 'active', 'inactive', 'locked'] as const).map((st) => (
                <button
                  key={st}
                  onClick={() => setStatusFilter(st)}
                  className={`px-3 py-1.5 capitalize ${
                    statusFilter === st ? 'bg-slate-900 text-white font-medium' : 'bg-white text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  {st}
                </button>
              ))}
            </div>
          </div>

          {canManageUsers && (
            <button
              onClick={() => {
                setSelectedEmp(null);
                setShowCreateModal(true);
              }}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md whitespace-nowrap"
            >
              <UserPlus className="w-3.5 h-3.5" />
              <span>Create User from HR Register</span>
            </button>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium text-slate-500">
                <th className="py-2.5 px-3">Employee ID</th>
                <th className="py-2.5 px-3">Employee Name</th>
                <th className="py-2.5 px-3">Department</th>
                <th className="py-2.5 px-3">Designation</th>
                <th className="py-2.5 px-3">Username</th>
                <th className="py-2.5 px-3">System Role</th>
                <th className="py-2.5 px-3">Account Status</th>
                <th className="py-2.5 px-3">Last Login</th>
                <th className="py-2.5 px-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-xs">
              {filteredUsers.map((u) => {
                const isLocked = u.status === 'locked' || Boolean(u.locked_until) || Number(u.failed_attempts || 0) >= 5;
                const statusLabel = !u.active || u.status === 'inactive' ? 'Inactive' : isLocked ? 'Locked' : 'Active';
                const statusClass =
                  statusLabel === 'Active'
                    ? 'text-emerald-700 font-medium'
                    : statusLabel === 'Locked'
                      ? 'text-amber-700 font-semibold'
                      : 'text-red-700 font-medium';
                return (
                  <tr key={u.id} className="hover:bg-slate-50/70">
                    <td className="py-2.5 px-3 font-mono font-semibold text-slate-800 whitespace-nowrap">
                      {u.employee_number || (u.exception_approved ? 'EXCEPTION' : '—')}
                    </td>
                    <td className="py-2.5 px-3">
                      <div className="font-medium text-slate-900">{u.full_name}</div>
                      <div className="text-[11px] font-mono text-slate-500">{u.email}</div>
                    </td>
                    <td className="py-2.5 px-3 text-slate-700">
                      {u.hr_department_name || u.department_names || 'Unassigned'}
                    </td>
                    <td className="py-2.5 px-3 text-slate-600">{u.hr_job_position || u.specialty || 'Staff'}</td>
                    <td className="py-2.5 px-3 font-mono text-slate-800">{u.username || u.email.split('@')[0]}</td>
                    <td className="py-2.5 px-3">
                      <span className="font-mono font-semibold text-teal-800">{u.role_code}</span>
                      <div className="text-[11px] text-slate-500 truncate max-w-[140px]">{u.role_name}</div>
                    </td>
                    <td className="py-2.5 px-3 whitespace-nowrap">
                      <div className={statusClass}>{statusLabel}</div>
                      <div className="text-[11px] font-mono text-slate-500 tabular-nums">
                        {u.two_fa_enabled ? '2FA' : 'Std'} · {u.active_session_count || 0} sess
                        {u.must_change_password === 1 ? ' · Reset Due' : ''}
                      </div>
                    </td>
                    <td className="py-2.5 px-3 font-mono text-slate-500 tabular-nums whitespace-nowrap">
                      {u.last_login_at ? u.last_login_at.slice(0, 16) : 'Never'}
                    </td>
                    <td className="py-2.5 px-3 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-1">
                        <button
                          onClick={() => setViewTarget(u)}
                          title="View Details"
                          className="p-1.5 text-slate-600 border border-slate-200 hover:bg-slate-50 rounded"
                        >
                          <Eye className="w-3.5 h-3.5" />
                        </button>
                        {canManageUsers && (
                          <>
                            <button
                              onClick={() => openEditUser(u)}
                              title="Edit Account & Department Scope"
                              className="p-1.5 text-slate-700 border border-slate-200 hover:bg-slate-50 rounded"
                            >
                              <Edit3 className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => {
                                setRolesTarget(u);
                                setEditRoleCodes(u.role_code.split(',').map((c) => c.trim()).filter(Boolean));
                              }}
                              title="Assign Roles"
                              className="p-1.5 text-teal-800 border border-teal-200 hover:bg-teal-50 rounded"
                            >
                              <Shield className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => handleStatusAction(u, 'reset_password')}
                              title="Reset Temporary Password"
                              className="p-1.5 text-slate-700 border border-slate-200 hover:bg-slate-50 rounded"
                            >
                              <KeyRound className="w-3.5 h-3.5" />
                            </button>
                            {isLocked ? (
                              <button
                                onClick={() => handleStatusAction(u, 'unlock')}
                                title="Unlock Account"
                                className="p-1.5 text-amber-800 border border-amber-300 hover:bg-amber-50 rounded"
                              >
                                <Unlock className="w-3.5 h-3.5" />
                              </button>
                            ) : (
                              <button
                                onClick={() => handleStatusAction(u, 'lock')}
                                disabled={u.id === currentUser.id}
                                title="Lock Account"
                                className="p-1.5 text-slate-700 border border-slate-200 hover:bg-slate-50 rounded disabled:opacity-30"
                              >
                                <Lock className="w-3.5 h-3.5" />
                              </button>
                            )}
                            <button
                              onClick={() => handleStatusAction(u, u.active ? 'deactivate' : 'activate')}
                              disabled={u.id === currentUser.id}
                              title={u.active ? 'Deactivate Account' : 'Activate Account'}
                              className={`p-1.5 border rounded disabled:opacity-30 ${
                                u.active
                                  ? 'text-red-700 border-red-200 hover:bg-red-50'
                                  : 'text-emerald-700 border-emerald-200 hover:bg-emerald-50'
                              }`}
                            >
                              <Power className="w-3.5 h-3.5" />
                            </button>
                          </>
                        )}
                        <button
                          onClick={() => openSessions(u)}
                          title="Active Sessions & Revoke"
                          className="px-2 py-1 text-[11px] font-mono text-slate-700 border border-slate-200 hover:bg-slate-50 rounded"
                        >
                          Sess
                        </button>
                        <button
                          onClick={() => openActivity(u)}
                          title="View User Activity"
                          className="p-1.5 text-slate-700 border border-slate-200 hover:bg-slate-50 rounded"
                        >
                          <Activity className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Create User from HR Employee Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-lg max-w-4xl w-full max-h-[92vh] flex flex-col">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <div>
                <h3 className="font-display text-base font-semibold text-slate-900">
                  Provision System Account from HR Employee Register
                </h3>
                <p className="text-xs text-slate-500">
                  HR maintains official staff records; system access and roles are explicitly assigned here.
                </p>
              </div>
              <button onClick={() => setShowCreateModal(false)} className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-12 flex-1 overflow-y-auto divide-y lg:divide-y-0 lg:divide-x divide-slate-200">
              {/* Left: HR Register Picker */}
              <div className="lg:col-span-5 p-4 flex flex-col gap-3 bg-slate-50/50">
                <div className="relative">
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    value={hrSearch}
                    onChange={(e) => setHrSearch(e.target.value)}
                    placeholder="Search HR ID, name, dept, designation..."
                    className="w-full pl-8 pr-3 py-1.5 text-xs bg-white border border-slate-300 rounded-md"
                  />
                </div>
                <div className="flex items-center gap-1 text-[11px]">
                  {(
                    [
                      ['available', 'Unprovisioned Active'],
                      ['all', 'All HR Staff'],
                      ['provisioned', 'Already Provisioned'],
                    ] as const
                  ).map(([k, lbl]) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setHrAccountFilter(k)}
                      className={`px-2.5 py-1 rounded border ${
                        hrAccountFilter === k ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-600 border-slate-200'
                      }`}
                    >
                      {lbl}
                    </button>
                  ))}
                </div>

                <div className="space-y-1.5 max-h-[380px] overflow-y-auto pr-1">
                  {modalHrList.length === 0 ? (
                    <div className="p-6 text-center text-xs text-slate-500 bg-white border border-slate-200 rounded">
                      No matching HR employees found. Add staff in HR Management first or switch filter.
                    </div>
                  ) : (
                    modalHrList.map((emp) => {
                      const selected = selectedEmp?.id === emp.id;
                      return (
                        <button
                          key={emp.id}
                          type="button"
                          onClick={() => selectEmployeeForAccount(emp)}
                          className={`w-full text-left p-2.5 rounded border text-xs transition-colors ${
                            selected
                              ? 'bg-teal-50 border-teal-600'
                              : 'bg-white border-slate-200 hover:border-slate-300'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-mono font-semibold text-teal-800">{emp.employee_number}</span>
                            <span
                              className={`font-mono text-[11px] ${
                                emp.has_system_account
                                  ? 'text-amber-700'
                                  : emp.status === 'active'
                                    ? 'text-emerald-700'
                                    : 'text-red-700'
                              }`}
                            >
                              {emp.has_system_account
                                ? `Linked (${emp.linked_roles || emp.linked_username})`
                                : emp.status === 'active'
                                  ? 'Available'
                                  : emp.status}
                            </span>
                          </div>
                          <div className="font-medium text-slate-900 mt-0.5">{emp.full_name}</div>
                          <div className="text-[11px] text-slate-500">
                            {emp.department_name} · {emp.job_position}
                          </div>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>

              {/* Right: Account Provisioning Form */}
              <form onSubmit={handleCreateUser} className="lg:col-span-7 p-5 space-y-4 text-xs">
                {!selectedEmp ? (
                  <div className="h-full flex items-center justify-center text-slate-500 text-center py-12">
                    Select an employee from the HR Register on the left to assign login credentials, roles, and department scope.
                  </div>
                ) : (
                  <>
                    <div className="p-3 bg-slate-50 border border-slate-200 rounded-md space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-slate-900">HR Record (Read-Only Source of Truth)</span>
                        <span className="font-mono text-teal-800">{selectedEmp.employee_number}</span>
                      </div>
                      <div className="text-slate-700">
                        {selectedEmp.full_name} · {selectedEmp.department_name} · {selectedEmp.job_position}
                      </div>
                      <div className="text-[11px] text-slate-500">
                        HR Status: <span className="font-mono uppercase">{selectedEmp.status}</span>
                        {selectedEmp.phone ? ` · ${selectedEmp.phone}` : ''}
                      </div>
                    </div>

                    {selectedEmp.has_system_account && (
                      <div className="p-3 bg-amber-50 border border-amber-200 rounded-md space-y-2">
                        <div className="font-semibold text-amber-900">
                          One-Account Rule Notice: This employee already has a linked system account ({selectedEmp.linked_username}).
                        </div>
                        <label className="flex items-center gap-2 text-amber-900 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={createForm.exception_approved}
                            onChange={(e) => setCreateForm({ ...createForm, exception_approved: e.target.checked })}
                          />
                          <span>Explicitly approve secondary account exception (audited)</span>
                        </label>
                      </div>
                    )}

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="block font-medium text-slate-700 mb-1">Username *</label>
                        <input
                          required
                          value={createForm.username}
                          onChange={(e) => setCreateForm({ ...createForm, username: e.target.value.toLowerCase() })}
                          className="w-full px-3 py-1.5 font-mono border border-slate-300 rounded-md"
                        />
                      </div>
                      <div>
                        <label className="block font-medium text-slate-700 mb-1">Login Email *</label>
                        <input
                          type="email"
                          required
                          value={createForm.email}
                          onChange={(e) => setCreateForm({ ...createForm, email: e.target.value })}
                          className="w-full px-3 py-1.5 border border-slate-300 rounded-md"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="block font-medium text-slate-700 mb-1">
                        Explicit System Roles * <span className="text-slate-400 font-normal">(HR position does not auto-grant access)</span>
                      </label>
                      <div className="grid grid-cols-2 gap-1.5 max-h-32 overflow-y-auto p-2 border border-slate-200 rounded-md">
                        {roles.map((r) => (
                          <label key={r.code} className="inline-flex items-center gap-1.5 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={createForm.role_codes.includes(r.code)}
                              onChange={(e) =>
                                setCreateForm((prev) => ({
                                  ...prev,
                                  role_codes: e.target.checked
                                    ? [...prev.role_codes, r.code]
                                    : prev.role_codes.filter((c) => c !== r.code),
                                }))
                              }
                            />
                            <span className="font-mono font-semibold text-teal-800">{r.code}</span>
                            <span className="text-slate-600 truncate">{r.name}</span>
                          </label>
                        ))}
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="block font-medium text-slate-700 mb-1">Department Scope Restrictions</label>
                        <div className="max-h-28 overflow-y-auto p-2 border border-slate-200 rounded-md space-y-1">
                          {departments.map((d) => (
                            <label key={d.id} className="flex items-center gap-1.5 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={createForm.department_ids.includes(d.id)}
                                onChange={(e) =>
                                  setCreateForm((prev) => ({
                                    ...prev,
                                    department_ids: e.target.checked
                                      ? [...prev.department_ids, d.id]
                                      : prev.department_ids.filter((id) => id !== d.id),
                                  }))
                                }
                              />
                              <span className="font-mono text-[11px] text-slate-500">{d.code}</span>
                              <span className="truncate text-slate-700">{d.name}</span>
                            </label>
                          ))}
                        </div>
                      </div>
                      <div>
                        <label className="block font-medium text-slate-700 mb-1">Assigned Clinic Rooms / Units</label>
                        <div className="max-h-28 overflow-y-auto p-2 border border-slate-200 rounded-md space-y-1">
                          {clinicRooms.map((rm) => (
                            <label key={rm.id} className="flex items-center gap-1.5 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={createForm.clinic_unit_ids.includes(rm.id)}
                                onChange={(e) =>
                                  setCreateForm((prev) => ({
                                    ...prev,
                                    clinic_unit_ids: e.target.checked
                                      ? [...prev.clinic_unit_ids, rm.id]
                                      : prev.clinic_unit_ids.filter((id) => id !== rm.id),
                                  }))
                                }
                              />
                              <span className="font-mono text-[11px] text-slate-500">{rm.room_code}</span>
                              <span className="truncate text-slate-700">{rm.name}</span>
                            </label>
                          ))}
                        </div>
                      </div>
                    </div>

                    <div className="space-y-2 pt-1">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={createForm.generate_temp_password}
                          onChange={(e) => setCreateForm({ ...createForm, generate_temp_password: e.target.checked })}
                        />
                        <span className="font-medium text-slate-800">Auto-generate one-time temporary password (force change on first login)</span>
                      </label>
                      {!createForm.generate_temp_password && (
                        <input
                          required
                          minLength={8}
                          type="text"
                          value={createForm.password}
                          onChange={(e) => setCreateForm({ ...createForm, password: e.target.value })}
                          placeholder="Enter temporary password (min 8 characters)"
                          className="w-full px-3 py-1.5 font-mono border border-slate-300 rounded-md"
                        />
                      )}
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={createForm.two_fa_enabled}
                          onChange={(e) => setCreateForm({ ...createForm, two_fa_enabled: e.target.checked })}
                        />
                        <span className="text-slate-700">Require 2FA verification code on sign-in</span>
                      </label>
                    </div>

                    <div className="pt-3 border-t border-slate-200 flex justify-end gap-2">
                      <button type="button" onClick={() => setShowCreateModal(false)} className="px-4 py-2 border border-slate-300 rounded-md">
                        Cancel
                      </button>
                      <button
                        type="submit"
                        disabled={selectedEmp.status !== 'active' || (selectedEmp.has_system_account && !createForm.exception_approved)}
                        className="px-4 py-2 font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md disabled:opacity-40"
                      >
                        Activate System User
                      </button>
                    </div>
                  </>
                )}
              </form>
            </div>
          </div>
        </div>
      )}

      {/* Issued Temporary Credentials Modal */}
      {issuedCreds && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-lg max-w-md w-full p-6 space-y-4 text-xs">
            <div className="flex items-center justify-between">
              <h3 className="font-display text-base font-semibold text-slate-900">{issuedCreds.title}</h3>
              <button onClick={() => setIssuedCreds(null)} className="text-slate-400 hover:text-slate-700">
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-slate-600">
              Share these temporary credentials securely with the staff member. They will be required to change this password on first login.
            </p>
            <div className="p-3 bg-slate-50 border border-slate-200 rounded font-mono space-y-1.5">
              <div>Username: <span className="font-semibold text-slate-900">{issuedCreds.username}</span></div>
              <div>Email: <span className="font-semibold text-slate-900">{issuedCreds.email}</span></div>
              <div>Temporary Password: <span className="font-semibold text-teal-800">{issuedCreds.tempPassword}</span></div>
            </div>
            <div className="flex justify-end">
              <button onClick={() => setIssuedCreds(null)} className="px-4 py-2 font-medium text-white bg-slate-900 rounded-md">
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* View User Details Modal */}
      {viewTarget && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-lg max-w-lg w-full p-6 space-y-4 text-xs">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <div>
                <h3 className="font-display text-base font-semibold text-slate-900">{viewTarget.full_name}</h3>
                <div className="font-mono text-slate-500">
                  {viewTarget.employee_number || 'Unlinked'} · @{viewTarget.username || viewTarget.email.split('@')[0]}
                </div>
              </div>
              <button onClick={() => setViewTarget(null)} className="text-slate-400 hover:text-slate-700">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><span className="text-slate-500">Email:</span> <span className="font-mono text-slate-900">{viewTarget.email}</span></div>
              <div><span className="text-slate-500">Status:</span> <span className="font-mono uppercase text-slate-900">{viewTarget.status}</span></div>
              <div><span className="text-slate-500">HR Dept:</span> <span className="text-slate-900">{viewTarget.hr_department_name || '—'}</span></div>
              <div><span className="text-slate-500">HR Position:</span> <span className="text-slate-900">{viewTarget.hr_job_position || '—'}</span></div>
              <div><span className="text-slate-500">Roles:</span> <span className="font-mono text-teal-800">{viewTarget.role_code}</span></div>
              <div><span className="text-slate-500">2FA:</span> <span className="text-slate-900">{viewTarget.two_fa_enabled ? 'Enabled' : 'Disabled'}</span></div>
              <div className="col-span-2">
                <span className="text-slate-500">Department Scope:</span>{' '}
                <span className="text-slate-900">{viewTarget.department_names || 'Default'}</span>
              </div>
              <div className="col-span-2">
                <span className="text-slate-500">Last Login:</span>{' '}
                <span className="font-mono text-slate-900">{viewTarget.last_login_at || 'Never'}</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Edit User & Scope Modal */}
      {editTarget && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-lg max-w-lg w-full max-h-[90vh] overflow-y-auto">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3 className="font-display text-base font-semibold text-slate-900">
                Edit Account &amp; Scope · {editTarget.full_name}
              </h3>
              <button onClick={() => setEditTarget(null)} className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleSaveEditUser} className="p-6 space-y-4 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Username *</label>
                  <input
                    required
                    value={editForm.username}
                    onChange={(e) => setEditForm({ ...editForm, username: e.target.value.toLowerCase() })}
                    className="w-full px-3 py-1.5 font-mono border border-slate-300 rounded-md"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Email *</label>
                  <input
                    type="email"
                    required
                    value={editForm.email}
                    onChange={(e) => setEditForm({ ...editForm, email: e.target.value })}
                    className="w-full px-3 py-1.5 border border-slate-300 rounded-md"
                  />
                </div>
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Clinical / Operational Specialty</label>
                <input
                  value={editForm.specialty}
                  onChange={(e) => setEditForm({ ...editForm, specialty: e.target.value })}
                  className="w-full px-3 py-1.5 border border-slate-300 rounded-md"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Authorized Departments</label>
                <div className="grid grid-cols-2 gap-1.5 max-h-32 overflow-y-auto p-2 border border-slate-200 rounded-md">
                  {departments.map((d) => (
                    <label key={d.id} className="inline-flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={editForm.department_ids.includes(d.id)}
                        onChange={(e) =>
                          setEditForm((prev) => ({
                            ...prev,
                            department_ids: e.target.checked
                              ? [...prev.department_ids, d.id]
                              : prev.department_ids.filter((id) => id !== d.id),
                          }))
                        }
                      />
                      <span className="font-mono text-[11px]">{d.code}</span>
                      <span className="truncate">{d.name}</span>
                    </label>
                  ))}
                </div>
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Authorized Clinic Rooms / Units</label>
                <div className="grid grid-cols-2 gap-1.5 max-h-32 overflow-y-auto p-2 border border-slate-200 rounded-md">
                  {clinicRooms.map((rm) => (
                    <label key={rm.id} className="inline-flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={editForm.clinic_unit_ids.includes(rm.id)}
                        onChange={(e) =>
                          setEditForm((prev) => ({
                            ...prev,
                            clinic_unit_ids: e.target.checked
                              ? [...prev.clinic_unit_ids, rm.id]
                              : prev.clinic_unit_ids.filter((id) => id !== rm.id),
                          }))
                        }
                      />
                      <span className="font-mono text-[11px]">{rm.room_code}</span>
                      <span className="truncate">{rm.name}</span>
                    </label>
                  ))}
                </div>
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={editForm.two_fa_enabled}
                  onChange={(e) => setEditForm({ ...editForm, two_fa_enabled: e.target.checked })}
                />
                <span>Require 2FA on login</span>
              </label>
              <div className="pt-3 border-t border-slate-200 flex justify-end gap-2">
                <button type="button" onClick={() => setEditTarget(null)} className="px-4 py-2 border border-slate-300 rounded-md">
                  Cancel
                </button>
                <button type="submit" className="px-4 py-2 font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md">
                  Save Changes
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Assign Roles Modal */}
      {rolesTarget && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-lg max-w-md w-full">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3 className="font-display text-base font-semibold text-slate-900">Assign Roles · {rolesTarget.full_name}</h3>
              <button onClick={() => setRolesTarget(null)} className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleSaveRoles} className="p-6 space-y-4 text-xs">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-64 overflow-y-auto">
                {roles.map((r) => (
                  <label key={r.code} className="flex items-center gap-2 p-2 border border-slate-200 rounded cursor-pointer hover:bg-slate-50">
                    <input
                      type="checkbox"
                      checked={editRoleCodes.includes(r.code)}
                      onChange={(e) =>
                        setEditRoleCodes((prev) => (e.target.checked ? [...prev, r.code] : prev.filter((c) => c !== r.code)))
                      }
                    />
                    <div>
                      <div className="font-mono font-semibold text-teal-800">{r.code}</div>
                      <div className="text-slate-600">{r.name}</div>
                    </div>
                  </label>
                ))}
              </div>
              <div className="pt-3 border-t border-slate-200 flex justify-end gap-2">
                <button type="button" onClick={() => setRolesTarget(null)} className="px-4 py-2 border border-slate-300 rounded-md">
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={editRoleCodes.length === 0}
                  className="px-4 py-2 font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md disabled:opacity-40"
                >
                  Save Roles
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Sessions Manager Modal */}
      {sessionsTarget && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-lg max-w-2xl w-full max-h-[85vh] flex flex-col">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <div>
                <h3 className="font-display text-base font-semibold text-slate-900">
                  Sessions · {sessionsTarget.full_name}
                </h3>
                <div className="text-xs text-slate-500">Revoking a session invalidates that JWT immediately on the next request.</div>
              </div>
              <div className="flex items-center gap-2">
                {canManageUsers && (
                  <button
                    onClick={async () => {
                      await handleStatusAction(sessionsTarget, 'revoke_sessions');
                      openSessions(sessionsTarget);
                    }}
                    className="px-3 py-1.5 text-xs font-medium text-red-700 border border-red-200 hover:bg-red-50 rounded"
                  >
                    Revoke All Sessions
                  </button>
                )}
                <button onClick={() => setSessionsTarget(null)} className="text-slate-400 hover:text-slate-700">
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>
            <div className="overflow-y-auto divide-y divide-slate-100 text-xs">
              {sessions.length === 0 ? (
                <div className="p-8 text-center text-slate-500">No recorded login sessions for this user yet.</div>
              ) : (
                sessions.map((s) => (
                  <div key={s.jti} className="px-6 py-3 flex items-center justify-between gap-3">
                    <div className="space-y-0.5 min-w-0">
                      <div className="font-mono text-slate-800 truncate">
                        {s.jti.slice(0, 14)}… · IP {s.ip_address || '127.0.0.1'}
                      </div>
                      <div className="text-slate-500 truncate">{s.user_agent || 'API Client'}</div>
                      <div className="font-mono text-[11px] text-slate-400 tabular-nums">
                        Created {s.created_at} · Last seen {s.last_seen_at}
                      </div>
                    </div>
                    <div className="shrink-0 flex items-center gap-2">
                      {s.revoked_at ? (
                        <span className="font-mono text-red-700">Revoked</span>
                      ) : (
                        <>
                          <span className="font-mono text-emerald-700">Active</span>
                          {canManageUsers && (
                            <button
                              onClick={() => handleRevokeSession(sessionsTarget.id, s.jti)}
                              className="inline-flex items-center gap-1 px-2.5 py-1 text-red-700 border border-red-200 hover:bg-red-50 rounded"
                            >
                              <Trash2 className="w-3 h-3" />
                              <span>Revoke</span>
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* User Activity Timeline Modal */}
      {activityTarget && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-lg max-w-2xl w-full max-h-[85vh] flex flex-col">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3 className="font-display text-base font-semibold text-slate-900">
                Recent Audit Activity · {activityTarget.full_name}
              </h3>
              <button onClick={() => setActivityTarget(null)} className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="overflow-y-auto divide-y divide-slate-100 text-xs">
              {activityLogs.length === 0 ? (
                <div className="p-8 text-center text-slate-500">No recorded audit activity for this user.</div>
              ) : (
                activityLogs.map((l) => (
                  <div key={l.id} className="px-6 py-2.5 flex items-center justify-between gap-3">
                    <div>
                      <span className="font-mono font-semibold text-teal-800">{l.action}</span>
                      <span className="mx-1.5 text-slate-300">·</span>
                      <span className="font-mono text-slate-600">{l.entity_type} #{l.entity_id ?? '—'}</span>
                      {l.reason && <span className="text-amber-800"> — {l.reason}</span>}
                    </div>
                    <span className="font-mono text-slate-400 tabular-nums shrink-0">{l.occurred_at}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
