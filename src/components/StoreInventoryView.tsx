import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ArrowRightLeft, Boxes, ClipboardList, PackagePlus, ShieldAlert, X } from 'lucide-react';
import { apiFetch } from '../lib/api';
import type {
  ExpiryAlert,
  GoodsReceipt,
  StockBatch,
  StockRequisition,
  StoreItem,
  UserContext,
} from '../types';

interface StoreInventoryViewProps {
  user: UserContext;
  onNotify: (msg: string, type?: 'success' | 'error') => void;
}

export const StoreInventoryView: React.FC<StoreInventoryViewProps> = ({ user, onNotify }) => {
  const [subTab, setSubTab] = useState<'stock' | 'grn' | 'requisitions' | 'expiry'>('stock');
  const [items, setItems] = useState<StoreItem[]>([]);
  const [batches, setBatches] = useState<StockBatch[]>([]);
  const [grns, setGrns] = useState<GoodsReceipt[]>([]);
  const [requisitions, setRequisitions] = useState<StockRequisition[]>([]);
  const [expiryAlerts, setExpiryAlerts] = useState<ExpiryAlert[]>([]);

  const [grnForm, setGrnForm] = useState({
    supplier_name: '',
    invoice_ref: '',
    item_id: '',
    batch_number: '',
    expiry_date: '2027-06-30',
    quantity: '100',
    unit_cost: '0.50',
    notes: '',
  });

  const [reqForm, setReqForm] = useState({
    to_location: 'dispensary' as 'dispensary' | 'lab' | 'ward',
    item_id: '',
    requested_qty: '50',
    notes: '',
  });

  const [blockTarget, setBlockTarget] = useState<StockBatch | null>(null);
  const [blockReason, setBlockReason] = useState('');

  const canReceiveGrn = user.permissions.includes('store.grn.create');
  const canCreateReq = user.permissions.includes('store.requisition.create');
  const canIssueReq = user.permissions.includes('store.requisition.issue');
  const canManageExpiry = user.permissions.includes('store.expiry.manage');

  const loadStore = useCallback(async () => {
    try {
      const res = await apiFetch<{
        items: StoreItem[];
        batches: StockBatch[];
        grns: GoodsReceipt[];
        requisitions: StockRequisition[];
        expiryAlerts: ExpiryAlert[];
      }>('/api/store/overview');
      setItems(res.items || []);
      setBatches(res.batches || []);
      setGrns(res.grns || []);
      setRequisitions(res.requisitions || []);
      setExpiryAlerts(res.expiryAlerts || []);
      if (res.items?.[0]) {
        setGrnForm((p) => (p.item_id ? p : { ...p, item_id: String(res.items[0].id) }));
        setReqForm((p) => (p.item_id ? p : { ...p, item_id: String(res.items[0].id) }));
      }
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }, [onNotify]);

  useEffect(() => {
    loadStore();
  }, [loadStore]);

  async function handleReceiveGrn(e: React.FormEvent) {
    e.preventDefault();
    try {
      const res = await apiFetch<{ grnNumber: string }>('/api/store/grn', {
        method: 'POST',
        body: JSON.stringify({
          ...grnForm,
          item_id: Number(grnForm.item_id),
          quantity: Number(grnForm.quantity),
          unit_cost: Number(grnForm.unit_cost),
        }),
      });
      onNotify(`Received Goods ${res.grnNumber} into Main Store`, 'success');
      setGrnForm((p) => ({
        ...p,
        supplier_name: '',
        invoice_ref: '',
        batch_number: '',
        notes: '',
      }));
      loadStore();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleCreateRequisition(e: React.FormEvent) {
    e.preventDefault();
    try {
      const res = await apiFetch<{ reqNumber: string }>('/api/store/requisitions', {
        method: 'POST',
        body: JSON.stringify({
          ...reqForm,
          item_id: Number(reqForm.item_id),
          requested_qty: Number(reqForm.requested_qty),
        }),
      });
      onNotify(`Requisition ${res.reqNumber} submitted to Main Store`, 'success');
      setReqForm((p) => ({ ...p, notes: '' }));
      loadStore();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleIssueRequisition(reqId: number) {
    try {
      const res = await apiFetch<{ fefoTransfers: Array<{ item: string; issued: number; batches: string[] }> }>(
        `/api/store/requisitions/${reqId}/issue`,
        { method: 'POST' }
      );
      const summary = res.fefoTransfers.map((t) => `${t.item}: ${t.batches.join(', ')}`).join(' · ');
      onNotify(`Issued via FEFO (${summary})`, 'success');
      loadStore();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  async function handleBlockBatch(e: React.FormEvent) {
    e.preventDefault();
    if (!blockTarget) return;
    try {
      await apiFetch(`/api/store/batches/${blockTarget.id}/block`, {
        method: 'POST',
        body: JSON.stringify({ reason: blockReason }),
      });
      onNotify(`Batch ${blockTarget.batch_number} quarantined & blocked from FEFO dispensing`, 'success');
      setBlockTarget(null);
      setBlockReason('');
      loadStore();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  }

  const pendingReqCount = requisitions.filter((r) => r.status === 'pending').length;
  const expiredCount = expiryAlerts.filter((a) => a.alert_band === 'expired').length;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-200/70 rounded-lg">
          <button
            onClick={() => setSubTab('stock')}
            className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              subTab === 'stock' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Boxes className="w-3.5 h-3.5" />
            <span>Stock Levels ({items.length})</span>
          </button>
          <button
            onClick={() => setSubTab('grn')}
            className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              subTab === 'grn' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <PackagePlus className="w-3.5 h-3.5" />
            <span>Receive Goods / GRN ({grns.length})</span>
          </button>
          <button
            onClick={() => setSubTab('requisitions')}
            className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              subTab === 'requisitions' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <ArrowRightLeft className="w-3.5 h-3.5" />
            <span>Requisitions &amp; FEFO Issue ({pendingReqCount} pending)</span>
          </button>
          <button
            onClick={() => setSubTab('expiry')}
            className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              subTab === 'expiry' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <ShieldAlert className={`w-3.5 h-3.5 ${expiredCount > 0 ? 'text-red-700' : ''}`} />
            <span>Expiry Alerts ({expiryAlerts.length})</span>
          </button>
        </div>
      </div>

      {/* 1. STOCK LEVELS & MULTI-LOCATION BATCHES */}
      {subTab === 'stock' && (
        <div className="space-y-5">
          <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between bg-slate-50/70">
              <h3 className="font-display text-sm font-semibold text-slate-900">
                Multi-Location Inventory Matrix (Main Store · Dispensary · Lab)
              </h3>
              <span className="text-xs text-slate-500">FEFO deducts earliest valid expiry batch automatically</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium text-slate-500">
                    <th className="py-2.5 px-4">Code &amp; Item</th>
                    <th className="py-2.5 px-4">Category</th>
                    <th className="py-2.5 px-4 text-right">Main Store</th>
                    <th className="py-2.5 px-4 text-right">Dispensary</th>
                    <th className="py-2.5 px-4 text-right">Lab</th>
                    <th className="py-2.5 px-4 text-right">Reorder At</th>
                    <th className="py-2.5 px-4">Earliest Expiry</th>
                    {canCreateReq && <th className="py-2.5 px-4 text-right">Restock</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-xs">
                  {items.map((it) => {
                    const lowTotal = it.total_qty <= it.reorder_level;
                    return (
                      <tr key={it.id} className="hover:bg-slate-50/70">
                        <td className="py-3 px-4">
                          <div className="font-medium text-slate-900">{it.name}</div>
                          <div className="font-mono text-slate-500">{it.code} · {it.unit}</div>
                        </td>
                        <td className="py-3 px-4 capitalize text-slate-600">{it.category}</td>
                        <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-900 font-semibold">
                          {it.main_store_qty}
                        </td>
                        <td className="py-3 px-4 text-right font-mono tabular-nums text-teal-800 font-semibold">
                          {it.dispensary_qty}
                        </td>
                        <td className="py-3 px-4 text-right font-mono tabular-nums text-sky-800 font-semibold">
                          {it.lab_qty}
                        </td>
                        <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-500">
                          {it.reorder_level}
                          {lowTotal && <span className="ml-1.5 text-red-700 font-semibold">LOW</span>}
                        </td>
                        <td className="py-3 px-4 font-mono text-slate-700 tabular-nums">
                          {it.earliest_expiry || '—'}
                        </td>
                        {canCreateReq && (
                          <td className="py-3 px-4 text-right whitespace-nowrap">
                            <button
                              onClick={() => {
                                setReqForm({
                                  to_location: it.category === 'reagent' ? 'lab' : 'dispensary',
                                  item_id: String(it.id),
                                  requested_qty: '50',
                                  notes: `Restock ${it.code}`,
                                });
                                setSubTab('requisitions');
                              }}
                              className="px-2.5 py-1 text-xs font-medium text-teal-800 border border-teal-200 hover:bg-teal-50 rounded"
                            >
                              Request Restock
                            </button>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <div className="px-5 py-3 border-b border-slate-200 bg-slate-50/70">
              <h3 className="font-display text-sm font-semibold text-slate-900">Active &amp; Quarantined Stock Batches (FEFO Order)</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium text-slate-500">
                    <th className="py-2.5 px-4">Batch No</th>
                    <th className="py-2.5 px-4">Item</th>
                    <th className="py-2.5 px-4">Location</th>
                    <th className="py-2.5 px-4">Expiry</th>
                    <th className="py-2.5 px-4 text-right">Qty On Hand</th>
                    <th className="py-2.5 px-4">Status</th>
                    {canManageExpiry && <th className="py-2.5 px-4 text-right">Control</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-xs">
                  {batches.map((b) => (
                    <tr key={b.id} className="hover:bg-slate-50/70">
                      <td className="py-2.5 px-4 font-mono font-semibold text-slate-900">{b.batch_number}</td>
                      <td className="py-2.5 px-4">{b.item_name}</td>
                      <td className="py-2.5 px-4 font-mono capitalize text-slate-600">{b.location.replace('_', ' ')}</td>
                      <td className="py-2.5 px-4 font-mono tabular-nums">{b.expiry_date}</td>
                      <td className="py-2.5 px-4 text-right font-mono tabular-nums font-semibold">{b.qty_on_hand}</td>
                      <td className="py-2.5 px-4">
                        <span className={b.status === 'blocked_expired' ? 'text-red-700 font-semibold' : 'text-emerald-700 font-medium'}>
                          {b.status === 'blocked_expired' ? `Quarantined (${b.block_reason || 'Expired'})` : 'Active'}
                        </span>
                      </td>
                      {canManageExpiry && (
                        <td className="py-2.5 px-4 text-right">
                          {b.status === 'active' && (
                            <button
                              onClick={() => setBlockTarget(b)}
                              className="px-2.5 py-1 text-xs font-medium text-red-700 border border-red-200 hover:bg-red-50 rounded"
                            >
                              Block Batch
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* 2. RECEIVE GOODS (GRN) */}
      {subTab === 'grn' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
          {canReceiveGrn && (
            <div className="lg:col-span-5 bg-white border border-slate-200 rounded-lg p-5 self-start">
              <h3 className="font-display text-sm font-semibold text-slate-900 mb-4">Record Goods Receipt Note (Main Store)</h3>
              <form onSubmit={handleReceiveGrn} className="space-y-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Supplier / Distributor *</label>
                  <input
                    required
                    value={grnForm.supplier_name}
                    onChange={(e) => setGrnForm({ ...grnForm, supplier_name: e.target.value })}
                    placeholder="e.g. MedCore Wholesale Ltd"
                    className="w-full px-3 py-2 text-xs border border-slate-300 rounded-md"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Supplier Invoice Ref</label>
                    <input
                      value={grnForm.invoice_ref}
                      onChange={(e) => setGrnForm({ ...grnForm, invoice_ref: e.target.value })}
                      placeholder="SUP-2026-881"
                      className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-md"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Store Item *</label>
                    <select
                      required
                      value={grnForm.item_id}
                      onChange={(e) => setGrnForm({ ...grnForm, item_id: e.target.value })}
                      className="w-full px-3 py-2 text-xs border border-slate-300 rounded-md bg-white"
                    >
                      {items.map((it) => (
                        <option key={it.id} value={it.id}>
                          {it.code} — {it.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Batch Number *</label>
                    <input
                      required
                      value={grnForm.batch_number}
                      onChange={(e) => setGrnForm({ ...grnForm, batch_number: e.target.value })}
                      placeholder="BCH-2026-901"
                      className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-md"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Expiry Date *</label>
                    <input
                      type="date"
                      required
                      value={grnForm.expiry_date}
                      onChange={(e) => setGrnForm({ ...grnForm, expiry_date: e.target.value })}
                      className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-md"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Quantity Received *</label>
                    <input
                      type="number"
                      min={1}
                      required
                      value={grnForm.quantity}
                      onChange={(e) => setGrnForm({ ...grnForm, quantity: e.target.value })}
                      className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-md"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Unit Cost ($)</label>
                    <input
                      type="number"
                      step="0.01"
                      min={0}
                      value={grnForm.unit_cost}
                      onChange={(e) => setGrnForm({ ...grnForm, unit_cost: e.target.value })}
                      className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-md"
                    />
                  </div>
                </div>
                <button
                  type="submit"
                  className="w-full px-4 py-2 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md"
                >
                  Post GRN &amp; Add Main Store Batch
                </button>
              </form>
            </div>
          )}

          <div className={`${canReceiveGrn ? 'lg:col-span-7' : 'lg:col-span-12'} bg-white border border-slate-200 rounded-lg overflow-hidden`}>
            <div className="px-5 py-3.5 border-b border-slate-200 bg-slate-50/70">
              <h3 className="font-display text-sm font-semibold text-slate-900">Goods Receipt Notes (GRN Ledger)</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium text-slate-500">
                    <th className="py-2.5 px-4">GRN No</th>
                    <th className="py-2.5 px-4">Supplier &amp; Invoice Ref</th>
                    <th className="py-2.5 px-4 text-right">Total Cost</th>
                    <th className="py-2.5 px-4">Received By</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-xs">
                  {grns.map((g) => (
                    <tr key={g.id} className="hover:bg-slate-50/70">
                      <td className="py-3 px-4 font-mono font-semibold text-slate-900">{g.grn_number}</td>
                      <td className="py-3 px-4">
                        <div className="font-medium text-slate-900">{g.supplier_name}</div>
                        <div className="font-mono text-slate-500">{g.invoice_ref || g.notes || 'Direct delivery'}</div>
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums font-semibold">
                        ${Number(g.total_cost).toFixed(2)}
                      </td>
                      <td className="py-3 px-4 text-slate-600">
                        <div>{g.received_by_name || 'Storekeeper'}</div>
                        <div className="font-mono text-[11px] text-slate-400">{g.received_at}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* 3. INTERNAL REQUISITIONS & FEFO ISSUE */}
      {subTab === 'requisitions' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
          {canCreateReq && (
            <div className="lg:col-span-4 bg-white border border-slate-200 rounded-lg p-5 self-start">
              <h3 className="font-display text-sm font-semibold text-slate-900 mb-4 flex items-center gap-2">
                <ClipboardList className="w-4 h-4 text-teal-700" />
                <span>Request Stock from Main Store</span>
              </h3>
              <form onSubmit={handleCreateRequisition} className="space-y-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Destination Department *</label>
                  <select
                    value={reqForm.to_location}
                    onChange={(e) => setReqForm({ ...reqForm, to_location: e.target.value as 'dispensary' | 'lab' | 'ward' })}
                    className="w-full px-3 py-2 text-xs border border-slate-300 rounded-md bg-white"
                  >
                    <option value="dispensary">Pharmacy Dispensary</option>
                    <option value="lab">Clinical Laboratory</option>
                    <option value="ward">Inpatient Ward</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Item *</label>
                  <select
                    required
                    value={reqForm.item_id}
                    onChange={(e) => setReqForm({ ...reqForm, item_id: e.target.value })}
                    className="w-full px-3 py-2 text-xs border border-slate-300 rounded-md bg-white"
                  >
                    {items.map((it) => (
                      <option key={it.id} value={it.id}>
                        {it.name} (Main Store: {it.main_store_qty})
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Requested Quantity *</label>
                  <input
                    type="number"
                    min={1}
                    required
                    value={reqForm.requested_qty}
                    onChange={(e) => setReqForm({ ...reqForm, requested_qty: e.target.value })}
                    className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-md"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Notes</label>
                  <input
                    value={reqForm.notes}
                    onChange={(e) => setReqForm({ ...reqForm, notes: e.target.value })}
                    placeholder="Urgency or replenishment reason"
                    className="w-full px-3 py-2 text-xs border border-slate-300 rounded-md"
                  />
                </div>
                <button
                  type="submit"
                  className="w-full px-4 py-2 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md"
                >
                  Submit Requisition
                </button>
              </form>
            </div>
          )}

          <div className={`${canCreateReq ? 'lg:col-span-8' : 'lg:col-span-12'} bg-white border border-slate-200 rounded-lg overflow-hidden`}>
            <div className="px-5 py-3.5 border-b border-slate-200 bg-slate-50/70">
              <h3 className="font-display text-sm font-semibold text-slate-900">Department Requisitions &amp; FEFO Fulfilment</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium text-slate-500">
                    <th className="py-2.5 px-4">Req No</th>
                    <th className="py-2.5 px-4">Destination</th>
                    <th className="py-2.5 px-4">Items Requested</th>
                    <th className="py-2.5 px-4">Status</th>
                    {canIssueReq && <th className="py-2.5 px-4 text-right">FEFO Issue</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-xs">
                  {requisitions.map((r) => (
                    <tr key={r.id} className="hover:bg-slate-50/70">
                      <td className="py-3 px-4 font-mono font-semibold text-slate-900">
                        <div>{r.req_number}</div>
                        <div className="text-[11px] font-normal text-slate-500">{r.requested_by_name}</div>
                      </td>
                      <td className="py-3 px-4 font-mono capitalize text-slate-700">{r.to_location}</td>
                      <td className="py-3 px-4">
                        {r.items?.map((ri) => (
                          <div key={ri.id} className="font-medium text-slate-900">
                            {ri.item_name} — Req {ri.requested_qty} {ri.unit}
                            {r.status === 'issued' && <span className="text-emerald-700 font-mono"> (Issued {ri.issued_qty})</span>}
                          </div>
                        ))}
                        {r.notes && <div className="text-slate-500 mt-0.5">{r.notes}</div>}
                      </td>
                      <td className="py-3 px-4 capitalize">
                        <span className={r.status === 'issued' ? 'text-emerald-700 font-semibold' : 'text-amber-700 font-semibold'}>
                          {r.status}
                        </span>
                        {r.issued_by_name && <div className="text-[11px] text-slate-400">by {r.issued_by_name}</div>}
                      </td>
                      {canIssueReq && (
                        <td className="py-3 px-4 text-right whitespace-nowrap">
                          {r.status === 'pending' && (
                            <button
                              onClick={() => handleIssueRequisition(r.id)}
                              className="px-3 py-1.5 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded"
                            >
                              Issue (FEFO)
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* 4. EXPIRY ALERTS (30 / 60 / 90d & EXPIRED) */}
      {subTab === 'expiry' && (
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-200 bg-slate-50/70 flex items-center justify-between">
            <h3 className="font-display text-sm font-semibold text-slate-900 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-700" />
              <span>Expiry Horizon Monitor (Expired · ≤30 Days · ≤90 Days)</span>
            </h3>
            <span className="text-xs text-slate-500">Expired batches are automatically excluded from FEFO picking</span>
          </div>
          {expiryAlerts.length === 0 ? (
            <div className="p-10 text-center text-sm text-slate-500">No batches expiring within the next 90 days.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium text-slate-500">
                    <th className="py-2.5 px-4">Risk Band</th>
                    <th className="py-2.5 px-4">Batch &amp; Item</th>
                    <th className="py-2.5 px-4">Location</th>
                    <th className="py-2.5 px-4">Expiry Date</th>
                    <th className="py-2.5 px-4 text-right">Qty at Risk</th>
                    {canManageExpiry && <th className="py-2.5 px-4 text-right">Quarantine Action</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-xs">
                  {expiryAlerts.map((a) => (
                    <tr key={a.id} className="hover:bg-slate-50/70">
                      <td className="py-3 px-4 font-semibold">
                        <span
                          className={
                            a.alert_band === 'expired'
                              ? 'text-red-700'
                              : a.alert_band === 'critical_30d'
                                ? 'text-amber-700'
                                : 'text-sky-700'
                          }
                        >
                          {a.alert_band === 'expired'
                            ? 'EXPIRED'
                            : a.alert_band === 'critical_30d'
                              ? 'Critical ≤ 30d'
                              : 'Warning ≤ 90d'}
                        </span>
                      </td>
                      <td className="py-3 px-4">
                        <div className="font-medium text-slate-900">{a.item_name}</div>
                        <div className="font-mono text-slate-500">{a.batch_number}</div>
                      </td>
                      <td className="py-3 px-4 font-mono capitalize text-slate-600">{a.location.replace('_', ' ')}</td>
                      <td className="py-3 px-4 font-mono font-semibold tabular-nums">{a.expiry_date}</td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums font-semibold">
                        {a.qty_on_hand} {a.unit}
                      </td>
                      {canManageExpiry && (
                        <td className="py-3 px-4 text-right">
                          <button
                            onClick={() => {
                              setBlockTarget(a);
                              setBlockReason(a.alert_band === 'expired' ? 'Expired stock quarantined from floor' : '');
                            }}
                            className="px-3 py-1 text-xs font-medium text-red-700 border border-red-200 hover:bg-red-50 rounded"
                          >
                            Quarantine / Block
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Quarantine / Block Batch Modal */}
      {blockTarget && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-lg max-w-md w-full">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3 className="font-display text-base font-semibold text-slate-900">
                Quarantine Batch · {blockTarget.batch_number}
              </h3>
              <button onClick={() => setBlockTarget(null)} className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleBlockBatch} className="p-6 space-y-4">
              <div className="text-xs text-slate-600">
                Item: <strong className="text-slate-900">{blockTarget.item_name}</strong> ({blockTarget.qty_on_hand} units, Exp {blockTarget.expiry_date})
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Mandatory Quarantine Reason *</label>
                <textarea
                  required
                  rows={2}
                  value={blockReason}
                  onChange={(e) => setBlockReason(e.target.value)}
                  placeholder="e.g. Expired stock removed, damaged packaging, or supplier recall"
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-md"
                />
              </div>
              <div className="pt-3 border-t border-slate-200 flex justify-end gap-2">
                <button type="button" onClick={() => setBlockTarget(null)} className="px-4 py-2 text-xs border border-slate-300 rounded-md">
                  Cancel
                </button>
                <button type="submit" className="px-4 py-2 text-xs font-medium text-white bg-red-700 hover:bg-red-800 rounded-md">
                  Confirm Quarantine
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
