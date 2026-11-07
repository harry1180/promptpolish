/**
 * Crypto entry-gate backtest — replays the PRODUCTION decision pipeline over
 * the daily bars already in crypto.db and reports, per candidate config, how
 * many BUY entries it would have produced and how they would have done, net
 * of the real fee/slippage model.
 *
 * Read-only: opens crypto.db with readOnly:true and never writes.
 *
 *   CRYPTO_DB=<path>/crypto.db node scripts/crypto-backtest.mts
 *
 * Faithful to production (same code, imported from @promptslim/tucore):
 *   shortTermScore -> cryptoParts -> fuse -> engine gates (confidence floor,
 *   per-day dedupe, sane R:R, evaluateEntry) -> liquidity-scaled fill with
 *   0.25%/side fees -> settleEndOfDay exits via checkExit (gap-aware).
 *
 * Documented assumptions, not hidden ones:
 *   - universe = today's 25 coins (the 730d backfill only holds those) ->
 *     mild selection/survivorship bias;
 *   - daily bars only: intraday stop/target tests happen on the daily bar,
 *     exactly like production's settleEndOfDay;
 *   - no LLM, no news pipeline (v1 has neither), events: [].
 *
 * Variants:
 *   current       production path untouched (SHORT default fusion weights)
 *   floor55       current + confidence floor 0.55 instead of 0.7 (fuse can
 *                   emit BUY at hint 0.55, the engine then throws it away)
 *   crypto_weights  fusion weights {technical: 0.84, regime: 0.16} so the
 *                   0.15/0.30 thresholds are reachable with the 2 parts
 *                   crypto actually supplies
 *   regime_bar    crypto_weights + BEAR_TREND no longer a *fatal* long
 *                   contradiction when it is the ONLY one: needs >=3
 *                   confirmations and positive 90d relative strength
 *   dip           crypto_weights + a separate rule leg (RSI<=30, no 20d
 *                   breakdown, rel.strength >= -10%) with its own dedupe key
 *   loose         crypto_weights + relaxed fusion band (0.15 / hint 0.60) and
 *                   confidence floor 0.55 — the "just open the gates" test
 *   fee16 / weights_fee16  same rules with Kraken's real tier-1 taker fee
 *                   (0.16%/side instead of the 0.25% default)
 *   target3atr / t3atr_fee16  target = price + 3*ATR14 instead of the next
 *                   resistance — tests exit geometry, not entry volume
 */
import { DatabaseSync } from 'node:sqlite';
import { checkExit, detectRegime, evaluateEntry, fuse, shortTermScore } from '@promptslim/tucore';
import type { Candle, Regime, ScoreParts } from '@promptslim/tucore';

const FEE_PCT = 0.0025;
const MIN_CONF = 0.7;
const MIN_RR = 1.5;
const RISK_PER_TRADE = 0.0075;
const MAX_POSITION_PCT = 0.1;
const STRATEGY = 'crypto_momentum_v1';
const START_CAPITAL = 100_000;
const HORIZON = 'SHORT' as const;

/** engine.ts cryptoParts — regime bucket used as a fusion part. */
const REGIME_SCORE: Record<string, number> = {
  BULL_TREND: 0.5, RISK_ON: 0.5, MOMENTUM: 0.5,
  LOW_VOLATILITY: 0.25, RECOVERY: 0.25, MEAN_REVERSION: 0,
  BEAR_TREND: -0.5, RISK_OFF: -0.5, LIQUIDITY_STRESS: -0.5, HIGH_VOLATILITY: -0.5,
  UNCERTAIN: 0,
};

/** The 6 evidence kinds shortTermScore counts as entry confirmations. */
const CONFIRMATIONS = new Set([
  'relative_strength', 'breakout', 'trend_alignment', 'vwap',
  'sector_momentum', 'aligned_events',
]);

/* ------------------------------------------------------------------ */
/* data: read-only bars from crypto.db                                */
/* ------------------------------------------------------------------ */

const dbPath =
  process.env.CRYPTO_DB ?? '/var/lib/docker/volumes/promptpolish_pp-data/_data/crypto.db';

