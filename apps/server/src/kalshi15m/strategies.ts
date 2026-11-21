/**
 * STRATEGY A — cross-exchange lead/lag (SHADOW ONLY).
 *
 * The idea under test: a meaningful BTC spot move, agreed by both venues, that
 * Kalshi's book has not finished repricing. We never read a raw exchange-price
 * difference as arbitrage — what is measured is REPRICING LAG:
 *
 *   expected move = p(settle YES | spot now) − p(settle YES | spot k s ago)
 *                   evaluated with the SAME sigma, strike and tau, so the only
 *                   difference between the two legs is the spot move itself;
 *   repriced      = what the YES mid actually did over those same k seconds;
 *   remaining     = expected − repriced  (what the book still has to do);
 *   net           = side-signed remaining − round-trip cost − safety buffer.
 *
 * A trade is only "taken" when net ≥ minNetPp AND every gate passed; the
 * runtime records EVERY evaluation (taken or skipped, with the reason), so the
 * shadow log can be scored for false negatives as well as false positives.
 *
 * Nothing here places orders. There is no execution path in this file.
 */
import { fairValue } from './fairvalue.ts';
import { KXBTC15M_FEES, roundTripCost, takerFee } from './fee.ts';

export interface LeadLagConfig {
  enabled: boolean;
  /** lookback used for BOTH the spot move and the mid move (seconds) */
  lagSec: number;
  /** minimum |spot move| over lagSec, in basis points */
  moveBps: number;
  /** both venues' 1s returns must share a sign */
  requireAgreement: boolean;
  /** all-in cost must be covered, in cents per contract (spec target: 2¢) */
  minNetPp: number;
  /** extra safety on top of costs, in cents per contract */
  bufferPp: number;
  /** do not trade in the last N seconds (settlement minute is not our edge) */
  minTauSec: number;
}

function bool(v: string | undefined, d: boolean): boolean {
  if (v === undefined || v === '') return d;
  return v === '1' || v.toLowerCase() === 'true';
}

function num(v: string | undefined, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
}

/** Safe defaults: OFF, and every threshold on the conservative side. */
export function leadLagConfigFromEnv(env: Record<string, string | undefined> = process.env): LeadLagConfig {
  return {
    enabled: bool(env.KALSHI15M_STRAT_A, false),
    lagSec: num(env.KALSHI15M_A_LAG_SEC, 3),
    moveBps: num(env.KALSHI15M_A_MOVE_BPS, 1.5),
    requireAgreement: env.KALSHI15M_A_AGREEMENT !== '0',
    minNetPp: num(env.KALSHI15M_A_MIN_NET_PP, 2),
    bufferPp: num(env.KALSHI15M_A_BUFFER_PP, 1),
    minTauSec: num(env.KALSHI15M_A_MIN_TAU_SEC, 15),
  };
}

export interface LeadLagInput {
  cfg: LeadLagConfig;
  now: number;
  tauSec: number | null;
  strike: number | null;
  /** spot reference NOW and lagSec ago (the tape's own history) */
  spotNow: number | null;
  spotLag: number | null;
  /** Kalshi YES mid NOW and lagSec ago */
  midNow: number | null;
  midLag: number | null;
  /** did both venues agree on the direction over the last second */
  venuesAgree: boolean;
  /** per-second sigma the fair value prices with (fixed across both legs) */
  sigmaPerSec: number | null;
  /** executable book, YES side */
  yesBid: number | null;
  yesAsk: number | null;
}

export interface LeadLagVerdict {
  strategy: 'A_LEADLAG';
  verdict: 'TRADE' | 'SKIP';
  side: 'YES' | 'NO' | null;
  /** probability points the spot move implies, before any repricing */
  expectedMovePp: number | null;
  /** probability points the mid actually moved over the same interval */
  repricedPp: number | null;
  /** side-signed remaining move, in probability points */
  remainingPp: number | null;
  /** round-trip cost of the chosen side: spread + both taker fees (cents) */
  costPp: number | null;
  /** remaining − cost − buffer, the number the gate compares to 0 */
  netPp: number | null;
  skipReason: string | null;
  /** every gate in order — the shadow log must explain itself */
  reasons: string[];
}

