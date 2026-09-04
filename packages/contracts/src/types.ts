import type {
  RetrievalId,
  TicketCandidateRef,
  TicketEvidenceId,
  TicketId,
  TicketSnapshotId,
} from './brand.js'
import type { TicketRetrievalMode, TicketSearchTrace } from './ranking.js'
/** Trusted identity established by the product host, never by a model or browser field. */
export interface TrustedPrincipalContext {
  readonly tenantId: string
  readonly subjectId: string
  readonly entitlementVersion: string
  readonly purpose: 'ticket_retrieval'
  readonly attributes: Readonly<Record<string, readonly string[]>>
  readonly issuedAt: string
  readonly expiresAt?: string
}
/** User-level retrieval target. */
export type TicketTaskTarget = 'ranked_cases' | 'constrained_list' | 'cohort_collection' | 'resolution_path'
/** Ranked retrieval intent, independent from the target set semantics. */
export type TicketRetrievalIntent = 'known_item' | 'analogous_case'
export type TicketCountPolicy = 'explicit' | 'adaptive' | 'exhaustive'
export interface TicketQueryAmbiguity {
  readonly kind: 'reference' | 'quantity' | 'boundary' | 'constraint' | 'boolean_logic' | 'task_type'
  readonly text: string
}
export interface TicketQueryEntity {
  readonly type: 'business_object' | 'ticket_id' | 'topic'
  readonly surface: string
  readonly canonical: string
}

/** An explicit requirement retains the user's surface even when it cannot yet be compiled. */
export interface TicketUserRequirement {
  readonly text: string
  readonly status: 'compiled' | 'unresolved'
  readonly filters: readonly TicketFilter[]
  readonly reason?: string
}

/** Legacy deterministic NLP trace retained so persisted Query Contract v4 remains readable. */
export interface TicketQueryNlpTraceV4 {
  readonly schemaVersion: 1
  readonly analyzerVersion: string
  readonly tokenization: string
  readonly keywordTerms: readonly string[]
  readonly tokens: readonly {
    readonly surface: string
    readonly kind: 'word' | 'latin' | 'number' | 'relation' | 'task' | 'function'
  }[]
  readonly triples: readonly {
    readonly subject: 'ticket_collection'
    readonly predicate: 'must_contain' | 'may_contain' | 'topic'
    readonly object: string
  }[]
}

/** Replayable spaCy POS/dependency provenance used by Query Contract v5-v6. */
export interface TicketQueryNlpTraceV5 {
  readonly schemaVersion: 2
  readonly engine: 'spacy'
  readonly engineVersion: string
  readonly pipeline: string
  readonly pipelineVersion: string
  readonly lexiconVersion: string
  readonly keywordTerms: readonly string[]
  readonly tokens: readonly {
    readonly surface: string
    readonly start: number
    readonly end: number
    readonly lemma: string
    readonly pos: string
    readonly tag: string
    readonly dep: string
    readonly head: number
    readonly isStop: boolean
    readonly entityType: string
  }[]
  readonly entities: readonly {
    readonly surface: string
    readonly label: string
    readonly start: number
    readonly end: number
  }[]
  readonly triples: readonly {
    readonly subject: string
    readonly predicate: string
    readonly object: string
    readonly source: 'dependency' | 'coordination'
  }[]
}

export type TicketQueryNlpTrace = TicketQueryNlpTraceV4 | TicketQueryNlpTraceV5

/** One semantic concept extracted from explicit user syntax. */
export interface TicketQueryConcept {
  readonly surface: string
  readonly canonical: string
  /** Provider-executable lexical variants for this concept; one variant is sufficient. */
  readonly alternatives: readonly string[]
}

/** Explicit Boolean meaning extracted from the direct-user query. */
export interface TicketQueryLogic {
  readonly operator: 'and' | 'or'
  /** Concepts keep user surfaces; alternatives are explanation-only on the initial fast path. */
  readonly requiredConcepts: readonly TicketQueryConcept[]
  readonly grouping?: 'single_set' | 'separate_sets'
}

/**
 * Immutable zero-rewrite plan for the first low-cost search. The keyword and
 * vector channels consume direct-user material and run against one snapshot.
 */
interface TicketFastQueryPlanBase {
  readonly source: 'direct_user'
  readonly rewriteApplied: false
  readonly vector: {
    /** Exact direct-user query; normalization and Agent repairs are later stages. */
    readonly text: string
  }
}

interface TicketFastKeywordQuery {
  readonly terms: readonly string[]
  readonly operator: 'and' | 'or'
}

