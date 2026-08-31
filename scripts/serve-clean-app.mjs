process.env.RETRIEVAL_AGENT_BROWSER_REVIEW = '1'

const { developmentVectorCacheDir, prepareDevelopmentIndex } = await import('./prepare-development-index.mjs')
process.env.RETRIEVAL_AGENT_VECTOR_CACHE_DIR ??= developmentVectorCacheDir

console.log('Waiting for the model service and preparing the persistent 2,040-ticket vector index...')
const prepared = await prepareDevelopmentIndex({ cacheDir: process.env.RETRIEVAL_AGENT_VECTOR_CACHE_DIR })
console.log(`Retrieval index ready: ${prepared.documentCount} documents, ${Math.round(prepared.elapsedMs)} ms, ${prepared.cacheDir}`)
console.log('Preparing an isolated Retrieval Agent DSH profile...')
console.log('Open the printed BROWSER_REVIEW_URL in Edge; press Enter here to stop and clean up.')

await import('./verify-clean-install.mjs')
