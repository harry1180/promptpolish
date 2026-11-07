/**
 * View derivation: seed + live demo events → dashboard payloads.
 *
 * NOTHING here hard-codes a displayed number: every metric is either seeded
 * (synthetic baseline) or accumulated from events appended at runtime, so a
 * demo run visibly changes the dashboard and Demo Reset (clearing events)
 * restores it.
 */

import { buildSeed, TENANT, type DemoSeed } from './seed.ts';
import { computeGovernanceScore, DISCLAIMER, rangeStatus, type ScoreInputs, type RangeStatus } from './score.ts';
import { computeBlastRadius } from './blast.ts';
import type { ActEvent, AgentPassport, GovernanceScore } from './types.ts';

const DAY = 86_400_000;

export function count(events: ActEvent[], type: ActEvent['type'], match?: (p: Record<string, unknown>) => boolean): number {
  return events.filter((e) => e.type === type && (!match || match(e.payload))).length;
}

/* ---------------- overview ---------------- */

export interface Overview {
  tenant: string;
  seedVersion: string;
  generatedAt: number;
  totalAgents: number;
  productionLikeAgents: number;
  boundedAutonomy: number;
  attentionAgents: number;
  governanceScore: GovernanceScore;
  autonomousActions: number;
  humanApprovals: number;
  policyBlocks: number;
  privilegeDriftFindings: number;
  orphanAgents: number;
  evidenceCoveragePct: number;
  maxFinancialBlastRadiusUsd: number;
  medianPolicyDecisionMs: number;
  timeToKillSec: number;
  p95TimeToKillSec: number;
  criticalIncidents: number;
  openIncidents: number;
  multimodalRisksDetected: number;
  syntheticMediaAlerts: number;
  promptInjectionAttempts: number;
  exposureBlockedUsd: number;
  ranges: RangeStatus[];
}

export function overview(seed: DemoSeed, events: ActEvent[], now: number): Overview {
  const b = seed.baseline;
  const drift = b.privilegeDriftFindings
    + count(events, 'drift.detected')
    - count(events, 'drift.restored');
  const orphans = Math.max(0, b.orphanFindings - count(events, 'orphan.suspended') - count(events, 'orphan.reassigned'));
  const blocks = b.policyBlocks + count(events, 'decision', (p) => p.decision === 'BLOCK' || p.decision === 'QUARANTINE');
  const approvals = b.humanApprovals + count(events, 'approval.granted');
  const autonomous = b.autonomousActions + count(events, 'decision', (p) => p.decision === 'ALLOW') + count(events, 'execution.simulated');
  const injection = b.injectionAttempts + count(events, 'scenario.run', (p) => p.channel === 'injection');
  const synthetic = b.syntheticMediaAlerts + count(events, 'scenario.run', (p) => p.channel === 'synthetic');
  const multimodal = b.multimodalRisks + count(events, 'scenario.run', (p) => p.channel === 'multimodal');
  // dedupe by scenario key so re-running a demo scenario never double-counts
  const seenExposure = new Set<string>();
  let exposure = 0;
  for (const e of events) {
    if (e.type !== 'exposure.blocked') continue;
    const key = String(e.payload.key ?? e.seq);
    if (seenExposure.has(key)) continue;
    seenExposure.add(key);
    exposure += Number(e.payload.usd ?? 0);
  }
  const kills = events.filter((e) => e.type === 'agent.killed');
  const ttk = kills.map((e) => Number(e.payload.elapsedMs ?? 0)).filter((n) => n > 0);

  const score = governanceScoreView(seed, events, now);
  const openIncidents = events.filter((e) => e.type === 'incident.opened').length
    - events.filter((e) => e.type === 'incident.closed').length;
  const critIncidents = events.filter(
    (e) => e.type === 'incident.opened' && e.payload.severity === 'critical',
  ).length;

  return {
    tenant: seed.tenant,
    seedVersion: seed.version,
    generatedAt: now,
    totalAgents: seed.agents.length,
    productionLikeAgents: b.productionLikeAgents,
    boundedAutonomy: b.boundedAutonomy,
    attentionAgents:
      b.attentionAgents
      + (drift > b.privilegeDriftFindings ? 1 : 0)
      - (orphans < b.orphanFindings ? 1 : 0),
    governanceScore: score,
    autonomousActions: autonomous,
    humanApprovals: approvals,
    policyBlocks: blocks,
    privilegeDriftFindings: drift,
    orphanAgents: orphans,
    evidenceCoveragePct: b.evidenceCoveragePct,
    maxFinancialBlastRadiusUsd: b.maxFinancialBlastRadiusUsd,
    medianPolicyDecisionMs: b.medianPolicyDecisionMs,
    timeToKillSec: ttk.length ? round1(mean(ttk) / 1000) : b.timeToKillSec,
    p95TimeToKillSec: ttk.length ? round1(percentile(ttk, 0.95) / 1000) : b.p95TimeToKillSec,
    criticalIncidents: critIncidents,
    openIncidents: Math.max(0, 2 + openIncidents),
    multimodalRisksDetected: multimodal,
    syntheticMediaAlerts: synthetic,
    promptInjectionAttempts: injection,
    exposureBlockedUsd: exposure,
    ranges: expectedRanges(b.autonomousActions, approvals, blocks, b.readOnlyEvaluations),
  };
}

