import React, { createContext, useCallback, useContext, useMemo } from 'react';
import type { DashboardType, UserContext } from '../types';

export interface AuthContextValue {
  user: UserContext;
  dialect: string;
  roles: string[];
  permissions: string[];
  defaultDashboard: DashboardType;
  availableDashboards: DashboardType[];
  hasPermission: (perm: string) => boolean;
  hasAnyPermission: (...perms: string[]) => boolean;
  canAccessDashboard: (dashboard: DashboardType) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function deriveAuthorizedDashboards(user: UserContext): DashboardType[] {
  if (Array.isArray(user.authorizedDashboards) && user.authorizedDashboards.length > 0) {
    return user.authorizedDashboards;
  }
  const roleSet = new Set(user.roles || []);
  const permSet = new Set(user.permissions || []);
  const out: DashboardType[] = [];

  if (roleSet.has('ADM') || permSet.has('admin.user.manage')) out.push('admin');
  if (roleSet.has('DOC') || (permSet.has('visit.read') && permSet.has('prescription.create'))) out.push('doctor');
  if (roleSet.has('NUR') || roleSet.has('WRD') || permSet.has('vitals.create') || permSet.has('ipd.mar.give')) out.push('nurse');
  if (roleSet.has('CSH') || roleSet.has('REC') || permSet.has('billing.payment.create') || permSet.has('billing.shift.manage')) out.push('cashier');
  if (roleSet.has('LAB') || permSet.has('lab.sample.collect') || permSet.has('lab.result.enter')) out.push('lab');
  if (roleSet.has('IMG') || permSet.has('imaging.exam.perform') || permSet.has('imaging.report.finalise')) out.push('radiology');
  if (roleSet.has('PHA') || roleSet.has('STO') || permSet.has('pharmacy.dispense')) out.push('pharmacy');
  if (roleSet.has('HRO') || permSet.has('hr.manage')) out.push('hr');
  if (roleSet.has('ACC') || permSet.has('accounting.ledger.manage')) out.push('accounting');
  if (roleSet.has('MGR') || roleSet.has('AUD') || out.length === 0) out.push('general');

  return Array.from(new Set(out));
}

function deriveDefaultDashboard(user: UserContext, authorized: DashboardType[]): DashboardType {
  if (user.defaultDashboard) return user.defaultDashboard;
  return authorized[0] || 'general';
}

export const AuthProvider: React.FC<{
  user: UserContext;
  dialect: string;
  children: React.ReactNode;
}> = ({ user, dialect, children }) => {
  const permissions = useMemo(() => user.permissions || [], [user.permissions]);
  const roles = useMemo(() => user.roles || [], [user.roles]);
  const permissionSet = useMemo(() => new Set(permissions), [permissions]);
  const availableDashboards = useMemo(() => deriveAuthorizedDashboards(user), [user]);
  const defaultDashboard = useMemo(() => deriveDefaultDashboard(user, availableDashboards), [user, availableDashboards]);

  const hasPermission = useCallback(
    (perm: string) => permissionSet.has(perm),
    [permissionSet]
  );

  const hasAnyPermission = useCallback(
    (...perms: string[]) => {
      if (perms.length === 0) return true;
      return perms.some((p) => permissionSet.has(p));
    },
    [permissionSet]
  );

  const canAccessDashboard = useCallback(
    (dashboard: DashboardType) => availableDashboards.includes(dashboard),
    [availableDashboards]
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      dialect,
      roles,
      permissions,
      defaultDashboard,
      availableDashboards,
      hasPermission,
      hasAnyPermission,
      canAccessDashboard,
    }),
    [user, dialect, roles, permissions, defaultDashboard, availableDashboards, hasPermission, hasAnyPermission, canAccessDashboard]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used inside <AuthProvider>');
  }
  return ctx;
}
