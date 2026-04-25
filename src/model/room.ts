import type { Board, Book, Card, Deck, Die, GameObject, Id, Plane, PlayerId, Pool, RoomDoc, SpriteSpec, Transform2D } from './types'
import { DEFAULT_BOARD_SIZE, DEFAULT_CARD_SIZE, DEFAULT_DIE_SIZE } from './types'

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

const DEFAULT_BOARD_FACE: SpriteSpec = {
  kind: 'label',
  label: 'Board',
  bg: '#d8d2c1',
  fg: '#20262b',
}

const DEFAULT_BOARD_BACK: SpriteSpec = {
  kind: 'label',
  label: 'Board Back',
  bg: '#796f5f',
  fg: '#fff6eb',
}

const DEFAULT_POOL_FACE: SpriteSpec = {
  kind: 'label',
  label: 'Board',
  bg: '#d8d2c1',
  fg: '#20262b',
}

const DEFAULT_POOL_BACK: SpriteSpec = {
  kind: 'label',
  label: 'Board Back',
  bg: '#796f5f',
  fg: '#fff6eb',
}

const DEFAULT_DIE_FACE_COLORS = [
  { bg: '#fff8e8', fg: '#20262b' },
  { bg: '#f1f7ff', fg: '#1e3650' },
  { bg: '#eef8ee', fg: '#224227' },
  { bg: '#fff1f1', fg: '#612626' },
  { bg: '#f7f0ff', fg: '#3b285f' },
  { bg: '#fff7e8', fg: '#5a3a12' },
] as const

const DEFAULT_BOOK_SIZE = {
  width: 240,
  height: 320,
} as const

function poolContainerSize(tokenSize: { width: number; height: number }) {
  const tokenMax = Math.max(tokenSize.width, tokenSize.height)
  const diameter = Math.max(64, Math.round(tokenMax * 2.5))
  return {
    width: diameter,
    height: diameter,
  }
}

function finitePoolRemainingTokens(pool: Pool) {
  const candidate = (pool as Partial<Pool>).remainingTokens
  if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate < 0) {
    return undefined
  }

  return Math.floor(candidate)
}

export function getPoolTokenSize(pool: Pool) {
  const candidate = (pool as Partial<Pool>).tokenSize
  if (
    candidate &&
    typeof candidate.width === 'number' &&
    Number.isFinite(candidate.width) &&
    candidate.width > 0 &&
    typeof candidate.height === 'number' &&
    Number.isFinite(candidate.height) &&
    candidate.height > 0
  ) {
    return candidate
  }

  // Legacy pools stored the token footprint directly in `size`.
  return pool.size
}

export function getPoolDisplaySize(pool: Pool) {
  const candidate = (pool as Partial<Pool>).tokenSize
  if (
    candidate &&
    typeof candidate.width === 'number' &&
    Number.isFinite(candidate.width) &&
    candidate.width > 0 &&
    typeof candidate.height === 'number' &&
    Number.isFinite(candidate.height) &&
    candidate.height > 0
  ) {
    return pool.size
  }

  // Legacy pools stored token size in `size`, so render them with a derived
  // container size even before the document is migrated.
  return poolContainerSize(pool.size)
}

export function getPoolRemainingTokens(pool: Pool) {
  return finitePoolRemainingTokens(pool) ?? Number.POSITIVE_INFINITY
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

export function isBoard(object: GameObject | undefined): object is Board {
  return object?.type === 'board'
}

export function isPool(object: GameObject | undefined): object is Pool {
  return object?.type === 'pool'
}

export function isBook(object: GameObject | undefined): object is Book {
  return object?.type === 'book'
}

export function isDie(object: GameObject | undefined): object is Die {
  return object?.type === 'die'
}

export function isGroupSelectableObject(object: GameObject | undefined): object is Card | Deck | Board | Pool | Book | Die {
  return isCard(object) || isDeck(object) || isBoard(object) || isPool(object) || isBook(object) || isDie(object)
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
    size: { ...DEFAULT_CARD_SIZE },
    childIds: [],
  }
}

export function createBoard(name = 'Board'): Board {
  return {
    id: createObjectId('board'),
    type: 'board',
    name,
    parentId: null,
    locked: true,
    meta: {
      faceUp: true,
    },
    size: { ...DEFAULT_BOARD_SIZE },
    face: { ...DEFAULT_BOARD_FACE, label: name },
    back: { ...DEFAULT_BOARD_BACK },
  }
}

