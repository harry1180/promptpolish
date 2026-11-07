/**
 * Contract-shaped fixtures for the TradingUSA tests.
 *
 * Every payload mirrors docs/TRADINGUSA-API.md exactly. The backend is built
 * in parallel — these tests must never hit the network, so stubFetch()
 * answers every /api/tradingusa/* request from the map below (and '{}' for
 * anything unknown, which the pages must survive).
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

export const SESSION = {
  session: 'MARKET_OPEN',
  date: '2026-10-16',
  nextSession: { date: '2026-10-17', openMs: T0 + 86_400_000, closeMs: T0 + 90_000_000, earlyClose: false },
};

export const STATUS = {
  mode: 'PAPER_ONLY',
  pilotMode: true,
  executionGuard: {
    mode: 'PAPER_ONLY',
    realMoneyBlocked: true,
    adapters: ['PaperBrokerAdapter'],
    prohibited: ['broker BUY', 'broker SELL', 'options', 'crypto', 'transfers', 'deposits', 'withdrawals'],
  },
  now: T0,
  timezone: 'America/New_York',
  market: SESSION,
  providers: {
    marketData: { name: 'yahoo', status: 'CONNECTED', freshness: 'DELAYED', lastUpdate: T0, latencyMs: 42 },
  },
  jobs: [{ name: 'signals', schedule: '*/5 * * * *', lastRun: T0, lastStatus: 'ok', lastError: null, durationMs: 118 }],
  workers: { enabled: true, startedAt: T0 - 3_600_000 },
};

export const QUOTE_SPY = { symbol: 'SPY', price: 583.22, prevClose: 580.1, changePct: 0.54, ts: T0, freshness: 'DELAYED', provider: 'yahoo' };
export const QUOTE_QQQ = { symbol: 'QQQ', price: 497.11, prevClose: 500.4, changePct: -0.66, ts: T0, freshness: 'DELAYED', provider: 'yahoo' };
export const QUOTE_DIA = { symbol: 'DIA', price: 428.9, prevClose: 427.2, changePct: 0.4, ts: T0, freshness: 'DELAYED', provider: 'yahoo' };

export const SIGNAL = {
  id: 'sig_1',
  ticker: 'AAPL',
  company: 'Apple Inc.',
  portfolio: 'SHORT_TERM_PORTFOLIO',
  signal: 'BUY',
  horizon: 'SHORT_TERM',
  confidence: 0.82,
  price: 236.48,
  entryLow: 234,
  entryHigh: 238.5,
  target: 258,
  invalidation: 226.5,
  expectedReturnPct: 8.7,
  riskReward: 2.4,
  strategy: 'MOMENTUM_BREAKOUT',
  createdAt: T0,
  session: 'MARKET_OPEN',
  status: 'ACTIVE',
};

export const SIGNAL_DETAIL = {
  ...SIGNAL,
  sector: 'Technology',
  scores: { technical: 0.8, fundamental: 0.6, event: 0.5, sentiment: 0.7, macro: 0.4, regime: 0.65, risk: 0.55 },
  evidence: [
    { title: '20-day breakout confirmed on 1.8x relative volume', source: 'market_bars', weight: 0.3 },
    { title: 'Estimate revisions trending up into the print', source: 'research', weight: 0.2 },
  ],
  contradictions: [
    { title: 'RSI(14) at 74 — overbought near the entry band', source: 'technicals', weight: 0.15 },
  ],
  regime: 'RISK_ON',
  dataFreshness: 0.98,
  strategyVersion: 'mb-1.4.0',
  modelVersion: 'llm-evidence-2',
  marketSession: 'MARKET_OPEN',
  knowledgeRefs: [{ id: 'k1', title: 'Breakouts hold in risk-on regimes' }],
  eventRefs: [{ id: 'ev1', type: 'FILING', ticker: 'AAPL' }],
  llm: { used: true, provider: 'Groq', task: 'evidence synthesis', summary: 'Two independent sources agree.' },
  audit: {
    generatedAt: T0,
    inputs: { barsAsOf: T0 - 1_000_000, quoteTs: T0 - 10_000, regimeAsOf: T0 - 86_400_000 },
    riskChecks: [{ check: 'position size within limit', passed: true, detail: '1.9% of equity' }],
  },
  immutable: true,
};

