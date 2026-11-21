/**
 * STRATEGY A (cross-exchange lead/lag) — the gates, the cost model and the
 * shadow discipline: every path returns a verdict with reasons, nothing
 * places an order, and nothing looks at data outside the inputs it was given.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  evaluateLeadLag, leadLagConfigFromEnv, type LeadLagConfig, type LeadLagInput,
} from '../src/kalshi15m/strategies.ts';
import { ensureK15mTables, insertSignal, recentSignals, signalSummary } from '../src/kalshi15m/store.ts';

const T0 = Date.parse('2026-11-20T20:00:00Z');
const CFG: LeadLagConfig = leadLagConfigFromEnv({});

function input(over: Partial<LeadLagInput> = {}): LeadLagInput {
  return {
    cfg: CFG,
    now: T0,
    tauSec: 300,
    strike: 59_000,
    // +3.4 bps up-move over the lag, book unmoved
    spotNow: 59_000,
    spotLag: 58_980,
    midNow: 0.5,
    midLag: 0.5,
    venuesAgree: true,
    sigmaPerSec: 0.0004,
    yesBid: 0.49,
    yesAsk: 0.51,
    ...over,
  };
}

test('config: Strategy A is OFF by default with conservative thresholds', () => {
  const c = leadLagConfigFromEnv({});
  assert.equal(c.enabled, false, 'never on unless asked');
  assert.equal(c.lagSec, 3);
  assert.equal(c.moveBps, 1.5);
  assert.equal(c.requireAgreement, true, 'agreement gate defaults ON');
  assert.equal(c.minNetPp, 2, "the spec's 2 cents net target");
  assert.equal(c.bufferPp, 1, 'safety buffer on top of costs');
  assert.equal(c.minTauSec, 15, 'stay out of the settlement minute');
  const on = leadLagConfigFromEnv({
    KALSHI15M_STRAT_A: '1', KALSHI15M_A_MOVE_BPS: '3', KALSHI15M_A_AGREEMENT: '0',
  });
  assert.equal(on.enabled, true);
  assert.equal(on.moveBps, 3);
  assert.equal(on.requireAgreement, false, 'gate can be turned off explicitly');
});

test('gates fire in order and each one names its own reason', () => {
  assert.equal(evaluateLeadLag(input({ tauSec: null })).skipReason, 'no_tau');
  assert.equal(evaluateLeadLag(input({ tauSec: 10 })).skipReason, 'too_close_to_settlement');
  assert.equal(evaluateLeadLag(input({ strike: null })).skipReason, 'no_strike');
  assert.equal(evaluateLeadLag(input({ sigmaPerSec: null })).skipReason, 'no_sigma');
  assert.equal(evaluateLeadLag(input({ spotLag: null })).skipReason, 'no_spot_history');
  assert.equal(evaluateLeadLag(input({ midLag: null })).skipReason, 'no_mid_history');
  assert.equal(evaluateLeadLag(input({ yesBid: 0.51, yesAsk: 0.49 })).skipReason, 'no_executable_book');
  assert.equal(evaluateLeadLag(input({ yesBid: 0, yesAsk: 0.5 })).skipReason, 'no_executable_book');
  // small move and disagreement are checked AFTER the data gates
  assert.equal(evaluateLeadLag(input({ spotNow: 58_980.5 })).skipReason, 'move_too_small');
  assert.equal(
    evaluateLeadLag(input({ spotNow: 59_000, spotLag: 58_900, venuesAgree: false })).skipReason,
    'venue_disagreement',
  );
  const v = evaluateLeadLag(input({ tauSec: 10 }));
  assert.equal(v.verdict, 'SKIP');
  assert.ok(v.reasons.length > 0, 'every skip still explains what it saw');
});

test('cost gate: a real move the book has not repriced is still refused when costs exceed it', () => {
  const v = evaluateLeadLag(input()); // +3.4bps, book still at 0.50
  assert.equal(v.verdict, 'SKIP');
  assert.equal(v.skipReason, 'edge_below_cost');
  assert.equal(v.side, 'YES', 'direction is still reported for the record');
  assert.ok((v.expectedMovePp ?? 0) > 0, 'the spot move implies a positive repricing');
  assert.ok((v.remainingPp ?? 0) > 0);
  assert.ok((v.costPp ?? 0) > 4, `spread 2c + two taker fees ~5.5c at 50c, got ${v.costPp}`);
  assert.ok((v.netPp ?? 0) < 0);
  assert.ok(v.reasons.some((r) => r.startsWith('cost=')), 'costs are spelled out');
});

test('a large unrepriced move clears cost + buffer + target and is TRADEd (shadow)', () => {
  const v = evaluateLeadLag(input({
    spotNow: 59_300, spotLag: 59_000, // +50 bps
    midNow: 0.5, midLag: 0.5,          // book has not moved at all
    yesBid: 0.495, yesAsk: 0.505,       // tight book -> cheaper round trip
  }));
  assert.equal(v.verdict, 'TRADE');
  assert.equal(v.side, 'YES');
  assert.ok((v.expectedMovePp ?? 0) > 20, `big move implies a big repricing: ${v.expectedMovePp}`);
  assert.equal(v.repricedPp, 0, 'the mid has not moved yet');
  assert.ok((v.remainingPp ?? 0) > 20);
  assert.ok((v.netPp ?? 0) >= CFG.minNetPp, `net ${v.netPp} must clear the ${CFG.minNetPp}c target`);
  assert.equal(v.skipReason, null);
});

test('an already-repriced move earns nothing — the lag is the trade, not the move', () => {
  const v = evaluateLeadLag(input({
    spotNow: 59_300, spotLag: 59_000,
    midNow: 0.78, midLag: 0.5, // the book already did the whole move
    yesBid: 0.775, yesAsk: 0.785,
  }));
  assert.equal(v.verdict, 'SKIP');
  assert.equal(v.skipReason, 'edge_below_cost');
  assert.ok((v.remainingPp ?? 99) < 3, `almost nothing left to capture: ${v.remainingPp}`);
});

test('the NO side is symmetric: a down-move with a stale book is a NO candidate', () => {
  const v = evaluateLeadLag(input({
    spotNow: 58_700, spotLag: 59_000, // −50 bps
    midNow: 0.5, midLag: 0.5,
    yesBid: 0.495, yesAsk: 0.505,
  }));
  assert.equal(v.verdict, 'TRADE');
  assert.equal(v.side, 'NO');
  assert.ok((v.expectedMovePp ?? 0) < 0, 'the implied YES repricing is negative');
  assert.ok((v.netPp ?? 0) >= CFG.minNetPp, `NO-side net ${v.netPp}`);
  // cost of the NO side uses NO prices (1-bid / 1-ask), still positive
  assert.ok((v.costPp ?? 0) > 0);
});

test('the agreement gate can be relaxed explicitly, and then disagreement trades', () => {
  const strict = evaluateLeadLag(input({
    spotNow: 59_300, spotLag: 59_000, venuesAgree: false,
    yesBid: 0.495, yesAsk: 0.505,
  }));
  assert.equal(strict.skipReason, 'venue_disagreement');
  const loose = evaluateLeadLag(input({
    spotNow: 59_300, spotLag: 59_000, venuesAgree: false,
    yesBid: 0.495, yesAsk: 0.505,
    cfg: { ...CFG, requireAgreement: false },
  }));
  assert.equal(loose.verdict, 'TRADE');
});

test('shadow storage: every verdict lands with its reasons, and the summary counts them', () => {
  const db = new DatabaseSync(':memory:');
  ensureK15mTables(db);
  const market = 'KXBTC15M-26NOV201700-00';
  const base = {
    ts: T0, marketTicker: market, eventTicker: 'KXBTC15M-26NOV201700',
    strategy: 'A_LEADLAG', tauSec: 300, strike: 59_000, sigma: 0.0004,
    spotNow: 59_000, spotLag: 58_980, midNow: 0.5, midLag: 0.5, moveBps: 3.4,
    agree: true, reasons: 'tau=300.0s | spot_move=3.40bps', phase: 'OPEN',
  };
  const traded = evaluateLeadLag(input({
    spotNow: 59_300, spotLag: 59_000, yesBid: 0.495, yesAsk: 0.505,
  }));
  const skipped = evaluateLeadLag(input());
  const id1 = insertSignal(db, {
    ...base, ts: T0, verdict: traded.verdict, side: traded.side,
    expectedMovePp: traded.expectedMovePp, repricedPp: traded.repricedPp,
    remainingPp: traded.remainingPp, costPp: traded.costPp, netPp: traded.netPp,
    skipReason: traded.skipReason, reasons: traded.reasons.join(' | '),
  });
  const id2 = insertSignal(db, {
    ...base, ts: T0 + 1_000, verdict: skipped.verdict, side: skipped.side,
    expectedMovePp: skipped.expectedMovePp, repricedPp: skipped.repricedPp,
    remainingPp: skipped.remainingPp, costPp: skipped.costPp, netPp: skipped.netPp,
    skipReason: skipped.skipReason, reasons: skipped.reasons.join(' | '),
  });
  assert.ok(id1 > 0 && id2 > 0, 'both rows written');

  const rows = recentSignals(db, 10);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].verdict, 'SKIP', 'newest first');
  assert.ok(String(rows[0].skip_reason).length > 0, 'the reason survives storage');
  assert.equal(rows[1].side, 'YES');
  assert.ok(String(rows[1].reasons).includes('side=YES'));

  const sum = signalSummary(db, 100) as {
    window: { rows: number }; trades: number; skips: number;
    bySide: Record<string, number>; bySkipReason: Record<string, number>;
    tradeNetPpMedian: number | null; note: string;
  };
  assert.equal(sum.window.rows, 2);
  assert.equal(sum.trades, 1);
  assert.equal(sum.skips, 1);
  assert.equal(sum.bySide.YES, 1);
  assert.ok(sum.bySkipReason.edge_below_cost === 1, 'skip reasons are bucketed');
  assert.ok(sum.tradeNetPpMedian !== null && sum.tradeNetPpMedian >= 2);
  assert.match(sum.note, /SHADOW ONLY/);

  const filtered = recentSignals(db, 10, 'A_LEADLAG');
  assert.equal(filtered.length, 2, 'filterable by strategy');
  db.close();
});