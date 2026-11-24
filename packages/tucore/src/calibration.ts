/**
 * Outcome calibration (SHADOW layer) — maps this book's OWN raw numbers
 * (fused `confidence`, strategy `expectedReturn`) onto what its closed trades
 * actually delivered, so anything reading them gets an honest figure.
 *
 * Small-sample design (dozens of trades, not thousands):
 *  - exponential time decay (half-life 60 sessions) so the mapping follows the
 *    current regime instead of averaging across regimes;
 *  - fixed confidence buckets with Laplace smoothing toward the global prior.
 *    NO monotonicity is imposed: production confidence is currently
 *    ANTI-correlated with realized return, and an isotonic fit assuming
 *    "higher confidence = better" would have buried that finding;
 *  - a ridge-style slope for expected return shrunk toward zero by
 *    n/(n+minSamples): with little evidence the honest forecast is the book's
 *    own average outcome, never the raw number;
 *  - below the evidence floor everything reports the prior with
 *    `sufficient:false`.
 *
 * Read-only instrumentation: it never gates, filters or sizes a trade.
 */
export interface CalibrationSample {
  /** fused confidence at emit time, 0..1 */
  confidence: number;
  /** raw strategy expected return (fraction, e.g. 0.046 = +4.6%) */
  predictedReturn: number;
  /** realized return of the closed trade (fraction) */
  actualReturn: number;
  /** exit timestamp (ms) — drives the time decay */
  ts: number;
}

export interface CalibrationBucket {
  lo: number;
  hi: number;
  /** sample count in the bucket (integer) */
  n: number;
  /** decay-weighted win rate, Laplace-smoothed toward the prior */
  winRate: number;
  /** decay-weighted mean realized return */
  meanReturn: number;
  /** standard error of winRate (normal approximation) */
  se: number;
}

export interface ReturnModel {
  /** shrunk slope: calibrated = intercept + slope * raw */
  slope: number;
  intercept: number;
  /** weighted correlation between predicted and actual return */
  r: number;
  meanPredicted: number;
  meanActual: number;
}

export interface Calibration {
  sufficient: boolean;
  n: number;
  effectiveN: number;
  halfLifeDays: number;
  priorWinRate: number;
  priorMeanReturn: number;
  buckets: CalibrationBucket[];
  returnModel: ReturnModel;
  updatedAt: number;
}

export interface CalibrationOptions {
  now?: number;
  halfLifeDays?: number;
  minSamples?: number;
  /** Laplace pseudo-count pulling thin buckets toward the prior */
  priorStrength?: number;
  bucketEdges?: number[];
}

export const CALIBRATION_MIN_SAMPLES = 10;
export const CALIBRATION_HALF_LIFE_DAYS = 60;
const DEFAULT_EDGES = [0, 0.55, 0.65, 0.75, 1.0001];

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function fitCalibration(samples: CalibrationSample[], opts: CalibrationOptions = {}): Calibration {
  const now = opts.now ?? Date.now();
  const halfLifeDays = opts.halfLifeDays ?? CALIBRATION_HALF_LIFE_DAYS;
  const minSamples = opts.minSamples ?? CALIBRATION_MIN_SAMPLES;
  const alpha = opts.priorStrength ?? 4;
  const edges = opts.bucketEdges ?? DEFAULT_EDGES;

  const rows = samples.filter(
    (s) => Number.isFinite(s.confidence) && Number.isFinite(s.actualReturn) && Number.isFinite(s.ts),
  );
  const n = rows.length;
  const weights = rows.map((r) => Math.pow(0.5, Math.max(0, now - r.ts) / 86_400_000 / halfLifeDays));

  let effectiveN = 0;
  let wWon = 0;
  let wActual = 0;
  let wPredicted = 0;
  rows.forEach((r, i) => {
    const w = weights[i];
    effectiveN += w;
    wWon += w * (r.actualReturn > 0 ? 1 : 0);
    wActual += w * r.actualReturn;
    wPredicted += w * (Number.isFinite(r.predictedReturn) ? r.predictedReturn : 0);
  });
  const priorWinRate = effectiveN > 0 ? wWon / effectiveN : 0.5;
  const meanActual = effectiveN > 0 ? wActual / effectiveN : 0;
  const meanPredicted = effectiveN > 0 ? wPredicted / effectiveN : 0;

  const buckets: CalibrationBucket[] = [];
  for (let b = 0; b + 1 < edges.length; b++) {
    const lo = edges[b];
    const hi = edges[b + 1];
    let bw = 0;
    let bwon = 0;
    let bret = 0;
    let count = 0;
    rows.forEach((r, i) => {
      if (r.confidence >= lo && r.confidence < hi) {
        count += 1;
        bw += weights[i];
        bwon += weights[i] * (r.actualReturn > 0 ? 1 : 0);
        bret += weights[i] * r.actualReturn;
      }
    });
    const denom = bw + alpha;
    const winRate = (bwon + alpha * priorWinRate) / denom;
    const meanReturn = bw > 0 ? bret / bw : meanActual;
    buckets.push({
      lo, hi, n: count, winRate, meanReturn,
      se: Math.sqrt(Math.max(0, winRate * (1 - winRate)) / denom),
    });
  }

  const sufficient = n >= minSamples;
  let slope = 0;
  let r = 0;
  if (sufficient && effectiveN > 0) {
    let cov = 0;
    let vx = 0;
    let vy = 0;
    rows.forEach((row, i) => {
      const x = Number.isFinite(row.predictedReturn) ? row.predictedReturn : 0;
      const y = row.actualReturn;
      const w = weights[i];
      cov += w * (x - meanPredicted) * (y - meanActual);
      vx += w * (x - meanPredicted) ** 2;
      vy += w * (y - meanActual) ** 2;
    });
    if (vx > 1e-12 && vy > 1e-14) {
      const shrink = n / (n + minSamples);
      slope = (cov / vx) * shrink;
      r = cov / Math.sqrt(vx * vy);
    }
  }

  return {
    sufficient,
    n,
    effectiveN,
    halfLifeDays,
    priorWinRate,
    priorMeanReturn: meanActual,
    buckets,
    returnModel: {
      slope,
      intercept: meanActual - slope * meanPredicted,
      r,
      meanPredicted,
      meanActual,
    },
    updatedAt: now,
  };
}

/** Realized win rate this book should expect at a given raw confidence. */
export function calibratedWinRate(cal: Calibration, confidence: number): number {
  if (!cal.sufficient) return cal.priorWinRate;
  const bucket = cal.buckets.find((b) => confidence >= b.lo && confidence < b.hi);
  return bucket ? bucket.winRate : cal.priorWinRate;
}

/** Honest expected return: shrunk model when there is evidence, book average otherwise. */
export function calibratedReturn(cal: Calibration, raw: number): number {
  if (!cal.sufficient) return cal.priorMeanReturn;
  const m = cal.returnModel;
  return clamp(m.intercept + m.slope * (Number.isFinite(raw) ? raw : 0), -0.5, 0.5);
}
