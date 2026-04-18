import { describe, expect, it } from 'vitest'
import {
  addCardToDeck,
  canSeeCardFace,
  createBoardOnPlane,
  createCardOnPlane,
  createDeckOnPlane,
  createDeckFromSpriteSheetOnPlane,
  createRoomDoc,
  drawFromDeck,
  duplicateObject,
  getRootPlane,
  isGroupSelectableObject,
  moveObject,
  removePlayer,
  renameOrAddPlayer,
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

    expect(isGroupSelectableObject(room.objects[boardId])).toBe(true)
    expect(isGroupSelectableObject(room.objects[cardId])).toBe(true)
    expect(isGroupSelectableObject(room.objects[deckId])).toBe(true)
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
