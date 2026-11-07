# TradingUSA — operations guide

Market-intelligence + PAPER-TRADING module of the Governance app:
`https://governance.agenticalchemy.io/tradingusa`

## Layout

- Domain logic: `packages/tucore` (pure, DOM-free, network-free; vitest)
- Server: `apps/server/src/tradingusa/`
  - `schema.ts` — separate SQLite DB (`TU_DB`, default `/data/tradingusa.db`);
    Governance DB never touched. `signals` is write-once (SQL triggers).
  - `providers/` — Yahoo (delayed quotes + daily bars), SEC EDGAR, Yahoo RSS,
    Treasury CSV. All behind the `MarketDataProvider` abstraction.
  - `inference/router.ts` — InferenceRouter (Groq primary, Gemini secondary):
    provider/model registries, quotas + reserve, health, circuit breaker,
    task router, response cache, prompt versioning, usage ledger, quality
    tracker, fallback, LLM value router. Only import site for provider keys.
  - `engine.ts` — scan pipeline; `ingestTick()` is provably LLM-free (test).
  - `broker.ts` — PaperBrokerService (fills, stops/targets, MFE/MAE, exits).
  - `intake.ts` — news/filings/macro/fundamentals → deduplicated events.
  - `learning.ts` — mistake pipeline, clusters, candidate lessons/rules.
  - `workers.ts` — session-aware scheduler (ComputeBudgetController-driven).
  - `guard.ts` — ExecutionGuard, PAPER_ONLY; only PaperBrokerAdapter exists.
- UI: `apps/web/src/tradingusa/` (mounted by pathname prefix in `main.tsx`).
- Docs: `docs/TRADINGUSA-ARCHITECTURE.md`, `docs/TRADINGUSA-API.md`.

## Secrets

`GROQ_API_KEY` / `GEMINI_API_KEY` live in `/opt/yard/tradingusa/.env`
(chmod 600, outside the repo; `.gitignore` covers `.env*`, `*.secret`,
`secrets/`, `*.key`). Docker Compose injects that file via `env_file:` on
the `server` service — container process-env only, never in the image, never
in any HTTP response. The UI sees status enums only
(`CONNECTED/UNAVAILABLE/RATE_LIMITED/QUOTA_EXHAUSTED/DEGRADED/CIRCUIT_OPEN/
LOCAL_ONLY/ERROR`).

Rotate a key: edit `/opt/yard/tradingusa/.env`, then
`docker compose up -d server` (recreates the container; no image rebuild).

## Edge routing

`pp-web` router (priority 60) now also claims `PathPrefix(/tradingusa)`;
API lives under `/pp/api/tradingusa/*` (priority 61, existing strip). No
other router labels changed — `/console`, `/api`, `/live` untouched.

## Operator commands

```bash
cd /opt/yard/promptpolish
pnpm install --frozen-lockfile
pnpm run typecheck && pnpm run test && pnpm run build

docker compose build
# terminal() rejects foreground `up` — run it detached:
docker compose up -d
docker compose ps

# verification
curl -s https://governance.agenticalchemy.io/pp/api/tradingusa/status | head -c 400
curl -so /dev/null -w '%{http_code}\n' https://governance.agenticalchemy.io/tradingusa
curl -so /dev/null -w '%{http_code}\n' https://governance.agenticalchemy.io/            # PromptPolice still 200
curl -so /dev/null -w '%{http_code}\n' https://governance.agenticalchemy.io/console     # still 401
curl -so /dev/null -w '%{http_code}\n' https://governance.agenticalchemy.io/live        # still 200
```

## Failure modes (by design)

- **Both LLM keys absent/broken** → router answers `LOCAL_ONLY`; scans,
  signals, paper fills, stops, P&L, UI all keep working (test-covered).
- **Market data provider down** → quotes degrade; paper fills fall back to
  the last available price with an explicit note; DataQuality gates can
  block new entries.
- **Kill switch** (`/system`) → new paper positions stop when quotes are
  stale during market open, providers fail, drawdown exceeds
  `TU_KILL_SWITCH_DRAWDOWN` (default 25%), the strategy misbehaves, or the
  regime is UNCERTAIN. Existing positions keep being monitored.

## Environment variables (server)

`TU_DB`, `TU_WORKERS=1`, `PILOT_MODE`, `TU_SHORT_CAPITAL` (100000),
`TU_LONG_CAPITAL` (100000), `TU_RISK_PER_TRADE` (0.0075),
`TU_MAX_POSITION_PCT` (0.1), `TU_MAX_SECTOR_PCT` (0.3),
`TU_MAX_CORRELATED_PCT` (0.4), `TU_MIN_RISK_REWARD` (1.5),
`TU_FILL_MODE` (`AT_SIGNAL`|`NEXT_OPEN`), `MAX_ROUTINE_LLM_CALLS_PER_DAY` (30),
`MAX_HIGH_PRIORITY_LLM_CALLS_PER_DAY` (15), `LLM_RESERVE_PERCENT` (25),
`TU_GROQ_TOKENS_PER_DAY` (120000), `TU_GEMINI_TOKENS_PER_DAY` (200000),
`TU_LLM_VALUE_THRESHOLD` (0.35), `TU_GROQ_MODEL`, `TU_GEMINI_MODEL`,
`TU_UNIVERSE` (comma list override).

## Not in this release (honestly)

- Real-time WebSocket vendor feeds (provider interface ready; current source
  is batched REST polling, labelled DELAYED).
- Real-money brokers: `RobinhoodAdapter` is an interface stub only.
- Automatic Champion promotion: candidates require backtest + walk-forward +
  out-of-sample + shadow evidence, applied manually.
- pgvector/Timescale/Redis/Python stack: SQLite + in-process cache/scheduler
  cover current scale (see architecture doc for the rationale).