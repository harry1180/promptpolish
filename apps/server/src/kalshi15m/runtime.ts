/**
 * K15mRuntime — the live 15-minute market data engine.
 *
 * Owns, for the current KXBTC15M window:
 *   discovery (REST, every 10s or at rollover) -> window row
 *   book (in-memory, snapshot + sequence-checked deltas)
 *   trade tape (every print, deduped)
 *   sampled decision tape (250ms cadence -> k15m_book_samples)
 *   feed health (latency/staleness/gaps -> k15m_feed_health)
 *
 * Design notes that matter later:
 *  - the socket delivers ~1,500 deltas/s on an active window: the BOOK is
 *    memory-resident and the SAMPLE is what gets persisted, so the tape is
 *    bounded (250ms * 900s/window ≈ 3,600 rows/window) while trades are
 *    stored individually.
 *  - gaps are never papered over: a seq jump marks the book untrusted, the
 *    runtime re-subscribes (Kalshi re-sends the snapshot) and, if the book is
 *    still untrusted a second later, falls back to the REST orderbook. Every
 *    sample records `needs_snapshot`, so a backtest can exclude those rows.
 *  - latency is measured WITHOUT pretending we share a clock:
 *      serverLag  = sending_ts_ms - ts_ms   (Kalshi's own processing delay)
 *      drift      = Date.now() - sending_ts_ms (skew + one-way, labeled so)
 *      staleness  = Date.now() - lastFrameAt   (pure local)
 */
import type { DatabaseSync } from 'node:sqlite';
import { KalshiBook, type BookMetrics, type TradePrint } from './book.ts';
import { evaluateLeadLag, leadLagConfigFromEnv, type LeadLagConfig } from './strategies.ts';
import { fairValue, impliedSigma, modelEdge } from './fairvalue.ts';
import { KalshiRest, KalshiWs, KXBTC15M, loadCreds, type AuthConfig, type KalshiCreds, type StreamSocket } from './client.ts';
import {
  eventOfMarket, msToClose, phaseAt, windowFromRest,
  type WindowBounds, type WindowPhase,
} from './lifecycle.ts';
import {
  ensureK15mTables, insertHealth, insertSample, insertSignal, insertTrade, pruneK15m,
  updateWindowQuotes, upsertWindow, type SampleFair,
} from './store.ts';

export interface K15mConfig {
  enabled: boolean;
  series: string;
  /** decision-tape cadence (ms) */
  sampleMs: number;
  /** REST discovery cadence (ms) — also the rollover detector */
  discoverMs: number;
  /** feed-health row cadence (ms) */
  healthMs: number;
  /** retention for samples/trades/health (days) */
  retentionDays: number;
  /** no frame for this long -> the feed is stale and signals must pause */
  staleMs: number;
  /** how long a re-subscribe may wait before we force a REST snapshot */
  snapshotRecoveryMs: number;
  /**
   * Which sigma the fair value prices with:
   *  'max'      (default, conservative) = max(realized, recent implied) — never
   *             more confident than the market, so an "edge" can only come from
   *             repricing lag or direction, never from under-measured vol.
   *  'implied'  = the book's own implied vol (median of recent samples),
   *             falls back to realized while the ring fills.
   *  'realized' = tape only (measured, but demonstrably understates).
   */
  sigmaSource: 'max' | 'implied' | 'realized';
  /** samples kept for the implied-sigma median (240 @250ms ≈ 60s) */
  impliedWindowSamples: number;
  /** STRATEGY A (cross-exchange lead/lag) — shadow only, off by default */
  stratA: LeadLagConfig;
  /** how often Strategy A is evaluated (ms) — 1s keeps the shadow log bounded */
  stratAEvalMs: number;
  auth: AuthConfig;
}

function bool(v: string | undefined, d: boolean): boolean {
  if (v === undefined || v === '') return d;
  return v === '1' || v.toLowerCase() === 'true';
}

function num(v: string | undefined, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
}

