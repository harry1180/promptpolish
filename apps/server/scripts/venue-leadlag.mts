/**
 * Priority 1 measurement: cross-venue price-discovery leadership between the
 * EXISTING Kraken feed and a read-only Coinbase Exchange ticker stream.
 *
 * Shadow/research only: opens its own sockets, writes no orders, touches no
 * trade state. Local receive clock is the comparison clock for both venues
 * (documented limitation: cross-venue network paths differ).
 *
 *   node scripts/venue-leadlag.mts            # 4 min window
 *   LL_WINDOW_MS=600000 LL_THRESHOLD_BPS=1 node scripts/venue-leadlag.mts
 *
 * Output: compact summary + $TMPDIR/venue-leadlag.json
 */
import WebSocket from 'ws';
import { leadLagUpdate, newLeadLagState, type LeadLagState } from '../src/crypto/research.ts';

const PAIRS: Array<{ k: string; c: string }> = [
  { k: 'BTC/USD', c: 'BTC-USD' },
  { k: 'ETH/USD', c: 'ETH-USD' },
  { k: 'SOL/USD', c: 'SOL-USD' },
  { k: 'XRP/USD', c: 'XRP-USD' },
  { k: 'DOGE/USD', c: 'DOGE-USD' },
];
const WINDOW_MS = Number(process.env.LL_WINDOW_MS ?? 180_000);
const THRESHOLD_BPS = Number(process.env.LL_THRESHOLD_BPS ?? 1);
const FOLLOW_WINDOW_MS = 3_000;

interface PairStat {
  symbol: string;
  moves: { kraken: number; coinbase: number };
  followers: { kraken: number; coinbase: number };
  lags: number[];
  last: { kraken: number | null; coinbase: number | null };
}
const stats = new Map<string, PairStat>();
const states = new Map<string, LeadLagState>();
for (const p of PAIRS) {
  stats.set(p.k, { symbol: p.k, moves: { kraken: 0, coinbase: 0 }, followers: { kraken: 0, coinbase: 0 }, lags: [], last: { kraken: null, coinbase: null } });
  states.set(p.k, newLeadLagState());
}
const rev = new Map<string, string>(PAIRS.map((p) => [p.c, p.k]));

function onPrice(pairKey: string, venue: 'kraken' | 'coinbase', price: number): void {
  const st = stats.get(pairKey)!;
  const s = states.get(pairKey)!;
  st.last[venue] = price;
  const ev = leadLagUpdate(s, venue, price, Date.now(), { thresholdBps: THRESHOLD_BPS, windowMs: FOLLOW_WINDOW_MS });
  if (!ev) return;
  st.moves[venue] += 1;
  if (ev.follower) {
    st.followers[venue] += 1;
    if (ev.lagMs !== null) st.lags.push(ev.lagMs);
  }
}

let closed = false;
function connect(url: string, open: (w: WebSocket) => void, onMsg: (m: string) => void, tag: string): void {
  const w = new WebSocket(url);
  w.on('open', () => open(w));
  w.on('message', (m) => { try { onMsg(String(m)); } catch { /* ignore malformed */ } });
  w.on('error', () => { /* reconnect below */ });
  w.on('close', () => {
    if (closed) return;
    console.error(`[${tag}] closed, reconnecting in 2s`);
    setTimeout(() => connect(url, open, onMsg, tag), 2_000);
  });
}

connect(
  'wss://ws.kraken.com/v2',
  (w) => w.send(JSON.stringify({ method: 'subscribe', params: { channel: 'ticker', symbol: PAIRS.map((p) => p.k) } })),
  (m) => {
    const j = JSON.parse(m) as { channel?: string; data?: Array<{ symbol: string; bid: number; ask: number }> };
    if (j.channel !== 'ticker' || !Array.isArray(j.data)) return;
    for (const d of j.data) {
      const mid = (d.bid + d.ask) / 2;
      if (Number.isFinite(mid)) onPrice(d.symbol, 'kraken', mid);
    }
  },
  'kraken',
);

connect(
  'wss://ws-feed.exchange.coinbase.com',
  (w) => w.send(JSON.stringify({ type: 'subscribe', product_ids: PAIRS.map((p) => p.c), channels: ['ticker'] })),
  (m) => {
    const j = JSON.parse(m) as { type: string; product_id?: string; price?: string; best_bid?: string; best_ask?: string };
    if (j.type !== 'ticker' || !j.product_id) return;
    const pairKey = rev.get(j.product_id);
    if (!pairKey) return;
    const bid = Number(j.best_bid), ask = Number(j.best_ask);
    const mid = Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 ? (bid + ask) / 2 : Number(j.price);
    if (Number.isFinite(mid) && mid > 0) onPrice(pairKey, 'coinbase', mid);
  },
  'coinbase',
);

console.log(`lead-lag window ${WINDOW_MS / 1000}s | threshold ${THRESHOLD_BPS}bp | follow window ${FOLLOW_WINDOW_MS}ms | pairs ${PAIRS.length}`);
await new Promise((r) => setTimeout(r, WINDOW_MS));
closed = true;

const agg = { moves: { kraken: 0, coinbase: 0 }, followers: { kraken: 0, coinbase: 0 }, lags: [] as number[] };
const rows: unknown[] = [];
for (const st of stats.values()) {
  agg.moves.kraken += st.moves.kraken; agg.moves.coinbase += st.moves.coinbase;
  agg.followers.kraken += st.followers.kraken; agg.followers.coinbase += st.followers.coinbase;
  agg.lags.push(...st.lags);
  rows.push({
    symbol: st.symbol,
    krakenMoves: st.moves.kraken, krakenFollows: st.followers.kraken,
    coinbaseMoves: st.moves.coinbase, coinbaseFollows: st.followers.coinbase,
    connected: st.last.kraken !== null && st.last.coinbase !== null,
  });
}
const leaderShare = (v: 'kraken' | 'coinbase') => {
  const m = agg.moves[v], f = agg.followers[v];
  return m > 0 ? (m - f) / m : null;
};
const median = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);
const report = {
  generatedAt: Date.now(), windowMs: WINDOW_MS, thresholdBps: THRESHOLD_BPS,
  aggregate: {
    moves: agg.moves, followers: agg.followers,
    krakenLeaderShare: leaderShare('kraken'), coinbaseLeaderShare: leaderShare('coinbase'),
    medianLagMs: median(agg.lags), nLags: agg.lags.length,
  },
  perSymbol: rows,
  note: 'leadership = share of >=threshold moves NOT preceded by the other venue within 3s (local recv clock). Preliminary: short window, network-path asymmetry uncorrected.',
};
const { writeFileSync } = await import('node:fs');
const out = `${process.env.TMPDIR ?? '/tmp'}/venue-leadlag.json`;
writeFileSync(out, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 1));
console.log(`report -> ${out}`);
process.exit(0);
