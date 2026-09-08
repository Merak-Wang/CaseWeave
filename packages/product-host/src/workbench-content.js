/** Present serialized dialogue without changing its authoritative citation offsets. */
export function displayFieldPart(source, citations = []) {
  let value = source, speaker, bounds
  try {
    const part = JSON.parse(source)
    if (part && !Array.isArray(part) && typeof part.speaker === 'string' && typeof part.text === 'string'
      && Object.keys(part).every(key => ['speaker', 'text'].includes(key))) {
      const match = /"text"\s*:\s*"((?:\\.|[^"\\])*)"/du.exec(source)
      if (match) { bounds = match.indices[1]; value = part.text; speaker = ({ agent: '客服', customer: '客户', user: '客户' })[part.speaker] || part.speaker }
    }
  } catch { /* Ordinary source text remains untouched. */ }
  const ranges = []
  for (const citation of citations) {
    if (source.slice(citation.start, citation.end) !== citation.text) continue
    let start = citation.start, end = citation.end
    if (bounds) {
      start = Math.max(start, bounds[0]); end = Math.min(end, bounds[1])
      if (start >= end) continue
      try {
        start = JSON.parse('"' + source.slice(bounds[0], start) + '"').length
        end = JSON.parse('"' + source.slice(bounds[0], end) + '"').length
      } catch { continue /* Never guess a highlight across a partial JSON escape. */ }
    }
    ranges.push({ start, end })
  }
  return { value, speaker, ranges: ranges.sort((a, b) => a.start - b.start) }
}
