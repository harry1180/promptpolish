/**
 * Storage for the multi-exchange layer — lives in the SAME SQLite file as the
 * crypto book (/data/crypto.db) so replay, accuracy and lead-lag studies read
 * one database. Tables are additive (`IF NOT EXISTS`); the trading tables are
 * never touched.
 *
 * Volumes are bounded: one sample row per (venue, symbol) every `SAMPLE_MS`,
 * pruned after `RETENTION_MS`. Live feature math runs on in-memory rings; the
 * tables exist for replay/ablation/lead-lag, not for the hot path.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { CanonicalEvent, VenueQuote } from './types.ts';

/** cadence of the persisted per-(venue,symbol) sample */
export const SAMPLE_MS = 5_000;
/** how long samples are kept (72h) */
export const RETENTION_MS = 72 * 3_600_000;

export const XCHANGE_DDL = `
CREATE TABLE IF NOT EXISTS xchange_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  provider TEXT NOT NULL,
  symbol TEXT NOT NULL,
  quote TEXT NOT NULL,
  bid REAL, ask REAL, mid REAL, last REAL, spread_bps REAL,
  bid_qty REAL, ask_qty REAL,
  trade_px REAL, trade_qty REAL, trade_side TEXT,
  events INTEGER NOT NULL DEFAULT 0,
  valid INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_xchange_samples_ts ON xchange_samples(ts);
CREATE INDEX IF NOT EXISTS idx_xchange_samples_pair ON xchange_samples(provider, symbol, ts);
CREATE TABLE IF NOT EXISTS xchange_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_xchange_snapshots_ts ON xchange_snapshots(ts);
CREATE TABLE IF NOT EXISTS xchange_context (
  key TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  expires INTEGER NOT NULL,
  payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS xchange_provider_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  provider TEXT NOT NULL,
  state TEXT NOT NULL,
  detail TEXT
);`;

export function ensureXchangeTables(db: DatabaseSync): void {
  db.exec(XCHANGE_DDL);
}

export interface SampleRow {
  ts: number;
  provider: string;
  symbol: string;
  quote: string;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  last: number | null;
  spreadBps: number | null;
  bidQty: number | null;
  askQty: number | null;
  tradePx: number | null;
  tradeQty: number | null;
  tradeSide: string | null;
  events: number;
  valid: boolean;
}

