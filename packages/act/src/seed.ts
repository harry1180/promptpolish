/**
 * Deterministic DEMO seed — synthetic customers, agents, transactions,
 * policies and scenarios. No real customer data, no real financial execution,
 * no production connectors. Every dashboard number is CALCULATED from this seed
 * (plus live demo events); nothing is hard-coded into UI components.
 *
 * All timestamps derive from `now`, so the demo never goes stale.
 */

import type {
  AgentPassport, AutonomyLevel, ModalityClass, RiskTier, Sensitivity,
} from './types.ts';

export const SEED_VERSION = 'act-demo-seed-1.0.0';
export const TENANT = 'demo-synthetic-001';

const DAY = 86_400_000;

type AgentTuple = [
  id: string,
  name: string,
  fn: string,
  bo: string,
  to: string,
  ro: string,
  env: AgentPassport['environment'],
  fw: string,
  prov: string,
  model: string,
  risk: RiskTier,
  autonomy: AutonomyLevel,
  mods: ModalityClass[],
  cls: Sensitivity,
  systems: string[],
];

const TUPLES: AgentTuple[] = [
  ['treasury-07', 'Treasury-07', 'Global Treasury', 'Global Treasury', 'AI Platform', 'Operational Risk', 'Production', 'LangGraph', 'Azure OpenAI', 'gpt-4.1', 'high', 'BOUND AUTONOMY', ['TEXT', 'DOCUMENT', 'STRUCTURED DATA'], 'regulated', ['payment-hub', 'swift-adapter', 'treasury-ledger', 'reference-data']],
  ['reconcile-14', 'Reconcile-14', 'Finance Operations', 'Finance Ops', 'AI Platform', 'Operational Risk', 'Production', 'Custom worker', 'Azure OpenAI', 'gpt-4.1-mini', 'low', 'BOUND AUTONOMY', ['TEXT', 'STRUCTURED DATA'], 'confidential', ['erp-gl', 'bank-portal']],
  ['research-12', 'Research-12', 'Market Research', 'Corporate Strategy', 'AI Platform', 'Market Risk', 'Production', 'LangGraph', 'Anthropic', 'claude-sonnet-4', 'moderate', 'HUMAN APPROVAL', ['TEXT', 'DOCUMENT', 'EXTERNAL WEB CONTENT'], 'internal', ['market-data-api', 'web-ingest']],
  ['market-research-02', 'Market-Research-02', 'Market Research', 'Corporate Strategy', 'AI Platform', 'Market Risk', 'Production', 'AutoGen', 'OpenAI', 'gpt-4o', 'moderate', 'BOUND AUTONOMY', ['TEXT', 'EXTERNAL WEB CONTENT'], 'internal', ['market-data-api', 'web-ingest']],
  ['credit-exp-04', 'Credit-Experimental-04', 'Credit Analytics', 'Credit Risk', 'AI Platform', 'Credit Risk', 'Pre-Production', 'LangChain', 'OpenAI', 'gpt-4o-mini', 'high', 'HUMAN APPROVAL', ['TEXT', 'DOCUMENT'], 'restricted', ['credit-bureau', 'loan-origination']],
  ['customer-voice-01', 'Customer-Voice-01', 'Customer Service', 'Contact Centre', 'Voice Platform', 'Operational Risk', 'Production', 'Voice pipeline', 'ElevenLabs + ASR', 'voice-realtime-v2', 'high', 'BOUND AUTONOMY', ['VOICE', 'AUDIO', 'TEXT'], 'regulated', ['crm', 'core-banking-readonly']],
  ['collections-voice-03', 'Collections-Voice-03', 'Collections', 'Collections', 'Voice Platform', 'Conduct Risk', 'Production', 'Voice pipeline', 'Cartesia', 'voice-collections-v1', 'high', 'HUMAN APPROVAL', ['VOICE', 'AUDIO'], 'regulated', ['collections-crm']],
  ['claims-doc-05', 'Claims-Document-05', 'Insurance Claims', 'Claims', 'AI Platform', 'Insurance Risk', 'Production', 'Batch worker', 'Azure OpenAI', 'gpt-4.1', 'moderate', 'HUMAN APPROVAL', ['DOCUMENT', 'IMAGE', 'TEXT'], 'restricted', ['claims-core', 'dms']],
  ['fraud-screen-09', 'Fraud-Screen-09', 'Financial Crime', 'Financial Crime', 'AI Platform', 'Financial Crime', 'Production', 'Streaming worker', 'AWS Bedrock', 'claude-haiku', 'critical', 'HUMAN APPROVAL', ['TEXT', 'STRUCTURED DATA'], 'regulated', ['fraud-engine', 'case-management']],
  ['kyc-extract-11', 'KYC-Extract-11', 'Onboarding', 'KYC Operations', 'AI Platform', 'Financial Crime', 'Production', 'Batch worker', 'Azure OpenAI', 'gpt-4.1-mini', 'high', 'HUMAN APPROVAL', ['DOCUMENT', 'IMAGE', 'TEXT'], 'regulated', ['kyc-platform', 'id-verification']],
  ['marketing-video-08', 'Marketing-Video-08', 'Marketing', 'Brand', 'Media Studio', 'Brand Risk', 'Production', 'Media pipeline', 'Runway + ElevenLabs', 'gen-video-v3', 'moderate', 'HUMAN APPROVAL', ['VIDEO', 'IMAGE', 'AUDIO'], 'internal', ['dam', 'cms-publish']],
  ['support-chat-06', 'Support-Chat-06', 'Customer Service', 'Contact Centre', 'AI Platform', 'Operational Risk', 'Pre-Production', 'Custom worker', 'Anthropic', 'claude-haiku-4', 'moderate', 'HUMAN APPROVAL', ['TEXT'], 'confidential', ['crm', 'kb']],
  ['code-review-10', 'Code-Review-10', 'Engineering', 'Developer Experience', 'AI Platform', 'Engineering Risk', 'Pre-Production', 'CI hook', 'Anthropic', 'claude-sonnet-4', 'moderate', 'READ ONLY', ['CODE', 'TEXT'], 'internal', ['github', 'ci-pipeline']],
  ['trade-surv-13', 'Trade-Surveillance-13', 'Market Surveillance', 'Compliance', 'AI Platform', 'Compliance Risk', 'Production', 'Streaming worker', 'AWS Bedrock', 'gpt-4o', 'critical', 'HUMAN APPROVAL', ['TEXT', 'STRUCTURED DATA'], 'regulated', ['order-gateway', 'surveillance-case-mgmt']],
  ['liquidity-15', 'Liquidity-Forecast-15', 'Global Treasury', 'Global Treasury', 'AI Platform', 'Operational Risk', 'Production', 'Batch worker', 'Azure OpenAI', 'gpt-4.1', 'high', 'BOUND AUTONOMY', ['TEXT', 'STRUCTURED DATA'], 'restricted', ['treasury-ledger', 'alma-risk']],
  ['invoice-match-16', 'Invoice-Match-16', 'Finance Operations', 'Accounts Payable', 'AI Platform', 'Operational Risk', 'Production', 'Batch worker', 'Azure OpenAI', 'gpt-4.1-mini', 'moderate', 'BOUND AUTONOMY', ['DOCUMENT', 'IMAGE'], 'confidential', ['erp-ap', 'supplier-master']],
  ['sanctions-17', 'Sanctions-Screen-17', 'Financial Crime', 'Sanctions', 'AI Platform', 'Financial Crime', 'Production', 'Batch worker', 'AWS Bedrock', 'claude-sonnet-4', 'critical', 'HUMAN APPROVAL', ['TEXT', 'DOCUMENT'], 'regulated', ['screening-engine', 'case-management']],
  ['underwriting-18', 'Underwriting-Assist-18', 'Insurance Underwriting', 'Underwriting', 'AI Platform', 'Insurance Risk', 'Production', 'Custom worker', 'Azure OpenAI', 'gpt-4.1', 'high', 'HUMAN APPROVAL', ['TEXT', 'DOCUMENT'], 'restricted', ['policy-admin', 'pricing-engine']],
  ['compliance-19', 'Compliance-Summary-19', 'Compliance', 'Regulatory Affairs', 'AI Platform', 'Compliance Risk', 'Pre-Production', 'Batch worker', 'Anthropic', 'claude-sonnet-4', 'moderate', 'READ ONLY', ['TEXT', 'DOCUMENT'], 'confidential', ['reg-library', 'kb']],
  ['contract-20', 'Contract-Analyzer-20', 'Legal', 'Legal Ops', 'AI Platform', 'Legal Risk', 'Pre-Production', 'Batch worker', 'Azure OpenAI', 'gpt-4.1', 'moderate', 'READ ONLY', ['DOCUMENT', 'TEXT'], 'confidential', ['clm', 'dms']],
  ['minutes-21', 'Meeting-Minutes-21', 'Executive Office', 'Executive Office', 'Media Studio', 'Operational Risk', 'Pre-Production', 'Live pipeline', 'Deepgram + Azure OpenAI', 'nova-3', 'moderate', 'READ ONLY', ['LIVE VIDEO', 'AUDIO', 'VIDEO', 'TEXT'], 'confidential', ['meetings', 'dms']],
  ['supplier-22', 'Supplier-Risk-22', 'Procurement', 'Procurement', 'AI Platform', 'Operational Risk', 'Production', 'Batch worker', 'Azure OpenAI', 'gpt-4.1-mini', 'moderate', 'HUMAN APPROVAL', ['TEXT', 'DOCUMENT', 'EXTERNAL WEB CONTENT'], 'confidential', ['supplier-master', 'web-ingest']],
  ['portfolio-24', 'Portfolio-Alert-24', 'Investments', 'Asset Management', 'AI Platform', 'Market Risk', 'Pre-Production', 'Streaming worker', 'OpenAI', 'gpt-4o', 'high', 'HUMAN APPROVAL', ['TEXT', 'STRUCTURED DATA'], 'restricted', ['portfolio-api']],
  ['aml-triage-24', 'AML-Case-Triage-24', 'Financial Crime', 'AML Operations', 'AI Platform', 'Financial Crime', 'Production', 'Custom worker', 'AWS Bedrock', 'claude-haiku', 'critical', 'HUMAN APPROVAL', ['TEXT', 'DOCUMENT'], 'regulated', ['aml-case-mgmt', 'screening-engine']],
  ['hr-screen-25', 'HR-Screen-25', 'People', 'Talent', 'AI Platform', 'People Risk', 'Pre-Production', 'Batch worker', 'Azure OpenAI', 'gpt-4.1-mini', 'high', 'PROHIBITED', ['TEXT', 'DOCUMENT'], 'restricted', ['ats']],
  ['log-anomaly-26', 'Log-Anomaly-26', 'Technology', 'Platform Engineering', 'AI Platform', 'Technology Risk', 'Pre-Production', 'Streaming worker', 'Self-hosted', 'llama-3.3-70b', 'moderate', 'READ ONLY', ['TEXT', 'STRUCTURED DATA'], 'internal', ['observability', 'cmdb']],
  ['lineage-27', 'Data-Lineage-27', 'Data Office', 'Data Governance', 'AI Platform', 'Data Risk', 'Production', 'Batch worker', 'Self-hosted', 'llama-3.3-70b', 'low', 'READ ONLY', ['TEXT', 'STRUCTURED DATA'], 'internal', ['catalogue', 'dq-monitor']],
];

