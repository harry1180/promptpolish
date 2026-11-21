/**
 * Contract-shaped fixtures for the crypto tests.
 *
 * Every payload mirrors server/src/crypto/routes.ts. The backend is built in
 * parallel — these tests must never hit the network, so stubFetch() answers
 * every /api/crypto/* request from the map below (and '{}' for anything
 * unknown, which the pages must survive — see Learning.tsx's null-safe reads).
 */

import { vi } from 'vitest';

export function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const T0 = 1760000000000;

export const STATUS = {
  ok: true,
  executionMode: 'PAPER_ONLY',
  portfolioKind: 'CRYPTO_SPOT',
  session: 'MARKET_OPEN',
  alwaysOpen: true,
  provider: { name: 'kraken', status: 'CONNECTED', lastUpdate: T0, lastLatencyMs: 31, lastError: null },
  stream: { live: true, symbols: 25 },
  universe: {
    members: 25,
    active: 25,
    pinned: ['BTC', 'ETH', 'XRP', 'DOGE', 'XLM', 'SHIB'],
    ranked: ['SOL', 'BNB', 'TRX', 'ZEC'],
    changes: [{ ts: T0, action: 'ADD', symbol: 'SOL' }],
  },
  counts: { quotes: 25, bars: 18_200, signals: 12, openPositions: 3, closedTrades: 5 },
  jobs: [
    { name: 'signal_scan', schedule: 'crypto', last_run: T0, last_status: 'OK', duration_ms: 240, last_error: null, runs: 96 },
  ],
  recentErrors: [],
};

export const OVERVIEW = {
  portfolio: {
    kind: 'CRYPTO_SPOT', startCapital: 100_000, cash: 78_400.55, equity: 101_842.11,
    unrealized: 1_204.3, exposure: 23_441.56, returnPct: 1.84, createdAt: T0,
  },
  benchmark: { symbol: 'BTC', price: 76_661.9, startPrice: 74_120.0, equity: 103_427.55, returnPct: 3.43 },
  stats: {
    closed: 5, wins: 2, winRatePct: 40, netPnl: 412.9, avgReturnPct: 0.82, feesPaid: 38.4, avgHoldSessions: 4.2,
    // Wilson 95% interval for 2/5 — the sample size must travel with the rate
    winRateCiLowPct: 11.8, winRateCiHighPct: 76.9,
  },
  positions: [
    {
      id: 1, ticker: 'BTC', company: 'BTC', qty: 0.15, entryPrice: 74_900, entryTs: T0, entrySession: 'DAY_0',
      currentPrice: 76_661.9, unrealized: 264.29, unrealizedPct: 2.35, stop: 71_000, target: 82_000,
      maxHold: 20, sessionsHeld: 3, mfe: 0.031, mae: -0.004, thesisStatus: 'INTACT',
      predictedReturn: 0.1, entryFee: 28.09, signalId: 12,
    },
  ],
  recentTrades: [
    {
      id: 9, ticker: 'SOL', side: 'LONG', qty: 4, entryPrice: 180, entryTs: T0, exitPrice: 191, exitTs: T0 + 86_400_000,
      exitReason: 'TARGET_REACHED', netPnl: 41.2, grossPnl: 44, returnPct: 5.7, benchmarkReturnPct: 2.1,
      excessReturnPct: 3.6, predictedReturnPct: 8, predictionError: 2.3, holdingSessions: 4,
      strategy: 'crypto_momentum_v1', capital: 720, status: 'CLOSED',
    },
  ],
  snapshotAt: T0,
};

export const QUOTES = {
  count: 2,
  quotes: [
    { symbol: 'BTC', price: 76_661.9, prevClose: 77_114, changePct: -0.59, bid: 76_661.8, ask: 76_661.9, ts: T0, provider: 'kraken-ws', freshness: 'REALTIME', pinned: true, rank: 1, active: true },
    { symbol: 'SOL', price: 191.2, prevClose: 188.4, changePct: 1.49, bid: 191.1, ask: 191.3, ts: T0, provider: 'kraken-ws', freshness: 'REALTIME', pinned: false, rank: 7, active: true },
  ],
};