export function createPool(name = 'Board'): Pool {
  const tokenSize = { ...DEFAULT_BOARD_SIZE }
  return {
    id: createObjectId('pool'),
    type: 'pool',
    name,
    parentId: null,
    locked: false,
    meta: {
      faceUp: true,
    },
    size: poolContainerSize(tokenSize),
    tokenSize,
    face: { ...DEFAULT_POOL_FACE, label: name },
    back: { ...DEFAULT_POOL_BACK },
  }
}

export function createBook(name = 'Book'): Book {
  return {
    id: createObjectId('book'),
    type: 'book',
    name,
    parentId: null,
    locked: true,
    meta: {
      aspectRatio: DEFAULT_BOOK_SIZE.width / DEFAULT_BOOK_SIZE.height,
    },
    size: { ...DEFAULT_BOOK_SIZE },
    pdfUrl: '',
    currentPage: 1,
    pageCount: 1,
  }
}

function defaultDieFaces(count = 6): SpriteSpec[] {
  return Array.from({ length: Math.max(1, count) }, (_, index) => {
    const palette = DEFAULT_DIE_FACE_COLORS[index % DEFAULT_DIE_FACE_COLORS.length]
    return {
      kind: 'label',
      label: String(index + 1),
      bg: palette.bg,
      fg: palette.fg,
    }
  })
}

export function createDie(name = 'Die'): Die {
  return {
    id: createObjectId('die'),
    type: 'die',
    name,
    parentId: null,
    locked: false,
    meta: {},
    size: { ...DEFAULT_DIE_SIZE },
    faces: defaultDieFaces(),
    currentFace: 0,
    rollVersion: 0,
  }
}

export function convertBoardToPool(room: RoomDoc, boardId: Id) {
  const board = room.objects[boardId]
  if (!isBoard(board)) {
    return undefined
  }

  const pool: Pool = {
    id: board.id,
    type: 'pool',
    name: board.name,
    parentId: board.parentId,
    locked: board.locked,
    meta: { ...board.meta },
    size: poolContainerSize(board.size),
    tokenSize: { ...board.size },
    face: cloneSpriteSpec(board.face),
    back: cloneSpriteSpec(board.back),
  }
  room.objects[boardId] = pool
  return boardId
}

