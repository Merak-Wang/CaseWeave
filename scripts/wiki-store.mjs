/** CLI for the same release-pinned reader shipped in the agent plugin. */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile, writeFile } from 'node:fs/promises'
import { openWiki } from '../packages/agent-plugin/src/wiki-store.js'
import { checkoutEntry, publishWiki, rollbackWiki, activateImportedWiki } from '../packages/agent-plugin/src/wiki-publisher.js'
export { openWiki, validateEntry, assertSafeProse, sha256 } from '../packages/agent-plugin/src/wiki-store.js'

async function main() {
  const args = process.argv.slice(2)
  const command = args.shift()
  const option = (key, fallback) => { const i = args.indexOf(key); return i === -1 ? fallback : args[i + 1] }
  const root = option('--wiki', fileURLToPath(new URL('../wiki/', import.meta.url)))
  let output
  if (command === 'checkout') {
    const draft = await checkoutEntry(root, option('--id', ''))
    const target = option('--out', undefined)
    if (!target) throw new Error('checkout requires --out')
    await writeFile(target, JSON.stringify(draft, null, 2) + '\n', { flag: 'wx' })
    console.log(JSON.stringify({ draft: target, baseRelease: draft.baseRelease })); return
  }
  if (command === 'publish') {
    output = await publishWiki(root, JSON.parse(await readFile(option('--delta', ''), 'utf8')))
    console.log(JSON.stringify(output, null, 2)); return
  }
  if (command === 'rollback') {
    output = await rollbackWiki(root, option('--release', ''))
    console.log(JSON.stringify(output, null, 2)); return
  }
  if (command === 'activate-import') {
    console.log(JSON.stringify(await activateImportedWiki(root, option('--release', '')))); return
  }
  const wiki = await openWiki(root, { releaseId: option('--release', undefined) })
  if (command === 'catalog') output = { releaseId: wiki.releaseId, domains: wiki.catalog(), ...(wiki.warning ? { warning: wiki.warning } : {}) }
  else if (command === 'search') output = wiki.search(option('--query', ''), { phase: option('--phase', 'post-fast-query'), domainIds: option('--domain', undefined)?.split(',') })
  else if (command === 'read') output = wiki.read(option('--id', ''))
  else if (command === 'verify') output = { releaseId: wiki.releaseId, domains: wiki.catalog().length, entries: wiki.catalog().reduce((n, d) => n + d.knowledgeRefs.length, 0), integrity: 'passed', semanticQuality: 'not-evaluated', ...(wiki.warning ? { warning: wiki.warning } : {}) }
  else throw new Error('Usage: wiki-store.mjs catalog|search|read|verify|checkout|publish|rollback [--wiki path] [--query text] [--id id] [--out file] [--delta file] [--release id]')
  console.log(JSON.stringify(output, null, 2))
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(`Wiki operation rejected: ${error.message}`); process.exitCode = 1 })
