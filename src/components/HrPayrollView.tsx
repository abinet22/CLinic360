import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Briefcase, Calendar, Check, FileText, Plus, RefreshCw, X } from 'lucide-react';
import { apiFetch } from '../lib/api';
import type { LeaveRequest, PayrollRun, StaffContract, StaffPayslip, UserContext } from '../types';

interface HrOverview {
  isHrManager: boolean;
  canViewPayroll: boolean;
  contracts: StaffContract[];
  leaveRequests: LeaveRequest[];
  payrollRuns: PayrollRun[];
  staffUsers: Array<{ id: number; full_name: string; email: string; role_code: string; role_name: string }>;
}

interface Props {
  user: UserContext;
  onNotify: (msg: string, type?: 'success' | 'error') => void;
}

export const HrPayrollView: React.FC<Props> = ({ user, onNotify }) => {
  const [data, setData] = useState<HrOverview | null>(null);
  const [payslips, setPayslips] = useState<StaffPayslip[]>([]);
  const [loading, setLoading] = useState(true);
  const [subTab, setSubTab] = useState<'contracts' | 'leave' | 'payroll' | 'payslips'>('leave');
  const initializedTab = useRef(false);

  const canVerifyPayroll = user.permissions.includes('hr.payroll.verify');
  const canApprovePayroll = user.permissions.includes('hr.payroll.approve');
  const canPostPayroll = user.permissions.includes('hr.payroll.post') || user.permissions.includes('hr.manage');
  const canPayPayroll = user.permissions.includes('hr.payroll.pay');
  const canViewOwnPayslips =
    user.permissions.includes('hr.payslip.own') || user.permissions.includes('hr.leave.request');

  // Contract modal
  const [contractOpen, setContractOpen] = useState(false);
  const [cUserId, setCUserId] = useState('');
  const [cEmpCode, setCEmpCode] = useState('');
  const [cDept, setCDept] = useState('');
  const [cType, setCType] = useState<'full_time' | 'part_time' | 'locum'>('full_time');
  const [cSalary, setCSalary] = useState('');
  const [cAllowance, setCAllowance] = useState('0');
  const [cLicenceNo, setCLicenceNo] = useState('');
  const [cLicenceExp, setCLicenceExp] = useState('');
  const [cStart, setCStart] = useState(() => new Date().toISOString().slice(0, 10));

  // Leave form
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [lType, setLType] = useState<'annual' | 'sick' | 'study' | 'emergency'>('annual');
  const [lStart, setLStart] = useState(() => new Date().toISOString().slice(0, 10));
  const [lEnd, setLEnd] = useState(() => new Date().toISOString().slice(0, 10));
  const [lReason, setLReason] = useState('');

  // Leave decision modal (mandatory note for rejection, optional for cancellation)
  const [leaveDecisionTarget, setLeaveDecisionTarget] = useState<{
    lr: LeaveRequest;
    decision: 'rejected' | 'cancelled';
  } | null>(null);
  const [leaveDecisionNote, setLeaveDecisionNote] = useState('');

  // Payroll generation
  const [payMonth, setPayMonth] = useState(() => new Date().toISOString().slice(0, 7));

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
      if (!initializedTab.current) {
        initializedTab.current = true;
        if (res.isHrManager) {
          setSubTab('contracts');
        } else if (res.canViewPayroll) {
          setSubTab('payroll');
        } else {
          setSubTab('leave');
        }
      }
    } catch (err) {
      onNotify((err as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }, [canViewOwnPayslips, onNotify]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  async function handleSaveContract(e: React.FormEvent) {
    e.preventDefault();
    try {
      await apiFetch('/api/hr/contracts', {
        method: 'POST',
        body: JSON.stringify({
          user_id: Number(cUserId),
          employee_code: cEmpCode,
          department_name: cDept,
          contract_type: cType,
          base_salary: Number(cSalary),
          housing_allowance: Number(cAllowance || 0),
          licence_number: cLicenceNo || null,
          licence_expiry: cLicenceExp || null,
          contract_start: cStart,
        }),
      });
      onNotify('Staff contract & credentialing record saved.');
      setContractOpen(false);
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

  async function handleGeneratePayroll() {
    try {
      const res = await apiFetch<{ runNumber: string }>('/api/hr/payroll/generate', {
        method: 'POST',
        body: JSON.stringify({ pay_month: payMonth }),
      });
      onNotify(`Draft payroll run ${res.runNumber} generated for ${payMonth}.`);
      loadData();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleVerifyPayroll(runId: number) {
    try {
      await apiFetch(`/api/hr/payroll/${runId}/verify`, { method: 'POST' });
      onNotify('Payroll run verified by Finance and forwarded for approval.');
      loadData();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleApprovePayroll(runId: number) {
    try {
      await apiFetch(`/api/hr/payroll/${runId}/approve`, { method: 'POST' });
      onNotify('Payroll run approved for General Ledger posting.');
      loadData();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handlePostPayroll(runId: number) {
    try {
      const res = await apiFetch<{ entryNumber: string }>(`/api/hr/payroll/${runId}/post`, {
        method: 'POST',
      });
      onNotify(`Payroll posted to General Ledger (${res.entryNumber}).`);
      loadData();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handlePayPayroll(runId: number) {
    try {
      const res = await apiFetch<{ entryNumber: string }>(`/api/hr/payroll/${runId}/pay`, {
        method: 'POST',
      });
      onNotify(`Bank salary disbursement recorded (${res.entryNumber}).`);
      loadData();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  const expiringContracts =
    data?.contracts.filter((c) => c.licence_alert === 'expired' || c.licence_alert === 'expiring_soon') || [];

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-xl font-semibold text-slate-900">HR, Medical Licences &amp; Payroll</h1>
          <p className="text-xs text-slate-500 mt-0.5">
            {data?.isHrManager
              ? 'Staff contracts, practising licence expiry alerts, leave workflow, and GL-linked monthly payroll.'
              : data?.canViewPayroll
                ? 'Verify, approve, or disburse monthly payroll runs, plus personal leave & payslips.'
                : 'Submit and track your personal leave requests and monthly payslips.'}
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
          {data?.isHrManager && (
            <button
              onClick={() => {
                if (data.staffUsers.length > 0 && !cUserId) setCUserId(String(data.staffUsers[0].id));
                setContractOpen(true);
              }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md whitespace-nowrap"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Add / Update Contract</span>
            </button>
          )}
        </div>
      </div>

      {/* Licence Expiry Alert Banner */}
      {data?.isHrManager && expiringContracts.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 flex items-start gap-3 text-xs text-amber-900">
          <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
          <div>
            <div className="font-semibold">Practising Licence Expiry Alerts ({expiringContracts.length})</div>
            <div className="mt-1 space-y-0.5">
              {expiringContracts.map((c) => (
                <div key={c.id}>
                  <span className="font-medium">{c.full_name}</span> ({c.licence_number || 'No licence #'}): expires{' '}
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

      {data && (
        <div className="flex flex-wrap gap-1 border-b border-slate-200">
          {(
            [
              ...(data.isHrManager ? [['contracts', `Staff Contracts (${data.contracts.length})`] as const] : []),
              ['leave', data.isHrManager ? `Leave Approvals (${data.leaveRequests.length})` : `My Leave (${data.leaveRequests.length})`] as const,
              ...(data.isHrManager || data.canViewPayroll ? [['payroll', `Monthly Payroll (${data.payrollRuns.length})`] as const] : []),
              ...(canViewOwnPayslips ? [['payslips', `My Payslips (${payslips.length})`] as const] : []),
            ] as Array<['contracts' | 'leave' | 'payroll' | 'payslips', string]>
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setSubTab(key)}
              className={`px-4 py-2 text-xs font-medium border-b-2 transition-colors whitespace-nowrap ${
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
          Loading HR &amp; Payroll workspace...
        </div>
      ) : null}

      {/* CONTRACTS */}
      {data?.isHrManager && subTab === 'contracts' && (
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-200 flex items-center gap-2">
            <Briefcase className="w-4 h-4 text-teal-700" />
            <h2 className="font-display text-sm font-semibold text-slate-900">Active Employment Contracts &amp; Licences</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-slate-500">
                  <th className="py-2.5 px-4">Emp Code</th>
                  <th className="py-2.5 px-4">Staff Member</th>
                  <th className="py-2.5 px-4">Department</th>
                  <th className="py-2.5 px-4">Practising Licence</th>
                  <th className="py-2.5 px-4 text-right">Base Salary</th>
                  <th className="py-2.5 px-4 text-right">Allowance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.contracts.map((c) => (
                  <tr key={c.id}>
                    <td className="py-2.5 px-4 font-mono font-semibold text-slate-800">{c.employee_code}</td>
                    <td className="py-2.5 px-4">
                      <div className="font-medium text-slate-900">{c.full_name}</div>
                      <div className="font-mono text-slate-500">{c.role_code} · {c.contract_type.replace('_', ' ')}</div>
                    </td>
                    <td className="py-2.5 px-4 text-slate-700">{c.department_name}</td>
                    <td className="py-2.5 px-4 font-mono">
                      {c.licence_number ? (
                        <div>
                          <span>{c.licence_number}</span>
                          <div
                            className={
                              c.licence_alert === 'expired'
                                ? 'text-red-700 font-semibold'
                                : c.licence_alert === 'expiring_soon'
                                  ? 'text-amber-700 font-semibold'
                                  : 'text-slate-500'
                            }
                          >
                            Exp: {c.licence_expiry} ({c.licence_days_remaining}d)
                          </div>
                        </div>
                      ) : (
                        <span className="text-slate-400">Non-clinical</span>
                      )}
                    </td>
                    <td className="py-2.5 px-4 text-right font-mono tabular-nums">${Number(c.base_salary).toFixed(2)}</td>
                    <td className="py-2.5 px-4 text-right font-mono tabular-nums">${Number(c.housing_allowance).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* LEAVE REQUESTS */}
      {data && subTab === 'leave' && (
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-200">
            <h2 className="font-display text-sm font-semibold text-slate-900">
              {data.isHrManager ? 'Staff Leave Approvals (Auto-Blocks Doctor Schedule on Approval)' : 'My Leave Requests'}
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
                  {data.isHrManager && <th className="py-2.5 px-4 text-right">Action</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.leaveRequests.map((lr) => (
                  <tr key={lr.id}>
                    <td className="py-2.5 px-4">
                      <span className="font-medium text-slate-900">{lr.staff_name}</span>
                      <span className="ml-1.5 font-mono text-slate-500">({lr.role_code})</span>
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
                    {data.isHrManager && (
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
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* PAYROLL */}
      {(data?.isHrManager || data?.canViewPayroll) && subTab === 'payroll' && (
        <div className="space-y-4">
          <div className="bg-white border border-slate-200 rounded-lg p-4 flex flex-wrap items-end justify-between gap-3">
            {data.isHrManager ? (
              <div className="flex items-end gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Payroll Month</label>
                  <input
                    type="month"
                    value={payMonth}
                    onChange={(e) => setPayMonth(e.target.value)}
                    className="px-3 py-1.5 text-xs border border-slate-300 rounded-md font-mono"
                  />
                </div>
                <button
                  onClick={handleGeneratePayroll}
                  className="px-4 py-1.5 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md whitespace-nowrap"
                >
                  Generate Monthly Draft
                </button>
              </div>
            ) : (
              <div className="text-xs font-medium text-slate-700">
                Payroll Approval &amp; Disbursement Controls (Segregation of Duties Enforced)
              </div>
            )}
            <div className="text-xs text-slate-500">
              Workflow: Draft → Verify (Finance) → Approve (Manager) → Post GL (5100/2200/2210/2220) → Disburse Bank Pay (2200/1020)
            </div>
          </div>

          {data.payrollRuns.map((run) => (
            <div key={run.id} className="bg-white border border-slate-200 rounded-lg overflow-hidden">
              <div className="px-5 py-3.5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
                <div className="text-xs space-y-1">
                  <div>
                    <span className="font-mono font-semibold text-teal-800 mr-2">{run.run_number}</span>
                    <span className="font-semibold text-slate-900">Period {run.pay_month}</span>
                    <span className="ml-2 px-2 py-0.5 rounded bg-slate-100 text-slate-700 font-mono uppercase text-[11px]">
                      {run.status}
                    </span>
                    <span className="mx-2 text-slate-300">·</span>
                    <span className="font-mono">
                      Gross ${Number(run.total_gross).toFixed(2)} · Deductions ${Number(run.total_deductions).toFixed(2)} · Net $
                      {Number(run.total_net).toFixed(2)}
                    </span>
                  </div>
                  <div className="text-[11px] text-slate-500 font-mono">
                    Draft: {run.created_by_name || '—'}
                    {run.verified_by_name && ` · Verified: ${run.verified_by_name}`}
                    {run.approved_by_name && ` · Approved: ${run.approved_by_name}`}
                    {run.journal_entry_number && ` · Accrual JE: ${run.journal_entry_number}`}
                    {run.payment_journal_entry_number && ` · Bank Pay JE: ${run.payment_journal_entry_number}`}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {run.status === 'draft' && canVerifyPayroll && (
                    <button
                      onClick={() => handleVerifyPayroll(run.id)}
                      className="px-3 py-1.5 text-xs font-medium text-white bg-sky-700 hover:bg-sky-800 rounded whitespace-nowrap"
                    >
                      Verify (Finance)
                    </button>
                  )}
                  {run.status === 'verified' && canApprovePayroll && (
                    <button
                      onClick={() => handleApprovePayroll(run.id)}
                      className="px-3 py-1.5 text-xs font-medium text-white bg-indigo-700 hover:bg-indigo-800 rounded whitespace-nowrap"
                    >
                      Approve Run
                    </button>
                  )}
                  {run.status === 'approved' && canPostPayroll && (
                    <button
                      onClick={() => handlePostPayroll(run.id)}
                      className="px-3 py-1.5 text-xs font-medium text-white bg-emerald-700 hover:bg-emerald-800 rounded whitespace-nowrap"
                    >
                      Post to GL
                    </button>
                  )}
                  {run.status === 'posted' && canPayPayroll && (
                    <button
                      onClick={() => handlePayPayroll(run.id)}
                      className="px-3 py-1.5 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded whitespace-nowrap"
                    >
                      Disburse Bank Pay
                    </button>
                  )}
                  {run.status === 'paid' && (
                    <span className="text-xs font-mono font-semibold text-emerald-700">
                      Disbursed ({run.payment_journal_entry_number || run.journal_entry_number})
                    </span>
                  )}
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-slate-500">
                      <th className="py-2 px-4">Staff Member</th>
                      <th className="py-2 px-4">Role</th>
                      <th className="py-2 px-4 text-right">Base</th>
                      <th className="py-2 px-4 text-right">Allowance</th>
                      <th className="py-2 px-4 text-right">PAYE Tax</th>
                      <th className="py-2 px-4 text-right">Pension (EE/ER)</th>
                      <th className="py-2 px-4 text-right">Net Pay</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {run.items.map((it) => (
                      <tr key={it.id}>
                        <td className="py-2 px-4 font-medium text-slate-900">{it.staff_name}</td>
                        <td className="py-2 px-4 font-mono text-slate-500">{it.role_code}</td>
                        <td className="py-2 px-4 text-right font-mono tabular-nums">${Number(it.base_salary).toFixed(2)}</td>
                        <td className="py-2 px-4 text-right font-mono tabular-nums">${Number(it.allowances).toFixed(2)}</td>
                        <td className="py-2 px-4 text-right font-mono tabular-nums">
                          ${Number(it.paye_tax ?? it.tax_deduction).toFixed(2)}
                        </td>
                        <td className="py-2 px-4 text-right font-mono tabular-nums text-slate-600">
                          ${Number(it.pension_employee ?? 0).toFixed(2)} / ${Number(it.pension_employer ?? 0).toFixed(2)}
                        </td>
                        <td className="py-2 px-4 text-right font-mono font-semibold tabular-nums">${Number(it.net_pay).toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* MY PAYSLIPS */}
      {subTab === 'payslips' && (
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-200 flex items-center gap-2">
            <FileText className="w-4 h-4 text-teal-700" />
            <h2 className="font-display text-sm font-semibold text-slate-900">My Approved &amp; Posted Payslips</h2>
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
                    <th className="py-2.5 px-4 text-right">Allowances</th>
                    <th className="py-2.5 px-4 text-right">PAYE Tax</th>
                    <th className="py-2.5 px-4 text-right">Pension (EE)</th>
                    <th className="py-2.5 px-4 text-right">Net Pay</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {payslips.map((ps) => (
                    <tr key={ps.id}>
                      <td className="py-2.5 px-4 font-mono">
                        <div className="font-semibold text-slate-900">{ps.pay_month}</div>
                        <div className="text-slate-500">{ps.run_number}</div>
                      </td>
                      <td className="py-2.5 px-4 font-mono capitalize text-emerald-700 font-semibold">{ps.run_status}</td>
                      <td className="py-2.5 px-4 text-right font-mono tabular-nums">${Number(ps.base_salary).toFixed(2)}</td>
                      <td className="py-2.5 px-4 text-right font-mono tabular-nums">${Number(ps.allowances).toFixed(2)}</td>
                      <td className="py-2.5 px-4 text-right font-mono tabular-nums">
                        ${Number(ps.paye_tax ?? ps.tax_deduction).toFixed(2)}
                      </td>
                      <td className="py-2.5 px-4 text-right font-mono tabular-nums">${Number(ps.pension_employee ?? 0).toFixed(2)}</td>
                      <td className="py-2.5 px-4 text-right font-mono font-semibold text-teal-800 tabular-nums">
                        ${Number(ps.net_pay).toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* CONTRACT MODAL */}
      {contractOpen && data && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-lg w-full max-w-lg p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-display text-base font-semibold text-slate-900">Staff Contract &amp; Credentialing</h3>
              <button onClick={() => setContractOpen(false)} className="text-slate-400 hover:text-slate-600">
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleSaveContract} className="space-y-3 text-xs">
              <div>
                <label className="block font-medium text-slate-700 mb-1">Staff User *</label>
                <select
                  required
                  value={cUserId}
                  onChange={(e) => setCUserId(e.target.value)}
                  className="w-full px-2.5 py-2 border border-slate-300 rounded-md bg-white"
                >
                  {data.staffUsers.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.full_name} ({u.role_code})
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Employee Code *</label>
                  <input
                    required
                    value={cEmpCode}
                    onChange={(e) => setCEmpCode(e.target.value)}
                    placeholder="EMP-011"
                    className="w-full px-3 py-2 border border-slate-300 rounded-md font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Department *</label>
                  <input
                    required
                    value={cDept}
                    onChange={(e) => setCDept(e.target.value)}
                    placeholder="Outpatient Medicine"
                    className="w-full px-3 py-2 border border-slate-300 rounded-md"
                  />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Contract Type</label>
                  <select
                    value={cType}
                    onChange={(e) => setCType(e.target.value as 'full_time' | 'part_time' | 'locum')}
                    className="w-full px-2.5 py-2 border border-slate-300 rounded-md bg-white"
                  >
                    <option value="full_time">Full Time</option>
                    <option value="part_time">Part Time</option>
                    <option value="locum">Locum</option>
                  </select>
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Base Salary ($) *</label>
                  <input
                    type="number"
                    required
                    min="1"
                    value={cSalary}
                    onChange={(e) => setCSalary(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-md font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Allowance ($)</label>
                  <input
                    type="number"
                    min="0"
                    value={cAllowance}
                    onChange={(e) => setCAllowance(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-md font-mono"
                  />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Licence #</label>
                  <input
                    value={cLicenceNo}
                    onChange={(e) => setCLicenceNo(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-md font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Licence Expiry</label>
                  <input
                    type="date"
                    value={cLicenceExp}
                    onChange={(e) => setCLicenceExp(e.target.value)}
                    className="w-full px-2.5 py-2 border border-slate-300 rounded-md font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Start Date *</label>
                  <input
                    type="date"
                    required
                    value={cStart}
                    onChange={(e) => setCStart(e.target.value)}
                    className="w-full px-2.5 py-2 border border-slate-300 rounded-md font-mono"
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setContractOpen(false)} className="px-3 py-1.5 border border-slate-200 rounded-md">
                  Cancel
                </button>
                <button type="submit" className="px-4 py-1.5 bg-teal-700 hover:bg-teal-800 text-white rounded-md font-medium">
                  Save Contract
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* LEAVE MODAL */}
      {leaveOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-lg w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-display text-base font-semibold text-slate-900">Submit Leave Request</h3>
              <button onClick={() => setLeaveOpen(false)} className="text-slate-400 hover:text-slate-600">
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleSubmitLeave} className="space-y-3 text-xs">
              <div>
                <label className="block font-medium text-slate-700 mb-1">Leave Type</label>
                <select
                  value={lType}
                  onChange={(e) => setLType(e.target.value as 'annual' | 'sick' | 'study' | 'emergency')}
                  className="w-full px-2.5 py-2 border border-slate-300 rounded-md bg-white"
                >
                  <option value="annual">Annual Leave</option>
                  <option value="sick">Sick Leave</option>
                  <option value="study">CME / Study Leave</option>
                  <option value="emergency">Emergency Leave</option>
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
      {/* LEAVE DECISION MODAL */}
      {leaveDecisionTarget && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4">
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
    </div>
  );
};
