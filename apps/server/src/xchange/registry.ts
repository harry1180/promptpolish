/**
 * Multi-exchange provider manager.
 *
 *   Coinbase / Binance.US / Gemini / Bitstamp / Crypto.com  (WebSocket, live)
 *        + DEX Screener / GeckoTerminal / CoinGecko          (REST, cached)
 *              ↓ CanonicalEvent
 *        SampleAccumulator → xchange_samples (5s cadence, 72h retention)
 *        Feature engine    → xchange_snapshots (60s cadence, research-only)
 *
 * Kraken stays the production feed: the manager is an OBSERVER with no path
 * into the broker. Everything runs inside the existing Node process — no new
 * services, no extra infrastructure.
 */
import type { DatabaseSync } from 'node:sqlite';
import { createContextSource, type ContextAdapter } from './context.ts';
import { aggressorPressure, confidenceScore, leadLag, priceAgreement, venueWindow, type AgreementStats, type LeadLagRow } from './features.ts';
import { SampleAccumulator, ensureXchangeTables, insertSamples, logProviderState, pruneSamples, putContext, getContext, countContext, SAMPLE_MS, type SampleRow } from './store.ts';
import type { XchangeConfig } from '../crypto/config.ts';
import type { CanonicalEvent, ContextSourceSnapshot, ProviderSnapshot, ProvidersResponse, ExchangeAdapter } from './types.ts';
import type { VenueFeedConfig } from './ws.ts';
import { PENDING_PROVIDERS, PROVIDER_FACTORIES } from './providers/index.ts';

export interface XchangeDeps {
  db: DatabaseSync;
  config: XchangeConfig;
  /** Kraken reference status, supplied by the runtime (the live production feed) */
  kraken: () => ProviderSnapshot;
  socketFactory?: (url: string) => unknown;
  now?: () => number;
  fetchImpl?: typeof fetch;
}

export interface XchangeFeatureSnapshot {
  symbol: string;
  generatedAt: number;
  windowMs: number;
  venues: Array<ReturnType<typeof venueWindow>>;
  agreement: AgreementStats[];
  pressure: Array<{ provider: string; trades: number; takerBuyPct: number | null; fresh: boolean }>;
  leadLag: LeadLagRow[];
  confidence: { score: number | null; sufficient: boolean; parts: Record<string, number | null> };
}

const CONTEXT_POLL_MS = 5 * 60_000;

export class XchangeManager {
  readonly db: DatabaseSync;
  readonly config: XchangeConfig;
  private readonly deps: XchangeDeps;
  private readonly feeds: ExchangeAdapter[] = [];
  private readonly context: ContextAdapter[] = [];
  private readonly acc = new SampleAccumulator();
  private sampleTimer: ReturnType<typeof setInterval> | null = null;
  private contextTimer: ReturnType<typeof setInterval> | null = null;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private snapshotTimer: ReturnType<typeof setInterval> | null = null;
  private lastStates = new Map<string, string>();
  /** enabled in config but not present in PROVIDER_FACTORIES */
  private readonly unwired: string[] = [];
  private started = false;

  constructor(deps: XchangeDeps) {
    this.deps = deps;
    this.db = deps.db;
    this.config = deps.config;
    ensureXchangeTables(this.db);
    if (!this.config.enabled) return;

    const feedCfg = (): VenueFeedConfig => ({
      symbols: this.config.symbols,
      quote: this.config.quote,
      onEvent: (ev) => this.onEvent(ev),
      ...(this.deps.socketFactory ? { socketFactory: this.deps.socketFactory as (url: string) => never } : {}),
      ...(this.deps.now ? { now: this.deps.now } : {}),
    });
    const cfg = feedCfg();
    for (const id of this.config.venues) {
      const make = PROVIDER_FACTORIES[id];
      // a venue that is enabled but not wired stays visible as CONFIGURED
      if (make) this.feeds.push(make(cfg));
      else this.unwired.push(id);
    }
    if (this.config.contextEnabled) {
      for (const id of ['dexscreener', 'geckoterminal', 'coingecko']) {
        this.context.push(createContextSource(id, {
          db: this.db,
          pollMs: this.config.contextPollMs,
          ...(this.config.coingeckoKey ? { apiKey: this.config.coingeckoKey } : {}),
          ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
          now: this.deps.now,
        }));
      }
    }
  }

  /**
   * External observers of the COINBASE event stream (Kraken reaches the spot
   * tape through CryptoRuntime.observeSpot instead — exactly one path per
   * venue, so nothing is counted twice). Failures in an observer can never
   * affect ingest.
   */
  private readonly observers: Array<(ev: CanonicalEvent) => void> = [];

  observe(cb: (ev: CanonicalEvent) => void): void {
    this.observers.push(cb);
  }

