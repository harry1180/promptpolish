import { catalog } from '@promptslim/model-config';
import { costBreakdown, formatNumber, formatUSD } from '@promptslim/pricing-engine';
import type { PromptSlim } from '../hooks/usePromptSlim';
import { MetricCard } from './MetricCard';

export function MetricsRow({ slim }: { slim: PromptSlim }) {
  const { result, analysis, outputEstimate, outputTokens, outputOverride, model } = slim;
  const origTok = result?.originalTokens ?? analysis?.tokens ?? null;
  const full = result && outputTokens !== null
    ? costBreakdown(model, result.optimizedTokens.tokens, outputTokens)
    : null;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
      <MetricCard
        label="Original tokens"
        value={origTok ? formatNumber(origTok.tokens) : '—'}
        sub={origTok ? `${origTok.method === 'exact' ? 'Exact count' : 'Estimated'} · ${formatNumber(analysis?.words ?? 0)} words · ${formatNumber(analysis?.characters ?? 0)} chars` : 'Paste a prompt to measure'}
        tone="violet"
        popKey={`o-${origTok?.tokens ?? 0}`}
      />
      <MetricCard
        label="Optimized tokens"
        value={result ? formatNumber(result.optimizedTokens.tokens) : '—'}
        sub={result ? `${result.level} · ${result.preservation.overall}% preserved` : 'Run optimization to compare'}
        tone="default"
        popKey={`n-${result?.optimizedTokens.tokens ?? 0}`}
      />
      <MetricCard
        label="Est. output tokens"
        value={outputTokens !== null ? `~${formatNumber(outputTokens)}` : '—'}
        sub={
          outputOverride !== null
            ? 'your manual setting'
            : outputEstimate?.basis === 'learned'
              ? `calibrated · ${outputEstimate.sampleSize} measured`
              : outputEstimate
                ? `projected · ${outputEstimate.shapeLabel}`
                : 'projected from prompt shape'
        }
        tone="amber"
        popKey={`x-${outputTokens ?? 0}`}
      />
      <MetricCard
        label="Token reduction"
        value={result ? `${result.reductionPercent.toFixed(1)}%` : '—'}
        sub={result ? `${formatNumber(result.originalTokens.tokens - result.optimizedTokens.tokens)} tokens removed` : ''}
        tone="mint"
        popKey={`r-${result?.reductionPercent ?? 0}`}
      />
      <MetricCard
        label="Cost reduction"
        value={
          result && slim.savings && result.originalTokens.tokens > 0
            ? `${((slim.savings.perRequest /
                ((result.originalTokens.tokens / 1e6) * slim.model.inputPricePerMillionTokens)) *
                100).toFixed(1)}%`
            : '—'
        }
        sub={result && slim.savings ? `${formatUSD(slim.savings.perRequest)} / request saved` : 'Same reduction, in dollars'}
        tone="mint"
        popKey={`c-${result?.reductionPercent ?? 0}`}
      />
      <MetricCard
        label="Full req. cost"
        value={full ? formatUSD(full.totalCost) : '—'}
        sub={full ? `in ${formatUSD(full.inputCost)} · out ${formatUSD(full.outputCost)}` : 'input + projected output'}
        tone="violet"
        popKey={`f-${full?.totalCost ?? 0}`}
      />
    </div>
  );
}

