/**
 * Portfolio — SHORT_TERM / LONG_TERM tabs with the equity curve vs SPY,
 * the full PortfolioMetrics grid (null → '—', CAGR only when present),
 * a strategy-vs-benchmark-vs-excess comparison bar and concentration by
 * sector (joined against the configured universe).
 */

import { useState } from 'react';
import { getPortfolios, getPositions, getSettings } from '../api';
import type { Portfolio, PortfolioMetrics, PositionsResponse, PortfoliosResponse, SettingsResponse } from '../api';
import { useEndpoint } from '../data';
import {
  Badge,
  Card,
  DataTable,
  EmptyState,
  ErrorState,
  HBar,
  LineChart,
  Loading,
  StatTile,
  dateText,
  frac,
  money,
  number,
  pct,
  pctPlain,
  time,
  toneClass,
} from '../ui';

const KINDS = [
  { kind: 'SHORT_TERM_PORTFOLIO', label: 'Short-term' },
  { kind: 'LONG_TERM_PORTFOLIO', label: 'Long-term' },
] as const;

function MetricTile({ label, value, fraction, unsigned }: { label: string; value: number | null; fraction?: boolean; unsigned?: boolean }) {
  return (
    <div className="rounded-md border border-line bg-ink-900/70 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-mist">{label}</div>
      <div className={`mt-0.5 font-mono text-sm ${value !== null && value !== undefined ? 'text-slate-soft' : 'text-mist'}`}>
        {value === null || value === undefined ? '—' : unsigned ? pctPlain(value * 100) : fraction ? frac(value) : money(value)}
      </div>
    </div>
  );
}

function CountTile({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="rounded-md border border-line bg-ink-900/70 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-mist">{label}</div>
      <div className={`mt-0.5 font-mono text-sm ${value === null || value === undefined ? 'text-mist' : 'text-slate-soft'}`}>
        {value === null || value === undefined ? '—' : number(value)}
      </div>
    </div>
  );
}

