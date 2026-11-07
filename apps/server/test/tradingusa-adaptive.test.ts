/**
 * Adaptive learning-loop tests: outcomes (wins AND losses) feed the knowledge
 * base, fusion weights only move once real evidence backs them, and a lesson
 * can be adopted, revoked and re-proposed.
 *
 * Network access is injected — no test touches the internet.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { FUSION_WEIGHTS } from '@promptslim/tucore';
import type { MarketDataProvider, Quote, ScoreParts } from '@promptslim/tucore';
import { openTradingDb } from '../src/tradingusa/schema.ts';
import { tuConfigFromEnv } from '../src/tradingusa/config.ts';
import { ensurePortfolios } from '../src/tradingusa/broker.ts';
import { runScan } from '../src/tradingusa/engine.ts';
import { tradableUniverse } from '../src/tradingusa/universe.ts';
import {
  MIN_TRADES, REVOKE_AFTER, REPROPOSE_AFTER,
  learnedWeights, recomputeStrategyWeights, learnFromOutcome, refreshKnowledge,
} from '../src/tradingusa/adaptive.ts';

const SHORT = 'st_multi_factor_v1';
const LONG = 'lt_quality_growth_v1';
const NOW = Date.parse('2026-11-02T16:00:00Z'); // 11:00 ET on a Monday

function scores(overrides: Partial<ScoreParts>): Record<string, number> {
  return { technical: 0.5, fundamental: 0, event: 0, sentiment: 0, macro: 0, regime: 0.5, ...overrides };
}

function insertSignal(
  db: DatabaseSync,
  o: { ticker: string; strategy: string; horizon: string; scores: Record<string, number>; audit?: Record<string, unknown> },
): number {
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
      o.ticker, `${o.ticker} Co`, 'Technology', 'SHORT_TERM_PORTFOLIO', o.strategy, '1.0.0', 'test',
      o.horizon, 'BUY', 0.8, 100, 99, 101, 110, 95, 0.1, 2, 5, 10, 'MARKET_OPEN',
      '2026-10-01', NOW, 'BULL_TREND', '[]', '[]', JSON.stringify(o.scores), 1, '[]',
      JSON.stringify(o.audit ?? {}), '[]', '[]', null,
    );
  return Number(res.lastInsertRowid);
}

function insertTrade(
  db: DatabaseSync,
  o: { signalId: number; ticker: string; strategy: string; netPnl: number; returnPct: number; excessReturn?: number },
): number {
  const excess = o.excessReturn ?? o.returnPct;
  const res = db
    .prepare(
      `INSERT INTO paper_trades (portfolio, ticker, company, sector, side, qty, entry_price, entry_ts,
         exit_price, exit_ts, exit_reason, capital, gross_pnl, net_pnl, return_pct, benchmark_return,
         excess_return, holding_sessions, mfe, mae, predicted_return, actual_return, prediction_error,
         signal_id, strategy, strategy_version, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      'SHORT_TERM_PORTFOLIO', o.ticker, `${o.ticker} Co`, 'Technology', 'LONG', 10, 100, NOW - 86_400_000,
      100, NOW, 'TARGET_REACHED', 1000, o.netPnl, o.netPnl, o.returnPct, 0, excess,
      1, 0, 0, 0.1, o.returnPct, 0, o.signalId, o.strategy, '1.0.0', 'CLOSED',
    );
  return Number(res.lastInsertRowid);
}

function lesson(db: DatabaseSync, status: string, scope: Record<string, unknown>, confidence = 0.95): number {
  const res = db
    .prepare(
      `INSERT INTO knowledge_lessons (title, statement, confidence, scope_json, status, validations,
        contradictions, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run('Recurring: TECHNICAL_SIGNAL_FAILURE', 'require price AND volume confirmation',
      confidence, JSON.stringify(scope), status, 1, 0, NOW, NOW);
  return Number(res.lastInsertRowid);
}

function eventKinds(db: DatabaseSync): string[] {
  return (db.prepare('SELECT kind FROM learning_events ORDER BY id').all() as unknown as Array<{ kind: string }>)
    .map((r) => r.kind);
}

test('without enough closed outcomes the shipped weights stay in force', () => {
  const db = openTradingDb(':memory:');
  try {
    const sig = insertSignal(db, { ticker: 'AAPL', strategy: SHORT, horizon: 'SHORT', scores: scores({}) });
    insertTrade(db, { signalId: sig, ticker: 'AAPL', strategy: SHORT, netPnl: -100, returnPct: -0.02 });

    const refresh = recomputeStrategyWeights(db, NOW);
    assert.equal(refresh.strategies, 0, 'one losing trade must not touch production logic');
    const learned = learnedWeights(db, SHORT, 'SHORT');
    assert.equal(learned.sufficient, false);
    assert.equal(learned.weights, undefined, 'runScan falls back to FUSION_WEIGHTS when there is no evidence');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM strategy_weights').get<{ n: number }>()?.n, 0);
  } finally {
    db.close();
  }
});

test('fusion weights are refit from realized outcomes, band-limited and normalized', () => {
  const db = openTradingDb(':memory:');
  try {
    // technical is high on every winner and low on every loser; the other
    // parts carry no information (flat), so only technical may gain weight.
    for (let i = 0; i < MIN_TRADES; i++) {
      const win = i % 2 === 0;
      const sig = insertSignal(db, {
        ticker: `T${i}`, strategy: SHORT, horizon: 'SHORT',
        scores: scores({ technical: win ? 0.95 : 0.05 }),
      });
      insertTrade(db, {
        signalId: sig, ticker: `T${i}`, strategy: SHORT,
        netPnl: win ? 100 : -100, returnPct: win ? 0.03 : -0.02,
        excessReturn: win ? 0.02 : -0.03,
      });
    }

    const refresh = recomputeStrategyWeights(db, NOW);
    assert.equal(refresh.strategies, 1);
    assert.equal(refresh.outcomes, MIN_TRADES);

    const learned = learnedWeights(db, SHORT, 'SHORT');
    assert.equal(learned.sufficient, true);
    assert.equal(learned.trades, MIN_TRADES);

    const def = FUSION_WEIGHTS.SHORT;
    const w = learned.weights as Record<string, number>;
    const total = Object.values(w).reduce((s, v) => s + v, 0);
    assert.ok(Math.abs(total - 1) < 1e-6, `weights must normalize to 1, got ${total}`);
    assert.ok(w.technical > def.technical, 'the part that predicted returns gains weight');
    for (const [k, v] of Object.entries(w)) {
      const d = def[k as keyof ScoreParts];
      assert.ok(v >= d * 0.3 && v <= d * 1.6, `${k} moved outside the band: ${v} vs default ${d}`);
    }
    assert.ok(eventKinds(db).includes('WEIGHT_REFRESH'), 'the refit is logged for the UI');
  } finally {
    db.close();
  }
});

test('wins confirm a validated lesson, losses contradict it, non-matching entries do neither', () => {
  const db = openTradingDb(':memory:');
  try {
    const id = lesson(db, 'VALIDATED', { mistakeKind: 'TECHNICAL_SIGNAL_FAILURE' });
    const gated = (relVol: number): number =>
      insertSignal(db, {
        ticker: 'MSFT', strategy: SHORT, horizon: 'SHORT', scores: scores({}),
        audit: { entryChecks: { relativeVolume: relVol } },
      });

    const winId = insertTrade(db, { signalId: gated(1.3), ticker: 'MSFT', strategy: SHORT, netPnl: 250, returnPct: 0.04 });
    const loseId = insertTrade(db, { signalId: gated(1.4), ticker: 'MSFT', strategy: SHORT, netPnl: -250, returnPct: -0.03 });
    const ignoredId = insertTrade(db, { signalId: gated(0.5), ticker: 'MSFT', strategy: SHORT, netPnl: -250, returnPct: -0.03 });

    assert.equal(learnFromOutcome(db, winId).won, true);
    assert.equal(learnFromOutcome(db, loseId).won, false);
    assert.equal(learnFromOutcome(db, ignoredId).recorded, true);

    const row = db.prepare('SELECT validations, contradictions FROM knowledge_lessons WHERE id = ?').get(id) as
      { validations: number; contradictions: number };
    // the helper seeds validations = 1, matching how learning.ts proposes a lesson
    assert.equal(row.validations, 2, 'a win under the lesson\'s prescription confirms it');
    assert.equal(row.contradictions, 1, 'a loss under it contradicts it');
    assert.equal(row.validations + row.contradictions, 3, 'an entry that ignored the prescription feeds nothing');

    const kinds = eventKinds(db);
    assert.equal(kinds.filter((k) => k === 'OUTCOME_RECORDED').length, 3, 'every closed trade is recorded, wins included');
    assert.ok(kinds.includes('LESSON_CONFIRMED'));
    assert.ok(kinds.includes('LESSON_CONTRADICTED'));
  } finally {
    db.close();
  }
});

test('a lesson contradicted by outcomes is revoked, then re-proposed on fresh evidence', () => {
  const db = openTradingDb(':memory:');
  try {
    const id = lesson(db, 'VALIDATED', { mistakeKind: 'TECHNICAL_SIGNAL_FAILURE' });
    db.prepare(`INSERT INTO mistake_clusters (kind, count, confidence, lesson, updated_at)
                 VALUES ('TECHNICAL_SIGNAL_FAILURE', 1, 0.4, 'lesson', ?)`)
      .run(NOW);

    // three losses under the lesson's own prescription overturn it
    for (let i = 0; i < REVOKE_AFTER; i++) {
      const sig = insertSignal(db, {
        ticker: 'NVDA', strategy: SHORT, horizon: 'SHORT', scores: scores({}),
        audit: { entryChecks: { relativeVolume: 1.2 } },
      });
      const tid = insertTrade(db, { signalId: sig, ticker: 'NVDA', strategy: SHORT, netPnl: -100, returnPct: -0.02 });
      learnFromOutcome(db, tid);
    }

    const first = refreshKnowledge(db, NOW);
    assert.equal(first.revoked, 1, 'contradictions now dominate, so the gate turns off');
    const after = db.prepare('SELECT status, scope_json FROM knowledge_lessons WHERE id = ?').get(id) as
      { status: string; scope_json: string };
    assert.equal(after.status, 'EXPIRED');
    assert.equal(JSON.parse(after.scope_json).revokedAtCount, 1, 'the cluster count at revocation is remembered');
    const stillGating = db
      .prepare(
        `SELECT 1 FROM knowledge_lessons
          WHERE status = 'VALIDATED' AND confidence >= 0.7
            AND scope_json LIKE '%TECHNICAL_SIGNAL_FAILURE%' LIMIT 1`,
      )
      .get();
    assert.equal(stillGating, undefined, 'engine.runScan no longer enforces the revoked rule');

    // three fresh observations in the same cluster bring the rule back as a candidate
    db.prepare(`UPDATE mistake_clusters SET count = ?, updated_at = ? WHERE kind = 'TECHNICAL_SIGNAL_FAILURE'`)
      .run(1 + REPROPOSE_AFTER, NOW + 1000);
    const second = refreshKnowledge(db, NOW + 2000);
    assert.equal(second.reproposed, 1);
    const back = db.prepare('SELECT status, contradictions, validations FROM knowledge_lessons WHERE id = ?').get(id) as
      { status: string; contradictions: number; validations: number };
    assert.equal(back.status, 'CANDIDATE', 're-proposed, not auto-reinstated');
    assert.equal(back.contradictions, 0, 'the new cycle starts with a clean ledger');

    const kinds = eventKinds(db);
    assert.ok(kinds.includes('LESSON_REVOKED'));
    assert.ok(kinds.includes('LESSON_REPROPOSED'));
    assert.ok(kinds.includes('KNOWLEDGE_REFRESH'));
  } finally {
    db.close();
  }
});

/* ---------------- integration: runScan actually consumes the weights -------- */

