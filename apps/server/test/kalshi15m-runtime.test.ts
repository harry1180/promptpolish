/**
 * K15mRuntime integration — offline: fake REST + fake socket, real frames.
 *
 * Drives the whole path the production engine walks:
 *   discovery -> window row -> book -> sampled tape -> feed health ->
 *   trade ingest (own vs foreign) -> sequence gap -> snapshot recovery ->
 *   15-minute rollover.
 * No network, no credentials, no timers: time is injected.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { generateKeyPairSync } from 'node:crypto';
import { K15mRuntime, k15mConfigFromEnv, type K15mConfig } from '../src/kalshi15m/runtime.ts';
import { KalshiRest, type StreamSocket } from '../src/kalshi15m/client.ts';

const FIX = new URL('./fixtures/kalshi15m/', import.meta.url);
function frame(kind: string, i = 0): Record<string, any> {
  const lines = readFileSync(new URL(`${kind}.jsonl`, FIX), 'utf8').trim().split('\n');
  return JSON.parse(lines[Math.min(i, lines.length - 1)]);
}

const T0 = Date.parse('2026-11-20T20:45:00Z'); // window open (fixtures: 1600 window)
const CLOSE = T0 + 15 * 60_000;
const MKT = 'KXBTC15M-26NOV201600-00';
const EVT = 'KXBTC15M-26NOV201600';

function restMarket(openIso: string, closeIso: string, ticker = MKT): Record<string, unknown> {
  return {
    ticker, status: 'active',
    open_time: openIso, close_time: closeIso,
    expected_expiration_time: new Date(Date.parse(closeIso) + 5 * 60_000).toISOString(),
    floor_strike: 58_643.54,
    yes_bid_dollars: '0.4300', yes_ask_dollars: '0.4400',
    volume_fp: '1000.00', open_interest_fp: '2000.00',
    rules_primary: 'If the simple average of the sixty seconds of CF Benchmarks\' BRTI before close ...',
  };
}

class FakeSocket implements StreamSocket {
  sent: string[] = [];
  closed = false;
  private handlers = new Map<string, Array<(...a: never[]) => void>>();
  on(ev: string, cb: (...a: never[]) => void): void {
    const list = this.handlers.get(ev) ?? [];
    list.push(cb);
    this.handlers.set(ev, list);
  }
  send(data: string): void { this.sent.push(data); }
  close(): void { this.closed = true; }
  fire(ev: string, ...args: unknown[]): void {
    for (const cb of this.handlers.get(ev) ?? []) (cb as (...a: unknown[]) => void)(...args);
  }
  subscribes(): Array<Record<string, any>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, any>);
  }
}

function makeRuntime(opts: {
  market?: Record<string, unknown>;
  marketCalls?: Array<Record<string, unknown>>;
  configPatch?: Partial<K15mConfig>;
} = {}): { rt: K15mRuntime; sock: FakeSocket; now: { t: number }; db: DatabaseSync; restCalls: string[] } {
  const db = new DatabaseSync(':memory:');
  const now = { t: T0 };
  const restCalls: string[] = [];
  const markets = opts.marketCalls ?? [opts.market ?? restMarket('2026-11-20T20:45:00Z', '2026-11-20T21:00:00Z')];
  let call = 0;
  const fetchImpl = (async (url: string) => {
    restCalls.push(url);
    const u = String(url);
    if (u.includes('/orderbook')) {
      return new Response(JSON.stringify({ orderbook_fp: { yes_dollars: [['0.4300', '100']], no_dollars: [['0.5600', '100']] } }));
    }
    const market = markets[Math.min(call++, markets.length - 1)];
    return new Response(JSON.stringify({ markets: [market] }));
  }) as unknown as typeof fetch;
  const sock = new FakeSocket();
  const { privateKey } = generateKeyPairSync('ed25519');
  const config: K15mConfig = {
    ...k15mConfigFromEnv({}),
    enabled: true,
    sampleMs: 250,
    discoverMs: 10_000,
    healthMs: 1_000,
    staleMs: 5_000,
    retentionDays: 14,
    snapshotRecoveryMs: 0, // recovery allowed on every gap (test speed)
    auth: { apiKeyId: 'test-key', pem: privateKey.export({ format: 'pem', type: 'pkcs8' }) as string },
    ...(opts.configPatch ?? {}),
  };
  const rt = new K15mRuntime({
    db, config,
    rest: new KalshiRest({ fetchImpl, creds: { keyId: 'test-key', key: privateKey } }),
    creds: { keyId: 'test-key', key: privateKey },
    socketFactory: () => sock as unknown as StreamSocket,
    now: () => now.t,
  });
  return { rt, sock, now, db, restCalls };
}

function count(db: DatabaseSync, table: string): number {
  return Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
}

/* ------------------------------------------------------------------ */

