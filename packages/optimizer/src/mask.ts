import type { PreservableItem, StructureAnalysis } from '@promptslim/shared-types';

/**
 * Preservation masking — runs BEFORE any reduction pass.
 *
 * Layer 1 (slots): fenced code, XML blocks, JSON objects, inline placeholders.
 *   These become opaque \uE000id\uE000 slots, restored verbatim at the end, and no
 *   reduction rule can match inside them.
 * Layer 2 (sentence tags): sentences that carry intent — role, constraints,
 *   safety, examples, output-format instructions — are prefixed with a
 *   \u2E1E{letter}\u2E1E marker INSTEAD of being slotted. Tagged sentences are
 *   still rewritten by phrase rules (safe wording compression) but are never
 *   dropped or near-deduped. Sentence granularity (not line granularity) is
 *   what lets restated instructions inside long paragraphs be collapsed while
 *   the real constraints stay untouched.
 */

export const SLOT_OPEN = '\uE000';
export const SLOT_CLOSE = '\uE000';
export const LINE_TAG = '\u2E1E'; // ␞

const slot = (i: number) => `${SLOT_OPEN}${i.toString(36)}${SLOT_CLOSE}`;
const SLOT_RE = /\uE000[0-9a-z]+\uE000/g;
const SLOT_TEST_RE = /\uE000[0-9a-z]+\uE000/;
export const TAG_RE = /\u2E1E[CESXFR]\u2E1E/g;
export const TAG_TEST_RE = /\u2E1E[CESXFR]\u2E1E/;

export const PLACEHOLDER_RE =
  /\{\{[A-Za-z_][\w.\- ]*\}\}|\$\{[A-Za-z_][\w.\- ]*\}|\{[A-Za-z_][\w.\-]*\}|\[[A-Z][A-Z0-9_]{2,}\]|<[A-Za-z_][\w.\-]*>/g;

const FENCE_RE = /```[\s\S]*?```/g;
const XML_BLOCK_RE = /<[A-Za-z][\w.\-]*(?:\s[^>]*)?>[\s\S]*?<\/[A-Za-z][\w.\-]*>/g;
const XML_SELF_CLOSING_RE = /<[A-Za-z][\w.\-]*(?:\s[^>]*?)?\/>/g;

export const OUTPUT_FORMAT_RE =
  /(?:output\s+(?:should|must|format|as|in)\b|respond\s+(?:only\s+)?(?:with|in|using)\b|return\s+(?:a\s+)?(?:valid\s+)?(?:json|only|the|it\s+in)\b|format\s*(?:must|should|of|:)|strict\s+json|follow(?:ing)?\s+(?:this|the|exact|following)\s+(?:format|structure|schema)|exactly\s+(?:the\s+)?(?:following|this)\s+(?:format|structure|schema)|your\s+(?:response|output|answer)\s+(?:should|must|in)|as\s+(?:a\s+)?(?:json|list|table|markdown\s+table)|json\s+schema|^\s*output\s*:|must\s+contain\b|only\s+contain\b)/im;

