/**
 * Deterministic, point-in-time daily backtester.
 *
 * - Iterates benchmark dates inside [startDate, endDate]; a decision made on
 *   day d reads ONLY bars with date <= d (slices), and entries fill at the
 *   NEXT bar's open (entryPrice === next bar open, never same-day close).
 * - `violations` records any future-bar read or same-day-close fill; a correct
 *   run keeps it empty.
 * - LONG_TERM runs pass fundamentals: null (no point-in-time fundamental data
 *   exists in this input), so they produce no entries rather than fabricating
 *   data.
 * - Sizing uses positionSizeShares with a 20% max-position cap and a 1.5% stop
 *   distance below the fill open; one position per ticker, maxOpenPositions
 *   cap counting both open and queued entries.
 * - Folds: TRAIN/VALIDATION/OUT_OF_SAMPLE split 60/20/20 by contiguous dates;
 *   trades are attributed by entryDate; per-fold return compares fold equity
 *   (or benchmark) against the value just before the fold.
 */
import type { Candle, EquityPoint, ExitReason, Quote } from './types.ts';
import { checkExit } from './broker.ts';
import { positionSizeShares } from './risk.ts';
import { detectRegime } from './regime.ts';
import { longTermScore, shortTermScore } from './strategies.ts';
import { dailyReturns, maxDrawdownFromSeries, sharpe } from './portfolio.ts';

export interface BacktestConfig {
  strategy: 'SHORT_TERM' | 'LONG_TERM';
  startDate: string;
  endDate: string;
  initialCapital: number;
  riskPerTradePct: number;
  maxOpenPositions: number;
  fillNextOpen: true;
}

export interface BacktestTrade {
  ticker: string;
  entryDate: string;
  entryPrice: number;
  exitDate: string;
  exitPrice: number;
  qty: number;
  returnPct: number;
  exitReason: ExitReason;
  holdingDays: number;
}

export interface BacktestFold {
  name: 'TRAIN' | 'VALIDATION' | 'OUT_OF_SAMPLE';
  start: string;
  end: string;
  returnPct: number;
  benchmarkReturnPct: number;
  trades: number;
}

export interface BacktestResult {
  trades: BacktestTrade[];
  equity: Array<{ date: string; equity: number }>;
  totalReturn: number;
  benchmarkReturn: number;
  excessReturn: number;
  maxDrawdown: number;
  winRate: number;
  profitFactor: number;
  sharpe: number | null;
  folds: BacktestFold[];
  violations: string[];
  barsUsed: number;
}

/** Max position fraction of equity used by the backtester's sizing cap. */
const MAX_POSITION_PCT = 0.2;

function byDate(a: Candle, b: Candle): number {
  return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
}

function indexOfWeek(arr: Candle[], date: string): number {
  for (let i = 0; i < arr.length; i++) if (arr[i].date === date) return i;
  return -1;
}

