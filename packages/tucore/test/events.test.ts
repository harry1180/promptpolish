import { describe, expect, it } from 'vitest';
import { classifyHeadline, contentHash, dedupKey, domainOf, mergeEventState, normalizeHeadline, similarity, storySignature } from '../src/events.ts';

describe('classifyHeadline', () => {
  it('classifies ~15 representative phrases with sensible sentiment/materiality', () => {
    const beats = classifyHeadline('Acme beats estimates, revenue jumps 12%');
    expect(beats.type).toBe('EARNINGS');
    expect(beats.sentiment).toBeGreaterThan(0);
    expect(beats.materiality).toBeGreaterThanOrEqual(0.7);

    const misses = classifyHeadline('Acme misses estimates in Q3');
    expect(misses.type).toBe('EARNINGS');
    expect(misses.sentiment).toBeLessThan(0);

    const cut = classifyHeadline('Acme cuts guidance for the year');
    expect(cut.type).toBe('GUIDANCE_REDUCTION');
    expect(cut.sentiment).toBeLessThan(0);
    expect(cut.materiality).toBeGreaterThanOrEqual(0.7);

    const raise = classifyHeadline('Acme raises full-year guidance');
    expect(raise.type).toBe('GUIDANCE_CHANGE');
    expect(raise.sentiment).toBeGreaterThan(0);

    const withdraw = classifyHeadline('Acme withdraws outlook after demand collapse');
    expect(withdraw.type).toBe('GUIDANCE_REDUCTION');
    expect(withdraw.sentiment).toBeLessThan(0);

    const ma = classifyHeadline('GlobalCorp agrees to acquire TargetCo for $3 billion');
    expect(ma.type).toBe('MA');
    expect(ma.materiality).toBeGreaterThan(cut.materiality - 0.01);

    const ceo = classifyHeadline('Acme appoints new CEO');
    expect(ceo.type).toBe('MANAGEMENT_CHANGE');
    expect(ceo.sentiment).toBeGreaterThan(0);

    const resign = classifyHeadline('Acme CEO resigns');
    expect(resign.type).toBe('MANAGEMENT_CHANGE');
    expect(resign.sentiment).toBeLessThan(0);

    const downgrade = classifyHeadline('Analyst downgrades Acme to sell');
    expect(downgrade.type).toBe('ANALYST_CHANGE');
    expect(downgrade.sentiment).toBeLessThan(0);
    expect(downgrade.materiality).toBeCloseTo(0.4, 12);

    const upgrade = classifyHeadline('Analyst upgrades Acme to overweight');
    expect(upgrade.type).toBe('ANALYST_CHANGE');
    expect(upgrade.sentiment).toBeGreaterThan(0);

    const dividend = classifyHeadline('Acme suspends dividend');
    expect(dividend.type).toBe('DIVIDEND_CHANGE');
    expect(dividend.materiality).toBeCloseTo(0.4, 12);
    expect(dividend.sentiment).toBeLessThan(0);

    const buyback = classifyHeadline('Acme announces $2 billion buyback');
    expect(buyback.type).toBe('BUYBACK');
    expect(buyback.sentiment).toBeGreaterThan(0);

    const fda = classifyHeadline("FDA approves Acme's new drug");
    expect(fda.type).toBe('FDA');
    expect(fda.sentiment).toBeGreaterThan(0);
    expect(fda.materiality).toBeGreaterThanOrEqual(0.7);

    const reject = classifyHeadline('FDA rejects Acme therapy');
    expect(reject.type).toBe('FDA');
    expect(reject.sentiment).toBeLessThan(0);

    const breach = classifyHeadline('Acme hit by data breach');
    expect(breach.type).toBe('CYBER_INCIDENT');
    expect(breach.sentiment).toBeLessThan(0);

    const lawsuit = classifyHeadline('Shareholder sues Acme in class action');
    expect(lawsuit.type).toBe('LAWSUIT');

    const layoffs = classifyHeadline('Acme announces layoffs of 1200 jobs');
    expect(layoffs.type).toBe('LAYOFFS');
    expect(layoffs.sentiment).toBeLessThan(0);

    const fed = classifyHeadline('Fed signals rate cut as inflation cools');
    expect(fed.type).toBe('MACRO');
    expect(fed.sentiment).toBeGreaterThan(0);

    const general = classifyHeadline('Acme announces something routine');
    expect(general.type).toBe('GENERAL');
    expect(general.materiality).toBeCloseTo(0.2, 12);
    expect(general.sentiment).toBe(0);
  });

  it('numbers/percent add +0.2 materiality, capped at 1', () => {
    const plain = classifyHeadline('Acme announces buyback');
    const numbered = classifyHeadline('Acme announces buyback worth 5 dollars');
    expect(numbered.materiality).toBeCloseTo(Math.min(1, plain.materiality + 0.2), 12);
    const big = classifyHeadline('Acme beats estimates by 12 percent and raises guidance 2026');
    expect(big.materiality).toBeLessThanOrEqual(1);
  });

  it('falls back to the body when the headline is generic', () => {
    const res = classifyHeadline('Acme issues update', 'The company misses estimates for the quarter');
    expect(res.type).toBe('EARNINGS');
    expect(res.sentiment).toBeLessThan(0);
  });
});

