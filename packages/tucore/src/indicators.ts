/**
 * Pure technical indicators. Deterministic, side-effect free, no I/O.
 *
 * Conventions:
 * - Leading values that cannot be computed (warm-up period) are `null`.
 * - Rolling standard deviations use the sample (n-1) denominator unless
 *   stated otherwise (bollinger uses population, as customary).
 */
import type { Candle } from './types.ts';

function mean(values: number[]): number {
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

function sampleStdev(values: number[]): number {
  if (values.length < 2) return 0;
  const mu = mean(values);
  let sum = 0;
  for (const v of values) {
    const d = v - mu;
    sum += d * d;
  }
  return Math.sqrt(sum / (values.length - 1));
}

export function sma(values: number[], period: number): (number | null)[] {
  const out = new Array<number | null>(values.length).fill(null);
  if (period <= 0) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** EMA seeded with the SMA of the first `period` values. */
export function ema(values: number[], period: number): (number | null)[] {
  const out = new Array<number | null>(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let prev = sum / period;
  out[period - 1] = prev;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function rsiValue(avgGain: number, avgLoss: number): number {
  if (avgGain === 0 && avgLoss === 0) return 50; // flat series -> neutral (documented)
  if (avgLoss === 0) return 100;
  if (avgGain === 0) return 0;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** Wilder-smoothed RSI. First value at index `period`. Flat series -> 50. */
export function rsi(closes: number[], period = 14): (number | null)[] {
  const out = new Array<number | null>(closes.length).fill(null);
  if (period <= 0 || closes.length <= period) return out;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch > 0) avgGain += ch;
    else avgLoss -= ch;
  }
  avgGain /= period;
  avgLoss /= period;
  out[period] = rsiValue(avgGain, avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const gain = ch > 0 ? ch : 0;
    const loss = ch < 0 ? -ch : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = rsiValue(avgGain, avgLoss);
  }
  return out;
}

export interface MacdResult {
  macd: (number | null)[];
  signal: (number | null)[];
  hist: (number | null)[];
}

export function macd(closes: number[], fast = 12, slow = 26, signalPeriod = 9): MacdResult {
  const macdLine = new Array<number | null>(closes.length).fill(null);
  const signalLine = new Array<number | null>(closes.length).fill(null);
  const hist = new Array<number | null>(closes.length).fill(null);
  const fastArr = ema(closes, fast);
  const slowArr = ema(closes, slow);
  for (let i = 0; i < closes.length; i++) {
    const f = fastArr[i];
    const s = slowArr[i];
    if (f !== null && s !== null) macdLine[i] = f - s;
  }
  // Signal is an EMA over the contiguous non-null suffix of the MACD line.
  let firstIdx = -1;
  for (let i = 0; i < macdLine.length; i++) {
    if (macdLine[i] !== null) {
      firstIdx = i;
      break;
    }
  }
  if (firstIdx >= 0) {
    const compact: number[] = [];
    for (let i = firstIdx; i < closes.length; i++) compact.push(macdLine[i]!);
    const sigCompact = ema(compact, signalPeriod);
    for (let j = 0; j < sigCompact.length; j++) {
      const v = sigCompact[j];
      if (v !== null) signalLine[firstIdx + j] = v;
    }
  }
  for (let i = 0; i < closes.length; i++) {
    const m = macdLine[i];
    const s = signalLine[i];
    if (m !== null && s !== null) hist[i] = m - s;
  }
  return { macd: macdLine, signal: signalLine, hist };
}

/** Wilder ATR. First value at index `period - 1` (true range of bar 0 is high-low). */
export function atr(candles: Candle[], period = 14): (number | null)[] {
  const out = new Array<number | null>(candles.length).fill(null);
  if (period <= 0 || candles.length < period) return out;
  const trs: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const prevClose = i > 0 ? candles[i - 1].close : c.close;
    const tr = Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
    trs.push(tr);
    if (i === period - 1) {
      let sum = 0;
      for (let j = 0; j <= i; j++) sum += trs[j];
      out[i] = sum / period;
    } else if (i >= period) {
      out[i] = (out[i - 1]! * (period - 1) + trs[i]) / period;
    }
  }
  return out;
}

export interface BollingerResult {
  upper: (number | null)[];
  middle: (number | null)[];
  lower: (number | null)[];
}

export function bollinger(closes: number[], period = 20, mult = 2): BollingerResult {
  const middle = sma(closes, period);
  const upper = new Array<number | null>(closes.length).fill(null);
  const lower = new Array<number | null>(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    const window: number[] = [];
    for (let j = i - period + 1; j <= i; j++) window.push(closes[j]);
    const mu = middle[i]!;
    let sumSq = 0;
    for (const v of window) {
      const d = v - mu;
      sumSq += d * d;
    }
    const sd = Math.sqrt(sumSq / period); // population sd, as customary
    upper[i] = mu + mult * sd;
    lower[i] = mu - mult * sd;
  }
  return { upper, middle, lower };
}

/** Cumulative volume-weighted average price using typical price (H+L+C)/3. */
export function vwapSeries(candles: Candle[]): number[] {
  const out = new Array<number>(candles.length).fill(0);
  let cumPV = 0;
  let cumV = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const tp = (c.high + c.low + c.close) / 3;
    cumPV += tp * c.volume;
    cumV += c.volume;
    out[i] = cumV > 0 ? cumPV / cumV : c.close;
  }
  return out;
}

/** On-balance volume; starts at 0. */
export function obv(candles: Candle[]): number[] {
  const out = new Array<number>(candles.length).fill(0);
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1].close;
    const cur = candles[i].close;
    const delta = cur > prev ? candles[i].volume : cur < prev ? -candles[i].volume : 0;
    out[i] = out[i - 1] + delta;
  }
  return out;
}

