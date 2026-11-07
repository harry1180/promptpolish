/**
 * Server-side backtest orchestration over stored daily bars.
 * The engine itself (point-in-time discipline, next-open fills, stop-first
 * intra-bar rule, TRAIN/VALIDATION/OUT_OF_SAMPLE folds) lives in
 * @promptslim/tucore.runBacktest; this module only loads data, runs it and
 * stores runs. One run at a time; results are immutable audit records.
 */
import type { DatabaseSync } from 'node:sqlite';
import { runBacktest } from '@promptslim/tucore';
import type { Candle } from '@promptslim/tucore';
import { tradableUniverse } from './universe.ts';

export function triggerBacktest(
  db: DatabaseSync,
  strategy: 'SHORT_TERM' | 'LONG_TERM',
  startDate: string,
  endDate: string,
): { runId: number } | { error: string } {
  const running = db.prepare(`SELECT id FROM backtest_runs WHERE status = 'RUNNING'`).get();
  if (running) return { error: 'a backtest is already running' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) return { error: 'dates must be YYYY-MM-DD' };
  if (startDate >= endDate) return { error: 'startDate must precede endDate' };
  const config = { strategy, startDate, endDate, initialCapital: 100_000, riskPerTradePct: 0.0075, maxOpenPositions: 8, fillNextOpen: true };
  const res = db
    .prepare(`INSERT INTO backtest_runs (strategy, start_date, end_date, status, config_json, created_at) VALUES (?, ?, ?, 'RUNNING', ?, ?)`)
    .run(strategy, startDate, endDate, JSON.stringify(config), Date.now());
  return { runId: Number(res.lastInsertRowid) };
}

export async function runBacktestJob(db: DatabaseSync, runId: number): Promise<{ status: string; error?: string }> {
  const run = db.prepare('SELECT * FROM backtest_runs WHERE id = ?').get(runId) as
    | { id: number; strategy: string; start_date: string; end_date: string; config_json: string }
    | undefined;
  if (!run) return { status: 'ERROR', error: 'run not found' };

  const warmupStart = new Date(Date.parse(run.start_date) - 320 * 86400_000).toISOString().slice(0, 10);
  const bars: Record<string, Candle[]> = {};
  for (const u of tradableUniverse()) {
    const rows = db
      .prepare('SELECT date, open, high, low, close, volume FROM market_bars WHERE ticker = ? AND date >= ? AND date <= ? ORDER BY date')
      .all(u.ticker, warmupStart, run.end_date) as unknown as Candle[];
    if (rows.length > 60) bars[u.ticker] = rows;
  }
  const bench = db
    .prepare('SELECT date, open, high, low, close, volume FROM market_bars WHERE ticker = ? AND date >= ? AND date <= ? ORDER BY date')
    .all('SPY', warmupStart, run.end_date) as unknown as Candle[];

  if (Object.keys(bars).length === 0 || bench.length === 0) {
    db.prepare(`UPDATE backtest_runs SET status = 'ERROR', finished_at = ?, result_json = ? WHERE id = ?`)
      .run(Date.now(), JSON.stringify({ error: 'insufficient historical bars — run a backfill first' }), runId);
    return { status: 'ERROR', error: 'insufficient bars' };
  }

  try {
    const raw = JSON.parse(run.config_json) as {
      strategy: 'SHORT_TERM' | 'LONG_TERM'; startDate: string; endDate: string;
      initialCapital: number; riskPerTradePct: number; maxOpenPositions: number;
    };
    const cfg = { ...raw, fillNextOpen: true } as {
      strategy: 'SHORT_TERM' | 'LONG_TERM'; startDate: string; endDate: string;
      initialCapital: number; riskPerTradePct: number; maxOpenPositions: number; fillNextOpen: true;
    };
    const result = await runBacktest({ bars, benchmark: bench, config: cfg });
    db.prepare(`UPDATE backtest_runs SET status = 'DONE', finished_at = ?, result_json = ?, violations = ? WHERE id = ?`)
      .run(Date.now(), JSON.stringify(result), result.violations.length, runId);
    recordStrategyPerformance(db, raw.strategy, result);
    db.prepare('INSERT INTO audit_log (ts, action, entity, entity_id, detail_json) VALUES (?, ?, ?, ?, ?)')
      .run(Date.now(), 'backtest_done', 'backtest', String(runId),
        JSON.stringify({ trades: result.trades.length, violations: result.violations.length }));
    return { status: 'DONE' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    db.prepare(`UPDATE backtest_runs SET status = 'ERROR', finished_at = ?, result_json = ? WHERE id = ?`)
      .run(Date.now(), JSON.stringify({ error: msg }), runId);
    return { status: 'ERROR', error: msg };
  }
}

/** Surface a finished run on the Strategies tab — without this row the
 *  strategy card renders an all-zero performance block while the real
 *  numbers sit only inside backtest_runs. */
function recordStrategyPerformance(
  db: DatabaseSync,
  strategy: 'SHORT_TERM' | 'LONG_TERM',
  result: {
    totalReturn?: number; benchmarkReturn?: number; excessReturn?: number;
    trades: Array<{ returnPct?: number }>;
  },
): void {
  const id = strategy === 'LONG_TERM' ? 'lt_quality_growth_v1' : 'st_multi_factor_v1';
  const trades = result.trades ?? [];
  const wins = trades.filter((t) => Number(t.returnPct ?? 0) > 0).length;
  // 0 trades means "never entered" (LONG_TERM backtests run with
  // fundamentals: null by design) — publishing 0% there would read as a
  // real flat return against a +13% benchmark, so the rates stay NULL.
  const hasTrades = trades.length > 0;
  db.prepare(
    `INSERT INTO strategy_performance (strategy, period, trades, wins, return_pct, benchmark_pct, excess_pct, updated_at)
     VALUES (?, 'all_time', ?, ?, ?, ?, ?, ?)
     ON CONFLICT(strategy, period) DO UPDATE SET
       trades = excluded.trades, wins = excluded.wins, return_pct = excluded.return_pct,
       benchmark_pct = excluded.benchmark_pct, excess_pct = excluded.excess_pct, updated_at = excluded.updated_at`,
  ).run(
    id, trades.length, wins,
    hasTrades ? (result.totalReturn ?? null) : null,
    hasTrades ? (result.benchmarkReturn ?? null) : null,
    hasTrades ? (result.excessReturn ?? null) : null,
    Date.now(),
  );
}

/** Kick off the bootstrap 1-year run once enough history exists. */
export function ensureInitialBacktest(db: DatabaseSync): { runId: number } | null {
  const any = db.prepare('SELECT id FROM backtest_runs LIMIT 1').get();
  if (any) return null;
  const barCount = db.prepare('SELECT COUNT(DISTINCT ticker) AS n FROM market_bars').get() as { n: number };
  if (barCount.n < 10) return null;
  const end = new Date();
  const start = new Date(Date.now() - 365 * 86400_000);
  const r = triggerBacktest(db, 'SHORT_TERM', start.toISOString().slice(0, 10), end.toISOString().slice(0, 10));
  return 'runId' in r ? r : null;
}
