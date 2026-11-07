/**
 * Gate A/B — re-apply the production entry gates to the stored SHORT_TERM
 * backtest trades and recompute quality metrics. Offline analysis only;
 * never imported by the server at runtime.
 *
 * Gates replicated (in production order, from engine.ts):
 *   1. adverse-regime veto — ADVERSE_LONG_REGIMES.includes(regime), with
 *      regime recomputed per entry via the SAME call the backtest itself
 *      used: detectRegime(tickerCandlesUpToEntry, { spyCandles: spyUpToEntry }).
 *   2. re-entry cooldown — no entry within `cooldown` sessions of the last
 *      STOP_REACHED exit of the same ticker among KEPT trades, using
 *      countTradingDays semantics exactly like reentryCooldownActive().
 *
 * NOT backtestable (stated, not silently dropped):
 *   - the confidence floor: the backtest records no per-trade fused confidence.
 *   - the earnings blackout: there is no historical earnings calendar.
 *   - fusion/LLM gates: the backtest trades are single-strategy score entries.
 *
 * Usage: node apps/server/scripts/gate-ab.ts <tradingusa.db> [cooldownSessions]
 */
import { DatabaseSync } from 'node:sqlite';
import { detectRegime, countTradingDays } from '@promptslim/tucore';
import type { Candle } from '@promptslim/tucore';
import { ADVERSE_LONG_REGIMES } from '../src/tradingusa/engine.ts';

interface BtTrade {
  ticker: string;
  entryDate: string;
  entryPrice: number;
  exitDate: string;
  exitPrice: number;
  qty: number;
  returnPct: number;
  exitReason: string;
  holdingDays: number;
}

interface Stats {
  trades: number;
  wins: number;
  winRatePct: number | null;
  expectancyPct: number | null;
  avgWinPct: number | null;
  avgLossPct: number | null;
  profitFactor: number | null;
  stopSharePct: number | null;
  sumReturnPct: number;
}

function stats(trades: BtTrade[]): Stats {
  const n = trades.length;
  if (n === 0) {
    return { trades: 0, wins: 0, winRatePct: null, expectancyPct: null, avgWinPct: null, avgLossPct: null, profitFactor: null, stopSharePct: null, sumReturnPct: 0 };
  }
  const winsArr = trades.filter((t) => t.returnPct > 0).map((t) => t.returnPct * 100);
  const lossArr = trades.filter((t) => t.returnPct < 0).map((t) => t.returnPct * 100);
  const grossWin = winsArr.reduce((s, r) => s + r, 0);
  const grossLoss = Math.abs(lossArr.reduce((s, r) => s + r, 0));
  const sum = trades.reduce((s, t) => s + t.returnPct * 100, 0);
  const stops = trades.filter((t) => t.exitReason === 'STOP_REACHED').length;
  return {
    trades: n,
    wins: winsArr.length,
    winRatePct: (winsArr.length / n) * 100,
    expectancyPct: sum / n,
    avgWinPct: winsArr.length ? grossWin / winsArr.length : null,
    avgLossPct: lossArr.length ? -grossLoss / lossArr.length : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    stopSharePct: (stops / n) * 100,
    sumReturnPct: sum,
  };
}

function loadBars(db: DatabaseSync, ticker: string): Candle[] {
  return db
    .prepare('SELECT date, open, high, low, close, volume FROM market_bars WHERE ticker = ? ORDER BY date')
    .all(ticker) as unknown as Candle[];
}

/** index of the last bar with date <= target (binary search) */
function idxUpto(bars: Candle[], date: string): number {
  let lo = 0;
  let hi = bars.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].date <= date) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return ans;
}

