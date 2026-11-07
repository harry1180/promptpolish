/**
 * Executive Demo — presentation mode over the 10 storyline scenarios.
 *
 * Each slide runs the REAL deterministic engine server-side
 * (POST /demo/scenarios/:id/run) and renders ScenarioResult.steps; the
 * DEMO banner and branding stay visible, sidebar chrome is hidden and the
 * slide counter reads "3 / 10".
 */

import { useCallback, useEffect, useState } from 'react';
import { SCENARIO_META } from '@promptslim/act';
import type { ScenarioResult } from '@promptslim/act';
import { post } from '../api';
import { useNavigate, usePresentation } from '../data';
import { Badge, Card, DecisionBadge, ErrorState, fmtUsd, Loading, sanitizeClaim } from '../ui';

const STORYLINE = SCENARIO_META.filter((s) => s.group === 'storyline');

const STEP_TONE_TEXT: Record<string, string> = {
  ok: 'text-mint',
  warn: 'text-amber-soft',
  bad: 'text-danger',
  info: 'text-slate-soft',
};

export function ExecutiveDemoPage() {
  const navigate = useNavigate();
  const [presentation, setPresentation] = usePresentation();
  const [index, setIndex] = useState(-1);
  const [result, setResult] = useState<ScenarioResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const total = STORYLINE.length;
  const current = index >= 0 ? STORYLINE[index] : null;

  const run = useCallback(async (i: number) => {
    const slide = STORYLINE[i];
    if (!slide) return;
    setRunning(true);
    setError(null);
    setNotice(null);
    try {
      const res = await post<ScenarioResult>(`/demo/scenarios/${encodeURIComponent(slide.id)}/run`);
      setResult(res);
    } catch (err) {
      setResult(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }, []);

  useEffect(() => {
    if (index >= 0) void run(index);
  }, [index, run]);

  async function reset() {
    setRunning(true);
    setError(null);
    try {
      const res = await post<{ ok: boolean; reset: string[]; deleted?: number; note: string }>('/demo/reset');
      setNotice(`${res.note} — ${res.deleted ?? 0} runtime event(s) cleared; restored: ${res.reset.join(', ')}.`);
      setIndex(-1);
      setResult(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  const counter = index < 0 ? `0 / ${total}` : `${index + 1} / ${total}`;

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-mist">Presentation mode</div>
          <h2 className="text-3xl font-semibold text-slate-soft">
            {current ? sanitizeClaim(current.title) : 'Agent Control Tower — executive storyline'}
          </h2>
          <p className="mt-1 text-sm text-mist">
            {current ? sanitizeClaim(current.summary) : `${total} scenarios, each running the live deterministic gateway against synthetic data.`}
          </p>
        </div>
        <div className="font-mono text-3xl text-mint">{counter}</div>
      </div>

      <div className="mb-6 flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => setIndex(0)}
          disabled={running}
          className="rounded-md border border-mint/50 bg-mint/10 px-5 py-2 text-sm text-mint disabled:opacity-50"
        >
          START
        </button>
        <button
          type="button"
          onClick={() => setIndex((i) => Math.min(i + 1, total - 1))}
          disabled={running || index < 0 || index >= total - 1}
          className="rounded-md border border-line bg-ink-800 px-5 py-2 text-sm text-slate-soft disabled:opacity-40"
        >
          NEXT
        </button>
        <button
          type="button"
          onClick={() => setIndex((i) => Math.max(i - 1, 0))}
          disabled={running || index <= 0}
          className="rounded-md border border-line bg-ink-800 px-5 py-2 text-sm text-slate-soft disabled:opacity-40"
        >
          BACK
        </button>
        <button
          type="button"
          onClick={() => void reset()}
          disabled={running}
          className="rounded-md border border-amber-soft/50 bg-amber-soft/10 px-5 py-2 text-sm text-amber-soft disabled:opacity-50"
        >
          RESET
        </button>
        <button
          type="button"
          onClick={() => navigate('/agent-control-tower/demo/lab')}
          className="rounded-md border border-line bg-ink-800 px-5 py-2 text-sm text-mist"
        >
          EXIT
        </button>
        <button
          type="button"
          aria-pressed={presentation}
          onClick={() => setPresentation(!presentation)}
          className="rounded-md border border-violet-soft/50 bg-violet-soft/10 px-5 py-2 text-sm text-violet-soft"
        >
          PRESENTATION MODE: {presentation ? 'ON' : 'OFF'}
        </button>
      </div>

      {notice && (
        <p role="status" className="card mb-6 border-mint/40 px-4 py-3 font-mono text-sm text-mint">
          {notice}
        </p>
      )}

      {error && <ErrorState message={error} onRetry={() => void run(index)} />}

      {!error && running && <Loading label="Running scenario against the live gateway…" />}

      {!error && !running && index >= 0 && result && (
        <Card
          title={sanitizeClaim(result.title)}
          subtitle={`channel: ${result.channel} · group: ${result.group}`}
          actions={
            <span className="flex gap-2">
              <DecisionBadge value={result.decision} />
              {typeof result.exposureBlockedUsd === 'number' && (
                <Badge tone="bad">
                  {fmtUsd(result.exposureBlockedUsd)} blocked (not a realised saving)
                </Badge>
              )}
            </span>
          }
        >
          <dl className="space-y-2">
            {result.steps.map((step, i) => (
              <div key={`${step.label}-${i}`} className="flex gap-4 border-b border-line/50 pb-2">
                <dt className="w-64 shrink-0 text-sm text-mist">{step.label}</dt>
                <dd
                  className={`text-sm font-mono ${
                    step.tone ? STEP_TONE_TEXT[step.tone] ?? 'text-slate-soft' : 'text-slate-soft'
                  }`}
                >
                  {step.value}
                </dd>
              </div>
            ))}
          </dl>

          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <div className="mb-1 text-[11px] uppercase tracking-wider text-mist">Reason codes</div>
              <div className="flex flex-wrap gap-1">
                {result.reasonCodes.length ? (
                  result.reasonCodes.map((c) => (
                    <Badge key={c} tone="warn">
                      {c}
                    </Badge>
                  ))
                ) : (
                  <span className="text-sm text-mist">none</span>
                )}
              </div>
            </div>
            <div>
              <div className="mb-1 text-[11px] uppercase tracking-wider text-mist">Policies applied</div>
              <div className="flex flex-wrap gap-1">
                {result.policies.length ? (
                  result.policies.map((p) => (
                    <Badge key={p} tone="info">
                      {p}
                    </Badge>
                  ))
                ) : (
                  <span className="text-sm text-mist">none</span>
                )}
              </div>
            </div>
          </div>

          <p className="mt-4 border-l-2 border-mint/50 pl-3 text-base text-slate-soft">
            <span className="text-[11px] uppercase tracking-wider text-mist">Learning — </span>
            {sanitizeClaim(result.learning)}
          </p>
        </Card>
      )}

      {!error && !running && index < 0 && (
        <Card title="How this works">
          <p className="text-sm text-mist">
            Press START to begin. Every slide is a live evaluation against the synthetic demo estate —
            nothing is a recorded screenshot. RESET restores the demo baseline (agents, policies,
            scores, evidence) and never touches Production; EXIT returns to the Scenario Lab where all
            {total} storyline scenarios and the lab channels are available individually.
          </p>
        </Card>
      )}
    </div>
  );
}