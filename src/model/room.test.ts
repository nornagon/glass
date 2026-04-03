import { describe, expect, it } from 'vitest'
import {
  addCardToDeck,
  createCardOnPlane,
  createDeckOnPlane,
  createRoomDoc,
  drawFromDeck,
  duplicateObject,
  getRootPlane,
  moveObject,
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
})
