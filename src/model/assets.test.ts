import { describe, expect, it } from 'vitest'
import type { AutomergeUrl } from '@automerge/react'
import { createBoardOnPlane, createCardOnPlane, createRoomDoc } from './room'
import { collectRoomImageAssetUrls, resolveImageSource, type ResolvedImageAsset } from './assets'

const FACE_ASSET_URL = 'automerge:4NMNnkMhL8jXrdJ9jamS58PAVdXu' as AutomergeUrl
const BACK_ASSET_URL = 'automerge:uKK1dJ4vE3E6r27kz5bsFaCykvM' as AutomergeUrl

describe('image assets', () => {
  it('collects only Automerge-backed image URLs from the room and extra sources', () => {
    const room = createRoomDoc()
    const cardId = createCardOnPlane(room, room.rootId, { x: 0, y: 0, rotation: 0 }, 'Card')
    const boardId = createBoardOnPlane(room, room.rootId, { x: 0, y: 0, rotation: 0 }, 'Board')

    expect(room.objects[cardId].type).toBe('card')
    expect(room.objects[boardId].type).toBe('board')

    if (room.objects[cardId].type === 'card') {
      room.objects[cardId].face = {
        kind: 'image-url',
        url: FACE_ASSET_URL,
      }
      room.objects[cardId].back = {
        kind: 'image-url',
        url: 'https://example.com/card-back.png',
      }
    }

    if (room.objects[boardId].type === 'board') {
      room.objects[boardId].face = {
        kind: 'image-url',
        url: BACK_ASSET_URL,
      }
    }

    expect(
      collectRoomImageAssetUrls(room, [
        FACE_ASSET_URL,
        'https://example.com/ignored.png',
      ]),
    ).toEqual([FACE_ASSET_URL, BACK_ASSET_URL])
  })

  it('resolves stored Automerge image sources to their local render URLs', () => {
    const imageAssets = new Map<AutomergeUrl, ResolvedImageAsset>([
      [FACE_ASSET_URL, {
        url: FACE_ASSET_URL,
        objectUrl: 'blob:face-preview',
        signature: 'face-signature',
        name: 'face.png',
        mimeType: 'image/png',
        sizeBytes: 1024,
        width: 320,
        height: 200,
      }],
    ])

    expect(resolveImageSource(FACE_ASSET_URL, imageAssets)).toMatchObject({
      isStored: true,
      renderUrl: 'blob:face-preview',
      signature: `${FACE_ASSET_URL}:face-signature`,
    })

    expect(resolveImageSource('https://example.com/card.png', imageAssets)).toEqual({
      isStored: false,
      renderUrl: 'https://example.com/card.png',
      signature: 'https://example.com/card.png',
    })
  })
})