/** v1 always has a keyword channel; v2 may skip it when no usable surface term exists. */
export type TicketFastQueryPlan =
  | TicketFastQueryPlanBase & { readonly schemaVersion: 1; readonly keyword: TicketFastKeywordQuery }
  | TicketFastQueryPlanBase & { readonly schemaVersion: 2; readonly keyword?: TicketFastKeywordQuery }
/**
 * Harness-owned interpretation of one direct-user query. This is persisted
 * before Provider access so a retrieval can explain exactly which task,
 * language, domain, entities, constraints, and result-set policy it used.
 */
export interface TicketQueryContract {
  /** Version 8 records sourced user requirements; older persisted contracts remain readable. */
  readonly schemaVersion: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8
  readonly original: string
  readonly normalized: string
  readonly task: TicketTaskTarget
  readonly resultPolicy: 'explicit_top_k' | 'adaptive_top_k' | 'exhaustive_current_snapshot'
  /** Legacy v1-v5 result bound. Version 6+ writers must not emit this field. */
  readonly maxResults?: number
  /** Version 6+ user-level explicit Top-K limit. Adaptive and exhaustive contracts omit it. */
  readonly resultLimit?: number
  readonly domain: 'telecom_ticket' | 'general_ticket'
  readonly language: 'zh' | 'en' | 'und'
  readonly entities: readonly TicketQueryEntity[]
  /** Current executable conditions, including clear requirements admitted before the first search. */
  readonly constraints: readonly TicketFilter[]
  /** Required for v8. Search hypotheses cannot silently weaken these user requirements. */
  readonly userRequirements?: readonly TicketUserRequirement[]
  readonly logic?: TicketQueryLogic
  readonly fastQuery?: TicketFastQueryPlan
  readonly nlp?: TicketQueryNlpTrace
  readonly ambiguities: readonly TicketQueryAmbiguity[]
  /** Syntax provenance, not an empirically calibrated probability. */
  readonly interpretationBasis?: 'deterministic_syntax' | 'clarification_required'
  readonly compilerVersion: string
}
export type TicketFilterOperator = 'eq' | 'neq' | 'gte' | 'lte' | 'contains'

/** Provider-declared query field. Syntax is validated centrally; support is enforced by the Provider. */
export interface TicketFilter {
  readonly field: string
  readonly op: TicketFilterOperator
  readonly value: string
}

/** One controller-admitted modification to an existing query. */
export type TicketQueryChange =
  | { readonly kind: 'add_terms'; readonly terms: readonly string[] }
  | { readonly kind: 'replace_terms'; readonly terms: readonly string[]; readonly operator: 'and' | 'or' }
  | { readonly kind: 'exclude_terms'; readonly terms: readonly string[] }
  | { readonly kind: 'add_filter'; readonly filter: TicketFilter }
  | { readonly kind: 'remove_filter'; readonly field: string }
  | { readonly kind: 'semantic_hint'; readonly text: string }
  | { readonly kind: 'rewrite_semantic_query'; readonly text: string }

/** One atomic query repair, or several changes validated before a single Provider search. */
export type TicketQueryDelta = TicketQueryChange | {
  readonly kind: 'batch'
  readonly changes: readonly TicketQueryChange[]
}

/** Initial consumer request before provider defaults are applied. */
export interface TicketRetrievalRequest {
  readonly target: TicketTaskTarget
  /** Exact direct-user text retained for provenance. */
  readonly query: string
  /** Normalized retrieval view; explicit business conditions are carried separately in filters. */
  readonly retrievalQuery?: string
  readonly retrievalIntent?: TicketRetrievalIntent
  /** User-level result policy. Omission means adaptive; it is independent from task target. */
  readonly requestedCount?: number
  readonly countPolicy?: TicketCountPolicy
  readonly mode?: TicketRetrievalMode
  readonly filters?: readonly TicketFilter[]
  readonly ambiguities?: readonly TicketQueryAmbiguity[]
  /** Present only for the direct-user initial path; repairs never mutate it. */
  readonly fastQuery?: TicketFastQueryPlan
  /** Present on the public direct-user path; manual/provider callers may omit it. */
  readonly queryContract?: TicketQueryContract
}

/** Fully validated query specification. */
export interface TicketRetrievalSpec {
  readonly target: TicketTaskTarget
  readonly originalQuery: string
  readonly normalizedQuery: string
  readonly retrievalIntent?: TicketRetrievalIntent
  /** User-level explicit Top-K limit. Adaptive and exhaustive specifications omit it. */
  readonly requestedCount?: number
  readonly countPolicy: TicketCountPolicy
  readonly mode: TicketRetrievalMode
  readonly filters: readonly TicketFilter[]
  /** Explanation of explicit user logic; only the keyword channel applies it on the fast path. */
  readonly requiredConcepts?: readonly TicketQueryConcept[]
  readonly keywordQuery?: { readonly terms: readonly string[]; readonly operator: 'and' | 'or' }
  readonly semanticQuery?: string
  /** Immutable proof that the initial two channels were not Agent-rewritten. */
  readonly fastQuery?: TicketFastQueryPlan
  readonly ambiguities: readonly TicketQueryAmbiguity[]
  readonly excludedTerms: readonly string[]
  readonly semanticHints: readonly string[]
  readonly compilerVersion: string
}