/** Fair value of YES from the two legs, using one sigma for both. */
function pYesAt(spot: number, strike: number, tauSec: number, sigma: number): number | null {
  const fv = fairValue({ spot, strike, tauSec, sigmaPerSec: sigma, approx: 'model' });
  return fv.pYes;
}

/**
 * One Strategy-A evaluation. Pure: every input is passed in, nothing is read
 * from the future (spotLag/midLag are the values `lagSec` in the past) and no
 * side effect exists beyond the returned verdict.
 */
export function evaluateLeadLag(input: LeadLagInput): LeadLagVerdict {
  const r: string[] = [];
  const skip = (reason: string, extra: Partial<LeadLagVerdict> = {}): LeadLagVerdict => ({
    strategy: 'A_LEADLAG', verdict: 'SKIP', side: null,
    expectedMovePp: null, repricedPp: null, remainingPp: null,
    costPp: null, netPp: null, skipReason: reason, reasons: r,
    ...extra,
  });

  /* ---- data gates ---- */
  const { cfg, strike, spotNow, spotLag, midNow, midLag, sigmaPerSec, yesBid, yesAsk, tauSec } = input;
  if (tauSec === null) return skip('no_tau');
  r.push(`tau=${tauSec.toFixed(1)}s`);
  if (tauSec < cfg.minTauSec) return skip('too_close_to_settlement');
  if (strike === null || !(strike > 0)) return skip('no_strike');
  if (sigmaPerSec === null || !(sigmaPerSec > 0)) return skip('no_sigma');
  if (spotNow === null || spotLag === null || !(spotNow > 0) || !(spotLag > 0)) return skip('no_spot_history');
  if (midNow === null || midLag === null) return skip('no_mid_history');
  if (yesBid === null || yesAsk === null || yesBid <= 0 || yesAsk <= yesBid) return skip('no_executable_book');

  /* ---- move gates ---- */
  const moveBps = Math.log(spotNow / spotLag) * 10_000;
  r.push(`spot_move=${moveBps.toFixed(2)}bps/${cfg.lagSec}s`);
  if (Math.abs(moveBps) < cfg.moveBps) return skip('move_too_small');
  if (cfg.requireAgreement && !input.venuesAgree) return skip('venue_disagreement');

  /* ---- repricing arithmetic (same sigma on both legs: only spot differs) ---- */
  const pNow = pYesAt(spotNow, strike, tauSec, sigmaPerSec);
  const pLag = pYesAt(spotLag, strike, tauSec, sigmaPerSec);
  if (pNow === null || pLag === null) return skip('model_unavailable');
  const expectedMovePp = (pNow - pLag) * 100;
  const repricedPp = (midNow - midLag) * 100;
  r.push(`expected=${expectedMovePp.toFixed(2)}pp repriced=${repricedPp.toFixed(2)}pp`);

  // direction of the move we are betting continues/repricess
  const side: 'YES' | 'NO' = expectedMovePp >= 0 ? 'YES' : 'NO';
  const sideSign = side === 'YES' ? 1 : -1;
  const remainingPp = sideSign * (expectedMovePp - repricedPp);
  r.push(`side=${side} remaining=${remainingPp.toFixed(2)}pp`);

  /* ---- cost of the chosen side (both legs taker: never assume a free exit) ---- */
  const entry = side === 'YES' ? yesAsk : 1 - yesBid;
  const exit = side === 'YES' ? yesBid : 1 - yesAsk;
  const cost = roundTripCost({ contracts: 1, entryPrice: entry, exitPrice: exit, sched: KXBTC15M_FEES });
  const costPp = cost.totalCents;
  r.push(`cost=${costPp.toFixed(2)}pp (spread ${cost.spread.toFixed(4)} + fees)`);

  const netPp = remainingPp - costPp - cfg.bufferPp;
  r.push(`net=${netPp.toFixed(2)}pp (min ${cfg.minNetPp})`);

  if (netPp < cfg.minNetPp) return skip('edge_below_cost', {
    side, expectedMovePp, repricedPp, remainingPp, costPp, netPp,
  });
  return {
    strategy: 'A_LEADLAG', verdict: 'TRADE', side,
    expectedMovePp, repricedPp, remainingPp, costPp, netPp,
    skipReason: null, reasons: r,
  };
}


