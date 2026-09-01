import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

interface LocalAppModule {
  readonly helpText: () => string
  readonly normalizedRerankerFlag: (value: string | undefined) => string
  readonly modelServiceAction: (input: {
    readonly ready: boolean
    readonly manage: boolean
    readonly baseUrl: string
  }) => string
  readonly parseCliArgs: (args: readonly string[]) => { readonly command: string; readonly forwardedArgs: readonly string[] }
  readonly parseModelSyncArgs: (args: readonly string[]) => { readonly all: boolean; readonly roles: readonly string[] }
  readonly profileSetupAction: (manifest: unknown, bundleRoot: string, profileRoot: string) => string
  readonly resolveLocalAppPaths: (environment: Record<string, string>, projectRoot: string) => {
    readonly dshHome: string
    readonly runnerRoot: string
    readonly vectorCacheDir: string
  }
}

let launcher: LocalAppModule

beforeAll(async () => {
  launcher = await import(pathToFileURL(resolve('scripts/local-app.mjs')).href) as LocalAppModule
})

describe('local source launcher', () => {
  it('separates setup and web while forwarding only DSH Web options', () => {
    expect(launcher.parseCliArgs([])).toEqual({ command: 'help', forwardedArgs: [] })
    expect(launcher.parseCliArgs(['setup'])).toEqual({ command: 'setup', forwardedArgs: [] })
    expect(launcher.parseCliArgs(['models'])).toEqual({ command: 'models', forwardedArgs: [] })
    expect(launcher.parseCliArgs(['models', '--all'])).toEqual({ command: 'models', forwardedArgs: ['--all'] })
    expect(launcher.parseCliArgs(['web', '--no-open', '--port', '3081'])).toEqual({
      command: 'web',
      forwardedArgs: ['--no-open', '--port', '3081'],
    })
    expect(() => launcher.parseCliArgs(['build'])).toThrow(/unknown command/u)
    expect(launcher.parseModelSyncArgs([])).toEqual({ all: false, roles: [] })
    expect(launcher.parseModelSyncArgs(['--all'])).toEqual({ all: true, roles: [] })
    expect(launcher.parseModelSyncArgs(['--role', 'reranker'])).toEqual({ all: false, roles: ['reranker'] })
    expect(() => launcher.parseModelSyncArgs(['--all', '--role', 'reranker'])).toThrow(/cannot combine/u)
  })

  it('keeps persistent runtime state and vector cache under ignored project paths by default', () => {
    const projectRoot = resolve('source-launch-fixture')
    const paths = launcher.resolveLocalAppPaths({}, projectRoot)
    expect(paths.dshHome).toBe(resolve(projectRoot, '.cache/retrieval-agent-local/dsh-home'))
    expect(paths.runnerRoot).toBe(resolve(projectRoot, '.cache/retrieval-agent-local/runtime/dsh-runner'))
    expect(paths.vectorCacheDir).toBe(resolve(projectRoot, '.cache/retrieval-agent-vectors'))

    const overridden = launcher.resolveLocalAppPaths({
      RETRIEVAL_AGENT_DSH_HOME: 'local/dsh',
      RETRIEVAL_AGENT_VECTOR_CACHE_DIR: 'local/vectors',
    }, projectRoot)
    expect(overridden.dshHome).toBe(resolve(projectRoot, 'local/dsh'))
    expect(overridden.vectorCacheDir).toBe(resolve(projectRoot, 'local/vectors'))
  })

  it('normalizes accepted reranker flags for the restricted DSH preset expression', () => {
    expect(['1', 'true', 'TRUE', 'yes', 'on'].map(launcher.normalizedRerankerFlag)).toEqual([
      'true', 'true', 'true', 'true', 'true',
    ])
    expect(launcher.normalizedRerankerFlag(undefined)).toBe('false')
    expect(launcher.normalizedRerankerFlag('off')).toBe('false')
  })

  it('initializes or links the public DSH Web profile only when needed', () => {
    const bundleRoot = resolve('packages/bundle')
    const profileRoot = resolve('.cache/test-profile')
    expect(launcher.profileSetupAction(undefined, bundleRoot, profileRoot)).toBe('initialize')
    expect(launcher.profileSetupAction({ dsh: { profile: { bundles: [] } } }, bundleRoot, profileRoot)).toBe('invalid')
    const base = {
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
      dependencies: {},
    }
    expect(launcher.profileSetupAction(base, bundleRoot, profileRoot)).toBe('link')
    expect(launcher.profileSetupAction({
      dsh: { profile: { bundles: [...base.dsh.profile.bundles, '@retrieval-agent/bundle'] } },
      dependencies: { '@retrieval-agent/bundle': `link:${bundleRoot.replaceAll('\\', '/')}` },
    }, bundleRoot, profileRoot)).toBe('reuse')
  })

  it('reuses ready services and only manages an unavailable loopback HTTP service', () => {
    expect(launcher.modelServiceAction({
      ready: true, manage: false, baseUrl: 'https://models.example.test',
    })).toBe('reuse')
    expect(launcher.modelServiceAction({
      ready: false, manage: true, baseUrl: 'https://models.example.test',
    })).toBe('unavailable')
    expect(launcher.modelServiceAction({
      ready: false, manage: false, baseUrl: 'http://127.0.0.1:8012',
    })).toBe('unavailable')
    expect(launcher.modelServiceAction({
      ready: false, manage: true, baseUrl: 'http://127.0.0.1:8012',
    })).toBe('start')
  })

  it('documents build-once/run-many instead of hiding a build in the web command', () => {
    const help = launcher.helpText()
    expect(help).toContain('pnpm build')
    expect(help).toContain('once')
    expect(help).toContain('pnpm retrieval-agent web')
    expect(help).toContain('pnpm retrieval-agent models')
    expect(help).toContain('active, pinned model dependencies')
    expect(help).toContain('never runs a product build, pack, clean-install verification or uninstall')
  })
})
