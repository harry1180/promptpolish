/**
 * Learning — what this book has taught itself so far: the fusion weights the
 * scanner is using (shipped defaults until 10 closed outcomes back a change),
 * the lesson ledger, the shadow-mode rule experiments, and the
 * MULTI-EXCHANGE MARKET INTELLIGENCE block: live source status, cross-venue
 * features, experimental source-contribution predictions and the validated
 * fixed-horizon accuracy.
 *
 * Experiments watch only: they record "I would have blocked this trade" and
 * never actually block anything. Graduation, if it ever comes, can only bias
 * conviction UP toward setups that proved out.
 *
 * Every multi-exchange widget is a read-only GET plus an honest state
 * (DISABLED / NOT WIRED / INSUFFICIENT_DATA / collecting). Nothing is
 * computed client-side: percentages, ages and counts come from the server
 * (decisionImpact: NONE), and a partial payload renders "—" instead of 0.
 */

import { useState } from 'react';
import type { ReactNode } from 'react';
import {
  getAccuracy,
  getContext,
  getExperiments,
  getLearning,
  getProviders,
  getSources,
  getXchange,
} from '../api';
import type {
  AccuracyHorizonView,
  AccuracyResponse,
  AgreementView,
  ContextResponse,
  ExperimentsResponse,
  LeadLagView,
  LearningResponse,
  ProviderSnapshotView,
  ProvidersResponse,
  SourceHorizonView,
  SourcesResponse,
  VenueWindowView,
  XchangeResponse,
} from '../api';
import { useEndpoint } from '../data';
import type { Endpoint } from '../data';
import {
  Badge,
  Card,
  DASH,
  DataTable,
  EmptyState,
  ErrorState,
  HBar,
  Loading,
  StatTile,
  number,
  pct,
  pctPlain,
  pctPlainAuto,
  time,
  toneClass,
} from '../../tradingusa/ui';
import type { Column, Tone } from '../../tradingusa/ui';
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

/* ==================================================================== */
/* MULTI-EXCHANGE MARKET INTELLIGENCE — read-only, research-only         */
/* ==================================================================== */

/** Pending venue ids -> display names (never silently enabled). */
const VENUE_LABELS: Record<string, string> = {
  kraken: 'Kraken',
  coinbase: 'Coinbase Exchange',
  binanceus: 'Binance.US',
  gemini: 'Gemini',
  bitstamp: 'Bitstamp',
  cryptocom: 'Crypto.com',
  dexscreener: 'DEX Screener',
  geckoterminal: 'GeckoTerminal',
  coingecko: 'CoinGecko',
};

function venueLabel(id: string): string {
  return VENUE_LABELS[id] ?? id;
}

/** ms since the last event → "12s ago"; null means the feed sent nothing. */
function ageText(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return 'no data yet';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

function bpsText(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  return `${number(v)} bps`;
}

function corrText(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  return v.toFixed(2);
}

function decimals(v: number | null | undefined, digits: number): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  return v.toFixed(digits);
}

function latencyText(latency: ProviderSnapshotView['latency'] | undefined): string {
  if (!latency || !Number.isFinite(latency.samples ?? 0) || (latency.samples ?? 0) === 0) return 'n/a';
  const p50 = latency.p50 === null || latency.p50 === undefined ? null : Math.round(latency.p50);
  const p95 = latency.p95 === null || latency.p95 === undefined ? null : Math.round(latency.p95);
  if (p50 === null && p95 === null) return 'n/a';
  return `${p50 ?? DASH} / ${p95 ?? DASH} ms`;
}

/** book channel present → how many levels pass the sequence check; else n/a. */
function integrityText(book: ProviderSnapshotView['book'] | undefined): string {
  if (!book || book.length === 0) return 'n/a';
  const valid = book.filter((b) => b && b.valid === true).length;
  return `${valid}/${book.length} valid`;
}

