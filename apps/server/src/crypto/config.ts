/**
 * Crypto book configuration — PAPER_ONLY, one $100k spot book (CRYPTO_SPOT),
 * long-only, no leverage. Every knob is CRYPTO_-prefixed so the two modules
 * can be tuned independently.
 *
 * Fees are NOT cosmetic here: exchange taker fees are ~0.25% per side, so a
 * round trip costs ~0.5% — materially different from US equities, where the
 * fill model's slippage alone was enough.
 */
import { EXECUTION_MODE } from '@promptslim/tucore';
import type { ScoreParts } from '@promptslim/tucore';

/**
 * Microstructure Alpha Engine flags (Phase 10 of the scalping spec).
 * Every flag defaults to the SAFE value: engine off, L2 features off (the
 * `book` channel is not subscribed), meta-labeling off, cost-aware
 * validation off, shadow mode ON, live execution OFF. The engine is
 * observational by construction — it has no code path into the broker —
 * so even `liveExecution: true` changes nothing until an explicitly
 * approved executor is written.
 */
export interface MicroFlagsConfig {
  /** SCALPING_ALPHA_ENABLED=1 — compute micro features in shadow mode */
  enabled: boolean;
  /** KRAKEN_L2_FEATURES_ENABLED=1 — requires the `book` channel (not subscribed) */
  l2Features: boolean;
  /** META_LABELING_ENABLED=1 — reserve flag; no trained model exists yet */
  metaLabeling: boolean;
  /** COST_AWARE_VALIDATION_ENABLED=1 — reserve flag; no validator wired yet */
  costAwareValidation: boolean;
  /** SHADOW_MODE=1 (default) — record alongside, never influence, decisions */
  shadowMode: boolean;
  /** LIVE_EXECUTION_ENABLED — default false; nothing executes regardless */
  liveExecution: boolean;
  /** reject observations older than this on arrival (ms) */
  staleMs: number;
  /** bounded observer queue capacity (drop-oldest when exceeded) */
  queueCap: number;
  /** feature-snapshot recording interval per symbol (ms; 0 = never record) */
  recordMs: number;
}

function bool(v: string | undefined, d: boolean): boolean {
  if (v === undefined || v === '') return d;
  return v === '1' || v.toLowerCase() === 'true';
}

function microFromEnv(env: Record<string, string | undefined>): MicroFlagsConfig {
  const enabled = bool(env.SCALPING_ALPHA_ENABLED, false);
  return {
    enabled,
    l2Features: bool(env.KRAKEN_L2_FEATURES_ENABLED, false),
    metaLabeling: bool(env.META_LABELING_ENABLED, false),
    costAwareValidation: bool(env.COST_AWARE_VALIDATION_ENABLED, false),
    shadowMode: bool(env.SHADOW_MODE, true),
    liveExecution: bool(env.LIVE_EXECUTION_ENABLED, false),
    staleMs: num(env.SCALPING_STALE_MS, 5_000),
    queueCap: num(env.SCALPING_QUEUE_CAP, 2_000),
    recordMs: enabled ? num(env.SCALPING_RECORD_MS, 10_000) : 0,
  };
}

