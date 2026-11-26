/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Bell, KeyRound, Menu, X } from 'lucide-react';
import { apiFetch, setAuthToken } from './lib/api';
import { AuthProvider } from './lib/authContext';
import { resetRealtimeStream, setRealtimeAuthenticated, useRealtimeSync } from './lib/useRealtimeSync';
import type { AppNotification, ClinicUnitInfo, DashboardType, DepartmentInfo, UserContext } from './types';
import {
  buildPathForRoute,
  DASHBOARD_METADATA,
  filterNavigationForUser,
  getRequiredPermissionsForRoute,
  resolvePathToState,
  type FilteredNavItem,
  type TabKey,
} from './config/navigationConfig';
import { LoginView } from './components/LoginView';
import { Sidebar } from './components/Sidebar';
import { DashboardRouter } from './components/DashboardRouter';
import { ProtectedRoute } from './components/ProtectedRoute';
import { UnauthorizedView } from './components/UnauthorizedView';
import { PatientsQueueView } from './components/PatientsQueueView';
import { AppointmentsView } from './components/AppointmentsView';
import { ClinicalOpdView } from './components/ClinicalOpdView';
import { DiagnosticsPharmacyView } from './components/DiagnosticsPharmacyView';
import { InpatientView } from './components/InpatientView';
import { BillingCashierView } from './components/BillingCashierView';
import { AdminAuditView, type AdminTab } from './components/AdminAuditView';
import { StoreInventoryView } from './components/StoreInventoryView';
import { AccountingReportsView } from './components/AccountingReportsView';
import { HrPayrollView } from './components/HrPayrollView';

interface AuthPayload {
  user?: UserContext;
  roles?: string[];
  permissions?: string[];
  departments?: DepartmentInfo[];
  clinic_units?: ClinicUnitInfo[];
  dashboard_type?: DashboardType;
  defaultDashboard?: DashboardType;
  authorizedDashboards?: DashboardType[];
  dialect?: string;
}

function normalizeUserContext(res: AuthPayload): UserContext | null {
  if (!res.user || !Array.isArray(res.user.permissions)) return null;
  return {
    ...res.user,
    roles: res.roles ?? res.user.roles,
    permissions: res.permissions ?? res.user.permissions,
    departments: res.departments ?? res.user.departments,
    clinicUnits: res.clinic_units ?? res.user.clinicUnits,
    defaultDashboard: res.defaultDashboard ?? res.dashboard_type ?? res.user.defaultDashboard,
    authorizedDashboards: res.authorizedDashboards ?? res.user.authorizedDashboards,
  };
}

