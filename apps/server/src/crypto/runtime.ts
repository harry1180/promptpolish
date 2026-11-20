/**
 * CryptoRuntime — owns the crypto database, the Kraken provider, the realtime
 * stream and the 24/7 scheduler. Constructed once by createApp; workers start
 * only when CRYPTO_WORKERS=1 (production compose), mirroring TradingRuntime.
 */
import { openCryptoDb } from './schema.ts';
import { cryptoConfigFromEnv, type CryptoConfig } from './config.ts';
import { ensureSpotPortfolio } from './broker.ts';
import { activeSymbols, ingestTick } from './engine.ts';
import { KrakenProvider } from './providers/kraken-provider.ts';
import { CryptoPriceStream } from './stream.ts';
import { CryptoScheduler } from './workers.ts';
import { MicroEngine } from './micro/features.ts';
import { XchangeManager } from '../xchange/registry.ts';
import { deriveState, type ProviderSnapshot } from '../xchange/types.ts';
import { recordMicroSnapshot } from './micro/recorder.ts';
import { PINNED } from './universe.ts';

export interface CryptoRuntimeOptions {
  dbPath?: string;
  workers?: boolean;
  config?: CryptoConfig;
  cycleMs?: number;
  /** subscribe Kraken's `trade` channel too (BTC spot tape needs prints) */
  spotTape?: boolean;
}

export class CryptoRuntime {
  readonly config: CryptoConfig;
  readonly db: ReturnType<typeof openCryptoDb>;
  readonly provider: KrakenProvider;
  readonly stream: CryptoPriceStream;
  readonly scheduler: CryptoScheduler;
  /** shadow microstructure engine; null while SCALPING_ALPHA_ENABLED is off */
  readonly micro: MicroEngine | null;
  /** multi-exchange observer layer (Kraken + Coinbase today); DATA ONLY */
  readonly xchange: XchangeManager;
  /** set after the observer exists so the stream closure never reads early */
  private onKrakenTick: ((q: { symbol: string; price: number; ts: number; bid?: number; ask?: number }) => void) | null = null;
  private started = false;
  /**
   * Observer taps for the BTC spot tape (Kalshi 15-minute engine). Arrays are
   * passed BY REFERENCE into the stream options, so a hook registered after
   * construction is still seen by the next tick — and no hook ever has a path
   * into the broker.
   */
  private readonly spotHooks: Array<(q: { symbol: string; price: number; ts: number; bid?: number; ask?: number }) => void> = [];
  private readonly rawObservers: Array<(text: string) => void> = [];

  /** Tap every Kraken ticker tick (BTC tape: returns, divergence, lead/lag). */
  observeSpot(cb: (q: { symbol: string; price: number; ts: number; bid?: number; ask?: number }) => void): void {
    this.spotHooks.push(cb);
  }

  /** Tap raw Kraken frames (the `trade` channel the tape parses). */
  observeRaw(cb: (text: string) => void): void {
    this.rawObservers.push(cb);
  }

