import { expect, it } from 'vitest'
import { MilvusClient } from './milvus.js'

it('bounds concurrent filtered searches, merges ticket scores and honours cancellation', async () => {
  const client = new MilvusClient()
  let active = 0, peak = 0, calls = 0
  client.call = async <T>(_path: string, body: Record<string, unknown>): Promise<T> => {
    active++; peak = Math.max(peak, active); calls++
    await new Promise(resolve => setTimeout(resolve, 2))
    active--
    const ids = JSON.parse(String(body.filter).slice('ticket_id in '.length)) as string[]
    return [{ ticket_id: ids[0], distance: Number(ids[0]), id: ids[0] }] as T
  }
  const hits = await client.search('test', [1], Array.from({ length: 5001 }, (_, i) => String(i)), 2)
  expect(calls).toBe(6)
  expect(peak).toBeGreaterThan(1)
  expect(peak).toBeLessThanOrEqual(4)
  expect(hits.map(h => h.ticket_id)).toEqual(['5000', '4000'])
  const abort = new AbortController(); abort.abort()
  await expect(client.search('test', [1], ['1'], 2, abort.signal)).rejects.toThrow()
})

it('unions Top 15 with every score strictly above .75, paging in hundreds', async () => {
  const client = new MilvusClient()
  let scores = Array.from({ length: 280 }, (_, i) => i < 260 ? .99 - i * .0008 : .75)
  const pages: number[] = []
  client.call = async <T>(_path: string, body: Record<string, unknown>): Promise<T> => {
    expect(body.limit).toBe(100)
    const offset = Number(body.offset ?? 0); pages.push(offset)
    return scores.slice(offset, offset + Number(body.limit)).map((distance, i) => ({ ticket_id: String(offset + i), distance })) as T
  }
  async function* batches() { yield Array.from({ length: 280 }, (_, i) => String(i)) }
  const hits = await client.searchBatches('test', [1], batches(), 15, undefined, .75)
  expect(hits).toHaveLength(260)
  expect(pages).toEqual([0, 100, 200])
  scores = Array.from({ length: 280 }, (_, i) => i < 5 ? .9 : .75 - i * .001)
  expect(await client.searchBatches('test', [1], batches(), 15, undefined, .75)).toHaveLength(15)
  scores = [.9, .8, .75]
  expect(await client.searchBatches('test', [1], batches(), 15, undefined, .75)).toHaveLength(3)
})
