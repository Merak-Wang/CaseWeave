import Module, { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import { installDshCjsResolutionCompatibility } from './cjs-resolution.js'

const cjs = Module as unknown as { _resolveFilename: (...args: any[]) => string }
const native = cjs._resolveFilename
afterEach(() => { cjs._resolveFilename = native })

it('resolves tr46 actual userland punycode dependency through the native exit of the broken rc.2 hook', () => {
  const provider = createRequire(realpathSync(new URL('../../provider-database/package.json', import.meta.url)))
  const mongo = createRequire(provider.resolve('mongodb'))
  const connection = createRequire(mongo.resolve('mongodb-connection-string-url'))
  const url = createRequire(connection.resolve('whatwg-url'))
  const tr46 = createRequire(url.resolve('tr46'))
  const expected = tr46.resolve('punycode/')
  cjs._resolveFilename = function (request, parent, isMain, options) {
    if (request === 'punycode/' && options?.paths === undefined) {
      // 真实rc.2将请求截成内置模块名，resolve.paths返回null导致for-of失败。
      for (const _path of tr46.resolve.paths('punycode')!) void _path
    }
    return native.call(this, request, parent, isMain, options)
  }
  expect(() => tr46.resolve('punycode/')).toThrow(TypeError)
  const dispose = installDshCjsResolutionCompatibility()
  expect(tr46.resolve('punycode/')).toBe(expected)
  expect(tr46('punycode/').toASCII('中文.example')).toBe('xn--fiq228c.example')
  dispose()
  expect(() => tr46.resolve('punycode/')).toThrow(TypeError)
})

it('preserves other requests and explicit paths while retaining the targeted request conditions', () => {
  const original = vi.fn(() => 'resolved'), parent = { paths: ['synthetic-module-path'] }
  cjs._resolveFilename = original
  const dispose = installDshCjsResolutionCompatibility()
  const explicit = { paths: ['explicit-path'], conditions: ['require'] }
  cjs._resolveFilename('mongodb', parent, false, explicit)
  cjs._resolveFilename('punycode/', parent, false, explicit)
  cjs._resolveFilename('punycode/', parent, false, { conditions: ['require'] })
  expect(original.mock.calls).toEqual([
    ['mongodb', parent, false, explicit], ['punycode/', parent, false, explicit],
    ['punycode/', parent, false, { conditions: ['require'], paths: parent.paths }],
  ])
  dispose(); expect(cjs._resolveFilename).toBe(original)
})

it('does not overwrite a later external hook on disposal', () => {
  const dispose = installDshCjsResolutionCompatibility(), later = vi.fn(() => 'later')
  cjs._resolveFilename = later; dispose()
  expect(cjs._resolveFilename).toBe(later)
})
