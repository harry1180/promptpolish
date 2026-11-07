/**
 * TradingUSA core domain types.
 *
 * DOM-free and network-free: imported by both the server (running under
 * Node's type stripping — so NO enums, NO parameter properties, NO
 * namespaces; only erasable TS) and the web bundle.
 */

export type SessionKind =
  | 'PREMARKET'
  | 'MARKET_OPEN'
  | 'POSTMARKET'
  | 'MARKET_CLOSED'
  | 'WEEKEND'
  | 'HOLIDAY'
  | 'EARLY_CLOSE';

export type Horizon = 'SHORT' | 'SWING' | 'MEDIUM' | 'LONG';

export type PortfolioKind = 'SHORT_TERM_PORTFOLIO' | 'LONG_TERM_PORTFOLIO';

export type SignalAction =
  | 'BUY'
  | 'SELL'
  | 'HOLD'
  | 'WATCH'
  | 'REDUCE'
  | 'EXIT'
  | 'NO_TRADE'
  | 'CONFLICTING_SIGNAL'
  | 'INSUFFICIENT_DATA';

export type Regime =
  | 'BULL_TREND'
  | 'BEAR_TREND'
  | 'RISK_ON'
  | 'RISK_OFF'
  | 'HIGH_VOLATILITY'
  | 'LOW_VOLATILITY'
  | 'MOMENTUM'
  | 'MEAN_REVERSION'
  | 'LIQUIDITY_STRESS'
  | 'RECOVERY'
  | 'UNCERTAIN';

export type ProviderStatus =
  | 'CONNECTED'
  | 'UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'QUOTA_EXHAUSTED'
  | 'DEGRADED'
  | 'CIRCUIT_OPEN'
  | 'LOCAL_ONLY'
  | 'ERROR';

export type ExitReason =
  | 'TARGET_REACHED'
  | 'STOP_REACHED'
  | 'TRAILING_STOP'
  | 'SELL_SIGNAL'
  | 'THESIS_INVALIDATED'
  | 'TIME_LIMIT'
  | 'REGIME_CHANGE'
  | 'RISK_EXIT';

export type MistakeKind =
  | 'BAD_ENTRY'
  | 'BAD_EXIT'
  | 'FALSE_BREAKOUT'
  | 'NEWS_MISINTERPRETATION'
  | 'FUNDAMENTAL_ERROR'
  | 'REGIME_CHANGE'
  | 'VOLATILITY_SPIKE'
  | 'EVENT_RISK'
  | 'SOURCE_FAILURE'
  | 'STALE_INFORMATION'
  | 'BAD_POSITION_SIZING'
  | 'OVERCONFIDENCE'
  | 'CORRELATION_ERROR'
  | 'MACRO_ERROR'
  | 'TECHNICAL_SIGNAL_FAILURE'
  | 'UNKNOWN';

export type EventType =
  | 'EARNINGS'
  | 'GUIDANCE_CHANGE'
  | 'GUIDANCE_REDUCTION'
  | 'MA'
  | 'MANAGEMENT_CHANGE'
  | 'CONTRACT'
  | 'PRODUCT_LAUNCH'
  | 'FDA'
  | 'LAWSUIT'
  | 'REGULATORY'
  | 'SEC_FILING'
  | 'INSIDER_TRANSACTION'
  | 'ANALYST_CHANGE'
  | 'DIVIDEND_CHANGE'
  | 'BUYBACK'
  | 'OFFERING'
  | 'DEBT_ISSUANCE'
  | 'LAYOFFS'
  | 'CYBER_INCIDENT'
  | 'INVESTIGATION'
  | 'MACRO'
  | 'GEOPOLITICAL'
  | 'GENERAL';

/** Daily OHLCV bar (adjusted for splits at ingest). */
export interface Candle {
  date: string; // YYYY-MM-DD (ET session date)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Quote {
  symbol: string;
  price: number;
  prevClose: number;
  ts: number; // epoch ms of the observation
  bid?: number;
  ask?: number;
  volume?: number;
  provider?: string;
  freshness?: 'REALTIME' | 'DELAYED' | 'EOD';
}

export interface EvidenceItem {
  kind: string; // e.g. 'relative_strength', 'event:GUIDANCE_REDUCTION'
  detail: string;
  weight: number; // 0..1
  positive: boolean;
  ref?: string; // event id / doc id / indicator name
}

/** Component scores before fusion, each in [-1, 1] (0 = neutral/no data). */
export interface ScoreParts {
  technical: number;
  fundamental: number;
  event: number;
  sentiment: number;
  macro: number;
  regime: number;
}

