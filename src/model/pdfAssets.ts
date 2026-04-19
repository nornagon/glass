import { isValidAutomergeUrl, type AutomergeUrl, useDocuments } from '@automerge/react'
import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { repo } from './repo'
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

export async function loadStoredPdfAsset(url: string) {
  const assetUrl = asAutomergeUrl(url)
  if (!assetUrl) {
    return undefined
  }

  const handle = await repo.find<PdfAssetDoc>(assetUrl)
  const doc = handle.doc()
  return isPdfAssetDoc(doc) ? doc : undefined
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

  const handle = repo.create<PdfAssetDoc>(assetDoc)
  return {
    url: handle.url,
    reused: false as const,
  }
}

export function useResolvedPdfAssets(urls: Array<string | undefined>) {
  const assetUrls = useMemo(() => collectAutomergeUrls(urls), [urls])
  const [assetDocs] = useDocuments<PdfAssetDoc>(assetUrls, { suspense: false })
  const objectUrlRef = useRef(new Map<AutomergeUrl, { signature: string; objectUrl: string }>())
  const [resolvedAssets, setResolvedAssets] = useState<ReadonlyMap<AutomergeUrl, ResolvedPdfAsset>>(new Map())
  const commitResolvedAssets = useEffectEvent((nextResolvedAssets: ReadonlyMap<AutomergeUrl, ResolvedPdfAsset>) => {
    setResolvedAssets(nextResolvedAssets)
  })

  useEffect(() => {
    const nextResolvedAssets = new Map<AutomergeUrl, ResolvedPdfAsset>()
    const liveUrls = new Set(assetUrls)

    for (const assetUrl of assetUrls) {
      const assetDoc = assetDocs.get(assetUrl)
      if (!assetDoc || !isPdfAssetDoc(assetDoc)) {
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
          objectUrl: URL.createObjectURL(
            new Blob([blobPartFromBytes(assetDoc.bytes)], { type: assetDoc.mimeType || 'application/pdf' }),
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
