/**
 * HTTP surface for /api/crypto — mounted in createApp, served at the edge as
 * /pp/api/crypto/*. Uses a shared crypto DB file so the test can seed the
 * universe directly and then read it back over HTTP, and proves the equities
 * routes still answer after the mount (regression guard).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { openDb } from '../src/db.ts';
import { createApp } from '../src/index.ts';
import { openCryptoDb } from '../src/crypto/schema.ts';

const dir = mkdtempSync(join(tmpdir(), 'crypto-http-'));
const cryptoDbPath = join(dir, 'crypto.db');

let server: ReturnType<typeof createApp>;
let base: string;

test.before(async () => {
  server = createApp(openDb(':memory:'), {
    dbPath: ':memory:',
    tuDbPath: ':memory:',
    cryptoDbPath,
    cryptoWorkers: false, // hermetic: no network in tests
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;

  // seed the universe from the outside (same file the runtime opened)
  const db = openCryptoDb(cryptoDbPath);
  const now = Date.now();
  for (const [symbol, pinned, rank] of [['BTC', 1, 1], ['ETH', 1, 2], ['SOL', 0, 7]] as Array<[string, number, number]>) {
    db.prepare('INSERT INTO crypto_universe (symbol, pinned, active, added_at, updated_at, last_rank) VALUES (?,?,?,?,?,?)')
      .run(symbol, pinned, 1, now, now, rank);
  }
  db.close();
});

test.after(() => {
  server?.close();
  rmSync(dir, { recursive: true, force: true });
});

test('GET /api/crypto/status reports the paper-only 24/7 runtime', async () => {
  const res = await fetch(`${base}/api/crypto/status`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    ok: boolean; executionMode: string; portfolioKind: string; alwaysOpen: boolean;
    provider: { name: string; status: string }; stream: { live: boolean; symbols: number };
    universe: { members: number; active: number; pinned: string[]; ranked: string[] };
    counts: Record<string, number>; jobs: unknown[];
  };
  assert.equal(body.ok, true);
  assert.equal(body.executionMode, 'PAPER_ONLY', 'the API never offers live trading');
  assert.equal(body.portfolioKind, 'CRYPTO_SPOT');
  assert.equal(body.alwaysOpen, true, 'crypto has no sessions');
  assert.equal(body.provider.name, 'kraken');
  assert.equal(body.universe.members, 3, 'seeded members are visible over HTTP');
  assert.deepEqual(body.universe.pinned.sort(), ['BTC', 'ETH']);
  assert.deepEqual(body.universe.ranked, ['SOL']);
  assert.equal(body.stream.live, false, 'workers are off in tests');
  assert.equal(body.counts.openPositions, 0);
  assert.ok(Array.isArray(body.jobs));
});

test('GET /api/crypto/overview opens a $100k paper book with BTC benchmark', async () => {
  const res = await fetch(`${base}/api/crypto/overview`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    portfolio: { kind: string; startCapital: number; cash: number; equity: number; returnPct: number } | null;
    benchmark: { symbol: string; equity: number };
    stats: { closed: number; winRatePct: number; feesPaid: number };
    positions: unknown[]; recentTrades: unknown[];
  };
  assert.ok(body.portfolio, 'the spot book exists');
  assert.equal(body.portfolio?.kind, 'CRYPTO_SPOT');
  assert.equal(body.portfolio?.startCapital, 100000);
  assert.equal(body.portfolio?.cash, 100000, 'untouched paper cash');
  assert.equal(body.benchmark.symbol, 'BTC', 'the benchmark is BTC, not SPY');
  assert.equal(body.stats.closed, 0);
  assert.deepEqual(body.positions, []);
  assert.deepEqual(body.recentTrades, []);
});

test('GET /api/crypto/learning exposes defaults + the empty learned state', async () => {
  const res = await fetch(`${base}/api/crypto/learning`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    strategy: string; horizon: string;
    fusionWeights: { defaults: Record<string, number>; learned: unknown; sufficient: boolean; trades: number };
    outcomesRecorded: number; note: string;
  };
  assert.equal(body.strategy, 'crypto_momentum_v1');
  assert.equal(body.horizon, 'SHORT');
  assert.ok(Object.keys(body.fusionWeights.defaults).length >= 4, 'shipped defaults are published');
  assert.equal(body.fusionWeights.sufficient, false, 'no fitted weights yet');
  assert.equal(body.fusionWeights.learned, null);
  assert.equal(body.outcomesRecorded, 0);
  assert.match(body.note, /crypto weights only/);
});

test('GET /api/crypto/experiments answers the shadow-mode summary with dates', async () => {
  const res = await fetch(`${base}/api/crypto/experiments?from=2026-10-01&to=2026-11-03`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { note: string; conditions: unknown[]; closedTrades: number };
  assert.match(body.note, /Shadow mode/);
  assert.ok(Array.isArray(body.conditions));
  assert.equal(body.closedTrades, 0);

  const bad = await fetch(`${base}/api/crypto/experiments?from=2026-11-03&to=2026-10-01`);
  assert.equal(bad.status, 400, 'from > to is rejected, not silently swapped');
});

test('unknown crypto paths 404 and the equities routes still answer', async () => {
  const missing = await fetch(`${base}/api/crypto/nope`);
  assert.equal(missing.status, 404);

  const tu = await fetch(`${base}/api/tradingusa/status`);
  assert.equal(tu.status, 200, 'the tradingusa mount still works after adding crypto');
  assert.match(tu.headers.get('content-type') ?? '', /json/);
  const tuBody = (await tu.json()) as Record<string, unknown>;
  assert.equal(typeof tuBody, 'object');
  assert.ok(tuBody !== null && Object.keys(tuBody).length > 0, 'it answers with a real body');
});