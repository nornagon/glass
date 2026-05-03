import { isValidAutomergeUrl, type AutomergeUrl } from '@automerge/react'
import { useEffect, useRef, useState } from 'react'
import { loadCachedResourceDoc, saveCachedResourceDoc } from './resourceCache'
import { enqueueResourceLoad, estimateRasterMemoryBytes, estimateStoredAssetMemoryBytes } from './resourceLoadQueue'
import { resourceRepo } from './repo'
import type { RoomDoc, SpriteSpec } from './types'

export interface ImageAssetDoc {
  version: 1
  kind: 'image'
  name: string
  mimeType: string
  bytes: Uint8Array
  sizeBytes: number
  contentHash?: string
  width?: number
  height?: number
  createdAt: number
}

export interface ResolvedImageAsset {
  url: AutomergeUrl
  objectUrl: string
  signature: string
  name: string
  mimeType: string
  sizeBytes: number
  contentHash?: string
  width?: number
  height?: number
}

export interface ResolvedImageSource {
  isStored: boolean
  renderUrl?: string
  signature: string
  asset?: ResolvedImageAsset
}

function blobPartFromBytes(bytes: Uint8Array) {
  return Uint8Array.from(bytes)
}

function cloneImageAssetDoc(assetDoc: ImageAssetDoc): ImageAssetDoc {
  return {
    ...assetDoc,
    bytes: Uint8Array.from(assetDoc.bytes),
  }
}

function isFinitePositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function estimateImageAssetMemoryBytes(assetDoc: Pick<ImageAssetDoc, 'height' | 'sizeBytes' | 'width'>) {
  const byteEstimate = estimateStoredAssetMemoryBytes(assetDoc.sizeBytes, 4)
  const rasterEstimate = assetDoc.width && assetDoc.height
    ? estimateRasterMemoryBytes(assetDoc.width, assetDoc.height, 2)
    : 0
  return Math.max(byteEstimate, rasterEstimate)
}

async function sha256Hex(bytes: Uint8Array) {
  if (!globalThis.crypto?.subtle) {
    return undefined
  }

  const digestInput = Uint8Array.from(bytes)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', digestInput)
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

export function isImageAssetDoc(value: unknown): value is ImageAssetDoc {
  if (!value || typeof value !== 'object') {
    return false
  }

  const doc = value as Partial<ImageAssetDoc>
  return (
    doc.version === 1 &&
    doc.kind === 'image' &&
    typeof doc.name === 'string' &&
    typeof doc.mimeType === 'string' &&
    doc.bytes instanceof Uint8Array &&
    isFinitePositiveNumber(doc.sizeBytes) &&
    typeof doc.createdAt === 'number'
  )
}

function spriteImageUrl(spec: SpriteSpec | undefined) {
  if (!spec || spec.kind !== 'image-url') {
    return undefined
  }
  return spec.url
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

export function collectRoomImageAssetUrls(room: RoomDoc, extraUrls: Array<string | undefined> = []) {
  const candidates = [...extraUrls]

  for (const object of Object.values(room.objects)) {
    if (object.type === 'card' || object.type === 'board' || object.type === 'pool') {
      candidates.push(spriteImageUrl(object.face))
      candidates.push(spriteImageUrl(object.back))
    } else if (object.type === 'die') {
      for (const face of object.faces) {
        candidates.push(spriteImageUrl(face))
      }
    }
  }

  return collectAutomergeUrls(candidates)
}

export function resolveImageSource(
  rawUrl: string | undefined,
  imageAssets: ReadonlyMap<AutomergeUrl, ResolvedImageAsset>,
): ResolvedImageSource | undefined {
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

  const asset = imageAssets.get(assetUrl)
  return {
    isStored: true,
    renderUrl: asset?.objectUrl,
    signature: asset ? `${assetUrl}:${asset.signature}` : `${assetUrl}:pending`,
    asset,
  }
}

export async function readImageBlobDimensions(blob: Blob) {
  return enqueueResourceLoad(
    async () => {
      const objectUrl = URL.createObjectURL(blob)
      try {
        return await new Promise<{ width: number; height: number }>((resolve, reject) => {
          const image = new Image()
          image.decoding = 'async'
          image.onload = () => {
            if (image.naturalWidth > 0 && image.naturalHeight > 0) {
              resolve({
                width: image.naturalWidth,
                height: image.naturalHeight,
              })
            } else {
              reject(new Error('Image loaded without dimensions'))
            }
          }
          image.onerror = () => reject(new Error('Image failed to load'))
          image.src = objectUrl
        })
      } finally {
        URL.revokeObjectURL(objectUrl)
      }
    },
    { estimatedBytes: estimateStoredAssetMemoryBytes(blob.size, 2) },
  )
}

export async function buildImageAssetDoc(file: File): Promise<ImageAssetDoc> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const dimensions = await readImageBlobDimensions(file)
  const contentHash = await sha256Hex(bytes)

  return {
    version: 1,
    kind: 'image',
    name: file.name || 'Uploaded image',
    mimeType: file.type || 'application/octet-stream',
    bytes,
    sizeBytes: bytes.byteLength,
    contentHash,
    width: dimensions.width,
    height: dimensions.height,
    createdAt: Date.now(),
  }
}

async function loadStoredImageAssetNow(url: string) {
  const assetUrl = asAutomergeUrl(url)
  if (!assetUrl) {
    return undefined
  }

  const cachedAsset = await loadCachedResourceDoc(assetUrl)
  if (cachedAsset && isImageAssetDoc(cachedAsset)) {
    return cloneImageAssetDoc(cachedAsset)
  }

  const progress = resourceRepo.findWithProgress<ImageAssetDoc>(assetUrl)
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
    if (!isImageAssetDoc(doc)) {
      return undefined
    }

    const assetDoc = cloneImageAssetDoc(doc)
    await saveCachedResourceDoc(assetUrl, assetDoc).catch(() => undefined)
    return assetDoc
  } finally {
    await resourceRepo.removeFromCache(handle.documentId).catch(() => undefined)
  }
}

