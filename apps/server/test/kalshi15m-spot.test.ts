/**
 * BTC spot tape: returns over 1/3/5/10/30/60s, short-term volatility,
 * venue divergence, lead/lag and persistence. Fully synthetic — time and
 * prices are injected, so every number asserted here is knowable by hand.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  HORIZONS, SpotRuntime, SpotTape, coinbaseQuote, coinbaseTrade,
  corr, ensureSpotTables, insertSpotSample, parseKrakenTrades, spotConfigFromEnv,
} from '../src/kalshi15m/spot.ts';
import type { CanonicalEvent } from '../src/xchange/types.ts';

const T0 = Date.parse('2026-11-20T20:00:00Z');

function feed(tape: SpotTape, venue: 'kraken' | 'coinbase', series: number[], startMs = T0, stepMs = 1_000, skewMs = 0): void {
  series.forEach((mid, i) => {
    const ts = startMs + i * stepMs;
    tape.observe({
      venue, ts, recvTs: ts + skewMs,
      bid: mid - 0.5, ask: mid + 0.5, last: mid,
    });
  });
}

/** deterministic non-degenerate walk: 120 seconds of BTC-ish prices */
function walk(n: number, seed = 42): number[] {
  const out: number[] = [];
  let x = seed;
  let price = 100_000;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    const shock = ((x / 2147483648) - 0.5) * 60; // ±30 dollars
    price = Math.max(1_000, price + shock);
    out.push(Math.round(price * 100) / 100);
  }
  return out;
}

/* ------------------------------------------------------------------ */

test('config: engine off by default, knobs honoured', () => {
  const off = spotConfigFromEnv({});
  assert.equal(off.enabled, false, 'never records unless asked');
  assert.equal(off.sampleMs, 1_000);
  assert.equal(off.retentionDays, 14);
  const on = spotConfigFromEnv({ CRYPTO_SPOT_TAPE: '1', CRYPTO_SPOT_SAMPLE_MS: '250' });
  assert.equal(on.enabled, true);
  assert.equal(on.sampleMs, 250);
});

test('returns: log return over each horizon, computed at the injected now', () => {
  const tape = new SpotTape();
  const base = 100_000;
  // one tick per second for 70s: price rises exactly 1% per 10 seconds
  const series: number[] = [];
  for (let i = 0; i < 71; i++) series.push(base * (1 + 0.001 * i));
  feed(tape, 'kraken', series, T0, 1_000);
  const now = T0 + 70_000;
  const snap = tape.snapshot(now);
  const kr = snap.kraken;
  assert.ok(kr, 'kraken state exists');
  assert.equal(kr.stalenessMs, 0, 'recvTs == now -> zero staleness');

  // price at now = base*(1+0.07); 1s back = base*(1+0.069) -> ratio known
  const p0 = base * 1.07;
  const p1 = base * 1.069;
  const r1 = Math.log(p0 / p1);
  assert.ok(kr.returns[1] !== null);
  assert.ok(Math.abs((kr.returns[1] as number) - r1) < 1e-9, `r1 ${kr.returns[1]} vs ${r1}`);

  const p60 = base * 1.01;
  const r60 = Math.log(p0 / p60);
  assert.ok(kr.returns[60] !== null);
  assert.ok(Math.abs((kr.returns[60] as number) - r60) < 1e-9, `r60 ${kr.returns[60]} vs ${r60}`);
  for (const h of HORIZONS) assert.ok(h in kr.returns, `horizon ${h} reported`);
  // monotone in horizon for a rising tape: longer window -> bigger return
  assert.ok((kr.returns[30] as number) > (kr.returns[5] as number));
});

