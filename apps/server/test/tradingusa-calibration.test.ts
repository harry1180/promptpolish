/**
 * Outcome calibration (SHADOW): closed trades + their signals fit a
 * confidence->win-rate map and a shrunk expected-return model; the daily
 * refresh persists it; every new signal records what it is worth; the HTTP
 * surface serves it read-only. Nothing here gates a trade.
 *
 * All network access is injected — no test touches the internet.
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/index.ts';
import { openDb } from '../src/db.ts';
import { openTradingDb } from '../src/tradingusa/schema.ts';
import { tuConfigFromEnv } from '../src/tradingusa/config.ts';
import { ensurePortfolios } from '../src/tradingusa/broker.ts';
import { runScan } from '../src/tradingusa/engine.ts';
import { tradableUniverse } from '../src/tradingusa/universe.ts';
import { computeCalibration, loadCalibration, recomputeCalibration } from '../src/tradingusa/calibration.ts';
import { refreshKnowledge } from '../src/tradingusa/adaptive.ts';
import type { MarketDataProvider, Quote } from '@promptslim/tucore';

const NOW = Date.parse('2026-11-24T21:00:00Z');
const DAY = 86_400_000;
const SHORT = 'st_multi_factor_v1';

/** 12 closed outcomes: high confidence LOSES (production's shape), forecast
 *  always claims +5%. */
