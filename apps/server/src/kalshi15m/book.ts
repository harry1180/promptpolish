/**
 * KXBTC15M order book — PURE. Applies the frames Kalshi actually sends
 * (captured live 2026-11-20, see test/fixtures/kalshi15m):
 *
 *   orderbook_snapshot { market_ticker, seq, yes_dollars_fp[[p,q]],
 *                        no_dollars_fp[[p,q]] }
 *   orderbook_delta    { market_ticker, seq, side:'yes'|'no',
 *                        price_dollars, delta_fp, ts_ms }
 *   trade              { trade_id, yes_price_dollars, no_price_dollars,
 *                        count_fp, taker_side, taker_book_side, ts_ms }
 *
 * Kalshi books are one book in two currencies: resting YES bids sit on the
 * `yes` side, resting NO bids sit on the `no` side, and a resting NO bid at
 * price q IS a YES ask at 1-q (the counterparty convention — the reason a
 * naive "asks are empty" read of the snapshot is wrong).
 *
 * Prices are stored as integer ten-thousandths (0.0930 -> 930) so no level
 * ever depends on float equality. Sizes are contracts (can be fractional).
 */

export type Side = 'yes' | 'no';

export interface Level { price: number; size: number }

export interface TradePrint {
  tradeId: string;
  tsMs: number;
  yesPrice: number;
  noPrice: number;
  qty: number;
  takerSide: string;
  takerBookSide: string;
}

export interface BookMetrics {
  bestBid: number | null;
  bestAsk: number | null;
  bestBidSize: number;
  bestAskSize: number;
  spread: number | null;
  /**
   * depth-walked executable price for `walkQty` contracts per side — the
   * price a market order of that size actually gets, never a midpoint.
   * null = the book cannot fill that size at all (illiquidity, not a guess).
   */
  bidDepthWalk: number | null;
  askDepthWalk: number | null;
  /** (bidDepth - askDepth) / (bidDepth + askDepth) inside `depthWindow` */
  imbalance: number | null;
  /** order-flow imbalance over the last sample window, -1..1 */
  ofi: number | null;
  /** negative deltas / all deltas in the window — cancel-rate proxy */
  cancelRatio: number | null;
  deltasInWindow: number;
  /** trades (and contracts) in the last second */
  trades1s: number;
  qty1s: number;
  trades5s: number;
  qty5s: number;
  /** taker-side split of the last 60s of volume: >0 = more YES lifting */
  takerBias60s: number | null;
  levels: { bids: number; asks: number };
}

const P = 10_000; // price units: 1 cent = 100, one tenth-cent = 10

function toUnits(price: number | string): number {
  const n = typeof price === 'string' ? Number(price) : price;
  if (!Number.isFinite(n) || n <= 0 || n >= 1) return -1;
  return Math.round(n * P);
}

function toPrice(units: number): number {
  return units / P;
}

export interface ApplyResult {
  applied: boolean;
  /** true when the sequence jumped — book is untrusted until a fresh snapshot */
  gap: boolean;
  reason?: string;
}

/**
 * Rolling 15-minute-window book for ONE market ticker.
 * Metrics are computed on demand (`snapshot()`); flow/cancel counters reset
 * when the runtime calls `endSampleWindow()` after each persisted sample.
 */
export class KalshiBook {
  readonly marketTicker: string;
  /** YES-side resting bids, price units -> contracts */
  private yesBids = new Map<number, number>();
  /** NO-side resting bids, price units -> contracts (YES asks at 1-p) */
  private noBids = new Map<number, number>();
  private trades: TradePrint[] = [];
  private lastSeq: number | null = null;
  private sid: number | null = null;
  /** set on a sequence gap; cleared by `applySnapshot` */
  needsSnapshot = true;
  snapshotAt: number | null = null;
  /** flow accumulators for the current sample window */
  private flowBid = 0;
  private flowAsk = 0;
  private deltas = 0;
  private cancels = 0;
  /** touch proximity for flow classification, in price units (default 2¢) */
  touchWindowUnits = 200;

  constructor(marketTicker: string) {
    this.marketTicker = marketTicker;
  }

  /** Full snapshot — replaces the book and re-arms the sequence. */
  applySnapshot(msg: {
    market_ticker?: string; sid?: number; seq?: number;
    yes_dollars_fp?: unknown; no_dollars_fp?: unknown;
  }, now = Date.now()): ApplyResult {
    if (msg.market_ticker && msg.market_ticker !== this.marketTicker) {
      return { applied: false, gap: false, reason: 'wrong_market' };
    }
    this.yesBids.clear();
    this.noBids.clear();
    for (const [price, size] of levels(msg.yes_dollars_fp)) {
      const u = toUnits(price);
      if (u > 0 && size > 0) this.yesBids.set(u, size);
    }
    for (const [price, size] of levels(msg.no_dollars_fp)) {
      const u = toUnits(price);
      if (u > 0 && size > 0) this.noBids.set(u, size);
    }
    // Sequence is re-armed LAZILY: after a fresh snapshot the next delta is
    // accepted whatever its number (Kalshi may continue the old sequence or
    // restart at 1 after a re-subscribe), and continuity is enforced from
    // there on. A snapshot is the authoritative "start from here".
    this.lastSeq = null;
    if (typeof msg.sid === 'number') this.sid = msg.sid;
    this.needsSnapshot = false;
    this.snapshotAt = now;
    return { applied: true, gap: false };
  }

