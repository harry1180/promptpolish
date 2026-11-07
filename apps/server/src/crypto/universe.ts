/**
 * Crypto universe selection.
 *
 * The book trades a STABLE list on purpose: fusion weights, experiments and
 * lessons are fitted per instrument, so an instrument that enters and exits
 * weekly never accumulates enough evidence to teach anything.
 *
 * Composition: 6 PINNED symbols (never dropped, whatever their rank) plus
 * 19 slots ranked by market cap, filtered to coins Kraken actually quotes in
 * USD and excluding stablecoins / wrapped / tokenised assets.
 *
 * Rankings are refreshed daily, membership is not: a ranked member is only
 * dropped after sitting outside the top TOP_OUT for OUT_DROP_AFTER, and a
 * newcomer only enters after sitting inside the top TOP_IN for IN_ADD_AFTER
 * (hysteresis — ranks 22..29 sit within 0.5..8% of each other, so without it
 * the list would shuffle every day). Every change is reported to the caller
 * so it can be logged and shown in the UI.
 */
import type { DatabaseSync } from 'node:sqlite';

/** Read the persisted membership (hysteresis clocks included). */
export function loadUniverseStates(db: DatabaseSync): MemberState[] {
  const rows = db
    .prepare('SELECT symbol, pinned, active, out_since, in_since, last_rank FROM crypto_universe ORDER BY pinned DESC, symbol')
    .all() as unknown as Array<{
      symbol: string; pinned: number; active: number;
      out_since: number | null; in_since: number | null; last_rank: number | null;
    }>;
  return rows.map((r) => ({
    symbol: r.symbol, pinned: r.pinned === 1, active: r.active === 1,
    outSince: r.out_since, inSince: r.in_since, lastRank: r.last_rank,
  }));
}

/** Persist membership state — upsert so both seeds and daily refreshes land. */
export function saveUniverseStates(db: DatabaseSync, states: MemberState[], now = Date.now()): void {
  for (const s of states) {
    db.prepare(
      `INSERT INTO crypto_universe (symbol, pinned, active, out_since, in_since, last_rank, added_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(symbol) DO UPDATE SET pinned=excluded.pinned, active=excluded.active,
         out_since=excluded.out_since, in_since=excluded.in_since, last_rank=excluded.last_rank,
         updated_at=excluded.updated_at`,
    ).run(s.symbol, s.pinned ? 1 : 0, s.active ? 1 : 0, s.outSince, s.inSince, s.lastRank, now, now);
  }
}

export const PINNED = ['BTC', 'ETH', 'XRP', 'DOGE', 'XLM', 'SHIB'] as const;

/** How many ranked (non-pinned) slots the book holds. */
export const RANKED_SLOTS = 19;
/** Rank outside which a member starts its 7-day exit clock. */
export const TOP_OUT = 35;
/** Rank inside which a candidate starts its 3-day entry clock. */
export const TOP_IN = 20;
export const OUT_DROP_AFTER_MS = 7 * 86_400_000;
export const IN_ADD_AFTER_MS = 3 * 86_400_000;

/** Nothing here can be traded as an investment: pegged, wrapped, tokenised. */
const STABLES = new Set([
  'USDT', 'USDC', 'DAI', 'USDE', 'USD1', 'USDS', 'USDG', 'FDUSD', 'TUSD',
  'PYUSD', 'USDD', 'BUSD', 'USDP', 'GUSD', 'LUSD', 'FRAX', 'USDY', 'USTC',
  'USDBC', 'DEUSD', 'EURT', 'EURS', 'AEUR', 'XUSD', 'BFUSD', 'USDF',
  'RLUSD', 'EURC', 'USDA', 'USD1', 'USDE0',
]);
const WRAPPED_OR_SYNTHETIC = new Set([
  'WBTC', 'WETH', 'STETH', 'WSTETH', 'WEETH', 'RETH', 'CBETH', 'WBETH',
  'XAUT', 'PAXG', 'FIGR_HELOC', 'WBT', 'XMRG', 'RAIN', 'CC', 'LEO', 'BGB',
  'HYPE', 'ZRO', 'BLUR', 'JUP', 'W',
]);

export interface RankedCoin {
  symbol: string;
  rank: number;
  marketCap: number;
}

export interface MemberState {
  symbol: string;
  pinned: boolean;
  active: boolean;
  /** epoch ms since the symbol has been OUTSIDE the top 35 (exit clock) */
  outSince: number | null;
  /** epoch ms since the candidate has been INSIDE the top 20 (entry clock) */
  inSince: number | null;
  lastRank: number | null;
}

export interface UniverseDecision {
  states: MemberState[];
  added: string[];
  dropped: string[];
  /** the tradable list after the decision */
  symbols: string[];
}

function eligible(coin: RankedCoin, tradable: Set<string>): boolean {
  const s = coin.symbol.toUpperCase();
  if (!tradable.has(s)) return false;
  if (STABLES.has(s)) return false;
  if (WRAPPED_OR_SYNTHETIC.has(s)) return false;
  return true;
}

/** Ranking feed -> filtered, ordered candidates (CoinGecko shape). */
export function filterRanking(
  raw: Array<{ symbol?: string; market_cap?: number | null }>,
  tradable: Set<string>,
): RankedCoin[] {
  const out: RankedCoin[] = [];
  raw.forEach((c, i) => {
    const symbol = String(c.symbol ?? '').toUpperCase();
    if (!symbol) return;
    const coin: RankedCoin = { symbol, rank: i + 1, marketCap: Number(c.market_cap ?? 0) || 0 };
    if (eligible(coin, tradable)) out.push(coin);
  });
  return out;
}