interface BarRow { ticker: string; date: string; open: number; high: number; low: number; close: number; volume: number }

const db = new DatabaseSync(dbPath, { readOnly: true });
const rows = db
  .prepare('SELECT ticker, date, open, high, low, close, volume FROM market_bars ORDER BY ticker, date')
  .all() as unknown as BarRow[];
const universe = (db.prepare('SELECT symbol FROM crypto_universe WHERE active = 1').all() as unknown as Array<{ symbol: string }>)
  .map((r) => r.symbol);

const barsByTicker = new Map<string, Candle[]>();
for (const r of rows) {
  const c: Candle = { date: r.date, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume };
  const arr = barsByTicker.get(r.ticker);
  if (arr) arr.push(c);
  else barsByTicker.set(r.ticker, [c]);
}

const benchmark = barsByTicker.get('BTC') ?? [];
const btcPos = new Map<string, number>();
benchmark.forEach((c, i) => btcPos.set(c.date, i));

// active universe = coins that have bars (BTC is the benchmark, not a member)
const tickers = universe.filter((t) => t !== 'BTC' && (barsByTicker.get(t)?.length ?? 0) > 0);
if (benchmark.length === 0 || tickers.length === 0) {
  console.error('no bars found in', dbPath);
  process.exit(1);
}

/** engine.ts liquidityOf — log10 of recent 30-bar dollar volume, /3. */
function liquidityOf(bars: Candle[]): number {
  const recent = bars.slice(-30);
  if (recent.length < 5) return 0.3;
  const avgVol = recent.reduce((s, b) => s + b.volume, 0) / recent.length;
  const avgPrice = recent.reduce((s, b) => s + b.close, 0) / recent.length;
  const notional = avgVol * avgPrice;
  return Math.max(0.05, Math.min(1, Math.log10(Math.max(1, notional)) / 3));
}

/** engine.ts volatilityOf — stdev of log returns. */
function volatilityOf(bars: Candle[]): number {
  const rets: number[] = [];
  for (let i = 1; i < bars.length; i++) rets.push(Math.log(bars[i].close / bars[i - 1].close));
  if (rets.length < 2) return 0.03;
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length;
  return Math.sqrt(variance);
}

/** crypto/broker.ts simulateCryptoFill without a book: liquidity-scaled slip. */
function fillPrice(side: 'BUY' | 'SELL', price: number, liq: number): number {
  const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
  const bps = clamp(2 + 18 * (1 - Math.max(0.05, Math.min(1, liq))), 2, 60);
  return side === 'BUY' ? price * (1 + bps / 10_000) : price * (1 - bps / 10_000);
}

/* ------------------------------------------------------------------ */
/* strategy layer — computed ONCE per (ticker, date), reused by every  */
/* variant (only fusion weights + entry policy differ)                */
/* ------------------------------------------------------------------ */

interface StratPoint {
  ticker: string;
  date: string;
  i: number;                    // index into barsByTicker[ticker]
  price: number;
  st: ReturnType<typeof shortTermScore>;
  regime: Regime;
  regimeConf: number;
  parts: ScoreParts;
  freshness: number;
  fatalLongKinds: string[];     // trend_chase / breakout_down / regime
  confPos: number;              // confirmations (evidence-flagged)
  confNeg: number;
  relStrength: number;
  rsi14: number;
  liq: number;
  vol: number;
}

const stratByDate = new Map<string, StratPoint[]>();
let scanned = 0;
let insufficient = 0;
const t0 = Date.now();

