/**
 * TradingUSA HTTP client — typed strictly against docs/TRADINGUSA-API.md.
 *
 * BASE is derived from VITE_API_BASE (empty in dev) plus the TradingUSA API
 * prefix — never a hardcoded origin. Every failure throws ApiError carrying
 * the FIRST entry of the server's `{ errors: [...] }` payload so callers can
 * render an honest message. Requests abort after 10s.
 *
 * The browser only ever issues GET requests except POST /backtests, which the
 * contract explicitly allows (rate-limited server-side).
 */

export const API: string = (import.meta.env.VITE_API_BASE ?? '') + '/api/tradingusa';

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
      const body = (await res.json()) as { errors?: unknown };
      if (Array.isArray(body?.errors) && typeof body.errors[0] === 'string') message = body.errors[0];
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

function post<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/* ------------------------------------------------------------------ */
/* contract shapes                                                     */
/* ------------------------------------------------------------------ */

export type ProviderStatus =
  | 'CONNECTED'
  | 'UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'QUOTA_EXHAUSTED'
  | 'DEGRADED'
  | 'CIRCUIT_OPEN'
  | 'LOCAL_ONLY'
  | 'ERROR';

export type SessionKind =
  | 'PREMARKET'
  | 'MARKET_OPEN'
  | 'POSTMARKET'
  | 'MARKET_CLOSED'
  | 'WEEKEND'
  | 'HOLIDAY'
  | 'EARLY_CLOSE';

export interface NextSession {
  date: string;
  openMs: number | null;
  closeMs: number | null;
  earlyClose?: boolean | null;
}

export interface Session {
  session: SessionKind;
  date: string;
  nextSession?: NextSession | null;
}

export interface Quote {
  symbol: string;
  price: number | null;
  prevClose: number | null;
  changePct: number | null;
  ts: number | string | null;
  freshness?: string | null;
  provider?: string | null;
}

export interface ExecutionGuard {
  mode: string;
  realMoneyBlocked: boolean;
  adapters: string[];
  prohibited: string[];
}

export interface ProviderHealth {
  name?: string;
  status: ProviderStatus;
  freshness?: string | null;
  lastUpdate?: number | string | null;
  latencyMs?: number | null;
}

export interface JobStatus {
  name: string;
  schedule?: string | null;
  lastRun?: number | string | null;
  lastStatus?: 'ok' | 'error' | 'never' | string | null;
  lastError?: string | null;
  durationMs?: number | null;
}

export interface StatusResponse {
  mode: string;
  pilotMode: boolean;
  executionGuard: ExecutionGuard;
  now: number | string;
  timezone: string;
  market: Session;
  providers: { marketData?: ProviderHealth; [key: string]: ProviderHealth | undefined };
  jobs: JobStatus[];
  workers: { enabled: boolean; startedAt: number | string | null };
}

export interface RegimeInfo {
  regime: string | null;
  confidence: number | null;
  components?: Record<string, number | null> | null;
}

export interface Breadth {
  advancers: number | null;
  decliners: number | null;
  asOf?: number | string | null;
}

export type SignalStatus = 'ACTIVE' | 'EXECUTED' | 'EXPIRED';

export interface SignalRow {
  id: string;
  ticker: string;
  company: string;
  portfolio: string;
  signal: string;
  horizon: string;
  confidence: number | null;
  price: number | null;
  entryLow: number | null;
  entryHigh: number | null;
  target: number | null;
  invalidation: number | null;
  expectedReturnPct: number | null;
  riskReward: number | null;
  strategy: string;
  createdAt: number | string | null;
  session?: string | null;
  status: SignalStatus | string;
}

/** Evidence rows are free-form server-side; render only known fields. */
export interface EvidenceItem {
  title?: string | null;
  text?: string | null;
  detail?: string | null;
  source?: string | null;
  weight?: number | null;
}

export interface SignalScores {
  technical?: number | null;
  fundamental?: number | null;
  event?: number | null;
  sentiment?: number | null;
  macro?: number | null;
  regime?: number | null;
  risk?: number | null;
}

