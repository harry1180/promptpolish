/**
 * Source-contribution evaluation — does Coinbase add anything over Kraken?
 *
 * Strictly chronological, point-in-time, research-only:
 *  - grid = Kraken sample timestamps (the reference venue)
 *  - features at t use only samples received at or before t
 *  - labels use the Kraken mid at t + horizon (never before)
 *  - train/test split is chronological with EXPANDING walk-forward folds
 *  - the Coinbase return is residualised against the Kraken return on the
 *    TRAIN rows only, so correlated signals are not double-counted
 *  - metrics: directional accuracy, balanced accuracy, Brier score +
 *    calibration buckets, expected net edge after round-trip cost
 *
 * Anything short of the evidence floor returns INSUFFICIENT_DATA — never a
 * fabricated number.
 */
import type { DatabaseSync } from 'node:sqlite';
import { loadSamples, type SampleRow } from './store.ts';

export interface ModelMetrics {
  n: number;
  accuracyPct: number | null;
  balancedAccuracyPct: number | null;
  brier: number | null;
  calibration: Array<{ bucket: string; predictedPct: number; observedPct: number; n: number }>;
  /** expected net return per evaluated signal after round-trip cost (%) */
  netEdgeAfterCostPct: number | null;
  signalsTaken: number;
  correctSignals: number;
}

export interface HorizonContribution {
  horizon: string;
  horizonMs: number;
  status: 'OK' | 'INSUFFICIENT_DATA';
  trainRows: number;
  testRows: number;
  folds: number;
  baseline: ModelMetrics;
  krakenOnly: ModelMetrics;
  krakenPlusCoinbase: ModelMetrics;
  incremental: {
    balancedAccuracyDeltaPct: number | null;
    brierDelta: number | null;
    netEdgeDeltaPct: number | null;
  };
  /** feature correlation handled: |r| between raw Coinbase and Kraken returns */
  featureRedundancyR: number | null;
  note: string;
}

export interface SourceContributionResult {
  symbol: string;
  generatedAt: number;
  windowMs: number;
  providers: Array<{ provider: string; samples: number; lastTs: number | null; ageMs: number | null }>;
  horizons: HorizonContribution[];
  freshness: Array<{ provider: string; symbol: string; ageMs: number | null; fresh: boolean }>;
  status: 'OK' | 'INSUFFICIENT_DATA' | 'NO_DATA';
  note: string;
}

export interface EvalOptions {
  symbol: string;
  /** round-trip cost, e.g. 0.0032 = 0.16% per side * 2 */
  feePct: number;
  now?: number;
  windowMs?: number;
  minTrain?: number;
  minTest?: number;
}

const HORIZONS: Array<{ label: string; ms: number }> = [
  { label: '30s', ms: 30_000 },
  { label: '60s', ms: 60_000 },
  { label: '5m', ms: 300_000 },
  { label: '15m', ms: 900_000 },
  { label: '1h', ms: 3_600_000 },
  { label: '1d', ms: 86_400_000 },
];

interface Series {
  ts: number[];
  mid: number[];
  spread: number[];
}

interface Row {
  t: number;
  krRet: number;
  krSpread: number;
  cbRet: number;
  cbDivergence: number;
  cbSpread: number;
}

function seriesOf(rows: SampleRow[], provider: string): Series {
  const mine = rows.filter((r) => r.provider === provider && r.mid !== null && r.mid > 0)
    .sort((a, b) => a.ts - b.ts);
  return {
    ts: mine.map((r) => r.ts),
    mid: mine.map((r) => r.mid as number),
    spread: mine.map((r) => r.spreadBps ?? 0),
  };
}

/** last sample at or before `t` (index into the series) */
function atOrBefore(s: Series, t: number): number {
  let lo = 0;
  let hi = s.ts.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (s.ts[mid] <= t) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return best;
}

