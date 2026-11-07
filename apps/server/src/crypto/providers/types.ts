/** Provider surface for the crypto book — mirrors MarketDataProvider so the
 *  engine, broker and workers never care which venue answers. */
import type { Candle, ProviderStatus, Quote } from '@promptslim/tucore';

export interface CryptoMarketDataProvider {
  readonly name: string;
  /** batch last-price snapshot (REALTIME provenance) */
  getQuotes(symbols: string[]): Promise<Quote[]>;
  /** daily OHLCV, oldest -> newest */
  getDailyBars(symbol: string, days?: number): Promise<Candle[]>;
  status(): ProviderStatus;
  lastUpdate(): number;
  lastLatencyMs(): number;
  lastError(): string | null;
}
