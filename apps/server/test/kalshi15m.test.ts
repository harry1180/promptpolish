/**
 * KXBTC15M core: window lifecycle, fee model and order book.
 *
 * Every book assertion runs against REAL frames captured from Kalshi's
 * production websocket on 2026-11-20 (test/fixtures/kalshi15m/) — the
 * parsers are pinned to what the exchange actually sends, not to what the
 * docs implied.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  eventOfMarket, isCurrentWindow, msToClose, parseEventTicker, phaseAt,
  etToUtc, windowFromEventTicker, windowFromRest, windowProgress,
  FINAL_MINUTE_MS, WINDOW_MS,
} from '../src/kalshi15m/lifecycle.ts';
import {
  KXBTC15M_FEES, breakevenWinProbability, makerFee, roundTripCost, takerFee,
} from '../src/kalshi15m/fee.ts';
import { KalshiBook, type TradePrint } from '../src/kalshi15m/book.ts';

const FIX = new URL('./fixtures/kalshi15m/', import.meta.url);
function frame(kind: string, i = 0): Record<string, any> {
  const lines = readFileSync(new URL(`${kind}.jsonl`, FIX), 'utf8').trim().split('\n');
  return JSON.parse(lines[Math.min(i, lines.length - 1)]);
}

/* ------------------------------------------------------------------ */
/* lifecycle                                                           */
/* ------------------------------------------------------------------ */

test('event ticker encodes the CLOSE time in US-Eastern (EST and EDT)', () => {
  const nov = parseEventTicker('KXBTC15M-26NOV201545');
  assert.ok(nov);
  assert.equal(nov.series, 'KXBTC15M');
  assert.deepEqual([nov.year, nov.month, nov.day, nov.hour, nov.minute], [2026, 11, 20, 15, 45]);
  // 15:45 EST = 20:45 UTC (verified against the live REST market today)
  assert.equal(etToUtc(2026, 11, 20, 15, 45), Date.parse('2026-11-20T20:45:00Z'));
  // October is EDT: 12:15 EDT = 16:15 UTC (the 26OCT201215 example)
  assert.equal(etToUtc(2026, 10, 20, 12, 15), Date.parse('2026-10-20T16:15:00Z'));
});

test('window = close - 15min .. close; market ticker maps to its event', () => {
  const b = windowFromEventTicker('KXBTC15M-26NOV201545');
  assert.ok(b);
  assert.equal(b.source, 'TICKER');
  assert.equal(b.openTs, Date.parse('2026-11-20T20:30:00Z'));
  assert.equal(b.closeTs, Date.parse('2026-11-20T20:45:00Z'));
  assert.equal(b.closeTs - b.openTs, WINDOW_MS);
  assert.equal(eventOfMarket('KXBTC15M-26NOV201545-45'), 'KXBTC15M-26NOV201545');
  assert.equal(eventOfMarket('KXBTC15M-26NOV201545'), 'KXBTC15M-26NOV201545');
  assert.equal(parseEventTicker('nope'), null);
  assert.equal(parseEventTicker('KXBTC15M-26XYZ201545'), null, 'unknown month -> null');
  assert.equal(windowFromEventTicker('garbage'), null);
});

test('REST timestamps always beat the ticker parse (authoritative source)', () => {
  const rest = windowFromRest('KXBTC15M-26NOV201545-45', {
    open_time: '2026-11-20T20:30:00Z',
    close_time: '2026-11-20T20:45:00Z',
    expected_expiration_time: '2026-11-20T20:50:00Z',
  });
  assert.ok(rest);
  assert.equal(rest.source, 'REST');
  assert.equal(rest.expireTs, Date.parse('2026-11-20T20:50:00Z'));
  // missing REST fields -> ticker fallback, never a guess
  const fallback = windowFromRest('KXBTC15M-26NOV201545-45', {});
  assert.equal(fallback?.source, 'TICKER');
  // unusable REST values must not win
  assert.equal(windowFromRest('KXBTC15M-26NOV201545-45', {
    open_time: '2026-11-20T21:00:00Z', close_time: '2026-11-20T20:45:00Z',
  })?.source, 'TICKER');
});