export interface SignalDetail extends SignalRow {
  sector?: string | null;
  scores: SignalScores;
  evidence: EvidenceItem[];
  contradictions: EvidenceItem[];
  regime?: string | null;
  dataFreshness?: number | null;
  strategyVersion?: string | null;
  modelVersion?: string | null;
  marketSession?: string | null;
  knowledgeRefs: Array<{ id: string; title?: string | null }>;
  eventRefs: Array<{ id: string; type?: string | null; ticker?: string | null }>;
  llm?: { used: boolean; provider?: string | null; task?: string | null; summary?: string | null } | null;
  audit?: {
    generatedAt?: number | string | null;
    inputs?: Record<string, number | string | null> | null;
    riskChecks?: Array<{ check?: string | null; passed?: boolean | null; detail?: string | null }>;
  } | null;
  immutable?: boolean;
}

export interface EventRow {
  id: string;
  ticker?: string | null;
  type: string;
  materiality: number | null;
  sentiment: number | null;
  headline: string;
  firstSeen?: number | string | null;
  lastUpdated?: number | string | null;
  sources?: number | null;
  independentSources?: number | null;
  confidence?: number | null;
  expectedHorizon?: string | null;
}

export interface OverviewResponse {
  banner?: string;
  market: Session;
  regime: RegimeInfo;
  indexes: Quote[];
  breadth: Breadth | null;
  volatility: { vix: number | null };
  opportunities: SignalRow[];
  riskAlerts: Array<{ ticker: string; alert: string; severity: 'high' | 'medium' | string }>;
  events: EventRow[];
  positions: { open: number | null; exposurePct: number | null };
  pnl: { todayPct: number | null; totalPct: number | null; equitySeries: Array<{ ts: number | string; equity: number | null }> };
  portfolios: PortfolioSummary[];
  signalsToday: number | null;
  llmCallsToday: number | null;
  llmDependencyPct?: number | null;
  whatIf: WhatIf;
}

export interface WhatIf {
  startingCapital: number | null;
  currentEquity: number | null;
  paperProfit: number | null;
  tradingusaReturnPct: number | null;
  spyReturnPct: number | null;
  excessReturnPct: number | null;
  trades: number | null;
  wins: number | null;
  losses: number | null;
  other: number | null;
  winRatePct: number | null;
  maxDrawdownPct: number | null;
}

export interface PortfolioSummary {
  kind: string;
  startCapital: number | null;
  equity: number | null;
  totalReturnPct: number | null;
  trades: number | null;
  winRatePct: number | null;
  maxDrawdownPct: number | null;
  benchmarkReturnPct: number | null;
  excessReturnPct: number | null;
}

export interface QuotesResponse {
  quotes: Quote[];
  asOf?: number | string | null;
}

export interface MarketResponse {
  market: Session;
  regime: RegimeInfo;
  indexes: Quote[];
  breadth: Breadth | null;
  volatility: { vix: number | null };
  yields: Array<{ date: string; y2: number | null; y5: number | null; y10: number | null; y30: number | null }>;
  curve: { spread10y2y: number | null; asOf?: number | string | null } | null;
  sectorPerformance: Array<{ sector: string; ret20dPct: number | null }>;
  sessions: {
    today?: Session | null;
    next?: Session | null;
    holidayUpcoming?: { date: string; name: string } | null;
  };
}

export interface SignalsResponse {
  total: number;
  signals: SignalRow[];
}

export interface SignalQuery {
  portfolio?: string;
  signal?: string;
  strategy?: string;
  horizon?: string;
  confidenceMin?: number;
  limit?: number;
  offset?: number;
}

export interface ScannerItem {
  ticker: string;
  company: string;
  price: number | null;
  changePct: number | null;
  score: number | null;
  reason?: string | null;
}

export interface ScannerResponse {
  categories: Array<{ key: string; label: string; note?: string | null; items: ScannerItem[] }>;
}

export interface Technicals {
  sma20?: number | null;
  sma50?: number | null;
  sma200?: number | null;
  rsi14?: number | null;
  macdHist?: number | null;
  atr?: number | null;
  atrPct?: number | null;
  relStrength90?: number | null;
  relVol?: number | null;
  vwapPos?: number | null;
  breakout?: string | boolean | null;
  maCross?: string | boolean | null;
  obvTrend?: string | boolean | null;
  stochasticK?: number | null;
  position52w?: number | null;
  realizedVol?: number | null;
}

export interface Fundamentals {
  revenueGrowth?: number | null;
  epsGrowth?: number | null;
  operatingMargin?: number | null;
  netMargin?: number | null;
  roe?: number | null;
  roic?: number | null;
  fcf?: number | null;
  debtToEquity?: number | null;
  pe?: number | null;
  fwdPe?: number | null;
  peg?: number | null;
  ps?: number | null;
  evEbitda?: number | null;
  fcfYield?: number | null;
  asOf?: string | number | null;
  source?: string | null;
}

