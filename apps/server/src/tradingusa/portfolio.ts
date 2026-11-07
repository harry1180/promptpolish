/**
 * Portfolio valuation, metrics and the SPY benchmark comparison.
 * Every displayed number is derived from stored state — nothing is
 * hard-coded. Benchmarks are SPY buy-and-hold over the same window.
 */
import type { DatabaseSync } from 'node:sqlite';
import { computeMetrics, etDate } from '@promptslim/tucore';
import type { EquityPoint, PortfolioMetrics, TradeRecord } from '@promptslim/tucore';

export interface PortfolioView {
  kind: string;
  startCapital: number;
  equity: number;
  cash: number;
  realizedPnl: number;
  unrealizedPnl: number;
  metrics: PortfolioMetrics;
  equitySeries: EquityPoint[];
  benchmark: { symbol: 'SPY'; series: EquityPoint[]; totalReturnPct: number };
  positions: unknown[];
}

function tradesOf(db: DatabaseSync, kind: string): TradeRecord[] {
  const rows = db
    .prepare(
      `SELECT id, ticker, portfolio, side, qty, entry_price AS entryPrice, entry_ts AS entryTs,
              exit_price AS exitPrice, exit_ts AS exitTs, exit_reason AS exitReason,
              holding_sessions, predicted_return, status
         FROM paper_trades WHERE portfolio = ? ORDER BY exit_ts`,
    )
    .all(kind) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: Number(r.id),
    ticker: String(r.ticker),
    portfolio: r.portfolio as TradeRecord['portfolio'],
    side: 'LONG',
    qty: Number(r.qty),
    entryPrice: Number(r.entryPrice),
    entryTs: Number(r.entryTs),
    exitPrice: r.exitPrice == null ? null : Number(r.exitPrice),
    exitTs: r.exitTs == null ? null : Number(r.exitTs),
    exitReason: (r.exitReason ?? null) as TradeRecord['exitReason'],
    target: Number(r.target ?? 0),
    stop: 0,
    maxHoldSessions: 0,
    predictedReturn: Number(r.predicted_return ?? 0),
  }));
}

function snapshots(db: DatabaseSync, kind: string): EquityPoint[] {
  const rows = db
    .prepare('SELECT ts, equity FROM portfolio_snapshots WHERE portfolio = ? ORDER BY ts')
    .all(kind) as unknown as Array<{ ts: number; equity: number }>;
  return rows.map((r) => ({ ts: r.ts, equity: r.equity }));
}

function benchmarkSeries(db: DatabaseSync, kind: string): EquityPoint[] {
  const pf = db.prepare('SELECT start_capital, created_at FROM paper_portfolios WHERE kind = ?').get(kind) as
    | { start_capital: number; created_at: number }
    | undefined;
  if (!pf) return [];
  const startDate = etDate(pf.created_at);
  // Base the curve on the last bar ON OR BEFORE the portfolio was created:
  // filtering `date >= created` alone leaves the window empty until the next
  // bar prints (the whole benchmark column then reads 0).
  const base = db
    .prepare(`SELECT date, close FROM market_bars WHERE ticker = 'SPY' AND date <= ? ORDER BY date DESC LIMIT 1`)
    .get(startDate) as { date: string; close: number } | undefined;
  if (!base) return [];
  const bars = db
    .prepare(`SELECT date, close FROM market_bars WHERE ticker = 'SPY' AND date >= ? ORDER BY date`)
    .all(base.date) as unknown as Array<{ date: string; close: number }>;
  if (bars.length === 0) return [];
  const baseClose = base.close;
  return bars.map((b) => ({ ts: Date.parse(`${b.date}T21:00:00Z`), equity: (b.close / baseClose) * pf.start_capital }));
}

