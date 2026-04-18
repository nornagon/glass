export interface AlphaPixelBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export const FULL_ALPHA_TRIM_CROP = { x: 0, y: 0, width: 1, height: 1 } as const
const ALPHA_TRIM_SAFE_PADDING_PIXELS = 1

export function computeSymmetricAlphaTrimCrop(
  rasterWidth: number,
  rasterHeight: number,
  bounds: AlphaPixelBounds | null | undefined,
) {
  if (
    !bounds ||
    rasterWidth <= 0 ||
    rasterHeight <= 0 ||
    bounds.minX < 0 ||
    bounds.minY < 0 ||
    bounds.maxX < bounds.minX ||
    bounds.maxY < bounds.minY ||
    bounds.maxX >= rasterWidth ||
    bounds.maxY >= rasterHeight
  ) {
    return FULL_ALPHA_TRIM_CROP
  }

  const leftInset = bounds.minX
  const rightInset = rasterWidth - 1 - bounds.maxX
  const topInset = bounds.minY
  const bottomInset = rasterHeight - 1 - bounds.maxY
  const trimX = Math.max(0, Math.min(leftInset, rightInset) - ALPHA_TRIM_SAFE_PADDING_PIXELS)
  const trimY = Math.max(0, Math.min(topInset, bottomInset) - ALPHA_TRIM_SAFE_PADDING_PIXELS)

  if (trimX <= 0 && trimY <= 0) {
    return FULL_ALPHA_TRIM_CROP
  }

  const trimmedWidth = rasterWidth - trimX * 2
  const trimmedHeight = rasterHeight - trimY * 2
  if (trimmedWidth <= 0 || trimmedHeight <= 0) {
    return FULL_ALPHA_TRIM_CROP
  }

  return {
    x: trimX / rasterWidth,
    y: trimY / rasterHeight,
    width: trimmedWidth / rasterWidth,
    height: trimmedHeight / rasterHeight,
  }
}
