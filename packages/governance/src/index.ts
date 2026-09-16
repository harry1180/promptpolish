import { francAll } from 'franc-min';
import type { SensitiveHit } from '@promptslim/shared-types';
import { detectSensitive } from '@promptslim/privacy-detector';

/**
 * Query governance + guardrails — local, deterministic, fail-closed.
 *
 * Three layers, mirroring the Action-Firewall pattern (policy lives outside
 * the prompt, never in model discretion):
 *
 * 1. DATA LABELS — the privacy-detector's PII/secret rules decide whether a
 *    query is "clean" for cache reuse and whether redaction should be
 *    offered. Categories are surfaced verbatim (masked samples only).
 *
 * 2. INTENT CATEGORIES — coarse topic classification (support, code,
 *    legal, medical, finance, marketing, general) by keyword scoring.
 *    Used for cache partition hints and for flagging regulated-domain
 *    queries where a stale/incorrect cached answer is costly.
 *
 * 3. GUARDRAILS — pattern rules for the classic injection/abuse classes:
 *    instruction-override attempts ("ignore previous instructions"),
 *    role/system spoofing, attempts to extract the system prompt, and
 *    clearly disallowed-content asks. A matched guardrail never silently
 *    alters the prompt: it labels the query and raises the policy verdict
 *    so the UI (and, in Phase 3, any real LLM call) can refuse or warn.
 *
 * Verdict ladder: allow < review < redact-required < block. Consumers must
 * treat anything worse than `allow` as "do not reuse cached data across
 * queries" — see packages/cache governance interlock.
 */

export type IntentCategory =
  | 'customer-support'
  | 'code'
  | 'legal'
  | 'medical'
  | 'finance'
  | 'marketing'
  | 'hr'
  | 'general';

export type GuardrailId =
  | 'instruction-override'
  | 'system-prompt-extraction'
  | 'role-spoofing'
  | 'jailbreak-marker'
  | 'disallowed-content'
  | 'non-english-input';

export type GovernanceVerdict = 'allow' | 'review' | 'redact-required' | 'block';

export interface GovernanceReport {
  verdict: GovernanceVerdict;
  /** primary intent label (highest scoring category) */
  intent: IntentCategory;
  intentScores: Array<{ category: IntentCategory; score: number }>;
  /** PII/secret hits with masked samples (never raw values) */
  sensitive: SensitiveHit[];
  /** no PII/secret hits at all */
  piiFree: boolean;
  /**
   * safe for cross-query cache reuse: PII-free AND not block/review AND
   * not a regulated domain (legal/medical/finance answers go stale).
   */
  reuseSafe: boolean;
  guardrails: Array<{ id: GuardrailId; label: string; sample: string }>;
  reasons: string[]; // human lines for the UI, in decision order
}

const INTENT_KEYWORDS: Record<Exclude<IntentCategory, 'general'>, RegExp> = {
  'customer-support': /\b(ticket|refund|complaint|customer|support|escalat|billing issue|claim|warrant)\b/gi,
  code: /\b(function|class|refactor|bug|compile|api|endpoint|typescript|python|javascript|sql|regex|deploy|unit test|stack trace|repository)\b/gi,
  legal: /\b(contract|clause|liabilit|indemnif|jurisdiction|lawsuit|attorney|compliance|terms of service|gdpr|ppa)\b/gi,
  medical: /\b(diagnos|symptom|patient|dosage|clinical|treatment|medical record|diagnosis|medication)\b/gi,
  finance: /\b(invoice|revenue|margin|portfolio|tax|audit|balance sheet|valuation|hedge|forecast)\b/gi,
  marketing: /\b(campaign|ad copy|brand|audience|conversion|funnel|seo|landing page|newsletter)\b/gi,
  hr: /\b(resume|candidate|hiring|performance review|termination|payroll|interview)\b/gi,
};

interface GuardrailRule {
  id: GuardrailId;
  label: string;
  regex: RegExp;
  severity: 'review' | 'block';
}

