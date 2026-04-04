import type { Card, Deck, GameObject, Id, Plane, PlayerId, RoomDoc, SpriteSpec, Transform2D } from './types'
import { DEFAULT_CARD_SIZE } from './types'

const DEFAULT_FACE: SpriteSpec = {
  kind: 'label',
  label: 'Card',
  bg: '#f8efe1',
  fg: '#20262b',
}

const DEFAULT_BACK: SpriteSpec = {
  kind: 'label',
  label: 'Back',
  bg: '#bb6939',
  fg: '#fff6eb',
}

function fallbackUuid() {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function randomId(prefix: string) {
  const value = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : fallbackUuid()
  return `${prefix}_${value}`
}

function randomPlayerName(index: number) {
  return `Player ${index}`
}

export function createPlayerId() {
  return randomId('player')
}

export function createObjectId(type: GameObject['type']) {
  return randomId(type)
}

export function createRoomDoc(): RoomDoc {
  const rootPlane: Plane = {
    id: 'root',
    type: 'plane',
    name: 'Table',
    parentId: null,
    locked: false,
    meta: {},
    childTransforms: {},
    childOrder: [],
  }

  return {
    version: 1,
    rootId: 'root',
    objects: {
      root: rootPlane,
    },
    players: {},
    playerOrder: [],
  }
}

export function getRootPlane(room: RoomDoc) {
  const root = room.objects[room.rootId]
  if (!root || root.type !== 'plane') {
    throw new Error('Root plane missing')
  }
  return root
}

export function getObject(room: RoomDoc, id?: Id | null) {
  return id ? room.objects[id] : undefined
}

export function isPlane(object: GameObject | undefined): object is Plane {
  return object?.type === 'plane'
}

export function isDeck(object: GameObject | undefined): object is Deck {
  return object?.type === 'deck'
}

export function isCard(object: GameObject | undefined): object is Card {
  return object?.type === 'card'
}

export function getTransform(room: RoomDoc, id: Id) {
  const object = room.objects[id]
  if (!object || !object.parentId) {
    return undefined
  }

  const parent = room.objects[object.parentId]
  return parent?.type === 'plane' ? parent.childTransforms[id] : undefined
}

export function createCard(name = 'Card'): Card {
  return {
    id: createObjectId('card'),
    type: 'card',
    name,
    parentId: null,
    locked: false,
    meta: {
      faceUp: true,
    },
    size: { ...DEFAULT_CARD_SIZE },
    face: { ...DEFAULT_FACE, label: name },
    back: { ...DEFAULT_BACK },
    visibility: true,
  }
}

export function createDeck(name = 'Deck'): Deck {
  return {
    id: createObjectId('deck'),
    type: 'deck',
    name,
    parentId: null,
    locked: false,
    meta: {},
    childIds: [],
  }
}

function addChildToPlane(
  plane: Plane,
  object: GameObject,
  transform: Transform2D,
  index?: number,
) {
  object.parentId = plane.id
  plane.childTransforms[object.id] = transform

  if (plane.childOrder.includes(object.id)) {
    plane.childOrder = plane.childOrder.filter((childId) => childId !== object.id)
  }

  if (index === undefined || index < 0 || index > plane.childOrder.length) {
    plane.childOrder.push(object.id)
  } else {
    plane.childOrder.splice(index, 0, object.id)
  }
}

function removeChildFromPlane(plane: Plane, childId: Id) {
  delete plane.childTransforms[childId]
  plane.childOrder = plane.childOrder.filter((id) => id !== childId)
}

function removeFromDeck(deck: Deck, childId: Id) {
  deck.childIds = deck.childIds.filter((id) => id !== childId)
}

export function detachObject(room: RoomDoc, objectId: Id) {
  const object = room.objects[objectId]
  if (!object?.parentId) {
    return object
  }

  const parent = room.objects[object.parentId]
  if (parent?.type === 'plane') {
    removeChildFromPlane(parent, objectId)
  } else if (parent?.type === 'deck') {
    removeFromDeck(parent, objectId)
  }

  object.parentId = null
  return object
}

export function addCardToDeck(room: RoomDoc, cardId: Id, deckId: Id, index?: number) {
  const card = room.objects[cardId]
  const deck = room.objects[deckId]
  if (!isCard(card) || !isDeck(deck)) {
    return
  }

  detachObject(room, cardId)
  card.parentId = deck.id

  if (deck.childIds.includes(card.id)) {
    deck.childIds = deck.childIds.filter((id) => id !== card.id)
  }

  if (index === undefined || index < 0 || index > deck.childIds.length) {
    deck.childIds.push(card.id)
  } else {
    deck.childIds.splice(index, 0, card.id)
  }
}

export function mergeDeckIntoDeck(room: RoomDoc, sourceDeckId: Id, targetDeckId: Id) {
  if (sourceDeckId === targetDeckId) {
    return
  }

  const sourceDeck = room.objects[sourceDeckId]
  const targetDeck = room.objects[targetDeckId]
  if (!isDeck(sourceDeck) || !isDeck(targetDeck)) {
    return
  }

  for (const cardId of sourceDeck.childIds) {
    const card = room.objects[cardId]
    if (!isCard(card)) {
      continue
    }
    card.parentId = targetDeck.id
    targetDeck.childIds.push(card.id)
  }

  sourceDeck.childIds = []
  detachObject(room, sourceDeckId)
  delete room.objects[sourceDeckId]
}

export function placeObjectOnPlane(
  room: RoomDoc,
  objectId: Id,
  planeId: Id,
  transform: Transform2D,
  index?: number,
) {
  const object = room.objects[objectId]
  const plane = room.objects[planeId]

  if (!object || !isPlane(plane)) {
    return
  }

  detachObject(room, objectId)
  addChildToPlane(plane, object, transform, index)
}

export function createCardOnPlane(room: RoomDoc, planeId: Id, transform: Transform2D, name?: string) {
  const card = createCard(name)
  room.objects[card.id] = card
  placeObjectOnPlane(room, card.id, planeId, transform)
  return card.id
}

export function createDeckOnPlane(room: RoomDoc, planeId: Id, transform: Transform2D, name?: string) {
  const deck = createDeck(name)
  room.objects[deck.id] = deck
  placeObjectOnPlane(room, deck.id, planeId, transform)
  return deck.id
}

interface SpriteSheetOptions {
  url: string
  rows: number
  cols: number
  count: number
}

interface DeckFromSpriteSheetOptions {
  name?: string
  faces: SpriteSheetOptions
  backs?: SpriteSheetOptions
  cardSize?: {
    width: number
    height: number
  }
}

function normalizeSheetCount(rows: number, cols: number, count: number) {
  const maxCount = Math.max(0, Math.floor(rows) * Math.floor(cols))
  return Math.max(0, Math.min(Math.floor(count), maxCount))
}

function spriteSpecFromSheet(sheet: SpriteSheetOptions, index: number): SpriteSpec {
  const col = index % sheet.cols
  const row = Math.floor(index / sheet.cols)

  return {
    kind: 'image-url',
    url: sheet.url,
    crop: {
      x: col / sheet.cols,
      y: row / sheet.rows,
      width: 1 / sheet.cols,
      height: 1 / sheet.rows,
    },
  }
}

export function createDeckFromSpriteSheetOnPlane(
  room: RoomDoc,
  planeId: Id,
  transform: Transform2D,
  options: DeckFromSpriteSheetOptions,
) {
  const faceCount = normalizeSheetCount(options.faces.rows, options.faces.cols, options.faces.count)
  if (faceCount <= 0) {
    return undefined
  }

  const backCount = options.backs
    ? normalizeSheetCount(options.backs.rows, options.backs.cols, options.backs.count)
    : 0

  const deck = createDeck(options.name?.trim() || 'Imported Deck')
  room.objects[deck.id] = deck
  placeObjectOnPlane(room, deck.id, planeId, transform)
  const insertedDeck = room.objects[deck.id]
  if (!isDeck(insertedDeck)) {
    return undefined
  }

  for (let index = 0; index < faceCount; index += 1) {
    const card = createCard(`Card ${index + 1}`)
    card.parentId = deck.id
    if (options.cardSize) {
      card.size = { ...options.cardSize }
    }
    card.face = spriteSpecFromSheet(options.faces, index)

    if (options.backs && backCount > 0) {
      card.back = spriteSpecFromSheet(options.backs, index % backCount)
    }

    room.objects[card.id] = card
    insertedDeck.childIds.push(card.id)
  }

  return deck.id
}

export function moveObject(room: RoomDoc, objectId: Id, transform: Partial<Transform2D>) {
  const current = getTransform(room, objectId)
  if (!current) {
    return
  }

  const next = {
    ...current,
    ...transform,
  }

  const parent = room.objects[room.objects[objectId].parentId as Id]
  if (parent?.type === 'plane') {
    parent.childTransforms[objectId] = next
  }
}

export function bringObjectForward(room: RoomDoc, objectId: Id) {
  const object = room.objects[objectId]
  const parent = object?.parentId ? room.objects[object.parentId] : undefined
  if (parent?.type !== 'plane') {
    return
  }
  const index = parent.childOrder.indexOf(objectId)
  if (index === -1 || index === parent.childOrder.length - 1) {
    return
  }
  ;[parent.childOrder[index], parent.childOrder[index + 1]] = [
    parent.childOrder[index + 1],
    parent.childOrder[index],
  ]
}

export function bringObjectToFront(room: RoomDoc, objectId: Id) {
  const object = room.objects[objectId]
  const parent = object?.parentId ? room.objects[object.parentId] : undefined
  if (parent?.type !== 'plane') {
    return
  }

  const index = parent.childOrder.indexOf(objectId)
  if (index === -1 || index === parent.childOrder.length - 1) {
    return
  }

  parent.childOrder.splice(index, 1)
  parent.childOrder.push(objectId)
}

export function sendObjectBackward(room: RoomDoc, objectId: Id) {
  const object = room.objects[objectId]
  const parent = object?.parentId ? room.objects[object.parentId] : undefined
  if (parent?.type !== 'plane') {
    return
  }
  const index = parent.childOrder.indexOf(objectId)
  if (index <= 0) {
    return
  }
  ;[parent.childOrder[index], parent.childOrder[index - 1]] = [
    parent.childOrder[index - 1],
    parent.childOrder[index],
  ]
}

export function flipCard(room: RoomDoc, cardId: Id) {
  const card = room.objects[cardId]
  if (!isCard(card)) {
    return
  }
  card.meta.faceUp = card.meta.faceUp === false
}

export function isCardFaceUp(card: Card) {
  return card.meta.faceUp !== false
}

export function canSeeCardFace(card: Card, playerId?: PlayerId) {
  if (!isCardFaceUp(card)) {
    return false
  }
  if (card.visibility === true) {
    return true
  }
  return playerId ? card.visibility.includes(playerId) : false
}

export function shuffleDeck(room: RoomDoc, deckId: Id, random = Math.random) {
  const deck = room.objects[deckId]
  if (!isDeck(deck)) {
    return
  }

  for (let index = deck.childIds.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1))
    ;[deck.childIds[index], deck.childIds[swapIndex]] = [
      deck.childIds[swapIndex],
      deck.childIds[index],
    ]
  }
}

