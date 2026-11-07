import { describe, expect, it } from 'vitest';
import { checkKillSwitch, evaluateEntry, positionSizeShares } from '../src/risk.ts';
import type { RiskCandidate, RiskEnvInput, RiskLimits, RiskPortfolio } from '../src/risk.ts';

const limits: RiskLimits = {
  riskPerTradePct: 0.01,
  maxPositionPct: 0.2,
  maxCorrelatedPct: 0.4,
  maxSectorPct: 0.3,
  minRiskReward: 1.5,
  maxEarningsDays: 5,
};

function portfolio(overrides: Partial<RiskPortfolio> = {}): RiskPortfolio {
  return {
    equity: 100_000,
    cash: 100_000,
    openPositions: [],
    currentDrawdownPct: 0,
    ...overrides,
  };
}

function candidate(overrides: Partial<RiskCandidate> = {}): RiskCandidate {
  return {
    ticker: 'AAA',
    sector: 'TECH',
    price: 100,
    entryLow: 99.75,
    invalidation: 95,
    target: 120,
    confidence: 0.8,
    horizon: 'SHORT',
    ...overrides,
  };
}

function env(overrides: Partial<RiskEnvInput> = {}): RiskEnvInput {
  return {
    liquidityScore: 0.9,
    volatilityPct: 30,
    regime: 'BULL_TREND',
    dataQuality: { stale: false, disagreement: false, missing: false },
    killSwitchActive: false,
    earningsWithinDays: 30,
    ...overrides,
  };
}

describe('evaluateEntry', () => {
  it('sizing is exact for a clean candidate', () => {
    const res = evaluateEntry(portfolio(), candidate(), limits, env());
    expect(res.approved).toBe(true);
    expect(res.reasons).toEqual([]);
    // stopDistance = 5 -> shares = floor(min(100000*0.01/5, 100000*0.2/100, 100000/100)) = 200
    expect(res.sizeShares).toBe(200);
    expect(res.riskAmount).toBe(200 * 5);
    expect(res.notional).toBe(200 * 100);
  });

  it('kill-switch vetoes', () => {
    const res = evaluateEntry(portfolio(), candidate(), limits, env({ killSwitchActive: true }));
    expect(res.approved).toBe(false);
    expect(res.sizeShares).toBe(0);
    expect(res.notional).toBe(0);
    expect(res.reasons).toContain('kill switch active');
  });

  it('stale data vetoes via the data quality gate', () => {
    const res = evaluateEntry(portfolio(), candidate(), limits, env({ dataQuality: { stale: true, disagreement: false, missing: false } }));
    expect(res.approved).toBe(false);
    expect(res.reasons).toContain('data quality gate');
    const disagree = evaluateEntry(portfolio(), candidate(), limits, env({ dataQuality: { stale: false, disagreement: true, missing: false } }));
    expect(disagree.reasons).toContain('data quality gate');
    const missing = evaluateEntry(portfolio(), candidate(), limits, env({ dataQuality: { stale: false, disagreement: false, missing: true } }));
    expect(missing.reasons).toContain('data quality gate');
  });

  it('sector exposure exceeding maxSectorPct vetoes', () => {
    const p = portfolio({
      openPositions: [
        { ticker: 'CCC', sector: 'TECH', notional: 25_000, entryPrice: 50, currentPrice: 50, qty: 500 },
      ],
    });
    const res = evaluateEntry(p, candidate(), limits, env());
    expect(res.approved).toBe(false);
    expect(res.reasons).toContain('sector exposure limit exceeded');
    expect(res.sizeShares).toBe(0);
  });

  it('correlated (same-sector) exposure above maxCorrelatedPct vetoes even below the sector cap', () => {
    const p = portfolio({
      openPositions: [
        { ticker: 'CCC', sector: 'TECH', notional: 45_000, entryPrice: 50, currentPrice: 50, qty: 900 },
      ],
    });
    const wideSector: RiskLimits = { ...limits, maxSectorPct: 0.7, maxCorrelatedPct: 0.4 };
    const res = evaluateEntry(p, candidate(), wideSector, env());
    expect(res.approved).toBe(false);
    expect(res.reasons).toContain('correlated exposure limit exceeded');
    expect(res.reasons).not.toContain('sector exposure limit exceeded');
  });

  it('min risk/reward vetoes', () => {
    const res = evaluateEntry(portfolio(), candidate({ target: 101 }), limits, env()); // rr = 1/5 = 0.2 < 1.5
    expect(res.approved).toBe(false);
    expect(res.reasons).toContain('risk/reward below minimum');
  });

  it('invalid stop (entry == invalidation) vetoes', () => {
    const res = evaluateEntry(portfolio(), candidate({ invalidation: 100 }), limits, env());
    expect(res.approved).toBe(false);
    expect(res.reasons).toContain('invalid stop (entry equals invalidation)');
  });

  it('position above maxPositionPct is CLAMPED to the cap, not rejected', () => {
    const tight: RiskLimits = { ...limits, maxPositionPct: 0.1 };
    const res = evaluateEntry(portfolio(), candidate(), tight, env());
    expect(res.approved).toBe(true);
    // raw risk sizing would want 200 shares (20% notional); the cap clamps to 100
    expect(res.sizeShares).toBe(100);
    expect(res.notional).toBeLessThanOrEqual(10_000 + 100);
  });

  it('insufficient cash clamps the size instead of over-drawing', () => {
    const p = portfolio({ cash: 5_000 });
    const res = evaluateEntry(p, candidate(), limits, env());
    expect(res.approved).toBe(true);
    expect(res.sizeShares).toBe(50); // byCash = floor(5000 / 100)
    expect(res.notional).toBeLessThanOrEqual(5_000 + 100);
  });

  it('a tight stop cannot fail sector caps (caps use the clamped position)', () => {
    // stop 0.5% away: raw risk formula would demand a huge share count
    const tightStop = candidate({ invalidation: 99.5, target: 104 });
    const res = evaluateEntry(portfolio(), tightStop, limits, env());
    expect(res.approved).toBe(true);
    expect(res.notional).toBeLessThanOrEqual(0.2 * 100_000 + 100);
  });

  it('earnings gate: near-term event with confidence < 0.7 vetoes', () => {
    const nearConfident = evaluateEntry(portfolio(), candidate({ confidence: 0.6 }), limits, env({ earningsWithinDays: 3 }));
    expect(nearConfident.approved).toBe(false);
    expect(nearConfident.reasons).toContain('earnings window with sub-threshold confidence');
    // far from earnings, or confident enough, passes
    expect(evaluateEntry(portfolio(), candidate({ confidence: 0.6 }), limits, env({ earningsWithinDays: 30 })).approved).toBe(true);
    expect(evaluateEntry(portfolio(), candidate({ confidence: 0.75 }), limits, env({ earningsWithinDays: 3 })).approved).toBe(true);
  });

  it('liquidity floor, LIQUIDITY_STRESS regime and drawdown vetoes', () => {
    expect(evaluateEntry(portfolio(), candidate(), limits, env({ liquidityScore: 0.1 })).reasons).toContain('liquidity below minimum');
    const stressed = evaluateEntry(portfolio(), candidate({ confidence: 0.7 }), limits, env({ regime: 'LIQUIDITY_STRESS' }));
    expect(stressed.reasons).toContain('liquidity stress regime with sub-threshold confidence');
    expect(evaluateEntry(portfolio(), candidate({ confidence: 0.8 }), limits, env({ regime: 'LIQUIDITY_STRESS' })).approved).toBe(true);
    const deep = evaluateEntry(portfolio({ currentDrawdownPct: 30 }), candidate(), limits, env());
    expect(deep.reasons).toContain('drawdown limit exceeded');
    expect(evaluateEntry(portfolio({ currentDrawdownPct: 25 }), candidate(), limits, env()).approved).toBe(true);
  });
});

