import {
  RetrievalError,
  assertTicketFilter,
  assertTicketFilterField,
  type TicketQueryDelta,
  type TicketRetrievalSpec,
} from '@retrieval-agent/contracts'

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.normalize('NFKC').trim()).filter(Boolean))]
}

export function applyQueryDelta(spec: TicketRetrievalSpec, delta: TicketQueryDelta | undefined): TicketRetrievalSpec {
  if (delta === undefined) return spec
  switch (delta.kind) {
    case 'add_terms': {
      const terms = unique(delta.terms)
      if (terms.length === 0) throw new RetrievalError('INVALID_REQUEST', '查询修复词不能为空。')
      return { ...spec, normalizedQuery: `${spec.normalizedQuery} ${terms.join(' ')}`.trim() }
    }
    case 'exclude_terms': {
      const terms = unique(delta.terms)
      if (terms.length === 0) throw new RetrievalError('INVALID_REQUEST', '排除词不能为空。')
      return { ...spec, excludedTerms: unique([...spec.excludedTerms, ...terms]) }
    }
    case 'add_filter':
      assertTicketFilter(delta.filter)
      return { ...spec, filters: [...spec.filters.filter(filter => filter.field !== delta.filter.field), delta.filter] }
    case 'remove_filter':
      assertTicketFilterField(delta.field)
      return { ...spec, filters: spec.filters.filter(filter => filter.field !== delta.field) }
    case 'semantic_hint': {
      const hint = delta.text.normalize('NFKC').trim()
      if (hint.length === 0) throw new RetrievalError('INVALID_REQUEST', '语义提示不能为空。')
      return { ...spec, semanticHints: unique([...spec.semanticHints, hint]) }
    }
    default:
      return delta satisfies never
  }
}
