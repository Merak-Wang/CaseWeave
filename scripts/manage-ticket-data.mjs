import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { access, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dataRoot = join(root, 'data')
const rawRoot = join(dataRoot, 'raw', 'deepseek-esft')
const ticketRoot = join(dataRoot, 'tickets')
const evalRoot = join(dataRoot, 'evals')

const SOURCE_COMMIT = '3746ca74410c92163cc521571dbd17579bfdc962'
const TRANSFORMATION_VERSION = 'retrieval-agent.esft-summary.v1'
const SOURCE_DATASET = 'deepseek-ai/ESFT'
const SOURCE_LICENSE_REVIEW = 'dataset-specific-license-not-identified'
const REDACTION_TOKEN = '[已脱敏]'
const PUBLIC_SERVICE_NUMBERS = new Set(['10000', '10001', '10010', '10011', '10016', '10085', '10086', '10099', '12300', '12315', '12321', '12345', '12381', '96110'])

const sourceFiles = Object.freeze({
  train: Object.freeze({
    path: join(rawRoot, 'summary-train.jsonl'),
    url: `https://raw.githubusercontent.com/deepseek-ai/ESFT/${SOURCE_COMMIT}/datasets/train/summary.jsonl`,
    size: 62_785_585,
    sha256: '313fe43f7d96fa79ea3828f4df3d4a7af28caa4e8360842f885107d57f21f92e',
  }),
  eval: Object.freeze({
    path: join(rawRoot, 'summary-eval.jsonl'),
    url: `https://raw.githubusercontent.com/deepseek-ai/ESFT/${SOURCE_COMMIT}/datasets/eval/summary.jsonl`,
    size: 664_823,
    sha256: 'c03812f89e9154c8395b85aadb858b573319088b44ef1083c789981bb4ffd7bb',
  }),
})

const outputFiles = Object.freeze({
  train: join(ticketRoot, 'esft', 'summary-train.jsonl'),
  eval: join(evalRoot, 'esft-summary-v1', 'tickets.jsonl'),
})

const categoryRules = Object.freeze([
  ['销户与停复机', /销户|注销|停机|复机|拆机/u, ['销户', '停复机']],
  ['宽带业务', /宽带|光猫|路由器|装机|移机|网线/u, ['宽带']],
  ['流量与上网', /流量|上网|数据业务|4G|5G|热点/u, ['流量']],
  ['套餐与合约', /套餐|合约|资费|保底消费|最低消费/u, ['套餐']],
  ['费用与账单', /话费|费用|扣费|账单|退费|返费|缴费|充值|欠费/u, ['计费']],
  ['主副卡业务', /副卡|主卡|亲情卡|共享卡/u, ['主副卡']],
  ['网络与信号', /信号|无服务|网络故障|无法上网|断网|掉线/u, ['网络']],
  ['号码与安全', /骚扰|诈骗|短信|验证码|服务密码|补卡|号码/u, ['号码安全']],
  ['渠道与应用', /APP|App|app|客户端|营业厅|登录/u, ['电子渠道']],
  ['投诉与服务', /投诉|工信部|服务态度|升级处理|不认可/u, ['投诉']],
])

function sha256Text(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

async function sha256File(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function fetchWithRetry(url, options, attempts = 6) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, options)
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)
      return response
    } catch (error) {
      lastError = error
      if (attempt < attempts) await new Promise(resolveWait => setTimeout(resolveWait, attempt * 750))
    }
  }
  throw lastError
}

