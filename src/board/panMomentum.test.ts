import { describe, expect, it } from 'vitest'
import { releasePanVelocity } from './panMomentum'

describe('releasePanVelocity', () => {
  it('drops momentum after the pointer sits still before release', () => {
    expect(releasePanVelocity(
      [
        { point: { x: 0, y: 0 }, time: 0 },
        { point: { x: 100, y: 0 }, time: 0.05 },
      ],
      { x: 100, y: 0 },
      0.2,
      0.12,
    )).toEqual({ x: 0, y: 0 })
  })

  it('keeps fling velocity when release happens immediately after movement', () => {
    expect(releasePanVelocity(
      [
        { point: { x: 0, y: 0 }, time: 0 },
        { point: { x: 100, y: 0 }, time: 0.05 },
      ],
      { x: 110, y: 0 },
      0.06,
      0.12,
    )).toEqual({ x: 1833.3333333333335, y: 0 })
  })
})