export function runBacktest(input: {
  bars: Record<string, Candle[]>;
  benchmark: Candle[];
  config: BacktestConfig;
}): BacktestResult {
  const { config } = input;
  const violations: string[] = [];
  if (config.fillNextOpen !== true) violations.push('fillNextOpen must be true for point-in-time next-open fills');

  const tickers = Object.keys(input.bars).sort();
  const sorted: Record<string, Candle[]> = {};
  let barsUsed = 0;
  for (const t of tickers) {
    const arr = [...input.bars[t]].sort(byDate);
    sorted[t] = arr;
    for (const c of arr) if (c.date >= config.startDate && c.date <= config.endDate) barsUsed++;
  }

  const benchAll = [...input.benchmark].sort(byDate);
  const benchInRange = benchAll.filter((b) => b.date >= config.startDate && b.date <= config.endDate);
  const dates = benchInRange.map((b) => b.date);
  const n = dates.length;

  const emptyResult = (): BacktestResult => ({
    trades: [],
    equity: [],
    totalReturn: 0,
    benchmarkReturn: 0,
    excessReturn: 0,
    maxDrawdown: 0,
    winRate: 0,
    profitFactor: 0,
    sharpe: null,
    folds: [],
    violations,
    barsUsed,
  });
  if (n === 0) return emptyResult();

  interface OpenPos {
    ticker: string;
    entryDate: string;
    entryPrice: number;
    qty: number;
    target: number;
    stop: number;
    maxHold: number;
    sessionsHeld: number;
    barIdx: number;
    lastClose: number;
  }
  interface PendingEntry {
    ticker: string;
    signalDate: string;
    fillDate: string;
    target: number;
    stop: number;
    maxHold: number;
  }

  const cursor: Record<string, number> = {};
  const lastClose: Record<string, number> = {};
  for (const t of tickers) cursor[t] = -1;

  let cash = config.initialCapital;
  const open = new Map<string, OpenPos>();
  const pending: PendingEntry[] = [];
  const trades: BacktestTrade[] = [];
  const equityCurve: Array<{ date: string; equity: number }> = [];

  let benchIdx = -1; // index into benchAll of the last bar with date <= d

  for (const d of dates) {
    // 1. advance per-ticker cursors to the last bar on or before d
    for (const t of tickers) {
      const arr = sorted[t];
      while (cursor[t] + 1 < arr.length && arr[cursor[t] + 1].date <= d) {
        cursor[t]++;
        lastClose[t] = arr[cursor[t]].close;
      }
    }
    while (benchIdx + 1 < benchAll.length && benchAll[benchIdx + 1].date <= d) benchIdx++;

    // 2. fill queued entries at their next-bar open (fillDate <= d)
    for (let pi = pending.length - 1; pi >= 0; pi--) {
      const p = pending[pi];
      if (p.fillDate > d) continue;
      pending.splice(pi, 1);
      const arr = sorted[p.ticker];
      const fi = indexOfWeek(arr, p.fillDate);
      if (fi < 0) continue;
      const fillBar = arr[fi];
      if (p.signalDate === fillBar.date) violations.push(`${p.ticker}: same-day fill on ${d}`);
      const entryPrice = fillBar.open;
      if (!(entryPrice - p.stop > 0)) continue; // invalid stop at fill time
      if (open.has(p.ticker) || open.size >= config.maxOpenPositions) continue;
      const eq = equityCurve.length > 0 ? equityCurve[equityCurve.length - 1].equity : config.initialCapital;
      const shares = positionSizeShares(eq, config.riskPerTradePct, entryPrice, p.stop, MAX_POSITION_PCT, cash);
      if (shares <= 0 || shares * entryPrice > cash) continue;
      cash -= shares * entryPrice;
      open.set(p.ticker, {
        ticker: p.ticker,
        entryDate: fillBar.date,
        entryPrice,
        qty: shares,
        target: p.target,
        stop: p.stop,
        maxHold: p.maxHold,
        sessionsHeld: 0,
        barIdx: fi,
        lastClose: fillBar.close,
      });
    }

    // 3. exit checks on every bar after the entry bar, on or before d
    for (const pos of [...open.values()]) {
      const arr = sorted[pos.ticker];
      let idx = pos.barIdx + 1;
      while (idx < arr.length && arr[idx].date <= d) {
        const bar = arr[idx];
        pos.sessionsHeld++;
        const reason = checkExit(
          {
            side: 'LONG',
            entryPrice: pos.entryPrice,
            qty: pos.qty,
            target: pos.target,
            stop: pos.stop,
            trailingStop: null,
            maxHoldSessions: pos.maxHold,
            sessionsHeld: pos.sessionsHeld,
            thesisInvalidated: false,
            sellSignal: false,
            regimeChanged: false,
          },
          { open: bar.open, high: bar.high, low: bar.low, close: bar.close, date: bar.date },
        );
        idx++;
        pos.lastClose = bar.close;
        if (reason !== null) {
          let exitPrice: number;
          if (reason === 'STOP_REACHED') exitPrice = bar.open <= pos.stop ? bar.open : pos.stop;
          else if (reason === 'TARGET_REACHED') exitPrice = bar.open >= pos.target ? bar.open : pos.target;
          else exitPrice = bar.close;
          cash += pos.qty * exitPrice;
          const holdingDays = Math.round((Date.parse(bar.date) - Date.parse(pos.entryDate)) / 86400000);
          trades.push({
            ticker: pos.ticker,
            entryDate: pos.entryDate,
            entryPrice: pos.entryPrice,
            exitDate: bar.date,
            exitPrice,
            qty: pos.qty,
            returnPct: (exitPrice - pos.entryPrice) / pos.entryPrice,
            exitReason: reason,
            holdingDays,
          });
          open.delete(pos.ticker);
          break;
        }
      }
      pos.barIdx = idx - 1;
    }

    // 4. signals from data <= d only; entries queued for the NEXT bar's open
    const pendingTickers = new Set(pending.map((p) => p.ticker));
    if (open.size + pending.length < config.maxOpenPositions) {
      const benchCandles = benchIdx >= 0 ? benchAll.slice(0, benchIdx + 1) : [];
      for (const t of tickers) {
        if (open.has(t) || pendingTickers.has(t)) continue;
        const arr = sorted[t];
        const ci = cursor[t];
        if (ci < 0) continue;
        const candles = arr.slice(0, ci + 1);
        const lastBar = candles[candles.length - 1];
        const prevBar = candles[candles.length - 2];
        const quote: Quote = {
          symbol: t,
          price: lastBar.close,
          prevClose: prevBar ? prevBar.close : lastBar.close,
          ts: Date.parse(lastBar.date) || 0,
        };
        const regime = detectRegime(candles, { spyCandles: benchCandles }).regime;
        const result =
          config.strategy === 'SHORT_TERM'
            ? shortTermScore({ ticker: t, company: t, candles, benchmarkCandles: benchCandles, quote, regime, sessionDate: d })
            : longTermScore({ ticker: t, company: t, candles, fundamentals: null, quote, regime });
        if (result.action !== 'BUY') continue;
        let ni = -1;
        for (let i = ci + 1; i < arr.length; i++) {
          if (arr[i].date > d) {
            ni = i;
            break;
          }
        }
        if (ni < 0) continue; // no next bar -> cannot fill; drop the signal
        const fillDate = arr[ni].date;
        if (fillDate <= d) violations.push(`${t}: entry scheduled same-day on ${d}`);
        pending.push({ ticker: t, signalDate: d, fillDate, target: result.target, stop: result.invalidation, maxHold: result.maxHoldSessions });
      }
    }

    // 5. mark to close
    let equity = cash;
    for (const pos of open.values()) equity += pos.qty * (lastClose[pos.ticker] ?? pos.lastClose);
    equityCurve.push({ date: d, equity });
  }

  // Metrics
  let wins = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  for (const t of trades) {
    const pnl = t.qty * (t.exitPrice - t.entryPrice);
    if (t.returnPct > 0) {
      wins++;
      grossProfit += pnl;
    } else if (t.returnPct < 0) {
      grossLoss += -pnl;
    }
  }
  const winRate = trades.length > 0 ? wins / trades.length : 0;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  const totalReturn = equityCurve[equityCurve.length - 1].equity / config.initialCapital - 1;
  const benchmarkReturn = benchInRange.length >= 2 ? benchInRange[benchInRange.length - 1].close / benchInRange[0].close - 1 : 0;
  const equityPoints: EquityPoint[] = equityCurve.map((p) => ({ ts: Date.parse(p.date) || 0, equity: p.equity }));
  const maxDrawdown = maxDrawdownFromSeries(equityCurve.map((p) => p.equity)) ?? 0;

  // Folds: 60/20/20 contiguous by date
  const nTrain = Math.floor(n * 0.6);
  const nVal = Math.floor(n * 0.2);
  const ranges: Array<{ name: 'TRAIN' | 'VALIDATION' | 'OUT_OF_SAMPLE'; s: number; e: number }> = [
    { name: 'TRAIN', s: 0, e: nTrain - 1 },
    { name: 'VALIDATION', s: nTrain, e: nTrain + nVal - 1 },
    { name: 'OUT_OF_SAMPLE', s: nTrain + nVal, e: n - 1 },
  ];
  const idx0 = indexOfWeek(benchAll, dates[0]);
  const folds: BacktestFold[] = [];
  for (const r of ranges) {
    if (r.e < r.s || r.s < 0 || r.e >= n) continue;
    const base = r.s === 0 ? config.initialCapital : equityCurve[r.s - 1].equity;
    const end = equityCurve[r.e].equity;
    const benchBase = r.s === 0 ? (idx0 > 0 ? benchAll[idx0 - 1].close : benchInRange[0].close) : benchInRange[r.s - 1].close;
    const benchEnd = benchInRange[r.e].close;
    const start = dates[r.s];
    const stopDate = dates[r.e];
    let foldTrades = 0;
    for (const t of trades) if (t.entryDate >= start && t.entryDate <= stopDate) foldTrades++;
    folds.push({
      name: r.name,
      start,
      end: stopDate,
      returnPct: base !== 0 ? end / base - 1 : 0,
      benchmarkReturnPct: benchBase !== 0 ? benchEnd / benchBase - 1 : 0,
      trades: foldTrades,
    });
  }

  return {
    trades,
    equity: equityCurve,
    totalReturn,
    benchmarkReturn,
    excessReturn: totalReturn - benchmarkReturn,
    maxDrawdown,
    winRate,
    profitFactor,
    sharpe: sharpe(dailyReturns(equityPoints)),
    folds,
    violations,
    barsUsed,
  };
}