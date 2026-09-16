import type { OptimizationLevel } from '@promptslim/shared-types';

/**
 * Prompt-cache engine — fully local, browser/DOM-free (web app + extension
 * share it unchanged; the storage backend is injected).
 *
 * Design grounded in 2024–2026 practice (GPTCache, "GPT Semantic Cache"
 * arXiv:2411.05276, Caffeine W-TinyLFU trace studies, SIEVE SIGCOMM'23):
 *
 * 1. Two lookup layers, like production semantic caches:
 *    - exact layer: canonicalized-prompt match (GPTCache's "key-get" step;
 *      deterministic, zero false positives — this covers "same prompt twice")
 *    - semantic layer: feature-vector cosine similarity (GPTCache's
 *      "similar-hit" step; here TF feature-hashing vectors — an honest
 *      offline stand-in for embedding models, labeled as lexical similarity
 *      everywhere in the UI)
 *
 * 2. Similarity bands (semantic-cache literature recommends ~0.8–0.92
 *    serving bars; three zones):
 *      >= strong bar  -> HIT, response may be served (governance permitting)
 *      >= partial bar -> NEIGHBOR: advisory only. Content is NEVER served
 *                        across prompts in this band; at most the neighbor's
 *                        response-SHAPE stat (its output token count)
 *                        surfaces as a calibration hint, and only when both
 *                        sides are governance-clean and levels agree.
 *      below          -> MISS
 *
 * 3. Governance interlock (fail-closed): callers must screen every query for
 *    sensitive data before cross-prompt reuse. Semantic serving requires BOTH
 *    the query and the cached entry to be clean. Exact same-prompt reuse is
 *    always allowed — the user's own data, their own browser, their prior
 *    identical request.
 *
 * 4. Eviction-policy comparison: the live cache runs SIEVE and is the only
 *    thing that SERVES. Five shadow policies (LRU, LFU, TinyLFU, FIFO,
 *    Belady-MIN) observe the same request stream with their own membership,
 *    so hit rates genuinely diverge; entry data is retained beyond live
 *    eviction (bounded) so shadows can recompute similarity for keys they
 *    kept. Belady is an offline replay over the recorded access log — a
 *    true-optimal upper bound, not shippable. The UI shows all six plus the
 *    gap-to-optimal for the live policy.
 */

// ---------------------------------------------------------------------------
// policy registry + metadata (drives the UI comparison table)
// ---------------------------------------------------------------------------

export type EvictionPolicyId = 'sieve' | 'lru' | 'lfu' | 'tinylfu' | 'fifo' | 'belady';

export interface EvictionPolicyInfo {
  id: EvictionPolicyId;
  label: string;
  oneLiner: string;
  pros: string;
  cons: string;
  oracle: boolean;
  live: boolean;
}

export const EVICTION_POLICIES: EvictionPolicyInfo[] = [
  {
    id: 'sieve',
    label: 'SIEVE',
    oneLiner: 'Insertion-ordered queue where every entry carries one “hit bit”; the eviction hand sweeps from the tail, rotating hit-bit entries to the head and evicting the first untouched one.',
    pros: 'SIGCOMM\u201923: 1.2\u20131.7x LRU hit rate at equal size with LESS metadata than LRU; one-hit wonders are swept out cheaply so hot entries survive scans.',
    cons: 'Young (2023); on uniform-random traffic it behaves like FIFO; sweep is O(cache) worst case per eviction.',
    oracle: false,
    live: true,
  },
  {
    id: 'lru',
    label: 'LRU',
    oneLiner: 'Evict the entry whose most recent access is oldest.',
    pros: 'The universal baseline; captures temporal locality; O(1) with a linked list.',
    cons: 'One scan can evict the whole cache; recency-only, blind to frequency.',
    oracle: false,
    live: false,
  },
  {
    id: 'lfu',
    label: 'LFU',
    oneLiner: 'Evict the entry with the lowest hit counter (ties: oldest).',
    pros: 'Keeps genuinely popular entries; scan-resistant.',
    cons: 'No aging: yesterday\u2019s fad squat in the cache forever; ignores recency.',
    oracle: false,
    live: false,
  },
  {
    id: 'tinylfu',
    label: 'TinyLFU',
    oneLiner: 'Count-Min sketch frequency estimator + small admission window feeding an LRU main segment (Caffeine design).',
    pros: 'Caffeine 43.7M-request trace: ~45% hits vs ~20% LRU, close to Belady\u2019s ~48% optimum; strongly scan-resistant.',
    cons: 'Most machinery of the six; sketch collisions can mis-admit; weak on first-seen bursts.',
    oracle: false,
    live: false,
  },
  {
    id: 'fifo',
    label: 'FIFO',
    oneLiner: 'Evict the oldest inserted entry, ignoring all reuse.',
    pros: 'One queue, zero bookkeeping; the honest floor for comparisons.',
    cons: 'Blind to recency AND frequency; collapses on skewed workloads.',
    oracle: false,
    live: false,
  },
  {
    id: 'belady',
    label: 'Belady (MIN)',
    oneLiner: 'Evict whatever is used farthest in the FUTURE — provably optimal offline; replayed here over the recorded access log.',
    pros: 'Theoretical upper bound: the “gap to optimal” measures what any practical policy leaves on the table.',
    cons: 'Oracle — needs the future; cannot ship. Shadow-only, computed offline per stats() call.',
    oracle: true,
    live: false,
  },
];

