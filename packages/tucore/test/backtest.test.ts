import { describe, expect, it } from 'vitest';
import { runBacktest } from '../src/backtest.ts';
import type { BacktestConfig } from '../src/backtest.ts';
import type { Candle } from '../src/types.ts';
import { weekdayDates } from './gen.ts';

/**
 * Scenario: 240 sessions. Sessions 0..199 are a flat sine wave around 100
 * (constant volume) where no BUY can fire — only trend-alignment and VWAP can
 * ever confirm, i.e. at most 2 of the 3 required confirmations. From session
 * 200 the price surges +1.5%/day on 6x volume. A point-in-time engine cannot
 * enter before the surge; an engine that peeked at future bars would enter
 * around session 121 (the first day with >= 120 bars). The entry assertions
 * below are that canary.
 */
const SURGE_START = 200;

function buildScenario() {
  const dates = weekdayDates('2025-01-02', 240);
  const closes: number[] = [];
  const volumes: number[] = [];
  for (let i = 0; i < dates.length; i++) {
    if (i < SURGE_START) {
      closes.push(100 + 0.6 * Math.sin(i / 9));
      volumes.push(500_000);
    } else {
      const base = closes[SURGE_START - 1];
      closes.push(base * Math.pow(1.015, i - SURGE_START + 1));
      volumes.push(3_000_000);
    }
  }
  const stock: Candle[] = dates.map((date, i) => {
    const close = closes[i];
    const open = i === 0 ? close : closes[i - 1];
    const high = Math.max(open, close) * 1.003;
    const low = Math.min(open, close) * 0.997;
    return { date, open, high, low, close, volume: volumes[i] };
  });
  const benchmark: Candle[] = dates.map((date, i) => {
    const close = 100 * Math.pow(1.0002, i);
    return { date, open: close, high: close * 1.001, low: close * 0.999, close, volume: 1_000_000 };
  });
  return { dates, stock, benchmark };
}

const baseConfig: BacktestConfig = {
  strategy: 'SHORT_TERM',
  startDate: '2025-01-01',
  endDate: '2026-12-31',
  initialCapital: 100_000,
  riskPerTradePct: 0.01,
  maxOpenPositions: 3,
  fillNextOpen: true,
};

