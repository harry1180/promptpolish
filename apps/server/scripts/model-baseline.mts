/**
 * Priority 3/4 harness: Target A (short-term direction) + Target B (forward
 * bps regression) as LOGISTIC / LINEAR BASELINES over the recorded
 * microstructure snapshots, with point-in-time features, purged chronological
 * walk-forward, an untouched final holdout, calibration bins and Wilson CIs
 * against simple baselines.
 *
 * XGBoost challenger: NOT implemented here (no dependency in repo; spec puts
 * it after baselines). Hawkes: explicitly deferred until baselines exist.
 *
 *   CRYPTO_DB=<path> node scripts/model-baseline.mts
 * Labels use the FIRST snapshot at/after t+h (no look-ahead).
 */
import { DatabaseSync } from 'node:sqlite';
import { wilson } from '../src/crypto/research.ts';

const dbPath = process.env.CRYPTO_DB ?? '/var/lib/docker/volumes/promptpolish_pp-data/_data/crypto.db';
const db = new DatabaseSync(dbPath, { readOnly: true });

const HORIZONS: Array<{ key: string; ms: number }> = [
  { key: '30s', ms: 30_000 }, { key: '60s', ms: 60_000 },
  { key: '5m', ms: 300_000 }, { key: '15m', ms: 900_000 }, { key: '1h', ms: 3_600_000 },
];
const FEATURE_KEYS = ['r1', 'r5', 'r15', 'r30', 'r60', 'spread', 'tob', 'micro', 'rv60', 'cvd', 'rate'] as const;

interface Snap { ts: number; symbol: string; mid: number; f: number[]; s60: number }
const snaps: Snap[] = [];
const raw = db.prepare('SELECT ts, symbol, payload FROM micro_snapshots ORDER BY ts').all() as unknown as Array<{ ts: number; symbol: string; payload: string }>;
for (const r of raw) {
  try {
    const p = JSON.parse(r.payload) as {
      mid: number; spreadBps: number; tobImbalance: number | null; microDevBps: number | null;
      rv60Bps: number | null; retBps: Record<string, number | null>;
      trades60: { cvd: number; ratePerSec: number } | null;
    };
    if (!Number.isFinite(p.mid) || p.mid <= 0) continue;
    snaps.push({
      ts: r.ts, symbol: r.symbol, mid: p.mid,
      f: [
        p.retBps.s1 ?? 0, p.retBps.s5 ?? 0, p.retBps.s15 ?? 0, p.retBps.s30 ?? 0, p.retBps.s60 ?? 0,
        p.spreadBps, p.tobImbalance ?? 0, p.microDevBps ?? 0, p.rv60Bps ?? 0,
        (p.trades60?.cvd ?? 0) > 0 ? Math.min(1, p.trades60!.cvd / 1000) : Math.max(-1, p.trades60!.cvd / 1000),
        Math.min(5, p.trades60?.ratePerSec ?? 0),
      ],
      s60: p.retBps.s60 ?? 0,
    });
  } catch { /* skip malformed */ }
}
console.log(`snapshots: ${snaps.length} rows, ${new Set(snaps.map((s) => s.symbol)).size} symbols, span ${((snaps.at(-1)!.ts - snaps[0].ts) / 60_000).toFixed(0)} min`);

/* per-symbol forward label: first snapshot at/after t+h (point-in-time) */
function buildDataset(hMs: number): { X: number[][]; y: number[]; pers: number[]; ts: number[]; bps: number[] } | null {
  const bySym = new Map<string, Snap[]>();
  for (const s of snaps) { const a = bySym.get(s.symbol) ?? []; a.push(s); bySym.set(s.symbol, a); }
  const X: number[][] = [], y: number[] = [], pers: number[] = [], ts: number[] = [], bps: number[] = [];
  for (const arr of bySym.values()) {
    let j = 0;
    for (let i = 0; i < arr.length; i++) {
      while (j < arr.length && arr[j].ts < arr[i].ts + hMs) j++;
      if (j >= arr.length) continue; // label not yet observed -> excluded (no look-ahead)
      const ret = (arr[j].mid - arr[i].mid) / arr[i].mid;
      if (Math.abs(ret) < 1e-12) continue; // flat excluded from direction labels
      X.push(arr[i].f);
      y.push(ret > 0 ? 1 : 0);
      pers.push(arr[i - 1] ? (arr[i].mid - arr[i - 1].mid > 0 ? 1 : 0) : 0);
      ts.push(arr[i].ts);
      bps.push(ret * 10_000);
    }
  }
  if (X.length < 500) return null;
  // chronological order across the whole panel
  const order = ts.map((t, i) => i).sort((a, b) => ts[a] - ts[b]);
  return {
    X: order.map((i) => X[i]), y: order.map((i) => y[i]),
    pers: order.map((i) => pers[i]), ts: order.map((i) => ts[i]),
    bps: order.map((i) => bps[i]),
  };
}

