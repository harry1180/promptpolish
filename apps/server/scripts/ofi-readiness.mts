/**
 * Phase E readiness probe: what timestamped trade / order-book history does
 * the existing Kraken feed actually hold, and is there enough of it to train
 * a lightweight OFI-XGBoost research challenger?
 *
 * READ-ONLY. Prints an honest READY / NOT READY verdict with numbers. This
 * script deliberately does NOT train or enable anything: the challenger
 * stays out of production decision-making until (a) the data threshold below
 * is met and (b) incremental improvement after costs is demonstrated on an
 * untouched holdout (separate approval required).
 *
 *   CRYPTO_DB=<path> node scripts/ofi-readiness.mts
 */
import { DatabaseSync } from 'node:sqlite';

const dbPath = process.env.CRYPTO_DB ?? '/var/lib/docker/volumes/promptpolish_pp-data/_data/crypto.db';
const db = new DatabaseSync(dbPath, { readOnly: true });

interface SnapRow { ts: number; symbol: string; payload: string }
const total = (db.prepare('SELECT COUNT(*) c FROM micro_snapshots').get() as { c: number }).c;
const rows = db.prepare('SELECT ts, symbol, payload FROM micro_snapshots ORDER BY ts').all() as unknown as SnapRow[];

let tradeFlow = 0;      // trades60 present -> OFI/volume features possible
let tob = 0;            // bid/ask sizes present -> book imbalance possible
let spread = 0;
let ret60 = 0;          // has 60s return feature (also usable as label context)
let symbols = new Set<string>();
let first = 0, last = 0;
const perDay = new Map<string, number>();
// labeled outcome availability: mid at (ts + 60s) exists within the SAME day window
const bySymbolDay = new Map<string, Array<{ ts: number; mid: number }>>();
for (const r of rows) {
  let p: Record<string, unknown>;
  try { p = JSON.parse(r.payload) as Record<string, unknown>; } catch { continue; }
  symbols.add(r.symbol);
  if (!first) first = r.ts;
  last = r.ts;
  const day = new Date(r.ts).toISOString().slice(0, 10);
  perDay.set(day, (perDay.get(day) ?? 0) + 1);
  const trades = p.trades60 as unknown;
  if (trades && typeof trades === 'object') tradeFlow++;
  if (typeof p.tobImbalance === 'number') tob++;
  if (typeof p.spreadBps === 'number') spread++;
  const rb = p.retBps as Record<string, number | null> | undefined;
  if (rb && typeof rb.s60 === 'number') ret60++;
  const mid = Number(p.mid);
  if (Number.isFinite(mid) && mid > 0) {
    const key = `${r.symbol}|${day}`;
    const arr = bySymbolDay.get(key) ?? [];
    arr.push({ ts: r.ts, mid });
    bySymbolDay.set(key, arr);
  }
}

// 60s-labeled pairs: a snapshot whose +60s outcome is inside 5..90s later
let labeled60 = 0;
for (const arr of bySymbolDay.values()) {
  arr.sort((a, b) => a.ts - b.ts);
  let j = 0;
  for (let i = 0; i < arr.length; i++) {
    while (j < arr.length && arr[j].ts < arr[i].ts + 60_000) j++;
    if (j < arr.length && arr[j].ts <= arr[i].ts + 90_000) labeled60++;
  }
}

const share = (n: number) => (total ? ((n / total) * 100).toFixed(1) : '0') + '%';
const days = [...perDay.keys()].sort();
const THRESHOLD = { minRows: 20_000, minLabeled: 15_000, minDays: 7 };

console.log('== OFI-XGBoost challenger data inventory ==');
console.log(`rows: ${total} | symbols: ${symbols.size} | span: ${first ? new Date(first).toISOString() : '-'} .. ${last ? new Date(last).toISOString() : '-'} | days: ${days.length}`);
console.log(`per-day: ${days.map((d) => `${d.slice(5)}:${perDay.get(d)}`).join(' ')}`);
console.log(`feature coverage: trades60 ${share(tradeFlow)} | tobImbalance ${share(tob)} | spreadBps ${share(spread)} | retBps.s60 ${share(ret60)}`);
console.log(`labeled 60s outcomes available NOW: ${labeled60}`);

const ready = total >= THRESHOLD.minRows && labeled60 >= THRESHOLD.minLabeled && days.length >= THRESHOLD.minDays;
console.log(`\nverdict: ${ready ? 'READY' : 'NOT READY'} — thresholds: rows>=${THRESHOLD.minRows}, labeled60>=${THRESHOLD.minLabeled}, days>=${THRESHOLD.minDays}`);
console.log(
  tradeFlow === 0
    ? 'note: SCALPING_ALPHA_ENABLED must be 1 for the trade channel (OFI inputs); currently no rows carry trades60.'
    : 'note: order-book depth (L2) is NOT recorded — only ticker top-of-book sizes; OFI is trade-flow based (aggressor side x size), book features are TOB imbalance only.',
);
console.log('no model is trained or enabled by this script — challenger training is gated on READY + separate approval.');
db.close();
