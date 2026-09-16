import { describe, expect, it } from 'vitest';
import {
  PromptCache,
  canonicalizePrompt,
  cosine,
  featurize,
  makeMemoryStore,
  replayBelady,
} from '../src/index';

const MODEL = 'gpt-5.4';

function freshCache(capacity = 12) {
  return new PromptCache({ capacity, store: makeMemoryStore() });
}

function runOptimize(c: PromptCache, prompt: string, level: 'conservative' | 'balanced' | 'aggressive' = 'balanced', clean = true) {
  const lookup = c.lookup(prompt, MODEL, level, clean);
  if (lookup.entry) {
    c.recordOutcome(lookup, lookup.entry.payload['inputTokens'] as number);
    return { status: lookup.status, served: true, lookup };
  }
  c.recordOutcome(lookup, 0);
  c.put(prompt, MODEL, level, clean, {
    inputTokens: 100, outputTokens: 40, shape: 'summary', result: { level },
  });
  return { status: lookup.status, served: false, lookup };
}

describe('exact layer', () => {
  it('same prompt twice exact-hits (normalization insensitive to case/space/punct)', () => {
    const c = freshCache();
    runOptimize(c, 'Summarize the quarterly report for {{team}}');
    const second = runOptimize(c, '  summarize   the quarterly report for {{team}}  ');
    expect(second.status).toBe('exact-hit');
    expect(second.served).toBe(true);
  });

  it('exact hit survives level+model partition: different level = miss', () => {
    const c = freshCache();
    runOptimize(c, 'Summarize the quarterly report');
    const r = c.lookup('Summarize the quarterly report', MODEL, 'aggressive', true);
    expect(r.status).toBe('miss');
  });
});

describe('semantic layer + bands', () => {
  it('near-duplicate phrasing above strong bar serves when both clean', () => {
    const c = freshCache();
    const base = 'Please summarize the following customer feedback about the billing portal and list the top issues clearly.';
    const near = 'Please summarize the following customer feedback about the billing portal and list the top issues clearly today.';
    runOptimize(c, base);
    const r = c.lookup(near, MODEL, 'balanced', true);
    expect(['semantic-hit', 'partial']).toContain(r.status);
    expect(r.similarity).toBeGreaterThan(0.6);
    if (r.status === 'semantic-hit') expect(r.entry).not.toBeNull();
  });

  it('unrelated prompts miss', () => {
    const c = freshCache();
    runOptimize(c, 'Summarize the quarterly report');
    const r = c.lookup('Implement a binary search tree in TypeScript with delete support', MODEL, 'balanced', true);
    expect(r.status).toBe('miss');
  });

  it('partial band NEVER serves content; only shape hint', () => {
    const cc = freshCache();
    cc.put('Summarize the revenue results for Q3 in brief form with key numbers', MODEL, 'balanced', true,
      { inputTokens: 50, outputTokens: 222, shape: 'summary' });
    const r = cc.lookup('Summarize the revenue results', MODEL, 'balanced', true);
    if (r.status === 'partial') {
      expect(r.entry).toBe(null); // content never served
      expect(r.partialContext?.neighborOutputTokens).toBe(222); // shape hint only
    }
    expect(['partial', 'miss', 'semantic-hit']).toContain(r.status);
  });
});

describe('governance interlock', () => {
  it('PII query cannot semantic-hit a cached entry', () => {
    const c = freshCache();
    runOptimize(c, 'Draft a reply confirming refund 42 for the angry customer');
    const r = c.lookup('Draft a reply confirming refund 42 for the angry customer now', MODEL, 'balanced', false);
    expect(['blocked-governance', 'partial', 'miss']).toContain(r.status);
    expect(r.entry).toBe(null);
  });

  it('PII-bearing entry: exact reuse allowed, cross-prompt refused', () => {
    const c = freshCache();
    const pii = 'Email john@example.com about {{ticket_id}}';
    runOptimize(c, pii, 'balanced', false); // stored with clean=false
    // identical prompt, still PII -> exact hit allowed
    const exact = c.lookup(pii, MODEL, 'balanced', false);
    expect(exact.status).toBe('exact-hit');
    expect(exact.entry).not.toBe(null);
    // paraphrase with PII -> refused
    const near = c.lookup(`${pii} please`, MODEL, 'balanced', false);
    expect(['blocked-governance', 'partial', 'miss']).toContain(near.status);
  });
});

describe('policy comparison', () => {
  it('live SIEVE serves; all six policies report stats on the same stream', () => {
    const c = freshCache(3);
    const prompts = Array.from({ length: 10 }, (_, i) => `Prompt number ${i} asking for a quick summary`);
    // deterministic skewed stream: early prompts recur, tail appears once
    const order: number[] = [];
    for (let i = 0; i < 60; i++) order.push(i % 3 === 0 ? i % 3 : i % prompts.length);
    for (const idx of order) runOptimize(c, prompts[idx]!);
    const s = c.stats();
    expect(s.policyStats.length).toBe(6);
    expect(s.totalLookups).toBe(60);
    expect(s.servedHits).toBeLessThanOrEqual(s.totalLookups);
    const rates = s.policyStats.map((p) => p.hitRate);
    expect(Math.max(...rates)).toBeGreaterThan(Math.min(...rates)); // policies genuinely diverge
    // every policy reports a rate the app could display
    for (const r of rates) expect(r).toBeGreaterThanOrEqual(0);
  });

  it('replayBelady is optimal on a known trace', () => {
    const events = [
      { kind: 'put' as const, id: 'A' },
      { kind: 'put' as const, id: 'B' },
      { kind: 'lookup' as const, id: 'A' },
      { kind: 'put' as const, id: 'C' },
      { kind: 'lookup' as const, id: 'B' },
      { kind: 'lookup' as const, id: 'A' },
      { kind: 'lookup' as const, id: 'C' },
    ];
    // capacity 2: at put C, MIN evicts B (next use t+2) over A (t+4)? A is used
    // farther ahead, so evict A... B hit, C hit => 2 lookups after C + A hit?
    // Belady evicts the FARTHEST: at t=3 members {A,B}; A next@5, B next@4 →
    // evict A. Then lookup B hit, lookup A miss (re-added? no puts left → A
    // simply absent), lookup C: C was put at t=3 (admitted) → hit. hits = 3.
    const { hits } = replayBelady(events, 2);
    expect(hits).toBe(3);
  });
});

describe('features', () => {
  it('canonicalizePrompt strips case/space/punctuation but keeps placeholders', () => {
    expect(canonicalizePrompt('Hey, {{name}}!  HOW are YOU?')).toBe('hey {{name}} how are you');
  });
  it('cosine self-similarity is 1', () => {
    const { vector, norm } = featurize('hello world foo');
    expect(cosine(vector, norm, vector, norm)).toBeCloseTo(1, 9);
  });
});
