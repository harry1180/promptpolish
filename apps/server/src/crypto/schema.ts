/**
 * Crypto book storage — a SEPARATE SQLite file (/data/crypto.db) so the two
 * track records never contaminate each other.
 *
 * It reuses the TradingUSA DDL verbatim: the learning loop
 * (adaptive.ts) and the shadow experiments (experiments.ts) take a
 * DatabaseSync and read signals / paper_trades / strategy_weights /
 * knowledge_lessons / learning_events — identical columns means the crypto
 * book gets outcome feedback, weight refits, lesson revocation and
 * experiments for free, with its own evidence floor.
 *
 * Crypto-only additions: the universe membership table (pinned/ranked
 * membership with the hysteresis clocks) and `entry_fee` on positions, since
 * crypto fills carry an exchange fee on BOTH sides.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DDL } from '../tradingusa/schema.ts';

export const CRYPTO_DDL = `${DDL}
CREATE TABLE IF NOT EXISTS crypto_universe (
  symbol TEXT PRIMARY KEY,
  pinned INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  out_since INTEGER,
  in_since INTEGER,
  last_rank INTEGER,
  added_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS crypto_universe_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  action TEXT NOT NULL,
  symbol TEXT NOT NULL,
  detail TEXT
);
CREATE TABLE IF NOT EXISTS micro_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_micro_snapshots_ts ON micro_snapshots(ts);
-- Top-K ranking recorder (config.topk): one row per BUY signal the scan
-- creates, with its rank among that scan's candidates and whether the
-- un-shipped "best K only" rule would have kept it. RECORD-ONLY: nothing
-- reads this table on the decision path, so it can never change a trade.
CREATE TABLE IF NOT EXISTS shadow_topk (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  session_date TEXT NOT NULL,
  signal_id INTEGER NOT NULL UNIQUE,
  ticker TEXT NOT NULL,
  score REAL NOT NULL,
  confidence REAL NOT NULL,
  rank INTEGER NOT NULL,
  selected INTEGER NOT NULL,
  order_created INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_shadow_topk_session ON shadow_topk(session_date);`;

/** SQLite cannot ALTER the same column twice — add it only when missing. */
function ensureCryptoColumns(db: DatabaseSync): void {
  const cols = db.prepare('PRAGMA table_info(paper_positions)').all() as unknown as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'entry_fee')) {
    db.exec('ALTER TABLE paper_positions ADD COLUMN entry_fee REAL NOT NULL DEFAULT 0');
  }
}

export function openCryptoDb(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(CRYPTO_DDL);
  ensureCryptoColumns(db);
  return db;
}

/** Persisted universe membership (mirrors crypto_universe). */
export interface UniverseRow {
  symbol: string;
  pinned: number;
  active: number;
  out_since: number | null;
  in_since: number | null;
  last_rank: number | null;
  added_at: number;
  updated_at: number;
}

export function loadUniverse(db: DatabaseSync): UniverseRow[] {
  return db.prepare('SELECT * FROM crypto_universe ORDER BY pinned DESC, last_rank').all() as unknown as UniverseRow[];
}

export function saveUniverse(
  db: DatabaseSync,
  rows: Array<{ symbol: string; pinned: boolean; active: boolean; outSince: number | null; inSince: number | null; lastRank: number | null }>,
  now = Date.now(),
): void {
  const stmt = db.prepare(
    `INSERT INTO crypto_universe (symbol, pinned, active, out_since, in_since, last_rank, added_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(symbol) DO UPDATE SET pinned = excluded.pinned, active = excluded.active,
       out_since = excluded.out_since, in_since = excluded.in_since, last_rank = excluded.last_rank,
       updated_at = excluded.updated_at`,
  );
  for (const r of rows) {
    stmt.run(r.symbol, r.pinned ? 1 : 0, r.active ? 1 : 0, r.outSince, r.inSince, r.lastRank, now, now);
  }
}

export function logUniverseChange(db: DatabaseSync, action: string, symbol: string, detail: string, now = Date.now()): void {
  db.prepare('INSERT INTO crypto_universe_log (ts, action, symbol, detail) VALUES (?, ?, ?, ?)')
    .run(now, action, symbol, detail);
}
