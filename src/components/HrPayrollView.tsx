import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle,
  Briefcase,
  Calendar,
  Check,
  Clock,
  DollarSign,
  Download,
  Edit3,
  Eye,
  FileText,
  Plus,
  Printer,
  RefreshCw,
  Send,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import type {
  HrAdjustment,
  HrAttendanceRecord,
  HrEmployee,
  HrEmployeeDocument,
  HrLeaveBalance,
  HrLeaveType,
  HrMonthlySubmission,
  HrOvertimeRecord,
  LeaveRequest,
  PayrollRun,
  StaffContract,
  StaffPayslip,
  UserContext,
} from '../types';

interface HrOverview {
  isHrManager: boolean;
  canViewPayroll: boolean;
  employees: HrEmployee[];
  employeeDocuments: HrEmployeeDocument[];
  attendance: HrAttendanceRecord[];
  leaveTypes: HrLeaveType[];
  leaveBalances: HrLeaveBalance[];
  overtime: HrOvertimeRecord[];
  adjustments: HrAdjustment[];
  monthlySubmissions: HrMonthlySubmission[];
  contracts: StaffContract[];
  leaveRequests: LeaveRequest[];
  payrollRuns: PayrollRun[];
  staffUsers: Array<{ id: number; full_name: string; email: string; role_code: string; role_name: string }>;
}

type HrSubTab =
  | 'employees'
  | 'attendance'
  | 'leave'
  | 'overtime'
  | 'adjustments'
  | 'submission'
  | 'reports'
  | 'payroll'
  | 'payslips';

type HrReportType =
  | 'employees'
  | 'attendance'
  | 'absenteeism'
  | 'late'
  | 'leave-balances'
  | 'leave-utilization'
  | 'overtime'
  | 'earnings-deductions'
  | 'turnover';

const HR_REPORT_LABELS: Record<HrReportType, string> = {
  employees: 'Employee Master Directory',
  attendance: 'Monthly Attendance Summary',
  absenteeism: 'Monthly Absenteeism Log',
  late: 'Late Arrivals & Early Departures',
  'leave-balances': 'Annual Leave Balances',
  'leave-utilization': 'Leave Utilization History',
  overtime: 'Monthly Overtime Report',
  'earnings-deductions': 'Additional Earnings & Deductions',
  turnover: 'Inactive & Terminated Staff Turnover',
};

const DEPARTMENTS = [
  'Medical',
  'Nursing',
  'Laboratory',
  'Radiology',
  'Pharmacy',
  'Administration',
  'Finance',
  'Reception & Cashier',
  'Support & Maintenance',
];

interface Props {
  user: UserContext;
  onNotify: (msg: string, type?: 'success' | 'error') => void;
  initialSubTab?: HrSubTab;
}

