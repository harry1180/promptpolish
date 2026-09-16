import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { openDb } from '../src/db.ts';
import { createApp } from '../src/index.ts';
import type { Server } from 'node:http';

/**
 * Integration test through real HTTP with an in-memory DB.
 * Exercises the exact scenario from the product ask: several users signed up
 * with the same cost_center tag; their metrics roll up when the dashboard
 * filters by that tag — alone and in combination with other tags.
 */

let server: Server;
let base = '';

before(async () => {
  const db = openDb(':memory:');
  server = createApp(db);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (typeof addr !== 'object' || !addr) throw new Error('no addr');
  base = `http://127.0.0.1:${addr.port}`;
});

after(() => new Promise<void>((r) => server.close(() => r())));

function cookieOf(res: Response): string {
  const c = res.headers.get('set-cookie');
  assert.ok(c, 'expected session cookie');
  return c.split(';')[0]!;
}

async function api(path: string, method = 'GET', body?: unknown, cookie?: string): Promise<{ status: number; data: any; cookie?: string }> {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data: unknown = null;
  try { data = await res.json(); } catch { /* no body */ }
  const setc = res.headers.get('set-cookie');
  return { status: res.status, data, cookie: setc ? setc.split(';')[0]! : undefined };
}

const PASS = 'sup3r-s3cret-pw';

test('signup validates tags, email, password; duplicate email rejected', async () => {
  const bad = await api('/api/signup', 'POST', { email: 'nope', password: 'short', tags: { '1x': 'y' } });
  assert.equal(bad.status, 400);
  assert.ok(bad.data.errors.length >= 3);

  const ok = await api('/api/signup', 'POST', {
    email: ' A@Example.com ', password: PASS, name: 'Ada', tags: { cost_center: '10', team: 'payments' },
  });
  assert.equal(ok.status, 201);
  assert.equal(ok.data.account.email, 'a@example.com');
  assert.deepEqual(ok.data.account.tags, { cost_center: '10', team: 'payments' });
  assert.ok(ok.cookie?.startsWith('pp_session='));

  const dup = await api('/api/signup', 'POST', { email: 'a@example.com', password: PASS });
  assert.equal(dup.status, 400);
});

test('login rejects wrong password; accepts right one; /api/me needs session', async () => {
  const no = await api('/api/me');
  assert.equal(no.status, 401);

  const wrong = await api('/api/login', 'POST', { email: 'a@example.com', password: 'wrong-password' });
  assert.equal(wrong.status, 401);

  const right = await api('/api/login', 'POST', { email: 'a@example.com', password: PASS });
  assert.equal(right.status, 200);
  const me = await api('/api/me', 'GET', undefined, right.cookie);
  assert.equal(me.status, 200);
  assert.equal(me.data.account.email, 'a@example.com');
});

