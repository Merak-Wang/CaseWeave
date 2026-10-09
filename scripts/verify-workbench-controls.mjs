import { createRequire } from 'node:module'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Fallback driver for an already installed core Playwright; installs nothing.
const args = process.argv.slice(2), option = (name, fallback) => { const index = args.indexOf(name); return index === -1 ? fallback : args[index + 1] }
const root = option('--playwright-root'), url = option('--url', 'http://127.0.0.1:3099/retrieval'), out = resolve(option('--out', 'output/playwright/controls'))
if (!root) throw new Error('Supply --playwright-root pointing to an existing Playwright package')
const target = new URL(url)
if (target.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(target.hostname)) throw new Error('Synthetic controls URL must be local HTTP')
const { chromium } = createRequire(import.meta.url)(resolve(root))
const browser = await chromium.launch({ headless: true, channel: option('--channel', 'msedge') })
await mkdir(out, { recursive: true })
let fixture
try {
  if (args.includes('--start-fixture')) {
    fixture = spawn(process.execPath, [fileURLToPath(new URL('./preview-workbench-controls.mjs', import.meta.url))], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WORKBENCH_CONTROLS_PORT: target.port || '80' },
    })
    await new Promise((resolve, reject) => {
      let details = '', settled = false
      const timer = setTimeout(() => finish(new Error('Synthetic fixture did not start within five seconds')), 5000)
      const finish = error => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve() }
      fixture.once('error', finish)
      fixture.once('exit', code => finish(new Error('Synthetic fixture exited ' + code + ': ' + details)))
      fixture.stderr.on('data', chunk => { details += chunk.toString('utf8') })
      fixture.stdout.on('data', chunk => { if (chunk.toString('utf8').includes('"syntheticOnly":true')) finish() })
    })
  }
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  await page.goto(url)
  await page.getByRole('checkbox', { name: '使用反馈学习', exact: true }).waitFor()
  await writeFile(resolve(out, 'initial-dom.txt'), await page.locator('body').innerText())
  await page.screenshot({ path: resolve(out, 'initial.png'), fullPage: true })
  const check = runInNewContext('(' + await readFile(new URL('./check-workbench-execution.js', import.meta.url), 'utf8') + ')', { URL, Buffer })
  const result = await check(page)
  await page.screenshot({ path: resolve(out, 'final.png'), fullPage: true })
  const report = { ...result, pageErrors: errors, passed: !result.error && errors.length === 0 && result.checks?.length > 0 && result.checks.every(check => check.passed) }
  await writeFile(resolve(out, 'verification.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
  if (!report.passed) process.exitCode = 1
} finally { await browser.close(); fixture?.kill() }