test('returns refuse to lie: short ring and feed gaps produce null, not 0', () => {
  const tape = new SpotTape();
  feed(tape, 'kraken', [100_000, 100_010], T0, 1_000);
  const snap = tape.snapshot(T0 + 1_000);
  assert.ok(snap.kraken?.returns[1] !== null, 'a 1s return IS computable from 1s of history');
  assert.equal(snap.kraken?.returns[60], null, '60s history simply does not exist yet');

  // full history, then a 30s feed blackout before `now`
  const tape2 = new SpotTape();
  feed(tape2, 'kraken', walk(70), T0, 1_000);
  const snap2 = tape2.snapshot(T0 + 70_000 + 30_000); // 30s of silence
  // the feed went silent 30s ago: the CURRENT point is stale, so no return
  // at any horizon is reported (a 30s-old price cannot describe "the last
  // 60 seconds"), and the staleness itself is on the record
  assert.equal(snap2.kraken?.returns[1], null, 'stale tape reports no 1s return');
  assert.ok((snap2.kraken?.stalenessMs ?? 0) >= 30_000, 'staleness reports the blackout');
  // 60s return: base 90s old -> also refused
  assert.equal(snap2.kraken?.returns[60], null);
});

test('divergence and agreement between venues', () => {
  const tape = new SpotTape();
  const now = T0 + 10_000;
  feed(tape, 'kraken', Array(11).fill(100_000), T0, 1_000);
  feed(tape, 'coinbase', Array(11).fill(100_100), T0, 1_000);
  const snap = tape.snapshot(now);
  assert.ok(snap.divergenceBps !== null);
  // 100 dollars apart on a 100k book -> 10 bps
  assert.ok(Math.abs(snap.divergenceBps - 10) < 0.01, `divergence ${snap.divergenceBps}`);
  // flat tape on both sides: 1s returns are 0 -> "same direction"
  assert.equal(snap.agree1s, true);

  // opposite moves -> no agreement
  const tape2 = new SpotTape();
  feed(tape2, 'kraken', [100_000, 100_100, 100_000, 99_900, 99_800], T0, 1_000);
  feed(tape2, 'coinbase', [100_000, 99_900, 100_000, 100_100, 100_200], T0, 1_000);
  const s2 = tape2.snapshot(T0 + 4_000);
  assert.equal(s2.agree1s, false, 'venues moving apart cannot "agree"');
});

test('lead/lag: a venue that moves 2s earlier is detected as the leader', () => {
  const tape = new SpotTape();
  const v = walk(130, 7);
  // kraken sees the walk at time t; coinbase sees the SAME walk 2s later
  feed(tape, 'kraken', v, T0, 1_000);
  const cbSeries = v.map((_, i) => (i < 2 ? v[0] : v[i - 2]));
  feed(tape, 'coinbase', cbSeries, T0, 1_000);
  const now = T0 + 129_000;
  const lead = tape.leadLag(now);
  assert.equal(lead.venue, 'kraken', `expected kraken to lead, got ${lead.venue}`);
  assert.equal(lead.lagS, 2, 'by exactly 2 seconds');
  assert.ok((lead.corr ?? 0) > 0.8, `correlation ${lead.corr}`);

  // the reverse construction: coinbase first
  const tape2 = new SpotTape();
  feed(tape2, 'coinbase', v, T0, 1_000);
  feed(tape2, 'kraken', cbSeries, T0, 1_000);
  const lead2 = tape2.leadLag(now);
  assert.equal(lead2.venue, 'coinbase');
  assert.equal(lead2.lagS, 2);

  // not enough overlap -> null, never a guess
  const tape3 = new SpotTape();
  feed(tape3, 'kraken', v.slice(0, 5), T0, 1_000);
  feed(tape3, 'coinbase', v.slice(0, 5), T0, 1_000);
  assert.equal(tape3.leadLag(T0 + 4_000).venue, null);
});

test('volatility: sigma over the last 60s responds to the size of the moves', () => {
  const calm = new SpotTape();
  feed(calm, 'kraken', walk(70, 3).map((p) => 100_000 + (p - 100_000) * 0.000_1), T0, 1_000);
  const wild = new SpotTape();
  feed(wild, 'kraken', walk(70, 3), T0, 1_000);
  const now = T0 + 69_000;
  const sCalm = calm.snapshot(now).kraken?.sigma60 ?? null;
  const sWild = wild.snapshot(now).kraken?.sigma60 ?? null;
  assert.ok(sCalm !== null && sWild !== null, 'both series report a sigma');
  assert.ok(sWild > sCalm * 100, `wild ${sWild} should dwarf calm ${sCalm}`);
  assert.ok(sWild > 0);
});