export interface PolicyStats {
  policy: EvictionPolicyId;
  hits: number;
  lookups: number;
  hitRate: number; // 0-1
  evictions: number;
}

// ---------------------------------------------------------------------------
// entries + store
// ---------------------------------------------------------------------------

export interface CacheEntryData {
  id: string;
  prompt: string;
  canonical: string;
  vector: Map<number, number>;
  norm: number;
  modelId: string;
  level: OptimizationLevel;
  governanceClean: boolean;
  createdAt: number;
  lastAccessAt: number;
  hits: number;
  payload: Record<string, unknown>;
}

export interface CacheStore {
  load(): CacheEntryData[];
  save(entries: CacheEntryData[]): void;
  clear(): void;
}

/** Storage adapter (localStorage in web; chrome.storage.local in Phase 2). */
export function makeCacheStore(
  storage: { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void },
  key = 'promptslim.cache.v1',
): CacheStore {
  return {
    load() {
      try {
        const raw = storage.getItem(key);
        if (!raw) return [];
        const arr = JSON.parse(raw) as Array<Record<string, unknown>>;
        return arr.map((e) => ({
          ...e,
          vector: new Map((e.vector as Array<[number, number]>).map(([k, v]) => [k, v])),
        })) as unknown as CacheEntryData[];
      } catch {
        return [];
      }
    },
    save(entries) {
      try {
        storage.setItem(
          key,
          JSON.stringify(entries.map((e) => ({ ...e, vector: Array.from(e.vector.entries()) }))),
        );
      } catch {
        /* quota or unavailable — cache is best-effort by design */
      }
    },
    clear() {
      storage.removeItem(key);
    },
  };
}

/** In-memory store (tests; default when no storage is injected). */
export function makeMemoryStore(): CacheStore {
  let data: CacheEntryData[] = [];
  return {
    load: () => data.map((e) => ({ ...e, vector: new Map(e.vector) })),
    save: (entries) => { data = entries.map((e) => ({ ...e, vector: new Map(e.vector) })); },
    clear: () => { data = []; },
  };
}

// ---------------------------------------------------------------------------
// local semantic features: hashing-trick TF over word unigrams + bigrams
// ---------------------------------------------------------------------------

const FEATURE_DIM = 4096;

function wordsOf(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9\u00c0-\u024f]+/g) ?? [];
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Term-frequency vector via the hashing trick (unigrams + bigrams).
 * NOT embeddings: strong for near-duplicate phrasing, weak for
 * cross-vocabulary paraphrase. The UI must call this "local lexical
 * similarity" — never "semantic understanding".
 */
export function featurize(text: string): { vector: Map<number, number>; norm: number } {
  const ws = wordsOf(text);
  const vector = new Map<number, number>();
  const add = (tok: string) => {
    const idx = hashString(tok) % FEATURE_DIM;
    vector.set(idx, (vector.get(idx) ?? 0) + 1);
  };
  for (const w of ws) add(w);
  for (let i = 0; i + 1 < ws.length; i++) add(`${ws[i]} ${ws[i + 1]}`);
  let norm = 0;
  for (const v of vector.values()) norm += v * v;
  return { vector, norm: Math.sqrt(norm) };
}

