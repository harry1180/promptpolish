import { describe, expect, it } from 'vitest';
import { checkExit, simulateFill } from '../src/broker.ts';
import type { ExitPosition } from '../src/broker.ts';
import type { Quote } from '../src/types.ts';

function quote(price: number): Quote {
  return { symbol: 'AAA', price, prevClose: price, ts: 1_700_000_000_000 };
}

describe('simulateFill', () => {
  it('BUY never fills below quote, SELL never above', () => {
    for (const liquidity of [0.1, 0.5, 0.9]) {
      const buy = simulateFill({ side: 'BUY', qty: 500, quote: quote(100), session: 'MARKET_OPEN', fillMode: 'AT_SIGNAL', liquidityScore: liquidity, nowMs: 0 });
      const sell = simulateFill({ side: 'SELL', qty: 500, quote: quote(100), session: 'MARKET_OPEN', fillMode: 'AT_SIGNAL', liquidityScore: liquidity, nowMs: 0 });
      expect(buy.filled).toBe(true);
      expect(buy.price).toBeGreaterThanOrEqual(100);
      expect(sell.filled).toBe(true);
      expect(sell.price).toBeLessThanOrEqual(100);
      expect(buy.notional).toBeCloseTo(buy.price * 500, 9);
    }
  });

  it('lower liquidity produces more slippage than higher liquidity', () => {
    const thin = simulateFill({ side: 'BUY', qty: 500, quote: quote(100), session: 'MARKET_OPEN', fillMode: 'AT_SIGNAL', liquidityScore: 0.1, nowMs: 0 });
    const deep = simulateFill({ side: 'BUY', qty: 500, quote: quote(100), session: 'MARKET_OPEN', fillMode: 'AT_SIGNAL', liquidityScore: 0.9, nowMs: 0 });
    expect(thin.slippage).toBeGreaterThan(deep.slippage);
    expect(thin.price).toBeGreaterThan(deep.price);
    expect(deep.slippage).toBeGreaterThan(0);
    // total slippage capped at 60 bps even for enormous size in the thinnest tape
    const huge = simulateFill({ side: 'BUY', qty: 1e9, quote: quote(100), session: 'MARKET_OPEN', fillMode: 'AT_SIGNAL', liquidityScore: 0.01, nowMs: 0 });
    expect(huge.slippage).toBeLessThanOrEqual(0.006);
    expect(huge.price).toBeGreaterThanOrEqual(100);
  });

  it('extended-hours sessions add 4 bps vs the regular session', () => {
    const open = simulateFill({ side: 'BUY', qty: 500, quote: quote(100), session: 'MARKET_OPEN', fillMode: 'AT_SIGNAL', liquidityScore: 0.5, nowMs: 0 });
    const pre = simulateFill({ side: 'BUY', qty: 500, quote: quote(100), session: 'PREMARKET', fillMode: 'AT_SIGNAL', liquidityScore: 0.5, nowMs: 0 });
    const post = simulateFill({ side: 'BUY', qty: 500, quote: quote(100), session: 'POSTMARKET', fillMode: 'AT_SIGNAL', liquidityScore: 0.5, nowMs: 0 });
    expect(pre.slippage).toBeGreaterThan(open.slippage);
    expect(post.slippage).toBeGreaterThan(open.slippage);
    expect(pre.slippage).toBeCloseTo(open.slippage + 0.0004, 12);
    expect(post.note).toContain('postmarket');
  });

  it('closed market: AT_SIGNAL fills at last price with 5 bps and the closed note', () => {
    for (const session of ['MARKET_CLOSED', 'WEEKEND', 'HOLIDAY'] as const) {
      const fill = simulateFill({ side: 'BUY', qty: 100, quote: quote(100), session, fillMode: 'AT_SIGNAL', liquidityScore: 0.8, nowMs: 123 });
      expect(fill.filled).toBe(true);
      expect(fill.price).toBe(100);
      expect(fill.slippage).toBeCloseTo(0.0005, 12);
      expect(fill.notional).toBe(10_000);
      expect(fill.note).toBe('filled at last available price while market closed');
    }
  });

  it('NEXT_OPEN without a next-open price queues with pendingUntil', () => {
    const fill = simulateFill({ side: 'BUY', qty: 100, quote: quote(100), session: 'MARKET_CLOSED', fillMode: 'NEXT_OPEN', liquidityScore: 0.8, nowMs: 4_567 });
    expect(fill.filled).toBe(false);
    expect(fill.price).toBe(0);
    expect(fill.slippage).toBe(0);
    expect(fill.notional).toBe(0);
    expect(fill.pendingUntil).toBe(4_567);
    expect(fill.note).toBe('queued for next session open');
  });

  it('NEXT_OPEN with a price fills exactly there with 3 bps and a gap note', () => {
    const up = simulateFill({ side: 'BUY', qty: 100, quote: quote(100), session: 'MARKET_CLOSED', fillMode: 'NEXT_OPEN', liquidityScore: 0.8, nowMs: 0, nextOpenPrice: 101 });
    expect(up.filled).toBe(true);
    expect(up.price).toBe(101);
    expect(up.slippage).toBeCloseTo(0.0003, 12);
    expect(up.notional).toBe(10_100);
    expect(up.note).toContain('gap up');
    expect(up.note).toContain('1.00%');
    expect(up.pendingUntil).toBeUndefined();
    const down = simulateFill({ side: 'SELL', qty: 100, quote: quote(100), session: 'MARKET_CLOSED', fillMode: 'NEXT_OPEN', liquidityScore: 0.8, nowMs: 0, nextOpenPrice: 98 });
    expect(down.price).toBe(98);
    expect(down.note).toContain('gap down');
  });

  it('rejects non-positive qty or liquidity', () => {
    const noQty = simulateFill({ side: 'BUY', qty: 0, quote: quote(100), session: 'MARKET_OPEN', fillMode: 'AT_SIGNAL', liquidityScore: 0.9, nowMs: 0 });
    expect(noQty).toEqual({ filled: false, price: 0, slippage: 0, notional: 0, note: 'rejected' });
    const noLiq = simulateFill({ side: 'BUY', qty: 10, quote: quote(100), session: 'MARKET_OPEN', fillMode: 'AT_SIGNAL', liquidityScore: 0, nowMs: 0 });
    expect(noLiq.note).toBe('rejected');
  });
});

