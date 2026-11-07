# Crypto alpha research — Phases A-E

Date 2026-11-07. Research and measurement only: no production threshold,
stop, target, confidence floor or order behavior was changed by this phase.
The five open trades are untouched. Scripts: `scripts/fixed-horizon-study.mts`
(Phase B/D inputs), `scripts/alpha-research.mts` (Phase A/C), `scripts/
ofi-readiness.mts` (Phase E), helpers in `src/crypto/research.ts` with
`test/crypto-research.test.ts` (6/6).

## 1. Verified fee and latency assumptions (Phase A)

Venue/product: Kraken spot market, PAPER_ONLY. Entries fill at the ask
(taker posture) in simulation.

Fees (Kraken published schedule, checked 2026-11-07):

| scenario | maker/side | taker/side | round trip |
|---|---|---|---|
| configured `CRYPTO_FEE_PCT` | 0.16% | 0.16% | 0.32% |
| Kraken Tier-1 (base) | 0.40% | 0.80% | 0.80–1.60% |
| account's actual tier | UNVERIFIED — no API keys configured; must be read from the authenticated fee-tier endpoint before any production-cost claim | | |

Re-simulation of the three real closed trades (same fills, same exits):

| trade | net @ configured 0.16% | net @ Tier-1 taker 0.80% |
|---|---|---|
| OKB | −$169.22 | −$296.40 |
| NEAR | −$238.37 | −$365.01 |
| UNI | −$196.91 | −$324.10 |
| total | **−$604.49** | **−$985.51** (+63% worse) |

606-day backtest, production geometry (A), same entry logic:

| fee scenario | net | maxDD | outcome |
|---|---|---|---|
| configured 0.16%/side | +$840 | 17.0% | flat, positive holdout |
| Tier-1 maker 0.40% | −$23,455 | 25.3% | drawdown breaker (>25%) halts ALL entries after train |
| Tier-1 taker 0.80% | −$25,396 | 27.0% | breaker halts; 0 trades in val+holdout |
| stress: taker + 3× slip | −$27,631 | 29.5% | same |

Latency: the 5–15s order-to-fill delay is paper-scheduler gating
(`order_processing`, 15s cycle) with simulated fills — NOT exchange
execution latency. Real submission-to-fill latency on Kraken remains
unmeasured (paper only) and must not be claimed otherwise.

## 2. Existing signal accuracy vs baselines (Phase B)

Fixed-horizon study, all 75 signals, no look-ahead (first observation at/
after signal_ts+horizon), Wilson 95% CIs:

| horizon | source | n eval | overall [CI] | BUY [CI] | SELL [CI] | upShare | persistence [CI] |
|---|---|---|---|---|---|---|---|
| 30s | snapshots | 9 | 77.8% [45.3, 93.7] | 33.3% [6.1,79.2] | 100% [61,100] | 11% | 11.1% n=9 |
| 60s | snapshots | 12 | 50.0% [25.4, 74.6] | 66.7% [20.8,93.9] | 44.4% [18.9,73.3] | 58% | 16.7% n=12 |
| 5m | Kraken 5m | 75 | 40.0% [29.3, 51.7] | 61.5% [35.5,82.3] | 35.1% [24.0,48.1] | 64% | 57.1% [43.3,70.0] |
| 15m | Kraken 15m | 75 | 39.7% [29.3, 51.2] | 40.0% [19.8,64.3] | 39.7% [28.1,52.5] | 56% | 63.0% [51.5,73.2] |
| 1h | Kraken 1h | 74 | 32.4% [22.9, 43.7] | 60.0% [35.7,80.2] | 25.4% [16.1,37.8] | 72% | 63.5% [52.1,73.6] |
| 1d | daily bars | 57 | 52.6% [39.9, 65.0] | 54.5% [28.0,78.7] | 52.2% [38.1,65.9] | 49% | 66.7% [53.7,77.5] |

Findings:
- The model is at or below chance at every horizon; at 1h the CI excludes
  50% entirely (32.4% [22.9, 43.7]) — significantly WORSE than coin flip,
  driven by SELL signals (25.4%) in a market that mean-reverted up.
- Persistence (prior-close direction) beats the model at 5m/15m/1h/1d.
- 30s/60s: n=9/12, CIs span everything — no claim possible either way.
- BUY side looks better at 5m/1h (61.5%/60.0%) but every CI includes 50% —
  NOT demonstrated superiority on any dataset, let alone an untouched one.
