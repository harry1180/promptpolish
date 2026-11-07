/**
 * Nasdaq public historical API — official JSON endpoint, no key, no JS
 * wall. Used as the daily-bar FALLBACK source when Yahoo is throttled.
 * Prices arrive as strings ('$343.46' / '763.25') and dates as MM/DD/YYYY.
 * Provenance is stored as 'nasdaq-eod' — never silently mixed with another
 * source's freshness label.
 */
import type { Candle, ProviderStatus, Quote } from '@promptslim/tucore';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

function num(s: string | undefined): number | null {
  if (s == null) return null;
  const v = Number(String(s).replace(/[$,]/g, '').trim());
  return Number.isFinite(v) ? v : null;
}

function isoDate(us: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(us.trim());
  if (!m) return null;
  return `${m[3]}-${m[1]}-${m[2]}`;
}

const NY_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});

/** Offset (New York local - UTC) in ms at a given instant. */
function nyOffsetMs(ts: number): number {
  const parts: Record<string, string> = {};
  for (const p of NY_FORMAT.formatToParts(ts)) if (p.type !== 'literal') parts[p.type] = p.value;
  const asUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour) % 24, Number(parts.minute), Number(parts.second),
  );
  return asUtc - ts;
}

/** Nasdaq stamps trades as 'Oct 19, 2026 2:50 PM ET' (New York local time).
 *  Date.parse reads that in the host zone, so resolve it against the NY
 *  offset; two fixed-point passes settle DST boundaries. */
function etLocalToEpoch(stamp: string | undefined): number {
  const naive = Date.parse(String(stamp ?? '').replace(/\s+ET$/, ''));
  if (!Number.isFinite(naive)) return Date.now();
  let ts = naive;
  for (let i = 0; i < 3; i++) ts = naive - nyOffsetMs(ts);
  return ts;
}

export class NasdaqEodProvider {
  readonly name = 'nasdaq-eod';
  private fetchImpl: typeof fetch;
  private _status: ProviderStatus = 'UNAVAILABLE';
  private _lastError: string | null = null;
  /** per-symbol quote cache so the concurrent call sites (quote poll,
   *  position monitor, order processing, signal scan) share one request. */
  private quoteCache = new Map<string, { quote: Quote; at: number }>();
  private lastRequestAt = 0;

  constructor(deps: { fetchImpl?: typeof fetch } = {}) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  status(): ProviderStatus { return this._status; }
  lastError(): string | null { return this._lastError; }

  /** Live quotes from api.nasdaq.com (no key, no JS wall). Yahoo stays the
   *  primary source — this path is only reached when Yahoo yields nothing.
   *  Provenance is 'nasdaq' / 'DELAYED': a stored row never claims Yahoo. */
  async getQuotes(symbols: string[]): Promise<Quote[]> {
    const TTL_MS = 15_000;
    const PACE_MS = 200;
    const MAX_SYMBOLS = 30;
    const now = Date.now();
    const out: Quote[] = [];
    const pending: string[] = [];
    for (const s of symbols.slice(0, MAX_SYMBOLS)) {
      if (s.startsWith('^')) continue; // indexes are not on this endpoint
      const hit = this.quoteCache.get(s);
      if (hit && now - hit.at < TTL_MS) out.push(hit.quote);
      else pending.push(s);
    }
    for (const sym of pending) {
      const wait = PACE_MS - (Date.now() - this.lastRequestAt);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      const quote = await this.quoteFromInfo(sym);
      this.lastRequestAt = Date.now();
      if (quote) {
        this.quoteCache.set(sym, { quote, at: Date.now() });
        out.push(quote);
      }
    }
    if (out.length > 0) {
      this._status = 'CONNECTED';
      this._lastError = null;
    }
    return out;
  }

  private async quoteFromInfo(ticker: string): Promise<Quote | null> {
    for (const assetClass of ['stocks', 'etf']) {
      const url = `https://api.nasdaq.com/api/quote/${encodeURIComponent(ticker)}/info?assetclass=${assetClass}`;
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 10_000);
        const res = await this.fetchImpl(url, {
          headers: { 'user-agent': UA, accept: 'application/json' },
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as {
          data?: { primaryData?: {
            lastSalePrice?: string; netChange?: string; volume?: string; lastTradeTimestamp?: string;
          } } | null;
        };
        const p = body.data?.primaryData;
        const price = num(p?.lastSalePrice ?? undefined);
        if (price == null || price <= 0) continue; // try the other asset class
        const change = num(p?.netChange ?? undefined);
        const prev = change != null ? price - change : price;
        const volume = num(p?.volume ?? undefined);
        return {
          symbol: ticker, price, prevClose: prev > 0 ? prev : price,
          ts: etLocalToEpoch(p?.lastTradeTimestamp), volume: volume ?? undefined,
          provider: 'nasdaq', freshness: 'DELAYED',
        };
      } catch (err) {
        this._status = 'DEGRADED';
        this._lastError = err instanceof Error ? err.message : 'nasdaq quote error';
      }
    }
    return null;
  }

  async getDailyBars(ticker: string, rangeOrFrom?: string): Promise<Candle[]> {
    // callers may pass a Yahoo-style range ('2y') — translate instead of
    // forwarding garbage dates to the API
    const validIso = typeof rangeOrFrom === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rangeOrFrom);
    const daysBack = (() => {
      const m = /^(\d+)([dm])$/.exec(String(rangeOrFrom ?? ''));
      if (!m) return 740;
      return m[2] === 'd' ? Number(m[1]) : Number(m[1]) * 30;
    })();
    const from = validIso
      ? (rangeOrFrom as string)
      : new Date(Date.now() - Math.max(30, daysBack) * 86400_000).toISOString().slice(0, 10);
    const to = new Date().toISOString().slice(0, 10);
    for (const assetClass of ['stocks', 'etf']) {
      const url =
        `https://api.nasdaq.com/api/quote/${encodeURIComponent(ticker)}/historical` +
        `?assetclass=${assetClass}&fromdate=${from}&todate=${to}&limit=700`;
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 15_000);
        const res = await this.fetchImpl(url, {
          headers: { 'user-agent': UA, accept: 'application/json' },
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as {
          data?: { tradesTable?: { rows?: Array<{ date: string; open: string; high: string; low: string; close: string; volume: string }> } } | null;
        };
        const rows = body.data?.tradesTable?.rows ?? [];
        if (rows.length === 0) continue; // try the other asset class
        const bars: Candle[] = [];
        for (const r of rows) {
          const date = isoDate(r.date);
          const open = num(r.open), high = num(r.high), low = num(r.low), close = num(r.close);
          if (!date || open == null || high == null || low == null || close == null) continue;
          bars.push({ date, open, high, low, close, volume: num(r.volume) ?? 0 });
        }
        bars.sort((a, b) => a.date.localeCompare(b.date));
        if (bars.length > 0) {
          this._status = 'CONNECTED';
          this._lastError = null;
          return bars;
        }
      } catch (err) {
        this._status = 'DEGRADED';
        this._lastError = err instanceof Error ? err.message : 'nasdaq error';
      }
    }
    return [];
  }
}
