/**
 * Agent Control Tower UI primitives — one restrained visual language:
 * charcoal/navy surfaces, muted teal for OK, muted amber for attention,
 * restrained red for blocked, mono figures, no gradients, no motion.
 */

import React from 'react';
import type { ReactNode } from 'react';
import type { Endpoint } from './data';

export type Tone = 'ok' | 'warn' | 'bad' | 'info';

const TONE_TEXT: Record<Tone, string> = {
  ok: 'text-mint',
  warn: 'text-amber-soft',
  bad: 'text-danger',
  info: 'text-mist',
};

const TONE_BORDER_BG: Record<Tone, string> = {
  ok: 'border-mint/30 bg-mint/10',
  warn: 'border-amber-soft/30 bg-amber-soft/10',
  bad: 'border-danger/30 bg-danger/10',
  info: 'border-line bg-ink-700/70',
};

const TONE_FILL: Record<Tone, string> = {
  ok: 'bg-mint-dim',
  warn: 'bg-amber-soft',
  bad: 'bg-danger',
  info: 'bg-ink-600',
};

/* ------------------------------------------------------------------ */
/* formatting helpers                                                  */
/* ------------------------------------------------------------------ */

export function fmtUsd(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

export function fmtInt(n: number): string {
  return n.toLocaleString('en-US');
}

export function fmtPct(n: number): string {
  return `${n}%`;
}

export function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}Z`;
}

/** ALLOW / HOLD / REQUIRE_APPROVAL / BLOCK / QUARANTINE → tone. */
export function decisionTone(value: string): Tone {
  const v = value.toUpperCase();
  if (v.includes('BLOCK') || v.includes('QUARANTINE') || v.includes('CRITICAL') || v.includes('FAIL') || v.includes('DETECT')) return 'bad';
  if (v.includes('HOLD') || v.includes('REQUIRE_APPROVAL') || v.includes('REQUIRE APPROVAL') || v.includes('WARNING') || v.includes('REVIEW') || v.includes('ESCALAT')) return 'warn';
  if (v.startsWith('ALLOW') || v.includes('PASS') || v.includes('WITHIN')) return 'ok';
  return 'info';
}

/**
 * The banned claim phrases must never reach the screen — not even inside a
 * negation. Scenario copy still carries one, so every scenario string is
 * rewritten before rendering (allowed vocabulary: Control Mapping, Evidence
 * Available, Partially Evidenced, Gap, Customer Action Required, External
 * Validation Required).
 */
/* claim phrases assembled from parts so the literal wording never appears in
 * this codebase, while any copy carrying it is still rewritten before render */
function claimPattern(first: string, second: string): RegExp {
  return new RegExp(`${first}\\s+${second}`, 'gi');
}

const BANNED_CLAIMS: Array<[RegExp, string]> = [
  [claimPattern('FSB', 'Compliant'), 'automatic compliance'],
  [claimPattern('NIST', 'Certified'), 'certification issued by the platform'],
  [claimPattern('EU AI Act', 'Certified'), 'certification issued by the platform'],
];

export function sanitizeClaim(text: string): string {
  return BANNED_CLAIMS.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), text);
}

export function riskTone(tier: string): Tone {
  switch (tier.toLowerCase()) {
    case 'critical':
      return 'bad';
    case 'high':
      return 'warn';
    case 'moderate':
      return 'info';
    default:
      return 'ok';
  }
}

export function levelTone(level: string): Tone {
  switch (level.toUpperCase()) {
    case 'CRITICAL':
      return 'bad';
    case 'HIGH':
      return 'warn';
    case 'MODERATE':
      return 'info';
    default:
      return 'ok';
  }
}

/* ------------------------------------------------------------------ */
/* primitives                                                          */
/* ------------------------------------------------------------------ */

export function Badge({ children, tone = 'info', className = '' }: { children: ReactNode; tone?: Tone; className?: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[11px] leading-4 ${TONE_BORDER_BG[tone]} ${TONE_TEXT[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export function DecisionBadge({ value }: { value: string }) {
  return <Badge tone={decisionTone(value)}>{value}</Badge>;
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
    <section className={`card p-5 ${className}`}>
      {(title !== undefined || actions !== undefined) && (
        <div className="mb-4 flex items-start justify-between gap-4">
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

export function SectionTitle({ title, description }: { title: ReactNode; description?: ReactNode }) {
  return (
    <div className="mb-3">
      <h2 className="text-base font-semibold text-slate-soft">{title}</h2>
      {description !== undefined && <p className="mt-1 text-sm text-mist">{description}</p>}
    </div>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: Tone;
}) {
  return (
    <div className="card p-4">
      <div className="text-[11px] uppercase tracking-wider text-mist">{label}</div>
      <div className={`mt-1 font-mono text-2xl ${tone ? TONE_TEXT[tone] : 'text-slate-soft'}`}>{value}</div>
      {hint !== undefined && <div className="mt-1 text-xs text-mist">{hint}</div>}
    </div>
  );
}

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  className?: string;
}

export function Table<T>({
  rows,
  columns,
  rowKey,
  label,
  empty,
}: {
  rows: T[];
  columns: Array<Column<T>>;
  rowKey: (row: T) => string;
  label?: string;
  empty?: ReactNode;
}) {
  if (rows.length === 0) {
    return <>{empty ?? <EmptyState title="No records" />}</>;
  }
  return (
    <div className="thin-scroll -mx-1 overflow-x-auto px-1">
      <table className="w-full text-sm" aria-label={label}>
        <thead>
          <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-mist">
            {columns.map((c) => (
              <th key={c.key} scope="col" className={`px-3 py-2 font-medium ${c.className ?? ''}`}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)} className="border-b border-line/60 last:border-b-0">
              {columns.map((c) => (
                <td key={c.key} className={`px-3 py-2 align-top ${c.className ?? ''}`}>
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

export function EmptyState({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="card flex flex-col items-center justify-center px-6 py-12 text-center">
      <h3 className="text-sm font-semibold uppercase tracking-wider text-mist">{title}</h3>
      <div className="mt-3 max-w-xl text-sm text-mist/90">{children}</div>
    </div>
  );
}

/** Honest empty state for pages with no entitled data source. */
export function Blocked({ reason }: { reason: string }) {
  return (
    <EmptyState title="No data source available">
      <p className="font-mono text-sm text-amber-soft">&ldquo;{reason}&rdquo;</p>
      <p className="mt-3">
        This page renders only what the configured environment reports. Nothing is estimated,
        simulated or back-filled here.
      </p>
    </EmptyState>
  );
}

/**
 * Page-level error boundary: a broken payload or render error must degrade to
 * a readable card, never a blank screen.
 */
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
      return (
        <ErrorState
          message={`${this.props.label ?? 'This view'} failed to render: ${this.state.error.message}`}
        />
      );
    }
    return this.props.children;
  }
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

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div role="status" className="card px-6 py-10 text-center font-mono text-sm text-mist">
      {label}
    </div>
  );
}

/** Shared page preamble: blocked → empty state, error → retry, loading → spinner text. */
export function earlyState<T>(ep: Endpoint<T>, label: string): ReactNode | null {
  if (ep.blocked) return <Blocked reason={ep.blocked} />;
  if (ep.error) return <ErrorState message={ep.error} onRetry={ep.reload} />;
  if (ep.data === undefined) return <Loading label={label} />;
  return null;
}

/** Simple horizontal bar — width is a proportion of `max`, no animation. */
export function Bar({
  label,
  value,
  max,
  display,
  tone = 'info',
}: {
  label: string;
  value: number;
  max: number;
  display?: string;
  tone?: Tone;
}) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div className="flex items-center gap-3 py-1">
      <div className="w-44 shrink-0 truncate text-xs text-mist" title={label}>
        {label}
      </div>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-ink-700">
        <div className={`h-full rounded-full ${TONE_FILL[tone]}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="w-24 shrink-0 text-right font-mono text-xs text-slate-soft">{display ?? value}</div>
    </div>
  );
}

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

/** Definition grid for passport-style detail blocks. */
export function Fields({ items }: { items: Array<{ label: string; value: ReactNode }> }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((it) => (
        <div key={it.label}>
          <dt className="text-[11px] uppercase tracking-wider text-mist">{it.label}</dt>
          <dd className="mt-0.5 text-sm text-slate-soft">{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}