test('config defaults are safe: engine off, 250ms samples, 14-day retention', () => {
  const c = k15mConfigFromEnv({});
  assert.equal(c.enabled, false, 'never on by default');
  assert.equal(c.series, 'KXBTC15M');
  assert.equal(c.sampleMs, 250);
  assert.equal(c.retentionDays, 14);
  assert.equal(k15mConfigFromEnv({ KALSHI15M_ENABLED: '1' }).enabled, true);
  const knobbed = k15mConfigFromEnv({ KALSHI15M_SAMPLE_MS: '500', KALSHI15M_RETENTION_DAYS: '3' });
  assert.equal(knobbed.sampleMs, 500);
  assert.equal(knobbed.retentionDays, 3);
});

test('discovery -> window row -> book -> sampled tape -> health, all offline', async () => {
  const { rt, sock, now, db } = makeRuntime();
  await rt.discover();
  assert.ok(rt.current, 'a current window must exist after discovery');
  assert.equal(rt.current?.eventTicker, EVT);
  assert.equal(rt.current?.bounds.openTs, T0);
  assert.equal(rt.current?.bounds.closeTs, CLOSE);
  assert.equal(rt.current?.strike, 58_643.54);

  rt.ws.start();
  sock.fire('open');
  assert.ok(sock.sent.length >= 1, 'socket opened and subscribed');
  const subs = sock.subscribes();
  assert.ok(subs.some((s) => s.cmd === 'subscribe' && s.params?.channels?.includes('trade')));
  assert.ok(subs.some((s) => s.params?.channels?.includes('orderbook_delta')
    && s.params?.market_tickers?.includes(MKT)), 'subscribed to the current market');

  // real captured frames into the book
  const snap = frame('orderbook_snapshot');
  sock.fire('message', JSON.stringify(snap));
  for (let i = 0; i < 6; i++) sock.fire('message', JSON.stringify(frame('orderbook_delta', i)));
  // one print for our market, one for a foreign market (global channel)
  sock.fire('message', JSON.stringify(frame('trade', 0)));
  sock.fire('message', JSON.stringify(frame('trade', 2)));

  const book = rt.books.get(MKT);
  assert.ok(book, 'book exists');
  assert.equal(book.needsSnapshot, false);
  assert.equal(book.seq, 7, 'six deltas after the snapshot arm the sequence');

  // sample cadence: nothing at +100ms, a row at +300ms
  rt.tick(now.t + 100);
  assert.equal(count(db, 'k15m_book_samples'), 0, 'no sample before sampleMs');
  now.t += 300;
  rt.tick(now.t);
  assert.equal(count(db, 'k15m_book_samples'), 1);
  const s = db.prepare('SELECT * FROM k15m_book_samples ORDER BY id DESC LIMIT 1').get() as Record<string, unknown>;
  assert.equal(s.market_ticker, MKT);
  assert.equal(s.yes_bid, 0.43);
  assert.equal(s.yes_ask, 0.44);
  assert.equal(s.phase, 'OPEN');
  assert.equal(s.ms_to_close, CLOSE - now.t);
  assert.equal(s.spot_mid, null, 'no BTC quote table in this bare DB -> null, not a guess');
  assert.equal(s.needs_snapshot, 0);

  // trades: ours stored once, foreign dropped
  assert.equal(count(db, 'k15m_trades'), 1, 'only our market prints are persisted');
  const tr = db.prepare('SELECT * FROM k15m_trades').get() as Record<string, unknown>;
  assert.equal(tr.market_ticker, MKT);
  assert.equal(tr.taker_side, 'yes');
  assert.equal(rt.stats.trades, 1);

  // health row after healthMs
  now.t += 1_100;
  rt.tick(now.t);
  assert.equal(count(db, 'k15m_feed_health'), 1);
  const h = db.prepare('SELECT * FROM k15m_feed_health').get() as Record<string, unknown>;
  assert.equal(h.stale, 0, 'frames arrived within staleMs');
  assert.equal(h.book_trusted, 1);

  // status block is secret-free and describes the window
  const st = rt.status(now.t);
  assert.equal(st.enabled, true);
  assert.equal((st.window as Record<string, unknown>).eventTicker, EVT);
  assert.equal((st.window as Record<string, unknown>).phase, 'OPEN');
  assert.ok(!JSON.stringify(st).includes('test-key'), 'status must never leak key material');

  rt.stop();
  assert.equal(sock.closed, true, 'stop() closes the socket');
  db.close();
});