export function insertSamples(db: DatabaseSync, rows: SampleRow[]): void {
  if (rows.length === 0) return;
  const stmt = db.prepare(
    `INSERT INTO xchange_samples (ts, provider, symbol, quote, bid, ask, mid, last, spread_bps,
       bid_qty, ask_qty, trade_px, trade_qty, trade_side, events, valid)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  for (const r of rows) {
    stmt.run(
      r.ts, r.provider, r.symbol, r.quote, r.bid, r.ask, r.mid, r.last, r.spreadBps,
      r.bidQty, r.askQty, r.tradePx, r.tradeQty, r.tradeSide, r.events, r.valid ? 1 : 0,
    );
  }
}

/** Latest sample per (provider, symbol) inside a window — the feature input. */
export function loadSamples(db: DatabaseSync, sinceMs: number, symbol?: string): SampleRow[] {
  const sql = `SELECT ts, provider, symbol, quote, bid, ask, mid, last, spread_bps AS spreadBps,
                      bid_qty AS bidQty, ask_qty AS askQty, trade_px AS tradePx,
                      trade_qty AS tradeQty, trade_side AS tradeSide, events, valid
                 FROM xchange_samples WHERE ts >= ? ${symbol ? 'AND symbol = ?' : ''}
                ORDER BY ts ASC`;
  const rows = (symbol
    ? db.prepare(sql).all(sinceMs, symbol)
    : db.prepare(sql).all(sinceMs)) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    ts: Number(r.ts),
    provider: String(r.provider),
    symbol: String(r.symbol),
    quote: String(r.quote),
    bid: r.bid === null ? null : Number(r.bid),
    ask: r.ask === null ? null : Number(r.ask),
    mid: r.mid === null ? null : Number(r.mid),
    last: r.last === null ? null : Number(r.last),
    spreadBps: r.spreadBps === null ? null : Number(r.spreadBps),
    bidQty: r.bidQty === null ? null : Number(r.bidQty),
    askQty: r.askQty === null ? null : Number(r.askQty),
    tradePx: r.tradePx === null ? null : Number(r.tradePx),
    tradeQty: r.tradeQty === null ? null : Number(r.tradeQty),
    tradeSide: r.tradeSide === null ? null : String(r.tradeSide),
    events: Number(r.events ?? 0),
    valid: Number(r.valid ?? 1) === 1,
  }));
}

export function pruneSamples(db: DatabaseSync, now = Date.now()): number {
  const cutoff = now - RETENTION_MS;
  const res = db.prepare('DELETE FROM xchange_samples WHERE ts < ?').run(cutoff);
  db.prepare('DELETE FROM xchange_snapshots WHERE ts < ?').run(now - 14 * 86_400_000);
  return Number(res.changes ?? 0);
}

export function saveSnapshot(db: DatabaseSync, ts: number, symbol: string, payload: unknown): void {
  db.prepare('INSERT INTO xchange_snapshots (ts, symbol, payload) VALUES (?,?,?)')
    .run(ts, symbol, JSON.stringify(payload));
}

export function loadSnapshots(db: DatabaseSync, sinceMs: number, symbol: string, limit = 288): unknown[] {
  const rows = db.prepare(
    'SELECT ts, symbol, payload FROM xchange_snapshots WHERE ts >= ? AND symbol = ? ORDER BY ts DESC LIMIT ?',
  ).all(sinceMs, symbol, limit) as unknown as Array<{ ts: number; symbol: string; payload: string }>;
  return rows.reverse().map((r) => ({ ts: r.ts, symbol: r.symbol, payload: JSON.parse(r.payload) }));
}

export function putContext(db: DatabaseSync, key: string, payload: unknown, ttlMs: number, now = Date.now()): void {
  db.prepare(
    `INSERT INTO xchange_context (key, ts, expires, payload) VALUES (?,?,?,?)
     ON CONFLICT(key) DO UPDATE SET ts = excluded.ts, expires = excluded.expires, payload = excluded.payload`,
  ).run(key, now, now + ttlMs, JSON.stringify(payload));
}

export function getContext(db: DatabaseSync, key: string, now = Date.now()): { ts: number; payload: unknown } | null {
  const row = db.prepare('SELECT ts, expires, payload FROM xchange_context WHERE key = ?').get(key) as
    | { ts: number; expires: number; payload: string }
    | undefined;
  if (!row || row.expires < now) return null;
  try {
    return { ts: row.ts, payload: JSON.parse(row.payload) };
  } catch {
    return null;
  }
}

export function countContext(db: DatabaseSync): number {
  return Number((db.prepare('SELECT COUNT(*) AS n FROM xchange_context').get() as { n: number }).n);
}

export function logProviderState(db: DatabaseSync, provider: string, state: string, detail: string | null, now = Date.now()): void {
  db.prepare('INSERT INTO xchange_provider_log (ts, provider, state, detail) VALUES (?,?,?,?)')
    .run(now, provider, state, detail);
}

/** In-memory accumulator: the latest top-of-book plus per-interval counters,
 *  flushed to `xchange_samples` every SAMPLE_MS by the registry. */
export class SampleAccumulator {
  private latest = new Map<string, VenueQuote>();
  private counts = new Map<string, number>();
  private trades = new Map<string, { px: number; qty: number; side: string | null }>();
  private valid = new Map<string, boolean>();

  observe(ev: CanonicalEvent): void {
    const key = `${ev.provider}|${ev.base}`;
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    this.valid.set(key, ev.bookValid);
    if (ev.type === 'trade' && ev.price !== null) {
      this.trades.set(key, { px: ev.price, qty: ev.size ?? 0, side: ev.side });
    }
    const bid = ev.bid;
    const ask = ev.ask;
    const mid = bid !== null && ask !== null ? (bid + ask) / 2 : ev.price;
    if (mid === null && ev.price === null) return;
    const prev = this.latest.get(key);
    const spreadBps = bid !== null && ask !== null && mid ? Math.round(((ask - bid) / mid) * 10_000 * 100) / 100 : prev?.spreadBps ?? null;
    this.latest.set(key, {
      provider: ev.provider,
      symbol: ev.base,
      quote: ev.quote,
      bid: bid ?? prev?.bid ?? null,
      ask: ask ?? prev?.ask ?? null,
      mid: mid ?? prev?.mid ?? null,
      last: ev.price ?? prev?.last ?? null,
      spreadBps,
      ts: ev.recvTs,
    });
  }

  /** Drain counters + latest quotes into rows ready for insert. */
  drain(now = Date.now()): SampleRow[] {
    const rows: SampleRow[] = [];
    for (const [key, q] of this.latest) {
      const events = this.counts.get(key) ?? 0;
      if (events === 0) continue; // silent venue -> no row (freshness shows in status)
      const trade = this.trades.get(key);
      rows.push({
        ts: now,
        provider: q.provider,
        symbol: q.symbol,
        quote: q.quote,
        bid: q.bid,
        ask: q.ask,
        mid: q.mid,
        last: q.last,
        spreadBps: q.spreadBps,
        bidQty: null,
        askQty: null,
        tradePx: trade?.px ?? null,
        tradeQty: trade?.qty ?? null,
        tradeSide: trade?.side ?? null,
        events,
        valid: this.valid.get(key) ?? true,
      });
      this.counts.set(key, 0);
      this.trades.delete(key);
    }
    return rows;
  }

  /** top-of-book quantities are tracked separately (only some feeds send them) */
  observeQty(provider: string, symbol: string, bidQty: number | null, askQty: number | null): void {
    const key = `${provider}|${symbol}`;
    const q = this.latest.get(key);
    if (!q) return;
    this.latest.set(key, { ...q });
    this.qty.set(key, { bidQty, askQty });
  }

  private qty = new Map<string, { bidQty: number | null; askQty: number | null }>();

  drainQty(): Map<string, { bidQty: number | null; askQty: number | null }> {
    return new Map(this.qty);
  }
}