/** Every knob defaults to the safe value: the engine is OFF until asked. */
export function k15mConfigFromEnv(env: Record<string, string | undefined> = process.env): K15mConfig {
  return {
    enabled: bool(env.KALSHI15M_ENABLED, false),
    series: (env.KALSHI15M_SERIES ?? KXBTC15M).trim() || KXBTC15M,
    sampleMs: num(env.KALSHI15M_SAMPLE_MS, 250),
    discoverMs: num(env.KALSHI15M_DISCOVER_MS, 10_000),
    healthMs: num(env.KALSHI15M_HEALTH_MS, 60_000),
    retentionDays: num(env.KALSHI15M_RETENTION_DAYS, 14),
    staleMs: num(env.KALSHI15M_STALE_MS, 5_000),
    snapshotRecoveryMs: num(env.KALSHI15M_SNAPSHOT_RECOVERY_MS, 1_500),
    sigmaSource: env.KALSHI15M_SIGMA_SOURCE === 'implied' || env.KALSHI15M_SIGMA_SOURCE === 'realized'
      ? env.KALSHI15M_SIGMA_SOURCE
      : 'max',
    impliedWindowSamples: num(env.KALSHI15M_IMPLIED_WINDOW, 240),
    stratA: leadLagConfigFromEnv(env),
    stratAEvalMs: num(env.KALSHI15M_A_EVAL_MS, 1_000),
    auth: {
      apiKeyId: env.KALSHI_API_KEY_ID,
      privateKeyPath: env.KALSHI_PRIVATE_KEY_PATH,
    },
  };
}

export interface K15mWindow {
  eventTicker: string;
  marketTicker: string;
  bounds: WindowBounds;
  strike: number | null;
}

/** Spot reference the fair-value model reads (wired to the BTC spot tape). */
export interface SpotRef {
  spot: number | null;
  /** per-second log-return sigma from the tape */
  sigmaPerSec: number | null;
  /** which realized-sigma window produced it: 60 / 300 / 900 seconds */
  sigmaWindowSec: number | null;
  /** which venue produced the number — always surfaced, never hidden */
  approx: string | null;
  /** did both venues' 1s returns share a sign (Strategy A gate) */
  agree1s: boolean | null;
}

export interface K15mDeps {
  db: DatabaseSync;
  config?: K15mConfig;
  rest?: KalshiRest;
  creds?: KalshiCreds | null;
  socketFactory?: (url: string, headers: Record<string, string>) => StreamSocket;
  now?: () => number;
  fetchImpl?: typeof fetch;
  /**
   * settlement fair-value inputs; absent = no fair value is recorded (nulls).
   * `tauSec` (seconds to close) lets the caller pick a realized-sigma window
   * no longer than the part of the contract that has already elapsed.
   */
  spotRef?: (now: number, tauSec: number) => SpotRef;
}

export class K15mRuntime {
  readonly db: DatabaseSync;
  readonly config: K15mConfig;
  readonly rest: KalshiRest;
  readonly ws: KalshiWs;
  readonly books = new Map<string, KalshiBook>();
  current: K15mWindow | null = null;
  readonly stats = {
    discovers: 0, discoverErrors: 0, rollOvers: 0,
    samples: 0, trades: 0, duplicateTrades: 0,
    seqGaps: 0, snapshotRecoveries: 0, restRecoveries: 0,
    frames: 0, bookFrames: 0, tradeFrames: 0,
    lastFrameAt: 0, lastError: null as string | null,
    lastSnapshotAt: 0,
  };
  private readonly serverLag: number[] = [];
  /** local arrival minus Kalshi's send time: skew + one-way latency, inseparable */
  private readonly offsets: number[] = [];
  private lastDiscoverAt = 0;
  private lastSampleAt = 0;
  private lastHealthAt = 0;
  private lastPruneAt = 0;
  private lastRecoveryAt = 0;
  private phase: WindowPhase | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;
  private readonly spotRef: ((now: number, tauSec: number) => SpotRef) | undefined;
  /** recent usable book-implied sigmas: the market's own vol estimate */
  private readonly impliedRing: number[] = [];
  /** (ts, spot, mid) history for Strategy A's repricing-lag lookback */
  private readonly lagRing: Array<{ ts: number; spot: number | null; mid: number | null; agree: boolean | null }> = [];
  private lastStratAEvalAt = 0;
  readonly stratAStats = { evaluated: 0, traded: 0, skipped: 0, lastVerdict: null as string | null, lastNetPp: null as number | null };
  private started = false;