test('trade tape: 1s flow and taker split by venue', () => {
  const tape = new SpotTape();
  const now = T0 + 5_000;
  tape.observeTrade({ venue: 'coinbase', ts: now - 10, price: 100_000, qty: 2, side: 'buy' });
  tape.observeTrade({ venue: 'coinbase', ts: now - 20, price: 100_001, qty: 1, side: 'buy' });
  tape.observeTrade({ venue: 'coinbase', ts: now - 50, price: 100_002, qty: 3, side: 'sell' });
  tape.observeTrade({ venue: 'coinbase', ts: now - 5_000, price: 99_000, qty: 9, side: 'buy' }); // outside 1s
  tape.observeTrade({ venue: 'kraken', ts: now - 10, price: 100_000, qty: 7, side: 'sell' });
  const snap = tape.snapshot(now);
  assert.equal(snap.coinbase?.trades1s, 3);
  assert.ok(Math.abs((snap.coinbase?.qty1s ?? 0) - 6) < 1e-9);
  assert.ok(Math.abs((snap.coinbase?.buyPct1s ?? 0) - 2 / 3) < 1e-9, '2 buys of 3 known-side prints');
  assert.equal(snap.kraken?.trades1s, 1);
});

test('Kraken trade frames: BTC only, XBT alias mapped, junk ignored', () => {
  const frame = JSON.stringify({
    channel: 'trade',
    data: [
      { symbol: 'BTC/USD', price: 100_000, qty: 0.5, side: 'buy', timestamp: '2026-11-20T20:00:01.000Z' },
      { symbol: 'XBT/USD', price: 100_001, qty: 0.25, side: 'sell', timestamp: '2026-11-20T20:00:02.000Z' },
      { symbol: 'ETH/USD', price: 3_000, qty: 1, side: 'buy', timestamp: '2026-11-20T20:00:03.000Z' },
      { symbol: 'SOL/USD', price: 0, qty: 0, side: 'buy', timestamp: '2026-11-20T20:00:04.000Z' },
    ],
  });
  const trades = parseKrakenTrades(frame, T0);
  assert.equal(trades.length, 2, 'BTC and XBT only, valid prices only');
  assert.equal(trades[0].venue, 'kraken');
  assert.equal(trades[0].side, 'buy');
  assert.equal(trades[0].ts, Date.parse('2026-11-20T20:00:01.000Z'));
  assert.equal(trades[1].price, 100_001, 'XBT is BTC');
  assert.equal(parseKrakenTrades('not json', T0).length, 0);
  assert.equal(parseKrakenTrades(JSON.stringify({ channel: 'ticker', data: [] }), T0).length, 0);
});

test('Coinbase canonical events: quotes and prints for BTC-USD only', () => {
  const mk = (over: Partial<CanonicalEvent>): CanonicalEvent => ({
    provider: 'coinbase', instrument: 'BTC-USD', base: 'BTC', quote: 'USD',
    productType: 'SPOT', type: 'ticker', eventId: null, exchangeTs: T0,
    recvTs: T0 + 20, processTs: T0 + 21, price: 100_000, size: null, side: null,
    bid: 99_999, bidQty: 2, ask: 100_001, askQty: 3, bids: null, asks: null,
    seq: null, channel: 'ticker', freshness: 'REALTIME', bookValid: true, ...over,
  });
  const q = coinbaseQuote(mk({}));
  assert.ok(q);
  assert.equal(q.venue, 'coinbase');
  assert.equal(q.recvTs, T0 + 20, 'arrival time is kept for staleness');
  assert.equal(coinbaseQuote(mk({ base: 'ETH' })), null, 'non-BTC refused');
  assert.equal(coinbaseQuote(mk({ provider: 'kraken' })), null, 'wrong provider refused');
  assert.equal(coinbaseQuote(mk({ type: 'trade' })), null, 'a print is not a quote');

  const t = coinbaseTrade(mk({ type: 'trade', size: 1.5, side: 'sell', price: 100_000 }));
  assert.ok(t);
  assert.equal(t.qty, 1.5);
  assert.equal(t.side, 'sell');
  assert.equal(coinbaseTrade(mk({ type: 'trade', size: null })), null, 'size-less print dropped');
});

