import React from 'react';
import { useAuth } from '../lib/authContext';
import { DASHBOARD_METADATA } from '../config/navigationConfig';
import type { DashboardType } from '../types';
import { ProtectedRoute } from './ProtectedRoute';
import { DashboardView } from './DashboardView';
import { AdminDashboard } from './dashboards/AdminDashboard';
import { DoctorDashboard } from './dashboards/DoctorDashboard';
import { NurseDashboard } from './dashboards/NurseDashboard';
import { CashierDashboard } from './dashboards/CashierDashboard';
import { LabDashboard } from './dashboards/LabDashboard';
import { RadiologyDashboard } from './dashboards/RadiologyDashboard';
import { PharmacyDashboard } from './dashboards/PharmacyDashboard';
import { HrDashboard } from './dashboards/HrDashboard';

interface DashboardRouterProps {
  activeDashboard?: DashboardType;
  onSelectDashboard: (dashboard: DashboardType) => void;
  onNavigate: (tab: string, subView?: string) => void;
}

export const DashboardRouter: React.FC<DashboardRouterProps> = ({
  activeDashboard,
  onSelectDashboard,
  onNavigate,
}) => {
  const { user, defaultDashboard, availableDashboards } = useAuth();
  const targetDashboard: DashboardType = activeDashboard || defaultDashboard;

  function renderDashboardBody() {
    switch (targetDashboard) {
      case 'admin':
        return <AdminDashboard onNavigate={onNavigate} />;
      case 'doctor':
        return <DoctorDashboard onNavigate={onNavigate} />;
      case 'nurse':
        return <NurseDashboard onNavigate={onNavigate} />;
      case 'cashier':
        return <CashierDashboard onNavigate={onNavigate} />;
      case 'lab':
        return <LabDashboard onNavigate={onNavigate} />;
      case 'radiology':
        return <RadiologyDashboard onNavigate={onNavigate} />;
      case 'pharmacy':
        return <PharmacyDashboard onNavigate={onNavigate} />;
      case 'hr':
        return <HrDashboard onNavigate={onNavigate} />;
      case 'accounting':
      case 'general':
      default:
        return <DashboardView user={user} onNavigate={onNavigate} />;
    }
  }

  return (
    <ProtectedRoute
      requiredDashboard={targetDashboard}
      attemptedPath={DASHBOARD_METADATA[targetDashboard]?.path || '/dashboard'}
      onReturnToDashboard={onSelectDashboard}
    >
      <div className="space-y-5">
        {availableDashboards.length > 1 && (
          <div className="bg-white border border-slate-200 rounded-lg px-4 py-2.5 flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-medium text-slate-500">
              Authorized Role Workspaces
            </span>
            <div className="flex flex-wrap items-center gap-1.5">
              {availableDashboards.map((dash) => {
                const active = dash === targetDashboard;
                const meta = DASHBOARD_METADATA[dash];
                return (
                  <button
                    key={dash}
                    type="button"
                    onClick={() => onSelectDashboard(dash)}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                      active
                        ? 'bg-teal-700 text-white'
                        : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 border border-slate-200'
                    }`}
                  >
                    {meta?.shortLabel || dash}
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {renderDashboardBody()}
      </div>
    </ProtectedRoute>
  );
};
