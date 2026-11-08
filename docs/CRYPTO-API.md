# Crypto API — `/pp/api/crypto/*`

The 24/7 spot **paper** book. Mounted by `createApp` next to `/api/tradingusa/`;
served at the edge under `/pp/api/crypto/*`.

Contracts:

- `executionMode` is always `PAPER_ONLY` (from `CryptoConfig`, never from a request).
- The book is a single portfolio kind: `CRYPTO_SPOT` (long-only, no leverage, no shorting).
- All endpoints are `GET` except `POST /run`, which executes exactly one scheduler
  cycle (the same work the timer runs anyway).
- `from`/`to` dates are `YYYY-MM-DD`; `from > to` → `400`.

## GET `/status`

```jsonc
{
  "ok": true,
  "executionMode": "PAPER_ONLY",
  "portfolioKind": "CRYPTO_SPOT",
  "session": "MARKET_OPEN",        // crypto has one session: always open
  "alwaysOpen": true,
  "provider": { "name": "kraken", "status": "CONNECTED", "lastUpdate": 1760000000000,
                "lastLatencyMs": 31, "lastError": null },
  "stream": { "live": true, "symbols": 25 },   // live = websocket transport
  "universe": { "members": 25, "active": 25, "pinned": [...], "ranked": [...],
                "changes": [{ "ts": 1760000000000, "action": "ADD", "symbol": "SOL" }] },
  "counts": { "quotes": 25, "bars": 18200, "signals": 12,
              "openPositions": 3, "closedTrades": 5 },
  "jobs": [{ "name": "signal_scan", "schedule": "crypto", "last_run": 1760000000000,
             "last_status": "OK", "duration_ms": 240, "last_error": null, "runs": 96 }],
  "recentErrors": [{ "job": "bar_backfill", "at": 1760000000000, "message": "kraken HTTP 502" }]
}
```

## GET `/overview`

Portfolio, benchmark and the paper ledger. `returnPct` and every trade return are
**fee-inclusive** (exchange taker fee charged on entry and exit).

```jsonc
{
  "portfolio": { "kind": "CRYPTO_SPOT", "startCapital": 100000, "cash": 78400.55,
                 "equity": 101842.11, "unrealized": 1204.3, "exposure": 23441.56,
                 "returnPct": 1.84, "createdAt": 1760000000000 },
  "benchmark": { "symbol": "BTC", "price": 76661.9, "startPrice": 74120.0,
                 "equity": 103427.55, "returnPct": 3.43 },   // buy-and-hold BTC
  "stats": { "closed": 5, "wins": 2, "winRatePct": 40,
             "winRateCiLowPct": 11.8, "winRateCiHighPct": 76.9,   // Wilson 95%, null when closed = 0
             "netPnl": 412.9, "avgReturnPct": 0.82,
             "feesPaid": 38.4, "avgHoldSessions": 4.2 },
  "positions": [ /* PositionRowView[] — see below */ ],
  "recentTrades": [ /* TradeRowView[] (10 newest) */ ],
  "snapshotAt": 1760000000000
}
```

`PositionRowView`: `id, ticker, company, qty, entryPrice, entryTs, entrySession,
currentPrice, unrealized, unrealizedPct, stop, target, maxHold, sessionsHeld,
mfe, mae, thesisStatus, predictedReturn, entryFee, signalId`.

`TradeRowView`: `id, ticker, side, qty, entryPrice, entryTs, exitPrice, exitTs,
exitReason, netPnl, grossPnl, returnPct, benchmarkReturnPct, excessReturnPct,
predictedReturnPct, predictionError, holdingSessions, strategy, capital, status`.

**The win rate never travels alone.** `winRatePct` is a point estimate over
`closed` trades; `winRateCiLowPct`/`winRateCiHighPct` are its Wilson 95%
interval and are `null` while nothing has closed. 0 wins in 4 closes is `0%`
with an interval of `[0%, 60%]` — "no information yet", not a system that
never wins. The UI always renders the sample and the interval next to the
rate (`4 closes`, `2 of 5 · CI 11.8–76.9%`).

## GET `/quotes`

Every active universe member, with rank/pinned flags:

```jsonc
{ "count": 2, "quotes": [{ "symbol": "BTC", "price": 76661.9, "prevClose": 77114,
  "changePct": -0.59, "bid": 76661.8, "ask": 76661.9, "ts": 1760000000000,
  "provider": "kraken-ws", "freshness": "REALTIME", "pinned": true, "rank": 1,
  "active": true }] }
```

## GET `/universe`

```jsonc
{ "members": 25, "active": 25, "pinned": ["BTC","ETH","XRP","DOGE","XLM","SHIB"],
  "ranked": ["SOL","BNB", "... 19 slots total"], "changes": [ /* last 20 ADD/DROP/SEED */ ] }
```

## GET `/signals`

Query: `limit` (default 50), `signal` (`BUY|SELL`), `date` (`YYYY-MM-DD`).

```jsonc
{ "count": 1, "signals": [{ "id": 12, "ticker": "BTC", "signal": "BUY",
  "confidence": 0.81, "price": 74900, "entryLow": 74500, "entryHigh": 75200,
  "target": 82000, "invalidation": 71000, "expectedReturnPct": 9.48, "riskReward": 2.3,
  "strategy": "crypto_momentum_v1", "createdAt": 1760000000000, "session": "MARKET_OPEN",
  "status": "ACTIVE", "regime": "MOMENTUM", "dataFreshness": 0.98,
  "signalDate": "2026-11-03", "portfolio": "CRYPTO_SPOT" }] }
```