const CAPS: Record<string, { approved: string[]; prohibited: string[]; exec?: Array<{ capability: string; maxAutonomousUsd?: number; autoApprovalThresholdUsd?: number; authorityCeilingUsd?: number }>; approval?: Array<{ capability: string; fromUsd: number; toUsd: number }> }> = {
  'treasury-07': {
    approved: ['balances:read', 'liquidity:forecast', 'instruments:query', 'transfer:recommend', 'transfer:execute'],
    prohibited: ['transfer:execute:>500k', 'beneficiary:create', 'transfer:cross-border', 'kyc:update', 'permission:change', 'agent:self-modify', 'policy:modify'],
    exec: [{ capability: 'transfer:execute', maxAutonomousUsd: 100_000, autoApprovalThresholdUsd: 250_000, authorityCeilingUsd: 500_000 }],
    approval: [{ capability: 'transfer:execute', fromUsd: 100_000, toUsd: 500_000 }],
  },
  'reconcile-14': {
    approved: ['balances:read', 'transactions:read', 'exception:create', 'reconcile:run'],
    prohibited: ['transfer:execute', 'beneficiary:create', 'ledger:post'],
    exec: [{ capability: 'exception:create' }],
  },
  'research-12': { approved: ['research:read', 'web:fetch', 'report:draft'], prohibited: ['transfer:execute', 'payments:write', 'beneficiary:create'] },
  'market-research-02': { approved: ['research:read', 'web:fetch'], prohibited: ['transfer:execute', 'payments:write'] },
  'customer-voice-01': {
    approved: ['account:read', 'balance:read', 'ticket:create', 'callback:schedule', 'beneficiary:create'],
    prohibited: ['transfer:execute', 'limit:change', 'kyc:update'],
  },
  'collections-voice-03': { approved: ['balance:read', 'reminder:send'], prohibited: ['transfer:execute', 'limit:change', 'threat:intent'] },
};

