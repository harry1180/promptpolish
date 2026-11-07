/**
 * Phase A + C + D study: fee scenarios and four exit-geometry families over
 * the PRODUCTION decision pipeline, with a chronological walk-forward split
 * and a final untouched holdout segment.
 *
 *   CRYPTO_DB=<path> node scripts/alpha-research.mts
 *
 * Design (research only — nothing here touches production config):
 *  - Signal layer: identical to production — shortTermScore -> cryptoParts ->
 *    fuse with the shipped CRYPTO_FUSION_WEIGHTS {technical .84, regime .16},
 *    confidence floor 0.50, per-day dedupe, sane R:R gate, evaluateEntry
 *    sizing (risk 0.75%, max position 10% — risk controls NEVER weakened).
 *  - Exit geometries (stop/target only; sizing still risk-based off the stop):
 *      A     production: stop = strategy invalidation, target = price+3*ATR
 *      B     vol-adjusted stops: stop = price - k*ATR14 (k in .75/1.0/1.5),
 *            target = price + 3*ATR (k=1.5 pairs with 4*ATR)
 *      C     horizon-matched: sigma_H = ATR/price*sqrt(expectedHoldSessions);
 *            stop = 1.0*sigma_H below, target = 2.0*sigma_H above
 *      D     production geometry + EV gate: accept only when
 *            pT*rr - pS - costs/risk > 0, with pT/pS estimated by conservative
 *            first-passage over TRAIN-window episodes only (purged: episodes
 *            must end before the train segment closes; never refit later)
 *  - Fees: 0.16%/side (configured), 0.40%/side (Kraken tier-1 maker),
 *    0.80%/side (Kraken tier-1 taker). One stress run: tier-1 taker with
 *    3x slippage.
 *  - Walk-forward: dates split 60/20/20 chronological -> train / validation /
 *    HOLDOUT. The holdout is reported but never used to choose anything.
 *  - Conservative fills: buy the liquidity-scaled ask, same as production
 *    simulation; daily-bar exits exactly like settleEndOfDay (gaps respected,
 *    stop priority over target on a both-touch bar).
 *
 * Paper scheduler delay (5-15s) is NOT modelled here — that delay exists
 * only in the paper scheduler, not in the strategy's daily-bar decision
 * cadence. Real exchange execution latency is unmeasured (paper only).
 */
import { DatabaseSync } from 'node:sqlite';
import { checkExit, detectRegime, evaluateEntry, fuse, shortTermScore } from '@promptslim/tucore';
import type { Candle, Regime, ScoreParts } from '@promptslim/tucore';
import { evGate, firstPassage, hitProbabilities } from '../src/crypto/research.ts';

const START_CAPITAL = 100_000;
const RISK_PER_TRADE = 0.0075;
const MAX_POSITION_PCT = 0.1;
const MIN_RR = 1.5;
const MIN_CONF = 0.5; // production CRYPTO_MIN_SIGNAL_CONFIDENCE
const WEIGHTS: Partial<ScoreParts> = { technical: 0.84, regime: 0.16 }; // production
const STRATEGY = 'crypto_momentum_v1';
const HORIZON = 'SHORT' as const;
const SLIP_BPS_BASE = 6; // production fill model reference (liq ~0.5)

const REGIME_SCORE: Record<string, number> = {
  BULL_TREND: 0.5, RISK_ON: 0.5, MOMENTUM: 0.5,
  LOW_VOLATILITY: 0.25, RECOVERY: 0.25, MEAN_REVERSION: 0,
  BEAR_TREND: -0.5, RISK_OFF: -0.5, LIQUIDITY_STRESS: -0.5, HIGH_VOLATILITY: -0.5,
  UNCERTAIN: 0,
};

const dbPath = process.env.CRYPTO_DB ?? '/var/lib/docker/volumes/promptpolish_pp-data/_data/crypto.db';
const db = new DatabaseSync(dbPath, { readOnly: true });

interface BarRow { ticker: string; date: string; open: number; high: number; low: number; close: number; volume: number }
const rows = db.prepare('SELECT ticker, date, open, high, low, close, volume FROM market_bars ORDER BY ticker, date').all() as unknown as BarRow[];
const universe = (db.prepare('SELECT symbol FROM crypto_universe WHERE active = 1').all() as unknown as Array<{ symbol: string }>).map((r) => r.symbol);