export function CostComparison({ slim }: { slim: PromptSlim }) {
  const { result, model, savings, requests, setRequests, outputEstimate, outputTokens, outputOverride, setOutputOverride } = slim;
  const inPrice = model.inputPricePerMillionTokens;
  const costBefore = result ? (result.originalTokens.tokens / 1e6) * inPrice : null;
  const costAfter = result ? (result.optimizedTokens.tokens / 1e6) * inPrice : null;
  const outCost = outputTokens !== null ? (outputTokens / 1e6) * model.outputPricePerMillionTokens : null;
  return (
    <section className="card overflow-hidden" aria-label="Estimated cost comparison">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-3">
        <h2 className="text-sm font-semibold uppercase tracking-[0.12em] text-mist">
          Estimated cost per request — {model.provider} {model.modelName}
        </h2>
        <span className="text-[11px] text-mist">Pricing last updated: {catalog.pricingLastUpdated}</span>
      </div>
      <div className="grid gap-px bg-line md:grid-cols-4">
        <div className="bg-ink-800/60 p-5">
          <div className="text-xs uppercase tracking-wider text-mist">Before</div>
          <div className="mt-1 font-mono text-3xl font-semibold text-slate-soft">
            {costBefore !== null ? formatUSD(costBefore) : '—'}
          </div>
          <div className="mt-1 text-xs text-mist">
            {result ? `${formatNumber(result.originalTokens.tokens)} input tokens` : 'no data yet'}
          </div>
        </div>
        <div className="bg-ink-800/60 p-5">
          <div className="text-xs uppercase tracking-wider text-mist">After optimization</div>
          <div className="mt-1 font-mono text-3xl font-semibold text-mint">
            {costAfter !== null ? formatUSD(costAfter) : '—'}
          </div>
          <div className="mt-1 text-xs text-mist">
            {result ? `${formatNumber(result.optimizedTokens.tokens)} input tokens` : 'optimize to see'}
          </div>
        </div>
        <div className="bg-ink-800/60 p-5">
          <div className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-mist">
            Output cost
            {outputOverride === null && outputEstimate && (
              <span className="rounded bg-violet-soft/10 px-1.5 py-0.5 text-[9px] font-semibold normal-case tracking-normal text-violet-soft" title={outputEstimate.engine}>
                {outputEstimate.basis === 'learned' ? 'calibrated' : 'projected'}
              </span>
            )}
          </div>
          <div className="mt-1 font-mono text-3xl font-semibold text-violet-soft">
            {outCost !== null ? formatUSD(outCost) : '—'}
          </div>
          <div className="mt-1 text-xs text-mist">
            {outputTokens !== null
              ? `~${formatNumber(outputTokens)} out tokens × ${formatUSD(model.outputPricePerMillionTokens)}/M`
              : 'paste a prompt to project'}
          </div>
        </div>
        <div className="bg-mint/[0.06] p-5">
          <div className="text-xs uppercase tracking-wider text-mint-dim">Saving per request</div>
          <div className="mt-1 font-mono text-3xl font-semibold text-mint" key={`s-${savings?.perRequest}`}>
            {savings ? formatUSD(savings.perRequest) : '—'}
          </div>
          <div className="mt-1 text-xs text-mint-dim/80">
            {result ? `${formatNumber(result.originalTokens.tokens - result.optimizedTokens.tokens)} tokens × ${formatUSD(inPrice)}/M` : ''}
          </div>
        </div>
      </div>

      {/* Expected output length control */}
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3 border-t border-line px-5 py-4">
        <label className="text-sm text-mist">
          Expected output length (tokens)
          <div className="mt-1.5 flex items-center gap-2">
            <input
              type="number"
              min={0}
              step={50}
              value={outputTokens ?? ''}
              placeholder={outputEstimate ? String(outputEstimate.tokens) : '—'}
              onChange={(e) => {
                const v = e.target.value;
                setOutputOverride(v === '' ? null : Math.max(0, Number(v) || 0));
              }}
              className="card w-32 bg-ink-900 px-3 py-2 font-mono text-base text-slate-soft"
              aria-label="Expected output tokens"
            />
            <button
              onClick={() => setOutputOverride(null)}
              disabled={outputOverride === null}
              className={`rounded-md border px-2.5 py-1.5 text-xs transition-colors ${
                outputOverride === null
                  ? 'border-line/60 text-mist/50'
                  : 'border-violet-soft/50 text-violet-soft hover:bg-violet-soft/10'
              }`}
              aria-label="Reset output length to projection"
            >
              Auto
            </button>
          </div>
        </label>
        <p className="ml-auto max-w-sm text-right text-[11px] leading-snug text-mist/70">
          {outputEstimate
            ? `Projection reads the response shape your prompt asks for (${outputEstimate.shapeLabel}). Set your own number once you know your typical response length — nothing here calls an LLM.`
            : 'Output tokens are projected from the response shape your prompt asks for — no LLM call.'}
        </p>
      </div>

      {/* Savings calculator */}
      <div className="border-t border-line p-5">
        <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
          <label className="text-sm text-mist">
            Requests per month
            <div className="mt-1.5 flex items-center gap-2">
              <input
                type="number"
                min={1}
                step={1000}
                value={requests}
                onChange={(e) => setRequests(Math.max(1, Number(e.target.value) || 1))}
                className="card w-40 bg-ink-900 px-3 py-2 font-mono text-lg text-slate-soft"
                aria-label="Requests per month"
              />
              <div className="flex gap-1">
                {[1_000, 10_000, 100_000, 1_000_000].map((t) => (
                  <button
                    key={t}
                    onClick={() => setRequests(t)}
                    className={`rounded-md border px-2 py-1 text-xs transition-colors ${
                      requests === t
                        ? 'border-mint/50 bg-mint/10 text-mint'
                        : 'border-line text-mist hover:text-slate-soft'
                    }`}
                  >
                    {t >= 1_000_000 ? '1M' : `${t / 1000}K`}
                  </button>
                ))}
              </div>
            </div>
          </label>
          <div className="ml-auto text-right">
            <div className="text-xs uppercase tracking-wider text-mist">Estimated monthly savings</div>
            <div
              className="animate-pop font-mono text-4xl font-bold text-mint md:text-5xl"
              key={`m-${savings?.monthlyByTier[requests]}`}
            >
              {savings ? formatUSD(savings.monthlyByTier[requests] ?? 0) : '—'}
            </div>
            <div className="mt-0.5 font-mono text-sm text-mint-dim">
              {savings ? `≈ ${formatUSD(savings.annual)} / year` : ''}
            </div>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2 lg:grid-cols-4">
          {[1_000, 10_000, 100_000, 1_000_000].map((t) => (
            <div key={t} className="rounded-lg border border-line bg-ink-900/60 px-3 py-2 text-center">
              <div className="text-[11px] text-mist">{formatNumber(t)} req/mo</div>
              <div className="font-mono text-sm text-slate-soft">
                {savings ? formatUSD(savings.monthlyByTier[t] ?? 0) : '—'}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
