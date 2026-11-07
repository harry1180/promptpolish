/**
 * Market — the tradable universe (pinned + ranked, with the hysteresis change
 * log) and realtime quotes for every member.
 */

import { getQuotes, getUniverse } from '../api';
import type { QuotesResponse, QuoteRow, UniverseResponse } from '../api';
import { useEndpoint } from '../data';
import { Badge, Card, Chips, DataTable, pageState, pct, time, toneClass } from '../../tradingusa/ui';
import type { Column } from '../../tradingusa/ui';

const quoteColumns: Array<Column<QuoteRow>> = [
  {
    key: 'symbol',
    header: 'Coin',
    cell: (q) => (
      <span className="flex items-center gap-2">
        <span className="font-mono text-slate-soft">{q.symbol}</span>
        {q.pinned && <Badge tone="info">pinned</Badge>}
        {q.rank !== null && <span className="font-mono text-[11px] text-mist">#{q.rank}</span>}
      </span>
    ),
    sortValue: (q) => q.symbol,
  },
  { key: 'price', header: 'Price', cell: (q) => <span className="font-mono">{money0(q.price)}</span>, align: 'right', sortValue: (q) => q.price },
  { key: 'change', header: '24h', cell: (q) => <span className={`font-mono ${toneClass(q.changePct)}`}>{pct(q.changePct)}</span>, align: 'right', sortValue: (q) => q.changePct },
  { key: 'bid', header: 'Bid', cell: (q) => <span className="font-mono">{q.bid !== null ? money0(q.bid) : '—'}</span>, align: 'right' },
  { key: 'ask', header: 'Ask', cell: (q) => <span className="font-mono">{q.ask !== null ? money0(q.ask) : '—'}</span>, align: 'right' },
  { key: 'src', header: 'Source', cell: (q) => <span className="text-xs text-mist">{q.provider} · {q.freshness.toLowerCase()}</span> },
  { key: 'ts', header: 'As of', cell: (q) => <span className="font-mono text-xs">{time(q.ts)}</span>, align: 'right', sortValue: (q) => q.ts },
];

function money0(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const digits = v >= 1000 ? 2 : v >= 1 ? 3 : 6;
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: digits });
}

export function MarketPage() {
  const quotes = useEndpoint<QuotesResponse>('/quotes', getQuotes);
  const universe = useEndpoint<UniverseResponse>('/universe', getUniverse);

  const state = pageState(quotes.data, quotes.error, quotes.reload, 'Loading quotes…');
  if (state) return state;

  const rows = quotes.data?.quotes ?? [];
  const u = universe.data;

  return (
    <div className="space-y-5">
      <div className="grid gap-5 lg:grid-cols-3">
        <Card title="Pinned members" subtitle="kept whatever their rank — their lesson history must survive">
          <Chips items={u?.pinned ?? []} tone="info" />
        </Card>
        <Card title="Ranked members" subtitle="top-band slots with hysteresis (7 days out to leave, 3 days in to enter)">
          <Chips items={u?.ranked ?? []} tone="neutral" />
        </Card>
        <Card title="Membership changes" subtitle="every add/drop is logged, never silent">
          {(u?.changes ?? []).length === 0 ? (
            <p className="text-sm text-mist">No membership changes yet — ranks refresh every 6h.</p>
          ) : (
            <ul className="space-y-1 text-xs">
              {(u?.changes ?? []).slice(0, 8).map((c, i) => (
                <li key={`${c.symbol}-${c.ts}-${i}`} className="flex items-center justify-between gap-2">
                  <span className="font-mono text-slate-soft">{c.symbol}</span>
                  <Badge tone={c.action === 'DROP' ? 'neg' : 'pos'}>{c.action.toLowerCase()}</Badge>
                  <span className="text-mist">{time(c.ts)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title="Universe quotes" subtitle={`${rows.length} members · websocket realtime with a 5s REST fallback`}>
        <DataTable
          rows={rows}
          columns={quoteColumns}
          rowKey={(q) => q.symbol}
          label="crypto universe quotes"
          empty={<p className="py-4 text-sm text-mist">No quotes yet — they arrive as soon as the stream or the REST poller runs.</p>}
          defaultSort={{ key: 'symbol', dir: 'asc' }}
        />
      </Card>
    </div>
  );
}