function main(): void {
  const dbPath = process.argv[2];
  if (!dbPath) {
    console.error('usage: node gate-ab.ts <tradingusa.db> [cooldownSessions]');
    process.exit(1);
  }
  const cooldown = Number(process.argv[3] ?? 5);
  const db = new DatabaseSync(dbPath, { readOnly: true });

  const run = db.prepare(
    `SELECT id, start_date, end_date, result_json FROM backtest_runs
     WHERE status = 'DONE' AND strategy = 'SHORT_TERM' ORDER BY id DESC LIMIT 1`,
  ).get() as { id: number; start_date: string; end_date: string; result_json: string } | undefined;
  if (!run) { console.error('no DONE SHORT_TERM backtest run'); process.exit(1); }

  const result = JSON.parse(run.result_json) as { trades?: BtTrade[] };
  const trades = [...(result.trades ?? [])].sort((a, b) =>
    a.entryDate === b.entryDate ? a.exitDate.localeCompare(b.exitDate) : a.entryDate.localeCompare(b.entryDate),
  );

  // bars: every traded ticker + SPY (the backtest's own regime inputs)
  const bars = new Map<string, Candle[]>();
  for (const t of trades) if (!bars.has(t.ticker)) bars.set(t.ticker, loadBars(db, t.ticker));
  const spy = loadBars(db, 'SPY');

  interface Bucket { trades: BtTrade[]; regimes: Map<string, number> }
  const kept: Bucket = { trades: [], regimes: new Map() };
  const blockedRegime: Bucket = { trades: [], regimes: new Map() };
  const blockedCooldown: Bucket = { trades: [], regimes: new Map() };
  let shortHistoryNotGated = 0;

  const lastStop = new Map<string, string>(); // ticker -> exitDate of last KEPT stop
  const bump = (b: Bucket, r: string): void => { b.regimes.set(r, (b.regimes.get(r) ?? 0) + 1); };

  for (const t of trades) {
    const ti = idxUpto(bars.get(t.ticker) ?? [], t.entryDate);
    const si = idxUpto(spy, t.entryDate);
    let regime = 'NO_DATA';
    let shortHistory = false;
    if (ti >= 0 && si >= 0) {
      const upTo = (arr: Candle[], i: number): Candle[] => arr.slice(0, i + 1);
      const det = detectRegime(upTo(bars.get(t.ticker)!, ti), { spyCandles: upTo(spy, si) });
      regime = det.regime;
      shortHistory = ti < 99; // detectRegime returns UNCERTAIN under 100 bars — an artifact here, not a market call
      if (shortHistory) shortHistoryNotGated += 1;
    }

    if (!shortHistory && ADVERSE_LONG_REGIMES.includes(regime as (typeof ADVERSE_LONG_REGIMES)[number])) {
      blockedRegime.trades.push(t); bump(blockedRegime, regime);
      continue;
    }

    const stop = lastStop.get(t.ticker);
    let cooled = false;
    if (stop && cooldown > 0) {
      cooled = stop >= t.entryDate || countTradingDays(stop, t.entryDate) <= cooldown;
    }
    if (cooled) {
      blockedCooldown.trades.push(t); bump(blockedCooldown, regime);
      continue;
    }

    kept.trades.push(t); bump(kept, regime);
    if (t.exitReason === 'STOP_REACHED') lastStop.set(t.ticker, t.exitDate);
  }

  const out = {
    run: { id: run.id, start: run.start_date, end: run.end_date, cooldownSessions: cooldown },
    note: 'confidence floor + earnings blackout NOT backtestable (not stored per trade); fusion/LLM gates not modeled',
    baseline: stats(trades),
    gated: stats(kept.trades),
    blockedByRegime: { ...stats(blockedRegime.trades), regimeCounts: Object.fromEntries(blockedRegime.regimes) },
    blockedByCooldown: stats(blockedCooldown.trades),
    keptRegimeCounts: Object.fromEntries(kept.regimes),
    shortHistoryNotGated,
  };

  const fmt = (s: Stats): string =>
    `n=${s.trades} win=${s.winRatePct === null ? '—' : s.winRatePct.toFixed(1) + '%'} ` +
    `exp=${s.expectancyPct === null ? '—' : s.expectancyPct.toFixed(3) + '%'} ` +
    `PF=${s.profitFactor === null ? '—' : s.profitFactor.toFixed(2)} ` +
    `stops=${s.stopSharePct === null ? '—' : s.stopSharePct.toFixed(0) + '%'}`;

  console.log(`run #${run.id}  ${run.start_date} → ${run.end_date}  cooldown=${cooldown} sessions`);
  console.log(`BASELINE (ungated) : ${fmt(out.baseline)}`);
  console.log(`GATED (regime+cool) : ${fmt(out.gated)}`);
  console.log(`blocked by regime   : ${fmt(out.blockedByRegime)}  ${JSON.stringify(out.blockedByRegime.regimeCounts)}`);
  console.log(`blocked by cooldown : ${fmt(out.blockedByCooldown)}`);
  console.log(`kept regime mix     : ${JSON.stringify(out.keptRegimeCounts)}`);
  console.log(`short-history artifacts not gated: ${shortHistoryNotGated}`);
  console.log(JSON.stringify(out, null, 1));
}

main();