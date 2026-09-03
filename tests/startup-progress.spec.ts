import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

interface ProgressModule {
  readonly formatPreparationProgress: (label: string, progress: {
    readonly phase: string
    readonly completedDocuments: number
    readonly totalDocuments: number
    readonly resumedDocuments: number
    readonly elapsedMs: number
    readonly documentsPerSecond: number
    readonly estimatedRemainingMs: number | null
  }, width?: number) => string
  readonly createStartupProgressReporter: (stream: {
    readonly isTTY: boolean
    readonly columns: number
    write(value: string): void
  }) => {
    preparation(label: string, value: Record<string, unknown>): void
  }
}

let progress: ProgressModule

beforeAll(async () => {
  progress = await import(pathToFileURL(resolve('scripts/startup-progress.mjs')).href) as ProgressModule
})

describe('startup progress rendering', () => {
  it('renders determinate index progress with resume, throughput and ETA', () => {
    expect(progress.formatPreparationProgress('Embedding tickets', {
      phase: 'embedding', completedDocuments: 50, totalDocuments: 100,
      resumedDocuments: 20, elapsedMs: 5_000, documentsPerSecond: 10,
      estimatedRemainingMs: 5_000,
    }, 10)).toBe('Embedding tickets [#####-----] 50% 50/100 | resumed 20 | 10.0 docs/s | ETA 5s')
  })

  it('renders cache validation and publication as explicit phases', () => {
    expect(progress.formatPreparationProgress('Vector index', {
      phase: 'checking_cache', completedDocuments: 0, totalDocuments: 100,
      resumedDocuments: 0, elapsedMs: 1_200, documentsPerSecond: 0,
      estimatedRemainingMs: null,
    }, 10)).toContain('checking cache')
    expect(progress.formatPreparationProgress('Vector index', {
      phase: 'publishing', completedDocuments: 100, totalDocuments: 100,
      resumedDocuments: 0, elapsedMs: 9_000, documentsPerSecond: 11,
      estimatedRemainingMs: 0,
    }, 10)).toContain('publishing cache')
  })

  it('announces a recovered checkpoint once without repeating it in every TTY frame', () => {
    let output = ''
    const reporter = progress.createStartupProgressReporter({
      isTTY: true,
      columns: 80,
      write(value) { output += value },
    })
    const value = {
      phase: 'embedding', revision: 2, completedDocuments: 32, totalDocuments: 100,
      resumedDocuments: 16, batchSize: 16, cacheHit: false, elapsedMs: 2_000,
      documentsPerSecond: 8, estimatedRemainingMs: 8_500,
    }
    reporter.preparation('[7/8] Vector index', value)
    reporter.preparation('[7/8] Vector index', { ...value, revision: 3, completedDocuments: 48 })
    expect(output.match(/checkpoint/g)).toHaveLength(1)
    expect(output.match(/resumed 16/g)).toHaveLength(1)
  })
})
