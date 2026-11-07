/**
 * Agent Control Tower — domain types.
 *
 * Everything in this package is deterministic and side-effect free: the same
 * context always produces the same governance decision. Authoritative
 * ALLOW/BLOCK never comes from a model; it comes from `policy.ts`.
 */

export type ActMode = 'demo' | 'production';

export type Decision =
  | 'ALLOW'
  | 'HOLD'
  | 'REQUIRE_APPROVAL'
  | 'BLOCK'
  | 'QUARANTINE';

export type RiskTier = 'low' | 'moderate' | 'high' | 'critical';
export type RiskSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';

export type AutonomyLevel =
  | 'READ ONLY'
  | 'BOUND AUTONOMY'
  | 'HUMAN APPROVAL'
  | 'PROHIBITED';

export type ModalityClass =
  | 'TEXT'
  | 'DOCUMENT'
  | 'IMAGE'
  | 'AUDIO'
  | 'VOICE'
  | 'VIDEO'
  | 'LIVE VIDEO'
  | 'MULTIMODAL'
  | 'CODE'
  | 'STRUCTURED DATA'
  | 'EXTERNAL WEB CONTENT'
  | 'TOOL OUTPUT'
  | 'AGENT MESSAGE';

export type TrustLevel = 'trusted' | 'internal' | 'external' | 'unknown' | 'untrusted';
export type ProvenanceState = 'valid' | 'invalid' | 'absent' | 'unknown' | 'partial';
export type IntegrityState = 'verified' | 'changed' | 'unknown' | 'broken';
export type Sensitivity = 'public' | 'internal' | 'confidential' | 'restricted' | 'regulated';
export type DisclosureState =
  | 'Required'
  | 'Applied'
  | 'Not Required'
  | 'Exception Approved'
  | 'Unknown / Review Needed';

/** Content classification for instruction hierarchy (§21). */
export type ContentClass =
  | 'User Instruction'
  | 'System Instruction'
  | 'Enterprise Policy'
  | 'Retrieved Context'
  | 'External Content'
  | 'Tool Result'
  | 'Agent Message';

export interface DelegationContext {
  originatingAgent: string;
  receivingAgent: string;
  scope: string;
  /** capability the receiving agent is allowed to exercise under this delegation */
  delegatedCapability: string;
  chainDepth: number;
  maxChainDepth: number;
  loopDetected: boolean;
  expiresAt: number;
  now: number;
}

export interface ApprovalState {
  /** 'none' | 'valid' | 'expired' | 'mutated' — mutated = tx fields changed after approval */
  state: 'none' | 'valid' | 'expired' | 'mutated';
  approver?: string;
  requiredApprover?: string;
  bindingHash?: string;
}

export interface CredentialState {
  valid: boolean;
  expiresAt?: number;
}

export interface EvaluationContext {
  /* identity & tenancy */
  tenant: string;
  environment: ActMode;
  agentId: string;
  workloadId?: string;
  agentVersion: string;
  authorityProfileVersion: string;
  delegatingService?: string;
  humanDelegator?: string;
  identityVerified: boolean;
  tenantValid: boolean;
  credential: CredentialState;
  /** agent status per registry: active | suspended | killed | quarantined */
  agentStatus: 'active' | 'suspended' | 'killed' | 'quarantined';

  /* request */
  action: string; // capability being requested, e.g. 'transfer:execute'
  tool?: string;
  targetSystem?: string;
  amountUsd?: number;
  beneficiary?: { id: string; approved: boolean; crossBorder?: boolean };
  instrument?: { id: string; approved: boolean };
  crossEntity?: boolean;
  customerImpact?: number;
  dataSensitivity?: Sensitivity;
  jurisdiction?: string;
  confidence?: number;

  /* modality / content */
  modality: ModalityClass;
  sourceTrust: TrustLevel;
  provenance: ProvenanceState;
  contentClass: ContentClass;
  /** true when injection controls found instructions hidden in the content */
  injectionDetected?: boolean;
  /** set by the modality gateway when this modality is not allowed for the use case */
  modalityNotAllowed?: boolean;
  crossBorderAllowed?: boolean;
  crossEntityAllowed?: boolean;
  syntheticMediaRisk?: 'none' | 'elevated' | 'high';
  /** whether a human is claiming to be an executive/authority via media */
  identityClaimViaMedia?: boolean;
  crossModalConflict?: boolean;

  /* runtime state */
  riskTier: RiskTier;
  autonomyLevel: AutonomyLevel;
  approvedCapabilities: string[];
  prohibitedCapabilities: string[];
  maxAutonomousUsd?: number;
  /** hard authority ceiling: above this the action is prohibited outright */
  authorityCeilingUsd?: number;
  autoApprovalThresholdUsd?: number;
  dailyLimitUsd?: number;
  dailyExecutedUsd?: number;
  maxVelocityPerHour?: number;
  velocityLastHour?: number;
  reversible: boolean;
  readOnly: boolean;
  approval: ApprovalState;
  emergencyDeny?: boolean;
  openCriticalPrivilegeDrift?: boolean;
  policyEngineAvailable?: boolean;
  evidenceInfrastructureOk?: boolean;
  evidenceMandatory?: boolean;
  productionConfigValid?: boolean;
  replayDetected?: boolean;
  idempotencyDuplicate?: boolean;
  delegation?: DelegationContext;
  /** policy for degraded operation when the policy engine is unavailable */
  degradedPolicy?: 'deny' | 'allow-readonly';
  now: number;
}

