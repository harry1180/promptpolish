# Agent Control Tower — HTTP API contract

Base: same origin, under the org API base. In production builds `VITE_API_BASE=/pp`,
so the browser calls **`/pp/api/act/...`**; Traefik strips `/pp`, and `apps/server`
sees **`/api/act/...`**. In dev (`pnpm dev`) `VITE_API_BASE` is empty → `/api/act/...`.

All responses are JSON, `cache-control: no-store`. Errors: `{ "errors": ["..."] }`
with 4xx/5xx. Every demo response is derived from the seed + the demo event ledger.

## Mode / trust boundary

Two independent server-side modes, resolved ONLY from server configuration
(`ACT_DEMO_ENABLED`, `ACT_PROD_ENABLED`, `ACT_PROD_ENTITLED`) — never from a
request body or query flag. Demo and production use **separate SQLite files**.

### `GET /api/act/context`
```json
{
  "mode": "demo",
  "tenant": "demo-synthetic-001",
  "seedVersion": "act-demo-seed-1.0.0",
  "banner": "DEMO ENVIRONMENT — Synthetic data — no real transactions",
  "demo": { "enabled": true },
  "production": { "enabled": false, "entitled": false,
                  "reason": "production mode is not enabled for this deployment (server configuration)" },
  "generatedAt": 1760000000000
}
```

### `GET /api/act/prod/*`
Always exists. Returns `403` with `{ "errors": ["...reason..."] }` unless production
is enabled AND entitled. When entitled, reads/writes ONLY the production database.

## Demo endpoints (`/api/act/demo/...`)

| Method | Path | Returns |
|---|---|---|
| GET | `/overview` | `Overview` (§12 metrics, governance score, expected ranges) |
| GET | `/agents` | `RegistryRow[]` (§15 columns + governanceScore, blastRadiusClass, needsAttention, attentionReason) |
| GET | `/agents/:agentId` | `{ passport, blastRadius, incidents, decisions }` |
| GET | `/decisions` | `DecisionRow[]` (seeded + runtime, newest first) |
| GET | `/approvals` | `ApprovalRow[]` |
| POST | `/approvals/:id/grant` | `{ ok, approvals }` |
| POST | `/approvals/:id/reject` | `{ ok, approvals }` |
| GET | `/policies` | `PolicyRow[]` (§43 lifecycle; state is event-derived) |
| GET | `/policies/lifecycle` | `{ policy: string[], learning: string[], rules: string[], suitabilityCriteria: string[] }` (§43/§52/§54) |
| POST | `/policies/:id/approve` | body `{actor}` → `{ok, policies}`; **403 if actor is the proposer** (maker-checker) |
| POST | `/policies/:id/publish` | body `{actor}` → `{ok, policies}`; 409 unless state = Approved |
| GET | `/modality` | `{ items: ContentItem[], reports: FullModalityReport[] }` |
| POST | `/modality/evaluate` | `{ item, report: FullModalityReport }` body = ContentItem fields |
| GET | `/appetite` | `AppetiteItem[]` |
| GET | `/use-cases` | `UseCase[]` |
| GET | `/use-cases/suitability` | `Array<{use, best, why, runnersUp}>` (§52: LLM / rules / ML / hybrid / human) |
| GET | `/performance` | `{ agent: Record<string,number>, governance: Record<string,number>, note }` |
| GET | `/blast-radius` | bare array `[{ agentId, name, radius: BlastRadius, breaches: BlastBreach[], remainingTodayUsd }]` |
| GET | `/incidents` | `IncidentRow[]` |
| GET | `/evidence` | `{ records: EvidenceRecord[], chainValid: boolean, coveragePct: number, sampleHashes }` |
| GET | `/evidence/:decisionId` | `{ record, decision, replay: [{t, detail}], note }` (observational replay) |
| GET | `/frameworks` | `{ frameworks: Framework[], summaries: Record<key, {...summary}> }` |
| POST | `/whatif` | `{ context: EvaluationContext, decision: GovernanceDecision, explanation: string[] }` |
| GET | `/integrations` | `Integration[]` (every row `enabled:false` until approved) |
| GET | `/models` | model/provider registry (§73): provider, model, version, hosting, region, allowed use cases, data restrictions, risk tier, contract owner, deprecation |
| GET | `/readiness` | `{ gates: ReadinessGate[], note, readinessPct }` |
| GET | `/admin` | `{ roles: [{role, permissions}], segregation: string[], breakGlass, residency, dataClassification, recentAudit }` (§65–§72, §106–§107) |
| GET | `/scenarios` | `ScenarioMeta[]` |
| POST | `/scenarios/:id/run` | `ScenarioResult` (appends events to the demo ledger) |
| POST | `/kill/:agentId` | `{ ok, agentId, elapsedMs, steps: [{label, at, ok}], incident, evidenceRef }` |
| POST | `/reset` | `{ ok, reset: string[], note: "Demo reset never touches Production" }` |
| POST | `/evaluate` | gateway: body = EvaluationContext → `{ decision: GovernanceDecision, evidenceRef }` |

Types come from `@promptslim/act` (`Overview`, `RegistryRow`, `DecisionRow`,
`ApprovalRow`, `IncidentRow`, `ScenarioResult`, `Framework`, `Integration`,
`ReadinessGate`, `PolicyRow`, `AppetiteItem`, `UseCase`, `BlastRadius`,
`GovernanceDecision`, `FullModalityReport`, `EvidenceRecord`).

## Security rules the server enforces

1. Demo handlers may only touch the demo database handle; prod handlers only the prod handle.
2. Every row carries `tenant_id`; reads filter by it (cross-tenant → 404/403).
3. Mutations append to an append-only, hash-chained evidence ledger.
4. `POST /reset` deletes demo events only; production DB is never opened by that path.