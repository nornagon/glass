export type BoardSize = {
  width: number
  height: number
}

export const MIN_BOARD_DIMENSION = 16
const NUMERIC_EXPRESSION_PATTERN = /^[\d+\-*/().\s]+$/

function isPositiveFiniteNumber(value: number) {
  return Number.isFinite(value) && value > 0
}

export function boardSizeFromDimensions(
  width: number,
  height: number,
  minimumDimension = MIN_BOARD_DIMENSION,
): BoardSize {
  const safeMinimumDimension = isPositiveFiniteNumber(minimumDimension) ? minimumDimension : MIN_BOARD_DIMENSION
  const safeWidth = isPositiveFiniteNumber(width) ? width : safeMinimumDimension
  const safeHeight = isPositiveFiniteNumber(height) ? height : safeMinimumDimension
  const minimumScale = Math.max(
    safeMinimumDimension / safeWidth,
    safeMinimumDimension / safeHeight,
    1,
  )

  return {
    width: Math.max(safeMinimumDimension, Math.round(safeWidth * minimumScale)),
    height: Math.max(safeMinimumDimension, Math.round(safeHeight * minimumScale)),
  }
}

export function boardSizeFromWidth(width: number, aspectRatio: number): BoardSize {
  const safeWidth = isPositiveFiniteNumber(width) ? width : MIN_BOARD_DIMENSION
  const safeAspectRatio = isPositiveFiniteNumber(aspectRatio) ? aspectRatio : 1
  return boardSizeFromDimensions(safeWidth, safeWidth / safeAspectRatio)
}

export function boardSizeFromHeight(height: number, aspectRatio: number): BoardSize {
  const safeHeight = isPositiveFiniteNumber(height) ? height : MIN_BOARD_DIMENSION
  const safeAspectRatio = isPositiveFiniteNumber(aspectRatio) ? aspectRatio : 1
  return boardSizeFromDimensions(safeHeight * safeAspectRatio, safeHeight)
}

export function parseNumericExpression(value: string) {
  const trimmedValue = value.trim()
  if (!trimmedValue || !NUMERIC_EXPRESSION_PATTERN.test(trimmedValue)) {
    return undefined
  }

  try {
    const evaluatedValue = Function(`"use strict"; return (${trimmedValue})`)()
    return typeof evaluatedValue === 'number' && Number.isFinite(evaluatedValue) ? evaluatedValue : undefined
  } catch {
    return undefined
  }
}