const WHAT_IF = {
  startingCapital: 10000,
  currentEquity: 11234.5,
  paperProfit: 1234.5,
  tradingusaReturnPct: 12.34,
  spyReturnPct: 8.21,
  excessReturnPct: 4.13,
  trades: 100,
  wins: 42,
  losses: 48,
  other: 10,
  winRatePct: 46.67,
  maxDrawdownPct: -5.5,
};

const PORTFOLIO_METRICS = {
  startingCapital: 10000,
  currentEquity: 11234.5,
  cash: 4234.5,
  realizedPnl: 800,
  unrealizedPnl: 434.5,
  totalReturn: 0.1234,
  cagr: 0.21,
  winRate: 0.4667,
  profitFactor: 1.42,
  expectancy: 0.12,
  avgWinner: 0.031,
  avgloser: -0.018,
  sharpe: 1.31,
  sortino: 1.77,
  maxDrawdown: -0.055,
  volatility: 0.14,
  turnover: 2.4,
  exposure: 0.58,
  trades: 100,
  wins: 42,
  losses: 48,
  other: 10,
  bestTrade: 0.12,
  worstTrade: -0.05,
  benchmarkReturn: 0.0821,
  excessReturn: 0.0413,
};

const EQUITY_SERIES = [
  { ts: T0 - 5 * 86_400_000, equity: 10000 },
  { ts: T0 - 4 * 86_400_000, equity: 10420 },
  { ts: T0 - 3 * 86_400_000, equity: 10310 },
  { ts: T0 - 2 * 86_400_000, equity: 10980 },
  { ts: T0 - 86_400_000, equity: 11105 },
  { ts: T0, equity: 11234.5 },
];

const BENCH_SERIES = EQUITY_SERIES.map((p, i) => ({ ts: p.ts, equity: 10000 + i * 40 }));

export const OVERVIEW = {
  banner: 'PAPER TRADING — NO REAL MONEY IS BEING USED',
  market: SESSION,
  regime: { regime: 'RISK_ON', confidence: 0.72, components: { trend: 0.8, breadth: 0.6, volatility: 0.7 } },
  indexes: [QUOTE_SPY, QUOTE_QQQ, QUOTE_DIA],
  breadth: { advancers: 312, decliners: 188, asOf: T0 },
  volatility: { vix: 14.6 },
  opportunities: [SIGNAL],
  riskAlerts: [{ ticker: 'TSLA', alert: 'Position 2.4x average true range — size flagged', severity: 'high' }],
  events: [
    {
      id: 'ev1',
      ticker: 'AAPL',
      type: 'FILING',
      materiality: 0.8,
      sentiment: 0.35,
      firstSeen: T0 - 7_200_000,
      sources: 4,
      independentSources: 3,
      headline: 'Apple files 8-K ahead of the holiday quarter',
    },
  ],
  positions: { open: 4, exposurePct: 58.4 },
  pnl: { todayPct: 0.42, totalPct: 12.34, equitySeries: EQUITY_SERIES },
  portfolios: [
    {
      kind: 'SHORT_TERM_PORTFOLIO',
      startCapital: 10000,
      equity: 11234.5,
      totalReturnPct: 12.34,
      trades: 100,
      winRatePct: 46.67,
      maxDrawdownPct: -5.5,
      benchmarkReturnPct: 8.21,
      excessReturnPct: 4.13,
    },
    {
      kind: 'LONG_TERM_PORTFOLIO',
      startCapital: 25000,
      equity: 26980,
      totalReturnPct: 7.92,
      trades: 18,
      winRatePct: 61.11,
      maxDrawdownPct: -3.2,
      benchmarkReturnPct: 8.21,
      excessReturnPct: -0.29,
    },
  ],
  signalsToday: 6,
  llmCallsToday: 41,
  llmDependencyPct: 22.5,
  whatIf: WHAT_IF,
};

