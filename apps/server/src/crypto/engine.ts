/**
 * Crypto decision pipeline (no LLM anywhere in the hot path):
 *
 *   price stream -> features -> short-term strategy -> fusion -> risk
 *   -> signals -> spot paper orders
 *
 * Same shape as the TradingUSA engine, three crypto-specific differences:
 *  - benchmark and regime come from BTC (there is no SPY here);
 *  - macro/event/sentiment parts are 0 in v1 (no news or rates pipeline for
 *    crypto yet) — fusion still runs, so when those sources arrive the weights
 *    are already in place;
 *  - learned fusion weights are read from the CRYPTO book's own
 *    strategy_weights (adaptive.ts), so crypto outcomes tune crypto fusion and
 *    never the equities book's.
 */
import type { DatabaseSync } from 'node:sqlite';
import { detectRegime, etDate, evaluateEntry, fuse, shortTermScore } from '@promptslim/tucore';
import type { Quote, Regime, ScoreParts, SignalAction } from '@promptslim/tucore';
import { learnedWeights } from '../tradingusa/adaptive.ts';
import type { CryptoConfig } from './config.ts';
import { CRYPTO_BENCHMARK, CRYPTO_PORTFOLIO, latestQuote, loadBars, upsertBar, upsertQuote } from './broker.ts';
import type { CryptoMarketDataProvider } from './providers/types.ts';

export const CRYPTO_STRATEGY = 'crypto_momentum_v1';

/** Regimes that would block a long entry in equities — recorded for crypto
 *  but NOT gating in v1 (see broker header: no regime table for crypto). */
const ADVERSE_REGIMES = new Set<Regime>(['BEAR_TREND', 'RISK_OFF', 'LIQUIDITY_STRESS', 'HIGH_VOLATILITY', 'UNCERTAIN']);

export function activeSymbols(db: DatabaseSync): string[] {
  const rows = db
    .prepare('SELECT symbol FROM crypto_universe WHERE active = 1 ORDER BY pinned DESC, last_rank')
    .all() as unknown as Array<{ symbol: string }>;
  return rows.map((r) => r.symbol);
}

/** Store live quotes; previous close comes from the last daily bar so the UI
 *  shows a real change%, not the placeholder the ticker provider sends. */
export function ingestTick(db: DatabaseSync, quotes: Quote[], now = Date.now()): number {
  let stored = 0;
  for (const q of quotes) {
    if (!Number.isFinite(q.price) || q.price <= 0) continue;
    const bars = loadBars(db, q.symbol, 2);
    const prevClose = bars.length >= 2 ? bars[bars.length - 2].close : q.prevClose;
    upsertQuote(db, { ...q, prevClose: prevClose > 0 ? prevClose : q.price });
    stored += 1;
    db.prepare(
      `INSERT INTO market_features (ticker, date, features_json, computed_at) VALUES (?,?,?,?)
       ON CONFLICT(ticker, date) DO UPDATE SET features_json = excluded.features_json, computed_at = excluded.computed_at`,
    ).run(q.symbol, etDate(now), JSON.stringify({
      price: q.price,
      prevClose,
      changePct: prevClose > 0 ? ((q.price - prevClose) / prevClose) * 100 : 0,
      quoteTs: q.ts,
    }), now);
  }
  return stored;
}

/** Pull bars for every active symbol (and BTC) and store them. */
export async function refreshBars(
  db: DatabaseSync,
  provider: CryptoMarketDataProvider,
  symbols: string[],
  days = 730,
): Promise<{ fetched: number; failed: number }> {
  let fetched = 0;
  const failed: string[] = [];
  for (const symbol of [...new Set([...symbols, CRYPTO_BENCHMARK])]) {
    try {
      const bars = await provider.getDailyBars(symbol, days);
      if (bars.length === 0) { failed.push(symbol); continue; }
      for (const b of bars) upsertBar(db, symbol, b);
      fetched += 1;
    } catch {
      failed.push(symbol);
    }
  }
  return { fetched, failed: failed.length };
}

/** Regime from BTC bars — the crypto market's own benchmark tape. */
export function computeCryptoRegime(db: DatabaseSync): { regime: Regime; confidence: number } {
  const bars = loadBars(db, CRYPTO_BENCHMARK);
  const detection = detectRegime(bars);
  return { regime: detection.regime, confidence: detection.confidence };
}

