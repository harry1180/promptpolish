/**
 * TradingUSA runtime configuration. Secrets (GROQ_API_KEY/GEMINI_API_KEY)
 * are read ONLY from process env by the InferenceRouter — never here, never
 * returned anywhere.
 */
import { DEFAULT_LIMITS, EXECUTION_MODE } from '@promptslim/tucore';

export interface TuConfig {
  executionMode: 'PAPER_ONLY';
  pilotMode: boolean;
  shortCapital: number;
  longCapital: number;
  riskPerTradePct: number;
  maxPositionPct: number;
  maxSectorPct: number;
  maxCorrelatedPct: number;
  minRiskReward: number;
  maxEarningsDays: number;
  killSwitchDrawdownPct: number;
  fillMode: 'AT_SIGNAL' | 'NEXT_OPEN';
  /** Minimum fused confidence for a BUY to become a signal at all (was: any
   *  fused BUY at >=0.55 hint). Production average was 0.63 — 0.70 cuts the
   *  churn while keeping strong setups actionable. */
  minSignalConfidence: number;
  /** Re-entry cooldown: no new BUY order on a ticker that stopped out within
   *  the last N trading sessions (AMZN was stopped twice the same day).
   *  Default 3 — gate A/B on the 609-trade backtest: regime gate alone
   *  (+0.185% exp), 3 sessions best (+0.200%), 5 sessions cut it to +0.080%. */
  reentryCooldownSessions: number;
  /** Widen the stop to N x ATR14 when (and only when) the target still
   *  affords minRiskReward — 71% of exits were stops inside noise. */
  stopAtrMultiple: number;
  /** NOISE FLOOR (2026-11-24 exits fix): a stop may never sit closer than
   *  N x ATR14 to entry — measured market-noise floor is ~0.38 ATR and stops
   *  inside it were consumed by ordinary noise (25 of 51 trades stopped out
   *  on day 1). Applied AFTER the strategy's own stop and widening, and the
   *  reward/risk gate keeps evaluating the strategy's stop, so the floor
   *  never removes a trade — it only moves the protective stop out of the
   *  noise; sizing then uses the wider stop, keeping dollars-at-risk fixed. */
  stopAtrFloorMultiple: number;
  /** Ratchet: once MFE reaches N x R, trail the stop at M x ATR14 behind the
   *  peak, never tighter than the original stop (monotone, ratcheting). 0 off. */
  trailingArmRMultiple: number;
  trailingAtrMultiple: number;
  /** Dead-trade cleanup: close after N sessions if MFE never reached
   *  M x R (exit_reason TIME_LIMIT). 0 off. */
  deadTradeSessions: number;
  deadTradeMfeRMultiple: number;
  workers: boolean;
  dbPath: string;
  universe: string[] | null;
  limits: {
    maxRoutineLlmCallsPerDay: number;
    maxHighPriorityLlmCallsPerDay: number;
    llmReservePercent: number;
    groqTokensPerDay: number;
    geminiTokensPerDay: number;
  };
}

function num(v: string | undefined, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
}

export function tuConfigFromEnv(env: Record<string, string | undefined> = process.env): TuConfig {
  // ExecutionGuard: this release is PAPER_ONLY, full stop. A non-paper
  // value in the environment is ignored — real-money modes do not exist yet.
  const fillMode = env.TU_FILL_MODE === 'NEXT_OPEN' ? 'NEXT_OPEN' : 'AT_SIGNAL';
  const minSignalConfidence = num(env.TU_MIN_SIGNAL_CONFIDENCE, 0.7);
  const reentryCooldownSessions = num(env.TU_REENTRY_COOLDOWN_SESSIONS, 3);
  const stopAtrMultiple = num(env.TU_STOP_ATR_MULTIPLE, 2);
  const nonNeg = (v: string | undefined, d: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : d;
  };
  const stopAtrFloorMultiple = Math.min(nonNeg(env.TU_STOP_ATR_FLOOR, 0.8), 5);
  const trailingArmRMultiple = Math.min(nonNeg(env.TU_TRAIL_ARM_R, 1), 10);
  const trailingAtrMultiple = Math.min(nonNeg(env.TU_TRAIL_ATR, 1.2), 10);
  const deadTradeSessions = Math.min(nonNeg(env.TU_DEAD_TRADE_SESSIONS, 5), 120);
  const deadTradeMfeRMultiple = Math.min(nonNeg(env.TU_DEAD_TRADE_MFE_R, 0.5), 10);
  return {
    executionMode: EXECUTION_MODE,
    pilotMode: (env.PILOT_MODE ?? 'true').toLowerCase() !== 'false',
    shortCapital: num(env.TU_SHORT_CAPITAL, 100_000),
    longCapital: num(env.TU_LONG_CAPITAL, 100_000),
    riskPerTradePct: num(env.TU_RISK_PER_TRADE, 0.0075) <= 0.05 ? num(env.TU_RISK_PER_TRADE, 0.0075) : 0.0075,
    maxPositionPct: num(env.TU_MAX_POSITION_PCT, 0.1),
    maxSectorPct: num(env.TU_MAX_SECTOR_PCT, 0.3),
    maxCorrelatedPct: num(env.TU_MAX_CORRELATED_PCT, 0.4),
    minRiskReward: num(env.TU_MIN_RISK_REWARD, 1.5),
    maxEarningsDays: num(env.TU_MAX_EARNINGS_DAYS, 3),
    killSwitchDrawdownPct: num(env.TU_KILL_SWITCH_DRAWDOWN, 0.25),
    fillMode,
    minSignalConfidence: Math.min(Math.max(minSignalConfidence, 0), 1),
    reentryCooldownSessions: Math.min(Math.max(reentryCooldownSessions, 0), 60),
    stopAtrMultiple: Math.min(Math.max(stopAtrMultiple, 0), 5),
    stopAtrFloorMultiple,
    trailingArmRMultiple,
    trailingAtrMultiple,
    deadTradeSessions,
    deadTradeMfeRMultiple,
    workers: (env.TU_WORKERS ?? '0') === '1',
    dbPath: env.TU_DB ?? 'data/tradingusa.db',
    universe: env.TU_UNIVERSE ? env.TU_UNIVERSE.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) : null,
    limits: {
      maxRoutineLlmCallsPerDay: num(env.MAX_ROUTINE_LLM_CALLS_PER_DAY, DEFAULT_LIMITS.maxRoutineLlmCallsPerDay),
      maxHighPriorityLlmCallsPerDay: num(env.MAX_HIGH_PRIORITY_LLM_CALLS_PER_DAY, DEFAULT_LIMITS.maxHighPriorityLlmCallsPerDay),
      llmReservePercent: num(env.LLM_RESERVE_PERCENT, DEFAULT_LIMITS.llmReservePercent),
      groqTokensPerDay: num(env.TU_GROQ_TOKENS_PER_DAY, DEFAULT_LIMITS.groqTokensPerDay),
      geminiTokensPerDay: num(env.TU_GEMINI_TOKENS_PER_DAY, DEFAULT_LIMITS.geminiTokensPerDay),
    },
  };
}
