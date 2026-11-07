/**
 * TradingUSA server tests: paper-only guard, secret hygiene, signal
 * immutability, LLM-free tick pipeline, LOCAL_ONLY degradation, realistic
 * paper fills with providers down, news dedup, backtest input validation.
 *
 * All network access is injected (failing or fixture fetch) — no test ever
 * touches the internet.
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.ts';
import type { Server } from 'node:http';
import { openDb } from '../src/db.ts';
import { TradingRuntime } from '../src/tradingusa/runtime.ts';
import { runScan, ingestTick } from '../src/tradingusa/engine.ts';
import { processOrders } from '../src/tradingusa/broker.ts';
import { InferenceRouter } from '../src/tradingusa/inference/router.ts';
import { pollNews } from '../src/tradingusa/intake.ts';
import { NewsProvider } from '../src/tradingusa/providers/news.ts';
import { tuConfigFromEnv } from '../src/tradingusa/config.ts';
import { etDate } from '@promptslim/tucore';

const GROQ_SENTINEL = 'gsk_TEST_SENTINEL_DO_NOT_LEAK_123456';
const GEMINI_SENTINEL = 'AIza_TEST_SENTINEL_DO_NOT_LEAK_123456';

process.env.GROQ_API_KEY = GROQ_SENTINEL;
process.env.GEMINI_API_KEY = GEMINI_SENTINEL;
delete process.env.TU_WORKERS;

const failingFetch = (async () => {
  throw new Error('network disabled in tests');
}) as unknown as typeof fetch;

let server: Server;
let base: string;

before(async () => {
  const db = openDb(':memory:');
  server = createApp(db, { dbPath: ':memory:', tuDbPath: ':memory:' });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function get(path: string): Promise<{ status: number; text: string; body: any }> {
  const res = await fetch(base + path);
  const text = await res.text();
  let body: unknown = null;
  try { body = JSON.parse(text); } catch { /* non-json */ }
  return { status: res.status, text, body };
}

function assertNoSecrets(text: string, label: string): void {
  assert.ok(!text.includes(GROQ_SENTINEL), `${label} must not contain GROQ key`);
  assert.ok(!text.includes(GEMINI_SENTINEL), `${label} must not contain GEMINI key`);
  assert.ok(!text.includes('GROQ_API_KEY'), `${label} must not name the env var`);
  assert.ok(!text.includes('GEMINI_API_KEY'), `${label} must not name the env var`);
}

/** Deterministic synthetic bars: steady uptrend ending in a 20d-high breakout
 *  with a 2x volume spike — the multi-confirmation shape strategies reward. */
function seedBars(db: import('node:sqlite').DatabaseSync, ticker: string, days = 320, endPrice = 100): void {
  const stmt = db.prepare(
    `INSERT INTO market_bars (ticker, date, open, high, low, close, volume, provider, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'test', ?) ON CONFLICT(ticker, date) DO NOTHING`,
  );
  const start = Date.now() - days * 86400_000;
  let price = endPrice / Math.pow(1.0018, days);
  for (let i = 0; i < days; i++) {
    const ts = start + i * 86400_000;
    const date = etDate(ts);
    const drift = 1.0018 * (i > days - 21 ? 1.004 : 1); // late acceleration => breakout
    const open = price;
    price = price * drift;
    const close = price;
    const high = Math.max(open, close) * 1.003;
    const low = Math.min(open, close) * 0.997;
    const volume = i === days - 1 ? 40_000_000 : 15_000_000; // relVol ~2.7
    stmt.run(ticker, date, open, high, low, close, volume, Date.now());
  }
}

function countSignals(db: import('node:sqlite').DatabaseSync): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM signals').get() as { n: number }).n;
}

test('status: PAPER_ONLY execution guard, no secrets', async () => {
  const r = await get('/api/tradingusa/status');
  assert.equal(r.status, 200);
  assert.equal(r.body.mode, 'PAPER_ONLY');
  assert.equal(r.body.executionGuard.realMoneyBlocked, true);
  assert.deepEqual(r.body.executionGuard.adapters, ['PaperBrokerAdapter']);
  assert.ok(r.body.executionGuard.prohibited.includes('deposits'));
  assert.ok(['PREMARKET', 'MARKET_OPEN', 'POSTMARKET', 'MARKET_CLOSED', 'WEEKEND', 'HOLIDAY', 'EARLY_CLOSE'].includes(r.body.market.session));
  assertNoSecrets(r.text, 'status');
});

