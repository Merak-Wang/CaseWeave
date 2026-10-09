#!/usr/bin/env node
import { resolve } from 'node:path'
import { installLocalProductAssets } from './startup.js'

const args = process.argv.slice(2)
const homeIndex = args.indexOf('--home')
const requestedHome = homeIndex >= 0 ? args[homeIndex + 1] : process.env.DSH_HOME
if (requestedHome === undefined || requestedHome.trim().length === 0) {
  throw new Error('Pass --home <DSH_HOME> or set DSH_HOME')
}
const dataRootIndex = args.indexOf('--data-root')
const requestedDataRoot = dataRootIndex >= 0 ? args[dataRootIndex + 1] : undefined
if (dataRootIndex >= 0 && (requestedDataRoot === undefined || requestedDataRoot.trim().length === 0)) {
  throw new Error('Pass a path after --data-root')
}
const scopeIndex = args.indexOf('--profile-scope')
const profileScope = scopeIndex >= 0 ? args[scopeIndex + 1] : 'jsonl'
if (profileScope !== 'jsonl' && profileScope !== 'mysql_milvus') {
  throw new Error('Pass jsonl or mysql_milvus after --profile-scope')
}
const receipt = await installLocalProductAssets(
  resolve(requestedHome),
  args.includes('--force'),
  requestedDataRoot === undefined ? undefined : resolve(requestedDataRoot),
  { skipData: args.includes('--skip-data'), profileScope },
)
process.stdout.write(`${JSON.stringify(receipt)}\n`)
