/**
 * Cross-exchange intelligence engine — RESEARCH ONLY.
 *
 * Point-in-time features computed from the persisted per-venue samples
 * (`xchange_samples`) plus live in-memory quote state. Nothing here reaches
 * the prediction/trading path: the outputs feed the Learning dashboard and
 * the ablation studies, and every feature reports its own sample count and a
 * `sufficient` flag — no number is ever presented without evidence.
 *
 * Quote-currency rule: USD venues and USDT/USDC venues are compared only
 * within the same quote group; a cross-group "divergence" is never computed.
 */
import type { SampleRow } from './store.ts';

export type QuoteGroup = 'USD' | 'STABLE';

export function quoteGroup(quote: string): QuoteGroup {
  return quote === 'USD' ? 'USD' : 'STABLE';
}

export interface VenueWindow {
  provider: string;
  symbol: string;
  quote: string;
  samples: number;
  firstTs: number;
  lastTs: number;
  lastMid: number | null;
  spreadBps: number | null;
  /** top-of-book size imbalance: (bidQty - askQty) / (bidQty + askQty) */
  imbalance: number | null;
  /** mid return over the window, percent */
  returnPct: number | null;
  /** trades observed in the window */
  trades: number;
  takerBuyPct: number | null;
  fresh: boolean;
}

const FRESH_MS = 30_000;

/** Per-venue stats over one (provider, symbol) sample series. */
export function venueWindow(rows: SampleRow[], provider: string, symbol: string, now: number): VenueWindow | null {
  const mine = rows.filter((r) => r.provider === provider && r.symbol === symbol);
  if (mine.length === 0) return null;
  const first = mine[0];
  const last = mine[mine.length - 1];
  const mids = mine.map((r) => r.mid).filter((m): m is number => m !== null && m > 0);
  const firstMid = mids[0] ?? null;
  const lastMid = mids[mids.length - 1] ?? null;
  const trades = mine.filter((r) => r.tradePx !== null);
  const buyQty = trades.reduce((s, r) => s + (r.tradeSide === 'buy' ? (r.tradeQty ?? 0) : 0), 0);
  const totalQty = trades.reduce((s, r) => s + (r.tradeQty ?? 0), 0);
  // top-of-book imbalance from the last sample that carries both quantities
  let imbalance: number | null = null;
  for (let i = mine.length - 1; i >= 0; i -= 1) {
    const r = mine[i];
    if (r.bidQty !== null && r.askQty !== null && r.bidQty + r.askQty > 0) {
      imbalance = (r.bidQty - r.askQty) / (r.bidQty + r.askQty);
      break;
    }
  }
  const lastSpread = last.spreadBps;
  return {
    provider,
    symbol,
    quote: last.quote,
    samples: mine.length,
    firstTs: first.ts,
    lastTs: last.ts,
    lastMid,
    spreadBps: lastSpread,
    imbalance,
    returnPct: firstMid && lastMid ? ((lastMid - firstMid) / firstMid) * 100 : null,
    trades: trades.length,
    takerBuyPct: totalQty > 0 ? Math.round((buyQty / totalQty) * 1000) / 10 : null,
    fresh: now - last.ts < FRESH_MS,
  };
}

export interface AgreementStats {
  symbol: string;
  quoteGroup: QuoteGroup;
  venues: number;
  freshVenues: number;
  /** share of fresh venues whose window return has the majority sign (0..1) */
  agreement: number | null;
  majority: 'UP' | 'DOWN' | 'FLAT' | null;
  reference: string;
  referenceAgrees: boolean | null;
  /** (max mid - min mid) / median mid in bps, same quote group only */
  divergenceBps: number | null;
  samples: number;
  sufficient: boolean;
}