- Class balance swings hard by horizon (upShare 11%→72%): the SELL-heavy
  book (60/75 signals) is misaligned with the upward drift in the window.

Data limits stated: snapshots begin 2026-11-07 (7d retention), so 30s/60s
n stays small for older signals; 5m/15m/1h use public Kraken OHLC (720-candle
depth covers 5m only for recent signals — full coverage at 15m/1h).

## 3. Confidence-score diagnostic (Phase B)

- All 15 BUY signals carry confidence EXACTLY 0.513699; reconstructing
  hint = conf/(0.7+0.3·|weighted|) gives hint = 0.6000 and weighted =
  0.5205 for EVERY BUY — one single (hint, weighted) pair.
- SELLs: hints {0.60, 0.90} → 5 distinct confidence values total in the book.
- Cause: intended weighting behavior with quantized inputs — the strategy
  hint (st.confidence) takes few discrete levels, and crypto supplies only
  two fusion parts (weights {technical 0.84, regime 0.16}), so longs all
  land in one bucket.
- Verdict: confidence does NOT rank opportunities within the BUY class
  (zero cross-sectional information). Calibration/precision-by-band cannot
  be computed (one BUY band, 0 winning BUY outcomes). NOT a bug to fix by
  reweighting or threshold changes — prohibited and uninformative anyway.
- Data freshness min 0.99997: stale-data never influenced these signals.

## 4. Stop/target alternatives and backtest results (Phase C)

Design: same production entry pipeline (crypto weights, floor 0.50, sane
R:R, evaluateEntry sizing at 0.75%/10% — risk controls unchanged), daily-bar
conservative exits (stop priority, gap-aware), chronological walk-forward:
train 2025-03-12..2026-03-09 (60%) / val to 2026-07-08 (20%) /
HOLDOUT 2026-07-09..2026-11-07 (122 days, 20%, untouched by selection).
D's pT/pS estimated on purged train episodes only (n=7,873), never refit.

Configured fees (0.16%/side), net $ by segment (entry-date cohorts):

| geo | full n | win% | net | train/val | HOLDOUT n, win%, net |
|---|---|---|---|---|---|
| A production | 493 | 23% | +840 | −11,532 / +3,243 | 88, 34% (CI 25.0–44.5), +9,129 |
| B075 stop 0.75ATR | 519 | 24% | −10,060 | −18,372 / +1,414 | 99, 32%, +6,897 |
| B10 stop 1.0ATR | 420 | 30% | −399 | −9,348 / −1,123 | 81, 40%, +10,072 |
| B15 stop 1.5ATR tgt 4ATR | 289 | 35% | +5,963 | −8,086 / −1,682 | 56, 48% (CI 35.7–61.0), +15,731 |
| **C horizon-matched σ_H** | 263 | 40% | **+7,977** | **−7,679 / −158 (best train+val)** | 44, 59% (CI 44.4–72.3), **+15,813** |
| D prod + EV gate | 39 | 5% | −3,887 | −126 / −781 (evRej 2,240) | 7, 0%, −2,981 |

Honest reading:
- Selection on train+val picks **C**; the untouched holdout then confirms
  it positively (+$15,813, lowest maxDD 16%) — but its 59% holdout win
  rate has CI [44.4, 72.3] which INCLUDES 50%, and C lost money in train.
  **C is promising, not statistically established.**
- At Kraken Tier-1 fees the whole field collapses: only C retains a
  positive holdout (+$10,160 t80, +$13,863 t40) while full-window results
  go negative; A/B variants trip the >25% drawdown breaker and stop
  trading entirely (risk controls working as designed).
- D's verdict is itself the finding: train-estimated first-passage for
  production-tight stops is pT=0.03–0.08 vs pS=0.91–0.96 — the production
  geometry is EV-negative once priced honestly, so a correct EV gate
  rejects 98% of setups rather than manufacturing trades.
- First-passage evidence (all 15 BUY signals): stop-first 4, target-first
  0, censored 11 — unchanged from the diagnostic phase.

## 5. Trade-frequency and profitability frontier

