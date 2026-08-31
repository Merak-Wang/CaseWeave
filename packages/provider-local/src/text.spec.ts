import { describe, expect, it } from 'vitest'
import { tokenize } from './text.js'

describe('tokenize', () => {
  it('separates adjacent Latin and Han runs so mixed ticket titles stay retrievable', () => {
    expect(tokenize('APP登录提示')).toEqual(['app', '登', '录', '提', '示', '登录', '录提', '提示'])
  })
})
