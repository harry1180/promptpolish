# Next-generation crypto alpha research and integration — deliverables

Date 2026-11-07. Research/measurement only: no production threshold, stop,
size, permission or risk limit changed; the five open trades untouched; no
LLM call added anywhere near the execution path. Scripts are host-side
research tools (server runtime does not import them).

## The three highest-value additions to the EXISTING architecture

1. **Cross-venue + futures observation plane** (Priority 1+2 core): a
   read-only Coinbase Exchange ticker stream and a Kraken Futures REST poll
   alongside the existing Kraken WS, feeding the SAME micro-feature
   recorder style of storage. Both sources verified live today. This is the
   substrate every requested feature family (OFI, aggression, imbalance,
   basis, funding, OI, leadership) hangs off — and it preserves the Kraken
   core untouched.
2. **Durable point-in-time label store + ablation harness** (Priority 4
   core): snapshots currently retain 7 days; row-level forward labels for
   30s–1h were computed in-memory only. Persisting (t, features, label,
   observed_at) rows is what makes accuracy claims survivable and enables
   the required per-feature-family ablation later.
3. **Execution-economics gate** (Priority 5 core): the only finding in this
   program that swings P&L by tens of thousands is fee reality —
   configured 0.16%/side backtests at +$840 while Kraken's published
   tier-1 taker 0.80%/side flips it to −$25k and trips the 25% drawdown
   breaker. Verifying the account's true fee tier and gating entries on
   cost-adjusted EV dominates any model upgrade.

## 1. Current application audit

- Venue: Kraken spot, WS v2 (ticker + trade channels), shadow micro engine
  recording 10s feature snapshots for 25 symbols (7,644 rows over the last
  227 min at time of writing; 7d retention).
- Trading: PAPER_ONLY book, long-only swing strategy `crypto_momentum_v1`
  (fusion weights {technical 0.84, regime 0.16}, confidence floor 0.50,
  atr3 targets, 0.16%/side fee config, entry/stop geometry guard with
  reason codes, 25% drawdown breaker). 5 open positions, 3 closed
  (−$604.49), win rate 0/3.
- Measured accuracy (prior phase): 1d 52.6% vs persistence 66.7%; 15m
  39.7%; 1h 32.4% — model at or below chance everywhere; BUY-confidence
  quantized to a single value (0.513699 = hint 0.60 × weighted 0.5205).
- Research assets: fixed-horizon accuracy endpoint, entry/stop guard,
  fee-grid + exit-geometry walk-forward (122-day untouched holdout),
  OFI readiness gate (NOT READY: thresholds 20k rows/15k labels/7 days).

## 2. Missing-information analysis

