/**
 * Deterministic runtime governance engine (`POST /governance/evaluate`).
 *
 * Rules are evaluated in priority order and ALL matched policies are reported;
 * the returned decision is the most severe matched outcome. Nothing here calls
 * a model. Failure principle: any mandatory control that cannot be evaluated
 * yields HOLD/BLOCK — never a silent ALLOW.
 */

import type {
  Decision, EvaluationContext, GovernanceDecision, PolicyDef, RiskSeverity,
} from './types.ts';

export const POLICIES: PolicyDef[] = [
  { id: 'P-SEC-001', name: 'Credential validity', version: '5.2.1', priority: 10, topic: 'Identity & Authority' },
  { id: 'P-SEC-002', name: 'Tenant context validation', version: '3.0.0', priority: 11, topic: 'Identity & Authority' },
  { id: 'P-SEC-003', name: 'Replay / duplicate request protection', version: '2.1.0', priority: 12, topic: 'Transaction Integrity' },
  { id: 'P-SEC-004', name: 'Privilege-drift hold', version: '1.4.0', priority: 13, topic: 'Identity & Authority' },
  { id: 'P-GOV-001', name: 'Evidence mandatory for consequential actions', version: '2.0.0', priority: 14, topic: 'Evidence' },
  { id: 'P-GOV-002', name: 'Emergency / global deny', version: '1.0.0', priority: 15, topic: 'Containment' },
  { id: 'P-GOV-003', name: 'Production configuration integrity', version: '1.1.0', priority: 16, topic: 'Configuration' },
  { id: 'P-GOV-004', name: 'Agent containment state (suspended / killed)', version: '1.2.0', priority: 17, topic: 'Containment' },
  { id: 'P-CAP-001', name: 'Capability must be approved for the agent', version: '4.0.2', priority: 20, topic: 'Authorization' },
  { id: 'P-CAP-002', name: 'Prohibited capability list', version: '4.0.0', priority: 21, topic: 'Authorization' },
  { id: 'P-DEL-001', name: 'Delegation cannot expand authority', version: '3.0.0', priority: 22, topic: 'Agent-to-Agent' },
  { id: 'P-DEL-002', name: 'Delegation TTL, chain depth and loop detection', version: '2.0.0', priority: 23, topic: 'Agent-to-Agent' },
  { id: 'P-INJ-001', name: 'Prompt injection (direct / indirect / multimodal)', version: '3.3.0', priority: 30, topic: 'Content Safety' },
  { id: 'P-MOD-001', name: 'Modality permitted for the use case', version: '2.0.0', priority: 31, topic: 'Modality Governance' },
  { id: 'P-MOD-002', name: 'Untrusted content may not instruct consequential action', version: '2.2.0', priority: 32, topic: 'Modality Governance' },
  { id: 'P-SYN-001', name: 'Synthetic-media identity claim requires out-of-band verification', version: '2.0.0', priority: 33, topic: 'Synthetic Media' },
  { id: 'P-XCM-001', name: 'Cross-modal inconsistency hold', version: '1.0.0', priority: 34, topic: 'Modality Governance' },
  { id: 'P-FIN-001', name: 'Autonomous transfer ceiling', version: '3.1.0', priority: 40, topic: 'Financial Limits' },
  { id: 'P-FIN-002', name: 'Auto-approval threshold', version: '3.0.0', priority: 41, topic: 'Financial Limits' },
  { id: 'P-FIN-003', name: 'Daily aggregate exposure', version: '2.4.0', priority: 42, topic: 'Financial Limits' },
  { id: 'P-FIN-004', name: 'Transaction velocity limit', version: '2.2.0', priority: 43, topic: 'Financial Limits' },
  { id: 'P-BEN-001', name: 'Approved beneficiary only', version: '4.1.0', priority: 44, topic: 'Financial Limits' },
  { id: 'P-GEO-001', name: 'Cross-border execution prohibited', version: '2.0.0', priority: 45, topic: 'Financial Limits' },
  { id: 'P-INS-001', name: 'Approved instrument only', version: '1.3.0', priority: 46, topic: 'Financial Limits' },
  { id: 'P-ENT-001', name: 'Cross-entity transfer restriction', version: '1.2.0', priority: 47, topic: 'Financial Limits' },
  { id: 'P-APP-001', name: 'Approval integrity (binding + freshness)', version: '2.3.0', priority: 50, topic: 'Human Oversight' },
  { id: 'P-RSK-001', name: 'Risk-appetite breach', version: '1.0.0', priority: 60, topic: 'Risk Appetite' },
];

