/**
 * In-memory Kraken tape window for the entry confirmation gate.
 *
 * An OBSERVER, not a feed: it is fed from the existing stream's tick path
 * (see stream.ts `tickObservers` / runtime.ts), allocates nothing per tick
 * beyond one bounded ring per symbol, and is read only when the scan is about
 * to create a BUY order. No new socket, no extra polling, no database writes,
 * no path into the broker.
 *
 * It exists because there is no tick history anywhere in the book: the daily
 * bars are one OHLC per day and `market_quotes` keeps only the latest row, so
 * "is this price a local high?" cannot be answered from storage. The tape
 * answers it over a bounded window and reports `null` when it has not seen
 * enough ticks — a missing window must never be read as "not at a high".
 */
export interface TapeQuote {
  symbol: string;
  price: number;
  ts: number;
}

export interface TapeWindow {
  symbol: string;
  ticks: number;
  firstTs: number;
  lastTs: number;
  /** highest / lowest observed price inside the window */
  high: number;
  low: number;
  last: number;
  /** ms between `lastTs` and the moment the window was read */
  ageMs: number;
}

interface Ring {
  /** parallel arrays: cheaper than objects for a hot observer */
  ts: number[];
  px: number[];
}

export class TickTape {
  private readonly rings = new Map<string, Ring>();
  private readonly windowMs: number;
  private readonly cap: number;

  constructor(opts: { windowMs?: number; capPerSymbol?: number } = {}) {
    this.windowMs = opts.windowMs ?? 1_800_000;
    this.cap = opts.capPerSymbol ?? 512;
  }

  /** Feed one tick. Never throws — a broken observer must not hurt the stream. */
  observe(q: TapeQuote): void {
    if (!q || !q.symbol || !Number.isFinite(q.price) || q.price <= 0) return;
    let ring = this.rings.get(q.symbol);
    if (!ring) {
      ring = { ts: [], px: [] };
      this.rings.set(q.symbol, ring);
    }
    ring.ts.push(q.ts);
    ring.px.push(q.price);
    while (ring.ts.length > this.cap) { ring.ts.shift(); ring.px.shift(); }
  }

  /** Window for one symbol at `now`, or null when too little was observed. */
  window(symbol: string, now: number, minTicks = 1): TapeWindow | null {
    const ring = this.rings.get(symbol);
    if (!ring) return null;
    const cut = now - this.windowMs;
    // drop ticks older than the window (front is oldest)
    let i = 0;
    while (i < ring.ts.length && ring.ts[i] < cut) i += 1;
    if (i > 0) { ring.ts.splice(0, i); ring.px.splice(0, i); }
    const n = ring.ts.length;
    if (n < minTicks) return null;
    let high = -Infinity;
    let low = Infinity;
    for (let k = 0; k < n; k += 1) {
      const px = ring.px[k];
      if (px > high) high = px;
      if (px < low) low = px;
    }
    const last = ring.px[n - 1];
    const lastTs = ring.ts[n - 1];
    return {
      symbol, ticks: n, firstTs: ring.ts[0], lastTs,
      high, low, last, ageMs: Math.max(0, now - lastTs),
    };
  }

  symbols(): string[] {
    return [...this.rings.keys()];
  }

  reset(): void {
    this.rings.clear();
  }
}