describe('positionSizeShares', () => {
  it('matches the documented formula', () => {
    // min(100000*0.01/5, 100000*0.2/100, 100000/100) = min(200, 200, 1000) = 200
    expect(positionSizeShares(100_000, 0.01, 100, 95, 0.2, 100_000)).toBe(200);
    // risk-sized 653.33 shares capped by 20% notional -> 196
    expect(positionSizeShares(100_000, 0.01, 102, 100.47, 0.2, 100_000)).toBe(196);
    // cash cap
    expect(positionSizeShares(100_000, 0.01, 100, 95, 0.2, 5_000)).toBe(50);
    // stop == entry -> 0
    expect(positionSizeShares(100_000, 0.01, 100, 100, 0.2, 100_000)).toBe(0);
    // invalid inputs -> 0
    expect(positionSizeShares(0, 0.01, 100, 95, 0.2, 100_000)).toBe(0);
    expect(positionSizeShares(100_000, 0, 100, 95, 0.2, 100_000)).toBe(0);
    expect(positionSizeShares(100_000, 0.01, 100, 105, 0.2, 100_000)).toBe(0);
  });
});

describe('checkKillSwitch', () => {
  const clear = {
    dataStale: false,
    providerFailed: false,
    priceDisagreement: false,
    dbUnhealthy: false,
    strategyAbnormal: false,
    drawdownPct: 10,
    drawdownLimitPct: 25,
    calcFailed: false,
    regimeUncertain: false,
  };

  it('inactive when everything is healthy', () => {
    expect(checkKillSwitch(clear)).toEqual({ active: false, reasons: [] });
  });

  it('activates and names each trigger', () => {
    expect(checkKillSwitch({ ...clear, dataStale: true }).reasons).toContain('stale data');
    expect(checkKillSwitch({ ...clear, providerFailed: true }).reasons).toContain('provider failure');
    expect(checkKillSwitch({ ...clear, priceDisagreement: true }).reasons).toContain('price disagreement');
    expect(checkKillSwitch({ ...clear, dbUnhealthy: true }).reasons).toContain('database unhealthy');
    expect(checkKillSwitch({ ...clear, strategyAbnormal: true }).reasons).toContain('strategy abnormal');
    expect(checkKillSwitch({ ...clear, calcFailed: true }).reasons).toContain('calculation failure');
    expect(checkKillSwitch({ ...clear, regimeUncertain: true }).reasons).toContain('regime uncertain');
    expect(checkKillSwitch({ ...clear, drawdownPct: 30, drawdownLimitPct: 25 }).active).toBe(true);
    expect(checkKillSwitch({ ...clear, drawdownPct: 25, drawdownLimitPct: 25 }).active).toBe(false);
    expect(checkKillSwitch({ ...clear, drawdownPct: 5, drawdownLimitPct: 0 }).active).toBe(false);
    const multi = checkKillSwitch({ ...clear, dataStale: true, providerFailed: true, drawdownPct: 40, drawdownLimitPct: 25 });
    expect(multi.active).toBe(true);
    expect(multi.reasons.length).toBe(3);
  });
});