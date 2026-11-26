import React, { useMemo } from 'react';
import { LogOut, X } from 'lucide-react';
import { useAuth } from '../lib/authContext';
import { filterNavigationForUser, type FilteredNavItem } from '../config/navigationConfig';

interface SidebarProps {
  activeNavKey: string;
  activeTab: string;
  mobileNavOpen: boolean;
  onCloseMobile: () => void;
  onSelectItem: (item: FilteredNavItem) => void;
  onLogout: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  activeNavKey,
  activeTab,
  mobileNavOpen,
  onCloseMobile,
  onSelectItem,
  onLogout,
}) => {
  const { user, dialect, roles, permissions, defaultDashboard } = useAuth();

  const navGroups = useMemo(
    () => filterNavigationForUser(permissions, roles, defaultDashboard),
    [permissions, roles, defaultDashboard]
  );

  const flatItems = useMemo(() => navGroups.flatMap((g) => g.items), [navGroups]);
  const activeKeyResolved =
    flatItems.find((i) => i.key === activeNavKey)?.key ||
    flatItems.find((i) => i.tab === activeTab)?.key ||
    flatItems[0]?.key;

  const primaryDept =
    user.departments?.find((d) => d.isPrimary)?.name ||
    user.departmentNames?.[0] ||
    null;

  return (
    <aside
      className={`no-print fixed lg:static inset-y-0 left-0 z-40 w-[248px] bg-white border-r border-slate-200 flex flex-col justify-between transition-transform duration-150 ${
        mobileNavOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
      }`}
    >
      <div className="flex flex-col flex-1 min-h-0">
        <div className="h-14 px-5 border-b border-slate-200 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded bg-teal-700 text-white flex items-center justify-center font-display font-bold text-xs">
              C3
            </div>
            <span className="font-display font-bold text-base tracking-tight text-slate-900 whitespace-nowrap">
              Clinic360
            </span>
          </div>
          <button
            onClick={onCloseMobile}
            className="lg:hidden text-slate-400 hover:text-slate-700"
            aria-label="Close navigation"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <nav className="p-3 space-y-1 overflow-y-auto flex-1" aria-label="Primary Clinic Navigation">
          {navGroups.map((group, groupIdx) => (
            <div key={group.id} className={groupIdx > 0 ? 'pt-2' : undefined}>
              <div className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                {group.title}
              </div>
              <div className="space-y-0.5">
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const isActive = activeKeyResolved === item.key;
                  return (
                    <button
                      key={item.key}
                      type="button"
                      onClick={() => {
                        onSelectItem(item);
                        onCloseMobile();
                      }}
                      className={`w-full flex items-center gap-2.5 px-3 py-2 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                        isActive
                          ? 'bg-teal-50 text-teal-800'
                          : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                      }`}
                    >
                      <Icon className={`w-4 h-4 shrink-0 ${isActive ? 'text-teal-700' : 'text-slate-400'}`} />
                      <span className="truncate">{item.displayLabel}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>
      </div>

      <div className="p-4 border-t border-slate-200 space-y-3">
        <div className="text-xs">
          <div className="font-semibold text-slate-900 truncate">{user.fullName}</div>
          <div className="text-slate-500 mt-0.5 font-mono truncate">
            {user.roles.join(', ')} · {dialect.toUpperCase()}
          </div>
          {primaryDept && (
            <div className="text-[11px] text-slate-500 mt-0.5 truncate">
              {primaryDept}
              {user.clinicUnits && user.clinicUnits.length > 0
                ? ` · ${user.clinicUnits.map((u) => u.roomCode).join(', ')}`
                : ''}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onLogout}
          className="w-full flex items-center justify-center gap-2 px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-200 hover:bg-slate-50 rounded-md whitespace-nowrap"
        >
          <LogOut className="w-3.5 h-3.5 shrink-0" />
          <span>Switch User / Sign Out</span>
        </button>
      </div>
    </aside>
  );
};
