/**
 * Kraken-backed CryptoMarketDataProvider. Wraps the raw REST helpers so the
 * rest of the module depends on an interface (injectable in tests, swappable
 * if we ever add a second venue).
 */
import type { Candle, ProviderStatus, Quote } from '@promptslim/tucore';
import { getTickers, getDailyBars } from './kraken.ts';
import type { CryptoMarketDataProvider } from './types.ts';

export class KrakenProvider implements CryptoMarketDataProvider {
  readonly name = 'kraken';
  private _status: ProviderStatus = 'UNAVAILABLE';
  private _lastError: string | null = null;
  private _lastUpdate = 0;
  private _latency = 0;
  /** injectable for tests; production uses the REST helpers */
  private fetchTickers: typeof getTickers;
  private fetchBars: typeof getDailyBars;

  constructor(deps: { tickers?: typeof getTickers; bars?: typeof getDailyBars } = {}) {
    this.fetchTickers = deps.tickers ?? getTickers;
    this.fetchBars = deps.bars ?? getDailyBars;
  }

  status(): ProviderStatus { return this._status; }
  lastError(): string | null { return this._lastError; }
  lastUpdate(): number { return this._lastUpdate; }
  lastLatencyMs(): number { return this._latency; }

  async getQuotes(symbols: string[]): Promise<Quote[]> {
    if (symbols.length === 0) return [];
    const started = Date.now();
    try {
      const quotes = await this.fetchTickers(symbols);
      this._latency = Date.now() - started;
      this._status = quotes.length > 0 ? 'CONNECTED' : 'DEGRADED';
      this._lastError = quotes.length > 0 ? null : 'kraken returned no quotes';
      this._lastUpdate = Date.now();
      return quotes;
    } catch (err) {
      this._latency = Date.now() - started;
      this._status = 'DEGRADED';
      this._lastError = err instanceof Error ? err.message : 'kraken quote fetch failed';
      return [];
    }
  }

  async getDailyBars(symbol: string, days = 730): Promise<Candle[]> {
    try {
      const bars = await this.fetchBars(symbol, days);
      if (bars.length > 0) {
        this._status = 'CONNECTED';
        this._lastError = null;
        this._lastUpdate = Date.now();
      }
      return bars;
    } catch (err) {
      this._status = 'DEGRADED';
      this._lastError = err instanceof Error ? err.message : 'kraken bar fetch failed';
      return [];
    }
  }
}
