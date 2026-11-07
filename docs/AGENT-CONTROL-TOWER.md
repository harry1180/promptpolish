# Agent Control Tower — architecture, trust boundaries and operations

Module of the PromptPolice / AgenticAlchemy platform at
`https://governance.agenticalchemy.io/agent-control-tower`.
HTTP contract: **`docs/ACT-API.md`**. Demo/conference guide: **`docs/ACT-DEMO-GUIDE.md`**.

---

## 1. What existed, and what changed

Discovered before implementation (Phase 1):

| Concern | Existing implementation | Reused? |
|---|---|---|
| Frontend | React 19 + Vite 7 + Tailwind v4, single page `apps/web/src/App.tsx`, no router | yes — the new module is a sibling entry mounted by path |
| Backend | `apps/server` — zero-dependency `node:http` + `node:sqlite`, TypeScript run directly by Node | yes — new routes under `/api/act/*` |
| Routing (edge) | Traefik v3 (host network) → nginx SPA + `/pp/api/*` → server with `/pp` stripped | yes — one router rule extended |
| Database | SQLite (`apps/server/data/promptpolice.db`, volume `pp-data`) | yes — untouched; ACT uses **its own files** `act-demo.db` / `act-prod.db` |
| AuthN | scrypt passwords, opaque 256-bit session cookie (HttpOnly, SameSite=Lax) | yes — unchanged |
| AuthZ | role-less org accounts today (documented Phase-4 seam) | unchanged; ACT ships its own role model for its own surface |
| Tenancy | org accounts + tag snapshotting | ACT adds `tenant` scoping on every row of its own store |
| Logging/monitoring | usage events only | ACT adds an evidence ledger + SIEM event catalog |
| Deployment | `docker compose up -d`, no raw ports | same; `docker-compose.yml` gained one Traefik rule + 3 env vars |

Changes are additive: no existing route, table, capability or data was renamed,
migrated or removed. Rollback = remove the Traefik rule + the `/api/act` branch.

New code:

```
packages/act/                 deterministic governance engine (DOM-free, network-free)
  src/policy.ts               runtime gateway rules (§41/§42)
  src/score.ts                governance score (11 weighted components)
  src/blast.ts                blast radius compute + ENFORCEMENT
  src/modality.ts             modality governance gateway (§19–§40)
  src/delegation.ts           agent-to-agent authority rules (§18)
  src/seed.ts                 synthetic demo estate (27 agents, appetite, readiness)
  src/state.ts                view derivation: seed + events → dashboard payloads
  src/scenarios.ts            10 storyline scenes + 14 workshop labs
  src/frameworks.ts           FSB 12 / MAS SAFR / NIST-ISO-OWASP, SIEM, threat model
  test/                       47 vitest cases
apps/server/src/act/store.ts  two databases, hash-chained evidence, kill state, idempotency
apps/server/src/act/routes.ts HTTP surface + trust boundary enforcement
apps/server/test/act.test.ts  12 HTTP integration tests
apps/web/src/act/             UI module (route /agent-control-tower)
docs/ACT-API.md               API contract
```

Environment variables: `ACT_DEMO_ENABLED` (default on), `ACT_PROD_ENABLED`
(default off), `ACT_PROD_ENTITLED` (default off), `ACT_DB_DIR` (defaults to the
directory of `PP_DB`), `ACT_PROD_TENANT` (default `prod-tenant-001`).

---

## 2. Trust boundaries

```
   Demo boundary                          Production boundary
┌───────────────────────────┐      ┌────────────────────────────────┐
│ /api/act/demo/*           │      │ /api/act/prod/*                │
│ demo handler code path    │      │ production handler code path   │
│        │                  │      │        │                       │
│        ▼                  │      │        ▼                       │
│ act-demo.db  (demo tenant)│      │ act-prod.db (production tenant)│
│ synthetic seed            │      │ empty until connectors register│
│ synthetic credentials     │      │ enterprise IAM / workload ID   │
└───────────────────────────┘      └────────────────────────────────┘
   separate file · separate handle · separate tenant id
   selected by SERVER CONFIG, never by a request field
```

Rules enforced in code and proven by tests:

1. The demo handler only ever receives the demo `ActStore`. The production
   handler only receives the production store, and only when
   `ACT_PROD_ENABLED=1` **and** `ACT_PROD_ENTITLED=1`.
2. A body field `environment: "demo"` changes nothing — the store that the
   route reaches is the boundary.
3. `POST /api/act/demo/reset` deletes rows from the demo file only; the test
   asserts production rows are byte-identical afterwards.
4. Production evaluation uses the **production registry** (empty until a
   connector registers an agent) — the synthetic demo agents are never visible
   on the production path.
5. Credentials are never shared: demo uses synthetic identifiers
   (`demo://synthetic/<connector>`), production would use
   `vault://prod/<connector>`.

---

## 3. Identity, authority and delegation

Every evaluation carries verifiable identity fields: agent id, workload id,
tenant, environment, agent version, authority-profile version, credential
issue/expiry. Server-side lookups (never client-supplied) decide: passport
capabilities, prohibited capabilities, limits, containment status.

- **Approved vs effective permissions** are compared continuously; a gap is a
  `drift.detected` event, an incident, and a HOLD on consequential actions.
- **Delegation** (`authorizeDelegation`) can only narrow: the receiver must
  already hold the capability, the delegator must hold it too, TTL ≤ 24 h,
  chain depth ≤ 3, loop detection. `P-DEL-001` blocks any attempt to expand
  authority through delegation.

## 4. Deterministic policy engine

`evaluate(context) → GovernanceDecision` — pure, no model in the loop.
27 policies (`POLICIES`) with id/version/priority; **all** matched policies are
reported, the decision is the most severe match:

