export type Id = string
export type PlayerId = string
export type MetaValue = string | number | boolean

export interface Transform2D {
  x: number
  y: number
  rotation: number
}

export interface SpriteSpec {
  kind: 'image-url' | 'label'
  url?: string
  label?: string
  bg?: string
  fg?: string
  fit?: 'cover' | 'contain'
  crop?: {
    x: number
    y: number
    width: number
    height: number
  }
}

export interface Player {
  id: PlayerId
  name: string
  joinedAt: number
}

export interface GameObjectBase {
  id: Id
  type: 'plane' | 'deck' | 'card'
  name: string
  parentId: Id | null
  locked: boolean
  meta: Record<string, MetaValue>
}

export interface Plane extends GameObjectBase {
  type: 'plane'
  childTransforms: Record<Id, Transform2D>
  childOrder: Id[]
}

export interface Deck extends GameObjectBase {
  type: 'deck'
  size: {
    width: number
    height: number
  }
  childIds: Id[]
}

export interface Card extends GameObjectBase {
  type: 'card'
  size: {
    width: number
    height: number
  }
  face: SpriteSpec
  back: SpriteSpec
  visibility: true | PlayerId[]
}

export type GameObject = Plane | Deck | Card

export interface RoomDoc {
  version: 1
  rootId: 'root'
  objects: Record<Id, GameObject>
  players: Record<PlayerId, Player>
  playerOrder: PlayerId[]
  turnPlayerId?: PlayerId
  sourceTemplateId?: string
}

export interface CameraState {
  centerX: number
  centerY: number
  zoom: number
}

export interface RoomHistoryEntry {
  roomUrl: string
  title: string
  lastOpenedAt: number
  lastKnownTurnPlayerId?: PlayerId
  lastKnownPlayerName?: string
}

export interface RoomTemplateEntry {
  id: string
  title: string
  savedAt: number
  room: RoomDoc
}

export const DEFAULT_CARD_SIZE = {
  width: 120,
  height: 168,
} as const

export const BOARD_WORLD_SIZE = 5000
