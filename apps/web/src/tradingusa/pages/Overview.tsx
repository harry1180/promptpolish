/**
 * Overview — the dashboard home: paper banner, session + regime, index
 * quotes, breadth/VIX, the "WHAT IF I FOLLOWED EVERY SIGNAL?" ledger,
 * portfolio cards vs SPY, opportunities, risk alerts, events, positions,
 * P&L, daily activity tiles and the daily review strip.
 */

import { getChart, getOverview, getReviews } from '../api';
import type { ChartResponse, OverviewResponse, PortfolioSummary, ReviewsResponse, SignalRow, WhatIf } from '../api';
import { Link, navigateTo, useEndpoint } from '../data';
import {
  Badge,
  Card,
  ConfidenceBar,
  DataTable,
  EmptyState,
  ErrorState,
  HBar,
  LineChart,
  Loading,
  MeterBar,
  SessionBadge,
  Sparkline,
  StatTile,
  dateText,
  flex,
  money,
  number,
  pct,
  pctPlain,
  time,
  toneClass,
} from '../ui';
import type { ReactNode } from 'react';

function QuoteCard({ symbol, change, price, spark }: { symbol: string; change: number | null; price: number | null; spark: number[] }) {
  return (
    <div className="card p-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-sm font-semibold text-slate-soft">{symbol}</span>
        <span className={`font-mono text-sm ${toneClass(change)}`}>{pct(change)}</span>
      </div>
      <div className="mt-1 flex items-end justify-between gap-2">
        <span className="font-mono text-lg text-slate-soft">{money(price)}</span>
        <Sparkline values={spark} ariaLabel={`${symbol} 1 month trend`} tone={change !== null && change < 0 ? 'neg' : 'pos'} />
      </div>
    </div>
  );
}

