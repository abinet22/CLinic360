import React, { useCallback, useEffect, useState } from 'react';
import {
  Bell,
  BookOpen,
  Building2,
  CheckCircle2,
  CreditCard,
  Database,
  Download,
  Edit3,
  FileText,
  Lock,
  Plus,
  Search,
  Shield,
  ShieldCheck,
  Stethoscope,
  Users,
  X,
} from 'lucide-react';
import { apiFetch, getAuthToken } from '../lib/api';
import type {
  AuditLog,
  ClinicRoomConfig,
  ClinicSettings,
  DepartmentConfig,
  DoctorProfileConfig,
  SpecialtyConfig,
  StaffUserRow,
  UserContext,
} from '../types';
import { UserManagementPanel } from './admin/UserManagementPanel';
import { ClinicConfigPanel } from './admin/ClinicConfigPanel';
import { SystemConfigPanel } from './admin/SystemConfigPanel';

export type AdminTab =
  | 'audit'
  | 'exceptions'
  | 'users'
  | 'roles'
  | 'clinic_config'
  | 'clinical_config'
  | 'catalog'
  | 'billing_config'
  | 'notifications_config'
  | 'documents_config'
  | 'security_config'
  | 'backup';

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
  system_role?: number;
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
  initialTab?: AdminTab;
  onNotify: (msg: string, type?: 'success' | 'error') => void;
}