test('phases: OPEN -> FINAL_MINUTE -> SETTLING -> EXPIRED, boundaries exact', () => {
  const b = {
    openTs: Date.parse('2026-11-20T20:30:00Z'),
    closeTs: Date.parse('2026-11-20T20:45:00Z'),
    expireTs: Date.parse('2026-11-20T20:50:00Z'),
    source: 'REST' as const,
  };
  assert.equal(phaseAt(b, b.openTs - 1), 'PRE_OPEN');
  assert.equal(phaseAt(b, b.openTs), 'OPEN');
  assert.equal(phaseAt(b, b.closeTs - FINAL_MINUTE_MS - 1), 'OPEN');
  assert.equal(phaseAt(b, b.closeTs - FINAL_MINUTE_MS), 'FINAL_MINUTE');
  assert.equal(phaseAt(b, b.closeTs - 1), 'FINAL_MINUTE');
  assert.equal(phaseAt(b, b.closeTs), 'SETTLING');
  assert.equal(phaseAt(b, b.expireTs - 1), 'SETTLING');
  assert.equal(phaseAt(b, b.expireTs), 'EXPIRED');
  assert.equal(msToClose(b, b.openTs), 15 * 60_000);
  assert.equal(msToClose(b, b.closeTs + 1_000), -1_000);
  assert.equal(Math.round(windowProgress(b, b.openTs) * 1000), 0);
  assert.equal(Math.round(windowProgress(b, b.closeTs) * 1000), 1000);
  assert.ok(isCurrentWindow(b, b.closeTs + 60_000), 'still current while settling');
  assert.ok(!isCurrentWindow(b, b.openTs - 1));
});

/* ------------------------------------------------------------------ */
/* fees — numbers cross-checked against Kalshi's published table        */
/* ------------------------------------------------------------------ */

test('taker fee matches the published table (1 and 100 contracts)', () => {
  assert.equal(takerFee(1, 0.5).fee, 0.0175);            // 1.75¢
  assert.equal(takerFee(100, 0.5).fee, 1.75);            // $1.75
  assert.equal(takerFee(1, 0.95).fee, 0.0034);           // 0.34¢ (centicent ceiling)
  assert.equal(takerFee(1, 0.99).fee, 0.0007);           // 0.07¢
  assert.equal(takerFee(100, 0.9).fee, 0.63);            // $0.63
  assert.equal(takerFee(1, 0.5).perContract, 0.0175);
});

test('KXBTC15M charges makers nothing; a maker-fee series does', () => {
  assert.equal(KXBTC15M_FEES.makerMultiplier, null, 'quadratic = takers only');
  assert.equal(makerFee(100, 0.5).fee, 0);
  const withMaker = { feeType: 'quadratic_with_maker_fees', takerMultiplier: 1, makerMultiplier: 1 };
  assert.equal(makerFee(100, 0.5, withMaker).fee, 0.4375, '0.0175 * 100 * 0.25');
});

test('round-trip cost is entry+exit fees + the spread actually paid', () => {
  const c = roundTripCost({ contracts: 10, entryPrice: 0.5, exitPrice: 0.49 });
  // taker in (1.75¢/c), taker out at 0.49 (1.7475¢ -> 1.75¢ ceiling), 1¢ spread
  assert.ok(c.entryFee > 0 && c.exitFee > 0);
  assert.equal(c.spread, 0.01);
  assert.ok(Math.abs(c.totalCents - (c.entryFee / 10 + c.exitFee / 10 + 0.01) * 100) < 1e-9);
  // maker exit removes the exit fee — the whole point of passive exits
  const m = roundTripCost({ contracts: 10, entryPrice: 0.5, exitPrice: 0.49, exitIsTaker: false });
  assert.equal(m.exitFee, 0);
  assert.ok(m.total < c.total);
});

