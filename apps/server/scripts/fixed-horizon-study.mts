/**
 * Phase B study: fixed-horizon directional accuracy for EVERY historical
 * signal at 30s / 60s / 5m / 15m / 1h / 1d, against simple baselines, with
 * Wilson 95% confidence intervals and class balance.
 *
 * Outcome sources (no look-ahead — first observation AT OR AFTER
 * signal_ts + horizon, never before):
 *   30s/60s   micro_snapshots (10s cadence, recorded from the live feed;
 *             7d retention — only signals younger than retention can score)
 *   5m        micro_snapshots first, else Kraken 5m OHLC (720-candle page)
 *   15m/1h    Kraken 15m / 1h OHLC (720-candle page = 7.5d / 30d depth)
 *   1d        daily bars in crypto.db (first bar at/after the horizon date)
 *
 * Baselines: always-UP and always-DOWN (the class share) and persistence
 * (direction from the last close strictly before the signal). Accuracy
 * denominators exclude FLAT outcomes; everything is reported with n — no
 * claim survives a small n because the Wilson interval says so.
 *
 * Read-only. Also emits Phase D inputs: realized |move| per horizon scale.
 *
 *   CRYPTO_DB=<path> node scripts/fixed-horizon-study.mts
 */
import { DatabaseSync } from 'node:sqlite';
import { etDate } from '@promptslim/tucore';
import { directionalStats, type DirectionRow } from '../src/crypto/research.ts';

const dbPath = process.env.CRYPTO_DB ?? '/data/crypto.db';
const db = new DatabaseSync(dbPath, { readOnly: true });

interface SignalRow {
  id: number; ticker: string; signal: 'BUY' | 'SELL';
  price: number; created_at: number; session_date: string;
}
const signals = db
  .prepare(`SELECT id, ticker, signal, price, created_at, session_date FROM signals WHERE signal IN ('BUY','SELL') ORDER BY created_at`)
  .all() as unknown as SignalRow[];

/* ------------------------------------------------------------------ */
/* Kraken intraday OHLC (public REST, no key)                          */
/* ------------------------------------------------------------------ */

interface Candle { t: number; close: number; open: number; high: number; low: number }

const PAIR_CACHE = new Map<string, string | null>();
const OHLC_CACHE = new Map<string, Candle[]>(); // key: `${symbol}|${interval}`

/** Kraken legacy naming + AssetPairs index (same rules as providers/kraken.ts). */
const LEGACY: Record<string, string> = { BTC: 'XBT', DOGE: 'XDG', REP: 'REPV2' };
async function pairFor(symbol: string): Promise<string | null> {
  if (PAIR_CACHE.has(symbol)) return PAIR_CACHE.get(symbol) ?? null;
  const raw = LEGACY[symbol] ?? symbol;
  const guess = `${raw}USD`;
  PAIR_CACHE.set(symbol, guess);
  return guess;
}