  constructor(deps: K15mDeps) {
    this.db = deps.db;
    this.now = deps.now ?? Date.now;
    this.spotRef = deps.spotRef;
    this.config = deps.config ?? k15mConfigFromEnv();
    ensureK15mTables(this.db);
    const creds = deps.creds !== undefined ? deps.creds : loadCreds(this.config.auth);
    this.rest = deps.rest ?? new KalshiRest({ creds, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) });
    this.ws = new KalshiWs({
      creds,
      markets: () => [...this.books.keys()],
      handlers: {
        onBook: (f) => this.onBook(f),
        onTrade: (f) => this.onTrade(f),
        onOther: () => { /* ticker/lifecycle frames: ignored on purpose */ },
        // the client subscribes trade + the current market list itself on open;
        // subscribing twice would deliver two snapshots per reconnect
        onConnect: () => { this.stats.lastError = null; },
        onDisconnect: (reason) => { if (reason === 'no_credentials') this.stats.lastError = reason; },
      },
      ...(deps.socketFactory ? { socketFactory: deps.socketFactory } : {}),
      now: this.now,
    });
  }

  /* ---------------------------------------------------------------- */
  /* lifecycle                                                         */
  /* ---------------------------------------------------------------- */

  start(): void {
    if (this.started) return;
    this.started = true;
    if (!this.config.enabled) return;
    // discovery first: without a current window nothing else can run
    void this.discover();
    this.ws.start();
    // the scheduler runs at the SAMPLE cadence (every gate is elapsed-time
    // based, so a fixed 1s tick silently stretched 250ms samples to 1s —
    // measured: 44 samples in 45s before this line existed)
    const tickMs = Math.max(50, Math.min(1_000, this.config.sampleMs));
    this.timer = setInterval(() => this.tick(), tickMs);
  }

  stop(): void {
    this.started = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.ws.stop();
  }

  /** One scheduler pass. Public and synchronous so tests can drive time. */
  tick(now = this.now()): void {
    if (!this.config.enabled) return;
    if (!this.current || now - this.lastDiscoverAt >= this.config.discoverMs
      || now >= this.current.bounds.closeTs) {
      void this.discover(now);
    }
    if (!this.current) return;
    const bounds = this.current.bounds;
    const phase = phaseAt(bounds, now);

    if (phase !== this.phase) {
      this.phase = phase;
      upsertWindow(this.db, {
        eventTicker: this.current.eventTicker,
        marketTicker: this.current.marketTicker,
        openTs: bounds.openTs, closeTs: bounds.closeTs, expireTs: bounds.expireTs,
        strike: this.current.strike, status: phase, phase,
        result: null, rules: null,
        firstSeenTs: now, updatedTs: now,
      });
    }

    const book = this.books.get(this.current.marketTicker);
    if (book && now - this.lastSampleAt >= this.config.sampleMs) {
      this.lastSampleAt = now;
      if (!book.isEmpty) {
        const m = book.metrics({ now });
        // computed ONCE: it feeds both the row and Strategy A (and pushes the
        // lag ring exactly once per sample)
        const fair = this.computeFair(now, bounds, m);
        insertSample(this.db, {
          ts: now,
          marketTicker: this.current.marketTicker,
          eventTicker: this.current.eventTicker,
          phase, msToClose: msToClose(bounds, now),
          metrics: m,
          spotMid: this.spotMid(),
          arrivalLatencyMs: this.medianServerLag(),
          stalenessMs: this.stats.lastFrameAt ? now - this.stats.lastFrameAt : null,
          clockDriftMs: this.serverLagOffset(),
          needsSnapshot: book.needsSnapshot,
          fair,
        });
        book.endSampleWindow();
        this.stats.samples += 1;
        if (this.config.stratA.enabled) this.runStrategyA(now, bounds, m, fair);
      }
    }

    if (now - this.lastHealthAt >= this.config.healthMs) {
      this.writeHealth(now, phase, book);
    }
    if (now - this.lastPruneAt >= 3_600_000) {
      this.lastPruneAt = now;
      pruneK15m(this.db, this.config.retentionDays, now);
    }
  }

  /* ---------------------------------------------------------------- */
  /* discovery + rollover                                              */
  /* ---------------------------------------------------------------- */

  async discover(now = this.now()): Promise<void> {
    this.lastDiscoverAt = now;
    this.stats.discovers += 1;
    try {
      const m = await this.rest.openMarket(this.config.series);
      if (!m) return;
      const bounds = windowFromRest(m.ticker, m);
      if (!bounds) return;
      const eventTicker = eventOfMarket(m.ticker);
      const strike = typeof m.floor_strike === 'number' ? m.floor_strike : null;
      const known = this.current?.eventTicker === eventTicker;
      if (!known) {
        if (this.current) this.stats.rollOvers += 1;
        this.current = { eventTicker, marketTicker: m.ticker, bounds, strike };
        this.books.set(m.ticker, this.books.get(m.ticker) ?? new KalshiBook(m.ticker));
        // drop books of fully expired windows so memory tracks the clock
        for (const t of [...this.books.keys()]) {
          if (t !== m.ticker && this.isExpired(t, now)) this.books.delete(t);
        }
        // cadence clocks restart with the window: the first sample and the first
        // health row land one interval after rollover, not immediately
        this.lastSampleAt = now;
        this.lastHealthAt = now;
        upsertWindow(this.db, {
          eventTicker, marketTicker: m.ticker,
          openTs: bounds.openTs, closeTs: bounds.closeTs, expireTs: bounds.expireTs,
          strike, status: m.status ?? null, phase: phaseAt(bounds, now),
          result: m.result ? String(m.result) : null,
          rules: m.rules_primary ?? null,
          firstSeenTs: now, updatedTs: now,
        });
        this.ws.subscribeMarkets();
      }
      updateWindowQuotes(this.db, eventTicker, {
        yesBid: m.yes_bid_dollars !== undefined ? Number(m.yes_bid_dollars) : null,
        yesAsk: m.yes_ask_dollars !== undefined ? Number(m.yes_ask_dollars) : null,
        volume: m.volume_fp !== undefined ? Number(m.volume_fp) : null,
        openInterest: m.open_interest_fp !== undefined ? Number(m.open_interest_fp) : null,
      }, now);
    } catch (err) {
      this.stats.discoverErrors += 1;
      this.stats.lastError = err instanceof Error ? err.message : String(err);
    }
  }

  private isExpired(marketTicker: string, now: number): boolean {
    const w = this.db.prepare('SELECT close_ts, expire_ts FROM k15m_windows WHERE market_ticker = ?')
      .get(marketTicker) as { close_ts: number; expire_ts: number | null } | undefined;
    if (!w) return false;
    return now >= (w.expire_ts ?? w.close_ts);
  }

  /* ---------------------------------------------------------------- */
  /* feed                                                              */
  /* ---------------------------------------------------------------- */

  private onBook(frame: Record<string, unknown>): void {
    this.stats.frames += 1;
    this.stats.bookFrames += 1;
    this.stats.lastFrameAt = this.now();
    const msg = frame.msg as Record<string, unknown> | undefined;
    if (!msg || typeof msg.market_ticker !== 'string') return;
    const ticker = msg.market_ticker;
    let book = this.books.get(ticker);
    // books for markets we have not discovered yet are ignored on purpose:
    // discovery decides what we follow, the feed never expands the set
    if (!book) {
      if (this.current && ticker === this.current.marketTicker) {
        book = new KalshiBook(ticker);
        this.books.set(ticker, book);
      } else return;
    }
    this.noteServerLag(frame, msg);

    if (frame.type === 'orderbook_snapshot') {
      const res = book.applySnapshot({ ...msg, sid: frame.sid, seq: frame.seq } as never, this.now());
      if (res.applied) this.stats.lastSnapshotAt = this.now();
      return;
    }
    const res = book.applyDelta({ ...msg, sid: frame.sid, seq: frame.seq } as never);
    if (res.gap) {
      this.stats.seqGaps += 1;
      this.recoverSnapshot(ticker, this.now());
    } else if (res.reason === 'awaiting_snapshot' || res.reason === 'sid_changed') {
      this.recoverSnapshot(ticker, this.now());
    }
  }

  /** Re-subscribe (snapshot re-delivery), REST book as a stopgap if still blind. */
  private recoverSnapshot(ticker: string, now: number): void {
    if (now - this.lastRecoveryAt < this.config.snapshotRecoveryMs) return;
    this.lastRecoveryAt = now;
    this.ws.refreshSnapshot();
    void (async () => {
      try {
        const ob = await this.rest.orderbook(ticker);
        const fp = ob.orderbook_fp;
        const book = this.books.get(ticker);
        if (!book || !fp) return;
        if (!book.needsSnapshot) return; // re-subscribe won the race
        book.applySnapshot({
          market_ticker: ticker,
          yes_dollars_fp: fp.yes_dollars ?? [],
          no_dollars_fp: fp.no_dollars ?? [],
        } as never, this.now());
        if (!book.needsSnapshot) this.stats.restRecoveries += 1;
      } catch (err) {
        this.stats.lastError = err instanceof Error ? err.message : String(err);
      }
    })();
  }

  private onTrade(frame: Record<string, unknown>): void {
    this.stats.frames += 1;
    this.stats.tradeFrames += 1;
    this.stats.lastFrameAt = this.now();
    const msg = frame.msg as Record<string, unknown> | undefined;
    if (!msg || typeof msg.market_ticker !== 'string') return;
    const ticker = msg.market_ticker;
    // the `trade` channel is GLOBAL: everything but our markets is dropped here
    if (!this.books.has(ticker) && ticker !== this.current?.marketTicker) return;
    const tradeId = String(msg.trade_id ?? '');
    if (!tradeId) return;
    this.noteServerLag(frame, msg);
    const print: TradePrint = {
      tradeId,
      tsMs: Number(msg.ts_ms ?? this.now()),
      yesPrice: Number(msg.yes_price_dollars ?? 0),
      noPrice: Number(msg.no_price_dollars ?? 0),
      qty: Number(msg.count_fp ?? 0),
      takerSide: String(msg.taker_side ?? ''),
      takerBookSide: String(msg.taker_book_side ?? ''),
    };
    if (!(print.yesPrice > 0) || !(print.qty > 0)) return;
    const inserted = insertTrade(this.db, {
      tradeId, tsMs: print.tsMs, marketTicker: ticker,
      eventTicker: eventOfMarket(ticker),
      yesPrice: print.yesPrice, noPrice: print.noPrice, qty: print.qty,
      takerSide: print.takerSide, takerBookSide: print.takerBookSide,
      seq: typeof frame.seq === 'number' ? frame.seq : null,
    }, this.now());
    if (inserted) this.stats.trades += 1;
    else this.stats.duplicateTrades += 1;
    const book = this.books.get(ticker);
    if (book && inserted) book.addTrade(print, this.now());
  }

  /* ---------------------------------------------------------------- */
  /* measurement helpers                                               */
  /* ---------------------------------------------------------------- */

  /** Kalshi's own processing delay: send timestamp minus event timestamp. */
  private noteServerLag(frame: Record<string, unknown>, msg: Record<string, unknown>): void {
    const local = this.now();
    const sent = Number(frame.sending_ts_ms);
    const ev = Number(msg.ts_ms);
    if (Number.isFinite(sent)) {
      const off = local - sent;
      if (Math.abs(off) < 3_600_000) { // an hour of "latency" is clock junk
        this.offsets.push(off);
        if (this.offsets.length > 400) this.offsets.shift();
      }
    }
    if (!Number.isFinite(sent) || !Number.isFinite(ev) || ev <= 0 || sent <= ev) return;
    const lag = sent - ev;
    if (lag > 60_000) return; // clock junk, not latency
    this.serverLag.push(lag);
    if (this.serverLag.length > 400) this.serverLag.shift();
  }

  /**
   * Median local-arrival minus Kalshi-send timestamp. This BLENDS clock skew
   * and one-way latency — they cannot be separated without a shared clock, so
   * the dashboard labels it "apparent offset", never "latency".
   */
  private serverLagOffset(): number | null {
    if (this.offsets.length === 0) return null;
    const sorted = [...this.offsets].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  /** Median Kalshi server processing delay (send minus event time). */
  private medianServerLag(): number | null {
    if (this.serverLag.length === 0) return null;
    const sorted = [...this.serverLag].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  private spotMid(): number | null {
    try {
      const row = this.db.prepare('SELECT price FROM market_quotes WHERE symbol = ?').get('BTC') as
        | { price: number } | undefined;
      return row && Number.isFinite(row.price) ? row.price : null;
    } catch {
      return null; // market_quotes may not exist yet (fresh DB, workers off)
    }
  }

  /**
   * Settlement fair value recorded with each sample: model probability from
   * the APPROXIMATED spot + the official strike + tape sigma, stored beside
   * the book's implied mid and the gap between them (edge_pp). Returns null
   * when no spot source is wired — the row keeps NULLs instead of guesses.
   * The midpoint here is comparison-only: it is never a fill price.
   */
  private computeFair(now: number, bounds: WindowBounds, m: BookMetrics): SampleFair | null {
    if (!this.spotRef) return null;
    const strike = this.current?.strike ?? null;
    const tauSec = msToClose(bounds, now) / 1_000;
    const ref = this.spotRef(now, tauSec);
    const impliedMid = m.bestBid !== null && m.bestAsk !== null
      ? (m.bestBid + m.bestAsk) / 2
      : null;
    // the book's own vol estimate for this instant, then the recent median
    // (per-sample implied is jumpy: it dies whenever the mid sits at ~0.5)
    const sigmaImplied = impliedSigma(impliedMid, ref.spot, strike, tauSec);
    if (sigmaImplied !== null) {
      this.impliedRing.push(sigmaImplied);
      while (this.impliedRing.length > this.config.impliedWindowSamples) this.impliedRing.shift();
    }
    const impliedMedian = this.impliedMedian();
    const chosen = this.chooseSigma(ref.sigmaPerSec, impliedMedian);

    // Strategy A lookback history: what spot, the YES mid and the venue
    // agreement looked like at this instant (bounded ring)
    this.lagRing.push({
      ts: now, spot: ref.spot, mid: impliedMid, agree: ref.agree1s,
    });
    while (this.lagRing.length > 600) this.lagRing.shift();

    const fv = fairValue({
      spot: ref.spot,
      strike,
      tauSec,
      sigmaPerSec: chosen.sigma,
      approx: ref.approx,
    });
    const edge = modelEdge(fv.pYes, impliedMid);
    return {
      spot: ref.spot,
      sigma: chosen.sigma,
      pYes: fv.pYes,
      impliedMid,
      edgePp: edge === null ? null : edge * 100,
      reason: fv.reason ?? null,
      approx: ref.approx,
      // calibration: what sigma the BOOK already believes, next to ours
      sigmaImplied,
      sigmaWindowSec: ref.sigmaWindowSec,
      sigmaRealized: ref.sigmaPerSec,
      sigmaSource: chosen.source,
    };
  }

  /** Median of the recent usable implied sigmas (null while the ring is empty). */
  private impliedMedian(): number | null {
    if (this.impliedRing.length === 0) return null;
    const sorted = [...this.impliedRing].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  private chooseSigma(
    realized: number | null, implied: number | null,
  ): { sigma: number | null; source: string | null } {
    return chooseSigma(this.config.sigmaSource, realized, implied);
  }

  /**
   * Realized-vs-implied vol diagnostics over the recent samples — the number
   * that decides whether an `edge_pp` is information or a vol artefact.
   * Bounded (one indexed read of at most `limit` rows); medians are computed
   * in JS because SQLite has none.
   */
  calibration(limit = 2_000): Record<string, unknown> {
    const rows = this.db.prepare(
      `SELECT fair_sigma, sigma_realized, sigma_implied, edge_pp, fair_sigma_source, phase
         FROM k15m_book_samples
        WHERE fair_sigma IS NOT NULL OR sigma_implied IS NOT NULL
        ORDER BY id DESC LIMIT ?`,
    ).all(Math.max(1, Math.min(20_000, limit))) as unknown as Array<Record<string, unknown>>;
    const nums = (key: string): number[] =>
      rows.map((r) => r[key]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    const median = (xs: number[]): number | null => {
      if (xs.length === 0) return null;
      const s = [...xs].sort((a, b) => a - b);
      const mid = s.length >> 1;
      return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
    };
    const realized = nums('sigma_realized');
    const implied = nums('sigma_implied');
    const edges = nums('edge_pp');
    const ratios: number[] = [];
    for (const r of rows) {
      const rl = r.sigma_realized;
      const im = r.sigma_implied;
      if (typeof rl === 'number' && typeof im === 'number' && rl > 0 && im > 0) ratios.push(im / rl);
    }
    const absEdges = edges.map(Math.abs).sort((a, b) => a - b);
    const sources: Record<string, number> = {};
    for (const r of rows) {
      const s = typeof r.fair_sigma_source === 'string' ? r.fair_sigma_source : 'null';
      sources[s] = (sources[s] ?? 0) + 1;
    }
    return {
      window: { rows: rows.length, limit },
      config: {
        sigmaSource: this.config.sigmaSource,
        impliedWindowSamples: this.config.impliedWindowSamples,
        impliedRing: this.impliedRing.length,
      },
      sigma: {
        realizedMedian: median(realized),
        impliedMedian: median(implied),
        impliedOverRealizedMedian: median(ratios),
        pairedSamples: ratios.length,
      },
      edge: {
        medianPp: median(edges),
        p95AbsPp: absEdges.length ? absEdges[Math.min(absEdges.length - 1, Math.floor(absEdges.length * 0.95))] : null,
        shareOver2Pp: edges.length ? edges.filter((e) => Math.abs(e) > 2).length / edges.length : null,
      },
      sources,
      note: 'edge_pp is information ONLY while sigma is calibrated: compare '
        + 'impliedOverRealizedMedian with 1 before believing any edge.',
    };
  }

  /**
   * STRATEGY A (shadow): evaluate the cross-exchange lead/lag signal once per
   * `stratAEvalMs` and record EVERY outcome with its reasons — taken and
   * rejected alike, so the shadow log can be scored for false negatives too.
   * There is no execution path from here: no order, no position, no broker.
   */
  private runStrategyA(
    now: number, bounds: WindowBounds, m: BookMetrics, fair: SampleFair | null,
  ): void {
    const cfg = this.config.stratA;
    if (!this.current) return;
    if (now - this.lastStratAEvalAt < this.config.stratAEvalMs) return;
    this.lastStratAEvalAt = now;

    // what spot / YES mid / venue agreement looked like `lagSec` ago
    const target = now - cfg.lagSec * 1_000;
    let past: { spot: number | null; mid: number | null } | null = null;
    for (let i = this.lagRing.length - 1; i >= 0; i--) {
      if (this.lagRing[i].ts <= target) { past = this.lagRing[i]; break; }
    }
    const last = this.lagRing[this.lagRing.length - 1] ?? null;
    const tauSec = msToClose(bounds, now) / 1_000;
    const spotNow = last?.spot ?? fair?.spot ?? null;
    const spotLag = past?.spot ?? null;
    const midNow = last?.mid ?? fair?.impliedMid ?? null;
    const midLag = past?.mid ?? null;

    const verdict = evaluateLeadLag({
      cfg, now, tauSec,
      strike: this.current.strike,
      spotNow, spotLag, midNow, midLag,
      venuesAgree: last?.agree === true,
      sigmaPerSec: fair?.sigma ?? null,
      yesBid: m.bestBid, yesAsk: m.bestAsk,
    });
    const moveBps = spotNow !== null && spotLag !== null && spotLag > 0
      ? Math.log(spotNow / spotLag) * 10_000
      : null;

    insertSignal(this.db, {
      ts: now,
      marketTicker: this.current.marketTicker,
      eventTicker: this.current.eventTicker,
      strategy: verdict.strategy,
      verdict: verdict.verdict,
      side: verdict.side,
      expectedMovePp: verdict.expectedMovePp,
      repricedPp: verdict.repricedPp,
      remainingPp: verdict.remainingPp,
      costPp: verdict.costPp,
      netPp: verdict.netPp,
      tauSec,
      strike: this.current.strike,
      sigma: fair?.sigma ?? null,
      spotNow, spotLag, midNow, midLag, moveBps,
      agree: last?.agree ?? null,
      skipReason: verdict.skipReason,
      reasons: verdict.reasons.join(' | '),
      phase: phaseAt(bounds, now),
    });
    this.stratAStats.evaluated += 1;
    this.stratAStats.lastVerdict = verdict.verdict;
    this.stratAStats.lastNetPp = verdict.netPp;
    if (verdict.verdict === 'TRADE') this.stratAStats.traded += 1;
    else this.stratAStats.skipped += 1;
  }

  private writeHealth(now: number, phase: WindowPhase, book: KalshiBook | undefined): void {
    this.lastHealthAt = now;
    const sorted = [...this.serverLag].sort((a, b) => a - b);
    const p = (q: number): number | null =>
      sorted.length > 0 ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null;
    const staleness = this.stats.lastFrameAt > 0 ? now - this.stats.lastFrameAt : null;
    insertHealth(this.db, {
      ts: now,
      marketTicker: this.current?.marketTicker ?? null,
      phase,
      frames: this.stats.frames,
      bookFrames: this.stats.bookFrames,
      tradeFrames: this.stats.tradeFrames,
      seqGaps: this.stats.seqGaps,
      reconnects: this.ws.stats.reconnects,
      errors: this.ws.stats.errors,
      lastFrameAgeMs: staleness,
      latencyP50Ms: p(0.5),
      latencyP95Ms: p(0.95),
      clockDriftMs: this.serverLagOffset(),
      stale: staleness === null || staleness > this.config.staleMs,
      bookTrusted: book ? !book.needsSnapshot : false,
    });
    // per-interval counters roll over with the row they describe
    this.stats.frames = 0;
    this.stats.bookFrames = 0;
    this.stats.tradeFrames = 0;
    this.stats.seqGaps = 0;
  }

  /** Status block for the API/dashboard. Never emits secrets. */
  status(now = this.now()): Record<string, unknown> {
    const book = this.current ? this.books.get(this.current.marketTicker) : undefined;
    const m = book && !book.isEmpty ? book.metrics({ now }) : null;
    return {
      enabled: this.config.enabled,
      series: this.config.series,
      authenticated: this.ws.stats.authed || Boolean(this.ws.live),
      socket: {
        live: this.ws.live, connects: this.ws.stats.connects,
        reconnects: this.ws.stats.reconnects, errors: this.ws.stats.errors,
        lastError: this.ws.stats.lastError,
        framesSeen: this.stats.frames + this.stats.bookFrames + this.stats.tradeFrames,
        lastFrameAt: this.stats.lastFrameAt || null,
        stalenessMs: this.stats.lastFrameAt ? now - this.stats.lastFrameAt : null,
        stale: this.stats.lastFrameAt > 0 && now - this.stats.lastFrameAt > this.config.staleMs,
      },
      window: this.current
        ? {
            eventTicker: this.current.eventTicker,
            marketTicker: this.current.marketTicker,
            openTs: this.current.bounds.openTs,
            closeTs: this.current.bounds.closeTs,
            expireTs: this.current.bounds.expireTs,
            strike: this.current.strike,
            phase: phaseAt(this.current.bounds, now),
            msToClose: msToClose(this.current.bounds, now),
            source: this.current.bounds.source,
          }
        : null,
      book: m ? { ...m, trusted: !book?.needsSnapshot, seq: book?.seq ?? null, levels: m.levels } : null,
      // model vs book, comparison only — mid is never offered as a fill
      fairValue: this.current && m
        ? { reference: 'APPROXIMATION' as const, ...this.computeFair(now, this.current.bounds, m) }
        : null,
      counters: {
        discovers: this.stats.discovers, discoverErrors: this.stats.discoverErrors,
        rollOvers: this.stats.rollOvers, samples: this.stats.samples,
        trades: this.stats.trades, duplicateTrades: this.stats.duplicateTrades,
        seqGaps: this.stats.seqGaps, snapshotRecoveries: this.stats.snapshotRecoveries,
        restRecoveries: this.stats.restRecoveries,
      },
      cadence: {
        sampleMs: this.config.sampleMs, discoverMs: this.config.discoverMs,
        healthMs: this.config.healthMs, staleMs: this.config.staleMs,
      },
      /** STRATEGY A: shadow only — no order is ever placed from this engine */
      strategyA: {
        enabled: this.config.stratA.enabled,
        mode: 'SHADOW',
        cfg: this.config.stratA,
        evalMs: this.config.stratAEvalMs,
        lagRing: this.lagRing.length,
        ...this.stratAStats,
      },
      /** sigma policy in force — an edge is only meaningful with this in view */
      sigmaPolicy: {
        source: this.config.sigmaSource,
        impliedWindowSamples: this.config.impliedWindowSamples,
        impliedRing: this.impliedRing.length,
      },
      lastError: this.stats.lastError,
    };
  }
}

/**
 * The sigma the fair value prices with (K15mConfig.sigmaSource).
 *
 * 'max' is the shipped default: never MORE confident than the market, so a
 * positive edge can only come from repricing lag or direction — a vol
 * disagreement cannot manufacture one, which is exactly what made the very
 * first live sample claim a +30pp edge on a 5x-understated realized vol.
 * Pure function: exported so the policy is unit-tested without a runtime.
 */
export function chooseSigma(
  mode: 'max' | 'implied' | 'realized',
  realized: number | null,
  implied: number | null,
): { sigma: number | null; source: string | null } {
  if (mode === 'realized') {
    return { sigma: realized, source: realized !== null ? 'realized' : 'none' };
  }
  if (mode === 'implied') {
    if (implied !== null) return { sigma: implied, source: 'implied' };
    return { sigma: realized, source: realized !== null ? 'realized' : 'none' };
  }
  if (realized === null && implied === null) return { sigma: null, source: 'none' };
  if (realized === null) return { sigma: implied, source: 'implied' };
  if (implied === null) return { sigma: realized, source: 'realized' };
  return realized >= implied
    ? { sigma: realized, source: 'max/realized' }
    : { sigma: implied, source: 'max/implied' };
}