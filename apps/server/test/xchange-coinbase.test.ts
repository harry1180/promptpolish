/**
 * Coinbase Exchange adapter — fixture-driven contract:
 * every captured frame goes through the exported parse path, then the feed
 * wiring (subscribe frame, event delivery, control frames, note surface) is
 * exercised over a fake socket. No network in this suite.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CanonicalEvent } from '../src/xchange/types.ts';
import type { ParseContext, StreamSocket, VenueFeedConfig } from '../src/xchange/ws.ts';
import {
  COINBASE_FEED_URL,
  createCoinbaseFeed,
  parseCoinbaseMessage,
} from '../src/xchange/providers/coinbase.ts';

interface Fixture {
  url: string;
  subscribe: string[];
  opened: boolean;
  error: string | null;
  messages: string[];
}

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, 'fixtures', 'xchange', 'coinbase.json'), 'utf8'),
) as Fixture;

/** deterministic local clock: after every exchange timestamp in the capture */
const NOW = 1_794_033_000_000;
const SYMBOLS = ['BTC', 'ETH'];
const ctx: ParseContext = { symbols: new Set(SYMBOLS), now: NOW };

/** expected events derived from the capture (frames for our symbols only) */
function expectedCounts(): { tickers: number; trades: number } {
  let tickers = 0;
  const tradeIds = new Set<string>();
  for (const text of fixture.messages) {
    const frame = JSON.parse(text) as { type?: string; product_id?: string; trade_id?: number };
    const base = (frame.product_id ?? '').split('-')[0];
    if (base && !SYMBOLS.includes(base)) continue;
    if (frame.type === 'ticker') tickers += 1;
    if ((frame.type === 'match' || frame.type === 'last_match') && frame.trade_id !== undefined) {
      tradeIds.add(String(frame.trade_id));
    }
  }
  return { tickers, trades: tradeIds.size };
}

function parseAll(): { events: CanonicalEvent[]; seen: Set<string> } {
  const seen = new Set<string>();
  const events: CanonicalEvent[] = [];
  for (const text of fixture.messages) {
    events.push(...parseCoinbaseMessage(text, ctx, seen));
  }
  return { events, seen };
}

function assertCanonical(ev: CanonicalEvent): void {
  assert.equal(ev.provider, 'coinbase');
  assert.equal(ev.productType, 'SPOT');
  assert.equal(ev.freshness, 'REALTIME');
  assert.equal(ev.bookValid, true, 'no L2 stream -> top-of-book stays valid');
  assert.ok(SYMBOLS.includes(ev.base), `base ${ev.base} is one of ${SYMBOLS.join('/')}`);
  assert.equal(ev.instrument, `${ev.base}-USD`);
  assert.equal(ev.quote, 'USD');
  assert.equal(ev.recvTs, NOW);
  assert.equal(ev.processTs, NOW);
  assert.ok(ev.exchangeTs !== null, 'capture carries an exchange timestamp');
  assert.ok(
    ev.exchangeTs > 1_600_000_000_000 && ev.exchangeTs < NOW + 86_400_000,
    `exchangeTs ${ev.exchangeTs} is a plausible ms epoch`,
  );
  assert.ok(ev.side === 'buy' || ev.side === 'sell', `side ${String(ev.side)} is buy|sell`);
  assert.ok(ev.eventId !== null, 'capture frames carry a trade id');
  assert.ok(typeof ev.seq === 'number' && Number.isFinite(ev.seq), 'sequence is numeric');
  assert.equal(ev.bids, null, 'anonymous feed has no L2 depth');
  assert.equal(ev.asks, null, 'anonymous feed has no L2 depth');
  assert.ok(ev.price !== null && Number.isFinite(ev.price) && ev.price > 0, 'price finite > 0');
}

test('parses every fixture frame into canonical events', () => {
  const { events, seen } = parseAll();
  const want = expectedCounts();

  assert.equal(want.tickers, 14, 'capture holds 14 ticker frames');
  assert.equal(want.trades, 15, 'capture holds 15 distinct trade ids');
  assert.equal(events.length, 29, 'subscriptions frame yields nothing; 14 tickers + 15 trades');
  assert.equal(events.length, want.tickers + want.trades);
  assert.equal(events.filter((e) => e.type === 'ticker').length, 14);
  assert.equal(events.filter((e) => e.type === 'trade').length, 15);
  assert.equal(events.filter((e) => e.base === 'BTC').length, 27);
  assert.equal(events.filter((e) => e.base === 'ETH').length, 2);

  for (const ev of events) {
    assertCanonical(ev);
    if (ev.type === 'ticker') {
      assert.equal(ev.channel, 'ticker');
      assert.ok(ev.bid !== null && ev.bid > 0, 'ticker bid finite > 0');
      assert.ok(ev.ask !== null && ev.ask > 0, 'ticker ask finite > 0');
      assert.ok(ev.bidQty !== null && ev.bidQty > 0, 'best_bid_size finite > 0');
      assert.ok(ev.askQty !== null && ev.askQty > 0, 'best_ask_size finite > 0');
      assert.ok(ev.ask! >= ev.bid!, 'ask not below bid');
    } else {
      assert.equal(ev.channel, 'matches');
      assert.ok(ev.size !== null && Number.isFinite(ev.size) && ev.size > 0, 'trade size finite > 0');
      assert.equal(ev.bid, null, 'match frames carry no top of book');
      assert.equal(ev.ask, null);
    }
  }

  // no trade_id emitted twice as a trade (ticker echoes are a different type)
  const tradeIds = events.filter((e) => e.type === 'trade').map((e) => e.eventId);
  assert.equal(new Set(tradeIds).size, tradeIds.length, 'no duplicate trade events');
  assert.equal(seen.size, 15, 'dedupe memory holds every emitted trade id');
});

