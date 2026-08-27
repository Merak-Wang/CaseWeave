#!/usr/bin/env node
import { resolve } from 'node:path'
import { installLocalProductAssets } from './startup.js'

const args = process.argv.slice(2)
const homeIndex = args.indexOf('--home')
const requestedHome = homeIndex >= 0 ? args[homeIndex + 1] : process.env.DSH_HOME
if (requestedHome === undefined || requestedHome.trim().length === 0) {
  throw new Error('Pass --home <DSH_HOME> or set DSH_HOME')
}
const receipt = await installLocalProductAssets(resolve(requestedHome), args.includes('--force'))
process.stdout.write(`${JSON.stringify(receipt)}\n`)
