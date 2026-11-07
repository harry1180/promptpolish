/**
 * Blast radius: maximum plausible impact an agent can create before
 * intervention. Computed from the passport + runtime usage, then ENFORCED
 * (`checkBlastRadius`) by the runtime gateway — it is never a dashboard-only
 * number.
 */

import type { AgentPassport, BlastDimension, BlastRadius, EvaluationContext } from './types.ts';

type Level = BlastRadius['overall'];

const RANK: Record<Level, number> = { LOW: 0, MODERATE: 1, HIGH: 2, CRITICAL: 3 };

function levelForUsd(usd: number | undefined): Level {
  if (usd === undefined || usd <= 0) return 'LOW';
  if (usd <= 10_000) return 'LOW';
  if (usd <= 100_000) return 'MODERATE';
  if (usd <= 1_000_000) return 'HIGH';
  return 'CRITICAL';
}

function dim(d: BlastDimension, level: Level, value: string, explanation: string) {
  return { dimension: d, level, value, explanation };
}

/**
 * Compute the blast radius for an agent (and optional pending request).
 * `dailyExecutedUsd` folds in what has already happened today.
 */
export function computeBlastRadius(
  agent: AgentPassport,
  opts: { dailyExecutedUsd?: number; requestedUsd?: number; chainAgents?: number } = {},
): BlastRadius {
  const dailyUsed = opts.dailyExecutedUsd ?? 0;
  const pending = opts.requestedUsd ?? 0;
  const dailyCap = agent.dailyLimitUsd ?? agent.blastRadiusUsd ?? 0;
  const financialUsd = dailyCap;
  const velocity = agent.velocityPerHour ?? 0;

  const dims = [
    dim(
      'financial',
      levelForUsd(dailyCap),
      dailyCap ? `$${dailyCap.toLocaleString('en-US')} / day` : 'no financial capability',
      dailyCap
        ? `Autonomous writes capped at $${(agent.execution?.[0]?.maxAutonomousUsd ?? 0).toLocaleString('en-US')} per transaction and $${dailyCap.toLocaleString('en-US')} per day; today $${dailyUsed.toLocaleString('en-US')} executed${pending ? `, $${pending.toLocaleString('en-US')} pending` : ''}.`
        : 'Agent holds no capability that moves value.',
    ),
    dim(
      'customer',
      agent.dataClassification === 'regulated' || agent.dataClassification === 'restricted' ? 'HIGH' : agent.businessFunction.toLowerCase().includes('customer') ? 'MODERATE' : 'LOW',
      `${agent.dataClassification} data`,
      `Business function "${agent.businessFunction}" touches ${agent.dataClassification} customer data.`,
    ),
    dim(
      'data',
      agent.dataClassification === 'regulated' ? 'CRITICAL' : agent.dataClassification === 'restricted' ? 'HIGH' : agent.dataClassification === 'confidential' ? 'MODERATE' : 'LOW',
      agent.dataClassification,
      `Connected systems: ${agent.connectedSystems.join(', ') || 'none'}.`,
    ),
    dim(
      'system',
      agent.connectedSystems.length >= 4 ? 'HIGH' : agent.connectedSystems.length >= 2 ? 'MODERATE' : 'LOW',
      `${agent.connectedSystems.length} connected system(s)`,
      agent.connectedSystems.length ? `Can reach ${agent.connectedSystems.join(', ')}.` : 'No enterprise connectors.',
    ),
    dim(
      'velocity',
      velocity >= 8 ? 'CRITICAL' : velocity >= 4 ? 'HIGH' : velocity >= 2 ? 'MODERATE' : 'LOW',
      velocity ? `${velocity} actions/hour` : 'n/a',
      velocity ? `Rate-limited at ${velocity} consequential actions per hour.` : 'No consequential rate.',
    ),
    dim(
      'privilege',
      agent.prohibitedCapabilities.length >= 4 && (agent.driftedCapabilities ?? []).length === 0 ? 'MODERATE' : (agent.driftedCapabilities ?? []).length > 0 ? 'HIGH' : 'MODERATE',
      `${agent.effectiveCapabilities.length} effective / ${agent.approvedCapabilities.length} approved`,
      (agent.driftedCapabilities ?? []).length
        ? `${(agent.driftedCapabilities ?? []).length} capability/ies beyond approval — privilege drift open.`
        : 'Effective permissions match approved permissions.',
    ),
    dim(
      'reversibility',
      agent.autonomyLevel === 'READ ONLY' ? 'LOW' : agent.autonomyLevel === 'BOUND AUTONOMY' ? 'MODERATE' : 'HIGH',
      agent.autonomyLevel,
      agent.autonomyLevel === 'READ ONLY' ? 'Actions are reads — no state change.' : 'Writes require reversal runbooks.',
    ),
    dim(
      'chain',
      levelForUsd(dailyCap),
      `${opts.chainAgents ?? 1} agent(s) in chain`,
      'Delegation depth is capped and cannot expand authority; downstream agents inherit a narrower scope.',
    ),
    dim(
      'reputation',
      agent.riskTier === 'critical' ? 'HIGH' : agent.riskTier === 'high' ? 'MODERATE' : 'LOW',
      `${agent.riskTier} risk tier`,
      agent.modalities.some((m) => m === 'VOICE' || m === 'VIDEO' || m === 'LIVE VIDEO')
        ? 'Customer-facing voice/video interaction can reach the public narrative.'
        : 'Internal-facing activity only.',
    ),
    dim(
      'jurisdiction',
      agent.crossBorderAllowed ? 'HIGH' : 'LOW',
      agent.crossBorderAllowed ? 'cross-border allowed' : 'cross-border prohibited',
      agent.crossBorderAllowed
        ? 'Policy permits cross-border execution — local regulation must be evaluated per transaction.'
        : 'P-geo-001 blocks cross-border execution.',
    ),
  ];

  const overall = dims.reduce<Level>((acc, d) => (RANK[d.level] > RANK[acc] ? d.level : acc), 'LOW');
  return {
    overall,
    dimensions: dims,
    financialUsd,
    explanation:
      `Highest single dimension drives the classification (${overall}). ` +
      `Financial exposure ${dailyCap ? `$${dailyCap.toLocaleString('en-US')}/day` : 'none'}, ` +
      `velocity ${velocity || 0}/h, ${agent.killEnabled ? 'kill switch enabled' : 'NO KILL SWITCH'}.`,
  };
}

