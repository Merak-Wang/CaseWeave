import { defineConfig } from 'tsdown'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { transform } from 'lightningcss'

const CSS_PREFIX = '\0retrieval-agent-css:'
const CSS_SUFFIX = '.mjs'

const clientModuleTable = new Set([
  'react',
  'react/jsx-runtime',
  '@deepseek-ai/dsh-client-ui-chat/client',
  '@deepseek-ai/dsh-client-ui-conversation/client',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-slots',
])

export default defineConfig({
  name: '@retrieval-agent/ui-ticket-results/client',
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2023',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    neverBundle: specifier => clientModuleTable.has(specifier),
    alwaysBundle: specifier => !clientModuleTable.has(specifier),
  },
  plugins: [{
    name: 'retrieval-agent-css-modules-inline',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.module.css') || importer === undefined) return null
      return CSS_PREFIX + resolve(dirname(importer), source) + CSS_SUFFIX
    },
    async load(virtualId: string) {
      if (!virtualId.startsWith(CSS_PREFIX)) return null
      const fileId = virtualId.slice(CSS_PREFIX.length, -CSS_SUFFIX.length)
      this.addWatchFile(fileId)
      const source = await readFile(fileId)
      const result = transform({ filename: fileId, code: source, cssModules: { pattern: '[hash]_[local]' }, minify: true })
      const classMap: Record<string, string> = {}
      for (const [local, value] of Object.entries(result.exports ?? {})) classMap[local] = value.name
      const tagId = '@retrieval-agent/ui-ticket-results/CandidatePanel.module.css'
      return [
        `const cssText = ${JSON.stringify(result.code.toString())};`,
        `const tagId = ${JSON.stringify(tagId)};`,
        "if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {",
        "  const tag = document.createElement('style');",
        "  tag.dataset.plugin = '@retrieval-agent/ui-ticket-results';",
        '  tag.dataset.pluginCss = tagId;',
        '  tag.textContent = cssText;',
        '  document.head.appendChild(tag);',
        '}',
        `export default ${JSON.stringify(classMap)};`,
      ].join('\n')
    },
  }],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "@retrieval-agent/ui-ticket-results", factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
