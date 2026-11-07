import { describe, expect, it } from 'vitest';
import { buildSeed } from '../src/seed.ts';
import { computeGovernanceScore, classify, DISCLAIMER } from '../src/score.ts';
import { overview, scoreInputs } from '../src/state.ts';
import { runScenario, SCENARIO_META } from '../src/scenarios.ts';
import { checkBlastRadius, computeBlastRadius } from '../src/blast.ts';
import type { ActEvent } from '../src/types.ts';

const NOW = 1_760_000_000_000;
const seed = buildSeed(NOW);

describe('governance score', () => {
  it('weights sum to 100 and every component is bounded by its weight', () => {
    const s = computeGovernanceScore(scoreInputs(seed, [], NOW));
    expect(s.components.reduce((n, c) => n + c.weight, 0)).toBe(100);
    for (const c of s.components) {
      expect(c.achieved).toBeGreaterThanOrEqual(0);
      expect(c.achieved).toBeLessThanOrEqual(c.weight);
    }
    expect(s.components).toHaveLength(11);
  });

  it('scores the seeded demo estate at 86 — Managed', () => {
    const s = computeGovernanceScore(scoreInputs(seed, [], NOW));
    expect(s.score).toBe(86);
    expect(s.classification).toBe('Managed');
    expect(s.methodologyVersion).toBeTruthy();
    expect(s.formulaVersion).toBeTruthy();
    expect(s.computedAt).toBe(NOW);
    expect(s.disclaimer).toBe(DISCLAIMER);
    expect(s.disclaimer).toMatch(/does not by itself establish regulatory compliance/);
  });

  it('drops when privilege drift opens and recovers when it is restored', () => {
    const before = computeGovernanceScore(scoreInputs(seed, [], NOW)).score;
    const drift: ActEvent[] = [
      { seq: 1, ts: NOW, type: 'drift.detected' as const, payload: { agentId: 'agt_treasury_07', count: 2 } },
    ];
    const during = computeGovernanceScore(scoreInputs(seed, drift, NOW)).score;
    expect(during).toBeLessThan(before);
    const restored: ActEvent[] = [
      ...drift,
      { seq: 2, ts: NOW, type: 'drift.restored' as const, payload: { agentId: 'agt_treasury_07' } },
    ];
    expect(computeGovernanceScore(scoreInputs(seed, restored, NOW)).score).toBe(before);
  });

  it('classification bands', () => {
    expect(classify(95)).toBe('Controlled Autonomy');
    expect(classify(86)).toBe('Managed');
    expect(classify(75)).toBe('Attention Required');
    expect(classify(65)).toBe('High Risk');
    expect(classify(40)).toBe('Critical');
  });
});

describe('seeded executive overview (§12)', () => {
  const ov = overview(seed, [], NOW);

  it('matches the specified demo portfolio values, all calculated', () => {
    expect(ov.totalAgents).toBe(27);
    expect(ov.productionLikeAgents).toBe(18);
    expect(ov.boundedAutonomy).toBe(6);
    expect(ov.attentionAgents).toBe(3);
    expect(ov.governanceScore.score).toBe(86);
    expect(ov.autonomousActions).toBe(1842);
    expect(ov.humanApprovals).toBe(37);
    expect(ov.policyBlocks).toBe(12);
    expect(ov.privilegeDriftFindings).toBe(2);
    expect(ov.orphanAgents).toBe(1);
    expect(ov.evidenceCoveragePct).toBe(99.4);
    expect(ov.maxFinancialBlastRadiusUsd).toBe(500_000);
    expect(ov.medianPolicyDecisionMs).toBe(18);
    expect(ov.timeToKillSec).toBe(4.2);
    expect(ov.criticalIncidents).toBe(0);
  });

  it('shows expected ranges with interpretation (not "higher is better")', () => {
    const autonomy = ov.ranges.find((r) => r.key === 'autonomy')!;
    expect(autonomy.actual).toBe('71%');
    expect(autonomy.status).toBe('Within Expected Range');
    expect(autonomy.note.length).toBeGreaterThan(20);
    for (const r of ov.ranges) expect(r.status).toBeTruthy();
  });
});