function cryptoParts(technical: number, regime: Regime, quote: Quote | null): { parts: ScoreParts; freshness: number } {
  const regimeScore: Record<string, number> = {
    BULL_TREND: 0.5, RISK_ON: 0.5, MOMENTUM: 0.5,
    LOW_VOLATILITY: 0.25, RECOVERY: 0.25, MEAN_REVERSION: 0,
    BEAR_TREND: -0.5, RISK_OFF: -0.5, LIQUIDITY_STRESS: -0.5, HIGH_VOLATILITY: -0.5,
    UNCERTAIN: 0,
  };
  const ageMs = quote ? Date.now() - quote.ts : Number.POSITIVE_INFINITY;
  const freshness = Number.isFinite(ageMs) ? Math.max(0, Math.min(1, 1 - ageMs / (24 * 3600_000))) : 0;
  return {
    parts: {
      technical,
      fundamental: 0, // v1: no fundamentals for crypto
      event: 0,       // v1: no news pipeline for crypto
      sentiment: 0,   // v1: no sentiment source for crypto
      macro: 0,       // v1: no rates/FX source for crypto
      regime: regimeScore[regime] ?? 0,
    },
    freshness,
  };
}

export interface CryptoScanResult {
  scanned: number;
  signalsCreated: number;
  ordersCreated: number;
  skippedDuplicate: number;
  skippedConfidence: number;
  skippedRisk: number;
  skippedLesson: number;
  created: Array<{ id: number; ticker: string; signal: string; confidence: number }>;
}

interface ScanDeps {
  db: DatabaseSync;
  provider: CryptoMarketDataProvider;
  config: CryptoConfig;
  now?: number;
}

