import type React from 'react';
import {
  Activity,
  BedDouble,
  BookOpen,
  Briefcase,
  Building2,
  Calendar,
  CreditCard,
  Database,
  FlaskConical,
  LayoutDashboard,
  Lock,
  Package,
  Pill,
  Scan,
  Settings,
  Shield,
  ShieldCheck,
  Stethoscope,
  UserCheck,
  UserPlus,
  Users,
} from 'lucide-react';
import type { DashboardType } from '../types';

export type TabKey =
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
  | 'governance'
  | 'unauthorized';

export interface NavChildItem {
  key: string;
  tab: Exclude<TabKey, 'unauthorized'>;
  subView?: string;
  dashboardType?: DashboardType;
  path: string;
  label: string;
  docLabel?: string;
  cashierLabel?: string;
  nurseLabel?: string;
  icon: React.ComponentType<{ className?: string }>;
  requiredAnyPermissions: string[];
}

export interface NavModuleGroup {
  id: string;
  title: string;
  items: NavChildItem[];
}

export const DASHBOARD_METADATA: Record<
  DashboardType,
  { label: string; shortLabel: string; path: string; description: string }
> = {
  admin: {
    label: 'System Administration Dashboard',
    shortLabel: 'Admin',
    path: '/dashboard/admin',
    description: 'User accounts, HR-employee access review, audit integrity, and clinic configuration.',
  },
  doctor: {
    label: 'Physician Clinical Dashboard',
    shortLabel: 'Doctor',
    path: '/dashboard/doctor',
    description: 'Assigned patient queue, consultation status, appointments, and diagnostic results.',
  },
  nurse: {
    label: 'Nursing & Triage Station',
    shortLabel: 'Nursing',
    path: '/dashboard/nurse',
    description: 'Triage vital signs queue, abnormal clinical alerts, nursing procedures, and ward beds.',
  },
  cashier: {
    label: 'Cashier & Billing Desk',
    shortLabel: 'Cashier',
    path: '/dashboard/cashier',
    description: 'Shift cash drawer, pending invoices, daily collections, and receipt reconciliation.',
  },
  lab: {
    label: 'Clinical Laboratory Workspace',
    shortLabel: 'Laboratory',
    path: '/dashboard/lab',
    description: 'Sample collection queue, result entry, verification backlog, and critical alerts.',
  },
  radiology: {
    label: 'Radiology & Imaging Workspace',
    shortLabel: 'Radiology',
    path: '/dashboard/radiology',
    description: 'Modality exam schedule, performed studies awaiting reporting, and finalised reports.',
  },
  pharmacy: {
    label: 'Pharmacy & Dispensary',
    shortLabel: 'Pharmacy',
    path: '/dashboard/pharmacy',
    description: 'Paid prescriptions ready to dispense, low-stock reorder alerts, and expiring batches.',
  },
  hr: {
    label: 'Human Resources Workspace',
    shortLabel: 'HR',
    path: '/dashboard/hr',
    description: 'Staff attendance, pending leave & overtime approvals, and payroll readiness.',
  },
  accounting: {
    label: 'Finance & Executive Ledger',
    shortLabel: 'Accounting',
    path: '/dashboard/accounting',
    description: 'Financial snapshot, invoiced revenue vs. expenses, and cash-on-hand balances.',
  },
  general: {
    label: 'Clinic Operations Overview',
    shortLabel: 'Executive',
    path: '/dashboard/general',
    description: 'Cross-department clinical activity, operational queues, and financial snapshot.',
  },
};

