/**
 * Market-regime detection.
 *
 * Deterministic mapping to exactly ONE Regime with a fixed priority chain
 * (documented below). Confidence is derived from directional component
 * agreement; raw readings are exposed in `components`.
 */
import type { Candle, Regime } from './types.ts';
import { sma } from './indicators.ts';

export interface RegimeOptions {
  spyCandles?: Candle[];
  breadth?: { advancers: number; decliners: number };
}

export interface RegimeDetection {
  regime: Regime;
  confidence: number;
  components: Record<string, number>;
}

function lastOf(values: (number | null)[]): number | null {
  for (let i = values.length - 1; i >= 0; i--) {
    const v = values[i];
    if (v !== null && Number.isFinite(v)) return v;
  }
  return null;
}

function sign(v: number): number {
  return v > 0 ? 1 : v < 0 ? -1 : 0;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function sampleStdev(values: number[]): number {
  if (values.length < 2) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  const mu = sum / values.length;
  let acc = 0;
  for (const v of values) {
    const d = v - mu;
    acc += d * d;
  }
  return Math.sqrt(acc / (values.length - 1));
}

/** Rolling annualized close-to-close volatility history (one entry per completed window). */
function rollingVolHistory(closes: number[], period: number): number[] {
  const out: number[] = [];
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const base = closes[i - 1];
    rets.push(base !== 0 ? closes[i] / base - 1 : 0);
    if (rets.length >= period) out.push(sampleStdev(rets.slice(rets.length - period)) * Math.sqrt(252));
  }
  return out;
}

/**
 * Priority chain (first match wins):
 *  1. <100 bars                                -> UNCERTAIN
 *  2. volPct >= 0.9 && drawdown <= -0.15       -> LIQUIDITY_STRESS (severe:
 *     drawdown <= -0.25 or breadth <= -0.35) else HIGH_VOLATILITY
 *  3. volPct >= 0.9                            -> HIGH_VOLATILITY
 *  4. drawdown <= -0.2 or (below long MA && flat/down slope && non-positive
 *     60d return)                              -> BEAR_TREND
 *  5. breadth <= -0.30                         -> RISK_OFF
 *  6. drawdown <= -0.05 && close > long MA && close > sma50 && sma50 slope >
 *     0 && 60d return > 0 && still below high  -> RECOVERY
 *  7. above long MA && rising sma50 && 60d >= +10% && volPct < 0.75 -> MOMENTUM
 *  8. above long MA && rising sma50 && 60d > 0 -> BULL_TREND
 *  9. breadth >= 0.30 && 60d > 0               -> RISK_ON
 * 10. within +/-3% of long MA && |60d| <= 5%   -> LOW_VOLATILITY (volPct <=
 *     0.35) else MEAN_REVERSION
 * 11. volPct <= 0.3 && |60d| <= 5%             -> LOW_VOLATILITY
 * 12. above long MA -> RISK_ON; below -> RISK_OFF; else UNCERTAIN
 *
 * Note: `closeVsSma200` uses a 200-bar MA when enough bars exist, otherwise an
 * MA over all available bars (series with 100..199 bars still classify).
 * `volPercentile` is the share of historical volatility windows strictly
 * below the current one, so a flat tape reads ~0 (never "high volatility").
 */
