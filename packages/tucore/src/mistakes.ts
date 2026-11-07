/**
 * Post-hoc trade mistake classification with a fixed priority order (first
 * match wins). Confidence is a per-class reliability estimate in 0..1.
 */
import type { ExitReason, MistakeKind, Regime } from './types.ts';

export const MISTAKE_KINDS: MistakeKind[] = [
  'BAD_ENTRY',
  'BAD_EXIT',
  'FALSE_BREAKOUT',
  'NEWS_MISINTERPRETATION',
  'FUNDAMENTAL_ERROR',
  'REGIME_CHANGE',
  'VOLATILITY_SPIKE',
  'EVENT_RISK',
  'SOURCE_FAILURE',
  'STALE_INFORMATION',
  'BAD_POSITION_SIZING',
  'OVERCONFIDENCE',
  'CORRELATION_ERROR',
  'MACRO_ERROR',
  'TECHNICAL_SIGNAL_FAILURE',
  'UNKNOWN',
];

export interface MistakeInput {
  lossPct: number;
  exitReason: ExitReason | null;
  regimeAtEntry: Regime;
  regimeAtExit: Regime;
  volatilitySpike: boolean;
  newsMisinterpreted: boolean;
  sourceFailure: boolean;
  staleInfo: boolean;
  positionSizedOverLimit: boolean;
  confidenceAtEntry: number;
  trendBrokeAtEntry: boolean;
  eventRiskWithinHold: boolean;
  macroDriven: boolean;
  correlatedClusterLoss: boolean;
}

export interface MistakeClassification {
  kind: MistakeKind;
  confidence: number;
  rationale: string;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function classifyMistake(input: MistakeInput): MistakeClassification {
  const mk = (kind: MistakeKind, confidence: number, rationale: string): MistakeClassification => ({
    kind,
    confidence: clamp(confidence, 0, 1),
    rationale,
  });

  if (input.newsMisinterpreted) return mk('NEWS_MISINTERPRETATION', 0.9, 'the thesis was driven by a misread news headline');
  if (input.sourceFailure) return mk('SOURCE_FAILURE', 0.9, 'a data source failed or returned unusable data during the trade');
  if (input.staleInfo) return mk('STALE_INFORMATION', 0.85, 'the decision relied on stale information');
  if (input.regimeAtEntry !== input.regimeAtExit) {
    return mk('REGIME_CHANGE', 0.8, `market regime shifted from ${input.regimeAtEntry} to ${input.regimeAtExit} during the hold`);
  }
  if (input.volatilitySpike) return mk('VOLATILITY_SPIKE', 0.8, 'a volatility spike invalidated the entry assumptions');
  if (input.eventRiskWithinHold) return mk('EVENT_RISK', 0.75, 'scheduled event risk fell inside the holding window');
  if (input.trendBrokeAtEntry && input.lossPct <= -0.04) {
    return mk('FALSE_BREAKOUT', 0.7, 'the level broke at entry and failed immediately — a false breakout');
  }
  if (input.trendBrokeAtEntry) {
    return mk('TECHNICAL_SIGNAL_FAILURE', 0.65, 'the technical signal broke at or right after entry');
  }
  if (input.positionSizedOverLimit) return mk('BAD_POSITION_SIZING', 0.7, 'the position was sized above the configured limit');
  if (input.correlatedClusterLoss) return mk('CORRELATION_ERROR', 0.7, 'losses clustered across correlated positions');
  if (input.macroDriven) return mk('MACRO_ERROR', 0.65, 'the loss was driven by a macro move, not the thesis');
  if (input.confidenceAtEntry >= 0.8 && input.lossPct <= -0.05) {
    return mk('OVERCONFIDENCE', 0.6, 'high entry confidence met a material loss');
  }
  if (input.exitReason === 'TIME_LIMIT' || input.exitReason === 'TRAILING_STOP') {
    return mk('BAD_EXIT', 0.55, `exit by ${input.exitReason} left the outcome to time, not the thesis`);
  }
  if (input.lossPct < 0) return mk('BAD_ENTRY', 0.5, 'the entry itself was wrong — price fell after entry');
  return mk('UNKNOWN', 0.2, 'no failure pattern matched this trade');
}