const DEFAULT_APPROVED = ['read:context', 'summarize', 'draft:output'];
const DEFAULT_PROHIBITED = ['transfer:execute', 'beneficiary:create', 'permission:change', 'agent:self-modify', 'policy:modify'];

function buildAgents(now: number): AgentPassport[] {
  return TUPLES.map((t, i) => {
    const [id, name, fn, bo, to, ro, env, fw, prov, model, risk, autonomy, mods, cls, systems] = t;
    const spec = CAPS[id];
    const approved = spec?.approved ?? DEFAULT_APPROVED;
    const prohibited = spec?.prohibited ?? DEFAULT_PROHIBITED;
    const orphan = id === 'credit-exp-04';
    const financial = id === 'treasury-07';
    return {
      agentId: `agt_${id.replace(/-/g, '_')}`,
      name,
      businessFunction: fn,
      businessOwner: bo,
      technicalOwner: to,
      riskOwner: ro,
      environment: env,
      framework: fw,
      provider: prov,
      model,
      modelVersion: `${model}#${(i % 5) + 1}`,
      agentVersion: `v${1 + (i % 4)}.${(i * 3) % 10}.${i % 7}`,
      status: 'active' as const,
      riskTier: risk,
      autonomyLevel: autonomy,
      modalities: mods,
      dataClassification: cls,
      connectedSystems: systems,
      approvedCapabilities: approved,
      effectiveCapabilities: [...approved],
      execution: spec?.exec,
      humanApproval: spec?.approval,
      prohibitedCapabilities: prohibited,
      dailyLimitUsd: financial ? 500_000 : undefined,
      velocityPerHour: financial ? 4 : undefined,
      credentialType: financial ? 'short-lived workload identity (mTLS)' : i % 3 === 0 ? 'short-lived workload identity' : 'workload identity federation',
      credentialExpiry: now + (financial ? 15 : 60 + (i % 20)) * 60_000,
      lastReview: now - (orphan ? 187 : 10 + (i % 60)) * DAY,
      nextReview: now + (orphan ? -187 : 80 - (i % 60)) * DAY,
      blastRadiusUsd: financial ? 500_000 : autonomy === 'PROHIBITED' ? 0 : undefined,
      killEnabled: autonomy !== 'READ ONLY',
      ownerActive: !orphan,
      approvedBeneficiaries: financial ? ['ben_internal_uk', 'ben_supplier_4471', 'ben_payroll_emea'] : undefined,
      approvedInstruments: financial ? ['SWIFT_MT103', 'RTGS_DOMESTIC'] : undefined,
      crossBorderAllowed: false,
      crossEntityAllowed: false,
    };
  });
}

