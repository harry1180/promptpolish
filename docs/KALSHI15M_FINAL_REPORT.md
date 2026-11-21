# Kalshi BTC 15-Minute Micro-Scalping Engine — Final Report (Phase 12)

Date: 2026-11-21 · Repo `/opt/yard/promptpolish` · Production `https://governance.agenticalchemy.io/crypto/kalshi15m`
Scope: build a research-grade engine for repeatable, after-fee positive-EV round trips
inside KXBTC15M windows, with promotion gated on evidence. **No live trading was enabled;
no order path exists anywhere in the codebase.**

---

## 1. Verified facts

Only claims below were reproduced by our own runs against our own code and data.

### Research (Phase 1)
- Four strategy sources (turbinefi, windmill, degenhedge, predictionmarketspicks) plus
  Kalshi docs and CF Benchmarks were retrieved. Their reported performance is
  **self-reported or backtest-only**; none of it was reproduced by us and none of it was
  copied into the engine. Every strategy here was independently specified, implemented
  and tested against our own recorded tape.
- Kalshi's public REST (`/trade-api/v2/...`) requires no auth; the WebSocket requires
  Ed25519-signed headers (implemented in `client.ts`, credentials outside the repo,
  key file mode 600, read-only bind mount, never printed).
- KXBTC15M fee schedule confirmed live: quadratic taker fee `0.07·C·P·(1−P)`, maker free
  (`fee_type=quadratic`). Settlement is the closing 60-print BRTI average vs the opening
  floor strike, tie to YES; settled markets expose `expiration_value` (the official value).

### Data engine (Phases 3)
- Live WS: window discovery/rollover, snapshot + sequence-checked deltas, trade prints,
  250 ms decision tape, 1 s BTC spot tape shared with the existing Kraken/Coinbase feeds
  (one socket per venue, observer hooks — no duplicate feeds, no extra polling).
- Health measured without pretending clocks are shared: server processing lag
  p50 ≈ 5 ms / p95 ≈ 7 ms, staleness local-only, 0 feed errors, 0 sequence gaps observed
  across all runs; gap → resubscribe → REST stopgap path implemented and tested.
- Fair value: settlement-average variance `v·(τ−40)` (τ ≥ 60 s) and `v·τ³/10800` inside the
  final minute. Reproduces published checks: std is 14.3 % smaller than a last-tick model
  at τ=150 s and 71.1 % smaller at τ=30 s. Every spot-derived number is labelled
  `APPROXIMATION` (BRTI is not licensed; a single venue is never passed off as the index).
- Sigma policy `max = max(realized, implied median)` was adopted after measurement: the
  first live sample claimed a +30 pp edge because realized vol understated the book ~7.5×
  (implied/realized median 7.53 at discovery, 1.46 in the current window). With the policy
  in force the median model edge is ≈ −0.71 pp (p95 |edge| 2.31 pp, share >2 pp = 14.8 %).
  `bookSpotDisagree()` refuses fair value outright when book and spot directions conflict,
  so a saturated p=1 can never reach a strategy.

### Strategies (Phase 4 — all SHADOW, all individually flagged)
Six evaluators, one verdict shape, one storage path (`k15m_signals`), every evaluation —
taken or skipped — persisted with exactly one named skip reason (18 distinct reasons seen).
- A cross-exchange lead/lag, B order-book microstructure (TAKER and MAKER cost models),
  C panic fade, D momentum, E late-window favorites (HOLD and EXIT), F passive maker.
- Live, first minutes with all six enabled: 89 evaluations each → 23 TRADEs
  (A 2, B 0, C 0, D 1, E 0, F 16), 1,977 reasoned skips.
- Structural result proven in the data: **B as a taker can never clear costs** —
  0 trades from 11,212 evaluations in the backtest. Its tradeable form is maker execution (= F).

### Backtest (Phase 8)
Event-driven replay of the recorded tape through the *same* evaluator functions
production runs. No look-ahead (inputs ≤ t), exits at the real later book or official
settlement, taker fills ASK/BID (never midpoints), maker fills marked ASSUMED, unscored
trades reported separately. Chronological TRAIN/VALIDATION/TEST.

Dataset: **15 windows ≈ 3.75 h, 14 with official results** (this is the honest size of
everything below).

| strategy | evals | taken | win % | net ¢/contract | max DD ¢ | p5 tail ¢ |
|---|---|---|---|---|---|---|
| A lead/lag | 11,212 | 44 | 27.3 | **−7.30** | 359.1 | −54.8 |
| B micro (taker) | 11,212 | 0 | — | — | — | — |
| C panic fade | 11,212 | 17 | 52.9 | **+2.48** | 51.3 | −17.2 |
| D momentum | 11,212 | 92 | 40.2 | **−2.43** | 199.6 | −25.0 |
| E late fav (HOLD) | 11,212 | 175 | 47.4 | **−3.11** | 453.6 | −69.9 |
| F maker | 11,212 | 3,057 | 44.7 | **−0.11** | 1,127.6 | −17.0 |
| **Total** | — | **3,383 scorable** | 44.5 | **−0.41** | — | — |

