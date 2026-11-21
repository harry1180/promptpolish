/**
 * Entry gates + risk shape for the spot paper strategy `crypto_momentum_v1`:
 * the ATR stop, the hard dollar risk cap, the walk-forward entry threshold and
 * the multi-venue/pullback confirmation gate, plus the trailing exit.
 *
 * Everything here is PAPER/SHADOW: the gates decide paper orders only, and the
 * invariant at the bottom proves that with no gate data present (no tape, no
 * venue samples, no recorded history) the scan creates exactly the same orders
 * as before they existed — a gate may never change a trade by accident.
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
  ensureSpotPortfolio, upsertBar, monitorPositions, CRYPTO_PORTFOLIO, CRYPTO_BENCHMARK,
} from '../src/crypto/broker.ts';
import { atrStopGeometry, runCryptoScan } from '../src/crypto/engine.ts';
import { entryMove, entryThreshold, evaluateThreshold } from '../src/crypto/calibrate.ts';
import { evaluateConfirmation, requiredPullback } from '../src/crypto/confirm.ts';
import { TickTape } from '../src/crypto/tape.ts';
import { KrakenProvider } from '../src/crypto/providers/kraken-provider.ts';
import { ensureXchangeTables, insertSamples } from '../src/xchange/store.ts';

const dir = mkdtempSync(join(tmpdir(), 'crypto-entrygate-'));
const dbPath = join(dir, 'crypto.db');

function quote(symbol: string, price: number): Quote {
  return {
    symbol, price, prevClose: price, ts: Date.now(),
    provider: 'kraken', freshness: 'REALTIME',
    bid: price * 0.999, ask: price * 1.001,
  } as Quote;
}

function providerFor(...prices: Array<[string, number]>): KrakenProvider {
  return new KrakenProvider({
    tickers: (async () => prices.map(([s, p]) => quote(s, p))) as never,
    bars: (async () => [] as Candle[]) as never,
  });
}

/** rising daily tape, universe of two active coins + the BTC benchmark */
function seedBook(db: ReturnType<typeof openCryptoDb>): void {
  const now = Date.now();
  for (const [symbol, pinned] of [['BTC', 1], ['ETH', 0]] as Array<[string, number]>) {
    db.prepare('INSERT INTO crypto_universe (symbol, pinned, active, added_at, updated_at) VALUES (?,?,?,?,?)')
      .run(symbol, pinned, 1, now, now);
  }
  const end = Date.parse('2026-11-03T00:00:00Z');
  const write = (ticker: string): void => {
    let price = 100;
    for (let i = 140; i >= 0; i--) {
      const date = new Date(end - i * 86_400_000).toISOString().slice(0, 10);
      const open = price;
      price = price * 1.012;
      upsertBar(db, ticker, { date, open, high: price, low: open * 0.992, close: price, volume: 1_500_000 });
    }
  };
  write('BTC'); write('ETH'); write(CRYPTO_BENCHMARK);
}

/* ------------------------------------------------------------------ */
/* 1. the volatility-scaled stop                                       */
/* ------------------------------------------------------------------ */

test('atrStopGeometry scales with ATR and respects the floor/ceiling', () => {
  const cfg = cryptoConfigFromEnv({});
  assert.equal(cfg.stop.mode, 'atr', 'ATR stop is the shipped default');
  assert.equal(cfg.stop.atrMultiple, 0.5);
  assert.equal(cfg.stop.maxPct, 0.04);

  // 5% daily ATR -> 0.5 x = 2.5%, inside the clamps (1e-6 tolerance: the stop
  // carries a deliberate 1e-9 clearance so the sane gate's 0.5% floor is met
  // in floating point — see atrStopGeometry)
  const mid = atrStopGeometry(100, 5, cfg.stop);
  assert.ok(mid);
  assert.ok(Math.abs((mid?.stopPct ?? 0) - 2.5) < 1e-6, `got ${mid?.stopPct}`);
  assert.ok(Math.abs((mid?.stop ?? 0) - 97.5) < 1e-6, `got ${mid?.stop}`);

  // 12% daily ATR -> capped at 4%
  assert.ok(Math.abs((atrStopGeometry(100, 12, cfg.stop)?.stopPct ?? 0) - 4) < 1e-6);
  // 0.6% daily ATR -> floored at 0.5%
  assert.ok(Math.abs((atrStopGeometry(100, 0.6, cfg.stop)?.stopPct ?? 0) - 0.5) < 1e-6);

  assert.equal(atrStopGeometry(0, 4, cfg.stop), null, 'no price -> null');
  assert.equal(atrStopGeometry(100, 0, cfg.stop), null, 'no ATR -> null');
});

