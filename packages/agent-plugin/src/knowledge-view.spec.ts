import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import type { RetrievalState } from '@retrieval-agent/contracts'
import { readTaskKnowledge } from './knowledge-view.js'
import { openWiki } from './wiki-store.js'
import { checkoutEntry, publishWiki } from './wiki-publisher.js'

// Full-release copies and durable writes vary with disk latency; these are
// consistency checks, not a five-second performance benchmark.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })

it('task knowledge keeps its pinned body after publication advances and rejects a revoked body', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'ra-knowledge-view-')), root = path.join(temp, 'wiki')
  try {
    await cp('wiki', root, { recursive: true })
    const original = await openWiki(root), domain = original.catalog().find(d => d.id === 'esim')!, entryId = domain.knowledgeRefs[0]!
    const state = { knowledgeCatalog: { status: 'available', releaseId: original.releaseId!, domains: [{ id: domain.id, description: domain.title, entryIds: domain.knowledgeRefs }] } } as unknown as RetrievalState
    const edit = await checkoutEntry(root, entryId)
    edit.changes[0]!.entry!.bodyMarkdown += '\n\n界面验收的下一修订。'
    await publishWiki(root, edit)
    const view = await readTaskKnowledge(root, state, entryId)
    expect(view.entry?.reference).toBe(original.read(entryId).reference)
    expect(view.entry?.bodyMarkdown).not.toContain('界面验收的下一修订')
    await expect(readTaskKnowledge(root, state, 'not-allowed')).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    const current = await openWiki(root)
    await publishWiki(root, { schemaVersion: 1, baseRelease: current.releaseId, changes: [{ operation: 'deactivate', id: entryId }] })
    expect((await readTaskKnowledge(root, state)).domains[0]!.entries.find(e => e.id === entryId)?.revoked).toBe(true)
    await expect(readTaskKnowledge(root, state, entryId)).rejects.toMatchObject({ code: 'INVALID_TRANSITION' })
  } finally {
    if (!path.resolve(temp).startsWith(path.resolve(tmpdir()) + path.sep) || !path.basename(temp).startsWith('ra-knowledge-view-')) throw new Error('Unexpected fixture directory')
    await rm(temp, { recursive: true, force: true })
  }
})
