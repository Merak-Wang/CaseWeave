import { spawn } from 'node:child_process'
import { startEmbeddedModel } from './container-web.mjs'
const model = await startEmbeddedModel()
async function run(script, args) {
 const child = spawn(process.execPath, [script, ...args], { stdio: 'inherit', env: process.env })
 const code = await new Promise(resolve => child.once('exit', resolve))
 if (code !== 0) throw new Error(`${script} exited with ${code}`)
}
try {
 if (!process.env.RETRIEVAL_AGENT_DATA_PATH) await run('scripts/manage-ticket-data.mjs', ['all'])
 for (const step of ['prepare', 'grams', 'verify']) await run('scripts/database.mjs', [step])
} finally { model.kill('SIGTERM') }
