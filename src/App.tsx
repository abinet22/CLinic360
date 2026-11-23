/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  BedDouble,
  Bell,
  BookOpen,
  Briefcase,
  Calendar,
  CreditCard,
  FlaskConical,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Menu,
  Package,
  ShieldCheck,
  Users,
  X,
} from 'lucide-react';
import { apiFetch, getAuthToken, setAuthToken } from './lib/api';
import { resetRealtimeStream, useRealtimeSync } from './lib/useRealtimeSync';
import type { AppNotification, UserContext } from './types';
import { LoginView } from './components/LoginView';
import { DashboardView } from './components/DashboardView';
import { PatientsQueueView } from './components/PatientsQueueView';
import { AppointmentsView } from './components/AppointmentsView';
import { ClinicalOpdView } from './components/ClinicalOpdView';
import { DiagnosticsPharmacyView } from './components/DiagnosticsPharmacyView';
import { InpatientView } from './components/InpatientView';
import { BillingCashierView } from './components/BillingCashierView';
import { AdminAuditView } from './components/AdminAuditView';
import { StoreInventoryView } from './components/StoreInventoryView';
import { AccountingReportsView } from './components/AccountingReportsView';
import { HrPayrollView } from './components/HrPayrollView';

type TabKey =
  | 'dashboard'
  | 'patients'
  | 'appointments'
  | 'clinical'
  | 'diagnostics'
  | 'store'
  | 'ipd'
  | 'billing'
  | 'accounting'
  | 'hr'
  | 'governance';

