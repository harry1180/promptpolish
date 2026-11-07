/**
 * Microstructure Alpha Engine — SHADOW ONLY.
 *
 * Consumes the SAME Kraken Spot WebSocket v2 frames the production stream
 * already receives, via two observers installed in CryptoRuntime:
 *   - onRawMessage: every frame, after the existing ticker parse has run
 *   - onQuote:      the normalized TickQuote (covers the REST fallback path)
 * No second socket, no write into shared market state, no execution path.
 * Every failure is caught and counted HERE so `ingestTick` can never be
 * affected. See docs/CRYPTO-MICRO.md for the flag semantics.
 *
 * Verified live 2026-11-07 against wss://ws.kraken.com/v2 (fixture in
 * apps/server/test/fixtures/kraken-v2-capture.json):
 *   ticker row: {symbol,bid,bid_qty,ask,ask_qty,last,volume,vwap,low,high,
 *                 change,change_pct,trades,timestamp}
 *   trade row:  {symbol,side,price,qty,ord_type,trade_id,timestamp}
 * Top-of-book imbalance and microprice are therefore observable WITHOUT the
 * book channel; L2/OFI features stay disabled until `book` is subscribed.
 */

export interface MicroFlags {
  enabled: boolean;
  l2Features: boolean;
  metaLabeling: boolean;
  costAwareValidation: boolean;
  shadowMode: boolean;
  liveExecution: boolean;
}

export interface MicroFeatures {
  symbol: string;
  /** Kraken event time (ms) of the newest input behind this snapshot */
  eventTs: number;
  /** local wall-clock receive time (ms) */
  recvTs: number;
  /** recvTs - eventTs: observed transport+queue latency */
  ageMs: number;
  mid: number;
  bid: number;
  ask: number;
  spreadBps: number;
  bidQty: number | null;
  askQty: number | null;
  /** (bidQty - askQty) / (bidQty + askQty); null when sizes are unknown */
  tobImbalance: number | null;
  /** size-weighted quote: (bid*askQty + ask*bidQty) / (bidQty+askQty) */
  microprice: number | null;
  /** (microprice - mid) / mid in bps; null without sizes */
  microDevBps: number | null;
  /** simple returns vs the mid at-or-before now-window, in bps */
  retBps: { s1: number | null; s5: number | null; s15: number | null; s30: number | null; s60: number | null };
  /** stdev of log-returns over the 60s window, in bps */
  rv60Bps: number | null;
  /** trade-side flow over 60s; null when the trade channel is off */
  trades60: { count: number; buyVol: number; sellVol: number; cvd: number; ratePerSec: number } | null;
  quality: 'OK' | 'WARMING_UP' | 'STALE' | 'NO_DATA';
}

interface Sample { t: number; mid: number }
interface TradeSample { t: number; buy: boolean; vol: number }

interface SymState {
  l1: { bid: number; ask: number; bidQty: number | null; askQty: number | null; eventTs: number; recvTs: number } | null;
  samples: Sample[];
  trades: TradeSample[];
  seenIds: Set<string>;
}

export interface MicroEngineOptions {
  flags: MicroFlags;
  /** taker fee per side, as a fraction (0.0016 = 16bps) — cost context only */
  feePct: number;
  staleMs?: number;
  queueCap?: number;
  /** >0: emit a feature snapshot per symbol at most this often (recording) */
  recordMs?: number;
  /** called with a JSON-serialisable snapshot when recording is on */
  onSnapshot?: (symbol: string, payload: MicroFeatures) => void;
  /** false: enqueue only; drain() must be called explicitly (tests) */
  autoDrain?: boolean;
}

interface MicroEvent { kind: 'raw' | 'quote'; raw?: string; quote?: { symbol: string; price: number; bid?: number; ask?: number; ts: number; provider?: string }; recvTs: number }

const WINDOWS_MS = [1_000, 5_000, 15_000, 30_000, 60_000] as const;
const WINDOW_MS = 60_000;
const SEEN_CAP = 20_000;

