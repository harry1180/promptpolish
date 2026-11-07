/**
 * Index-quote tests: `^VIX` (and its siblings) now have a source that answers
 * from this host, and an index symbol can no longer blank the Alpaca realtime
 * batch — a real production bug: one `^VIX` made every snapshot request come
 * back `400 invalid symbol`, so all quotes fell through to delayed Nasdaq.
 *
 * Network access is injected — no test touches the internet.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CboeIndexProvider } from '../src/tradingusa/providers/cboe.ts';
import { AlpacaRealtimeProvider } from '../src/tradingusa/providers/alpaca.ts';
import { TradingRuntime } from '../src/tradingusa/runtime.ts';

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const CBOE_VIX = {
  timestamp: '2026-11-03 02:02:15',
  data: { symbol: '^VIX', current_price: 21.15, price_change: 1.73, prev_day_close: 21.15 },
};

const ALPACA_BATCH = {
  AAPL: {
    latestTrade: { p: 338.95, t: '2026-11-03T02:00:00.000000000Z' },
    latestQuote: { bp: 338.9, ap: 339.0 },
    prevDailyBar: { c: 344.77 },
  },
};

test('cboe index quote: price, derived prev close, provenance and UTC stamp', async () => {
  const cboe = new CboeIndexProvider({
    fetchImpl: (async (input: RequestInfo | URL) => {
      assert.match(String(input), /delayed_quotes\/quotes\/_VIX\.json$/);
      return jsonRes(CBOE_VIX);
    }) as unknown as typeof fetch,
  });
  const quotes = await cboe.getQuotes(['^VIX']);
  assert.equal(quotes.length, 1);
  const q = quotes[0];
  assert.equal(q.symbol, '^VIX');
  assert.equal(q.price, 21.15);
  assert.ok(
    Math.abs(q.prevClose - 19.42) < 1e-9,
    'prev close is derived from price_change — the field itself echoed the last price',
  );
  assert.equal(q.provider, 'cboe', 'provenance names the source that actually answered');
  assert.equal(q.freshness, 'DELAYED');
  assert.equal(new Date(q.ts).toISOString(), '2026-11-03T02:02:15.000Z');
  assert.equal(cboe.status(), 'CONNECTED');
  assert.equal(cboe.lastError(), null);
});

test('cboe skips index tickers it has no Cboe symbol for instead of guessing', async () => {
  let calls = 0;
  const cboe = new CboeIndexProvider({
    fetchImpl: (async () => { calls += 1; return jsonRes(CBOE_VIX); }) as unknown as typeof fetch,
  });
  const quotes = await cboe.getQuotes(['^IXIC', '^NOT_A_REAL_INDEX']);
  assert.equal(calls, 0, 'no request is made for a symbol we cannot name honestly');
  assert.equal(quotes.length, 0);
});

test('alpaca batch ignores index symbols instead of failing the whole request', async () => {
  let requested = '';
  const alpaca = new AlpacaRealtimeProvider({
    keyId: 'PK', secretKey: 'SK',
    fetchImpl: (async (input: RequestInfo | URL) => {
      requested = String(input);
      return jsonRes(ALPACA_BATCH);
    }) as unknown as typeof fetch,
  });
  const quotes = await alpaca.getQuotes(['^VIX', 'AAPL']);
  assert.ok(!requested.includes('%5E'), 'the index symbol never reaches the endpoint');
  assert.ok(requested.includes('AAPL'), 'equities still go out in the batch');
  assert.equal(quotes.length, 1);
  assert.equal(quotes[0].symbol, 'AAPL');
  assert.equal(quotes[0].freshness, 'REALTIME');
  assert.equal(alpaca.status(), 'CONNECTED');
});

test('runtime fallback serves equities and indexes with per-quote provenance', async () => {
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('finance.yahoo.com')) return new Response('Too Many Requests', { status: 429 });
    if (url.includes('data.alpaca.markets')) return jsonRes(ALPACA_BATCH);
    if (url.includes('cboe.com')) return jsonRes(CBOE_VIX);
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;

  const rt = new TradingRuntime({
    dbPath: ':memory:', workers: false, fetchImpl,
    alpacaKeyId: 'PK', alpacaSecretKey: 'SK',
  });
  try {
    const quotes = await rt.provider.getQuotes(['AAPL', '^VIX']);
    const aapl = quotes.find((q) => q.symbol === 'AAPL');
    const vix = quotes.find((q) => q.symbol === '^VIX');
    assert.ok(aapl, 'the equity quote survives Yahoo being throttled');
    assert.equal(aapl?.provider, 'alpaca');
    assert.equal(aapl?.freshness, 'REALTIME');
    assert.ok(vix, 'the index quote is served even though neither Nasdaq nor Alpaca carries it');
    assert.equal(vix?.provider, 'cboe');
    assert.equal(vix?.freshness, 'DELAYED');
  } finally {
    rt.stop();
  }
});
