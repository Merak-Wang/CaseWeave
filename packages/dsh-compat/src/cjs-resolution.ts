import Module from 'node:module'

interface ResolveOptions { paths?: string[]; conditions?: string[] }
interface ModuleParent { paths: string[] }
type Resolver = (request: string, parent?: ModuleParent, isMain?: boolean, options?: ResolveOptions) => string
const cjs = Module as unknown as { _resolveFilename: Resolver }

/** rc.2把punycode/截成Node内置punycode；显式父模块路径交回原生解析，保留其他DSH路由。 */
export function installDshCjsResolutionCompatibility(): () => void {
  const original = cjs._resolveFilename
  const wrapped: Resolver = function (this: unknown, request, parent, isMain, options) {
    return original.call(this, request, parent, isMain,
      request === 'punycode/' && parent && options?.paths === undefined ? { ...options, paths: parent.paths } : options)
  }
  cjs._resolveFilename = wrapped
  return () => { if (cjs._resolveFilename === wrapped) cjs._resolveFilename = original }
}