const stubProvider: MarketDataProvider = {
  name: 'test',
  getQuotes: (async () => [] as Quote[]) as MarketDataProvider['getQuotes'],
  getDailyBars: (async () => []) as MarketDataProvider['getDailyBars'],
  status: () => 'CONNECTED',
  lastUpdate: () => NOW,
  lastLatencyMs: () => 1,
  lastError: () => null,
};

function seedUniverse(db: DatabaseSync): void {
  const stmt = db.prepare(
    `INSERT INTO market_bars (ticker, date, open, high, low, close, volume, provider, fetched_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  const quote = db.prepare(
    `INSERT INTO market_quotes (symbol, price, prev_close, ts, provider, freshness) VALUES (?,?,?,?,?,?)`,
  );
  const tickers = ['SPY', ...tradableUniverse().map((t) => t.ticker)];
  const end = Date.parse('2026-11-02T00:00:00Z');
  for (const ticker of tickers) {
    let price = 100;
    // 140 sessions (shortTermScore needs >= 120, detectRegime >= 100) of a
    // rising tape with no upper wick: close is the session high, so nothing
    // sits above the last price and the strategy's target is its own 2x ATR.
    for (let i = 140; i >= 0; i--) {
      const date = new Date(end - i * 86_400_000).toISOString().slice(0, 10);
      const open = price;
      price = price * 1.012;
      const close = price;
      const low = Math.min(open, close) * 0.992;
      const volume = 1_200_000 + (i % 7) * 150_000;
      stmt.run(ticker, date, open, close, low, close, volume, 'test', NOW);
    }
    // a live quote above the previous close keeps the regime's breadth
    // component fed instead of reading 0/0
    quote.run(ticker, price, price / 1.012, NOW, 'test', 'DELAYED');
  }
}

function plantWeights(db: DatabaseSync, strategy: string, horizon: string): void {
  // macro dominates and the macro part is ~0 in a seeded book -> fusion must
  // produce no actionable signal, which is exactly how we prove runScan read
  // the row instead of the shipped defaults.
  db.prepare(
    `INSERT INTO strategy_weights (strategy, horizon, weights_json, updated_at) VALUES (?, ?, ?, ?)`,
  ).run(
    strategy, horizon,
    JSON.stringify({
      weights: { technical: 0.01, fundamental: 0.01, event: 0.01, sentiment: 0.01, macro: 0.96, regime: 0.01 },
      trades: MIN_TRADES, sufficient: true, updatedAt: NOW,
    }),
    NOW,
  );
}

test('runScan consumes the learned weights (default run vs planted run)', async () => {
  // the confidence floor and the R:R floor are relaxed only so the seeded
  // tape clears the entry gates — the assertion below is about runScan
  // READING the learned weights, not about those gates.
  const config = tuConfigFromEnv({ TU_MIN_SIGNAL_CONFIDENCE: '0.5', TU_MIN_RISK_REWARD: '1' });

  const dbA = openTradingDb(':memory:');
  let a;
  try {
    ensurePortfolios(dbA, config);
    seedUniverse(dbA);
    a = await runScan({ db: dbA, provider: stubProvider, config, now: NOW });
  } finally {
    dbA.close();
  }

  const dbB = openTradingDb(':memory:');
  let b;
  try {
    ensurePortfolios(dbB, config);
    seedUniverse(dbB);
    plantWeights(dbB, SHORT, 'SHORT');
    plantWeights(dbB, LONG, 'LONG');
    b = await runScan({ db: dbB, provider: stubProvider, config, now: NOW });
  } finally {
    dbB.close();
  }

  assert.ok(a.scanned > 0, 'the seeded universe must be scanned');
  assert.ok(a.signalsCreated > 0, `default weights must produce signals, got ${a.signalsCreated}`);
  assert.equal(b.signalsCreated, 0, 'planted weights that zero the fusion must stop every signal');
  assert.notEqual(b.signalsCreated, a.signalsCreated, 'runScan read the learned row, not the defaults');
});