/** One scan over the active universe -> signals + spot paper orders. */
export async function runCryptoScan(deps: ScanDeps): Promise<CryptoScanResult> {
  const { db, provider, config } = deps;
  const now = deps.now ?? Date.now();
  const sessionDate = etDate(now);
  const result: CryptoScanResult = {
    scanned: 0, signalsCreated: 0, ordersCreated: 0, skippedDuplicate: 0,
    skippedConfidence: 0, skippedRisk: 0, skippedLesson: 0, created: [],
  };

  const symbols = activeSymbols(db);
  if (symbols.length === 0) return result;

  const quotes = await provider.getQuotes(symbols);
  if (quotes.length > 0) ingestTick(db, quotes, now);

  const regime = computeCryptoRegime(db);
  const btcBars = loadBars(db, CRYPTO_BENCHMARK);
  const learned = learnedWeights(db, CRYPTO_STRATEGY, 'SHORT');
  // the validated volume lesson, same rule as the equities book
  const volumeLessonActive = db
    .prepare(
      `SELECT 1 FROM knowledge_lessons
        WHERE status = 'VALIDATED' AND confidence >= 0.7
          AND scope_json LIKE '%TECHNICAL_SIGNAL_FAILURE%' LIMIT 1`,
    )
    .get() !== undefined;

  const positions = db
    .prepare('SELECT ticker FROM paper_positions WHERE exit_ts IS NULL')
    .all() as unknown as Array<{ ticker: string }>;
  const held = new Set(positions.map((p) => p.ticker));

  const cash = (db.prepare('SELECT cash FROM paper_portfolios WHERE kind = ?').get(CRYPTO_PORTFOLIO) as { cash: number } | undefined)?.cash ?? config.startCapital;
  const equityRows = db
    .prepare('SELECT equity FROM portfolio_snapshots WHERE portfolio = ? ORDER BY ts DESC LIMIT 2')
    .all(CRYPTO_PORTFOLIO) as unknown as Array<{ equity: number }>;
  const equity = equityRows[0]?.equity ?? cash;
  const drawdownPct = equityRows.length >= 2 && equityRows[1].equity > 0
    ? Math.max(0, (equityRows[1].equity - equity) / equityRows[1].equity) * 100
    : 0;

  for (const symbol of symbols) {
    const bars = loadBars(db, symbol);
    if (bars.length < 60) continue; // not enough history to score
    result.scanned += 1;

    const quote = latestQuote(db, symbol) ?? {
      symbol, price: bars[bars.length - 1].close,
      prevClose: bars[bars.length - 2]?.close ?? bars[bars.length - 1].close,
      ts: Date.parse(`${bars[bars.length - 1].date}T00:00:00Z`),
      provider: provider.name, freshness: 'DELAYED' as const,
    };

    // strategy: the shared short-term factor model, benchmarked against BTC
    const st = shortTermScore({
      ticker: symbol, company: symbol, candles: bars, benchmarkCandles: btcBars,
      quote, regime: regime.regime, sectorCandles: undefined, events: [], sessionDate,
    });
    if (st.action === 'INSUFFICIENT_DATA') continue;

    // Exit geometry (CRYPTO_TARGET_MODE=atr3): aim past the next resistance at
    // price + 3*ATR14. S/R targets routinely sit inside the 1.5R minimum and
    // were thrown away by the sane-RR gate — measured 714 -> 97 rejections and
    // net +$3.9k vs -$2.3k over 602d (scripts/crypto-backtest.mts).
    if (config.targetMode === 'atr3') {
      const atr14 = Number(st.factors.atr ?? 0);
      if (atr14 > 0 && quote.price + 3 * atr14 > st.target) {
        st.target = quote.price + 3 * atr14;
      }
    }

    const { parts, freshness } = cryptoParts(st.score, regime.regime, quote);
    const fused = fuse({
      parts, horizon: 'SHORT', strategy: CRYPTO_STRATEGY,
      // static crypto weights first (CRYPTO_FUSION_WEIGHTS), fitted weights
      // from this book's own outcomes win once they are sufficient
      ...(config.fusionWeights ? { weights: config.fusionWeights } : {}),
      ...(learned.weights ? { weights: learned.weights } : {}),
      confidenceHint: st.confidence, evidence: st.evidence, contradictions: st.contradictions,
    });
    const action: SignalAction = fused.action;
    if (action !== 'BUY' && action !== 'SELL') continue;
    if (action === 'BUY' && fused.confidence < config.minSignalConfidence) {
      result.skippedConfidence += 1;
      continue;
    }

    const relVol = Number(st.factors.relativeVolume ?? 0);
    if (action === 'BUY' && volumeLessonActive && relVol < 1.15) {
      result.skippedLesson += 1;
      continue;
    }

    // idempotency: one signal per (symbol, strategy, horizon, session, action)
    const dup = db
      .prepare('SELECT id FROM signals WHERE ticker = ? AND strategy = ? AND horizon = ? AND session_date = ? AND signal = ?')
      .get(symbol, CRYPTO_STRATEGY, 'SHORT', sessionDate, action);
    if (dup) { result.skippedDuplicate += 1; continue; }

    const stopDist = Math.max(0.0001, quote.price - st.invalidation);
    const rr = (st.target - quote.price) / stopDist;
    const sane = action === 'SELL'
      ? true
      : stopDist >= quote.price * 0.005 && rr >= config.minRiskReward && rr <= 20 && st.target > quote.price;
    if (!sane) { result.skippedDuplicate += 1; continue; }

    const liquidityScore = liquidityOf(symbol, bars);
    const volPct = volatilityOf(bars);
    const risk = evaluateEntry(
      { equity, cash, openPositions: [], currentDrawdownPct: drawdownPct },
      { ticker: symbol, sector: 'Crypto', price: quote.price, entryLow: st.entryLow,
        invalidation: st.invalidation, target: st.target, confidence: fused.confidence, horizon: 'SHORT' },
      { riskPerTradePct: config.riskPerTradePct, maxPositionPct: config.maxPositionPct,
        maxCorrelatedPct: 1, maxSectorPct: 1, minRiskReward: config.minRiskReward, maxEarningsDays: 3 },
      { liquidityScore, volatilityPct: volPct, regime: regime.regime,
        dataQuality: { stale: freshness < 0.05, disagreement: false, missing: false },
        killSwitchActive: false, earningsWithinDays: 9999 },
    );

    const expectedReturn = (st.target - quote.price) / quote.price;
    const signalId = insertCryptoSignal(db, {
      symbol, action, confidence: fused.confidence, price: quote.price,
      entryLow: st.entryLow, entryHigh: st.entryHigh, target: st.target,
      invalidation: st.invalidation, expectedReturn, riskReward: rr,
      expectedHold: st.expectedHoldSessions, maxHold: st.maxHoldSessions,
      sessionDate, createdAt: now, regime: regime.regime, regimeConfidence: regime.confidence,
      evidence: st.evidence, contradictions: st.contradictions,
      scores: { ...parts, risk: 0 }, freshness,
      audit: {
        generatedAt: now,
        inputs: { barsAsOf: bars[bars.length - 1].date, quoteTs: quote.ts, regime: regime.regime },
        conflicts: fused.conflicts, weighted: fused.weighted,
        entryChecks: { relativeVolume: relVol },
        learnedWeights: learned.sufficient,
        pipeline: ['price_stream', 'features', 'strategy', 'fusion', 'risk', 'signal'],
      },
    });
    result.signalsCreated += 1;
    result.created.push({ id: signalId, ticker: symbol, signal: action, confidence: fused.confidence });

    if (action === 'BUY' && risk.approved && !held.has(symbol) && risk.sizeShares > 0) {
      db.prepare(
        `INSERT INTO paper_orders (portfolio, signal_id, ticker, side, qty, limit_price, stop_price, status, fill_mode, created_at)
         VALUES (?,?,?,?,?,?,?,'PENDING',?,?)`,
      ).run(CRYPTO_PORTFOLIO, signalId, symbol, 'BUY', risk.sizeShares, st.entryHigh, st.invalidation, config.fillMode, now);
      result.ordersCreated += 1;
    } else if (action === 'SELL' && held.has(symbol)) {
      const pos = db.prepare('SELECT qty FROM paper_positions WHERE ticker = ? AND exit_ts IS NULL').get(symbol) as { qty: number } | undefined;
      if (pos) {
        db.prepare(
          `INSERT INTO paper_orders (portfolio, signal_id, ticker, side, qty, limit_price, stop_price, status, fill_mode, created_at)
           VALUES (?,?,?,?,?,?,NULL,'PENDING',?,?)`,
        ).run(CRYPTO_PORTFOLIO, signalId, symbol, 'SELL', pos.qty, st.entryLow, config.fillMode, now);
        result.ordersCreated += 1;
      }
    }
  }

  db.prepare(`INSERT INTO audit_log (ts, action, entity, entity_id, detail_json) VALUES (?, 'scan', 'system', ?, ?)`)
    .run(now, 'crypto', JSON.stringify({
      scanned: result.scanned, signals: result.signalsCreated, orders: result.ordersCreated,
      skippedConfidence: result.skippedConfidence, skippedLesson: result.skippedLesson,
      skippedDuplicate: result.skippedDuplicate,
    }));

  return result;
}

