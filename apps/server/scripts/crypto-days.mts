/**
 * Per-date replay of the PRODUCTION crypto decision path over the last N
 * dates in crypto.db: how many BUY/SELL decisions fuse emits per day, and
 * what the BTC regime was. Read-only.
 *
 *   CRYPTO_DB=<path>/crypto.db node scripts/crypto-days.mts [days]
 */
import { DatabaseSync } from 'node:sqlite';
import { detectRegime, fuse, shortTermScore } from '@promptslim/tucore';
import type { Candle, ScoreParts } from '@promptslim/tucore';

const dbPath = process.env.CRYPTO_DB ?? '/root/.hermes/cache/scratch/crypto.db';
const DAYS = Number(process.argv[2] ?? 14);
const MIN_CONF = 0.7;
const ATR3 = process.env.CRYPTO_TARGET_MODE === 'atr3';

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
const btcByDate = new Map(bench.map((c, i) => [c.date, i]));

const allDates = [...new Set(rows.map((r) => r.date))].sort();
const dates = allDates.slice(-DAYS);

console.log(`date        regime(BTC)      conf  strat:BUY/SELL/WATCH  fuse:BUY/SELL/other  passFloor  sane  orders`);
for (const date of dates) {
  const bp = btcByDate.get(date);
  if (bp === undefined || bp < 119) continue;
  const regimeDet = detectRegime(bench.slice(0, bp + 1));
  const regime = regimeDet.regime;
  let sBuy = 0, sSell = 0, sWatch = 0, fBuy = 0, fSell = 0, fOther = 0, floor = 0, sane = 0, orders = 0;

  for (const sym of universe) {
    const bars = barsByTicker.get(sym) ?? [];
    const i = bars.findIndex((b) => b.date === date);
    if (i < 119) continue;
    const candles = bars.slice(0, i + 1);
    const quote = { symbol: sym, price: candles[i].close, prevClose: candles[i - 1].close, ts: Date.parse(`${date}T00:00:00Z`) };
    const st = shortTermScore({
      ticker: sym, company: sym, candles, benchmarkCandles: bench.slice(0, bp + 1),
      quote, regime, events: [], sessionDate: date,
    });
    if (st.action === 'INSUFFICIENT_DATA') continue;
    if (st.action === 'BUY') sBuy++; else if (st.action === 'SELL') sSell++; else sWatch++;

    if (ATR3) {
      const atr14 = Number(st.factors.atr ?? 0);
      if (atr14 > 0 && quote.price + 3 * atr14 > st.target) st.target = quote.price + 3 * atr14;
    }
    const parts: ScoreParts = {
      technical: st.score, fundamental: 0, event: 0, sentiment: 0, macro: 0,
      regime: REGIME_SCORE[regime] ?? 0,
    };
    const f = fuse({ parts, horizon: 'SHORT', strategy: 'crypto_momentum_v1', confidenceHint: st.confidence, evidence: st.evidence, contradictions: st.contradictions });
    if (f.action === 'BUY') fBuy++;
    else if (f.action === 'SELL') fSell++;
    else fOther++;
    if (f.action !== 'BUY') continue;
    if (f.confidence < MIN_CONF) continue;
    floor++;
    const stopDist = Math.max(0.0001, quote.price - st.invalidation);
    const rr = (st.target - quote.price) / stopDist;
    const isSane = stopDist >= quote.price * 0.005 && rr >= 1.5 && rr <= 20 && st.target > quote.price;
    if (!isSane) continue;
    sane++;
    orders++;
  }
  console.log(
    `${date}  ${regime.padEnd(14)}  ${(regimeDet.confidence * 100).toFixed(0).padStart(3)}%  ` +
    `${String(sBuy).padStart(3)}/${String(sSell).padStart(3)}/${String(sWatch).padStart(3)}` +
    `${' '.repeat(10)}${String(fBuy).padStart(3)}/${String(fSell).padStart(3)}/${String(fOther).padStart(3)}` +
    `${' '.repeat(10)}${String(floor).padStart(6)}  ${String(sane).padStart(4)}  ${String(orders).padStart(6)}`,
  );
}
db.close();
