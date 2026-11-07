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
  stats: { closed: 5, wins: 2, winRatePct: 40, netPnl: 412.9, avgReturnPct: 0.82, feesPaid: 38.4, avgHoldSessions: 4.2 },
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

/** endpoint key ('status', 'overview', 'experiments', …) -> payload */
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
};

export function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (!url.includes('/api/crypto/')) return jsonResponse({}, 404);
      const rest = url.slice(url.indexOf('/api/crypto/') + '/api/crypto/'.length);
      const key = rest.split('?')[0];
      return jsonResponse(FIXTURES[key] ?? {});
    }),
  );
}

/** pushState + popstate, so the shell's useRoute() picks it up. */
export function goto(path: string): void {
  window.history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
