/**
 * Daily/weekly review benchmark tests.
 *
 * The review is written right after the close, usually before the day's SPY
 * bar exists. It used to fall back to 0, which made the report say "SPY was
 * flat" and flipped the sign of excess return (2026-11-02 showed -0.04%
 * excess against a real -0.48% SPY move). Now: null while pending, correct
 * once the bar has landed, and the settle pass rewrites the row.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { openTradingDb } from '../src/tradingusa/schema.ts';
import { buildDailyReview, buildWeeklyReviewIfDue } from '../src/tradingusa/workers.ts';

const DAY = '2026-11-02';
const T1 = Date.parse('2026-11-01T21:00:00Z');
const T2 = Date.parse('2026-11-02T21:00:00Z');

function seedSnapshots(db: DatabaseSync): void {
  const stmt = db.prepare(
    `INSERT INTO portfolio_snapshots (portfolio, ts, equity, cash, realized, unrealized, exposure, benchmark_equity)
     VALUES (?,?,?,?,?,?,?,?)`,
  );
  // SHORT +0.5% between the two snapshots, LONG flat -> daily = +0.25%
  stmt.run('SHORT_TERM_PORTFOLIO', T1, 100000, 100000, 0, 0, 0, 100000);
  stmt.run('SHORT_TERM_PORTFOLIO', T2, 100500, 100500, 0, 0, 0, 100000);
  stmt.run('LONG_TERM_PORTFOLIO', T1, 100000, 100000, 0, 0, 0, 100000);
  stmt.run('LONG_TERM_PORTFOLIO', T2, 100000, 100000, 0, 0, 0, 100000);
}

function seedSpy(db: DatabaseSync, bars: Array<[string, number]>): void {
  const stmt = db.prepare(
    `INSERT INTO market_bars (ticker, date, open, high, low, close, volume, provider, fetched_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  for (const [date, close] of bars) stmt.run('SPY', date, close, close, close, close, 1000, 'test', T2);
}

function review(db: DatabaseSync): Record<string, unknown> {
  const row = db.prepare('SELECT payload_json FROM daily_reviews WHERE date = ?').get(DAY) as
    | { payload_json: string }
    | undefined;
  assert.ok(row, 'a review row must exist');
  return JSON.parse(row.payload_json) as Record<string, unknown>;
}

test('missing SPY bar reports a pending benchmark, never a fake 0%', () => {
  const db = openTradingDb(':memory:');
  try {
    seedSnapshots(db);
    seedSpy(db, [['2026-11-01', 755.72]]); // previous bar only — the session's bar is not in yet

    buildDailyReview(db, DAY);
    const payload = review(db);

    assert.equal(payload.dailyReturnPct, 0.25, 'our own daily return is still computed');
    assert.equal(payload.benchmarkReturnPct, null, '0% must not be reported as "SPY was flat"');
    assert.equal(payload.excessReturnPct, null, 'excess cannot be claimed without a benchmark');
    assert.equal(payload.benchmarkPending, true, 'the UI can show the pending state');
  } finally {
    db.close();
  }
});

test('once the bar lands, a re-run fills in the real benchmark and excess', () => {
  const db = openTradingDb(':memory:');
  try {
    seedSnapshots(db);
    seedSpy(db, [['2026-11-01', 755.72]]);
    buildDailyReview(db, DAY);
    assert.equal(review(db).benchmarkReturnPct, null);

    // the daily bar arrives — the settle pass calls buildDailyReview again
    seedSpy(db, [[DAY, 752.1]]);
    buildDailyReview(db, DAY);
    const payload = review(db);

    const bench = ((752.1 - 755.72) / 755.72) * 100; // -0.4790%
    assert.ok(Math.abs((payload.benchmarkReturnPct as number) - bench) < 0.001,
      `benchmark should be ${bench.toFixed(4)}, got ${payload.benchmarkReturnPct}`);
    assert.equal(payload.benchmarkPending, false);
    assert.ok(Math.abs((payload.excessReturnPct as number) - (0.25 - bench)) < 0.001,
      'excess = our return minus the real benchmark');
    assert.ok((payload.excessReturnPct as number) > 0,
      'the book beat a falling market that day — the old code reported the opposite');
  } finally {
    db.close();
  }
});

test('the daily review is idempotent — a rebuild keeps the counts and updates the benchmark', () => {
  const db = openTradingDb(':memory:');
  try {
    seedSnapshots(db);
    seedSpy(db, [['2026-11-01', 755.72], [DAY, 752.1]]);
    buildDailyReview(db, DAY);
    const first = review(db);
    buildDailyReview(db, DAY);
    const second = review(db);

    assert.equal(second.signals, first.signals);
    assert.equal(second.closed, first.closed);
    assert.equal(second.dailyReturnPct, first.dailyReturnPct);
    assert.equal(second.benchmarkReturnPct, first.benchmarkReturnPct);
    const rows = db.prepare('SELECT COUNT(*) AS n FROM daily_reviews WHERE date = ?').get(DAY) as { n: number };
    assert.equal(rows.n, 1, 're-running upserts rather than duplicating the day');
  } finally {
    db.close();
  }
});

test('a rebuild uses THAT day\'s snapshots, not the newest pair', () => {
  const db = openTradingDb(':memory:');
  try {
    const stmt = db.prepare(
      `INSERT INTO portfolio_snapshots (portfolio, ts, equity, cash, realized, unrealized, exposure, benchmark_equity)
       VALUES (?,?,?,?,?,?,?,?)`,
    );
    // SHORT climbs 100000 -> 100200 on 11-01, then -> 100400 on 11-02; LONG flat
    stmt.run('SHORT_TERM_PORTFOLIO', Date.parse('2026-10-31T21:00:00Z'), 100000, 100000, 0, 0, 0, 100000);
    stmt.run('SHORT_TERM_PORTFOLIO', Date.parse('2026-11-01T21:00:00Z'), 100200, 100200, 0, 0, 0, 100000);
    stmt.run('SHORT_TERM_PORTFOLIO', Date.parse('2026-11-02T21:00:00Z'), 100400, 100400, 0, 0, 0, 100000);
    stmt.run('LONG_TERM_PORTFOLIO', Date.parse('2026-10-31T21:00:00Z'), 100000, 100000, 0, 0, 0, 100000);
    stmt.run('LONG_TERM_PORTFOLIO', Date.parse('2026-11-01T21:00:00Z'), 100000, 100000, 0, 0, 0, 100000);
    stmt.run('LONG_TERM_PORTFOLIO', Date.parse('2026-11-02T21:00:00Z'), 100000, 100000, 0, 0, 0, 100000);

    buildDailyReview(db, '2026-11-01');
    const day1 = JSON.parse(
      (db.prepare('SELECT payload_json FROM daily_reviews WHERE date = ?').get('2026-11-01') as { payload_json: string }).payload_json,
    ) as { dailyReturnPct: number };

    buildDailyReview(db, DAY);
    const day2 = review(db);

    // SHORT +0.2% on 11-01, LONG flat -> 0.1%; on 11-02 SHORT +0.1996% -> ~0.0998%
    assert.ok(Math.abs(day1.dailyReturnPct - 0.1) < 1e-6, `11-01 must use its own snapshots, got ${day1.dailyReturnPct}`);
    assert.ok(Math.abs((day2.dailyReturnPct as number) - 0.0998) < 0.001,
      `11-02 must use its own snapshots, got ${day2.dailyReturnPct}`);
    assert.notEqual(day1.dailyReturnPct, day2.dailyReturnPct,
      'the old code stamped the newest snapshot pair onto every date');
  } finally {
    db.close();
  }
});

test('weekly review reports a pending SPY return instead of 0', () => {
  const db = openTradingDb(':memory:');
  try {
    seedSnapshots(db); // no SPY bars at all
    buildWeeklyReviewIfDue(db, DAY);

    const rows = db.prepare('SELECT payload_json FROM weekly_reviews').all() as Array<{ payload_json: string }>;
    assert.ok(rows.length > 0, 'a weekly row is produced from the seed');
    const payload = JSON.parse(rows[rows.length - 1].payload_json) as {
      shortTerm: { spyReturnPct: number | null; excessReturnPct: number | null };
    };
    assert.equal(payload.shortTerm.spyReturnPct, null, 'never fake a flat market');
    assert.equal(payload.shortTerm.excessReturnPct, null);
    assert.equal(typeof payload.shortTerm.returnPct, 'number');
  } finally {
    db.close();
  }
});