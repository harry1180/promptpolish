/**
 * BTC spot tape for the 15-minute engine — Coinbase + Kraken, tick level.
 *
 * Phase 3 of the spec asks for what the existing 5-second xchange grid cannot
 * give: price changes over 1/3/5/10/30/60 SECONDS, short-term volatility,
 * venue divergence and timestamped lead/lag. So this module taps the two
 * feeds that already exist (no second Coinbase socket, no duplicate Kraken
 * connection — both hand events to hooks they already run):
 *
 *   CryptoRuntime.observeSpot()   -> Kraken ticker ticks (stream onTick)
 *   XchangeManager.observe()      -> Coinbase CanonicalEvents
 *   CryptoRuntime raw observer    -> Kraken `trade` channel (side + size)
 *
 * Everything in SpotTape is pure and time-injected, so the return/vol/lead
 * maths is unit-testable against synthetic series before it ever sees a live
 * tick. Persistence is one row per (venue) per second with 14-day retention.
 *
 * Settlement caveat (Phase 3): Kalshi settles on CF Benchmarks BRTI, which we
 * cannot license here. Every spot number is an APPROXIMATION of the settlement
 * reference and is labeled as such everywhere it surfaces — never merged into
 * a "settlement price" field.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { CanonicalEvent } from '../xchange/types.ts';

export type Venue = 'kraken' | 'coinbase';

/** Return horizons in seconds (the spec's list). */
export const HORIZONS = [1, 3, 5, 10, 30, 60] as const;
export type Horizon = (typeof HORIZONS)[number];

export interface TapeTick {
  venue: Venue;
  /** ms epoch of the SOURCE event when the feed gives one, else arrival */
  ts: number;
  /** local arrival time (ms) — latency and staleness come from this pair */
  recvTs: number;
  bid?: number | null;
  ask?: number | null;
  last?: number | null;
}

export interface TapeTrade {
  venue: Venue;
  ts: number;
  price: number;
  qty: number;
  side: 'buy' | 'sell' | null;
}

interface QuotePoint { ts: number; recvTs: number; mid: number; bid: number | null; ask: number | null }

const RING_CAP = 2_000;      // ~65s of tick-level points per venue
/** 1-second downsampled ring: 1500 entries = 25 minutes, i.e. a whole
 *  15-minute window — the only way to measure window-scale vol at all. */
const SEC_RING_CAP = 1_500;
const TRADE_CAP = 4_000;
/** minimum return pairs before a sigma window reports anything */
const MIN_SIGMA_PAIRS = 20;
/** 1s grid length used by lead/lag and volatility (seconds) */
const GRID_WINDOW_S = 60;
/**
 * How old the CURRENT observation may be and still produce a return.
 * Without this, a feed that went silent 30s ago would still report a "60s
 * return" built from a 30s-old price and a 60s-old base — arithmetically
 * true, semantically a lie about what just happened.
 */
const FRESH_MS = 5_000;

/**
 * Log return of `price` vs the last observation at or before `now-horizon`.
 * Never looks forward, never extrapolates: if the ring has no history that
 * old, or the base is older than the horizon + slack (a feed gap), it is
 * null — a missing return is honest, a fabricated one poisons every edge.
 */
function logReturn(now: number, price: number, pts: QuotePoint[], horizonS: number): number | null {
  if (pts.length === 0 || !(price > 0)) return null;
  const cur = pts[pts.length - 1];
  if (now - cur.ts > FRESH_MS) return null; // silent feed: no return at all
  const target = now - horizonS * 1_000;
  let base: QuotePoint | null = null;
  for (let i = pts.length - 1; i >= 0; i--) {
    if (pts[i].ts <= target) { base = pts[i]; break; }
  }
  if (!base || !(base.mid > 0)) return null;
  if (now - base.ts > horizonS * 1_000 + 3_000) return null;
  return Math.log(price / base.mid);
}