At configured fees: more trades ≠ more profit (B075: 519 trades, −$10,060
vs C: 263 trades, +$7,977). Win rate rises with wider stops (23%→40%) while
frequency falls — the frontier's efficient region at 0.16% fees is
low-frequency, wider-stop (B15/C). At real Tier-1 fees the frontier is
empty: no configuration produced a positive full-window net. Optimizing
for trade count would have selected the worst performer.

## 6. Performance by holding horizon (Phase D)

Break-even vs realized movement:

| horizon | cost RT @0.16%+slip (0.42%) | cost RT @Tier-1 (≈1.7%) | realized |median| move | verdict |
|---|---|---|---|---|
| 30s | 0.42% | 1.70% | ~0.03% (3bps, snapshots) | NO-TRADE (cost ≫ move, 14×) |
| 5m | 0.42% | 1.70% | ~0.06% est. | NO-TRADE |
| 15m | 0.42% | 1.70% | 0.14% (p90 0.51%, n=14,420) | NO-TRADE at Tier-1; tail-only at 0.16% |
| 1h | 0.42% | 1.70% | 0.32% (p90 1.13%) | marginal at 0.16%, NO at Tier-1 |
| 1d+ (swing, existing) | 0.42% | 1.70% | daily ATR 2–6% for these alts | only viable horizon |

Ranking: **swing (existing) ≫ 1h > 15m > 5m ≈ 30s (NO-TRADE)** — and swing
only clears Tier-1 costs on high-volatility names. Signal accuracy results
(Section 2) reinforce this: the model adds no demonstrated directional edge
at any horizon, so shorter horizons only multiply cost exposure.

## 7. Incremental value of OFI-XGBoost (Phase E)

Data inventory (live, shadow recording ON — SCALPING_ALPHA_ENABLED=1,
SHADOW_MODE=1, LIVE_EXECUTION=0, decision impact NONE):

- rows: 6,478 (growing ~10s × 25 symbols), span 1 day, labeled-60s: 4,783
- feature coverage: trades60 (OFI inputs) 98.6%, TOB imbalance 100%,
  spread 100%; NO L2 depth (ticker top-of-book only)
- readiness thresholds: rows ≥20k, labeled ≥15k, days ≥7
- **verdict: NOT READY** (1/7 days). No model was trained; the four-way
  comparison (engine / engine+cost filter / OFI-XGBoost / engine+meta-
  labeling) cannot be computed until READY — reporting anything now would
  fabricate results. Meta-labeling additionally needs per-trade outcomes,
  which accumulate at ~3 trades/week — the binding constraint.

## 8. Proposed changes ranked (research only — approval required)

| # | change | expected benefit | evidence | risk |
|---|---|---|---|---|
| 1 | Verify the account's real Kraken fee tier (authenticated read-only call) | resolves the single biggest cost unknown (0.16% vs 0.40/0.80%) | published schedule vs config, 5× gap | none (read-only) |
| 2 | Keep trading the swing book ONLY until sub-day horizons prove otherwise | avoids guaranteed cost bleed at 30s–15m | break-even table, Sec 6 | none |
| 3 | Backtest geometry C (horizon-matched σ_H) further — extend window, add walk-forward folds; change NOTHING live yet | best train+val AND holdout; lowest DD | Sec 4, but CI includes 50% | low (research) |
| 4 | Cost-aware entry filter: require expected gross ≥ 2× RT cost before entry at whatever fee tier is real | directly targets the −$23k fee leak | fee grid, Sec 1 | low |
| 5 | Record a durable copy of short-horizon outcomes (they expire in 7d snapshots) so accuracy claims survive | measurement integrity | snapshot retention | none |
| 6 | Re-run fixed-horizon study weekly; only after 30d of untouched data judge the BUY-side 5m/1h signal | replaces n=9–15 with real samples | Sec 2 CIs | none |
| 7 | OFI-XGBoost: wait for READY, then train offline; ship nothing without the 4-way after-cost comparison | unknown until data exists | Sec 7 NOT READY | gated |
| — | NOT proposed: threshold/confidence/stop changes in production — current evidence does not support any specific change | | | |

Bottom line: **no configuration has demonstrated statistically credible
alpha after real costs.** Best candidates (geometry C, BUY-side short-
horizon signal) remain inside their confidence intervals. The honest
actions are cheaper fees verification, preserving the swing book,
accumulating untouched data, and re-measuring — not new live parameters.