test('breakeven: a 95¢ taker entry needs >95¢ of win probability', () => {
  const be = breakevenWinProbability(0.95);
  assert.ok(be);
  assert.ok(be > 0.95 && be < 0.96);
  assert.equal(breakevenWinProbability(0.5), 0.5175);
  assert.equal(breakevenWinProbability(1), null);
  assert.equal(breakevenWinProbability(0), null);
});

/* ------------------------------------------------------------------ */
/* order book — against captured production frames                      */
/* ------------------------------------------------------------------ */

test('snapshot parses into a YES-view book (NO bids become YES asks)', () => {
  const f = frame('orderbook_snapshot');
  const book = new KalshiBook(f.msg.market_ticker);
  const res = book.applySnapshot({ ...f.msg, sid: f.sid, seq: f.seq });
  assert.equal(res.applied, true);
  assert.equal(book.needsSnapshot, false);
  assert.equal(book.seq, null, 'snapshot re-arms sequencing lazily (next delta arms it)');

  const m = book.metrics({ now: Date.now() });
  // pinned from the captured frame: best yes bid 0.43, best no bid 0.56
  assert.equal(m.bestBid, 0.43);
  assert.equal(m.bestAsk, 0.44, 'YES ask = 1 - best NO bid, exact (no float drift)');
  assert.equal(m.spread, 0.01);
  assert.equal(m.bestBidSize, 8133.56);
  assert.equal(m.bestAskSize, 3087.8);
  assert.deepEqual(m.levels, { bids: 133, asks: 146 });
  // top-5 depth sums (real resting size, not a model)
  const expImbalance = (27270.77 - 22890.93) / (27270.77 + 22890.93);
  assert.ok(m.imbalance !== null && Math.abs(m.imbalance - expImbalance) < 1e-9,
    `imbalance ${m.imbalance} vs ${expImbalance}`);
  const d = book.depth(5);
  assert.equal(d.bids[0].price, 0.43);
  assert.equal(d.asks[0].price, 0.44);
  for (let i = 1; i < d.asks.length; i++) {
    assert.ok(d.asks[i].price >= d.asks[i - 1].price, 'asks sorted ascending');
  }
});

test('deltas apply in sequence; a seq jump marks the book untrusted', () => {
  const f = frame('orderbook_snapshot');
  const book = new KalshiBook(f.msg.market_ticker);
  book.applySnapshot({ ...f.msg, sid: f.sid, seq: f.seq });

  for (let i = 0; i < 6; i++) {
    const d = frame('orderbook_delta', i);
    const r = book.applyDelta({ ...d.msg, sid: d.sid, seq: d.seq });
    assert.equal(r.applied, true, `delta ${d.seq} must apply: ${r.reason ?? ''}`);
    assert.equal(r.gap, false);
  }
  assert.equal(book.seq, 7);
  // +500 contracts lifted onto the 0.43 bid
  assert.equal(book.metrics().bestBidSize, 8133.56 + 500);
  // no side: -30.77 then +202 at 0.56
  assert.equal(book.metrics().bestAskSize, 3087.8 - 30.77 + 202);

  const jump = book.applyDelta({ market_ticker: f.msg.market_ticker, sid: f.sid, seq: 99,
    side: 'yes', price_dollars: '0.4300', delta_fp: '10' });
  assert.equal(jump.gap, true, 'seq jump must be detected');
  assert.equal(jump.applied, false);
  assert.equal(book.needsSnapshot, true, 'book refuses deltas until a fresh snapshot');
  const refused = book.applyDelta({ market_ticker: f.msg.market_ticker, sid: f.sid, seq: 100,
    side: 'yes', price_dollars: '0.4300', delta_fp: '10' });
  assert.equal(refused.applied, false);
  // a fresh snapshot re-arms it
  book.applySnapshot({ ...f.msg, sid: f.sid, seq: 1 });
  assert.equal(book.needsSnapshot, false);
});