function WhatIfCard({ whatIf }: { whatIf: Partial<WhatIf> | undefined }) {
  const w = whatIf ?? {};
  const rows: Array<{ label: string; value: ReactNode; tone?: string }> = [
    { label: 'Starting Capital', value: money(w.startingCapital ?? null) },
    { label: 'Current Equity', value: money(w.currentEquity ?? null) },
    { label: 'Paper Profit', value: money(w.paperProfit ?? null), tone: toneClass(w.paperProfit ?? null) },
    { label: 'TradingUSA Return', value: pct(w.tradingusaReturnPct ?? null), tone: toneClass(w.tradingusaReturnPct ?? null) },
    { label: 'SPY Return', value: pct(w.spyReturnPct ?? null), tone: toneClass(w.spyReturnPct ?? null) },
    { label: 'Excess Return', value: pct(w.excessReturnPct ?? null), tone: toneClass(w.excessReturnPct ?? null) },
    { label: 'Trades', value: number(w.trades ?? null) },
    { label: 'Wins', value: number(w.wins ?? null) },
    { label: 'Losses', value: number(w.losses ?? null) },
    { label: 'Other', value: number(w.other ?? null) },
    { label: 'Win Rate', value: pctPlain(w.winRatePct ?? null) },
    { label: 'Max Drawdown', value: pct(w.maxDrawdownPct ?? null), tone: toneClass(w.maxDrawdownPct ?? null) },
  ];
  return (
    <Card
      title="WHAT IF I FOLLOWED EVERY SIGNAL?"
      subtitle="Hypothetical paper ledger — every published signal taken at its stated entry, no cherry-picking."
      className="border-mint/30"
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {rows.map((r) => (
          <div key={r.label} className="rounded-md border border-line bg-ink-900/70 px-3 py-2">
            <div className="text-[10px] uppercase tracking-wider text-mist">{r.label}</div>
            <div className={`mt-0.5 font-mono text-base ${r.tone ?? 'text-slate-soft'}`}>{r.value}</div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function PortfolioCard({ p }: { p: PortfolioSummary }) {
  const label = p.kind === 'SHORT_TERM_PORTFOLIO' ? 'Short-term portfolio' : p.kind === 'LONG_TERM_PORTFOLIO' ? 'Long-term portfolio' : p.kind;
  const ceiling = Math.max(Math.abs(p.totalReturnPct ?? 0), Math.abs(p.benchmarkReturnPct ?? 0), 1);
  return (
    <Card title={label} subtitle={`equity ${money(p.equity)} · start ${money(p.startCapital)}`}>
      <div className="space-y-1">
        <HBar
          label="Strategy return"
          value={p.totalReturnPct ?? 0}
          display={pct(p.totalReturnPct)}
          tone={p.totalReturnPct !== null && p.totalReturnPct >= 0 ? 'pos' : 'neg'}
          max={ceiling}
        />
        <HBar
          label="SPY return"
          value={p.benchmarkReturnPct ?? 0}
          display={pct(p.benchmarkReturnPct)}
          tone="info"
          max={ceiling}
        />
        <HBar
          label="Excess return"
          value={p.excessReturnPct ?? 0}
          display={pct(p.excessReturnPct)}
          tone={p.excessReturnPct !== null && p.excessReturnPct >= 0 ? 'pos' : 'neg'}
          max={ceiling}
        />
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 border-t border-line pt-2 text-xs">
        <div>
          <div className="text-[10px] uppercase text-mist">Trades</div>
          <div className="font-mono text-slate-soft">{number(p.trades)}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase text-mist">Win rate</div>
          <div className="font-mono text-slate-soft">{pctPlain(p.winRatePct)}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase text-mist">Max DD</div>
          <div className="font-mono text-slate-soft">{pct(p.maxDrawdownPct)}</div>
        </div>
      </div>
    </Card>
  );
}

const OPPORTUNITY_COLUMNS = [
  {
    key: 'ticker',
    header: 'Ticker',
    sortValue: (r: SignalRow) => r.ticker,
    cell: (r: SignalRow) => (
      <Link to={`/tradingusa/signals/${r.id}`} className="font-mono font-semibold text-mint hover:underline">
        {r.ticker}
      </Link>
    ),
  },
  { key: 'signal', header: 'Signal', sortValue: (r: SignalRow) => r.signal, cell: (r: SignalRow) => <Badge tone={r.signal === 'BUY' ? 'pos' : r.signal === 'SELL' ? 'neg' : 'neutral'}>{r.signal}</Badge> },
  { key: 'horizon', header: 'Horizon', cell: (r: SignalRow) => <span className="text-xs text-mist">{r.horizon}</span> },
  { key: 'confidence', header: 'Confidence', align: 'right' as const, sortValue: (r: SignalRow) => r.confidence, cell: (r: SignalRow) => <div className="flex justify-end"><ConfidenceBar value={r.confidence} /></div> },
  { key: 'price', header: 'Price', align: 'right' as const, sortValue: (r: SignalRow) => r.price, cell: (r: SignalRow) => <span className="font-mono">{money(r.price)}</span> },
  { key: 'target', header: 'Target', align: 'right' as const, sortValue: (r: SignalRow) => r.target, cell: (r: SignalRow) => <span className="font-mono">{money(r.target)}</span> },
  { key: 'expected', header: 'Expected return', align: 'right' as const, sortValue: (r: SignalRow) => r.expectedReturnPct, cell: (r: SignalRow) => <span className={`font-mono ${toneClass(r.expectedReturnPct)}`}>{pct(r.expectedReturnPct)}</span> },
  { key: 'strategy', header: 'Strategy', cell: (r: SignalRow) => <span className="text-xs text-mist">{r.strategy}</span> },
  { key: 'status', header: 'Status', cell: (r: SignalRow) => <Badge tone={r.status === 'ACTIVE' ? 'pos' : 'neutral'}>{r.status}</Badge> },
];

export function OverviewPage() {
  const ov = useEndpoint<OverviewResponse>('/overview', getOverview);
  const reviews = useEndpoint<ReviewsResponse>('/reviews', getReviews);
  const spy = useEndpoint<ChartResponse>('/chart?symbol=SPY&range=1mo', () => getChart('SPY', '1mo'));
  const qqq = useEndpoint<ChartResponse>('/chart?symbol=QQQ&range=1mo', () => getChart('QQQ', '1mo'));
  const dia = useEndpoint<ChartResponse>('/chart?symbol=DIA&range=1mo', () => getChart('DIA', '1mo'));

  if (ov.data === undefined) {
    return ov.error ? <ErrorState message={ov.error} onRetry={ov.reload} /> : <Loading label="Loading overview…" />;
  }
  const d = ov.data;
  const spark = (c: ChartResponse | undefined): number[] =>
    (c?.candles ?? []).map((k) => k.close).filter((v) => typeof v === 'number');
  const breadth = d.breadth;
  const total = (breadth?.advancers ?? 0) + (breadth?.decliners ?? 0);
  const advShare = total > 0 ? ((breadth?.advancers ?? 0) / total) * 100 : 0;
  const regime = d.regime ?? { regime: null, confidence: null, components: null };
  const regimeComponents = Object.entries(regime.components ?? {});

  return (
    <div className="space-y-5">
      {/* paper banner reinforced */}
      <div className="rounded-lg border border-amber-soft/50 bg-amber-soft/10 px-4 py-3">
        <div className="font-mono text-xs font-semibold uppercase tracking-[0.2em] text-amber-soft">
          {d.banner ?? 'PAPER TRADING — NO REAL MONEY IS BEING USED'}
        </div>
        <p className="mt-1 text-xs text-amber-soft/90">
          Every fill below is simulated against delayed quotes. No orders leave this system; no broker, options,
          crypto or transfer action exists here.
        </p>
      </div>

      {/* session + regime */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Market session">
          <div className="flex flex-wrap items-center gap-2">
            <SessionBadge session={d.market?.session} date={d.market?.date ?? null} />
            {d.market?.nextSession && (
              <span className="font-mono text-[11px] text-mist">
                next: {dateText(d.market.nextSession.date)}
                {d.market.nextSession.openMs ? ` · open ${time(d.market.nextSession.openMs)}` : ''}
              </span>
            )}
          </div>
          <p className="mt-2 text-xs text-mist">{d.volatility?.vix === null || d.volatility?.vix === undefined ? 'VIX —' : `VIX ${number(d.volatility.vix)}`}</p>
        </Card>
        <Card title="Regime" subtitle={regime.regime ?? '—'} className="lg:col-span-2">
          <ConfidenceBar value={regime.confidence ?? null} />
          {regimeComponents.length > 0 && (
            <div className="mt-2 space-y-0.5">
              {regimeComponents.map(([k, v]) => (
                <div key={k} className="flex items-center justify-between text-xs">
                  <span className="text-mist">{k}</span>
                  <span className="font-mono text-slate-soft">{number(v)}</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* indexes */}
      <div className="grid gap-4 sm:grid-cols-3">
        <QuoteCard symbol="SPY" price={d.indexes?.[0]?.price ?? null} change={d.indexes?.[0]?.changePct ?? null} spark={spark(spy.data)} />
        <QuoteCard symbol="QQQ" price={d.indexes?.[1]?.price ?? null} change={d.indexes?.[1]?.changePct ?? null} spark={spark(qqq.data)} />
        <QuoteCard symbol="DIA" price={d.indexes?.[2]?.price ?? null} change={d.indexes?.[2]?.changePct ?? null} spark={spark(dia.data)} />
      </div>

      {/* breadth + vix + activity tiles */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Breadth"
          value={`${number(breadth?.advancers ?? null)} / ${number(breadth?.decliners ?? null)}`}
          hint={breadth ? `advancers / decliners${breadth.asOf ? ` · ${time(breadth.asOf)}` : ''}` : 'breadth unavailable'}
        />
        <StatTile label="VIX" value={number(d.volatility?.vix ?? null)} hint="CBOE volatility index" />
        <StatTile label="Signals today" value={number(d.signalsToday)} />
        <StatTile label="LLM calls today" value={number(d.llmCallsToday)} hint={pctPlain(d.llmDependencyPct ?? null)} />
      </div>

      {total > 0 && (
        <Card title="Advance / decline">
          <div className="h-2 overflow-hidden rounded-full bg-ink-700">
            <div className="h-full rounded-full bg-mint-dim" style={{ width: `${advShare}%` }} />
          </div>
          <div className="mt-1 flex justify-between font-mono text-[11px] text-mist">
            <span className="text-mint">{number(breadth?.advancers ?? null)} advancing</span>
            <span className="text-danger">{number(breadth?.decliners ?? null)} declining</span>
          </div>
        </Card>
      )}

      <WhatIfCard whatIf={d.whatIf} />

      {/* portfolios side by side */}
      <div className="grid gap-4 lg:grid-cols-2">
        {(d.portfolios ?? []).map((p) => (
          <PortfolioCard key={p.kind} p={p} />
        ))}
      </div>

      {/* P&L */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Paper P&amp;L" className="lg:col-span-2">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div>
              <div className="text-[10px] uppercase text-mist">Today</div>
              <div className={`font-mono text-xl ${toneClass(d.pnl?.todayPct)}`}>{pct(d.pnl?.todayPct)}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase text-mist">Total</div>
              <div className={`font-mono text-xl ${toneClass(d.pnl?.totalPct)}`}>{pct(d.pnl?.totalPct)}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase text-mist">Open positions</div>
              <div className="font-mono text-xl text-slate-soft">{number(d.positions?.open ?? null)}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase text-mist">Exposure</div>
              <div className="font-mono text-xl text-slate-soft">{pct(d.positions?.exposurePct ?? null)}</div>
            </div>
          </div>
          <div className="mt-3">
            <LineChart
              ariaLabel="equity curve, last 60 snapshots"
              series={[
                {
                  name: 'Equity',
                  color: '#34f5c5',
                  points: (d.pnl?.equitySeries ?? []).map((p) => ({
                    x: typeof p.ts === 'number' ? p.ts : Date.parse(p.ts),
                    y: p.equity,
                  })),
                },
              ]}
              valueFormat={(v) => money(v)}
            />
          </div>
        </Card>

        <Card title="Top risk alerts">
          {(d.riskAlerts ?? []).length === 0 ? (
            <p className="text-xs text-mist">No active risk alerts.</p>
          ) : (
            <ul className="space-y-2">
              {(d.riskAlerts ?? []).map((a, i) => (
                <li key={`${a.ticker}-${i}`} className="flex items-start gap-2 border-b border-line/60 pb-2 last:border-b-0">
                  <Badge tone={a.severity === 'high' ? 'neg' : 'warn'}>{a.severity}</Badge>
                  <div className="min-w-0">
                    <Link to={`/tradingusa/stocks/${a.ticker}`} className="font-mono text-xs font-semibold text-mint hover:underline">
                      {a.ticker}
                    </Link>
                    <p className="text-xs text-slate-soft">{a.alert}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {/* opportunities */}
      <Card title="Top opportunities" subtitle="Highest-confidence active signals — inclusion is research, not an order.">
        <DataTable
          label="Top opportunities"
          rows={d.opportunities ?? []}
          columns={OPPORTUNITY_COLUMNS}
          rowKey={(r) => r.id}
          onRowClick={(r) => navigateTo(`/tradingusa/signals/${r.id}`)}
          empty={<EmptyState title="No signals yet">No active signals have been published for this session.</EmptyState>}
        />
      </Card>

      {/* events */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Recent events" subtitle="Deduplicated across independent sources.">
          {(d.events ?? []).length === 0 ? (
            <p className="text-xs text-mist">No events captured yet.</p>
          ) : (
            <ul className="space-y-2">
              {(d.events ?? []).slice(0, 8).map((e) => (
                <li key={e.id} className="border-b border-line/60 pb-2 last:border-b-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="info">{e.type}</Badge>
                    {e.ticker && <span className="font-mono text-xs font-semibold text-mint">{e.ticker}</span>}
                    <span className="text-[11px] text-mist">{e.headline}</span>
                    <span className={`ml-auto font-mono text-[11px] ${toneClass(e.sentiment)}`}>{pct(e.sentiment === null ? null : e.sentiment)}</span>
                  </div>
                  <div className="mt-1 flex items-center gap-2">
                    <MeterBar value={e.materiality} width="w-20" />
                    <span className="text-[10px] text-mist">
                      materiality {number(e.materiality)} · {number(e.sources ?? null)} sources (
                      {number(e.independentSources ?? null)} independent) · first seen {time(e.firstSeen ?? null)}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card
          title="Daily review"
          subtitle="Server-computed session ledger from GET /reviews."
          actions={
            <span className="font-mono text-[11px] text-mist">
              {reviews.data ? `${reviews.data.daily.length} sessions` : ''}
            </span>
          }
        >
          <DataTable
            label="Daily review"
            rows={reviews.data?.daily ?? []}
            columns={[
              { key: 'date', header: 'Session', sortValue: (r) => r.date, cell: (r) => <span className="font-mono text-xs">{dateText(r.date)}</span> },
              { key: 'signals', header: 'Signals', align: 'right', cell: (r) => <span className="font-mono">{number(r.signals ?? null)}</span> },
              { key: 'opened', header: 'Opened', align: 'right', cell: (r) => <span className="font-mono">{number(r.opened ?? null)}</span> },
              { key: 'closed', header: 'Closed', align: 'right', cell: (r) => <span className="font-mono">{number(r.closed ?? null)}</span> },
              { key: 'wins', header: 'Wins', align: 'right', cell: (r) => <span className="font-mono text-mint">{number(r.wins ?? null)}</span> },
              { key: 'daily', header: 'Daily', align: 'right', cell: (r) => <span className={`font-mono ${toneClass(r.dailyReturnPct ?? null)}`}>{pct(r.dailyReturnPct ?? null)}</span> },
              { key: 'bench', header: 'SPY', align: 'right', cell: (r) => <span className="font-mono text-mist">{pct(r.benchmarkReturnPct ?? null)}</span> },
              { key: 'excess', header: 'Excess', align: 'right', cell: (r) => <span className={`font-mono ${toneClass(r.excessReturnPct ?? null)}`}>{pct(r.excessReturnPct ?? null)}</span> },
              { key: 'mistakes', header: 'Mistakes', align: 'right', cell: (r) => <span className="font-mono">{number(r.mistakes ?? null)}</span> },
              { key: 'llm', header: 'LLM calls', align: 'right', cell: (r) => <span className="font-mono">{number(r.llmCalls ?? null)}</span> },
            ]}
            rowKey={(r) => r.date}
            empty={<p className="py-4 text-center text-xs text-mist">No daily reviews published yet.</p>}
          />
        </Card>
      </div>

      {/* weekly roll-up from the same endpoint */}
      <Card title="Weekly review" subtitle="Server-computed weekly roll-up (short/long-term, system and AI blocks).">
        <DataTable
          label="Weekly review"
          rows={reviews.data?.weekly ?? []}
          rowKey={(r) => r.label}
          columns={[
            { key: 'label', header: 'Week', sortValue: (r) => r.label, cell: (r) => <span className="font-mono text-xs text-slate-soft">{r.label}</span> },
            { key: 'period', header: 'Period', cell: (r) => <span className="font-mono text-xs text-mist">{dateText(r.start ?? '')} → {dateText(r.end ?? '')}</span> },
            { key: 'short', header: 'Short term', cell: (r) => <span className="font-mono text-[11px] text-mist">{flex(r.shortTerm ?? null)}</span> },
            { key: 'long', header: 'Long term', cell: (r) => <span className="font-mono text-[11px] text-mist">{flex(r.longTerm ?? null)}</span> },
            { key: 'system', header: 'System', cell: (r) => <span className="font-mono text-[11px] text-mist">{flex(r.system ?? null)}</span> },
            { key: 'ai', header: 'AI', cell: (r) => <span className="font-mono text-[11px] text-mist">{flex(r.ai ?? null)}</span> },
          ]}
          empty={<p className="py-4 text-center text-xs text-mist">No weekly reviews published yet.</p>}
        />
      </Card>
    </div>
  );
}