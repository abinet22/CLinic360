import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, FlaskConical, Pill, RotateCcw, Scan, X } from 'lucide-react';
import { apiFetch } from '../lib/api';
import type { ImagingOrder, LabOrder, Prescription, UserContext } from '../types';

interface DiagnosticsPharmacyViewProps {
  user: UserContext;
  onNotify: (msg: string, type?: 'success' | 'error') => void;
}

export const DiagnosticsPharmacyView: React.FC<DiagnosticsPharmacyViewProps> = ({ user, onNotify }) => {
  const canLab = user.permissions.includes('lab.order.read');
  const canImaging = user.permissions.includes('imaging.order.read');
  const canPharmacy = user.permissions.includes('pharmacy.prescription.read');

  const defaultTab = canLab ? 'lab' : canImaging ? 'imaging' : 'pharmacy';
  const [tab, setTab] = useState<'lab' | 'imaging' | 'pharmacy'>(defaultTab);
  const [labOrders, setLabOrders] = useState<LabOrder[]>([]);
  const [imagingOrders, setImagingOrders] = useState<ImagingOrder[]>([]);
  const [prescriptions, setPrescriptions] = useState<Prescription[]>([]);

  const [resultDrafts, setResultDrafts] = useState<Record<number, { value: string; flag: string }>>({});
  const [emergencyLabBypass, setEmergencyLabBypass] = useState<Record<number, boolean>>({});
  const [emergencyRxBypass, setEmergencyRxBypass] = useState<Record<number, boolean>>({});

  const [rejectTarget, setRejectTarget] = useState<LabOrder | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const [amendTarget, setAmendTarget] = useState<LabOrder | null>(null);
  const [amendValue, setAmendValue] = useState('');
  const [amendFlag, setAmendFlag] = useState('normal');
  const [amendReason, setAmendReason] = useState('');

  const [performTarget, setPerformTarget] = useState<ImagingOrder | null>(null);
  const [pregnancyChecked, setPregnancyChecked] = useState(false);
  const [examNotes, setExamNotes] = useState('');

  const [reportTarget, setReportTarget] = useState<ImagingOrder | null>(null);
  const [findings, setFindings] = useState('');
  const [impression, setImpression] = useState('');

  const [addendumTarget, setAddendumTarget] = useState<ImagingOrder | null>(null);
  const [addendumText, setAddendumText] = useState('');

  const loadData = useCallback(async () => {
    try {
      if (canLab) {
        const res = await apiFetch<{ orders: LabOrder[] }>('/api/lab/orders');
        setLabOrders(res.orders);
      }
      if (canImaging) {
        const res = await apiFetch<{ orders: ImagingOrder[] }>('/api/imaging/orders');
        setImagingOrders(res.orders);
      }
      if (canPharmacy) {
        const res = await apiFetch<{ prescriptions: Prescription[] }>('/api/pharmacy/prescriptions');
        setPrescriptions(res.prescriptions);
      }
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }, [canLab, canImaging, canPharmacy, onNotify]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  async function handleLabAction(
    id: number,
    action: 'collect' | 'enter_result' | 'verify' | 'recollect'
  ) {
    const draft = resultDrafts[id] || { value: '', flag: 'normal' };
    try {
      await apiFetch(`/api/lab/orders/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          action,
          result_value: draft.value,
          abnormal_flag: draft.flag,
          bypass_payment_gate: Boolean(emergencyLabBypass[id]),
        }),
      });
      onNotify(`Lab order #${id} updated (${action.replace('_', ' ')})`, 'success');
      loadData();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleRejectSample(e: React.FormEvent) {
    e.preventDefault();
    if (!rejectTarget) return;
    try {
      await apiFetch(`/api/lab/orders/${rejectTarget.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          action: 'reject',
          rejection_reason: rejectReason,
          bypass_payment_gate: Boolean(emergencyLabBypass[rejectTarget.id]),
        }),
      });
      onNotify(`Sample #${rejectTarget.id} rejected & clinician notified`, 'success');
      setRejectTarget(null);
      setRejectReason('');
      loadData();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleAmendLab(e: React.FormEvent) {
    e.preventDefault();
    if (!amendTarget) return;
    try {
      await apiFetch(`/api/lab/orders/${amendTarget.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          action: 'amend',
          result_value: amendValue,
          abnormal_flag: amendFlag,
          amend_reason: amendReason,
        }),
      });
      onNotify(`Lab order #${amendTarget.id} amended (previous result retained)`, 'success');
      setAmendTarget(null);
      setAmendValue('');
      setAmendReason('');
      loadData();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handlePerformImaging(e: React.FormEvent) {
    e.preventDefault();
    if (!performTarget) return;
    try {
      await apiFetch(`/api/imaging/orders/${performTarget.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          action: 'perform',
          pregnancy_checked: pregnancyChecked,
          exam_notes: examNotes,
        }),
      });
      onNotify(`Imaging exam #${performTarget.id} performed`, 'success');
      setPerformTarget(null);
      setPregnancyChecked(false);
      setExamNotes('');
      loadData();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleFinaliseImaging(e: React.FormEvent) {
    e.preventDefault();
    if (!reportTarget) return;
    try {
      await apiFetch(`/api/imaging/orders/${reportTarget.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          action: 'finalise',
          findings,
          impression,
        }),
      });
      onNotify(`Imaging report #${reportTarget.id} finalised & sent to Doctor`, 'success');
      setReportTarget(null);
      setFindings('');
      setImpression('');
      loadData();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleAddendumImaging(e: React.FormEvent) {
    e.preventDefault();
    if (!addendumTarget) return;
    try {
      await apiFetch(`/api/imaging/orders/${addendumTarget.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          action: 'addendum',
          addendum: addendumText,
        }),
      });
      onNotify(`Addendum added to imaging report #${addendumTarget.id}`, 'success');
      setAddendumTarget(null);
      setAddendumText('');
      loadData();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleDispense(id: number) {
    try {
      await apiFetch(`/api/pharmacy/dispense/${id}`, {
        method: 'POST',
        body: JSON.stringify({
          bypass_payment_gate: Boolean(emergencyRxBypass[id]),
        }),
      });
      onNotify(`Prescription #${id} dispensed and dispensary stock updated`, 'success');
      loadData();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-200/70 rounded-lg w-fit">
        {canLab && (
          <button
            onClick={() => setTab('lab')}
            className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors ${
              tab === 'lab' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <FlaskConical className="w-3.5 h-3.5" />
            <span>Laboratory ({labOrders.length})</span>
          </button>
        )}
        {canImaging && (
          <button
            onClick={() => setTab('imaging')}
            className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors ${
              tab === 'imaging' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Scan className="w-3.5 h-3.5" />
            <span>Imaging ({imagingOrders.length})</span>
          </button>
        )}
        {canPharmacy && (
          <button
            onClick={() => setTab('pharmacy')}
            className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors ${
              tab === 'pharmacy' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Pill className="w-3.5 h-3.5" />
            <span>Pharmacy ({prescriptions.length})</span>
          </button>
        )}
      </div>

      {/* LABORATORY WORKLIST */}
      {tab === 'lab' && canLab && (
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          {labOrders.length === 0 ? (
            <div className="p-10 text-center text-sm text-slate-500">No laboratory orders in worklist.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium text-slate-500">
                    <th className="py-2.5 px-4">Order / Sample</th>
                    <th className="py-2.5 px-4">Patient</th>
                    <th className="py-2.5 px-4">Test &amp; Ref Range</th>
                    <th className="py-2.5 px-4">Payment Gate</th>
                    <th className="py-2.5 px-4">Result &amp; Chain</th>
                    <th className="py-2.5 px-4 text-right">Workflow</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-sm">
                  {labOrders.map((lo) => {
                    const draft = resultDrafts[lo.id] || { value: lo.result_value || '', flag: lo.abnormal_flag || 'normal' };
                    const paidOk = lo.patient_type !== 'self-pay' || lo.invoice_status === 'paid';
                    return (
                      <tr key={lo.id} className="hover:bg-slate-50/70">
                        <td className="py-3 px-4 font-mono text-xs">
                          <div className="font-semibold text-slate-900">#{lo.id} · {lo.test_code}</div>
                          <div className="text-slate-500">{lo.sample_barcode || lo.sample_type}</div>
                        </td>
                        <td className="py-3 px-4">
                          <div className="font-medium text-slate-900">{lo.first_name} {lo.last_name}</div>
                          <div className="text-xs font-mono text-slate-500">
                            {lo.mrn} {lo.triage_priority === 'emergency' && '· EMERGENCY'}
                          </div>
                        </td>
                        <td className="py-3 px-4 text-xs">
                          <div className="font-medium text-slate-900">{lo.test_name}</div>
                          <div className="text-slate-500 font-mono">Ref: {lo.reference_range || '—'} {lo.unit || ''}</div>
                        </td>
                        <td className="py-3 px-4 text-xs">
                          <div className={paidOk ? 'text-emerald-700 font-medium' : 'text-red-700 font-semibold'}>
                            {lo.invoice_number || 'Direct'} · {lo.invoice_status || 'paid'}
                          </div>
                          {!paidOk && lo.status !== 'verified' && (
                            <label className="mt-1 inline-flex items-center gap-1.5 text-[11px] text-amber-800 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={Boolean(emergencyLabBypass[lo.id])}
                                onChange={(e) => setEmergencyLabBypass({ ...emergencyLabBypass, [lo.id]: e.target.checked })}
                              />
                              <span>Emergency bypass</span>
                            </label>
                          )}
                        </td>
                        <td className="py-3 px-4 text-xs">
                          {lo.status === 'collected' && user.permissions.includes('lab.result.enter') ? (
                            <div className="flex items-center gap-1.5">
                              <input
                                value={draft.value}
                                onChange={(e) => setResultDrafts({ ...resultDrafts, [lo.id]: { ...draft, value: e.target.value } })}
                                placeholder="Result value"
                                className="w-28 px-2 py-1 text-xs font-mono border border-slate-300 rounded"
                              />
                              <select
                                value={draft.flag}
                                onChange={(e) => setResultDrafts({ ...resultDrafts, [lo.id]: { ...draft, flag: e.target.value } })}
                                className="px-2 py-1 text-xs border border-slate-300 rounded bg-white"
                              >
                                <option value="normal">Normal</option>
                                <option value="high">High</option>
                                <option value="low">Low</option>
                                <option value="critical">Critical</option>
                              </select>
                            </div>
                          ) : (
                            <div className="space-y-0.5">
                              <div>
                                <span className={`font-mono font-medium ${lo.abnormal_flag === 'critical' ? 'text-red-700' : 'text-slate-900'}`}>
                                  {lo.result_value || 'Pending'}
                                </span>
                                <span className="text-slate-400 mx-1.5">·</span>
                                <span className={`capitalize ${lo.status === 'rejected' ? 'text-red-700 font-semibold' : 'text-slate-600'}`}>
                                  {lo.status}
                                </span>
                              </div>
                              {lo.previous_result_value && (
                                <div className="font-mono text-[11px] text-amber-700">
                                  Previous: {lo.previous_result_value} ({lo.amend_reason})
                                </div>
                              )}
                              {lo.rejection_reason && (
                                <div className="text-[11px] text-red-700">Rejected: {lo.rejection_reason}</div>
                              )}
                              {lo.entered_by_name && (
                                <div className="text-[11px] text-slate-400">
                                  Entered: {lo.entered_by_name}
                                  {lo.verified_by_name && ` · Verified: ${lo.verified_by_name}`}
                                </div>
                              )}
                            </div>
                          )}
                        </td>
                        <td className="py-3 px-4 text-right space-x-1.5 whitespace-nowrap">
                          {lo.status === 'ordered' && user.permissions.includes('lab.sample.collect') && (
                            <>
                              <button
                                onClick={() => handleLabAction(lo.id, 'collect')}
                                className="px-3 py-1 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded"
                              >
                                Collect Sample
                              </button>
                              <button
                                onClick={() => setRejectTarget(lo)}
                                className="px-2.5 py-1 text-xs font-medium text-red-700 border border-red-200 hover:bg-red-50 rounded"
                              >
                                Reject
                              </button>
                            </>
                          )}
                          {lo.status === 'collected' && user.permissions.includes('lab.result.enter') && (
                            <>
                              <button
                                onClick={() => handleLabAction(lo.id, 'enter_result')}
                                className="px-3 py-1 text-xs font-medium text-white bg-sky-700 hover:bg-sky-800 rounded"
                              >
                                Submit Result
                              </button>
                              <button
                                onClick={() => setRejectTarget(lo)}
                                className="px-2.5 py-1 text-xs font-medium text-red-700 border border-red-200 hover:bg-red-50 rounded"
                              >
                                Reject
                              </button>
                            </>
                          )}
                          {lo.status === 'rejected' && user.permissions.includes('lab.sample.collect') && (
                            <button
                              onClick={() => handleLabAction(lo.id, 'recollect')}
                              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-teal-800 border border-teal-200 hover:bg-teal-50 rounded"
                            >
                              <RotateCcw className="w-3 h-3" />
                              <span>Free Recollect</span>
                            </button>
                          )}
                          {lo.status === 'resulted' && user.permissions.includes('lab.result.verify') && (
                            <button
                              onClick={() => handleLabAction(lo.id, 'verify')}
                              className="px-3 py-1 text-xs font-medium text-white bg-emerald-700 hover:bg-emerald-800 rounded"
                            >
                              Senior Verify
                            </button>
                          )}
                          {(lo.status === 'verified' || lo.status === 'amended') && (
                            <div className="inline-flex items-center gap-2">
                              <span className="inline-flex items-center gap-1 text-xs text-emerald-700 font-medium">
                                <CheckCircle2 className="w-3.5 h-3.5" />
                                <span>{lo.status === 'amended' ? 'Amended' : 'Released'}</span>
                              </span>
                              {user.permissions.includes('lab.result.verify') && (
                                <button
                                  onClick={() => {
                                    setAmendTarget(lo);
                                    setAmendValue(lo.result_value || '');
                                    setAmendFlag(lo.abnormal_flag || 'normal');
                                  }}
                                  className="px-2 py-0.5 text-[11px] font-medium text-slate-700 border border-slate-200 hover:bg-slate-50 rounded"
                                >
                                  Amend
                                </button>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* IMAGING / RADIOLOGY WORKLIST */}
      {tab === 'imaging' && canImaging && (
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          {imagingOrders.length === 0 ? (
            <div className="p-10 text-center text-sm text-slate-500">No imaging orders in radiology worklist.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium text-slate-500">
                    <th className="py-2.5 px-4">Order &amp; Modality</th>
                    <th className="py-2.5 px-4">Patient</th>
                    <th className="py-2.5 px-4">Exam &amp; Clinical Question</th>
                    <th className="py-2.5 px-4">Payment Gate</th>
                    <th className="py-2.5 px-4">Report &amp; Safety</th>
                    <th className="py-2.5 px-4 text-right">Workflow</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-sm">
                  {imagingOrders.map((io) => {
                    const paidOk = io.patient_type !== 'self-pay' || io.invoice_status === 'paid';
                    return (
                      <tr key={io.id} className="hover:bg-slate-50/70">
                        <td className="py-3 px-4 font-mono text-xs">
                          <div className="font-semibold text-slate-900">#{io.id} · {io.exam_code}</div>
                          <div className="text-slate-500">{io.modality} · {io.body_region}</div>
                        </td>
                        <td className="py-3 px-4">
                          <div className="font-medium text-slate-900">{io.first_name} {io.last_name}</div>
                          <div className="text-xs font-mono text-slate-500">{io.mrn} · {io.sex}</div>
                        </td>
                        <td className="py-3 px-4 text-xs max-w-[260px]">
                          <div className="font-medium text-slate-900">{io.exam_name}</div>
                          <div className="text-slate-500">{io.clinical_question || 'Routine diagnostic study'}</div>
                        </td>
                        <td className="py-3 px-4 text-xs">
                          <span className={paidOk ? 'text-emerald-700 font-medium' : 'text-red-700 font-semibold'}>
                            {io.invoice_number || 'Direct'} · {io.invoice_status || 'paid'}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-xs max-w-[280px]">
                          <div className="capitalize font-medium text-slate-800">
                            {io.status.replace('_', ' ')}
                            {io.pregnancy_checked === 1 && ' · Pregnancy checked'}
                          </div>
                          {io.impression && (
                            <div className="text-slate-600 mt-0.5 truncate">Impression: {io.impression}</div>
                          )}
                          {io.addendum && (
                            <div className="text-teal-800 mt-0.5 truncate">Addendum: {io.addendum}</div>
                          )}
                        </td>
                        <td className="py-3 px-4 text-right whitespace-nowrap space-x-1.5">
                          {(io.status === 'ordered' || io.status === 'scheduled') && user.permissions.includes('imaging.exam.perform') && (
                            <button
                              onClick={() => {
                                setPerformTarget(io);
                                setPregnancyChecked(false);
                                setExamNotes('');
                              }}
                              className="px-3 py-1 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded"
                            >
                              Perform Exam
                            </button>
                          )}
                          {io.status === 'performed' && user.permissions.includes('imaging.report.finalise') && (
                            <button
                              onClick={() => {
                                setReportTarget(io);
                                setFindings('');
                                setImpression('');
                              }}
                              className="px-3 py-1 text-xs font-medium text-white bg-sky-700 hover:bg-sky-800 rounded"
                            >
                              Finalise Report
                            </button>
                          )}
                          {io.status === 'reported_final' && user.permissions.includes('imaging.report.finalise') && (
                            <button
                              onClick={() => {
                                setAddendumTarget(io);
                                setAddendumText('');
                              }}
                              className="px-2.5 py-1 text-xs font-medium text-slate-700 border border-slate-200 hover:bg-slate-50 rounded"
                            >
                              Append Addendum
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* PHARMACY DISPENSING */}
      {tab === 'pharmacy' && canPharmacy && (
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          {prescriptions.length === 0 ? (
            <div className="p-10 text-center text-sm text-slate-500">No prescriptions in pharmacy queue.</div>
          ) : (
            <div className="divide-y divide-slate-200">
              {prescriptions.map((pr) => {
                const paidOk = pr.patient_type !== 'self-pay' || pr.invoice_status === 'paid';
                return (
                  <div key={pr.id} className="p-5 flex flex-wrap items-start justify-between gap-4">
                    <div className="space-y-2 flex-1 min-w-[280px]">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="font-mono font-semibold text-slate-900">Rx #{pr.id}</span>
                        <span className="text-slate-300">·</span>
                        <span className="font-medium text-slate-900">{pr.first_name} {pr.last_name} ({pr.mrn})</span>
                        <span className="text-slate-300">·</span>
                        <span className="text-slate-500">Prescribed by {pr.doctor_name}</span>
                      </div>

                      <div className="text-xs flex flex-wrap items-center gap-3">
                        <span className={pr.allergies && pr.allergies !== 'None known' ? 'text-red-700 font-semibold inline-flex items-center gap-1' : 'text-slate-500'}>
                          {pr.allergies && pr.allergies !== 'None known' && <AlertTriangle className="w-3.5 h-3.5" />}
                          Allergies: {pr.allergies || 'None known'}
                        </span>
                        <span className="text-slate-300">|</span>
                        <span className={paidOk ? 'text-emerald-700 font-medium font-mono' : 'text-red-700 font-semibold font-mono'}>
                          {pr.invoice_number} ({pr.invoice_status || 'paid'})
                        </span>
                        {!paidOk && pr.status === 'pending' && (
                          <label className="inline-flex items-center gap-1.5 text-amber-800 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={Boolean(emergencyRxBypass[pr.id])}
                              onChange={(e) => setEmergencyRxBypass({ ...emergencyRxBypass, [pr.id]: e.target.checked })}
                            />
                            <span>Emergency bypass</span>
                          </label>
                        )}
                      </div>

                      <div className="border border-slate-200 rounded-md divide-y divide-slate-100 text-xs mt-2">
                        {pr.items.map((it) => (
                          <div key={it.id} className="px-3 py-2 flex flex-wrap items-center justify-between gap-2">
                            <div>
                              <span className="font-semibold text-slate-900">{it.generic_name} {it.strength}</span>
                              <span className="text-slate-600"> — {it.dosage}, {it.frequency} ({it.duration_days}d)</span>
                            </div>
                            <div className="font-mono text-slate-600 tabular-nums">
                              Qty {it.quantity} · Batch {it.batch_number} · Stock {it.stock_qty} · Exp {it.expiry_date}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      {pr.status === 'pending' && user.permissions.includes('pharmacy.dispense') ? (
                        <button
                          onClick={() => handleDispense(pr.id)}
                          className="px-4 py-2 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md whitespace-nowrap"
                        >
                          Dispense &amp; Deduct Stock
                        </button>
                      ) : (
                        <span className="text-xs font-medium text-emerald-700 capitalize">
                          {pr.status}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Reject Lab Sample Modal */}
      {rejectTarget && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-lg max-w-md w-full">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3 className="font-display text-base font-semibold text-slate-900">
                Reject Sample · #{rejectTarget.id} ({rejectTarget.test_code})
              </h3>
              <button onClick={() => setRejectTarget(null)} className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleRejectSample} className="p-6 space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Specimen Rejection Reason *</label>
                <textarea
                  required
                  rows={2}
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  placeholder="e.g. Hemolyzed specimen, insufficient volume, or unlabeled tube"
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-md"
                />
              </div>
              <div className="pt-3 border-t border-slate-200 flex justify-end gap-2">
                <button type="button" onClick={() => setRejectTarget(null)} className="px-4 py-2 text-xs border border-slate-300 rounded-md">
                  Cancel
                </button>
                <button type="submit" className="px-4 py-2 text-xs font-medium text-white bg-red-700 hover:bg-red-800 rounded-md">
                  Reject &amp; Notify Doctor
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Amend Lab Result Modal */}
      {amendTarget && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-lg max-w-md w-full">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3 className="font-display text-base font-semibold text-slate-900">
                Amend Released Result · #{amendTarget.id}
              </h3>
              <button onClick={() => setAmendTarget(null)} className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleAmendLab} className="p-6 space-y-4">
              <div className="text-xs text-slate-600 font-mono">
                Current Value: <strong className="text-slate-900">{amendTarget.result_value}</strong>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Corrected Result *</label>
                  <input
                    required
                    value={amendValue}
                    onChange={(e) => setAmendValue(e.target.value)}
                    className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-md"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Flag</label>
                  <select
                    value={amendFlag}
                    onChange={(e) => setAmendFlag(e.target.value)}
                    className="w-full px-3 py-2 text-xs border border-slate-300 rounded-md bg-white"
                  >
                    <option value="normal">Normal</option>
                    <option value="high">High</option>
                    <option value="low">Low</option>
                    <option value="critical">Critical</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Mandatory Audit Reason *</label>
                <textarea
                  required
                  rows={2}
                  value={amendReason}
                  onChange={(e) => setAmendReason(e.target.value)}
                  placeholder="Reason for post-release amendment (previous value remains visible)"
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-md"
                />
              </div>
              <div className="pt-3 border-t border-slate-200 flex justify-end gap-2">
                <button type="button" onClick={() => setAmendTarget(null)} className="px-4 py-2 text-xs border border-slate-300 rounded-md">
                  Cancel
                </button>
                <button type="submit" className="px-4 py-2 text-xs font-medium text-white bg-amber-700 hover:bg-amber-800 rounded-md">
                  Save Amendment
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Perform Imaging Exam Modal */}
      {performTarget && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-lg max-w-md w-full">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3 className="font-display text-base font-semibold text-slate-900">
                Perform {performTarget.modality} · {performTarget.exam_name}
              </h3>
              <button onClick={() => setPerformTarget(null)} className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handlePerformImaging} className="p-6 space-y-4">
              <div className="text-xs text-slate-600">
                Patient: <strong className="text-slate-900">{performTarget.first_name} {performTarget.last_name}</strong> ({performTarget.sex} · DOB {performTarget.date_of_birth})
              </div>
              <label className="flex items-start gap-2 p-3 bg-slate-50 border border-slate-200 rounded-md text-xs text-slate-800">
                <input
                  type="checkbox"
                  checked={pregnancyChecked}
                  onChange={(e) => setPregnancyChecked(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  Radiation Safety Check: LMP / pregnancy screening verified prior to exposure (mandatory for reproductive-age female patients).
                </span>
              </label>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Technical / Acquisition Notes</label>
                <textarea
                  rows={2}
                  value={examNotes}
                  onChange={(e) => setExamNotes(e.target.value)}
                  placeholder="Views acquired, contrast dose, patient tolerance..."
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-md"
                />
              </div>
              <div className="pt-3 border-t border-slate-200 flex justify-end gap-2">
                <button type="button" onClick={() => setPerformTarget(null)} className="px-4 py-2 text-xs border border-slate-300 rounded-md">
                  Cancel
                </button>
                <button type="submit" className="px-4 py-2 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md">
                  Mark Exam Performed
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Finalise Imaging Report Modal */}
      {reportTarget && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-lg max-w-lg w-full">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3 className="font-display text-base font-semibold text-slate-900">
                Finalise Imaging Report · #{reportTarget.id}
              </h3>
              <button onClick={() => setReportTarget(null)} className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleFinaliseImaging} className="p-6 space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Findings *</label>
                <textarea
                  required
                  rows={3}
                  value={findings}
                  onChange={(e) => setFindings(e.target.value)}
                  placeholder="Detailed radiographic findings..."
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-md"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Impression / Conclusion *</label>
                <textarea
                  required
                  rows={2}
                  value={impression}
                  onChange={(e) => setImpression(e.target.value)}
                  placeholder="Concise diagnostic impression..."
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-md"
                />
              </div>
              <div className="pt-3 border-t border-slate-200 flex justify-end gap-2">
                <button type="button" onClick={() => setReportTarget(null)} className="px-4 py-2 text-xs border border-slate-300 rounded-md">
                  Cancel
                </button>
                <button type="submit" className="px-4 py-2 text-xs font-medium text-white bg-sky-700 hover:bg-sky-800 rounded-md">
                  Finalise &amp; Notify Doctor
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Imaging Addendum Modal */}
      {addendumTarget && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-lg max-w-md w-full">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3 className="font-display text-base font-semibold text-slate-900">
                Append Report Addendum · #{addendumTarget.id}
              </h3>
              <button onClick={() => setAddendumTarget(null)} className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleAddendumImaging} className="p-6 space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Addendum Note *</label>
                <textarea
                  required
                  rows={3}
                  value={addendumText}
                  onChange={(e) => setAddendumText(e.target.value)}
                  placeholder="Signed addendum (original finalised report remains locked)..."
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-md"
                />
              </div>
              <div className="pt-3 border-t border-slate-200 flex justify-end gap-2">
                <button type="button" onClick={() => setAddendumTarget(null)} className="px-4 py-2 text-xs border border-slate-300 rounded-md">
                  Cancel
                </button>
                <button type="submit" className="px-4 py-2 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-md">
                  Append Addendum
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
