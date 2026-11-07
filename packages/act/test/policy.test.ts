import { describe, expect, it } from 'vitest';
import { evaluate, isConsequential } from '../src/policy.ts';
import type { EvaluationContext } from '../src/types.ts';

const NOW = 1_760_000_000_000;

function ctx(over: Partial<EvaluationContext> = {}): EvaluationContext {
  return {
    tenant: 't1',
    environment: 'demo',
    agentId: 'agt_treasury_07',
    agentVersion: 'v2.1.0',
    authorityProfileVersion: 'agt_treasury_07@v2.1.0',
    identityVerified: true,
    tenantValid: true,
    credential: { valid: true, expiresAt: NOW + 60_000 },
    agentStatus: 'active',
    action: 'transfer:execute',
    modality: 'STRUCTURED DATA',
    sourceTrust: 'internal',
    provenance: 'unknown',
    contentClass: 'System Instruction',
    riskTier: 'high',
    autonomyLevel: 'BOUND AUTONOMY',
    approvedCapabilities: ['transfer:execute', 'balances:read'],
    prohibitedCapabilities: ['beneficiary:create', 'policy:modify', 'agent:self-modify'],
    maxAutonomousUsd: 100_000,
    authorityCeilingUsd: 500_000,
    autoApprovalThresholdUsd: 250_000,
    dailyLimitUsd: 500_000,
    dailyExecutedUsd: 0,
    maxVelocityPerHour: 4,
    velocityLastHour: 0,
    reversible: false,
    readOnly: false,
    approval: { state: 'none' },
    policyEngineAvailable: true,
    evidenceInfrastructureOk: true,
    productionConfigValid: true,
    now: NOW,
    ...over,
  };
}

