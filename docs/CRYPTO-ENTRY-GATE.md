# Crypto spot paper entry gates & risk shape (`crypto_momentum_v1`)

Paper-only. Everything below decides **paper orders** in the `CRYPTO_SPOT`
book; there is no live order path in this module (`EXECUTION_MODE` is
`PAPER_ONLY`, real-money adapters throw at registration).

## Why the gates exist (measured, live DB 2026-11-21)

`paper_trades` held 14 closed rows: **0 wins, 14/14 `STOP_REACHED`**, net
**−$6,739.01** (gross −$6,427.45, so only ~$312 was fees — the damage is
price). `predicted_return` was positive on every trade (+16.5% … +53.7%)
while `actual_return` was negative on every one (−1.7% … −27.3%) → direction
accuracy **0/14**. MFE averaged **+3.36%**, MAE **−10.35%** (worst −26.97%),
so the stop sat ~3× deeper than the best favourable excursion ever observed.

Two findings drive the design:

1. **The confidence threshold cannot be calibrated.** Every BUY candidate the
   book has recorded carries the same fused confidence `0.5137`, the same
   fused score `+0.5205` and the same technical part `+1.0` — 39 BUY rows, 1
   distinct value each. Any cut on those features keeps all of them or none.
   That is stated here rather than papered over with an invented number.
2. **One feature does discriminate, and it is point-in-time.** `entry move =
   signal price / last completed session close − 1` has 39 distinct values on
   the BUY rows, and its relationship with the next session's return is
   monotone across the whole recorded history: quartiles 49.3 / 37.3 / 25.4 /
   11.8% next-day hit rate; walk-forward p50 cut (threshold from rows strictly
   before the session being decided) **37.5% kept (n=104) vs 11.4% cut
   (n=88)** over 192 evaluated rows; BUY-only 45.0% (n=20) vs 15.8% (n=19).
   Unconditional base rate over the same window: **30.8%** (n=402 coin-days,
   BTC −31.7% over 18 sessions) — the window is a bear tape, so *no* cut
   reaches 50%; the gate only avoids the half that was measurably worse.

## The four mechanisms

| what | module | default | rollback |
|---|---|---|---|
| ATR/volatility stop | `engine.ts` `atrStopGeometry` | `CRYPTO_STOP_MODE=atr`, `CRYPTO_STOP_ATR_MULTIPLE=0.5`, floor `CRYPTO_STOP_MIN_PCT=0.005`, cap `CRYPTO_STOP_MAX_PCT=0.04` | `CRYPTO_STOP_MODE=sigmah` |
| trailing exit | `broker.ts` `monitorPositions` | `CRYPTO_TRAIL_ENABLED=1`, activate `CRYPTO_TRAIL_ACTIVATE_R=0.75`, behind-peak `CRYPTO_TRAIL_DISTANCE_R=0.5` | `CRYPTO_TRAIL_ENABLED=0` |
| hard dollar risk cap | `engine.ts` scan | `CRYPTO_MAX_RISK_USD=250` | raise it, or set it above what sizing produces |
| entry threshold | `calibrate.ts` | `CRYPTO_ENTRY_THRESHOLD=1`, `CRYPTO_ENTRY_THRESHOLD_PCT=50`, floor `CRYPTO_ENTRY_THRESHOLD_MIN=60` | `CRYPTO_ENTRY_THRESHOLD=0` |
| confirmation gate | `confirm.ts` + `tape.ts` | `CRYPTO_ENTRY_CONFIRM=1` | `CRYPTO_ENTRY_CONFIRM=0` |

### 1. Stop — `CRYPTO_STOP_MODE=atr` (default)

`depth = clamp(atrMultiple × ATR14/price, minPct, maxPct)`, `stop = price −
depth × price`. It replaces **only** the stop; the target still comes from
`CRYPTO_TARGET_MODE` (approved geometry C). Measured ATR14/price on the
entries taken: 4.9–12.4%; geometry C's stop sat 1.0–26.8% below entry
(`σ_H = ATR/price × √hold`). At the shipped defaults the same entries stop
**2.4–4.0%** below entry.

The swap is conditional: if the resulting risk/reward falls under
`CRYPTO_MIN_RISK_REWARD`, the strategy's own stop is kept and the scan counts
`atrStopFallback` — a rule never forces geometry the target cannot pay for
(same null-fallback contract as `sigmahGeometry`).

### 2. Trailing exit

