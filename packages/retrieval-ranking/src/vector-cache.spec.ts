import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadVectorCache, publishVectorCache, vectorCacheKey, type VectorCacheIdentity } from './vector-cache.js'

const directories: string[] = []
const identity: VectorCacheIdentity = {
  model: 'fake', revision: 'v1', dimensions: 2, projectionVersion: 'projection-v1',
  documents: [{ id: 'a', contentHash: 'hash-a' }, { id: 'b', contentHash: 'hash-b' }],
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('vector cache', () => {
  it('publishes and reloads normalized float32 rows', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'retrieval-vector-cache-'))
    directories.push(directory)
    const vectors = new Float32Array([1, 0, 0, 1])

    await publishVectorCache(directory, identity, vectors)

    expect([...await loadVectorCache(directory, identity) ?? []]).toEqual([1, 0, 0, 1])
  })

  it('treats corrupt binary data and identity drift as a cache miss', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'retrieval-vector-cache-'))
    directories.push(directory)
    await publishVectorCache(directory, identity, new Float32Array([1, 0, 0, 1]))
    await writeFile(join(directory, `${vectorCacheKey(identity)}.f32`), Buffer.from([0, 1, 2]))

    expect(await loadVectorCache(directory, identity)).toBeUndefined()
    expect(await loadVectorCache(directory, { ...identity, revision: 'v2' })).toBeUndefined()
    expect(JSON.parse(await readFile(join(directory, `${vectorCacheKey(identity)}.json`), 'utf8'))).toMatchObject({ rowCount: 2 })
  })

  it('refuses non-normalized vectors', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'retrieval-vector-cache-'))
    directories.push(directory)
    await expect(publishVectorCache(directory, identity, new Float32Array([2, 0, 0, 1]))).rejects.toThrow(TypeError)
  })
})
