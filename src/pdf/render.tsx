import { useEffect, useMemo, useState } from 'react'
import type { PdfDocumentObject, PdfEngine, PdfPageObject } from '@embedpdf/models'
import { enqueueResourceLoad, estimateRasterMemoryBytes } from '../model/resourceLoadQueue'

type Size = {
  width: number
  height: number
}

interface PdfPageImageState {
  imageUrl?: string
  loading: boolean
  error?: string
}

const pdfDocumentPromiseCache = new Map<string, Promise<PdfDocumentObject>>()
const renderedPdfPagePromiseCache = new Map<string, Promise<string>>()
const renderedPdfPageCache = new Map<string, string>()
const pdfiumWasmUrl = new URL('../../node_modules/@embedpdf/pdfium/dist/pdfium.wasm', import.meta.url).href

let embedPdfEnginePromise: Promise<PdfEngine<Blob>> | undefined

async function getEmbedPdfEngine() {
  if (!embedPdfEnginePromise) {
    embedPdfEnginePromise = import('@embedpdf/engines').then(({ createPdfiumWorkerEngine }) =>
      createPdfiumWorkerEngine(pdfiumWasmUrl, {
        encoderPoolSize: 1,
      }),
    )
  }

  return embedPdfEnginePromise
}

function pageDisplaySize(page: PdfPageObject) {
  const isQuarterTurn = page.rotation % 2 !== 0
  return isQuarterTurn
    ? {
        width: page.size.height,
        height: page.size.width,
      }
    : page.size
}

function openPdfDocument(url: string) {
  const cached = pdfDocumentPromiseCache.get(url)
  if (cached) {
    return cached
  }

  const request = getEmbedPdfEngine()
    .then((engine) =>
      engine.openDocumentUrl({
        id: url,
        url,
      }).toPromise(),
    )

  pdfDocumentPromiseCache.set(url, request)

  void request.catch(() => {
    pdfDocumentPromiseCache.delete(url)
  })
  return request
}

export function loadPdfDocument(url: string) {
  return enqueueResourceLoad(
    () => openPdfDocument(url),
    { estimatedBytes: estimateRasterMemoryBytes(4096, 4096, 4) },
  )
}

export async function inspectPdfSource(url: string) {
  const document = await loadPdfDocument(url)
  const firstPage = document.pages[0]
  const size = firstPage ? pageDisplaySize(firstPage) : { width: 0, height: 0 }

  return {
    pageCount: document.pageCount,
    width: size.width,
    height: size.height,
  }
}

export async function inspectPdfPageSource(url: string, pageNumber: number) {
  const document = await loadPdfDocument(url)
  const safePageIndex = Math.max(0, Math.min(pageNumber - 1, document.pageCount - 1))
  const page = document.pages[safePageIndex]
  const size = page ? pageDisplaySize(page) : { width: 0, height: 0 }

  return {
    pageCount: document.pageCount,
    pageNumber: safePageIndex + 1,
    width: size.width,
    height: size.height,
  }
}

function normalizedRenderSize(size: Size, qualityBoost: number, maxDimension: number) {
  const deviceScale = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1
  const targetWidth = Math.max(1, Math.round(size.width * deviceScale * qualityBoost))
  const targetHeight = Math.max(1, Math.round(size.height * deviceScale * qualityBoost))
  const scaleLimit = Math.min(1, maxDimension / Math.max(targetWidth, targetHeight, 1))

  return {
    width: Math.max(1, Math.round(targetWidth * scaleLimit)),
    height: Math.max(1, Math.round(targetHeight * scaleLimit)),
  }
}

