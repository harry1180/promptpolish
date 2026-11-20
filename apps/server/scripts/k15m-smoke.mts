/**
 * Live smoke test for the Kalshi 15-minute data engine (module 1).
 *
 *   node scripts/k15m-smoke.mts [seconds]
 *
 * Connects to the REAL Kalshi websocket (Ed25519 creds from
 * KALSHI_API_KEY_ID / KALSHI_PRIVATE_KEY_PATH — read from the env file the
 * predict dashboard already uses when not set), records into an in-memory
 * database, and prints what landed. No orders are placed; this path has no
 * order code at all. Never prints credentials.
 */
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { K15mRuntime } from '../src/kalshi15m/runtime.ts';

// fill credentials from the predict dashboard's env file when unset
if (!process.env.KALSHI_API_KEY_ID || !process.env.KALSHI_PRIVATE_KEY_PATH) {
  try {
    const env = readFileSync('/opt/yard/predict_app/.env', 'utf8');
    const get = (k: string): string | undefined => env.match(new RegExp(`^${k}=(.+)$`, 'm'))?.[1]?.trim();
    process.env.KALSHI_API_KEY_ID ??= get('KALSHI_API_KEY_ID') ?? '';
    process.env.KALSHI_PRIVATE_KEY_PATH ??= get('KALSHI_PRIVATE_KEY_PATH') ?? '';
  } catch { /* runtime will report "no credentials" honestly */ }
}

const seconds = Number(process.argv[2] ?? 45);
const db = new DatabaseSync(':memory:');
const rt = new K15mRuntime({
  db,
  config: {
    enabled: true,
    series: 'KXBTC15M',
    sampleMs: 250,
    discoverMs: 10_000,
    healthMs: 5_000,
    retentionDays: 14,
    staleMs: 5_000,
    snapshotRecoveryMs: 1_500,
    auth: {
      apiKeyId: process.env.KALSHI_API_KEY_ID,
      privateKeyPath: process.env.KALSHI_PRIVATE_KEY_PATH,
    },
  },
});

console.log(`[smoke] starting: ${seconds}s against live Kalshi (in-memory DB)`);
rt.start();

await new Promise<void>((resolve) => setTimeout(() => resolve(), seconds * 1000));

const count = (t: string): number =>
  Number((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n);

const status = rt.status();
console.log('[smoke] status:', JSON.stringify(status, null, 2));
console.log('[smoke] rows:', JSON.stringify({
  windows: count('k15m_windows'),
  samples: count('k15m_book_samples'),
  trades: count('k15m_trades'),
  health: count('k15m_feed_health'),
}));

const lastSample = db.prepare('SELECT * FROM k15m_book_samples ORDER BY id DESC LIMIT 1').get();
console.log('[smoke] last sample:', JSON.stringify(lastSample));
const lastHealth = db.prepare('SELECT * FROM k15m_feed_health ORDER BY id DESC LIMIT 1').get();
console.log('[smoke] last health:', JSON.stringify(lastHealth));
const lastTrade = db.prepare('SELECT * FROM k15m_trades ORDER BY ts_ms DESC LIMIT 1').get();
console.log('[smoke] last trade:', JSON.stringify(lastTrade));

rt.stop();
db.close();
process.exit(0);