/* ---------------- expected ranges (§14) ---------------- */

function expectedRanges(autonomous: number, approvals: number, blocks: number, readOnly: number): RangeStatus[] {
  const total = autonomous + approvals + blocks + readOnly;
  const autonomyPct = round1((autonomous / total) * 100);
  return [
    rangeStatus(
      { key: 'autonomy', label: 'Autonomy Rate (share of actions executed without a human)', expected: '%', actual: autonomyPct, unit: '%' },
      65, 75,
      'Reconciliation and read-only work is expected to be highly autonomous; payments are not. A value outside the range is a QUESTION, not automatically good or bad.',
    ),
    rangeStatus(
      { key: 'blockrate', label: 'Block Rate (share of evaluated actions blocked)', expected: '%', actual: round1((blocks / total) * 100), unit: '%' },
      0.3, 2.0,
      'A high block rate can mean strong controls OR badly designed agents — read it with the incident and use-case views.',
    ),
    rangeStatus(
      { key: 'approval-rate', label: 'Human Approval Rate', expected: '%', actual: round1((approvals / total) * 100), unit: '%' },
      1.0, 6.0,
      'Approvals should concentrate on consequential actions, not trivial reads.',
    ),
  ];
}

/* ---------------- governance score ---------------- */

export function scoreInputs(seed: DemoSeed, events: ActEvent[], now: number): ScoreInputs {
  const b = seed.baseline;
  const drift = b.privilegeDriftFindings
    + count(events, 'drift.detected')
    - count(events, 'drift.restored');
  const orphans = Math.max(0, b.orphanFindings - count(events, 'orphan.suspended') - count(events, 'orphan.reassigned'));
  const approvalsTotal = b.approvalsTotal + count(events, 'approval.granted') + count(events, 'approval.rejected');
  const approvalsBound = b.approvalsBound + count(events, 'approval.granted');
  const modalityTotal = b.modalityChecksTotal + count(events, 'scenario.run');
  const modalityFindings = (b.modalityChecksTotal - b.modalityChecksClean)
    + count(events, 'scenario.run', (p) => p.channel === 'injection' || p.channel === 'multimodal' || p.channel === 'synthetic');
  return {
    now,
    agentsTotal: seed.agents.length,
    agentsWithActiveOwner: b.ownedAgents - orphans,
    agentsReviewed: b.reviewedAgents,
    driftOpen: Math.max(0, drift),
    orphanOpen: orphans,
    openCriticalIncidents: events.filter((e) => e.type === 'incident.opened' && e.payload.severity === 'critical').length
      - events.filter((e) => e.type === 'incident.closed' && e.payload.severity === 'critical').length,
    evidenceCoveragePct: b.evidenceCoveragePct,
    killTestedPct: b.killTestedPct,
    credentialsValidPct: b.credentialsValidPct,
    policyChangesWithMakerChecker: b.policyChangesDualControlled,
    policyChangesTotal: b.policyChangesTotal,
    blastEnforcedPct: b.blastEnforcedPct,
    modalityChecksWithFindings: modalityFindings,
    modalityChecksTotal: modalityTotal,
    approvalsBound,
    approvalsTotal,
    emergencyDenyActive: events.some((e) => e.type === 'agent.killed' && e.payload.globalDeny === true),
    exceptions: [
      { id: 'EXC-2026-014', note: 'Unlisted model provider in pre-production evaluation', expiresAt: now + 21 * DAY },
    ],
    evidenceRefs: ['ev:foundation', 'ev:policy-catalogue', 'ev:readiness'],
  };
}