/** Pearson correlation; null when either side has no variance. */
export function corr(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 8) return null;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const xa = a[i] - ma;
    const xb = b[i] - mb;
    num += xa * xb;
    da += xa * xa;
    db += xb * xb;
  }
  if (da <= 0 || db <= 0) return null;
  return num / Math.sqrt(da * db);
}

/**
 * Per-second sigma of log returns over the last `windowS` seconds from ANY
 * timestamped point list (raw ticks or the 1-second downsample). Returns are
 * normalized by sqrt(dt) so uneven spacing stays honest, and the window must
 * actually be covered by history — a 60-second sigma silently extrapolated to
 * a 15-minute contract is how a model ends up 5x away from the market.
 */
function sigmaOver(
  points: Array<{ ts: number; mid: number }>, windowS: number, now: number,
): number | null {
  if (points.length < MIN_SIGMA_PAIRS + 1) return null;
  const start = now - windowS * 1_000;
  // history must reach the START of the window (1s slack for bucketing)
  if (points[0].ts > start + 1_000) return null;
  const rs: number[] = [];
  let prev: { ts: number; mid: number } | null = null;
  for (const p of points) {
    if (p.ts < start) { prev = p; continue; }
    if (prev !== null && prev.mid > 0 && p.mid > 0) {
      const dt = (p.ts - prev.ts) / 1_000;
      if (dt >= 0.4 && dt <= 5) rs.push(Math.log(p.mid / prev.mid) / Math.sqrt(dt));
    }
    prev = p;
  }
  if (rs.length < MIN_SIGMA_PAIRS) return null;
  const mean = rs.reduce((s, v) => s + v, 0) / rs.length;
  const varr = rs.reduce((s, v) => s + (v - mean) ** 2, 0) / rs.length;
  return Math.sqrt(varr);
}

export interface SpotVenueState {
  venue: Venue;
  last: QuotePoint | null;
  spreadBps: number | null;
  /** feed age at query time — staleness gate for every signal */
  stalenessMs: number | null;
  returns: Partial<Record<Horizon, number | null>>;
  /** per-second stdev of 1s log returns over the last 60s (short-term vol) */
  sigma60: number | null;
  /**
   * Same measure over 5 and 15 minutes, from the 1-second downsampled ring.
   * null while history is still shorter than the window — a 60-second sigma
   * extrapolated to a 15-minute contract is exactly how a model ends up 5x
   * away from the market's implied vol (observed live: model p 0.998 vs book
   * 0.695).
   */
  sigma300: number | null;
  sigma900: number | null;
  /** seconds of 1s-downsampled history available right now */
  historySec: number | null;
  trades1s: number;
  qty1s: number;
  buyPct1s: number | null;
  points: number;
}

export interface SpotSnapshot {
  ts: number;
  /** both venues' mids are approximations of the settlement reference */
  kraken: SpotVenueState | null;
  coinbase: SpotVenueState | null;
  /** |mid_cb - mid_kr| in basis points — venue divergence */
  divergenceBps: number | null;
  /** which venue's recent return arrived first, and by how much (seconds) */
  leadVenue: Venue | null;
  leadLagS: number | null;
  leadCorr: number | null;
  /** true when both venues are fresh and in the same direction over 1s */
  agree1s: boolean;
}

/**
 * Tick-level tape for ONE symbol (BTC). Pure: `observe` + `snapshot(now)`.
 */
export class SpotTape {
  private readonly quotes = new Map<Venue, QuotePoint[]>();
  /** one mid per wall-clock second — lives 25 minutes, covers a whole window */
  private readonly secRing = new Map<Venue, Array<{ ts: number; mid: number }>>();
  private readonly trades: TapeTrade[] = [];

