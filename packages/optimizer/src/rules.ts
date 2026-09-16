import type { ChangeLogEntry } from '@promptslim/shared-types';
import { hasSlot, joinSentences, splitSentences, TAG_RE, type Sent } from './mask';

/**
 * Deterministic verbosity rules. Each rule fires only at its level or higher
 * (conservative < balanced < aggressive).
 *
 * Granularity is SENTENCE, not line: an intent-bearing sentence carries a
 * ␞X␞ tag that makes it immune to whole-sentence removal and near-dedup,
 * while phrase-level compression rules still rewrite its wording safely
 * ("Please make sure that you" -> "ensure you"). Slot characters \uE000id\uE000
 * are opaque: no rule can match inside them.
 */

export type Level = 'conservative' | 'balanced' | 'aggressive';
export const LEVEL_RANK: Record<Level, number> = { conservative: 0, balanced: 1, aggressive: 2 };

export interface PhraseRule {
  pattern: RegExp;
  replace: string;
  min: Level;
  description: string;
}

export const PHRASE_RULES: PhraseRule[] = [
  // --- conservative: politeness / throat-clearing / filler collocations ---
  { pattern: /\bi would like you to\b\s*/gi, replace: '', min: 'conservative', description: 'Removed politeness opener "I would like you to"' },
  { pattern: /\bi'?d like (?:to ask )?you to\b\s*/gi, replace: '', min: 'conservative', description: 'Removed politeness opener "I would like you to"' },
  { pattern: /\bi want you to\b\s*/gi, replace: '', min: 'conservative', description: 'Removed "I want you to"' },
  { pattern: /\bplease note that\b\s*/gi, replace: 'Note: ', min: 'conservative', description: 'Compressed "please note that" to "Note:"' },
  { pattern: /\b(?:please\s+)?make sure that you\b\s+/gi, replace: 'ensure you ', min: 'conservative', description: 'Compressed "make sure that you" to "ensure you"' },
  { pattern: /\bit is (?:very |really |also )?important to (?:note|remember|understand|mention|be aware) that\b\s*/gi, replace: 'Note: ', min: 'conservative', description: 'Compressed "it is important to note that"' },
  { pattern: /\b(?:thanks a lot|thanks so much|thank you very much|thanks|thank you|much appreciated|appreciate (?:it|this|your help)|best regards|kind regards|sincerely)\b[,.!]?\s*/gi, replace: '', min: 'conservative', description: 'Removed courtesy thanks (no effect on model output)' },
  { pattern: /\bi (?:really |truly )?appreciate (?:it|this|your help)\b[,.!]?\s*/gi, replace: '', min: 'conservative', description: 'Removed appreciation closer' },
  { pattern: /\b(?:please\s+)?make sure to\b\s+/gi, replace: 'ensure ', min: 'conservative', description: 'Compressed "make sure to" to "ensure"' },
  { pattern: /\b(?:please\s+)?make sure that\b\s+/gi, replace: 'ensure ', min: 'conservative', description: 'Compressed "make sure that"' },
  { pattern: /\bplease ensure that you\b\s+/gi, replace: 'ensure you ', min: 'conservative', description: 'Compressed "please ensure that you"' },
  { pattern: /\bensured?\s+that\s+you\b/gi, replace: 'ensure you', min: 'conservative', description: 'Compressed "ensure that you"' },
  { pattern: /\bensure that\b/gi, replace: 'ensure', min: 'conservative', description: 'Compressed "ensure that"' },
  { pattern: /\bcould you (?:please )?\b/gi, replace: '', min: 'conservative', description: 'Removed "Could you" request phrasing' },
  { pattern: /\bwould you (?:mind )?(?:please )?\b/gi, replace: '', min: 'conservative', description: 'Removed "Would you" request phrasing' },
  { pattern: /\bin order to\b/gi, replace: 'to', min: 'conservative', description: 'Compressed "in order to" to "to"' },
  { pattern: /\bfor the purpose of\b/gi, replace: 'to', min: 'conservative', description: 'Compressed "for the purpose of" to "to"' },
  { pattern: /\bwith(?: regards?)? to\b|\bin regard to\b/gi, replace: 'about', min: 'conservative', description: 'Compressed "with regard to" to "about"' },
  { pattern: /\bas a large language model\b\s*,?\s*/gi, replace: '', min: 'conservative', description: 'Removed "As a large language model" preamble' },
  { pattern: /\byou need to\b\s*/gi, replace: '', min: 'conservative', description: 'Removed "you need to" (imperative kept)' },
  { pattern: /\bbelow is (?:the|a|an)\b/gi, replace: 'Context:', min: 'conservative', description: 'Compressed "below is the" lead-in' },
  { pattern: /\bthe following is\b\s*/gi, replace: '', min: 'conservative', description: 'Removed "the following is" lead-in' },
  { pattern: /\bi (?:will|would) (?:provide|give|send) you\b\s*/gi, replace: '', min: 'conservative', description: 'Removed user-side narration' },
  { pattern: /\bplease[,.]?\s+/gi, replace: '', min: 'conservative', description: 'Removed politeness "please"' },
  { pattern: /\bkindly[,.]?\s+/gi, replace: '', min: 'conservative', description: 'Removed politeness "kindly"' },
  { pattern: /\bNote: (?:that|it is)\b/gi, replace: 'Note:', min: 'conservative', description: 'Tidied "Note:" lead-in' },

  // --- balanced: verbose collocations, hedging, restatement, courtesy ---
  { pattern: /\bdue to the fact that\b/gi, replace: 'because', min: 'balanced', description: 'Compressed "due to the fact that" to "because"' },
  { pattern: /\bin the event that\b/gi, replace: 'if', min: 'balanced', description: 'Compressed "in the event that" to "if"' },
  { pattern: /\bat (?:this|that) point in time\b/gi, replace: 'now', min: 'balanced', description: 'Compressed "at this point in time"' },
  { pattern: /\bin the near future\b/gi, replace: 'soon', min: 'balanced', description: 'Compressed "in the near future" to "soon"' },
  { pattern: /\bon a regular basis\b/gi, replace: 'regularly', min: 'balanced', description: 'Compressed "on a regular basis" to "regularly"' },
  { pattern: /\bin many cases\b|\boften times\b/gi, replace: 'often', min: 'balanced', description: 'Compressed hedging phrase' },
  { pattern: /\bit is (?:very |really |also )?important to (?:note|remember|understand|mention|be aware) that\b\s*/gi, replace: 'Note: ', min: 'balanced', description: 'Compressed "it is important to note that"' },
  { pattern: /\bit is (?:very |really |also )?important that\b\s*/gi, replace: 'Important: ', min: 'balanced', description: 'Compressed "it is important that"' },
  { pattern: /\bit is (?:also |very |really )?worth noting that\b\s*/gi, replace: 'Note: ', min: 'balanced', description: 'Compressed "it is worth noting that"' },
  { pattern: /\bit is (?:also )?(?:crucial|essential|vital|critical) to\b\s*/gi, replace: 'ensure you ', min: 'balanced', description: 'Compressed "it is crucial to"' },
  { pattern: /\bi (?:really |truly )?appreciate (?:it|this|your help)\b[,.!]?\s*/gi, replace: '', min: 'balanced', description: 'Removed appreciation closer' },
  { pattern: /\b(?:i(?:'m| am)|we(?:'re| are)) (?:happy|glad|pleased) to help\b[^\uE000\n]*?[.!?]?\s*/gi, replace: '', min: 'balanced', description: 'Removed offer-to-help sentence' },
  { pattern: /\b(?:if you have any questions|feel free to ask|let me know if)\b[^\uE000\n]*?[.!?]?\s*/gi, replace: '', min: 'balanced', description: 'Removed conversational closer' },
  { pattern: /\b(?:thanks a lot|thanks so much|thank you very much|thanks|thank you|much appreciated|appreciate (?:it|this|your help)|best regards|kind regards|sincerely)\b[,.!]?\s*/gi, replace: '', min: 'balanced', description: 'Removed courtesy thanks (no effect on model output)' },
  { pattern: /\b(?:very|really|basically|actually|literally|definitely|simply|essentially|quite)\s+(?=[a-z])/gi, replace: ' ', min: 'balanced', description: 'Removed intensifier filler' },
  { pattern: /\b(?:carefully|thorough(?:ly)?|properly|accurately)\b\s+/gi, replace: '', min: 'balanced', description: 'Removed adverbial padding' },
  { pattern: /\bjust\s+(?=[a-z])/gi, replace: ' ', min: 'balanced', description: 'Removed filler "just"' },
  { pattern: /\bin other words,?\s*/gi, replace: '', min: 'balanced', description: 'Removed "in other words" restatement' },
  { pattern: /\b(?:to summarize|in summary|to restate (?:the task|this|the requirement)|as (?:a )?re(?:cap|statement)|remember to)\b[,.:]?\s*:?\s*/gi, replace: '', min: 'balanced', description: 'Removed restatement lead-in' },
  { pattern: /\bremember\b\s+(?=(?:to\s+)?(?:always|never|that))/gi, replace: 'Note:', min: 'balanced', description: 'Normalized "remember"' },
  { pattern: /\bas you know,?\s*/gi, replace: '', min: 'balanced', description: 'Removed "as you know"' },
  { pattern: /\bneedless to say,?\s*|\bit goes without saying that\b\s*/gi, replace: '', min: 'balanced', description: 'Removed "needless to say"' },
  { pattern: /\byou should\s+/gi, replace: '', min: 'balanced', description: 'Removed "you should" (imperative kept)' },
  { pattern: /\bthen you (?:should|will|can)\b/gi, replace: 'then', min: 'balanced', description: 'Compressed "then you should"' },
  { pattern: /\bdouble check\b/gi, replace: 'verify', min: 'balanced', description: 'Compressed "double check" to "verify"' },
  { pattern: /\bfor what it'?s worth\b,?\s*/gi, replace: '', min: 'balanced', description: 'Removed "for what it is worth"' },
  { pattern: /\bwhen it comes to\b/gi, replace: 'for', min: 'balanced', description: 'Compressed "when it comes to"' },
  { pattern: /\bin terms of\b/gi, replace: 'for', min: 'balanced', description: 'Compressed "in terms of"' },
  { pattern: /\bkeep in mind that\b\s*/gi, replace: 'Note: ', min: 'balanced', description: 'Compressed "keep in mind that"' },
  { pattern: /\bbear in mind that\b/gi, replace: ' Note: ', min: 'balanced', description: 'Compressed "bear in mind that"' },
  { pattern: /\bat the end of the day\b,?\s*/gi, replace: '', min: 'balanced', description: 'Removed "at the end of the day"' },
  { pattern: /\ball in all\b,?\s*/gi, replace: '', min: 'balanced', description: 'Removed "all in all"' },
  { pattern: /\b(?:as previously mentioned|as i said|as mentioned above|as stated earlier)\b,?\s*/gi, replace: '', min: 'balanced', description: 'Removed redundant back-reference' },
  { pattern: /\bdo not hesitate to\b\s*/gi, replace: 'feel free to ', min: 'balanced', description: 'Compressed "do not hesitate to"' },
  { pattern: /\bfor your reference\b,?\s*/gi, replace: '', min: 'balanced', description: 'Removed "for your reference"' },
  { pattern: /\byou are required to\b\s*/gi, replace: 'you must ', min: 'balanced', description: 'Compressed "you are required to"' },
  { pattern: /\bwith the aim of\b/gi, replace: 'to', min: 'balanced', description: 'Compressed "with the aim of"' },
  { pattern: /\bto (?:me|make) sure\b/gi, replace: 'to ensure', min: 'balanced', description: 'Compressed "to me sure"' },
  { pattern: /\bplease do\b[.!]?\s*/gi, replace: '', min: 'balanced', description: 'Removed redundant execution nudge' },
  { pattern: /\bnow\b[,.]?\s+(?=(?:do|write|generate|extract|answer|respond|begin|output)\b)/gi, replace: '', min: 'balanced', description: 'Removed filler "now"' },

  // --- aggressive: meta narration, pacing, hedges, pointer words ---
  { pattern: /\btake your time\b[,.]?\s*|\bwhen you are ready,?\s*/gi, replace: '', min: 'aggressive', description: 'Removed pacing chatter' },
  { pattern: /\bi (?:believe|think|feel) that\b\s*/gi, replace: '', min: 'aggressive', description: 'Removed hedged lead-in' },
  { pattern: /\bit should be mentioned that\b\s*|\bit must be said that\b\s*/gi, replace: '', min: 'aggressive', description: 'Removed meta commentary' },
  { pattern: /\bstep by step\b\s*/gi, replace: '', min: 'aggressive', description: 'Removed "step by step" filler' },
  { pattern: /\bas well as\b/gi, replace: 'and', min: 'aggressive', description: 'Compressed "as well as" to "and"' },
  { pattern: /\bin the context of\b/gi, replace: 'for', min: 'aggressive', description: 'Compressed "in the context of"' },
  { pattern: /\bfor clarity\b,?\s*|\bto be clear\b,?\s*/gi, replace: '', min: 'aggressive', description: 'Removed clarifying filler' },
  { pattern: /\s+\b(?:provided\s+|listed\s+|shown\s+)?below\b/gi, replace: '', min: 'aggressive', description: 'Removed pointer word "below"' },
  { pattern: /\s+\b(?:provided\s+)?above\b/gi, replace: '', min: 'aggressive', description: 'Removed pointer word "above"' },
  { pattern: /\bin the following (?:format|structure|order)\b/gi, replace: ' in this format', min: 'aggressive', description: 'Compressed "in the following format"' },
  { pattern: /\byou must always\b/gi, replace: 'always', min: 'aggressive', description: 'Compressed "you must always"' },
  { pattern: /\b(?:to respond|to answer|to do (?:this|it)|to begin|to start|to help you)(?: to [^,.]{0,30})?,\s+/gi, replace: '', min: 'aggressive', description: 'Removed introductory purpose clause' },
  { pattern: /\b(?:please\s+)?make sure\b/gi, replace: 'ensure', min: 'aggressive', description: 'Compressed "make sure" to "ensure"' },
];

/** Pure-conversational sentence shape (aggressive drop candidate). */
export const CHATTER_RE =
  /^(?:hi|hello|hey|okay|ok|so then|first off|well|anyway|by the way|thanks|thank you|appreciate)\b/i;

const TAG_PREFIX_RE = /^(\u2E1E[CESXFR]\u2E1E)([\s\S]*)$/;
const TAG_ANY_RE = new RegExp(TAG_RE.source);

export function isTaggedSentence(s: string): boolean {
  return TAG_ANY_RE.test(s);
}
export function tagOfSentence(s: string): string | null {
  const m = s.match(TAG_PREFIX_RE);
  return m ? m[1]![2] : null;
}
export function sentenceBody(s: string): string {
  return s.replace(TAG_PREFIX_RE, '$2');
}

export function applyPhraseRules(
  lines: string[],
  level: Level,
  changes: ChangeLogEntry[],
  tokenCountFn: (s: string) => number,
): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const sents = splitSentences(line);
    const processed: Sent[] = [];
    for (const s of sents) {
      const m = s.text.match(TAG_PREFIX_RE);
      const tag = m ? m[1]! : '';
      let body = m ? m[2]! : s.text;
      for (const rule of PHRASE_RULES) {
        if (LEVEL_RANK[rule.min] > LEVEL_RANK[level]) continue;
        const before = body;
        body = body.replace(rule.pattern, rule.replace);
        if (body !== before) {
          changes.push({
            kind: 'compressed-phrase',
            description: rule.description,
            before: snippet(before, rule.pattern),
            after: snippet(body, rule.pattern) || undefined,
            tokensSaved: Math.max(0, tokenCountFn(before) - tokenCountFn(body)),
          });
        }
      }
      body = tidy(body);
      if (body.trim() === '' && s.text.trim() !== '') {
        // sentence fully deleted; only safe when untagged
        if (!tag) continue;
      }
      // orphaned fragments left by courtesy deletions ("I", "and", bare punctuation)
      if (!tag && /^(?:i|it|and|so|but|or|then|also|to|the|a|for)\.?$/i.test(body.trim())) continue;
      processed.push({ text: tag + body, sep: s.sep });
    }
    const rebuilt = joinSentences(processed);
    if (rebuilt.trim() === '' && line.trim() !== '') continue;
    out.push(rebuilt);
  }
  return out;
}

