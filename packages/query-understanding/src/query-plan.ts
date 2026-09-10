import type { QueryExpression, QueryFieldCapability, QueryPlan, TicketFilter } from '@retrieval-agent/contracts'
import { compileUserConditions } from './conditions.js'

const TRUE: QueryExpression = { kind: 'constant', value: true }
export function hasDisjunction(expression: QueryExpression): boolean {
  return expression.kind === 'or' || expression.kind === 'and' && expression.children.some(hasDisjunction)
    || expression.kind === 'not' && hasDisjunction(expression.child)
}
export interface QueryPlanParser {
  parse(input: { readonly query: string; readonly now: Date; readonly timeZone: string; readonly fields: readonly QueryFieldCapability[] }, signal?: AbortSignal): Promise<QueryPlan>
}
const FALSE: QueryExpression = { kind: 'constant', value: false }
export const DEFAULT_QUERY_FIELDS: readonly QueryFieldCapability[] = [
  ...['displayId', 'region', 'status', 'product', 'component', 'type', 'category', 'priority', 'language', 'createdAt', 'updatedAt', 'resolvedAt', 'errorCodes'].map(key => ({
    key, searchable: false, operations: ['eq', 'in', 'range', 'exists'] as const,
    availability: 'partial' as const, origin: 'source' as const, source: `ticket.${key}`,
  })),
  ...['title', 'summary', 'body', 'problemDescription', 'resolution'].map(key => ({
    key, searchable: true, operations: ['contains', 'phrase', 'exists'] as const,
    availability: 'partial' as const, origin: 'source' as const, source: `ticket.${key}`,
  })),
]
export function booleanGroup(kind: 'and' | 'or', children: readonly QueryExpression[]): QueryExpression {
  if (children.some(e => e.kind === 'constant' && e.value === (kind === 'or'))) return kind === 'and' ? FALSE : TRUE
  const retained = children.filter(e => e.kind !== 'constant')
  return retained.length === 0 ? (kind === 'and' ? TRUE : FALSE) : retained.length === 1 ? retained[0]! : { kind, children: retained }
}
export function filterExpression(filter: TicketFilter): QueryExpression {
  if (filter.op === 'gte' || filter.op === 'lte') return { kind: 'field', field: filter.field, op: 'range',
    ...(filter.op === 'gte' ? { lower: filter.value } : { upper: filter.value, upperInclusive: true }) }
  const eq: QueryExpression = { kind: 'field', field: filter.field, op: filter.op === 'contains' ? 'in' : 'eq', values: [filter.value] }
  return filter.op === 'neq' ? { kind: 'not', child: eq } : eq
}