const GUARDRAIL_RULES: GuardrailRule[] = [
  {
    id: 'instruction-override',
    label: 'Instruction-override attempt',
    regex: /\b(ignore|disregard|forget)\b.{0,40}\b(previous|above|prior|earlier|all)\b.{0,30}\b(instructions?|prompts?|rules?|directives?)\b/gi,
    severity: 'block',
  },
  {
    id: 'system-prompt-extraction',
    label: 'System-prompt extraction attempt',
    regex: /\b(reveal|show|print|repeat|output|leak)\b.{0,30}\b(system prompt|hidden instructions?|initial prompt|developer message)\b/gi,
    severity: 'block',
  },
  {
    id: 'role-spoofing',
    label: 'Role spoofing ("you are now the developer/admin")',
    regex: /\b(you are now|act as|pretend to be)\b.{0,40}\b(developer|admin(istrator)?|root|system|dan|god ?mode)\b/gi,
    severity: 'review',
  },
  {
    id: 'jailbreak-marker',
    label: 'Known jailbreak marker',
    regex: /\b(jailbreak|jailbroken|developer mode|do anything now|dan\b)\b/gi,
    severity: 'review',
  },
  {
    id: 'disallowed-content',
    label: 'Disallowed-content request',
    regex: /\b(malware|ransomware|keylogger|exploit kit|how to (make|build) a (bomb|weapon)|stolen credit card|ddos)\b/gi,
    severity: 'block',
  },
  {
    // enforced by screenLanguage() below — semantic language detection plus
    // a Unicode script scan (not this regex; /(\b\B/) can never match).
    id: 'non-english-input',
    label: 'Non-English input (translation-jailbreak class)',
    regex: /\b\B/g,
    severity: 'block',
  },
];

/**
 * English-only input policy — semantic language detection + script scan.
 *
 * The guardrail rules above are English pattern families: a request
 * translated into another language (e.g. the "ignore previous instructions /
 * reveal the system prompt" jailbreak rendered in Telugu) sails past every
 * one of them, and a downstream LLM follows the translated instruction
 * faithfully — a classic translation jailbreak. Rather than maintain
 * injection rules per language, the product restricts governed input to
 * English.
 *
 * Two complementary signals decide, replacing the old script-range regex
 * gate that this section used to be:
 *
 * 1. LANGUAGE — `franc` ranks the text against trigram profiles of ~180
 *    languages (pure JS, deterministic, ~1ms even on 200k chars). When a
 *    non-English language wins outright, the input is blocked — including
 *    Latin-script non-English (French, German, romanized Hindi/Hinglish)
 *    that the old script regex let straight through. Because franc's
 *    models are trained on prose, short colloquial English can be
 *    misvoted; an English-confidence rescue (strong English trigram score
 *    OR a real share of English function words) prevents false blocks, so
 *    a borrowed foreign phrase inside English prose ("café crème", "nous
 *    somme a French phrase, but...") stays allowed.
 *
 * 2. SCRIPT — a Unicode-property scan (`\p{Script=...}`, the official
 *    script blocks — not hand-picked codepoint ranges) computes what share
 *    of the letters are non-Latin. A meaningful non-Latin minority is
 *    blocked even when franc still votes "eng": franc can be fooled by
 *    dominant English filler, so a jailbreak hidden deep inside a long
 *    English thread must NOT depend on the classifier's verdict. This
 *    closes the old regex's other hole, where it only ever looked at the
 *    FIRST non-Latin letter and let any amount of injected foreign script
 *    past a mostly-English sentence.
 *
 * Allowed: English prose, including accented Latin names (José, café) and
 * typographic punctuation (curly quotes, em dashes) from word processors.
 * Blocked before any optimization, caching, or provider call: any language
 * the classifier resolves to non-English (Latin-script included), and any
 * meaningful non-Latin script presence (share or absolute count) regardless
 * of what the classifier thinks. Strings too short to judge (< MIN_LETTERS
 * letters) are not penalized.
 */

/** Official Unicode script property — not hand-picked codepoint ranges. */
const LATIN_LETTER = /\p{Script=Latin}/u;
const IS_LETTER = /\p{L}/u;
/** franc's "undetermined" ISO 639-2 code (also the empty result). */
const UNDETERMINED = 'und';
/** below this many letters, nothing is judged (URLs/emoji stay safe). */
const MIN_LETTERS = 3;
/** below this many letters, trigram signals are noise — don't classify. */
const MIN_CLASSIFIABLE = 25;
/** non-Latin letters above this share of all letters are never tolerated. */
const NON_LATIN_SHARE_BLOCK = 0.1;
/** ...and above this absolute count either, even if English dominates. */
const NON_LATIN_COUNT_BLOCK = 8;