  observe(q: TapeTick): void {
    const mid = midOf(q);
    if (mid === null) return;
    let ring = this.quotes.get(q.venue);
    if (!ring) { ring = []; this.quotes.set(q.venue, ring); }
    const last = ring[ring.length - 1];
    // same instant, no new information -> keep the ring clean
    if (last && last.ts === q.ts && last.mid === mid) return;
    ring.push({
      ts: q.ts, recvTs: q.recvTs, mid,
      bid: q.bid ?? null, ask: q.ask ?? null,
    });
    while (ring.length > RING_CAP) ring.shift();

    // 1-second downsample: the LAST mid of each wall-clock second, so vol can
    // be measured across a whole 15-minute window (the tick ring holds ~65s).
    // Out-of-order stamps are ignored rather than corrupting the series.
    let sec = this.secRing.get(q.venue);
    if (!sec) { sec = []; this.secRing.set(q.venue, sec); }
    const bucket = Math.floor(q.ts / 1000) * 1000;
    const lastSec = sec[sec.length - 1];
    if (!lastSec || bucket > lastSec.ts) sec.push({ ts: bucket, mid });
    else if (bucket === lastSec.ts) lastSec.mid = mid;
    while (sec.length > SEC_RING_CAP) sec.shift();
  }

  observeTrade(t: TapeTrade): void {
    if (!(t.price > 0) || !(t.qty > 0)) return;
    this.trades.push(t);
    const cut = t.ts - 70_000;
    while (this.trades.length > 0 && this.trades[0].ts < cut) this.trades.shift();
    if (this.trades.length > TRADE_CAP) this.trades.splice(0, this.trades.length - TRADE_CAP);
  }

  mid(venue: Venue): number | null {
    const ring = this.quotes.get(venue);
    return ring && ring.length > 0 ? ring[ring.length - 1].mid : null;
  }

  /**
   * State of one venue. Always returns a state — a venue that has only
   * printed trades (no quote yet) still has flow worth reporting, with
   * `last: null` rather than a missing row.
   */
  private venueState(venue: Venue, now: number): SpotVenueState {
    const ring = this.quotes.get(venue) ?? [];
    const cur = ring[ring.length - 1] ?? null;
    if (!cur) {
      const recent = this.trades.filter((t) => t.venue === venue && t.ts >= now - 1_000);
      const buys = recent.filter((t) => t.side === 'buy').length;
      const sells = recent.filter((t) => t.side === 'sell').length;
      return {
        venue, last: null, spreadBps: null, stalenessMs: null, returns: {},
        sigma60: null, sigma300: null, sigma900: null, historySec: null,
        trades1s: recent.length,
        qty1s: recent.reduce((s, t) => s + t.qty, 0),
        buyPct1s: buys + sells > 0 ? buys / (buys + sells) : null,
        points: 0,
      };
    }
    const state: SpotVenueState = {
      venue,
      last: cur,
      spreadBps: cur.bid !== null && cur.ask !== null && cur.bid > 0 && cur.mid > 0
        ? ((cur.ask - cur.bid) / cur.mid) * 10_000
        : null,
      stalenessMs: now - cur.recvTs,
      returns: {},
      sigma60: null,
      sigma300: null,
      sigma900: null,
      historySec: null,
      trades1s: 0,
      qty1s: 0,
      buyPct1s: null,
      points: ring.length,
    };
    for (const h of HORIZONS) state.returns[h] = logReturn(now, cur.mid, ring, h);

    // three vol windows: 60s from raw ticks (fills fastest), 5 and 15 minutes
    // from the 1-second ring — null until that much history actually exists
    state.sigma60 = sigmaOver(ring, 60, now);
    const sec = this.secRing.get(venue) ?? [];
    state.historySec = sec.length >= 2 ? Math.min(now - sec[0].ts, SEC_RING_CAP * 1_000) : null;
    state.sigma300 = sigmaOver(sec, 300, now);
    state.sigma900 = sigmaOver(sec, 900, now);

    const recent = this.trades.filter((t) => t.venue === venue && t.ts >= now - 1_000);
    state.trades1s = recent.length;
    state.qty1s = recent.reduce((s, t) => s + t.qty, 0);
    const buys = recent.filter((t) => t.side === 'buy').length;
    const sells = recent.filter((t) => t.side === 'sell').length;
    state.buyPct1s = buys + sells > 0 ? buys / (buys + sells) : null;
    return state;
  }

