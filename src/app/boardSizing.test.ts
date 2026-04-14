import { describe, expect, it } from 'vitest'
import {
  boardSizeFromHeight,
  boardSizeFromWidth,
  parseNumericExpression,
} from './boardSizing'

describe('board sizing', () => {
  it('derives a locked size from a target width', () => {
    expect(boardSizeFromWidth(640, 16 / 9)).toEqual({
      width: 640,
      height: 360,
    })
  })

  it('derives a locked size from a target height', () => {
    expect(boardSizeFromHeight(300, 4 / 3)).toEqual({
      width: 400,
      height: 300,
    })
  })

  it('preserves aspect ratio when the minimum board size applies', () => {
    expect(boardSizeFromWidth(48, 2)).toEqual({
      width: 96,
      height: 48,
    })
  })

  it('evaluates arithmetic expressions for numeric drafts', () => {
    expect(parseNumericExpression('300 / 2')).toBe(150)
    expect(parseNumericExpression('300 * 2')).toBe(600)
    expect(parseNumericExpression('(240 + 60) / 3')).toBe(100)
  })

  it('rejects invalid numeric drafts', () => {
    expect(parseNumericExpression('board * 2')).toBeUndefined()
    expect(parseNumericExpression('')).toBeUndefined()
    expect(parseNumericExpression('10 / 0')).toBeUndefined()
  })
})