/** Provider-issued authorization and data snapshot. */
export interface TicketSnapshot {
  readonly snapshotId: TicketSnapshotId
  readonly shortId: string
  readonly providerId: string
  readonly createdAt: string
  readonly expiresAt?: string
  readonly sourceVersion: string
  readonly indexVersion: string
  readonly retrievalProfileVersion: string
  readonly authorizationVersion: string
  readonly principalBindingHash: string
  readonly queryPolicyVersion: string
  /** Versioned data vocabulary exposed for this authorized snapshot. */
  readonly fieldCatalog: readonly TicketFieldDescriptor[]
  readonly capabilities: {
    readonly exhaustive: boolean
    readonly pagination: boolean
    readonly evidencePromotion: boolean
    /** Host-facing L2 detail projection. */
    readonly detailRead: boolean
    /** Dedicated, reauthorized single-ticket L3 source read. */
    readonly exportRead: boolean
    readonly keywordSearch: true
    readonly denseSearch: boolean
    readonly hybridFusion: boolean
    readonly reranking: boolean
  }
}

export interface TicketFieldDescriptor {
  readonly key: string
  readonly label: string
  readonly valueKind: 'keyword' | 'datetime' | 'text' | 'string_list' | 'raw_json'
  readonly accessLevel: 'L0' | 'L1' | 'L2' | 'L3'
  readonly filterOperators: readonly TicketFilterOperator[]
  readonly sensitivity: 'non_sensitive' | 'source_controlled'
}

/** Already-authorized display value. `sourcePath` is provenance, not an access path. */
export interface TicketDisplayField {
  readonly key: string
  readonly label: string
  readonly value: string
  readonly sourcePath: string
}

/** L0 fields approved for candidate-list display. */
export interface TicketL0 {
  readonly createdAt?: string
  readonly updatedAt?: string
  readonly resolvedAt?: string
  readonly type?: string
  readonly category?: string
  readonly product?: string
  readonly component?: string
  readonly region?: string
  readonly status?: string
  readonly priority?: string
  readonly language?: string
  readonly additionalFields?: readonly TicketDisplayField[]
}

/** Authorized title and summary. Legacy L2 markers are migrated by field meaning. */
export interface TicketCandidate {
  readonly ref: TicketCandidateRef
  readonly displayId: string
  readonly sourceVersion: string
  readonly snapshotId: TicketSnapshotId
  readonly contentHash: string
  readonly evidenceLevel: 'L1' | 'L2'
  readonly rank: number
  readonly title: string
  readonly summary: string
  readonly l0: TicketL0
  readonly matchFragments: readonly { readonly field: 'title' | 'summary'; readonly text: string; readonly truncated: boolean }[]
  /** Retrieval diagnostics, not ticket-source facts. */
  readonly matchSignals?: {
    readonly channels: readonly ('keyword' | 'vector' | 'reranker')[]
    readonly keywordTerms: readonly string[]
  }
}

export interface TicketSearchBoundaryObservation {
  readonly authorizedCorpusSize: number
  readonly documentsAfterStructuredFilters: number
  readonly documentsEligibleForKeywordChannel: number
  readonly rankedHits: number
  /** Pagination fact for this exact expression and ranking result only. */
  readonly resultPagesExhausted: boolean
  /** False unless an external, calibrated oracle can prove semantic recall. */
  readonly semanticRecallKnown: boolean
}

/** Bounded, deterministic page of authorized candidates. */
export interface TicketSearchPage {
  readonly snapshotId: TicketSnapshotId
  readonly queryFingerprint: string
  readonly candidates: readonly TicketCandidate[]
  readonly completeness: 'exhaustive' | 'bounded' | 'unknown'
  readonly nextCursor?: string
  readonly scanned: number
  readonly returned: number
  readonly elapsedMs: number
  readonly appliedFilters: readonly TicketFilter[]
  readonly warnings: readonly string[]
  readonly trace: TicketSearchTrace
  readonly boundary: TicketSearchBoundaryObservation
}

/** Provider-declared L2/L3 key. The current snapshot field catalog is the runtime allowlist. */
export type TicketEvidenceField = string