  /** Both venues' state + divergence + lead/lag, computed at `now`. */
  snapshot(now: number): SpotSnapshot {
    const kr = this.venueState('kraken', now);
    const cb = this.venueState('coinbase', now);
    let divergenceBps: number | null = null;
    if (kr && cb && kr.last && cb.last && kr.last.mid > 0 && cb.last.mid > 0) {
      divergenceBps = (Math.abs(cb.last.mid - kr.last.mid) / kr.last.mid) * 10_000;
    }
    const lead = this.leadLag(now);
    const r1k = kr?.returns[1] ?? null;
    const r1c = cb?.returns[1] ?? null;
    const fresh = (s: SpotVenueState | null): boolean => s !== null && s.stalenessMs !== null && s.stalenessMs < 5_000;
    const agree = fresh(kr) && fresh(cb)
      && r1k !== null && r1c !== null
      && ((r1k > 0 && r1c > 0) || (r1k < 0 && r1c < 0) || (r1k === 0 && r1c === 0));
    return {
      ts: now, kraken: kr, coinbase: cb, divergenceBps,
      leadVenue: lead.venue, leadLagS: lead.lagS, leadCorr: lead.corr,
      agree1s: agree,
    };
  }

  /**
   * Which venue moves FIRST: cross-correlate 1s log returns over the last
   * 60s at lags -3..+3s. Positive lag L means `kraken` at t predicts
   * `coinbase` at t+L — Kraken leads by L seconds.
   * Returns null (no signal) below 12 matched buckets.
   */
  leadLag(now: number, maxLagS = 3): { venue: Venue | null; lagS: number | null; corr: number | null } {
    // index-aligned on the shared second grid: a skipped second is skipped
    // on BOTH sides, so lag i really means i seconds
    const g1 = this.grid('kraken', now);
    const g2 = this.grid('coinbase', now);
    const n = Math.min(g1.length, g2.length);
    const a: number[] = [];
    const b: number[] = [];
    for (let i = 1; i < n; i++) {
      const p1 = g1[i - 1], c1 = g1[i], p2 = g2[i - 1], c2 = g2[i];
      if (p1 === null || c1 === null || p2 === null || c2 === null) continue;
      if (p1 <= 0 || c1 <= 0 || p2 <= 0 || c2 <= 0) continue;
      a.push(Math.log(c1 / p1));
      b.push(Math.log(c2 / p2));
    }
    if (a.length < 12) return { venue: null, lagS: null, corr: null };
    let best = { lag: 0, c: 0 as number | null };
    for (let lag = -maxLagS; lag <= maxLagS; lag++) {
      const xa: number[] = [];
      const xb: number[] = [];
      for (let i = 0; i < a.length; i++) {
        const j = i + lag;
        if (j < 0 || j >= b.length) continue;
        xa.push(a[i]);
        xb.push(b[j]);
      }
      const c = corr(xa, xb);
      if (c !== null && (best.c === null || Math.abs(c) > Math.abs(best.c))) best = { lag, c };
    }
    if (best.c === null || Math.abs(best.c) < 0.2) return { venue: null, lagS: null, corr: best.c };
    if (best.lag === 0) return { venue: null, lagS: 0, corr: best.c };
    // lag > 0: kraken's return at t lines up with coinbase at t+lag -> kraken leads
    return {
      venue: best.lag > 0 ? 'kraken' : 'coinbase',
      lagS: Math.abs(best.lag),
      corr: best.c,
    };
  }

