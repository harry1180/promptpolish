import { defaultModelId, getModel, models, providers } from '@promptslim/model-config';
import { formatUSD } from '@promptslim/pricing-engine';

interface ModelSelectorProps {
  value: string;
  onChange: (id: string) => void;
}

/** Grouped by provider; every option shows live price from model-config. */
export function ModelSelector({ value, onChange }: ModelSelectorProps) {
  const current = getModel(value) ?? getModel(defaultModelId)!;
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-mist whitespace-nowrap">Model</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="card max-w-full cursor-pointer bg-ink-800 px-3 py-2 text-sm text-slate-soft outline-none hover:border-ink-600"
      >
        {providers.map((p) => (
          <optgroup key={p} label={p}>
            {models
              .filter((m) => m.provider === p)
              .map((m) => (
                <option key={m.id} value={m.id} className="bg-ink-800">
                  {m.modelName} — ${m.inputPricePerMillionTokens}/${m.outputPricePerMillionTokens} per M
                </option>
              ))}
          </optgroup>
        ))}
      </select>
      <span className="hidden lg:inline text-xs text-mist font-mono">
        {formatUSD(current.inputPricePerMillionTokens)}/M in · {formatUSD(current.outputPricePerMillionTokens)}/M out
      </span>
    </label>
  );
}
