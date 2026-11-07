/**
 * Kraken public REST — primary crypto data source (verified from this host:
 * ticker + OHLC answer in ~50ms, no key, no JS wall).
 *
 *   ticker: /0/public/Ticker?pair=BTCUSD,XRPUSD        -> last, 24h vwap/vol/hi/lo
 *   ohlc:   /0/public/OHLC?pair=BTCUSD&interval=1440  -> daily bars, 720/page
 *   pairs:  /0/public/AssetPairs                      -> the tradable universe
 *
 * Provenance: quotes are stamped REALTIME/'kraken' — the price IS the current
 * last trade, observed at `ts`. Bars are EOD ('kraken'). Nothing is ever
 * relabelled as another source.
 */
import type { Candle, Quote } from '@promptslim/tucore';
import { normalizeKrakenBase } from '../universe.ts';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const BASE = 'https://api.kraken.com/0/public';

/** Kraken's pair naming is legacy in three places (BTC=XBT, DOGE=XDG, ...). */
const PAIR_ALIASES: Record<string, string> = {
  BTC: 'XBTUSD', DOGE: 'XDGUSD', ETH: 'ETHUSD', XRP: 'XRPUSD', XLM: 'XLMUSD',
};

/**
 * Responses are keyed by Kraken's CANONICAL pair name (requesting XBTUSD
 * comes back as XXBTZUSD), so results must be resolved through AssetPairs
 * rather than by position. Cached for an hour.
 */
let pairIndexCache: { at: number; map: Map<string, string> } | null = null;
async function pairIndex(): Promise<Map<string, string>> {
  if (pairIndexCache && Date.now() - pairIndexCache.at < 3_600_000) return pairIndexCache.map;
  const body = await get<{ result: Record<string, { altname?: string; quote?: string }> }>('AssetPairs', {});
  const map = new Map<string, string>();
  for (const [canonical, p] of Object.entries(body.result ?? {})) {
    if (!p.altname || !p.altname.endsWith('USD')) continue;
    if (p.quote !== 'ZUSD' && p.quote !== 'USD') continue;
    const base = p.altname.slice(0, -3);
    const symbol = normalizeKrakenBase(base);
    map.set(canonical, symbol);
    map.set(p.altname.toUpperCase(), symbol);
  }
  pairIndexCache = { at: Date.now(), map };
  return map;
}

export function pairFor(symbol: string): string {
  const s = symbol.toUpperCase();
  return PAIR_ALIASES[s] ?? `${s}USD`;
}

async function get<T>(path: string, params: Record<string, string>): Promise<T> {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${BASE}/${path}?${qs}`, {
    headers: { accept: 'application/json', 'user-agent': UA },
  });
  if (!res.ok) throw new Error(`kraken ${path} HTTP ${res.status}`);
  const body = (await res.json()) as { error?: string[] } & Record<string, unknown>;
  if (Array.isArray(body.error) && body.error.length > 0) {
    throw new Error(`kraken ${path}: ${body.error.join(', ')}`);
  }
  return body as T;
}

interface TickerResult {
  a: string[]; // ask [price, wholeLotVol, lotVol]
  b: string[]; // bid
  c: string[]; // last trade [price, lotVol]
  v: string[]; // volume [24h, today]
  p: string[]; // vwap [24h, today]
  t: number[]; // trade count [24h, today]
  l: string[]; // low
  h: string[]; // high
}

export interface CryptoQuote extends Quote {
  bid?: number;
  ask?: number;
}

/**
 * Batch last-price snapshot — one request per 20 pairs. Results are matched
 * back to symbols through AssetPairs (see pairIndex), never by position:
 * Kraken returns canonical keys and can reorder them.
 */
export async function getTickers(symbols: string[], now = Date.now()): Promise<CryptoQuote[]> {
  const wanted = new Set(symbols.map((s) => s.toUpperCase()));
  const pairs = symbols.map(pairFor);
  const index = await pairIndex();
  const out: CryptoQuote[] = [];

  for (let i = 0; i < pairs.length; i += 20) {
    const chunk = pairs.slice(i, i + 20);
    const body = await get<{ result: Record<string, TickerResult> }>('Ticker', { pair: chunk.join(',') });
    for (const [key, t] of Object.entries(body.result ?? {})) {
      const symbol = index.get(key);
      if (!symbol || !wanted.has(symbol)) continue;
      const price = Number(t?.c?.[0]);
      if (!Number.isFinite(price) || price <= 0) continue;
      const bid = Number(t.b?.[0]);
      const ask = Number(t.a?.[0]);
      out.push({
        symbol,
        price,
        // Kraken's ticker carries no prior close; the caller replaces this
        // with yesterday's bar close before storing (change% comes from bars).
        prevClose: price,
        ts: now,
        bid: Number.isFinite(bid) ? bid : undefined,
        ask: Number.isFinite(ask) ? ask : undefined,
        volume: Number(t.v?.[0]),
        provider: 'kraken',
        freshness: 'REALTIME',
      });
    }
  }
  return out;
}

/** [time, open, high, low, close, vwap, volume, tradeCount] */
type OhlcRow = [number, string, string, string, string, string, string, number];

function toCandle(row: OhlcRow): Candle | null {
  const open = Number(row[1]);
  const high = Number(row[2]);
  const low = Number(row[3]);
  const close = Number(row[4]);
  if (![open, high, low, close].every((n) => Number.isFinite(n) && n > 0)) return null;
  return {
    date: new Date(row[0] * 1000).toISOString().slice(0, 10),
    open, high, low, close,
    volume: Number(row[6]) || 0,
  };
}

/** Daily OHLCV, paginated backwards through Kraken's 720-candle pages. */
export async function getDailyBars(
  symbol: string,
  days = 730,
  now = Date.now(),
): Promise<Candle[]> {
  const pair = pairFor(symbol);
  const interval = 1440; // 1d
  const end = Math.floor(now / 1000);
  const start = end - days * 86_400;
  const candles = new Map<string, Candle>();
  let since = start;

  for (let page = 0; page < 12 && since < end; page++) {
    const body = await get<{ result: Record<string, OhlcRow[] | number> }>('OHLC', {
      pair,
      interval: String(interval),
      since: String(since),
    });
    const rows = (body.result[pair] ?? body.result[Object.keys(body.result).find((k) => k !== 'last') ?? '']) as
      | OhlcRow[]
      | undefined;
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const row of rows) {
      const c = toCandle(row);
      if (c && c.date >= new Date(start * 1000).toISOString().slice(0, 10)) candles.set(c.date, c);
    }
    const lastRow = rows[rows.length - 1];
    const nextSince = Number(lastRow?.[0] ?? 0);
    if (!Number.isFinite(nextSince) || nextSince <= since) break;
    since = nextSince;
    if (rows.length < 720) break; // short page: we reached the present
  }

  return [...candles.values()].sort((a, b) => a.date.localeCompare(b.date));
}