test('the 5-users-cost-center-10 scenario rolls up across accounts', async () => {
  // five users, all cost_center=10 (three of them also team=payments)
  const cookies: string[] = [];
  for (let i = 1; i <= 5; i++) {
    const tags = i <= 3 ? { cost_center: '10', team: 'payments' } : { cost_center: '10', team: 'search' };
    const s = await api('/api/signup', 'POST', { email: `u${i}@corp.com`, password: PASS, name: `U${i}`, tags });
    assert.equal(s.status, 201, JSON.stringify(s.data));
    cookies.push(s.cookie!);
  }
  // a sixth user in cost_center 20 — must NOT appear in cc10 rollups
  const other = await api('/api/signup', 'POST', { email: 'u6@corp.com', password: PASS, tags: { cost_center: '20' } });
  assert.equal(other.status, 201);

  // each cc10 user records events; tokens chosen so costs are exact-ish
  for (const [i, c] of cookies.entries()) {
    const r = await api('/api/events', 'POST', {
      modelId: 'gpt-5.4', level: 'balanced',
      originalTokens: 1000 * (i + 1), optimizedTokens: 600 * (i + 1),
      fromCache: false,
    }, c);
    assert.equal(r.status, 201, JSON.stringify(r.data));
  }
  await api('/api/events', 'POST', { modelId: 'gpt-5.4', level: 'balanced', originalTokens: 9999, optimizedTokens: 1, fromCache: false }, other.cookie);

  // unauthenticated aggregate is refused
  assert.equal((await api('/api/aggregate', 'POST', {})).status, 401);

  // filter cost_center=10 → 5 users, 5 requests, nothing from the cc20 user
  const cc10 = await api('/api/aggregate', 'POST', { filters: [{ key: 'cost_center', value: '10' }] }, cookies[0]);
  assert.equal(cc10.status, 200);
  assert.equal(cc10.data.totals.users, 5);
  assert.equal(cc10.data.totals.requests, 5);
  assert.equal(cc10.data.totals.originalTokens, 1000 * (1 + 2 + 3 + 4 + 5));
  assert.ok(cc10.data.totals.costOriginalUsd < 1); // sanity: this is not the 9999-token row
  assert.ok(cc10.data.projectedAnnualUsd > 0);

  // combined filter cost_center=10 AND team=payments → exactly the 3 payments users
  const comb = await api('/api/aggregate', 'POST', {
    filters: [{ key: 'cost_center', value: '10' }, { key: 'team', value: 'payments' }],
  }, cookies[4]);
  assert.equal(comb.status, 200);
  assert.equal(comb.data.totals.users, 3);
  assert.equal(comb.data.totals.originalTokens, 1000 * (1 + 2 + 3));

  // group by cost_center across the org → buckets sorted by savings (money leads:
  // the cc20 user saved 9998 tokens on one event, more than all cc10 users combined)
  const grouped = await api('/api/aggregate', 'POST', { groupBy: ['cost_center'] }, cookies[0]);
  assert.equal(grouped.data.buckets.length, 2); // 10 and 20 (no untagged events)
  assert.deepEqual(grouped.data.buckets.map((b: any) => b.label).sort(), ['10', '20']);
  const b10 = grouped.data.buckets.find((b: any) => b.label === '10');
  assert.equal(b10.requests, 5);
  assert.equal(b10.users, 5);
  assert.equal(grouped.data.buckets.reduce((s: number, b: any) => s + b.requests, 0), 6);
  assert.ok(
    grouped.data.buckets[0].savingsUsd >= grouped.data.buckets[1].savingsUsd,
    'buckets must sort by savings desc',
  );

  // group by user surfaces who contributes
  const byUser = await api('/api/aggregate', 'POST', {
    filters: [{ key: 'cost_center', value: '10' }], groupBy: ['__user'],
  }, cookies[0]);
  assert.equal(byUser.data.buckets.length, 5);
  assert.ok(byUser.data.buckets.every((b: any) => b.label.endsWith('@corp.com')));

  // facets feed the dashboard filter pickers
  const facets = await api('/api/tags/facets', 'GET', undefined, cookies[0]);
  const cc = facets.data.facets.find((f: any) => f.key === 'cost_center');
  assert.deepEqual(cc.values.map((v: any) => v.value).sort(), ['10', '20']);
});

test('events reject junk and bad models; tag edits only affect future events', async () => {
  const s = await api('/api/signup', 'POST', { email: 't@corp.com', password: PASS, tags: { cost_center: '77' } });
  const c = s.cookie!;
  assert.equal((await api('/api/events', 'POST', { modelId: 'nope', level: 'balanced', originalTokens: 10, optimizedTokens: 5 }, c)).status, 400);
  assert.equal((await api('/api/events', 'POST', { modelId: 'gpt-5.4', level: 'extreme', originalTokens: 10, optimizedTokens: 5 }, c)).status, 400);
  assert.equal((await api('/api/events', 'POST', { modelId: 'gpt-5.4', level: 'balanced', originalTokens: 10, optimizedTokens: 50 }, c)).status, 400);

  await api('/api/events', 'POST', { modelId: 'gpt-5.4', level: 'balanced', originalTokens: 1000, optimizedTokens: 500 }, c);
  const upd = await api('/api/me/tags', 'PUT', { tags: { cost_center: '88' } }, c);
  assert.equal(upd.status, 200);
  assert.deepEqual(upd.data.account.tags, { cost_center: '88' });

  const in77 = await api('/api/aggregate', 'POST', { filters: [{ key: 'cost_center', value: '77' }] }, c);
  assert.equal(in77.data.totals.requests, 1); // snapshot kept
  const in88 = await api('/api/aggregate', 'POST', { filters: [{ key: 'cost_center', value: '88' }] }, c);
  assert.equal(in88.data.totals.requests, 0); // no new events yet

  const badTag = await api('/api/me/tags', 'PUT', { tags: { '1bad': 'x' } }, c);
  assert.equal(badTag.status, 400);
});

test('logout clears the session', async () => {
  const l = await api('/api/login', 'POST', { email: 't@corp.com', password: PASS });
  const c = l.cookie!;
  assert.equal((await api('/api/me', 'GET', undefined, c)).status, 200);
  await api('/api/logout', 'POST', undefined, c);
  assert.equal((await api('/api/me', 'GET', undefined, c)).status, 401);
});
