# TradingUSA performance review (2026-11-24)

Scope: live paper book, `tradingusa.db`, 2026-10-18 → 2026-11-24.
All numbers below were read out of the database, not estimated.

## Headline numbers

- 51 closed trades, 35.3% win rate, net **+$684** across both books
  (SHORT +$1,076 = +1.08%, LONG −$391 = −0.39%).
- Breakeven win rate for this exit shape: **31.4%** (avg win $239 ÷
  (239 + 109)). So the book is *slightly* profitable, not losing — but it is
  flat, and it has taken **zero trades since 2026-11-07**.
- Benchmark (SPY) over the same window: **−5.37%**. Both books beat it; the
  problem is not relative performance, it is that the engine has gone quiet
  and its forecasts carry no information.
- 0 open positions, 100% cash, jobs all `ok` (signal_scan 12,547 runs,
  position_monitor 19,209 runs, no errors).

## Why it is not performing — five measured causes

1. **The return forecast carries no information.** Predicted +4.68% average
   vs realized +0.14% average (33× too optimistic); correlation between
   predicted and actual return over the 51 trades is **−0.06**. Targets,
   R:R checks and sizing are all built on a number that does not predict
   anything.
2. **Confidence is anti-predictive.** Realized return by confidence band:
   0.50–0.60 → +0.66% (10/19 wins), 0.60–0.70 → −0.20%, 0.70+ → −0.12%
   (3/14 wins). Correlation(confidence, actual) = **−0.15**. The current
   `minSignalConfidence = 0.7` floor therefore selects the *weakest* bucket.
3. **Exits stop winners out first.** 25/51 exits are `STOP_REACHED` (average
   hold 0.16 sessions, stop sits 1.66% from entry on average) while only
   10/51 reach target; 16 more exit on `REGIME_CHANGE` with 7.0% predicted
   vs 0.39% realized. `paper_positions.trailing_stop` is populated for
   **every** row as NULL — the trailing-stop branch in `checkExit` has never
   fired.
4. **The book has stopped trading.** Since 2026-11-07: 175 SELL signals,
   0 BUY. Regime has been `HIGH_VOLATILITY` (confidence 0.95) and the entry
   gate refuses BUYs there — 16,191 `skippedRegime` scan events in that
   window. Defensible in a −5.4% tape, but it means the "not performing"
   feeling is mostly *inactivity*.
5. **Sample hygiene.** 38/51 entries filled outside regular hours
   (`AT_SIGNAL` fills at the last close while the market is closed — 6 of
   them on a WEEKEND), the same ticker was bought in both portfolios on the
   same day 5 times (AMZN, JNJ, META, MSFT), the universe is 51 tickers, and
   `regime` scored a constant 0.5 across every traded signal so the learned
   weight refit can never move it (Pearson on a flat feature = 0).

Score-part correlation with realized return (n=51): technical **+0.25**,
fundamental −0.07, macro −0.02, sentiment −0.16, event −0.23, regime 0.00
(flat). The only part that earns its weight is `technical`.

Two reporting checks worth a look (not fixed in this pass):
`strategy_performance.all_time` reports benchmark **+13.7%** while the
portfolio snapshots imply SPY **−5.37%** over the same window; and the
VIX series in `economic_data` is stale (last row 2026-11-19) because its
Cboe quote stopped refreshing.

## What was built in this pass (shadow, no gate changes)

- `packages/tucore/src/calibration.ts` — outcome calibration: 60-session
  time decay, fixed confidence buckets with Laplace smoothing toward the
  book's own prior (no monotonicity assumed — the anti-correlation above
  must stay visible), and a ridge-shrunk expected-return slope so a raw +5%
  forecast collapses to the book's own average until evidence says
  otherwise. Evidence floor: 10 closed trades.
- `apps/server/src/tradingusa/calibration.ts` + table `calibration_state` —
  fitted once per day inside `refreshKnowledge()` (logged as
  `KNOWLEDGE_REFRESH`), read by `runScan`.
- Every new signal now records `audit_json.calibration`
  (`winRate`, `expectedReturn`, `sufficient`) — **recorded only; it never
  gates, filters or sizes a trade** (feature-work rule: any entry-blocking
  change needs an explicit go and ships shadow-first).
- `GET /pp/api/tradingusa/calibration` — the map, buckets, prior, return
  model and an 8-point confidence→win-rate mapping.

Tests: `packages/tucore/test/calibration.test.ts` (5),
`apps/server/test/tradingusa-calibration.test.ts` (3, includes the HTTP
endpoint and a seeded `runScan`).


## Research (2026-11-24, two parallel literature sweeps)

