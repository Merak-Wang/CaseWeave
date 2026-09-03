import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const contract = JSON.parse(await readFile(join(root, 'architecture', 'workspace.json'), 'utf8'))
const fallbackPnpmCli = process.platform === 'win32' && process.env.APPDATA !== undefined
  ? join(process.env.APPDATA, 'npm', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
  : undefined
const pnpmCli = process.env.npm_execpath?.endsWith('.cjs') === true
  ? process.env.npm_execpath
  : fallbackPnpmCli !== undefined && existsSync(fallbackPnpmCli) ? fallbackPnpmCli : undefined
const packageManager = pnpmCli !== undefined
  ? { command: process.execPath, prefix: [pnpmCli] }
  : { command: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', prefix: [] }
const pinnedDshVersion = '0.1.1-rc.2'
const tempRoot = mkdtempSync(join(tmpdir(), 'retrieval-agent-clean-install-'))
const browserReview = process.env.RETRIEVAL_AGENT_BROWSER_REVIEW === '1'

async function seedBrowserReviewModelSettings(home) {
  if (!browserReview) return
  const provider = process.env.RETRIEVAL_AGENT_BROWSER_LLM_PROVIDER?.trim()
  const model = process.env.RETRIEVAL_AGENT_BROWSER_LLM_MODEL?.trim()
  const baseURL = process.env.RETRIEVAL_AGENT_BROWSER_LLM_BASE_URL?.trim()
  const apiKeyEnv = process.env.RETRIEVAL_AGENT_BROWSER_LLM_API_KEY_ENV?.trim()
  if ([provider, model, baseURL, apiKeyEnv].every(value => value === undefined)) return
  if (provider === undefined || model === undefined || baseURL === undefined || apiKeyEnv === undefined
    || provider.length === 0 || model.length === 0 || baseURL.length === 0 || apiKeyEnv.length === 0) {
    throw new Error('browser model review requires provider, model, base URL, and API-key environment name together')
  }
  const settings = {
    'agent-default-model': {
      provider,
      model,
      reasoningEffort: process.env.RETRIEVAL_AGENT_BROWSER_LLM_REASONING?.trim() || 'off',
    },
    'llm-pi-ai': {
      providers: {
        [provider]: {
          displayName: process.env.RETRIEVAL_AGENT_BROWSER_LLM_DISPLAY_NAME?.trim() || provider,
          apiKeyEnv,
          baseURL,
          models: [{ id: model }],
        },
      },
    },
    'ui-onboarding': { welcomeNoticeVersion: '2026-08-13.1' },
  }
  // JSON is a YAML 1.2 subset and avoids adding a verification-only parser.
  await writeFile(join(home, 'settings.yaml'), `${JSON.stringify(settings, undefined, 2)}\n`, 'utf8')
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  })
}

function pnpm(args, cwd) {
  return run(packageManager.command, [...packageManager.prefix, ...args], { cwd })
}

function fileSpec(path) {
  return pathToFileURL(path).href
}

