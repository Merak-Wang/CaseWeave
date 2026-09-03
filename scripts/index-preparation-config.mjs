function configuredMilliseconds(environment, name, fallback, minimum) {
  const raw = environment[name]
  if (raw === undefined || String(raw).trim().length === 0) return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer of at least ${minimum} milliseconds`)
  }
  return value
}

function configuredPositiveInteger(environment, name, fallback) {
  const raw = environment[name]
  if (raw === undefined || String(raw).trim().length === 0) return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`)
  return value
}

export function resolveIndexPreparationConfig(environment = process.env) {
  for (const name of ['RETRIEVAL_AGENT_INDEX_INACTIVITY_TIMEOUT_MS', 'RETRIEVAL_AGENT_INDEX_MAX_DURATION_MS']) {
    if (environment[name] !== undefined && String(environment[name]).trim().length > 0) {
      throw new Error(`${name} was removed; configure progress reporting or checkpoint frequency instead`)
    }
  }
  return {
    pollIntervalMs: configuredMilliseconds(environment, 'RETRIEVAL_AGENT_INDEX_PROGRESS_INTERVAL_MS', 1_000, 5),
    checkpointEveryBatches: configuredPositiveInteger(environment, 'RETRIEVAL_AGENT_INDEX_CHECKPOINT_BATCHES', 8),
  }
}
