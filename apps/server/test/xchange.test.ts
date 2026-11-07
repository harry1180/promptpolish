/**
 * Multi-exchange layer: HTTP surface + synchronized feature/evaluation math.
 *
 * Hermetic (cryptoWorkers: false — no sockets in tests). Samples are seeded
 * straight into the crypto DB so the point-in-time pipeline is exercised end
 * to end: store -> features -> walk-forward evaluation -> API.
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
import { insertSamples, type SampleRow } from '../src/xchange/store.ts';
import { priceAgreement, correlation, confidenceScore, venueWindow } from '../src/xchange/features.ts';

const dir = mkdtempSync(join(tmpdir(), 'xchange-http-'));
const cryptoDbPath = join(dir, 'crypto.db');

let server: ReturnType<typeof createApp>;
let base: string;

/** deterministic pseudo-random walk (no Math.random: stable assertions) */
function lcg(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

function seedSamples(now: number): number {
  const db = openCryptoDb(cryptoDbPath);
  const rand = lcg(42);
  const rows: SampleRow[] = [];
  const n = 900;
  const stepMs = 10_000;
  let kr = 75_000;
  let cb = 75_000;
  for (let i = n; i >= 1; i -= 1) {
    const ts = now - i * stepMs;
    const shock = (rand() - 0.5) * 60; // $30 either way each step
    kr += shock;
    cb += shock * 0.98 + (rand() - 0.5) * 12; // correlated with venue noise
    const spread = 1 + rand() * 2;
    rows.push({
      ts,
      provider: 'kraken',
      symbol: 'BTC',
      quote: 'USD',
      bid: kr - spread / 2,
      ask: kr + spread / 2,
      mid: kr,
      last: kr,
      spreadBps: spread,
      bidQty: 1 + rand(),
      askQty: 1 + rand(),
      tradePx: null,
      tradeQty: null,
      tradeSide: null,
      events: 20,
      valid: true,
    });
    rows.push({
      ts,
      provider: 'coinbase',
      symbol: 'BTC',
      quote: 'USD',
      bid: cb - spread / 2,
      ask: cb + spread / 2,
      mid: cb,
      last: cb,
      spreadBps: spread,
      bidQty: 1 + rand(),
      askQty: 1 + rand(),
      tradePx: rand() > 0.5 ? cb : null,
      tradeQty: rand() > 0.5 ? 0.01 : null,
      tradeSide: rand() > 0.5 ? 'buy' : 'sell',
      events: 30,
      valid: true,
    });
  }
  insertSamples(db, rows);
  db.close();
  return rows.length;
}

test.before(async () => {
  server = createApp(openDb(':memory:'), {
    dbPath: ':memory:',
    tuDbPath: ':memory:',
    cryptoDbPath,
    cryptoWorkers: false,
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

test.after(() => {
  server?.close();
  rmSync(dir, { recursive: true, force: true });
});

test('GET /api/crypto/providers lists the reference feed, Coinbase and pending venues', async () => {
  const res = await fetch(`${base}/api/crypto/providers`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    ok: boolean; executionMode: string; decisionImpact: string;
    exchanges: Array<{ id: string; state: string; healthy: boolean; symbols: string[] }>;
    context: unknown[]; pending: string[];
    reference: { id: string; state: string; symbolCount: number };
  };
  assert.equal(body.ok, true);
  assert.equal(body.executionMode, 'PAPER_ONLY', 'the layer can never enable trading');
  assert.equal(body.decisionImpact, 'NONE');
  const ids = body.exchanges.map((e) => e.id);
  assert.ok(ids.includes('coinbase'), 'Coinbase must be wired into the registry');
  assert.ok(body.pending.includes('binanceus'), 'unwired venues stay visible as pending');
  assert.ok(body.pending.includes('cryptocom'));
  const cb = body.exchanges.find((e) => e.id === 'coinbase');
  assert.ok(cb, 'coinbase row present');
  assert.equal(cb?.healthy, false, 'CONNECTED/healthy must never be claimed before data arrives');
  assert.equal(body.reference.id, 'kraken');
  assert.equal(typeof body.reference.symbolCount, 'number');
  // no secrets in the payload
  const raw = JSON.stringify(body);
  assert.ok(!raw.includes('COINGECKO_DEMO_KEY'), 'env names never leak');
  assert.ok(!raw.includes('sk_'), 'no key material in the response');
});

test('GET /api/crypto/xchange answers honestly before and after samples exist', async () => {
  const before = (await (await fetch(`${base}/api/crypto/xchange?symbol=BTC`)).json()) as {
    ok: boolean; enabled: boolean; features: unknown; note: string;
  };
  assert.equal(before.ok, true);
  assert.equal(before.enabled, true);
  assert.ok(before.features === null || typeof before.features === 'object');

  seedSamples(Date.now());

  const after = (await (await fetch(`${base}/api/crypto/xchange?symbol=BTC&window=14400000`)).json()) as {
    sampleCount: number;
    features: {
      venues: Array<{ provider: string; samples: number; lastMid: number }>;
      agreement: Array<{ quoteGroup: string; venues: number; sufficient: boolean; divergenceBps: number | null }>;
      confidence: { score: number | null; sufficient: boolean };
      leadLag: Array<{ provider: string; sufficient: boolean }>;
    };
  };
  assert.ok(after.sampleCount >= 1700, `expected ~1800 seeded samples, got ${after.sampleCount}`);
  const providers = after.features.venues.map((v) => v.provider).sort();
  assert.deepEqual(providers, ['coinbase', 'kraken'], 'both venues land on the synchronized grid');
  const usd = after.features.agreement.find((a) => a.quoteGroup === 'USD');
  assert.ok(usd, 'USD group computed');
  assert.equal(usd?.venues, 2);
  assert.equal(usd?.sufficient, true, 'two fresh venues = sufficient');
  assert.ok(usd?.divergenceBps !== null, 'cross-venue divergence is measurable');
  assert.equal(after.features.confidence.sufficient, true);
  assert.ok(after.features.leadLag.some((l) => l.provider === 'coinbase'));
});

test('GET /api/crypto/sources reports per-horizon contributions without fabricating', async () => {
  const body = (await (await fetch(`${base}/api/crypto/sources?symbol=BTC`)).json()) as {
    status: string;
    providers: Array<{ provider: string; samples: number }>;
    horizons: Array<{
      horizon: string; status: string; testRows: number;
      krakenOnly: { balancedAccuracyPct: number | null; brier: number | null };
      krakenPlusCoinbase: { balancedAccuracyPct: number | null };
      baseline: { balancedAccuracyPct: number | null };
      incremental: { balancedAccuracyDeltaPct: number | null };
      featureRedundancyR: number | null;
      note: string;
    }>;
  };
  assert.equal(body.providers.length, 2);
  assert.ok(body.providers.every((p) => p.samples > 0), 'both sources have samples');
  assert.equal(body.horizons.length, 6, '30s, 60s, 5m, 15m, 1h, 1d');
  const byLabel = Object.fromEntries(body.horizons.map((h) => [h.horizon, h]));

  const short = byLabel['30s'];
  assert.equal(short.status, 'OK', `30s horizon should have evidence: ${short.note}`);
  assert.ok(short.testRows >= 80, `test rows ${short.testRows}`);
  assert.notEqual(short.krakenOnly.balancedAccuracyPct, null);
  assert.notEqual(short.baseline.balancedAccuracyPct, null);
  assert.equal(typeof short.featureRedundancyR, 'number', 'redundancy is measured, not assumed');

  const day = byLabel['1d'];
  assert.equal(day.status, 'INSUFFICIENT_DATA', 'a 1d horizon cannot be scored within hours of seeding');
  assert.equal(day.krakenOnly.balancedAccuracyPct, null, 'INSUFFICIENT_DATA never shows a number');
  assert.equal(day.krakenPlusCoinbase.balancedAccuracyPct, null);
  assert.equal(day.incremental.balancedAccuracyDeltaPct, null);
  assert.ok(day.note.length > 0, 'the reason is stated');
  assert.equal(body.status, 'OK');
});

test('GET /api/crypto/context stays disabled by default', async () => {
  const body = (await (await fetch(`${base}/api/crypto/context`)).json()) as {
    enabled: boolean; sources: unknown[];
  };
  assert.equal(body.enabled, false, 'optional REST sources are off unless explicitly enabled');
  assert.deepEqual(body.sources, []);
});

test('feature math: agreement, window stats and confidence are derived, not hardcoded', () => {
  const now = Date.now();
  const rows: SampleRow[] = [];
  for (let i = 40; i >= 0; i -= 1) {
    const ts = now - i * 5_000;
    const up = 100 + (40 - i);
    const down = 100 - (40 - i);
    rows.push({
      ts, provider: 'kraken', symbol: 'BTC', quote: 'USD',
      bid: up, ask: up + 1, mid: up, last: up, spreadBps: 1,
      bidQty: 3, askQty: 1, tradePx: null, tradeQty: null, tradeSide: null,
      events: 5, valid: true,
    });
    rows.push({
      ts, provider: 'coinbase', symbol: 'BTC', quote: 'USD',
      bid: down, ask: down + 1, mid: down, last: down, spreadBps: 1,
      bidQty: 1, askQty: 1, tradePx: down, tradeQty: 0.5, tradeSide: 'buy',
      events: 5, valid: true,
    });
  }
  const agreement = priceAgreement(rows, 'BTC', now, 'kraken');
  const usd = agreement.find((a) => a.quoteGroup === 'USD');
  assert.ok(usd, 'USD group present');
  assert.equal(usd?.venues, 2);
  assert.equal(usd?.majority, 'UP', 'Kraken is up over the window');
  assert.equal(usd?.referenceAgrees, true);
  assert.equal(usd?.agreement, 0.5, 'one of two venues agrees');

  const krakenWin = venueWindow(rows, 'kraken', 'BTC', now);
  assert.ok(krakenWin);
  assert.ok((krakenWin?.returnPct ?? 0) > 0, 'Kraken window return is positive');
  assert.equal(krakenWin?.imbalance, 0.5, '(3-1)/(3+1)');

  const cbWin = venueWindow(rows, 'coinbase', 'BTC', now);
  assert.equal(cbWin?.takerBuyPct, 100, 'the only trade was a taker buy');

  // correlation is honest about sign and bounds
  assert.ok(correlation([1, 2, 3], [2, 4, 6]) > 0.999);
  assert.ok(correlation([1, 2, 3], [3, 2, 1]) < -0.999);
  assert.ok(Number.isNaN(correlation([1, 2], [1, 2])), 'too few samples is NaN, not 1');

  const poor = confidenceScore({
    agreement: null, freshVenues: 1, requiredVenues: 4, divergenceBps: null, medianSpreadBps: null,
  });
  assert.equal(poor.score, null, 'one fresh venue never produces a score');
  assert.equal(poor.sufficient, false);

  const good = confidenceScore({
    agreement: 1, freshVenues: 4, requiredVenues: 4, divergenceBps: 1, medianSpreadBps: 2,
  });
  assert.equal(good.sufficient, true);
  assert.ok((good.score ?? 0) > 0.8 && (good.score ?? 0) <= 1);
});

test('regression: the existing crypto endpoints still answer', async () => {
  for (const path of ['/api/crypto/status', '/api/crypto/overview', '/api/crypto/learning', '/api/crypto/accuracy']) {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.status, 200, `${path} must stay available`);
  }
});