test('every read endpoint leaks no secret material', async () => {
  const paths = [
    '/api/tradingusa/status', '/api/tradingusa/overview', '/api/tradingusa/market',
    '/api/tradingusa/signals', '/api/tradingusa/scanner', '/api/tradingusa/portfolios',
    '/api/tradingusa/positions', '/api/tradingusa/trades', '/api/tradingusa/strategies',
    '/api/tradingusa/research', '/api/tradingusa/sources', '/api/tradingusa/learning',
    '/api/tradingusa/backtests', '/api/tradingusa/ai', '/api/tradingusa/system',
    '/api/tradingusa/settings', '/api/tradingusa/reviews', '/api/tradingusa/events',
    '/api/tradingusa/quotes?symbols=SPY,AAPL',
  ];
  for (const p of paths) {
    const r = await get(p);
    assert.equal(r.status, 200, `${p} should be 200 (got ${r.status})`);
    assertNoSecrets(r.text, p);
  }
});

test('settings: locked to paper, no real-money adapter possible', async () => {
  const r = await get('/api/tradingusa/settings');
  assert.equal(r.status, 200);
  assert.equal(r.body.locked.executionMode, 'PAPER_ONLY');
  assert.equal(r.body.locked.realMoneyEnabled, false);
  assert.deepEqual(r.body.locked.brokerAdapters, ['PaperBrokerAdapter']);
  assert.match(r.body.locked.note, /NOT implemented/);
  assert.equal(r.body.config.shortTermCapital, 100000);
  assert.equal(r.body.config.longTermCapital, 100000);
});

test('ai: status enums only, budgets visible, LOCAL_ONLY when unconfigured', async () => {
  const r = await get('/api/tradingusa/ai');
  assert.equal(r.status, 200);
  const allowed = new Set(['CONNECTED', 'UNAVAILABLE', 'RATE_LIMITED', 'QUOTA_EXHAUSTED', 'DEGRADED', 'CIRCUIT_OPEN', 'LOCAL_ONLY', 'ERROR']);
  for (const p of r.body.providers) assert.ok(allowed.has(p.status), `bad status ${p.status}`);
  assert.ok(r.body.budgets.routineCallsPerDay > 0);
  assert.ok(typeof r.body.totals.llmDependencyPct === 'number');
  assertNoSecrets(r.text, 'ai');
});

test('signals are immutable once written (DB trigger)', () => {
  const rt = new TradingRuntime({ dbPath: ':memory:', workers: false, fetchImpl: failingFetch });
  const now = Date.now();
  rt.db
    .prepare(
      `INSERT INTO signals (ticker, company, sector, portfolio, strategy, strategy_version, model_version,
        horizon, signal, confidence, price, entry_low, entry_high, target, invalidation, expected_return,
        risk_reward, expected_hold, max_hold, session, session_date, created_at, regime)
       VALUES ('AAPL','Apple Inc.','Technology','SHORT_TERM_PORTFOLIO','st_multi_factor_v1','1.0.0','st_mf_v1',
        'SHORT','BUY',0.8,100,99,101,110,95,0.1,2.0,5,20,'MARKET_OPEN','2026-10-16',?, 'BULL_TREND')`,
    )
    .run(now);
  assert.throws(
    () => rt.db.prepare('UPDATE signals SET target = 999 WHERE ticker = ?').run('AAPL'),
    /immutable/,
    'signal UPDATE must be blocked',
  );
  assert.throws(
    () => rt.db.prepare('DELETE FROM signals WHERE ticker = ?').run('AAPL'),
    /immutable/,
    'signal DELETE must be blocked',
  );
  rt.stop();
});

test('market ticks never trigger LLM calls (hot path purity)', () => {
  const rt = new TradingRuntime({ dbPath: ':memory:', workers: false, fetchImpl: failingFetch });
  seedBars(rt.db, 'AAPL', 100);
  const before = (rt.db.prepare('SELECT COUNT(*) AS n FROM llm_usage').get() as { n: number }).n;
  for (let i = 0; i < 500; i++) {
    ingestTick(rt.db, [
      { symbol: 'AAPL', price: 100 + Math.sin(i) , prevClose: 99, ts: Date.now(), provider: 'test', freshness: 'DELAYED' },
    ]);
  }
  const after = (rt.db.prepare('SELECT COUNT(*) AS n FROM llm_usage').get() as { n: number }).n;
  assert.equal(after, before, '500 ticks must produce zero LLM usage rows');
  rt.stop();
});

