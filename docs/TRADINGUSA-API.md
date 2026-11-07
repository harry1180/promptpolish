# TradingUSA HTTP API contract

Base path on the server: `/api/tradingusa/*`. At the edge it is served under
`https://governance.agenticalchemy.io/pp/api/tradingusa/*` (Traefik strips
`/pp`). The SPA calls `(import.meta.env.VITE_API_BASE ?? '') + '/api/tradingusa'`.

All endpoints are GET (read-only from the browser; no auth required — this is
a public research/paper dashboard) except `POST /backtests` (rate-limited).
Errors use the house shape `{ "errors": ["message"] }` with 4xx/5xx.
Every response is `cache-control: no-store` JSON.

**Security invariants (tested):** no response body ever contains
`GROQ_API_KEY`, `GEMINI_API_KEY`, or any secret material. Provider health is
always one of the status enums
`CONNECTED | UNAVAILABLE | RATE_LIMITED | QUOTA_EXHAUSTED | DEGRADED | CIRCUIT_OPEN | LOCAL_ONLY | ERROR`.
`executionMode` is always `"PAPER_ONLY"`.

## Common shapes

Session: `{ session: "PREMARKET"|"MARKET_OPEN"|"POSTMARKET"|"MARKET_CLOSED"|"WEEKEND"|"HOLIDAY"|"EARLY_CLOSE", date: "YYYY-MM-DD", nextSession: { date, openMs, closeMs, earlyClose } }`

Quote: `{ symbol, price, prevClose, changePct, ts, freshness: "DELAYED", provider: "yahoo" }`

Signal (list row): `{ id, ticker, company, portfolio, signal, horizon, confidence, price, entryLow, entryHigh, target, invalidation, expectedReturnPct, riskReward, strategy, createdAt, session, status: "ACTIVE"|"EXECUTED"|"EXPIRED" }`
Signal is IMMUTABLE once created (timestamp, price, target, invalidation,
confidence, evidence, versions frozen server-side).

Position: `{ id, portfolio, ticker, company, qty, entryPrice, entryTs, currentPrice, unrealizedPnl, returnPct, target, stop, distanceToTargetPct, distanceToStopPct, daysHeld, sessionsHeld, maxFavorableExcursion, maxAdverseExcursion, thesisStatus }`

Trade (closed): position fields + `{ exitPrice, exitTs, exitReason, grossPnl, netPnl, predictedReturnPct, actualReturnPct, predictionErrorPct, benchmarkReturnPct, excessReturnPct, mfe, mae, strategyVersion }`

Portfolio: `{ kind: "SHORT_TERM_PORTFOLIO"|"LONG_TERM_PORTFOLIO", startCapital, equity, cash, realizedPnl, unrealizedPnl, metrics: PortfolioMetrics, equitySeries: [{ts, equity}], benchmark: {symbol:"SPY", series:[{ts, equity}], totalReturnPct} }`
`PortfolioMetrics` = the tucore type (startingCapital, currentEquity, cash,
realizedPnl, unrealizedPnl, totalReturn, cagr, winRate, profitFactor,
expectancy, avgWinner, avgloser, sharpe, sortino, maxDrawdown, volatility,
turnover, exposure, trades, wins, losses, other, bestTrade, worstTrade,
benchmarkReturn, excessReturn — fractions, null when not meaningful).

## Endpoints

### GET /status
```
{ mode:"PAPER_ONLY", pilotMode:true,
  executionGuard:{ mode:"PAPER_ONLY", realMoneyBlocked:true, adapters:["PaperBrokerAdapter"], prohibited:["broker BUY","broker SELL","options","crypto","transfers","deposits","withdrawals"] },
  now, timezone:"America/New_York",
  market: Session, 
  providers:{ marketData:{ name, status, freshness, lastUpdate, latencyMs } },
  jobs:[{ name, lastRun, lastStatus:"ok"|"error"|"never", lastError }],
  workers:{ enabled, startedAt } }
```

