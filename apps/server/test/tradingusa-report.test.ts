/**
 * /report — date-range daily metrics.
 * Unit level: buildReport over a seeded in-memory trading DB (per-day
 * aggregation + percent conventions). HTTP level: the route's default
 * window, validation, and no-secret guarantee.
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/index.ts';
import { openDb } from '../src/db.ts';
import { openTradingDb } from '../src/tradingusa/schema.ts';
import { buildReport, reportRange } from '../src/tradingusa/report.ts';

/* ---------------- pure range validation ---------------- */

test('reportRange defaults to 14 days and validates input', () => {
  const now = Date.parse('2026-10-20T16:00:00Z');
  const def = reportRange(null, null, now);
  assert.ok(!('error' in def), 'default range must be valid');
  assert.equal(def.to, '2026-10-20');
  assert.equal(def.from, '2026-10-07'); // 13 days back = 14-day window

  assert.ok('error' in reportRange('banana', null, now));
  assert.match((reportRange('banana', null, now) as { error: string }).error, /YYYY-MM-DD/);
  assert.ok('error' in reportRange('2026-10-20', '2026-10-01', now), 'from > to rejected');
  assert.ok('error' in reportRange('2020-01-01', '2026-10-20', now), 'span > 400d rejected');

  const custom = reportRange('2026-10-01', '2026-10-05', now);
  assert.deepEqual(custom, { from: '2026-10-01', to: '2026-10-05' });
});

/* ---------------- buildReport over a seeded trading DB ---------------- */

function seed(db: DatabaseSync): void {
  const day = '2026-10-14';
  const ts = Date.parse(`${day}T15:00:00Z`); // 11:00 ET — same ET day
  const nextDay = Date.parse('2026-10-15T15:00:00Z');

  db.prepare(`INSERT INTO market_regimes (date, regime, confidence, components_json) VALUES (?, 'BULL_TREND', 0.8, '{}')`).run(day);

  db.prepare(`INSERT INTO audit_log (ts, action, entity, entity_id, detail_json) VALUES (?, 'scan', 'system', 'MARKET_OPEN', ?)`)
    .run(ts, JSON.stringify({ scanned: 51, signals: 1, regime: 'BULL_TREND', skippedRegime: 2, skippedLowConfidence: 5, skippedLesson: 1 }));
  db.prepare(`INSERT INTO audit_log (ts, action, entity, entity_id, detail_json) VALUES (?, 'scan', 'system', 'MARKET_OPEN', ?)`)
    .run(ts + 60_000, JSON.stringify({ scanned: 51, signals: 0, regime: 'BULL_TREND', skippedRegime: 0, skippedLowConfidence: 3, skippedLesson: 0 }));
  // pre-counter legacy row must not break parsing
  db.prepare(`INSERT INTO audit_log (ts, action, entity, entity_id, detail_json) VALUES (?, 'scan', 'system', 'MARKET_OPEN', ?)`)
    .run(ts + 120_000, JSON.stringify({ scanned: 51, signals: 0, regime: 'BULL_TREND' }));

  db.prepare(
    `INSERT INTO signals (ticker, company, sector, portfolio, strategy, strategy_version, model_version,
       horizon, signal, confidence, price, entry_low, entry_high, target, invalidation, expected_return,
       risk_reward, expected_hold, max_hold, session, session_date, created_at, regime)
     VALUES ('AAPL','Apple Inc.','Technology','SHORT_TERM_PORTFOLIO','st_multi_factor_v1','1.0.0','m1',
       'SHORT_TERM','BUY',0.82,200,199,201,210,195,0.05,2.0,5,10,'MARKET_OPEN',?,?,'BULL_TREND')`,
  ).run(day, ts);

  db.prepare(
    `INSERT INTO paper_orders (portfolio, signal_id, ticker, side, qty, status, fill_mode, created_at, filled_at, fill_price)
     VALUES ('SHORT_TERM_PORTFOLIO', 1, 'AAPL', 'BUY', 10, 'FILLED', 'AT_SIGNAL', ?, ?, 200.1)`,
  ).run(ts, ts);

  // winner closed on day 1
  db.prepare(
    `INSERT INTO paper_trades (portfolio, ticker, company, sector, side, qty, entry_price, entry_ts,
       exit_price, exit_ts, exit_reason, capital, gross_pnl, net_pnl, return_pct, status)
     VALUES ('SHORT_TERM_PORTFOLIO','AAPL','Apple Inc.','Technology','LONG',10,200,?,204,?,'TARGET_REACHED',2000,40,40,0.02,'CLOSED')`,
  ).run(ts, ts);
  // loser closed on day 2
  db.prepare(
    `INSERT INTO paper_trades (portfolio, ticker, company, sector, side, qty, entry_price, entry_ts,
       exit_price, exit_ts, exit_reason, capital, gross_pnl, net_pnl, return_pct, status)
     VALUES ('SHORT_TERM_PORTFOLIO','MSFT','Microsoft','Technology','LONG',5,300,?,297,?,'STOP_REACHED',1500,-15,-15,-0.01,'CLOSED')`,
  ).run(ts, nextDay);
  // still-open position must not count as closed
  db.prepare(
    `INSERT INTO paper_trades (portfolio, ticker, company, sector, side, qty, entry_price, entry_ts, capital, status)
     VALUES ('SHORT_TERM_PORTFOLIO','NVDA','Nvidia','Technology','LONG',2,100,?,200,'OPEN')`,
  ).run(ts);

  db.prepare(
    `INSERT INTO portfolio_snapshots (portfolio, ts, equity, cash, realized, unrealized, exposure)
     VALUES ('SHORT_TERM_PORTFOLIO', ?, 101000, 50000, 1000, -500, 0.5)`,
  ).run(ts);
}