/** Rate of change as a fraction: (close[i] - close[i-p]) / close[i-p]. */
export function roc(closes: number[], period = 10): (number | null)[] {
  const out = new Array<number | null>(closes.length).fill(null);
  if (period <= 0) return out;
  for (let i = period; i < closes.length; i++) {
    const base = closes[i - period];
    out[i] = base !== 0 ? closes[i] / base - 1 : null;
  }
  return out;
}

export interface StochasticResult {
  k: (number | null)[];
  d: (number | null)[];
}

/** Slow stochastic; when the window has zero range, %K is 50 (neutral, documented). */
export function stochastic(candles: Candle[], kPeriod = 14, dPeriod = 3): StochasticResult {
  const k = new Array<number | null>(candles.length).fill(null);
  const d = new Array<number | null>(candles.length).fill(null);
  for (let i = kPeriod - 1; i < candles.length; i++) {
    let highest = -Infinity;
    let lowest = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      highest = Math.max(highest, candles[j].high);
      lowest = Math.min(lowest, candles[j].low);
    }
    const range = highest - lowest;
    k[i] = range > 0 ? (100 * (candles[i].close - lowest)) / range : 50;
  }
  for (let i = kPeriod - 1 + dPeriod - 1; i < candles.length; i++) {
    let sum = 0;
    let ok = true;
    for (let j = i - dPeriod + 1; j <= i; j++) {
      const v = k[j];
      if (v === null) {
        ok = false;
        break;
      }
      sum += v;
    }
    if (ok) d[i] = sum / dPeriod;
  }
  return { k, d };
}

/**
 * Trailing relative strength vs a benchmark: (stockRet - benchRet) over the
 * same `period` sessions, as a fraction. Index-aligned with `closes`.
 */
export function relativeStrength(closes: number[], benchCloses: number[], period = 90): (number | null)[] {
  const out = new Array<number | null>(closes.length).fill(null);
  if (period <= 0) return out;
  for (let i = period; i < closes.length; i++) {
    if (i >= benchCloses.length) break;
    const base = closes[i - period];
    const benchBase = benchCloses[i - period];
    if (!base || !benchBase) continue;
    out[i] = closes[i] / base - benchCloses[i] / benchBase;
  }
  return out;
}

/** Drawdown vs the running peak; always <= 0. */
export function drawdownSeries(closes: number[]): number[] {
  const out = new Array<number>(closes.length).fill(0);
  let peak = closes.length > 0 ? closes[0] : 0;
  for (let i = 0; i < closes.length; i++) {
    if (closes[i] > peak) peak = closes[i];
    out[i] = peak !== 0 ? closes[i] / peak - 1 : 0;
  }
  return out;
}

/** Position within the 52-week (max 252 bar) high-low range, 0..1. Needs >= 60 bars. */
export function position52w(candles: Candle[]): number | null {
  const n = candles.length;
  if (n < 60) return null;
  const window = candles.slice(-Math.min(252, n));
  let low = Infinity;
  let high = -Infinity;
  for (const c of window) {
    low = Math.min(low, c.low);
    high = Math.max(high, c.high);
  }
  if (high === low) return 0.5;
  const close = candles[n - 1].close;
  const pos = (close - low) / (high - low);
  return pos < 0 ? 0 : pos > 1 ? 1 : pos;
}

/** Last volume / mean volume of the preceding `volPeriod` bars (excludes today). */
export function relativeVolume(candles: Candle[], volPeriod = 20): number | null {
  const n = candles.length;
  if (volPeriod <= 0 || n < volPeriod + 1) return null;
  let sum = 0;
  for (let i = n - 1 - volPeriod; i <= n - 2; i++) sum += candles[i].volume;
  const avg = sum / volPeriod;
  if (avg <= 0) return null;
  return candles[n - 1].volume / avg;
}

/**
 * Close crossing above/below the extreme of the preceding `lookback` bars
 * (today excluded). Requires prev close on the original side of the level, so
 * a gap that was already through the level is not a fresh cross.
 */
