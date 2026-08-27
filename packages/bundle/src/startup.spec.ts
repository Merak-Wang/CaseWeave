import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installLocalProductAssets, uninstallLocalProductAssets } from './startup.js'

const temporaryRoots: string[] = []

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    if (!root.startsWith(tmpdir())) throw new Error(`refusing to remove non-temporary path: ${root}`)
    await rm(root, { recursive: true, force: true })
  }
})

describe('installLocalProductAssets', () => {
  it('installs the fixed preset and fixture without import-time side effects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'retrieval-agent-assets-'))
    temporaryRoots.push(root)

    const receipt = await installLocalProductAssets(root)

    await expect(readFile(join(receipt.presetRoot, 'retrieval-agent', 'preset.yml'), 'utf8')).resolves.toContain('只读工单检索')
    await expect(readFile(join(receipt.presetRoot, 'retrieval-agent', 'agent.cordis.yml'), 'utf8')).resolves.toContain('@retrieval-agent/agent-plugin')
    await expect(readFile(receipt.dataPath, 'utf8')).resolves.toContain('INC-1001')
  })

  it('refuses accidental overwrite unless it is explicitly requested', async () => {
    const root = await mkdtemp(join(tmpdir(), 'retrieval-agent-assets-'))
    temporaryRoots.push(root)
    const receipt = await installLocalProductAssets(root)
    await writeFile(receipt.dataPath, 'local-edit', 'utf8')

    await expect(installLocalProductAssets(root)).rejects.toBeDefined()
    await installLocalProductAssets(root, true)
    await expect(readFile(receipt.dataPath, 'utf8')).resolves.toContain('INC-1001')
  })

  it('rejects installation into a filesystem root', async () => {
    const root = parse(process.cwd()).root
    await expect(installLocalProductAssets(root)).rejects.toThrow(/filesystem root/u)
    await expect(uninstallLocalProductAssets(root)).rejects.toThrow(/filesystem root/u)
  })

  it('removes only product-owned preset and fixture directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'retrieval-agent-assets-'))
    temporaryRoots.push(root)
    const receipt = await installLocalProductAssets(root)
    const unrelated = join(root, 'keep.txt')
    await writeFile(unrelated, 'keep', 'utf8')

    const removed = await uninstallLocalProductAssets(root)

    await expect(access(removed.presetPath)).rejects.toBeDefined()
    await expect(access(removed.productRoot)).rejects.toBeDefined()
    await expect(readFile(unrelated, 'utf8')).resolves.toBe('keep')
  })
})