/** Small uppercase section caption with a rule (blocks 1–4). */
function Caption({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 pt-1">
      <h3 className="text-[10px] font-semibold uppercase tracking-[0.18em] text-mist">{children}</h3>
      <span aria-hidden className="h-px flex-1 bg-line" />
    </div>
  );
}

/** Loading / error / data switch for one endpoint inside its own card. */
function Block<T>({
  ep,
  title,
  subtitle,
  label,
  children,
  actions,
}: {
  ep: Endpoint<T>;
  title: string;
  subtitle?: ReactNode;
  label: string;
  actions?: ReactNode;
  children: (data: T) => ReactNode;
}) {
  if (ep.data === undefined) {
    return (
      <Card title={title} subtitle={subtitle} actions={actions}>
        {ep.error ? <ErrorState message={ep.error} onRetry={ep.reload} /> : <Loading label={`Loading ${label}…`} />}
      </Card>
    );
  }
  return (
    <Card title={title} subtitle={subtitle} actions={actions}>
      {children(ep.data)}
    </Card>
  );
}

interface SourceRow {
  key: string;
  source: string;
  feed: string;
  state: string;
  healthy: boolean;
  pairs: string;
  lastEventAgeMs: number | null;
  events: number;
  eventsPerMin: number;
  latency: string;
  integrity: string;
  note: string;
}

/**
 * CONNECTED is transport only: `healthy` (fresh valid data) is a SEPARATE
 * column, so a live socket with a frozen feed never reads as healthy.
 */
function SourceStatus({ state, healthy }: { state: string; healthy: boolean }) {
  const tone: Tone = healthy
    ? 'pos'
    : state === 'DEGRADED' || state === 'CONNECTING'
      ? 'warn'
      : state === 'DISABLED' ||
          state === 'UNAVAILABLE' ||
          state === 'DISCONNECTED' ||
          state === 'NEEDS_CONFIGURATION' ||
          state === 'NOT WIRED'
        ? 'neg'
        : state === 'CONNECTED'
          ? 'info'
          : 'neutral';
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Badge tone={tone}>{state}</Badge>
      <Badge tone={healthy ? 'pos' : 'neutral'}>{healthy ? 'HEALTHY' : 'NOT HEALTHY'}</Badge>
    </span>
  );
}

function buildSourceRows(p: ProvidersResponse): SourceRow[] {
  const rows: SourceRow[] = [];
  const fromSnapshot = (s: ProviderSnapshotView): SourceRow => ({
    key: s.id,
    source: s.label || venueLabel(s.id),
    feed: s.feedKind ?? DASH,
    state: s.state ?? 'UNKNOWN',
    healthy: s.healthy === true,
    pairs:
      (s.symbols ?? []).length > 0
        ? (s.symbols ?? []).join(' · ')
        : (s.symbolCount ?? 0) > 0
          ? `${number(s.symbolCount)} pairs`
          : DASH,
    lastEventAgeMs: s.lastEventAgeMs ?? null,
    events: s.events ?? 0,
    eventsPerMin: s.eventsPerMin ?? 0,
    latency: latencyText(s.latency),
    integrity: integrityText(s.book),
    note: s.note ?? DASH,
  });

  if (p.reference) rows.push(fromSnapshot(p.reference));
  for (const e of p.exchanges ?? []) rows.push(fromSnapshot(e));
  for (const id of p.pending ?? []) {
    rows.push({
      key: `pending:${id}`,
      source: venueLabel(id),
      feed: 'WEBSOCKET',
      state: 'NOT WIRED',
      healthy: false,
      pairs: DASH,
      lastEventAgeMs: null,
      events: 0,
      eventsPerMin: 0,
      latency: DASH,
      integrity: DASH,
      note: 'adapter designed but not wired — never silently enabled',
    });
  }
  for (const c of p.context ?? []) {
    rows.push({
      key: `context:${c.id}`,
      source: c.label || venueLabel(c.id),
      feed: c.feedKind ?? 'REST',
      state: c.state ?? 'UNKNOWN',
      healthy: c.healthy === true,
      pairs: DASH,
      lastEventAgeMs: c.lastFetchAgeMs ?? null,
      events: c.requests ?? 0,
      eventsPerMin: 0,
      latency: DASH,
      integrity: `${number(c.cacheEntries ?? 0)} cached`,
      note:
        c.note ??
        (c.budget ? `budget ${number(c.budget.used)}/${number(c.budget.limit)} this window` : DASH),
    });
  }
  return rows;
}

