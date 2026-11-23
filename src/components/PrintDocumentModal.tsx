import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Lock, Printer, X } from 'lucide-react';
import { apiFetch } from '../lib/api';
import type { IpdStatement, LabPanelResultItem } from '../types';

export type PrintDocRequest =
  | { type: 'lab'; orderId: number }
  | { type: 'imaging'; orderId: number }
  | { type: 'ipd_statement'; admissionId: number }
  | {
      type: 'prescription';
      data: {
        prescriptionId: number;
        visitNumber: string;
        mrn: string;
        patientName: string;
        sex?: string;
        dob?: string;
        allergies?: string | null;
        doctorName?: string | null;
        createdAt?: string;
        status: string;
        items: Array<{
          generic_name: string;
          strength: string;
          dosage: string;
          frequency: string;
          duration_days?: number;
          quantity: number;
          selected_qty?: number | null;
          external_qty?: number | null;
          dispensed_qty?: number;
          instructions?: string | null;
        }>;
      };
    };

interface PrintableLabPayload {
  id: number;
  visit_number: string;
  mrn: string;
  first_name: string;
  last_name: string;
  sex: string;
  date_of_birth: string;
  phone: string;
  test_code: string;
  test_name: string;
  sample_type: string;
  sample_barcode: string | null;
  unit: string | null;
  reference_range: string | null;
  result_value: string | null;
  previous_result_value: string | null;
  abnormal_flag: string | null;
  result_notes: string | null;
  panel_results_json?: string | null;
  amend_reason: string | null;
  status: string;
  ordered_by_name: string | null;
  entered_by_name: string | null;
  verified_by_name: string | null;
  verified_at: string | null;
  created_at: string;
}

interface PrintableImagingPayload {
  id: number;
  visit_number: string;
  mrn: string;
  first_name: string;
  last_name: string;
  sex: string;
  date_of_birth: string;
  exam_code: string;
  exam_name: string;
  modality: string;
  body_region: string;
  clinical_question: string | null;
  pregnancy_checked: number;
  exam_notes: string | null;
  findings: string | null;
  impression: string | null;
  addendum: string | null;
  status: string;
  ordered_by_name: string | null;
  performed_by_name: string | null;
  reported_by_name: string | null;
  finalised_at: string | null;
  created_at: string;
}

interface PrintDocumentModalProps {
  request: PrintDocRequest | null;
  onClose: () => void;
}