describe('blast radius enforcement (§49)', () => {
  const treasury = seed.agents.find((a) => a.name === 'Treasury-07')!;

  it('classifies and explains dimensions', () => {
    const br = computeBlastRadius(treasury, { dailyExecutedUsd: 0 });
    expect(br.financialUsd).toBe(500_000);
    expect(['LOW', 'MODERATE', 'HIGH', 'CRITICAL']).toContain(br.overall);
    expect(br.dimensions.length).toBeGreaterThanOrEqual(9);
    expect(br.explanation.length).toBeGreaterThan(20);
  });

  it('refuses $100K autonomous execution once $450K is already executed today', () => {
    const r = checkBlastRadius(treasury, { amountUsd: 100_000, dailyExecutedUsd: 450_000 });
    expect(r.ok).toBe(false);
    expect(r.breaches.map((b) => b.code)).toContain('DAILY_EXPOSURE');
    expect(r.remainingTodayUsd).toBe(50_000);
  });

  it('flags per-transaction ceiling and velocity breaches', () => {
    const over = checkBlastRadius(treasury, { amountUsd: 150_000, dailyExecutedUsd: 0 });
    expect(over.breaches.map((b) => b.code)).toContain('PER_TRANSACTION_LIMIT');
    const fast = checkBlastRadius(treasury, { amountUsd: 10_000, velocityLastHour: 4 });
    expect(fast.breaches.map((b) => b.code)).toContain('VELOCITY');
  });
});

describe('demo scenarios (§85–§100)', () => {
  const ctx = { seed, events: [], now: NOW };

  it('exposes the full storyline and lab catalogue', () => {
    expect(SCENARIO_META.filter((s) => s.group === 'storyline')).toHaveLength(10);
    expect(SCENARIO_META.filter((s) => s.group === 'lab').length).toBeGreaterThanOrEqual(14);
  });

  it('runs every scenario deterministically with steps and a decision', () => {
    for (const meta of SCENARIO_META) {
      const a = runScenario(meta.id, ctx);
      const b = runScenario(meta.id, ctx);
      expect(a.steps.length).toBeGreaterThan(0);
      expect(a.learning.length).toBeGreaterThan(10);
      expect(a.decision).toBe(b.decision);
      expect(a.reasonCodes).toEqual(b.reasonCodes);
      expect(a.events.length).toBeGreaterThan(0);
    }
  });

  it('produces the specified decisions for key scenes', () => {
    expect(runScenario('s2-reconcile', ctx).decision).toBe('ALLOW');
    expect(runScenario('s3-transfer-340k', ctx).decision).toBe('REQUIRE_APPROVAL');
    expect(runScenario('s4-transfer-48m', ctx).decision).toBe('BLOCK');
    expect(runScenario('s5-web-injection', ctx).decision).toContain('BLOCK');
    expect(runScenario('lab-delegation', ctx).decision).toBe('BLOCK');
    expect(runScenario('lab-cross-modal', ctx).decision).toBe('BLOCK');
    expect(runScenario('lab-voice-impersonation', ctx).decision).toBe('BLOCK');
    expect(runScenario('lab-video-deepfake', ctx).decision).toBe('BLOCK');
    expect(runScenario('lab-customer-voice', ctx).decision).toContain('REQUIRE_APPROVAL');
  });

  it('counts blocked exposure for the $4.8M scene', () => {
    const r = runScenario('s4-transfer-48m', ctx);
    expect(r.exposureBlockedUsd).toBe(4_800_000);
    expect(r.events.some((e) => e.type === 'exposure.blocked')).toBe(true);
  });

  it('never emits a compliance claim', () => {
    for (const meta of SCENARIO_META) {
      const r = runScenario(meta.id, ctx);
      const blob = JSON.stringify(r).toUpperCase();
      expect(blob).not.toContain('FSB COMPLIANT');
      expect(blob).not.toContain('NIST CERTIFIED');
      expect(blob).not.toContain('EU AI ACT CERTIFIED');
    }
  });
});