export const MARKET = {
  market: SESSION,
  regime: OVERVIEW.regime,
  indexes: [QUOTE_SPY, QUOTE_QQQ, QUOTE_DIA],
  breadth: OVERVIEW.breadth,
  volatility: { vix: 14.6 },
  yields: [{ date: '2026-10-16', y2: 3.85, y5: 3.72, y10: 4.12, y30: 4.44 }],
  curve: { spread10y2y: 0.27, asOf: '2026-10-16' },
  sectorPerformance: [
    { sector: 'Technology', ret20dPct: 4.2 },
    { sector: 'Energy', ret20dPct: -1.8 },
    { sector: 'Healthcare', ret20dPct: 1.1 },
  ],
  sessions: { today: SESSION, next: SESSION, holidayUpcoming: { date: '2026-11-26', name: 'Thanksgiving Day' } },
};

export const STOCK = {
  ticker: 'AAPL',
  company: 'Apple Inc.',
  sector: 'Technology',
  quote: { symbol: 'AAPL', price: 236.48, prevClose: 234.1, changePct: 1.02, ts: T0, freshness: 'DELAYED', provider: 'yahoo' },
  freshness: 'DELAYED',
  technicals: {
    sma20: 232.1, sma50: 228.4, sma200: 219.7, rsi14: 74.2, macdHist: 1.42, atr: 4.1, atrPct: 1.73,
    relStrength90: 8.4, relVol: 1.8, vwapPos: 0.62, breakout: '20D_HIGH', maCross: 'GOLDEN', obvTrend: 'UP',
    stochasticK: 71.5, position52w: 0.84, realizedVol: 0.22,
  },
  fundamentals: {
    revenueGrowth: 0.081, epsGrowth: 0.114, operatingMargin: 0.31, netMargin: 0.25, roe: 1.47, roic: 0.55,
    fcf: 98_000_000_000, debtToEquity: 1.87, pe: 34.2, fwdPe: 28.9, peg: 2.4, ps: 8.7, evEbitda: 24.1,
    fcfYield: 0.034, asOf: '2026-09-30', source: 'SEC filings',
  },
  scores: { quality: 0.9, growth: 0.6, valuation: 0.35, financialRisk: 0.75 },
  regime: 'RISK_ON',
  sentiment: { overall: 0.42, dimensions: { news: 0.5, earnings: 0.6, guidance: 0.2, analyst: 0.35 }, trend: 'IMPROVING' },
  events: [
    { id: 'ev1', ticker: 'AAPL', type: 'FILING', materiality: 0.8, sentiment: 0.35, headline: '8-K filed', firstSeen: T0 - 7_200_000, sources: 4, independentSources: 3 },
  ],
  news: [
    { id: 'n1', headline: 'Apple supplier checks point to a strong quarter', ts: T0 - 3_600_000, source: 'Reuters', url: 'https://www.reuters.com/example', sentiment: 0.4 },
  ],
  filings: [
    { id: 'f1', form: '10-K', filedAt: '2026-10-30', description: 'Annual report for fiscal 2026', url: 'https://www.sec.gov/example' },
  ],
  macroExposure: { yields: 0.35, betaToSpy: 1.18 },
  peers: [{ ticker: 'MSFT', ret20dPct: 2.4 }, { ticker: 'NVDA', ret20dPct: 5.1 }],
  signals: [SIGNAL],
  trades: [
    {
      ...SIGNAL,
      id: 'tr_1',
      qty: 40,
      entryPrice: 228.4,
      currentPrice: 236.48,
      unrealizedPnl: 323.2,
      returnPct: 3.54,
      stop: 221.5,
      exitPrice: 236.4,
      exitTs: T0 - 86_400_000,
      exitReason: 'TARGET',
      grossPnl: 320,
      netPnl: 318.4,
      predictedReturnPct: 6.5,
      actualReturnPct: 3.54,
      predictionErrorPct: -2.96,
      benchmarkReturnPct: 1.1,
      excessReturnPct: 2.44,
      mfe: 4.1,
      mae: -1.2,
      strategyVersion: 'mb-1.4.0',
    },
  ],
  lessons: [{ id: 'l1', title: 'Wait for volume confirmation', statement: 'Breakouts without 1.5x volume failed 6 of 8 times.', confidence: 0.78, status: 'VALIDATED' }],
  why: {
    title: 'WHY TRADINGUSA LIKES THIS',
    bullets: [
      'Price is breaking a 20-day high on 1.8x relative volume.',
      'Estimate revisions are trending up into the next print.',
    ],
  },
  counter: {
    title: 'WHAT COULD MAKE IT WRONG',
    bullets: [
      'RSI(14) at 74 leaves little room before the entry band fails.',
      'A hawkish yields spike would compress the multiple.',
    ],
  },
  currentVsKnowledge: {
    current: ['Quote is 4 minutes old (DELAYED).', '8-K filed this morning.'],
    historicalKnowledge: ['Breakouts held in risk-on regimes 7 of 10 times.', 'Prior lesson: wait for volume confirmation.'],
  },
};

