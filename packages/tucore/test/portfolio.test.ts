import { describe, expect, it } from 'vitest';
import { computeMetrics, dailyReturns, maxDrawdownFromSeries, sharpe, sortino } from '../src/portfolio.ts';
import type { EquityPoint, TradeRecord } from '../src/types.ts';

const T0 = Date.UTC(2025, 0, 2);
const DAY = 86400000;

function trade(id: number, entryPrice: number, exitPrice: number, qty = 100): TradeRecord {
  return {
    id,
    ticker: `T${id}`,
    portfolio: 'SHORT_TERM_PORTFOLIO',
    side: 'LONG',
    qty,
    entryPrice,
    entryTs: T0 + id * 10 * DAY,
    exitPrice,
    exitTs: T0 + (id * 10 + 5) * DAY,
    exitReason: 'TARGET_REACHED',
    target: entryPrice * 1.1,
    stop: entryPrice * 0.95,
    maxHoldSessions: 20,
    predictedReturn: 0.1,
  };
}

function curve(values: number[], spanDays: number): EquityPoint[] {
  const step = values.length > 1 ? spanDays / (values.length - 1) : 0;
  return values.map((equity, i) => ({ ts: T0 + Math.round(i * step) * DAY, equity }));
}

describe('computeMetrics', () => {
  const equityValues = [100000, 101000, 99000, 102000, 104000, 103000, 106000, 108000, 105000, 110000, 112000, 115000];
  const equitySeries = curve(equityValues, 200); // 200-day span >= 90 days
  const benchmarkSeries = curve(equityValues.map((_, i) => 100000 + i * (8000 / 11)), 200);
  // returns: 5 closed trades -> +10%, -5%, 0%, +20%, -2%
  const trades = [
    trade(1, 100, 110),
    trade(2, 100, 95),
    trade(3, 100, 100),
    trade(4, 100, 120),
    trade(5, 100, 98),
  ];

  const metrics = computeMetrics({
    startingCapital: 100000,
    cash: 5000,
    currentEquity: 115000,
    realizedPnl: 13000,
    unrealizedPnl: 2000,
    equitySeries,
    trades,
    benchmarkSeries,
    openNotional: 20000,
  });

  it('hand-computed 5-trade metrics', () => {
    expect(metrics.trades).toBe(5);
    expect(metrics.wins).toBe(2);
    expect(metrics.losses).toBe(2);
    expect(metrics.other).toBe(1);
    expect(metrics.winRate).toBeCloseTo(2 / 5, 12); // wins / closed trades
    // gross profit 1000+2000=3000, gross loss 500+200=700
    expect(metrics.profitFactor).toBeCloseTo(3000 / 700, 12);
    expect(metrics.expectancy).toBeCloseTo((0.1 - 0.05 + 0 + 0.2 - 0.02) / 5, 12);
    expect(metrics.avgWinner).toBeCloseTo(0.15, 12);
    expect(metrics.avgloser).toBeCloseTo(-0.035, 12);
    expect(metrics.bestTrade).toBeCloseTo(0.2, 12);
    expect(metrics.worstTrade).toBeCloseTo(-0.05, 12);
  });

  it('exact max drawdown of the equity curve', () => {
    // worst point is 105000 off a 108000 peak
    expect(metrics.maxDrawdown).toBeCloseTo(105000 / 108000 - 1, 12);
    expect(metrics.maxDrawdown).toBeLessThanOrEqual(0);
    expect(maxDrawdownFromSeries([100, 120, 90, 130])).toBeCloseTo(-0.25, 12);
    expect(maxDrawdownFromSeries([100])).toBeNull();
  });

  it('returns, benchmark and excess math', () => {
    expect(metrics.totalReturn).toBeCloseTo(115000 / 100000 - 1, 12);
    expect(metrics.benchmarkReturn).toBeCloseTo(108000 / 100000 - 1, 12);
    expect(metrics.excessReturn).toBeCloseTo(metrics.totalReturn - metrics.benchmarkReturn, 12);
    expect(metrics.turnover).toBeCloseTo(50000 / (equityValues.reduce((a, b) => a + b, 0) / 12), 12);
    expect(metrics.exposure).toBeCloseTo(20000 / 115000, 12);
  });

  it('CAGR from the equity time span (>= 90 days)', () => {
    const years = 200 / 365.25;
    expect(metrics.cagr).toBeCloseTo(Math.pow(1.15, 1 / years) - 1, 12);
    expect(metrics.cagr!).toBeGreaterThan(0);
  });

  it('sharpe/sortino/volatility from daily returns with an independent calculation', () => {
    const rets = dailyReturns(equitySeries);
    expect(rets.length).toBe(11);
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const varSample = rets.reduce((acc, r) => acc + (r - mean) ** 2, 0) / (rets.length - 1);
    const sd = Math.sqrt(varSample);
    expect(metrics.volatility).toBeCloseTo(sd * Math.sqrt(252), 12);
    expect(metrics.sharpe).toBeCloseTo((mean / sd) * Math.sqrt(252), 12);
    expect(sharpe(rets)).toBeCloseTo((mean / sd) * Math.sqrt(252), 12);
    const downside = Math.sqrt(rets.reduce((acc, r) => acc + (r < 0 ? r * r : 0), 0) / rets.length);
    expect(metrics.sortino).toBeCloseTo((mean / downside) * Math.sqrt(252), 12);
    expect(sortino(rets)).toBeCloseTo((mean / downside) * Math.sqrt(252), 12);
  });

  it('passes through the account fields', () => {
    expect(metrics.startingCapital).toBe(100000);
    expect(metrics.currentEquity).toBe(115000);
    expect(metrics.cash).toBe(5000);
    expect(metrics.realizedPnl).toBe(13000);
    expect(metrics.unrealizedPnl).toBe(2000);
  });

  it('nulls out statistics on empty input', () => {
    const empty = computeMetrics({
      startingCapital: 100000,
      cash: 100000,
      currentEquity: 100000,
      realizedPnl: 0,
      unrealizedPnl: 0,
      equitySeries: [],
      trades: [],
      benchmarkSeries: [],
    });
    expect(empty.totalReturn).toBe(0);
    expect(empty.winRate).toBeNull();
    expect(empty.profitFactor).toBeNull();
    expect(empty.expectancy).toBeNull();
    expect(empty.avgWinner).toBeNull();
    expect(empty.avgloser).toBeNull();
    expect(empty.bestTrade).toBeNull();
    expect(empty.worstTrade).toBeNull();
    expect(empty.cagr).toBeNull();
    expect(empty.sharpe).toBeNull();
    expect(empty.sortino).toBeNull();
    expect(empty.volatility).toBeNull();
    expect(empty.maxDrawdown).toBe(0);
    expect(empty.trades).toBe(0);
    expect(empty.benchmarkReturn).toBe(0);
    expect(empty.excessReturn).toBe(0);
  });

  it('fewer than 2 closed trades or fewer than 10 equity points -> nulls', () => {
    const oneTrade = computeMetrics({
      startingCapital: 100000,
      cash: 90000,
      currentEquity: 105000,
      realizedPnl: 5000,
      unrealizedPnl: 0,
      equitySeries: curve(new Array(12).fill(105000), 400),
      trades: [trade(1, 100, 105)],
      benchmarkSeries: [],
    });
    expect(oneTrade.winRate).toBeNull();
    expect(oneTrade.profitFactor).toBeNull();
    expect(oneTrade.expectancy).toBeNull();
    expect(oneTrade.bestTrade).toBeCloseTo(0.05, 12); // best/worst only need 1 closed trade

    const shortCurve = computeMetrics({
      startingCapital: 100000,
      cash: 50000,
      currentEquity: 101000,
      realizedPnl: 1000,
      unrealizedPnl: 0,
      equitySeries: curve([100000, 101000, 99000, 102000, 101500, 103000], 30), // 6 points
      trades: [trade(1, 100, 110), trade(2, 100, 90)],
      benchmarkSeries: [],
    });
    expect(shortCurve.sharpe).toBeNull();
    expect(shortCurve.sortino).toBeNull();
    expect(shortCurve.volatility).toBeNull();
    expect(shortCurve.cagr).toBeNull(); // 30 days < 90 days
    expect(shortCurve.winRate).not.toBeNull();
  });

  it('no downside -> sortino null; constant positive growth -> sharpe null, volatility 0', () => {
    // exact powers-of-two equity so every period return is exactly 1 (zero dispersion)
    const rising = curve(Array.from({ length: 12 }, (_, i) => 100000 * Math.pow(2, i)), 200);
    const res = computeMetrics({
      startingCapital: 100000,
      cash: 10000,
      currentEquity: rising[rising.length - 1].equity,
      realizedPnl: 10000,
      unrealizedPnl: 0,
      equitySeries: rising,
      trades: [],
      benchmarkSeries: curve(new Array(12).fill(100000), 200),
    });
    expect(res.sortino).toBeNull(); // no negative returns
    expect(res.sharpe).toBeNull(); // zero dispersion -> undefined
    expect(res.volatility).toBeCloseTo(0, 12);
    expect(dailyReturns(rising).every((r) => r === 1)).toBe(true);
  });
});

describe('dailyReturns', () => {
  it('computes simple period returns and skips zero bases', () => {
    const out = dailyReturns(curve([100, 110, 99], 2));
    expect(out).toHaveLength(2);
    expect(out[0]).toBeCloseTo(0.1, 12);
    expect(out[1]).toBeCloseTo(-0.1, 12);
    expect(dailyReturns([{ ts: 0, equity: 0 }, { ts: 1, equity: 50 }])).toEqual([]);
    expect(dailyReturns([])).toEqual([]);
  });
});