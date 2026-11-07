/**
 * Demo Reset — explicit confirmation, then POST /demo/reset.
 *
 * The confirmation lists exactly what is restored, carries the fixed line
 * "Demo reset never touches Production", and the result shows the array the
 * SERVER returned (not a client-side assumption).
 */

import { useState } from 'react';
import { post } from '../api';
import { unavailableReason, useActEnv } from '../data';
import { Badge, Blocked, Card, ErrorState } from '../ui';

const RESTORES = [
  'agents',
  'policies',
  'FSB mapping',
  'risk appetite',
  'demo accounts',
  'demo transactions',
  'scenarios',
  'incidents',
  'approvals',
  'scores',
  'evidence',
];

interface ResetResponse {
  ok: boolean;
  reset: string[];
  deleted?: number;
  note: string;
}

export function DemoResetPage() {
  const { ctx } = useActEnv();
  const [result, setResult] = useState<ResetResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (ctx && !(ctx.mode === 'demo' && ctx.demo.enabled)) {
    return <Blocked reason={unavailableReason(ctx)} />;
  }

  async function reset() {
    setBusy(true);
    setError(null);
    try {
      const res = await post<ResetResponse>('/demo/reset');
      setResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Card
        title="Restore the demo baseline"
        subtitle="Reset clears the live demo event ledger. Seeded synthetic data returns to its initial state."
      >
        <div className="mb-4 text-sm text-mist">This restores:</div>
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {RESTORES.map((item) => (
            <li key={item} className="flex items-center gap-2 border border-line bg-ink-900/60 px-3 py-2 text-sm">
              <Badge tone="info">{item}</Badge>
            </li>
          ))}
        </ul>

        <p className="mt-4 border-l-2 border-amber-soft/50 pl-3 font-mono text-sm text-amber-soft">
          Demo reset never touches Production
        </p>
        <p className="mt-2 text-xs text-mist">
          Demo and Production use separate SQLite files; the reset path only ever opens the demo store.
        </p>

        <button
          type="button"
          onClick={() => void reset()}
          disabled={busy}
          className="mt-4 rounded-md border border-danger/50 bg-danger/10 px-5 py-2 text-sm text-danger disabled:opacity-50"
        >
          {busy ? 'RESETTING…' : 'RESET DEMO'}
        </button>

        {error && (
          <div className="mt-4">
            <ErrorState message={error} onRetry={() => void reset()} />
          </div>
        )}
      </Card>

      {result && (
        <Card
          title="Reset complete"
          subtitle={`Server response — ${result.deleted ?? 0} event(s) deleted`}
          actions={<Badge tone={result.ok ? 'ok' : 'bad'}>{result.ok ? 'ok' : 'failed'}</Badge>}
        >
          <p className="mb-3 font-mono text-sm text-mint">{result.note}</p>
          <div className="text-[11px] uppercase tracking-wider text-mist">Server returned reset list</div>
          <ul className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {result.reset.map((item) => (
              <li key={item} className="border border-mint/30 bg-mint/5 px-3 py-2 font-mono text-sm text-mint">
                {item}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}