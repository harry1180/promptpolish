/**
 * Correction-phase test suite (approved item 3): entry/stop geometry guard,
 * replay of the three closed trades, fees + realized P&L, order states
 * (pending / filled / rejected), same-day re-entry, stale-data gate,
 * position-state consistency, trailing stop and protective exits.
 *
 * Protective stops are never disabled here — the suite asserts they fire,
 * with slippage, exactly as the production exit path models them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkExit, evaluateEntry } from '@promptslim/tucore';
import type { Quote } from '@promptslim/tucore';
import { cryptoConfigFromEnv } from '../src/crypto/config.ts';
import {
  ensureSpotPortfolio, monitorPositions, openPositions, processOrders, upsertBar,
} from '../src/crypto/broker.ts';
import { entryBandOverlapsStop, validateEntryGeometry } from '../src/crypto/guard.ts';
import { evaluateFixedHorizons } from '../src/crypto/accuracy.ts';
import { openCryptoDb } from '../src/crypto/schema.ts';
import type { CryptoMarketDataProvider } from '../src/crypto/providers/types.ts';

const FEE = 0.0016; // production CRYPTO_FEE_PCT
const cfg = (env: Record<string, string> = {}) =>
  cryptoConfigFromEnv({ CRYPTO_FEE_PCT: String(FEE), ...env });

function provider(quotes: Array<Partial<Quote> & { symbol: string; price: number }>): CryptoMarketDataProvider {
  return {
    name: 'test',
    getQuotes: async () => quotes as Quote[],
    getDailyBars: async () => [],
  } as unknown as CryptoMarketDataProvider;
}

/** The three closed trades, exactly as recorded in the live paper book. */
const REPLAY = [
  {
    ticker: 'OKB', qty: 93, entry: 106.84, entryTs: 1793912937921,
    entryFee: 15.897792000000003, stop: 105.72999999999999, target: 128.83122314392463,
    exit: 105.36, gross: -137.64000000000038, net: -169.2153600000004,
    ret: -0.017030325720703895, bandLow: 105.07, execRef: 106.9,
    slippageBelowStop: true, // exit printed BELOW the stop (gap through it)
  },
  {
    ticker: 'NEAR', qty: 2695, entry: 3.7095, entryTs: 1793914438948,
    entryFee: 15.995363999999999, stop: 3.6328, target: 5.069453059175537,
    exit: 3.6328, gross: -206.70649999999938, net: -238.36649759999938,
    ret: -0.023843558431055338, bandLow: 3.5979, execRef: 3.71,
    slippageBelowStop: false,
  },
  {
    ticker: 'UNI', qty: 1456, entry: 6.8815, entryTs: 1793924640909,
    entryFee: 16.0311424, stop: 6.7681000000000004, target: 8.659307133578043,
    exit: 6.7681000000000004, gross: -165.1103999999993, net: -196.9085081599993,
    ret: -0.01965259899731156, bandLow: 6.7279, execRef: 6.89,
    slippageBelowStop: false,
  },
];

const db = openCryptoDb(':memory:');
const config = cfg();
ensureSpotPortfolio(db, config);

/* ------------------------------------------------------------------ */
/* 1. geometry guard unit                                              */
/* ------------------------------------------------------------------ */

test('validateEntryGeometry: executable entry must clear stop + buffer', () => {
  const base = { side: 'BUY' as const, invalidation: 100, bufferPct: 0.001 };
  assert.equal(validateEntryGeometry({ ...base, executablePrice: 100.2 }).ok, true);
  // exactly at the floor passes; one tick below fails
  assert.equal(validateEntryGeometry({ ...base, executablePrice: 100.1 }).ok, true);
  const atStop = validateEntryGeometry({ ...base, executablePrice: 100.0 });
  assert.equal(atStop.ok, false);
  assert.equal(atStop.code, 'ENTRY_EXEC_BELOW_STOP');
  assert.equal(atStop.requiredMin, 100.1);
  const below = validateEntryGeometry({ ...base, executablePrice: 99.5 });
  assert.equal(below.ok, false);
  assert.equal(below.code, 'ENTRY_EXEC_BELOW_STOP');
});

