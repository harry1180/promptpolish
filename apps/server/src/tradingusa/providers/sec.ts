/**
 * SEC EDGAR ingestion: ticker->CIK map, recent filings (submissions API),
 * and fundamentals extracted from XBRL company facts. All official,
 * key-free endpoints; User-Agent header per SEC fair-access policy.
 */
import type { ProviderStatus } from '@promptslim/tucore';

const SEC_UA = 'TradingUSA research agent (governance.agenticalchemy.io)';

export interface Filing {
  form: string;
  filedAt: string; // YYYY-MM-DD
  accession: string;
  url: string;
  description: string;
}

export interface SecRawFacts {
  revenueTtm: number | null;
  revenuePriorYear: number | null;
  netIncomeTtm: number | null;
  epsDilutedTtm: number | null;
  operatingIncomeTtm: number | null;
  grossProfitTtm: number | null;
  cash: number | null;
  longTermDebt: number | null;
  stockholdersEquity: number | null;
  sharesOutstanding: number | null;
  operatingCashFlowTtm: number | null;
  capexTtm: number | null;
  asOf: string | null;
}

export class SecProvider {
  readonly name = 'sec-edgar';
  private fetchImpl: typeof fetch;
  private _status: ProviderStatus = 'UNAVAILABLE';
  private _lastError: string | null = null;
  private cikMap: Map<string, number> = new Map();
  private cikFetchedAt = 0;

  constructor(deps: { fetchImpl?: typeof fetch } = {}) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  status(): ProviderStatus { return this._status; }
  lastError(): string | null { return this._lastError; }