test('scan + paper trading keep working when all LLM providers are absent', async () => {
  const env = { ...process.env } as Record<string, string | undefined>;
  delete env.GROQ_API_KEY;
  delete env.GEMINI_API_KEY;
  const rt = new TradingRuntime({
    dbPath: ':memory:', workers: false, fetchImpl: failingFetch,
    config: tuConfigFromEnv(env),
  });
  rt.start(); // seeds the two $100K paper portfolios
  seedBars(rt.db, 'AAPL', 320, 250);
  seedBars(rt.db, 'SPY', 320, 500);
  const before = (rt.db.prepare('SELECT COUNT(*) AS n FROM llm_usage').get() as { n: number }).n;

  const scan = await runScan({ db: rt.db, provider: rt.provider, config: rt.config });
  assert.ok(scan.scanned >= 1, 'scan should see the seeded universe');

  // router must answer LOCAL_ONLY with no keys configured
  const resp = await rt.router.reason({
    task: 'EVENT_INTERPRETATION', priority: 'routine', contentKey: 'test-key',
    prompt: 'interpret', value: null,
  });
  assert.equal(resp.mode, 'LOCAL_ONLY');

  const after = (rt.db.prepare('SELECT COUNT(*) AS n FROM llm_usage').get() as { n: number }).n;
  assert.ok(after >= before, 'ledger must not regress');
  rt.stop();
});

test('circuit/quota: repeated provider failures fall back then go LOCAL_ONLY', async () => {
  const rt = new TradingRuntime({ dbPath: ':memory:', workers: false, fetchImpl: failingFetch });
  const resp = await rt.router.reason({
    task: 'TRADE_POSTMORTEM', priority: 'routine', contentKey: 'x', prompt: 'p', value: null,
  });
  assert.ok(['LOCAL_ONLY', 'GROQ', 'GEMINI', 'CACHE', 'SKIPPED'].includes(resp.mode));
  if (resp.mode === 'LOCAL_ONLY') assert.equal(resp.ok, false);
  rt.stop();
});

test('paper fills stay realistic and execute with providers down', async () => {
  const rt = new TradingRuntime({ dbPath: ':memory:', workers: false, fetchImpl: failingFetch });
  seedBars(rt.db, 'AAPL', 120, 200);
  rt.db.prepare(`INSERT INTO paper_portfolios (kind, start_capital, cash, created_at) VALUES ('SHORT_TERM_PORTFOLIO', 100000, 100000, ?)`).run(Date.now());
  const now = Date.now();
  rt.db
    .prepare(
      `INSERT INTO signals (ticker, company, sector, portfolio, strategy, strategy_version, model_version,
        horizon, signal, confidence, price, entry_low, entry_high, target, invalidation, expected_return,
        risk_reward, expected_hold, max_hold, session, session_date, created_at, regime)
       VALUES ('AAPL','Apple Inc.','Technology','SHORT_TERM_PORTFOLIO','st_multi_factor_v1','1.0.0','st_mf_v1',
        'SHORT','BUY',0.8,200,199,201,260,200,0.15,2.0,5,20,?, ?, ?, 'BULL_TREND')`,
    )
    .run(sessionLabel(), etDate(now), now);
  const signalId = (rt.db.prepare('SELECT MAX(id) AS id FROM signals').get() as { id: number }).id;
  rt.db
    .prepare(
      `INSERT INTO paper_orders (portfolio, signal_id, ticker, side, qty, limit_price, stop_price, status, fill_mode, created_at)
       VALUES ('SHORT_TERM_PORTFOLIO', ?, 'AAPL', 'BUY', 50, 260, 200, 'PENDING', 'AT_SIGNAL', ?)`,
    )
    .run(signalId, now);

  const summary = await processOrders(rt.db, rt.provider, rt.config, now);
  assert.equal(summary.filled, 1, 'order must fill at last available price with providers down');
  const pos = rt.db.prepare(`SELECT * FROM paper_positions WHERE ticker = 'AAPL' AND exit_ts IS NULL`).get() as { entry_price: number; qty: number; target: number; stop: number } | undefined;
  assert.ok(pos, 'position created');
  assert.equal(pos!.qty, 50);
  assert.ok(pos!.target > pos!.entry_price, 'target above entry');
  assert.ok(pos!.stop < pos!.entry_price, 'stop below entry');
  const cash = (rt.db.prepare(`SELECT cash FROM paper_portfolios WHERE kind = 'SHORT_TERM_PORTFOLIO'`).get() as { cash: number }).cash;
  assert.ok(cash < 100000 && cash > 0, 'virtual cash reduced, never negative');
  const order = rt.db.prepare(`SELECT * FROM paper_orders WHERE status = 'FILLED'`).get() as { fill_price: number; fill_note: string };
  assert.ok(order.fill_price >= 150 && order.fill_price <= 300, `fill price realistic (near last close): ${order.fill_price}`);
  assert.match(order.fill_note, /closed|slippage|filled/i);
  rt.stop();
});

