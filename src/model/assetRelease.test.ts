import type { AutomergeUrl } from '@automerge/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { findMock, removeFromCacheMock, loadCachedResourceDocMock, saveCachedResourceDocMock } = vi.hoisted(() => ({
  findMock: vi.fn(),
  removeFromCacheMock: vi.fn(),
  loadCachedResourceDocMock: vi.fn(),
  saveCachedResourceDocMock: vi.fn(),
}))

vi.mock('./resourceCache', () => ({
  loadCachedResourceDoc: loadCachedResourceDocMock,
  saveCachedResourceDoc: saveCachedResourceDocMock,
}))

vi.mock('./repo', () => ({
  resourceRepo: {
    findWithProgress: findMock,
    removeFromCache: removeFromCacheMock,
  },
}))

import { loadStoredImageAsset, type ImageAssetDoc } from './assets'
import { loadStoredPdfAsset, type PdfAssetDoc } from './pdfAssets'

const IMAGE_ASSET_URL = 'automerge:4NMNnkMhL8jXrdJ9jamS58PAVdXu' as AutomergeUrl
const PDF_ASSET_URL = 'automerge:uKK1dJ4vE3E6r27kz5bsFaCykvM' as AutomergeUrl

describe('stored asset loading', () => {
  beforeEach(() => {
    findMock.mockReset()
    removeFromCacheMock.mockReset()
    removeFromCacheMock.mockResolvedValue(undefined)
    loadCachedResourceDocMock.mockReset()
    saveCachedResourceDocMock.mockReset()
    loadCachedResourceDocMock.mockResolvedValue(undefined)
    saveCachedResourceDocMock.mockResolvedValue(undefined)
  })

  it('copies image asset data, caches it, and removes the repo handle from cache after reading it', async () => {
    const imageDoc: ImageAssetDoc = {
      version: 1,
      kind: 'image',
      name: 'card-face.png',
      mimeType: 'image/png',
      bytes: new Uint8Array([1, 2, 3, 4]),
      sizeBytes: 4,
      contentHash: 'image-hash',
      width: 100,
      height: 80,
      createdAt: 1,
    }
    const documentId = 'image-doc-id'

    findMock.mockReturnValueOnce({
      handle: {
        doc: () => imageDoc,
        documentId,
        isUnloaded: () => false,
        isReady: () => true,
        isUnavailable: () => false,
      },
    })

    const loadedAsset = await loadStoredImageAsset(IMAGE_ASSET_URL)

    expect(loadCachedResourceDocMock).toHaveBeenCalledWith(IMAGE_ASSET_URL)
    expect(findMock).toHaveBeenCalledWith(IMAGE_ASSET_URL)
    expect(saveCachedResourceDocMock).toHaveBeenCalledWith(IMAGE_ASSET_URL, imageDoc)
    expect(removeFromCacheMock).toHaveBeenCalledWith(documentId)
    expect(loadedAsset).toEqual(imageDoc)
    expect(loadedAsset?.bytes).not.toBe(imageDoc.bytes)
  })

  it('returns cached image asset data without touching automerge', async () => {
    const imageDoc: ImageAssetDoc = {
      version: 1,
      kind: 'image',
      name: 'cached-face.png',
      mimeType: 'image/png',
      bytes: new Uint8Array([9, 8, 7, 6]),
      sizeBytes: 4,
      contentHash: 'cached-image-hash',
      width: 32,
      height: 24,
      createdAt: 1,
    }

    loadCachedResourceDocMock.mockResolvedValueOnce(imageDoc)

    const loadedAsset = await loadStoredImageAsset(IMAGE_ASSET_URL)

    expect(loadCachedResourceDocMock).toHaveBeenCalledWith(IMAGE_ASSET_URL)
    expect(findMock).not.toHaveBeenCalled()
    expect(saveCachedResourceDocMock).not.toHaveBeenCalled()
    expect(removeFromCacheMock).not.toHaveBeenCalled()
    expect(loadedAsset).toEqual(imageDoc)
    expect(loadedAsset?.bytes).not.toBe(imageDoc.bytes)
  })

  it('copies pdf asset data, caches it, and removes the repo handle from cache after reading it', async () => {
    const pdfDoc: PdfAssetDoc = {
      version: 1,
      kind: 'pdf',
      name: 'rules.pdf',
      mimeType: 'application/pdf',
      bytes: new Uint8Array([5, 6, 7, 8]),
      sizeBytes: 4,
      contentHash: 'pdf-hash',
      createdAt: 1,
    }
    const documentId = 'pdf-doc-id'

    findMock.mockReturnValueOnce({
      handle: {
        doc: () => pdfDoc,
        documentId,
        isUnloaded: () => false,
        isReady: () => true,
        isUnavailable: () => false,
      },
    })

    const loadedAsset = await loadStoredPdfAsset(PDF_ASSET_URL)

    expect(loadCachedResourceDocMock).toHaveBeenCalledWith(PDF_ASSET_URL)
    expect(findMock).toHaveBeenCalledWith(PDF_ASSET_URL)
    expect(saveCachedResourceDocMock).toHaveBeenCalledWith(PDF_ASSET_URL, pdfDoc)
    expect(removeFromCacheMock).toHaveBeenCalledWith(documentId)
    expect(loadedAsset).toEqual(pdfDoc)
    expect(loadedAsset?.bytes).not.toBe(pdfDoc.bytes)
  })
})
