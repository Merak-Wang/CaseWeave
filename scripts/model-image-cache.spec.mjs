import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, stat, utimes, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

const inputs = ['config/model-service/Dockerfile', 'config/model-service/Dockerfile.dockerignore',
  'pyproject.toml', 'uv.lock', 'python/evals/pyproject.toml', 'python/model-service/pyproject.toml',
  'python/model-service/README.md', 'python/semantic-operators/pyproject.toml',
  'architecture/model-manifest.json', 'config/query-domain-lexicon.json', 'python/model-service/src/service.py']
async function fixture() {
  await mkdir(resolve('.cache/startup-tests'), { recursive: true })
  const root = await mkdtemp(join(resolve('.cache/startup-tests'), 'model-inputs-'))
  for (const input of inputs) {
    await mkdir(dirname(join(root, input)), { recursive: true })
    await writeFile(join(root, input), `fixture ${input}\n`)
  }
  return root // 保留测试夹具，不执行永久删除。
}
function run(root, code, environment = {}) {
  return execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
    "$ErrorActionPreference = 'Stop'; . $env:CASEWEAVE_IMAGE_CACHE_SCRIPT; " + code], { encoding: 'utf8', env: { ...process.env,
      CASEWEAVE_IMAGE_CACHE_SCRIPT: resolve('scripts/model-image-cache.ps1'), CASEWEAVE_IMAGE_TEST_ROOT: root, ...environment } }).trim()
}
const fingerprint = (root, uv = '') => run(root, 'Get-ModelBuildFingerprint $env:CASEWEAVE_IMAGE_TEST_ROOT $env:CASEWEAVE_TEST_UV', { CASEWEAVE_TEST_UV: uv })
async function change(root, path) { await writeFile(join(root, path), 'changed fixture\n') }

test('unchanged model inputs produce a stable SHA256 fingerprint', async () => {
  const root = await fixture(), hash = fingerprint(root)
  assert.match(hash, /^[a-f0-9]{64}$/u)
  assert.equal(fingerprint(root), hash)
})
test('workbench sources, semantic operator code and documentation do not rebuild the model', async () => {
  const root = await fixture(), hash = fingerprint(root)
  for (const file of ['packages/product-host/src/app.ts', 'python/semantic-operators/src/filter.py', 'docs/README.md']) {
    await mkdir(dirname(join(root, file)), { recursive: true }); await change(root, file)
  }
  assert.equal(fingerprint(root), hash)
})
test('model source bytes invalidate the image even with unchanged file timestamp', async () => {
  const root = await fixture(), hash = fingerprint(root), file = join(root, 'python/model-service/src/service.py'), before = await stat(file)
  await change(root, 'python/model-service/src/service.py'); await utimes(file, before.atime, before.mtime)
  assert.notEqual(fingerprint(root), hash)
})
test('new model source files invalidate the image while Python cache does not', async () => {
  const root = await fixture(), hash = fingerprint(root)
  await mkdir(join(root, 'python/model-service/src/__pycache__'), { recursive: true })
  await writeFile(join(root, 'python/model-service/src/__pycache__/service.pyc'), 'ignored bytecode')
  assert.equal(fingerprint(root), hash)
  await writeFile(join(root, 'python/model-service/src/another.py'), 'new model code')
  assert.notEqual(fingerprint(root), hash)
})
test('model dependency lock changes invalidate the image', async () => {
  const root = await fixture(), hash = fingerprint(root)
  await change(root, 'uv.lock'); assert.notEqual(fingerprint(root), hash)
})
test('model manifest and query lexicon changes invalidate the image', async () => {
  const root = await fixture(), hash = fingerprint(root)
  await change(root, 'architecture/model-manifest.json'); const changed = fingerprint(root)
  assert.notEqual(changed, hash)
  await change(root, 'config/query-domain-lexicon.json'); assert.notEqual(fingerprint(root), changed)
})
test('Docker recipe and effective UV image changes invalidate the image', async () => {
  const root = await fixture(), hash = fingerprint(root)
  assert.notEqual(fingerprint(root, 'uv:another-pinned-image'), hash)
  await change(root, 'config/model-service/Dockerfile'); assert.notEqual(fingerprint(root), hash)
})
test('only an existing image with the matching input label skips model build', async () => {
  const root = await fixture()
  const mock = 'function docker { $global:LASTEXITCODE = [int]$env:CASEWEAVE_TEST_DOCKER_EXIT; $env:CASEWEAVE_TEST_LABEL }; Test-ModelImageCurrent fixture-image expected-hash'
  assert.equal(run(root, mock, { CASEWEAVE_TEST_DOCKER_EXIT: '0', CASEWEAVE_TEST_LABEL: '{"org.caseweave.model-inputs":"expected-hash"}' }), 'True')
  assert.equal(run(root, mock, { CASEWEAVE_TEST_DOCKER_EXIT: '0', CASEWEAVE_TEST_LABEL: '{"org.caseweave.model-inputs":"stale-hash"}' }), 'False')
  assert.equal(run(root, mock, { CASEWEAVE_TEST_DOCKER_EXIT: '1', CASEWEAVE_TEST_LABEL: '' }), 'False')
  const setup = await readFile(resolve('setup.ps1'), 'utf8')
  assert.ok(setup.includes("Step '构建应用更新（算子随应用部署）' @('build', 'app')"))
  assert.ok(setup.includes('CASEWEAVE_MODEL_INPUT_HASH=$modelInputs'))
})