test('validateEntryGeometry: buffer scales the floor', () => {
  const v = validateEntryGeometry({ side: 'BUY', executablePrice: 101.0, invalidation: 100, bufferPct: 0.02 });
  assert.equal(v.ok, false, '101 < 100*1.02 = 102');
  assert.equal(v.requiredMin, 102);
});

test('validateEntryGeometry: shorts are explicitly unsupported, bad numbers rejected', () => {
  assert.equal(
    validateEntryGeometry({ side: 'SELL', executablePrice: 100, invalidation: 90, bufferPct: 0.001 }).code,
    'UNSUPPORTED_SIDE',
  );
  assert.equal(validateEntryGeometry({ side: 'BUY', executablePrice: NaN, invalidation: 90, bufferPct: 0.001 }).code, 'BAD_GEOMETRY');
  assert.equal(validateEntryGeometry({ side: 'BUY', executablePrice: 100, invalidation: 0, bufferPct: 0.001 }).code, 'BAD_GEOMETRY');
});

test('entryBandOverlapsStop: the three historical trades had the structural conflict', () => {
  for (const t of REPLAY) {
    assert.equal(
      entryBandOverlapsStop(t.bandLow, t.stop, 0.001), true,
      `${t.ticker} entry band low ${t.bandLow} dips below its stop ${t.stop}`,
    );
    // ...while their signal-time executable reference cleared the floor
    assert.equal(validateEntryGeometry({
      side: 'BUY', executablePrice: t.execRef, bandLow: t.bandLow,
      invalidation: t.stop, bufferPct: 0.001,
    }).code, 'ENTRY_BAND_OVERLAP_STOP', `${t.ticker} band overlap is reported as its own code`);
    assert.equal(validateEntryGeometry({
      side: 'BUY', executablePrice: t.execRef,
      invalidation: t.stop, bufferPct: 0.001,
    }).ok, true, `${t.ticker} executable reference itself is above the floor`);
  }
});

/* ------------------------------------------------------------------ */
/* 2. fill-time guard: reject before a position exists                 */
/* ------------------------------------------------------------------ */

function seedOrder(
  db_: ReturnType<typeof openCryptoDb>,
  o: { ticker: string; qty: number; limit: number; stop: number; cash?: number },
): number {
  const cash = o.cash ?? 100_000;
  db_.prepare(
    `INSERT INTO paper_portfolios (kind, start_capital, cash, created_at) VALUES ('CRYPTO_SPOT', 100000, ?, 1)
     ON CONFLICT(kind) DO UPDATE SET cash = excluded.cash`,
  ).run(cash);
  const res = db_.prepare(
    `INSERT INTO paper_orders (portfolio, signal_id, ticker, side, qty, limit_price, stop_price, status, fill_mode, created_at)
     VALUES ('CRYPTO_SPOT', NULL, ?, 'BUY', ?, ?, ?, 'PENDING', 'AT_SIGNAL', ?)`,
  ).run(o.ticker, o.qty, o.limit, o.stop, Date.now());
  return Number(res.lastInsertRowid);
}