/**
 * Common English function words (closed class). franc's trigram models are
 * trained on long well-formed prose; on short conversational English ("hello
 * there, give me a haiku about rain") it confidently misvotes exotic
 * languages. A Latin-script string that the classifier calls foreign but
 * which leans on English function words is English — colloquial, even, and
 * must not be false-blocked. Real foreign prose scores 0.00–0.15 here
 * (crossed overlaps like Spanish "no"/"a" are individually rare); romanized
 * Hindi/Hinglish jailbreaks sit in the same band because their injected
 * English is jailbreak vocabulary, not grammar.
 */
const ENGLISH_FUNCTION_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'than', 'that', 'this',
  'these', 'those', 'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'him',
  'his', 'she', 'her', 'it', 'its', 'is', 'are', 'am', 'was', 'were', 'be', 'been',
  'being', 'does', 'did', 'done', 'not', 'no', 'yes', 'of', 'in', 'on', 'at',
  'to', 'for', 'from', 'with', 'without', 'about', 'into', 'over', 'under',
  'again', 'further', 'once', 'here', 'there', 'when', 'where', 'why', 'how',
  'all', 'any', 'both', 'each', 'few', 'more', 'most', 'other', 'some',
  'such', 'only', 'own', 'same', 'so', 'too', 'very', 'can', 'could', 'will',
  'would', 'just', 'should', 'shall', 'may', 'might', 'must', 'need', 'want',
  'like', 'please', 'thanks', 'thank', 'give', 'write', 'summarize', 'list',
  'make', 'made', 'take', 'get', 'know', 'think', 'say', 'says', 'said',
]);

function englishFunctionWordShare(text: string): number {
  const words = text.toLowerCase().match(/\p{Script=Latin}+/gu) ?? [];
  if (words.length === 0) return 1;
  const hits = words.reduce((n, w) => n + (ENGLISH_FUNCTION_WORDS.has(w) ? 1 : 0), 0);
  return hits / words.length;
}
/** function-word share at/above this rescues a foreign classifier vote. */
const FUNCTION_WORDS_TRUST = 0.28;
/** an English trigram score at/above this also rescues (second signal). */
const ENGLISH_SCORE_TRUST = 0.95;

/** null = fine; a returned string is short evidence text for the UI chip. */
function screenLanguage(text: string): string | null {
  // One pass over letters: total count, non-Latin count, small UI sample.
  let letters = 0;
  let nonLatin = 0;
  let sample = '';
  for (const ch of text) {
    if (!IS_LETTER.test(ch)) continue;
    letters++;
    if (!LATIN_LETTER.test(ch)) {
      nonLatin++;
      if (sample.length < 12) sample += ch;
    }
  }
  if (letters < MIN_LETTERS) return null; // too short to judge; not worth blocking

  const share = nonLatin / letters;
  // Script signal FIRST: trustworthy at any letter count and catches the
  // foreign payload franc can outvote with dominant English filler (long
  // English thread with a hidden translated jailbreak, Devanagari/Telugu
  // smuggled into Latin-script sentences).
  if (share >= NON_LATIN_SHARE_BLOCK || nonLatin >= NON_LATIN_COUNT_BLOCK) {
    const detail =
      share >= NON_LATIN_SHARE_BLOCK
        ? `${Math.round(share * 100)}% non-Latin letters`
        : `${nonLatin} non-Latin letters injected into Latin-script text`;
    return `${detail}; sample: "${sample.trim().slice(0, 60)}"`;
  }
  // Language signal: Latin-script non-English (French, German, romanized
  // Hindi/Hinglish) has zero non-Latin letters — only the classifier sees
  // it. Its top vote blocks unless two independent English signals rescue
  // it (short colloquial English gets misvoted by trigram profiles).
  if (letters >= MIN_CLASSIFIABLE) {
    const ranked = francAll(text);
    const top = ranked[0];
    if (top && top[0] !== 'eng' && top[0] !== UNDETERMINED) {
      const engScore = ranked.find(([code]) => code === 'eng')?.[1] ?? 0;
      const fnShare = englishFunctionWordShare(text);
      if (engScore < ENGLISH_SCORE_TRUST && fnShare < FUNCTION_WORDS_TRUST) {
        const excerpt = text.trim().replace(/\s+/g, ' ').slice(0, 40);
        return `detected language: ${top[0]} (english match ${Math.round(engScore * 100)}%, english function words ${Math.round(fnShare * 100)}%); text: "${excerpt}"`;
      }
    }
  }
  return null;
}