/** Market-cap ranking from CoinGecko, filtered to what Kraken can quote. */
export async function fetchRanking(tradable: Set<string>): Promise<RankedCoin[]> {
  const url = 'https://api.coingecko.com/api/v3/coins/markets'
    + '?vs_currency=usd&order=market_cap_desc&per_page=100&page=1';
  const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': UA } });
  if (!res.ok) throw new Error(`coingecko HTTP ${res.status}`);
  const raw = (await res.json()) as Array<{ symbol?: string; market_cap?: number | null }>;
  return filterRanking(raw, tradable);
}

/** Kraken's legacy base codes -> the symbol the rest of the app uses. */
const KRAKEN_BASE_ALIASES: Record<string, string> = { XBT: 'BTC', XDG: 'DOGE' };
export function normalizeKrakenBase(base: string): string {
  const b = base.toUpperCase();
  return KRAKEN_BASE_ALIASES[b] ?? b;
}

/** Kraken's own USD universe: `altname` pairs are what the REST API accepts. */
export async function fetchTradable(): Promise<Set<string>> {
  const res = await fetch('https://api.kraken.com/0/public/AssetPairs', {
    headers: { accept: 'application/json', 'user-agent': UA },
  });
  if (!res.ok) throw new Error(`kraken AssetPairs HTTP ${res.status}`);
  const body = (await res.json()) as { error?: string[]; result?: Record<string, { altname?: string; quote?: string }> };
  if (body.error?.length) throw new Error(`kraken: ${body.error.join(', ')}`);
  const out = new Set<string>();
  for (const pair of Object.values(body.result ?? {})) {
    if (pair.quote !== 'ZUSD' && pair.quote !== 'USDT' && pair.quote !== 'USD') continue;
    if (!pair.altname?.endsWith('USD')) continue;
    const base = pair.altname.slice(0, -3); // strip trailing USD
    if (base.length > 0) out.add(normalizeKrakenBase(base));
  }
  return out;
}

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

/**
 * Cold start: with no history there is no evidence to protect, so the first
 * population is immediate — pinned members plus the best RANKED_SLOTS by rank.
 */
export function seedStates(ranking: RankedCoin[]): MemberState[] {
  const states: MemberState[] = PINNED.map((sym) => ({
    symbol: sym,
    pinned: true,
    active: true,
    outSince: null,
    inSince: null,
    lastRank: ranking.find((c) => c.symbol === sym)?.rank ?? null,
  }));
  for (const coin of ranking) {
    if (states.filter((s) => !s.pinned).length >= RANKED_SLOTS) break;
    if (states.some((s) => s.symbol === coin.symbol)) continue;
    states.push({
      symbol: coin.symbol, pinned: false, active: true,
      outSince: null, inSince: null, lastRank: coin.rank,
    });
  }
  return states;
}

/**
 * Pure hysteresis step: given the stored membership state and today's
 * filtered ranking, decide who enters and who leaves. Never touches IO.
 */
export function decideUniverse(
  states: MemberState[],
  ranking: RankedCoin[],
  now: number,
): UniverseDecision {
  const bySymbol = new Map(ranking.map((c) => [c.symbol, c]));
  const rankOf = (symbol: string): number | null => bySymbol.get(symbol)?.rank ?? null;

  const next: MemberState[] = states.map((s) => ({ ...s }));
  const known = new Set(next.map((s) => s.symbol));
  const added: string[] = [];
  const dropped: string[] = [];

  // every PINNED symbol is a member, even if the ranking never mentions it
  for (const sym of PINNED) {
    if (known.has(sym)) continue;
    next.push({ symbol: sym, pinned: true, active: true, outSince: null, inSince: null, lastRank: rankOf(sym) });
    known.add(sym);
    added.push(sym);
  }

  // ranked members: start/advance the exit clock when outside TOP_OUT
  for (const m of next) {
    if (m.pinned) continue;
    m.lastRank = rankOf(m.symbol);
    const rank = m.lastRank;
    if (!m.active) continue;
    if (rank != null && rank <= TOP_OUT) {
      m.outSince = null; // back inside the band: clock resets
      continue;
    }
    m.outSince = m.outSince ?? now;
    if (now - m.outSince >= OUT_DROP_AFTER_MS) {
      m.active = false;
      dropped.push(m.symbol);
    }
  }

  // candidates: advance the entry clock, promote when old enough, up to the slot budget
  const activeRanked = next.filter((m) => m.active && !m.pinned).length;
  let budget = Math.max(0, RANKED_SLOTS - activeRanked);
  const entrants = ranking
    .filter((c) => c.rank <= TOP_IN)
    .filter((c) => !next.some((m) => m.symbol === c.symbol && m.active))
    .sort((a, b) => a.rank - b.rank);

  for (const c of entrants) {
    if (budget <= 0) break;
    let state = next.find((m) => m.symbol === c.symbol);
    if (!state) {
      state = { symbol: c.symbol, pinned: false, active: false, outSince: null, inSince: now, lastRank: c.rank };
      next.push(state);
    }
    state.inSince = state.inSince ?? now;
    if (now - state.inSince >= IN_ADD_AFTER_MS) {
      state.active = true;
      state.inSince = null;
      state.outSince = null;
      added.push(c.symbol);
      budget -= 1;
    }
  }

  const symbols = next.filter((m) => m.active).map((m) => m.symbol);
  return { states: next, added, dropped, symbols };
}