/* ---------------- seed metrics inputs (all dashboard numbers derive here) ---------------- */

export interface DemoSeed {
  version: string;
  tenant: string;
  now: number;
  agents: AgentPassport[];
  baseline: {
    productionLikeAgents: number;
    boundedAutonomy: number;
    attentionAgents: number;
    autonomousActions: number;
    humanApprovals: number;
    policyBlocks: number;
    privilegeDriftFindings: number;
    orphanFindings: number;
    evidenceCoveragePct: number;
    medianPolicyDecisionMs: number;
    timeToKillSec: number;
    p95TimeToKillSec: number;
    criticalIncidents: number;
    injectionAttempts: number;
    multimodalRisks: number;
    syntheticMediaAlerts: number;
    maxFinancialBlastRadiusUsd: number;
    credentialsValidPct: number;
    killTestedPct: number;
    policyChangesTotal: number;
    policyChangesDualControlled: number;
    modalityChecksTotal: number;
    modalityChecksClean: number;
    readOnlyEvaluations: number;
    approvalsTotal: number;
    approvalsBound: number;
    blastEnforcedPct: number;
    reviewedAgents: number;
    ownedAgents: number;
  };
  performance: Record<string, number>;
}

export function buildSeed(now: number): DemoSeed {
  const agents = buildAgents(now);
  return {
    version: SEED_VERSION,
    tenant: TENANT,
    now,
    agents,
    baseline: {
      productionLikeAgents: agents.filter((a) => a.environment === 'Production').length,
      boundedAutonomy: agents.filter((a) => a.autonomyLevel === 'BOUND AUTONOMY').length,
      attentionAgents: 3,
      autonomousActions: 1842,
      humanApprovals: 37,
      policyBlocks: 12,
      privilegeDriftFindings: 2,
      orphanFindings: 1,
      evidenceCoveragePct: 99.4,
      medianPolicyDecisionMs: 18,
      timeToKillSec: 4.2,
      p95TimeToKillSec: 6.1,
      criticalIncidents: 0,
      injectionAttempts: 46,
      multimodalRisks: 9,
      syntheticMediaAlerts: 4,
      maxFinancialBlastRadiusUsd: 500_000,
      credentialsValidPct: 90,
      killTestedPct: 100,
      policyChangesTotal: 22,
      policyChangesDualControlled: 20,
      modalityChecksTotal: 20,
      modalityChecksClean: 16,
      readOnlyEvaluations: 703,
      approvalsTotal: 37,
      approvalsBound: 37,
      blastEnforcedPct: 100,
      reviewedAgents: 25,
      ownedAgents: 26,
    },
    performance: {
      taskSuccess: 97.8,
      falseRecommendations: 1.4,
      humanOverride: 2.1,
      unsupportedClaimRate: 0.7,
      unauthorizedToolAttempts: 0.3,
      policyBreachingActionsExecuted: 0,
      avgAgentResponseSec: 1.8,
      governanceLatencyMs: 18,
      voiceAsrErrorRate: 1.9,
      multimodalConflictRate: 0.4,
      syntheticMediaAlerts: 4,
      blockRate: 0.7,
      evidenceCoverage: 99.4,
    },
  };
}

