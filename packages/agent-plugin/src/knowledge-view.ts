import { RetrievalError, type RetrievalState } from '@retrieval-agent/contracts'
import { openWiki, revokedKnowledge } from './wiki-store.js'
import type { PublishedWikiEntry } from './wiki-types.js'

export type KnowledgeSummary = Pick<PublishedWikiEntry, 'id' | 'reference' | 'title' | 'domain' | 'scope' | 'revision' | 'kind' | 'keywords'> & { revoked: boolean }
export interface KnowledgeView {
  releaseId?: string
  status: 'available' | 'empty' | 'disabled' | 'preparing'
  domains: { id: string; title: string; entries: KnowledgeSummary[] }[]
  entry?: PublishedWikiEntry
}

/** Called only after task/source authorization. Never accepts a release or file path from the browser. */
export async function readTaskKnowledge(root: string | undefined, state: RetrievalState, entryId?: string): Promise<KnowledgeView> {
  const catalog = state.knowledgeCatalog
  if (!root || !catalog?.releaseId || catalog.status !== 'available') {
    if (entryId) throw new RetrievalError('INVALID_REQUEST', '此任务没有可读取的知识条目。')
    return { status: catalog?.status ?? 'preparing', domains: [] }
  }
  if (entryId && !catalog.domains.some(d => d.entryIds.includes(entryId))) throw new RetrievalError('INVALID_REQUEST', '知识条目不属于此任务的知识库。')
  try {
    const wiki = await openWiki(root, { releaseId: catalog.releaseId })
    const entries = catalog.domains.flatMap(d => d.entryIds.map(id => wiki.read(id)))
    const revoked = new Set(await revokedKnowledge(root, entries.map(e => e.reference)))
    if (entryId && revoked.has(wiki.read(entryId).reference)) throw new RetrievalError('INVALID_TRANSITION', '这条知识已停用，正文不再展示。')
    return { status: 'available', releaseId: catalog.releaseId,
      domains: catalog.domains.map(d => ({ id: d.id, title: d.description, entries: entries.filter(e => e.domain === d.id).map(e => ({
        id: e.id, reference: e.reference, title: e.title, domain: e.domain, scope: e.scope, revision: e.revision,
        kind: e.kind, keywords: e.keywords, revoked: revoked.has(e.reference),
      })) })), ...(entryId ? { entry: wiki.read(entryId) } : {}) }
  } catch (e) {
    if (e instanceof RetrievalError) throw e
    throw new RetrievalError('PROVIDER_UNAVAILABLE', '知识库暂时无法读取，请稍后重试。', { retryable: true })
  }
}
