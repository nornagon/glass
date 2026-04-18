import { describe, expect, it } from 'vitest'
import { computeSymmetricAlphaTrimCrop, FULL_ALPHA_TRIM_CROP } from './alphaTrim'

describe('computeSymmetricAlphaTrimCrop', () => {
  it('trims equal transparent borders on both axes', () => {
    expect(
      computeSymmetricAlphaTrimCrop(100, 80, {
        minX: 10,
        minY: 8,
        maxX: 89,
        maxY: 71,
      }),
    ).toEqual({
      x: 0.09,
      y: 0.0875,
      width: 0.82,
      height: 0.825,
    })
  })

  it('trims only the shared inset so the visual center stays fixed', () => {
    expect(
      computeSymmetricAlphaTrimCrop(100, 80, {
        minX: 4,
        minY: 12,
        maxX: 89,
        maxY: 73,
      }),
    ).toEqual({
      x: 0.03,
      y: 0.0625,
      width: 0.94,
      height: 0.875,
    })
  })

  it('leaves full-frame content unchanged', () => {
    expect(
      computeSymmetricAlphaTrimCrop(100, 80, {
        minX: 0,
        minY: 0,
        maxX: 99,
        maxY: 79,
      }),
    ).toBe(FULL_ALPHA_TRIM_CROP)
  })

  it('falls back when bounds are missing or invalid', () => {
    expect(computeSymmetricAlphaTrimCrop(100, 80, null)).toBe(FULL_ALPHA_TRIM_CROP)
    expect(
      computeSymmetricAlphaTrimCrop(100, 80, {
        minX: 10,
        minY: 10,
        maxX: 100,
        maxY: 70,
      }),
    ).toBe(FULL_ALPHA_TRIM_CROP)
  })
})