async function verifyWebStartup(dshBin, home, cwd) {
  const port = await new Promise((resolvePromise, rejectPromise) => {
    const server = createServer()
    server.once('error', rejectPromise)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        rejectPromise(new Error('cannot allocate a local verification port'))
        return
      }
      server.close(error => error === undefined ? resolvePromise(address.port) : rejectPromise(error))
    })
  })
  await new Promise((resolvePromise, rejectPromise) => {
    let ready = false
    let routeVerified = false
    let routeError
    let stdout = ''
    let stderr = ''
    const child = spawn(process.execPath, [dshBin, '--profile', 'retrieval-agent', '--no-open', '--port', String(port)], {
      cwd,
      env: { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stopChild = () => { child.kill('SIGTERM') }
    process.once('SIGINT', stopChild)
    process.once('SIGTERM', stopChild)
    let stopFromInput
    if (browserReview && process.stdin.isTTY) {
      stopFromInput = chunk => {
        if (chunk.includes('\n') || chunk.includes('\r')) stopChild()
      }
      process.stdin.setEncoding('utf8')
      process.stdin.resume()
      process.stdin.on('data', stopFromInput)
    }
    const removeSignalHandlers = () => {
      process.off('SIGINT', stopChild)
      process.off('SIGTERM', stopChild)
      if (stopFromInput !== undefined) {
        process.stdin.off('data', stopFromInput)
        process.stdin.pause()
      }
    }
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      rejectPromise(new Error(`clean DSH Web startup timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    }, 30_000)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      stdout += chunk
      if (!ready && stdout.includes(`http://127.0.0.1:${port}`)) {
        ready = true
        void fetch(`http://127.0.0.1:${port}/api/retrieval-agent/export`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` },
          body: JSON.stringify({ sessionId: 'missing-session', retrievalId: 'missing-retrieval', candidateRefs: [] }),
        }).then(async response => {
          const body = await response.text()
          if (response.status !== 409 || !body.includes('SESSION_NOT_ACTIVE')) {
            throw new Error(`Product Host route returned ${response.status}: ${body}`)
          }
          routeVerified = true
          if (browserReview) {
            clearTimeout(timer)
            console.log(`BROWSER_REVIEW_URL=http://127.0.0.1:${port}`)
            if (process.stdin.isTTY) console.log('Press Enter to stop the app and remove the isolated profile.')
          } else {
            child.kill('SIGTERM')
          }
        }).catch(error => {
          routeError = error
          child.kill('SIGTERM')
        })
      }
    })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', error => {
      clearTimeout(timer)
      removeSignalHandlers()
      rejectPromise(error)
    })
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      removeSignalHandlers()
      if (routeError !== undefined) rejectPromise(routeError)
      else if (ready && routeVerified) resolvePromise(undefined)
      else rejectPromise(new Error(`clean DSH Web exited before readiness (code=${String(code)}, signal=${String(signal)})\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    })
  })
}

try {
  const packs = join(tempRoot, 'packs')
  const runner = join(tempRoot, 'runner')
  const home = join(tempRoot, 'dsh-home')
  const profile = join(home, 'profiles', 'retrieval-agent')
  await mkdir(packs, { recursive: true })
  await mkdir(runner, { recursive: true })
  await mkdir(profile, { recursive: true })

  const tarballs = new Map()
  for (const entry of contract.packages) {
    const reportText = pnpm(['--filter', entry.name, 'pack', '--json', '--pack-destination', packs], root)
    const report = JSON.parse(reportText.slice(reportText.indexOf('{')))
    tarballs.set(entry.name, resolve(report.filename))
  }

  await writeFile(join(runner, 'package.json'), JSON.stringify({
    name: 'retrieval-agent-clean-dsh-runner',
    private: true,
    packageManager: 'pnpm@10.28.2',
    dependencies: { '@deepseek-ai/dsh': pinnedDshVersion },
  }, undefined, 2), 'utf8')
  pnpm(['install', '--ignore-scripts', '--frozen-lockfile=false'], runner)

  const firstPartyDependencies = Object.fromEntries(
    [...tarballs].map(([name, archive]) => [name, fileSpec(archive)]),
  )
  await writeFile(join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-retrieval-agent-clean-install',
    private: true,
    packageManager: 'pnpm@10.28.2',
    dependencies: firstPartyDependencies,
    pnpm: { overrides: firstPartyDependencies },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@retrieval-agent/bundle'] } },
  }, undefined, 2), 'utf8')
  await writeFile(join(profile, 'cordis.patch.yml'), '[]\n', 'utf8')
  pnpm(['install', '--ignore-scripts', '--frozen-lockfile=false'], profile)

  const installer = join(profile, 'node_modules', '@retrieval-agent', 'bundle', 'lib', 'install-cli.js')
  const uninstaller = join(profile, 'node_modules', '@retrieval-agent', 'bundle', 'lib', 'uninstall-cli.js')
  run(process.execPath, [installer, '--home', home, '--data-root', join(root, 'data')], { cwd: profile })
  await seedBrowserReviewModelSettings(home)

  const dshBin = join(runner, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const version = run(process.execPath, [dshBin, '--version'], { cwd: root }).trim()
  if (version !== pinnedDshVersion) throw new Error(`unexpected clean DSH version ${version}`)
  const config = run(process.execPath, [dshBin, '--profile', 'retrieval-agent', '--dump-config'], {
    cwd: root,
    env: { ...process.env, DSH_HOME: home },
  })
  if (!config.includes('@retrieval-agent/ui-ticket-results')) throw new Error('composed DSH config is missing the candidate UI row')
  if (!config.includes('@retrieval-agent/ui-product-shell')) throw new Error('composed DSH config is missing the product shell UI row')
  if (!config.includes('@retrieval-agent/product-host')) throw new Error('composed DSH config is missing the Product Host row')
  if (!/id:\s*permission[\s\S]*?defaultPreset:\s*['"]?read-only['"]?/u.test(config)) {
    throw new Error('composed DSH config is missing the read-only default permission preset')
  }
  if (!/default:\s*['"]?retrieval-agent['"]?/u.test(config)) {
    const relevant = config.split(/\r?\n/u).filter(line => /agent-presets|retrieval-agent/u.test(line)).join('\n')
    throw new Error(`composed DSH config is missing the retrieval-agent default preset; relevant lines:\n${relevant}`)
  }

  const probe = join(profile, 'artifact-probe.mjs')
  await writeFile(probe, `
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createServer as createHttpServer } from 'node:http'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { RetrievalId } from '@retrieval-agent/contracts'
import { foldRetrievalEvents, RetrievalController } from '@retrieval-agent/domain'
import { RetrievalAgentService, SessionRetrievalEventJournal } from '@retrieval-agent/agent-plugin'
import { installDshSessionCompatibility } from '@retrieval-agent/dsh-compat'
import { MODEL_SERVICE_PROTOCOL_VERSION, ModelServiceClient } from '@retrieval-agent/model-service-client'
import { LocalTicketProvider, parseTicketDatasetJsonl } from '@retrieval-agent/provider-local'
import { HybridRankingEngine } from '@retrieval-agent/retrieval-ranking'
import { FixturePrincipalProviderService, LocalTicketProviderService } from '@retrieval-agent/bundle'

installDshSessionCompatibility()
const session = Session.create(SessionId('clean-install-session'))
if (session.id !== 'clean-install-session') throw new Error('DSH Session package did not load')
const now = new Date('2026-08-27T04:00:00.000Z')
const principal = {
  tenantId: 'demo', subjectId: 'development-admin', entitlementVersion: 'development-admin-v1',
  purpose: 'ticket_retrieval', attributes: { group: ['admin'], region: ['cn'], role: ['administrator'], environment: ['development'] },
  issuedAt: '2026-08-27T00:00:00.000Z', expiresAt: '2026-08-28T00:00:00.000Z',
}
const installedDataPath = join(process.env.DSH_HOME, 'retrieval-agent', 'data', 'default.jsonl')
const records = parseTicketDatasetJsonl(await readFile(installedDataPath, 'utf8'))
if (records.length !== 19587) throw new Error('installed ESFT development corpus is incomplete')
if (records.some(record => record.rawSource?.datasetId !== 'deepseek-ai/ESFT')) {
  throw new Error('installed corpus contains a non-ESFT source')
}

const dimensions = 32
function fakeEmbedding(text) {
  const vector = Array.from({ length: dimensions }, () => 0)
  for (const character of text.normalize('NFKC').toLocaleLowerCase()) {
    const point = character.codePointAt(0)
    if (point !== undefined && !/\s/u.test(character)) vector[point % dimensions] += 1
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
  return norm === 0 ? [1, ...Array.from({ length: dimensions - 1 }, () => 0)] : vector.map(value => value / norm)
}
function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']'
  if (typeof value === 'object' && value !== null) {
    return '{' + Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => JSON.stringify(key) + ':' + stable(item)).join(',') + '}'
  }
  return JSON.stringify(value)
}
function rankingProfileVersion(profile) {
  const identity = {
    version: 'quick-hybrid-v1', embeddingIdentity: profile.embeddingIdentity ?? null,
    rerankerIdentity: profile.rerankerIdentity ?? null, embeddingInstruction: profile.embeddingInstruction,
    rerankerInstruction: profile.rerankerInstruction, embeddingBatchSize: profile.embeddingBatchSize,
    minimumDenseScore: profile.minimumDenseScore, denseTopK: profile.denseTopK,
    fusion: profile.fusion, bm25f: profile.bm25f,
    rerankerEnabled: profile.rerankerEnabled, rerankTopN: profile.rerankTopN,
  }
  return 'quick-hybrid-v1:' + createHash('sha256').update(stable(identity)).digest('hex').slice(0, 16)
}
async function requestBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
const modelServer = createHttpServer(async (request, response) => {
  const send = (status, value) => {
    const data = JSON.stringify(value)
    response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) })
    response.end(data)
  }
  if (request.method === 'GET' && request.url === '/health/ready') {
    send(200, {
      protocolVersion: MODEL_SERVICE_PROTOCOL_VERSION, serviceVersion: 'clean-install-fake-v1', ready: true, device: 'test',
      models: [{
        model: 'clean-install-embedding', revision: 'clean-install-revision-v1', kind: 'embedding', loaded: true,
        dtype: 'float32', device: 'test', maxTokens: 12000, dimensions, pooling: 'last_token', normalization: 'l2',
      }],
      limits: { maxBatchSize: 128, maxTotalTokens: 100000, maxRerankCandidates: 20 },
      rag: { protocolVersion: 'retrieval-agent.rag.v1', ranking: true, policy: true },
    })
    return
  }
  if (request.method === 'POST' && request.url === '/v1/embeddings') {
    const body = await requestBody(request)
    send(200, {
      protocolVersion: MODEL_SERVICE_PROTOCOL_VERSION, requestId: body.requestId,
      model: 'clean-install-embedding', revision: 'clean-install-revision-v1', dimensions, normalization: 'l2',
      data: body.input.map((text, index) => ({ index, embedding: fakeEmbedding(text) })), elapsedMs: 0,
    })
    return
  }
  if (request.method === 'POST' && request.url === '/v1/ranking/prepare') {
    const body = await requestBody(request)
    const identity = body.profile.embeddingIdentity
    send(200, {
      protocolVersion: 'retrieval-agent.rag.v1', requestId: body.requestId,
      documentCount: body.documents.length, model: identity.model, revision: identity.revision,
      dimensions: identity.dimensions, elapsedMs: 0, profileVersion: rankingProfileVersion(body.profile),
    })
    return
  }
  if (request.method === 'POST' && request.url === '/v1/ranking/rank') {
    const body = await requestBody(request)
    const queryVector = fakeEmbedding(body.query.semanticText ?? body.query.text)
    const ranked = body.documents.map(document => {
      const documentVector = fakeEmbedding([document.title, document.summary, document.body, document.metadata].join(' '))
      return { documentId: document.id, score: documentVector.reduce((sum, value, index) => sum + value * queryVector[index], 0) }
    }).sort((left, right) => right.score - left.score || left.documentId.localeCompare(right.documentId))
    const dense = ranked
      .filter(item => item.score >= body.profile.minimumDenseScore)
      .slice(0, body.profile.denseTopK)
    const denseHits = dense.map((item, index) => ({
      documentId: item.documentId, rank: index + 1, score: item.score,
      channels: [{ channel: 'vector', rank: index + 1, score: item.score }],
    }))
    const keywordQuery = body.query.keywordQuery
    const keywordEligible = keywordQuery === undefined ? [] : body.documents.filter(document => {
      const searchable = [document.title, document.summary, document.body, document.metadata]
        .join('\\n').normalize('NFKC').toLowerCase()
      const matches = keywordQuery.terms.map(term => searchable.includes(term.normalize('NFKC').trim().toLowerCase()))
      return keywordQuery.operator === 'and' ? matches.every(Boolean) : matches.some(Boolean)
    }).sort((left, right) => left.id.localeCompare(right.id))
    const keywordHits = keywordEligible.map((document, index) => ({
      documentId: document.id, rank: index + 1, score: 1,
      channels: [{ channel: 'keyword', rank: index + 1, score: 1 }],
    }))
    const hybridUsesKeyword = body.query.mode === 'hybrid' && keywordHits.length > 0
    const fused = new Map()
    if (hybridUsesKeyword) {
      for (const [channel, channelHits, weight] of [
        ['keyword', keywordHits, body.profile.fusion.keywordWeight],
        ['vector', denseHits, body.profile.fusion.vectorWeight],
      ]) {
        for (const hit of channelHits) {
          const row = fused.get(hit.documentId) ?? { documentId: hit.documentId, score: 0, channels: [] }
          row.score += weight / (body.profile.fusion.rankConstant + hit.rank)
          row.channels.push({ channel, rank: hit.rank, score: hit.score })
          fused.set(hit.documentId, row)
        }
      }
    }
    const hits = body.query.mode === 'keyword' ? keywordHits
      : body.query.mode === 'dense' || !hybridUsesKeyword ? denseHits
        : [...fused.values()].sort((left, right) => right.score - left.score || left.documentId.localeCompare(right.documentId))
          .map((hit, index) => ({ ...hit, rank: index + 1 }))
    const executedMode = body.query.mode === 'hybrid' && !hybridUsesKeyword ? 'dense' : body.query.mode
    const channels = [
      ...(body.query.mode === 'dense' || keywordQuery === undefined ? [] : [{
        channel: 'keyword', implementation: 'clean-install-keyword', version: 'v1',
        resultCount: keywordHits.length, elapsedMs: 0,
      }]),
      ...(body.query.mode === 'keyword' ? [] : [{
        channel: 'vector', implementation: 'clean-install-dense', version: 'v1',
        resultCount: denseHits.length, elapsedMs: 0,
      }]),
    ]
    send(200, {
      protocolVersion: 'retrieval-agent.rag.v1', requestId: body.requestId,
      result: {
        hits,
        execution: {
          requestedMode: body.query.mode, executedMode,
          strategyVersion: rankingProfileVersion(body.profile),
          channels,
          ...(hybridUsesKeyword ? { fusion: { method: 'weighted_rrf', version: 'clean-install-rrf-v1', ...body.profile.fusion } } : {}),
        },
        scanned: body.documents.length, keywordEligible: keywordEligible.length, rankedHits: hits.length,
        warnings: body.query.mode !== 'hybrid' || hybridUsesKeyword ? []
          : [keywordQuery === undefined ? 'keyword_unavailable_dense_only' : 'keyword_no_hits_dense_only'],
      },
      elapsedMs: 0,
    })
    return
  }
  if (request.method === 'POST' && request.url === '/v1/policy/candidate-ranking') {
    const body = await requestBody(request)
    const input = body.input
    const history = [...new Map([...input.previousHistory, ...input.page].map(candidate => [candidate.ref, candidate])).values()]
    const nextObservation = {
      searchEventId: input.searchEventId, stage: input.stage, queryFingerprint: input.queryFingerprint,
      ranking: input.page.map(candidate => ({ ref: candidate.ref, rank: candidate.rank })),
    }
    const observations = [...input.previousObservations, nextObservation]
    const scores = new Map()
    for (const observation of observations) {
      const weight = observation.stage === 'repair_search' ? 1.25 : 1
      for (const row of observation.ranking) scores.set(row.ref, (scores.get(row.ref) ?? 0) + weight / (60 + row.rank))
    }
    const excluded = new Set(input.excludedRefs)
    const firstSeen = new Map(history.map((candidate, index) => [candidate.ref, index]))
    const active = history.filter(candidate => !excluded.has(candidate.ref))
      .sort((left, right) => (scores.get(right.ref) ?? 0) - (scores.get(left.ref) ?? 0)
        || firstSeen.get(left.ref) - firstSeen.get(right.ref))
      .map((candidate, index) => ({ ...candidate, rank: index + 1 }))
    send(200, {
      protocolVersion: 'retrieval-agent.rag.v1', requestId: body.requestId,
      result: { version: 'candidate-ranking-v1', history, observations, active }, elapsedMs: 0,
    })
    return
  }
  send(404, { error: { code: 'NOT_FOUND', message: 'not found', retryable: false } })
})
await new Promise((resolvePromise, rejectPromise) => {
  modelServer.once('error', rejectPromise)
  modelServer.listen(0, '127.0.0.1', resolvePromise)
})
const modelAddress = modelServer.address()
if (modelAddress === null || typeof modelAddress === 'string') throw new Error('fake model server has no TCP address')
const modelServiceBaseUrl = 'http://127.0.0.1:' + modelAddress.port

