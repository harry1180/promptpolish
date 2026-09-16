# PromptPolice — Architecture

Reference: repo root `README.md` for user-facing scope. This document covers
internals: layering, data flows, each engine, storage, and the decision
records behind the non-obvious choices.

```
                              apps/web (React 19 + Vite + Tailwind)
   ┌──────────────────────────────────────────────────────────────────────┐
   │  App.tsx  ── one hook: hooks/usePromptSlim (single UI state source)  │
   │   ├─ GovernanceBanner      ├─ CachePanel       ├─ CostPanels        │
   │   ├─ PromptPane x2         ├─ ModelComparison  ├─ Changes/Diff/…    │
   └───────────────┬──────────────────────────────────────────────────────┘
                   │ imports (no business logic below components)
   ┌───────────────▼──────────────────────────────────────────────────────┐
   │                              ENGINES                                 │
   │  governance ─────► privacy-detector        cache (PromptCache)       │
   │      │                                            │                  │
   │      ▼                                            ▼                  │
   │  optimizer ──► token-counter ◄── shared-types    shared (export/diff)│
   │                    │                              │                  │
   │                    ▼                              ▼                  │
   │                pricing-engine ◄──────────── model-config             │
   │                (all $ math)                  (models.json)           │
   └──────────────────────────────────────────────────────────────────────┘
        All packages DOM-free. Storage & tokenizer are injected seams.
```

## 1. Layering rules

Dependency direction (enforced by convention, verified by `pnpm typecheck`
resolution): `shared-types → model-config → {token-counter, pricing-engine,
privacy-detector} → {optimizer, cache, governance} → apps`.

- **No UI-side pricing or counting.** Components import `pricing-engine` /
  `token-counter` accessors only; every number on screen traces to
  `models.json` or the engine output shape.
- **No DOM inside packages.** `localStorage`/`chrome.storage` reach engines
  only through injected adapters (`makeCacheStore`, `makeHistoryStore`).
  This is what lets the Phase-2 extension import engines unchanged.
- **One state hook.** `usePromptSlim` owns text/model/level/requests/
  override/result/governance/cache-outcome; components are thin props
  renderers, so the popup reuses the exact shape.

## 2. The optimize flow (per click)

```
text + modelId + level
   │
   ▼
governQuery(text)                      packages/governance
   │  verdict ∈ allow|review|redact-required|block
   ├── block ──────────────► refuse run; emit BLOCKED outcome to UI; STOP
   ▼
reuseSafe = report.reuseSafe           (PII-free AND clean verdict AND not
   │                                    regulated domain)
   ▼
cache.lookup(text, modelId, level, reuseSafe)      packages/cache
   │
   ├─ exact-hit / semantic-hit ─► recordOutcome(hit, savedTokens)
   │        │                     return cached result; fromCache=true
   │        ▼
   │      (never touches the "provider" path)
   │
   ├─ partial  ─► recordOutcome; keep neighbor hint (shape only);
   │              fall through to fresh run
   ├─ blocked-governance ─► same, with refusal note
   └─ miss ─► fresh run:
              optimizePrompt() (deterministic engine)
              estimateOutputTokens(text, modelId) for payload
              cache.put(entry) + recordOutcome(miss)
   ▼
result → metrics, cost panels, diff, exports (all read the same objects)
```

Model or level changes while a result is visible re-route through the same
path (guarded re-entrant `optimize()`), so governance and cache always see
the final query.

## 3. Token & cost engines

### 3.1 Input tokens — `packages/token-counter`

- `estimateTokens(text, tokenizerType)` → `TokenCount {tokens, method, engine}`.
- Heuristic family (~4 chars/token English): word tokens by
  `ceil(len/4)`, digit runs `ceil(len/2.5)`, punctuation 1 each,
  overhead `min(chars/24, 0.4·words)`; `o200k` variant does greedy
  char-run merging; `cl100k` = heuristic × 1.04.
- **Exact seam**: `setExactTokenProvider(p)` — register tiktoken WASM
  (Phase 2) or server counter; every downstream consumer already branches on
  `method`, so exactness changes one function.
- Placeholders (`{{var}}`, `${var}`, `{orderId}`) are single units so
  variable-heavy prompts aren't over-counted.

### 3.2 Output tokens — three-tier projection (never "exact")

Output length is decided by the model at generation time; **no offline
method can be exact**, so PromptPolice never pretends to be:

