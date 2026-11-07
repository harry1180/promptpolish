/**
 * Sources — per-domain retrieval health: reliability, freshness, latency,
 * failure/duplicate rates, predictive contribution and robots policy.
 */

import { getSources } from '../api';
import type { SourceRow, SourcesResponse } from '../api';
import { useEndpoint } from '../data';
import { Badge, Card, DataTable, ErrorState, Loading, MeterBar, StatTile, dateText, number, pctPlain, pctPlainAuto, toneClass } from '../ui';

function policyTone(status: string): 'pos' | 'warn' | 'neutral' {
  if (status === 'ROBOTS_OK') return 'pos';
  if (status === 'MANUAL_REVIEW') return 'warn';
  return 'neutral';
}

export function SourcesPage() {
  const ep = useEndpoint<SourcesResponse>('/sources', getSources);

  if (ep.data === undefined) {
    return ep.error ? <ErrorState message={ep.error} onRetry={ep.reload} /> : <Loading label="Loading sources…" />;
  }
  const rows = ep.data.sources ?? [];
  const healthy = rows.filter((s) => s.policyStatus === 'ROBOTS_OK').length;
  const docs = rows.reduce((sum, s) => sum + (s.documents ?? 0), 0);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Sources" value={number(rows.length)} />
        <StatTile label="Robots OK" value={`${number(healthy)} / ${number(rows.length)}`} />
        <StatTile label="Documents" value={number(docs)} />
        <StatTile
          label="Avg reliability"
          value={rows.length > 0 ? pctPlainAuto(rows.reduce((sum, s) => sum + (s.reliability ?? 0), 0) / rows.length) : '—'}
        />
      </div>

      <Card title="Source health" subtitle="Every column comes straight from GET /sources — nothing is estimated here.">
        <DataTable
          label="Sources"
          rows={rows}
          rowKey={(r) => `${r.domain}:${r.category}`}
          columns={[
            {
              key: 'domain',
              header: 'Domain',
              sortValue: (r: SourceRow) => r.domain,
              cell: (r: SourceRow) => (
                <div>
                  <div className="font-mono text-xs font-semibold text-slate-soft">{r.domain}</div>
                  {r.url && (
                    <a href={r.url} target="_blank" rel="noopener noreferrer" className="text-[10px] text-mist hover:text-mint">
                      {r.retrievalMethod ?? 'visit'} ↗
                    </a>
                  )}
                </div>
              ),
            },
            { key: 'category', header: 'Category', sortValue: (r: SourceRow) => r.category, cell: (r: SourceRow) => <span className="text-xs text-mist">{r.category}</span> },
            {
              key: 'reliability',
              header: 'Reliability',
              align: 'right',
              sortValue: (r: SourceRow) => r.reliability,
              cell: (r: SourceRow) => (
                <div className="flex items-center justify-end gap-2">
                  <MeterBar value={r.reliability} width="w-14" />
                  <span className="font-mono text-xs">{pctPlainAuto(r.reliability)}</span>
                </div>
              ),
            },
            { key: 'freshness', header: 'Freshness', align: 'right', sortValue: (r: SourceRow) => r.freshnessScore, cell: (r: SourceRow) => <span className="font-mono text-xs">{pctPlainAuto(r.freshnessScore)}</span> },
            { key: 'latency', header: 'Latency', align: 'right', sortValue: (r: SourceRow) => r.latencyMs, cell: (r: SourceRow) => <span className="font-mono text-xs">{r.latencyMs === null ? '—' : `${number(r.latencyMs)} ms`}</span> },
            { key: 'failure', header: 'Failure %', align: 'right', sortValue: (r: SourceRow) => r.failureRatePct, cell: (r: SourceRow) => <span className={`font-mono text-xs ${toneClass(r.failureRatePct === null ? null : -(r.failureRatePct ?? 0))}`}>{pctPlain(r.failureRatePct)}</span> },
            { key: 'dupes', header: 'Duplicate %', align: 'right', sortValue: (r: SourceRow) => r.duplicateRatePct, cell: (r: SourceRow) => <span className="font-mono text-xs">{pctPlain(r.duplicateRatePct)}</span> },
            {
              key: 'predictive',
              header: 'Predictive contribution',
              align: 'right',
              sortValue: (r: SourceRow) => r.predictiveContribution,
              cell: (r: SourceRow) => (
                <div className="flex items-center justify-end gap-2">
                  <MeterBar value={r.predictiveContribution} width="w-14" />
                  <span className="font-mono text-xs">{pctPlainAuto(r.predictiveContribution)}</span>
                </div>
              ),
            },
            { key: 'documents', header: 'Documents', align: 'right', sortValue: (r: SourceRow) => r.documents, cell: (r: SourceRow) => <span className="font-mono text-xs">{number(r.documents)}</span> },
            { key: 'checked', header: 'Last checked', cell: (r: SourceRow) => <span className="font-mono text-[11px] text-mist">{dateText(String(r.lastChecked ?? ''))}</span> },
            { key: 'policy', header: 'Policy', cell: (r: SourceRow) => <Badge tone={policyTone(r.policyStatus)}>{r.policyStatus}</Badge> },
          ]}
          empty={<p className="py-4 text-center text-xs text-mist">No sources registered yet.</p>}
        />
      </Card>
    </div>
  );
}