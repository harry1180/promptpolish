/**
 * Framework mapping — CONTROL MAPPING ONLY.
 *
 * The platform never claims automatic compliance. Allowed statuses:
 * Strongly Evidenced / Partially Evidenced / Gap / Not Assessed /
 * External Process Required. Assertions of certification or compliance are
 * never produced by this module.
 */

export type MappingStatus =
  | 'Strongly Evidenced'
  | 'Partially Evidenced'
  | 'Gap'
  | 'Not Assessed'
  | 'External Process Required';

export interface MappedControl {
  id: string;
  title: string;
  status: MappingStatus;
  owner: string;
  controls: string[];
  evidence: string[];
  gaps: string[];
  recommendation: string;
  lastAssessedDays: number;
}

export interface Framework {
  key: string;
  name: string;
  note: string;
  controls: MappedControl[];
}

export const FSB_PRACTICES = [
  'Board / Senior Management Oversight and Alignment',
  'Governance Framework and Roles',
  'AI within Risk Management and Documentation',
  'Continuous Learning and Adaptation',
  'Materiality and Risk Assessment',
  'Appropriate Technology Selection',
  'Data Governance',
  'Explainability and Compensating Controls',
  'AI Performance Evaluation',
  'Effective Human Oversight',
  'Cyber and ICT Risk',
  'Third-Party AI Dependencies',
];

export function fsbFramework(): Framework {
  const rows: Array<[MappingStatus, string, string[], string[], string[], string, number]> = [
    ['Strongly Evidenced', 'Risk & Compliance', ['AI risk appetite', 'governance score', 'executive report'], ['Risk appetite configuration', 'Executive overview'], [], 'Keep appetite exceptions time-bound and re-approved.', 4],
    ['Strongly Evidenced', 'AI Platform', ['role model', 'maker-checker', 'segregation of duties'], ['Administration RBAC', 'Policy Studio lifecycle'], [], 'Review role definitions quarterly.', 9],
    ['Strongly Evidenced', 'Operational Risk', ['agent passports', 'use-case assessment', 'risk tiers'], ['Agent Registry', 'AI Use Cases'], [], 'Extend documentation to pre-production agents.', 6],
    ['Partially Evidenced', 'AI Platform', ['controlled learning lifecycle', 'regression tests'], ['Change governance records'], ['Offline evaluation evidence is not yet linked per model version'], 'Wire model evaluation artifacts into the passport.', 12],
    ['Strongly Evidenced', 'Risk & Compliance', ['materiality', 'inherent vs residual risk'], ['Use-case assessment'], [], 'Re-assess materiality annually.', 21],
    ['Partially Evidenced', 'AI Platform', ['model registry', 'technology suitability comparison'], ['Model/provider registry'], ['Provider-concentration analysis is manual'], 'Add concentration metric to third-party register.', 18],
    ['Strongly Evidenced', 'Data Office', ['classification', 'minimization', 'residency'], ['Modality governance', 'data classification'], [], 'Monitor masking exceptions monthly.', 7],
    ['Partially Evidenced', 'Model Risk', ['explainability', 'compensating controls'], ['Decision replay', 'policy reason codes'], ['Some model providers do not expose token-level attribution'], 'Document compensating controls per model family.', 15],
    ['Strongly Evidenced', 'Model Risk', ['performance vs governance split', 'override rates'], ['AI Performance dashboard'], [], 'Keep agent and governance KPIs separate.', 3],
    ['Strongly Evidenced', 'Operations', ['approval workflows', 'human-in-the-loop', 'kill authority'], ['Approvals', 'Kill controls'], [], 'Exercise kill runbook quarterly.', 5],
    ['Strongly Evidenced', 'Security Engineering', ['injection controls', 'credential hygiene', 'SIEM events', 'tenant isolation'], ['Modality gateway', 'Security tests', 'SIEM catalog'], [], 'Schedule independent penetration test.', 8],
    ['Strongly Evidenced', 'Vendor Management', ['third-party register', 'vendor chain', 'exit strategy'], ['Integrations', 'multimodal vendor chain'], [], 'Review SLAs at each renewal.', 26],
  ];
  return {
    key: 'fsb',
    name: 'FSB 2026 — 12 Sound Practices for Responsible Adoption of AI',
    note: 'Control mapping with evidence references. Not an FSB assessment and never a compliance claim.',
    controls: FSB_PRACTICES.map((title, i) => {
      const [status, owner, controls, evidence, gaps, recommendation, days] = rows[i];
      return {
        id: `FSB-${String(i + 1).padStart(2, '0')}`,
        title,
        status,
        owner,
        controls,
        evidence,
        gaps,
        recommendation,
        lastAssessedDays: days,
      };
    }),
  };
}

