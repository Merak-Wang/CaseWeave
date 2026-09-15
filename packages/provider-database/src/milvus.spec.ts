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