export interface StockResponse {
  ticker: string;
  company: string;
  sector: string;
  quote: Quote | null;
  freshness?: string | null;
  technicals: Technicals;
  fundamentals: Fundamentals;
  scores: { quality?: number | null; growth?: number | null; valuation?: number | null; financialRisk?: number | null };
  regime?: string | null;
  sentiment: {
    overall?: number | string | null;
    dimensions?: Record<string, number | string | null> | null;
    trend?: string | null;
  };
  events: EventRow[];
  news: Array<{ id: string; headline: string; ts?: number | string | null; source?: string | null; url?: string | null; sentiment?: number | null }>;
  filings: Array<{ id: string; form: string; filedAt?: number | string | null; description?: string | null; url?: string | null }>;
  macroExposure?: { yields?: unknown; betaToSpy?: number | null } | null;
  peers: Array<{ ticker: string; ret20dPct: number | null }>;
  signals: SignalRow[];
  trades: TradeRow[];
  lessons: Array<{ id: string; title: string; statement?: string | null; confidence?: number | null; status?: string | null }>;
  why: { title: string; bullets: string[] };
  counter: { title: string; bullets: string[] };
  currentVsKnowledge: { current: string[]; historicalKnowledge: string[] };
}

export interface ChartResponse {
  candles: Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }>;
  range: string;
}

export interface Position {
  id: string;
  portfolio: string;
  ticker: string;
  company: string;
  qty: number | null;
  entryPrice: number | null;
  entryTs: number | string | null;
  currentPrice: number | null;
  unrealizedPnl: number | null;
  returnPct: number | null;
  target: number | null;
  stop: number | null;
  distanceToTargetPct?: number | null;
  distanceToStopPct?: number | null;
  daysHeld?: number | null;
  sessionsHeld?: number | null;
  maxFavorableExcursion?: number | null;
  maxAdverseExcursion?: number | null;
  thesisStatus?: string | null;
}

export interface TradeRow extends Position {
  exitPrice?: number | null;
  exitTs?: number | string | null;
  exitReason?: string | null;
  grossPnl?: number | null;
  netPnl?: number | null;
  predictedReturnPct?: number | null;
  actualReturnPct?: number | null;
  predictionErrorPct?: number | null;
  benchmarkReturnPct?: number | null;
  excessReturnPct?: number | null;
  mfe?: number | null;
  mae?: number | null;
  strategyVersion?: string | null;
}

export interface PortfolioMetrics {
  startingCapital: number | null;
  currentEquity: number | null;
  cash: number | null;
  realizedPnl: number | null;
  unrealizedPnl: number | null;
  totalReturn: number | null;
  cagr: number | null;
  winRate: number | null;
  profitFactor: number | null;
  expectancy: number | null;
  avgWinner: number | null;
  avgloser: number | null;
  sharpe: number | null;
  sortino: number | null;
  maxDrawdown: number | null;
  volatility: number | null;
  turnover: number | null;
  exposure: number | null;
  trades: number | null;
  wins: number | null;
  losses: number | null;
  other: number | null;
  bestTrade: number | null;
  worstTrade: number | null;
  benchmarkReturn: number | null;
  excessReturn: number | null;
}

export interface Portfolio {
  kind: string;
  startCapital: number | null;
  equity: number | null;
  cash: number | null;
  realizedPnl: number | null;
  unrealizedPnl: number | null;
  metrics: PortfolioMetrics;
  equitySeries: Array<{ ts: number | string; equity: number | null }>;
  benchmark: { symbol: string; series: Array<{ ts: number | string; equity: number | null }>; totalReturnPct: number | null };
}

export interface PortfoliosResponse {
  portfolios: Portfolio[];
  whatIf?: WhatIf;
}

export interface PositionsResponse {
  positions: Position[];
}

export interface TradesResponse {
  trades: TradeRow[];
  counts: { open: number | null; closed: number | null };
}

export interface StrategyPerf {
  trades?: number | null;
  winRatePct?: number | null;
  returnPct?: number | null;
  excessReturnPct?: number | null;
}

