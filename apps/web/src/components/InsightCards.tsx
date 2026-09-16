import type { QualityMetrics, StructureAnalysis } from '@promptslim/shared-types';

export function StructureCard({ structure }: { structure: StructureAnalysis }) {
  const items: Array<[string, boolean]> = [
    ['Role', structure.role],
    ['Objective', structure.objective],
    ['Context', structure.context],
    ['Constraints', structure.constraints],
    ['Examples', structure.examples],
    ['Output format', structure.outputFormat],
  ];
  const present = items.filter(([, v]) => v).length;
  return (
    <div className="card p-4">
      <h3 className="mb-2.5 text-xs font-semibold uppercase tracking-[0.12em] text-mist">
        Prompt structure <span className="normal-case text-mist/70">({present}/6 detected)</span>
      </h3>
      <div className="flex flex-wrap gap-1.5">
        {items.map(([label, ok]) => (
          <span
            key={label}
            title={ok ? 'Detected in prompt' : 'Not detected (informational only)'}
            className={`rounded-full border px-2.5 py-1 text-xs ${
              ok ? 'border-mint/40 bg-mint/10 text-mint' : 'border-line text-mist/70 line-through decoration-mist/40'
            }`}
          >
            {ok ? '●' : '○'} {label}
          </span>
        ))}
      </div>
      <p className="mt-2.5 text-[11px] leading-snug text-mist/70">
        Informational only — PromptPolice does not rewrite your prompt into a template.
      </p>
    </div>
  );
}

export function QualityCard({ quality }: { quality: QualityMetrics }) {
  const rows: Array<[string, number]> = [
    ['Redundancy', quality.redundancy],
    ['Instruction density', quality.instructionDensity],
    ['Constraint clarity', quality.constraintClarity],
    ['Structure', quality.structure],
  ];
  return (
    <div className="card p-4">
      <div className="flex items-baseline justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-mist">
          Token efficiency score
        </h3>
        <span className="font-mono text-2xl font-bold text-violet-soft">{quality.score}<span className="text-sm text-mist">/100</span></span>
      </div>
      <div className="mt-3 space-y-2">
        {rows.map(([label, v]) => (
          <div key={label} className="flex items-center gap-2">
            <span className="w-36 shrink-0 text-xs text-mist">{label}</span>
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-ink-700" role="meter" aria-valuenow={v} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
              <div
                className="h-full rounded-full bg-gradient-to-r from-violet-soft to-mint transition-all duration-500"
                style={{ width: `${v}%` }}
              />
            </div>
            <span className="w-8 shrink-0 text-right font-mono text-xs text-mist">{v}</span>
          </div>
        ))}
      </div>
      <p className="mt-2.5 text-[11px] leading-snug text-mist/70">
        Measures how economically the prompt spends tokens — it does not predict answer quality or accuracy.
      </p>
    </div>
  );
}
