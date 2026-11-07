/**
 * Crypto paper broker + the learning loop wired to the CRYPTO database.
 *
 * Proves the three things the module promises: fee-aware spot fills in a
 * PAPER_ONLY book, fee-inclusive outcome accounting (what a real account
 * would have seen), and that the shared learning/experiment modules run
 * unchanged against /data/crypto.db — so crypto mistakes feed crypto lessons
 * and crypto weight refits, never the equities book's.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Quote, Candle } from '@promptslim/tucore';
import { openCryptoDb } from '../src/crypto/schema.ts';
import { cryptoConfigFromEnv } from '../src/crypto/config.ts';
import {
  ensureSpotPortfolio, simulateCryptoFill, processOrders, closePosition,
  loadBars, upsertBar, CRYPTO_PORTFOLIO, CRYPTO_BENCHMARK,
} from '../src/crypto/broker.ts';
import { seedStates, decideUniverse, fetchRanking, fetchTradable } from '../src/crypto/universe.ts';
import { KrakenProvider } from '../src/crypto/providers/kraken-provider.ts';
import { learnFromOutcome } from '../src/tradingusa/adaptive.ts';
import { experimentSummary } from '../src/tradingusa/experiments.ts';

const dir = mkdtempSync(join(tmpdir(), 'crypto-'));
const dbPath = join(dir, 'crypto.db');

function stubProvider(quotes: Quote[]): KrakenProvider {
  return new KrakenProvider({
    tickers: (async () => quotes) as never,
    bars: (async () => [] as Candle[]) as never,
  });
}

function insertSignal(db: ReturnType<typeof openCryptoDb>, sessionDate: string): number {
  const res = db.prepare(
    `INSERT INTO signals (ticker, company, sector, portfolio, strategy, strategy_version, model_version,
      horizon, signal, confidence, price, entry_low, entry_high, target, invalidation, expected_return,
      risk_reward, expected_hold, max_hold, session, session_date, created_at, regime, evidence_json,
      contradictions_json, scores_json, data_freshness, risk_checks_json, audit_json, knowledge_refs_json,
      event_refs_json, llm_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    'BTC', 'Bitcoin', 'Crypto', CRYPTO_PORTFOLIO, 'crypto_momentum_v1', '1.0.0', 'test',
    'SHORT', 'BUY', 0.8, 100, 99, 101, 130, 95, 0.3, 3.5, 5, 20, 'MARKET_OPEN',
    sessionDate, Date.now(), 'MOMENTUM',
    JSON.stringify([{ kind: 'breakout', detail: 'breakout above 20d high on 1.40x volume', weight: 0.75, positive: true }]),
    '[]', JSON.stringify({ technical: 1, fundamental: 0, event: 0, sentiment: 0, macro: 0, regime: 0.5, risk: 0 }),
    1, '[]', JSON.stringify({ entryChecks: { relativeVolume: 1.4 } }), '[]', '[]', null,
  );
  return Number(res.lastInsertRowid);
}

function insertPendingOrder(db: ReturnType<typeof openCryptoDb>, signalId: number, qty: number, limit: number, stop: number): number {
  // stop = the signal's invalidation (what production stores in stop_price);
  // it must sit BELOW the expected fill or the entry-geometry guard rejects
  // the order as structurally invalid — which is correct behavior.
  const res = db.prepare(
    `INSERT INTO paper_orders (portfolio, signal_id, ticker, side, qty, limit_price, stop_price, status, fill_mode, created_at)
     VALUES (?,?,?,?,?,?,?,'PENDING','AT_SIGNAL',?)`,
  ).run(CRYPTO_PORTFOLIO, signalId, 'BTC', 'BUY', qty, limit, stop, Date.now());
  return Number(res.lastInsertRowid);
}

test('fee-aware fills: buy the ask, charge the exchange fee on both sides', () => {
  const withBook = simulateCryptoFill({
    side: 'BUY', qty: 2, price: 100, bid: 99.9, ask: 100.1, feePct: 0.0025, liquidityScore: 0.9,
  });
  assert.equal(withBook.filled, true);
  assert.equal(withBook.price, 100.1, 'buys lift the ask, never the mid');
  assert.ok(Math.abs(withBook.fee - 100.1 * 2 * 0.0025) < 1e-9, 'fee = notional x feePct');

  const noBook = simulateCryptoFill({
    side: 'SELL', qty: 1, price: 100, feePct: 0.0025, liquidityScore: 0.2,
  });
  assert.ok(noBook.price < 100, 'thin book without quotes -> slippage on the sell');
  assert.ok(noBook.fee > 0, 'fee still charged');

  const bad = simulateCryptoFill({ side: 'BUY', qty: 0, price: 100, feePct: 0.0025, liquidityScore: 1 });
  assert.equal(bad.filled, false, 'degenerate requests are rejected, not filled');
});

test('the crypto DB can be reopened (entry_fee column is added exactly once)', () => {
  const first = openCryptoDb(dbPath);
  const cols = first.prepare('PRAGMA table_info(paper_positions)').all() as unknown as Array<{ name: string }>;
  assert.ok(cols.some((c) => c.name === 'entry_fee'), 'crypto positions carry their entry fee');
  first.close();

  const second = openCryptoDb(dbPath); // must not throw "duplicate column name"
  const tables = second.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN
    ('crypto_universe','crypto_universe_log','signals','paper_trades','strategy_weights','knowledge_lessons')`).get() as { n: number };
  assert.equal(tables.n, 6, 'crypto tables + the shared learning tables all exist');
  second.close();
});

test('a round trip is fee-inclusive and the learning loop sees it', async () => {
  const db = openCryptoDb(dbPath);
  try {
    const config = cryptoConfigFromEnv({ CRYPTO_CAPITAL: '100000', CRYPTO_FEE_PCT: '0.0025' });
    ensureSpotPortfolio(db, config);
    for (let i = 0; i < 60; i++) {
      const date = new Date(Date.now() - (60 - i) * 86_400_000).toISOString().slice(0, 10);
      upsertBar(db, 'BTC', { date, open: 100, high: 104, low: 96, close: 100 + i * 0.5, volume: 1000 });
      upsertBar(db, CRYPTO_BENCHMARK, { date, open: 100, high: 104, low: 96, close: 100 + i * 0.5, volume: 1000 });
    }

    const signalId = insertSignal(db, new Date().toISOString().slice(0, 10));
    insertPendingOrder(db, signalId, 10, 120, 95); // limit above price, stop = signal invalidation (95) below the fill

    const provider = stubProvider([{ symbol: 'BTC', price: 100, prevClose: 99, ts: Date.now(), bid: 99.9, ask: 100.1, provider: 'kraken', freshness: 'REALTIME' }]);
    const summary = await processOrders(db, provider, config);
    assert.equal(summary.filled, 1, 'the entry filled');

    const cashAfterBuy = (db.prepare('SELECT cash FROM paper_portfolios WHERE kind = ?').get(CRYPTO_PORTFOLIO) as { cash: number }).cash;
    const expectedCash = 100000 - (100.1 * 10 + 100.1 * 10 * 0.0025);
    assert.ok(Math.abs(cashAfterBuy - expectedCash) < 1e-6, `cash must drop by notional + fee, got ${cashAfterBuy}`);

    const pos = db.prepare('SELECT * FROM paper_positions WHERE exit_ts IS NULL').get() as { entry_fee: number; entry_price: number };
    assert.ok(Math.abs(pos.entry_fee - 100.1 * 10 * 0.0025) < 1e-6, 'entry fee recorded on the position');

    // backdate the entry so the BTC benchmark window is non-empty
    // (same-day entry+exit compares a bar against itself -> 0 by design)
    db.prepare('UPDATE paper_positions SET entry_ts = ? WHERE exit_ts IS NULL')
      .run(Date.now() - 10 * 86_400_000);
    closePosition(db, config, { ticker: 'BTC', qty: 10, exitPrice: 110, exitTs: Date.now(), reason: 'TARGET_REACHED' });
    const trade = db.prepare('SELECT * FROM paper_trades WHERE status = ? ORDER BY id DESC LIMIT 1').get('CLOSED') as
      { gross_pnl: number; net_pnl: number; return_pct: number; benchmark_return: number };

    const gross = (110 - pos.entry_price) * 10;
    const entryFee = pos.entry_fee;
    const exitFee = 110 * 10 * 0.0025;
    assert.ok(Math.abs(trade.gross_pnl - gross) < 1e-6, 'gross is price-only');
    assert.ok(Math.abs(trade.net_pnl - (gross - entryFee - exitFee)) < 1e-6,
      'net is gross minus BOTH fees');
    assert.ok(trade.return_pct < gross / (pos.entry_price * 10),
      'return_pct is fee-inclusive, so it is smaller than the raw move');
    assert.ok(trade.benchmark_return !== 0, 'benchmark is BTC over the window');

    // the shared learning loop, pointed at the CRYPTO database
    const tradeId = (db.prepare('SELECT MAX(id) AS id FROM paper_trades').get() as { id: number }).id;
    const outcome = learnFromOutcome(db, tradeId);
    assert.equal(outcome.won, true, 'a winning crypto trade is recorded as an outcome');
    const events = db.prepare(`SELECT kind, COUNT(*) AS n FROM learning_events WHERE kind = 'OUTCOME_RECORDED' GROUP BY 1`).get() as { n: number } | undefined;
    assert.ok((events?.n ?? 0) > 0, 'the crypto book has its own OUTCOME_RECORDED events');

    const exp = experimentSummary(db, new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10), new Date().toISOString().slice(0, 10));
    assert.ok(exp.conditions.length >= 6, 'shadow experiments run against the crypto book');
    assert.equal(exp.closedTrades, 1, 'its one closed trade is counted here, not in the equities book');
    assert.match(exp.note, /Shadow mode/);
  } finally {
    db.close();
  }
});

test('universe hysteresis: a ranked member needs 7 days outside the top band to leave', () => {
  const ranking = [
    { symbol: 'BTC', rank: 1, marketCap: 1e12 }, { symbol: 'ETH', rank: 2, marketCap: 3e11 },
    { symbol: 'XRP', rank: 3, marketCap: 1e11 }, { symbol: 'DOGE', rank: 4, marketCap: 5e10 },
    { symbol: 'XLM', rank: 5, marketCap: 4e10 }, { symbol: 'SHIB', rank: 6, marketCap: 3e10 },
    { symbol: 'SOL', rank: 7, marketCap: 2e10 }, { symbol: 'NEW', rank: 8, marketCap: 1e10 },
  ];
  const states = seedStates(ranking);
  assert.ok(states.some((s) => s.symbol === 'BTC' && s.pinned && s.active));

  // SOL falls out of the band today: clock starts, member stays
  const t1 = Date.now();
  const away = ranking.map((c) => (c.symbol === 'SOL' ? { ...c, rank: 999 } : c));
  const first = decideUniverse(states, away, t1);
  assert.ok(first.symbols.includes('SOL'), 'one bad day does not evict a member');
  assert.ok(first.dropped.length === 0);

  // still out 6 days later -> stays; out at 7 days -> leaves
  const second = decideUniverse(first.states, away, t1 + 6 * 86_400_000);
  assert.ok(second.symbols.includes('SOL'), 'day 6: still a member');
  const third = decideUniverse(second.states, away, t1 + 7 * 86_400_000);
  assert.ok(!third.symbols.includes('SOL'), 'day 7: dropped');
  assert.deepEqual(third.dropped, ['SOL']);
  assert.ok(third.symbols.includes('BTC'), 'pinned members are never dropped');
});
