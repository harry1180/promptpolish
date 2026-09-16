import { catalog, getModel } from '@promptslim/model-config';
import { formatUSD } from '@promptslim/pricing-engine';

/**
 * Model picker for the governed chat console: every catalog model (the same
 * options the cost-comparison table prices) plus ⚡ AUTO — deterministic
 * balanced routing across cost · capability · context headroom, executed
 * server-side (packages/llm-connect routeModel).
 */
export function ChatModelSelect({ value, onChange }: {
  value: string;
  onChange: (id: string) => void;
}) {
  const providers = Array.from(new Set(catalog.models.map((m) => m.provider)));
  const current = value === 'auto' ? null : getModel(value);
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="whitespace-nowrap text-mist">Route via</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Chat model"
        className="card max-w-full cursor-pointer bg-ink-800 px-3 py-2 text-sm text-slate-soft outline-none hover:border-ink-600"
      >
        <option value="auto">⚡ Auto — balanced (cost · output · context)</option>
        {providers.map((p) => (
          <optgroup key={p} label={p}>
            {catalog.models
              .filter((m) => m.provider === p)
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {m.modelName} — ${m.inputPricePerMillionTokens}/${m.outputPricePerMillionTokens} per M
                </option>
              ))}
          </optgroup>
        ))}
      </select>
      {current && (
        <span className="hidden font-mono text-xs text-mist lg:inline">
          {formatUSD(current.inputPricePerMillionTokens)}/M in · {formatUSD(current.outputPricePerMillionTokens)}/M out
        </span>
      )}
    </label>
  );
}
