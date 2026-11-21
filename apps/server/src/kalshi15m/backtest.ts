/**
 * Event-driven backtester over the RECORDED tape (Phase 8).
 *
 * Replays `k15m_book_samples` chronologically inside each window and feeds the
 * SAME strategy functions the shadow engine calls live — one implementation,
 * so a backtest cannot quietly disagree with production.
 *
 * Look-ahead discipline:
 *  - inputs come only from rows with ts <= t (the lag fields are looked up
 *    backwards through already-loaded history);
 *  - exits use rows at t+hold (later data, but only for P&L — never for a
 *    decision), or the official settlement when the window has a result;
 *  - a strategy that needs a value the tape does not have gets null and skips,
 *    exactly as it would live.
 *
 * Fill honesty:
 *  - taker entries fill at the ASK (the price the cost model already assumed),
 *    taker exits at the BID — never midpoints;
 *  - maker entries fill at the BID and are marked `fillAssumed`: probability of
 *    fill is NOT modelled (Strategy F says so in its own reasons);
 *  - windows without an official result cannot be scored hold-to-settlement
 *    and are reported as `unscorable`, never counted as wins or losses.
 */
import type { DatabaseSync } from 'node:sqlite';
import {
  evaluateLeadLag, evaluateMaker, evaluateMomentum, evaluateMicro, evaluateLateFav,
  evaluatePanicFade, lateFavConfigFromEnv, leadLagConfigFromEnv, makerConfigFromEnv,
  microConfigFromEnv, momentumConfigFromEnv, panicConfigFromEnv,
  type StrategyVerdict,
} from './strategies.ts';
import { takerFee, KXBTC15M_FEES } from './fee.ts';

export type SplitName = 'TRAIN' | 'VALIDATION' | 'TEST';

export interface BacktestConfig {
  /** strategies to replay; empty = all six */
  strategies: string[];
  /** round-trip exit horizon (seconds) for EXIT_AT_HOLD scoring */
  holdSec: number;
  /** how often a strategy may fire inside a window (ms), matching live */
  evalMs: number;
  /** chronological split: train fraction, then validation, remainder test */
  trainShare: number;
  validationShare: number;
  /** per-window cap on replayed samples (safety, not sampling) */
  maxSamplesPerWindow: number;
}