function mapSymbol(raw: string): string {
  const base = raw.split('/')[0]?.toUpperCase() ?? '';
  return base === 'XBT' ? 'BTC' : base;
}

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export class MicroEngine {
  readonly flags: MicroFlags;
  readonly feePct: number;
  private staleMs: number;
  private queueCap: number;
  private recordMs: number;
  private onSnapshot: ((symbol: string, payload: MicroFeatures) => void) | null;
  private autoDrain: boolean;
  private queue: MicroEvent[] = [];
  private syms = new Map<string, SymState>();
  private lastRecordAt = new Map<string, number>();
  counters = {
    processed: 0,
    droppedOverload: 0,
    droppedStale: 0,
    duplicates: 0,
    parseErrors: 0,
    errors: 0,
    dedupEvictions: 0,
    recorded: 0,
  };

  constructor(opts: MicroEngineOptions) {
    this.flags = { ...opts.flags };
    this.feePct = opts.feePct;
    this.staleMs = opts.staleMs ?? 5_000;
    this.queueCap = opts.queueCap ?? 2_000;
    this.recordMs = opts.recordMs ?? 0;
    this.onSnapshot = opts.onSnapshot ?? null;
    this.autoDrain = opts.autoDrain ?? true;
  }

  /** round-trip cost context in bps (entry + exit taker fees) */
  roundTripCostBps(): number {
    return Math.round(this.feePct * 2 * 10_000 * 100) / 100;
  }

  private state(symbol: string): SymState {
    let s = this.syms.get(symbol);
    if (!s) {
      s = { l1: null, samples: [], trades: [], seenIds: new Set() };
      this.syms.set(symbol, s);
    }
    return s;
  }

  /** Raw Kraken v2 frame from the shared socket (observer position). */
  enqueueRaw(text: string, recvTs: number): void {
    this.push({ kind: 'raw', raw: text, recvTs });
  }

  /** Normalized quote (REST fallback / non-size updates). */
  onQuote(q: { symbol: string; price: number; bid?: number; ask?: number; ts: number; provider?: string }, recvTs: number): void {
    this.push({ kind: 'quote', quote: q, recvTs });
  }

  private push(ev: MicroEvent): void {
    if (this.queue.length >= this.queueCap) {
      this.queue.shift(); // explicit drop-OLDEST overload policy
      this.counters.droppedOverload += 1;
    }
    this.queue.push(ev);
    if (this.autoDrain) this.drain();
  }

  /** Process queued events synchronously; per-event failures are counted, never thrown. */
  drain(): void {
    while (this.queue.length > 0) {
      const ev = this.queue.shift();
      if (!ev) break;
      try {
        if (ev.kind === 'raw') this.handleRaw(ev.raw ?? '', ev.recvTs);
        else if (ev.quote) this.handleQuote(ev.quote, ev.recvTs);
        this.counters.processed += 1;
      } catch {
        this.counters.errors += 1;
      }
    }
  }

  private handleQuote(q: { symbol: string; price: number; bid?: number; ask?: number; ts: number }, recvTs: number): void {
    if (!q.symbol) return;
    const s = this.state(q.symbol);
    if (recvTs - q.ts > this.staleMs) { this.counters.droppedStale += 1; return; }
    const bid = num(q.bid);
    const ask = num(q.ask);
    const mid = bid !== null && ask !== null && bid > 0 && ask > 0 ? (bid + ask) / 2 : q.price;
    if (!(mid > 0)) return;
    if (!s.l1) s.l1 = { bid: bid ?? mid, ask: ask ?? mid, bidQty: null, askQty: null, eventTs: q.ts, recvTs };
    else {
      if (bid !== null) s.l1.bid = bid;
      if (ask !== null) s.l1.ask = ask;
      s.l1.eventTs = q.ts; s.l1.recvTs = recvTs;
    }
    this.pushSample(s, recvTs, mid);
  }

  private handleRaw(text: string, recvTs: number): void {
    let msg: { channel?: string; data?: Array<Record<string, unknown>> };
    try {
      msg = JSON.parse(text) as typeof msg;
    } catch {
      this.counters.parseErrors += 1;
      return;
    }
    if (!Array.isArray(msg.data)) return;
    if (msg.channel === 'ticker') {
      for (const row of msg.data) {
        const symbol = mapSymbol(String(row.symbol ?? ''));
        if (!symbol) continue;
        const eventTs = Date.parse(String(row.timestamp ?? ''));
        if (Number.isFinite(eventTs) && recvTs - eventTs > this.staleMs) { this.counters.droppedStale += 1; continue; }
        const bid = num(row.bid); const ask = num(row.ask);
        if (bid === null || ask === null || bid <= 0 || ask <= 0) continue;
        const s = this.state(symbol);
        s.l1 = {
          bid, ask,
          bidQty: num(row.bid_qty), askQty: num(row.ask_qty),
          eventTs: Number.isFinite(eventTs) ? eventTs : recvTs,
          recvTs,
        };
        this.pushSample(s, recvTs, (bid + ask) / 2);
        this.maybeRecord(symbol, recvTs);
      }
    } else if (msg.channel === 'trade') {
      for (const row of msg.data) {
        const symbol = mapSymbol(String(row.symbol ?? ''));
        if (!symbol) continue;
        const eventTs = Date.parse(String(row.timestamp ?? ''));
        if (Number.isFinite(eventTs) && recvTs - eventTs > this.staleMs) { this.counters.droppedStale += 1; continue; }
        const price = num(row.price); const qty = num(row.qty);
        if (price === null || qty === null) continue;
        const s = this.state(symbol);
        const id = `${symbol}:${String(row.trade_id)}`;
        if (s.seenIds.has(id)) { this.counters.duplicates += 1; continue; }
        if (s.seenIds.size >= SEEN_CAP) { s.seenIds.clear(); this.counters.dedupEvictions += 1; }
        s.seenIds.add(id);
        s.trades.push({ t: recvTs, buy: String(row.side) === 'buy', vol: qty });
        this.pruneTrades(s, recvTs);
      }
    }
  }

  private pushSample(s: SymState, t: number, mid: number): void {
    s.samples.push({ t, mid });
    // Retain 2x the longest window: with only a 10s band past 60s, any
    // symbol with a >10s no-tick gap (ticker fires on trades) loses the base
    // sample for the 60s return. 120s of samples costs a few KB per symbol.
    const cut = t - (WINDOW_MS * 2);
    while (s.samples.length > 0 && (s.samples[0] as Sample).t < cut) s.samples.shift();
    if (s.samples.length > 5_000) s.samples.splice(0, s.samples.length - 5_000);
  }

  /** Window cut uses the EVENT's receive time, never wall-clock now: replayed
   *  or delayed frames must survive their own 60s window. */
  private pruneTrades(s: SymState, t: number): void {
    const cut = t - WINDOW_MS;
    while (s.trades.length > 0 && (s.trades[0] as TradeSample).t < cut) s.trades.shift();
  }

  private retAt(s: SymState, now: number, windowMs: number): number | null {
    const target = now - windowMs;
    let base: Sample | null = null;
    for (const smp of s.samples) {
      if (smp.t <= target) base = smp; else break;
    }
    if (!base || s.samples.length < 2) return null;
    const latest = s.samples[s.samples.length - 1] as Sample;
    if (!(base.mid > 0)) return null;
    return Math.round(((latest.mid - base.mid) / base.mid) * 10_000 * 100) / 100;
  }

  features(symbol: string, at?: number): MicroFeatures | null {
    const s = this.syms.get(symbol);
    if (!s || !s.l1) return null;
    const now = at ?? s.l1.recvTs;
    const l1 = s.l1;
    const mid = (l1.bid + l1.ask) / 2;
    const spreadBps = mid > 0 ? Math.round(((l1.ask - l1.bid) / mid) * 10_000 * 100) / 100 : 0;
    const bq = l1.bidQty; const aq = l1.askQty;
    const sizesKnown = bq !== null && aq !== null && bq > 0 && aq > 0;
    const tobImbalance = sizesKnown ? Math.round((((bq as number) - (aq as number)) / ((bq as number) + (aq as number))) * 1_000) / 1_000 : null;
    const microprice = sizesKnown ? ((l1.bid * (aq as number)) + (l1.ask * (bq as number))) / ((bq as number) + (aq as number)) : null;
    const microDevBps = microprice !== null && mid > 0 ? Math.round(((microprice - mid) / mid) * 10_000 * 100) / 100 : null;

    const retBps = {
      s1: this.retAt(s, now, WINDOWS_MS[0]),
      s5: this.retAt(s, now, WINDOWS_MS[1]),
      s15: this.retAt(s, now, WINDOWS_MS[2]),
      s30: this.retAt(s, now, WINDOWS_MS[3]),
      s60: this.retAt(s, now, WINDOWS_MS[4]),
    };

    let rv60Bps: number | null = null;
    const win = s.samples.filter((x) => x.t >= now - WINDOW_MS);
    if (win.length >= 5) {
      const rets: number[] = [];
      for (let i = 1; i < win.length; i++) {
        const a = (win[i - 1] as Sample).mid; const b = (win[i] as Sample).mid;
        if (a > 0 && b > 0) rets.push(Math.log(b / a));
      }
      if (rets.length >= 2) {
        const mean = rets.reduce((x, y) => x + y, 0) / rets.length;
        const variance = rets.reduce((x, y) => x + (y - mean) * (y - mean), 0) / (rets.length - 1);
        rv60Bps = Math.round(Math.sqrt(Math.max(0, variance)) * 10_000 * 100) / 100;
      }
    }

    let trades60: MicroFeatures['trades60'] = null;
    const tWin = s.trades.filter((x) => x.t >= now - WINDOW_MS);
    if (tWin.length > 0) {
      let buy = 0; let sell = 0;
      for (const t of tWin) { if (t.buy) buy += t.vol; else sell += t.vol; }
      trades60 = {
        count: tWin.length,
        buyVol: Math.round(buy * 1e8) / 1e8,
        sellVol: Math.round(sell * 1e8) / 1e8,
        cvd: Math.round((buy - sell) * 1e8) / 1e8,
        ratePerSec: Math.round((tWin.length / 60) * 100) / 100,
      };
    }

    const ageMs = now - l1.recvTs;
    const span = s.samples.length > 0 ? now - (s.samples[0] as Sample).t : 0;
    const quality: MicroFeatures['quality'] =
      ageMs > this.staleMs ? 'STALE' : span < WINDOW_MS ? 'WARMING_UP' : 'OK';
    return {
      symbol,
      eventTs: l1.eventTs,
      recvTs: l1.recvTs,
      ageMs,
      mid: Math.round(mid * 1e8) / 1e8,
      bid: l1.bid, ask: l1.ask, spreadBps,
      bidQty: bq, askQty: aq, tobImbalance,
      microprice: microprice === null ? null : Math.round(microprice * 1e8) / 1e8,
      microDevBps,
      retBps, rv60Bps, trades60, quality,
    };
  }

  private maybeRecord(symbol: string, now: number): void {
    if (this.recordMs <= 0 || !this.onSnapshot) return;
    const last = this.lastRecordAt.get(symbol) ?? 0;
    if (now - last < this.recordMs) return;
    this.lastRecordAt.set(symbol, now);
    const f = this.features(symbol, now);
    if (!f) return;
    try { this.onSnapshot(symbol, f); this.counters.recorded += 1; } catch { this.counters.errors += 1; }
  }

  status(): Record<string, unknown> {
    const features: Record<string, MicroFeatures> = {};
    for (const symbol of this.syms.keys()) {
      const f = this.features(symbol);
      if (f) features[symbol] = f;
    }
    return {
      flags: { ...this.flags },
      executionMode: 'PAPER_ONLY',
      decisionImpact: 'NONE (shadow: stored alongside existing predictions, never consumed by the trading path)',
      feePct: this.feePct,
      roundTripCostBps: this.roundTripCostBps(),
      channels: {
        ticker: true,
        trade: this.flags.enabled,   // subscribed on the same socket when enabled
        book: false,
        ohlc: false,
      },
      l2: {
        enabled: false,
        reason: 'book channel not subscribed — multi-level OFI/depth features stay disabled rather than approximated',
      },
      queue: { pending: this.queue.length, cap: this.queueCap, ...this.counters },
      features,
    };
  }
}
