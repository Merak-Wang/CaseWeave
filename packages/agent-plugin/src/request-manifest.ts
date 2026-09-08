import { createHash } from 'node:crypto'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { ContextManifest, RetrievalState } from '@retrieval-agent/contracts'

/** Recover only exact controlled projections from the actual immutable DSH request envelope. */
export function requestManifest(state: RetrievalState, options: GenerateOptions, roleId: string, estimatedTokens: number): ContextManifest {
  const strings = (v: unknown): string[] => typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(strings)
    : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : []
  // Message source/section metadata is for DSH replay and UI, not provider-visible content.
  const text = options.messages.flatMap(m => strings(m.content)).join('\n')
  const parse = (tag: string): Record<string, unknown>[] => [...text.matchAll(new RegExp(`<${tag}>(.*?)</${tag}>`, 'gs'))].flatMap(m => {
    try { return [JSON.parse(m[1]!) as Record<string, unknown>] } catch { return [] }
  })
  const candidates = parse('untrusted_ticket_candidate').flatMap(value => {
    const match = /^c([1-9]\d*)$/u.exec(String(value.alias))
    const candidate = match ? state.candidateHistory[Number(match[1]) - 1] : undefined
    return candidate && state.candidates.some(c => c.ref === candidate.ref) && candidate.title === value.title && candidate.summary === value.summary ? [candidate.ref] : []
  })
  const evidence = parse('untrusted_ticket_evidence').flatMap(value => {
    const match = /^e([1-9]\d*)$/u.exec(String(value.alias))
    const item = match ? state.promotedEvidence[Number(match[1]) - 1] : undefined
    return item && item.text === value.text && item.field === value.field && item.start === value.start && item.end === value.end
      && state.candidates.some(c => c.ref === item.candidateRef) ? [item] : []
  })
  const knowledge = parse('untrusted_retrieval_knowledge').flatMap(block => Array.isArray(block.entries) ? block.entries : [])
  const task = state.expertTasks?.find(t => t.id === roleId)
  const serialized = JSON.stringify({ system: options.system, tools: options.tools, messages: options.messages })
  const renderedHash = createHash('sha256').update(serialized).digest('hex')
  return { id: createHash('sha256').update(`${roleId}:${state.stateId}:${renderedHash}`).digest('hex'), roleId,
    stateId: state.stateId, inputGeneration: state.inputGeneration ?? 0, candidateRefs: [...new Set(candidates)],
    evidenceIds: [...new Set(evidence.map(e => e.evidenceId))], evidenceSpans: evidence.map(e => ({ evidenceId: e.evidenceId,
      start: e.start, end: e.end, contentHash: e.spanHash ?? e.contentHash })),
    knowledgeRefs: knowledge.flatMap(e => e && typeof e === 'object' && typeof e.reference === 'string' && task?.knowledgeRefs.includes(e.reference) ? [e.reference] : []),
    ...(task?.releaseId ? { releaseId: task.releaseId } : {}), renderedHash, estimatedTokens, measurement: 'dsh_request' }
}
