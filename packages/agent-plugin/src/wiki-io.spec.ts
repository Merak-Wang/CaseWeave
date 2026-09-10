import { expect, it } from 'vitest'
import { mapWikiFiles } from './wiki-io.js'

it('keeps failed publication work pending until all started file operations settle', async () => {
  let finish!: () => void
  const pending = new Promise<void>(resolve => { finish = resolve })
  const started: number[] = []
  let settled = false
  const work = mapWikiFiles([0, 1, 2, 3, 4], async value => {
    started.push(value)
    if (value === 0) throw new Error('disk failure')
    await pending
    return value
  })
  const checked = expect(work).rejects.toThrow('disk failure').then(() => { settled = true })
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(settled).toBe(false)
  expect(started).toEqual([0, 1, 2, 3])
  finish()
  await checked
  expect(started).toEqual([0, 1, 2, 3])
})

it('keeps result order when file operations finish out of order', async () => {
  let finishFirst!: () => void
  const first = new Promise<void>(resolve => { finishFirst = resolve })
  const order: number[] = []
  const result = mapWikiFiles([0, 1, 2, 3, 4], async value => {
    if (value === 0) await first
    else if (value === 3) finishFirst()
    order.push(value)
    return value
  })
  expect(await result).toEqual([0, 1, 2, 3, 4])
  expect(order).toEqual([1, 2, 3, 0, 4])
})