`ALLOW < HOLD < REQUIRE_APPROVAL < QUARANTINE < BLOCK`

Fail-closed gates run first (identity, credential, tenant, replay/idempotency,
drift, evidence infrastructure, emergency deny, production config, containment
state). Degraded read-only behaviour is configurable (`degradedPolicy`), and
defaults to **deny**.

## 5. Evidence

Append-only `act_events` with a sha256 hash chain
(`prev_hash | ts | tenant | type | payload`). `verifyChain()` re-computes the
whole chain; any edit breaks it. No hidden chain-of-thought is stored — only
decision summary, policy ids/versions, reason codes, provenance and results.
Replay is observational: timelines are rebuilt, side effects never re-run.

## 6. Kill / containment

`POST /api/act/demo/kill/:agentId` runs outside any agent runtime: suspend →
revoke credentials → stop queue → **verify** a fresh evaluation returns BLOCK →
open incident → seal evidence, measuring real wall-clock elapsed time
(`elapsedMs`). The test asserts that after a kill, a new transfer evaluates to
`BLOCK / AGENT_KILLED`.

## 7. Governance Score (formula 1.0.0)

`score = round(Σ achieved_i)`, 11 components, weights summing to 100:
Identity 10 · Authorization 15 · Runtime enforcement 15 · Human oversight 10 ·
Blast radius 10 · Evidence 10 · Credentials 5 · Kill 10 · Monitoring 5 ·
Change governance 5 · Multimodal 5. Seeded demo estate = **86 — Managed**.
Drift/orphan/incident findings reduce the specific component, so the score moves
when the estate moves. Every score carries methodology version, formula version,
timestamp, component inputs, exceptions and the disclaimer that it is a
risk-management indicator, not regulatory compliance.

## 8. Blast radius

Computed per agent across financial / customer / data / system / velocity /
privilege / reversibility / chain / reputation / jurisdiction, classified
LOW→CRITICAL with a written explanation. Enforced at the gateway:
per-transaction ceiling, daily aggregate, velocity — a breach becomes
REQUIRE_APPROVAL or BLOCK, never an advisory number.

## 9. Modality governance

One logical layer for TEXT, DOCUMENT, IMAGE, AUDIO, VOICE, VIDEO, LIVE VIDEO,
MULTIMODAL, CODE, STRUCTURED DATA, EXTERNAL WEB CONTENT, TOOL OUTPUT and
AGENT MESSAGE. Twelve checkpoints per item (source, provenance, trust,
integrity, sensitivity, injection, synthetic, identity, consent, minimization,
policy, action separation). Injection controls scan OCR output, transcripts,
subtitles, hidden layers and tool responses — not just plain text.
Provenance is a trust signal: absence is never called "fake", presence is
never treated as authorization.

## 10. Threat model (summary)

21 threats modelled (compromised model/runtime, malicious user/admin,
multimodal injection, voice impersonation, video deepfake, document/RAG
poisoning, tool compromise, delegation abuse, credential theft, approval
fraud, evidence tampering, cross-tenant attack, replay/duplicate transaction,
supply chain, DoS) with asset → attack path → prevention → detection →
containment → evidence → **residual risk**. Full table: `threatModel()`,
rendered in Framework Mapping.

## 11. Security controls

TLS at the edge (Traefik/Let's Encrypt), HttpOnly SameSite cookies, scrypt
credentials, body-size limits, per-IP rate budget on mutating ACT endpoints,
tenant-scoped queries, server-side authority resolution, input validation on
every ACT field, dependency pinning via lockfile, no secrets in logs.

## 12. HA / DR (current status)

- Single-node SQLite with WAL today → **NOT READY** for multi-node HA.
- Recommended production topology: N stateless gateway replicas + a replicated
  policy/evidence store, health checks, graceful shutdown, circuit breaking.
- Backups: volume snapshots (`pp-data`). RTO/RPO targets: 4 h / 15 min —
  **restore is not yet exercised in this deployment** → listed as NOT TESTED in
  the readiness checklist until the customer runs it.

## 13. Production readiness

`GET /api/act/demo/readiness` returns the checklist (PASS / FAIL / NOT TESTED /
CUSTOMER ACTION REQUIRED). Current honest state: pen test **NOT TESTED**,
independent validation **CUSTOMER ACTION REQUIRED**. The platform never labels
a tenant "Regulator Approved".

**Production enablement process**

1. `ACT_PROD_ENABLED=1`, `ACT_PROD_ENTITLED=1`, `ACT_PROD_TENANT=<tenant>`.
2. Point production connectors at real systems (each defaults DISABLED and
   must be approved).
3. Register real agents (import passports; no demo object is ever promoted).
4. Import policies as drafts → test → maker-checker review → publish.
5. Complete the readiness gates, run the kill test and the restore test.
6. Start in observe-only mode, then enable consequential enforcement per
   risk tier.

## 14. Known limitations / what is NOT ready

- Multi-node HA and automated restore drills: NOT READY here.
- No real SIEM/connector is wired in this deployment; the SIEM catalog is
  emitted as structured JSON but not shipped anywhere yet.
- C2PA validation is modelled as a pluggable layer; a real validator is a
  customer-supplied integration.
- Paralinguistic and deepfake scores are deterministic seeded signals in demo
  mode; production requires vendor detectors and must treat them as signals,
  never identity proof.
- Framework mappings are control mappings; external validation is a customer
  and independent-process responsibility.
- No automatic compliance claims are made anywhere in code or UI.

## 15. Customer responsibilities

Enterprise IAM federation, MFA, KMS/secret manager, connector approval, SIEM
ingestion, WORM/retention policy for evidence export, legal determinations per
jurisdiction, independent penetration test, independent validation of framework
mappings, restore/DR drills.