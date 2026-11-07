import { describe, expect, it } from 'vitest';
import { detectRegime } from '../src/regime.ts';
import type { Candle } from '../src/types.ts';
import { barsFromCloses, geometricCloses, weekdayDates } from './gen.ts';

function uptrendBars(n: number, daily: number): Candle[] {
  const dates = weekdayDates('2025-01-02', n);
  return barsFromCloses(dates, geometricCloses(n, 100, 1 + daily));
}

/**
 * Smooth 0.1%/day advance followed by a 20-session crash with VARYING daily
 * drops (~-18% cumulative): the varying drops give the crash window genuinely
 * high realized vol vs the calm advance, which is what volPercentile detects.
 */
function crashedBars(): Candle[] {
  const up = barsFromCloses(weekdayDates('2025-01-02', 280), geometricCloses(280, 100, 1.001));
  const peak = up[up.length - 1].close;
  const factors = [0.996, 0.985, 0.992, 0.981, 0.997, 0.988, 0.983, 0.994, 0.986, 0.994];
  const crashCloses: number[] = [];
  let p = peak;
  for (let i = 0; i < 20; i++) {
    p *= factors[i % 10];
    crashCloses.push(p);
  }
  const crash = barsFromCloses(weekdayDates('2026-02-13', 20), crashCloses);
  return [...up, ...crash];
}

describe('detectRegime', () => {
  it('strong 300-bar uptrend -> MOMENTUM with high confidence and raw components', () => {
    const bars = uptrendBars(300, 0.0025);
    const det = detectRegime(bars);
    expect(det.regime).toBe('MOMENTUM');
    expect(det.confidence).toBeGreaterThan(0.7);
    expect(det.confidence).toBeLessThanOrEqual(1);
    expect(det.components.closeVsSma200).toBeGreaterThan(0);
    expect(det.components.sma50Slope).toBeGreaterThan(0);
    expect(det.components.trailing60dReturn).toBeGreaterThan(0.1);
    expect(det.components.drawdownFromHigh).toBeLessThanOrEqual(0);
    expect(det.components.volPercentile).toBeGreaterThanOrEqual(0);
    expect(det.components.volPercentile).toBeLessThanOrEqual(1);
  });

  it('steady long decline -> BEAR_TREND', () => {
    const bars = uptrendBars(300, -0.001);
    const det = detectRegime(bars);
    expect(det.regime).toBe('BEAR_TREND');
    expect(det.components.drawdownFromHigh).toBeLessThan(-0.2);
    expect(det.components.closeVsSma200).toBeLessThan(0);
  });

  it('sharp crash -> HIGH_VOLATILITY', () => {
    const bars = crashedBars();
    const det = detectRegime(bars);
    expect(det.regime).toBe('HIGH_VOLATILITY');
    expect(det.components.volPercentile).toBeGreaterThanOrEqual(0.9);
    expect(det.components.drawdownFromHigh).toBeLessThanOrEqual(-0.15);
    expect(det.components.drawdownFromHigh).toBeGreaterThan(-0.25);
  });

  it('crash plus collapsing breadth -> LIQUIDITY_STRESS', () => {
    const det = detectRegime(crashedBars(), { breadth: { advancers: 200, decliners: 4800 } });
    expect(det.regime).toBe('LIQUIDITY_STRESS');
    expect(det.components.breadth).toBeLessThan(-0.35);
  });

  it('< 100 bars -> UNCERTAIN with capped confidence', () => {
    const det = detectRegime(uptrendBars(80, 0.005));
    expect(det.regime).toBe('UNCERTAIN');
    expect(det.confidence).toBeLessThanOrEqual(0.3);
    expect(det.components).toEqual({});
  });

  it('benchmark and breadth readings are exposed when provided', () => {
    const bars = uptrendBars(150, 0.001);
    const spy = barsFromCloses(weekdayDates('2025-01-02', 150), geometricCloses(150, 500, 1.002));
    const det = detectRegime(bars, { spyCandles: spy, breadth: { advancers: 3000, decliners: 2000 } });
    expect(det.components.benchCloseVsSma200).toBeDefined();
    expect(det.components.benchTrailing60d).toBeDefined();
    expect(det.components.breadth).toBeCloseTo(0.2, 10);
    expect(Number.isFinite(det.confidence)).toBe(true);
  });
});