import { defineConfig } from 'tsdown'

export default defineConfig(['workbench-client', 'dataset-client'].map(name => ({
  entry: { [name]: `src/${name}.js` },
  outDir: 'lib', format: 'esm', platform: 'browser', target: 'es2023',
  dts: false, sourcemap: true, clean: false,
  deps: { alwaysBundle: () => true },
})))