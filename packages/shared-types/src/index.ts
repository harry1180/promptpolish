/** Core shared types for PromptPolice. Browser/DOM-free: usable by web app, Chrome extension, and Node. */

export type OptimizationLevel = 'conservative' | 'balanced' | 'aggressive';

export type TokenizerType = 'o200k' | 'cl100k' | 'tiktoken' | 'heuristic';

/** A model entry from model-config/models.json (no pricing lives in UI code). */
export interface ModelEntry {
  id: string;
  provider: string;
  modelName: string;
  inputPricePerMillionTokens: number;
  outputPricePerMillionTokens: number;
  contextWindow: number;
  tokenizerType: TokenizerType;
  notes?: string;
  /** Override the provider API base (e.g. an org's Azure/Bedrock gateway). */
  apiBase?: string;
  /** Override the wire model id if it differs from the catalog id. */
  apiModel?: string;
  lastUpdated: string; // ISO date the price was last verified
}

export interface ModelCatalog {
  pricingLastUpdated: string; // global "verify prices" date shown in UI
  disclaimer: string;
  models: ModelEntry[];
}

export type TokenMethod = 'exact' | 'estimated';

export interface TokenCount {
  tokens: number;
  method: TokenMethod;
  /** e.g. 'tiktoken o200k_base' or 'heuristic chars/4+words' */
  engine: string;
}

/** A single deterministic change made by the optimizer (shown in "Optimization Changes"). */
export interface ChangeLogEntry {
  kind:
    | 'removed-duplicate'
    | 'compressed-phrase'
    | 'collapsed-whitespace'
    | 'removed-filler'
    | 'combined-constraints'
    | 'removed-redundant-instruction'
    | 'compressed-example'
    | 'preserved-json-schema'
    | 'preserved-xml'
    | 'preserved-placeholder';
  description: string;
  before?: string;
  after?: string;
  tokensSaved: number;
}

/** Anything the optimizer is not allowed to touch or delete. */
export interface PreservableItem {
  type:
    | 'placeholder' // {{var}}, ${var}, {var}, [VAR]
    | 'json-block'
    | 'xml-block'
    | 'code-block'
    | 'output-format'
    | 'constraint'
    | 'example'
    | 'safety'
    | 'role'
    | 'tool-def';
  text: string;
}

export interface StructureAnalysis {
  role: boolean;
  objective: boolean;
  context: boolean;
  constraints: boolean;
  examples: boolean;
  outputFormat: boolean;
}

export interface QualityMetrics {
  /** 0-100 overall token-efficiency score (NOT a factual-accuracy claim). */
  score: number;
  redundancy: number; // 0-100, higher = less redundancy
  instructionDensity: number; // 0-100
  constraintClarity: number; // 0-100
  structure: number; // 0-100
}

export interface PreservationScores {
  intent: number; // 0-100
  constraints: number; // 0-100
  outputFormat: number; // 0-100
  placeholders: number; // 0-100
  overall: number; // 0-100
  warnings: string[];
  notes: string[]; // positive confirmations, e.g. "JSON schema preserved"
}

export interface PromptAnalysis {
  characters: number;
  words: number;
  lines: number;
  sentences: number;
  tokens: TokenCount;
  structure: StructureAnalysis;
  quality: QualityMetrics;
  sensitive: SensitiveHit[];
  preserved: PreservableItem[];
}

export interface OptimizationResult {
  originalText: string;
  optimizedText: string;
  level: OptimizationLevel;
  originalTokens: TokenCount;
  optimizedTokens: TokenCount;
  reductionPercent: number; // token reduction, 0-100
  changeLog: ChangeLogEntry[];
  preservation: PreservationScores;
  structure: StructureAnalysis;
}

export type SensitiveCategory =
  | 'email'
  | 'phone'
  | 'api-key'
  | 'aws-key'
  | 'credit-card'
  | 'ssn'
  | 'ip-address';

export interface SensitiveHit {
  category: SensitiveCategory;
  label: string; // human label, never the raw secret
  samples: string[]; // masked samples, e.g. "j***@e***.com"
  count: number;
}

/* ---------------- accounts, tags & usage analytics (org dashboard) -------- */

