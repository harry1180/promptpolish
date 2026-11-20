/**
 * KXBTC15M persistence — additive tables inside the existing crypto.db
 * (the crypto book already owns its own SQLite file, WAL mode; nothing here
 * touches TradingUSA or the promptpolice DB).
 *
 * What is stored, and why:
 *  - k15m_windows      one row per 15-minute market: lifecycle, strike, rules,
 *                      resolution. The backbone of every per-window report.
 *  - k15m_book_samples the decision tape: top-of-book + depth/flow metrics on
 *                      a fixed cadence (default 250 ms). Deltas run ~1,500/s
 *                      on an active window — persisting every one would be
 *                      100M+ rows/day, so the sample carries the derived state
 *                      while the book itself stays in memory.
 *  - k15m_trades       every print for our markets (deduped by trade_id) —
 *                      the full trade tape, no sampling.
 *  - k15m_feed_health  latency / staleness / gap counters, one row per minute:
 *                      "the signal was computed from data that arrived 800ms
 *                      late" is a fact we must be able to prove later.
 *
 * Retention is pruned by the runtime (RETENTION_DAYS).
 */
import type { DatabaseSync } from 'node:sqlite';
import type { BookMetrics } from './book.ts';
import type { WindowPhase } from './lifecycle.ts';

export const K15M_DDL = `
CREATE TABLE IF NOT EXISTS k15m_windows (
  event_ticker TEXT PRIMARY KEY,
  market_ticker TEXT,
  open_ts INTEGER NOT NULL,
  close_ts INTEGER NOT NULL,
  expire_ts INTEGER,
  strike REAL,
  status TEXT,
  phase TEXT,
  result TEXT,
  rules_primary TEXT,
  yes_bid REAL,
  yes_ask REAL,
  volume REAL,
  open_interest REAL,
  first_seen_ts INTEGER NOT NULL,
  updated_ts INTEGER NOT NULL,
  settled_result TEXT,
  settle_note TEXT
);
CREATE INDEX IF NOT EXISTS idx_k15m_windows_close ON k15m_windows(close_ts);

CREATE TABLE IF NOT EXISTS k15m_book_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  market_ticker TEXT NOT NULL,
  event_ticker TEXT,
  phase TEXT NOT NULL,
  ms_to_close INTEGER NOT NULL,
  yes_bid REAL, yes_ask REAL, yes_bid_size REAL, yes_ask_size REAL,
  spread REAL, micro REAL,
  bid_depth REAL, ask_depth REAL, imbalance REAL, ofi REAL,
  cancel_ratio REAL, deltas INTEGER,
  trades_1s INTEGER, qty_1s REAL, trades_5s INTEGER, qty_5s REAL,
  taker_bias_60s REAL,
  walk_bid REAL, walk_ask REAL,
  levels_bid INTEGER, levels_ask INTEGER,
  spot_mid REAL, spot_divergence REAL,
  arrival_latency_ms REAL, staleness_ms REAL, clock_drift_ms REAL,
  needs_snapshot INTEGER NOT NULL DEFAULT 0,
  -- settlement fair value (module 3): APPROXIMATION of the BRTI settlement,
  -- never the index itself. edge_pp = (p_yes - implied_mid) * 100.
  fair_spot REAL, fair_sigma REAL, fair_yes REAL, implied_mid REAL,
  edge_pp REAL, fair_reason TEXT, fair_approx TEXT
);
CREATE INDEX IF NOT EXISTS idx_k15m_samples_market_ts ON k15m_book_samples(market_ticker, ts);

CREATE TABLE IF NOT EXISTS k15m_trades (
  trade_id TEXT PRIMARY KEY,
  ts_ms INTEGER NOT NULL,
  market_ticker TEXT NOT NULL,
  event_ticker TEXT,
  yes_price REAL NOT NULL,
  no_price REAL NOT NULL,
  qty REAL NOT NULL,
  taker_side TEXT,
  taker_book_side TEXT,
  seq INTEGER,
  ingested_ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_k15m_trades_market_ts ON k15m_trades(market_ticker, ts_ms);

CREATE TABLE IF NOT EXISTS k15m_feed_health (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  market_ticker TEXT,
  phase TEXT,
  frames INTEGER NOT NULL DEFAULT 0,
  book_frames INTEGER NOT NULL DEFAULT 0,
  trade_frames INTEGER NOT NULL DEFAULT 0,
  seq_gaps INTEGER NOT NULL DEFAULT 0,
  reconnects INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  last_frame_age_ms INTEGER,
  latency_p50_ms REAL, latency_p95_ms REAL,
  clock_drift_ms REAL,
  stale INTEGER NOT NULL DEFAULT 0,
  book_trusted INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_k15m_health_ts ON k15m_feed_health(ts);`;

