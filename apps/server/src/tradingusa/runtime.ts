/**
 * TradingRuntime — owns the TradingUSA database, providers, InferenceRouter,
 * ExecutionGuard and session-aware scheduler. Constructed once by
 * createApp; workers start only when TU_WORKERS=1 (production compose).
 * Nothing here needs Hermes after deployment.
 */
import type { DatabaseSync } from 'node:sqlite';
import { openTradingDb } from './schema.ts';
import { tuConfigFromEnv, type TuConfig } from './config.ts';
import { ExecutionGuard } from './guard.ts';
import { YahooFinanceProvider } from './providers/yahoo.ts';
import { NewsProvider } from './providers/news.ts';
import { SecProvider } from './providers/sec.ts';
import { MacroProvider } from './providers/macro.ts';
import { NasdaqEodProvider } from './providers/nasdaq.ts';
import { AlpacaRealtimeProvider } from './providers/alpaca.ts';
import { CboeIndexProvider } from './providers/cboe.ts';
import type { Quote } from '@promptslim/tucore';
import { InferenceRouter, QualityTracker, configFromEnv } from './inference/router.ts';
import { TradingScheduler } from './workers.ts';
import { ensurePortfolios } from './broker.ts';

export interface TradingRuntimeOptions {
  dbPath?: string;
  workers?: boolean;
  fetchImpl?: typeof fetch;
  config?: TuConfig;
  /** Alpaca creds — defaults to process.env (compose env_file injects them). */
  alpacaKeyId?: string;
  alpacaSecretKey?: string;
}

export class TradingRuntime {
  readonly config: TuConfig;
  readonly db: DatabaseSync;
  readonly provider: YahooFinanceProvider;
  readonly news: NewsProvider;
  readonly sec: SecProvider;
  readonly macro: MacroProvider;
  readonly nasdaq: NasdaqEodProvider;
  readonly alpaca: AlpacaRealtimeProvider;
  readonly cboe: CboeIndexProvider;
  readonly router: InferenceRouter;
  readonly quality: QualityTracker;
  readonly guard: ExecutionGuard;
  readonly scheduler: TradingScheduler;
  private started = false;

  constructor(opts: TradingRuntimeOptions = {}) {
    this.config = opts.config ?? tuConfigFromEnv();
    this.db = openTradingDb(opts.dbPath ?? this.config.dbPath);
    const fetchImpl = opts.fetchImpl;
    this.provider = new YahooFinanceProvider(fetchImpl ? { fetchImpl } : {});
    this.news = new NewsProvider(fetchImpl ? { fetchImpl } : {});
    this.sec = new SecProvider(fetchImpl ? { fetchImpl } : {});
    this.macro = new MacroProvider(fetchImpl ? { fetchImpl } : {});
    this.nasdaq = new NasdaqEodProvider(fetchImpl ? { fetchImpl } : {});
    this.cboe = new CboeIndexProvider(fetchImpl ? { fetchImpl } : {});
    this.alpaca = new AlpacaRealtimeProvider({
      ...(fetchImpl ? { fetchImpl } : {}),
      keyId: opts.alpacaKeyId ?? process.env.ALPACA_API_KEY_ID,
      secretKey: opts.alpacaSecretKey ?? process.env.ALPACA_SECRET_KEY,
    });
    // Yahoo is nominally first; when it yields nothing (429/cooldown — every
    // call from this host) the chain splits by asset class:
    //   equities -> Alpaca REALTIME snapshots, then delayed Nasdaq;
    //   indexes  -> Cboe, because neither of the others serves `^` symbols
    //               (Nasdaq has no index endpoint; Alpaca answers 400 for a
    //               batch that contains one, which used to blank the whole
    //               realtime path).
    // Provenance stays per quote, so stored rows truthfully say
    // 'alpaca'/REALTIME, 'nasdaq'/DELAYED or 'cboe'/DELAYED.
    this.provider.quoteFallback = async (symbols) => {
      const indexes = symbols.filter((s) => s.startsWith('^'));
      const equities = symbols.filter((s) => !s.startsWith('^'));
      const out: Quote[] = [];
      if (equities.length > 0) {
        if (this.alpaca.configured()) {
          try {
            const quotes = await this.alpaca.getQuotes(equities);
            if (quotes.length > 0) out.push(...quotes);
          } catch { /* fall through to the delayed source */ }
        }
        if (out.length === 0) {
          try {
            out.push(...await this.nasdaq.getQuotes(equities));
          } catch { /* best effort: report what we have */ }
        }
      }
      if (indexes.length > 0 && out.length < symbols.length) {
        try {
          out.push(...await this.cboe.getQuotes(indexes));
        } catch { /* index quotes are optional, never fatal */ }
      }
      return out;
    };
    this.router = new InferenceRouter({
      db: this.db,
      config: configFromEnv(),
      ...(fetchImpl ? { fetchImpl } : {}),
    });
    this.quality = new QualityTracker(this.db);
    this.guard = new ExecutionGuard();
    this.scheduler = new TradingScheduler({
      db: this.db, provider: this.provider, news: this.news, sec: this.sec,
      macro: this.macro, nasdaq: this.nasdaq, cboe: this.cboe, router: this.router,
      quality: this.quality, config: this.config,
    });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    ensurePortfolios(this.db, this.config);
    if (this.config.workers) this.scheduler.start();
  }

  stop(): void {
    this.scheduler.stop();
  }
}
