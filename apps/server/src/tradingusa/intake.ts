/**
 * Public-information intake: news RSS, SEC filings, macro series and XBRL
 * fundamentals -> canonical, deduplicated EVENTS (25 syndicated copies of
 * one story = one event with source/independent-source counts).
 *
 * Crawling rules enforced here: conditional/deduped retrieval via
 * content_hash, one fetch per document, robots/TOS-friendly endpoints only
 * (official APIs, RSS, IR feeds) — no CAPTCHA/paywall/auth bypass anywhere.
 */
import type { DatabaseSync } from 'node:sqlite';
import {
  classifyHeadline, contentHash, dedupKey, domainOf, mergeEventState, normalizeHeadline, similarity,
} from '@promptslim/tucore';
import type { EventType } from '@promptslim/tucore';
import type { NewsProvider } from './providers/news.ts';
import type { SecProvider, Filing, SecRawFacts } from './providers/sec.ts';
import type { MacroProvider } from './providers/macro.ts';
import { latestQuote } from './engine.ts';

const FORM_MATERIALITY: Record<string, number> = {
  '10-K': 0.6, '10-Q': 0.5, '8-K': 0.6, 'S-1': 0.4, '4': 0.25,
  'SC 13D': 0.5, 'SC 13G': 0.3, 'DEF 14A': 0.3, '11-K': 0.2,
};

export interface IntakeStats {
  documentsNew: number;
  documentsDuplicate: number;
  eventsCreated: number;
  eventsMerged: number;
  errors: number;
}

function ensureSource(db: DatabaseSync, domain: string, url: string, category: string, retrieval: string): number {
  const existing = db.prepare('SELECT id FROM sources WHERE domain = ? AND category = ?').get(domain, category) as
    | { id: number }
    | undefined;
  if (existing) {
    db.prepare('UPDATE sources SET last_checked = ?, check_count = check_count + 1 WHERE id = ?').run(Date.now(), existing.id);
    return existing.id;
  }
  const res = db
    .prepare(
      `INSERT INTO sources (domain, url, category, retrieval_method, robots_ok, policy_status, last_checked, check_count)
       VALUES (?, ?, ?, ?, 1, 'ROBOTS_OK', ?, 1)`,
    )
    .run(domain, url, category, retrieval, Date.now());
  return Number(res.lastInsertRowid);
}

