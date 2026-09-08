import { describe, expect, it } from 'vitest'
import type { TrustedPrincipalContext } from '@retrieval-agent/contracts'
import { LocalTicketProvider } from './provider.js'
import { rankingDocuments } from './search-projection.js'
import { normalizePublicSnapshotTicket } from './source.js'
import { testHybridRanker } from '../../../tests/support/fake-model-gateway.js'

const PRINCIPAL: TrustedPrincipalContext = {
  tenantId: 'demo', subjectId: 'development-admin', entitlementVersion: 'development-admin-v1',
  purpose: 'ticket_retrieval', attributes: { environment: ['development'], role: ['administrator'] },
  issuedAt: '2026-08-27T00:00:00.000Z', expiresAt: '2026-08-28T00:00:00.000Z',
}

describe('source-native public snapshot adapter', () => {
  it('keeps upstream summaries at L1 and reads the full controlled dialogue without exposing raw metadata', async () => {
    const record = normalizePublicSnapshotTicket({ ticket_id: 'ESFT-PROJECTION', source_dataset: 'deepseek-ai/ESFT', source_version: 'v1',
      title: '副卡办理', summary: '用户要求办理副卡。', problem_description: '客户只说要办理。', pii_redaction_status: 'redacted',
      raw_dialogue: [{ speaker: 'customer', text: '我要办理副卡。' }, { speaker: 'agent', text: '异地无法办理，需要到归属地。' }],
      transformation: { hidden: 'not-a-ticket-field' } })
    const provider = new LocalTicketProvider([record], { now: () => new Date('2026-08-27T01:00:00.000Z'), ranker: testHybridRanker() })
    const snapshot = await provider.openSnapshot(PRINCIPAL)
    const page = await provider.search(PRINCIPAL, snapshot.snapshotId, provider.resolve({ query: '副卡', target: 'ranked_cases' }), { topK: 5, maxScan: 10, stage: 'initial_hybrid' })
    expect(page.candidates[0]?.titleOrigin?.kind).toBe('generated')
    const read = await provider.readEvidence(PRINCIPAL, { snapshotId: snapshot.snapshotId, candidateRefs: [page.candidates[0]!.ref], fields: ['summary', 'source.raw_dialogue'], tokenBudget: 1000, level: 'L3' })
    expect(read.evidence[0]).toMatchObject({ projectionLevel: 'L1', origin: { kind: 'unknown' } })
    expect(read.evidence[0]?.origin?.description).toContain('非对话原文')
    expect(read.evidence.filter(e => e.field === 'source.raw_dialogue').map(e => JSON.parse(e.text))).toEqual(record.rawSource!.payload.raw_dialogue)
    expect(JSON.stringify(read)).not.toContain('not-a-ticket-field')
    const details = await provider.readDetails(PRINCIPAL, { snapshotId: snapshot.snapshotId, candidateRefs: [page.candidates[0]!.ref], fields: ['source.raw_dialogue'], purpose: 'inline_detail' })
    expect(details.evidence?.map(e => e.evidenceId)).toEqual(read.evidence.slice(1).map(e => e.evidenceId))
  })
  it('keeps unknown raw keys inside the Provider and rejects raw evidence and detail reads', async () => {
    const record = normalizePublicSnapshotTicket({
      ticket_id: 'PUBLIC-1', source_dataset: 'example/full', source_version: 'v1', source_kind: 'real',
      title: 'Router photon fault', summary: 'A customer reports a photon fault.', queue: 'network',
      tags: ['router'], near_duplicate_group: 'router|photon', custom_note: 'unmapped-photon-extension',
    })
    const provider = new LocalTicketProvider([record], { now: () => new Date('2026-08-27T01:00:00.000Z'), ranker: testHybridRanker() })
    const snapshot = await provider.openSnapshot(PRINCIPAL)
    expect(snapshot.fieldCatalog).toContainEqual(expect.objectContaining({ key: 'source.raw', accessLevel: 'L3' }))
    const spec = provider.resolve({
      target: 'ranked_cases', query: 'unmapped photon', requestedCount: 5, countPolicy: 'explicit',
      filters: [{ field: 'source.dataset', op: 'eq', value: 'example/full' }],
    })
    const page = await provider.search(PRINCIPAL, snapshot.snapshotId, spec, { topK: 5, maxScan: 10, stage: 'baseline' })
    expect(page.candidates).toHaveLength(1)
    expect(JSON.stringify(page.candidates[0])).not.toContain('unmapped-photon-extension')
    await expect(provider.readDetails(PRINCIPAL, {
      snapshotId: snapshot.snapshotId,
      candidateRefs: [page.candidates[0]!.ref],
      fields: ['source.raw'],
      purpose: 'inline_detail',
    })).rejects.toThrow(/不允许的详情字段/u)
    await expect(provider.readEvidence(PRINCIPAL, {
      snapshotId: snapshot.snapshotId,
      candidateRefs: [page.candidates[0]!.ref],
      fields: ['source.raw'], tokenBudget: 100,
    })).rejects.toMatchObject({ code: 'FIELD_NOT_ALLOWED' })
    expect(record.rawSource?.payload).toHaveProperty('custom_note', 'unmapped-photon-extension')
  })

  it('rejects dynamic filters that the source catalog did not declare', () => {
    const provider = new LocalTicketProvider([normalizePublicSnapshotTicket({
      ticket_id: 'PUBLIC-2', source_dataset: 'example/full', source_version: 'v1',
      title: 'Example', summary: 'Example record', custom_filter: 'hidden',
    })])
    expect(() => provider.resolve({
      target: 'ranked_cases', query: 'Example', requestedCount: 5, countPolicy: 'explicit', filters: [{ field: 'source.custom_filter', op: 'eq', value: 'hidden' }],
    })).toThrow(/不支持筛选字段/u)
  })

  it('maps redacted ESFT fields to L0-L3 without indexing transformation metadata', () => {
    const record = normalizePublicSnapshotTicket({
      ticket_id: 'ESFT-SUMMARY-TRAIN-000001', source_dataset: 'deepseek-ai/ESFT', source_version: 'commit-1',
      source_kind: 'public_research_corpus', source_split: 'train', domain: 'telecom_customer_service',
      title: '副卡流量费用争议', summary: '用户反映副卡流量费用有疑义。', problem_description: '副卡产生了额外流量费用。',
      product: '移动通信', category: '流量与上网', type: '客服通话摘要', language: 'zh-CN',
      pii_redaction_status: 'redacted', raw_dialogue: [{ speaker: 'customer', text: '请核实副卡流量。' }],
      transformation: { internal_marker: 'must-not-enter-search-projection' },
    })

    expect(record.piiRedactionStatus).toBe('redacted')
    expect(record.product).toBe('移动通信')
    expect(record.additionalFields).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'source.split', value: 'train' }),
      expect.objectContaining({ key: 'source.domain', value: 'telecom_customer_service' }),
    ]))
    const document = rankingDocuments([record])[0]!
    expect(document.body).toContain('请核实副卡流量')
    expect(document.body).not.toContain('must-not-enter-search-projection')
    expect(record.rawSource?.payload).toHaveProperty('transformation')
  })
})
