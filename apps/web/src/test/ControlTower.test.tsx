import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DISCLAIMER } from '@promptslim/act';
import type { GovernanceScore, Overview } from '@promptslim/act';
import ControlTower from '../act';
import { BASE_PATH, DEMO_BANNER, DEMO_NAV, PRODUCTION_NAV } from '../act/data';

/* ------------------------------------------------------------------ */
/* fetch stub — context, overview and empty-but-well-formed payloads   */
/* for every other demo endpoint (same shapes the server returns)      */
/* ------------------------------------------------------------------ */

const CONTEXT = {
  mode: 'demo',
  banner: DEMO_BANNER,
  tenant: 'demo-synthetic-001',
  seedVersion: 'act-demo-seed-1.0.0',
  generatedAt: 1760000000000,
  demo: { enabled: true },
  production: {
    enabled: false,
    entitled: false,
    reason: 'production mode is not enabled for this deployment (server configuration)',
  },
};

const SCORE: GovernanceScore = {
  score: 87,
  classification: 'Controlled Autonomy',
  methodologyVersion: 'act-govscore-methodology-1.0.0',
  formulaVersion: 'act-govscore-formula-1.0.0',
  computedAt: 1760000000000,
  components: [
    { key: 'identity', label: 'Identity & Ownership', weight: 10, achieved: 9.6, inputs: ['owners assigned'] },
  ],
  exceptions: [],
  evidenceRefs: ['ev:foundation'],
  disclaimer: DISCLAIMER,
};

const OVERVIEW: Overview = {
  tenant: 'demo-synthetic-001',
  seedVersion: 'act-demo-seed-1.0.0',
  generatedAt: 1760000000000,
  totalAgents: 27,
  productionLikeAgents: 17,
  boundedAutonomy: 7,
  attentionAgents: 3,
  governanceScore: SCORE,
  autonomousActions: 1842,
  humanApprovals: 37,
  policyBlocks: 12,
  privilegeDriftFindings: 2,
  orphanAgents: 1,
  evidenceCoveragePct: 99.4,
  maxFinancialBlastRadiusUsd: 500000,
  medianPolicyDecisionMs: 18,
  timeToKillSec: 4.2,
  p95TimeToKillSec: 6.1,
  criticalIncidents: 0,
  openIncidents: 2,
  multimodalRisksDetected: 9,
  syntheticMediaAlerts: 4,
  promptInjectionAttempts: 46,
  exposureBlockedUsd: 0,
  ranges: [],
};

