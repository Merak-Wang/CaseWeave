import { RetrievalError } from './errors.js'
import { validateQueryExpression } from './query-plan.js'
import type { TicketFilter, TicketRetrievalRequest, TrustedPrincipalContext } from './types.js'

const RESERVED_FILTER_FIELDS = new Set([
  'tenantId', 'subjectId', 'allowedSubjectIds', 'requiredAttributes', 'piiRedactionStatus',
  'contentHash', 'rawSource', 'rawSource.payload',
])
const DATE_FILTER_FIELDS = new Set(['createdAt', 'updatedAt', 'resolvedAt'])
const CATEGORICAL_FILTER_FIELDS = new Set([
  'type', 'category', 'priority', 'status', 'language', 'region', 'product', 'component',
])

export function assertTrustedPrincipal(principal: TrustedPrincipalContext, now = Date.now()): void {
  if (principal.purpose !== 'ticket_retrieval') throw new RetrievalError('UNAUTHORIZED', '当前身份不允许执行工单检索。')
  if (principal.tenantId.trim().length === 0 || principal.subjectId.trim().length === 0 || principal.entitlementVersion.trim().length === 0) {
    throw new RetrievalError('UNAUTHORIZED', '身份上下文不完整。')
  }
  if (Number.isNaN(Date.parse(principal.issuedAt))) throw new RetrievalError('UNAUTHORIZED', '身份上下文时间无效。')
  if (principal.expiresAt !== undefined) {
    const expiry = Date.parse(principal.expiresAt)
    if (Number.isNaN(expiry) || expiry <= now) throw new RetrievalError('UNAUTHORIZED', '身份上下文已失效。')
  }
}

export function assertTicketFilterField(field: unknown): asserts field is TicketFilter['field'] {
  if (typeof field !== 'string'
    || !/^[A-Za-z][A-Za-z0-9_.:-]{0,95}$/u.test(field)
    || RESERVED_FILTER_FIELDS.has(field)) {
    throw new RetrievalError('INVALID_REQUEST', '包含不支持的工单筛选字段。')
  }
}

export function assertTicketFilter(filter: TicketFilter): void {
  const candidate = filter as { readonly field?: unknown; readonly op?: unknown; readonly value?: unknown }
  assertTicketFilterField(candidate.field)
  if (typeof candidate.value !== 'string' || candidate.value.trim().length === 0 || candidate.value.length > 256) {
    throw new RetrievalError('INVALID_REQUEST', '工单筛选值无效。')
  }
  if (!['eq', 'neq', 'gte', 'lte', 'contains'].includes(String(candidate.op))) {
    throw new RetrievalError('INVALID_REQUEST', '工单筛选操作无效。')
  }
  if (CATEGORICAL_FILTER_FIELDS.has(candidate.field) && candidate.op !== 'eq' && candidate.op !== 'neq') {
    throw new RetrievalError('INVALID_REQUEST', '枚举工单字段只支持 eq/neq。')
  }
  if (DATE_FILTER_FIELDS.has(candidate.field)) {
    if (candidate.op !== 'gte' && candidate.op !== 'lte') throw new RetrievalError('INVALID_REQUEST', '时间字段只支持 gte/lte。')
    if (Number.isNaN(Date.parse(candidate.value))) throw new RetrievalError('INVALID_REQUEST', '时间筛选值必须是有效时间。')
  }
  if (candidate.field === 'errorCodes' && candidate.op !== 'contains') {
    throw new RetrievalError('INVALID_REQUEST', '错误码字段只支持 contains。')
  }
}