1. **Calibration (best)** — `OutputCalibrationSource` seam. The web app
   wires it to the cache's measured responses: mean measured output per
   `(model, shape)`, trusted at n ≥ 3. Labeled `calibrated · N measured`.
   Phase 3 replaces manual "Save measurement" entries with API `usage`
   fields — same seam, no UI change.
2. **Shape prior** — regex-detected requested shape (json-schema,
   classification, summary, list, code, long-form, qa) × input tokens,
   with per-shape ratio + min/max clamp. Honest name in UI: "projected".
3. **Manual override** — wins over both; card says "your manual setting".

`method` is always `'estimated'` because it is a projection, not a call —
documented deliberately in the API comment.

### 3.3 Cost — `packages/pricing-engine`

All math: `cost = tokens/1e6 × pricePerMillion`. Key surfaces:
`inputCostPerRequest`, `outputCostPerRequest`, `costBreakdown` (in/out/total),
`computeSavings` (**input-side only** — optimization reduces input tokens;
including output would overstate savings), `compareModels(input, output)`
across the catalog. Formatters (`formatUSD` etc.) live here so micro-amounts
render consistently.

### 3.4 Prices — `packages/model-config/src/models.json`

14 models / 7 providers (OpenAI, Anthropic, Google, DeepSeek, Qwen, Mistral,
Meta), each with input/output $/M, context window, tokenizer family,
per-entry `lastUpdated`, plus global `pricingLastUpdated` + disclaimer
rendered wherever prices appear. Adding a model = one JSON entry.

## 4. Optimizer — `packages/optimizer`

Deterministic, two-stage:

- **Stage 1 (shipped)**: rule pipeline by level (`conservative |
  balanced | aggressive`): duplicate-instruction removal, phrase
  compression, whitespace collapse, filler removal, constraint combining,
  example compression. A **mask/protect** pass (`mask.ts`) fences
  placeholders, JSON/XML/code blocks, output-format, safety, role and
  tool-definition spans first; every splitter round-trips
  (`join(split(x)) === x`) over the sample corpus.
- Output shape `OptimizationResult`: original/optimized text, `TokenCount`s,
  reduction %, `changeLog[]` (every edit with before/after + tokensSaved),
  `preservation` scores (intent/constraints/format/placeholders + warnings),
  structure analysis. Same result object is cached and re-served.
- **Stage 2 (Phase 3 seam)**: AI semantic pass slotting after Stage 1 with
  the same preservation contract and a visible "AI OPTIMIZATION" badge —
  the seam is documented in code, not implemented.

## 5. Cache engine — `packages/cache`