test('control frames and unknown frames yield no events', () => {
  const seen = new Set<string>();
  for (const text of fixture.messages) {
    const t = (JSON.parse(text) as { type: string }).type;
    if (t === 'subscriptions') {
      assert.deepEqual(parseCoinbaseMessage(text, ctx, seen), [], 'subscriptions ack -> []');
    }
  }
  assert.deepEqual(
    parseCoinbaseMessage('{"type":"error","event":"subscribe","reason":"level2, level3, and full channels now require authentication..."}', ctx, seen),
    [],
    'error frame -> []',
  );
  assert.deepEqual(parseCoinbaseMessage('{"type":"heartbeat"}', ctx, seen), []);
  assert.deepEqual(parseCoinbaseMessage('{"type":"subscribe","product_ids":["BTC-USD"],"channels":["ticker"]}', ctx, seen), []);
  assert.deepEqual(parseCoinbaseMessage('not json at all', ctx, seen), []);
  assert.deepEqual(parseCoinbaseMessage('[1,2,3]', ctx, seen), []);
  assert.deepEqual(parseCoinbaseMessage('null', ctx, seen), []);
});

test('frames for symbols outside the parse context are ignored', () => {
  const btcOnly: ParseContext = { symbols: new Set(['BTC']), now: NOW };
  const seen = new Set<string>();
  const solTicker =
    '{"type":"ticker","sequence":42,"product_id":"SOL-USD","price":"212.4","best_bid":"212.3","best_ask":"212.5","best_bid_size":"9.5","best_ask_size":"8.1","side":"buy","time":"2026-11-07T17:07:13.114539Z","trade_id":7,"last_size":"1.5"}';
  const solMatch =
    '{"type":"match","trade_id":99,"side":"sell","size":"3.5","price":"212.4","product_id":"SOL-USD","sequence":43,"time":"2026-11-07T17:07:13.114539Z"}';
  assert.deepEqual(parseCoinbaseMessage(solTicker, btcOnly, seen), [], 'SOL ticker ignored by BTC context');
  assert.deepEqual(parseCoinbaseMessage(solMatch, btcOnly, seen), [], 'SOL trade ignored by BTC context');
  assert.equal(seen.size, 0, 'ignored frames never enter the dedupe memory');

  // ...and ETH is ignored exactly the same way when only BTC is configured
  const ethTicker = fixture.messages.find((m) => m.includes('"product_id":"ETH-USD"'));
  assert.ok(ethTicker, 'capture contains an ETH frame');
  assert.deepEqual(parseCoinbaseMessage(ethTicker, btcOnly, seen), []);
  // while the BTC frames still parse for that context
  const btcTicker = fixture.messages.find(
    (m) => m.includes('"type":"ticker"') && m.includes('"product_id":"BTC-USD"'),
  );
  assert.ok(btcTicker);
  assert.equal(parseCoinbaseMessage(btcTicker, btcOnly, seen).length, 1);
});

test('trade ids dedupe: match/last_match echo and ticker overlap', () => {
  const seen = new Set<string>();
  const match =
    '{"type":"match","trade_id":1001,"side":"buy","size":"0.5","price":"75000.1","product_id":"BTC-USD","sequence":9,"time":"2026-11-07T17:07:13.000000Z"}';
  const lastMatch = match.replace('"type":"match"', '"type":"last_match"');
  const ticker =
    '{"type":"ticker","sequence":9,"product_id":"BTC-USD","price":"75000.1","best_bid":"75000.0","best_ask":"75000.2","best_bid_size":"1","best_ask_size":"2","side":"buy","time":"2026-11-07T17:07:13.000000Z","trade_id":1001,"last_size":"0.5"}';

  assert.equal(parseCoinbaseMessage(ticker, ctx, seen).length, 1, 'ticker still emits');
  assert.equal(seen.size, 0, 'a ticker does not reserve its trade id');
  assert.equal(parseCoinbaseMessage(match, ctx, seen).length, 1, 'first match emits the trade');
  assert.equal(parseCoinbaseMessage(lastMatch, ctx, seen).length, 0, 'last_match echo dropped');
  assert.equal(parseCoinbaseMessage(match, ctx, seen).length, 0, 'repeat match dropped');
  assert.equal(seen.size, 1);

  // bounded memory: ids beyond the cap are evicted, newest survive
  for (let i = 0; i < 2500; i += 1) {
    parseCoinbaseMessage(match.replace('1001', String(2000 + i)), ctx, seen);
  }
  assert.ok(seen.size <= 2000, `dedupe memory bounded (got ${seen.size})`);
  assert.ok(!seen.has('1001'), 'oldest ids evicted');
});

