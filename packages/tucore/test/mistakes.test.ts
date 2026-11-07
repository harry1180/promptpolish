import { describe, expect, it } from 'vitest';
import { MISTAKE_KINDS, classifyMistake } from '../src/mistakes.ts';
import type { MistakeInput } from '../src/mistakes.ts';
import type { ExitReason, MistakeKind, Regime } from '../src/types.ts';

function input(overrides: Partial<MistakeInput> = {}): MistakeInput {
  return {
    lossPct: 0,
    exitReason: null,
    regimeAtEntry: 'BULL_TREND',
    regimeAtExit: 'BULL_TREND',
    volatilitySpike: false,
    newsMisinterpreted: false,
    sourceFailure: false,
    staleInfo: false,
    positionSizedOverLimit: false,
    confidenceAtEntry: 0.5,
    trendBrokeAtEntry: false,
    eventRiskWithinHold: false,
    macroDriven: false,
    correlatedClusterLoss: false,
    ...overrides,
  };
}

describe('MISTAKE_KINDS', () => {
  it('exports every kind exactly once', () => {
    expect(MISTAKE_KINDS).toHaveLength(16);
    expect(new Set(MISTAKE_KINDS).size).toBe(16);
    expect(MISTAKE_KINDS).toContain('NEWS_MISINTERPRETATION');
    expect(MISTAKE_KINDS).toContain('UNKNOWN');
  });
});

describe('classifyMistake', () => {
  const cases: Array<{ name: string; input: Partial<MistakeInput>; kind: MistakeKind }> = [
    { name: 'news misread', input: { newsMisinterpreted: true, lossPct: -0.1 }, kind: 'NEWS_MISINTERPRETATION' },
    { name: 'source failure', input: { sourceFailure: true }, kind: 'SOURCE_FAILURE' },
    { name: 'stale info', input: { staleInfo: true }, kind: 'STALE_INFORMATION' },
    { name: 'regime changed during hold', input: { regimeAtEntry: 'BULL_TREND', regimeAtExit: 'BEAR_TREND' }, kind: 'REGIME_CHANGE' },
    { name: 'volatility spike', input: { volatilitySpike: true }, kind: 'VOLATILITY_SPIKE' },
    { name: 'event risk in window', input: { eventRiskWithinHold: true }, kind: 'EVENT_RISK' },
    { name: 'break at entry with deep loss', input: { trendBrokeAtEntry: true, lossPct: -0.05 }, kind: 'FALSE_BREAKOUT' },
    { name: 'break at entry with shallow loss', input: { trendBrokeAtEntry: true, lossPct: -0.01 }, kind: 'TECHNICAL_SIGNAL_FAILURE' },
    { name: 'sized over limit', input: { positionSizedOverLimit: true }, kind: 'BAD_POSITION_SIZING' },
    { name: 'correlated cluster', input: { correlatedClusterLoss: true }, kind: 'CORRELATION_ERROR' },
    { name: 'macro driven', input: { macroDriven: true }, kind: 'MACRO_ERROR' },
    { name: 'confident and down big', input: { confidenceAtEntry: 0.85, lossPct: -0.06 }, kind: 'OVERCONFIDENCE' },
    { name: 'exited by time limit', input: { lossPct: -0.02, exitReason: 'TIME_LIMIT' }, kind: 'BAD_EXIT' },
    { name: 'exited by trailing stop', input: { lossPct: -0.02, exitReason: 'TRAILING_STOP' }, kind: 'BAD_EXIT' },
    { name: 'plain losing entry', input: { lossPct: -0.03 }, kind: 'BAD_ENTRY' },
    { name: 'nothing matches', input: {}, kind: 'UNKNOWN' },
    { name: 'winning trade, no flags', input: { lossPct: 0.12 }, kind: 'UNKNOWN' },
    { name: 'winning trade exited on target', input: { lossPct: 0.1, exitReason: 'TARGET_REACHED' }, kind: 'UNKNOWN' },
  ];

  for (const c of cases) {
    it(`${c.name} -> ${c.kind}`, () => {
      const res = classifyMistake(input(c.input));
      expect(res.kind).toBe(c.kind);
      expect(res.confidence).toBeGreaterThanOrEqual(0);
      expect(res.confidence).toBeLessThanOrEqual(1);
      expect(res.rationale.length).toBeGreaterThan(0);
    });
  }

  it('priority: news beats source beats stale beats regime beats everything else', () => {
    const stacked = input({
      newsMisinterpreted: true,
      sourceFailure: true,
      staleInfo: true,
      regimeAtExit: 'BEAR_TREND',
      volatilitySpike: true,
      positionSizedOverLimit: true,
      correlatedClusterLoss: true,
      macroDriven: true,
      confidenceAtEntry: 0.95,
      lossPct: -0.2,
      exitReason: 'TIME_LIMIT',
    });
    expect(classifyMistake(stacked).kind).toBe('NEWS_MISINTERPRETATION');
    expect(classifyMistake({ ...stacked, newsMisinterpreted: false }).kind).toBe('SOURCE_FAILURE');
    expect(classifyMistake({ ...stacked, newsMisinterpreted: false, sourceFailure: false }).kind).toBe('STALE_INFORMATION');
    expect(
      classifyMistake({ ...stacked, newsMisinterpreted: false, sourceFailure: false, staleInfo: false }).kind,
    ).toBe('REGIME_CHANGE');
    expect(
      classifyMistake({ ...stacked, newsMisinterpreted: false, sourceFailure: false, staleInfo: false, regimeAtExit: 'BULL_TREND' }).kind,
    ).toBe('VOLATILITY_SPIKE');
  });

  it('FALSE_BREAKOUT vs TECHNICAL_SIGNAL_FAILURE threshold is exactly -4%', () => {
    expect(classifyMistake(input({ trendBrokeAtEntry: true, lossPct: -0.04 })).kind).toBe('FALSE_BREAKOUT');
    expect(classifyMistake(input({ trendBrokeAtEntry: true, lossPct: -0.039 })).kind).toBe('TECHNICAL_SIGNAL_FAILURE');
  });

  it('regime-change detection only fires when entry/exit regimes differ', () => {
    const same: Regime = 'RISK_ON';
    expect(classifyMistake(input({ regimeAtEntry: same, regimeAtExit: same })).kind).toBe('UNKNOWN');
    expect(classifyMistake(input({ regimeAtEntry: same, regimeAtExit: 'RISK_OFF' })).kind).toBe('REGIME_CHANGE');
  });

  it('overconfidence needs both high confidence and a material loss', () => {
    expect(classifyMistake(input({ confidenceAtEntry: 0.8, lossPct: -0.04 })).kind).toBe('BAD_ENTRY'); // loss not deep enough
    expect(classifyMistake(input({ confidenceAtEntry: 0.7, lossPct: -0.1 })).kind).toBe('BAD_ENTRY'); // confidence too low
    expect(classifyMistake(input({ confidenceAtEntry: 0.8, lossPct: -0.05 })).kind).toBe('OVERCONFIDENCE');
  });

  it('exit reason priority sits above the generic BAD_ENTRY fallback', () => {
    const withBadExit: Partial<MistakeInput> = { exitReason: 'TIME_LIMIT' as ExitReason, lossPct: -0.09 };
    expect(classifyMistake(input(withBadExit)).kind).toBe('BAD_EXIT');
    expect(classifyMistake(input({ exitReason: 'TARGET_REACHED', lossPct: -0.01 })).kind).toBe('BAD_ENTRY');
  });
});