const sourceColumns: Array<Column<SourceRow>> = [
  {
    key: 'source',
    header: 'Source',
    cell: (r) => <span className="whitespace-nowrap text-xs font-semibold text-slate-soft">{r.source}</span>,
  },
  { key: 'feed', header: 'Feed', cell: (r) => <span className="font-mono text-[11px] text-mist">{r.feed}</span> },
  { key: 'status', header: 'Status', cell: (r) => <SourceStatus state={r.state} healthy={r.healthy} /> },
  { key: 'pairs', header: 'Monitored pairs', cell: (r) => <span className="font-mono text-[11px]">{r.pairs}</span> },
  {
    key: 'lastEvent',
    header: 'Last event',
    cell: (r) => (
      <span className={`whitespace-nowrap font-mono text-[11px] ${r.lastEventAgeMs == null ? 'text-mist' : 'text-slate-soft'}`}>
        {ageText(r.lastEventAgeMs)}
      </span>
    ),
  },
  { key: 'events', header: 'Events', align: 'right', cell: (r) => <span className="font-mono text-xs">{number(r.events)}</span> },
  {
    key: 'eventsPerMin',
    header: 'Events/min',
    align: 'right',
    cell: (r) => <span className="font-mono text-xs">{number(r.eventsPerMin)}</span>,
  },
  { key: 'latency', header: 'Latency p50 / p95', cell: (r) => <span className="whitespace-nowrap font-mono text-[11px]">{r.latency}</span> },
  { key: 'integrity', header: 'Data integrity', cell: (r) => <span className="whitespace-nowrap font-mono text-[11px]">{r.integrity}</span> },
  {
    key: 'note',
    header: 'Note',
    cell: (r) => <span className="block max-w-[24rem] text-[10px] leading-4 text-mist">{r.note}</span>,
  },
];

/** Per-source freshness strip — stale after the same 30s the server uses. */
function FreshnessList({ p }: { p: ProvidersResponse }) {
  const items: Array<{ label: string; age: number | null }> = [
    ...(p.reference ? [{ label: p.reference.label || venueLabel(p.reference.id), age: p.reference.lastEventAgeMs ?? null }] : []),
    ...(p.exchanges ?? []).map((e) => ({ label: e.label || venueLabel(e.id), age: e.lastEventAgeMs ?? null })),
    ...(p.context ?? []).map((c) => ({ label: c.label || venueLabel(c.id), age: c.lastFetchAgeMs ?? null })),
  ];
  if (items.length === 0) {
    return <p className="text-xs text-mist">No sources reported — nothing has connected yet.</p>;
  }
  return (
    <div className="flex flex-wrap gap-2">
      {items.map((it) => {
        const fresh = it.age !== null && Number.isFinite(it.age) && it.age <= 30_000;
        return (
          <div key={it.label} className="rounded-md border border-line bg-ink-900/70 px-2 py-1">
            <span className="font-mono text-[11px] text-slate-soft">{it.label}</span>
            <span className={`ml-2 font-mono text-[11px] ${fresh ? 'text-mint' : 'text-amber-soft'}`}>{ageText(it.age)}</span>
            <span className="ml-2 text-[10px] uppercase tracking-wider text-mist">{fresh ? 'fresh' : 'stale'}</span>
          </div>
        );
      })}
    </div>
  );
}

