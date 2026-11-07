/**
 * Learning — what this book has taught itself so far: the fusion weights the
 * scanner is using (shipped defaults until 10 closed outcomes back a change),
 * the lesson ledger, and the shadow-mode rule experiments filterable by date.
 *
 * Experiments watch only: they record "I would have blocked this trade" and
 * never actually block anything. Graduation, if it ever comes, can only bias
 * conviction UP toward setups that proved out.
 */

import { useState } from 'react';
import { getExperiments, getLearning } from '../api';
import type { ExperimentsResponse, LearningResponse } from '../api';
import { useEndpoint } from '../data';
import {
  Badge,
  Card,
  DataTable,
  EmptyState,
  ErrorState,
  HBar,
  Loading,
  StatTile,
  number,
  pct,
  time,
  toneClass,
} from '../../tradingusa/ui';
import type { Column } from '../../tradingusa/ui';
import type { ExperimentRow } from '../api';

/** The six score parts fusion blends — shown learned-vs-shipped. */
const WEIGHT_PARTS = ['technical', 'fundamental', 'event', 'sentiment', 'macro', 'regime'] as const;

function isoDaysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

const RANGE_PRESETS = [
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
  { label: '180d', days: 180 },
];

function experimentTone(status: string): 'pos' | 'neg' | 'warn' {
  if (status === 'PROMOTE_CANDIDATE') return 'pos';
  if (status === 'NO_EDGE') return 'neg';
  return 'warn';
}

const experimentColumns: Array<Column<ExperimentRow>> = [
  {
    key: 'setup',
    header: 'Setup',
    cell: (r) => (
      <div>
        <div className="text-xs font-semibold text-slate-soft">{r.label}</div>
        <div className="text-[10px] text-mist">{r.description}</div>
      </div>
    ),
  },
  {
    key: 'matched',
    header: 'Matched',
    align: 'right',
    cell: (r) => (
      <span className="font-mono text-xs">
        {number(r.matchedClosed)}
        <span className="text-mist"> / {number(r.matchedSignals)}</span>
      </span>
    ),
  },
  { key: 'winRate', header: 'Win rate', align: 'right', cell: (r) => <span className="font-mono text-xs">{pct(r.matchedWinRatePct)}</span> },
  { key: 'matchedAvg', header: 'Matched avg', align: 'right', cell: (r) => <span className="font-mono text-xs">{pct(r.matchedAvgReturnPct)}</span> },
  { key: 'baselineAvg', header: 'Rest avg', align: 'right', cell: (r) => <span className="font-mono text-xs text-mist">{pct(r.baselineAvgReturnPct)}</span> },
  {
    key: 'delta',
    header: 'Edge',
    align: 'right',
    cell: (r) => (
      <span className={`font-mono text-xs ${r.deltaReturnPct == null ? 'text-mist' : toneClass(r.deltaReturnPct)}`}>
        {pct(r.deltaReturnPct)}
      </span>
    ),
  },
  { key: 'status', header: 'Status', cell: (r) => <Badge tone={experimentTone(r.status)}>{r.status.replace(/_/g, ' ')}</Badge> },
];

function RuleExperiments() {
  const [from, setFrom] = useState(() => isoDaysAgo(89));
  const [to, setTo] = useState(() => isoDaysAgo(0));
  const ep = useEndpoint<ExperimentsResponse>(`/experiments?from=${from}&to=${to}`, () => getExperiments(from, to));

  if (ep.data === undefined) {
    return ep.error ? <ErrorState message={ep.error} onRetry={ep.reload} /> : <Loading label="Loading experiments…" />;
  }
  // unknown/partial payloads must survive — stubFetch answers '{}' for
  // anything not in its fixture map, and the page still has to render
  const d = ep.data;
  const conditions = d.conditions ?? [];
  const verdicts = conditions.filter((c) => c.status !== 'OBSERVING').length;
  // only a POSITIVE edge deserves the headline — a negative delta would read
  // as "strongest setup" while actually being the weakest
  const best =
    [...conditions]
      .filter((c) => (c.deltaReturnPct ?? -Infinity) > 0)
      .sort((a, b) => (b.deltaReturnPct ?? -Infinity) - (a.deltaReturnPct ?? -Infinity))[0] ?? null;

  return (
    <Card
      title="Rule experiments · shadow mode"
      subtitle={d.note ?? 'Shadow mode — these experiments observe outcomes only. Nothing is blocked.'}
    >
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wider text-mist">
          From
          <input
            type="date"
            value={from}
            max={to}
            onChange={(e) => setFrom(e.target.value)}
            aria-label="experiments from date"
            className="rounded-md border border-line bg-ink-800 px-2 py-1 font-mono text-xs text-slate-soft"
          />
        </label>
        <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wider text-mist">
          To
          <input
            type="date"
            value={to}
            min={from}
            onChange={(e) => setTo(e.target.value)}
            aria-label="experiments to date"
            className="rounded-md border border-line bg-ink-800 px-2 py-1 font-mono text-xs text-slate-soft"
          />
        </label>
        <div className="flex gap-1">
          {RANGE_PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => {
                setFrom(isoDaysAgo(p.days - 1));
                setTo(isoDaysAgo(0));
              }}
              className="rounded-md border border-line bg-ink-800 px-2 py-1 font-mono text-xs text-slate-soft hover:border-mint/50"
            >
              {p.label}
            </button>
          ))}
        </div>
        <span className="ml-auto font-mono text-[11px] text-mist">
          {d.from} → {d.to}
        </span>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <StatTile label="Signals in window" value={number(d.signals ?? 0)} />
        <StatTile label="Closed trades" value={number(d.closedTrades ?? 0)} />
        <StatTile label="Setups with a verdict" value={number(verdicts)} tone={verdicts > 0 ? 'pos' : undefined} />
      </div>

      {best ? (
        <p className="mt-2 text-xs text-slate-soft">
          Strongest setup in this window: <span className="font-mono text-mint">{best.label}</span>{' '}
          <span className="font-mono">{pct(best.deltaReturnPct)} vs the rest</span> over {number(best.matchedClosed)} closed
          trades.
        </p>
      ) : (
        <p className="mt-2 text-xs text-mist">
          No setup beats the rest of this window yet — the experiments keep observing until the evidence floor is met.
        </p>
      )}

      <div className="mt-3">
        <DataTable
          label="Rule experiments"
          rows={conditions}
          rowKey={(r) => r.key}
          columns={experimentColumns}
          empty={<p className="py-4 text-center text-xs text-mist">No signals in this window.</p>}
        />
      </div>
    </Card>
  );
}

