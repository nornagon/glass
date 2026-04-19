import { describe, expect, it } from 'vitest'
import type { AutomergeUrl } from '@automerge/react'
import { createBookOnPlane, createRoomDoc } from './room'
import {
  collectRoomPdfAssetUrls,
  findMatchingStoredPdfAssetUrl,
  resolvePdfSource,
  type PdfAssetDoc,
  type ResolvedPdfAsset,
} from './pdfAssets'

const BOOK_ASSET_URL = 'automerge:4NMNnkMhL8jXrdJ9jamS58PAVdXu' as AutomergeUrl

describe('pdf assets', () => {
  it('collects only Automerge-backed PDF URLs from books and extras', () => {
    const room = createRoomDoc()
    const bookId = createBookOnPlane(room, room.rootId, { x: 0, y: 0, rotation: 0 }, 'Rules')

    expect(room.objects[bookId].type).toBe('book')
    if (room.objects[bookId].type === 'book') {
      room.objects[bookId].pdfUrl = BOOK_ASSET_URL
    }

    expect(
      collectRoomPdfAssetUrls(room, [
        BOOK_ASSET_URL,
        'https://example.com/ignored.pdf',
      ]),
    ).toEqual([BOOK_ASSET_URL])
  })

  it('resolves stored Automerge PDF sources to their local render URLs', () => {
    const pdfAssets = new Map<AutomergeUrl, ResolvedPdfAsset>([
      [BOOK_ASSET_URL, {
        url: BOOK_ASSET_URL,
        objectUrl: 'blob:book-preview',
        signature: 'book-signature',
        name: 'rules.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 4096,
      }],
    ])

    expect(resolvePdfSource(BOOK_ASSET_URL, pdfAssets)).toMatchObject({
      isStored: true,
      renderUrl: 'blob:book-preview',
      signature: `${BOOK_ASSET_URL}:book-signature`,
    })

    expect(resolvePdfSource('https://example.com/rules.pdf', pdfAssets)).toEqual({
      isStored: false,
      renderUrl: 'https://example.com/rules.pdf',
      signature: 'https://example.com/rules.pdf',
    })
  })

  it('matches an existing stored PDF asset by content hash', async () => {
    const uploadedAsset = {
      bytes: new Uint8Array([1, 2, 3, 4]),
      sizeBytes: 4,
      contentHash: 'abc123',
    }
    const candidateAssets = new Map<string, PdfAssetDoc>([
      [BOOK_ASSET_URL, {
        version: 1,
        kind: 'pdf',
        name: 'same.pdf',
        mimeType: 'application/pdf',
        bytes: new Uint8Array([9, 9, 9, 9]),
        sizeBytes: 4,
        contentHash: 'abc123',
        createdAt: 1,
      }],
    ])

    const matchedUrl = await findMatchingStoredPdfAssetUrl(
      uploadedAsset,
      ['https://example.com/ignored.pdf', BOOK_ASSET_URL],
      async (url) => candidateAssets.get(url),
    )

    expect(matchedUrl).toBe(BOOK_ASSET_URL)
  })
})
