import { describe, expect, it } from 'vitest'
import { isCompactHeaderWidth, shouldHideHeaderIdentity } from './responsive.js'

describe('isCompactHeaderWidth', () => {
  it('uses the icon-only utility at the narrow-screen boundary', () => {
    expect(isCompactHeaderWidth(481)).toBe(false)
    expect(isCompactHeaderWidth(480)).toBe(true)
    expect(isCompactHeaderWidth(320)).toBe(true)
  })

  it('reserves the 320px header for session and export utilities', () => {
    expect(shouldHideHeaderIdentity(341)).toBe(false)
    expect(shouldHideHeaderIdentity(340)).toBe(true)
    expect(shouldHideHeaderIdentity(320)).toBe(true)
  })
})
