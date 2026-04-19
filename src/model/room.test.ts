import { describe, expect, it } from 'vitest'
import {
  addCardToDeck,
  bringObjectsForward,
  canSeeCardFace,
  canReturnBoardToPool,
  convertBoardToPool,
  createBoardFromPool,
  createBoardOnPlane,
  createCardOnPlane,
  createDeckOnPlane,
  createDeckFromSpriteSheetOnPlane,
  createPoolOnPlane,
  createRoomDoc,
  drawFromDeck,
  duplicateObject,
  getPoolDisplaySize,
  getRootPlane,
  isGroupSelectableObject,
  moveObject,
  removePlayer,
  renameOrAddPlayer,
  sendObjectsBackward,
  returnBoardToPool,
  setTurnPlayer,
  shuffleDeck,
} from './room'

describe('room model', () => {
  it('creates and places objects on the root plane', () => {
    const room = createRoomDoc()
    const cardId = createCardOnPlane(room, room.rootId, { x: 10, y: 20, rotation: 0 })
    const deckId = createDeckOnPlane(room, room.rootId, { x: 30, y: 40, rotation: 0 })

    expect(room.objects[cardId]).toBeDefined()
    expect(room.objects[deckId]).toBeDefined()
    expect(getRootPlane(room).childOrder).toEqual([cardId, deckId])
  })

  it('treats boards as group-selectable objects', () => {
    const room = createRoomDoc()
    const boardId = createBoardOnPlane(room, room.rootId, { x: 0, y: 0, rotation: 0 }, 'Board')
    const cardId = createCardOnPlane(room, room.rootId, { x: 10, y: 20, rotation: 0 })
    const deckId = createDeckOnPlane(room, room.rootId, { x: 30, y: 40, rotation: 0 })
    const poolId = createPoolOnPlane(room, room.rootId, { x: 50, y: 60, rotation: 0 }, 'Board')

    expect(isGroupSelectableObject(room.objects[boardId])).toBe(true)
    expect(isGroupSelectableObject(room.objects[cardId])).toBe(true)
    expect(isGroupSelectableObject(room.objects[deckId])).toBe(true)
    expect(isGroupSelectableObject(room.objects[poolId])).toBe(true)
    expect(isGroupSelectableObject(room.objects[room.rootId])).toBe(false)
  })

  it('moves cards into and out of decks', () => {
    const room = createRoomDoc()
    const cardId = createCardOnPlane(room, room.rootId, { x: 10, y: 20, rotation: 0 })
    const deckId = createDeckOnPlane(room, room.rootId, { x: 30, y: 40, rotation: 0 })

    addCardToDeck(room, cardId, deckId)
    expect(room.objects[deckId].type).toBe('deck')
    expect((room.objects[deckId].type === 'deck' && room.objects[deckId].childIds) || []).toContain(cardId)

    const drawn = drawFromDeck(room, deckId)
    expect(drawn).toBe(cardId)
    expect(getRootPlane(room).childOrder).toContain(cardId)
  })

  it('adds dropped cards to the top of a deck by default', () => {
    const room = createRoomDoc()
    const deckId = createDeckOnPlane(room, room.rootId, { x: 30, y: 40, rotation: 0 })
    const cardA = createCardOnPlane(room, room.rootId, { x: 0, y: 0, rotation: 0 }, 'A')
    const cardB = createCardOnPlane(room, room.rootId, { x: 0, y: 0, rotation: 0 }, 'B')

    addCardToDeck(room, cardA, deckId)
    addCardToDeck(room, cardB, deckId)

    expect(room.objects[deckId].type).toBe('deck')
    expect(room.objects[deckId].type === 'deck' ? room.objects[deckId].childIds : []).toEqual([cardA, cardB])
    expect(drawFromDeck(room, deckId)).toBe(cardB)
    expect(drawFromDeck(room, deckId)).toBe(cardA)
  })

  it('can insert a target card onto the bottom of a dragged deck', () => {
    const room = createRoomDoc()
    const deckId = createDeckOnPlane(room, room.rootId, { x: 30, y: 40, rotation: 0 })
    const cardA = createCardOnPlane(room, room.rootId, { x: 0, y: 0, rotation: 0 }, 'A')
    const cardB = createCardOnPlane(room, room.rootId, { x: 0, y: 0, rotation: 0 }, 'B')
    const cardC = createCardOnPlane(room, room.rootId, { x: 0, y: 0, rotation: 0 }, 'C')

    addCardToDeck(room, cardA, deckId)
    addCardToDeck(room, cardB, deckId)
    addCardToDeck(room, cardC, deckId, 0)

    expect(room.objects[deckId].type).toBe('deck')
    expect(room.objects[deckId].type === 'deck' ? room.objects[deckId].childIds : []).toEqual([cardC, cardA, cardB])
    expect(drawFromDeck(room, deckId)).toBe(cardB)
    expect(drawFromDeck(room, deckId)).toBe(cardA)
    expect(drawFromDeck(room, deckId)).toBe(cardC)
  })

  it('adopts the first inserted card size for an empty deck', () => {
    const room = createRoomDoc()
    const cardId = createCardOnPlane(room, room.rootId, { x: 10, y: 20, rotation: 0 })
    const deckId = createDeckOnPlane(room, room.rootId, { x: 30, y: 40, rotation: 0 })

    expect(room.objects[cardId].type).toBe('card')
    expect(room.objects[deckId].type).toBe('deck')

    if (room.objects[cardId].type === 'card') {
      room.objects[cardId].size = { width: 200, height: 96 }
    }

    addCardToDeck(room, cardId, deckId)

    expect(room.objects[deckId].type).toBe('deck')
    expect(room.objects[deckId].type === 'deck' ? room.objects[deckId].size : undefined).toEqual({
      width: 200,
      height: 96,
    })
  })

  it('keeps deck size until a new card is added to an empty deck', () => {
    const room = createRoomDoc()
    const cardA = createCardOnPlane(room, room.rootId, { x: 0, y: 0, rotation: 0 }, 'A')
    const cardB = createCardOnPlane(room, room.rootId, { x: 0, y: 0, rotation: 0 }, 'B')
    const deckId = createDeckOnPlane(room, room.rootId, { x: 30, y: 40, rotation: 0 })

    if (room.objects[cardA].type === 'card') {
      room.objects[cardA].size = { width: 180, height: 120 }
    }
    if (room.objects[cardB].type === 'card') {
      room.objects[cardB].size = { width: 90, height: 200 }
    }

    addCardToDeck(room, cardA, deckId)
    expect(room.objects[deckId].type === 'deck' ? room.objects[deckId].size : undefined).toEqual({
      width: 180,
      height: 120,
    })

    expect(drawFromDeck(room, deckId)).toBe(cardA)
    expect(room.objects[deckId].type === 'deck' ? room.objects[deckId].size : undefined).toEqual({
      width: 180,
      height: 120,
    })

    addCardToDeck(room, cardB, deckId)
    expect(room.objects[deckId].type === 'deck' ? room.objects[deckId].size : undefined).toEqual({
      width: 90,
      height: 200,
    })
  })

  it('adopts imported card size when creating a deck from a sprite sheet', () => {
    const room = createRoomDoc()
    const deckId = createDeckFromSpriteSheetOnPlane(room, room.rootId, { x: 0, y: 0, rotation: 0 }, {
      faces: {
        url: 'https://example.com/cards.png',
        rows: 2,
        cols: 2,
        count: 4,
      },
      cardSize: {
        width: 144,
        height: 92,
      },
    })

    expect(deckId).toBeTruthy()
    const deck = room.objects[deckId!]
    expect(deck.type).toBe('deck')
    expect(deck.type === 'deck' ? deck.size : undefined).toEqual({
      width: 144,
      height: 92,
    })
  })

  it('duplicates deck contents recursively', () => {
    const room = createRoomDoc()
    const cardId = createCardOnPlane(room, room.rootId, { x: 10, y: 20, rotation: 0 })
    const deckId = createDeckOnPlane(room, room.rootId, { x: 30, y: 40, rotation: 0 })
    addCardToDeck(room, cardId, deckId)

    const copyId = duplicateObject(room, deckId)
    expect(copyId).toBeTruthy()
    expect(copyId).not.toBe(deckId)
    const copy = room.objects[copyId!]
    expect(copy).toBeDefined()
    expect(copy.type).toBe('deck')
    expect(copy.type === 'deck' ? copy.childIds.length : 0).toBe(1)
  })

  it('preserves object names when duplicating', () => {
    const room = createRoomDoc()
    const cardId = createCardOnPlane(room, room.rootId, { x: 0, y: 0, rotation: 0 }, 'Card Name')
    const deckId = createDeckOnPlane(room, room.rootId, { x: 20, y: 20, rotation: 0 }, 'Deck Name')
    const boardId = createBoardOnPlane(room, room.rootId, { x: 40, y: 40, rotation: 0 }, 'Board Name')
    const poolId = createPoolOnPlane(room, room.rootId, { x: 60, y: 60, rotation: 0 }, 'Pool Name')

    const duplicatedIds = [cardId, deckId, boardId, poolId].map((objectId) => duplicateObject(room, objectId))

    expect(duplicatedIds).toHaveLength(4)
    expect(duplicatedIds.every((objectId) => objectId)).toBe(true)
    expect(room.objects[duplicatedIds[0]!].name).toBe('Card Name')
    expect(room.objects[duplicatedIds[1]!].name).toBe('Deck Name')
    expect(room.objects[duplicatedIds[2]!].name).toBe('Board Name')
    expect(room.objects[duplicatedIds[3]!].name).toBe('Pool Name')
  })

  it('instantiates boards from pools as unlocked copies', () => {
    const room = createRoomDoc()
    const poolId = createPoolOnPlane(room, room.rootId, { x: 10, y: 20, rotation: 0 }, 'Meeple')

    expect(room.objects[poolId].type).toBe('pool')
    if (room.objects[poolId].type === 'pool') {
      room.objects[poolId].locked = true
      room.objects[poolId].tokenSize = { width: 72, height: 96 }
      room.objects[poolId].size = { width: 220, height: 220 }
      room.objects[poolId].face = {
        kind: 'label',
        label: 'Meeple',
        bg: '#2a6f4f',
        fg: '#f7f2db',
      }
    }

    const boardId = createBoardFromPool(room, poolId, { x: 90, y: 110, rotation: 0 })
    expect(boardId).toBeTruthy()

    const board = boardId ? room.objects[boardId] : undefined
    expect(board?.type).toBe('board')
    expect(board?.locked).toBe(false)
    expect(board?.name).toBe('Meeple')
    expect(board?.type === 'board' ? board.size : undefined).toEqual({ width: 72, height: 96 })
    expect(board?.type === 'board' ? board.face : undefined).toMatchObject({
      kind: 'label',
      label: 'Meeple',
      bg: '#2a6f4f',
      fg: '#f7f2db',
    })
  })

  it('falls back to legacy pool size when tokenSize is missing', () => {
    const room = createRoomDoc()
    const poolId = createPoolOnPlane(room, room.rootId, { x: 10, y: 20, rotation: 0 }, 'Legacy')

    expect(room.objects[poolId].type).toBe('pool')
    if (room.objects[poolId].type === 'pool') {
      room.objects[poolId].size = { width: 88, height: 112 }
      delete (room.objects[poolId] as { tokenSize?: { width: number; height: number } }).tokenSize
    }

    const boardId = createBoardFromPool(room, poolId, { x: 90, y: 110, rotation: 0 })
    expect(boardId).toBeTruthy()
    expect(boardId ? room.objects[boardId] : undefined).toMatchObject({
      type: 'board',
      size: { width: 88, height: 112 },
    })
    expect(room.objects[poolId].type === 'pool' ? getPoolDisplaySize(room.objects[poolId]) : undefined).toEqual({
      width: 280,
      height: 280,
    })
  })

  it('converts boards into pools in place', () => {
    const room = createRoomDoc()
    const boardId = createBoardOnPlane(room, room.rootId, { x: 40, y: 50, rotation: 0.2 }, 'Meeple')

    if (room.objects[boardId].type === 'board') {
      room.objects[boardId].size = { width: 72, height: 96 }
    }

    expect(convertBoardToPool(room, boardId)).toBe(boardId)
    expect(room.objects[boardId]?.type).toBe('pool')
    expect(room.objects[boardId]?.type === 'pool' ? room.objects[boardId].tokenSize : undefined).toEqual({
      width: 72,
      height: 96,
    })
    expect(room.objects[boardId]?.type === 'pool' ? room.objects[boardId].size : undefined).toEqual({
      width: 240,
      height: 240,
    })
    expect(getRootPlane(room).childOrder).toContain(boardId)
    expect(getRootPlane(room).childTransforms[boardId]).toMatchObject({
      x: 40,
      y: 50,
      rotation: 0.2,
    })
  })

  it('returns matching boards to pools by deleting the dropped board', () => {
    const room = createRoomDoc()
    const poolId = createPoolOnPlane(room, room.rootId, { x: 0, y: 0, rotation: 0 }, 'Token')
    const matchingBoardId = createBoardOnPlane(room, room.rootId, { x: 10, y: 0, rotation: 0 }, 'Token')
    const otherBoardId = createBoardOnPlane(room, room.rootId, { x: 20, y: 0, rotation: 0 }, 'Other')

    expect(canReturnBoardToPool(room, matchingBoardId, poolId)).toBe(true)
    expect(canReturnBoardToPool(room, otherBoardId, poolId)).toBe(false)

    expect(returnBoardToPool(room, matchingBoardId, poolId)).toBe(true)
    expect(room.objects[matchingBoardId]).toBeUndefined()
    expect(room.objects[poolId]).toBeDefined()

    expect(returnBoardToPool(room, otherBoardId, poolId)).toBe(false)
    expect(room.objects[otherBoardId]).toBeDefined()
  })

  it('moves a selected group forward together while preserving relative order', () => {
    const room = createRoomDoc()
    const cardA = createCardOnPlane(room, room.rootId, { x: 0, y: 0, rotation: 0 }, 'A')
    const cardB = createCardOnPlane(room, room.rootId, { x: 10, y: 0, rotation: 0 }, 'B')
    const cardC = createCardOnPlane(room, room.rootId, { x: 20, y: 0, rotation: 0 }, 'C')
    const cardD = createCardOnPlane(room, room.rootId, { x: 30, y: 0, rotation: 0 }, 'D')

    bringObjectsForward(room, [cardB, cardC])

    expect(getRootPlane(room).childOrder).toEqual([cardA, cardD, cardB, cardC])
  })

  it('moves a selected group backward together while preserving relative order', () => {
    const room = createRoomDoc()
    const cardA = createCardOnPlane(room, room.rootId, { x: 0, y: 0, rotation: 0 }, 'A')
    const cardB = createCardOnPlane(room, room.rootId, { x: 10, y: 0, rotation: 0 }, 'B')
    const cardC = createCardOnPlane(room, room.rootId, { x: 20, y: 0, rotation: 0 }, 'C')
    const cardD = createCardOnPlane(room, room.rootId, { x: 30, y: 0, rotation: 0 }, 'D')

    sendObjectsBackward(room, [cardB, cardC])

    expect(getRootPlane(room).childOrder).toEqual([cardB, cardC, cardA, cardD])
  })

  it('shuffles deterministically when random is injected', () => {
    const room = createRoomDoc()
    const deckId = createDeckOnPlane(room, room.rootId, { x: 30, y: 40, rotation: 0 })
    const cardA = createCardOnPlane(room, room.rootId, { x: 0, y: 0, rotation: 0 }, 'A')
    const cardB = createCardOnPlane(room, room.rootId, { x: 0, y: 0, rotation: 0 }, 'B')
    const cardC = createCardOnPlane(room, room.rootId, { x: 0, y: 0, rotation: 0 }, 'C')
    addCardToDeck(room, cardA, deckId)
    addCardToDeck(room, cardB, deckId)
    addCardToDeck(room, cardC, deckId)

    const values = [0.1, 0.4]
    shuffleDeck(room, deckId, () => values.shift() ?? 0)

    expect(room.objects[deckId].type).toBe('deck')
    expect((room.objects[deckId].type === 'deck' && room.objects[deckId].childIds) || []).toHaveLength(3)
  })

  it('updates plane transforms in place', () => {
    const room = createRoomDoc()
    const cardId = createCardOnPlane(room, room.rootId, { x: 10, y: 20, rotation: 0 })

    moveObject(room, cardId, { x: 90, rotation: 1 })

    expect(getRootPlane(room).childTransforms[cardId]).toMatchObject({
      x: 90,
      y: 20,
      rotation: 1,
    })
  })

  it('removes players from turn order and card visibility', () => {
    const room = createRoomDoc()
    const aliceId = 'player-alice'
    const bobId = 'player-bob'
    const carolId = 'player-carol'
    const cardId = createCardOnPlane(room, room.rootId, { x: 0, y: 0, rotation: 0 })

    renameOrAddPlayer(room, aliceId, 'Alice')
    renameOrAddPlayer(room, bobId, 'Bob')
    renameOrAddPlayer(room, carolId, 'Carol')
    setTurnPlayer(room, bobId)

    expect(room.objects[cardId].type).toBe('card')
    if (room.objects[cardId].type === 'card') {
      room.objects[cardId].visibility = [bobId, carolId]
    }

    removePlayer(room, bobId)

    expect(room.players[bobId]).toBeUndefined()
    expect(room.playerOrder).toEqual([aliceId, carolId])
    expect(room.turnPlayerId).toBe(carolId)
    expect(room.objects[cardId].type).toBe('card')
    expect(room.objects[cardId].type === 'card' ? canSeeCardFace(room.objects[cardId], bobId) : undefined).toBe(false)
    expect(room.objects[cardId].type === 'card' ? canSeeCardFace(room.objects[cardId], carolId) : undefined).toBe(true)
  })
})