| gap | impact | path |
|---|---|---|
| Account's real Kraken fee tier | configured 0.16% vs published 0.40/0.80% — flips every backtest sign | authenticated read-only fee-tier call (needs API key) |
| L2 order-book depth | no cancellations/adds, no multi-level OFI — ticker gives top-of-book sizes only | Coinbase `level2`/`full` channel behind same observer (stage 2) |
| History before 2026-11-07 03:05 UTC | sub-day features/labels exist for ~4h only; 1h holdout impossible today | durable label store (addition #2) |
| Kraken Futures funding units | raw `fundingRate` magnitudes implausible as 8h decimals (PF_XBTUSD raw 0.8948, PF_ETHUSD 0.0171) — possibly already-percent | verify against Kraken Futures docs before feature use; raw captured in futures-features.json |
| Real execution latency | paper scheduler 5–15s is simulation, not venue behavior | deferred until live-authenticated measurement is authorized |
| USD vs USDT identity | Binance.US streams are USDT-quoted for most pairs; Coinbase `*-USD` is true USD | never merge quote currencies; keep venue-specific symbols |
| Trade episodes for Targets C/D | 3 closed trades — no censored-survival training possible | accumulate paper episodes |

## 3. Free market-data integration plan (staged, all shadow)

- **Stage 0 (done today):** reachability probes from this host — Coinbase
  REST+WS ✓, Binance.US REST+WS ✓ (USDT caveat), Kraken Futures REST ✓
  (219 markets, 191ms). Lead-lag observer `scripts/venue-leadlag.mts`
  runs both existing-Kraken and Coinbase tickers, scores leadership with
  `leadLagUpdate` (1bp move threshold, 3s follow window, local recv clock).
- **Stage 1:** persist Coinbase+ticker snapshots and futures snapshots on a
  schedule (same recorder pattern as micro_snapshots; still no decision
  path).
- **Stage 2:** Coinbase `level2` for depth/cancellation features; Binance.US
  USD (not USDT) pairs only — as a SECOND source only if Stage-1 ablation
  shows incremental value; do not add venues for their own sake.
- **Stage 3:** futures funding/OI/basis joined point-in-time into features
  after unit verification.

## 4. Per-source incremental information analysis

- **Price-discovery leadership (measured, 180s, 5 pairs, 1bp/3s):** 24
  moves/venue; Kraken followed in 8 (leader share 66.7%), Coinbase followed
  in 4 (leader share 83.3%); median follower lag 283ms (n=12). XRP/USD:
  Kraken followed 5/10 vs Coinbase 2/13. **Preliminary only** — weekend-
  quiet window, tiny n, recv-clock network asymmetry uncorrected. Runs
  again any time: `LL_WINDOW_MS=600000 node scripts/venue-leadlag.mts`.
- **Futures features (measured):** 219 markets, 209 with funding, 219 with
  open interest; BTC spot-index basis +0.5bp (PF_XBTUSD), quarterly
  futures basis −20bp to +190bp; funding raw values captured pending unit
  verification.
- **Incremental predictive contribution: NOT YET MEASURABLE.** Requires
  the accumulated multi-day dataset + ablation harness (addition #2), then
  Kraken-only vs Kraken+Coinbase vs Kraken+futures feature-family ablation
  under the same purged walk-forward. No number will be claimed until that
  exists.

## 5. Model training and label design

- **Target A (direction)** and **Target B (forward bps)** implemented in
  `scripts/model-baseline.mts`: labels = first snapshot at/after t+h (no
  look-ahead), horizons 30s/60s/5m/15m/1h, features = point-in-time
  microstructure vector (r1..r60, spread, TOB imbalance, microprice dev,
  rv60, CVD, trade rate), purged chronological split 60/20/20 with purge =
  horizon, holdout untouched, calibration quintiles, Wilson CIs.
- **Target C** (P(take-profit before stop/time)) — design: time-to-event
  with censoring on the recorded trade episodes; needs far more than 3
  episodes. **Target D** (P(net P&L > 0)) — design: features + fill model
  + fee scenario as inputs, label = realized net; same data gate as C.
- Baseline = logistic regression (implemented); XGBoost challenger = next
  after baselines (no dependency in repo; spec orders it after baselines);
  HawkesTime/HawkesSign explicitly deferred until baselines establish any
  signal.

## 6. Baseline versus challenger evaluation

Single-session run (7,644 snapshots, 227 min, 25 symbols):

| horizon | n (train/val/test) | logistic acc [95% CI] | alwaysUp | alwaysDown | persistence | B: R² | B: MAE |
|---|---|---|---|---|---|---|---|
| 30s | 3990/1316/1319 | 54.7% [52.0, 57.3] | 52.2% | 47.8% | 52.7% | −0.011 | 4.3bp |
| 60s | 4184/1362/1372 | 52.0% [49.3, 54.6] | 53.3% | 46.7% | 51.7% | −0.020 | 5.2bp |
| 5m | 4366/1322/1300 | 49.1% [46.4, 51.8] | 48.0% | 52.0% | 51.2% | −0.042 | 8.2bp |
| 15m | 4239/969/926 | 41.7% [38.5, 44.9] | 60.3% | 39.7% | 49.4% | −0.157 | 14.2bp |
| 1h | — | insufficient after purge (test n=0) | | | | | |

- 30s: CI [52.0,57.3] overlaps persistence 52.7% — not distinguishable from
  the best simple baseline.
- 15m: significantly BELOW 50% while the market rose 60% of the time —
  consistent with the earlier signal-level 15m result (39.7%).
- Target B: R² negative at every horizon (linear model worse than the
  mean) — no magnitude-prediction value.
- Calibration: miscalibrated (60s quintile 3 predicted 0.491 vs observed
  0.600; 15m far worse) — probabilities unusable for EV gating as-is.
- Challenger (XGBoost): not run — no credible baseline to challenge; runs
  next with the same harness once rows ≥ threshold.

## 7. Accuracy, calibration, trade-frequency, profitability comparison

No configuration in any phase demonstrates statistically credible
improvement after realistic costs:

- Directional: every horizon's CI either includes 50% or is significantly
  below it; persistence beats the model at 5m/15m/1h/1d.
- Calibration: poor at all horizons (above).
- Trade frequency: more entries = worse results (B075 519 trades −$10k vs
  C 263 trades +$8k at configured fees; at real tier-1 fees the frontier is
  empty — every variant negative or breaker-stopped).
- Profitability: best holdout candidate (geometry C, +$15,813 over 122d)
  has win-rate CI [44.4, 72.3] — includes 50%, and full-window at real
  fees is negative.
- **Conclusion per protocol: remain in paper trading.**

## 8. Fee and latency sensitivity

- Fees verified against Kraken's published schedule: tier-1 maker 0.40% /
  taker 0.80% vs configured 0.16% (unverified account tier pending API
  read). Re-sim of the 3 real trades at tier-1 taker: −$985.51 vs
  −$604.49. 606d backtest production geometry: +$840 configured → −$23.5k
  (0.40%) → −$25.4k (0.80%) → −$27.6k stress; drawdown breaker halts all
  entries after train at real tiers.
- Latency: paper 5–15s = `order_processing` 15s scheduler gating with
  simulated fills — NOT venue latency; real submission→fill unmeasured
  (paper-only) and must not be claimed. Break-even: at 0.16%+5bps slippage
  RT cost = 0.42%; at tier-1 taker ≈1.7% RT, which exceeds even the p90 of
  1h realized moves (1.13%) — no short horizon clears real fees.
- Binance.US vs Global: distinct venues; nothing transfers between them by
  assumption. USD (Coinbase `*-USD`) and USDT (Binance.US) kept separate
  identities; no cross-currency conflation.

## 9. Recommended production architecture

1. Keep Kraken WS v2 as the sole execution/data core (unchanged).
2. Add the observation plane as pure observers: Coinbase ticker + Kraken
   Futures poll + durable label store — same recorder pattern, feature-
   flagged, zero decision paths (production parity: micro engine's
   decision-impact NONE invariant).
3. All model scoring shadow-only until: (a) ablation shows incremental
   value over persistence after costs, (b) calibration acceptable, (c)
   separate approval.
4. Cost gate before any entry: predicted gross ≥ 2× RT cost at the
   VERIFIED fee tier — otherwise NO-TRADE (spec: never force trades when
   predicted moves < costs).
5. LLM (MiMo/GLM) stays out of latency-sensitive paths — unchanged.

## 10. Safe staged rollout plan

- **Stage A (now):** scripts-only measurement; server untouched — done.
- **Stage B:** durable snapshot/label storage + scheduled observer, behind
  flags, still zero decision impact.
- **Stage C:** ≥7 days of data → OFI readiness gate re-run → feature-family
  ablation (Kraken-only vs +Coinbase vs +futures) under purged walk-forward
  with untouched holdout → XGBoost challenger vs logistic baseline.
- **Stage D:** only if a config beats persistence + costs with CI excluding
  break-even: propose paper-strategy integration (geometry/fee/filter
  changes) — separate explicit approval, one change at a time.
- **Stage E:** live execution remains out of scope until D passes twice.

## Scientific foundation — verified papers and what is genuinely empirical

All four citations verified to exist:

1. **Alexander et al. (2026), J. Banking & Finance** — "High-frequency
   price discovery in fragmented crypto markets" (ScienceDirect
   S0378426626002232). Genuine: fragmented-market price discovery is
   measure/frequency-sensitive — motivates our per-venue leadership
   measurement rather than assuming one venue "is" the price.
2. **Pindza (2026), Frontiers in Blockchain** (DOI 10.3389/fbloc.2026.1811716)
   — 3M minute-level obs, Binance spot+perp, purged walk-forward: features
   stably selected but **gradient boosting overfits under leakage controls
   and NO strategy survives realistic fees**; cross-coin transfer fails,
   spot↔perp same-asset transfer works. Independent replication of our fee
   verdict; directly cautions against XGBoost claims on our sample size.
3. **Frino et al. (2025), J. Futures Markets 45(4):269–288**
   (DOI 10.1002/fut.22560) — at 1s sampling futures generally LEAD spot,
   with daily fluctuation and noise-measure sensitivity. Genuine finding
   from paid tick data; our futures-basis/funding features target the same
   relationship but our own lead-lag evidence must come from our own
   measurements, not this paper.
4. **Raffaelli et al. (2026), Decisions in Economics and Finance**
   (DOI 10.1007/s10203-026-00570-z) — HawkesTime (MHP event timing + COE
   magnitude from base imbalance) beats pure Hawkes and baselines on
   Bitfinex LOB; **profitability is simulated** (their own framing) — we
   will not treat simulated Hawkes profits as realizable, and Hawkes
   evaluation waits until our logistic baseline shows signal.

**Distinguished from our proposed architecture:** the papers establish
that (i) venue leadership is measurable and fluctuates, (ii) microstructure
features carry weak information that costs usually eat, (iii) futures can
lead spot. Our combined architecture — Kraken core + Coinbase/futures
observation plane + cost-gated shadow models + durable ablation harness —
is OUR proposal, not an empirical result, and earns adoption only through
Stage C above.

## Bottom line

No model or configuration has demonstrated statistically credible
improvement after realistic costs. The highest-value next steps are
measurement infrastructure and fee verification, not model complexity.
**Recommendation: remain in paper trading.**
