import React from 'react';
import { useAuth } from '../lib/authContext';
import type { DashboardType } from '../types';
import { UnauthorizedView } from './UnauthorizedView';

interface ProtectedRouteProps {
  requiredPermission?: string;
  requiredAnyPermissions?: string[];
  requiredDashboard?: DashboardType;
  attemptedPath?: string;
  onReturnToDashboard: (dashboard: DashboardType) => void;
  children: React.ReactNode;
}

export const ProtectedRoute: React.FC<ProtectedRouteProps> = ({
  requiredPermission,
  requiredAnyPermissions,
  requiredDashboard,
  attemptedPath,
  onReturnToDashboard,
  children,
}) => {
  const { hasPermission, hasAnyPermission, canAccessDashboard } = useAuth();

  let authorized = true;
  const requiredList: string[] = [];

  if (requiredPermission) {
    requiredList.push(requiredPermission);
    if (!hasPermission(requiredPermission)) {
      authorized = false;
    }
  }

  if (authorized && requiredAnyPermissions && requiredAnyPermissions.length > 0) {
    requiredList.push(...requiredAnyPermissions);
    if (!hasAnyPermission(...requiredAnyPermissions)) {
      authorized = false;
    }
  }

  if (authorized && requiredDashboard && !canAccessDashboard(requiredDashboard)) {
    authorized = false;
  }

  if (!authorized) {
    return (
      <UnauthorizedView
        attemptedPath={attemptedPath}
        requiredPermissions={requiredList}
        onReturnToDashboard={onReturnToDashboard}
      />
    );
  }

  return <>{children}</>;
};
