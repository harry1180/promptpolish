# Crypto correction phase — before/after report

Date: 2026-11-07. Scope: approved items 1-10. Everything ran against the
PAPER_ONLY book; the 5 open positions and all production thresholds were
untouched. Only items 1 (entry/stop geometry guard) and 3 (tests) changed
behavior; stop distances, target rules, confidence thresholds and strategy
parameters are PROPOSALS pending validation.

## 1. All eight trade states

| # | Coin | State | Entry | Now/Exit | Net |
|---|------|-------|-------|----------|-----|
| 1 | OKB | CLOSED (STOP_REACHED, printed below stop: gap-through) | 106.84 | 105.36 | -$169.22 |
| 2 | NEAR | CLOSED (STOP_REACHED at stop) | 3.7095 | 3.6328 | -$238.37 |
| 3 | UNI | CLOSED (STOP_REACHED at stop) | 6.8815 | 6.7681 | -$196.91 |
| 4 | ZEC | OPEN, stop 1205, target 1605.49 | 1246.11 | 1315.3 | +$553 (u) |
| 5 | XMR | OPEN, stop 568.28, target 716.19 | 615.10 | 611.49 | -$56 (u) |
| 6 | QNT | OPEN, stop 185.29, target 249.77 | 188.56 | 194.26 | +$300 (u) |
| 7 | UNI (re-entry) | OPEN, stop 6.7681, target 8.7305 | 6.9113 | 7.0262 | +$166 (u) |
| 8 | NEAR (re-entry) | OPEN, stop 3.6201, target 4.9787 | 3.6861 | 3.7510 | +$175 (u) |

Realized: -$604.49 net (-$509.46 gross, -$95.03 fees). Win rate 0/3.
Open: +$1,138 unrealized (measured at report time). Nothing modified.

## 2. Root cause per closed trade

All three: stop = strategy invalidation 0.19-0.21x daily ATR14 (OKB 1.04%,
NEAR 2.07%, UNI 1.65% below entry) while that day's ranges were 11.1% /
3.7% / 16% in a -5.5% BTC BEAR_TREND session. checkExit (tucore broker.ts)
fired STOP_REACHED within 12/22/45 minutes; exit price = min(stop, bid),
so OKB printed 105.36 vs stop 105.73 (real gap-through, correctly modeled).
Secondary defect: every order's entry band dipped BELOW its own stop
(entryLow < invalidation on all three) - the system would accept fills inside
its own invalidation zone.

## 3. Fixed-horizon directional accuracy (item 2, NEW endpoint)

GET /pp/api/crypto/accuracy -> evaluateFixedHorizons() in
apps/server/src/crypto/accuracy.ts. Reports 30s / 60s / 5m / 30m / 1d for
every elapsed signal, BUY and SELL separately, vs always-UP / always-DOWN /
persistence baselines + class balance, with exact signal and outcome
timestamps per row. No look-ahead: outcome is the first observation at/after
signal_ts+horizon (micro_snapshots for <=30m; first daily bar at/after the
horizon date for 1d).

Current data limits (stated, not imputed): micro_snapshots began 2026-11-07,
so 30s/60s/5m/30m start with near-zero n; 1d works for all historical
signals. The earlier 84.6% point-in-time figure is explicitly NOT a
fixed-horizon measurement and is superseded by this endpoint.

## 4. Realized P&L, fees, latency

- Realized net: -$604.49 over 3 trades; fees $95.03 = 19% of the loss.
- Configured fee 0.16%/side (32bps round trip). VERIFIED against Kraken's
  published schedule (kraken.com/fee-schedule, checked 2026-11-07): base
  Tier 1 is 0.40% maker / 0.80% taker - the config UNDERSTATES real Kraken
  taker fees by 2.5-5x. A real account at Tier 1 pays 160bps round trip.
  PROPOSAL (not changed): CRYPTO_FEE_PCT=0.004 until the account's actual
  tier is read from the authenticated API (no keys configured).
- Latency decomposition (8 orders, created_at -> filled_at):
  signal calc <1s (in-scan), order created at signal timestamp (0s),
  queue/scheduler = the entire 5.0-15.3s (order_processing cycle gating,
  workers.ts due('order_processing', 15_000)), fill = REST quote fetch
  ~50-140ms + simulated execution, Kraken ack = N/A (paper; measuring
  submission->ack needs authenticated live orders and is a pre-production
  gap). Submission-to-fill == scheduler delay by construction.