export const UNIVERSE = {
  members: 25,
  active: 25,
  pinned: ['BTC', 'ETH', 'XRP', 'DOGE', 'XLM', 'SHIB'],
  ranked: ['SOL', 'BNB', 'TRX', 'ZEC'],
  changes: [{ ts: T0, action: 'ADD', symbol: 'SOL' }],
};

export const LEARNING = {
  strategy: 'crypto_momentum_v1',
  horizon: 'SHORT',
  fusionWeights: {
    defaults: { technical: 0.38, fundamental: 0.18, event: 0.14, sentiment: 0.08, macro: 0.06, regime: 0.16 },
    learned: null,
    sufficient: false,
    trades: 0,
    updatedAt: null,
  },
  lessonsByStatus: [{ status: 'PROPOSED', n: 2 }],
  outcomesRecorded: 0,
  weightRefits: 0,
  note: 'Outcomes from the crypto book refit crypto weights only (MIN_TRADES floor, ±35% bound).',
};

export const EXPERIMENTS = {
  from: '2026-08-06',
  to: '2026-11-03',
  signals: 42,
  closedTrades: 7,
  note: 'Shadow mode — these experiments observe outcomes only. Nothing is blocked.',
  conditions: [
    {
      key: 'relative_strength',
      label: 'Relative strength',
      description: 'top-quartile 20d return vs BTC',
      evaluableSignals: 42, matchedSignals: 18, matchedClosed: 4,
      matchedWinRatePct: 50, matchedAvgReturnPct: 4.2,
      baselineClosed: 3, baselineWinRatePct: 33.3, baselineAvgReturnPct: 1.1,
      deltaReturnPct: 3.1, status: 'PROMOTE_CANDIDATE',
    },
    {
      key: 'volume_confirmed',
      label: 'Volume confirmed',
      description: 'relative volume ≥ 1.5x',
      evaluableSignals: 42, matchedSignals: 21, matchedClosed: 3,
      matchedWinRatePct: 33.3, matchedAvgReturnPct: -0.4,
      baselineClosed: 4, baselineWinRatePct: 50, baselineAvgReturnPct: 3.2,
      deltaReturnPct: -3.6, status: 'OBSERVING',
    },
  ],
};

export const JOBS = {
  count: 1,
  jobs: [
    { name: 'signal_scan', schedule: 'crypto', last_run: T0, last_status: 'OK', duration_ms: 240, last_error: null, runs: 96 },
    { name: 'bar_backfill', schedule: 'crypto', last_run: T0, last_status: 'ERROR', duration_ms: 12, last_error: 'kraken HTTP 502', runs: 4 },
  ],
};

export const RUN = {
  ok: true,
  signalsCreated: 1,
  snapshot: { equity: 101_842.11, cash: 78_400.55, unrealized: 1_204.3, benchmark: 103_427.55 },
  jobs: JOBS.jobs,
};

/* ------------------------------------------------------------------ */
/* multi-exchange market intelligence — /providers, /xchange,          */
/* /sources, /context (enabled:false production default), /accuracy    */
/* ------------------------------------------------------------------ */

const KRAKEN_REFERENCE = {
  id: 'kraken',
  label: 'Kraken',
  feedKind: 'WEBSOCKET',
  state: 'CONNECTED',
  healthy: true,
  connected: true,
  channels: ['ticker'],
  symbols: ['BTC', 'ETH', 'XRP', 'DOGE', 'XLM', 'SHIB'],
  symbolCount: 25,
  events: 18_420,
  eventsPerMin: 25,
  lastEventTs: T0 - 2_000,
  lastEventAgeMs: 2_000,
  lastAckTs: T0 - 2_000,
  reconnects: 0,
  errors: 0,
  lastError: null,
  // Kraken's WS ticker carries bid/ask sizes but no L2 levels in this app
  latency: { p50: null, p95: null, samples: 0 },
  book: [],
  quotes: [
    { provider: 'kraken', symbol: 'BTC', quote: 'USD', bid: 76_661.4, ask: 76_662.4, mid: 76_661.9, last: 76_661.9, spreadBps: 1.3, ts: T0 - 2_000 },
  ],
  note: null,
};