test('the ATR stop is far tighter than the geometry-C stop it replaces', () => {
  const cfg = cryptoConfigFromEnv({});
  // measured on the 14 closed trades: ATR14/price 4.9-12.4%, hold 2-5 sessions
  for (const [atrPct, hold] of [[0.049, 5], [0.089, 5], [0.1235, 5]] as Array<[number, number]>) {
    const atrStop = atrStopGeometry(100, atrPct * 100, cfg.stop);
    const sigmaH = atrPct * Math.sqrt(hold) * 100; // geometry C stop depth, %
    assert.ok(atrStop, 'geometry produced');
    assert.ok((atrStop?.stopPct ?? 0) <= 4.0001, 'shipped stop is capped at 4%');
    assert.ok((atrStop?.stopPct ?? 0) < sigmaH, `${atrStop?.stopPct}% < geometry C ${sigmaH}%`);
  }
});

test('CRYPTO_STOP_MODE=sigmah restores the approved geometry stop', () => {
  assert.equal(cryptoConfigFromEnv({ CRYPTO_STOP_MODE: 'sigmah' }).stop.mode, 'sigmah');
  assert.equal(cryptoConfigFromEnv({ CRYPTO_STOP_MODE: 'atr' }).stop.mode, 'atr');
  assert.equal(cryptoConfigFromEnv({}).stop.mode, 'atr');
  const wide = cryptoConfigFromEnv({ CRYPTO_STOP_ATR_MULTIPLE: '3', CRYPTO_STOP_MAX_PCT: '0.2' }).stop;
  assert.equal(wide.atrMultiple, 3);
  assert.ok(Math.abs((atrStopGeometry(100, 5, wide)?.stopPct ?? 0) - 15) < 1e-6,
    `knob really reaches the stop: ${atrStopGeometry(100, 5, wide)?.stopPct}`);
});

/* ------------------------------------------------------------------ */
/* 2. hard per-trade dollar risk cap                                   */
/* ------------------------------------------------------------------ */