export function flipDeck(room: RoomDoc, deckId: Id) {
  const deck = room.objects[deckId]
  if (!isDeck(deck)) {
    return
  }

  for (const cardId of deck.childIds) {
    const card = room.objects[cardId]
    if (!isCard(card)) {
      continue
    }
    card.meta.faceUp = card.meta.faceUp === false
  }
}

export function liftTopCardFromDeck(room: RoomDoc, deckId: Id) {
  const deck = room.objects[deckId]
  if (!isDeck(deck) || deck.childIds.length === 0 || !deck.parentId) {
    return undefined
  }

  const parent = room.objects[deck.parentId]
  if (!isPlane(parent)) {
    return undefined
  }

  const cardId = deck.childIds[deck.childIds.length - 1]
  deck.childIds.pop()

  const baseTransform = parent.childTransforms[deck.id] ?? { x: 0, y: 0, rotation: 0 }
  placeObjectOnPlane(room, cardId, parent.id, {
    x: baseTransform.x,
    y: baseTransform.y,
    rotation: baseTransform.rotation,
  })

  return cardId
}

export function drawFromDeck(room: RoomDoc, deckId: Id) {
  const deck = room.objects[deckId]
  if (!isDeck(deck) || deck.childIds.length === 0 || !deck.parentId) {
    return
  }

  const parent = room.objects[deck.parentId]
  if (!isPlane(parent)) {
    return
  }

  const cardId = deck.childIds[deck.childIds.length - 1]
  deck.childIds.pop()

  const baseTransform = parent.childTransforms[deck.id] ?? { x: 0, y: 0, rotation: 0 }
  placeObjectOnPlane(room, cardId, parent.id, {
    x: baseTransform.x + 140,
    y: baseTransform.y + 20,
    rotation: 0,
  })
  return cardId
}