export interface Strategy {
  id: string;
  name: string;
  horizon: string;
  active: boolean;
  champion: boolean;
  version: string | null;
  weights?: Record<string, number | null> | null;
  factors: string[];
  performance: StrategyPerf;
  notes?: string | null;
  challengers: Array<{ id: string; name: string; status: string; observations?: number | null }>;
}

export interface StrategiesResponse {
  strategies: Strategy[];
}

export interface ResearchItem {
  id: string;
  kind: string;
  ticker?: string | null;
  title: string;
  ts?: number | string | null;
  source?: string | null;
  url?: string | null;
  materiality?: number | null;
  sentiment?: number | null;
}

export interface ResearchResponse {
  items: ResearchItem[];
  sourcesToday?: number | null;
}

export interface SourceRow {
  domain: string;
  category: string;
  url?: string | null;
  retrievalMethod?: string | null;
  reliability: number | null;
  freshnessScore: number | null;
  latencyMs: number | null;
  failureRatePct: number | null;
  duplicateRatePct: number | null;
  predictiveContribution: number | null;
  documents: number | null;
  lastChecked?: number | string | null;
  policyStatus: string;
}

export interface SourcesResponse {
  sources: SourceRow[];
}

export interface LearningResponse {
  stats: {
    mistakesDetected?: number | null;
    lessonsProposed?: number | null;
    lessonsValidated?: number | null;
    lessonsRejected?: number | null;
    clusters?: number | null;
    challengerRules?: number | null;
  };
  mistakes: Array<{
    id: string;
    tradeId?: string | number | null;
    ticker?: string | null;
    kind: string;
    confidence?: number | null;
    rationale?: string | null;
    ts?: number | string | null;
    lossPct?: number | null;
    status?: string | null;
  }>;
  clusters: Array<{ id: string; kind: string; count?: number | null; confidence?: number | null; lesson?: string | null }>;
  lessons: Array<{
    id: string;
    title: string;
    statement: string;
    confidence?: number | null;
    scope?: { strategy?: string | null; sector?: string | null; ticker?: string | null; regime?: string | null; eventType?: string | null } | null;
    status: string;
    validations?: number | null;
    contradictions?: number | null;
    createdAt?: number | string | null;
  }>;
  ruleExtraction: Array<{ id: string; condition: unknown; action?: string | null; evidenceCount?: number | null; status?: string | null }>;
  /** Learned fusion weights currently passed to fuse() by runScan, each with
   *  the shipped defaults it moved away from (see server adaptive.ts). */
  fusionWeights?: Array<{
    strategy: string;
    horizon: string;
    trades?: number | null;
    updatedAt?: number | string | null;
    weights?: Record<string, number | null> | null;
    defaults?: Record<string, number | null> | null;
  }> | null;
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

export interface BacktestFold {
  name: string;
  start?: string;
  end?: string;
  returnPct?: number | null;
  benchmarkReturnPct?: number | null;
  trades?: number | null;
}

export interface BacktestRun {
  id: string;
  strategy: string;
  startDate: string;
  endDate: string;
  status: string;
  totalReturnPct?: number | null;
  benchmarkReturnPct?: number | null;
  excessReturnPct?: number | null;
  maxDrawdownPct?: number | null;
  winRatePct?: number | null;
  trades?: number | null;
  violations?: number | null;
  folds: BacktestFold[];
  createdAt?: number | string | null;
}

export interface BacktestsResponse {
  runs: BacktestRun[];
}

export interface BacktestRequest {
  strategy: string;
  startDate: string;
  endDate: string;
}

export interface AiProvider {
  name: string;
  status: ProviderStatus;
  model?: string | null;
  callsToday?: number | null;
  callsWeek?: number | null;
  inputTokensToday?: number | null;
  outputTokensToday?: number | null;
  inputTokensWeek?: number | null;
  outputTokensWeek?: number | null;
  cacheHitRatePct?: number | null;
  rateLimitResetMs?: number | null;
  lastError?: string | null;
  role?: string | null;
}

export interface AiResponse {
  providers: AiProvider[];
  totals: {
    callsToday?: number | null;
    tokensToday?: number | null;
    estCostUsd?: number | null;
    cacheHitRatePct?: number | null;
    avoidedByCache?: number | null;
    avoidedByLocalProcessing?: number | null;
    llmDependencyPct?: number | null;
  };
  budgets: {
    groqTokensPerDay?: number | null;
    geminiTokensPerDay?: number | null;
    routineCallsPerDay?: number | null;
    highPriorityCallsPerDay?: number | null;
    reservePercent?: number | null;
    routineRemaining?: number | null;
    highPriorityRemaining?: number | null;
  };
  ablation: {
    evaluated?: number | null;
    improved?: number | null;
    noEffect?: number | null;
    worse?: number | null;
    incrementalAlphaPct?: number | null;
    byTask: Array<{ task: string; baseAccuracy?: number | null; augmentedAccuracy?: number | null; incrementalAccuracy?: number | null; calls?: number | null; tokens?: number | null }>;
  };
  valueRouter: {
    threshold?: number | null;
    recent: Array<{ task: string; value?: number | null; invoked?: boolean | null; reason?: string | null }>;
  };
  mode: string;
  recent: Array<{ ts?: number | string | null; provider?: string | null; task?: string | null; status?: string | null; latencyMs?: number | null; tokens?: number | null; cached?: boolean | null }>;
}

export interface SystemResponse {
  market: Session;
  mode: string;
  pilotMode?: boolean;
  jobs: JobStatus[];
  workers: { enabled?: boolean; startedAt?: number | string | null; ticks?: number | null };
  db: { healthy?: boolean | null; sizeBytes?: number | null; tables?: number | null };
  dataQuality: { staleQuotes?: number | null; lastQuoteAgeMs?: number | null; providerDisagreements?: number | null; missingBars?: number | null };
  broker: { status?: string | null; pendingOrders?: number | null; openPositions?: number | null; mode?: string | null };
  killSwitch: { active?: boolean | null; reasons?: string[] | null };
  llm: { groq?: ProviderStatus | string | null; gemini?: ProviderStatus | string | null; mode?: string | null };
  dataSources: Array<{ name: string; status?: string | null; lastSuccess?: number | string | null; lastError?: string | null }>;
}

export interface SettingsResponse {
  config: {
    shortTermCapital?: number | null;
    longTermCapital?: number | null;
    riskPerTradePct?: number | null;
    maxPositionPct?: number | null;
    maxSectorPct?: number | null;
    maxCorrelatedPct?: number | null;
    minRiskRewardPct?: number | null;
    fillMode?: string | null;
    llmValueThreshold?: number | null;
    limits?: Record<string, unknown> | null;
    universe?: Array<{ ticker: string; company: string; sector: string }>;
  };
  locked: {
    executionMode: string;
    realMoneyEnabled: boolean;
    brokerAdapters: string[];
  };
}

export interface DailyReview {
  date: string;
  signals?: number | null;
  opened?: number | null;
  closed?: number | null;
  wins?: number | null;
  losses?: number | null;
  dailyReturnPct?: number | null;
  benchmarkReturnPct?: number | null;
  excessReturnPct?: number | null;
  /** true while the session's SPY bar has not landed yet — benchmark and
   *  excess are null (rendered "—") instead of a misleading 0% */
  benchmarkPending?: boolean | null;
  mistakes?: number | null;
  lessons?: number | null;
  errors?: number | null;
  llmCalls?: number | null;
}

export interface ReviewsResponse {
  daily: DailyReview[];
  weekly: Array<{
    label: string;
    start?: string | null;
    end?: string | null;
    shortTerm?: Record<string, unknown> | null;
    longTerm?: Record<string, unknown> | null;
    system?: Record<string, unknown> | null;
    ai?: Record<string, unknown> | null;
  }>;
}

/** One row per day; all *Pct fields are ALREADY-PERCENT, netPnl/equity in dollars. */
export interface ReportDay {
  date: string;
  regime: string | null;
  scans: number;
  signals: number;
  orders: number;
  opened: number;
  closed: number;
  wins: number;
  losses: number;
  winRatePct: number | null;
  avgWinPct: number | null;
  avgLossPct: number | null;
  expectancyPct: number | null;
  stops: number;
  targets: number;
  netPnl: number | null;
  equity: number | null;
  blockedRegime: number;
  blockedLowConfidence: number;
  blockedLesson: number;
}

export interface ReportTotals {
  days: number;
  signals: number;
  orders: number;
  opened: number;
  closed: number;
  wins: number;
  losses: number;
  winRatePct: number | null;
  expectancyPct: number | null;
  stops: number;
  targets: number;
  netPnl: number;
  blockedRegime: number;
  blockedLowConfidence: number;
  blockedLesson: number;
}

export interface ReportResponse {
  from: string;
  to: string;
  days: ReportDay[];
  totals: ReportTotals;
}

/* ------------------------------------------------------------------ */
/* endpoints                                                           */
/* ------------------------------------------------------------------ */

export function getStatus(): Promise<StatusResponse> {
  return get<StatusResponse>('/status');
}

export function getOverview(): Promise<OverviewResponse> {
  return get<OverviewResponse>('/overview');
}

export function getQuotes(symbols: string[]): Promise<QuotesResponse> {
  return get<QuotesResponse>(`/quotes?symbols=${encodeURIComponent(symbols.join(','))}`);
}

export function getMarket(): Promise<MarketResponse> {
  return get<MarketResponse>('/market');
}

export function getSignals(query: SignalQuery = {}): Promise<SignalsResponse> {
  const params = new URLSearchParams();
  if (query.portfolio) params.set('portfolio', query.portfolio);
  if (query.signal) params.set('signal', query.signal);
  if (query.strategy) params.set('strategy', query.strategy);
  if (query.horizon) params.set('horizon', query.horizon);
  if (query.confidenceMin !== undefined) params.set('confidenceMin', String(query.confidenceMin));
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.offset !== undefined) params.set('offset', String(query.offset));
  const qs = params.toString();
  return get<SignalsResponse>(`/signals${qs ? `?${qs}` : ''}`);
}