export function masFramework(): Framework {
  const rows: Array<[string, MappingStatus, string, string[], string[]]> = [
    ['Action authorization before execution', 'Strongly Evidenced', 'Runtime Governance Gateway (POST /governance/evaluate) returns ALLOW/HOLD/REQUIRE_APPROVAL/BLOCK/QUARANTINE', ['Gateway decisions', 'Policy catalogue'], []],
    ['Runtime governance of agentic activity', 'Strongly Evidenced', 'Deterministic policy evaluation on every tool call and agent message', ['Live decisions', 'Evidence ledger'], []],
    ['Human oversight activation', 'Strongly Evidenced', 'Thresholds, risk tier and modality trigger approvals bound to the exact transaction', ['Approvals', 'Approval binding tests'], []],
    ['Decision evidence and reconstructability', 'Strongly Evidenced', 'Append-only hash-chained evidence, observational replay', ['Evidence & Replay'], []],
    ['Bounded autonomy and containment', 'Partially Evidenced', 'Blast-radius enforcement + multi-level kill', ['Kill tests', 'Blast radius'], ['Group-level containment across regions not yet exercised']],
    ['Third-party agentic dependencies', 'Partially Evidenced', 'Vendor chain register per modality pipeline', ['Integrations'], ['Subprocessor exit evidence is manual']],
  ];
  return {
    key: 'mas',
    name: 'MAS — Safeguards for Agentic Finance at Runtime (SAFR)',
    note: 'Concept mapping to product functionality. No formal MAS approval is claimed or implied.',
    controls: rows.map(([title, status, ctrl, ev, gaps], i) => ({
      id: `MAS-SAFR-${i + 1}`,
      title,
      status,
      owner: 'Financial Services Governance',
      controls: [ctrl],
      evidence: ev,
      gaps,
      recommendation: gaps.length ? 'Close the listed evidence gap before relying on this mapping.' : 'Maintain evidence currency.',
      lastAssessedDays: 5 + i * 3,
    })),
  };
}

export function standardsFramework(): Framework {
  const rows: Array<[string, MappingStatus, string[], string[]]> = [
    ['NIST AI RMF — Map / Measure / Manage / Govern', 'Strongly Evidenced', ['inventory', 'score', 'incident workflow'], ['Agent Registry', 'Governance Score', 'Incidents']],
    ['NIST GenAI Profile — data privacy & information integrity', 'Strongly Evidenced', ['minimization', 'injection controls', 'provenance'], ['Modality gateway']],
    ['NIST agent identity & authorization work — workload identity, scoped claims, short-lived credentials', 'Strongly Evidenced', ['credential state in every evaluation', 'environment-bound credentials'], ['Agent identity model', 'Credential hygiene']],
    ['ISO/IEC 42001 — AI management system clauses', 'Partially Evidenced', ['policy lifecycle', 'roles', 'monitoring', 'continual improvement'], ['Policy Studio', 'Administration'], ],
    ['OWASP Top 10 for Agentic Applications 2026 — tool abuse / agent privilege', 'Strongly Evidenced', ['capability allow-lists', 'prohibited capabilities', 'delegation limits'], ['Passports', 'Delegation tests']],
    ['OWASP Top 10 for Agentic Applications 2026 — injection & goal manipulation', 'Strongly Evidenced', ['multimodal injection controls', 'untrusted content cannot instruct'], ['Modality gateway', 'Injection tests']],
    ['OWASP LLM / GenAI security guidance — sensitive data disclosure', 'Strongly Evidenced', ['masking before model calls', 'PII labels'], ['Privacy controls']],
    ['OWASP LLM / GenAI security guidance — supply chain & model integration', 'Partially Evidenced', ['model/provider registry', 'SBOM'], ['Integrations'], ],
    ['Enterprise model risk management expectations', 'Partially Evidenced', ['model registry', 'performance monitoring', 'challenger review'], ['AI Performance', 'Model registry'], ],
    ['Customer-defined internal controls', 'Not Assessed', [], ['Customer control library (empty until imported)']],
    ['Jurisdiction-specific regulatory requirements', 'External Process Required', ['jurisdiction configuration', 'disclosure settings'], ['Configuration only — legal determination belongs to counsel']],
    ['Independent external validation of mappings', 'External Process Required', [], ['Must be performed by an independent process']],
  ];
  return {
    key: 'standards',
    name: 'NIST / ISO / OWASP / customer-defined controls',
    note: 'Configurable mappings. Status describes evidence availability, not certification.',
    controls: rows.map(([title, status, controls, evidence], i) => ({
      id: `STD-${String(i + 1).padStart(2, '0')}`,
      title,
      status,
      owner: ['AI Governance', 'Security Engineering', 'Legal', 'Model Risk'][i % 4],
      controls,
      evidence,
      gaps: status === 'Gap' || status === 'Not Assessed' ? ['Not yet assessed in this deployment'] : status === 'External Process Required' ? ['Requires an external/legal process'] : [],
      recommendation: status === 'Strongly Evidenced' ? 'Maintain evidence currency.' : 'Assign an owner and target date for the listed gap.',
      lastAssessedDays: 3 + i * 4,
    })),
  };
}