/** nearest sample to `t` within `tolMs`, else -1 */
function nearest(s: Series, t: number, tolMs: number): number {
  const i = atOrBefore(s, t);
  const candidates = [i, i + 1].filter((k) => k >= 0 && k < s.ts.length);
  let best = -1;
  let bestDiff = Infinity;
  for (const k of candidates) {
    const d = Math.abs(s.ts[k] - t);
    if (d <= tolMs && d < bestDiff) { best = k; bestDiff = d; }
  }
  return best;
}

function ret(series: Series, iNow: number, lookbackMs: number): number | null {
  const t = series.ts[iNow];
  const j = atOrBefore(series, t - lookbackMs);
  if (j < 0) return null;
  const prev = series.mid[j];
  if (prev <= 0) return null;
  return (series.mid[iNow] - prev) / prev;
}

/** Build synchronized point-in-time rows (features at t); labels are resolved
 *  per horizon, so a row only ever needs to be younger than THAT horizon. */
function buildRows(kr: Series, cb: Series): Row[] {
  const out: Row[] = [];
  const lookbackMs = 60_000;
  for (let i = 0; i < kr.ts.length; i += 1) {
    const t = kr.ts[i];
    const krRet = ret(kr, i, lookbackMs);
    if (krRet === null) continue;
    const cbIdx = atOrBefore(cb, t);
    if (cbIdx < 0) continue;
    const cbRet = ret(cb, cbIdx, lookbackMs);
    if (cbRet === null) continue;
    const div = ((cb.mid[cbIdx] - kr.mid[i]) / kr.mid[i]) * 10_000;
    out.push({
      t,
      krRet,
      krSpread: kr.spread[i] ?? 0,
      cbRet,
      cbDivergence: div,
      cbSpread: cb.spread[cbIdx] ?? 0,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* tiny deterministic logistic regression (no deps, no randomness)     */
/* ------------------------------------------------------------------ */

interface Scaler { mean: number[]; std: number[]; }

function scale(rows: number[][], fit?: Scaler): { x: number[][]; scaler: Scaler } {
  const n = rows.length;
  const dims = rows[0]?.length ?? 0;
  const mean = fit?.mean ?? new Array(dims).fill(0).map((_, d) => rows.reduce((s, r) => s + r[d], 0) / Math.max(1, n));
  const std = fit?.std ?? new Array(dims).fill(0).map((_, d) => {
    const v = rows.reduce((s, r) => s + (r[d] - mean[d]) ** 2, 0) / Math.max(1, n);
    return Math.sqrt(v) || 1;
  });
  return { x: rows.map((r) => r.map((d, k) => (d - mean[k]) / std[k])), scaler: { mean, std } };
}

function fitLogistic(x: number[][], y: number[], dims: number): number[] {
  const w = new Array(dims).fill(0);
  let b = 0;
  const lr = 0.35;
  const epochs = 220;
  const n = x.length;
  if (n === 0) return [...w, b];
  for (let e = 0; e < epochs; e += 1) {
    const gw = new Array(dims).fill(0);
    let gb = 0;
    for (let i = 0; i < n; i += 1) {
      let z = b;
      for (let d = 0; d < dims; d += 1) z += w[d] * x[i][d];
      const p = 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
      const err = p - y[i];
      for (let d = 0; d < dims; d += 1) gw[d] += err * x[i][d];
      gb += err;
    }
    for (let d = 0; d < dims; d += 1) w[d] -= (lr * gw[d]) / n + 1e-4 * w[d];
    b -= (lr * gb) / n;
  }
  return [...w, b];
}

function predict(w: number[], row: number[]): number {
  let z = w[w.length - 1];
  for (let d = 0; d < row.length; d += 1) z += w[d] * row[d];
  return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
}

/** Long-only economics: a signal is taken when the model predicts UP, and its
 *  net is the ACTUAL forward return minus the round-trip cost — never a
 *  assumed win rate. `roundTripPct` is in percent (fee per side * 2 * 100). */
function metrics(preds: number[], labels: number[], fwdPct: number[], roundTripPct: number): ModelMetrics {
  const n = preds.length;
  if (n === 0) {
    return {
      n: 0, accuracyPct: null, balancedAccuracyPct: null, brier: null, calibration: [],
      netEdgeAfterCostPct: null, signalsTaken: 0, correctSignals: 0,
    };
  }
  let correct = 0;
  let posTotal = 0;
  let posCorrect = 0;
  let negTotal = 0;
  let negCorrect = 0;
  let brierSum = 0;
  let signals = 0;
  let signalsCorrect = 0;
  let edgeSum = 0;
  for (let i = 0; i < n; i += 1) {
    const predUp = preds[i] >= 0.5;
    const actualUp = labels[i] === 1;
    if (predUp === actualUp) correct += 1;
    if (actualUp) { posTotal += 1; if (predUp) posCorrect += 1; } else { negTotal += 1; if (!predUp) negCorrect += 1; }
    brierSum += (preds[i] - labels[i]) ** 2;
    // long-only book: only an UP prediction is tradeable; net = actual return - cost
    if (preds[i] > 0.5) {
      signals += 1;
      if (actualUp) signalsCorrect += 1;
      edgeSum += (fwdPct[i] ?? 0) - roundTripPct;
    }
  }
  const sens = posTotal > 0 ? posCorrect / posTotal : null;
  const spec = negTotal > 0 ? negCorrect / negTotal : null;
  const buckets: Array<{ bucket: string; predictedPct: number; observedPct: number; n: number }> = [];
  for (let b = 0; b < 10; b += 1) {
    const lo = b / 10;
    const hi = (b + 1) / 10;
    const idx = preds.map((p, i) => ({ p, i })).filter(({ p }) => (b === 9 ? p >= lo && p <= hi : p >= lo && p < hi));
    if (idx.length === 0) continue;
    buckets.push({
      bucket: `${Math.round(lo * 100)}-${Math.round(hi * 100)}%`,
      predictedPct: Math.round((idx.reduce((s, { p }) => s + p, 0) / idx.length) * 1000) / 10,
      observedPct: Math.round((idx.reduce((s, { i }) => s + labels[i], 0) / idx.length) * 1000) / 10,
      n: idx.length,
    });
  }
  return {
    n,
    accuracyPct: Math.round((correct / n) * 10_000) / 100,
    balancedAccuracyPct: sens !== null && spec !== null ? Math.round(((sens + spec) / 2) * 10_000) / 100 : null,
    brier: Math.round((brierSum / n) * 10_000) / 10_000,
    calibration: buckets,
    netEdgeAfterCostPct: signals > 0 ? Math.round((edgeSum / signals) * 10_000) / 10_000 : null,
    signalsTaken: signals,
    correctSignals: signalsCorrect,
  };
}

const FLAT_EPS = 0.0001; // 1 bp: flatter moves are not a direction

export function evaluateSourceContribution(db: DatabaseSync, opts: EvalOptions): SourceContributionResult {
  const now = opts.now ?? Date.now();
  const windowMs = opts.windowMs ?? 4 * 86_400_000;
  const minTrain = opts.minTrain ?? 300;
  const minTest = opts.minTest ?? 80;
  const rows = loadSamples(db, now - windowMs, opts.symbol)
    .filter((r) => r.provider === 'kraken' || r.provider === 'coinbase');

  const providers = (['kraken', 'coinbase'] as const).map((p) => {
    const mine = rows.filter((r) => r.provider === p);
    const lastTs = mine.reduce((m, r) => Math.max(m, r.ts), 0) || null;
    return {
      provider: p,
      samples: mine.length,
      lastTs,
      ageMs: lastTs === null ? null : now - lastTs,
    };
  });

  const freshness = (['kraken', 'coinbase'] as const).flatMap((p) =>
    (['USD'] as const).map(() => ({
      provider: p,
      symbol: opts.symbol,
      ageMs: providers.find((x) => x.provider === p)?.ageMs ?? null,
      fresh: (providers.find((x) => x.provider === p)?.ageMs ?? Infinity) < 30_000,
    })),
  );

  const base: SourceContributionResult = {
    symbol: opts.symbol,
    generatedAt: now,
    windowMs,
    providers,
    horizons: [],
    freshness,
    status: 'NO_DATA',
    note: '',
  };

  const kr = seriesOf(rows, 'kraken');
  const cb = seriesOf(rows, 'coinbase');
  if (kr.ts.length < 30 || cb.ts.length < 30) {
    return {
      ...base,
      status: 'NO_DATA',
      note: kr.ts.length < 30 && cb.ts.length < 30
        ? 'no synchronized samples yet — the layer is collecting'
        : kr.ts.length < 30
          ? 'Kraken samples missing'
          : 'Coinbase samples missing',
    };
  }

  const all = buildRows(kr, cb);
  const cost = opts.feePct; // per side; round trip = 2x applied in netEdge

  const horizons: HorizonContribution[] = [];
  for (const h of HORIZONS) {
    const usable = all.filter((r) => r.t + h.ms <= now);
    const needed = minTrain + minTest;
    if (usable.length < needed) {
      horizons.push({
        horizon: h.label,
        horizonMs: h.ms,
        status: 'INSUFFICIENT_DATA',
        trainRows: 0,
        testRows: 0,
        folds: 0,
        baseline: metrics([], [], [], 0),
        krakenOnly: metrics([], [], [], 0),
        krakenPlusCoinbase: metrics([], [], [], 0),
        incremental: { balancedAccuracyDeltaPct: null, brierDelta: null, netEdgeDeltaPct: null },
        featureRedundancyR: null,
        note: `needs ${needed} synchronized rows, have ${usable.length}`,
      });
      continue;
    }

    // labels for this horizon
    const labelled = usable.map((r) => {
      const i = nearest(kr, r.t + h.ms, Math.max(15_000, h.ms / 3));
      if (i < 0) return null;
      const fwd = (kr.mid[i] - kr.mid[atOrBefore(kr, r.t)]) / kr.mid[atOrBefore(kr, r.t)];
      if (!Number.isFinite(fwd) || Math.abs(fwd) < FLAT_EPS) return null; // flat = no direction
      return { row: r, label: fwd > 0 ? 1 : 0, fwdPct: fwd * 100 };
    }).filter((x): x is { row: Row; label: number; fwdPct: number } => x !== null);

    if (labelled.length < needed) {
      horizons.push({
        horizon: h.label, horizonMs: h.ms, status: 'INSUFFICIENT_DATA',
        trainRows: 0, testRows: 0, folds: 0,
        baseline: metrics([], [], [], 0), krakenOnly: metrics([], [], [], 0),
        krakenPlusCoinbase: metrics([], [], [], 0),
        incremental: { balancedAccuracyDeltaPct: null, brierDelta: null, netEdgeDeltaPct: null },
        featureRedundancyR: null,
        note: `${labelled.length} labelled rows after excluding flat moves (need ${needed})`,
      });
      continue;
    }

    // chronological walk-forward: expanding train, contiguous test blocks
    const folds = 3;
    const testSize = Math.floor(labelled.length * 0.4 / folds);
    const startTest = labelled.length - testSize * folds;
    const predsA: number[] = [];
    const predsB: number[] = [];
    const predsBase: number[] = [];
    const labels: number[] = [];
    const fwd: number[] = [];
    let redundancyR: number | null = null;

    for (let f = 0; f < folds; f += 1) {
      const train = labelled.slice(0, startTest + f * testSize);
      const test = labelled.slice(startTest + f * testSize, startTest + (f + 1) * testSize);
      if (train.length < minTrain || test.length < 10) continue;

      const trainKr = train.map((r) => [r.row.krRet, r.row.krSpread]);
      const trainCbRaw = train.map((r) => r.row.cbRet);
      // residualise the Coinbase return against Kraken on TRAIN rows only
      const meanK = trainKr.reduce((s, r) => s + r[0], 0) / trainKr.length;
      const meanC = trainCbRaw.reduce((s, v) => s + v, 0) / trainCbRaw.length;
      let cov = 0;
      let varK = 0;
      let varC = 0;
      for (let i = 0; i < train.length; i += 1) {
        const dk = trainKr[i][0] - meanK;
        const dc = trainCbRaw[i] - meanC;
        cov += dk * dc;
        varK += dk * dk;
        varC += dc * dc;
      }
      const beta = varK > 0 ? cov / varK : 0;
      redundancyR = varK > 0 && varC > 0 ? Math.round((cov / Math.sqrt(varK * varC)) * 100) / 100 : null;

      const featA = (r: Row): number[] => [r.krRet, r.krSpread];
      const featB = (r: Row): number[] => [r.krRet, r.krSpread, r.cbRet - beta * r.krRet, r.cbDivergence, r.cbSpread];

      const xsA = scale(train.map((r) => featA(r.row)));
      const xsB = scale(train.map((r) => featB(r.row)));
      const wA = fitLogistic(xsA.x, train.map((r) => r.label), 2);
      const wB = fitLogistic(xsB.x, train.map((r) => r.label), 5);

      for (const t of test) {
        const a = predict(wA, scale([featA(t.row)], xsA.scaler).x[0]);
        const b = predict(wB, scale([featB(t.row)], xsB.scaler).x[0]);
        predsA.push(a);
        predsB.push(b);
        predsBase.push(t.row.krRet > 0 ? 0.7 : 0.3); // persistence baseline
        labels.push(t.label);
        fwd.push(t.fwdPct);
      }
    }

    const roundTripPct = cost * 2 * 100; // per-side fraction -> round-trip percent
    const mA = metrics(predsA, labels, fwd, roundTripPct);
    const mB = metrics(predsB, labels, fwd, roundTripPct);
    const mBase = metrics(predsBase, labels, fwd, roundTripPct);
    const status: HorizonContribution['status'] = labels.length >= minTest ? 'OK' : 'INSUFFICIENT_DATA';
    horizons.push({
      horizon: h.label,
      horizonMs: h.ms,
      status,
      trainRows: Math.min(startTest + testSize * (folds - 1), labelled.length),
      testRows: labels.length,
      folds,
      baseline: mBase,
      krakenOnly: mA,
      krakenPlusCoinbase: mB,
      incremental: {
        balancedAccuracyDeltaPct: mA.balancedAccuracyPct !== null && mB.balancedAccuracyPct !== null
          ? Math.round((mB.balancedAccuracyPct - mA.balancedAccuracyPct) * 100) / 100
          : null,
        brierDelta: mA.brier !== null && mB.brier !== null
          ? Math.round((mB.brier - mA.brier) * 10_000) / 10_000
          : null,
        netEdgeDeltaPct: mA.netEdgeAfterCostPct !== null && mB.netEdgeAfterCostPct !== null
          ? Math.round((mB.netEdgeAfterCostPct - mA.netEdgeAfterCostPct) * 10_000) / 10_000
          : null,
      },
      featureRedundancyR: redundancyR,
      note: status === 'OK'
        ? 'walk-forward: expanding train, 3 chronological test folds'
        : `only ${labels.length} labelled test rows (need ${minTest})`,
    });
  }

  const ok = horizons.some((h) => h.status === 'OK');
  return {
    ...base,
    horizons,
    status: ok ? 'OK' : 'INSUFFICIENT_DATA',
    note: ok
      ? 'chronological walk-forward, point-in-time features, flat moves excluded'
      : 'collecting synchronized Kraken+Coinbase samples; no claim made until the evidence floor is met',
  };
}