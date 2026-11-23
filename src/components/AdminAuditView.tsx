import React, { useCallback, useEffect, useState } from 'react';
import {
  BookOpen,
  CheckCircle2,
  Database,
  Download,
  Edit3,
  Plus,
  Search,
  Settings,
  Shield,
  ShieldCheck,
  Unlock,
  UserPlus,
  X,
} from 'lucide-react';
import { apiFetch, getAuthToken } from '../lib/api';
import type { AuditLog, ClinicSettings, UserContext } from '../types';

interface StaffUserRow {
  id: number;
  full_name: string;
  email: string;
  specialty: string | null;
  active: number;
  must_change_password?: number;
  two_fa_enabled?: number;
  failed_attempts?: number;
  locked_until?: string | null;
  last_login_at: string | null;
  role_code: string;
  role_name: string;
}

interface DeploymentStatus {
  dialect: 'sqlite' | 'mysql';
  dbClientMode: string;
  mysqlConfigured: boolean;
  mysqlSsl: boolean;
  counts?: {
    patients: number;
    visits: number;
    journalEntries: number;
    auditLogs: number;
  };
}

interface RoleRow {
  id: number;
  code: string;
  name: string;
  description: string;
  permission_count: number;
}

interface RolePermRow {
  role_id: number;
  code: string;
  module: string;
  scope: string;
}

interface PermissionDef {
  id: number;
  code: string;
  module: string;
  description: string;
}

type CatalogEntity = 'services' | 'lab_tests' | 'imaging_catalog' | 'medicines' | 'wards';

interface AdminAuditViewProps {
  user: UserContext;
  initialTab?: 'audit' | 'users' | 'roles';
  onNotify: (msg: string, type?: 'success' | 'error') => void;
}

