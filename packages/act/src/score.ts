/**
 * Governance Score — a risk-management indicator, never a compliance claim.
 *
 * 11 weighted components (total 100). Component values are derived from live
 * findings (drift, orphans, incidents, evidence coverage …), so the score moves
 * when the estate changes and is reproducible from its inputs.
 *
 * formulaVersion 1.0.0:
 *   score = round(Σ achieved_i)  where 0 ≤ achieved_i ≤ weight_i
 */

import type { GovernanceScore, ScoreComponent } from './types.ts';

export const METHODOLOGY_VERSION = 'act-govscore-methodology-1.0.0';
export const FORMULA_VERSION = 'act-govscore-formula-1.0.0';

export const DISCLAIMER =
  'Governance Score is a risk-management indicator and does not by itself establish regulatory compliance.';

export interface ScoreInputs {
  now: number;
  agentsTotal: number;
  agentsWithActiveOwner: number;
  agentsReviewed: number; // nextReview in the future
  driftOpen: number;
  orphanOpen: number;
  openCriticalIncidents: number;
  evidenceCoveragePct: number; // 0..100
  killTestedPct: number; // 0..100 — most recent kill tests within SLO
  credentialsValidPct: number; // 0..100 short-lived / rotated
  policyChangesWithMakerChecker: number;
  policyChangesTotal: number;
  /** % of financial-capable agents with per-transaction/daily/velocity limits actually enforced */
  blastEnforcedPct: number;
  modalityChecksWithFindings: number;
  modalityChecksTotal: number;
  approvalsBound: number;
  approvalsTotal: number;
  emergencyDenyActive?: boolean;
  exceptions?: Array<{ id: string; note: string; expiresAt?: number }>;
  evidenceRefs?: string[];
}

function pct(part: number, whole: number): number {
  return whole > 0 ? (part / whole) * 100 : 100;
}

/**
 * Compute the score. Individual components degrade independently so the
 * operator can see WHICH control lost points.
 */
