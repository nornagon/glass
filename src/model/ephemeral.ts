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
  transform?: Transform2D
}

export type RoomEphemeralMessage = DragPreviewMessage | DragPreviewEndMessage

export interface RemoteDragSession {
  clientId: string
  objectId: Id
  transform: Transform2D
  updatedAt: number
  ending: boolean
}

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
      return candidate.transform === undefined || isTransform2D((candidate as Partial<DragPreviewEndMessage>).transform)
    }
    return isTransform2D((candidate as Partial<DragPreviewMessage>).transform)
  }

  return false
}

export function roomEphemeralSessionKey(clientId: string, objectId: Id) {
  return `${clientId}:${objectId}`
}

export function applyRoomEphemeralMessage(
  sessions: Map<string, RemoteDragSession>,
  message: RoomEphemeralMessage,
  updatedAt: number,
) {
  const sessionKey = roomEphemeralSessionKey(message.clientId, message.objectId)

  if (message.kind === 'drag-preview') {
    sessions.set(sessionKey, {
      clientId: message.clientId,
      objectId: message.objectId,
      transform: message.transform,
      updatedAt,
      ending: false,
    })
    return { sessionKey, changed: true }
  }

  const existing = sessions.get(sessionKey)
  if (!existing && message.transform === undefined) {
    return { sessionKey, changed: false }
  }

  sessions.set(sessionKey, {
    clientId: message.clientId,
    objectId: message.objectId,
    transform: message.transform ?? existing!.transform,
    updatedAt,
    ending: true,
  })
  return { sessionKey, changed: true }
}
