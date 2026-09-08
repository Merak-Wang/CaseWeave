import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Real Compose parses .env/YAML; a Docker shim controls costly deployment commands.
// Fixtures remain below ignored .tmp; no real containers/volumes are changed.
const root = fileURLToPath(new URL('..', import.meta.url))
const windows = process.platform === 'win32'
const docker = execFileSync(windows ? 'where.exe' : 'which', ['docker'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0]
const bash = windows ? resolve(process.env.ProgramFiles, 'Git/bin/bash.exe') : 'bash'
const parent = join(root, '.tmp/setup-tests')
mkdirSync(parent, { recursive: true })
const sampleKey = 'setup-demo $literal ${NOT_EXPANDED} # quote" apostrophe\' slash\\ equals=tail\\'
const quote = value => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', () => '$$') + '"'

function fixture({ configured = true, mode = '' } = {}) {
  const dir = mkdtempSync(join(parent, 'path with spaces-'))
  for (const path of ['setup.sh', 'setup.ps1', 'setup.cmd', '.env.example', 'config/database', 'config/model-service', 'config/app']) {
    cpSync(join(root, path), join(dir, path), { recursive: true })
  }
  const env = { ...process.env }
  for (const name of Object.keys(env)) if (/^(?:COMPOSE_|RETRIEVAL_AGENT_)/u.test(name)) delete env[name]
  Object.assign(env, { SETUP_FIXTURE: dir, SETUP_REAL_DOCKER: docker, SETUP_TEST_MODE: mode })
  mkdirSync(join(dir, 'fake-bin'))
  writeFileSync(join(dir, 'fake-bin/docker'), '#!/usr/bin/env bash\nexec node "$SETUP_FIXTURE/fake-docker.mjs" "$@"\n', { mode: 0o755 })
  writeFileSync(join(dir, 'fake-docker.mjs'), `
import {spawnSync} from 'node:child_process'; import {appendFileSync} from 'node:fs'; import {join} from 'node:path';
const args=process.argv.slice(2), mode=process.env.SETUP_TEST_MODE;
if(args[0]==='info'){if(mode==='offline')process.exit(62);console.log(mode==='windows'?'windows':'linux');process.exit(0)}
if(args[1]==='version'||args.includes('config')){const r=spawnSync(process.env.SETUP_REAL_DOCKER,args,{stdio:'inherit'});process.exit(r.status??1)}
appendFileSync(join(process.env.SETUP_FIXTURE,'calls.jsonl'),JSON.stringify(args)+'\\n');
if(mode==='index-failure'&&args.at(-1)==='prepare'&&args.includes('scripts/database.mjs'))process.exit(37);
if(mode==='gpu-failure'&&args.includes('up')&&args.includes('model-service'))process.exit(42);
if(mode==='start-failure'&&args.includes('up'))process.exit(43);
`)
  if (configured) {
    let text = readFileSync(join(dir, '.env.example'), 'utf8')
    const values = {
      RETRIEVAL_AGENT_BROWSER_LLM_PROVIDER: 'deepseek', RETRIEVAL_AGENT_BROWSER_LLM_MODEL: 'setup-demo',
      RETRIEVAL_AGENT_BROWSER_LLM_BASE_URL: 'https://example.invalid/v1',
      RETRIEVAL_AGENT_BROWSER_LLM_API_KEY_ENV: 'RETRIEVAL_AGENT_MAIN_MODEL_API_KEY',
      RETRIEVAL_AGENT_MAIN_MODEL_API_KEY: sampleKey,
    }
    for (const [key, value] of Object.entries(values)) text = text.replace(new RegExp('^' + key + '=.*$', 'm'), () => key + '=' + quote(value))
    writeFileSync(join(dir, '.env'), text)
  }
  return {
    dir, env,
    run(args = [], input) {
      const result = spawnSync(bash, ['-c', 'cd "$SETUP_FIXTURE"; export PATH="$PWD/fake-bin:$PATH"; exec bash ./setup.sh "$@"', 'setup', ...args],
        { cwd: root, env, input, encoding: 'utf8', timeout: 120_000 })
      assert.ifError(result.error)
      assert.ok(!result.stdout.includes(sampleKey) && !result.stderr.includes(sampleKey), 'credential must not appear in output')
      return result
    },
    calls() { const path = join(dir, 'calls.jsonl'); return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse) : [] },
    config() { return execFileSync(docker, ['compose', '--env-file', '.env', 'config', '--environment'], { cwd: dir, env, encoding: 'utf8' }) },
  }
}

