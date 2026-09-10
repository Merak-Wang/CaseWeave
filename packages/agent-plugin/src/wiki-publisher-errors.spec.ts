import { cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { checkoutEntry, publishWiki } from './wiki-publisher.js'

const injected = vi.hoisted(() => ({ failRename: false, transientFailures: 0 }))
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs, rename: async (...args: Parameters<typeof fs.rename>) => {
    if (String(args[0]).replaceAll('\\', '/').includes('/.staging/')) {
      if (injected.transientFailures > 0) {
        injected.transientFailures--
        throw Object.assign(new Error('publication directory temporarily busy'), { code: 'EPERM' })
      }
      if (injected.failRename) throw Object.assign(new Error('publication directory is busy'), { code: 'EACCES' })
    }
    return fs.rename(...args)
  } }
})

it.runIf(process.platform === 'win32')('retries a transient Windows rename failure before publishing the validated release', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'ra-wiki-rename-')), root = path.join(temp, 'wiki')
  try {
    await cp('wiki', root, { recursive: true })
    const draft = await checkoutEntry(root, 'esim-forms')
    draft.changes[0]!.entry!.scope = '核对暂时占用解除后的发布。'
    injected.transientFailures = 2
    const result = await publishWiki(root, draft)
    expect(injected.transientFailures).toBe(0)
    expect(JSON.parse(await readFile(path.join(root, 'current.json'), 'utf8')).releaseId).toBe(result.releaseId)
    expect(await publishWiki(root, draft)).toMatchObject({ releaseId: result.releaseId, duplicate: true })
  } finally {
    injected.transientFailures = 0
    if (!path.resolve(temp).startsWith(path.resolve(tmpdir()) + path.sep) || !path.basename(temp).startsWith('ra-wiki-rename-')) throw new Error('Unexpected fixture directory')
    await rm(temp, { recursive: true, force: true })
  }
})

it('preserves the actual publication failure and leaves the current release untouched', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'ra-wiki-rename-')), root = path.join(temp, 'wiki')
  try {
    await cp('wiki', root, { recursive: true })
    const pointer = await readFile(path.join(root, 'current.json'), 'utf8')
    const draft = await checkoutEntry(root, 'esim-forms')
    draft.changes[0]!.entry!.scope = '核对发布失败后的原版本。'
    injected.failRename = true
    await expect(publishWiki(root, draft)).rejects.toMatchObject({ code: 'EACCES', message: 'publication directory is busy' })
    expect(await readFile(path.join(root, 'current.json'), 'utf8')).toBe(pointer)
    await expect(readFile(path.join(root, '.publish.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    injected.failRename = false
    if (!path.resolve(temp).startsWith(path.resolve(tmpdir()) + path.sep) || !path.basename(temp).startsWith('ra-wiki-rename-')) throw new Error('Unexpected fixture directory')
    await rm(temp, { recursive: true, force: true })
  }
})