function providersBody(p: ProvidersResponse): ReactNode {
  const rows = buildSourceRows(p);
  return (
    <>
      <DataTable
        label="Market data sources"
        rows={rows}
        rowKey={(r) => r.key}
        columns={sourceColumns}
        empty={<p className="py-4 text-center text-xs text-mist">No sources reported — the provider registry returned no rows.</p>}
      />
      <div className="mt-3">
        <p className="mb-1.5 text-[10px] uppercase tracking-wider text-mist">Data freshness · per source</p>
        <FreshnessList p={p} />
      </div>
      <p className="mt-2 font-mono text-[11px] text-mist">
        decision impact: {p.decisionImpact ?? 'unknown'} · execution {p.executionMode ?? 'unknown'} · generated{' '}
        {time(p.generatedAt ?? null)}
      </p>
    </>
  );
}

/** /xchange body: disabled / collecting / full comparative BTC-ETH view. */
function xchangeBody(d: XchangeResponse): ReactNode {
  if (d.enabled === undefined) {
    return (
      <div className="rounded-md border border-line bg-ink-900/70 p-3">
        <Badge tone="neutral">NO DATA</Badge>
        <p className="mt-2 text-xs text-mist">The endpoint returned no payload — no cross-venue number is shown.</p>
      </div>
    );
  }
  if (d.enabled === false) {
    return (
      <div className="rounded-md border border-line bg-ink-900/70 p-3">
        <Badge tone="neutral">DISABLED</Badge>
        <p className="mt-2 text-xs text-slate-soft">{d.note ?? 'The multi-exchange layer is switched off.'}</p>
        <p className="mt-1 text-[11px] text-mist">No cross-venue numbers are shown while the layer is off — nothing is inferred.</p>
      </div>
    );
  }
  const f = d.features;
  if (!f) {
    return (
      <div className="rounded-md border border-line bg-ink-900/70 p-3">
        <Badge tone="warn">COLLECTING</Badge>
        <p className="mt-2 text-xs text-slate-soft">{d.note ?? 'No synchronized samples yet — the layer is collecting.'}</p>
        <p className="mt-1 font-mono text-[11px] text-mist">
          {d.sampleCount == null ? DASH : number(d.sampleCount)} samples in the window · monitors{' '}
          {d.monitors?.join(' · ') || DASH}
        </p>
      </div>
    );
  }

  const usd = (f.agreement ?? []).find((a) => a.quoteGroup === 'USD') ?? null;
  const windowMinutes = Math.round((d.windowMs ?? f.windowMs ?? 0) / 60_000);

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Price agreement"
          value={usd ? pctPlainAuto(usd.agreement) : DASH}
          tone={usd?.sufficient ? 'pos' : 'warn'}
          hint={usd ? `majority ${usd.majority ?? DASH} · ${number(usd.freshVenues)}/${number(usd.venues)} fresh venues` : 'no USD venue pair yet'}
        />
        <StatTile
          label="Cross-venue divergence"
          value={usd ? bpsText(usd.divergenceBps) : DASH}
          hint={usd ? `${usd.quoteGroup} quote group only — never compared across groups` : DASH}
        />
        <StatTile
          label="Confidence score"
          value={pctPlainAuto(f.confidence?.score ?? null)}
          tone={f.confidence?.sufficient ? 'info' : 'warn'}
          hint={
            f.confidence?.sufficient
              ? 'experimental, not a calibrated probability'
              : 'insufficient evidence · experimental, not a calibrated probability'
          }
        />
        <StatTile
          label="Samples in window"
          value={d.sampleCount == null ? DASH : number(d.sampleCount)}
          hint={`${windowMinutes}m window · ${d.symbol ?? f.symbol ?? DASH} · ${number((f.venues ?? []).length)} venues`}
        />
      </div>

      <div className="mt-3">
        <DataTable
          label="Venue comparison"
          rows={f.venues ?? []}
          rowKey={(r) => `${r.provider}:${r.symbol}`}
          columns={venueColumns}
          empty={<p className="py-4 text-center text-xs text-mist">No synchronized venue samples yet — the layer is collecting.</p>}
        />
      </div>

      <div className="mt-3">
        <p className="mb-1.5 text-[10px] uppercase tracking-wider text-mist">Agreement by quote group</p>
        <DataTable
          label="Agreement by quote group"
          rows={f.agreement ?? []}
          rowKey={(r) => `${r.symbol}:${r.quoteGroup}`}
          columns={agreementColumns}
          empty={<p className="py-4 text-center text-xs text-mist">No agreement rows — at least one venue pair is required.</p>}
        />
      </div>

      <div className="mt-3">
        <p className="mb-1.5 text-[10px] uppercase tracking-wider text-mist">Lead-lag vs Kraken (reference venue)</p>
        <DataTable
          label="Lead-lag versus Kraken"
          rows={f.leadLag ?? []}
          rowKey={(r) => r.provider}
          columns={leadLagColumns}
          empty={<p className="py-4 text-center text-xs text-mist">No second venue in the window — lead-lag needs two series.</p>}
        />
      </div>

      <p className="mt-2 text-[11px] text-mist">{d.note ?? DASH}</p>
    </>
  );
}