const barsByTicker = new Map<string, Candle[]>();
for (const r of rows) {
  const c: Candle = { date: r.date, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume };
  const arr = barsByTicker.get(r.ticker);
  if (arr) arr.push(c); else barsByTicker.set(r.ticker, [c]);
}
const benchmark = barsByTicker.get('BTC') ?? [];
const btcPos = new Map<string, number>();
benchmark.forEach((c, i) => btcPos.set(c.date, i));
const tickers = universe.filter((t) => t !== 'BTC' && (barsByTicker.get(t)?.length ?? 0) > 0);

function liquidityOf(bars: Candle[]): number {
  const recent = bars.slice(-30);
  if (recent.length < 5) return 0.3;
  const avgVol = recent.reduce((s, b) => s + b.volume, 0) / recent.length;
  const avgPrice = recent.reduce((s, b) => s + b.close, 0) / recent.length;
  return Math.max(0.05, Math.min(1, Math.log10(Math.max(1, avgVol * avgPrice)) / 3));
}
function volatilityOf(bars: Candle[]): number {
  const rets: number[] = [];
  for (let i = 1; i < bars.length; i++) rets.push(Math.log(bars[i].close / bars[i - 1].close));
  if (rets.length < 2) return 0.03;
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length;
  return Math.sqrt(variance);
}
function fillPrice(side: 'BUY' | 'SELL', price: number, liq: number, slipMult: number): number {
  const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
  const bps = clamp((2 + 18 * (1 - clamp(liq, 0.05, 1))) * slipMult, 2, 180);
  return side === 'BUY' ? price * (1 + bps / 10_000) : price * (1 - bps / 10_000);
}

/* ---------------- strategy layer (computed once) ---------------- */

interface StratPoint {
  ticker: string; date: string; i: number; price: number;
  st: ReturnType<typeof shortTermScore>;
  regime: Regime; parts: ScoreParts; liq: number;
}

const stratByDate = new Map<string, StratPoint[]>();
const t0 = Date.now();
let scanned = 0;
for (const t of tickers) {
  const bars = barsByTicker.get(t)!;
  for (let i = 119; i < bars.length; i++) {
    const last = bars[i];
    const bp = btcPos.get(last.date);
    if (bp === undefined || bp < 119) continue;
    scanned++;
    const candles = bars.slice(0, i + 1);
    const bench = benchmark.slice(0, bp + 1);
    const regime = detectRegime(bench).regime;
    const quote = { symbol: t, price: last.close, prevClose: bars[i - 1].close, ts: Date.parse(`${last.date}T00:00:00Z`) };
    const st = shortTermScore({ ticker: t, company: t, candles, benchmarkCandles: bench, quote, regime, events: [], sessionDate: last.date });
    if (st.action === 'INSUFFICIENT_DATA') continue;
    const parts: ScoreParts = { technical: st.score, fundamental: 0, event: 0, sentiment: 0, macro: 0, regime: REGIME_SCORE[regime] ?? 0 };
    const point: StratPoint = { ticker: t, date: last.date, i, price: last.close, st, regime, parts, liq: liquidityOf(candles) };
    const list = stratByDate.get(last.date);
    if (list) list.push(point); else stratByDate.set(last.date, [point]);
  }
}
const dates = [...stratByDate.keys()].sort();
console.log(`strategy layer: ${scanned} coin-days, ${dates.length} dates (${dates[0]} .. ${dates[dates.length - 1]}), ${Date.now() - t0}ms`);

/* ---------------- walk-forward split ---------------- */

const trainEndIdx = Math.floor(dates.length * 0.6);
const valEndIdx = Math.floor(dates.length * 0.8);
const SEGMENTS = {
  train: [0, trainEndIdx],
  val: [trainEndIdx, valEndIdx],
  holdout: [valEndIdx, dates.length],
} as const;
const segmentOf = (date: string): 'train' | 'val' | 'holdout' => {
  const i = dates.indexOf(date);
  return i < trainEndIdx ? 'train' : i < valEndIdx ? 'val' : 'holdout';
};
console.log(`walk-forward: train ${dates[0]}..${dates[trainEndIdx - 1]} | val ..${dates[valEndIdx - 1]} | HOLDOUT ${dates[valEndIdx]}..${dates[dates.length - 1]} (${dates.length - valEndIdx} days untouched by selection)`);