/** fake StreamSocket + feed wired to it; stopped via the test context */
function openFeed(t: { after(fn: () => void): void }): {
  feed: ReturnType<typeof createCoinbaseFeed>;
  sent: string[];
  handlers: Map<string, (...args: unknown[]) => void>;
  events: CanonicalEvent[];
} {
  const sent: string[] = [];
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const socket: StreamSocket = {
    on(event, cb) {
      handlers.set(event, cb as (...args: unknown[]) => void);
    },
    send(data: string) {
      sent.push(data);
    },
    close() {
      /* the test never closes the socket */
    },
  };
  const events: CanonicalEvent[] = [];
  const cfg: VenueFeedConfig = {
    symbols: SYMBOLS,
    quote: 'USD',
    onEvent: (ev) => events.push(ev),
    socketFactory: () => socket,
    now: () => NOW,
  };
  const feed = createCoinbaseFeed(cfg);
  t.after(() => feed.stop());
  feed.start();
  handlers.get('open')?.();
  return { feed, sent, handlers, events };
}

test('createCoinbaseFeed wires the venue over a fake socket', (t) => {
  const { feed, sent, handlers, events } = openFeed(t);

  assert.equal(feed.id, 'coinbase');
  assert.equal(feed.label, 'Coinbase Exchange');
  assert.equal(feed.feedKind, 'WEBSOCKET');
  assert.deepEqual(feed.channels, ['ticker', 'matches']);
  assert.deepEqual(feed.symbols, SYMBOLS);
  assert.equal(COINBASE_FEED_URL, fixture.url, 'adapter points at the captured venue');

  assert.deepEqual(sent, fixture.subscribe, 'subscribe frame matches the captured one');

  for (const text of fixture.messages) handlers.get('message')?.(text);
  assert.equal(events.length, 29, 'every fixture frame delivered exactly one event');

  const snap = feed.snapshot();
  assert.equal(snap.id, 'coinbase');
  assert.equal(snap.events, 29);
  assert.equal(snap.connected, true);
  assert.equal(snap.state, 'CONNECTED');
  assert.equal(snap.healthy, true);
  assert.equal(snap.note, null, 'clean capture leaves no note');
  assert.deepEqual(
    snap.book.map((b) => [b.symbol, b.levels, b.valid]),
    [
      ['BTC', 0, true],
      ['ETH', 0, true],
    ],
    'no L2 channel -> levels 0, reported valid',
  );
  const quotes = new Map(snap.quotes.map((q) => [q.symbol, q]));
  assert.equal(quotes.size, 2, 'top-of-book tracked per symbol');
  const btc = quotes.get('BTC');
  assert.ok(btc);
  assert.equal(btc.provider, 'coinbase');
  assert.equal(btc.quote, 'USD');
  // last frame in the capture is a trade, so top-of-book may be the trade price
  assert.ok(btc.last !== null && Number.isFinite(btc.last) && btc.last > 0, 'quote carries the last price');
  assert.equal(snap.latency.samples, 0, 'capture clock skew is not counted as latency');

  // subscription rejection arrives as a normal frame -> surfaces in note
  const rejection = '{"type":"error","event":"subscribe","reason":"level2, level3, and full channels now require authentication..."}';
  handlers.get('message')?.(rejection);
  assert.equal(events.length, 29, 'error frame emits no events');
  const noted = feed.snapshot();
  assert.equal(noted.events, 29);
  assert.ok(
    noted.note !== null && noted.note.includes('level2, level3, and full channels now require authentication'),
    `note surfaces the auth limitation (got ${String(noted.note)})`,
  );
});

test('ticker frames drive top-of-book quotes with spread', (t) => {
  const { feed, handlers, events } = openFeed(t);
  for (const text of fixture.messages) {
    if ((JSON.parse(text) as { type: string }).type === 'ticker') handlers.get('message')?.(text);
  }
  assert.equal(events.length, 14, 'only ticker frames were delivered');
  const quotes = new Map(feed.snapshot().quotes.map((q) => [q.symbol, q] as const));
  assert.equal(quotes.size, 2);
  for (const symbol of SYMBOLS) {
    const q = quotes.get(symbol);
    assert.ok(q, `quote for ${symbol}`);
    assert.equal(q.provider, 'coinbase');
    assert.equal(q.quote, 'USD');
    assert.ok(q.bid !== null && q.ask !== null && q.ask >= q.bid, `${symbol} ordered top of book`);
    assert.ok(q.mid !== null && Number.isFinite(q.mid) && q.mid > 0, `${symbol} mid price`);
    assert.ok(q.last !== null && Number.isFinite(q.last) && q.last > 0, `${symbol} last price`);
    assert.ok(q.spreadBps !== null && q.spreadBps >= 0, `${symbol} spread computed`);
    assert.equal(q.ts, NOW, 'quote stamped with the local clock');
  }
});