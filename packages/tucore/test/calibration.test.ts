import { describe, expect, it } from 'vitest';
import {
  CALIBRATION_MIN_SAMPLES, calibratedReturn, calibratedWinRate, fitCalibration,
} from '../src/calibration.ts';
import type { CalibrationSample } from '../src/calibration.ts';

const NOW = Date.parse('2026-11-24T21:00:00Z');
const DAY = 86_400_000;

/** n samples: predicted return always 10x too big, confidence ANTI-correlated
 *  with the outcome (exactly what the production book shows). */
function productionShape(): CalibrationSample[] {
  const out: CalibrationSample[] = [];
  for (let i = 0; i < 20; i++) {
    const high = i % 2 === 1; // odd index: high confidence, losing trade
    out.push({
      confidence: high ? 0.8 : 0.55,
      predictedReturn: 0.05,
      actualReturn: high ? -0.02 : 0.03,
      ts: NOW - (i + 1) * DAY,
    });
  }
  return out;
}

describe('fitCalibration', () => {
  it('shrinks a 10x-too-big forecast toward what actually happened', () => {
    const cal = fitCalibration(productionShape(), { now: NOW });
    expect(cal.n >= CALIBRATION_MIN_SAMPLES, `n=${cal.n}`).toBe(true);
    expect(cal.sufficient).toBe(true);
    const mapped = calibratedReturn(cal, 0.05);
    // the honest answer is near the book's own average outcome, not +5%
    expect(Math.abs(mapped)).toBeLessThan(0.03);
    expect(mapped).toBeLessThan(0.05);
    expect(Math.abs(cal.returnModel.r) < 0.01, 'a forecast with no information fits ~zero slope').toBe(true);
  });

  it('reports each confidence bucket its OWN realized win rate — no monotonicity forced', () => {
    const cal = fitCalibration(productionShape(), { now: NOW });
    const low = calibratedWinRate(cal, 0.55);
    const high = calibratedWinRate(cal, 0.8);
    expect(low > high, 'anti-correlated confidence must be visible, not smoothed away').toBe(true);
    expect(low).toBeGreaterThan(0.5);
    expect(high).toBeLessThan(0.5);
    expect(cal.buckets.reduce((s, b) => s + b.n, 0)).toBe(20);
  });

  it('below the evidence floor everything reports the prior', () => {
    const cal = fitCalibration(productionShape().slice(0, 3), { now: NOW });
    expect(cal.sufficient).toBe(false);
    expect(calibratedReturn(cal, 0.2)).toBeCloseTo(cal.priorMeanReturn, 10);
    expect(calibratedWinRate(cal, 0.9)).toBeCloseTo(cal.priorWinRate, 10);
    expect(cal.returnModel.slope).toBe(0);
  });

  it('recent outcomes outweigh old ones (60-session half-life)', () => {
    const recentWin: CalibrationSample = {
      confidence: 0.7, predictedReturn: 0.04, actualReturn: 0.05, ts: NOW - 1 * DAY,
    };
    const oldWins: CalibrationSample[] = Array.from({ length: 10 }, (_, i) => ({
      confidence: 0.7, predictedReturn: 0.04, actualReturn: -0.03, ts: NOW - (150 + i * 5) * DAY,
    }));
    const withRecent = fitCalibration([...oldWins, recentWin], { now: NOW });
    const withoutRecent = fitCalibration(oldWins, { now: NOW });
    expect(withRecent.priorWinRate).toBeGreaterThan(withoutRecent.priorWinRate);
  });

  it('empty history is safe', () => {
    const cal = fitCalibration([], { now: NOW });
    expect(cal.sufficient).toBe(false);
    expect(cal.n).toBe(0);
    expect(calibratedWinRate(cal, 0.8)).toBe(0.5);
    expect(calibratedReturn(cal, 0.1)).toBe(0);
  });
});
