import { describe, expect, it } from 'vitest';
import {
  atr,
  avgVolume,
  bollinger,
  detectBreakout,
  drawdownSeries,
  ema,
  gapPct,
  maCross,
  macd,
  obv,
  position52w,
  realizedVol,
  relativeStrength,
  relativeVolume,
  roc,
  rsi,
  sma,
  stochastic,
  supportResistance,
  vwapSeries,
} from '../src/indicators.ts';
import type { Candle } from '../src/types.ts';
import { barsFromCloses, bar, weekdayDates } from './gen.ts';

describe('indicators', () => {
  it('sma known values and warm-up nulls', () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
    expect(sma([1, 2, 3], 5)).toEqual([null, null, null]);
    expect(sma([], 3)).toEqual([]);
  });

  it('ema seeds with SMA then applies the smoothing constant', () => {
    // period 3: k = 0.5, seed = mean(1,2,3) = 2 -> 4*0.5+2*0.5 = 3 -> 5*0.5+3*0.5 = 4
    expect(ema([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
    expect(ema([1, 2], 3)).toEqual([null, null]);
  });

  it('rsi of a monotone rising series approaches 100', () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
    const out = rsi(closes, 14);
    expect(out[13]).toBeNull();
    expect(out[14]).toBe(100);
    expect(out[19]).toBe(100);
  });

  it('rsi of a flat series is 50 (documented neutral)', () => {
    const out = rsi(new Array(30).fill(100), 14);
    expect(out[13]).toBeNull();
    for (let i = 14; i < out.length; i++) expect(out[i]).toBe(50);
  });

  it('rsi of a falling series approaches 0', () => {
    const closes = Array.from({ length: 20 }, (_, i) => 200 - i);
    expect(rsi(closes, 14)[19]).toBe(0);
  });

  it('macd aligns with the EMAs and hist = macd - signal', () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + i);
    const { macd: line, signal, hist } = macd(closes, 12, 26, 9);
    expect(line[24]).toBeNull(); // slow EMA seeds at index 25
    expect(line[25]).not.toBeNull();
    expect(line[59]).toBeGreaterThan(0); // fast above slow in a rising series
    expect(signal[59]).not.toBeNull();
    expect(hist[59]).not.toBeNull();
    for (let i = 0; i < closes.length; i++) {
      if (line[i] !== null && signal[i] !== null) {
        expect(hist[i]).toBeCloseTo(line[i]! - signal[i]!, 12);
      }
    }
  });

  it('atr is positive with warm-up nulls', () => {
    const dates = weekdayDates('2026-01-02', 30);
    const candles = barsFromCloses(dates, Array.from({ length: 30 }, (_, i) => 100 + i));
    const out = atr(candles, 14);
    expect(out[12]).toBeNull();
    for (let i = 13; i < out.length; i++) {
      expect(out[i]).not.toBeNull();
      expect(out[i]!).toBeGreaterThan(0);
    }
    expect(atr(candles.slice(0, 5), 14).every((v) => v === null)).toBe(true);
  });

  it('bollinger bands bracket the middle and collapse on a flat series', () => {
    const flat = bollinger(new Array(30).fill(10), 20, 2);
    expect(flat.middle[29]).toBe(10);
    expect(flat.upper[29]).toBe(10);
    expect(flat.lower[29]).toBe(10);
    const varied = bollinger(Array.from({ length: 30 }, (_, i) => 100 + (i % 5) * 3), 20, 2);
    expect(varied.upper[29]!).toBeGreaterThan(varied.middle[29]!);
    expect(varied.lower[29]!).toBeLessThan(varied.middle[29]!);
    expect(varied.upper[18]).toBeNull();
  });

  it('vwap cumulative: [10, 11] for two equal-size bars at typical 10 and 12', () => {
    const candles = [bar('d1', 10, 11, 9, 10, 100), bar('d2', 12, 13, 11, 12, 100)];
    expect(vwapSeries(candles)).toEqual([10, 11]);
  });

  it('obv accumulates on up moves and subtracts on down moves', () => {
    const candles = [
      bar('d1', 99, 100, 98, 100, 1000),
      bar('d2', 100, 102, 99, 101, 500),
      bar('d3', 101, 101, 98, 99, 200),
    ];
    expect(obv(candles)).toEqual([0, 500, 300]);
  });

  it('roc is a fraction with period warm-up nulls', () => {
    const out = roc([100, 110], 1);
    expect(out[0]).toBeNull();
    expect(out[1]).toBeCloseTo(0.1, 12);
    expect(roc([100, 110, 121], 10)).toEqual([null, null, null]);
  });

  it('stochastic: %K = 100 at the window high, 50 on a zero-range window', () => {
    const atHigh: Candle[] = Array.from({ length: 20 }, (_, i) =>
      bar(`d${i}`, 90 + i * 0.5, 100, 90, i === 19 ? 100 : 95, 1000),
    );
    const kh = stochastic(atHigh, 14, 3);
    expect(kh.k[19]).toBe(100);
    expect(kh.d[19]).not.toBeNull();
    const flat: Candle[] = Array.from({ length: 20 }, (_, i) => bar(`d${i}`, 10, 10, 10, 10, 1000));
    const kf = stochastic(flat, 14, 3);
    expect(kf.k[19]).toBe(50);
    expect(kf.d[19]).toBe(50);
    expect(kf.k[12]).toBeNull();
  });

  it('relativeStrength = stockRet - benchRet over the trailing window', () => {
    expect(relativeStrength([100, 200], [100, 100], 1)).toEqual([null, 1]);
    expect(relativeStrength([100, 110], [100, 120], 1)[1]).toBeCloseTo(-0.1, 12);
    expect(relativeStrength([100, 200], [100], 1)).toEqual([null, null]);
  });

  it('drawdown series is always <= 0', () => {
    expect(drawdownSeries([100, 120, 90])).toEqual([0, 0, -0.25]);
    const up = drawdownSeries(Array.from({ length: 50 }, (_, i) => 100 + i));
    expect(up.every((v) => v <= 0)).toBe(true);
    expect(up.every((v) => v === 0)).toBe(true);
  });

  it('position52w: bounded 0..1, null with < 60 bars', () => {
    expect(position52w(barsFromCloses(weekdayDates('2026-01-02', 59), new Array(59).fill(100)))).toBeNull();
    const candles = barsFromCloses(weekdayDates('2026-01-02', 70), new Array(70).fill(100));
    for (const c of candles) {
      c.high = 110;
      c.low = 90;
    }
    candles[69].close = 110; // at the top of the range
    expect(position52w(candles)).toBe(1);
    candles[69].close = 90;
    expect(position52w(candles)).toBe(0);
    candles[69].close = 100;
    expect(position52w(candles)).toBe(0.5);
  });

  it('relativeVolume spikes above 1 on a volume surge', () => {
    const dates = weekdayDates('2026-01-02', 25);
    const candles = dates.map((d, i) => bar(d, 100, 101, 99, 100, i === 24 ? 300_000 : 100_000));
    expect(relativeVolume(candles, 20)).toBeCloseTo(3, 10);
    expect(relativeVolume(candles.slice(0, 10), 20)).toBeNull();
  });

  it('detectBreakout: synthetic 20d high break and no-breakout case', () => {
    const dates = weekdayDates('2026-01-02', 22);
    const up = dates.map((d, i) => {
      const close = i <= 19 ? 100 : i === 20 ? 104 : 106;
      return bar(d, close, 105, 95, close, 1000);
    });
    expect(detectBreakout(up, 20)).toEqual({ breakout: true, direction: 'UP', level: 105 });
    const down = dates.map((d, i) => {
      const close = i <= 19 ? 100 : i === 20 ? 97 : 94;
      return bar(d, close, 105, 95, close, 1000);
    });
    expect(detectBreakout(down, 20)).toEqual({ breakout: true, direction: 'DOWN', level: 95 });
    const flat = dates.map((d, i) => bar(d, 100, 105, 95, i === 21 ? 102 : 100, 1000));
    expect(detectBreakout(flat, 20)).toEqual({ breakout: false, direction: null, level: null });
    expect(detectBreakout(up.slice(0, 10), 20)).toEqual({ breakout: false, direction: null, level: null });
  });

  it('maCross: BULL on a long rising series, FLAT without enough bars', () => {
    expect(maCross(Array.from({ length: 250 }, (_, i) => 100 + i), 50, 200)).toBe('BULL');
    expect(maCross(Array.from({ length: 250 }, (_, i) => 300 - i), 50, 200)).toBe('BEAR');
    expect(maCross(Array.from({ length: 100 }, (_, i) => 100 + i), 50, 200)).toBe('FLAT');
  });

  it('gapPct as a fraction with zero/missing prevClose guard', () => {
    expect(gapPct(bar('d', 105, 106, 104, 105, 1), 100)).toBeCloseTo(0.05, 12);
    expect(gapPct(bar('d', 105, 106, 104, 105, 1), 0)).toBeNull();
    expect(gapPct(bar('d', 105, 106, 104, 105, 1), null)).toBeNull();
  });

  it('avgVolume over the trailing window', () => {
    const candles = Array.from({ length: 30 }, (_, i) => bar(`d${i}`, 100, 101, 99, 100, 500));
    expect(avgVolume(candles, 20)).toBe(500);
    expect(avgVolume(candles, 40)).toBeNull();
  });

  it('realizedVol of a constant series is exactly 0', () => {
    expect(realizedVol(new Array(40).fill(100), 20)).toBe(0);
    const rising = Array.from({ length: 40 }, (_, i) => 100 * Math.pow(1.01, i));
    expect(realizedVol(rising, 20)!).toBeGreaterThan(0);
    expect(realizedVol([100], 20)).toBeNull();
  });

  it('supportResistance finds the swing high/low of a wave', () => {
    const dates = weekdayDates('2026-01-02', 40);
    const closes = dates.map((_, i) => 100 + 12 * Math.sin(i / 3));
    const candles = barsFromCloses(dates, closes);
    const { supports, resistances } = supportResistance(candles, 40, 0.02);
    expect(supports.length).toBeGreaterThan(0);
    expect(resistances.length).toBeGreaterThan(0);
    expect(supports.some((s) => s <= 92)).toBe(true);
    expect(resistances.some((r) => r >= 108)).toBe(true);
    // sorted ascending
    expect([...supports].sort((a, b) => a - b)).toEqual(supports);
    expect([...resistances].sort((a, b) => a - b)).toEqual(resistances);
    expect(supportResistance([], 20, 0.02)).toEqual({ supports: [], resistances: [] });
  });
});