export const CHART = {
  range: '1y',
  candles: Array.from({ length: 30 }, (_, i) => ({
    date: `2026-09-${String((i % 28) + 1).padStart(2, '0')}`,
    open: 200 + i,
    high: 202 + i,
    low: 198 + i,
    close: 201 + i,
    volume: 1_000_000 + i * 10_000,
  })),
};

export const PORTFOLIOS = {
  portfolios: [
    {
      kind: 'SHORT_TERM_PORTFOLIO',
      startCapital: 10000,
      equity: 11234.5,
      cash: 4234.5,
      realizedPnl: 800,
      unrealizedPnl: 434.5,
      metrics: PORTFOLIO_METRICS,
      equitySeries: EQUITY_SERIES,
      benchmark: { symbol: 'SPY', series: BENCH_SERIES, totalReturnPct: 8.21 },
    },
    {
      kind: 'LONG_TERM_PORTFOLIO',
      startCapital: 25000,
      equity: 26980,
      cash: 6980,
      realizedPnl: 1200,
      unrealizedPnl: 780,
      metrics: { ...PORTFOLIO_METRICS, cagr: null },
      equitySeries: EQUITY_SERIES,
      benchmark: { symbol: 'SPY', series: BENCH_SERIES, totalReturnPct: 8.21 },
    },
  ],
  whatIf: WHAT_IF,
};

export const POSITIONS = {
  positions: [
    {
      id: 'pos_1',
      portfolio: 'SHORT_TERM_PORTFOLIO',
      ticker: 'AAPL',
      company: 'Apple Inc.',
      qty: 40,
      entryPrice: 228.4,
      entryTs: T0 - 3 * 86_400_000,
      currentPrice: 236.48,
      unrealizedPnl: 323.2,
      returnPct: 3.54,
      target: 258,
      stop: 221.5,
      distanceToTargetPct: 9.1,
      distanceToStopPct: -6.3,
      daysHeld: 3,
      sessionsHeld: 3,
      maxFavorableExcursion: 4.1,
      maxAdverseExcursion: -1.2,
      thesisStatus: 'INTACT',
    },
  ],
};

export const TRADES = {
  trades: [
    {
      ...POSITIONS.positions[0],
      exitPrice: 236.4,
      exitTs: T0 - 86_400_000,
      exitReason: 'TARGET',
      grossPnl: 320,
      netPnl: 318.4,
      predictedReturnPct: 6.5,
      actualReturnPct: 3.54,
      predictionErrorPct: -2.96,
      benchmarkReturnPct: 1.1,
      excessReturnPct: 2.44,
      mfe: 4.1,
      mae: -1.2,
      strategyVersion: 'mb-1.4.0',
    },
  ],
  counts: { open: 4, closed: 12 },
};

