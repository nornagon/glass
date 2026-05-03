import { isValidAutomergeUrl, type AutomergeUrl } from '@automerge/react'
import { useEffect, useRef, useState } from 'react'
import { loadCachedResourceDoc, saveCachedResourceDoc } from './resourceCache'
import { enqueueResourceLoad, estimateStoredAssetMemoryBytes } from './resourceLoadQueue'
import { resourceRepo } from './repo'
import type { RoomDoc } from './types'

export interface PdfAssetDoc {
  version: 1
  kind: 'pdf'
  name: string
  mimeType: string
  bytes: Uint8Array
  sizeBytes: number
  contentHash?: string
  createdAt: number
}

export interface ResolvedPdfAsset {
  url: AutomergeUrl
  objectUrl: string
  signature: string
  name: string
  mimeType: string
  sizeBytes: number
  contentHash?: string
}

export interface ResolvedPdfSource {
  isStored: boolean
  renderUrl?: string
  signature: string
  asset?: ResolvedPdfAsset
}

function bytesToArrayBuffer(bytes: Uint8Array) {
  if (bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer
  }

  return bytes.slice().buffer
}

function blobPartFromBytes(bytes: Uint8Array) {
  return bytesToArrayBuffer(bytes)
}

function clonePdfAssetDoc(assetDoc: PdfAssetDoc): PdfAssetDoc {
  return {
    ...assetDoc,
    bytes: Uint8Array.from(assetDoc.bytes),
  }
}

function isFinitePositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

async function sha256Hex(bytes: Uint8Array) {
  if (!globalThis.crypto?.subtle) {
    return undefined
  }

  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytesToArrayBuffer(bytes))
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
}

function sameBytes(left: Uint8Array, right: Uint8Array) {
  if (left.byteLength !== right.byteLength) {
    return false
  }

  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) {
      return false
    }
  }

  return true
}

function isPdfFile(file: File) {
  return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
}

export function isPdfAssetDoc(value: unknown): value is PdfAssetDoc {
  if (!value || typeof value !== 'object') {
    return false
  }

  const doc = value as Partial<PdfAssetDoc>
  return (
    doc.version === 1 &&
    doc.kind === 'pdf' &&
    typeof doc.name === 'string' &&
    typeof doc.mimeType === 'string' &&
    doc.bytes instanceof Uint8Array &&
    isFinitePositiveNumber(doc.sizeBytes) &&
    typeof doc.createdAt === 'number'
  )
}

export function asAutomergeUrl(value: string | undefined) {
  return value && isValidAutomergeUrl(value) ? (value as AutomergeUrl) : undefined
}

export function collectAutomergeUrls(values: Array<string | undefined>) {
  return [...new Set(values.map(asAutomergeUrl).filter((value): value is AutomergeUrl => Boolean(value)))]
}

function collectAutomergeUrlState(values: Array<string | undefined>) {
  const assetUrls = collectAutomergeUrls(values)
  return {
    key: assetUrls.join('\0'),
    assetUrls,
  }
}

export function collectRoomPdfAssetUrls(room: RoomDoc, extraUrls: Array<string | undefined> = []) {
  const candidates = [...extraUrls]

  for (const object of Object.values(room.objects)) {
    if (object.type === 'book') {
      candidates.push(object.pdfUrl)
    }
  }

  return collectAutomergeUrls(candidates)
}

export function resolvePdfSource(
  rawUrl: string | undefined,
  pdfAssets: ReadonlyMap<AutomergeUrl, ResolvedPdfAsset>,
): ResolvedPdfSource | undefined {
  if (!rawUrl) {
    return undefined
  }

  const assetUrl = asAutomergeUrl(rawUrl)
  if (!assetUrl) {
    return {
      isStored: false,
      renderUrl: rawUrl,
      signature: rawUrl,
    }
  }

  const asset = pdfAssets.get(assetUrl)
  return {
    isStored: true,
    renderUrl: asset?.objectUrl,
    signature: asset ? `${assetUrl}:${asset.signature}` : `${assetUrl}:pending`,
    asset,
  }
}

