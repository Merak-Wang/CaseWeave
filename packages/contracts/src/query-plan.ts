/** Parser-independent, sourced Boolean expressions. SQL NULL follows three-valued logic. */
export type QueryExpression =
  | { readonly kind: 'constant'; readonly value: boolean }
  | { readonly kind: 'and' | 'or'; readonly children: readonly QueryExpression[] }
  | { readonly kind: 'not'; readonly child: QueryExpression }
  | { readonly kind: 'literal'; readonly op: 'contains' | 'phrase'; readonly text: string; readonly field?: string }
  | { readonly kind: 'field'; readonly field: string; readonly op: 'eq' | 'in' | 'range' | 'exists'; readonly values?: readonly string[]; readonly lower?: string; readonly upper?: string; readonly upperInclusive?: boolean }
  | { readonly kind: 'unknown'; readonly requirementId: string }

export interface QueryFieldCapability {
  readonly key: string
  readonly searchable: boolean
  readonly operations: readonly ('eq' | 'in' | 'range' | 'exists' | 'contains' | 'phrase')[]
  readonly availability: 'available' | 'partial' | 'unavailable'
  readonly origin: 'source' | 'generated'
  readonly source: string
}

export interface QueryPlan {
  readonly schemaVersion: 1
  readonly original: string
  readonly anchor: { readonly at: string; readonly timeZone: string }
  readonly normalizationVersion: 'nfkc-lower-v1'
  readonly keyword: QueryExpression
  /** Common necessary hard conditions; keyword hypotheses are never imposed on vectors. */
  readonly hard: QueryExpression
  readonly vector: { readonly text: string }
  readonly requirements: readonly {
    readonly id: string
    readonly span: { readonly start: number; readonly end: number; readonly text: string }
    readonly interpretation: string
    readonly kind: 'hard' | 'keyword' | 'semantic'
    readonly status: 'compiled' | 'unresolved' | 'evidence_required'
    readonly expression?: QueryExpression
  }[]
  readonly unresolved: readonly string[]
  readonly fields: readonly QueryFieldCapability[]
  readonly parserVersion: string
  readonly elapsedMs: number
}

export const normalizeLiteral = (text: string): string => text.normalize('NFKC').toLowerCase()
export type QueryTruth = boolean | null
export interface QueryDocument {
  readonly texts: Readonly<Record<string, readonly string[]>>
  readonly fields: Readonly<Record<string, string | readonly string[] | null>>
}

export function evaluateQuery(expression: QueryExpression, document: QueryDocument): QueryTruth {
  switch (expression.kind) {
    case 'constant': return expression.value
    case 'unknown': return null
    case 'not': { const v = evaluateQuery(expression.child, document); return v === null ? null : !v }
    case 'and': case 'or': {
      const values = expression.children.map(child => evaluateQuery(child, document))
      if (expression.kind === 'and') return values.includes(false) ? false : values.includes(null) ? null : true
      return values.includes(true) ? true : values.includes(null) ? null : false
    }
    case 'literal': {
      const values = expression.field === undefined ? Object.values(document.texts).flat() : document.texts[expression.field]
      if (values === undefined || (expression.field !== undefined && values.length === 0)) return null
      return values.some(value => normalizeLiteral(value).includes(normalizeLiteral(expression.text)))
    }
    case 'field': {
      const value = document.fields[expression.field]
      if (expression.op === 'exists') return value !== undefined && value !== null && (typeof value === 'string' || value.length > 0)
      if (value === undefined || value === null || (typeof value !== 'string' && value.length === 0)) return null
      const values = typeof value === 'string' ? [value] : value
      if (expression.op === 'eq' || expression.op === 'in') return values.some(v => expression.values?.some(w => normalizeLiteral(v) === normalizeLiteral(w)))
      return values.some(v => (expression.lower === undefined || v >= expression.lower)
        && (expression.upper === undefined || (expression.upperInclusive ? v <= expression.upper : v < expression.upper)))
    }
  }
}

export function validateQueryExpression(expression: QueryExpression, fields: readonly QueryFieldCapability[], depth = 0): void {
  if (depth > 24 || expression === null || typeof expression !== 'object') throw new TypeError('Invalid or excessively nested QueryExpression')
  switch (expression.kind) {
    case 'constant': if (typeof expression.value !== 'boolean') throw new TypeError('Invalid constant'); return
    case 'unknown': if (!expression.requirementId) throw new TypeError('Missing requirement'); return
    case 'not': validateQueryExpression(expression.child, fields, depth + 1); return
    case 'and': case 'or':
      if (!Array.isArray(expression.children) || expression.children.length < 1 || expression.children.length > 64) throw new TypeError('Invalid Boolean group')
      expression.children.forEach(child => validateQueryExpression(child, fields, depth + 1)); return
    case 'literal':
      if (!['contains', 'phrase'].includes(expression.op) || typeof expression.text !== 'string' || !expression.text.trim() || expression.text.length > 2000) throw new TypeError('Invalid literal')
      if (expression.field !== undefined && !fields.some(field => field.key === expression.field && field.searchable)) throw new TypeError(`Unsupported search field: ${expression.field}`)
      return
    case 'field': {
      if (!fields.some(field => field.key === expression.field && field.operations.includes(expression.op))) throw new TypeError(`Unsupported field operation: ${expression.field}/${expression.op}`)
      if (['eq', 'in'].includes(expression.op) && (!expression.values?.length || expression.values.length > 128 || expression.values.some(v => typeof v !== 'string' || v.length > 2000))) throw new TypeError('Invalid field values')
      if (expression.op === 'range' && expression.lower === undefined && expression.upper === undefined) throw new TypeError('Empty range')
      return
    }
    default: throw new TypeError('Unknown QueryExpression kind')
  }
}