export function assertTicketRetrievalRequest(request: TicketRetrievalRequest): void {
  if (request.query.trim().length === 0) throw new RetrievalError('INVALID_REQUEST', '检索问题不能为空。')
  if (request.query.length > 4_000) throw new RetrievalError('INVALID_REQUEST', '检索问题过长。')
  if (request.retrievalQuery !== undefined
    && (request.retrievalQuery.trim().length === 0 || request.retrievalQuery.length > 4_000)) {
    throw new RetrievalError('INVALID_REQUEST', '结构化后的检索文本无效。')
  }
  if (request.requestedCount !== undefined && (!Number.isSafeInteger(request.requestedCount) || request.requestedCount < 1)) {
    throw new RetrievalError('INVALID_REQUEST', '用户结果数量必须是正安全整数。')
  }
  if (request.mode !== undefined && !['keyword', 'dense', 'hybrid'].includes(request.mode)) {
    throw new RetrievalError('INVALID_REQUEST', '检索模式无效。')
  }
  if (request.countPolicy !== undefined && !['explicit', 'adaptive', 'exhaustive'].includes(request.countPolicy)) {
    throw new RetrievalError('INVALID_REQUEST', '候选数量策略无效。')
  }
  const legacyAdaptiveLimit = request.queryContract !== undefined && request.queryContract.schemaVersion <= 5
    && request.countPolicy === 'adaptive' && request.requestedCount !== undefined
  if (!legacyAdaptiveLimit && ((request.countPolicy === 'explicit') !== (request.requestedCount !== undefined))) {
    throw new RetrievalError('INVALID_REQUEST', '只有显式 Top-K 可以且必须声明用户级结果数量。')
  }
  for (const ambiguity of request.ambiguities ?? []) {
    if (!['reference', 'quantity', 'boundary', 'constraint', 'boolean_logic', 'task_type'].includes(ambiguity.kind)
      || ambiguity.text.trim().length === 0 || ambiguity.text.length > 500) {
      throw new RetrievalError('INVALID_REQUEST', '查询歧义无效。')
    }
  }
  for (const filter of request.filters ?? []) assertTicketFilter(filter)
  const contract = request.queryContract
  if (contract !== undefined) {
    const plan = contract.queryPlan
    if (plan !== undefined) {
      if (plan.schemaVersion !== 1 || plan.original !== request.query || plan.vector.text !== request.query
        || plan.normalizationVersion !== 'nfkc-lower-v1' || !Number.isFinite(Date.parse(plan.anchor.at))
        || !Array.isArray(plan.requirements) || plan.requirements.length > 128
        || plan.requirements.some(r => !Number.isInteger(r.span.start) || !Number.isInteger(r.span.end) || r.span.start < 0 || r.span.end <= r.span.start
          || plan.original.slice(r.span.start, r.span.end) !== r.span.text)) throw new RetrievalError('INVALID_REQUEST', 'QueryPlan 的身份或要求出处无效。')
      try { validateQueryExpression(plan.keyword, plan.fields); validateQueryExpression(plan.hard, plan.fields) }
      catch (error) { throw new RetrievalError('INVALID_REQUEST', 'QueryPlan 含未声明字段或非法布尔条件。', { cause: error }) }
    }
    const resultPolicyValid = ['explicit_top_k', 'adaptive_top_k', 'exhaustive_current_snapshot'].includes(contract.resultPolicy)
    const legacyBoundedResultPolicy = contract.resultPolicy === 'explicit_top_k' || contract.resultPolicy === 'adaptive_top_k'
    const effectiveCountPolicy = request.countPolicy ?? (request.requestedCount === undefined ? 'adaptive' : 'explicit')
    const expectedResultPolicy = effectiveCountPolicy === 'explicit'
      ? 'explicit_top_k'
      : effectiveCountPolicy === 'exhaustive' ? 'exhaustive_current_snapshot' : 'adaptive_top_k'
    const legacyLimitValid = contract.schemaVersion <= 5
      && contract.resultLimit === undefined
      && (contract.maxResults === undefined
        ? !legacyBoundedResultPolicy
        : legacyBoundedResultPolicy && contract.maxResults === request.requestedCount
          && Number.isSafeInteger(contract.maxResults) && contract.maxResults >= 1 && contract.maxResults <= 100)
    const currentLimitValid = contract.schemaVersion >= 6
      && contract.maxResults === undefined
      && (contract.resultLimit === undefined
        ? effectiveCountPolicy !== 'explicit' && request.requestedCount === undefined
        : effectiveCountPolicy === 'explicit' && contract.resultLimit === request.requestedCount
          && Number.isSafeInteger(contract.resultLimit) && contract.resultLimit >= 1)
    if (![1, 2, 3, 4, 5, 6, 7, 8, 9].includes(contract.schemaVersion) || contract.original !== request.query || contract.task !== request.target
      || contract.normalized !== (request.retrievalQuery ?? request.query).normalize('NFKC').trim().replace(/\s+/gu, ' ')
      || !resultPolicyValid || contract.resultPolicy !== expectedResultPolicy
      || !['telecom_ticket', 'general_ticket'].includes(contract.domain)
      || !['zh', 'en', 'und'].includes(contract.language)
      || (!legacyLimitValid && !currentLimitValid)
      || contract.compilerVersion.trim().length === 0) {
      throw new RetrievalError('INVALID_REQUEST', 'Query Contract 与检索请求不一致或包含无效字段。')
    }
    if (JSON.stringify(contract.constraints) !== JSON.stringify(request.filters ?? [])
      || JSON.stringify(contract.ambiguities) !== JSON.stringify(request.ambiguities ?? [])) {
      throw new RetrievalError('INVALID_REQUEST', 'Query Contract 的约束或歧义与检索请求不一致。')
    }
    if (contract.schemaVersion >= 8 && !Array.isArray(contract.userRequirements)) {
      throw new RetrievalError('INVALID_REQUEST', 'Query Contract 缺少用户条件来源。')
    }
    for (const requirement of contract.userRequirements ?? []) {
      if (typeof requirement.text !== 'string' || requirement.text.trim().length === 0
        || !contract.original.includes(requirement.text) || !['compiled', 'unresolved'].includes(requirement.status)
        || !Array.isArray(requirement.filters)
        || (requirement.status === 'compiled' && requirement.filters.length === 0 && !contract.queryPlan?.requirements.some(r => r.span.text === requirement.text && r.status === 'compiled'))
        || (requirement.status === 'unresolved' && (requirement.filters.length !== 0 || !requirement.reason?.trim()))) {
        throw new RetrievalError('INVALID_REQUEST', '用户条件缺少原文依据、可执行条件或未解决原因。')
      }
      for (const filter of requirement.filters) {
        assertTicketFilter(filter)
        if (!contract.constraints.some(item => JSON.stringify(item) === JSON.stringify(filter))) {
          throw new RetrievalError('INVALID_REQUEST', '已编译用户条件未应用到首轮检索。')
        }
      }
    }
    for (const entity of contract.entities) {
      if (!['business_object', 'ticket_id', 'topic'].includes(entity.type)
        || entity.surface.trim().length === 0 || entity.canonical.trim().length === 0
        || entity.surface.length > 200 || entity.canonical.length > 200) {
        throw new RetrievalError('INVALID_REQUEST', 'Query Contract 包含无效实体。')
      }
    }
    if (contract.logic !== undefined) {
      if (contract.schemaVersion < 2 || !['and', 'or'].includes(contract.logic.operator)
        || contract.logic.requiredConcepts.length < 2 || contract.logic.requiredConcepts.length > 8) {
        throw new RetrievalError('INVALID_REQUEST', 'Query Contract 包含无效的布尔查询结构。')
      }
      for (const concept of contract.logic.requiredConcepts) {
        if (concept.surface.trim().length === 0 || concept.canonical.trim().length === 0
          || concept.surface.length > 200 || concept.canonical.length > 200
          || concept.alternatives.length === 0 || concept.alternatives.length > 16
          || concept.alternatives.some(alternative => alternative.trim().length === 0 || alternative.length > 200)
          || new Set(concept.alternatives).size !== concept.alternatives.length) {
          throw new RetrievalError('INVALID_REQUEST', 'Query Contract 包含无效的必选概念。')
        }
      }
    }
    if (contract.fastQuery !== undefined) {
      const fast = contract.fastQuery
      const keyword = fast.keyword
      const keywordInvalid = keyword !== undefined && (
        !['and', 'or'].includes(keyword.operator)
        || keyword.terms.length < 1 || keyword.terms.length > 8
        || keyword.terms.some(term => term.trim().length === 0 || term.length > 200)
      )
      if (contract.schemaVersion < 3 || request.fastQuery === undefined
        || JSON.stringify(fast) !== JSON.stringify(request.fastQuery)
        || ![1, 2].includes(fast.schemaVersion) || fast.source !== 'direct_user' || fast.rewriteApplied !== false
        || fast.vector.text !== request.query
        || (fast.schemaVersion === 1 && keyword === undefined)
        || keywordInvalid) {
        throw new RetrievalError('INVALID_REQUEST', '首轮快查询计划无效或已发生改写。')
      }
    }
    if (contract.schemaVersion === 9 && contract.queryPlan === undefined) throw new RetrievalError('INVALID_REQUEST', 'Query Contract v9 必须包含 QueryPlan。')
    if (contract.schemaVersion >= 4 && contract.schemaVersion < 9 && contract.nlp === undefined) {
      throw new RetrievalError('INVALID_REQUEST', 'Query Contract v4+ 必须包含 NLP 分析轨迹。')
    }
    if (contract.nlp !== undefined) {
      const nlp = contract.nlp
      const commonInvalid = nlp.keywordTerms.length > 8
        || (contract.fastQuery?.schemaVersion === 1 && nlp.keywordTerms.length < 1)
        || JSON.stringify(nlp.keywordTerms) !== JSON.stringify(contract.fastQuery?.keyword?.terms ?? [])
        || nlp.tokens.length > 64 || nlp.triples.length > 8
      const legacyInvalid = nlp.schemaVersion === 1 && (
        contract.schemaVersion !== 4 || nlp.analyzerVersion.trim().length === 0 || nlp.analyzerVersion.length > 200
        || nlp.tokenization.trim().length === 0 || nlp.tokenization.length > 200
        || nlp.tokens.some(token => token.surface.trim().length === 0 || token.surface.length > 200
          || !['word', 'latin', 'number', 'relation', 'task', 'function'].includes(token.kind))
        || nlp.triples.some(triple => triple.subject !== 'ticket_collection'
          || !['must_contain', 'may_contain', 'topic'].includes(triple.predicate)
          || triple.object.trim().length === 0 || triple.object.length > 200)
      )
      const spacyInvalid = nlp.schemaVersion === 2 && (
        ![5, 6, 7, 8, 9].includes(contract.schemaVersion) || nlp.engine !== 'spacy'
        || [nlp.engineVersion, nlp.pipeline, nlp.pipelineVersion, nlp.lexiconVersion].some(value => value.trim().length === 0 || value.length > 200)
        || nlp.tokens.some((token, index) => token.surface.trim().length === 0 || token.surface.length > 200
          || !Number.isSafeInteger(token.start) || !Number.isSafeInteger(token.end) || token.start < 0 || token.end <= token.start
          || token.end > contract.original.length || token.head < 0 || token.head >= nlp.tokens.length || !Number.isSafeInteger(token.head)
          || [token.pos, token.tag, token.dep].some(value => value.trim().length === 0 || value.length > 100)
          || token.lemma.length > 200 || token.entityType.length > 100 || index > 63)
        || nlp.entities.length > 32
        || nlp.entities.some(entity => entity.surface.trim().length === 0 || entity.surface.length > 200
          || entity.label.trim().length === 0 || entity.label.length > 100
          || !Number.isSafeInteger(entity.start) || !Number.isSafeInteger(entity.end)
          || entity.start < 0 || entity.end <= entity.start || entity.end > contract.original.length)
        || nlp.triples.some(triple => [triple.subject, triple.predicate, triple.object].some(value => value.trim().length === 0 || value.length > 200)
          || !['dependency', 'coordination'].includes(triple.source))
      )
      if (contract.schemaVersion < 4 || commonInvalid || (nlp.schemaVersion !== 1 && nlp.schemaVersion !== 2)
        || legacyInvalid || spacyInvalid) {
        throw new RetrievalError('INVALID_REQUEST', 'Query Contract 的 NLP 分析轨迹无效。')
      }
    }
  }
}