function duplicateCard(card: Card): Card {
  return {
    ...card,
    id: createObjectId('card'),
    name: `${card.name} Copy`,
    meta: { ...card.meta },
    size: { ...card.size },
    face: { ...card.face },
    back: { ...card.back },
    visibility: card.visibility === true ? true : [...card.visibility],
    parentId: null,
  }
}

function duplicateDeck(deck: Deck): Deck {
  return {
    ...deck,
    id: createObjectId('deck'),
    name: `${deck.name} Copy`,
    meta: { ...deck.meta },
    childIds: [] as Id[],
    parentId: null,
  }
}

export function duplicateObject(room: RoomDoc, objectId: Id) {
  const object = room.objects[objectId]
  if (!object) {
    return undefined
  }

  if (object.type === 'card') {
    const copy = duplicateCard(object)
    room.objects[copy.id] = copy
    const transform = getTransform(room, objectId)
    if (transform && object.parentId) {
      placeObjectOnPlane(room, copy.id, object.parentId, {
        ...transform,
        x: transform.x + 36,
        y: transform.y + 36,
      })
    }
    return copy.id
  }

  if (object.type === 'deck') {
    const copy = duplicateDeck(object)
    room.objects[copy.id] = copy

    for (const childId of object.childIds) {
      const clonedChildId = duplicateObjectIntoDeck(room, childId, copy.id)
      if (clonedChildId) {
        copy.childIds.push(clonedChildId)
      }
    }

    const transform = getTransform(room, objectId)
    if (transform && object.parentId) {
      placeObjectOnPlane(room, copy.id, object.parentId, {
        ...transform,
        x: transform.x + 42,
        y: transform.y + 30,
      })
    }
    return copy.id
  }

  return undefined
}