### GET /overview
```
{ banner:"PAPER TRADING — NO REAL MONEY IS BEING USED",
  market: Session,
  regime:{ regime, confidence, components },
  indexes:[Quote] (SPY,QQQ,DIA),
  breadth:{ advancers, decliners, asOf }|null,
  volatility:{ vix:number|null },
  opportunities:[ signal rows, top 6 by confidence ],
  riskAlerts:[{ ticker, alert, severity:"high"|"medium" }],
  events:[{ id, ticker, type, materiality, sentiment, firstSeen, sources, independentSources, headline }],
  positions:{ open:number, exposurePct },
  pnl:{ todayPct, totalPct, equitySeries:[{ts,equity}] last 60 },
  portfolios:[{ kind, startCapital, equity, totalReturnPct, trades, winRatePct, maxDrawdownPct, benchmarkReturnPct, excessReturnPct }] (2),
  signalsToday, llmCallsToday, llmDependencyPct,
  whatIf:{ startingCapital, currentEquity, paperProfit, tradingusaReturnPct, spyReturnPct, excessReturnPct, trades, wins, losses, other, winRatePct, maxDrawdownPct } }
```

### GET /quotes?symbols=AAPL,MSFT  → `{ quotes:[Quote], asOf }`

### GET /market
```
{ market: Session, regime, indexes:[Quote], breadth|null, volatility,
  yields:[{ date, y2, y5, y10, y30 }], curve:{ spread10y2y, asOf }|null,
  sectorPerformance:[{ sector, ret20dPct }],
  sessions:{ today, next, holidayUpcoming:{date,name}|null } }
```

### GET /signals?portfolio=&signal=&strategy=&horizon=&confidenceMin=&limit=&offset=
→ `{ total, signals:[SignalRow] }`

### GET /signals/:id
Full signal: all SignalRow fields + `{ company, sector, scores:{technical,fundamental,event,sentiment,macro,regime,risk}, evidence:[EvidenceItem], contradictions:[EvidenceItem], regime, dataFreshness, strategyVersion, modelVersion, marketSession, knowledgeRefs:[{id,title}], eventRefs:[{id,type,ticker}], llm:{ used:boolean, provider, task, summary }|null, audit:{ generatedAt, inputs:{ barsAsOf, quoteTs, regimeAsOf }, riskChecks:[{check,passed,detail}] }, immutable:true }`

### GET /scanner
`{ categories:[{ key, label, note, items:[{ ticker, company, price, changePct, score, reason }] }] }`
keys: `highest_conviction, new_momentum, breakouts, post_earnings, fundamental_improvement, quality_value, oversold_quality, deterioration, risk_alerts, compounders`.
Note on each category: inclusion is not a trade.

### GET /stocks/:ticker
```
{ ticker, company, sector, quote, freshness,
  technicals:{ sma20, sma50, sma200, rsi14, macdHist, atr, atrPct, relStrength90, relVol, vwapPos, breakout, maCross, obvTrend, stochasticK, position52w, realizedVol },
  fundamentals:{ revenueGrowth, epsGrowth, operatingMargin, netMargin, roe, roic, fcf, debtToEquity, pe, fwdPe, peg, ps, evEbitda, fcfYield, asOf, source } (nullable fields),
  scores:{ quality, growth, valuation, financialRisk },
  regime, sentiment:{ overall, dimensions:{ news, earnings, guidance, analyst }, trend:"IMPROVING"|"STABLE"|"DETERIORATING" },
  events:[EventRow], news:[{ id, headline, ts, source, url, sentiment }], filings:[{ id, form, filedAt, description, url }],
  macroExposure:{ yields, betaToSpy }|null,
  peers:[{ ticker, ret20dPct }],
  signals:[SignalRow], trades:[TradeRow], lessons:[{ id, title, statement, confidence, status }],
  why:{ title:"WHY TRADINGUSA LIKES THIS", bullets:[string] },
  counter:{ title:"WHAT COULD MAKE IT WRONG", bullets:[string] },
  currentVsKnowledge:{ current:[string], historicalKnowledge:[string] } }
```
`GET /stocks/:ticker/chart?range=1y|6mo|3mo|1mo` → `{ candles:[{date,open,high,low,close,volume}], range }`

