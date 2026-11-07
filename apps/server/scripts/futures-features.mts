/**
 * Priority 2 measurement: public permitted futures-market features from
 * Kraken Futures (no key, read-only REST). Captures funding rates, open
 * interest, mark/index basis per market. Research-only: prediction inputs,
 * never a leveraged-trading path.
 *
 *   node scripts/futures-features.mts
 * Output: compact summary + $TMPDIR/futures-features.json
 */

const t0 = Date.now();
const res = await fetch('https://futures.kraken.com/derivatives/api/v3/tickers');
const latencyMs = Date.now() - t0;
const body = (await res.json()) as { result?: string; tickers?: Array<Record<string, unknown>> };
if (body.result !== 'success' || !Array.isArray(body.tickers)) {
  console.error('futures API failure', res.status, JSON.stringify(body).slice(0, 300));
  process.exit(1);
}

interface Row {
  symbol: string; last: number | null; mark: number | null; index: number | null;
  basisBps: number | null; fundingBps8h: number | null; oi: number | null;
}
const rows: Row[] = [];
let withFunding = 0, withOi = 0;
for (const t of body.tickers) {
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const mark = num(t.markPrice), index = num(t.indexPrice);
  const funding = num(t.fundingRate);
  const row: Row = {
    symbol: String(t.symbol ?? '?'),
    last: num(t.last), mark, index,
    basisBps: mark !== null && index !== null && index > 0 ? ((mark - index) / index) * 10_000 : null,
    fundingBps8h: funding !== null ? funding * 10_000 : null,
    oi: num(t.openInterest),
  };
  if (row.fundingBps8h !== null) withFunding += 1;
  if (row.oi !== null) withOi += 1;
  rows.push(row);
}

const main = rows.filter((r) => /XBT|BTC|ETH/.test(r.symbol)).sort((a, b) => (b.oi ?? 0) - (a.oi ?? 0));
const topOi = [...rows].filter((r) => r.oi !== null).sort((a, b) => (b.oi ?? 0) - (a.oi ?? 0)).slice(0, 10);

console.log(`kraken futures tickers: ${rows.length} markets | with funding: ${withFunding} | with open interest: ${withOi} | REST latency ${latencyMs}ms | status ${res.status}`);
console.log('\nBTC/ETH markets (basis + funding + OI):');
for (const r of main.slice(0, 8)) {
  console.log(`  ${r.symbol.padEnd(18)} basis ${r.basisBps === null ? 'n/a' : r.basisBps.toFixed(1) + 'bp'} funding8h ${r.fundingBps8h === null ? 'n/a' : r.fundingBps8h.toFixed(3) + 'bp'} OI ${r.oi ?? 'n/a'} mark ${r.mark ?? '-'} index ${r.index ?? '-'}`);
}
console.log('\ntop-10 by open interest:', topOi.map((r) => `${r.symbol}:${r.oi}`).join(' '));

const { writeFileSync } = await import('node:fs');
const out = `${process.env.TMPDIR ?? '/tmp'}/futures-features.json`;
writeFileSync(out, JSON.stringify({ generatedAt: Date.now(), latencyMs, markets: rows.length, withFunding, withOi, rows }, null, 1));
console.log(`report -> ${out}`);
