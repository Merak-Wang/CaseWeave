const WORD = /[\p{L}\p{N}]+/gu

/** Deterministic NFKC tokenization with CJK unigrams/bigrams and word tokens. */
export function tokenize(input: string): string[] {
  const normalized = input.normalize('NFKC').toLocaleLowerCase('zh-CN')
  const tokens: string[] = []
  for (const match of normalized.matchAll(WORD)) {
    const value = match[0]
    if (/^[\p{Script=Han}]+$/u.test(value)) {
      const chars = [...value]
      tokens.push(...chars)
      for (let index = 0; index + 1 < chars.length; index += 1) {
        tokens.push(`${chars[index]}${chars[index + 1]}`)
      }
    } else {
      tokens.push(value)
    }
  }
  return tokens
}
export function estimateTokens(input: string): number {
  if (input.length === 0) return 0
  const cjk = [...input].filter(character => /\p{Script=Han}/u.test(character)).length
  return Math.max(1, Math.ceil(cjk + (input.length - cjk) / 4))
}

export function truncateToEstimatedTokens(input: string, budget: number): { text: string; tokens: number; truncated: boolean } {
  if (budget <= 0) return { text: '', tokens: 0, truncated: input.length > 0 }
  if (estimateTokens(input) <= budget) return { text: input, tokens: estimateTokens(input), truncated: false }
  let low = 0
  let high = input.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (estimateTokens(input.slice(0, middle)) <= budget) low = middle
    else high = middle - 1
  }
  const text = input.slice(0, low)
  return { text, tokens: estimateTokens(text), truncated: true }
}
