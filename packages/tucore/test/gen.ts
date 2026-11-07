import type { Candle } from '../src/types.ts';

/** `count` weekday (Mon-Fri) dates starting at `start` ('YYYY-MM-DD'). */
export function weekdayDates(start: string, count: number): string[] {
  const out: string[] = [];
  const [y, m, d] = start.split('-').map(Number);
  let ts = Date.UTC(y, m - 1, d);
  while (out.length < count) {
    const wd = new Date(ts).getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(new Date(ts).toISOString().slice(0, 10));
    ts += 86400000;
  }
  return out;
}

export function bar(date: string, open: number, high: number, low: number, close: number, volume: number): Candle {
  return { date, open, high, low, close, volume };
}

/** Build bars from an explicit close path (open = previous close, padded highs/lows). */
export function barsFromCloses(dates: string[], closes: number[], volume = 1_000_000): Candle[] {
  return dates.map((date, i) => {
    const close = closes[i];
    const open = i === 0 ? close : closes[i - 1];
    const high = Math.max(open, close) * 1.003;
    const low = Math.min(open, close) * 0.997;
    return { date, open, high, low, close, volume };
  });
}

/** Geometric close path: start * dailyFactor^i. */
export function geometricCloses(n: number, start: number, dailyFactor: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(start * Math.pow(dailyFactor, i));
  return out;
}