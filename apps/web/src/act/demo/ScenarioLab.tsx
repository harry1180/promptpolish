/**
 * Scenario Lab — every SCENARIO_META entry (storyline + lab), filterable by
 * channel, each running the real engine via POST /demo/scenarios/:id/run.
 */

import { useState } from 'react';
import { SCENARIO_META } from '@promptslim/act';
import type { ScenarioMeta, ScenarioResult } from '@promptslim/act';
import { post } from '../api';
import { Badge, Card, DecisionBadge, ErrorState, fmtUsd, Loading, sanitizeClaim } from '../ui';

type Channel = ScenarioMeta['channel'];

const CHANNELS: Channel[] = ['core', 'injection', 'synthetic', 'multimodal', 'framework'];

const STEP_TONE_TEXT: Record<string, string> = {
  ok: 'text-mint',
  warn: 'text-amber-soft',
  bad: 'text-danger',
  info: 'text-slate-soft',
};

const CHANNEL_TONE: Record<Channel, 'ok' | 'warn' | 'bad' | 'info'> = {
  core: 'info',
  injection: 'bad',
  synthetic: 'warn',
  multimodal: 'warn',
  framework: 'ok',
};

export function ScenarioLabPage() {
  const [channel, setChannel] = useState<Channel | 'all'>('all');
  const [results, setResults] = useState<Record<string, ScenarioResult>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const visible = SCENARIO_META.filter((s) => channel === 'all' || s.channel === channel);
  const storyline = visible.filter((s) => s.group === 'storyline');
  const lab = visible.filter((s) => s.group === 'lab');
  const activeResult = selected ? results[selected] : null;

  async function run(id: string) {
    setRunning(id);
    setError(null);
    setSelected(id);
    try {
      const res = await post<ScenarioResult>(`/demo/scenarios/${encodeURIComponent(id)}/run`);
      setResults((prev) => ({ ...prev, [id]: res }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(null);
    }
  }

  function renderGroup(title: string, subtitle: string, items: ScenarioMeta[]) {
    if (items.length === 0) return null;
    return (
      <Card title={title} subtitle={subtitle}>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {items.map((s) => {
            const res = results[s.id];
            return (
              <div
                key={s.id}
                className={`border bg-ink-900/60 p-3 ${
                  selected === s.id ? 'border-mint/50' : 'border-line'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-slate-soft">{sanitizeClaim(s.title)}</div>
                    <div className="mt-0.5 text-xs text-mist">{sanitizeClaim(s.summary)}</div>
                  </div>
                  <Badge tone={CHANNEL_TONE[s.channel]}>{s.channel}</Badge>
                </div>
                <div className="mt-3 flex items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => void run(s.id)}
                    disabled={running !== null}
                    className="rounded-md border border-mint/50 bg-mint/10 px-3 py-1 text-xs text-mint disabled:opacity-50"
                  >
                    {running === s.id ? 'running…' : res ? 'run again' : 'run'}
                  </button>
                  {res ? <DecisionBadge value={res.decision} /> : <span className="text-[11px] text-mist">not run</span>}
                </div>
              </div>
            );
          })}
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] uppercase tracking-wider text-mist">Channel</span>
        <button
          type="button"
          onClick={() => setChannel('all')}
          className={`rounded-full border px-3 py-1 text-xs ${
            channel === 'all' ? 'border-mint/50 bg-mint/10 text-mint' : 'border-line bg-ink-900 text-mist'
          }`}
        >
          all ({SCENARIO_META.length})
        </button>
        {CHANNELS.map((c) => {
          const n = SCENARIO_META.filter((s) => s.channel === c).length;
          return (
            <button
              key={c}
              type="button"
              onClick={() => setChannel(c)}
              className={`rounded-full border px-3 py-1 text-xs ${
                channel === c ? 'border-mint/50 bg-mint/10 text-mint' : 'border-line bg-ink-900 text-mist'
              }`}
            >
              {c} ({n})
            </button>
          );
        })}
      </div>

      {error && <ErrorState message={error} />}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-5">
        <div className="space-y-4 xl:col-span-3">
          {renderGroup('Storyline', 'The ten executive scenarios, in narrative order.', storyline)}
          {renderGroup('Lab', 'Channel-specific experiments: injection, synthetic media, multimodal, delegation.', lab)}
        </div>

        <div className="xl:col-span-2">
          <Card title="Result panel">
            {running && !activeResult ? (
              <Loading label="Running scenario…" />
            ) : !activeResult ? (
              <p className="text-sm text-mist">
                Run a scenario to see its steps, decision, reason codes, policies and the learning line.
              </p>
            ) : (
              <div className="space-y-4">
                <div>
                  <div className="text-sm font-semibold text-slate-soft">{sanitizeClaim(activeResult.title)}</div>
                  <div className="mt-1 flex flex-wrap gap-2">
                    <DecisionBadge value={activeResult.decision} />
                    <Badge tone={CHANNEL_TONE[activeResult.channel]}>{activeResult.channel}</Badge>
                    {typeof activeResult.exposureBlockedUsd === 'number' && (
                      <Badge tone="bad">{fmtUsd(activeResult.exposureBlockedUsd)} blocked</Badge>
                    )}
                    {activeResult.kill && <Badge tone="bad">kill: {activeResult.kill.agentName}</Badge>}
                  </div>
                </div>

                <dl className="space-y-1.5">
                  {activeResult.steps.map((step, i) => (
                    <div key={`${step.label}-${i}`} className="flex gap-3 border-b border-line/50 pb-1.5">
                      <dt className="w-44 shrink-0 text-xs text-mist">{step.label}</dt>
                      <dd
                        className={`text-xs font-mono ${
                          step.tone ? STEP_TONE_TEXT[step.tone] ?? 'text-slate-soft' : 'text-slate-soft'
                        }`}
                      >
                        {step.value}
                      </dd>
                    </div>
                  ))}
                </dl>

                <div>
                  <div className="mb-1 text-[11px] uppercase tracking-wider text-mist">Reason codes</div>
                  <div className="flex flex-wrap gap-1">
                    {activeResult.reasonCodes.length ? (
                      activeResult.reasonCodes.map((c) => (
                        <Badge key={c} tone="warn">
                          {c}
                        </Badge>
                      ))
                    ) : (
                      <span className="text-xs text-mist">none</span>
                    )}
                  </div>
                </div>

                <div>
                  <div className="mb-1 text-[11px] uppercase tracking-wider text-mist">Policies</div>
                  <div className="flex flex-wrap gap-1">
                    {activeResult.policies.length ? (
                      activeResult.policies.map((p) => (
                        <Badge key={p} tone="info">
                          {p}
                        </Badge>
                      ))
                    ) : (
                      <span className="text-xs text-mist">none</span>
                    )}
                  </div>
                </div>

                <p className="border-l-2 border-mint/50 pl-3 text-sm text-slate-soft">
                  <span className="text-[11px] uppercase tracking-wider text-mist">Learning — </span>
                  {sanitizeClaim(activeResult.learning)}
                </p>
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}