  private onEvent(ev: CanonicalEvent): void {
    this.acc.observe(ev);
    for (const cb of this.observers) {
      try { cb(ev); } catch { /* observer must not break ingest */ }
    }
  }

  /**
   * Kraken ticks are mirrored into the SAME accumulator, so both venues land
   * on one synchronized 5s grid — the only way the point-in-time comparison
   * can be honest. Called from the production stream's onTick observer hook;
   * it never writes back into stream state.
   */
  observeKraken(q: { symbol: string; price: number; ts: number; bid?: number; ask?: number }): void {
    if (!this.config.enabled) return;
    const now = this.now();
    this.acc.observe({
      provider: 'kraken',
      instrument: `${q.symbol}/USD`,
      base: q.symbol,
      quote: 'USD',
      productType: 'SPOT',
      type: 'ticker',
      eventId: null,
      exchangeTs: Number.isFinite(q.ts) ? q.ts : null,
      recvTs: now,
      processTs: now,
      price: q.price,
      size: null,
      side: null,
      bid: q.bid ?? null,
      bidQty: null,
      ask: q.ask ?? null,
      askQty: null,
      bids: null,
      asks: null,
      seq: null,
      channel: 'ticker',
      freshness: 'REALTIME',
      bookValid: true,
    });
  }

  start(): void {
    if (this.started || !this.config.enabled) return;
    this.started = true;
    for (const feed of this.feeds) {
      try {
        feed.start();
        logProviderState(this.db, feed.id, 'CONNECTING', 'start');
      } catch (err) {
        logProviderState(this.db, feed.id, 'UNAVAILABLE', err instanceof Error ? err.message : 'start failed');
      }
    }
    this.sampleTimer = setInterval(() => this.flushSamples(), SAMPLE_MS);
    this.snapshotTimer = setInterval(() => this.persistSnapshots(), 60_000);
    this.pruneTimer = setInterval(() => { try { pruneSamples(this.db); } catch { /* best effort */ } }, 600_000);
    if (this.context.length > 0) {
      void this.pollContext();
      this.contextTimer = setInterval(() => { void this.pollContext(); }, this.config.contextPollMs || CONTEXT_POLL_MS);
    }
  }

  stop(): void {
    this.started = false;
    for (const feed of this.feeds) { try { feed.stop(); } catch { /* already gone */ } }
    if (this.sampleTimer) { clearInterval(this.sampleTimer); this.sampleTimer = null; }
    if (this.snapshotTimer) { clearInterval(this.snapshotTimer); this.snapshotTimer = null; }
    if (this.pruneTimer) { clearInterval(this.pruneTimer); this.pruneTimer = null; }
    if (this.contextTimer) { clearInterval(this.contextTimer); this.contextTimer = null; }
    try { this.flushSamples(); } catch { /* final flush is best effort */ }
  }

  private flushSamples(): void {
    try {
      const rows = this.acc.drain(this.now());
      if (rows.length > 0) insertSamples(this.db, rows);
    } catch { /* storage pressure never kills the feed */ }
  }

  private async pollContext(): Promise<void> {
    for (const src of this.context) {
      try {
        const payload = await src.fetchOnce();
        if (payload !== null) putContext(this.db, src.id, payload, this.config.contextPollMs * 3, this.now());
      } catch { /* adapter records its own error */ }
    }
  }

