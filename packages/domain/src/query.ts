import {
  RetrievalError,
  assertTicketFilter,
  assertTicketFilterField,
  type TicketFilter,
  type TicketQueryChange,
  type TicketQueryDelta,
  type TicketRetrievalSpec,
} from '@retrieval-agent/contracts'

const MAX_QUERY_CHANGES_PER_SEARCH = 8

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.normalize('NFKC').trim()).filter(Boolean))]
}

export function applyQueryDelta(spec: TicketRetrievalSpec, delta: TicketQueryDelta | undefined): TicketRetrievalSpec {
  if (delta === undefined) return spec
  if (delta.kind !== 'batch') return applyQueryChange(spec, delta)
  if (delta.changes.length === 0 || delta.changes.length > MAX_QUERY_CHANGES_PER_SEARCH) {
    throw new RetrievalError(
      'INVALID_REQUEST',
      `一次查询修复必须包含 1–${MAX_QUERY_CHANGES_PER_SEARCH} 个变更。`,
    )
  }
  return delta.changes.reduce<TicketRetrievalSpec>(
    (current, change) => applyQueryChange(current, change),
    spec,
  )
}

function isRangeFilter(filter: TicketFilter): boolean {
  return filter.op === 'gte' || filter.op === 'lte'
}

function conflictsWithIncomingFilter(current: TicketFilter, incoming: TicketFilter): boolean {
  if (current.field !== incoming.field) return false
  return !(isRangeFilter(current) && isRangeFilter(incoming) && current.op !== incoming.op)
}

function assertOrderedRange(filters: readonly TicketFilter[], field: string): void {
  const lower = filters.find(filter => filter.field === field && filter.op === 'gte')
  const upper = filters.find(filter => filter.field === field && filter.op === 'lte')
  if (lower === undefined || upper === undefined) return
  const lowerTimestamp = Date.parse(lower.value)
  const upperTimestamp = Date.parse(upper.value)
  if (Number.isFinite(lowerTimestamp) && Number.isFinite(upperTimestamp) && lowerTimestamp > upperTimestamp) {
    throw new RetrievalError('INVALID_REQUEST', `${field} 的起始时间不能晚于结束时间。`)
  }
}

function applyQueryChange(spec: TicketRetrievalSpec, delta: TicketQueryChange): TicketRetrievalSpec {
  switch (delta.kind) {
    case 'add_terms': {
      const terms = unique(delta.terms)
      if (terms.length === 0) throw new RetrievalError('INVALID_REQUEST', '查询修复词不能为空。')
      return {
        ...spec,
        normalizedQuery: `${spec.normalizedQuery} ${terms.join(' ')}`.trim(),
        keywordQuery: {
          terms: unique([...(spec.keywordQuery?.terms ?? []), ...terms]),
          operator: spec.keywordQuery?.operator ?? 'and',
        },
      }
    }
    case 'replace_terms': {
      const terms = unique(delta.terms)
      if (terms.length === 0) throw new RetrievalError('INVALID_REQUEST', '重写后的关键词不能为空。')
      return {
        ...spec,
        normalizedQuery: terms.join(delta.operator === 'and' ? ' 和 ' : ' 或 '),
        keywordQuery: { terms, operator: delta.operator },
      }
    }
    case 'exclude_terms': {
      const terms = unique(delta.terms)
      if (terms.length === 0) throw new RetrievalError('INVALID_REQUEST', '排除词不能为空。')
      return { ...spec, excludedTerms: unique([...spec.excludedTerms, ...terms]) }
    }
    case 'add_filter': {
      assertTicketFilter(delta.filter)
      const filters = [
        ...spec.filters.filter(filter => !conflictsWithIncomingFilter(filter, delta.filter)),
        delta.filter,
      ]
      assertOrderedRange(filters, delta.filter.field)
      return { ...spec, filters }
    }
    case 'remove_filter':
      assertTicketFilterField(delta.field)
      return { ...spec, filters: spec.filters.filter(filter => filter.field !== delta.field) }
    case 'semantic_hint': {
      const hint = delta.text.normalize('NFKC').trim()
      if (hint.length === 0) throw new RetrievalError('INVALID_REQUEST', '语义提示不能为空。')
      return { ...spec, semanticHints: unique([...spec.semanticHints, hint]) }
    }
    case 'rewrite_semantic_query': {
      const text = delta.text.normalize('NFKC').trim().replace(/\s+/gu, ' ')
      if (text.length === 0) throw new RetrievalError('INVALID_REQUEST', '改写后的语义查询不能为空。')
      return { ...spec, semanticQuery: text, semanticHints: [] }
    }
    default:
      return delta satisfies never
  }
}