### GET /events?ticker=&type=&limit=
→ `{ events:[{ id, ticker, type, materiality, sentiment, headline, firstSeen, lastUpdated, sources, independentSources, confidence, expectedHorizon }] }`

### GET /portfolios  → `{ portfolios:[Portfolio], whatIf:{...per /overview} }`
### GET /positions?portfolio=  → `{ positions:[Position] }`
### GET /trades?portfolio=&status=open|closed  → `{ trades:[TradeRow], counts:{open,closed} }`

### GET /report?from=&to=   (both `YYYY-MM-DD`, optional — default = last 14 days, max 400 days; 400 on malformed input)
Day-by-day metrics for any range: `{ from, to, days:[{ date, regime, scans, signals, orders, opened, closed, wins, losses, winRatePct, avgWinPct, avgLossPct, expectancyPct, stops, targets, netPnl, equity, blockedRegime, blockedLowConfidence, blockedLesson }], totals:{ days, signals, orders, opened, closed, wins, losses, winRatePct, expectancyPct, stops, targets, netPnl, blockedRegime, blockedLowConfidence, blockedLesson } }`. All `*Pct` fields are ALREADY-PERCENT (server convention); `netPnl`/`equity` are dollars; win/avg/expectancy fields are `null` when the day (or range) has no closed trades; `blocked*` counters come from the per-scan audit trail (regime gate / confidence floor / lesson gate). Days are ET session dates.

### GET /strategies
`{ strategies:[{ id, name, horizon:"SHORT_TERM"|"LONG_TERM", active, champion, version, weights, factors:[string], performance:{ trades, winRatePct, returnPct, excessReturnPct }, notes, challengers:[{ id, name, status:"SHADOW"|"BACKTEST"|"CANDIDATE", observations }] }] }`

### GET /research
`{ items:[{ id, kind:"EVENT"|"FILING"|"NEWS"|"MACRO", ticker, title, ts, source, url, materiality, sentiment }] , sourcesToday }`

### GET /sources
`{ sources:[{ domain, category, url, retrievalMethod, reliability, freshnessScore, latencyMs, failureRatePct, duplicateRatePct, predictiveContribution, documents, lastChecked, policyStatus:"ROBOTS_OK"|"MANUAL_REVIEW"|"DISABLED" }] }`

### GET /learning
```
{ stats:{ mistakesDetected, lessonsProposed, lessonsValidated, lessonsRejected, clusters, challengerRules },
  mistakes:[{ id, tradeId, ticker, kind, confidence, rationale, ts, lossPct, status }],
  clusters:[{ id, kind, count, confidence, lesson }],
  lessons:[{ id, title, statement, confidence, scope:{ strategy?, sector?, ticker?, regime?, eventType? }, status:"CANDIDATE"|"VALIDATED"|"REJECTED"|"EXPIRED", validations, contradictions, createdAt }],
  ruleExtraction:[{ id, condition, action, evidenceCount, status }],
  fusionWeights:[{ strategy, horizon, trades, updatedAt, weights:{ technical, fundamental, event, sentiment, macro, regime }, defaults:{...same keys} }] }
```
`fusionWeights` is what `runScan` currently passes to fusion (learned, band-limited,
see `adaptive.ts`); absent when a strategy has fewer than 10 closed outcomes.