export function detectBreakout(
  candles: Candle[],
  lookback = 20,
): { breakout: boolean; direction: 'UP' | 'DOWN' | null; level: number | null } {
  const n = candles.length;
  if (lookback <= 0 || n < lookback + 1) return { breakout: false, direction: null, level: null };
  const last = candles[n - 1];
  const prev = candles[n - 2];
  let hi = -Infinity;
  let lo = Infinity;
  for (let i = n - 1 - lookback; i <= n - 2; i++) {
    hi = Math.max(hi, candles[i].high);
    lo = Math.min(lo, candles[i].low);
  }
  if (last.close > hi && prev.close <= hi) return { breakout: true, direction: 'UP', level: hi };
  if (last.close < lo && prev.close >= lo) return { breakout: true, direction: 'DOWN', level: lo };
  return { breakout: false, direction: null, level: null };
}

/** Golden/death cross state of fast vs slow SMA; FLAT when either is unavailable. */
export function maCross(closes: number[], fast = 50, slow = 200): 'BULL' | 'BEAR' | 'FLAT' {
  const f = sma(closes, fast);
  const s = sma(closes, slow);
  const fv = f[f.length - 1];
  const sv = s[s.length - 1];
  if (fv === null || sv === null) return 'FLAT';
  if (fv > sv) return 'BULL';
  if (fv < sv) return 'BEAR';
  return 'FLAT';
}

/** Overnight gap as a fraction: (open - prevClose) / prevClose. */
export function gapPct(candle: Candle, prevClose: number | null): number | null {
  if (prevClose === null || !Number.isFinite(prevClose) || prevClose === 0) return null;
  return (candle.open - prevClose) / prevClose;
}

/** Mean volume over the last `period` bars (including the last bar). */
export function avgVolume(candles: Candle[], period = 20): number | null {
  const n = candles.length;
  if (period <= 0 || n < period) return null;
  let sum = 0;
  for (let i = n - period; i < n; i++) sum += candles[i].volume;
  return sum / period;
}

/**
 * Annualized close-to-close realized volatility (sample stdev of up to the
 * last `period` simple returns * sqrt(annualize)). Constant series -> 0.
 */
export function realizedVol(closes: number[], period = 20, annualize = 252): number | null {
  if (closes.length < 2) return null;
  const rets: number[] = [];
  const start = Math.max(1, closes.length - period);
  for (let i = start; i < closes.length; i++) {
    const base = closes[i - 1];
    rets.push(base !== 0 ? closes[i] / base - 1 : 0);
  }
  if (rets.length === 0) return null;
  if (rets.length === 1) return 0;
  return sampleStdev(rets) * Math.sqrt(annualize);
}

function clusterLevels(levels: number[], tolerance: number): number[] {
  const sorted = [...levels].sort((a, b) => a - b);
  const out: number[] = [];
  let group: number[] = [];
  let groupSum = 0;
  const flush = (): void => {
    if (group.length > 0) out.push(groupSum / group.length);
    group = [];
    groupSum = 0;
  };
  for (const lv of sorted) {
    if (group.length === 0) {
      group = [lv];
      groupSum = lv;
      continue;
    }
    const mu = groupSum / group.length;
    if (Math.abs(lv - mu) <= tolerance * Math.abs(mu)) {
      group.push(lv);
      groupSum += lv;
    } else {
      flush();
      group = [lv];
      groupSum = lv;
    }
  }
  flush();
  return out;
}

/**
 * Support/resistance from fractal pivots (window +/-2 bars) over the trailing
 * `lookback` bars, clustered within `tolerance` (fraction of level).
 * The window's global low/high are always included. Ascending order.
 */
export function supportResistance(
  candles: Candle[],
  lookback = 120,
  tolerance = 0.02,
): { supports: number[]; resistances: number[] } {
  const w = candles.slice(-Math.max(1, lookback));
  if (w.length === 0) return { supports: [], resistances: [] };
  let minLow = Infinity;
  let maxHigh = -Infinity;
  for (const c of w) {
    minLow = Math.min(minLow, c.low);
    maxHigh = Math.max(maxHigh, c.high);
  }
  if (w.length < 5) return { supports: [minLow], resistances: [maxHigh] };
  const highPivots: number[] = [maxHigh];
  const lowPivots: number[] = [minLow];
  const half = 2;
  for (let i = 0; i < w.length; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = Math.max(0, i - half); j <= Math.min(w.length - 1, i + half); j++) {
      if (j === i) continue;
      if (w[j].high > w[i].high) isHigh = false;
      if (w[j].low < w[i].low) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) highPivots.push(w[i].high);
    if (isLow) lowPivots.push(w[i].low);
  }
  return {
    supports: clusterLevels(lowPivots, tolerance),
    resistances: clusterLevels(highPivots, tolerance),
  };
}