const COINBASE = {
  id: 'coinbase',
  label: 'Coinbase Exchange',
  feedKind: 'WEBSOCKET',
  state: 'CONNECTED',
  healthy: true,
  connected: true,
  channels: ['ticker', 'level2', 'matches'],
  symbols: ['BTC', 'ETH'],
  symbolCount: 2,
  events: 12_906,
  eventsPerMin: 214,
  lastEventTs: T0 - 4_000,
  lastEventAgeMs: 4_000,
  lastAckTs: T0 - 4_000,
  reconnects: 1,
  errors: 0,
  lastError: null,
  latency: { p50: 38, p95: 121, samples: 512 },
  book: [
    { symbol: 'BTC', levels: 50, valid: true, ageMs: 4_000 },
    { symbol: 'ETH', levels: 50, valid: true, ageMs: 5_000 },
  ],
  quotes: [
    { provider: 'coinbase', symbol: 'BTC', quote: 'USD', bid: 76_660.1, ask: 76_661.4, mid: 76_660.75, last: 76_661.1, spreadBps: 0.17, ts: T0 - 4_000 },
  ],
  note: null,
};

/** enabled + healthy: Kraken reference first, Coinbase second, 4 NOT WIRED. */
export const PROVIDERS = {
  ok: true,
  executionMode: 'PAPER_ONLY',
  decisionImpact: 'NONE',
  generatedAt: T0,
  exchanges: [COINBASE],
  context: [],
  pending: ['binanceus', 'gemini', 'bitstamp', 'cryptocom'],
  reference: KRAKEN_REFERENCE,
};

/** CRYPTO_XCHANGE_ENABLED=0 — every configured venue reports DISABLED. */
export const PROVIDERS_DISABLED = {
  ...PROVIDERS,
  exchanges: [
    {
      ...COINBASE,
      state: 'DISABLED',
      healthy: false,
      connected: false,
      events: 0,
      eventsPerMin: 0,
      lastEventTs: null,
      lastEventAgeMs: null,
      latency: { p50: null, p95: null, samples: 0 },
      book: [],
      quotes: [],
      note: 'CRYPTO_XCHANGE_ENABLED=0',
    },
  ],
};

/** socket up, feed frozen: CONNECTED must NOT read as healthy. */
export const PROVIDERS_STALE = {
  ...PROVIDERS,
  exchanges: [
    {
      ...COINBASE,
      healthy: false,
      lastEventAgeMs: 95_000,
      lastEventTs: T0 - 95_000,
      eventsPerMin: 0,
      note: 'no market data for 95s',
    },
  ],
};

