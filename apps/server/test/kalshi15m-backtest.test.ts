/**
 * Backtester: chronological replay of the recorded tape through the SAME
 * strategy functions production runs, with both exit modes and the honesty
 * rules (no look-ahead, no invented fills, no scoring without an outcome).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  backtestConfigFromEnv, runBacktest, type BacktestConfig,
} from '../src/kalshi15m/backtest.ts';
import { deriveSettlement } from '../src/kalshi15m/runtime.ts';
import { ensureK15mTables } from '../src/kalshi15m/store.ts';

const T0 = Date.parse('2026-11-20T20:00:00Z');
const MKT = 'KXBTC15M-26NOV201700-00';

const CFG: BacktestConfig = {
  strategies: ['F_MAKER'],
  holdSec: 10,
  evalMs: 60_000, // one evaluation per window in these fixtures
  trainShare: 0.5,
  validationShare: 0.25,
  maxSamplesPerWindow: 4_000,
};

function addWindow(db: DatabaseSync, event: string, openTs: number, result: string | null): void {
  db.prepare(
    `INSERT INTO k15m_windows (event_ticker, market_ticker, open_ts, close_ts, strike,
       settled_result, first_seen_ts, updated_ts, status, phase)
     VALUES (?,?,?,?,?,?,'','','settled','OPEN')`,
  ).run(event, MKT, openTs, openTs + 900_000, 59_000, result);
}

function addSample(db: DatabaseSync, event: string, ts: number, over: Partial<Record<string, number>> = {}): void {
  const bid = over.bid ?? 0.4;
  const ask = over.ask ?? 0.41;
  db.prepare(
    `INSERT INTO k15m_book_samples (ts, market_ticker, event_ticker, phase, ms_to_close,
       yes_bid, yes_ask, micro, imbalance, ofi, taker_bias_60s, needs_snapshot,
       spot_mid, fair_spot, fair_sigma, fair_yes, implied_mid)
     VALUES (?,?,?,'OPEN',?,?,?,?,?,?,?,0,?,?,?,?,?)`,
  ).run(
    ts, MKT, event, over.msToClose ?? 300_000,
    bid, ask, over.micro ?? (bid + ask) / 2, over.imbalance ?? 0.3, over.ofi ?? 0.4,
    over.takerBias ?? 0.5, over.spotMid ?? 59_000, over.spot ?? 59_000,
    over.sigma ?? 4e-4, over.pYes ?? 0.6, over.mid ?? null,
  );
}

test('config: backtest knobs are safe defaults, strategies default to all six', () => {
  const c = backtestConfigFromEnv({});
  assert.deepEqual(c.strategies, [], 'empty = replay everything');
  assert.equal(c.holdSec, 10);
  assert.equal(c.evalMs, 1_000);
  assert.equal(c.trainShare, 0.6);
  assert.equal(c.validationShare, 0.2);
  const custom = backtestConfigFromEnv({
    KALSHI15M_BT_STRATEGIES: 'A_LEADLAG,F_MAKER', KALSHI15M_BT_HOLD_SEC: '20',
  });
  assert.deepEqual(custom.strategies, ['A_LEADLAG', 'F_MAKER']);
  assert.equal(custom.holdSec, 20);
});

test('backtester: settlement exit scores, missing outcome stays unscorable', () => {
  const db = new DatabaseSync(':memory:');
  ensureK15mTables(db);
  addWindow(db, 'EV1', T0, 'YES');          // has an official result
  addWindow(db, 'EV2', T0 + 900_000, null); // no result yet
  // one sample each: no later book exists, so EV1 must settle and EV2 must
  // NOT be scored at all (never a win, never a loss)
  addSample(db, 'EV1', T0 + 300_000);
  addSample(db, 'EV2', T0 + 1_200_000);

  const report = runBacktest(db, CFG);
  assert.equal(report.windows.total, 2);
  const f = report.byStrategy.F_MAKER;
  assert.ok(f, 'F replayed');
  assert.equal(f.evaluated, 2, 'one evaluation per window');
  assert.equal(f.taken, 2, 'the maker gate passes on both fixtures');
  assert.equal(report.totals.unscorable, 1, 'EV2 has neither an exit book nor a result');
  assert.equal(report.totals.scorable, 1);

  // EV1 settled YES: maker bought the 0.40 YES bid -> pays $1 -> +60c, no fee
  const train = f.bySplit.TRAIN;
  assert.equal(train.scorable, 1, 'chronological split puts EV1 in TRAIN');
  assert.equal(train.wins, 1);
  assert.ok(Math.abs((train.netPerContractPp ?? 0) - 60) < 1e-6, `net ${train.netPerContractPp}`);
  assert.equal(train.feesPp, 0, 'makers pay nothing on this series');
  assert.equal(train.winRatePct, 100);
  assert.ok(train.profitFactor === null || train.profitFactor > 0, 'reported honestly (no losses)');
  assert.ok((train.maxDrawdownPp ?? 0) >= 0);
  assert.ok((train.tailP5Pp ?? 0) <= (train.netPerContractPp ?? 0));

  // EV2 lands in VALIDATION with nothing to score
  const val = f.bySplit.VALIDATION;
  assert.equal(val.scorable, 0);
  assert.equal(val.unscorable, 1, 'explicitly unscorable, not zero-PnL');
  assert.equal(val.winRatePct, null, 'no rate without samples');
  db.close();
});

test('backtester: exit-at-hold uses the LATER book, never the entry book', () => {
  const db = new DatabaseSync(':memory:');
  ensureK15mTables(db);
  addWindow(db, 'EV3', T0, null);
  // entry book 0.40/0.41, then the book improves to 0.55/0.56 ten seconds later
  for (let i = 0; i < 20; i++) {
    addSample(db, 'EV3', T0 + 300_000 + i * 1_000, i === 10 ? { bid: 0.55, ask: 0.56 } : {});
  }
  const report = runBacktest(db, CFG);
  const f = report.byStrategy.F_MAKER;
  assert.equal(f.taken, 1, 'evalMs is 60s in this fixture -> a single evaluation');
  const t = f.bySplit.TEST.scorable + f.bySplit.TRAIN.scorable + f.bySplit.VALIDATION.scorable;
  assert.equal(t, 1, 'one trade scored');
  const m = f.bySplit.TEST.scorable ? f.bySplit.TEST : (f.bySplit.VALIDATION.scorable ? f.bySplit.VALIDATION : f.bySplit.TRAIN);
  assert.equal(m.scorable, 1);
  assert.ok(Math.abs((m.netPerContractPp ?? 0) - 16) < 1e-6,
    `maker: bought 0.40, sold 10s later at 0.56 -> +16c, got ${m.netPerContractPp}`);
  assert.ok(Math.abs((m.avgHoldSec ?? 0) - 10) < 1e-6, `hold is the real 10s, got ${m.avgHoldSec}`);
  assert.equal(m.feesPp, 0);
  db.close();
});

test('backtester: chronologically ordered splits, and a report that explains itself', () => {
  const db = new DatabaseSync(':memory:');
  ensureK15mTables(db);
  for (let i = 0; i < 4; i++) {
    addWindow(db, `EV${i}`, T0 + i * 900_000, i === 0 ? 'YES' : null);
    addSample(db, `EV${i}`, T0 + i * 900_000 + 300_000);
  }
  const report = runBacktest(db, CFG);
  // train = floor(4*0.5)=2 windows, val = 2 + max(1, floor(4*0.25))=3, rest test
  const f = report.byStrategy.F_MAKER;
  assert.equal(f.bySplit.TRAIN.scorable + f.bySplit.TRAIN.unscorable, 2, 'first two windows are TRAIN');
  assert.equal(f.bySplit.VALIDATION.scorable + f.bySplit.VALIDATION.unscorable, 1);
  assert.equal(f.bySplit.TEST.scorable + f.bySplit.TEST.unscorable, 1);
  assert.equal(report.notes.length >= 4, true, 'the report states its own assumptions');
  assert.ok(report.notes.some((n) => n.includes('ASSUMED')), 'fill assumptions disclosed');
  assert.ok(report.notes.some((n) => n.includes('never counted as a win or loss')), 'unscorable policy disclosed');
  assert.ok(report.notes.some((n) => n.includes('does not fit')), 'params are measured, not fitted');
  assert.equal(report.totals.scorable, 1, 'only the window with a result is scored');
  db.close();
});

test('deriveSettlement: Kalshi result wins, the rule derives, nothing is guessed', () => {
  const settled = deriveSettlement({
    result: 'yes', expiration_value: '58915.41', floor_strike: 58_928.04,
  });
  assert.deepEqual(settled, { result: 'YES', settleValue: 58_915.41, source: 'kalshi_result' });
  assert.equal(deriveSettlement({ result: 'NO', expiration_value: '1', floor_strike: 2 })?.result, 'NO');
  // no result string -> the official rule decides (close >= open average)
  assert.deepEqual(
    deriveSettlement({ result: '', expiration_value: '58915.41', floor_strike: 58_900 }),
    { result: 'YES', settleValue: 58_915.41, source: 'rule_derived' },
  );
  assert.equal(
    deriveSettlement({ result: '', expiration_value: '58900', floor_strike: 58_928.04 })?.result,
    'NO',
  );
  // tie resolves YES (the market's own rule)
  assert.equal(
    deriveSettlement({ result: '', expiration_value: '58928.04', floor_strike: 58_928.04 })?.result,
    'YES',
  );
  // nothing usable -> null, never a guessed outcome
  assert.equal(deriveSettlement({ result: '', expiration_value: '', floor_strike: 58_928.04 }), null);
  assert.equal(deriveSettlement({ result: '', expiration_value: '58915', floor_strike: undefined }), null);
});