export const NAVIGATION_MODULES: NavModuleGroup[] = [
  {
    id: 'workspace',
    title: 'Workspace',
    items: [
      {
        key: 'dashboard',
        tab: 'dashboard',
        path: '/dashboard',
        label: 'Role Dashboard',
        icon: LayoutDashboard,
        requiredAnyPermissions: [],
      },
    ],
  },
  {
    id: 'front-desk',
    title: 'Patients & Front Desk',
    items: [
      {
        key: 'patients-all',
        tab: 'patients',
        subView: 'patients',
        path: '/patients',
        label: 'Patients & Queue',
        docLabel: 'My Patients',
        cashierLabel: 'All Patients',
        icon: Users,
        requiredAnyPermissions: ['patient.read'],
      },
      {
        key: 'patients-register',
        tab: 'patients',
        subView: 'register',
        path: '/patients/register',
        label: 'Patient Registration',
        icon: UserPlus,
        requiredAnyPermissions: ['patient.create'],
      },
      {
        key: 'patients-visits',
        tab: 'patients',
        subView: 'visits',
        path: '/patients/visits',
        label: 'Visits & Queue Control',
        icon: UserCheck,
        requiredAnyPermissions: ['visit.create', 'queue.manage'],
      },
      {
        key: 'patients-assign-doctor',
        tab: 'patients',
        subView: 'assign_doctor',
        path: '/patients/assign-doctor',
        label: 'OPD Doctor Assignment',
        icon: Stethoscope,
        requiredAnyPermissions: ['visit.assign_doctor'],
      },
      {
        key: 'appointments',
        tab: 'appointments',
        path: '/appointments',
        label: 'Appointments',
        docLabel: 'My Appointments',
        icon: Calendar,
        requiredAnyPermissions: ['appointment.read'],
      },
    ],
  },
  {
    id: 'clinical-opd',
    title: 'Clinical & Nursing Care',
    items: [
      {
        key: 'clinical-vitals',
        tab: 'clinical',
        subView: 'vitals_only',
        path: '/clinical/vitals',
        label: 'Vital Signs & Triage',
        docLabel: 'Patient Vital Signs',
        cashierLabel: 'Vital Registration',
        icon: Activity,
        requiredAnyPermissions: ['vitals.create', 'vitals.read'],
      },
      {
        key: 'clinical-consultations',
        tab: 'clinical',
        subView: 'consultations',
        path: '/clinical/consultations',
        label: 'OPD Consultations',
        nurseLabel: 'Nursing Procedures',
        icon: Stethoscope,
        requiredAnyPermissions: ['visit.read'],
      },
      {
        key: 'clinical-prescriptions',
        tab: 'clinical',
        subView: 'prescriptions',
        path: '/clinical/prescriptions',
        label: 'Prescriptions',
        icon: Pill,
        requiredAnyPermissions: ['prescription.create'],
      },
      {
        key: 'clinical-lab-requests',
        tab: 'clinical',
        subView: 'lab_requests',
        path: '/clinical/lab-requests',
        label: 'Order Diagnostics',
        icon: FlaskConical,
        requiredAnyPermissions: ['order.lab.create', 'order.imaging.create'],
      },
      {
        key: 'clinical-reports',
        tab: 'clinical',
        subView: 'reports',
        path: '/clinical/reports',
        label: 'Clinical Reports',
        docLabel: 'My Clinical Reports',
        icon: BookOpen,
        requiredAnyPermissions: ['consultation.write', 'visit.read'],
      },
      {
        key: 'ipd',
        tab: 'ipd',
        path: '/ipd',
        label: 'Inpatient & Beds',
        icon: BedDouble,
        requiredAnyPermissions: ['ipd.admission.read', 'ipd.bed.assign', 'ipd.mar.give'],
      },
    ],
  },
  {
    id: 'diagnostics-pharmacy',
    title: 'Diagnostics & Pharmacy',
    items: [
      {
        key: 'diag-lab',
        tab: 'diagnostics',
        subView: 'lab',
        path: '/diagnostics/lab',
        label: 'Laboratory Worklist',
        icon: FlaskConical,
        requiredAnyPermissions: ['lab.order.read', 'lab.sample.collect', 'lab.result.enter', 'lab.result.verify'],
      },
      {
        key: 'diag-imaging',
        tab: 'diagnostics',
        subView: 'imaging',
        path: '/diagnostics/imaging',
        label: 'Radiology & Imaging',
        icon: Scan,
        requiredAnyPermissions: ['imaging.order.read', 'imaging.exam.perform', 'imaging.report.finalise'],
      },
      {
        key: 'diag-pharmacy',
        tab: 'diagnostics',
        subView: 'pharmacy',
        path: '/diagnostics/pharmacy',
        label: 'Pharmacy Dispensing',
        icon: Pill,
        requiredAnyPermissions: ['pharmacy.prescription.read', 'pharmacy.dispense'],
      },
      {
        key: 'store',
        tab: 'store',
        path: '/store',
        label: 'Store & FEFO Inventory',
        icon: Package,
        requiredAnyPermissions: ['store.item.read', 'store.item.manage', 'store.grv.receive'],
      },
    ],
  },
  {
    id: 'finance-hr',
    title: 'Finance & Human Resources',
    items: [
      {
        key: 'billing-invoices',
        tab: 'billing',
        subView: 'invoices',
        path: '/billing/invoices',
        label: 'Billing & Invoices',
        icon: CreditCard,
        requiredAnyPermissions: ['billing.invoice.read', 'billing.invoice.create'],
      },
      {
        key: 'billing-payments',
        tab: 'billing',
        subView: 'payments',
        path: '/billing/payments',
        label: 'Payments & Receipts',
        icon: CreditCard,
        requiredAnyPermissions: ['billing.payment.create', 'billing.shift.manage'],
      },
      {
        key: 'billing-shifts',
        tab: 'billing',
        subView: 'shifts',
        path: '/billing/shifts',
        label: 'Shift Reconciliation',
        icon: BookOpen,
        requiredAnyPermissions: ['billing.shift.manage', 'billing.shift.reconcile'],
      },
      {
        key: 'billing-reports',
        tab: 'billing',
        subView: 'reports',
        path: '/billing/reports',
        label: 'Payment Reports',
        icon: BookOpen,
        requiredAnyPermissions: ['billing.report.own', 'finance.report.view'],
      },
      {
        key: 'accounting',
        tab: 'accounting',
        path: '/accounting',
        label: 'Finance & Ledger',
        icon: BookOpen,
        requiredAnyPermissions: [
          'finance.report.view',
          'accounting.ledger.manage',
          'accounting.expense.create',
          'accounting.period.manage',
          'accounting.journal.reverse',
          'finance.coa.manage',
          'finance.payment.manage',
          'finance.receipt.manage',
          'finance.bank.manage',
          'finance.grv.manage',
        ],
      },
      {
        key: 'hr',
        tab: 'hr',
        path: '/hr',
        label: 'HR & Staff Register',
        icon: Briefcase,
        requiredAnyPermissions: [
          'hr.manage',
          'hr.attendance.manage',
          'hr.overtime.manage',
          'hr.payroll.submit',
          'hr.leave.request',
          'hr.payslip.own',
        ],
      },
      {
        key: 'hr-payroll',
        tab: 'hr',
        subView: 'payroll',
        path: '/hr/payroll',
        label: 'Payroll Processing',
        icon: Briefcase,
        requiredAnyPermissions: [
          'hr.payroll.submit',
          'hr.payroll.verify',
          'hr.payroll.approve',
          'hr.payroll.post',
          'hr.payroll.pay',
          'finance.payroll.generate',
        ],
      },
    ],
  },
  {
    id: 'governance',
    title: 'System Administration',
    items: [
      {
        key: 'admin-users',
        tab: 'governance',
        subView: 'users',
        path: '/governance/users',
        label: 'User Management',
        icon: Users,
        requiredAnyPermissions: ['admin.user.manage'],
      },
      {
        key: 'admin-roles',
        tab: 'governance',
        subView: 'roles',
        path: '/governance/roles',
        label: 'Roles & Permissions',
        icon: Shield,
        requiredAnyPermissions: ['admin.role.manage', 'admin.user.manage'],
      },
      {
        key: 'admin-clinic',
        tab: 'governance',
        subView: 'clinic_config',
        path: '/governance/clinic',
        label: 'Clinic Configuration',
        icon: Building2,
        requiredAnyPermissions: ['admin.config.manage', 'admin.user.manage'],
      },
      {
        key: 'admin-clinical',
        tab: 'governance',
        subView: 'clinical_config',
        path: '/governance/clinical',
        label: 'Clinical Configuration',
        icon: Stethoscope,
        requiredAnyPermissions: ['admin.config.manage', 'admin.user.manage'],
      },
      {
        key: 'admin-catalog',
        tab: 'governance',
        subView: 'catalog',
        path: '/governance/catalog',
        label: 'Service Catalog',
        icon: BookOpen,
        requiredAnyPermissions: ['catalog.manage', 'admin.user.manage'],
      },
      {
        key: 'admin-billing',
        tab: 'governance',
        subView: 'billing_config',
        path: '/governance/billing',
        label: 'Billing Settings',
        icon: CreditCard,
        requiredAnyPermissions: ['admin.config.manage', 'admin.user.manage'],
      },
      {
        key: 'admin-notifications',
        tab: 'governance',
        subView: 'notifications_config',
        path: '/governance/notifications',
        label: 'Notifications & Alerts',
        icon: Settings,
        requiredAnyPermissions: ['admin.config.manage', 'admin.user.manage'],
      },
      {
        key: 'admin-security',
        tab: 'governance',
        subView: 'security_config',
        path: '/governance/security',
        label: 'Security Policies',
        icon: Lock,
        requiredAnyPermissions: ['admin.config.manage', 'admin.user.manage'],
      },
      {
        key: 'admin-audit',
        tab: 'governance',
        subView: 'audit',
        path: '/governance/audit',
        label: 'Audit Logs',
        icon: ShieldCheck,
        requiredAnyPermissions: ['audit.read'],
      },
      {
        key: 'admin-backup',
        tab: 'governance',
        subView: 'backup',
        path: '/governance/backup',
        label: 'Backup & Maintenance',
        icon: Database,
        requiredAnyPermissions: ['admin.backup.manage', 'admin.user.manage'],
      },
    ],
  },
];

