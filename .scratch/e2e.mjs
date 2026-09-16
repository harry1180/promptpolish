/* Live E2E driver against http://127.0.0.1:8787 (scratch DB). */
const B = 'http://127.0.0.1:8787';
const PASS = 'sup3r-s3cret-pw';
let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  · ' + extra : ''}`);
  if (!cond) failures++;
}
async function api(path, method = 'GET', body, cookie) {
  const res = await fetch(B + path, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch {}
  const c = res.headers.get('set-cookie');
  return { status: res.status, data, cookie: c ? c.split(';')[0] : undefined };
}

const stamp = Date.now(); // fresh emails each run so the scratch DB is re-runnable

// 1) five users on cost_center=10 (three also team=payments), one on 20
const cookies = [];
for (let i = 1; i <= 5; i++) {
  const s = await api('/api/signup', 'POST', {
    email: `live_u${stamp}_${i}@corp.com`, password: PASS, name: `Live User ${i}`,
    tags: { cost_center: '10', team: i <= 3 ? 'payments' : 'search' },
  });
  check(`signup u${i}`, s.status === 201, JSON.stringify(s.data?.errors ?? ''));
  cookies.push(s.cookie);
}
const u6 = await api('/api/signup', 'POST', {
  email: `live_u${stamp}_6@corp.com`, password: PASS, tags: { cost_center: '20' },
});
cookies.push(u6.cookie);

// 2) each user records one optimization run (u6 deliberately bigger to test isolation)
const tokens = [2000, 4000, 6000, 8000, 10000];
for (let i = 0; i < 5; i++) {
  const r = await api('/api/events', 'POST', {
    modelId: 'gpt-5.4', level: 'balanced',
    originalTokens: tokens[i], optimizedTokens: Math.round(tokens[i] * 0.6), fromCache: false,
  }, cookies[i]);
  check(`event u${i + 1} tagged`, r.status === 201 && r.data.tagsRecorded.cost_center === '10');
}
await api('/api/events', 'POST', {
  modelId: 'gpt-5.4', level: 'balanced', originalTokens: 50000, optimizedTokens: 40000, fromCache: false,
}, cookies[5]);

// 3) roll-up by single tag combination
const cc10 = await api('/api/aggregate', 'POST', { filters: [{ key: 'cost_center', value: '10' }] }, cookies[0]);
const t = cc10.data.totals;
check('cc10 users = 5', t.users === 5);
check('cc10 requests = 5', t.requests === 5);
check('cc10 orig tokens = 30000', t.originalTokens === 30000, `got ${t.originalTokens}`);
check('cc10 saved = 12000 tokens', t.savedTokens === 12000);
check('cc10 has USD savings', t.savingsUsd > 0, `$${t.savingsUsd.toFixed(4)} · projected $${cc10.data.projectedAnnualUsd.toFixed(2)}/yr`);

// 4) combined tag filter ANDs
const comb = await api('/api/aggregate', 'POST', {
  filters: [{ key: 'cost_center', value: '10' }, { key: 'team', value: 'payments' }],
}, cookies[0]);
check('cc10 AND payments → 3 users / 12000 tokens',
  comb.data.totals.users === 3 && comb.data.totals.originalTokens === 12000,
  `users=${comb.data.totals.users} orig=${comb.data.totals.originalTokens}`);

// 5) group-by breakdown reconciles
const grouped = await api('/api/aggregate', 'POST', { groupBy: ['cost_center'] }, cookies[0]);
const b10 = grouped.data.buckets.find((b) => b.label === '10');
const b20 = grouped.data.buckets.find((b) => b.label === '20');
check('buckets 10 & 20 present, requests sum to 6',
  !!b10 && !!b20 && b10.requests === 5 && b20.requests === 1);

// 6) per-user view
const byUser = await api('/api/aggregate', 'POST', {
  filters: [{ key: 'cost_center', value: '10' }], groupBy: ['__user'],
}, cookies[0]);
check('group-by user → 5 buckets', byUser.data.buckets.length === 5);

// 7) facets for pickers
const facets = await api('/api/tags/facets', 'GET', undefined, cookies[0]);
const cc = facets.data.facets.find((f) => f.key === 'cost_center');
check('facets include cost_center 10', cc && cc.values.some((v) => v.value === '10'));

// 8) authz: anonymous aggregate refused; wrong password refused
check('anonymous aggregate 401', (await api('/api/aggregate', 'POST', {})).status === 401);
check('wrong password 401', (await api('/api/login', 'POST', { email: `live_u${stamp}_1@corp.com`, password: 'nope-nope-nope' })).status === 401);
const li = await api('/api/login', 'POST', { email: `live_u${stamp}_1@corp.com`, password: PASS });
check('login round-trip 200', li.status === 200 && li.data.account.tags.cost_center === '10');
check('me with session 200', (await api('/api/me', 'GET', undefined, li.cookie)).status === 200);
check('logout then me 401',
  (await api('/api/logout', 'POST', undefined, li.cookie), (await api('/api/me', 'GET', undefined, li.cookie)).status) === 401);

// 9) prompt text never leaves the client — server ignores any text field
const leak = await api('/api/events', 'POST', {
  modelId: 'gpt-5.4', level: 'balanced', originalTokens: 10, optimizedTokens: 5, promptText: 'SECRET',
}, cookies[0]);
const rows = await api('/api/aggregate', 'POST', { filters: [{ key: 'cost_center', value: '10' }] }, cookies[0]);
check('event accepted but text field ignored (no leak in response/buckets)', leak.status === 201 && !JSON.stringify(rows.data).includes('SECRET'));

console.log(failures === 0 ? '\nALL LIVE E2E CHECKS PASSED' : `\n${failures} CHECKS FAILED`);
process.exit(failures === 0 ? 0 : 1);