export function PortfolioPage() {
  const [kind, setKind] = useState<string>(KINDS[0].kind);
  const portfolios = useEndpoint<PortfoliosResponse>('/portfolios', getPortfolios);
  const positions = useEndpoint<PositionsResponse>('/positions', getPositions);
  const settings = useEndpoint<SettingsResponse>('/settings', getSettings);

  if (portfolios.data === undefined) {
    return portfolios.error ? (
      <ErrorState message={portfolios.error} onRetry={portfolios.reload} />
    ) : (
      <Loading label="Loading portfolios…" />
    );
  }

  const p: Portfolio | undefined = (portfolios.data.portfolios ?? []).find((x) => x.kind === kind);
  const m: PortfolioMetrics | undefined = p?.metrics;
  const universe = settings.data?.config?.universe ?? [];
  const sectorByTicker = new Map(universe.map((u) => [u.ticker, u.sector]));

  const equityPoints = (p?.equitySeries ?? []).map((s) => ({
    x: typeof s.ts === 'number' ? s.ts : Date.parse(String(s.ts)),
    y: s.equity,
  }));
  const benchPoints = (p?.benchmark?.series ?? []).map((s) => ({
    x: typeof s.ts === 'number' ? s.ts : Date.parse(String(s.ts)),
    y: s.equity,
  }));

  // concentration: market value per sector, joined on the configured universe
  const notional = new Map<string, number>();
  let totalNotional = 0;
  for (const pos of positions.data?.positions ?? []) {
    const value = Math.abs((pos.qty ?? 0) * (pos.currentPrice ?? pos.entryPrice ?? 0));
    const sector = sectorByTicker.get(pos.ticker) ?? 'Unknown';
    notional.set(sector, (notional.get(sector) ?? 0) + value);
    totalNotional += value;
  }
  const concentration = [...notional.entries()]
    .map(([sector, value]) => ({ sector, value, pctOfBook: totalNotional > 0 ? (value / totalNotional) * 100 : 0 }))
    .sort((a, b) => b.value - a.value);

  const stratRet = m?.totalReturn ?? null;
  const benchRet = m?.benchmarkReturn ?? null;
  const excessRet = m?.excessReturn ?? null;
  const ceiling = Math.max(Math.abs((stratRet ?? 0) * 100), Math.abs((benchRet ?? 0) * 100), 1);

  return (
    <div className="space-y-4">
      <div className="flex gap-2" role="tablist" aria-label="portfolios">
        {KINDS.map((k) => (
          <button
            key={k.kind}
            type="button"
            role="tab"
            aria-selected={kind === k.kind}
            onClick={() => setKind(k.kind)}
            className={`rounded-md border px-4 py-1.5 text-sm ${
              kind === k.kind ? 'border-mint/50 bg-mint/10 text-mint' : 'border-line text-mist hover:text-slate-soft'
            }`}
          >
            {k.label}
          </button>
        ))}
      </div>

      {!p ? (
        <EmptyState title="Portfolio unavailable">
          GET /portfolios did not include the {kind} portfolio.
        </EmptyState>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile label="Equity" value={money(p.equity)} hint={`started ${money(p.startCapital)}`} />
            <StatTile label="Cash" value={money(p.cash)} />
            <StatTile label="Realized P&L" value={money(p.realizedPnl)} tone={toneClass(p.realizedPnl) as 'pos' | 'neg' | 'info' | 'warn' | 'neutral'} />
            <StatTile label="Unrealized P&L" value={money(p.unrealizedPnl)} tone={toneClass(p.unrealizedPnl) as 'pos' | 'neg' | 'info' | 'warn' | 'neutral'} />
          </div>

          <Card
            title="Equity vs benchmark"
            subtitle={`${p.benchmark?.symbol ?? 'SPY'} rebased to the same starting capital`}
            actions={<Badge tone={toneClass(excessRet) === 'text-danger' ? 'neg' : 'pos'}>excess {frac(excessRet)}</Badge>}
          >
            <LineChart
              ariaLabel="equity versus benchmark"
              series={[
                { name: p.kind.replace('_PORTFOLIO', '').replace('_', '-'), color: '#34f5c5', points: equityPoints },
                { name: p.benchmark?.symbol ?? 'SPY', color: '#8b7cf6', points: benchPoints },
              ]}
              valueFormat={(v) => money(v)}
            />
          </Card>

          <Card title="Benchmark comparison">
            <div className="space-y-1">
              <HBar label="Strategy return" value={(stratRet ?? 0) * 100} display={frac(stratRet)} tone={(stratRet ?? 0) >= 0 ? 'pos' : 'neg'} max={ceiling} />
              <HBar label={`${p.benchmark?.symbol ?? 'SPY'} return`} value={(benchRet ?? 0) * 100} display={frac(benchRet)} tone="info" max={ceiling} />
              <HBar label="Excess return" value={(excessRet ?? 0) * 100} display={frac(excessRet)} tone={(excessRet ?? 0) >= 0 ? 'pos' : 'neg'} max={ceiling} />
            </div>
          </Card>

          <Card title="Metrics" subtitle="Fractions are shown as percentages; '—' means not meaningful.">
            <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-5">
              <MetricTile label="Starting capital" value={m?.startingCapital ?? null} />
              <MetricTile label="Current equity" value={m?.currentEquity ?? null} />
              <MetricTile label="Cash" value={m?.cash ?? null} />
              <MetricTile label="Realized P&L" value={m?.realizedPnl ?? null} />
              <MetricTile label="Unrealized P&L" value={m?.unrealizedPnl ?? null} />
              <MetricTile label="Total return" value={m?.totalReturn ?? null} fraction />
              {m?.cagr !== null && m?.cagr !== undefined && <MetricTile label="CAGR" value={m.cagr} fraction />}
              <MetricTile label="Win rate" value={m?.winRate ?? null} unsigned />
              <MetricTile label="Profit factor" value={m?.profitFactor ?? null} />
              <MetricTile label="Expectancy" value={m?.expectancy ?? null} />
              <MetricTile label="Avg winner" value={m?.avgWinner ?? null} fraction />
              <MetricTile label="Avg loser" value={m?.avgloser ?? null} fraction />
              <MetricTile label="Sharpe" value={m?.sharpe ?? null} />
              <MetricTile label="Sortino" value={m?.sortino ?? null} />
              <MetricTile label="Max drawdown" value={m?.maxDrawdown ?? null} fraction />
              <MetricTile label="Volatility" value={m?.volatility ?? null} fraction />
              <MetricTile label="Turnover" value={m?.turnover ?? null} fraction />
              <MetricTile label="Exposure" value={m?.exposure ?? null} fraction />
              <CountTile label="Trades" value={m?.trades ?? null} />
              <CountTile label="Wins" value={m?.wins ?? null} />
              <CountTile label="Losses" value={m?.losses ?? null} />
              <CountTile label="Other" value={m?.other ?? null} />
              <MetricTile label="Best trade" value={m?.bestTrade ?? null} fraction />
              <MetricTile label="Worst trade" value={m?.worstTrade ?? null} fraction />
              <MetricTile label="Benchmark return" value={m?.benchmarkReturn ?? null} fraction />
              <MetricTile label="Excess return" value={m?.excessReturn ?? null} fraction />
            </div>
          </Card>

          <Card
            title="Concentration"
            subtitle="Sector share of open paper positions, joined against the configured universe."
            actions={<span className="font-mono text-[11px] text-mist">{dateText(new Date().toISOString())} · {number(totalNotional ? Math.round(totalNotional) : null)} notional</span>}
          >
            {concentration.length === 0 ? (
              <p className="text-xs text-mist">No open positions — nothing to concentrate.</p>
            ) : (
              <div className="space-y-0.5">
                {concentration.map((c) => (
                  <HBar
                    key={c.sector}
                    label={c.sector}
                    value={c.pctOfBook}
                    display={`${c.pctOfBook.toFixed(1)}% · ${money(c.value)}`}
                    tone="info"
                    max={100}
                  />
                ))}
              </div>
            )}
            <div className="mt-3">
              <DataTable
                label="Open positions"
                rows={positions.data?.positions ?? []}
                rowKey={(r) => r.id}
                columns={[
                  { key: 'ticker', header: 'Ticker', cell: (r) => <span className="font-mono font-semibold text-mint">{r.ticker}</span> },
                  { key: 'pf', header: 'Portfolio', cell: (r) => <span className="text-[11px] text-mist">{r.portfolio}</span> },
                  { key: 'entered', header: 'Entered', cell: (r) => <span className="font-mono text-xs text-mist">{time(r.entryTs)}</span> },
                  { key: 'sessions', header: 'Sessions held', align: 'right', cell: (r) => <span className="font-mono">{number(r.sessionsHeld ?? null)}</span> },
                  { key: 'qty', header: 'Qty', align: 'right', cell: (r) => <span className="font-mono">{number(r.qty)}</span> },
                  { key: 'entry', header: 'Entry', align: 'right', cell: (r) => <span className="font-mono">{money(r.entryPrice)}</span> },
                  { key: 'current', header: 'Current', align: 'right', cell: (r) => <span className="font-mono">{money(r.currentPrice)}</span> },
                  { key: 'unreal', header: 'Unrealized', align: 'right', cell: (r) => <span className={`font-mono ${toneClass(r.unrealizedPnl)}`}>{money(r.unrealizedPnl)}</span> },
                  { key: 'ret', header: 'Return', align: 'right', cell: (r) => <span className={`font-mono ${toneClass(r.returnPct)}`}>{pct(r.returnPct)}</span> },
                ]}
                empty={<p className="py-3 text-center text-xs text-mist">No open positions in this portfolio.</p>}
              />
            </div>
          </Card>
        </>
      )}
    </div>
  );
}