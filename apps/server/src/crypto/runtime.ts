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
import { recordMicroSnapshot } from './micro/recorder.ts';
import { PINNED } from './universe.ts';

export interface CryptoRuntimeOptions {
  dbPath?: string;
  workers?: boolean;
  config?: CryptoConfig;
  cycleMs?: number;
}

export class CryptoRuntime {
  readonly config: CryptoConfig;
  readonly db: ReturnType<typeof openCryptoDb>;
  readonly provider: KrakenProvider;
  readonly stream: CryptoPriceStream;
  readonly scheduler: CryptoScheduler;
  /** shadow microstructure engine; null while SCALPING_ALPHA_ENABLED is off */
  readonly micro: MicroEngine | null;
  private started = false;

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
      },
      restPoll: async () => {
        const quotes = await this.provider.getQuotes(activeSymbols(this.db));
        if (quotes.length > 0) ingestTick(this.db, quotes);
        return quotes.length;
      },
      restPollMs: this.config.restPollMs,
      // --- shadow observers (micro module). Both are inert when the flag is
      // off: extraChannels stays empty and onRawMessage is never set, so the
      // socket subscribes exactly as before.
      ...(this.config.micro.enabled ? { extraChannels: ['trade'] } : {}),
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
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    ensureSpotPortfolio(this.db, this.config);
    if (this.config.workers) this.scheduler.start();
  }

  stop(): void {
    this.scheduler.stop();
  }
}
