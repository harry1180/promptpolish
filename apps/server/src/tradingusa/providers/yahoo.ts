/**
 * Market data provider abstraction + Yahoo Finance implementation.
 *
 * Provider-independent surface (quotes / daily bars / market meta) so a
 * future WebSocket vendor can be added without touching strategy code.
 * Provenance is explicit: Yahoo data is DELAYED — stored and served with
 * freshness:'DELAYED'. Real-time / EOD provenance is never silently mixed.
 */
import { etDate } from '@promptslim/tucore';
import type { Candle, ProviderStatus, Quote } from '@promptslim/tucore';

export interface MarketDataProvider {
  readonly name: string;
  getQuotes(symbols: string[]): Promise<Quote[]>;
  getDailyBars(symbol: string, range?: string): Promise<Candle[]>;
  status(): ProviderStatus;
  lastUpdate(): number;
  lastLatencyMs(): number;
  lastError(): string | null;
}

export interface ProviderFetchDeps {
  fetchImpl?: typeof fetch;
  userAgent?: string;
}

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

export class YahooFinanceProvider implements MarketDataProvider {
  readonly name = 'yahoo';
  private fetchImpl: typeof fetch;
  private userAgent: string;
  private _status: ProviderStatus = 'UNAVAILABLE';
  private _lastUpdate = 0;
  private _latency = 0;
  private _lastError: string | null = null;
  private consecutiveFailures = 0;
  private cooldownUntil = 0;
  private cooldownMs = 0;
  private useQuery2 = false;
  /** Secondary quote source consulted only when Yahoo yields nothing for a
   *  whole batch (429 / cooldown). Provenance stays per-quote: the fallback
   *  stamps its own provider name, so stored rows never claim to be Yahoo. */
  quoteFallback?: (symbols: string[]) => Promise<Quote[]>;