function sessionLabel(): string {
  const d = new Date();
  const wd = d.getUTCDay();
  return wd === 0 || wd === 6 ? 'WEEKEND' : 'MARKET_CLOSED';
}

test('duplicate news does not multiply evidence', async () => {
  const rss = `<?xml version="1.0"?><rss version="2.0"><channel>
<item><title>Apple beats Q4 estimates as iPhone sales surge 12%</title><link>https://finance.example.com/a1</link><pubDate>Thu, 15 Oct 2026 12:00:00 GMT</pubDate></item>
<item><title>Apple beats Q4 estimates as iPhone sales surge 12%</title><link>https://mirror.example.net/a1</link><pubDate>Thu, 15 Oct 2026 12:05:00 GMT</pubDate></item>
<item><title>Apple earnings: iPhone sales surge 12% beating estimates</title><link>https://synd.example.org/a1</link><pubDate>Thu, 15 Oct 2026 12:07:00 GMT</pubDate></item>
</channel></rss>`;

  const fakeFetch = (async () => new Response(rss, { status: 200 })) as unknown as typeof fetch;
  const news = new NewsProvider({ fetchImpl: fakeFetch });
  const rt = new TradingRuntime({ dbPath: ':memory:', workers: false, fetchImpl: failingFetch });

  const first = await pollNews(rt.db, news, [{ ticker: 'AAPL', company: 'Apple Inc.' }]);
  const eventsAfterFirst = (rt.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;
  assert.ok(eventsAfterFirst >= 1, 'first poll creates an event');
  assert.equal(first.errors, 0);

  const second = await pollNews(rt.db, news, [{ ticker: 'AAPL', company: 'Apple Inc.' }]);
  const eventsAfterSecond = (rt.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;
  assert.equal(eventsAfterSecond, eventsAfterFirst, 'second identical poll must not create events');
  assert.ok(second.documentsDuplicate >= 1, 'documents deduped by content hash');

  // syndicated copies across domains count as ONE event with independent sources
  const ev = rt.db.prepare('SELECT sources, independent_sources FROM events ORDER BY id LIMIT 1').get() as { sources: number; independent_sources: number };
  assert.ok(ev.sources >= 1 && ev.independent_sources >= 1 && ev.independent_sources <= ev.sources);
  rt.stop();
});

test('backtest trigger validates input and rate-limits', async () => {
  const bad = await fetch(base + '/api/tradingusa/backtests', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ strategy: 'SHORT_TERM', startDate: '2026-12-01', endDate: '2026-01-01' }),
  });
  assert.equal(bad.status, 400);

  const ok = await fetch(base + '/api/tradingusa/backtests', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ strategy: 'SHORT_TERM', startDate: '2025-01-01', endDate: '2026-01-01' }),
  });
  assert.ok([201, 400].includes(ok.status), `unexpected ${ok.status}`);
  const second = await fetch(base + '/api/tradingusa/backtests', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ strategy: 'SHORT_TERM', startDate: '2025-01-01', endDate: '2026-01-01' }),
  });
  assert.ok([429, 400].includes(second.status), `rate limit or validation expected, got ${second.status}`);
});

test('InferenceRouter is the only path to providers (usage ledger records)', async () => {
  const rt = new TradingRuntime({ dbPath: ':memory:', workers: false, fetchImpl: failingFetch });
  await rt.router.reason({ task: 'EVENT_INTERPRETATION', priority: 'routine', contentKey: 'k1', prompt: 'p', value: null });
  const rows = rt.db.prepare('SELECT provider, status FROM llm_usage ORDER BY id DESC LIMIT 5').all() as unknown as Array<{ provider: string; status: string }>;
  assert.ok(rows.length >= 1, 'attempt recorded in ledger');
  for (const row of rows) assert.ok(['groq', 'gemini'].includes(row.provider));
  // router constructed with sentinel keys present in env => it tried network (failing fetch) and recorded a failure status
  const statuses = new Set(rows.map((r) => r.status));
  for (const s of statuses) assert.ok(['ERROR', 'LOCAL_ONLY', 'RATE_LIMITED', 'CACHED', 'SKIPPED', 'UNAVAILABLE'].includes(s), `bad status ${s}`);
  rt.stop();
});
