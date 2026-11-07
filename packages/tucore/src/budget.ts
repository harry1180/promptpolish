/**
 * Compute-budget planner per session kind.
 *
 * Table (MARKET_OPEN / EARLY_CLOSE quotePoll is 60000 instead of 20000 when
 * systemLoad > 0.8 or dataFreshness < 0.5; providerHealthy=false doubles
 * quotePollMs; field-level `overrides` win last, limit overrides re-cap
 * maxRoutineLlmCalls):
 *
 *   session         quotePoll  feature    crawl     intraday  mtm  maxRoutine
 *   MARKET_OPEN      20000     60000      300000    true    true     30
 *   EARLY_CLOSE      20000     60000      180000    true    true     30
 *   PREMARKET       120000    300000      120000    false  false     10
 *   POSTMARKET      300000    600000      600000    false  false     10
 *   MARKET_CLOSED   900000   3600000     1800000    false  false      0
 *   WEEKEND/HOLIDAY 3600000  7200000     3600000    false  false      0
 *
 * llmAllowed is always true (maxRoutineLlmCalls = 0 outside hours still
 * permits high-priority calls up to maxHighPriorityLlmCallsPerDay).
 * mlIntervalMs refreshes with each feature computation.
 * portfolioExposure/openCandidates are accepted for caller-side policy
 * context and are not used to alter cadence.
 */
import type { ComputeBudget, SessionKind } from './types.ts';

export interface BudgetLimits {
  maxRoutineLlmCallsPerDay: number;
  maxHighPriorityLlmCallsPerDay: number;
  llmReservePercent: number;
  groqTokensPerDay: number;
  geminiTokensPerDay: number;
}

export const DEFAULT_LIMITS: BudgetLimits = {
  maxRoutineLlmCallsPerDay: 30,
  maxHighPriorityLlmCallsPerDay: 15,
  llmReservePercent: 25,
  groqTokensPerDay: 120000,
  geminiTokensPerDay: 200000,
};

export interface BudgetInput {
  session: SessionKind;
  portfolioExposure: number;
  openCandidates: number;
  dataFreshness: number;
  providerHealthy: boolean;
  systemLoad: number;
  overrides?: Partial<ComputeBudget> & Partial<BudgetLimits>;
}

interface SessionPlan {
  quotePollMs: number;
  featureIntervalMs: number;
  crawlIntervalMs: number;
  intradayEnabled: boolean;
  markToMarketEnabled: boolean;
  sessionMaxRoutine: number;
}

function planFor(session: SessionKind): SessionPlan {
  switch (session) {
    case 'MARKET_OPEN':
      return { quotePollMs: 20000, featureIntervalMs: 60000, crawlIntervalMs: 300000, intradayEnabled: true, markToMarketEnabled: true, sessionMaxRoutine: 30 };
    case 'EARLY_CLOSE':
      return { quotePollMs: 20000, featureIntervalMs: 60000, crawlIntervalMs: 180000, intradayEnabled: true, markToMarketEnabled: true, sessionMaxRoutine: 30 };
    case 'PREMARKET':
      return { quotePollMs: 120000, featureIntervalMs: 300000, crawlIntervalMs: 120000, intradayEnabled: false, markToMarketEnabled: false, sessionMaxRoutine: 10 };
    case 'POSTMARKET':
      return { quotePollMs: 300000, featureIntervalMs: 600000, crawlIntervalMs: 600000, intradayEnabled: false, markToMarketEnabled: false, sessionMaxRoutine: 10 };
    case 'MARKET_CLOSED':
      return { quotePollMs: 900000, featureIntervalMs: 3600000, crawlIntervalMs: 1800000, intradayEnabled: false, markToMarketEnabled: false, sessionMaxRoutine: 0 };
    case 'WEEKEND':
    case 'HOLIDAY':
      return { quotePollMs: 3600000, featureIntervalMs: 7200000, crawlIntervalMs: 3600000, intradayEnabled: false, markToMarketEnabled: false, sessionMaxRoutine: 0 };
    default:
      return { quotePollMs: 900000, featureIntervalMs: 3600000, crawlIntervalMs: 1800000, intradayEnabled: false, markToMarketEnabled: false, sessionMaxRoutine: 0 };
  }
}

export function computeBudget(input: BudgetInput): ComputeBudget {
  const ov = input.overrides ?? {};
  const limits: BudgetLimits = {
    maxRoutineLlmCallsPerDay: ov.maxRoutineLlmCallsPerDay ?? DEFAULT_LIMITS.maxRoutineLlmCallsPerDay,
    maxHighPriorityLlmCallsPerDay: ov.maxHighPriorityLlmCallsPerDay ?? DEFAULT_LIMITS.maxHighPriorityLlmCallsPerDay,
    llmReservePercent: ov.llmReservePercent ?? DEFAULT_LIMITS.llmReservePercent,
    groqTokensPerDay: ov.groqTokensPerDay ?? DEFAULT_LIMITS.groqTokensPerDay,
    geminiTokensPerDay: ov.geminiTokensPerDay ?? DEFAULT_LIMITS.geminiTokensPerDay,
  };

  const plan = planFor(input.session);
  let quotePollMs = plan.quotePollMs;
  if (
    (input.session === 'MARKET_OPEN' || input.session === 'EARLY_CLOSE') &&
    (input.systemLoad > 0.8 || input.dataFreshness < 0.5)
  ) {
    quotePollMs = 60000;
  }
  if (!input.providerHealthy) quotePollMs *= 2;

  const maxRoutineLlmCalls = Math.min(plan.sessionMaxRoutine, Math.max(0, limits.maxRoutineLlmCallsPerDay));
  const mlIntervalMs = plan.featureIntervalMs;

  return {
    quotePollMs: ov.quotePollMs ?? quotePollMs,
    featureIntervalMs: ov.featureIntervalMs ?? plan.featureIntervalMs,
    crawlIntervalMs: ov.crawlIntervalMs ?? plan.crawlIntervalMs,
    mlIntervalMs: ov.mlIntervalMs ?? mlIntervalMs,
    llmAllowed: ov.llmAllowed ?? true,
    maxRoutineLlmCalls: ov.maxRoutineLlmCalls ?? maxRoutineLlmCalls,
    intradayEnabled: ov.intradayEnabled ?? plan.intradayEnabled,
    markToMarketEnabled: ov.markToMarketEnabled ?? plan.markToMarketEnabled,
  };
}