const venueColumns: Array<Column<VenueWindowView>> = [
  { key: 'provider', header: 'Venue', cell: (r) => <span className="whitespace-nowrap text-xs font-semibold text-slate-soft">{venueLabel(r.provider)}</span> },
  { key: 'quote', header: 'Quote', cell: (r) => <span className="font-mono text-[11px] text-mist">{r.quote}</span> },
  { key: 'samples', header: 'Samples', align: 'right', cell: (r) => <span className="font-mono text-xs">{number(r.samples)}</span> },
  { key: 'mid', header: 'Mid', align: 'right', cell: (r) => <span className="font-mono text-xs">{number(r.lastMid)}</span> },
  { key: 'spread', header: 'Spread', align: 'right', cell: (r) => <span className="font-mono text-xs">{bpsText(r.spreadBps)}</span> },
  {
    key: 'return',
    header: 'Window return',
    align: 'right',
    cell: (r) => <span className={`font-mono text-xs ${r.returnPct == null ? 'text-mist' : toneClass(r.returnPct)}`}>{r.returnPct == null ? DASH : pctPlain(r.returnPct)}</span>,
  },
  { key: 'taker', header: 'Taker buy', align: 'right', cell: (r) => <span className="font-mono text-xs text-mist">{pctPlainAuto(r.takerBuyPct)}</span> },
  {
    key: 'fresh',
    header: 'Freshness',
    cell: (r) => <Badge tone={r.fresh ? 'pos' : 'warn'}>{r.fresh ? 'FRESH' : 'STALE'}</Badge>,
  },
];

const agreementColumns: Array<Column<AgreementView>> = [
  { key: 'group', header: 'Quote group', cell: (r) => <span className="font-mono text-xs font-semibold text-slate-soft">{r.quoteGroup}</span> },
  {
    key: 'venues',
    header: 'Venues',
    align: 'right',
    cell: (r) => (
      <span className="font-mono text-xs">
        {number(r.freshVenues)}
        <span className="text-mist"> / {number(r.venues)}</span>
      </span>
    ),
  },
  { key: 'agreement', header: 'Agreement', align: 'right', cell: (r) => <span className="font-mono text-xs">{pctPlainAuto(r.agreement)}</span> },
  { key: 'majority', header: 'Majority', cell: (r) => <Badge tone={r.majority === 'UP' ? 'pos' : r.majority === 'DOWN' ? 'neg' : 'neutral'}>{r.majority ?? 'FLAT'}</Badge> },
  {
    key: 'reference',
    header: 'Kraken agrees',
    cell: (r) => <span className="font-mono text-xs text-mist">{r.referenceAgrees == null ? DASH : r.referenceAgrees ? 'yes' : 'no'}</span>,
  },
  { key: 'divergence', header: 'Divergence', align: 'right', cell: (r) => <span className="font-mono text-xs">{bpsText(r.divergenceBps)}</span> },
  {
    key: 'evidence',
    header: 'Evidence',
    cell: (r) => <Badge tone={r.sufficient ? 'pos' : 'warn'}>{r.sufficient ? 'SUFFICIENT' : 'INSUFFICIENT'}</Badge>,
  },
];

