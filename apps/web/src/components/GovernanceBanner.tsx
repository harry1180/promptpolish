import type { GovernanceReport } from '@promptslim/governance';

const VERDICT_STYLE = {
  allow: { chip: 'border-mint/40 bg-mint/10 text-mint', label: 'ALLOW' },
  review: { chip: 'border-amber-soft/40 bg-amber-soft/10 text-amber-soft', label: 'REVIEW' },
  'redact-required': { chip: 'border-violet-soft/40 bg-violet-soft/10 text-violet-soft', label: 'REDACT' },
  block: { chip: 'border-danger/40 bg-danger/10 text-danger', label: 'BLOCKED' },
} as const;

/**
 * Governance verdict for the last screened query: intent label, PII tags,
 * guardrail flags. Deterministic local rules — see packages/governance.
 */
export function GovernanceBanner({ report }: { report: GovernanceReport | null }) {
  if (!report) return null;
  const v = VERDICT_STYLE[report.verdict];
  return (
    <div
      role={report.verdict === 'block' ? 'alert' : undefined}
      aria-label="Governance verdict"
      className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-ink-900/60 px-3.5 py-2.5 text-xs"
    >
      <span className={`rounded-full border px-2 py-0.5 font-semibold tracking-wider ${v.chip}`}>{v.label}</span>
      <span className="rounded-full border border-line px-2 py-0.5 text-mist" title="Keyword-scored intent category (local, deterministic)">
        intent: {report.intent}
      </span>
      {report.sensitive.map((s) => (
        <span key={`${s.category}-${s.label}`} className="rounded-full border border-danger/30 bg-danger/5 px-2 py-0.5 text-danger/90" title={`${s.count} occurrence(s), masked`}>
          {s.label} · {s.samples[0] ?? ''}
        </span>
      ))}
      {report.guardrails.map((g) => (
        <span key={g.id} className="rounded-full border border-amber-soft/30 bg-amber-soft/5 px-2 py-0.5 text-amber-soft" title={`matched: "${g.sample}"`}>
          guardrail: {g.id}
        </span>
      ))}
      <span className="ml-auto max-w-full text-mist/70">{report.reasons[0]}</span>
    </div>
  );
}
