/** Model-authored recall hints and business predicate; no business Boolean compiler. */
export interface SemanticQueryPlan {
  readonly schemaVersion: 1
  readonly original: string
  readonly instruction: string
  readonly keywords: readonly string[]
  readonly retrieval_expressions: readonly string[]
  readonly goal: { readonly mode: 'adaptive' | 'examples' | 'all'; readonly count: number | null }
  readonly steps: readonly { readonly id: string; readonly op: SemanticOperator; readonly inputs: readonly string[];
    readonly instruction: string; readonly params: Readonly<Record<string, unknown>> }[]
  readonly manifest_id: string
  readonly inputGeneration: number
}
export type SemanticOperator = 'sem_search' | 'sem_filter' | 'sem_extract' | 'sem_agg'
export interface OperatorPassage {
  readonly id: string; readonly field: string; readonly text: string; readonly start: number
  readonly origin: 'source' | 'generated' | 'unknown'
}
export interface OperatorRecord {
  readonly ref: string; readonly version: string; readonly content_hash: string
  readonly passages: readonly OperatorPassage[]; readonly attributes: Readonly<Record<string, unknown>>
  readonly vectors?: readonly (readonly number[])[]
  readonly embedding_id?: string
}
export interface OperatorCitation {
  readonly ref: string; readonly version: string; readonly content_hash: string; readonly passage_id: string
  readonly field: string; readonly start: number; readonly end: number; readonly quote: string; readonly origin: string
}
export interface OperatorDecision {
  readonly ref: string; readonly label: 'accept' | 'exclude' | 'undetermined'
  readonly citations: readonly OperatorCitation[]; readonly knowledge_ids: readonly string[]
  readonly basis: 'model' | 'reused_model' | 'proxy' | 'unresolved'; readonly reason: string
  readonly manifest_id: string | null
  readonly inference?: { readonly algorithm: string; readonly proposal: string; readonly phase: string;
    readonly model_id?: string; readonly predicate_key?: string; readonly input_revision?: number; readonly feature_id?: string;
    readonly training_records?: number; readonly fit_count?: number; readonly score?: number;
    readonly source_version?: string; readonly content_hash?: string;
    readonly checks?: readonly { readonly region: string; readonly population: number; readonly sampled: number;
      readonly errors: number; readonly error_upper: number; readonly alpha: number; readonly tolerance: number; readonly passed: boolean }[];
    readonly proposed: number; readonly inferred: boolean;
    readonly population?: number; readonly sampled?: number; readonly errors?: number; readonly remaining?: number;
    readonly error_upper?: number; readonly alpha?: number; readonly tolerance?: number } | null
}
export interface OperatorArtifact {
  readonly id: string; readonly operation: SemanticOperator; readonly inputGeneration: number
  readonly candidateRefs: readonly string[]; readonly manifestIds: readonly string[]; readonly events: readonly unknown[]
}

/** 一份模型/质量说明 + 紧凑结果块；不复制逐条 teacher 引文。 */
export interface LearnedResult {
  readonly model_id: string; readonly input_revision: number; readonly predicate_key: string;
  readonly feature_id: string; readonly returned: number; readonly scope_count: number;
  readonly quality: { readonly precision_lower: number | null; readonly recall_lower: number | null;
    readonly precision_target: number; readonly recall_target: number; readonly [key: string]: unknown };
  readonly metadata: Readonly<Record<string, unknown>>;
}
export interface NumericPredictionBlock {
  readonly model_id: string; readonly offset: number; readonly ids: readonly number[];
  readonly labels: readonly number[]; readonly scores: readonly number[];
}
export interface SemanticResultStore {
  begin(taskId: string, modelId: string): Promise<void>
  write(taskId: string, block: NumericPredictionBlock): Promise<void>
  page(taskId: string, modelId: string, offset: number, limit: number): Promise<{ ids: number[]; scores: number[] }>
  count(taskId: string, modelId: string): Promise<number>
}