async function downloadSource(name, source, concurrency = 12) {
  await mkdir(dirname(source.path), { recursive: true })
  if (await exists(source.path)) {
    const current = await stat(source.path)
    if (current.size === source.size && await sha256File(source.path) === source.sha256) {
      return { name, status: 'reused', ...source }
    }
  }

  const partPath = `${source.path}.part`
  const handle = await open(partPath, 'w')
  const chunkSize = 1024 * 1024
  const chunkCount = Math.ceil(source.size / chunkSize)
  let nextChunk = 0
  try {
    await handle.truncate(source.size)
    async function worker() {
      while (true) {
        const chunkIndex = nextChunk
        nextChunk += 1
        if (chunkIndex >= chunkCount) return
        const start = chunkIndex * chunkSize
        const end = Math.min(source.size - 1, start + chunkSize - 1)
        const response = await fetchWithRetry(source.url, { headers: { Range: `bytes=${start}-${end}` } })
        if (response.status !== 206) throw new Error(`${name} source ignored range ${start}-${end}`)
        const bytes = new Uint8Array(await response.arrayBuffer())
        if (bytes.byteLength !== end - start + 1) {
          throw new Error(`${name} range ${start}-${end} returned ${bytes.byteLength} bytes`)
        }
        await handle.write(bytes, 0, bytes.byteLength, start)
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, chunkCount) }, () => worker()))
    await handle.sync()
  } finally {
    await handle.close()
  }
  const digest = await sha256File(partPath)
  if (digest !== source.sha256) throw new Error(`${name} source SHA-256 mismatch: ${digest}`)
  if (await exists(source.path)) {
    const invalidPath = `${source.path}.invalid-${Date.now()}`
    await rename(source.path, invalidPath)
  }
  await rename(partPath, source.path)
  return { name, status: 'downloaded', ...source }
}

function replacePattern(state, pattern, kind, replacement = REDACTION_TOKEN) {
  state.text = state.text.replace(pattern, (...args) => {
    state.counts[kind] = (state.counts[kind] ?? 0) + 1
    return typeof replacement === 'function' ? replacement(...args) : replacement
  })
}

function redactText(value) {
  const state = { text: String(value).normalize('NFKC'), counts: {} }
  replacePattern(state, /\*{3,}/gu, 'existing_mask')
  replacePattern(state, /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, 'email')
  replacePattern(state, /(?<!\d)\d{17}[\dXx](?!\d)/gu, 'national_id')
  replacePattern(state, /(?<!\d)1[3-9]\d{9}(?!\d)/gu, 'mobile_phone')
  replacePattern(state, /(?<!\d)(?:\d[ -]?){12,19}(?!\d)/gu, 'bank_or_long_number')
  replacePattern(state, /((?:服务密码|密码|身份证(?:号|号码)?|银行卡(?:号|号码)?|联系电话|手机号)[：:\s]*(?:是|为)?[：:\s]*)\d{4,11}/gu, 'context_number', (_match, prefix) => `${prefix}${REDACTION_TOKEN}`)
  replacePattern(state, /((?:工单|投诉|订单)(?:编号|号)?[：:\s]*(?:是|为)?[：:\s]*)[A-Za-z0-9_-]{5,}/gu, 'case_identifier', (_match, prefix) => `${prefix}${REDACTION_TOKEN}`)
  state.text = state.text.replace(/(?<![\d.])\d{5,}(?![\d.])/gu, match => {
    if (PUBLIC_SERVICE_NUMBERS.has(match)) return match
    state.counts.long_number = (state.counts.long_number ?? 0) + 1
    return REDACTION_TOKEN
  })
  replacePattern(state, /((?:我叫|姓名(?:是|为|[：:])|联系人(?:是|为|[：:]))\s*)\p{Script=Han}{2,4}(?=[，。；！？\s])/gu, 'person_name', (_match, prefix) => `${prefix}${REDACTION_TOKEN}`)
  replacePattern(state, /((?:住址|家庭地址|联系地址)[：:\s]*(?:是|为)?[：:\s]*)[^，。；！？\n]{4,80}/gu, 'address', (_match, prefix) => `${prefix}${REDACTION_TOKEN}`)
  state.text = state.text.replace(/[ \t]+/gu, ' ').replace(/ *\n */gu, '\n').trim()
  return state
}

function mergeCounts(target, counts) {
  for (const [key, value] of Object.entries(counts)) target[key] = (target[key] ?? 0) + value
}

function parseDialogue(prompt) {
  const marker = /【(坐席|客户)】/gu
  const matches = [...prompt.matchAll(marker)]
  if (matches.length === 0) throw new Error('dialogue has no 坐席/客户 markers')
  const turns = []
  const redactionCounts = {}
  for (const [index, match] of matches.entries()) {
    const start = match.index + match[0].length
    const end = matches[index + 1]?.index ?? prompt.length
    const cleaned = redactText(prompt.slice(start, end))
    mergeCounts(redactionCounts, cleaned.counts)
    if (cleaned.text.length === 0) continue
    turns.push({ speaker: match[1] === '客户' ? 'customer' : 'agent', text: cleaned.text })
  }
  if (turns.length === 0) throw new Error('dialogue has no non-empty turn')
  const hasCustomerMarker = turns.some(turn => turn.speaker === 'customer')
  return {
    turns: hasCustomerMarker ? turns : turns.map(turn => ({ ...turn, speaker: 'unknown' })),
    redactionCounts,
    segmentationStatus: hasCustomerMarker ? 'complete_markers' : 'missing_customer_marker',
  }
}