export interface CryptoConfig {
  executionMode: 'PAPER_ONLY';
  /** single spot book — long-only, no leverage, no shorting */
  portfolioKind: 'CRYPTO_SPOT';
  startCapital: number;
  riskPerTradePct: number;
  maxPositionPct: number;
  /** exchange taker fee per side (Kraken tier 1 = 0.16%, default 0.25%) */
  feePct: number;
  minRiskReward: number;
  minSignalConfidence: number;
  /**
   * Exit geometry for new entries. `sr` (production default) aims at the next
   * resistance above price; `atr3` aims at price + 3*ATR14, which backtested
   * at +$3.9k vs -$2.3k over 602d because most S/R targets sit inside the
   * 1.5R minimum and were discarded by the sane-RR gate (714 -> 97 rejects).
   */
  targetMode: 'sr' | 'atr3';
  reentryCooldownSessions: number;
  stopAtrMultiple: number;
  maxHoldSessions: number;
  fillMode: 'AT_SIGNAL' | 'NEXT_OPEN';
  workers: boolean;
  dbPath: string;
  /** how often quotes are polled when the websocket is down (ms) */
  restPollMs: number;
  /** seconds between strategy scans (crypto has no session to gate it) */
  scanIntervalSec: number;
  /**
   * Static fusion weights over the six ScoreParts, from `CRYPTO_FUSION_WEIGHTS`
   * (JSON object). Crypto only ever fills two of the six parts — technical and
   * regime — while fundamental/event/sentiment/macro are hard 0 in v1, so the
   * shipped SHORT defaults (0.38 technical / 0.16 regime + 0.46 on dead parts)
   * both halve the readable signal and trip the conflict rule whenever
   * technical >= +0.5 in a bear regime: 1,186 coin-days of CONFLICTING_SIGNAL
   * during the 368-day BUY drought. `{ "technical": 0.84, "regime": 0.16 }`
   * gives the two live parts their full weight and drops regime below the
   * 0.15 conflict threshold. `null` (unset) keeps the tucore SHORT defaults.
   * Fitted weights from this book's own outcomes (strategy_weights) still
   * override these once they reach MIN_TRADES.
   */
  fusionWeights: Partial<ScoreParts> | null;
  micro: MicroFlagsConfig;
}

function num(v: string | undefined, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
}

const PART_KEYS = ['technical', 'fundamental', 'event', 'sentiment', 'macro', 'regime'] as const;

/** `CRYPTO_FUSION_WEIGHTS='{"technical":0.84,"regime":0.16}'` -> partial weights.
 *  Unknown keys and non-finite values are dropped; anything unusable -> null
 *  (the tucore SHORT defaults), so a typo can never silence the fusion. */
function fusionWeightsFromEnv(raw: string | undefined): Partial<ScoreParts> | null {
  if (!raw || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Partial<ScoreParts> = {};
    for (const k of PART_KEYS) {
      const v = Number(parsed[k]);
      if (Number.isFinite(v)) out[k] = v;
    }
    return Object.keys(out).length > 0 ? out : null;
  } catch {
    return null;
  }
}

export function cryptoConfigFromEnv(env: Record<string, string | undefined> = process.env): CryptoConfig {
  return {
    executionMode: EXECUTION_MODE,
    portfolioKind: 'CRYPTO_SPOT',
    startCapital: num(env.CRYPTO_CAPITAL, 100_000),
    riskPerTradePct: num(env.CRYPTO_RISK_PER_TRADE, 0.0075),
    maxPositionPct: num(env.CRYPTO_MAX_POSITION, 0.10),
    feePct: num(env.CRYPTO_FEE_PCT, 0.0025),
    minRiskReward: num(env.CRYPTO_MIN_RISK_REWARD, 1.5),
    minSignalConfidence: Math.min(num(env.CRYPTO_MIN_SIGNAL_CONFIDENCE, 0.7), 1),
    targetMode: env.CRYPTO_TARGET_MODE === 'atr3' ? 'atr3' : 'sr',
    reentryCooldownSessions: Math.min(num(env.CRYPTO_REENTRY_COOLDOWN, 1), 30),
    stopAtrMultiple: Math.min(num(env.CRYPTO_STOP_ATR_MULTIPLE, 2), 5),
    maxHoldSessions: num(env.CRYPTO_MAX_HOLD, 20),
    fillMode: env.CRYPTO_FILL_MODE === 'NEXT_OPEN' ? 'NEXT_OPEN' : 'AT_SIGNAL',
    workers: (env.CRYPTO_WORKERS ?? '0') === '1',
    dbPath: env.CRYPTO_DB ?? 'data/crypto.db',
    restPollMs: num(env.CRYPTO_REST_POLL_MS, 5_000),
    scanIntervalSec: num(env.CRYPTO_SCAN_INTERVAL, 300),
    fusionWeights: fusionWeightsFromEnv(env.CRYPTO_FUSION_WEIGHTS),
    micro: microFromEnv(env),
  };
}

/** Crypto never closes: 24/7/365. Everything that keys off "session" in the
 *  TradingUSA module (which models US market hours) reads this instead. */
export const CRYPTO_SESSION = 'MARKET_OPEN' as const;
