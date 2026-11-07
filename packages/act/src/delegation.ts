/**
 * Agent-to-agent delegation governance.
 * Rule: AUTHORITY CANNOT EXPAND THROUGH DELEGATION.
 */

import type { AgentPassport, DelegationContext } from './types.ts';

export interface DelegationRequest {
  originatingAgent: string;
  receivingAgent: string;
  scope: string;
  requestedCapability: string;
  dataShared: string[];
  purpose: string;
  ttlMs: number;
  chain: string[]; // agent ids from root to receiver
  now: number;
}

export const MAX_CHAIN_DEPTH = 3;

export interface DelegationVerdict {
  allowed: boolean;
  delegatedCapability: string;
  chainDepth: number;
  reasons: string[];
  effectiveScope: string;
}

/**
 * A delegation may only NARROW authority: the receiver gets a subset of the
 * delegating agent's approved capabilities, capped by the receiver's own
 * passport, with a TTL and a hard chain-depth limit.
 */
export function authorizeDelegation(
  req: DelegationRequest,
  delegator: AgentPassport,
  receiver: AgentPassport,
): DelegationVerdict {
  const reasons: string[] = [];
  const chainDepth = Math.max(0, req.chain.length - 1);

  const scopeSet = new Set(
    delegator.approvedCapabilities.filter((c) => !delegator.prohibitedCapabilities.includes(c)),
  );
  const requested = req.requestedCapability;
  const receiverAllows = receiver.approvedCapabilities.includes(requested);

  if (delegator.status !== 'active') reasons.push(`delegating agent is ${delegator.status}`);
  if (receiver.status !== 'active') reasons.push(`receiving agent is ${receiver.status}`);
  if (!scopeSet.has(requested)) {
    reasons.push(`delegating agent does not hold ${requested} — delegation cannot grant what it does not have`);
  }
  if (!receiverAllows) {
    reasons.push(`receiving agent's passport does not approve ${requested}`);
  }
  if (req.chain.filter((a, i) => req.chain.indexOf(a) !== i).length > 0) {
    reasons.push('delegation loop detected in chain');
  }
  if (chainDepth > MAX_CHAIN_DEPTH) {
    reasons.push(`chain depth ${chainDepth} exceeds maximum ${MAX_CHAIN_DEPTH}`);
  }
  if (req.ttlMs <= 0 || req.ttlMs > 24 * 3600_000) {
    reasons.push('delegation TTL must be > 0 and ≤ 24h');
  }
  if (delegator.prohibitedCapabilities.includes(requested)) {
    reasons.push(`${requested} is prohibited for the delegating agent`);
  }

  const effectiveScope = reasons.length
    ? 'none — delegation denied'
    : `subset of ${delegator.name} ∩ ${receiver.name}: ${requested}`;

  return {
    allowed: reasons.length === 0,
    delegatedCapability: reasons.length ? '' : requested,
    chainDepth,
    reasons,
    effectiveScope,
  };
}

/** Build the runtime delegation context used by the policy engine. */
export function delegationContext(
  req: DelegationRequest,
  verdict: DelegationVerdict,
  now: number,
): DelegationContext {
  return {
    originatingAgent: req.originatingAgent,
    receivingAgent: req.receivingAgent,
    scope: req.scope,
    delegatedCapability: verdict.allowed ? verdict.delegatedCapability : '',
    chainDepth: verdict.chainDepth,
    maxChainDepth: MAX_CHAIN_DEPTH,
    loopDetected: req.chain.filter((a, i) => req.chain.indexOf(a) !== i).length > 0,
    expiresAt: req.now + req.ttlMs,
    now,
  };
}