  constructor(opts: CryptoRuntimeOptions = {}) {
    this.config = opts.config ?? cryptoConfigFromEnv();
    this.db = openCryptoDb(opts.dbPath ?? this.config.dbPath);
    this.provider = new KrakenProvider();
    // seed the socket with the pinned members; the universe job swaps in the
    // full active list (stream.updateSymbols) once it has fetched ranks
    const initial = activeSymbols(this.db);
    this.stream = new CryptoPriceStream({
      symbols: initial.length > 0 ? initial : [...PINNED],
      onTick: (q) => {
        try { ingestTick(this.db, [q]); } catch { /* one tick lost; the next arrives in ms */ }
        try { this.micro?.onQuote(q, Date.now()); } catch { /* shadow only */ }
        try { this.onKrakenTick?.(q); } catch { /* observer only — trading unaffected */ }
        // spot-tape observers (BTC 15-min engine): same tick, no extra socket
        for (const hook of this.spotHooks) {
          try { hook(q); } catch { /* tape is an observer; trading unaffected */ }
        }
      },
      restPoll: async () => {
        const quotes = await this.provider.getQuotes(activeSymbols(this.db));
        if (quotes.length > 0) ingestTick(this.db, quotes);
        return quotes.length;
      },
      restPollMs: this.config.restPollMs,
      // --- shadow observers (micro module + BTC spot tape). Inert when the flags
      // are off: extraChannels stays empty and onRawMessage is never set, so
      // the socket subscribes exactly as before. The `trade` channel is added
      // by EITHER consumer — one subscription, both observers fed.
      ...((this.config.micro.enabled || opts.spotTape) ? { extraChannels: ['trade'] } : {}),
      rawObservers: this.rawObservers,
      onRawMessage: this.config.micro.enabled
        ? (text: string) => { try { this.micro?.enqueueRaw(text, Date.now()); } catch { /* counted in engine */ } }
        : undefined,
    });
    this.micro = this.config.micro.enabled
      ? new MicroEngine({
          flags: this.config.micro,
          feePct: this.config.feePct,
          staleMs: this.config.micro.staleMs,
          queueCap: this.config.micro.queueCap,
          recordMs: this.config.micro.recordMs,
          onSnapshot: (symbol, payload) => { try { recordMicroSnapshot(this.db, symbol, payload); } catch { /* recording is best-effort */ } },
        })
      : null;
    this.scheduler = new CryptoScheduler({
      db: this.db, provider: this.provider, config: this.config,
      stream: this.stream, ...(opts.cycleMs ? { cycleMs: opts.cycleMs } : {}),
    });
    // Observer layer: constructed always (tables exist, endpoints answer),
    // sockets start only when workers run — same gate as the trading cycle.
    this.xchange = new XchangeManager({
      db: this.db,
      config: this.config.xchange,
      kraken: () => krakenSnapshot(this.db, this.provider, this.stream),
    });
    this.onKrakenTick = (q) => { this.xchange.observeKraken(q); };
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    ensureSpotPortfolio(this.db, this.config);
    if (this.config.workers) this.scheduler.start();
    if (this.config.workers && this.config.xchange.enabled) this.xchange.start();
  }

  stop(): void {
    this.scheduler.stop();
    this.xchange.stop();
  }
}

/**
 * Kraken reported through the SAME snapshot shape as the extra venues, so the
 * dashboard compares like with like. Transport health comes from the live
 * stream; quote freshness from `market_quotes` — CONNECTED alone never means
 * healthy (a socket with a frozen book reports DEGRADED).
 */
export function krakenSnapshot(
  db: ReturnType<typeof openCryptoDb>,
  provider: KrakenProvider,
  stream: CryptoPriceStream,
): ProviderSnapshot {
  const now = Date.now();
  const rows = db.prepare('SELECT symbol, bid, ask, price, ts FROM market_quotes').all() as unknown as Array<{
    symbol: string; bid: number | null; ask: number | null; price: number; ts: number;
  }>;
  const lastTs = rows.reduce((m, r) => Math.max(m, Number(r.ts ?? 0)), 0) || null;
  const eventsPerMin = rows.filter((r) => now - Number(r.ts) < 60_000).length;
  const transport = stream.live || provider.status() === 'CONNECTED';
  const derived = deriveState({
    enabled: true,
    connected: transport,
    connecting: false,
    configured: true,
    events: rows.length,
    lastEventTs: lastTs,
    now,
    lastError: provider.lastError(),
  });
  return {
    id: 'kraken',
    label: 'Kraken',
    feedKind: 'WEBSOCKET',
    state: derived.state,
    healthy: derived.healthy,
    connected: transport,
    channels: stream.live ? ['ticker'] : ['rest'],
    symbols: [...stream.symbols],
    symbolCount: stream.symbols.size,
    events: rows.length,
    eventsPerMin,
    lastEventTs: lastTs,
    lastEventAgeMs: lastTs === null ? null : now - lastTs,
    lastAckTs: lastTs,
    reconnects: 0,
    errors: provider.lastError() ? 1 : 0,
    lastError: provider.lastError(),
    latency: { p50: null, p95: null, samples: 0 },
    // Kraken's WS ticker carries bid/ask sizes but no L2 levels in this app
    book: [],
    quotes: rows.map((r) => ({
      provider: 'kraken',
      symbol: r.symbol,
      quote: 'USD',
      bid: r.bid ?? null,
      ask: r.ask ?? null,
      mid: r.bid !== null && r.ask !== null ? (r.bid + r.ask) / 2 : r.price,
      last: r.price,
      spreadBps: r.bid !== null && r.ask !== null && r.price
        ? Math.round((((r.ask - r.bid) / r.price) * 10_000) * 100) / 100
        : null,
      ts: Number(r.ts),
    })),
    note: `${stream.live ? 'websocket' : 'rest poll'} · rest ${provider.lastLatencyMs()}ms`,
  };
}
