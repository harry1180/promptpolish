# Multi-exchange market intelligence (docs/XCHANGE.md)

Data-only observation layer behind `/crypto`. **Kraken stays the production
feed and the execution reference**; nothing in this module has a code path into
the broker, the fusion weights or the confidence floor.

## Scope (evidence-driven selection)

| venue | status | why |
|---|---|---|
| Kraken | production feed (existing) | execution reference |
| Coinbase Exchange | wired, live, research-only | first additional source to prove incremental value |
| Binance.US, Gemini, Bitstamp, Crypto.com | **not wired** (listed as `pending`) | enabled only after Kraken + Coinbase demonstrate reproducible value |
| DEX Screener / GeckoTerminal / CoinGecko | implemented, **off by default** | optional REST context, `CRYPTO_XCHANGE_CONTEXT=1` to run |

Adding a venue = one adapter file + one entry in
`apps/server/src/xchange/providers/index.ts`. No change to the manager, store,
feature engine or routes.

## Shape

```
Coinbase WS ─┐                          DEX Screener / GeckoTerminal / CoinGecko (REST, 5-min poll)
Kraken tick ─┴─ CanonicalEvent ─ SampleAccumulator ─ xchange_samples (5s grid, 72h retention)
                                          │
                            features.ts / evaluation.ts (research only)
                                          │
                            /pp/api/crypto/{providers,xchange,sources,context}
```

- `types.ts` — canonical event + `ProviderState` (`DISABLED, CONFIGURED,
  CONNECTING, CONNECTED, DEGRADED, DISCONNECTED, UNAVAILABLE,
  NEEDS_CONFIGURATION`) and `deriveState()`: **CONNECTED never implies
  healthy** — health needs fresh, valid market data.
- `ws.ts` — shared socket lifecycle (backoff, idle recycle, heartbeat reply,
  subscribe acks, latency percentiles, per-symbol book freshness).
- `store.ts` — one row per (venue, symbol) every 5s, pruned after 72h; in-
  memory accumulator drains on a timer so the hot path never blocks.
- `features.ts` — price agreement, divergence (same quote group only — USD and
  USDT/USDC are never merged), top-of-book imbalance, taker pressure,
  lead-lag vs Kraken, experimental confidence score (explicitly not a
  calibrated probability).
- `evaluation.ts` — walk-forward source contribution: Kraken-only vs
  Kraken+Coinbase vs persistence baseline, chronological expanding train /
  3 test folds, Coinbase return residualised against Kraken on TRAIN rows only
  (no double-counting), flat moves excluded, metrics = directional accuracy,
  balanced accuracy, Brier + calibration buckets, and net edge after the real
  round-trip fee. Short of the evidence floor it returns `INSUFFICIENT_DATA`.

## Env knobs (all optional; defaults are the safe ones)

| var | default | meaning |
|---|---|---|
| `CRYPTO_XCHANGE_ENABLED` | `1` | master switch for the live layer |
| `CRYPTO_XCHANGE_VENUES` | `coinbase` | only wired venues can be listed |
| `CRYPTO_XCHANGE_SYMBOLS` | `BTC,ETH` | bases per venue |
| `CRYPTO_XCHANGE_QUOTE` | `USD` | venue quote; `USDT`/`USDC` accepted |
| `CRYPTO_XCHANGE_CONTEXT` | `0` | REST context sources |
| `CRYPTO_XCHANGE_CONTEXT_POLL_MS` | `300000` | REST poll cadence |
| `COINGECKO_DEMO_KEY` | unset | sent as `x-cg-demo-api-key`; keyless works today, a 401 flips the source to `NEEDS_CONFIGURATION` |

Sockets start only when `CRYPTO_WORKERS=1` (production); tests run with
`cryptoWorkers: false`, so the suite is hermetic.

## Verified endpoint facts (2026-11-07, from this host)

- Coinbase `wss://ws-feed.exchange.coinbase.com`: `ticker` + `matches` stream
  fine; **`level2`/`full` now require authentication** (server answers with an
  error frame) — top-of-book sizes come from `ticker`, no L2 depth.
- Kraken v2 `wss://ws.kraken.com/v2` (existing feed, untouched).
- Binance.US / Gemini / Bitstamp / Crypto.com public feeds were probed and
  captured (`apps/server/test/fixtures/xchange/`) but are intentionally not
  wired yet.

## Tests

`apps/server/test/xchange.test.ts` (HTTP + seeded pipeline + feature math),
`apps/server/test/xchange-coinbase.test.ts` (fixture-driven parser), plus the
pre-existing crypto regression tests.
