/**
 * Rule experiments (shadow mode): the matched-vs-baseline comparison is
 * read-only, filterable by date window, and refuses a verdict on thin
 * evidence. Nothing here can block a trade — a test asserts no table is
 * written to.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { openTradingDb } from '../src/tradingusa/schema.ts';
import { MIN_TRADES } from '../src/tradingusa/adaptive.ts';
import { experimentSummary, EXPERIMENT_CONDITIONS } from '../src/tradingusa/experiments.ts';

interface Seed {
  sessionDate: string;
  volume: 'confirmed' | 'weak';
  confidence: number;
  retPct: number | null; // null = still open
}

function insertSignal(db: DatabaseSync, s: Seed): number {
  const detail = s.volume === 'confirmed'
    ? 'breakout above 20d high 142.10 on 1.40x volume'
    : 'breakout above 20d high 142.10 without volume confirmation (0.90x)';
  const evidence = [
    { kind: 'breakout', detail, weight: 0.75, positive: true },
    { kind: 'trend_alignment', detail: 'bullish stack (20>50>120)', weight: 0.6, positive: true },
  ];
  const res = db
    .prepare(
      `INSERT INTO signals (ticker, company, sector, portfolio, strategy, strategy_version, model_version,
        horizon, signal, confidence, price, entry_low, entry_high, target, invalidation, expected_return,
        risk_reward, expected_hold, max_hold, session, session_date, created_at, regime, evidence_json,
        contradictions_json, scores_json, data_freshness, risk_checks_json, audit_json, knowledge_refs_json,
        event_refs_json, llm_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      'SPY', 'SPY Co', 'Index', 'SHORT_TERM_PORTFOLIO', 'st_multi_factor_v1', '1.0.0', 'test',
      'SHORT', 'BUY', s.confidence, 140, 139, 141, 150, 135, 0.07, 2, 5, 10, 'MARKET_OPEN',
      s.sessionDate, Date.parse(`${s.sessionDate}T16:00:00Z`), 'BULL_TREND', JSON.stringify(evidence),
      '[]', JSON.stringify({ technical: 1, fundamental: 0, event: 0, sentiment: 0, macro: 0, regime: 0.5, risk: 0 }),
      1, '[]', JSON.stringify({ entryChecks: { relativeVolume: s.volume === 'confirmed' ? 1.4 : 0.9 } }),
      '[]', '[]', null,
    );
  return Number(res.lastInsertRowid);
}

function insertTrade(db: DatabaseSync, signalId: number, retPct: number | null): number {
  const exitTs = retPct == null ? null : Date.parse('2026-10-25T20:00:00Z');
  const res = db
    .prepare(
      `INSERT INTO paper_trades (portfolio, ticker, company, sector, side, qty, entry_price, entry_ts,
         exit_price, exit_ts, exit_reason, capital, gross_pnl, net_pnl, return_pct, benchmark_return,
         excess_return, holding_sessions, mfe, mae, predicted_return, actual_return, prediction_error,
         signal_id, strategy, strategy_version, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      'SHORT_TERM_PORTFOLIO', 'SPY', 'SPY Co', 'Index', 'LONG', 10, 140, Date.parse('2026-10-20T16:00:00Z'),
      140, exitTs, 'TARGET_REACHED', 1000, 0, 0, retPct ?? 0, 0, retPct ?? 0,
      1, 0, 0, 0.07, retPct ?? 0, 0, signalId, 'st_multi_factor_v1', '1.0.0',
      retPct == null ? 'OPEN' : 'CLOSED',
    );
  return Number(res.lastInsertRowid);
}

function seed(db: DatabaseSync): void {
  // group A: early October, volume confirmed, high confidence, +3% each
  for (let i = 0; i < 12; i++) {
    const id = insertSignal(db, { sessionDate: '2026-10-10', volume: 'confirmed', confidence: 0.8, retPct: 0.03 });
    insertTrade(db, id, 0.03);
  }
  // group B: late October, weak volume, low confidence, -1% each
  for (let i = 0; i < 12; i++) {
    const id = insertSignal(db, { sessionDate: '2026-10-20', volume: 'weak', confidence: 0.6, retPct: -0.01 });
    insertTrade(db, id, -0.01);
  }
  // one still-open signal: counted as a signal, never as an outcome
  const open = insertSignal(db, { sessionDate: '2026-10-25', volume: 'confirmed', confidence: 0.8, retPct: null });
  insertTrade(db, open, null);
}

const counts = (db: DatabaseSync): Record<string, number> => {
  const tables = ['signals', 'paper_trades', 'mistakes', 'knowledge_lessons', 'strategy_weights', 'learning_events'];
  const out: Record<string, number> = {};
  for (const t of tables) {
    out[t] = (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
  }
  return out;
};

test('a proven setup beats the rest of the window, with real numbers', () => {
  const db = openTradingDb(':memory:');
  try {
    seed(db);
    const before = counts(db);
    const out = experimentSummary(db, '2026-10-01', '2026-10-31');

    assert.equal(out.signals, 25, '24 closed signals plus the open one');
    assert.equal(out.closedTrades, 24, 'the open trade is not an outcome');
    assert.deepEqual(counts(db), before, 'shadow mode writes NOTHING — no table touched');

    const vol = out.conditions.find((c) => c.key === 'volume_confirmed')!;
    assert.equal(vol.matchedSignals, 13, 'group A plus the still-open confirmed entry');
    assert.equal(vol.matchedClosed, 12, 'the still-open entry is not an outcome');
    assert.equal(vol.baselineClosed, 12);
    assert.equal(vol.matchedAvgReturnPct, 3, 'average of the matched trades in percent');
    assert.equal(vol.baselineAvgReturnPct, -1);
    assert.equal(vol.deltaReturnPct, 4, 'matched minus baseline, percentage points');
    assert.equal(vol.status, 'PROMOTE_CANDIDATE', 'enough evidence and a positive edge');

    const conf = out.conditions.find((c) => c.key === 'high_confidence')!;
    assert.equal(conf.matchedAvgReturnPct, 3);
    assert.equal(conf.deltaReturnPct, 4);

    // trend alignment holds for every signal -> no baseline to compare against
    const trend = out.conditions.find((c) => c.key === 'trend_aligned')!;
    assert.equal(trend.evaluableSignals, 25);
    assert.equal(trend.baselineClosed, 0, 'no counterfactual, no verdict');
    assert.equal(trend.status, 'OBSERVING');
    assert.equal(trend.deltaReturnPct, null);
  } finally {
    db.close();
  }
});

test('the window filters the comparison (same data, earlier range)', () => {
  const db = openTradingDb(':memory:');
  try {
    seed(db);
    const out = experimentSummary(db, '2026-10-01', '2026-10-15');
    assert.equal(out.signals, 12, 'only the first group falls inside the range');
    assert.equal(out.closedTrades, 12);
    const vol = out.conditions.find((c) => c.key === 'volume_confirmed')!;
    assert.equal(vol.matchedClosed, 12);
    assert.equal(vol.baselineClosed, 0, 'the later group is outside the window');
    assert.equal(vol.status, 'OBSERVING', 'no baseline in this window -> no verdict');
  } finally {
    db.close();
  }
});

test('thin evidence never produces a verdict', () => {
  const db = openTradingDb(':memory:');
  try {
    // MIN_TRADES - 1 matched winners: positive, but under the evidence floor
    const n = MIN_TRADES - 1;
    for (let i = 0; i < n; i++) {
      const id = insertSignal(db, { sessionDate: '2026-10-10', volume: 'confirmed', confidence: 0.8, retPct: 0.05 });
      insertTrade(db, id, 0.05);
    }
    for (let i = 0; i < 12; i++) {
      const id = insertSignal(db, { sessionDate: '2026-10-10', volume: 'weak', confidence: 0.6, retPct: -0.02 });
      insertTrade(db, id, -0.02);
    }
    const out = experimentSummary(db, '2026-10-01', '2026-10-31');
    const vol = out.conditions.find((c) => c.key === 'volume_confirmed')!;
    assert.equal(vol.matchedClosed, n);
    assert.equal(vol.deltaReturnPct, 7, 'the arithmetic still runs');
    assert.equal(vol.status, 'OBSERVING', `fewer than ${MIN_TRADES} matched trades -> no verdict`);
    assert.match(out.note, /Shadow mode/);
    assert.match(out.note, /never remove trades/);
  } finally {
    db.close();
  }
});

test('the condition library stays measurable from stored signal fields', () => {
  assert.ok(EXPERIMENT_CONDITIONS.length >= 6, 'the setup library is populated');
  for (const c of EXPERIMENT_CONDITIONS) {
    assert.ok(c.key && c.label && c.description, 'each condition is presentable in the UI');
    assert.equal(typeof c.evaluate, 'function');
  }
  const keys = EXPERIMENT_CONDITIONS.map((c) => c.key);
  assert.equal(new Set(keys).size, keys.length, 'no duplicate keys');
});