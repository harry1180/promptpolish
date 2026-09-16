import type { SensitiveCategory, SensitiveHit } from '@promptslim/shared-types';

/**
 * Lightweight, local-only sensitive-data detection.
 * Rules are intentionally conservative: we report categories with masked
 * samples (never raw secrets) and let the user decide. False positives are
 * possible (e.g. any 15-16 digit number looks card-like).
 */

interface Rule {
  category: SensitiveCategory;
  label: string;
  regex: RegExp;
  mask: (m: string) => string;
}

const maskEmail = (m: string): string => {
  const [local, domain] = m.split('@');
  return `${(local?.[0] ?? '*')}***@${domain ?? ''}`;
};

const RULES: Rule[] = [
  {
    category: 'email',
    label: 'Email address',
    regex: /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g,
    mask: maskEmail,
  },
  {
    category: 'phone',
    label: 'Phone number',
    regex: /(?<![\w.\-])(?:\+1[\s.\-]?)?(?:\(?\d{3}\)?[\s.\-])\d{3}[\s.\-]\d{4}(?![\w.\-])/g,
    mask: (m) => `+* (${m.replace(/\D/g, '').slice(0, 3)}) ***-****`,
  },
  {
    category: 'api-key',
    label: 'API key (generic)',
    regex: /\b(?:api[_-]?key|apikey|secret|token)[\s:=]+["']?([A-Za-z0-9\-_/]{16,})["']?/gi,
    mask: () => '[REDACTED key]',
  },
  {
    category: 'api-key',
    label: 'OpenAI-style API key',
    regex: /\bsk-[A-Za-z0-9_\-]{16,}\b/g,
    mask: () => 'sk-***',
  },
  {
    category: 'aws-key',
    label: 'AWS access key',
    regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    mask: () => 'AKIA***',
  },
  {
    category: 'credit-card',
    label: 'Credit-card-like number',
    regex: /\b(?:\d[ -]?){13,19}\b/g,
    mask: (m) => `****-****-${m.replace(/\D/g, '').slice(-4)}`,
  },
  {
    category: 'ssn',
    label: 'SSN-like number',
    regex: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g,
    mask: () => '***-**-1234',
  },
  {
    category: 'ip-address',
    label: 'IP address',
    regex: /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g,
    mask: (m) => m.split('.').map((p, i) => (i < 3 ? '***' : p)).join('.'),
  },
];

export function detectSensitive(text: string): SensitiveHit[] {
  const hits: SensitiveHit[] = [];
  for (const rule of RULES) {
    rule.regex.lastIndex = 0;
    const matches: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = rule.regex.exec(text)) !== null && matches.length < 50) {
      matches.push(m[0]);
      if (m.index === rule.regex.lastIndex) rule.regex.lastIndex += 1; // avoid zero-length loop
    }
    if (matches.length === 0) continue;
    // Dedupe overlapping categories: IP matches inside longer digit runs etc.
    const samples = Array.from(new Set(matches)).slice(0, 3).map(rule.mask);
    hits.push({ category: rule.category, label: rule.label, samples, count: matches.length });
  }
  // merge same-category entries (e.g. generic + openai keys)
  const merged = new Map<string, SensitiveHit>();
  for (const h of hits) {
    const key = `${h.category}:${h.label}`;
    const prev = merged.get(key);
    if (prev) {
      prev.count += h.count;
      prev.samples = Array.from(new Set([...prev.samples, ...h.samples])).slice(0, 3);
    } else merged.set(key, { ...h });
  }
  return Array.from(merged.values());
}

export function hasSensitive(text: string): boolean {
  return detectSensitive(text).length > 0;
}

/** Replace detected sensitive values with typed redaction markers. */
export function redactSensitive(text: string): string {
  let out = text;
  for (const rule of RULES) {
    out = out.replace(rule.regex, `[REDACTED:${rule.category}]`);
  }
  return out;
}