/** Columns added after the table first shipped (existing DBs get them too). */
const K15M_SAMPLE_MIGRATION: Array<[string, string]> = [
  ['fair_spot', 'REAL'],
  ['fair_sigma', 'REAL'],
  ['fair_yes', 'REAL'],
  ['implied_mid', 'REAL'],
  ['edge_pp', 'REAL'],
  ['fair_reason', 'TEXT'],
  ['fair_approx', 'TEXT'],
];

/** Open (or create) the kalshi15m tables on an existing database handle. */
export function ensureK15mTables(db: DatabaseSync): void {
  db.exec(K15M_DDL);
  // SQLite cannot ALTER the same column twice — add only what is missing
  const cols = new Set(
    (db.prepare('PRAGMA table_info(k15m_book_samples)').all() as unknown as Array<{ name: string }>)
      .map((c) => c.name),
  );
  for (const [name, type] of K15M_SAMPLE_MIGRATION) {
    if (!cols.has(name)) db.exec(`ALTER TABLE k15m_book_samples ADD COLUMN ${name} ${type}`);
  }
}

export interface WindowRow {
  eventTicker: string;
  marketTicker: string | null;
  openTs: number;
  closeTs: number;
  expireTs: number | null;
  strike: number | null;
  status: string | null;
  phase: string;
  result: string | null;
  rules: string | null;
  firstSeenTs: number;
  updatedTs: number;
}

export function upsertWindow(db: DatabaseSync, row: WindowRow): void {
  db.prepare(
    `INSERT INTO k15m_windows (event_ticker, market_ticker, open_ts, close_ts, expire_ts,
        strike, status, phase, result, rules_primary, first_seen_ts, updated_ts)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(event_ticker) DO UPDATE SET
       market_ticker = COALESCE(excluded.market_ticker, k15m_windows.market_ticker),
       open_ts = excluded.open_ts, close_ts = excluded.close_ts,
       expire_ts = COALESCE(excluded.expire_ts, k15m_windows.expire_ts),
       strike = COALESCE(excluded.strike, k15m_windows.strike),
       status = COALESCE(excluded.status, k15m_windows.status),
       phase = excluded.phase,
       result = COALESCE(excluded.result, k15m_windows.result),
       rules_primary = COALESCE(excluded.rules_primary, k15m_windows.rules_primary),
       updated_ts = excluded.updated_ts`,
  ).run(
    row.eventTicker, row.marketTicker, row.openTs, row.closeTs, row.expireTs,
    row.strike, row.status, row.phase, row.result, row.rules,
    row.firstSeenTs, row.updatedTs,
  );
}

export function updateWindowQuotes(
  db: DatabaseSync, eventTicker: string,
  q: { yesBid?: number | null; yesAsk?: number | null; volume?: number | null; openInterest?: number | null },
  now: number,
): void {
  db.prepare(
    `UPDATE k15m_windows SET yes_bid = COALESCE(?, yes_bid), yes_ask = COALESCE(?, yes_ask),
        volume = COALESCE(?, volume), open_interest = COALESCE(?, open_interest), updated_ts = ?
      WHERE event_ticker = ?`,
  ).run(q.yesBid ?? null, q.yesAsk ?? null, q.volume ?? null, q.openInterest ?? null, now, eventTicker);
}