## 5. Entry/stop/target geometry (item 4)

Closed group: risk 1.04-2.07%, reward 20.5-36.6%, R:R 16-22 recorded.
Open group: risk 3.3-7.6% (stops wider - ZEC -3.3%, XMR -7.6%, QNT -1.7%,
UNI -2.1%, NEAR -1.8%), reward 15.9-34.9%, R:R 4.7-9.6. Entry, stop,
target, volatility and costs are internally consistent per trade EXCEPT
the known issues: (a) 32bps RT cost assumes 0.16% fees (see 4),
(b) target = price + 3*ATR14 daily vs holding horizon 20 sessions is
coherent for swing but unreachable before a 0.2x-ATR stop in practice.

Target-hit-before-stop (first-passage on daily bars, all 15 BUY signals, up
to 20 sessions after the signal; same-bar both-hit = ambiguous, no hit =
censored):
  stop-first 4 | target-first 0 | ambiguous 0 | censored 11
  P(target before stop | resolved) = 0.0% (0 of 4 resolved, incl. ambiguous)
Read with care (n small, 11 censored): no historical BUY setup ever reached
its +20-37% target before its stop fired; the ones that resolved all hit the
stop first. The reward side of the recorded R:R 15-20 has never paid out.

Stop-distance alternatives (0.5-1x ATR minimum NOT imposed, per instruction):
PROPOSALS to backtest before adoption:
  A. stop = max(invalidation, price - k*ATR14) with k in {0.5, 1, 1.5, 2}
  B. vol-targeted stop: risk = x% of equity => stop distance = x%*equity/size
  C. keep invalidation stops but require stopDist >= k*ATR as a GATE
     (fewer entries, no stop widening on open positions)
  D. time-stop: exit if unrealized < 0 after N minutes (scalping horizon)
Each must be walked through scripts/crypto-backtest.mts methodology +
walk-forward; none applied.

## 6. Confidence calibration (item 5)

Verdict: INTENDED WEIGHTING BEHAVIOR with a coarse input, not a bug.
- fusion confidence = clamp(hint * (0.7 + 0.3*|weighted|)) (fusion.ts:136).
- All 11 BUY signals carry exactly 0.5136986301369862 - the strategy hint
  (st.confidence) is quantized to a handful of levels, so every BUY lands on
  one value; SELLs show 4 distinct values (0.5028/0.5137/0.5334/0.754-0.8001).
- Not a normalization defect (values pass the 0.5 floor cleanly), not a
  ceiling bug (SELLs reach 0.80). The 0.50 floor admits a single
  indistinguishable BUY band, so confidence currently carries ~no
  cross-signal ranking information for longs.
- Calibration / precision-by-band / incremental value: CANNOT be computed
  yet - 0 winning BUY outcomes, n=3 closed trades. Do NOT raise the
  threshold or reweight to manufacture a trade rate (explicitly prohibited).
  Recorded for the future: hint, weighted and conflicts are already in
  signals.audit_json; once outcomes accumulate, evaluate reliability
  curves per band from there.

## 7. Re-entry (item 8)

Finding: CRYPTO_REENTRY_COOLDOWN is read by config but referenced NOWHERE
in the crypto module - the knob is dead. The only brakes are (a) one signal
per (symbol, session-date, action) and (b) the held-set while a position is
open. UNI re-entered 6.5h after its stop-out, NEAR 10h later - both next ET
session date, i.e. hours not sessions. Broker-level re-entry is immediate
(documented by a test).
PROPOSAL (not implemented): per-asset, per-strategy WALL-CLOCK cooldown
(CRYPTO_REENTRY_COOLDOWN_SEC), default from a backtest grid {0, 4h, 8h,
12h, 24h} measuring re-entry expectancy after stop-outs; never session
counts as the unit.

## 8. Separate strategy horizons (item 7)

