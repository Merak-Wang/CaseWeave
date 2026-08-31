import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const path = join(process.cwd(), 'architecture', 'product-quality-gate.json')
const gate = JSON.parse(await readFile(path, 'utf8'))
if (gate.schemaVersion !== 1 || !Array.isArray(gate.requirements)) {
  throw new Error('product quality gate manifest is invalid')
}
const open = gate.requirements.filter(requirement => {
  if (requirement.status !== 'verified') return true
  if (typeof requirement.required === 'number') return Number(requirement.observed) < requirement.required
  return requirement.required === true && requirement.observed !== true
})
if (gate.status !== 'verified' || open.length > 0) {
  console.error('Product quality release gate is BLOCKED:')
  for (const requirement of open) {
    console.error(`- ${requirement.id}: ${requirement.description}`)
  }
  process.exitCode = 1
} else {
  console.log('Product quality release gate verified.')
}