const PAYLOADS: Record<string, unknown> = {
  '/api/act/demo/overview': {
    ...OVERVIEW,
    summary: { 'Agents Governed': 27, 'Governance Score': '87/100 — Controlled Autonomy' },
  },
  '/api/act/demo/agents': [],
  '/api/act/demo/decisions': [],
  '/api/act/demo/approvals': [],
  '/api/act/demo/policies': [],
  '/api/act/demo/policies/lifecycle': { policy: [], learning: [], rules: [], suitabilityCriteria: [] },
  '/api/act/demo/modality': { items: [], reports: [] },
  '/api/act/demo/appetite': [],
  '/api/act/demo/use-cases': [],
  '/api/act/demo/use-cases/suitability': [],
  '/api/act/demo/performance': { agent: {}, governance: {}, note: '' },
  '/api/act/demo/blast-radius': [],
  '/api/act/demo/incidents': [],
  '/api/act/demo/evidence': { records: [], chainValid: true, chainCount: 0, coveragePct: 100 },
  '/api/act/demo/frameworks': {
    frameworks: [{ key: 'fsb', name: 'FSB 12', note: 'Control mapping only.', controls: [] }],
    summaries: {},
  },
  '/api/act/demo/integrations': [],
  '/api/act/demo/readiness': { gates: [], note: '', readinessPct: 0, blockers: [] },
  '/api/act/demo/admin': { roles: [], segregation: [], breakGlass: { requirements: [] }, recentAudit: [] },
  '/api/act/demo/agents/agt_treasury_07': {
    passport: {
      agentId: 'agt_treasury_07',
      name: 'Treasury-07',
      businessFunction: 'Global Treasury',
      businessOwner: 'Global Treasury',
      technicalOwner: 'AI Platform',
      riskOwner: 'Operational Risk',
      environment: 'Production',
      framework: 'LangGraph',
      provider: 'Azure OpenAI',
      model: 'gpt-4.1',
      modelVersion: 'gpt-4.1#1',
      agentVersion: 'v2.3.0',
      status: 'active',
      riskTier: 'high',
      autonomyLevel: 'BOUND AUTONOMY',
      modalities: ['TEXT', 'STRUCTURED DATA'],
      dataClassification: 'regulated',
      connectedSystems: ['payment-hub'],
      approvedCapabilities: ['transfer:execute'],
      effectiveCapabilities: ['transfer:execute'],
      prohibitedCapabilities: ['beneficiary:create'],
      credentialType: 'short-lived workload identity (mTLS)',
      credentialExpiry: Date.now() + 900000,
      lastReview: Date.now() - 86400000,
      nextReview: Date.now() + 86400000,
      killEnabled: true,
      ownerActive: true,
      governanceScore: 87,
      blastRadiusClass: 'HIGH',
      needsAttention: false,
    },
    blastRadius: { overall: 'HIGH', dimensions: [], explanation: '', financialUsd: 500000 },
    breaches: { ok: true, breaches: [], remainingTodayUsd: 1000 },
    incidents: [],
    decisions: [],
  },
  '/api/act/demo/evidence/dec_seed_02': {
    record: null,
    decision: null,
    replay: [{ t: 'T+0 ms', detail: 'objective requested' }],
    note: 'Observational replay — side effects are never re-executed.',
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function stubFetch(): void {
  const impl = async (input: RequestInfo | URL): Promise<Response> => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = raw.replace(/^https?:\/\/[^/]+/, '');
    if (path.endsWith('/api/act/context')) return jsonResponse(CONTEXT);
    if (path in PAYLOADS) return jsonResponse(PAYLOADS[path]);
    return jsonResponse({});
  };
  vi.stubGlobal('fetch', vi.fn(impl));
}

beforeEach(() => {
  window.history.replaceState({}, '', '/');
  stubFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function goto(to: string): void {
  window.history.pushState({}, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

/* ------------------------------------------------------------------ */
/* the shell                                                           */
/* ------------------------------------------------------------------ */

describe('Agent Control Tower shell', () => {
  it('renders the navigation with the required labels, in order', async () => {
    render(<ControlTower />);

    const nav = await screen.findByRole('navigation', { name: /control tower navigation/i });
    const links = within(nav).getAllByRole('link').map((a) => a.textContent ?? '');

    // required labels from the brief
    for (const label of ['Executive Overview', 'Agent Registry', 'Evidence & Replay', 'Framework Mapping', 'Executive Demo']) {
      expect(links).toContain(label);
    }

    // full nav, exact order: 18 production pages then the 3 demo pages
    expect(links).toEqual([...PRODUCTION_NAV.map((i) => i.label), ...DEMO_NAV.map((i) => i.label)]);
  });

  it('shows the persistent demo banner', async () => {
    render(<ControlTower />);
    const banner = await screen.findByText(DEMO_BANNER);
    expect(banner.textContent).toContain('Synthetic data — no real transactions');
    expect(banner.className).toContain('amber');
  });

  it('renders the executive overview with the governance-score disclaimer', async () => {
    render(<ControlTower />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Executive Overview' })).toBeTruthy();
    expect(await screen.findByText(DISCLAIMER)).toBeTruthy();
    // §101 block renders server-provided summary values verbatim
    expect(await screen.findByText('Agent Governance Summary')).toBeTruthy();
    expect(screen.getByText('Agents Governed')).toBeTruthy();
    expect(screen.getAllByText('27').length).toBeGreaterThan(0);
  });

  it('renders every production page and demo page without crashing', async () => {
    render(<ControlTower />);
    await screen.findByRole('navigation', { name: /control tower navigation/i });

    const routes: Array<[string, string]> = [
      ...PRODUCTION_NAV.map((i) => [i.to, i.label] as [string, string]),
      [`${BASE_PATH}/passports/agt_treasury_07`, 'Agent Passports'],
      [`${BASE_PATH}/evidence/dec_seed_02`, 'Evidence & Replay'],
      ...DEMO_NAV.map((i) => [i.to, i.label] as [string, string]),
    ];

    for (const [to, label] of routes) {
      goto(to);
      const heading = await screen.findByRole('heading', { level: 1, name: label });
      expect(heading).toBeTruthy();
      // let the endpoint settle: no stuck loading state and no failed request
      await waitFor(() => expect(document.querySelector('[role="status"]')).toBeNull(), { timeout: 3000 });
      expect(screen.queryByText(/request failed/i)).toBeNull();
    }
  });

  it('shows an honest empty state quoting the production reason when no data source is entitled', async () => {
    const noSource = {
      ...CONTEXT,
      mode: 'none',
      demo: { enabled: false },
      production: {
        enabled: false,
        entitled: false,
        reason: 'production mode is not enabled for this deployment (server configuration)',
      },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        return jsonResponse(raw.endsWith('/api/act/context') ? noSource : {});
      }),
    );

    render(<ControlTower />);
    const nav = await screen.findByRole('navigation', { name: /control tower navigation/i });
    // the 18 production pages still render ...
    expect(within(nav).getAllByRole('link')).toHaveLength(PRODUCTION_NAV.length);
    // ... each quoting the server's own reason instead of fabricating rows
    const quoted = await screen.findAllByText(/production mode is not enabled for this deployment/);
    expect(quoted.length).toBeGreaterThan(0);
    expect(screen.queryByText(DEMO_BANNER)).toBeNull();
  });

  it('never renders the banned compliance claim phrases, even in negation', async () => {
    render(<ControlTower />);
    await screen.findByRole('navigation', { name: /control tower navigation/i });

    // scenario copy in the workspace package still carries one of them
    goto(`${BASE_PATH}/demo/lab`);
    await screen.findByRole('heading', { level: 1, name: 'Scenario Lab' });
    await waitFor(() => expect(document.querySelector('[role="status"]')).toBeNull(), { timeout: 3000 });

    const banned = [
      ['FSB', 'Compliant'].join(' '),
      ['NIST', 'Certified'].join(' '),
      ['EU AI Act', 'Certified'].join(' '),
    ];
    for (const phrase of banned) {
      expect(screen.queryByText(new RegExp(phrase))).toBeNull();
    }
    // the allowed vocabulary is present instead
    expect(screen.getAllByText(/Control mapping/i).length).toBeGreaterThan(0);
  });

  it('grants a pending approval through POST /demo/approvals/:id/grant', async () => {
    const pending = {
      id: 'apr_test_1',
      agentId: 'agt_treasury_07',
      agent: 'Treasury-07',
      action: 'transfer:execute',
      amountUsd: 145000,
      beneficiary: 'ben_supplier_4471',
      requestedAt: 1760000000000,
      status: 'pending',
      requiredApprover: 'Risk Manager (transaction approver)',
      policyIds: ['P-FIN-002'],
      bindingHash: '8f3c…a91d',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const method = (init?.method ?? 'GET').toUpperCase();
        if (raw.endsWith('/api/act/context')) return jsonResponse(CONTEXT);
        if (raw.endsWith('/api/act/demo/approvals') && method === 'GET') return jsonResponse([pending]);
        if (raw.includes('/api/act/demo/approvals/apr_test_1/grant') && method === 'POST') {
          return jsonResponse({ ok: true, approvals: [{ ...pending, status: 'approved' }] });
        }
        return jsonResponse({});
      }),
    );

    render(<ControlTower />);
    await screen.findByRole('navigation', { name: /control tower navigation/i });
    goto(`${BASE_PATH}/approvals`);

    const grant = await screen.findByRole('button', { name: 'Grant' });
    fireEvent.click(grant);

    expect(await screen.findByText(/Approval apr_test_1 granted/)).toBeTruthy();
    await waitFor(() => expect(screen.getByText('approved')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Grant' })).toBeNull();
  });
});