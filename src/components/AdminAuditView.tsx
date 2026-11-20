import React, { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Search, ShieldCheck, UserPlus, X } from 'lucide-react';
import { apiFetch } from '../lib/api';
import type { AuditLog, UserContext } from '../types';

interface StaffUserRow {
  id: number;
  full_name: string;
  email: string;
  specialty: string | null;
  active: number;
  last_login_at: string | null;
  role_code: string;
  role_name: string;
}

interface RoleRow {
  id: number;
  code: string;
  name: string;
  description: string;
  permission_count: number;
}

interface AdminAuditViewProps {
  user: UserContext;
  initialTab?: 'audit' | 'users' | 'roles';
  onNotify: (msg: string, type?: 'success' | 'error') => void;
}

export const AdminAuditView: React.FC<AdminAuditViewProps> = ({ user, initialTab = 'audit', onNotify }) => {
  const canAudit = user.permissions.includes('audit.read');
  const canManageUsers = user.permissions.includes('admin.user.manage');
  const canRoles = user.permissions.includes('admin.role.manage');

  const [tab, setTab] = useState<'audit' | 'exceptions' | 'users' | 'roles'>(
    initialTab === 'users' && canManageUsers ? 'users' : canAudit ? 'audit' : 'users'
  );

  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [exceptions, setExceptions] = useState<AuditLog[]>([]);
  const [traceLogs, setTraceLogs] = useState<AuditLog[]>([]);
  const [tracePatientId, setTracePatientId] = useState('1');
  const [traceUserId, setTraceUserId] = useState('');
  const [logFilter, setLogFilter] = useState('');
  const [chainResult, setChainResult] = useState<{ valid: boolean; totalRows: number; brokenAtId: number | null } | null>(null);

  const [users, setUsers] = useState<StaffUserRow[]>([]);
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [showCreateUser, setShowCreateUser] = useState(false);
  const [newUserForm, setNewUserForm] = useState({
    full_name: '',
    email: '',
    password: 'Clinic360!',
    role_code: 'REC',
    specialty: '',
  });

  const loadData = useCallback(async () => {
    try {
      if (canAudit) {
        const [res, excRes] = await Promise.all([
          apiFetch<{ logs: AuditLog[] }>(`/api/audit-logs?action=${encodeURIComponent(logFilter)}`),
          apiFetch<{ exceptions: AuditLog[] }>('/api/audit-logs/exceptions'),
        ]);
        setLogs(res.logs);
        setExceptions(excRes.exceptions);
      }
      if (canManageUsers || canAudit) {
        const uRes = await apiFetch<{ users: StaffUserRow[] }>('/api/admin/users');
        setUsers(uRes.users);
      }
      if (canRoles || canManageUsers || canAudit) {
        const rRes = await apiFetch<{ roles: RoleRow[] }>('/api/admin/roles');
        setRoles(rRes.roles);
      }
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }, [canAudit, canManageUsers, canRoles, logFilter, onNotify]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  async function handleRunTrace(e: React.FormEvent) {
    e.preventDefault();
    try {
      const qs = new URLSearchParams();
      if (tracePatientId.trim()) qs.set('patientId', tracePatientId.trim());
      if (traceUserId.trim()) qs.set('userId', traceUserId.trim());
      const res = await apiFetch<{ trace: AuditLog[] }>(`/api/audit-logs/trace?${qs.toString()}`);
      setTraceLogs(res.trace);
      onNotify(`Loaded ${res.trace.length} chronological trace events`, 'success');
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleVerifyChain() {
    try {
      const res = await apiFetch<{ valid: boolean; totalRows: number; brokenAtId: number | null }>('/api/audit-logs/verify');
      setChainResult(res);
      onNotify(
        res.valid
          ? `Audit chain verified intact (${res.totalRows} entries)`
          : `Audit chain break detected at ID #${res.brokenAtId}`,
        res.valid ? 'success' : 'error'
      );
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleCreateUser(e: React.FormEvent) {
    e.preventDefault();
    try {
      await apiFetch('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify(newUserForm),
      });
      onNotify(`Created staff login for ${newUserForm.email} (${newUserForm.role_code})`, 'success');
      setShowCreateUser(false);
      setNewUserForm({ full_name: '', email: '', password: 'Clinic360!', role_code: 'REC', specialty: '' });
      loadData();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleToggleUser(id: number) {
    try {
      const res = await apiFetch<{ active: boolean }>(`/api/admin/users/${id}/toggle`, { method: 'PATCH' });
      onNotify(`User account ${res.active ? 'activated' : 'deactivated'}`, 'success');
      loadData();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-1 p-1 bg-slate-200/70 rounded-lg">
          {canAudit && (
            <>
              <button
                onClick={() => setTab('audit')}
                className={`px-3.5 py-1.5 text-xs font-medium rounded-md ${
                  tab === 'audit' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Audit Log ({logs.length})
              </button>
              <button
                onClick={() => setTab('exceptions')}
                className={`px-3.5 py-1.5 text-xs font-medium rounded-md ${
                  tab === 'exceptions' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Exceptions &amp; Trace ({exceptions.length})
              </button>
            </>
          )}
          {(canManageUsers || canAudit) && (
            <button
              onClick={() => setTab('users')}
              className={`px-3.5 py-1.5 text-xs font-medium rounded-md ${
                tab === 'users' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Staff Users ({users.length})
            </button>
          )}
          <button
            onClick={() => setTab('roles')}
            className={`px-3.5 py-1.5 text-xs font-medium rounded-md ${
              tab === 'roles' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            14-Role RBAC Matrix
          </button>
        </div>

        {tab === 'audit' && canAudit && (
          <button
            onClick={handleVerifyChain}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-md whitespace-nowrap"
          >
            <ShieldCheck className="w-3.5 h-3.5" />
            <span>Verify Hash Chain</span>
          </button>
        )}

        {tab === 'users' && canManageUsers && (
          <button
            onClick={() => setShowCreateUser(true)}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md whitespace-nowrap"
          >
            <UserPlus className="w-3.5 h-3.5" />
            <span>Create Staff User</span>
          </button>
        )}
      </div>

      {tab === 'audit' && canAudit && (
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="p-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
            <div className="relative flex-1 min-w-[240px] max-w-md">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                value={logFilter}
                onChange={(e) => setLogFilter(e.target.value)}
                placeholder="Filter by action, user, or entity..."
                className="w-full pl-9 pr-3 py-1.5 text-xs border border-slate-300 rounded-md"
              />
            </div>
            {chainResult && (
              <div className={`text-xs font-medium flex items-center gap-1.5 ${chainResult.valid ? 'text-emerald-700' : 'text-red-700'}`}>
                <CheckCircle2 className="w-4 h-4" />
                <span>
                  {chainResult.valid
                    ? `SHA-256 Chain Intact · ${chainResult.totalRows} append-only rows verified`
                    : `Tampering detected at row #${chainResult.brokenAtId}`}
                </span>
              </div>
            )}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium text-slate-500">
                  <th className="py-2.5 px-4">Timestamp (UTC)</th>
                  <th className="py-2.5 px-4">Actor &amp; Role</th>
                  <th className="py-2.5 px-4">Action</th>
                  <th className="py-2.5 px-4">Entity / Reason</th>
                  <th className="py-2.5 px-4">Row Hash (SHA-256)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-xs">
                {logs.map((l) => (
                  <tr key={l.id} className="hover:bg-slate-50/70">
                    <td className="py-2.5 px-4 font-mono text-slate-600 tabular-nums whitespace-nowrap">
                      {l.occurred_at}
                    </td>
                    <td className="py-2.5 px-4">
                      <span className="font-medium text-slate-900">{l.user_name}</span>
                      <span className="font-mono text-slate-500"> · {l.role_at_time}</span>
                    </td>
                    <td className="py-2.5 px-4 font-mono text-teal-800 font-medium">{l.action}</td>
                    <td className="py-2.5 px-4 text-slate-600 max-w-[260px] truncate">
                      <span>{l.entity_type} #{l.entity_id ?? '—'}</span>
                      {l.reason && <span className="text-amber-800"> · {l.reason}</span>}
                    </td>
                    <td className="py-2.5 px-4 font-mono text-slate-400 tabular-nums">
                      {l.row_hash.slice(0, 14)}…
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'exceptions' && canAudit && (
        <div className="space-y-6">
          <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between bg-slate-50/70">
              <div>
                <h3 className="font-display text-sm font-semibold text-slate-900">
                  Flagged Governance &amp; Security Exceptions
                </h3>
                <div className="text-xs text-slate-500">
                  Emergency bypasses, segregation blocks, result amendments, reprints, merges, and failed logins
                </div>
              </div>
              <span className="font-mono text-xs text-slate-600 tabular-nums">{exceptions.length} events</span>
            </div>
            {exceptions.length === 0 ? (
              <div className="p-8 text-center text-sm text-slate-500">No security or clinical exceptions recorded.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium text-slate-500">
                      <th className="py-2.5 px-4">Timestamp</th>
                      <th className="py-2.5 px-4">Actor</th>
                      <th className="py-2.5 px-4">Exception Action</th>
                      <th className="py-2.5 px-4">Target &amp; Reason</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-xs">
                    {exceptions.map((ex) => (
                      <tr key={ex.id} className="hover:bg-slate-50/70">
                        <td className="py-2.5 px-4 font-mono text-slate-500 tabular-nums whitespace-nowrap">{ex.occurred_at}</td>
                        <td className="py-2.5 px-4 font-medium text-slate-900">{ex.user_name} ({ex.role_at_time})</td>
                        <td className="py-2.5 px-4 font-mono font-semibold text-amber-800">{ex.action}</td>
                        <td className="py-2.5 px-4 text-slate-700">
                          <span className="font-mono">{ex.entity_type} #{ex.entity_id ?? '—'}</span>
                          {ex.reason && <span className="text-slate-600"> — {ex.reason}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <div className="p-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3 bg-slate-50/70">
              <div>
                <h3 className="font-display text-sm font-semibold text-slate-900">End-to-End Audit Trace</h3>
                <div className="text-xs text-slate-500">Reconstruct chronological timeline by Patient ID or Staff User ID</div>
              </div>
              <form onSubmit={handleRunTrace} className="flex flex-wrap items-center gap-2">
                <input
                  type="number"
                  value={tracePatientId}
                  onChange={(e) => setTracePatientId(e.target.value)}
                  placeholder="Patient ID (e.g. 1)"
                  className="w-32 px-2.5 py-1.5 text-xs font-mono border border-slate-300 rounded bg-white"
                />
                <select
                  value={traceUserId}
                  onChange={(e) => setTraceUserId(e.target.value)}
                  className="px-2.5 py-1.5 text-xs border border-slate-300 rounded bg-white"
                >
                  <option value="">All Staff Users</option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.role_code} — {u.full_name}
                    </option>
                  ))}
                </select>
                <button
                  type="submit"
                  className="px-3.5 py-1.5 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded"
                >
                  Run Trace
                </button>
              </form>
            </div>
            {traceLogs.length === 0 ? (
              <div className="p-8 text-center text-sm text-slate-500">
                Enter a Patient ID or select a Staff User and click Run Trace.
              </div>
            ) : (
              <div className="divide-y divide-slate-100 max-h-96 overflow-y-auto text-xs">
                {traceLogs.map((tr) => (
                  <div key={tr.id} className="px-4 py-2.5 flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <span className="font-mono font-semibold text-teal-800">{tr.action}</span>
                      <span className="mx-1.5 text-slate-300">·</span>
                      <span className="font-medium text-slate-900">{tr.user_name}</span> ({tr.role_at_time})
                      <span className="mx-1.5 text-slate-300">·</span>
                      <span className="font-mono text-slate-600">{tr.entity_type} #{tr.entity_id ?? '—'}</span>
                      {tr.reason && <span className="text-amber-800"> — {tr.reason}</span>}
                    </div>
                    <span className="font-mono text-slate-400 tabular-nums">{tr.occurred_at}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {tab === 'users' && (
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium text-slate-500">
                  <th className="py-2.5 px-4">Staff Member</th>
                  <th className="py-2.5 px-4">Email</th>
                  <th className="py-2.5 px-4">Role</th>
                  <th className="py-2.5 px-4">Status</th>
                  {canManageUsers && <th className="py-2.5 px-4 text-right">Account Control</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-sm">
                {users.map((u) => (
                  <tr key={u.id} className="hover:bg-slate-50/70">
                    <td className="py-2.5 px-4">
                      <div className="font-medium text-slate-900">{u.full_name}</div>
                      {u.specialty && <div className="text-xs text-slate-500">{u.specialty}</div>}
                    </td>
                    <td className="py-2.5 px-4 font-mono text-xs text-slate-600">{u.email}</td>
                    <td className="py-2.5 px-4 text-xs">
                      <span className="font-mono font-semibold text-teal-800">{u.role_code}</span>
                      <span className="text-slate-500"> · {u.role_name}</span>
                    </td>
                    <td className="py-2.5 px-4 text-xs">
                      <span className={u.active ? 'text-emerald-700 font-medium' : 'text-red-700'}>
                        {u.active ? 'Active' : 'Deactivated'}
                      </span>
                    </td>
                    {canManageUsers && (
                      <td className="py-2.5 px-4 text-right">
                        <button
                          onClick={() => handleToggleUser(u.id)}
                          disabled={u.id === user.id}
                          className="px-2.5 py-1 text-xs font-medium border border-slate-200 rounded hover:bg-slate-50 disabled:opacity-40"
                        >
                          {u.id === user.id ? 'Current Session' : u.active ? 'Deactivate' : 'Activate'}
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

      {tab === 'roles' && (
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium text-slate-500">
                <th className="py-2.5 px-4">Code</th>
                <th className="py-2.5 px-4">Role Title</th>
                <th className="py-2.5 px-4">Duties &amp; Separation Boundary</th>
                <th className="py-2.5 px-4 text-right">Permissions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-xs">
              {roles.map((r) => (
                <tr key={r.id} className="hover:bg-slate-50/70">
                  <td className="py-2.5 px-4 font-mono font-semibold text-teal-800">{r.code}</td>
                  <td className="py-2.5 px-4 font-medium text-slate-900">{r.name}</td>
                  <td className="py-2.5 px-4 text-slate-600">{r.description}</td>
                  <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-800">
                    {r.permission_count}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Create User Modal */}
      {showCreateUser && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-lg max-w-md w-full">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3 className="font-display text-base font-semibold text-slate-900">Create Staff Account</h3>
              <button onClick={() => setShowCreateUser(false)} className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleCreateUser} className="p-6 space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Full Name *</label>
                <input
                  required
                  value={newUserForm.full_name}
                  onChange={(e) => setNewUserForm({ ...newUserForm, full_name: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Work Email *</label>
                <input
                  type="email"
                  required
                  value={newUserForm.email}
                  onChange={(e) => setNewUserForm({ ...newUserForm, email: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Assigned Role *</label>
                <select
                  value={newUserForm.role_code}
                  onChange={(e) => setNewUserForm({ ...newUserForm, role_code: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md bg-white"
                >
                  {roles.map((r) => (
                    <option key={r.code} value={r.code}>
                      {r.code} — {r.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Temporary Password *</label>
                <input
                  required
                  value={newUserForm.password}
                  onChange={(e) => setNewUserForm({ ...newUserForm, password: e.target.value })}
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-md"
                />
              </div>
              <div className="pt-3 border-t border-slate-200 flex justify-end gap-2">
                <button type="button" onClick={() => setShowCreateUser(false)} className="px-4 py-2 text-xs border border-slate-300 rounded-md">
                  Cancel
                </button>
                <button type="submit" className="px-4 py-2 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md">
                  Create Account
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
