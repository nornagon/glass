export type BoardSize = {
  width: number
  height: number
}

export const MIN_BOARD_DIMENSION = 48
const NUMERIC_EXPRESSION_PATTERN = /^[\d+\-*/().\s]+$/

function isPositiveFiniteNumber(value: number) {
  return Number.isFinite(value) && value > 0
}

function finalizeLockedBoardSize(width: number, height: number): BoardSize {
  const safeWidth = isPositiveFiniteNumber(width) ? width : MIN_BOARD_DIMENSION
  const safeHeight = isPositiveFiniteNumber(height) ? height : MIN_BOARD_DIMENSION
  const minimumScale = Math.max(
    MIN_BOARD_DIMENSION / safeWidth,
    MIN_BOARD_DIMENSION / safeHeight,
    1,
  )

  return {
    width: Math.max(MIN_BOARD_DIMENSION, Math.round(safeWidth * minimumScale)),
    height: Math.max(MIN_BOARD_DIMENSION, Math.round(safeHeight * minimumScale)),
  }
}

export function boardSizeFromWidth(width: number, aspectRatio: number): BoardSize {
  const safeWidth = isPositiveFiniteNumber(width) ? width : MIN_BOARD_DIMENSION
  const safeAspectRatio = isPositiveFiniteNumber(aspectRatio) ? aspectRatio : 1
  return finalizeLockedBoardSize(safeWidth, safeWidth / safeAspectRatio)
}

export function boardSizeFromHeight(height: number, aspectRatio: number): BoardSize {
  const safeHeight = isPositiveFiniteNumber(height) ? height : MIN_BOARD_DIMENSION
  const safeAspectRatio = isPositiveFiniteNumber(aspectRatio) ? aspectRatio : 1
  return finalizeLockedBoardSize(safeHeight * safeAspectRatio, safeHeight)
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