export const STRATEGIES = {
  strategies: [
    {
      id: 'st_momentum',
      name: 'Momentum breakout',
      horizon: 'SHORT_TERM',
      active: true,
      champion: true,
      version: '1.4.0',
      weights: { trend: 0.4, volume: 0.35, quality: 0.25 },
      factors: ['breakout', 'relative volume', 'earnings drift'],
      performance: { trades: 100, winRatePct: 46.67, returnPct: 12.34, excessReturnPct: 4.13 },
      notes: 'Promotes only after walk-forward confirmation.',
      challengers: [{ id: 'ch_1', name: 'Momentum v2 (tighter stops)', status: 'SHADOW', observations: 128 }],
    },
  ],
};

export const RESEARCH = {
  items: [
    {
      id: 'r1',
      kind: 'EVENT',
      ticker: 'AAPL',
      title: 'Apple files 8-K ahead of the holiday quarter',
      ts: T0 - 7_200_000,
      source: 'SEC EDGAR',
      url: 'https://www.sec.gov/example',
      materiality: 0.8,
      sentiment: 0.35,
    },
  ],
  sourcesToday: 143,
};

export const SOURCES = {
  sources: [
    {
      domain: 'sec.gov',
      category: 'filings',
      url: 'https://www.sec.gov/edgar',
      retrievalMethod: 'RSS',
      reliability: 0.97,
      freshnessScore: 0.9,
      latencyMs: 412,
      failureRatePct: 0.4,
      duplicateRatePct: 2.1,
      predictiveContribution: 0.31,
      documents: 1520,
      lastChecked: T0 - 600_000,
      policyStatus: 'ROBOTS_OK',
    },
  ],
};

export const LEARNING = {
  stats: { mistakesDetected: 12, lessonsProposed: 8, lessonsValidated: 5, lessonsRejected: 2, clusters: 4, challengerRules: 3 },
  mistakes: [
    {
      id: 'm1',
      tradeId: 'tr_1',
      ticker: 'AAPL',
      kind: 'chased_entry',
      confidence: 0.8,
      rationale: 'Entered 1.4% above the stated entry band.',
      ts: T0 - 86_400_000,
      lossPct: -1.2,
      status: 'OPEN',
    },
  ],
  clusters: [{ id: 'c1', kind: 'late_entry', count: 5, confidence: 0.72, lesson: 'Wait for a pullback to the entry band.' }],
  lessons: [
    {
      id: 'l1',
      title: 'Wait for volume confirmation',
      statement: 'Breakouts below 1.5x relative volume failed 6 of 8 times.',
      confidence: 0.78,
      scope: { strategy: 'MOMENTUM_BREAKOUT', regime: 'RISK_ON' },
      status: 'VALIDATED',
      validations: 7,
      contradictions: 2,
      createdAt: T0 - 10 * 86_400_000,
    },
  ],
  ruleExtraction: [
    { id: 'rx1', condition: { relVol: { gte: 1.5 } }, action: 'allow_entry', evidenceCount: 9, status: 'CANDIDATE' },
  ],
};

export const BACKTESTS = {
  runs: [
    {
      id: 'bt_1',
      strategy: 'SHORT_TERM',
      startDate: '2024-01-01',
      endDate: '2026-01-01',
      status: 'DONE',
      totalReturnPct: 24.6,
      benchmarkReturnPct: 18.2,
      excessReturnPct: 6.4,
      maxDrawdownPct: -7.1,
      winRatePct: 47.2,
      trades: 312,
      violations: 0,
      folds: [
        { name: 'TRAIN', start: '2024-01-01', end: '2024-08-01', returnPct: 11.2, benchmarkReturnPct: 8.1, trades: 120 },
        { name: 'VALIDATION', start: '2024-08-02', end: '2024-12-31', returnPct: 5.4, benchmarkReturnPct: 4.9, trades: 82 },
        { name: 'OUT_OF_SAMPLE', start: '2025-01-01', end: '2026-01-01', returnPct: 8.0, benchmarkReturnPct: 5.2, trades: 110 },
      ],
      createdAt: T0 - 3_600_000,
    },
  ],
};

