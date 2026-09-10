/** Host-owned publisher. Knowledge models supply data; they never supply paths or executable files. */
/** @typedef {import('./wiki-types.js').WikiDelta} WikiDelta */
/** @typedef {import('./wiki-types.js').PublicationResult} PublicationResult */
/** @typedef {import('./wiki-types.js').PublicationOptions} PublicationOptions */
import { mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { openWiki, validateEntry, assertSafeProse, sha256 } from './wiki-store.js'
import { mapWikiFiles } from './wiki-io.js'

const idPattern = { test: value => typeof value === 'string' && /^[a-z][a-z0-9-]{1,90}$/u.test(value) }
const assert = (ok, message) => { if (!ok) throw new Error(message) }
const json = value => JSON.stringify(value, null, 2) + '\n'
const exact = (value, required, optional = []) => assert(value && typeof value === 'object' && !Array.isArray(value)
  && required.every(k => Object.hasOwn(value, k)) && Object.keys(value).every(k => [...required, ...optional].includes(k)), 'Unknown or missing fields')
/** @param {string} root */
export const wikiAuditRoot = root => path.join(path.dirname(path.resolve(root)), '.cache', 'wiki-publications', sha256(path.resolve(root)).slice(0, 16))
/** @param {import('./wiki-types.js').PublishedWiki} wiki @returns {import('./wiki-types.js').WikiEntry[]} */
export const wikiEntries = wiki => wiki.catalog().flatMap(d => d.knowledgeRefs.map(id => {
  const { reference, releaseId, ...entry } = wiki.read(id); return entry
}))

async function directory(root, rel) {
  let target = root
  for (const part of rel.split('/')) {
    assert(idPattern.test(part) || part === '.staging', 'Invalid publication directory')
    target = path.join(target, part)
    try { await mkdir(target) } catch (e) { if (e.code !== 'EEXIST') throw e }
    assert((await realpath(target)).startsWith(root + path.sep), 'Publication path escapes Wiki root')
  }
  return target
}
async function durableFile(file, bytes) {
  const handle = await open(file, 'wx')
  try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
}
async function atomic(file, bytes) {
  const temp = `${file}.${randomUUID()}.tmp`
  await durableFile(temp, bytes)
  try { await rename(temp, file) } finally { await rm(temp, { force: true }) }
}
async function renameRelease(source, destination, signal) {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted()
    try { await rename(source, destination); return }
    catch (error) {
      // Windows can briefly deny directory renames after files close. Keep the
      // publication lock and retry the same validated directory, never its data.
      if (process.platform !== 'win32' || attempt >= 4 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error
      await delay(25 * 2 ** attempt, undefined, { signal })
    }
  }
}
async function locked(root, work, signal) {
  await mkdir(root, { recursive: true })
  const canonical = await realpath(root), file = path.join(canonical, '.publish.lock')
  const started = Date.now(), nonce = randomUUID()
  let handle
  while (!handle) {
    signal?.throwIfAborted()
    try { handle = await open(file, 'wx') }
    catch (error) {
      if (error.code !== 'EEXIST') throw error
      // One-machine profile: never steal a live writer's lock based on elapsed time.
      try {
        const owner = JSON.parse(await readFile(file, 'utf8'))
        if (Number.isInteger(owner.pid) && owner.pid > 0) {
          try { process.kill(owner.pid, 0) } catch (e) {
            if (e.code === 'ESRCH' && (await readFile(file, 'utf8')) === json(owner)) await rm(file)
          }
        }
      } catch { /* A writer may be between exclusive create and writing its identity. */ }
      if (Date.now() - started > 5000) throw new Error('Wiki publication lock busy')
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
  try { await handle.writeFile(json({ pid: process.pid, nonce })); await handle.sync(); return await work(canonical) }
  finally {
    await handle.close()
    if (JSON.parse(await readFile(file, 'utf8')).nonce === nonce) await rm(file)
  }
}

/** @param {string} root @param {string} id @returns {Promise<WikiDelta>} */
export async function checkoutEntry(root, id) {
  const wiki = await openWiki(root)
  const { reference, releaseId, ...entry } = wiki.read(id)
  return { schemaVersion: 1, baseRelease: wiki.releaseId, changes: [{ operation: 'update', id, entry }] }
}

function validateDelta(delta) {
  exact(delta, ['schemaVersion', 'baseRelease', 'changes'], ['domains'])
  assert(delta.schemaVersion === 1 && (delta.baseRelease === null || idPattern.test(delta.baseRelease)), 'Invalid delta base')
  assert(Array.isArray(delta.changes) && delta.changes.length > 0 && delta.changes.length <= 100, 'Invalid delta changes')
  const seen = new Set()
  for (const change of delta.changes) {
    exact(change, ['operation', 'id'], ['entry'])
    assert(idPattern.test(change.id) && !seen.has(change.id), 'Invalid or duplicate delta identity'); seen.add(change.id)
    assert(['add', 'update', 'deactivate'].includes(change.operation), 'Invalid operation')
    if (change.operation === 'deactivate') assert(!change.entry, 'Deactivation cannot include a body')
    else { validateEntry(change.entry); assert(change.entry.id === change.id, 'Delta identity mismatch') }
  }
  if (delta.domains !== undefined) {
    assert(Array.isArray(delta.domains), 'Invalid domains')
    const ids = new Set()
    for (const d of delta.domains) {
      exact(d, ['id', 'title']); assert(idPattern.test(d.id) && !ids.has(d.id), 'Invalid domain'); ids.add(d.id); assertSafeProse(d.title)
    }
  }
}

/** @param {string} root @param {WikiDelta} suppliedDelta @param {PublicationOptions} options @returns {Promise<PublicationResult>} */
export async function publishWiki(root, suppliedDelta, options = {}) {
  const delta = structuredClone(suppliedDelta)
  validateDelta(delta)
  const operationHash = sha256(json({ delta, audit: options.audit ?? null }))
  return locked(root, async canonical => {
    const current = await openWiki(canonical)
    // Walk committed ancestry, not an orphan build directory, to recognize a retry after a crash.
    let ancestor = current.releaseId
    const visited = new Set()
    while (ancestor && !visited.has(ancestor)) {
      visited.add(ancestor)
      let manifest
      try { manifest = JSON.parse(await readFile(path.join(canonical, 'releases', ancestor, 'manifest.json'), 'utf8')) }
      catch { break } // The retired confidential import is intentionally outside the replay window.
      if (manifest.operationHash === operationHash) return { releaseId: ancestor, duplicate: true, changedIds: delta.changes.map(c => c.id) }
      ancestor = idPattern.test(manifest.baseRelease) ? manifest.baseRelease : null
    }
    if (options.requireBaseRelease) assert(delta.baseRelease === current.releaseId, 'Wiki changed; learning requires fresh semantic validation')
    const base = delta.baseRelease === current.releaseId ? current : delta.baseRelease ? await openWiki(canonical, { releaseId: delta.baseRelease }) : null
    const original = new Map(base ? wikiEntries(base).map(e => [e.id, e]) : [])
    const entries = new Map(wikiEntries(current).map(e => [e.id, e]))
    const graph = new Map(current.lineage().map(entry => [entry.id, entry]))
    const revoked = new Map(current.revocations().map(entry => [entry.id, entry.revision]))
    // Replacements write the target's routing state too, so its concurrent edits require the same CAS.
    for (const change of delta.changes) for (const ref of change.entry?.supersedes ?? []) {
      assert(json(original.get(ref)) === json(entries.get(ref)), `Wiki edit conflict: ${ref}`)
    }
    for (const change of delta.changes) {
      const old = original.get(change.id), live = entries.get(change.id)
      assert(json(old) === json(live), `Wiki edit conflict: ${change.id}`)
      assert(change.operation === 'add' ? !old : !!old, 'Operation does not match base entry')
      if (change.entry) {
        const entry = { ...change.entry, revision: (graph.get(change.id)?.revision ?? 0) + 1 }
        entries.set(change.id, entry); graph.set(change.id, entry)
      } else entries.delete(change.id)
    }
    const visitedIds = new Set(), visitingIds = new Set()
    const walk = id => {
      assert(!visitingIds.has(id), 'Wiki supersedes cycle')
      if (visitedIds.has(id)) return
      visitingIds.add(id)
      for (const ref of graph.get(id)?.supersedes ?? []) {
        assert(graph.has(ref), 'Unknown superseded knowledge'); walk(ref)
      }
      visitingIds.delete(id); visitedIds.add(id)
    }
    for (const id of graph.keys()) walk(id)
    // Replacement actually removes the old prior from routing.
    for (const change of delta.changes) for (const ref of change.entry?.supersedes ?? []) entries.delete(ref)
    for (const item of graph.values()) if (!entries.has(item.id)) revoked.set(item.id, Math.max(revoked.get(item.id) ?? 0, item.revision))
    const domains = new Map(current.catalog().map(d => [d.id, d.title]))
    for (const d of delta.domains ?? []) {
      const baseTitle = base?.catalog().find(item => item.id === d.id)?.title
      assert(!domains.has(d.id) || domains.get(d.id) === baseTitle || domains.get(d.id) === d.title, `Wiki domain conflict: ${d.id}`)
      domains.set(d.id, d.title)
    }
    for (const e of entries.values()) assert(domains.has(e.domain), 'Entry has no domain')
    const releaseId = `wiki-${sha256(json([current.releaseId, operationHash])).slice(0, 40)}`
    const stagingId = `stage-${randomUUID()}`
    const releasePath = await directory(canonical, `.staging/${stagingId}`)
    await directory(canonical, `.staging/${stagingId}/entries`)
    const refs = await mapWikiFiles([...entries.values()].sort((a, b) => a.id.localeCompare(b.id)), async entry => {
      validateEntry(entry)
      const bytes = json(entry), file = path.join(releasePath, 'entries', `${entry.id}.json`)
      await durableFile(file, bytes)
      return { id: entry.id, revision: entry.revision, sha256: sha256(bytes) }
    })
    const manifest = { schemaVersion: 2, releaseId, baseRelease: current.releaseId, kind: options.audit ? 'evidence-reviewed-learning' : 'file-edit', operationHash,
      revoked: [...revoked].map(([id, revision]) => ({ id, revision })).sort((a, b) => a.id.localeCompare(b.id)),
      domains: [...domains].map(([id, title]) => ({ id, title, knowledgeRefs: [...entries.values()].filter(e => e.domain === id).map(e => e.id).sort() })).filter(d => d.knowledgeRefs.length), entries: refs,
      retired: [...graph.values()].filter(e => !entries.has(e.id)).map(({ id, revision, supersedes }) => ({ id, revision, supersedes })).sort((a, b) => a.id.localeCompare(b.id)) }
    const manifestBytes = json(manifest)
    await durableFile(path.join(releasePath, 'manifest.json'), manifestBytes)
    await directory(canonical, 'releases')
    const destination = path.join(canonical, 'releases', releaseId)
    try { await renameRelease(releasePath, destination, options.signal) }
    catch (e) {
      // Complete but uncommitted releases can be reused after a failed source fence or process restart.
      const existing = await readFile(path.join(destination, 'manifest.json'), 'utf8').catch(error => {
        if (error.code === 'ENOENT') throw e
        throw error
      })
      assert(existing === manifestBytes, 'Immutable publication conflict')
      await rm(releasePath, { recursive: true })
    }
    await openWiki(canonical, { releaseId })
    // Private source mapping stays outside the published root and all model read ports.
    if (options.audit) {
      const privateRoot = wikiAuditRoot(canonical)
      await mkdir(privateRoot, { recursive: true })
      await atomic(path.join(privateRoot, `${releaseId}.json`), json({ releaseId, manifestSha256: sha256(manifestBytes), audit: options.audit }))
    }
    const result = { releaseId, duplicate: false, changedIds: delta.changes.map(c => c.id) }
    const commit = async () => {
      options.signal?.throwIfAborted()
      if (current.releaseId) {
        const prior = await readFile(path.join(canonical, 'releases', current.releaseId, 'manifest.json'))
        await atomic(path.join(canonical, 'previous.json'), json({ schemaVersion: 2, releaseId: current.releaseId, manifestSha256: sha256(prior) }))
      }
      await atomic(path.join(canonical, 'current.json'), json({ schemaVersion: 2, releaseId, manifestSha256: sha256(manifestBytes) }))
    }
    if (options.beforeCommit) await options.beforeCommit(result, commit)
    else await commit()
    return result
  }, options.signal)
}

/** @param {string} root @param {string} releaseId @returns {Promise<PublicationResult>} */
export async function rollbackWiki(root, releaseId) {
  const current = await openWiki(root), old = await openWiki(root, { releaseId })
  const now = new Map(wikiEntries(current).map(e => [e.id, e]))
  const restored = new Map(wikiEntries(old).map(e => [e.id, e]))
  const changes = [...new Set([...now.keys(), ...restored.keys()])].map(id => {
    const entry = restored.get(id)
    return entry ? { id, operation: now.has(id) ? 'update' : 'add', entry } : { id, operation: 'deactivate' }
  })
  return publishWiki(root, { schemaVersion: 1, baseRelease: current.releaseId, domains: old.catalog().map(({ id, title }) => ({ id, title })), changes }, { audit: { kind: 'rollback', restoredRelease: releaseId } })
}

/** The offline compiler may bootstrap or verify its own release, never reset a newer live pointer. */
/** @param {string} root @param {string} releaseId @returns {Promise<PublicationResult>} */
export async function activateImportedWiki(root, releaseId) {
  assert(idPattern.test(releaseId), 'Invalid imported release')
  return locked(root, async canonical => {
    const current = await openWiki(canonical)
    assert(!current.releaseId || current.releaseId === releaseId, 'Initial import cannot replace a newer publication; publish a file delta')
    await openWiki(canonical, { releaseId })
    const bytes = await readFile(path.join(canonical, 'releases', releaseId, 'manifest.json'))
    await atomic(path.join(canonical, 'current.json'), json({ schemaVersion: 2, releaseId, manifestSha256: sha256(bytes) }))
    return { releaseId, duplicate: current.releaseId === releaseId, changedIds: [] }
  })
}
