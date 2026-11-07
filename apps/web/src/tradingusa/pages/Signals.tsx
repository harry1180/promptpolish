/**
 * Signals — filterable immutable-signal table plus the per-signal detail
 * route (/tradingusa/signals/:id) with evidence, contradictions, score
 * breakdown, audit reconstruction and the immutability note.
 */

import { useEffect, useState } from 'react';
import { getSignal, getSignals } from '../api';
import type { EvidenceItem, SignalDetail, SignalRow, SignalsResponse } from '../api';
import { Link, navigateTo, useEndpoint } from '../data';
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
  MeterBar,
  StatTile,
  dateText,
  flex,
  money,
  norm01,
  number,
  pct,
  time,
  toneClass,
} from '../ui';

const SIGNAL_COLUMNS = [
  {
    key: 'ticker',
    header: 'Ticker',
    sortValue: (r: SignalRow) => r.ticker,
    cell: (r: SignalRow) => <span className="font-mono font-semibold text-mint">{r.ticker}</span>,
  },
  { key: 'company', header: 'Company', sortValue: (r: SignalRow) => r.company, cell: (r: SignalRow) => <span className="text-xs text-slate-soft">{r.company}</span> },
  { key: 'signal', header: 'Signal', sortValue: (r: SignalRow) => r.signal, cell: (r: SignalRow) => <Badge tone={r.signal === 'BUY' ? 'pos' : r.signal === 'SELL' ? 'neg' : 'info'}>{r.signal}</Badge> },
  { key: 'horizon', header: 'Horizon', cell: (r: SignalRow) => <span className="text-xs text-mist">{r.horizon}</span> },
  { key: 'confidence', header: 'Confidence', align: 'right' as const, sortValue: (r: SignalRow) => r.confidence, cell: (r: SignalRow) => <div className="flex justify-end"><ConfidenceBar value={r.confidence} /></div> },
  { key: 'price', header: 'Price', align: 'right' as const, sortValue: (r: SignalRow) => r.price, cell: (r: SignalRow) => <span className="font-mono">{money(r.price)}</span> },
  { key: 'entry', header: 'Entry', align: 'right' as const, sortValue: (r: SignalRow) => r.entryLow, cell: (r: SignalRow) => <span className="font-mono">{r.entryLow === null || r.entryHigh === null ? '—' : `${money(r.entryLow)}–${money(r.entryHigh)}`}</span> },
  { key: 'target', header: 'Target', align: 'right' as const, sortValue: (r: SignalRow) => r.target, cell: (r: SignalRow) => <span className="font-mono">{money(r.target)}</span> },
  { key: 'invalidations', header: 'Invalidations', align: 'right' as const, sortValue: (r: SignalRow) => r.invalidation, cell: (r: SignalRow) => <span className="font-mono text-danger">{money(r.invalidation)}</span> },
  { key: 'expected', header: 'Expected Return', align: 'right' as const, sortValue: (r: SignalRow) => r.expectedReturnPct, cell: (r: SignalRow) => <span className={`font-mono ${toneClass(r.expectedReturnPct)}`}>{pct(r.expectedReturnPct)}</span> },
  { key: 'risk', header: 'Risk', align: 'right' as const, sortValue: (r: SignalRow) => r.riskReward, cell: (r: SignalRow) => <span className="font-mono">{number(r.riskReward)}</span> },
  { key: 'strategy', header: 'Strategy', cell: (r: SignalRow) => <span className="text-xs text-mist">{r.strategy}</span> },
  { key: 'created', header: 'Created', sortValue: (r: SignalRow) => (typeof r.createdAt === 'number' ? r.createdAt : 0), cell: (r: SignalRow) => <span className="font-mono text-xs text-mist">{time(r.createdAt)}</span> },
  { key: 'status', header: 'Status', cell: (r: SignalRow) => <Badge tone={r.status === 'ACTIVE' ? 'pos' : r.status === 'EXPIRED' ? 'neutral' : 'info'}>{r.status}</Badge> },
];

function selectClass(): string {
  return 'rounded-md border border-line bg-ink-800 px-2 py-1 text-xs text-slate-soft';
}

