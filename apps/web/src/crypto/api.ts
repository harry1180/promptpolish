/**
 * Crypto HTTP client — typed strictly against the /api/crypto endpoints in
 * docs (status, overview, quotes, universe, signals, positions, trades,
 * portfolio, learning, experiments, jobs + POST run).
 *
 * BASE is derived from VITE_API_BASE (empty in dev) plus the crypto API
 * prefix — never a hardcoded origin. Failures throw ApiError carrying the
 * server's message. The browser only issues GET requests except POST /run,
 * which re-runs the scheduler cycle manually (server-side rate not needed:
 * it does exactly what the timer would do).
 */

export const API: string = (import.meta.env.VITE_API_BASE ?? '') + '/api/crypto';

const TIMEOUT_MS = 10_000;

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

function isAbort(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: string }).name === 'AbortError';
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(API + path, {
      ...init,
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
    });
  } catch (err) {
    if (isAbort(err)) throw new ApiError(`Request timed out after ${TIMEOUT_MS / 1000}s`, 0);
    throw new ApiError(err instanceof Error ? err.message : 'network error', 0);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let message = `request failed (status ${res.status})`;
    try {
      const body = (await res.json()) as { error?: unknown; errors?: unknown };
      if (typeof body?.error === 'string') message = body.error;
      else if (Array.isArray(body?.errors) && typeof body.errors[0] === 'string') message = body.errors[0];
    } catch {
      /* non-JSON error body — keep the status message */
    }
    throw new ApiError(message, res.status);
  }

  try {
    return (await res.json()) as T;
  } catch {
    throw new ApiError('response was not valid JSON', res.status);
  }
}

function get<T>(path: string): Promise<T> {
  return request<T>(path, { method: 'GET' });
}

function post<T>(path: string): Promise<T> {
  return request<T>(path, { method: 'POST' });
}

/* ------------------------------------------------------------------ */
/* response shapes (mirrors server/src/crypto/routes.ts)              */
/* ------------------------------------------------------------------ */

export interface ProviderInfo {
  name: string;
  status: string;
  lastUpdate: number;
  lastLatencyMs: number;
  lastError: string | null;
}

export interface UniverseChange { ts: number; action: string; symbol: string }

export interface StatusResponse {
  ok: boolean;
  executionMode: string;
  portfolioKind: string;
  session: string;
  alwaysOpen: boolean;
  provider: ProviderInfo;
  stream: { live: boolean; symbols: number };
  universe: {
    members: number; active: number;
    pinned: string[]; ranked: string[];
    changes: UniverseChange[];
  };
  counts: {
    quotes: number; bars: number; signals: number;
    openPositions: number; closedTrades: number;
  };
  jobs: JobRow[];
  recentErrors: Array<{ job: string; at: number; message: string }>;
}

export interface JobRow {
  name: string; schedule?: string; last_run?: number; last_status?: string;
  duration_ms?: number; last_error?: string | null; runs?: number;
}

export interface PositionRowView {
  id: number; ticker: string; company: string; qty: number;
  entryPrice: number; entryTs: number; entrySession: string;
  currentPrice: number; unrealized: number; unrealizedPct: number;
  stop: number; target: number; maxHold: number; sessionsHeld: number;
  mfe: number; mae: number; thesisStatus: string; predictedReturn: number;
  entryFee: number; signalId: number | null;
}

export interface TradeRowView {
  id: number; ticker: string; side: string; qty: number;
  entryPrice: number; entryTs: number; exitPrice: number; exitTs: number;
  exitReason: string; netPnl: number; grossPnl: number;
  returnPct: number; benchmarkReturnPct: number; excessReturnPct: number;
  predictedReturnPct: number; predictionError: number | null;
  holdingSessions: number; strategy: string; capital: number; status: string;
}

export interface TradeStats {
  closed: number; wins: number; winRatePct: number; netPnl: number;
  avgReturnPct: number; feesPaid: number; avgHoldSessions: number;
}

export interface OverviewResponse {
  portfolio: {
    kind: string; startCapital: number; cash: number; equity: number;
    unrealized: number; exposure: number; returnPct: number; createdAt: number;
  } | null;
  benchmark: { symbol: string; price: number; startPrice: number; equity: number; returnPct: number };
  stats: TradeStats;
  positions: PositionRowView[];
  recentTrades: TradeRowView[];
  snapshotAt: number | null;
}

