import { readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const mode = process.argv[2] ?? '--check'
if (!['--check', '--write'].includes(mode)) throw new Error('usage: workspace-contracts.mjs [--check|--write]')
const metadata = JSON.parse(await readFile(join(root, 'architecture/workspace.json'), 'utf8'))
const failures = []
async function filesUnder(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['lib', 'node_modules'].includes(entry.name)) continue
    const path = join(directory, entry.name)
    files.push(...(entry.isDirectory() ? await filesUnder(path) : [path]))
  }
  return files
}
const packages = []
for (const directory of await readdir(join(root, 'packages'), { withFileTypes: true })) {
  if (!directory.isDirectory()) continue
  const path = join(root, 'packages', directory.name)
  let manifest
  try { manifest = JSON.parse(await readFile(join(path, 'package.json'), 'utf8')) }
  catch (error) {
    if (error.code !== 'ENOENT') throw error
    if ((await filesUnder(path)).length) failures.push(`source without package manifest: ${directory.name}`)
    continue
  }
  const description = metadata.packages.find(p => p.name === manifest.name)
  packages.push({ directory: directory.name, manifest, name: manifest.name,
    kind: description?.kind ?? 'module', capability: description?.capability ?? manifest.description ?? '' })
}
packages.sort((a, b) => a.name.localeCompare(b.name))
const byName = new Map(packages.map(p => [p.name, p]))
for (const entry of packages) {
  const dependencies = new Set(['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']
    .flatMap(section => Object.keys(entry.manifest[section] ?? {})))
  entry.dependencies = [...dependencies].filter(name => byName.has(name)).sort()
  if (!entry.name.startsWith(metadata.packageScope)) failures.push(`unexpected package scope: ${entry.name}`)
  for (const file of await filesUnder(join(root, 'packages', entry.directory))) {
    if (!/\.[cm]?[jt]sx?$/.test(file) || /\.(spec|test)\./.test(file)) continue
    const source = await readFile(file, 'utf8'), label = relative(root, file).replaceAll('\\', '/')
    if (/export\s+function\s+apply\s*\(/u.test(source) && /export\s+const\s+inject\s*=/u.test(source) && /export\s+default\b/u.test(source)) failures.push(`${label}: default export hides DSH loader metadata`)
    if (/\bextends\s+Service\b/u.test(source) && /(^|[^\w$])#[A-Za-z_$][\w$]*/mu.test(source)) failures.push(`${label}: Cordis trace proxies cannot use #private members`)
    for (const match of source.matchAll(/(?:from\s+|import\s*\()(['"])(@retrieval-agent\/[^'"/]+)(?:\/[^'"]*)?\1/gu)) {
      if (match[2] !== entry.name && !dependencies.has(match[2])) failures.push(`${label}: undeclared dependency ${match[2]}`)
    }
  }
}
const node = entry => entry.directory.replaceAll('-', '_')
const graph = `<!-- Generated from package.json by scripts/workspace-contracts.mjs. -->
# Workspace 能力图

本图来自实际 workspace 的 package.json；角色说明来自 architecture/workspace.json。箭头表示已声明的构建依赖（包含开发/peer 依赖），不是运行时数据流或依赖许可清单。

\`\`\`mermaid
flowchart LR
${packages.map(p => `  ${node(p)}["${p.name}<br/>${p.kind}"]`).join('\n')}
${packages.flatMap(p => p.dependencies.map(d => `  ${node(p)} --> ${node(byName.get(d))}`)).join('\n')}
\`\`\`

| 包 | 角色 | 职责 | 已声明的一方依赖 |
| --- | --- | --- | --- |
${packages.map(p => `| \`${p.name}\` | ${p.kind} | ${p.capability} | ${p.dependencies.map(d => `\`${d}\``).join('<br>') || '—'} |`).join('\n')}

浏览器通过 domain/result、domain/replay 和 product-api 的明确客户端出口复用逻辑；Host、数据库和 DSH 装配保留在服务端。测试按用户行为或实际失败边界组织，不要求与实现文件一一对应。发布检查只处理 bundle 实际运行依赖闭包。
`
const graphPath = join(root, 'docs/WORKSPACE_GRAPH.md')
if (mode === '--write' && !failures.length) await writeFile(graphPath, graph)
else if (await readFile(graphPath, 'utf8').catch(() => '') !== graph) failures.push('workspace graph changed: run pnpm graph:workspace')
if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1 }
else console.log(`workspace verified for ${packages.length} packages`)
