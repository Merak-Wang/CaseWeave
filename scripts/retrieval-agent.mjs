#!/usr/bin/env node
import { runCli } from './local-app.mjs'

try {
  await runCli(process.argv.slice(2))
} catch (error) {
  process.stderr.write(`retrieval-agent: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
