/**
 * Crypto engine + realtime stream tests.
 *
 * The websocket parser is written against a REAL Kraken ticker row captured
 * from this host (the field is `timestamp`, not `time` — a mistake that would
 * have silently dropped every tick), and the scan is driven against a seeded
 * book so signal creation and the learned-weight plumbing are proven without
 * touching the network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Candle, Quote } from '@promptslim/tucore';
import { openCryptoDb } from '../src/crypto/schema.ts';
import { cryptoConfigFromEnv } from '../src/crypto/config.ts';
import { ensureSpotPortfolio, upsertBar, CRYPTO_PORTFOLIO, CRYPTO_BENCHMARK } from '../src/crypto/broker.ts';
import { runCryptoScan, activeSymbols, ingestTick, CRYPTO_STRATEGY } from '../src/crypto/engine.ts';
import { KrakenProvider } from '../src/crypto/providers/kraken-provider.ts';
import { CryptoPriceStream, parseTickerMessage, wsSymbol, type StreamSocket } from '../src/crypto/stream.ts';

const dir = mkdtempSync(join(tmpdir(), 'crypto-engine-'));
const dbPath = join(dir, 'crypto.db');

/** Captured live from wss://ws.kraken.com/v2 on 2026-11-03. */
const REAL_TICKER_ROW = {
  channel: 'ticker', type: 'update',
  data: [{
    symbol: 'XBT/USD', bid: 76661.8, bid_qty: 0.51, ask: 76661.9, ask_qty: 1.2,
    last: 76661.9, volume: 5108.77, vwap: 77014.2, low: 76449.48, high: 78382.36,
    change: -452.1, change_pct: -0.59, trades: 123456,
    timestamp: '2026-11-03T06:29:02.090939Z',
  }],
};

const STATUS_ROW = {
  channel: 'status', type: 'update',
  data: [{ version: '2.0.10', system: 'online', api_version: 'v2', connection_id: 1 }],
};

test('websocket ticker rows parse into quotes (XBT->BTC, timestamp, real prev close)', () => {
  const symbols = new Set(['BTC', 'ETH']);
  const now = Date.now();

  const quotes = parseTickerMessage(JSON.stringify(REAL_TICKER_ROW), symbols, now);
  assert.equal(quotes.length, 1, 'exactly one quote per row');
  const q = quotes[0];
  assert.equal(q.symbol, 'BTC', 'Kraken calls bitcoin XBT on the wire');
  assert.equal(q.price, 76661.9);
  assert.equal(new Date(q.ts).toISOString(), '2026-11-03T06:29:02.090Z', 'ts comes from `timestamp`');
  assert.ok(Math.abs(q.prevClose - (76661.9 + 452.1)) < 1e-6, 'prevClose derived from the 24h change');
  assert.equal(q.bid, 76661.8);
  assert.equal(q.provider, 'kraken-ws');
  assert.equal(q.freshness, 'REALTIME');

  assert.deepEqual(parseTickerMessage(JSON.stringify(STATUS_ROW), symbols, now), [], 'heartbeats are ignored');
  assert.deepEqual(parseTickerMessage('not json', symbols, now), [], 'garbage is ignored');
  assert.deepEqual(
    parseTickerMessage(JSON.stringify(REAL_TICKER_ROW), new Set(['ETH']), now),
    [], 'rows for symbols outside the universe are dropped',
  );
});

test('the stream subscribes, falls back to REST while down, and recovers', async () => {
  const ticks: Quote[] = [];
  let restPolls = 0;
  const handlers: Record<string, Array<(arg?: unknown) => void>> = {};
  let sent: string[] = [];
  let closed = false;

  const fakeSocket = {
    on: (event: 'open' | 'message' | 'error' | 'close', cb: (arg?: unknown) => void) => {
      (handlers[event] ??= []).push(cb as (arg?: unknown) => void);
    },
    send: (data: string) => { sent.push(data); },
    close: () => { closed = true; },
  } as unknown as StreamSocket;

  const stream = new CryptoPriceStream({
    symbols: ['BTC', 'ETH'],
    onTick: (q) => ticks.push(q),
    restPoll: async () => { restPolls += 1; },
    restPollMs: 20,
    socketFactory: () => fakeSocket,
  });

  stream.start();
  handlers.open?.[0]?.();
  assert.equal(sent.length, 1, 'subscribed once on open');
  const sub = JSON.parse(sent[0]) as { method: string; params: { channel: string; symbol: string[] } };
  assert.equal(sub.method, 'subscribe');
  assert.equal(sub.params.channel, 'ticker');
  assert.deepEqual(sub.params.symbol, ['BTC/USD', 'ETH/USD'], 'BTC must be sent as BTC (v2 rejects XBT/USD)');

  handlers.message?.[0]?.(JSON.stringify(REAL_TICKER_ROW));
  assert.equal(ticks.length, 1, 'live tick delivered through the socket');
  assert.equal(stream.live, true);

  // socket dies -> REST keeps the book warm
  handlers.close?.[0]?.();
  assert.equal(stream.live, false);
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(restPolls >= 2, `REST polling ran while down (got ${restPolls})`);

  stream.stop();
  const atStop = restPolls;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(restPolls, atStop, 'stop() halts the REST fallback timer');
  void closed;
});