/**
 * NOTE the deliberate credential-shaped fields: the AI page must never render
 * them (allow-listed fields only), and the tests assert that too.
 */
export const AI = {
  providers: [
    {
      name: 'Groq',
      status: 'CONNECTED',
      model: 'llama-3.3-70b-versatile',
      callsToday: 41,
      callsWeek: 612,
      inputTokensToday: 812_000,
      outputTokensToday: 96_000,
      inputTokensWeek: 12_400_000,
      outputTokensWeek: 1_500_000,
      cacheHitRatePct: 63.4,
      rateLimitResetMs: 420_000,
      lastError: null,
      role: 'primary',
      apiKey: 'sk-do-not-render-this-value',
    },
    {
      name: 'Gemini',
      status: 'RATE_LIMITED',
      model: 'gemini-2.0-flash',
      callsToday: 6,
      callsWeek: 88,
      inputTokensToday: 120_000,
      outputTokensToday: 14_000,
      inputTokensWeek: 1_900_000,
      outputTokensWeek: 210_000,
      cacheHitRatePct: 41.2,
      rateLimitResetMs: null,
      lastError: '429 quota exceeded',
      role: 'secondary',
      api_key: 'GROQ_API_KEY_should_never_render',
    },
  ],
  totals: {
    callsToday: 47,
    tokensToday: 942_000,
    estCostUsd: 0.42,
    cacheHitRatePct: 61.2,
    avoidedByCache: 31,
    avoidedByLocalProcessing: 128,
    llmDependencyPct: 22.5,
  },
  budgets: {
    groqTokensPerDay: 500_000_000,
    geminiTokensPerDay: 20_000_000,
    routineCallsPerDay: 400,
    highPriorityCallsPerDay: 60,
    reservePercent: 20,
    routineRemaining: 310,
    highPriorityRemaining: 54,
  },
  ablation: {
    evaluated: 240,
    improved: 96,
    noEffect: 121,
    worse: 23,
    incrementalAlphaPct: 3.4,
    byTask: [
      { task: 'evidence synthesis', baseAccuracy: 0.61, augmentedAccuracy: 0.69, incrementalAccuracy: 0.08, calls: 120, tokens: 420_000 },
    ],
  },
  valueRouter: {
    threshold: 0.35,
    recent: [
      { task: 'summarize filing', value: 0.62, invoked: true, reason: 'value above threshold' },
      { task: 'classify headline', value: 0.12, invoked: false, reason: 'local model handles it' },
    ],
  },
  mode: 'NORMAL',
  recent: [
    { ts: T0 - 60_000, provider: 'Groq', task: 'evidence synthesis', status: 'CONNECTED', latencyMs: 840, tokens: 3200, cached: false },
  ],
};

export const SYSTEM = {
  market: SESSION,
  mode: 'PAPER_ONLY',
  pilotMode: true,
  jobs: [{ name: 'signals', schedule: '*/5 * * * *', lastRun: T0, lastStatus: 'ok', durationMs: 118, lastError: null }],
  workers: { enabled: true, startedAt: T0 - 3_600_000, ticks: 4211 },
  db: { healthy: true, sizeBytes: 24_117_248, tables: 39 },
  dataQuality: { staleQuotes: 2, lastQuoteAgeMs: 48_000, providerDisagreements: 1, missingBars: 0 },
  broker: { status: 'OK', pendingOrders: 1, openPositions: 4, mode: 'PAPER_ONLY' },
  killSwitch: { active: false, reasons: [] },
  llm: { groq: 'CONNECTED', gemini: 'RATE_LIMITED', mode: 'NORMAL' },
  dataSources: [{ name: 'yahoo-finance', status: 'ok', lastSuccess: T0 - 60_000, lastError: null }],
};