export default function App() {
  const [user, setUser] = useState<UserContext | null>(null);
  const [dialect, setDialect] = useState<string>('sqlite');
  const [checkingSession, setCheckingSession] = useState(true);
  const [activeTab, setActiveTab] = useState<TabKey>('dashboard');
  const [activeSubView, setActiveSubView] = useState<string | undefined>(undefined);
  const [activeDashboard, setActiveDashboard] = useState<DashboardType | undefined>(undefined);
  const [activeNavKey, setActiveNavKey] = useState<string>('dashboard');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [notifOpen, setNotifOpen] = useState(false);

  const notify = useCallback((msg: string, type: 'success' | 'error' = 'success') => {
    setToast({ msg, type });
    setTimeout(() => {
      setToast((prev) => (prev?.msg === msg ? null : prev));
    }, 4200);
  }, []);

  const loadNotifications = useCallback(async () => {
    try {
      const res = await apiFetch<{ notifications?: AppNotification[]; unreadCount?: number }>('/api/notifications');
      setNotifications(Array.isArray(res?.notifications) ? res.notifications : []);
      setUnreadCount(typeof res?.unreadCount === 'number' ? res.unreadCount : 0);
    } catch {
      // ignore on unauthenticated state
    }
  }, []);

  const syncRouteFromLocation = useCallback((ctx: UserContext) => {
    const defDash: DashboardType = ctx.defaultDashboard || 'general';
    const currentPath = typeof window !== 'undefined' ? window.location.pathname : '/';
    const resolved = resolvePathToState(currentPath, defDash);
    setActiveTab(resolved.tab);
    setActiveSubView(resolved.subView);
    setActiveDashboard(resolved.dashboardType);
    if (resolved.navKey) {
      setActiveNavKey(resolved.navKey);
    }
    if (typeof window !== 'undefined' && (currentPath === '/' || currentPath === '/dashboard')) {
      const targetPath = DASHBOARD_METADATA[defDash]?.path || '/dashboard';
      window.history.replaceState(null, '', targetPath);
    }
  }, []);

  useEffect(() => {
    apiFetch<AuthPayload>('/api/auth/me')
      .then((res) => {
        const normalized = normalizeUserContext(res);
        if (normalized) {
          setUser(normalized);
          setDialect(res.dialect || 'sqlite');
          setRealtimeAuthenticated(true);
          syncRouteFromLocation(normalized);
        } else {
          setAuthToken(null);
          setRealtimeAuthenticated(false);
        }
      })
      .catch(() => {
        setAuthToken(null);
        setRealtimeAuthenticated(false);
      })
      .finally(() => setCheckingSession(false));
  }, [syncRouteFromLocation]);

  useEffect(() => {
    if (!user) return;
    const handlePopState = () => {
      syncRouteFromLocation(user);
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [user, syncRouteFromLocation]);

  useEffect(() => {
    if (user) {
      loadNotifications();
    }
  }, [user, activeTab, loadNotifications]);

  useRealtimeSync(
    ['notification:created'],
    () => {
      loadNotifications();
    },
    Boolean(user)
  );

  async function markNotificationRead(id: number) {
    await apiFetch(`/api/notifications/${id}/read`, { method: 'POST' }).catch(() => {});
    loadNotifications();
  }

  async function markAllNotificationsRead() {
    await apiFetch('/api/notifications/read-all', { method: 'POST' }).catch(() => {});
    loadNotifications();
  }

  async function handleLogout() {
    await apiFetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    setAuthToken(null);
    resetRealtimeStream(false);
    setUser(null);
    setNotifications([]);
    setUnreadCount(0);
    setNotifOpen(false);
    setActiveTab('dashboard');
    setActiveSubView(undefined);
    setActiveDashboard(undefined);
    setActiveNavKey('dashboard');
    if (typeof window !== 'undefined') {
      window.history.replaceState(null, '', '/');
    }
  }

  if (checkingSession) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center text-sm text-slate-500">
        Verifying Clinic360 session...
      </div>
    );
  }

  if (!user) {
    return (
      <LoginView
        onSuccess={(u, d) => {
          setUser(u);
          setDialect(d);
          resetRealtimeStream(true);
          const defDash: DashboardType = u.defaultDashboard || 'general';
          setActiveTab('dashboard');
          setActiveSubView(undefined);
          setActiveDashboard(defDash);
          setActiveNavKey('dashboard');
          if (typeof window !== 'undefined') {
            window.history.pushState(null, '', DASHBOARD_METADATA[defDash]?.path || '/dashboard');
          }
        }}
      />
    );
  }

  const defaultDashboard: DashboardType = user.defaultDashboard || 'general';
  const navGroups = filterNavigationForUser(user.permissions, user.roles, defaultDashboard);
  const flatNavItems = navGroups.flatMap((g) => g.items);
  const currentNav =
    flatNavItems.find((i) => i.key === activeNavKey) ||
    flatNavItems.find((i) => i.tab === activeTab) ||
    flatNavItems[0];

  function pushRoutePath(path: string) {
    if (typeof window !== 'undefined' && window.location.pathname !== path) {
      window.history.pushState(null, '', path);
    }
  }

  function handleSelectNavItem(item: FilteredNavItem) {
    setActiveTab(item.tab);
    setActiveSubView(item.subView);
    setActiveDashboard(item.tab === 'dashboard' ? item.dashboardType || defaultDashboard : undefined);
    setActiveNavKey(item.key);
    pushRoutePath(item.path);
  }

  function handleSelectDashboard(dashboard: DashboardType) {
    setActiveTab('dashboard');
    setActiveSubView(undefined);
    setActiveDashboard(dashboard);
    setActiveNavKey('dashboard');
    pushRoutePath(DASHBOARD_METADATA[dashboard]?.path || '/dashboard');
  }

  function handleNavigate(tab: string, subView?: string) {
    const targetTab = tab as TabKey;
    if (targetTab === 'dashboard') {
      handleSelectDashboard(defaultDashboard);
      setMobileNavOpen(false);
      return;
    }
    const match =
      flatNavItems.find((i) => i.tab === targetTab && (!subView || i.subView === subView)) ||
      flatNavItems.find((i) => i.tab === targetTab);
    setActiveTab(targetTab);
    setActiveSubView(subView ?? match?.subView);
    setActiveDashboard(undefined);
    if (match) {
      setActiveNavKey(match.key);
    }
    pushRoutePath(buildPathForRoute(targetTab, subView ?? match?.subView));
    setMobileNavOpen(false);
  }

  if (user.mustChangePassword) {
    return (
      <ForcePasswordChangeGate
        user={user}
        onUpdated={(updated) => {
          setUser(updated);
          notify('Password updated. Welcome to Clinic360.');
        }}
        onLogout={handleLogout}
      />
    );
  }

  const activeRequiredPerms = getRequiredPermissionsForRoute(activeTab, activeSubView);
  const breadcrumbTitle =
    activeTab === 'unauthorized'
      ? 'Access Denied'
      : activeTab === 'dashboard'
        ? DASHBOARD_METADATA[activeDashboard || defaultDashboard]?.label || 'Dashboard'
        : currentNav?.displayLabel || 'Workspace';

  return (
    <AuthProvider user={user} dialect={dialect}>
      <div className="min-h-screen bg-slate-50 flex print-hide-when-modal">
        {mobileNavOpen && (
          <div
            className="fixed inset-0 z-30 bg-slate-900/40 lg:hidden"
            onClick={() => setMobileNavOpen(false)}
          />
        )}

        <Sidebar
          activeNavKey={activeNavKey}
          activeTab={activeTab}
          mobileNavOpen={mobileNavOpen}
          onCloseMobile={() => setMobileNavOpen(false)}
          onSelectItem={handleSelectNavItem}
          onLogout={handleLogout}
        />

        <div className="flex-1 flex flex-col min-w-0">
          <header className="no-print h-14 bg-white border-b border-slate-200 px-5 lg:px-8 flex items-center justify-between gap-4">
            <div className="flex items-center gap-3 min-w-0">
              <button
                onClick={() => setMobileNavOpen(true)}
                className="lg:hidden p-1.5 text-slate-600 hover:text-slate-900"
                aria-label="Open menu"
              >
                <Menu className="w-5 h-5" />
              </button>
              <div className="text-xs text-slate-500 flex items-center gap-2 truncate">
                <span className="font-medium text-slate-900">Clinic360 Central</span>
                <span aria-hidden="true">/</span>
                <span className="font-semibold text-teal-800 truncate">{breadcrumbTitle}</span>
              </div>
            </div>

          <div className="flex items-center gap-3 shrink-0 relative">
            <span className="hidden sm:inline text-xs text-slate-500 font-mono">
              {user.roles.join(' · ')}
            </span>

            <button
              onClick={() => {
                setNotifOpen((prev) => !prev);
                if (!notifOpen) loadNotifications();
              }}
              aria-label="Notifications"
              className="relative inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-700 border border-slate-200 hover:bg-slate-50 rounded-md"
            >
              <Bell className="w-3.5 h-3.5" />
              <span className="font-mono tabular-nums">{unreadCount}</span>
            </button>

            {notifOpen && (
              <div className="absolute right-0 top-11 z-50 w-80 bg-white border border-slate-200 rounded-lg shadow-lg overflow-hidden">
                <div className="px-4 py-2.5 border-b border-slate-200 flex items-center justify-between bg-slate-50">
                  <span className="text-xs font-semibold text-slate-900">Role Notifications</span>
                  <button
                    onClick={markAllNotificationsRead}
                    className="text-xs font-medium text-teal-700 hover:text-teal-800"
                  >
                    Mark all read
                  </button>
                </div>
                <div className="max-h-80 overflow-y-auto divide-y divide-slate-100">
                  {notifications.length === 0 ? (
                    <div className="p-4 text-xs text-slate-500 text-center">No notifications for your role.</div>
                  ) : (
                    notifications.map((n) => (
                      <button
                        key={n.id}
                        onClick={() => markNotificationRead(n.id)}
                        className={`w-full text-left px-4 py-3 text-xs hover:bg-slate-50 ${
                          n.is_read ? 'opacity-65' : 'bg-teal-50/30'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span
                            className={`font-semibold ${
                              n.severity === 'critical'
                                ? 'text-red-700'
                                : n.severity === 'warning'
                                  ? 'text-amber-700'
                                  : 'text-slate-900'
                            }`}
                          >
                            {n.title}
                          </span>
                          <span className="font-mono text-[11px] text-slate-400">
                            {n.is_read ? 'Read' : 'New'}
                          </span>
                        </div>
                        <div className="text-slate-600 mt-0.5">{n.message}</div>
                      </button>
                    ))
                  )}
                </div>
              </div>
            )}

            <button
              onClick={handleLogout}
              className="px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-200 hover:bg-slate-50 rounded-md whitespace-nowrap"
            >
              Sign Out
            </button>
          </div>
        </header>

        {/* Toast Feedback */}
        {toast && (
          <div className="no-print px-5 lg:px-8 pt-4">
            <div
              className={`px-4 py-2.5 rounded-md border text-xs font-medium flex items-center justify-between ${
                toast.type === 'error'
                  ? 'bg-red-50 border-red-200 text-red-800'
                  : 'bg-emerald-50 border-emerald-200 text-emerald-900'
              }`}
            >
              <span>{toast.msg}</span>
              <button onClick={() => setToast(null)} className="ml-4 opacity-60 hover:opacity-100">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}

        <main className="flex-1 p-5 lg:p-8 max-w-[1440px] w-full mx-auto">
          {activeTab === 'dashboard' && (
            <DashboardRouter
              activeDashboard={activeDashboard}
              onSelectDashboard={handleSelectDashboard}
              onNavigate={handleNavigate}
            />
          )}
          {activeTab === 'unauthorized' && (
            <UnauthorizedView
              attemptedPath={typeof window !== 'undefined' ? window.location.pathname : '/unauthorized'}
              onReturnToDashboard={handleSelectDashboard}
            />
          )}
          {activeTab !== 'dashboard' && activeTab !== 'unauthorized' && (
            <ProtectedRoute
              requiredAnyPermissions={activeRequiredPerms}
              attemptedPath={typeof window !== 'undefined' ? window.location.pathname : undefined}
              onReturnToDashboard={handleSelectDashboard}
            >
              {activeTab === 'patients' && (
                <PatientsQueueView
                  user={user}
                  onNotify={notify}
                  initialSubTab={
                    activeSubView === 'register' ||
                    activeSubView === 'visits' ||
                    activeSubView === 'assign_doctor' ||
                    activeSubView === 'queue'
                      ? activeSubView
                      : 'patients'
                  }
                />
              )}
              {activeTab === 'appointments' && <AppointmentsView user={user} onNotify={notify} />}
              {activeTab === 'clinical' && (
                <ClinicalOpdView
                  user={user}
                  onNotify={notify}
                  initialSection={
                    activeSubView === 'vitals_only' ||
                    activeSubView === 'consultations' ||
                    activeSubView === 'prescriptions' ||
                    activeSubView === 'lab_requests' ||
                    activeSubView === 'reports'
                      ? activeSubView
                      : 'all'
                  }
                />
              )}
              {activeTab === 'diagnostics' && (
                <DiagnosticsPharmacyView
                  user={user}
                  onNotify={notify}
                  initialTab={
                    activeSubView === 'lab' || activeSubView === 'imaging' || activeSubView === 'pharmacy'
                      ? activeSubView
                      : undefined
                  }
                />
              )}
              {activeTab === 'store' && <StoreInventoryView user={user} onNotify={notify} />}
              {activeTab === 'ipd' && <InpatientView user={user} onNotify={notify} />}
              {activeTab === 'billing' && (
                <BillingCashierView
                  user={user}
                  onNotify={notify}
                  initialSubTab={
                    activeSubView === 'payments' ||
                    activeSubView === 'deposits' ||
                    activeSubView === 'approvals' ||
                    activeSubView === 'bypasses' ||
                    activeSubView === 'shifts' ||
                    activeSubView === 'reports'
                      ? activeSubView
                      : 'invoices'
                  }
                />
              )}
              {activeTab === 'accounting' && <AccountingReportsView user={user} onNotify={notify} />}
              {activeTab === 'hr' && (
                <HrPayrollView
                  user={user}
                  onNotify={notify}
                  initialSubTab={activeSubView === 'payroll' ? 'payroll' : undefined}
                />
              )}
              {activeTab === 'governance' && (
                <AdminAuditView
                  user={user}
                  initialTab={activeSubView as AdminTab | undefined}
                  onNotify={notify}
                />
              )}
            </ProtectedRoute>
          )}
        </main>
        </div>
      </div>
    </AuthProvider>
  );
}

function ForcePasswordChangeGate({
  user,
  onUpdated,
  onLogout,
}: {
  user: UserContext;
  onUpdated: (u: UserContext) => void;
  onLogout: () => void;
}) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (newPassword.length < 8) {
      setError('New password must be at least 8 characters long.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('New password and confirmation do not match.');
      return;
    }
    setSaving(true);
    try {
      const res = await apiFetch<{ ok: boolean; user: UserContext }>('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      if (res.user) {
        onUpdated(res.user);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <div className="bg-white border border-slate-200 rounded-lg max-w-md w-full p-7 space-y-5">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-md bg-teal-700 text-white flex items-center justify-center">
            <KeyRound className="w-4 h-4" />
          </div>
          <div>
            <h1 className="font-display text-lg font-semibold text-slate-900">Password Change Required</h1>
            <p className="text-xs text-slate-500">
              {user.fullName} ({user.email})
            </p>
          </div>
        </div>
        <p className="text-xs text-slate-600 leading-relaxed">
          Security policy requires replacing your administrator-issued temporary password before accessing clinical or financial records.
        </p>
        {error && <div className="p-3 bg-red-50 border border-red-200 rounded-md text-xs text-red-800">{error}</div>}
        <form onSubmit={handleSubmit} className="space-y-3 text-xs">
          <div>
            <label className="block font-medium text-slate-700 mb-1">Temporary / Current Password</label>
            <input
              type="password"
              required
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-md font-mono"
            />
          </div>
          <div>
            <label className="block font-medium text-slate-700 mb-1">New Password (min 8 chars)</label>
            <input
              type="password"
              required
              minLength={8}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-md font-mono"
            />
          </div>
          <div>
            <label className="block font-medium text-slate-700 mb-1">Confirm New Password</label>
            <input
              type="password"
              required
              minLength={8}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-md font-mono"
            />
          </div>
          <div className="flex items-center justify-between pt-2">
            <button type="button" onClick={onLogout} className="text-xs text-slate-500 hover:text-slate-800">
              Sign out
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 bg-teal-700 hover:bg-teal-800 text-white rounded-md font-medium disabled:opacity-60"
            >
              {saving ? 'Updating...' : 'Save New Password'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