/* ---------------- risk appetite (§50) ---------------- */

export interface AppetiteItem {
  key: string;
  label: string;
  configured: string;
  assessment: 'WITHIN APPETITE' | 'OUTSIDE APPETITE' | 'EXCEPTION';
  detail: string;
}

export function riskAppetite(): AppetiteItem[] {
  return [
    { key: 'max-autonomous-financial', label: 'Maximum autonomous financial value', configured: '$100,000 per transaction / $500,000 per day', assessment: 'WITHIN APPETITE', detail: 'Treasury-07 is the only agent with autonomous write authority; the gateway enforces both ceilings.' },
    { key: 'max-delegated-financial', label: 'Maximum delegated financial authority', configured: '$0 — no financial authority via delegation', assessment: 'WITHIN APPETITE', detail: 'Delegated capabilities are narrowed to research/read scopes only (P-DEL-001).' },
    { key: 'customer-decision-autonomy', label: 'Customer-decision autonomy', configured: 'Read-only; any customer-affecting action needs a human or an existing bank control', assessment: 'WITHIN APPETITE', detail: 'Voice/support agents can read balances and open tickets only.' },
    { key: 'critical-system-authority', label: 'Critical-system authority', configured: 'No agent may write to payment, trading or core ledgers autonomously', assessment: 'WITHIN APPETITE', detail: 'Write capabilities are held behind REQUIRE_APPROVAL.' },
    { key: 'data-sharing', label: 'External data sharing to models', configured: 'Regulated data may only reach approved regional endpoints; redaction first', assessment: 'WITHIN APPETITE', detail: 'Minimization gateway masks PII before model calls.' },
    { key: 'external-model-usage', label: 'External model usage', configured: 'Approved provider list per region; no regulated data to unlisted providers', assessment: 'EXCEPTION', detail: 'Two pre-production agents use an unlisted provider for evaluation — accepted until renewal, expires in 21 days.' },
    { key: 'synthetic-media-usage', label: 'Synthetic-media usage', configured: 'Marketing only, disclosure mandatory, human approval before publication', assessment: 'WITHIN APPETITE', detail: 'Marketing-Video-08 publishes only after human sign-off with AI disclosure applied.' },
    { key: 'voice-clone-usage', label: 'Voice-clone usage', configured: 'Prohibited for customer contact unless consent record exists', assessment: 'WITHIN APPETITE', detail: 'No consented clone profiles active in this deployment.' },
    { key: 'biometric-usage', label: 'Biometric usage', configured: 'Voice identity is a risk signal only — never authoritative authentication', assessment: 'WITHIN APPETITE', detail: 'Institutional authentication remains authoritative for consequential actions.' },
    { key: 'paralinguistic-analysis', label: 'Emotion / paralinguistic analysis', configured: 'Collections: neutral reminders only; no fear, shame or artificial urgency', assessment: 'OUTSIDE APPETITE', detail: 'One collections scenario exceeded the coercion threshold in test — controls regenerate the reply and escalate.' },
    { key: 'cross-border-execution', label: 'Cross-border AI execution', configured: 'Prohibited', assessment: 'WITHIN APPETITE', detail: 'P-GEO-001 blocks cross-border execution outright.' },
    { key: 'allowed-autonomy-by-tier', label: 'Allowed autonomy by risk tier', configured: 'critical→HUMAN APPROVAL, high→BOUND AUTONOMY max, moderate→BOUND, low→bounded autonomous', assessment: 'WITHIN APPETITE', detail: 'All 27 agents classified; 1 agent (HR-Screen-25) set to PROHIBITED pending legal review.' },
    { key: 'production-blast-radius', label: 'Production agent blast radius', configured: '$500,000 maximum daily aggregate across the estate', assessment: 'WITHIN APPETITE', detail: 'Enforced at the gateway, not a reporting number.' },
  ];
}

/* ---------------- AI use cases (§51) ---------------- */

export interface UseCase {
  id: string;
  name: string;
  objective: string;
  materiality: 'low' | 'medium' | 'high';
  financialExposureUsd: number;
  customerImpact: string;
  dataSensitivity: Sensitivity;
  modalities: ModalityClass[];
  autonomyRequested: AutonomyLevel;
  systems: string[];
  reversibility: string;
  oversight: string;
  jurisdictions: string[];
  inherentRisk: RiskTier;
  controls: string[];
  residualRisk: RiskTier;
  recommendedMode: 'BOUND AUTONOMY' | 'READ ONLY' | 'HUMAN APPROVAL' | 'PROHIBITED';
  status: 'approved' | 'in assessment' | 'rejected';
  value: string;
}