/** one OK horizon, one INSUFFICIENT_DATA horizon (never a fake 0) */
export const SOURCES = {
  ok: true,
  symbol: 'BTC',
  generatedAt: T0,
  windowMs: 86_400_000,
  providers: [
    { provider: 'kraken', samples: 720, lastTs: T0 - 5_000, ageMs: 5_000 },
    { provider: 'coinbase', samples: 716, lastTs: T0 - 5_000, ageMs: 5_000 },
  ],
  freshness: [
    { provider: 'kraken', symbol: 'BTC', ageMs: 5_000, fresh: true },
    { provider: 'coinbase', symbol: 'BTC', ageMs: 5_000, fresh: true },
  ],
  horizons: [
    {
      horizon: '5m',
      horizonMs: 300_000,
      status: 'OK',
      trainRows: 420,
      testRows: 180,
      folds: 4,
      baseline: { n: 180, accuracyPct: 52.22, balancedAccuracyPct: 50.0, brier: 0.2487, calibration: [{ bucket: '0-20', predictedPct: 12, observedPct: 14, n: 36 }], netEdgeAfterCostPct: 0.021, signalsTaken: 64, correctSignals: 34 },
      krakenOnly: { n: 180, accuracyPct: 54.44, balancedAccuracyPct: 54.44, brier: 0.2412, calibration: [{ bucket: '40-60', predictedPct: 51, observedPct: 54, n: 72 }], netEdgeAfterCostPct: 0.034, signalsTaken: 64, correctSignals: 36 },
      krakenPlusCoinbase: { n: 180, accuracyPct: 57.78, balancedAccuracyPct: 57.78, brier: 0.2331, calibration: [{ bucket: '40-60', predictedPct: 55, observedPct: 58, n: 72 }], netEdgeAfterCostPct: 0.046, signalsTaken: 64, correctSignals: 39 },
      incremental: { balancedAccuracyDeltaPct: 3.34, brierDelta: -0.0081, netEdgeDeltaPct: 0.012 },
      featureRedundancyR: 0.82,
      note: 'Adding Coinbase improves balanced accuracy over Kraken alone in this fold.',
    },
    {
      horizon: '1d',
      horizonMs: 86_400_000,
      status: 'INSUFFICIENT_DATA',
      trainRows: 0,
      testRows: 0,
      folds: 0,
      baseline: { n: 0, accuracyPct: null, balancedAccuracyPct: null, brier: null, calibration: [], netEdgeAfterCostPct: null, signalsTaken: 0, correctSignals: 0 },
      krakenOnly: { n: 0, accuracyPct: null, balancedAccuracyPct: null, brier: null, calibration: [], netEdgeAfterCostPct: null, signalsTaken: 0, correctSignals: 0 },
      krakenPlusCoinbase: { n: 0, accuracyPct: null, balancedAccuracyPct: null, brier: null, calibration: [], netEdgeAfterCostPct: null, signalsTaken: 0, correctSignals: 0 },
      incremental: { balancedAccuracyDeltaPct: null, brierDelta: null, netEdgeDeltaPct: null },
      featureRedundancyR: null,
      note: '4 closed 1d outcomes — below the 30-row evaluation floor, no metric is reported.',
    },
  ],
  status: 'OK',
  note: 'Research only: this measures whether added venue data helps, not a live strategy.',
};

export const XCHANGE = {
  ok: true,
  enabled: true,
  symbol: 'BTC',
  windowMs: 3_600_000,
  generatedAt: T0,
  monitors: ['BTC', 'ETH'],
  quote: 'USD',
  sampleCount: 478,
  features: {
    symbol: 'BTC',
    generatedAt: T0,
    windowMs: 3_600_000,
    venues: [
      { provider: 'kraken', symbol: 'BTC', quote: 'USD', samples: 240, firstTs: T0 - 3_600_000, lastTs: T0 - 3_000, lastMid: 76_661.9, spreadBps: 1.3, imbalance: 0.12, returnPct: 0.42, trades: 118, takerBuyPct: 54.6, fresh: true },
      { provider: 'coinbase', symbol: 'BTC', quote: 'USD', samples: 238, firstTs: T0 - 3_600_000, lastTs: T0 - 4_000, lastMid: 76_660.75, spreadBps: 0.17, imbalance: -0.05, returnPct: 0.4, trades: 96, takerBuyPct: 51.2, fresh: true },
    ],
    agreement: [
      { symbol: 'BTC', quoteGroup: 'USD', venues: 2, freshVenues: 2, agreement: 1, majority: 'UP', reference: 'kraken', referenceAgrees: true, divergenceBps: 1.49, samples: 478, sufficient: true },
    ],
    pressure: [
      { provider: 'kraken', trades: 118, takerBuyPct: 54.6, fresh: true },
      { provider: 'coinbase', trades: 96, takerBuyPct: 51.2, fresh: true },
    ],
    leadLag: [
      { provider: 'coinbase', lagSamples: 3, corrLag0: 0.91, corrBestLag: 0.64, bestLag: 1, n: 238, sufficient: true },
    ],
    confidence: { score: 0.83, sufficient: true, parts: { agreement: 1, coverage: 1, spread: 0.99, divergenceSanity: 1 } },
  },
  note: 'research-only: none of these values feeds a trading decision',
};

