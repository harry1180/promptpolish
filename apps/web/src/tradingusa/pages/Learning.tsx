/**
 * Learning — mistake detection stats, the mistake log, clusters, lesson
 * cards with scope chips and validation bars, and the rule-extraction
 * table (condition → action).
 */

import { useState } from 'react';
import { getExperiments, getLearning } from '../api';
import type { ExperimentsResponse, LearningResponse } from '../api';
import { useEndpoint } from '../data';
import {
  Badge,
  Card,
  Chips,
  ConfidenceBar,
  DataTable,
  EmptyState,
  ErrorState,
  HBar,
  Loading,
  StatTile,
  flex,
  number,
  pct,
  pctAuto,
  time,
  toneClass,
} from '../ui';

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

/**
 * Rule experiments — shadow mode, filterable by date range.
 *
 * The point is to answer "which setups actually make money?" so conviction
 * can follow evidence. It never suppresses a trade: the server side is
 * read-only and the only possible graduation is a bias UP toward setups that
 * proved out.
 */
function RuleExperiments() {
  const [from, setFrom] = useState(() => isoDaysAgo(89));
  const [to, setTo] = useState(() => isoDaysAgo(0));
  const ep = useEndpoint<ExperimentsResponse>(
    `/experiments?from=${from}&to=${to}`,
    () => getExperiments(from, to),
  );

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
  const best = [...conditions]
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
          <span className="font-mono">{pct(best.deltaReturnPct)} vs the rest</span>{' '}
          over {number(best.matchedClosed)} closed trades.
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
          columns={[
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
            {
              key: 'winRate',
              header: 'Win rate',
              align: 'right',
              cell: (r) => <span className="font-mono text-xs">{pct(r.matchedWinRatePct)}</span>,
            },
            {
              key: 'matchedAvg',
              header: 'Matched avg',
              align: 'right',
              cell: (r) => <span className="font-mono text-xs">{pct(r.matchedAvgReturnPct)}</span>,
            },
            {
              key: 'baselineAvg',
              header: 'Rest avg',
              align: 'right',
              cell: (r) => <span className="font-mono text-xs text-mist">{pct(r.baselineAvgReturnPct)}</span>,
            },
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
            {
              key: 'status',
              header: 'Status',
              cell: (r) => <Badge tone={experimentTone(r.status)}>{r.status.replace(/_/g, ' ')}</Badge>,
            },
          ]}
          empty={<p className="py-4 text-center text-xs text-mist">No signals in this window.</p>}
        />
      </div>
    </Card>
  );
}

function statusTone(status: string): 'pos' | 'neg' | 'warn' | 'neutral' {
  const s = status.toUpperCase();
  if (s === 'VALIDATED') return 'pos';
  if (s === 'REJECTED') return 'neg';
  if (s === 'EXPIRED') return 'neutral';
  return 'warn';
}