function seedBook(db: ReturnType<typeof openCryptoDb>): void {
  const now = Date.now();
  db.prepare('INSERT INTO crypto_universe (symbol, pinned, active, added_at, updated_at) VALUES (?,?,?,?,?)')
    .run('BTC', 1, 1, now, now);
  db.prepare('INSERT INTO crypto_universe (symbol, pinned, active, added_at, updated_at) VALUES (?,?,?,?,?)')
    .run('ETH', 0, 1, now, now);
  db.prepare('INSERT INTO crypto_universe (symbol, pinned, active, added_at, updated_at) VALUES (?,?,?,?,?)')
    .run('SOL', 0, 0, now, now); // inactive member must not be scanned

  const end = Date.parse('2026-11-03T00:00:00Z');
  const write = (ticker: string) => {
    let price = 100;
    for (let i = 140; i >= 0; i--) {
      const date = new Date(end - i * 86_400_000).toISOString().slice(0, 10);
      const open = price;
      price = price * 1.012;
      upsertBar(db, ticker, { date, open, high: price, low: open * 0.992, close: price, volume: 1_500_000 });
    }
  };
  write('BTC');
  write('ETH');
  write(CRYPTO_BENCHMARK);
  upsertBar(db, 'SOL', { date: '2026-11-03', open: 1, high: 1, low: 1, close: 1, volume: 1 });
}

test('the scan produces signals and spot orders from the active universe only', async () => {
  const db = openCryptoDb(dbPath);
  try {
    const config = cryptoConfigFromEnv({
      CRYPTO_CAPITAL: '100000', CRYPTO_MIN_SIGNAL_CONFIDENCE: '0.5', CRYPTO_MIN_RISK_REWARD: '1',
    });
    ensureSpotPortfolio(db, config);
    seedBook(db);

    const provider = new KrakenProvider({
      tickers: (async () => [
        { symbol: 'BTC', price: 76000, prevClose: 76500, ts: Date.now(), bid: 75990, ask: 76010, provider: 'kraken', freshness: 'REALTIME' },
        { symbol: 'ETH', price: 2240, prevClose: 2280, ts: Date.now(), bid: 2239, ask: 2241, provider: 'kraken', freshness: 'REALTIME' },
      ] as Quote[]) as never,
      bars: (async () => [] as Candle[]) as never,
    });

    const res = await runCryptoScan({ db, provider, config, now: Date.parse('2026-11-03T12:00:00Z') });

    assert.deepEqual(activeSymbols(db), ['BTC', 'ETH'], 'inactive members are not scanned');
    assert.equal(res.scanned, 2, 'both active symbols were scored');
    assert.ok(res.signalsCreated > 0, `the rising tape should fire, got ${JSON.stringify(res)}`);
    assert.ok(res.ordersCreated > 0, 'a BUY signal opens a spot paper order');

    const sig = db.prepare('SELECT * FROM signals ORDER BY id DESC LIMIT 1').get() as {
      strategy: string; portfolio: string; sector: string; audit_json: string; regime: string;
    };
    assert.equal(sig.strategy, CRYPTO_STRATEGY);
    assert.equal(sig.portfolio, CRYPTO_PORTFOLIO, 'orders belong to the crypto book');
    assert.equal(sig.sector, 'Crypto');
    const audit = JSON.parse(sig.audit_json) as { learnedWeights: boolean; entryChecks: { relativeVolume: number } };
    assert.equal(audit.learnedWeights, false, 'no fitted weights yet -> shipped defaults');
    assert.ok(audit.entryChecks.relativeVolume >= 0, 'entry check stored for lesson feedback');

    const order = db.prepare(`SELECT * FROM paper_orders WHERE status = 'PENDING'`).get() as
      { portfolio: string; side: string } | undefined;
    assert.ok(order, 'a pending BUY order exists');
    assert.equal(order?.portfolio, CRYPTO_PORTFOLIO);

    const auditRow = db.prepare(`SELECT detail_json FROM audit_log WHERE action = 'scan' ORDER BY id DESC LIMIT 1`).get() as
      { detail_json: string };
    assert.equal(JSON.parse(auditRow.detail_json).scanned, 2, 'the scan is auditable');

    // re-running the same session must not duplicate signals
    const again = await runCryptoScan({ db, provider, config, now: Date.parse('2026-11-03T12:00:00Z') });
    assert.equal(again.signalsCreated, 0, 'one signal per symbol per session');
    assert.ok(again.skippedDuplicate > 0, 'duplicates are counted, not re-emitted');
  } finally {
    db.close();
  }
});