export function detectRegime(candles: Candle[], opts?: RegimeOptions): RegimeDetection {
  const components: Record<string, number> = {};
  const n = candles.length;
  if (n < 100) return { regime: 'UNCERTAIN', confidence: 0.2, components };

  const closes = candles.map((c) => c.close);
  const last = closes[n - 1];
  const longMa = lastOf(sma(closes, Math.min(200, n)));
  const sma50Arr = sma(closes, 50);
  const sma50Now = lastOf(sma50Arr);

  let slope = 0;
  if (sma50Now !== null) {
    const prevIdx = Math.max(49, n - 11);
    const sma50Prev = sma50Arr[prevIdx];
    if (sma50Prev !== null && sma50Prev !== 0) slope = (sma50Now - sma50Prev) / sma50Prev;
  }

  const vols = rollingVolHistory(closes, 20);
  let volPct = 0.5;
  if (vols.length >= 2) {
    const cur = vols[vols.length - 1];
    const hist = vols.slice(0, -1);
    let below = 0;
    // 1e-9 absolute tolerance: numerically-constant tapes (every window within
    // 1e-9 annualized of the current reading) count as equal, so pure noise can
    // never read as "extreme volatility".
    for (const v of hist) if (v < cur - 1e-9) below++;
    volPct = below / hist.length;
  }

  const trailing60 = n > 60 ? last / closes[n - 61] - 1 : last / closes[0] - 1;
  let peak = -Infinity;
  for (const c of closes) if (c > peak) peak = c;
  const drawdown = peak !== 0 ? last / peak - 1 : 0;
  const closeVsLong = longMa ? (last - longMa) / longMa : 0;
  const closeVsSma50 = sma50Now ? (last - sma50Now) / sma50Now : 0;

  components.closeVsSma200 = closeVsLong;
  components.closeVsSma50 = closeVsSma50;
  components.sma50Slope = slope;
  components.volPercentile = volPct;
  components.trailing60dReturn = trailing60;
  components.drawdownFromHigh = drawdown;

  let breadthVal: number | null = null;
  if (opts?.breadth) {
    const total = opts.breadth.advancers + opts.breadth.decliners;
    breadthVal = total > 0 ? (opts.breadth.advancers - opts.breadth.decliners) / total : 0;
    components.breadth = breadthVal;
  }

  let benchVsLong: number | null = null;
  const spy = opts?.spyCandles;
  if (spy && spy.length >= 100) {
    const bc = spy.map((c) => c.close);
    const bLast = bc[bc.length - 1];
    const bMa = lastOf(sma(bc, Math.min(200, bc.length)));
    benchVsLong = bMa ? (bLast - bMa) / bMa : 0;
    components.benchCloseVsSma200 = benchVsLong;
    components.benchTrailing60d = bc.length > 60 ? bLast / bc[bc.length - 61] - 1 : 0;
  }

  const extremeVol = volPct >= 0.9;
  let regime: Regime;
  if (extremeVol && drawdown <= -0.15) {
    const severe = drawdown <= -0.25 || (breadthVal !== null && breadthVal <= -0.35);
    regime = severe ? 'LIQUIDITY_STRESS' : 'HIGH_VOLATILITY';
  } else if (extremeVol) {
    regime = 'HIGH_VOLATILITY';
  } else if (drawdown <= -0.2 || (closeVsLong < 0 && slope <= 0 && trailing60 <= 0)) {
    regime = 'BEAR_TREND';
  } else if (breadthVal !== null && breadthVal <= -0.3) {
    regime = 'RISK_OFF';
  } else if (
    drawdown <= -0.05 &&
    closeVsLong > 0 &&
    closeVsSma50 > 0 &&
    slope > 0 &&
    trailing60 > 0 &&
    last < peak
  ) {
    regime = 'RECOVERY';
  } else if (closeVsLong > 0 && slope > 0 && trailing60 >= 0.1 && volPct < 0.75) {
    regime = 'MOMENTUM';
  } else if (closeVsLong > 0 && slope > 0 && trailing60 > 0) {
    regime = 'BULL_TREND';
  } else if (breadthVal !== null && breadthVal >= 0.3 && trailing60 > 0) {
    regime = 'RISK_ON';
  } else if (Math.abs(closeVsLong) < 0.03 && Math.abs(trailing60) <= 0.05) {
    regime = volPct <= 0.35 ? 'LOW_VOLATILITY' : 'MEAN_REVERSION';
  } else if (volPct <= 0.3 && Math.abs(trailing60) <= 0.05) {
    regime = 'LOW_VOLATILITY';
  } else if (closeVsLong > 0) {
    regime = 'RISK_ON';
  } else if (closeVsLong < 0) {
    regime = 'RISK_OFF';
  } else {
    regime = 'UNCERTAIN';
  }

  // Confidence from directional agreement of the components.
  const votes: Array<{ w: number; s: number }> = [
    { w: 0.3, s: sign(closeVsLong) },
    { w: 0.2, s: sign(slope) },
    { w: 0.2, s: sign(trailing60) },
  ];
  if (breadthVal !== null) votes.push({ w: 0.15, s: sign(breadthVal) });
  if (benchVsLong !== null) votes.push({ w: 0.15, s: sign(benchVsLong) });
  let wSum = 0;
  let wsSum = 0;
  for (const v of votes) {
    wSum += v.w;
    wsSum += v.w * v.s;
  }
  const agreement = wSum > 0 ? Math.abs(wsSum) / wSum : 0;
  let confidence = clamp01(0.35 + 0.6 * agreement);
  if (regime === 'UNCERTAIN') confidence = Math.min(confidence, 0.3);

  return { regime, confidence, components };
}