export function LearningPage() {
  const ep = useEndpoint<LearningResponse>('/learning', getLearning);

  if (ep.data === undefined) {
    return ep.error ? <ErrorState message={ep.error} onRetry={ep.reload} /> : <Loading label="Loading learning data…" />;
  }
  const d = ep.data;
  const stats = d.stats ?? {};

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatTile label="Mistakes detected" value={number(stats.mistakesDetected ?? null)} />
        <StatTile label="Lessons proposed" value={number(stats.lessonsProposed ?? null)} />
        <StatTile label="Lessons validated" value={number(stats.lessonsValidated ?? null)} tone="pos" />
        <StatTile label="Lessons rejected" value={number(stats.lessonsRejected ?? null)} tone="neg" />
        <StatTile label="Clusters" value={number(stats.clusters ?? null)} />
        <StatTile label="Challenger rules" value={number(stats.challengerRules ?? null)} />
      </div>

      {/* learned fusion weights — what runScan is using right now */}
      <Card
        title="Learned fusion weights"
        subtitle="Refit from realized outcomes after the close; every part stays within ±35% of its shipped default and nothing is published before 10 closed trades back it."
      >
        {(d.fusionWeights ?? []).length === 0 ? (
          <EmptyState title="No learned weights yet">
            The daily refresh publishes weights once a strategy has enough closed outcomes. Until then the shipped defaults drive fusion.
          </EmptyState>
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {(d.fusionWeights ?? []).map((w) => (
              <div key={`${w.strategy}|${w.horizon}`} className="rounded-md border border-line bg-ink-900/70 p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-xs font-semibold text-mint">{w.strategy}</span>
                  <Badge tone="info">{w.horizon}</Badge>
                </div>
                <p className="mt-1 font-mono text-[10px] text-mist">
                  fitted on {number(w.trades)} closed trades · refreshed {time(w.updatedAt)}
                </p>
                <div className="mt-2">
                  {WEIGHT_PARTS.map((part) => {
                    const learned = Number((w.weights ?? {})[part] ?? Number.NaN);
                    const base = Number((w.defaults ?? {})[part] ?? Number.NaN);
                    const has = Number.isFinite(learned);
                    const delta = has && Number.isFinite(base) ? learned - base : null;
                    const tone: 'pos' | 'neg' | 'neutral' | 'info' =
                      delta == null ? 'info' : delta > 0.002 ? 'pos' : delta < -0.002 ? 'neg' : 'neutral';
                    const deltaText =
                      delta != null && Math.abs(delta) >= 0.0005
                        ? ` (${delta > 0 ? '+' : ''}${(delta * 100).toFixed(1)})`
                        : '';
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
            ))}
          </div>
        )}
      </Card>

      {/* shadow-mode experiments: which setups actually make money */}
      <RuleExperiments />

      {/* mistakes */}
      <Card title="Mistakes" subtitle="Detected from closed paper trades — the raw material of every lesson.">
        {(d.mistakes ?? []).length === 0 ? (
          <EmptyState title="No mistakes recorded">No trading mistakes have been detected yet.</EmptyState>
        ) : (
          <ul className="space-y-2">
            {(d.mistakes ?? []).map((m) => (
              <li key={m.id} className="border-b border-line/60 pb-2 last:border-b-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="warn">{m.kind}</Badge>
                  {m.ticker && <span className="font-mono text-xs font-semibold text-mint">{m.ticker}</span>}
                  <ConfidenceBar value={m.confidence ?? null} />
                  <span className={`ml-auto font-mono text-xs ${toneClass(m.lossPct ?? null)}`}>{pctAuto(m.lossPct ?? null)}</span>
                  <Badge tone={m.status === 'RESOLVED' ? 'pos' : 'neutral'}>{m.status ?? 'OPEN'}</Badge>
                </div>
                <p className="mt-1 text-xs text-slate-soft">{m.rationale ?? '—'}</p>
                <p className="mt-0.5 font-mono text-[10px] text-mist">
                  trade {m.tradeId ?? '—'} · {time(m.ts)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* clusters */}
      <Card title="Mistake clusters">
        {(d.clusters ?? []).length === 0 ? (
          <p className="text-xs text-mist">No mistake clusters yet.</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {(d.clusters ?? []).map((c) => (
              <div key={c.id} className="rounded-md border border-line bg-ink-900/70 p-3">
                <div className="flex items-center justify-between gap-2">
                  <Badge tone="info">{c.kind}</Badge>
                  <span className="font-mono text-xs text-mist">{number(c.count ?? null)} occurrences</span>
                </div>
                <div className="mt-2">
                  <ConfidenceBar value={c.confidence ?? null} />
                </div>
                {c.lesson && <p className="mt-1 text-xs text-slate-soft">{c.lesson}</p>}
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* lessons */}
      <Card title="Lessons" subtitle="Scope chips show where each lesson applies; bars compare validations vs contradictions.">
        {(d.lessons ?? []).length === 0 ? (
          <EmptyState title="No lessons yet">No lessons have been proposed from trading outcomes.</EmptyState>
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {(d.lessons ?? []).map((l) => {
              const validations = l.validations ?? 0;
              const contradictions = l.contradictions ?? 0;
              const total = validations + contradictions;
              const scope = Object.entries(l.scope ?? {})
                .filter(([, v]) => v !== null && v !== undefined && v !== '')
                .map(([k, v]) => `${k}: ${String(v)}`);
              return (
                <div key={l.id} className="rounded-md border border-line bg-ink-900/70 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-sm font-semibold text-slate-soft">{l.title}</span>
                    <Badge tone={statusTone(l.status)}>{l.status}</Badge>
                  </div>
                  <p className="mt-1 text-xs text-mist">{l.statement}</p>
                  <div className="mt-2">
                    <Chips items={scope} tone="neutral" />
                  </div>
                  <div className="mt-2 space-y-1">
                    <HBar
                      label="Validations"
                      value={validations}
                      display={number(validations)}
                      tone="pos"
                      max={Math.max(total, 1)}
                    />
                    <HBar
                      label="Contradictions"
                      value={contradictions}
                      display={number(contradictions)}
                      tone="neg"
                      max={Math.max(total, 1)}
                    />
                  </div>
                  <div className="mt-2 flex items-center justify-between text-[11px] text-mist">
                    <ConfidenceBar value={l.confidence ?? null} />
                    <span className="font-mono">{time(l.createdAt ?? null)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* rule extraction */}
      <Card title="Rule extraction" subtitle="Condition → action candidates; only validated rules ever reach execution.">
        <DataTable
          label="Rule extraction"
          rows={d.ruleExtraction ?? []}
          rowKey={(r) => r.id}
          columns={[
            { key: 'condition', header: 'Condition', cell: (r) => <span className="font-mono text-xs text-slate-soft">{flex(r.condition)}</span> },
            { key: 'action', header: 'Action', cell: (r) => <span className="text-xs text-mint">{r.action ?? '—'}</span> },
            { key: 'evidence', header: 'Evidence', align: 'right', cell: (r) => <span className="font-mono text-xs">{number(r.evidenceCount ?? null)}</span> },
            { key: 'status', header: 'Status', cell: (r) => <Badge tone={statusTone(r.status ?? 'CANDIDATE')}>{r.status ?? 'CANDIDATE'}</Badge> },
          ]}
          empty={<p className="py-4 text-center text-xs text-mist">No candidate rules extracted yet.</p>}
        />
      </Card>
    </div>
  );
}