describe('normalizeHeadline / contentHash / dedupKey', () => {
  it('normalizes case, punctuation and whitespace', () => {
    expect(normalizeHeadline('  Hello,   World!! ')).toBe('hello world');
    expect(normalizeHeadline('Guidance-Cut: FY outlook slashed')).toBe('guidance cut fy outlook slashed');
  });

  it('FNV-1a 64 known vectors and determinism', () => {
    expect(contentHash('')).toBe('cbf29ce484222325');
    expect(contentHash('a')).toBe('af63dc4c8601ec8c');
    expect(contentHash('foobar')).toBe('85944171f73967e8');
    expect(contentHash('abc')).toBe(contentHash('abc'));
    expect(contentHash('abc')).not.toBe(contentHash('abd'));
    expect(contentHash('abc')).toMatch(/^[0-9a-f]{16}$/);
    // multi-byte input hashes deterministically without throwing
    expect(contentHash('café')).toMatch(/^[0-9a-f]{16}$/);
    expect(contentHash('café')).toBe(contentHash('café'));
  });

  it('dedupKey collapses digit variants of the same story', () => {
    const a = dedupKey('AAPL', 'EARNINGS', 'Acme beats by 5 cents');
    const b = dedupKey('AAPL', 'EARNINGS', 'Acme beats by 7 cents');
    expect(a).toBe(b);
    expect(a.startsWith('AAPL|EARNINGS|')).toBe(true);
    expect(dedupKey(null, 'EARNINGS', 'Acme beats by 5 cents').startsWith('|EARNINGS|')).toBe(true);
    expect(dedupKey('AAPL', 'MA', 'Acme beats by 5 cents')).not.toBe(a);
    expect(storySignature('Acme beats by 5 cents')).toBe('acme beats by # cents');
  });
});

describe('similarity / domainOf', () => {
  it('identical -> 1, disjoint -> 0, near-identical -> >= 0.82', () => {
    expect(similarity('Acme beats estimates', 'Acme beats estimates')).toBe(1);
    expect(similarity('cat dog bird', 'quantum physics rocket')).toBe(0);
    const base = 'Acme Corp reported record quarterly revenue beating analyst estimates across all segments worldwide';
    const variant = `${base} today`;
    expect(similarity(base, variant)).toBeGreaterThanOrEqual(0.82);
    expect(similarity(base, 'Completely unrelated story about pandas in the wild rainforest')).toBeLessThan(0.82);
    // short-text guard: no shingles, falls back to unigram Jaccard without throwing
    expect(similarity('a', 'b')).toBe(0);
    expect(similarity('same', 'same')).toBe(1);
    expect(similarity('', '')).toBe(1);
  });

  it('domainOf strips scheme, www., path and keeps the last two labels', () => {
    expect(domainOf('https://www.reuters.com/markets/stocks/story')).toBe('reuters.com');
    expect(domainOf('www.example.com/path?x=1')).toBe('example.com');
    expect(domainOf('https://example.com')).toBe('example.com');
    expect(domainOf('https://www.nytimes.com:443/article')).toBe('nytimes.com');
    expect(domainOf('')).toBe('');
  });
});

