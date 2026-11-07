/**
 * Live-path diagnostic: why does production emit 0 BUY?
 * Reproduces engine.ts runCryptoScan decision math against the LIVE db
 * (read-only) and prints, per symbol, which gate stops a BUY.
 *
 *   CRYPTO_DB=<path>/crypto.db node scripts/crypto-live-diag.mts
 */
import { DatabaseSync } from 'node:sqlite';
import { detectRegime, fuse, shortTermScore } from '@promptslim/tucore';
import type { Candle, ScoreParts } from '@promptslim/tucore';

const dbPath = process.env.CRYPTO_DB ?? '/root/.hermes/cache/scratch/crypto.db';
const db = new DatabaseSync(dbPath, { readOnly: true });

const REGIME_SCORE: Record<string, number> = {
  BULL_TREND: 0.5, RISK_ON: 0.5, MOMENTUM: 0.5,
  LOW_VOLATILITY: 0.25, RECOVERY: 0.25, MEAN_REVERSION: 0,
  BEAR_TREND: -0.5, RISK_OFF: -0.5, LIQUIDITY_STRESS: -0.5, HIGH_VOLATILITY: -0.5,
  UNCERTAIN: 0,
};

interface BarRow { ticker: string; date: string; open: number; high: number; low: number; close: number; volume: number }

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
const quoteRows = db.prepare('SELECT symbol, price, prev_close, ts FROM market_quotes').all() as unknown as
  Array<{ symbol: string; price: number; prev_close: number; ts: number }>;
const quotes = new Map(quoteRows.map((q) => [q.symbol, q]));

const bench = barsByTicker.get('BTC') ?? [];
const regimeDet = detectRegime(bench);
const regime = regimeDet.regime;
console.log(`BTC regime: ${regime} @ ${(regimeDet.confidence * 100).toFixed(0)}%  bars=${bench.length} last=${bench.at(-1)?.date} close=${bench.at(-1)?.close}`);
console.log(`regime components: ${JSON.stringify(regimeDet.components)}`);
console.log(`quotes fresh: ${quoteRows.map((q) => q.symbol + '=' + ((Date.now() - q.ts) / 1000).toFixed(0) + 's').join(' ')}\n`);

const CONFIRMATIONS = new Set([
  'relative_strength', 'breakout', 'trend_alignment', 'vwap', 'sector_momentum', 'aligned_events',
]);

interface Diag {
  sym: string; stAction: string; score: number; conf: number; pos: number; neg: number;
  w: number; fused: string; fusedConf: number; fatal: string; kills: string[];
  cfWeights: string; // counterfactual action with crypto-only weights
}
const out: Diag[] = [];

for (const sym of universe) {
  const bars = barsByTicker.get(sym) ?? [];
  if (bars.length < 120) continue;
  const q = quotes.get(sym);
  const price = q?.price ?? bars.at(-1)!.close;
  const st = shortTermScore({
    ticker: sym, company: sym, candles: bars, benchmarkCandles: bench,
    quote: { symbol: sym, price, prevClose: q?.prev_close ?? bars.at(-2)!.close, ts: q?.ts ?? Date.now() },
    regime, events: [], sessionDate: bars.at(-1)!.date,
  });
  if (st.action === 'INSUFFICIENT_DATA') continue;

  const parts: ScoreParts = {
    technical: st.score, fundamental: 0, event: 0, sentiment: 0, macro: 0,
    regime: REGIME_SCORE[regime] ?? 0,
  };
  const f = fuse({ parts, horizon: 'SHORT', strategy: 'crypto_momentum_v1', confidenceHint: st.confidence, evidence: st.evidence, contradictions: st.contradictions });
  const cf = fuse({ parts, horizon: 'SHORT', strategy: 'crypto_momentum_v1', weights: { technical: 0.84, regime: 0.16 }, confidenceHint: st.confidence, evidence: st.evidence, contradictions: st.contradictions });

  let pos = 0, neg = 0;
  for (const e of st.evidence) if (CONFIRMATIONS.has(e.kind)) { if (e.positive) pos++; else neg++; }
  const fatal: string[] = [];
  if (st.factors.trendAlignment === -1) fatal.push('bearish_stack');
  if (st.factors.breakout === -1) fatal.push('20d_breakdown');
  if ((regime === 'BEAR_TREND' || regime === 'LIQUIDITY_STRESS') && (st.factors.regimeConfidence ?? 0) > 0.7) fatal.push('regime_veto');

  const kills: string[] = [];
  if (st.action !== 'BUY') kills.push(`strategy=${st.action}(need>=3 confirm & no fatal)`);
  if (st.action === 'BUY' && st.confidence < 0.7) kills.push(`conf ${st.confidence.toFixed(2)}<0.70 floor`);
  if (f.action !== 'BUY') kills.push(`fuse=${f.action} w=${f.weighted.toFixed(2)} hint=${st.confidence.toFixed(2)}`);

  out.push({
    sym, stAction: st.action, score: st.score, conf: st.confidence, pos, neg,
    w: f.weighted, fused: f.action, fusedConf: f.confidence,
    fatal: fatal.join('+') || '-', kills, cfWeights: cf.action,
  });
}

const pad = (s: string | number, n: number) => String(s).padEnd(n);
console.log(pad('sym', 6) + pad('stAct', 8) + pad('score', 7) + pad('conf', 6) + pad('p/n', 6) +
  pad('w', 6) + pad('fuse', 7) + pad('cfWts', 7) + 'fatal                 kills');
for (const d of out) {
  console.log(pad(d.sym, 6) + pad(d.stAction, 8) + pad(d.score.toFixed(2), 7) + pad(d.conf.toFixed(2), 6) +
    pad(`${d.pos}/${d.neg}`, 6) + pad(d.w.toFixed(2), 6) + pad(d.fused, 7) + pad(d.cfWeights, 7) +
    pad(d.fatal, 21) + d.kills.join(' | '));
}

const counts = (k: 'stAction' | 'fused' | 'cfWeights') =>
  out.reduce<Record<string, number>>((acc, d) => { acc[d[k]] = (acc[d[k]] ?? 0) + 1; return acc; }, {});
console.log('\nstrategy action mix :', JSON.stringify(counts('stAction')));
console.log('fused action (prod) :', JSON.stringify(counts('fused')));
console.log('fused w/ crypto wts :', JSON.stringify(counts('cfWeights')));
const fatalCounts = out.reduce<Record<string, number>>((acc, d) => { acc[d.fatal] = (acc[d.fatal] ?? 0) + 1; return acc; }, {});
console.log('fatal long blockers :', JSON.stringify(fatalCounts));

// How far is the best candidate from a BUY? weighted needed: 0.30 @ hint>=0.55, 0.15 @ hint>=0.75
console.log('\nper-symbol headroom (prod weights 0.38*technical + 0.16*regime):');
for (const d of [...out].sort((a, b) => b.w - a.w)) {
  const need030 = (0.30 - d.w).toFixed(2);
  const needHint = d.stAction === 'BUY' ? 'hint ok' : `hint ${d.conf.toFixed(2)} (<0.75 unless strategy BUY)`;
  console.log(`  ${pad(d.sym, 6)} weighted ${d.w.toFixed(2)} -> need +${need030} for the 0.30 band; ${needHint}`);
}
db.close();