function position(overrides: Partial<ExitPosition> = {}): ExitPosition {
  return {
    side: 'LONG',
    entryPrice: 100,
    qty: 100,
    target: 120,
    stop: 95,
    trailingStop: null,
    maxHoldSessions: 10,
    sessionsHeld: 0,
    thesisInvalidated: false,
    sellSignal: false,
    regimeChanged: false,
    ...overrides,
  };
}

describe('checkExit', () => {
  it('stop triggers even when the open gaps below it', () => {
    const reason = checkExit(position(), { date: '2026-06-15', open: 90, high: 94, low: 88, close: 92 });
    expect(reason).toBe('STOP_REACHED');
    const mild: typeof reason = checkExit(position(), { date: '2026-06-15', open: 96, high: 97, low: 94.5, close: 96 });
    expect(mild).toBe('STOP_REACHED');
  });

  it('a bar through BOTH stop and target exits on the stop (conservative)', () => {
    const reason = checkExit(position(), { date: '2026-06-15', open: 100, high: 125, low: 90, close: 110 });
    expect(reason).toBe('STOP_REACHED');
  });

  it('target alone triggers TARGET_REACHED', () => {
    const reason = checkExit(position(), { date: '2026-06-15', open: 100, high: 121, low: 99, close: 118 });
    expect(reason).toBe('TARGET_REACHED');
  });

  it('flags, time limit and trailing stop follow the documented priority', () => {
    const bar = { date: '2026-06-15', open: 100, high: 110, low: 99, close: 105 };
    expect(checkExit(position({ thesisInvalidated: true }), bar)).toBe('THESIS_INVALIDATED');
    expect(checkExit(position({ sellSignal: true }), bar)).toBe('SELL_SIGNAL');
    expect(checkExit(position({ regimeChanged: true }), bar)).toBe('REGIME_CHANGE');
    expect(checkExit(position({ sessionsHeld: 10, maxHoldSessions: 10, trailingStop: 97 }), bar)).toBe('TIME_LIMIT');
    expect(checkExit(position({ sessionsHeld: 9, trailingStop: 99.5 }), bar)).toBe('TRAILING_STOP');
    expect(checkExit(position({ sessionsHeld: 3 }), bar)).toBeNull();
    // flags beat the time limit
    expect(checkExit(position({ sessionsHeld: 20, thesisInvalidated: true }), bar)).toBe('THESIS_INVALIDATED');
    // stop beats an invalidated flag
    expect(checkExit(position({ thesisInvalidated: true }), { date: '2026-06-15', open: 94, high: 95, low: 93, close: 94 })).toBe('STOP_REACHED');
  });
});