The existing implementation is swing-oriented: target = price + 3*ATR14
daily, max hold 20 sessions, daily-bar settlement, confidence gate on
SHORT horizon. Confirmed by inspection - treat as SWING.
PROPOSED scalping architecture (design only, no code):
- Shares the EXISTING Kraken WS connection, ingestTick, market_quotes/bars,
  micro_snapshots observers (stream.ts hooks extraChannels/onRawMessage).
- New strategy id (e.g. crypto_scalp_v1) with its OWN config namespace:
  entries from micro features (OFI, imbalance, spread) at 10-60s horizons,
  targets 2-5x spread, stops ATR(sub-minute)-scaled, cost gate at REAL
  taker fees, hard max hold in minutes.
- Its signals NEVER write into swing positions: separate strategy column,
  separate portfolio book or at minimum separate risk limits; swing
  stop/target/hold rules read only swing signals (enforced by strategy id
  filter in engine/broker).
- Rollout: shadow -> paper -> (explicit approval only) live. Feature flag
  CRYPTO_SCALP_STRATEGY_ENABLED, default 0.

## 9. Opportunity optimization experiment (item 10, design only)

Run AFTER this correction phase stabilizes and the fixed-horizon endpoint
accumulates data. Configs x metrics on a WALK-FORWARD split (train on the
first ~70% of sessions, validate on the held-out 30%, one shot - no tuning
on the holdout):
- Configs: entry gate variants x stop A-grid x cooldown grid (proposal A-D
  above), all evaluated against the SAME signal stream.
- Metrics: fixed-horizon directional accuracy (per horizon, per side),
  realized net P&L after REAL fees, max drawdown, turnover, fee drag %,
  time-under-water.
- Baselines to beat: current config + always-up/down/persistence.
- Output: recommendations only; applying anything still needs approval.

## 10. Regression tests (item 3, DONE)

apps/server/test/crypto-guard.test.ts - 15 tests, all green:
geometry unit + historical-trade conflict, fill-below-stop rejection with
reason codes + audit row, guard-off rollback path, healthy fill + cash math,
order states PENDING/FILLED/REJECTED/CANCELLED (ack vs fill), full replay of
OKB/NEAR/UNI through monitorPositions asserting exit price, slippage-below-
stop, gross/net/return to the recorded cents, fee arithmetic, cash
reconciliation, position/trade consistency invariants, same-day re-entry
documented, stale-data gate, checkExit priority + trailing + gap-through,
fixed-horizon module structure + no-look-ahead assertion.
Full suite: 124/124 pass, typecheck clean.

## 11. What changed vs before (item 1 + 3 only)

Code: guard.ts (new), accuracy.ts (new), engine pre-submit guard, broker
fill-time guard, config entryStopGuard/entryStopBufferPct, routes /accuracy,
2 test files touched (new suite + fixture fix). Flags:
CRYPTO_ENTRY_STOP_GUARD (default ON, set '0' to roll back),
CRYPTO_ENTRY_STOP_BUFFER_PCT (default 0.001).
Behavior deltas: (1) BUY orders whose executable entry does not clear
stop*(1+buffer) are rejected pre-submission / at fill with reason codes
ENTRY_EXEC_BELOW_STOP, ENTRY_BAND_OVERLAP_STOP (advisory), BAD_GEOMETRY,
UNSUPPORTED_SIDE; (2) band overlaps are counted (bandOverlap) in scan audits.
No stops widened, no targets changed, no thresholds touched, no open
position or live order modified, no clamping anywhere.

## 12. Remaining risks before production (live money) rollout

1. Fee assumption understates Kraken Tier-1 taker by 2.5-5x (needs the
   account's real fee tier from the authenticated API).
2. Kraken submission->ack latency unmeasured (paper only); fill model is
   REST-quote simulation, not book depth.
3. Stop distances remain ~0.2x ATR until proposals A-D are backtested and
   approved - the guard prevents invalid ENTRIES but does not fix too-tight
   stops.
4. Confidence carries no ranking information for BUYs (single band); no
   calibration possible until outcomes exist.
5. Sub-minute accuracy n is ~0 until micro_snapshots accumulate days of data
   (7d retention - persist horizon outcomes before pruning if long-term).
6. Re-entry cooldown is dead config; wall-clock cooldown not implemented.
7. 3-trade sample: no statistical claim about win rate is possible yet.
8. OFI-XGBoost/meta-labeling: must wait for baseline validation per spec.