test('CRYPTO_MAX_RISK_USD caps shares so risk at the stop cannot exceed it', async () => {
  const base = { CRYPTO_CAPITAL: '100000', CRYPTO_MIN_SIGNAL_CONFIDENCE: '0.5', CRYPTO_MIN_RISK_REWARD: '1' };
  const run = async (extra: Record<string, string>) => {
    const path = `${dbPath}-cap-${Object.keys(extra).join('-') || 'default'}-${Math.random().toString(36).slice(2, 7)}`;
    const db = openCryptoDb(path);
    try {
      const config = cryptoConfigFromEnv({ ...base, ...extra });
      ensureSpotPortfolio(db, config);
      seedBook(db);
      const res = await runCryptoScan({
        db, provider: providerFor(['BTC', 76000], ['ETH', 2240]),
        config, now: Date.parse('2026-11-03T12:00:00Z'),
      });
      const orders = db.prepare(`SELECT qty, stop_price, limit_price FROM paper_orders WHERE side = 'BUY'`).all() as Array<{
        qty: number; stop_price: number;
      }>;
      const gate = db.prepare(
        `SELECT json_extract(detail_json,'$.code') AS code, json_extract(detail_json,'$.maxRiskUsd') AS cap
           FROM audit_log WHERE action = 'entry_gate' ORDER BY id DESC`,
      ).all() as Array<{ code: string; cap: number }>;
      return { res, orders, gate };
    } finally {
      db.close();
      rmSync(path, { force: true });
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
    }
  };

  const normal = await run({});
  assert.equal(normal.res.ordersCreated, 1, 'baseline: one BUY order is created');
  const stopDist = 2240 - normal.orders[0].stop_price;
  const riskAtStop = normal.orders[0].qty * stopDist;

  // a cap that binds: shares shrink until shares * stopDistance <= 20
  const capped = await run({ CRYPTO_MAX_RISK_USD: '20' });
  assert.equal(capped.res.ordersCreated, 1, 'a binding cap trims, it does not block');
  assert.ok(capped.res.riskCapped >= 1, 'the trim is counted');
  const capStopDist = 2240 - capped.orders[0].stop_price;
  assert.ok(capped.orders[0].qty * capStopDist <= 20 + 1e-9,
    `risk at stop ${capped.orders[0].qty * capStopDist} must be <= 20`);
  assert.ok(capped.orders[0].qty < normal.orders[0].qty, 'smaller cap -> smaller position');

  // a cap so small no legal size exists: no order, audited reason
  const blocked = await run({ CRYPTO_MAX_RISK_USD: '1' });
  assert.equal(blocked.res.ordersCreated, 0, 'no order when the cap cannot be met');
  assert.equal(blocked.gate[0]?.code, 'RISK_CAP');
  assert.equal(blocked.gate[0]?.cap, 1);
  assert.ok(blocked.res.riskCappedOut >= 1, 'the refusal is counted, not silent');
  assert.ok(riskAtStop <= 250 + 1e-9, 'default cap (250) is respected');
});

/* ------------------------------------------------------------------ */
/* 3. walk-forward entry threshold                                     */
/* ------------------------------------------------------------------ */

type Bar = { date: string; close: number };

/** 60 sessions of daily bars where the NEXT session's return is +1% on even
 *  day indices and -1% on odd ones (the feature/outcome pair we control). */