const leadLagColumns: Array<Column<LeadLagView>> = [
  { key: 'provider', header: 'Venue', cell: (r) => <span className="whitespace-nowrap text-xs font-semibold text-slate-soft">{venueLabel(r.provider)}</span> },
  { key: 'bestLag', header: 'Best lag (samples)', align: 'right', cell: (r) => <span className="font-mono text-xs">{r.bestLag == null ? DASH : number(r.bestLag)}</span> },
  { key: 'corrBest', header: 'Corr @ best lag', align: 'right', cell: (r) => <span className="font-mono text-xs">{corrText(r.corrBestLag)}</span> },
  { key: 'corr0', header: 'Corr @ lag 0', align: 'right', cell: (r) => <span className="font-mono text-xs text-mist">{corrText(r.corrLag0)}</span> },
  { key: 'n', header: 'Pairs', align: 'right', cell: (r) => <span className="font-mono text-xs">{number(r.n)}</span> },
  {
    key: 'evidence',
    header: 'Evidence',
    cell: (r) => <Badge tone={r.sufficient ? 'pos' : 'warn'}>{r.sufficient ? 'SUFFICIENT' : 'INSUFFICIENT'}</Badge>,
  },
];

const horizonColumns: Array<Column<SourceHorizonView>> = [
  { key: 'horizon', header: 'Horizon', cell: (r) => <span className="font-mono text-xs font-semibold text-slate-soft">{r.horizon}</span> },
  {
    key: 'status',
    header: 'Status',
    cell: (r) => (
      <div>
        <Badge tone={r.status === 'OK' ? 'pos' : 'warn'}>{r.status ?? 'UNKNOWN'}</Badge>
        {r.status !== 'OK' && (
          <p className="mt-1 max-w-[20rem] text-[10px] leading-4 text-mist">{r.note || 'no note returned'}</p>
        )}
      </div>
    ),
  },
  { key: 'testRows', header: 'Test rows', align: 'right', cell: (r) => <span className="font-mono text-xs">{number(r.testRows)}</span> },
  {
    key: 'baseline',
    header: 'Baseline bal. acc',
    align: 'right',
    cell: (r) => <span className="font-mono text-xs text-mist">{pctPlain(r.baseline?.balancedAccuracyPct)}</span>,
  },
  {
    key: 'krakenOnly',
    header: 'Kraken only',
    align: 'right',
    cell: (r) => <span className="font-mono text-xs">{pctPlain(r.krakenOnly?.balancedAccuracyPct)}</span>,
  },
  {
    key: 'krakenPlusCoinbase',
    header: 'Kraken + Coinbase',
    align: 'right',
    cell: (r) => <span className="font-mono text-xs text-mint">{pctPlain(r.krakenPlusCoinbase?.balancedAccuracyPct)}</span>,
  },
  {
    key: 'delta',
    header: 'Δ bal. acc',
    align: 'right',
    cell: (r) => {
      const v = r.incremental?.balancedAccuracyDeltaPct ?? null;
      return <span className={`font-mono text-xs ${v == null ? 'text-mist' : toneClass(v)}`}>{pct(v)}</span>;
    },
  },
  {
    key: 'brier',
    header: 'Δ Brier',
    align: 'right',
    cell: (r) => <span className="font-mono text-xs text-mist">{decimals(r.incremental?.brierDelta ?? null, 4)}</span>,
  },
];