describe('mergeEventState', () => {
  it('first insert creates the event', () => {
    const res = mergeEventState({ sourceUrls: [], headlines: [] }, { sourceUrl: 'https://www.reuters.com/a', headline: 'Acme beats estimates' });
    expect(res.duplicate).toBe(false);
    expect(res.updated).toBe(true);
    expect(res.sourceUrls).toEqual(['https://www.reuters.com/a']);
    expect(res.headlines).toEqual(['Acme beats estimates']);
    expect(res.independentSources).toBe(1);
  });

  it('identical repeat is a duplicate with nothing updated', () => {
    const first = mergeEventState({ sourceUrls: [], headlines: [] }, { sourceUrl: 'https://www.reuters.com/a', headline: 'Acme beats estimates' });
    const second = mergeEventState(first, { sourceUrl: 'https://www.reuters.com/a', headline: 'Acme beats estimates' });
    expect(second.duplicate).toBe(true);
    expect(second.updated).toBe(false);
    expect(second.sourceUrls).toHaveLength(1);
    expect(second.headlines).toHaveLength(1);
  });

  it('25 syndicated copies from 5 domains merge into 1 event with 25 sources / 5 independent', () => {
    let state = { sourceUrls: [] as string[], headlines: [] as string[] };
    const headline = 'Acme beats estimates as revenue jumps 12%';
    const firstSeen = new Set<number>();
    for (let i = 0; i < 25; i++) {
      const domain = i % 5;
      const res = mergeEventState(state, {
        sourceUrl: `https://www.publisher${domain}.com/articles/${i}`,
        headline,
      });
      state = { sourceUrls: res.sourceUrls, headlines: res.headlines };
      if (i === 0) {
        expect(res.updated).toBe(true);
        expect(res.duplicate).toBe(false);
        firstSeen.add(i);
      } else {
        expect(res.duplicate).toBe(true);
        expect(res.updated).toBe(false); // no new headline after the first copy
      }
    }
    expect(firstSeen.size).toBe(1);
    expect(state.headlines).toHaveLength(1);
    expect(state.sourceUrls).toHaveLength(25);
    const final = mergeEventState(state, { sourceUrl: 'https://www.publisher0.com/articles/0', headline });
    expect(final.independentSources).toBe(5);
    expect(final.sourceUrls).toHaveLength(25); // URL already present
    expect(final.updated).toBe(false);
  });

  it('digit-variant copies collapse to the same story', () => {
    const first = mergeEventState({ sourceUrls: [], headlines: [] }, { sourceUrl: 'https://a.com/1', headline: 'Acme beats by 5 cents' });
    const second = mergeEventState(first, { sourceUrl: 'https://b.com/2', headline: 'Acme beats by 7 cents' });
    expect(second.duplicate).toBe(true);
    expect(second.independentSources).toBe(2);
  });

  it('a reworded headline over the similarity threshold is the same story', () => {
    const base = 'Acme Corp reported record quarterly revenue beating analyst estimates across all segments worldwide';
    const variant = `${base} today`;
    const first = mergeEventState({ sourceUrls: [], headlines: [] }, { sourceUrl: 'https://a.com/1', headline: base });
    const second = mergeEventState(first, { sourceUrl: 'https://b.com/2', headline: variant });
    expect(second.duplicate).toBe(true);
    expect(similarity(base, variant)).toBeGreaterThanOrEqual(0.82);
    expect(second.independentSources).toBe(2);
  });
});