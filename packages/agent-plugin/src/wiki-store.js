/** Read-only, release-pinned file Wiki port. Never reads intake/source directories. */
/** @typedef {import('./wiki-types.js').PublishedWiki} PublishedWiki */
/** @typedef {import('./wiki-types.js').PublishedWikiEntry} PublishedWikiEntry */
/** @typedef {import('./wiki-types.js').WikiEntry} WikiEntry */
import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { mapWikiFiles } from './wiki-io.js'

/** @param {string | Uint8Array} data */
export const sha256 = data => createHash('sha256').update(data).digest('hex')
const identifier = { test: value => typeof value === 'string' && /^[a-z][a-z0-9-]{1,90}$/u.test(value) }
const hashPattern = /^[a-f0-9]{64}$/u
const assert = (ok, message) => { if (!ok) throw new Error(message) }
const exactKeys = (obj, names) => assert(obj && typeof obj === 'object' && Object.keys(obj).sort().join('|') === [...names].sort().join('|'), 'Unknown or missing fields')

export function assertSafeProse(text) {
  assert(typeof text === 'string', 'Invalid prose')
  const deny = [
    /\bsrc-[a-f0-9]{16}\b|来源与使用身份/iu,
    /https?:\/\/|file:\/\/|jdbc:|[a-z]:[\\/]|\\\\[a-z0-9]/iu,
    /\b\d{1,3}(?:\.\d{1,3}){3}\b|[\w.+-]+@[\w.-]+/u,
    /\d[\d -]{6,}\d|-----BEGIN|sk-[a-z0-9]{12}/iu,
    /```|~~~|<script|<iframe|!\[|\]\(/iu,
    /\b(select\s+.+from|update\s+\w+\s+set|delete\s+from|insert\s+into|curl\s|grant\s)\b/iu,
    /\b(?:tf|td|ti|ts|tl)_[a-z][a-z0-9_]+\b/iu,
    /(?:password|passwd|secret|token|authorization|cookie|api_key)\s*[:=]/iu,
    /(?:密码|密钥|口令|手机号|身份证号|银行卡号|工号)\s*[:：=]\s*\S+/u,
    /忽略.{0,12}(?:指令|规则)|ignore.{0,25}instructions|system\s*prompt/iu,
  ]
  assert(!deny.some(re => re.test(text)), 'Unsafe or operational content')
}

export function validateEntry(e) {
  exactKeys(e, ['schemaVersion','id','revision','domain','title','kind','status','authority','isTicketEvidence','scope','keywords','bodyMarkdown','evidenceChecklist','limitations','supersedes'])
  assert(e.schemaVersion === 2 && identifier.test(e.id) && identifier.test(e.domain), 'Invalid entry identity')
  assert(Number.isSafeInteger(e.revision) && e.revision > 0 && e.status === 'active'
    && ['retrieval-prior', 'retrieval-observation'].includes(e.kind), 'Unsupported entry state')
  assert(e.authority === (e.kind === 'retrieval-prior' ? 'reviewed-business-prior' : 'evidence-reviewed-observation') && e.isTicketEvidence === false, 'Invalid authority')
  for (const k of ['title', 'scope', 'bodyMarkdown']) {
    try { assertSafeProse(e[k]); assert(e[k].trim().length > 0 && e[k].length <= 16000, 'Invalid length') } catch { throw new Error(`Unsafe entry ${e.id} field ${k}`) }
  }
  for (const k of ['keywords', 'evidenceChecklist', 'limitations']) assert(Array.isArray(e[k]) && e[k].length > 0, 'Missing ' + k)
  for (const k of ['keywords', 'evidenceChecklist', 'limitations']) e[k].forEach(assertSafeProse)
  assert(Array.isArray(e.supersedes) && e.supersedes.every(s => identifier.test(s)) && new Set(e.supersedes).size === e.supersedes.length, 'Invalid supersedes')
}

/** @param {string} root @param {{releaseId?: string}} options @returns {Promise<PublishedWiki>} */
export async function openWiki(root, { releaseId } = {}) {
  try { return await readWiki(root, releaseId, 'current.json') }
  catch (error) {
    // An explicit historical identity must never silently acquire another body.
    if (releaseId) throw error
    try {
      const recovered = await readWiki(root, undefined, 'previous.json')
      if (!recovered.releaseId) throw error
      return { ...recovered, warning: '当前知识发布损坏，使用上一完整发布；旧引用保持原身份。' }
    } catch { throw error }
  }
}

async function readWiki(root, releaseId, pointerFile) {
  let canonical
  try { canonical = await realpath(root) } catch (e) { if (e.code === 'ENOENT' && !releaseId) return emptyWiki(); throw e }
  async function safeRead(rel) {
    assert(typeof rel === 'string' && !rel.includes('\\') && !path.isAbsolute(rel) && !rel.split('/').some(p => p === '..' || p === '' || p === '.'), 'Unsafe path')
    const resolved = await realpath(path.join(canonical, rel))
    assert(resolved.startsWith(canonical + path.sep), 'Path escapes Wiki root')
    return readFile(resolved)
  }
  let pointer
  if (!releaseId) {
    try { pointer = JSON.parse(await safeRead(pointerFile)) } catch (e) {
      if (e.code === 'ENOENT' && pointerFile === 'current.json') {
        try { await safeRead('previous.json') }
        catch (previous) { if (previous.code === 'ENOENT') return emptyWiki(); throw previous }
        throw new Error('Current publication pointer missing')
      }
      throw e
    }
    exactKeys(pointer, ['schemaVersion','releaseId','manifestSha256'])
    assert(pointer.schemaVersion === 2 && hashPattern.test(pointer.manifestSha256), 'Invalid publication pointer')
  }
  const id = releaseId ?? pointer.releaseId
  assert(identifier.test(id), 'Invalid release')
  const bytes = await safeRead(`releases/${id}/manifest.json`)
  if (pointer) assert(sha256(bytes) === pointer.manifestSha256, 'Manifest hash mismatch')
  const manifest = JSON.parse(bytes)
  assert(manifest.schemaVersion === 2 && manifest.releaseId === id && Array.isArray(manifest.entries) && Array.isArray(manifest.domains), 'Invalid manifest')
  const entryIds = new Set()
  for (const ref of manifest.entries) {
    assert(identifier.test(ref.id) && hashPattern.test(ref.sha256) && !entryIds.has(ref.id), 'Invalid entry manifest')
    entryIds.add(ref.id)
  }
  const loaded = await mapWikiFiles(manifest.entries, async ref => {
    // File path comes from validated IDs, never an arbitrary manifest/source path.
    const body = await safeRead(`releases/${id}/entries/${ref.id}.json`)
    assert(sha256(body) === ref.sha256, 'Entry hash mismatch')
    const entry = JSON.parse(body)
    validateEntry(entry)
    // The shipped v2 import identifies entries by hash only; new releases also record their revision.
    assert(entry.id === ref.id && (ref.revision === undefined || entry.revision === ref.revision), 'Entry identity mismatch')
    return entry
  })
  const entries = new Map(loaded.map(entry => [entry.id, entry]))
  // Keep only identities and replacement edges for inactive entries. Their bodies stay in old releases.
  const lineage = new Map([...entries.values()].map(({ id, revision, supersedes }) => [id, { id, revision, supersedes }]))
  assert(manifest.retired === undefined || Array.isArray(manifest.retired), 'Invalid retired lineage')
  for (const item of manifest.retired ?? []) {
    exactKeys(item, ['id', 'revision', 'supersedes'])
    assert(identifier.test(item.id) && !lineage.has(item.id) && Number.isSafeInteger(item.revision) && item.revision > 0
      && Array.isArray(item.supersedes) && item.supersedes.every(s => identifier.test(s))
      && new Set(item.supersedes).size === item.supersedes.length, 'Invalid retired identity')
    lineage.set(item.id, item)
  }
  const revoked = new Map((manifest.retired ?? []).map(e => [e.id, e.revision]))
  assert(manifest.revoked === undefined || Array.isArray(manifest.revoked), 'Invalid revocation list')
  for (const item of manifest.revoked ?? []) {
    exactKeys(item, ['id', 'revision'])
    assert(identifier.test(item.id) && Number.isSafeInteger(item.revision) && item.revision > 0
      && lineage.has(item.id) && item.revision <= lineage.get(item.id).revision, 'Invalid revoked identity')
    revoked.set(item.id, Math.max(revoked.get(item.id) ?? 0, item.revision))
  }
  const visited = new Set(), visiting = new Set()
  const visit = id => {
    assert(!visiting.has(id), 'Wiki supersedes cycle')
    if (visited.has(id)) return
    assert(lineage.has(id), 'Unknown superseded knowledge')
    visiting.add(id)
    for (const ref of lineage.get(id).supersedes) visit(ref)
    visiting.delete(id); visited.add(id)
  }
  for (const id of lineage.keys()) visit(id)
  const domains = new Map()
  for (const d of manifest.domains) {
    exactKeys(d, ['id','title','knowledgeRefs'])
    assert(identifier.test(d.id) && !domains.has(d.id), 'Invalid domain')
    assertSafeProse(d.title)
    assert(Array.isArray(d.knowledgeRefs) && d.knowledgeRefs.length > 0, 'Invalid domain refs')
    assert(d.knowledgeRefs.every(ref => entries.get(ref)?.domain === d.id), 'Dangling domain ref')
    domains.set(d.id, d)
  }
  assert([...entries.values()].every(e => domains.get(e.domain)?.knowledgeRefs.includes(e.id)), 'Uncatalogued entry')
  const clone = value => structuredClone(value)
  return {
    releaseId: id,
    catalog: () => clone([...domains.values()].map(d => ({ id: d.id, title: d.title, knowledgeRefs: d.knowledgeRefs }))),
    lineage: () => clone([...lineage.values()]),
    revocations: () => [...revoked].map(([id, revision]) => ({ id, revision })),
    read(entryId) {
      assert(entries.has(entryId), 'Unknown knowledge ID')
      const entry = entries.get(entryId)
      return { reference: `wiki:${id}:${entryId}@${entry.revision}`, releaseId: id, ...clone(entry) }
    },
    search(query, { phase, limit = 8, domainIds } = {}) {
      assert(phase === 'post-fast-query' || phase === 'first-pass', 'Explicit retrieval phase required')
      assert(Number.isInteger(limit) && limit >= 1 && limit <= 30, 'Invalid limit')
      if (phase === 'first-pass') return []
      assert(typeof query === 'string' && query.length <= 4000, 'Invalid query')
      assert(domainIds === undefined || (Array.isArray(domainIds) && domainIds.every(d => domains.has(d))), 'Invalid domain selection')
      const q = query.toLowerCase()
      return [...entries.values()].filter(e => domainIds === undefined || domainIds.includes(e.domain))
        .map(e => ({ e, hits: e.keywords.filter(k => q.includes(k.toLowerCase())) }))
        .filter(r => r.hits.length).sort((a, b) => b.hits.length - a.hits.length || a.e.id.localeCompare(b.e.id))
        .slice(0, limit).map(({ e, hits }) => ({ id: e.id, domain: e.domain, title: e.title, matchedTerms: hits,
          reference: `wiki:${id}:${e.id}@${e.revision}`, isTicketEvidence: false }))
    },
  }
}

function emptyWiki() {
  return { releaseId: null, catalog: () => [], lineage: () => [], revocations: () => [], search: () => [], read: () => { throw new Error('Wiki unavailable') } }
}

/** Active consumers check retirement even when their normal content is release-pinned. */
export async function revokedKnowledge(root, references) {
  const wiki = await openWiki(root)
  const retired = new Map(wiki.revocations().map(e => [e.id, e.revision]))
  return references.filter(ref => {
    const match = /^wiki:[a-z0-9-]+:([a-z0-9-]+)@(\d+)$/u.exec(ref)
    return match && (retired.get(match[1]) ?? 0) >= Number(match[2])
  })
}