/** L2 evidence is untrusted ticket content even after authorization. */
export interface TicketEvidenceSegment {
  readonly evidenceId: TicketEvidenceId
  readonly candidateRef: TicketCandidateRef
  readonly displayId: string
  readonly sourceVersion: string
  readonly contentHash: string
  readonly field: TicketEvidenceField
  readonly text: string
  readonly start: number
  readonly end: number
  readonly estimatedTokens: number
  readonly trust: 'untrusted_ticket_evidence'
  readonly truncated: boolean
  readonly evidenceLevel?: 'L1' | 'L2'
  /** Provider receipt, model delivery, and UI reading are separate observations. */
  readonly readers?: readonly ('provider' | 'model' | 'user')[]
  readonly snapshotId?: TicketSnapshotId
  readonly authorizationVersion?: string
  readonly principalBindingHash?: string
}

export interface TicketEvidenceResult {
  readonly snapshotId: TicketSnapshotId
  readonly evidence: readonly TicketEvidenceSegment[]
  readonly requestedCandidateRefs: readonly TicketCandidateRef[]
  readonly rejectedCandidateRefs: readonly TicketCandidateRef[]
  readonly tokenBudget: number
  readonly tokensUsed: number
  readonly warnings: readonly string[]
}

/** Host-facing, reauthorized candidate detail. Internal authorization metadata is absent. */
export interface TicketDetail {
  readonly candidateRef: TicketCandidateRef
  readonly displayId: string
  readonly sourceVersion: string
  readonly title: string
  readonly summary: string
  readonly l0: TicketL0
  readonly fields: Partial<Record<TicketEvidenceField, readonly string[]>>
  readonly unavailableFields: readonly TicketEvidenceField[]
}

export interface TicketDetailResult {
  /** Same Provider evidence identities as model reads, with complete authorized fields. */
  readonly evidence?: readonly TicketEvidenceSegment[]
  readonly snapshotId: TicketSnapshotId
  readonly details: readonly TicketDetail[]
  readonly rejectedCandidateRefs: readonly TicketCandidateRef[]
  readonly warnings: readonly string[]
}

/** Historical event payload only; current Providers never return complete raw records. */
export interface LegacyRawDetail {
  readonly candidateRef: TicketCandidateRef
  readonly displayId: string
  readonly sourceVersion: string
  readonly contentHash: string
  readonly source: {
    readonly datasetId: string
    readonly datasetVersion: string
    readonly schemaVersion: string
    readonly recordId: string
  }
  readonly rawPayload: Readonly<Record<string, unknown>>
  readonly trust: 'untrusted_ticket_evidence'
}

export interface TicketProviderStatus {
  readonly providerId: string
  readonly ready: boolean
  readonly readOnly: true
  readonly sourceVersion?: string
  readonly indexVersion?: string
  readonly snapshotValid?: boolean
  readonly warnings: readonly string[]
}

/** Internal normalized source record used by providers; never returned wholesale. */
export interface NormalizedTicketRecord {
  readonly ticketId: TicketId
  readonly displayId: string
  readonly tenantId: string
  readonly allowedSubjectIds: readonly string[]
  readonly requiredAttributes: Readonly<Record<string, readonly string[]>>
  readonly sourceVersion: string
  readonly contentHash: string
  readonly createdAt?: string
  readonly updatedAt?: string
  readonly resolvedAt?: string
  readonly title: string
  readonly summary: string
  readonly problemDescription?: string
  readonly conversationOrUpdates: readonly string[]
  readonly resolutionSteps: readonly string[]
  readonly rootCause?: string
  readonly answer?: string
  readonly product?: string
  readonly component?: string
  readonly category?: string
  readonly type?: string
  readonly priority?: string
  readonly status?: string
  readonly language?: string
  readonly region?: string
  readonly errorCodes: readonly string[]
  readonly piiRedactionStatus: 'not_applicable' | 'redacted' | 'unreviewed'
  /** Optional source-native document retained inside the Provider and never projected wholesale. */
  readonly rawSource?: {
    readonly datasetId: string
    readonly datasetVersion: string
    readonly schemaVersion: string
    readonly recordId: string
    readonly payload: Readonly<Record<string, unknown>>
  }
  /** Additional source text selected by its adapter for retrieval indexing. */
  readonly searchText?: readonly string[]
  /** Authorized, source-specific L0 values that do not require a shared schema change. */
  readonly additionalFields?: readonly TicketDisplayField[]
  /** Provider-side values for source-specific filters. */
  readonly filterValues?: Readonly<Record<string, string | readonly string[]>>
  /** Source-specific L2 values. L3 raw payloads are read only from `rawSource`. */
  readonly additionalEvidence?: Readonly<Record<string, readonly string[]>>
  /** Descriptors contributed by the source adapter. */
  readonly fieldCatalog?: readonly TicketFieldDescriptor[]
}