test('a BUY fill below stop + buffer is REJECTED with a reason code; no position, no cash movement', async () => {
  const orderId = seedOrder(db, { ticker: 'GEO', qty: 10, limit: 106.9, stop: 105.73, cash: 100_000 });
  const cashBefore = (db.prepare("SELECT cash FROM paper_portfolios WHERE kind='CRYPTO_SPOT'").get() as { cash: number }).cash;
  const summary = await processOrders(
    db,
    provider([{ symbol: 'GEO', price: 105.4, bid: 105.35, ask: 105.5 }]),
    config,
    Date.now(),
  );
  assert.equal(summary.filled, 0, 'the invalid fill never executes');
  const order = db.prepare('SELECT status, fill_note FROM paper_orders WHERE id = ?').get(orderId) as { status: string; fill_note: string };
  assert.equal(order.status, 'REJECTED');
  assert.match(order.fill_note, /^ENTRY_EXEC_BELOW_STOP/);
  assert.equal(openPositions(db).filter((p) => p.ticker === 'GEO').length, 0, 'no position was opened');
  const cashAfter = (db.prepare("SELECT cash FROM paper_portfolios WHERE kind='CRYPTO_SPOT'").get() as { cash: number }).cash;
  assert.equal(cashAfter, cashBefore, 'cash untouched');
  const audit = db.prepare("SELECT detail_json FROM audit_log WHERE action='order_rejected' AND entity='order' ORDER BY ts DESC LIMIT 1").get() as { detail_json: string };
  assert.equal(JSON.parse(audit.detail_json).code, 'ENTRY_EXEC_BELOW_STOP');
});

test('the same fill passes when CRYPTO_ENTRY_STOP_GUARD=0 (rollback switch)', async () => {
  const off = cfg({ CRYPTO_ENTRY_STOP_GUARD: '0' });
  const orderId = seedOrder(db, { ticker: 'GEO2', qty: 10, limit: 106.9, stop: 105.73, cash: 100_000 });
  const summary = await processOrders(
    db,
    provider([{ symbol: 'GEO2', price: 105.4, bid: 105.35, ask: 105.5 }]),
    off,
    Date.now(),
  );
  assert.equal(summary.filled, 1, 'with the guard off, legacy behavior fills');
  const order = db.prepare('SELECT status FROM paper_orders WHERE id = ?').get(orderId) as { status: string };
  assert.equal(order.status, 'FILLED');
  // clean the flag-off artifacts so later assertions see a tidy book
  db.prepare("UPDATE paper_positions SET exit_ts = 1 WHERE ticker = 'GEO2'").run();
  db.prepare("DELETE FROM paper_orders WHERE ticker = 'GEO2'").run();
  db.prepare("DELETE FROM paper_positions WHERE ticker = 'GEO2'").run();
  db.prepare("DELETE FROM audit_log WHERE detail_json LIKE '%GEO2%'").run();
});

test('a healthy BUY fills normally: one position, cash reduced by notional + fee', async () => {
  db.prepare("UPDATE paper_portfolios SET cash = 100000 WHERE kind='CRYPTO_SPOT'").run();
  const orderId = seedOrder(db, { ticker: 'HEALTHY', qty: 10, limit: 110, stop: 105.73, cash: 100_000 });
  const summary = await processOrders(
    db,
    provider([{ symbol: 'HEALTHY', price: 106.9, bid: 106.85, ask: 106.9 }]),
    config,
    Date.now(),
  );
  assert.equal(summary.filled, 1);
  const order = db.prepare('SELECT status, fill_price, slippage FROM paper_orders WHERE id = ?').get(orderId) as { status: string; fill_price: number; slippage: number };
  assert.equal(order.status, 'FILLED');
  assert.ok(order.fill_price >= 106.85 && order.fill_price <= 106.91, 'filled on/near the ask');
  assert.ok(order.slippage >= 0);
  const positions = openPositions(db).filter((p) => p.ticker === 'HEALTHY');
  assert.equal(positions.length, 1, 'exactly one position');
  assert.equal(positions[0].qty, 10);
  const cash = (db.prepare("SELECT cash FROM paper_portfolios WHERE kind='CRYPTO_SPOT'").get() as { cash: number }).cash;
  const expected = 100_000 - (10 * order.fill_price) - (10 * order.fill_price * FEE);
  assert.ok(Math.abs(cash - expected) < 0.01, `cash ${cash} = 100k - notional - fee ${expected}`);
});

