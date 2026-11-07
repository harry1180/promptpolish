/**
 * Executive Overview — §12 metrics, governance score and expected ranges.
 *
 * Every number comes from GET /demo/overview; the score card always carries
 * the compliance disclaimer verbatim and expected ranges are shown with their
 * interpretation (higher is NOT automatically better).
 */

import { DISCLAIMER } from '@promptslim/act';
import type { Overview, RangeStatus } from '@promptslim/act';
import { earlyState, Bar, Badge, Card, ErrorState, fmtInt, fmtPct, fmtTime, fmtUsd, Stat, Table } from '../ui';
import { useEndpoint } from '../data';
import type { Column } from '../ui';

export type OverviewPayload = Overview & {
  lastKillElapsedMs?: number | null;
  summary?: Record<string, string | number>;
};

const RANGE_TONE: Record<RangeStatus['status'], 'ok' | 'warn'> = {
  'Within Expected Range': 'ok',
  'Above Expected Range': 'warn',
  'Below Expected Range': 'warn',
};

const RANGE_COLUMNS: Array<Column<RangeStatus>> = [
  { key: 'label', header: 'Metric', cell: (r) => <span className="text-slate-soft">{r.label}</span> },
  { key: 'expected', header: 'Expected', cell: (r) => <span className="font-mono">{r.expected}</span> },
  { key: 'actual', header: 'Actual', cell: (r) => <span className="font-mono text-slate-soft">{r.actual}</span> },
  {
    key: 'status',
    header: 'Status',
    cell: (r) => <Badge tone={RANGE_TONE[r.status]}>{r.status}</Badge>,
  },
  {
    key: 'note',
    header: 'Interpretation',
    cell: (r) => <span className="block max-w-xl text-xs text-mist">{r.note}</span>,
  },
];