/* ---------------- Phase D probe: train-window hit probabilities ------- */

interface Episode { stopDist: number; targetDist: number; atr: number; bars: Candle[]; date: string }

/** Conservative first-passage episodes over TRAIN bars for grid estimation. */
function trainEpisodes(): Episode[] {
  const eps: Episode[] = [];
  const trainDates = new Set(dates.slice(0, trainEndIdx));
  for (const t of tickers) {
    const bars = barsByTicker.get(t)!;
    for (let i = 119; i < bars.length - 2; i++) {
      const date = bars[i].date;
      if (!trainDates.has(date)) continue;
      // purged: episode window must end before train closes
      if (i + 20 >= bars.length) continue;
      const win = bars.slice(0, i + 1);
      const atr = atr14(win);
      if (!(atr > 0)) continue;
      eps.push({ stopDist: atr, targetDist: 3 * atr, atr, bars: bars.slice(i + 1), date });
    }
  }
  return eps;
}

function atr14(bars: Candle[]): number {
  if (bars.length < 15) return 0;
  const trs: number[] = [];
  for (let i = bars.length - 14; i < bars.length; i++) {
    const h = bars[i].high, l = bars[i].low, pc = bars[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  return trs.reduce((s, x) => s + x, 0) / 14;
}

/** pT/pS for a (kStop, kTarget) pair in ATR units, estimated on train only. */
function estimateProbs(kStop: number, kTarget: number): { pT: number; pS: number; n: number } {
  const eps = trainEpisodes();
  const outcomes = eps.map((e) => {
    const entry = e.bars[0]?.open ?? 0; // episode starts next bar after signal bar
    if (!(entry > 0)) return 'CENSORED' as const;
    const stop = entry - kStop * e.atr;
    const target = entry + kTarget * e.atr;
    return firstPassage(e.bars, stop, target, 20);
  });
  const p = hitProbabilities(outcomes);
  return { pT: p.pTarget, pS: p.pStop, n: p.n };
}

/* ---------------- variants ---------------- */

type GeoKey = 'A' | 'B075' | 'B10' | 'B15' | 'C' | 'D';

interface Geometry { key: GeoKey; label: string }

const GEOMETRIES: Geometry[] = [
  { key: 'A', label: 'prod: stop=invalidation, target=price+3ATR' },
  { key: 'B075', label: 'vol: stop=0.75ATR, target=3ATR' },
  { key: 'B10', label: 'vol: stop=1.0ATR, target=3ATR' },
  { key: 'B15', label: 'vol: stop=1.5ATR, target=4ATR' },
  { key: 'C', label: 'horizon: stop=1.0*sigma_H, target=2.0*sigma_H' },
  { key: 'D', label: 'prod + EV gate (train-estimated pT/pS)' },
];

const FEE_SCENARIOS: Array<{ key: string; feePct: number; slipMult: number; label: string }> = [
  { key: 'cfg16', feePct: 0.0016, slipMult: 1, label: 'configured 0.16%/side + model slip' },
  { key: 't40', feePct: 0.004, slipMult: 1, label: 'Kraken tier-1 maker 0.40%/side' },
  { key: 't80', feePct: 0.008, slipMult: 1, label: 'Kraken tier-1 taker 0.80%/side' },
  { key: 't80s3', feePct: 0.008, slipMult: 3, label: 'STRESS: tier-1 taker + 3x slippage' },
];

// pre-estimate D's probability grid on TRAIN episodes (purged, never refit)
const t1 = Date.now();
const D_PROBS: Array<{ kS: number; kT: number; pT: number; pS: number; n: number }> = [];
for (const kS of [0.1, 0.25, 0.5, 0.75, 1.0, 1.5, 2.0]) {
  for (const kT of [2, 3, 4]) {
    const p = estimateProbs(kS, kT);
    D_PROBS.push({ kS, kT, ...p });
  }
}
console.log(`D probability grid (train-only, purged): ${D_PROBS.length} cells, ${Date.now() - t1}ms`);
console.log('  sample cells: ' + D_PROBS.filter((c) => c.kT === 3).map((c) => `kS${c.kS}:pT=${c.pT.toFixed(2)}/pS=${c.pS.toFixed(2)}(n=${c.n})`).join(' '));

function nearestProb(kS: number, kT: number): { pT: number; pS: number } {
  let best = D_PROBS[0], bestD = Infinity;
  for (const c of D_PROBS) {
    const d = Math.abs(c.kS - kS) / 0.5 + Math.abs(c.kT - kT);
    if (d < bestD) { bestD = d; best = c; }
  }
  return { pT: best.pT, pS: best.pS };
}

/* ---------------- runner ---------------- */

interface OpenPos {
  ticker: string; idx: number; entryDate: string; entryPrice: number;
  qty: number; target: number; stop: number; maxHold: number;
  sessionsHeld: number; entryFee: number;
}
interface ClosedTrade {
  ticker: string; entryDate: string; exitDate: string; entryPrice: number;
  exitPrice: number; qty: number; netPnl: number; reason: string;
  holdDays: number; fee: number;
}

interface SegStat { n: number; wins: number; net: number; gross: number; fees: number }

function emptySeg(): SegStat { return { n: 0, wins: 0, net: 0, gross: 0, fees: 0 }; }

function runVariant(geo: Geometry, fee: { feePct: number; slipMult: number }): {
  full: SegStat; train: SegStat; val: SegStat; holdout: SegStat;
  orders: number; openLeft: number; maxDD: number; evRejected: number; finalEquity: number;
  avgHoldDays: number; exitReasons: Record<string, number>;
} {
  const seen = new Set<string>();
  const open = new Map<string, OpenPos>();
  const trades: ClosedTrade[] = [];
  let cash = START_CAPITAL, equity = START_CAPITAL, peak = START_CAPITAL, maxDD = 0;
  let orders = 0, evRejected = 0;
  const exitReasons: Record<string, number> = {};

  for (const date of dates) {
    const points = stratByDate.get(date)!;
    const decs = points.map((p) => ({ p, d: decide(p) }));

    /* exits first (production order) */
    for (const pos of [...open.values()]) {
      const idx = idxOf(pos.ticker, date);
      if (idx === undefined || idx <= pos.idx) continue;
      const bar = barsByTicker.get(pos.ticker)![idx];
      pos.sessionsHeld++;
      const sellToday = decs.some((x) => x.p.ticker === pos.ticker && x.d.action === 'SELL');
      const reason = checkExit(
        {
          side: 'LONG', entryPrice: pos.entryPrice, qty: pos.qty,
          target: pos.target, stop: pos.stop, trailingStop: null,
          maxHoldSessions: pos.maxHold, sessionsHeld: pos.sessionsHeld,
          thesisInvalidated: false, sellSignal: sellToday, regimeChanged: false,
        },
        { open: bar.open, high: bar.high, low: bar.low, close: bar.close, date: bar.date },
      );
      pos.idx = idx;
      if (!reason) continue;
      const exitPrice = reason === 'STOP_REACHED' ? Math.min(pos.stop, Math.max(bar.open, pos.stop))
        : reason === 'TARGET_REACHED' ? Math.max(pos.target, Math.min(bar.open, pos.target))
        : bar.close;
      const exitFee = exitPrice * pos.qty * fee.feePct;
      cash += pos.qty * exitPrice - exitFee;
      trades.push({
        ticker: pos.ticker, entryDate: pos.entryDate, exitDate: date,
        entryPrice: pos.entryPrice, exitPrice, qty: pos.qty,
        netPnl: (exitPrice - pos.entryPrice) * pos.qty - pos.entryFee - exitFee,
        reason, holdDays: Math.round((Date.parse(date) - Date.parse(pos.entryDate)) / 86_400_000),
        fee: pos.entryFee + exitFee,
      });
      exitReasons[reason] = (exitReasons[reason] ?? 0) + 1;
      open.delete(pos.ticker);
    }

    /* entries */
    for (const { p, d } of decs) {
      if (d.action !== 'BUY') continue;
      const key = `${p.ticker}|BUY|${date}`;
      if (seen.has(key)) continue;
      if (d.confidence < MIN_CONF) continue;

      const geom = geometryFor(p, geo);
      if (!geom) continue;
      const stopDist = geom.stopDist;
      const rr = geom.targetDist / Math.max(1e-9, stopDist);
      const sane = stopDist >= p.price * 0.005 && rr >= MIN_RR && rr <= 20 && geom.target > p.price;
      if (!sane) continue;
      seen.add(key);
      if (open.has(p.ticker)) continue;

      // EV gate (config D only) — probabilities from TRAIN episodes only
      if (geo.key === 'D') {
        const kS = stopDist / Math.max(1e-9, p.st.factors.atr ?? stopDist);
        const kT = geom.targetDist / Math.max(1e-9, p.st.factors.atr ?? stopDist);
        const pr = nearestProb(kS, kT);
        const costOverRisk = (2 * (fee.feePct + (SLIP_BPS_BASE * fee.slipMult) / 10_000) * p.price) / stopDist;
        const ev = evGate({ pTarget: pr.pT, pStop: pr.pS, rr, costOverRisk });
        if (!(ev > 0)) { evRejected++; continue; }
      }

      const drawdownPct = Math.max(0, (peak - equity) / Math.max(1, peak)) * 100;
      const decision = evaluateEntry(
        { equity, cash, openPositions: [], currentDrawdownPct: drawdownPct },
        { ticker: p.ticker, sector: 'Crypto', price: p.price, entryLow: p.st.entryLow, invalidation: geom.stop, target: geom.target, confidence: d.confidence, horizon: HORIZON },
        { riskPerTradePct: RISK_PER_TRADE, maxPositionPct: MAX_POSITION_PCT, maxCorrelatedPct: 1, maxSectorPct: 1, minRiskReward: MIN_RR, maxEarningsDays: 3 },
        { liquidityScore: p.liq, volatilityPct: volatilityOf(barsByTicker.get(p.ticker)!.slice(0, p.i + 1)), regime: p.regime, dataQuality: { stale: false, disagreement: false, missing: false }, killSwitchActive: false, earningsWithinDays: 9999 },
      );
      if (!decision.approved || decision.sizeShares <= 0) continue;

      const entryPrice = fillPrice('BUY', p.price, p.liq, fee.slipMult);
      const qty = decision.sizeShares;
      const notional = entryPrice * qty;
      const entryFee = notional * fee.feePct;
      if (notional + entryFee > cash) continue;
      cash -= notional + entryFee;
      orders++;
      open.set(p.ticker, {
        ticker: p.ticker, idx: p.i, entryDate: date, entryPrice, qty,
        target: geom.target, stop: geom.stop, maxHold: p.st.maxHoldSessions,
        sessionsHeld: 0, entryFee,
      });
    }

    equity = cash;
    for (const pos of open.values()) {
      const idx = idxOf(pos.ticker, date);
      const bars = barsByTicker.get(pos.ticker)!;
      equity += pos.qty * (idx !== undefined ? bars[idx].close : bars[bars.length - 1].close);
    }
    if (equity > peak) peak = equity;
    maxDD = Math.max(maxDD, ((peak - equity) / peak) * 100);
  }

  const seg = { train: emptySeg(), val: emptySeg(), holdout: emptySeg() };
  const full = emptySeg();
  for (const t of trades) {
    const s = seg[segmentOf(t.entryDate)];
    s.n++; s.net += t.netPnl; s.gross += t.netPnl + t.fee; s.fees += t.fee;
    if (t.netPnl > 0) s.wins++;
    full.n++; full.net += t.netPnl; full.gross += t.netPnl + t.fee; full.fees += t.fee;
    if (t.netPnl > 0) full.wins++;
  }
  return {
    full, train: seg.train, val: seg.val, holdout: seg.holdout,
    orders, openLeft: open.size, maxDD, evRejected, finalEquity: equity,
    avgHoldDays: trades.length ? trades.reduce((s, t) => s + t.holdDays, 0) / trades.length : 0,
    exitReasons,
  };
}

interface GeometrySpec { stop: number; target: number; stopDist: number; targetDist: number }

function geometryFor(p: StratPoint, geo: Geometry): GeometrySpec | null {
  const atr = Number(p.st.factors.atr ?? 0);
  const price = p.price;
  switch (geo.key) {
    case 'A':
    case 'D':
      return { stop: p.st.invalidation, target: price + 3 * (atr || 0), stopDist: price - p.st.invalidation, targetDist: 3 * (atr || 0) };
    case 'B075':
      return mk(price, price - 0.75 * atr, price + 3 * atr);
    case 'B10':
      return mk(price, price - 1.0 * atr, price + 3 * atr);
    case 'B15':
      return mk(price, price - 1.5 * atr, price + 4 * atr);
    case 'C': {
      const H = Math.max(1, Number(p.st.expectedHoldSessions ?? 5));
      const sigmaH = (atr / price) * Math.sqrt(H);
      return mk(price, price * (1 - 1.0 * sigmaH), price * (1 + 2.0 * sigmaH));
    }
  }
  function mk(entry: number, stop: number, target: number): GeometrySpec {
    return { stop, target, stopDist: entry - stop, targetDist: target - entry };
  }
}

function decide(p: StratPoint): { action: 'BUY' | 'SELL' | null; confidence: number } {
  const base = fuse({
    parts: p.parts, horizon: HORIZON, strategy: STRATEGY, weights: WEIGHTS,
    confidenceHint: p.st.confidence, evidence: p.st.evidence, contradictions: p.st.contradictions,
  });
  return {
    action: base.action === 'BUY' || base.action === 'SELL' ? base.action : null,
    confidence: base.confidence,
  };
}

const idxCache = new Map<string, Map<string, number>>();
for (const t of tickers) {
  const m = new Map<string, number>();
  barsByTicker.get(t)!.forEach((c, i) => m.set(c.date, i));
  idxCache.set(t, m);
}
const idxOf = (t: string, d: string) => idxCache.get(t)?.get(d);

/* ---------------- run the grid ---------------- */

const pct = (v: number) => (v * 100).toFixed(1) + '%';
const win = (s: SegStat) => (s.n ? ((s.wins / s.n) * 100).toFixed(0) : '-');

console.log('\ngeo   fee      | full: n  win%    net$    maxDD% | train n/net | val n/net | HOLDOUT n/win%  net$  (entry-date cohort)');
const results: Array<{ geo: string; fee: string; r: ReturnType<typeof runVariant> }> = [];
for (const geo of GEOMETRIES) {
  for (const fee of FEE_SCENARIOS) {
    if (fee.key === 't80s3' && geo.key !== 'A') continue; // stress only on production geometry
    const r = runVariant(geo, fee);
    results.push({ geo: geo.key, fee: fee.key, r });
    console.log(
      `${geo.key.padEnd(5)} ${fee.key.padEnd(8)} | ${String(r.full.n).padStart(4)} ${win(r.full).padStart(5)} ${r.full.net.toFixed(0).padStart(8)} ${r.maxDD.toFixed(1).padStart(7)} | ` +
      `${String(r.train.n).padStart(5)}/${r.train.net.toFixed(0).padStart(7)} | ${String(r.val.n).padStart(4)}/${r.val.net.toFixed(0).padStart(7)} | ` +
      `${String(r.holdout.n).padStart(4)} ${win(r.holdout).padStart(5)} ${r.holdout.net.toFixed(0).padStart(8)}` +
      `${r.evRejected ? ` (evRej ${r.evRejected})` : ''}`,
    );
  }
}

console.log('\nfee scenarios (same production geometry A):');
for (const fee of FEE_SCENARIOS) {
  const row = results.find((x) => x.geo === 'A' && x.fee === fee.key)!;
  console.log(`  ${fee.key.padEnd(8)} ${fee.label.padEnd(40)} net ${row.r.full.net.toFixed(0).padStart(7)} | holdout ${row.r.holdout.net.toFixed(0).padStart(7)} | fees ${row.r.full.fees.toFixed(0)}`);
}

const { writeFileSync } = await import('node:fs');
const outPath = `${process.env.TMPDIR ?? '/tmp'}/alpha-research.json`;
writeFileSync(outPath, JSON.stringify({
  window: [dates[0], dates[dates.length - 1]],
  segments: { trainEnd: dates[trainEndIdx - 1], valEnd: dates[valEndIdx - 1], holdout: [dates[valEndIdx], dates[dates.length - 1]] },
  dProbs: D_PROBS,
  results: results.map((x) => ({ geo: x.geo, fee: x.fee, ...x.r })),
}, null, 1));
console.log(`\nfull report -> ${outPath}`);
db.close();