test('order states: PENDING until conditions met, REJECTED on cash, CANCELLED on missing position', async () => {
  // (a) ask above the BUY limit -> stays PENDING (submitted, not filled)
  const p1 = seedOrder(db, { ticker: 'WAIT1', qty: 1, limit: 100.0, stop: 95, cash: 100_000 });
  let s = await processOrders(db, provider([{ symbol: 'WAIT1', price: 101, bid: 100.9, ask: 101.1 }]), config, Date.now());
  assert.equal(s.pending, 1);
  assert.equal((db.prepare('SELECT status FROM paper_orders WHERE id=?').get(p1) as { status: string }).status, 'PENDING');

  // (b) insufficient cash -> REJECTED (acknowledged but never executed)
  const p2 = seedOrder(db, { ticker: 'POOR', qty: 100, limit: 110, stop: 105, cash: 50 });
  s = await processOrders(db, provider([{ symbol: 'POOR', price: 106.9, bid: 106.8, ask: 106.9 }]), config, Date.now());
  assert.equal((db.prepare('SELECT status, fill_note FROM paper_orders WHERE id=?').get(p2) as { status: string; fill_note: string }).status, 'REJECTED');

  // (c) SELL order with no open position -> CANCELLED
  db.prepare(
    `INSERT INTO paper_orders (portfolio, signal_id, ticker, side, qty, limit_price, stop_price, status, fill_mode, created_at)
     VALUES ('CRYPTO_SPOT', NULL, 'GHOST', 'SELL', 1, 100, NULL, 'PENDING', 'AT_SIGNAL', ?)`,
  ).run(Date.now());
  const p3 = (db.prepare("SELECT id FROM paper_orders WHERE ticker='GHOST'").get() as { id: number }).id;
  s = await processOrders(db, provider([{ symbol: 'GHOST', price: 100, bid: 99.9, ask: 100.1 }]), config, Date.now());
  assert.equal((db.prepare('SELECT status, fill_note FROM paper_orders WHERE id=?').get(p3) as { status: string; fill_note: string }).status, 'CANCELLED');
});

/* ------------------------------------------------------------------ */
/* 3. replay all three closed trades through the live exit path        */
/* ------------------------------------------------------------------ */

