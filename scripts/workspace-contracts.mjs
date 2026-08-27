import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const contractPath = join(root, 'architecture', 'workspace.json')
const graphPath = join(root, 'docs', 'WORKSPACE_GRAPH.md')
const mode = process.argv[2] ?? '--check'

if (!['--check', '--write'].includes(mode)) {
  throw new Error('usage: node scripts/workspace-contracts.mjs [--check|--write]')
}

const contract = JSON.parse(await readFile(contractPath, 'utf8'))
const failures = []
const packageByName = new Map(contract.packages.map(entry => [entry.name, entry]))
const dependencySections = ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']

async function filesUnder(directory) {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'lib' || entry.name === 'node_modules') continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) result.push(...await filesUnder(path))
    else result.push(path)
  }
  return result
}

function slash(path) {
  return path.split(sep).join('/')
}

function sourceLineCount(text) {
  if (text.length === 0) return 0
  const normalized = text.replace(/\r\n/gu, '\n')
  return normalized.split('\n').length - (normalized.endsWith('\n') ? 1 : 0)
}

for (const forbidden of contract.forbiddenGenericPackageNames) {
  if (packageByName.has(`${contract.packageScope}${forbidden}`)) {
    failures.push(`generic catch-all package is forbidden: ${contract.packageScope}${forbidden}`)
  }
}

const diskPackageDirectories = (await readdir(join(root, 'packages'), { withFileTypes: true }))
  .filter(entry => entry.isDirectory())
  .map(entry => entry.name)
  .sort()
const declaredDirectories = contract.packages.map(entry => entry.directory).sort()
if (JSON.stringify(diskPackageDirectories) !== JSON.stringify(declaredDirectories)) {
  failures.push(`workspace manifest drift: disk=${diskPackageDirectories.join(',')} declared=${declaredDirectories.join(',')}`)
}

