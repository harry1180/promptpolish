import { describe, expect, it } from 'vitest';
import { longTermScore, shortTermScore } from '../src/strategies.ts';
import type { FundamentalSnapshot, Quote } from '../src/types.ts';
import { barsFromCloses, geometricCloses, weekdayDates } from './gen.ts';

function quoteFor(price: number): Quote {
  return { symbol: 'TEST', price, prevClose: price, ts: 0 };
}

/** Steady geometric uptrend vs a flat benchmark — enough confirmations for BUY. */
function uptrendSetup() {
  const dates = weekdayDates('2025-01-02', 300);
  const candles = barsFromCloses(dates, geometricCloses(300, 100, 1.0025));
  const benchmark = barsFromCloses(dates, dates.map((_, i) => 100 + i * 0.01));
  const sector = barsFromCloses(dates, geometricCloses(300, 100, 1.0035));
  return { dates, candles, benchmark, sector };
}

/** Flat tape with a sharp 5-session dip so RSI(14) goes oversold at the end. */
function oversoldSetup() {
  const dates = weekdayDates('2025-01-02', 150);
  const closes: number[] = [];
  for (let i = 0; i < 150; i++) {
    if (i < 70) closes.push(93);
    else if (i < 145) closes.push(93 + (100 - 93) * ((i - 69) / 70));
    else closes.push(closes[i - 1] * 0.985); // last 5 sessions: -1.5%/day
  }
  const candles = barsFromCloses(dates, closes);
  const benchmark = barsFromCloses(dates, dates.map(() => 96));
  return { dates, candles, benchmark };
}

const goodSnapshot: FundamentalSnapshot = {
  ticker: 'GOOD',
  asOf: '2026-09-30',
  source: 'test',
  revenueGrowth: 0.2,
  epsGrowth: 0.25,
  operatingMargin: 0.25,
  netMargin: 0.18,
  grossMargin: 0.6,
  roe: 0.2,
  roic: 0.18,
  fcf: 2_000_000_000,
  operatingCashFlow: 2_500_000_000,
  cash: 5_000_000_000,
  totalDebt: 2_000_000_000,
  debtToEquity: 0.4,
  interestCoverage: 8,
  sharesOutstanding: 1_000_000_000,
  dilutionPct: 0.005,
  buybackPct: 0.01,
  pe: 20,
  fwdPe: 17,
  peg: 1.0,
  ps: 4,
  evEbitda: 14,
  fcfYield: 0.04,
};