test('replay: OKB, NEAR and UNI exit STOP_REACHED with recorded slippage, fees and P&L', async () => {
  // fresh book: drop fixture positions/orders/trades from earlier tests
  db.prepare('DELETE FROM paper_positions').run();
  db.prepare('DELETE FROM paper_trades').run();
  db.prepare('DELETE FROM paper_orders').run();
  db.prepare("UPDATE paper_portfolios SET cash = 100000 WHERE kind='CRYPTO_SPOT'").run();
  const entryCost = REPLAY.reduce((s, t) => s + t.entry * t.qty + t.entryFee, 0);
  db.prepare("UPDATE paper_portfolios SET cash = ? WHERE kind='CRYPTO_SPOT'").run(100_000 - entryCost);

  for (const t of REPLAY) {
    db.prepare(
      `INSERT INTO paper_positions (portfolio, ticker, company, sector, qty, entry_price, entry_ts, entry_session,
         target, stop, trailing_stop, max_hold, sessions_held, mfe, mae, thesis_status, signal_id,
         current_price, last_update, predicted_return, entry_fee)
       VALUES ('CRYPTO_SPOT', ?, ?, 'Crypto', ?, ?, ?, 'DAY_0', ?, ?, NULL, 20, 0, 0, 0, 'INTACT', NULL, ?, ?, 0, ?)`,
    ).run(t.ticker, t.ticker, t.qty, t.entry, t.entryTs, t.target, t.stop, t.entry, t.entryTs, t.entryFee);
  }
  assert.equal(openPositions(db).length, 3);

  // one monitor pass: every quote sits at/below its stop — exits fire via
  // the production checkExit -> min(stop, bid) path (slippage preserved)
  const res = await monitorPositions(
    db,
    provider(REPLAY.map((t) => ({ symbol: t.ticker, price: t.exit, bid: t.exit, ask: t.exit }))),
    config,
    REPLAY[2].entryTs + 45 * 60_000,
  );
  assert.equal(res.exited, 3, 'all three stop out');
  assert.equal(openPositions(db).length, 0, 'no open positions remain');

  for (const t of REPLAY) {
    const trade = db.prepare(
      'SELECT exit_price, exit_reason, gross_pnl, net_pnl, return_pct, holding_sessions FROM paper_trades WHERE ticker = ? AND status = ?',
    ).get(t.ticker, 'CLOSED') as { exit_price: number; exit_reason: string; gross_pnl: number; net_pnl: number; return_pct: number; holding_sessions: number };
    assert.equal(trade.exit_reason, 'STOP_REACHED', `${t.ticker} exit reason`);
    assert.ok(Math.abs(trade.exit_price - t.exit) < 1e-9, `${t.ticker} exit price ${trade.exit_price} == recorded ${t.exit}`);
    assert.ok(Math.abs(trade.gross_pnl - t.gross) < 0.01, `${t.ticker} gross ${trade.gross_pnl} vs ${t.gross}`);
    assert.ok(Math.abs(trade.net_pnl - t.net) < 0.01, `${t.ticker} net ${trade.net_pnl} vs ${t.net}`);
    assert.ok(Math.abs(trade.return_pct - t.ret) < 1e-6, `${t.ticker} return ${trade.return_pct} vs ${t.ret}`);
    assert.equal(trade.holding_sessions, 0, `${t.ticker} same-session exit`);

    // fee arithmetic: net = gross - entryFee - exitFee(exit*qty*fee)
    const exitFee = t.exit * t.qty * FEE;
    assert.ok(Math.abs(trade.net_pnl - (t.gross - t.entryFee - exitFee)) < 0.01, `${t.ticker} fee-inclusive net`);
    // slippage contract: an exit may print below the stop (gap), never above it
    assert.ok(trade.exit_price <= t.stop + 1e-9, `${t.ticker} STOP exit never better than the stop`);
    if (t.slippageBelowStop) assert.ok(trade.exit_price < t.stop, `${t.ticker} gap through the stop preserved`);
  }

  // cash reconciles: start - entry costs + exit proceeds - exit fees
  const exitFees = REPLAY.reduce((s, t) => s + t.exit * t.qty * FEE, 0);
  const exitProceeds = REPLAY.reduce((s, t) => s + t.exit * t.qty, 0);
  const cash = (db.prepare("SELECT cash FROM paper_portfolios WHERE kind='CRYPTO_SPOT'").get() as { cash: number }).cash;
  assert.ok(Math.abs(cash - (100_000 - entryCost + exitProceeds - exitFees)) < 0.01, `cash ${cash}`);
});

test('position state consistency: closed trades and positions mirror, no duplicate opens', () => {
  const closed = (db.prepare("SELECT COUNT(*) c FROM paper_positions WHERE exit_ts IS NOT NULL").get() as { c: number }).c;
  const trades = (db.prepare("SELECT COUNT(*) c FROM paper_trades WHERE status='CLOSED'").get() as { c: number }).c;
  assert.equal(closed, trades, 'every closed position has exactly one trade row');
  const dupes = db
    .prepare('SELECT ticker, COUNT(*) c FROM paper_positions WHERE exit_ts IS NULL GROUP BY ticker HAVING c > 1')
    .all();
  assert.equal(dupes.length, 0, 'never two open positions on one ticker');
});