function splitPurged(n: number, hMs: number, ts: number[]) {
  const gap = hMs; // purge: label horizon straddling a boundary is dropped
  const t1 = Math.floor(n * 0.6), t2 = Math.floor(n * 0.8);
  const b1 = ts[Math.min(t1, n - 1)], b2 = ts[Math.min(t2, n - 1)];
  const idx = (lo: number, hi: number, loTs: number, hiTs: number) =>
    [...Array(n).keys()].filter((i) => i >= lo && i < hi && ts[i] >= loTs && ts[i] < hiTs);
  return {
    train: idx(0, t1, -Infinity, b1),
    val: idx(t1, t2, b1 + gap, b2),
    test: idx(t2, n, b2 + gap, Infinity), // untouched holdout
  };
}

function standardize(X: number[][], idx: number[]): { mu: number[]; sd: number[] } {
  const d = X[0].length, mu = new Array(d).fill(0), sd = new Array(d).fill(0);
  for (const i of idx) for (let k = 0; k < d; k++) mu[k] += X[i][k];
  for (let k = 0; k < d; k++) mu[k] /= idx.length;
  for (const i of idx) for (let k = 0; k < d; k++) sd[k] += (X[i][k] - mu[k]) ** 2;
  for (let k = 0; k < d; k++) sd[k] = Math.sqrt(sd[k] / idx.length) || 1;
  return { mu, sd };
}
const z = (x: number, mu: number, sd: number) => (x - mu) / sd;
const sigmoid = (v: number) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, v))));

function trainLogistic(X: number[][], y: number[], idx: number[], iters = 400, lr = 0.05, l2 = 1e-4): { w: number[]; mu: number[]; sd: number[] } {
  const { mu, sd } = standardize(X, idx);
  const d = X[0].length, w = new Array(d + 1).fill(0);
  for (let it = 0; it < iters; it++) {
    const g = new Array(d + 1).fill(0);
    for (const i of idx) {
      const xs = X[i].map((v, k) => z(v, mu[k], sd[k]));
      const p = sigmoid(w[d] + xs.reduce((s, v, k) => s + v * w[k], 0));
      const e = p - y[i];
      for (let k = 0; k < d; k++) g[k] += e * xs[k];
      g[d] += e;
    }
    for (let k = 0; k < d; k++) w[k] -= lr * (g[k] / idx.length + l2 * w[k]);
    w[d] -= lr * (g[d] / idx.length);
  }
  return { w, mu, sd };
}

function trainLinear(X: number[][], y: number[], idx: number[], iters = 400, lr = 0.05): { w: number[]; mu: number[]; sd: number[] } {
  const { mu, sd } = standardize(X, idx);
  const d = X[0].length, w = new Array(d + 1).fill(0);
  for (let it = 0; it < iters; it++) {
    const g = new Array(d + 1).fill(0);
    for (const i of idx) {
      const xs = X[i].map((v, k) => z(v, mu[k], sd[k]));
      const p = w[d] + xs.reduce((s, v, k) => s + v * w[k], 0);
      const e = p - y[i];
      for (let k = 0; k < d; k++) g[k] += e * xs[k];
      g[d] += e;
    }
    for (let k = 0; k <= d; k++) w[k] -= lr * (g[k] / idx.length);
  }
  return { w, mu, sd };
}

const predict = (m: { w: number[]; mu: number[]; sd: number[] }, x: number[]) =>
  sigmoid(m.w[m.w.length - 1] + x.reduce((s, v, k) => s + z(v, m.mu[k], m.sd[k]) * m.w[k], 0));