function countMatches(regex: RegExp, text: string): number {
  regex.lastIndex = 0;
  let n = 0;
  while (regex.exec(text) !== null && n < 100) n++;
  return n;
}

/**
 * Full governance pass over one query. Pure and synchronous; cheap enough
 * to run on every optimize click (never on every keystroke — callers
 * debounce). Language screening is sub-millisecond (franc + one Unicode
 * scan) even on the chat gateway's 200k-char thread cap.
 */
export function governQuery(text: string): GovernanceReport {
  const reasons: string[] = [];

  // 1. data layer
  const sensitive = detectSensitive(text);
  const piiFree = sensitive.length === 0;

  // 2. intent layer
  const intentScores = (Object.entries(INTENT_KEYWORDS) as Array<[Exclude<IntentCategory, 'general'>, RegExp]>)
    .map(([category, regex]) => ({ category, score: countMatches(regex, text) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  const intent: IntentCategory = intentScores[0]?.category ?? 'general';
  const REGULATED: IntentCategory[] = ['legal', 'medical', 'finance', 'hr'];
  const regulated = REGULATED.includes(intent);

  // 3. guardrail layer
  const guardrails: GovernanceReport['guardrails'] = [];
  for (const rule of GUARDRAIL_RULES) {
    rule.regex.lastIndex = 0;
    const m = rule.regex.exec(text);
    if (m) guardrails.push({ id: rule.id, label: rule.label, sample: m[0].slice(0, 60) });
  }

  // 3b. language gate — semantic detector + script scan. Runs AFTER the
  //     English injection rules so a translated attack gets the most
  //     specific label available, and catches everything the old script
  //     regex caught plus Latin-script and mixed-script translations.
  const language = screenLanguage(text);
  if (language) {
    guardrails.push({
      id: 'non-english-input',
      label: 'Non-English input (translation-jailbreak class)',
      sample: language,
    });
  }

  // verdict ladder (worst applicable wins)
  let verdict: GovernanceVerdict = 'allow';
  const hasBlock = guardrails.some((g) => GUARDRAIL_RULES.find((r) => r.id === g.id)?.severity === 'block');
  const hasReview = guardrails.some((g) => GUARDRAIL_RULES.find((r) => r.id === g.id)?.severity === 'review');

  if (hasBlock) {
    verdict = 'block';
    if (language) {
      reasons.push('Blocked: governed queries must be in English. Non-English input can carry translation-jailbreak attempts that bypass English guardrails, so it is refused before any optimization, caching, or provider call. Rewrite the request in English.');
    }
    reasons.push(`Blocked: ${guardrails.filter((g) => GUARDRAIL_RULES.find((r) => r.id === g.id)?.severity === 'block').map((g) => g.label.toLowerCase()).join(', ')} detected.`);
  } else if (hasReview) {
    verdict = 'review';
    reasons.push('Needs review: possible manipulation pattern in the prompt text.');
  } else if (!piiFree) {
    verdict = 'redact-required';
    reasons.push(`Sensitive data found: ${sensitive.map((s) => s.label).join(', ')}. Redaction offered; cache reuse limited to exact same-prompt hits.`);
  }
  const reuseSafe = piiFree && verdict === 'allow' && !regulated;
  if (regulated && verdict !== 'block') {
    if (verdict === 'allow') verdict = 'review';
    reasons.push(`Regulated domain (${intent}): cached answers may go stale — verify before reuse.`);
  }
  if (verdict === 'allow') reasons.push('Clean: eligible for full cache reuse.');

  return { verdict, intent, intentScores, sensitive, piiFree, reuseSafe, guardrails, reasons };
}

/**
 * True only when a query may take part in cross-prompt cache reuse.
 * Exact same-prompt reuse does NOT require this (see PromptCache.lookup).
 */
export function cacheReuseAllowed(report: GovernanceReport): boolean {
  return report.reuseSafe;
}