export function allFrameworks(): Framework[] {
  return [fsbFramework(), masFramework(), standardsFramework()];
}

export function frameworkSummary(fw: Framework): {
  total: number; strongly: number; partial: number; gap: number; notAssessed: number; external: number;
} {
  const c = fw.controls;
  return {
    total: c.length,
    strongly: c.filter((x) => x.status === 'Strongly Evidenced').length,
    partial: c.filter((x) => x.status === 'Partially Evidenced').length,
    gap: c.filter((x) => x.status === 'Gap').length,
    notAssessed: c.filter((x) => x.status === 'Not Assessed').length,
    external: c.filter((x) => x.status === 'External Process Required').length,
  };
}

/* ---------------- SIEM event catalog (§76) ---------------- */

export const SIEM_EVENTS: Array<{ event: string; severity: 'low' | 'medium' | 'high' | 'critical'; description: string }> = [
  { event: 'agent.action.blocked', severity: 'high', description: 'Governance gateway blocked a consequential action' },
  { event: 'agent.approval.required', severity: 'medium', description: 'Action held pending human approval' },
  { event: 'agent.privilege.drift', severity: 'high', description: 'Effective permissions differ from approved permissions' },
  { event: 'agent.orphan.detected', severity: 'high', description: 'Agent without an active owner or overdue review' },
  { event: 'agent.kill.activated', severity: 'critical', description: 'Kill/containment command issued' },
  { event: 'policy.publish', severity: 'medium', description: 'Policy version published through maker-checker' },
  { event: 'policy.failed', severity: 'high', description: 'Policy evaluation failed closed' },
  { event: 'prompt.injection', severity: 'high', description: 'Direct or indirect prompt injection detected' },
  { event: 'multimodal.injection', severity: 'high', description: 'Injection detected in document/image/audio/video channel' },
  { event: 'voice.synthetic-risk', severity: 'high', description: 'Synthetic voice / clone risk signal above threshold' },
  { event: 'video.deepfake-risk', severity: 'high', description: 'Video manipulation signal above threshold' },
  { event: 'content.provenance.invalid', severity: 'medium', description: 'Content Credentials manifest failed validation' },
  { event: 'tenant.violation', severity: 'critical', description: 'Cross-tenant access attempt rejected' },
  { event: 'credential.revoked', severity: 'high', description: 'Credential revoked as part of containment' },
];

/* ---------------- threat model (§111) ---------------- */

export interface ThreatRow {
  threat: string;
  asset: string;
  attackPath: string;
  prevention: string;
  detection: string;
  containment: string;
  evidence: string;
  residual: string;
}

