/**
 * Live Decisions (append-only decision log) + Approvals (human oversight).
 *
 * Grant/reject POST /demo/approvals/:id/{grant,reject}; the server binds the
 * approval to the exact transaction and returns the refreshed list.
 */

import { useState } from 'react';
import type { ApprovalRow, DecisionRow } from '@promptslim/act';
import { post } from '../api';
import { useEndpoint } from '../data';
import { Badge, Card, Chips, earlyState, fmtTime, fmtUsd, Table } from '../ui';
import type { Column } from '../ui';

const DECISION_TONE = (d: string): 'ok' | 'warn' | 'bad' | 'info' =>
  d === 'ALLOW' ? 'ok' : d === 'BLOCK' || d === 'QUARANTINE' ? 'bad' : d === 'HOLD' || d === 'REQUIRE_APPROVAL' ? 'warn' : 'info';

const APPROVAL_TONE: Record<ApprovalRow['status'], 'ok' | 'warn' | 'bad' | 'info'> = {
  pending: 'warn',
  approved: 'ok',
  rejected: 'bad',
  expired: 'info',
};

/* ------------------------------------------------------------------ */
/* live decisions                                                      */
/* ------------------------------------------------------------------ */

export function DecisionsPage() {
  const ep = useEndpoint<DecisionRow[]>('/decisions');
  const early = earlyState(ep, 'Loading decisions…');
  if (early) return early;
  const rows = [...ep.data!].sort((a, b) => b.ts - a.ts);

  const columns: Array<Column<DecisionRow>> = [
    { key: 'ts', header: 'Time', cell: (d) => <span className="font-mono text-xs text-mist">{fmtTime(d.ts)}</span> },
    { key: 'agent', header: 'Agent', cell: (d) => <span className="text-slate-soft">{d.agent}</span> },
    { key: 'action', header: 'Action', cell: (d) => <span className="font-mono text-xs">{d.action}</span> },
    { key: 'modality', header: 'Modality', cell: (d) => <span className="text-xs text-mist">{d.modality}</span> },
    {
      key: 'decision',
      header: 'Decision',
      cell: (d) => <Badge tone={DECISION_TONE(d.decision)}>{d.decision}</Badge>,
    },
    { key: 'amount', header: 'Amount', cell: (d) => <span className="font-mono text-xs">{d.amountUsd ? fmtUsd(d.amountUsd) : '—'}</span> },
    { key: 'reasons', header: 'Reason codes', cell: (d) => <Chips items={d.reasonCodes} tone={DECISION_TONE(d.decision)} /> },
    { key: 'policies', header: 'Policies', cell: (d) => <Chips items={d.policies} tone="info" /> },
    {
      key: 'latency',
      header: 'Latency',
      cell: (d) => <span className="font-mono text-xs">{d.latencyMs} ms</span>,
      className: 'text-right',
    },
    {
      key: 'evidence',
      header: 'Evidence',
      cell: (d) => <span className="block max-w-48 truncate font-mono text-[11px] text-mist" title={d.evidenceRef}>{d.evidenceRef || '—'}</span>,
    },
  ];

  return (
    <Card
      title={`Live decisions · ${rows.length}`}
      subtitle="Seeded baseline plus runtime decisions, newest first. Every decision is written to the append-only evidence ledger."
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
      <Table rows={rows} columns={columns} rowKey={(d) => d.id} label="Live decisions" />
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* approvals                                                           */
/* ------------------------------------------------------------------ */

interface ApprovalResponse {
  ok: boolean;
  approvals: ApprovalRow[];
}

export function ApprovalsPage() {
  const ep = useEndpoint<ApprovalRow[]>('/approvals');
  const [rows, setRows] = useState<ApprovalRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  const early = earlyState(ep, 'Loading approvals…');
  if (early) return early;
  const data = rows ?? ep.data!;
  const pending = data.filter((a) => a.status === 'pending');

  async function decide(id: string, action: 'grant' | 'reject') {
    setBusy(id + action);
    setNotice(null);
    try {
      const res = await post<ApprovalResponse>(`/demo/approvals/${encodeURIComponent(id)}/${action}`);
      setRows(res.approvals);
      setNotice({
        tone: 'ok',
        text: `Approval ${id} ${action === 'grant' ? 'granted' : 'rejected'} — evidence record appended.`,
      });
    } catch (err) {
      // server rejections (409/403) are surfaced inline, never treated as a crash
      setNotice({ tone: 'bad', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  }

  const columns: Array<Column<ApprovalRow>> = [
    {
      key: 'agent',
      header: 'Request',
      cell: (a) => (
        <div>
          <span className="text-slate-soft">{a.agent}</span>
          <div className="font-mono text-[11px] text-mist">
            {a.action} {a.amountUsd ? `· ${fmtUsd(a.amountUsd)}` : ''} {a.beneficiary ? `· ${a.beneficiary}` : ''}
          </div>
        </div>
      ),
    },
    { key: 'requested', header: 'Requested', cell: (a) => <span className="font-mono text-xs text-mist">{fmtTime(a.requestedAt)}</span> },
    { key: 'approver', header: 'Required approver', cell: (a) => <span className="text-xs">{a.requiredApprover}</span> },
    { key: 'policies', header: 'Bound policies', cell: (a) => <Chips items={a.policyIds} tone="info" /> },
    { key: 'binding', header: 'Binding hash', cell: (a) => <span className="font-mono text-[11px] text-mist">{a.bindingHash}</span> },
    { key: 'status', header: 'Status', cell: (a) => <Badge tone={APPROVAL_TONE[a.status]}>{a.status}</Badge> },
    {
      key: 'actions',
      header: 'Decision',
      cell: (a) =>
        a.status === 'pending' ? (
          <span className="flex gap-2">
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void decide(a.id, 'grant')}
              className="rounded-md border border-mint/40 bg-mint/10 px-3 py-1 text-xs text-mint disabled:opacity-50"
            >
              {busy === a.id + 'grant' ? 'granting…' : 'Grant'}
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void decide(a.id, 'reject')}
              className="rounded-md border border-danger/40 bg-danger/10 px-3 py-1 text-xs text-danger disabled:opacity-50"
            >
              {busy === a.id + 'reject' ? 'rejecting…' : 'Reject'}
            </button>
          </span>
        ) : (
          <span className="text-xs text-mist">—</span>
        ),
    },
  ];

  return (
    <div className="space-y-4">
      {notice && (
        <p
          role={notice.tone === 'bad' ? 'alert' : 'status'}
          className={`card px-4 py-3 font-mono text-sm ${notice.tone === 'bad' ? 'border-danger/50 text-danger' : 'border-mint/40 text-mint'}`}
        >
          {notice.text}
        </p>
      )}

      <Card
        title={`Approvals · ${pending.length} pending of ${data.length}`}
        subtitle="Approvals are bound to the exact transaction (hash + amount + beneficiary); a mutated transaction invalidates the approval."
        actions={
          <button
            type="button"
            onClick={() => {
              setRows(null);
              ep.reload();
            }}
            className="rounded-md border border-line bg-ink-700 px-3 py-1 text-xs text-slate-soft hover:border-mint/40"
          >
            Refresh
          </button>
        }
      >
        <Table rows={data} columns={columns} rowKey={(a) => a.id} label="Approvals" />
      </Card>
    </div>
  );
}