  constructor(deps: ProviderFetchDeps = {}) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.userAgent = deps.userAgent ?? UA;
  }

  private _cooldownClear(): void {
    this.cooldownUntil = 0;
    this.cooldownMs = 0;
  }

  status(): ProviderStatus { return this._status; }
  lastUpdate(): number { return this._lastUpdate; }
  lastLatencyMs(): number { return this._latency; }
  lastError(): string | null { return this._lastError; }

  /** Rotate query1/query2 and respect our own cooldown between attempts so a
   *  429 window can actually cool down instead of being re-triggered. */
  private rotate(url: string): string {
    if (this.useQuery2) return url.replace('query1.finance.yahoo.com', 'query2.finance.yahoo.com');
    return url;
  }

  private async getJson(urlIn: string, timeoutMs = 12_000): Promise<unknown> {
    const url = this.rotate(urlIn);
    if (Date.now() < this.cooldownUntil) {
      this._status = 'RATE_LIMITED';
      this._lastError = 'provider cooldown active';
      throw new Error('provider rate limited (cooldown)');
    }
    const started = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        headers: { 'user-agent': this.userAgent, accept: 'application/json' },
        signal: ctrl.signal,
      });
      this._latency = Date.now() - started;
      if (res.status === 429) {
        this._status = 'RATE_LIMITED';
        this._lastError = 'rate limited by provider';
        this.consecutiveFailures += 1;
        // exponential cooldown: 60s, 2m, 4m ... cap 10m; rotate host for next try
        this.cooldownMs = Math.min(600_000, this.cooldownMs > 0 ? this.cooldownMs * 2 : 60_000);
        this.cooldownUntil = Date.now() + this.cooldownMs;
        this.useQuery2 = !this.useQuery2;
        throw new Error('provider rate limited');
      }
      if (!res.ok) {
        this.consecutiveFailures += 1;
        this._status = this.consecutiveFailures >= 3 ? 'DEGRADED' : this._status;
        this._lastError = `HTTP ${res.status}`;
        throw new Error(`provider HTTP ${res.status}`);
      }
      const body = (await res.json()) as { chart?: { error?: { description?: string } }; spark?: { error?: unknown } };
      if (body.chart?.error) {
        this._lastError = body.chart.error.description ?? 'chart error';
        throw new Error(this._lastError);
      }
      this.consecutiveFailures = 0;
      this._cooldownClear();
      this._status = 'CONNECTED';
      this._lastError = null;
      this._lastUpdate = Date.now();
      return body;
    } catch (err) {
      if (!ctrl.signal.aborted) {
        this.consecutiveFailures += 1;
        if (this.consecutiveFailures >= 3 && this._status !== 'RATE_LIMITED') this._status = 'DEGRADED';
      } else {
        this._status = 'DEGRADED';
        this._lastError = 'timeout';
      }
      if (err instanceof Error && this._lastError === null) this._lastError = err.message;
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Batch quotes via the spark endpoint (one request for many symbols). */
  async getQuotes(symbols: string[]): Promise<Quote[]> {
    if (symbols.length === 0) return [];
    const url =
      'https://query1.finance.yahoo.com/v7/finance/spark?symbols=' +
      encodeURIComponent(symbols.join(',')) + '&range=1d&interval=5m';
    try {
      const body = (await this.getJson(url)) as {
        spark?: { result?: Array<{ meta?: Record<string, unknown> }> };
      };
      const out: Quote[] = [];
      for (const item of body.spark?.result ?? []) {
        const m = item.meta;
        if (!m || typeof m.symbol !== 'string') continue;
        const price = Number(m.regularMarketPrice ?? 0);
        const prev = Number(m.previousClose ?? m.chartPreviousClose ?? 0);
        if (!Number.isFinite(price) || price <= 0) continue;
        out.push({
          symbol: m.symbol,
          price,
          prevClose: prev > 0 ? prev : price,
          ts: Number(m.regularMarketTime ?? Date.now()) * 1000,
          volume: typeof m.regularMarketVolume === 'number' ? m.regularMarketVolume : undefined,
          provider: this.name,
          freshness: 'DELAYED',
        });
      }
      return out;
    } catch {
      // spark throttled — paced per-symbol chart fallback (never burst)
      const out: Quote[] = [];
      const capped = symbols.slice(0, 20);
      for (const sym of capped) {
        try {
          const q = await this.quoteFromChart(sym);
          if (q) out.push(q);
        } catch {
          if (this._status === 'RATE_LIMITED') break; // stop hammering while throttled
        }
        await new Promise((r) => setTimeout(r, 350));
      }
      // last resort: a whole batch that produced nothing would leave every
      // position marked at entry (returns pinned at 0) — hand the symbols to
      // the secondary source instead of returning empty.
      if (out.length === 0 && this.quoteFallback) {
        try {
          const fb = await this.quoteFallback(symbols);
          if (fb.length > 0) {
            this._lastError = 'yahoo throttled — quotes served by fallback provider';
            return fb;
          }
        } catch {
          /* fallback is best-effort: report empty rather than throw */
        }
      }
      return out;
    }
  }

  async quoteFromChart(symbol: string): Promise<Quote | null> {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=5m`;
    const body = (await this.getJson(url)) as {
      chart?: { result?: Array<{ meta?: Record<string, unknown> }> };
    };
    const m = body.chart?.result?.[0]?.meta;
    if (!m) return null;
    const price = Number(m.regularMarketPrice ?? 0);
    if (!Number.isFinite(price) || price <= 0) return null;
    const prev = Number(m.previousClose ?? m.chartPreviousClose ?? 0);
    return {
      symbol: symbol,
      price,
      prevClose: prev > 0 ? prev : price,
      ts: Number(m.regularMarketTime ?? Date.now()) * 1000,
      provider: this.name,
      freshness: 'DELAYED',
    };
  }

  /** Daily OHLCV bars; dates are ET session dates via tucore.etDate. */
  async getDailyBars(symbol: string, range = '2y'): Promise<Candle[]> {
    const url =
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
      `?range=${encodeURIComponent(range)}&interval=1d&includePrePost=false&events=split,div`;
    const body = (await this.getJson(url)) as {
      chart?: {
        result?: Array<{
          timestamp?: number[];
          indicators?: {
            quote?: Array<{ open?: Array<number | null>; high?: Array<number | null>; low?: Array<number | null>; close?: Array<number | null>; volume?: Array<number | null> }>;
            adjclose?: Array<{ adjclose?: Array<number | null> }>;
          };
        }>;
      };
    };
    const r = body.chart?.result?.[0];
    if (!r || !r.timestamp || !r.indicators?.quote?.[0]) return [];
    const q = r.indicators.quote[0];
    const bars: Candle[] = [];
    for (let i = 0; i < r.timestamp.length; i++) {
      const open = q.open?.[i], high = q.high?.[i], low = q.low?.[i], close = q.close?.[i];
      if (open == null || high == null || low == null || close == null) continue;
      bars.push({
        date: etDate(r.timestamp[i] * 1000),
        open, high, low, close,
        volume: q.volume?.[i] ?? 0,
      });
    }
    return bars;
  }
}