export function cosine(
  a: Map<number, number>, an: number, b: Map<number, number>, bn: number,
): number {
  if (an === 0 || bn === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [idx, v] of small) {
    const other = large.get(idx);
    if (other) dot += v * other;
  }
  return dot / (an * bn);
}

/** Exact-layer key: case/space/punctuation-insensitive, placeholders kept. */
export function canonicalizePrompt(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N}\s{}[\]$]/gu, '')
    .trim();
}

// ---------------------------------------------------------------------------
// lookup result
// ---------------------------------------------------------------------------

export type LookupStatus =
  | 'exact-hit'           // same normalized prompt, same model+level — served
  | 'semantic-hit'        // >= strong bar, clean+clean, same level — served
  | 'partial'             // >= partial bar: neighbor shown, content NOT served
  | 'miss'                // nothing close (or level mismatch on a strong match)
  | 'blocked-governance'; // strong match refused by governance

export interface LookupResult {
  status: LookupStatus;
  /** set ONLY for served statuses — what the live cache returns */
  entry: CacheEntryData | null;
  /** best match id in ANY band (for policy accounting), else null */
  matchedId: string | null;
  similarity: number; // 0-1; 1 for exact
  note: string;
  /** governance-safe shape hint for the partial band (never content) */
  partialContext?: {
    sameLevel: boolean;
    bothClean: boolean;
    neighborOutputTokens: number | null;
  };
}

// ---------------------------------------------------------------------------
// online shadow policy backends (membership owned by the cache)
// ---------------------------------------------------------------------------

interface PolicyBackend {
  onGet(id: string): void;
  onPut(id: string): void;
  onEvict(live: Set<string>): string;
}

class FifoPolicy implements PolicyBackend {
  private queue: string[] = [];
  onGet(): void { /* insertion order only */ }
  onPut(id: string): void { this.queue.push(id); }
  onEvict(live: Set<string>): string {
    while (this.queue.length) {
      const id = this.queue.shift()!;
      if (live.has(id)) return id;
    }
    return '';
  }
}

class LruPolicy implements PolicyBackend {
  private stack: string[] = [];
  onGet(id: string): void {
    const i = this.stack.indexOf(id);
    if (i >= 0) { this.stack.splice(i, 1); this.stack.push(id); }
  }
  onPut(id: string): void { this.stack.push(id); }
  onEvict(live: Set<string>): string {
    while (this.stack.length) {
      const id = this.stack.shift()!;
      if (live.has(id)) return id;
    }
    return '';
  }
}

class LfuPolicy implements PolicyBackend {
  private counts = new Map<string, number>();
  private order = new Map<string, number>();
  private seq = 0;
  onGet(id: string): void { this.counts.set(id, (this.counts.get(id) ?? 0) + 1); }
  onPut(id: string): void {
    if (!this.counts.has(id)) { this.counts.set(id, 1); this.order.set(id, this.seq++); }
  }
  onEvict(live: Set<string>): string {
    let best = '';
    let bestC = Infinity;
    let bestO = Infinity;
    for (const id of live) {
      const c = this.counts.get(id) ?? 0;
      const o = this.order.get(id) ?? 0;
      if (c < bestC || (c === bestC && o < bestO)) { best = id; bestC = c; bestO = o; }
    }
    return best;
  }
}

/** SIEVE (Zhang et al., SIGCOMM'23): insertion order + one hit bit + hand. */
export class SievePolicy implements PolicyBackend {
  private queue: string[] = [];
  private visited = new Set<string>();
  private hand = -1;
  onGet(id: string): void { this.visited.add(id); }
  onPut(id: string): void { this.queue.push(id); }
  onEvict(live: Set<string>): string {
    if (!this.queue.length) return '';
    for (let scanned = 0; scanned <= this.queue.length * 2; scanned++) {
      if (this.hand < 0) this.hand = this.queue.length - 1;
      if (this.hand >= this.queue.length) this.hand = this.queue.length - 1;
      const id = this.queue[this.hand];
      if (id === undefined) break;
      if (!live.has(id)) { // stale node: drop quietly, keep sweeping
        this.queue.splice(this.hand, 1);
        continue;
      }
      if (this.visited.has(id)) {
        // rotation rule: clear bit, move entry to head, hand STAYS
        this.visited.delete(id);
        this.queue.splice(this.hand, 1);
        this.queue.unshift(id);
        continue;
      }
      this.queue.splice(this.hand, 1);
      if (this.hand >= this.queue.length) this.hand = this.queue.length - 1;
      return id;
    }
    const fallback = this.queue.shift() ?? '';
    this.visited.delete(fallback);
    return fallback;
  }
}

