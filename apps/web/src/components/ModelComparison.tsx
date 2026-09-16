import { useMemo, useState } from 'react';
import { catalog } from '@promptslim/model-config';
import { compareModels, formatNumber, formatUSD } from '@promptslim/pricing-engine';

interface ModelComparisonProps {
  inputTokens: number | null;
  /** Effective expected output length (override or projection); null = none yet. */
  outputTokens: number | null;
  /** true when outputTokens comes from the automatic projection, not the user. */
  outputIsProjected: boolean;
  selectedModelId: string;
}

type SortKey = 'cheapest' | 'provider' | 'context' | 'output';

/** All rows/prices derived from @promptslim/model-config — zero hardcoded pricing. */
export function ModelComparison({ inputTokens, outputTokens, outputIsProjected, selectedModelId }: ModelComparisonProps) {
  const [sort, setSort] = useState<SortKey>('cheapest');
  const inTokens = inputTokens ?? 1500; // sample prompt fallback when nothing typed yet
  const outTokens = outputTokens ?? 400;
  const usingSample = inputTokens === null;

  const rows = useMemo(() => {
    const data = compareModels(inTokens, outTokens);
    if (sort === 'cheapest') data.sort((a, b) => a.costPerRequest - b.costPerRequest);
    if (sort === 'provider') data.sort((a, b) => a.model.provider.localeCompare(b.model.provider) || a.costPerRequest - b.costPerRequest);
    if (sort === 'context') data.sort((a, b) => b.model.contextWindow - a.model.contextWindow);
    if (sort === 'output') data.sort((a, b) => a.outputCost - b.outputCost);
    return data;
  }, [inTokens, outTokens, sort]);

  return (
    <section className="card overflow-hidden" id="models" aria-label="Model cost comparison">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3.5">
        <div>
          <h2 className="text-base font-semibold text-slate-soft">Model cost comparison</h2>
          <p className="text-xs text-mist">
            Same prompt priced across all providers:{' '}
            <span className="font-mono">{formatNumber(inTokens)} input</span> +{' '}
            <span className="font-mono">{formatNumber(outTokens)} output</span> tokens per request
            {usingSample && <span className="text-mist/60"> (sample prompt — run an optimization to use yours)</span>}
            {!usingSample && outputIsProjected && <span className="text-mist/60"> (output length projected — adjust it in the cost panel)</span>}
          </p>
        </div>
        <div className="flex gap-1.5" role="radiogroup" aria-label="Sort comparison">
          {(
            [
              ['cheapest', 'Cheapest'],
              ['output', 'Output $'],
              ['provider', 'Provider'],
              ['context', 'Context'],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              role="radio"
              aria-checked={sort === k}
              onClick={() => setSort(k)}
              className={`rounded-md border px-2.5 py-1 text-xs ${
                sort === k ? 'border-mint/50 bg-mint/10 text-mint' : 'border-line text-mist hover:text-slate-soft'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-line text-[11px] uppercase tracking-wider text-mist">
              <th className="px-5 py-2.5 font-medium">Model</th>
              <th className="px-3 py-2.5 font-medium text-right">In $/M</th>
              <th className="px-3 py-2.5 font-medium text-right">Out $/M</th>
              <th className="px-3 py-2.5 font-medium text-right">$/req in</th>
              <th className="px-3 py-2.5 font-medium text-right">$/req out</th>
              <th className="px-3 py-2.5 font-medium text-right">$/req total</th>
              <th className="px-3 py-2.5 font-medium text-right">$/mo @100K</th>
              <th className="px-5 py-2.5 font-medium text-right">Context</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const m = r.model;
              return (
                <tr
                  key={m.id}
                  className={`border-b border-line/50 last:border-0 ${m.id === selectedModelId ? 'bg-mint/[0.06]' : ''}`}
                >
                  <td className="px-5 py-2.5">
                    <span className="text-mist/80">{m.provider}</span>{' '}
                    <span className="font-medium text-slate-soft">{m.modelName}</span>
                    {m.id === selectedModelId && <span className="ml-2 text-[10px] text-mint">● selected</span>}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-mist">{formatUSD(m.inputPricePerMillionTokens)}</td>
                  <td className="px-3 py-2.5 text-right font-mono text-mist">{formatUSD(m.outputPricePerMillionTokens)}</td>
                  <td className="px-3 py-2.5 text-right font-mono text-slate-soft">{formatUSD(r.inputCost)}</td>
                  <td className="px-3 py-2.5 text-right font-mono text-violet-soft">{formatUSD(r.outputCost)}</td>
                  <td className="px-3 py-2.5 text-right font-mono font-semibold text-slate-soft">{formatUSD(r.costPerRequest)}</td>
                  <td className="px-3 py-2.5 text-right font-mono">{formatUSD(r.monthly100k)}</td>
                  <td className="px-5 py-2.5 text-right font-mono text-mist">
                    {m.contextWindow >= 1e6 ? `${m.contextWindow / 1e6}M` : `${Math.round(m.contextWindow / 1024)}K`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="border-t border-line px-5 py-2.5 text-[11px] leading-snug text-mist/80">
        Output length ({formatNumber(outTokens)} tokens) is {outputIsProjected ? 'a local projection from the response shape your prompt asks for — not an LLM call' : 'your manual setting'}; input tokens {usingSample ? 'use a sample figure' : 'are estimated locally'}. {catalog.disclaimer}
      </p>
    </section>
  );
}