export const CONSTRAINT_RE =
  /\b(must(?:\s+not)?|never|always|do\s+not|don'?t|shall|required|only|no\s+more\s+than|at\s+least|max(?:imum)?|min(?:imum)?|strictly|ensure|avoid|exclude|preserve|retain|exactly|within|adhere|comply|respect)\b/i;

export const SAFETY_RE =
  /\b(confidential|privacy|PII|GDPR|HIPAA|compliance|legal|do\s+not\s+share|never\s+reveal|safety|secure|restricted|authenticat|sanitiz|not\s+exist)/i;

export const ROLE_RE =
  /^(?:you\s+are\b|as\s+an?\s+[\w\s]{0,40}?(?:assistant|expert|analyst|agent|engineer|specialist|model|system)|act\s+as\b|imagine\s+you(?:'re|\s+are)\b|role\s*:|your\s+(?:role|job|task)\s+is\b|your\s+task\s+is\b|your\s+job\s+is\b)/i;

export const EXAMPLE_RE =
  /^(e\.?g\.?|for\s+example|for\s+instance|example(s)?\s*:?|here(?:'s| is)\s+an?|input\s*:|output\s*:\s*(?:e\.?g|")|for\s+example,?\s+\w+\()/i;

export const CONTEXT_RE =
  /^(context|background|situat|the\s+(customer|user|company|system|product)|we\s+(have|are|offer)|given\b)/i;

export const OBJECTIVE_RE =
  /^(your\s+(task|objective|goal)\s+is|analyze|summarize|extract|generate|write|create|classify|convert|translate|review|build|answer|compare|explain|identify|produce|draft)/i;

export function hasSlot(line: string): boolean {
  return line.includes(SLOT_OPEN);
}
export function hasTag(line: string): boolean {
  return TAG_TEST_RE.test(line);
}
export function untag(text: string): string {
  return text.replace(TAG_RE, '');
}

export function findPlaceholders(text: string): string[] {
  const re = new RegExp(PLACEHOLDER_RE.source, 'g');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m[0]);
  return out;
}

export interface MaskedText {
  text: string; // slot-masked + sentence-tagged; safe for reduction passes
  slots: Map<string, string>;
  protectedItems: PreservableItem[]; // block/placeholder items (restored verbatim)
  placeholders: string[]; // all placeholder occurrences (incl. inside blocks)
}

/** Sentence chunks with their trailing whitespace preserved for lossless rebuild. */
export interface Sent {
  text: string;
  sep: string; // whitespace (+closing quotes) following this sentence ('' for last)
}

const ABBREV = new Set([
  'e.g', 'i.e', 'vs', 'etc', 'approx', 'mr', 'mrs', 'ms', 'dr', 'prof', 'inc', 'ltd', 'co', 'st',
  'no', 'fig', 'cf', 'min', 'max', 'ref', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep',
  'oct', 'nov', 'dec', 'api', 'sdk', 'id',
]);

/**
 * Split a line into sentences without losing characters. Splits at
 * [.!?] + optional closing punctuation + whitespace, unless the word before
 * the period is a common abbreviation. Also splits after ':' when followed by
 * newline (label-style sections keep their line; colons mid-line do not).
 */
export function splitSentences(line: string): Sent[] {
  const parts: Sent[] = [];
  let current = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    current += ch;
    if (ch !== '.' && ch !== '!' && ch !== '?') continue;
    const prevWord = (current.slice(0, -1).match(/([A-Za-z](?:[A-Za-z.]*)?)(?:[.!?])$/) ?? [])[1];
    if (ch === '.' && prevWord && ABBREV.has(prevWord.toLowerCase().replace(/\.$/, ''))) continue;
    // lookahead: closing brackets may trail the sentence; whitespace; next sentence may open with a quote/bracket
    const rest = line.slice(i + 1);
    const m = rest.match(/^(["')\]]*)(\s+)(?=["'(\[{<\u2E1E\uE000A-Z0-9]|\s*$)/);
    if (!m) continue;
    parts.push({ text: current + (m[1] ?? ''), sep: m[2] ?? ' ' });
    current = '';
    i += m[0].length; // m is relative to rest (after the '.'), so the '.' counts as already consumed
  }
  if (current) parts.push({ text: current, sep: '' });
  return parts.length ? parts : [{ text: line, sep: '' }];
}

export function joinSentences(parts: Sent[]): string {
  return parts.map((p) => p.text + p.sep).join('');
}

function classifySentence(s: string): string | null {
  const t = untag(s.replace(/\uE000[0-9a-z]+\uE000/g, ' ')).trim();
  if (!t) return null;
  if (OUTPUT_FORMAT_RE.test(t)) return 'F';
  if (SAFETY_RE.test(t)) return 'S';
  if (ROLE_RE.test(t)) return 'R';
  if (EXAMPLE_RE.test(t)) return 'E';
  if (t.length <= 260 && CONSTRAINT_RE.test(t)) return 'C';
  return null;
}

export function maskText(text: string): MaskedText {
  const slots = new Map<string, string>();
  const protectedItems: PreservableItem[] = [];
  let next = 0;
  const put = (raw: string, type: PreservableItem['type']): string => {
    const id = slot(next++);
    slots.set(id, raw);
    protectedItems.push({ type, text: raw });
    return id;
  };

  let working = text;
  // Layer 1: block masks
  working = working.replace(FENCE_RE, (m) => put(m, m.toLowerCase().includes('```json') ? 'json-block' : 'code-block'));
  working = working.replace(XML_BLOCK_RE, (m) => put(m, 'xml-block'));
  working = working.replace(XML_SELF_CLOSING_RE, (m) => put(m, 'xml-block'));
  working = maskJsonBlocks(working, (m) => put(m, 'json-block'));
  working = working.replace(new RegExp(PLACEHOLDER_RE.source, 'g'), (m) => put(m, 'placeholder'));

  // Layer 2: sentence-level semantic tags
  const tagged = working
    .split('\n')
    .map((line) => {
      if (!line.trim()) return line;
      const sents = splitSentences(line);
      const out = sents.map((s) => {
        const cls = classifySentence(s.text);
        // do not double-tag; pure slot lines are already protected
        if (cls && !s.text.includes(SLOT_OPEN) && !TAG_TEST_RE.test(s.text)) {
          return { ...s, text: `${LINE_TAG}${cls}${LINE_TAG}${s.text}` };
        }
        return s;
      });
      return joinSentences(out);
    })
    .join('\n');

  return {
    text: tagged,
    slots,
    protectedItems,
    placeholders: findPlaceholders(text),
  };
}

/** Balance-brace scan; masks each top-level JSON object (with a string key) found. */
function maskJsonBlocks(text: string, put: (s: string) => string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '{') {
      const end = matchBrace(text, i);
      if (end > i) {
        const block = text.slice(i, end + 1);
        if (/"[^"]+"\s*:/.test(block) && block.length > 12) {
          out += put(block);
          i = end + 1;
          continue;
        }
      }
    }
    out += text[i];
    i += 1;
  }
  return out;
}

function matchBrace(text: string, start: number): number {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1; // unterminated: leave as-is
}

/** Remove all sentence tags before restore (tags are metadata only). */
export function stripTags(text: string): string {
  return text.replace(TAG_RE, '');
}

/** Restore repeatedly (sentences may contain placeholder slots); a single
 * pass of String.replace does not rescan inserted text. */
export function restoreText(masked: MaskedText, text: string): string {
  const untagged = stripTags(text);
  let out = untagged;
  for (let pass = 0; pass < 10 && SLOT_TEST_RE.test(out); pass++) {
    out = out.replace(SLOT_RE, (id) => masked.slots.get(id) ?? id);
  }
  return out;
}

/** Structure detection (role/objective/context/constraints/examples/output format). Informational only. */
export function analyzeStructure(originalText: string): StructureAnalysis {
  const lines = originalText.split('\n').map((l) => l.trim()).filter(Boolean);
  const lower = originalText.toLowerCase();
  return {
    role: lines.some((l) => ROLE_RE.test(l)) || /\byou are\b/.test(lower),
    objective: lines.some((l) => OBJECTIVE_RE.test(l)) || /your (task|objective|goal) is/.test(lower),
    context: lines.some((l) => CONTEXT_RE.test(l)) || /context\s*:|background\s*:/.test(lower),
    constraints: lines.some((l) => CONSTRAINT_RE.test(l)),
    examples: lines.some((l) => EXAMPLE_RE.test(l)) || /for example|e\.g\.|for instance/.test(lower),
    outputFormat: lines.some((l) => OUTPUT_FORMAT_RE.test(l)) || /output format|respond with|return json/.test(lower),
  };
}