  /** One incremental level change. Never trusts order: gap -> refuse. */
  applyDelta(msg: {
    market_ticker?: string; sid?: number; seq?: number; side?: string;
    price_dollars?: string | number; delta_fp?: string | number;
  }): ApplyResult {
    if (msg.market_ticker && msg.market_ticker !== this.marketTicker) {
      return { applied: false, gap: false, reason: 'wrong_market' };
    }
    if (typeof msg.seq === 'number') {
      if (this.sid !== null && typeof msg.sid === 'number' && msg.sid !== this.sid) {
        // channel id changed (resubscribe): re-arm from a snapshot
        this.needsSnapshot = true;
        this.lastSeq = msg.seq;
        return { applied: false, gap: true, reason: 'sid_changed' };
      }
      if (this.lastSeq !== null && msg.seq !== this.lastSeq + 1) {
        this.needsSnapshot = true;
        this.lastSeq = msg.seq;
        return { applied: false, gap: true, reason: `seq_${this.lastSeq}_to_${msg.seq}` };
      }
      this.lastSeq = msg.seq;
      if (typeof msg.sid === 'number') this.sid = msg.sid;
    }
    if (this.needsSnapshot) return { applied: false, gap: false, reason: 'awaiting_snapshot' };

    const side: Side = msg.side === 'no' ? 'no' : msg.side === 'yes' ? 'yes' : null as never;
    if (side !== 'yes' && side !== 'no') return { applied: false, gap: false, reason: 'bad_side' };
    const u = toUnits(msg.price_dollars as string);
    const d = Number(msg.delta_fp);
    if (u <= 0 || !Number.isFinite(d)) return { applied: false, gap: false, reason: 'bad_level' };

    const book = side === 'yes' ? this.yesBids : this.noBids;
    const next = (book.get(u) ?? 0) + d;
    if (next > 0.0001) book.set(u, next);
    else book.delete(u);

    this.accountFlow(side, u, d);
    return { applied: true, gap: false };
  }

  /** Flow/cancel accounting for one delta (called from applyDelta). */
  private accountFlow(side: Side, units: number, delta: number): void {
    this.deltas += 1;
    if (delta < 0) this.cancels += 1;
    const best = side === 'yes' ? this.bestBidUnits() : this.bestNoUnits();
    if (best === null) return;
    // near-touch only: size arriving/leaving within touchWindow of the touch
    if (Math.abs(best - units) <= this.touchWindowUnits) {
      if (side === 'yes') this.flowBid += delta;
      else this.flowAsk += delta;
    }
  }

  /** Ingest a print (runtime feeds every trade frame). */
  addTrade(t: TradePrint, now = Date.now()): void {
    this.trades.push(t);
    const cutoff = now - 70_000;
    while (this.trades.length > 0 && this.trades[0].tsMs < cutoff) this.trades.shift();
  }

  /** Reset the per-sample flow/cancel counters (call after each sample row). */
  endSampleWindow(): void {
    this.flowBid = 0;
    this.flowAsk = 0;
    this.deltas = 0;
    this.cancels = 0;
  }

  bestBidUnits(): number | null {
    let best: number | null = null;
    for (const k of this.yesBids.keys()) if (best === null || k > best) best = k;
    return best;
  }

  bestNoUnits(): number | null {
    let best: number | null = null;
    for (const k of this.noBids.keys()) if (best === null || k > best) best = k;
    return best;
  }

  bestAskUnits(): number | null {
    const no = this.bestNoUnits();
    return no === null ? null : P - no;
  }

  /** Resting size on the YES bid side, top `n` levels. */
  private bidDepth(n: number): number {
    const prices = [...this.yesBids.keys()].sort((a, b) => b - a).slice(0, n);
    return prices.reduce((s, p) => s + (this.yesBids.get(p) ?? 0), 0);
  }

  /** Resting size expressible as YES asks (NO bids), top `n` levels. */
  private askDepth(n: number): number {
    const prices = [...this.noBids.keys()].sort((a, b) => b - a).slice(0, n);
    return prices.reduce((s, p) => s + (this.noBids.get(p) ?? 0), 0);
  }