export function threatModel(): ThreatRow[] {
  const rows: Array<[string, string, string, string, string, string, string, string]> = [
    ['Compromised model', 'Model output', 'Prompt/system compromise → malicious tool call', 'Model never authorizes; deterministic gateway', 'Unusual capability requests', 'Capability freeze / kill', 'Decision + policy hash', 'Provider-side compromise remains — third-party dependency'],
    ['Compromised agent runtime', 'Agent process', 'Memory poisoning → autonomous action', 'Short-lived credentials, capability allow-list', 'Velocity + anomaly rules', 'Kill: revoke credentials, stop queue', 'Kill timeline evidence', 'Bounded window before detection'],
    ['Malicious user', 'Enterprise systems', 'Injected instructions via chat/document', 'Content trust classification, injection controls', 'Injection detections', 'Block + incident', 'Content item + findings', 'Novel encodings require rule updates'],
    ['Malicious admin', 'Policy store', 'Self-approve a broadening policy', 'Maker-checker; author cannot approve', 'Segregation-of-duties audit', 'Revert to previous policy version', 'Diff + approver identity', 'Colluding approvers — needs independent audit'],
    ['Prompt injection', 'Agent instructions', 'Hidden text/OCR/subtitle/web content', 'Untrusted content may not instruct consequential action', 'Multimodal injection rules', 'Block', 'Content item + policy match', 'Zero-day phrasing'],
    ['Voice impersonation', 'Transaction authority', 'Cloned executive voice requests transfer', 'Voice = claim only; institutional auth required', 'Synthetic-voice risk signal', 'Block / out-of-band verification', 'Call transcript + signals', 'Detector accuracy — never sole control'],
    ['Video deepfake', 'Meeting authority', 'Deepfake CFO in video call', 'Meeting identity unverified → transaction policy applies', 'Manipulation + provenance signals', 'Block / verified out-of-band', 'Frame + audio signals', 'Detector accuracy'],
    ['Document poisoning', 'Retrieved context', 'Hidden instruction in PDF', 'Document = data, not authority', 'Hidden-content rules', 'Block tool call', 'Document findings', 'Novel obfuscation'],
    ['RAG poisoning', 'Retrieval corpus', 'Planted instruction in indexed doc', 'Retrieved context class + trust', 'Injection in retrieved items', 'Quarantine content', 'Provenance chain', 'Corpus hygiene beyond platform'],
    ['Tool compromise', 'Tool responses', 'Malicious API response instructing agent', 'Tool output treated as untrusted', 'Response-hash + content scan', 'Block', 'Tool identity + hash', 'Legitimate-looking payloads'],
    ['Delegation abuse', 'Authority chain', 'Receiver gains broader authority', 'Authority cannot expand; depth + TTL + loop checks', 'Delegation chain evidence', 'Block delegation', 'Chain record', 'Cross-org delegation outside scope'],
    ['Credential theft', 'Agent identity', 'Token replay from stolen workload identity', 'Short TTL, replay/idempotency protection', 'Replay detection', 'Credential revocation', 'Replay evidence', 'Stolen valid token inside TTL'],
    ['Approval fraud', 'Human oversight', 'Approval for a different transaction', 'Approval bound to transaction hash; mutation invalidates', 'Binding mismatch detection', 'Block', 'Approval binding record', 'Compromised approver account'],
    ['Evidence tampering', 'Evidence ledger', 'Editing historical records', 'Append-only hash chain + export to WORM', 'Chain verification failure', 'Legal hold / incident', 'Chain verification report', 'Storage-level attack — customer WORM integration'],
    ['Cross-tenant attack', 'Tenant data', 'IDOR / parameter tampering', 'Server-side tenant scoping on every query', 'Tenant violation events', 'Reject + alert', 'Tenant violation event', 'Shared infrastructure side channels'],
    ['Replay / duplicate transaction', 'Payments', 'Re-sent request executes twice', 'Idempotency keys + request expiry + nonce', 'Duplicate detection', 'Reject', 'Idempotency evidence', 'Clock skew on expiry'],
    ['Supply chain', 'Dependencies', 'Malicious package update', 'Lockfile, pinning, SBOM, scanning', 'CI dependency scan', 'Revert + rebuild', 'SBOM + CI logs', 'Transitive compromise'],
    ['Denial of service', 'Gateway availability', 'Flood evaluations', 'Rate limits, backpressure, circuit breaking', 'Latency/error dashboards', 'Shed load — fail closed', 'Health events', 'Upstream dependency outage'],
  ];
  return rows.map(([threat, asset, attackPath, prevention, detection, containment, evidence, residual]) => ({
    threat, asset, attackPath, prevention, detection, containment, evidence, residual,
  }));
}