# Scalping strategy separation + experiment design (PROPOSALS)

Status: design only. Nothing in this document is implemented. It answers
approved correction-phase items 7 (separate strategy horizons), 8 (re-entry
controls) and 10 (opportunity optimization experiment). The existing
strategy is swing-oriented (atr3 targets, 20-session max hold, daily
settlement) and must stay untouched while any of this is evaluated.

## 1. Why the current strategy is swing, not scalping

- target = price + 3 * ATR14(daily) => +15..40% targets
- max hold = 20 sessions, settle_hourly evaluates daily bars
- signal horizon = SHORT in the fusion sense but geometry is multi-day
- 15s order cycle + 0.2x-ATR stops make sub-minute economics impossible

## 2. Proposed scalping strategy (separate, sharing the feed)

Non-negotiables honored: same Kraken WS connection, same ingestTick /
market_quotes / market_bars / micro_snapshots, same stream.ts hook points
(extraChannels, onRawMessage) - no second socket, no duplicate
subscriptions, no LLM in the loop.

    Kraken WS v2 (existing)
      -> stream.ts (existing)
      -> ingestTick / micro observers (existing)
      -> strategy router
           |- crypto_momentum_v1 (swing, UNCHANGED)
           `- crypto_scalp_v1    (NEW, flag CRYPTO_SCALP_STRATEGY_ENABLED=0)

- Entries: micro features (OFI proxy from trade flow, TOB imbalance,
  spread, microdev) with horizons 10-60s; meta-labeler (item: separate
  model) gates entries when trained - until then shadow only.
- Exit geometry: target = k * spread or fixed bps; stop = m * sub-minute
  ATR; hard time stop (max minutes held).
- Costs: gate on REAL Kraken taker fee for the account tier; a trade must
  clear (fees + 2*spread) expected edge before entry.
- Risk: separate limits namespace (riskPerTradePct scalp, maxPositionPct
  scalp); scalp signals cannot create swing positions or vice versa -
  enforced by filtering engine/broker on signals.strategy.
- Rollout: shadow -> paper -> live, each step explicit approval.

## 3. Re-entry controls (wall-clock, not sessions)

- Finding: CRYPTO_REENTRY_COOLDOWN is dead config in the crypto module;
  UNI/NEAR re-entered 6.5h/10h after stop-outs (next ET session date).
- Proposal: per (asset, strategy) wall-clock cooldown
  CRYPTO_REENTRY_COOLDOWN_SEC + optional re-entry validation (e.g. new
  signal must have confidence > first entry's, and quote freshness < 30s).
- Backtest grid before adoption: {0, 4h, 8h, 12h, 24h} x {no validation,
  higher-confidence, newer-session}. Metric: expectancy of re-entries vs
  first entries after stop-outs. Never impose 24h without this evidence.

## 4. Opportunity optimization experiment (walk-forward + holdout)

Preconditions: correction phase merged, fixed-horizon endpoint producing,
>= 2 weeks of micro_snapshots.

- Split: chronological 70% train / 30% holdout by session date; the
  holdout is touched exactly once, at the end.
- Config space (each axis swept on train only):
  stop alternatives A-D from CRYPTO-CORRECTION-REPORT.md section 5,
  cooldown grid (section 3), entry guard buffer {0, 5, 10, 25 bps},
  confidence floor {0.50, 0.55, 0.60} (sweep is analysis, NOT a live
  change).
- Metrics: fixed-horizon accuracy per horizon/side, realized net P&L after
  real fees, max drawdown, turnover, fee drag %, trades/day.
- Baselines: current production config; always-up; always-down;
  persistence.
- Output: a recommendations report. Applying any winner still requires
  explicit approval - the experiment never writes production config.
