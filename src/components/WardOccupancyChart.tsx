import React, { useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { Admission, Bed, Ward } from '../types';

interface WardOccupancyChartProps {
  wards: Ward[];
  beds: Bed[];
  admissions: Admission[];
  loading?: boolean;
}

interface WardChartRow {
  id: number;
  name: string;
  code: string;
  wardType: string;
  total: number;
  occupied: number;
  vacant: number;
  cleaning: number;
  outOfService: number;
  occupancyRate: number;
  awaitingBed: number;
  dischargePending: number;
}

interface TooltipPayloadItem {
  payload: WardChartRow;
}

const OccupancyTooltip: React.FC<{
  active?: boolean;
  payload?: TooltipPayloadItem[];
  mode: 'rate' | 'breakdown';
}> = ({ active, payload, mode }) => {
  if (!active || !payload || payload.length === 0) return null;
  const row = payload[0].payload;
  const capacityLabel =
    row.occupancyRate >= 85
      ? 'Near capacity'
      : row.occupancyRate >= 65
        ? 'Elevated load'
        : 'Normal flow';

  return (
    <div className="bg-white border border-slate-200 rounded-md shadow-sm px-3.5 py-2.5 text-xs space-y-1.5 min-w-[200px]">
      <div className="flex items-center justify-between gap-3 border-b border-slate-100 pb-1.5">
        <span className="font-semibold text-slate-900">
          {row.name} <span className="font-mono text-slate-500">({row.code})</span>
        </span>
        <span
          className={`font-mono font-semibold tabular-nums ${
            row.occupancyRate >= 85
              ? 'text-red-700'
              : row.occupancyRate >= 65
                ? 'text-amber-700'
                : 'text-teal-800'
          }`}
        >
          {row.occupancyRate}%
        </span>
      </div>

      <div className="font-mono tabular-nums text-slate-700">
        {mode === 'rate' ? (
          <span>
            {row.occupied} / {row.total} beds occupied · {capacityLabel}
          </span>
        ) : (
          <span>
            Total {row.total} beds · {capacityLabel}
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-slate-600 font-mono tabular-nums">
        <span>Occupied: {row.occupied}</span>
        <span>Vacant: {row.vacant}</span>
        <span>Cleaning: {row.cleaning}</span>
        <span>Maint: {row.outOfService}</span>
      </div>

      {(row.awaitingBed > 0 || row.dischargePending > 0) && (
        <div className="pt-1 border-t border-slate-100 text-slate-600 font-mono tabular-nums">
          {row.awaitingBed > 0 && <span>Awaiting bed: {row.awaitingBed}</span>}
          {row.awaitingBed > 0 && row.dischargePending > 0 && <span> · </span>}
          {row.dischargePending > 0 && <span>Discharge pending: {row.dischargePending}</span>}
        </div>
      )}
    </div>
  );
};

export const WardOccupancyChart: React.FC<WardOccupancyChartProps> = ({
  wards,
  beds,
  admissions,
  loading = false,
}) => {
  const [chartMode, setChartMode] = useState<'rate' | 'breakdown'>('rate');

  const { wardStats, summary } = useMemo(() => {
    const stats: WardChartRow[] = wards.map((ward) => {
      const wardBeds = beds.filter((b) => b.ward_id === ward.id);
      const occupied = wardBeds.filter((b) => b.status === 'occupied').length;
      const vacant = wardBeds.filter((b) => b.status === 'vacant' || b.status === 'reserved').length;
      const cleaning = wardBeds.filter((b) => b.status === 'cleaning').length;
      const outOfService = wardBeds.filter((b) => b.status === 'out_of_service').length;
      const total = wardBeds.length;
      const occupancyRate = total > 0 ? Math.round((occupied / total) * 100) : 0;

      const wardAdmissions = admissions.filter((a) => a.ward_id === ward.id);
      const awaitingBed = wardAdmissions.filter(
        (a) => a.status === 'ordered' || (!a.bed_id && a.status !== 'discharged')
      ).length;
      const dischargePending = wardAdmissions.filter((a) => a.status === 'discharge_ordered').length;

      return {
        id: ward.id,
        name: ward.name,
        code: ward.code,
        wardType: ward.ward_type,
        total,
        occupied,
        vacant,
        cleaning,
        outOfService,
        occupancyRate,
        awaitingBed,
        dischargePending,
      };
    });

    const totalBeds = beds.length;
    const occupiedBeds = beds.filter((b) => b.status === 'occupied').length;
    const vacantBeds = beds.filter((b) => b.status === 'vacant' || b.status === 'reserved').length;
    const cleaningBeds = beds.filter((b) => b.status === 'cleaning').length;
    const overallRate = totalBeds > 0 ? Math.round((occupiedBeds / totalBeds) * 100) : 0;
    const awaitingPlacement = admissions.filter(
      (a) => a.status === 'ordered' || (!a.bed_id && a.status !== 'discharged')
    ).length;
    const pendingDischarge = admissions.filter((a) => a.status === 'discharge_ordered').length;

    return {
      wardStats: stats,
      summary: {
        totalBeds,
        occupiedBeds,
        vacantBeds,
        cleaningBeds,
        overallRate,
        awaitingPlacement,
        pendingDischarge,
      },
    };
  }, [wards, beds, admissions]);

  return (
    <section
      aria-label="Ward bed occupancy summary"
      className="bg-white border border-slate-200 rounded-lg overflow-hidden"
    >
      <div className="px-5 py-3.5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3 bg-slate-50/70">
        <div>
          <h3 className="font-display text-sm font-semibold text-slate-900">
            Ward Bed Occupancy &amp; Patient Flow
          </h3>
          <div className="text-xs text-slate-500 font-mono tabular-nums mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span>
              Overall: <strong className="text-slate-900">{summary.overallRate}%</strong> (
              {summary.occupiedBeds}/{summary.totalBeds} occupied)
            </span>
            <span aria-hidden="true">·</span>
            <span className="text-emerald-700 font-medium">Vacant: {summary.vacantBeds}</span>
            <span aria-hidden="true">·</span>
            <span className={summary.cleaningBeds > 0 ? 'text-amber-700 font-medium' : 'text-slate-500'}>
              Cleaning: {summary.cleaningBeds}
            </span>
            {summary.awaitingPlacement > 0 && (
              <>
                <span aria-hidden="true">·</span>
                <span className="text-sky-700 font-medium">
                  Awaiting Bed: {summary.awaitingPlacement}
                </span>
              </>
            )}
            {summary.pendingDischarge > 0 && (
              <>
                <span aria-hidden="true">·</span>
                <span className="text-amber-700 font-medium">
                  Pending Discharge: {summary.pendingDischarge}
                </span>
              </>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1 p-1 bg-slate-200/70 rounded-lg">
          <button
            type="button"
            onClick={() => setChartMode('rate')}
            className={`px-3 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
              chartMode === 'rate'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Occupancy %
          </button>
          <button
            type="button"
            onClick={() => setChartMode('breakdown')}
            className={`px-3 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
              chartMode === 'breakdown'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Bed Breakdown
          </button>
        </div>
      </div>

      <div className="px-5 py-4">
        {loading && wards.length === 0 ? (
          <div className="h-[220px] w-full rounded bg-slate-100 animate-pulse" />
        ) : wards.length === 0 ? (
          <div className="h-[160px] flex items-center justify-center text-sm text-slate-500">
            No wards or beds configured yet.
          </div>
        ) : (
          <>
            <div className="h-[220px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                {chartMode === 'rate' ? (
                  <BarChart data={wardStats} margin={{ top: 14, right: 16, left: -12, bottom: 2 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E2E8F0" />
                    <XAxis
                      dataKey="name"
                      tick={{ fill: '#475569', fontSize: 12 }}
                      axisLine={{ stroke: '#CBD5E1' }}
                      tickLine={false}
                    />
                    <YAxis
                      domain={[0, 100]}
                      ticks={[0, 25, 50, 75, 100]}
                      tickFormatter={(v: number) => `${v}%`}
                      tick={{ fill: '#64748B', fontSize: 11 }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <Tooltip
                      content={<OccupancyTooltip mode="rate" />}
                      cursor={{ fill: 'rgba(15, 23, 42, 0.04)' }}
                    />
                    <ReferenceLine
                      y={85}
                      stroke="#D97706"
                      strokeDasharray="4 4"
                      label={{
                        value: '85% High Flow',
                        position: 'insideTopRight',
                        fill: '#B45309',
                        fontSize: 11,
                      }}
                    />
                    <Bar dataKey="occupancyRate" name="Occupancy Rate" radius={[4, 4, 0, 0]} maxBarSize={56}>
                      {wardStats.map((entry) => (
                        <Cell
                          key={entry.id}
                          fill={
                            entry.occupancyRate >= 85
                              ? '#DC2626'
                              : entry.occupancyRate >= 65
                                ? '#D97706'
                                : '#0F766E'
                          }
                        />
                      ))}
                    </Bar>
                  </BarChart>
                ) : (
                  <BarChart data={wardStats} margin={{ top: 14, right: 16, left: -12, bottom: 2 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E2E8F0" />
                    <XAxis
                      dataKey="name"
                      tick={{ fill: '#475569', fontSize: 12 }}
                      axisLine={{ stroke: '#CBD5E1' }}
                      tickLine={false}
                    />
                    <YAxis
                      allowDecimals={false}
                      tick={{ fill: '#64748B', fontSize: 11 }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <Tooltip
                      content={<OccupancyTooltip mode="breakdown" />}
                      cursor={{ fill: 'rgba(15, 23, 42, 0.04)' }}
                    />
                    <Bar dataKey="occupied" stackId="beds" name="Occupied" fill="#0F766E" maxBarSize={56} />
                    <Bar dataKey="vacant" stackId="beds" name="Vacant" fill="#10B981" maxBarSize={56} />
                    <Bar dataKey="cleaning" stackId="beds" name="Cleaning" fill="#F59E0B" maxBarSize={56} />
                    <Bar
                      dataKey="outOfService"
                      stackId="beds"
                      name="Maintenance"
                      fill="#94A3B8"
                      radius={[4, 4, 0, 0]}
                      maxBarSize={56}
                    />
                  </BarChart>
                )}
              </ResponsiveContainer>
            </div>

            <div className="mt-3 pt-3 border-t border-slate-100 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-600">
              {chartMode === 'rate' ? (
                <div className="flex flex-wrap items-center gap-4">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-[2px] bg-[#0F766E]" />
                    <span>&lt; 65% Normal capacity</span>
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-[2px] bg-[#D97706]" />
                    <span>65–84% Elevated load</span>
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-[2px] bg-[#DC2626]" />
                    <span>≥ 85% Near capacity</span>
                  </span>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-4">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-[2px] bg-[#0F766E]" />
                    <span>Occupied</span>
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-[2px] bg-[#10B981]" />
                    <span>Vacant / Ready</span>
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-[2px] bg-[#F59E0B]" />
                    <span>Cleaning Turnover</span>
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-[2px] bg-[#94A3B8]" />
                    <span>Maintenance Hold</span>
                  </span>
                </div>
              )}

              <div className="font-mono tabular-nums text-slate-500 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                {wardStats.map((w, idx) => (
                  <React.Fragment key={w.id}>
                    {idx > 0 && <span aria-hidden="true">·</span>}
                    <span>
                      {w.code} {w.occupied}/{w.total} ({w.occupancyRate}%)
                    </span>
                  </React.Fragment>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  );
};