### GET /experiments?from=&to=   (both `YYYY-MM-DD`, optional — same range rules as `/report`)
Shadow-mode rule experiments: each measurable setup vs the rest of the window,
**read-only — the server writes nothing for this endpoint and no experiment can
block or alter a trade.**
```
{ from, to, signals, closedTrades, note,
  conditions:[{ key, label, description, evaluableSignals, matchedSignals,
                matchedClosed, matchedWinRatePct, matchedAvgReturnPct,
                baselineClosed, baselineWinRatePct, baselineAvgReturnPct,
                deltaReturnPct, status:"OBSERVING"|"PROMOTE_CANDIDATE"|"NO_EDGE" }] }
```
`deltaReturnPct` = matched average minus baseline average, in percentage points;
`null` when either side has no closed trades. A status other than `OBSERVING`
requires `matchedClosed >= 10`. `PROMOTE_CANDIDATE` never changes live
behaviour — graduation is a separate, reviewed step that may only add
conviction, never remove trades.

### GET /backtests
`{ runs:[{ id, strategy, startDate, endDate, status:"RUNNING"|"DONE"|"ERROR", totalReturnPct, benchmarkReturnPct, excessReturnPct, maxDrawdownPct, winRatePct, trades, violations, folds:[{name,start,end,returnPct,benchmarkReturnPct,trades}], createdAt }] }`
POST `/backtests` body `{ strategy:"SHORT_TERM"|"LONG_TERM", startDate, endDate }` → `{ runId }` (429 if a run is already active or >1/min/IP).

### GET /ai
```
{ providers:[{ name:"Groq"|"Gemini", status, model, callsToday, callsWeek, inputTokensToday, outputTokensToday, inputTokensWeek, outputTokensWeek, cacheHitRatePct, rateLimitResetMs|null, lastError|null, role:"primary"|"secondary" }],
  totals:{ callsToday, tokensToday, estCostUsd, cacheHitRatePct, avoidedByCache, avoidedByLocalProcessing, llmDependencyPct },
  budgets:{ groqTokensPerDay, geminiTokensPerDay, routineCallsPerDay, highPriorityCallsPerDay, reservePercent, routineRemaining, highPriorityRemaining },
  ablation:{ evaluated, improved, noEffect, worse, incrementalAlphaPct|null, byTask:[{ task, baseAccuracy, augmentedAccuracy, incrementalAccuracy, calls, tokens }] },
  valueRouter:{ threshold, recent:[{ task, value, invoked, reason }] },
  mode:"NORMAL"|"LOCAL_ONLY",
  recent:[{ ts, provider, task, status, latencyMs, tokens, cached }] }
```

### GET /system
```
{ market: Session, mode:"PAPER_ONLY", pilotMode,
  jobs:[{ name, schedule, lastRun, lastStatus, durationMs, lastError }],
  workers:{ enabled, startedAt, ticks },
  db:{ healthy, sizeBytes, tables },
  dataQuality:{ staleQuotes, lastQuoteAgeMs, providerDisagreements, missingBars },
  broker:{ status:"OK", pendingOrders, openPositions, mode:"PAPER_ONLY" },
  killSwitch:{ active, reasons },
  llm:{ groq: status, gemini: status, mode },
  dataSources:[{ name, status, lastSuccess, lastError }] }
```

### GET /settings
```
{ config:{ shortTermCapital, longTermCapital, riskPerTradePct, maxPositionPct, maxSectorPct, maxCorrelatedPct, minRiskRewardPct, fillMode:"AT_SIGNAL"|"NEXT_OPEN", llmValueThreshold, limits:{...DEFAULT_LIMITS}, universe:[{ ticker, company, sector }] },
  locked:{ executionMode:"PAPER_ONLY", realMoneyEnabled:false, brokerAdapters:["PaperBrokerAdapter"] } }
```

### GET /reviews
`{ daily:[{ date, signals, opened, closed, wins, losses, dailyReturnPct, benchmarkReturnPct, excessReturnPct, mistakes, lessons, errors, llmCalls }], weekly:[{ label, start, end, shortTerm:{...}, longTerm:{...}, system:{ observations, events, signals, trades }, ai:{ groqCalls, geminiCalls, tokens, cacheHits, dependencyPct } }] }`