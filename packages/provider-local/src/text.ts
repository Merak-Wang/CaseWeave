/** Projection-only tokenizer used for match fragments; ranking tokenization lives in Python. */
export function tokenize(text: string): string[] {
  const normalized = text.normalize('NFKC').toLocaleLowerCase()
  const tokens: string[] = []
  for (const match of normalized.matchAll(/[\p{Script=Han}]+|(?:(?!\p{Script=Han})[\p{L}\p{N}])(?:(?!\p{Script=Han})[\p{L}\p{N}_.:/-])*/gu)) {
    const value = match[0]
    if (/^\p{Script=Han}+$/u.test(value)) {
      const chars = [...value]
      tokens.push(...chars)
      for (let index = 0; index + 1 < chars.length; index += 1) tokens.push(`${chars[index]}${chars[index + 1]}`)
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