export function backtestConfigFromEnv(env: Record<string, string | undefined> = process.env): BacktestConfig {
  const num = (v: string | undefined, d: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  return {
    strategies: (env.KALSHI15M_BT_STRATEGIES ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    holdSec: num(env.KALSHI15M_BT_HOLD_SEC, 10),
    evalMs: num(env.KALSHI15M_BT_EVAL_MS, 1_000),
    trainShare: num(env.KALSHI15M_BT_TRAIN_SHARE, 0.6),
    validationShare: num(env.KALSHI15M_BT_VALIDATION_SHARE, 0.2),
    maxSamplesPerWindow: num(env.KALSHI15M_BT_MAX_SAMPLES, 4_000),
  };
}

export const ALL_STRATEGIES = ['A_LEADLAG', 'B_MICRO', 'C_PANICFADE', 'D_MOMENTUM', 'E_LATEFAV_HOLD', 'F_MAKER'] as const;

interface SampleRow {
  ts: number;
  market_ticker: string;
  event_ticker: string | null;
  phase: string;
  ms_to_close: number;
  yes_bid: number | null;
  yes_ask: number | null;
  micro: number | null;
  imbalance: number | null;
  ofi: number | null;
  cancel_ratio: number | null;
  trades_1s: number | null;
  taker_bias_60s: number | null;
  needs_snapshot: number;
  spot_mid: number | null;
  fair_spot: number | null;
  fair_sigma: number | null;
  fair_yes: number | null;
  implied_mid: number | null;
}

interface WindowRow {
  event_ticker: string;
  open_ts: number;
  close_ts: number;
  strike: number | null;
  settled_result: string | null;
  settle_value: number | null;
}

export interface BtTrade {
  strategy: string;
  split: SplitName;
  eventTicker: string;
  entryTs: number;
  exitTs: number | null;
  side: 'YES' | 'NO';
  entryPrice: number;
  exitPrice: number | null;
  holdSec: number | null;
  feesPp: number;
  /** net cents per contract AFTER fees; null = cannot be scored */
  pnlPp: number | null;
  scoreMode: 'EXIT_AT_HOLD' | 'SETTLEMENT';
  fillAssumed: boolean;
  netPpPredicted: number | null;
}

export interface MetricSet {
  trades: number;
  scorable: number;
  unscorable: number;
  wins: number;
  winRatePct: number | null;
  netPp: number | null;
  netPerContractPp: number | null;
  profitFactor: number | null;
  expectancyPp: number | null;
  sharpePerTrade: number | null;
  maxDrawdownPp: number | null;
  tailP5Pp: number | null;
  feesPp: number;
  avgHoldSec: number | null;
  medianNetPp: number | null;
}

export interface StrategyReport {
  strategy: string;
  evaluated: number;
  taken: number;
  skipped: number;
  /** live-equivalent: how many windows had at least one evaluation */
  windowsTouched: number;
  windowsWithTrade: number;
  tradesPerWindow: number | null;
  windowsSkippedPct: number | null;
  fills: { taker: number; makerAssumed: number };
  predictedNetPpMedian: number | null;
  realizedVsPredictedPp: number | null;
  bySplit: Record<SplitName, MetricSet>;
}

export interface BacktestReport {
  generatedAt: number;
  config: BacktestConfig;
  windows: { total: number; withSamples: number; withResult: number };
  totals: MetricSet;
  byStrategy: Record<string, StrategyReport>;
  splits: Record<SplitName, MetricSet>;
  notes: string[];
}

/* ------------------------------------------------------------------ */
/* loading                                                             */
/* ------------------------------------------------------------------ */

interface WindowData {
  win: WindowRow;
  samples: SampleRow[];
  /** ts -> venue agreement flag read from the spot tape at that second */
  agreeByTs: Map<number, boolean>;
}

function loadWindows(db: DatabaseSync, cfg: BacktestConfig): WindowData[] {
  const wins = db.prepare(
    `SELECT w.event_ticker, w.open_ts, w.close_ts, w.strike, w.settled_result, w.settle_value
       FROM k15m_windows w
       JOIN (SELECT event_ticker, COUNT(*) AS n FROM k15m_book_samples GROUP BY event_ticker) s
         ON s.event_ticker = w.event_ticker
      ORDER BY w.open_ts`,
  ).all() as unknown as WindowRow[];

  const out: WindowData[] = [];
  for (const win of wins) {
    const samples = db.prepare(
      `SELECT ts, market_ticker, event_ticker, phase, ms_to_close, yes_bid, yes_ask, micro,
              imbalance, ofi, cancel_ratio, trades_1s, taker_bias_60s, needs_snapshot,
              spot_mid, fair_spot, fair_sigma, fair_yes, implied_mid
         FROM k15m_book_samples
        WHERE event_ticker = ? AND needs_snapshot = 0
        ORDER BY ts ASC LIMIT ?`,
    ).all(win.event_ticker, cfg.maxSamplesPerWindow) as unknown as SampleRow[];
    if (samples.length === 0) continue;
    const agreeByTs = new Map<number, boolean>();
    let spotRows: Array<{ ts: number; agree_1s: number | null }> = [];
    try {
      // the spot tape may never have been enabled on this DB: agreement then
      // reads false (conservative — the gate fires fewer times, never more)
      spotRows = db.prepare(
        `SELECT ts, agree_1s FROM k15m_spot_samples
          WHERE venue = 'coinbase' AND ts >= ? AND ts <= ? ORDER BY ts`,
      ).all(win.open_ts, win.close_ts) as unknown as Array<{ ts: number; agree_1s: number | null }>;
    } catch { spotRows = []; }
    for (const r of spotRows) agreeByTs.set(r.ts, r.agree_1s === 1);
    out.push({ win, samples, agreeByTs });
  }
  return out;
}

function splitOf(win: WindowRow, ordered: WindowRow[], cfg: BacktestConfig): SplitName {
  const i = ordered.findIndex((w) => w.event_ticker === win.event_ticker);
  const n = ordered.length;
  const train = Math.max(1, Math.floor(n * cfg.trainShare));
  const val = train + Math.max(1, Math.floor(n * cfg.validationShare));
  if (i < train) return 'TRAIN';
  if (i < val) return 'VALIDATION';
  return 'TEST';
}

/** venue agreement nearest (at or before) a timestamp, within 2s */
function agreeAt(data: WindowData, ts: number): boolean {
  let best: { ts: number; v: boolean } | null = null;
  for (const [t, v] of data.agreeByTs) {
    if (t <= ts && t >= ts - 2_000 && (!best || t > best.ts)) best = { ts: t, v };
  }
  return best?.v === true;
}

/* ------------------------------------------------------------------ */
/* replay                                                              */
/* ------------------------------------------------------------------ */

interface LagPoint { ts: number; spot: number | null; mid: number | null }

function lagLookup(hist: LagPoint[], targetTs: number): LagPoint | null {
  for (let i = hist.length - 1; i >= 0; i--) if (hist[i].ts <= targetTs) return hist[i];
  return null;
}

/** First sample at or after `ts` in the same window (used for exits only). */
function sampleAt(samples: SampleRow[], ts: number): SampleRow | null {
  for (let i = 0; i < samples.length; i++) if (samples[i].ts >= ts) return samples[i];
  return null;
}

function midOf(s: SampleRow): number | null {
  if (s.implied_mid !== null) return s.implied_mid;
  if (s.yes_bid !== null && s.yes_ask !== null) return (s.yes_bid + s.yes_ask) / 2;
  return null;
}

export function runBacktest(db: DatabaseSync, cfg: BacktestConfig = backtestConfigFromEnv()): BacktestReport {
  const enabled = cfg.strategies.length > 0 ? cfg.strategies : [...ALL_STRATEGIES];
  const data = loadWindows(db, cfg);
  const ordered = data.map((d) => d.win);
  const trades: BtTrade[] = [];
  const evalCount: Record<string, { evaluated: number; skipped: number; windows: Set<string>; windowsWithTrade: Set<string> }> = {};
  for (const s of enabled) {
    evalCount[s] = { evaluated: 0, skipped: 0, windows: new Set(), windowsWithTrade: new Set() };
  }

  const cfgA = leadLagConfigFromEnv();
  const cfgB = microConfigFromEnv();
  const cfgC = panicConfigFromEnv();
  const cfgD = momentumConfigFromEnv();
  const cfgE = lateFavConfigFromEnv();
  const cfgF = makerConfigFromEnv();

  for (const dataW of data) {
    const { win, samples } = dataW;
    const split = splitOf(win, ordered, cfg);
    const hist: LagPoint[] = [];
    let lastEval = Number.NEGATIVE_INFINITY;
    let spot: number | null = null;

    for (const s of samples) {
      const tauSec = s.ms_to_close / 1_000;
      const mid = midOf(s);
      spot = s.fair_spot ?? s.spot_mid ?? spot;
      hist.push({ ts: s.ts, spot, mid });
      while (hist.length > 1_200) hist.shift();

      if (s.ts - lastEval < cfg.evalMs) continue;
      lastEval = s.ts;

      const common = {
        tauSec, strike: win.strike, mid, yesBid: s.yes_bid, yesAsk: s.yes_ask,
        sigma: s.fair_sigma, pYes: s.fair_yes, spotNow: spot,
        agree: agreeAt(dataW, s.ts),
      };

      const verdicts: StrategyVerdict[] = [];
      if (enabled.includes('A_LEADLAG')) {
        const lag = lagLookup(hist, s.ts - cfgA.lagSec * 1_000);
        verdicts.push(evaluateLeadLag({
          cfg: cfgA, now: s.ts, tauSec, strike: win.strike,
          spotNow: spot, spotLag: lag?.spot ?? null,
          midNow: mid, midLag: lag?.mid ?? null,
          venuesAgree: common.agree, sigmaPerSec: s.fair_sigma,
          yesBid: s.yes_bid, yesAsk: s.yes_ask,
        }));
      }
      if (enabled.includes('B_MICRO')) {
        verdicts.push(evaluateMicro({
          cfg: cfgB, tauSec, mid, micro: s.micro,
          imbalance: s.imbalance, ofi: s.ofi, takerBias60s: s.taker_bias_60s,
          yesBid: s.yes_bid, yesAsk: s.yes_ask,
        }));
      }
      if (enabled.includes('C_PANICFADE')) {
        const lag = lagLookup(hist, s.ts - cfgC.lookbackSec * 1_000);
        const moveBps = spot !== null && lag?.spot != null && lag.spot > 0
          ? Math.log(spot / lag.spot) * 10_000 : null;
        verdicts.push(evaluatePanicFade({
          cfg: cfgC, tauSec, midNow: mid, midLag: lag?.mid ?? null,
          spotMoveBps: moveBps, yesBid: s.yes_bid, yesAsk: s.yes_ask,
        }));
      }
      if (enabled.includes('D_MOMENTUM')) {
        const lag = lagLookup(hist, s.ts - cfgD.lookbackSec * 1_000);
        verdicts.push(evaluateMomentum({
          cfg: cfgD, tauSec, strike: win.strike, spotNow: spot, spotLag: lag?.spot ?? null,
          venuesAgree: common.agree, sigmaPerSec: s.fair_sigma,
          repricedPp: mid !== null && lag?.mid != null ? (mid - lag.mid) * 100 : null,
          yesBid: s.yes_bid, yesAsk: s.yes_ask,
        }));
      }
      if (enabled.includes('E_LATEFAV_HOLD') || enabled.includes('E_LATEFAV_EXIT')) {
        verdicts.push(evaluateLateFav({
          cfg: cfgE, tauSec, pYes: s.fair_yes, entryPrice: s.yes_ask,
          yesBid: s.yes_bid, yesAsk: s.yes_ask,
        }));
      }
      if (enabled.includes('F_MAKER')) {
        verdicts.push(evaluateMaker({
          cfg: cfgF, tauSec, pYes: s.fair_yes, yesBid: s.yes_bid, yesAsk: s.yes_ask,
        }));
      }

      for (const v of verdicts) {
        const bucket = evalCount[v.strategy] ?? (evalCount[v.strategy] = { evaluated: 0, skipped: 0, windows: new Set(), windowsWithTrade: new Set() });
        bucket.evaluated += 1;
        bucket.windows.add(win.event_ticker);
        if (v.verdict !== 'TRADE') { bucket.skipped += 1; continue; }
        bucket.windowsWithTrade.add(win.event_ticker);
        const trade = scoreTrade({ v, s, samples, win, split, cfg, spot });
        trades.push(trade);
      }
    }
  }

  return buildReport(trades, evalCount, data, cfg);
}

/** Turn a taken verdict into one scored trade (two exit modes, both honest). */
function scoreTrade(args: {
  v: StrategyVerdict; s: SampleRow; samples: SampleRow[]; win: WindowRow;
  split: SplitName; cfg: BacktestConfig; spot: number | null;
}): BtTrade {
  const { v, s, samples, win, split, cfg } = args;
  const side = (v.side ?? 'YES') as 'YES' | 'NO';
  const sign = side === 'YES' ? 1 : -1;
  const maker = v.strategy === 'F_MAKER' || (v.strategy === 'B_MICRO' && v.costPp === 0);
  const entryPrice = maker
    ? (side === 'YES' ? s.yes_bid ?? 0 : 1 - (s.yes_ask ?? 1))
    : (side === 'YES' ? s.yes_ask ?? 0 : 1 - (s.yes_bid ?? 1));
  const entryFeePp = maker ? 0 : takerFee(1, Math.min(0.999, Math.max(0.001, entryPrice)), KXBTC15M_FEES).perContract * 100;

  const base: BtTrade = {
    strategy: v.strategy, split, eventTicker: win.event_ticker,
    entryTs: s.ts, exitTs: null, side, entryPrice, exitPrice: null, holdSec: null,
    feesPp: entryFeePp, pnlPp: null, scoreMode: 'SETTLEMENT', fillAssumed: maker,
    netPpPredicted: v.netPp,
  };

  // 1) round trip at t+hold against the real later book (preferred: it is a
  //    price we could actually have traded, no settlement needed)
  const exitAt = sampleAt(samples, s.ts + cfg.holdSec * 1_000);
  if (exitAt && exitAt.yes_bid !== null && exitAt.yes_ask !== null) {
    const exitPrice = maker
      ? (side === 'YES' ? exitAt.yes_ask ?? 0 : 1 - (exitAt.yes_bid ?? 1))
      : (side === 'YES' ? exitAt.yes_bid ?? 0 : 1 - (exitAt.yes_ask ?? 1));
    const exitFeePp = maker ? 0 : takerFee(1, Math.min(0.999, Math.max(0.001, exitPrice)), KXBTC15M_FEES).perContract * 100;
    const gross = sign * (exitPrice - entryPrice) * 100;
    return {
      ...base,
      exitTs: exitAt.ts, exitPrice, holdSec: (exitAt.ts - s.ts) / 1_000,
      feesPp: entryFeePp + exitFeePp,
      pnlPp: gross - entryFeePp - exitFeePp,
      scoreMode: 'EXIT_AT_HOLD',
    };
  }

  // 2) no later book inside the window: settlement only if we have the result
  const result = win.settled_result;
  if (result === 'YES' || result === 'NO') {
    const won = (result === 'YES' && side === 'YES') || (result === 'NO' && side === 'NO');
    const gross = won ? (1 - entryPrice) * 100 : -entryPrice * 100;
    return { ...base, scoreMode: 'SETTLEMENT', feesPp: entryFeePp, pnlPp: gross - entryFeePp };
  }
  return base; // unscorable: no exit book and no official result
}

/* ------------------------------------------------------------------ */
/* metrics                                                             */
/* ------------------------------------------------------------------ */

function metricsOf(pnls: number[], holds: number[], fees: number[]): MetricSet {
  const n = pnls.length;
  const wins = pnls.filter((p) => p > 0).length;
  const sum = pnls.reduce((a, b) => a + b, 0);
  const gains = pnls.filter((p) => p > 0).reduce((a, b) => a + b, 0);
  const losses = pnls.filter((p) => p < 0).reduce((a, b) => a + b, 0);
  const mean = n ? sum / n : null;
  const variance = n > 1 ? pnls.reduce((a, b) => a + (b - (mean ?? 0)) ** 2, 0) / (n - 1) : null;
  const sd = variance !== null && variance > 0 ? Math.sqrt(variance) : null;
  const sorted = [...pnls].sort((a, b) => a - b);
  let peak = 0;
  let dd = 0;
  let cum = 0;
  for (const p of pnls) {
    cum += p;
    peak = Math.max(peak, cum);
    dd = Math.max(dd, peak - cum);
  }
  return {
    trades: n,
    scorable: n,
    unscorable: 0,
    wins,
    winRatePct: n ? Math.round((wins / n) * 1000) / 10 : null,
    netPp: n ? Math.round(sum * 100) / 100 : null,
    netPerContractPp: mean !== null ? Math.round(mean * 100) / 100 : null,
    profitFactor: n && losses !== 0 ? Math.round((gains / Math.abs(losses)) * 1000) / 1000 : (n && gains > 0 ? null : 0),
    expectancyPp: mean !== null ? Math.round(mean * 100) / 100 : null,
    sharpePerTrade: sd !== null && mean !== null && n > 1 ? Math.round((mean / sd) * Math.sqrt(n) * 1000) / 1000 : null,
    maxDrawdownPp: n ? Math.round(dd * 100) / 100 : null,
    tailP5Pp: n >= 5 ? Math.round(sorted[Math.floor(n * 0.05)] * 100) / 100 : null,
    feesPp: Math.round(fees.reduce((a, b) => a + b, 0) * 100) / 100,
    avgHoldSec: holds.length ? Math.round((holds.reduce((a, b) => a + b, 0) / holds.length) * 10) / 10 : null,
    medianNetPp: n ? Math.round(sorted[n >> 1] * 100) / 100 : null,
  };
}

function buildReport(
  trades: BtTrade[],
  evalCount: Record<string, { evaluated: number; skipped: number; windows: Set<string>; windowsWithTrade: Set<string> }>,
  data: WindowData[],
  cfg: BacktestConfig,
): BacktestReport {
  const splits: Record<SplitName, BtTrade[]> = { TRAIN: [], VALIDATION: [], TEST: [] };
  const byStrategy: Record<string, StrategyReport> = {};
  const notes: string[] = [];

  for (const [name, bucket] of Object.entries(evalCount)) {
    const mine = trades.filter((t) => t.strategy === name);
    const splitMetrics = {} as Record<SplitName, MetricSet>;
    for (const split of ['TRAIN', 'VALIDATION', 'TEST'] as SplitName[]) {
      const rows = mine.filter((t) => t.split === split);
      splits[split].push(...rows);
      const scored = rows.filter((r) => r.pnlPp !== null);
      splitMetrics[split] = metricsOf(
        scored.map((r) => r.pnlPp as number),
        scored.map((r) => r.holdSec ?? 0),
        scored.map((r) => r.feesPp),
      );
      splitMetrics[split].unscorable = rows.length - scored.length;
    }
    const scored = mine.filter((r) => r.pnlPp !== null);
    const predicted = mine.map((t) => t.netPpPredicted).filter((p): p is number => typeof p === 'number');
    const realized = scored.map((t) => t.pnlPp as number);
    byStrategy[name] = {
      strategy: name,
      evaluated: bucket.evaluated,
      taken: mine.length,
      skipped: bucket.skipped,
      windowsTouched: bucket.windows.size,
      windowsWithTrade: bucket.windowsWithTrade.size,
      tradesPerWindow: bucket.windows.size ? Math.round((mine.length / bucket.windows.size) * 100) / 100 : null,
      windowsSkippedPct: bucket.windows.size
        ? Math.round((1 - bucket.windowsWithTrade.size / bucket.windows.size) * 1000) / 10
        : null,
      fills: {
        taker: mine.filter((t) => !t.fillAssumed).length,
        makerAssumed: mine.filter((t) => t.fillAssumed).length,
      },
      predictedNetPpMedian: predicted.length
        ? Math.round([...predicted].sort((a, b) => a - b)[predicted.length >> 1] * 100) / 100
        : null,
      realizedVsPredictedPp: scored.length && predicted.length
        ? Math.round((realized.reduce((a, b) => a + b, 0) / realized.length
          - predicted.reduce((a, b) => a + b, 0) / predicted.length) * 100) / 100
        : null,
      bySplit: splitMetrics,
    };
  }

  const splitMetricsOut = {} as Record<SplitName, MetricSet>;
  for (const split of ['TRAIN', 'VALIDATION', 'TEST'] as SplitName[]) {
    const rows = splits[split];
    const scored = rows.filter((r) => r.pnlPp !== null);
    splitMetricsOut[split] = metricsOf(
      scored.map((r) => r.pnlPp as number),
      scored.map((r) => r.holdSec ?? 0),
      scored.map((r) => r.feesPp),
    );
    splitMetricsOut[split].unscorable = rows.length - scored.length;
  }
  const allScored = trades.filter((t) => t.pnlPp !== null);
  const totals = metricsOf(
    allScored.map((t) => t.pnlPp as number),
    allScored.map((t) => t.holdSec ?? 0),
    allScored.map((t) => t.feesPp),
  );
  totals.unscorable = trades.length - allScored.length;

  const withResult = data.filter((d) => d.win.settled_result).length;
  notes.push('Fills: taker entries at the ASK and exits at the BID (never midpoints); maker fills are ASSUMED, probability of fill is not modelled.');
  notes.push('Windows without an official settlement result are scored only when a later book exists inside the window; otherwise the trade is unscorable, never counted as a win or loss.');
  notes.push('Params (rebound fraction, continuation, thresholds) come from the live env config — this report measures THEM, it does not fit them. Split the output TRAIN/VALIDATION/TEST before trusting any number.');
  if (withResult === 0) notes.push('NO settled results are recorded yet: settlement-mode scoring is unavailable and hold-to-settlement P&L cannot be computed.');
  notes.push('Sharpe is per-trade (mean/sd * sqrt(n)), not annualized — 15-minute windows have no meaningful annualization here.');

  return {
    generatedAt: Date.now(),
    config: cfg,
    windows: {
      total: data.length,
      withSamples: data.length,
      withResult,
    },
    totals,
    byStrategy,
    splits: splitMetricsOut,
    notes,
  };
}