export function loadStoredImageAsset(url: string) {
  return enqueueResourceLoad(() => loadStoredImageAssetNow(url))
}

function createImageAssetObjectUrl(assetDoc: ImageAssetDoc) {
  return enqueueResourceLoad(
    async () =>
      URL.createObjectURL(
        new Blob([blobPartFromBytes(assetDoc.bytes)], { type: assetDoc.mimeType || 'application/octet-stream' }),
      ),
    { estimatedBytes: estimateImageAssetMemoryBytes(assetDoc) },
  )
}

export async function findMatchingStoredImageAssetUrl(
  assetDoc: Pick<ImageAssetDoc, 'bytes' | 'sizeBytes' | 'contentHash'>,
  candidateUrls: Array<string | undefined>,
  loadAsset: (url: string) => Promise<ImageAssetDoc | undefined> = loadStoredImageAsset,
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

export async function createOrReuseImageAsset(file: File, candidateUrls: Array<string | undefined> = []) {
  const assetDoc = await buildImageAssetDoc(file)
  const existingUrl = await findMatchingStoredImageAssetUrl(assetDoc, candidateUrls)
  if (existingUrl) {
    return {
      url: existingUrl,
      reused: true as const,
    }
  }

  const handle = resourceRepo.create<ImageAssetDoc>(assetDoc)
  await saveCachedResourceDoc(handle.url, assetDoc).catch(() => undefined)
  return {
    url: handle.url,
    reused: false as const,
  }
}

export async function loadStoredImageDimensions(url: string) {
  const asset = await loadStoredImageAsset(url)
  if (!asset) {
    return undefined
  }

  if (asset.width && asset.height) {
    return {
      width: asset.width,
      height: asset.height,
    }
  }

  return readImageBlobDimensions(new Blob([blobPartFromBytes(asset.bytes)], { type: asset.mimeType }))
}

export function useResolvedImageAssets(urls: Array<string | undefined>) {
  const [{ assetUrls, key: assetUrlsKey }, setAssetUrlState] = useState(() => collectAutomergeUrlState(urls))
  const objectUrlRef = useRef(new Map<AutomergeUrl, { signature: string; objectUrl: string }>())
  const [resolvedAssets, setResolvedAssets] = useState<ReadonlyMap<AutomergeUrl, ResolvedImageAsset>>(new Map())
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

        let assetDoc: ImageAssetDoc | undefined
        try {
          assetDoc = await loadStoredImageAsset(assetUrl)
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
          assetDoc.width ?? 0,
          assetDoc.height ?? 0,
        ].join(':')
        const currentObjectUrl = objectUrlRef.current.get(assetUrl)

        if (!currentObjectUrl || currentObjectUrl.signature !== signature) {
          if (currentObjectUrl) {
            URL.revokeObjectURL(currentObjectUrl.objectUrl)
          }

          objectUrlRef.current.set(assetUrl, {
            signature,
            objectUrl: await createImageAssetObjectUrl(assetDoc),
          })
        }

        if (cancelled || loadVersionRef.current !== loadVersion) {
          return
        }

        const objectUrl = objectUrlRef.current.get(assetUrl)
        if (!objectUrl) {
          continue
        }

        const resolvedAsset: ResolvedImageAsset = {
          url: assetUrl,
          objectUrl: objectUrl.objectUrl,
          signature,
          name: assetDoc.name,
          mimeType: assetDoc.mimeType,
          sizeBytes: assetDoc.sizeBytes,
          contentHash: assetDoc.contentHash,
          width: assetDoc.width,
          height: assetDoc.height,
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