export function SignalsPage() {
  const [portfolio, setPortfolio] = useState('');
  const [signal, setSignal] = useState('');
  const [strategy, setStrategy] = useState('');
  const [horizon, setHorizon] = useState('');
  const [confidenceMin, setConfidenceMin] = useState(0);

  const query = new URLSearchParams();
  if (portfolio) query.set('portfolio', portfolio);
  if (signal) query.set('signal', signal);
  if (strategy) query.set('strategy', strategy);
  if (horizon) query.set('horizon', horizon);
  if (confidenceMin > 0) query.set('confidenceMin', String(confidenceMin));
  query.set('limit', '200');
  const path = `/signals?${query.toString()}`;

  const ep = useEndpoint<SignalsResponse>(path, () =>
    getSignals({
      portfolio: portfolio || undefined,
      signal: signal || undefined,
      strategy: strategy || undefined,
      horizon: horizon || undefined,
      confidenceMin: confidenceMin > 0 ? confidenceMin : undefined,
      limit: 200,
    }),
  );

  if (ep.data === undefined) {
    return ep.error ? <ErrorState message={ep.error} onRetry={ep.reload} /> : <Loading label="Loading signals…" />;
  }

  const rows = ep.data.signals ?? [];

  return (
    <div className="space-y-4">
      <Card title="Filters" subtitle="Server-side filtering — every row is an immutable published signal.">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wider text-mist">
            Portfolio
            <select className={selectClass()} value={portfolio} onChange={(e) => setPortfolio(e.target.value)}>
              <option value="">All portfolios</option>
              <option value="SHORT_TERM_PORTFOLIO">Short-term</option>
              <option value="LONG_TERM_PORTFOLIO">Long-term</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wider text-mist">
            Signal type
            <select className={selectClass()} value={signal} onChange={(e) => setSignal(e.target.value)}>
              <option value="">All signals</option>
              <option value="BUY">BUY</option>
              <option value="SELL">SELL</option>
              <option value="WATCH">WATCH</option>
              <option value="EXIT">EXIT</option>
              <option value="HOLD">HOLD</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wider text-mist">
            Strategy
            <input
              className={`${selectClass()} w-40`}
              value={strategy}
              placeholder="any strategy"
              onChange={(e) => setStrategy(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wider text-mist">
            Horizon
            <select className={selectClass()} value={horizon} onChange={(e) => setHorizon(e.target.value)}>
              <option value="">Any horizon</option>
              <option value="SHORT_TERM">SHORT_TERM</option>
              <option value="LONG_TERM">LONG_TERM</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wider text-mist">
            Min confidence {pct(confidenceMin * 100)}
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={confidenceMin}
              onChange={(e) => setConfidenceMin(Number(e.target.value))}
              aria-label="Minimum confidence"
              className="w-40 accent-mint"
            />
          </label>
          <span className="ml-auto font-mono text-xs text-mist">
            {rows.length} of {number(ep.data.total)} shown
          </span>
        </div>
      </Card>

      <Card title="Signals">
        <DataTable
          label="Signals"
          rows={rows}
          columns={SIGNAL_COLUMNS}
          rowKey={(r) => r.id}
          onRowClick={(r) => navigateTo(`/tradingusa/signals/${r.id}`)}
          empty={<EmptyState title="No signals match">Loosen the filters — or no signal has been published yet.</EmptyState>}
        />
      </Card>
    </div>
  );
}

function EvidenceList({ title, items, tone }: { title: string; items: EvidenceItem[]; tone: 'pos' | 'neg' }) {
  return (
    <Card title={title}>
      {items.length === 0 ? (
        <p className="text-xs text-mist">none recorded</p>
      ) : (
        <ul className="space-y-2">
          {items.map((e, i) => (
            <li key={i} className="flex items-start gap-2 border-b border-line/60 pb-2 last:border-b-0">
              <span className={tone === 'pos' ? 'text-mint' : 'text-danger'} aria-hidden>
                {tone === 'pos' ? '▲' : '▼'}
              </span>
              <div className="min-w-0">
                <p className="text-sm text-slate-soft">{e.title ?? e.text ?? e.detail ?? flex(e)}</p>
                <p className="mt-0.5 font-mono text-[11px] text-mist">
                  {e.source ? `source: ${e.source}` : ''}
                  {e.weight !== null && e.weight !== undefined ? `${e.source ? ' · ' : ''}weight: ${number(e.weight)}` : ''}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function SignalDetailPage({ signalId }: { signalId: string }) {
  const ep = useEndpoint<SignalDetail>(`/signals/${signalId}`, () => getSignal(signalId));

  useEffect(() => {
    // nothing to clean up: the endpoint hook owns the polling lifecycle
  }, []);

  if (ep.data === undefined) {
    return ep.error ? <ErrorState message={ep.error} onRetry={ep.reload} /> : <Loading label="Loading signal…" />;
  }
  const s = ep.data;
  const scoreEntries = Object.entries(s.scores ?? {}).filter(([, v]) => typeof v === 'number');

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link to="/tradingusa/signals" className="text-xs text-mist hover:text-mint">
          &larr; Back to Signals
        </Link>
        <h2 className="font-mono text-xl font-semibold text-slate-soft">
          {s.ticker} <span className="text-mist">·</span> {s.company}
        </h2>
        <Badge tone={s.signal === 'BUY' ? 'pos' : s.signal === 'SELL' ? 'neg' : 'info'}>{s.signal}</Badge>
        <Badge tone={s.status === 'ACTIVE' ? 'pos' : 'neutral'}>{s.status}</Badge>
        <Badge tone="info">{s.portfolio}</Badge>
        <Badge tone="neutral">{s.horizon}</Badge>
        <span className="font-mono text-[11px] text-mist">id {s.id}</span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Price" value={money(s.price)} />
        <StatTile label="Entry" value={s.entryLow === null || s.entryHigh === null ? '—' : `${money(s.entryLow)}–${money(s.entryHigh)}`} />
        <StatTile label="Target" value={money(s.target)} tone="pos" />
        <StatTile label="Invalidation" value={money(s.invalidation)} tone="neg" />
        <StatTile label="Confidence" value={<ConfidenceBar value={s.confidence} />} />
        <StatTile label="Expected return" value={pct(s.expectedReturnPct)} tone={toneClass(s.expectedReturnPct) as 'pos' | 'neg' | 'info' | 'warn' | 'neutral'} />
        <StatTile label="Risk / reward" value={number(s.riskReward)} />
        <StatTile label="Created" value={<span className="text-sm">{time(s.createdAt)}</span>} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <EvidenceList title="Evidence" items={s.evidence ?? []} tone="pos" />
        <EvidenceList title="Contradictions" items={s.contradictions ?? []} tone="neg" />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Score breakdown" subtitle="Seven weighted inputs frozen at generation time.">
          <div className="space-y-1.5">
            {scoreEntries.length === 0 ? (
              <p className="text-xs text-mist">no scores recorded</p>
            ) : (
              scoreEntries.map(([k, v]) => (
                <HBar
                  key={k}
                  label={k}
                  value={norm01(v as number) * 100}
                  display={`${Math.round(norm01(v as number) * 100)}%`}
                  tone={norm01(v as number) >= 0.7 ? 'pos' : norm01(v as number) >= 0.45 ? 'warn' : 'neg'}
                  max={100}
                />
              ))
            )}
          </div>
        </Card>

        <Card title="Context">
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between gap-3">
              <dt className="text-mist">Regime</dt>
              <dd className="text-slate-soft">{s.regime ?? '—'}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-mist">Data freshness</dt>
              <dd className="font-mono text-slate-soft">{s.dataFreshness === null || s.dataFreshness === undefined ? '—' : number(s.dataFreshness)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-mist">Market session</dt>
              <dd className="text-slate-soft">{s.marketSession ?? '—'}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-mist">Strategy version</dt>
              <dd className="font-mono text-slate-soft">{s.strategyVersion ?? '—'}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-mist">Model version</dt>
              <dd className="font-mono text-slate-soft">{s.modelVersion ?? '—'}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-mist">Strategy</dt>
              <dd className="font-mono text-slate-soft">{s.strategy ?? '—'}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-mist">Session</dt>
              <dd className="text-slate-soft">{s.session ?? '—'}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-mist">Sector</dt>
              <dd className="text-slate-soft">{s.sector ?? '—'}</dd>
            </div>
          </dl>
          <div className="mt-3 space-y-2">
            <div>
              <div className="text-[10px] uppercase tracking-wider text-mist">Event references</div>
              <div className="mt-1 flex flex-wrap gap-1">
                {(s.eventRefs ?? []).length === 0 ? (
                  <span className="text-xs text-mist">none</span>
                ) : (
                  (s.eventRefs ?? []).map((r) => (
                    <Badge key={r.id} tone="info">
                      {r.type ?? 'EVENT'} {r.ticker ?? ''}
                    </Badge>
                  ))
                )}
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wider text-mist">Knowledge references</div>
              <Chips items={(s.knowledgeRefs ?? []).map((r) => r.title ?? r.id)} />
            </div>
          </div>
        </Card>

        <Card title="LLM usage">
          {s.llm && s.llm.used ? (
            <div className="space-y-1 text-sm">
              <p className="text-mint">LLM used for this signal</p>
              <p className="text-xs text-mist">
                provider <span className="font-mono text-slate-soft">{s.llm.provider ?? '—'}</span> · task{' '}
                <span className="font-mono text-slate-soft">{s.llm.task ?? '—'}</span>
              </p>
              {s.llm.summary && <p className="text-xs text-slate-soft">{s.llm.summary}</p>}
            </div>
          ) : (
            <p className="text-xs text-mist">No LLM call contributed to this signal — it came from local rules only.</p>
          )}
        </Card>
      </div>

      <Card title="Audit reconstruction" subtitle="Inputs and risk checks recorded when the signal was generated.">
        <div className="grid gap-4 lg:grid-cols-2">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-mist">Generated at</div>
            <div className="font-mono text-sm text-slate-soft">{time(s.audit?.generatedAt ?? null)}</div>
            <div className="mt-2 text-[10px] uppercase tracking-wider text-mist">Inputs</div>
            <dl className="mt-1 space-y-1 text-xs">
              {Object.entries(s.audit?.inputs ?? {}).length === 0 ? (
                <p className="text-mist">no input snapshot recorded</p>
              ) : (
                Object.entries(s.audit?.inputs ?? {}).map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-3">
                    <dt className="text-mist">{k}</dt>
                    <dd className="font-mono text-slate-soft">{flex(v)}</dd>
                  </div>
                ))
              )}
            </dl>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wider text-mist">Risk checks</div>
            <ul className="mt-1 space-y-1 text-xs">
              {(s.audit?.riskChecks ?? []).length === 0 ? (
                <li className="text-mist">no risk checks recorded</li>
              ) : (
                (s.audit?.riskChecks ?? []).map((c, i) => (
                  <li key={i} className="flex items-start gap-2 border-b border-line/60 pb-1">
                    <Badge tone={c.passed ? 'pos' : 'neg'}>{c.passed ? 'PASS' : 'FAIL'}</Badge>
                    <span className="text-slate-soft">{c.check ?? flex(c)}</span>
                    {c.detail && <span className="ml-auto text-mist">{c.detail}</span>}
                  </li>
                ))
              )}
            </ul>
          </div>
        </div>
        <div className="mt-3">
          <MeterBar value={s.confidence === null ? null : norm01(s.confidence) * 100} width="w-full" />
          <p className="mt-1 text-[11px] text-mist">
            confidence {pct(s.confidence === null ? null : norm01(s.confidence) * 100)} · created {dateText(String(s.createdAt ?? ''))}
          </p>
        </div>
        <p className="mt-3 rounded-md border border-line bg-ink-900/70 px-3 py-2 text-xs text-mist">
          <span className="font-semibold uppercase tracking-wide text-slate-soft">Immutable record.</span> Timestamp,
          price, target, invalidation, confidence, evidence and versions are frozen server-side the moment the signal
          is created — lifecycle status changes never rewrite the prediction.
        </p>
      </Card>
    </div>
  );
}