for (const t of tickers) {
  const bars = barsByTicker.get(t)!;
  for (let i = 119; i < bars.length; i++) {
    const last = bars[i];
    const bp = btcPos.get(last.date);
    if (bp === undefined || bp < 119) continue; // need >=120 bench bars too
    scanned++;
    const candles = bars.slice(0, i + 1);
    const bench = benchmark.slice(0, bp + 1);
    const regimeDet = detectRegime(bench);
    const regime = regimeDet.regime;
    const quote = {
      symbol: t, price: last.close,
      prevClose: bars[i - 1].close,
      ts: Date.parse(`${last.date}T00:00:00Z`),
    };
    const st = shortTermScore({
      ticker: t, company: t, candles, benchmarkCandles: bench,
      quote, regime, events: [], sessionDate: last.date,
    });
    if (st.action === 'INSUFFICIENT_DATA') { insufficient++; continue; }

    // engine.ts cryptoParts. Freshness: production compares quote age at
    // decision time (a live quote, ~0 age); here the decision is made on the
    // bar's own date with that bar's close, so it is fresh by construction.
    const freshness = 1;
    const parts: ScoreParts = {
      technical: st.score, fundamental: 0, event: 0, sentiment: 0, macro: 0,
      regime: REGIME_SCORE[regime] ?? 0,
    };

    // fatal longs, recomputed from factors (strategies.ts:313-321)
    const fatalLongKinds: string[] = [];
    if (st.factors.trendAlignment === -1) fatalLongKinds.push('trend_chase');
    if (st.factors.breakout === -1) fatalLongKinds.push('breakout_down');
    const regimeVeto =
      (regime === 'BEAR_TREND' || regime === 'LIQUIDITY_STRESS') &&
      (st.factors.regimeConfidence ?? 0) > 0.7;
    if (regimeVeto) fatalLongKinds.push('regime');

    let confPos = 0, confNeg = 0;
    for (const e of st.evidence) {
      if (!CONFIRMATIONS.has(e.kind)) continue;
      if (e.positive) confPos++; else confNeg++;
    }

    const point: StratPoint = {
      ticker: t, date: last.date, i, price: last.close, st, regime,
      regimeConf: regimeDet.confidence, parts, freshness, fatalLongKinds,
      confPos, confNeg,
      relStrength: Number(st.factors.relativeStrength ?? 0),
      rsi14: Number(st.factors.rsi ?? 50),
      liq: liquidityOf(candles), vol: volatilityOf(candles),
    };
    const list = stratByDate.get(last.date);
    if (list) list.push(point);
    else stratByDate.set(last.date, [point]);
  }
}

const dates = [...stratByDate.keys()].sort();
console.log(
  `strategy layer: ${scanned} coin-days over ${dates.length} dates ` +
  `(${dates[0]} .. ${dates[dates.length - 1]}), ${tickers.length} coins, ` +
  `${insufficient} insufficient, ${Date.now() - t0}ms`,
);

/* ------------------------------------------------------------------ */
/* variants + per-point decision                                      */
/* ------------------------------------------------------------------ */

interface Variant {
  key: string;
  label: string;
  weights?: Partial<ScoreParts>;
  regimeBar: boolean;
  dip: boolean;
  minConf: number;
  /** relaxed fusion decision band: weighted >= 0.15 with hint >= 0.60 */
  loose?: boolean;
  /** override the modelled round-trip fee (default CRYPTO_FEE_PCT 0.25%/side) */
  feePct?: number;
  /** replace the S/R target with price + N*ATR14 (wider target geometry) */
  targetAtr?: number;
}