  /**
   * Depth-weighted executable price for taking `qty` contracts on one side —
   * walks real resting size (never a midpoint, never best-only).
   * Returns null when the book cannot fill `qty`.
   */
  walkPrice(side: 'BUY' | 'SELL', qty: number): number | null {
    if (!(qty > 0)) return null;
    if (side === 'BUY') {
      const asks = [...this.noBids.entries()]
        .map(([u, s]) => ({ units: P - u, size: s }))
        .filter((l) => l.units > 0)
        .sort((a, b) => a.units - b.units);
      let need = qty;
      let cost = 0;
      for (const l of asks) {
        const take = Math.min(need, l.size);
        cost += take * (l.units / P);
        need -= take;
        if (need <= 1e-9) return cost / qty;
      }
      return null;
    }
    const bids = [...this.yesBids.entries()]
      .map(([u, s]) => ({ units: u, size: s }))
      .sort((a, b) => b.units - a.units);
    let need = qty;
    let proceeds = 0;
    for (const l of bids) {
      const take = Math.min(need, l.size);
      proceeds += take * (l.units / P);
      need -= take;
      if (need <= 1e-9) return proceeds / qty;
    }
    return null;
  }

  /** Raw level lists in dollars (YES view), best first. */
  depth(levels = 5): { bids: Level[]; asks: Level[] } {
    const bids = [...this.yesBids.entries()]
      .map(([u, s]) => ({ price: toPrice(u), size: s }))
      .sort((a, b) => b.price - a.price)
      .slice(0, levels);
    const asks = [...this.noBids.entries()]
      .map(([u, s]) => ({ price: toPrice(P - u), size: s }))
      .filter((l) => l.price > 0 && l.price < 1)
      .sort((a, b) => a.price - b.price)
      .slice(0, levels);
    return { bids, asks };
  }

  /** Everything the decision path and the dashboard read, computed now. */
  metrics(opts: { depthLevels?: number; walkQty?: number; now?: number } = {}): BookMetrics {
    const now = opts.now ?? Date.now();
    const depthLevels = opts.depthLevels ?? 5;
    const walkQty = opts.walkQty ?? 10;
    const bidU = this.bestBidUnits();
    const askU = this.bestAskUnits();
    const bestBid = bidU === null ? null : toPrice(bidU);
    const bestAsk = askU === null ? null : toPrice(askU);
    const bestBidSize = bidU === null ? 0 : this.yesBids.get(bidU) ?? 0;
    const bestAskSize = askU === null || this.bestNoUnits() === null
      ? 0 : this.noBids.get(this.bestNoUnits() as number) ?? 0;

    const bidDepth = this.bidDepth(depthLevels);
    const askDepth = this.askDepth(depthLevels);
    const denom = bidDepth + askDepth;

    const d1 = this.trades.filter((t) => t.tsMs >= now - 1_000);
    const d5 = this.trades.filter((t) => t.tsMs >= now - 5_000);
    const d60 = this.trades.filter((t) => t.tsMs >= now - 60_000);
    const yesQty = d60.filter((t) => (t.takerSide ?? '').toLowerCase() === 'yes')
      .reduce((s, t) => s + t.qty, 0);
    const noQty = d60.filter((t) => (t.takerSide ?? '').toLowerCase() === 'no')
      .reduce((s, t) => s + t.qty, 0);

    const flowSum = Math.abs(this.flowBid) + Math.abs(this.flowAsk);
    return {
      bestBid, bestAsk, bestBidSize, bestAskSize,
      // integer units first: 4400-4300 = 100 -> 0.01 exactly (no float dust)
      spread: bidU !== null && askU !== null ? (askU - bidU) / P : null,
      bidDepthWalk: this.walkPrice('SELL', walkQty),
      askDepthWalk: this.walkPrice('BUY', walkQty),
      imbalance: denom > 0 ? (bidDepth - askDepth) / denom : null,
      ofi: flowSum > 0 ? (this.flowBid - this.flowAsk) / flowSum : null,
      cancelRatio: this.deltas > 0 ? this.cancels / this.deltas : null,
      deltasInWindow: this.deltas,
      trades1s: d1.length,
      qty1s: d1.reduce((s, t) => s + t.qty, 0),
      trades5s: d5.length,
      qty5s: d5.reduce((s, t) => s + t.qty, 0),
      takerBias60s: yesQty + noQty > 0 ? (yesQty - noQty) / (yesQty + noQty) : null,
      levels: { bids: this.yesBids.size, asks: this.noBids.size },
    };
  }

  get isEmpty(): boolean {
    return this.yesBids.size === 0 && this.noBids.size === 0;
  }

  get seq(): number | null {
    return this.lastSeq;
  }
}

/** Tolerant `[[p,q], ...]` reader (Kalshi sends strings). */
function levels(raw: unknown): Array<[string, number]> {
  if (!Array.isArray(raw)) return [];
  const out: Array<[string, number]> = [];
  for (const row of raw) {
    if (!Array.isArray(row) || row.length < 2) continue;
    const p = String(row[0]);
    const q = Number(row[1]);
    if (Number.isFinite(q) && q > 0) out.push([p, q]);
  }
  return out;
}