import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { 'workbench-client': 'src/workbench-client.js' },
  outDir: 'lib', format: 'esm', platform: 'browser', target: 'es2023',
  dts: false, sourcemap: true, clean: false,
  deps: { alwaysBundle: () => true },
})
