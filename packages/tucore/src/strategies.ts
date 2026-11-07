/**
 * Strategy scorers for the 1-10 session (short term) and 3-18 month (long
 * term) horizons. Pure functions: all inputs are explicit, nothing is read
 * from the environment.
 *
 * StrategyResult.score is a signed strength in [-1, 1] (0 = neutral), so it
 * can feed ScoreParts directly. confidence is in [0.3, 0.9].
 */
import type {
  Candle,
  EvidenceItem,
  FundamentalSnapshot,
  Quote,
  Regime,
  SignalAction,
} from './types.ts';
import {
  atr,
  avgVolume,
  detectBreakout,
  drawdownSeries,
  gapPct,
  maCross,
  position52w,
  realizedVol,
  relativeStrength,
  relativeVolume,
  rsi,
  sma,
  supportResistance,
  vwapSeries,
} from './indicators.ts';
import { detectRegime } from './regime.ts';

export interface StrategyEvent {
  type: string;
  sentiment: number;
  materiality: number;
  ageDays: number;
}

export interface ShortTermInput {
  ticker: string;
  company: string;
  candles: Candle[];
  benchmarkCandles: Candle[];
  quote: Quote;
  regime: Regime;
  sectorCandles?: Candle[];
  events?: StrategyEvent[];
  sessionDate: string;
}

export interface LongTermInput {
  ticker: string;
  company: string;
  candles: Candle[];
  fundamentals: FundamentalSnapshot | null;
  quote: Quote;
  regime: Regime;
  events?: StrategyEvent[];
}

export interface StrategyResult {
  score: number;
  confidence: number;
  action: SignalAction;
  entryLow: number;
  entryHigh: number;
  target: number;
  invalidation: number;
  expectedHoldSessions: number;
  maxHoldSessions: number;
  evidence: EvidenceItem[];
  contradictions: EvidenceItem[];
  factors: Record<string, number>;
}

