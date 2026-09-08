import type { TicketFilter, TicketQueryAmbiguity, TicketUserRequirement } from '@retrieval-agent/contracts'
import type { SpacyEntityResponse } from './protocol.js'

type CalendarDate = { year: number; month: number; day: number }

const PROVINCES = /北京|天津|上海|重庆|河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|海南|四川|贵州|云南|陕西|甘肃|青海|台湾|内蒙古|广西|西藏|宁夏|新疆|香港|澳门/gu
const NUMBER = '[0-9零一二两三四五六七八九十百千万]+'
const DATE = '(?:[0-9]{4}[-/][0-9]{1,2}[-/][0-9]{1,2}|[0-9]{4}\\s*年\\s*[0-9]{1,2}\\s*月\\s*[0-9]{1,2}\\s*[日号]?)'

export function positiveUserCount(text: string): number | undefined {
  const normalized = text.normalize('NFKC')
  if (/^[0-9]+$/u.test(normalized)) {
    const value = Number(normalized)
    return Number.isSafeInteger(value) && value > 0 ? value : undefined
  }
  if (normalized.length > 1 && !/[十百千万]/u.test(normalized)) return undefined
  const digits: Readonly<Record<string, number>> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  const units: Readonly<Record<string, number>> = { 十: 10, 百: 100, 千: 1_000, 万: 10_000 }
  let total = 0
  let section = 0
  let current = 0
  for (const character of normalized) {
    if (digits[character] !== undefined) current = digits[character]
    else if (units[character] !== undefined) {
      const unit = units[character]
      if (unit === 10_000) { total += (section + current) * unit; section = 0 }
      else section += (current || 1) * unit
      current = 0
    } else return undefined
  }
  const value = total + section + current
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/** Quantity syntax belongs to result semantics; dates, durations and ticket numbers are excluded. */
export function explicitUserCount(query: string): number | undefined {
  const patterns = [
    new RegExp(`(?:前|top\\s*)(${NUMBER})(?=\\s*(?:条|个|件|份|工单|cases?\\b|tickets?\\b|[，。,.]|$))`, 'iu'),
    new RegExp(`(?:只需|仅需|找|查找|返回|给我|列出|收集|要|需要|找出|取|推荐|展示)\\s*(${NUMBER})\\s*(?:条|个|件|份)(?!月|星期|小时|天|周|年)`, 'u'),
    new RegExp(`\\b(?:find|return|list|collect)\\s+(${NUMBER})\\s+(?:tickets?|cases?)\\b`, 'iu'),
  ]
  for (const pattern of patterns) {
    const match = query.match(pattern)
    if (match !== null) {
      const value = positiveUserCount(match[1]!)
      if (value === undefined && /^[0-9]+$/u.test(match[1]!)) throw new TypeError('用户结果数量必须在可表示的正安全整数范围内。')
      return value
    }
  }
  return undefined
}

function localDate(value: Date, timeZone: string): CalendarDate {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(value)
  const part = (type: string): number => Number(parts.find(item => item.type === type)!.value)
  return { year: part('year'), month: part('month'), day: part('day') }
}

function calendar(year: number, month: number, day: number): CalendarDate | undefined {
  const value = new Date(Date.UTC(year, month - 1, day))
  return value.getUTCFullYear() === year && value.getUTCMonth() === month - 1 && value.getUTCDate() === day
    ? { year, month, day } : undefined
}

function parseDate(text: string): CalendarDate | undefined {
  const parts = text.match(/[0-9]+/gu)!.map(Number)
  return calendar(parts[0]!, parts[1]!, parts[2]!)
}

function shiftDays(date: CalendarDate, delta: number): CalendarDate {
  const value = new Date(Date.UTC(date.year, date.month - 1, date.day + delta))
  return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate() }
}

function shiftMonths(date: CalendarDate, delta: number): CalendarDate {
  const first = new Date(Date.UTC(date.year, date.month - 1 + delta, 1))
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate()
  return { year: first.getUTCFullYear(), month: first.getUTCMonth() + 1, day: Math.min(date.day, lastDay) }
}

/** Convert calendar boundaries using the request zone, including daylight-saving offsets. */
function midnight(date: CalendarDate, timeZone: string): number {
  const target = Date.UTC(date.year, date.month - 1, date.day)
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  })
  let value = target
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = formatter.formatToParts(new Date(value))
    const part = (type: string): number => Number(parts.find(item => item.type === type)!.value)
    const local = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'))
    if (local === target) return value
    value += target - local
  }
  throw new TypeError('请求时区中的日期边界无法唯一解析。')
}

