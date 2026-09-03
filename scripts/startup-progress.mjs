const PHASE_LABELS = {
  checking_cache: 'checking cache',
  embedding: 'embedding',
  publishing: 'publishing cache',
  ready: 'ready',
  failed: 'failed',
}

function duration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '?'
  const seconds = Math.round(milliseconds / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${seconds % 60}s`
}

export function formatPreparationProgress(label, progress, width = 24) {
  const total = Math.max(0, Number(progress.totalDocuments) || 0)
  const completed = Math.min(total, Math.max(0, Number(progress.completedDocuments) || 0))
  const phase = PHASE_LABELS[progress.phase] ?? String(progress.phase)
  if (progress.phase !== 'embedding' && progress.phase !== 'ready') {
    return `${label} [${phase}] ${completed}/${total} | elapsed ${duration(progress.elapsedMs)}`
  }
  const ratio = total === 0 ? 0 : completed / total
  const filled = Math.min(width, Math.round(ratio * width))
  const percent = Math.min(100, Math.floor(ratio * 100))
  const parts = [`${label} [${'#'.repeat(filled)}${'-'.repeat(width - filled)}] ${percent}% ${completed}/${total}`]
  if (progress.resumedDocuments > 0) parts.push(`resumed ${progress.resumedDocuments}`)
  if (progress.documentsPerSecond > 0) parts.push(`${progress.documentsPerSecond.toFixed(1)} docs/s`)
  if (progress.estimatedRemainingMs !== null) parts.push(`ETA ${duration(progress.estimatedRemainingMs)}`)
  return parts.join(' | ')
}

function activityLine(label, elapsedMs, detail) {
  return `${label} [working] elapsed ${duration(elapsedMs)}${detail ? ` | ${detail}` : ''}`
}

function bytes(value) {
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KiB`
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MiB`
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GiB`
}

export function formatByteProgress(label, completedBytes, totalBytes, width = 24) {
  const total = Math.max(1, totalBytes)
  const completed = Math.min(total, Math.max(0, completedBytes))
  const ratio = completed / total
  const filled = Math.min(width, Math.round(ratio * width))
  return `${label} [${'#'.repeat(filled)}${'-'.repeat(width - filled)}] ${Math.floor(ratio * 100)}% ${bytes(completed)}/${bytes(total)}`
}

export function createStartupProgressReporter(stream = process.stderr) {
  const tty = stream.isTTY === true
  const progressWidth = tty ? Math.max(10, Math.min(24, Number(stream.columns ?? 120) - 70)) : 24
  let live = false
  let lastNonTtyKey = ''
  let lastNonTtyAt = 0
  let announcedResume = 0

  const clearLive = () => {
    if (live && tty) stream.write('\r\x1b[2K')
    live = false
  }
  const line = message => {
    clearLive()
    stream.write(`${message}\n`)
  }
  const update = (message, key, minimumIntervalMs = 5_000) => {
    if (tty) {
      stream.write(`\r\x1b[2K${message}`)
      live = true
      return
    }
    const now = Date.now()
    if (key !== lastNonTtyKey || now - lastNonTtyAt >= minimumIntervalMs) {
      stream.write(`${message}\n`)
      lastNonTtyKey = key
      lastNonTtyAt = now
    }
  }

  return {
    stage(label, detail = '') {
      line(`${label}${detail ? ` | ${detail}` : ''}`)
    },
    activity(label, elapsedMs, detail = '') {
      update(activityLine(label, elapsedMs, detail), `${label}:${Math.floor(elapsedMs / 10_000)}`)
    },
    preparation(label, progress) {
      if (tty && !progress.cacheHit && progress.resumedDocuments > announcedResume) {
        announcedResume = progress.resumedDocuments
        line(`${label} [checkpoint] resumed ${progress.resumedDocuments}/${progress.totalDocuments}`)
      }
      const displayed = tty && progress.resumedDocuments > 0
        ? { ...progress, resumedDocuments: 0 }
        : progress
      const percentBucket = progress.totalDocuments === 0
        ? 0
        : Math.floor((progress.completedDocuments / progress.totalDocuments) * 20)
      update(
        formatPreparationProgress(label, displayed, progressWidth),
        `${progress.phase}:${percentBucket}:${progress.resumedDocuments}`,
        10_000,
      )
    },
    bytes(label, completedBytes, totalBytes) {
      const bucket = Math.floor((completedBytes / Math.max(1, totalBytes)) * 20)
      update(formatByteProgress(label, completedBytes, totalBytes), `${label}:${bucket}`, 10_000)
    },
    complete(label, detail = '') {
      line(`${label} [done]${detail ? ` | ${detail}` : ''}`)
    },
    fail(label, error) {
      line(`${label} [failed] | ${error instanceof Error ? error.message : String(error)}`)
    },
    close() {
      clearLive()
    },
  }
}
