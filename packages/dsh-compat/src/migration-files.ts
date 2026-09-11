import { createHash, randomUUID } from 'node:crypto'
import { link, open, readFile, readdir, unlink } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { encodeMigratedSession, migrateRetrievalSession } from './migration.js'

const hash = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT'

/** Node's one-shot decoder stops at the first frame; consume every appended batch. */
export function decodeSessionFrames(bytes: Buffer): Buffer {
  const parts: Buffer[] = []
  let offset = 0
  while (offset < bytes.length) {
    const start = offset
    const take = (length: number): number => {
      const position = offset; offset += length
      if (offset > bytes.length) throw new Error(`Truncated Session Zstandard frame at ${start}`)
      return position
    }
    if (bytes.readUInt32LE(take(4)) !== 0xfd2fb528) throw new Error(`Invalid Session Zstandard frame at ${start}`)
    // RFC 8878 frame header and block lengths. Node 24 can silently decode a
    // truncated final frame, so establish structural completion before decoding.
    const descriptor = bytes[take(1)]!
    if (descriptor & 0x18) throw new Error('Reserved Zstandard frame-header bits')
    const sizeFlag = descriptor >>> 6, dictionaryFlag = descriptor & 3
    const single = Boolean(descriptor & 0x20)
    take((single ? 0 : 1) + (dictionaryFlag === 3 ? 4 : dictionaryFlag) + (sizeFlag ? 1 << sizeFlag : single ? 1 : 0))
    let last = false
    while (!last) {
      const block = bytes.readUIntLE(take(3), 3), kind = (block >>> 1) & 3
      if (kind === 3) throw new Error('Reserved Zstandard block type')
      take(kind === 1 ? 1 : block >>> 3)
      last = Boolean(block & 1)
    }
    if (descriptor & 4) take(4)
    parts.push(zstdDecompressSync(bytes.subarray(start, offset)))
  }
  return Buffer.concat(parts)
}
async function optionalFile(path: string): Promise<Buffer | undefined> {
  try { return await readFile(path) } catch (error) { if (missing(error)) return undefined; throw error }
}

/** Publish an entire flushed file without replacing an existing generation. */
async function publish(path: string, bytes: string | Uint8Array): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`
  const handle = await open(temp, 'wx', 0o600)
  try {
    await handle.writeFile(bytes, 'utf8')
    await handle.sync()
  } finally { await handle.close() }
  try { await link(temp, path) } finally { await unlink(temp) }
}

export interface SessionMigrationResult {
  readonly sessionId: string
  readonly source: string
  readonly destination: string
  readonly eventCount: number
  readonly action: 'checked' | 'migrated' | 'current' | 'refused'
  readonly error?: string
}

/**
 * Offline startup preflight. Retains V0 bytes and publishes validated V3 beside
 * them; never runs against a live old writer. A receipt detects an old runtime
 * modifying the predecessor after migration, including an unsafe downgrade.
 * Only CaseWeave V0 logs are converted; ordinary DSH logs use DSH's own migrator.
 */
export async function migrateSessionDirectory(root: string, write = false): Promise<SessionMigrationResult[]> {
  const results: SessionMigrationResult[] = []
  const visit = async (directory: string): Promise<void> => {
    let entries
    try { entries = await readdir(directory, { withFileTypes: true }) }
    catch (error) { if (missing(error)) return; throw error }
    if (entries.some(entry => entry.isSymbolicLink())) throw new Error(`Session migration refuses symbolic links: ${directory}`)
    const sources = entries.filter(entry => entry.isFile() && ['session.jsonl', 'session.jsonl.zstd'].includes(entry.name))
    if (sources.length > 1) throw new Error(`Ambiguous V0 Session generations: ${directory}`)
    for (const sourceEntry of sources) {
      const source = join(directory, sourceEntry.name)
      const original = await readFile(source)
      const text = (source.endsWith('.zstd') ? decodeSessionFrames(original) : original).toString('utf8')
      const rows: unknown[] = text.trimEnd().split('\n').map(line => JSON.parse(line) as unknown)
      if (!rows.some(row => row && typeof row === 'object' && 'type' in row && String(row.type).startsWith('retrieval/'))) continue
      const destination = join(directory, `session.v3.jsonl${source.endsWith('.zstd') ? '.zstd' : ''}`)
      const receiptPath = join(directory, 'caseweave-v0-migration.json')
      const sourceHash = hash(original)
      const receiptBytes = await optionalFile(receiptPath)
      const receipt = receiptBytes ? JSON.parse(receiptBytes.toString('utf8')) as { sourceHash?: string; sessionId?: string; eventCount?: number } : undefined
      if (receipt && receipt.sourceHash !== sourceHash) throw new Error(`V0 Session changed after migration; restore a consistent backup before continuing: ${source}`)
      const existing = await optionalFile(destination)
      if (existing && receipt) {
        results.push({ sessionId: String(receipt.sessionId), source, destination, eventCount: Number(receipt.eventCount), action: 'current' })
        continue
      }
      let artifact
      try { artifact = migrateRetrievalSession(rows) }
      catch (error) {
        results.push({ sessionId: basename(directory), source, destination, eventCount: 0, action: 'refused',
          error: error instanceof Error ? error.message : String(error) })
        continue
      }
      const plaintext = encodeMigratedSession(artifact)
      const headerEnd = plaintext.indexOf('\n') + 1
      const compress = (text: string) => zstdCompressSync(text, { params: { [constants.ZSTD_c_checksumFlag]: 1 } })
      // DSH requires the first compressed frame to contain exactly the header.
      const encoded = source.endsWith('.zstd') ? Buffer.concat([compress(plaintext.slice(0, headerEnd)), compress(plaintext.slice(headerEnd))]) : plaintext
      if (existing && hash(existing) !== hash(encoded)) throw new Error(`Unrecognized V3 successor requires explicit verification: ${destination}`)
      const result = { sessionId: artifact.header.id, source, destination, eventCount: artifact.events.length }
      if (write) {
        // Refuse a concurrently appended or replaced source instead of publishing a stale successor.
        if (hash(await readFile(source)) !== sourceHash) throw new Error(`Session source changed during migration: ${source}`)
        if (!existing) await publish(destination, encoded)
        if (!receipt) await publish(receiptPath, JSON.stringify({ version: 1, sourceHash, targetHash: hash(encoded), ...result }) + '\n')
      }
      results.push({ ...result, action: write ? 'migrated' : 'checked' })
    }
    for (const entry of entries) if (entry.isDirectory()) await visit(join(directory, entry.name))
  }
  await visit(resolve(root))
  return results
}
