import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { TagMap } from '@promptslim/shared-types';

/* Row shapes mirror the SQL columns 1:1; mapping to domain types happens in
 * the route layer. */

export interface UserRow {
  id: number;
  email: string;
  name: string;
  pass_salt: string;
  pass_hash: string;
  tags_json: string;
  created_at: number;
}

export interface EventRow {
  id: number;
  user_id: number;
  ts: number;
  model_id: string;
  level: string;
  original_tokens: number;
  optimized_tokens: number;
  from_cache: number;
  cost_original_usd: number;
  cost_optimized_usd: number;
  tags_json: string;
  source: string; // 'optimizer' | 'chat'
  output_tokens: number;
  actual_cost_usd: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name        TEXT NOT NULL DEFAULT '',
  pass_salt   TEXT NOT NULL,
  pass_hash   TEXT NOT NULL,
  tags_json   TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS events (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id            INTEGER NOT NULL REFERENCES users(id),
  ts                 INTEGER NOT NULL,
  model_id           TEXT NOT NULL,
  level              TEXT NOT NULL,
  original_tokens    INTEGER NOT NULL,
  optimized_tokens   INTEGER NOT NULL,
  from_cache         INTEGER NOT NULL DEFAULT 0,
  cost_original_usd  REAL NOT NULL,
  cost_optimized_usd REAL NOT NULL,
  tags_json          TEXT NOT NULL DEFAULT '{}',
  source             TEXT NOT NULL DEFAULT 'optimizer',
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  actual_cost_usd    REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id);
CREATE INDEX IF NOT EXISTS idx_events_source ON events(source);
/* Provider API keys per account, AES-256-GCM blobs (keys.ts). The raw key is
 * NEVER stored or returned anywhere else. */
CREATE TABLE IF NOT EXISTS provider_keys (
  user_id     INTEGER NOT NULL REFERENCES users(id),
  provider    TEXT NOT NULL,
  key_blob    TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, provider)
);
/* Tag snapshot index: any (key, value) combination filter is an indexed
 * EXISTS lookup — this is what makes arbitrary tag combos cheap. */
CREATE TABLE IF NOT EXISTS event_tags (
  event_id  INTEGER NOT NULL REFERENCES events(id),
  key_l     TEXT NOT NULL,   -- lowercased tag key
  value     TEXT NOT NULL,
  PRIMARY KEY (event_id, key_l)
);
CREATE INDEX IF NOT EXISTS idx_event_tags_kv ON event_tags(key_l, value, event_id);
`;

/** Bring an older dev DB up to the current schema. CREATE TABLE IF NOT
 *  EXISTS never alters an existing table, so columns added after first
 *  release must be ALTERed in (SQLite ADD COLUMN with a constant default
 *  is cheap and safe). */
function migrate(db: DatabaseSync): void {
  const has = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='events'`).get();
  if (!has) return;
  const cols = new Set(
    (db.prepare('PRAGMA table_info(events)').all() as unknown as Array<{ name: string }>).map((c) => c.name),
  );
  const added: Array<[string, string]> = [
    ['source', "TEXT NOT NULL DEFAULT 'optimizer'"],
    ['output_tokens', 'INTEGER NOT NULL DEFAULT 0'],
    ['actual_cost_usd', 'REAL NOT NULL DEFAULT 0'],
  ];
  for (const [name, def] of added) {
    if (!cols.has(name)) db.exec(`ALTER TABLE events ADD COLUMN ${name} ${def}`);
  }
}

export function openDb(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  db.exec(SCHEMA);
  return db;
}

export function insertEvent(
  db: DatabaseSync,
  ev: Omit<EventRow, 'id'>,
): number {
  const res = db
    .prepare(
      `INSERT INTO events (user_id, ts, model_id, level, original_tokens, optimized_tokens,
        from_cache, cost_original_usd, cost_optimized_usd, tags_json,
        source, output_tokens, actual_cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      ev.user_id, ev.ts, ev.model_id, ev.level, ev.original_tokens, ev.optimized_tokens,
      ev.from_cache, ev.cost_original_usd, ev.cost_optimized_usd, ev.tags_json,
      ev.source ?? 'optimizer', ev.output_tokens ?? 0, ev.actual_cost_usd ?? 0,
    );
  const id = Number(res.lastInsertRowid);
  const tags = JSON.parse(ev.tags_json) as TagMap;
  const stmt = db.prepare('INSERT INTO event_tags (event_id, key_l, value) VALUES (?, ?, ?)');
  for (const [k, v] of Object.entries(tags)) stmt.run(id, k.trim().toLowerCase(), v);
  return id;
}

/** Load events for an aggregate query: tag filters AND via EXISTS lookups on
 *  the indexed (key_l, value) table; optional time window; newest-first cap. */
export function queryEvents(
  db: DatabaseSync,
  filters: Array<{ key: string; value: string }>,
  since: number | null,
  until: number | null,
  cap = 100_000,
): EventRow[] {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (since != null) {
    where.push('e.ts >= ?');
    params.push(since);
  }
  if (until != null) {
    where.push('e.ts <= ?');
    params.push(until);
  }
  for (const f of filters) {
    where.push(
      `EXISTS (SELECT 1 FROM event_tags t WHERE t.event_id = e.id AND t.key_l = ? AND t.value = ?)`,
    );
    params.push(f.key.trim().toLowerCase(), f.value.trim());
  }
  const sql =
    `SELECT e.* FROM events e${where.length ? ' WHERE ' + where.join(' AND ') : ''}` +
    ` ORDER BY e.id DESC LIMIT ?`;
  params.push(cap);
  return db.prepare(sql).all(...params) as unknown as EventRow[];
}

export function tagFacetsFromDb(
  db: DatabaseSync,
): Array<{ key: string; values: Array<{ value: string; events: number }> }> {
  const rows = db
    .prepare(
      `SELECT key_l AS key, value, COUNT(*) AS events
         FROM event_tags GROUP BY key_l, value ORDER BY key, events DESC`,
    )
    .all() as unknown as Array<{ key: string; value: string; events: number }>;
  const map = new Map<string, Array<{ value: string; events: number }>>();
  for (const r of rows) {
    let list = map.get(r.key);
    if (!list) {
      list = [];
      map.set(r.key, list);
    }
    list.push({ value: r.value, events: r.events });
  }
  return [...map.entries()].map(([key, values]) => ({ key, values }));
}

export function parseTags(json: string | null | undefined): TagMap {
  try {
    const v = JSON.parse(json ?? '{}') as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as TagMap) : {};
  } catch {
    return {};
  }
}
