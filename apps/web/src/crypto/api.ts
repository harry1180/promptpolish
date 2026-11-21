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
  /** Wilson 95% interval on the win rate — null until something has closed */
  winRateCiLowPct: number | null;
  winRateCiHighPct: number | null;
}

/**
 * The win-rate tile's second line. A rate over 4 trades carries no
 * information, so the sample size and its interval travel with the number:
 * `2 wins · CI 6-81%`. `100% on 1 trade` should never read as skill.
 */
export function winRateHint(stats?: Partial<TradeStats> | null): string {
  if (!stats) return '';
  const { closed = 0, wins = 0, winRateCiLowPct: lo, winRateCiHighPct: hi } = stats;
  if (!closed) return 'no closed trades yet';
  if (lo == null || hi == null) return `${wins} win${wins === 1 ? '' : 's'} of ${closed}`;
  return `${wins} of ${closed} · CI ${lo}–${hi}%`;
}

export interface ShadowResponse {
  enabled: boolean;
  k: number;
  mode: string;
  decisionImpact: string;
  recorded: number;
  selected: number;
  takenByProduction: number;
  outcomes: Array<{ selected: number; n: number; wins: number; netPnl: number }>;
  recent: Array<{
    ts: number; session_date: string; signal_id: number; ticker: string;
    score: number; confidence: number; rank: number; selected: number;
    order_created: number;
  }>;
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
export const getShadow = (): Promise<ShadowResponse> => get<ShadowResponse>('/shadow');

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

/* ------------------------------------------------------------------ */
/* multi-exchange market intelligence (research-only, decisionImpact   */
/* 'NONE'): GET /providers · /xchange · /sources · /context ·          */
/* /accuracy — same API base and wrappers as every fetcher above.       */
/* Shapes mirror server/src/xchange/{types,features,evaluation}.ts and   */
/* server/src/crypto/accuracy.ts; every field the server may omit stays  */
/* optional so a partial payload degrades to an honest empty state.      */
/* ------------------------------------------------------------------ */

export type FeedKind = 'WEBSOCKET' | 'REST';

export type ProviderState =
  | 'DISABLED'
  | 'CONFIGURED'
  | 'CONNECTING'
  | 'CONNECTED'
  | 'DEGRADED'
  | 'DISCONNECTED'
  | 'UNAVAILABLE'
  | 'NEEDS_CONFIGURATION';

export interface VenueQuoteView {
  provider: string; symbol: string; quote: string;
  bid: number | null; ask: number | null; mid: number | null; last: number | null;
  spreadBps: number | null; ts: number;
}

/** One live venue as the registry reports it — CONNECTED is transport only. */
export interface ProviderSnapshotView {
  id: string;
  label: string;
  feedKind: FeedKind;
  state: ProviderState;
  healthy: boolean;
  connected: boolean;
  channels: string[];
  symbols: string[];
  symbolCount: number;
  events: number;
  eventsPerMin: number;
  lastEventTs: number | null;
  lastEventAgeMs: number | null;
  lastAckTs: number | null;
  reconnects: number;
  errors: number;
  lastError: string | null;
  latency: { p50: number | null; p95: number | null; samples: number };
  book: Array<{ symbol: string; levels: number; valid: boolean; ageMs: number | null }>;
  quotes: VenueQuoteView[];
  note: string | null;
}

/** Lower-frequency REST research source (DEX Screener / GeckoTerminal / CoinGecko). */
export interface ContextSourceView {
  id: string;
  label: string;
  feedKind: FeedKind;
  state: ProviderState;
  healthy: boolean;
  requests: number;
  budget: { limit: number; used: number; resetsAt: number | null };
  lastFetchTs: number | null;
  lastFetchAgeMs: number | null;
  cacheEntries: number;
  lastError: string | null;
  note: string | null;
}

export interface ProvidersResponse {
  ok: boolean;
  executionMode?: string;
  decisionImpact?: string;
  generatedAt?: number;
  exchanges?: ProviderSnapshotView[];
  context?: ContextSourceView[];
  /** venues with an adapter design but NOT wired — rendered as NOT WIRED */
  pending?: string[];
  /** the production feed, reported in the same shape */
  reference?: ProviderSnapshotView | null;
}

export interface VenueWindowView {
  provider: string; symbol: string; quote: string; samples: number;
  firstTs: number; lastTs: number; lastMid: number | null; spreadBps: number | null;
  imbalance: number | null; returnPct: number | null; trades: number;
  takerBuyPct: number | null; fresh: boolean;
}

export interface AgreementView {
  symbol: string; quoteGroup: 'USD' | 'STABLE'; venues: number; freshVenues: number;
  agreement: number | null; majority: 'UP' | 'DOWN' | 'FLAT' | null;
  reference: string; referenceAgrees: boolean | null; divergenceBps: number | null;
  samples: number; sufficient: boolean;
}

export interface LeadLagView {
  provider: string; lagSamples: number;
  corrLag0: number | null; corrBestLag: number | null; bestLag: number | null;
  n: number; sufficient: boolean;
}

export interface ConfidenceView {
  score: number | null;
  sufficient: boolean;
  parts: Record<string, number | null>;
}

export interface XchangeFeaturesView {
  symbol: string;
  generatedAt: number;
  windowMs: number;
  venues: VenueWindowView[];
  agreement: AgreementView[];
  pressure: Array<{ provider: string; trades: number; takerBuyPct: number | null; fresh: boolean }>;
  leadLag: LeadLagView[];
  confidence: ConfidenceView;
}

export interface XchangeResponse {
  ok: boolean;
  /** false → the layer is off; features is then absent, never invented */
  enabled: boolean;
  symbol?: string;
  windowMs?: number;
  generatedAt?: number;
  monitors?: string[];
  quote?: string;
  sampleCount?: number;
  features?: XchangeFeaturesView | null;
  note?: string;
}

/** One evaluated model: metrics are PERCENTAGES except `brier` (0..1). */
export interface SourceModelMetrics {
  n: number;
  accuracyPct: number | null;
  balancedAccuracyPct: number | null;
  brier: number | null;
  calibration: Array<{ bucket: string; predictedPct: number; observedPct: number; n: number }>;
  netEdgeAfterCostPct: number | null;
  signalsTaken: number;
  correctSignals: number;
}

export interface SourceHorizonView {
  horizon: string;
  horizonMs: number;
  status: 'OK' | 'INSUFFICIENT_DATA';
  trainRows: number;
  testRows: number;
  folds: number;
  baseline: SourceModelMetrics;
  krakenOnly: SourceModelMetrics;
  krakenPlusCoinbase: SourceModelMetrics;
  incremental: {
    balancedAccuracyDeltaPct: number | null;
    brierDelta: number | null;
    netEdgeDeltaPct: number | null;
  };
  featureRedundancyR: number | null;
  note: string;
}

export interface SourcesResponse {
  ok: boolean;
  symbol?: string;
  generatedAt?: number;
  windowMs?: number;
  providers?: Array<{ provider: string; samples: number; lastTs: number | null; ageMs: number | null }>;
  freshness?: Array<{ provider: string; symbol: string; ageMs: number | null; fresh: boolean }>;
  horizons?: SourceHorizonView[];
  status?: 'OK' | 'INSUFFICIENT_DATA' | 'NO_DATA';
  note?: string;
}

export interface ContextResponse {
  ok: boolean;
  enabled: boolean;
  generatedAt?: number;
  sources?: ContextSourceView[];
  cacheEntries?: number;
  data?: Record<string, { ts: number; payload: unknown } | null>;
  note?: string;
}

/** Fixed-horizon accuracy: `pct` fields are FRACTIONS (0..1). */
export interface AccuracySideView { n: number; correct: number; pct: number | null }

export interface AccuracyHorizonView {
  key: string;
  source: string;
  horizonMs: number;
  elapsed: number;
  evaluated: number;
  flat: number;
  noData: number;
  accuracy: { BUY: AccuracySideView; SELL: AccuracySideView; overall: AccuracySideView };
  classBalance: { up: number; down: number; upPct: number | null };
  baselines: {
    alwaysUp: { n: number; pct: number | null };
    alwaysDown: { n: number; pct: number | null };
    persistence: { n: number; pct: number | null };
  };
}

export interface AccuracyResponse {
  generatedAt?: number;
  note?: string;
  signals?: { total: number; BUY: number; SELL: number };
  horizons?: AccuracyHorizonView[];
}

export const getProviders = (): Promise<ProvidersResponse> => get<ProvidersResponse>('/providers');

export const getXchange = (symbol = 'BTC', windowMs = 3_600_000): Promise<XchangeResponse> =>
  get<XchangeResponse>(`/xchange?symbol=${encodeURIComponent(symbol)}&window=${windowMs}`);

export const getSources = (symbol = 'BTC'): Promise<SourcesResponse> =>
  get<SourcesResponse>(`/sources?symbol=${encodeURIComponent(symbol)}`);

export const getContext = (): Promise<ContextResponse> => get<ContextResponse>('/context');

export const getAccuracy = (): Promise<AccuracyResponse> => get<AccuracyResponse>('/accuracy');

/* ------------------------------------------------------------------ */
/* Kalshi 15-minute engine (KXBTC15M) — read-only                      */
/* mirrors server/src/crypto/routes.ts `/kalshi15m/*`. Every field is  */
/* optional: the engine may be off ({enabled:false, note}) and the      */
/* fixtures answer '{}' for an unknown path, so consumers must default. */
/* ------------------------------------------------------------------ */

export interface K15mWindowView {
  eventTicker?: string;
  marketTicker?: string;
  openTs?: number;
  closeTs?: number;
  expireTs?: number;
  strike?: number | null;
  phase?: string;
  msToClose?: number | null;
  source?: string;
}

export interface K15mSocketView {
  live?: boolean;
  connects?: number;
  reconnects?: number;
  errors?: number;
  lastError?: string | null;
  framesSeen?: number;
  lastFrameAt?: number | null;
  stalenessMs?: number | null;
  stale?: boolean;
}

export interface K15mBookView {
  bestBid?: number | null;
  bestAsk?: number | null;
  spread?: number | null;
  imbalance?: number | null;
  ofi?: number | null;
  cancelRatio?: number | null;
  deltasInWindow?: number;
  trades1s?: number;
  qty1s?: number;
  trades5s?: number;
  qty5s?: number;
  takerBias60s?: number | null;
  levels?: { bids?: number; asks?: number };
  trusted?: boolean;
  seq?: number;
}

/** `edgePp = (p_yes - implied_mid) * 100`; `reference` is APPROXIMATION. */
export interface K15mFairValueView {
  reference?: string;
  spot?: number | null;
  sigma?: number | null;
  pYes?: number | null;
  impliedMid?: number | null;
  edgePp?: number | null;
  reason?: string | null;
  approx?: string | null;
  sigmaImplied?: number | null;
  sigmaWindowSec?: number | null;
  sigmaRealized?: number | null;
  sigmaSource?: string | null;
}

export interface K15mCounters {
  discovers?: number;
  discoverErrors?: number;
  rollOvers?: number;
  samples?: number;
  trades?: number;
  duplicateTrades?: number;
  seqGaps?: number;
  snapshotRecoveries?: number;
  restRecoveries?: number;
}

export interface K15mStrategyCounts {
  [strategy: string]: { evaluated?: number; traded?: number } | undefined;
}

/** status.shadowStrategies = { mode, enabled: {A..F}, shadowStrategies: {...} } */
export interface K15mShadowView {
  mode?: string;
  enabled?: Record<string, boolean>;
  shadowStrategies?: K15mStrategyCounts;
}

export interface K15mPaperConfig {
  enabled?: boolean;
  bankrollCents?: number;
  riskPerTradePct?: number;
  dailyLossCapPct?: number;
  maxExposurePct?: number;
  maxPositionsPerMarket?: number;
  minNetPp?: number;
  holdSec?: number;
  stopLossPp?: number;
  takeProfitPp?: number;
  reentryCooldownMs?: number;
  allowPartial?: boolean;
  maxBookAgeMs?: number;
  killSwitch?: boolean;
  haltStaleMs?: number;
}

export interface K15mStatusResponse {
  enabled?: boolean;
  series?: string;
  authenticated?: boolean;
  note?: string;
  lastError?: string | null;
  socket?: K15mSocketView;
  window?: K15mWindowView;
  book?: K15mBookView;
  fairValue?: K15mFairValueView;
  counters?: K15mCounters;
  cadence?: { sampleMs?: number; discoverMs?: number; healthMs?: number; staleMs?: number };
  strategyA?: { enabled?: boolean; mode?: string; evaluated?: number; traded?: number; skipped?: number; lastVerdict?: string | null };
  shadowStrategies?: K15mShadowView;
  sigmaPolicy?: { source?: string; impliedWindowSamples?: number; impliedRing?: number };
  paper?: { enabled?: boolean; equityCents?: number; halt?: { manual?: boolean; auto?: boolean; reason?: string | null; halts?: number } };
  counts?: Record<string, number>;
}

export interface K15mCalibrationResponse {
  enabled?: boolean;
  note?: string;
  window?: { rows?: number; limit?: number };
  config?: { sigmaSource?: string; impliedWindowSamples?: number; impliedRing?: number };
  sigma?: {
    realizedMedian?: number | null;
    impliedMedian?: number | null;
    impliedOverRealizedMedian?: number | null;
    pairedSamples?: number;
  };
  edge?: { medianPp?: number | null; p95AbsPp?: number | null; shareOver2Pp?: number | null };
  sources?: Record<string, number>;
}

export interface K15mSignalRow {
  id: number;
  ts: number;
  market_ticker?: string;
  event_ticker?: string;
  strategy?: string;
  verdict?: string;
  side?: string | null;
  expected_move_pp?: number | null;
  repriced_pp?: number | null;
  remaining_pp?: number | null;
  cost_pp?: number | null;
  net_pp?: number | null;
  tau_sec?: number | null;
  strike?: number | null;
  sigma?: number | null;
  spot_now?: number | null;
  mid_now?: number | null;
  move_bps?: number | null;
  agree?: number | null;
  skip_reason?: string | null;
  reasons?: string | null;
  phase?: string | null;
}

export interface K15mSignalsResponse {
  enabled?: boolean;
  count?: number;
  mode?: string;
  strategyAEnabled?: boolean;
  summary?: {
    window?: { rows?: number; limit?: number };
    trades?: number;
    skips?: number;
    bySide?: Record<string, number>;
    bySkipReason?: Record<string, number>;
    byStrategy?: Record<string, { trades?: number; skips?: number }> | undefined;
    tradeNetPpMedian?: number | null;
    note?: string;
  };
  signals?: K15mSignalRow[];
}

/** All money fields are CENTS (or cent-fractions): render money(cents / 100). */
export interface K15mPaperResponse {
  ok?: boolean;
  enabled?: boolean;
  mode?: string;
  config?: K15mPaperConfig;
  halt?: { manual?: boolean; auto?: boolean; reason?: string | null; halts?: number };
  equityCents?: number;
  open?: Array<{
    id?: number;
    eventTicker?: string;
    marketTicker?: string;
    strategy?: string;
    side?: string;
    qty?: number;
    entryPrice?: number;
    entryFeeC?: number;
    entryTs?: number;
  }>;
  risk?: { openCostC?: number; openPositions?: number; dailyRealizedC?: number; blockedBy?: string | null };
  closed?: {
    trades?: number;
    wins?: number;
    winRatePct?: number | null;
    netCents?: number;
    feesCents?: number;
    byExitReason?: Array<{ r: string; n: number }>;
  };
  counters?: { entries?: number; rejected?: number; exits?: number; settled?: number; halts?: number };
  rejects?: Record<string, number>;
  byStrategy?: Array<{ strategy: string; trades?: number; net_c?: number }>;
}

export const getK15mStatus = (): Promise<K15mStatusResponse> => get<K15mStatusResponse>('/kalshi15m');

export const getK15mCalibration = (limit = 2_000): Promise<K15mCalibrationResponse> =>
  get<K15mCalibrationResponse>(`/kalshi15m/calibration?limit=${limit}`);

export const getK15mSignals = (
  params: { limit?: number; summaryLimit?: number; strategy?: string } = {},
): Promise<K15mSignalsResponse> => {
  const q = new URLSearchParams();
  if (params.limit !== undefined) q.set('limit', String(params.limit));
  if (params.summaryLimit !== undefined) q.set('summary_limit', String(params.summaryLimit));
  if (params.strategy) q.set('strategy', params.strategy);
  const qs = q.toString();
  return get<K15mSignalsResponse>(`/kalshi15m/signals${qs ? `?${qs}` : ''}`);
};

export const getK15mPaper = (): Promise<K15mPaperResponse> => get<K15mPaperResponse>('/kalshi15m/paper');

/** Emergency control on the paper ledger: halt blocks every entry now. */
export const getK15mPaperAction = (action: 'halt' | 'resume'): Promise<K15mPaperResponse> =>
  get<K15mPaperResponse>(`/kalshi15m/paper?action=${action}`);
