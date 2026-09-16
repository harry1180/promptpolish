import type { ChangeLogEntry, PreservationScores } from '@promptslim/shared-types';
import { IconCheck, IconWarn } from './Icons';

const KIND_LABEL: Record<ChangeLogEntry['kind'], { text: string; cls: string }> = {
  'removed-duplicate': { text: 'Duplicate', cls: 'text-mint' },
  'compressed-phrase': { text: 'Compressed', cls: 'text-violet-soft' },
  'collapsed-whitespace': { text: 'Whitespace', cls: 'text-mist' },
  'removed-filler': { text: 'Filler', cls: 'text-mint' },
  'combined-constraints': { text: 'Combined', cls: 'text-mint' },
  'removed-redundant-instruction': { text: 'Redundant', cls: 'text-mint' },
  'compressed-example': { text: 'Example', cls: 'text-amber-soft' },
  'preserved-json-schema': { text: 'Kept', cls: 'text-slate-soft' },
  'preserved-xml': { text: 'Kept', cls: 'text-slate-soft' },
  'preserved-placeholder': { text: 'Kept', cls: 'text-slate-soft' },
};

export function ChangesPanel({
  changes,
  preservation,
}: {
  changes: ChangeLogEntry[];
  preservation: PreservationScores;
}) {
  return (
    <section className="card p-5" aria-label="Optimization changes">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-[0.12em] text-mist">
          Optimization changes ({changes.length})
        </h2>
        <PreservationChips p={preservation} />
      </div>

      {preservation.warnings.length > 0 && (
        <ul className="mb-3 space-y-1.5">
          {preservation.warnings.map((w, i) => (
            <li key={i} className="flex items-start gap-2 rounded-lg border border-amber-soft/30 bg-amber-soft/5 px-3 py-2 text-sm text-amber-soft">
              <span className="mt-0.5"><IconWarn /></span>
              {w}
            </li>
          ))}
        </ul>
      )}
      {preservation.notes.length > 0 && (
        <ul className="mb-3 grid gap-1 sm:grid-cols-2">
          {preservation.notes.slice(0, 8).map((n, i) => (
            <li key={i} className="flex items-start gap-2 text-xs text-mint-dim">
              <span className="mt-0.5 shrink-0"><IconCheck /></span>
              <span className="truncate" title={n}>{n}</span>
            </li>
          ))}
          {preservation.notes.length > 8 && (
            <li className="text-xs text-mist">+{preservation.notes.length - 8} more preserved items</li>
          )}
        </ul>
      )}

      <ul className="thin-scroll max-h-64 space-y-1 overflow-y-auto pr-1">
        {changes.map((c, i) => {
          const meta = KIND_LABEL[c.kind];
          return (
            <li key={i} className="flex items-baseline gap-2 border-b border-line/50 py-1.5 text-sm last:border-0">
              <span className={`w-24 shrink-0 text-[11px] font-semibold uppercase tracking-wide ${meta.cls}`}>
                {meta.text}
              </span>
              <span className="min-w-0 flex-1 text-slate-soft">{c.description}</span>
              {c.tokensSaved > 0 && (
                <span className="shrink-0 font-mono text-xs text-mist">-{c.tokensSaved} tok</span>
              )}
            </li>
          );
        })}
        {changes.length === 0 && <li className="text-sm text-mist">No changes recorded.</li>}
      </ul>
    </section>
  );
}

function PreservationChips({ p }: { p: PreservationScores }) {
  const chip = (label: string, v: number) => (
    <span
      className={`rounded-full border px-2.5 py-1 text-xs font-medium ${
        v >= 95
          ? 'border-mint/40 bg-mint/10 text-mint'
          : v >= 80
            ? 'border-amber-soft/30 bg-amber-soft/5 text-amber-soft'
            : 'border-danger/40 bg-danger/10 text-danger'
      }`}
    >
      {label} {v}%
    </span>
  );
  return (
    <div className="flex flex-wrap gap-1.5" aria-label="Prompt preservation score">
      {chip('Intent', p.intent)}
      {chip('Constraints', p.constraints)}
      {chip('Format', p.outputFormat)}
      {chip('Variables', p.placeholders)}
      {chip('Overall', p.overall)}
    </div>
  );
}