test('foreign markets and junk frames are refused, never merged', () => {
  const f = frame('orderbook_snapshot');
  const book = new KalshiBook('KXBTC15M-OTHER');
  assert.equal(book.applySnapshot({ ...f.msg, sid: f.sid, seq: f.seq }).applied, false);
  assert.equal(book.isEmpty, true);
  assert.equal(book.applyDelta({ market_ticker: 'KXBTC15M-OTHER', side: 'yes',
    price_dollars: 'x', delta_fp: '1' }).applied, false, 'bad price -> refuse');
  assert.equal(book.applyDelta({ market_ticker: 'KXBTC15M-OTHER', side: 'weird',
    price_dollars: '0.5', delta_fp: '1' }).applied, false, 'bad side -> refuse');
});

test('trades feed intensity and taker bias; other venues\' prints ignored by runtime filter', () => {
  const f = frame('orderbook_snapshot');
  const book = new KalshiBook(f.msg.market_ticker);
  book.applySnapshot({ ...f.msg, sid: f.sid, seq: f.seq });
  const now = Date.now();
  for (let i = 0; i < 6; i++) {
    const t = frame('trade', i);
    if (t.msg.market_ticker !== f.msg.market_ticker) continue; // runtime filters this
    const print: TradePrint = {
      tradeId: t.msg.trade_id, tsMs: now - 5,
      yesPrice: Number(t.msg.yes_price_dollars), noPrice: Number(t.msg.no_price_dollars),
      qty: Number(t.msg.count_fp), takerSide: String(t.msg.taker_side),
      takerBookSide: String(t.msg.taker_book_side ?? ''),
    };
    book.addTrade(print, now);
  }
  const m = book.metrics({ now });
  assert.equal(m.trades1s, 2, 'only this market\'s prints count');
  assert.ok(Math.abs(m.qty1s - (30.77 + 13.72)) < 1e-9);
  assert.equal(m.takerBias60s, 1, 'both prints lifted YES');
  assert.equal(m.trades5s, 2);
});

test('depth walk prices a real market order; impossible size returns null', () => {
  const f = frame('orderbook_snapshot');
  const book = new KalshiBook(f.msg.market_ticker);
  book.applySnapshot({ ...f.msg, sid: f.sid, seq: f.seq });
  const buy10 = book.walkPrice('BUY', 10);
  assert.ok(buy10);
  assert.ok(buy10 >= 0.44 && buy10 <= 0.45, `walk should start at the 0.44 ask, got ${buy10}`);
  const sell10 = book.walkPrice('SELL', 10);
  assert.ok(sell10);
  assert.ok(sell10 <= 0.43 && sell10 > 0.42, `walk should start at the 0.43 bid, got ${sell10}`);
  assert.equal(book.walkPrice('BUY', 10_000_000), null, 'unfillable size -> null, never a price');
  assert.equal(book.walkPrice('BUY', 0), null);
  const m = book.metrics({ walkQty: 10 });
  assert.equal(m.askDepthWalk, buy10);
  assert.equal(m.bidDepthWalk, sell10);
});

test('flow/cancel counters reset with the sample window', () => {
  const f = frame('orderbook_snapshot');
  const book = new KalshiBook(f.msg.market_ticker);
  book.applySnapshot({ ...f.msg, sid: f.sid, seq: f.seq });
  for (let i = 0; i < 6; i++) {
    const d = frame('orderbook_delta', i);
    book.applyDelta({ ...d.msg, sid: d.sid, seq: d.seq });
  }
  let m = book.metrics();
  assert.equal(m.deltasInWindow, 6);
  assert.equal(m.cancelRatio, 2 / 6, 'two of the six captured deltas removed size');
  assert.ok(m.ofi !== null, 'near-touch flow seen -> ofi defined');
  book.endSampleWindow();
  m = book.metrics();
  assert.equal(m.deltasInWindow, 0);
  assert.equal(m.cancelRatio, null, 'empty window is null, not 0');
  assert.equal(m.ofi, null);
});