/* ================================================================== */
/* Shared: verdict shape + cost helpers used by every strategy         */
/* ================================================================== */

/** Every strategy returns this shape so one storage path can hold them all. */
export type StrategyVerdict = LeadLagVerdict;

/** Round-trip cost of taking a side on the YES book, in cents per contract. */
export function sideCost(side: 'YES' | 'NO', yesBid: number, yesAsk: number): number {
  const entry = side === 'YES' ? yesAsk : 1 - yesBid;
  const exit = side === 'YES' ? yesBid : 1 - yesAsk;
  return roundTripCost({ contracts: 1, entryPrice: entry, exitPrice: exit, sched: KXBTC15M_FEES }).totalCents;
}

/** Uniform builder: a verdict always carries a strategy, a reason list and nulls. */
export function mkVerdict(
  strategy: string,
  verdict: 'TRADE' | 'SKIP',
  reasons: string[],
  fields: Partial<StrategyVerdict> = {},
): StrategyVerdict {
  return {
    strategy, verdict,
    side: null, expectedMovePp: null, repricedPp: null, remainingPp: null,
    costPp: null, netPp: null,
    skipReason: verdict === 'SKIP' ? (fields.skipReason ?? 'unknown') : null,
    reasons, ...fields,
  } as StrategyVerdict;
}

/* ================================================================== */
/* STRATEGY B — order-book microstructure                              */
/* ================================================================== */

export interface MicroConfig {
  enabled: boolean;
  /** confirmation gates on flow before a microprice edge is believed */
  minAbsImbalance: number;
  minAbsOfi: number;
  minNetPp: number;
  bufferPp: number;
  minTauSec: number;
  /**
   * How the signal is assumed to be executed:
   *  TAKER (default) crosses the book — and since the microprice gap is by
   *  construction at most half the spread, a taker round trip can never be
   *  beaten by this signal alone. The shadow proves that on real data.
   *  MAKER posts instead: fee-free on this series, so the gate sees the raw
   *  gap (that is Strategy B feeding Strategy F's execution).
   */
  costModel: 'TAKER' | 'MAKER';
}

export function microConfigFromEnv(env: Record<string, string | undefined> = process.env): MicroConfig {
  return {
    enabled: bool(env.KALSHI15M_STRAT_B, false),
    minAbsImbalance: num(env.KALSHI15M_B_MIN_IMBALANCE, 0.2),
    minAbsOfi: num(env.KALSHI15M_B_MIN_OFI, 0.3),
    minNetPp: num(env.KALSHI15M_B_MIN_NET_PP, 2),
    bufferPp: num(env.KALSHI15M_B_BUFFER_PP, 1),
    minTauSec: num(env.KALSHI15M_B_MIN_TAU_SEC, 15),
    costModel: env.KALSHI15M_B_COST_MODEL === 'MAKER' ? 'MAKER' : 'TAKER',
  };
}

export interface MicroInput {
  cfg: MicroConfig;
  tauSec: number | null;
  /** YES mid and the microprice (size-weighted top of book) */
  mid: number | null;
  micro: number | null;
  imbalance: number | null;
  ofi: number | null;
  takerBias60s: number | null;
  yesBid: number | null;
  yesAsk: number | null;
}

/**
 * Microprice vs mid as the short-horizon drift estimate, CONFIRMED by flow:
 * imbalance, order-flow imbalance and taker-side bias must all point the same
 * way, otherwise the microprice is just a lopsided top of book. The expected
 * move is the raw microprice gap — no invented coefficient is applied to it,
 * and whatever gap exists still has to beat the full round trip.
 */