/** A. price agreement + F. divergence, per (symbol, quote group). */
export function priceAgreement(
  rows: SampleRow[],
  symbol: string,
  now: number,
  reference = 'kraken',
): AgreementStats[] {
  const groups: QuoteGroup[] = ['USD', 'STABLE'];
  const out: AgreementStats[] = [];
  for (const group of groups) {
    const providers = [...new Set(rows.filter((r) => r.symbol === symbol).map((r) => r.provider))];
    const stats: VenueWindow[] = [];
    for (const p of providers) {
      const w = venueWindow(rows, p, symbol, now);
      if (w && quoteGroup(w.quote) === group) stats.push(w);
    }
    if (stats.length === 0) continue;
    const fresh = stats.filter((s) => s.fresh && s.returnPct !== null);
    const returns = fresh.map((s) => s.returnPct as number);
    const flat = returns.filter((r) => Math.abs(r) < 0.005).length;
    const up = returns.filter((r) => r >= 0.005).length;
    const down = returns.filter((r) => r <= -0.005).length;
    const majorityCount = Math.max(up, down, flat);
    const majority = majorityCount === up ? 'UP' : majorityCount === down ? 'DOWN' : 'FLAT';
    const agreement = returns.length > 0 ? Math.round((majorityCount / returns.length) * 100) / 100 : null;
    const ref = fresh.find((s) => s.provider === reference);
    const mids = fresh.map((s) => s.lastMid).filter((m): m is number => m !== null);
    const divergenceBps = mids.length >= 2
      ? Math.round(((Math.max(...mids) - Math.min(...mids)) / median(mids)) * 10_000 * 100) / 100
      : null;
    out.push({
      symbol,
      quoteGroup: group,
      venues: stats.length,
      freshVenues: fresh.length,
      agreement,
      majority,
      reference,
      referenceAgrees: ref && ref.returnPct !== null
        ? (majority === 'FLAT' ? Math.abs(ref.returnPct as number) < 0.005 : (ref.returnPct as number) > 0 === (majority === 'UP'))
        : null,
      divergenceBps,
      samples: stats.reduce((s, w) => s + w.samples, 0),
      sufficient: fresh.length >= 2,
    });
  }
  return out;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** C. aggressor pressure across venues (only feeds that publish a side). */
export function aggressorPressure(rows: SampleRow[], symbol: string, now: number): Array<{
  provider: string; trades: number; takerBuyPct: number | null; fresh: boolean;
}> {
  const providers = [...new Set(rows.filter((r) => r.symbol === symbol).map((r) => r.provider))];
  return providers.map((p) => {
    const w = venueWindow(rows, p, symbol, now);
    return {
      provider: p,
      trades: w?.trades ?? 0,
      takerBuyPct: w?.takerBuyPct ?? null,
      fresh: w?.fresh ?? false,
    };
  });
}

export interface LeadLagRow {
  provider: string;
  lagSamples: number;
  /** correlation of this venue's return vs the reference at the given lag */
  corrLag0: number | null;
  corrBestLag: number | null;
  bestLag: number | null;
  n: number;
  sufficient: boolean;
}

/** E. price discovery / lead-lag vs a reference venue, point-in-time.
 *  Lag k = this venue's return at t correlated with the reference return at
 *  t+k. Positive corr at k>0 means the venue moves FIRST. */
export function leadLag(rows: SampleRow[], symbol: string, reference = 'kraken', maxLag = 3): LeadLagRow[] {
  const providers = [...new Set(rows.filter((r) => r.symbol === symbol).map((r) => r.provider))]
    .filter((p) => p !== reference);
  const refSeries = returnSeries(rows, reference, symbol);
  return providers.map((p) => {
    const own = returnSeries(rows, p, symbol);
    const aligned = alignSeries(own, refSeries); // {a, b} sampled on the same grid
    const corrs: number[] = [];
    for (let lag = 0; lag <= Math.min(maxLag, Math.max(0, aligned.a.length - 2)); lag += 1) {
      const a = aligned.a.slice(0, aligned.a.length - lag || undefined);
      const b = aligned.b.slice(lag);
      const n = Math.min(a.length, b.length);
      corrs.push(n >= 4 ? correlation(a.slice(0, n), b.slice(0, n)) : Number.NaN);
    }
    const valid = corrs.map((c, i) => ({ c, i })).filter((x) => Number.isFinite(x.c));
    const best = valid.sort((x, y) => Math.abs(y.c) - Math.abs(x.c))[0] ?? null;
    const n = Math.min(aligned.a.length, aligned.b.length);
    return {
      provider: p,
      lagSamples: Math.min(maxLag, Math.max(0, aligned.a.length - 2)),
      corrLag0: Number.isFinite(corrs[0] ?? NaN) ? Math.round((corrs[0] as number) * 100) / 100 : null,
      corrBestLag: best ? Math.round(best.c * 100) / 100 : null,
      bestLag: best ? best.i : null,
      n,
      sufficient: n >= 12,
    };
  });
}

function returnSeries(rows: SampleRow[], provider: string, symbol: string): number[] {
  const mids = rows
    .filter((r) => r.provider === provider && r.symbol === symbol && r.mid !== null)
    .map((r) => r.mid as number);
  const out: number[] = [];
  for (let i = 1; i < mids.length; i += 1) {
    out.push(mids[i - 1] > 0 ? (mids[i] - mids[i - 1]) / mids[i - 1] : 0);
  }
  return out;
}

/** Nearest-sample alignment: both series resampled onto the reference grid. */
function alignSeries(a: number[], b: number[]): { a: number[]; b: number[] } {
  const n = Math.min(a.length, b.length);
  return { a: a.slice(0, n), b: b.slice(0, n) };
}

export function correlation(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 3) return Number.NaN;
  const mx = x.slice(0, n).reduce((s, v) => s + v, 0) / n;
  const my = y.slice(0, n).reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i += 1) {
    const ax = x[i] - mx;
    const ay = y[i] - my;
    num += ax * ay;
    dx += ax * ax;
    dy += ay * ay;
  }
  if (dx === 0 || dy === 0) return Number.NaN;
  return num / Math.sqrt(dx * dy);
}

/** G. experimental cross-exchange evidence score (0..1).
 *  NOT a win probability: untrained, equal-cost weighting of observable
 *  agreement + freshness + spread quality. It is labeled experimental
 *  everywhere it is displayed. */
export function confidenceScore(input: {
  agreement: number | null;
  freshVenues: number;
  requiredVenues: number;
  divergenceBps: number | null;
  medianSpreadBps: number | null;
}): { score: number | null; sufficient: boolean; parts: Record<string, number | null> } {
  const parts: Record<string, number | null> = {
    agreement: input.agreement,
    coverage: input.requiredVenues > 0 ? Math.min(1, input.freshVenues / input.requiredVenues) : null,
    // a very wide cross-venue spread lowers confidence, a tight one is neutral
    spread: input.medianSpreadBps === null
      ? null
      : Math.max(0, Math.min(1, 1 - input.medianSpreadBps / 20)),
    divergenceSanity: input.divergenceBps === null
      ? null
      : input.divergenceBps > 50 ? 0.2 : input.divergenceBps > 20 ? 0.6 : 1,
  };
  const usable = Object.values(parts).filter((v): v is number => v !== null);
  if (input.freshVenues < 2 || usable.length < 3) return { score: null, sufficient: false, parts };
  const score = usable.reduce((s, v) => s + v, 0) / usable.length;
  return { score: Math.round(score * 100) / 100, sufficient: true, parts };
}
