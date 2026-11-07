/**
 * Evidence & Replay — append-only, sha256 hash-chained ledger plus
 * observational replay of a single decision (side effects are never
 * re-executed).
 */

import { useState } from 'react';
import type { DecisionRow, EvidenceRecord } from '@promptslim/act';
import { useEndpoint, useNavigate } from '../data';
import { Badge, Bar, Card, Chips, earlyState, fmtTime, fmtUsd, Table } from '../ui';
import type { Column } from '../ui';

interface EvidenceList {
  records: EvidenceRecord[];
  chainValid: boolean;
  chainCount?: number;
  coveragePct: number;
  design?: string;
  sampleHashes?: unknown;
}

interface ReplayPayload {
  record: EvidenceRecord | null;
  decision: DecisionRow | null;
  /** server replay timeline; `timelineFrom` is the docs' alternate field name */
  replay?: Array<{ t: string; detail: string }>;
  timelineFrom?: Array<{ t: string; detail: string }>;
  note?: string;
}

function decisionIdOf(record: EvidenceRecord): string | null {
  const id = record.payload.decisionId;
  return typeof id === 'string' ? id : null;
}

/* ------------------------------------------------------------------ */
/* ledger                                                              */
/* ------------------------------------------------------------------ */

export function EvidencePage() {
  const ep = useEndpoint<EvidenceList>('/evidence');
  const navigate = useNavigate();
  const [lookup, setLookup] = useState('');

  const early = earlyState(ep, 'Loading evidence ledger…');
  if (early) return early;
  const { records, chainValid, coveragePct, design } = ep.data!;
  const chainCount = ep.data!.chainCount ?? records.length;

  const columns: Array<Column<EvidenceRecord>> = [
    { key: 'seq', header: 'Seq', cell: (r) => <span className="font-mono text-xs text-mist">{r.seq}</span> },
    { key: 'ts', header: 'Time', cell: (r) => <span className="font-mono text-xs">{fmtTime(r.ts)}</span> },
    { key: 'type', header: 'Event', cell: (r) => <span className="text-xs text-slate-soft">{r.type}</span> },
    { key: 'env', header: 'Environment', cell: (r) => <Badge tone={r.environment === 'demo' ? 'warn' : 'info'}>{r.environment}</Badge> },
    { key: 'tenant', header: 'Tenant', cell: (r) => <span className="font-mono text-[11px] text-mist">{r.tenant}</span> },
    {
      key: 'hash',
      header: 'Hash (prev → current)',
      cell: (r) => (
        <span className="font-mono text-[11px]">
          <span className="text-mist">{r.prevHash.slice(0, 10)}…</span>
          <span className="mx-1 text-mist/60">→</span>
          <span className="text-mint">{r.hash.slice(0, 10)}…</span>
        </span>
      ),
    },
    {
      key: 'replay',
      header: 'Replay',
      cell: (r) => {
        const id = decisionIdOf(r);
        if (!id) return <span className="text-xs text-mist">—</span>;
        return (
          <a
            href={`/agent-control-tower/evidence/${encodeURIComponent(id)}`}
            onClick={(e) => {
              e.preventDefault();
              navigate(`/agent-control-tower/evidence/${encodeURIComponent(id)}`);
            }}
            className="font-mono text-xs text-mint hover:underline"
          >
            {id}
          </a>
        );
      },
    },
  ];

  const sampleHashes = ep.data!.sampleHashes;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card title="Chain integrity">
          <div className="flex items-center gap-3">
            <Badge tone={chainValid ? 'ok' : 'bad'}>{chainValid ? 'chain verified' : 'chain broken'}</Badge>
            <span className="font-mono text-sm text-slate-soft">{chainCount} record(s)</span>
          </div>
          <p className="mt-2 text-xs text-mist">
            Every record hashes its predecessor; any edit to history breaks verification from that point.
          </p>
        </Card>
        <Card title="Coverage">
          <div className="font-mono text-3xl text-slate-soft">{coveragePct}%</div>
          <div className="mt-2">
            <Bar label="decisions with evidence" value={coveragePct} max={100} display={`${coveragePct}%`} tone={coveragePct >= 99 ? 'ok' : 'warn'} />
          </div>
        </Card>
        <Card title="Open a replay">
          <label className="text-xs text-mist">
            Decision id
            <input
              value={lookup}
              onChange={(e) => setLookup(e.target.value)}
              placeholder="dec_seed_02"
              className="mt-1 w-full rounded-md border border-line bg-ink-900 px-2 py-1.5 font-mono text-xs text-slate-soft"
            />
          </label>
          <button
            type="button"
            disabled={!lookup.trim()}
            onClick={() => navigate(`/agent-control-tower/evidence/${encodeURIComponent(lookup.trim())}`)}
            className="mt-2 rounded-md border border-mint/50 bg-mint/10 px-3 py-1.5 text-xs text-mint disabled:opacity-50"
          >
            Replay decision
          </button>
          <p className="mt-2 text-xs text-mist">Observational only — replay never re-executes anything.</p>
        </Card>
      </div>

      <Card
        title={`Evidence records · ${records.length}`}
        subtitle={design ?? 'append-only, hash-chained, tenant-scoped'}
        actions={
          <button
            type="button"
            onClick={ep.reload}
            className="rounded-md border border-line bg-ink-700 px-3 py-1 text-xs text-slate-soft hover:border-mint/40"
          >
            Refresh
          </button>
        }
      >
        <Table rows={records} columns={columns} rowKey={(r) => String(r.seq)} label="Evidence records" />
        {sampleHashes !== undefined && sampleHashes !== null && (
          <p className="mt-3 font-mono text-[11px] text-mist">
            sample hashes:{' '}
            {Array.isArray(sampleHashes)
              ? sampleHashes.map((h) => String(h)).join(' · ')
              : Object.entries(sampleHashes as Record<string, unknown>)
                  .map(([k, v]) => `${k}=${String(v)}`)
                  .join(' · ')}
          </p>
        )}
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* replay                                                              */
/* ------------------------------------------------------------------ */

export function ReplayPage({ decisionId }: { decisionId: string }) {
  const ep = useEndpoint<ReplayPayload>(`/evidence/${encodeURIComponent(decisionId)}`);
  const navigate = useNavigate();
  const early = earlyState(ep, 'Loading replay…');
  if (early) return early;
  const { record, decision, note } = ep.data!;
  const timeline = ep.data!.replay ?? ep.data!.timelineFrom ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <button
            type="button"
            onClick={() => navigate('/agent-control-tower/evidence')}
            className="text-xs text-mist hover:text-mint"
          >
            ← evidence ledger
          </button>
          <h2 className="font-mono text-xl text-slate-soft">{decisionId}</h2>
        </div>
        <Badge tone="info">observational replay</Badge>
      </div>

      {decision && (
        <Card title="Decision under replay">
          <div className="flex flex-wrap items-center gap-3">
            <Badge tone={decision.decision === 'ALLOW' ? 'ok' : decision.decision === 'BLOCK' || decision.decision === 'QUARANTINE' ? 'bad' : 'warn'}>
              {decision.decision}
            </Badge>
            <span className="text-sm text-slate-soft">{decision.agent}</span>
            <span className="font-mono text-xs text-mist">{decision.action}</span>
            {decision.amountUsd ? <span className="font-mono text-xs text-mist">{fmtUsd(decision.amountUsd)}</span> : null}
            <span className="font-mono text-xs text-mist">{fmtTime(decision.ts)}</span>
            <span className="font-mono text-xs text-mist">{decision.latencyMs} ms</span>
          </div>
          <div className="mt-3 space-y-2">
            <div>
              <span className="text-[11px] uppercase tracking-wider text-mist">Reason codes: </span>
              <Chips items={decision.reasonCodes} tone="warn" />
            </div>
            <div>
              <span className="text-[11px] uppercase tracking-wider text-mist">Policies: </span>
              <Chips items={decision.policies} tone="info" />
            </div>
          </div>
        </Card>
      )}

      <Card title="Replay timeline" subtitle={note ?? 'Observational replay — side effects are never re-executed.'}>
        {timeline.length === 0 ? (
          <p className="text-sm text-mist">
            No timeline for this id — it is not a recorded decision (or no evidence record carries it).
          </p>
        ) : (
          <ol className="space-y-2">
            {timeline.map((step, i) => (
              <li key={`${step.t}-${i}`} className="flex gap-4 border-b border-line/50 pb-2">
                <span className="w-24 shrink-0 font-mono text-xs text-mint">{step.t}</span>
                <span className="text-sm text-slate-soft">{step.detail}</span>
              </li>
            ))}
          </ol>
        )}
      </Card>

      {record && (
        <Card title="Evidence record" subtitle={`seq ${record.seq} · ${record.type}`}>
          <div className="grid grid-cols-1 gap-x-8 gap-y-2 font-mono text-xs sm:grid-cols-2">
            <div>
              <span className="text-mist">prev hash </span>
              <span className="text-slate-soft">{record.prevHash}</span>
            </div>
            <div>
              <span className="text-mist">hash </span>
              <span className="text-mint">{record.hash}</span>
            </div>
            <div>
              <span className="text-mist">tenant </span>
              <span className="text-slate-soft">{record.tenant}</span>
            </div>
            <div>
              <span className="text-mist">environment </span>
              <span className="text-slate-soft">{record.environment}</span>
            </div>
          </div>
          <pre className="thin-scroll mt-3 overflow-x-auto rounded-md border border-line bg-ink-900 p-3 text-[11px] text-mist">
            {JSON.stringify(record.payload, null, 2)}
          </pre>
        </Card>
      )}

      {!record && !decision && (
        <Card title="No record">
          <p className="text-sm text-mist">
            The ledger has no record carrying <span className="font-mono">{decisionId}</span>. Seeded
            baseline decisions replay from the seed; runtime decisions carry their own evidence entry.
          </p>
        </Card>
      )}
    </div>
  );
}