export function evaluateMicro(input: MicroInput): StrategyVerdict {
  const r: string[] = [];
  const { cfg } = input;
  const skip = (reason: string): StrategyVerdict => mkVerdict('B_MICRO', 'SKIP', r, { skipReason: reason });
  if (input.tauSec === null) return skip('no_tau');
  r.push(`tau=${input.tauSec.toFixed(1)}s`);
  if (input.tauSec < cfg.minTauSec) return skip('too_close_to_settlement');
  if (input.mid === null || input.micro === null) return skip('no_microprice');
  if (input.yesBid === null || input.yesAsk === null || input.yesAsk <= input.yesBid) return skip('no_executable_book');

  const gap = (input.micro - input.mid) * 100; // pp, signed toward the microprice
  r.push(`mid=${input.mid.toFixed(4)} micro=${input.micro.toFixed(4)} gap=${gap.toFixed(3)}pp`);
  if (Math.abs(gap) < 1e-9) return skip('micro_flat');

  const side: 'YES' | 'NO' = gap > 0 ? 'YES' : 'NO';
  const sign = side === 'YES' ? 1 : -1;
  const imbalance = input.imbalance ?? 0;
  const ofi = input.ofi ?? 0;
  const taker = input.takerBias60s ?? 0;
  r.push(`imb=${imbalance.toFixed(2)} ofi=${ofi.toFixed(2)} taker=${taker.toFixed(2)}`);
  if (Math.abs(imbalance) < cfg.minAbsImbalance) return skip('imbalance_too_weak');
  if (Math.sign(imbalance) !== sign) return skip('flow_disagreement');
  if (Math.abs(ofi) < cfg.minAbsOfi) return skip('ofi_too_weak');
  if (Math.sign(ofi) !== sign) return skip('ofi_disagreement');
  if (taker !== 0 && Math.sign(taker) !== sign) return skip('taker_flow_disagreement');

  const expected = Math.abs(gap);
  const costPp = cfg.costModel === 'MAKER' ? 0 : sideCost(side, input.yesBid, input.yesAsk);
  const netPp = expected - costPp - cfg.bufferPp;
  r.push(`cost_model=${cfg.costModel} expected=${expected.toFixed(3)}pp cost=${costPp.toFixed(2)}pp net=${netPp.toFixed(2)}pp`);
  if (netPp < cfg.minNetPp) return mkVerdict('B_MICRO', 'SKIP', r, {
    skipReason: 'edge_below_cost', side, remainingPp: expected, costPp, netPp,
  });
  return mkVerdict('B_MICRO', 'TRADE', r, { side, remainingPp: expected, costPp, netPp });
}

/* ================================================================== */
/* STRATEGY C — panic fade                                             */
/* ================================================================== */

export interface PanicConfig {
  enabled: boolean;
  /** contract-price decline over lookbackSec that counts as a panic, in pp */
  dropPp: number;
  lookbackSec: number;
  /** if spot moved MORE than this over the window, the drop is real news */
  spotConfirmMaxBps: number;
  /** fraction of the unexplained decline assumed to revert (assumption) */
  reboundFraction: number;
  minNetPp: number;
  bufferPp: number;
  minTauSec: number;
}

export function panicConfigFromEnv(env: Record<string, string | undefined> = process.env): PanicConfig {
  return {
    enabled: bool(env.KALSHI15M_STRAT_C, false),
    dropPp: num(env.KALSHI15M_C_DROP_PP, 5),
    lookbackSec: num(env.KALSHI15M_C_LOOKBACK_SEC, 10),
    spotConfirmMaxBps: num(env.KALSHI15M_C_SPOT_CONFIRM_BPS, 1),
    reboundFraction: num(env.KALSHI15M_C_REBOUND_FRACTION, 0.5),
    minNetPp: num(env.KALSHI15M_C_MIN_NET_PP, 2),
    bufferPp: num(env.KALSHI15M_C_BUFFER_PP, 1),
    minTauSec: num(env.KALSHI15M_C_MIN_TAU_SEC, 15),
  };
}

export interface PanicInput {
  cfg: PanicConfig;
  tauSec: number | null;
  /** YES mid now and lookbackSec ago */
  midNow: number | null;
  midLag: number | null;
  /** spot move over the same window, in bps */
  spotMoveBps: number | null;
  yesBid: number | null;
  yesAsk: number | null;
}

