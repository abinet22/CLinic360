import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Eye, FlaskConical, Lock, PackagePlus, Pill, Printer, RotateCcw, Scan, Upload, X } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { useRealtimeSync } from '../lib/useRealtimeSync';
import type {
  ImagingAttachment,
  ImagingOrder,
  LabAnalyteTemplate,
  LabOrder,
  LabPanelResultItem,
  Prescription,
  UserContext,
} from '../types';
import { PrintDocumentModal, type PrintDocRequest } from './PrintDocumentModal';

interface DiagnosticsPharmacyViewProps {
  user: UserContext;
  onNotify: (msg: string, type?: 'success' | 'error') => void;
  initialTab?: 'lab' | 'imaging' | 'pharmacy';
}

export const DiagnosticsPharmacyView: React.FC<DiagnosticsPharmacyViewProps> = ({ user, onNotify, initialTab }) => {
  const canLab = user.permissions.includes('lab.order.read');
  const canImaging = user.permissions.includes('imaging.order.read');
  const canPharmacy = user.permissions.includes('pharmacy.prescription.read');
  const canCreateRequisition = user.permissions.includes('store.requisition.create');

  const canBypassGate = user.permissions.includes('payment.gate.bypass');

  const defaultTab = initialTab || (canLab ? 'lab' : canImaging ? 'imaging' : 'pharmacy');
  const [tab, setTab] = useState<'lab' | 'imaging' | 'pharmacy'>(defaultTab);

  useEffect(() => {
    if (initialTab) {
      setTab(initialTab);
    }
  }, [initialTab]);
  const [labOrders, setLabOrders] = useState<LabOrder[]>([]);
  const [imagingOrders, setImagingOrders] = useState<ImagingOrder[]>([]);
  const [prescriptions, setPrescriptions] = useState<Prescription[]>([]);

  const [resultDrafts, setResultDrafts] = useState<Record<number, { value: string; flag: string }>>({});
  const [emergencyLabBypass, setEmergencyLabBypass] = useState<Record<number, boolean>>({});
  const [labBypassReason, setLabBypassReason] = useState<Record<number, string>>({});
  const [imagingBypass, setImagingBypass] = useState<Record<number, boolean>>({});
  const [imagingBypassReason, setImagingBypassReason] = useState<Record<number, string>>({});
  const [emergencyRxBypass, setEmergencyRxBypass] = useState<Record<number, boolean>>({});
  const [rxBypassReason, setRxBypassReason] = useState<Record<number, string>>({});
  const [allergyOverrideReason, setAllergyOverrideReason] = useState<Record<number, string>>({});
  const [selectedQtyDrafts, setSelectedQtyDrafts] = useState<Record<number, Record<number, string>>>({});
  const [dispenseQtyDrafts, setDispenseQtyDrafts] = useState<Record<number, Record<number, string>>>({});
  const [printRequest, setPrintRequest] = useState<PrintDocRequest | null>(null);
  const [restockTarget, setRestockTarget] = useState<{ storeItemId: number; name: string } | null>(null);
  const [restockQty, setRestockQty] = useState('50');
  const [restockNotes, setRestockNotes] = useState('');

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

  const [panelModal, setPanelModal] = useState<{
    order: LabOrder;
    isAmend: boolean;
    rows: LabPanelResultItem[];
    notes: string;
    amendReason: string;
  } | null>(null);

  const [attachmentModalOrder, setAttachmentModalOrder] = useState<ImagingOrder | null>(null);
  const [attachments, setAttachments] = useState<ImagingAttachment[]>([]);
  const [attCaption, setAttCaption] = useState('');
  const [attFile, setAttFile] = useState<{ file_name: string; mime_type: string; data_url: string } | null>(null);
  const [attInvert, setAttInvert] = useState(false);

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

  useRealtimeSync(
    ['lab:updated', 'imaging:updated', 'pharmacy:updated', 'payment:confirmed', 'visit:updated'],
    () => {
      loadData();
    }
  );

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
          bypass_reason: emergencyLabBypass[id] ? labBypassReason[id] : undefined,
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
          bypass_reason: emergencyLabBypass[rejectTarget.id] ? labBypassReason[rejectTarget.id] : undefined,
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
          bypass_payment_gate: Boolean(imagingBypass[performTarget.id]),
          bypass_reason: imagingBypass[performTarget.id] ? imagingBypassReason[performTarget.id] : undefined,
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

  async function handleBillPrescription(pr: Prescription) {
    try {
      const draft = selectedQtyDrafts[pr.id] || {};
      const itemsPayload = pr.items.map((it) => {
        const defaultOnSite = Math.min(Number(it.quantity), Math.max(0, Number(it.stock_qty || 0)));
        const chosen = draft[it.id] !== undefined ? Number(draft[it.id]) : defaultOnSite;
        return {
          item_id: it.id,
          selected_qty: Math.max(0, Math.min(Number(it.quantity), Math.floor(chosen))),
        };
      });
      const res = await apiFetch<{
        status: string;
        allExternal?: boolean;
        invoiceNumber?: string | null;
        totalAmount?: number;
      }>(`/api/pharmacy/prescriptions/${pr.id}/bill`, {
        method: 'POST',
        body: JSON.stringify({ items: itemsPayload }),
      });
      if (res.allExternal) {
        onNotify(`Rx #${pr.id}: all items marked external purchase (no clinic charge)`, 'success');
      } else {
        onNotify(
          `Rx #${pr.id} billed · Invoice ${res.invoiceNumber} ($${Number(res.totalAmount || 0).toFixed(2)}) · ${
            res.status === 'pending_payment' ? 'Send patient to Cashier' : 'Cleared to dispense'
          }`,
          'success'
        );
      }
      loadData();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleDispense(pr: Prescription, completeVisit = false) {
    try {
      const rxDraft = dispenseQtyDrafts[pr.id] || {};
      const itemsPayload = pr.items.map((it) => {
        const targetOnSite = it.selected_qty !== undefined && it.selected_qty !== null ? Number(it.selected_qty) : Number(it.quantity);
        const remaining = Math.max(0, targetOnSite - Number(it.dispensed_qty || 0));
        const val = rxDraft[it.id] !== undefined ? Number(rxDraft[it.id]) : remaining;
        return { item_id: it.id, dispense_qty: Math.max(0, val) };
      });
      const res = await apiFetch<{
        status: string;
        visitCompleted?: boolean;
        fefoAllocations?: Array<{ medicine: string; qty: number; batches: Array<{ batch: string; taken: number }> }>;
      }>(`/api/pharmacy/dispense/${pr.id}`, {
        method: 'POST',
        body: JSON.stringify({
          bypass_payment_gate: Boolean(emergencyRxBypass[pr.id]),
          bypass_reason: emergencyRxBypass[pr.id] ? rxBypassReason[pr.id] : undefined,
          overrideAllergyReason: allergyOverrideReason[pr.id]?.trim() || undefined,
          complete_visit: completeVisit,
          items: itemsPayload,
        }),
      });
      const batchMsg = res.fefoAllocations
        ?.map((a) => `${a.medicine}: ${a.batches.map((b) => `${b.batch}(${b.taken})`).join('+')}`)
        .filter(Boolean)
        .join('; ');
      onNotify(
        `Rx #${pr.id} ${res.status === 'partial' ? 'partially dispensed' : 'dispensed'}${batchMsg ? ` · FEFO: ${batchMsg}` : ''}${res.visitCompleted ? ' · Visit Completed' : ''}`,
        'success'
      );
      loadData();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleRequestRestock(e: React.FormEvent) {
    e.preventDefault();
    if (!restockTarget) return;
    try {
      const res = await apiFetch<{ reqNumber: string }>('/api/store/requisitions', {
        method: 'POST',
        body: JSON.stringify({
          to_location: 'dispensary',
          item_id: restockTarget.storeItemId,
          requested_qty: Number(restockQty),
          notes: restockNotes || `Dispensary restock request for ${restockTarget.name}`,
        }),
      });
      onNotify(`Requisition ${res.reqNumber} sent to Main Storekeeper`, 'success');
      setRestockTarget(null);
      setRestockNotes('');
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  function parseTemplate(lo: LabOrder): LabAnalyteTemplate[] {
    if (!lo.analyte_template_json) return [];
    try {
      const parsed = JSON.parse(lo.analyte_template_json);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function parsePanelResults(lo: LabOrder): LabPanelResultItem[] {
    if (!lo.panel_results_json) return [];
    try {
      const parsed = JSON.parse(lo.panel_results_json);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function openPanelEntry(lo: LabOrder, isAmend = false) {
    const existing = parsePanelResults(lo);
    const tmpl = parseTemplate(lo);
    const rows: LabPanelResultItem[] =
      existing.length > 0
        ? existing
        : tmpl.map((t) => ({
            code: t.code,
            analyte: t.name,
            value: '',
            unit: t.unit,
            refRange: t.refRange,
            flag: 'normal',
          }));
    setPanelModal({
      order: lo,
      isAmend,
      rows,
      notes: lo.result_notes || '',
      amendReason: '',
    });
  }

  async function handleSubmitPanel(e: React.FormEvent) {
    e.preventDefault();
    if (!panelModal) return;
    try {
      await apiFetch(`/api/lab/orders/${panelModal.order.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          action: panelModal.isAmend ? 'amend' : 'enter_result',
          panel_results: panelModal.rows,
          result_notes: panelModal.notes || undefined,
          amend_reason: panelModal.isAmend ? panelModal.amendReason : undefined,
          bypass_payment_gate: Boolean(emergencyLabBypass[panelModal.order.id]),
        }),
      });
      onNotify(
        `Multi-analyte panel #${panelModal.order.id} ${panelModal.isAmend ? 'amended' : 'submitted'}`,
        'success'
      );
      setPanelModal(null);
      loadData();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function openAttachmentsModal(io: ImagingOrder) {
    setAttachmentModalOrder(io);
    setAttCaption('');
    setAttFile(null);
    setAttInvert(false);
    try {
      const res = await apiFetch<{ attachments: ImagingAttachment[] }>(`/api/imaging/orders/${io.id}/attachments`);
      setAttachments(res.attachments);
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  function handleSelectScanFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2_800_000) {
      onNotify('Selected file exceeds 2.8 MB upload limit.', 'error');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setAttFile({
          file_name: file.name,
          mime_type: file.type || 'application/octet-stream',
          data_url: reader.result,
        });
      }
    };
    reader.readAsDataURL(file);
  }

  async function handleUploadAttachment(e: React.FormEvent) {
    e.preventDefault();
    if (!attachmentModalOrder || !attFile) return;
    try {
      await apiFetch(`/api/imaging/orders/${attachmentModalOrder.id}/attachments`, {
        method: 'POST',
        body: JSON.stringify({
          ...attFile,
          caption: attCaption || undefined,
        }),
      });
      onNotify(`Uploaded ${attFile.file_name} to imaging study #${attachmentModalOrder.id}`, 'success');
      setAttFile(null);
      setAttCaption('');
      const res = await apiFetch<{ attachments: ImagingAttachment[] }>(
        `/api/imaging/orders/${attachmentModalOrder.id}/attachments`
      );
      setAttachments(res.attachments);
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
                    const isEmergency = lo.triage_priority === 'emergency';
                    const bypassValid =
                      canBypassGate &&
                      Boolean(emergencyLabBypass[lo.id]) &&
                      (labBypassReason[lo.id]?.trim().length ?? 0) >= 5;
                    const gateCleared = paidOk || isEmergency || bypassValid;
                    const tmpl = parseTemplate(lo);
                    const panelItems = parsePanelResults(lo);
                    const isPanel = tmpl.length > 0;
                    return (
                      <tr key={lo.id} className="hover:bg-slate-50/70">
                        <td className="py-3 px-4 font-mono text-xs">
                          <div className="font-semibold text-slate-900">#{lo.id} · {lo.test_code}</div>
                          <div className="text-slate-500">{lo.sample_barcode || lo.sample_type}</div>
                        </td>
                        <td className="py-3 px-4">
                          <div className="font-medium text-slate-900">{lo.first_name} {lo.last_name}</div>
                          <div className="text-xs font-mono text-slate-500">
                            {lo.mrn} {isEmergency && '· EMERGENCY'}
                          </div>
                        </td>
                        <td className="py-3 px-4 text-xs">
                          <div className="font-medium text-slate-900">
                            {lo.test_name}
                            {isPanel && <span className="font-mono text-teal-800 ml-1">({tmpl.length}-analyte panel)</span>}
                          </div>
                          <div className="text-slate-500 font-mono">Ref: {lo.reference_range || '—'} {lo.unit || ''}</div>
                        </td>
                        <td className="py-3 px-4 text-xs">
                          <div className={paidOk ? 'text-emerald-700 font-medium inline-flex items-center gap-1' : 'text-red-700 font-semibold inline-flex items-center gap-1'}>
                            {!paidOk && !isEmergency && <Lock className="w-3 h-3" />}
                            <span>
                              {paidOk
                                ? lo.status === 'ordered'
                                  ? 'Paid - Pending Sample'
                                  : `${lo.invoice_number || 'Direct'} · ${lo.invoice_status || 'paid'}`
                                : isEmergency
                                  ? 'Emergency Override Active'
                                  : `Pending Payment (${lo.invoice_number || 'Cashier'})`}
                            </span>
                          </div>
                          {!paidOk && !isEmergency && lo.status !== 'verified' && canBypassGate && (
                            <div className="mt-1 space-y-1">
                              <label className="inline-flex items-center gap-1.5 text-[11px] text-amber-800 cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={Boolean(emergencyLabBypass[lo.id])}
                                  onChange={(e) => setEmergencyLabBypass({ ...emergencyLabBypass, [lo.id]: e.target.checked })}
                                />
                                <span>Clinical gate override</span>
                              </label>
                              {emergencyLabBypass[lo.id] && (
                                <input
                                  value={labBypassReason[lo.id] || ''}
                                  onChange={(e) => setLabBypassReason({ ...labBypassReason, [lo.id]: e.target.value })}
                                  placeholder="Reason (min 5 chars)..."
                                  className="block w-44 px-2 py-0.5 text-[11px] border border-amber-300 rounded"
                                />
                              )}
                            </div>
                          )}
                        </td>
                        <td className="py-3 px-4 text-xs">
                          {lo.status === 'collected' && user.permissions.includes('lab.result.enter') ? (
                            isPanel ? (
                              <button
                                onClick={() => openPanelEntry(lo, false)}
                                className="px-3 py-1.5 text-xs font-medium text-teal-800 border border-teal-300 bg-teal-50/70 hover:bg-teal-100/70 rounded"
                              >
                                Enter {tmpl.length}-Analyte Panel
                              </button>
                            ) : (
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
                            )
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
                              {panelItems.length > 0 && (
                                <div className="flex flex-wrap gap-1.5 font-mono text-[11px] text-slate-600">
                                  {panelItems.map((pi, idx) => (
                                    <span key={idx} className={pi.flag && pi.flag !== 'normal' ? 'text-red-700 font-semibold' : ''}>
                                      {pi.code || pi.analyte}:{pi.value}
                                    </span>
                                  ))}
                                </div>
                              )}
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
                            gateCleared ? (
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
                            ) : (
                              <span className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-500 bg-slate-100 rounded">
                                <Lock className="w-3 h-3" />
                                <span>Locked Until Paid</span>
                              </span>
                            )
                          )}
                          {lo.status === 'collected' && user.permissions.includes('lab.result.enter') && (
                            <>
                              {!isPanel && (
                                <button
                                  onClick={() => handleLabAction(lo.id, 'enter_result')}
                                  className="px-3 py-1 text-xs font-medium text-white bg-sky-700 hover:bg-sky-800 rounded"
                                >
                                  Submit Result
                                </button>
                              )}
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
                              <button
                                onClick={() => setPrintRequest({ type: 'lab', orderId: lo.id })}
                                className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium text-teal-800 border border-teal-200 hover:bg-teal-50 rounded"
                              >
                                <Printer className="w-3 h-3" />
                                <span>Print Report</span>
                              </button>
                              {user.permissions.includes('lab.result.verify') && (
                                <button
                                  onClick={() => {
                                    if (isPanel) {
                                      openPanelEntry(lo, true);
                                    } else {
                                      setAmendTarget(lo);
                                      setAmendValue(lo.result_value || '');
                                      setAmendFlag(lo.abnormal_flag || 'normal');
                                    }
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
                    const bypassValid =
                      canBypassGate &&
                      Boolean(imagingBypass[io.id]) &&
                      (imagingBypassReason[io.id]?.trim().length ?? 0) >= 5;
                    const gateCleared = paidOk || bypassValid;
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
                          <div className={paidOk ? 'text-emerald-700 font-medium inline-flex items-center gap-1' : 'text-red-700 font-semibold inline-flex items-center gap-1'}>
                            {!paidOk && <Lock className="w-3 h-3" />}
                            <span>
                              {paidOk
                                ? io.status === 'ordered' || io.status === 'scheduled'
                                  ? 'Paid - Pending Scan'
                                  : `${io.invoice_number || 'Direct'} · ${io.invoice_status || 'paid'}`
                                : `Pending Payment (${io.invoice_number || 'Cashier'})`}
                            </span>
                          </div>
                          {!paidOk && (io.status === 'ordered' || io.status === 'scheduled') && canBypassGate && (
                            <div className="mt-1 space-y-1">
                              <label className="inline-flex items-center gap-1.5 text-[11px] text-amber-800 cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={Boolean(imagingBypass[io.id])}
                                  onChange={(e) => setImagingBypass({ ...imagingBypass, [io.id]: e.target.checked })}
                                />
                                <span>Clinical gate override</span>
                              </label>
                              {imagingBypass[io.id] && (
                                <input
                                  value={imagingBypassReason[io.id] || ''}
                                  onChange={(e) => setImagingBypassReason({ ...imagingBypassReason, [io.id]: e.target.value })}
                                  placeholder="Reason (min 5 chars)..."
                                  className="block w-44 px-2 py-0.5 text-[11px] border border-amber-300 rounded"
                                />
                              )}
                            </div>
                          )}
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
                          <button
                            onClick={() => openAttachmentsModal(io)}
                            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-700 border border-slate-300 hover:bg-slate-50 rounded"
                          >
                            <Eye className="w-3 h-3" />
                            <span>Scans ({io.attachment_count ?? 0})</span>
                          </button>
                          {(io.status === 'ordered' || io.status === 'scheduled') && user.permissions.includes('imaging.exam.perform') && (
                            gateCleared ? (
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
                            ) : (
                              <span className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-500 bg-slate-100 rounded">
                                <Lock className="w-3 h-3" />
                                <span>Locked Until Paid</span>
                              </span>
                            )
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
                          {io.status === 'reported_final' && (
                            <>
                              <button
                                onClick={() => setPrintRequest({ type: 'imaging', orderId: io.id })}
                                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-teal-800 border border-teal-200 hover:bg-teal-50 rounded"
                              >
                                <Printer className="w-3 h-3" />
                                <span>Print Report</span>
                              </button>
                              {user.permissions.includes('imaging.report.finalise') && (
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
                            </>
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
                const isStockCheck = pr.status === 'awaiting_stock_check';
                const isPendingPay = pr.status === 'pending_payment';
                const isReadyStage =
                  pr.status === 'paid_ready_to_dispense' || pr.status === 'pending' || pr.status === 'partial';
                const paidOk =
                  pr.patient_type !== 'self-pay' ||
                  pr.invoice_status === 'paid' ||
                  pr.status === 'paid_ready_to_dispense';
                const bypassValid =
                  canBypassGate &&
                  Boolean(emergencyRxBypass[pr.id]) &&
                  (rxBypassReason[pr.id]?.trim().length ?? 0) >= 5;
                const canDispenseNow = isReadyStage && (paidOk || bypassValid) && user.permissions.includes('pharmacy.dispense');

                const selectedEstimate = pr.items.reduce((sum, it) => {
                  const defaultOnSite = Math.min(Number(it.quantity), Math.max(0, Number(it.stock_qty || 0)));
                  const selVal =
                    selectedQtyDrafts[pr.id]?.[it.id] !== undefined
                      ? Number(selectedQtyDrafts[pr.id][it.id])
                      : defaultOnSite;
                  const clamped = Math.max(0, Math.min(Number(it.quantity), Math.floor(selVal || 0)));
                  return sum + clamped * Number(it.unit_price || 0);
                }, 0);

                const allergyWords = (pr.allergies || '')
                  .toLowerCase()
                  .split(/[,;/\s]+/)
                  .map((s) => s.trim())
                  .filter((s) => s.length >= 3 && s !== 'none' && s !== 'known' && s !== 'restricted');
                const hasAllergyAlert =
                  allergyWords.length > 0 &&
                  pr.items.some((it) => {
                    const g = it.generic_name.toLowerCase();
                    return (
                      allergyWords.some((w) => g.includes(w) || w.includes(g)) ||
                      (allergyWords.some((w) => w.includes('penicillin')) && (g.includes('amoxicillin') || g.includes('ampicillin'))) ||
                      (allergyWords.some((w) => w.includes('sulfa')) && g.includes('sulfamethoxazole'))
                    );
                  });

                return (
                  <div key={pr.id} className="p-5 space-y-3">
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div className="space-y-1.5">
                        <div className="flex flex-wrap items-center gap-2 text-xs">
                          <span className="font-mono font-semibold text-slate-900">Rx #{pr.id}</span>
                          {pr.visit_number && <span className="font-mono text-slate-500">· {pr.visit_number}</span>}
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
                          {isStockCheck ? (
                            <span className="font-medium text-sky-700">Step 1: Confirm In-Stock Quantities &amp; Bill</span>
                          ) : isPendingPay ? (
                            <span className="font-semibold text-red-700 font-mono inline-flex items-center gap-1">
                              <Lock className="w-3 h-3" />
                              <span>{pr.invoice_number} (Pending Payment at Cashier)</span>
                            </span>
                          ) : (
                            <span className={paidOk ? 'text-emerald-700 font-medium font-mono' : 'text-red-700 font-semibold font-mono'}>
                              {pr.invoice_number || 'Direct'} ({pr.status === 'dispensed' ? 'Dispensed' : pr.invoice_status || 'Paid - Ready to Dispense'})
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            setPrintRequest({
                              type: 'prescription',
                              data: {
                                prescriptionId: pr.id,
                                visitNumber: pr.visit_number || `VISIT-${pr.visit_id}`,
                                mrn: pr.mrn,
                                patientName: `${pr.first_name} ${pr.last_name}`,
                                allergies: pr.allergies,
                                doctorName: pr.doctor_name,
                                status: pr.status,
                                items: pr.items,
                              },
                            })
                          }
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-teal-800 border border-teal-200 hover:bg-teal-50 rounded-md"
                        >
                          <Printer className="w-3.5 h-3.5" />
                          <span>Print Final Rx</span>
                        </button>

                        {isStockCheck && user.permissions.includes('pharmacy.dispense') && (
                          <button
                            type="button"
                            onClick={() => handleBillPrescription(pr)}
                            className="px-4 py-1.5 text-xs font-medium text-white bg-sky-700 hover:bg-sky-800 rounded-md whitespace-nowrap"
                          >
                            Confirm Stock &amp; Bill (${selectedEstimate.toFixed(2)})
                          </button>
                        )}

                        {isPendingPay && !paidOk && !bypassValid && (
                          <span className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-slate-600 bg-slate-100 rounded-md">
                            <Lock className="w-3.5 h-3.5" />
                            <span>Locked Until Cashier Payment</span>
                          </span>
                        )}

                        {canDispenseNow && (
                          <>
                            <button
                              type="button"
                              onClick={() => handleDispense(pr, false)}
                              className="px-3.5 py-1.5 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md whitespace-nowrap"
                            >
                              {pr.status === 'partial' ? 'Dispense Remaining (FEFO)' : 'Dispense (FEFO)'}
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDispense(pr, true)}
                              className="px-3.5 py-1.5 text-xs font-medium text-white bg-emerald-700 hover:bg-emerald-800 rounded-md whitespace-nowrap"
                            >
                              Dispense &amp; Complete Visit
                            </button>
                          </>
                        )}

                        {pr.status === 'dispensed' && (
                          <span className="text-xs font-medium text-emerald-700 inline-flex items-center gap-1">
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            <span>Dispensed</span>
                          </span>
                        )}
                      </div>
                    </div>

                    {isPendingPay && !paidOk && canBypassGate && (
                      <div className="p-2.5 bg-amber-50 border border-amber-200 rounded text-xs flex flex-wrap items-center gap-2">
                        <label className="inline-flex items-center gap-1.5 text-amber-900 font-medium cursor-pointer">
                          <input
                            type="checkbox"
                            checked={Boolean(emergencyRxBypass[pr.id])}
                            onChange={(e) => setEmergencyRxBypass({ ...emergencyRxBypass, [pr.id]: e.target.checked })}
                          />
                          <span>Authorize clinical payment-gate override</span>
                        </label>
                        {emergencyRxBypass[pr.id] && (
                          <input
                            value={rxBypassReason[pr.id] || ''}
                            onChange={(e) => setRxBypassReason({ ...rxBypassReason, [pr.id]: e.target.value })}
                            placeholder="Mandatory override audit reason (min 5 chars)..."
                            className="flex-1 min-w-[200px] px-2.5 py-1 text-xs bg-white border border-amber-300 rounded"
                          />
                        )}
                      </div>
                    )}

                    {hasAllergyAlert && pr.status !== 'dispensed' && (
                      <div className="p-2.5 bg-red-50 border border-red-200 rounded text-xs text-red-900 flex flex-wrap items-center gap-2">
                        <AlertTriangle className="w-4 h-4 text-red-700 shrink-0" />
                        <span className="font-semibold">Allergy Safety Warning ({pr.allergies}) — Override reason required to dispense:</span>
                        <input
                          value={allergyOverrideReason[pr.id] || ''}
                          onChange={(e) => setAllergyOverrideReason({ ...allergyOverrideReason, [pr.id]: e.target.value })}
                          placeholder="Prescriber confirmation / clinical justification (min 5 chars)..."
                          className="flex-1 min-w-[220px] px-2.5 py-1 text-xs bg-white border border-red-300 rounded"
                        />
                      </div>
                    )}

                    <div className="border border-slate-200 rounded-md divide-y divide-slate-100 text-xs">
                      {pr.items.map((it) => {
                        const defaultOnSite = Math.min(Number(it.quantity), Math.max(0, Number(it.stock_qty || 0)));
                        const selDraft =
                          selectedQtyDrafts[pr.id]?.[it.id] !== undefined
                            ? selectedQtyDrafts[pr.id][it.id]
                            : String(defaultOnSite);
                        const onSiteChosen = Math.max(0, Math.min(Number(it.quantity), Math.floor(Number(selDraft || 0))));
                        const extCalc = Math.max(0, Number(it.quantity) - onSiteChosen);

                        const targetOnSite =
                          it.selected_qty !== undefined && it.selected_qty !== null ? Number(it.selected_qty) : Number(it.quantity);
                        const remaining = Math.max(0, targetOnSite - Number(it.dispensed_qty || 0));
                        const draftQty = dispenseQtyDrafts[pr.id]?.[it.id] ?? String(remaining);
                        const canEditDispenseQty = isReadyStage && remaining > 0;

                        return (
                          <div key={it.id} className="px-3 py-2.5 space-y-1.5">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div>
                                <span className="font-semibold text-slate-900">{it.generic_name} {it.strength}</span>
                                <span className="text-slate-600"> — {it.dosage}, {it.frequency} ({it.duration_days}d)</span>
                              </div>
                              <div className="flex flex-wrap items-center gap-2.5 font-mono text-slate-600 tabular-nums">
                                {isStockCheck ? (
                                  <>
                                    <span>Rx Qty {it.quantity} · Stock {it.stock_qty}</span>
                                    {user.permissions.includes('pharmacy.dispense') && (
                                      <label className="inline-flex items-center gap-1 text-slate-800">
                                        <span>Bill On-Site:</span>
                                        <input
                                          type="number"
                                          min={0}
                                          max={Math.min(Number(it.quantity), Math.max(0, Number(it.stock_qty || 0)))}
                                          value={selDraft}
                                          onChange={(e) =>
                                            setSelectedQtyDrafts((prev) => ({
                                              ...prev,
                                              [pr.id]: { ...(prev[pr.id] || {}), [it.id]: e.target.value },
                                            }))
                                          }
                                          className="w-16 px-1.5 py-0.5 text-xs border border-slate-300 rounded"
                                        />
                                      </label>
                                    )}
                                    {extCalc > 0 && (
                                      <span className="text-amber-700 font-semibold">Ext Rx: {extCalc}</span>
                                    )}
                                  </>
                                ) : (
                                  <>
                                    <span>
                                      Dispensed {it.dispensed_qty || 0}/{targetOnSite} · Stock {it.stock_qty}
                                      {Number(it.external_qty || 0) > 0 && ` · External: ${it.external_qty}`}
                                    </span>
                                    {canEditDispenseQty && user.permissions.includes('pharmacy.dispense') && (
                                      <label className="inline-flex items-center gap-1 text-slate-700">
                                        <span>Now:</span>
                                        <input
                                          type="number"
                                          min={0}
                                          max={remaining}
                                          value={draftQty}
                                          onChange={(e) =>
                                            setDispenseQtyDrafts((prev) => ({
                                              ...prev,
                                              [pr.id]: { ...(prev[pr.id] || {}), [it.id]: e.target.value },
                                            }))
                                          }
                                          className="w-16 px-1.5 py-0.5 text-xs border border-slate-300 rounded"
                                        />
                                      </label>
                                    )}
                                  </>
                                )}
                                {canCreateRequisition && it.store_item_id && (
                                  <button
                                    type="button"
                                    onClick={() => setRestockTarget({ storeItemId: it.store_item_id!, name: `${it.generic_name} ${it.strength}` })}
                                    className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-sans font-medium text-teal-800 border border-teal-200 hover:bg-teal-50 rounded"
                                  >
                                    <PackagePlus className="w-3 h-3" />
                                    <span>Restock</span>
                                  </button>
                                )}
                              </div>
                            </div>
                            {it.fefo_batches && it.fefo_batches.length > 0 ? (
                              <div className="font-mono text-[11px] text-teal-800">
                                FEFO Pick Order: {it.fefo_batches.map((b) => `${b.batch_number} (${b.qty_on_hand}u · Exp ${b.expiry_date})`).join(' → ')}
                              </div>
                            ) : (
                              <div className="font-mono text-[11px] text-slate-500">
                                Batch {it.batch_number} · Exp {it.expiry_date}
                              </div>
                            )}
                          </div>
                        );
                      })}
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
      {/* Dispensary Restock Requisition Modal */}
      {restockTarget && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-lg max-w-md w-full">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3 className="font-display text-base font-semibold text-slate-900">
                Request Restock · {restockTarget.name}
              </h3>
              <button onClick={() => setRestockTarget(null)} className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleRequestRestock} className="p-6 space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Requested Quantity from Main Store *</label>
                <input
                  type="number"
                  min={1}
                  required
                  value={restockQty}
                  onChange={(e) => setRestockQty(e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-md"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Notes</label>
                <input
                  value={restockNotes}
                  onChange={(e) => setRestockNotes(e.target.value)}
                  placeholder="Urgent dispensary replenishment"
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-md"
                />
              </div>
              <div className="pt-3 border-t border-slate-200 flex justify-end gap-2">
                <button type="button" onClick={() => setRestockTarget(null)} className="px-4 py-2 text-xs border border-slate-300 rounded-md">
                  Cancel
                </button>
                <button type="submit" className="px-4 py-2 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md">
                  Send Requisition to Store
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Multi-Analyte Lab Panel Modal */}
      {panelModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3 className="font-display text-base font-semibold text-slate-900">
                {panelModal.isAmend ? 'Amend Multi-Analyte Panel' : 'Enter Multi-Analyte Panel'} · {panelModal.order.test_name} (#{panelModal.order.id})
              </h3>
              <button onClick={() => setPanelModal(null)} className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleSubmitPanel} className="p-6 space-y-4">
              <table className="w-full text-left border-collapse border border-slate-200 text-xs">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-slate-500">
                    <th className="py-2 px-3">Analyte</th>
                    <th className="py-2 px-3">Reference Range</th>
                    <th className="py-2 px-3">Result Value *</th>
                    <th className="py-2 px-3">Flag</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {panelModal.rows.map((row, idx) => (
                    <tr key={idx}>
                      <td className="py-2 px-3">
                        <div className="font-medium text-slate-900">{row.analyte}</div>
                        <div className="font-mono text-slate-500">{row.code} ({row.unit})</div>
                      </td>
                      <td className="py-2 px-3 font-mono text-slate-600">{row.refRange}</td>
                      <td className="py-2 px-3">
                        <input
                          required
                          value={row.value}
                          onChange={(e) => {
                            const next = [...panelModal.rows];
                            next[idx] = { ...row, value: e.target.value };
                            setPanelModal({ ...panelModal, rows: next });
                          }}
                          placeholder="Value"
                          className="w-28 px-2.5 py-1 text-xs font-mono border border-slate-300 rounded"
                        />
                      </td>
                      <td className="py-2 px-3">
                        <select
                          value={row.flag || 'normal'}
                          onChange={(e) => {
                            const next = [...panelModal.rows];
                            next[idx] = { ...row, flag: e.target.value as LabPanelResultItem['flag'] };
                            setPanelModal({ ...panelModal, rows: next });
                          }}
                          className="px-2 py-1 text-xs border border-slate-300 rounded bg-white"
                        >
                          <option value="normal">Normal</option>
                          <option value="high">High</option>
                          <option value="low">Low</option>
                          <option value="critical">Critical</option>
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Bench Technician Notes</label>
                <input
                  value={panelModal.notes}
                  onChange={(e) => setPanelModal({ ...panelModal, notes: e.target.value })}
                  placeholder="Analyzer run ID, smear morphology, dilution notes..."
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-md"
                />
              </div>
              {panelModal.isAmend && (
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Mandatory Audit Amendment Reason *</label>
                  <input
                    required
                    value={panelModal.amendReason}
                    onChange={(e) => setPanelModal({ ...panelModal, amendReason: e.target.value })}
                    placeholder="Reason for post-release correction..."
                    className="w-full px-3 py-2 text-xs border border-slate-300 rounded-md"
                  />
                </div>
              )}
              <div className="pt-3 border-t border-slate-200 flex justify-end gap-2">
                <button type="button" onClick={() => setPanelModal(null)} className="px-4 py-2 text-xs border border-slate-300 rounded-md">
                  Cancel
                </button>
                <button type="submit" className="px-4 py-2 text-xs font-medium text-white bg-sky-700 hover:bg-sky-800 rounded-md">
                  {panelModal.isAmend ? 'Save Panel Amendment' : 'Submit Panel for Senior Verification'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Imaging Attachments & Upload Modal */}
      {attachmentModalOrder && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3 className="font-display text-base font-semibold text-slate-900">
                Study Scans &amp; PACS Attachments · #{attachmentModalOrder.id} ({attachmentModalOrder.exam_name})
              </h3>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setAttInvert((v) => !v)}
                  className="px-2.5 py-1 text-xs border border-slate-300 rounded hover:bg-slate-50"
                >
                  {attInvert ? 'Normal View' : 'Invert X-Ray'}
                </button>
                <button onClick={() => setAttachmentModalOrder(null)} className="text-slate-400 hover:text-slate-700">
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>
            <div className="p-6 space-y-5">
              {(user.permissions.includes('imaging.exam.perform') || user.permissions.includes('imaging.report.finalise')) && (
                <form onSubmit={handleUploadAttachment} className="p-4 bg-slate-50 border border-slate-200 rounded-md space-y-3">
                  <div className="text-xs font-semibold text-slate-800 flex items-center gap-1.5">
                    <Upload className="w-3.5 h-3.5 text-teal-700" />
                    <span>Upload Radiograph / Ultrasound / PDF Capture (max 2.8 MB)</span>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <input
                      type="file"
                      accept="image/*,.pdf,.svg"
                      onChange={handleSelectScanFile}
                      className="text-xs text-slate-700"
                    />
                    <input
                      value={attCaption}
                      onChange={(e) => setAttCaption(e.target.value)}
                      placeholder="View / Caption (e.g. AP & Lateral Chest)"
                      className="px-2.5 py-1.5 text-xs border border-slate-300 rounded bg-white"
                    />
                  </div>
                  <div className="flex justify-end">
                    <button
                      type="submit"
                      disabled={!attFile}
                      className="px-3.5 py-1.5 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded disabled:opacity-40"
                    >
                      Attach Study Image
                    </button>
                  </div>
                </form>
              )}

              {attachments.length === 0 ? (
                <div className="py-8 text-center text-sm text-slate-500">No scans attached to this imaging order yet.</div>
              ) : (
                <div className="space-y-4">
                  {attachments.map((att) => (
                    <div key={att.id} className="border border-slate-200 rounded-md overflow-hidden">
                      <div className="px-3 py-2 bg-slate-50 border-b border-slate-200 flex justify-between text-xs">
                        <span className="font-mono font-medium text-slate-800">{att.file_name}</span>
                        <span className="text-slate-500">{att.uploaded_by_name || 'Radiology'} · {att.created_at}</span>
                      </div>
                      <div className="bg-slate-950 p-3 flex justify-center">
                        {att.mime_type === 'application/pdf' ? (
                          <iframe src={att.data_url} title={att.file_name} className="w-full h-80 bg-white rounded" />
                        ) : (
                          <img
                            src={att.data_url}
                            alt={att.caption || att.file_name}
                            className={`max-h-80 object-contain ${attInvert ? 'invert' : ''}`}
                          />
                        )}
                      </div>
                      {att.caption && <div className="px-3 py-2 text-xs text-slate-700">{att.caption}</div>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <PrintDocumentModal request={printRequest} onClose={() => setPrintRequest(null)} />
    </div>
  );
};