  /**
   * Mid at each whole-second boundary of the last `windowS` seconds — the
   * SAME absolute grid for every venue, so two venues' series are index
   * aligned (a lag of i really is i seconds). null = no data at that second.
   */
  private grid(venue: Venue, now: number, windowS = GRID_WINDOW_S): Array<number | null> {
    const ring = this.quotes.get(venue);
    const out: Array<number | null> = [];
    const start = Math.floor((now - windowS * 1_000) / 1_000) * 1_000;
    if (!ring || ring.length === 0) return out;
    let i = 0;
    for (let t = start; t <= now; t += 1_000) {
      while (i + 1 < ring.length && ring[i + 1].ts <= t) i++;
      out.push(ring[i].ts <= t ? ring[i].mid : null);
    }
    return out;
  }
}

function midOf(q: TapeTick): number | null {
  const b = q.bid ?? null;
  const a = q.ask ?? null;
  if (b !== null && a !== null && b > 0 && a > 0) return (b + a) / 2;
  if (q.last !== null && q.last !== undefined && q.last > 0) return q.last;
  if (b !== null && b > 0 && a !== null && a > 0) return (b + a) / 2;
  return null;
}

/* ------------------------------------------------------------------ */
/* persistence                                                         */
/* ------------------------------------------------------------------ */

export const SPOT_DDL = `
CREATE TABLE IF NOT EXISTS k15m_spot_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  venue TEXT NOT NULL,
  bid REAL, ask REAL, mid REAL,
  src_ts INTEGER, arrival_ts INTEGER, staleness_ms INTEGER,
  ret_1s REAL, ret_3s REAL, ret_5s REAL, ret_10s REAL, ret_30s REAL, ret_60s REAL,
  sigma_60s REAL,
  trades_1s INTEGER, trade_qty_1s REAL, buy_pct_1s REAL,
  divergence_bps REAL,
  lead_venue TEXT, lead_lag_s REAL, lead_corr REAL,
  agree_1s INTEGER,
  settlement_reference INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_k15m_spot_ts ON k15m_spot_samples(ts);
CREATE INDEX IF NOT EXISTS idx_k15m_spot_venue ON k15m_spot_samples(venue, ts);`;

export function ensureSpotTables(db: DatabaseSync): void {
  db.exec(SPOT_DDL);
}