/**
 * A large contract-price drop that SPOT did not confirm is treated as a
 * liquidity/panic move, not a change in settlement probability. The rebound
 * size is a stated assumption (reboundFraction of the unexplained decline),
 * not a measurement — the shadow log exists to test that assumption against
 * what actually happened, so the parameter can be retired or fitted later.
 */
export function evaluatePanicFade(input: PanicInput): StrategyVerdict {
  const r: string[] = [];
  const { cfg } = input;
  const skip = (reason: string): StrategyVerdict => mkVerdict('C_PANICFADE', 'SKIP', r, { skipReason: reason });
  if (input.tauSec === null) return skip('no_tau');
  r.push(`tau=${input.tauSec.toFixed(1)}s`);
  if (input.tauSec < cfg.minTauSec) return skip('too_close_to_settlement');
  if (input.midNow === null || input.midLag === null) return skip('no_mid_history');
  if (input.spotMoveBps === null) return skip('no_spot_history');
  if (input.yesBid === null || input.yesAsk === null || input.yesAsk <= input.yesBid) return skip('no_executable_book');

  const dropPp = (input.midLag - input.midNow) * 100; // positive when the contract fell
  r.push(`drop=${dropPp.toFixed(2)}pp/${cfg.lookbackSec}s spot=${input.spotMoveBps.toFixed(2)}bps`);
  if (dropPp < cfg.dropPp) return skip('no_panic_drop');
  if (Math.abs(input.spotMoveBps) > cfg.spotConfirmMaxBps) return skip('spot_confirms_move');

  const side: 'YES' | 'NO' = 'YES'; // fading a decline = buying what fell
  const expected = dropPp * cfg.reboundFraction;
  const costPp = sideCost(side, input.yesBid, input.yesAsk);
  const netPp = expected - costPp - cfg.bufferPp;
  r.push(`rebound=${expected.toFixed(2)}pp (fraction ${cfg.reboundFraction}) cost=${costPp.toFixed(2)}pp net=${netPp.toFixed(2)}pp`);
  r.push('rebound_fraction=ASSUMPTION (shadow measures it)');
  if (netPp < cfg.minNetPp) return mkVerdict('C_PANICFADE', 'SKIP', r, {
    skipReason: 'edge_below_cost', side, remainingPp: expected, costPp, netPp,
  });
  return mkVerdict('C_PANICFADE', 'TRADE', r, { side, remainingPp: expected, costPp, netPp });
}

/* ================================================================== */
/* STRATEGY D — momentum scalping                                      */
/* ================================================================== */

export interface MomentumConfig {
  enabled: boolean;
  lookbackSec: number;
  moveBps: number;
  requireAgreement: boolean;
  /** how much of the observed move is assumed to continue, 0..1 (assumption) */
  continuation: number;
  /** intended holding period the projection is scaled to (seconds) */
  holdSec: number;
  minNetPp: number;
  bufferPp: number;
  minTauSec: number;
}

export function momentumConfigFromEnv(env: Record<string, string | undefined> = process.env): MomentumConfig {
  return {
    enabled: bool(env.KALSHI15M_STRAT_D, false),
    lookbackSec: num(env.KALSHI15M_D_LOOKBACK_SEC, 3),
    moveBps: num(env.KALSHI15M_D_MOVE_BPS, 1.5),
    requireAgreement: env.KALSHI15M_D_AGREEMENT !== '0',
    continuation: num(env.KALSHI15M_D_CONTINUATION, 0.5),
    holdSec: num(env.KALSHI15M_D_HOLD_SEC, 10),
    minNetPp: num(env.KALSHI15M_D_MIN_NET_PP, 2),
    bufferPp: num(env.KALSHI15M_D_BUFFER_PP, 1),
    minTauSec: num(env.KALSHI15M_D_MIN_TAU_SEC, 15),
  };
}