export const AdminAuditView: React.FC<AdminAuditViewProps> = ({ user, initialTab = 'audit', onNotify }) => {
  const canAudit = user.permissions.includes('audit.read');
  const canManageUsers = user.permissions.includes('admin.user.manage');
  const canRoles = user.permissions.includes('admin.role.manage');
  const canEditCatalog = user.permissions.includes('catalog.manage');
  const canViewCatalog = canEditCatalog || canManageUsers;
  const canViewSettings = canManageUsers || canEditCatalog;

  const [tab, setTab] = useState<'audit' | 'exceptions' | 'users' | 'roles' | 'settings' | 'catalog'>(() => {
    if (initialTab === 'users' && (canManageUsers || canAudit)) return 'users';
    if (initialTab === 'roles' && (canRoles || canManageUsers || canAudit)) return 'roles';
    if (canAudit) return 'audit';
    if (canManageUsers) return 'users';
    if (canEditCatalog) return 'catalog';
    return 'roles';
  });

  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [exceptions, setExceptions] = useState<AuditLog[]>([]);
  const [traceLogs, setTraceLogs] = useState<AuditLog[]>([]);
  const [tracePatientId, setTracePatientId] = useState('1');
  const [traceUserId, setTraceUserId] = useState('');
  const [logFilter, setLogFilter] = useState('');
  const [auditFrom, setAuditFrom] = useState('');
  const [auditTo, setAuditTo] = useState('');
  const [auditOffset, setAuditOffset] = useState(0);
  const AUDIT_LIMIT = 50;
  const [chainResult, setChainResult] = useState<{ valid: boolean; totalRows: number; brokenAtId: number | null } | null>(null);

  const [users, setUsers] = useState<StaffUserRow[]>([]);
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [rolePerms, setRolePerms] = useState<RolePermRow[]>([]);
  const [allPermissions, setAllPermissions] = useState<PermissionDef[]>([]);
  const [deployStatus, setDeployStatus] = useState<DeploymentStatus | null>(null);

  // Create User Modal
  const [showCreateUser, setShowCreateUser] = useState(false);
  const [newUserForm, setNewUserForm] = useState({
    full_name: '',
    email: '',
    password: 'Clinic360!',
    role_codes: ['REC'] as string[],
    specialty: '',
  });

  // Edit User Roles Modal
  const [editRolesTarget, setEditRolesTarget] = useState<StaffUserRow | null>(null);
  const [editRoleCodes, setEditRoleCodes] = useState<string[]>([]);

  // Edit Role Permissions Modal
  const [editPermsRole, setEditPermsRole] = useState<RoleRow | null>(null);
  const [selectedPermCodes, setSelectedPermCodes] = useState<string[]>([]);

  // Clinic Settings
  const [settingsForm, setSettingsForm] = useState<ClinicSettings>({
    clinicName: 'Clinic360 Medical Center',
    currencyCode: 'USD',
    currencySymbol: '$',
    timezone: 'UTC',
    expenseAutoPostLimit: 500,
  });

  // Master Catalog CRUD
  const [catalogEntity, setCatalogEntity] = useState<CatalogEntity>('services');
  const [catalogRows, setCatalogRows] = useState<Array<Record<string, unknown>>>([]);
  const [catalogModalOpen, setCatalogModalOpen] = useState(false);
  const [catalogEditingId, setCatalogEditingId] = useState<number | null>(null);
  const [catalogForm, setCatalogForm] = useState<Record<string, string>>({});

  const loadCatalog = useCallback(
    async (entity: CatalogEntity) => {
      if (!canViewCatalog) return;
      try {
        const res = await apiFetch<{ rows: Array<Record<string, unknown>> }>(`/api/catalog/manage/${entity}`);
        setCatalogRows(res.rows || []);
      } catch (err) {
        onNotify((err as Error).message, 'error');
      }
    },
    [canViewCatalog, onNotify]
  );

  const loadData = useCallback(async () => {
    try {
      if (canAudit) {
        const qs = new URLSearchParams();
        if (logFilter.trim()) qs.set('action', logFilter.trim());
        if (auditFrom) qs.set('from', auditFrom);
        if (auditTo) qs.set('to', auditTo);
        qs.set('limit', String(AUDIT_LIMIT));
        qs.set('offset', String(auditOffset));

        const [res, excRes] = await Promise.all([
          apiFetch<{ logs: AuditLog[] }>(`/api/audit-logs?${qs.toString()}`),
          apiFetch<{ exceptions: AuditLog[] }>('/api/audit-logs/exceptions'),
        ]);
        setLogs(res.logs);
        setExceptions(excRes.exceptions);
      }
      if (canManageUsers || canAudit) {
        const [uRes, dRes] = await Promise.all([
          apiFetch<{ users: StaffUserRow[] }>('/api/admin/users'),
          apiFetch<DeploymentStatus>('/api/admin/deployment-status'),
        ]);
        setUsers(uRes.users);
        setDeployStatus(dRes);
      }
      if (canRoles || canManageUsers || canAudit) {
        const rRes = await apiFetch<{
          roles: RoleRow[];
          rolePerms?: RolePermRow[];
          allPermissions?: PermissionDef[];
        }>('/api/admin/roles');
        setRoles(rRes.roles);
        setRolePerms(rRes.rolePerms || []);
        setAllPermissions(rRes.allPermissions || []);
      }
      if (canViewSettings) {
        const sRes = await apiFetch<{ settings: ClinicSettings }>('/api/admin/settings');
        if (sRes.settings) setSettingsForm(sRes.settings);
      }
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }, [canAudit, canManageUsers, canRoles, canViewSettings, logFilter, auditFrom, auditTo, auditOffset, onNotify]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    if (tab === 'catalog' && canViewCatalog) {
      loadCatalog(catalogEntity);
    }
  }, [tab, catalogEntity, canViewCatalog, loadCatalog]);

  async function handleExportAuditCsv() {
    try {
      const token = getAuthToken();
      const qs = new URLSearchParams();
      if (auditFrom) qs.set('from', auditFrom);
      if (auditTo) qs.set('to', auditTo);
      const res = await fetch(`/api/audit-logs/export?${qs.toString()}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        const msg = await res.text();
        throw new Error(msg || `Export failed (${res.status})`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `clinic360-audit-${auditFrom || 'all'}-to-${auditTo || 'latest'}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      onNotify('Audit CSV exported cleanly', 'success');
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

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
    if (newUserForm.role_codes.length === 0) {
      onNotify('Select at least one role.', 'error');
      return;
    }
    try {
      await apiFetch('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify(newUserForm),
      });
      onNotify(`Created staff login for ${newUserForm.email} (${newUserForm.role_codes.join(', ')})`, 'success');
      setShowCreateUser(false);
      setNewUserForm({ full_name: '', email: '', password: 'Clinic360!', role_codes: ['REC'], specialty: '' });
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

  async function handleUnlockUser(u: StaffUserRow) {
    try {
      await apiFetch(`/api/admin/users/${u.id}/unlock`, { method: 'POST' });
      onNotify(`Unlocked account and reset failed attempts for ${u.email}`, 'success');
      loadData();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  function openEditRoles(u: StaffUserRow) {
    setEditRolesTarget(u);
    setEditRoleCodes(
      u.role_code
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean)
    );
  }

  async function handleSaveUserRoles(e: React.FormEvent) {
    e.preventDefault();
    if (!editRolesTarget) return;
    try {
      await apiFetch(`/api/admin/users/${editRolesTarget.id}/roles`, {
        method: 'PUT',
        body: JSON.stringify({ role_codes: editRoleCodes }),
      });
      onNotify(`Updated roles for ${editRolesTarget.full_name}`, 'success');
      setEditRolesTarget(null);
      loadData();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  function openEditRolePerms(r: RoleRow) {
    setEditPermsRole(r);
    const assigned = rolePerms.filter((rp) => rp.role_id === r.id).map((rp) => rp.code);
    setSelectedPermCodes(assigned);
  }

  async function handleSaveRolePerms(e: React.FormEvent) {
    e.preventDefault();
    if (!editPermsRole) return;
    try {
      await apiFetch(`/api/admin/roles/${editPermsRole.code}/permissions`, {
        method: 'PUT',
        body: JSON.stringify({ permission_codes: selectedPermCodes }),
      });
      onNotify(`Saved ${selectedPermCodes.length} permissions for ${editPermsRole.code}`, 'success');
      setEditPermsRole(null);
      loadData();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleSaveSettings(e: React.FormEvent) {
    e.preventDefault();
    try {
      const res = await apiFetch<{ settings: ClinicSettings }>('/api/admin/settings', {
        method: 'PUT',
        body: JSON.stringify(settingsForm),
      });
      if (res.settings) setSettingsForm(res.settings);
      onNotify('Clinic governance settings saved', 'success');
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  function openCatalogModal(row?: Record<string, unknown>) {
    if (row) {
      setCatalogEditingId(Number(row.id));
      const strMap: Record<string, string> = {};
      for (const [k, v] of Object.entries(row)) {
        strMap[k] = v === null || v === undefined ? '' : String(v);
      }
      setCatalogForm(strMap);
    } else {
      setCatalogEditingId(null);
      setCatalogForm({
        code: '',
        name: '',
        category: 'consultation',
        unit_price: '25',
        price: '25',
        sample_type: 'Serum',
        unit: '',
        reference_range: '',
        modality: 'X-Ray',
        body_region: 'Chest',
        generic_name: '',
        strength: '',
        form: 'Tablet',
        reorder_level: '20',
        department: 'Inpatient',
        daily_tariff: '80',
        active: '1',
      });
    }
    setCatalogModalOpen(true);
  }

  async function handleSaveCatalogItem(e: React.FormEvent) {
    e.preventDefault();
    try {
      if (catalogEditingId) {
        await apiFetch(`/api/catalog/manage/${catalogEntity}/${catalogEditingId}`, {
          method: 'PUT',
          body: JSON.stringify(catalogForm),
        });
        onNotify(`Updated ${catalogEntity} item #${catalogEditingId}`, 'success');
      } else {
        await apiFetch(`/api/catalog/manage/${catalogEntity}`, {
          method: 'POST',
          body: JSON.stringify(catalogForm),
        });
        onNotify(`Added new ${catalogEntity} catalog entry`, 'success');
      }
      setCatalogModalOpen(false);
      loadCatalog(catalogEntity);
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  const permissionsByModule = allPermissions.reduce<Record<string, PermissionDef[]>>((acc, p) => {
    if (!acc[p.module]) acc[p.module] = [];
    acc[p.module].push(p);
    return acc;
  }, {});

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-200/70 rounded-lg">
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
          {(canRoles || canManageUsers || canAudit) && (
            <button
              onClick={() => setTab('roles')}
              className={`px-3.5 py-1.5 text-xs font-medium rounded-md ${
                tab === 'roles' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              14-Role RBAC Matrix
            </button>
          )}
          {canViewSettings && (
            <button
              onClick={() => setTab('settings')}
              className={`inline-flex items-center gap-1 px-3.5 py-1.5 text-xs font-medium rounded-md ${
                tab === 'settings' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Settings className="w-3.5 h-3.5" />
              <span>Clinic Settings</span>
            </button>
          )}
          {canViewCatalog && (
            <button
              onClick={() => setTab('catalog')}
              className={`inline-flex items-center gap-1 px-3.5 py-1.5 text-xs font-medium rounded-md ${
                tab === 'catalog' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <BookOpen className="w-3.5 h-3.5" />
              <span>Master Catalog</span>
            </button>
          )}
        </div>

        {tab === 'audit' && canAudit && (
          <div className="flex items-center gap-2">
            <button
              onClick={handleExportAuditCsv}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-md whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Export CSV</span>
            </button>
            <button
              onClick={handleVerifyChain}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-md whitespace-nowrap"
            >
              <ShieldCheck className="w-3.5 h-3.5" />
              <span>Verify Hash Chain</span>
            </button>
          </div>
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

        {tab === 'catalog' && canEditCatalog && (
          <button
            onClick={() => openCatalogModal()}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md whitespace-nowrap"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add Catalog Item</span>
          </button>
        )}
      </div>

      {deployStatus && (
        <div className="bg-white border border-slate-200 rounded-lg px-5 py-3.5 flex flex-wrap items-center justify-between gap-4 text-xs">
          <div className="flex items-center gap-2.5">
            <Database className="w-4 h-4 text-teal-700 shrink-0" />
            <div>
              <span className="font-semibold text-slate-900">
                Database Engine: <span className="font-mono uppercase">{deployStatus.dialect}</span>
              </span>
              <span className="text-slate-400 mx-2">·</span>
              <span className="text-slate-600">
                Mode: <span className="font-mono">{deployStatus.dbClientMode}</span>
                {' · '}
                MySQL 8 Configured: <span className="font-mono">{deployStatus.mysqlConfigured ? 'Yes' : 'Fallback SQLite'}</span>
                {deployStatus.mysqlConfigured && ` · TLS/SSL: ${deployStatus.mysqlSsl ? 'Enabled' : 'Disabled'}`}
              </span>
            </div>
          </div>
          {deployStatus.counts && (
            <div className="font-mono tabular-nums text-slate-600">
              {deployStatus.counts.patients} patients · {deployStatus.counts.visits} visits · {deployStatus.counts.journalEntries} GL entries · {deployStatus.counts.auditLogs} audit rows
            </div>
          )}
        </div>
      )}

      {tab === 'audit' && canAudit && (
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="p-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2 flex-1">
              <div className="relative flex-1 min-w-[200px] max-w-xs">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  value={logFilter}
                  onChange={(e) => {
                    setAuditOffset(0);
                    setLogFilter(e.target.value);
                  }}
                  placeholder="Filter by action, user, or entity..."
                  className="w-full pl-9 pr-3 py-1.5 text-xs border border-slate-300 rounded-md"
                />
              </div>
              <input
                type="date"
                value={auditFrom}
                onChange={(e) => {
                  setAuditOffset(0);
                  setAuditFrom(e.target.value);
                }}
                title="From date"
                className="px-2.5 py-1.5 text-xs font-mono border border-slate-300 rounded-md"
              />
              <span className="text-xs text-slate-400">to</span>
              <input
                type="date"
                value={auditTo}
                onChange={(e) => {
                  setAuditOffset(0);
                  setAuditTo(e.target.value);
                }}
                title="To date"
                className="px-2.5 py-1.5 text-xs font-mono border border-slate-300 rounded-md"
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
          <div className="px-4 py-2.5 border-t border-slate-200 bg-slate-50/70 flex items-center justify-between text-xs text-slate-600">
            <span className="font-mono">
              Showing offset {auditOffset}–{auditOffset + logs.length}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={auditOffset === 0}
                onClick={() => setAuditOffset((o) => Math.max(0, o - AUDIT_LIMIT))}
                className="px-3 py-1 border border-slate-300 bg-white rounded hover:bg-slate-50 disabled:opacity-40"
              >
                Previous
              </button>
              <button
                type="button"
                disabled={logs.length < AUDIT_LIMIT}
                onClick={() => setAuditOffset((o) => o + AUDIT_LIMIT)}
                className="px-3 py-1 border border-slate-300 bg-white rounded hover:bg-slate-50 disabled:opacity-40"
              >
                Next
              </button>
            </div>
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
                  <th className="py-2.5 px-4">Roles</th>
                  <th className="py-2.5 px-4">Security &amp; Status</th>
                  {canManageUsers && <th className="py-2.5 px-4 text-right">Account Control</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-sm">
                {users.map((u) => {
                  const isLocked = Boolean(u.locked_until) || Number(u.failed_attempts || 0) >= 5;
                  return (
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
                        {u.two_fa_enabled === 1 && <span className="text-teal-800 font-mono"> · 2FA</span>}
                        {u.must_change_password === 1 && <span className="text-amber-700 font-mono"> · Pwd Reset Pending</span>}
                        {isLocked && <span className="text-red-700 font-mono font-semibold"> · LOCKED ({u.failed_attempts} fails)</span>}
                      </td>
                      {canManageUsers && (
                        <td className="py-2.5 px-4 text-right whitespace-nowrap space-x-1.5">
                          {isLocked && (
                            <button
                              onClick={() => handleUnlockUser(u)}
                              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-amber-800 border border-amber-300 hover:bg-amber-50 rounded"
                            >
                              <Unlock className="w-3 h-3" />
                              <span>Unlock</span>
                            </button>
                          )}
                          <button
                            onClick={() => openEditRoles(u)}
                            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-teal-800 border border-teal-200 hover:bg-teal-50 rounded"
                          >
                            <Shield className="w-3 h-3" />
                            <span>Roles</span>
                          </button>
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
                  );
                })}
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
                {canRoles && <th className="py-2.5 px-4 text-right">RBAC Matrix</th>}
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
                  {canRoles && (
                    <td className="py-2.5 px-4 text-right">
                      <button
                        onClick={() => openEditRolePerms(r)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-teal-800 border border-teal-200 hover:bg-teal-50 rounded"
                      >
                        <Edit3 className="w-3 h-3" />
                        <span>Configure</span>
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'settings' && canViewSettings && (
        <div className="bg-white border border-slate-200 rounded-lg max-w-2xl">
          <div className="px-6 py-4 border-b border-slate-200">
            <h3 className="font-display text-sm font-semibold text-slate-900">Clinic Governance &amp; Financial Thresholds</h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Changes take effect across receipts, clinical timestamps, and General Ledger approval gates.
            </p>
          </div>
          <form onSubmit={handleSaveSettings} className="p-6 space-y-4 text-xs">
            <div>
              <label className="block font-medium text-slate-700 mb-1">Facility Display Name</label>
              <input
                required
                disabled={!canManageUsers}
                value={settingsForm.clinicName}
                onChange={(e) => setSettingsForm({ ...settingsForm, clinicName: e.target.value })}
                className="w-full px-3 py-2 border border-slate-300 rounded-md disabled:bg-slate-50"
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="block font-medium text-slate-700 mb-1">Currency Code</label>
                <input
                  required
                  disabled={!canManageUsers}
                  value={settingsForm.currencyCode}
                  onChange={(e) => setSettingsForm({ ...settingsForm, currencyCode: e.target.value.toUpperCase() })}
                  className="w-full px-3 py-2 font-mono border border-slate-300 rounded-md disabled:bg-slate-50"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Currency Symbol</label>
                <input
                  required
                  disabled={!canManageUsers}
                  value={settingsForm.currencySymbol}
                  onChange={(e) => setSettingsForm({ ...settingsForm, currencySymbol: e.target.value })}
                  className="w-full px-3 py-2 font-mono border border-slate-300 rounded-md disabled:bg-slate-50"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">IANA Timezone</label>
                <input
                  required
                  disabled={!canManageUsers}
                  value={settingsForm.timezone}
                  onChange={(e) => setSettingsForm({ ...settingsForm, timezone: e.target.value })}
                  placeholder="UTC or Africa/Nairobi"
                  className="w-full px-3 py-2 font-mono border border-slate-300 rounded-md disabled:bg-slate-50"
                />
              </div>
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">Expense Voucher Auto-Post Threshold ($)</label>
              <input
                type="number"
                min={0}
                step="1"
                disabled={!canManageUsers}
                value={settingsForm.expenseAutoPostLimit ?? 500}
                onChange={(e) => setSettingsForm({ ...settingsForm, expenseAutoPostLimit: Number(e.target.value) })}
                className="w-48 px-3 py-2 font-mono border border-slate-300 rounded-md disabled:bg-slate-50"
              />
              <div className="text-[11px] text-slate-500 mt-1">
                Vouchers strictly above this amount require separate Manager/Finance approval before posting to GL.
              </div>
            </div>
            {canManageUsers && (
              <div className="pt-3 border-t border-slate-200 flex justify-end">
                <button type="submit" className="px-4 py-2 font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md">
                  Save Settings
                </button>
              </div>
            )}
          </form>
        </div>
      )}

      {tab === 'catalog' && canViewCatalog && (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-1.5">
            {(
              [
                ['services', 'Services & Consultations'],
                ['lab_tests', 'Laboratory Tests'],
                ['imaging_catalog', 'Imaging & Radiology'],
                ['medicines', 'Medicines Formulary'],
                ['wards', 'Inpatient Wards'],
              ] as Array<[CatalogEntity, string]>
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setCatalogEntity(key)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md border ${
                  catalogEntity === key
                    ? 'bg-teal-700 text-white border-teal-700'
                    : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/70 font-medium text-slate-500">
                    <th className="py-2.5 px-4">Code</th>
                    <th className="py-2.5 px-4">Name / Description</th>
                    <th className="py-2.5 px-4">Details</th>
                    <th className="py-2.5 px-4 text-right">Tariff / Price</th>
                    {canEditCatalog && <th className="py-2.5 px-4 text-right">Edit</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {catalogRows.map((row) => {
                    const id = Number(row.id);
                    const name = String(row.name || row.generic_name || '');
                    const price = Number(row.unit_price ?? row.price ?? row.daily_tariff ?? 0);
                    const detail =
                      catalogEntity === 'services'
                        ? `${row.category}${Number(row.active) === 0 ? ' · Inactive' : ''}`
                        : catalogEntity === 'lab_tests'
                          ? `${row.sample_type || ''} · ${row.reference_range || ''}`
                          : catalogEntity === 'imaging_catalog'
                            ? `${row.modality || ''} · ${row.body_region || ''}`
                            : catalogEntity === 'medicines'
                              ? `${row.strength || ''} · Stock ${row.stock_qty ?? 0} · Reorder ${row.reorder_level ?? 0}`
                              : `Dept: ${row.department || ''}`;
                    return (
                      <tr key={id} className="hover:bg-slate-50/70">
                        <td className="py-2.5 px-4 font-mono font-semibold text-teal-800">{String(row.code || '')}</td>
                        <td className="py-2.5 px-4 font-medium text-slate-900">{name}</td>
                        <td className="py-2.5 px-4 text-slate-600">{detail}</td>
                        <td className="py-2.5 px-4 text-right font-mono tabular-nums">${price.toFixed(2)}</td>
                        {canEditCatalog && (
                          <td className="py-2.5 px-4 text-right">
                            <button
                              onClick={() => openCatalogModal(row)}
                              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-700 border border-slate-200 hover:bg-slate-50 rounded"
                            >
                              <Edit3 className="w-3 h-3" />
                              <span>Edit</span>
                            </button>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Create User Modal */}
      {showCreateUser && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-lg max-w-md w-full max-h-[90vh] overflow-y-auto">
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
                <label className="block text-xs font-medium text-slate-700 mb-1">Assigned Roles *</label>
                <div className="grid grid-cols-2 gap-1.5 max-h-36 overflow-y-auto p-2 border border-slate-200 rounded-md text-xs">
                  {roles.map((r) => {
                    const checked = newUserForm.role_codes.includes(r.code);
                    return (
                      <label key={r.code} className="inline-flex items-center gap-1.5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) =>
                            setNewUserForm((prev) => ({
                              ...prev,
                              role_codes: e.target.checked
                                ? [...prev.role_codes, r.code]
                                : prev.role_codes.filter((c) => c !== r.code),
                            }))
                          }
                        />
                        <span className="font-mono font-semibold">{r.code}</span>
                        <span className="text-slate-500 truncate">{r.name}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Specialty / Department (Opt)</label>
                <input
                  value={newUserForm.specialty}
                  onChange={(e) => setNewUserForm({ ...newUserForm, specialty: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md"
                />
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

      {/* Edit User Multi-Role Modal */}
      {editRolesTarget && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-lg max-w-md w-full">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3 className="font-display text-base font-semibold text-slate-900">
                Assign Roles · {editRolesTarget.full_name}
              </h3>
              <button onClick={() => setEditRolesTarget(null)} className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleSaveUserRoles} className="p-6 space-y-4 text-xs">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-64 overflow-y-auto">
                {roles.map((r) => (
                  <label key={r.code} className="flex items-center gap-2 p-2 border border-slate-200 rounded cursor-pointer hover:bg-slate-50">
                    <input
                      type="checkbox"
                      checked={editRoleCodes.includes(r.code)}
                      onChange={(e) =>
                        setEditRoleCodes((prev) =>
                          e.target.checked ? [...prev, r.code] : prev.filter((c) => c !== r.code)
                        )
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
                <button type="button" onClick={() => setEditRolesTarget(null)} className="px-4 py-2 border border-slate-300 rounded-md">
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

      {/* Edit Role Permissions Modal */}
      {editPermsRole && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-lg max-w-3xl w-full max-h-[90vh] flex flex-col">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <div>
                <h3 className="font-display text-base font-semibold text-slate-900">
                  Configure RBAC Permissions · {editPermsRole.code} ({editPermsRole.name})
                </h3>
                <div className="text-xs text-slate-500">{selectedPermCodes.length} permissions enabled</div>
              </div>
              <button onClick={() => setEditPermsRole(null)} className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleSaveRolePerms} className="p-6 overflow-y-auto space-y-4 text-xs flex-1">
              {Object.entries(permissionsByModule).map(([mod, perms]) => (
                <div key={mod} className="border border-slate-200 rounded-md p-3 space-y-2">
                  <div className="font-semibold text-slate-900 uppercase tracking-wide text-[11px]">{mod}</div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                    {perms.map((p) => (
                      <label key={p.code} className="inline-flex items-start gap-2 cursor-pointer p-1 rounded hover:bg-slate-50">
                        <input
                          type="checkbox"
                          className="mt-0.5"
                          checked={selectedPermCodes.includes(p.code)}
                          onChange={(e) =>
                            setSelectedPermCodes((prev) =>
                              e.target.checked ? [...prev, p.code] : prev.filter((c) => c !== p.code)
                            )
                          }
                        />
                        <div>
                          <div className="font-mono font-medium text-slate-800">{p.code}</div>
                          {p.description && <div className="text-slate-500 text-[11px]">{p.description}</div>}
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
              <div className="pt-3 border-t border-slate-200 flex justify-end gap-2">
                <button type="button" onClick={() => setEditPermsRole(null)} className="px-4 py-2 border border-slate-300 rounded-md">
                  Cancel
                </button>
                <button type="submit" className="px-4 py-2 font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md">
                  Save Role Permissions
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Catalog Add / Edit Modal */}
      {catalogModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-lg max-w-md w-full">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3 className="font-display text-base font-semibold text-slate-900">
                {catalogEditingId ? `Edit ${catalogEntity} #${catalogEditingId}` : `Add ${catalogEntity} Entry`}
              </h3>
              <button onClick={() => setCatalogModalOpen(false)} className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleSaveCatalogItem} className="p-6 space-y-3 text-xs">
              {!catalogEditingId && (
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Code *</label>
                  <input
                    required
                    value={catalogForm.code || ''}
                    onChange={(e) => setCatalogForm({ ...catalogForm, code: e.target.value })}
                    className="w-full px-3 py-2 font-mono border border-slate-300 rounded-md"
                  />
                </div>
              )}

              {catalogEntity === 'medicines' ? (
                <>
                  <div>
                    <label className="block font-medium text-slate-700 mb-1">Generic Name *</label>
                    <input
                      required
                      value={catalogForm.generic_name || ''}
                      onChange={(e) => setCatalogForm({ ...catalogForm, generic_name: e.target.value })}
                      className="w-full px-3 py-2 border border-slate-300 rounded-md"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block font-medium text-slate-700 mb-1">Strength</label>
                      <input
                        value={catalogForm.strength || ''}
                        onChange={(e) => setCatalogForm({ ...catalogForm, strength: e.target.value })}
                        className="w-full px-3 py-2 border border-slate-300 rounded-md"
                      />
                    </div>
                    <div>
                      <label className="block font-medium text-slate-700 mb-1">Unit Price ($) *</label>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        required
                        value={catalogForm.unit_price || '0'}
                        onChange={(e) => setCatalogForm({ ...catalogForm, unit_price: e.target.value })}
                        className="w-full px-3 py-2 font-mono border border-slate-300 rounded-md"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block font-medium text-slate-700 mb-1">Reorder Level</label>
                    <input
                      type="number"
                      min="0"
                      value={catalogForm.reorder_level || '20'}
                      onChange={(e) => setCatalogForm({ ...catalogForm, reorder_level: e.target.value })}
                      className="w-full px-3 py-2 font-mono border border-slate-300 rounded-md"
                    />
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <label className="block font-medium text-slate-700 mb-1">Name *</label>
                    <input
                      required
                      value={catalogForm.name || ''}
                      onChange={(e) => setCatalogForm({ ...catalogForm, name: e.target.value })}
                      className="w-full px-3 py-2 border border-slate-300 rounded-md"
                    />
                  </div>
                  {catalogEntity === 'services' && (
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block font-medium text-slate-700 mb-1">Category</label>
                        <input
                          value={catalogForm.category || 'consultation'}
                          onChange={(e) => setCatalogForm({ ...catalogForm, category: e.target.value })}
                          className="w-full px-3 py-2 border border-slate-300 rounded-md"
                        />
                      </div>
                      <div>
                        <label className="block font-medium text-slate-700 mb-1">Unit Price ($) *</label>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          required
                          value={catalogForm.unit_price || '0'}
                          onChange={(e) => setCatalogForm({ ...catalogForm, unit_price: e.target.value })}
                          className="w-full px-3 py-2 font-mono border border-slate-300 rounded-md"
                        />
                      </div>
                    </div>
                  )}
                  {catalogEntity === 'lab_tests' && (
                    <div className="grid grid-cols-3 gap-2">
                      <div>
                        <label className="block font-medium text-slate-700 mb-1">Sample</label>
                        <input
                          value={catalogForm.sample_type || 'Serum'}
                          onChange={(e) => setCatalogForm({ ...catalogForm, sample_type: e.target.value })}
                          className="w-full px-2.5 py-2 border border-slate-300 rounded-md"
                        />
                      </div>
                      <div>
                        <label className="block font-medium text-slate-700 mb-1">Ref Range</label>
                        <input
                          value={catalogForm.reference_range || ''}
                          onChange={(e) => setCatalogForm({ ...catalogForm, reference_range: e.target.value })}
                          className="w-full px-2.5 py-2 border border-slate-300 rounded-md"
                        />
                      </div>
                      <div>
                        <label className="block font-medium text-slate-700 mb-1">Price ($) *</label>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          required
                          value={catalogForm.price || '0'}
                          onChange={(e) => setCatalogForm({ ...catalogForm, price: e.target.value })}
                          className="w-full px-2.5 py-2 font-mono border border-slate-300 rounded-md"
                        />
                      </div>
                    </div>
                  )}
                  {catalogEntity === 'imaging_catalog' && (
                    <div className="grid grid-cols-3 gap-2">
                      <div>
                        <label className="block font-medium text-slate-700 mb-1">Modality</label>
                        <input
                          value={catalogForm.modality || 'X-Ray'}
                          onChange={(e) => setCatalogForm({ ...catalogForm, modality: e.target.value })}
                          className="w-full px-2.5 py-2 border border-slate-300 rounded-md"
                        />
                      </div>
                      <div>
                        <label className="block font-medium text-slate-700 mb-1">Region</label>
                        <input
                          value={catalogForm.body_region || ''}
                          onChange={(e) => setCatalogForm({ ...catalogForm, body_region: e.target.value })}
                          className="w-full px-2.5 py-2 border border-slate-300 rounded-md"
                        />
                      </div>
                      <div>
                        <label className="block font-medium text-slate-700 mb-1">Price ($) *</label>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          required
                          value={catalogForm.price || '0'}
                          onChange={(e) => setCatalogForm({ ...catalogForm, price: e.target.value })}
                          className="w-full px-2.5 py-2 font-mono border border-slate-300 rounded-md"
                        />
                      </div>
                    </div>
                  )}
                  {catalogEntity === 'wards' && (
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block font-medium text-slate-700 mb-1">Department</label>
                        <input
                          value={catalogForm.department || 'Inpatient'}
                          onChange={(e) => setCatalogForm({ ...catalogForm, department: e.target.value })}
                          className="w-full px-3 py-2 border border-slate-300 rounded-md"
                        />
                      </div>
                      <div>
                        <label className="block font-medium text-slate-700 mb-1">Daily Tariff ($) *</label>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          required
                          value={catalogForm.daily_tariff || '80'}
                          onChange={(e) => setCatalogForm({ ...catalogForm, daily_tariff: e.target.value })}
                          className="w-full px-3 py-2 font-mono border border-slate-300 rounded-md"
                        />
                      </div>
                    </div>
                  )}
                </>
              )}

              <div className="pt-3 border-t border-slate-200 flex justify-end gap-2">
                <button type="button" onClick={() => setCatalogModalOpen(false)} className="px-4 py-2 border border-slate-300 rounded-md">
                  Cancel
                </button>
                <button type="submit" className="px-4 py-2 font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md">
                  {catalogEditingId ? 'Save Changes' : 'Create Entry'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
