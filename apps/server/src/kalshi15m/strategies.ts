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
import { KXBTC15M_FEES, roundTripCost } from './fee.ts';

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