export interface BlastBreach {
  code: string;
  detail: string;
}

/**
 * ENFORCEMENT: returns every limit the request would break. The gateway turns
 * any breach into REQUIRE_APPROVAL/BLOCK — the number is never advisory.
 */
export function checkBlastRadius(
  agent: AgentPassport,
  request: { amountUsd?: number; velocityLastHour?: number; dailyExecutedUsd?: number },
): { ok: boolean; breaches: BlastBreach[]; remainingTodayUsd: number } {
  const breaches: BlastBreach[] = [];
  const used = request.dailyExecutedUsd ?? 0;
  const cap = agent.dailyLimitUsd;
  const amt = request.amountUsd ?? 0;

  if (amt > 0 && agent.execution?.some((e) => e.maxAutonomousUsd !== undefined && amt > e.maxAutonomousUsd)) {
    const ceiling = Math.max(...agent.execution.map((e) => e.maxAutonomousUsd ?? 0));
    breaches.push({ code: 'PER_TRANSACTION_LIMIT', detail: `$${amt.toLocaleString('en-US')} exceeds per-transaction autonomous ceiling $${ceiling.toLocaleString('en-US')}` });
  }
  if (cap !== undefined && amt > 0 && used + amt > cap) {
    breaches.push({ code: 'DAILY_EXPOSURE', detail: `$${used.toLocaleString('en-US')} already executed today; adding $${amt.toLocaleString('en-US')} would exceed the $${cap.toLocaleString('en-US')} daily limit` });
  }
  if (agent.velocityPerHour !== undefined && request.velocityLastHour !== undefined && request.velocityLastHour >= agent.velocityPerHour) {
    breaches.push({ code: 'VELOCITY', detail: `${request.velocityLastHour} actions in the last hour meets the ${agent.velocityPerHour}/hour limit` });
  }

  return {
    ok: breaches.length === 0,
    breaches,
    remainingTodayUsd: Math.max(0, (cap ?? 0) - used),
  };
}

/** Context fields the gateway must inject for blast-radius enforcement. */
export function blastContextFields(
  agent: AgentPassport,
  request: { amountUsd?: number; velocityLastHour?: number; dailyExecutedUsd?: number },
): Pick<EvaluationContext, 'maxAutonomousUsd' | 'authorityCeilingUsd' | 'autoApprovalThresholdUsd' | 'dailyLimitUsd' | 'dailyExecutedUsd' | 'maxVelocityPerHour' | 'velocityLastHour'> {
  const exec = agent.execution?.[0];
  return {
    maxAutonomousUsd: exec?.maxAutonomousUsd,
    authorityCeilingUsd: exec?.authorityCeilingUsd,
    autoApprovalThresholdUsd: exec?.autoApprovalThresholdUsd,
    dailyLimitUsd: agent.dailyLimitUsd,
    dailyExecutedUsd: request.dailyExecutedUsd ?? 0,
    maxVelocityPerHour: agent.velocityPerHour,
    velocityLastHour: request.velocityLastHour ?? 0,
  };
}