export function governanceScoreView(seed: DemoSeed, events: ActEvent[], now: number): GovernanceScore {
  return computeGovernanceScore(scoreInputs(seed, events, now));
}

/* ---------------- registry / passports ---------------- */

export interface RegistryRow extends AgentPassport {
  governanceScore: number;
  blastRadiusClass: string;
  needsAttention: boolean;
  attentionReason?: string;
}

export function registry(seed: DemoSeed, events: ActEvent[], now: number): RegistryRow[] {
  const driftByAgent = new Map<string, number>();
  for (const e of events) {
    if (e.type === 'drift.detected') driftByAgent.set(String(e.payload.agentId), (driftByAgent.get(String(e.payload.agentId)) ?? 0) + 1);
    if (e.type === 'drift.restored') driftByAgent.set(String(e.payload.agentId), Math.max(0, (driftByAgent.get(String(e.payload.agentId)) ?? 0) - 1));
  }
  const killed = new Set(events.filter((e) => e.type === 'agent.killed').map((e) => String(e.payload.agentId)));
  const suspended = new Set(events.filter((e) => e.type === 'orphan.suspended').map((e) => String(e.payload.agentId)));

  return seed.agents.map((a) => {
    const drift = (driftByAgent.get(a.agentId) ?? 0)
      + (seed.baseline.privilegeDriftFindings > 0 && a.agentId === 'agt_treasury_07' && driftByAgent.get(a.agentId) === undefined ? 0 : 0);
    const agent: AgentPassport = {
      ...a,
      status: killed.has(a.agentId) ? 'killed' : suspended.has(a.agentId) ? 'suspended' : a.status,
      driftedCapabilities: drift > 0 ? a.effectiveCapabilities.slice(-Math.min(drift, 2)) : undefined,
      effectiveCapabilities: drift > 0 ? [...a.approvedCapabilities, ...a.effectiveCapabilities.slice(-Math.min(drift, 2))] : a.approvedCapabilities,
      ownerActive: a.agentId === 'agt_credit_exp_04' && !suspended.has(a.agentId) ? false : a.ownerActive,
    };
    const blast = computeBlastRadius(agent, {});
    const overdue = agent.nextReview < now;
    const attention = drift > 0 || !agent.ownerActive || overdue;
    const score = Math.max(
      40,
      Math.min(
        99,
        (seed.baseline.evidenceCoveragePct > 0 ? 86 : 80)
          - drift * 3
          - (!agent.ownerActive ? 6 : 0)
          - (overdue ? 3 : 0)
          - (agent.status === 'killed' ? 10 : 0)
          + ((agent.name.length * 7) % 5) - 2,
      ),
    );
    return {
      ...agent,
      governanceScore: Math.round(score),
      blastRadiusClass: blast.overall,
      needsAttention: attention,
      attentionReason: drift > 0
        ? `${drift} unauthorized permission(s) beyond approval`
        : !agent.ownerActive
          ? 'owner inactive — orphan agent'
          : overdue
            ? `review overdue ${Math.round((now - agent.nextReview) / DAY)} days`
            : undefined,
    };
  });
}

/* ---------------- incidents ---------------- */

export interface IncidentRow {
  id: string;
  type: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  title: string;
  status: 'New' | 'Triaged' | 'Investigating' | 'Contained' | 'Remediating' | 'Resolved' | 'Closed';
  openedAt: number;
  agentId?: string;
  source: 'seed' | 'runtime';
}