Full findings live in this section; "adopt" marks what maps directly onto a
change this book could make without blocking a trade. Venue flags: (preprint)
= SSRN/arXiv, not yet peer reviewed.

### A. Weight learning, calibration and small-sample statistics

1. Ledoit & Wolf 2004, *A well-conditioned estimator for large-dimensional
   covariance matrices*, J. Multivar. Analysis 88(2) — shrinkage toward a
   simple target provably lowers estimator MSE when signal is weak.
   **Adopt:** shrink every fitted weight toward the shipped default before
   the existing band clamp (our refit is currently raw Pearson × band).
2. Hoerl & Kennard 1970, *Ridge regression*, Technometrics 12(1) — ridge is
   the right regularizer for 6 collinear parts at n=51.
   **Adopt:** ridge (closed-form 6×6 solve, LOOCV alpha) replaces the
   correlation refit in `adaptive.recomputeStrategyWeights`.
3. Fisher 1921, Biometrika 13(3) — SE of a sample correlation is
   1/√(n−3) = 0.14 at n=51: most of our daily weight moves are noise.
   **Adopt:** log a Fisher-z p-value with every refit; "insufficient evidence
   to move" becomes a logged outcome, not a silent no-op.
4. Tashman 2000, IJF 16(4) — refitting on the same 51 trades daily is
   in-sample reuse; refit on ≥15 NEW closed trades or monthly.
   **Adopt:** gate `recomputeStrategyWeights` on new-trade count.
5. Clemen 1989, IJF 5(3) — equal-weight combinations are extremely hard to
   beat at small n; keep it as the baseline every learned scheme must beat
   out-of-sample (Diebold & Mariano 1995, JBES 13(3) for the test).
6. Bailey & Lopez de Prado 2014 (Deflated Sharpe Ratio, *JFR* 1(1)) and
   Bailey et al. 2017 (Probability of Backtest Overfitting, *JPM* 43(4)) —
   release gates for any refit/backtest claim.
7. Clopper & Pearson 1934, Biometrika 26(4) — our 35.3% win rate at n=51 is
   roughly [22%, 50%]; never tune to the point estimate.
8. Lopez-Lira & Tang 2023, *Can ChatGPT forecast stock price movements?*,
   JFE 184 / arXiv:2304.07619 — out-of-sample headline scores predict
   post-news drift; alpha is in underreaction to fresh text and it decays.
   **Adopt:** score each RSS headline at ingest and track hit-rate decay
   (we already poll news every 300s; we never score it per headline for
   entry).
9. Dolphin 2026, arXiv:2607.08346 (preprint) — fine-grained 8-K event tags
   beat SEC item codes; CEO/CFO departures move price >2σ in 17% of cases.
   **Adopt:** escalate only high-magnitude 8-K tags into the event part.
10. Gupta, Rawte & Zaki 2024, *Computational Economics* 64 — rolling 8-K
    text deltas predict firm performance better than 10-K year-over-year
    change; refresh a filing-derived sentiment list quarterly.

### B. Regime gating, stops, LLM agents

11. Shu, Yu & Mulvey 2024, arXiv:2402.05272 — a 2-state HMM gate raises
    Sharpe (0.54 vs 0.48) but LOWERS return (8.5% vs 10.2%); states need
    median filtering. **Adopt:** express regime as size reduction, never a
    flat-to-cash flip (matches proposed increment 4).
12. Pomorski & Gorse 2023, arXiv:2310.04536 — ex-ante random-forest regime
    prediction beat HMM badly (Sharpe 1.44 vs 0.005 on equities); test a
    cheap 200d-MA + vol-bucket classifier baseline first.
13. Chua 2026, SSRN 6965179 (preprint) — breadth momentum AND an HMM must
    agree: either alone over-triggers; composite halved max drawdown
    (−23% vs −51%).
14. Viaggi 2026, SSRN 6432558 (preprint) — market noise floor ≈0.38 ATR;
    stops inside it are consumed by noise, best around 0.8–1.0 ATR.
    **Adopt:** stop-distance floor of 0.8×ATR(14) — directly targets the
    25/51 day-1 stop-outs (mean stop is 1.66% ≈ sub-ATR on many names).
15. Fonseca 2026, *Mathematics* 14(12) — 14 ATR-multiplier configs sit on a
    Sharpe plateau (0.805 ± 0.20pp); stop width is second-order, regime and
    sizing dominate. Stop tuning one multiplier; ratchet the stop only.
16. Howard 2026, SSRN 6350238 (preprint) — price stops destroyed value at
    all 12 distances on 6,284 E-mini events; a time-based exit stack beat
    the baseline in 11/13 months (p=0.02). **Adopt:** make the no-progress
    timeout the primary exit and keep the price stop as a tail-risk cap.