function timeField(query: string, index: number, length: number): string {
  const prefix = query.slice(Math.max(0, index - 20), index)
  if (/(?:解决|办结|关闭)(?:日期|时间)[为在从：:\s]*$/u.test(prefix)) return 'resolvedAt'
  if (/更新(?:日期|时间)[为在从：:\s]*$/u.test(prefix)) return 'updatedAt'
  // “7月已解决的工单”“已解决的7月工单”都指在7月解决，而不是创建于7月。
  if (/(?:已)?(?:解决|办结|关闭|完成)(?:的)?\s*$/u.test(prefix)) return 'resolvedAt'
  if (/^\s*(?:的\s*)?(?:已)?(?:解决|办结|关闭|完成)/u.test(query.slice(index + length))) return 'resolvedAt'
  return 'createdAt'
}

export function compileUserConditions(query: string, entities: readonly SpacyEntityResponse[], now: Date, timeZone: string): {
  filters: TicketFilter[]; ambiguities: TicketQueryAmbiguity[]; userRequirements: TicketUserRequirement[]
} {
  const requirements: TicketUserRequirement[] = []
  const compiledSpans: { start: number; end: number }[] = []
  const add = (text: string, filters: TicketFilter[]): void => {
    if (!requirements.some(item => item.text === text && JSON.stringify(item.filters) === JSON.stringify(filters))) {
      requirements.push({ text, filters, status: 'compiled' })
    }
  }
  const unresolved = (text: string, reason: string): void => {
    if (!requirements.some(item => item.text === text)) requirements.push({ text, filters: [], status: 'unresolved', reason })
  }
  const remember = (match: RegExpMatchArray): void => { compiledSpans.push({ start: match.index!, end: match.index! + match[0].length }) }
  const covered = (start: number, end: number): boolean => compiledSpans.some(span => start >= span.start && end <= span.end)
  const dateExcluded = (index: number): boolean => /(?:排除|除了|不在|不是|不要|非)(?:(?:创建|更新|解决|办结|关闭)(?:日期|时间))?[为在从：:\s]*$/u.test(query.slice(0, index))
  const range = (text: string, field: string, start: CalendarDate, end: CalendarDate, exactEnd?: number): void => {
    if (dateExcluded(query.indexOf(text))) {
      unresolved(text, '排除日期范围不能编译为相反的包含条件，需要进一步明确。')
      return
    }
    const lower = midnight(start, timeZone)
    const upper = exactEnd ?? midnight(shiftDays(end, 1), timeZone) - 1
    if (lower > upper) { unresolved(text, '日期范围的开始晚于结束。'); return }
    add(text, [{ field, op: 'gte', value: new Date(lower).toISOString() }, { field, op: 'lte', value: new Date(upper).toISOString() }])
  }

  for (const match of query.matchAll(new RegExp(`(${DATE})\\s*(?:至|到|—|~|～|\\bto\\b)\\s*(${DATE})`, 'gu'))) {
    const start = parseDate(match[1]!)
    const end = parseDate(match[2]!)
    if (start === undefined || end === undefined) unresolved(match[0], '日期不是有效的日历日期。')
    else range(match[0], timeField(query, match.index, match[0].length), start, end)
    remember(match)
  }
  for (const match of query.matchAll(new RegExp(DATE, 'gu'))) {
    if (covered(match.index, match.index + match[0].length)) continue
    const date = parseDate(match[0])
    if (date === undefined) unresolved(match[0], '日期不是有效的日历日期。')
    else if (dateExcluded(match.index)) unresolved(match[0], '排除日期范围不能编译为相反的包含条件，需要进一步明确。')
    else {
      const suffix = query.slice(match.index + match[0].length).trimStart()
      const prefix = query.slice(0, match.index)
      const field = timeField(query, match.index, match[0].length)
      if (/^(?:以|之)后/u.test(suffix)) add(match[0], [{ field, op: 'gte', value: new Date(midnight(shiftDays(date, 1), timeZone)).toISOString() }])
      else if (/^(?:以|之)前/u.test(suffix)) add(match[0], [{ field, op: 'lte', value: new Date(midnight(date, timeZone) - 1).toISOString() }])
      else if (/^起/u.test(suffix) || /(?:不早于|从|自)\s*$/u.test(prefix)) add(match[0], [{ field, op: 'gte', value: new Date(midnight(date, timeZone)).toISOString() }])
      else if (/^止/u.test(suffix) || /(?:截至|截止|不晚于)\s*$/u.test(prefix)) add(match[0], [{ field, op: 'lte', value: new Date(midnight(shiftDays(date, 1), timeZone) - 1).toISOString() }])
      else range(match[0], field, date, date)
    }
    remember(match)
  }
  for (const match of query.matchAll(/([0-9]{4})\s*年\s*([0-9]{1,2})\s*月/gu)) {
    if (covered(match.index, match.index + match[0].length)) continue
    const start = calendar(Number(match[1]), Number(match[2]), 1)
    if (start === undefined) unresolved(match[0], '月份不是有效的日历月份。')
    else range(match[0], timeField(query, match.index, match[0].length), start, shiftDays(shiftMonths(start, 1), -1))
    remember(match)
  }
  const today = localDate(now, timeZone)
  for (const match of query.matchAll(new RegExp(`(?:最近|近|过去)(${NUMBER})(?:个)?(天|日|周|星期|月|年)`, 'gu'))) {
    const amount = positiveUserCount(match[1]!)
    if (amount === undefined || amount > 10_000) unresolved(match[0], '相对日期跨度无法可靠解析。')
    else {
      const unit = match[2]!
      const start = unit === '月' || unit === '年' ? shiftMonths(today, -amount * (unit === '年' ? 12 : 1))
        : shiftDays(today, -amount * (unit === '周' || unit === '星期' ? 7 : 1))
      range(match[0], timeField(query, match.index, match[0].length), start, today, now.getTime())
    }
    remember(match)
  }
  for (const match of query.matchAll(/今天|昨天|本月|这个月|上个月|上月/gu)) {
    if (covered(match.index, match.index + match[0].length)) continue
    const start = match[0] === '昨天' ? shiftDays(today, -1) : match[0] === '今天' ? today
      : shiftMonths({ ...today, day: 1 }, /上/u.test(match[0]) ? -1 : 0)
    const end = match[0] === '昨天' || match[0] === '今天' ? start : shiftDays(shiftMonths(start, 1), -1)
    range(match[0], timeField(query, match.index, match[0].length), start, end, /今天|本月|这个月/u.test(match[0]) ? now.getTime() : undefined)
    remember(match)
  }
  for (const match of query.matchAll(/最近|近期|近来|这段时间|[0-9一二三四五六七八九十]+\s*月/gu)) {
    if (!covered(match.index, match.index + match[0].length)) unresolved(match[0], '时间条件缺少明确的年份或日期范围。')
  }
  for (const entity of entities) {
    if (['DATE', 'TIME'].includes(entity.label) && query.slice(entity.start, entity.end) === entity.text
      && !covered(entity.start, entity.end)) unresolved(entity.text, '时间表达尚不能可靠编译，请明确日期范围。')
  }

  const geographic = [...query.matchAll(PROVINCES)].map(match => match[0])
  for (const entity of entities) {
    if (['GPE', 'LOC'].includes(entity.label) && query.slice(entity.start, entity.end) === entity.text) geographic.push(entity.text)
  }
  const macroRegions = /(?:华东|华南|华北|华中|东北|西北|西南|附近|当地|本地)(?:地区)?/gu
  for (const match of query.matchAll(macroRegions)) unresolved(match[0], '地域范围需要明确可用的地区名称，当前不支持区域层级推断。')
  const regions = [...new Set(geographic)].filter(text => !/华东|华南|华北|华中|东北|西北|西南|附近|当地|本地/u.test(text))
  const distinctRegions = regions.filter(text => !regions.some(other => other !== text && other.includes(text)))
  // A scoped inclusion plus separately stated exclusions is already unambiguous.
  // Keep compound alternatives and unscoped mentions for the model/user to resolve.
  const explicitRegions = distinctRegions.map(text => {
    const index = query.indexOf(text), prefix = query.slice(0, index)
    const op = /(?:排除|除了|非|不在|不是|不要)\s*$/u.test(prefix) ? 'neq'
      : /(?:只看|只查|只查询|只要|仅看|仅查|仅查询|限于|仅限)\s*$/u.test(prefix) ? 'eq' : undefined
    return { text, op }
  })
  const explicitConjunction = distinctRegions.length > 1 && explicitRegions.every(item => item.op)
    && explicitRegions.filter(item => item.op === 'eq').length <= 1
    && distinctRegions.every(text => query.indexOf(text) === query.lastIndexOf(text))
    && !/(?:或|还是|\bor\b)/iu.test(query)
  for (const text of distinctRegions) {
    if (explicitConjunction) add(text, [{ field: 'region', op: explicitRegions.find(item => item.text === text)!.op as 'eq' | 'neq', value: text.replace(/(?:省|市)$/u, '') }])
    else if (distinctRegions.length > 1) unresolved(text, '存在多个地域，需确认它们的逻辑关系和字段映射。')
    else if (/^(?:附近|周边)/u.test(query.slice(query.indexOf(text) + text.length))) unresolved(text, '附近或周边地区需要明确地域范围，不能作为该城市的等值条件。')
    else add(text, [{ field: 'region', op: /(?:排除|除了|非|不在|不是|不要)\s*$/u.test(query.slice(0, query.indexOf(text)))
      || /^(?:以外|之外)/u.test(query.slice(query.indexOf(text) + text.length)) ? 'neq' : 'eq', value: text.replace(/(?:省|市)$/u, '') }])
  }
  for (const match of query.matchAll(/(?:地域|地区|region)\s*[:：=]\s*([^\s，,；;。]+)/giu)) {
    if (requirements.some(item => match[0].includes(item.text))) continue
    add(match[0], [{ field: 'region', op: 'eq', value: match[1]! }])
  }
  const statusMatches = [...query.matchAll(/已解决|未解决|处理中|待处理|已关闭|已办结|未办结|已完成/gu)]
  for (const match of statusMatches) {
    if (new Set(statusMatches.map(item => item[0])).size > 1) unresolved(match[0], '存在多个状态，需确认状态条件的逻辑关系。')
    else add(match[0], [{ field: 'status', op: /(?:排除|除了|非|不是|不要)\s*$/u.test(query.slice(0, match.index)) ? 'neq' : 'eq', value: match[0] }])
  }
  for (const match of query.matchAll(/(?:状态|status)\s*[:：=为]\s*([^\s，,；;。的]+)/giu)) {
    if (!requirements.some(item => match[0].includes(item.text))) add(match[0], [{ field: 'status', op: 'eq', value: match[1]! }])
  }
  const identities = [...query.matchAll(/(?:工单(?:编号|号码|号)|ticket\s*(?:id|number)|编号)\s*[:：#为]?\s*([A-Za-z0-9][A-Za-z0-9_.:/-]{0,127})/giu)]
  // “工单 ESFT-…”省略“号”的说法：只有紧跟完整编号形态（字母+数字+连字符）才按已知工单编译，
  // 数量、日期或普通名词不会被误当成编号。
  if (identities.length === 0) {
    for (const match of query.matchAll(/(?:工单|ticket)\s*[:：#]?\s*([A-Za-z0-9][A-Za-z0-9_.:/-]{0,127})/giu)) {
      const value = match[1]!
      if (/[A-Za-z]/u.test(value) && /[0-9]/u.test(value) && value.includes('-')) identities.push(match)
    }
  }
  if (identities.length === 0) identities.push(...query.matchAll(/\bTKT-[0-9]+\b/gu))
  for (const match of identities) {
    if (identities.length > 1) unresolved(match[0], '多个工单编号需要集合查询，不能编译成相互冲突的等值条件。')
    else add(match[0], [{ field: 'displayId', op: 'eq', value: match[1] ?? match[0] }])
  }
  const uncertainQuantities = new Set<string>()
  for (const match of query.matchAll(new RegExp(`(${NUMBER})\\s*(?:到|至|[-~～])\\s*(${NUMBER})\\s*(?:条|个|件)(?!月|小时|天|周|年)|(?:三五|若干|几)\\s*(?:条|个|件)(?!月|小时|天|周|年)`, 'gu'))) {
    uncertainQuantities.add(match[0])
    unresolved(match[0], '数量范围尚未确定为精确结果目标。')
  }
  const userRequirements = requirements
  const filters = [...new Map(requirements.flatMap(item => item.filters).map(filter => [JSON.stringify(filter), filter])).values()]
  const ambiguities: TicketQueryAmbiguity[] = requirements.filter(item => item.status === 'unresolved')
    .map(item => ({ kind: uncertainQuantities.has(item.text) ? 'quantity' : 'constraint', text: `${item.text}：${item.reason}` }))
  return { filters, ambiguities, userRequirements }
}