export interface MomentumInput {
  cfg: MomentumConfig;
  tauSec: number | null;
  strike: number | null;
  spotNow: number | null;
  spotLag: number | null;
  venuesAgree: boolean;
  sigmaPerSec: number | null;
  /** what the book has ALREADY repriced over the lookback, pp */
  repricedPp: number | null;
  yesBid: number | null;
  yesAsk: number | null;
}

/**
 * Cross-venue confirmed momentum, projected forward by a STATED continuation
 * factor (default: half the observed log-move, scaled to the holding period).
 * The projection is an assumption — recorded in `reasons` and in the shadow
 * log — never presented as a measurement. Already-repriced moves earn nothing:
 * only the projected remainder is counted, and it must clear costs twice over.
 */
export function evaluateMomentum(input: MomentumInput): StrategyVerdict {
  const r: string[] = [];
  const { cfg } = input;
  const skip = (reason: string): StrategyVerdict => mkVerdict('D_MOMENTUM', 'SKIP', r, { skipReason: reason });
  if (input.tauSec === null) return skip('no_tau');
  r.push(`tau=${input.tauSec.toFixed(1)}s`);
  if (input.tauSec < cfg.minTauSec) return skip('too_close_to_settlement');
  if (input.strike === null || input.sigmaPerSec === null) return skip('no_model_inputs');
  if (input.spotNow === null || input.spotLag === null || !(input.spotLag > 0)) return skip('no_spot_history');
  if (input.yesBid === null || input.yesAsk === null || input.yesAsk <= input.yesBid) return skip('no_executable_book');

  const move = Math.log(input.spotNow / input.spotLag) * 10_000;
  r.push(`move=${move.toFixed(2)}bps/${cfg.lookbackSec}s`);
  if (Math.abs(move) < cfg.moveBps) return skip('move_too_small');
  if (cfg.requireAgreement && !input.venuesAgree) return skip('venue_disagreement');

  const projected = move * cfg.continuation * (cfg.holdSec / cfg.lookbackSec);
  const spotProj = input.spotNow * Math.exp(projected / 10_000);
  const pNow = fairValue({ spot: input.spotNow, strike: input.strike, tauSec: input.tauSec, sigmaPerSec: input.sigmaPerSec, approx: 'model' }).pYes;
  const pProj = fairValue({ spot: spotProj, strike: input.strike, tauSec: Math.max(1, input.tauSec - cfg.holdSec), sigmaPerSec: input.sigmaPerSec, approx: 'model' }).pYes;
  if (pNow === null || pProj === null) return skip('model_unavailable');

  const side: 'YES' | 'NO' = projected >= 0 ? 'YES' : 'NO';
  const sign = side === 'YES' ? 1 : -1;
  const expected = Math.abs((pProj - pNow) * 100);
  const alreadyRepriced = sign * (input.repricedPp ?? 0);
  const remaining = Math.max(0, expected - Math.max(0, alreadyRepriced));
  const costPp = sideCost(side, input.yesBid, input.yesAsk);
  const netPp = remaining - costPp - cfg.bufferPp;
  r.push(`projected=${projected.toFixed(2)}bps expected=${expected.toFixed(2)}pp repriced=${(input.repricedPp ?? 0).toFixed(2)}pp`);
  r.push(`continuation=${cfg.continuation} hold=${cfg.holdSec}s = ASSUMPTION (shadow measures it)`);
  r.push(`remaining=${remaining.toFixed(2)}pp cost=${costPp.toFixed(2)}pp net=${netPp.toFixed(2)}pp`);
  if (netPp < cfg.minNetPp) return mkVerdict('D_MOMENTUM', 'SKIP', r, {
    skipReason: 'edge_below_cost', side, expectedMovePp: expected,
    repricedPp: input.repricedPp, remainingPp: remaining, costPp, netPp,
  });
  return mkVerdict('D_MOMENTUM', 'TRADE', r, {
    side, expectedMovePp: expected, repricedPp: input.repricedPp, remainingPp: remaining, costPp, netPp,
  });
}

/* ================================================================== */
/* STRATEGY E — late-window favorites                                  */
/* ================================================================== */

