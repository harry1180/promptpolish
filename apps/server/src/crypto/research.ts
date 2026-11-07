/**
 * Research helpers for the alpha investigation phase (Phases A-E).
 *
 * Pure functions only: no DB, no network, no side effects. Scripts under
 * scripts/ compose these into studies; test/crypto-research.test.ts pins the
 * math. Nothing here feeds production decisions — research and measurement
 * only.
 */

/* ------------------------------------------------------------------ */
/* statistics                                                          */
/* ------------------------------------------------------------------ */

export interface WilsonInterval {
  n: number;
  successes: number;
  pct: number | null;
  lo: number | null;
  hi: number | null;
}

/**
 * Wilson score interval for a binomial proportion (95% by default).
 * n=0 -> all null (never fabricates a number from no data).
 */
export function wilson(successes: number, n: number, z = 1.96): WilsonInterval {
  if (n <= 0) return { n: 0, successes, pct: null, lo: null, hi: null };
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { n, successes, pct: p, lo: Math.max(0, center - half), hi: Math.min(1, center + half) };
}

export interface DirectionRow {
  predicted: 'UP' | 'DOWN';
  actual: 'UP' | 'DOWN' | 'FLAT';
}

export interface DirectionalStats {
  evaluated: number;
  correct: number;
  flat: number;
  up: number;
  down: number;
  accuracy: WilsonInterval;
  /** share of non-flat outcomes that were UP — the always-up baseline */
  alwaysUp: number | null;
  alwaysDown: number | null;
}

/** BUY/SELL directional accuracy with class balance and Wilson CI. */
export function directionalStats(rows: DirectionRow[]): DirectionalStats {
  const flat = rows.filter((r) => r.actual === 'FLAT').length;
  const judged = rows.filter((r) => r.actual !== 'FLAT');
  const correct = judged.filter((r) => r.predicted === r.actual).length;
  const up = judged.filter((r) => r.actual === 'UP').length;
  const down = judged.length - up;
  return {
    evaluated: rows.length,
    correct,
    flat,
    up,
    down,
    accuracy: wilson(correct, judged.length),
    alwaysUp: judged.length ? up / judged.length : null,
    alwaysDown: judged.length ? down / judged.length : null,
  };
}

/* ------------------------------------------------------------------ */
/* first-passage on daily bars (Phase C: hit probabilities)            */
/* ------------------------------------------------------------------ */

export interface PassageBar {
  high: number;
  low: number;
}

export type PassageOutcome = 'STOP_FIRST' | 'TARGET_FIRST' | 'AMBIGUOUS' | 'CENSORED';

/**
 * Conservative first-passage: a bar that touches BOTH levels resolves to
 * STOP_FIRST (never credits the target — same priority the production
 * checkExit uses). `maxBars` bounds the holding window.
 */
export function firstPassage(
  bars: PassageBar[],
  stopPrice: number,
  targetPrice: number,
  maxBars: number,
): PassageOutcome {
  let touchedEither = false;
  const n = Math.min(bars.length, maxBars);
  for (let i = 0; i < n; i++) {
    const hitStop = bars[i].low <= stopPrice;
    const hitTarget = bars[i].high >= targetPrice;
    if (hitStop) return 'STOP_FIRST'; // both -> stop wins (conservative)
    if (hitTarget) return 'TARGET_FIRST';
    if (hitStop || hitTarget) touchedEither = true;
  }
  void touchedEither;
  return 'CENSORED';
}

export interface HitProbabilities {
  n: number;
  pTarget: number;
  pStop: number;
  pCensored: number;
}

/** Empirical target/stop hit probabilities over a sample of episodes. */
export function hitProbabilities(outcomes: PassageOutcome[]): HitProbabilities {
  const n = outcomes.length;
  if (n === 0) return { n: 0, pTarget: 0, pStop: 0, pCensored: 1 };
  const t = outcomes.filter((o) => o === 'TARGET_FIRST').length;
  const s = outcomes.filter((o) => o === 'STOP_FIRST' || o === 'AMBIGUOUS').length;
  return { n, pTarget: t / n, pStop: s / n, pCensored: (n - t - s) / n };
}