function liquidityOf(symbol: string, bars: Array<{ volume: number; close: number }>): number {
  const recent = bars.slice(-30);
  if (recent.length < 5) return 0.3;
  const avgVol = recent.reduce((s, b) => s + b.volume, 0) / recent.length;
  const avgPrice = recent.reduce((s, b) => s + b.close, 0) / recent.length;
  const notional = avgVol * avgPrice;
  void symbol;
  return Math.max(0.05, Math.min(1, Math.log10(Math.max(1, notional)) / 3));
}

function volatilityOf(bars: Array<{ close: number }>): number {
  const rets: number[] = [];
  for (let i = 1; i < bars.length; i++) rets.push(Math.log(bars[i].close / bars[i - 1].close));
  if (rets.length < 2) return 0.03;
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length;
  return Math.sqrt(variance);
}

function insertCryptoSignal(
  db: DatabaseSync,
  s: {
    symbol: string; action: SignalAction; confidence: number; price: number;
    entryLow: number; entryHigh: number; target: number; invalidation: number;
    expectedReturn: number; riskReward: number; expectedHold: number; maxHold: number;
    sessionDate: string; createdAt: number; regime: Regime; regimeConfidence: number;
    evidence: unknown; contradictions: unknown; scores: ScoreParts & { risk: number };
    freshness: number; audit: unknown;
  },
): number {
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
      s.symbol, s.symbol, 'Crypto', CRYPTO_PORTFOLIO, CRYPTO_STRATEGY, '1.0.0', 'crypto_v1',
      'SHORT', s.action, s.confidence, s.price, s.entryLow, s.entryHigh, s.target, s.invalidation,
      s.expectedReturn, s.riskReward, s.expectedHold, s.maxHold, 'MARKET_OPEN', s.sessionDate,
      s.createdAt, s.regime, JSON.stringify(s.evidence), JSON.stringify(s.contradictions),
      JSON.stringify(s.scores), s.freshness, '[]', JSON.stringify(s.audit), '[]', '[]', null,
    );
  const id = Number(res.lastInsertRowid);
  db.prepare('INSERT INTO signal_status (signal_id, status, updated_at) VALUES (?, ?, ?)')
    .run(id, 'ACTIVE', s.createdAt);
  return id;
}

export const CRYPTO_ADVERSE_REGIMES = ADVERSE_REGIMES;
