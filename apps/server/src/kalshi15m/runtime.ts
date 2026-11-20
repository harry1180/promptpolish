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
import { KalshiBook, type TradePrint } from './book.ts';
import { KalshiRest, KalshiWs, KXBTC15M, loadCreds, type AuthConfig, type KalshiCreds, type StreamSocket } from './client.ts';
import {
  eventOfMarket, msToClose, phaseAt, windowFromRest,
  type WindowBounds, type WindowPhase,
} from './lifecycle.ts';
import {
  ensureK15mTables, insertHealth, insertSample, insertTrade, pruneK15m,
  updateWindowQuotes, upsertWindow,
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

export interface K15mDeps {
  db: DatabaseSync;
  config?: K15mConfig;
  rest?: KalshiRest;
  creds?: KalshiCreds | null;
  socketFactory?: (url: string, headers: Record<string, string>) => StreamSocket;
  now?: () => number;
  fetchImpl?: typeof fetch;
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
  private started = false;

  constructor(deps: K15mDeps) {
    this.db = deps.db;
    this.now = deps.now ?? Date.now;
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
        });
        book.endSampleWindow();
        this.stats.samples += 1;
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
      lastError: this.stats.lastError,
    };
  }
}