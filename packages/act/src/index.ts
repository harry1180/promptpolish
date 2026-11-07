/**
 * @promptslim/act — Agent Control Tower core.
 *
 * Deterministic, DOM-free, network-free governance engine shared by the
 * server (authoritative evaluation) and the web app (rendering helpers).
 */

export * from './types.ts';
export { evaluate, isConsequential, POLICIES } from './policy.ts';
export {
  computeGovernanceScore, classify, rangeStatus, DISCLAIMER,
  METHODOLOGY_VERSION, FORMULA_VERSION,
} from './score.ts';
export type { ScoreInputs, RangeMetric, RangeStatus } from './score.ts';
export { computeBlastRadius, checkBlastRadius, blastContextFields } from './blast.ts';
export type { BlastBreach } from './blast.ts';
export { authorizeDelegation, delegationContext, MAX_CHAIN_DEPTH } from './delegation.ts';
export type { DelegationRequest, DelegationVerdict } from './delegation.ts';
export { evaluateContent, detectInjection, detectCrossModalConflict, provenanceFindings } from './modality.ts';
export type { Checkpoint, FullModalityReport, CrossModalInput } from './modality.ts';
export {
  buildSeed, riskAppetite, useCases, integrations, productionReadiness,
  policyStudioRows, SEED_VERSION, TENANT, READINESS_NOTE,
} from './seed.ts';
export type { DemoSeed, AppetiteItem, UseCase, Integration, ReadinessGate, PolicyRow } from './seed.ts';
export {
  overview, scoreInputs, governanceScoreView, registry, incidents, approvals,
  seededDecisions, runtimeDecisions, performance, executiveSummary, count,
} from './state.ts';
export type { Overview, RegistryRow, IncidentRow, ApprovalRow, DecisionRow } from './state.ts';
export { SCENARIO_META, runScenario } from './scenarios.ts';
export type { ScenarioResult, ScenarioStep, ScenarioContext } from './scenarios.ts';
export {
  fsbFramework, masFramework, standardsFramework, allFrameworks, frameworkSummary,
  FSB_PRACTICES, SIEM_EVENTS, threatModel,
} from './frameworks.ts';
export type { Framework, MappedControl, MappingStatus, ThreatRow } from './frameworks.ts';