function setDeckSizeFromCard(deck: Deck, card: Card) {
  deck.size = { ...card.size }
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

function moveKnownDeckCardToPlane(card: Card, plane: Plane, transform: Transform2D) {
  card.parentId = plane.id
  plane.childTransforms[card.id] = transform
  plane.childOrder.push(card.id)
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

  const shouldAdoptCardSize = deck.childIds.length === 0

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

  if (shouldAdoptCardSize) {
    setDeckSizeFromCard(deck, card)
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

  const shouldAdoptSourceSize = targetDeck.childIds.length === 0 && sourceDeck.childIds.length > 0

  for (const cardId of sourceDeck.childIds) {
    const card = room.objects[cardId]
    if (!isCard(card)) {
      continue
    }
    card.parentId = targetDeck.id
    targetDeck.childIds.push(card.id)
  }

  if (shouldAdoptSourceSize) {
    targetDeck.size = { ...sourceDeck.size }
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

export function createBoardOnPlane(room: RoomDoc, planeId: Id, transform: Transform2D, name?: string) {
  const board = createBoard(name)
  room.objects[board.id] = board
  placeObjectOnPlane(room, board.id, planeId, transform)
  return board.id
}

export function createPoolOnPlane(room: RoomDoc, planeId: Id, transform: Transform2D, name?: string) {
  const pool = createPool(name)
  room.objects[pool.id] = pool
  placeObjectOnPlane(room, pool.id, planeId, transform)
  return pool.id
}

export function createBookOnPlane(room: RoomDoc, planeId: Id, transform: Transform2D, name?: string) {
  const book = createBook(name)
  room.objects[book.id] = book
  placeObjectOnPlane(room, book.id, planeId, transform)
  return book.id
}

export function createDieOnPlane(room: RoomDoc, planeId: Id, transform: Transform2D, name?: string) {
  const die = createDie(name)
  room.objects[die.id] = die
  placeObjectOnPlane(room, die.id, planeId, transform)
  return die.id
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

interface DieFromSpriteSheetOptions {
  name?: string
  faces: SpriteSheetOptions
  dieSize?: {
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
    if (options.cardSize) {
      card.size = { ...options.cardSize }
    }
    card.face = spriteSpecFromSheet(options.faces, index)

    if (options.backs && backCount > 0) {
      card.back = spriteSpecFromSheet(options.backs, index % backCount)
    }

    room.objects[card.id] = card
    addCardToDeck(room, card.id, insertedDeck.id)
  }

  return deck.id
}

export function createDieFromSpriteSheetOnPlane(
  room: RoomDoc,
  planeId: Id,
  transform: Transform2D,
  options: DieFromSpriteSheetOptions,
) {
  const faceCount = normalizeSheetCount(options.faces.rows, options.faces.cols, options.faces.count)
  if (faceCount <= 0) {
    return undefined
  }

  const die = createDie(options.name?.trim() || 'Imported Die')
  if (options.dieSize) {
    die.size = { ...options.dieSize }
  }
  die.faces = Array.from({ length: faceCount }, (_, index) => spriteSpecFromSheet(options.faces, index))
  die.currentFace = 0
  die.rollVersion = 0
  room.objects[die.id] = die
  placeObjectOnPlane(room, die.id, planeId, transform)
  return die.id
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

export function bringObjectsForward(room: RoomDoc, objectIds: readonly Id[]) {
  const selectionsByParent = new Map<Id, Set<Id>>()

  for (const objectId of objectIds) {
    const object = room.objects[objectId]
    const parentId = object?.parentId
    const parent = parentId ? room.objects[parentId] : undefined
    if (parent?.type !== 'plane') {
      continue
    }

    let selectedIds = selectionsByParent.get(parent.id)
    if (!selectedIds) {
      selectedIds = new Set<Id>()
      selectionsByParent.set(parent.id, selectedIds)
    }
    selectedIds.add(objectId)
  }

  for (const [parentId, selectedIds] of selectionsByParent) {
    const parent = room.objects[parentId]
    if (parent?.type !== 'plane') {
      continue
    }

    for (let index = parent.childOrder.length - 2; index >= 0; index -= 1) {
      const currentId = parent.childOrder[index]
      const nextId = parent.childOrder[index + 1]
      if (!selectedIds.has(currentId) || selectedIds.has(nextId)) {
        continue
      }

      ;[parent.childOrder[index], parent.childOrder[index + 1]] = [nextId, currentId]
    }
  }
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

export function sendObjectsBackward(room: RoomDoc, objectIds: readonly Id[]) {
  const selectionsByParent = new Map<Id, Set<Id>>()

  for (const objectId of objectIds) {
    const object = room.objects[objectId]
    const parentId = object?.parentId
    const parent = parentId ? room.objects[parentId] : undefined
    if (parent?.type !== 'plane') {
      continue
    }

    let selectedIds = selectionsByParent.get(parent.id)
    if (!selectedIds) {
      selectedIds = new Set<Id>()
      selectionsByParent.set(parent.id, selectedIds)
    }
    selectedIds.add(objectId)
  }

  for (const [parentId, selectedIds] of selectionsByParent) {
    const parent = room.objects[parentId]
    if (parent?.type !== 'plane') {
      continue
    }

    for (let index = 1; index < parent.childOrder.length; index += 1) {
      const previousId = parent.childOrder[index - 1]
      const currentId = parent.childOrder[index]
      if (!selectedIds.has(currentId) || selectedIds.has(previousId)) {
        continue
      }

      ;[parent.childOrder[index - 1], parent.childOrder[index]] = [currentId, previousId]
    }
  }
}

export function flipCard(room: RoomDoc, cardId: Id) {
  const card = room.objects[cardId]
  if (!isCard(card)) {
    return
  }
  card.meta.faceUp = card.meta.faceUp === false
}

export function flipBoard(room: RoomDoc, boardId: Id) {
  const board = room.objects[boardId]
  if (!isBoard(board)) {
    return
  }
  board.meta.faceUp = board.meta.faceUp === false
}

export function flipPool(room: RoomDoc, poolId: Id) {
  const pool = room.objects[poolId]
  if (!isPool(pool)) {
    return
  }
  pool.meta.faceUp = pool.meta.faceUp === false
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

export function isBoardFaceUp(board: Board) {
  return board.meta.faceUp !== false
}

export function isPoolFaceUp(pool: Pool) {
  return pool.meta.faceUp !== false
}

export function getDieFaceCount(die: Die) {
  return Math.max(1, die.faces.length)
}

export function getDieCurrentFaceIndex(die: Die) {
  return Math.max(0, Math.min(Math.floor(die.currentFace), getDieFaceCount(die) - 1))
}

export function getDieCurrentFace(die: Die) {
  return die.faces[getDieCurrentFaceIndex(die)] ?? defaultDieFaces(1)[0]
}

export function rollDie(room: RoomDoc, dieId: Id, random = Math.random) {
  const die = room.objects[dieId]
  if (!isDie(die)) {
    return undefined
  }

  const faceCount = getDieFaceCount(die)
  die.currentFace = Math.floor(random() * faceCount)
  die.rollVersion += 1
  return die.currentFace
}

function cloneSpriteSpec(spec: SpriteSpec): SpriteSpec {
  if (spec.crop) {
    return {
      ...spec,
      crop: { ...spec.crop },
    }
  }

  return { ...spec }
}

export function createBoardFromPool(room: RoomDoc, poolId: Id, transform: Transform2D) {
  const pool = room.objects[poolId]
  if (!isPool(pool) || !pool.parentId) {
    return undefined
  }

  const parent = room.objects[pool.parentId]
  if (!isPlane(parent)) {
    return undefined
  }

  const remainingTokens = getPoolRemainingTokens(pool)
  if (remainingTokens <= 0) {
    return undefined
  }

  const tokenSize = getPoolTokenSize(pool)
  const board: Board = {
    id: createObjectId('board'),
    type: 'board',
    name: pool.name,
    parentId: null,
    locked: false,
    meta: { ...pool.meta },
    size: { ...tokenSize },
    face: cloneSpriteSpec(pool.face),
    back: cloneSpriteSpec(pool.back),
  }

  room.objects[board.id] = board
  placeObjectOnPlane(room, board.id, parent.id, transform)
  if (Number.isFinite(remainingTokens)) {
    pool.remainingTokens = remainingTokens - 1
  }
  return board.id
}

export function canReturnBoardToPool(room: RoomDoc, boardId: Id, poolId: Id) {
  const board = room.objects[boardId]
  const pool = room.objects[poolId]
  return isBoard(board) && isPool(pool) && board.name === pool.name
}

export function returnBoardToPool(room: RoomDoc, boardId: Id, poolId: Id) {
  if (!canReturnBoardToPool(room, boardId, poolId)) {
    return false
  }

  const pool = room.objects[poolId]
  const remainingTokens = isPool(pool) ? getPoolRemainingTokens(pool) : Number.POSITIVE_INFINITY
  deleteObject(room, boardId)
  if (isPool(pool) && Number.isFinite(remainingTokens)) {
    pool.remainingTokens = remainingTokens + 1
  }
  return true
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
  const card = room.objects[cardId]
  if (!isCard(card)) {
    return undefined
  }

  deck.childIds.splice(deck.childIds.length - 1, 1)

  const baseTransform = parent.childTransforms[deck.id] ?? { x: 0, y: 0, rotation: 0 }
  moveKnownDeckCardToPlane(card, parent, {
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
  const card = room.objects[cardId]
  if (!isCard(card)) {
    return
  }

  deck.childIds.splice(deck.childIds.length - 1, 1)

  const baseTransform = parent.childTransforms[deck.id] ?? { x: 0, y: 0, rotation: 0 }
  moveKnownDeckCardToPlane(card, parent, {
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
    name: card.name,
    meta: { ...card.meta },
    size: { ...card.size },
    face: cloneSpriteSpec(card.face),
    back: cloneSpriteSpec(card.back),
    visibility: card.visibility === true ? true : [...card.visibility],
    parentId: null,
  }
}

function duplicateBoard(board: Board): Board {
  return {
    ...board,
    id: createObjectId('board'),
    name: board.name,
    meta: { ...board.meta },
    size: { ...board.size },
    face: cloneSpriteSpec(board.face),
    back: cloneSpriteSpec(board.back),
    parentId: null,
  }
}

function duplicatePool(pool: Pool): Pool {
  const tokenSize = getPoolTokenSize(pool)
  const remainingTokens = finitePoolRemainingTokens(pool)
  const copy: Pool = {
    ...pool,
    id: createObjectId('pool'),
    name: pool.name,
    meta: { ...pool.meta },
    size: { ...pool.size },
    tokenSize: { ...tokenSize },
    face: cloneSpriteSpec(pool.face),
    back: cloneSpriteSpec(pool.back),
    parentId: null,
  }

  if (remainingTokens === undefined) {
    delete (copy as Partial<Pool>).remainingTokens
  } else {
    copy.remainingTokens = remainingTokens
  }

  return copy
}

function duplicateBook(book: Book): Book {
  return {
    ...book,
    id: createObjectId('book'),
    name: book.name,
    meta: { ...book.meta },
    size: { ...book.size },
    parentId: null,
  }
}

function duplicateDie(die: Die): Die {
  return {
    ...die,
    id: createObjectId('die'),
    name: die.name,
    meta: { ...die.meta },
    size: { ...die.size },
    faces: die.faces.map((face) => cloneSpriteSpec(face)),
    parentId: null,
  }
}

function duplicateDeck(deck: Deck): Deck {
  return {
    ...deck,
    id: createObjectId('deck'),
    name: deck.name,
    meta: { ...deck.meta },
    size: { ...deck.size },
    childIds: [] as Id[],
    parentId: null,
  }
}

interface DuplicateObjectOptions {
  transform?: Transform2D
}

export function duplicateObject(room: RoomDoc, objectId: Id, options?: DuplicateObjectOptions) {
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
        ...(options?.transform ?? {
          ...transform,
          x: transform.x + 36,
          y: transform.y + 36,
        }),
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
        ...(options?.transform ?? {
          ...transform,
          x: transform.x + 42,
          y: transform.y + 30,
        }),
      })
    }
    return copy.id
  }

  if (object.type === 'board') {
    const copy = duplicateBoard(object)
    room.objects[copy.id] = copy
    const transform = getTransform(room, objectId)
    if (transform && object.parentId) {
      placeObjectOnPlane(room, copy.id, object.parentId, {
        ...(options?.transform ?? {
          ...transform,
          x: transform.x + 48,
          y: transform.y + 48,
        }),
      })
    }
    return copy.id
  }

  if (object.type === 'pool') {
    const copy = duplicatePool(object)
    room.objects[copy.id] = copy
    const transform = getTransform(room, objectId)
    if (transform && object.parentId) {
      placeObjectOnPlane(room, copy.id, object.parentId, {
        ...(options?.transform ?? {
          ...transform,
          x: transform.x + 48,
          y: transform.y + 48,
        }),
      })
    }
    return copy.id
  }

  if (object.type === 'book') {
    const copy = duplicateBook(object)
    room.objects[copy.id] = copy
    const transform = getTransform(room, objectId)
    if (transform && object.parentId) {
      placeObjectOnPlane(room, copy.id, object.parentId, {
        ...(options?.transform ?? {
          ...transform,
          x: transform.x + 48,
          y: transform.y + 48,
        }),
      })
    }
    return copy.id
  }

  if (object.type === 'die') {
    const copy = duplicateDie(object)
    room.objects[copy.id] = copy
    const transform = getTransform(room, objectId)
    if (transform && object.parentId) {
      placeObjectOnPlane(room, copy.id, object.parentId, {
        ...(options?.transform ?? {
          ...transform,
          x: transform.x + 36,
          y: transform.y + 36,
        }),
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

export function removePlayer(room: RoomDoc, playerId: PlayerId) {
  if (!room.players[playerId]) {
    return
  }

  const removedIndex = room.playerOrder.indexOf(playerId)
  if (removedIndex !== -1) {
    room.playerOrder.splice(removedIndex, 1)
  }
  delete room.players[playerId]

  for (const object of Object.values(room.objects)) {
    if (isCard(object) && object.visibility !== true) {
      object.visibility = object.visibility.filter((visiblePlayerId) => visiblePlayerId !== playerId)
    }
  }

  if (room.turnPlayerId === playerId) {
    if (room.playerOrder.length === 0) {
      delete room.turnPlayerId
      return
    }

    const nextIndex = removedIndex === -1 ? 0 : removedIndex % room.playerOrder.length
    room.turnPlayerId = room.playerOrder[nextIndex]
    return
  }

  if (room.turnPlayerId && !room.players[room.turnPlayerId]) {
    delete room.turnPlayerId
  }
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