export async function buildPdfAssetDoc(file: File): Promise<PdfAssetDoc> {
  if (!isPdfFile(file)) {
    throw new Error('Not a PDF file')
  }

  const bytes = new Uint8Array(await file.arrayBuffer())
  const contentHash = await sha256Hex(bytes)

  return {
    version: 1,
    kind: 'pdf',
    name: file.name || 'Uploaded PDF',
    mimeType: file.type || 'application/pdf',
    bytes,
    sizeBytes: bytes.byteLength,
    contentHash,
    createdAt: Date.now(),
  }
}

async function loadStoredPdfAssetNow(url: string) {
  const assetUrl = asAutomergeUrl(url)
  if (!assetUrl) {
    return undefined
  }

  const cachedAsset = await loadCachedResourceDoc(assetUrl)
  if (cachedAsset && isPdfAssetDoc(cachedAsset)) {
    return clonePdfAssetDoc(cachedAsset)
  }

  const progress = resourceRepo.findWithProgress<PdfAssetDoc>(assetUrl)
  const handle = progress.handle
  try {
    if (!handle.isReady() && !handle.isUnavailable()) {
      if ('untilReady' in progress) {
        await progress.untilReady(['ready', 'unavailable'])
      } else {
        await handle.whenReady(['ready', 'unavailable'])
      }
    }

    if (!handle.isReady()) {
      return undefined
    }

    const doc = handle.doc()
    if (!isPdfAssetDoc(doc)) {
      return undefined
    }

    const assetDoc = clonePdfAssetDoc(doc)
    await saveCachedResourceDoc(assetUrl, assetDoc).catch(() => undefined)
    return assetDoc
  } finally {
    await resourceRepo.removeFromCache(handle.documentId).catch(() => undefined)
  }
}

export function loadStoredPdfAsset(url: string) {
  return enqueueResourceLoad(() => loadStoredPdfAssetNow(url))
}

function createPdfAssetObjectUrl(assetDoc: PdfAssetDoc) {
  return enqueueResourceLoad(
    async () =>
      URL.createObjectURL(new Blob([blobPartFromBytes(assetDoc.bytes)], { type: assetDoc.mimeType || 'application/pdf' })),
    { estimatedBytes: estimateStoredAssetMemoryBytes(assetDoc.sizeBytes, 4) },
  )
}

export async function findMatchingStoredPdfAssetUrl(
  assetDoc: Pick<PdfAssetDoc, 'bytes' | 'sizeBytes' | 'contentHash'>,
  candidateUrls: Array<string | undefined>,
  loadAsset: (url: string) => Promise<PdfAssetDoc | undefined> = loadStoredPdfAsset,
) {
  for (const assetUrl of collectAutomergeUrls(candidateUrls)) {
    const existingAsset = await loadAsset(assetUrl)
    if (!existingAsset || existingAsset.sizeBytes !== assetDoc.sizeBytes) {
      continue
    }

    if (existingAsset.contentHash && assetDoc.contentHash && existingAsset.contentHash === assetDoc.contentHash) {
      return assetUrl
    }

    if (sameBytes(existingAsset.bytes, assetDoc.bytes)) {
      return assetUrl
    }
  }

  return undefined
}

export async function createOrReusePdfAsset(file: File, candidateUrls: Array<string | undefined> = []) {
  const assetDoc = await buildPdfAssetDoc(file)
  const existingUrl = await findMatchingStoredPdfAssetUrl(assetDoc, candidateUrls)
  if (existingUrl) {
    return {
      url: existingUrl,
      reused: true as const,
    }
  }

  const handle = resourceRepo.create<PdfAssetDoc>(assetDoc)
  await saveCachedResourceDoc(handle.url, assetDoc).catch(() => undefined)
  return {
    url: handle.url,
    reused: false as const,
  }
}

