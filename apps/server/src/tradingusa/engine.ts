/**
 * The TradingUSA decision pipeline (NO LLM anywhere in this file's hot path):
 *
 *   market stream -> normalizer -> features -> strategies -> fusion -> risk
 *   -> signals -> paper orders
 *
 * LLM reasoning is invoked only AFTER a candidate signal exists, only when
 * the LLMValueRouter approves it, and only through InferenceRouter.reason().
 * `ingestTick()` is the hot path for live quotes and must never grow an LLM
 * dependency — a test asserts exactly that.
 */
import type { DatabaseSync } from 'node:sqlite';
import {
  atr, computeBudget, countTradingDays, detectRegime, detectBreakout, fuse,
  evaluateEntry, etDate,
  maCross, relativeStrength, relativeVolume, sessionKindAt,
  shortTermScore, longTermScore, sma, rsi,
} from '@promptslim/tucore';
import type {
  Candle, Quote, Regime, ScoreParts, SignalAction, StrategyEvent,
} from '@promptslim/tucore';
// (Candle also used as a value-type annotation in backfillBars)
import type { MarketDataProvider } from './providers/yahoo.ts';
import { learnedWeights } from './adaptive.ts';
import type { TuConfig } from './config.ts';
import { universeEntry, tradableUniverse, BENCHMARKS, SECTOR_ETFS } from './universe.ts';

/* ------------------------------------------------------------------ */
/* bar loading                                                         */
/* ------------------------------------------------------------------ */

export function loadBars(db: DatabaseSync, ticker: string, limit?: number): Candle[] {
  const sql = limit
    ? 'SELECT date, open, high, low, close, volume FROM market_bars WHERE ticker = ? ORDER BY date DESC LIMIT ?'
    : 'SELECT date, open, high, low, close, volume FROM market_bars WHERE ticker = ? ORDER BY date';
  const rows = (limit
    ? db.prepare(sql).all(ticker, limit)
    : db.prepare(sql).all(ticker)) as unknown as Array<Candle>;
  return limit ? rows.reverse() : rows;
}

export function latestQuote(db: DatabaseSync, symbol: string): Quote | null {
  const row = db
    .prepare('SELECT symbol, price, prev_close, ts, provider, freshness FROM market_quotes WHERE symbol = ?')
    .get(symbol) as { symbol: string; price: number; prev_close: number; ts: number; provider: string; freshness: string } | undefined;
  if (!row) return null;
  return {
    symbol: row.symbol, price: row.price, prevClose: row.prev_close, ts: row.ts,
    provider: row.provider, freshness: row.freshness as Quote['freshness'],
  };
}

export function upsertQuote(db: DatabaseSync, q: Quote): void {
  db.prepare(
    `INSERT INTO market_quotes (symbol, price, prev_close, ts, provider, freshness)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(symbol) DO UPDATE SET price=excluded.price, prev_close=excluded.prev_close,
       ts=excluded.ts, provider=excluded.provider, freshness=excluded.freshness`,
  ).run(q.symbol, q.price, q.prevClose, q.ts, q.provider ?? 'yahoo', q.freshness ?? 'DELAYED');
}

export interface BarSource {
  name: string;
  getDailyBars(ticker: string, range?: string): Promise<Candle[]>;
}

export async function backfillBars(
  db: DatabaseSync,
  provider: MarketDataProvider,
  tickers: string[],
  range = '2y',
  delayMs = 1500,
  fallback?: BarSource,
  opts: { refresh?: boolean } = {},
): Promise<{ fetched: number; failed: number; missing: string[] }> {
  let fetched = 0;
  const failed: string[] = [];
  const now = Date.now();
  const stmt = db.prepare(
    `INSERT INTO market_bars (ticker, date, open, high, low, close, volume, provider, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(ticker, date) DO UPDATE SET open=excluded.open, high=excluded.high,
       low=excluded.low, close=excluded.close, volume=excluded.volume, fetched_at=excluded.fetched_at`,
  );
  const have = new Set(
    (db.prepare('SELECT DISTINCT ticker FROM market_bars').all() as unknown as Array<{ ticker: string }>)
      .map((r) => r.ticker),
  );
  for (const ticker of tickers) {
    // `refresh` re-fetches tickers that already have history — without it the
    // first successful backfill freezes daily bars at the boot date forever
    // (the scheduler only calls this when a ticker is missing entirely).
    if (!opts.refresh && have.has(ticker)) continue;
    if (provider.status() === 'RATE_LIMITED' && !fallback) {
      // no fallback source: wait out the provider's cooldown politely.
      // With a fallback we attempt (the provider short-circuits during its
      // own cooldown without touching the network) and route to it instead.
      await new Promise((r) => setTimeout(r, 45_000));
    }
    let bars: Candle[] = [];
    let sourceName = provider.name;
    try {
      bars = await provider.getDailyBars(ticker, range);
    } catch {
      bars = [];
    }
    if (bars.length === 0 && provider.status() === 'RATE_LIMITED') {
      // do not burn retries while the primary is cooling down — go straight
      // to the fallback source for this ticker
      bars = [];
    } else if (bars.length === 0) {
      // one patient retry before consulting the fallback
      await new Promise((r) => setTimeout(r, 5_000));
      try {
        bars = await provider.getDailyBars(ticker, range);
      } catch {
        bars = [];
      }
    }
    if (bars.length === 0 && fallback) {
      try {
        bars = await fallback.getDailyBars(ticker, range);
        if (bars.length > 0) sourceName = fallback.name;
      } catch {
        bars = [];
      }
    }
    if (bars.length === 0) {
      failed.push(ticker);
    } else {
      for (const b of bars) stmt.run(ticker, b.date, b.open, b.high, b.low, b.close, b.volume, sourceName, now);
      fetched += 1;
    }
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }
  return { fetched, failed: failed.length, missing: failed };
}