export const SETTINGS = {
  config: {
    shortTermCapital: 10000,
    longTermCapital: 25000,
    riskPerTradePct: 1.5,
    maxPositionPct: 8,
    maxSectorPct: 30,
    maxCorrelatedPct: 15,
    minRiskRewardPct: 200,
    fillMode: 'AT_SIGNAL',
    llmValueThreshold: 0.35,
    limits: { maxOpenPositions: 10, maxDailyTrades: 20 },
    universe: [
      { ticker: 'AAPL', company: 'Apple Inc.', sector: 'Technology' },
      { ticker: 'MSFT', company: 'Microsoft Corporation', sector: 'Technology' },
    ],
  },
  locked: { executionMode: 'PAPER_ONLY', realMoneyEnabled: false, brokerAdapters: ['PaperBrokerAdapter'] },
};

export const REVIEWS = {
  daily: [
    {
      date: '2026-10-15',
      signals: 6,
      opened: 2,
      closed: 3,
      wins: 2,
      losses: 1,
      dailyReturnPct: 0.42,
      benchmarkReturnPct: 0.31,
      excessReturnPct: 0.11,
      mistakes: 0,
      lessons: 1,
      errors: 0,
      llmCalls: 41,
    },
  ],
  weekly: [
    { label: '2026-W41', start: '2026-10-05', end: '2026-10-11', shortTerm: {}, longTerm: {}, system: {}, ai: {} },
  ],
};

export const SCANNER = {
  categories: [
    {
      key: 'highest_conviction',
      label: 'Highest conviction',
      note: 'Scanner inclusion is NOT a trade — signals still pass risk checks.',
      items: [{ ticker: 'AAPL', company: 'Apple Inc.', price: 236.48, changePct: 1.02, score: 0.91, reason: 'Breakout + revisions' }],
    },
    {
      key: 'risk_alerts',
      label: 'Risk alerts',
      note: 'Scanner inclusion is NOT a trade.',
      items: [],
    },
  ],
};

export const QUOTES = { quotes: [QUOTE_SPY, QUOTE_QQQ, QUOTE_DIA], asOf: T0 };

/** Contract fixture for GET /report (query strings stripped by stubFetch). */
export const REPORT = {
  from: '2026-10-10',
  to: '2026-10-16',
  days: [
    {
      date: '2026-10-13', regime: 'BULL_TREND', scans: 4, signals: 3, orders: 2,
      opened: 2, closed: 1, wins: 1, losses: 0, winRatePct: 100, avgWinPct: 2.1,
      avgLossPct: null, expectancyPct: 2.1, stops: 0, targets: 1, netPnl: 210,
      equity: 100210, blockedRegime: 2, blockedLowConfidence: 5, blockedLesson: 0,
    },
    {
      date: '2026-10-14', regime: 'LOW_VOLATILITY', scans: 4, signals: 1, orders: 1,
      opened: 1, closed: 1, wins: 0, losses: 1, winRatePct: 0, avgWinPct: null,
      avgLossPct: -1.2, expectancyPct: -1.2, stops: 1, targets: 0, netPnl: -120,
      equity: 100090, blockedRegime: 0, blockedLowConfidence: 3, blockedLesson: 1,
    },
  ],
  totals: {
    days: 7, signals: 4, orders: 3, opened: 3, closed: 2, wins: 1, losses: 1,
    winRatePct: 50, expectancyPct: 0.45, stops: 1, targets: 1, netPnl: 90,
    blockedRegime: 2, blockedLowConfidence: 8, blockedLesson: 1,
  },
};

