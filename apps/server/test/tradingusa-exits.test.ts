/**
 * 2026-11-24 exits fix (three approved changes, all execution-side):
 *   1. ATR noise floor — a placed stop may never sit closer than
 *      stopAtrFloorMultiple x ATR14 to entry, while the reward/risk gate keeps
 *      judging the strategy's stop, so trade flow is byte-identical.
 *   2. Ratchet trailing stop — arms at 1R of MFE, trails behind the peak,
 *      never tighter than the original stop, never moves down.
 *   3. Dead-trade cleanup — N sessions without reaching M x R closes the
 *      position as TIME_LIMIT.
 *
 * All network access is injected — no test touches the internet.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { atr } from '@promptslim/tucore';
import type { MarketDataProvider, Quote } from '@promptslim/tucore';
import { openTradingDb } from '../src/tradingusa/schema.ts';
import { tuConfigFromEnv } from '../src/tradingusa/config.ts';
import { ensurePortfolios } from '../src/tradingusa/broker.ts';
import { isDeadTrade, settleEndOfDay, updateTrailingStop } from '../src/tradingusa/broker.ts';
import { loadBars, runScan } from '../src/tradingusa/engine.ts';
import { tradableUniverse } from '../src/tradingusa/universe.ts';

const NOW = Date.parse('2026-11-24T21:00:00Z'); // 16:00 ET, market open
const DAY = 86_400_000;

const stubProvider: MarketDataProvider = {
  name: 'test',
  getQuotes: (async () => [] as Quote[]) as MarketDataProvider['getQuotes'],
  getDailyBars: (async () => []) as MarketDataProvider['getDailyBars'],
  status: () => 'CONNECTED',
  lastUpdate: () => NOW,
  lastLatencyMs: () => 1,
  lastError: () => null,
};

/** 141 sessions of a steady uptrend: support sits close under the last close,
 *  which is exactly the shape that produced sub-noise stops in production. */