/** Free-form organization metadata attached to an account: {cost_center: "10", team: "payments"}. */
export type TagMap = Record<string, string>;

/** One filter condition in a tag-combination query. Multiple filters AND together. */
export interface TagFilter {
  key: string;
  value: string;
}

/** A single recorded prompt-run metric row (NEVER contains prompt text). */
export interface UsageEventRow {
  id: number;
  userId: number;
  email?: string; // populated for group-by-user views only where needed
  ts: number; // epoch ms
  modelId: string;
  level: OptimizationLevel;
  originalTokens: number;
  optimizedTokens: number;
  fromCache: boolean;
  /** USD at write time, computed by pricing-engine (input side). */
  costOriginalUsd: number;
  costOptimizedUsd: number;
  /** Tag snapshot taken when the event was written. */
  tags: TagMap;
  /** 'optimizer' = local run reported by the web app; 'chat' = live governed LLM call. */
  source?: 'optimizer' | 'chat';
  /** Exact provider output tokens (chat events only). */
  outputTokens?: number;
  /** Total real spend incl. output (chat events only). */
  actualCostUsd?: number;
}

/** Summed metrics over a set of events (totals or one bucket). */
export interface RollupTotals {
  requests: number;
  users: number;
  originalTokens: number;
  optimizedTokens: number;
  savedTokens: number;
  costOriginalUsd: number;
  costOptimizedUsd: number;
  savingsUsd: number;
  reductionPercent: number;
  /** live governed LLM calls inside the selection */
  chatRequests: number;
  /** real money paid to providers incl. output (chat events) */
  actualCostUsd: number;
}

/** One group-by bucket: e.g. all events whose cost_center = "10". */
export interface RollupBucket extends RollupTotals {
  label: string;
  /** null when this is the ungrouped overall bucket. */
  values: string[] | null;
}

/** Request body for POST /api/aggregate. */
export interface AggregateRequest {
  filters?: TagFilter[];
  groupBy?: string[];
  since?: number | null; // epoch ms, inclusive
  until?: number | null; // epoch ms, inclusive
}

/** Daily trend point (UTC date). */
export interface SeriesPoint {
  date: string; // YYYY-MM-DD
  requests: number;
  savedUsd: number;
  costUsd: number;
}

/** Response of POST /api/aggregate. */
export interface AggregateResponse {
  window: { since: number | null; until: number | null };
  filters: TagFilter[];
  groupBy: string[];
  totals: RollupTotals;
  /** savings/windowDays × 365 — labeled as a projection everywhere in UI. */
  projectedAnnualUsd: number;
  windowDays: number;
  buckets: RollupBucket[];
  series: SeriesPoint[];
}

/** Public account shape returned by /api/me. Never includes password material. */
export interface AccountInfo {
  id: number;
  email: string;
  name: string;
  tags: TagMap;
  createdAt: number;
}

/* ---------------- governed chat (live LLM interaction) ------------------- */

/** POST /api/chat body — the gateway never accepts raw-text bypass fields. */
export interface ChatRequest {
  /** the live thread; the LAST user turn is what governance screens.
   *  Usually built from the (optimized) prompt the user sees in the pane. */
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  modelId: string | 'auto';
  /** the ORIGINAL unoptimized prompt + its token counts, so the dashboard can
   *  attribute the savings the optimizer delivered on this real call. */
  originalTokens?: number;
  sentWasOptimized?: boolean;
}

export interface ChatResponseMeta {
  modelId: string;
  provider: string;
  modelName: string;
  routed: boolean; // true when AUTO chose the model
  routeReason?: string; // AUTO explanation
  inputTokens: number; // exact, from provider usage
  outputTokens: number; // exact, from provider usage
  costUsd: number; // real spend (in + out) at catalog prices
  savingsUsd: number | null; // what the optimizer saved on this call, if it ran
  governance: string; // verdict that let the call through (always 'allow')
}

export interface ChatResponse {
  text: string;
  meta: ChatResponseMeta;
}

/** Safe view of a saved provider key (never the key itself). */
export interface ProviderKeyInfo {
  provider: string;
  masked: string; // e.g. "sk-…abc1"
  addedAt: number;
}