test('first-run public wizard preserves special characters and configures all deployment stages', () => {
  const f = fixture({ configured: false })
  const result = f.run([], ['cpu', 'deepseek', 'setup-demo', 'https://example.invalid/v1', sampleKey, ''].join('\n'))
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /部署完成：http:\/\/127.0.0.1:3080\/retrieval/u)
  const actual = f.config().split(/\r?\n/).find(line => line.startsWith('RETRIEVAL_AGENT_MAIN_MODEL_API_KEY='))?.split('=').slice(1).join('=')
  assert.equal(actual, sampleKey)
  assert.equal(f.calls().length, 8)
})

test('index failure stops before app startup; rerun preserves configuration and never deletes volumes', () => {
  const f = fixture({ mode: 'index-failure' }), before = readFileSync(join(f.dir, '.env'), 'utf8')
  const failed = f.run(['--non-interactive'])
  assert.equal(failed.status, 37, failed.stderr)
  assert.match(failed.stderr, /未完成：\[5\/8\]/u)
  assert.ok(!failed.stdout.includes('部署完成'))
  assert.ok(!f.calls().some(call => call.includes('up') && call.at(-1) === 'app'))
  f.env.SETUP_TEST_MODE = ''
  const resumed = f.run(['--non-interactive', '--no-build'])
  assert.equal(resumed.status, 0, resumed.stderr)
  assert.equal(readFileSync(join(f.dir, '.env'), 'utf8'), before)
  assert.ok(f.calls().every(call => !call.includes('down') && !call.includes('--volumes')))
  assert.ok(f.calls().at(-1).includes('app'))
})

test('non-interactive missing configuration fails before building/downloading', () => {
  const f = fixture({ configured: false })
  const result = f.run(['--non-interactive'])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /缺少配置：RETRIEVAL_AGENT_BROWSER_LLM_PROVIDER/u)
  assert.deepEqual(f.calls(), [])
})

test('check is read-only and works with an env path containing spaces', () => {
  const f = fixture(), path = join(f.dir, '.env')
  const before = readFileSync(path, 'utf8')
  const result = f.run(['--check', '--env-file', path])
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(f.calls(), [])
  assert.equal(readFileSync(path, 'utf8'), before)
})

test('explicit GPU failure cannot fall back to CPU or announce completion', () => {
  const f = fixture({ mode: 'gpu-failure' })
  const result = f.run(['--gpu', '--non-interactive'])
  assert.equal(result.status, 42, result.stderr)
  assert.match(readFileSync(join(f.dir, '.env'), 'utf8'), /compose\.gpu\.yml/u)
  assert.ok(!result.stdout.includes('部署完成'))
  assert.equal(f.calls().filter(call => call.includes('up')).length, 1)
})

for (const mode of ['offline', 'windows']) {
  test(`Docker ${mode} fails before creating local configuration`, () => {
    const f = fixture({ configured: false, mode })
    const result = f.run(['--non-interactive'])
    assert.notEqual(result.status, 0)
    assert.ok(!existsSync(join(f.dir, '.env')))
    assert.deepEqual(f.calls(), [])
  })
}

test('daily start skips installation, preserves configuration and never builds or downloads', () => {
  const f = fixture(), before = readFileSync(join(f.dir, '.env'), 'utf8')
  const result = f.run(['start'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /工作台已启动/u)
  const calls = f.calls()
  assert.equal(calls.length, 1)
  assert.ok(calls[0].includes('up') && calls[0].includes('--no-build') && calls[0].includes('never'))
  assert.ok(!calls[0].includes('run') && !calls[0].includes('build'))
  assert.equal(readFileSync(join(f.dir, '.env'), 'utf8'), before)
})

test('stop/status/logs remain usable with missing model credentials and do not rewrite configuration', () => {
  const f = fixture(), path = join(f.dir, '.env')
  const before = readFileSync(join(f.dir, '.env.example'), 'utf8')
  writeFileSync(path, before)
  for (const action of ['stop', 'status', 'logs']) {
    const result = f.run([action])
    assert.equal(result.status, 0, result.stderr)
    assert.equal(readFileSync(path, 'utf8'), before)
  }
  const calls = f.calls()
  assert.equal(calls.length, 3)
  assert.ok(calls.every(call => !call.includes('run') && !call.includes('build') && !call.includes('down')))
})

test('daily start requires prior configuration and cannot silently become an installation', () => {
  const f = fixture({ configured: false })
  const result = f.run(['start'])
  assert.notEqual(result.status, 0)
  assert.ok(!existsSync(join(f.dir, '.env')))
  assert.deepEqual(f.calls(), [])
})

test('daily startup failure returns the Docker exit code without claiming success', () => {
  const f = fixture({ mode: 'start-failure' })
  const result = f.run(['start'])
  assert.equal(result.status, 43, result.stderr)
  assert.ok(!result.stdout.includes('工作台已启动'))
  assert.equal(f.calls().length, 1)
})