/** Contract fixture for GET /experiments (query strings stripped by stubFetch). */
export const EXPERIMENTS = {
  from: '2026-07-18',
  to: '2026-10-16',
  signals: 42,
  closedTrades: 30,
  note: 'Shadow mode — these experiments observe outcomes only. Nothing is blocked; a verdict needs 10 matched closed trades, and any graduation can only add conviction to a proven setup, never remove trades.',
  conditions: [
    {
      key: 'volume_confirmed', label: 'Volume-confirmed entry',
      description: 'Relative volume >= 1.15 at entry — the lesson the system already enforces.',
      evaluableSignals: 42, matchedSignals: 24, matchedClosed: 18,
      matchedWinRatePct: 61.1, matchedAvgReturnPct: 1.9,
      baselineClosed: 12, baselineWinRatePct: 41.7, baselineAvgReturnPct: -0.4,
      deltaReturnPct: 2.3, status: 'PROMOTE_CANDIDATE',
    },
    {
      key: 'high_confidence', label: 'High fused confidence',
      description: 'Signal confidence at or above 0.75.',
      evaluableSignals: 42, matchedSignals: 20, matchedClosed: 9,
      matchedWinRatePct: 55.6, matchedAvgReturnPct: 1.1,
      baselineClosed: 21, baselineWinRatePct: 47.6, baselineAvgReturnPct: 0.2,
      deltaReturnPct: 0.9, status: 'OBSERVING',
    },
    {
      key: 'event_alignment', label: 'Fresh material event',
      description: 'A positive, high-materiality event inside the last 3 sessions.',
      evaluableSignals: 6, matchedSignals: 6, matchedClosed: 4,
      matchedWinRatePct: 25, matchedAvgReturnPct: -0.8,
      baselineClosed: 0, baselineWinRatePct: null, baselineAvgReturnPct: null,
      deltaReturnPct: null, status: 'OBSERVING',
    },
  ],
};

const ROUTES: Record<string, unknown> = {
  '/api/tradingusa/report': REPORT,
  '/api/tradingusa/experiments': EXPERIMENTS,
  '/api/tradingusa/status': STATUS,
  '/api/tradingusa/overview': OVERVIEW,
  '/api/tradingusa/quotes': QUOTES,
  '/api/tradingusa/market': MARKET,
  '/api/tradingusa/signals': { total: 1, signals: [SIGNAL] },
  '/api/tradingusa/signals/sig_1': SIGNAL_DETAIL,
  '/api/tradingusa/scanner': SCANNER,
  '/api/tradingusa/stocks/AAPL': STOCK,
  '/api/tradingusa/stocks/AAPL/chart': CHART,
  '/api/tradingusa/events': { events: OVERVIEW.events },
  '/api/tradingusa/portfolios': PORTFOLIOS,
  '/api/tradingusa/positions': POSITIONS,
  '/api/tradingusa/trades': TRADES,
  '/api/tradingusa/strategies': STRATEGIES,
  '/api/tradingusa/research': RESEARCH,
  '/api/tradingusa/sources': SOURCES,
  '/api/tradingusa/learning': LEARNING,
  '/api/tradingusa/backtests': BACKTESTS,
  '/api/tradingusa/ai': AI,
  '/api/tradingusa/system': SYSTEM,
  '/api/tradingusa/settings': SETTINGS,
  '/api/tradingusa/reviews': REVIEWS,
};

/** Stub global fetch with contract-shaped answers (query strings stripped). */
export function stubFetch(overrides: Record<string, unknown> = {}): void {
  const impl = async (input: RequestInfo | URL): Promise<Response> => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = raw.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    if (path in overrides) return jsonResponse(overrides[path]);
    if (path in ROUTES) return jsonResponse(ROUTES[path]);
    return jsonResponse({});
  };
  vi.stubGlobal('fetch', vi.fn(impl));
}

/** Navigate like the shell does: pushState + popstate. */
export function goto(to: string): void {
  window.history.pushState({}, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
}