export function useCases(): UseCase[] {
  return [
    {
      id: 'uc_treasury', name: 'Autonomous treasury execution (bounded)', objective: 'Execute intraday liquidity moves within strict limits',
      materiality: 'high', financialExposureUsd: 500_000, customerImpact: 'internal — counterparty payments', dataSensitivity: 'regulated',
      modalities: ['TEXT', 'DOCUMENT', 'STRUCTURED DATA'], autonomyRequested: 'BOUND AUTONOMY', systems: ['payment-hub', 'swift-adapter'],
      reversibility: 'limited — recall window 20 min', oversight: 'approval above $250K, dual approval above $100K for new beneficiaries',
      jurisdictions: ['UK', 'EU'], inherentRisk: 'critical', controls: ['P-FIN-001..004', 'P-BEN-001', 'P-GEO-001', 'kill switch', 'evidence ledger'],
      residualRisk: 'high', recommendedMode: 'BOUND AUTONOMY', status: 'approved', value: 'Frees 1,400 analyst hours/quarter on intraday sweeps',
    },
    {
      id: 'uc_recon', name: 'Reconciliation exception creation', objective: 'Auto-create exceptions for small mismatches', materiality: 'low',
      financialExposureUsd: 0, customerImpact: 'none', dataSensitivity: 'confidential', modalities: ['TEXT', 'STRUCTURED DATA'],
      autonomyRequested: 'BOUND AUTONOMY', systems: ['erp-gl'], reversibility: 'fully reversible — exception can be closed', oversight: 'sample review 5%',
      jurisdictions: ['UK'], inherentRisk: 'low', controls: ['P-CAP-001', 'evidence ledger'], residualRisk: 'low', recommendedMode: 'BOUND AUTONOMY',
      status: 'approved', value: 'Removes manual matching of 60k lines/month',
    },
    {
      id: 'uc_voice_collect', name: 'Collections voice agent (paralinguistic governed)', objective: 'Neutral payment reminders by voice', materiality: 'high',
      financialExposureUsd: 0, customerImpact: 'direct — vulnerable customers', dataSensitivity: 'regulated', modalities: ['VOICE', 'AUDIO'],
      autonomyRequested: 'HUMAN APPROVAL', systems: ['collections-crm'], reversibility: 'call cannot be unsaid — conduct risk', oversight: 'persona + prosody policy, live escalation',
      jurisdictions: ['UK', 'AU'], inherentRisk: 'critical', controls: ['paralinguistic policy', 'AI disclosure', 'P-SYN-001', 'transcript policy'],
      residualRisk: 'high', recommendedMode: 'HUMAN APPROVAL', status: 'in assessment', value: 'Out-of-hours coverage without agent burnout',
    },
    {
      id: 'uc_hr', name: 'CV screening for hiring', objective: 'Rank applicants', materiality: 'high', financialExposureUsd: 0,
      customerImpact: 'direct — candidates', dataSensitivity: 'restricted', modalities: ['DOCUMENT', 'TEXT'], autonomyRequested: 'PROHIBITED',
      systems: ['ats'], reversibility: 'not reversible — decision affects people', oversight: 'none approved', jurisdictions: ['EU'],
      inherentRisk: 'critical', controls: ['P-CAP-002 prohibited capability'], residualRisk: 'critical', recommendedMode: 'PROHIBITED',
      status: 'rejected', value: 'not accepted — legal + fairness review outstanding',
    },
    {
      id: 'uc_marketing_video', name: 'AI-generated campaign video', objective: 'Produce synthetic campaign assets', materiality: 'medium',
      financialExposureUsd: 0, customerImpact: 'public audience', dataSensitivity: 'internal', modalities: ['VIDEO', 'IMAGE', 'AUDIO'],
      autonomyRequested: 'HUMAN APPROVAL', systems: ['dam', 'cms-publish'], reversibility: 'retractable', oversight: 'human approval + AI disclosure before publish',
      jurisdictions: ['EU', 'US'], inherentRisk: 'moderate', controls: ['C2PA provenance', 'disclosure policy', 'P-SYN-001'], residualRisk: 'low',
      recommendedMode: 'HUMAN APPROVAL', status: 'approved', value: 'Creative production cost -60%',
    },
  ];
}

/* ---------------- integrations / connectors (§105) — default DISABLED ---------------- */

export interface Integration {
  id: string;
  system: string;
  category: string;
  capability: string;
  auth: string;
  credentialRef: string;
  riskTier: RiskTier;
  failureBehavior: string;
  killBehavior: string;
  enabled: boolean;
  approved: boolean;
  health: 'healthy' | 'degraded' | 'disabled';
  lastReviewDays: number;
  owner: string;
}

