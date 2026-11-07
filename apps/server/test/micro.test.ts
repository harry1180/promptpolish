/**
 * Microstructure Alpha Engine — tests driven by REAL captured Kraken Spot
 * WebSocket v2 frames (fixtures/kraken-v2-capture.json, captured live
 * 2026-11-07 from wss://ws.kraken.com/v2) plus synthetic time-controlled
 * sequences for window math, staleness, dedup and overload behaviour.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MicroEngine } from '../src/crypto/micro/features.ts';
import { cryptoConfigFromEnv } from '../src/crypto/config.ts';

const cap = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'kraken-v2-capture.json'), 'utf8')) as {
  ticker: Array<{ data: Array<Record<string, unknown>> }>;
  trade: Array<{ data: Array<Record<string, unknown>> }>;
};

function engine(over: Partial<ConstructorParameters<typeof MicroEngine>[0]> = {}): MicroEngine {
  return new MicroEngine({
    flags: { enabled: true, l2Features: false, metaLabeling: false, costAwareValidation: false, shadowMode: true, liveExecution: false },
    feePct: 0.0016,
    autoDrain: true,
    ...over,
  });
}

test('flags default safe: engine off, shadow on, live execution off', () => {
  const cfg = cryptoConfigFromEnv({});
  assert.equal(cfg.micro.enabled, false);
  assert.equal(cfg.micro.l2Features, false);
  assert.equal(cfg.micro.metaLabeling, false);
  assert.equal(cfg.micro.costAwareValidation, false);
  assert.equal(cfg.micro.shadowMode, true);
  assert.equal(cfg.micro.liveExecution, false);
  const on = cryptoConfigFromEnv({ SCALPING_ALPHA_ENABLED: '1' });
  assert.equal(on.micro.enabled, true);
  assert.equal(on.micro.liveExecution, false, 'live execution never turns on implicitly');
  assert.equal(on.micro.recordMs > 0, true, 'recording starts when the engine is on');
});

test('real ticker frame yields L1 with sizes, spread, imbalance and microprice', () => {
  const e = engine();
  const frame = cap.ticker[cap.ticker.length - 1];
  const recvTs = Date.parse(String(frame.data[0].timestamp)) + 20;
  e.enqueueRaw(JSON.stringify(frame), recvTs);
  const f = e.features('BTC');
  assert.ok(f, 'features exist after the first real frame');
  assert.equal(f.quality, 'WARMING_UP');
  assert.ok((f.bidQty ?? 0) > 0, 'bid_qty is carried through (verified live)');
  assert.ok((f.askQty ?? 0) > 0);
  assert.ok(f.spreadBps >= 0 && f.spreadBps < 50, `spread bps sane: ${f.spreadBps}`);
  assert.ok(f.tobImbalance !== null && Math.abs(f.tobImbalance) <= 1);
  assert.ok(f.microprice !== null && f.microprice >= f.bid && f.microprice <= f.ask,
    'microprice is a convex combination of bid and ask');
  assert.equal(f.retBps.s60, null, 'returns stay null until the window has history');
  assert.equal(e.counters.parseErrors, 0);
  assert.equal(e.counters.errors, 0);
});

test('real trade frame feeds signed flow and deduplicates by trade_id', () => {
  const e = engine();
  const tick = cap.ticker[cap.ticker.length - 1];
  const frame = cap.trade[cap.trade.length - 1];
  const recvTick = Date.parse(String(tick.data[0].timestamp)) + 20;
  const recvTs = Date.parse(String(frame.data[0].timestamp)) + 20;
  e.enqueueRaw(JSON.stringify(tick), recvTick); // L1 arrives first, as live
  e.enqueueRaw(JSON.stringify(frame), recvTs);
  e.enqueueRaw(JSON.stringify(frame), recvTs + 1); // same trade_id replayed
  const f = e.features('BTC');
  assert.ok(f, 'features exist after ticker + trade frames');
  assert.ok(f.trades60, 'trade flow present when the trade channel is on');
  assert.equal(f.trades60.count, 1, 'replayed trade_id counted once');
  assert.equal(e.counters.duplicates, 1);
  const side = String(frame.data[0].side);
  assert.equal(side === 'buy', f.trades60.cvd > 0, 'CVD sign follows the taker side');
});

test('returns over 1/5/15/30/60s from time-controlled mids', () => {
  const e = engine();
  const t0 = Date.now() - 70_000;
  // linear climb: +10bps per 10s so windows are checkable
  for (let i = 0; i <= 7; i++) {
    const mid = 100 * (1 + 0.001 * i);
    e.onQuote({ symbol: 'ETH', price: mid, bid: mid - 0.01, ask: mid + 0.01, ts: t0 + i * 10_000 }, t0 + i * 10_000);
  }
  const at = t0 + 70_000;
  const f = e.features('ETH', at);
  assert.ok(f);
  assert.equal(f.quality, 'OK', 'a full 60s of history is no longer warming up');
  assert.ok(f.retBps.s5 !== null && f.retBps.s60 !== null);
  assert.ok((f.retBps.s60 as number) > (f.retBps.s5 as number), 'longer window captured more of the climb');
  assert.ok((f.rv60Bps as number) > 0, 'realized vol is positive on a moving series');
});

test('stale observations are rejected and counted', () => {
  const e = engine({ staleMs: 1_000 });
  const now = Date.now();
  const old = { symbol: 'BTC/USD', bid: 1, ask: 2, bid_qty: 1, ask_qty: 1, timestamp: new Date(now - 60_000).toISOString() };
  e.enqueueRaw(JSON.stringify({ channel: 'ticker', data: [old] }), now);
  assert.equal(e.features('BTC'), null, 'stale frame never becomes state');
  assert.equal(e.counters.droppedStale, 1);
});

test('bounded queue drops oldest on overload with an explicit counter', () => {
  const e = engine({ queueCap: 3, autoDrain: false });
  for (let i = 0; i < 5; i++) e.enqueueRaw('not-json-' + i, Date.now());
  const status = e.status() as { queue: { pending: number; droppedOverload: number } };
  assert.equal(status.queue.pending, 3);
  assert.equal(status.queue.droppedOverload, 2, 'drop-OLDEST is recorded, never silent');
  e.drain();
  assert.equal(e.counters.parseErrors, 3, 'the 3 surviving frames were parsed (and failed) individually');
  assert.equal(e.counters.errors, 0, 'bad frames are counted, never thrown');
});

test('status reports disabled L2 and the round-trip cost context', () => {
  const e = engine();
  const s = e.status() as Record<string, unknown>;
  const l2 = s.l2 as { enabled: boolean; reason: string };
  assert.equal(l2.enabled, false);
  assert.match(l2.reason, /book channel not subscribed/);
  assert.equal(s.executionMode, 'PAPER_ONLY');
  assert.equal(s.roundTripCostBps, 32, '0.16% per side x 2 = 32bps round trip');
  assert.match(String(s.decisionImpact), /NONE/);
});
