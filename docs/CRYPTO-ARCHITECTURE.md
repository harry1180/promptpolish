# Crypto module — architecture

A second paper-trading book next to TradingUSA: 24/7 spot crypto, long-only,
no leverage, fee-aware, with the same outcome-learning loop. Separate database,
separate scheduler, separate UI at `/crypto` (edge: `/pp/crypto`).

## Module layout (`apps/server/src/crypto/`)

| file | responsibility |
|---|---|
| `config.ts` | `CryptoConfig` — every knob `CRYPTO_`-prefixed; `executionMode` is `EXECUTION_MODE` (`PAPER_ONLY`); `CRYPTO_SESSION = 'MARKET_OPEN'` (always open) |
| `schema.ts` | opens `/data/crypto.db`, reuses the TradingUSA DDL verbatim (`export const DDL`) + crypto-only tables (`crypto_universe`, `crypto_universe_log`, `paper_positions.entry_fee` with an add-once guard) |
| `universe.ts` | pinned 6 + 19 ranked slots, hysteresis (7d out to drop, 3d in to add), Kraken `AssetPairs` tradability, CoinGecko market-cap ranking, `XBT→BTC`/`XDG→DOGE` normalization, state persistence |
| `providers/kraken.ts` | REST: batch tickers (canonical pair keys), paginated daily OHLCV |
| `providers/kraken-provider.ts` | `KrakenProvider` implementing `CryptoMarketDataProvider` (injectable deps → tests never hit the network) |
| `stream.ts` | Kraken **websocket** ticker channel for the whole universe + automatic 5s REST fallback while the socket is down, backoff reconnect, `updateSymbols()` re-subscribe on membership change |
| `engine.ts` | features → `shortTermScore` (benchmark BTC) → `fuse` with the **crypto book's own learned weights** → risk sizing → signals → spot orders; one scan audit row per pass |
| `broker.ts` | fee-aware fills (buy the ask / sell the bid; liquidity-scaled slippage when no book), fee-inclusive `net_pnl`/`return_pct`, BTC benchmark, 24/7 order processing + position monitoring, daily-bar settle |
| `workers.ts` | `CryptoScheduler` — due-gated job cycle (below) + `snapshotEquity` + `refreshUniverse` |
| `runtime.ts` | `CryptoRuntime` — DB + provider + stream + scheduler; workers only under `CRYPTO_WORKERS=1` |
| `routes.ts` | `/api/crypto/*` (see `docs/CRYPTO-API.md`); `/entrygate` reports the entry-gate state and `overview.calibration` the predicted-vs-realized diagnostic |
| `calibrate.ts` | walk-forward **entry threshold** over the recorded signal history — evidence floor, fixed feature order, `INSUFFICIENT_DATA` rather than an invented cut (see `docs/CRYPTO-ENTRY-GATE.md`) |
| `confirm.ts` | pre-order **confirmation gate**: pullback from the Kraken tape + Kraken-vs-Coinbase direction read from `xchange_samples`; missing/stale data passes and says so |
| `tape.ts` | `TickTape` — bounded in-memory per-symbol window fed by the stream's `tickObservers` (observer only: no socket, no poll, no writes) |

Web: `apps/web/src/crypto/` — shell (`index.tsx`), routing/data (`data.tsx`),
client (`api.ts`), 6 pages (`Overview, Market, Signals, Paper Trading,
Learning, System`), mounted by `main.tsx` on `/crypto/*`. Shared components
come from `apps/web/src/tradingusa/ui.tsx`.

## Data flow

```
Kraken websocket (primary) ──┐
Kraken REST every 5s (fallback) ─┴→ ingestTick → market_quotes / market_features
Kraken REST daily OHLCV (10min) ───→ market_bars (universe + BTC)
                                              │
                runCryptoScan (5min, 24/7) ◄──┘
                   shortTermScore (benchmark = BTC)
                   → fuse(weights from strategy_weights: crypto book)
                   → evaluateEntry (risk, liquidity, volatility)
                   → signals + paper_orders (PENDING, BUY only)
                                              │
processOrders (15s): fee-aware fill → paper_positions (+ entry_fee) → cash
monitorPositions (10s): mark, MFE/MAE, checkExit (price/stop/target/trailing)
settleHourly: daily-bar exits; knowledge(30m): learnFromOutcome (once per
  trade, marked in audit_log) → refreshKnowledge → strategy_weights refit
```

## What is deliberately different from TradingUSA

- **Sessions:** none. The scheduler gates by due time, never by session kind;
  `sessions_held` counts calendar days because daily bars are daily.
