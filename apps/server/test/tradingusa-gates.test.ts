/**
 * Gates + real-time provider tests (all network injected — nothing touches
 * the internet):
 *   - AlpacaRealtimeProvider parses batch snapshots into REALTIME quotes,
 *     keeps provenance per quote, and fails soft on bad credentials.
 *   - entryGate: adverse regime vetoes BUY first, confidence floor second,
 *     SELL is never gated (it exits a long-only book).
 *   - reentryCooldownActive / earningsWithinDaysFor: the two new order gates.
 *   - parseEarningsDate: both Nasdaq response shapes, stale dates rejected.
 *   - runtime wires Alpaca as the FIRST quote fallback (provenance not faked).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { AlpacaRealtimeProvider } from '../src/tradingusa/providers/alpaca.ts';
import { parseEarningsDate } from '../src/tradingusa/earnings.ts';
import {
  entryGate, reentryCooldownActive, earningsWithinDaysFor,
} from '../src/tradingusa/engine.ts';
import { tradableUniverse } from '../src/tradingusa/universe.ts';
import { openTradingDb } from '../src/tradingusa/schema.ts';
import { TradingRuntime } from '../src/tradingusa/runtime.ts';
import { etDate } from '@promptslim/tucore';
import type { DatabaseSync } from 'node:sqlite';

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const SNAPSHOT = {
  AAPL: {
    latestTrade: { p: 345.885, t: '2026-10-26T15:28:17.014932408Z' },
    latestQuote: { bp: 345.86, ap: 345.91, t: '2026-10-26T15:28:24.415039103Z' },
    dailyBar: { c: 345.84, v: 352370 },
    prevDailyBar: { c: 347.69 },
  },
  SPY: {
    latestTrade: { p: 767.02, t: '2026-10-26T15:28:21.528598716Z' },
    latestQuote: { bp: 766.9, ap: 767.11 },
    prevDailyBar: { c: 759.83 },
  },
  THIN: { latestQuote: { bp: 10, ap: 12 } }, // no trade: midpoint fallback
  EMPTY: {}, // no usable price: dropped
};

test('alpaca snapshots parse into REALTIME quotes with per-quote provenance', async () => {
  let url = '';
  const provider = new AlpacaRealtimeProvider({
    keyId: 'PK', secretKey: 'SK',
    fetchImpl: (async (input: RequestInfo | URL) => {
      url = String(input);
      return jsonRes(SNAPSHOT);
    }) as unknown as typeof fetch,
  });
  const quotes = await provider.getQuotes(['AAPL', 'SPY', 'THIN', 'EMPTY']);
  assert.match(url, /snapshots\?feed=iex&symbols=/);
  assert.equal(quotes.length, 3, 'symbols without a usable price are dropped');
  const aapl = quotes.find((q) => q.symbol === 'AAPL')!;
  assert.equal(aapl.provider, 'alpaca');
  assert.equal(aapl.freshness, 'REALTIME');
  assert.equal(aapl.price, 345.885, 'trade print wins over midpoint');
  assert.equal(aapl.prevClose, 347.69, 'prevClose comes from prevDailyBar');
  assert.equal(new Date(aapl.ts).toISOString(), '2026-10-26T15:28:17.014Z',
    'sub-ms Alpaca stamps truncate to parseable ms');
  assert.equal(quotes.find((q) => q.symbol === 'THIN')!.price, 11, 'midpoint fallback');
  assert.equal(provider.status(), 'CONNECTED');

  // second call inside the cache TTL must not hit the network again
  let calls = 0;
  const counting = new AlpacaRealtimeProvider({
    keyId: 'PK', secretKey: 'SK',
    fetchImpl: (async () => { calls += 1; return jsonRes(SNAPSHOT); }) as unknown as typeof fetch,
  });
  await counting.getQuotes(['AAPL']);
  await counting.getQuotes(['AAPL']);
  assert.equal(calls, 1, 'hot cache serves repeat polls');
});

test('alpaca fails soft: unconfigured returns nothing; 401 marks UNAVAILABLE without leaking headers', async () => {
  const bare = new AlpacaRealtimeProvider({ fetchImpl: (async () => jsonRes({})) as unknown as typeof fetch });
  assert.equal(bare.configured(), false);
  assert.deepEqual(await bare.getQuotes(['AAPL']), [], 'no creds -> no request at all');

  const rejected = new AlpacaRealtimeProvider({
    keyId: 'PK', secretKey: 'TOPSECRETVALUE',
    fetchImpl: (async () => jsonRes({ message: 'forbidden' }, 401)) as unknown as typeof fetch,
  });
  const out = await rejected.getQuotes(['AAPL']);
  assert.deepEqual(out, []);
  assert.equal(rejected.status(), 'UNAVAILABLE');
  assert.ok(!String(rejected.lastError()).includes('TOPSECRETVALUE'), 'no key material in errors');
});

test('alpaca serves no daily bars by design (EOD stays with Yahoo/Nasdaq)', async () => {
  const provider = new AlpacaRealtimeProvider({ keyId: 'a', secretKey: 'b' });
  assert.deepEqual(await provider.getDailyBars('AAPL'), []);
});

test('entryGate: adverse regime first, confidence floor second, SELL never gated', () => {
  // regime outranks confidence as the attribution cause
  const bad = entryGate('BUY', 'RISK_OFF', 0.9, 0.7);
  assert.equal(bad.allowed, false);
  assert.equal(bad.kind, 'regime');
  const weak = entryGate('BUY', 'BULL_TREND', 0.62, 0.7);
  assert.equal(weak.allowed, false);
  assert.equal(weak.kind, 'confidence');
  const ok = entryGate('BUY', 'BULL_TREND', 0.75, 0.7);
  assert.equal(ok.allowed, true);
  // every adverse regime blocks; production's RISK_OFF was the killer
  for (const r of ['BEAR_TREND', 'RISK_OFF', 'LIQUIDITY_STRESS', 'HIGH_VOLATILITY', 'UNCERTAIN'] as const) {
    assert.equal(entryGate('BUY', r, 0.99, 0.7).allowed, false, `${r} must block BUY`);
  }
  // SELL exits the long-only book — never gated, even in a bad regime
  assert.equal(entryGate('SELL', 'RISK_OFF', 0.1, 0.7).allowed, true);
  assert.equal(entryGate('SELL', 'BULL_TREND', 0.5, 0.7).allowed, true);
});

test('reentryCooldownActive: recent stop blocks, old/absent stop does not', () => {
  const db = openTradingDb(':memory:');
  const now = Date.now();
  const insert = (ticker: string, exitTs: number) =>
    db.prepare(
      `INSERT INTO paper_trades (portfolio, ticker, company, sector, side, qty, entry_price, entry_ts,
         exit_price, exit_ts, exit_reason, capital, gross_pnl, net_pnl, return_pct, status)
       VALUES ('SHORT_TERM_PORTFOLIO', ?, 'X', 'Technology', 'LONG', 1, 100, ?, 99, ?, 'STOP_REACHED', 100, -1, -0.01, -0.01, 'CLOSED')`,
    ).run(ticker, exitTs - 86400_000, exitTs);

  assert.equal(reentryCooldownActive(db, 'NONE', now, 5), false, 'no stop ever');
  insert('FRESH', now - 1 * 86400_000);
  assert.equal(reentryCooldownActive(db, 'FRESH', now, 5), true, 'stop yesterday is inside a 5-session window');
  insert('STALE', now - 60 * 86400_000);
  assert.equal(reentryCooldownActive(db, 'STALE', now, 5), false, 'a 60-day-old stop is history');
  assert.equal(reentryCooldownActive(db, 'FRESH', now, 0), false, 'sessions=0 disables the gate');
  // SELL-side safety: only STOP_REACHED counts — a target exit must not cool down
  db.prepare(
    `INSERT INTO paper_trades (portfolio, ticker, company, sector, side, qty, entry_price, entry_ts,
       exit_price, exit_ts, exit_reason, capital, gross_pnl, net_pnl, return_pct, status)
     VALUES ('SHORT_TERM_PORTFOLIO','WINNER','X','Technology','LONG',1,100,?,110,?,'TARGET_REACHED',100,10,0.1,0.1,'CLOSED')`,
  ).run(now - 86400_000, now - 86400_000);
  assert.equal(reentryCooldownActive(db, 'WINNER', now, 5), false, 'target exits never trigger cooldown');
});

test('earningsWithinDaysFor: unknown/stale rows behave like the old 9999 default', () => {
  const db = openTradingDb(':memory:');
  const now = Date.now();
  assert.equal(earningsWithinDaysFor(db, 'NOBODY', now), 9999, 'no row -> no gate');
  db.prepare(`INSERT INTO earnings_calendar (ticker, next_earnings_date, fetched_at) VALUES ('SOON', ?, ?)`)
    .run(etDate(now + 2 * 86400_000), now);
  const days = earningsWithinDaysFor(db, 'SOON', now);
  assert.ok(days >= 1 && days <= 4, `future date -> small session count (got ${days})`);
  db.prepare(`INSERT INTO earnings_calendar (ticker, next_earnings_date, fetched_at) VALUES ('PAST', ?, ?)`)
    .run('2026-01-15', now);
  assert.equal(earningsWithinDaysFor(db, 'PAST', now), 9999, 'stale past date -> unknown, not "overdue"');
  // Regression (production OOM crash-loop, 2026-10-27): the earnings job's
  // '9999-12-31' "unknown" sentinel and any non-ISO value MUST read as
  // unknown — passing them to countTradingDays spins tradingDaysBetween for
  // ~2.9M iterations until the heap is exhausted. These asserts complete in
  // milliseconds only if the guard holds.
  db.prepare(`INSERT INTO earnings_calendar (ticker, next_earnings_date, fetched_at) VALUES ('SENTINEL', '9999-12-31', ?)`)
    .run(now);
  assert.equal(earningsWithinDaysFor(db, 'SENTINEL', now), 9999, '9999-12-31 sentinel -> unknown, never counted');
  db.prepare(`INSERT INTO earnings_calendar (ticker, next_earnings_date, fetched_at) VALUES ('GARBAGE', 'Nov 02, 2026', ?)`)
    .run(now);
  assert.equal(earningsWithinDaysFor(db, 'GARBAGE', now), 9999, 'non-ISO value -> unknown, never counted');
});

test('parseEarningsDate handles both Nasdaq shapes and rejects past dates', () => {
  assert.equal(
    parseEarningsDate('Apple is expected* to report earnings on  11/02/2026 after market close.', '2026-10-26'),
    '2026-11-02',
  );
  assert.equal(
    parseEarningsDate('Earnings announcement* for AAPL: Nov 02, 2026', '2026-10-26'),
    '2026-11-02',
  );
  assert.equal(
    parseEarningsDate('report earnings on 01/05/2026', '2026-10-26'),
    null,
    'a date already in the past means the calendar has not rolled -> unknown',
  );
  assert.equal(parseEarningsDate('no date here', '2026-10-26'), null);
});

test('runtime wires Alpaca FIRST in the quote fallback chain (provenance stays per quote)', async () => {
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('finance.yahoo.com')) return new Response('Too Many Requests', { status: 429 });
    if (url.includes('data.alpaca.markets')) {
      // serve only the requested symbols, like the real endpoint does
      const want = new Set(decodeURIComponent(url.split('symbols=')[1] ?? '').split(','));
      const body: Record<string, unknown> = {};
      for (const k of Object.keys(SNAPSHOT)) if (want.has(k)) body[k] = SNAPSHOT[k];
      return jsonRes(body);
    }
    if (url.includes('api.nasdaq.com')) return jsonRes({ data: null });
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
  const rt = new TradingRuntime({
    dbPath: ':memory:', workers: false, fetchImpl,
    alpacaKeyId: 'PK', alpacaSecretKey: 'SK',
  });
  try {
    assert.equal(typeof rt.provider.quoteFallback, 'function');
    const quotes = await rt.provider.getQuotes(['AAPL', 'SPY']);
    assert.equal(quotes.length, 2, 'Yahoo 429 -> Alpaca serves the batch');
    assert.ok(quotes.every((q) => q.provider === 'alpaca' && q.freshness === 'REALTIME'),
      'stored rows truthfully claim alpaca/REALTIME');
    assert.equal(rt.alpaca.status(), 'CONNECTED');
  } finally {
    rt.stop();
  }
});

test('universe exposes the tradable set the earnings job walks', () => {
  const t = tradableUniverse();
  // 51 tradable stocks; ALL_TICKERS (65) adds benchmarks + sector ETFs
  assert.ok(t.length >= 50, `expected >=50 tradable tickers (got ${t.length})`);
  assert.ok(t.every((u) => u.tradable && u.ticker === u.ticker.toUpperCase()));
});