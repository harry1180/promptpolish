/**
 * Alpaca real-time quote provider (free paper account, IEX feed).
 *
 * READ-ONLY market data: two env headers (ALPACA_API_KEY_ID /
 * ALPACA_SECRET_KEY), no order flow anywhere — execution stays with
 * PaperBroker under the PAPER_ONLY guard.
 *
 * Source: REST batch snapshots (`/v2/stocks/snapshots?feed=iex`) — one
 * request covers the whole universe and returns latest TRADE prints plus
 * prevDailyBar. Provenance is kept per quote: freshness 'REALTIME',
 * provider 'alpaca' — never mixed with DELAYED rows from other providers
 * in the same table (the column is per row).
 *
 * Daily bars are deliberately NOT served here: end-of-day history stays
 * with the Yahoo/Nasdaq EOD path, so `getDailyBars` returns [] and
 * `backfillBars` routes to its fallback as designed.
 *
 * The WebSocket stream (wss://stream.data.alpaca.markets) does not connect
 * from this host, hence the REST polling design: every existing call site
 * (quote_poll 45s, position_monitor 20s, scan, order fills) already polls,
 * and each poll now returns seconds-fresh prints instead of a 15-minute
 * delayed snapshot.
 */
import type { Candle, ProviderStatus, Quote } from '@promptslim/tucore';

export interface AlpacaDeps {
  fetchImpl?: typeof fetch;
  keyId?: string;
  secretKey?: string;
}

interface AlpacaQuote {
  bp?: number; ap?: number; t?: string;
}
interface AlpacaTrade {
  p?: number; t?: string;
}
interface AlpacaBar {
  c?: number; v?: number; t?: string;
}
interface AlpacaSnapshot {
  latestQuote?: AlpacaQuote;
  latestTrade?: AlpacaTrade;
  dailyBar?: AlpacaBar;
  prevDailyBar?: AlpacaBar;
}

const SNAPSHOT_URL = 'https://data.alpaca.markets/v2/stocks/snapshots?feed=iex&symbols=';
/** Snapshot cache TTL: polls closer together than this are served from memory. */
const CACHE_TTL_MS = 10_000;

/** Alpaca stamps sub-millisecond precision ("…07.739665046Z"); JS Date only
 *  takes milliseconds — truncate the fraction so parsing never yields NaN. */
function parseTs(iso: string | undefined): number | null {
  if (!iso) return null;
  const norm = iso.replace(/(\.\d{3})\d*/, '$1');
  const ms = Date.parse(norm);
  return Number.isFinite(ms) ? ms : null;
}

function snapshotQuote(symbol: string, snap: AlpacaSnapshot): Quote | null {
  // Prefer the actual trade print; fall back to the quote midpoint.
  const trade = snap.latestTrade;
  const q = snap.latestQuote;
  let price: number | null = null;
  if (trade && typeof trade.p === 'number' && trade.p > 0) price = trade.p;
  else if (q && typeof q.bp === 'number' && typeof q.ap === 'number' && q.bp > 0 && q.ap > 0) {
    price = (q.bp + q.ap) / 2;
  }
  if (price == null) return null;
  const ts = parseTs(trade?.t) ?? parseTs(q?.t) ?? Date.now();
  const prevClose = typeof snap.prevDailyBar?.c === 'number' && snap.prevDailyBar.c > 0
    ? snap.prevDailyBar.c
    : price;
  return {
    symbol,
    price,
    prevClose,
    ts,
    bid: q?.bp,
    ask: q?.ap,
    volume: typeof snap.dailyBar?.v === 'number' ? snap.dailyBar.v : undefined,
    provider: 'alpaca',
    freshness: 'REALTIME',
  };
}

export class AlpacaRealtimeProvider {
  readonly name = 'alpaca';
  private fetchImpl: typeof fetch;
  private keyId: string | undefined;
  private secretKey: string | undefined;
  private _status: ProviderStatus = 'UNAVAILABLE';
  private _lastUpdate = 0;
  private _latency = 0;
  private _lastError: string | null = null;
  private cache = new Map<string, { quote: Quote; at: number }>();

  constructor(deps: AlpacaDeps = {}) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.keyId = deps.keyId;
    this.secretKey = deps.secretKey;
  }

  /** Both env headers present — the only precondition for being consulted. */
  configured(): boolean {
    return Boolean(this.keyId && this.secretKey);
  }

  status(): ProviderStatus { return this._status; }
  lastUpdate(): number { return this._lastUpdate; }
  lastLatencyMs(): number { return this._latency; }
  lastError(): string | null { return this._lastError; }

  async getQuotes(symbols: string[]): Promise<Quote[]> {
    if (!this.configured() || symbols.length === 0) return [];
    const now = Date.now();
    const out: Quote[] = [];
    const pending: string[] = [];
    for (const s of symbols) {
      // Indexes (^VIX …) are NOT on this feed: one of them makes the whole
      // snapshot request answer `400 invalid symbol` and kills realtime for
      // every equity in the batch. They are served by CboeIndexProvider.
      if (s.startsWith('^')) continue;
      const hit = this.cache.get(s);
      if (hit && now - hit.at < CACHE_TTL_MS) out.push(hit.quote);
      else pending.push(s);
    }
    if (pending.length > 0) {
      const started = Date.now();
      try {
        const res = await this.fetchImpl(SNAPSHOT_URL + encodeURIComponent(pending.join(',')), {
          headers: {
            'APCA-API-KEY-ID': this.keyId as string,
            'APCA-API-SECRET-KEY': this.secretKey as string,
            accept: 'application/json',
          },
        });
        this._latency = Date.now() - started;
        if (res.status === 401 || res.status === 403) {
          this._status = 'UNAVAILABLE';
          this._lastError = 'alpaca rejected the configured credentials';
          return out;
        }
        if (res.status === 429) {
          this._status = 'RATE_LIMITED';
          this._lastError = 'alpaca rate limit';
          return out;
        }
        if (!res.ok) {
          this._status = 'DEGRADED';
          this._lastError = `alpaca HTTP ${res.status}`;
          return out;
        }
        const body = (await res.json()) as Record<string, AlpacaSnapshot>;
        const at = Date.now();
        for (const [symbol, snap] of Object.entries(body)) {
          const quote = snapshotQuote(symbol, snap);
          if (!quote) continue;
          this.cache.set(symbol, { quote, at });
          out.push(quote);
        }
        this._status = 'CONNECTED';
        this._lastError = null;
        this._lastUpdate = Date.now();
      } catch (err) {
        this._latency = Date.now() - started;
        this._status = 'DEGRADED';
        this._lastError = err instanceof Error ? err.message : 'alpaca quote fetch failed';
      }
    } else if (out.length > 0) {
      // fully served from the hot cache — still fresh, keep CONNECTED
      this._status = 'CONNECTED';
      this._lastUpdate = now;
    }
    return out;
  }

  /** By design: EOD bar history stays with the Yahoo/Nasdaq path. */
  async getDailyBars(_symbol: string, _range?: string): Promise<Candle[]> {
    return [];
  }
}