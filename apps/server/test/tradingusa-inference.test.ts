/**
 * Spec-required invariants that need a live router + learning pipeline:
 *   - LLM response cache (same content => one provider call, then CACHE)
 *   - Groq failure falls back to Gemini
 *   - a losing trade creates a learning record WITHOUT touching Champion
 *     strategy config (one mistake can never modify production logic)
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { InferenceRouter, configFromEnv } from '../src/tradingusa/inference/router.ts';
import { openTradingDb } from '../src/tradingusa/schema.ts';
import { analyzeClosedTrade, consolidate } from '../src/tradingusa/learning.ts';
import type { DatabaseSync } from 'node:sqlite';

function routerWith(fetchImpl: typeof fetch): { router: InferenceRouter; db: DatabaseSync } {
  const db = openTradingDb(':memory:');
  const config = configFromEnv({ GROQ_API_KEY: 'gsk_test', GEMINI_API_KEY: 'AIza_TEST' });
  return { router: new InferenceRouter({ db, config, fetchImpl }), db };
}

const groqOk = (async () =>
  new Response(JSON.stringify({
    choices: [{ message: { content: '{"action":"HOLD","confidence":0.6,"reasoning":"cached answer"}' } }],
    usage: { prompt_tokens: 100, completion_tokens: 50 },
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

test('LLM response cache: second identical request never re-pays tokens', async () => {
  const calls = { n: 0 };
  const countingFetch = (async (input: RequestInfo | URL) => {
    calls.n += 1;
    return groqOk(input as never);
  }) as unknown as typeof fetch;
  const { router: r, db } = routerWith(countingFetch);

  const req = {
    task: 'EVENT_INTERPRETATION' as const, priority: 'routine' as const,
    contentKey: 'event:42:Apple beats estimates', prompt: 'interpret this', value: null,
  };
  const first = await r.reason(req);
  const second = await r.reason(req);

  assert.equal(first.mode, 'GROQ', `first call should hit groq (got ${first.mode})`);
  assert.equal(second.mode, 'CACHE', 'second call must be served from cache');
  assert.equal(second.inputTokens, 0, 'cached response costs zero input tokens');
  assert.equal(calls.n, 1, 'provider must be called exactly once');

  const row = db.prepare('SELECT COUNT(*) AS n FROM llm_cache').get() as { n: number };
  assert.equal(row.n, 1, 'one cache entry stored');
});

const geminiOk = () => new Response(JSON.stringify({
  candidates: [{ content: { parts: [{ text: '{"action":"HOLD","confidence":0.6,"reasoning":"gemini took over"}' }] } }],
  usageMetadata: { promptTokenCount: 80, candidatesTokenCount: 40 },
}), { status: 200, headers: { 'content-type': 'application/json' } });

test('Groq failure falls back to Gemini', async () => {
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('groq.com')) return new Response('boom', { status: 500 });
    if (url.includes('googleapis.com')) return geminiOk();
    return new Response('unexpected host', { status: 500 });
  }) as unknown as typeof fetch;
  const { router: r, db } = routerWith(fetchImpl);
  const res = await r.reason({
    task: 'EVENT_INTERPRETATION', priority: 'routine',
    contentKey: 'event:77', prompt: 'p', value: null,
  });
  assert.equal(res.mode, 'GEMINI', `expected gemini fallback (got ${res.mode}: ${res.reason ?? ''})`);
  assert.equal(res.ok, true);
  assert.ok(res.inputTokens > 0, 'tokens recorded from the successful provider');
  const ledger = db.prepare('SELECT provider, status FROM llm_usage ORDER BY id DESC LIMIT 2').all() as unknown as Array<{ provider: string; status: string }>;
  assert.equal(ledger[0].provider, 'gemini');
  assert.equal(ledger[1].provider, 'groq');
  assert.equal(ledger[1].status, 'ERROR');
});

test('one losing trade creates a learning record but NEVER touches Champion strategy config', () => {
  const db = openTradingDb(':memory:');
  const now = Date.now();
  // strategy_versions / weights baseline (as seeded by ops)
  db.prepare(
    `INSERT INTO strategy_versions (strategy, version, active, champion, horizon, config_json, created_at)
     VALUES ('st_multi_factor_v1', '1.0.0', 1, 1, 'SHORT', '{"lookback":90}', ?)`,
  ).run(now);
  db.prepare(
    `INSERT INTO strategy_weights (strategy, horizon, weights_json, updated_at)
     VALUES ('st_multi_factor_v1', 'SHORT', '{"technical":0.38}', ?)`,
  ).run(now);
  // a closed losing paper trade
  const t = db.prepare(
    `INSERT INTO paper_trades (portfolio, ticker, company, sector, side, qty, entry_price, entry_ts,
       exit_price, exit_ts, exit_reason, capital, gross_pnl, net_pnl, return_pct, benchmark_return,
       excess_return, holding_sessions, mfe, mae, predicted_return, actual_return, prediction_error,
       strategy, strategy_version, status)
     VALUES ('SHORT_TERM_PORTFOLIO','FAKE','Fake Co','Technology','LONG',10,100,? ,90,?,'STOP_REACHED',
       1000,-100,-10,-0.10,0.02,-0.12,3,-0.01,-0.10,0.07,-0.10,0.17,'st_multi_factor_v1','1.0.0','CLOSED')`,
  ).run(now - 3 * 86400_000, now);
  const tradeId = Number(t.lastInsertRowid);

  const res = analyzeClosedTrade(db, tradeId);
  assert.equal(res.recorded, true, 'losing trade must produce a mistake record');
  const mistake = db.prepare('SELECT kind FROM mistakes WHERE trade_id = ?').get(tradeId) as { kind: string };
  assert.ok(mistake.kind.length > 0);
  const cluster = db.prepare('SELECT count FROM mistake_clusters WHERE kind = ?').get(mistake.kind) as { count: number };
  assert.equal(cluster.count, 1, 'cluster statistics updated');
  const lessons = (db.prepare('SELECT COUNT(*) AS c FROM knowledge_lessons').get() as { c: number }).c;
  assert.equal(lessons, 0, 'ONE mistake must not even propose a lesson (needs a cluster of 3)');

  // consolidation must not touch strategy config either
  consolidate(db, Date.now());
  const sv = db.prepare('SELECT version, config_json FROM strategy_versions WHERE strategy = ?').get('st_multi_factor_v1') as { version: string; config_json: string };
  const sw = db.prepare('SELECT weights_json FROM strategy_weights WHERE strategy = ?').get('st_multi_factor_v1') as { weights_json: string };
  assert.equal(sv.version, '1.0.0');
  assert.equal(sv.config_json, '{"lookback":90}');
  assert.equal(sw.weights_json, '{"technical":0.38}');
});