test('sequence gap: book goes untrusted, re-subscribe fires, sample flags it', async () => {
  const { rt, sock, now, db } = makeRuntime();
  await rt.discover();
  rt.ws.start();
  sock.fire('open');
  sock.fire('message', JSON.stringify(frame('orderbook_snapshot')));
  const before = sock.sent.length;

  sock.fire('message', JSON.stringify(frame('orderbook_delta', 0)));
  // jump: seq 99 after seq 2
  sock.fire('message', JSON.stringify({
    type: 'orderbook_delta', sid: 4, seq: 99,
    msg: { market_ticker: MKT, side: 'yes', price_dollars: '0.4300', delta_fp: '10', ts_ms: now.t },
  }));
  const book = rt.books.get(MKT);
  assert.equal(book?.needsSnapshot, true, 'untrusted after a seq jump');
  assert.equal(rt.stats.seqGaps, 1);
  assert.ok(sock.sent.length > before, 're-subscribe requested');

  now.t += 300;
  rt.tick(now.t);
  const s = db.prepare('SELECT needs_snapshot FROM k15m_book_samples ORDER BY id DESC LIMIT 1')
    .get() as { needs_snapshot: number };
  assert.equal(s.needs_snapshot, 1, 'samples record that the book was untrusted');

  // snapshot recovery re-arms and the next delta applies again
  sock.fire('message', JSON.stringify(frame('orderbook_snapshot')));
  assert.equal(book?.needsSnapshot, false);
  sock.fire('message', JSON.stringify(frame('orderbook_delta', 0)));
  assert.equal(book?.seq, 2, 'lazy re-arm: the first delta after a snapshot sets the sequence');
  rt.stop();
  db.close();
});

test('rollover: a new window replaces the current one and is persisted', async () => {
  const marketCalls = [
    restMarket('2026-11-20T20:30:00Z', '2026-11-20T20:45:00Z', 'KXBTC15M-26NOV201545-45'),
    restMarket('2026-11-20T20:45:00Z', '2026-11-20T21:00:00Z', 'KXBTC15M-26NOV201600-00'),
  ];
  const { rt, now, db } = makeRuntime({
    marketCalls,
    // only the closeTs trigger may fire discovery here — a periodic refresh
    // would fetch the next window early and fake the rollover
    configPatch: { discoverMs: 10_000_000 },
  });
  // start inside the FIRST window (20:30-20:45); the fixtures' market opens later
  const aOpen = Date.parse('2026-11-20T20:30:00Z');
  const aClose = Date.parse('2026-11-20T20:45:00Z');
  now.t = aOpen;
  await rt.discover();
  assert.equal(rt.current?.marketTicker, 'KXBTC15M-26NOV201545-45');
  assert.equal(rt.current?.bounds.closeTs, aClose);

  // close time has NOT passed -> the tick keeps the same window
  now.t = aClose - 60_000; // 20:44
  rt.tick(now.t);
  assert.equal(rt.current?.marketTicker, 'KXBTC15M-26NOV201545-45', 'still the same window before close');

  // close time passes -> the tick itself triggers discovery and rolls over
  now.t = aClose + 1_000; // 20:45:01 -> next window open
  rt.tick(now.t);
  await new Promise((r) => setTimeout(r, 20)); // let the promise resolve
  assert.equal(rt.current?.marketTicker, 'KXBTC15M-26NOV201600-00');
  assert.equal(rt.stats.rollOvers, 1, 'rollover counted exactly once');
  const rows = db.prepare('SELECT event_ticker, phase FROM k15m_windows ORDER BY close_ts').all() as Array<Record<string, unknown>>;
  assert.equal(rows.length, 2, 'both windows persisted');
  assert.equal(rows[0].event_ticker, 'KXBTC15M-26NOV201545');
  rt.stop();
  db.close();
});

test('enabled=false does nothing: no discovery, no socket, no rows', async () => {
  const { rt, sock, db } = makeRuntime();
  (rt.config as { enabled: boolean }).enabled = false;
  rt.start();
  rt.tick();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(rt.current, null, 'disabled runtime never discovers');
  assert.equal(sock.sent.length, 0, 'no subscription');
  rt.stop();
  db.close();
});