export interface LateFavConfig {
  enabled: boolean;
  /** only consider contracts priced at or above this (0.80 = 80c) */
  minPrice: number;
  /** never above this: at ~0.99 one loss erases ~99 wins and fees bite */
  maxPrice: number;
  /** only inside the last N seconds */
  maxTauSec: number;
  /** HOLD = carry to settlement; EXIT = sell back before it */
  variant: 'HOLD' | 'EXIT';
  /** EXIT only: seconds before close the position is sold */
  exitLeadSec: number;
  minNetPp: number;
  bufferPp: number;
}

export function lateFavConfigFromEnv(env: Record<string, string | undefined> = process.env): LateFavConfig {
  return {
    enabled: bool(env.KALSHI15M_STRAT_E, false),
    minPrice: num(env.KALSHI15M_E_MIN_PRICE, 0.8),
    maxPrice: num(env.KALSHI15M_E_MAX_PRICE, 0.97),
    maxTauSec: num(env.KALSHI15M_E_MAX_TAU_SEC, 180),
    variant: env.KALSHI15M_E_VARIANT === 'EXIT' ? 'EXIT' : 'HOLD',
    exitLeadSec: num(env.KALSHI15M_E_EXIT_LEAD_SEC, 20),
    minNetPp: num(env.KALSHI15M_E_MIN_NET_PP, 2),
    bufferPp: num(env.KALSHI15M_E_BUFFER_PP, 1),
  };
}

export interface LateFavInput {
  cfg: LateFavConfig;
  tauSec: number | null;
  /** model probability and the price actually payable (the ASK, never mid) */
  pYes: number | null;
  entryPrice: number | null;
  yesBid: number | null;
  yesAsk: number | null;
}

/**
 * Two variants, both gated on EV rather than on the seductive win rate:
 * HOLD = p - entry - entry fee (a win pays $1, a loss $0, no exit);
 * EXIT = p - entry - full round trip (spread + two taker fees).
 * The rare-loss arithmetic is printed into `reasons` every time: at price P
 * one loss erases round(1/(1-P)) wins, which is the whole reason a 90%+ win
 * rate is not a profit claim.
 */
export function evaluateLateFav(input: LateFavInput): StrategyVerdict {
  const r: string[] = [];
  const { cfg } = input;
  const name = cfg.variant === 'HOLD' ? 'E_LATEFAV_HOLD' : 'E_LATEFAV_EXIT';
  const skip = (reason: string): StrategyVerdict => mkVerdict(name, 'SKIP', r, { skipReason: reason });
  if (input.tauSec === null) return skip('no_tau');
  r.push(`tau=${input.tauSec.toFixed(1)}s variant=${cfg.variant}`);
  if (input.tauSec > cfg.maxTauSec) return skip('not_late_enough');
  if (cfg.variant === 'EXIT' && input.tauSec <= cfg.exitLeadSec) return skip('inside_exit_lead');
  if (input.pYes === null) return skip('no_model_probability');
  if (input.entryPrice === null) return skip('no_price');
  if (input.yesBid === null || input.yesAsk === null || input.yesAsk <= input.yesBid) return skip('no_executable_book');
  if (input.entryPrice < cfg.minPrice) return skip('not_a_favorite');
  if (input.entryPrice > cfg.maxPrice) return skip('price_ceiling');

  const p = input.pYes;
  const price = input.entryPrice;
  const erases = Math.round(1 / Math.max(1e-9, 1 - price));
  r.push(`p=${p.toFixed(4)} entry=${price.toFixed(4)} rare_loss=1 loss erases ~${erases} wins`);
  const feePp = takerFee(1, price, KXBTC15M_FEES).perContract * 100;
  let costPp: number;
  let ev: number; // cents per contract
  if (cfg.variant === 'HOLD') {
    costPp = feePp;
    ev = (p - price) * 100 - feePp;
    r.push(`HOLD: ev = p - price - entry_fee (${feePp.toFixed(3)}c)`);
  } else {
    costPp = sideCost('YES', input.yesBid, input.yesAsk);
    ev = (p - price) * 100 - costPp;
    r.push(`EXIT at -${cfg.exitLeadSec}s: ev = p - price - round_trip (${costPp.toFixed(2)}c)`);
  }
  const netPp = ev - cfg.bufferPp;
  r.push(`ev=${ev.toFixed(2)}pp net=${netPp.toFixed(2)}pp (min ${cfg.minNetPp})`);
  if (netPp < cfg.minNetPp) return mkVerdict(name, 'SKIP', r, {
    skipReason: 'edge_below_cost', side: 'YES', remainingPp: ev, costPp, netPp,
  });
  return mkVerdict(name, 'TRADE', r, { side: 'YES', remainingPp: ev, costPp, netPp });
}