describe('runtime governance gateway', () => {
  it('allows a small transfer inside every limit', () => {
    const d = evaluate(ctx({ amountUsd: 80_000, beneficiary: { id: 'b1', approved: true } }));
    expect(d.decision).toBe('ALLOW');
    expect(d.failClosed).toBe(false);
    expect(d.reasonCodes).toEqual(['ALL_CONTROLS_SATISFIED']);
  });

  it('scene 3: $340K requires approval (above autonomous ceiling, inside hard ceiling)', () => {
    const d = evaluate(ctx({
      amountUsd: 340_000,
      beneficiary: { id: 'b1', approved: true },
      instrument: { id: 'RTGS', approved: true },
      crossEntity: false,
    }));
    expect(d.decision).toBe('REQUIRE_APPROVAL');
    expect(d.policyIds).toContain('P-FIN-001');
    expect(d.requiredApprover).toBeTruthy();
    expect(d.decisionExpiryMs).toBe(15 * 60_000);
  });

  it('scene 4: $4.8M with new beneficiary + unapproved instrument + cross-entity blocks on four policies', () => {
    const d = evaluate(ctx({
      amountUsd: 4_800_000,
      beneficiary: { id: 'b_new', approved: false },
      instrument: { id: 'FX_SWAP', approved: false },
      crossEntity: true,
      sourceTrust: 'external',
      contentClass: 'External Content',
      modality: 'EXTERNAL WEB CONTENT',
    }));
    expect(d.decision).toBe('BLOCK');
    for (const p of ['P-FIN-001', 'P-BEN-001', 'P-INS-001', 'P-ENT-001']) {
      expect(d.policyIds).toContain(p);
    }
  });

  it('fails closed on invalid identity, expired credential and bad tenant', () => {
    expect(evaluate(ctx({ identityVerified: false })).decision).toBe('BLOCK');
    expect(evaluate(ctx({ credential: { valid: false } })).decision).toBe('BLOCK');
    expect(evaluate(ctx({ credential: { valid: true, expiresAt: NOW - 1 } })).decision).toBe('BLOCK');
    expect(evaluate(ctx({ tenantValid: false })).decision).toBe('BLOCK');
  });

  it('fails closed when the policy engine is unavailable (default deny)', () => {
    const d = evaluate(ctx({ policyEngineAvailable: false, amountUsd: 50_000 }));
    expect(d.decision).toBe('BLOCK');
    expect(d.reasonCodes).toContain('POLICY_ENGINE_UNAVAILABLE');
  });

  it('supports configurable degraded read-only behaviour for low-risk reads', () => {
    const d = evaluate(ctx({
      policyEngineAvailable: false,
      degradedPolicy: 'allow-readonly',
      readOnly: true,
      riskTier: 'low',
      action: 'balances:read',
      amountUsd: undefined,
      reversible: true,
    }));
    expect(d.decision).toBe('ALLOW');
    expect(d.reasonCodes).toContain('DEGRADED_READ_ALLOWED');
    // and it still refuses a write
    const w = evaluate(ctx({ policyEngineAvailable: false, degradedPolicy: 'allow-readonly', amountUsd: 10_000 }));
    expect(w.decision).toBe('BLOCK');
  });

  it('fails closed when evidence infrastructure is down for consequential actions', () => {
    const d = evaluate(ctx({ evidenceInfrastructureOk: false, amountUsd: 10_000 }));
    expect(d.decision).toBe('BLOCK');
    expect(d.reasonCodes).toContain('EVIDENCE_UNAVAILABLE');
  });

  it('holds on unresolved critical privilege drift', () => {
    const d = evaluate(ctx({ openCriticalPrivilegeDrift: true, amountUsd: 10_000 }));
    expect(d.decision).toBe('HOLD');
    expect(d.reasonCodes).toContain('PRIVILEGE_DRIFT_OPEN');
  });

  it('blocks on emergency deny, invalid production config and containment state', () => {
    expect(evaluate(ctx({ emergencyDeny: true })).decision).toBe('BLOCK');
    expect(evaluate(ctx({ environment: 'production', productionConfigValid: false })).decision).toBe('BLOCK');
    expect(evaluate(ctx({ agentStatus: 'killed' })).decision).toBe('BLOCK');
    expect(evaluate(ctx({ agentStatus: 'suspended' })).decision).toBe('BLOCK');
    expect(evaluate(ctx({ agentStatus: 'quarantined' })).decision).toBe('QUARANTINE');
  });

  it('rejects replayed and duplicated requests', () => {
    expect(evaluate(ctx({ replayDetected: true })).reasonCodes).toContain('REPLAY_DETECTED');
    expect(evaluate(ctx({ idempotencyDuplicate: true })).reasonCodes).toContain('IDEMPOTENCY_DUPLICATE');
  });

  it('enforces daily exposure and velocity', () => {
    const daily = evaluate(ctx({ amountUsd: 100_000, dailyExecutedUsd: 450_000 }));
    expect(daily.decision).not.toBe('ALLOW');
    expect(daily.reasonCodes).toContain('DAILY_EXPOSURE_EXCEEDED');

    const velocity = evaluate(ctx({ amountUsd: 90_000, velocityLastHour: 7 }));
    expect(velocity.decision).toBe('BLOCK');
    expect(velocity.reasonCodes).toContain('VELOCITY_LIMIT');
  });

  it('blocks prohibited capabilities and injection-driven tool calls', () => {
    const prohibited = evaluate(ctx({ action: 'beneficiary:create' }));
    expect(prohibited.decision).toBe('BLOCK');
    expect(prohibited.reasonCodes).toContain('CAPABILITY_PROHIBITED');

    const injected = evaluate(ctx({ injectionDetected: true, amountUsd: 10_000 }));
    expect(injected.decision).toBe('BLOCK');
    expect(injected.reasonCodes).toContain('PROMPT_INJECTION_DETECTED');
  });

  it('blocks untrusted content that tries to direct a consequential action', () => {
    const d = evaluate(ctx({
      amountUsd: 10_000,
      contentClass: 'External Content',
      sourceTrust: 'external',
      provenance: 'absent',
    }));
    expect(d.decision).toBe('BLOCK');
    expect(d.reasonCodes).toContain('UNTRUSTED_CONTENT_INSTRUCTION');
  });

  it('invalidates approvals that expired or whose transaction changed', () => {
    expect(evaluate(ctx({ amountUsd: 340_000, approval: { state: 'expired' } })).reasonCodes).toContain('APPROVAL_EXPIRED');
    expect(evaluate(ctx({ amountUsd: 340_000, approval: { state: 'mutated' } })).decision).toBe('BLOCK');
  });

  it('blocks delegation that would expand authority', () => {
    const d = evaluate(ctx({
      agentId: 'agt_research_12',
      approvedCapabilities: ['research:read'],
      amountUsd: 50_000,
      delegation: {
        originatingAgent: 'agt_treasury_07',
        receivingAgent: 'agt_research_12',
        scope: 'market analysis',
        delegatedCapability: 'research:read',
        chainDepth: 1,
        maxChainDepth: 3,
        loopDetected: false,
        expiresAt: NOW + 60_000,
        now: NOW,
      },
    }));
    expect(d.decision).toBe('BLOCK');
    expect(d.policyIds).toContain('P-CAP-001');
  });

  it('is deterministic — the same context yields the same decision', () => {
    const a = evaluate(ctx({ amountUsd: 4_800_000, beneficiary: { id: 'b', approved: false } }));
    const b = evaluate(ctx({ amountUsd: 4_800_000, beneficiary: { id: 'b', approved: false } }));
    expect(a.decision).toBe(b.decision);
    expect(a.policyIds).toEqual(b.policyIds);
    expect(a.reasonCodes).toEqual(b.reasonCodes);
  });

  it('classifies consequence correctly', () => {
    expect(isConsequential(ctx({ amountUsd: 10 }))).toBe(true);
    expect(isConsequential(ctx({ readOnly: true, amountUsd: undefined, reversible: true, action: 'balances:read' }))).toBe(false);
  });
});