export interface QuoteRow {
  symbol: string; price: number; prevClose: number; changePct: number;
  bid: number | null; ask: number | null; ts: number;
  provider: string; freshness: string; pinned: boolean; rank: number | null; active: boolean;
}

export interface QuotesResponse { count: number; quotes: QuoteRow[] }

export interface UniverseResponse {
  members: number; active: number; pinned: string[]; ranked: string[];
  changes: UniverseChange[];
}

export interface SignalRowView {
  id: number; ticker: string; company: string; sector: string; portfolio: string;
  signal: string; horizon: string; confidence: number; price: number;
  entryLow: number; entryHigh: number; target: number; invalidation: number;
  expectedReturnPct: number; riskReward: number; strategy: string;
  createdAt: number; session: string; status: string; regime: string;
  dataFreshness: number; signalDate: string;
}

export interface SignalsResponse { count: number; signals: SignalRowView[] }
export interface PositionsResponse { count: number; positions: PositionRowView[] }
export interface TradesResponse { count: number; stats: TradeStats; trades: TradeRowView[] }

export interface PortfolioPoint { ts: number; equity: number; cash: number; unrealized: number; benchmark: number }
export interface PortfolioResponse { count: number; points: PortfolioPoint[] }

export interface LearningResponse {
  strategy: string; horizon: string;
  fusionWeights: {
    defaults: Record<string, number>;
    learned: Partial<Record<string, number>> | null;
    sufficient: boolean;
    trades: number;
    updatedAt: number | null;
  };
  lessonsByStatus: Array<{ status: string; n: number }>;
  outcomesRecorded: number;
  weightRefits: number;
  note: string;
}

/** Shadow-mode rule experiment: matched setup vs the rest of the window.
 *  Read-only by contract — the server never writes anything for these. */
export interface ExperimentRow {
  key: string;
  label: string;
  description: string;
  evaluableSignals: number;
  matchedSignals: number;
  matchedClosed: number;
  matchedWinRatePct: number | null;
  matchedAvgReturnPct: number | null;
  baselineClosed: number;
  baselineWinRatePct: number | null;
  baselineAvgReturnPct: number | null;
  /** matched average minus baseline average, in percentage points */
  deltaReturnPct: number | null;
  status: 'OBSERVING' | 'PROMOTE_CANDIDATE' | 'NO_EDGE';
}

export interface ExperimentsResponse {
  from: string;
  to: string;
  signals: number;
  closedTrades: number;
  note: string;
  conditions: ExperimentRow[];
}

export interface JobsResponse { count: number; jobs: JobRow[] }

export interface RunResponse {
  ok: boolean; signalsCreated: number;
  snapshot: { equity: number; cash: number; unrealized: number; benchmark: number };
  jobs: JobRow[];
}

/* ------------------------------------------------------------------ */
/* fetchers                                                            */
/* ------------------------------------------------------------------ */

export const getStatus = (): Promise<StatusResponse> => get<StatusResponse>('/status');
export const getOverview = (): Promise<OverviewResponse> => get<OverviewResponse>('/overview');
export const getQuotes = (): Promise<QuotesResponse> => get<QuotesResponse>('/quotes');
export const getUniverse = (): Promise<UniverseResponse> => get<UniverseResponse>('/universe');
export const getPositions = (): Promise<PositionsResponse> => get<PositionsResponse>('/positions');
export const getTrades = (limit = 50): Promise<TradesResponse> => get<TradesResponse>(`/trades?limit=${limit}`);
export const getPortfolio = (): Promise<PortfolioResponse> => get<PortfolioResponse>('/portfolio');
export const getLearning = (): Promise<LearningResponse> => get<LearningResponse>('/learning');
export const getJobs = (): Promise<JobsResponse> => get<JobsResponse>('/jobs');

export const getSignals = (params: { limit?: number; signal?: string; date?: string } = {}): Promise<SignalsResponse> => {
  const q = new URLSearchParams();
  if (params.limit) q.set('limit', String(params.limit));
  if (params.signal) q.set('signal', params.signal);
  if (params.date) q.set('date', params.date);
  const s = q.toString();
  return get<SignalsResponse>(`/signals${s ? `?${s}` : ''}`);
};

export const getExperiments = (from: string, to?: string): Promise<ExperimentsResponse> => {
  const q = new URLSearchParams({ from });
  if (to) q.set('to', to);
  return get<ExperimentsResponse>(`/experiments?${q.toString()}`);
};

export const runCycle = (): Promise<RunResponse> => post<RunResponse>('/run');