test('buildReport counts a scan in the tail of the final ET day', () => {
  const db = openTradingDb(':memory:');
  // Oct 16 03:30Z = Oct 15 23:30 ET — inside the last hours of the range's final day
  const lateTs = Date.parse('2026-10-16T03:30:00Z');
  db.prepare(`INSERT INTO audit_log (ts, action, entity, entity_id, detail_json) VALUES (?, 'scan', 'system', 'MARKET_CLOSE', ?)`)
    .run(lateTs, JSON.stringify({ scanned: 51, signals: 0, regime: 'RISK_ON', skippedRegime: 1, skippedLowConfidence: 4, skippedLesson: 0 }));
  const rep = buildReport(db, '2026-10-14', '2026-10-15');
  const d2 = rep.days[1];
  assert.equal(d2.date, '2026-10-15');
  assert.equal(d2.scans, 1, 'late-ET scan must land on its own day, not fall outside the window');
  assert.equal(d2.blockedLowConfidence, 4);
  assert.equal(d2.blockedRegime, 1);
});

test('buildReport aggregates per-day metrics with percent conventions', () => {
  const db = openTradingDb(':memory:');
  seed(db);
  const rep = buildReport(db, '2026-10-14', '2026-10-15');

  assert.equal(rep.from, '2026-10-14');
  assert.equal(rep.to, '2026-10-15');
  assert.equal(rep.days.length, 2);

  const d1 = rep.days[0];
  assert.equal(d1.date, '2026-10-14');
  assert.equal(d1.regime, 'BULL_TREND');
  assert.equal(d1.scans, 3, 'three scan audit rows, legacy row included');
  assert.equal(d1.signals, 1);
  assert.equal(d1.orders, 1);
  assert.equal(d1.opened, 3, 'AAPL + MSFT + NVDA all entered that day');
  assert.equal(d1.closed, 1, 'only AAPL closed on day 1');
  assert.equal(d1.wins, 1);
  assert.equal(d1.winRatePct, 100);
  assert.equal(d1.expectancyPct, 2, 'ALREADY-PERCENT (0.02 fraction → 2)');
  assert.equal(d1.avgWinPct, 2);
  assert.equal(d1.targets, 1);
  assert.equal(d1.netPnl, 40);
  assert.equal(d1.equity, 101000);
  assert.equal(d1.blockedRegime, 2);
  assert.equal(d1.blockedLowConfidence, 8, '5 + 3 from two counter rows; legacy row adds 0');
  assert.equal(d1.blockedLesson, 1);

  const d2 = rep.days[1];
  assert.equal(d2.date, '2026-10-15');
  assert.equal(d2.closed, 1);
  assert.equal(d2.losses, 1);
  assert.equal(d2.winRatePct, 0);
  assert.equal(d2.expectancyPct, -1);
  assert.equal(d2.stops, 1);
  assert.equal(d2.netPnl, -15);
  assert.equal(d2.equity, null, 'no snapshot that day');

  const t = rep.totals;
  assert.equal(t.days, 2);
  assert.equal(t.signals, 1);
  assert.equal(t.opened, 3, 'all three seeded trades entered in range');
  assert.equal(t.closed, 2);
  assert.equal(t.wins, 1);
  assert.equal(t.losses, 1);
  assert.equal(t.winRatePct, 50);
  assert.equal(t.expectancyPct, 0.5, '(2 + -1) / 2');
  assert.equal(t.netPnl, 25, '40 + -15');
  assert.equal(t.stops, 1);
  assert.equal(t.targets, 1);
  assert.equal(t.blockedRegime, 2);
  assert.equal(t.blockedLowConfidence, 8);
  assert.equal(t.blockedLesson, 1);
});

/* ---------------- HTTP ---------------- */

let server: Server;
let base = '';

before(async () => {
  server = createApp(openDb(':memory:'), { dbPath: ':memory:', tuDbPath: ':memory:' });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('GET /api/tradingusa/report serves a default 14-day window', async () => {
  const res = await fetch(`${base}/api/tradingusa/report`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { from: string; to: string; days: unknown[]; totals: Record<string, unknown> };
  assert.match(body.from, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(body.to, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(body.days.length >= 13 && body.days.length <= 15, `expected ~14 days, got ${body.days.length}`);
  assert.ok('winRatePct' in body.totals && 'blockedRegime' in body.totals);
  const text = JSON.stringify(body);
  for (const sentinel of ['GROQ_API_KEY', 'GEMINI_API_KEY', 'ALPACA']) {
    assert.ok(!text.includes(sentinel), `report leaked ${sentinel}`);
  }
});

test('GET /api/tradingusa/report rejects malformed ranges', async () => {
  const res = await fetch(`${base}/api/tradingusa/report?from=banana`);
  assert.equal(res.status, 400);
  const body = (await res.json()) as { errors: string[] };
  assert.match(body.errors[0], /YYYY-MM-DD/);

  const reversed = await fetch(`${base}/api/tradingusa/report?from=2026-10-10&to=2026-10-01`);
  assert.equal(reversed.status, 400);
});