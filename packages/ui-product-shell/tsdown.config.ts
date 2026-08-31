import { defineConfig } from 'tsdown'

const clientModuleTable = new Set([
  'react',
  'react/jsx-runtime',
  '@deepseek-ai/dsh-client-runtime/client',
  '@deepseek-ai/dsh-client-ui-conversation/client',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-slots',
])

export default defineConfig({
  name: '@retrieval-agent/ui-product-shell/client',
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
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "@retrieval-agent/ui-product-shell", factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