const VARIANTS: Variant[] = [
  { key: 'current', label: 'production (SHORT default weights)', weights: undefined, regimeBar: false, dip: false, minConf: MIN_CONF },
  { key: 'floor55', label: 'production weights + confidence floor 0.55 (fuse allows BUY at hint 0.55)', weights: undefined, regimeBar: false, dip: false, minConf: 0.55 },
  { key: 'crypto_weights', label: 'fusion weights technical 0.84 / regime 0.16', weights: { technical: 0.84, regime: 0.16 }, regimeBar: false, dip: false, minConf: MIN_CONF },
  { key: 'regime_bar', label: 'crypto_weights + regime veto -> higher bar (>=3 confirmations, rel.strength >= 0)', weights: { technical: 0.84, regime: 0.16 }, regimeBar: true, dip: false, minConf: MIN_CONF },
  { key: 'dip', label: 'crypto_weights + dip leg (RSI<=30, no 20d breakdown, rel.strength >= -10%)', weights: { technical: 0.84, regime: 0.16 }, regimeBar: false, dip: true, minConf: MIN_CONF },
  { key: 'loose', label: 'crypto_weights + relaxed band (weighted 0.15 / hint 0.60) + floor 0.55', weights: { technical: 0.84, regime: 0.16 }, regimeBar: false, dip: false, minConf: 0.55, loose: true },
  { key: 'fee16', label: 'production weights + Kraken tier-1 taker fee 0.16%/side', weights: undefined, regimeBar: false, dip: false, minConf: MIN_CONF, feePct: 0.0016 },
  { key: 'weights_fee16', label: 'crypto_weights + Kraken tier-1 taker fee 0.16%/side', weights: { technical: 0.84, regime: 0.16 }, regimeBar: false, dip: false, minConf: MIN_CONF, feePct: 0.0016 },
  { key: 'prod_now', label: 'ACTUAL PRODUCTION: default weights + atr3 target + 0.16%/side (CRYPTO_* compose env)', weights: undefined, regimeBar: false, dip: false, minConf: MIN_CONF, targetAtr: 3, feePct: 0.0016 },
  { key: 'prod_wts', label: 'prod_now + fusion weights technical 0.84 / regime 0.16', weights: { technical: 0.84, regime: 0.16 }, regimeBar: false, dip: false, minConf: MIN_CONF, targetAtr: 3, feePct: 0.0016 },
  { key: 'prod_w_f55', label: 'prod_now (as deployed) + confidence floor 0.55', weights: undefined, regimeBar: false, dip: false, minConf: 0.55, targetAtr: 3, feePct: 0.0016 },
  { key: 'prod_wts_f50', label: 'prod_now + crypto weights + confidence floor 0.50', weights: { technical: 0.84, regime: 0.16 }, regimeBar: false, dip: false, minConf: 0.5, targetAtr: 3, feePct: 0.0016 },
  { key: 'target3atr', label: 'crypto_weights + target = price + 3*ATR14 instead of next resistance', weights: { technical: 0.84, regime: 0.16 }, regimeBar: false, dip: false, minConf: MIN_CONF, targetAtr: 3 },
  { key: 't3atr_fee16', label: 'crypto_weights + 3*ATR target + 0.16%/side fee', weights: { technical: 0.84, regime: 0.16 }, regimeBar: false, dip: false, minConf: MIN_CONF, targetAtr: 3, feePct: 0.0016 },
];

