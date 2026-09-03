import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

async function esftDataRoot(root: string): Promise<string> {
  const dataRoot = join(root, 'source-data')
  const ticketPath = join(dataRoot, 'tickets', 'esft', 'summary-train.jsonl')
  await mkdir(join(dataRoot, 'tickets', 'esft'), { recursive: true })
  await writeFile(ticketPath, `${JSON.stringify({
    ticket_id: 'ESFT-SUMMARY-TRAIN-000001',
    source_dataset: 'deepseek-ai/ESFT',
    source_version: 'pinned',
    source_split: 'train',
    title: '测试标题',
    summary: '测试摘要',
    problem_description: '测试问题',
    raw_dialogue: [{ speaker: 'customer', text: '测试问题' }],
    pii_redaction_status: 'redacted',
  })}\n`, 'utf8')
  await writeFile(join(dataRoot, 'manifest.json'), `${JSON.stringify({
    schemaVersion: 'retrieval-agent.data.v1',
    defaultTicketProfile: 'esft-summary-train-v1',
    sourcePolicy: {
      authoritativeSource: 'deepseek-ai/ESFT',
      runtimeTicketSources: ['deepseek-ai/ESFT'],
      fallbackSources: [],
    },
    ticketProfiles: {
      'esft-summary-train-v1': {
        recordCount: 1,
        paths: ['tickets/esft/summary-train.jsonl'],
        sha256: ['test-only'],
      },
    },
  })}\n`, 'utf8')
  return dataRoot
}

describe('installLocalProductAssets', () => {
  it('installs the fixed preset and fixture without import-time side effects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'retrieval-agent-assets-'))
    temporaryRoots.push(root)

    const receipt = await installLocalProductAssets(root, false, await esftDataRoot(root))

    await expect(readFile(join(receipt.presetRoot, 'retrieval-agent', 'preset.yml'), 'utf8')).resolves.toContain('只读工单检索')
    await expect(readFile(join(receipt.presetRoot, 'retrieval-agent', 'agent.cordis.yml'), 'utf8')).resolves.toContain('@retrieval-agent/bundle/agent')
    await expect(readFile(receipt.dataPath, 'utf8')).resolves.toContain('ESFT-SUMMARY-TRAIN-')
    await expect(readFile(join(receipt.dataRoot, 'manifest.json'), 'utf8')).resolves.toContain('esft-summary-train-v1')
    await expect(access(join(receipt.dataRoot, 'raw'))).rejects.toBeDefined()
    await expect(access(receipt.workspacePath)).resolves.toBeUndefined()
  })

  it('refuses accidental overwrite unless it is explicitly requested', async () => {
    const root = await mkdtemp(join(tmpdir(), 'retrieval-agent-assets-'))
    temporaryRoots.push(root)
    const dataRoot = await esftDataRoot(root)
    const receipt = await installLocalProductAssets(root, false, dataRoot)
    await writeFile(receipt.dataPath, 'local-edit', 'utf8')

    await expect(installLocalProductAssets(root, false, dataRoot)).rejects.toBeDefined()
    await installLocalProductAssets(root, true, dataRoot)
    await expect(readFile(receipt.dataPath, 'utf8')).resolves.toContain('ESFT-SUMMARY-TRAIN-')
  })

  it('rejects installation into a filesystem root', async () => {
    const root = parse(process.cwd()).root
    await expect(installLocalProductAssets(root)).rejects.toThrow(/filesystem root/u)
    await expect(uninstallLocalProductAssets(root)).rejects.toThrow(/filesystem root/u)
  })

  it('removes only product-owned preset and fixture directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'retrieval-agent-assets-'))
    temporaryRoots.push(root)
    const receipt = await installLocalProductAssets(root, false, await esftDataRoot(root))
    const unrelated = join(root, 'keep.txt')
    await writeFile(unrelated, 'keep', 'utf8')

    const removed = await uninstallLocalProductAssets(root)

    await expect(access(removed.presetPath)).rejects.toBeDefined()
    await expect(access(removed.productRoot)).rejects.toBeDefined()
    await expect(readFile(unrelated, 'utf8')).resolves.toBe('keep')
  })
})
