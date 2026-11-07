/**
 * Stock dossier (/tradingusa/stocks/:ticker) — quote + chart, technicals,
 * fundamentals, scores, sentiment, events/news/filings, macro, peers,
 * historical signals, paper-trade history, learned lessons, and the two
 * opposing thesis blocks plus the current-information vs historical-
 * knowledge split.
 */

import { useState } from 'react';
import { getChart, getStock } from '../api';
import type { ChartResponse, StockResponse } from '../api';
import { Link, useEndpoint } from '../data';
import type { ReactNode } from 'react';
import {
  Badge,
  Card,
  ConfidenceBar,
  DataTable,
  ErrorState,
  HBar,
  LineChart,
  Loading,
  MeterBar,
  StatTile,
  dateText,
  flex,
  money,
  norm01,
  number,
  pct,
  pctAuto,
  time,
  toneClass,
} from '../ui';
import type { SignalRow, TradeRow } from '../api';

const RANGES = ['1y', '6mo', '3mo', '1mo'] as const;

/** Volume strip under the price line — hand-rolled SVG, no chart library. */
function VolumeBars({ volumes, labels }: { volumes: number[]; labels: string[] }) {
  const W = 720;
  const H = 54;
  if (volumes.length === 0) return null;
  const max = Math.max(...volumes, 1);
  const slot = W / volumes.length;
  const barW = Math.max(1, Math.min(slot * 0.7, 12));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" role="img" aria-label="volume" className="block">
      <text x={2} y={10} fontSize="9" fontFamily="monospace" fill="#93a4bd">
        volume {labels[0] ?? ''} → {labels[labels.length - 1] ?? ''}
      </text>
      {volumes.map((v, i) => {
        const h = (v / max) * (H - 16);
        return <rect key={i} x={i * slot + (slot - barW) / 2} y={H - h} width={barW} height={Math.max(h, 1)} fill="#2a3950" />;
      })}
    </svg>
  );
}

function KeyValue({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-line/50 py-1 last:border-b-0">
      <span className="text-[11px] uppercase tracking-wide text-mist">{label}</span>
      <span className="font-mono text-xs text-slate-soft">{value}</span>
    </div>
  );
}