function seedThresholdHistory(db: ReturnType<typeof openCryptoDb>, opts: { flip: boolean }): void {
  const start = Date.parse('2026-01-01T00:00:00Z');
  const days = 60;
  const dates: string[] = [];
  for (let i = 0; i < days; i += 1) dates.push(new Date(start + i * 86_400_000).toISOString().slice(0, 10));
  // close[i+1] = close[i] * (i even ? 1.01 : 0.99)  -> forward return known
  const closes: number[] = [100];
  for (let i = 0; i < days - 1; i += 1) closes.push(closes[i] * (i % 2 === 0 ? 1.01 : 0.99));
  for (let i = 0; i < days; i += 1) {
    upsertBar(db, 'AAA', {
      date: dates[i], open: closes[i], close: closes[i],
      high: closes[i] * 1.001, low: closes[i] * 0.999, volume: 1_000_000,
    });
  }
  // one recorded signal every 2 sessions, alternating the point-in-time move
  const insert = db.prepare(
    `INSERT INTO signals (ticker, company, sector, portfolio, strategy, strategy_version, model_version,
       horizon, signal, confidence, price, entry_low, entry_high, target, invalidation, expected_return,
       risk_reward, expected_hold, max_hold, session, session_date, created_at, regime, evidence_json,
       contradictions_json, scores_json, data_freshness, risk_checks_json, audit_json, knowledge_refs_json,
       event_refs_json, llm_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  // 54 rows, exactly 27 even + 27 odd day indices: the p50 cut lands exactly
  // between the two point masses, so neither side of the cut is empty.
  for (let i = 1; i <= 54; i += 1) {
    const prevClose = closes[i - 1];
    const even = i % 2 === 0;               // forward return on day i: +1% when even
    const wantsSupported = opts.flip ? !even : even;
    const move = wantsSupported ? -0.02 : 0.02;   // low move -> good outcome
    insert.run(
      'AAA', 'AAA', 'Crypto', CRYPTO_PORTFOLIO, 'crypto_momentum_v1', '1.0.0', 'test',
      'SHORT', 'BUY', 0.51, prevClose * (1 + move), 99, 101, 130, 95, 0.3, 3.5, 5, 20,
      'MARKET_OPEN', dates[i], Date.parse(`${dates[i]}T12:00:00Z`), 'MOMENTUM',
      '[]', '[]', JSON.stringify({ technical: 1, regime: 0.5 }),
      1, '[]', JSON.stringify({ weighted: 0.52 }), '[]', '[]', null,
    );
  }
}

test('no recorded history -> INSUFFICIENT_DATA, and the threshold blocks nothing', () => {
  const db = openCryptoDb(`${dbPath}-th-empty`);
  try {
    const config = cryptoConfigFromEnv({});
    const state = entryThreshold(db, config.threshold, { asOf: '2026-11-03', strategy: 'crypto_momentum_v1' });
    assert.equal(state.status, 'INSUFFICIENT_DATA');
    assert.equal(state.threshold, null, 'no number is invented without evidence');
    const verdict = evaluateThreshold(state, 0.5);
    assert.equal(verdict.ok, true, 'an unevaluated threshold must not block an entry');
    assert.equal(verdict.code, 'INACTIVE');
    assert.ok(state.reason.length > 0, 'the reason is always explained');
  } finally {
    db.close();
    rmSync(`${dbPath}-th-empty`, { force: true });
  }
});

test('recorded history that supports the cut -> ACTIVE, cuts the run-up side only', () => {
  const db = openCryptoDb(`${dbPath}-th-ok`);
  try {
    seedThresholdHistory(db, { flip: false });
    const config = cryptoConfigFromEnv({ CRYPTO_ENTRY_THRESHOLD_MIN: '10' });
    const state = entryThreshold(db, config.threshold, { asOf: '2026-03-01', strategy: 'crypto_momentum_v1' });
    assert.equal(state.status, 'ACTIVE', state.reason);
    assert.equal(state.feature, 'entry_move_vs_prev_close');
    assert.equal(state.direction, 'lte');
    assert.ok(state.threshold !== null && Math.abs(state.threshold) < 1e-9, `cut at ${state.threshold}`);
    assert.ok(state.samples >= 10, `n=${state.samples}`);
    assert.ok((state.candidates[0].kept.accPct ?? 0) > (state.candidates[0].cut.accPct ?? 0),
      'kept side must outperform the cut side');
    assert.equal(state.buyCheck?.agrees, true, 'the BUY-only sub-sample agrees');

    const blocked = evaluateThreshold(state, 0.03);   // entry already ran up
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, 'BLOCKED');
    const kept = evaluateThreshold(state, -0.03);     // entry below the prev close
    assert.equal(kept.ok, true);
    assert.equal(kept.code, 'PASS');
  } finally {
    db.close();
    rmSync(`${dbPath}-th-ok`, { force: true });
  }
});

test('history that contradicts the cut -> the threshold refuses to activate', () => {
  const db = openCryptoDb(`${dbPath}-th-bad`);
  try {
    seedThresholdHistory(db, { flip: true });
    const config = cryptoConfigFromEnv({ CRYPTO_ENTRY_THRESHOLD_MIN: '10' });
    const state = entryThreshold(db, config.threshold, { asOf: '2026-03-01', strategy: 'crypto_momentum_v1' });
    assert.notEqual(state.status, 'ACTIVE', `must not activate: ${state.reason}`);
    assert.equal(evaluateThreshold(state, 0.03).ok, true, 'a refuted cut blocks nothing');
    assert.ok(state.candidates.some((c) => c.verdict === 'WRONG_DIRECTION'), JSON.stringify(state.candidates));
  } finally {
    db.close();
    rmSync(`${dbPath}-th-bad`, { force: true });
  }
});

test('CRYPTO_ENTRY_THRESHOLD=0 disables the feature entirely', () => {
  const db = openCryptoDb(`${dbPath}-th-off`);
  try {
    seedThresholdHistory(db, { flip: false });
    const state = entryThreshold(db, cryptoConfigFromEnv({ CRYPTO_ENTRY_THRESHOLD: '0' }).threshold, {
      asOf: '2026-03-01', strategy: 'crypto_momentum_v1',
    });
    assert.equal(state.status, 'DISABLED');
    assert.equal(state.candidates.length, 0, 'disabled means not even evaluated');
  } finally {
    db.close();
    rmSync(`${dbPath}-th-off`, { force: true });
  }
});

test('entryMove measures the same point-in-time feature as the calibration', () => {
  const bars: Bar[] = [
    { date: '2026-01-01', close: 100 },
    { date: '2026-01-02', close: 101 },
    { date: '2026-01-03', close: 102 },
  ];
  // signal on 2026-01-03 priced 5% above the last COMPLETED session (01-02)
  assert.ok(Math.abs((entryMove(bars, '2026-01-03', 106.05) ?? 0) - 0.05) < 1e-9);
  // signal dated before the first bar -> no feature, never a guess
  assert.equal(entryMove(bars, '2025-12-31', 100), null);
  assert.equal(entryMove(bars.slice(0, 1), '2026-01-01', 100), null);
});

/* ------------------------------------------------------------------ */
/* 4. multi-venue / pullback confirmation gate                         */
/* ------------------------------------------------------------------ */

function freshDb(name: string): ReturnType<typeof openCryptoDb> {
  const db = openCryptoDb(`${dbPath}-${name}`);
  ensureXchangeTables(db);
  return db;
}

test('pullback leg: NO_TAPE with no observer data, never a silent block', () => {
  const cfg = cryptoConfigFromEnv({}).confirm;
  const db = freshDb('pb-none');
  try {
    const none = evaluateConfirmation({ db, cfg, tape: undefined, symbol: 'ETH', price: 100, atrPct: 0.05, now: Date.now() });
    assert.equal(none.ok, true);
    assert.equal(none.pullback.code, 'NO_TAPE');
    assert.equal(none.venue.code, 'NO_DATA');

    const tape = new TickTape({ windowMs: 60_000 });
    const now = Date.now();
    const empty = evaluateConfirmation({ db, cfg, tape, symbol: 'ETH', price: 100, atrPct: 0.05, now });
    assert.equal(empty.pullback.code, 'NO_TAPE', 'too few ticks -> no opinion');

    // price sitting ON the recent tape high -> blocked
    const atHigh = new TickTape({ windowMs: 60_000 });
    for (const px of [99.4, 99.7, 100]) atHigh.observe({ symbol: 'ETH', price: px, ts: now - 1_000 });
    const blocked = evaluateConfirmation({ db, cfg, tape: atHigh, symbol: 'ETH', price: 100, atrPct: 0.05, now });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.pullback.code, 'AT_LOCAL_HIGH');
    assert.equal(blocked.reason, 'AT_LOCAL_HIGH');
    assert.ok((blocked.pullback.observedPct ?? 1) < (blocked.pullback.requiredPct ?? 0));

    // pulled back far enough (5% ATR x 0.15 = 0.75% required) -> passes
    const pulled = new TickTape({ windowMs: 60_000 });
    for (const px of [100, 100.3, 100.8]) pulled.observe({ symbol: 'ETH', price: px, ts: now - 1_000 });
    const okRun = evaluateConfirmation({ db, cfg, tape: pulled, symbol: 'ETH', price: 100, atrPct: 0.05, now });
    assert.equal(okRun.ok, true, JSON.stringify(okRun.pullback));
    assert.equal(okRun.pullback.code, 'PASS');
    assert.ok((okRun.pullback.observedPct ?? 0) >= (okRun.pullback.requiredPct ?? 1));
  } finally {
    db.close();
    rmSync(`${dbPath}-pb-none`, { force: true });
    rmSync(`${dbPath}-pb-none-wal`, { force: true });
    rmSync(`${dbPath}-pb-none-shm`, { force: true });
  }
});

test('requiredPullback is volatility-scaled and clamped', () => {
  const cfg = cryptoConfigFromEnv({}).confirm;
  assert.ok(Math.abs(requiredPullback(0.05, cfg) - 0.0075) < 1e-12, '0.15 x 5% ATR');
  assert.ok(Math.abs(requiredPullback(0.001, cfg) - cfg.minPct) < 1e-12, 'floor');
  assert.ok(Math.abs(requiredPullback(0.5, cfg) - cfg.maxPct) < 1e-12, 'ceiling');
  assert.equal(requiredPullback(0, cfg), cfg.minPct, 'no ATR -> floor, never NaN');
});

test('venue leg: agreement passes, a falling or diverging tape blocks, stale says STALE', () => {
  const cfg = cryptoConfigFromEnv({}).confirm;
  const db = freshDb('venue');
  const now = Date.parse('2026-11-21T12:00:00Z');
  try {
    const sample = (provider: string, from: number, to: number) => [
      { ts: now - 60_000, provider, symbol: 'BTC', quote: 'USD', bid: from, ask: from + 1, mid: from, last: from, spreadBps: 1, bidQty: null, askQty: null, tradePx: null, tradeQty: null, tradeSide: null, events: 1, valid: true },
      { ts: now - 5_000, provider, symbol: 'BTC', quote: 'USD', bid: to, ask: to + 1, mid: to, last: to, spreadBps: 1, bidQty: null, askQty: null, tradePx: null, tradeQty: null, tradeSide: null, events: 1, valid: true },
    ];

    // both venues up -> agreement
    insertSamples(db, [...sample('kraken', 100, 101), ...sample('coinbase', 100, 100.8)]);
    const agree = evaluateConfirmation({ db, cfg, tape: undefined, symbol: 'ETH', price: 100, atrPct: 0.05, now });
    assert.equal(agree.venue.code, 'PASS', JSON.stringify(agree.venue));
    assert.equal(agree.venue.majority, 'UP');
    assert.equal(agree.ok, true, 'no pullback tape + agreeing venues = pass');

    db.exec('DELETE FROM xchange_samples');
    // both venues down -> blocked (long-only book: agreement on a fall confirms the exit case)
    insertSamples(db, [...sample('kraken', 101, 100), ...sample('coinbase', 101, 100.2)]);
    const falling = evaluateConfirmation({ db, cfg, tape: undefined, symbol: 'ETH', price: 100, atrPct: 0.05, now });
    assert.equal(falling.venue.code, 'FALLING');
    assert.equal(falling.ok, false);
    assert.equal(falling.reason, 'FALLING');

    db.exec('DELETE FROM xchange_samples');
    // venues disagree on direction -> blocked
    insertSamples(db, [...sample('kraken', 100, 101), ...sample('coinbase', 101, 100)]);
    const diverge = evaluateConfirmation({ db, cfg, tape: undefined, symbol: 'ETH', price: 100, atrPct: 0.05, now });
    assert.equal(diverge.venue.code, 'DIVERGE');
    assert.equal(diverge.ok, false);

    // agreement-only mode: a falling tape no longer blocks (divergence still does)
    db.exec('DELETE FROM xchange_samples');
    insertSamples(db, [...sample('kraken', 101, 100), ...sample('coinbase', 101, 100.2)]);
    const agreeOnly = cryptoConfigFromEnv({ CRYPTO_VENUE_REQUIRE_UP: '0' }).confirm;
    const relaxed = evaluateConfirmation({ db, cfg: agreeOnly, tape: undefined, symbol: 'ETH', price: 100, atrPct: 0.05, now });
    assert.equal(relaxed.venue.code, 'PASS', JSON.stringify(relaxed.venue));
    assert.equal(relaxed.ok, true, JSON.stringify(relaxed.venue));
  } finally {
    db.close();
    rmSync(`${dbPath}-venue`, { force: true });
    rmSync(`${dbPath}-venue-wal`, { force: true });
    rmSync(`${dbPath}-venue-shm`, { force: true });
  }
});

test('stale venue samples are reported as STALE and do not block', () => {
  const cfg = cryptoConfigFromEnv({}).confirm;
  const db = freshDb('stale');
  const now = Date.parse('2026-11-21T12:00:00Z');
  try {
    // inside the 5-minute sample window but past maxAgeMs (120s): stale, not missing
    insertSamples(db, [
      { ts: now - 260_000, provider: 'kraken', symbol: 'BTC', quote: 'USD', bid: 100, ask: 101, mid: 100.5, last: 100.5, spreadBps: 10, bidQty: null, askQty: null, tradePx: null, tradeQty: null, tradeSide: null, events: 1, valid: true },
      { ts: now - 240_000, provider: 'coinbase', symbol: 'BTC', quote: 'USD', bid: 100, ask: 101, mid: 100.5, last: 100.5, spreadBps: 10, bidQty: null, askQty: null, tradePx: null, tradeQty: null, tradeSide: null, events: 1, valid: true },
    ]);
    const res = evaluateConfirmation({ db, cfg, tape: undefined, symbol: 'ETH', price: 100, atrPct: 0.05, now });
    assert.equal(res.venue.code, 'STALE');
    assert.equal(res.ok, true, 'stale data passes but is recorded, never silent');
    assert.ok((res.venue.ageMs ?? 0) > cfg.maxAgeMs);
  } finally {
    db.close();
    rmSync(`${dbPath}-stale`, { force: true });
    rmSync(`${dbPath}-stale-wal`, { force: true });
    rmSync(`${dbPath}-stale-shm`, { force: true });
  }
});

test('CRYPTO_ENTRY_CONFIRM=0 turns the whole gate off', () => {
  const db = freshDb('off');
  try {
    const cfg = cryptoConfigFromEnv({ CRYPTO_ENTRY_CONFIRM: '0' }).confirm;
    const tape = new TickTape();
    for (const px of [100, 100, 100]) tape.observe({ symbol: 'ETH', price: px, ts: Date.now() });
    const res = evaluateConfirmation({ db, cfg, tape, symbol: 'ETH', price: 100, atrPct: 0.05, now: Date.now() });
    assert.equal(res.ok, true);
    assert.equal(res.pullback.code, 'DISABLED');
    assert.equal(res.venue.code, 'DISABLED');
  } finally {
    db.close();
    rmSync(`${dbPath}-off`, { force: true });
    rmSync(`${dbPath}-off-wal`, { force: true });
    rmSync(`${dbPath}-off-shm`, { force: true });
  }
});

/* ------------------------------------------------------------------ */
/* 5. trailing exit                                                    */
/* ------------------------------------------------------------------ */

test('the trail ratchets up after activation and exits on a pullback to it', async () => {
  const path = `${dbPath}-trail`;
  const db = openCryptoDb(path);
  try {
    const config = cryptoConfigFromEnv({ CRYPTO_CAPITAL: '100000' });
    ensureSpotPortfolio(db, config);
    const now = Date.now();
    db.prepare(
      `INSERT INTO paper_positions (portfolio, ticker, company, sector, qty, entry_price, entry_ts,
         entry_session, target, stop, trailing_stop, max_hold, sessions_held, mfe, mae, thesis_status,
         signal_id, current_price, last_update, predicted_return, entry_fee)
       VALUES (?,?,?,?,?,?,?,?,?,?,NULL,?,0,0,0,'INTACT',NULL,?,?,0,0)`,
    ).run(CRYPTO_PORTFOLIO, 'ETH', 'ETH', 'Crypto', 10, 100, now, 'DAY_0', 500, 96, 20, 100, now);

    // +3% = 0.75R -> trail arms ABOVE entry, and no exit fires on the way up
    const up = await monitorPositions(db, providerFor(['ETH', 103]), config, now + 1_000);
    assert.equal(up.exited, 0, 'arming the trail must not close the position');
    const armed = db.prepare(`SELECT trailing_stop FROM paper_positions WHERE exit_ts IS NULL`).get() as { trailing_stop: number | null };
    assert.ok(armed.trailing_stop !== null, 'trail armed');
    assert.ok(armed.trailing_stop > 100, `trail ${armed.trailing_stop} must sit above entry`);
    assert.ok(Math.abs(armed.trailing_stop - 101) < 1e-9, `0.5R behind 103 -> 101, got ${armed.trailing_stop}`);

    // price falls back to the trail -> TRAILING_STOP, at the market price
    const down = await monitorPositions(db, providerFor(['ETH', 100.9]), config, now + 2_000);
    assert.equal(down.exited, 1, 'the pullback to the trail closes the position');
    const trade = db.prepare(`SELECT exit_reason, exit_price FROM paper_trades ORDER BY id DESC LIMIT 1`).get() as
      { exit_reason: string; exit_price: number };
    assert.equal(trade.exit_reason, 'TRAILING_STOP');
    assert.ok(Math.abs(trade.exit_price - 100.9) < 1e-9, `exit at market, got ${trade.exit_price}`);
  } finally {
    db.close();
    rmSync(path, { force: true });
    rmSync(`${path}-wal`, { force: true });
    rmSync(`${path}-shm`, { force: true });
  }
});

test('CRYPTO_TRAIL_ENABLED=0 leaves the position on the fixed stop', async () => {
  const path = `${dbPath}-trail-off`;
  const db = openCryptoDb(path);
  try {
    const config = cryptoConfigFromEnv({ CRYPTO_CAPITAL: '100000', CRYPTO_TRAIL_ENABLED: '0' });
    ensureSpotPortfolio(db, config);
    const now = Date.now();
    db.prepare(
      `INSERT INTO paper_positions (portfolio, ticker, company, sector, qty, entry_price, entry_ts,
         entry_session, target, stop, trailing_stop, max_hold, sessions_held, mfe, mae, thesis_status,
         signal_id, current_price, last_update, predicted_return, entry_fee)
       VALUES (?,?,?,?,?,?,?,?,?,?,NULL,?,0,0,0,'INTACT',NULL,?,?,0,0)`,
    ).run(CRYPTO_PORTFOLIO, 'ETH', 'ETH', 'Crypto', 10, 100, now, 'DAY_0', 500, 96, 20, 100, now);
    const res = await monitorPositions(db, providerFor(['ETH', 110]), config, now + 1_000);
    assert.equal(res.exited, 0, 'no trail, price above the stop -> still open');
    const row = db.prepare(`SELECT trailing_stop FROM paper_positions WHERE exit_ts IS NULL`).get() as { trailing_stop: number | null };
    assert.equal(row.trailing_stop, null, 'trail never armed');
  } finally {
    db.close();
    rmSync(path, { force: true });
    rmSync(`${path}-wal`, { force: true });
    rmSync(`${path}-shm`, { force: true });
  }
});

/* ------------------------------------------------------------------ */
/* 6. invariant: with no gate data the trade flow is unchanged         */
/* ------------------------------------------------------------------ */

test('gates on vs off create the SAME orders when no gate data exists', async () => {
  const base = { CRYPTO_CAPITAL: '100000', CRYPTO_MIN_SIGNAL_CONFIDENCE: '0.5', CRYPTO_MIN_RISK_REWARD: '1' };
  const now = Date.parse('2026-11-03T12:00:00Z');
  const run = async (extra: Record<string, string>, tag: string) => {
    const path = `${dbPath}-inv-${tag}-${Math.random().toString(36).slice(2, 7)}`;
    const db = openCryptoDb(path);
    try {
      const config = cryptoConfigFromEnv({ ...base, ...extra });
      ensureSpotPortfolio(db, config);
      seedBook(db);
      const res = await runCryptoScan({ db, provider: providerFor(['BTC', 76000], ['ETH', 2240]), config, now });
      return { signals: res.signalsCreated, orders: res.ordersCreated };
    } finally {
      db.close();
      rmSync(path, { force: true });
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
    }
  };

  const off = await run({ CRYPTO_ENTRY_CONFIRM: '0', CRYPTO_ENTRY_THRESHOLD: '0' }, 'off');
  const on = await run({}, 'on');
  assert.ok(on.signals > 0 && on.orders > 0, `the tape still fires: ${JSON.stringify(on)}`);
  assert.equal(on.orders, off.orders,
    'SHADOW/NO-DATA MUST NOT CHANGE THE TRADE FLOW: same tape, gates on vs off');
  assert.equal(on.signals, off.signals, 'signals are identical too');
});

test.after(() => {
  rmSync(dir, { recursive: true, force: true });
});