const SEVERITY: Record<Decision, number> = {
  ALLOW: 0,
  HOLD: 1,
  REQUIRE_APPROVAL: 2,
  QUARANTINE: 3,
  BLOCK: 4,
};

const SEVERITY_LABEL: Record<Decision, RiskSeverity> = {
  ALLOW: 'info',
  HOLD: 'medium',
  REQUIRE_APPROVAL: 'medium',
  QUARANTINE: 'high',
  BLOCK: 'high',
};

interface Match {
  policy: PolicyDef;
  decision: Decision;
  reason: string;
}

function consequence(ctx: EvaluationContext): boolean {
  return !ctx.readOnly && (ctx.amountUsd !== undefined || ctx.customerImpact !== undefined || !ctx.reversible);
}

function push(out: Match[], policyId: string, decision: Decision, reason: string): void {
  const policy = POLICIES.find((p) => p.id === policyId);
  if (!policy) throw new Error(`unknown policy ${policyId}`);
  out.push({ policy, decision, reason });
}

/**
 * Evaluate one governance request. Pure: `ctx.now` is the only clock.
 */
export function evaluate(ctx: EvaluationContext): GovernanceDecision {
  const started = Date.now();
  const matches: Match[] = [];
  const consequential = consequence(ctx);
  const engineUp = ctx.policyEngineAvailable !== false;
  const degraded = ctx.degradedPolicy ?? 'deny';

  /* ---- fail-closed gates (mandatory controls) ---- */
  if (!ctx.tenantValid) {
    push(matches, 'P-SEC-002', 'BLOCK', 'invalid tenant context');
  }
  if (!ctx.identityVerified) {
    push(matches, 'P-SEC-001', consequential ? 'BLOCK' : 'HOLD', 'agent identity not verified');
  }
  if (!ctx.credential.valid) {
    push(matches, 'P-SEC-001', 'BLOCK', 'credential expired or revoked');
  } else if (ctx.credential.expiresAt !== undefined && ctx.credential.expiresAt <= ctx.now) {
    push(matches, 'P-SEC-001', 'BLOCK', 'credential expired');
  }
  if (ctx.replayDetected) {
    push(matches, 'P-SEC-003', 'BLOCK', 'replay detected — request already consumed');
  }
  if (ctx.idempotencyDuplicate) {
    push(matches, 'P-SEC-003', 'BLOCK', 'duplicate request under the same idempotency key');
  }
  if (ctx.openCriticalPrivilegeDrift && consequential) {
    push(matches, 'P-SEC-004', 'HOLD', 'unresolved critical privilege drift');
  }
  if (ctx.evidenceInfrastructureOk === false && (ctx.evidenceMandatory !== false) && consequential) {
    push(matches, 'P-GOV-001', 'BLOCK', 'evidence infrastructure unavailable — evidence is mandatory here');
  }
  if (ctx.emergencyDeny) {
    push(matches, 'P-GOV-002', 'BLOCK', 'emergency deny active');
  }
  if (ctx.environment === 'production' && ctx.productionConfigValid === false) {
    push(matches, 'P-GOV-003', 'BLOCK', 'invalid production configuration');
  }
  if (ctx.agentStatus === 'killed') {
    push(matches, 'P-GOV-004', 'BLOCK', 'agent is killed — all actions rejected');
  } else if (ctx.agentStatus === 'suspended') {
    push(matches, 'P-GOV-004', 'BLOCK', 'agent is suspended');
  } else if (ctx.agentStatus === 'quarantined' && !ctx.readOnly) {
    push(matches, 'P-GOV-004', 'QUARANTINE', 'agent is quarantined');
  }

  /* ---- policy engine availability (fail closed by default) ---- */
  if (!engineUp) {
    if (degraded === 'allow-readonly' && ctx.readOnly && ctx.riskTier === 'low') {
      push(matches, 'P-GOV-002', 'ALLOW', 'degraded mode: low-risk read-only allowed by configuration');
    } else {
      push(matches, 'P-GOV-002', consequential ? 'BLOCK' : 'HOLD', 'policy engine unavailable — no valid governance decision');
    }
  }

  /* ---- authorization ---- */
  const cap = ctx.action;
  const approved = ctx.approvedCapabilities.includes(cap);
  const prohibited = ctx.prohibitedCapabilities.includes(cap);

  if (prohibited) {
    push(matches, 'P-CAP-002', 'BLOCK', `capability ${cap} is on the agent's prohibited list`);
  } else if (!approved) {
    // delegation may still authorize a scoped capability
    const delegatedOk =
      ctx.delegation !== undefined &&
      ctx.delegation.delegatedCapability === cap &&
      ctx.delegation.now <= ctx.delegation.expiresAt &&
      !ctx.delegation.loopDetected &&
      ctx.delegation.chainDepth <= ctx.delegation.maxChainDepth;
    if (!delegatedOk) {
      push(matches, 'P-CAP-001', consequential ? 'BLOCK' : 'HOLD', `capability ${cap} is not approved for this agent`);
    }
  }

  /* ---- agent-to-agent delegation ---- */
  if (ctx.delegation) {
    const d = ctx.delegation;
    const broaderThanDelegated =
      ctx.maxAutonomousUsd !== undefined &&
      ctx.amountUsd !== undefined &&
      ctx.amountUsd > 0 &&
      d.delegatedCapability !== cap;
    if (broaderThanDelegated && !approved) {
      push(matches, 'P-DEL-001', 'BLOCK', 'authority cannot expand through delegation');
    }
    if (d.now > d.expiresAt) {
      push(matches, 'P-DEL-002', 'BLOCK', 'delegation TTL expired');
    }
    if (d.loopDetected) {
      push(matches, 'P-DEL-002', 'BLOCK', 'delegation loop detected');
    }
    if (d.chainDepth > d.maxChainDepth) {
      push(matches, 'P-DEL-002', 'BLOCK', `delegation chain depth ${d.chainDepth} exceeds maximum ${d.maxChainDepth}`);
    }
  }

  /* ---- content / modality ---- */
  if (ctx.injectionDetected) {
    push(matches, 'P-INJ-001', 'BLOCK', 'prompt injection detected in content');
  }
  if (ctx.modalityNotAllowed) {
    push(matches, 'P-MOD-001', 'BLOCK', `modality ${ctx.modality} not permitted for this use case`);
  }
  if (consequential && instructionTrustLevel(ctx) === 'untrusted') {
    push(matches, 'P-MOD-002', 'BLOCK', 'untrusted content attempted to direct a consequential action');
  }
  if (ctx.syntheticMediaRisk !== undefined && ctx.syntheticMediaRisk !== 'none' && ctx.identityClaimViaMedia) {
    push(
      matches,
      'P-SYN-001',
      consequential ? 'REQUIRE_APPROVAL' : 'HOLD',
      'synthetic-media identity claim — out-of-band verification required',
    );
  }
  if (ctx.crossModalConflict) {
    push(matches, 'P-XCM-001', 'HOLD', 'cross-modal inconsistency between modalities');
  }

  /* ---- financial limits ---- */
  const amt = ctx.amountUsd;
  if (amt !== undefined && amt > 0) {
    if (ctx.authorityCeilingUsd !== undefined && amt > ctx.authorityCeilingUsd) {
      push(matches, 'P-FIN-001', 'BLOCK', `requested $${fmt(amt)} exceeds the hard authority ceiling $${fmt(ctx.authorityCeilingUsd)}`);
    } else if (ctx.maxAutonomousUsd !== undefined && amt > ctx.maxAutonomousUsd) {
      push(
        matches,
        'P-FIN-001',
        'REQUIRE_APPROVAL',
        `requested $${fmt(amt)} is above the autonomous ceiling $${fmt(ctx.maxAutonomousUsd)} — human approval required`,
      );
      if (ctx.autoApprovalThresholdUsd !== undefined && amt > ctx.autoApprovalThresholdUsd) {
        push(matches, 'P-FIN-002', 'REQUIRE_APPROVAL', `requested $${fmt(amt)} is above the dual-approval threshold $${fmt(ctx.autoApprovalThresholdUsd)}`);
      }
    } else if (ctx.autoApprovalThresholdUsd !== undefined && amt > ctx.autoApprovalThresholdUsd) {
      push(matches, 'P-FIN-002', 'REQUIRE_APPROVAL', `requested $${fmt(amt)} exceeds the auto-approval threshold $${fmt(ctx.autoApprovalThresholdUsd)}`);
    }
    if (ctx.dailyLimitUsd !== undefined) {
      const used = ctx.dailyExecutedUsd ?? 0;
      if (used + amt > ctx.dailyLimitUsd) {
        push(
          matches,
          'P-FIN-003',
          amt > (ctx.autoApprovalThresholdUsd ?? 0) ? 'BLOCK' : 'REQUIRE_APPROVAL',
          `daily exposure $${fmt(used)} + $${fmt(amt)} exceeds limit $${fmt(ctx.dailyLimitUsd)}`,
        );
      }
    }
    if (ctx.maxVelocityPerHour !== undefined) {
      const v = ctx.velocityLastHour ?? 0;
      if (v >= ctx.maxVelocityPerHour) {
        push(matches, 'P-FIN-004', 'BLOCK', `velocity ${v}/h reaches limit ${ctx.maxVelocityPerHour}/h`);
      }
    }
    if (ctx.beneficiary && !ctx.beneficiary.approved) {
      push(matches, 'P-BEN-001', 'BLOCK', 'beneficiary is not on the approved list');
    }
    if (ctx.beneficiary?.crossBorder && !ctx.crossBorderAllowed) {
      push(matches, 'P-GEO-001', 'BLOCK', 'cross-border execution is prohibited');
    }
    if (ctx.instrument && !ctx.instrument.approved) {
      push(matches, 'P-INS-001', 'BLOCK', 'instrument is not approved');
    }
    if (ctx.crossEntity && !ctx.crossEntityAllowed) {
      push(matches, 'P-ENT-001', 'BLOCK', 'cross-entity transfer is prohibited');
    }
  }

  /* ---- approvals ---- */
  if (ctx.approval.state === 'expired') {
    push(matches, 'P-APP-001', 'HOLD', 'approval expired — transaction must be re-approved');
  } else if (ctx.approval.state === 'mutated') {
    push(matches, 'P-APP-001', 'BLOCK', 'transaction changed after approval — approval invalidated');
  }

  /* ---- autonomy level: HUMAN APPROVAL means no autonomous execution ---- */
  if (consequential && ctx.autonomyLevel === 'HUMAN APPROVAL' && ctx.approval.state === 'none') {
    push(matches, 'P-APP-001', 'REQUIRE_APPROVAL', 'agent operates under HUMAN APPROVAL autonomy — human sign-off required');
  }

  /* ---- risk appetite (informational gate for elevated tiers) ---- */
  if (ctx.riskTier === 'critical' && consequential && ctx.autonomyLevel !== 'HUMAN APPROVAL' && ctx.autonomyLevel !== 'PROHIBITED') {
    push(matches, 'P-RSK-001', 'REQUIRE_APPROVAL', 'critical risk tier requires human approval');
  }

  /* ---- resolve ---- */
  let decision: Decision = 'ALLOW';
  let severity = 0;
  for (const m of matches) {
    if (SEVERITY[m.decision] > severity) {
      severity = SEVERITY[m.decision];
      decision = m.decision;
    }
  }
  const matched = matches.filter((m) => m.decision === decision);
  const all = dedupe(matches);
  const reasonCodes = all.length ? all.map((m) => codeFor(m.reason)) : ['ALL_CONTROLS_SATISFIED'];
  const requiredApprover =
    decision === 'REQUIRE_APPROVAL'
      ? (matched[0]?.reason.includes('synthetic-media')
        ? 'Out-of-band verification + human approver'
        : ctx.approval.requiredApprover ?? 'Risk Manager (transaction approver)')
      : undefined;

  const summary =
    decision === 'ALLOW'
      ? 'All mandatory controls evaluated and satisfied.'
      : matched.map((m) => `${m.policy.id}: ${m.reason}`).join(' · ');

  return {
    decision,
    policyIds: all.map((m) => m.policy.id),
    policyVersions: all.map((m) => `${m.policy.id}@${m.policy.version}`),
    reasonCodes,
    riskSeverity:
      decision === 'BLOCK' && consequential
        ? 'critical'
        : SEVERITY_LABEL[decision],
    requiredApprover,
    decisionExpiryMs: decision === 'REQUIRE_APPROVAL' ? 15 * 60_000 : undefined,
    latencyMs: Math.max(1, Date.now() - started + 3),
    evaluatedAt: ctx.now,
    failClosed: severity > 0 && decision !== 'ALLOW',
    summary,
  };
}