export const AdminAuditView: React.FC<AdminAuditViewProps> = ({ user, initialTab, onNotify }) => {
  const canAudit = user.permissions.includes('audit.read');
  const canManageUsers = user.permissions.includes('admin.user.manage');
  const canRoles = user.permissions.includes('admin.role.manage');
  const canConfig = user.permissions.includes('admin.config.manage') || canManageUsers;
  const canBackup = user.permissions.includes('admin.backup.manage') || canManageUsers;
  const canEditCatalog = user.permissions.includes('catalog.manage');
  const canViewCatalog = canEditCatalog || canManageUsers || canConfig;

  const resolveDefaultTab = useCallback(
    (requested?: AdminTab): AdminTab => {
      if (requested) {
        if ((requested === 'audit' || requested === 'exceptions') && canAudit) return requested;
        if (requested === 'users' && (canManageUsers || canAudit)) return 'users';
        if (requested === 'roles' && (canRoles || canManageUsers || canAudit)) return 'roles';
        if (requested === 'catalog' && canViewCatalog) return 'catalog';
        if (requested === 'backup' && (canBackup || canAudit)) return 'backup';
        if (
          (requested === 'clinic_config' ||
            requested === 'clinical_config' ||
            requested === 'billing_config' ||
            requested === 'notifications_config' ||
            requested === 'documents_config' ||
            requested === 'security_config') &&
          (canConfig || canViewCatalog)
        ) {
          return requested;
        }
      }
      if (canManageUsers) return 'users';
      if (canAudit) return 'audit';
      if (canConfig) return 'clinic_config';
      if (canEditCatalog) return 'catalog';
      return 'roles';
    },
    [canAudit, canManageUsers, canRoles, canConfig, canBackup, canEditCatalog, canViewCatalog]
  );

  const [tab, setTab] = useState<AdminTab>(() => resolveDefaultTab(initialTab));

  useEffect(() => {
    if (initialTab) {
      setTab(resolveDefaultTab(initialTab));
    }
  }, [initialTab, resolveDefaultTab]);

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
  const [departments, setDepartments] = useState<DepartmentConfig[]>([]);
  const [specialties, setSpecialties] = useState<SpecialtyConfig[]>([]);
  const [clinicRooms, setClinicRooms] = useState<ClinicRoomConfig[]>([]);
  const [doctors, setDoctors] = useState<DoctorProfileConfig[]>([]);

  // Custom Role Create / Edit Modal
  const [roleModalOpen, setRoleModalOpen] = useState(false);
  const [editingRoleMeta, setEditingRoleMeta] = useState<RoleRow | null>(null);
  const [roleMetaForm, setRoleMetaForm] = useState({ code: '', name: '', description: '' });

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
        setUsers(uRes.users || []);
        setDeployStatus(dRes);
      }
      if (canRoles || canManageUsers || canAudit) {
        const rRes = await apiFetch<{
          roles: RoleRow[];
          rolePerms?: RolePermRow[];
          allPermissions?: PermissionDef[];
        }>('/api/admin/roles');
        setRoles(rRes.roles || []);
        setRolePerms(rRes.rolePerms || []);
        setAllPermissions(rRes.allPermissions || []);
      }
      if (canConfig || canViewCatalog || canAudit) {
        const [deptRes, specRes, roomRes, docRes] = await Promise.all([
          apiFetch<{ departments: DepartmentConfig[] }>('/api/admin/departments').catch(() => ({ departments: [] })),
          apiFetch<{ specialties: SpecialtyConfig[] }>('/api/admin/specialties').catch(() => ({ specialties: [] })),
          apiFetch<{ rooms: ClinicRoomConfig[] }>('/api/admin/clinic-rooms').catch(() => ({ rooms: [] })),
          apiFetch<{ doctors: DoctorProfileConfig[] }>('/api/admin/doctors').catch(() => ({ doctors: [] })),
        ]);
        setDepartments(deptRes.departments || []);
        setSpecialties(specRes.specialties || []);
        setClinicRooms(roomRes.rooms || []);
        setDoctors(docRes.doctors || []);
      }
      if (canConfig || canViewCatalog) {
        const sRes = await apiFetch<{ settings: ClinicSettings }>('/api/admin/settings');
        if (sRes.settings) setSettingsForm(sRes.settings);
      }
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }, [canAudit, canManageUsers, canRoles, canConfig, canViewCatalog, logFilter, auditFrom, auditTo, auditOffset, onNotify]);

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
        credentials: 'include',
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

  function openRoleModal(role?: RoleRow) {
    if (role) {
      setEditingRoleMeta(role);
      setRoleMetaForm({ code: role.code, name: role.name, description: role.description || '' });
    } else {
      setEditingRoleMeta(null);
      setRoleMetaForm({ code: '', name: '', description: '' });
    }
    setRoleModalOpen(true);
  }

  async function handleSaveRoleMeta(e: React.FormEvent) {
    e.preventDefault();
    try {
      if (editingRoleMeta) {
        await apiFetch(`/api/admin/roles/${editingRoleMeta.code}`, {
          method: 'PUT',
          body: JSON.stringify({ name: roleMetaForm.name, description: roleMetaForm.description }),
        });
        onNotify(`Updated role ${editingRoleMeta.code}`, 'success');
      } else {
        await apiFetch('/api/admin/roles', {
          method: 'POST',
          body: JSON.stringify({
            code: roleMetaForm.code,
            name: roleMetaForm.name,
            description: roleMetaForm.description,
            permission_codes: [],
          }),
        });
        onNotify(`Created custom role ${roleMetaForm.code.toUpperCase()}. Configure its permissions next.`, 'success');
      }
      setRoleModalOpen(false);
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

  const tabItems: Array<{
    key: AdminTab;
    label: string;
    visible: boolean;
    icon: React.ComponentType<{ className?: string }>;
  }> = [
    { key: 'users', label: `Staff Users (${users.length})`, visible: canManageUsers || canAudit, icon: Users },
    { key: 'roles', label: `Roles & RBAC (${roles.length})`, visible: canRoles || canManageUsers || canAudit, icon: Shield },
    { key: 'clinic_config', label: 'Clinic & Depts', visible: canConfig, icon: Building2 },
    { key: 'clinical_config', label: 'Clinical', visible: canConfig, icon: Stethoscope },
    { key: 'catalog', label: 'Services & Catalog', visible: canViewCatalog, icon: BookOpen },
    { key: 'billing_config', label: 'Billing & GL', visible: canConfig, icon: CreditCard },
    { key: 'notifications_config', label: 'Notifications', visible: canConfig, icon: Bell },
    { key: 'documents_config', label: 'Print Headers', visible: canConfig, icon: FileText },
    { key: 'security_config', label: 'Security', visible: canConfig, icon: Lock },
    { key: 'audit', label: `Audit Log (${logs.length})`, visible: canAudit, icon: ShieldCheck },
    { key: 'exceptions', label: `Exceptions (${exceptions.length})`, visible: canAudit, icon: Search },
    { key: 'backup', label: 'Backup & DB', visible: canBackup || canAudit, icon: Database },
  ];

  return (
    <div className="space-y-5">
      {/* Admin Sub-navigation Bar + Context Actions */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-200/70 rounded-lg">
          {tabItems
            .filter((t) => t.visible)
            .map((t) => {
              const Icon = t.icon;
              return (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setTab(t.key)}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                    tab === t.key ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  <span>{t.label}</span>
                </button>
              );
            })}
        </div>

        {tab === 'audit' && canAudit && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleExportAuditCsv}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-md whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Export CSV</span>
            </button>
            <button
              type="button"
              onClick={handleVerifyChain}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-md whitespace-nowrap"
            >
              <ShieldCheck className="w-3.5 h-3.5" />
              <span>Verify Hash Chain</span>
            </button>
          </div>
        )}

        {tab === 'roles' && canRoles && (
          <button
            type="button"
            onClick={() => openRoleModal()}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md whitespace-nowrap"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Create Custom Role</span>
          </button>
        )}

        {tab === 'catalog' && canEditCatalog && (
          <button
            type="button"
            onClick={() => openCatalogModal()}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md whitespace-nowrap"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add Catalog Item</span>
          </button>
        )}
      </div>

      {deployStatus && (
        <div className="bg-white border border-slate-200 rounded-lg px-5 py-3 flex flex-wrap items-center justify-between gap-4 text-xs">
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
                MySQL 8: <span className="font-mono">{deployStatus.mysqlConfigured ? 'Configured' : 'Fallback SQLite'}</span>
                {deployStatus.mysqlConfigured && ` · TLS: ${deployStatus.mysqlSsl ? 'Enabled' : 'Disabled'}`}
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

      {tab === 'users' && (canManageUsers || canAudit) && (
        <UserManagementPanel
          currentUser={user}
          users={users}
          roles={roles}
          departments={departments}
          clinicRooms={clinicRooms}
          canManageUsers={canManageUsers}
          onRefresh={loadData}
          onNotify={onNotify}
        />
      )}

      {tab === 'clinic_config' && canConfig && (
        <ClinicConfigPanel
          settings={settingsForm}
          departments={departments}
          specialties={specialties}
          clinicRooms={clinicRooms}
          doctors={doctors}
          canManageConfig={canConfig}
          onSettingsSaved={setSettingsForm}
          onRefresh={loadData}
          onNotify={onNotify}
        />
      )}

      {(tab === 'clinical_config' ||
        tab === 'billing_config' ||
        tab === 'notifications_config' ||
        tab === 'documents_config' ||
        tab === 'security_config' ||
        tab === 'backup') && (
        <SystemConfigPanel
          section={tab}
          settings={settingsForm}
          canManageConfig={canConfig}
          canManageBackup={canBackup}
          onSettingsSaved={setSettingsForm}
          onNotify={onNotify}
        />
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
            <span className="font-mono tabular-nums">
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
                  Emergency bypasses, segregation blocks, result amendments, reprints, offboarding alerts, and failed logins
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

      {tab === 'roles' && (
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-5 py-3 border-b border-slate-200 bg-slate-50/70 flex items-center justify-between text-xs">
            <div>
              <span className="font-semibold text-slate-900">Dynamic Role &amp; Permission Matrix</span>
              <span className="text-slate-500 ml-2">
                ({roles.length} roles · {allPermissions.length} granular permissions)
              </span>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium text-slate-500">
                  <th className="py-2.5 px-4">Code</th>
                  <th className="py-2.5 px-4">Role Title</th>
                  <th className="py-2.5 px-4">Duties &amp; Separation Boundary</th>
                  <th className="py-2.5 px-4">Origin</th>
                  <th className="py-2.5 px-4 text-right">Permissions</th>
                  {canRoles && <th className="py-2.5 px-4 text-right">Actions</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-xs">
                {roles.map((r) => (
                  <tr key={r.id} className="hover:bg-slate-50/70">
                    <td className="py-2.5 px-4 font-mono font-semibold text-teal-800">{r.code}</td>
                    <td className="py-2.5 px-4 font-medium text-slate-900">{r.name}</td>
                    <td className="py-2.5 px-4 text-slate-600">{r.description}</td>
                    <td className="py-2.5 px-4 font-mono text-slate-500">
                      {r.system_role === 0 ? 'Custom' : 'Core'}
                    </td>
                    <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-800">
                      {r.permission_count}
                    </td>
                    {canRoles && (
                      <td className="py-2.5 px-4 text-right whitespace-nowrap space-x-1.5">
                        <button
                          type="button"
                          onClick={() => openRoleModal(r)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-700 border border-slate-200 hover:bg-slate-50 rounded"
                        >
                          <Edit3 className="w-3 h-3" />
                          <span>Rename</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => openEditRolePerms(r)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-teal-800 border border-teal-200 hover:bg-teal-50 rounded"
                        >
                          <Shield className="w-3 h-3" />
                          <span>Permissions</span>
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
                type="button"
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
                        <td className="py-2.5 px-4 text-right font-mono tabular-nums">
                          {settingsForm.currencySymbol || '$'}
                          {price.toFixed(2)}
                        </td>
                        {canEditCatalog && (
                          <td className="py-2.5 px-4 text-right">
                            <button
                              type="button"
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

      {/* Create / Edit Role Metadata Modal */}
      {roleModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-lg max-w-md w-full">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3 className="font-display text-base font-semibold text-slate-900">
                {editingRoleMeta ? `Edit Role · ${editingRoleMeta.code}` : 'Create Custom RBAC Role'}
              </h3>
              <button type="button" onClick={() => setRoleModalOpen(false)} className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleSaveRoleMeta} className="p-6 space-y-4 text-xs">
              {!editingRoleMeta && (
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Role Code (2–10 chars) *</label>
                  <input
                    required
                    minLength={2}
                    maxLength={10}
                    value={roleMetaForm.code}
                    onChange={(e) => setRoleMetaForm({ ...roleMetaForm, code: e.target.value.toUpperCase() })}
                    placeholder="e.g. TRIAGE or AUD_JR"
                    className="w-full px-3 py-2 font-mono border border-slate-300 rounded-md"
                  />
                </div>
              )}
              <div>
                <label className="block font-medium text-slate-700 mb-1">Role Name *</label>
                <input
                  required
                  value={roleMetaForm.name}
                  onChange={(e) => setRoleMetaForm({ ...roleMetaForm, name: e.target.value })}
                  placeholder="e.g. Triage Coordinator"
                  className="w-full px-3 py-2 border border-slate-300 rounded-md"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Duties &amp; Access Boundary</label>
                <textarea
                  rows={3}
                  value={roleMetaForm.description}
                  onChange={(e) => setRoleMetaForm({ ...roleMetaForm, description: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-300 rounded-md"
                />
              </div>
              <div className="pt-3 border-t border-slate-200 flex justify-end gap-2">
                <button type="button" onClick={() => setRoleModalOpen(false)} className="px-4 py-2 border border-slate-300 rounded-md">
                  Cancel
                </button>
                <button type="submit" className="px-4 py-2 font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md">
                  {editingRoleMeta ? 'Save Changes' : 'Create Role'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Role Permissions Matrix Modal */}
      {editPermsRole && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-lg max-w-3xl w-full max-h-[90vh] flex flex-col">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <div>
                <h3 className="font-display text-base font-semibold text-slate-900">
                  Configure RBAC Permissions · {editPermsRole.code} ({editPermsRole.name})
                </h3>
                <div className="text-xs text-slate-500 font-mono tabular-nums">
                  {selectedPermCodes.length} of {allPermissions.length} permissions enabled
                </div>
              </div>
              <button type="button" onClick={() => setEditPermsRole(null)} className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleSaveRolePerms} className="p-6 overflow-y-auto space-y-4 text-xs flex-1">
              {Object.entries(permissionsByModule).map(([mod, perms]) => {
                const modCodes = perms.map((p) => p.code);
                const allModSelected = modCodes.every((c) => selectedPermCodes.includes(c));
                return (
                  <div key={mod} className="border border-slate-200 rounded-md p-3 space-y-2">
                    <div className="flex items-center justify-between border-b border-slate-100 pb-1.5">
                      <span className="font-semibold text-slate-900 uppercase tracking-wide text-[11px]">{mod}</span>
                      <button
                        type="button"
                        onClick={() =>
                          setSelectedPermCodes((prev) =>
                            allModSelected
                              ? prev.filter((c) => !modCodes.includes(c))
                              : [...new Set([...prev, ...modCodes])]
                          )
                        }
                        className="text-[11px] font-medium text-teal-700 hover:text-teal-900"
                      >
                        {allModSelected ? 'Clear Module' : 'Select All'}
                      </button>
                    </div>
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
                );
              })}
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
              <button type="button" onClick={() => setCatalogModalOpen(false)} className="text-slate-400 hover:text-slate-700">
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
