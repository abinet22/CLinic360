import React from 'react';
import { ArrowLeft, ShieldAlert } from 'lucide-react';
import { useAuth } from '../lib/authContext';
import { DASHBOARD_METADATA } from '../config/navigationConfig';
import type { DashboardType } from '../types';

interface UnauthorizedViewProps {
  attemptedPath?: string;
  requiredPermissions?: string[];
  onReturnToDashboard: (dashboard: DashboardType) => void;
}

export const UnauthorizedView: React.FC<UnauthorizedViewProps> = ({
  attemptedPath,
  requiredPermissions,
  onReturnToDashboard,
}) => {
  const { user, defaultDashboard } = useAuth();
  const homeMeta = DASHBOARD_METADATA[defaultDashboard] || DASHBOARD_METADATA.general;

  return (
    <div className="py-12 flex items-center justify-center">
      <div className="max-w-lg w-full bg-white border border-slate-200 rounded-lg p-7 space-y-5">
        <div className="flex items-start gap-3.5">
          <div className="w-10 h-10 rounded-md bg-red-50 border border-red-200 text-red-700 flex items-center justify-center shrink-0">
            <ShieldAlert className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <h1 className="font-display text-lg font-bold text-slate-900">Access Denied (403)</h1>
            <p className="text-xs text-slate-600 mt-1 leading-relaxed">
              Your account ({user.fullName} · {user.roles.join(', ')}) does not hold the authorization required to open this view.
            </p>
          </div>
        </div>

        {(attemptedPath || (requiredPermissions && requiredPermissions.length > 0)) && (
          <div className="border-t border-b border-slate-200 py-3 space-y-1.5 text-xs text-slate-600">
            {attemptedPath && (
              <div className="flex items-center justify-between gap-2">
                <span className="text-slate-500">Requested Route</span>
                <span className="font-mono text-slate-900 truncate">{attemptedPath}</span>
              </div>
            )}
            {requiredPermissions && requiredPermissions.length > 0 && (
              <div className="flex items-center justify-between gap-2">
                <span className="text-slate-500">Required Permission</span>
                <span className="font-mono text-slate-900 truncate">{requiredPermissions.join(' or ')}</span>
              </div>
            )}
          </div>
        )}

        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-slate-500">
            Assigned Workspace: <span className="font-medium text-slate-700">{homeMeta.label}</span>
          </span>
          <button
            type="button"
            onClick={() => onReturnToDashboard(defaultDashboard)}
            className="inline-flex items-center gap-2 px-4 py-2 bg-teal-700 hover:bg-teal-800 text-white text-xs font-medium rounded-md whitespace-nowrap shrink-0"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Return to My Dashboard</span>
          </button>
        </div>
      </div>
    </div>
  );
};
