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
import {
  evaluateLeadLag, evaluateMaker, evaluateMomentum, evaluateMicro, evaluateLateFav,
  evaluatePanicFade, lateFavConfigFromEnv, leadLagConfigFromEnv, makerConfigFromEnv,
  microConfigFromEnv, momentumConfigFromEnv, panicConfigFromEnv,
  type LateFavConfig, type LeadLagConfig, type MakerConfig, type MicroConfig,
  type MomentumConfig, type PanicConfig, type StrategyVerdict,
} from './strategies.ts';
import { bookSpotDisagree, fairValue, impliedSigma, modelEdge } from './fairvalue.ts';
import { PaperEngine, paperConfigFromEnv, type PaperBookView, type PaperConfig } from './paper.ts';
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
  /** B microstructure / C panic-fade / D momentum / E late favorites / F maker */
  stratB: MicroConfig;
  stratC: PanicConfig;
  stratD: MomentumConfig;
  stratE: LateFavConfig;
  stratF: MakerConfig;
  /** how often every shadow strategy is evaluated (ms) — 1s bounds the log */
  stratAEvalMs: number;
  /** how often settled windows are collected (ms) — outcomes feed the backtest */
  outcomeMs: number;
  /** paper execution layer: state machine + risk limits, simulated fills only */
  paper: PaperConfig;
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
    stratB: microConfigFromEnv(env),
    stratC: panicConfigFromEnv(env),
    stratD: momentumConfigFromEnv(env),
    stratE: lateFavConfigFromEnv(env),
    stratF: makerConfigFromEnv(env),
    stratAEvalMs: num(env.KALSHI15M_A_EVAL_MS, 1_000),
    outcomeMs: num(env.KALSHI15M_OUTCOME_MS, 60_000),
    paper: paperConfigFromEnv(env),
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
    outcomes: 0, outcomeErrors: 0,
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
  private lastOutcomeAt = 0;
  /** local arrival time of the newest book frame — the paper staleness gate */
  private lastBookFrameAt = 0;
  /** paper execution: built always (tables ready), actives only when enabled */
  readonly paper: PaperEngine;
  readonly stratAStats = { evaluated: 0, traded: 0, skipped: 0, lastVerdict: null as string | null, lastNetPp: null as number | null };
  /** per-strategy shadow counters (B..F; A keeps stratAStats for compatibility) */
  readonly shadowByStrategy: Record<string, { evaluated: number; traded: number }> = {};
  private started = false;

  constructor(deps: K15mDeps) {
    this.db = deps.db;
    this.now = deps.now ?? Date.now;
    this.spotRef = deps.spotRef;
    this.config = deps.config ?? k15mConfigFromEnv();
    ensureK15mTables(this.db);
    // paper engine: tables are created even while disabled so enabling it is
    // a config flip, never a migration on a live feed
    this.paper = new PaperEngine(this.db, this.config.paper);
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
        this.runShadowStrategies(now, bounds, m, fair);
      }
    }

    if (now - this.lastHealthAt >= this.config.healthMs) {
      this.writeHealth(now, phase, book);
    }
    if (now - this.lastOutcomeAt >= this.config.outcomeMs) {
      void this.collectOutcomes(now);
    }
    if (this.config.paper.enabled) {
      // Phase 11: a silent feed HALTS paper entries automatically (frames
      // returning clear it); a frame can stop while the book still answers,
      // so freshness is measured from the last book frame, not from the book.
      const silent = this.stats.lastFrameAt === 0
        || now - this.stats.lastFrameAt > this.config.paper.haltStaleMs;
      this.paper.setFeedOk(!silent, 'feed_stale');
      this.runPaperManage(now, book);
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
    this.lastBookFrameAt = this.now();
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
    // a material book-vs-spot direction disagreement refuses the model outright:
    // no fair value is better than a confident number from disagreeing inputs
    const chosen = bookSpotDisagree(impliedMid, ref.spot, strike)
      ? { sigma: null, source: 'disagreement' }
      : this.chooseSigma(ref.sigmaPerSec, impliedMedian);

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
   * Collect SETTLED windows for this series: the official result plus the
   * BRTI value Kalshi resolved on (`expiration_value`). Outcomes are what
   * make hold-to-settlement scoring — and any honest backtest — possible;
   * without them only round trips can be measured. A failure never disturbs
   * the feed: it is counted and retried next interval.
   */
  async collectOutcomes(now = this.now()): Promise<number> {
    this.lastOutcomeAt = now;
    try {
      const body = await this.rest.markets(this.config.series, 'settled', 25);
      let recorded = 0;
      for (const m of body.markets ?? []) {
        const eventTicker = eventOfMarket(m.ticker ?? '');
        if (!eventTicker) continue;
        const derived = deriveSettlement(m);
        if (!derived) continue;
        const res = this.db.prepare(
          `UPDATE k15m_windows SET settled_result = ?, settle_value = ?, settle_note = ?,
              settled_at = ?, status = 'settled', phase = 'EXPIRED', updated_ts = ?
            WHERE event_ticker = ? AND (settled_result IS NULL OR settled_result = '')`,
        ).run(
          derived.result, derived.settleValue, derived.source, now, now, eventTicker,
        );
        if (Number(res.changes) > 0) {
          recorded += 1;
          this.stats.outcomes += 1;
          // RECONCILE: close any paper position that rode this window to settlement
          for (const p of this.paper.openPositions()) {
            if (p.eventTicker === eventTicker) this.paper.settle(p, derived.result, now);
          }
        }
      }
      return recorded;
    } catch (err) {
      this.stats.outcomeErrors += 1;
      this.stats.lastError = err instanceof Error ? err.message : String(err);
      return 0;
    }
  }

  /** Executable view of the current book for the paper engine (never midpoints). */
  private paperBook(now: number, book: KalshiBook | undefined): PaperBookView | null {
    if (!book || book.needsSnapshot || book.isEmpty) return null;
    const m = book.metrics({ now });
    if (m.bestBid === null || m.bestAsk === null || !(m.bestBid > 0) || !(m.bestAsk > m.bestBid)) {
      return null; // no two-sided market -> nothing is executable
    }
    return {
      yesBid: m.bestBid, yesAsk: m.bestAsk,
      // resting size at the touch, converted to dollars: the fill cap is the
      // displayed depth, not an assumed deep book
      depthBidDollars: m.bestBidSize * m.bestBid,
      depthAskDollars: m.bestAskSize * m.bestAsk,
      ageMs: this.lastBookFrameAt > 0 ? Math.max(0, now - this.lastBookFrameAt) : 999_999,
    };
  }

  /** MANAGE: every open paper position against the live book, each tick. */
  private runPaperManage(now: number, book: KalshiBook | undefined): void {
    const pb = this.paperBook(now, book);
    if (!pb) return;
    for (const pos of this.paper.openPositions()) this.paper.manage(pos, pb, now);
  }

  /* ---------------------------------------------------------------- */
  /* Shadow strategies: A..F, one pass per eval window                 */
  /* ---------------------------------------------------------------- */

  /** The lagRing entry at or before `targetTs` (null = not enough history). */
  private lagAt(targetTs: number): { ts: number; spot: number | null; mid: number | null; agree: boolean | null } | null {
    for (let i = this.lagRing.length - 1; i >= 0; i--) {
      if (this.lagRing[i].ts <= targetTs) return this.lagRing[i];
    }
    return null;
  }

  /** Persist one shadow verdict and bump the counters. No execution path. */
  private recordSignal(
    v: StrategyVerdict, now: number, bounds: WindowBounds,
    ctx: { tauSec: number; strike: number | null; sigma: number | null;
           spotNow: number | null; spotLag: number | null;
           midNow: number | null; midLag: number | null; moveBps: number | null;
           agree: boolean | null },
  ): void {
    if (!this.current) return;
    insertSignal(this.db, {
      ts: now,
      marketTicker: this.current.marketTicker,
      eventTicker: this.current.eventTicker,
      strategy: v.strategy,
      verdict: v.verdict,
      side: v.side,
      expectedMovePp: v.expectedMovePp,
      repricedPp: v.repricedPp,
      remainingPp: v.remainingPp,
      costPp: v.costPp,
      netPp: v.netPp,
      tauSec: ctx.tauSec,
      strike: ctx.strike,
      sigma: ctx.sigma,
      spotNow: ctx.spotNow,
      spotLag: ctx.spotLag,
      midNow: ctx.midNow,
      midLag: ctx.midLag,
      moveBps: ctx.moveBps,
      agree: ctx.agree,
      skipReason: v.skipReason,
      reasons: v.reasons.join(' | '),
      phase: phaseAt(bounds, now),
    });
    if (v.strategy === 'A_LEADLAG') {
      this.stratAStats.evaluated += 1;
      this.stratAStats.lastVerdict = v.verdict;
      this.stratAStats.lastNetPp = v.netPp;
      if (v.verdict === 'TRADE') this.stratAStats.traded += 1;
      else this.stratAStats.skipped += 1;
    }
    const bucket = this.shadowByStrategy[v.strategy] ?? { evaluated: 0, traded: 0 };
    bucket.evaluated += 1;
    if (v.verdict === 'TRADE') bucket.traded += 1;
    this.shadowByStrategy[v.strategy] = bucket;
    // PAPER: a taken signal enters the state machine here. Fills are
    // simulated against this very book (ask/bid, depth-capped) and the
    // module has no order call of any kind.
    if (this.config.paper.enabled && v.verdict === 'TRADE' && this.current) {
      const pb = this.paperBook(now, this.books.get(this.current.marketTicker));
      if (pb) this.paper.enter(v, this.current.eventTicker, this.current.marketTicker, pb, now);
    }
  }

  /**
   * Evaluate every ENABLED shadow strategy once per `stratAEvalMs` and record
   * EVERY outcome with its reasons — taken and rejected alike, so the shadow
   * log can be scored for false negatives too. There is no execution path
   * from here: no order, no position, no broker.
   */
  private runShadowStrategies(
    now: number, bounds: WindowBounds, m: BookMetrics, fair: SampleFair | null,
  ): void {
    const c = this.config;
    const anyOn = c.stratA.enabled || c.stratB.enabled || c.stratC.enabled
      || c.stratD.enabled || c.stratE.enabled || c.stratF.enabled;
    if (!anyOn || !this.current) return;
    if (now - this.lastStratAEvalAt < c.stratAEvalMs) return;
    this.lastStratAEvalAt = now;

    const tauSec = msToClose(bounds, now) / 1_000;
    const strike = this.current.strike;
    const mid = fair?.impliedMid ?? null;
    const pYes = fair?.pYes ?? null;
    const sigma = fair?.sigma ?? null;
    const yesBid = m.bestBid;
    const yesAsk = m.bestAsk;
    const spotNow = this.lagRing[this.lagRing.length - 1]?.spot ?? fair?.spot ?? null;
    const agree = this.lagRing[this.lagRing.length - 1]?.agree ?? null;
    const micro = mid !== null && yesBid !== null && yesAsk !== null
      && m.bestBidSize + m.bestAskSize > 0
      ? (m.bestBidSize * yesAsk + m.bestAskSize * yesBid) / (m.bestBidSize + m.bestAskSize)
      : null;
    const base = { tauSec, strike, sigma, spotNow, spotLag: null, midNow: mid, midLag: null, moveBps: null, agree };

    if (c.stratA.enabled) {
      const lag = this.lagAt(now - c.stratA.lagSec * 1_000);
      const last = this.lagRing[this.lagRing.length - 1] ?? null;
      const spotLag = lag?.spot ?? null;
      const midLag = lag?.mid ?? null;
      const moveBps = spotNow !== null && spotLag !== null && spotLag > 0
        ? Math.log(spotNow / spotLag) * 10_000 : null;
      this.recordSignal(evaluateLeadLag({
        cfg: c.stratA, now, tauSec, strike,
        spotNow, spotLag, midNow: mid, midLag,
        venuesAgree: last?.agree === true,
        sigmaPerSec: sigma, yesBid, yesAsk,
      }), now, bounds, { ...base, spotLag, midLag, moveBps, agree: last?.agree ?? null });
    }

    if (c.stratB.enabled) {
      this.recordSignal(evaluateMicro({
        cfg: c.stratB, tauSec, mid, micro,
        imbalance: m.imbalance, ofi: m.ofi, takerBias60s: m.takerBias60s,
        yesBid, yesAsk,
      }), now, bounds, base);
    }

    if (c.stratC.enabled) {
      const lag = this.lagAt(now - c.stratC.lookbackSec * 1_000);
      const spotLag = lag?.spot ?? null;
      const midLag = lag?.mid ?? null;
      const moveBps = spotNow !== null && spotLag !== null && spotLag > 0
        ? Math.log(spotNow / spotLag) * 10_000 : null;
      this.recordSignal(evaluatePanicFade({
        cfg: c.stratC, tauSec, midNow: mid, midLag, spotMoveBps: moveBps, yesBid, yesAsk,
      }), now, bounds, { ...base, spotLag, midLag, moveBps });
    }

    if (c.stratD.enabled) {
      const lag = this.lagAt(now - c.stratD.lookbackSec * 1_000);
      const spotLag = lag?.spot ?? null;
      const midLag = lag?.mid ?? null;
      const repricedPp = mid !== null && midLag !== null ? (mid - midLag) * 100 : null;
      const moveBps = spotNow !== null && spotLag !== null && spotLag > 0
        ? Math.log(spotNow / spotLag) * 10_000 : null;
      this.recordSignal(evaluateMomentum({
        cfg: c.stratD, tauSec, strike, spotNow, spotLag,
        venuesAgree: lag?.agree === true, sigmaPerSec: sigma,
        repricedPp, yesBid, yesAsk,
      }), now, bounds, { ...base, spotLag, midLag, moveBps, agree: lag?.agree ?? null });
    }

    if (c.stratE.enabled) {
      this.recordSignal(evaluateLateFav({
        cfg: c.stratE, tauSec, pYes, entryPrice: yesAsk, yesBid, yesAsk,
      }), now, bounds, base);
    }

    if (c.stratF.enabled) {
      this.recordSignal(evaluateMaker({ cfg: c.stratF, tauSec, pYes, yesBid, yesAsk }), now, bounds, base);
    }
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
      /** every strategy: SHADOW ONLY — no order is ever placed from this engine */
      strategyA: {
        enabled: this.config.stratA.enabled,
        mode: 'SHADOW',
        cfg: this.config.stratA,
        evalMs: this.config.stratAEvalMs,
        lagRing: this.lagRing.length,
        ...this.stratAStats,
      },
      shadowStrategies: {
        mode: 'SHADOW',
        enabled: {
          A: this.config.stratA.enabled, B: this.config.stratB.enabled,
          C: this.config.stratC.enabled, D: this.config.stratD.enabled,
          E: this.config.stratE.enabled, F: this.config.stratF.enabled,
        },
        shadowStrategies: this.shadowByStrategy,
      },
      /** PAPER execution (simulated fills only) — Phase 6/7/9 status */
      paper: this.config.paper.enabled
        ? this.paper.summary()
        : { enabled: false, note: 'KALSHI15M_PAPER is off' },
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

/**
 * Settlement of one settled Kalshi market — PURE.
 * Kalshi's own `result` wins when present; otherwise the official rule decides
 * (YES iff the closing BRTI average `expiration_value` >= the opening average
 * `floor_strike`, tie to YES). Returns null when the market carries no usable
 * outcome — never a guessed result.
 */
export function deriveSettlement(m: {
  result?: string; expiration_value?: string; floor_strike?: number;
}): { result: 'YES' | 'NO'; settleValue: number | null; source: string } | null {
  const raw = (m.result ?? '').trim().toLowerCase();
  const settleValue = m.expiration_value !== undefined && m.expiration_value !== ''
    ? Number(m.expiration_value)
    : null;
  const usableValue = settleValue !== null && Number.isFinite(settleValue) ? settleValue : null;
  if (raw === 'yes' || raw === 'y') return { result: 'YES', settleValue: usableValue, source: 'kalshi_result' };
  if (raw === 'no' || raw === 'n') return { result: 'NO', settleValue: usableValue, source: 'kalshi_result' };
  const strike = typeof m.floor_strike === 'number' ? m.floor_strike : null;
  if (usableValue !== null && strike !== null && Number.isFinite(strike)) {
    return { result: usableValue >= strike ? 'YES' : 'NO', settleValue: usableValue, source: 'rule_derived' };
  }
  return null;
}