interface Decision {
  action: 'BUY' | 'SELL' | null;
  confidence: number;
  strategy: string;
  source: 'momentum' | 'dip';
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** One point through one variant's decision layer (no engine gates yet). */
function decide(p: StratPoint, v: Variant): Decision {
  // rule leg — separate strategy, own dedupe key, still floor+risk gated
  if (v.dip) {
    const noBreakdown = p.st.factors.breakout !== -1;
    const dipOk = p.rsi14 <= 30 && noBreakdown && p.relStrength >= -0.1;
    if (dipOk) {
      // calibration: RSI 30 sits exactly on the production 0.7 floor, deeper
      // oversold earns more conviction
      const hint = clamp(0.7 + (30 - p.rsi14) * 0.008, 0.5, 0.92);
      return { action: 'BUY', confidence: hint, strategy: 'crypto_dip_v1', source: 'dip' };
    }
  }

  const base = fuse({
    parts: p.parts,
    horizon: HORIZON,
    strategy: STRATEGY,
    ...(v.weights ? { weights: v.weights } : {}),
    confidenceHint: p.st.confidence,
    evidence: p.st.evidence,
    contradictions: p.st.contradictions,
  });
  let action = base.action;
  let confidence = base.confidence;

  // regime_bar: BEAR_TREND stops being FATAL when it is the only fatal long
  if (v.regimeBar && action !== 'BUY') {
    const onlyRegime = p.fatalLongKinds.length === 1 && p.fatalLongKinds[0] === 'regime';
    if (onlyRegime && p.confPos >= 3 && p.relStrength >= 0) {
      const ratio = p.confPos / Math.max(1, p.confPos + p.confNeg);
      const hint = clamp(0.3 + 0.6 * ratio, 0, 0.9); // as if the entry had been allowed
      const re = fuse({
        parts: p.parts,
        horizon: HORIZON,
        strategy: STRATEGY,
        ...(v.weights ? { weights: v.weights } : {}),
        confidenceHint: hint,
        evidence: p.st.evidence,
        contradictions: p.st.contradictions,
      });
      if (re.action === 'BUY') { action = re.action; confidence = re.confidence; }
    }
  }

  // loose: same weighted score, wider decision band. Production fuse table is
  // (0.15 & hint>=0.75) or (0.30 & hint>=0.55); this uses 0.15 & hint>=0.60.
  // Conflicts still veto, exactly as in fuseSignals.
  if (v.loose && base.action !== 'CONFLICTING_SIGNAL') {
    const hint = p.st.confidence;
    const w = base.weighted;
    const conf = clamp(hint * (0.7 + 0.3 * Math.abs(w)), 0, 1);
    if (action !== 'BUY' && w >= 0.15 && hint >= 0.6) { action = 'BUY'; confidence = conf; }
    else if (action !== 'SELL' && w <= -0.15 && hint >= 0.6) { action = 'SELL'; confidence = conf; }
  }

  return {
    action: action === 'BUY' || action === 'SELL' ? action : null,
    confidence,
    strategy: STRATEGY,
    source: 'momentum',
  };
}

/* ------------------------------------------------------------------ */
/* runner: one variant = one paper book over the whole window         */
/* ------------------------------------------------------------------ */

interface OpenPos {
  ticker: string; idx: number; entryDate: string; entryPrice: number;
  qty: number; target: number; stop: number; maxHold: number;
  sessionsHeld: number; entryFee: number; source: string;
}

interface ClosedTrade {
  ticker: string; entryDate: string; exitDate: string; entryPrice: number;
  exitPrice: number; qty: number; returnPct: number; netPnl: number;
  reason: string; holdDays: number; source: string; fee: number;
}

interface Report {
  key: string; label: string;
  points: number; noAction: number; buys: number; sells: number;
  belowConf: number; dup: number; saneFail: number; alreadyHeld: number;
  riskReject: number; riskReasons: Record<string, number>;
  orders: number; closed: number; openLeft: number;
  wins: number; winRate: number; avgReturnPct: number; medianReturnPct: number;
  netPnl: number; grossPnl: number; grossAvgPct: number; fees: number;
  finalEquity: number; maxDrawdownPct: number;
  tradesPerWeek: number; avgHoldDays: number; benchReturnPct: number;
  exitReasons: Record<string, number>;
}

const idxByTicker = new Map<string, Map<string, number>>();
for (const t of tickers) {
  const m = new Map<string, number>();
  barsByTicker.get(t)!.forEach((c, i) => m.set(c.date, i));
  idxByTicker.set(t, m);
}

function riskEnv(p: StratPoint) {
  return {
    liquidityScore: p.liq,
    volatilityPct: p.vol,
    regime: p.regime,
    dataQuality: { stale: p.freshness < 0.05, disagreement: false, missing: false },
    killSwitchActive: false,
    earningsWithinDays: 9999,
  } as Parameters<typeof evaluateEntry>[3];
}

function runVariant(v: Variant): Report {
  const feePct = v.feePct ?? FEE_PCT;
  const seen = new Set<string>();
  const open = new Map<string, OpenPos>();
  const trades: ClosedTrade[] = [];
  const riskReasons: Record<string, number> = {};
  const exitReasons: Record<string, number> = {};
  let cash = START_CAPITAL;
  let equity = START_CAPITAL;
  let peak = START_CAPITAL;
  let maxDD = 0;
  let fees = 0;
  let orders = 0;
  const f = {
    points: 0, noAction: 0, buys: 0, sells: 0, belowConf: 0, dup: 0,
    saneFail: 0, alreadyHeld: 0, riskReject: 0,
  };

  for (const date of dates) {
    const points = stratByDate.get(date)!;
    const decs: Array<{ p: StratPoint; d: Decision }> = [];
    for (const p of points) {
      f.points++;
      const d = decide(p, v);
      if (d.action === null) { f.noAction++; continue; }
      if (d.action === 'BUY') f.buys++;
      else f.sells++;
      decs.push({ p, d });
    }

    /* --- exits: settleEndOfDay on this date's real bar --------------- */
    for (const pos of [...open.values()]) {
      const idx = idxByTicker.get(pos.ticker)!.get(date);
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
      const exitPrice =
        reason === 'STOP_REACHED' ? Math.min(pos.stop, Math.max(bar.open, pos.stop))
        : reason === 'TARGET_REACHED' ? Math.max(pos.target, Math.min(bar.open, pos.target))
        : bar.close;
      const exitFee = exitPrice * pos.qty * feePct;
      fees += exitFee;
      cash += pos.qty * exitPrice - exitFee;
      const netPnl = (exitPrice - pos.entryPrice) * pos.qty - pos.entryFee - exitFee;
      trades.push({
        ticker: pos.ticker, entryDate: pos.entryDate, exitDate: date,
        entryPrice: pos.entryPrice, exitPrice, qty: pos.qty,
        returnPct: (netPnl / (pos.entryPrice * pos.qty)) * 100,
        netPnl, reason,
        holdDays: Math.round((Date.parse(date) - Date.parse(pos.entryDate)) / 86_400_000),
        source: pos.source,
        fee: pos.entryFee + exitFee,
      });
      exitReasons[reason] = (exitReasons[reason] ?? 0) + 1;
      open.delete(pos.ticker);
    }

    /* --- entries: engine gates in production order ------------------- */
    for (const { p, d } of decs) {
      if (d.action !== 'BUY') continue;
      const key = `${d.strategy}|${d.source}|${p.ticker}|BUY|${date}`;
      if (seen.has(key)) { f.dup++; continue; }
      if (d.confidence < v.minConf) { f.belowConf++; continue; }

      const stopDist = Math.max(0.0001, p.price - p.st.invalidation);
      // target geometry: production uses the next resistance above price;
      // variants may widen it to price + N*ATR14 (st.factors.atr)
      const atr = Number(p.st.factors.atr ?? 0);
      const effTarget = v.targetAtr && atr > 0 ? p.price + v.targetAtr * atr : p.st.target;
      const rr = (effTarget - p.price) / stopDist;
      const sane =
        stopDist >= p.price * 0.005 && rr >= MIN_RR && rr <= 20 && effTarget > p.price;
      if (!sane) { f.saneFail++; continue; }

      seen.add(key); // signal is emitted here, exactly like insertCryptoSignal
      if (open.has(p.ticker)) { f.alreadyHeld++; continue; }

      const drawdownPct = Math.max(0, (peak - equity) / Math.max(1, peak)) * 100;
      const decision = evaluateEntry(
        { equity, cash, openPositions: [], currentDrawdownPct: drawdownPct },
        {
          ticker: p.ticker, sector: 'Crypto', price: p.price,
          entryLow: p.st.entryLow, invalidation: p.st.invalidation,
          target: effTarget, confidence: d.confidence, horizon: HORIZON,
        },
        {
          riskPerTradePct: RISK_PER_TRADE, maxPositionPct: MAX_POSITION_PCT,
          maxCorrelatedPct: 1, maxSectorPct: 1, minRiskReward: MIN_RR,
          maxEarningsDays: 3,
        },
        riskEnv(p),
      );
      if (!decision.approved || decision.sizeShares <= 0) {
        f.riskReject++;
        for (const r of decision.reasons) riskReasons[r] = (riskReasons[r] ?? 0) + 1;
        continue;
      }

      const entryPrice = fillPrice('BUY', p.price, p.liq);
      const qty = decision.sizeShares;
      const notional = entryPrice * qty;
      const entryFee = notional * feePct;
      if (notional + entryFee > cash) { f.riskReject++; continue; }
      cash -= notional + entryFee;
      fees += entryFee;
      orders++;
      open.set(p.ticker, {
        ticker: p.ticker, idx: p.i, entryDate: date, entryPrice, qty,
        target: effTarget, stop: p.st.invalidation,
        maxHold: p.st.maxHoldSessions, sessionsHeld: 0, entryFee,
        source: d.source,
      });
    }

    /* --- mark to close ------------------------------------------------ */
    equity = cash;
    for (const pos of open.values()) {
      const idx = idxByTicker.get(pos.ticker)!.get(date);
      const bars = barsByTicker.get(pos.ticker)!;
      const last = idx !== undefined ? bars[idx].close : bars[bars.length - 1].close;
      equity += pos.qty * last;
    }
    if (equity > peak) peak = equity;
    const dd = ((peak - equity) / peak) * 100;
    if (dd > maxDD) maxDD = dd;
  }

  const closed = trades.length;
  const wins = trades.filter((t) => t.netPnl > 0).length;
  const rets = trades.map((t) => t.returnPct).sort((a, b) => a - b);
  const avg = closed ? rets.reduce((s, r) => s + r, 0) / closed : 0;
  const median = closed ? rets[Math.floor(rets.length / 2)] : 0;
  const grossPnl = trades.reduce((s, t) => s + t.netPnl + t.fee, 0);
  const grossAvgPct = closed
    ? trades.reduce((s, t) => s + ((t.netPnl + t.fee) / (t.entryPrice * t.qty)) * 100, 0) / closed
    : 0;
  const weeks = Math.max(1, (Date.parse(dates[dates.length - 1]) - Date.parse(dates[0])) / (7 * 86_400_000));

  return {
    key: v.key, label: v.label, ...f,
    belowConf: f.belowConf, dup: f.dup, saneFail: f.saneFail,
    alreadyHeld: f.alreadyHeld, riskReject: f.riskReject, riskReasons,
    orders, closed, openLeft: open.size, wins,
    winRate: closed ? (wins / closed) * 100 : 0,
    avgReturnPct: avg, medianReturnPct: median,
    netPnl: trades.reduce((s, t) => s + t.netPnl, 0),
    grossPnl, grossAvgPct,
    fees, finalEquity: equity, maxDrawdownPct: maxDD,
    tradesPerWeek: closed / weeks,
    avgHoldDays: closed ? trades.reduce((s, t) => s + t.holdDays, 0) / closed : 0,
    benchReturnPct: 0, exitReasons,
  };
}

/* ------------------------------------------------------------------ */
/* diagnostics + main                                                  */
/* ------------------------------------------------------------------ */

const btcAt = (d: string): number => {
  const i = btcPos.get(d);
  return i !== undefined ? benchmark[i].close : NaN;
};
const startPx = btcAt(dates.find((d) => Number.isFinite(btcAt(d)))!);
const endPx = btcAt([...dates].reverse().find((d) => Number.isFinite(btcAt(d)))!);
const benchReturnPct = (endPx / startPx - 1) * 100;

// why the production pipeline produces no BUY, measured over the window
let vetoRegime = 0, structuralFatal = 0;
let poolRB3 = 0, poolRB4 = 0, poolDip25 = 0, poolDip30 = 0, poolDip35 = 0;
const actionMix: Record<string, number> = {};
for (const list of stratByDate.values()) {
  for (const p of list) {
    const has = (k: string) => p.fatalLongKinds.includes(k);
    if (has('regime')) vetoRegime++;
    if (has('trend_chase') || has('breakout_down')) structuralFatal++;
    const regimeOnly = p.fatalLongKinds.length === 1 && p.fatalLongKinds[0] === 'regime';
    if (regimeOnly && p.confPos >= 3 && p.relStrength >= 0) poolRB3++;
    if (regimeOnly && p.confPos >= 4 && p.relStrength >= 0) poolRB4++;
    const noBreakdown = p.st.factors.breakout !== -1;
    if (noBreakdown && p.relStrength >= -0.05 && p.rsi14 <= 25) poolDip25++;
    if (noBreakdown && p.relStrength >= -0.1 && p.rsi14 <= 30) poolDip30++;
    if (noBreakdown && p.relStrength >= -0.15 && p.rsi14 <= 35) poolDip35++;
    actionMix[p.st.action] = (actionMix[p.st.action] ?? 0) + 1;
  }
}

console.log(`\nwindow ${dates[0]} .. ${dates[dates.length - 1]} | BTC ${benchReturnPct.toFixed(1)}% | $100k start`);
console.log('\nDiagnostics over all coin-days:');
console.log(`  strategy action mix       ${JSON.stringify(actionMix)}`);
console.log(`  regime veto active        ${vetoRegime} coin-days (BEAR_TREND/LIQUIDITY_STRESS @>70% conf)`);
console.log(`  structural fatal long     ${structuralFatal} coin-days (bearish stack or 20d breakdown)`);
console.log(`  regime_bar pool  >=3 conf ${poolRB3} coin-days | >=4 conf ${poolRB4}`);
console.log(`  dip pool  RSI<=25/-5%     ${poolDip25} | RSI<=30/-10% ${poolDip30} | RSI<=35/-15% ${poolDip35}`);

const reports: Report[] = [];
for (const v of VARIANTS) {
  const r = runVariant(v);
  r.benchReturnPct = benchReturnPct;
  reports.push(r);
}

console.log('\nvariant            buys   sells noAct  conf  sane  risk  fills  closed  win%   avgRet%  netPnL   finalEq   maxDD%  /wk  holdD');
for (const r of reports) {
  console.log(
    `${r.key.padEnd(18)}${String(r.buys).padStart(5)}${String(r.sells).padStart(7)}` +
    `${String(r.noAction).padStart(6)}${String(r.belowConf).padStart(6)}${String(r.saneFail).padStart(6)}` +
    `${String(r.riskReject).padStart(6)}${String(r.orders).padStart(7)}${String(r.closed).padStart(8)}` +
    `${r.winRate.toFixed(1).padStart(7)}${r.avgReturnPct.toFixed(2).padStart(9)}` +
    `${r.netPnl.toFixed(0).padStart(9)}${r.finalEquity.toFixed(0).padStart(10)}` +
    `${r.maxDrawdownPct.toFixed(1).padStart(8)}${r.tradesPerWeek.toFixed(1).padStart(5)}${r.avgHoldDays.toFixed(1).padStart(6)}`,
  );
}

for (const r of reports) {
  const risk = Object.entries(r.riskReasons).sort((a, b) => b[1] - a[1]).slice(0, 4);
  const exits = Object.entries(r.exitReasons).sort((a, b) => b[1] - a[1]);
  console.log(`\n${r.key}: ${r.label}`);
  console.log(
    `  funnel: ${r.buys} BUY decisions -> ${r.belowConf} below conf floor, ` +
    `${r.saneFail} insane R:R, ${r.dup} dup, ${r.alreadyHeld} already held, ` +
    `${r.riskReject} risk-rejected, ${r.orders} filled`,
  );
  console.log(`  risk rejections: ${JSON.stringify(Object.fromEntries(risk))}`);
  console.log(`  exit reasons:    ${JSON.stringify(Object.fromEntries(exits))} | open at end: ${r.openLeft}`);
  console.log(
    `  money: gross ${r.grossPnl.toFixed(0)} (avg ${r.grossAvgPct.toFixed(2)}%/trade) ` +
    `- fees ${r.fees.toFixed(0)} = net ${r.netPnl.toFixed(0)} (avg ${r.avgReturnPct.toFixed(2)}%/trade)`,
  );
}

const outPath = `${process.env.TMPDIR ?? '/tmp'}/crypto-backtest.json`;
const { writeFileSync } = await import('node:fs');
writeFileSync(outPath, JSON.stringify({ window: [dates[0], dates[dates.length - 1]], benchReturnPct, reports }, null, 2));
console.log(`\nfull report -> ${outPath}`);
db.close();