/** TinyLFU shadow: 4-row Count-Min sketch + window + LRU main (Caffeine-ish). */
export class TinyLfuPolicy implements PolicyBackend {
  private sketch: Uint32Array;
  private width: number;
  private window: string[] = [];
  private main: string[] = [];
  private windowMax: number;
  private capacity: number;
  constructor(capacity: number) {
    this.capacity = Math.max(2, capacity);
    this.width = Math.max(1024, this.capacity * 8);
    this.sketch = new Uint32Array(4 * this.width);
    this.windowMax = Math.max(1, Math.floor(this.capacity * 0.12));
  }
  private rows(id: string): number[] {
    const out: number[] = [];
    for (let r = 0; r < 4; r++) out.push(r * this.width + (hashString(`${id}#${r}`) % this.width));
    return out;
  }
  private bump(id: string): void { for (const p of this.rows(id)) this.sketch[p]++; }
  estimate(id: string): number {
    let min = Infinity;
    for (const p of this.rows(id)) min = Math.min(min, this.sketch[p]);
    return min;
  }
  onGet(id: string): void {
    this.bump(id);
    const i = this.main.indexOf(id);
    if (i >= 0) { this.main.splice(i, 1); this.main.unshift(id); }
  }
  onPut(id: string): void {
    this.bump(id);
    this.window.unshift(id);
    while (this.window.length > this.windowMax) {
      const demote = this.window.pop()!;
      // frequency admission: only demote into main if it beat the tail's
      // current estimate — otherwise drop (that's the scan filter)
      const tail = this.main[this.main.length - 1];
      if (!tail || this.estimate(demote) >= this.estimate(tail)) this.main.unshift(demote);
    }
  }
  onEvict(live: Set<string>): string {
    for (let i = this.main.length - 1; i >= 0; i--) {
      const id = this.main[i]!;
      if (live.has(id)) { this.main.splice(i, 1); return id; }
    }
    while (this.window.length) {
      const id = this.window.pop()!;
      if (live.has(id)) return id;
    }
    return '';
  }
}

function makeBackend(p: EvictionPolicyId, capacity: number): PolicyBackend {
  switch (p) {
    case 'lru': return new LruPolicy();
    case 'lfu': return new LfuPolicy();
    case 'tinylfu': return new TinyLfuPolicy(capacity);
    case 'fifo': return new FifoPolicy();
    case 'sieve':
    case 'belady':
    default: return new SievePolicy(); // belady never uses an online backend
  }
}

// ---------------------------------------------------------------------------
// Belady: offline replay of the recorded access stream (true MIN)
// ---------------------------------------------------------------------------

export type StreamEvent =
  | { kind: 'lookup'; id: string | null } // best-match id in any band (or none)
  | { kind: 'put'; id: string };

export function replayBelady(events: StreamEvent[], capacity: number): { hits: number; evictions: number } {
  const members = new Set<string>();
  let hits = 0;
  let evictions = 0;
  const nextUse = (from: number, id: string): number => {
    for (let u = from + 1; u < events.length; u++) {
      const e = events[u]!;
      if (e.id === id) return u; // lookup-or-put on this id
    }
    return -1;
  };
  for (let t = 0; t < events.length; t++) {
    const ev = events[t]!;
    if (ev.kind === 'lookup') {
      if (ev.id && members.has(ev.id)) hits++;
      continue;
    }
    members.add(ev.id);
    while (members.size > capacity) {
      let victim = '';
      let furthest = -1;
      for (const m of members) {
        const nu = nextUse(t, m);
        const dist = nu === -1 ? Infinity : nu;
        if (dist > furthest) { furthest = dist; victim = m; }
      }
      members.delete(victim);
      evictions++;
    }
  }
  return { hits, evictions };
}

// ---------------------------------------------------------------------------
// the cache
// ---------------------------------------------------------------------------

export const DEFAULT_SIMILARITY = { strong: 0.88, partial: 0.6 } as const;

