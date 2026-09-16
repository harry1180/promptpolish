import { LEVEL_TARGET_HINT } from '@promptslim/optimizer';
import type { OptimizationLevel } from '@promptslim/shared-types';

interface LevelSelectorProps {
  value: OptimizationLevel;
  onChange: (l: OptimizationLevel) => void;
}

const LEVELS: Array<{ id: OptimizationLevel; label: string }> = [
  { id: 'conservative', label: 'Conservative' },
  { id: 'balanced', label: 'Balanced' },
  { id: 'aggressive', label: 'Aggressive' },
];

export function LevelSelector({ value, onChange }: LevelSelectorProps) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <div className="card flex overflow-hidden p-1" role="radiogroup" aria-label="Optimization level">
        {LEVELS.map((l) => (
          <button
            key={l.id}
            role="radio"
            aria-checked={value === l.id}
            onClick={() => onChange(l.id)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              value === l.id
                ? l.id === 'aggressive'
                  ? 'bg-amber-soft/15 text-amber-soft'
                  : 'bg-mint/12 text-mint'
                : 'text-mist hover:text-slate-soft'
            }`}
          >
            {l.label}
          </button>
        ))}
      </div>
      <p className="text-xs text-mist max-w-[420px]">
        {value === 'aggressive' ? (
          <span className="text-amber-soft">{LEVEL_TARGET_HINT.aggressive}</span>
        ) : (
          LEVEL_TARGET_HINT[value]
        )}
      </p>
    </div>
  );
}
