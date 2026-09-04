import { afterEach, describe, expect, it, vi } from 'vitest'
import { readRetrievalPresentation } from './presentation.js'

afterEach(() => { vi.unstubAllGlobals() })

describe('current presentation access', () => {
  it('fails closed when current authorization rejects a historical retrieval', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      code: 'UNAUTHORIZED', message: '工单权限已撤销。',
    }), { status: 403 })))
    await expect(readRetrievalPresentation('session', 'retrieval')).rejects.toThrow('工单权限已撤销')
  })

  it('rejects an apparently successful response for a different retrieval', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      node: { retrievalId: 'other', candidates: [{ title: '其他任务证据' }], alreadyReadEvidence: [] },
    }), { status: 200 })))
    await expect(readRetrievalPresentation('session', 'retrieval')).rejects.toThrow('不属于当前检索')
  })
})