export function getSignal(id: string): Promise<SignalDetail> {
  return get<SignalDetail>(`/signals/${encodeURIComponent(id)}`);
}

export function getScanner(): Promise<ScannerResponse> {
  return get<ScannerResponse>('/scanner');
}

export function getStock(ticker: string): Promise<StockResponse> {
  return get<StockResponse>(`/stocks/${encodeURIComponent(ticker)}`);
}

export function getChart(ticker: string, range = '1y'): Promise<ChartResponse> {
  return get<ChartResponse>(`/stocks/${encodeURIComponent(ticker)}/chart?range=${encodeURIComponent(range)}`);
}

export function getEvents(query: { ticker?: string; type?: string; limit?: number } = {}): Promise<{ events: EventRow[] }> {
  const params = new URLSearchParams();
  if (query.ticker) params.set('ticker', query.ticker);
  if (query.type) params.set('type', query.type);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  const qs = params.toString();
  return get<{ events: EventRow[] }>(`/events${qs ? `?${qs}` : ''}`);
}

export function getPortfolios(): Promise<PortfoliosResponse> {
  return get<PortfoliosResponse>('/portfolios');
}

export function getPositions(portfolio?: string): Promise<PositionsResponse> {
  const qs = portfolio ? `?portfolio=${encodeURIComponent(portfolio)}` : '';
  return get<PositionsResponse>(`/positions${qs}`);
}

