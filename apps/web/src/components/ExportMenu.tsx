import { useState } from 'react';
import { buildExportJSON, buildExportMarkdown, download } from '@promptslim/shared';
import { REQUEST_TIERS, costBreakdown, formatNumber, formatPercent, formatUSD } from '@promptslim/pricing-engine';
import type { PromptSlim } from '../hooks/usePromptSlim';

export function ExportMenu({ slim }: { slim: PromptSlim }) {
  const [open, setOpen] = useState(false);
  const { result, model, savings, requests, outputTokens, outputEstimate, outputOverride } = slim;
  if (!result) return null;

  // full-request economics (input + projected output) for the optimized prompt
  const breakdown =
    outputTokens !== null ? costBreakdown(model, result.optimizedTokens.tokens, outputTokens) : null;
  const outputSource =
    outputOverride !== null
      ? 'manual setting'
      : outputEstimate
        ? `projected (${outputEstimate.shapeLabel})`
        : 'not set';

  const doExport = (fmt: 'txt' | 'md' | 'json') => {
    const stamp = new Date().toISOString().slice(0, 10);
    if (fmt === 'txt') {
      download(
        `promptpolice-${stamp}.txt`,
        `=== ORIGINAL (${formatNumber(result.originalTokens.tokens)} tokens) ===\n${result.originalText}\n\n=== OPTIMIZED / ${result.level} (${formatNumber(result.optimizedTokens.tokens)} tokens, ${formatPercent(result.reductionPercent)} reduction) ===\n${result.optimizedText}\n${
          breakdown
            ? `\n=== COST PER REQUEST — ${model.provider} ${model.modelName} ===\nInput:  ${formatUSD(breakdown.inputCost)} (${formatNumber(result.optimizedTokens.tokens)} tokens)\nOutput: ${formatUSD(breakdown.outputCost)} (~${formatNumber(outputTokens ?? 0)} tokens, ${outputSource})\nTotal:  ${formatUSD(breakdown.totalCost)}\n`
            : ''
        }`,
        'text/plain',
      );
    }
    if (fmt === 'md') {
      download(
        `promptpolice-${stamp}.md`,
        buildExportMarkdown({
          original: result.originalText,
          optimized: result.optimizedText,
          model: `${model.provider} ${model.modelName}`,
          level: result.level,
          stats: [
            `Original tokens: **${formatNumber(result.originalTokens.tokens)}** (${result.originalTokens.method})`,
            `Optimized tokens: **${formatNumber(result.optimizedTokens.tokens)}**`,
            `Token reduction: **${formatPercent(result.reductionPercent)}**`,
            `Savings per request: **${savings ? `$${savings.perRequest.toFixed(5)}` : 'n/a'}**`,
            `At ${formatNumber(requests)} requests/month: **${savings ? `$${Math.round(savings.monthlyByTier[requests] ?? 0).toLocaleString('en-US')}` : 'n/a'}/month**, **${savings ? `$${Math.round(savings.annual).toLocaleString('en-US')}` : 'n/a'}/year**`,
            ...(breakdown
              ? [
                  `Expected output tokens: **~${formatNumber(outputTokens ?? 0)}** (${outputSource})`,
                  `Full request cost (input + output): **${formatUSD(breakdown.totalCost)}** (in ${formatUSD(breakdown.inputCost)} · out ${formatUSD(breakdown.outputCost)})`,
                ]
              : []),
            `Preservation: intent ${result.preservation.intent}% · constraints ${result.preservation.constraints}% · format ${result.preservation.outputFormat}% · variables ${result.preservation.placeholders}%`,
          ],
        }),
        'text/markdown',
      );
    }
    if (fmt === 'json') {
      const estimatedSavings: Record<string, number | string> = {};
      if (savings) {
        for (const t of REQUEST_TIERS) estimatedSavings[`${t}_requests_per_month`] = Number((savings.monthlyByTier[t] ?? 0).toFixed(4));
        estimatedSavings.per_request = Number(savings.perRequest.toFixed(6));
        estimatedSavings.annual_at_selected_requests = Number(savings.annual.toFixed(2));
      }
      const estimatedCostPerRequest: Record<string, number | string> = {
        currency: 'USD',
        input_tokens: result.optimizedTokens.tokens,
        input_tokens_method: result.optimizedTokens.method,
        output_tokens: outputTokens ?? 0,
        output_tokens_source: outputOverride !== null ? 'manual' : outputEstimate ? `projected:${outputEstimate.shape}` : 'none',
      };
      if (breakdown) {
        estimatedCostPerRequest.input_cost = Number(breakdown.inputCost.toFixed(6));
        estimatedCostPerRequest.output_cost = Number(breakdown.outputCost.toFixed(6));
        estimatedCostPerRequest.total_cost = Number(breakdown.totalCost.toFixed(6));
      }
      download(
        `promptpolice-${stamp}.json`,
        buildExportJSON({
          originalTokens: result.originalTokens.tokens,
          optimizedTokens: result.optimizedTokens.tokens,
          reductionPercent: result.reductionPercent,
          model: model.modelName,
          modelProvider: model.provider,
          level: result.level,
          optimizedPrompt: result.optimizedText,
          estimatedSavings,
          estimatedCostPerRequest,
          preservation: result.preservation,
        }),
        'application/json',
      );
    }
    setOpen(false);
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="card flex items-center gap-2 px-3.5 py-2 text-sm text-slate-soft transition-colors hover:border-ink-600"
      >
        Download
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="m6 9 6 6 6-6" /></svg>
      </button>
      {open && (
        <div
          role="menu"
          className="animate-fade-slide absolute right-0 z-20 mt-1 w-40 overflow-hidden rounded-lg border border-line bg-ink-800 py-1 shadow-xl shadow-black/40"
        >
          {(
            [
              ['txt', 'Plain text (.txt)'],
              ['md', 'Markdown report (.md)'],
              ['json', 'Structured data (.json)'],
            ] as const
          ).map(([f, label]) => (
            <button
              key={f}
              role="menuitem"
              onClick={() => doExport(f)}
              className="block w-full px-4 py-2 text-left text-sm text-slate-soft transition-colors hover:bg-mint/10 hover:text-mint"
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