describe('runBacktest', () => {
  const { dates, stock, benchmark } = buildScenario();
  const bars = { AAA: stock };
  const result = runBacktest({ bars, benchmark, config: baseConfig });

  it('produces trades with zero violations', () => {
    expect(result.violations).toEqual([]);
    expect(result.trades.length).toBeGreaterThanOrEqual(1);
    expect(result.barsUsed).toBe(240);
    expect(result.equity.length).toBe(240);
    expect(result.equity[0].date).toBe(dates[0]);
    expect(result.equity[239].date).toBe(dates[239]);
  });

  it('entryPrice equals the NEXT bar open exactly (never same-day close)', () => {
    const byDate = new Map(stock.map((b) => [b.date, b]));
    for (const t of result.trades) {
      const fillBar = byDate.get(t.entryDate);
      expect(fillBar).toBeDefined();
      expect(t.entryPrice).toBe(fillBar!.open);
      expect(t.qty).toBeGreaterThan(0);
      expect(t.returnPct).toBeCloseTo((t.exitPrice - t.entryPrice) / t.entryPrice, 12);
      expect(t.holdingDays).toBeGreaterThanOrEqual(0);
    }
    // no two trades on the same ticker overlap
    const sorted = [...result.trades].sort((a, b) => (a.entryDate < b.entryDate ? -1 : 1));
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i].entryDate > sorted[i - 1].exitDate).toBe(true);
    }
  });

  it('future-bar canary: no entry before the surge begins', () => {
    const index = new Map(dates.map((d, i) => [d, i]));
    expect(result.trades.length).toBeGreaterThanOrEqual(1);
    for (const t of result.trades) {
      const idx = index.get(t.entryDate);
      expect(idx).toBeDefined();
      // a lookahead engine would have entered around index 121
      expect(idx!).toBeGreaterThan(SURGE_START);
    }
    // entries strictly after their signal session: first possible signal day
    // with >= 120 bars is index 119, but no BUY exists before the surge
    const firstEntryIdx = Math.min(...result.trades.map((t) => index.get(t.entryDate)!));
    expect(firstEntryIdx).toBeGreaterThanOrEqual(SURGE_START + 1);
  });

  it('benchmark return matches a manual buy-and-hold calculation', () => {
    const manual = benchmark[benchmark.length - 1].close / benchmark[0].close - 1;
    expect(result.benchmarkReturn).toBeCloseTo(manual, 12);
    const lastEquity = result.equity[result.equity.length - 1].equity;
    expect(result.totalReturn).toBeCloseTo(lastEquity / baseConfig.initialCapital - 1, 12);
    expect(result.excessReturn).toBeCloseTo(result.totalReturn - result.benchmarkReturn, 12);
    expect(result.maxDrawdown).toBeLessThanOrEqual(0);
    expect(result.winRate).toBeGreaterThanOrEqual(0);
    expect(result.winRate).toBeLessThanOrEqual(1);
    expect(result.profitFactor).toBeGreaterThan(0); // all-closing-wins scenario -> Infinity
    expect(result.sharpe === null || typeof result.sharpe === 'number').toBe(true);
  });

  it('folds are contiguous, non-overlapping and cover the full range 60/20/20', () => {
    const folds = result.folds;
    expect(folds.map((f) => f.name)).toEqual(['TRAIN', 'VALIDATION', 'OUT_OF_SAMPLE']);
    expect(folds[0].start).toBe(dates[0]);
    expect(folds[0].end).toBe(dates[143]); // floor(240*0.6) = 144 sessions
    expect(folds[1].start).toBe(dates[144]);
    expect(folds[1].end).toBe(dates[191]); // + floor(240*0.2) = 48 sessions
    expect(folds[2].start).toBe(dates[192]);
    expect(folds[2].end).toBe(dates[239]);
    // contiguity: each fold starts the session after the previous ends
    expect(dates.indexOf(folds[1].start)).toBe(dates.indexOf(folds[0].end) + 1);
    expect(dates.indexOf(folds[2].start)).toBe(dates.indexOf(folds[1].end) + 1);
    // trades attributed by entryDate sum to all trades
    const attributed = folds.reduce((acc, f) => acc + f.trades, 0);
    expect(attributed).toBe(result.trades.length);
    for (const f of folds) {
      expect(Number.isFinite(f.returnPct)).toBe(true);
      expect(Number.isFinite(f.benchmarkReturnPct)).toBe(true);
      expect(f.trades).toBeGreaterThanOrEqual(0);
    }
    // fold benchmark returns are computed over the same windows
    expect(folds[1].benchmarkReturnPct).toBeCloseTo(benchmark[191].close / benchmark[143].close - 1, 12);
    expect(folds[2].benchmarkReturnPct).toBeCloseTo(benchmark[239].close / benchmark[191].close - 1, 12);
  });

  it('is fully deterministic across runs', () => {
    const again = runBacktest({ bars, benchmark, config: baseConfig });
    expect(again).toEqual(result);
  });

  it('respects maxOpenPositions and one-position-per-ticker', () => {
    const multi = runBacktest({
      bars: { AAA: stock, BBB: stock.map((b) => ({ ...b, close: b.close * 1.001 })) },
      benchmark,
      config: { ...baseConfig, maxOpenPositions: 1 },
    });
    expect(multi.violations).toEqual([]);
    // with max 1 position across 2 tickers, at most one trade in flight at a time
    const events = multi.trades.flatMap((t) => [
      { d: t.entryDate, kind: 'in' as const },
      { d: t.exitDate, kind: 'out' as const },
    ]).sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : a.kind === 'in' ? -1 : 1));
    let open = 0;
    for (const e of events) {
      open += e.kind === 'in' ? 1 : -1;
      expect(open).toBeLessThanOrEqual(1);
      expect(open).toBeGreaterThanOrEqual(0);
    }
  });

  it('LONG_TERM with no point-in-time fundamentals yields no fabricated trades', () => {
    const lt = runBacktest({ bars, benchmark, config: { ...baseConfig, strategy: 'LONG_TERM' } });
    expect(lt.violations).toEqual([]);
    expect(lt.trades).toEqual([]);
    expect(lt.equity.length).toBe(240);
    expect(lt.winRate).toBe(0);
    expect(lt.profitFactor).toBe(0);
    expect(lt.barsUsed).toBe(240);
  });

  it('empty range returns an empty result instead of throwing', () => {
    const empty = runBacktest({ bars, benchmark, config: { ...baseConfig, startDate: '2030-01-01', endDate: '2030-12-31' } });
    expect(empty.trades).toEqual([]);
    expect(empty.equity).toEqual([]);
    expect(empty.folds).toEqual([]);
    expect(empty.totalReturn).toBe(0);
    expect(empty.violations).toEqual([]);
  });
});