- **Benchmark:** BTC buy-and-hold with the same starting capital (there is no
  SPY). `tu_config.btc_start` pins the benchmark entry price at first snapshot.
- **Fees:** modeled on both sides (default `CRYPTO_FEE_PCT = 0.0025`). A round
  trip costs ~0.5%, so `net_pnl`/`return_pct` are fee-inclusive everywhere —
  including what the learning loop sees.
- **Regime:** derived from BTC's tape and stored on the signal, but **not
  gating** in v1 (there is no `market_regimes` table for crypto). Exits run on
  price, ATR-widened stop, target, trailing stop and max hold.
- **Score parts:** `fundamental/event/sentiment/macro` are `0` in v1 (no news
  or rates pipeline for crypto yet). Fusion still runs with them present, so
  when those sources arrive the weights are already wired.
- **No LLM in the hot path** — same rule as TradingUSA: strategy decisions are
  code, LLM is interpretation only (and crypto has no news pipeline yet).

## Learning loop (identical code, different database)

`adaptive.ts` and `experiments.ts` are imported as-is and pointed at
`/data/crypto.db`, so:

- outcomes (wins included) feed `learning_events.OUTCOME_RECORDED` here;
- `strategy_weights` for `crypto_momentum_v1`/`SHORT` refits from **crypto**
  outcomes only — the equities book's weights are never touched;
- shadow experiments read this book's signals/trades read-only; graduation can
  only bias conviction **up**, never block a trade;
- lessons (`knowledge_lessons`) accumulate here, including the validated
  relative-volume lesson, applied at crypto entries too.

Cross-contamination is impossible by construction: two database files, and the
modules only ever receive their own `db`.

## Universe stability

Membership is *content* for learning: a coin that enters and exits weekly never
accumulates enough outcomes to teach anything. Hence:

- 6 **pinned** coins (BTC, ETH, XRP, DOGE, XLM, SHIB) are never dropped;
- 19 **ranked** slots follow market cap, filtered to Kraken-quoted USD pairs
  and excluding stablecoins/wrapped/tokenised assets;
- hysteresis: a ranked member leaves only after 7 days outside the top 35, a
  candidate enters only after 3 days inside the top 20; every change is logged
  (`crypto_universe_log`, `audit_log`) and shown in the UI;
- refresh cadence: 6h (`universe_refresh`).

## Job cycle

| job | cadence | what it does |
|---|---|---|
| `universe_refresh` | 6h (first run seeds) | tradability + ranking + hysteresis; re-subscribes the socket |
| `quote_ingest` | 5s (only when the socket is down) | REST quotes → `ingestTick` |
| `bar_backfill` | 10min | daily bars for the universe + BTC (730d) |
| `order_processing` | 15s | fill PENDING orders, fee-aware |
| `position_monitor` | 10s | mark to market, fire exits |
| `snapshot` | 60s | equity/cash/unrealized/BTC benchmark row |
| `signal_scan` | 5min (`CRYPTO_SCAN_INTERVAL`) | strategy → fusion → orders |
| `settle_hourly` | 1h | daily-bar exit evaluation |
| `knowledge` | 30min | outcome feedback (once per trade) + weight/threshold refit |

Every job writes `system_jobs` (`last_status` OK/ERROR, `duration_ms`,
`last_error`) — that is what `/pp/api/crypto/system` shows.

## Tests

- `apps/server/test/crypto-broker.test.ts` — fee-aware fills, DB reopen guard,
  **fee-inclusive round trip + learning loop on the crypto DB**, hysteresis.
- `apps/server/test/crypto-engine.test.ts` — websocket parsing against a
  **real captured Kraken row** (`timestamp`, XBT→BTC, 24h change → prevClose),
  stream lifecycle/REST fallback, scan produces signals+orders from the active
  universe only, planted weights silence the scan vs a control twin,
  `ingestTick` previous-close from bars.
- `apps/server/test/crypto-http.test.ts` — real `createApp` on an ephemeral
  port: status/overview/learning/experiments contracts, `PAPER_ONLY` in the
  payload, 404 for unknown paths, and a regression guard on `/api/tradingusa/*`.
- `apps/web/src/test/Crypto.shell.test.tsx` — both badges always visible, 6
  nav labels in order, header state, navigation without reload, unknown path
  fallback.
- `apps/web/src/test/Crypto.learning.test.tsx` — empty learned state, shadow
  experiments with date filters + presets, only a positive delta gets the
  headline, `{}` payload survives.