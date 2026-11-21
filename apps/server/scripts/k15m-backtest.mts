/**
 * Replay the recorded KXBTC15M tape through the same strategies the shadow
 * engine runs live, and report per-strategy / per-split performance.
 *
 *   node scripts/k15m-backtest.mts [dbPath] [jsonOutPath]
 *
 * Defaults: the production crypto.db (docker volume) and $TMPDIR output.
 * READ-ONLY against the database — the backtester never writes to it.
 */
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
import { backtestConfigFromEnv, runBacktest } from '../src/kalshi15m/backtest.ts';

const DEFAULT_DB = '/var/lib/docker/volumes/promptpolish_pp-data/_data/crypto.db';
const dbPath = process.argv[2] ?? process.env.CRYPTO_DB ?? DEFAULT_DB;
const outPath = process.argv[3] ?? `${process.env.TMPDIR ?? '/tmp'}/k15m-backtest.json`;

let db: DatabaseSync;
try {
  db = new DatabaseSync(dbPath, { readOnly: true });
} catch {
  db = new DatabaseSync(dbPath); // older node:sqlite without readOnly
}

const cfg = backtestConfigFromEnv();
const report = runBacktest(db, cfg);
writeFileSync(outPath, JSON.stringify(report, null, 2));

const pct = (v: number | null): string => (v === null ? '  n/a' : `${v.toFixed(1)}%`);
const n2 = (v: number | null): string => (v === null ? '  n/a' : v.toFixed(2).padStart(8));
console.log(`db=${dbPath}`);
console.log(`windows=${report.windows.total} withSettlementResult=${report.windows.withResult} ` +
  `strategies=${Object.keys(report.byStrategy).length} hold=${cfg.holdSec}s eval=${cfg.evalMs}ms`);
console.log('strategy           eval   taken  skip  win%   net/c   PF     maxDD  tail5  fees   SPLIT(test n/c)');
for (const [name, s] of Object.entries(report.byStrategy)) {
  const t = s.bySplit.TEST;
  console.log(
    `${name.padEnd(18)}${String(s.evaluated).padStart(5)}${String(s.taken).padStart(7)}` +
    `${String(s.skipped).padStart(6)}${pct(t.winRatePct).padStart(6)}${n2(t.netPerContractPp)}` +
    `${n2(t.profitFactor)}${n2(t.maxDrawdownPp)}${n2(t.tailP5Pp)}${n2(t.feesPp)}  ` +
    `test n=${t.scorable}${t.unscorable ? ` unscored=${t.unscorable}` : ''}`,
  );
}
console.log(`totals: ${report.totals.scorable} scorable / ${report.totals.unscorable} unscorable, ` +
  `net ${n2(report.totals.netPp).trim()}c total, ${n2(report.totals.netPerContractPp).trim()}c per contract`);
for (const note of report.notes) console.log(`- ${note}`);
console.log(`full report: ${outPath}`);
db.close();