export function computePortfolioView(db: DatabaseSync, kind: string): PortfolioView | null {
  const pf = db.prepare('SELECT kind, start_capital, cash, created_at FROM paper_portfolios WHERE kind = ?').get(kind) as
    | { kind: string; start_capital: number; cash: number; created_at: number }
    | undefined;
  if (!pf) return null;

  const positions = db
    .prepare('SELECT * FROM paper_positions WHERE portfolio = ? AND exit_ts IS NULL')
    .all(kind) as unknown as Array<Record<string, unknown>>;
  const openNotional = positions.reduce((s, p) => s + Number(p.qty) * Number(p.current_price ?? p.entry_price), 0);
  const unrealized = positions.reduce(
    (s, p) => s + Number(p.qty) * (Number(p.current_price ?? p.entry_price) - Number(p.entry_price)),
    0,
  );
  const equity = pf.cash + openNotional;
  const realized = (db.prepare('SELECT COALESCE(SUM(net_pnl), 0) AS s FROM paper_trades WHERE portfolio = ?').get(kind) as { s: number }).s;

  const eqSeries = snapshots(db, kind);
  const bench = benchmarkSeries(db, kind);
  const trades = tradesOf(db, kind);

  const metrics = computeMetrics({
    startingCapital: pf.start_capital,
    cash: pf.cash,
    currentEquity: equity,
    realizedPnl: realized,
    unrealizedPnl: unrealized,
    equitySeries: eqSeries,
    trades,
    benchmarkSeries: bench,
    openNotional,
  });

  const benchReturn = bench.length > 1 ? (bench[bench.length - 1].equity - bench[0].equity) / bench[0].equity : 0;

  return {
    kind,
    startCapital: pf.start_capital,
    equity,
    cash: pf.cash,
    realizedPnl: realized,
    unrealizedPnl: unrealized,
    metrics,
    equitySeries: eqSeries,
    benchmark: { symbol: 'SPY', series: bench, totalReturnPct: benchReturn },
    positions,
  };
}

export function snapshotPortfolios(db: DatabaseSync, now = Date.now()): number {
  let n = 0;
  for (const kind of ['SHORT_TERM_PORTFOLIO', 'LONG_TERM_PORTFOLIO']) {
    const view = computePortfolioView(db, kind);
    if (!view) continue;
    const bench = view.benchmark.series;
    const benchmarkEquity = bench.length > 0 ? bench[bench.length - 1].equity : view.startCapital;
    db.prepare(
      `INSERT INTO portfolio_snapshots (portfolio, ts, equity, cash, realized, unrealized, exposure, benchmark_equity)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      kind, now, view.equity, view.cash, view.realizedPnl, view.unrealizedPnl,
      view.equity > 0 ? (view.equity - view.cash) / view.equity : 0, benchmarkEquity,
    );
    n += 1;
  }
  return n;
}

export interface WhatIf {
  startingCapital: number;
  currentEquity: number;
  paperProfit: number;
  tradingusaReturnPct: number;
  spyReturnPct: number;
  excessReturnPct: number;
  trades: number;
  wins: number;
  losses: number;
  other: number;
  winRatePct: number | null;
  maxDrawdownPct: number;
  portfolio: string;
}

export function whatIfView(db: DatabaseSync): WhatIf[] {
  const out: WhatIf[] = [];
  for (const kind of ['SHORT_TERM_PORTFOLIO', 'LONG_TERM_PORTFOLIO']) {
    const view = computePortfolioView(db, kind);
    if (!view) continue;
    const m = view.metrics;
    const ret = (view.equity - view.startCapital) / view.startCapital;
    const spy = view.benchmark.totalReturnPct;
    out.push({
      portfolio: kind,
      startingCapital: view.startCapital,
      currentEquity: view.equity,
      paperProfit: view.equity - view.startCapital,
      tradingusaReturnPct: ret * 100,
      spyReturnPct: spy * 100,
      excessReturnPct: (ret - spy) * 100,
      trades: m.trades,
      wins: m.wins,
      losses: m.losses,
      other: m.other,
      winRatePct: m.winRate != null ? m.winRate * 100 : null,
      maxDrawdownPct: m.maxDrawdown * 100,
    });
  }
  // combined master view
  if (out.length === 2) {
    const start = out[0].startingCapital + out[1].startingCapital;
    const equity = out[0].currentEquity + out[1].currentEquity;
    const spyRet = (out[0].spyReturnPct + out[1].spyReturnPct) / 2;
    const ret = ((equity - start) / start) * 100;
    out.push({
      portfolio: 'COMBINED_MASTER',
      startingCapital: start,
      currentEquity: equity,
      paperProfit: equity - start,
      tradingusaReturnPct: ret,
      spyReturnPct: spyRet,
      excessReturnPct: ret - spyRet,
      trades: out[0].trades + out[1].trades,
      wins: out[0].wins + out[1].wins,
      losses: out[0].losses + out[1].losses,
      other: out[0].other + out[1].other,
      winRatePct: out[0].trades + out[1].trades > 0
        ? ((out[0].wins + out[1].wins) / Math.max(1, out[0].trades + out[1].trades)) * 100
        : null,
      maxDrawdownPct: Math.min(out[0].maxDrawdownPct, out[1].maxDrawdownPct),
    });
  }
  return out;
}