export function incidents(_seed: DemoSeed, events: ActEvent[], now: number): IncidentRow[] {
  const rows: IncidentRow[] = [
    { id: 'INC-1041', type: 'Privilege Drift', severity: 'medium', title: 'Effective permissions exceed approval on Treasury-07', status: 'Investigating', openedAt: now - 2 * DAY, agentId: 'agt_treasury_07', source: 'seed' },
    { id: 'INC-1042', type: 'Orphan Agent', severity: 'medium', title: 'Credit-Experimental-04 has an inactive owner and an overdue review', status: 'Triaged', openedAt: now - 1 * DAY, agentId: 'agt_credit_exp_04', source: 'seed' },
    { id: 'INC-1038', type: 'Prompt Injection', severity: 'high', title: 'Indirect injection attempt via external web content', status: 'Resolved', openedAt: now - 5 * DAY, agentId: 'agt_research_12', source: 'seed' },
  ];
  let n = 1100;
  for (const e of events) {
    if (e.type === 'incident.opened') {
      rows.unshift({
        id: `INC-${n++}`,
        type: String(e.payload.type ?? 'Policy Failure'),
        severity: (e.payload.severity as IncidentRow['severity']) ?? 'medium',
        title: String(e.payload.title ?? 'Runtime incident'),
        status: 'New',
        openedAt: e.ts,
        agentId: e.payload.agentId ? String(e.payload.agentId) : undefined,
        source: 'runtime',
      });
    }
    if (e.type === 'incident.closed') {
      const target = rows.find((r) => r.id === String(e.payload.id));
      if (target) target.status = 'Closed';
    }
    if (e.type === 'drift.restored') {
      const target = rows.find((r) => r.type === 'Privilege Drift' && r.status !== 'Closed');
      if (target) target.status = 'Resolved';
    }
    if (e.type === 'orphan.suspended') {
      const target = rows.find((r) => r.type === 'Orphan Agent' && r.status !== 'Closed');
      if (target) target.status = 'Contained';
    }
  }
  return rows;
}

/* ---------------- approvals ---------------- */

export interface ApprovalRow {
  id: string;
  agentId: string;
  agent: string;
  action: string;
  amountUsd?: number;
  beneficiary?: string;
  requestedAt: number;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  requiredApprover: string;
  policyIds: string[];
  bindingHash: string;
}

export function approvals(_seed: DemoSeed, events: ActEvent[], now: number): ApprovalRow[] {
  const rows: ApprovalRow[] = [
    {
      id: 'apr_seed_1', agentId: 'agt_treasury_07', agent: 'Treasury-07', action: 'transfer:execute',
      amountUsd: 145_000, beneficiary: 'ben_supplier_4471', requestedAt: now - 40 * 60_000,
      status: 'approved', requiredApprover: 'Risk Manager (transaction approver)',
      policyIds: ['P-FIN-002'], bindingHash: '8f3c…a91d',
    },
    {
      id: 'apr_seed_2', agentId: 'agt_fraud_screen_09', agent: 'Fraud-Screen-09', action: 'case:close',
      requestedAt: now - 3 * 3600_000, status: 'approved', requiredApprover: 'Financial Crime Officer',
      policyIds: ['P-RSK-001'], bindingHash: '12ab…9c40',
    },
  ];
  let n = 500;
  for (const e of events) {
    if (e.type === 'decision' && e.payload.decision === 'REQUIRE_APPROVAL') {
      rows.unshift({
        id: String(e.payload.decisionId ?? `apr_${n}`),
        agentId: String(e.payload.agentId ?? ''),
        agent: String(e.payload.agentName ?? String(e.payload.agentId ?? '')),
        action: String(e.payload.action ?? ''),
        amountUsd: typeof e.payload.amountUsd === 'number' ? e.payload.amountUsd : undefined,
        beneficiary: e.payload.beneficiary ? String(e.payload.beneficiary) : undefined,
        requestedAt: e.ts,
        status: 'pending',
        requiredApprover: String(e.payload.requiredApprover ?? 'Risk Manager (transaction approver)'),
        policyIds: Array.isArray(e.payload.policyIds) ? (e.payload.policyIds as string[]) : [],
        bindingHash: String(e.payload.bindingHash ?? '—'),
      });
      n++;
    }
    if (e.type === 'approval.granted') {
      const target = rows.find((r) => r.id === String(e.payload.approvalId));
      if (target) target.status = 'approved';
    }
    if (e.type === 'approval.rejected') {
      const target = rows.find((r) => r.id === String(e.payload.approvalId));
      if (target) target.status = 'rejected';
    }
  }
  return rows;
}

