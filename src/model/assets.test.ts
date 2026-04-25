import { describe, expect, it } from 'vitest'
import type { AutomergeUrl } from '@automerge/react'
import { createBoardOnPlane, createCardOnPlane, createDieOnPlane, createPoolOnPlane, createRoomDoc } from './room'
import {
  collectRoomImageAssetUrls,
  findMatchingStoredImageAssetUrl,
  resolveImageSource,
  type ImageAssetDoc,
  type ResolvedImageAsset,
} from './assets'

const FACE_ASSET_URL = 'automerge:4NMNnkMhL8jXrdJ9jamS58PAVdXu' as AutomergeUrl
const BACK_ASSET_URL = 'automerge:uKK1dJ4vE3E6r27kz5bsFaCykvM' as AutomergeUrl
const POOL_ASSET_URL = 'automerge:4MQ2w6yyaaWT1ZfysuJhS6iCmh7t' as AutomergeUrl

describe('image assets', () => {
  it('collects only Automerge-backed image URLs from the room and extra sources', () => {
    const room = createRoomDoc()
    const cardId = createCardOnPlane(room, room.rootId, { x: 0, y: 0, rotation: 0 }, 'Card')
    const boardId = createBoardOnPlane(room, room.rootId, { x: 0, y: 0, rotation: 0 }, 'Board')
    const poolId = createPoolOnPlane(room, room.rootId, { x: 0, y: 0, rotation: 0 }, 'Board')
    const dieId = createDieOnPlane(room, room.rootId, { x: 0, y: 0, rotation: 0 }, 'D6')

    expect(room.objects[cardId].type).toBe('card')
    expect(room.objects[boardId].type).toBe('board')
    expect(room.objects[poolId].type).toBe('pool')
    expect(room.objects[dieId].type).toBe('die')

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

    if (room.objects[poolId].type === 'pool') {
      room.objects[poolId].back = {
        kind: 'image-url',
        url: POOL_ASSET_URL,
      }
    }

    if (room.objects[dieId].type === 'die') {
      room.objects[dieId].faces[0] = {
        kind: 'image-url',
        url: FACE_ASSET_URL,
      }
    }

    expect(
      collectRoomImageAssetUrls(room, [
        FACE_ASSET_URL,
        'https://example.com/ignored.png',
      ]),
    ).toEqual([FACE_ASSET_URL, BACK_ASSET_URL, POOL_ASSET_URL])
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

  it('matches an existing stored asset by content hash', async () => {
    const uploadedAsset = {
      bytes: new Uint8Array([1, 2, 3, 4]),
      sizeBytes: 4,
      contentHash: 'abc123',
    }
    const candidateAssets = new Map<string, ImageAssetDoc>([
      [FACE_ASSET_URL, {
        version: 1,
        kind: 'image',
        name: 'same-bytes-different-name.png',
        mimeType: 'image/png',
        bytes: new Uint8Array([9, 9, 9, 9]),
        sizeBytes: 4,
        contentHash: 'abc123',
        createdAt: 1,
      }],
    ])

    const matchedUrl = await findMatchingStoredImageAssetUrl(
      uploadedAsset,
      ['https://example.com/ignored.png', FACE_ASSET_URL],
      async (url) => candidateAssets.get(url),
    )

    expect(matchedUrl).toBe(FACE_ASSET_URL)
  })

  it('falls back to byte comparison for legacy assets without a stored content hash', async () => {
    const uploadedAsset = {
      bytes: new Uint8Array([5, 6, 7, 8]),
      sizeBytes: 4,
      contentHash: 'def456',
    }
    const candidateAssets = new Map<string, ImageAssetDoc>([
      [BACK_ASSET_URL, {
        version: 1,
        kind: 'image',
        name: 'legacy.png',
        mimeType: 'image/png',
        bytes: new Uint8Array([5, 6, 7, 8]),
        sizeBytes: 4,
        createdAt: 1,
      }],
    ])

    const matchedUrl = await findMatchingStoredImageAssetUrl(
      uploadedAsset,
      [BACK_ASSET_URL],
      async (url) => candidateAssets.get(url),
    )

    expect(matchedUrl).toBe(BACK_ASSET_URL)
  })
})
