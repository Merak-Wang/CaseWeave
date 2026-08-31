export const RANKING_TOKENIZER_VERSION = 'unicode-han-bigram-v1' as const

/** Deterministic mixed Chinese/Latin tokenization for the lexical baseline. */
export function tokenizeRankingText(text: string): string[] {
  const normalized = text.normalize('NFKC').toLocaleLowerCase()
  const tokens: string[] = []
  // The second branch explicitly excludes Han at every position. A plain
  // `\p{L}` branch would greedily turn `APP登录` into one token.
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