export interface FilteredNavItem extends NavChildItem {
  displayLabel: string;
}

export interface FilteredNavGroup {
  id: string;
  title: string;
  items: FilteredNavItem[];
}

export function filterNavigationForUser(
  permissions: string[],
  roles: string[],
  defaultDashboard: DashboardType
): FilteredNavGroup[] {
  const permSet = new Set(permissions || []);
  const roleSet = new Set(roles || []);
  const isDocFocused = roleSet.has('DOC') && !roleSet.has('ADM') && !roleSet.has('MGR');
  const isCashierFocused = (roleSet.has('CSH') || roleSet.has('REC')) && !roleSet.has('ADM') && !roleSet.has('MGR');
  const isNurseFocused = (roleSet.has('NUR') || roleSet.has('WRD')) && !roleSet.has('ADM') && !roleSet.has('MGR');

  const groups: FilteredNavGroup[] = [];
  for (const group of NAVIGATION_MODULES) {
    const visibleItems: FilteredNavItem[] = [];
    for (const item of group.items) {
      const allowed =
        item.requiredAnyPermissions.length === 0 ||
        item.requiredAnyPermissions.some((p) => permSet.has(p));
      if (!allowed) continue;

      let displayLabel = item.label;
      if (item.key === 'dashboard') {
        displayLabel = DASHBOARD_METADATA[defaultDashboard]?.label || 'Role Dashboard';
      } else if (isDocFocused && item.docLabel) {
        displayLabel = item.docLabel;
      } else if (isCashierFocused && item.cashierLabel) {
        displayLabel = item.cashierLabel;
      } else if (isNurseFocused && item.nurseLabel) {
        displayLabel = item.nurseLabel;
      }

      visibleItems.push({
        ...item,
        path: item.key === 'dashboard' ? DASHBOARD_METADATA[defaultDashboard].path : item.path,
        dashboardType: item.key === 'dashboard' ? defaultDashboard : item.dashboardType,
        displayLabel,
      });
    }

    if (visibleItems.length > 0) {
      groups.push({
        id: group.id,
        title: group.title,
        items: visibleItems,
      });
    }
  }
  return groups;
}