function sourcesBody(d: SourcesResponse): ReactNode {
  const horizons = d.horizons ?? [];
  const statusTone: Tone = d.status === 'OK' ? 'pos' : d.status === 'NO_DATA' ? 'neutral' : 'warn';
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={statusTone}>{d.status ?? 'UNKNOWN'}</Badge>
        <span className="text-xs text-slate-soft">{d.note ?? 'The endpoint returned no study note.'}</span>
        <span className="font-mono text-[11px] text-mist">
          symbol {d.symbol ?? DASH} · window {d.windowMs == null ? DASH : `${Math.round(d.windowMs / 60_000)}m`} ·
          generated {time(d.generatedAt ?? null)}
        </span>
      </div>
      <div className="mt-3">
        <DataTable
          label="Experimental model predictions by horizon"
          rows={horizons}
          rowKey={(r) => r.horizon}
          columns={horizonColumns}
          empty={
            <p className="py-4 text-center text-xs text-mist">
              No horizon rows returned — nothing is evaluated, and nothing is inferred here.
            </p>
          }
        />
      </div>
    </>
  );
}

const accuracyColumns: Array<Column<AccuracyHorizonView>> = [
  { key: 'key', header: 'Horizon', cell: (r) => <span className="font-mono text-xs font-semibold text-slate-soft">{r.key}</span> },
  { key: 'source', header: 'Outcome source', cell: (r) => <span className="font-mono text-[11px] text-mist">{r.source}</span> },
  { key: 'evaluated', header: 'Evaluated', align: 'right', cell: (r) => <span className="font-mono text-xs">{number(r.evaluated)}</span> },
  {
    key: 'overall',
    header: 'Overall',
    align: 'right',
    cell: (r) => <span className="font-mono text-xs">{pctPlainAuto(r.accuracy?.overall?.pct)}</span>,
  },
  { key: 'buy', header: 'BUY', align: 'right', cell: (r) => <span className="font-mono text-xs">{pctPlainAuto(r.accuracy?.BUY?.pct)}</span> },
  { key: 'sell', header: 'SELL', align: 'right', cell: (r) => <span className="font-mono text-xs">{pctPlainAuto(r.accuracy?.SELL?.pct)}</span> },
  {
    key: 'balance',
    header: 'Class balance (UP)',
    align: 'right',
    cell: (r) => (
      <span className="font-mono text-xs text-mist">
        {pctPlainAuto(r.classBalance?.upPct)}
        <span className="text-mist/70"> · {number(r.classBalance?.up)}/{number(r.classBalance?.down)}</span>
      </span>
    ),
  },
  {
    key: 'alwaysUp',
    header: 'Always-UP baseline',
    align: 'right',
    cell: (r) => <span className="font-mono text-xs text-mist">{pctPlainAuto(r.baselines?.alwaysUp?.pct)}</span>,
  },
  {
    key: 'persistence',
    header: 'Persistence baseline',
    align: 'right',
    cell: (r) => <span className="font-mono text-xs text-mist">{pctPlainAuto(r.baselines?.persistence?.pct)}</span>,
  },
  { key: 'noData', header: 'No data', align: 'right', cell: (r) => <span className="font-mono text-xs text-mist">{number(r.noData)}</span> },
];

function accuracyBody(d: AccuracyResponse): ReactNode {
  const rows = d.horizons ?? [];
  const longest = rows.length > 0 ? rows[rows.length - 1] : null;
  return (
    <>
      <p className="text-xs text-slate-soft">
        Validated on actual trade outcomes — every row scores the signal against the price observed at or after its
        horizon, never before.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <StatTile
          label="Signals evaluated"
          value={d.signals ? number(d.signals.total) : DASH}
          hint={d.signals ? `BUY ${number(d.signals.BUY)} · SELL ${number(d.signals.SELL)}` : 'no signal count in payload'}
        />
        <StatTile
          label="Horizons measured"
          value={rows.length > 0 ? number(rows.length) : DASH}
          tone={rows.length > 0 ? 'pos' : 'warn'}
        />
        <StatTile label="Longest horizon" value={longest ? longest.key : DASH} hint={longest ? `${longest.source} · ${number(longest.evaluated)} evaluated` : 'no horizon data yet'} />
      </div>
      <div className="mt-3">
        <DataTable
          label="Fixed-horizon accuracy"
          rows={rows}
          rowKey={(r) => r.key}
          columns={accuracyColumns}
          empty={<p className="py-4 text-center text-xs text-mist">No fixed-horizon rows yet — outcomes accumulate as signals mature.</p>}
        />
      </div>
      <p className="mt-2 text-[11px] leading-4 text-mist">{d.note ?? DASH}</p>
    </>
  );
}