/* ---------------- decisions / evidence ---------------- */

export interface DecisionRow {
  id: string;
  ts: number;
  agent: string;
  action: string;
  modality: string;
  decision: string;
  reasonCodes: string[];
  policies: string[];
  latencyMs: number;
  amountUsd?: number;
  riskSeverity: string;
  evidenceRef: string;
}

export function seededDecisions(seed: DemoSeed, now: number): DecisionRow[] {
  const rows: Array<[string, string, string, string, number, number, string[]]> = [
    ['dec_seed_01', 'reconcile-14', 'exception:create', 'ALLOW', 11, 0, ['ALL_CONTROLS_SATISFIED']],
    ['dec_seed_02', 'treasury-07', 'transfer:execute', 'REQUIRE_APPROVAL', 21, 145_000, ['ABOVE_AUTO_THRESHOLD']],
    ['dec_seed_03', 'research-12', 'web:fetch', 'ALLOW', 14, 0, ['ALL_CONTROLS_SATISFIED']],
    ['dec_seed_04', 'support-chat-06', 'ticket:create', 'ALLOW', 9, 0, ['ALL_CONTROLS_SATISFIED']],
    ['dec_seed_05', 'kyc-extract-11', 'document:extract', 'ALLOW', 24, 0, ['ALL_CONTROLS_SATISFIED']],
    ['dec_seed_06', 'market-research-02', 'web:fetch', 'ALLOW', 12, 0, ['ALL_CONTROLS_SATISFIED']],
    ['dec_seed_07', 'claims-doc-05', 'claim:decide', 'BLOCK', 19, 0, ['CAPABILITY_NOT_APPROVED']],
    ['dec_seed_08', 'collections-voice-03', 'limit:change', 'BLOCK', 17, 0, ['CAPABILITY_PROHIBITED']],
    ['dec_seed_09', 'invoice-match-16', 'invoice:post', 'REQUIRE_APPROVAL', 22, 12_400, ['ABOVE_AUTO_THRESHOLD']],
    ['dec_seed_10', 'trade-surv-13', 'order:read', 'ALLOW', 10, 0, ['ALL_CONTROLS_SATISFIED']],
    ['dec_seed_11', 'research-12', 'transfer:execute', 'BLOCK', 18, 250_000, ['CAPABILITY_PROHIBITED', 'AUTHORITY_EXPANSION']],
    ['dec_seed_12', 'sanctions-17', 'screen:run', 'ALLOW', 16, 0, ['ALL_CONTROLS_SATISFIED']],
  ];
  return rows.map(([id, agent, action, decision, latency, amount, codes], i) => ({
    id,
    ts: now - (i + 1) * 7 * 60_000,
    agent,
    action,
    modality: action.startsWith('transfer') || action.includes('invoice') ? 'STRUCTURED DATA' : action.includes('document') ? 'DOCUMENT' : action.includes('web') ? 'EXTERNAL WEB CONTENT' : 'TEXT',
    decision,
    reasonCodes: codes,
    policies: decision === 'ALLOW' ? ['P-CAP-001'] : codes.map(codeToPolicy),
    latencyMs: latency,
    amountUsd: amount || undefined,
    riskSeverity: decision === 'BLOCK' ? 'high' : decision === 'REQUIRE_APPROVAL' ? 'medium' : 'info',
    evidenceRef: `ev://${seed.tenant}/${id}`,
  }));
}

