/**
 * TradingUSA UI primitives — one restrained institutional-research visual
 * language: ink/navy surfaces, mint for positive, danger for negative,
 * amber for warnings, violet for info, mono figures, no motion.
 *
 * Charts are hand-rolled SVG (sparkline, multi-series line/equity chart with
 * axis labels + legend, signed bar chart) — no chart library, no canvas.
 *
 * Formatters accept null/undefined and render '—' instead of crashing:
 * every nullable contract field goes through them.
 */

import React, { useMemo, useState } from 'react';
import type { ReactNode } from 'react';

export type Tone = 'pos' | 'neg' | 'warn' | 'info' | 'neutral';

const TONE_TEXT: Record<Tone, string> = {
  pos: 'text-mint',
  neg: 'text-danger',
  warn: 'text-amber-soft',
  info: 'text-violet-soft',
  neutral: 'text-mist',
};

const TONE_BORDER_BG: Record<Tone, string> = {
  pos: 'border-mint/30 bg-mint/10',
  neg: 'border-danger/30 bg-danger/10',
  warn: 'border-amber-soft/30 bg-amber-soft/10',
  info: 'border-violet-soft/30 bg-violet-soft/10',
  neutral: 'border-line bg-ink-700/70',
};

const TONE_FILL: Record<Tone, string> = {
  pos: 'bg-mint-dim',
  neg: 'bg-danger',
  warn: 'bg-amber-soft',
  info: 'bg-violet-soft',
  neutral: 'bg-ink-600',
};

const SVG_TONE: Record<Tone, string> = {
  pos: '#34f5c5',
  neg: '#f87171',
  warn: '#fbbf24',
  info: '#8b7cf6',
  neutral: '#93a4bd',
};

export const DASH = '—';

/* ------------------------------------------------------------------ */
/* formatters                                                          */
/* ------------------------------------------------------------------ */