/** Rules consume raw source spans. NLP provides only optional surface terms, never the business AST. */
export function compileQueryPlan(original: string, terms: readonly string[], options: {
  readonly now?: Date; readonly timeZone?: string; readonly fields?: readonly QueryFieldCapability[]
} = {}): QueryPlan {
  const started = performance.now()
  const now = options.now ?? new Date()
  const timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const fields = options.fields ?? DEFAULT_QUERY_FIELDS
  const requirements: QueryPlan['requirements'][number][] = []
  const unresolved: string[] = []
  const requirement = (start: number, end: number, kind: 'hard' | 'keyword' | 'semantic', status: 'compiled' | 'unresolved' | 'evidence_required', interpretation: string, expression?: QueryExpression, polarity?: 'exclude'): string => {
    const id = `r${requirements.length + 1}`
    requirements.push({ id, span: { start, end, text: original.slice(start, end) }, kind, status, interpretation,
      ...(expression === undefined ? {} : { expression }), ...(polarity ? { polarity } : {}) })
    if (status === 'unresolved') unresolved.push(id)
    return id
  }
  // Mask semantic exclusions without shifting offsets; their terms must not enter lexical search.
  let source = original
  const explicitIntersection = /同时(?:出现|包含|含有|命中)|(?:两者|二者|关键词)都(?:出现|包含)|\bAND\b|并且|而且|且|既.+又/iu.test(original)
  for (const match of original.matchAll(/(?:排除|不要|不包括|不纳入|不计入)[^，,。；;()（）]*(?:导致|引起|造成|原因|(?:已|完成|解除|取消|结束|恢复)[^，,。；;()（）]{0,12}后|仅剩|只剩)[^，,。；;()（）]*/gu)) {
    requirement(match.index, match.index + match[0].length, 'semantic', 'evidence_required', '根据来源证据核对业务对象、时序或原因排除；整项条件不能变为字面 NOT 或正向召回分支', undefined, 'exclude')
    source = source.slice(0, match.index) + ' '.repeat(match[0].length) + source.slice(match.index + match[0].length)
  }
  type Pair = { keyword: QueryExpression; hard: QueryExpression }
  function parse(start: number, end: number, depth = 0): Pair {
    while (start < end && /[\s，,、。的]/u.test(source[start]!)) start++
    while (end > start && /[\s，,、。的]/u.test(source[end - 1]!)) end--
    if (start >= end) return { keyword: TRUE, hard: TRUE }
    if (depth > 24) throw new TypeError('Query Boolean nesting exceeds 24')
    // Find outer operators while respecting literal quotes and nested parentheses.
    let nesting = 0; let quote = ''; let outerClose = -1
    const splits: { start: number; end: number; kind: 'and' | 'or'; topical: boolean }[] = []
    for (let i = start; i < end; i++) {
      const c = source[i]!
      if (quote) { if (c === quote) quote = ''; continue }
      if ('"“\'‘'.includes(c)) { quote = c === '“' ? '”' : c === '‘' ? '’' : c; continue }
      if ('(（'.includes(c)) { nesting++; continue }
      if (')）'.includes(c)) { nesting--; if (nesting === 0) outerClose = i; continue }
      if (nesting !== 0) continue
      // A conjunction character inside one supplied source term is part of that word.
      if (!/[A-Za-z]/u.test(c) && terms.some(term => term.length > 1 && source.lastIndexOf(term, i) >= start
        && source.lastIndexOf(term, i) + term.length > i)) continue
      const match = source.slice(i, end).match(/^(\bOR\b|或者|或是|或|\bAND\b|并且|而且|且|和|与)/iu)
      if (match) {
        const topical = /^[和与]$/u.test(match[0]) && !explicitIntersection
        splits.push({ start: i, end: i + match[0].length, kind: topical || /OR|或/iu.test(match[0]) ? 'or' : 'and', topical }); i += match[0].length - 1
      }
    }
    if (nesting !== 0 || quote) {
      const id = requirement(start, end, 'hard', 'unresolved', '括号或引号不匹配')
      return { keyword: { kind: 'unknown', requirementId: id }, hard: { kind: 'unknown', requirementId: id } }
    }
    const chosen = splits.filter(s => s.kind === (splits.some(s => s.kind === 'or') ? 'or' : 'and'))
    if (chosen.length) {
      const parts: Pair[] = []; let cursor = start
      for (const split of chosen) { parts.push(parse(cursor, split.start, depth + 1)); cursor = split.end }
      parts.push(parse(cursor, end, depth + 1))
      const kind = chosen[0]!.kind
      return { keyword: booleanGroup(kind, parts.map(p => p.keyword)), hard: booleanGroup(chosen.every(s => s.topical) ? 'and' : kind, parts.map(p => p.hard)) }
    }
    if ('(（'.includes(source[start]!) && outerClose === end - 1) return parse(start + 1, end - 1, depth + 1)
    const text = source.slice(start, end)
    const not = text.match(/^NOT\s+/iu)
    if (not) {
      const child = parse(start + not[0].length, end, depth + 1)
      // Explicit NOT names a literal even when the NLP stop-word pass omitted that operand.
      const operand = child.keyword.kind === 'constant' && child.keyword.value
        ? { kind: 'literal' as const, op: 'contains' as const, text: text.slice(not[0].length).trim() } : child.keyword
      const expr: QueryExpression = { kind: 'not', child: operand }
      requirement(start, end, 'hard', 'compiled', '明确字面 NOT', expr)
      return { keyword: expr, hard: expr }
    }
    const hard: QueryExpression[] = []; const lexical: QueryExpression[] = []
    const masked: { start: number; end: number }[] = []
    for (const match of text.matchAll(/(?:(正文|标题|摘要|处理结论)\s*)?(包含|含有|不包含|不出现|不得出现|出现)?\s*[“"‘']([^”"’']+)[”"’']/gu)) {
      if (!match[1] && !match[2] && /(?:属于|是否符合|是否满足)\s*$/u.test(text.slice(0, match.index))) {
        requirement(start + match.index, start + match.index + match[0].length, 'semantic', 'evidence_required', '引号命名待核查的业务范围，不要求来源逐字出现范围名称')
        masked.push({ start: match.index, end: match.index + match[0].length })
        continue
      }
      const field = ({ 正文: 'body', 标题: 'title', 摘要: 'summary', 处理结论: 'resolution' } as Record<string, string>)[match[1] ?? '']
      let expr: QueryExpression = { kind: 'literal', op: 'phrase', text: match[3]!, ...(field === undefined ? {} : { field }) }
      if (/不/u.test(match[2] ?? '')) expr = { kind: 'not', child: expr }
      hard.push(expr); masked.push({ start: match.index, end: match.index + match[0].length })
      requirement(start + match.index, start + match.index + match[0].length, 'hard', 'compiled', '明确字面短语', expr)
    }
    for (const match of text.matchAll(/(处理结论|地区|状态|创建时间)(?:为|是)?(空|未知|不存在|非空|不为空)/gu)) {
      const field = ({ 处理结论: 'resolution', 地区: 'region', 状态: 'status', 创建时间: 'createdAt' } as Record<string, string>)[match[1]!]!
      const exists: QueryExpression = { kind: 'field', field, op: 'exists' }
      const expr: QueryExpression = /非空|不为空/u.test(match[2]!) ? exists : { kind: 'not', child: exists }
      hard.push(expr); masked.push({ start: match.index, end: match.index + match[0].length })
      requirement(start + match.index, start + match.index + match[0].length, 'hard', 'compiled', '显式空值条件', expr)
    }
    const conditions = compileUserConditions(text, [], now, timeZone)
    for (const item of conditions.userRequirements) {
      const offset = text.indexOf(item.text)
      if (masked.some(m => offset >= m.start && offset < m.end)) continue
      const expr = booleanGroup('and', item.filters.map(filterExpression))
      const supported = item.status === 'compiled' && item.filters.every(f => fields.some(c => c.key === f.field && c.availability !== 'unavailable'))
      const id = requirement(start + offset, start + offset + item.text.length, 'hard', supported ? 'compiled' : 'unresolved', item.reason ?? '来源字段条件', supported ? expr : undefined)
      hard.push(supported ? expr : { kind: 'unknown', requirementId: id })
      masked.push({ start: offset, end: offset + item.text.length })
    }
    // Reading/delivery instructions describe the workflow, not ticket contents. Keep
    // quoted text and business operands intact, and mask only these source spans.
    for (const pattern of [
      /^(?:请|帮我|请帮我)?(?:查找|查询|寻找|找出|找|查)/gu,
      /(?:请)?(?:读取|核对|查看|阅读)(?:工单的?)?(?:原始|完整)?(?:对话|原文|正文)(?:后)?/gu,
      /(?:请)?(?:给出|提供|下载|导出|生成)(?:该工单的?|其)?(?:确认结果|检索报告|报告|CSV|JSONL)/giu,
      /(?:只(?:需(?:要)?|要)|返回|给我)\s*\d+\s*(?:条|个)(?:工单)?/gu,
    ]) for (const match of text.matchAll(pattern)) {
      const end = match.index + match[0].length
      if (!masked.some(m => match.index < m.end && end > m.start)) masked.push({ start: match.index, end })
    }
    const clauseTerms = terms.filter(term => {
      if (term === '工单' || term === '工单号') return false // Unquoted object names are not business text requirements.
      for (let at = text.indexOf(term); at >= 0; at = text.indexOf(term, at + 1)) {
        if (!masked.some(m => at < m.end && at + term.length > m.start)) return true
      }
      return false
    })
    for (const term of clauseTerms) {
      const expr: QueryExpression = { kind: 'literal', op: 'contains', text: term }
      lexical.push(expr); const offset = text.indexOf(term)
      requirement(start + offset, start + offset + term.length, 'keyword', 'compiled', '原文关键词', expr)
    }
    if (/状态历史|重新打开|由.+变成/u.test(text)) {
      const id = requirement(start, end, 'hard', 'unresolved', '当前静态字段不能证明状态历史')
      hard.push({ kind: 'unknown', requirementId: id })
    }
    return { keyword: booleanGroup('and', [...hard, ...(lexical.length ? [booleanGroup(explicitIntersection ? 'and' : 'or', lexical)] : [])]), hard: booleanGroup('and', hard) }
  }
  const pair = parse(0, source.length)
  return { schemaVersion: 1, original, anchor: { at: now.toISOString(), timeZone }, normalizationVersion: 'nfkc-lower-v1',
    keyword: pair.keyword.kind === 'constant' && pair.keyword.value ? FALSE : pair.keyword, hard: pair.hard, vector: { text: original }, requirements, unresolved, fields, parserVersion: 'sourced-rules-v3-semantic-exclusions', elapsedMs: performance.now() - started }
}