/** Shadow entry-data retention beyond live capacity (similarity recompute needs text). */
const SHADOW_RETENTION = 500;

export interface PromptCacheOptions {
  capacity?: number;
  store?: CacheStore | null;
  strongThreshold?: number;
  partialThreshold?: number;
}

export interface CacheStatsSnapshot {
  size: number;
  capacity: number;
  totalLookups: number;
  exactHits: number;
  semanticHits: number;
  partialMatches: number;
  blockedByGovernance: number;
  /** responses actually avoided by cache hits (this is what saved money) */
  servedHits: number;
  savedTokens: number;
  livePolicy: EvictionPolicyId;
  policyStats: PolicyStats[];
}

interface ShadowState {
  backend: PolicyBackend;
  members: Set<string>;
  hits: number;
  evictions: number;
}

export class PromptCache {
  private capacity: number;
  private store: CacheStore | null;
  private strong: number;
  private partial: number;

  private entries = new Map<string, CacheEntryData>(); // LIVE serving cache (SIEVE)
  private data = new Map<string, CacheEntryData>();    // entry data incl. shadow-retained
  private byCanonical = new Map<string, string>();     // canonical -> id
  private shadows = new Map<EvictionPolicyId, ShadowState>();
  private stream: StreamEvent[] = [];
  private beladyCache: { hits: number; evictions: number } | null = null;

  private lookups = 0;
  private exactHits = 0;
  private semanticHits = 0;
  private partialMatches = 0;
  private blockedByGov = 0;
  private savedTokens = 0;

  constructor(opts: PromptCacheOptions = {}) {
    this.capacity = Math.max(1, opts.capacity ?? 200);
    this.store = opts.store ?? null;
    this.strong = opts.strongThreshold ?? DEFAULT_SIMILARITY.strong;
    this.partial = opts.partialThreshold ?? DEFAULT_SIMILARITY.partial;
    for (const p of EVICTION_POLICIES) {
      this.shadows.set(p.id, {
        backend: makeBackend(p.id, this.capacity),
        members: new Set(), hits: 0, evictions: 0,
      });
    }
    if (this.store) {
      const stored = this.store.load();
      for (const e of stored) this.data.set(e.id, e);
      const live = stored.slice(-this.capacity);
      for (const e of live) {
        this.entries.set(e.id, e);
        this.byCanonical.set(e.canonical, e.id);
        for (const [, s] of this.shadows) {
          s.members.add(e.id);
          s.backend.onPut(e.id);
        }
      }
    }
  }

  // --- lookup (pure — call recordOutcome with the result) -------------------

  lookup(prompt: string, modelId: string, level: OptimizationLevel, governanceClean: boolean): LookupResult {
    // exact layer
    const exactId = this.byCanonical.get(canonicalizePrompt(prompt));
    if (exactId) {
      const e = this.entries.get(exactId); // serving only from the LIVE cache
      if (e && e.modelId === modelId && e.level === level) {
        return {
          status: 'exact-hit', entry: e, matchedId: e.id, similarity: 1,
          note: 'Normalized prompt matches a cached response exactly — served from cache.',
        };
      }
    }

    // best match among ALL retained data (shadow-fair accounting), and
    // separately among LIVE entries (what may actually be served)
    const { vector, norm } = featurize(prompt);
    let bestLive: { entry: CacheEntryData; sim: number } | null = null;
    let bestAnyId: string | null = null;
    let bestAnySim = 0;
    for (const e of this.data.values()) {
      if (e.modelId !== modelId) continue;
      const sim = cosine(vector, norm, e.vector, e.norm);
      if (sim > bestAnySim) { bestAnySim = sim; bestAnyId = e.id; }
    }
    for (const e of this.entries.values()) {
      if (e.modelId !== modelId) continue;
      const sim = cosine(vector, norm, e.vector, e.norm);
      if (!bestLive || sim > bestLive.sim) bestLive = { entry: e, sim };
    }

    if (!bestLive || bestLive.sim < this.partial) {
      return {
        status: 'miss', entry: null, matchedId: bestAnyId, similarity: bestAnySim,
        note: 'No cached response at usable similarity — fresh request.',
      };
    }

    const sim = bestLive.sim;
    const match = bestLive.entry;

    if (sim >= this.strong) {
      if (match.level !== level) {
        return {
          status: 'miss', entry: null, matchedId: match.id, similarity: sim,
          note: `Closest match was ${(sim * 100).toFixed(0)}% similar but was optimized at a different level — outputs would differ, treated as miss.`,
        };
      }
      if (!governanceClean || !match.governanceClean) {
        return {
          status: 'blocked-governance', entry: null, matchedId: match.id, similarity: sim,
          note: 'Semantic match refused: this query or the cached prompt carries sensitive data — cross-query reuse is blocked (fail-closed). Re-sending the identical prompt would still exact-hit.',
        };
      }
      return {
        status: 'semantic-hit', entry: match, matchedId: match.id, similarity: sim,
        note: `Served the cached response from a ${(sim * 100).toFixed(0)}%-similar prompt (both governance-clean, same level).`,
      };
    }

    // partial band: neighbor surfaced, content NEVER served
    const bothClean = governanceClean && match.governanceClean;
    const shapeTokens = typeof match.payload['outputTokens'] === 'number'
      ? (match.payload['outputTokens'] as number)
      : null;
    return {
      status: 'partial', entry: null, matchedId: match.id, similarity: sim,
      partialContext: { sameLevel: match.level === level, bothClean, neighborOutputTokens: shapeTokens },
      note: bothClean && match.level === level
        ? `Partial-context neighbor at ${(sim * 100).toFixed(0)}% — below the ${(this.strong * 100).toFixed(0)}% serving bar, so its answer is NOT reused. Only its response shape is offered as a calibration hint: expected output ~${shapeTokens ?? '?'} tokens.`
        : `Partial-context neighbor at ${(sim * 100).toFixed(0)}% — nothing taken from it (${match.level === level ? 'a prompt on either side carries sensitive data' : 'optimization levels differ'}).`,
    };
  }

