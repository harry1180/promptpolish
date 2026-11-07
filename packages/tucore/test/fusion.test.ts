import { describe, expect, it } from 'vitest';
import { FUSION_WEIGHTS, fuse, fuseScore, fuseSignals } from '../src/fusion.ts';
import type { ScoreParts } from '../src/types.ts';

function parts(p: Partial<ScoreParts>): ScoreParts {
  return { technical: 0, fundamental: 0, event: 0, sentiment: 0, macro: 0, regime: 0, ...p };
}

describe('fusion', () => {
  it('default weights sum to 1 for every horizon; SWING/MEDIUM interpolate', () => {
    for (const h of ['SHORT', 'SWING', 'MEDIUM', 'LONG'] as const) {
      const sum = Object.values(FUSION_WEIGHTS[h]).reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(1, 12);
    }
    expect(FUSION_WEIGHTS.SHORT.technical).toBeCloseTo(0.38, 12);
    expect(FUSION_WEIGHTS.SHORT.fundamental).toBeCloseTo(0.06, 12);
    expect(FUSION_WEIGHTS.SHORT.event).toBeCloseTo(0.2, 12);
    expect(FUSION_WEIGHTS.SHORT.sentiment).toBeCloseTo(0.12, 12);
    expect(FUSION_WEIGHTS.SHORT.macro).toBeCloseTo(0.08, 12);
    expect(FUSION_WEIGHTS.SHORT.regime).toBeCloseTo(0.16, 12);
    expect(FUSION_WEIGHTS.LONG.fundamental).toBeCloseTo(0.45, 12);
    // monotone interpolation between SHORT and LONG
    expect(FUSION_WEIGHTS.SWING.technical).toBeLessThan(FUSION_WEIGHTS.SHORT.technical);
    expect(FUSION_WEIGHTS.SWING.technical).toBeGreaterThan(FUSION_WEIGHTS.MEDIUM.technical);
    expect(FUSION_WEIGHTS.MEDIUM.technical).toBeGreaterThan(FUSION_WEIGHTS.LONG.technical);
    expect(FUSION_WEIGHTS.SWING.fundamental).toBeLessThan(FUSION_WEIGHTS.MEDIUM.fundamental);
  });

  it('aligned strong parts -> BUY with hint-derived confidence', () => {
    const res = fuseSignals({
      parts: parts({ technical: 0.6, fundamental: 0.5, event: 0.4, sentiment: 0.3, macro: 0.2, regime: 0.5 }),
      horizon: 'SHORT',
      strategy: 'st_test',
      confidenceHint: 0.7,
      evidence: [],
      contradictions: [],
    });
    expect(res.action).toBe('BUY');
    expect(res.conflicts).toEqual([]);
    expect(res.weighted).toBeCloseTo(
      0.6 * 0.38 + 0.5 * 0.06 + 0.4 * 0.2 + 0.3 * 0.12 + 0.2 * 0.08 + 0.5 * 0.16,
      12,
    );
    expect(res.weighted).toBeGreaterThanOrEqual(0.3);
    expect(res.confidence).toBeCloseTo(0.7 * (0.7 + 0.3 * res.weighted), 12);
  });

  it('strong opposing heavyweight parts -> CONFLICTING_SIGNAL listing the keys', () => {
    const res = fuseSignals({
      parts: parts({ technical: 0.9, event: -0.9, regime: 0.1 }),
      horizon: 'SHORT',
      strategy: 'st_test',
      confidenceHint: 0.8,
      evidence: [],
      contradictions: [],
    });
    expect(res.action).toBe('CONFLICTING_SIGNAL');
    expect(res.conflicts).toContain('technical');
    expect(res.conflicts).toContain('event');
    expect(res.confidence).toBeLessThanOrEqual(0.4);
    expect(res.action).not.toBe('BUY');
    expect(res.action).not.toBe('SELL');
  });

  it('custom weights can create a conflict (both >= 0.15 after normalization)', () => {
    const res = fuseSignals({
      parts: parts({ technical: 0.8, fundamental: -0.8 }),
      horizon: 'SHORT',
      strategy: 'st_test',
      weights: { technical: 0.5, fundamental: 0.5 },
      confidenceHint: 0.8,
      evidence: [],
      contradictions: [],
    });
    expect(res.action).toBe('CONFLICTING_SIGNAL');
    expect(res.conflicts.sort()).toEqual(['fundamental', 'technical']);
  });

  it('weak parts -> NO_TRADE; moderate parts -> WATCH', () => {
    const weak = fuseSignals({
      parts: parts({ technical: 0.05, fundamental: 0.04, event: 0.03, regime: 0.05 }),
      horizon: 'SHORT',
      strategy: 'st_test',
      confidenceHint: 0.7,
      evidence: [],
      contradictions: [],
    });
    expect(weak.action).toBe('NO_TRADE');
    expect(Math.abs(weak.weighted)).toBeLessThan(0.15);

    const mid = fuseSignals({
      parts: parts({ technical: 0.4, event: 0.3, regime: 0.3 }),
      horizon: 'SHORT',
      strategy: 'st_test',
      confidenceHint: 0.7,
      evidence: [],
      contradictions: [],
    });
    expect(mid.action).toBe('WATCH');
    expect(Math.abs(mid.weighted)).toBeGreaterThanOrEqual(0.15);
    expect(Math.abs(mid.weighted)).toBeLessThan(0.3);
  });

  it('low confidenceHint can never produce BUY', () => {
    const strong = fuseSignals({
      parts: parts({ technical: 0.9, event: 0.9, regime: 0.8, sentiment: 0.5 }),
      horizon: 'SHORT',
      strategy: 'st_test',
      confidenceHint: 0.3,
      evidence: [],
      contradictions: [],
    });
    expect(strong.action).toBe('WATCH');
    expect(strong.action).not.toBe('BUY');
    // hint >= 0.55 flips the same parts to BUY
    const same = fuseSignals({
      parts: parts({ technical: 0.9, event: 0.9, regime: 0.8, sentiment: 0.5 }),
      horizon: 'SHORT',
      strategy: 'st_test',
      confidenceHint: 0.6,
      evidence: [],
      contradictions: [],
    });
    expect(same.action).toBe('BUY');
  });

  it('confident strong negative parts -> SELL', () => {
    const res = fuseSignals({
      parts: parts({ technical: -0.7, event: -0.6, regime: -0.5, sentiment: -0.4 }),
      horizon: 'SHORT',
      strategy: 'st_test',
      confidenceHint: 0.7,
      evidence: [],
      contradictions: [],
    });
    expect(res.action).toBe('SELL');
    expect(res.weighted).toBeLessThanOrEqual(-0.3);
  });

  it('partial caller weights are normalized to sum 1', () => {
    const res = fuseSignals({
      parts: parts({ technical: 1 }),
      horizon: 'SHORT',
      strategy: 'st_test',
      weights: { technical: 0.5, event: 0.5 },
      confidenceHint: 0.9,
      evidence: [],
      contradictions: [],
    });
    // merged over defaults: tech .5, fund .06, event .5, sent .12, macro .08, regime .16
    const expectedTech = 0.5 / (0.5 + 0.5 + 0.06 + 0.12 + 0.08 + 0.16);
    expect(res.weighted).toBeCloseTo(expectedTech, 12);
    expect(res.weighted).toBeLessThanOrEqual(1);
  });

  it('confidence is clamped to [0, 1] and capped at 0.4 on conflict', () => {
    const high = fuseSignals({
      parts: parts({ technical: 1, event: 1, regime: 1 }),
      horizon: 'SHORT',
      strategy: 'st_test',
      confidenceHint: 3,
      evidence: [],
      contradictions: [],
    });
    expect(high.confidence).toBeLessThanOrEqual(1);
    expect(high.confidence).toBeGreaterThanOrEqual(0);
  });

  it('aliases share the same behavior', () => {
    const input = {
      parts: parts({ technical: 0.6, event: 0.5, regime: 0.5 }),
      horizon: 'SWING' as const,
      strategy: 'sw_test',
      confidenceHint: 0.75,
      evidence: [],
      contradictions: [],
    };
    const a = fuseSignals(input);
    expect(fuse(input)).toEqual(a);
    expect(fuseScore(input)).toEqual(a);
  });
});