  private persistSnapshots(): void {
    for (const symbol of this.config.symbols) {
      try {
        const snap = this.features(symbol, 3_600_000);
        if (snap) {
          this.db.prepare('INSERT INTO xchange_snapshots (ts, symbol, payload) VALUES (?,?,?)')
            .run(this.now(), symbol, JSON.stringify(snap));
        }
      } catch { /* research only */ }
    }
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /* ------------------------------------------------------------------ */
  /* read surfaces                                                       */
  /* ------------------------------------------------------------------ */

  exchangeSnapshots(): ProviderSnapshot[] {
    return this.feeds.map((f) => f.snapshot());
  }

  referenceSnapshot(): ProviderSnapshot {
    return this.deps.kraken();
  }

  contextSnapshots(): ContextSourceSnapshot[] {
    if (!this.config.enabled || !this.config.contextEnabled) {
      return this.context.length > 0 ? this.context.map((c) => c.status()) : [];
    }
    return this.context.map((c) => c.status());
  }

  status(): ProvidersResponse {
    const ids = this.config.venues.length > 0 ? this.config.venues : ['coinbase'];
    const exchanges = this.config.enabled
      ? [
          ...this.exchangeSnapshots(),
          ...this.unwired.map((id) => placeholder(id, 'CONFIGURED', 'adapter not wired in providers/index.ts')),
        ]
      : ids.map((id) => placeholder(id, 'DISABLED', 'CRYPTO_XCHANGE_ENABLED=0'));
    const context = this.config.contextEnabled ? this.contextSnapshots() : [];
    return {
      ok: true,
      executionMode: 'PAPER_ONLY',
      decisionImpact: 'NONE',
      generatedAt: this.now(),
      exchanges,
      context,
      pending: [...PENDING_PROVIDERS],
      reference: this.referenceSnapshot(),
    };
  }

  /** load a window of samples for the feature math */
  samples(windowMs: number, symbol?: string): SampleRow[] {
    return rowsFor(this.db, this.now() - windowMs, symbol);
  }

  features(symbol: string, windowMs = 3_600_000): XchangeFeatureSnapshot | null {
    const rows = rowsFor(this.db, this.now() - windowMs, symbol);
    if (rows.length === 0) return null;
    const now = this.now();
    const agreement = priceAgreement(rows, symbol, now, 'kraken');
    const usd = agreement.find((a) => a.quoteGroup === 'USD') ?? null;
    const ven = this.config.symbols.includes(symbol) ? this.config.symbols.length : 4;
    const freshVenues = usd?.freshVenues ?? 0;
    const spreads = rows.filter((r) => r.spreadBps !== null).map((r) => r.spreadBps as number).sort((a, b) => a - b);
    const medianSpread = spreads.length > 0 ? spreads[Math.floor(spreads.length / 2)] : null;
    const confidence = confidenceScore({
      agreement: usd?.agreement ?? null,
      freshVenues,
      requiredVenues: ven,
      divergenceBps: usd?.divergenceBps ?? null,
      medianSpreadBps: medianSpread,
    });
    return {
      symbol,
      generatedAt: now,
      windowMs,
      venues: [...new Set(rows.map((r) => r.provider))]
        .map((p) => venueWindow(rows, p, symbol, now))
        .filter((v): v is NonNullable<typeof v> => v !== null),
      agreement,
      pressure: aggressorPressure(rows, symbol, now),
      leadLag: leadLag(rows, symbol, 'kraken'),
      confidence,
    };
  }

  contextData(): Record<string, { ts: number; payload: unknown } | null> {
    const out: Record<string, { ts: number; payload: unknown } | null> = {};
    for (const id of ['dexscreener', 'geckoterminal', 'coingecko']) out[id] = getContext(this.db, id, this.now());
    return out;
  }

  contextCounts(): number {
    return countContext(this.db);
  }

  /** state transitions, for the provider log (visibility without logs) */
  recordStateTransitions(): void {
    for (const snap of this.exchangeSnapshots()) {
      const prev = this.lastStates.get(snap.id);
      if (prev !== snap.state) {
        this.lastStates.set(snap.id, snap.state);
        logProviderState(this.db, snap.id, snap.state, snap.note);
      }
    }
  }
}

/** A venue with no running adapter still gets a row, honestly labeled. */
function placeholder(id: string, state: ProviderSnapshot['state'], note: string): ProviderSnapshot {
  return {
    id,
    label: id,
    feedKind: 'WEBSOCKET',
    state,
    healthy: false,
    connected: false,
    channels: [],
    symbols: [],
    symbolCount: 0,
    events: 0,
    eventsPerMin: 0,
    lastEventTs: null,
    lastEventAgeMs: null,
    lastAckTs: null,
    reconnects: 0,
    errors: 0,
    lastError: null,
    latency: { p50: null, p95: null, samples: 0 },
    book: [],
    quotes: [],
    note,
  };
}

function rowsFor(db: DatabaseSync, since: number, symbol?: string): SampleRow[] {
  const sql = `SELECT ts, provider, symbol, quote, bid, ask, mid, last, spread_bps AS spreadBps,
                      bid_qty AS bidQty, ask_qty AS askQty, trade_px AS tradePx,
                      trade_qty AS tradeQty, trade_side AS tradeSide, events, valid
                 FROM xchange_samples WHERE ts >= ? ${symbol ? 'AND symbol = ?' : ''}
                ORDER BY ts ASC`;
  const rows = (symbol
    ? db.prepare(sql).all(since, symbol)
    : db.prepare(sql).all(since)) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    ts: Number(r.ts),
    provider: String(r.provider),
    symbol: String(r.symbol),
    quote: String(r.quote),
    bid: r.bid === null ? null : Number(r.bid),
    ask: r.ask === null ? null : Number(r.ask),
    mid: r.mid === null ? null : Number(r.mid),
    last: r.last === null ? null : Number(r.last),
    spreadBps: r.spreadBps === null ? null : Number(r.spreadBps),
    bidQty: r.bidQty === null ? null : Number(r.bidQty),
    askQty: r.askQty === null ? null : Number(r.askQty),
    tradePx: r.tradePx === null ? null : Number(r.tradePx),
    tradeQty: r.tradeQty === null ? null : Number(r.tradeQty),
    tradeSide: r.tradeSide === null ? null : String(r.tradeSide),
    events: Number(r.events ?? 0),
    valid: Number(r.valid ?? 1) === 1,
  }));
}