async function fetchOhlc(symbol: string, intervalMin: number): Promise<Candle[]> {
  const key = `${symbol}|${intervalMin}`;
  if (OHLC_CACHE.has(key)) return OHLC_CACHE.get(key)!;
  const pair = await pairFor(symbol);
  if (!pair) return [];
  try {
    const res = await fetch(`https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=${intervalMin}`);
    const body = (await res.json()) as { error: string[]; result: Record<string, unknown> };
    if (body.error && body.error.length) { OHLC_CACHE.set(key, []); return []; }
    const rows = body.result[Object.keys(body.result).find((k) => k !== 'last') ?? ''] as unknown as Array<Array<number>>;
    const out = (rows ?? []).map((r) => ({
      t: r[0] * 1000, open: r[1], high: r[2], low: r[3], close: r[4],
    }));
    OHLC_CACHE.set(key, out);
    return out;
  } catch {
    OHLC_CACHE.set(key, []);
    return [];
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* outcome lookups                                                     */
/* ------------------------------------------------------------------ */

function snapshotOutcome(symbol: string, t: number, horizonMs: number, tolMs: number): { ts: number; price: number } | null {
  const row = db
    .prepare(`SELECT ts, payload FROM micro_snapshots WHERE symbol = ? AND ts >= ? AND ts <= ? ORDER BY ts LIMIT 1`)
    .get(symbol, t + horizonMs, t + horizonMs + tolMs) as { ts: number; payload: string } | undefined;
  if (!row) return null;
  try {
    const p = JSON.parse(row.payload) as { mid?: number; price?: number };
    const price = Number(p.mid ?? p.price);
    return Number.isFinite(price) && price > 0 ? { ts: row.ts, price } : null;
  } catch { return null; }
}

function candleOutcome(candles: Candle[], t: number, horizonMs: number, intervalMs: number): { ts: number; price: number } | null {
  for (const c of candles) {
    const closeTs = c.t + intervalMs; // candle observed complete at its close
    if (closeTs >= t + horizonMs) return { ts: closeTs, price: c.close };
  }
  return null;
}

function priorCandleClose(candles: Candle[], t: number, intervalMs: number): number | null {
  let prev: number | null = null;
  for (const c of candles) {
    if (c.t + intervalMs > t) break; // candle not finished before the signal
    prev = c.close;
  }
  return prev;
}

function dailyOutcome(symbol: string, t: number): { ts: number; price: number } | null {
  const row = db
    .prepare('SELECT date, close FROM market_bars WHERE ticker = ? AND date >= ? ORDER BY date LIMIT 1')
    .get(symbol, etDate(t + 86_400_000)) as { date: string; close: number } | undefined;
  return row ? { ts: Date.parse(`${row.date}T23:59:59Z`), price: row.close } : null;
}

function dailyPriorClose(symbol: string, sessionDate: string): number | null {
  const row = db
    .prepare('SELECT close FROM market_bars WHERE ticker = ? AND date < ? ORDER BY date DESC LIMIT 1')
    .get(symbol, sessionDate) as { close: number } | undefined;
  return row ? row.close : null;
}

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

interface HorizonDef {
  key: '30s' | '60s' | '5m' | '15m' | '1h' | '1d';
  ms: number;
  tolMs: number;
  source: 'snapshot' | 'candle' | 'daily';
  intervalMin?: number;
}

const HORIZONS: HorizonDef[] = [
  { key: '30s', ms: 30_000, tolMs: 30_000, source: 'snapshot' },
  { key: '60s', ms: 60_000, tolMs: 30_000, source: 'snapshot' },
  { key: '5m', ms: 300_000, tolMs: 60_000, source: 'candle', intervalMin: 5 },
  { key: '15m', ms: 900_000, tolMs: 120_000, source: 'candle', intervalMin: 15 },
  { key: '1h', ms: 3_600_000, tolMs: 300_000, source: 'candle', intervalMin: 60 },
  { key: '1d', ms: 86_400_000, tolMs: 0, source: 'daily' },
];

const now = Date.now();
const tickers = [...new Set(signals.map((s) => s.ticker))].sort();

// prefetch intraday candles per ticker/interval (rate-limit friendly)
for (const t of tickers) {
  for (const iv of [5, 15, 60]) { await fetchOhlc(t, iv); await sleep(220); }
}

const results: unknown[] = [];
const detail: unknown[] = [];

for (const h of HORIZONS) {
  const rows: Array<DirectionRow & { side: string; persisted: boolean | null }> = [];
  let elapsed = 0, noData = 0;

  for (const s of signals) {
    if (now < s.created_at + h.ms) continue;
    elapsed += 1;

    let observed: { ts: number; price: number } | null = null;
    let persistence: boolean | null = null;

    if (h.source === 'snapshot') {
      observed = snapshotOutcome(s.ticker, s.created_at, h.ms, h.tolMs);
      if (!observed && h.key === '5m') {
        const candles = await fetchOhlc(s.ticker, 5);
        observed = candleOutcome(candles, s.created_at, h.ms, 5 * 60_000);
        if (observed) {
          const prev = priorCandleClose(candles, s.created_at, 5 * 60_000);
          persistence = prev != null && prev !== s.price ? (s.price > prev ? 'UP' : 'DOWN') === ((observed.price > s.price ? 'UP' : 'DOWN')) : null;
        }
      }
      if (observed && h.key !== '5m') {
        const row = db.prepare('SELECT ts, payload FROM micro_snapshots WHERE symbol = ? AND ts < ? ORDER BY ts DESC LIMIT 1')
          .get(s.ticker, s.created_at) as { payload: string } | undefined;
        if (row) {
          try {
            const p = JSON.parse(row.payload) as { mid?: number };
            const prev = Number(p.mid);
            if (Number.isFinite(prev) && prev !== s.price) {
              persistence = (prev > s.price ? 'UP' : 'DOWN') === (observed.price > s.price ? 'UP' : 'DOWN');
            }
          } catch { /* null */ }
        }
      }
    } else if (h.source === 'candle') {
      const candles = await fetchOhlc(s.ticker, h.intervalMin!);
      observed = candleOutcome(candles, s.created_at, h.ms, h.intervalMin! * 60_000);
      const prev = priorCandleClose(candles, s.created_at, h.intervalMin! * 60_000);
      if (observed && prev != null && prev !== s.price) {
        persistence = (prev > s.price ? 'UP' : 'DOWN') === (observed.price > s.price ? 'UP' : 'DOWN');
      }
    } else {
      observed = dailyOutcome(s.ticker, s.created_at);
      const prev = dailyPriorClose(s.ticker, s.session_date);
      if (observed && prev != null && prev !== s.price) {
        persistence = (prev > s.price ? 'UP' : 'DOWN') === (observed.price > s.price ? 'UP' : 'DOWN');
      }
    }

    if (!observed) { noData += 1; continue; }

    const ret = (observed.price - s.price) / s.price;
    const actual = ret > 0 ? 'UP' : ret < 0 ? 'DOWN' : 'FLAT';
    const predicted = s.signal === 'BUY' ? 'UP' : 'DOWN';
    rows.push({
      predicted, actual, side: s.signal,
      persisted: actual === 'FLAT' ? null : persistence,
    });
    detail.push({
      signalId: s.id, ticker: s.ticker, side: s.signal, signalPrice: s.price,
      createdAt: s.created_at, horizon: h.key, observedTs: observed.ts,
      observedPrice: observed.price, ret, predicted, actual, source: h.source,
      persistenceCorrect: actual === 'FLAT' ? null : persistence,
    });
  }

  const overall = directionalStats(rows);
  const buy = directionalStats(rows.filter((r) => r.side === 'BUY'));
  const sell = directionalStats(rows.filter((r) => r.side === 'SELL'));
  const persisted = rows.filter((r) => r.persisted !== null);
  const persistenceCorrect = persisted.filter((r) => r.persisted === true).length;

  results.push({
    horizon: h.key,
    source: h.source,
    elapsed,
    evaluated: overall.evaluated,
    noData,
    flat: overall.flat,
    classBalance: { up: overall.up, down: overall.down, upPct: overall.alwaysUp },
    overall: overall.accuracy,
    BUY: buy.accuracy,
    SELL: sell.accuracy,
    baselines: {
      alwaysUp: overall.alwaysUp,
      alwaysDown: overall.alwaysDown,
      persistence: directionalStats(
        persisted.map((r) => ({ predicted: r.persisted ? 'UP' : 'DOWN', actual: r.actual })),
      ).accuracy,
    },
    persistenceN: persisted.length,
    persistenceCorrect,
  });
  void persistenceCorrect;
}

/* ------------------------------------------------------------------ */
/* Phase D inputs: realized |move| at each scale                       */
/* ------------------------------------------------------------------ */

const realized: unknown[] = [];
{
  // 15m candles across all tickers: |close - open| / open distribution
  const moves15: number[] = [];
  const moves60: number[] = [];
  for (const t of tickers) {
    for (const pair of [[15, moves15], [60, moves60]] as Array<[number, number[]]>) {
      const iv = pair[0];
      const bucket = pair[1];
      const candles = await fetchOhlc(t, iv);
      for (const c of candles) bucket.push(Math.abs(c.close - c.open) / c.open * 100);
    }
  }
  const stats = (arr: number[]) => {
    if (!arr.length) return { n: 0 };
    const sorted = [...arr].sort((a, b) => a - b);
    const mean = arr.reduce((s, x) => s + x, 0) / arr.length;
    return {
      n: arr.length,
      meanPct: +mean.toFixed(4),
      medianPct: +sorted[Math.floor(arr.length / 2)].toFixed(4),
      p90Pct: +sorted[Math.floor(arr.length * 0.9)].toFixed(4),
    };
  };
  // micro snapshot return stats (bps) from recorded features
  const snap = db.prepare(`SELECT payload FROM micro_snapshots LIMIT 5000`).all() as unknown as Array<{ payload: string }>;
  const rets: Record<string, number[]> = { s1: [], s5: [], s15: [], s30: [], s60: [] };
  for (const r of snap) {
    try {
      const p = JSON.parse(r.payload) as { retBps?: Record<string, number | null> };
      if (!p.retBps) continue;
      for (const k of Object.keys(rets)) {
        const v = p.retBps[k];
        if (typeof v === 'number' && Number.isFinite(v)) rets[k].push(Math.abs(v));
      }
    } catch { /* skip */ }
  }
  realized.push({
    candleAbsMove15m: stats(moves15),
    candleAbsMove1h: stats(moves60),
    snapshotAbsRetBps: Object.fromEntries(Object.entries(rets).map(([k, v]) => [k, stats(v)])),
    snapshotRows: (db.prepare('SELECT COUNT(*) c FROM micro_snapshots').get() as { c: number }).c,
  });
}

const report = {
  generatedAt: now,
  signals: {
    total: signals.length,
    BUY: signals.filter((s) => s.signal === 'BUY').length,
    SELL: signals.filter((s) => s.signal === 'SELL').length,
  },
  horizons: results,
  realized,
  detail,
};

const fmtCi = (ci: { pct: number | null; lo: number | null; hi: number | null }) =>
  ci.pct === null ? 'n/a' : `${(ci.pct * 100).toFixed(1)}% [${((ci.lo ?? 0) * 100).toFixed(1)}, ${((ci.hi ?? 0) * 100).toFixed(1)}]`;

console.log(`signals: ${report.signals.total} (BUY ${report.signals.BUY} / SELL ${report.signals.SELL})  now=${new Date(now).toISOString()}\n`);
console.log('horizon  src       elapsed eval noData  overall [95% CI]          BUY [95% CI]           SELL [95% CI]          upShare  persistence');
for (const r of results as Array<Record<string, any>>) {
  console.log(
    `${r.horizon.padEnd(8)} ${String(r.source).padEnd(9)} ${String(r.elapsed).padStart(5)} ${String(r.evaluated).padStart(4)} ${String(r.noData).padStart(6)}  ` +
    `${fmtCi(r.overall).padEnd(24)} ${fmtCi(r.BUY).padEnd(22)} ${fmtCi(r.SELL).padEnd(22)} ` +
    `${(r.classBalance.upPct === null ? 'n/a' : (r.classBalance.upPct * 100).toFixed(0) + '%').padStart(7)}  ` +
    `${fmtCi(r.baselines.persistence)} (n=${r.persistenceN})`,
  );
}

console.log('\nrealized |move| inputs for Phase D:');
console.log(JSON.stringify(realized, null, 1));

const { writeFileSync } = await import('node:fs');
const outPath = `${process.env.TMPDIR ?? '/tmp'}/fixed-horizon-study.json`;
writeFileSync(outPath, JSON.stringify(report, null, 1));
console.log(`\nfull report -> ${outPath}`);
db.close();
