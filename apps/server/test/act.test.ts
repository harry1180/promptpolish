import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { openDb } from '../src/db.ts';
import { createApp } from '../src/index.ts';
import { ActStack, actConfigFromEnv, appendEvent, listEvents, openActStore, verifyChain } from '../src/act/store.ts';
import { TENANT } from '@promptslim/act';
import type { Server } from 'node:http';

/**
 * Agent Control Tower over real HTTP.
 *
 * Proves the acceptance criteria that matter for a regulated deployment:
 * demo/production trust boundary, fail-closed evaluation, tenant isolation,
 * replay/idempotency, approval binding, kill outside the runtime, evidence
 * hash chain, and that Demo Reset cannot touch Production.
 */

let server: Server;
let base = '';
const stack = new ActStack(
  {
    demoEnabled: true,
    prodEnabled: true,
    prodEntitled: true,
    prodTenant: 'prod-tenant-001',
    demoDbPath: ':memory:',
    prodDbPath: ':memory:',
    reason: 'production mode enabled by server configuration and entitlement',
  },
  TENANT,
);
const demoStore = openActStore(':memory:', 'demo', TENANT);
const prodStore = openActStore(':memory:', 'production', 'prod-tenant-001');
stack.inject(demoStore, prodStore);

async function call(path: string, method = 'GET', body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

before(async () => {
  const db = openDb(':memory:');
  server = createApp(db, { dbPath: ':memory:', actStack: stack });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (typeof addr !== 'object' || !addr) throw new Error('no addr');
  base = `http://127.0.0.1:${addr.port}`;
});

after(() => server.close());

test('context exposes mode from server configuration only', async () => {
  const { status, json } = await call('/api/act/context');
  assert.equal(status, 200);
  assert.equal(json.mode, 'demo');
  assert.match(json.banner, /DEMO ENVIRONMENT/);
  assert.match(json.banner, /Synthetic data — no real transactions/);
  assert.equal(json.demo.enabled, true);
  assert.equal(json.production.entitled, true);
});

test('production endpoints are gated by server config and entitlement', async () => {
  const strict = new ActStack(
    {
      demoEnabled: true, prodEnabled: false, prodEntitled: false, prodTenant: 'x',
      demoDbPath: ':memory:', prodDbPath: ':memory:',
      reason: 'production mode is not enabled for this deployment (server configuration)',
    },
    TENANT,
  );
  strict.inject(openActStore(':memory:', 'demo', TENANT), null);

  const db = openDb(':memory:');
  const s2 = createApp(db, { dbPath: ':memory:', actStack: strict });
  await new Promise<void>((r) => s2.listen(0, '127.0.0.1', r));
  const addr = s2.address();
  const b2 = `http://127.0.0.1:${(addr as { port: number }).port}`;

  const res = await fetch(`${b2}/api/act/prod/status`);
  const body = (await res.json()) as { errors: string[] };
  assert.equal(res.status, 403);
  assert.match(body.errors[0], /not enabled for this deployment/);
  // the production store was never opened by that code path
  assert.equal(strict.prodStore(), null);
  s2.close();

  // environment defaults: demo and production resolve to DIFFERENT files
  const cfg = actConfigFromEnv({ PP_DB: 'data/promptpolice.db' } as NodeJS.ProcessEnv);
  assert.notEqual(cfg.demoDbPath, cfg.prodDbPath);
  assert.equal(cfg.prodEntitled, false);
});

test('executive overview is calculated from the seed (27 / 18 / 6 / 86)', async () => {
  const { status, json } = await call('/api/act/demo/overview');
  assert.equal(status, 200);
  assert.equal(json.totalAgents, 27);
  assert.equal(json.productionLikeAgents, 18);
  assert.equal(json.boundedAutonomy, 6);
  assert.equal(json.governanceScore.score, 86);
  assert.equal(json.governanceScore.classification, 'Managed');
  assert.match(json.governanceScore.disclaimer, /does not by itself establish regulatory compliance/);
  assert.equal(json.evidenceCoveragePct, 99.4);
  assert.equal(json.criticalIncidents, 0);
  assert.equal(json.ranges.find((r: { key: string }) => r.key === 'autonomy').actual, '71%');
});

test('gateway evaluation is deterministic, fail-closed and evidence-backed', async () => {
  const req = {
    tenant: TENANT,
    agentId: 'agt_treasury_07',
    action: 'transfer:execute',
    amountUsd: 4_800_000,
    beneficiary: { id: 'ben_new', approved: false },
  };
  const a = await call('/api/act/demo/evaluate', 'POST', req);
  const b = await call('/api/act/demo/evaluate', 'POST', req);
  assert.equal(a.status, 200);
  assert.equal(a.json.decision.decision, 'BLOCK');
  assert.deepEqual(a.json.decision.reasonCodes, b.json.decision.reasonCodes);
  assert.ok(a.json.evidenceRef.startsWith('ev://'));

  // unknown identity → rejected, never allowed
  const bad = await call('/api/act/demo/evaluate', 'POST', { tenant: TENANT, agentId: 'agt_nope', action: 'x' });
  assert.equal(bad.status, 400);
  assert.match(bad.json.errors[0], /identity cannot be verified/);
});

test('cross-tenant requests are rejected (tenant isolation)', async () => {
  const r = await call('/api/act/demo/evaluate', 'POST', {
    tenant: 'other-tenant',
    agentId: 'agt_treasury_07',
    action: 'transfer:execute',
    amountUsd: 1000,
  });
  assert.equal(r.status, 403);
  assert.match(r.json.errors[0], /tenant violation/);
});

test('replay protection: the same idempotency key is consumed once', async () => {
  const body = {
    tenant: TENANT,
    agentId: 'agt_treasury_07',
    action: 'transfer:execute',
    amountUsd: 50_000,
    idempotencyKey: 'idem-test-1',
  };
  const first = await call('/api/act/demo/evaluate', 'POST', body);
  assert.equal(first.json.decision.decision, 'ALLOW');
  const second = await call('/api/act/demo/evaluate', 'POST', body);
  assert.equal(second.json.decision.decision, 'BLOCK');
  assert.ok(second.json.decision.reasonCodes.includes('REPLAY_DETECTED'));
});

test('a killed agent can never execute again (kill is external and verified)', async () => {
  const kill = await call('/api/act/demo/kill/agt_treasury_07', 'POST', {});
  assert.equal(kill.status, 200);
  assert.ok(kill.json.elapsedMs >= 1);
  assert.equal(kill.json.steps.length, 6);
  assert.match(kill.json.incident, /agent.kill.activated/);

  const after = await call('/api/act/demo/evaluate', 'POST', {
    tenant: TENANT,
    agentId: 'agt_treasury_07',
    action: 'transfer:execute',
    amountUsd: 10_000,
  });
  assert.equal(after.json.decision.decision, 'BLOCK');
  assert.ok(after.json.decision.reasonCodes.includes('AGENT_KILLED'));

  const ov = await call('/api/act/demo/overview');
  assert.equal(ov.json.lastKillElapsedMs, kill.json.elapsedMs);
});

test('scenario run appends evidence and keeps the hash chain valid', async () => {
  const r = await call('/api/act/demo/scenarios/s4-transfer-48m', 'POST', {});
  assert.equal(r.status, 200);
  assert.equal(r.json.decision, 'BLOCK');
  assert.equal(r.json.exposureBlockedUsd, 4_800_000);
  assert.ok(r.json.chain.valid);

  const ev = await call('/api/act/demo/evidence');
  assert.equal(ev.json.chainValid, true);
  assert.ok(ev.json.records.length > 0);

  const replay = await call('/api/act/demo/evidence/dec_s4_48m');
  assert.equal(replay.status, 200);
  assert.ok(replay.json.replay.length >= 8);
  assert.match(replay.json.note, /never re-executed/);
});

test('approval flow binds to the exact transaction', async () => {
  await call('/api/act/demo/scenarios/s3-transfer-340k', 'POST', {});
  const list = await call('/api/act/demo/approvals');
  const pending = list.json.find((a: { status: string }) => a.status === 'pending');
  assert.ok(pending, 'scenario 3 should create a pending approval');
  assert.equal(pending.amountUsd, 340_000);
  assert.ok(pending.bindingHash);

  const granted = await call(`/api/act/demo/approvals/${pending.id}/grant`, 'POST', {});
  assert.equal(granted.status, 200);
  const after = granted.json.approvals.find((a: { id: string }) => a.id === pending.id);
  assert.equal(after.status, 'approved');

  const again = await call(`/api/act/demo/approvals/${pending.id}/grant`, 'POST', {});
  assert.equal(again.status, 409, 'an approval cannot be granted twice');
});

test('FSB mapping reports 9 strongly evidenced / 3 partially, never a compliance claim', async () => {
  const { json } = await call('/api/act/demo/frameworks');
  const fsb = json.frameworks.find((f: { key: string }) => f.key === 'fsb');
  assert.equal(fsb.controls.length, 12);
  assert.equal(json.summaries.fsb.strongly, 9);
  assert.equal(json.summaries.fsb.partial, 3);
  assert.equal(json.summaries.fsb.notAssessed, 0);
  assert.match(json.disclaimer, /never asserts regulatory compliance/);
});

test('what-if simulation returns a deterministic decision with explanation', async () => {
  const body = { agentId: 'agt_treasury_07', action: 'transfer:execute', amountUsd: 340_000 };
  const a = await call('/api/act/demo/whatif', 'POST', body);
  const b = await call('/api/act/demo/whatif', 'POST', body);
  assert.equal(a.json.decision.decision, 'REQUIRE_APPROVAL');
  assert.deepEqual(a.json.decision.reasonCodes, b.json.decision.reasonCodes);
  assert.ok(a.json.explanation.length >= 3);
});

test('demo reset restores the seed and CANNOT touch production', async () => {
  // seed a production-side event through the production store directly
  appendEvent(prodStore, 'decision', { note: 'production decision before demo reset' });
  const prodBefore = listEvents(prodStore).length;
  assert.ok(prodBefore > 0);

  await call('/api/act/demo/scenarios/s6-drift', 'POST', {});
  const demoBefore = listEvents(demoStore).length;
  assert.ok(demoBefore > 0);

  const r = await call('/api/act/demo/reset', 'POST', {});
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.match(r.json.note, /never touches Production/);
  assert.ok(r.json.reset.includes('evidence'));

  // demo ledger cleared → back to baseline
  assert.equal(listEvents(demoStore).length, 0);
  const ov = await call('/api/act/demo/overview');
  assert.equal(ov.json.governanceScore.score, 86);
  assert.equal(ov.json.privilegeDriftFindings, 2);

  // production untouched, still exactly as it was
  assert.equal(listEvents(prodStore).length, prodBefore);
  assert.equal(verifyChain(prodStore).valid, true);
  assert.equal(verifyChain(demoStore).valid, true);
});

test('maker-checker: the proposer can never approve their own policy change', async () => {
  const list = await call('/api/act/demo/policies');
  const draft = list.json.find((p: { state: string }) => p.state === 'Draft');
  assert.ok(draft, 'seed should contain a draft policy');

  const self = await call(`/api/act/demo/policies/${draft.id}/approve`, 'POST', { actor: draft.proposer });
  assert.equal(self.status, 403, 'self-approval must be refused by the server');
  assert.match(self.json.errors[0], /cannot approve it/);

  const other = await call(`/api/act/demo/policies/${draft.id}/approve`, 'POST', { actor: 'r.okafor' });
  assert.equal(other.status, 200);
  assert.equal(other.json.policies.find((p: { id: string }) => p.id === draft.id).state, 'Approved');

  // publish before approval is refused
  const list2 = await call('/api/act/demo/policies');
  const active = list2.json.find((p: { state: string }) => p.state === 'Active');
  const early = await call(`/api/act/demo/policies/${active.id}/publish`, 'POST', { actor: 'a.mensah' });
  assert.equal(early.status, 409, 'Active policy cannot be re-published (maker-checker ordering)');

  const lifecycle = await call('/api/act/demo/policies/lifecycle');
  assert.deepEqual(lifecycle.json.policy.slice(0, 4), ['Draft', 'Submit', 'Review', 'Approve']);
  assert.ok(lifecycle.json.rules[0].includes('never approve their own change'));
});

test('technology suitability is exposed for use-case assessment', async () => {
  const r = await call('/api/act/demo/use-cases/suitability');
  assert.equal(r.status, 200);
  const auth = r.json.find((x: { use: string }) => x.use === 'Transaction authorization');
  assert.equal(auth.best, 'rules engine', 'authorization must stay deterministic');
});

test('demo connectors are disabled by default and carry no production credentials', async () => {
  const r = await call('/api/act/demo/integrations');
  assert.equal(r.status, 200);
  assert.ok(r.json.length > 0);
  for (const i of r.json) {
    assert.equal(i.enabled, false, `${i.system} must default to DISABLED`);
    assert.equal(i.approved, false);
    assert.match(i.credentialRef, /^demo:\/\/synthetic\//);
  }
});

test('model registry and administration expose roles, residency and break-glass', async () => {
  const m = await call('/api/act/demo/models');
  assert.equal(m.status, 200);
  assert.ok(m.json.length > 5);
  assert.ok(m.json.every((r: { provider: string; allowedUseCases: string[] }) => r.provider && r.allowedUseCases.length > 0));

  const a = await call('/api/act/demo/admin');
  assert.equal(a.json.roles.length, 11, 'role model from the spec');
  assert.ok(a.json.breakGlass.requirements.includes('stated reason'));
  assert.equal(a.json.breakGlass.silent, false);
  assert.ok(a.json.residency.processingRegion);
  assert.ok(a.json.segregation.some((s: string) => s.includes('cannot rewrite historical evidence')));
});

test('unknown demo endpoints 404 and production evaluate stays gated', async () => {
  const r = await call('/api/act/demo/nope');
  assert.equal(r.status, 404);
  const st = await call('/api/act/prod/status');
  assert.equal(st.status, 200);
  assert.equal(st.json.environment, 'production');
  assert.equal(st.json.registeredAgents, 0, 'production registry starts empty until connectors register agents');

  // production evaluation refuses any agent that is not in the PRODUCTION registry
  // (the synthetic demo seed is never used on this path)
  const p = await call('/api/act/prod/evaluate', 'POST', { agentId: 'agt_treasury_07', action: 'transfer:execute' });
  assert.equal(p.status, 400);
  assert.match(p.json.errors[0], /identity cannot be verified/);
});