17. TradingAgents (Xiao et al. 2024, arXiv:2412.20138) — gains come from a
    bull-vs-bear debate plus a risk-team veto on shared inputs, not new
    information; short backtest windows.
18. FinMem (Yu et al. 2023, arXiv:2311.13743, IEEE Trans. Big Data) —
    per-feed recency retention windows + a nightly reflection pass carry the
    gain, not the raw model. **Adopt:** one retention window per feed
    (headline/8-K/quote/yield) instead of one rolling 7-day prompt.
19. FinAgent (Zhang et al. 2024, KDD '24 / arXiv:2402.18485) — +36% avg
    profit over 12 baselines, but ~7-month windows and aggressive risk;
    always run buy-and-hold alongside to separate agent alpha from beta.

### Shortlist I would implement next (each still needs your go)

- Stop floor 0.8×ATR(14) + ratchet (items 14, 15) — attacks the day-1
  stop-outs directly, no entry flow lost.
- Time/no-progress exit as primary, price stop as tail cap (item 16).
- Regime as sizing, not veto, in HIGH_VOLATILITY only (item 11).
- Ridge + shrinkage + Fisher-z + new-trade-count refit gate (items 1–4) —
  replaces the Pearson refit already in `adaptive.ts`.
- Per-headline LLM sentiment retained per feed with decay tracking (items
  8, 18) — this is the "latest information" half of your ask, and it uses
  the GROQ/GEMINI keys already wired through the InferenceRouter.

## Shipped 2026-11-24 (approved: stop floor, ratchet, dead-trade exit)

Three execution-side changes, none of which adds, removes or filters a trade:

1. **ATR noise floor** — a placed stop may never sit closer than
   `TU_STOP_ATR_FLOOR` (default **0.8**) × ATR14 to entry. Measured first:
   26 of the 32 historical short-term stops sat inside 0.8 ATR, and 18 of
   those would have fallen under the 1.5 R:R floor if the gate had judged
   the widened stop — so the reward/risk gate and `evaluateEntry` keep
   judging the **strategy's** stop (`candidate.gateInvalidation`) while
   sizing and the placed order use the floored stop, keeping dollars-at-risk
   at `riskPerTradePct`. Twin seeded runs prove an extreme 3×ATR floor
   changes zero signals and zero orders; every signal records a
   `stop_floor` risk check saying what the floor did.
2. **Ratchet trailing stop** — arms once MFE ≥ 1R (`TU_TRAIL_ARM_R`,
   default 1.0), then trails 1.2 × ATR14 behind the peak
   (`TU_TRAIL_ATR`), floored at the original stop and monotone (a ratchet
   never moves down). `paper_positions.trailing_stop` was NULL on all 51
   historical positions — this is the first code path to write it.
3. **Dead-trade cleanup** — a position with `sessions_held ≥ 5`
   (`TU_DEAD_TRADE_SESSIONS`) whose MFE never reached 0.5R
   (`TU_DEAD_TRADE_MFE_R`) closes as `TIME_LIMIT` (the existing reason, so
   every downstream report keeps working), in both the intraday monitor and
   the end-of-day settle.

Verification: workspace typecheck ✓, tests 259 server + 164 tucore + 70 web
✓ (4 new exit tests, incl. twin seeded flow-neutrality and a settle-level
TIME_LIMIT close), build ✓, image `333327787de7…` started 20:24:17Z, live
probe of the deployed container returns the five knobs
`{floor:0.8, armR:1, trailAtr:1.2, deadSessions:5, deadMfeR:0.5}`, jobs
`ok`, `/pp/api/tradingusa/calibration` 200, PAPER_ONLY guard unchanged.

## Proposed next increments (need your go — each can change trade flow)

1. **Bias sizing toward what proved out** — scale `riskPerTradePct` by the
   calibrated win rate of the setup's bucket (upward bias only, never a
   block): the 0.55-confidence bucket has been the winner, so it would get
   the larger share.
2. **Trailing stop** — activate `trailing_stop` at 1×ATR once MFE ≥ 1R so
   the 16 REGIME_CHANGE exits and the give-back trades lock profit instead
   of round-tripping.
3. **Honest targets** — set `target` from the calibrated expected return
   instead of the raw one, which pulls 10/51 target hits closer to the
   realized distribution (this one does shrink some trades: shadow first).
4. **Regime sizing instead of regime veto** — in `HIGH_VOLATILITY`, halve
   size rather than refuse, so the book keeps collecting outcomes while the
   gate stays on for BEAR/RISK_OFF/LIQUIDITY_STRESS.