export function OverviewPage() {
  const ep = useEndpoint<OverviewPayload>('/overview');
  const early = earlyState(ep, 'Loading executive overview…');
  if (early) return early;
  const ov = ep.data!;

  // a partial or malformed payload must never blank the page
  if (!ov || !ov.governanceScore || !Array.isArray(ov.governanceScore.components)) {
    return <ErrorState message="The server returned an incomplete overview payload — refusing to render figures it cannot verify." />;
  }

  const score = ov.governanceScore;
  const componentMax = Math.max(...score.components.map((c) => c.weight), 1);
  const summaryRows = ov.summary ? Object.entries(ov.summary) : [];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Agents governed" value={fmtInt(ov.totalAgents)} hint={`${ov.productionLikeAgents} production-like`} />
        <Stat label="Bounded autonomy" value={fmtInt(ov.boundedAutonomy)} hint="bound at the gateway" />
        <Stat label="Needs attention" value={fmtInt(ov.attentionAgents)} tone={ov.attentionAgents > 0 ? 'warn' : 'ok'} hint="drift · orphan · overdue review" />
        <Stat label="Autonomous actions" value={fmtInt(ov.autonomousActions)} hint="executed without a human" />
        <Stat label="Human approvals" value={fmtInt(ov.humanApprovals)} hint="consequential actions" />
        <Stat label="Policy blocks" value={fmtInt(ov.policyBlocks)} tone={ov.policyBlocks > 0 ? 'warn' : 'ok'} hint="stopped at the gateway" />
        <Stat label="Evidence coverage" value={fmtPct(ov.evidenceCoveragePct)} tone="ok" hint="hash-chained ledger" />
        <Stat label="Max financial blast radius" value={fmtUsd(ov.maxFinancialBlastRadiusUsd)} tone="warn" hint="daily aggregate ceiling" />
        <Stat label="Median policy decision" value={`${ov.medianPolicyDecisionMs} ms`} hint="deterministic evaluation" />
        <Stat
          label="Time to kill"
          value={`${ov.timeToKillSec}s`}
          tone="ok"
          hint={`p95 ${ov.p95TimeToKillSec}s${ov.lastKillElapsedMs !== null && ov.lastKillElapsedMs !== undefined ? ` · last ${ov.lastKillElapsedMs}ms` : ''}`}
        />
        <Stat label="Prompt injection attempts" value={fmtInt(ov.promptInjectionAttempts)} tone="warn" hint="detected + blocked" />
        <Stat label="Multimodal risks" value={fmtInt(ov.multimodalRisksDetected)} tone="warn" hint="cross-modal signals" />
        <Stat label="Synthetic media alerts" value={fmtInt(ov.syntheticMediaAlerts)} tone="warn" hint="voice / video signals" />
        <Stat label="Privilege drift findings" value={fmtInt(ov.privilegeDriftFindings)} tone={ov.privilegeDriftFindings > 0 ? 'warn' : 'ok'} hint="effective vs approved" />
        <Stat label="Orphan agents" value={fmtInt(ov.orphanAgents)} tone={ov.orphanAgents > 0 ? 'warn' : 'ok'} hint="no active owner" />
        <Stat
          label="Exposure blocked"
          value={fmtUsd(ov.exposureBlockedUsd)}
          tone="bad"
          hint="potential, not realised savings"
        />
        <Stat label="Open incidents" value={fmtInt(ov.openIncidents)} tone={ov.openIncidents > 0 ? 'warn' : 'ok'} hint="all severities" />
        <Stat label="Critical incidents" value={fmtInt(ov.criticalIncidents)} tone={ov.criticalIncidents > 0 ? 'bad' : 'ok'} hint="open, critical severity" />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-5">
        <Card
          title="Governance score"
          subtitle={`${score.methodologyVersion} · ${score.formulaVersion} · computed ${fmtTime(score.computedAt)}`}
          className="xl:col-span-3"
        >
          <div className="flex items-end gap-4">
            <div className="font-mono text-5xl text-slate-soft">{score.score}</div>
            <div className="pb-1 text-sm text-mist">
              <span className="text-slate-soft">{score.classification}</span> / 100
            </div>
          </div>
          <p className="mt-3 border-l-2 border-amber-soft/50 pl-3 text-sm text-amber-soft/90">{DISCLAIMER}</p>

          <div className="mt-4 space-y-1">
            {score.components.map((c) => (
              <Bar
                key={c.key}
                label={c.label}
                value={c.achieved}
                max={componentMax}
                display={`${c.achieved} / ${c.weight}`}
                tone={c.achieved >= c.weight * 0.85 ? 'ok' : c.achieved >= c.weight * 0.6 ? 'warn' : 'bad'}
              />
            ))}
          </div>

          <div className="mt-4 space-y-2 text-xs text-mist">
            <div>
              <span className="uppercase tracking-wider">Evidence references: </span>
              <span className="font-mono">{score.evidenceRefs.join(', ') || 'none'}</span>
            </div>
            {score.exceptions.length > 0 && (
              <div>
                <span className="uppercase tracking-wider">Exceptions: </span>
                {score.exceptions.map((ex) => (
                  <span key={ex.id} className="mr-2">
                    <Badge tone="warn">{ex.id}</Badge> {ex.note}
                    {ex.expiresAt ? ` (expires ${fmtTime(ex.expiresAt)})` : ''}
                  </span>
                ))}
              </div>
            )}
          </div>
        </Card>

        <Card
          title="Expected ranges"
          subtitle="Reference bands for interpretation — a value outside the band is a question, not a verdict."
          className="xl:col-span-2"
        >
          <Table
            rows={ov.ranges}
            columns={RANGE_COLUMNS}
            rowKey={(r) => r.key}
            label="Expected ranges"
            empty={<p className="text-sm text-mist">No expected ranges configured.</p>}
          />
          <p className="mt-3 text-xs text-mist">
            Higher is not automatically better: block rate, approval rate and autonomy rate are read
            together with incidents and use cases.
          </p>
        </Card>
      </div>

      {summaryRows.length > 0 && (
        <Card
          title="Agent Governance Summary"
          subtitle={`§101 executive summary · tenant ${ov.tenant} · seed ${ov.seedVersion} · generated ${fmtTime(ov.generatedAt)}`}
        >
          <div className="grid grid-cols-1 gap-x-8 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
            {summaryRows.map(([key, value]) => (
              <div key={key} className="flex items-baseline justify-between gap-3 border-b border-line/50 pb-1.5">
                <span className="text-xs text-mist">{key}</span>
                <span className="font-mono text-sm text-slate-soft">{value}</span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}