function calibration(ps: number[], ys: number[], bins = 5): Array<{ lo: number; n: number; pred: number; emp: number }> {
  const pairs = ps.map((p, i) => ({ p, y: ys[i] })).sort((a, b) => a.p - b.p);
  const out = [];
  for (let b = 0; b < bins; b++) {
    const slice = pairs.slice(Math.floor((pairs.length * b) / bins), Math.floor((pairs.length * (b + 1)) / bins));
    if (!slice.length) continue;
    out.push({
      lo: +slice[0].p.toFixed(3), n: slice.length,
      pred: +(slice.reduce((s, x) => s + x.p, 0) / slice.length).toFixed(3),
      emp: +(slice.reduce((s, x) => s + x.y, 0) / slice.length).toFixed(3),
    });
  }
  return out;
}

console.log('\nhorizon |   n(train/val/test) | model acc [95% CI] | alwaysUp | alwaysDown | persistence | B: R2 | B: MAE(bps)');
const results: unknown[] = [];
for (const h of HORIZONS) {
  const ds = buildDataset(h.ms);
  if (!ds) { console.log(`${h.key.padEnd(7)} | INSUFFICIENT (n<500 for an in-window forward label)`); results.push({ horizon: h.key, status: 'insufficient' }); continue; }
  const sp = splitPurged(ds.X.length, h.ms, ds.ts);
  if (sp.train.length < 300 || sp.test.length < 100) {
    console.log(`${h.key.padEnd(7)} | INSUFFICIENT after purge (train ${sp.train.length}, test ${sp.test.length})`);
    results.push({ horizon: h.key, status: 'insufficient', n: ds.X.length });
    continue;
  }
  const model = trainLogistic(ds.X, ds.y, sp.train);
  const testY = sp.test.map((i) => ds.y[i]);
  const ps = sp.test.map((i) => predict(model, ds.X[i]));
  const preds = ps.map((p) => (p >= 0.5 ? 1 : 0));
  const correct = preds.filter((p, i) => p === testY[i]).length;
  const ci = wilson(correct, testY.length);
  const upShare = testY.reduce((s, v) => s + v, 0) / testY.length;
  const persAcc = sp.test.filter((i, k) => ds.pers[i] === ds.y[i]).length / sp.test.length;
  // Target B: forward-bps regression, same split, same features
  const lin = trainLinear(ds.X, ds.bps, sp.train);
  const bTrue = sp.test.map((i) => ds.bps[i]);
  const bPred = sp.test.map((i) => lin.w[lin.w.length - 1] + ds.X[i].reduce((s, v, k) => s + z(v, lin.mu[k], lin.sd[k]) * lin.w[k], 0));
  const bMean = bTrue.reduce((s, v) => s + v, 0) / bTrue.length;
  const ssTot = bTrue.reduce((s, v) => s + (v - bMean) ** 2, 0);
  const ssRes = bTrue.reduce((s, v, i) => s + (v - bPred[i]) ** 2, 0);
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : null;
  const mae = bTrue.reduce((s, v, i) => s + Math.abs(v - bPred[i]), 0) / bTrue.length;
  results.push({ horizon: h.key, n: ds.X.length, split: [sp.train.length, sp.val.length, sp.test.length], acc: ci, upShare, persAcc, b: { r2, maeBps: mae }, calib: calibration(ps, testY) });
  console.log(
    `${h.key.padEnd(7)} | ${String(sp.train.length).padStart(6)}/${String(sp.val.length).padStart(5)}/${String(sp.test.length).padStart(5)} | ` +
    `${((ci.pct ?? 0) * 100).toFixed(1)}% [${((ci.lo ?? 0) * 100).toFixed(1)}, ${((ci.hi ?? 0) * 100).toFixed(1)}] | ` +
    `${(upShare * 100).toFixed(1)}% | ${((1 - upShare) * 100).toFixed(1)}% | ${(persAcc * 100).toFixed(1)}% | ` +
    `${r2 === null ? 'n/a' : r2.toFixed(3)} | ${mae.toFixed(2)}`,
  );
}

const { writeFileSync } = await import('node:fs');
const out = `${process.env.TMPDIR ?? '/tmp'}/model-baseline.json`;
writeFileSync(out, JSON.stringify({ generatedAt: Date.now(), features: FEATURE_KEYS, results }, null, 1));
console.log(`\nreport -> ${out}`);
db.close();
