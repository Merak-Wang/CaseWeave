import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  readRetrievalPresentation,
  RetrievalPresentationClientError,
  snapshotInvalidated,
} from './presentation.js'

afterEach(() => { vi.unstubAllGlobals() })

describe('current presentation access', () => {
  it('fails closed when current authorization rejects a historical retrieval', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      code: 'UNAUTHORIZED', message: '工单权限已撤销。', retryable: false,
    }), { status: 403 })))
    await expect(readRetrievalPresentation('session', 'retrieval')).rejects.toThrow('工单权限已撤销')
  })

  it('preserves the Host error identity for a deterministic snapshot failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      code: 'SNAPSHOT_INVALID', message: '历史快照已失效，请重新检索。', retryable: false,
    }), { status: 409 })))
    const failure = await readRetrievalPresentation('session', 'retrieval').then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(RetrievalPresentationClientError)
    expect(failure).toMatchObject({ code: 'SNAPSHOT_INVALID', retryable: false, status: 409 })
    expect(snapshotInvalidated(failure)).toBe(true)
  })

  it('keeps transient backend failures retryable and distinct from dead snapshots', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      code: 'PROVIDER_UNAVAILABLE', message: '工单来源暂时不可用，无法完成重新授权；请稍后重试。', retryable: true,
    }), { status: 503 })))
    const failure = await readRetrievalPresentation('session', 'retrieval').then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(RetrievalPresentationClientError)
    expect(failure).toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true, status: 503 })
    expect(snapshotInvalidated(failure)).toBe(false)
  })

  it('rejects an apparently successful response for a different retrieval', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      node: { retrievalId: 'other', candidates: [{ title: '其他任务证据' }], alreadyReadEvidence: [] },
    }), { status: 200 })))
    await expect(readRetrievalPresentation('session', 'retrieval')).rejects.toThrow('不属于当前检索')
  })

  it('requires the confirmed-result schema instead of accepting an old mixed terminal collection', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      node: { retrievalId: 'retrieval', candidates: [], alreadyReadEvidence: [],
        result: { schemaVersion: 1, tickets: [], undeterminedCandidates: [{ title: '待判定工单' }] } },
    }), { status: 200 })))
    await expect(readRetrievalPresentation('session', 'retrieval')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })
})