export const XCHANGE_DISABLED = {
  ok: true,
  enabled: false,
  symbol: 'BTC',
  note: 'CRYPTO_XCHANGE_ENABLED=0',
};

export const CONTEXT_SOURCE = {
  id: 'dexscreener',
  label: 'DEX Screener',
  feedKind: 'REST',
  state: 'CONNECTED',
  healthy: true,
  requests: 4,
  budget: { limit: 60, used: 4, resetsAt: T0 + 300_000 },
  lastFetchTs: T0 - 120_000,
  lastFetchAgeMs: 120_000,
  cacheEntries: 36,
  lastError: null,
  note: null,
};

/** production default (CRYPTO_XCHANGE_CONTEXT is off) */
export const CONTEXT_OFF = {
  ok: true,
  enabled: false,
  sources: [],
  data: {},
  note: 'CRYPTO_XCHANGE_CONTEXT is off',
};

export const CONTEXT_ON = {
  ok: true,
  enabled: true,
  generatedAt: T0,
  sources: [CONTEXT_SOURCE],
  cacheEntries: 36,
  data: { dexscreener: { ts: T0 - 120_000, payload: { pairs: 12, updatedAt: T0 - 120_000 } } },
  note: 'lower-frequency research context — never mixed into realtime features',
};

/** fixed-horizon accuracy: pct fields are fractions; null stays null */
export const ACCURACY = {
  generatedAt: T0,
  note: 'Horizon-fixed evaluation: outcome taken at/after signal_ts + horizon, never before.',
  signals: { total: 18, BUY: 11, SELL: 7 },
  horizons: [
    {
      key: '30s',
      source: 'micro_snapshot',
      horizonMs: 30_000,
      elapsed: 18,
      evaluated: 16,
      flat: 1,
      noData: 2,
      accuracy: { BUY: { n: 9, correct: 6, pct: 0.6667 }, SELL: { n: 7, correct: 4, pct: 0.5714 }, overall: { n: 16, correct: 10, pct: 0.625 } },
      classBalance: { up: 9, down: 7, upPct: 0.5625 },
      baselines: {
        alwaysUp: { n: 16, pct: 0.5625 },
        alwaysDown: { n: 16, pct: 0.4375 },
        persistence: { n: 14, pct: 0.5 },
      },
    },
    {
      key: '1d',
      source: 'daily_bar',
      horizonMs: 86_400_000,
      elapsed: 18,
      evaluated: 0,
      flat: 0,
      noData: 18,
      accuracy: { BUY: { n: 0, correct: 0, pct: null }, SELL: { n: 0, correct: 0, pct: null }, overall: { n: 0, correct: 0, pct: null } },
      classBalance: { up: 0, down: 0, upPct: null },
      baselines: {
        alwaysUp: { n: 0, pct: null },
        alwaysDown: { n: 0, pct: null },
        persistence: { n: 0, pct: null },
      },
    },
  ],
  detail: [],
};

/* ------------------------------------------------------------------ */
/* Kalshi 15m engine — /kalshi15m{,/calibration,/signals,/paper}       */
/* mirrors server/src/crypto/routes.ts; money arrives in CENTS        */
/* ------------------------------------------------------------------ */

