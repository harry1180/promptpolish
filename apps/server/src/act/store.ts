/**
 * Agent Control Tower storage — TWO SEPARATE DATABASES.
 *
 * Demo and Production never share a file, a connection or a table: the demo
 * handler only ever receives the demo store handle, the production handler
 * only the production handle, and the mode is decided by server configuration
 * (`ACT_DEMO_ENABLED` / `ACT_PROD_ENABLED` / `ACT_PROD_ENTITLED`), never by a
 * request field. `environment = demo` in a JSON body is NOT the boundary —
 * the boundary is which database handle the code path can reach.
 *
 * Evidence: append-only, hash-chained (sha256 over prev hash + record). Rows
 * carry tenant_id so every read is tenant-scoped.
 */

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ActEvent, ActMode } from '@promptslim/act';

const GENESIS = '0'.repeat(64);

export interface ActStore {
  mode: ActMode;
  tenant: string;
  db: DatabaseSync;
  path: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS act_events (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        INTEGER NOT NULL,
  tenant    TEXT NOT NULL,
  type      TEXT NOT NULL,
  payload   TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_act_events_tenant ON act_events(tenant, seq);
/* kill / containment state per agent (external to any agent runtime) */
CREATE TABLE IF NOT EXISTS act_agents (
  tenant      TEXT NOT NULL,
  agent_id    TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active',
  revoked_at  INTEGER,
  killed_at   INTEGER,
  kill_ms     INTEGER,
  PRIMARY KEY (tenant, agent_id)
);
/* transaction integrity: idempotency keys + replay protection */
CREATE TABLE IF NOT EXISTS act_idempotency (
  tenant TEXT NOT NULL,
  key    TEXT NOT NULL,
  ts     INTEGER NOT NULL,
  PRIMARY KEY (tenant, key)
);
`;

export function openActStore(path: string, mode: ActMode, tenant: string): ActStore {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return { mode, tenant, db, path };
}

function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export interface StoredEvent extends ActEvent {
  tenant: string;
  hash: string;
  prevHash: string;
}

export function appendEvent(
  store: ActStore,
  type: ActEvent['type'],
  payload: Record<string, unknown>,
  ts = Date.now(),
): StoredEvent {
  const last = store.db
    .prepare('SELECT seq, ts, type, payload, hash FROM act_events WHERE tenant = ? ORDER BY seq DESC LIMIT 1')
    .get(store.tenant) as { hash?: string } | undefined;
  const prevHash = last?.hash ?? GENESIS;
  const body = JSON.stringify(payload);
  const hash = sha256(`${prevHash}|${ts}|${store.tenant}|${type}|${body}`);
  const res = store.db
    .prepare('INSERT INTO act_events (ts, tenant, type, payload, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?)')
    .run(ts, store.tenant, type, body, prevHash, hash);
  return {
    seq: Number(res.lastInsertRowid),
    ts,
    tenant: store.tenant,
    type,
    payload,
    prevHash,
    hash,
  };
}

export function listEvents(store: ActStore, cap = 5000): ActEvent[] {
  const rows = store.db
    .prepare('SELECT seq, ts, type, payload FROM act_events WHERE tenant = ? ORDER BY seq ASC LIMIT ?')
    .all(store.tenant, cap) as unknown as Array<{ seq: number; ts: number; type: string; payload: string }>;
  return rows.map((r) => ({
    seq: r.seq,
    ts: r.ts,
    type: r.type as ActEvent['type'],
    payload: JSON.parse(r.payload) as Record<string, unknown>,
  }));
}

export function evidenceRecords(store: ActStore, cap = 500) {
  const rows = store.db
    .prepare('SELECT seq, ts, type, payload, prev_hash, hash FROM act_events WHERE tenant = ? ORDER BY seq DESC LIMIT ?')
    .all(store.tenant, cap) as unknown as Array<{
      seq: number; ts: number; type: string; payload: string; prev_hash: string; hash: string;
    }>;
  return rows.map((r) => ({
    seq: r.seq,
    ts: r.ts,
    type: r.type,
    tenant: store.tenant,
    environment: store.mode,
    payload: JSON.parse(r.payload) as Record<string, unknown>,
    prevHash: r.prev_hash,
    hash: r.hash,
  }));
}

/** Recompute the whole chain — any tampering breaks it. */
export function verifyChain(store: ActStore): { valid: boolean; count: number; brokenAtSeq?: number } {
  const rows = store.db
    .prepare('SELECT seq, ts, tenant, type, payload, prev_hash, hash FROM act_events WHERE tenant = ? ORDER BY seq ASC')
    .all(store.tenant) as unknown as Array<{
      seq: number; ts: number; tenant: string; type: string; payload: string; prev_hash: string; hash: string;
    }>;
  let prev = GENESIS;
  for (const r of rows) {
    const expected = sha256(`${prev}|${r.ts}|${r.tenant}|${r.type}|${r.payload}`);
    if (r.prev_hash !== prev || r.hash !== expected) {
      return { valid: false, count: rows.length, brokenAtSeq: r.seq };
    }
    prev = r.hash;
  }
  return { valid: true, count: rows.length };
}

/** Demo reset: clears ONLY this store's events. Production is a different file. */
export function resetStore(store: ActStore): { deleted: number } {
  const res = store.db.prepare('DELETE FROM act_events WHERE tenant = ?').run(store.tenant);
  store.db.prepare('DELETE FROM act_agents WHERE tenant = ?').run(store.tenant);
  store.db.prepare('DELETE FROM act_idempotency WHERE tenant = ?').run(store.tenant);
  return { deleted: Number(res.changes) };
}

/* ---------------- agent containment state ---------------- */

export function getAgentState(store: ActStore, agentId: string): { status: string; killedAt: number | null } {
  const row = store.db
    .prepare('SELECT status, killed_at FROM act_agents WHERE tenant = ? AND agent_id = ?')
    .get(store.tenant, agentId) as { status?: string; killed_at?: number | null } | undefined;
  return { status: row?.status ?? 'active', killedAt: row?.killed_at ?? null };
}

export function setAgentState(
  store: ActStore,
  agentId: string,
  patch: { status?: string; revokedAt?: number | null; killedAt?: number | null; killMs?: number | null },
): void {
  const cur = getAgentState(store, agentId);
  store.db.prepare(
    `INSERT INTO act_agents (tenant, agent_id, status, revoked_at, killed_at, kill_ms)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(tenant, agent_id) DO UPDATE SET
       status = excluded.status,
       revoked_at = COALESCE(excluded.revoked_at, act_agents.revoked_at),
       killed_at = COALESCE(excluded.killed_at, act_agents.killed_at),
       kill_ms = COALESCE(excluded.kill_ms, act_agents.kill_ms)`,
  ).run(
    store.tenant,
    agentId,
    patch.status ?? cur.status,
    patch.revokedAt ?? null,
    patch.killedAt ?? null,
    patch.killMs ?? null,
  );
}

/* ---------------- idempotency / replay ---------------- */

/** Returns true the first time a key is seen for this tenant, false on replay. */
export function firstUse(store: ActStore, key: string, now = Date.now()): boolean {
  const existing = store.db
    .prepare('SELECT key FROM act_idempotency WHERE tenant = ? AND key = ?')
    .get(store.tenant, key);
  if (existing) return false;
  store.db.prepare('INSERT INTO act_idempotency (tenant, key, ts) VALUES (?, ?, ?)').run(store.tenant, key, now);
  return true;
}

/* ---------------- runtime configuration (server-side only) ---------------- */

export interface ActConfig {
  demoEnabled: boolean;
  prodEnabled: boolean;
  prodEntitled: boolean;
  prodTenant: string;
  demoDbPath: string;
  prodDbPath: string;
  reason: string;
}

export function actConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ActConfig {
  const demoEnabled = env.ACT_DEMO_ENABLED !== '0';
  const prodEnabled = env.ACT_PROD_ENABLED === '1';
  const entitled = env.ACT_PROD_ENTITLED === '1';
  const dir = env.ACT_DB_DIR ?? (env.PP_DB ?? 'data/promptpolice.db').replace(/\/[^/]+$/, '');
  return {
    demoEnabled,
    prodEnabled,
    prodEntitled: prodEnabled && entitled,
    prodTenant: env.ACT_PROD_TENANT ?? 'prod-tenant-001',
    demoDbPath: `${dir}/act-demo.db`,
    prodDbPath: `${dir}/act-prod.db`,
    reason:
      prodEnabled && entitled
        ? 'production mode enabled by server configuration and entitlement'
        : !prodEnabled
          ? 'production mode is not enabled for this deployment (server configuration)'
          : 'production mode is enabled but this tenant is not entitled (readiness gate)',
  };
}

/**
 * The act stack: lazily opened, per-mode stores. Demo and production are
 * separate DatabaseSync handles over separate files.
 */
export class ActStack {
  private demo: ActStore | null = null;
  private prod: ActStore | null = null;
  private readonly cfg: ActConfig;
  private readonly demoTenant: string;

  constructor(cfg: ActConfig, demoTenant: string) {
    this.cfg = cfg;
    this.demoTenant = demoTenant;
  }

  get config(): ActConfig {
    return this.cfg;
  }

  demoStore(): ActStore | null {
    if (!this.cfg.demoEnabled) return null;
    if (!this.demo) this.demo = openActStore(this.cfg.demoDbPath, 'demo', this.demoTenant);
    return this.demo;
  }

  prodStore(): ActStore | null {
    if (!this.cfg.prodEntitled) return null;
    if (!this.prod) this.prod = openActStore(this.cfg.prodDbPath, 'production', this.cfg.prodTenant);
    return this.prod;
  }

  /** Tests: swap stores for in-memory databases. */
  inject(demo: ActStore | null, prod: ActStore | null): void {
    this.demo = demo;
    this.prod = prod;
  }
}