import type {
  TicketFilter,
  TicketQueryAmbiguity,
  TicketRetrievalRequest,
  TicketTaskTarget,
} from '@retrieval-agent/contracts'

export interface DirectQueryCompilerConfig {
  readonly adaptiveMaxResults?: number
  readonly now?: () => Date
}
const REGION_NAMES = [
  '北京', '天津', '上海', '重庆', '河北', '山西', '辽宁', '吉林', '黑龙江', '江苏', '浙江',
  '安徽', '福建', '江西', '山东', '河南', '湖北', '湖南', '广东', '海南', '四川', '贵州', '云南',
  '陕西', '甘肃', '青海', '台湾', '内蒙古', '广西', '西藏', '宁夏', '新疆', '香港', '澳门',
] as const

const CHINESE_DIGITS: Readonly<Record<string, number>> = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
}

function chineseInteger(text: string): number | undefined {
  if (text === '十') return 10
  if (text.includes('十')) {
    const [tensText, onesText] = text.split('十')
    const tens = tensText === '' ? 1 : CHINESE_DIGITS[tensText!]
    const ones = onesText === '' ? 0 : CHINESE_DIGITS[onesText!]
    return tens === undefined || ones === undefined ? undefined : tens * 10 + ones
  }
  return CHINESE_DIGITS[text]
}

function requestedCount(query: string): { readonly count?: number; readonly matched?: string } {
  const match = query.match(/(?:前|最多|返回|给我|找出|查找|列出|要)?\s*(\d{1,2}|[一二两三四五六七八九十]{1,3})\s*(?:条|张|件|笔|份|个(?!月))(?:工单|记录|结果)?/u)
  if (match === null) return {}
  const count = /^\d+$/u.test(match[1]!) ? Number(match[1]) : chineseInteger(match[1]!)
  return count === undefined || count < 1 || count > 50 ? {} : { count, matched: match[0] }
}

function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function relativeDateFilter(query: string, now: Date): { readonly filter?: TicketFilter; readonly matched?: string } {
  const match = query.match(/(?:最近|近)\s*(\d{1,3}|[一二两三四五六七八九十]{1,3})\s*(天|周|个月|月)/u)
  if (match === null) return {}
  const amount = /^\d+$/u.test(match[1]!) ? Number(match[1]) : chineseInteger(match[1]!)
  if (amount === undefined || amount < 1 || amount > 365) return {}
  const days = match[2] === '天' ? amount : match[2] === '周' ? amount * 7 : amount * 30
  return {
    filter: {
      field: 'createdAt',
      op: 'gte',
      value: dateOnly(new Date(now.getTime() - days * 24 * 60 * 60 * 1_000)),
    },
    matched: match[0],
  }
}

function extractFilters(query: string, now: Date): {
  readonly filters: TicketFilter[]
  readonly matched: string[]
  readonly ambiguities: TicketQueryAmbiguity[]
} {
  const filters: TicketFilter[] = []
  const matched: string[] = []
  const ambiguities: TicketQueryAmbiguity[] = []
  const regions = REGION_NAMES.filter(region => query.includes(region))
  if (regions.length === 1) {
    filters.push({ field: 'region', op: 'eq', value: regions[0]! })
    matched.push(`${regions[0]}地区`, `${regions[0]}省`, `${regions[0]}市`, regions[0]!)
  } else if (regions.length > 1) {
    ambiguities.push({ kind: 'constraint', text: `查询同时包含多个地区：${regions.join('、')}` })
  }
  for (const [value, pattern] of [
    ['已解决', /已解决|已经解决/u],
    ['未解决', /未解决|尚未解决/u],
    ['处理中', /处理中|正在处理/u],
  ] as const) {
    const found = query.match(pattern)?.[0]
    if (found !== undefined) {
      filters.push({ field: 'status', op: 'eq', value })
      matched.push(found)
      break
    }
  }
  for (const [value, pattern] of [
    ['高', /高优先级|优先级为?高/u],
    ['中', /中优先级|优先级为?中/u],
    ['低', /低优先级|优先级为?低/u],
  ] as const) {
    const found = query.match(pattern)?.[0]
    if (found !== undefined) {
      filters.push({ field: 'priority', op: 'eq', value })
      matched.push(found)
      break
    }
  }
  const relative = relativeDateFilter(query, now)
  if (relative.filter !== undefined) filters.push(relative.filter)
  if (relative.matched !== undefined) matched.push(relative.matched)
  return { filters, matched, ambiguities }
}

function targetFor(query: string, filters: readonly TicketFilter[]): TicketTaskTarget {
  if (/如何(?:处理|解决)|怎么(?:处理|解决)|解决方案|处理方法|历史上.*解决/u.test(query)) return 'resolution_path'
  if (/全部|所有|完整集合|汇总|收集|有哪些(?:同类|相关)?工单/u.test(query)) return 'cohort_collection'
  if (filters.length > 0) return 'constrained_list'
  return 'ranked_cases'
}

function retrievalText(query: string, removals: readonly string[]): string {
  let text = query
  for (const removal of [...new Set(removals)].sort((left, right) => right.length - left.length)) {
    if (removal.length > 0) text = text.replaceAll(removal, ' ')
  }
  text = text
    .replace(/^(?:请|麻烦)?(?:帮我)?(?:查询|查找|找出|找|检索|返回|列出|收集|汇总)\s*/u, '')
    .replace(/如何(?:处理|解决)[:：]?|怎么(?:处理|解决)[:：]?/gu, ' ')
    .replace(/(?:全部|所有|相关的?|类似的?|同类的?)?\s*(?:历史)?工单(?:集合|记录|结果)?/gu, ' ')
    .replace(/有没有|有哪些|最好是|给我/gu, ' ')
    .replace(/[，,。；;：:]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/^的+|的+$/gu, '')
  return text.length === 0 ? query.trim() : text
}

/** Compile accepted direct-user text before the zero-LLM initial Hybrid. */
export function compileDirectTicketQuery(
  rawQuery: string,
  config: DirectQueryCompilerConfig = {},
): TicketRetrievalRequest {
  const query = rawQuery.normalize('NFKC').trim().replace(/\s+/gu, ' ')
  const maxResults = config.adaptiveMaxResults ?? 20
  if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > 50) {
    throw new TypeError('adaptiveMaxResults must be an integer between 1 and 50')
  }
  const count = requestedCount(query)
  const extracted = extractFilters(query, (config.now ?? (() => new Date()))())
  const ambiguities = [...extracted.ambiguities]
  if (/(?:这个|这类|上述|前面)(?:问题|情况|工单)?/u.test(query)) {
    ambiguities.push({ kind: 'reference', text: '查询包含依赖会话上下文的指代。' })
  }
  return {
    target: targetFor(query, extracted.filters),
    query: rawQuery,
    retrievalQuery: retrievalText(query, [count.matched ?? '', ...extracted.matched]),
    retrievalIntent: /TKT[-_ ]?\d+|工单号|编号为/u.test(query) ? 'known_item' : 'analogous_case',
    requestedCount: count.count ?? maxResults,
    countPolicy: count.count === undefined ? 'adaptive' : 'explicit',
    filters: extracted.filters,
    ambiguities,
  }
}
