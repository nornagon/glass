import { isValidAutomergeUrl, type AutomergeUrl, useDocuments } from '@automerge/react'
import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { repo } from './repo'
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

function isFinitePositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
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

export function collectRoomImageAssetUrls(room: RoomDoc, extraUrls: Array<string | undefined> = []) {
  const candidates = [...extraUrls]

  for (const object of Object.values(room.objects)) {
    if (object.type === 'card' || object.type === 'board' || object.type === 'pool') {
      candidates.push(spriteImageUrl(object.face))
      candidates.push(spriteImageUrl(object.back))
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

export async function loadStoredImageAsset(url: string) {
  const assetUrl = asAutomergeUrl(url)
  if (!assetUrl) {
    return undefined
  }

  const handle = await repo.find<ImageAssetDoc>(assetUrl)
  const doc = handle.doc()
  return isImageAssetDoc(doc) ? doc : undefined
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

  const handle = repo.create<ImageAssetDoc>(assetDoc)
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
  const assetUrls = useMemo(() => collectAutomergeUrls(urls), [urls])
  const [assetDocs] = useDocuments<ImageAssetDoc>(assetUrls, { suspense: false })
  const objectUrlRef = useRef(new Map<AutomergeUrl, { signature: string; objectUrl: string }>())
  const [resolvedAssets, setResolvedAssets] = useState<ReadonlyMap<AutomergeUrl, ResolvedImageAsset>>(new Map())
  const commitResolvedAssets = useEffectEvent((nextResolvedAssets: ReadonlyMap<AutomergeUrl, ResolvedImageAsset>) => {
    setResolvedAssets(nextResolvedAssets)
  })

  useEffect(() => {
    const nextResolvedAssets = new Map<AutomergeUrl, ResolvedImageAsset>()
    const liveUrls = new Set(assetUrls)

    for (const assetUrl of assetUrls) {
      const assetDoc = assetDocs.get(assetUrl)
      if (!assetDoc || !isImageAssetDoc(assetDoc)) {
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
          objectUrl: URL.createObjectURL(
            new Blob([blobPartFromBytes(assetDoc.bytes)], { type: assetDoc.mimeType || 'application/octet-stream' }),
          ),
        })
      }

      const objectUrl = objectUrlRef.current.get(assetUrl)
      if (!objectUrl) {
        continue
      }

      nextResolvedAssets.set(assetUrl, {
        url: assetUrl,
        objectUrl: objectUrl.objectUrl,
        signature,
        name: assetDoc.name,
        mimeType: assetDoc.mimeType,
        sizeBytes: assetDoc.sizeBytes,
        contentHash: assetDoc.contentHash,
        width: assetDoc.width,
        height: assetDoc.height,
      })
    }

    for (const [assetUrl, currentObjectUrl] of objectUrlRef.current) {
      if (!liveUrls.has(assetUrl) || !nextResolvedAssets.has(assetUrl)) {
        URL.revokeObjectURL(currentObjectUrl.objectUrl)
        objectUrlRef.current.delete(assetUrl)
      }
    }

    commitResolvedAssets(nextResolvedAssets)
  }, [assetDocs, assetUrls])

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
