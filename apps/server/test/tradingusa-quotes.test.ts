/**
 * TradingUSA quote-source tests: Yahoo is primary, the Nasdaq endpoint is the
 * fallback that keeps positions mark-to-market when Yahoo is throttled.
 *
 * Network access is injected — no test touches the internet.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { YahooFinanceProvider } from '../src/tradingusa/providers/yahoo.ts';
import { NasdaqEodProvider } from '../src/tradingusa/providers/nasdaq.ts';
import { TradingRuntime } from '../src/tradingusa/runtime.ts';

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const NASDAQ_INFO = {
  data: {
    primaryData: {
      lastSalePrice: '$342.9895',
      netChange: '-0.4705',
      percentageChange: '-0.14%',
      volume: '21,053,376.9',
      lastTradeTimestamp: 'Oct 19, 2026 2:50 PM ET',
      isRealTime: true,
    },
  },
  status: { rCode: 200 },
};

test('yahoo 429 -> quoteFallback supplies the batch (provenance not faked)', async () => {
  const yahoo = new YahooFinanceProvider({
    fetchImpl: (async () => new Response('Too Many Requests', { status: 429 })) as unknown as typeof fetch,
  });
  yahoo.quoteFallback = async (symbols) =>
    symbols.map((s) => ({ symbol: s, price: 100, prevClose: 99, ts: 1, provider: 'nasdaq', freshness: 'DELAYED' as const }));

  const quotes = await yahoo.getQuotes(['AAPL', 'MSFT']);
  assert.equal(quotes.length, 2);
  assert.equal(quotes[0].provider, 'nasdaq', 'fallback quotes carry the fallback provider');
  assert.match(String(yahoo.lastError()), /fallback/);
});

test('yahoo untouched when it answers (no fallback call)', async () => {
  let fallbackCalls = 0;
  const yahoo = new YahooFinanceProvider({
    fetchImpl: (async () => jsonRes({
      spark: { result: [{ meta: { symbol: 'AAPL', regularMarketPrice: 341.5, previousClose: 340, regularMarketTime: 1792435800 } }] },
    })) as unknown as typeof fetch,
  });
  yahoo.quoteFallback = async () => { fallbackCalls += 1; return []; };

  const quotes = await yahoo.getQuotes(['AAPL']);
  assert.equal(quotes.length, 1);
  assert.equal(quotes[0].price, 341.5);
  assert.equal(fallbackCalls, 0, 'a working Yahoo must never trigger the fallback');
});

test('nasdaq quotes parse price, derived prev close and New York trade time', async () => {
  const nasdaq = new NasdaqEodProvider({
    fetchImpl: (async (input: RequestInfo | URL) => {
      const url = String(input);
      assert.match(url, /api\.nasdaq\.com\/api\/quote\/AAPL\/info\?assetclass=stocks/);
      return jsonRes(NASDAQ_INFO);
    }) as unknown as typeof fetch,
  });

  const quotes = await nasdaq.getQuotes(['AAPL', '^VIX']);
  assert.equal(quotes.length, 1, 'indexes are not on this endpoint and must be skipped');
  const q = quotes[0];
  assert.equal(q.symbol, 'AAPL');
  assert.ok(Math.abs(q.price - 342.9895) < 1e-9);
  assert.ok(Math.abs(q.prevClose - 343.46) < 1e-6, 'prevClose = lastSalePrice - netChange');
  assert.equal(q.provider, 'nasdaq');
  assert.equal(q.freshness, 'DELAYED');
  assert.equal(new Date(q.ts).toISOString(), '2026-10-19T18:50:00.000Z', '2:50 PM ET == 18:50Z');
  assert.equal(nasdaq.status(), 'CONNECTED');
});

test('nasdaq falls through stocks -> etf asset class for ETF symbols', async () => {
  const seen: string[] = [];
  const nasdaq = new NasdaqEodProvider({
    fetchImpl: (async (input: RequestInfo | URL) => {
      const url = String(input);
      seen.push(url.includes('assetclass=stocks') ? 'stocks' : 'etf');
      return url.includes('assetclass=etf') ? jsonRes(NASDAQ_INFO) : jsonRes({ data: null, status: { rCode: 400 } });
    }) as unknown as typeof fetch,
  });
  const quotes = await nasdaq.getQuotes(['SPY']);
  assert.deepEqual(seen, ['stocks', 'etf']);
  assert.equal(quotes.length, 1);
  assert.equal(quotes[0].symbol, 'SPY');
});

test('runtime wires the quote fallback so every call site benefits', async () => {
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('finance.yahoo.com')) return new Response('Too Many Requests', { status: 429 });
    if (url.includes('api.nasdaq.com')) return jsonRes(NASDAQ_INFO);
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;

  const rt = new TradingRuntime({ dbPath: ':memory:', workers: false, fetchImpl });
  try {
    assert.equal(typeof rt.provider.quoteFallback, 'function', 'fallback must be wired on the shared provider');
    const quotes = await rt.provider.getQuotes(['AAPL']);
    assert.equal(quotes.length, 1, 'positions still get marked when Yahoo is throttled');
    assert.equal(quotes[0].provider, 'nasdaq');
  } finally {
    rt.stop();
  }
});