function evalTargetPrompt(prompt) {
  const marker = '请总结下面这段客服对话：'
  const start = prompt.lastIndexOf(marker)
  if (start < 0) throw new Error('eval prompt has no target dialogue marker')
  return prompt.slice(start + marker.length).replace(/\n总结：\s*(?:Assistant:)?\s*$/u, '').trim()
}

function titleFromSummary(summary) {
  const withoutLead = summary
    .replace(/^\[已脱敏\](?:用户)?(?:来电)?(?:反映|咨询|投诉|称)?[：:\s]*/u, '')
    .replace(/^(?:用户|客户)(?:来电)?(?:反映|咨询|投诉|称|表示|反馈)[：:\s]*/u, '')
  const sentence = withoutLead.split(/[。；！？.!?;\n]/u)[0]?.trim()
  const firstClause = sentence?.split(/[,，]/u).find(value => value.trim().length >= 4)?.trim()
  const clause = firstClause ?? sentence
  const candidate = clause && clause.length >= 4 ? clause : summary.trim()
  return [...candidate].slice(0, 40).join('').replace(/[，,：:\s]+$/u, '')
}

function classify(text) {
  const tags = []
  let category = '其他通信客服'
  for (const [label, pattern, ruleTags] of categoryRules) {
    if (!pattern.test(text)) continue
    if (category === '其他通信客服') category = label
    tags.push(...ruleTags)
  }
  if (/投诉|不认可|强烈要求|工信部/u.test(text)) tags.push('争议投诉')
  if (/退费|核减|返费/u.test(text)) tags.push('退费诉求')
  return { category, tags: [...new Set(tags)] }
}

function productFromText(text) {
  if (/宽带|光猫|路由器|装机|移机|网线/u.test(text)) return '家庭宽带'
  if (/固话|座机/u.test(text)) return '固定电话'
  return '移动通信'
}

function sourceRow(split, row) {
  if (split === 'train') {
    if (!Array.isArray(row.messages) || row.messages.length !== 2) throw new Error('train messages must contain two entries')
    const user = row.messages[0]
    const assistant = row.messages[1]
    if (user?.role !== 'user' || assistant?.role !== 'assistant') throw new Error('train message roles are invalid')
    return {
      sourceIndex: String(row.id),
      originalDataset: String(row.dataset),
      prompt: String(user.content).replace(/\n总结[：:]\s*$/u, '').trim(),
      summary: String(assistant.content),
      sourceMetadata: { source_length: row.length },
    }
  }
  const summary = row.answers?.[0] ?? row.raw_answers?.[0]
  if (summary === undefined) throw new Error('eval answer is missing')
  return {
    sourceIndex: String(row.idx),
    originalDataset: 'df_536_service',
    prompt: evalTargetPrompt(String(row.prompt)),
    summary: String(summary),
    sourceMetadata: { raw_answer_matches_answer: row.raw_answers?.[0] === row.answers?.[0] },
  }
}