export interface ResolvedRouteState {
  tab: TabKey;
  subView?: string;
  dashboardType?: DashboardType;
  navKey?: string;
}

export function resolvePathToState(pathname: string, defaultDashboard: DashboardType): ResolvedRouteState {
  const clean = pathname.replace(/\/+$/, '') || '/';
  if (clean === '/' || clean === '/dashboard') {
    return { tab: 'dashboard', dashboardType: defaultDashboard, navKey: 'dashboard' };
  }
  if (clean === '/unauthorized') {
    return { tab: 'unauthorized', navKey: 'unauthorized' };
  }
  if (clean.startsWith('/dashboard/')) {
    const seg = clean.slice('/dashboard/'.length).toLowerCase() as DashboardType;
    if (seg in DASHBOARD_METADATA) {
      return { tab: 'dashboard', dashboardType: seg, navKey: 'dashboard' };
    }
    return { tab: 'unauthorized', navKey: 'unauthorized' };
  }

  for (const group of NAVIGATION_MODULES) {
    for (const item of group.items) {
      if (item.path === clean) {
        return {
          tab: item.tab,
          subView: item.subView,
          dashboardType: item.dashboardType,
          navKey: item.key,
        };
      }
    }
  }

  if (clean.startsWith('/patients')) return { tab: 'patients', subView: 'patients', navKey: 'patients-all' };
  if (clean.startsWith('/appointments')) return { tab: 'appointments', navKey: 'appointments' };
  if (clean.startsWith('/clinical')) return { tab: 'clinical', subView: 'consultations', navKey: 'clinical-consultations' };
  if (clean.startsWith('/diagnostics')) return { tab: 'diagnostics', subView: 'lab', navKey: 'diag-lab' };
  if (clean.startsWith('/store')) return { tab: 'store', navKey: 'store' };
  if (clean.startsWith('/ipd')) return { tab: 'ipd', navKey: 'ipd' };
  if (clean.startsWith('/billing')) return { tab: 'billing', subView: 'invoices', navKey: 'billing-invoices' };
  if (clean.startsWith('/accounting')) return { tab: 'accounting', navKey: 'accounting' };
  if (clean.startsWith('/hr')) return { tab: 'hr', navKey: 'hr' };
  if (clean.startsWith('/governance')) return { tab: 'governance', subView: 'users', navKey: 'admin-users' };

  return { tab: 'dashboard', dashboardType: defaultDashboard, navKey: 'dashboard' };
}