export const KALSHI15M = {
  enabled: true,
  series: 'KXBTC15M',
  authenticated: true,
  socket: { live: true, connects: 1, reconnects: 0, errors: 0, lastError: null, framesSeen: 92_680, lastFrameAt: T0, stalenessMs: 4, stale: false },
  window: {
    eventTicker: 'KXBTC15M-20NOV202100',
    marketTicker: 'KXBTC15M-20NOV202100-00',
    openTs: T0 - 600_000,
    closeTs: T0 + 300_000,
    expireTs: T0 + 600_000,
    strike: 76_640.5,
    phase: 'OPEN',
    msToClose: 240_000,
    source: 'REST',
  },
  book: {
    bestBid: 0.52, bestAsk: 0.53, spread: 0.01, imbalance: 0.11, ofi: 0.04, cancelRatio: 0.42,
    deltasInWindow: 612, trades1s: 4, qty1s: 12.5, trades5s: 31, qty5s: 180.2, takerBias60s: 0.18,
    levels: { bids: 128, asks: 141 }, trusted: true, seq: 291_819,
  },
  fairValue: {
    reference: 'APPROXIMATION', spot: 76_641.2, sigma: 0.000052, pYes: 0.5473, impliedMid: 0.525,
    edgePp: 2.23, reason: null, approx: 'coinbase', sigmaImplied: 0.000081, sigmaWindowSec: 60,
    sigmaRealized: 0.0000069, sigmaSource: 'max/implied',
  },
  counters: {
    discovers: 12, discoverErrors: 0, rollOvers: 0, samples: 812, trades: 24_118,
    duplicateTrades: 0, seqGaps: 0, snapshotRecoveries: 0, restRecoveries: 0,
  },
  cadence: { sampleMs: 250, discoverMs: 10_000, healthMs: 60_000, staleMs: 5_000 },
  strategyA: { enabled: true, mode: 'SHADOW', evaluated: 257, traded: 0, skipped: 257, lastVerdict: 'SKIP', lastNetPp: null },
  shadowStrategies: {
    mode: 'SHADOW',
    enabled: { A: true, B: true, C: true, D: true, E: true, F: true },
    shadowStrategies: {
      A_LEADLAG: { evaluated: 257, traded: 0 },
      B_MICRO: { evaluated: 257, traded: 0 },
      C_PANICFADE: { evaluated: 257, traded: 7 },
      D_MOMENTUM: { evaluated: 257, traded: 3 },
      E_LATEFAV_HOLD: { evaluated: 257, traded: 0 },
      F_MAKER: { evaluated: 257, traded: 168 },
    },
  },
  sigmaPolicy: { source: 'max', impliedWindowSamples: 240, impliedRing: 240 },
  paper: { enabled: true, equityCents: 99_438.36, halt: { manual: false, auto: false, reason: null, halts: 1 } },
};

export const KALSHI15M_CALIBRATION = {
  window: { rows: 2_000, limit: 2_000 },
  config: { sigmaSource: 'max', impliedWindowSamples: 240, impliedRing: 240 },
  sigma: { realizedMedian: 0.00000695, impliedMedian: 0.000000603, impliedOverRealizedMedian: 0.0876, pairedSamples: 1_240 },
  edge: { medianPp: 1.87, p95AbsPp: 10.37, shareOver2Pp: 0.3333 },
  sources: { 'max/implied': 2_000 },
  note: 'edge_pp is information ONLY while sigma is calibrated: compare impliedOverRealizedMedian with 1 before believing any edge.',
};