function normalizedRecord(split, row) {
  const source = sourceRow(split, row)
  const parsed = parseDialogue(source.prompt)
  const cleanedSummary = redactText(source.summary)
  mergeCounts(parsed.redactionCounts, cleanedSummary.counts)
  const summary = cleanedSummary.text
  if (summary.length === 0) throw new Error('summary is empty after redaction')
  const customerText = parsed.turns
    .filter(turn => turn.speaker === 'customer')
    .map(turn => turn.text)
    .join('\n')
  const problemDescription = customerText.length > 0 ? customerText : summary
  const classification = classify(`${summary}\n${problemDescription}`)
  const cleanedTitle = redactText(titleFromSummary(summary))
  mergeCounts(parsed.redactionCounts, cleanedTitle.counts)
  const generatedFields = ['ticket_id', 'title', 'problem_description', 'domain', 'language', 'category', 'type', 'product', 'tags']
  const priority = /加急|紧急/u.test(summary) ? '高' : null
  if (priority !== null) generatedFields.push('priority')
  const ticketId = `ESFT-SUMMARY-${split.toUpperCase()}-${source.sourceIndex.padStart(split === 'eval' ? 4 : 6, '0')}`
  return {
    ticket_id: ticketId,
    source_dataset: SOURCE_DATASET,
    source_version: SOURCE_COMMIT,
    source_kind: 'public_research_corpus',
    source_split: split,
    source_index: source.sourceIndex,
    source_original_dataset: source.originalDataset,
    domain: 'telecom_customer_service',
    language: 'zh-CN',
    title: cleanedTitle.text,
    summary,
    problem_description: problemDescription,
    category: classification.category,
    type: '客服通话摘要',
    product: productFromText(`${summary}\n${problemDescription}`),
    priority,
    status: null,
    region: null,
    created_at: null,
    tags: classification.tags,
    raw_dialogue: parsed.turns,
    pii_redaction_status: 'redacted',
    source_metadata: source.sourceMetadata,
    transformation: {
      schema_version: TRANSFORMATION_VERSION,
      dialogue_segmentation_status: parsed.segmentationStatus,
      source_row_sha256: sha256Text(JSON.stringify(row)),
      generated_fields: generatedFields,
      unverifiable_fields_left_null: ['created_at', 'region', 'status', ...(priority === null ? ['priority'] : [])],
      pii_redaction_counts: parsed.redactionCounts,
    },
  }
}

async function writeNormalizedSplit(split) {
  const source = sourceFiles[split]
  const outputPath = outputFiles[split]
  await mkdir(dirname(outputPath), { recursive: true })
  const partPath = `${outputPath}.part`
  const output = createWriteStream(partPath, { encoding: 'utf8' })
  const digest = createHash('sha256')
  const ids = new Set()
  const categories = new Map()
  const redactions = {}
  let recordCount = 0
  let customerTurnCount = 0
  let agentTurnCount = 0
  let unknownTurnCount = 0
  let incompleteSegmentationCount = 0
  const input = createInterface({ input: createReadStream(source.path, { encoding: 'utf8' }), crlfDelay: Infinity })
  try {
    for await (const line of input) {
      if (line.trim().length === 0) continue
      const record = normalizedRecord(split, JSON.parse(line))
      if (ids.has(record.ticket_id)) throw new Error(`${split} duplicate ticket_id ${record.ticket_id}`)
      ids.add(record.ticket_id)
      categories.set(record.category, (categories.get(record.category) ?? 0) + 1)
      mergeCounts(redactions, record.transformation.pii_redaction_counts)
      customerTurnCount += record.raw_dialogue.filter(turn => turn.speaker === 'customer').length
      agentTurnCount += record.raw_dialogue.filter(turn => turn.speaker === 'agent').length
      unknownTurnCount += record.raw_dialogue.filter(turn => turn.speaker === 'unknown').length
      if (record.transformation.dialogue_segmentation_status !== 'complete_markers') incompleteSegmentationCount += 1
      const encoded = `${JSON.stringify(record)}\n`
      digest.update(encoded, 'utf8')
      if (!output.write(encoded)) await new Promise(resolveDrain => output.once('drain', resolveDrain))
      recordCount += 1
    }
  } finally {
    output.end()
    await new Promise((resolveClose, rejectClose) => {
      output.once('finish', resolveClose)
      output.once('error', rejectClose)
    })
  }
  await rm(outputPath, { force: true })
  await rename(partPath, outputPath)
  return {
    path: outputPath,
    recordCount,
    sha256: digest.digest('hex'),
    categoryCounts: Object.fromEntries([...categories].sort(([left], [right]) => left.localeCompare(right, 'zh-CN'))),
    turnCounts: { customer: customerTurnCount, agent: agentTurnCount, unknown: unknownTurnCount },
    incompleteSegmentationCount,
    piiRedactionCounts: redactions,
  }
}

function relativeDataPath(path) {
  return path.slice(dataRoot.length + 1).replaceAll('\\', '/')
}