export const PrintDocumentModal: React.FC<PrintDocumentModalProps> = ({ request, onClose }) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [labReport, setLabReport] = useState<PrintableLabPayload | null>(null);
  const [imagingReport, setImagingReport] = useState<PrintableImagingPayload | null>(null);
  const [ipdStatement, setIpdStatement] = useState<IpdStatement | null>(null);

  useEffect(() => {
    if (!request) return;
    document.body.classList.add('has-print-modal');
    return () => {
      document.body.classList.remove('has-print-modal');
    };
  }, [request]);

  useEffect(() => {
    if (!request) return;
    setError(null);
    setLabReport(null);
    setImagingReport(null);
    setIpdStatement(null);

    if (request.type === 'prescription') {
      return;
    }

    setLoading(true);
    if (request.type === 'lab') {
      apiFetch<{ report: PrintableLabPayload }>(`/api/lab/orders/${request.orderId}/report`)
        .then((res) => setLabReport(res.report))
        .catch((err: Error) => setError(err.message))
        .finally(() => setLoading(false));
    } else if (request.type === 'imaging') {
      apiFetch<{ report: PrintableImagingPayload }>(`/api/imaging/orders/${request.orderId}/report`)
        .then((res) => setImagingReport(res.report))
        .catch((err: Error) => setError(err.message))
        .finally(() => setLoading(false));
    } else if (request.type === 'ipd_statement') {
      apiFetch<IpdStatement>(`/api/ipd/admissions/${request.admissionId}/statement`)
        .then((res) => setIpdStatement(res))
        .catch((err: Error) => setError(err.message))
        .finally(() => setLoading(false));
    }
  }, [request]);

  if (!request) return null;

  const docTitle =
    request.type === 'lab'
      ? 'Verified Laboratory Report'
      : request.type === 'imaging'
        ? 'Diagnostic Imaging Report'
        : request.type === 'prescription'
          ? 'Outpatient Prescription Sheet'
          : 'Inpatient Running Statement & Discharge Summary';

  return createPortal(
    <div className="print-modal-backdrop fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
      <div className="print-modal-card bg-white border border-slate-200 rounded-lg max-w-3xl w-full max-h-[90vh] overflow-y-auto p-6 sm:p-8 space-y-5">
        {/* Header Bar */}
        <div className="flex items-start justify-between border-b-2 border-slate-900 pb-4">
          <div>
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded bg-teal-700 text-white flex items-center justify-center font-display font-bold text-xs">
                C3
              </div>
              <span className="font-display font-bold text-lg text-slate-900">Clinic360 Central Medical</span>
            </div>
            <div className="text-xs font-semibold uppercase tracking-wider text-teal-800 mt-1">{docTitle}</div>
          </div>
          <div className="flex items-center gap-2 no-print">
            <button
              onClick={() => window.print()}
              disabled={loading || Boolean(error)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md disabled:opacity-40"
            >
              <Printer className="w-3.5 h-3.5" />
              <span>Print / Save PDF</span>
            </button>
            <button onClick={onClose} className="p-1.5 text-slate-400 hover:text-slate-700">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {loading && <div className="py-12 text-center text-sm text-slate-500">Loading official document...</div>}
        {error && <div className="p-4 bg-red-50 border border-red-200 rounded text-xs text-red-800">{error}</div>}

        {/* LAB REPORT */}
        {labReport && (
          <div className="space-y-5 text-xs">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 bg-slate-50 border border-slate-200 rounded p-3.5">
              <div>
                <div className="text-slate-500">Patient Name</div>
                <div className="font-semibold text-slate-900 mt-0.5">{labReport.first_name} {labReport.last_name}</div>
              </div>
              <div>
                <div className="text-slate-500">MRN / Demographics</div>
                <div className="font-mono text-slate-900 mt-0.5">{labReport.mrn} · {labReport.sex} · {labReport.date_of_birth}</div>
              </div>
              <div>
                <div className="text-slate-500">Visit / Order</div>
                <div className="font-mono text-slate-900 mt-0.5">{labReport.visit_number} · Lab #{labReport.id}</div>
              </div>
              <div>
                <div className="text-slate-500">Specimen Barcode</div>
                <div className="font-mono text-slate-900 mt-0.5">{labReport.sample_barcode || labReport.sample_type}</div>
              </div>
            </div>

            <table className="w-full text-left border-collapse border border-slate-200">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-slate-600">
                  <th className="py-2.5 px-3">Test Code &amp; Assay</th>
                  <th className="py-2.5 px-3">Result</th>
                  <th className="py-2.5 px-3">Unit</th>
                  <th className="py-2.5 px-3">Reference Range</th>
                  <th className="py-2.5 px-3">Flag</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-slate-200">
                  <td className="py-3 px-3">
                    <div className="font-semibold text-slate-900">{labReport.test_name}</div>
                    <div className="font-mono text-slate-500">{labReport.test_code} ({labReport.sample_type})</div>
                  </td>
                  <td className={`py-3 px-3 font-mono text-sm font-bold ${labReport.abnormal_flag === 'critical' ? 'text-red-700' : 'text-slate-900'}`}>
                    {labReport.result_value || 'Pending'}
                  </td>
                  <td className="py-3 px-3 font-mono text-slate-600">{labReport.unit || '—'}</td>
                  <td className="py-3 px-3 font-mono text-slate-600">{labReport.reference_range || '—'}</td>
                  <td className={`py-3 px-3 uppercase font-semibold ${labReport.abnormal_flag === 'critical' ? 'text-red-700' : labReport.abnormal_flag !== 'normal' ? 'text-amber-700' : 'text-emerald-700'}`}>
                    {labReport.abnormal_flag || 'normal'}
                  </td>
                </tr>
              </tbody>
            </table>

            {(() => {
              let panelItems: LabPanelResultItem[] = [];
              if (labReport.panel_results_json) {
                try {
                  const parsed = JSON.parse(labReport.panel_results_json);
                  if (Array.isArray(parsed)) panelItems = parsed;
                } catch {
                  panelItems = [];
                }
              }
              if (panelItems.length === 0) return null;
              return (
                <div>
                  <div className="font-semibold text-slate-800 mb-1.5">Multi-Analyte Panel Breakdown</div>
                  <table className="w-full text-left border-collapse border border-slate-200">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-200 text-slate-600">
                        <th className="py-2 px-3">Analyte</th>
                        <th className="py-2 px-3">Value</th>
                        <th className="py-2 px-3">Unit</th>
                        <th className="py-2 px-3">Reference Range</th>
                        <th className="py-2 px-3">Flag</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {panelItems.map((it, idx) => (
                        <tr key={idx}>
                          <td className="py-2 px-3 font-medium text-slate-900">
                            {it.code ? <span className="font-mono text-slate-500 mr-1.5">{it.code}</span> : null}
                            {it.analyte}
                          </td>
                          <td className="py-2 px-3 font-mono font-semibold text-slate-900">{it.value}</td>
                          <td className="py-2 px-3 font-mono text-slate-600">{it.unit || '—'}</td>
                          <td className="py-2 px-3 font-mono text-slate-600">{it.refRange || '—'}</td>
                          <td className={`py-2 px-3 uppercase font-semibold ${it.flag === 'critical' ? 'text-red-700' : it.flag && it.flag !== 'normal' ? 'text-amber-700' : 'text-emerald-700'}`}>
                            {it.flag || 'normal'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              );
            })()}

            {labReport.previous_result_value && (
              <div className="p-3 bg-amber-50 border border-amber-200 rounded text-amber-900">
                <strong>Post-Release Amendment Notice:</strong> Original value was{' '}
                <span className="font-mono">{labReport.previous_result_value}</span>. Reason: {labReport.amend_reason}
              </div>
            )}

            {labReport.result_notes && (
              <div>
                <div className="font-semibold text-slate-700">Laboratory Notes</div>
                <div className="mt-1 text-slate-700">{labReport.result_notes}</div>
              </div>
            )}

            <div className="pt-4 border-t border-slate-200 grid grid-cols-1 sm:grid-cols-3 gap-3 text-slate-600">
              <div>
                <div className="text-slate-400">Ordered By</div>
                <div className="font-medium text-slate-900">{labReport.ordered_by_name || 'Clinician'}</div>
              </div>
              <div>
                <div className="text-slate-400">Analysed By</div>
                <div className="font-medium text-slate-900">{labReport.entered_by_name || 'Lab Technician'}</div>
              </div>
              <div>
                <div className="text-slate-400">2-Person Senior Verification</div>
                <div className="font-medium text-slate-900">
                  {labReport.verified_by_name || 'Pending'}
                  {labReport.verified_at && ` · ${labReport.verified_at}`}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* IMAGING REPORT */}
        {imagingReport && (
          <div className="space-y-5 text-xs">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 bg-slate-50 border border-slate-200 rounded p-3.5">
              <div>
                <div className="text-slate-500">Patient Name</div>
                <div className="font-semibold text-slate-900 mt-0.5">{imagingReport.first_name} {imagingReport.last_name}</div>
              </div>
              <div>
                <div className="text-slate-500">MRN / Demographics</div>
                <div className="font-mono text-slate-900 mt-0.5">{imagingReport.mrn} · {imagingReport.sex} · {imagingReport.date_of_birth}</div>
              </div>
              <div>
                <div className="text-slate-500">Modality &amp; Region</div>
                <div className="font-mono text-slate-900 mt-0.5">{imagingReport.modality} · {imagingReport.body_region}</div>
              </div>
              <div>
                <div className="text-slate-500">Study / Visit</div>
                <div className="font-mono text-slate-900 mt-0.5">{imagingReport.visit_number} · #{imagingReport.id}</div>
              </div>
            </div>

            <div className="space-y-3">
              <div>
                <div className="font-semibold text-slate-700">Examination</div>
                <div className="text-sm font-semibold text-slate-900 mt-0.5">
                  [{imagingReport.exam_code}] {imagingReport.exam_name}
                </div>
                {imagingReport.clinical_question && (
                  <div className="text-slate-600 mt-1">Clinical Indication: {imagingReport.clinical_question}</div>
                )}
              </div>

              {imagingReport.exam_notes && (
                <div className="p-3 bg-slate-50 border border-slate-200 rounded">
                  <span className="font-semibold text-slate-700">Technical Acquisition: </span>
                  <span className="text-slate-700">{imagingReport.exam_notes}</span>
                  {imagingReport.pregnancy_checked === 1 && ' · Radiation pregnancy check verified.'}
                </div>
              )}

              <div>
                <div className="font-semibold text-slate-700 uppercase tracking-wide">Findings</div>
                <div className="mt-1 p-3.5 border border-slate-200 rounded bg-white text-slate-800 whitespace-pre-wrap leading-relaxed">
                  {imagingReport.findings || 'Findings pending'}
                </div>
              </div>

              <div>
                <div className="font-semibold text-slate-700 uppercase tracking-wide">Impression / Conclusion</div>
                <div className="mt-1 p-3.5 border border-slate-300 rounded bg-slate-50 font-semibold text-slate-900 whitespace-pre-wrap">
                  {imagingReport.impression || 'Impression pending'}
                </div>
              </div>

              {imagingReport.addendum && (
                <div className="p-3.5 border border-teal-200 bg-teal-50/50 rounded">
                  <div className="font-semibold text-teal-900">Signed Addendum</div>
                  <div className="mt-1 text-slate-800 whitespace-pre-wrap">{imagingReport.addendum}</div>
                </div>
              )}
            </div>

            <div className="pt-4 border-t border-slate-200 grid grid-cols-1 sm:grid-cols-3 gap-3 text-slate-600">
              <div>
                <div className="text-slate-400">Referring Clinician</div>
                <div className="font-medium text-slate-900">{imagingReport.ordered_by_name || 'Clinician'}</div>
              </div>
              <div>
                <div className="text-slate-400">Radiographer</div>
                <div className="font-medium text-slate-900">{imagingReport.performed_by_name || 'Radiology Tech'}</div>
              </div>
              <div>
                <div className="text-slate-400">Finalised By</div>
                <div className="font-medium text-slate-900">
                  {imagingReport.reported_by_name || 'Radiologist'}
                  {imagingReport.finalised_at && ` · ${imagingReport.finalised_at}`}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* OUTPATIENT PRESCRIPTION */}
        {request.type === 'prescription' && (
          <div className="space-y-5 text-xs">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 bg-slate-50 border border-slate-200 rounded p-3.5">
              <div>
                <div className="text-slate-500">Patient Name</div>
                <div className="font-semibold text-slate-900 mt-0.5">{request.data.patientName}</div>
              </div>
              <div>
                <div className="text-slate-500">MRN</div>
                <div className="font-mono text-slate-900 mt-0.5">{request.data.mrn}</div>
              </div>
              <div>
                <div className="text-slate-500">Visit / Rx No</div>
                <div className="font-mono text-slate-900 mt-0.5">{request.data.visitNumber} · Rx #{request.data.prescriptionId}</div>
              </div>
              <div>
                <div className="text-slate-500">Allergy Alert</div>
                <div className={`font-semibold mt-0.5 ${request.data.allergies && request.data.allergies !== 'None known' ? 'text-red-700' : 'text-slate-900'}`}>
                  {request.data.allergies || 'None known'}
                </div>
              </div>
            </div>

            <div className="border border-slate-200 rounded overflow-hidden">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-slate-600">
                    <th className="py-2.5 px-3">Medication</th>
                    <th className="py-2.5 px-3">Dosage &amp; Instructions</th>
                    <th className="py-2.5 px-3 text-right">Prescribed</th>
                    <th className="py-2.5 px-3 text-right">Dispensed On-Site</th>
                    <th className="py-2.5 px-3 text-right">Purchase Externally</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {request.data.items.map((it, i) => {
                    const dispensedOnSite = Number(it.dispensed_qty ?? 0);
                    const externalQty =
                      it.external_qty !== undefined && it.external_qty !== null
                        ? Number(it.external_qty)
                        : Math.max(0, Number(it.quantity) - Math.max(dispensedOnSite, Number(it.selected_qty ?? dispensedOnSite)));
                    return (
                      <tr key={i}>
                        <td className="py-3 px-3 font-semibold text-slate-900">
                          <div>{it.generic_name} {it.strength}</div>
                          <div className="text-[11px] font-normal text-slate-500 mt-0.5">
                            {externalQty > 0 && dispensedOnSite === 0
                              ? 'External Pharmacy Only'
                              : externalQty > 0
                                ? 'Partial On-Site + External'
                                : dispensedOnSite >= it.quantity
                                  ? 'Dispensed On-Site'
                                  : 'Pending Fulfilment'}
                          </div>
                        </td>
                        <td className="py-3 px-3 text-slate-700">
                          <div>
                            {it.dosage}, {it.frequency}
                            {it.duration_days ? ` × ${it.duration_days} days` : ''}
                          </div>
                          {it.instructions && (
                            <div className="text-[11px] text-slate-500 mt-0.5">{it.instructions}</div>
                          )}
                        </td>
                        <td className="py-3 px-3 text-right font-mono tabular-nums">{it.quantity}</td>
                        <td className="py-3 px-3 text-right font-mono tabular-nums font-semibold text-emerald-700">
                          {dispensedOnSite}
                        </td>
                        <td className={`py-3 px-3 text-right font-mono tabular-nums font-semibold ${externalQty > 0 ? 'text-amber-700' : 'text-slate-400'}`}>
                          {externalQty}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="p-3 bg-slate-50 border border-slate-200 rounded text-[11px] text-slate-600">
              Items marked under <strong>Purchase Externally</strong> were either out of stock at the clinic dispensary or deferred by patient choice and may be filled at any licensed retail pharmacy using this signed prescription.
            </div>

            <div className="pt-4 border-t border-slate-200 flex items-center justify-between text-slate-600">
              <div>
                <span className="text-slate-400">Prescriber: </span>
                <strong className="text-slate-900">{request.data.doctorName || 'Attending Clinician'}</strong>
              </div>
              <div className="font-mono capitalize">Status: {request.data.status.replace(/_/g, ' ')}</div>
            </div>
          </div>
        )}

        {/* IPD RUNNING STATEMENT & DISCHARGE SUMMARY */}
        {ipdStatement && (
          <div className="space-y-5 text-xs">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 bg-slate-50 border border-slate-200 rounded p-3.5">
              <div>
                <div className="text-slate-500">Inpatient</div>
                <div className="font-semibold text-slate-900 mt-0.5">
                  {ipdStatement.admission.first_name} {ipdStatement.admission.last_name}
                </div>
                <div className="font-mono text-slate-500">{ipdStatement.admission.mrn}</div>
              </div>
              <div>
                <div className="text-slate-500">Admission / Ward</div>
                <div className="font-mono font-semibold text-slate-900 mt-0.5">{ipdStatement.admission.admission_number}</div>
                <div className="text-slate-600">{ipdStatement.admission.ward_name} · {ipdStatement.admission.bed_number || 'Unassigned'}</div>
              </div>
              <div>
                <div className="text-slate-500">Attending &amp; Stay</div>
                <div className="font-medium text-slate-900 mt-0.5">{ipdStatement.admission.doctor_name}</div>
                <div className="font-mono text-slate-500">
                  Billed Days: {ipdStatement.admission.bed_days_billed ?? 0} · ${Number(ipdStatement.admission.daily_tariff || 0).toFixed(2)}/d
                </div>
              </div>
              <div>
                <div className="text-slate-500">Admission Status</div>
                <div className="font-semibold text-slate-900 capitalize mt-0.5">{ipdStatement.admission.status.replace('_', ' ')}</div>
                <div className="font-mono text-slate-500">{ipdStatement.admission.admitted_at}</div>
              </div>
            </div>

            <div className="p-3.5 border border-slate-200 rounded space-y-1.5">
              <div>
                <span className="font-semibold text-slate-700">Admission Diagnosis: </span>
                <span className="text-slate-900">{ipdStatement.admission.admission_diagnosis}</span>
              </div>
              {ipdStatement.admission.discharge_summary && (
                <div>
                  <span className="font-semibold text-slate-700">Clinical Discharge Summary: </span>
                  <span className="text-slate-900">{ipdStatement.admission.discharge_summary}</span>
                </div>
              )}
            </div>

            {/* Invoices Breakdown */}
            <div>
              <h4 className="font-semibold text-slate-900 mb-2">Billing Ledger &amp; Bed Charges</h4>
              <table className="w-full text-left border-collapse border border-slate-200">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-slate-600">
                    <th className="py-2 px-3">Invoice</th>
                    <th className="py-2 px-3">Line Items</th>
                    <th className="py-2 px-3 text-right">Total</th>
                    <th className="py-2 px-3 text-right">Paid</th>
                    <th className="py-2 px-3">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {ipdStatement.invoices.map((inv) => (
                    <tr key={inv.id}>
                      <td className="py-2 px-3 font-mono font-medium">{inv.invoice_number}</td>
                      <td className="py-2 px-3 text-slate-700">
                        {inv.items?.map((it) => `${it.description} × ${it.quantity}`).join(', ') || inv.notes || 'Clinical charge'}
                      </td>
                      <td className="py-2 px-3 text-right font-mono tabular-nums">${Number(inv.total_amount).toFixed(2)}</td>
                      <td className="py-2 px-3 text-right font-mono tabular-nums">${Number(inv.paid_amount).toFixed(2)}</td>
                      <td className="py-2 px-3 capitalize">{inv.status.replace('_', ' ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Advance Deposits */}
            {ipdStatement.deposits.length > 0 && (
              <div>
                <h4 className="font-semibold text-slate-900 mb-2">Advance Patient Deposits</h4>
                <table className="w-full text-left border-collapse border border-slate-200">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200 text-slate-600">
                      <th className="py-2 px-3">Deposit No</th>
                      <th className="py-2 px-3">Method</th>
                      <th className="py-2 px-3 text-right">Deposited</th>
                      <th className="py-2 px-3 text-right">Remaining Credit</th>
                      <th className="py-2 px-3">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {ipdStatement.deposits.map((d) => (
                      <tr key={d.id}>
                        <td className="py-2 px-3 font-mono font-medium">{d.deposit_number}</td>
                        <td className="py-2 px-3 uppercase">{d.payment_method.replace('_', ' ')}</td>
                        <td className="py-2 px-3 text-right font-mono tabular-nums">${Number(d.amount).toFixed(2)}</td>
                        <td className="py-2 px-3 text-right font-mono tabular-nums">${Number(d.remaining_amount).toFixed(2)}</td>
                        <td className="py-2 px-3 capitalize">{d.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Totals Strip */}
            {(() => {
              const nonVoid = ipdStatement.invoices.filter((i) => i.status !== 'voided');
              const totalBilled = nonVoid.reduce((s, i) => s + Number(i.total_amount), 0);
              const totalPaid = nonVoid.reduce((s, i) => s + Number(i.paid_amount), 0);
              const outstanding = Math.max(0, totalBilled - totalPaid);
              const depositAvail = ipdStatement.deposits
                .filter((d) => d.status === 'active')
                .reduce((s, d) => s + Number(d.remaining_amount), 0);
              return (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 p-3.5 bg-slate-50 border border-slate-200 rounded font-mono tabular-nums">
                  <div>
                    <div className="text-slate-500">Total Billed</div>
                    <div className="text-sm font-bold text-slate-900">${totalBilled.toFixed(2)}</div>
                  </div>
                  <div>
                    <div className="text-slate-500">Total Paid / Applied</div>
                    <div className="text-sm font-bold text-emerald-700">${totalPaid.toFixed(2)}</div>
                  </div>
                  <div>
                    <div className="text-slate-500">Deposit Credit Held</div>
                    <div className="text-sm font-bold text-teal-800">${depositAvail.toFixed(2)}</div>
                  </div>
                  <div>
                    <div className="text-slate-500">Unpaid Balance</div>
                    <div className={`text-sm font-bold ${outstanding > 0 ? 'text-red-700' : 'text-emerald-700'}`}>
                      ${outstanding.toFixed(2)}
                    </div>
                  </div>
                </div>
              );
            })()}
          </div>
        )}

        <div className="pt-3 border-t border-slate-200 text-[11px] text-slate-500 flex items-center justify-between">
          <span className="inline-flex items-center gap-1">
            <Lock className="w-3 h-3" />
            <span>Clinic360 Audited Electronic Medical &amp; Financial Record</span>
          </span>
          <span className="font-mono">Printed {new Date().toISOString().slice(0, 16).replace('T', ' ')}</span>
        </div>
      </div>
    </div>,
    document.body
  );
};