try {

const serviceCtx = new Context()
try {
  await serviceCtx.plugin(FixturePrincipalProviderService, {
    tenantId: 'demo', subjectId: 'development-admin', entitlementVersion: 'development-admin-v1',
    groups: ['admin'], regions: ['cn'], developmentAdmin: true,
  })
  await serviceCtx.plugin(LocalTicketProviderService, {
    dataPath: installedDataPath,
    providerId: 'clean-install-cordis-v1',
    modelServiceBaseUrl,
    embeddingModel: 'clean-install-embedding',
    embeddingRevision: 'clean-install-revision-v1',
    embeddingDimensions: dimensions,
  })
  await serviceCtx.plugin(RetrievalAgentService, { retrievalPolicyBaseUrl: modelServiceBaseUrl })
  const serviceAgent = { session: Session.create(SessionId('clean-install-cordis-agent')) }
  const serviceState = await serviceCtx.retrievalAgent.start(serviceAgent, {
    target: 'ranked_cases', query: '主副卡解绑后仍共享流量', requestedCount: 5, countPolicy: 'explicit',
  })
  if (serviceState.candidates.length === 0
    || serviceState.candidates.some(candidate => !candidate.displayId.startsWith('ESFT-SUMMARY-TRAIN-'))) {
    throw new Error('packed Cordis service path did not return ESFT development candidates')
  }
} finally {
  await serviceCtx.fiber.dispose()
}

const gateway = new ModelServiceClient({
  baseUrl: modelServiceBaseUrl,
  embeddingModel: 'clean-install-embedding', embeddingRevision: 'clean-install-revision-v1', embeddingDimensions: dimensions,
})
const provider = new LocalTicketProvider(records, {
  now: () => now,
  ranker: new HybridRankingEngine({
    baseUrl: modelServiceBaseUrl,
    embeddingIdentity: { model: 'clean-install-embedding', revision: 'clean-install-revision-v1', dimensions },
    minimumDenseScore: -1,
  }),
})
let serial = 0
const nextId = () => 'clean-' + serial++
const journal = new SessionRetrievalEventJournal(session, { now: () => now, eventId: nextId })
const controller = new RetrievalController(provider, journal, undefined, {
  now: () => now, id: nextId, retrievalPolicyBaseUrl: modelServiceBaseUrl,
})
const state = await controller.start(principal, { target: 'ranked_cases', query: '主副卡解绑后仍共享流量' })
if (state.candidates.length === 0
  || state.candidates.some(candidate => !candidate.displayId.startsWith('ESFT-SUMMARY-TRAIN-'))) {
  throw new Error('packed vertical slice did not return ESFT development candidates')
}
if (journal.read(RetrievalId(state.retrievalId)).length === 0) throw new Error('packed event journal is empty')
const replayedSession = Session.create(SessionId('clean-install-replayed'), session.events)
const replayedEvents = new SessionRetrievalEventJournal(replayedSession).read(RetrievalId(state.retrievalId))
const replayedState = foldRetrievalEvents(replayedEvents)
if (replayedState === undefined || JSON.stringify(replayedState) !== JSON.stringify(state)) {
  throw new Error('packed DSH Session replay did not reconstruct the same retrieval state')
}
} finally {
  await new Promise(resolvePromise => modelServer.close(resolvePromise))
}
`, 'utf8')
  run(process.execPath, [probe], { cwd: profile, env: { ...process.env, DSH_HOME: home } })

  const installedPreset = await readFile(join(home, '.agent-presets', 'retrieval-agent', 'agent.cordis.yml'), 'utf8')
  if (!installedPreset.includes('@retrieval-agent/bundle/agent')) throw new Error('installed preset is incomplete')
  const installedCorpus = JSON.parse(await readFile(join(home, 'retrieval-agent', 'data', 'manifest.json'), 'utf8'))
  if (
    installedCorpus.ticketProfiles[installedCorpus.defaultTicketProfile].recordCount !== 19587
    || installedCorpus.sourcePolicy.authoritativeSource !== 'deepseek-ai/ESFT'
    || installedCorpus.sourcePolicy.fallbackSources.length !== 0
  ) {
    throw new Error('installed ESFT-only development corpus is incomplete')
  }

  await verifyWebStartup(dshBin, home, root)

  const packageNames = contract.packages.map(entry => entry.name)
  run(process.execPath, [uninstaller, '--home', home], { cwd: profile })
  if (existsSync(join(home, '.agent-presets', 'retrieval-agent'))) throw new Error('preset assets remained after uninstall')
  if (existsSync(join(home, 'retrieval-agent'))) throw new Error('fixture assets remained after uninstall')
  run(process.execPath, [dshBin, 'plugin', '--profile', 'retrieval-agent', 'remove', ...packageNames], {
    cwd: root,
    env: { ...process.env, DSH_HOME: home },
  })
  const afterRemove = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
  if (afterRemove.dsh.profile.bundles.includes('@retrieval-agent/bundle')) throw new Error('bundle remained active after plugin removal')

  console.log(`clean install verified against published @deepseek-ai/dsh ${pinnedDshVersion}: pack, install, compose, Web startup, Host route, 19,587-record ESFT corpus search, Session replay, assets, remove`)
} finally {
  const resolvedTemp = resolve(tempRoot)
  const resolvedOsTemp = resolve(tmpdir())
  if (resolvedTemp.startsWith(`${resolvedOsTemp}${sep}`) && basename(resolvedTemp).startsWith('retrieval-agent-clean-install-')) {
    await rm(resolvedTemp, { recursive: true, force: true })
  } else {
    throw new Error(`refusing to clean unexpected temporary directory ${resolvedTemp}; relative=${relative(resolvedOsTemp, resolvedTemp)}`)
  }
}