for (const entry of contract.packages) {
  const packageDirectory = join(root, 'packages', entry.directory)
  let manifest
  try {
    manifest = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8'))
  } catch (error) {
    failures.push(`cannot read packages/${entry.directory}/package.json: ${error.message}`)
    continue
  }
  if (manifest.name !== entry.name) failures.push(`packages/${entry.directory}: expected package name ${entry.name}, got ${manifest.name}`)
  if (!manifest.name?.startsWith(contract.packageScope)) failures.push(`packages/${entry.directory}: first-party package must use ${contract.packageScope} prefix`)

  const actualInternalDependencies = new Set()
  for (const section of dependencySections) {
    for (const dependency of Object.keys(manifest[section] ?? {})) {
      if (packageByName.has(dependency)) actualInternalDependencies.add(dependency)
    }
  }
  for (const dependency of actualInternalDependencies) {
    if (!entry.allowedInternalDependencies.includes(dependency)) failures.push(`${entry.name}: internal dependency ${dependency} is outside its allowed boundary`)
  }

  const sourceDirectory = join(packageDirectory, 'src')
  let sourceFiles = []
  try {
    if ((await stat(sourceDirectory)).isDirectory()) sourceFiles = (await filesUnder(sourceDirectory)).filter(path => path.endsWith('.ts') || path.endsWith('.tsx'))
  } catch {
    sourceFiles = []
  }
  let packageLines = 0
  for (const file of sourceFiles) {
    const relativeFile = slash(relative(root, file))
    const source = await readFile(file, 'utf8')
    const lines = sourceLineCount(source)
    const isTest = /\.spec\.tsx?$/u.test(file)
    if (isTest) {
      const implementation = file.replace(/\.spec(\.tsx?)$/u, '$1')
      try {
        if (!(await stat(implementation)).isFile()) failures.push(`${relativeFile}: adjacent test has no matching implementation module`)
      } catch {
        failures.push(`${relativeFile}: adjacent test has no matching implementation module`)
      }
      continue
    }
    packageLines += lines
    if (lines > contract.maxModuleLines) failures.push(`${relativeFile}: ${lines} lines exceeds module limit ${contract.maxModuleLines}`)
    if (/export\s+function\s+apply\s*\(/u.test(source)
      && /export\s+const\s+inject\s*=/u.test(source)
      && /export\s+default\b/u.test(source)) {
      failures.push(`${relativeFile}: DSH plugin entry with named apply/inject must not export a default that hides loader metadata`)
    }

    const importPattern = /(?:from\s+|import\s*\()(['"])(@retrieval-agent\/[^'"/]+)(?:\/[^'"]*)?\1/gu
    for (const match of source.matchAll(importPattern)) {
      const dependency = match[2]
      if (dependency !== entry.name && !actualInternalDependencies.has(dependency)) failures.push(`${relativeFile}: imports undeclared internal dependency ${dependency}`)
      if (dependency !== entry.name && !entry.allowedInternalDependencies.includes(dependency)) failures.push(`${relativeFile}: imports ${dependency} outside allowed boundary`)
    }

    if (file.endsWith(`${sep}${contract.protocolConvention.fileName}`)) {
      const declarationPattern = /export\s+(?:interface|type|class)\s+([A-Za-z_$][\w$]*)/gu
      for (const match of source.matchAll(declarationPattern)) {
        const typeName = match[1]
        if (!contract.protocolConvention.allowedExportedTypeSuffixes.some(suffix => typeName.endsWith(suffix))) {
          failures.push(`${relativeFile}: exported wire type ${typeName} must end in ${contract.protocolConvention.allowedExportedTypeSuffixes.join(', ')}`)
        }
      }
    }
  }
  if (packageLines > entry.maxSourceLines) failures.push(`${entry.name}: ${packageLines} production lines exceeds package budget ${entry.maxSourceLines}`)

  const misplacedTests = (await filesUnder(packageDirectory)).filter(path => /\.spec\.tsx?$/u.test(path) && !path.startsWith(`${sourceDirectory}${sep}`))
  for (const file of misplacedTests) failures.push(`${slash(relative(root, file))}: package tests must be adjacent under src/`)
}

function graphMarkdown() {
  const rows = contract.packages.map(entry => {
    const dependencies = entry.allowedInternalDependencies.length === 0
      ? '—'
      : entry.allowedInternalDependencies.map(value => `\`${value}\``).join('<br>')
    return `| \`${entry.name}\` | ${entry.kind} | ${entry.capability} | ${dependencies} | ${entry.maxSourceLines} |`
  })
  const edges = contract.packages.flatMap(entry => entry.allowedInternalDependencies.map(dependency => {
    const from = entry.directory.replace(/-/gu, '_')
    const to = packageByName.get(dependency).directory.replace(/-/gu, '_')
    return `  ${from} --> ${to}`
  }))
  const nodes = contract.packages.map(entry => `  ${entry.directory.replace(/-/gu, '_')}["${entry.name}<br/>${entry.kind}"]`)
  return `<!-- Generated by scripts/workspace-contracts.mjs. Do not edit by hand. -->
# Workspace 能力图

状态：\`implemented\`。本页由 \`architecture/workspace.json\` 生成；\`pnpm verify:workspace\` 同时检查图漂移、包命名、允许依赖、协议类型后缀、测试位置和源码体积预算。

箭头 \`A --> B\` 表示 A 可以在构建时依赖 B；它不是运行时数据流，也不代表 B 可以反向访问 A。

\`\`\`mermaid
flowchart LR
${nodes.join('\n')}
${edges.join('\n')}
\`\`\`

| 包 | 角色 | 独占能力 | 允许的一方依赖 | 生产源码预算 |
| --- | --- | --- | --- | ---: |
${rows.join('\n')}

## 命名与增长门槛

- 一方包必须使用 \`${contract.packageScope}*\`；禁止创建 ${contract.forbiddenGenericPackageNames.map(value => `\`${value}\``).join('、')} 这类兜底包。
- 线协议只放在 \`${contract.protocolConvention.fileName}\`，导出载荷使用 ${contract.protocolConvention.allowedExportedTypeSuffixes.map(value => `\`*${value}\``).join('、')} 后缀。
- 包内测试与实现相邻，使用 \`name.spec.ts\`；跨包组合测试才进入根目录 \`${contract.testConvention.repositoryIntegrationRoot}/\`。
- 单个生产模块不得超过 ${contract.maxModuleLines} 行；包预算不是扩容目标，接近门槛就应重新判断能力所有权。

## 运行时边界

\`ui-ticket-results\` 只渲染安全投影，并只依赖 \`product-api/protocol\` 的线协议；\`product-host\` 才能把协议绑定到 DSH Web、活动 Session 与可信 Principal。\`bundle\` 是唯一默认装配点，因而可以依赖具体本地 Provider；\`agent-plugin\` 只依赖 Provider 端口，不得把 Provider 算法收回应用层。Python 评测位于生产 pnpm workspace 之外，只能通过公开测试驱动协议观察产品。
`
}

const expectedGraph = graphMarkdown()
if (mode === '--write') {
  await writeFile(graphPath, expectedGraph, 'utf8')
} else {
  let currentGraph = ''
  try {
    currentGraph = await readFile(graphPath, 'utf8')
  } catch {
    failures.push('docs/WORKSPACE_GRAPH.md is missing; run pnpm graph:workspace')
  }
  if (currentGraph !== expectedGraph) failures.push('docs/WORKSPACE_GRAPH.md is stale; run pnpm graph:workspace')
}

if (failures.length > 0) {
  console.error(failures.map(failure => `- ${failure}`).join('\n'))
  process.exitCode = 1
} else {
  console.log(`workspace contract verified for ${contract.packages.length} packages`)
}