export function setWindowResult(db: DatabaseSync, eventTicker: string, result: string, note: string | null, now: number): void {
  db.prepare(
    `UPDATE k15m_windows SET settled_result = ?, settle_note = ?, status = 'settled', phase = 'EXPIRED',
        updated_ts = ?
      WHERE event_ticker = ? AND (settled_result IS NULL OR settled_result = '')`,
  ).run(result, note, now, eventTicker);
}

/** Settlement fair value recorded with the sample (module 3, APPROXIMATION). */
export interface SampleFair {
  spot: number | null;
  sigma: number | null;
  pYes: number | null;
  impliedMid: number | null;
  /** (p_yes - implied_mid) * 100 — model edge in percentage points */
  edgePp: number | null;
  reason: string | null;
  /** which venue the spot came from (kraken / coinbase) — provenance */
  approx: string | null;
}

export interface SampleRow {
  ts: number;
  marketTicker: string;
  eventTicker: string | null;
  phase: WindowPhase | string;
  msToClose: number;
  metrics: BookMetrics;
  spotMid?: number | null;
  spotDivergence?: number | null;
  arrivalLatencyMs?: number | null;
  stalenessMs?: number | null;
  clockDriftMs?: number | null;
  needsSnapshot: boolean;
  fair?: SampleFair | null;
}

export function insertSample(db: DatabaseSync, s: SampleRow): void {
  const m = s.metrics;
  const micro = m.bestBid !== null && m.bestAsk !== null
    ? (m.bestBidSize * m.bestAsk + m.bestAskSize * m.bestBid) / Math.max(1e-9, m.bestBidSize + m.bestAskSize)
    : null;
  db.prepare(
    `INSERT INTO k15m_book_samples (ts, market_ticker, event_ticker, phase, ms_to_close,
       yes_bid, yes_ask, yes_bid_size, yes_ask_size, spread, micro,
       bid_depth, ask_depth, imbalance, ofi, cancel_ratio, deltas,
       trades_1s, qty_1s, trades_5s, qty_5s, taker_bias_60s,
       walk_bid, walk_ask, levels_bid, levels_ask,
       spot_mid, spot_divergence, arrival_latency_ms, staleness_ms, clock_drift_ms,
       needs_snapshot, fair_spot, fair_sigma, fair_yes, implied_mid, edge_pp, fair_reason, fair_approx)
     VALUES (${Array(39).fill('?').join(',')})`,
  ).run(
    s.ts, s.marketTicker, s.eventTicker, s.phase, s.msToClose,
    m.bestBid, m.bestAsk, m.bestBidSize, m.bestAskSize, m.spread, micro,
    m.bidDepthWalk, m.askDepthWalk, m.imbalance, m.ofi, m.cancelRatio, m.deltasInWindow,
    m.trades1s, m.qty1s, m.trades5s, m.qty5s, m.takerBias60s,
    m.bidDepthWalk, m.askDepthWalk, m.levels.bids, m.levels.asks,
    s.spotMid ?? null, s.spotDivergence ?? null,
    s.arrivalLatencyMs ?? null, s.stalenessMs ?? null, s.clockDriftMs ?? null,
    s.needsSnapshot ? 1 : 0,
    s.fair?.spot ?? null, s.fair?.sigma ?? null, s.fair?.pYes ?? null,
    s.fair?.impliedMid ?? null, s.fair?.edgePp ?? null, s.fair?.reason ?? null,
    s.fair?.approx ?? null,
  );
}

