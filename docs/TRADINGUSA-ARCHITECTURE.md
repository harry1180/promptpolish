# TradingUSA — Architecture (Phase 0 findings + decisions)

TradingUSA is a market-intelligence + PAPER-TRADING module mounted inside the
existing PromptPolice/AgenticAlchemy Governance app at
`https://governance.agenticalchemy.io/tradingusa`.

## Phase 0 inspection findings

- **Repo**: pnpm monorepo at `/opt/yard/promptpolish`. TypeScript strict,
  React 19 + Vite + Tailwind v4 (`apps/web`), zero-dependency `node:http` +
  `node:sqlite` server running TypeScript directly under Node's type stripping
  (`apps/server`), DOM-free engine packages in `packages/*`.
- **Routing**: SPA is path-mounted from `apps/web/src/main.tsx` by pathname
  prefix (existing example: `/agent-control-tower`). Server routes are all
  `/api/...` and exposed at the edge under `/pp/api/*` (Traefik `pp-strip`
  middleware removes `/pp`).
- **Edge**: Traefik v3 docker labels in `docker-compose.yml`. Priorities:
  pp-api 61, pp-web 60, live 50/40, cx-trust console 30/20, catch-all 10.
- **Auth**: PromptPolice session cookie for `/api/*` data routes; TradingUSA
  is a read-only public research dashboard (no auth required to view, no
  mutations from the browser — all trading activity is server-side paper-only).
- **DB**: SQLite (`node:sqlite`), WAL, `/data/promptpolice.db` on volume
  `pp-data`. ACT module already demonstrates multi-store isolation.
- **Deployment**: `docker compose build && docker compose up -d` from repo
  root; server `node --env-file-if-exists=.env src/index.ts`.
- **CI/CD**: none in repo; deploy is manual compose on this host.
- **Design system**: dark "ink/mint" tokens in `apps/web/src/styles.css`
  (`--color-ink-950` base, `--color-mint` accent, mono numerics).

## Secrets

- `GROQ_API_KEY` / `GEMINI_API_KEY` live in `/opt/yard/tradingusa/.env`
  (outside the repo, chmod 600). The `server` service loads it via compose
  `env_file:` — keys exist only as container process env on the server.
- Keys never reach: repo, git, bundle, browser, API responses, logs, DB.
  The frontend only ever sees status enums
  `CONNECTED | UNAVAILABLE | RATE_LIMITED | ERROR (+ DEGRADED, QUOTA_EXHAUSTED, CIRCUIT_OPEN, LOCAL_ONLY)`.
- `.gitignore` covers `.env`, `.env.local`, `.env.*` (except `.env.example`).

## Stack decision vs spec's "recommended stack"

The spec says *preserve the existing stack where reasonable* and *use a
modular monolith initially*. Building a parallel Python/FastAPI/Postgres/
Redis/Celery deployment would mean a second app, second proxy config, second
monitoring surface — and the acceptance criteria require everything under one
URL. Decision: **implement TradingUSA inside the existing monorepo** in
TypeScript: domain logic in a new DOM-free package `packages/tucore`, HTTP +
workers + storage in `apps/server/src/tradingusa/`, UI in
`apps/web/src/tradingusa/`. Storage is a **separate SQLite file**
(`/data/tradingusa.db`) so existing Governance data is untouched.

Replacements for spec suggestions:
- PostgreSQL/TimescaleDB/pgvector → SQLite (separate file) + in-process
  semantic index (keyword/metadata-filtered); revisit if scale demands.
- Redis → in-process cache (LLM response cache is content-addressed in DB).
- Celery/Dramatiq → in-process session-aware scheduler (`workers.ts`).
- scikit-learn/XGBoost/LightGBM → deterministic local factor models + small
  logistic-style weighting implemented in TS (Phase 5 extends).
- Next.js → existing React 19 + Vite SPA (path-mounted).
- TradingView Lightweight Charts → bundled lightweight chart lib or custom
  SVG/canvas sparkline (decided at UI time).

## Market data

- Provider abstraction `MarketDataProvider` (quotes / candles / historical /
  market status), first provider **YahooFinanceProvider** using the public
  `query1.finance.yahoo.com/v8/finance/chart` endpoint (works from this host;
  the v7 quote endpoint is auth-walled). Data is **DELAYED** — stored and
  labelled as such; never mixed with real-time/EOD without provenance fields.