test('planted learned weights change the scan (the row is really read)', async () => {
  const db = openCryptoDb(`${dbPath}-weights`);
  try {
    const config = cryptoConfigFromEnv({
      CRYPTO_CAPITAL: '100000', CRYPTO_MIN_SIGNAL_CONFIDENCE: '0.5', CRYPTO_MIN_RISK_REWARD: '1',
    });
    ensureSpotPortfolio(db, config);
    seedBook(db);
    // macro dominates and the macro part is 0 in crypto v1 -> fusion must go quiet
    db.prepare('INSERT INTO strategy_weights (strategy, horizon, weights_json, updated_at) VALUES (?,?,?,?)')
      .run(CRYPTO_STRATEGY, 'SHORT', JSON.stringify({
        weights: { technical: 0.01, fundamental: 0.01, event: 0.01, sentiment: 0.01, macro: 0.96, regime: 0.01 },
        trades: 10, sufficient: true, updatedAt: Date.now(),
      }), Date.now());

    const provider = new KrakenProvider({
      tickers: (async () => [
        { symbol: 'BTC', price: 76000, prevClose: 76500, ts: Date.now(), provider: 'kraken', freshness: 'REALTIME' },
      ] as Quote[]) as never,
      bars: (async () => [] as Candle[]) as never,
    });

    // identical twin WITHOUT the planted row: same seed, default weights
    const dbTwin = openCryptoDb(`${dbPath}-twin`);
    ensureSpotPortfolio(dbTwin, config);
    seedBook(dbTwin);
    const control = await runCryptoScan({ db: dbTwin, provider, config, now: Date.parse('2026-11-03T12:00:00Z') });

    const res = await runCryptoScan({ db, provider, config, now: Date.parse('2026-11-03T12:00:00Z') });
    assert.ok(control.signalsCreated > 0, 'the control run (shipped weights) fires signals');
    assert.equal(res.signalsCreated, 0, 'planted weights silence the fusion -> no signals');
    assert.notEqual(res.signalsCreated, control.signalsCreated, 'the difference comes from the planted row');

    const { learnedWeights } = await import('../src/tradingusa/adaptive.ts');
    const learned = learnedWeights(db, CRYPTO_STRATEGY, 'SHORT');
    assert.equal(learned.sufficient, true, 'the scan could read the planted row');
    assert.equal(learnedWeights(dbTwin, CRYPTO_STRATEGY, 'SHORT').sufficient, false, 'the twin has none');
    dbTwin.close();
  } finally {
    db.close();
  }
});

test('ingestTick stamps previous close from the bars, not the placeholder', () => {
  const db = openCryptoDb(`${dbPath}-ingest`);
  try {
    upsertBar(db, 'BTC', { date: '2026-11-02', open: 100, high: 101, low: 99, close: 105, volume: 10 });
    upsertBar(db, 'BTC', { date: '2026-11-03', open: 105, high: 106, low: 104, close: 107, volume: 10 });
    const stored = ingestTick(db, [
      { symbol: 'BTC', price: 110, prevClose: 110, ts: Date.now(), provider: 'kraken-ws', freshness: 'REALTIME' } as Quote,
    ]);
    assert.equal(stored, 1);
    const row = db.prepare('SELECT price, prev_close, provider, freshness FROM market_quotes WHERE symbol = ?').get('BTC') as
      { price: number; prev_close: number; provider: string; freshness: string };
    assert.equal(row.price, 110);
    assert.equal(row.prev_close, 105, 'previous close = the prior daily bar');
    assert.equal(row.provider, 'kraken-ws');
    assert.equal(row.freshness, 'REALTIME');
  } finally {
    db.close();
    rmSync(`${dbPath}-ingest`, { force: true });
  }
});