export function integrations(mode: 'demo' | 'production'): Integration[] {
  const rows: Array<[string, string, string, string, string, RiskTier, string]> = [
    ['aws-bedrock', 'AWS Bedrock', 'Model provider', 'inference', 'IRSA workload identity', 'high', 'fail closed — request held'],
    ['openai', 'OpenAI', 'Model provider', 'inference', 'API key in KMS-backed vault', 'high', 'fail closed — request held'],
    ['anthropic', 'Anthropic', 'Model provider', 'inference', 'API key in KMS-backed vault', 'high', 'fail closed — request held'],
    ['entra-id', 'Microsoft Entra ID', 'IAM', 'identity + SSO', 'OIDC / mTLS', 'critical', 'no identity → BLOCK'],
    ['okta', 'Okta', 'IAM', 'identity + SSO', 'OIDC', 'critical', 'no identity → BLOCK'],
    ['cyberark', 'CyberArk', 'Secrets', 'credential brokering', 'mTLS', 'critical', 'expired credential → BLOCK'],
    ['vault', 'HashiCorp Vault', 'Secrets', 'secret retrieval', 'mTLS + token', 'critical', 'unreachable → HOLD'],
    ['aws-kms', 'AWS KMS', 'Encryption', 'key management', 'IRSA', 'critical', 'unreachable → HOLD'],
    ['splunk', 'Splunk', 'SIEM', 'event streaming', 'HEC token', 'high', 'buffered, alert on gap'],
    ['sentinel', 'Microsoft Sentinel', 'SIEM', 'event streaming', 'managed identity', 'high', 'buffered, alert on gap'],
    ['servicenow', 'ServiceNow', 'ITSM', 'incident creation', 'OAuth2', 'moderate', 'incident queued locally'],
    ['datadog', 'Datadog', 'Observability', 'metrics/traces', 'API key', 'moderate', 'metrics dropped, alert'],
    ['langgraph', 'LangGraph', 'Agent framework', 'agent runtime hook', 'in-process', 'high', 'runtime pause'],
    ['c2pa-validator', 'C2PA validator', 'Provenance', 'manifest validation', 'service key', 'moderate', 'provenance unknown → REVIEW'],
    ['telephony', 'Telephony platform (SIP)', 'Voice', 'call ingress', 'mTLS', 'high', 'call rejected'],
  ];
  return rows.map(([id, system, category, capability, auth, risk, failure], i) => ({
    id, system, category, capability, auth,
    credentialRef: mode === 'demo' ? `demo://synthetic/${id}` : `vault://prod/${id}`,
    riskTier: risk, failureBehavior: failure, killBehavior: 'connector disabled; queued actions rejected',
    enabled: mode === 'demo' ? false : false, // DISABLED until approved (§105)
    approved: false,
    health: 'disabled' as const,
    lastReviewDays: 40 + i * 7,
    owner: ['AI Platform', 'Infrastructure', 'Security Engineering'][i % 3],
  }));
}

/* ---------------- production readiness (§83 / §113) ---------------- */

export interface ReadinessGate {
  id: string;
  label: string;
  status: 'PASS' | 'FAIL' | 'NOT TESTED' | 'CUSTOMER ACTION REQUIRED';
  detail: string;
  mandatory: boolean;
}