export interface SignalDraft {
  ticker: string;
  company: string;
  strategy: string; // strategy id, e.g. 'st_momentum_v1'
  horizon: Horizon;
  signal: SignalAction;
  confidence: number; // 0..1
  price: number;
  entryLow: number;
  entryHigh: number;
  target: number;
  invalidation: number;
  expectedUpside: number; // fraction, e.g. 0.098
  expectedDownside: number; // fraction, positive number
  riskReward: number;
  expectedHoldSessions: number;
  maxHoldSessions: number;
  scores: ScoreParts & { risk: number };
  evidence: EvidenceItem[];
  contradictions: EvidenceItem[];
  regime: Regime;
  dataFreshness: number; // 0..1
}

/** Risk gate result for a candidate entry. */
export interface RiskDecision {
  approved: boolean;
  sizeShares: number;
  riskAmount: number; // virtual USD at risk (entry→stop)
  notional: number;
  reasons: string[]; // rejection/veto reasons (approved => [])
}

export interface FillResult {
  filled: boolean;
  price: number;
  slippage: number; // fraction of price
  notional: number;
  note: string;
  pendingUntil?: number; // epoch ms when a deferred fill would execute
}

/** Equity curve point for metrics. */
export interface EquityPoint {
  ts: number;
  equity: number;
}

export interface TradeRecord {
  id: number;
  ticker: string;
  portfolio: PortfolioKind;
  side: 'LONG' | 'SHORT';
  qty: number;
  entryPrice: number;
  entryTs: number;
  exitPrice: number | null;
  exitTs: number | null;
  exitReason: ExitReason | null;
  target: number;
  stop: number;
  maxHoldSessions: number;
  predictedReturn: number;
}

export interface PortfolioMetrics {
  startingCapital: number;
  currentEquity: number;
  cash: number;
  realizedPnl: number;
  unrealizedPnl: number;
  totalReturn: number; // fraction
  cagr: number | null;
  winRate: number | null;
  profitFactor: number | null;
  expectancy: number | null;
  avgWinner: number | null;
  avgloser: number | null;
  sharpe: number | null;
  sortino: number | null;
  maxDrawdown: number; // negative fraction
  volatility: number | null; // annualized fraction
  turnover: number;
  exposure: number; // fraction of equity in positions
  trades: number;
  wins: number;
  losses: number;
  other: number;
  bestTrade: number | null;
  worstTrade: number | null;
  benchmarkReturn: number; // SPY return over same window, fraction
  excessReturn: number;
}

export interface LlmValueInput {
  novelty: number; // 0..1
  materiality: number; // 0..1
  portfolioExposure: number; // 0..1
  strategyImportance: number; // 0..1
  modelDisagreement: number; // 0..1
  currentUncertainty: number; // 0..1
  historicalLlmBenefit: number; // 0..1 (tracked from ablation results)
  informationComplexity: number; // 0..1
}

export interface ComputeBudget {
  quotePollMs: number;
  featureIntervalMs: number;
  crawlIntervalMs: number;
  mlIntervalMs: number;
  llmAllowed: boolean;
  maxRoutineLlmCalls: number;
  intradayEnabled: boolean;
  markToMarketEnabled: boolean;
}

export const EXECUTION_MODE = 'PAPER_ONLY' as const;
export type ExecutionMode = typeof EXECUTION_MODE;

/**
 * Point-in-time fundamental snapshot for a ticker.
 *
 * `asOf` is the data date (YYYY-MM-DD), `source` the provider id. Every
 * numeric field is nullable: null means "not available" and consumers must
 * treat it as neutral, never as zero. Canonical location is this file because
 * both the short- and long-term strategies (and the server's snapshots table)
 * share it.
 */
export interface FundamentalSnapshot {
  ticker: string;
  asOf: string;
  source: string;
  revenueGrowth: number | null;
  epsGrowth: number | null;
  operatingMargin: number | null;
  netMargin: number | null;
  grossMargin: number | null;
  roe: number | null;
  roic: number | null;
  fcf: number | null;
  operatingCashFlow: number | null;
  cash: number | null;
  totalDebt: number | null;
  debtToEquity: number | null;
  interestCoverage: number | null;
  sharesOutstanding: number | null;
  dilutionPct: number | null;
  buybackPct: number | null;
  pe: number | null;
  fwdPe: number | null;
  peg: number | null;
  ps: number | null;
  evEbitda: number | null;
  fcfYield: number | null;
}