export interface GovernanceDecision {
  decision: Decision;
  policyIds: string[];
  policyVersions: string[];
  reasonCodes: string[];
  riskSeverity: RiskSeverity;
  requiredApprover?: string;
  decisionExpiryMs?: number;
  latencyMs: number;
  evaluatedAt: number;
  failClosed: boolean;
  summary: string;
}

export interface PolicyDef {
  id: string;
  name: string;
  version: string;
  priority: number;
  /** maps to the control topic shown in Policy Studio */
  topic: string;
}

/* ---------------- agent registry / passport ---------------- */

export interface AgentPassport {
  agentId: string;
  name: string;
  businessFunction: string;
  businessOwner: string;
  technicalOwner: string;
  riskOwner: string;
  environment: 'Production' | 'Pre-Production' | 'Development' | 'Sandbox';
  framework: string;
  provider: string;
  model: string;
  modelVersion: string;
  agentVersion: string;
  status: 'active' | 'suspended' | 'killed' | 'quarantined';
  riskTier: RiskTier;
  autonomyLevel: AutonomyLevel;
  modalities: ModalityClass[];
  dataClassification: Sensitivity;
  connectedSystems: string[];
  approvedCapabilities: string[];
  effectiveCapabilities: string[];
  /** capabilities granted at runtime beyond approval → privilege drift */
  driftedCapabilities?: string[];
  execution?: Array<{ capability: string; maxAutonomousUsd?: number; autoApprovalThresholdUsd?: number; authorityCeilingUsd?: number }>;
  humanApproval?: Array<{ capability: string; fromUsd: number; toUsd: number }>;
  prohibitedCapabilities: string[];
  dailyLimitUsd?: number;
  velocityPerHour?: number;
  credentialType: string;
  credentialExpiry: number; // epoch ms
  lastReview: number;
  nextReview: number;
  blastRadiusUsd?: number;
  killEnabled: boolean;
  ownerActive: boolean;
  approvedBeneficiaries?: string[];
  approvedInstruments?: string[];
  crossBorderAllowed?: boolean;
  crossEntityAllowed?: boolean;
}

/* ---------------- evidence ---------------- */

export interface EvidenceRecord {
  seq: number;
  ts: number;
  type: string;
  tenant: string;
  environment: ActMode;
  payload: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

/* ---------------- governance score ---------------- */

export interface ScoreComponent {
  key: string;
  label: string;
  weight: number;
  achieved: number;
  inputs: string[];
  notes?: string;
}

export interface GovernanceScore {
  score: number;
  classification: string;
  methodologyVersion: string;
  formulaVersion: string;
  computedAt: number;
  components: ScoreComponent[];
  exceptions: Array<{ id: string; note: string; expiresAt?: number }>;
  evidenceRefs: string[];
  disclaimer: string;
}

/* ---------------- blast radius ---------------- */

export type BlastDimension =
  | 'financial'
  | 'customer'
  | 'data'
  | 'system'
  | 'velocity'
  | 'privilege'
  | 'reversibility'
  | 'chain'
  | 'reputation'
  | 'jurisdiction';

export interface BlastRadius {
  overall: 'LOW' | 'MODERATE' | 'HIGH' | 'CRITICAL';
  dimensions: Array<{
    dimension: BlastDimension;
    level: 'LOW' | 'MODERATE' | 'HIGH' | 'CRITICAL';
    value: string;
    explanation: string;
  }>;
  explanation: string;
  financialUsd: number;
}

/* ---------------- modality gateway ---------------- */

export interface ModalityFinding {
  code: string;
  label: string;
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  detail: string;
}

export interface ContentItem {
  contentId: string;
  modality: ModalityClass;
  source: string;
  trust: TrustLevel;
  owner: string;
  ts: number;
  integrity: IntegrityState;
  provenance: ProvenanceState;
  sensitivity: Sensitivity;
  injectionRisk: 'none' | 'possible' | 'detected';
  syntheticMediaState: 'not-applicable' | 'clean' | 'possible' | 'detected';
  policyState: 'pass' | 'review' | 'block';
  contentClass: ContentClass;
  /** raw text (or OCR/transcript extract) that injection controls scan */
  text?: string;
  disclosures?: DisclosureState;
}

export interface ModalityReport {
  item: ContentItem;
  findings: ModalityFinding[];
  instructionTrust: TrustLevel;
  mayInstruct: boolean;
  verdict: 'PASS' | 'REVIEW' | 'BLOCK';
}

export interface ScenarioMeta {
  id: string;
  title: string;
  group: 'storyline' | 'lab';
  channel: 'core' | 'injection' | 'synthetic' | 'multimodal' | 'framework';
  summary: string;
}

/* ---------------- demo runtime events (server appends, package derives) ---------------- */

export interface ActEvent {
  seq: number;
  ts: number;
  type:
    | 'decision'
    | 'approval.granted'
    | 'approval.rejected'
    | 'execution.simulated'
    | 'incident.opened'
    | 'incident.closed'
    | 'drift.detected'
    | 'drift.restored'
    | 'orphan.suspended'
    | 'orphan.reassigned'
    | 'agent.killed'
    | 'agent.revived'
    | 'scenario.run'
    | 'policy.publish'
    | 'exposure.blocked'
    | 'delegation.blocked'
    | 'velocity.tick'
    | 'evidence.exported';
  payload: Record<string, unknown>;
}