  private async getJson(url: string, timeoutMs = 20_000): Promise<unknown> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        headers: { 'user-agent': SEC_UA, accept: 'application/json' },
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`SEC HTTP ${res.status}`);
      this._status = 'CONNECTED';
      this._lastError = null;
      return (await res.json()) as unknown;
    } catch (err) {
      this._status = 'DEGRADED';
      this._lastError = err instanceof Error ? err.message : 'sec error';
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async cikFor(ticker: string): Promise<number | null> {
    const now = Date.now();
    if (this.cikMap.size === 0 || now - this.cikFetchedAt > 24 * 3600_000) {
      try {
        const body = (await this.getJson('https://www.sec.gov/files/company_tickers.json')) as Record<
          string,
          { cik_str: number; ticker: string }
        >;
        const map = new Map<string, number>();
        for (const row of Object.values(body)) map.set(row.ticker.toUpperCase(), row.cik_str);
        this.cikMap = map;
        this.cikFetchedAt = now;
      } catch {
        return this.cikMap.get(ticker.toUpperCase()) ?? null;
      }
    }
    return this.cikMap.get(ticker.toUpperCase()) ?? null;
  }

  private static cik10(cik: number): string {
    return String(cik).padStart(10, '0');
  }

  async recentFilings(ticker: string, limit = 15): Promise<Filing[]> {
    const cik = await this.cikFor(ticker);
    if (!cik) return [];
    const body = (await this.getJson(
      `https://data.sec.gov/submissions/CIK${SecProvider.cik10(cik)}.json`,
    )) as {
      filings?: { recent?: { form?: string[]; filingDate?: string[]; accessionNumber?: string[]; primaryDocument?: string[]; items?: string[] } };
    };
    const recent = body.filings?.recent;
    if (!recent?.form) return [];
    const out: Filing[] = [];
    const accessions = recent.accessionNumber ?? [];
    const filingDates = recent.filingDate ?? [];
    const count = Math.min(recent.form.length, 80);
    for (let i = 0; i < count && out.length < limit; i++) {
      const form = recent.form[i];
      if (!['8-K', '10-K', '10-Q', 'S-1', '4', 'SC 13D', 'SC 13G', 'DEF 14A', '11-K'].includes(form)) continue;
      const acc = (accessions[i] ?? '').replace(/-/g, '');
      out.push({
        form,
        filedAt: filingDates[i] ?? '',
        accession: accessions[i] ?? '',
        url: `https://www.sec.gov/Archives/edgar/data/${cik}/${acc}/${recent.primaryDocument?.[i] ?? ''}`,
        description: (recent.items?.[i] ?? '').split(',').slice(0, 4).join(', '),
      });
    }
    return out;
  }

  /** Extract TTM-style fundamentals from XBRL facts (best effort, null-safe). */
  async companyFacts(ticker: string): Promise<SecRawFacts | null> {
    const cik = await this.cikFor(ticker);
    if (!cik) return null;
    const body = (await this.getJson(
      `https://data.sec.gov/api/xbrl/companyfacts/CIK${SecProvider.cik10(cik)}.json`,
    )) as {
      facts?: Record<string, Record<string, { units?: Record<string, Array<{ val: number; fy?: number; fp?: string; form?: string; end?: string; start?: string }>> }>>;
    };
    const ug = (body as { facts?: Record<string, Record<string, { units?: Record<string, Array<{ val: number; end?: string; form?: string; start?: string }>> }>> }).facts?.['us-gaap'];
    if (!ug) return null;

    const pick = (...names: string[]): { units: Array<{ val: number; end?: string; form?: string; start?: string }> } | null => {
      for (const n of names) {
        const node = ug[n];
        const units = node?.units?.['USD'] ?? node?.units?.['shares'] ?? node?.units?.['USD/shares'];
        if (units && units.length > 0) return { units };
      }
      return null;
    };

    /** Sum four quarterly duration facts ending within the last ~365 days into a TTM. */
    const ttm = (names: string[]): { value: number | null; asOf: string | null } => {
      const node = pick(...names);
      if (!node) return { value: null, asOf: null };
      const durations = node.units.filter((u) => u.start != null && u.end != null);
      const instants = node.units.filter((u) => u.start == null && u.end != null);
      if (durations.length >= 4) {
        // prefer quarterly (~90d) facts: take the 4 most recent distinct non-overlapping quarters
        const byEnd = [...durations].sort((a, b) => String(a.end).localeCompare(String(b.end)));
        const quarters: typeof byEnd = [];
        for (let i = byEnd.length - 1; i >= 0 && quarters.length < 4; i--) {
          const cand = byEnd[i];
          const days = cand.start && cand.end ? (Date.parse(cand.end) - Date.parse(cand.start)) / 86400_000 : 0;
          if (days > 300) continue; // annual facts handled below
          if (quarters.length === 0 || String(quarters[quarters.length - 1].start) > String(cand.end)) quarters.push(cand);
        }
        if (quarters.length === 4) {
          return { value: quarters.reduce((s, q) => s + q.val, 0), asOf: String(quarters[0].end) };
        }
        const annual = byEnd.filter((u) => {
          const days = u.start && u.end ? (Date.parse(u.end) - Date.parse(u.start)) / 86400_000 : 0;
          return days > 300;
        });
        if (annual.length > 0) {
          const last = annual[annual.length - 1];
          return { value: last.val, asOf: String(last.end) };
        }
      }
      if (instants.length > 0) {
        const last = [...instants].sort((a, b) => String(a.end).localeCompare(String(b.end))).pop()!;
        return { value: last.val, asOf: String(last.end) };
      }
      return { value: null, asOf: null };
    };

    const revenue = ttm(['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet']);
    const priorRevNode = pick('RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet');
    let priorYearRevenue: number | null = null;
    if (priorRevNode) {
      const annuals = priorRevNode.units.filter((u) => {
        const days = u.start && u.end ? (Date.parse(u.end) - Date.parse(u.start)) / 86400_000 : 0;
        return days > 300;
      }).sort((a, b) => String(a.end).localeCompare(String(b.end)));
      if (annuals.length >= 2) priorYearRevenue = annuals[annuals.length - 2].val;
    }
    const eps = (() => {
      const node = pick('EarningsPerShareDiluted');
      if (!node) return null;
      const durations = node.units.filter((u) => u.start != null && u.end != null);
      if (durations.length >= 4) {
        const byEnd = [...durations].sort((a, b) => String(a.end).localeCompare(String(b.end)));
        const q: typeof byEnd = [];
        for (let i = byEnd.length - 1; i >= 0 && q.length < 4; i--) {
          const c = byEnd[i];
          const days = c.start && c.end ? (Date.parse(c.end) - Date.parse(c.start)) / 86400_000 : 0;
          if (days > 300) continue;
          if (q.length === 0 || String(q[q.length - 1].start) > String(c.end)) q.push(c);
        }
        if (q.length === 4) return q.reduce((s, x) => s + x.val, 0);
      }
      return null;
    })();

    const fcf = ttm(['NetCashProvidedByUsedInOperatingActivities']);
    const capex = ttm(['PaymentsToAcquirePropertyPlantAndEquipment', 'PaymentsToAcquireProductiveAssets']);

    return {
      revenueTtm: revenue.value,
      revenuePriorYear: priorYearRevenue,
      netIncomeTtm: ttm(['NetIncomeLoss']).value,
      epsDilutedTtm: eps,
      operatingIncomeTtm: ttm(['OperatingIncomeLoss']).value,
      grossProfitTtm: ttm(['GrossProfit']).value,
      cash: ttm(['CashAndCashEquivalentsAtCarryingValue', 'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents']).value,
      longTermDebt: ttm(['LongTermDebtNoncurrent', 'LongTermDebt']).value,
      stockholdersEquity: ttm(['StockholdersEquity']).value,
      sharesOutstanding: (() => {
        const node = pick('CommonStockSharesOutstanding', 'EntityCommonStockSharesOutstanding');
        if (!node) return null;
        const last = [...node.units].sort((a, b) => String(a.end).localeCompare(String(b.end))).pop();
        return last ? last.val : null;
      })(),
      operatingCashFlowTtm: fcf.value,
      capexTtm: capex.value,
      asOf: revenue.asOf,
    };
  }
}