export const KALSHI15M_SIGNALS = {
  enabled: true,
  count: 3,
  mode: 'SHADOW — no order is ever placed from this engine',
  strategyAEnabled: true,
  summary: {
    window: { rows: 2_000, limit: 2_000 },
    trades: 190,
    skips: 1_810,
    bySide: { YES: 37, NO: 153 },
    bySkipReason: {
      move_too_small: 584,
      edge_below_cost: 248,
      no_panic_drop: 236,
      not_late_enough: 211,
      not_a_favorite: 115,
      imbalance_too_weak: 81,
      taker_flow_disagreement: 78,
      spot_confirms_move: 44,
      flow_disagreement: 39,
      venue_disagreement: 31,
      ofi_disagreement: 63,
      ofi_too_weak: 26,
      no_model_probability: 20,
      no_model_inputs: 12,
      no_sigma: 12,
      no_mid_history: 8,
      no_spot_history: 2,
    },
    tradeNetPpMedian: 4.9978,
    note: 'SHADOW ONLY: no order was ever placed; verdicts are hypothetical.',
  },
  signals: [
    {
      id: 21_395, ts: T0, market_ticker: 'KXBTC15M-20NOV202100-00', event_ticker: 'KXBTC15M-20NOV202100',
      strategy: 'F_MAKER', verdict: 'SKIP', side: null, expected_move_pp: null, repriced_pp: null,
      remaining_pp: null, cost_pp: 0, net_pp: null, tau_sec: 48.6, strike: 76_640.5, sigma: 0.000052,
      spot_now: 76_641.2, mid_now: 0.525, move_bps: null, agree: 1, skip_reason: 'move_too_small',
      reasons: 'tau=48.6s maker_fee=0 (series fee_type=quadratic); spot move below the 1.5bps floor',
      phase: 'OPEN',
    },
    {
      id: 21_394, ts: T0 - 250, market_ticker: 'KXBTC15M-20NOV202100-00', event_ticker: 'KXBTC15M-20NOV202100',
      strategy: 'C_PANICFADE', verdict: 'TRADE', side: 'NO', expected_move_pp: 6.1, repriced_pp: 3.7,
      remaining_pp: 2.4, cost_pp: 1.6, net_pp: 2.4, tau_sec: 132.4, strike: 76_640.5, sigma: 0.000052,
      spot_now: 76_641.2, mid_now: 0.525, move_bps: 4.2, agree: 1, skip_reason: null,
      reasons: 'drop not confirmed by spot tape; rebound fraction 0.5 (stated assumption)',
      phase: 'OPEN',
    },
    {
      id: 21_393, ts: T0 - 500, market_ticker: 'KXBTC15M-20NOV202100-00', event_ticker: 'KXBTC15M-20NOV202100',
      strategy: 'A_LEADLAG', verdict: 'SKIP', side: null, expected_move_pp: 3.4, repriced_pp: 1.1,
      remaining_pp: 2.3, cost_pp: 1.6, net_pp: 1.1, tau_sec: 96.2, strike: 76_640.5, sigma: 0.000052,
      spot_now: 76_641.2, mid_now: 0.525, move_bps: 2.9, agree: 1, skip_reason: 'edge_below_cost',
      reasons: 'expected 3.4pp move vs 1.1pp already repriced; round trip cost 1.6pp',
      phase: 'OPEN',
    },
  ],
};

export const KALSHI15M_PAPER = {
  ok: true,
  mode: 'PAPER — simulated fills, no order path exists in this engine',
  enabled: true,
  config: {
    enabled: true, bankrollCents: 100_000, riskPerTradePct: 0.25, dailyLossCapPct: 2, maxExposurePct: 5,
    maxPositionsPerMarket: 1, minNetPp: 2, holdSec: 10, stopLossPp: 5, takeProfitPp: 10,
    reentryCooldownMs: 5_000, allowPartial: false, maxBookAgeMs: 5_000, killSwitch: false, haltStaleMs: 30_000,
  },
  halt: { manual: false, auto: false, reason: null, halts: 1 },
  equityCents: 99_438.36,
  open: [
    {
      id: 50, eventTicker: 'KXBTC15M-20NOV202100', marketTicker: 'KXBTC15M-20NOV202100-00',
      strategy: 'F_MAKER', side: 'NO', qty: 2, entryPrice: 0.47, entryFeeC: 0, entryTs: T0 - 40_000,
    },
  ],
  risk: { openCostC: 94, openPositions: 1, dailyRealizedC: -561.64, blockedBy: null },
  closed: {
    trades: 48, wins: 15, winRatePct: 31.3, netCents: -561.64, feesCents: 763.64,
    byExitReason: [{ r: 'TIME_EXIT', n: 28 }, { r: 'STOP_LOSS', n: 16 }, { r: 'TAKE_PROFIT', n: 4 }],
  },
  counters: { entries: 21, rejected: 154, exits: 22, settled: 0, halts: 1 },
  rejects: { risk_reentry_cooldown: 73, risk_position_exists: 79, risk_insufficient_depth: 1, risk_exit_insufficient_depth: 1 },
  byStrategy: [
    { strategy: 'F_MAKER', trades: 46, net_c: -577.6 },
    { strategy: 'C_PANICFADE', trades: 1, net_c: -52.15 },
    { strategy: 'A_LEADLAG', trades: 1, net_c: 68.11 },
  ],
};

