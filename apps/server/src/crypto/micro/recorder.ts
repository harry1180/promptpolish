/**
 * Shadow recorder for the microstructure engine: appends feature snapshots
 * to `micro_snapshots` (crypto.db) with 7-day retention. This is the ONLY
 * persistence the micro module performs — it exists so the model/backtest
 * phases have real, ordered Kraken microstructure history to train on
 * (history starts at first enable; nothing is backfilled or synthesised).
 */
import type { DatabaseSync } from 'node:sqlite';
import type { MicroFeatures } from './features.ts';

const RETENTION_MS = 7 * 86_400_000;
const PRUNE_EVERY = 500;
let insertsSincePrune = 0;

export function recordMicroSnapshot(db: DatabaseSync, symbol: string, payload: MicroFeatures): void {
  db.prepare('INSERT INTO micro_snapshots (ts, symbol, payload) VALUES (?, ?, ?)')
    .run(payload.recvTs, symbol, JSON.stringify(payload));
  insertsSincePrune += 1;
  if (insertsSincePrune >= PRUNE_EVERY) {
    insertsSincePrune = 0;
    db.prepare('DELETE FROM micro_snapshots WHERE ts < ?').run(Date.now() - RETENTION_MS);
  }
}