async function buildManifest(train, evaluation) {
  const manifest = {
    schemaVersion: 'retrieval-agent.data.v1',
    defaultTicketProfile: 'esft-summary-train-v1',
    transformationVersion: TRANSFORMATION_VERSION,
    sourcePolicy: {
      authoritativeSource: SOURCE_DATASET,
      pinnedRevision: SOURCE_COMMIT,
      datasetLicenseReview: SOURCE_LICENSE_REVIEW,
      redistribution: 'disabled-pending-review',
      rawDataMayContainPii: true,
      providerMayReadOnlyRedactedNormalizedData: true,
      runtimeTicketSources: [SOURCE_DATASET],
      fallbackSources: [],
    },
    layerPolicy: {
      L0: ['ticket_id', 'source_dataset', 'source_version', 'source_split', 'domain', 'language', 'category', 'type', 'product', 'priority'],
      L1: ['title'],
      L2: ['summary', 'problem_description'],
      L3: ['raw_dialogue', 'source_metadata', 'transformation'],
      note: 'L3 is the redacted source payload, not the downloaded upstream row. Unverifiable time, region, and status fields remain null.',
    },
    generatedFieldPolicy: {
      ticket_id: 'deterministic split plus upstream id',
      title: 'first factual clause of the redacted official summary, capped at 40 Unicode code points',
      problem_description: 'ordered concatenation of redacted customer turns',
      category: 'deterministic telecom keyword rules',
      type: 'constant 客服通话摘要',
      product: 'deterministic broadband, fixed-line, or mobile keyword rule',
      tags: 'deterministic multi-label telecom keyword rules',
      priority: '高 only when the official summary explicitly contains 加急 or 紧急; otherwise null',
    },
    normalizationPolicy: {
      taskPromptRemoved: ['请总结下面这段客服对话：', '总结：'],
      answerMapping: 'train messages[assistant].content and eval answers[0] are normalized to summary; raw_answers[0] is a fallback only',
      answerFieldsRetained: false,
      dialogueMapping: '坐席 becomes agent; 客户 becomes customer; unresolvable speaker labels become unknown',
    },
    rawSources: {
      train: { path: relativeDataPath(sourceFiles.train.path), url: sourceFiles.train.url, bytes: sourceFiles.train.size, sha256: sourceFiles.train.sha256 },
      eval: { path: relativeDataPath(sourceFiles.eval.path), url: sourceFiles.eval.url, bytes: sourceFiles.eval.size, sha256: sourceFiles.eval.sha256 },
    },
    ticketProfiles: {
      'esft-summary-train-v1': {
        purpose: 'default-telecom-development-corpus',
        recordCount: train.recordCount,
        paths: [relativeDataPath(train.path)],
        sha256: [train.sha256],
      },
    },
    evaluations: {
      'esft-summary-eval-v1': { recordCount: evaluation.recordCount, path: relativeDataPath(evaluation.path), sha256: evaluation.sha256, indexedByDefault: false },
    },
    quality: {
      train: { categoryCounts: train.categoryCounts, turnCounts: train.turnCounts, incompleteSegmentationCount: train.incompleteSegmentationCount, piiRedactionCounts: train.piiRedactionCounts },
      eval: { categoryCounts: evaluation.categoryCounts, turnCounts: evaluation.turnCounts, incompleteSegmentationCount: evaluation.incompleteSegmentationCount, piiRedactionCounts: evaluation.piiRedactionCounts },
    },
  }
  await writeFile(join(dataRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return manifest
}

async function build() {
  for (const source of Object.values(sourceFiles)) {
    if (!await exists(source.path)) throw new Error(`missing raw source ${source.path}; run data:download first`)
    const info = await stat(source.path)
    if (info.size !== source.size || await sha256File(source.path) !== source.sha256) {
      throw new Error(`raw source integrity mismatch: ${source.path}`)
    }
  }
  const train = await writeNormalizedSplit('train')
  const evaluation = await writeNormalizedSplit('eval')
  const manifest = await buildManifest(train, evaluation)
  return { train, evaluation, manifestPath: join(dataRoot, 'manifest.json'), defaultProfile: manifest.defaultTicketProfile }
}

function residualSensitiveText(record) {
  const values = [record.title, record.summary, record.problem_description, ...record.raw_dialogue.map(turn => turn.text)]
  return values.find(value => {
    if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu.test(value)) return true
    return [...value.matchAll(/(?<![\d.])\d{5,}(?![\d.])/gu)].some(match => !PUBLIC_SERVICE_NUMBERS.has(match[0]))
  })
}

async function verifyNormalized(path, expectedCount, expectedSplit) {
  const ids = new Set()
  let recordCount = 0
  let residualSensitiveRows = 0
  for await (const line of createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity })) {
    if (line.trim().length === 0) continue
    const record = JSON.parse(line)
    if (record.source_dataset !== SOURCE_DATASET || record.source_version !== SOURCE_COMMIT || record.source_split !== expectedSplit) {
      throw new Error(`${path} row ${recordCount + 1} has invalid source identity`)
    }
    if (typeof record.ticket_id !== 'string' || ids.has(record.ticket_id)) throw new Error(`${path} has missing or duplicate ticket_id`)
    ids.add(record.ticket_id)
    if (typeof record.title !== 'string' || record.title.length === 0 || [...record.title].length > 40) throw new Error(`${path} has invalid title`)
    if (typeof record.summary !== 'string' || record.summary.length === 0) throw new Error(`${path} has invalid summary`)
    if (typeof record.problem_description !== 'string' || record.problem_description.length === 0) throw new Error(`${path} has invalid problem_description`)
    if (!Array.isArray(record.raw_dialogue) || record.raw_dialogue.length === 0) throw new Error(`${path} has invalid raw_dialogue`)
    if (record.pii_redaction_status !== 'redacted') throw new Error(`${path} has invalid redaction status`)
    if ('answer' in record || 'answers' in record || 'raw_answers' in record || 'prompt' in record || 'messages' in record) {
      throw new Error(`${path} retains an upstream prompt or answer field instead of the normalized schema`)
    }
    if (JSON.stringify(record).includes('请总结下面这段客服对话') || JSON.stringify(record).includes('总结：')) {
      throw new Error(`${path} retains an ESFT summarization instruction`)
    }
    if (residualSensitiveText(record) !== undefined) residualSensitiveRows += 1
    recordCount += 1
  }
  if (recordCount !== expectedCount) throw new Error(`${path} expected ${expectedCount} records, got ${recordCount}`)
  if (residualSensitiveRows > 0) throw new Error(`${path} has ${residualSensitiveRows} rows with residual long identifiers`)
  return { path, recordCount, sha256: await sha256File(path), residualSensitiveRows }
}

