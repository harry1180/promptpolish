/**
 * Fair value for a KXBTC15M contract — PURE.
 *
 * WHAT SETTLES (official rule, read live from the market):
 *   YES iff  avg(60 one-second CF Benchmarks BRTI prints before CLOSE)
 *          ≥ avg(60 one-second prints before OPEN)   (= floor_strike, K)
 * A tie resolves YES. The settlement value is therefore an AVERAGE, not a
 * last tick — which changes the risk shape materially, and is the single
 * most-mis-modelled thing about these contracts (buying "gamma" intuition
 * from a last-tick option is wrong; see the variance derivation below).
 *
 * MODEL (driftless arithmetic-Brownian-on-log-price, v = per-second variance):
 *   let tau = seconds to close, W(u) = log-price noise, Var W(u) = v*u.
 *
 *   tau >= 60 (settlement window not yet started):
 *     the whole 60s window [tau-60, tau] is unknown, so
 *       Var = (1/60^2) * integral integral v*min(u,w) du dw
 *           = v * [ (b^3-a^3)/3 - a^2*(b-a) ] / 3600      (a=tau-60, b=tau)
 *           = v * (tau - 40)                      <- collapses to this
 *
 *   tau < 60 (inside the settlement minute): prints up to now are already
 *     FIXED, only [0, tau] is still random, and they are averaged over the
 *     full 60:
 *       Var = (1/60^2) * v * tau^3 / 3  =  v * tau^3 / 10800
 *
 *   Continuity at tau=60: 20v from both sides.
 *
 * Both published sanity checks from the independent tape study reproduce:
 *   tau=150s -> std = sqrt(v*110) vs last-tick sqrt(v*150) = 14.3% smaller
 *               ("14% smaller at 12:30" of a 15-minute window)
 *   tau=30s  -> sqrt(30^3/10800)/sqrt(30) = 0.289 = 71.1% smaller
 *               ("71% smaller with 30 seconds left")
 *
 * SPOT IS AN APPROXIMATION: settlement uses BRTI, which is licensed and not
 * available here. Every value this module produces carries `reference:
 * 'APPROXIMATION'` and the caller must label it. We never substitute an
 * exchange price for the index silently — `approx` says which venue fed it.
 */

export type ReferenceKind = 'APPROXIMATION' | 'OFFICIAL';

export interface SettlementVariance {
  /** variance of the settlement log-value, in units of v (per-second variance) */
  varianceUnits: number;
  /** dimensionless sqrt(varianceUnits) — scale factor on sigma */
  stdUnits: number;
  /** std of the settlement log-value = sigma * sqrt(varianceUnits) */
  std: number;
  /** how the terminal uncertainty compares with a last-tick settle, 0..1 */
  vsLastTick: number;
  regime: 'WINDOW_OPEN' | 'SETTLEMENT_MINUTE';
}

/**
 * Variance of the settlement average given tau (seconds to close) and
 * sigma (per-SECOND log-return standard deviation from the spot tape).
 * Returns null when the inputs cannot support a number (never guesses).
 */
export function settlementVariance(tauSec: number, sigmaPerSec: number): SettlementVariance | null {
  if (!Number.isFinite(tauSec) || !Number.isFinite(sigmaPerSec)) return null;
  if (tauSec <= 0 || sigmaPerSec <= 0) return null;
  const units = tauSec >= 60 ? tauSec - 40 : (tauSec ** 3) / 10_800;
  if (!(units > 0)) return null;
  const std = sigmaPerSec * Math.sqrt(units);
  const lastTickStd = sigmaPerSec * Math.sqrt(tauSec);
  return {
    varianceUnits: units,
    stdUnits: Math.sqrt(units),
    std,
    vsLastTick: std / lastTickStd,
    regime: tauSec >= 60 ? 'WINDOW_OPEN' : 'SETTLEMENT_MINUTE',
  };
}

export interface FairValueInput {
  /** spot mid used as the settlement reference — ALWAYS an approximation */
  spot: number | null;
  /** official strike = BRTI average before the window opened */
  strike: number | null;
  /** seconds until close */
  tauSec: number | null;
  /** per-second log-return sigma from the spot tape */
  sigmaPerSec: number | null;
  /** which venue the spot came from (kraken / coinbase) for the label */
  approx?: string | null;
}