test('current behavior: broker-level re-entry after a stop-out is allowed (cooldown is engine/session-scoped only)', async () => {
  // Documents the item-8 finding: nothing at broker level blocks a fresh
  // order for a just-stopped ticker; the only brakes are the engine's
  // one-signal-per-session dedup and the held set. Wall-clock cooldown =
  // proposal, not implemented.
  const orderId = seedOrder(db, { ticker: 'UNI', qty: 1442, limit: 7.1, stop: 6.7681, cash: 100_000 });
  const s = await processOrders(
    db,
    provider([{ symbol: 'UNI', price: 6.9113, bid: 6.91, ask: 6.9113 }]),
    config,
    Date.now(),
  );
  assert.equal(s.filled, 1, 'immediate re-entry fills today — documented, not changed');
  assert.equal((db.prepare('SELECT status FROM paper_orders WHERE id=?').get(orderId) as { status: string }).status, 'FILLED');
  const open = openPositions(db).filter((p) => p.ticker === 'UNI');
  assert.equal(open.length, 1);
  assert.ok(open[0].entry_price > open[0].stop, 'new entry at least sits above its stop');
});

/* ------------------------------------------------------------------ */
/* 4. signal age / stale data                                          */
/* ------------------------------------------------------------------ */

test('stale data quality vetoes entry; healthy data passes', () => {
  const candidate = {
    ticker: 'X', sector: 'Crypto', price: 100, entryLow: 99,
    invalidation: 97, target: 110, confidence: 0.8, horizon: 'SHORT' as const,
  };
  const limits = {
    riskPerTradePct: 0.0075, maxPositionPct: 0.1, maxCorrelatedPct: 1,
    maxSectorPct: 1, minRiskReward: 1.5, maxEarningsDays: 3,
  };
  const base = {
    liquidityScore: 0.5, volatilityPct: 0.03, regime: 'UNCERTAIN' as const,
    killSwitchActive: false, earningsWithinDays: 9999,
  };
  const portfolio = { equity: 100_000, cash: 100_000, openPositions: [], currentDrawdownPct: 0 };

  const stale = evaluateEntry(
    portfolio, candidate, limits,
    { ...base, dataQuality: { stale: true, disagreement: false, missing: false } },
  );
  assert.equal(stale.approved, false);
  assert.ok(stale.reasons.includes('data quality gate'));

  const fresh = evaluateEntry(
    portfolio, candidate, limits,
    { ...base, dataQuality: { stale: false, disagreement: false, missing: false } },
  );
  assert.equal(fresh.approved, true, 'fresh, liquid, sane-RR candidate passes');
  assert.ok(fresh.sizeShares > 0);
});

/* ------------------------------------------------------------------ */
/* 5. trailing stop + protective exits (stops never disabled)          */
/* ------------------------------------------------------------------ */

function exitPos(over: Partial<Parameters<typeof checkExit>[0]> = {}): Parameters<typeof checkExit>[0] {
  return {
    side: 'LONG', entryPrice: 100, qty: 1, target: 130, stop: 95,
    trailingStop: null, maxHoldSessions: 20, sessionsHeld: 0,
    thesisInvalidated: false, sellSignal: false, regimeChanged: false,
    ...over,
  };
}

test('checkExit: protective exit set fires in documented priority order', () => {
  const bar = { open: 100, high: 101, low: 99, close: 100.5, date: '2026-11-05' };
  assert.equal(checkExit(exitPos(), bar), null, 'hold');

  // stop beats everything — including a same-bar target touch (conservative)
  assert.equal(
    checkExit(exitPos({ target: 99.5 }), { ...bar, low: 94.9, high: 99.6 }),
    'STOP_REACHED',
    'stop priority over target',
  );
  assert.equal(checkExit(exitPos(), { ...bar, low: 94.9 }), 'STOP_REACHED');
  assert.equal(checkExit(exitPos({ thesisInvalidated: true }), bar), 'THESIS_INVALIDATED');
  assert.equal(checkExit(exitPos({ sellSignal: true }), bar), 'SELL_SIGNAL');
  assert.equal(checkExit(exitPos({ sessionsHeld: 20 }), bar), 'TIME_LIMIT');
  // trailing stop: only after MFE ratchets it up
  assert.equal(checkExit(exitPos({ trailingStop: 108 }), { ...bar, low: 107.9 }), 'TRAILING_STOP');
  assert.equal(checkExit(exitPos({ trailingStop: 108 }), { ...bar, low: 106 }), 'TRAILING_STOP');
  // gap through the stop still exits (low <= stop)
  assert.equal(checkExit(exitPos(), { ...bar, open: 90, low: 90, close: 92 }), 'STOP_REACHED');
});