export function useResolvedPdfAssets(urls: Array<string | undefined>) {
  const [{ assetUrls, key: assetUrlsKey }, setAssetUrlState] = useState(() => collectAutomergeUrlState(urls))
  const objectUrlRef = useRef(new Map<AutomergeUrl, { signature: string; objectUrl: string }>())
  const [resolvedAssets, setResolvedAssets] = useState<ReadonlyMap<AutomergeUrl, ResolvedPdfAsset>>(new Map())
  const loadVersionRef = useRef(0)

  useEffect(() => {
    const nextAssetUrlState = collectAutomergeUrlState(urls)
    if (nextAssetUrlState.key !== assetUrlsKey) {
      // We intentionally stabilize the URL set so asset loads are keyed by URL contents, not caller array identity.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setAssetUrlState(nextAssetUrlState)
    }
  }, [assetUrlsKey, urls])

  useEffect(() => {
    const loadVersion = loadVersionRef.current + 1
    loadVersionRef.current = loadVersion
    let cancelled = false

    const liveUrls = new Set(assetUrls)
    for (const [assetUrl, currentObjectUrl] of objectUrlRef.current) {
      if (!liveUrls.has(assetUrl)) {
        URL.revokeObjectURL(currentObjectUrl.objectUrl)
        objectUrlRef.current.delete(assetUrl)
      }
    }
    setResolvedAssets((currentAssets) => {
      const nextResolvedAssets = new Map(currentAssets)
      for (const assetUrl of currentAssets.keys()) {
        if (!liveUrls.has(assetUrl)) {
          nextResolvedAssets.delete(assetUrl)
        }
      }
      return nextResolvedAssets
    })

    void (async () => {
      for (const assetUrl of assetUrls) {
        if (cancelled || loadVersionRef.current !== loadVersion) {
          return
        }

        let assetDoc: PdfAssetDoc | undefined
        try {
          assetDoc = await loadStoredPdfAsset(assetUrl)
        } catch {
          assetDoc = undefined
        }

        if (cancelled || loadVersionRef.current !== loadVersion) {
          return
        }

        if (!assetDoc) {
          const currentObjectUrl = objectUrlRef.current.get(assetUrl)
          if (currentObjectUrl) {
            URL.revokeObjectURL(currentObjectUrl.objectUrl)
            objectUrlRef.current.delete(assetUrl)
          }
          setResolvedAssets((currentAssets) => {
            if (!currentAssets.has(assetUrl)) {
              return currentAssets
            }
            const nextResolvedAssets = new Map(currentAssets)
            nextResolvedAssets.delete(assetUrl)
            return nextResolvedAssets
          })
          continue
        }

        const signature = [
          assetDoc.contentHash ?? '',
          assetDoc.name,
          assetDoc.mimeType,
          assetDoc.sizeBytes,
        ].join(':')
        const currentObjectUrl = objectUrlRef.current.get(assetUrl)

        if (!currentObjectUrl || currentObjectUrl.signature !== signature) {
          if (currentObjectUrl) {
            URL.revokeObjectURL(currentObjectUrl.objectUrl)
          }

          objectUrlRef.current.set(assetUrl, {
            signature,
            objectUrl: await createPdfAssetObjectUrl(assetDoc),
          })
        }

        if (cancelled || loadVersionRef.current !== loadVersion) {
          return
        }

        const objectUrl = objectUrlRef.current.get(assetUrl)
        if (!objectUrl) {
          continue
        }

        const resolvedAsset: ResolvedPdfAsset = {
          url: assetUrl,
          objectUrl: objectUrl.objectUrl,
          signature,
          name: assetDoc.name,
          mimeType: assetDoc.mimeType,
          sizeBytes: assetDoc.sizeBytes,
          contentHash: assetDoc.contentHash,
        }

        setResolvedAssets((currentAssets) => {
          const nextResolvedAssets = new Map(currentAssets)
          nextResolvedAssets.set(assetUrl, resolvedAsset)
          return nextResolvedAssets
        })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [assetUrls])

  useEffect(
    () => () => {
      for (const currentObjectUrl of objectUrlRef.current.values()) {
        URL.revokeObjectURL(currentObjectUrl.objectUrl)
      }
      objectUrlRef.current.clear()
    },
    [],
  )

  return resolvedAssets
}