function lastNum(values: (number | null)[]): number | null {
  for (let i = values.length - 1; i >= 0; i--) {
    const v = values[i];
    if (v !== null && Number.isFinite(v)) return v;
  }
  return null;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

function eventEvidence(ev: StrategyEvent, horizonDays: number): { item: EvidenceItem; score: number } | null {
  if (ev.ageDays > horizonDays || ev.materiality < 0.5) return null;
  return {
    item: {
      kind: `event:${ev.type}`,
      detail: `${ev.type}: materiality ${ev.materiality.toFixed(2)}, ${ev.ageDays}d old, sentiment ${ev.sentiment.toFixed(2)}`,
      weight: Math.min(1, Math.max(0, ev.materiality)),
      positive: ev.sentiment > 0,
    },
    score: ev.sentiment * ev.materiality,
  };
}

/**
 * 1-10 session horizon.
 *
 * BUY requires >= 3 distinct positive confirmations (relative strength,
 * volume-confirmed breakout, trend alignment, VWAP, sector momentum, aligned
 * fresh events) AND no fatal contradiction (bearish trend chasing longs, DOWN
 * breakout, BEAR_TREND/LIQUIDITY_STRESS regime with detection confidence >
 * 0.7). Mean-reversion readings (e.g. RSI < 30) are recorded as evidence but
 * never count as confirmations, so oversold-alone can never yield BUY — it is
 * capped at WATCH. SELL mirrors breakdowns/distribution.
 *
 * With < 120 bars of price or benchmark data the result is INSUFFICIENT_DATA
 * with empty evidence/contradictions.
 */
export function shortTermScore(input: ShortTermInput): StrategyResult {
  const price = input.quote.price;
  const bars = input.candles;
  const bench = input.benchmarkCandles;
  const maxHold = 20;

  if (bars.length < 120 || bench.length < 120 || !Number.isFinite(price) || price <= 0) {
    return {
      score: 0,
      confidence: 0,
      action: 'INSUFFICIENT_DATA',
      entryLow: price,
      entryHigh: price,
      target: price,
      invalidation: price,
      expectedHoldSessions: 0,
      maxHoldSessions: maxHold,
      evidence: [],
      contradictions: [],
      factors: {},
    };
  }

  const closes = bars.map((c) => c.close);
  const benchCloses = bench.map((c) => c.close);
  const n = closes.length;
  const lastClose = closes[n - 1];
  const factors: Record<string, number> = {};
  const evidence: EvidenceItem[] = [];
  const positives: string[] = [];
  const negatives: string[] = [];

  // 1. 90d relative strength vs benchmark
  const rs = lastNum(relativeStrength(closes, benchCloses, 90));
  factors.relativeStrength = rs ?? 0;
  if (rs !== null) {
    if (rs >= 0.05) {
      evidence.push({ kind: 'relative_strength', detail: `90d relative strength ${pct(rs)} vs benchmark`, weight: 0.7, positive: true });
      positives.push('relative_strength');
    } else if (rs <= -0.05) {
      evidence.push({ kind: 'relative_strength', detail: `90d relative strength ${pct(rs)} vs benchmark`, weight: 0.7, positive: false });
      negatives.push('relative_strength');
    } else {
      evidence.push({ kind: 'relative_strength', detail: `90d relative strength ${pct(rs)} — in line with benchmark`, weight: 0.3, positive: rs >= 0 });
    }
  }

  // 2. 20d breakout confirmed by relative volume
  const bo = detectBreakout(bars, 20);
  const rv = relativeVolume(bars, 20) ?? 1;
  factors.breakout = bo.direction === 'UP' ? 1 : bo.direction === 'DOWN' ? -1 : 0;
  factors.relativeVolume = rv;
  if (bo.breakout && bo.direction === 'UP') {
    if (rv >= 1.15) {
      evidence.push({ kind: 'breakout', detail: `breakout above 20d high ${bo.level!.toFixed(2)} on ${rv.toFixed(2)}x volume`, weight: 0.75, positive: true });
      positives.push('breakout');
    } else {
      evidence.push({ kind: 'breakout', detail: `breakout above 20d high without volume confirmation (${rv.toFixed(2)}x)`, weight: 0.4, positive: true });
    }
  } else if (bo.breakout && bo.direction === 'DOWN') {
    if (rv >= 1.15) {
      evidence.push({ kind: 'breakout', detail: `breakdown below 20d low ${bo.level!.toFixed(2)} on ${rv.toFixed(2)}x volume`, weight: 0.75, positive: false });
      negatives.push('breakout');
    } else {
      evidence.push({ kind: 'breakout', detail: `breakdown below 20d low without volume confirmation (${rv.toFixed(2)}x)`, weight: 0.4, positive: false });
    }
  }

  // 3. trend structure (sma20 > sma50 > long MA) and 50/200 cross
  const sma20 = lastNum(sma(closes, 20));
  const sma50 = lastNum(sma(closes, 50));
  const longPeriod = Math.min(200, n);
  const smaLong = lastNum(sma(closes, longPeriod));
  let alignment = 0;
  if (sma20 !== null && sma50 !== null && smaLong !== null) {
    if (sma20 > sma50 && sma50 > smaLong) alignment = 1;
    else if (sma20 < sma50 && sma50 < smaLong) alignment = -1;
  }
  const cross = maCross(closes, 50, 200);
  factors.trendAlignment = alignment;
  factors.maCross = cross === 'BULL' ? 1 : cross === 'BEAR' ? -1 : 0;
  if (sma20 !== null) factors.sma20 = sma20;
  if (sma50 !== null) factors.sma50 = sma50;
  if (smaLong !== null) factors.smaLong = smaLong;
  if (alignment !== 0) {
    evidence.push({
      kind: 'trend_alignment',
      detail:
        alignment > 0
          ? `bullish stack (20>50>${longPeriod}), 50/200 cross ${cross}`
          : `bearish stack (20<50<${longPeriod}), 50/200 cross ${cross}`,
      weight: 0.6,
      positive: alignment > 0,
    });
    if (alignment > 0) positives.push('trend_alignment');
    else negatives.push('trend_alignment');
  }

  // 4. close vs cumulative VWAP
  const vwap = vwapSeries(bars);
  const vwapNow = vwap[n - 1];
  if (vwapNow > 0) {
    const delta = (lastClose - vwapNow) / vwapNow;
    factors.closeVsVwap = delta;
    if (lastClose > vwapNow) {
      evidence.push({ kind: 'vwap', detail: `close ${pct(delta)} above cumulative VWAP`, weight: 0.5, positive: true });
      positives.push('vwap');
    } else if (lastClose < vwapNow) {
      evidence.push({ kind: 'vwap', detail: `close ${pct(delta)} below cumulative VWAP`, weight: 0.5, positive: false });
      negatives.push('vwap');
    }
  } else {
    factors.closeVsVwap = 0;
  }

  // 5. sector momentum vs benchmark (optional)
  factors.sectorMomentum = 0;
  const sector = input.sectorCandles;
  if (sector && sector.length >= 21 && bench.length >= 21) {
    const sRet = sector[sector.length - 1].close / sector[sector.length - 21].close - 1;
    const bRet = bench[bench.length - 1].close / bench[bench.length - 21].close - 1;
    const diff = sRet - bRet;
    factors.sectorMomentum = diff;
    if (diff >= 0.02) {
      evidence.push({ kind: 'sector_momentum', detail: `sector 20d momentum ${pct(diff)} ahead of benchmark`, weight: 0.5, positive: true });
      positives.push('sector_momentum');
    } else if (diff <= -0.02) {
      evidence.push({ kind: 'sector_momentum', detail: `sector 20d momentum ${pct(diff)} behind benchmark`, weight: 0.5, positive: false });
      negatives.push('sector_momentum');
    } else {
      evidence.push({ kind: 'sector_momentum', detail: `sector 20d momentum ${pct(diff)} — neutral`, weight: 0.3, positive: diff >= 0 });
    }
  }

  // 6. fresh material events (age <= 3 sessions, materiality >= 0.5)
  let eventScore = 0;
  for (const ev of input.events ?? []) {
    const hit = eventEvidence(ev, 3);
    if (hit) {
      eventScore += hit.score;
      evidence.push(hit.item);
    }
  }
  factors.eventScore = eventScore;
  if (eventScore >= 0.25) positives.push('aligned_events');
  else if (eventScore <= -0.25) negatives.push('aligned_events');

  // 7. volatility regime (informational — never a confirmation on its own)
  const vol = realizedVol(closes, 20) ?? 0;
  factors.realizedVolatility = vol;
  if (vol <= 0.6) {
    evidence.push({ kind: 'volatility_regime', detail: `20d annualized realized vol ${pct(vol)} — orderly`, weight: 0.25, positive: true });
  } else if (vol >= 1.0) {
    evidence.push({ kind: 'volatility_regime', detail: `20d annualized realized vol ${pct(vol)} — elevated`, weight: 0.4, positive: false });
  }

  // 8. liquidity (informational)
  const avgVol = avgVolume(bars) ?? 0;
  const liquidity = avgVol * lastClose;
  factors.liquidity = liquidity;
  if (liquidity >= 5e6) {
    evidence.push({ kind: 'liquidity', detail: `~$${(liquidity / 1e6).toFixed(1)}M avg daily dollar volume`, weight: 0.2, positive: true });
  } else if (liquidity < 1e6) {
    evidence.push({ kind: 'liquidity', detail: `~$${(liquidity / 1e6).toFixed(2)}M avg daily dollar volume — thin`, weight: 0.3, positive: false });
  }

  // 9. mean-reversion readings — explicitly NOT confirmations
  const rsi14 = lastNum(rsi(closes, 14)) ?? 50;
  factors.rsi = rsi14;
  if (rsi14 < 30) {
    evidence.push({ kind: 'mean_reversion', detail: `RSI(14) ${rsi14.toFixed(1)} oversold — mean-reversion only, capped at WATCH`, weight: 0.35, positive: true });
  } else if (rsi14 > 70) {
    evidence.push({ kind: 'mean_reversion', detail: `RSI(14) ${rsi14.toFixed(1)} overbought — mean-reversion only`, weight: 0.35, positive: false });
  }

  // 10. remaining raw readings
  const prevClose = n > 1 ? closes[n - 2] : null;
  const gap = gapPct(bars[n - 1], prevClose);
  factors.gapPct = gap ?? 0;
  factors.position52w = position52w(bars) ?? 0.5;
  const atr14 = lastNum(atr(bars, 14)) ?? lastClose * 0.02;
  factors.atr = atr14;
  factors.close = lastClose;
  const dd = drawdownSeries(closes);
  factors.drawdownFromHigh = dd[n - 1];
  const detection = detectRegime(bars, { spyCandles: bench });
  factors.regimeConfidence = detection.confidence;

  // Fatal contradiction gates
  const fatalLong: EvidenceItem[] = [];
  const fatalShort: EvidenceItem[] = [];
  if (alignment === -1) {
    fatalLong.push({ kind: 'trend_chase', detail: 'bearish trend structure — chasing longs is a fatal contradiction', weight: 1, positive: false });
  }
  if (bo.breakout && bo.direction === 'DOWN') {
    fatalLong.push({ kind: 'breakout_down', detail: 'breakdown below the 20d low — fatal for long entries', weight: 1, positive: false });
  }
  if ((input.regime === 'BEAR_TREND' || input.regime === 'LIQUIDITY_STRESS') && detection.confidence > 0.7) {
    fatalLong.push({ kind: 'regime', detail: `${input.regime} regime at ${(detection.confidence * 100).toFixed(0)}% confidence — fatal for long entries`, weight: 1, positive: false });
  }
  if (alignment === 1) {
    fatalShort.push({ kind: 'trend_chase_short', detail: 'bullish trend structure — chasing shorts is a fatal contradiction', weight: 1, positive: false });
  }
  if (bo.breakout && bo.direction === 'UP') {
    fatalShort.push({ kind: 'breakout_up', detail: 'breakout above the 20d high — fatal for short entries', weight: 1, positive: false });
  }
  if (
    (input.regime === 'BULL_TREND' || input.regime === 'MOMENTUM' || input.regime === 'RISK_ON') &&
    detection.confidence > 0.7
  ) {
    fatalShort.push({ kind: 'regime', detail: `${input.regime} regime at ${(detection.confidence * 100).toFixed(0)}% confidence — fatal for short entries`, weight: 1, positive: false });
  }

  const buyOk = positives.length >= 3 && fatalLong.length === 0;
  const sellOk = negatives.length >= 3 && fatalShort.length === 0;
  let action: SignalAction = 'WATCH';
  if (buyOk) action = 'BUY';
  else if (sellOk) action = 'SELL';

  const contradictions =
    action === 'BUY' ? [] : action === 'SELL' ? fatalShort : [...fatalLong, ...fatalShort];

  const total = positives.length + negatives.length;
  const ratio =
    total > 0
      ? action === 'BUY'
        ? positives.length / total
        : action === 'SELL'
          ? negatives.length / total
          : Math.max(positives.length, negatives.length) / total
      : 0;
  const confidence = clamp(action === 'WATCH' ? 0.3 + 0.3 * ratio : 0.3 + 0.6 * ratio, 0.3, 0.9);
  const score = clamp((positives.length - negatives.length) / Math.max(1, total), -1, 1);

  // Levels
  const sr = supportResistance(bars, 120, 0.02);
  const above = sr.resistances.filter((r) => r > price);
  const target = above.length > 0 ? Math.min(...above) : price + 2 * atr14;
  const below = sr.supports.filter((s) => s < price);
  const support = below.length > 0 ? Math.max(...below) : null;
  const invalidation = Math.max(support ?? price - 1.5 * atr14, price - 1.5 * atr14);
  const entryLow = price - 0.25 * atr14;
  const entryHigh = price + 0.25 * atr14;
  const expectedHoldSessions = clamp(Math.round(2 + 8 * (1 - confidence)), 1, 10);

  return {
    score,
    confidence,
    action,
    entryLow,
    entryHigh,
    target,
    invalidation,
    expectedHoldSessions,
    maxHoldSessions: maxHold,
    evidence,
    contradictions,
    factors,
  };
}

function qualityScore(s: FundamentalSnapshot, push: (target: number[], name: string, value: number | null, scorer: (x: number) => number) => void): number {
  const parts: number[] = [];
  push(parts, 'roe', s.roe, (x) => x / 0.25);
  push(parts, 'roic', s.roic, (x) => x / 0.2);
  push(parts, 'grossMargin', s.grossMargin, (x) => x / 0.6);
  push(parts, 'operatingMargin', s.operatingMargin, (x) => x / 0.25);
  push(parts, 'netMargin', s.netMargin, (x) => x / 0.2);
  push(parts, 'fcf', s.fcf, (x) => (x > 0 ? 1 : 0));
  push(parts, 'operatingCashFlow', s.operatingCashFlow, (x) => (x > 0 ? 1 : 0));
  return avg(parts);
}

function growthScore(s: FundamentalSnapshot, push: (target: number[], name: string, value: number | null, scorer: (x: number) => number) => void): number {
  const parts: number[] = [];
  push(parts, 'revenueGrowth', s.revenueGrowth, (x) => 0.5 + x / 0.6);
  push(parts, 'epsGrowth', s.epsGrowth, (x) => 0.5 + x / 0.6);
  return avg(parts);
}

function valuationScore(s: FundamentalSnapshot, push: (target: number[], name: string, value: number | null, scorer: (x: number) => number) => void): number {
  const parts: number[] = [];
  push(parts, 'pe', s.pe, (x) => (x <= 0 ? 0.1 : 1 - (x - 8) / 27));
  push(parts, 'fwdPe', s.fwdPe, (x) => (x <= 0 ? 0.1 : 1 - (x - 6) / 24));
  push(parts, 'peg', s.peg, (x) => (x <= 0 ? 0.1 : 1 - (x - 0.5) / 2));
  push(parts, 'ps', s.ps, (x) => 1 - (x - 1) / 11);
  push(parts, 'evEbitda', s.evEbitda, (x) => (x <= 0 ? 0.1 : 1 - (x - 6) / 19));
  push(parts, 'fcfYield', s.fcfYield, (x) => x / 0.08);
  return avg(parts);
}

function financialRiskScore(
  s: FundamentalSnapshot,
  push: (target: number[], name: string, value: number | null, scorer: (x: number) => number) => void,
): number {
  const parts: number[] = [];
  push(parts, 'debtToEquity', s.debtToEquity, (x) => (x <= 0 ? 1 : 1 - x / 2.5));
  push(parts, 'interestCoverage', s.interestCoverage, (x) => (x <= 0 ? 0 : x / 6));
  if (s.cash === null || s.totalDebt === null || !Number.isFinite(s.cash) || !Number.isFinite(s.totalDebt)) {
    parts.push(0.5);
  } else {
    const cash = Math.max(0, s.cash);
    const ratio = cash > 0 ? Math.max(0, s.totalDebt) / cash : s.totalDebt > 0 ? Infinity : 0;
    parts.push(clamp(1 - ratio / 3, 0, 1));
  }
  push(parts, 'dilutionPct', s.dilutionPct, (x) => 1 - x / 0.05);
  push(parts, 'buybackPct', s.buybackPct, (x) => 0.5 + x / 0.04);
  return avg(parts);
}

function avg(values: number[]): number {
  if (values.length === 0) return 0.5;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/**
 * 3-18 month horizon.
 *
 * Factors.qualityScore/growthScore/valuationScore/financialRiskScore are each
 * 0..1; missing metrics contribute a neutral 0.5 with an evidence note.
 * fundamentals === null -> action starts at WATCH with INSUFFICIENT_DATA
 * evidence. BUY needs quality >= 0.55 AND (growth or valuation attractive,
 * i.e. >= 0.6), and NEVER fires when financialRiskScore < 0.3 (balance-sheet
 * contradiction). Technicals only adjust timing: >15% above the 50-day average
 * adds an overextension contradiction; near the 52w low inside a flat trend
 * adds favourable-entry timing evidence.
 */
export function longTermScore(input: LongTermInput): StrategyResult {
  const price = input.quote.price;
  const bars = input.candles;
  const snap = input.fundamentals;
  const factors: Record<string, number> = {};
  const evidence: EvidenceItem[] = [];
  const contradictions: EvidenceItem[] = [];
  const missingFields: string[] = [];

  const push = (
    target: number[],
    name: string,
    value: number | null,
    scorer: (x: number) => number,
  ): void => {
    if (value === null || !Number.isFinite(value)) {
      target.push(0.5); // null -> neutral
      missingFields.push(name);
      return;
    }
    target.push(clamp(scorer(value), 0, 1));
  };

  const quality = snap ? qualityScore(snap, push) : 0.5;
  const growth = snap ? growthScore(snap, push) : 0.5;
  const valuation = snap ? valuationScore(snap, push) : 0.5;
  const financialRisk = snap ? financialRiskScore(snap, push) : 0.5;

  if (snap === null) {
    evidence.push({
      kind: 'insufficient_data',
      detail: 'no fundamental snapshot — quality/growth/valuation/risk held neutral at 0.5',
      weight: 0.8,
      positive: false,
    });
  } else if (missingFields.length > 0) {
    evidence.push({
      kind: 'missing_data',
      detail: `neutral 0.5 placeholders for missing fields: ${missingFields.join(', ')}`,
      weight: 0.4,
      positive: false,
    });
  }

  factors.qualityScore = quality;
  factors.growthScore = growth;
  factors.valuationScore = valuation;
  factors.financialRiskScore = financialRisk;

  // Fresh material events within two weeks
  let eventScore = 0;
  for (const ev of input.events ?? []) {
    const hit = eventEvidence(ev, 14);
    if (hit) {
      eventScore += hit.score;
      evidence.push(hit.item);
    }
  }
  factors.eventScore = eventScore;
  if (eventScore <= -0.5) {
    contradictions.push({ kind: 'negative_news_flow', detail: 'material negative headlines within the last two weeks', weight: 0.7, positive: false });
  }

  // Technical timing overlay (optional — only adjusts timing, never gates)
  if (bars.length >= 60) {
    const closes = bars.map((c) => c.close);
    const lastClose = closes[closes.length - 1];
    const sma50v = lastNum(sma(closes, 50));
    const smaLongv = lastNum(sma(closes, Math.min(200, closes.length)));
    const p52 = position52w(bars);
    factors.position52w = p52 ?? 0.5;
    if (sma50v !== null) {
      const ext = (lastClose - sma50v) / sma50v;
      factors.closeVsSma50 = ext;
      if (ext > 0.15) {
        contradictions.push({ kind: 'overextended', detail: `price ${pct(ext)} above the 50-day average — chasing an extended entry`, weight: 0.6, positive: false });
      }
      const flat = smaLongv !== null && smaLongv !== 0 ? Math.abs((sma50v - smaLongv) / smaLongv) < 0.03 : false;
      if (p52 !== null && p52 <= 0.15 && flat) {
        evidence.push({ kind: 'timing:52w_low', detail: 'near the 52-week low inside a flat long-term trend — favourable accumulation window', weight: 0.5, positive: true });
      }
    }
    const cross = maCross(closes, 50, 200);
    factors.maCross = cross === 'BULL' ? 1 : cross === 'BEAR' ? -1 : 0;
    const dd = drawdownSeries(closes);
    factors.drawdownFromHigh = dd[dd.length - 1];
  } else if (bars.length > 0) {
    evidence.push({ kind: 'technical_timing', detail: 'insufficient price history for the technical timing overlay', weight: 0.3, positive: false });
  }

  const attractive = growth >= 0.6 || valuation >= 0.6;
  let action: SignalAction = 'WATCH';
  if (snap === null) {
    action = 'WATCH';
  } else if (financialRisk < 0.3) {
    contradictions.push({
      kind: 'balance_sheet_risk',
      detail: `financial risk score ${financialRisk.toFixed(2)} below the 0.30 floor — BUY is blocked`,
      weight: 0.9,
      positive: false,
    });
    action = quality < 0.4 ? 'SELL' : 'WATCH';
  } else if (quality >= 0.55 && attractive) {
    action = 'BUY';
  }

  let confidence = 0.5;
  if (quality >= 0.7) confidence += 0.2;
  if (attractive) confidence += 0.15;
  if (snap === null) confidence -= 0.2;
  if (financialRisk < 0.3) confidence -= 0.15;
  if (contradictions.some((c) => c.kind === 'overextended')) confidence -= 0.1;
  confidence = clamp(confidence, 0.3, 0.9);

  const score = clamp(
    (quality - 0.5 + (growth - 0.5) + (valuation - 0.5) + (financialRisk - 0.5)) / 2,
    -1,
    1,
  );
  const expectedHoldSessions = clamp(Math.round(63 + 315 * (1 - confidence)), 63, 378);

  const priceSafe = Number.isFinite(price) && price > 0 ? price : 0;
  const sr = bars.length >= 5 ? supportResistance(bars, Math.min(120, bars.length), 0.02) : { supports: [] as number[], resistances: [] as number[] };
  const above = sr.resistances.filter((r) => r > priceSafe);
  const target = above.length > 0 ? Math.min(...above) : priceSafe * 1.3;
  const below = sr.supports.filter((s) => s < priceSafe);
  const support = below.length > 0 ? Math.max(...below) : priceSafe * 0.85;
  const invalidation = Math.max(support, priceSafe * 0.85);

  return {
    score,
    confidence,
    action,
    entryLow: priceSafe * 0.97,
    entryHigh: priceSafe * 1.03,
    target,
    invalidation,
    expectedHoldSessions,
    maxHoldSessions: 252,
    evidence,
    contradictions,
    factors,
  };
}