/* ------------------------------------------------------------------ */
/* 6. fixed-horizon accuracy module (structure + no look-ahead)        */
/* ------------------------------------------------------------------ */

test('evaluateFixedHorizons: horizons, baselines and no-look-ahead structure', () => {
  // seed one 1d-elapsed signal whose next-day bar exists
  upsertBar(db, 'ACCT', { date: '2026-11-04', open: 100, high: 101, low: 99, close: 100, volume: 10 });
  upsertBar(db, 'ACCT', { date: '2026-11-05', open: 100, high: 105, low: 99, close: 104, volume: 10 });
  upsertBar(db, 'ACCT', { date: '2026-11-06', open: 104, high: 106, low: 103, close: 105, volume: 10 });
  db.prepare(
    `INSERT INTO signals (ticker, company, sector, portfolio, strategy, strategy_version, model_version,
       horizon, signal, confidence, price, entry_low, entry_high, target, invalidation, expected_return,
       risk_reward, expected_hold, max_hold, session, session_date, created_at, regime, evidence_json,
       contradictions_json, scores_json, data_freshness, risk_checks_json, audit_json,
       knowledge_refs_json, event_refs_json, llm_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run('ACCT', 'ACCT', 'Crypto', 'CRYPTO_SPOT', 'crypto_momentum_v1', '1.0.0', 'crypto_v1',
    'SHORT', 'BUY', 0.8, 100, 99.5, 100.5, 110, 97, 0.1, 3, 5, 20, 'MARKET_OPEN', '2026-11-05',
    Date.parse('2026-11-05T12:00:00Z'), 'UNCERTAIN', '[]', '[]', '{}', 1, '[]', '{}', '[]', '[]', null);

  const report = evaluateFixedHorizons(db, Date.parse('2026-11-07T00:00:00Z'));
  assert.equal(report.horizons.length, 5);
  assert.deepEqual(report.horizons.map((h) => h.key), ['30s', '60s', '5m', '30m', '1d']);
  for (const h of report.horizons) {
    assert.ok(h.baselines.alwaysUp.pct === null || (h.baselines.alwaysUp.pct! + h.baselines.alwaysDown.pct! === 1));
    assert.ok('BUY' in h.accuracy && 'SELL' in h.accuracy, 'sides reported separately');
  }
  const d1 = report.horizons.find((h) => h.key === '1d')!;
  assert.equal(d1.evaluated, 1, 'the 1d horizon elapsed and a bar exists');
  assert.equal(d1.source, 'daily_bar');
  const row = report.detail.find((r) => r.horizon === '1d')!;
  assert.equal(row.observedPrice, 105, 'outcome is the FIRST bar at/after the horizon date (no look-ahead)');
  assert.equal(row.predicted, 'UP');
  assert.equal(row.actual, 'UP');
  assert.equal(row.correct, true);
  assert.ok(row.observedTs >= Date.parse('2026-11-06T00:00:00Z'), 'observed at/after the 24h horizon');
  // sub-minute horizons report noData honestly (no snapshots in this test DB)
  for (const h of ['30s', '60s', '5m', '30m']) {
    const hh = report.horizons.find((x) => x.key === h)!;
    assert.equal(hh.evaluated, 0, `${h} has no micro_snapshots in this db`);
    assert.ok(hh.noData >= 0);
  }
});

test('guard flags on the default config', () => {
  const c = cryptoConfigFromEnv({});
  assert.equal(c.entryStopGuard, true, 'guard defaults ON (approved fix)');
  assert.equal(c.entryStopBufferPct, 0.001, 'default 10bps buffer');
});