const XCHANGE_SYMBOLS = ['BTC', 'ETH'];

function MarketIntelligence() {
  const providers = useEndpoint<ProvidersResponse>('/providers', getProviders);
  const sources = useEndpoint<SourcesResponse>('/sources', getSources);
  const accuracy = useEndpoint<AccuracyResponse>('/accuracy', getAccuracy);
  const context = useEndpoint<ContextResponse>('/context', getContext);
  const [symbol, setSymbol] = useState<string>('BTC');
  const xchange = useEndpoint<XchangeResponse>(`/xchange?symbol=${symbol}&window=3600000`, () => getXchange(symbol));

  return (
    <section aria-labelledby="xchange-heading" className="space-y-4 pt-2">
      <div>
        <h2 id="xchange-heading" className="text-sm font-semibold uppercase tracking-[0.12em] text-slate-soft">
          MULTI-EXCHANGE MARKET INTELLIGENCE
        </h2>
        <p className="mt-1 text-xs text-mist">
          Research-only observation plane: provider status, cross-venue features and source-contribution studies.
          Decision impact is NONE — nothing here reaches the trading path.
        </p>
      </div>

      <Caption>LIVE MARKET-DATA OBSERVATIONS</Caption>
      <Block
        ep={providers}
        title="Live sources"
        label="source status"
        subtitle="Kraken (the production feed) first, then connected venues, then venues designed but NOT WIRED and any lower-frequency context source. Status is transport; health needs fresh valid data."
        children={providersBody}
      />

      {context.error !== null && context.data === undefined ? (
        <p className="text-[11px] text-danger">Context sources: {context.error}</p>
      ) : context.data !== undefined ? (
        <p className="text-[11px] text-mist">
          <span className="uppercase tracking-wider">Context sources — </span>
          {context.data.enabled === true
            ? `${number((context.data.sources ?? []).length)} enabled · ${number(context.data.cacheEntries ?? 0)} cached entries`
            : context.data.enabled === false
              ? context.data.note ?? 'disabled'
              : 'no payload returned'}
        </p>
      ) : null}

      <Block
        ep={xchange}
        title={`Comparative view · ${symbol}`}
        label="cross-venue features"
        subtitle="Per-venue top-of-book, agreement, divergence, lead-lag vs Kraken and the experimental confidence score — same synchronized window for every venue."
        actions={
          <div className="flex gap-1">
            {XCHANGE_SYMBOLS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSymbol(s)}
                aria-pressed={s === symbol}
                className={`rounded-md border px-2 py-1 font-mono text-[11px] ${
                  s === symbol ? 'border-mint/60 bg-ink-700 text-mint' : 'border-line bg-ink-800 text-slate-soft hover:border-mint/40'
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        }
        children={xchangeBody}
      />

      <Caption>EXPERIMENTAL MODEL PREDICTIONS</Caption>
      <Block
        ep={sources}
        title="Source contribution by horizon"
        label="source contribution"
        subtitle="Walk-forward comparison of balanced accuracy: baseline vs Kraken only vs Kraken + Coinbase. Research-only — these are model readings, not trade instructions, and a horizon without enough rows reports INSUFFICIENT_DATA instead of a number."
        children={sourcesBody}
      />

      <Caption>VALIDATED RESULTS</Caption>
      <Block
        ep={accuracy}
        title="Fixed-horizon accuracy"
        label="validated accuracy"
        subtitle="Outcome measured at a fixed horizon after each signal, against always-UP / persistence baselines."
        children={accuracyBody}
      />
    </section>
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
      <Caption>EXISTING TRADING & LEARNING RESULTS</Caption>
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

      <MarketIntelligence />
    </div>
  );
}