/** top-K ranking shadow record — /shadow */
export const SHADOW = {
  enabled: true,
  k: 3,
  mode: 'shadow',
  decisionImpact: 'NONE — every BUY still trades; this table only records what a top-K rule would have kept',
  recorded: 12,
  selected: 5,
  takenByProduction: 12,
  outcomes: [
    { selected: 1, n: 3, wins: 2, netPnl: 214.5 },
    { selected: 0, n: 2, wins: 0, netPnl: -88.1 },
  ],
  recent: [
    { ts: T0, session_date: '2026-11-07', signal_id: 12, ticker: 'NEAR', score: 0.62, confidence: 0.514, rank: 1, selected: 1, order_created: 1 },
    { ts: T0, session_date: '2026-11-07', signal_id: 13, ticker: 'UNI', score: 0.31, confidence: 0.514, rank: 2, selected: 1, order_created: 1 },
  ],
};

/** endpoint key ('status', 'overview', 'kalshi15m', …) -> payload */
export const FIXTURES: Record<string, unknown> = {
  status: STATUS,
  overview: OVERVIEW,
  quotes: QUOTES,
  universe: UNIVERSE,
  learning: LEARNING,
  experiments: EXPERIMENTS,
  jobs: JOBS,
  run: RUN,
  positions: { count: OVERVIEW.positions.length, positions: OVERVIEW.positions },
  trades: { count: 1, stats: OVERVIEW.stats, trades: OVERVIEW.recentTrades },
  signals: { count: 1, signals: [] },
  portfolio: { count: 0, points: [] },
  /* multi-exchange market intelligence (see exports above for variants) */
  providers: PROVIDERS,
  xchange: XCHANGE,
  sources: SOURCES,
  /** /context default = production default (CRYPTO_XCHANGE_CONTEXT off) */
  context: CONTEXT_OFF,
  accuracy: ACCURACY,
  shadow: SHADOW,
  providers_disabled: PROVIDERS_DISABLED,
  providers_stale: PROVIDERS_STALE,
  xchange_disabled: XCHANGE_DISABLED,
  context_enabled: CONTEXT_ON,
  /* Kalshi 15m engine (read-only) */
  kalshi15m: KALSHI15M,
  'kalshi15m/calibration': KALSHI15M_CALIBRATION,
  'kalshi15m/signals': KALSHI15M_SIGNALS,
  'kalshi15m/paper': KALSHI15M_PAPER,
};

/**
 * `overrides` wins over FIXTURES, keyed by the full `path?query` first and
 * then by the bare path — so a test can serve an `enabled: false` variant
 * for `/context` or a DISABLED provider set without a second stub.
 */
export function stubFetch(overrides: Record<string, unknown> = {}): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (!url.includes('/api/crypto/')) return jsonResponse({}, 404);
      const rest = url.slice(url.indexOf('/api/crypto/') + '/api/crypto/'.length);
      const key = rest.split('?')[0];
      const body = overrides[rest] ?? overrides[key] ?? FIXTURES[rest] ?? FIXTURES[key] ?? {};
      return jsonResponse(body);
    }),
  );
}

/** pushState + popstate, so the shell's useRoute() picks it up. */
export function goto(path: string): void {
  window.history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
