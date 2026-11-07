/**
 * Coinbase Exchange (ws-feed.exchange.coinbase.com) WebSocket adapter.
 *
 * Subscribes to `ticker` + `matches` only: as of 2026-11 the level2 / level3 /
 * full book channels REQUIRE authentication, so no depth stream exists for an
 * anonymous feed. The venue's rejection text is surfaced through `onNote` so
 * `snapshot().note` shows the limitation, and book depth is therefore limited
 * to best_bid / best_ask sizes (no `bids`/`asks` arrays ever leave this file).
 *
 * Native frames -> CanonicalEvent:
 *   ticker               -> one 'ticker' event (top of book + last trade ids)
 *   match | last_match   -> one 'trade'  event, deduped by trade_id
 *   subscriptions/error/... -> control frames: no events (errors via onNote)
 *
 * Erasable-TypeScript only (no enums / parameter properties), relative imports
 * end in `.ts`.
 */
import type { CanonicalEvent } from '../types.ts';
import { WsFeed, type ParseContext, type VenueFeedConfig } from '../ws.ts';

export const COINBASE_FEED_URL = 'wss://ws-feed.exchange.coinbase.com';

const PROVIDER = 'coinbase';
/** channels an unauthenticated socket may subscribe to (level2/3 need auth) */
const CHANNELS = ['ticker', 'matches'];
/** bounded memory of emitted trade ids (insertion-ordered Set) */
const SEEN_TRADE_CAP = 2000;

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** native numeric strings -> number, null when absent/unparseable (never 0-by-default) */
function asNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string' || v.length === 0) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function asSide(v: unknown): 'buy' | 'sell' | null {
  return v === 'buy' || v === 'sell' ? v : null;
}

/** ISO-8601 exchange timestamp -> ms epoch, null when absent/unparseable */
function asExchangeTs(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

/** 'BTC-USD' -> base/quote/instrument, null for anything not BASE-QUOTE */
function splitProduct(v: unknown): { instrument: string; base: string; quote: string } | null {
  const instrument = asString(v);
  if (!instrument) return null;
  const parts = instrument.split('-');
  const base = parts[0] ?? '';
  const quote = parts[1] ?? '';
  if (!base || !quote) return null;
  return { instrument, base, quote };
}

function frameOf(text: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

function remember(seen: Set<string>, id: string): void {
  seen.add(id);
  while (seen.size > SEEN_TRADE_CAP) {
    const oldest = seen.values().next().value;
    if (oldest === undefined) break;
    seen.delete(oldest);
  }
}

/**
 * Pure native frame -> canonical events.
 *
 * `seen` carries the dedupe memory of trade ids already emitted (the feed owns
 * one instance; callers that want replay semantics pass their own). Control
 * frames (`subscriptions`, `error`, acks, anything unparseable) yield [].
 */
export function parseCoinbaseMessage(
  text: string,
  ctx: ParseContext,
  seen: Set<string> = new Set(),
): CanonicalEvent[] {
  const msg = frameOf(text);
  if (!msg) return [];
  const kind = typeof msg.type === 'string' ? msg.type : '';

  if (kind === 'ticker') {
    const product = splitProduct(msg.product_id);
    if (!product || !ctx.symbols.has(product.base)) return []; // not ours
    return [
      {
        provider: PROVIDER,
        instrument: product.instrument,
        base: product.base,
        quote: product.quote,
        productType: 'SPOT',
        type: 'ticker',
        eventId: msg.trade_id === null || msg.trade_id === undefined ? null : String(msg.trade_id),
        exchangeTs: asExchangeTs(msg.time),
        recvTs: ctx.now,
        processTs: ctx.now,
        price: asNumber(msg.price),
        size: asNumber(msg.last_size),
        side: asSide(msg.side),
        bid: asNumber(msg.best_bid),
        bidQty: asNumber(msg.best_bid_size),
        ask: asNumber(msg.best_ask),
        askQty: asNumber(msg.best_ask_size),
        // no L2 stream without auth -> depth is best bid/ask only
        bids: null,
        asks: null,
        seq: asNumber(msg.sequence),
        channel: 'ticker',
        freshness: 'REALTIME',
        bookValid: true,
      },
    ];
  }

  if (kind === 'match' || kind === 'last_match') {
    const product = splitProduct(msg.product_id);
    if (!product || !ctx.symbols.has(product.base)) return []; // not ours
    const tradeId = msg.trade_id === null || msg.trade_id === undefined ? null : String(msg.trade_id);
    if (tradeId !== null) {
      // ticker and match echo the same trade: the trade comes from
      // match/last_match, and a trade_id already emitted never repeats
      if (seen.has(tradeId)) return [];
      remember(seen, tradeId);
    }
    return [
      {
        provider: PROVIDER,
        instrument: product.instrument,
        base: product.base,
        quote: product.quote,
        productType: 'SPOT',
        type: 'trade',
        eventId: tradeId,
        exchangeTs: asExchangeTs(msg.time),
        recvTs: ctx.now,
        processTs: ctx.now,
        price: asNumber(msg.price),
        size: asNumber(msg.size),
        side: asSide(msg.side),
        bid: null,
        bidQty: null,
        ask: null,
        askQty: null,
        bids: null,
        asks: null,
        seq: asNumber(msg.sequence),
        channel: 'matches',
        freshness: 'REALTIME',
        bookValid: true,
      },
    ];
  }

  return []; // subscriptions acks, errors (see coinbaseNote), heartbeats, acks
}

/**
 * Control frames worth showing in `snapshot().note` — subscription rejections
 * arrive as normal frames, never as socket errors (the level2/level3 auth
 * limitation is reported exactly as the venue words it).
 */
export function coinbaseNote(text: string): string | null {
  const msg = frameOf(text);
  if (!msg || msg.type !== 'error') return null;
  return asString(msg.message) ?? asString(msg.reason) ?? 'coinbase: unknown error';
}

/** Coinbase Exchange feed: ticker + matches, anonymous (no L2/depth). */
export function createCoinbaseFeed(cfg: VenueFeedConfig): WsFeed {
  const seen = new Set<string>();
  const productIds = cfg.symbols.map((base) => `${base}-${cfg.quote}`);
  const subscribe = JSON.stringify({ type: 'subscribe', product_ids: productIds, channels: CHANNELS });
  return new WsFeed({
    id: PROVIDER,
    label: 'Coinbase Exchange',
    url: COINBASE_FEED_URL,
    symbols: cfg.symbols,
    channels: CHANNELS,
    subscribeFrames: () => [subscribe],
    parse: (text, ctx) => parseCoinbaseMessage(text, ctx, seen),
    onNote: coinbaseNote,
    onEvent: cfg.onEvent,
    ...(cfg.socketFactory ? { socketFactory: cfg.socketFactory as (url: string) => never } : {}),
    ...(cfg.now ? { now: cfg.now } : {}),
  });
}