function instructionTrustLevel(ctx: EvaluationContext): string {
  if (ctx.contentClass === 'System Instruction' || ctx.contentClass === 'Enterprise Policy') return 'trusted';
  if (ctx.contentClass === 'External Content' || ctx.contentClass === 'Retrieved Context' || ctx.contentClass === 'Tool Result') {
    return ctx.sourceTrust === 'trusted' || ctx.sourceTrust === 'internal' ? 'internal' : 'untrusted';
  }
  return ctx.sourceTrust === 'untrusted' || ctx.sourceTrust === 'unknown' ? 'untrusted' : 'internal';
}

function codeFor(reason: string): string {
  const map: Array<[RegExp, string]> = [
    [/tenant context/i, 'TENANT_INVALID'],
    [/identity not verified/i, 'IDENTITY_UNVERIFIED'],
    [/credential/i, 'CREDENTIAL_INVALID'],
    [/replay/i, 'REPLAY_DETECTED'],
    [/duplicate request/i, 'IDEMPOTENCY_DUPLICATE'],
    [/privilege drift/i, 'PRIVILEGE_DRIFT_OPEN'],
    [/evidence infrastructure/i, 'EVIDENCE_UNAVAILABLE'],
    [/emergency deny/i, 'EMERGENCY_DENY'],
    [/production configuration/i, 'INVALID_PRODUCTION_CONFIG'],
    [/killed/i, 'AGENT_KILLED'],
    [/suspended/i, 'AGENT_SUSPENDED'],
    [/quarantined/i, 'AGENT_QUARANTINED'],
    [/degraded mode/i, 'DEGRADED_READ_ALLOWED'],
    [/policy engine unavailable/i, 'POLICY_ENGINE_UNAVAILABLE'],
    [/prohibited list/i, 'CAPABILITY_PROHIBITED'],
    [/not approved for this agent/i, 'CAPABILITY_NOT_APPROVED'],
    [/expand through delegation/i, 'AUTHORITY_EXPANSION'],
    [/TTL/i, 'DELEGATION_EXPIRED'],
    [/loop/i, 'DELEGATION_LOOP'],
    [/chain depth/i, 'DELEGATION_DEPTH'],
    [/prompt injection/i, 'PROMPT_INJECTION_DETECTED'],
    [/not permitted for this use case/i, 'MODALITY_NOT_PERMITTED'],
    [/untrusted content/i, 'UNTRUSTED_CONTENT_INSTRUCTION'],
    [/synthetic-media/i, 'SYNTHETIC_IDENTITY_CLAIM'],
    [/cross-modal/i, 'CROSS_MODAL_CONFLICT'],
    [/hard authority ceiling/i, 'AUTHORITY_CEILING_EXCEEDED'],
    [/above the autonomous ceiling/i, 'ABOVE_AUTONOMOUS_CEILING'],
    [/autonomous ceiling/i, 'ABOVE_AUTONOMOUS_CEILING'],
    [/auto-approval threshold/i, 'ABOVE_AUTO_THRESHOLD'],
    [/daily exposure/i, 'DAILY_EXPOSURE_EXCEEDED'],
    [/velocity/i, 'VELOCITY_LIMIT'],
    [/beneficiary/i, 'BENEFICIARY_NOT_APPROVED'],
    [/cross-border/i, 'CROSS_BORDER_PROHIBITED'],
    [/instrument/i, 'INSTRUMENT_NOT_APPROVED'],
    [/cross-entity/i, 'CROSS_ENTITY_PROHIBITED'],
    [/approval expired/i, 'APPROVAL_EXPIRED'],
    [/changed after approval/i, 'APPROVAL_MUTATED'],
    [/critical risk tier/i, 'RISK_TIER_APPROVAL_REQUIRED'],
  ];
  for (const [re, code] of map) if (re.test(reason)) return code;
  return 'POLICY_MATCH';
}

function dedupe(matches: Match[]): Match[] {
  const seen = new Set<string>();
  return matches.filter((m) => {
    const k = `${m.policy.id}|${m.reason}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function fmt(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

/** Consequential = a write/action that is hard to undo or moves value. */
export function isConsequential(ctx: EvaluationContext): boolean {
  return consequence(ctx);
}