- **Yahoo answers 429 on every endpoint from this VPS** (spark, chart,
  query1 *and* query2 — verified repeatedly), so live quotes go through the
  fallback chain wired in `runtime.ts`, split by asset class:
  - **equities** → `AlpacaRealtimeProvider` (REST
    `/v2/stocks/snapshots?feed=iex`, `provider:'alpaca'`, `REALTIME`, keys from
    the env file), then `NasdaqEodProvider`
    (`api.nasdaq.com/api/quote/{SYM}/info`, `provider:'nasdaq'`, `DELAYED`,
    15s cache / 200ms pacing / 30-symbol cap).
  - **indexes** (`^VIX`, `^GSPC`, `^DJI`, `^NDX`, `^RUT`) →
    `CboeIndexProvider` (`cdn.cboe.com/api/global/delayed_quotes/quotes/_VIX.json`,
    `provider:'cboe'`, `DELAYED`). Nasdaq has no index endpoint and Alpaca
    rejects a batch containing `^`-prefixed symbols with
    `400 invalid symbol` — which is why the Alpaca provider filters them out;
    before that fix one `^VIX` blanked the whole realtime batch and every
    quote fell to delayed Nasdaq. Unknown index tickers are skipped, never
    guessed (`^IXIC` has no Cboe equivalent).
  - Provenance stays **per quote**, so `market_quotes.provider` truthfully
    reads `alpaca` / `nasdaq` / `cboe`.
- WebSocket-first providers (e.g. paid vendors) can be added behind the same
  interface later; no key-bearing vendor is assumed in Phase 1.

## Learning loop (outcomes → knowledge → decisions)

`apps/server/src/tradingusa/adaptive.ts` closes the loop that `learning.ts`
started; both keep the same guardrail — **one trade never rewrites production
logic, and no LLM ever edits strategy code**.

1. **Outcomes (wins included).** `learnFromOutcome()` runs for every closed
   trade next to `analyzeClosedTrade()`: it writes an `OUTCOME_RECORDED`
   learning event, and when a `VALIDATED` lesson has a measurable
   prescription that held at entry (stored in the signal's `audit_json`
   → `entryChecks`), a win bumps `validations` and a loss bumps
   `contradictions`. Losers were the only thing recorded before.
2. **Learned fusion weights.** `recomputeStrategyWeights()` correlates each
   of the six `ScoreParts` with realized excess return per
   (strategy, horizon) and refits the shipped `FUSION_WEIGHTS`: evidence-shrunk,
   each part clamped to ±35% of its default and never below 40% of it,
   renormalized, and **nothing is written before `MIN_TRADES` (10) closed
   outcomes**. `runScan` reads `strategy_weights` and passes the row to
   `fuse()`; a missing or insufficient row leaves the defaults in force.
3. **Daily refresh.** The `knowledge_consolidation` job now calls
   `refreshKnowledge()`: consolidate lessons, refit weights, then review lesson
   gates — a `VALIDATED` lesson whose contradictions dominate is revoked
   (its gate switches off in `runScan`) and may be re-proposed after
   `REPROPOSE_AFTER` (3) fresh observations in the same mistake cluster.
   Every step lands in `learning_events` (`WEIGHT_REFRESH`,
   `LESSON_REVOKED`, `LESSON_REPROPOSED`, `LESSON_CONFIRMED`,
   `LESSON_CONTRADICTED`, `KNOWLEDGE_REFRESH`) so the loop is auditable.
4. **Rule experiments (shadow mode)** — `experiments.ts`, `GET /experiments`.
   A small library of measurable setups (volume-confirmed entry, trend
   alignment, relative strength, breakout, fresh event, favourable regime,
   high confidence) is evaluated for every signal in a date window and
   compared against the rest: matched closed trades vs the remainder, in
   win rate and average return, with the delta in percentage points. The
   module is **read-only** (no writes, `runScan` never imports it) and
   refuses a verdict below `MIN_TRADES` matched closed trades. Purpose:
   decide where conviction should be added — graduation may only bias a
   proven setup UP, never filter trades out. Rendered on the Learning page
   with a from/to + preset date filter.

## Public intelligence sources (verified reachable)

- SEC EDGAR (`www.sec.gov` browse-edgar atom + `data.sec.gov` companyfacts) —
  filings + fundamentals, requires User-Agent header.
- Yahoo Finance RSS per ticker — headlines (its RSS host is NOT throttled,
  only `query1`/`query2`).
- U.S. Treasury daily yield curve CSV — macro rates.
- VIX / indexes via Cboe delayed single-symbol quotes (Yahoo chart endpoint
  when it answers).

## LLM boundary

All cloud LLM traffic goes through `InferenceRouter`
(`apps/server/src/tradingusa/inference/`): provider registry (Groq primary,
Gemini secondary), model registry, quota manager (daily call/token budgets
+ reserve), health checker, circuit breaker, task router, response cache
(content hash + prompt version), prompt versioning, usage ledger (DB),
quality tracker, fallback manager, LLM value router (novelty × materiality ×
uncertainty × historical benefit). Market data, indicators, P&L, risk and the
trading loop never call an LLM; with both keys disabled the system runs in
LOCAL_ONLY_MODE.

## Execution guard

`EXECUTION_MODE=PAPER_ONLY` is a hard constant: the only executor is
`PaperBrokerService`. `BrokerAdapter` interface exists with
`PaperBrokerAdapter` as the sole registered adapter; `RobinhoodAdapter` is an
interface stub only (no network, no auth, not registered).