  // --- outcome recording -----------------------------------------------------

  /**
   * Feed a lookup result back. Served hits update entry stats and savings;
   * every lookup updates all six policy shadows so the comparison reflects
   * the full request stream. Policy hits count residency of the best match
   * in ANY band ("would have served"); real savings come from servedHits.
   */
  recordOutcome(result: LookupResult, savedTokens = 0): void {
    this.lookups++;
    this.stream.push({ kind: 'lookup', id: result.matchedId });
    this.beladyCache = null;

    if (result.status === 'exact-hit') this.exactHits++;
    if (result.status === 'semantic-hit') this.semanticHits++;
    if (result.status === 'partial') this.partialMatches++;
    if (result.status === 'blocked-governance') this.blockedByGov++;

    if (result.entry) {
      this.savedTokens += savedTokens;
      result.entry.hits++;
      result.entry.lastAccessAt = Date.now();
    }

    for (const [pid, s] of this.shadows) {
      if (pid === 'belady') continue; // offline replay in stats()
      if (result.matchedId && s.members.has(result.matchedId)) s.hits++;
      if (result.matchedId) s.backend.onGet(result.matchedId);
    }
    this.persist();
  }

  put(
    prompt: string, modelId: string, level: OptimizationLevel,
    governanceClean: boolean, payload: Record<string, unknown>,
  ): CacheEntryData {
    const canonical = canonicalizePrompt(prompt);
    const { vector, norm } = featurize(prompt);
    const entry: CacheEntryData = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      prompt, canonical, vector, norm,
      modelId, level, governanceClean,
      createdAt: Date.now(), lastAccessAt: Date.now(), hits: 0, payload,
    };
    this.data.set(entry.id, entry);
    this.entries.set(entry.id, entry);
    this.byCanonical.set(canonical, entry.id);
    this.stream.push({ kind: 'put', id: entry.id });
    this.beladyCache = null;

