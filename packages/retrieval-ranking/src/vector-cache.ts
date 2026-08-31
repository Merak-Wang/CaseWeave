import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const VECTOR_CACHE_FORMAT_VERSION = 'float32-le-v1' as const

export interface VectorCacheIdentity {
  readonly model: string
  readonly revision: string
  readonly dimensions: number
  readonly projectionVersion: string
  readonly documents: readonly { readonly id: string; readonly contentHash: string }[]
}

interface VectorCacheMetadata extends VectorCacheIdentity {
  readonly formatVersion: typeof VECTOR_CACHE_FORMAT_VERSION
  readonly rowCount: number
  readonly dataSha256: string
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function hash(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

export function vectorCacheKey(identity: VectorCacheIdentity): string {
  return hash(stable(identity))
}

function validVectors(vectors: Float32Array, dimensions: number): boolean {
  if (vectors.length % dimensions !== 0) return false
  for (let row = 0; row < vectors.length / dimensions; row += 1) {
    let norm = 0
    for (let column = 0; column < dimensions; column += 1) {
      const value = vectors[row * dimensions + column]!
      if (!Number.isFinite(value)) return false
      norm += value * value
    }
    if (Math.abs(Math.sqrt(norm) - 1) > 0.02) return false
  }
  return true
}

export async function loadVectorCache(cacheDir: string, identity: VectorCacheIdentity): Promise<Float32Array | undefined> {
  const key = vectorCacheKey(identity)
  try {
    const metadata = JSON.parse(await readFile(join(cacheDir, `${key}.json`), 'utf8')) as VectorCacheMetadata
    const data = await readFile(join(cacheDir, `${key}.f32`))
    if (metadata.formatVersion !== VECTOR_CACHE_FORMAT_VERSION || metadata.model !== identity.model
      || metadata.revision !== identity.revision || metadata.dimensions !== identity.dimensions
      || metadata.projectionVersion !== identity.projectionVersion || stable(metadata.documents) !== stable(identity.documents)
      || metadata.rowCount !== identity.documents.length || metadata.dataSha256 !== hash(data)
      || data.byteLength !== metadata.rowCount * metadata.dimensions * Float32Array.BYTES_PER_ELEMENT) return undefined
    const copied = Uint8Array.from(data)
    const vectors = new Float32Array(copied.buffer)
    return validVectors(vectors, identity.dimensions) ? vectors : undefined
  } catch {
    return undefined
  }
}

export async function publishVectorCache(cacheDir: string, identity: VectorCacheIdentity, vectors: Float32Array): Promise<void> {
  if (vectors.length !== identity.documents.length * identity.dimensions || !validVectors(vectors, identity.dimensions)) {
    throw new TypeError('refusing to publish invalid normalized vectors')
  }
  await mkdir(cacheDir, { recursive: true })
  const key = vectorCacheKey(identity)
  const suffix = `${process.pid}-${randomUUID()}`
  const dataTarget = join(cacheDir, `${key}.f32`)
  const metadataTarget = join(cacheDir, `${key}.json`)
  const dataTemporary = `${dataTarget}.${suffix}.tmp`
  const metadataTemporary = `${metadataTarget}.${suffix}.tmp`
  const data = Buffer.from(vectors.buffer, vectors.byteOffset, vectors.byteLength)
  const metadata: VectorCacheMetadata = {
    ...identity,
    formatVersion: VECTOR_CACHE_FORMAT_VERSION,
    rowCount: identity.documents.length,
    dataSha256: hash(data),
  }
  try {
    await writeFile(dataTemporary, data, { flag: 'wx' })
    await writeFile(metadataTemporary, JSON.stringify(metadata), { flag: 'wx' })
    await rm(dataTarget, { force: true })
    await rm(metadataTarget, { force: true })
    await rename(dataTemporary, dataTarget)
    await rename(metadataTemporary, metadataTarget)
  } finally {
    await rm(dataTemporary, { force: true })
    await rm(metadataTemporary, { force: true })
  }
}
