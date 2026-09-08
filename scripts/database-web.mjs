import { runLocalWeb } from './local-app.mjs'
await runLocalWeb(process.argv.slice(2), { environment: { ...process.env, RETRIEVAL_AGENT_STORAGE: 'mysql_milvus' } })
