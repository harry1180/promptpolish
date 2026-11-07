/**
 * Pre-trade risk gate and position sizing.
 *
 * Scale conventions: riskPerTradePct / maxPositionPct / maxCorrelatedPct /
 * maxSectorPct are FRACTIONS of equity (0.01 = 1%, 0.20 = 20%); earningsWithinDays
 * is sessions; RiskPortfolio.currentDrawdownPct is a PERCENT number
 * (25 = 25% down), matching the spec's `currentDrawdownPct > 25` veto.
 *
 * Every veto returns approved=false with sizeShares=0 and the reason recorded
 * in `reasons` (all applicable reasons are collected, not just the first).
 */
import type { Horizon, Regime, RiskDecision } from './types.ts';

export interface RiskCandidate {
  ticker: string;
  sector: string;
  price: number;
  entryLow: number;
  invalidation: number;
  target: number;
  confidence: number;
  horizon: Horizon;
}

export interface RiskPosition {
  ticker: string;
  sector: string;
  notional: number;
  entryPrice: number;
  currentPrice: number;
  qty: number;
}

export interface RiskPortfolio {
  equity: number;
  cash: number;
  openPositions: RiskPosition[];
  currentDrawdownPct: number;
}

export interface RiskLimits {
  riskPerTradePct: number;
  maxPositionPct: number;
  maxCorrelatedPct: number;
  maxSectorPct: number;
  minRiskReward: number;
  maxEarningsDays: number;
}

export interface RiskEnvInput {
  liquidityScore: number;
  volatilityPct: number;
  regime: Regime;
  dataQuality: { stale: boolean; disagreement: boolean; missing: boolean };
  killSwitchActive: boolean;
  earningsWithinDays: number;
}

/** shares = floor(min(equity*riskPct/stopDistance, equity*maxNotionalPct/entry, cash/entry)); stop >= entry -> 0. */
export function positionSizeShares(
  equity: number,
  riskPct: number,
  entry: number,
  stop: number,
  maxNotionalPct: number,
  cash: number,
): number {
  if (!(equity > 0) || !(entry > 0) || !(cash > 0) || !(riskPct > 0)) return 0;
  const stopDistance = entry - stop;
  if (!(stopDistance > 0)) return 0;
  const byRisk = (equity * riskPct) / stopDistance;
  const byNotional = (equity * maxNotionalPct) / entry;
  const byCash = cash / entry;
  return Math.floor(Math.min(byRisk, byNotional, byCash));
}

export function evaluateEntry(
  portfolio: RiskPortfolio,
  candidate: RiskCandidate,
  limits: RiskLimits,
  env: RiskEnvInput,
): RiskDecision {
  const reasons: string[] = [];
  const entry = candidate.price;
  const stop = candidate.invalidation;
  const target = candidate.target;
  const equity = portfolio.equity;

  // 1. kill switch
  if (env.killSwitchActive) reasons.push('kill switch active');
  // 2. data quality gate
  if (env.dataQuality.stale || env.dataQuality.disagreement || env.dataQuality.missing) {
    reasons.push('data quality gate');
  }
  // 3. liquidity floor
  if (env.liquidityScore < 0.2) reasons.push('liquidity below minimum');

  // 4. invalid stop
  const validStop = entry !== stop && Number.isFinite(entry) && Number.isFinite(stop);
  if (!validStop) reasons.push('invalid stop (entry equals invalidation)');

  // 5. minimum risk/reward: (target - entry) / (entry - invalidation)
  const stopDistance = entry - stop;
  const riskReward = stopDistance > 0 ? (target - entry) / stopDistance : Number.NEGATIVE_INFINITY;
  if (validStop && riskReward < limits.minRiskReward) reasons.push('risk/reward below minimum');

  // Size FIRST with the contract formula (risk / notional / cash caps
  // applied together), then test exposure limits against the position that
  // would actually be taken — a tight stop must not fail sector caps just
  // because the raw risk formula would have wanted a huge share count.
  const sizeShares = positionSizeShares(equity, limits.riskPerTradePct, entry, stop, limits.maxPositionPct, portfolio.cash);
  const riskNotional = sizeShares * entry;

  // 6/7. sector and correlated exposure (existing book + this candidate)
  let sectorNotional = 0;
  for (const p of portfolio.openPositions) {
    if (p.sector === candidate.sector) sectorNotional += p.notional;
  }
  if (equity > 0 && (sectorNotional + riskNotional) / equity > limits.maxSectorPct) {
    reasons.push('sector exposure limit exceeded');
  }
  if (sectorNotional > limits.maxCorrelatedPct * equity) {
    reasons.push('correlated exposure limit exceeded');
  }

  // 8. single-position cap
  if (riskNotional > limits.maxPositionPct * equity + entry) {
    reasons.push('position size limit exceeded');
  }
  // 9. cash
  if (riskNotional > portfolio.cash + entry) reasons.push('insufficient cash');
  // 10. earnings window
  if (env.earningsWithinDays <= limits.maxEarningsDays && candidate.confidence < 0.7) {
    reasons.push('earnings window with sub-threshold confidence');
  }
  // 11. liquidity-stress regime
  if (env.regime === 'LIQUIDITY_STRESS' && candidate.confidence < 0.75) {
    reasons.push('liquidity stress regime with sub-threshold confidence');
  }
  // 12. drawdown circuit breaker (percent scale, strict >)
  if (portfolio.currentDrawdownPct > 25) reasons.push('drawdown limit exceeded');

  if (reasons.length > 0) {
    return { approved: false, sizeShares: 0, riskAmount: 0, notional: 0, reasons };
  }

  const distance = stopDistance > 0 ? stopDistance : 0;
  return {
    approved: true,
    sizeShares,
    riskAmount: sizeShares * distance,
    notional: sizeShares * entry,
    reasons: [],
  };
}

export interface KillSwitchInput {
  dataStale: boolean;
  providerFailed: boolean;
  priceDisagreement: boolean;
  dbUnhealthy: boolean;
  strategyAbnormal: boolean;
  drawdownPct: number;
  drawdownLimitPct: number;
  calcFailed: boolean;
  regimeUncertain: boolean;
}

/** drawdownPct is a percent number; it trips only when drawdownLimitPct > 0 and drawdownPct > limit. */
export function checkKillSwitch(input: KillSwitchInput): { active: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (input.dataStale) reasons.push('stale data');
  if (input.providerFailed) reasons.push('provider failure');
  if (input.priceDisagreement) reasons.push('price disagreement');
  if (input.dbUnhealthy) reasons.push('database unhealthy');
  if (input.strategyAbnormal) reasons.push('strategy abnormal');
  if (input.drawdownLimitPct > 0 && input.drawdownPct > input.drawdownLimitPct) {
    reasons.push('drawdown limit exceeded');
  }
  if (input.calcFailed) reasons.push('calculation failure');
  if (input.regimeUncertain) reasons.push('regime uncertain');
  return { active: reasons.length > 0, reasons };
}