function seedOutcomes(db: DatabaseSync): void {
  const sig = db.prepare(
    `INSERT INTO signals (ticker, company, sector, portfolio, strategy, strategy_version, model_version,
       horizon, signal, confidence, price, entry_low, entry_high, target, invalidation, expected_return,
       risk_reward, expected_hold, max_hold, session, session_date, created_at, regime, scores_json,
       audit_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const trade = db.prepare(
    `INSERT INTO paper_trades (portfolio, ticker, company, sector, side, qty, entry_price, entry_ts,
       exit_price, exit_ts, exit_reason, capital, gross_pnl, net_pnl, return_pct, benchmark_return,
       excess_return, holding_sessions, mfe, mae, predicted_return, actual_return, prediction_error,
       signal_id, strategy, strategy_version, status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  for (let i = 0; i < 12; i++) {
    const high = i % 2 === 1;
    const confidence = high ? 0.8 : 0.55;
    const actual = high ? -0.02 : 0.03;
    const res = sig.run(
      `T${i}`, `T${i} Co`, 'Technology', 'SHORT_TERM_PORTFOLIO', SHORT, '1.0.0', 'st_mf_v1',
      'SHORT', 'BUY', confidence, 100, 99, 101, 110, 95, 0.05, 2, 5, 10, 'MARKET_OPEN',
      '2026-11-01', NOW - (i + 1) * DAY, 'BULL_TREND', '{}', '{}',
    );
    trade.run(
      'SHORT_TERM_PORTFOLIO', `T${i}`, `T${i} Co`, 'Technology', 'LONG', 10, 100, NOW - (i + 2) * DAY,
      100 + actual * 100, NOW - (i + 1) * DAY, 'TARGET_REACHED', 1000, actual * 1000, actual * 1000,
      actual, 0, actual, 1, 0, 0, 0.05, actual, 0.05 - actual, Number(res.lastInsertRowid),
      SHORT, '1.0.0', 'CLOSED',
    );
  }
}

test('computeCalibration fits the book\'s own outcomes; refresh persists it', () => {
  const db = openTradingDb(':memory:');
  try {
    seedOutcomes(db);
    const cal = computeCalibration(db, NOW);
    assert.equal(cal.n, 12);
    assert.equal(cal.sufficient, true, '12 closed outcomes clears the 10-trade floor');
    assert.equal(loadCalibration(db), null, 'nothing persisted until the refresh runs');

    const stored = recomputeCalibration(db, NOW);
    assert.equal(stored.samples, 12);
    const row = loadCalibration(db);
    assert.ok(row, 'daily refresh stores the fitted model');
    assert.equal(row!.n, 12);
    assert.ok(row!.priorWinRate > 0 && row!.priorWinRate < 1);

    const refreshed = refreshKnowledge(db, NOW);
    assert.equal(refreshed.calibrationSamples, 12, 'the daily job reports the calibration sample');
    assert.equal(refreshed.calibrationSufficient, true);
    const kinds = (db.prepare('SELECT kind FROM learning_events ORDER BY id').all() as unknown as Array<{ kind: string }>)
      .map((r) => r.kind);
    assert.ok(kinds.includes('KNOWLEDGE_REFRESH'), 'the refresh stays auditable');
  } finally {
    db.close();
  }
});

/* ---- integration: runScan stamps the shadow value on new signals ---- */

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
  const end = Date.parse('2026-11-24T00:00:00Z');
  for (const ticker of tickers) {
    let price = 100;
    for (let i = 140; i >= 0; i--) {
      const date = new Date(end - i * DAY).toISOString().slice(0, 10);
      const open = price;
      price = price * 1.012;
      const low = Math.min(open, price) * 0.992;
      stmt.run(ticker, date, open, price, low, price, 1_200_000 + (i % 7) * 150_000, 'test', NOW);
    }
    quote.run(ticker, price, price / 1.012, NOW, 'test', 'DELAYED');
  }
}

test('runScan records the calibrated worth of a signal (shadow, never a gate)', async () => {
  const config = tuConfigFromEnv({ TU_MIN_SIGNAL_CONFIDENCE: '0.5', TU_MIN_RISK_REWARD: '1' });
  const db = openTradingDb(':memory:');
  try {
    ensurePortfolios(db, config);
    seedUniverse(db);
    recomputeCalibration(db, NOW); // empty book -> stored, insufficient

    const scan = await runScan({ db, provider: stubProvider, config, now: NOW });
    assert.ok(scan.signalsCreated > 0, `seeded tape must produce signals, got ${scan.signalsCreated}`);

    const rows = db.prepare('SELECT audit_json FROM signals').all() as unknown as Array<{ audit_json: string }>;
    let seen = 0;
    for (const r of rows) {
      const audit = JSON.parse(r.audit_json) as { calibration?: { sufficient: boolean; winRate: number } | null };
      assert.ok('calibration' in audit, 'every signal carries the shadow calibration key');
      if (audit.calibration) {
        seen += 1;
        assert.equal(audit.calibration.sufficient, false, 'an unfitted book reports insufficient');
        assert.ok(audit.calibration.winRate >= 0 && audit.calibration.winRate <= 1);
      }
    }
    assert.ok(seen > 0, 'with a stored row every new signal records its calibrated worth');
  } finally {
    db.close();
  }
});

/* ---- HTTP: the fitted map is served read-only ---- */

let server: Server;
let base: string;
let dir: string;

before(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'tu-calibration-'));
  const dbFile = path.join(dir, 'tradingusa.db');
  const seed = openTradingDb(dbFile);
  seedOutcomes(seed);
  recomputeCalibration(seed, NOW);
  seed.close();

  server = createApp(openDb(':memory:'), { dbPath: ':memory:', tuDbPath: dbFile });
});

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

test('GET /api/tradingusa/calibration serves the shadow map read-only', async () => {
  const res = await fetch(base + '/api/tradingusa/calibration');
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, any>;
  assert.equal(body.mode, 'SHADOW');
  assert.equal(body.sufficient, true);
  assert.equal(body.samples, 12);
  assert.ok(body.buckets.length >= 3, 'confidence buckets are exposed');
  assert.ok(body.mapping.some((m: { confidence: number; calibratedWinRatePct: number }) => m.confidence === 0.8),
    'a mapping from raw confidence to calibrated win rate is served');
  assert.ok(typeof body.returnModel.slope === 'number');
});