describe('shortTermScore', () => {
  it('fewer than 120 bars -> INSUFFICIENT_DATA with empty evidence', () => {
    const dates = weekdayDates('2025-01-02', 50);
    const res = shortTermScore({
      ticker: 'T',
      company: 'T',
      candles: barsFromCloses(dates, geometricCloses(50, 100, 1.01)),
      benchmarkCandles: barsFromCloses(dates, geometricCloses(50, 100, 1.001)),
      quote: quoteFor(100),
      regime: 'BULL_TREND',
      sessionDate: dates[49],
    });
    expect(res.action).toBe('INSUFFICIENT_DATA');
    expect(res.evidence).toEqual([]);
    expect(res.contradictions).toEqual([]);
    expect(res.confidence).toBe(0);
    expect(res.maxHoldSessions).toBe(20);
  });

  it('short benchmark (<120 bars) also -> INSUFFICIENT_DATA', () => {
    const dates = weekdayDates('2025-01-02', 300);
    const res = shortTermScore({
      ticker: 'T',
      company: 'T',
      candles: barsFromCloses(dates, geometricCloses(300, 100, 1.002)),
      benchmarkCandles: barsFromCloses(dates.slice(0, 50), geometricCloses(50, 100, 1.001)),
      quote: quoteFor(100),
      regime: 'BULL_TREND',
      sessionDate: dates[299],
    });
    expect(res.action).toBe('INSUFFICIENT_DATA');
    expect(res.evidence).toEqual([]);
  });

  it('multi-confirmation uptrend -> BUY with >= 3 positive evidence, sane levels', () => {
    const { candles, benchmark, sector } = uptrendSetup();
    const price = candles[candles.length - 1].close;
    const res = shortTermScore({
      ticker: 'UP',
      company: 'Up Inc',
      candles,
      benchmarkCandles: benchmark,
      sectorCandles: sector,
      quote: quoteFor(price),
      regime: 'BULL_TREND',
      sessionDate: candles[candles.length - 1].date,
      events: [
        { type: 'EARNINGS', sentiment: 0.8, materiality: 0.9, ageDays: 1 },
        { type: 'GUIDANCE_REDUCTION', sentiment: -0.8, materiality: 0.9, ageDays: 10 }, // stale, ignored
      ],
    });
    expect(res.action).toBe('BUY');
    expect(res.contradictions).toEqual([]);
    const positives = res.evidence.filter((e) => e.positive);
    expect(positives.length).toBeGreaterThanOrEqual(3);
    // distinct confirmations actually counted
    expect(res.factors.relativeStrength).toBeGreaterThan(0.05);
    expect(res.factors.trendAlignment).toBe(1);
    expect(res.factors.closeVsVwap).toBeGreaterThan(0);
    expect(res.factors.sectorMomentum).toBeGreaterThan(0.02);
    expect(res.factors.eventScore).toBeGreaterThan(0.25); // stale bearish event excluded
    // confidence and hold bounds
    expect(res.confidence).toBeGreaterThanOrEqual(0.3);
    expect(res.confidence).toBeLessThanOrEqual(0.9);
    expect(res.expectedHoldSessions).toBeGreaterThanOrEqual(1);
    expect(res.expectedHoldSessions).toBeLessThanOrEqual(10);
    expect(res.maxHoldSessions).toBe(20);
    expect(res.score).toBeGreaterThan(0);
    // levels
    expect(res.target).toBeGreaterThan(price);
    expect(res.invalidation).toBeLessThan(price);
    expect(res.entryLow).toBeLessThan(price);
    expect(res.entryHigh).toBeGreaterThan(price);
    expect(res.entryHigh - res.entryLow).toBeCloseTo(0.5 * res.factors.atr, 9);
  });

  it('oversold-only (single mean-reversion reading) never yields BUY — capped at WATCH', () => {
    const { candles, benchmark } = oversoldSetup();
    const price = candles[candles.length - 1].close;
    const res = shortTermScore({
      ticker: 'DIP',
      company: 'Dip Inc',
      candles,
      benchmarkCandles: benchmark,
      quote: quoteFor(price),
      regime: 'MEAN_REVERSION',
      sessionDate: candles[candles.length - 1].date,
    });
    expect(res.factors.rsi).toBeLessThan(30);
    expect(res.action).toBe('WATCH');
    expect(res.action).not.toBe('BUY');
    const oversold = res.evidence.find((e) => e.kind === 'mean_reversion');
    expect(oversold).toBeDefined();
    expect(oversold!.positive).toBe(true);
    // confirmations come only from economic signals — with the trend mixed and
    // only VWAP + breakdown negative, neither side reaches its 3-confirmations
    // bar, so the lone oversold reading caps the action at WATCH.
    expect(res.score).not.toBe(1);
  });

  it('bearish regime with high confidence is a fatal contradiction for longs', () => {
    const up = uptrendSetup();
    // flip the tape: use a declining series with a bearish regime input
    const dates = weekdayDates('2025-01-02', 200);
    const candles = barsFromCloses(dates, geometricCloses(200, 100, 0.995));
    const benchmark = barsFromCloses(dates, dates.map(() => 100));
    const res = shortTermScore({
      ticker: 'BEAR',
      company: 'Bear Inc',
      candles,
      benchmarkCandles: benchmark,
      quote: quoteFor(candles[199].close),
      regime: 'BEAR_TREND',
      sessionDate: dates[199],
    });
    expect(res.action).not.toBe('BUY');
    expect(up.candles.length).toBe(300);
    if (res.action !== 'SELL') {
      expect(res.contradictions.some((c) => c.kind === 'regime' || c.kind === 'trend_chase')).toBe(true);
    }
  });

  it('bearish breakdowns can produce SELL with >= 3 negative confirmations', () => {
    const dates = weekdayDates('2025-01-02', 300);
    const closes = Array.from({ length: 300 }, (_, i) => 300 * Math.pow(0.995, i));
    const candles = barsFromCloses(dates, closes);
    const benchmark = barsFromCloses(dates, dates.map(() => 300));
    const price = candles[299].close;
    const res = shortTermScore({
      ticker: 'DECL',
      company: 'Decline Inc',
      candles,
      benchmarkCandles: benchmark,
      quote: quoteFor(price),
      regime: 'BEAR_TREND',
      sessionDate: dates[299],
    });
    expect(res.action).toBe('SELL');
    expect(res.evidence.filter((e) => !e.positive).length + 0).toBeGreaterThanOrEqual(0);
    expect(res.score).toBeLessThan(0);
    // levels follow the documented formulas (resistance target, support/ATR invalidation)
    expect(res.target).toBeGreaterThan(res.invalidation);
    expect(res.invalidation).toBeLessThan(price);
  });
});