async function renderPdfPageToObjectUrl(
  url: string,
  pageNumber: number,
  size: Size,
  qualityBoost: number,
  maxDimension: number,
) {
  const rasterSize = normalizedRenderSize(size, qualityBoost, maxDimension)
  const cacheKey = `${url}:${pageNumber}:${rasterSize.width}x${rasterSize.height}`
  const cached = renderedPdfPageCache.get(cacheKey)
  if (cached) {
    return cached
  }

  const cachedPromise = renderedPdfPagePromiseCache.get(cacheKey)
  if (cachedPromise) {
    return cachedPromise
  }

  const request = enqueueResourceLoad(async () => {
    const pdfDocument = await openPdfDocument(url)
    const safePageIndex = Math.max(0, Math.min(pageNumber - 1, pdfDocument.pageCount - 1))
    const page = pdfDocument.pages[safePageIndex]
    if (!page) {
      throw new Error('PDF page unavailable')
    }

    const baseSize = pageDisplaySize(page)
    const scaleFactor = Math.min(
      rasterSize.width / Math.max(baseSize.width, 1),
      rasterSize.height / Math.max(baseSize.height, 1),
    )

    const engine = await getEmbedPdfEngine()
    const blob = await engine.renderPage(pdfDocument, page, {
      scaleFactor: Math.max(scaleFactor, 0.01),
      imageType: 'image/png',
      imageQuality: 1,
    }).toPromise()

    const objectUrl = URL.createObjectURL(blob)
    renderedPdfPageCache.set(cacheKey, objectUrl)
    renderedPdfPagePromiseCache.delete(cacheKey)
    return objectUrl
  }, { estimatedBytes: estimateRasterMemoryBytes(rasterSize.width, rasterSize.height, 6) })

  renderedPdfPagePromiseCache.set(cacheKey, request)

  try {
    return await request
  } catch (error) {
    renderedPdfPagePromiseCache.delete(cacheKey)
    throw error
  }
}

export function usePdfDocumentInfo(url?: string) {
  const [state, setState] = useState<{
    url?: string
    pageCount?: number
    error?: string
  }>({})

  useEffect(() => {
    if (!url) {
      return
    }

    let cancelled = false

    void loadPdfDocument(url)
      .then((pdfDocument) => {
        if (cancelled) {
          return
        }

        setState({
          url,
          pageCount: pdfDocument.pageCount,
          error: undefined,
        })
      })
      .catch(() => {
        if (cancelled) {
          return
        }

        setState({
          url,
          pageCount: undefined,
          error: 'Could not load this PDF.',
        })
      })

    return () => {
      cancelled = true
    }
  }, [url])

  return {
    pageCount: state.url === url ? state.pageCount : undefined,
    loading: Boolean(url) && state.url !== url,
    error: state.url === url ? state.error : undefined,
  }
}

export function usePdfPageImage(
  url: string | undefined,
  pageNumber: number,
  size: Size,
  options?: {
    qualityBoost?: number
    maxDimension?: number
  },
) {
  const requestSize = useMemo(
    () => ({
      width: Math.max(1, size.width),
      height: Math.max(1, size.height),
    }),
    [size.height, size.width],
  )
  const qualityBoost = options?.qualityBoost ?? 1
  const maxDimension = options?.maxDimension ?? 2048
  const requestKey = url ? `${url}:${pageNumber}:${requestSize.width}x${requestSize.height}:${qualityBoost}:${maxDimension}` : undefined
  const [state, setState] = useState<{
    key?: string
    imageUrl?: string
    error?: string
  }>({})

  useEffect(() => {
    if (!url) {
      return
    }

    let cancelled = false
    void renderPdfPageToObjectUrl(url, pageNumber, requestSize, qualityBoost, maxDimension)
      .then((imageUrl) => {
        if (cancelled) {
          return
        }

        setState({
          key: requestKey,
          imageUrl,
          error: undefined,
        })
      })
      .catch(() => {
        if (cancelled) {
          return
        }

        setState({
          key: requestKey,
          imageUrl: undefined,
          error: 'Could not render this PDF page.',
        })
      })

    return () => {
      cancelled = true
    }
  }, [maxDimension, pageNumber, qualityBoost, requestKey, requestSize, url])

  return {
    imageUrl: state.key === requestKey ? state.imageUrl : undefined,
    loading: Boolean(requestKey) && state.key !== requestKey,
    error: state.key === requestKey ? state.error : undefined,
  } satisfies PdfPageImageState
}