export function StockPage({ ticker }: { ticker: string }) {
  const [range, setRange] = useState<string>('1y');
  const stock = useEndpoint<StockResponse>(`/stocks/${ticker}`, () => getStock(ticker));
  const chart = useEndpoint<ChartResponse>(`/stocks/${ticker}/chart?range=${range}`, () => getChart(ticker, range));

  if (stock.data === undefined) {
    return stock.error ? <ErrorState message={stock.error} onRetry={stock.reload} /> : <Loading label={`Loading ${ticker}…`} />;
  }
  const d = stock.data;
  const q = d.quote;
  const candles = chart.data?.candles ?? [];
  const tech = d.technicals ?? {};
  const fund = d.fundamentals ?? {};
  const scores = d.scores ?? {};
  const sentiment = d.sentiment ?? {};
  const dims = Object.entries(sentiment.dimensions ?? {});
  const trendTone =
    sentiment.trend === 'IMPROVING' ? 'pos' : sentiment.trend === 'DETERIORATING' ? 'neg' : 'neutral';

  return (
    <div className="space-y-4">
      <Link to="/tradingusa/signals" className="inline-block text-xs text-mist hover:text-mint">
        &larr; Back to Signals
      </Link>

      {/* header */}
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="font-mono text-2xl font-semibold text-slate-soft">{d.ticker}</h2>
        <span className="text-sm text-slate-soft">{d.company}</span>
        <Badge tone="info">{d.sector}</Badge>
        <span className={`font-mono text-xl ${toneClass(q?.changePct ?? null)}`}>{money(q?.price ?? null)}</span>
        <span className={`font-mono text-sm ${toneClass(q?.changePct ?? null)}`}>{pct(q?.changePct ?? null)}</span>
        <Badge tone="warn">{d.freshness ?? q?.freshness ?? 'DELAYED'}</Badge>
        <Badge tone="neutral">{q?.provider ?? '—'}</Badge>
        <span className="font-mono text-[11px] text-mist">prev close {money(q?.prevClose ?? null)}</span>
        <span className="font-mono text-[11px] text-mist">{q?.ts ? `quote ${time(q.ts)}` : 'quote —'}</span>
        <Badge tone="neutral">{d.regime ?? '—'}</Badge>
      </div>

      {/* thesis blocks — always prominent, above the detail */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Why TradingUSA likes this" className="border-mint/40">
          <ul className="space-y-2">
            {(d.why?.bullets ?? []).length === 0 ? (
              <li className="text-xs text-mist">No thesis bullets recorded.</li>
            ) : (
              (d.why?.bullets ?? []).map((b, i) => (
                <li key={i} className="flex gap-2 text-sm text-slate-soft">
                  <span className="text-mint" aria-hidden>
                    ▲
                  </span>
                  <span>{b}</span>
                </li>
              ))
            )}
          </ul>
          <p className="mt-3 text-[11px] uppercase tracking-wider text-mint">{d.why?.title ?? 'WHY TRADINGUSA LIKES THIS'}</p>
        </Card>
        <Card title="What could make it wrong" className="border-amber-soft/40">
          <ul className="space-y-2">
            {(d.counter?.bullets ?? []).length === 0 ? (
              <li className="text-xs text-mist">No counter-thesis bullets recorded.</li>
            ) : (
              (d.counter?.bullets ?? []).map((b, i) => (
                <li key={i} className="flex gap-2 text-sm text-slate-soft">
                  <span className="text-amber-soft" aria-hidden>
                    ▼
                  </span>
                  <span>{b}</span>
                </li>
              ))
            )}
          </ul>
          <p className="mt-3 text-[11px] uppercase tracking-wider text-amber-soft">
            {d.counter?.title ?? 'WHAT COULD MAKE IT WRONG'}
          </p>
        </Card>
      </div>

      {/* current vs historical knowledge */}
      <Card title="Current information vs historical knowledge">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-md border border-line bg-ink-900/70 p-3">
            <div className="text-[10px] uppercase tracking-wider text-violet-soft">Current information</div>
            <ul className="mt-2 space-y-1.5">
              {(d.currentVsKnowledge?.current ?? []).length === 0 ? (
                <li className="text-xs text-mist">nothing current recorded</li>
              ) : (
                (d.currentVsKnowledge?.current ?? []).map((line, i) => (
                  <li key={i} className="text-xs text-slate-soft">
                    {line}
                  </li>
                ))
              )}
            </ul>
          </div>
          <div className="rounded-md border border-line bg-ink-900/70 p-3">
            <div className="text-[10px] uppercase tracking-wider text-mist">Historical knowledge</div>
            <ul className="mt-2 space-y-1.5">
              {(d.currentVsKnowledge?.historicalKnowledge ?? []).length === 0 ? (
                <li className="text-xs text-mist">no historical lessons recorded</li>
              ) : (
                (d.currentVsKnowledge?.historicalKnowledge ?? []).map((line, i) => (
                  <li key={i} className="text-xs text-slate-soft">
                    {line}
                  </li>
                ))
              )}
            </ul>
          </div>
        </div>
      </Card>

      {/* chart */}
      <Card
        title="Price"
        subtitle={candles.length > 0 ? `${candles.length} bars · ${chart.data?.range ?? range}` : 'no bars for this range'}
        actions={
          <div className="flex gap-1">
            {RANGES.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setRange(r)}
                className={`rounded border px-2 py-0.5 font-mono text-[11px] ${
                  r === range ? 'border-mint/50 bg-mint/10 text-mint' : 'border-line text-mist hover:text-slate-soft'
                }`}
              >
                {r}
              </button>
            ))}
          </div>
        }
      >
        <LineChart
          ariaLabel={`${d.ticker} closing price`}
          series={[
            {
              name: `${d.ticker} close`,
              color: '#34f5c5',
              points: candles.map((c) => ({ x: Date.parse(c.date) || 0, y: c.close })),
            },
          ]}
          valueFormat={(v) => money(v)}
        />
        <VolumeBars volumes={candles.map((c) => c.volume)} labels={candles.length > 0 ? [candles[0].date, candles[candles.length - 1].date] : []} />
      </Card>

      {/* technicals + scores */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Technicals" className="lg:col-span-2">
          <div className="grid gap-x-6 sm:grid-cols-2 lg:grid-cols-3">
            <KeyValue label="SMA 20" value={money(tech.sma20 ?? null)} />
            <KeyValue label="SMA 50" value={money(tech.sma50 ?? null)} />
            <KeyValue label="SMA 200" value={money(tech.sma200 ?? null)} />
            <KeyValue label="RSI 14" value={number(tech.rsi14 ?? null)} />
            <KeyValue label="MACD hist" value={number(tech.macdHist ?? null)} />
            <KeyValue label="ATR" value={money(tech.atr ?? null)} />
            <KeyValue label="ATR %" value={pctAuto(tech.atrPct ?? null)} />
            <KeyValue label="Rel strength 90d" value={number(tech.relStrength90 ?? null)} />
            <KeyValue label="Relative volume" value={number(tech.relVol ?? null)} />
            <KeyValue label="VWAP position" value={pctAuto(tech.vwapPos ?? null)} />
            <KeyValue label="Breakout" value={flex(tech.breakout ?? null)} />
            <KeyValue label="MA cross" value={flex(tech.maCross ?? null)} />
            <KeyValue label="OBV trend" value={flex(tech.obvTrend ?? null)} />
            <KeyValue label="Stochastic K" value={number(tech.stochasticK ?? null)} />
            <KeyValue label="52w position" value={pctAuto(tech.position52w ?? null)} />
            <KeyValue label="Realized vol" value={pctAuto(tech.realizedVol ?? null)} />
          </div>
        </Card>
        <Card title="Fundamental scores">
          <div className="space-y-2">
            {(['quality', 'growth', 'valuation', 'financialRisk'] as const).map((k) => {
              const v = scores[k] ?? null;
              const n = norm01(v);
              return (
                <div key={k}>
                  <div className="mb-0.5 flex justify-between text-[11px]">
                    <span className="uppercase tracking-wide text-mist">{k}</span>
                    <span className="font-mono text-slate-soft">{v === null ? '—' : `${Math.round(n * 100)} / 100`}</span>
                  </div>
                  <HBar label="" value={n * 100} display="" tone={n >= 0.7 ? 'pos' : n >= 0.45 ? 'warn' : 'neg'} max={100} />
                </div>
              );
            })}
          </div>
        </Card>
      </div>

      {/* fundamentals */}
      <Card title="Fundamentals" subtitle={fund.source ? `source: ${fund.source} · as of ${flex(fund.asOf ?? null)}` : undefined}>
        <div className="grid gap-x-8 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
          <KeyValue label="Revenue growth" value={pctAuto(fund.revenueGrowth ?? null)} />
          <KeyValue label="EPS growth" value={pctAuto(fund.epsGrowth ?? null)} />
          <KeyValue label="Operating margin" value={pctAuto(fund.operatingMargin ?? null)} />
          <KeyValue label="Net margin" value={pctAuto(fund.netMargin ?? null)} />
          <KeyValue label="ROE" value={pctAuto(fund.roe ?? null)} />
          <KeyValue label="ROIC" value={pctAuto(fund.roic ?? null)} />
          <KeyValue label="FCF" value={money(fund.fcf ?? null)} />
          <KeyValue label="Debt / equity" value={number(fund.debtToEquity ?? null)} />
          <KeyValue label="P/E" value={number(fund.pe ?? null)} />
          <KeyValue label="Forward P/E" value={number(fund.fwdPe ?? null)} />
          <KeyValue label="PEG" value={number(fund.peg ?? null)} />
          <KeyValue label="P/S" value={number(fund.ps ?? null)} />
          <KeyValue label="EV / EBITDA" value={number(fund.evEbitda ?? null)} />
          <KeyValue label="FCF yield" value={pctAuto(fund.fcfYield ?? null)} />
        </div>
      </Card>

      {/* sentiment */}
      <Card title="Sentiment" actions={<Badge tone={trendTone}>{sentiment.trend ?? '—'}</Badge>}>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-mist">Overall</div>
            <div className="font-mono text-2xl text-slate-soft">
              {typeof sentiment.overall === 'number' ? pctAuto(sentiment.overall) : flex(sentiment.overall ?? null)}
            </div>
            <div className="mt-2">
              <MeterBar value={typeof sentiment.overall === 'number' ? sentiment.overall * 100 : null} width="w-full" />
            </div>
          </div>
          <div className="space-y-1">
            {dims.length === 0 ? (
              <p className="text-xs text-mist">no sentiment dimensions published</p>
            ) : (
              dims.map(([k, v]) => (
                <div key={k} className="flex items-center justify-between gap-3">
                  <span className="text-xs uppercase tracking-wide text-mist">{k}</span>
                  <span className={`font-mono text-xs ${typeof v === 'number' ? toneClass(v) : ''}`}>
                    {typeof v === 'number' ? pctAuto(v) : flex(v)}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </Card>

      {/* events / news / filings */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Current events">
          {(d.events ?? []).length === 0 ? (
            <p className="text-xs text-mist">No current events for {d.ticker}.</p>
          ) : (
            <ul className="space-y-2">
              {(d.events ?? []).map((e) => (
                <li key={e.id} className="border-b border-line/60 pb-2 last:border-b-0">
                  <div className="flex items-center gap-2">
                    <Badge tone="info">{e.type}</Badge>
                    <span className="text-[11px] text-slate-soft">{e.headline}</span>
                  </div>
                  <div className="mt-1 flex items-center gap-2">
                    <MeterBar value={e.materiality} width="w-16" />
                    <span className="text-[10px] text-mist">
                      materiality {number(e.materiality)} · {number(e.sources ?? null)} sources (
                      {number(e.independentSources ?? null)} independent) · confidence {number(e.confidence ?? null)} ·
                      horizon {flex(e.expectedHorizon ?? null)} · seen {flex(e.firstSeen ? time(e.firstSeen) : null)} ·
                      updated {flex(e.lastUpdated ? time(e.lastUpdated) : null)}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="News">
          {(d.news ?? []).length === 0 ? (
            <p className="text-xs text-mist">No news items captured.</p>
          ) : (
            <ul className="space-y-2">
              {(d.news ?? []).map((n) => (
                <li key={n.id} className="border-b border-line/60 pb-2 last:border-b-0">
                  <a
                    href={n.url ?? '#'}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-slate-soft hover:text-mint"
                  >
                    {n.headline}
                  </a>
                  <div className="mt-0.5 flex items-center gap-2 font-mono text-[10px] text-mist">
                    <span>{n.source ?? '—'}</span>
                    <span>{time(n.ts)}</span>
                    <span className={toneClass(n.sentiment ?? null)}>{pct(n.sentiment ?? null)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="SEC filings">
          {(d.filings ?? []).length === 0 ? (
            <p className="text-xs text-mist">No filings captured.</p>
          ) : (
            <ul className="space-y-2">
              {(d.filings ?? []).map((f) => (
                <li key={f.id} className="border-b border-line/60 pb-2 last:border-b-0">
                  <div className="flex items-center gap-2">
                    <Badge tone="neutral">{f.form}</Badge>
                    <span className="font-mono text-[10px] text-mist">{dateText(String(f.filedAt ?? ''))}</span>
                  </div>
                  <a
                    href={f.url ?? '#'}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-0.5 block text-xs text-slate-soft hover:text-mint"
                  >
                    {f.description ?? f.form}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {/* macro + peers */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Macro exposure">
          {d.macroExposure ? (
            <div className="space-y-1">
              <KeyValue label="Beta to SPY" value={number(d.macroExposure.betaToSpy ?? null)} />
              <KeyValue label="Yield sensitivity" value={flex(d.macroExposure.yields ?? null)} />
            </div>
          ) : (
            <p className="text-xs text-mist">No macro exposure profile recorded.</p>
          )}
        </Card>
        <Card title="Peers" subtitle="20-day relative return.">
          <DataTable
            label="Peers"
            rows={d.peers ?? []}
            rowKey={(r) => r.ticker}
            columns={[
              {
                key: 'ticker',
                header: 'Ticker',
                cell: (r) => (
                  <Link to={`/tradingusa/stocks/${r.ticker}`} className="font-mono text-mint hover:underline">
                    {r.ticker}
                  </Link>
                ),
              },
              { key: 'ret', header: '20d return', align: 'right', cell: (r) => <span className={`font-mono ${toneClass(r.ret20dPct)}`}>{pct(r.ret20dPct)}</span> },
            ]}
            empty={<p className="py-2 text-xs text-mist">no peers mapped</p>}
          />
        </Card>
      </div>

      {/* historical signals */}
      <Card title="Historical signals" subtitle="Every signal ever published for this ticker — immutable.">
        <DataTable
          label="Historical signals"
          rows={d.signals ?? []}
          rowKey={(r) => r.id}
          columns={[
            {
              key: 'id',
              header: 'Created',
              cell: (r: SignalRow) => (
                <Link to={`/tradingusa/signals/${r.id}`} className="font-mono text-xs text-mint hover:underline">
                  {time(r.createdAt)}
                </Link>
              ),
            },
            { key: 'signal', header: 'Signal', cell: (r: SignalRow) => <Badge tone={r.signal === 'BUY' ? 'pos' : r.signal === 'SELL' ? 'neg' : 'info'}>{r.signal}</Badge> },
            { key: 'confidence', header: 'Confidence', cell: (r: SignalRow) => <ConfidenceBar value={r.confidence} /> },
            { key: 'price', header: 'Price', align: 'right', cell: (r: SignalRow) => <span className="font-mono">{money(r.price)}</span> },
            { key: 'target', header: 'Target', align: 'right', cell: (r: SignalRow) => <span className="font-mono">{money(r.target)}</span> },
            { key: 'expected', header: 'Expected', align: 'right', cell: (r: SignalRow) => <span className={`font-mono ${toneClass(r.expectedReturnPct)}`}>{pct(r.expectedReturnPct)}</span> },
            { key: 'status', header: 'Status', cell: (r: SignalRow) => <Badge tone={r.status === 'ACTIVE' ? 'pos' : 'neutral'}>{r.status}</Badge> },
          ]}
          empty={<p className="py-3 text-center text-xs text-mist">No signals published for {d.ticker} yet.</p>}
        />
      </Card>

      {/* paper trade history */}
      <Card title="Paper-trade history" subtitle="Simulated fills only — never real orders.">
        <DataTable
          label="Paper trade history"
          rows={d.trades ?? []}
          rowKey={(r) => r.id}
          columns={[
            { key: 'entry', header: 'Entry', cell: (r: TradeRow) => <span className="font-mono text-xs">{time(r.entryTs)}</span> },
            { key: 'exit', header: 'Exit', cell: (r: TradeRow) => <span className="font-mono text-xs">{time(r.exitTs ?? null)}</span> },
            { key: 'qty', header: 'Qty', align: 'right', cell: (r: TradeRow) => <span className="font-mono">{number(r.qty)}</span> },
            { key: 'entryPrice', header: 'Entry price', align: 'right', cell: (r: TradeRow) => <span className="font-mono">{money(r.entryPrice)}</span> },
            { key: 'exitPrice', header: 'Exit price', align: 'right', cell: (r: TradeRow) => <span className="font-mono">{money(r.exitPrice ?? null)}</span> },
            { key: 'net', header: 'Net P&L', align: 'right', cell: (r: TradeRow) => <span className={`font-mono ${toneClass(r.netPnl ?? null)}`}>{money(r.netPnl ?? null)}</span> },
            { key: 'actual', header: 'Actual', align: 'right', cell: (r: TradeRow) => <span className={`font-mono ${toneClass(r.actualReturnPct ?? null)}`}>{pct(r.actualReturnPct ?? null)}</span> },
            { key: 'reason', header: 'Exit reason', cell: (r: TradeRow) => <span className="text-xs text-mist">{r.exitReason ?? '—'}</span> },
          ]}
          empty={<p className="py-3 text-center text-xs text-mist">No paper trades for {d.ticker} yet.</p>}
        />
      </Card>

      {/* lessons */}
      <Card title="Learned lessons">
        {(d.lessons ?? []).length === 0 ? (
          <p className="text-xs text-mist">Nothing learned about {d.ticker} yet.</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {(d.lessons ?? []).map((l) => (
              <div key={l.id} className="rounded-md border border-line bg-ink-900/70 p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-slate-soft">{l.title}</span>
                  <Badge tone={l.status === 'VALIDATED' ? 'pos' : l.status === 'REJECTED' ? 'neg' : 'warn'}>
                    {l.status ?? 'CANDIDATE'}
                  </Badge>
                </div>
                <p className="mt-1 text-xs text-mist">{l.statement ?? ''}</p>
                <div className="mt-2">
                  <ConfidenceBar value={l.confidence ?? null} />
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* stat tiles last for quick scanning */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Quote freshness" value={<span className="text-sm">{d.freshness ?? q?.freshness ?? 'DELAYED'}</span>} tone="warn" />
        <StatTile label="Regime" value={<span className="text-sm">{d.regime ?? '—'}</span>} />
        <StatTile label="Open events" value={number((d.events ?? []).length)} />
        <StatTile label="Signals on record" value={number((d.signals ?? []).length)} />
      </div>
    </div>
  );
}