/** One row per venue per sample. `settlement_reference=0` is the honest label. */
export function insertSpotSample(db: DatabaseSync, snap: SpotSnapshot): void {
  const stmt = db.prepare(
    `INSERT INTO k15m_spot_samples (ts, venue, bid, ask, mid, src_ts, arrival_ts, staleness_ms,
       ret_1s, ret_3s, ret_5s, ret_10s, ret_30s, ret_60s, sigma_60s,
       trades_1s, trade_qty_1s, buy_pct_1s, divergence_bps,
       lead_venue, lead_lag_s, lead_corr, agree_1s, settlement_reference)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
  );
  for (const state of [snap.kraken, snap.coinbase]) {
    if (!state || !state.last) continue;
    stmt.run(
      snap.ts, state.venue, null, null, state.last.mid,
      state.last.ts, state.last.recvTs, state.stalenessMs,
      state.returns[1] ?? null, state.returns[3] ?? null, state.returns[5] ?? null,
      state.returns[10] ?? null, state.returns[30] ?? null, state.returns[60] ?? null,
      state.sigma60,
      state.trades1s, state.qty1s, state.buyPct1s,
      snap.divergenceBps,
      snap.leadVenue, snap.leadLagS, snap.leadCorr,
      snap.agree1s ? 1 : 0,
    );
  }
}

/* ------------------------------------------------------------------ */
/* frame -> tick adapters (pure, tested against captured shapes)       */
/* ------------------------------------------------------------------ */

/** Kraken v2 `trade` channel frame -> tape trades (BTC only upstream). */
export function parseKrakenTrades(text: string, now: number): TapeTrade[] {
  let msg: {
    channel?: string;
    data?: Array<{
      symbol?: string; price?: number; qty?: number; side?: string; timestamp?: string;
    }>;
  };
  try { msg = JSON.parse(text) as typeof msg; } catch { return []; }
  if (msg.channel !== 'trade' || !Array.isArray(msg.data)) return [];
  const out: TapeTrade[] = [];
  for (const row of msg.data) {
    if (!row.symbol) continue;
    const base = row.symbol.split('/')[0]?.toUpperCase();
    const symbol = base === 'XBT' ? 'BTC' : base;
    if (symbol !== 'BTC') continue;
    const price = Number(row.price);
    const qty = Number(row.qty);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(qty) || qty <= 0) continue;
    const ts = row.timestamp ? Date.parse(row.timestamp) : now;
    out.push({
      venue: 'kraken', ts: Number.isFinite(ts) ? ts : now, price, qty,
      side: row.side === 'buy' ? 'buy' : row.side === 'sell' ? 'sell' : null,
    });
  }
  return out;
}

/** Coinbase CanonicalEvent -> tape quote (BTC only). */
export function coinbaseQuote(ev: CanonicalEvent): TapeTick | null {
  if (ev.provider !== 'coinbase' || ev.base !== 'BTC' || ev.quote !== 'USD') return null;
  if (ev.type !== 'ticker' && ev.type !== 'book_update' && ev.type !== 'book_snapshot') return null;
  if (ev.bid === null && ev.ask === null && ev.price === null) return null;
  return {
    venue: 'coinbase',
    ts: ev.exchangeTs ?? ev.recvTs,
    recvTs: ev.recvTs,
    bid: ev.bid,
    ask: ev.ask,
    last: ev.price,
  };
}

/** Coinbase CanonicalEvent -> tape trade (BTC only). */
export function coinbaseTrade(ev: CanonicalEvent): TapeTrade | null {
  if (ev.provider !== 'coinbase' || ev.base !== 'BTC' || ev.quote !== 'USD') return null;
  if (ev.type !== 'trade' || ev.price === null || ev.size === null) return null;
  return {
    venue: 'coinbase',
    ts: ev.exchangeTs ?? ev.recvTs,
    price: ev.price,
    qty: ev.size,
    side: ev.side,
  };
}

/* ------------------------------------------------------------------ */
/* runtime                                                             */
/* ------------------------------------------------------------------ */

export interface SpotConfig {
  /** CRYPTO_SPOT_TAPE=1 — record the BTC tape (default off) */
  enabled: boolean;
  /** persist cadence (ms); decisions read the in-memory tape, not the rows */
  sampleMs: number;
  /** retention for k15m_spot_samples (days) */
  retentionDays: number;
  /** staleness beyond this marks a venue unfit for signals */
  staleMs: number;
}

export function spotConfigFromEnv(env: Record<string, string | undefined> = process.env): SpotConfig {
  const enabled = env.CRYPTO_SPOT_TAPE === '1' || env.CRYPTO_SPOT_TAPE === 'true';
  const num = (v: string | undefined, d: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  return {
    enabled,
    sampleMs: num(env.CRYPTO_SPOT_SAMPLE_MS, 1_000),
    retentionDays: num(env.CRYPTO_SPOT_RETENTION_DAYS, 14),
    staleMs: num(env.CRYPTO_SPOT_STALE_MS, 5_000),
  };
}

/**
 * Owns the tape, the hooks and the persistence timer. Construction is free;
 * `start()` only arms timers when enabled — hooks can be attached either way
 * (research mode: watch without recording).
 */
export class SpotRuntime {
  readonly tape = new SpotTape();
  readonly config: SpotConfig;
  readonly stats = {
    krakenTicks: 0, coinbaseEvents: 0, krakenTrades: 0,
    samples: 0, lastSampleAt: 0, errors: 0, lastError: null as string | null,
  };
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;
  private db: DatabaseSync | null = null;

  constructor(opts: { config?: SpotConfig; now?: () => number; db?: DatabaseSync } = {}) {
    this.config = opts.config ?? spotConfigFromEnv();
    this.now = opts.now ?? Date.now;
    if (opts.db && this.config.enabled) {
      this.db = opts.db;
      ensureSpotTables(opts.db);
    }
  }

  /** Kraken ticker tick (from CryptoRuntime.observeSpot). */
  observeKraken = (q: { symbol: string; price: number; ts: number; bid?: number; ask?: number }): void => {
    if (q.symbol !== 'BTC') return;
    this.stats.krakenTicks += 1;
    const recvTs = this.now();
    this.tape.observe({
      venue: 'kraken', ts: Number.isFinite(q.ts) ? q.ts : recvTs, recvTs,
      bid: q.bid ?? null, ask: q.ask ?? null, last: q.price,
    });
  };

  /** Every Coinbase canonical event (from XchangeManager.observe). */
  observeCoinbase = (ev: CanonicalEvent): void => {
    if (ev.provider !== 'coinbase') return;
    this.stats.coinbaseEvents += 1;
    const q = coinbaseQuote(ev);
    if (q) this.tape.observe(q);
    const t = coinbaseTrade(ev);
    if (t) { this.stats.krakenTrades += 0; this.tape.observeTrade(t); }
  };

  /** Kraken raw frames (trade channel) — wired as a stream raw observer. */
  observeRaw = (text: string): void => {
    for (const t of parseKrakenTrades(text, this.now())) {
      this.stats.krakenTrades += 1;
      this.tape.observeTrade(t);
    }
  };

  start(): void {
    if (!this.config.enabled || this.timer) return;
    this.timer = setInterval(() => this.sample(), this.config.sampleMs);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** Persist the current snapshot (also callable directly in tests). */
  sample(now = this.now()): void {
    if (!this.db) return;
    try {
      const snap = this.tape.snapshot(now);
      insertSpotSample(this.db, snap);
      this.stats.samples += 1;
      this.stats.lastSampleAt = now;
      if (now % 60_000 < this.config.sampleMs) this.prune(now);
    } catch (err) {
      this.stats.errors += 1;
      this.stats.lastError = err instanceof Error ? err.message : String(err);
    }
  }

  prune(now = this.now()): void {
    if (!this.db) return;
    const cut = now - this.config.retentionDays * 86_400_000;
    try { this.db.prepare('DELETE FROM k15m_spot_samples WHERE ts < ?').run(cut); } catch { /* best effort */ }
  }

  /** Live status for the dashboard — never emits secrets. */
  status(now = this.now()): Record<string, unknown> {
    const snap = this.tape.snapshot(now);
    const venue = (s: SpotSnapshot['kraken']): unknown => s && ({
      venue: s.venue,
      mid: s.last?.mid ?? null,
      srcTs: s.last?.ts ?? null,
      stalenessMs: s.stalenessMs,
      fresh: s.stalenessMs !== null && s.stalenessMs < this.config.staleMs,
      spreadBps: s.spreadBps,
      returns: s.returns,
      sigma60: s.sigma60,
      sigma300: s.sigma300,
      sigma900: s.sigma900,
      historySec: s.historySec,
      trades1s: s.trades1s,
      qty1s: s.qty1s,
      buyPct1s: s.buyPct1s,
      points: s.points,
    });
    return {
      enabled: this.config.enabled,
      /** every spot number approximates settlement (BRTI is licensed) */
      settlementReference: 'APPROXIMATION — CF Benchmarks BRTI not licensed here',
      kraken: venue(snap.kraken),
      coinbase: venue(snap.coinbase),
      divergenceBps: snap.divergenceBps,
      leadVenue: snap.leadVenue,
      leadLagS: snap.leadLagS,
      leadCorr: snap.leadCorr,
      agree1s: snap.agree1s,
      stats: { ...this.stats },
      sampleMs: this.config.sampleMs,
    };
  }
}