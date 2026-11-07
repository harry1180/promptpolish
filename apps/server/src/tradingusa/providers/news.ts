/**
 * Public-news ingestion (Yahoo Finance RSS per ticker) — tiny regex XML
 * parsing, no dependencies. Respects caching/dedup upstream via
 * source_documents.content_hash.
 */
import type { ProviderStatus } from '@promptslim/tucore';

export interface NewsItem {
  title: string;
  url: string;
  pubDate: string; // raw RFC822
  ts: number; // epoch ms
  source: string;
}

export class NewsProvider {
  readonly name = 'yahoo-rss';
  private fetchImpl: typeof fetch;
  private _status: ProviderStatus = 'UNAVAILABLE';
  private _lastError: string | null = null;

  constructor(deps: { fetchImpl?: typeof fetch } = {}) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  status(): ProviderStatus { return this._status; }
  lastError(): string | null { return this._lastError; }

  async fetchHeadlines(ticker: string, limit = 20): Promise<NewsItem[]> {
    const url = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(ticker)}&region=US&lang=en-US`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12_000);
    try {
      const res = await this.fetchImpl(url, {
        headers: { 'user-agent': 'Mozilla/5.0 TradingUSA research' },
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const xml = await res.text();
      this._status = 'CONNECTED';
      this._lastError = null;
      return parseRss(xml, limit);
    } catch (err) {
      this._status = 'DEGRADED';
      this._lastError = err instanceof Error ? err.message : 'rss error';
      return [];
    } finally {
      clearTimeout(timer);
    }
  }
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

export function parseRss(xml: string, limit: number): NewsItem[] {
  const items: NewsItem[] = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) && items.length < limit) {
    const block = m[1];
    const title = /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/.exec(block)?.[1] ?? '';
    const link = /<link>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/.exec(block)?.[1] ?? '';
    const pub = /<pubDate>([\s\S]*?)<\/pubDate>/.exec(block)?.[1] ?? '';
    const sourceName = /<source[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/source>/.exec(block)?.[1] ?? 'yahoo';
    if (!title || !link) continue;
    const ts = Date.parse(pub);
    items.push({
      title: unescapeXml(title).trim(),
      url: unescapeXml(link).trim(),
      pubDate: pub.trim(),
      ts: Number.isFinite(ts) ? ts : Date.now(),
      source: sourceName.trim() || 'yahoo',
    });
  }
  return items;
}