    for (const [, s] of this.shadows) {
      s.members.add(entry.id);
      s.backend.onPut(entry.id);
    }
    this.enforceCapacity();
    this.persist();
    return entry;
  }

  private enforceCapacity(): void {
    // LIVE cache trimmed by SIEVE (the serving policy)
    const liveS = this.shadows.get('sieve')!;
    while (this.entries.size > this.capacity) {
      const victim = liveS.backend.onEvict(new Set(this.entries.keys()));
      if (!victim) break;
      if (this.entries.delete(victim)) liveS.evictions++;
      else break; // backend desync guard
    }
    liveS.members = new Set(this.entries.keys());

    // each shadow trims its OWN membership (data stays in this.data)
    for (const [pid, s] of this.shadows) {
      if (pid === 'sieve' || pid === 'belady') continue;
      while (s.members.size > this.capacity) {
        const victim = s.backend.onEvict(s.members);
        if (!victim) break;
        s.members.delete(victim);
        s.evictions++;
      }
    }

    // bounded data retention so memory can't run away
    const maxData = this.capacity + SHADOW_RETENTION;
    if (this.data.size > maxData) {
      const ids = Array.from(this.data.keys());
      let toDrop = this.data.size - maxData;
      for (const id of ids) {
        if (toDrop <= 0) break;
        if (this.entries.has(id)) continue; // live data must stay
        this.data.delete(id);
        for (const [, s] of this.shadows) s.members.delete(id);
        toDrop--;
      }
      for (const [k, v] of Array.from(this.byCanonical.entries())) {
        if (!this.data.has(v)) this.byCanonical.delete(k);
      }
    }
  }

  // --- introspection ---------------------------------------------------------

  stats(): CacheStatsSnapshot {
    if (!this.beladyCache) this.beladyCache = replayBelady(this.stream, this.capacity);
    const beladyS = this.shadows.get('belady')!;
    beladyS.hits = this.beladyCache.hits;
    beladyS.evictions = this.beladyCache.evictions;

    return {
      size: this.entries.size,
      capacity: this.capacity,
      totalLookups: this.lookups,
      exactHits: this.exactHits,
      semanticHits: this.semanticHits,
      partialMatches: this.partialMatches,
      blockedByGovernance: this.blockedByGov,
      servedHits: this.exactHits + this.semanticHits,
      savedTokens: this.savedTokens,
      livePolicy: 'sieve',
      policyStats: EVICTION_POLICIES.map((p) => {
        const s = this.shadows.get(p.id)!;
        return {
          policy: p.id,
          hits: s.hits,
          lookups: this.lookups,
          hitRate: this.lookups ? s.hits / this.lookups : 0,
          evictions: s.evictions,
        };
      }),
    };
  }

  snapshotEntries(): Array<{ id: string; modelId: string; level: string; governanceClean: boolean; createdAt: number; hits: number; preview: string }> {
    return Array.from(this.entries.values()).map((e) => ({
      id: e.id, modelId: e.modelId, level: e.level,
      governanceClean: e.governanceClean, createdAt: e.createdAt, hits: e.hits,
      preview: e.prompt.length > 60 ? `${e.prompt.slice(0, 60)}\u2026` : e.prompt,
    }));
  }

  similarityBars(): { strong: number; partial: number } {
    return { strong: this.strong, partial: this.partial };
  }

  /**
   * Measured output lengths recorded by the user (actual response size
   * logged against a cached entry), grouped by (model, shape) — the
   * concrete calibration feed for estimateOutputTokens.
   */
  measuredOutputs(): Map<string, { total: number; n: number }> {
    const out = new Map<string, { total: number; n: number }>();
    for (const e of this.data.values()) {
      const shape = typeof e.payload['shape'] === 'string' ? (e.payload['shape'] as string) : null;
      const measured = typeof e.payload['measuredOutput'] === 'number' ? (e.payload['measuredOutput'] as number) : null;
      if (!shape || measured === null || measured <= 0) continue;
      const key = `${e.modelId}::${shape}`;
      const cur = out.get(key) ?? { total: 0, n: 0 };
      cur.total += measured;
      cur.n += 1;
      out.set(key, cur);
    }
    return out;
  }

  /** Attach the user's measured output length to an entry (calibration data). */
  recordMeasuredOutput(id: string, tokens: number): boolean {
    const e = this.data.get(id);
    if (!e || tokens <= 0) return false;
    e.payload['measuredOutput'] = Math.round(tokens);
    this.persist();
    return true;
  }

  clear(): void {
    this.entries.clear();
    this.data.clear();
    this.byCanonical.clear();
    this.stream = [];
    this.beladyCache = null;
    for (const [, s] of this.shadows) { s.members.clear(); s.hits = 0; s.evictions = 0; }
    this.lookups = this.exactHits = this.semanticHits = this.partialMatches = this.blockedByGov = this.savedTokens = 0;
    this.store?.clear();
  }

  private persist(): void {
    this.store?.save(Array.from(this.entries.values()));
  }
}