export function getRequiredPermissionsForRoute(tab: TabKey, subView?: string): string[] {
  if (tab === 'dashboard' || tab === 'unauthorized') return [];

  for (const group of NAVIGATION_MODULES) {
    for (const item of group.items) {
      if (item.tab === tab && (item.subView === subView || (!subView && !item.subView))) {
        return item.requiredAnyPermissions;
      }
    }
  }

  const fallbackByTab: Record<Exclude<TabKey, 'dashboard' | 'unauthorized'>, string[]> = {
    patients: ['patient.read', 'patient.create', 'visit.create', 'queue.manage'],
    appointments: ['appointment.read'],
    clinical: ['visit.read', 'vitals.read', 'vitals.create'],
    diagnostics: [
      'lab.order.read',
      'lab.sample.collect',
      'lab.result.enter',
      'imaging.order.read',
      'imaging.exam.perform',
      'pharmacy.prescription.read',
      'pharmacy.dispense',
    ],
    store: ['store.item.read', 'store.item.manage', 'store.grv.receive'],
    ipd: ['ipd.admission.read', 'ipd.bed.assign', 'ipd.mar.give'],
    billing: ['billing.invoice.read', 'billing.payment.create', 'billing.shift.manage', 'billing.shift.reconcile'],
    accounting: ['finance.report.view', 'accounting.ledger.manage', 'accounting.expense.create', 'accounting.period.manage'],
    hr: ['hr.manage', 'hr.attendance.manage', 'hr.overtime.manage', 'hr.payroll.submit', 'hr.leave.request', 'hr.payslip.own', 'finance.payroll.generate', 'hr.payroll.verify', 'hr.payroll.approve', 'hr.payroll.post', 'hr.payroll.pay'],
    governance: ['admin.user.manage', 'admin.role.manage', 'admin.config.manage', 'audit.read', 'catalog.manage', 'admin.backup.manage'],
  };

  return fallbackByTab[tab] || [];
}

export function buildPathForRoute(tab: TabKey, subView?: string, dashboardType?: DashboardType): string {
  if (tab === 'unauthorized') return '/unauthorized';
  if (tab === 'dashboard') {
    return dashboardType ? DASHBOARD_METADATA[dashboardType].path : '/dashboard';
  }
  for (const group of NAVIGATION_MODULES) {
    for (const item of group.items) {
      if (item.tab === tab && item.subView === subView) {
        return item.path;
      }
    }
  }
  for (const group of NAVIGATION_MODULES) {
    for (const item of group.items) {
      if (item.tab === tab) {
        return item.path;
      }
    }
  }
  return '/';
}
