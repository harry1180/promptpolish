/**
 * Why is fuse() not emitting BUY? Categories the non-BUY outcome falls into,
 * over a date window. Read-only.
 *
 *   CRYPTO_DB=<path>/crypto.db node scripts/crypto-blockers.mts [fromISO] [toISO]
 */
import { DatabaseSync } from 'node:sqlite';
import { detectRegime, fuse, shortTermScore } from '@promptslim/tucore';
import type { Candle, ScoreParts } from '@promptslim/tucore';

const dbPath = process.env.CRYPTO_DB ?? '/root/.hermes/cache/scratch/crypto.db';
const FROM = process.argv[2] ?? '2025-11-03';
const TO = process.argv[3] ?? '2026-11-05';

const REGIME_SCORE: Record<string, number> = {
  BULL_TREND: 0.5, RISK_ON: 0.5, MOMENTUM: 0.5,
  LOW_VOLATILITY: 0.25, RECOVERY: 0.25, MEAN_REVERSION: 0,
  BEAR_TREND: -0.5, RISK_OFF: -0.5, LIQUIDITY_STRESS: -0.5, HIGH_VOLATILITY: -0.5,
  UNCERTAIN: 0,
};
interface BarRow { ticker: string; date: string; open: number; high: number; low: number; close: number; volume: number }

const db = new DatabaseSync(dbPath, { readOnly: true });
const rows = db.prepare('SELECT ticker, date, open, high, low, close, volume FROM market_bars ORDER BY ticker, date')
  .all() as unknown as BarRow[];
const barsByTicker = new Map<string, Candle[]>();
for (const r of rows) {
  const c: Candle = { date: r.date, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume };
  const a = barsByTicker.get(r.ticker);
  if (a) a.push(c); else barsByTicker.set(r.ticker, [c]);
}
const universe = (db.prepare('SELECT symbol FROM crypto_universe WHERE active = 1').all() as unknown as Array<{ symbol: string }>)
  .map((r) => r.symbol);
const bench = barsByTicker.get('BTC') ?? [];
const btcPos = new Map(bench.map((c, i) => [c.date, i]));

const counts: Record<string, number> = {};
const bump = (k: string): void => { counts[k] = (counts[k] ?? 0) + 1; };
let coinDays = 0, stratBuy = 0, fuseBuy = 0, fuseBuyBelowFloor = 0;

for (const t of universe) {
  const bars = barsByTicker.get(t) ?? [];
  for (let i = 119; i < bars.length; i++) {
    const date = bars[i].date;
    if (date < FROM || date > TO) continue;
    const bp = btcPos.get(date);
    if (bp === undefined || bp < 119) continue;
    coinDays++;
    const candles = bars.slice(0, i + 1);
    const benchSlice = bench.slice(0, bp + 1);
    const regime = detectRegime(benchSlice).regime;
    const st = shortTermScore({
      ticker: t, company: t, candles, benchmarkCandles: benchSlice,
      quote: { symbol: t, price: candles[i].close, prevClose: candles[i - 1].close, ts: Date.parse(`${date}T00:00:00Z`) },
      regime, events: [], sessionDate: date,
    });
    if (st.action === 'INSUFFICIENT_DATA') continue;
    if (st.action === 'BUY') stratBuy++;

    const parts: ScoreParts = {
      technical: st.score, fundamental: 0, event: 0, sentiment: 0, macro: 0,
      regime: REGIME_SCORE[regime] ?? 0,
    };
    const f = fuse({ parts, horizon: 'SHORT', strategy: 'crypto_momentum_v1', confidenceHint: st.confidence, evidence: st.evidence, contradictions: st.contradictions });
    if (f.action === 'BUY') {
      fuseBuy++;
      if (f.confidence < 0.7) { fuseBuyBelowFloor++; bump('BUY but conf < 0.70 floor'); }
      else bump('BUY -> signal');
      continue;
    }
    if (f.conflicts.length > 0) { bump('CONFLICTING_SIGNAL (technical vs bear regime)'); continue; }
    if (Math.abs(f.weighted) < 0.15) { bump('|weighted| < 0.15 -> NO_TRADE'); continue; }
    if (f.weighted > 0) {
      if (st.confidence < 0.55) bump(`bullish but hint ${st.confidence.toFixed(2)} < 0.55`);
      else if (st.confidence < 0.75 && f.weighted < 0.30) bump(`bullish w=${f.weighted.toFixed(2)} hint=${st.confidence.toFixed(2)} -> WATCH (needs 0.30 band or hint>=0.75)`);
      else bump('bullish other');
      continue;
    }
    bump('net bearish -> SELL/WATCH');
  }
}

console.log(`window ${FROM} .. ${TO}: ${coinDays} coin-days`);
console.log(`  strategy BUY      ${stratBuy}`);
console.log(`  fuse BUY          ${fuseBuy} (${fuseBuyBelowFloor} of them below the 0.70 confidence floor)`);
console.log('  non-BUY outcomes:');
for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${String(v).padStart(6)}  ${((v / coinDays) * 100).toFixed(1).padStart(5)}%  ${k}`);
}
db.close();