/** Repair spacing/punctuation artifacts of deletions; restore capitalization. */
export function tidy(line: string): string {
  return line
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/^\s*[-*]\s*$/, '')
    .replace(/^\s+/, '')
    .replace(/^(\s*)([a-z])/g, (_m, sp, c) => sp + (c as string).toUpperCase())
    .replace(/(^|[.!?]\s+)([a-z])/g, (_m, p, c) => p + (c as string).toUpperCase())
    .replace(/[ \t]+$/g, '')
    .trimEnd();
}

function snippet(text: string, pattern: RegExp): string {
  const re = new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''));
  const m = text.match(re);
  if (!m) return '';
  const s = m[0].replace(/[\uE000\u2E1E]/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'you', 'your', 'to', 'of', 'in', 'on', 'that', 'this', 'it', 'is', 'are',
  'be', 'with', 'from', 'any', 'all', 'a', 'an', 'if', 'or', 'as', 'at', 'by', 'we', 'they', 'them',
  'their', 'there', 'here', 'when', 'then', 'than', 'but', 'not', 'do', 'does', 'did', 'have', 'has',
  'should', 'must', 'will', 'can', 'please', 'always', 'never', 'only', 'into', 'using', 'use',
  'make', 'sure', 'ensure', 'also', 'more', 'most', 'other', 'some', 'such', 'what', 'which',
]);