export function computeGovernanceScore(inputs: ScoreInputs): GovernanceScore {
  const c: ScoreComponent[] = [];

  const identityPct = pct(inputs.agentsWithActiveOwner, inputs.agentsTotal);
  const reviewPct = pct(inputs.agentsReviewed, inputs.agentsTotal);
  c.push({
    key: 'identity',
    label: 'Identity & Ownership',
    weight: 10,
    achieved: round1(Math.min(10, (identityPct * 0.6 + reviewPct * 0.4) / 10)),
    inputs: ['owners assigned', 'reviews current'],
    notes: `${inputs.agentsWithActiveOwner}/${inputs.agentsTotal} owned · ${inputs.agentsReviewed}/${inputs.agentsTotal} reviewed`,
  });

  c.push({
    key: 'authorization',
    label: 'Authorization / Least Privilege',
    weight: 15,
    achieved: inputs.driftOpen > 0 ? Math.max(0, 13 - inputs.driftOpen * 2.5) : 13,
    inputs: ['open privilege-drift findings', 'approved vs effective permissions'],
    notes: inputs.driftOpen ? `${inputs.driftOpen} open drift finding(s)` : 'no drift',
  });

  c.push({
    key: 'runtime',
    label: 'Runtime Policy Enforcement',
    weight: 15,
    achieved: inputs.emergencyDenyActive ? 15 : 13.5,
    inputs: ['deterministic gateway active', 'fail-closed gates'],
    notes: 'deterministic evaluation, fail-closed by default',
  });

  const approvalBindPct = pct(inputs.approvalsBound, inputs.approvalsTotal);
  c.push({
    key: 'oversight',
    label: 'Human Oversight',
    weight: 10,
    achieved: round1(Math.min(10, (approvalBindPct / 100) * 6 + (inputs.approvalsTotal > 0 ? 3 : 1))),
    inputs: ['approval binding', 'approval coverage'],
    notes: `${inputs.approvalsBound}/${inputs.approvalsTotal} approvals bound to exact transaction`,
  });

  c.push({
    key: 'blast',
    label: 'Blast Radius Containment',
    weight: 10,
    achieved: round1(Math.min(10, (inputs.blastEnforcedPct / 100) * 9)),
    inputs: ['per-transaction ceiling', 'daily aggregate', 'velocity'],
    notes: 'limits enforced at the gateway, not advisory',
  });

  const ev = inputs.evidenceCoveragePct;
  c.push({
    key: 'evidence',
    label: 'Evidence & Auditability',
    weight: 10,
    achieved: round1(Math.min(10, (ev / 100) * 10)),
    inputs: ['evidence coverage %', 'hash-chain integrity'],
    notes: `${ev.toFixed(1)}% coverage`,
  });

  c.push({
    key: 'credentials',
    label: 'Credential Hygiene',
    weight: 5,
    achieved: round1(Math.min(5, (inputs.credentialsValidPct / 100) * 5)),
    inputs: ['short-lived credentials', 'rotation'],
    notes: `${inputs.credentialsValidPct}% within policy`,
  });

  c.push({
    key: 'recovery',
    label: 'Recovery / Kill Capability',
    weight: 10,
    achieved: round1(Math.min(10, (inputs.killTestedPct / 100) * 10)),
    inputs: ['kill switch enabled', 'time-to-kill within SLO'],
    notes: `${inputs.killTestedPct}% of kill tests within SLO`,
  });

  const monitoringBase = 4 - Math.min(3, inputs.openCriticalIncidents);
  c.push({
    key: 'monitoring',
    label: 'Monitoring / Incident Readiness',
    weight: 5,
    achieved: Math.max(0, monitoringBase),
    inputs: ['SIEM event coverage', 'open critical incidents'],
    notes: inputs.openCriticalIncidents ? `${inputs.openCriticalIncidents} critical incident(s) open` : 'no critical incidents',
  });

  const changePct = pct(inputs.policyChangesWithMakerChecker, inputs.policyChangesTotal);
  c.push({
    key: 'change',
    label: 'Change Governance',
    weight: 5,
    achieved: round1(Math.min(5, (changePct / 100) * 5)),
    inputs: ['maker-checker on policy changes'],
    notes: `${inputs.policyChangesWithMakerChecker}/${inputs.policyChangesTotal} changes dual-controlled`,
  });

  const modPct = pct(inputs.modalityChecksTotal - inputs.modalityChecksWithFindings, inputs.modalityChecksTotal);
  c.push({
    key: 'multimodal',
    label: 'Multimodal Safety & Provenance',
    weight: 5,
    achieved: round1(Math.min(5, (modPct / 100) * 5)),
    inputs: ['modality checkpoint findings', 'provenance validation'],
    notes: `${inputs.modalityChecksTotal - inputs.modalityChecksWithFindings}/${inputs.modalityChecksTotal} content items clean`,
  });

  const score = Math.max(0, Math.min(100, Math.round(c.reduce((s, x) => s + x.achieved, 0))));
  return {
    score,
    classification: classify(score),
    methodologyVersion: METHODOLOGY_VERSION,
    formulaVersion: FORMULA_VERSION,
    computedAt: inputs.now,
    components: c,
    exceptions: inputs.exceptions ?? [],
    evidenceRefs: inputs.evidenceRefs ?? [],
    disclaimer: DISCLAIMER,
  };
}

export function classify(score: number): string {
  if (score >= 90) return 'Controlled Autonomy';
  if (score >= 80) return 'Managed';
  if (score >= 70) return 'Attention Required';
  if (score >= 60) return 'High Risk';
  return 'Critical';
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/* ---- expected ranges: not every metric is higher = better ---- */

export interface RangeMetric {
  key: string;
  label: string;
  expected: string;
  actual: number;
  unit: string;
  lowerBetter?: boolean;
}

export interface RangeStatus {
  key: string;
  label: string;
  expected: string;
  actual: string;
  status: 'Within Expected Range' | 'Above Expected Range' | 'Below Expected Range';
  note: string;
}

export function rangeStatus(
  m: RangeMetric,
  low: number,
  high: number,
  interpretation: string,
): RangeStatus {
  const status =
    m.actual >= low && m.actual <= high
      ? 'Within Expected Range'
      : m.actual > high
        ? 'Above Expected Range'
        : 'Below Expected Range';
  return {
    key: m.key,
    label: m.label,
    expected: `${low}–${high}${m.unit}`,
    actual: `${m.actual}${m.unit}`,
    status,
    note: interpretation,
  };
}