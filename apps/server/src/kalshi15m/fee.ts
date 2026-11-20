/**
 * Kalshi fee model — PURE. Source: Kalshi fee schedule (kalshi.com fee PDF,
 * verified against the live series API on 2026-11-20):
 *
 *   taker: fee = round_up(M * 0.07 * C * P * (1 - P))   dollars
 *   maker: fee = round_up(M * 0.0175 * C * P * (1 - P))  only when the series
 *          fee_type includes maker fees ("quadratic_with_maker_fees")
 *   settlement: free
 *
 * KXBTC15M reports fee_type "quadratic", fee_multiplier 1 -> TAKERS ONLY.
 * A resting order on this series pays nothing, which is the entire economic
 * argument for the passive/maker strategy — and the reason round-trip cost
 * depends on HOW you execute, not just where.
 *
 * Rounding (docs.kalshi.com fee rounding): the raw fee is rounded up to a
 * millionth of a dollar, then fee+positionCost is rounded up to a centicent
 * ($0.0001) for a direct member; the excess counts as fee. We model the
 * centicent ceiling because it is the conservative (higher-cost) reading and
 * it is what a $0.01-precision broker account pays.
 */

export const TAKER_COEFF = 0.07;
export const MAKER_COEFF = 0.0175;

export type FeeType = 'quadratic' | 'quadratic_with_maker_fees' | string;

export interface FeeSchedule {
  feeType: FeeType;
  /** M in the formula (series fee_multiplier) */
  takerMultiplier: number;
  /** M for resting orders; null when the series charges makers at all */
  makerMultiplier: number | null;
}

/** KXBTC15M as reported by `GET /trade-api/v2/series/KXBTC15M`. */
export const KXBTC15M_FEES: FeeSchedule = {
  feeType: 'quadratic',
  takerMultiplier: 1,
  makerMultiplier: null,
};

/**
 * ceil to 1e-6 dollars (Kalshi's fee precision before the balance rounding).
 * The 1e-6-unit tolerance absorbs binary-float noise: 0.07*0.5*0.5 computes
 * to 0.017500000000000002 and a naive ceil would bill 0.0176 — a fee that
 * does not exist. Kalshi works in exact decimals; we must not invent cents.
 */
export function ceilMicro(x: number): number {
  if (!Number.isFinite(x) || x <= 0) return 0;
  return Math.ceil(x * 1_000_000 - 1e-6) / 1_000_000;
}

/** ceil to a centicent $0.0001 (direct-member balance precision) */
export function ceilCenticent(x: number): number {
  if (!Number.isFinite(x) || x <= 0) return 0;
  return Math.ceil(x * 10_000 - 1e-6) / 10_000;
}

/** Raw quadratic fee in dollars before any rounding. */
export function rawQuadraticFee(contracts: number, price: number, coeff: number, multiplier = 1): number {
  if (!(contracts > 0) || !(price > 0) || price >= 1) return 0;
  return coeff * multiplier * contracts * price * (1 - price);
}

export interface FeeQuote {
  /** fee in dollars after the centicent ceiling — the number to budget with */
  fee: number;
  /** before balance rounding (1e-6 grid) */
  feeExact: number;
  /** dollars per contract */
  perContract: number;
}

/** Taker fee for taking liquidity now (fills against a resting order). */
export function takerFee(contracts: number, price: number, sched: FeeSchedule = KXBTC15M_FEES): FeeQuote {
  const feeExact = ceilMicro(rawQuadraticFee(contracts, price, TAKER_COEFF, sched.takerMultiplier));
  const fee = ceilCenticent(feeExact);
  return { fee, feeExact, perContract: contracts > 0 ? fee / contracts : 0 };
}

/**
 * Maker fee for an order that rests and is filled later.
 * Zero when the series carries no maker fee (KXBTC15M today); never assumes
 * free — pass the series' own schedule.
 */
export function makerFee(contracts: number, price: number, sched: FeeSchedule = KXBTC15M_FEES): FeeQuote {
  if (sched.makerMultiplier === null) return { fee: 0, feeExact: 0, perContract: 0 };
  const feeExact = ceilMicro(rawQuadraticFee(contracts, price, MAKER_COEFF, sched.makerMultiplier));
  const fee = ceilCenticent(feeExact);
  return { fee, feeExact, perContract: contracts > 0 ? fee / contracts : 0 };
}

export interface RoundTripCost {
  /** entry fee (taker by default: you crossed the spread to get in) */
  entryFee: number;
  exitFee: number;
  /** spread paid in dollars (entryPrice - exitPrice normalized per contract) */
  spread: number;
  /** everything that must be beaten, per contract, in dollars */
  total: number;
  /** same, in cents — the unit the spec's 2¢ target is denominated in */
  totalCents: number;
}

/**
 * All-in cost of one round trip per contract.
 * `entryPrice`/`exitPrice` are the EXECUTABLE prices used (ask to enter,
 * bid to exit — never midpoints), so `spread` is what the book actually
 * charged, not a modelled number.
 */
export function roundTripCost(opts: {
  contracts: number;
  entryPrice: number;
  exitPrice: number;
  entryIsTaker?: boolean;
  exitIsTaker?: boolean;
  sched?: FeeSchedule;
}): RoundTripCost {
  const sched = opts.sched ?? KXBTC15M_FEES;
  const eTaker = opts.entryIsTaker !== false;
  const xTaker = opts.exitIsTaker !== false;
  const entry = eTaker ? takerFee(opts.contracts, opts.entryPrice, sched) : makerFee(opts.contracts, opts.entryPrice, sched);
  const exit = xTaker ? takerFee(opts.contracts, opts.exitPrice, sched) : makerFee(opts.contracts, opts.exitPrice, sched);
  // prices live on the 0.001/0.01 tick grid — subtract in tick units so the
  // spread never carries float dust (0.44-0.43 must be 0.01, not 0.0100…009)
  const spread = Math.max(0, Math.round((opts.entryPrice - opts.exitPrice) * 10_000) / 10_000);
  const total = entry.fee / opts.contracts + exit.fee / opts.contracts + spread;
  return {
    entryFee: entry.fee, exitFee: exit.fee, spread,
    total: opts.contracts > 0 ? total : 0,
    totalCents: opts.contracts > 0 ? total * 100 : 0,
  };
}

/**
 * Price you must win at to break even after paying `price` to enter as a
 * taker (a $1.00 settlement on a win). Includes the entry fee only — exiting
 * by selling back at `price` is a different question, handled by
 * roundTripCost. Returns null outside (0,1).
 */
export function breakevenWinProbability(price: number, sched: FeeSchedule = KXBTC15M_FEES): number | null {
  if (!(price > 0) || price >= 1) return null;
  const per = takerFee(1, price, sched).perContract;
  const be = price + per;
  return Math.min(1, be);
}