/** Content-word set for similarity (ignores tags/slots). */
export function contentWords(s: string): Set<string> {
  const w = s
    .replace(/[\u2E1E][CESXFR][\u2E1E]/g, ' ')
    .replace(/\uE000[0-9a-z]+\uE000/g, ' ')
    .toLowerCase()
    .match(/[a-z]{4,}/g) ?? [];
  return new Set(w.filter((x) => !STOPWORDS.has(x)));
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/**
 * Collapse duplicates AT SENTENCE GRANULARITY.
 * - exact duplicate sentence anywhere (all levels; tagged duplicates count as
 *   "combined repeated constraint/instruction")
 * - semantic duplicate (Jaccard >= 0.6) vs an already-kept sentence at
 *   balanced+ — only untagged prose may be dropped this way
 * Slot-bearing sentences are never dropped: same surface, unknown content.
 * Lines are rebuilt with their original separators so paragraphs stay intact.
 */
export function dedupeSentences(
  text: string,
  level: Level,
  changes: ChangeLogEntry[],
  tokenCountFn: (s: string) => number,
): string {
  const seenExact = new Set<string>();
  const keptSets: Array<{ set: Set<string>; line: string }> = [];
  const drop = new Set<Sent>();
  const lines = text.split('\n');
  const parsed = lines.map((l) => splitSentences(l));

  for (const sents of parsed) {
    for (const s of sents) {
      const body = sentenceBody(s.text);
      const t = body.trim();
      if (!t || hasSlot(s.text) || !/\S/.test(t.replace(/[\uE000-\uE0FF]/g, ''))) continue;
      const key = t
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (!key) continue;
      const tag = tagOfSentence(s.text);
      if (seenExact.has(key)) {
        drop.add(s);
        changes.push({
          kind: tag === 'C' ? 'combined-constraints' : 'removed-duplicate',
          description: tag
            ? `Removed repeated ${tag === 'C' ? 'constraint' : tag === 'F' ? 'output-format' : 'instruction'}`
            : 'Removed duplicate sentence/bullet',
          before: truncate(t),
          tokensSaved: tokenCountFn(body),
        });
        continue;
      }
      if (LEVEL_RANK[level] >= LEVEL_RANK['balanced']) {
        const set = contentWords(t);
        if (set.size >= 5) {
          let best = 0;
          let bestLine = '';
          for (const prev of keptSets) {
            const sim = jaccard(set, prev.set);
            if (sim > best) {
              best = sim;
              bestLine = prev.line;
            }
          }
          // untagged prose: 0.50 (balanced) / 0.45 (aggressive); tagged (constraint/format)
          // restatements: 0.55 on content words, or keyword containment: if the NEW
          // sentence's content words are (almost) all already covered by a kept
          // sentence, it is a paraphrase of an existing instruction — merge it.
          const threshold = tag ? 0.55 : LEVEL_RANK[level] >= LEVEL_RANK.aggressive ? 0.45 : 0.5;
          let merge = best >= threshold;
          if (!merge && set.size >= 3) {
            for (const prev of keptSets) {
              let covered = 0;
              for (const w of set) if (prev.set.has(w)) covered += 1;
              if (covered / set.size >= 0.85) {
                merge = true;
                bestLine = prev.line;
                break;
              }
            }
          }
          if (merge) {
            drop.add(s);
            changes.push({
              kind: tag ? 'combined-constraints' : 'removed-redundant-instruction',
              description: tag
                ? 'Combined repeated constraint/instruction (already stated earlier)'
                : 'Combined repeated instruction (same meaning already stated)',
              before: truncate(t),
              after: `kept earlier: ${truncate(bestLine)}`,
              tokensSaved: tokenCountFn(body),
            });
            continue;
          }
        }
      }
      seenExact.add(key);
      keptSets.push({ set: contentWords(t), line: truncate(t) });
    }
  }

  const result: string[] = [];
  for (const sents of parsed) {
    const kept = sents.filter((s) => !drop.has(s));
    if (kept.length === 0) {
      result.push('');
      continue;
    }
    result.push(joinSentences(kept));
  }
  return result.join('\n');
}

/** Drop pure conversational sentences (aggressive only; never tagged/slot). */
export function dropMetaLines(
  text: string,
  changes: ChangeLogEntry[],
  tokenCountFn: (s: string) => number,
): string {
  const lines = text.split('\n');
  const out: string[] = [];
  for (const line of lines) {
    const sents = splitSentences(line);
    const kept = sents.filter((s) => {
      const body = sentenceBody(s.text).trim();
      if (!body || hasSlot(s.text) || isTaggedSentence(s.text)) return true;
      const chatter =
        CHATTER_RE.test(body) && body.length <= 90 && contentWords(body).size <= 3;
      if (chatter) {
        changes.push({
          kind: 'removed-filler',
          description: 'Removed conversational line',
          before: truncate(body),
          tokensSaved: tokenCountFn(body),
        });
        return false;
      }
      return true;
    });
    const rebuilt = joinSentences(kept);
    if (rebuilt.trim() || !line.trim()) out.push(rebuilt);
  }
  return out.join('\n');
}

function truncate(s: string): string {
  return s.length > 70 ? `${s.slice(0, 67)}...` : s;
}
