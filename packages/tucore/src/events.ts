/**
 * Headline classification, normalization, hashing, similarity and event-state
 * merging. LOCAL lexicon only — no network, no models.
 */
import type { EventType } from './types.ts';

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Lowercase, strip punctuation (replaced by spaces), collapse whitespace, trim. */
export function normalizeHeadline(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** FNV-1a 64-bit over UTF-8 bytes; returns 16 lowercase hex chars (no 0x). */
export function contentHash(text: string): string {
  const bytes = utf8Bytes(text);
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (const b of bytes) {
    hash ^= BigInt(b);
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, '0');
}

function utf8Bytes(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i++;
      }
    }
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return out;
}

/** Normalized headline with digit runs replaced by '#'. */
export function storySignature(headline: string): string {
  return normalizeHeadline(headline).replace(/\d+/g, '#');
}

/** 'ticker|type|hash' — hash over the digit-normalized headline. */
export function dedupKey(ticker: string | null, type: EventType, headline: string): string {
  return `${ticker ?? ''}|${type}|${contentHash(storySignature(headline))}`;
}

function shingles(tokens: string[], k: number): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + k <= tokens.length; i++) out.add(tokens.slice(i, i + k).join(' '));
  return out;
}

/** Token 3-shingle Jaccard 0..1; short texts (<3 tokens each side) fall back to unigram Jaccard. */
export function similarity(a: string, b: string): number {
  const na = normalizeHeadline(a);
  const nb = normalizeHeadline(b);
  if (na === nb) return 1;
  const ta = na === '' ? [] : na.split(' ');
  const tb = nb === '' ? [] : nb.split(' ');
  if (ta.length === 0 && tb.length === 0) return 1;
  if (ta.length === 0 || tb.length === 0) return 0;
  const useShingles = ta.length >= 3 && tb.length >= 3;
  const sa = useShingles ? shingles(ta, 3) : new Set(ta);
  const sb = useShingles ? shingles(tb, 3) : new Set(tb);
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Host minus leading 'www.', last two labels. */
export function domainOf(url: string): string {
  let host = url.trim();
  const schemeIdx = host.indexOf('://');
  if (schemeIdx >= 0) host = host.slice(schemeIdx + 3);
  const slash = host.search(/[/?#]/);
  if (slash >= 0) host = host.slice(0, slash);
  const colon = host.indexOf(':');
  if (colon >= 0) host = host.slice(0, colon);
  if (host.toLowerCase().startsWith('www.')) host = host.slice(4);
  const labels = host.split('.').filter((l) => l.length > 0);
  if (labels.length <= 2) return labels.join('.');
  return labels.slice(-2).join('.');
}

interface PhraseRule {
  type: EventType;
  materiality: number;
  phrases: ReadonlyArray<readonly [string, number]>; // [normalized substring, sentiment]
}

/**
 * Ordered rule table — first matching phrase wins. Specific guidance rules
 * precede generic earnings wording; analyst/dividend/FDA rules precede the
 * broad MACRO list. Materiality: earnings/guidance/M&A/FDA >= 0.7,
 * analyst/dividend 0.4, general 0.2 (+0.2 when numbers/percent present).
 */
const RULES: readonly PhraseRule[] = [
  {
    type: 'GUIDANCE_REDUCTION',
    materiality: 0.75,
    phrases: [
      ['cuts guidance', -0.7],
      ['cut guidance', -0.7],
      ['lower guidance', -0.7],
      ['lowers guidance', -0.7],
      ['slashes guidance', -0.8],
      ['trims guidance', -0.6],
      ['guidance cut', -0.7],
      ['withdraws guidance', -0.8],
      ['withdraws outlook', -0.8],
      ['withdraws full year outlook', -0.8],
      ['cuts outlook', -0.7],
      ['cuts forecast', -0.6],
      ['lowers forecast', -0.6],
      ['disappointing guidance', -0.8],
      ['withdraws', -0.7],
    ],
  },
  {
    type: 'GUIDANCE_CHANGE',
    materiality: 0.7,
    phrases: [
      ['raises guidance', 0.6],
      ['raise guidance', 0.6],
      ['raises full year guidance', 0.6],
      ['boosts guidance', 0.6],
      ['raises outlook', 0.6],
      ['raises forecast', 0.6],
      ['raises full year outlook', 0.6],
      ['expands outlook', 0.4],
      ['updates outlook', 0.2],
      ['reaffirms guidance', 0.2],
      ['guidance raise', 0.6],
    ],
  },
  {
    type: 'MA',
    materiality: 0.75,
    phrases: [
      ['agrees to be acquired', 0.6],
      ['agrees to acquire', 0.3],
      ['to acquire', 0.3],
      ['set to acquire', 0.3],
      ['acquires', 0.3],
      ['acquisition of', 0.2],
      ['buyout of', 0.3],
      ['merger with', 0.2],
      ['to buy', 0.2],
    ],
  },
  {
    type: 'MANAGEMENT_CHANGE',
    materiality: 0.6,
    phrases: [
      ['fires ceo', -0.6],
      ['ousts ceo', -0.6],
      ['ceo to step down', -0.4],
      ['steps down', -0.4],
      ['resigns', -0.3],
      ['ceo departure', -0.3],
      ['appoints new ceo', 0.2],
      ['appoints ceo', 0.2],
      ['names ceo', 0.2],
      ['appoints chief executive', 0.2],
    ],
  },
  {
    type: 'ANALYST_CHANGE',
    materiality: 0.4,
    phrases: [
      ['downgrades', -0.4],
      ['downgrade', -0.4],
      ['initiates with sell', -0.4],
      ['cuts price target', -0.3],
      ['lower price target', -0.3],
      ['underweight', -0.3],
      ['upgrades', 0.4],
      ['upgrade', 0.4],
      ['initiates with buy', 0.4],
      ['raises price target', 0.3],
      ['overweight', 0.3],
    ],
  },
  {
    type: 'DIVIDEND_CHANGE',
    materiality: 0.4,
    phrases: [
      ['suspends dividend', -0.6],
      ['cuts dividend', -0.5],
      ['dividend cut', -0.5],
      ['raises dividend', 0.4],
      ['increases dividend', 0.4],
      ['initiates dividend', 0.5],
      ['special dividend', 0.3],
      ['dividend', 0],
    ],
  },
  {
    type: 'BUYBACK',
    materiality: 0.5,
    phrases: [
      ['buys back', 0.4],
      ['buyback', 0.4],
      ['buy back', 0.4],
      ['repurchase', 0.4],
    ],
  },
  {
    type: 'OFFERING',
    materiality: 0.55,
    phrases: [
      ['sells shares', -0.5],
      ['secondary offering', -0.5],
      ['prices offering', -0.3],
      ['public offering', -0.4],
      ['equity offering', -0.4],
      ['offering', -0.4],
    ],
  },
  {
    type: 'FDA',
    materiality: 0.75,
    phrases: [
      ['fda rejects', -0.8],
      ['rejected by fda', -0.8],
      ['fda rejection', -0.8],
      ['fails to get fda', -0.8],
      ['fda approves', 0.8],
      ['fda approval', 0.8],
      ['fda clears', 0.7],
      ['fda clearance', 0.7],
      ['wins fda', 0.7],
      ['receives fda', 0.7],
      ['fda', 0.1],
    ],
  },
  {
    type: 'REGULATORY',
    materiality: 0.65,
    phrases: [
      ['sec charges', -0.6],
      ['doj charges', -0.6],
      ['files charges', -0.5],
      ['charged with', -0.5],
      ['regulators block', -0.5],
      ['blocks merger', -0.5],
      ['blocks deal', -0.5],
      ['antitrust', -0.3],
      ['fined', -0.5],
      ['faces fine', -0.5],
    ],
  },
  {
    type: 'INVESTIGATION',
    materiality: 0.6,
    phrases: [
      ['under investigation', -0.4],
      ['sec probe', -0.4],
      ['subpoena', -0.5],
      ['investigation', -0.4],
      ['investigating', -0.4],
      ['probe', -0.3],
    ],
  },
  {
    type: 'LAWSUIT',
    materiality: 0.55,
    phrases: [
      ['files suit', -0.4],
      ['class action', -0.4],
      ['lawsuit', -0.4],
      ['sues', -0.4],
      ['sued', -0.4],
    ],
  },
  {
    type: 'LAYOFFS',
    materiality: 0.5,
    phrases: [
      ['slashes jobs', -0.3],
      ['cuts jobs', -0.3],
      ['to cut jobs', -0.3],
      ['job cuts', -0.3],
      ['layoffs', -0.3],
      ['lay off', -0.3],
      ['reduces workforce', -0.3],
      ['restructuring', -0.2],
    ],
  },
  {
    type: 'CYBER_INCIDENT',
    materiality: 0.6,
    phrases: [
      ['ransomware', -0.7],
      ['data breach', -0.7],
      ['hacked', -0.7],
      ['cyberattack', -0.6],
      ['cyber attack', -0.6],
      ['security incident', -0.5],
      ['breach', -0.6],
      ['hack', -0.7],
    ],
  },
  {
    type: 'CONTRACT',
    materiality: 0.6,
    phrases: [
      ['wins contract', 0.6],
      ['awarded contract', 0.6],
      ['lands contract', 0.6],
      ['wins order', 0.5],
      ['gets order', 0.4],
      ['contract with', 0.3],
    ],
  },
  {
    type: 'PRODUCT_LAUNCH',
    materiality: 0.5,
    phrases: [
      ['launches', 0.4],
      ['unveils', 0.4],
      ['debuts', 0.4],
      ['rolls out', 0.3],
      ['introduces', 0.3],
    ],
  },
  {
    type: 'SEC_FILING',
    materiality: 0.4,
    phrases: [
      ['form 10 k', 0],
      ['form 10 q', 0],
      ['form 8 k', 0],
      ['sec filing', 0],
      ['files annual report', 0],
    ],
  },
  {
    type: 'INSIDER_TRANSACTION',
    materiality: 0.4,
    phrases: [
      ['insider buys', 0.3],
      ['director buys', 0.3],
      ['ceo buys', 0.3],
      ['insider selling', -0.2],
      ['insider', 0],
    ],
  },
  {
    type: 'DEBT_ISSUANCE',
    materiality: 0.45,
    phrases: [
      ['issues bonds', -0.1],
      ['prices senior notes', -0.1],
      ['debt offering', -0.2],
      ['raises debt', -0.1],
      ['senior notes', -0.1],
    ],
  },
  {
    type: 'EARNINGS',
    materiality: 0.7,
    phrases: [
      ['misses estimates', -0.7],
      ['misses', -0.7],
      ['falls short', -0.6],
      ['beats estimates', 0.7],
      ['tops estimates', 0.7],
      ['exceeds estimates', 0.7],
      ['beats', 0.6],
      ['quarterly results', 0],
      ['reports earnings', 0],
      ['earnings', 0],
    ],
  },
  {
    type: 'MACRO',
    materiality: 0.5,
    phrases: [
      ['inflation cools', 0.4],
      ['inflation rises', -0.4],
      ['inflation jumps', -0.4],
      ['rate cut', 0.3],
      ['rate hike', -0.3],
      ['fed cuts', 0.3],
      ['fed raises', -0.3],
      ['fed signals', 0.1],
      ['fed holds', 0],
      ['federal reserve', 0],
      ['rate decision', 0],
      ['fomc', 0],
      ['jobs report', 0],
      ['payrolls', 0],
      ['cpi', 0],
      ['inflation', 0],
      ['unemployment', 0],
      ['interest rates', 0],
      ['treasury yields', 0],
      ['gdp', 0],
    ],
  },
  {
    type: 'GEOPOLITICAL',
    materiality: 0.6,
    phrases: [
      ['ceasefire', 0.3],
      ['sanctions', -0.3],
      ['tariffs', -0.3],
      ['invasion', -0.4],
      ['war', -0.4],
      ['geopolitical', -0.2],
    ],
  },
];

function findMatch(text: string): { type: EventType; sentiment: number; materiality: number } | null {
  // Word-boundary matching: phrases must match whole tokens so 'sues' never
  // fires inside 'issues'.
  const padded = ` ${text} `;
  for (const rule of RULES) {
    for (const [phrase, sentiment] of rule.phrases) {
      if (padded.includes(` ${phrase} `)) return { type: rule.type, sentiment, materiality: rule.materiality };
    }
  }
  return null;
}

export function classifyHeadline(headline: string, body?: string): { type: EventType; sentiment: number; materiality: number } {
  const h = normalizeHeadline(headline);
  let match = findMatch(h);
  if (match === null && body) match = findMatch(normalizeHeadline(body));
  const type = match?.type ?? 'GENERAL';
  const sentiment = clamp(match?.sentiment ?? 0, -1, 1);
  let materiality = match?.materiality ?? 0.2;
  if (/\d/.test(h) || headline.includes('%')) materiality = Math.min(1, materiality + 0.2);
  return { type, sentiment, materiality };
}

export interface MergeEventResult {
  sourceUrls: string[];
  headlines: string[]; // only distinct story signatures are appended
  independentSources: number; // distinct domains
  updated: boolean; // true only when a NEW headline variant was recorded
  duplicate: boolean; // incoming headline matches an existing story
}

/**
 * Merge one incoming syndicated item into an event's state.
 *
 * Duplicate = same digit-normalized hash or similarity >= 0.82 vs any stored
 * headline. sourceUrls grow with every new URL; independentSources counts
 * distinct domains; `updated` reflects headline/story state only (a brand-new
 * URL does not set it), which is how 25 copies of one story from 5 domains
 * merge to 1 event with 25 sources, 5 independent sources, updated=false after
 * the first copy.
 */
export function mergeEventState(
  existing: { sourceUrls: string[]; headlines: string[] },
  incoming: { sourceUrl: string; headline: string },
): MergeEventResult {
  const sig = storySignature(incoming.headline);
  let duplicate = false;
  for (const h of existing.headlines) {
    if (storySignature(h) === sig || similarity(h, incoming.headline) >= 0.82) {
      duplicate = true;
      break;
    }
  }
  const headNew = !existing.headlines.some((h) => storySignature(h) === sig);
  const urlNew = !existing.sourceUrls.includes(incoming.sourceUrl);
  const sourceUrls = urlNew ? [...existing.sourceUrls, incoming.sourceUrl] : [...existing.sourceUrls];
  const headlines = headNew ? [...existing.headlines, incoming.headline] : [...existing.headlines];
  const domains = new Set(sourceUrls.map(domainOf));
  return {
    sourceUrls,
    headlines,
    independentSources: domains.size,
    updated: headNew,
    duplicate,
  };
}