test('persistence: one row per venue, labeled as an approximation', () => {
  const db = new DatabaseSync(':memory:');
  ensureSpotTables(db);
  const tape = new SpotTape();
  feed(tape, 'kraken', walk(65, 11), T0, 1_000);
  feed(tape, 'coinbase', walk(65, 12), T0, 1_000);
  const now = T0 + 64_000;
  const snap = tape.snapshot(now);
  insertSpotSample(db, snap);
  const rows = db.prepare('SELECT * FROM k15m_spot_samples ORDER BY venue').all() as Array<Record<string, unknown>>;
  assert.equal(rows.length, 2, 'one row per venue');
  assert.deepEqual(rows.map((r) => r.venue), ['coinbase', 'kraken']);
  for (const r of rows) {
    assert.equal(r.settlement_reference, 0, 'spot is never the settlement reference');
    assert.equal(typeof r.mid, 'number');
    assert.equal(typeof r.ret_1s, 'number');
    assert.ok(r.ret_60s !== undefined);
    assert.equal(r.agree_1s, snap.agree1s ? 1 : 0);
  }
  assert.equal(rows[0].divergence_bps, snap.divergenceBps);
  db.close();
});

test('SpotRuntime: hooks feed the tape, sample() persists, disabled = no rows', () => {
  const db = new DatabaseSync(':memory:');
  const now = { t: T0 };
  const rt = new SpotRuntime({
    config: { enabled: true, sampleMs: 1_000, retentionDays: 14, staleMs: 5_000 },
    now: () => now.t,
    db,
  });
  // Kraken hook (shape of CryptoRuntime.observeSpot)
  rt.observeKraken({ symbol: 'BTC', price: 100_000, ts: T0, bid: 99_999.5, ask: 100_000.5 });
  rt.observeKraken({ symbol: 'ETH', price: 3_000, ts: T0, bid: 2_999, ask: 3_001 }); // ignored
  assert.equal(rt.stats.krakenTicks, 1, 'only BTC ticks reach the tape');

  const cbEvent = {
    provider: 'coinbase', instrument: 'BTC-USD', base: 'BTC', quote: 'USD',
    productType: 'SPOT', type: 'ticker', eventId: null, exchangeTs: T0,
    recvTs: T0 + 5, processTs: T0 + 6, price: 100_010, size: null, side: null,
    bid: 100_009, bidQty: 1, ask: 100_011, askQty: 1, bids: null, asks: null,
    seq: null, channel: 'ticker', freshness: 'REALTIME', bookValid: true,
  } as CanonicalEvent;
  rt.observeCoinbase(cbEvent);
  const st = rt.status(now.t);
  assert.equal(st.enabled, true);
  assert.equal((st.kraken as Record<string, unknown>).mid, 100_000);
  assert.equal((st.coinbase as Record<string, unknown>).mid, 100_010);
  assert.ok(typeof st.divergenceBps === 'number');
  assert.match(String(st.settlementReference), /APPROXIMATION/);

  rt.sample();
  const rows = db.prepare('SELECT COUNT(*) AS n FROM k15m_spot_samples').get() as { n: number };
  assert.equal(Number(rows.n), 2, 'sample() writes both venues');

  // disabled runtime: no tables, no rows, no timers — construction is free
  const off = new SpotRuntime({ config: { enabled: false, sampleMs: 1_000, retentionDays: 14, staleMs: 5_000 } });
  off.start();
  assert.equal(off.status().enabled, false);
  off.stop();
  db.close();
});

test('corr: degenerate series return null instead of a fake correlation', () => {
  assert.equal(corr([1, 1, 1, 1, 1, 1, 1, 1, 1, 1], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), null, 'zero variance');
  assert.equal(corr([1, 2, 3], [1, 2, 3]), null, 'too few points');
  const c = corr([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], [2, 4, 6, 8, 10, 12, 14, 16, 18, 20]);
  assert.ok(c !== null && Math.abs(c - 1) < 1e-9, 'perfect linear relation');
});