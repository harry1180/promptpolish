# Microstructure Alpha Engine (shadow mode)

Feature-flagged observer that computes short-horizon microstructure features
from the **same** Kraken Spot WebSocket v2 connection the crypto book already
uses. It never opens a socket, never writes to shared market state, and has
**no code path into the broker** — decision impact is `NONE` by construction.

## Verified data contract (captured live 2026-11-07, `wss://ws.kraken.com/v2`)

Fixture: `apps/server/test/fixtures/kraken-v2-capture.json`

- **ticker** (already subscribed by the production stream):
  `{channel, type, data:[{symbol, bid, bid_qty, ask, ask_qty, last, volume,
  vwap, low, high, change, change_pct, trades, timestamp}]}`
  → `bid_qty`/`ask_qty` make top-of-book imbalance and microprice observable
  **without** the `book` channel.
- **trade** (subscribed only when the engine is enabled, on the SAME
  connection): `{channel:'trade', type:'update', data:[{symbol, side, price,
  qty, ord_type, trade_id, timestamp}]}` — deduplicated by `trade_id`
  (replays counted, never double-counted).
- Kraken v2 rejects `XBT/USD`; mapping `XBT→BTC` is applied on inbound
  decoding exactly as the production parser does.

## Integration seam

```
Kraken WS v2 ──► CryptoPriceStream (unchanged production parse)
                     │ after parse, try/catch observer: onRawMessage(text)
                     │ extra subscribe: channel 'trade' (only when enabled)
                     ▼
              CryptoRuntime.onTick ──► ingestTick (UNCHANGED)
                     │                 └─► micro.onQuote (shadow, try/catch)
                     ▼
              MicroEngine (bounded queue, drop-OLDEST + counters)
                     ├─► in-memory features per symbol
                     └─► micro_snapshots (7-day retention, 10s cadence)
```

- `stream.ts`: two NEW optional options (`extraChannels`, `onRawMessage`).
  Defaults unset ⇒ byte-identical original behaviour.
- `runtime.ts`: constructs the engine only when `SCALPING_ALPHA_ENABLED=1`.
- `routes.ts`: `GET /api/crypto/micro` — flags, counters, latest features.

## Flags (config.ts `microFromEnv`, all safe by default)

| Env | Default | Meaning |
|---|---|---|
| `SCALPING_ALPHA_ENABLED` | off | build the engine + subscribe `trade` |
| `KRAKEN_L2_FEATURES_ENABLED` | off | reserved; `book` NOT subscribed, L2 features report disabled |
| `META_LABELING_ENABLED` | off | reserved; no trained model exists yet |
| `COST_AWARE_VALIDATION_ENABLED` | off | reserved; no validator wired yet |
| `SHADOW_MODE` | on | record alongside; never influence decisions |
| `LIVE_EXECUTION_ENABLED` | off | nothing executes regardless |
| `SCALPING_STALE_MS` | 5000 | reject observations older than this |
| `SCALPING_QUEUE_CAP` | 2000 | bounded observer queue (drop-oldest) |
| `SCALPING_RECORD_MS` | 10000 | snapshot recording cadence (enabled only) |

## Overload / failure semantics

- Queue is bounded: overflow drops the **oldest** event and increments
  `queue.droppedOverload` — never silent.
- Frames older than `SCALPING_STALE_MS` on arrival: `droppedStale`.
- Duplicate `trade_id`: `duplicates`.
- Parse/process failures: counted (`parseErrors`, `errors`), never thrown —
  the production `ingestTick` path cannot be affected.
- Feature quality per symbol: `OK | WARMING_UP | STALE | NO_DATA`.

## Cost context (Phase 7)

`roundTripCostBps = feePct × 2 × 10000` (live: `CRYPTO_FEE_PCT=0.0016`
→ **32 bps** round trip, Kraken tier-1 taker). Exposed on `/api/crypto/micro`
as context only; no trade decision consumes it yet.

## NOT READY (deliberately not claimed)

- Models A–D (XGBoost / expected-return / meta-labeling / execution quality):
  no microstructure training history exists yet — `micro_snapshots` starts
  accumulating from first enable. Nothing is backfilled or synthesised.
- L2/OFI/depth features: `book` channel not subscribed; disabled, not
  approximated.
- Backtest, walk-forward comparison, latency/CPU study, profitability claims:
  pending recorded history. No accuracy or P&L improvement is claimed.

## Rollout / rollback

1. Off (default): remove/never set `SCALPING_ALPHA_ENABLED` → engine not
   constructed, no extra subscription, `/micro` reports disabled.
2. Shadow (deployed): `SCALPING_ALPHA_ENABLED=1` (+ `SHADOW_MODE=1` default)
   → features computed, snapshots recorded, decisions untouched.
3. Full rollback: unset the flag, `docker compose up -d server` — the only
   residue is the `micro_snapshots` table (drop it if desired).