/**
 * Modality Governance Gateway — evaluates content BEFORE (or alongside)
 * model processing. One logical layer for every modality: the checkpoints in
 * §20 are reported per item, injection controls are not text-only, and
 * provenance is a TRUST SIGNAL — never an authorization decision.
 *
 * Absence of C2PA ≠ fake. Presence of C2PA ≠ safe.
 */

import { governQuery } from '@promptslim/governance';
import type {
  ContentItem, ModalityClass, ModalityFinding, ModalityReport, TrustLevel,
} from './types.ts';

export interface Checkpoint {
  id: string;
  label: string;
  status: 'pass' | 'attention' | 'fail' | 'not-applicable';
  detail: string;
}

export interface FullModalityReport extends ModalityReport {
  checkpoints: Checkpoint[];
}

/* ------------------------------------------------------------------ */
/* injection controls that do NOT assume plain text                    */
/* ------------------------------------------------------------------ */

interface InjectionRule {
  code: string;
  label: string;
  regex: RegExp;
  severity: ModalityFinding['severity'];
}

/** Rules that fire on visible text, OCR output, transcripts or subtitles. */
const INSTRUCTION_RULES: InjectionRule[] = [
  { code: 'INJ-OVERRIDE', label: 'Instruction-override attempt', regex: /\b(ignore|disregard|forget|override|bypass)\b[\s\S]{0,60}\b(instructions?|rules?|limits?|policies|controls|thresholds?)\b/i, severity: 'critical' },
  { code: 'INJ-ROLE', label: 'Role / hierarchy spoofing', regex: /\b(you are now|act as|pretend to be|from now on)\b[\s\S]{0,40}\b(system|developer|admin|root|assistant)\b/i, severity: 'high' },
  { code: 'INJ-TOOL', label: 'Embedded tool-invocation instruction', regex: /\b(createBeneficiary|transferFunds|executeTransfer|approvePayment|updateBeneficiary|setLimit|grantRole|runSql|shellExec)\b/, severity: 'critical' },
  { code: 'INJ-SECRET', label: 'System-prompt / policy extraction', regex: /\b(reveal|print|repeat|output|expose)\b[\s\S]{0,40}\b(system prompt|hidden instructions?|policies|rules)\b/i, severity: 'high' },
  { code: 'INJ-URGENCY', label: 'Urgency + financial instruction combination', regex: /\b(immediately|urgent|right now|bypass|emergency)\b[\s\S]{0,60}\b\$\s?\d|\btransfer\b[\s\S]{0,40}\b(immediately|urgent|now)\b/i, severity: 'high' },
  { code: 'INJ-ENCODED', label: 'Encoded / obfuscated instruction block', regex: /(?:[A-Za-z0-9+/]{140,}={0,2})|(?:\\u00[0-9a-f]{2}[\\u00-\\u7f]{0,20}){6,}/, severity: 'medium' },
  { code: 'INJ-HIDDEN-UNICODE', label: 'Hidden Unicode manipulation', regex: /[\u200B-\u200F\u2028\u2029\u2060\uFEFF\u00AD\u061C]{3,}/, severity: 'medium' },
  { code: 'INJ-FAKE-SYSTEM', label: 'Fake system-message framing', regex: /(\[system\]|\[assistant\]|<system>|BEGIN SYSTEM|### SYSTEM)/i, severity: 'high' },
];

/** Surface-specific signals: hidden text in PDFs, OCR in images, QR codes … */
function surfaceFindings(item: ContentItem): ModalityFinding[] {
  const out: ModalityFinding[] = [];
  const t = item.text ?? '';
  switch (item.modality) {
    case 'DOCUMENT':
      if (/<!--[\s\S]*?-->/.test(t)) out.push({ code: 'DOC-HIDDEN', label: 'Hidden content in document markup', severity: 'high', detail: 'HTML/XML comment or hidden run detected in the document body.' });
      if (/\b(disregard|ignore)\b[\s\S]{0,40}\b(previous|above|visible)\b/i.test(t)) out.push({ code: 'DOC-STEALTH', label: 'Visually hidden instruction', severity: 'critical', detail: 'Instruction references content the reader cannot see — classic white-text/hidden-layer injection.' });
      if (/\bQR\b|quick response code/i.test(t)) out.push({ code: 'DOC-QR', label: 'QR code present', severity: 'medium', detail: 'QR codes can carry instructions or payloads outside the visible text stream.' });
      if (/\b(macro|vba|\.xlsm|\.docm)\b/i.test(t)) out.push({ code: 'DOC-MACRO', label: 'Macro-enabled document', severity: 'high', detail: 'Macro content requires sandboxed handling before agent ingestion.' });
      if (/\bhttps?:\/\//i.test(t)) out.push({ code: 'DOC-EXTLINK', label: 'External references', severity: 'low', detail: 'Document links to external resources — retrieval must be treated as untrusted.' });
      break;
    case 'IMAGE':
      if (/\b(ocr|extracted text)/i.test(t) || item.contentClass === 'External Content') {
        // OCR text scanned by the shared rules below
      }
      if (/\b(instruction|ignore|transfer|change (the )?bank|beneficiary)\b/i.test(t)) {
        out.push({ code: 'IMG-OCR-INSTR', label: 'OCR-extracted instruction in image', severity: 'high', detail: 'Text extracted from the image contains an imperative instruction to the agent.' });
      }
      if (/\b(signature|passport|driver'?s license|iban|account number|routing)\b/i.test(t)) {
        out.push({ code: 'IMG-SENSITIVE', label: 'Sensitive document/identity content in image', severity: 'high', detail: 'Image appears to contain identity or account data — minimization and access rules apply.' });
      }
      if (/\bqr\b/i.test(t)) out.push({ code: 'IMG-QR', label: 'QR code present', severity: 'medium', detail: 'QR content must be decoded and governed as its own content item.' });
      if (/\b(face|biometric|selfie)\b/i.test(t)) out.push({ code: 'IMG-BIO', label: 'Biometric content', severity: 'high', detail: 'Biometric handling requires explicit lawful basis and policy.' });
      break;
    case 'AUDIO':
    case 'VOICE':
      if (/\b(whisper|inaudible|side channel|background voice)\b/i.test(t)) out.push({ code: 'AUD-SIDECHANNEL', label: 'Low-volume / background instruction channel', severity: 'high', detail: 'A secondary audio channel can carry instructions the transcript reader never sees.' });
      break;
    case 'VIDEO':
    case 'LIVE VIDEO':
      if (/\bsubtitle|\ccaption/i.test(t)) out.push({ code: 'VID-SUBTITLE', label: 'Subtitle track carries instruction-like content', severity: 'high', detail: 'Subtitle/metadata instructions are a known multimodal injection vector.' });
      if (/\b(cfo|ceo|transfer)\b[\s\S]{0,40}\b(now|immediately)\b/i.test(t)) out.push({ code: 'VID-EXEC-CLAIM', label: 'Executive authority claim in video', severity: 'high', detail: 'An executive identity claim in media is not authorization — out-of-band verification required.' });
      break;
    case 'EXTERNAL WEB CONTENT':
    case 'TOOL OUTPUT':
    case 'AGENT MESSAGE':
      out.push({ code: `${item.modality === 'TOOL OUTPUT' ? 'TOOL' : 'SRC'}-UNTRUSTED`, label: `${item.modality} treated as untrusted input`, severity: 'info', detail: 'Content from this source may never elevate to instruction status.' });
      break;
    default:
      break;
  }
  return out;
}

/** Scan any extracted text stream for instruction-attack patterns. */
export function detectInjection(text: string): ModalityFinding[] {
  const findings: ModalityFinding[] = [];
  for (const rule of INSTRUCTION_RULES) {
    const m = rule.regex.exec(text);
    if (m) {
      findings.push({
        code: rule.code,
        label: rule.label,
        severity: rule.severity,
        detail: `matched: ${clip(m[0])}`,
      });
    }
  }
  // reuse the platform's language/jailbreak guardrails for text streams
  if (text.trim().length > 0) {
    try {
      const rep = governQuery(text);
      for (const g of rep.guardrails) {
        findings.push({
          code: `PLAT-${g.id.toUpperCase()}`,
          label: g.label,
          severity: rep.verdict === 'block' ? 'critical' : 'high',
          detail: `platform guardrail hit: ${clip(g.sample)}`,
        });
      }
      if (rep.sensitive.length) {
        findings.push({
          code: 'SENSITIVE-DATA',
          label: 'Sensitive data present',
          severity: 'medium',
          detail: `${rep.sensitive.length} sensitive item(s): ${rep.sensitive.map((s) => s.label).join(', ')} (masked)`,
        });
      }
    } catch {
      /* guardrail engine unavailable → injection state stays as detected above */
    }
  }
  return findings;
}

function clip(s: string, n = 80): string {
  const clean = s.replace(/\s+/g, ' ').trim();
  return clean.length > n ? `${clean.slice(0, n)}…` : clean;
}

/* ------------------------------------------------------------------ */
/* provenance                                                          */
/* ------------------------------------------------------------------ */

export function provenanceFindings(item: ContentItem): ModalityFinding[] {
  const out: ModalityFinding[] = [];
  switch (item.provenance) {
    case 'valid':
      out.push({ code: 'PROV-VALID', label: 'Content Credentials validated', severity: 'info', detail: 'Manifest present and signature valid — a TRUST SIGNAL, not an authorization decision.' });
      break;
    case 'absent':
      out.push({ code: 'PROV-ABSENT', label: 'No provenance manifest', severity: 'low', detail: 'No C2PA manifest found. This does NOT establish that the asset is fake — provenance is one signal among several.' });
      break;
    case 'invalid':
      out.push({ code: 'PROV-INVALID', label: 'Provenance manifest failed validation', severity: 'high', detail: 'Manifest present but signature/history validation failed — escalate per use case.' });
      break;
    case 'partial':
      out.push({ code: 'PROV-PARTIAL', label: 'Partial provenance (ingredient or segment gap)', severity: 'medium', detail: 'Some segments or ingredients are unsigned — continuity is incomplete.' });
      break;
    default:
      out.push({ code: 'PROV-UNKNOWN', label: 'Provenance unknown', severity: 'low', detail: 'No provenance information available for evaluation.' });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* cross-modal consistency                                              */
/* ------------------------------------------------------------------ */

export interface CrossModalInput {
  modality: ModalityClass;
  /** field name → value as that modality states it (e.g. amount: "750000") */
  fields: Record<string, string>;
}

export function detectCrossModalConflict(inputs: CrossModalInput[]): ModalityFinding | null {
  const byField = new Map<string, Array<{ modality: ModalityClass; value: string }>>();
  for (const input of inputs) {
    for (const [k, v] of Object.entries(input.fields)) {
      const norm = normalize(v);
      const list = byField.get(k) ?? [];
      list.push({ modality: input.modality, value: norm });
      byField.set(k, list);
    }
  }
  const diffs: string[] = [];
  for (const [field, list] of byField) {
    const values = new Set(list.map((x) => x.value));
    if (values.size > 1) {
      diffs.push(
        `${field}: ${list.map((x) => `${x.modality}="${x.value}"`).join(' vs ')}`,
      );
    }
  }
  if (!diffs.length) return null;
  return {
    code: 'XMOD-CONFLICT',
    label: 'Cross-modal inconsistency',
    severity: 'high',
    detail: `Modalities disagree — ${diffs.join('; ')}`,
  };
}

function normalize(v: string): string {
  const digits = v.replace(/[^\d.]/g, '');
  if (digits && /^[\d.,\s$€£]+$/.test(v)) {
    const n = Number(digits.replace(/,/g, ''));
    if (Number.isFinite(n)) return String(n);
  }
  return v.trim().toLowerCase().replace(/\s+/g, ' ');
}

/* ------------------------------------------------------------------ */
/* full evaluation                                                      */
/* ------------------------------------------------------------------ */

export function evaluateContent(
  item: ContentItem,
  opts: { permittedModalities?: ModalityClass[]; purposeAllowsModality?: boolean } = {},
): FullModalityReport {
  const findings: ModalityFinding[] = [];

  const injection = detectInjection(item.text ?? '');
  findings.push(...injection);
  findings.push(...surfaceFindings(item));
  findings.push(...provenanceFindings(item));

  const injectionDetected = injection.some((f) => f.severity === 'critical' || f.code.startsWith('INJ-') && f.severity === 'high');
  const instrHigh = injection.some((f) => f.severity === 'critical');
  const sensitive = injection.some((f) => f.code === 'SENSITIVE-DATA');

  /* instruction trust: content class decides whether text may act as instruction */
  const instructionTrust = trustFor(item);
  const mayInstruct = instructionTrust === 'trusted' || instructionTrust === 'internal';

  const modalityAllowed =
    (opts.permittedModalities ?? []).length === 0
      ? opts.purposeAllowsModality !== false
      : opts.permittedModalities!.includes(item.modality);

  let verdict: ModalityReport['verdict'] = 'PASS';
  if (instrHigh || item.injectionRisk === 'detected' || !modalityAllowed) verdict = 'BLOCK';
  else if (findings.some((f) => f.severity === 'high') || injectionDetected || sensitive || item.trust === 'untrusted') verdict = 'REVIEW';

  const checkpoints: Checkpoint[] = [
    cp('source', 'Source', item.source, item.trust === 'trusted' || item.trust === 'internal' ? 'pass' : 'attention', `supplied by ${item.source} · trust=${item.trust}`),
    cp('provenance', 'Provenance', item.provenance, item.provenance === 'valid' ? 'pass' : item.provenance === 'invalid' ? 'fail' : 'attention', findings.find((f) => f.code.startsWith('PROV-'))?.detail ?? ''),
    cp('trust', 'Trust', item.trust, item.trust === 'trusted' ? 'pass' : item.trust === 'untrusted' ? 'fail' : 'attention', `classified ${item.trust}`),
    cp('integrity', 'Integrity', item.integrity, item.integrity === 'verified' ? 'pass' : item.integrity === 'broken' || item.integrity === 'changed' ? 'fail' : 'attention', `integrity state ${item.integrity}`),
    cp('sensitivity', 'Sensitivity', item.sensitivity, item.sensitivity === 'regulated' || item.sensitivity === 'restricted' ? 'attention' : 'pass', `classified ${item.sensitivity}`),
    cp('injection', 'Injection Risk', item.injectionRisk, verdict === 'BLOCK' ? 'fail' : injectionDetected || item.injectionRisk !== 'none' ? 'attention' : 'pass', injection.length ? `${injection.length} signal(s): ${injection.map((f) => f.code).join(', ')}` : 'no injection signals'),
    cp('synthetic', 'Synthetic Media', item.syntheticMediaState, item.syntheticMediaState === 'detected' ? 'fail' : item.syntheticMediaState === 'possible' ? 'attention' : 'pass', `state=${item.syntheticMediaState}`),
    cp('identity', 'Identity Claim', item.contentClass === 'Agent Message' || item.contentClass === 'External Content' ? 'claimed' : 'n/a', item.contentClass === 'External Content' ? 'attention' : 'pass', 'content purporting to represent a person/entity is treated as a claim, not proof'),
    cp('consent', 'Consent / Disclosure', item.disclosures ?? 'Not Required', (item.disclosures === 'Required' || item.disclosures === 'Unknown / Review Needed') ? 'attention' : 'pass', `disclosure=${item.disclosures ?? 'Not Required'}`),
    cp('minimization', 'Data Minimization', item.sensitivity, sensitive ? 'attention' : 'pass', sensitive ? 'contains sensitive fields — redact/tokenize before model call' : 'no excess sensitive fields detected'),
    cp('policy', 'Policy', item.policyState, item.policyState === 'block' ? 'fail' : item.policyState === 'review' ? 'attention' : 'pass', `policy state ${item.policyState}`),
    cp('separation', 'Action Separation', 'enforced', mayInstruct && verdict === 'BLOCK' ? 'fail' : 'pass', mayInstruct
      ? 'content is trusted enough to inform reasoning; consequential action still passes the runtime gateway'
      : 'content may NOT instruct the agent — it is data, not authority'),
  ];

  return {
    item,
    findings,
    instructionTrust,
    mayInstruct,
    verdict,
    checkpoints,
  };
}

function cp(id: string, label: string, _v: unknown, status: Checkpoint['status'], detail: string): Checkpoint {
  return { id, label, status, detail };
}

function trustFor(item: ContentItem): TrustLevel {
  switch (item.contentClass) {
    case 'System Instruction':
    case 'Enterprise Policy':
      return 'trusted';
    case 'User Instruction':
      return item.trust === 'untrusted' ? 'unknown' : 'internal';
    case 'Retrieved Context':
    case 'External Content':
    case 'Tool Result':
      return item.trust === 'trusted' || item.trust === 'internal' ? 'internal' : 'untrusted';
    case 'Agent Message':
      return item.trust === 'trusted' ? 'internal' : item.trust === 'untrusted' ? 'untrusted' : 'external';
    default:
      return item.trust;
  }
}