/* ------------------------------------------------------------------ */
/* regime                                                              */
/* ------------------------------------------------------------------ */

export function computeRegime(db: DatabaseSync): { regime: Regime; confidence: number; components: Record<string, number> } {
  const spy = loadBars(db, 'SPY');
  const adv = db.prepare(`SELECT COUNT(*) AS n FROM market_quotes WHERE price > prev_close`).get() as { n: number };
  const dec = db.prepare(`SELECT COUNT(*) AS n FROM market_quotes WHERE price <= prev_close`).get() as { n: number };
  const result = detectRegime(spy, { breadth: { advancers: adv.n, decliners: dec.n } });
  const date = etDate(Date.now());
  try {
    db.prepare(
      `INSERT INTO market_regimes (date, regime, confidence, components_json) VALUES (?, ?, ?, ?)
       ON CONFLICT(date) DO UPDATE SET regime=excluded.regime, confidence=excluded.confidence, components_json=excluded.components_json`,
    ).run(date, result.regime, result.confidence, JSON.stringify(result.components));
  } catch {
    /* regime persistence is best-effort */
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* hot path: quotes -> features (deliberately LLM-free)                */
/* ------------------------------------------------------------------ */

export interface TickResult {
  stored: number;
  featuresUpdated: number;
}

/**
 * Normalize a live quote batch into storage + feature rows. This is the
 * WebSocket/-stream equivalent in the REST provider: it processes market
 * data locally and NEVER calls the InferenceRouter (enforced by test).
 */
export function ingestTick(db: DatabaseSync, quotes: Quote[], now = Date.now()): TickResult {
  let stored = 0;
  let featuresUpdated = 0;
  for (const q of quotes) {
    upsertQuote(db, q);
    stored += 1;
  }
  // incremental daily feature row for the session
  const date = etDate(now);
  for (const q of quotes) {
    const entry = db.prepare('SELECT 1 FROM market_bars WHERE ticker = ? AND date = ?').get(q.symbol, date);
    const prev = db.prepare('SELECT close FROM market_bars WHERE ticker = ? ORDER BY date DESC LIMIT 1').get(q.symbol) as { close: number } | undefined;
    const features = {
      price: q.price,
      prevClose: q.prevClose,
      changePct: q.prevClose > 0 ? (q.price - q.prevClose) / q.prevClose : 0,
      intradayReturn: prev && prev.close > 0 ? (q.price - prev.close) / prev.close : 0,
      quoteTs: q.ts,
      barExistsToday: Boolean(entry),
    };
    db.prepare(
      `INSERT INTO market_features (ticker, date, features_json, computed_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(ticker, date) DO UPDATE SET features_json=excluded.features_json, computed_at=excluded.computed_at`,
    ).run(q.symbol, date, JSON.stringify(features), now);
    featuresUpdated += 1;
  }
  return { stored, featuresUpdated };
}

/* ------------------------------------------------------------------ */
/* feature / score parts                                               */
/* ------------------------------------------------------------------ */

function recentEvents(db: DatabaseSync, ticker: string, days: number): Array<{ type: string; sentiment: number; materiality: number; headline: string; id: number; first_seen: number }> {
  const since = Date.now() - days * 86400_000;
  return db
    .prepare('SELECT id, type, sentiment, materiality, headline, first_seen FROM events WHERE (ticker = ? OR ticker IS NULL) AND first_seen >= ? ORDER BY materiality DESC')
    .all(ticker, since) as unknown as Array<{ type: string; sentiment: number; materiality: number; headline: string; id: number; first_seen: number }>;
}

function macroParts(db: DatabaseSync): number {
  const latest = (series: string): number | null => {
    const row = db.prepare('SELECT value FROM economic_data WHERE series = ? ORDER BY date DESC LIMIT 1').get(series) as
      | { value: number }
      | undefined;
    return row ? row.value : null;
  };
  const y2 = latest('treasury_y2');
  const y10 = latest('treasury_y10');
  const vixValue = latest('vix');
  const vix = vixValue != null ? { value: vixValue } : undefined;
  let score = 0;
  if (y2 != null && y10 != null) {
    const spread = y10 - y2;
    if (spread < 0) score -= 0.4;
    else if (spread < 0.25) score -= 0.15;
    else if (spread > 0.8) score += 0.15;
  }
  if (vix) {
    if (vix.value >= 28) score -= 0.5;
    else if (vix.value >= 20) score -= 0.2;
    else if (vix.value <= 14) score += 0.2;
  }
  return Math.max(-1, Math.min(1, score));
}

function regimePart(regime: Regime): number {
  if (regime === 'BULL_TREND' || regime === 'RISK_ON' || regime === 'MOMENTUM') return 0.5;
  if (regime === 'RECOVERY' || regime === 'LOW_VOLATILITY') return 0.25;
  if (regime === 'BEAR_TREND' || regime === 'RISK_OFF' || regime === 'LIQUIDITY_STRESS' || regime === 'HIGH_VOLATILITY') return -0.5;
  if (regime === 'MEAN_REVERSION') return 0;
  return 0; // UNCERTAIN
}

export interface TickerParts {
  parts: ScoreParts;
  freshness: number;
  sectorEvents: StrategyEvent[];
}

export function computeParts(db: DatabaseSync, ticker: string, technicalScore: number, fundamentalScore: number, regime: Regime, quote: Quote | null): TickerParts {
  const events = recentEvents(db, ticker, 7);
  const material = events.filter((e) => e.materiality >= 0.6);
  const eventPart = material.length > 0
    ? Math.max(-1, Math.min(1, material.reduce((s, e) => s + e.sentiment * e.materiality, 0) / Math.max(1, material.length) * 1.5))
    : 0;
  const sentimentPart = events.length > 0
    ? Math.max(-1, Math.min(1, events.reduce((s, e, i) => s + e.sentiment * Math.max(0.2, e.materiality) / (1 + i * 0.15), 0) / events.length * 1.4))
    : 0;
  const ageMs = quote ? Date.now() - quote.ts : Number.POSITIVE_INFINITY;
  const freshness = Number.isFinite(ageMs) ? Math.max(0, Math.min(1, 1 - ageMs / (24 * 3600_000))) : 0;
  return {
    parts: {
      technical: technicalScore,
      fundamental: fundamentalScore,
      event: eventPart,
      sentiment: sentimentPart,
      macro: macroParts(db),
      regime: regimePart(regime),
    },
    freshness,
    sectorEvents: events.map((e) => ({ type: e.type, sentiment: e.sentiment, materiality: e.materiality, ageDays: (Date.now() - e.first_seen) / 86400_000 } as StrategyEvent)),
  };
}

/** fundamental composite in [-1,1] from the long-term strategy sub-scores */
export function fundamentalComposite(factors: Record<string, number>): number {
  const q = factors.qualityScore ?? 0.5;
  const g = factors.growthScore ?? 0.5;
  const v = factors.valuationScore ?? 0.5;
  const r = factors.financialRiskScore ?? 0.5;
  const composite = 0.3 * q + 0.25 * g + 0.25 * v + 0.2 * r;
  return Math.max(-1, Math.min(1, (composite - 0.5) * 2));
}

export function coreQuoteSymbols(db: DatabaseSync): string[] {
  const set = new Set<string>([...BENCHMARKS]);
  const pos = db.prepare('SELECT DISTINCT ticker FROM paper_positions WHERE exit_ts IS NULL').all() as unknown as Array<{ ticker: string }>;
  for (const p of pos) set.add(p.ticker);
  const sigs = db.prepare(
    `SELECT DISTINCT s.ticker FROM signals s
       LEFT JOIN signal_status st ON st.signal_id = s.id
      WHERE COALESCE(st.status, 'ACTIVE') = 'ACTIVE' ORDER BY s.created_at DESC LIMIT 20`,
  ).all() as unknown as Array<{ ticker: string }>;
  for (const s of sigs) set.add(s.ticker);
  return [...set].slice(0, 30);
}

/* ------------------------------------------------------------------ */
/* scan: strategies -> fusion -> risk -> signals -> orders             */
/* ------------------------------------------------------------------ */

export interface ScanDeps {
  db: DatabaseSync;
  provider: MarketDataProvider;
  config: TuConfig;
  now?: number;
}

export interface CreatedSignal {
  id: number;
  ticker: string;
  portfolio: string;
  signal: string;
  confidence: number;
  riskApproved: boolean;
}

export interface ScanResult {
  session: string;
  scanned: number;
  signalsCreated: number;
  ordersCreated: number;
  skippedDuplicate: number;
  /** BUY dropped by the market-regime gate (RISK_OFF/BEAR/etc.). */
  skippedRegime: number;
  /** BUY dropped by the min fused-confidence floor. */
  skippedLowConfidence: number;
  /** BUY dropped by a VALIDATED learning lesson (volume confirmation). */
  skippedLesson: number;
  created: CreatedSignal[];
  llmSkipped: number;
}

/** Market regimes in which new LONG entries are refused outright. UNCERTAIN
 *  is included: the ops contract already treats it as a no-new-entries state.
 *  Verified against production: 82 of 174 recent signals fired under RISK_OFF
 *  and were stopped out — this gate is the direct fix. */
export const ADVERSE_LONG_REGIMES: Regime[] = [
  'BEAR_TREND', 'RISK_OFF', 'LIQUIDITY_STRESS', 'HIGH_VOLATILITY', 'UNCERTAIN',
];

export interface EntryGateDecision {
  allowed: boolean;
  kind: 'regime' | 'confidence' | null;
  reason: string | null;
}

/** Regime check runs BEFORE the confidence check so counters attribute the
 *  dominant cause (a weak signal in a bad market is a market problem).
 *  SELLs are exits on a long-only book — never gated here. */
export function entryGate(
  action: SignalAction,
  regime: Regime,
  confidence: number,
  minConfidence: number,
): EntryGateDecision {
  if (action !== 'BUY') return { allowed: true, kind: null, reason: null };
  if (ADVERSE_LONG_REGIMES.includes(regime)) {
    return { allowed: false, kind: 'regime', reason: `adverse market regime ${regime}` };
  }
  if (confidence < minConfidence) {
    return {
      allowed: false,
      kind: 'confidence',
      reason: `fused confidence ${confidence.toFixed(2)} below floor ${minConfidence}`,
    };
  }
  return { allowed: true, kind: null, reason: null };
}

/** True while a STOP_REACHED exit on this ticker is within the cooldown
 *  window (inclusive of both endpoints: a stop today => 1 session). */
export function reentryCooldownActive(
  db: DatabaseSync,
  ticker: string,
  now: number,
  sessions: number,
): boolean {
  if (sessions <= 0) return false;
  const row = db
    .prepare(`SELECT MAX(exit_ts) AS t FROM paper_trades WHERE ticker = ? AND exit_reason = 'STOP_REACHED'`)
    .get(ticker) as { t: number | null } | undefined;
  if (!row?.t) return false;
  const from = etDate(row.t);
  const to = etDate(now);
  if (from >= to) return true; // stopped out today or in the same session
  return countTradingDays(from, to) <= sessions;
}

/** Sessions until the ticker's next earnings report; 9999 when unknown
 *  (behaves exactly like the old hardcoded value). */
export function earningsWithinDaysFor(db: DatabaseSync, ticker: string, now: number): number {
  const row = db
    .prepare('SELECT next_earnings_date FROM earnings_calendar WHERE ticker = ?')
    .get(ticker) as { next_earnings_date: string } | undefined;
  const to = row?.next_earnings_date;
  if (!to) return 9999;
  const today = etDate(now);
  // Anything that is not a strict ISO date, is in the past (stale row), or is
  // the '9999-12-31' "unknown" sentinel written by the earnings job must read
  // as unknown — NEVER as a countable span: tradingDaysBetween('2026…',
  // '9999-12-31') iterates ~2.9M days and OOMs the process (production
  // incident: crash-loop + edge 401s). The year bound keeps any corrupt
  // far-future value from spinning the calendar loop.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(to)) return 9999;
  if (to < today) return 9999;
  if (Number(to.slice(0, 4)) > Number(today.slice(0, 4)) + 1) return 9999;
  return countTradingDays(today, to);
}

interface SignalInsertInput {
  ticker: string; company: string; sector: string; portfolio: string;
  strategy: string; strategyVersion: string; modelVersion: string;
  horizon: string; signal: string; confidence: number; price: number;
  entryLow: number; entryHigh: number; target: number; invalidation: number;
  expectedReturn: number; riskReward: number; expectedHold: number; maxHold: number;
  session: string; sessionDate: string; createdAt: number; regime: string;
  evidence: unknown; contradictions: unknown; scores: unknown; dataFreshness: number;
  riskChecks: unknown; audit: unknown; knowledgeRefs: unknown; eventRefs: unknown;
  llm: unknown;
}

function insertSignal(db: DatabaseSync, s: SignalInsertInput): number {
  const res = db
    .prepare(
      `INSERT INTO signals (ticker, company, sector, portfolio, strategy, strategy_version, model_version,
        horizon, signal, confidence, price, entry_low, entry_high, target, invalidation, expected_return,
        risk_reward, expected_hold, max_hold, session, session_date, created_at, regime, evidence_json,
        contradictions_json, scores_json, data_freshness, risk_checks_json, audit_json, knowledge_refs_json,
        event_refs_json, llm_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      s.ticker, s.company, s.sector, s.portfolio, s.strategy, s.strategyVersion, s.modelVersion,
      s.horizon, s.signal, s.confidence, s.price, s.entryLow, s.entryHigh, s.target, s.invalidation,
      s.expectedReturn, s.riskReward, s.expectedHold, s.maxHold, s.session, s.sessionDate, s.createdAt,
      s.regime, JSON.stringify(s.evidence), JSON.stringify(s.contradictions), JSON.stringify(s.scores),
      s.dataFreshness, JSON.stringify(s.riskChecks), JSON.stringify(s.audit), JSON.stringify(s.knowledgeRefs),
      JSON.stringify(s.eventRefs), s.llm == null ? null : JSON.stringify(s.llm),
    );
  const id = Number(res.lastInsertRowid);
  db.prepare('INSERT INTO signal_status (signal_id, status, updated_at) VALUES (?, ?, ?)').run(id, 'ACTIVE', s.createdAt);
  return id;
}

interface PortfolioState {
  equity: number;
  cash: number;
  positions: Array<{ ticker: string; sector: string; notional: number; entryPrice: number; currentPrice: number; qty: number }>;
  drawdown: number;
}

export function portfolioState(db: DatabaseSync, kind: string): PortfolioState {
  const pf = db.prepare('SELECT kind, start_capital, cash FROM paper_portfolios WHERE kind = ?').get(kind) as
    | { kind: string; start_capital: number; cash: number }
    | undefined;
  const rows = db
    .prepare('SELECT ticker, sector, qty, entry_price, current_price FROM paper_positions WHERE portfolio = ? AND exit_ts IS NULL')
    .all(kind) as unknown as Array<{ ticker: string; sector: string; qty: number; entry_price: number; current_price: number | null }>;
  const positions = rows.map((r) => ({
    ticker: r.ticker,
    sector: r.sector,
    qty: r.qty,
    entryPrice: r.entry_price,
    currentPrice: r.current_price ?? r.entry_price,
    notional: r.qty * (r.current_price ?? r.entry_price),
  }));
  const cash = pf?.cash ?? 0;
  const equity = cash + positions.reduce((s, p) => s + p.notional, 0);
  const peak = db.prepare('SELECT MAX(equity) AS peak FROM portfolio_snapshots WHERE portfolio = ?').get(kind) as { peak: number | null };
  const peakEq = Math.max(peak?.peak ?? equity, equity);
  return {
    equity: equity || (pf?.start_capital ?? 100_000),
    cash,
    positions,
    drawdown: peakEq > 0 ? Math.max(0, (peakEq - equity) / peakEq) : 0,
  };
}

export function sectorOf(ticker: string): string {
  return universeEntry(ticker)?.sector ?? 'Unknown';
}

export async function runScan(deps: ScanDeps): Promise<ScanResult> {
  const { db, provider, config } = deps;
  const now = deps.now ?? Date.now();
  const session = sessionKindAt(now);
  const sessionDate = etDate(now);
  const budget = computeBudget({
    session,
    portfolioExposure: 0,
    openCandidates: 0,
    dataFreshness: 1,
    providerHealthy: provider.status() === 'CONNECTED',
    systemLoad: 0,
  });

  const result: ScanResult = {
    session, scanned: 0, signalsCreated: 0, ordersCreated: 0,
    skippedDuplicate: 0, skippedRegime: 0, skippedLowConfidence: 0,
    skippedLesson: 0, created: [], llmSkipped: 0,
  };

  // Learning loop: a VALIDATED lesson for repeated technical-signal failures
  // demands volume confirmation on new entries (lesson text: "require price
  // AND volume confirmation"). Read once per scan; CANDIDATE lessons never
  // gate — that guardrail stays in learning.ts.
  const volumeLessonActive = db
    .prepare(
      `SELECT 1 FROM knowledge_lessons
        WHERE status = 'VALIDATED' AND confidence >= 0.7
          AND scope_json LIKE '%TECHNICAL_SIGNAL_FAILURE%' LIMIT 1`,
    )
    .get() !== undefined;

  // Learned fusion weights (adaptive.ts): re-fit from realized outcomes and
  // only published once MIN_TRADES closed trades back them, so a missing or
  // insufficient row leaves the shipped FUSION_WEIGHTS in force — a single
  // losing trade cannot move the book.
  const learnedShort = learnedWeights(db, 'st_multi_factor_v1', 'SHORT');
  const learnedLong = learnedWeights(db, 'lt_quality_growth_v1', 'LONG');

  // quotes for the core set only (indexes + live paper exposure + signal
  // tickers); everything else is analyzed from its latest daily bar — the
  // provider is DELAYED REST and must not be burst-polled.
  const quotes = await provider.getQuotes(coreQuoteSymbols(db));
  if (quotes.length > 0) ingestTick(db, quotes, now);

  const regimeInfo = computeRegime(db);
  const regime = regimeInfo.regime;
  const macro = macroParts(db);

  const shortPortfolio = db.prepare('SELECT 1 FROM paper_portfolios WHERE kind = ?').get('SHORT_TERM_PORTFOLIO') ? 'SHORT_TERM_PORTFOLIO' : null;
  const longPortfolio = db.prepare('SELECT 1 FROM paper_portfolios WHERE kind = ?').get('LONG_TERM_PORTFOLIO') ? 'LONG_TERM_PORTFOLIO' : null;
  if (!shortPortfolio || !longPortfolio) return result;

  const stState = portfolioState(db, 'SHORT_TERM_PORTFOLIO');
  const ltState = portfolioState(db, 'LONG_TERM_PORTFOLIO');
  void budget;
  void macro;

  for (const entry of tradableUniverse()) {
    const bars = loadBars(db, entry.ticker);
    if (bars.length < 60) continue;
    result.scanned += 1;

    const lastBar = bars[bars.length - 1];
    const quote = latestQuote(db, entry.ticker) ?? {
      symbol: entry.ticker, price: lastBar.close, prevClose: bars[bars.length - 2]?.close ?? lastBar.close,
      // Honest provenance: this price IS the last bar's close, not "now".
      // Stamping ts=now made freshness read 1.0 and sailed through the
      // data-quality gate with day-old data.
      ts: Date.parse(`${lastBar.date}T21:00:00Z`),
      provider: provider.name, freshness: 'DELAYED' as const,
    };
    const benchmarkBars = loadBars(db, 'SPY');
    const sectorEtf = SECTOR_ETFS.find((s) => s.sector === entry.sector)?.ticker;
    const sectorBars = sectorEtf ? loadBars(db, sectorEtf) : undefined;

    const strategyEvents: StrategyEvent[] = recentEvents(db, entry.ticker, 7).map((e) => ({
      type: e.type, sentiment: e.sentiment, materiality: e.materiality,
      ageDays: (now - e.first_seen) / 86400_000,
    }));

    /* ---- short-term strategy ---- */
    const st = shortTermScore({
      ticker: entry.ticker, company: entry.company, candles: bars, benchmarkCandles: benchmarkBars,
      quote, regime, sectorCandles: sectorBars, events: strategyEvents, sessionDate,
    });

    /* ---- long-term strategy ---- */
    const fundRow = db.prepare('SELECT data_json, as_of, source FROM fundamentals WHERE ticker = ?').get(entry.ticker) as
      | { data_json: string; as_of: string; source: string }
      | undefined;
    const fundamentals = fundRow ? (JSON.parse(fundRow.data_json) as never) : null;
    const lt = longTermScore({
      ticker: entry.ticker, company: entry.company, candles: bars,
      fundamentals: fundamentals as never, quote, regime, events: strategyEvents,
    });

    if (st.action === 'INSUFFICIENT_DATA' && lt.action === 'INSUFFICIENT_DATA') continue;

    const { parts, freshness } = computeParts(db, entry.ticker, st.score, fundamentalComposite(lt.factors), regime, quote);

    /* ---- short-term fusion + risk ---- */
    if (st.action !== 'INSUFFICIENT_DATA') {
      const fused = fuse({
        parts, horizon: 'SHORT', strategy: 'st_multi_factor_v1',
        ...(learnedShort.weights ? { weights: learnedShort.weights } : {}),
        confidenceHint: st.confidence, evidence: st.evidence, contradictions: st.contradictions,
      });
      const action: SignalAction = fused.action;
      if (action === 'BUY' || action === 'SELL') {
        const gate = entryGate(action, regime, fused.confidence, config.minSignalConfidence);
        if (!gate.allowed) {
          if (gate.kind === 'regime') result.skippedRegime += 1;
          else result.skippedLowConfidence += 1;
        } else if (
          action === 'BUY' && volumeLessonActive &&
          Number(st.factors.relativeVolume ?? 0) < 1.15
        ) {
          // validated lesson: breakout/technical entries need volume confirmation
          result.skippedLesson += 1;
        } else {
          // Stop widening: move the stop out to stopAtrMultiple x ATR when the
          // target still affords minRiskReward at the wider stop; otherwise the
          // strategy's own level stands (never widen into an R:R violation).
          let invalidation = st.invalidation;
          const atrVal = Number(st.factors.atr ?? 0);
          const stopDist = quote.price - invalidation;
          if (
            atrVal > 0 && config.stopAtrMultiple > 0 &&
            quote.price - config.stopAtrMultiple * atrVal < invalidation &&
            stopDist > 0
          ) {
            const widened = quote.price - config.stopAtrMultiple * atrVal;
            const rrWidened = (st.target - quote.price) / (quote.price - widened);
            if (rrWidened >= config.minRiskReward) invalidation = widened;
          }
          emitSignal({
            db, config, now, session, sessionDate, entry, action,
            confidence: fused.confidence, price: quote.price,
            entryLow: st.entryLow, entryHigh: st.entryHigh, target: st.target, invalidation,
            expectedHold: st.expectedHoldSessions, maxHold: st.maxHoldSessions,
            strategy: 'st_multi_factor_v1', horizon: 'SHORT', portfolio: 'SHORT_TERM_PORTFOLIO',
            evidence: st.evidence, contradictions: st.contradictions,
            scores: { ...parts, risk: 0 }, regime, freshness,
            portfolioStateRef: stState, barsAsOf: lastBar.date, quoteTs: quote.ts,
            regimeConfidence: regimeInfo.confidence, fused, result,
            // the volume lesson's own threshold, captured at entry so the
            // outcome loop can tell a confirmed lesson from a contradicted one
            entryChecks: { relativeVolume: Number(st.factors.relativeVolume ?? 0) },
          });
        }
      }
    }

    /* ---- long-term fusion + risk ---- */
    if (lt.action !== 'INSUFFICIENT_DATA') {
      const fused = fuse({
        parts, horizon: 'LONG', strategy: 'lt_quality_growth_v1',
        ...(learnedLong.weights ? { weights: learnedLong.weights } : {}),
        confidenceHint: lt.confidence, evidence: lt.evidence, contradictions: lt.contradictions,
      });
      const action: SignalAction = fused.action;
      if (action === 'BUY' || action === 'SELL') {
        const gate = entryGate(action, regime, fused.confidence, config.minSignalConfidence);
        if (!gate.allowed) {
          if (gate.kind === 'regime') result.skippedRegime += 1;
          else result.skippedLowConfidence += 1;
        } else {
          emitSignal({
            db, config, now, session, sessionDate, entry, action,
            confidence: fused.confidence, price: quote.price,
            entryLow: lt.entryLow, entryHigh: lt.entryHigh, target: lt.target, invalidation: lt.invalidation,
            expectedHold: lt.expectedHoldSessions, maxHold: lt.maxHoldSessions,
            strategy: 'lt_quality_growth_v1', horizon: 'LONG', portfolio: 'LONG_TERM_PORTFOLIO',
            evidence: lt.evidence, contradictions: lt.contradictions,
            scores: { ...parts, risk: 0 }, regime, freshness,
            portfolioStateRef: ltState, barsAsOf: lastBar.date, quoteTs: quote.ts,
            regimeConfidence: regimeInfo.confidence, fused, result,
          });
        }
      }
    }
  }

  db.prepare(
    `INSERT INTO audit_log (ts, action, entity, entity_id, detail_json) VALUES (?, 'scan', 'system', ?, ?)`,
  ).run(now, session, JSON.stringify({
    scanned: result.scanned, signals: result.signalsCreated, regime,
    skippedRegime: result.skippedRegime, skippedLowConfidence: result.skippedLowConfidence,
    skippedLesson: result.skippedLesson, skippedDuplicate: result.skippedDuplicate,
  }));

  return result;
}

interface EmitArgs {
  db: DatabaseSync; config: TuConfig; now: number; session: string; sessionDate: string;
  entry: { ticker: string; company: string; sector: string }; action: SignalAction;
  confidence: number; price: number; entryLow: number; entryHigh: number; target: number;
  invalidation: number; expectedHold: number; maxHold: number; strategy: string;
  horizon: 'SHORT' | 'LONG'; portfolio: string; evidence: unknown; contradictions: unknown;
  scores: ScoreParts & { risk: number }; regime: Regime; freshness: number;
  portfolioStateRef: PortfolioState; barsAsOf: string; quoteTs: number;
  regimeConfidence: number;
  /** measurable entry-time conditions a validated lesson prescribed (e.g. the
   *  relative volume the volume-confirmation lesson demands); stored in
   *  audit_json so adaptive.learnFromOutcome can score outcomes against them */
  entryChecks?: Record<string, number>;
  fused: { action: SignalAction; confidence: number; conflicts: string[]; weighted: number };
  result: ScanResult;
}

function emitSignal(a: EmitArgs): void {
  const { db, config, entry, action } = a;
  const sessionDate = a.sessionDate;

  // idempotency: one signal per (ticker, strategy, horizon, session date, action)
  const dup = db
    .prepare('SELECT id FROM signals WHERE ticker = ? AND strategy = ? AND horizon = ? AND session_date = ? AND signal = ?')
    .get(entry.ticker, a.strategy, a.horizon, sessionDate, action);
  if (dup) { a.result.skippedDuplicate += 1; return; }

  const stopDistRaw = a.price - a.invalidation;
  const stopDist = Math.max(0.01, stopDistRaw);
  const rr = ((a.target - a.price) / stopDist);
  const expectedReturn = (a.target - a.price) / a.price;

  /* signal-quality gate: an actionable BUY/SELL must carry a sane
   * reward/risk structure — fusion alone can produce levels that make no
   * sense to trade (overhead resistance, degenerate stops). Those never
   * become signal records. */
  if (a.action === 'BUY' || a.action === 'SELL') {
    const saneStop = stopDistRaw >= a.price * 0.005; // stop at least 0.5% away
    const saneRr = rr >= config.minRiskReward && rr <= 20;
    const positiveUpside = a.target > a.price;
    if (a.action === 'BUY' && (!saneStop || !saneRr || !positiveUpside)) {
      a.result.skippedDuplicate += 1;
      return;
    }
  }

  /* ---- risk gate ---- */
  const earningsDays = earningsWithinDaysFor(db, entry.ticker, a.now);
  const cooldown = a.action === 'BUY'
    && reentryCooldownActive(db, entry.ticker, a.now, config.reentryCooldownSessions);
  const nearEarnings = a.action === 'BUY' && earningsDays <= config.maxEarningsDays;
  const risk = evaluateEntry(
    {
      equity: a.portfolioStateRef.equity, cash: a.portfolioStateRef.cash,
      openPositions: a.portfolioStateRef.positions,
      // tucore risk gate expects a PERCENT (25 = 25%)
      currentDrawdownPct: a.portfolioStateRef.drawdown * 100,
    },
    {
      ticker: entry.ticker, sector: entry.sector, price: a.price, entryLow: a.entryLow,
      invalidation: a.invalidation, target: a.target, confidence: a.confidence, horizon: a.horizon,
    },
    {
      riskPerTradePct: config.riskPerTradePct, maxPositionPct: config.maxPositionPct,
      maxCorrelatedPct: config.maxCorrelatedPct, maxSectorPct: config.maxSectorPct,
      minRiskReward: config.minRiskReward, maxEarningsDays: config.maxEarningsDays,
    },
    {
      liquidityScore: liquidityOf(db, entry.ticker),
      volatilityPct: volOf(db, entry.ticker),
      regime: a.regime,
      dataQuality: { stale: a.freshness < 0.05, disagreement: false, missing: false },
      killSwitchActive: false,
      // real calendar value; 9999 when the date is unknown (old behavior)
      earningsWithinDays: earningsDays,
    },
  );

  const riskChecks = [
    { check: 'risk_reward', passed: rr >= config.minRiskReward, detail: `R:R ${rr.toFixed(2)} vs min ${config.minRiskReward}` },
    { check: 'data_quality', passed: a.freshness >= 0.05, detail: `freshness ${a.freshness.toFixed(2)}` },
    { check: 'kill_switch', passed: true, detail: 'no kill-switch condition' },
    { check: 'execution_mode', passed: true, detail: 'PAPER_ONLY' },
    { check: 'position_size', passed: risk.approved, detail: risk.approved ? `${risk.sizeShares} shares, $${risk.riskAmount.toFixed(0)} at risk` : risk.reasons.join('; ') },
    {
      check: 'reentry_cooldown',
      passed: !cooldown,
      detail: cooldown
        ? `STOP_REACHED within the last ${config.reentryCooldownSessions} sessions`
        : `clear (${config.reentryCooldownSessions}-session stop cooldown)`,
    },
    {
      check: 'earnings_window',
      passed: !nearEarnings,
      detail: nearEarnings
        ? `earnings in ${earningsDays} session(s), block window ${config.maxEarningsDays}`
        : earningsDays >= 9999 ? 'earnings date unknown' : `earnings in ${earningsDays} session(s)`,
    },
  ];

  const eventRefs = db
    .prepare('SELECT id, type, ticker FROM events WHERE (ticker = ? OR ticker IS NULL) AND first_seen >= ? ORDER BY materiality DESC LIMIT 5')
    .all(entry.ticker, a.now - 7 * 86400_000) as unknown as Array<{ id: number; type: string; ticker: string }>;

  const signalRow: Omit<SignalInsertInput, 'llm'> & { llm: unknown } = {
    ticker: entry.ticker, company: entry.company, sector: entry.sector, portfolio: a.portfolio,
    strategy: a.strategy, strategyVersion: '1.0.0', modelVersion: a.horizon === 'SHORT' ? 'st_mf_v1' : 'lt_qg_v1',
    horizon: a.horizon, signal: action, confidence: a.fused.confidence, price: a.price,
    entryLow: a.entryLow, entryHigh: a.entryHigh, target: a.target, invalidation: a.invalidation,
    expectedReturn, riskReward: rr, expectedHold: a.expectedHold, maxHold: a.maxHold,
    session: a.session, sessionDate, createdAt: a.now, regime: a.regime,
    evidence: a.evidence, contradictions: a.contradictions, scores: a.scores,
    dataFreshness: a.freshness, riskChecks,
    audit: {
      generatedAt: a.now,
      inputs: { barsAsOf: a.barsAsOf, quoteTs: a.quoteTs, regime: a.regime, regimeConfidence: a.regimeConfidence },
      conflicts: a.fused.conflicts, weighted: a.fused.weighted,
      entryChecks: a.entryChecks ?? {},
      pipeline: ['market_data', 'features', 'strategies', 'fusion', 'risk', 'signal'],
    },
    knowledgeRefs: [], eventRefs, llm: null,
  };
  void signalRow;
  const signalId = insertSignal(db, { ...signalRow, llm: null });

  a.result.signalsCreated += 1;
  a.result.created.push({ id: signalId, ticker: entry.ticker, portfolio: a.portfolio, signal: action, confidence: a.fused.confidence, riskApproved: risk.approved });

  const openPos = db
    .prepare('SELECT id, qty FROM paper_positions WHERE portfolio = ? AND ticker = ? AND exit_ts IS NULL')
    .get(a.portfolio, entry.ticker) as { id: number; qty: number } | undefined;

  // cooldown + earnings window block the ORDER (the signal stays as research
  // evidence with its failed riskChecks visible); neither touches SELLs.
  const orderBlocked = cooldown || nearEarnings;

  if (action === 'BUY' && risk.approved && !orderBlocked) {
    // one live position per (portfolio, ticker)
    if (!openPos && risk.sizeShares > 0) {
      db.prepare(
        `INSERT INTO paper_orders (portfolio, signal_id, ticker, side, qty, limit_price, stop_price, status, fill_mode, created_at)
         VALUES (?, ?, ?, 'BUY', ?, ?, ?, 'PENDING', ?, ?)`,
      ).run(a.portfolio, signalId, entry.ticker, risk.sizeShares, a.entryHigh, a.invalidation, config.fillMode, a.now);
      a.result.ordersCreated += 1;
    }
  } else if (action === 'SELL' && openPos) {
    // long-only book: a SELL reduces/closes the open paper position
    db.prepare(
      `INSERT INTO paper_orders (portfolio, signal_id, ticker, side, qty, limit_price, stop_price, status, fill_mode, created_at)
       VALUES (?, ?, ?, 'SELL', ?, ?, NULL, 'PENDING', ?, ?)`,
    ).run(a.portfolio, signalId, entry.ticker, openPos.qty, a.entryLow, config.fillMode, a.now);
    a.result.ordersCreated += 1;
  }
}

function liquidityOf(db: DatabaseSync, ticker: string): number {
  const bars = loadBars(db, ticker, 30);
  if (bars.length < 5) return 0.3;
  const avgVol = bars.reduce((s, b) => s + b.volume, 0) / bars.length;
  const avgPrice = bars.reduce((s, b) => s + b.close, 0) / bars.length;
  const dollarVolume = avgVol * avgPrice;
  // $50M/day -> 0.2; $1B+/day -> ~1
  return Math.max(0.05, Math.min(1, Math.log10(Math.max(1, dollarVolume / 10_000_000)) / 1.4));
}

function volOf(db: DatabaseSync, ticker: string): number {
  const bars = loadBars(db, ticker, 30);
  if (bars.length < 10) return 0.02;
  const rets: number[] = [];
  for (let i = 1; i < bars.length; i++) rets.push(Math.log(bars[i].close / bars[i - 1].close));
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length;
  return Math.sqrt(variance);
}

/* small helpers used by stock detail endpoint */
export function technicalSnapshot(db: DatabaseSync, ticker: string): Record<string, number | string | null> {
  const bars = loadBars(db, ticker);
  const closes = bars.map((b) => b.close);
  const last = closes[closes.length - 1] ?? null;
  const s20 = sma(closes, 20).at(-1) ?? null;
  const s50 = sma(closes, 50).at(-1) ?? null;
  const s200 = sma(closes, 200).at(-1) ?? null;
  const rsi14 = rsi(closes, 14).at(-1) ?? null;
  const a = atr(bars, 14).at(-1) ?? null;
  const brk = detectBreakout(bars, 20);
  const spy = loadBars(db, 'SPY').map((b) => b.close);
  const rs = relativeStrength(closes, spy, 90).at(-1) ?? null;
  const rv = relativeVolume(bars, 20);
  return {
    last, sma20: s20, sma50: s50, sma200: s200, rsi14,
    atr: a, atrPct: a && last ? a / last : null,
    maCross: maCross(closes), breakout: brk.breakout ? 1 : 0, breakoutDirection: brk.direction ?? 'NONE',
    relStrength90: rs, relVol: rv,
    bars: bars.length,
  };
}