export function getTrades(query: { portfolio?: string; status?: string } = {}): Promise<TradesResponse> {
  const params = new URLSearchParams();
  if (query.portfolio) params.set('portfolio', query.portfolio);
  if (query.status) params.set('status', query.status);
  const qs = params.toString();
  return get<TradesResponse>(`/trades${qs ? `?${qs}` : ''}`);
}

export function getStrategies(): Promise<StrategiesResponse> {
  return get<StrategiesResponse>('/strategies');
}

export function getResearch(): Promise<ResearchResponse> {
  return get<ResearchResponse>('/research');
}

export function getSources(): Promise<SourcesResponse> {
  return get<SourcesResponse>('/sources');
}

export function getLearning(): Promise<LearningResponse> {
  return get<LearningResponse>('/learning');
}

export function getBacktests(): Promise<BacktestsResponse> {
  return get<BacktestsResponse>('/backtests');
}

export function postBacktest(body: BacktestRequest): Promise<{ runId: string | number }> {
  return post<{ runId: string | number }>('/backtests', body);
}

export function getAi(): Promise<AiResponse> {
  return get<AiResponse>('/ai');
}

export function getSystem(): Promise<SystemResponse> {
  return get<SystemResponse>('/system');
}

export function getSettings(): Promise<SettingsResponse> {
  return get<SettingsResponse>('/settings');
}

export function getReviews(): Promise<ReviewsResponse> {
  return get<ReviewsResponse>('/reviews');
}

export function getReport(from: string, to: string): Promise<ReportResponse> {
  return get<ReportResponse>(`/report?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
}

export function getExperiments(from: string, to: string): Promise<ExperimentsResponse> {
  return get<ExperimentsResponse>(`/experiments?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
}