function duplicateObjectIntoDeck(room: RoomDoc, objectId: Id, deckId: Id) {
  const object = room.objects[objectId]
  if (!object || object.type !== 'card') {
    return undefined
  }
  const copy = duplicateCard(object)
  room.objects[copy.id] = copy
  copy.parentId = deckId
  return copy.id
}

export function deleteObject(room: RoomDoc, objectId: Id) {
  const object = room.objects[objectId]
  if (!object || object.id === room.rootId) {
    return
  }

  if (object.type === 'deck') {
    for (const childId of [...object.childIds]) {
      deleteObject(room, childId)
    }
  }

  detachObject(room, objectId)
  delete room.objects[objectId]
}

export function renameOrAddPlayer(room: RoomDoc, playerId: PlayerId, name?: string) {
  const current = room.players[playerId]
  if (current) {
    current.name = name?.trim() || current.name
    return
  }

  const playerName = name?.trim() || randomPlayerName(room.playerOrder.length + 1)
  room.players[playerId] = {
    id: playerId,
    name: playerName,
    joinedAt: Date.now(),
  }
  room.playerOrder.push(playerId)
}

export function setTurnPlayer(room: RoomDoc, playerId?: PlayerId) {
  if (!playerId || !room.players[playerId]) {
    delete room.turnPlayerId
    return
  }
  room.turnPlayerId = playerId
}

export function advanceTurn(room: RoomDoc) {
  if (room.playerOrder.length === 0) {
    delete room.turnPlayerId
    return
  }

  if (!room.turnPlayerId) {
    room.turnPlayerId = room.playerOrder[0]
    return
  }

  const currentIndex = room.playerOrder.indexOf(room.turnPlayerId)
  const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % room.playerOrder.length
  room.turnPlayerId = room.playerOrder[nextIndex]
}

export function rootPlaneLabel(room: RoomDoc) {
  return getRootPlane(room).name || 'Untitled Table'
}

export function formatRoomTitle(room: RoomDoc) {
  const title = rootPlaneLabel(room)
  return title.trim() || 'Untitled Table'
}