export function productionReadiness(): ReadinessGate[] {
  return [
    { id: 'identity', label: 'Identity', status: 'PASS', detail: 'Enterprise IAM federation configured; workload identity for agents', mandatory: true },
    { id: 'authz', label: 'Authorization', status: 'PASS', detail: 'Least-privilege passports with prohibited-capability lists', mandatory: true },
    { id: 'tenant', label: 'Tenant Isolation', status: 'PASS', detail: 'tenant_id on every row; cross-tenant access tested in CI', mandatory: true },
    { id: 'evidence', label: 'Evidence', status: 'PASS', detail: 'Append-only hash-chained evidence ledger with export', mandatory: true },
    { id: 'policy-gov', label: 'Policy Governance', status: 'PASS', detail: 'Maker-checker lifecycle; authors cannot approve own changes', mandatory: true },
    { id: 'security', label: 'Security', status: 'PASS', detail: 'TLS, RBAC, input validation, rate limits, secure headers', mandatory: true },
    { id: 'privacy', label: 'Privacy', status: 'PASS', detail: 'Minimization + masking before model calls; residency config', mandatory: true },
    { id: 'blast', label: 'Blast Radius', status: 'PASS', detail: 'Per-transaction, daily and velocity limits enforced at the gateway', mandatory: true },
    { id: 'kill', label: 'Kill Test', status: 'PASS', detail: 'Kill operates outside the agent runtime; P50 4.2s, P95 6.1s', mandatory: true },
    { id: 'monitoring', label: 'Monitoring', status: 'PASS', detail: 'OpenTelemetry-compatible traces, decision latency metrics', mandatory: true },
    { id: 'siem', label: 'SIEM', status: 'PASS', detail: 'Structured event catalog streamed to the customer SIEM', mandatory: true },
    { id: 'ha', label: 'HA', status: 'PASS', detail: 'Multiple policy nodes, health checks, graceful shutdown', mandatory: true },
    { id: 'backup', label: 'Backup', status: 'PASS', detail: 'Encrypted snapshots per tenant', mandatory: true },
    { id: 'restore', label: 'Restore', status: 'PASS', detail: 'Restore tested — evidence chain verified after restore', mandatory: true },
    { id: 'dr', label: 'DR', status: 'PASS', detail: 'RTO 4h / RPO 15min, documented and exercised', mandatory: true },
    { id: 'pen-test', label: 'Pen Test', status: 'NOT TESTED', detail: 'Independent penetration test not yet scheduled by the customer', mandatory: true },
    { id: 'validation', label: 'Independent Validation', status: 'CUSTOMER ACTION REQUIRED', detail: 'External validation of framework mappings must be performed by an independent process', mandatory: true },
    { id: 'model-risk', label: 'Model Risk', status: 'PASS', detail: 'Model registry with allowed use cases and review dates', mandatory: false },
    { id: 'third-party', label: 'Third Party', status: 'PASS', detail: 'Vendor register with SLA, subprocessors and exit strategy', mandatory: false },
  ];
}

export const READINESS_NOTE =
  'Status reflects this deployment only. The platform never labels a tenant "Regulator Approved".';

/* ---------------- policy catalogue for Policy Studio (§42/§43) ---------------- */

export interface PolicyRow {
  id: string;
  name: string;
  version: string;
  scope: string;
  state: 'Draft' | 'In Review' | 'Approved' | 'Active' | 'Superseded';
  priority: number;
  updatedDays: number;
  proposer: string;
  reviewer?: string;
  approver?: string;
  tests: 'passing' | 'failing' | 'not run';
}

export function policyStudioRows(): PolicyRow[] {
  const rows: Array<[string, string, string, PolicyRow['state'], number, number, string, string?, string?]> = [
    ['P-FIN-001', 'Autonomous transfer ceiling', 'tenant=global, env=production', 'Active', 40, 6, 'a.mensah', 'r.okafor', 's.duarte'],
    ['P-FIN-002', 'Auto-approval threshold', 'tenant=global, env=production', 'Active', 41, 6, 'a.mensah', 'r.okafor', 's.duarte'],
    ['P-FIN-003', 'Daily aggregate exposure', 'tenant=global, env=production', 'Active', 42, 14, 'a.mensah', 'r.okafor', 's.duarte'],
    ['P-FIN-004', 'Transaction velocity limit', 'tenant=global, env=production', 'Active', 43, 21, 'j.tan', 'r.okafor', 's.duarte'],
    ['P-BEN-001', 'Approved beneficiary only', 'tenant=global, env=production', 'Active', 44, 9, 'a.mensah', 'r.okafor', 's.duarte'],
    ['P-GEO-001', 'Cross-border execution prohibited', 'tenant=global', 'Active', 45, 33, 'compliance', 'r.okafor', 's.duarte'],
    ['P-INJ-001', 'Prompt injection (direct / indirect / multimodal)', 'tenant=global, all modalities', 'Active', 30, 3, 'sec-eng', 'm.ferreira', 's.duarte'],
    ['P-DEL-001', 'Delegation cannot expand authority', 'tenant=global', 'Active', 22, 11, 'sec-eng', 'm.ferreira', 's.duarte'],
    ['P-APP-001', 'Approval integrity (binding + freshness)', 'tenant=global', 'Active', 50, 12, 'r.governance', 'r.okafor', 's.duarte'],
    ['P-RSK-002', 'Paralinguistic collections guardrail', 'modality=voice, function=collections', 'In Review', 61, 2, 'conduct-risk', undefined, undefined],
    ['P-MOD-003', 'Live-video provenance continuity', 'modality=live-video', 'Draft', 35, 1, 'media-gov', undefined, undefined],
    ['P-SYN-002', 'Synthetic-voice disclosure by jurisdiction', 'modality=voice', 'Draft', 36, 4, 'legal', undefined, undefined],
  ];
  return rows.map(([id, name, scope, state, priority, updatedDays, proposer, reviewer, approver]) => ({
    id, name, version: `v${priority % 5}.${updatedDays % 9}.0`, scope, state, priority, updatedDays,
    proposer, reviewer, approver, tests: state === 'Draft' ? 'not run' : 'passing',
  }));
}