import type { Id, Transform2D } from './types'

export interface DragPreviewMessage {
  kind: 'drag-preview'
  clientId: string
  objectId: Id
  transform: Transform2D
}

export interface DragPreviewEndMessage {
  kind: 'drag-preview-end'
  clientId: string
  objectId: Id
}

export type RoomEphemeralMessage = DragPreviewMessage | DragPreviewEndMessage

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isTransform2D(value: unknown): value is Transform2D {
  if (!value || typeof value !== 'object') {
    return false
  }

  const candidate = value as Partial<Transform2D>
  return (
    isFiniteNumber(candidate.x) &&
    isFiniteNumber(candidate.y) &&
    isFiniteNumber(candidate.rotation)
  )
}

export function isRoomEphemeralMessage(value: unknown): value is RoomEphemeralMessage {
  if (!value || typeof value !== 'object') {
    return false
  }

  const candidate = value as Partial<RoomEphemeralMessage>
  if (
    (candidate.kind === 'drag-preview' || candidate.kind === 'drag-preview-end') &&
    typeof candidate.clientId === 'string' &&
    typeof candidate.objectId === 'string'
  ) {
    if (candidate.kind === 'drag-preview-end') {
      return true
    }
    return isTransform2D((candidate as Partial<DragPreviewMessage>).transform)
  }

  return false
}