export function money(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Signed percentage, 2 decimals: +3.25% / -1.10% */
export function pct(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(2)}%`;
}

export function number(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

const PAD = (n: number): string => String(n).padStart(2, '0');

function toDate(v: number | string | null | undefined): Date | null {
  if (v === null || v === undefined || v === '') return null;
  const d =
    typeof v === 'number'
      ? new Date(v)
      : /^\d+$/.test(v)
        ? new Date(Number(v))
        : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** UTC ISO / epoch-ms → local `YYYY-MM-DD HH:MM`. */
export function time(v: number | string | null | undefined): string {
  const d = toDate(v);
  if (!d) return DASH;
  return `${d.getFullYear()}-${PAD(d.getMonth() + 1)}-${PAD(d.getDate())} ${PAD(d.getHours())}:${PAD(d.getMinutes())}`;
}

/** `YYYY-MM-DD` values render verbatim (no timezone drift). */
export function dateText(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === '') return DASH;
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return time(v);
}

/** Short axis label: `HH:MM` inside a day, `MM-DD` otherwise. */
export function axisTime(x: number, spanMs: number): string {
  const d = new Date(x);
  if (Number.isNaN(d.getTime())) return DASH;
  if (spanMs > 0 && spanMs < 2 * 86_400_000) return `${PAD(d.getHours())}:${PAD(d.getMinutes())}`;
  return `${PAD(d.getMonth() + 1)}-${PAD(d.getDate())}`;
}

/** Unsigned percentage, 2 decimals — for RATES (win rate, accuracy, cache hit). */
export function pctPlain(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  return `${v.toFixed(2)}%`;
}

/** Unsigned fraction/percent normalizer: 0.4667 → 46.67% */
export function pctPlainAuto(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  return pctPlain(Math.abs(v) <= 1 ? v * 100 : v);
}

/** Metrics arrive as FRACTIONS (tucore) — 0.1234 → +12.34% */
export function frac(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  return pct(v * 100);
}

/** Ratios may arrive as fraction or already-percent — normalize by magnitude. */
export function pctAuto(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  return Math.abs(v) <= 1 ? pct(v * 100) : pct(v);
}

/** Materiality/score bars: fraction (0..1) or percent (0..100) → 0..100 width. */
export function barPct(v: number | null | undefined): number {
  if (v === null || v === undefined || !Number.isFinite(v)) return 0;
  const scaled = Math.abs(v) <= 1.5 ? v * 100 : v;
  return Math.max(0, Math.min(100, scaled));
}

/** 0..1 (or 0..100) score → 0..1 for normalized bars. */
export function norm01(v: number | null | undefined): number {
  if (v === null || v === undefined || !Number.isFinite(v)) return 0;
  const n = Math.abs(v) <= 1 ? v : v / 100;
  return Math.max(0, Math.min(1, n));
}

/** Anything renderable → string without crashing (objects become k=v pairs). */
export function flex(v: unknown): string {
  if (v === null || v === undefined || v === '') return DASH;
  if (typeof v === 'number') return number(v);
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((x) => flex(x)).join(', ');
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>);
    if (entries.length === 0) return DASH;
    return entries.map(([k, x]) => `${k}: ${flex(x)}`).join(' · ');
  }
  return String(v);
}

export function toneFor(v: number | null | undefined): Tone {
  if (v === null || v === undefined || !Number.isFinite(v) || v === 0) return 'neutral';
  return v > 0 ? 'pos' : 'neg';
}

export function toneClass(v: number | null | undefined): string {
  return TONE_TEXT[toneFor(v)];
}

/* ------------------------------------------------------------------ */
/* primitives                                                          */
/* ------------------------------------------------------------------ */

export function Badge({
  children,
  tone = 'neutral',
  className = '',
}: {
  children: ReactNode;
  tone?: Tone;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[11px] leading-4 ${TONE_BORDER_BG[tone]} ${TONE_TEXT[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export function Card({
  title,
  subtitle,
  actions,
  children,
  className = '',
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card p-4 ${className}`}>
      {(title !== undefined || actions !== undefined) && (
        <div className="mb-3 flex items-start justify-between gap-4">
          <div className="min-w-0">
            {title !== undefined && (
              <h2 className="text-xs font-semibold uppercase tracking-wider text-mist">{title}</h2>
            )}
            {subtitle !== undefined && <p className="mt-1 text-xs text-mist/80">{subtitle}</p>}
          </div>
          {actions !== undefined && <div className="shrink-0">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function StatTile({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  tone?: Tone;
}) {
  return (
    <div className="card p-3">
      <div className="text-[10px] uppercase tracking-wider text-mist">{label}</div>
      <div className={`mt-1 font-mono text-xl ${TONE_TEXT[tone]}`}>{value}</div>
      {hint !== undefined && <div className="mt-0.5 text-[11px] text-mist">{hint}</div>}
    </div>
  );
}

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  className?: string;
  align?: 'left' | 'right' | 'center';
  /** when present the column header becomes a sort control */
  sortValue?: (row: T) => number | string | null;
}

type SortDir = 'asc' | 'desc';

export function DataTable<T>({
  rows,
  columns,
  rowKey,
  label,
  empty,
  defaultSort,
  onRowClick,
}: {
  rows: T[];
  columns: Array<Column<T>>;
  rowKey: (row: T) => string;
  label?: string;
  empty?: ReactNode;
  defaultSort?: { key: string; dir: SortDir };
  onRowClick?: (row: T) => void;
}) {
  const [sort, setSort] = useState<{ key: string; dir: SortDir } | null>(defaultSort ?? null);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sortValue) return rows;
    const get = col.sortValue;
    const factor = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = get(a);
      const bv = get(b);
      if (av === bv) return 0;
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * factor;
      return String(av).localeCompare(String(bv)) * factor;
    });
  }, [rows, sort, columns]);

  if (rows.length === 0) return <>{empty ?? <EmptyState title="No records" />}</>;

  const alignClass = (a?: Column<T>['align']): string =>
    a === 'right' ? 'text-right' : a === 'center' ? 'text-center' : 'text-left';

  return (
    <div className="thin-scroll -mx-1 overflow-x-auto px-1">
      <table className="w-full text-sm" aria-label={label}>
        <thead>
          <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-mist">
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                className={`px-2 py-2 font-medium ${alignClass(c.align)} ${c.className ?? ''}`}
              >
                {c.sortValue ? (
                  <button
                    type="button"
                    onClick={() =>
                      setSort((prev) =>
                        prev && prev.key === c.key
                          ? { key: c.key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
                          : { key: c.key, dir: 'asc' },
                      )
                    }
                    className="uppercase tracking-wider hover:text-mint"
                  >
                    {c.header}
                    <span aria-hidden className="ml-1 text-[9px]">
                      {sort?.key === c.key ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'}
                    </span>
                  </button>
                ) : (
                  c.header
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr
              key={rowKey(row)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={`border-b border-line/60 last:border-b-0 ${onRowClick ? 'cursor-pointer hover:bg-ink-700/40' : ''}`}
            >
              {columns.map((c) => (
                <td key={c.key} className={`px-2 py-1.5 align-top ${alignClass(c.align)} ${c.className ?? ''}`}>
                  {c.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div role="status" className="card px-6 py-10 text-center font-mono text-sm text-mist">
      {label}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="card border-danger/40 px-6 py-8 text-center">
      <h3 className="text-sm font-semibold uppercase tracking-wider text-danger">Request failed</h3>
      <p className="mt-2 font-mono text-sm text-slate-soft">{message}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-4 rounded-md border border-line bg-ink-700 px-4 py-1.5 text-sm text-slate-soft hover:border-mint/40"
        >
          Retry
        </button>
      )}
    </div>
  );
}

export function EmptyState({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="card flex flex-col items-center justify-center px-6 py-10 text-center">
      <h3 className="text-sm font-semibold uppercase tracking-wider text-mist">{title}</h3>
      <div className="mt-2 max-w-xl text-sm text-mist/90">{children}</div>
    </div>
  );
}

/** Page-level error boundary: a broken payload degrades to a readable card. */
export class ErrorBoundary extends React.Component<
  { children: ReactNode; label?: string },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  render(): ReactNode {
    if (this.state.error) {
      return <ErrorState message={`${this.props.label ?? 'This view'} failed to render: ${this.state.error.message}`} />;
    }
    return this.props.children;
  }
}

/** 0..1 confidence → proportional bar + percentage. */
export function ConfidenceBar({ value, showLabel = true }: { value: number | null | undefined; showLabel?: boolean }) {
  const n = norm01(value);
  const tone: Tone = n >= 0.7 ? 'pos' : n >= 0.45 ? 'warn' : 'neg';
  return (
    <div className="flex items-center gap-2" title={value === null || value === undefined ? DASH : String(value)}>
      <div className="h-1.5 w-20 overflow-hidden rounded-full bg-ink-700">
        <div className={`h-full rounded-full ${TONE_FILL[tone]}`} style={{ width: `${n * 100}%` }} />
      </div>
      {showLabel && <span className="font-mono text-[11px] text-mist">{Math.round(n * 100)}%</span>}
    </div>
  );
}

/** Provider status enum → tone pill. */
export function StatusPill({ status, label }: { status: string | null | undefined; label?: string }) {
  const s = (status ?? 'UNAVAILABLE').toUpperCase();
  let tone: Tone = 'neutral';
  if (s === 'CONNECTED') tone = 'pos';
  else if (s === 'RATE_LIMITED' || s === 'QUOTA_EXHAUSTED' || s === 'DEGRADED') tone = 'warn';
  else if (s === 'CIRCUIT_OPEN' || s === 'UNAVAILABLE' || s === 'ERROR') tone = 'neg';
  else if (s === 'LOCAL_ONLY') tone = 'info';
  return (
    <Badge tone={tone} className="whitespace-nowrap">
      {label ? `${label} ${status ?? ''}`.trim() : status ?? 'UNKNOWN'}
    </Badge>
  );
}

/** Market session kind → tone pill. */
export function SessionBadge({ session, date }: { session: string | null | undefined; date?: string | null }) {
  const s = (session ?? 'MARKET_CLOSED').toUpperCase();
  let tone: Tone = 'neutral';
  if (s === 'MARKET_OPEN') tone = 'pos';
  else if (s === 'PREMARKET' || s === 'POSTMARKET') tone = 'info';
  else if (s === 'EARLY_CLOSE') tone = 'warn';
  return (
    <Badge tone={tone} className="whitespace-nowrap">
      {s}
      {date ? ` · ${dateText(date)}` : ''}
    </Badge>
  );
}

/** Horizontal materiality / contribution bar (0..1 or 0..100 input). */
export function MeterBar({ value, tone, width = 'w-24' }: { value: number | null | undefined; tone?: Tone; width?: string }) {
  const n = barPct(value);
  const t: Tone = tone ?? (n >= 70 ? 'pos' : n >= 40 ? 'warn' : 'neutral');
  return (
    <div className={`h-1.5 overflow-hidden rounded-full bg-ink-700 ${width}`}>
      <div className={`h-full rounded-full ${TONE_FILL[t]}`} style={{ width: `${n}%` }} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* charts (hand-rolled SVG)                                            */
/* ------------------------------------------------------------------ */

function finite(values: Array<number | null | undefined>): number[] {
  return values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
}

export function Sparkline({
  values,
  width = 110,
  height = 26,
  tone = 'pos',
  ariaLabel = 'trend',
}: {
  values: Array<number | null | undefined>;
  width?: number;
  height?: number;
  tone?: Tone;
  ariaLabel?: string;
}) {
  const pts = finite(values);
  if (pts.length < 2) {
    return (
      <svg width={width} height={height} role="img" aria-label={`${ariaLabel} (no data)`} className="opacity-50">
        <line x1={2} y1={height / 2} x2={width - 2} y2={height / 2} stroke="#2a3950" strokeDasharray="3 3" />
      </svg>
    );
  }
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const span = max - min || 1;
  const stepX = (width - 4) / (pts.length - 1);
  const d = pts
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${(2 + i * stepX).toFixed(1)},${(height - 3 - ((v - min) / span) * (height - 6)).toFixed(1)}`)
    .join(' ');
  const color = SVG_TONE[tone];
  const last = pts[pts.length - 1];
  const lastY = height - 3 - ((last - min) / span) * (height - 6);
  return (
    <svg width={width} height={height} role="img" aria-label={ariaLabel} className="overflow-visible">
      <path d={d} fill="none" stroke={color} strokeWidth={1.4} strokeLinejoin="round" />
      <circle cx={width - 2} cy={lastY} r={2} fill={color} />
    </svg>
  );
}

export interface ChartPoint {
  x: number;
  y: number | null;
}

export interface ChartSeries {
  name: string;
  color: string;
  points: ChartPoint[];
}

/** Multi-series line/equity chart with value axis labels, time axis + legend. */
export function LineChart({
  series,
  height = 220,
  ariaLabel = 'chart',
  valueFormat = (v: number) => number(v),
}: {
  series: ChartSeries[];
  height?: number;
  ariaLabel?: string;
  valueFormat?: (v: number) => string;
}) {
  const legend = series.length > 1 || true;
  const W = 720;
  const H = height;
  const padL = 62;
  const padR = 14;
  const padT = 12;
  const padB = 26;

  const all = series.flatMap((s) => s.points);
  const ys = finite(all.map((p) => p.y));
  const xs = finite(all.map((p) => p.x));

  const body =
    ys.length === 0 || xs.length === 0 ? null : (() => {
      let min = Math.min(...ys);
      let max = Math.max(...ys);
      if (min === max) {
        min -= Math.abs(min) * 0.01 + 1;
        max += Math.abs(max) * 0.01 + 1;
      }
      const xMin = Math.min(...xs);
      const xMax = Math.max(...xs);
      const xSpan = xMax - xMin;
      const yPad = (max - min) * 0.08;
      const lo = min - yPad;
      const hi = max + yPad;
      const sx = (x: number): number => (xSpan === 0 ? (padL + W - padR) / 2 : padL + ((x - xMin) / xSpan) * (W - padL - padR));
      const sy = (y: number): number => H - padB - ((y - lo) / (hi - lo)) * (H - padT - padB);

      const gridLines = [0, 0.25, 0.5, 0.75, 1].map((t) => {
        const v = lo + (hi - lo) * t;
        return { y: sy(v), label: valueFormat(v) };
      });

      const paths = series.map((s) => {
        const pts = [...s.points]
          .filter((p) => typeof p.y === 'number' && Number.isFinite(p.y) && Number.isFinite(p.x))
          .sort((a, b) => a.x - b.x);
        let d = '';
        let pen = false;
        for (const p of pts) {
          const y = p.y as number;
          if (!pen) {
            d += `M${sx(p.x).toFixed(1)},${sy(y).toFixed(1)}`;
            pen = true;
          } else {
            d += `L${sx(p.x).toFixed(1)},${sy(y).toFixed(1)}`;
          }
        }
        return { name: s.name, color: s.color, d };
      });

      const xTicks =
        xs.length >= 3
          ? [xMin, xMin + xSpan / 2, xMax].map((x) => ({ x: sx(x), label: axisTime(x, xSpan) }))
          : xs.map((x) => ({ x: sx(x), label: axisTime(x, xSpan) }));

      return { gridLines, paths, xTicks };
    })();

  return (
    <div>
      {legend && (
        <div className="mb-1 flex flex-wrap items-center gap-3">
          {series.map((s) => (
            <span key={s.name} className="flex items-center gap-1.5 text-[11px] text-mist">
              <span className="inline-block h-0.5 w-4 rounded" style={{ background: s.color }} aria-hidden />
              {s.name}
            </span>
          ))}
        </div>
      )}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={ariaLabel}
        className="block"
      >
        {body === null ? (
          <>
            <rect x={padL} y={padT} width={W - padL - padR} height={H - padT - padB} fill="none" stroke="#1e2a3d" />
            <text x={W / 2} y={H / 2} textAnchor="middle" fontSize="12" fill="#93a4bd">
              no data
            </text>
          </>
        ) : (
          <>
            {body.gridLines.map((g, i) => (
              <g key={i}>
                <line x1={padL} y1={g.y} x2={W - padR} y2={g.y} stroke="#1e2a3d" strokeDasharray="2 4" />
                <text x={padL - 6} y={g.y + 3} textAnchor="end" fontSize="10" fontFamily="monospace" fill="#93a4bd">
                  {g.label}
                </text>
              </g>
            ))}
            {body.xTicks.map((t, i) => (
              <text key={i} x={t.x} y={H - 8} textAnchor="middle" fontSize="10" fontFamily="monospace" fill="#93a4bd">
                {t.label}
              </text>
            ))}
            {body.paths.map((p) => (
              <path key={p.name} d={p.d} fill="none" stroke={p.color} strokeWidth={1.6} strokeLinejoin="round" />
            ))}
          </>
        )}
      </svg>
    </div>
  );
}

/** Signed vertical bar chart with a zero baseline and axis labels. */
export function BarChart({
  data,
  height = 170,
  ariaLabel = 'bar chart',
  valueFormat = (v: number) => pct(v),
}: {
  data: Array<{ label: string; value: number | null; color?: string }>;
  height?: number;
  ariaLabel?: string;
  valueFormat?: (v: number) => string;
}) {
  const W = 720;
  const H = height;
  const padT = 14;
  const padB = 34;
  const padL = 56;
  const padR = 10;
  const values = finite(data.map((d) => d.value));
  if (values.length === 0) {
    return (
      <div className="py-6 text-center font-mono text-xs text-mist" role="img" aria-label={ariaLabel}>
        no data
      </div>
    );
  }
  const max = Math.max(...values.map((v) => Math.abs(v)), 0.0001);
  const zeroY = padT + (H - padT - padB) / 2;
  const usable = (H - padT - padB) / 2;
  const slot = (W - padL - padR) / data.length;
  const barW = Math.min(34, slot * 0.6);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="xMidYMid meet" role="img" aria-label={ariaLabel} className="block">
      <line x1={padL} y1={zeroY} x2={W - padR} y2={zeroY} stroke="#2a3950" />
      <text x={padL - 6} y={zeroY + 3} textAnchor="end" fontSize="10" fontFamily="monospace" fill="#93a4bd">
        0
      </text>
      <text x={padL - 6} y={padT + 6} textAnchor="end" fontSize="10" fontFamily="monospace" fill="#93a4bd">
        {valueFormat(max)}
      </text>
      <text x={padL - 6} y={H - padB} textAnchor="end" fontSize="10" fontFamily="monospace" fill="#93a4bd">
        {valueFormat(-max)}
      </text>
      {data.map((d, i) => {
        const v = typeof d.value === 'number' && Number.isFinite(d.value) ? d.value : null;
        const cx = padL + slot * i + slot / 2;
        if (v === null) {
          return (
            <text key={d.label + i} x={cx} y={zeroY - 4} textAnchor="middle" fontSize="9" fontFamily="monospace" fill="#93a4bd">
              —
            </text>
          );
        }
        const h = (Math.abs(v) / max) * usable;
        const y = v >= 0 ? zeroY - h : zeroY;
        const fill = d.color ?? (v >= 0 ? SVG_TONE.pos : SVG_TONE.neg);
        return (
          <g key={d.label + i}>
            <rect x={cx - barW / 2} y={y} width={barW} height={Math.max(h, 1)} fill={fill} opacity={0.85} rx={2} />
            <text x={cx} y={v >= 0 ? y - 4 : y + h + 11} textAnchor="middle" fontSize="9" fontFamily="monospace" fill={fill}>
              {valueFormat(v)}
            </text>
            <text x={cx} y={H - 10} textAnchor="middle" fontSize="9" fontFamily="monospace" fill="#93a4bd">
              {d.label.length > 10 ? `${d.label.slice(0, 9)}…` : d.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** Horizontal labeled bar row — sector exposure, weights, comparisons. */
export function HBar({
  label,
  value,
  display,
  tone = 'info',
  max,
}: {
  label: string;
  value: number;
  display?: ReactNode;
  tone?: Tone;
  max?: number;
}) {
  const ceiling = max ?? 100;
  const width = ceiling > 0 ? Math.max(0, Math.min(100, (Math.abs(value) / ceiling) * 100)) : 0;
  return (
    <div className="flex items-center gap-2 py-1">
      <div className="w-40 shrink-0 truncate text-xs text-mist" title={label}>
        {label}
      </div>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-ink-700">
        <div className={`h-full rounded-full ${TONE_FILL[tone]}`} style={{ width: `${width}%` }} />
      </div>
      <div className="w-24 shrink-0 text-right font-mono text-xs text-slate-soft">{display ?? value}</div>
    </div>
  );
}

/** Two small paired bars (predicted vs actual style comparisons). */
export function PairedBars({
  leftLabel,
  leftValue,
  rightLabel,
  rightValue,
}: {
  leftLabel: string;
  leftValue: number | null;
  rightLabel: string;
  rightValue: number | null;
}) {
  const max = Math.max(Math.abs(leftValue ?? 0), Math.abs(rightValue ?? 0), 0.0001);
  const row = (label: string, v: number | null, tone: Tone): ReactNode => (
    <div className="flex items-center gap-2">
      <span className="w-16 shrink-0 text-[10px] uppercase tracking-wide text-mist">{label}</span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-ink-700">
        <div
          className={`h-full rounded-full ${TONE_FILL[tone]}`}
          style={{ width: `${v === null ? 0 : (Math.abs(v) / max) * 100}%` }}
        />
      </div>
      <span className={`w-20 shrink-0 text-right font-mono text-[11px] ${TONE_TEXT[tone]}`}>{pct(v)}</span>
    </div>
  );
  return (
    <div className="space-y-1">
      {row(leftLabel, leftValue, 'info')}
      {row(rightLabel, rightValue, 'pos')}
    </div>
  );
}

/** Definition list for detail blocks. */
export function Fields({ items }: { items: Array<{ label: string; value: ReactNode }> }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((it) => (
        <div key={it.label}>
          <dt className="text-[10px] uppercase tracking-wider text-mist">{it.label}</dt>
          <dd className="mt-0.5 text-sm text-slate-soft">{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Chips row (factors, scope tags, knowledge refs). */
export function Chips({ items, tone = 'info' }: { items: string[]; tone?: Tone }) {
  if (items.length === 0) return <span className="text-xs text-mist">none</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {items.map((item) => (
        <Badge key={item} tone={tone}>
          {item}
        </Badge>
      ))}
    </span>
  );
}

/** Shared page preamble: error → retry, loading → status text. */
export function pageState<T>(data: T | undefined, error: string | null, reload: () => void, label: string): ReactNode | null {
  if (data !== undefined) return null;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  return <Loading label={label} />;
}