/** Returns false when the print was already stored (idempotent ingest). */
export function insertTrade(
  db: DatabaseSync,
  t: {
    tradeId: string; tsMs: number; marketTicker: string; eventTicker?: string | null;
    yesPrice: number; noPrice: number; qty: number;
    takerSide?: string | null; takerBookSide?: string | null; seq?: number | null;
  },
  now = Date.now(),
): boolean {
  const res = db.prepare(
    `INSERT OR IGNORE INTO k15m_trades (trade_id, ts_ms, market_ticker, event_ticker,
       yes_price, no_price, qty, taker_side, taker_book_side, seq, ingested_ts)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    t.tradeId, t.tsMs, t.marketTicker, t.eventTicker ?? null,
    t.yesPrice, t.noPrice, t.qty, t.takerSide ?? null, t.takerBookSide ?? null,
    t.seq ?? null, now,
  );
  return Number(res.changes) > 0;
}

export interface HealthRow {
  ts: number;
  marketTicker: string | null;
  phase: string | null;
  frames: number;
  bookFrames: number;
  tradeFrames: number;
  seqGaps: number;
  reconnects: number;
  errors: number;
  lastFrameAgeMs: number | null;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  clockDriftMs: number | null;
  stale: boolean;
  bookTrusted: boolean;
}

export function insertHealth(db: DatabaseSync, h: HealthRow): void {
  db.prepare(
    `INSERT INTO k15m_feed_health (ts, market_ticker, phase, frames, book_frames, trade_frames,
       seq_gaps, reconnects, errors, last_frame_age_ms, latency_p50_ms, latency_p95_ms,
       clock_drift_ms, stale, book_trusted)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    h.ts, h.marketTicker, h.phase, h.frames, h.bookFrames, h.tradeFrames,
    h.seqGaps, h.reconnects, h.errors, h.lastFrameAgeMs,
    h.latencyP50Ms, h.latencyP95Ms, h.clockDriftMs,
    h.stale ? 1 : 0, h.bookTrusted ? 1 : 0,
  );
}

export function latestHealth(db: DatabaseSync, limit = 20): Array<Record<string, unknown>> {
  return db.prepare('SELECT * FROM k15m_feed_health ORDER BY id DESC LIMIT ?').all(limit) as unknown as Array<Record<string, unknown>>;
}

export function recentSamples(db: DatabaseSync, marketTicker: string, limit = 500): Array<Record<string, unknown>> {
  return db.prepare(
    'SELECT * FROM k15m_book_samples WHERE market_ticker = ? ORDER BY id DESC LIMIT ?',
  ).all(marketTicker, limit) as unknown as Array<Record<string, unknown>>;
}

export function windowRows(db: DatabaseSync, limit = 20): Array<Record<string, unknown>> {
  return db.prepare('SELECT * FROM k15m_windows ORDER BY close_ts DESC LIMIT ?').all(limit) as unknown as Array<Record<string, unknown>>;
}

/** Age-based retention — keeps the file bounded without touching other tables. */
export function pruneK15m(db: DatabaseSync, retentionDays: number, now = Date.now()): { samples: number; trades: number; health: number } {
  const cut = now - retentionDays * 86_400_000;
  const s = db.prepare('DELETE FROM k15m_book_samples WHERE ts < ?').run(cut);
  const t = db.prepare('DELETE FROM k15m_trades WHERE ts_ms < ?').run(cut);
  const h = db.prepare('DELETE FROM k15m_feed_health WHERE ts < ?').run(cut);
  return { samples: Number(s.changes), trades: Number(t.changes), health: Number(h.changes) };
}

/** Counts for the dashboard (cheap: indexed COUNTs only). */
export function k15mCounts(db: DatabaseSync): Record<string, number> {
  const q = (sql: string): number => Number((db.prepare(sql).get() as { n: number }).n);
  return {
    windows: q('SELECT COUNT(*) AS n FROM k15m_windows'),
    samples: q('SELECT COUNT(*) AS n FROM k15m_book_samples'),
    trades: q('SELECT COUNT(*) AS n FROM k15m_trades'),
    health: q('SELECT COUNT(*) AS n FROM k15m_feed_health'),
  };
}