export function LearningPage() {
  const ep = useEndpoint<LearningResponse>('/learning', getLearning);

  if (ep.data === undefined) {
    return ep.error ? <ErrorState message={ep.error} onRetry={ep.reload} /> : <Loading label="Loading learning data…" />;
  }
  const d = ep.data;
  // unknown/partial payloads must survive — stubFetch answers '{}' for
  // anything not in its fixture map, and the page still has to render
  const w = d.fusionWeights ?? { defaults: {}, learned: null, sufficient: false, trades: 0, updatedAt: null };

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Outcomes recorded" value={number(d.outcomesRecorded ?? 0)} hint="wins included" />
        <StatTile label="Weight refits" value={number(d.weightRefits ?? 0)} />
        <StatTile label="Evidence" value={`${number(w.trades)} trades`} tone={w.sufficient ? 'pos' : 'warn'} hint={w.sufficient ? 'weights are live' : 'below MIN_TRADES floor'} />
        <StatTile label="Lessons" value={(d.lessonsByStatus ?? []).map((l) => `${l.status.toLowerCase()} ${l.n}`).join(' · ') || 'none yet'} />
      </div>

      <Card
        title="Learned fusion weights"
        subtitle={d.note ?? 'Refit from realized outcomes; every part stays within ±35% of its shipped default and nothing is published before the evidence floor.'}
      >
        {!w.sufficient ? (
          <EmptyState title="No learned weights yet">
            The scanner uses the shipped defaults until 10 closed outcomes back a change for{' '}
            <span className="font-mono">{d.strategy ?? 'crypto_momentum_v1'}</span> ({d.horizon ?? 'SHORT'} horizon). Until
            then fusion is exactly what was shipped.
          </EmptyState>
        ) : (
          <div className="rounded-md border border-line bg-ink-900/70 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-xs font-semibold text-mint">{d.strategy}</span>
              <Badge tone="info">{d.horizon}</Badge>
            </div>
            <p className="mt-1 font-mono text-[10px] text-mist">
              fitted on {number(w.trades)} closed trades · refreshed {time(w.updatedAt)}
            </p>
            <div className="mt-2">
              {WEIGHT_PARTS.map((part) => {
                const learned = Number((w.learned ?? {})[part] ?? Number.NaN);
                const base = Number((w.defaults ?? {})[part] ?? Number.NaN);
                const has = Number.isFinite(learned);
                const delta = has && Number.isFinite(base) ? learned - base : null;
                const tone: 'pos' | 'neg' | 'neutral' | 'info' =
                  delta == null ? 'info' : delta > 0.002 ? 'pos' : delta < -0.002 ? 'neg' : 'neutral';
                const deltaText =
                  delta != null && Math.abs(delta) >= 0.0005 ? ` (${delta > 0 ? '+' : ''}${(delta * 100).toFixed(1)})` : '';
                return (
                  <HBar
                    key={part}
                    label={part}
                    value={has ? learned : 0}
                    max={0.5}
                    tone={tone}
                    display={has ? `${(learned * 100).toFixed(1)}%${deltaText}` : '—'}
                  />
                );
              })}
            </div>
          </div>
        )}
      </Card>

      <RuleExperiments />
    </div>
  );
}