test('CRYPTO_FUSION_WEIGHTS parses the parts that matter and falls back safely', () => {
  const ok = cryptoConfigFromEnv({ CRYPTO_FUSION_WEIGHTS: '{"technical":0.84,"regime":0.16,"bogus":9}' });
  assert.deepEqual(
    ok.fusionWeights, { technical: 0.84, regime: 0.16 },
    'known parts kept, unknown keys dropped',
  );
  assert.equal(cryptoConfigFromEnv({ CRYPTO_FUSION_WEIGHTS: 'not json' }).fusionWeights, null, 'garbage -> tucore defaults');
  assert.equal(cryptoConfigFromEnv({ CRYPTO_FUSION_WEIGHTS: '{"nope":1}' }).fusionWeights, null, 'no valid part -> defaults');
  assert.equal(cryptoConfigFromEnv({}).fusionWeights, null, 'unset -> defaults (v1 behaviour unchanged)');
});

test('configured crypto fusion weights reach the scan (twin run differs from the defaults)', async () => {
  const base = {
    CRYPTO_CAPITAL: '100000', CRYPTO_MIN_SIGNAL_CONFIDENCE: '0.5', CRYPTO_MIN_RISK_REWARD: '1',
  };
  const withWeights = cryptoConfigFromEnv({ ...base, CRYPTO_FUSION_WEIGHTS: '{"technical":0.84,"regime":0.16}' });
  const defaults = cryptoConfigFromEnv(base);
  const db = openCryptoDb(`${dbPath}-fw`);
  const dbTwin = openCryptoDb(`${dbPath}-fw-twin`);
  try {
    ensureSpotPortfolio(db, withWeights);
    ensureSpotPortfolio(dbTwin, defaults);
    seedBook(db);
    seedBook(dbTwin);
    const provider = new KrakenProvider({
      tickers: (async () => [
        { symbol: 'BTC', price: 76000, prevClose: 76500, ts: Date.now(), provider: 'kraken', freshness: 'REALTIME' },
        { symbol: 'ETH', price: 2240, prevClose: 2280, ts: Date.now(), provider: 'kraken', freshness: 'REALTIME' },
      ] as Quote[]) as never,
      bars: (async () => [] as Candle[]) as never,
    });
    const now = Date.parse('2026-11-03T12:00:00Z');
    const res = await runCryptoScan({ db, provider, config: withWeights, now });
    const ctl = await runCryptoScan({ db: dbTwin, provider, config: defaults, now });

    assert.ok(res.signalsCreated > 0, 'the configured run still fires');
    const weightedOf = (d: typeof db): number => {
      const row = d.prepare(`SELECT audit_json FROM signals ORDER BY id DESC LIMIT 1`).get() as { audit_json: string };
      return Number((JSON.parse(row.audit_json) as { weighted: number }).weighted);
    };
    assert.notEqual(
      weightedOf(db), weightedOf(dbTwin),
      'same tape, different weights -> different weighted score (the env really reaches fuse)',
    );
    assert.equal(res.signalsCreated, ctl.signalsCreated, 'on this tape both configs agree on the action');
  } finally {
    db.close();
    dbTwin.close();
    rmSync(`${dbPath}-fw`, { force: true });
    rmSync(`${dbPath}-fw-twin`, { force: true });
  }
});

test('wsSymbol speaks Kraken v2 naming (BTC, not the rejected XBT alias)', () => {
  assert.equal(wsSymbol('BTC'), 'BTC/USD', 'v2 rejects XBT/USD with "Currency pair not supported"');
  assert.equal(wsSymbol('doge'), 'DOGE/USD');
  assert.equal(wsSymbol('XMR'), 'XMR/USD');
});

test.after(() => {
  rmSync(dir, { recursive: true, force: true });
});