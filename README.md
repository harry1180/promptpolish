# PromptPolice

**LLM prompt cost optimizer. Measure. Optimize. Compare. Save.**

PromptPolice estimates how much any LLM prompt will cost — before it is ever
sent — and rewrites it to cost less without changing what it does. The
optimizer runs **fully client-side**; prompt text never leaves the browser.
An optional org account (`apps/server`) adds **tagged accounts** and a
cross-user **executive dashboard**: every optimization is stamped with the
account's tags (`cost_center=10`, `team=payments`, …) and metrics — counts
and dollars only — roll up across all users for any tag combination.

- **Measure** — live token counting (per-model tokenizer families, always
  labeled `estimated` vs `exact`) and cost math against one central price file.
- **Optimize** — a deterministic two-stage engine that removes politeness,
  duplicated instructions, restated constraints and filler while protecting
  placeholders, JSON schemas, XML tags, code blocks and safety rules verbatim,
  with a preservation score and a visible diff.
- **Compare** — the same prompt priced across 14 models from 7 providers
  (input, output, and total per request) plus monthly savings projections at
  1K–1M requests.
- **Output side** — projected response length per prompt (shape priors,
  calibratable with real measurements) and per-provider output cost.
- **Cache** — a local two-layer (exact + lexical-semantic) prompt cache with a
  live-vs-shadow eviction-policy comparison (SIEVE serving; LRU, LFU, TinyLFU,
  FIFO, Belady-MIN shadowed on your own traffic).
- **Govern** — every query is screened locally: PII/secret labels, intent
  categorization, injection guardrails, and a fail-closed interlock that
  decides what the cache may reuse.
- **Roll up** — signup collects organization tags as key/value pairs; the
  executive dashboard filters and groups by ANY combination of them across
  users (dollars saved, projected annual, spend-if-unoptimized, daily
  trend, per-cost-center and per-user breakdowns).
- **Ask (governed)** — real LLM conversations through the org server with
  your own provider keys (AES-256-GCM at rest, masked everywhere else):
  every query is screened by the same governance engine before it leaves
  (PII → redact first, injection → refused outright, zero provider
  traffic), AUTO routing picks a balanced model from the same 14-model
  price table (or choose one explicitly), and every call comes back with
  exact provider token counts and real cost — metered into the same
  tag-combination dashboard.

Live repo layout: pnpm monorepo, TypeScript strict, React 19 + Vite + Tailwind
(v4) web app; engine packages are DOM-free so the Phase-2 Chrome extension can
import them unchanged.

## Quick start

```bash
pnpm install
pnpm dev:all      # web on http://localhost:5173 + org server on :8787 (proxied via /api)
pnpm dev          # web only (dashboard/account features show "server unreachable" until `pnpm server`)
pnpm server       # org server only (SQLite auto-created at apps/server/data/promptpolice.db)
pnpm test         # engine + analytics + web UI + server integration suites
pnpm typecheck    # tsc strict, whole workspace
pnpm build        # production bundle → apps/web/dist
```

## Where things live

| Path | What |
|---|---|
| `packages/shared-types` | All interfaces (ModelEntry, TokenCount, OptimizationResult, …). No logic. |
| `packages/model-config` | `models.json` — the single source of truth for models + prices + tokenizer families. |
| `packages/token-counter` | Input token estimation (`estimated`/`exact` seam), output-length projection (calibration seam). |
| `packages/pricing-engine` | All cost math: per-request, savings, tiers, cross-model comparison. No UI knows a price. |
| `packages/privacy-detector` | Local PII/secret rules with masked samples (email, phone, keys, SSN, card, IP). |
| `packages/optimizer` | Deterministic optimization engine (levels, protected spans, change log, preservation scores) + analysis bundle. |
| `packages/cache` | PromptCache: exact + lexical-semantic lookup bands, governance interlock, 6 eviction policies (1 live + 5 shadow incl. offline Belady replay), LocalStorage adapter. |
| `packages/governance` | Query screening: PII labels, intent categories, injection guardrails, verdict ladder (`allow / review / redact-required / block`). |
| `packages/llm-connect` | Provider adapters (OpenAI-compatible / Anthropic / Google), exact-usage normalization, AUTO model routing. DOM-free. |
| `packages/analytics` | Pure rollup math: tag validation, AND-combination filtering, savings rollups, group-by buckets, daily series, projections. DOM-free. |
| `packages/shared` | Diff utilities, history store, TXT/MD/JSON export builders. |
| `apps/web` | React app: thin wiring layer; all state in `hooks/usePromptSlim` + `hooks/useAccount`; executive dashboard in `components/DashboardPanel`. |
| `apps/server` | Org server (node:http + node:sqlite, zero deps): signup **with tag key/value pairs**, scrypt passwords, cookie sessions, tag-snapshotted usage events, cross-user tag-combination aggregation API. |

Full design, data flows, and decision records: **`docs/ARCHITECTURE.md`**.

## How the numbers are honest

1. **Token counts are labeled.** Every count carries `method: estimated|exact`
   and the engine name. A pluggable `setExactTokenProvider()` seam upgrades to
   real tokenizers (e.g. tiktoken WASM) without touching the UI.
2. **Prices are config, not code.** `models.json` holds every number with a
   `pricingLastUpdated` stamp and disclaimer rendered in the UI.
3. **Output length is a projection, never a claim.** Three tiers: your
   calibration measurements > response-shape priors > manual override — each
   labeled in the UI ("projected", "calibrated · N measured", "your manual
   setting").
4. **Cache similarity is lexical.** The semantic layer is hashing-trick TF
   cosine on-device (an explicit stand-in for embeddings) and the UI says
   "local lexical" wherever a score appears.
5. **Guardrails never silently rewrite.** Governance labels and gates reuse;
   a blocked query produces no optimization and no cache interaction.

## Roadmap seams (already in code)

- **Phase 2 — Chrome MV3 extension**: engine packages are DOM-free and
  storage-agnostic (`makeCacheStore(localStorage)` swaps to
  `chrome.storage.local`); all UI state lives in one reusable hook.
- **Phase 3 — AI semantic stage + real LLM calls**: `ExactTokenProvider` and
  `OutputCalibrationSource` seams; API `usage` fields feed the cache
  measurement payloads; the governance gate is the insertion point for any
  outbound-call policy.

MIT-style MVP. See `docs/ARCHITECTURE.md` for internals and trade-offs.