Grounded in GPTCache, the "GPT Semantic Cache" paper (arXiv:2411.05276),
Caffeine W-TinyLFU trace results, and SIEVE (SIGCOMM'23).

### 5.1 Two lookup layers

- **Exact**: `canonicalizePrompt` (lowercase, whitespace-collapse, strip
  punctuation, keep placeholder braces) → map lookup. Zero false positives;
  this is what "same prompt twice" hits.
- **Lexical-semantic**: `featurize()` = hashing-trick TF over word
  unigrams+bigrams (dim 4096) → cosine vs live entries. Explicitly NOT
  embeddings — strong on near-duplicate phrasing, weak on cross-vocabulary
  paraphrase; UI strings say "local lexical similarity" everywhere a score
  appears.

### 5.2 Bands and what each permits

| Band | Condition | Effect |
|---|---|---|
| `exact-hit` | canonical match, same model+level | serve (content is user's own repeat) |
| `semantic-hit` | sim ≥ 0.88, same level, **both sides governance-clean** | serve |
| `partial` | 0.6 ≤ sim < 0.88 | never serve; surface neighbor + its output-token count as calibration hint only (both-clean & same-level required) |
| `blocked-governance` | sim ≥ bar but PII on either side | refuse, note fail-closed reason |
| `miss` | below band / level mismatch | fresh run |

Level mismatch on a strong match is a `miss`: different optimization levels
genuinely produce different outputs. Serving thresholds mirror the paper's
0.8–0.92 guidance; 0.88 chosen (skews false-negative — safer).

### 5.3 Eviction: 1 live + 5 shadows

Only **SIEVE** serves. Every policy keeps independent membership and sees
identical `(lookup→best-match, put)` events, so rates genuinely diverge:

- **SIEVE**: insertion-ordered queue, one hit-bit, tail-sweeping hand that
  rotates hit-bit entries to the head and evicts the first untouched.
- **LRU / LFU / FIFO**: textbook baselines.
- **TinyLFU**: 4-row Count-Min sketch + 12% admission window into LRU main
  (Caffeine-style scan filter).
- **Belady (MIN)**: not an online backend at all — `replayBelady()` replays
  the recorded access stream offline picking true-optimal victims. Shown
  as the upper bound; UI labels it ORACLE and reports the live policy's
  gap-to-optimal.

Shadow fairness: entry data is retained beyond live eviction (bounded +500)
so a shadow that *kept* a key the live cache dropped still gets its
counterfactual hit (standard trace-simulator practice — shadows measure the
policy, the live cache decides reality).

### 5.4 Persistence

`makeCacheStore(localStorage)` serializes live entries with vectors as
entry-lists; restore re-admits shadows. Save/load failures are swallowed —
cache is best-effort; correctness never depends on it. Clear-cache wipes
memory + storage + counters.

## 6. Governance — `packages/governance`

Action-Firewall pattern: policy is deterministic rules outside the prompt,
never model discretion. Three layers, one pure sync pass (`governQuery`):

1. **Data**: privacy-detector rules → `SensitiveHit[]` with **masked**
   samples (never raw values — they also never enter localStorage beyond
   what history/export settings allow). `piiFree = no hits`.
2. **Intent**: keyword-scored categories (`customer-support, code, legal,
   medical, finance, marketing, hr, general`); top score wins, all scores
   returned for transparency.
3. **Guardrails**: injection/abuse regex families — instruction-override
   (block), system-prompt extraction (block), role-spoofing (review),
   jailbreak markers (review), disallowed-content (block) — plus an
   English-only input gate (block): the rules above are English patterns,
   so non-Latin-script input (the translation-jailbreak class) is refused
   before optimization, caching, or any provider call. Accented Latin
   letters and typographic punctuation in English prose are allowed.

**Verdict ladder** (worst wins): `allow → review → redact-required → block`.
Regulated intents downgrade at least to `review`. `reuseSafe` requires
`piiFree && verdict === allow && !regulated`; the cache interlock refuses
cross-prompt reuse otherwise, while exact self-repeat stays allowed.

## 7. UI surfaces (apps/web)

- **GovernanceBanner**: verdict chip, intent chip, PII chips (masked),
  guardrail chips, first reason line.
- **CachePanel**: last-lookup outcome badge + note + similarity
  ("local lexical"), partial calibration hint, savings counters
  (lookups / served-from-cache / tokens not re-processed), the 6-policy
  comparison table (role, hits, rate, evictions, one-liner, pros/cons in
  title, LIVE/ORACLE tags, gap-to-optimal), measurement box wiring
  `recordMeasuredOutput` → calibration, cached-prompt list with
  clean/PII dots, Clear cache.
- **CostPanels**: 6 metric cards incl. Est. output tokens (3-state label)
  and Full req. cost (in·out split); 4-column per-request cost incl.
  Output cost with projected/calibrated badge; output-length override +
  Auto; savings tiers unchanged (input-side).
- **ModelComparison**: per-provider In $/M · Out $/M · $/req in · $/req out
  · $/req total · $/mo @100K · context, with footer stating exactly which
  numbers are estimates vs config.
- **Exports**: TXT/MD/JSON reports carry the full in/out cost block and
  `output_tokens_source` (`manual` | `projected:<shape>`).
- **History** and **SensitiveBanner**: unchanged Phase-1 behavior (counts
  only unless opted in; redaction offered).

## 8. Cross-cutting invariants (test-enforced)

1. No price or token number exists in UI code (tests read the catalog).
2. Every user-visible count/cost carries its method label end-to-end
   (`method`, `engine`, `basis`, source strings in exports).
3. Raw secrets never leave `packages/*` detection layers — samples are
   masked at the rule level.
4. Cache never serves across prompts in the partial band, and never
   serves a PII-bearing entry to a different prompt (tests: `partial band
   NEVER serves`, `PII-bearing entry`).
5. Blocked governance verdict produces no result and no cache write
   (e2e test).
6. Savings claims are input-side only.

## 9. Testing & verification

- 124 tests / 12 workspace projects (119 vitest + 5 node:test server
  integration):
  unit (tokenizer + output projection, pricing math
  incl. costBreakdown/compareModels split, optimizer rules/preservation,
  privacy masks, governance verdicts, cache bands/interlock/policies/
  Belady replay, analytics tag rules/rollups) + 19 React e2e (full flow
  incl. cache exact-hit, blocked query, override, exports parse-back with
  in+out=total assertion; signup-with-tags, dashboard KPIs, AND-filter chips,
  metrics-only event reporting) + real-HTTP server suite (the cross-user
  cost_center=10 rollup scenario, tag-snapshot immutability, authz).
- Ladder before any report: `pnpm -r --if-present test` → `pnpm typecheck`
  → `pnpm build` → dev-server health check → UI-level assertions.

## 10. Known limitations (stated honestly)

- Lexical similarity ≠ embeddings: paraphrase-heavy reuse will under-hit
  by design (misses cost a re-run; false hits cost correctness).
- Prior ratios are hand-tuned until enough calibration data exists —
  hence the measurement UI; nothing claims model-specific accuracy.
- Shadow policies run at live capacity on the same stream; divergence is
  eviction-choice-only, not admission-order artifacts.
- Belady replay sees only the recorded session log (no future beyond it)
  and is O(n·members) — fine at demo scale.
- Governance regexes have false positives by design (a support prompt may
  say "ignore previous instructions" legitimately); the ladder surfaces a
  chip and reason line, never silently rewrites the user's text.
- Prices are list prices as of `pricingLastUpdated`; verify before
  relying (disclaimer rendered in every price surface).

## 11. Phase roadmap seams (already coded)

| Seam | Today | Phase 2/3 |
|---|---|---|
| `ExactTokenProvider` | heuristic estimation | tiktoken WASM in extension; server exact counting |
| `OutputCalibrationSource` | manual measurements via cache | API `usage` fields auto-populate |
| Cache store adapter | `localStorage` | `chrome.storage.local` / IndexedDB |
| Governance gate | pre-optimize screen | pre-outbound-call policy for AI stage |
| State hook | web | popup + side panel reuse unchanged |
| Aggregate API scope | any member sees org-wide rollups | RBAC layer (per-cost-center visibility) in front of `/api/aggregate` |
| Server storage | `node:sqlite` file | Postgres/ClickHouse behind the same `queryEvents`/`buildAggregate` shapes |

## 12. Accounts, tags & the executive dashboard

The one place a server is genuinely required: metrics from *several users*
must meet in one aggregate (all five accounts tagged `cost_center=10` roll up
together). Everything else stays local-first.

### 12.1 Shape

- `apps/server` — `node:http` + `node:sqlite` + `node:crypto`, zero runtime
  deps, runs TS directly on Node ≥ 22.6. Routes: `/api/signup|login|logout|me`
  `/api/me/tags` (PUT), `/api/events` (POST), `/api/aggregate` (POST),
  `/api/tags/facets`.
- `packages/analytics` — the rollup math (validation, AND-filters, buckets,
  series, projections) is DOM-free pure functions; the server is a thin SQL +
  HTTP shell around them, so the extension can reuse the same logic offline.

### 12.2 Tag model (the core requirement)

- Signup collects **key/value tag pairs**; the same editor lives behind
  `PUT /api/me/tags` (validation rules shared via `validateTags`).
- Every usage event stores a **snapshot** of the account's tags at write time
  (`events.tags_json` + indexed `event_tags(event_id, key_l, value)`).
  Editing tags later only redirects *future* events — historical rollups
  never mutate (tested).
- Filters combine with **AND**: `cost_center=10 AND team=payments` selects
  exactly the users carrying both, via one EXISTS subquery per filter on the
  `(key_l, value)` index. Keys match case-insensitively; values exactly.
- Group-by (`/api/aggregate.groupBy`) splits the filtered population by any
  tag key — or `__user` (server injects the synthetic tag) for the per-person
  view. Events missing the key land in `(untagged)` so totals reconcile.

### 12.3 What is stored (privacy line)

`modelId, level, originalTokens, optimizedTokens, fromCache, ts` plus
server-computed USD (`pricing-engine.inputCostPerRequest` at write time —
price updates never rewrite history). **Prompt text never leaves the
browser** — the API has no field for it (asserted in tests; an unknown
`promptText` field is ignored end-to-end).

### 12.4 Executive dashboard design (apps/web `DashboardPanel`)

Screen order answers the three board-level questions, in dollars:

1. **How much are we saving, and will it matter at scale?** — KPI row:
   savings in window, projected annual (labeled *projection: window rate ×
   365, not a promise*), spend-if-unoptimized vs current spend, tokens
   avoided.
2. **Which part of the org owns the win?** — breakdown table grouped by any
   tag (default `cost_center`), sorted by savings, with users/runs/spend/
   saved/%-reduction and a TOTAL row that reconciles.
3. **Is the trend right?** — daily savings bars (inline SVG, no chart lib).

Time window (7/30/90/all) and cascading tag pickers (`/api/tags/facets`) sit
above all three, so the whole board re-cuts per audience. A footer states
which numbers are estimates and why costs freeze at write time.

### 12.5 Security decisions

- Passwords: scrypt (N=2^15) + 16-byte per-user salt, `timingSafeEqual`
  verify; login throttled per (ip,email).
- Sessions: 256-bit random token; only SHA-256(token) stored; HttpOnly,
  SameSite=Lax cookie (Secure behind `PP_COOKIE_SECURE=1`); 30-day expiry;
  server-side logout deletes the row.
- SQL: every value through prepared statements; the only dynamic SQL is
  filter-count-derived `EXISTS` placeholders (still parameterized).
- Body limit 64 KB, strict numeric bounds on events, 100k-row query cap.
- Known gap (documented, not hidden): dashboard reads are org-wide for any
  signed-in member — fine for the MVP's trust model, RBAC is the Phase-4
  seam above.

## 13. Governed LLM interaction (live chat + smart routing)

The optimizer told you what a prompt *would* cost; the chat gateway makes the
call, under the same governance and with the same tagging, so real
conversations are metered like everything else.

### 13.1 Shape

- `packages/llm-connect` — DOM-free provider adapters (OpenAI-compatible,
  Anthropic Messages, Google generateContent), response normalization to
  `{text, inputTokens, outputTokens}` from **provider-reported usage**
  (exact counts, not projections), and `routeModel()` for AUTO. Optional
  `apiBase`/`apiModel` per catalog entry lets an org repoint any id at its
  own Azure/Bedrock gateway without code changes.
- `apps/server/src/chat.ts` — the gateway: `POST /api/chat` takes a thread
  (`messages`), screens it, routes it, calls the provider with the caller's
  own key, records the event, returns text + meta.
- `apps/web` AskPanel — sends whatever the prompt panes hold (optimized text
  when available), renders turns with a per-call meta line (model · exact
  in/out tokens · real cost · savings attributed to the optimizer ·
  governance chip) and supports follow-up turns on one thread.

### 13.2 The governance contract for chat (fail-closed)

Every turn is screened by `governQuery` twice: the new message AND the
accumulated user-thread (history cannot smuggle what a fresh turn could
not). `block`/`redact-required` → HTTP 403, zero provider traffic, audit
line server-side; `allow`/`review` → send, verdict echoed in meta and in
the UI chip. Rate limit: 20 chat requests/min/account. Failed provider
calls (bad key, 429 upstream) record nothing — the dashboard only counts
money actually spent or saved.

### 13.3 Keys (bring your own)

`PUT /api/keys` stores `{provider, apiKey}` per account, AES-256-GCM
encrypted at rest under a master key from `PP_MASTER_KEY` (hex) or an
auto-generated `<dbdir>/master.key`. Endpoints only ever return masked
forms (`sk-abcd…wxyz`); the plaintext key is decrypted for the single
outbound call and is never logged or echoed. The browser holds no copy.

### 13.4 AUTO routing (deterministic, local)

`routeModel` scores the eligible catalog (context must fit transcript +
projected reply + 10% headroom; only providers with a saved key are
candidates) on cost 0.5 · capability 0.35 · context 0.15. Capability is an
honest, labeled proxy: log-scaled price-per-output-token (the only signal
present in every provider's public data). The chosen model and the full
score line ship in `meta.routeReason` — the pick is always explainable,
and no remote LLM sits in the routing path.

### 13.5 What the dashboard gains

Chat events carry `source='chat'`, exact provider `outputTokens`, and
`actualCostUsd` (input+output at catalog prices, frozen at write time).
New rollup fields `totals.chatRequests` / `totals.actualCostUsd` surface
as the **Live LLM spend** KPI; the Ask panel's per-call savings line uses
the original-vs-optimized input tokens the web app reports with the call,
so a cost-center view now answers both "what did we spend" and "what did
PromptPolice save us on those spends".
