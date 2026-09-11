import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrateSessionDirectory } from '../packages/dsh-compat/lib/migration-files.js'

export { migrateSessionDirectory }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const home = args.find(arg => arg.startsWith('--home='))?.slice(7)
  if (!home || (args.includes('--write') && args.includes('--check')) || args.some(arg => !arg.startsWith('--home=') && arg !== '--write' && arg !== '--check')) {
    throw new Error('Usage: node scripts/migrate-dsh-sessions.mjs --home=DSH_HOME [--check | --write]. Stop the old Host before --write.')
  }
  const result = await migrateSessionDirectory(join(resolve(home), 'sessions'), args.includes('--write'))
  const refused = result.filter(item => item.action === 'refused').length
  console.log(JSON.stringify({ sessions: result.length, refused, results: result }, null, 2))
  if (refused) process.exitCode = 1
}