Fees paid: 642.6 ¢. Unscorable (no exit book, no result): 2 — never counted as wins/losses.
Splits: TRAIN −0.52 ¢/c (n=2,377, PF 0.77) · VALIDATION −1.38 ¢/c (n=571, PF 0.72) ·
TEST **+1.50 ¢/c (n=435, PF 1.55)**.

### Paper execution (Phases 6/7/9 — simulated fills only)
State machine `MONITOR → SIGNAL → VALIDATE → ENTER → CONFIRM_FILL → MANAGE → EXIT →
RECONCILE → MONITOR`; fills at ASK/BID, depth-capped, partials refused; fixed 0.25 % sizing
of a $1,000 bankroll (never martingale), 1 position per market (no averaging down *by
construction*), 5 s re-entry cooldown, 2 % daily loss cap, 5 % exposure cap, 2 ¢ min edge,
5 s stale-book refusal; exits at 10 s time / 5 c stop / 10 c take / settlement 0-or-1 —
the stop test asserts the fill is the bid, i.e. **realized loss exceeds the nominal stop**.
Kill switch (manual, sticky) + automatic feed-loss halt (>30 s silent), verified live:
`?action=halt → {manual:true, halts:1}`.
Live after ~1 h: ~29 closed trades, **net −169.67 ¢, fees 481.67 ¢**, equity 99,830 ¢ of
100,000 ¢, win 31 %; rejections firing as designed (position-exists and cooldown most common).

### Dashboard (Phase 10)
`/crypto/kalshi15m` tab with five sections, all verified in a browser against live data
(screenshots: `/opt/yard/cx-trust-control-plane/kalshi15m-tab-full.png`,
`kalshi15m-tab-top.png`); both mandated labels rendered verbatim. Gate: typecheck +
633 tests + build, exit 0.

### Verification totals
Server: **232/232** node tests (13 Kalshi suites + fixtures captured from the real feed).
Full workspace gate: **633 tests, 0 failures**. Typecheck clean. Commits `97a7295`,
`5e04881`, `967bc68`, `58b7a53`, `573d978`, `30b4f45`, `55e4691`, `66c01e2`, `dfc589e`.

---

## 2. Estimates (reasonable, not measured)

- ~3.75 h of tape spans one market regime; per-strategy TEST sample sizes (n=3…435) are
  far below any significance threshold. The TEST split's +1.50 ¢/c is **within noise**.
- Fill assumptions for maker trades (F, and B in MAKER mode) are unmodelled; paper's
  −0.11 ¢/contract on F with taker economics is a conservative proxy for a number we
  do not yet know.
- Latency figures are Kalshi's server processing delay, not our end-to-end path.

## 3. Assumptions (declared in code and in every verdict's reason string)

- C: rebound = 0.5 × unexplained drop (declared `ASSUMPTION`).
- D: continuation = 0.5 scaled to a 10 s hold (declared `ASSUMPTION`).
- E: HOLD exit-free; price ceiling 0.97 keeps the 99 ¢ fee trap out.
- F: `queue_position=UNMODELLED`, `fill_probability=UNMODELLED`,
  `adverse_selection=UNMODELLED` — a F verdict means "theoretical if filled".
- Settlement reference is an APPROXIMATION (venue-labelled), never BRTI.

## 4. Unsupported claims (explicitly NOT made)

- No strategy is claimed profitable. The aggregate is negative (−0.41 ¢/contract backtest,
  −169.67 ¢ paper) and is reported as such.
- No exchange price difference was treated as arbitrage (Kraken/Coinbase mids run 15–30 bps
  apart in this environment; Strategy A measures *repricing lag*, not divergence).
- Published backtest/live figures from the four sources remain unverified.
- Midpoints are never used as fills anywhere; no spoofing, wash trading or misleading
  orders are implemented (there is no order capability at all).

## 5. Known limitations

1. Sample size: hours, not days. No parameter has been fitted; all thresholds are
   hand-picked research defaults.
2. Maker fill probability, queue position and adverse selection are not modelled.
3. Risk engine (Phase 7) runs only against paper — it has never seen real positions.
4. Dashboard hides below a 1024 px viewport (deep link works).
5. Halt/resume is a GET (console-session-authed) — acceptable internally, not as a public API.
6. One flaky unrelated test (`xchange.test.ts` ECONNRESET under parallel runs).
7. BRTI not licensed: settlement inputs are approximations by construction.

## 6. Future work (ordered)

1. **Accumulate days of tape** — the binding constraint on every conclusion above.
2. Fit parameters on TRAIN → check VALIDATION → judge once on TEST (walk-forward, ablation
   of each gate, regime labels).
3. Model maker fill probability (or restrict to taker-only strategies) before trusting F.
4. Stop/take/time-exit grid search under the risk engine, with gap-aware fills.
5. Paper → live requires explicit approval, sustained positive after-fee evidence, and the
   remaining Phase 11 items (rate-limit backoff evidence, clock-skew guard on signed
   requests, redaction audit).