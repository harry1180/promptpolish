// Supplementary capture: Binance.US trade+ticker (no depth flood) and a longer
// Gemini window to catch a `trade` event; also dump crypto.com method spread.
import { readFileSync, writeFileSync } from 'node:fs';
import WebSocket from 'ws';

const FIX = new URL('../test/fixtures/xchange/', import.meta.url);

function capture(url, frames, seconds, maxMessages) {
  return new Promise((resolve) => {
    const messages = [];
    let ws = null;
    let opened = false;
    let error = null;
    const finish = () => { try { ws && ws.close(); } catch { /* */ } resolve({ url, subscribe: frames, opened, error, messages }); };
    const timer = setTimeout(finish, seconds * 1000);
    try { ws = new WebSocket(url, { handshakeTimeout: 10000 }); } catch (e) {
      error = String(e && e.message); clearTimeout(timer); return resolve({ url, subscribe: frames, opened, error, messages });
    }
    ws.on('open', () => { opened = true; for (const f of frames) { try { ws.send(f); } catch (e) { error = String(e && e.message); } } });
    ws.on('message', (d) => { if (messages.length < maxMessages) messages.push(String(d)); else finish(); });
    ws.on('error', (e) => { error = String(e && e.message); });
    ws.on('close', () => { clearTimeout(timer); resolve({ url, subscribe: frames, opened, error, messages }); });
  });
}

function kind(m) {
  try { const j = JSON.parse(m); return j.stream ? `stream:${j.stream}` : (j.method ?? j.type ?? j.event ?? 'other'); } catch { return 'unparsed'; }
}

// 1) Binance.US trades + tickers only
const bu = await capture(
  'wss://stream.binance.us:9443/stream?streams=btcusdt@trade/btcusdt@ticker/ethusdt@trade',
  [], 10, 40,
);
writeFileSync(new URL('binanceus-trades.json', FIX), JSON.stringify(bu, null, 1));
const buKinds = {}; for (const m of bu.messages) buKinds[kind(m)] = (buKinds[kind(m)] ?? 0) + 1;
console.log('binanceus-trades:', bu.messages.length, JSON.stringify(buKinds));

// 2) Gemini longer window, BTCUSD + ETHUSD
const gm = await capture('wss://api.gemini.com/v1/marketdata/BTCUSD?subscribe=true', [], 20, 400);
writeFileSync(new URL('gemini-long.json', FIX), JSON.stringify({ ...gm, messages: gm.messages.slice(0, 200) }, null, 1));
const gmKinds = {}; let tradeEvents = 0;
for (const m of gm.messages) {
  gmKinds[kind(m)] = (gmKinds[kind(m)] ?? 0) + 1;
  try { const j = JSON.parse(m); if ((j.events ?? []).some((e) => e.type === 'trade')) tradeEvents += 1; } catch { /* */ }
}
console.log('gemini-long:', gm.messages.length, JSON.stringify(gmKinds), 'frames_with_trade=', tradeEvents);

// 3) crypto.com method spread (existing fixture)
const cc = JSON.parse(readFileSync(new URL('cryptocom.json', FIX), 'utf8'));
const ccKinds = {}; for (const m of cc.messages) ccKinds[kind(m)] = (ccKinds[kind(m)] ?? 0) + 1;
console.log('cryptocom methods:', JSON.stringify(ccKinds));
console.log('cryptocom sample non-ack:', (cc.messages.find((m) => !JSON.parse(m).id || JSON.parse(m).method !== 'subscribe') ?? 'NONE').slice(0, 400));