export const HrPayrollView: React.FC<Props> = ({ user, onNotify, initialSubTab }) => {
  const [data, setData] = useState<HrOverview | null>(null);
  const [payslips, setPayslips] = useState<StaffPayslip[]>([]);
  const [loading, setLoading] = useState(true);
  const [subTab, setSubTab] = useState<HrSubTab>(initialSubTab || 'leave');
  const initializedTab = useRef(Boolean(initialSubTab));

  const canManageHr = user.permissions.includes('hr.manage');
  const canAttendance = canManageHr || user.permissions.includes('hr.attendance.manage');
  const canOvertime = canManageHr || user.permissions.includes('hr.overtime.manage');
  const canSubmitPayroll = canManageHr || user.permissions.includes('hr.payroll.submit');
  const canVerifyPayroll = user.permissions.includes('hr.payroll.verify');
  const canApprovePayroll = user.permissions.includes('hr.payroll.approve');
  const canPostPayroll = user.permissions.includes('hr.payroll.post');
  const canPayPayroll = user.permissions.includes('hr.payroll.pay');
  const canViewOwnPayslips =
    user.permissions.includes('hr.payslip.own') || user.permissions.includes('hr.leave.request');

  // Employee Directory filters & modals
  const [empSearch, setEmpSearch] = useState('');
  const [empDeptFilter, setEmpDeptFilter] = useState('all');
  const [empStatusFilter, setEmpStatusFilter] = useState('active');
  const [empModalOpen, setEmpModalOpen] = useState(false);
  const [editingEmp, setEditingEmp] = useState<HrEmployee | null>(null);
  const [profileEmp, setProfileEmp] = useState<HrEmployee | null>(null);
  const [statusModalEmp, setStatusModalEmp] = useState<{ emp: HrEmployee; targetStatus: 'active' | 'inactive' | 'resigned' | 'terminated' } | null>(null);
  const [statusReason, setStatusReason] = useState('');

  // Employee Form fields
  const [fUserId, setFUserId] = useState('');
  const [fEmpNum, setFEmpNum] = useState('');
  const [fFullName, setFFullName] = useState('');
  const [fGender, setFGender] = useState('female');
  const [fPhone, setFPhone] = useState('');
  const [fEmail, setFEmail] = useState('');
  const [fAddress, setFAddress] = useState('');
  const [fEmergName, setFEmergName] = useState('');
  const [fEmergPhone, setFEmergPhone] = useState('');
  const [fDept, setFDept] = useState('Medical');
  const [fPosition, setFPosition] = useState('');
  const [fEmpType, setFEmpType] = useState<'full_time' | 'part_time' | 'contract' | 'locum'>('full_time');
  const [fHireDate, setFHireDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [fContractStart, setFContractStart] = useState(() => new Date().toISOString().slice(0, 10));
  const [fContractEnd, setFContractEnd] = useState('');
  const [fSalary, setFSalary] = useState('');
  const [fAllowance, setFAllowance] = useState('0');
  const [fLicenceNo, setFLicenceNo] = useState('');
  const [fLicenceExp, setFLicenceExp] = useState('');

  // Document attachment form (inside Employee Profile modal)
  const [docType, setDocType] = useState<'contract' | 'certificate' | 'id_document' | 'licence' | 'other'>('contract');
  const [docTitle, setDocTitle] = useState('');
  const [docRef, setDocRef] = useState('');
  const [docExpiry, setDocExpiry] = useState('');
  const [docNotes, setDocNotes] = useState('');

  // Attendance form & filters
  const [attEmpId, setAttEmpId] = useState('');
  const [attDate, setAttDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [attCheckIn, setAttCheckIn] = useState('08:00');
  const [attCheckOut, setAttCheckOut] = useState('17:00');
  const [attStatus, setAttStatus] = useState<'' | 'present' | 'late' | 'early_departure' | 'absent' | 'on_leave'>('');
  const [attHoursOverride, setAttHoursOverride] = useState('');
  const [attNotes, setAttNotes] = useState('');
  const [attMonthFilter, setAttMonthFilter] = useState(() => new Date().toISOString().slice(0, 7));
  const [attDeptFilter, setAttDeptFilter] = useState('all');
  const [attEditTarget, setAttEditTarget] = useState<HrAttendanceRecord | null>(null);

  // Leave request & leave type modals
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [lEmployeeId, setLEmployeeId] = useState('');
  const [lType, setLType] = useState('annual');
  const [lStart, setLStart] = useState(() => new Date().toISOString().slice(0, 10));
  const [lEnd, setLEnd] = useState(() => new Date().toISOString().slice(0, 10));
  const [lReason, setLReason] = useState('');
  const [leaveDecisionTarget, setLeaveDecisionTarget] = useState<{
    lr: LeaveRequest;
    decision: 'rejected' | 'cancelled';
  } | null>(null);
  const [leaveDecisionNote, setLeaveDecisionNote] = useState('');
  const [leaveTypeModalOpen, setLeaveTypeModalOpen] = useState(false);
  const [ltCode, setLtCode] = useState('');
  const [ltName, setLtName] = useState('');
  const [ltAllowance, setLtAllowance] = useState('15');
  const [ltPaid, setLtPaid] = useState(true);
  const [leaveViewSection, setLeaveViewSection] = useState<'requests' | 'balances'>('requests');

  // Overtime state
  const [otEmpId, setOtEmpId] = useState('');
  const [otDate, setOtDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [otHours, setOtHours] = useState('2');
  const [otDayType, setOtDayType] = useState<'regular' | 'weekend' | 'holiday'>('regular');
  const [otMult, setOtMult] = useState('1.5');
  const [otReason, setOtReason] = useState('');

  // Adjustments (Additional Earnings & Deductions)
  const [adjEmpId, setAdjEmpId] = useState('');
  const [adjType, setAdjType] = useState<'earning' | 'deduction'>('earning');
  const [adjCategory, setAdjCategory] = useState('Transport Allowance');
  const [adjAmount, setAdjAmount] = useState('');
  const [adjMonth, setAdjMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [adjRecurring, setAdjRecurring] = useState(false);
  const [adjDesc, setAdjDesc] = useState('');

  // Monthly Payroll Input Submission
  const [submitMonth, setSubmitMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [submitNotes, setSubmitNotes] = useState('');

  // HR Reports
  const [hrReportType, setHrReportType] = useState<HrReportType>('employees');
  const [hrReportMonth, setHrReportMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [hrReportRows, setHrReportRows] = useState<Array<Record<string, unknown>>>([]);
  const [hrReportLoading, setHrReportLoading] = useState(false);

  // Printable modals
  const [printProfileEmp, setPrintProfileEmp] = useState<HrEmployee | null>(null);
  const [printPayslip, setPrintPayslip] = useState<StaffPayslip | null>(null);

  useEffect(() => {
    if (printProfileEmp || printPayslip) {
      document.body.classList.add('has-print-modal');
      return () => {
        document.body.classList.remove('has-print-modal');
      };
    }
  }, [printProfileEmp, printPayslip]);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [res, slipRes] = await Promise.all([
        apiFetch<HrOverview>('/api/hr/overview'),
        canViewOwnPayslips
          ? apiFetch<{ payslips: StaffPayslip[] }>('/api/hr/my-payslips').catch(() => ({ payslips: [] }))
          : Promise.resolve({ payslips: [] }),
      ]);
      setData(res);
      setPayslips(slipRes.payslips || []);

      const activeEmps = (res.employees || []).filter((e) => e.status === 'active');
      if (activeEmps.length > 0) {
        const firstId = String(activeEmps[0].id);
        setAttEmpId((p) => p || firstId);
        setOtEmpId((p) => p || firstId);
        setAdjEmpId((p) => p || firstId);
      }

      if (!initializedTab.current) {
        initializedTab.current = true;
        if (canManageHr) setSubTab('employees');
        else if (canAttendance) setSubTab('attendance');
        else if (canOvertime) setSubTab('overtime');
        else if (canSubmitPayroll) setSubTab('submission');
        else if (res.canViewPayroll) setSubTab('payroll');
        else setSubTab('leave');
      }
    } catch (err) {
      onNotify((err as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }, [canViewOwnPayslips, canManageHr, canAttendance, canOvertime, canSubmitPayroll, onNotify]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    if (initialSubTab) {
      initializedTab.current = true;
      setSubTab(initialSubTab);
    }
  }, [initialSubTab]);

  const loadHrReport = useCallback(async () => {
    setHrReportLoading(true);
    try {
      const res = await apiFetch<{ rows: Array<Record<string, unknown>> }>(
        `/api/hr/reports/${hrReportType}?month=${encodeURIComponent(hrReportMonth)}`
      );
      setHrReportRows(Array.isArray(res?.rows) ? res.rows : []);
    } catch (err) {
      onNotify((err as Error).message, 'error');
    } finally {
      setHrReportLoading(false);
    }
  }, [hrReportType, hrReportMonth, onNotify]);

  useEffect(() => {
    if (subTab === 'reports' && data?.isHrManager) {
      loadHrReport();
    }
  }, [subTab, data?.isHrManager, loadHrReport]);

  function openNewEmployeeModal() {
    setEditingEmp(null);
    setFUserId('');
    setFEmpNum('');
    setFFullName('');
    setFGender('female');
    setFPhone('');
    setFEmail('');
    setFAddress('');
    setFEmergName('');
    setFEmergPhone('');
    setFDept('Medical');
    setFPosition('');
    setFEmpType('full_time');
    const today = new Date().toISOString().slice(0, 10);
    setFHireDate(today);
    setFContractStart(today);
    setFContractEnd('');
    setFSalary('');
    setFAllowance('0');
    setFLicenceNo('');
    setFLicenceExp('');
    setEmpModalOpen(true);
  }

  function openEditEmployeeModal(emp: HrEmployee) {
    setEditingEmp(emp);
    setFUserId(emp.user_id ? String(emp.user_id) : '');
    setFEmpNum(emp.employee_number);
    setFFullName(emp.full_name);
    setFGender(emp.gender || 'unspecified');
    setFPhone(emp.phone || '');
    setFEmail(emp.email || '');
    setFAddress(emp.address || '');
    setFEmergName(emp.emergency_contact_name || '');
    setFEmergPhone(emp.emergency_contact_phone || '');
    setFDept(emp.department_name || 'Medical');
    setFPosition(emp.job_position || '');
    setFEmpType((emp.employment_type as 'full_time' | 'part_time' | 'contract' | 'locum') || 'full_time');
    setFHireDate(emp.hire_date || '');
    setFContractStart(emp.contract_start || '');
    setFContractEnd(emp.contract_end || '');
    setFSalary(String(emp.basic_salary || ''));
    setFAllowance(String(emp.housing_allowance || 0));
    setFLicenceNo(emp.licence_number || '');
    setFLicenceExp(emp.licence_expiry || '');
    setEmpModalOpen(true);
  }

  async function handleSaveEmployee(e: React.FormEvent) {
    e.preventDefault();
    try {
      const payload = {
        user_id: fUserId ? Number(fUserId) : null,
        employee_number: fEmpNum.trim() || undefined,
        full_name: fFullName.trim(),
        gender: fGender,
        phone: fPhone.trim() || null,
        email: fEmail.trim() || null,
        address: fAddress.trim() || null,
        emergency_contact_name: fEmergName.trim() || null,
        emergency_contact_phone: fEmergPhone.trim() || null,
        department_name: fDept.trim(),
        job_position: fPosition.trim() || 'Clinic Staff',
        employment_type: fEmpType,
        hire_date: fHireDate,
        contract_start: fContractStart,
        contract_end: fContractEnd || null,
        basic_salary: Number(fSalary),
        housing_allowance: Number(fAllowance || 0),
        licence_number: fLicenceNo.trim() || null,
        licence_expiry: fLicenceExp || null,
      };
      if (editingEmp) {
        await apiFetch(`/api/hr/employees/${editingEmp.id}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
        onNotify(`Updated employee profile ${editingEmp.employee_number}.`);
      } else {
        const res = await apiFetch<{ employee_number: string }>('/api/hr/employees', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        onNotify(`Registered employee ${res.employee_number} (${fFullName.trim()}).`);
      }
      setEmpModalOpen(false);
      loadData();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleConfirmStatusChange(e: React.FormEvent) {
    e.preventDefault();
    if (!statusModalEmp) return;
    try {
      await apiFetch(`/api/hr/employees/${statusModalEmp.emp.id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({
          status: statusModalEmp.targetStatus,
          reason: statusReason.trim() || undefined,
        }),
      });
      onNotify(`Employee ${statusModalEmp.emp.full_name} marked ${statusModalEmp.targetStatus}.`);
      setStatusModalEmp(null);
      setStatusReason('');
      loadData();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleAddEmployeeDocument(e: React.FormEvent) {
    e.preventDefault();
    if (!profileEmp) return;
    try {
      await apiFetch(`/api/hr/employees/${profileEmp.id}/documents`, {
        method: 'POST',
        body: JSON.stringify({
          doc_type: docType,
          title: docTitle.trim(),
          file_ref: docRef.trim() || null,
          expiry_date: docExpiry || null,
          notes: docNotes.trim() || null,
        }),
      });
      onNotify(`Attached document "${docTitle.trim()}" to ${profileEmp.full_name}.`);
      setDocTitle('');
      setDocRef('');
      setDocExpiry('');
      setDocNotes('');
      loadData();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleDeleteDocument(docId: number) {
    try {
      await apiFetch(`/api/hr/documents/${docId}`, { method: 'DELETE' });
      onNotify('Employee document removed.');
      loadData();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleSaveAttendance(e: React.FormEvent) {
    e.preventDefault();
    try {
      if (attEditTarget) {
        await apiFetch(`/api/hr/attendance/${attEditTarget.id}`, {
          method: 'PUT',
          body: JSON.stringify({
            check_in: attStatus === 'absent' || attStatus === 'on_leave' ? null : attCheckIn,
            check_out: attStatus === 'absent' || attStatus === 'on_leave' ? null : attCheckOut,
            status: attStatus || 'present',
            hours_worked: attHoursOverride !== '' ? Number(attHoursOverride) : undefined,
            notes: attNotes.trim() || null,
          }),
        });
        onNotify(`Corrected attendance record for ${attEditTarget.full_name}.`);
        setAttEditTarget(null);
      } else {
        const res = await apiFetch<{ status: string; hours_worked: number; updated?: boolean }>('/api/hr/attendance', {
          method: 'POST',
          body: JSON.stringify({
            employee_id: Number(attEmpId),
            attendance_date: attDate,
            check_in: attStatus === 'absent' || attStatus === 'on_leave' ? null : attCheckIn,
            check_out: attStatus === 'absent' || attStatus === 'on_leave' ? null : attCheckOut,
            status: attStatus || undefined,
            hours_worked: attHoursOverride !== '' ? Number(attHoursOverride) : undefined,
            notes: attNotes.trim() || null,
          }),
        });
        onNotify(
          `Attendance ${res.updated ? 'updated' : 'recorded'}: ${res.status.replace('_', ' ')} (${Number(res.hours_worked).toFixed(2)} hrs).`
        );
      }
      setAttNotes('');
      setAttHoursOverride('');
      loadData();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleSubmitLeave(e: React.FormEvent) {
    e.preventDefault();
    try {
      const res = await apiFetch<{ daysCount: number }>('/api/hr/leave', {
        method: 'POST',
        body: JSON.stringify({
          employee_id: canManageHr && lEmployeeId ? Number(lEmployeeId) : undefined,
          leave_type: lType,
          start_date: lStart,
          end_date: lEnd,
          reason: lReason,
        }),
      });
      onNotify(`Submitted ${res.daysCount}-day ${lType} leave request.`);
      setLeaveOpen(false);
      setLReason('');
      loadData();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleSaveLeaveType(e: React.FormEvent) {
    e.preventDefault();
    try {
      await apiFetch('/api/hr/leave-types', {
        method: 'POST',
        body: JSON.stringify({
          code: ltCode.trim(),
          name: ltName.trim(),
          annual_allowance_days: Number(ltAllowance || 0),
          paid: ltPaid,
        }),
      });
      onNotify(`Saved leave type "${ltName.trim()}".`);
      setLeaveTypeModalOpen(false);
      setLtCode('');
      setLtName('');
      loadData();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleDecideLeave(id: number, decision: 'approved' | 'rejected' | 'cancelled', decision_note?: string) {
    try {
      const res = await apiFetch<{ blocksCreated: number }>(`/api/hr/leave/${id}/decide`, {
        method: 'POST',
        body: JSON.stringify({ decision, decision_note }),
      });
      onNotify(
        decision === 'approved'
          ? `Leave approved${res.blocksCreated > 0 ? ` (${res.blocksCreated} clinician schedule block(s) auto-created)` : ''}.`
          : decision === 'cancelled'
            ? 'Leave request cancelled and schedule blocks released.'
            : 'Leave request rejected.'
      );
      setLeaveDecisionTarget(null);
      setLeaveDecisionNote('');
      loadData();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleCreateOvertime(e: React.FormEvent) {
    e.preventDefault();
    try {
      const res = await apiFetch<{ computed_amount: number }>('/api/hr/overtime', {
        method: 'POST',
        body: JSON.stringify({
          employee_id: Number(otEmpId),
          overtime_date: otDate,
          hours: Number(otHours),
          day_type: otDayType,
          rate_multiplier: Number(otMult),
          reason: otReason.trim(),
        }),
      });
      onNotify(`Overtime logged ($${Number(res.computed_amount).toFixed(2)} pending approval).`);
      setOtReason('');
      loadData();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleDecideOvertime(id: number, decision: 'approved' | 'rejected') {
    try {
      await apiFetch(`/api/hr/overtime/${id}/decide`, {
        method: 'POST',
        body: JSON.stringify({ decision }),
      });
      onNotify(`Overtime request ${decision}.`);
      loadData();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleCreateAdjustment(e: React.FormEvent) {
    e.preventDefault();
    try {
      await apiFetch('/api/hr/adjustments', {
        method: 'POST',
        body: JSON.stringify({
          employee_id: Number(adjEmpId),
          adjustment_type: adjType,
          category: adjCategory.trim(),
          amount: Number(adjAmount),
          effective_month: adjMonth,
          recurring: adjRecurring,
          description: adjDesc.trim(),
        }),
      });
      onNotify(`${adjType === 'earning' ? 'Earning' : 'Deduction'} recorded for ${adjMonth}.`);
      setAdjAmount('');
      setAdjDesc('');
      loadData();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleCancelAdjustment(id: number) {
    try {
      await apiFetch(`/api/hr/adjustments/${id}/cancel`, { method: 'PATCH' });
      onNotify('Adjustment cancelled.');
      loadData();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleSubmitPayrollInputs(e: React.FormEvent) {
    e.preventDefault();
    try {
      const res = await apiFetch<{
        payMonth: string;
        totalEmployees: number;
        totalOvertimeAmount: number;
      }>('/api/hr/payroll-inputs/submit', {
        method: 'POST',
        body: JSON.stringify({
          pay_month: submitMonth,
          notes: submitNotes.trim() || null,
        }),
      });
      onNotify(
        `Submitted ${res.payMonth} HR payroll inputs (${res.totalEmployees} active employees, $${Number(res.totalOvertimeAmount).toFixed(2)} OT) to Finance.`
      );
      setSubmitNotes('');
      loadData();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleVerifyPayroll(runId: number) {
    try {
      await apiFetch(`/api/hr/payroll/${runId}/verify`, { method: 'POST' });
      onNotify('Payroll run verified by Finance.');
      loadData();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleApprovePayroll(runId: number) {
    try {
      await apiFetch(`/api/hr/payroll/${runId}/approve`, { method: 'POST' });
      onNotify('Payroll run approved for GL posting.');
      loadData();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handlePostPayroll(runId: number) {
    try {
      const res = await apiFetch<{ entryNumber: string }>(`/api/hr/payroll/${runId}/post`, { method: 'POST' });
      onNotify(`Payroll posted to GL (${res.entryNumber}).`);
      loadData();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handlePayPayroll(runId: number) {
    try {
      const res = await apiFetch<{ entryNumber: string }>(`/api/hr/payroll/${runId}/pay`, { method: 'POST' });
      onNotify(`Bank salary disbursement recorded (${res.entryNumber}).`);
      loadData();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  function exportHrReportCsv() {
    if (hrReportRows.length === 0) {
      onNotify('No rows available to export.', 'error');
      return;
    }
    const headers = Object.keys(hrReportRows[0]);
    const escapeCell = (val: unknown) => {
      const str = val === null || val === undefined ? '' : String(val);
      return str.includes(',') || str.includes('"') || str.includes('\n') ? `"${str.replace(/"/g, '""')}"` : str;
    };
    const csv = [headers.join(','), ...hrReportRows.map((r) => headers.map((h) => escapeCell(r[h])).join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `clinic360-hr-${hrReportType}-${hrReportMonth}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    onNotify(`Exported ${hrReportRows.length} rows to CSV.`);
  }

  const employees = useMemo(() => data?.employees || [], [data?.employees]);
  const activeEmployees = useMemo(() => employees.filter((e) => e.status === 'active'), [employees]);

  const filteredEmployees = useMemo(() => {
    const q = empSearch.trim().toLowerCase();
    return employees.filter((e) => {
      if (empStatusFilter !== 'all' && e.status !== empStatusFilter) return false;
      if (empDeptFilter !== 'all' && e.department_name !== empDeptFilter) return false;
      if (
        q &&
        !e.full_name.toLowerCase().includes(q) &&
        !e.employee_number.toLowerCase().includes(q) &&
        !e.job_position.toLowerCase().includes(q)
      ) {
        return false;
      }
      return true;
    });
  }, [employees, empSearch, empDeptFilter, empStatusFilter]);

  const expiringEmployees = useMemo(
    () => activeEmployees.filter((e) => e.licence_alert === 'expired' || e.licence_alert === 'expiring_soon'),
    [activeEmployees]
  );

  const filteredAttendance = useMemo(() => {
    return (data?.attendance || []).filter((a) => {
      if (attMonthFilter && !a.attendance_date.startsWith(attMonthFilter)) return false;
      if (attDeptFilter !== 'all' && a.department_name !== attDeptFilter) return false;
      return true;
    });
  }, [data?.attendance, attMonthFilter, attDeptFilter]);

  const attendanceSummary = useMemo(() => {
    let present = 0;
    let late = 0;
    let absent = 0;
    let hours = 0;
    for (const a of filteredAttendance) {
      if (a.status === 'absent') absent++;
      else if (a.status === 'late') {
        late++;
        present++;
      } else if (a.status === 'present' || a.status === 'early_departure') present++;
      hours += Number(a.hours_worked || 0);
    }
    return { total: filteredAttendance.length, present, late, absent, hours };
  }, [filteredAttendance]);

  const submissionPreview = useMemo(() => {
    const monthStart = `${submitMonth}-01`;
    const [y, m] = submitMonth.split('-').map(Number);
    const monthEnd = !Number.isNaN(y) && !Number.isNaN(m) ? new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) : `${submitMonth}-31`;
    const eligibleEmps = activeEmployees.filter(
      (e) => e.contract_start <= monthEnd && (!e.contract_end || e.contract_end >= monthStart)
    );
    const attHours = (data?.attendance || [])
      .filter((a) => a.attendance_date.startsWith(submitMonth))
      .reduce((s, a) => s + Number(a.hours_worked || 0), 0);
    const approvedOt = (data?.overtime || [])
      .filter((o) => o.status === 'approved' && o.overtime_date.startsWith(submitMonth))
      .reduce((s, o) => s + Number(o.computed_amount || 0), 0);
    const extraEarn = (data?.adjustments || [])
      .filter((a) => a.status === 'active' && a.adjustment_type === 'earning' && (a.effective_month === submitMonth || a.recurring === 1))
      .reduce((s, a) => s + Number(a.amount || 0), 0);
    const extraDed = (data?.adjustments || [])
      .filter((a) => a.status === 'active' && a.adjustment_type === 'deduction' && (a.effective_month === submitMonth || a.recurring === 1))
      .reduce((s, a) => s + Number(a.amount || 0), 0);
    return {
      headcount: eligibleEmps.length,
      attHours,
      approvedOt,
      extraEarn,
      extraDed,
    };
  }, [activeEmployees, data?.attendance, data?.overtime, data?.adjustments, submitMonth]);

  const otPreview = useMemo(() => {
    const emp = employees.find((e) => String(e.id) === otEmpId);
    const hrs = Number(otHours || 0);
    const mult = Number(otMult || 1.5);
    if (!emp || hrs <= 0) return { rate: 0, amount: 0 };
    const rate = Number((Number(emp.basic_salary) / 160).toFixed(2));
    return { rate, amount: Number((hrs * rate * mult).toFixed(2)) };
  }, [employees, otEmpId, otHours, otMult]);

  const leavePreviewDays = useMemo(() => {
    const s = new Date(lStart).getTime();
    const e = new Date(lEnd).getTime();
    if (Number.isNaN(s) || Number.isNaN(e) || e < s) return 0;
    return Math.max(1, Math.round((e - s) / 86400000) + 1);
  }, [lStart, lEnd]);

  const unlinkedUsers = useMemo(() => {
    const linked = new Set(employees.filter((e) => e.user_id).map((e) => e.user_id));
    return (data?.staffUsers || []).filter((u) => !linked.has(u.id));
  }, [data?.staffUsers, employees]);

  const subTabs: Array<[HrSubTab, string]> = useMemo(() => {
    if (!data) return [];
    const list: Array<[HrSubTab, string]> = [];
    if (canManageHr) list.push(['employees', `Employees (${employees.length})`]);
    if (canAttendance) list.push(['attendance', 'Attendance']);
    list.push(['leave', canManageHr ? `Leave & Balances (${data.leaveRequests.length})` : `My Leave (${data.leaveRequests.length})`]);
    if (canOvertime) list.push(['overtime', `Overtime (${data.overtime.length})`]);
    if (canManageHr || canSubmitPayroll) list.push(['adjustments', `Earnings & Deductions (${data.adjustments.length})`]);
    if (canSubmitPayroll) list.push(['submission', 'Payroll Submission']);
    if (data.isHrManager) list.push(['reports', 'HR Reports']);
    if (data.canViewPayroll && !canManageHr) list.push(['payroll', `Payroll Approvals (${data.payrollRuns.length})`]);
    if (canViewOwnPayslips) list.push(['payslips', `My Payslips (${payslips.length})`]);
    return list;
  }, [data, canManageHr, canAttendance, canOvertime, canSubmitPayroll, canViewOwnPayslips, employees.length, payslips.length]);

  const profileDocs = useMemo(
    () => (profileEmp ? (data?.employeeDocuments || []).filter((d) => d.employee_id === profileEmp.id) : []),
    [profileEmp, data?.employeeDocuments]
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 no-print">
        <div>
          <h1 className="font-display text-xl font-semibold text-slate-900">Human Resources Management</h1>
          <p className="text-xs text-slate-500 mt-0.5">
            {canManageHr || canSubmitPayroll
              ? 'Employee directory, attendance tracking, leave balances, overtime, adjustments, and monthly Finance payroll handoff.'
              : data?.canViewPayroll
                ? 'Payroll approvals & disbursement oversight, personal leave requests, and payslips.'
                : 'Submit leave requests and download personal monthly payslips.'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={loadData}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-md whitespace-nowrap"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Refresh</span>
          </button>
          <button
            onClick={() => setLeaveOpen(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-md whitespace-nowrap"
          >
            <Calendar className="w-3.5 h-3.5" />
            <span>Request Leave</span>
          </button>
          {canManageHr && (
            <button
              onClick={openNewEmployeeModal}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md whitespace-nowrap"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Register Employee</span>
            </button>
          )}
        </div>
      </div>

      {/* Practising Licence Alert Banner */}
      {canManageHr && expiringEmployees.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 flex items-start gap-3 text-xs text-amber-900 no-print">
          <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
          <div>
            <div className="font-semibold">Practising Licence Expiry Alerts ({expiringEmployees.length})</div>
            <div className="mt-1 space-y-0.5">
              {expiringEmployees.map((c) => (
                <div key={c.id}>
                  <span className="font-medium">{c.full_name}</span> ({c.employee_number} · {c.licence_number || 'No licence #'}): expires{' '}
                  <span className="font-mono font-semibold">{c.licence_expiry}</span> (
                  {c.licence_days_remaining !== null && c.licence_days_remaining !== undefined
                    ? c.licence_days_remaining <= 0
                      ? 'EXPIRED'
                      : `${c.licence_days_remaining}d left`
                    : ''}
                  )
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Sub-Tabs */}
      {data && (
        <div className="flex flex-wrap gap-1 border-b border-slate-200 no-print">
          {subTabs.map(([key, label]) => (
            <button
              key={key}
              onClick={() => setSubTab(key)}
              className={`px-3.5 py-2 text-xs font-medium border-b-2 transition-colors whitespace-nowrap ${
                subTab === key
                  ? 'border-teal-700 text-teal-800 bg-white'
                  : 'border-transparent text-slate-500 hover:text-slate-900'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {loading && !data ? (
        <div className="bg-white border border-slate-200 rounded-lg p-10 text-center text-sm text-slate-500">
          Loading HR workspace...
        </div>
      ) : null}

      {/* 1. EMPLOYEES DIRECTORY */}
      {canManageHr && subTab === 'employees' && data && (
        <div className="space-y-4">
          <div className="bg-white border border-slate-200 rounded-lg p-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2.5 text-xs flex-1">
              <input
                value={empSearch}
                onChange={(e) => setEmpSearch(e.target.value)}
                placeholder="Search by employee #, name, or position..."
                className="px-3 py-1.5 border border-slate-300 rounded-md w-64"
              />
              <select
                value={empDeptFilter}
                onChange={(e) => setEmpDeptFilter(e.target.value)}
                className="px-2.5 py-1.5 border border-slate-300 rounded-md bg-white"
              >
                <option value="all">All Departments</option>
                {Array.from(new Set([...DEPARTMENTS, ...employees.map((e) => e.department_name)])).map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
              <select
                value={empStatusFilter}
                onChange={(e) => setEmpStatusFilter(e.target.value)}
                className="px-2.5 py-1.5 border border-slate-300 rounded-md bg-white"
              >
                <option value="active">Active Staff</option>
                <option value="inactive">Inactive</option>
                <option value="resigned">Resigned</option>
                <option value="terminated">Terminated</option>
                <option value="all">All Statuses</option>
              </select>
            </div>
            <div className="text-xs font-mono text-slate-500 tabular-nums">
              {filteredEmployees.length} of {employees.length} employees · Monthly Base Payroll $
              {activeEmployees.reduce((s, e) => s + Number(e.basic_salary || 0), 0).toFixed(2)}
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Users className="w-4 h-4 text-teal-700" />
                <h2 className="font-display text-sm font-semibold text-slate-900">Employee Master Roster</h2>
              </div>
              <span className="text-xs text-slate-500">Supports both system login accounts &amp; non-login clinic staff</span>
            </div>
            {filteredEmployees.length === 0 ? (
              <div className="p-8 text-center text-xs text-slate-500">No employees match the active filters.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-slate-500">
                      <th className="py-2.5 px-4">Emp #</th>
                      <th className="py-2.5 px-4">Employee &amp; Role</th>
                      <th className="py-2.5 px-4">Department &amp; Type</th>
                      <th className="py-2.5 px-4">Contact</th>
                      <th className="py-2.5 px-4 text-right">Basic Salary</th>
                      <th className="py-2.5 px-4 text-right">Allowance</th>
                      <th className="py-2.5 px-4">Status</th>
                      <th className="py-2.5 px-4 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {filteredEmployees.map((emp) => (
                      <tr key={emp.id} className="hover:bg-slate-50/60">
                        <td className="py-2.5 px-4 font-mono font-semibold text-slate-800 whitespace-nowrap">
                          {emp.employee_number}
                        </td>
                        <td className="py-2.5 px-4">
                          <div className="font-medium text-slate-900">{emp.full_name}</div>
                          <div className="text-slate-500">
                            {emp.job_position}
                            {emp.role_code ? ` · User ${emp.role_code}` : ' · Non-login staff'}
                          </div>
                        </td>
                        <td className="py-2.5 px-4">
                          <div className="text-slate-800">{emp.department_name}</div>
                          <div className="font-mono text-[11px] text-slate-500 capitalize">
                            {emp.employment_type.replace('_', ' ')} · Start {emp.contract_start}
                          </div>
                        </td>
                        <td className="py-2.5 px-4 text-slate-600">
                          <div>{emp.phone || '—'}</div>
                          <div className="text-[11px] text-slate-400">{emp.email || emp.user_email || ''}</div>
                        </td>
                        <td className="py-2.5 px-4 text-right font-mono tabular-nums font-medium">
                          ${Number(emp.basic_salary).toFixed(2)}
                        </td>
                        <td className="py-2.5 px-4 text-right font-mono tabular-nums">
                          ${Number(emp.housing_allowance || 0).toFixed(2)}
                        </td>
                        <td className="py-2.5 px-4 font-mono capitalize font-semibold">
                          <span
                            className={
                              emp.status === 'active'
                                ? 'text-emerald-700'
                                : emp.status === 'terminated'
                                  ? 'text-red-700'
                                  : 'text-amber-700'
                            }
                          >
                            {emp.status}
                          </span>
                        </td>
                        <td className="py-2.5 px-4 text-right whitespace-nowrap">
                          <div className="inline-flex items-center gap-1.5">
                            <button
                              onClick={() => setProfileEmp(emp)}
                              className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-slate-700 border border-slate-200 hover:bg-slate-50 rounded"
                            >
                              <Eye className="w-3 h-3" />
                              <span>Profile ({emp.document_count || 0})</span>
                            </button>
                            <button
                              onClick={() => openEditEmployeeModal(emp)}
                              className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-teal-800 border border-teal-200 hover:bg-teal-50 rounded"
                            >
                              <Edit3 className="w-3 h-3" />
                              <span>Edit</span>
                            </button>
                            {emp.status === 'active' ? (
                              <>
                                <button
                                  onClick={() => {
                                    setStatusReason('');
                                    setStatusModalEmp({ emp, targetStatus: 'inactive' });
                                  }}
                                  className="px-2 py-1 text-xs font-medium text-amber-800 border border-amber-200 hover:bg-amber-50 rounded"
                                >
                                  Deactivate
                                </button>
                                <button
                                  onClick={() => {
                                    setStatusReason('');
                                    setStatusModalEmp({ emp, targetStatus: 'resigned' });
                                  }}
                                  className="px-2 py-1 text-xs font-medium text-orange-800 border border-orange-200 hover:bg-orange-50 rounded"
                                >
                                  Resign
                                </button>
                                <button
                                  onClick={() => {
                                    setStatusReason('');
                                    setStatusModalEmp({ emp, targetStatus: 'terminated' });
                                  }}
                                  className="px-2 py-1 text-xs font-medium text-red-700 border border-red-200 hover:bg-red-50 rounded"
                                >
                                  Terminate
                                </button>
                              </>
                            ) : (
                              <button
                                onClick={() => {
                                  setStatusReason('');
                                  setStatusModalEmp({ emp, targetStatus: 'active' });
                                }}
                                className="px-2 py-1 text-xs font-medium text-emerald-700 border border-emerald-200 hover:bg-emerald-50 rounded"
                              >
                                Reactivate
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 2. ATTENDANCE MANAGEMENT */}
      {canAttendance && subTab === 'attendance' && data && (
        <div className="space-y-4">
          <div className="bg-white border border-slate-200 rounded-lg p-5">
            <div className="flex items-center justify-between mb-3 pb-2 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <Clock className="w-4 h-4 text-teal-700" />
                <h2 className="font-display text-sm font-semibold text-slate-900">
                  {attEditTarget ? `Correct Attendance · ${attEditTarget.full_name} (${attEditTarget.attendance_date})` : 'Register Daily Attendance'}
                </h2>
              </div>
              {attEditTarget && (
                <button
                  onClick={() => setAttEditTarget(null)}
                  className="text-xs text-slate-500 hover:text-slate-900"
                >
                  Cancel Correction
                </button>
              )}
            </div>
            <form onSubmit={handleSaveAttendance} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-7 gap-3 text-xs items-end">
              {!attEditTarget && (
                <div className="lg:col-span-2">
                  <label className="block font-medium text-slate-700 mb-1">Employee *</label>
                  <select
                    required
                    value={attEmpId}
                    onChange={(e) => setAttEmpId(e.target.value)}
                    className="w-full px-2.5 py-2 border border-slate-300 rounded-md bg-white"
                  >
                    {activeEmployees.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.employee_number} · {e.full_name} ({e.department_name})
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div>
                <label className="block font-medium text-slate-700 mb-1">Date *</label>
                <input
                  type="date"
                  required
                  disabled={Boolean(attEditTarget)}
                  value={attDate}
                  onChange={(e) => setAttDate(e.target.value)}
                  className="w-full px-2.5 py-2 border border-slate-300 rounded-md font-mono disabled:bg-slate-100"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Status</label>
                <select
                  value={attStatus}
                  onChange={(e) => setAttStatus(e.target.value as typeof attStatus)}
                  className="w-full px-2.5 py-2 border border-slate-300 rounded-md bg-white"
                >
                  <option value="">Auto (8:15 late / 17:00 early)</option>
                  <option value="present">Present</option>
                  <option value="late">Late Arrival</option>
                  <option value="early_departure">Early Departure</option>
                  <option value="absent">Absent</option>
                  <option value="on_leave">On Leave</option>
                </select>
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Check-In</label>
                <input
                  type="time"
                  disabled={attStatus === 'absent' || attStatus === 'on_leave'}
                  value={attCheckIn}
                  onChange={(e) => setAttCheckIn(e.target.value)}
                  className="w-full px-2.5 py-2 border border-slate-300 rounded-md font-mono disabled:bg-slate-100"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Check-Out</label>
                <input
                  type="time"
                  disabled={attStatus === 'absent' || attStatus === 'on_leave'}
                  value={attCheckOut}
                  onChange={(e) => setAttCheckOut(e.target.value)}
                  className="w-full px-2.5 py-2 border border-slate-300 rounded-md font-mono disabled:bg-slate-100"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Notes</label>
                <input
                  value={attNotes}
                  onChange={(e) => setAttNotes(e.target.value)}
                  placeholder="Optional remark"
                  className="w-full px-2.5 py-2 border border-slate-300 rounded-md"
                />
              </div>
              <div className="sm:col-span-2 lg:col-span-7 flex flex-wrap items-center justify-between gap-3 pt-1">
                <div className="flex items-center gap-3 text-slate-500">
                  <span>Manual Hours Override (optional):</span>
                  <input
                    type="number"
                    step="0.25"
                    min="0"
                    max="24"
                    value={attHoursOverride}
                    onChange={(e) => setAttHoursOverride(e.target.value)}
                    placeholder="Auto"
                    className="w-24 px-2 py-1 border border-slate-300 rounded font-mono text-slate-900"
                  />
                </div>
                <button
                  type="submit"
                  className="px-4 py-2 bg-teal-700 hover:bg-teal-800 text-white rounded-md font-medium whitespace-nowrap"
                >
                  {attEditTarget ? 'Save Correction' : 'Record Attendance'}
                </button>
              </div>
            </form>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div className="bg-white border border-slate-200 rounded-lg p-4">
              <div className="text-xs text-slate-500">Records ({attMonthFilter || 'All'})</div>
              <div className="font-mono text-lg font-semibold text-slate-900 mt-1 tabular-nums">{attendanceSummary.total}</div>
            </div>
            <div className="bg-white border border-slate-200 rounded-lg p-4">
              <div className="text-xs text-slate-500">Present / Late Days</div>
              <div className="font-mono text-lg font-semibold text-emerald-700 mt-1 tabular-nums">
                {attendanceSummary.present} ({attendanceSummary.late} late)
              </div>
            </div>
            <div className="bg-white border border-slate-200 rounded-lg p-4">
              <div className="text-xs text-slate-500">Absent Days</div>
              <div className="font-mono text-lg font-semibold text-red-700 mt-1 tabular-nums">{attendanceSummary.absent}</div>
            </div>
            <div className="bg-white border border-slate-200 rounded-lg p-4">
              <div className="text-xs text-slate-500">Total Hours Logged</div>
              <div className="font-mono text-lg font-semibold text-teal-800 mt-1 tabular-nums">
                {attendanceSummary.hours.toFixed(2)} hrs
              </div>
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
              <h2 className="font-display text-sm font-semibold text-slate-900">Attendance Register</h2>
              <div className="flex items-center gap-2 text-xs">
                <input
                  type="month"
                  value={attMonthFilter}
                  onChange={(e) => setAttMonthFilter(e.target.value)}
                  className="px-2.5 py-1 border border-slate-300 rounded font-mono"
                />
                <select
                  value={attDeptFilter}
                  onChange={(e) => setAttDeptFilter(e.target.value)}
                  className="px-2.5 py-1 border border-slate-300 rounded bg-white"
                >
                  <option value="all">All Departments</option>
                  {DEPARTMENTS.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-slate-500">
                    <th className="py-2.5 px-4">Date</th>
                    <th className="py-2.5 px-4">Employee</th>
                    <th className="py-2.5 px-4">Department</th>
                    <th className="py-2.5 px-4">Check-In / Out</th>
                    <th className="py-2.5 px-4 text-right">Hours</th>
                    <th className="py-2.5 px-4">Status &amp; Flags</th>
                    <th className="py-2.5 px-4 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredAttendance.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="py-8 text-center text-slate-500">
                        No attendance logs for the selected filter.
                      </td>
                    </tr>
                  ) : (
                    filteredAttendance.map((att) => (
                      <tr key={att.id}>
                        <td className="py-2.5 px-4 font-mono text-slate-700">{att.attendance_date}</td>
                        <td className="py-2.5 px-4">
                          <span className="font-medium text-slate-900">{att.full_name}</span>
                          <span className="ml-1.5 font-mono text-slate-500">{att.employee_number}</span>
                        </td>
                        <td className="py-2.5 px-4 text-slate-600">{att.department_name}</td>
                        <td className="py-2.5 px-4 font-mono text-slate-700">
                          {att.check_in || '—'} → {att.check_out || '—'}
                        </td>
                        <td className="py-2.5 px-4 text-right font-mono tabular-nums font-medium">
                          {Number(att.hours_worked || 0).toFixed(2)}
                        </td>
                        <td className="py-2.5 px-4 text-xs">
                          <span
                            className={`font-mono font-semibold capitalize ${
                              att.status === 'present'
                                ? 'text-emerald-700'
                                : att.status === 'absent'
                                  ? 'text-red-700'
                                  : 'text-amber-700'
                            }`}
                          >
                            {att.status.replace('_', ' ')}
                          </span>
                          {(att.late_minutes > 0 || att.early_leave_minutes > 0) && (
                            <span className="ml-2 text-slate-500 font-mono">
                              {att.late_minutes > 0 ? `+${att.late_minutes}m late` : ''}
                              {att.early_leave_minutes > 0 ? ` -${att.early_leave_minutes}m early` : ''}
                            </span>
                          )}
                          {att.notes && <div className="text-slate-500">{att.notes}</div>}
                        </td>
                        <td className="py-2.5 px-4 text-right">
                          <button
                            onClick={() => {
                              setAttEditTarget(att);
                              setAttDate(att.attendance_date);
                              setAttCheckIn(att.check_in || '08:00');
                              setAttCheckOut(att.check_out || '17:00');
                              setAttStatus(att.status);
                              setAttHoursOverride(String(att.hours_worked || ''));
                              setAttNotes(att.notes || '');
                            }}
                            className="px-2 py-1 text-xs font-medium text-slate-700 border border-slate-200 hover:bg-slate-50 rounded"
                          >
                            Correct
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* 3. LEAVE & BALANCES */}
      {data && subTab === 'leave' && (
        <div className="space-y-4">
          {canManageHr && (
            <div className="flex flex-wrap items-center justify-between gap-3 bg-white border border-slate-200 rounded-lg p-3.5">
              <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg text-xs">
                <button
                  onClick={() => setLeaveViewSection('requests')}
                  className={`px-3 py-1.5 rounded-md font-medium transition-colors ${
                    leaveViewSection === 'requests' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Leave Requests ({data.leaveRequests.length})
                </button>
                <button
                  onClick={() => setLeaveViewSection('balances')}
                  className={`px-3 py-1.5 rounded-md font-medium transition-colors ${
                    leaveViewSection === 'balances' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Employee Leave Balances ({data.leaveBalances.length})
                </button>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setLeaveTypeModalOpen(true)}
                  className="px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-200 hover:bg-slate-50 rounded-md"
                >
                  Define Leave Type ({data.leaveTypes.length})
                </button>
                <button
                  onClick={() => {
                    if (activeEmployees.length > 0 && !lEmployeeId) setLEmployeeId(String(activeEmployees[0].id));
                    setLeaveOpen(true);
                  }}
                  className="px-3 py-1.5 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md"
                >
                  Register Staff Leave
                </button>
              </div>
            </div>
          )}

          {(!canManageHr || leaveViewSection === 'requests') && (
            <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
              <div className="px-5 py-3.5 border-b border-slate-200">
                <h2 className="font-display text-sm font-semibold text-slate-900">
                  {canManageHr ? 'Staff Leave Approvals (Auto-Blocks Doctor Schedule on Approval)' : 'My Leave Requests'}
                </h2>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-slate-500">
                      <th className="py-2.5 px-4">Staff</th>
                      <th className="py-2.5 px-4">Type</th>
                      <th className="py-2.5 px-4">Dates</th>
                      <th className="py-2.5 px-4">Reason</th>
                      <th className="py-2.5 px-4">Status</th>
                      {canManageHr && <th className="py-2.5 px-4 text-right">Action</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.leaveRequests.length === 0 ? (
                      <tr>
                        <td colSpan={canManageHr ? 6 : 5} className="py-8 text-center text-slate-500">
                          No leave requests recorded yet.
                        </td>
                      </tr>
                    ) : (
                      data.leaveRequests.map((lr) => (
                        <tr key={lr.id}>
                          <td className="py-2.5 px-4">
                            <span className="font-medium text-slate-900">{lr.staff_name}</span>
                            <span className="ml-1.5 font-mono text-slate-500">
                              {lr.employee_number || lr.role_code}
                            </span>
                          </td>
                          <td className="py-2.5 px-4 capitalize">{lr.leave_type}</td>
                          <td className="py-2.5 px-4 font-mono">
                            {lr.start_date} to {lr.end_date} ({lr.days_count}d)
                          </td>
                          <td className="py-2.5 px-4 text-slate-600">{lr.reason}</td>
                          <td className="py-2.5 px-4 capitalize font-semibold">
                            <span
                              className={
                                lr.status === 'approved'
                                  ? 'text-emerald-700'
                                  : lr.status === 'rejected'
                                    ? 'text-red-700'
                                    : 'text-amber-700'
                              }
                            >
                              {lr.status}
                            </span>
                          </td>
                          {canManageHr && (
                            <td className="py-2.5 px-4 text-right">
                              <div className="inline-flex items-center gap-1.5">
                                {lr.status === 'pending' && (
                                  <>
                                    <button
                                      onClick={() => handleDecideLeave(lr.id, 'approved')}
                                      className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-white bg-emerald-700 hover:bg-emerald-800 rounded whitespace-nowrap"
                                    >
                                      <Check className="w-3 h-3" />
                                      <span>Approve</span>
                                    </button>
                                    <button
                                      onClick={() => {
                                        setLeaveDecisionNote('');
                                        setLeaveDecisionTarget({ lr, decision: 'rejected' });
                                      }}
                                      className="px-2.5 py-1 text-xs font-medium text-red-700 border border-red-200 hover:bg-red-50 rounded"
                                    >
                                      Reject
                                    </button>
                                  </>
                                )}
                                {(lr.status === 'pending' || lr.status === 'approved') && (
                                  <button
                                    onClick={() => {
                                      setLeaveDecisionNote('');
                                      setLeaveDecisionTarget({ lr, decision: 'cancelled' });
                                    }}
                                    className="px-2.5 py-1 text-xs font-medium text-slate-700 border border-slate-200 hover:bg-slate-50 rounded"
                                  >
                                    Cancel Leave
                                  </button>
                                )}
                              </div>
                            </td>
                          )}
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {canManageHr && leaveViewSection === 'balances' && (
            <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
              <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
                <h2 className="font-display text-sm font-semibold text-slate-900">Annual Employee Leave Balances ({new Date().getUTCFullYear()})</h2>
                <span className="text-xs font-mono text-slate-500">{data.leaveBalances.length} ledger rows</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-slate-500">
                      <th className="py-2.5 px-4">Emp #</th>
                      <th className="py-2.5 px-4">Employee</th>
                      <th className="py-2.5 px-4">Department</th>
                      <th className="py-2.5 px-4">Leave Type</th>
                      <th className="py-2.5 px-4 text-right">Entitled</th>
                      <th className="py-2.5 px-4 text-right">Used</th>
                      <th className="py-2.5 px-4 text-right">Pending</th>
                      <th className="py-2.5 px-4 text-right">Remaining</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.leaveBalances.map((lb, idx) => (
                      <tr key={`${lb.employee_id}-${lb.leave_type_code}-${idx}`}>
                        <td className="py-2 px-4 font-mono text-slate-700">{lb.employee_number}</td>
                        <td className="py-2 px-4 font-medium text-slate-900">{lb.full_name}</td>
                        <td className="py-2 px-4 text-slate-600">{lb.department_name}</td>
                        <td className="py-2 px-4">{lb.leave_type_name}</td>
                        <td className="py-2 px-4 text-right font-mono tabular-nums">{lb.annual_allowance_days}d</td>
                        <td className="py-2 px-4 text-right font-mono tabular-nums text-slate-700">{lb.used_days}d</td>
                        <td className="py-2 px-4 text-right font-mono tabular-nums text-amber-700">{lb.pending_days}d</td>
                        <td className="py-2 px-4 text-right font-mono tabular-nums font-semibold text-teal-800">
                          {lb.remaining_days}d
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 4. OVERTIME MANAGEMENT */}
      {canOvertime && subTab === 'overtime' && data && (
        <div className="space-y-4">
          <div className="bg-white border border-slate-200 rounded-lg p-5">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3 pb-2 border-b border-slate-100">
              <h2 className="font-display text-sm font-semibold text-slate-900">Register Employee Overtime</h2>
              <span className="text-xs font-mono text-slate-600 tabular-nums">
                Est. Rate ${otPreview.rate.toFixed(2)}/hr × {otMult}x ={' '}
                <strong className="text-teal-800">${otPreview.amount.toFixed(2)}</strong>
              </span>
            </div>
            <form onSubmit={handleCreateOvertime} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3 text-xs items-end">
              <div className="lg:col-span-2">
                <label className="block font-medium text-slate-700 mb-1">Employee *</label>
                <select
                  required
                  value={otEmpId}
                  onChange={(e) => setOtEmpId(e.target.value)}
                  className="w-full px-2.5 py-2 border border-slate-300 rounded-md bg-white"
                >
                  {activeEmployees.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.employee_number} · {e.full_name} (${Number(e.basic_salary).toFixed(0)})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Overtime Date *</label>
                <input
                  type="date"
                  required
                  value={otDate}
                  onChange={(e) => setOtDate(e.target.value)}
                  className="w-full px-2.5 py-2 border border-slate-300 rounded-md font-mono"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Day Type</label>
                <select
                  value={otDayType}
                  onChange={(e) => {
                    const dt = e.target.value as 'regular' | 'weekend' | 'holiday';
                    setOtDayType(dt);
                    setOtMult(dt === 'holiday' ? '2.5' : dt === 'weekend' ? '2.0' : '1.5');
                  }}
                  className="w-full px-2.5 py-2 border border-slate-300 rounded-md bg-white"
                >
                  <option value="regular">Regular Day (1.5x)</option>
                  <option value="weekend">Weekend (2.0x)</option>
                  <option value="holiday">Public Holiday (2.5x)</option>
                </select>
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Hours *</label>
                <input
                  type="number"
                  step="0.5"
                  min="0.5"
                  required
                  value={otHours}
                  onChange={(e) => setOtHours(e.target.value)}
                  className="w-full px-2.5 py-2 border border-slate-300 rounded-md font-mono"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Multiplier</label>
                <input
                  type="number"
                  step="0.1"
                  min="1"
                  required
                  value={otMult}
                  onChange={(e) => setOtMult(e.target.value)}
                  className="w-full px-2.5 py-2 border border-slate-300 rounded-md font-mono"
                />
              </div>
              <div className="lg:col-span-5">
                <label className="block font-medium text-slate-700 mb-1">Duty / Clinical Coverage Reason *</label>
                <input
                  required
                  value={otReason}
                  onChange={(e) => setOtReason(e.target.value)}
                  placeholder="e.g. Extended emergency shift coverage or night lab batch"
                  className="w-full px-3 py-2 border border-slate-300 rounded-md"
                />
              </div>
              <div>
                <button
                  type="submit"
                  className="w-full px-4 py-2 bg-teal-700 hover:bg-teal-800 text-white rounded-md font-medium whitespace-nowrap"
                >
                  Log Overtime
                </button>
              </div>
            </form>
          </div>

          <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
              <h2 className="font-display text-sm font-semibold text-slate-900">Overtime Requests &amp; Payroll Inclusion</h2>
              <span className="text-xs font-mono text-slate-500">
                Approved unpaid OT totals $
                {data.overtime
                  .filter((o) => o.status === 'approved' && !o.payroll_run_id)
                  .reduce((s, o) => s + Number(o.computed_amount || 0), 0)
                  .toFixed(2)}
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-slate-500">
                    <th className="py-2.5 px-4">Date</th>
                    <th className="py-2.5 px-4">Employee</th>
                    <th className="py-2.5 px-4">Type &amp; Reason</th>
                    <th className="py-2.5 px-4 text-right">Hours</th>
                    <th className="py-2.5 px-4 text-right">Rate × Mult</th>
                    <th className="py-2.5 px-4 text-right">Payable</th>
                    <th className="py-2.5 px-4">Status</th>
                    <th className="py-2.5 px-4 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.overtime.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="py-8 text-center text-slate-500">
                        No overtime records logged yet.
                      </td>
                    </tr>
                  ) : (
                    data.overtime.map((ot) => (
                      <tr key={ot.id}>
                        <td className="py-2.5 px-4 font-mono">{ot.overtime_date}</td>
                        <td className="py-2.5 px-4">
                          <div className="font-medium text-slate-900">{ot.full_name}</div>
                          <div className="font-mono text-slate-500">{ot.employee_number} · {ot.department_name}</div>
                        </td>
                        <td className="py-2.5 px-4">
                          <div className="capitalize font-medium text-slate-800">{ot.day_type}</div>
                          <div className="text-slate-500">{ot.reason}</div>
                        </td>
                        <td className="py-2.5 px-4 text-right font-mono tabular-nums">{Number(ot.hours).toFixed(2)}</td>
                        <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-600">
                          ${Number(ot.hourly_rate_snapshot).toFixed(2)} × {ot.rate_multiplier}x
                        </td>
                        <td className="py-2.5 px-4 text-right font-mono tabular-nums font-semibold text-slate-900">
                          ${Number(ot.computed_amount).toFixed(2)}
                        </td>
                        <td className="py-2.5 px-4 font-mono capitalize font-semibold">
                          <span
                            className={
                              ot.status === 'approved'
                                ? 'text-emerald-700'
                                : ot.status === 'rejected'
                                  ? 'text-red-700'
                                  : 'text-amber-700'
                            }
                          >
                            {ot.status}
                          </span>
                          {ot.payroll_run_id && <div className="text-[11px] text-slate-500 font-normal">In payroll run</div>}
                        </td>
                        <td className="py-2.5 px-4 text-right">
                          {ot.status === 'pending' && (
                            <div className="inline-flex items-center gap-1.5">
                              <button
                                onClick={() => handleDecideOvertime(ot.id, 'approved')}
                                className="px-2.5 py-1 text-xs font-medium text-white bg-emerald-700 hover:bg-emerald-800 rounded"
                              >
                                Approve
                              </button>
                              <button
                                onClick={() => handleDecideOvertime(ot.id, 'rejected')}
                                className="px-2.5 py-1 text-xs font-medium text-red-700 border border-red-200 hover:bg-red-50 rounded"
                              >
                                Reject
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* 5. ADDITIONAL EARNINGS & DEDUCTIONS */}
      {(canManageHr || canSubmitPayroll) && subTab === 'adjustments' && data && (
        <div className="space-y-4">
          <div className="bg-white border border-slate-200 rounded-lg p-5">
            <div className="flex items-center gap-2 mb-3 pb-2 border-b border-slate-100">
              <DollarSign className="w-4 h-4 text-teal-700" />
              <h2 className="font-display text-sm font-semibold text-slate-900">
                Add Employee Allowance, Bonus, Loan or Deduction
              </h2>
            </div>
            <form onSubmit={handleCreateAdjustment} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3 text-xs items-end">
              <div className="lg:col-span-2">
                <label className="block font-medium text-slate-700 mb-1">Employee *</label>
                <select
                  required
                  value={adjEmpId}
                  onChange={(e) => setAdjEmpId(e.target.value)}
                  className="w-full px-2.5 py-2 border border-slate-300 rounded-md bg-white"
                >
                  {activeEmployees.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.employee_number} · {e.full_name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Type *</label>
                <select
                  value={adjType}
                  onChange={(e) => {
                    const t = e.target.value as 'earning' | 'deduction';
                    setAdjType(t);
                    setAdjCategory(t === 'earning' ? 'Transport Allowance' : 'Salary Advance');
                  }}
                  className="w-full px-2.5 py-2 border border-slate-300 rounded-md bg-white"
                >
                  <option value="earning">Additional Earning</option>
                  <option value="deduction">Employee Deduction</option>
                </select>
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Category *</label>
                <input
                  required
                  list="hr-adj-categories"
                  value={adjCategory}
                  onChange={(e) => setAdjCategory(e.target.value)}
                  className="w-full px-2.5 py-2 border border-slate-300 rounded-md"
                />
                <datalist id="hr-adj-categories">
                  <option value="Transport Allowance" />
                  <option value="Housing Allowance" />
                  <option value="Medical Allowance" />
                  <option value="Meal Allowance" />
                  <option value="Bonus" />
                  <option value="Incentive" />
                  <option value="Loan Repayment" />
                  <option value="Salary Advance" />
                  <option value="Penalty" />
                  <option value="Unpaid Leave" />
                </datalist>
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Amount ($) *</label>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  required
                  value={adjAmount}
                  onChange={(e) => setAdjAmount(e.target.value)}
                  className="w-full px-2.5 py-2 border border-slate-300 rounded-md font-mono"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Effective Month *</label>
                <input
                  type="month"
                  required
                  value={adjMonth}
                  onChange={(e) => setAdjMonth(e.target.value)}
                  className="w-full px-2.5 py-2 border border-slate-300 rounded-md font-mono"
                />
              </div>
              <div className="lg:col-span-4">
                <label className="block font-medium text-slate-700 mb-1">Description / Justification *</label>
                <input
                  required
                  value={adjDesc}
                  onChange={(e) => setAdjDesc(e.target.value)}
                  placeholder="e.g. Monthly transport stipend or salary advance installment 1 of 3"
                  className="w-full px-3 py-2 border border-slate-300 rounded-md"
                />
              </div>
              <div className="flex items-center gap-2 py-2">
                <input
                  id="adj-recurring"
                  type="checkbox"
                  checked={adjRecurring}
                  onChange={(e) => setAdjRecurring(e.target.checked)}
                />
                <label htmlFor="adj-recurring" className="text-slate-700 font-medium">
                  Recurring Monthly
                </label>
              </div>
              <div>
                <button
                  type="submit"
                  className="w-full px-4 py-2 bg-teal-700 hover:bg-teal-800 text-white rounded-md font-medium whitespace-nowrap"
                >
                  Save Adjustment
                </button>
              </div>
            </form>
          </div>

          <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
              <h2 className="font-display text-sm font-semibold text-slate-900">Employee Earnings &amp; Deductions Ledger</h2>
              <span className="text-xs font-mono text-slate-500">{data.adjustments.length} records</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-slate-500">
                    <th className="py-2.5 px-4">Employee</th>
                    <th className="py-2.5 px-4">Type</th>
                    <th className="py-2.5 px-4">Category &amp; Description</th>
                    <th className="py-2.5 px-4">Period</th>
                    <th className="py-2.5 px-4 text-right">Amount</th>
                    <th className="py-2.5 px-4">Status</th>
                    <th className="py-2.5 px-4 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.adjustments.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="py-8 text-center text-slate-500">
                        No allowances or deductions registered yet.
                      </td>
                    </tr>
                  ) : (
                    data.adjustments.map((adj) => (
                      <tr key={adj.id}>
                        <td className="py-2.5 px-4">
                          <div className="font-medium text-slate-900">{adj.full_name}</div>
                          <div className="font-mono text-slate-500">{adj.employee_number} · {adj.department_name}</div>
                        </td>
                        <td className="py-2.5 px-4 font-mono uppercase text-[11px]">
                          <span className={adj.adjustment_type === 'earning' ? 'text-emerald-700 font-semibold' : 'text-red-700 font-semibold'}>
                            {adj.adjustment_type}
                          </span>
                        </td>
                        <td className="py-2.5 px-4">
                          <div className="font-medium text-slate-900">{adj.category}</div>
                          <div className="text-slate-500">{adj.description}</div>
                        </td>
                        <td className="py-2.5 px-4 font-mono">
                          {adj.effective_month} {adj.recurring ? '· Recurring' : '· One-time'}
                        </td>
                        <td className="py-2.5 px-4 text-right font-mono tabular-nums font-semibold">
                          ${Number(adj.amount).toFixed(2)}
                        </td>
                        <td className="py-2.5 px-4 font-mono capitalize">
                          <span className={adj.status === 'active' ? 'text-emerald-700 font-semibold' : 'text-slate-400'}>
                            {adj.status}
                          </span>
                        </td>
                        <td className="py-2.5 px-4 text-right">
                          {adj.status === 'active' && (
                            <button
                              onClick={() => handleCancelAdjustment(adj.id)}
                              className="px-2 py-1 text-xs font-medium text-red-700 border border-red-200 hover:bg-red-50 rounded"
                            >
                              Cancel
                            </button>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* 6. MONTHLY PAYROLL INPUT SUBMISSION TO FINANCE */}
      {canSubmitPayroll && subTab === 'submission' && data && (
        <div className="space-y-4">
          <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3">
              <div>
                <h2 className="font-display text-sm font-semibold text-slate-900">
                  Compile &amp; Submit Monthly HR Payroll Inputs to Finance
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  HR prepares employee attendance, leave, approved overtime, and adjustments. Finance generates, verifies, posts, and pays salaries.
                </p>
              </div>
              <div className="flex items-center gap-2 text-xs">
                <label className="font-medium text-slate-700">Pay Month:</label>
                <input
                  type="month"
                  value={submitMonth}
                  onChange={(e) => setSubmitMonth(e.target.value)}
                  className="px-2.5 py-1.5 border border-slate-300 rounded-md font-mono"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
              <div className="p-3 bg-slate-50 border border-slate-200 rounded-md">
                <div className="text-[11px] text-slate-500">Eligible Active Staff</div>
                <div className="font-mono text-base font-semibold text-slate-900 tabular-nums mt-0.5">{submissionPreview.headcount}</div>
              </div>
              <div className="p-3 bg-slate-50 border border-slate-200 rounded-md">
                <div className="text-[11px] text-slate-500">Attendance Hours</div>
                <div className="font-mono text-base font-semibold text-slate-900 tabular-nums mt-0.5">
                  {submissionPreview.attHours.toFixed(1)} hrs
                </div>
              </div>
              <div className="p-3 bg-slate-50 border border-slate-200 rounded-md">
                <div className="text-[11px] text-slate-500">Approved Overtime</div>
                <div className="font-mono text-base font-semibold text-emerald-700 tabular-nums mt-0.5">
                  ${submissionPreview.approvedOt.toFixed(2)}
                </div>
              </div>
              <div className="p-3 bg-slate-50 border border-slate-200 rounded-md">
                <div className="text-[11px] text-slate-500">Extra Earnings</div>
                <div className="font-mono text-base font-semibold text-teal-800 tabular-nums mt-0.5">
                  ${submissionPreview.extraEarn.toFixed(2)}
                </div>
              </div>
              <div className="p-3 bg-slate-50 border border-slate-200 rounded-md">
                <div className="text-[11px] text-slate-500">Extra Deductions</div>
                <div className="font-mono text-base font-semibold text-red-700 tabular-nums mt-0.5">
                  ${submissionPreview.extraDed.toFixed(2)}
                </div>
              </div>
            </div>

            <form onSubmit={handleSubmitPayrollInputs} className="flex flex-col sm:flex-row items-stretch sm:items-end gap-3 text-xs">
              <div className="flex-1">
                <label className="block font-medium text-slate-700 mb-1">Handoff Notes for Finance (Optional)</label>
                <input
                  value={submitNotes}
                  onChange={(e) => setSubmitNotes(e.target.value)}
                  placeholder="e.g. Verified all attendance sheets, 2 locum overtime approvals, and housing stipends"
                  className="w-full px-3 py-2 border border-slate-300 rounded-md"
                />
              </div>
              <button
                type="submit"
                className="inline-flex items-center justify-center gap-1.5 px-4 py-2 bg-teal-700 hover:bg-teal-800 text-white rounded-md font-medium whitespace-nowrap"
              >
                <Send className="w-3.5 h-3.5" />
                <span>Submit {submitMonth} Inputs to Finance</span>
              </button>
            </form>
          </div>

          <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200">
              <h2 className="font-display text-sm font-semibold text-slate-900">HR Monthly Submission History</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-slate-500">
                    <th className="py-2.5 px-4">Month</th>
                    <th className="py-2.5 px-4 text-right">Headcount</th>
                    <th className="py-2.5 px-4 text-right">Att. Hours</th>
                    <th className="py-2.5 px-4 text-right">Approved OT</th>
                    <th className="py-2.5 px-4 text-right">Extra Earnings</th>
                    <th className="py-2.5 px-4 text-right">Extra Deductions</th>
                    <th className="py-2.5 px-4">Status &amp; Submitted By</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.monthlySubmissions.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="py-8 text-center text-slate-500">
                        No monthly HR payroll submissions sent to Finance yet.
                      </td>
                    </tr>
                  ) : (
                    data.monthlySubmissions.map((sub) => (
                      <tr key={sub.id}>
                        <td className="py-2.5 px-4 font-mono font-semibold text-slate-900">{sub.pay_month}</td>
                        <td className="py-2.5 px-4 text-right font-mono tabular-nums">{sub.total_employees}</td>
                        <td className="py-2.5 px-4 text-right font-mono tabular-nums">
                          {Number(sub.total_attendance_hours).toFixed(1)}
                        </td>
                        <td className="py-2.5 px-4 text-right font-mono tabular-nums">
                          ${Number(sub.total_overtime_amount).toFixed(2)}
                        </td>
                        <td className="py-2.5 px-4 text-right font-mono tabular-nums">
                          ${Number(sub.total_extra_earnings).toFixed(2)}
                        </td>
                        <td className="py-2.5 px-4 text-right font-mono tabular-nums">
                          ${Number(sub.total_extra_deductions).toFixed(2)}
                        </td>
                        <td className="py-2.5 px-4">
                          <span
                            className={`font-mono uppercase font-semibold ${
                              sub.status === 'processed' ? 'text-emerald-700' : 'text-teal-800'
                            }`}
                          >
                            {sub.status}
                          </span>
                          <span className="ml-2 text-slate-500">by {sub.submitted_by_name || 'HRO'}</span>
                          {sub.notes && <div className="text-slate-500">{sub.notes}</div>}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* 7. HR REPORTS */}
      {data?.isHrManager && subTab === 'reports' && (
        <div className="space-y-4">
          <div className="bg-white border border-slate-200 rounded-lg p-4 flex flex-wrap items-end justify-between gap-4 no-print">
            <div className="flex flex-wrap items-end gap-3 text-xs">
              <div>
                <label className="block font-medium text-slate-700 mb-1">HR Report Template</label>
                <select
                  value={hrReportType}
                  onChange={(e) => setHrReportType(e.target.value as HrReportType)}
                  className="px-3 py-1.5 border border-slate-300 rounded-md bg-white"
                >
                  {(Object.keys(HR_REPORT_LABELS) as HrReportType[]).map((key) => (
                    <option key={key} value={key}>
                      {HR_REPORT_LABELS[key]}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Period Month</label>
                <input
                  type="month"
                  value={hrReportMonth}
                  onChange={(e) => setHrReportMonth(e.target.value)}
                  className="px-2.5 py-1.5 border border-slate-300 rounded-md font-mono"
                />
              </div>
              <button
                onClick={loadHrReport}
                className="px-3 py-1.5 text-white bg-teal-700 hover:bg-teal-800 rounded-md font-medium whitespace-nowrap"
              >
                Run Report
              </button>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={exportHrReportCsv}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-200 hover:bg-slate-50 rounded-md whitespace-nowrap"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Export CSV</span>
              </button>
              <button
                onClick={() => window.print()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-200 hover:bg-slate-50 rounded-md whitespace-nowrap"
              >
                <Printer className="w-3.5 h-3.5" />
                <span>Print / PDF</span>
              </button>
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FileText className="w-4 h-4 text-teal-700" />
                <h2 className="font-display text-sm font-semibold text-slate-900">{HR_REPORT_LABELS[hrReportType]}</h2>
              </div>
              <span className="text-xs font-mono text-slate-500">
                Month {hrReportMonth} · {hrReportRows.length} rows
              </span>
            </div>
            {hrReportLoading ? (
              <div className="p-8 text-center text-xs text-slate-500">Compiling HR report...</div>
            ) : hrReportRows.length === 0 ? (
              <div className="p-8 text-center text-xs text-slate-500">No HR records found for this filter.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-slate-500">
                      {Object.keys(hrReportRows[0]).map((col) => (
                        <th key={col} className="py-2.5 px-4 uppercase tracking-wider font-medium">
                          {col.replace(/_/g, ' ')}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {hrReportRows.map((row, idx) => (
                      <tr key={idx}>
                        {Object.entries(row).map(([k, val]) => (
                          <td key={k} className="py-2 px-4 font-mono text-slate-800 whitespace-nowrap tabular-nums">
                            {val === null || val === undefined ? '—' : String(val)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* PAYROLL APPROVALS (for Finance/Manager quick access if arriving from HR tab) */}
      {data?.canViewPayroll && subTab === 'payroll' && (
        <div className="space-y-4">
          <div className="bg-white border border-slate-200 rounded-lg p-4 text-xs text-slate-600 flex flex-wrap items-center justify-between gap-2">
            <span>Payroll Generation, GL Posting &amp; Individual Employee Disbursements live under Finance &amp; Reports → Payroll Processing.</span>
            <span className="font-mono text-slate-500">Draft → Verify → Approve → Post GL → Pay Staff</span>
          </div>
          {data.payrollRuns.map((run) => (
            <div key={run.id} className="bg-white border border-slate-200 rounded-lg overflow-hidden">
              <div className="px-5 py-3.5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3 text-xs">
                <div className="space-y-1">
                  <div>
                    <span className="font-mono font-semibold text-teal-800 mr-2">{run.run_number}</span>
                    <span className="font-semibold text-slate-900">Period {run.pay_month}</span>
                    <span className="ml-2 font-mono uppercase text-slate-600">{run.status}</span>
                    <span className="mx-2 text-slate-300">·</span>
                    <span className="font-mono tabular-nums">
                      Gross ${Number(run.total_gross).toFixed(2)} · Net ${Number(run.total_net).toFixed(2)}
                    </span>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {run.status === 'draft' && canVerifyPayroll && (
                    <button
                      onClick={() => handleVerifyPayroll(run.id)}
                      className="px-3 py-1.5 text-xs font-medium text-white bg-sky-700 hover:bg-sky-800 rounded"
                    >
                      Verify (Finance)
                    </button>
                  )}
                  {(run.status === 'draft' || run.status === 'verified') && canApprovePayroll && (
                    <button
                      onClick={() => handleApprovePayroll(run.id)}
                      className="px-3 py-1.5 text-xs font-medium text-white bg-indigo-700 hover:bg-indigo-800 rounded"
                    >
                      Approve Run
                    </button>
                  )}
                  {run.status === 'approved' && canPostPayroll && (
                    <button
                      onClick={() => handlePostPayroll(run.id)}
                      className="px-3 py-1.5 text-xs font-medium text-white bg-emerald-700 hover:bg-emerald-800 rounded"
                    >
                      Post to GL
                    </button>
                  )}
                  {(run.status === 'posted' || run.status === 'partially_paid') && canPayPayroll && (
                    <button
                      onClick={() => handlePayPayroll(run.id)}
                      className="px-3 py-1.5 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded"
                    >
                      Disburse All Remaining
                    </button>
                  )}
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-slate-500">
                      <th className="py-2 px-4">Staff Member</th>
                      <th className="py-2 px-4 text-right">Base</th>
                      <th className="py-2 px-4 text-right">Allow. + OT + Bonus</th>
                      <th className="py-2 px-4 text-right">PAYE + Pension + Other</th>
                      <th className="py-2 px-4 text-right">Net Pay</th>
                      <th className="py-2 px-4 text-right">Paid</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {run.items.map((it) => (
                      <tr key={it.id}>
                        <td className="py-2 px-4 font-medium text-slate-900">{it.staff_name}</td>
                        <td className="py-2 px-4 text-right font-mono tabular-nums">${Number(it.base_salary).toFixed(2)}</td>
                        <td className="py-2 px-4 text-right font-mono tabular-nums">
                          ${(Number(it.allowances) + Number(it.overtime_pay || 0) + Number(it.bonus_earnings || 0)).toFixed(2)}
                        </td>
                        <td className="py-2 px-4 text-right font-mono tabular-nums">${Number(it.tax_deduction).toFixed(2)}</td>
                        <td className="py-2 px-4 text-right font-mono font-semibold tabular-nums">${Number(it.net_pay).toFixed(2)}</td>
                        <td className="py-2 px-4 text-right font-mono tabular-nums text-emerald-700">
                          ${Number(it.paid_amount || 0).toFixed(2)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 8. MY PAYSLIPS */}
      {subTab === 'payslips' && (
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-200 flex items-center gap-2">
            <FileText className="w-4 h-4 text-teal-700" />
            <h2 className="font-display text-sm font-semibold text-slate-900">My Approved &amp; Disbursed Payslips</h2>
          </div>
          {payslips.length === 0 ? (
            <div className="p-10 text-center text-sm text-slate-500">
              No approved or disbursed payslips recorded for your account yet.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-slate-500">
                    <th className="py-2.5 px-4">Period &amp; Run</th>
                    <th className="py-2.5 px-4">Status</th>
                    <th className="py-2.5 px-4 text-right">Base Salary</th>
                    <th className="py-2.5 px-4 text-right">Allowances &amp; OT</th>
                    <th className="py-2.5 px-4 text-right">PAYE &amp; Pension</th>
                    <th className="py-2.5 px-4 text-right">Net Pay</th>
                    <th className="py-2.5 px-4 text-right">Payslip</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {payslips.map((ps) => (
                    <tr key={ps.id}>
                      <td className="py-2.5 px-4 font-mono">
                        <div className="font-semibold text-slate-900">{ps.pay_month}</div>
                        <div className="text-slate-500">{ps.run_number}</div>
                      </td>
                      <td className="py-2.5 px-4 font-mono capitalize text-emerald-700 font-semibold">
                        {ps.payment_status || ps.run_status}
                      </td>
                      <td className="py-2.5 px-4 text-right font-mono tabular-nums">${Number(ps.base_salary).toFixed(2)}</td>
                      <td className="py-2.5 px-4 text-right font-mono tabular-nums">
                        ${(Number(ps.allowances) + Number(ps.overtime_pay || 0) + Number(ps.bonus_earnings || 0)).toFixed(2)}
                      </td>
                      <td className="py-2.5 px-4 text-right font-mono tabular-nums">
                        ${Number(ps.tax_deduction).toFixed(2)}
                      </td>
                      <td className="py-2.5 px-4 text-right font-mono font-semibold text-teal-800 tabular-nums">
                        ${Number(ps.net_pay).toFixed(2)}
                      </td>
                      <td className="py-2.5 px-4 text-right">
                        <button
                          onClick={() => setPrintPayslip(ps)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-700 border border-slate-200 hover:bg-slate-50 rounded"
                        >
                          <Printer className="w-3 h-3" />
                          <span>Print Payslip</span>
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* REGISTER / EDIT EMPLOYEE MODAL */}
      {empModalOpen && data && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4 no-print">
          <div className="bg-white border border-slate-200 rounded-lg w-full max-w-2xl max-h-[90vh] overflow-y-auto p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-display text-base font-semibold text-slate-900">
                {editingEmp ? `Edit Employee · ${editingEmp.employee_number}` : 'Register Clinic Employee'}
              </h3>
              <button onClick={() => setEmpModalOpen(false)} className="text-slate-400 hover:text-slate-600">
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleSaveEmployee} className="space-y-3 text-xs">
              {!editingEmp && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block font-medium text-slate-700 mb-1">Link System User (Optional)</label>
                    <select
                      value={fUserId}
                      onChange={(e) => {
                        const uid = e.target.value;
                        setFUserId(uid);
                        const u = unlinkedUsers.find((x) => String(x.id) === uid);
                        if (u) {
                          if (!fFullName) setFFullName(u.full_name);
                          if (!fEmail) setFEmail(u.email);
                          if (!fPosition) setFPosition(u.role_name);
                        }
                      }}
                      className="w-full px-2.5 py-2 border border-slate-300 rounded-md bg-white"
                    >
                      <option value="">No system login (Non-login clinic staff)</option>
                      {unlinkedUsers.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.full_name} ({u.role_code})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block font-medium text-slate-700 mb-1">Employee Number (blank = auto EMP-...)</label>
                    <input
                      value={fEmpNum}
                      onChange={(e) => setFEmpNum(e.target.value)}
                      placeholder="Auto-generated if blank"
                      className="w-full px-3 py-2 border border-slate-300 rounded-md font-mono"
                    />
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="sm:col-span-2">
                  <label className="block font-medium text-slate-700 mb-1">Full Name *</label>
                  <input
                    required
                    value={fFullName}
                    onChange={(e) => setFFullName(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-md"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Gender</label>
                  <select
                    value={fGender}
                    onChange={(e) => setFGender(e.target.value)}
                    className="w-full px-2.5 py-2 border border-slate-300 rounded-md bg-white"
                  >
                    <option value="female">Female</option>
                    <option value="male">Male</option>
                    <option value="other">Other</option>
                    <option value="unspecified">Unspecified</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Phone</label>
                  <input
                    value={fPhone}
                    onChange={(e) => setFPhone(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-md font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Email</label>
                  <input
                    type="email"
                    value={fEmail}
                    onChange={(e) => setFEmail(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-md"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Residential Address</label>
                  <input
                    value={fAddress}
                    onChange={(e) => setFAddress(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-md"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Emergency Contact Name</label>
                  <input
                    value={fEmergName}
                    onChange={(e) => setFEmergName(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-md"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Emergency Contact Phone</label>
                  <input
                    value={fEmergPhone}
                    onChange={(e) => setFEmergPhone(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-md font-mono"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Department *</label>
                  <input
                    required
                    list="hr-dept-list"
                    value={fDept}
                    onChange={(e) => setFDept(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-md"
                  />
                  <datalist id="hr-dept-list">
                    {DEPARTMENTS.map((d) => (
                      <option key={d} value={d} />
                    ))}
                  </datalist>
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Job Position *</label>
                  <input
                    required
                    value={fPosition}
                    onChange={(e) => setFPosition(e.target.value)}
                    placeholder="e.g. Senior Nurse, Lab Tech"
                    className="w-full px-3 py-2 border border-slate-300 rounded-md"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Employment Type *</label>
                  <select
                    value={fEmpType}
                    onChange={(e) => setFEmpType(e.target.value as typeof fEmpType)}
                    className="w-full px-2.5 py-2 border border-slate-300 rounded-md bg-white"
                  >
                    <option value="full_time">Full Time</option>
                    <option value="part_time">Part Time</option>
                    <option value="contract">Contract</option>
                    <option value="locum">Locum</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Hire Date *</label>
                  <input
                    type="date"
                    required
                    value={fHireDate}
                    onChange={(e) => setFHireDate(e.target.value)}
                    className="w-full px-2.5 py-2 border border-slate-300 rounded-md font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Contract Start *</label>
                  <input
                    type="date"
                    required
                    value={fContractStart}
                    onChange={(e) => setFContractStart(e.target.value)}
                    className="w-full px-2.5 py-2 border border-slate-300 rounded-md font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Contract End (if fixed-term)</label>
                  <input
                    type="date"
                    value={fContractEnd}
                    onChange={(e) => setFContractEnd(e.target.value)}
                    className="w-full px-2.5 py-2 border border-slate-300 rounded-md font-mono"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Basic Salary ($) *</label>
                  <input
                    type="number"
                    step="0.01"
                    min="1"
                    required
                    value={fSalary}
                    onChange={(e) => setFSalary(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-md font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Default Allowance ($)</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={fAllowance}
                    onChange={(e) => setFAllowance(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-md font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Licence #</label>
                  <input
                    value={fLicenceNo}
                    onChange={(e) => setFLicenceNo(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-md font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Licence Expiry</label>
                  <input
                    type="date"
                    value={fLicenceExp}
                    onChange={(e) => setFLicenceExp(e.target.value)}
                    className="w-full px-2.5 py-2 border border-slate-300 rounded-md font-mono"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
                <button type="button" onClick={() => setEmpModalOpen(false)} className="px-3 py-1.5 border border-slate-200 rounded-md">
                  Cancel
                </button>
                <button type="submit" className="px-4 py-1.5 bg-teal-700 hover:bg-teal-800 text-white rounded-md font-medium">
                  {editingEmp ? 'Update Employee' : 'Register Employee'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* EMPLOYEE PROFILE & DOCUMENTS MODAL */}
      {profileEmp && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4 no-print">
          <div className="bg-white border border-slate-200 rounded-lg w-full max-w-2xl max-h-[90vh] overflow-y-auto p-6 space-y-5">
            <div className="flex items-start justify-between gap-4 border-b border-slate-200 pb-3">
              <div>
                <div className="font-mono text-xs text-teal-800 font-semibold">{profileEmp.employee_number}</div>
                <h3 className="font-display text-lg font-semibold text-slate-900">{profileEmp.full_name}</h3>
                <div className="text-xs text-slate-500">
                  {profileEmp.job_position} · {profileEmp.department_name} · {profileEmp.employment_type.replace('_', ' ')}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setPrintProfileEmp(profileEmp)}
                  className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-200 hover:bg-slate-50 rounded-md"
                >
                  <Printer className="w-3.5 h-3.5" />
                  <span>Print Profile</span>
                </button>
                <button onClick={() => setProfileEmp(null)} className="text-slate-400 hover:text-slate-600">
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
              <div>
                <div className="text-slate-500">Gender / Status</div>
                <div className="font-medium capitalize text-slate-900">
                  {profileEmp.gender} · {profileEmp.status}
                </div>
              </div>
              <div>
                <div className="text-slate-500">Phone / Email</div>
                <div className="font-medium text-slate-900">{profileEmp.phone || '—'}</div>
                <div className="text-slate-500">{profileEmp.email || profileEmp.user_email || '—'}</div>
              </div>
              <div>
                <div className="text-slate-500">Emergency Contact</div>
                <div className="font-medium text-slate-900">{profileEmp.emergency_contact_name || '—'}</div>
                <div className="font-mono text-slate-500">{profileEmp.emergency_contact_phone || ''}</div>
              </div>
              <div>
                <div className="text-slate-500">Hire / Contract</div>
                <div className="font-mono text-slate-900">
                  Hired {profileEmp.hire_date} · Term {profileEmp.contract_start}
                  {profileEmp.contract_end ? ` → ${profileEmp.contract_end}` : ''}
                </div>
              </div>
              <div>
                <div className="text-slate-500">Compensation</div>
                <div className="font-mono font-semibold text-slate-900 tabular-nums">
                  Base ${Number(profileEmp.basic_salary).toFixed(2)} + Allow ${Number(profileEmp.housing_allowance || 0).toFixed(2)}
                </div>
              </div>
              <div>
                <div className="text-slate-500">Practising Licence</div>
                <div className="font-mono text-slate-900">
                  {profileEmp.licence_number || 'None'} {profileEmp.licence_expiry ? `(Exp ${profileEmp.licence_expiry})` : ''}
                </div>
              </div>
            </div>

            {(profileEmp.status === 'terminated' || profileEmp.status === 'resigned') && profileEmp.termination_reason && (
              <div className="p-3 bg-red-50 border border-red-200 rounded text-xs text-red-900">
                <strong className="capitalize">{profileEmp.status} ({profileEmp.terminated_at}):</strong> {profileEmp.termination_reason}
              </div>
            )}

            <div className="space-y-3 pt-2 border-t border-slate-200">
              <div className="font-display text-sm font-semibold text-slate-900">Employee Documents &amp; Credentials</div>
              {profileDocs.length === 0 ? (
                <div className="text-xs text-slate-500">No contracts, certificates, or ID documents attached yet.</div>
              ) : (
                <div className="divide-y divide-slate-100 border border-slate-200 rounded-md">
                  {profileDocs.map((d) => (
                    <div key={d.id} className="px-3.5 py-2.5 flex items-center justify-between gap-3 text-xs">
                      <div>
                        <div className="font-medium text-slate-900">
                          <span className="font-mono uppercase text-[11px] text-teal-800 mr-1.5">[{d.doc_type}]</span>
                          {d.title}
                        </div>
                        <div className="text-slate-500 font-mono text-[11px]">
                          {d.file_ref || 'On file'}
                          {d.expiry_date ? ` · Expires ${d.expiry_date}` : ''}
                          {d.notes ? ` · ${d.notes}` : ''}
                        </div>
                      </div>
                      <button
                        onClick={() => handleDeleteDocument(d.id)}
                        className="text-red-600 hover:text-red-800 p-1"
                        title="Remove document"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <form onSubmit={handleAddEmployeeDocument} className="grid grid-cols-1 sm:grid-cols-4 gap-2 text-xs pt-2">
                <select
                  value={docType}
                  onChange={(e) => setDocType(e.target.value as typeof docType)}
                  className="px-2.5 py-1.5 border border-slate-300 rounded-md bg-white"
                >
                  <option value="contract">Employment Contract</option>
                  <option value="id_document">National ID / Passport</option>
                  <option value="certificate">Degree / Certificate</option>
                  <option value="licence">Practising Licence</option>
                  <option value="other">Other Document</option>
                </select>
                <input
                  required
                  value={docTitle}
                  onChange={(e) => setDocTitle(e.target.value)}
                  placeholder="Document title *"
                  className="px-2.5 py-1.5 border border-slate-300 rounded-md"
                />
                <input
                  value={docRef}
                  onChange={(e) => setDocRef(e.target.value)}
                  placeholder="File / folder ref #"
                  className="px-2.5 py-1.5 border border-slate-300 rounded-md font-mono"
                />
                <button type="submit" className="px-3 py-1.5 bg-teal-700 hover:bg-teal-800 text-white rounded-md font-medium">
                  Attach Document
                </button>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* EMPLOYEE STATUS CHANGE / TERMINATION MODAL */}
      {statusModalEmp && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4 no-print">
          <div className="bg-white border border-slate-200 rounded-lg w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-display text-base font-semibold text-slate-900 capitalize">
                {statusModalEmp.targetStatus === 'active'
                  ? 'Reactivate Employee'
                  : statusModalEmp.targetStatus === 'inactive'
                    ? 'Deactivate Employee'
                    : statusModalEmp.targetStatus === 'resigned'
                      ? 'Record Employee Resignation'
                      : 'Terminate Employee'}
              </h3>
              <button onClick={() => setStatusModalEmp(null)} className="text-slate-400 hover:text-slate-600">
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleConfirmStatusChange} className="space-y-3 text-xs">
              <div className="text-slate-600">
                Employee: <strong className="text-slate-900">{statusModalEmp.emp.full_name}</strong> ({statusModalEmp.emp.employee_number})
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">
                  {statusModalEmp.targetStatus === 'terminated' || statusModalEmp.targetStatus === 'resigned'
                    ? 'Formal Offboarding Reason *'
                    : 'HR Audit Note (Optional)'}
                </label>
                <textarea
                  rows={2}
                  required={statusModalEmp.targetStatus === 'terminated' || statusModalEmp.targetStatus === 'resigned'}
                  value={statusReason}
                  onChange={(e) => setStatusReason(e.target.value)}
                  placeholder="Enter HR documentation note..."
                  className="w-full px-3 py-2 border border-slate-300 rounded-md"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setStatusModalEmp(null)} className="px-3 py-1.5 border border-slate-200 rounded-md">
                  Cancel
                </button>
                <button
                  type="submit"
                  className={`px-4 py-1.5 text-white rounded-md font-medium ${
                    statusModalEmp.targetStatus === 'terminated'
                      ? 'bg-red-700 hover:bg-red-800'
                      : statusModalEmp.targetStatus === 'active'
                        ? 'bg-emerald-700 hover:bg-emerald-800'
                        : 'bg-slate-900 hover:bg-slate-800'
                  }`}
                >
                  Confirm Status Change
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* LEAVE REQUEST MODAL */}
      {leaveOpen && data && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4 no-print">
          <div className="bg-white border border-slate-200 rounded-lg w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-display text-base font-semibold text-slate-900">Submit Leave Request</h3>
              <button onClick={() => setLeaveOpen(false)} className="text-slate-400 hover:text-slate-600">
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleSubmitLeave} className="space-y-3 text-xs">
              {canManageHr && activeEmployees.length > 0 && (
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Employee</label>
                  <select
                    value={lEmployeeId}
                    onChange={(e) => setLEmployeeId(e.target.value)}
                    className="w-full px-2.5 py-2 border border-slate-300 rounded-md bg-white"
                  >
                    <option value="">Myself ({user.fullName})</option>
                    {activeEmployees.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.employee_number} · {e.full_name} ({e.department_name})
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div>
                <label className="block font-medium text-slate-700 mb-1">Leave Type</label>
                <select
                  value={lType}
                  onChange={(e) => setLType(e.target.value)}
                  className="w-full px-2.5 py-2 border border-slate-300 rounded-md bg-white"
                >
                  {data.leaveTypes.length > 0 ? (
                    data.leaveTypes.map((lt) => (
                      <option key={lt.id} value={lt.code}>
                        {lt.name} ({lt.annual_allowance_days > 0 ? `${lt.annual_allowance_days}d/yr` : lt.paid ? 'Paid' : 'Unpaid'})
                      </option>
                    ))
                  ) : (
                    <>
                      <option value="annual">Annual Leave</option>
                      <option value="sick">Sick Leave</option>
                      <option value="study">CME / Study Leave</option>
                      <option value="emergency">Emergency Leave</option>
                    </>
                  )}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Start Date *</label>
                  <input
                    type="date"
                    required
                    value={lStart}
                    onChange={(e) => setLStart(e.target.value)}
                    className="w-full px-2.5 py-2 border border-slate-300 rounded-md font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">End Date *</label>
                  <input
                    type="date"
                    required
                    value={lEnd}
                    onChange={(e) => setLEnd(e.target.value)}
                    className="w-full px-2.5 py-2 border border-slate-300 rounded-md font-mono"
                  />
                </div>
              </div>
              <div className="text-[11px] font-mono text-teal-800">
                Computed duration: <strong>{leavePreviewDays}</strong> day(s)
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Reason *</label>
                <textarea
                  rows={2}
                  required
                  value={lReason}
                  onChange={(e) => setLReason(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-md"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setLeaveOpen(false)} className="px-3 py-1.5 border border-slate-200 rounded-md">
                  Cancel
                </button>
                <button type="submit" className="px-4 py-1.5 bg-teal-700 hover:bg-teal-800 text-white rounded-md font-medium">
                  Submit Request
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* DEFINE LEAVE TYPE MODAL */}
      {leaveTypeModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4 no-print">
          <div className="bg-white border border-slate-200 rounded-lg w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-display text-base font-semibold text-slate-900">Define Leave Type</h3>
              <button onClick={() => setLeaveTypeModalOpen(false)} className="text-slate-400 hover:text-slate-600">
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleSaveLeaveType} className="space-y-3 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Code *</label>
                  <input
                    required
                    value={ltCode}
                    onChange={(e) => setLtCode(e.target.value)}
                    placeholder="e.g. paternity"
                    className="w-full px-3 py-2 border border-slate-300 rounded-md font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Annual Days *</label>
                  <input
                    type="number"
                    min="0"
                    required
                    value={ltAllowance}
                    onChange={(e) => setLtAllowance(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-md font-mono"
                  />
                </div>
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Display Name *</label>
                <input
                  required
                  value={ltName}
                  onChange={(e) => setLtName(e.target.value)}
                  placeholder="e.g. Paternity Leave"
                  className="w-full px-3 py-2 border border-slate-300 rounded-md"
                />
              </div>
              <div className="flex items-center gap-2">
                <input id="lt-paid" type="checkbox" checked={ltPaid} onChange={(e) => setLtPaid(e.target.checked)} />
                <label htmlFor="lt-paid" className="text-slate-700 font-medium">
                  Paid Leave Policy
                </label>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setLeaveTypeModalOpen(false)} className="px-3 py-1.5 border border-slate-200 rounded-md">
                  Cancel
                </button>
                <button type="submit" className="px-4 py-1.5 bg-teal-700 hover:bg-teal-800 text-white rounded-md font-medium">
                  Save Leave Type
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* LEAVE DECISION MODAL */}
      {leaveDecisionTarget && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4 no-print">
          <div className="bg-white border border-slate-200 rounded-lg w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-display text-base font-semibold text-slate-900">
                {leaveDecisionTarget.decision === 'rejected' ? 'Reject Leave Request' : 'Cancel Leave Request'}
              </h3>
              <button onClick={() => setLeaveDecisionTarget(null)} className="text-slate-400 hover:text-slate-600">
                <X className="w-4 h-4" />
              </button>
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleDecideLeave(leaveDecisionTarget.lr.id, leaveDecisionTarget.decision, leaveDecisionNote);
              }}
              className="space-y-3 text-xs"
            >
              <div className="text-slate-600">
                Staff: <strong className="text-slate-900">{leaveDecisionTarget.lr.staff_name}</strong> ({leaveDecisionTarget.lr.start_date} to{' '}
                {leaveDecisionTarget.lr.end_date})
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">
                  {leaveDecisionTarget.decision === 'rejected' ? 'Formal Rejection Reason *' : 'Cancellation Note (Optional)'}
                </label>
                <textarea
                  rows={2}
                  required={leaveDecisionTarget.decision === 'rejected'}
                  value={leaveDecisionNote}
                  onChange={(e) => setLeaveDecisionNote(e.target.value)}
                  placeholder="Enter HR audit note..."
                  className="w-full px-3 py-2 border border-slate-300 rounded-md"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setLeaveDecisionTarget(null)} className="px-3 py-1.5 border border-slate-200 rounded-md">
                  Back
                </button>
                <button
                  type="submit"
                  className={`px-4 py-1.5 text-white rounded-md font-medium ${
                    leaveDecisionTarget.decision === 'rejected' ? 'bg-red-700 hover:bg-red-800' : 'bg-slate-900 hover:bg-slate-800'
                  }`}
                >
                  Confirm {leaveDecisionTarget.decision === 'rejected' ? 'Rejection' : 'Cancellation'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* PRINTABLE EMPLOYEE PROFILE PORTAL */}
      {printProfileEmp &&
        createPortal(
          <div className="print-modal-backdrop fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
            <div className="print-modal-card bg-white border border-slate-200 rounded-lg max-w-2xl w-full p-8 space-y-5 text-xs">
              <div className="flex items-start justify-between border-b-2 border-slate-900 pb-4">
                <div>
                  <div className="font-display text-lg font-bold text-slate-900">Clinic360 Central Medical</div>
                  <div className="uppercase tracking-wider font-semibold text-teal-800 mt-0.5">
                    Official Employee Profile &amp; Employment Record
                  </div>
                </div>
                <div className="flex items-center gap-2 no-print">
                  <button
                    onClick={() => window.print()}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-teal-700 hover:bg-teal-800 text-white rounded-md font-medium"
                  >
                    <Printer className="w-3.5 h-3.5" />
                    <span>Print / PDF</span>
                  </button>
                  <button
                    onClick={() => setPrintProfileEmp(null)}
                    className="px-3 py-1.5 border border-slate-200 rounded-md text-slate-700"
                  >
                    Close
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <div className="text-slate-500">Full Name</div>
                  <div className="font-semibold text-sm text-slate-900">{printProfileEmp.full_name}</div>
                </div>
                <div>
                  <div className="text-slate-500">Employee Number</div>
                  <div className="font-mono font-semibold text-sm text-slate-900">{printProfileEmp.employee_number}</div>
                </div>
                <div>
                  <div className="text-slate-500">Department &amp; Position</div>
                  <div className="font-medium text-slate-900">
                    {printProfileEmp.department_name} · {printProfileEmp.job_position}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500">Employment Type &amp; Status</div>
                  <div className="font-medium capitalize text-slate-900">
                    {printProfileEmp.employment_type.replace('_', ' ')} · {printProfileEmp.status}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500">Contact &amp; Address</div>
                  <div>{printProfileEmp.phone || '—'} · {printProfileEmp.email || '—'}</div>
                  <div className="text-slate-600">{printProfileEmp.address || '—'}</div>
                </div>
                <div>
                  <div className="text-slate-500">Emergency Contact</div>
                  <div>{printProfileEmp.emergency_contact_name || '—'}</div>
                  <div className="font-mono">{printProfileEmp.emergency_contact_phone || '—'}</div>
                </div>
                <div>
                  <div className="text-slate-500">Contract Dates</div>
                  <div className="font-mono">
                    Hire {printProfileEmp.hire_date} · Start {printProfileEmp.contract_start}
                    {printProfileEmp.contract_end ? ` · End ${printProfileEmp.contract_end}` : ''}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500">Compensation</div>
                  <div className="font-mono font-semibold">
                    Basic ${Number(printProfileEmp.basic_salary).toFixed(2)} · Allowance $
                    {Number(printProfileEmp.housing_allowance || 0).toFixed(2)}
                  </div>
                </div>
              </div>
            </div>
          </div>,
          document.body
        )}

      {/* PRINTABLE EMPLOYEE PAYSLIP PORTAL */}
      {printPayslip &&
        createPortal(
          <div className="print-modal-backdrop fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
            <div className="print-modal-card bg-white border border-slate-200 rounded-lg max-w-xl w-full p-8 space-y-5 text-xs">
              <div className="flex items-start justify-between border-b-2 border-slate-900 pb-4">
                <div>
                  <div className="font-display text-lg font-bold text-slate-900">Clinic360 Central Medical</div>
                  <div className="uppercase tracking-wider font-semibold text-teal-800 mt-0.5">
                    Employee Salary Statement (Payslip)
                  </div>
                </div>
                <div className="flex items-center gap-2 no-print">
                  <button
                    onClick={() => window.print()}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-teal-700 hover:bg-teal-800 text-white rounded-md font-medium"
                  >
                    <Printer className="w-3.5 h-3.5" />
                    <span>Print / PDF</span>
                  </button>
                  <button
                    onClick={() => setPrintPayslip(null)}
                    className="px-3 py-1.5 border border-slate-200 rounded-md text-slate-700"
                  >
                    Close
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 bg-slate-50 p-3.5 border border-slate-200 rounded">
                <div>
                  <div className="text-slate-500">Employee</div>
                  <div className="font-semibold text-slate-900">{printPayslip.staff_name}</div>
                  <div className="font-mono text-slate-500">
                    {printPayslip.employee_code || printPayslip.role_code} · {printPayslip.department_name || 'Staff'}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-slate-500">Pay Period &amp; Run</div>
                  <div className="font-mono font-semibold text-slate-900">{printPayslip.pay_month}</div>
                  <div className="font-mono text-slate-500">{printPayslip.run_number}</div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="border border-slate-200 rounded p-3 space-y-2">
                  <div className="font-semibold text-slate-900 border-b border-slate-100 pb-1">Earnings</div>
                  <div className="flex justify-between">
                    <span>Basic Salary</span>
                    <span className="font-mono tabular-nums">${Number(printPayslip.base_salary).toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Allowances</span>
                    <span className="font-mono tabular-nums">${Number(printPayslip.allowances || 0).toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Overtime Pay</span>
                    <span className="font-mono tabular-nums">${Number(printPayslip.overtime_pay || 0).toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Bonus / Incentives</span>
                    <span className="font-mono tabular-nums">${Number(printPayslip.bonus_earnings || 0).toFixed(2)}</span>
                  </div>
                </div>
                <div className="border border-slate-200 rounded p-3 space-y-2">
                  <div className="font-semibold text-slate-900 border-b border-slate-100 pb-1">Deductions</div>
                  <div className="flex justify-between">
                    <span>PAYE Income Tax</span>
                    <span className="font-mono tabular-nums">${Number(printPayslip.paye_tax ?? 0).toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Employee Pension (7%)</span>
                    <span className="font-mono tabular-nums">${Number(printPayslip.pension_employee ?? 0).toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Loans / Advances / Other</span>
                    <span className="font-mono tabular-nums">${Number(printPayslip.other_deductions ?? 0).toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between text-slate-500 pt-1 border-t border-slate-100">
                    <span>Employer Pension (11%)</span>
                    <span className="font-mono tabular-nums">${Number(printPayslip.pension_employer ?? 0).toFixed(2)}</span>
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between p-4 bg-teal-50 border border-teal-200 rounded font-mono">
                <span className="font-sans font-semibold text-slate-900">Net Salary Payable</span>
                <span className="text-lg font-bold text-teal-900 tabular-nums">${Number(printPayslip.net_pay).toFixed(2)}</span>
              </div>
              <div className="text-[11px] text-slate-500 font-mono flex justify-between">
                <span>Payment Status: {(printPayslip.payment_status || printPayslip.run_status).toUpperCase()}</span>
                <span>{printPayslip.payment_ref ? `Ref: ${printPayslip.payment_ref}` : ''}</span>
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
};