One signal per (symbol, strategy, horizon, session, action) — re-scans are
deduplicated and counted, never re-emitted.

## GET `/positions`

```jsonc
{ "count": 1, "positions": [ /* PositionRowView[] — open only */ ] }
```

## GET `/trades`

Query: `limit` (default 50). Includes the same `stats` block as `/overview`.

```jsonc
{ "count": 1, "stats": { /* TradeStats */ }, "trades": [ /* TradeRowView[] */ ] }
```

## GET `/portfolio`

Equity curve for the UI chart (last 500 snapshots, oldest first):

```jsonc
{ "count": 2, "points": [{ "ts": 1760000000000, "equity": 100000, "cash": 100000,
                           "unrealized": 0, "benchmark": 100000 }] }
```

## GET `/learning`

What this book has taught itself. Weights are read from **this database only**
(`strategy_weights` row for `crypto_momentum_v1`/`SHORT`).

```jsonc
{
  "strategy": "crypto_momentum_v1",
  "horizon": "SHORT",
  "fusionWeights": { "defaults": { "technical": 0.38, "fundamental": 0.18, "event": 0.14,
                                   "sentiment": 0.08, "macro": 0.06, "regime": 0.16 },
                     "learned": null,        // null until the evidence floor is met
                     "sufficient": false,    // MIN_TRADES = 10 closed outcomes
                     "trades": 0, "updatedAt": null },
  "lessonsByStatus": [{ "status": "PROPOSED", "n": 2 }],
  "outcomesRecorded": 0,
  "weightRefits": 0,
  "note": "Outcomes from the crypto book refit crypto weights only (MIN_TRADES floor, ±35% bound)."
}
```

## GET `/experiments`

Shadow-mode rule experiments (read-only by contract). Query: `from` (default
90 days ago), `to` (default today).

```jsonc
{
  "from": "2026-08-06", "to": "2026-11-03",
  "signals": 42, "closedTrades": 7,
  "note": "Shadow mode — these experiments observe outcomes only. Nothing is blocked.",
  "conditions": [{
    "key": "relative_strength", "label": "Relative strength",
    "description": "top-quartile 20d return vs BTC",
    "evaluableSignals": 42, "matchedSignals": 18, "matchedClosed": 4,
    "matchedWinRatePct": 50, "matchedAvgReturnPct": 4.2,
    "baselineClosed": 3, "baselineWinRatePct": 33.3, "baselineAvgReturnPct": 1.1,
    "deltaReturnPct": 3.1,          // matched avg − rest avg, percentage points
    "status": "PROMOTE_CANDIDATE"   // OBSERVING | PROMOTE_CANDIDATE | NO_EDGE
  }]
}
```

Graduation, if it ever happens, can only bias conviction **up** — no experiment
can block or remove a trade.

## GET `/shadow`

The top-K entry-ranking **recorder** (SHADOW — it never gates a trade).
Each scan ranks its BUY candidates by the continuous technical score and
marks the best `k` (`CRYPTO_TOPK_K`, default 3) as `selected`, so the
"enter only the best 3 per scan" idea can be measured against real outcomes
before it is ever allowed to filter anything. Production confidence is a
constant 0.514, so it cannot rank — the score can.

```jsonc
{
  "enabled": true, "k": 3, "mode": "shadow",
  "decisionImpact": "NONE — every BUY still trades; this table only records what a top-K rule would have kept",
  "recorded": 12,        // BUY signals ranked since deploy
  "selected": 5,         // rows inside the top 3
  "takenByProduction": 12, // production ordered all of them (unchanged behaviour)
  "outcomes": [          // closed-trade results split by selected/not
    { "selected": 1, "n": 3, "wins": 2, "netPnl": 214.5 },
    { "selected": 0, "n": 2, "wins": 0, "netPnl": -88.1 }
  ],
  "recent": [ /* newest 20 rows: ts, session_date, signal_id, ticker, score,
                 confidence, rank, selected, order_created */ ]
}
```

Knobs: `CRYPTO_TOPK_SHADOW` (default `1`; `0` stops the recorder) and
`CRYPTO_TOPK_K` (default 3, capped at 25). Rows live in `shadow_topk`, keyed
`UNIQUE(signal_id)`; nothing on the decision path reads that table, so the
trade flow is identical with the recorder on or off (proven by
`test/crypto-engine.test.ts`: same tape, recorder on vs off → same signals,
same orders).

## GET `/jobs`

```jsonc
{ "count": 9, "jobs": [{ "name": "knowledge", "schedule": "crypto",
  "last_run": 1760000000000, "last_status": "OK", "duration_ms": 84,
  "last_error": null, "runs": 41 }] }
```

## POST `/run`

Runs one scheduler pass immediately (same work as the timer) and reports:

```jsonc
{ "ok": true, "signalsCreated": 1,
  "snapshot": { "equity": 101842.11, "cash": 78400.55, "unrealized": 1204.3,
                "benchmark": 103427.55 },
  "jobs": [ /* JobRow[] after the run */ ] }
```

## Errors

Unknown path → `404 { "error": "unknown crypto endpoint" }`.
Route failures → `500 { "error": "<message>" }` (no stack, no env values).