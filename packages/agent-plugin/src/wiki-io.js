/**
 * Bound file I/O while keeping manifest order and waiting for every started
 * operation on failure. A publisher must not release its lock with writes pending.
 * @template T, R
 * @param {readonly T[]} values
 * @param {(value: T) => Promise<R>} work
 * @returns {Promise<R[]>}
 */
export async function mapWikiFiles(values, work) {
  const output = []
  for (let start = 0; start < values.length; start += 4) {
    const batch = await Promise.allSettled(values.slice(start, start + 4).map(work))
    for (const result of batch) {
      if (result.status === 'rejected') throw result.reason
      output.push(result.value)
    }
  }
  return output
}