export default function App() {
  const [user, setUser] = useState<UserContext | null>(null);
  const [dialect, setDialect] = useState<string>('sqlite');
  const [checkingSession, setCheckingSession] = useState(true);
  const [activeTab, setActiveTab] = useState<TabKey>('dashboard');
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

  useEffect(() => {
    const token = getAuthToken();
    if (!token) {
      setCheckingSession(false);
      return;
    }
    apiFetch<{ user?: UserContext; dialect?: string }>('/api/auth/me')
      .then((res) => {
        if (res?.user && Array.isArray(res.user.permissions)) {
          setUser(res.user);
          setDialect(res.dialect || 'sqlite');
        } else {
          setAuthToken(null);
        }
      })
      .catch(() => {
        setAuthToken(null);
      })
      .finally(() => setCheckingSession(false));
  }, []);

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
    resetRealtimeStream();
    setUser(null);
    setNotifications([]);
    setUnreadCount(0);
    setNotifOpen(false);
    setActiveTab('dashboard');
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
          resetRealtimeStream();
          setActiveTab('dashboard');
        }}
      />
    );
  }

  const perms = user.permissions;
  const allNavItems: Array<{ key: TabKey; label: string; icon: React.ComponentType<{ className?: string }>; visible: boolean }> = [
    { key: 'dashboard', label: 'Overview', icon: LayoutDashboard, visible: true },
    { key: 'patients', label: 'Patients & Queue', icon: Users, visible: perms.includes('patient.read') },
    { key: 'appointments', label: 'Appointments', icon: Calendar, visible: perms.includes('appointment.read') },
    {
      key: 'clinical',
      label: 'Triage & OPD',
      icon: Activity,
      visible: perms.includes('visit.read') || perms.includes('vitals.read'),
    },
    {
      key: 'diagnostics',
      label: 'Diagnostics & Rx',
      icon: FlaskConical,
      visible:
        perms.includes('lab.order.read') ||
        perms.includes('imaging.order.read') ||
        perms.includes('pharmacy.prescription.read'),
    },
    {
      key: 'store',
      label: 'Store & FEFO',
      icon: Package,
      visible: perms.includes('store.item.read'),
    },
    {
      key: 'ipd',
      label: 'Inpatient & Beds',
      icon: BedDouble,
      visible: perms.includes('ipd.admission.read'),
    },
    {
      key: 'billing',
      label: 'Cashier & Billing',
      icon: CreditCard,
      visible: perms.includes('billing.invoice.read') || perms.includes('billing.shift.manage'),
    },
    {
      key: 'accounting',
      label: 'Finance & Reports',
      icon: BookOpen,
      visible:
        perms.includes('finance.report.view') ||
        perms.includes('accounting.ledger.manage') ||
        perms.includes('accounting.expense.create'),
    },
    {
      key: 'hr',
      label: 'HR & Payroll',
      icon: Briefcase,
      visible: perms.includes('hr.manage') || perms.includes('hr.leave.request'),
    },
    {
      key: 'governance',
      label: 'Users & Audit Log',
      icon: ShieldCheck,
      visible: perms.includes('audit.read') || perms.includes('admin.user.manage') || perms.includes('admin.role.manage'),
    },
  ];
  const navItems = allNavItems.filter((item) => item.visible);

  const currentNav = navItems.find((i) => i.key === activeTab) || navItems[0];

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

  return (
    <div className="min-h-screen bg-slate-50 flex print-hide-when-modal">
      {/* Mobile Sidebar Backdrop */}
      {mobileNavOpen && (
        <div
          className="fixed inset-0 z-30 bg-slate-900/40 lg:hidden"
          onClick={() => setMobileNavOpen(false)}
        />
      )}

      {/* Left Sidebar (248px) */}
      <aside
        className={`no-print fixed lg:static inset-y-0 left-0 z-40 w-[248px] bg-white border-r border-slate-200 flex flex-col justify-between transition-transform duration-150 ${
          mobileNavOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
        }`}
      >
        <div>
          <div className="h-14 px-5 border-b border-slate-200 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="w-7 h-7 rounded bg-teal-700 text-white flex items-center justify-center font-display font-bold text-xs">
                C3
              </div>
              <span className="font-display font-bold text-base tracking-tight text-slate-900 whitespace-nowrap">
                Clinic360
              </span>
            </div>
            <button onClick={() => setMobileNavOpen(false)} className="lg:hidden text-slate-400">
              <X className="w-5 h-5" />
            </button>
          </div>

          <nav className="p-3 space-y-1">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = activeTab === item.key;
              return (
                <button
                  key={item.key}
                  onClick={() => {
                    setActiveTab(item.key);
                    setMobileNavOpen(false);
                  }}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                    isActive
                      ? 'bg-teal-50 text-teal-800'
                      : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                  }`}
                >
                  <Icon className={`w-4 h-4 shrink-0 ${isActive ? 'text-teal-700' : 'text-slate-400'}`} />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>
        </div>

        {/* Active Staff Footer */}
        <div className="p-4 border-t border-slate-200 space-y-3">
          <div className="text-xs">
            <div className="font-semibold text-slate-900 truncate">{user.fullName}</div>
            <div className="text-slate-500 mt-0.5 font-mono">
              Role: {user.roles.join(', ')} · {dialect.toUpperCase()}
            </div>
          </div>
          <button
            onClick={handleLogout}
            className="w-full flex items-center justify-center gap-2 px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-200 hover:bg-slate-50 rounded-md"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>Switch User / Sign Out</span>
          </button>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top Bar Contract: Breadcrumb Left, Single Action / Context Right */}
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
              <span className="font-semibold text-teal-800 truncate">{currentNav?.label}</span>
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
          {activeTab === 'dashboard' && <DashboardView user={user} onNavigate={(t) => setActiveTab(t as TabKey)} />}
          {activeTab === 'patients' && <PatientsQueueView user={user} onNotify={notify} />}
          {activeTab === 'appointments' && <AppointmentsView user={user} onNotify={notify} />}
          {activeTab === 'clinical' && <ClinicalOpdView user={user} onNotify={notify} />}
          {activeTab === 'diagnostics' && <DiagnosticsPharmacyView user={user} onNotify={notify} />}
          {activeTab === 'store' && <StoreInventoryView user={user} onNotify={notify} />}
          {activeTab === 'ipd' && <InpatientView user={user} onNotify={notify} />}
          {activeTab === 'billing' && <BillingCashierView user={user} onNotify={notify} />}
          {activeTab === 'accounting' && <AccountingReportsView user={user} onNotify={notify} />}
          {activeTab === 'hr' && <HrPayrollView user={user} onNotify={notify} />}
          {activeTab === 'governance' && <AdminAuditView user={user} onNotify={notify} />}
        </main>
      </div>
    </div>
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