function upsertEvent(
  db: DatabaseSync,
  args: {
    ticker: string | null; type: EventType; headline: string; materiality: number;
    sentiment: number; confidence: number; sourceUrl: string; docId: number | null;
    expectedHorizon?: string; payload?: unknown;
  },
): { id: number; created: boolean; merged: boolean } {
  const domain = domainOf(args.sourceUrl);
  const key = dedupKey(args.ticker, args.type, args.headline);
  const now = Date.now();

  // 1. exact dedup key (same normalized story)
  const exact = db.prepare('SELECT id, dedup_key FROM events WHERE dedup_key = ?').get(key) as { id: number } | undefined;

  // 2. near-duplicate syndication: same ticker+type in the last 72h
  const candidates = exact
    ? []
    : (db
        .prepare('SELECT id, headline FROM events WHERE (ticker IS ? ) AND type = ? AND first_seen >= ?')
        .all(args.ticker, args.type, now - 72 * 3600_000) as unknown as Array<{ id: number; headline: string }>);

  let targetId = exact?.id ?? null;
  if (targetId == null) {
    for (const c of candidates) {
      if (similarity(normalizeHeadline(c.headline), normalizeHeadline(args.headline)) >= 0.82) {
        targetId = c.id;
        break;
      }
    }
  }

  if (targetId != null) {
    const sources = db.prepare('SELECT url FROM event_sources WHERE event_id = ?').all(targetId) as unknown as Array<{ url: string }>;
    const headlines = db.prepare('SELECT headline FROM event_sources WHERE event_id = ?').all(targetId) as unknown as Array<{ headline: string }>;
    const merge = mergeEventState(
      { sourceUrls: sources.map((s) => s.url), headlines: headlines.map((h) => h.headline) },
      { sourceUrl: args.sourceUrl, headline: args.headline },
    );
    if (!merge.updated) return { id: targetId, created: false, merged: false };
    db.prepare('INSERT OR IGNORE INTO event_sources (event_id, doc_id, url, domain, headline, seen_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(targetId, args.docId, args.sourceUrl, domain, args.headline, now);
    const counts = db.prepare('SELECT COUNT(*) AS n FROM event_sources WHERE event_id = ?').get(targetId) as { n: number };
    const domains = db.prepare('SELECT COUNT(DISTINCT domain) AS n FROM event_sources WHERE event_id = ?').get(targetId) as { n: number };
    db.prepare(
      `UPDATE events SET sources = ?, independent_sources = ?, last_updated = ?,
         sentiment = (sentiment * 0.6 + ? * 0.4), materiality = MAX(materiality, ?) WHERE id = ?`,
    ).run(counts.n, Math.max(1, domains.n), now, args.sentiment, args.materiality, targetId);
    return { id: targetId, created: false, merged: true };
  }

  const res = db
    .prepare(
      `INSERT INTO events (ticker, type, headline, materiality, sentiment, confidence, first_seen, last_updated,
         sources, independent_sources, expected_horizon, dedup_key, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?)`,
    )
    .run(
      args.ticker, args.type, args.headline, args.materiality, args.sentiment, args.confidence,
      now, now, args.expectedHorizon ?? 'unknown', key, JSON.stringify(args.payload ?? {}),
    );
  const id = Number(res.lastInsertRowid);
  db.prepare('INSERT OR IGNORE INTO event_sources (event_id, doc_id, url, domain, headline, seen_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, args.docId, args.sourceUrl, domain, args.headline, now);
  return { id, created: true, merged: false };
}

export function insertDocument(
  db: DatabaseSync,
  doc: { url: string; title: string; content: string; docType: string; tickers: string[]; sourceId: number },
): { id: number | null; duplicate: boolean } {
  const hash = contentHash(doc.url + '|' + doc.title);
  const existing = db.prepare('SELECT id FROM source_documents WHERE content_hash = ?').get(hash) as { id: number } | undefined;
  if (existing) return { id: existing.id, duplicate: true };
  try {
    const res = db
      .prepare(
        `INSERT INTO source_documents (source_id, url, title, content, content_hash, doc_type, fetched_at, tickers_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(doc.sourceId, doc.url, doc.title, doc.content, hash, doc.docType, Date.now(), JSON.stringify(doc.tickers));
    db.prepare('UPDATE sources SET documents = documents + 1, freshness_score = 0.9 WHERE id = ?').run(doc.sourceId);
    return { id: Number(res.lastInsertRowid), duplicate: false };
  } catch {
    return { id: null, duplicate: true };
  }
}

/* ---------------- news ---------------- */
export async function pollNews(
  db: DatabaseSync,
  news: NewsProvider,
  tickers: Array<{ ticker: string; company: string }>,
): Promise<IntakeStats> {
  const stats: IntakeStats = { documentsNew: 0, documentsDuplicate: 0, eventsCreated: 0, eventsMerged: 0, errors: 0 };
  for (const t of tickers) {
    const items = await news.fetchHeadlines(t.ticker, 15);
    for (const item of items) {
      try {
        const domain = domainOf(item.url);
        const sourceId = ensureSource(db, domain, item.url, 'news', 'rss');
        const doc = insertDocument(db, {
          url: item.url, title: item.title, content: '', docType: 'news',
          tickers: [t.ticker], sourceId,
        });
        if (doc.duplicate) {
          stats.documentsDuplicate += 1;
          // exact re-fetch of the same story: skip entirely (no evidence multiplication)
          const same = db.prepare('SELECT id FROM events WHERE dedup_key = ?').get(dedupKey(t.ticker, 'GENERAL', item.title));
          if (same) continue;
        } else {
          stats.documentsNew += 1;
        }
        const cls = classifyHeadline(item.title);
        const recency = Math.max(0, 1 - (Date.now() - item.ts) / (48 * 3600_000));
        const upsert = upsertEvent(db, {
          ticker: t.ticker, type: cls.type, headline: item.title,
          materiality: Math.min(1, cls.materiality * (0.5 + 0.5 * recency)),
          sentiment: cls.sentiment, confidence: 0.55 + 0.25 * recency,
          sourceUrl: item.url, docId: doc.id,
          expectedHorizon: cls.materiality >= 0.7 ? 'days-weeks' : 'days',
          payload: { published: item.ts, source: item.source },
        });
        if (upsert.created) stats.eventsCreated += 1;
        else if (upsert.merged) stats.eventsMerged += 1;
      } catch {
        stats.errors += 1;
      }
    }
  }
  return stats;
}

/* ---------------- SEC filings ---------------- */
export async function pollSecFilings(
  db: DatabaseSync,
  sec: SecProvider,
  tickers: string[],
): Promise<IntakeStats & { filings: number }> {
  const stats: IntakeStats & { filings: number } = { documentsNew: 0, documentsDuplicate: 0, eventsCreated: 0, eventsMerged: 0, errors: 0, filings: 0 };
  for (const ticker of tickers) {
    try {
      const filings: Filing[] = await sec.recentFilings(ticker, 8);
      for (const f of filings) {
        if (!f.filedAt || f.filedAt < new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10)) continue;
        const domain = 'sec.gov';
        const sourceId = ensureSource(db, domain, f.url, 'sec', 'api');
        const doc = insertDocument(db, {
          url: f.url, title: `${f.form} ${f.filedAt} ${ticker}`, content: f.description,
          docType: 'filing', tickers: [ticker], sourceId,
        });
        stats.filings += 1;
        if (doc.duplicate) { stats.documentsDuplicate += 1; continue; }
        stats.documentsNew += 1;
        const materiality = FORM_MATERIALITY[f.form] ?? 0.3;
        const recency = f.filedAt >= new Date().toISOString().slice(0, 10) ? 1 : 0.7;
        const upsert = upsertEvent(db, {
          ticker, type: f.form === '10-K' || f.form === '10-Q' || f.form === '8-K' ? 'SEC_FILING' : 'SEC_FILING',
          headline: `${ticker} files ${f.form}${f.description ? ` (${f.description})` : ''} on ${f.filedAt}`,
          materiality: materiality * recency, sentiment: 0, confidence: 0.9,
          sourceUrl: f.url, docId: doc.id, expectedHorizon: 'days-weeks',
          payload: { form: f.form, filedAt: f.filedAt, accession: f.accession },
        });
        if (upsert.created) stats.eventsCreated += 1;
        else if (upsert.merged) stats.eventsMerged += 1;
      }
    } catch {
      stats.errors += 1;
    }
  }
  return stats;
}

/* ---------------- macro ---------------- */
export async function pollMacro(db: DatabaseSync, macro: MacroProvider): Promise<number> {
  const rows = await macro.treasuryYields();
  let stored = 0;
  const stmt = db.prepare(
    `INSERT INTO economic_data (series, date, value, source) VALUES (?, ?, ?, ?)
     ON CONFLICT(series, date) DO UPDATE SET value = excluded.value`,
  );
  for (const r of rows) {
    for (const [series, v] of [['treasury_y2', r.y2], ['treasury_y5', r.y5], ['treasury_y10', r.y10], ['treasury_y30', r.y30]] as const) {
      if (v != null) { stmt.run(series, r.date, v, 'treasury.gov'); stored += 1; }
    }
  }
  return stored;
}

/* ---------------- fundamentals ---------------- */
export function factsToSnapshot(ticker: string, facts: SecRawFacts, price: number | null): Record<string, number | string | null> {
  const rev = facts.revenueTtm;
  const growth = rev != null && facts.revenuePriorYear ? (rev - facts.revenuePriorYear) / Math.abs(facts.revenuePriorYear) : null;
  const eps = facts.epsDilutedTtm;
  const shares = facts.sharesOutstanding;
  const equity = facts.stockholdersEquity;
  const debt = facts.longTermDebt;
  const ocf = facts.operatingCashFlowTtm;
  const capex = facts.capexTtm;
  const fcf = ocf != null && capex != null ? ocf - capex : null;
  const marketCap = price != null && shares != null ? price * shares : null;
  return {
    ticker,
    asOf: facts.asOf ?? '',
    source: 'sec-xbrl',
    revenueGrowth: growth,
    epsGrowth: null,
    operatingMargin: rev && facts.operatingIncomeTtm != null ? facts.operatingIncomeTtm / rev : null,
    netMargin: rev && facts.netIncomeTtm != null ? facts.netIncomeTtm / rev : null,
    grossMargin: rev && facts.grossProfitTtm != null ? facts.grossProfitTtm / rev : null,
    roe: equity && facts.netIncomeTtm != null ? facts.netIncomeTtm / equity : null,
    roic: equity && debt != null && facts.operatingIncomeTtm != null ? facts.operatingIncomeTtm / (equity + debt) : null,
    fcf,
    operatingCashFlow: ocf,
    cash: facts.cash,
    totalDebt: debt,
    debtToEquity: equity && debt != null ? debt / equity : null,
    interestCoverage: null,
    sharesOutstanding: shares,
    dilutionPct: null,
    buybackPct: null,
    pe: eps && eps > 0 && price != null ? price / eps : null,
    fwdPe: null,
    peg: null,
    ps: marketCap && rev ? marketCap / rev : null,
    evEbitda: null,
    fcfYield: fcf && marketCap ? fcf / marketCap : null,
  };
}

export async function refreshFundamentals(
  db: DatabaseSync,
  sec: SecProvider,
  tickers: string[],
): Promise<number> {
  let updated = 0;
  for (const ticker of tickers) {
    try {
      const facts = await sec.companyFacts(ticker);
      if (!facts) continue;
      const q = latestQuote(db, ticker);
      const snapshot = factsToSnapshot(ticker, facts, q?.price ?? null);
      db.prepare(
        `INSERT INTO fundamentals (ticker, as_of, source, data_json, fetched_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(ticker) DO UPDATE SET as_of=excluded.as_of, source=excluded.source,
           data_json=excluded.data_json, fetched_at=excluded.fetched_at`,
      ).run(ticker, snapshot.asOf as string, 'sec-xbrl', JSON.stringify(snapshot), Date.now());
      updated += 1;
    } catch {
      /* skip ticker */
    }
  }
  return updated;
}
