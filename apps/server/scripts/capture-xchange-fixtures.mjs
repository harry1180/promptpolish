// Capture real frames from each public feed into apps/server/test/fixtures/xchange/.
// Sequential per provider (avoids per-IP connection throttling). Read-only.
import { mkdirSync, writeFileSync } from 'node:fs';
import WebSocket from 'ws';

const OUT = new URL('../test/fixtures/xchange/', import.meta.url);
mkdirSync(OUT, { recursive: true });

function capture(name, url, frames, seconds, maxMessages) {
  return new Promise((resolve) => {
    const messages = [];
    let ws = null;
    let opened = false;
    let error = null;
    const finish = () => {
      try { ws && ws.close(); } catch { /* ignore */ }
      resolve({ name, url, subscribe: frames, opened, error, messages });
    };
    const timer = setTimeout(finish, seconds * 1000);
    try { ws = new WebSocket(url, { handshakeTimeout: 10000 }); } catch (e) {
      error = String(e && e.message); clearTimeout(timer); return resolve({ name, url, subscribe: frames, opened, error, messages });
    }
    ws.on('open', () => {
      opened = true;
      for (const f of frames) { try { ws.send(f); } catch (e) { error = String(e && e.message); } }
    });
    ws.on('message', (d) => {
      const text = String(d);
      if (messages.length < maxMessages) messages.push(text);
      else finish();
    });
    ws.on('error', (e) => { error = String(e && e.message); });
    ws.on('close', () => { clearTimeout(timer); resolve({ name, url, subscribe: frames, opened, error, messages }); });
  });
}

const targets = [
  { name: 'coinbase', url: 'wss://ws-feed.exchange.coinbase.com', frames: [JSON.stringify({ type: 'subscribe', product_ids: ['BTC-USD', 'ETH-USD'], channels: ['ticker', 'matches'] })], seconds: 8, max: 30 },
  { name: 'binanceus', url: 'wss://stream.binance.us:9443/stream?streams=btcusdt@trade/btcusdt@ticker/btcusdt@depth10@100ms/ethusdt@trade/ethusdt@ticker', frames: [], seconds: 8, max: 40 },
  { name: 'gemini', url: 'wss://api.gemini.com/v1/marketdata/BTCUSD?subscribe=true', frames: [], seconds: 8, max: 40 },
  { name: 'bitstamp', url: 'wss://ws.bitstamp.net', frames: [JSON.stringify({ event: 'bts:subscribe', data: { channel: 'live_trades_btcusd' } }), JSON.stringify({ event: 'bts:subscribe', data: { channel: 'order_book_btcusd' } })], seconds: 8, max: 30 },
  { name: 'cryptocom', url: 'wss://stream.crypto.com/exchange/v1/market', frames: [JSON.stringify({ id: 1, method: 'subscribe', nonce: Date.now(), params: { channels: ['trade.BTC_USDT', 'ticker.BTC_USDT', 'book.BTC_USDT.50'] } })], seconds: 8, max: 30 },
];

for (const t of targets) {
  const cap = await capture(t.name, t.url, t.frames, t.seconds, t.max);
  writeFileSync(new URL(`${t.name}.json`, OUT), JSON.stringify(cap, null, 1));
  const kinds = {};
  for (const m of cap.messages) {
    let k = 'unparsed';
    try { const j = JSON.parse(m); k = j.stream ? `stream:${j.stream}` : (j.type ?? j.event ?? j.method ?? 'other'); } catch { /* */ }
    kinds[k] = (kinds[k] ?? 0) + 1;
  }
  console.log(`${t.name}: opened=${cap.opened} err=${cap.error ?? '-'} msgs=${cap.messages.length} ${JSON.stringify(kinds)}`);
}