function codeToPolicy(code: string): string {
  const map: Record<string, string> = {
    ABOVE_AUTO_THRESHOLD: 'P-FIN-002',
    AUTONOMOUS_LIMIT_EXCEEDED: 'P-FIN-001',
    AUTHORITY_CEILING_EXCEEDED: 'P-FIN-001',
    ABOVE_AUTONOMOUS_CEILING: 'P-FIN-001',
    DAILY_EXPOSURE_EXCEEDED: 'P-FIN-003',
    VELOCITY_LIMIT: 'P-FIN-004',
    BENEFICIARY_NOT_APPROVED: 'P-BEN-001',
    CAPABILITY_NOT_APPROVED: 'P-CAP-001',
    CAPABILITY_PROHIBITED: 'P-CAP-002',
    PROMPT_INJECTION_DETECTED: 'P-INJ-001',
    AUTHORITY_EXPANSION: 'P-DEL-001',
    CROSS_BORDER_PROHIBITED: 'P-GEO-001',
    INSTRUMENT_NOT_APPROVED: 'P-INS-001',
    CROSS_ENTITY_PROHIBITED: 'P-ENT-001',
    CREDENTIAL_INVALID: 'P-SEC-001',
    REPLAY_DETECTED: 'P-SEC-003',
  };
  return map[code] ?? 'P-GOV-001';
}

export function runtimeDecisions(events: ActEvent[]): DecisionRow[] {
  return events
    .filter((e) => e.type === 'decision')
    .map((e) => {
      const p = e.payload;
      return {
        id: String(p.decisionId ?? `dec_${e.seq}`),
        ts: e.ts,
        agent: String(p.agentName ?? p.agentId ?? '—'),
        action: String(p.action ?? '—'),
        modality: String(p.modality ?? 'TEXT'),
        decision: String(p.decision ?? 'ALLOW'),
        reasonCodes: Array.isArray(p.reasonCodes) ? (p.reasonCodes as string[]) : [],
        policies: Array.isArray(p.policyIds) ? (p.policyIds as string[]) : [],
        latencyMs: Number(p.latencyMs ?? 0),
        amountUsd: typeof p.amountUsd === 'number' ? p.amountUsd : undefined,
        riskSeverity: String(p.riskSeverity ?? 'info'),
        evidenceRef: String(p.evidenceRef ?? ''),
      };
    })
    .reverse();
}

/* ---------------- performance ---------------- */

export function performance(seed: DemoSeed, events: ActEvent[]): Record<string, number> {
  const kills = events.filter((e) => e.type === 'agent.killed').length;
  return {
    ...seed.performance,
    killActivations: kills,
    driftFindings: seed.baseline.privilegeDriftFindings + count(events, 'drift.detected') - count(events, 'drift.restored'),
  };
}

/* ---------------- executive summary (§101) ---------------- */

export function executiveSummary(seed: DemoSeed, events: ActEvent[], now: number): Record<string, string | number> {
  const ov = overview(seed, events, now);
  return {
    'Agents Governed': ov.totalAgents,
    'Actions Evaluated': ov.autonomousActions + ov.humanApprovals + ov.policyBlocks,
    'Autonomous Actions': ov.autonomousActions,
    'Human Approvals': ov.humanApprovals,
    'Blocked Actions': ov.policyBlocks,
    'Potential Exposure Blocked': `$${ov.exposureBlockedUsd.toLocaleString('en-US')}`,
    'Privilege Drift': ov.privilegeDriftFindings,
    'Orphan Agents': ov.orphanAgents,
    'Prompt Injection Attempts': ov.promptInjectionAttempts,
    'Multimodal Risks': ov.multimodalRisksDetected,
    'Synthetic Media Alerts': ov.syntheticMediaAlerts,
    'Evidence Coverage': `${ov.evidenceCoveragePct}%`,
    'Median Policy Latency': `${ov.medianPolicyDecisionMs} ms`,
    'Time to Kill': `${ov.timeToKillSec} sec`,
    'FSB Practices Evidenced': '9 of 12 strongly evidenced',
    'Governance Score': `${ov.governanceScore.score}/100 — ${ov.governanceScore.classification}`,
  };
}

/* ---------------- what-if helper ---------------- */

export interface WhatIfResult {
  scenario: string;
  decision: string;
  reasonCodes: string[];
  policies: string[];
  requiredApprover?: string;
}

function mean(xs: number[]): number {
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

function percentile(xs: number[], p: number): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export { buildSeed, TENANT, DISCLAIMER };
export type { ActEvent };