async function verify() {
  const manifest = JSON.parse(await readFile(join(dataRoot, 'manifest.json'), 'utf8'))
  if (manifest.sourcePolicy?.authoritativeSource !== SOURCE_DATASET || manifest.sourcePolicy?.fallbackSources?.length !== 0) {
    throw new Error('manifest source policy must be ESFT-only with no fallback')
  }
  if (Object.keys(manifest.ticketProfiles).length !== 1 || manifest.defaultTicketProfile !== 'esft-summary-train-v1') {
    throw new Error('manifest must expose exactly one ESFT runtime ticket profile')
  }
  const trainProfile = manifest.ticketProfiles[manifest.defaultTicketProfile]
  const evalProfile = manifest.evaluations['esft-summary-eval-v1']
  const [train, evaluation] = await Promise.all([
    verifyNormalized(join(dataRoot, trainProfile.paths[0]), trainProfile.recordCount, 'train'),
    verifyNormalized(join(dataRoot, evalProfile.path), evalProfile.recordCount, 'eval'),
  ])
  if (train.sha256 !== trainProfile.sha256[0]) throw new Error('default train output SHA-256 differs from manifest')
  if (evaluation.sha256 !== evalProfile.sha256) throw new Error('eval output SHA-256 differs from manifest')
  return { status: 'verified', defaultProfile: manifest.defaultTicketProfile, train, evaluation }
}

async function download() {
  return await Promise.all(Object.entries(sourceFiles).map(([name, source]) => downloadSource(name, source)))
}

const command = process.argv[2] ?? 'verify'
let result
if (command === 'download') result = await download()
else if (command === 'build') result = await build()
else if (command === 'verify') result = await verify()
else if (command === 'all') {
  const downloads = await download()
  const built = await build()
  const verified = await verify()
  result = { downloads, built, verified }
} else {
  throw new Error(`unknown command ${command}; expected download, build, verify, or all`)
}
console.log(JSON.stringify(result, null, 2))