Arms at `entry + 0.75R` (R = the initial stop distance), then ratchets to
`max(price − 0.5R, current trail, initial stop)` — never down. It is evaluated
against the **current price**, not against `bar.low`, because `monitorPositions`
builds that low from `min(price, entry, previous mark)` and the fill price sits
below any armed trail (handing it to `checkExit` fired `TRAILING_STOP` the
instant the trail was set).

### 3. Hard per-trade dollar risk cap

`shares ≤ floor(maxRiskUsd / stopDistance)`, applied on top of the percentage
caps. Default $250: measured risk-at-stop on the 14 closed trades was
$103–$751 (avg ~$400) on positions up to ~$10k. A cap too small to buy any
size refuses the order and writes an `entry_gate` audit row with
`code: RISK_CAP`.

### 4. Walk-forward entry threshold (`calibrate.ts`)

Reads `signals` with `session_date < today` (no same-day leakage) plus
`market_bars`, scores candidate features in a **fixed order**
(`entry_move_vs_prev_close` → `confidence` → `weighted`) and activates the
first one that

1. clears the evidence floor (`minSamples`, default 60 usable rows),
2. actually varies (≥ 2 distinct values),
3. keeps a better next-session hit rate than it cuts,
4. is not contradicted by the BUY-only sub-sample.

Otherwise the state is `INSUFFICIENT_DATA` / `NOT_SUPPORTED` and **blocks
nothing** — a threshold without evidence is never invented. The cut is the
p50 percentile of the recorded feature values (configurable, 1–99).

### 5. Confirmation gate (`confirm.ts`)

Two legs, both fed by data the book already collects — **no second socket,
no extra polling**:

* **Pullback** — the in-memory Kraken tape (`tape.ts`), fed from the existing
  stream through `tickObservers` (`stream.ts`) and from the REST fallback in
  `runtime.ts`. The entry must have retraced from the tape high by
  `clamp(ATR14 × CRYPTO_PULLBACK_ATR_MULTIPLE, minPct, maxPct)` (default
  0.15 × ATR, floored at 0.25%, capped at 3%). Fewer than
  `CRYPTO_PULLBACK_MIN_TICKS` ticks or an older-than-maxAge window →
  `NO_TAPE` (passes, recorded).
* **Multi-venue** — Kraken vs Coinbase mid direction over
  `CRYPTO_VENUE_WINDOW_MS` (default 5 min), read from `xchange_samples` with
  the existing `priceAgreement()`/`venueWindow()` helpers. Coinbase only quotes
  BTC/ETH, so an alt entry is confirmed on the BTC tape (the same benchmark the
  regime leg uses); the entry symbol is tried first. Blocked codes:
  `DIVERGE` (opposite signs) and `FALLING` (neither venue up, at least one
  down — a long-only book has no use for agreement on a fall;
  `CRYPTO_VENUE_REQUIRE_UP=0` demotes it to agreement-only). Missing/stale
  data → `NO_DATA`/`STALE`: passes, recorded, never silent.

Both legs are wrapped so a misbehaving data source degrades to `NO_DATA`
instead of breaking the scan.

## Where to read it

* `GET /pp/api/crypto/entrygate` — threshold state with the measured
  candidates, per-reason `gateCounts`, the last 20 gate decisions, and the
  stop/trail/cap/confirm configuration (plus the rollback switches).
* `GET /pp/api/crypto/overview` → `calibration` — avg predicted vs avg
  realized and direction accuracy on the closed book, with the note that
  `predicted_return` is a target distance, not a forecast.
* `audit_log` rows with `action = 'entry_gate'` (one per blocked candidate,
  with the feature value, the cut, both gate payloads and the size that was
  refused) and the `scan` rows, which now carry `skippedThreshold`,
  `skippedConfirm`, `riskCapped`, `riskCappedOut`, `atrStopFallback` and the
  threshold status.

The signal row is **always** written — the gates only decide whether an order
is created — so the recorded history keeps growing and the calibration can be
revisited with more rows.

## Tests

`apps/server/test/crypto-entrygate.test.ts` (17): stop math and clamps,
stop-vs-geometry-C depth, `CRYPTO_STOP_MODE` rollback, dollar cap (trim,
block, audited reason), threshold states (`INSUFFICIENT_DATA`,
`ACTIVE`+`BLOCKED`/`PASS`, `WRONG_DIRECTION` refusal, disabled), `entryMove`
parity with the calibration, pullback and venue legs (pass/block/stale/off),
the trailing ratchet and its exit, and the invariant: **same tape, gates on
vs off → the same signals and the same orders** when no gate data exists.