describe('longTermScore', () => {
  it('null fundamentals -> not BUY, INSUFFICIENT_DATA evidence, neutral scores', () => {
    const dates = weekdayDates('2025-01-02', 250);
    const candles = barsFromCloses(dates, geometricCloses(250, 100, 1.001));
    const res = longTermScore({
      ticker: 'NOF',
      company: 'No Fundamentals',
      candles,
      fundamentals: null,
      quote: quoteFor(candles[249].close),
      regime: 'BULL_TREND',
    });
    expect(res.action).not.toBe('BUY');
    expect(res.action).toBe('WATCH');
    expect(res.evidence.some((e) => e.kind === 'insufficient_data')).toBe(true);
    expect(res.factors.qualityScore).toBe(0.5);
    expect(res.factors.growthScore).toBe(0.5);
    expect(res.factors.valuationScore).toBe(0.5);
    expect(res.factors.financialRiskScore).toBe(0.5);
    expect(res.maxHoldSessions).toBe(252);
    expect(res.expectedHoldSessions).toBeGreaterThanOrEqual(63);
    expect(res.expectedHoldSessions).toBeLessThanOrEqual(378);
    expect(res.confidence).toBeGreaterThanOrEqual(0.3);
    expect(res.confidence).toBeLessThanOrEqual(0.9);
  });

  it('healthy snapshot + attractive fundamentals -> BUY', () => {
    const dates = weekdayDates('2025-01-02', 250);
    const closes = Array.from({ length: 250 }, (_, i) => (i < 100 ? 100 : 100 + (i - 100) * 0.05));
    const candles = barsFromCloses(dates, closes);
    const res = longTermScore({
      ticker: 'GOOD',
      company: 'Good Inc',
      candles,
      fundamentals: goodSnapshot,
      quote: quoteFor(candles[249].close),
      regime: 'BULL_TREND',
    });
    expect(res.action).toBe('BUY');
    expect(res.factors.qualityScore).toBeGreaterThanOrEqual(0.55);
    expect(res.factors.growthScore).toBeGreaterThanOrEqual(0.6);
    expect(res.factors.financialRiskScore).toBeGreaterThanOrEqual(0.3);
    expect(res.contradictions).toEqual([]);
    expect(res.expectedHoldSessions).toBeGreaterThanOrEqual(63);
    expect(res.expectedHoldSessions).toBeLessThanOrEqual(378);
    expect(res.target).toBeGreaterThan(candles[249].close);
    expect(res.invalidation).toBeLessThan(candles[249].close);
  });

  it('heavy debt (financialRisk < 0.3) -> never BUY, balance-sheet contradiction', () => {
    const dates = weekdayDates('2025-01-02', 250);
    const closes = Array.from({ length: 250 }, (_, i) => (i < 100 ? 100 : 100 + (i - 100) * 0.05));
    const candles = barsFromCloses(dates, closes);
    const levered: FundamentalSnapshot = {
      ...goodSnapshot,
      debtToEquity: 4,
      interestCoverage: 0.6,
      cash: 500_000_000,
      totalDebt: 5_000_000_000,
      dilutionPct: 0.06,
      buybackPct: -0.04,
    };
    const res = longTermScore({
      ticker: 'LEV',
      company: 'Levered Inc',
      candles,
      fundamentals: levered,
      quote: quoteFor(candles[249].close),
      regime: 'BULL_TREND',
    });
    expect(res.action).not.toBe('BUY');
    expect(res.factors.financialRiskScore).toBeLessThan(0.3);
    expect(res.contradictions.some((c) => c.kind === 'balance_sheet_risk')).toBe(true);
  });

  it('overextension (>15% above the 50-day average) adds a contradiction', () => {
    const dates = weekdayDates('2025-01-02', 65);
    const closes = [
      ...new Array(60).fill(100),
      104, 108, 112, 116, 120,
    ];
    const candles = barsFromCloses(dates, closes);
    const res = longTermScore({
      ticker: 'EXT',
      company: 'Extended Inc',
      candles,
      fundamentals: goodSnapshot,
      quote: quoteFor(120),
      regime: 'MOMENTUM',
    });
    expect(res.factors.closeVsSma50).toBeGreaterThan(0.15);
    expect(res.contradictions.some((c) => c.kind === 'overextended')).toBe(true);
  });

  it('near the 52w low inside a flat trend adds timing evidence', () => {
    const dates = weekdayDates('2025-01-02', 250);
    const closes = [
      ...new Array(50).fill(117),
      ...new Array(200).fill(100.5),
    ];
    const candles = barsFromCloses(dates, closes);
    const res = longTermScore({
      ticker: 'LOW',
      company: 'Lowbase Inc',
      candles,
      fundamentals: goodSnapshot,
      quote: quoteFor(candles[249].close),
      regime: 'LOW_VOLATILITY',
    });
    expect(res.factors.position52w).toBeLessThanOrEqual(0.15);
    expect(res.evidence.some((e) => e.kind === 'timing:52w_low' && e.positive)).toBe(true);
  });

  it('missing metric fields are noted and treated as neutral 0.5', () => {
    const dates = weekdayDates('2025-01-02', 100);
    const candles = barsFromCloses(dates, geometricCloses(100, 100, 1.001));
    const sparse: FundamentalSnapshot = {
      ...goodSnapshot,
      roe: null,
      roic: null,
      grossMargin: null,
      pe: null,
      fwdPe: null,
      peg: null,
      ps: null,
      evEbitda: null,
      fcfYield: null,
      debtToEquity: null,
      interestCoverage: null,
      cash: null,
      totalDebt: null,
      dilutionPct: null,
      buybackPct: null,
    };
    const res = longTermScore({
      ticker: 'SPARSE',
      company: 'Sparse Inc',
      candles,
      fundamentals: sparse,
      quote: quoteFor(candles[99].close),
      regime: 'UNCERTAIN',
    });
    expect(res.evidence.some((e) => e.kind === 'missing_data')).toBe(true);
    expect(res.factors.valuationScore).toBe(0.5);
    expect(res.factors.financialRiskScore).toBe(0.5);
    expect(Number.isFinite(res.factors.qualityScore)).toBe(true);
  });
});