export interface FairValue {
  /** P(settle >= strike), 0..1 */
  pYes: number | null;
  /** 1 - pYes, for symmetry in reports */
  pNo: number | null;
  /** std of the settlement log-value in log units */
  stdLog: number | null;
  /** log distance to strike, normalized: (ln(S/K)) / std — the z-score */
  z: number | null;
  tauSec: number;
  regime: SettlementVariance['regime'] | 'NO_INPUT';
  reference: ReferenceKind;
  approx: string | null;
  /** explicit reason when no number could be produced */
  reason?: string;
}

/** Standard normal CDF (Abramowitz-Stegun 7.1.26 through erf rational approx). */
export function normCdf(x: number): number {
  // erf via the Hart/Cody-style approximation is overkill here; use the
  // well-known Numerical-Recipes rational approximation (|err| < 1.5e-7)
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

/**
 * Fair value of the YES contract from the approximation inputs.
 * Returns pYes = null (with a reason) whenever any input is missing — a
 * silent fallback to a plausible number is exactly how a model starts lying.
 */
export function fairValue(input: FairValueInput): FairValue {
  const base: FairValue = {
    pYes: null, pNo: null, stdLog: null, z: null,
    tauSec: input.tauSec ?? 0,
    regime: 'NO_INPUT',
    reference: 'APPROXIMATION',
    approx: input.approx ?? null,
  };
  const { spot, strike, tauSec, sigmaPerSec } = input;
  if (spot === null || !(spot > 0)) return { ...base, reason: 'no_spot' };
  if (strike === null || !(strike > 0)) return { ...base, reason: 'no_strike' };
  if (tauSec === null || !Number.isFinite(tauSec)) return { ...base, reason: 'no_tau' };
  if (tauSec <= 0) return { ...base, reason: 'window_closed', tauSec };
  if (sigmaPerSec === null || !(sigmaPerSec > 0)) return { ...base, reason: 'no_sigma' };

  const v = settlementVariance(tauSec, sigmaPerSec);
  if (!v) return { ...base, reason: 'no_variance' };
  // sigma-SCALED std (v.std), never the dimensionless factor — using
  // sqrt(units) alone collapses every z to ~0 and every probability to 0.5
  const stdLog = v.std;
  const z = Math.log(spot / strike) / stdLog;
  const pYes = normCdf(z);
  return {
    pYes,
    pNo: 1 - pYes,
    stdLog,
    z,
    tauSec,
    regime: v.regime,
    reference: 'APPROXIMATION',
    approx: input.approx ?? null,
  };
}

/**
 * Where the fair value sits against the BOOK's implied probability
 * (mid of executable quotes — mid is used for COMPARISON only, never as a
 * fill). Positive edge means the book is asking more than the model thinks
 * the contract is worth. Both inputs are cents-fraction probabilities.
 */
export function modelEdge(pYes: number | null, impliedMid: number | null): number | null {
  if (pYes === null || impliedMid === null) return null;
  return pYes - impliedMid;
}

/** Seconds to close from a window close time. */
export function tauSeconds(closeTs: number, now: number): number {
  return (closeTs - now) / 1_000;
}

/**
 * Invert the model: the per-second sigma that WOULD justify the book's own
 * implied probability. This is the calibration instrument — comparing it
 * against the realized sigma over the same horizon tells us whether our vol
 * input is sane before any strategy is allowed to call the gap "edge".
 *
 * Returns null when the inversion carries no information:
 *  - implied p is too close to 0.5 (z ~ 0 -> any sigma fits),
 *  - the sign disagrees with spot vs strike (the book and the tape disagree
 *    about direction — a data problem, not a vol number),
 *  - tau or strike unusable.
 */
export function impliedSigma(
  pImplied: number | null, spot: number | null, strike: number | null, tauSec: number | null,
): number | null {
  if (pImplied === null || spot === null || strike === null || tauSec === null) return null;
  if (!(pImplied > 0 && pImplied < 1) || !(spot > 0) || !(strike > 0) || !(tauSec > 0)) return null;
  const z = normInv(pImplied);
  if (z === null || Math.abs(z) < 0.1) return null;
  const dist = Math.log(spot / strike);
  if (!Number.isFinite(dist) || dist === 0) return null;
  if (Math.sign(z) !== Math.sign(dist)) return null;
  const units = tauSec >= 60 ? tauSec - 40 : (tauSec ** 3) / 10_800;
  if (!(units > 0)) return null;
  const std = dist / z;
  if (!(std > 0)) return null;
  return std / Math.sqrt(units);
}

/** Inverse standard normal CDF (bisection on normCdf: simple, monotone, exact enough). */
export function normInv(p: number): number | null {
  if (!(p > 0) || !(p < 1)) return null;
  let lo = -8;
  let hi = 8;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (normCdf(mid) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}