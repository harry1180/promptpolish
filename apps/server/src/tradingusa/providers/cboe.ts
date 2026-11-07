/**
 * Cboe delayed single-symbol quotes — the INDEX path (`^VIX`, `^GSPC`, …)
 * that only Yahoo used to serve.
 *
 * Why this provider exists: `api.nasdaq.com` has no index endpoint and
 * Alpaca's snapshot endpoint answers `400 invalid symbol: ^VIX` for the
 * WHOLE batch, so with Yahoo throttled from this host the VIX row never
 * landed and `macroParts()`' volatility term stayed inert.
 *
 * Endpoint (proven from this host, no key, no JS wall — batch endpoints 403):
 *   https://cdn.cboe.com/api/global/delayed_quotes/quotes/_VIX.json
 *   -> {"timestamp":"2026-11-03 02:02:15","data":{"symbol":"^VIX",
 *       "current_price":21.15,"price_change":1.73,"prev_day_close":19.42,…}}
 *
 * Provenance stays per quote: provider 'cboe', freshness 'DELAYED' — a
 * stored row never claims to be Yahoo data.
 */
import type { ProviderStatus, Quote } from '@promptslim/tucore';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

/** Yahoo-style index tickers mapped to the Cboe symbols that exist for them.
 *  Anything absent from this map is SKIPPED, never guessed: `^IXIC` (Nasdaq
 *  Composite) has no Cboe equivalent and NDX is a different index. */
const INDEX_SYMBOLS: Record<string, string> = {
  '^VIX': '_VIX',
  '^GSPC': '_SPX',
  '^SPX': '_SPX',
  '^DJI': '_DJI',
  '^NDX': '_NDX',
  '^RUT': '_RUT',
};

interface CboeBody {
  timestamp?: string;
  data?: {
    symbol?: string;
    current_price?: number;
    price_change?: number;
    prev_day_close?: number;
  };
}

export class CboeIndexProvider {
  readonly name = 'cboe';
  private fetchImpl: typeof fetch;
  private _status: ProviderStatus = 'UNAVAILABLE';
  private _lastError: string | null = null;
  private _lastUpdate = 0;

  constructor(deps: { fetchImpl?: typeof fetch } = {}) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  status(): ProviderStatus { return this._status; }
  lastError(): string | null { return this._lastError; }
  lastUpdate(): number { return this._lastUpdate; }

  async getQuotes(symbols: string[]): Promise<Quote[]> {
    const out: Quote[] = [];
    for (const sym of symbols) {
      const cboe = INDEX_SYMBOLS[sym];
      if (!cboe) continue;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10_000);
      try {
        const res = await this.fetchImpl(
          `https://cdn.cboe.com/api/global/delayed_quotes/quotes/${cboe}.json`,
          { headers: { 'user-agent': UA, accept: 'application/json' }, signal: ctrl.signal },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as CboeBody;
        const d = body.data;
        const price = Number(d?.current_price);
        if (!Number.isFinite(price) || price <= 0) continue;
        // `prev_day_close` came back equal to the last price on the delayed
        // feed; the change is authoritative, so derive prev close from it and
        // only use the field when there was no change at all.
        const change = Number(d?.price_change);
        const derived = Number.isFinite(change) ? price - change : Number.NaN;
        const prev = derived > 0 ? derived : Number(d?.prev_day_close);
        out.push({
          symbol: sym,
          price,
          prevClose: Number.isFinite(prev) && prev > 0 ? prev : price,
          ts: parseUtc(body.timestamp),
          provider: this.name,
          freshness: 'DELAYED',
        });
        this._status = 'CONNECTED';
        this._lastError = null;
        this._lastUpdate = Date.now();
      } catch (err) {
        this._status = 'DEGRADED';
        this._lastError = err instanceof Error ? err.message : 'cboe quote error';
      } finally {
        clearTimeout(timer);
      }
    }
    return out;
  }
}

/** Cboe stamps `timestamp` in UTC with no zone marker ("2026-11-03 02:02:15").
 *  Read it as UTC; any unparseable stamp falls back to now rather than to 0,
 *  so freshness never reads as years-old data. */
function parseUtc(stamp: string | undefined): number {
  if (typeof stamp !== 'string' || stamp.trim() === '') return Date.now();
  const iso = stamp.trim().replace(' ', 'T');
  const zoned = /(?:Z|z|[+-]\d\d:?\d\d)$/.test(iso);
  const ms = Date.parse(zoned ? iso : `${iso}Z`);
  return Number.isFinite(ms) ? ms : Date.now();
}
