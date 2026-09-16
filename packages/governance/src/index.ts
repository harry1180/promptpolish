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
    // enforces the English-only input policy below (see screenLanguage);
    // /\b\B/ can never match — language.ts decides, not this regex.
    id: 'non-english-input',
    label: 'Non-English input (translation-jailbreak class)',
    regex: /\b\B/g,
    severity: 'block',
  },
];

/**
 * English-only input policy.
 *
 * The guardrail rules above are English pattern families: a request
 * translated into another script (e.g. the "ignore previous instructions /
 * reveal the system prompt" jailbreak rendered in Telugu) sails past every
 * one of them, and a downstream LLM follows the translated instruction
 * faithfully — a classic translation jailbreak. Rather than maintain
 * injection rules per language, the product restricts governed input to
 * English: anything carrying non-Latin script is blocked deterministically,
 * before it can be optimized, cached, or sent to any provider.
 *
 * Allowed: ASCII plus Latin-1 letters (names like José, café — still
 * English prose), and typographic punctuation (curly quotes, en/em dashes,
 * ellipsis) produced by word processors. Blocked: any non-Latin letter
 * (Telugu, Devanagari, Arabic, CJK, Cyrillic, Greek, Hangul, ...) once a
 * minimum of letters is present, so URLs/emoji-only short strings are not
 * penalized.
 */
const LATIN_SAFE = /[\u0020-\u024F\u2018\u2019\u201C\u201D\u2013\u2014\u2026]/g;
const NON_LATIN_LETTER =
  /[\u0370-\u05FF\u0600-\u08FF\u0900-\u1FFF\u2C60-\uD7FF\uF900-\uFDFF\uFE70-\uFFFF]/;

function screenLanguage(text: string): GovernanceReport['guardrails'][number] | null {
  const letters = (text.match(/\p{L}/gu) ?? []).length;
  if (letters < 3) return null; // too short to judge; not worth blocking
  const stripped = text.replace(LATIN_SAFE, '');
  const m = stripped.match(NON_LATIN_LETTER);
  if (!m) return null;
  const at = text.indexOf(m[0]);
  return {
    id: 'non-english-input',
    label: 'Non-English input (translation-jailbreak class)',
    sample: text.slice(Math.max(0, at - 6), at + 14).trim().slice(0, 60),
  };
}

function countMatches(regex: RegExp, text: string): number {
  regex.lastIndex = 0;
  let n = 0;
  while (regex.exec(text) !== null && n < 100) n++;
  return n;
}

/**
 * Full governance pass over one query. Pure + synchronous; cheap enough to
 * run on every optimize click (never on every keystroke — callers debounce).
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

  // 3b. script gate — runs AFTER the English rules so a translated attack
  //     gets the most specific label available.
  const language = screenLanguage(text);
  if (language) guardrails.push(language);

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
