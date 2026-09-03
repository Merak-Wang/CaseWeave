import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
const tickets = (await readFile(join(process.cwd(), 'data', 'tickets', 'synthetic', 'legacy-bronze-v1.jsonl'), 'utf8'))
  .split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line))
const cases = (await readFile(join(process.cwd(), 'data', 'evals', 'legacy-bronze-v1', 'cases.jsonl'), 'utf8'))
  .split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line))
const titleById = new Map(tickets.map(ticket => [ticket.ticketId, String(ticket.title)]))
const positives = cases.filter(item => item.qrels.some(qrel => qrel.relevance > 0))
const negatives = cases.filter(item => item.qrels.every(qrel => qrel.relevance <= 0))
const containsFullGoldTitle = positives.filter(item => item.qrels.some(qrel => {
  const title = titleById.get(qrel.ticketId)
  return title !== undefined && String(item.query).includes(title)
}))
const equalsGoldTitle = positives.filter(item => item.qrels.some(qrel => {
  const title = titleById.get(qrel.ticketId)
  return title !== undefined && String(item.query).trim() === title
}))
const multiRelevant = positives.filter(item => item.qrels.filter(qrel => qrel.relevance > 0).length > 1)
const artificialSentinelNegatives = negatives.filter(item => /__no_such|no_such_ticket/iu.test(String(item.query)))

console.log(JSON.stringify({
  evidenceLevel: 'dataset_structure_audit',
  dataset: 'legacy-bronze-v1',
  caseCount: cases.length,
  positiveCaseCount: positives.length,
  noResultCaseCount: negatives.length,
  noResultRate: negatives.length / cases.length,
  positiveQueriesContainingFullGoldTitle: containsFullGoldTitle.length,
  positiveQueriesEqualToGoldTitle: equalsGoldTitle.length,
  multiRelevantCaseCount: multiRelevant.length,
  artificialSentinelNoResultCount: artificialSentinelNegatives.length,
  artificialSentinelQueries: artificialSentinelNegatives.map(item => item.query),
  releaseGateEligible: false,
  reasons: [
    'The set is generated Bronze, not independently labeled Silver/Gold.',
    'Natural-language product entry and final Agent collection are not represented by provider-only scores.',
    'No-result, ambiguity, boundary-conflict, multi-relevant, and clarification cases are not representative.',
  ],
}, undefined, 2))
