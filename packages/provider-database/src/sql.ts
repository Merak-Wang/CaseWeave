import { normalizeLiteral, validateQueryExpression, type QueryExpression, type QueryFieldCapability } from '@retrieval-agent/contracts'
import { grams } from './projection.js'

/** A positive required substring supplies necessary grams; OR keeps only shared necessities. */
export function necessaryGrams(e: QueryExpression): string[] {
  if (e.kind === 'literal') return grams(e.text)
  if (e.kind === 'and') return [...new Set(e.children.flatMap(necessaryGrams))]
  if (e.kind === 'or') {
    const groups = e.children.map(necessaryGrams)
    return (groups[0] ?? []).filter(gram => groups.every(group => group.includes(gram)))
  }
  return []
}

/** Only values are interpolated as bound parameters; identifiers come from this compiler. */
export function compileSql(expression: QueryExpression, fields: readonly QueryFieldCapability[], accelerate = false): { sql: string; params: unknown[] } {
  validateQueryExpression(expression, fields)
  const params: unknown[] = []
  const bind = (value: unknown): string => { params.push(value); return '?' }
  const compile = (e: QueryExpression): string => {
    switch (e.kind) {
      case 'constant': return e.value ? 'TRUE' : 'FALSE'
      case 'unknown': return 'NULL'
      case 'not': return `(NOT ${compile(e.child)})`
      case 'and': case 'or': return `(${e.children.map(compile).join(e.kind === 'and' ? ' AND ' : ' OR ')})`
      case 'literal': {
        if (e.field !== undefined) {
          const literal = bind(normalizeLiteral(e.text)); const field = bind(e.field)
          return `(SELECT MAX(LOCATE(CAST(${literal} AS BINARY),CAST(f.text_value AS BINARY))>0) FROM ra_search_field f WHERE f.generation=t.generation AND f.ticket_id=t.ticket_id AND f.field_key=${field})`
        }
        // Exact LOCATE on normalized binary text is the correctness baseline.
        const field = e.field === undefined ? '' : ` AND f.field_key=${bind(e.field)}`
        const literal = bind(normalizeLiteral(e.text))
        const exact = `EXISTS (SELECT 1 FROM ra_search_field f WHERE f.generation=t.generation AND f.ticket_id=t.ticket_id${field} AND LOCATE(CAST(${literal} AS BINARY),CAST(f.text_value AS BINARY))>0)`
        // Every bigram in a substring must occur in the same ticket; exact recheck remains mandatory.
        const first = grams(e.text)[0]
        if (!accelerate || first === undefined) return exact
        const gram = bind(first)
        return `(${exact} AND EXISTS (SELECT 1 FROM ra_gram g WHERE g.generation=t.generation AND g.ticket_id=t.ticket_id AND g.gram=${gram}))`
      }
      case 'field': {
        if (e.op === 'exists') return `EXISTS (SELECT 1 FROM ra_field_value v WHERE v.generation=t.generation AND v.ticket_id=t.ticket_id AND v.field_key=${bind(e.field)} AND v.text_value IS NOT NULL)`
        let condition: string
        if (e.op === 'eq' || e.op === 'in') condition = `v.text_value IN (${e.values!.map(v => bind(normalizeLiteral(v))).join(',')})`
        else condition = [e.lower === undefined ? undefined : `v.text_value>=${bind(normalizeLiteral(e.lower))}`,
          e.upper === undefined ? undefined : `v.text_value${e.upperInclusive ? '<=' : '<'}${bind(normalizeLiteral(e.upper))}`].filter(Boolean).join(' AND ')
        // Scalar NULL survives NOT/OR. A missing field cannot become a positive match through NOT EXISTS.
        return `(SELECT MAX(${condition}) FROM ra_field_value v WHERE v.generation=t.generation AND v.ticket_id=t.ticket_id AND v.field_key=${bind(e.field)})`
      }
    }
  }
  // SQL field scalar puts the predicate before scope: collect parameters in SQL order below.
  const sql = compile(expression)
  return { sql, params }
}