function seedUniverse(db: DatabaseSync): void {
  const stmt = db.prepare(
    `INSERT INTO market_bars (ticker, date, open, high, low, close, volume, provider, fetched_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  const quote = db.prepare(
    `INSERT INTO market_quotes (symbol, price, prev_close, ts, provider, freshness) VALUES (?,?,?,?,?,?)`,
  );
  const tickers = ['SPY', ...tradableUniverse().map((t) => t.ticker)];
  const end = NOW;
  for (const ticker of tickers) {
    let price = 100;
    for (let i = 140; i >= 0; i--) {
      const date = new Date(end - i * DAY).toISOString().slice(0, 10);
      const open = price;
      price = price * 1.012;
      const low = Math.min(open, price) * 0.992;
      stmt.run(ticker, date, open, price, low, price, 1_400_000 + (i % 7) * 150_000, 'test', NOW);
    }
    quote.run(ticker, price, price / 1.012, NOW, 'test', 'DELAYED');
  }
}

interface ScanOut {
  signals: number;
  orders: number;
  rows: Array<{ ticker: string; signal: string; invalidation: number; price: number; riskChecks: string }>;
}

async function scanWith(floor: string): Promise<ScanOut> {
  const config = tuConfigFromEnv({
    TU_MIN_SIGNAL_CONFIDENCE: '0.5', TU_MIN_RISK_REWARD: '1', TU_STOP_ATR_FLOOR: floor,
  });
  const db = openTradingDb(':memory:');
  try {
    ensurePortfolios(db, config);
    seedUniverse(db);
    const scan = await runScan({ db, provider: stubProvider, config, now: NOW });
    const rows = (db.prepare(
      `SELECT ticker, signal, invalidation, price, risk_checks_json AS riskChecks FROM signals`,
    ).all() as unknown as Array<{ ticker: string; signal: string; invalidation: number; price: number; riskChecks: string }>);
    return { signals: scan.signalsCreated, orders: scan.ordersCreated, rows };
  } finally {
    db.close();
  }
}

test('ATR noise floor moves stops but NEVER the trade count (twin seeded runs)', async () => {
  const off = await scanWith('0');
  const on = await scanWith('0.8');
  // an EXTREME floor (3x ATR below entry) must still not remove a trade:
  // the reward/risk gate judges the strategy's stop, sizing follows the placed one
  const extreme = await scanWith('3');

  assert.ok(on.signals > 0, `seeded tape must emit signals, got ${on.signals}`);
  assert.equal(on.signals, off.signals, 'the floor must not remove a single trade');
  assert.equal(on.orders, off.orders, 'the floor must not remove an order');
  assert.equal(extreme.signals, off.signals, 'even a 3x ATR floor removes no trade');
  assert.equal(extreme.orders, off.orders, 'even a 3x ATR floor removes no order');
  assert.ok(
    extreme.rows.some((r, i) => r.invalidation < off.rows[i].invalidation - 1e-9),
    'the floor must actually move stops when it binds',
  );
  for (const r of extreme.rows) {
    if (r.signal !== 'BUY') continue;
    const checks = JSON.parse(r.riskChecks) as Array<{ check: string; passed: boolean }>;
    const rr = checks.find((c) => c.check === 'risk_reward');
    assert.ok(rr?.passed, `${r.ticker}: reward/risk gate unchanged even when the floor binds`);
  }

  const db = openTradingDb(':memory:');
  try {
    seedUniverse(db);
    let widened = 0;
    for (let i = 0; i < on.rows.length; i++) {
      const a = off.rows[i];
      const b = on.rows[i];
      assert.equal(a.ticker, b.ticker, 'identical seed must produce identical signal order');
      const checks = JSON.parse(b.riskChecks) as Array<{ check: string; passed: boolean }>;
      const rr = checks.find((c) => c.check === 'risk_reward');
      if (b.signal === 'BUY') {
        assert.ok(rr && rr.passed, `${b.ticker}: reward/risk gate still judges the strategy stop`);
        const floor = checks.find((c) => c.check === 'stop_floor');
        assert.ok(floor, 'every signal records what the floor did');
        const a14 = atr(loadBars(db, b.ticker), 14).at(-1) ?? 0;
        const dist = b.price - b.invalidation;
        assert.ok(dist >= 0.8 * a14 - 1e-6,
          `${b.ticker}: placed stop ${dist.toFixed(2)} must be >= 0.8xATR ${(0.8 * a14).toFixed(2)}`);
      }
      if (b.invalidation < a.invalidation - 1e-9) widened += 1;
    }
    // on this tape the strategy's own stop already clears 0.8x ATR, so the
    // 0.8 run may move nothing — the binding case is asserted on the 3x run above
    void widened;
  } finally {
    db.close();
  }
});

/* ---------------- ratchet trailing stop ---------------- */

function position(over: Partial<Parameters<typeof updateTrailingStop>[1]> = {}) {
  return {
    id: 7, ticker: 'FLAT', entry_price: 100, stop: 97, mfe: 0, trailing_stop: null as number | null,
    ...over,
  };
}

/** Low-vol tape: TR is constant 1.5, so ATR14 = 1.5 and the trail math is exact. */
function seedFlat(db: DatabaseSync): void {
  const stmt = db.prepare(
    `INSERT INTO market_bars (ticker, date, open, high, low, close, volume, provider, fetched_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  const end = NOW;
  for (let i = 40; i >= 0; i--) {
    stmt.run('FLAT', new Date(end - i * DAY).toISOString().slice(0, 10), 100, 101, 99.5, 100.2, 1_000_000, 'test', NOW);
  }
}

test('ratchet: unarmed below 1R, arms at 1R, never below the original stop, never moves down', () => {
  const config = tuConfigFromEnv({}); // defaults: arm 1R, trail 1.2 ATR
  const db = openTradingDb(':memory:');
  try {
    seedFlat(db);
    const a14 = atr(loadBars(db, 'FLAT'), 14).at(-1)!;
    assert.ok(Math.abs(a14 - 1.5) < 1e-6, `constant-TR tape must give ATR14 = 1.5, got ${a14}`);

    // below 1R -> no trailing stop at all
    assert.equal(updateTrailingStop(db, position({ mfe: 0.02 * 0.9 }), config, 102), null);
    // exactly 1R -> armed, 1.2 ATR behind the peak, floored at the original stop
    const armed = updateTrailingStop(db, position({ mfe: 0.03 }), config, 103);
    assert.ok(armed !== null, 'must arm once MFE reaches 1R');
    assert.ok(Math.abs(armed! - Math.max(103 - 1.2 * a14, 97)) < 1e-9, `trail = peak - 1.2 ATR (got ${armed})`);
    assert.ok(armed! >= 97, 'never tighter than the original stop');

    // monotone: a later, LOWER peak candidate may not pull the stop back down
    const p = position({ mfe: 0.03, trailing_stop: armed! });
    const down = updateTrailingStop(db, p, config, 100.5);
    assert.equal(down, armed, 'a ratchet never moves down');
    // a higher peak keeps ratcheting up
    const up = updateTrailingStop(db, { ...p, mfe: 0.06 }, config, 106);
    assert.ok(up! > armed!, 'a new high keeps ratcheting the stop up');
    // persistence: a real row gets the ratcheted value written back
    db.prepare(
      `INSERT INTO paper_positions (portfolio, ticker, company, sector, qty, entry_price, entry_ts,
         entry_session, target, stop, trailing_stop, max_hold, sessions_held, mfe, mae, thesis_status,
         signal_id, current_price, last_update, predicted_return)
       VALUES ('SHORT_TERM_PORTFOLIO','FLAT','Flat Co','Technology',10,100,?,'MARKET_OPEN',106,97,NULL,20,0,0,0,'INTACT',NULL,100,?,0)`,
    ).run(NOW, NOW);
    const id = Number((db.prepare(`SELECT id FROM paper_positions WHERE ticker='FLAT'`).get() as { id: number }).id);
    updateTrailingStop(db, { id, ticker: 'FLAT', entry_price: 100, stop: 97, mfe: 0.03, trailing_stop: null }, config, 103);
    const stored = db.prepare('SELECT trailing_stop FROM paper_positions WHERE id = ?').get(id) as { trailing_stop: number };
    assert.ok(stored.trailing_stop > 97, 'the ratcheted stop is persisted on the position row');
  } finally {
    db.close();
  }
});

/* ---------------- dead-trade cleanup ---------------- */

test('dead trade: N sessions without M x R closes as TIME_LIMIT, a working position stays', () => {
  const config = tuConfigFromEnv({}); // defaults: 5 sessions, 0.5R
  const base = { entry_price: 100, stop: 97, mfe: 0, sessions_held: 0 };

  assert.equal(isDeadTrade({ ...base, sessions_held: 4, mfe: 0 }, config), false, 'not yet N sessions');
  assert.equal(isDeadTrade({ ...base, sessions_held: 5, mfe: 0.014 }, config), true, 'stalled below 0.5R for N sessions');
  assert.equal(isDeadTrade({ ...base, sessions_held: 5, mfe: 0.02 }, config), false, 'a position that moved stays open');
  assert.equal(isDeadTrade({ ...base, sessions_held: 9, mfe: 0 } , { ...config, deadTradeSessions: 0 }), false, '0 disables the rule');
});

test('settleEndOfDay closes a stalled position as TIME_LIMIT (end-of-day pass runs the rule)', () => {
  const config = tuConfigFromEnv({});
  const db = openTradingDb(':memory:');
  try {
    seedUniverse(db);
    db.prepare(`INSERT INTO paper_portfolios (kind, start_capital, cash, created_at) VALUES ('SHORT_TERM_PORTFOLIO', 100000, 100000, ?)`).run(NOW);
    const last = loadBars(db, 'AAPL').at(-1)!;
    const entryTs = NOW - 6 * DAY;
    db.prepare(
      `INSERT INTO paper_positions (portfolio, ticker, company, sector, qty, entry_price, entry_ts,
         entry_session, target, stop, trailing_stop, max_hold, sessions_held, mfe, mae, thesis_status,
         signal_id, current_price, last_update, predicted_return)
       VALUES ('SHORT_TERM_PORTFOLIO','AAPL','Apple','Technology',10,?,?, 'MARKET_OPEN', ?, ?, NULL, 20, 0, 0.01, 0, 'INTACT', NULL, ?, ?, 0)`,
    ).run(last.close * 0.99, entryTs, last.close * 0.99 * 1.06, last.close * 0.99 * 0.97, last.close, NOW);

    const closed = settleEndOfDay(db, config, new Date(NOW).toISOString().slice(0, 10));
    assert.equal(closed.closed, 1, 'the stalled position must close');
    const trade = db.prepare(`SELECT exit_reason FROM paper_trades WHERE ticker = 'AAPL'`).get() as { exit_reason: string };
    assert.equal(trade.exit_reason, 'TIME_LIMIT', 'dead trades reuse the existing time-limit reason');
    const pos = db.prepare('SELECT exit_ts FROM paper_positions').get() as { exit_ts: number | null };
    assert.ok(pos.exit_ts, 'position marked closed');
  } finally {
    db.close();
  }
});