/* ================================================================== */
/* STRATEGY F — passive market making                                  */
/* ================================================================== */

export interface MakerConfig {
  enabled: boolean;
  minNetPp: number;
  bufferPp: number;
  minTauSec: number;
}

export function makerConfigFromEnv(env: Record<string, string | undefined> = process.env): MakerConfig {
  return {
    enabled: bool(env.KALSHI15M_STRAT_F, false),
    minNetPp: num(env.KALSHI15M_F_MIN_NET_PP, 2),
    bufferPp: num(env.KALSHI15M_F_BUFFER_PP, 1),
    minTauSec: num(env.KALSHI15M_F_MIN_TAU_SEC, 15),
  };
}

export interface MakerInput {
  cfg: MakerConfig;
  tauSec: number | null;
  pYes: number | null;
  yesBid: number | null;
  yesAsk: number | null;
}

/**
 * Resting orders on KXBTC15M pay NO fee (series fee_type=quadratic, verified
 * live), so the theoretical edge of a resting bid is (p - bid) with zero cost
 * beyond adverse selection. Queue position, probability of fill and adverse
 * selection are NOT modelled here — no queue data exists in this engine — and
 * every verdict says so explicitly. A TRADE from this function means "a
 * resting order here would be theoretically positive if filled", which is a
 * much weaker statement than "this fills profitably".
 */
export function evaluateMaker(input: MakerInput): StrategyVerdict {
  const r: string[] = [];
  const { cfg } = input;
  const skip = (reason: string): StrategyVerdict => mkVerdict('F_MAKER', 'SKIP', r, { skipReason: reason });
  if (input.tauSec === null) return skip('no_tau');
  r.push(`tau=${input.tauSec.toFixed(1)}s maker_fee=0 (series fee_type=quadratic)`);
  if (input.tauSec < cfg.minTauSec) return skip('too_close_to_settlement');
  if (input.pYes === null) return skip('no_model_probability');
  if (input.yesBid === null || input.yesAsk === null || input.yesAsk <= input.yesBid) return skip('no_executable_book');

  // quote both sides: a resting YES bid at the touch, a resting NO bid (= the
  // YES ask); keep whichever the model says is cheaper than it is worth
  const candidates: Array<{ side: 'YES' | 'NO'; bid: number; p: number }> = [
    { side: 'YES', bid: input.yesBid, p: input.pYes },
    { side: 'NO', bid: 1 - input.yesAsk, p: 1 - input.pYes },
  ];
  const best = candidates.reduce((a, b) => (b.p - b.bid > a.p - a.bid ? b : a));
  const edge = (best.p - best.bid) * 100;
  r.push(`best_quote=${best.side} bid=${best.bid.toFixed(4)} p=${best.p.toFixed(4)} edge=${edge.toFixed(2)}pp`);
  r.push('queue_position=UNMODELLED | fill_probability=UNMODELLED | adverse_selection=UNMODELLED');
  const netPp = edge - cfg.bufferPp;
  r.push(`net=${netPp.toFixed(2)}pp (min ${cfg.minNetPp})`);
  if (netPp < cfg.minNetPp) return mkVerdict('F_MAKER', 'SKIP', r, {
    skipReason: 'edge_below_cost', side: best.side, remainingPp: edge, costPp: 0, netPp,
  });
  return mkVerdict('F_MAKER', 'TRADE', r, { side: best.side, remainingPp: edge, costPp: 0, netPp });
}