/* ------------------------------------------------------------------ */
/* expected-value exit gate (Phase C config D)                         */
/* ------------------------------------------------------------------ */

export interface EvInput {
  /** P(target first) estimated on training data only */
  pTarget: number;
  /** P(stop first) */
  pStop: number;
  /** target distance / stop distance for this setup */
  rr: number;
  /** round-trip costs (fees + slippage) as a fraction of STOP distance */
  costOverRisk: number;
}

/**
 * Expected value per unit of risk: pT * rr - pS - costs/risk.
 * A config accepts the trade only when ev > 0.
 */
export function evGate(input: EvInput): number {
  return input.pTarget * input.rr - input.pStop - input.costOverRisk;
}

/* ------------------------------------------------------------------ */
/* break-even economics per horizon (Phase D)                          */
/* ------------------------------------------------------------------ */

export interface HorizonEconomics {
  horizon: string;
  /** round-trip cost as % of notional under the given fee+slippage model */
  costRtPct: number;
  /** price move the strategy must capture JUST to break even */
  requiredMovePct: number;
}

/**
 * Required gross move per horizon = round-trip fees + 2x slippage, expressed
 * as % of price. For a target of `captureRatio` x the required move the
 * strategy needs that much edge before any alpha claim.
 */
export function horizonEconomics(
  horizon: string,
  feePctPerSide: number,
  slippagePerSidePct: number,
): HorizonEconomics {
  const costRtPct = (feePctPerSide + slippagePerSidePct) * 2 * 100;
  return { horizon, costRtPct, requiredMovePct: costRtPct };
}

/* ------------------------------------------------------------------ */
/* cross-venue lead-lag (Priority 1 measurement, pure)                */
/* ------------------------------------------------------------------ */

export interface LeadLagState {
  /** venue -> price at its own last scored move */
  lastScoredPrice: Record<string, number>;
  /** venue -> ms of its own last scored move */
  lastMoveAt: Record<string, number>;
}

export function newLeadLagState(): LeadLagState {
  return { lastScoredPrice: {}, lastMoveAt: {} };
}

export interface MoveEvent {
  venue: string;
  /** true when the OTHER venue moved within the window just before this one */
  follower: boolean;
  /** ms the leading venue moved before this one (only when follower) */
  lagMs: number | null;
}

/**
 * A venue "moves" when its price changes by >= thresholdBps versus its own
 * last scored move. If the other venue moved within windowMs before this
 * one, this move is the FOLLOWER of that lead; otherwise it originates a
 * fresh move (leader). First observation only primes state.
 */
export function leadLagUpdate(
  state: LeadLagState,
  venue: string,
  price: number,
  nowMs: number,
  opts: { thresholdBps?: number; windowMs?: number } = {},
): MoveEvent | null {
  const thresholdBps = opts.thresholdBps ?? 1;
  const windowMs = opts.windowMs ?? 3_000;
  if (!Number.isFinite(price) || price <= 0) return null;
  const prev = state.lastScoredPrice[venue];
  if (prev === undefined) {
    state.lastScoredPrice[venue] = price;
    return null; // first observation only primes state
  }
  if ((Math.abs(price - prev) / prev) * 10_000 < thresholdBps) return null;
  state.lastScoredPrice[venue] = price;
  const other = Object.keys(state.lastMoveAt).find((v) => v !== venue);
  state.lastMoveAt[venue] = nowMs;
  if (other === undefined) return { venue, follower: false, lagMs: null };
  const otherAt = state.lastMoveAt[other];
  if (otherAt !== undefined && nowMs >= otherAt && nowMs - otherAt <= windowMs) {
    return { venue, follower: true, lagMs: nowMs - otherAt };
  }
  return { venue, follower: false, lagMs: null };
}
