import { readFile, rm } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packagesRoot = resolve(root, 'packages')
const contract = JSON.parse(await readFile(resolve(root, 'architecture', 'workspace.json'), 'utf8'))

for (const entry of contract.packages) {
  const target = resolve(packagesRoot, entry.directory, 'lib')
  const relativeTarget = relative(packagesRoot, target)
  if (relativeTarget.startsWith(`..${sep}`) || relativeTarget === '..' || !relativeTarget.endsWith(`${sep}lib`)) {
    throw new Error(`refusing to clean unexpected build path: ${target}`)
  }
  await rm(target, { recursive: true, force: true })
}

console.log(`cleaned generated lib directories for ${contract.packages.length} packages`)
