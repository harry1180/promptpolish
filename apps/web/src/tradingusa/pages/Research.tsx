/**
 * Research — chronological feed of events/filings/news/macro items with
 * kind, materiality and sentiment, linking out to the original source.
 */

import { getResearch } from '../api';
import type { ResearchItem, ResearchResponse } from '../api';
import { Link, useEndpoint } from '../data';
import { Badge, Card, EmptyState, ErrorState, Loading, MeterBar, StatTile, number, pct, time, toneClass } from '../ui';

function kindTone(kind: string): 'pos' | 'neg' | 'warn' | 'info' | 'neutral' {
  const k = kind.toUpperCase();
  if (k === 'EVENT') return 'info';
  if (k === 'FILING') return 'neutral';
  if (k === 'NEWS') return 'warn';
  if (k === 'MACRO') return 'pos';
  return 'neutral';
}

function ResearchRow({ item }: { item: ResearchItem }) {
  return (
    <li className="border-b border-line/60 py-2 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={kindTone(item.kind)}>{item.kind}</Badge>
        {item.ticker && (
          <Link to={`/tradingusa/stocks/${item.ticker}`} className="font-mono text-xs font-semibold text-mint hover:underline">
            {item.ticker}
          </Link>
        )}
        <span className="min-w-0 flex-1 text-sm text-slate-soft">{item.title}</span>
        <span className={`font-mono text-xs ${toneClass(item.sentiment ?? null)}`}>{pct(item.sentiment ?? null)}</span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-3 text-[11px] text-mist">
        <span className="font-mono">{time(item.ts)}</span>
        <span>{item.source ?? '—'}</span>
        <span className="flex items-center gap-1">
          materiality
          <MeterBar value={item.materiality ?? null} width="w-16" />
        </span>
        {item.url && (
          <a
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto text-mint hover:underline"
          >
            open source ↗
          </a>
        )}
      </div>
    </li>
  );
}

export function ResearchPage() {
  const ep = useEndpoint<ResearchResponse>('/research', getResearch);

  if (ep.data === undefined) {
    return ep.error ? <ErrorState message={ep.error} onRetry={ep.reload} /> : <Loading label="Loading research…" />;
  }
  const items = [...(ep.data.items ?? [])].sort(
    (a, b) => (typeof b.ts === 'number' ? b.ts : 0) - (typeof a.ts === 'number' ? a.ts : 0),
  );

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile label="Items" value={number(items.length)} />
        <StatTile label="Sources today" value={number(ep.data.sourcesToday ?? null)} />
        <StatTile
          label="High materiality"
          value={number(items.filter((i) => (i.materiality ?? 0) >= 0.7).length)}
          hint="materiality ≥ 0.7"
        />
      </div>

      <Card title="Research feed" subtitle="Newest first — every item traces back to a retrieved document.">
        {items.length === 0 ? (
          <EmptyState title="No research yet">No events, filings, news or macro items have been captured.</EmptyState>
        ) : (
          <ul>
            {items.map((item) => (
              <ResearchRow key={item.id} item={item} />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}