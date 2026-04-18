import type { AutomergeUrl } from '@automerge/react'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent as ReactDragEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { resolveImageSource, type ResolvedImageAsset } from '../model/assets'
import { BOARD_WORLD_SIZE, DEFAULT_CARD_SIZE, type CameraState, type Id, type RoomDoc, type SpriteSpec, type Transform2D } from '../model/types'
import { canSeeCardFace, getRootPlane, getTransform, isBoard, isBoardFaceUp, isCard, isDeck, isGroupSelectableObject } from '../model/room'
import {
  bindBoardInputRecorder,
  recordBoardInputRecorderCamera,
  recordBoardInputRecorderSelection,
  recordBoardInputRecorderViewport,
} from '../debug/inputRecorder'

interface BoardViewProps {
  room: RoomDoc
  roomUrl: string
  imageAssets: ReadonlyMap<AutomergeUrl, ResolvedImageAsset>
  dropImageError?: string
  ephemeralTransforms?: Partial<Record<Id, Transform2D>>
  selectionMode: 'normal' | 'group'
  selectedId?: Id
  selectedIds: Id[]
  lassoMode: boolean
  currentPlayerId?: string
  canEdit: boolean
  allowSelectLocked: boolean
  initialCamera: CameraState
  onCameraChange: (camera: CameraState) => void
  onSelect: (id?: Id) => void
  onToggleGroupSelection: (id: Id) => void
  onAddToGroupSelection: (ids: Id[]) => void
  onCommitTransform: (id: Id, transform: Partial<Transform2D>) => void
  onPreviewTransform: (id: Id, transform: Transform2D) => void
  onClearPreviewTransform: (id: Id, finalTransform?: Transform2D) => void
  onDropObjectOntoObject: (objectId: Id, targetId: Id) => void
  onBringObjectToFront: (objectId: Id) => void
  onLiftTopCardFromDeck: (deckId: Id) => Id | undefined
  onFlipCard: (cardId: Id) => void
  onFlipBoard: (boardId: Id) => void
  onFlipDeck: (deckId: Id) => void
  onDrawDeck: (deckId: Id) => void
  onDropImageFileAt: (files: File[], point: { x: number; y: number }) => void
  onShuffleDeck: (deckId: Id) => void
  onOpenSelectionPanel: () => void
}

interface Point {
  x: number
  y: number
}

interface Size {
  width: number
  height: number
}

interface DragState {
  id: Id
  pointerId: number
  mode: 'move' | 'rotate'
  startPointer: Point
  startTransform: Transform2D
  currentPoint: Point
  moved: boolean
  raisedToFront: boolean
  groupMembers?: Array<{ id: Id; startTransform: Transform2D }>
}

interface PendingDeckPress {
  deckId: Id
  pointerId: number
  startPoint: Point
  startTransform: Transform2D
  timeoutId: number
}

interface TapCandidate {
  id: Id
  pointerId: number
  startPoint: Point
}

interface BackgroundTapCandidate {
  pointerId: number
  startPoint: Point
}

interface LassoState {
  pointerId: number
  points: Point[]
}

interface QuickAction {
  id: string
  label: string
  onClick: () => void
  icon?: 'flip' | 'more'
  text?: string
}

type EphemeralTransformMap = Partial<Record<Id, Transform2D>>

const FULL_CROP = { x: 0, y: 0, width: 1, height: 1 } as const
const TAP_GRACE_DISTANCE = 10
const DECK_LONG_PRESS_MS = 360
const MIN_ZOOM_SCALE = 0.2
const MAX_ZOOM_SCALE = 2.5
const PAN_CLAMP_MARGIN = 640
const PAN_MOMENTUM_DECAY = 6.5
const PAN_MOMENTUM_CUTOFF_SCREEN_VELOCITY = 10
const PAN_MOMENTUM_MAX_DT_SECONDS = 1 / 15
const PAN_MOMENTUM_SAMPLE_WINDOW_SECONDS = 0.12
const PAN_MOMENTUM_VELOCITY_GAIN = 1
const PAN_MOMENTUM_CONSTRAINT_EPSILON = 1
const ALPHA_COMPONENT_THRESHOLD = 96
const ALPHA_COMPONENT_ANALYSIS_MAX_DIMENSION = 256
const ALPHA_OUTLINE_RENDER_THRESHOLD = 24
const ALPHA_OUTLINE_MAX_RASTER_DIMENSION = 1024
const ALPHA_OUTLINE_MIN_SAMPLES = 12
const ALPHA_OUTLINE_MAX_SAMPLES = 64
const PREPARED_SPRITE_MAX_DIMENSION = 4096
const PREPARED_SPRITE_MOBILE_SAFARI_MAX_DIMENSION = 2048
const PREPARED_SPRITE_PREWARM_INITIAL_DELAY_MS = 1500
const PREPARED_SPRITE_PREWARM_QUIET_MS = 1000
const PREPARED_SPRITE_PREWARM_FALLBACK_DELAY_MS = 250
const PREPARED_SPRITE_PREWARM_MIN_IDLE_MS = 12

const intrinsicImageSizeCache = new Map<string, Size | null>()
const resolvedSourceImageElementCache = new Map<string, HTMLImageElement>()
const sourceImageElementCache = new Map<string, Promise<HTMLImageElement>>()
const resolvedSourceImageBitmapCache = new Map<string, ImageBitmap>()
const sourceImageBitmapCache = new Map<string, Promise<ImageBitmap>>()
const preparedSpriteSurfaceUrlCache = new Map<string, string | null>()
const preparedSpriteSurfaceRequestCache = new Map<string, Promise<string | null>>()
const opaqueRegionBoundsCache = new Map<string, { x: number; y: number; width: number; height: number } | null>()
const opaqueRegionRequestCache = new Map<string, Promise<{ x: number; y: number; width: number; height: number } | null>>()

function computeSurfaceFit(
  crop: ReturnType<typeof normalizeCrop>,
  targetSize: Size,
  sourceSize: Size,
  fit: SpriteSpec['fit'],
) {
  const targetAspect = targetSize.width > 0 && targetSize.height > 0 ? targetSize.width / targetSize.height : 1
  const sourceAspect = sourceSize.width / sourceSize.height
  const cropAspect = sourceAspect * crop.width / crop.height

  let fitWidth = 1
  let fitHeight = 1
  if (fit === 'contain') {
    if (cropAspect > targetAspect) {
      fitHeight = targetAspect / cropAspect
    } else {
      fitWidth = cropAspect / targetAspect
    }
  } else if (cropAspect > targetAspect) {
    fitWidth = cropAspect / targetAspect
  } else {
    fitHeight = targetAspect / cropAspect
  }

  return {
    fitWidth,
    fitHeight,
  }
}

function preparedSpriteSurfaceRasterSize(
  crop: ReturnType<typeof normalizeCrop>,
  fitWorldWidth: number,
  fitWorldHeight: number,
  intrinsicSize: Size,
) {
  const maxDimension = isLikelyMobileSafari() ? PREPARED_SPRITE_MOBILE_SAFARI_MAX_DIMENSION : PREPARED_SPRITE_MAX_DIMENSION
  const qualityScale =
    typeof window === 'undefined'
      ? MAX_ZOOM_SCALE
      : Math.max(1, (window.devicePixelRatio || 1) * MAX_ZOOM_SCALE)
  const cropPixelWidth = Math.max(1, Math.round(intrinsicSize.width * crop.width))
  const cropPixelHeight = Math.max(1, Math.round(intrinsicSize.height * crop.height))
  const targetRasterWidth = Math.max(1, Math.round(fitWorldWidth * qualityScale))
  const targetRasterHeight = Math.max(1, Math.round(fitWorldHeight * qualityScale))
  const uncappedRasterWidth = Math.min(targetRasterWidth, cropPixelWidth)
  const uncappedRasterHeight = Math.min(targetRasterHeight, cropPixelHeight)
  const scaleLimit = Math.min(
    1,
    maxDimension / Math.max(uncappedRasterWidth, uncappedRasterHeight, 1),
  )

  return {
    rasterWidth: Math.max(1, Math.round(uncappedRasterWidth * scaleLimit)),
    rasterHeight: Math.max(1, Math.round(uncappedRasterHeight * scaleLimit)),
  }
}

function isLikelyMobileSafari() {
  if (typeof navigator === 'undefined') {
    return false
  }

  const userAgent = navigator.userAgent
  const vendor = navigator.vendor ?? ''
  const isAppleWebKit = vendor.includes('Apple') && userAgent.includes('WebKit')
  const isOtherIosBrowser = /CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo|GSA/.test(userAgent)
  const isTouchAppleDevice = navigator.maxTouchPoints > 1 && (/iP(hone|ad|od)/.test(userAgent) || userAgent.includes('Macintosh'))
  return isAppleWebKit && !isOtherIosBrowser && isTouchAppleDevice
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function sameTransform(a: Transform2D | undefined, b: Transform2D | undefined) {
  if (!a || !b) {
    return a === b
  }

  return a.x === b.x && a.y === b.y && a.rotation === b.rotation
}

function sameTransformMap(a: EphemeralTransformMap, b: EphemeralTransformMap) {
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) {
    return false
  }

  return aKeys.every((key) => sameTransform(a[key], b[key]))
}

function sameCamera(a: CameraState, b: CameraState) {
  return a.centerX === b.centerX && a.centerY === b.centerY && a.zoom === b.zoom
}

function clampCamera(camera: CameraState): CameraState {
  const limit = BOARD_WORLD_SIZE / 2 + PAN_CLAMP_MARGIN
  return {
    centerX: clamp(Number(camera.centerX.toFixed(1)), -limit, limit),
    centerY: clamp(Number(camera.centerY.toFixed(1)), -limit, limit),
    zoom: clamp(Number(camera.zoom.toFixed(3)), MIN_ZOOM_SCALE, MAX_ZOOM_SCALE),
  }
}

function screenToLogical(viewport: Size, camera: CameraState, point: Point): Point {
  return {
    x: camera.centerX + (point.x - viewport.width / 2) / camera.zoom,
    y: camera.centerY + (point.y - viewport.height / 2) / camera.zoom,
  }
}

function logicalToScreen(viewport: Size, camera: CameraState, point: Point): Point {
  return {
    x: viewport.width / 2 + (point.x - camera.centerX) * camera.zoom,
    y: viewport.height / 2 + (point.y - camera.centerY) * camera.zoom,
  }
}

function boardGridScreenStyle(viewport: Size, camera: CameraState): CSSProperties {
  const surfaceScreenSize = Math.max(1, BOARD_WORLD_SIZE * camera.zoom)
  const gridSize = Math.max(1, 160 * camera.zoom)
  const topLeft = logicalToScreen(viewport, camera, {
    x: -BOARD_WORLD_SIZE / 2,
    y: -BOARD_WORLD_SIZE / 2,
  })
  const originOffset = surfaceScreenSize / 2

  return {
    left: `${topLeft.x}px`,
    top: `${topLeft.y}px`,
    width: `${surfaceScreenSize}px`,
    height: `${surfaceScreenSize}px`,
    backgroundPosition: `${originOffset}px ${originOffset}px`,
    backgroundSize: `${gridSize}px ${gridSize}px, ${gridSize}px ${gridSize}px`,
  }
}

function applyBoardGridScreenStyle(boardGrid: HTMLDivElement, viewport: Size, camera: CameraState) {
  const style = boardGridScreenStyle(viewport, camera)
  boardGrid.style.left = String(style.left ?? '')
  boardGrid.style.top = String(style.top ?? '')
  boardGrid.style.width = String(style.width ?? '')
  boardGrid.style.height = String(style.height ?? '')
  boardGrid.style.backgroundPosition = String(style.backgroundPosition ?? '')
  boardGrid.style.backgroundSize = String(style.backgroundSize ?? '')
}

function cameraForAnchor(
  viewport: Size,
  anchorWorld: Point,
  anchorScreen: Point,
  zoom: number,
): CameraState {
  return clampCamera({
    centerX: anchorWorld.x - (anchorScreen.x - viewport.width / 2) / zoom,
    centerY: anchorWorld.y - (anchorScreen.y - viewport.height / 2) / zoom,
    zoom,
  })
}

function cameraTranslation(viewport: Size, camera: CameraState) {
  return {
    x: viewport.width / 2 - camera.centerX * camera.zoom,
    y: viewport.height / 2 - camera.centerY * camera.zoom,
  }
}

function cameraFromTranslation(viewport: Size, translation: Point, zoom: number): CameraState {
  return clampCamera({
    centerX: (viewport.width / 2 - translation.x) / zoom,
    centerY: (viewport.height / 2 - translation.y) / zoom,
    zoom,
  })
}

function clientToLocal(root: HTMLDivElement | null, clientX: number, clientY: number) {
  if (!root) {
    return undefined
  }

  const rect = root.getBoundingClientRect()
  return {
    x: clientX - rect.left,
    y: clientY - rect.top,
  }
}

function isMovableObjectType(room: RoomDoc, objectId: Id) {
  const object = room.objects[objectId]
  return Boolean(isCard(object) || isDeck(object) || isBoard(object))
}

function isMultiselectObjectType(room: RoomDoc, objectId: Id) {
  return isGroupSelectableObject(room.objects[objectId])
}

function objectDimensions(room: RoomDoc, objectId: Id) {
  const object = room.objects[objectId]
  if (isCard(object) || isBoard(object)) {
    return object.size
  }
  if (isDeck(object)) {
    if (object.size?.width && object.size?.height) {
      return object.size
    }

    for (let index = object.childIds.length - 1; index >= 0; index -= 1) {
      const child = room.objects[object.childIds[index]]
      if (isCard(child)) {
        return child.size
      }
    }
  }
  return DEFAULT_CARD_SIZE
}

function displayedTransformForObject(
  room: RoomDoc,
  objectId: Id,
  ephemeralTransforms: EphemeralTransformMap,
  localPreviewTransforms: EphemeralTransformMap,
) {
  return localPreviewTransforms[objectId] ?? ephemeralTransforms[objectId] ?? getTransform(room, objectId)
}

function pointInObjectRect(
  room: RoomDoc,
  objectId: Id,
  point: Point,
  ephemeralTransforms: EphemeralTransformMap,
  localPreviewTransforms: EphemeralTransformMap,
) {
  const transform = displayedTransformForObject(room, objectId, ephemeralTransforms, localPreviewTransforms)
  const object = room.objects[objectId]
  if (!transform || !object) {
    return false
  }

  const { width, height } = objectDimensions(room, objectId)
  const dx = point.x - transform.x
  const dy = point.y - transform.y
  const sin = Math.sin(-transform.rotation)
  const cos = Math.cos(-transform.rotation)
  const localX = dx * cos - dy * sin
  const localY = dx * sin + dy * cos

  return localX >= -width / 2 && localX <= width / 2 && localY >= -height / 2 && localY <= height / 2
}

function findDropTargetAtPoint(
  room: RoomDoc,
  point: Point,
  ephemeralTransforms: EphemeralTransformMap,
  localPreviewTransforms: EphemeralTransformMap,
  draggedObjectId: Id,
  ignoreId?: Id,
) {
  const root = getRootPlane(room)
  const draggedObject = room.objects[draggedObjectId]

  for (let index = root.childOrder.length - 1; index >= 0; index -= 1) {
    const objectId = root.childOrder[index]
    if (objectId === ignoreId) {
      continue
    }

    const object = room.objects[objectId]
    if (!pointInObjectRect(room, objectId, point, ephemeralTransforms, localPreviewTransforms)) {
      continue
    }

    if (isCard(draggedObject) && isDeck(object)) {
      return objectId
    }

    if (isDeck(draggedObject) && (isDeck(object) || isCard(object))) {
      return objectId
    }
  }

  return undefined
}

function pointInPolygon(point: Point, polygon: Point[]) {
  let inside = false

  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const currentPoint = polygon[index]
    const previousPoint = polygon[previous]
    const intersects =
      currentPoint.y > point.y !== previousPoint.y > point.y &&
      point.x < ((previousPoint.x - currentPoint.x) * (point.y - currentPoint.y)) / (previousPoint.y - currentPoint.y) + currentPoint.x

    if (intersects) {
      inside = !inside
    }
  }

  return inside
}

function objectIdsWithinLasso(
  viewport: Size,
  camera: CameraState,
  room: RoomDoc,
  ephemeralTransforms: EphemeralTransformMap,
  localPreviewTransforms: EphemeralTransformMap,
  polygon: Point[],
) {
  const root = getRootPlane(room)
  const selectedIds: Id[] = []

  for (const objectId of root.childOrder) {
    if (!isMultiselectObjectType(room, objectId)) {
      continue
    }

    const transform = displayedTransformForObject(room, objectId, ephemeralTransforms, localPreviewTransforms)
    if (!transform) {
      continue
    }

    if (pointInPolygon(logicalToScreen(viewport, camera, { x: transform.x, y: transform.y }), polygon)) {
      selectedIds.push(objectId)
    }
  }

  return selectedIds
}

function normalizeCrop(crop?: { x: number; y: number; width: number; height: number }) {
  if (!crop) {
    return FULL_CROP
  }

  const x = clamp(crop.x, 0, 1)
  const y = clamp(crop.y, 0, 1)
  const width = clamp(crop.width, 0.001, 1 - x)
  const height = clamp(crop.height, 0.001, 1 - y)

  return { x, y, width, height }
}

function snapRotationAngle(angle: number) {
  const fullTurn = Math.PI * 2
  const normalized = ((angle % fullTurn) + fullTurn) % fullTurn
  let bestAngle = normalized
  let bestDistance = Number.POSITIVE_INFINITY

  for (let degrees = 0; degrees < 360; degrees += 15) {
    if (degrees % 30 !== 0 && degrees % 45 !== 0) {
      continue
    }

    const candidate = (degrees * Math.PI) / 180
    const delta = Math.abs(candidate - normalized)
    const wrappedDelta = Math.min(delta, fullTurn - delta)
    if (wrappedDelta < bestDistance) {
      bestDistance = wrappedDelta
      bestAngle = candidate
    }
  }

  return bestAngle
}

function hasFileTransfer(dataTransfer: DataTransfer) {
  return [...dataTransfer.types].includes('Files')
}

function imageFilesFromTransfer(dataTransfer: DataTransfer) {
  const imageFiles: File[] = []

  for (const item of dataTransfer.items) {
    if (item.kind !== 'file') {
      continue
    }

    const file = item.getAsFile()
    if (file?.type.startsWith('image/')) {
      imageFiles.push(file)
    }
  }

  if (imageFiles.length > 0) {
    return imageFiles
  }

  return [...dataTransfer.files].filter((file) => file.type.startsWith('image/'))
}

function objectIdAtClientPoint(clientX: number, clientY: number) {
  const target = document.elementFromPoint(clientX, clientY)
  const objectElement =
    target instanceof Element ? target.closest<HTMLElement>('[data-board-object-id]') : null

  return objectElement?.dataset.boardObjectId as Id | undefined
}

function objectCursor(
  object: RoomDoc['objects'][Id],
  canEdit: boolean,
  allowSelectLocked: boolean,
  isDragging: boolean,
) {
  if (isDragging) {
    return 'grabbing'
  }
  if (canEdit && !object.locked) {
    return 'grab'
  }
  if (object.locked && allowSelectLocked) {
    return 'pointer'
  }
  return 'default'
}

function FlipQuickActionIcon() {
  return (
    <svg className="flip-icon" aria-hidden="true" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 5V2L8 6l4 4V7c2.76 0 5 2.24 5 5 0 .48-.07.94-.2 1.38l1.52 1.52A7 7 0 0 0 19 12c0-3.87-3.13-7-7-7Z" />
      <path d="M7 12c0-.48.07-.94.2-1.38L5.68 9.1A7 7 0 0 0 5 12c0 3.87 3.13 7 7 7v3l4-4-4-4v3c-2.76 0-5-2.24-5-5Z" />
    </svg>
  )
}

function MoreQuickActionIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
      <path d="M6 12h.01M12 12h.01M18 12h.01" />
    </svg>
  )
}

function loadSourceImageElement(url: string) {
  const resolved = resolvedSourceImageElementCache.get(url)
  if (resolved) {
    return Promise.resolve(resolved)
  }

  const cached = sourceImageElementCache.get(url)
  if (cached) {
    return cached
  }

  const request = new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.decoding = 'async'
    image.onload = () => {
      const finalize = () => {
        resolvedSourceImageElementCache.set(url, image)
        resolve(image)
      }

      if (typeof image.decode !== 'function') {
        finalize()
        return
      }

      void image.decode().then(finalize).catch(finalize)
    }
    image.onerror = () => {
      resolvedSourceImageElementCache.delete(url)
      sourceImageElementCache.delete(url)
      reject(new Error('Failed to load source image element'))
    }
    image.src = url
  })

  sourceImageElementCache.set(url, request)
  return request
}

function useSourceImagePreload(url: string | undefined) {
  useEffect(() => {
    if (!url) {
      return
    }

    void loadSourceImageElement(url).catch(() => {})
  }, [url])
}

function loadSourceImageBitmap(url: string) {
  const resolved = resolvedSourceImageBitmapCache.get(url)
  if (resolved) {
    return Promise.resolve(resolved)
  }

  const cached = sourceImageBitmapCache.get(url)
  if (cached) {
    return cached
  }

  const request = loadSourceImageElement(url)
    .then(async (image) => {
      if (typeof createImageBitmap !== 'function') {
        throw new Error('ImageBitmap is not supported')
      }

      const bitmap = await createImageBitmap(image)
      resolvedSourceImageBitmapCache.set(url, bitmap)
      sourceImageBitmapCache.delete(url)
      return bitmap
    })
    .catch((error) => {
      resolvedSourceImageBitmapCache.delete(url)
      sourceImageBitmapCache.delete(url)
      throw error
    })

  sourceImageBitmapCache.set(url, request)
  return request
}

function canvasBlob(canvas: HTMLCanvasElement | OffscreenCanvas) {
  if (typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas) {
    return canvas.convertToBlob({ type: 'image/png' })
  }

  return new Promise<Blob | null>((resolve) => {
    ;(canvas as HTMLCanvasElement).toBlob((nextBlob) => resolve(nextBlob), 'image/png')
  })
}

function preparedSpriteSurfaceCacheKey(
  imageUrl: string,
  crop: ReturnType<typeof normalizeCrop>,
  rasterWidth: number,
  rasterHeight: number,
) {
  return [
    imageUrl,
    crop.x.toFixed(4),
    crop.y.toFixed(4),
    crop.width.toFixed(4),
    crop.height.toFixed(4),
    rasterWidth,
    rasterHeight,
  ].join('|')
}

async function buildPreparedSpriteSurfaceUrl(
  imageUrl: string,
  crop: ReturnType<typeof normalizeCrop>,
  rasterWidth: number,
  rasterHeight: number,
) {
  if (typeof document === 'undefined' && typeof OffscreenCanvas === 'undefined') {
    return null
  }

  try {
    if (typeof createImageBitmap === 'function') {
      const sourceBitmap = await loadSourceImageBitmap(imageUrl)
      const sx = Math.max(0, Math.round(sourceBitmap.width * crop.x))
      const sy = Math.max(0, Math.round(sourceBitmap.height * crop.y))
      const sw = Math.max(1, Math.round(sourceBitmap.width * crop.width))
      const sh = Math.max(1, Math.round(sourceBitmap.height * crop.height))
      const preparedBitmap = await createImageBitmap(sourceBitmap, sx, sy, sw, sh, {
        resizeWidth: rasterWidth,
        resizeHeight: rasterHeight,
        resizeQuality: 'high',
      })

      const canvas =
        typeof OffscreenCanvas !== 'undefined'
          ? new OffscreenCanvas(rasterWidth, rasterHeight)
          : Object.assign(document.createElement('canvas'), { width: rasterWidth, height: rasterHeight })
      const context = canvas.getContext('2d')
      if (!context) {
        preparedBitmap.close()
        return null
      }

      context.clearRect(0, 0, rasterWidth, rasterHeight)
      context.drawImage(preparedBitmap, 0, 0)
      preparedBitmap.close()

      const blob = await canvasBlob(canvas)
      return blob ? URL.createObjectURL(blob) : null
    }
  } catch {
    // Fall back to the plain HTMLImageElement canvas path below.
  }

  const image = await loadSourceImageElement(imageUrl)
  const canvas = document.createElement('canvas')
  canvas.width = rasterWidth
  canvas.height = rasterHeight
  const context = canvas.getContext('2d')
  if (!context) {
    return null
  }

  context.clearRect(0, 0, rasterWidth, rasterHeight)
  context.drawImage(
    image,
    image.naturalWidth * crop.x,
    image.naturalHeight * crop.y,
    image.naturalWidth * crop.width,
    image.naturalHeight * crop.height,
    0,
    0,
    rasterWidth,
    rasterHeight,
  )

  const blob = await canvasBlob(canvas)

  return blob ? URL.createObjectURL(blob) : null
}

function usePreparedSpriteSurfaceUrl(
  imageUrl: string | undefined,
  crop: ReturnType<typeof normalizeCrop>,
  fitWorldWidth: number,
  fitWorldHeight: number,
  intrinsicSize?: Size,
) {
  const hasRenderableImage = Boolean(imageUrl)
  const { rasterWidth, rasterHeight } = intrinsicSize
    ? preparedSpriteSurfaceRasterSize(crop, fitWorldWidth, fitWorldHeight, intrinsicSize)
    : {
      rasterWidth: Math.max(1, Math.round(fitWorldWidth)),
      rasterHeight: Math.max(1, Math.round(fitWorldHeight)),
    }
  const cacheKey = imageUrl && hasRenderableImage
    ? preparedSpriteSurfaceCacheKey(imageUrl, crop, rasterWidth, rasterHeight)
    : undefined
  const cachedPreparedSurfaceUrl = cacheKey ? preparedSpriteSurfaceUrlCache.get(cacheKey) : undefined
  const [loadedPreparedSurface, setLoadedPreparedSurface] = useState<{ key: string; url: string | null } | undefined>(
    () => {
      if (!cacheKey || cachedPreparedSurfaceUrl === undefined) {
        return undefined
      }

      return {
        key: cacheKey,
        url: cachedPreparedSurfaceUrl,
      }
    },
  )

  useEffect(() => {
    if (!imageUrl || !cacheKey) {
      return
    }

    const cached = preparedSpriteSurfaceUrlCache.get(cacheKey)
    if (cached !== undefined) {
      return
    }

    let cancelled = false
    const request =
      preparedSpriteSurfaceRequestCache.get(cacheKey) ??
      buildPreparedSpriteSurfaceUrl(imageUrl, crop, rasterWidth, rasterHeight)
        .then((url) => {
          preparedSpriteSurfaceUrlCache.set(cacheKey, url)
          preparedSpriteSurfaceRequestCache.delete(cacheKey)
          return url
        })
        .catch(() => {
          preparedSpriteSurfaceUrlCache.set(cacheKey, null)
          preparedSpriteSurfaceRequestCache.delete(cacheKey)
          return null
        })

    preparedSpriteSurfaceRequestCache.set(cacheKey, request)
    void request.then((url) => {
      if (!cancelled) {
        setLoadedPreparedSurface({
          key: cacheKey,
          url,
        })
      }
    })

    return () => {
      cancelled = true
    }
  }, [cacheKey, crop, imageUrl, rasterHeight, rasterWidth])

  const loadedPreparedSurfaceUrl = loadedPreparedSurface?.key === cacheKey
    ? loadedPreparedSurface?.url
    : undefined

  const preparedSurfaceUrl =
    typeof loadedPreparedSurfaceUrl === 'string'
      ? loadedPreparedSurfaceUrl
      : typeof cachedPreparedSurfaceUrl === 'string'
        ? cachedPreparedSurfaceUrl
        : undefined

  let stage: 'preparing' | 'ready' | 'failed' | undefined
  if (!imageUrl || !cacheKey) {
    stage = undefined
  } else if (preparedSurfaceUrl) {
    stage = 'ready'
  } else if (loadedPreparedSurface?.key === cacheKey && loadedPreparedSurface?.url === null) {
    stage = 'failed'
  } else if (cachedPreparedSurfaceUrl === null) {
    stage = 'failed'
  } else {
    stage = 'preparing'
  }

  return {
    preparedSurfaceUrl,
    stage,
  }
}

function requestPreparedSpriteSurface(
  imageUrl: string,
  crop: ReturnType<typeof normalizeCrop>,
  fitWorldWidth: number,
  fitWorldHeight: number,
  intrinsicSize: Size,
) {
  const { rasterWidth, rasterHeight } = preparedSpriteSurfaceRasterSize(crop, fitWorldWidth, fitWorldHeight, intrinsicSize)
  const cacheKey = preparedSpriteSurfaceCacheKey(imageUrl, crop, rasterWidth, rasterHeight)
  const cached = preparedSpriteSurfaceUrlCache.get(cacheKey)
  if (cached !== undefined) {
    return Promise.resolve(cached)
  }

  const existingRequest = preparedSpriteSurfaceRequestCache.get(cacheKey)
  if (existingRequest) {
    return existingRequest
  }

  const request = buildPreparedSpriteSurfaceUrl(imageUrl, crop, rasterWidth, rasterHeight)
    .then((url) => {
      preparedSpriteSurfaceUrlCache.set(cacheKey, url)
      preparedSpriteSurfaceRequestCache.delete(cacheKey)
      return url
    })
    .catch(() => {
      preparedSpriteSurfaceUrlCache.set(cacheKey, null)
      preparedSpriteSurfaceRequestCache.delete(cacheKey)
      return null
    })

  preparedSpriteSurfaceRequestCache.set(cacheKey, request)
  return request
}

function composeCrop(
  parent: ReturnType<typeof normalizeCrop>,
  child: { x: number; y: number; width: number; height: number },
) {
  return normalizeCrop({
    x: parent.x + parent.width * child.x,
    y: parent.y + parent.height * child.y,
    width: parent.width * child.width,
    height: parent.height * child.height,
  })
}

async function analyzeLargestOpaqueRegion(
  imageUrl: string,
  crop: ReturnType<typeof normalizeCrop>,
) {
  if (typeof document === 'undefined') {
    return null
  }

  const image = await loadSourceImageElement(imageUrl)
  const cropPixelWidth = Math.max(1, Math.round(image.naturalWidth * crop.width))
  const cropPixelHeight = Math.max(1, Math.round(image.naturalHeight * crop.height))
  const analysisScale = Math.min(
    1,
    ALPHA_COMPONENT_ANALYSIS_MAX_DIMENSION / Math.max(cropPixelWidth, cropPixelHeight, 1),
  )
  const rasterWidth = Math.max(1, Math.round(cropPixelWidth * analysisScale))
  const rasterHeight = Math.max(1, Math.round(cropPixelHeight * analysisScale))
  const canvas = document.createElement('canvas')
  canvas.width = rasterWidth
  canvas.height = rasterHeight
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) {
    return null
  }

  context.clearRect(0, 0, rasterWidth, rasterHeight)
  context.drawImage(
    image,
    image.naturalWidth * crop.x,
    image.naturalHeight * crop.y,
    image.naturalWidth * crop.width,
    image.naturalHeight * crop.height,
    0,
    0,
    rasterWidth,
    rasterHeight,
  )

  const { data } = context.getImageData(0, 0, rasterWidth, rasterHeight)
  const alphaFilled = new Uint8Array(rasterWidth * rasterHeight)
  let alphaMinX = rasterWidth
  let alphaMinY = rasterHeight
  let alphaMaxX = -1
  let alphaMaxY = -1
  let alphaCount = 0
  for (let index = 0; index < alphaFilled.length; index += 1) {
    const alpha = data[index * 4 + 3]
    if (alpha < ALPHA_COMPONENT_THRESHOLD) {
      continue
    }

    alphaFilled[index] = 1
    alphaCount += 1
    const x = index % rasterWidth
    const y = Math.floor(index / rasterWidth)
    alphaMinX = Math.min(alphaMinX, x)
    alphaMinY = Math.min(alphaMinY, y)
    alphaMaxX = Math.max(alphaMaxX, x)
    alphaMaxY = Math.max(alphaMaxY, y)
  }

  let filled = alphaFilled
  const alphaOccupiesWholeRaster =
    alphaCount > 0 &&
    alphaMinX === 0 &&
    alphaMinY === 0 &&
    alphaMaxX === rasterWidth - 1 &&
    alphaMaxY === rasterHeight - 1

  if (!alphaOccupiesWholeRaster) {
    return FULL_CROP
  }

  if (alphaOccupiesWholeRaster) {
    const cornerSamples: Array<{ r: number; g: number; b: number; count: number }> = []
    const cornerOrigins = [
      { x: 0, y: 0 },
      { x: Math.max(0, rasterWidth - 3), y: 0 },
      { x: 0, y: Math.max(0, rasterHeight - 3) },
      { x: Math.max(0, rasterWidth - 3), y: Math.max(0, rasterHeight - 3) },
    ]

    for (const origin of cornerOrigins) {
      let r = 0
      let g = 0
      let b = 0
      let count = 0
      for (let sampleY = origin.y; sampleY < Math.min(rasterHeight, origin.y + 3); sampleY += 1) {
        for (let sampleX = origin.x; sampleX < Math.min(rasterWidth, origin.x + 3); sampleX += 1) {
          const pixelIndex = (sampleY * rasterWidth + sampleX) * 4
          if (data[pixelIndex + 3] < ALPHA_COMPONENT_THRESHOLD) {
            continue
          }
          r += data[pixelIndex]
          g += data[pixelIndex + 1]
          b += data[pixelIndex + 2]
          count += 1
        }
      }
      if (count > 0) {
        cornerSamples.push({ r, g, b, count })
      }
    }

    if (cornerSamples.length > 0) {
      const total = cornerSamples.reduce(
        (current, sample) => ({
          r: current.r + sample.r,
          g: current.g + sample.g,
          b: current.b + sample.b,
          count: current.count + sample.count,
        }),
        { r: 0, g: 0, b: 0, count: 0 },
      )
      const target = {
        r: total.r / total.count,
        g: total.g / total.count,
        b: total.b / total.count,
      }
      const backgroundMask = new Uint8Array(rasterWidth * rasterHeight)
      const queueX = new Int32Array(rasterWidth * rasterHeight)
      const queueY = new Int32Array(rasterWidth * rasterHeight)
      let head = 0
      let tail = 0
      const channelThreshold = 26
      const colorDistanceThreshold = 44 * 44

      const enqueueIfBackground = (x: number, y: number) => {
        const index = y * rasterWidth + x
        if (backgroundMask[index] || !alphaFilled[index]) {
          return
        }
        const pixelIndex = index * 4
        const dr = data[pixelIndex] - target.r
        const dg = data[pixelIndex + 1] - target.g
        const db = data[pixelIndex + 2] - target.b
        if (
          Math.abs(dr) > channelThreshold ||
          Math.abs(dg) > channelThreshold ||
          Math.abs(db) > channelThreshold ||
          dr * dr + dg * dg + db * db > colorDistanceThreshold
        ) {
          return
        }

        backgroundMask[index] = 1
        queueX[tail] = x
        queueY[tail] = y
        tail += 1
      }

      for (let x = 0; x < rasterWidth; x += 1) {
        enqueueIfBackground(x, 0)
        enqueueIfBackground(x, rasterHeight - 1)
      }
      for (let y = 1; y < rasterHeight - 1; y += 1) {
        enqueueIfBackground(0, y)
        enqueueIfBackground(rasterWidth - 1, y)
      }

      while (head < tail) {
        const x = queueX[head]
        const y = queueY[head]
        head += 1

        for (let deltaY = -1; deltaY <= 1; deltaY += 1) {
          for (let deltaX = -1; deltaX <= 1; deltaX += 1) {
            if (deltaX === 0 && deltaY === 0) {
              continue
            }

            const nextX = x + deltaX
            const nextY = y + deltaY
            if (nextX < 0 || nextY < 0 || nextX >= rasterWidth || nextY >= rasterHeight) {
              continue
            }

            enqueueIfBackground(nextX, nextY)
          }
        }
      }

      const trimmedFilled = new Uint8Array(rasterWidth * rasterHeight)
      let trimmedCount = 0
      for (let index = 0; index < trimmedFilled.length; index += 1) {
        if (alphaFilled[index] && !backgroundMask[index]) {
          trimmedFilled[index] = 1
          trimmedCount += 1
        }
      }

      if (trimmedCount > 0 && trimmedCount < alphaCount) {
        filled = trimmedFilled
      }
    }
  }

  const coreFilled = new Uint8Array(rasterWidth * rasterHeight)
  for (let y = 1; y < rasterHeight - 1; y += 1) {
    for (let x = 1; x < rasterWidth - 1; x += 1) {
      let isCorePixel = 1
      for (let deltaY = -1; deltaY <= 1 && isCorePixel; deltaY += 1) {
        for (let deltaX = -1; deltaX <= 1; deltaX += 1) {
          if (!filled[(y + deltaY) * rasterWidth + (x + deltaX)]) {
            isCorePixel = 0
            break
          }
        }
      }
      coreFilled[y * rasterWidth + x] = isCorePixel
    }
  }

  const analysisMask = coreFilled.some((value) => value === 1) ? coreFilled : filled
  const visited = new Uint8Array(rasterWidth * rasterHeight)
  let bestArea = 0
  let bestBounds:
    | {
        minX: number
        minY: number
        maxX: number
        maxY: number
      }
    | undefined

  const queueX = new Int32Array(rasterWidth * rasterHeight)
  const queueY = new Int32Array(rasterWidth * rasterHeight)

  for (let startY = 0; startY < rasterHeight; startY += 1) {
    for (let startX = 0; startX < rasterWidth; startX += 1) {
      const startIndex = startY * rasterWidth + startX
      if (visited[startIndex]) {
        continue
      }

      visited[startIndex] = 1
      if (!analysisMask[startIndex]) {
        continue
      }

      let head = 0
      let tail = 0
      queueX[tail] = startX
      queueY[tail] = startY
      tail += 1

      let area = 0
      let minX = startX
      let minY = startY
      let maxX = startX
      let maxY = startY

      while (head < tail) {
        const x = queueX[head]
        const y = queueY[head]
        head += 1
        area += 1
        minX = Math.min(minX, x)
        minY = Math.min(minY, y)
        maxX = Math.max(maxX, x)
        maxY = Math.max(maxY, y)

        for (let deltaY = -1; deltaY <= 1; deltaY += 1) {
          for (let deltaX = -1; deltaX <= 1; deltaX += 1) {
            if (deltaX === 0 && deltaY === 0) {
              continue
            }

            const nextX = x + deltaX
            const nextY = y + deltaY
            if (nextX < 0 || nextY < 0 || nextX >= rasterWidth || nextY >= rasterHeight) {
              continue
            }

            const nextIndex = nextY * rasterWidth + nextX
            if (visited[nextIndex]) {
              continue
            }

            visited[nextIndex] = 1
            if (!analysisMask[nextIndex]) {
              continue
            }

            queueX[tail] = nextX
            queueY[tail] = nextY
            tail += 1
          }
        }
      }

      if (area > bestArea) {
        bestArea = area
        bestBounds = { minX, minY, maxX, maxY }
      }
    }
  }

  if (!bestBounds || bestArea < 4) {
    return FULL_CROP
  }

  const padding = 1
  const minX = Math.max(0, bestBounds.minX - padding)
  const minY = Math.max(0, bestBounds.minY - padding)
  const maxX = Math.min(rasterWidth - 1, bestBounds.maxX + padding)
  const maxY = Math.min(rasterHeight - 1, bestBounds.maxY + padding)

  return normalizeCrop({
    x: minX / rasterWidth,
    y: minY / rasterHeight,
    width: (maxX - minX + 1) / rasterWidth,
    height: (maxY - minY + 1) / rasterHeight,
  })
}

function useLargestOpaqueRegion(
  imageUrl: string | undefined,
  crop: ReturnType<typeof normalizeCrop>,
) {
  const cacheKey = imageUrl
    ? [
        imageUrl,
        crop.x.toFixed(4),
        crop.y.toFixed(4),
        crop.width.toFixed(4),
        crop.height.toFixed(4),
      ].join('|')
    : undefined
  const cachedRegion = cacheKey ? opaqueRegionBoundsCache.get(cacheKey) : undefined
  const [loadedRegion, setLoadedRegion] = useState<
    | {
        key: string
        region: { x: number; y: number; width: number; height: number } | null
      }
    | undefined
  >(() => (
    cacheKey && cachedRegion !== undefined
      ? {
          key: cacheKey,
          region: cachedRegion,
        }
      : undefined
  ))

  useEffect(() => {
    if (!cacheKey || !imageUrl || cachedRegion !== undefined) {
      return
    }

    let cancelled = false
    const request =
      opaqueRegionRequestCache.get(cacheKey) ??
      analyzeLargestOpaqueRegion(imageUrl, crop)
        .then((result) => {
          opaqueRegionBoundsCache.set(cacheKey, result)
          opaqueRegionRequestCache.delete(cacheKey)
          return result
        })
        .catch(() => {
          opaqueRegionBoundsCache.set(cacheKey, FULL_CROP)
          opaqueRegionRequestCache.delete(cacheKey)
          return FULL_CROP
        })

    opaqueRegionRequestCache.set(cacheKey, request)
    void request.then((result) => {
      if (!cancelled) {
        setLoadedRegion({
          key: cacheKey,
          region: result,
        })
      }
    })

    return () => {
      cancelled = true
    }
  }, [cacheKey, cachedRegion, crop, imageUrl])

  if (cachedRegion !== undefined) {
    return cachedRegion ?? undefined
  }

  return loadedRegion && loadedRegion.key === cacheKey ? loadedRegion.region ?? undefined : undefined
}

function outlineSampleCount(radius: number) {
  const circumference = Math.PI * 2 * Math.max(radius, 1)

  return clamp(
    Math.ceil(circumference * 1.35),
    ALPHA_OUTLINE_MIN_SAMPLES,
    ALPHA_OUTLINE_MAX_SAMPLES,
  )
}

function renderAlphaOutlineCanvas(
  image: HTMLImageElement,
  regionCrop: ReturnType<typeof normalizeCrop>,
  metrics: {
    contentWidth: number
    contentHeight: number
    padX: number
    padY: number
    outlineRadius: number
  },
  selectionStrokeColor: string,
) {
  const { contentWidth, contentHeight, padX, padY, outlineRadius } = metrics
  const canvasWidth = contentWidth + padX * 2
  const canvasHeight = contentHeight + padY * 2
  const maskCanvas = document.createElement('canvas')
  maskCanvas.width = contentWidth
  maskCanvas.height = contentHeight
  const maskContext = maskCanvas.getContext('2d', { willReadFrequently: true })
  if (!maskContext) {
    return null
  }

  maskContext.clearRect(0, 0, contentWidth, contentHeight)
  maskContext.drawImage(
    image,
    image.naturalWidth * regionCrop.x,
    image.naturalHeight * regionCrop.y,
    image.naturalWidth * regionCrop.width,
    image.naturalHeight * regionCrop.height,
    0,
    0,
    contentWidth,
    contentHeight,
  )

  const maskImageData = maskContext.getImageData(0, 0, contentWidth, contentHeight)
  const { data } = maskImageData
  for (let index = 0; index < data.length; index += 4) {
    const alpha = data[index + 3]
    data[index] = 255
    data[index + 1] = 255
    data[index + 2] = 255
    data[index + 3] = alpha >= ALPHA_OUTLINE_RENDER_THRESHOLD ? alpha : 0
  }
  maskContext.putImageData(maskImageData, 0, 0)

  const outlineCanvas = document.createElement('canvas')
  outlineCanvas.width = canvasWidth
  outlineCanvas.height = canvasHeight
  const outlineContext = outlineCanvas.getContext('2d')
  if (!outlineContext) {
    return null
  }

  outlineContext.clearRect(0, 0, canvasWidth, canvasHeight)
  outlineContext.globalCompositeOperation = 'source-over'

  const samples = outlineSampleCount(outlineRadius)
  for (let sampleIndex = 0; sampleIndex < samples; sampleIndex += 1) {
    const angle = (sampleIndex / samples) * Math.PI * 2
    const offsetX = Math.cos(angle) * outlineRadius
    const offsetY = Math.sin(angle) * outlineRadius
    outlineContext.drawImage(maskCanvas, padX + offsetX, padY + offsetY)
  }

  outlineContext.globalCompositeOperation = 'destination-out'
  outlineContext.drawImage(maskCanvas, padX, padY)
  outlineContext.globalCompositeOperation = 'source-in'
  outlineContext.fillStyle = selectionStrokeColor
  outlineContext.fillRect(0, 0, canvasWidth, canvasHeight)
  outlineContext.globalCompositeOperation = 'source-over'

  return outlineCanvas
}

function useIntrinsicImageSize(url: string | undefined, initialSize?: Size) {
  const [loadedImage, setLoadedImage] = useState<{ url: string; size: Size } | undefined>(
    url && initialSize ? { url, size: initialSize } : undefined,
  )
  const cachedSize = url ? intrinsicImageSizeCache.get(url) : undefined

  useEffect(() => {
    if (initialSize?.width && initialSize.height) {
      return
    }

    if (!url || cachedSize !== undefined) {
      return
    }

    let cancelled = false
    void loadSourceImageElement(url)
      .then((image) => {
        if (cancelled || image.naturalWidth <= 0 || image.naturalHeight <= 0) {
          return
        }

        const nextSize = {
          width: image.naturalWidth,
          height: image.naturalHeight,
        }
        intrinsicImageSizeCache.set(url, nextSize)
        setLoadedImage({ url, size: nextSize })
      })
      .catch(() => {
        intrinsicImageSizeCache.set(url, null)
      })

    return () => {
      cancelled = true
    }
  }, [cachedSize, initialSize, url])

  return initialSize ?? (loadedImage?.url === url ? loadedImage?.size : cachedSize ?? undefined)
}

interface BoardSurfaceProps {
  spec: SpriteSpec
  fallbackLabel: string
  size: Size
  imageAssets: ReadonlyMap<AutomergeUrl, ResolvedImageAsset>
  rounded: boolean
  className?: string
}

interface BoardSurfaceLayout {
  imageUrl?: string
  intrinsicSize?: Size
  crop: ReturnType<typeof normalizeCrop>
  fitWidth: number
  fitHeight: number
  labelFontSize: number
  surfaceBackground: string
}

function useBoardSurfaceLayout(
  spec: SpriteSpec,
  size: Size,
  imageAssets: ReadonlyMap<AutomergeUrl, ResolvedImageAsset>,
  rounded: boolean,
): BoardSurfaceLayout {
  const imageSource = spec.kind === 'image-url' ? resolveImageSource(spec.url, imageAssets) : undefined
  const imageUrl = imageSource?.renderUrl
  useSourceImagePreload(imageUrl)
  const originalIntrinsicSize = useIntrinsicImageSize(
    imageUrl,
    imageSource?.asset?.width && imageSource.asset.height
      ? {
        width: imageSource.asset.width,
          height: imageSource.asset.height,
        }
      : undefined,
  )

  const crop = normalizeCrop(spec.crop)
  const intrinsicSize = originalIntrinsicSize
  const targetAspect = size.width > 0 && size.height > 0 ? size.width / size.height : 1
  const sourceAspect = intrinsicSize
    ? intrinsicSize.width / intrinsicSize.height
    : targetAspect * (crop.height / crop.width)
  const cropAspect = sourceAspect * crop.width / crop.height
  const fit = spec.fit ?? 'cover'
  const surfaceBackground =
    spec.bg ?? (imageUrl && !rounded ? 'transparent' : rounded ? '#f8efe1' : '#d8d2c1')

  let fitWidth = 1
  let fitHeight = 1
  if (fit === 'contain') {
    if (cropAspect > targetAspect) {
      fitHeight = targetAspect / cropAspect
    } else {
      fitWidth = cropAspect / targetAspect
    }
  } else if (cropAspect > targetAspect) {
    fitWidth = cropAspect / targetAspect
  } else {
    fitHeight = targetAspect / cropAspect
  }

  const labelFontSize = Math.max(12, Math.min(size.width, size.height) * (rounded ? 0.14 : 0.08))

  return {
    imageUrl,
    intrinsicSize,
    crop,
    fitWidth,
    fitHeight,
    labelFontSize,
    surfaceBackground,
  }
}

function BoardSurface({
  spec,
  fallbackLabel,
  size,
  imageAssets,
  rounded,
  className,
}: BoardSurfaceProps) {
  const {
    imageUrl,
    intrinsicSize,
    crop,
    fitWidth,
    fitHeight,
    labelFontSize,
    surfaceBackground,
  } = useBoardSurfaceLayout(spec, size, imageAssets, rounded)
  const fitWorldWidth = size.width * fitWidth
  const fitWorldHeight = size.height * fitHeight
  const { preparedSurfaceUrl, stage } = usePreparedSpriteSurfaceUrl(
    imageUrl,
    crop,
    fitWorldWidth,
    fitWorldHeight,
    intrinsicSize,
  )

  return (
    <div
      className={`board-surface ${rounded ? 'is-rounded' : 'is-square'}${className ? ` ${className}` : ''}`}
      style={{
        background: surfaceBackground,
        color: spec.fg ?? '#1d2428',
      }}
    >
      {imageUrl ? (
        <div className="board-sprite-frame">
          <div
            className="board-sprite-fit-frame"
            style={{
              width: `${fitWidth * 100}%`,
              height: `${fitHeight * 100}%`,
            }}
          >
            <img
              className="board-sprite-image"
              src={preparedSurfaceUrl}
              alt=""
              draggable={false}
              decoding="async"
              loading="eager"
              fetchPriority="high"
              data-board-sprite-stage={stage}
              style={{
                width: '100%',
                height: '100%',
                opacity: preparedSurfaceUrl ? 1 : 0,
              }}
            />
          </div>
        </div>
      ) : (
        <div className="board-surface-label" style={{ fontSize: `${labelFontSize}px` }}>
          {spec.label ?? fallbackLabel}
        </div>
      )}
    </div>
  )
}

interface CardObjectProps {
  cardId: Id
  room: RoomDoc
  currentPlayerId: string | undefined
  imageAssets: ReadonlyMap<AutomergeUrl, ResolvedImageAsset>
  size: Size
  constrainedEffects: boolean
}

function CardObject({ cardId, room, currentPlayerId, imageAssets, size, constrainedEffects }: CardObjectProps) {
  const card = room.objects[cardId]
  if (!isCard(card)) {
    return null
  }

  const faceVisible = canSeeCardFace(card, currentPlayerId)
  const visibleSpec = faceVisible ? card.face : card.back
  const visibleFallbackLabel = faceVisible ? card.name : 'Back'

  if (constrainedEffects) {
    return (
      <div className="board-card-shell is-constrained">
        <BoardSurface
          spec={visibleSpec}
          fallbackLabel={visibleFallbackLabel}
          size={size}
          imageAssets={imageAssets}
          rounded
        />
      </div>
    )
  }

  return (
    <div className="board-card-shell">
      <div className={`board-card-flip ${faceVisible ? 'is-face-visible' : 'is-back-visible'}`}>
        <div className="board-card-face board-card-front">
          <BoardSurface
            spec={card.face}
            fallbackLabel={card.name}
            size={size}
            imageAssets={imageAssets}
            rounded
          />
        </div>
        <div className="board-card-face board-card-back">
          <BoardSurface
            spec={card.back}
            fallbackLabel="Back"
            size={size}
            imageAssets={imageAssets}
            rounded
          />
        </div>
      </div>
    </div>
  )
}

interface DeckObjectProps {
  deckId: Id
  room: RoomDoc
  currentPlayerId: string | undefined
  imageAssets: ReadonlyMap<AutomergeUrl, ResolvedImageAsset>
  size: Size
}

function DeckObject({ deckId, room, currentPlayerId, imageAssets, size }: DeckObjectProps) {
  const deck = room.objects[deckId]
  const deckChildIds = isDeck(deck) ? deck.childIds : []
  const stackCount = Math.min(deckChildIds.length, 4)
  const stackDepth = Math.max(0, stackCount - 1)
  const topCardId = deckChildIds[deckChildIds.length - 1]
  const topCard = topCardId ? room.objects[topCardId] : undefined
  const topCardSpec =
    isCard(topCard) && canSeeCardFace(topCard, currentPlayerId) ? topCard.face : isCard(topCard) ? topCard.back : undefined

  if (!isDeck(deck)) {
    return null
  }

  return (
    <div className={`board-deck-shell ${stackCount === 0 ? 'is-empty' : ''}`}>
      {stackCount === 0 ? (
        <div className="board-deck-empty" />
      ) : (
        <>
          {Array.from({ length: Math.max(0, stackCount - 1) }).map((_, index) => (
            <div
              key={`shadow-${index}`}
              className="board-deck-layer board-deck-shadow-layer"
              style={{
                transform: `translate(${(index - stackDepth) * 4}px, ${(index - stackDepth) * 3}px)`,
              }}
            />
          ))}
          <div className="board-deck-layer board-deck-top-layer">
            {topCardSpec ? (
              <BoardSurface
                spec={topCardSpec}
                fallbackLabel={isCard(topCard) ? topCard.name : deck.name}
                size={size}
                imageAssets={imageAssets}
                rounded
              />
            ) : (
              <BoardSurface
                spec={{ kind: 'label', label: deck.name, bg: '#f2e3ca', fg: '#1c2125' }}
                fallbackLabel={deck.name}
                size={size}
                imageAssets={imageAssets}
                rounded
              />
            )}
          </div>
          <div className="board-deck-count">{deck.childIds.length}</div>
        </>
      )}
    </div>
  )
}

interface BoardObjectContentProps {
  objectId: Id
  room: RoomDoc
  currentPlayerId: string | undefined
  imageAssets: ReadonlyMap<AutomergeUrl, ResolvedImageAsset>
  size: Size
  constrainedEffects: boolean
}

function BoardObjectContent({
  objectId,
  room,
  currentPlayerId,
  imageAssets,
  size,
  constrainedEffects,
}: BoardObjectContentProps) {
  const object = room.objects[objectId]
  if (isCard(object)) {
    return (
      <CardObject
        cardId={objectId}
        room={room}
        currentPlayerId={currentPlayerId}
        imageAssets={imageAssets}
        size={size}
        constrainedEffects={constrainedEffects}
      />
    )
  }

  if (isDeck(object)) {
    return (
      <DeckObject
        deckId={objectId}
        room={room}
        currentPlayerId={currentPlayerId}
        imageAssets={imageAssets}
        size={size}
      />
    )
  }

  if (isBoard(object)) {
    return (
      <BoardSurface
        spec={isBoardFaceUp(object) ? object.face : object.back}
        fallbackLabel={object.name}
        size={size}
        imageAssets={imageAssets}
        rounded={false}
      />
    )
  }

  return null
}

const MemoBoardObjectContent = memo(BoardObjectContent, (prevProps, nextProps) => {
  if (prevProps.objectId !== nextProps.objectId) {
    return false
  }
  if (prevProps.currentPlayerId !== nextProps.currentPlayerId) {
    return false
  }
  if (prevProps.imageAssets !== nextProps.imageAssets) {
    return false
  }
  if (prevProps.constrainedEffects !== nextProps.constrainedEffects) {
    return false
  }
  if (
    prevProps.size.width !== nextProps.size.width ||
    prevProps.size.height !== nextProps.size.height
  ) {
    return false
  }

  const prevObject = prevProps.room.objects[prevProps.objectId]
  const nextObject = nextProps.room.objects[nextProps.objectId]
  if (prevObject !== nextObject) {
    return false
  }

  if (isDeck(prevObject) && isDeck(nextObject)) {
    const prevTopCardId = prevObject.childIds[prevObject.childIds.length - 1]
    const nextTopCardId = nextObject.childIds[nextObject.childIds.length - 1]
    if (prevTopCardId !== nextTopCardId) {
      return false
    }
    if (
      prevTopCardId &&
      nextTopCardId &&
      prevProps.room.objects[prevTopCardId] !== nextProps.room.objects[nextTopCardId]
    ) {
      return false
    }
  }

  return true
})

interface BoardSelectionOverlayProps {
  spec: SpriteSpec
  size: Size
  imageAssets: ReadonlyMap<AutomergeUrl, ResolvedImageAsset>
  cameraZoom: number
  selectionStrokeWidth: number
  selectionStrokeColor: string
}

function BoardSelectionOverlay({
  spec,
  size,
  imageAssets,
  cameraZoom,
  selectionStrokeWidth,
  selectionStrokeColor,
}: BoardSelectionOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const outlineRenderVersionRef = useRef(0)
  const { imageUrl, crop, fitWidth, fitHeight, surfaceBackground } = useBoardSurfaceLayout(spec, size, imageAssets, false)
  const dominantRegion = useLargestOpaqueRegion(imageUrl, crop)
  const isAlphaSelection = Boolean(imageUrl && surfaceBackground === 'transparent')

  const region = dominantRegion ?? FULL_CROP
  const regionCrop = composeCrop(crop, region)
  const regionCropX = regionCrop.x
  const regionCropY = regionCrop.y
  const regionCropWidth = regionCrop.width
  const regionCropHeight = regionCrop.height

  const fitWorldWidth = Math.max(1, size.width * fitWidth * region.width)
  const fitWorldHeight = Math.max(1, size.height * fitHeight * region.height)
  const fitScreenWidth = fitWorldWidth * cameraZoom
  const fitScreenHeight = fitWorldHeight * cameraZoom
  const outlineScreenRadius = selectionStrokeWidth
  const safeZoom = Math.max(cameraZoom, 0.001)
  const padScreenX = Math.max(2, Math.ceil(outlineScreenRadius + 2))
  const padScreenY = Math.max(2, Math.ceil(outlineScreenRadius + 2))
  const padWorldX = padScreenX / safeZoom
  const padWorldY = padScreenY / safeZoom
  const padPercentX = Number(((padWorldX / fitWorldWidth) * 100).toFixed(3))
  const padPercentY = Number(((padWorldY / fitWorldHeight) * 100).toFixed(3))

  const rasterMetrics = useMemo(() => {
    const devicePixelRatio = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1
    const desiredWidth = Math.max(1, (fitScreenWidth + padScreenX * 2) * devicePixelRatio)
    const desiredHeight = Math.max(1, (fitScreenHeight + padScreenY * 2) * devicePixelRatio)
    const rasterScale = Math.min(
      1,
      ALPHA_OUTLINE_MAX_RASTER_DIMENSION / Math.max(desiredWidth, desiredHeight),
    )

    return {
      contentWidth: Math.max(1, Math.round(fitScreenWidth * devicePixelRatio * rasterScale)),
      contentHeight: Math.max(1, Math.round(fitScreenHeight * devicePixelRatio * rasterScale)),
      padX: Math.max(1, Math.round(padScreenX * devicePixelRatio * rasterScale)),
      padY: Math.max(1, Math.round(padScreenY * devicePixelRatio * rasterScale)),
      outlineRadius: Math.max(0.75, outlineScreenRadius * devicePixelRatio * rasterScale),
    }
  }, [fitScreenHeight, fitScreenWidth, outlineScreenRadius, padScreenX, padScreenY])

  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !imageUrl || !isAlphaSelection) {
      return
    }

    const renderVersion = outlineRenderVersionRef.current + 1
    outlineRenderVersionRef.current = renderVersion
    let cancelled = false

    const commitRenderedOutline = (renderedCanvas: HTMLCanvasElement | null) => {
      if (
        cancelled ||
        outlineRenderVersionRef.current !== renderVersion ||
        !renderedCanvas
      ) {
        return
      }

      const liveCanvas = canvasRef.current
      if (!liveCanvas) {
        return
      }

      if (liveCanvas.width !== renderedCanvas.width) {
        liveCanvas.width = renderedCanvas.width
      }
      if (liveCanvas.height !== renderedCanvas.height) {
        liveCanvas.height = renderedCanvas.height
      }

      const context = liveCanvas.getContext('2d')
      if (!context) {
        return
      }

      context.clearRect(0, 0, liveCanvas.width, liveCanvas.height)
      context.drawImage(renderedCanvas, 0, 0)
    }

    const renderOutline = (image: HTMLImageElement) => {
      const renderedCanvas = renderAlphaOutlineCanvas(
        image,
        {
          x: regionCropX,
          y: regionCropY,
          width: regionCropWidth,
          height: regionCropHeight,
        },
        rasterMetrics,
        selectionStrokeColor,
      )
      commitRenderedOutline(renderedCanvas)
    }

    const resolvedImage = resolvedSourceImageElementCache.get(imageUrl)
    if (resolvedImage) {
      renderOutline(resolvedImage)
    } else {
      void loadSourceImageElement(imageUrl).then((image) => {
        if (!cancelled) {
          renderOutline(image)
        }
      })
    }

    return () => {
      cancelled = true
    }
  }, [imageUrl, isAlphaSelection, rasterMetrics, regionCropHeight, regionCropWidth, regionCropX, regionCropY, selectionStrokeColor])

  if (!isAlphaSelection) {
    return null
  }

  return (
    <div
      className="board-object-selection is-alpha"
      style={
        {
          '--board-selection-width': `${selectionStrokeWidth}px`,
          '--board-selection-color': selectionStrokeColor,
        } as CSSProperties
      }
    >
      <div className="board-sprite-frame">
        <div
          className="board-sprite-fit-frame"
          style={{
            width: `${fitWidth * 100}%`,
            height: `${fitHeight * 100}%`,
          }}
        >
          <div
            className="board-selection-alpha-region"
            style={{
              left: `${region.x * 100}%`,
              top: `${region.y * 100}%`,
              width: `${region.width * 100}%`,
              height: `${region.height * 100}%`,
            }}
          >
            <canvas
              ref={canvasRef}
              className="board-selection-alpha-canvas"
              aria-hidden="true"
              style={{
                left: `${-padPercentX}%`,
                top: `${-padPercentY}%`,
                width: `${100 + padPercentX * 2}%`,
                height: `${100 + padPercentY * 2}%`,
              }}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

export function BoardView({
  room,
  roomUrl,
  imageAssets,
  dropImageError,
  ephemeralTransforms = {},
  selectionMode,
  selectedId,
  selectedIds,
  lassoMode,
  currentPlayerId,
  canEdit,
  allowSelectLocked,
  initialCamera,
  onCameraChange,
  onSelect,
  onToggleGroupSelection,
  onAddToGroupSelection,
  onCommitTransform,
  onPreviewTransform,
  onClearPreviewTransform,
  onDropObjectOntoObject,
  onBringObjectToFront,
  onLiftTopCardFromDeck,
  onFlipCard,
  onFlipBoard,
  onFlipDeck: _onFlipDeck,
  onDrawDeck: _onDrawDeck,
  onDropImageFileAt,
  onShuffleDeck,
  onOpenSelectionPanel,
}: BoardViewProps) {
  void _onFlipDeck
  void _onDrawDeck

  const rootRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const boardWorldRef = useRef<HTMLDivElement>(null)
  const boardGridRef = useRef<HTMLDivElement>(null)
  const quickActionsRef = useRef<HTMLDivElement>(null)
  const roomRef = useRef(room)
  const cameraRef = useRef(clampCamera(initialCamera))
  const recorderContextRef = useRef({
    roomUrl,
    href: typeof window === 'undefined' ? '' : window.location.href,
    hash: typeof window === 'undefined' ? '' : window.location.hash,
    camera: clampCamera(initialCamera),
    viewport: { width: 1, height: 1 },
    selectedId,
    selectedIds,
    canEdit,
    objectCount: Object.keys(room.objects).length,
  })
  const ephemeralTransformsRef = useRef(ephemeralTransforms)
  const onClearPreviewTransformRef = useRef(onClearPreviewTransform)
  const selectionModeRef = useRef(selectionMode)
  const previewTransformsRef = useRef<EphemeralTransformMap>({})
  const dragRef = useRef<DragState | null>(null)
  const pendingDeckPressRef = useRef<PendingDeckPress | null>(null)
  const tapCandidateRef = useRef<TapCandidate | null>(null)
  const backgroundTapCandidateRef = useRef<BackgroundTapCandidate | null>(null)
  const lassoRef = useRef<LassoState | null>(null)
  const cameraPointersRef = useRef<Map<number, Point>>(new Map())
  const pendingCameraUpdateRef = useRef<((current: CameraState) => CameraState) | null>(null)
  const cameraAnimationFrameRef = useRef<number | null>(null)
  const cameraRenderSyncTimeoutRef = useRef<number | null>(null)
  const cameraMomentumFrameRef = useRef<number | null>(null)
  const cameraMomentumPositionRef = useRef<Point>({ x: 0, y: 0 })
  const cameraMomentumVelocityRef = useRef<Point>({ x: 0, y: 0 })
  const cameraMomentumTimeRef = useRef(performance.now() / 1000)
  const prewarmPauseUntilRef = useRef(
    typeof performance === 'undefined' ? 0 : performance.now() + PREPARED_SPRITE_PREWARM_INITIAL_DELAY_MS,
  )
  const hasActiveAlphaSelectionRef = useRef(false)
  const hasQuickActionsRef = useRef(false)
  const selectedWorldObjectRef = useRef<{ transform: Transform2D; worldSize: Size } | undefined>(undefined)
  const pointerPanStateRef = useRef<{
    active: boolean
    lastVelocity: Point
    lastSampleTime: number
    recentSamples: Array<{ point: Point; time: number }>
  }>({
    active: false,
    lastVelocity: { x: 0, y: 0 },
    lastSampleTime: performance.now() / 1000,
    recentSamples: [],
  })
  const dropDepthRef = useRef(0)
  const [viewportSize, setViewportSize] = useState<Size>({ width: 1, height: 1 })
  const [camera, setCamera] = useState(() => cameraRef.current)
  const [liveSelectionZoom, setLiveSelectionZoom] = useState(() => cameraRef.current.zoom)
  const [previewTransforms, setPreviewTransforms] = useState<EphemeralTransformMap>({})
  const [hoverDropTargetId, setHoverDropTargetId] = useState<Id | undefined>()
  const [lassoPath, setLassoPath] = useState<Point[]>([])
  const [isImageDropTarget, setIsImageDropTarget] = useState(false)
  const constrainedEffects = useMemo(() => isLikelyMobileSafari(), [])

  roomRef.current = room
  recorderContextRef.current = {
    roomUrl,
    href: typeof window === 'undefined' ? '' : window.location.href,
    hash: typeof window === 'undefined' ? '' : window.location.hash,
    camera: cameraRef.current,
    viewport: viewportSize,
    selectedId,
    selectedIds,
    canEdit,
    objectCount: Object.keys(room.objects).length,
  }
  ephemeralTransformsRef.current = ephemeralTransforms
  onClearPreviewTransformRef.current = onClearPreviewTransform
  selectionModeRef.current = selectionMode
  previewTransformsRef.current = previewTransforms

  const replacePreviewTransforms = useCallback((nextTransforms: EphemeralTransformMap) => {
    previewTransformsRef.current = nextTransforms
    setPreviewTransforms((current) => (sameTransformMap(current, nextTransforms) ? current : nextTransforms))
  }, [])

  const clearPendingDeckPress = useCallback(() => {
    const pendingDeckPress = pendingDeckPressRef.current
    if (!pendingDeckPress) {
      return
    }

    window.clearTimeout(pendingDeckPress.timeoutId)
    pendingDeckPressRef.current = null
  }, [])

  const beginCameraPointer = useCallback((pointerId: number, localPoint: Point) => {
    cameraPointersRef.current.set(pointerId, localPoint)
    if (cameraPointersRef.current.size === 1) {
      const now = performance.now() / 1000
      pointerPanStateRef.current = {
        active: true,
        lastVelocity: { x: 0, y: 0 },
        lastSampleTime: now,
        recentSamples: [{ point: localPoint, time: now }],
      }
    }
  }, [])

  const cancelTouchObjectInteraction = useCallback((handoffPointer?: { pointerId: number; localPoint: Point }) => {
    clearPendingDeckPress()
    tapCandidateRef.current = null
    backgroundTapCandidateRef.current = null

    const activeDrag = dragRef.current
    if (!activeDrag) {
      if (handoffPointer) {
        cameraPointersRef.current.set(handoffPointer.pointerId, handoffPointer.localPoint)
      }
      return
    }

    if (handoffPointer) {
      cameraPointersRef.current.set(activeDrag.pointerId, activeDrag.currentPoint)
      cameraPointersRef.current.set(handoffPointer.pointerId, handoffPointer.localPoint)
    }

    dragRef.current = null
    setHoverDropTargetId(undefined)
    if (activeDrag.groupMembers && activeDrag.groupMembers.length > 0) {
      for (const member of activeDrag.groupMembers) {
        onClearPreviewTransform(member.id)
      }
    } else {
      onClearPreviewTransform(activeDrag.id)
    }
    replacePreviewTransforms({})
  }, [clearPendingDeckPress, onClearPreviewTransform, replacePreviewTransforms])

  const currentTransformForObject = useCallback((objectId: Id) => {
    return displayedTransformForObject(
      roomRef.current,
      objectId,
      ephemeralTransformsRef.current,
      previewTransformsRef.current,
    )
  }, [])

  const applyQuickActionsPosition = useCallback((nextCamera: CameraState) => {
    const quickActions = quickActionsRef.current
    const selectedObject = selectedWorldObjectRef.current
    if (!quickActions || !selectedObject || !hasQuickActionsRef.current) {
      return
    }

    const screenPoint = logicalToScreen(viewportSize, nextCamera, {
      x: selectedObject.transform.x,
      y: selectedObject.transform.y,
    })
    quickActions.style.left = `${screenPoint.x}px`
    quickActions.style.top = `${screenPoint.y - selectedObject.worldSize.height * nextCamera.zoom / 2 - 24}px`
  }, [viewportSize])

  const applyCameraToBoardWorld = useCallback((nextCamera: CameraState) => {
    const boardWorld = boardWorldRef.current
    const boardGrid = boardGridRef.current
    if (!boardWorld) {
      return
    }

    const { x: translateX, y: translateY } = cameraTranslation(viewportSize, nextCamera)
    boardWorld.style.transform = `translate3d(${translateX}px, ${translateY}px, 0) scale(${nextCamera.zoom})`
    boardWorld.style.setProperty('--board-zoom', `${nextCamera.zoom}`)
    if (boardGrid) {
      applyBoardGridScreenStyle(boardGrid, viewportSize, nextCamera)
      boardGrid.style.setProperty('--board-zoom', `${nextCamera.zoom}`)
    }
    applyQuickActionsPosition(nextCamera)
  }, [applyQuickActionsPosition, viewportSize])

  const markPrewarmInteraction = useCallback(() => {
    if (typeof performance === 'undefined') {
      return
    }

    prewarmPauseUntilRef.current = performance.now() + PREPARED_SPRITE_PREWARM_QUIET_MS
  }, [])

  const scheduleCameraRenderSync = useCallback(() => {
    if (cameraRenderSyncTimeoutRef.current !== null) {
      window.clearTimeout(cameraRenderSyncTimeoutRef.current)
    }

    cameraRenderSyncTimeoutRef.current = window.setTimeout(() => {
      cameraRenderSyncTimeoutRef.current = null
      setCamera((current) => (sameCamera(current, cameraRef.current) ? current : cameraRef.current))
    }, 90)
  }, [])

  const applyCommittedCamera = useCallback((nextCamera: CameraState) => {
    cameraRef.current = nextCamera
    cameraMomentumPositionRef.current = cameraTranslation(viewportSize, nextCamera)
    recorderContextRef.current.camera = nextCamera
    applyCameraToBoardWorld(nextCamera)
    if (hasActiveAlphaSelectionRef.current) {
      setLiveSelectionZoom((current) => (current === nextCamera.zoom ? current : nextCamera.zoom))
    }
    scheduleCameraRenderSync()
  }, [applyCameraToBoardWorld, scheduleCameraRenderSync, viewportSize])

  const resetPointerPanState = useCallback(() => {
    pointerPanStateRef.current = {
      active: false,
      lastVelocity: { x: 0, y: 0 },
      lastSampleTime: performance.now() / 1000,
      recentSamples: [],
    }
  }, [])

  const stopCameraMomentum = useCallback(() => {
    if (cameraMomentumFrameRef.current !== null) {
      window.cancelAnimationFrame(cameraMomentumFrameRef.current)
      cameraMomentumFrameRef.current = null
    }

    cameraMomentumVelocityRef.current = { x: 0, y: 0 }
    cameraMomentumTimeRef.current = performance.now() / 1000
  }, [])

  const startCameraMomentum = useCallback((velocity: Point) => {
    stopCameraMomentum()
    cameraMomentumPositionRef.current = cameraTranslation(viewportSize, cameraRef.current)
    cameraMomentumVelocityRef.current = {
      x: velocity.x * PAN_MOMENTUM_VELOCITY_GAIN,
      y: velocity.y * PAN_MOMENTUM_VELOCITY_GAIN,
    }
    cameraMomentumTimeRef.current = performance.now() / 1000

    const tickMomentum = () => {
      const currentCamera = cameraRef.current
      const now = performance.now() / 1000
      let dt = now - cameraMomentumTimeRef.current
      cameraMomentumTimeRef.current = now
      if (dt > PAN_MOMENTUM_MAX_DT_SECONDS) {
        dt = PAN_MOMENTUM_MAX_DT_SECONDS
      }
      if (dt <= 0) {
        cameraMomentumFrameRef.current = window.requestAnimationFrame(tickMomentum)
        return
      }

      const decay = Math.exp(-PAN_MOMENTUM_DECAY * dt)
      let nextVelocityX = cameraMomentumVelocityRef.current.x * decay
      let nextVelocityY = cameraMomentumVelocityRef.current.y * decay
      const unconstrainedTranslation = {
        x: cameraMomentumPositionRef.current.x + nextVelocityX * dt,
        y: cameraMomentumPositionRef.current.y + nextVelocityY * dt,
      }
      const nextCamera = cameraFromTranslation(viewportSize, unconstrainedTranslation, currentCamera.zoom)
      const constrainedTranslation = cameraTranslation(viewportSize, nextCamera)

      if (Math.abs(constrainedTranslation.x - unconstrainedTranslation.x) > PAN_MOMENTUM_CONSTRAINT_EPSILON) {
        nextVelocityX = 0
      }
      if (Math.abs(constrainedTranslation.y - unconstrainedTranslation.y) > PAN_MOMENTUM_CONSTRAINT_EPSILON) {
        nextVelocityY = 0
      }

      cameraMomentumPositionRef.current = constrainedTranslation
      cameraMomentumVelocityRef.current = {
        x: nextVelocityX,
        y: nextVelocityY,
      }

      if (!sameCamera(currentCamera, nextCamera)) {
        applyCommittedCamera(nextCamera)
        markPrewarmInteraction()
      }

      const screenVelocity = Math.hypot(nextVelocityX, nextVelocityY) * nextCamera.zoom
      if (screenVelocity >= PAN_MOMENTUM_CUTOFF_SCREEN_VELOCITY) {
        cameraMomentumFrameRef.current = window.requestAnimationFrame(tickMomentum)
      } else {
        stopCameraMomentum()
      }
    }

    cameraMomentumFrameRef.current = window.requestAnimationFrame(tickMomentum)
  }, [applyCommittedCamera, markPrewarmInteraction, stopCameraMomentum, viewportSize])

  const flushPendingCameraUpdate = useCallback(() => {
    if (cameraAnimationFrameRef.current !== null) {
      window.cancelAnimationFrame(cameraAnimationFrameRef.current)
      cameraAnimationFrameRef.current = null
    }

    const pendingUpdate = pendingCameraUpdateRef.current
    if (!pendingUpdate) {
      return
    }

    pendingCameraUpdateRef.current = null
    const clamped = clampCamera(pendingUpdate(cameraRef.current))
    if (sameCamera(cameraRef.current, clamped)) {
      return
    }

    applyCommittedCamera(clamped)
  }, [applyCommittedCamera])

  const updateCamera = useCallback((nextCamera: CameraState | ((current: CameraState) => CameraState)) => {
    const updater = typeof nextCamera === 'function' ? nextCamera : () => nextCamera
    const pendingUpdate = pendingCameraUpdateRef.current
    pendingCameraUpdateRef.current = pendingUpdate
      ? (current) => updater(pendingUpdate(current))
      : updater

    if (cameraAnimationFrameRef.current !== null) {
      return
    }

    cameraAnimationFrameRef.current = window.requestAnimationFrame(() => {
      cameraAnimationFrameRef.current = null
      const scheduledUpdate = pendingCameraUpdateRef.current
      if (!scheduledUpdate) {
        return
      }

      pendingCameraUpdateRef.current = null
      const clamped = clampCamera(scheduledUpdate(cameraRef.current))
      if (sameCamera(cameraRef.current, clamped)) {
        return
      }

      applyCommittedCamera(clamped)
    })
  }, [applyCommittedCamera])

  useLayoutEffect(() => {
    applyCameraToBoardWorld(cameraRef.current)
  }, [applyCameraToBoardWorld])

  const startDrag = useCallback((
    id: Id,
    pointerId: number,
    mode: DragState['mode'],
    startPoint: Point,
    startTransform: Transform2D,
    groupMembers?: DragState['groupMembers'],
  ) => {
    tapCandidateRef.current = null
    cameraPointersRef.current.delete(pointerId)
    dragRef.current = {
      id,
      pointerId,
      mode,
      startPointer: screenToLogical(viewportSize, cameraRef.current, startPoint),
      startTransform: { ...startTransform },
      currentPoint: startPoint,
      moved: false,
      raisedToFront: false,
      groupMembers,
    }
  }, [viewportSize])

  useEffect(() => {
    onCameraChange(camera)
  }, [camera, onCameraChange])

  useEffect(() => {
    if (!import.meta.env.DEV) {
      return
    }

    const host = hostRef.current
    const root = rootRef.current
    if (!host || !root) {
      return
    }

    return bindBoardInputRecorder({
      host,
      root,
      getContext: () => recorderContextRef.current,
    })
  }, [])

  useEffect(() => {
    if (!import.meta.env.DEV) {
      return
    }

    recordBoardInputRecorderCamera(camera)
  }, [camera])

  useEffect(() => {
    if (!import.meta.env.DEV) {
      return
    }

    recordBoardInputRecorderSelection(selectedId, selectedIds)
  }, [selectedId, selectedIds])

  useEffect(() => {
    if (!import.meta.env.DEV) {
      return
    }

    recordBoardInputRecorderViewport(viewportSize)
  }, [viewportSize])

  useEffect(() => {
    const host = hostRef.current
    if (!host) {
      return
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) {
        return
      }

      const nextViewport = {
        width: Math.max(1, Math.round(entry.contentRect.width)),
        height: Math.max(1, Math.round(entry.contentRect.height)),
      }
      setViewportSize((current) =>
        current.width === nextViewport.width && current.height === nextViewport.height ? current : nextViewport,
      )
    })

    observer.observe(host)
    return () => {
      observer.disconnect()
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    const tasks = Object.values(room.objects).flatMap((object) => {
      if (isCard(object)) {
        const visibleSpec = canSeeCardFace(object, currentPlayerId) ? object.face : object.back
        if (constrainedEffects) {
          return [{ spec: visibleSpec, size: object.size }]
        }

        return [
          { spec: object.face, size: object.size },
          { spec: object.back, size: object.size },
        ]
      }

      if (isBoard(object)) {
        const visibleSpec = isBoardFaceUp(object) ? object.face : object.back
        if (constrainedEffects) {
          return [{ spec: visibleSpec, size: object.size }]
        }

        return [
          { spec: object.face, size: object.size },
          { spec: object.back, size: object.size },
        ]
      }

      return []
    })

    const seenTaskKeys = new Set<string>()
    const queue = tasks.filter(({ spec, size }) => {
      if (spec.kind !== 'image-url' || !spec.url) {
        return false
      }

      const crop = normalizeCrop(spec.crop)
      const taskKey = [
        spec.url,
        size.width,
        size.height,
        spec.fit ?? 'cover',
        crop.x.toFixed(4),
        crop.y.toFixed(4),
        crop.width.toFixed(4),
        crop.height.toFixed(4),
      ].join('|')
      if (seenTaskKeys.has(taskKey)) {
        return false
      }

      seenTaskKeys.add(taskKey)
      return true
    })

    let cancelled = false
    let idleCallbackId: number | undefined
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | undefined
    let nextTaskIndex = 0

    const runNextTask = async () => {
      const task = queue[nextTaskIndex]
      nextTaskIndex += 1
      if (!task || task.spec.kind !== 'image-url' || !task.spec.url) {
        return
      }

      const source = resolveImageSource(task.spec.url, imageAssets)
      const imageUrl = source?.renderUrl
      if (!imageUrl) {
        return
      }

      const image = await loadSourceImageElement(imageUrl).catch(() => undefined)
      if (!image || cancelled) {
        return
      }

      const intrinsicSize =
        source?.asset?.width && source.asset.height
          ? {
            width: source.asset.width,
            height: source.asset.height,
          }
          : {
            width: image.naturalWidth,
            height: image.naturalHeight,
          }
      const crop = normalizeCrop(task.spec.crop)
      const { fitWidth, fitHeight } = computeSurfaceFit(crop, task.size, intrinsicSize, task.spec.fit ?? 'cover')
      await requestPreparedSpriteSurface(
        imageUrl,
        crop,
        task.size.width * fitWidth,
        task.size.height * fitHeight,
        intrinsicSize,
      )
    }

    const scheduleNextTask = (delayMs = 0) => {
      if (cancelled || nextTaskIndex >= queue.length) {
        return
      }

      if (delayMs > 0) {
        timeoutId = globalThis.setTimeout(() => {
          timeoutId = undefined
          scheduleNextTask()
        }, delayMs)
        return
      }

      const quietDelayMs = Math.max(0, prewarmPauseUntilRef.current - performance.now())
      if (quietDelayMs > 0) {
        timeoutId = globalThis.setTimeout(() => {
          timeoutId = undefined
          scheduleNextTask()
        }, quietDelayMs)
        return
      }

      if ('requestIdleCallback' in window) {
        idleCallbackId = window.requestIdleCallback(async (deadline) => {
          idleCallbackId = undefined
          if (
            prewarmPauseUntilRef.current > performance.now() ||
            deadline.timeRemaining() < PREPARED_SPRITE_PREWARM_MIN_IDLE_MS
          ) {
            scheduleNextTask(PREPARED_SPRITE_PREWARM_FALLBACK_DELAY_MS)
            return
          }

          await runNextTask()
          scheduleNextTask()
        })
        return
      }

      timeoutId = globalThis.setTimeout(async () => {
        timeoutId = undefined
        if (prewarmPauseUntilRef.current > performance.now()) {
          scheduleNextTask()
          return
        }
        await runNextTask()
        scheduleNextTask()
      }, PREPARED_SPRITE_PREWARM_FALLBACK_DELAY_MS)
    }

    scheduleNextTask()

    return () => {
      cancelled = true
      if (idleCallbackId !== undefined && 'cancelIdleCallback' in window) {
        window.cancelIdleCallback(idleCallbackId)
      }
      if (timeoutId !== undefined) {
        globalThis.clearTimeout(timeoutId)
      }
    }
  }, [constrainedEffects, currentPlayerId, imageAssets, room.objects])

  useEffect(() => {
    const host = hostRef.current
    if (!host) {
      return
    }

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault()
      markPrewarmInteraction()
      stopCameraMomentum()
      resetPointerPanState()
      const localPoint = clientToLocal(rootRef.current, event.clientX, event.clientY)
      if (!localPoint) {
        return
      }

      updateCamera((current) => {
        const anchorWorld = screenToLogical(viewportSize, current, localPoint)
        const nextZoom = clamp(current.zoom * Math.exp(-event.deltaY * 0.0012), MIN_ZOOM_SCALE, MAX_ZOOM_SCALE)
        return cameraForAnchor(viewportSize, anchorWorld, localPoint, nextZoom)
      })
    }

    host.addEventListener('wheel', handleWheel, { passive: false })
    return () => {
      host.removeEventListener('wheel', handleWheel)
    }
  }, [markPrewarmInteraction, resetPointerPanState, stopCameraMomentum, updateCamera, viewportSize])

  useEffect(() => {
    const host = hostRef.current
    if (!host) {
      return
    }

    const preventNativeTouchBehavior = (event: TouchEvent) => {
      event.preventDefault()
    }

    host.addEventListener('touchstart', preventNativeTouchBehavior, { passive: false })
    host.addEventListener('touchmove', preventNativeTouchBehavior, { passive: false })

    return () => {
      host.removeEventListener('touchstart', preventNativeTouchBehavior)
      host.removeEventListener('touchmove', preventNativeTouchBehavior)
    }
  }, [])

  useEffect(() => {
    const preventWindowDropNavigation = (event: DragEvent) => {
      if (!event.dataTransfer || !hasFileTransfer(event.dataTransfer)) {
        return
      }

      event.preventDefault()
    }

    window.addEventListener('dragover', preventWindowDropNavigation)
    window.addEventListener('drop', preventWindowDropNavigation)
    return () => {
      window.removeEventListener('dragover', preventWindowDropNavigation)
      window.removeEventListener('drop', preventWindowDropNavigation)
    }
  }, [])

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const localPoint = clientToLocal(rootRef.current, event.clientX, event.clientY)
      if (!localPoint) {
        return
      }

      const activeLasso = lassoRef.current
      if (activeLasso && activeLasso.pointerId === event.pointerId) {
        const lastPoint = activeLasso.points[activeLasso.points.length - 1]
        if (!lastPoint || Math.hypot(localPoint.x - lastPoint.x, localPoint.y - lastPoint.y) >= 6) {
          const nextPoints = [...activeLasso.points, localPoint]
          activeLasso.points = nextPoints
          setLassoPath(nextPoints)
        }
        return
      }

      const pendingDeckPress = pendingDeckPressRef.current
      if (!dragRef.current && pendingDeckPress && pendingDeckPress.pointerId === event.pointerId) {
        const pointerDistance = Math.hypot(
          localPoint.x - pendingDeckPress.startPoint.x,
          localPoint.y - pendingDeckPress.startPoint.y,
        )

        if (pointerDistance > TAP_GRACE_DISTANCE) {
          clearPendingDeckPress()

          const liftedCardId = onLiftTopCardFromDeck(pendingDeckPress.deckId)
          const dragId = liftedCardId ?? pendingDeckPress.deckId
          if (liftedCardId) {
            onBringObjectToFront(liftedCardId)
            onSelect(liftedCardId)
          }

          startDrag(
            dragId,
            event.pointerId,
            'move',
            pendingDeckPress.startPoint,
            pendingDeckPress.startTransform,
          )
        }
      }

      const activeDrag = dragRef.current
      if (activeDrag && activeDrag.pointerId === event.pointerId) {
        activeDrag.currentPoint = localPoint

        const worldPoint = screenToLogical(viewportSize, cameraRef.current, localPoint)
        const distance = Math.hypot(
          worldPoint.x - activeDrag.startPointer.x,
          worldPoint.y - activeDrag.startPointer.y,
        )
        activeDrag.moved ||= distance > 8

        if (
          activeDrag.mode === 'move' &&
          activeDrag.moved &&
          !activeDrag.raisedToFront &&
          (!activeDrag.groupMembers || activeDrag.groupMembers.length === 0) &&
          isMovableObjectType(roomRef.current, activeDrag.id)
        ) {
          onBringObjectToFront(activeDrag.id)
          activeDrag.raisedToFront = true
        }

        if (activeDrag.mode === 'move') {
          const deltaX = worldPoint.x - activeDrag.startPointer.x
          const deltaY = worldPoint.y - activeDrag.startPointer.y

          if (activeDrag.groupMembers && activeDrag.groupMembers.length > 0) {
            const nextTransforms: EphemeralTransformMap = {}
            for (const member of activeDrag.groupMembers) {
              nextTransforms[member.id] = {
                ...member.startTransform,
                x: member.startTransform.x + deltaX,
                y: member.startTransform.y + deltaY,
              }
            }
            replacePreviewTransforms(nextTransforms)
            setHoverDropTargetId(undefined)

            for (const [objectId, transform] of Object.entries(nextTransforms)) {
              if (transform) {
                onPreviewTransform(objectId, transform)
              }
            }
          } else {
            const nextTransform = {
              ...activeDrag.startTransform,
              x: activeDrag.startTransform.x + deltaX,
              y: activeDrag.startTransform.y + deltaY,
            }
            replacePreviewTransforms({
              [activeDrag.id]: nextTransform,
            })
            onPreviewTransform(activeDrag.id, nextTransform)

            const draggingObject = roomRef.current.objects[activeDrag.id]
            const nextHoverDropTargetId =
              draggingObject && (draggingObject.type === 'card' || draggingObject.type === 'deck')
                ? findDropTargetAtPoint(
                    roomRef.current,
                    { x: nextTransform.x, y: nextTransform.y },
                    ephemeralTransformsRef.current,
                    previewTransformsRef.current,
                    activeDrag.id,
                    activeDrag.id,
                  )
                : undefined

            setHoverDropTargetId((current) => (current === nextHoverDropTargetId ? current : nextHoverDropTargetId))
          }
        } else {
          const angle =
            Math.atan2(
              worldPoint.y - activeDrag.startTransform.y,
              worldPoint.x - activeDrag.startTransform.x,
            ) + Math.PI / 2

          const nextTransform = {
            ...activeDrag.startTransform,
            rotation: angle,
          }
          replacePreviewTransforms({
            [activeDrag.id]: nextTransform,
          })
          onPreviewTransform(activeDrag.id, nextTransform)
        }
        return
      }

      const cameraPointers = cameraPointersRef.current
      const previousPoint = cameraPointers.get(event.pointerId)
      if (!previousPoint) {
        return
      }

      markPrewarmInteraction()

      cameraPointers.set(event.pointerId, localPoint)
      const pointerEntries = [...cameraPointers.entries()]

      if (pointerEntries.length === 1) {
        const now = performance.now() / 1000
        const nextSamples = [
          ...pointerPanStateRef.current.recentSamples,
          { point: localPoint, time: now },
        ].filter((sample) => now - sample.time <= PAN_MOMENTUM_SAMPLE_WINDOW_SECONDS)
        const firstSample = nextSamples[0]
        const lastSample = nextSamples[nextSamples.length - 1]
        const dt = firstSample && lastSample ? lastSample.time - firstSample.time : 0
        if (dt > 0 && firstSample && lastSample) {
          pointerPanStateRef.current = {
            active: true,
            lastVelocity: {
              x: (lastSample.point.x - firstSample.point.x) / dt,
              y: (lastSample.point.y - firstSample.point.y) / dt,
            },
            lastSampleTime: now,
            recentSamples: nextSamples,
          }
        } else {
          pointerPanStateRef.current = {
            active: true,
            lastVelocity: pointerPanStateRef.current.lastVelocity,
            lastSampleTime: now,
            recentSamples: nextSamples,
          }
        }

        updateCamera((current) => ({
          ...current,
          centerX: current.centerX - (localPoint.x - previousPoint.x) / current.zoom,
          centerY: current.centerY - (localPoint.y - previousPoint.y) / current.zoom,
        }))
        return
      }

      if (pointerEntries.length >= 2) {
        stopCameraMomentum()
        resetPointerPanState()
        const [firstEntry, secondEntry] = pointerEntries
        const [firstPointerId, firstCurrent] = firstEntry
        const [secondPointerId, secondCurrent] = secondEntry
        const firstPrevious = firstPointerId === event.pointerId ? previousPoint : firstCurrent
        const secondPrevious = secondPointerId === event.pointerId ? previousPoint : secondCurrent
        const previousCenter = {
          x: (firstPrevious.x + secondPrevious.x) / 2,
          y: (firstPrevious.y + secondPrevious.y) / 2,
        }
        const nextCenter = {
          x: (firstCurrent.x + secondCurrent.x) / 2,
          y: (firstCurrent.y + secondCurrent.y) / 2,
        }
        const previousDistance = Math.hypot(
          firstPrevious.x - secondPrevious.x,
          firstPrevious.y - secondPrevious.y,
        )
        const nextDistance = Math.hypot(
          firstCurrent.x - secondCurrent.x,
          firstCurrent.y - secondCurrent.y,
        )

        if (previousDistance > 0 && nextDistance > 0) {
          updateCamera((current) => {
            const anchorWorld = screenToLogical(viewportSize, current, previousCenter)
            const zoom = clamp(current.zoom * (nextDistance / previousDistance), MIN_ZOOM_SCALE, MAX_ZOOM_SCALE)
            return cameraForAnchor(viewportSize, anchorWorld, nextCenter, zoom)
          })
        }
      }
    }

    const handlePointerUp = (event: PointerEvent) => {
      markPrewarmInteraction()
      clearPendingDeckPress()
      const hadCameraPointer = cameraPointersRef.current.has(event.pointerId)
      const shouldStartMomentum =
        hadCameraPointer &&
        cameraPointersRef.current.size === 1 &&
        pointerPanStateRef.current.active
      const releaseVelocity = pointerPanStateRef.current.lastVelocity

      const localPoint = clientToLocal(rootRef.current, event.clientX, event.clientY)
      if (!localPoint) {
        return
      }

      const activeLasso = lassoRef.current
      if (activeLasso && activeLasso.pointerId === event.pointerId) {
        lassoRef.current = null
        setLassoPath([])
        if (activeLasso.points.length >= 3) {
          onAddToGroupSelection(
            objectIdsWithinLasso(
              viewportSize,
              cameraRef.current,
              roomRef.current,
              ephemeralTransformsRef.current,
              previewTransformsRef.current,
              activeLasso.points,
            ),
          )
        }
        return
      }

      const activeDrag = dragRef.current
      if (activeDrag && activeDrag.pointerId === event.pointerId) {
        dragRef.current = null
        setHoverDropTargetId(undefined)

        const nextPreviewTransforms = previewTransformsRef.current
        if (activeDrag.mode === 'move') {
          if (activeDrag.groupMembers && activeDrag.groupMembers.length > 0) {
            for (const member of activeDrag.groupMembers) {
              const finalTransform = nextPreviewTransforms[member.id]
              onClearPreviewTransform(member.id, finalTransform)
              if (finalTransform) {
                onCommitTransform(member.id, {
                  x: finalTransform.x,
                  y: finalTransform.y,
                  rotation: member.startTransform.rotation,
                })
              }
            }
            replacePreviewTransforms({})
            return
          }

          const finalTransform = nextPreviewTransforms[activeDrag.id] ?? activeDrag.startTransform
          onClearPreviewTransform(activeDrag.id, finalTransform)

          const worldPoint = screenToLogical(viewportSize, cameraRef.current, localPoint)
          const object = roomRef.current.objects[activeDrag.id]
          const targetId =
            object && (object.type === 'card' || object.type === 'deck')
              ? findDropTargetAtPoint(
                  roomRef.current,
                  worldPoint,
                  ephemeralTransformsRef.current,
                  previewTransformsRef.current,
                  activeDrag.id,
                  activeDrag.id,
                )
              : undefined

          replacePreviewTransforms({})
          if (targetId) {
            onDropObjectOntoObject(activeDrag.id, targetId)
          } else {
            onCommitTransform(activeDrag.id, finalTransform)
          }
          return
        }

        const finalTransform = nextPreviewTransforms[activeDrag.id] ?? activeDrag.startTransform
        const snappedRotation = snapRotationAngle(finalTransform.rotation)
        const snappedTransform = {
          ...finalTransform,
          rotation: snappedRotation,
        }
        onClearPreviewTransform(activeDrag.id, snappedTransform)
        replacePreviewTransforms({})
        onCommitTransform(activeDrag.id, {
          rotation: snappedRotation,
        })
        return
      }

      const tapCandidate = tapCandidateRef.current
      if (tapCandidate && tapCandidate.pointerId === event.pointerId) {
        tapCandidateRef.current = null
        const releasedObjectId = objectIdAtClientPoint(event.clientX, event.clientY)
        const distance = Math.hypot(
          localPoint.x - tapCandidate.startPoint.x,
          localPoint.y - tapCandidate.startPoint.y,
        )
        if (releasedObjectId === tapCandidate.id && distance <= TAP_GRACE_DISTANCE) {
          if (selectionModeRef.current === 'group') {
            onToggleGroupSelection(tapCandidate.id)
          } else {
            onSelect(tapCandidate.id)
          }
        }
      }

      const backgroundTapCandidate = backgroundTapCandidateRef.current
      if (backgroundTapCandidate && backgroundTapCandidate.pointerId === event.pointerId) {
        backgroundTapCandidateRef.current = null
        const distance = Math.hypot(
          localPoint.x - backgroundTapCandidate.startPoint.x,
          localPoint.y - backgroundTapCandidate.startPoint.y,
        )
        const releasedObjectId = objectIdAtClientPoint(event.clientX, event.clientY)
        if (!releasedObjectId && distance <= TAP_GRACE_DISTANCE && selectionModeRef.current === 'normal') {
          onSelect(undefined)
        }
      }

      cameraPointersRef.current.delete(event.pointerId)
      if (shouldStartMomentum) {
        flushPendingCameraUpdate()
        if (Math.hypot(releaseVelocity.x, releaseVelocity.y) > 0) {
          startCameraMomentum(releaseVelocity)
        }
      }
      resetPointerPanState()
    }

    const handlePointerCancel = (event: PointerEvent) => {
      markPrewarmInteraction()
      if (dragRef.current?.pointerId === event.pointerId) {
        const drag = dragRef.current
        dragRef.current = null
        setHoverDropTargetId(undefined)
        if (drag.groupMembers && drag.groupMembers.length > 0) {
          for (const member of drag.groupMembers) {
            onClearPreviewTransform(member.id)
          }
        } else if (drag) {
          onClearPreviewTransform(drag.id)
        }
        replacePreviewTransforms({})
      }

      if (lassoRef.current?.pointerId === event.pointerId) {
        lassoRef.current = null
        setLassoPath([])
      }

      if (tapCandidateRef.current?.pointerId === event.pointerId) {
        tapCandidateRef.current = null
      }

      if (backgroundTapCandidateRef.current?.pointerId === event.pointerId) {
        backgroundTapCandidateRef.current = null
      }

      clearPendingDeckPress()
      cameraPointersRef.current.delete(event.pointerId)
      stopCameraMomentum()
      resetPointerPanState()
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerCancel)

    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerCancel)
    }
  }, [
    clearPendingDeckPress,
    onAddToGroupSelection,
    onBringObjectToFront,
    onClearPreviewTransform,
    onCommitTransform,
    onDropObjectOntoObject,
    onLiftTopCardFromDeck,
    onPreviewTransform,
    onSelect,
    replacePreviewTransforms,
    startDrag,
    onToggleGroupSelection,
    updateCamera,
    viewportSize,
    flushPendingCameraUpdate,
    resetPointerPanState,
    startCameraMomentum,
    stopCameraMomentum,
    markPrewarmInteraction,
  ])

  useEffect(
    () => () => {
      flushPendingCameraUpdate()
      pendingCameraUpdateRef.current = null
      stopCameraMomentum()
      if (cameraRenderSyncTimeoutRef.current !== null) {
        window.clearTimeout(cameraRenderSyncTimeoutRef.current)
        cameraRenderSyncTimeoutRef.current = null
      }
      clearPendingDeckPress()
      if (dragRef.current) {
        if (dragRef.current.groupMembers && dragRef.current.groupMembers.length > 0) {
          for (const member of dragRef.current.groupMembers) {
            onClearPreviewTransformRef.current(member.id)
          }
        } else {
          onClearPreviewTransformRef.current(dragRef.current.id)
        }
      }
    },
    [clearPendingDeckPress, flushPendingCameraUpdate, stopCameraMomentum],
  )

  const quickActions = useMemo<QuickAction[]>(() => {
    if (selectionMode !== 'normal' || !selectedId) {
      return []
    }

    const object = room.objects[selectedId]
    if (!object || !canEdit) {
      return []
    }

    if (object.type === 'card') {
      return [
        { id: 'flip', label: 'Flip', icon: 'flip', onClick: () => onFlipCard(object.id) },
        { id: 'more', label: 'More actions', icon: 'more', onClick: onOpenSelectionPanel },
      ]
    }

    if (object.type === 'deck') {
      return [
        { id: 'shuffle', label: 'Shuffle', text: 'Shuffle', onClick: () => onShuffleDeck(object.id) },
        { id: 'more', label: 'More actions', icon: 'more', onClick: onOpenSelectionPanel },
      ]
    }

    if (object.type === 'board') {
      return [
        { id: 'flip', label: 'Flip', icon: 'flip', onClick: () => onFlipBoard(object.id) },
        { id: 'more', label: 'More actions', icon: 'more', onClick: onOpenSelectionPanel },
      ]
    }

    return []
  }, [canEdit, onFlipBoard, onFlipCard, onOpenSelectionPanel, onShuffleDeck, room.objects, selectedId, selectionMode])
  hasQuickActionsRef.current = quickActions.length > 0

  const root = getRootPlane(room)
  const selectedIdsSet = useMemo(() => new Set(selectedIds), [selectedIds])
  const worldObjects = useMemo(
    () =>
      root.childOrder.flatMap((objectId, index) => {
        const object = room.objects[objectId]
        const transform = displayedTransformForObject(room, objectId, ephemeralTransforms, previewTransforms)
        if (!object || !transform) {
          return []
        }

        const worldSize = objectDimensions(room, objectId)

        return [{
          index,
          objectId,
          object,
          transform,
          worldSize,
        }]
      }),
    [ephemeralTransforms, previewTransforms, room, root.childOrder],
  )

  const selectedWorldObject = useMemo(
    () => (selectedId ? worldObjects.find((object) => object.objectId === selectedId) : undefined),
    [selectedId, worldObjects],
  )

  const hasActiveAlphaSelection = useMemo(() => {
    const candidateIds = selectionMode === 'group' ? selectedIds : selectedId ? [selectedId] : []
    return candidateIds.some((objectId) => {
      const object = room.objects[objectId]
      if (!isBoard(object)) {
        return false
      }
      const spec = isBoardFaceUp(object) ? object.face : object.back
      return spec.kind === 'image-url' && (spec.bg === undefined || spec.bg === 'transparent')
    })
  }, [room, selectedId, selectedIds, selectionMode])
  hasActiveAlphaSelectionRef.current = hasActiveAlphaSelection

  useEffect(() => {
    if (!hasActiveAlphaSelection) {
      return
    }

    setLiveSelectionZoom(cameraRef.current.zoom)
  }, [hasActiveAlphaSelection])

  const objectElementsZoomDependency = hasActiveAlphaSelection ? liveSelectionZoom : undefined

  const quickActionsPosition = useMemo(() => {
    if (!selectedWorldObject || quickActions.length === 0) {
      return undefined
    }

    const screenPoint = logicalToScreen(viewportSize, cameraRef.current, {
      x: selectedWorldObject.transform.x,
      y: selectedWorldObject.transform.y,
    })

    return {
      left: `${screenPoint.x}px`,
      top: `${screenPoint.y - selectedWorldObject.worldSize.height * cameraRef.current.zoom / 2 - 24}px`,
    }
  }, [quickActions.length, selectedWorldObject, viewportSize])
  selectedWorldObjectRef.current = selectedWorldObject

  useLayoutEffect(() => {
    applyQuickActionsPosition(cameraRef.current)
  }, [applyQuickActionsPosition, quickActions.length, selectedWorldObject])

  const boardWorldStyle = useMemo<CSSProperties>(() => {
    return {
      width: '0px',
      height: '0px',
    }
  }, [])

  const boardGridStyle = useMemo<CSSProperties>(
    () => boardGridScreenStyle(viewportSize, camera),
    [camera, viewportSize],
  )

  const handleRootPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement | null)?.closest('[data-board-ui]')) {
      return
    }

    if (event.button === 2) {
      return
    }

    const localPoint = clientToLocal(rootRef.current, event.clientX, event.clientY)
    if (!localPoint) {
      return
    }

    if (event.pointerType === 'touch') {
      event.preventDefault()
      const activeDrag = dragRef.current
      if (activeDrag && activeDrag.pointerId !== event.pointerId) {
        if (activeDrag.moved) {
          beginCameraPointer(event.pointerId, localPoint)
        } else {
          cancelTouchObjectInteraction({
            pointerId: event.pointerId,
            localPoint,
          })
        }
        return
      }
      if (cameraPointersRef.current.size > 0) {
        cancelTouchObjectInteraction({
          pointerId: event.pointerId,
          localPoint,
        })
        return
      }
    }

    markPrewarmInteraction()
    stopCameraMomentum()
    resetPointerPanState()

    if (selectionMode === 'group' && lassoMode && !dragRef.current) {
      lassoRef.current = {
        pointerId: event.pointerId,
        points: [localPoint],
      }
      setLassoPath([localPoint])
      return
    }

    if (event.pointerType === 'touch') {
      backgroundTapCandidateRef.current = {
        pointerId: event.pointerId,
        startPoint: localPoint,
      }
    } else if (selectionMode === 'normal') {
      onSelect(undefined)
    }

    beginCameraPointer(event.pointerId, localPoint)
  }, [beginCameraPointer, cancelTouchObjectInteraction, lassoMode, markPrewarmInteraction, onSelect, resetPointerPanState, selectionMode, stopCameraMomentum])

  const handleObjectPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>, objectId: Id) => {
    const object = room.objects[objectId]
    if (!object) {
      return
    }

    if (selectionMode === 'group' && lassoMode) {
      return
    }

    const isTouchPointer = event.pointerType === 'touch'
    const isMiddleMouse = event.pointerType === 'mouse' && event.button === 1
    if (isMiddleMouse) {
      return
    }

    const localPoint = clientToLocal(rootRef.current, event.clientX, event.clientY)
    if (!localPoint) {
      return
    }

    if (isTouchPointer) {
      event.preventDefault()
      const activeDrag = dragRef.current
      if (activeDrag && activeDrag.pointerId !== event.pointerId) {
        event.stopPropagation()
        if (activeDrag.moved) {
          beginCameraPointer(event.pointerId, localPoint)
        } else {
          cancelTouchObjectInteraction({
            pointerId: event.pointerId,
            localPoint,
          })
        }
        return
      }
      if (cameraPointersRef.current.size > 0) {
        event.stopPropagation()
        cancelTouchObjectInteraction({
          pointerId: event.pointerId,
          localPoint,
        })
        return
      }
    }

    markPrewarmInteraction()
    stopCameraMomentum()
    resetPointerPanState()

    if (isTouchPointer) {
      beginCameraPointer(event.pointerId, localPoint)
    }

    const currentTransform = currentTransformForObject(objectId)
    if (!currentTransform) {
      return
    }

    const shouldPromoteToGroupSelection =
      event.shiftKey &&
      selectionMode === 'normal' &&
      selectedId !== undefined &&
      selectedId !== objectId &&
      isMultiselectObjectType(room, selectedId) &&
      isMultiselectObjectType(room, objectId) &&
      (!object.locked || allowSelectLocked)

    if (shouldPromoteToGroupSelection) {
      event.stopPropagation()
      onAddToGroupSelection([selectedId, objectId])
      return
    }

    if (object.locked) {
      if (!allowSelectLocked) {
        return
      }

      event.stopPropagation()
      tapCandidateRef.current = {
        id: objectId,
        pointerId: event.pointerId,
        startPoint: localPoint,
      }
      return
    }

    if (selectionMode === 'group') {
      if (!isMultiselectObjectType(room, objectId)) {
        return
      }

      event.stopPropagation()
      const isSelected = selectedIdsSet.has(objectId)
      tapCandidateRef.current = {
        id: objectId,
        pointerId: event.pointerId,
        startPoint: localPoint,
      }

      if (!isSelected) {
        return
      }

      if (!canEdit || !isMovableObjectType(room, objectId)) {
        return
      }

      startDrag(
        objectId,
        event.pointerId,
        'move',
        localPoint,
        currentTransform,
        selectedIds
          .map((memberId) => {
            const memberTransform = currentTransformForObject(memberId)
            return memberTransform ? { id: memberId, startTransform: { ...memberTransform } } : undefined
          })
          .filter((member): member is { id: Id; startTransform: Transform2D } => Boolean(member)),
      )
      return
    }

    if (isDeck(object) && canEdit && (!isTouchPointer || selectedId === objectId)) {
      event.stopPropagation()
      onSelect(objectId)
      tapCandidateRef.current = {
        id: objectId,
        pointerId: event.pointerId,
        startPoint: localPoint,
      }

      clearPendingDeckPress()
      pendingDeckPressRef.current = {
        deckId: objectId,
        pointerId: event.pointerId,
        startPoint: localPoint,
        startTransform: { ...currentTransform },
        timeoutId: window.setTimeout(() => {
          const pendingDeckPress = pendingDeckPressRef.current
          if (!pendingDeckPress || pendingDeckPress.deckId !== objectId || pendingDeckPress.pointerId !== event.pointerId) {
            return
          }

          pendingDeckPressRef.current = null
          startDrag(objectId, event.pointerId, 'move', localPoint, pendingDeckPress.startTransform)
        }, DECK_LONG_PRESS_MS),
      }
      return
    }

    if (!isTouchPointer) {
      event.stopPropagation()
      onSelect(objectId)
      if (!canEdit || !isMovableObjectType(room, objectId)) {
        return
      }

      startDrag(objectId, event.pointerId, 'move', localPoint, currentTransform)
      return
    }

    event.stopPropagation()
    tapCandidateRef.current = {
      id: objectId,
      pointerId: event.pointerId,
      startPoint: localPoint,
    }

    if (selectedId !== objectId || !canEdit || !isMovableObjectType(room, objectId)) {
      return
    }

    startDrag(objectId, event.pointerId, 'move', localPoint, currentTransform)
  }, [
    allowSelectLocked,
    canEdit,
    clearPendingDeckPress,
    currentTransformForObject,
    lassoMode,
    onAddToGroupSelection,
    onSelect,
    room,
    resetPointerPanState,
    selectedId,
    selectedIds,
    selectedIdsSet,
    selectionMode,
    startDrag,
    stopCameraMomentum,
    beginCameraPointer,
    cancelTouchObjectInteraction,
    markPrewarmInteraction,
  ])

  const handleRotatePointerDown = useCallback((event: ReactPointerEvent<HTMLButtonElement>, objectId: Id) => {
    event.stopPropagation()
    const currentTransform = currentTransformForObject(objectId)
    if (!currentTransform) {
      return
    }

    const localPoint = clientToLocal(rootRef.current, event.clientX, event.clientY)
    if (!localPoint) {
      return
    }

    if (event.pointerType === 'touch') {
      event.preventDefault()
    }

    markPrewarmInteraction()
    stopCameraMomentum()
    resetPointerPanState()
    startDrag(objectId, event.pointerId, 'rotate', localPoint, currentTransform)
  }, [currentTransformForObject, markPrewarmInteraction, resetPointerPanState, startDrag, stopCameraMomentum])

  function resetDropTarget() {
    dropDepthRef.current = 0
    setIsImageDropTarget(false)
  }

  function handleDragEnter(event: ReactDragEvent<HTMLDivElement>) {
    if (!canEdit || !event.dataTransfer || !hasFileTransfer(event.dataTransfer)) {
      return
    }

    event.preventDefault()
    dropDepthRef.current += 1
    setIsImageDropTarget(true)
  }

  function handleDragOver(event: ReactDragEvent<HTMLDivElement>) {
    if (!canEdit || !event.dataTransfer || !hasFileTransfer(event.dataTransfer)) {
      return
    }

    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setIsImageDropTarget(true)
  }

  function handleDragLeave(event: ReactDragEvent<HTMLDivElement>) {
    if (!event.dataTransfer || !hasFileTransfer(event.dataTransfer)) {
      return
    }

    event.preventDefault()
    dropDepthRef.current = Math.max(0, dropDepthRef.current - 1)
    if (dropDepthRef.current === 0) {
      setIsImageDropTarget(false)
    }
  }

  function handleDrop(event: ReactDragEvent<HTMLDivElement>) {
    if (!canEdit || !event.dataTransfer || !hasFileTransfer(event.dataTransfer)) {
      return
    }

    event.preventDefault()
    const files = imageFilesFromTransfer(event.dataTransfer)
    resetDropTarget()
    if (files.length === 0) {
      return
    }

    const localPoint = clientToLocal(rootRef.current, event.clientX, event.clientY)
    if (!localPoint) {
      return
    }

    onDropImageFileAt(files, screenToLogical(viewportSize, cameraRef.current, localPoint))
  }

  const objectElements = useMemo(
    () =>
      worldObjects.map(({ index, objectId, object, transform, worldSize }) => {
        const isDragging =
          dragRef.current?.id === objectId ||
          Boolean(dragRef.current?.groupMembers?.some((member) => member.id === objectId))
        const selectionStrokeWidth =
          hoverDropTargetId === objectId
            ? 5
            : selectionMode === 'group'
              ? selectedIdsSet.has(objectId)
                ? selectedId === objectId
                  ? 5
                  : 4
                : 0
              : selectedId === objectId
                ? 4
                : 0
        const selectionStrokeColor =
          hoverDropTargetId === objectId
            ? '#ff8d47'
            : selectionMode === 'group' && selectedId === objectId
              ? '#ffd78a'
              : '#ffcb72'
        const boardSelectionSpec = isBoard(object) ? (isBoardFaceUp(object) ? object.face : object.back) : undefined
        const usesAlphaBoardSelection = Boolean(
          boardSelectionSpec &&
          boardSelectionSpec.kind === 'image-url' &&
          (boardSelectionSpec.bg === undefined || boardSelectionSpec.bg === 'transparent'),
        )
        const usesCardOutlineSelection = isCard(object) && selectionStrokeWidth > 0
        const showsRotateHandle =
          selectionMode === 'normal' && selectedId === objectId && canEdit && !object.locked
        const worldPosition = transform

        return (
          <div
            key={objectId}
            className={`board-object board-object-${object.type}${isDragging ? ' is-dragging' : ''}${usesCardOutlineSelection ? ' has-card-outline-selection' : ''}`}
            data-board-object-id={objectId}
            data-board-object-type={object.type}
            style={{
              left: `${worldPosition.x}px`,
              top: `${worldPosition.y}px`,
              width: `${worldSize.width}px`,
              height: `${worldSize.height}px`,
              transform: `translate3d(-50%, -50%, 0) rotate(${transform.rotation}rad)`,
              zIndex: isDragging ? 1000 + index : index + 1,
              cursor: objectCursor(object, canEdit, allowSelectLocked, isDragging),
              ...(selectionStrokeWidth > 0
                ? ({
                    ['--board-selection-width' as const]: `${selectionStrokeWidth}px`,
                    ['--board-selection-color' as const]: selectionStrokeColor,
                  } as CSSProperties)
                : undefined),
            }}
            aria-label={`${object.type}: ${object.name}`}
            onPointerDown={(event) => handleObjectPointerDown(event, objectId)}
          >
            {selectionStrokeWidth > 0 && boardSelectionSpec && usesAlphaBoardSelection ? (
              <BoardSelectionOverlay
                spec={boardSelectionSpec}
                size={worldSize}
                imageAssets={imageAssets}
                cameraZoom={objectElementsZoomDependency ?? 1}
                selectionStrokeWidth={selectionStrokeWidth}
                selectionStrokeColor={selectionStrokeColor}
              />
            ) : null}
            <MemoBoardObjectContent
              objectId={objectId}
              room={room}
              currentPlayerId={currentPlayerId}
              imageAssets={imageAssets}
              size={worldSize}
              constrainedEffects={constrainedEffects}
            />
            {selectionStrokeWidth > 0 && !usesCardOutlineSelection && (!boardSelectionSpec || !usesAlphaBoardSelection) ? (
              <div
                className={`board-object-selection ${object.type === 'board' ? 'is-square' : 'is-rounded'}`}
              />
            ) : null}
            {showsRotateHandle ? (
              <button
                type="button"
                className="board-rotate-handle"
                data-board-ui="rotate-handle"
                onPointerDown={(event) => handleRotatePointerDown(event, objectId)}
                aria-label={`Rotate ${object.name}`}
              />
            ) : null}
          </div>
        )
      }),
    [
      allowSelectLocked,
      canEdit,
      currentPlayerId,
      constrainedEffects,
      handleObjectPointerDown,
      handleRotatePointerDown,
      hoverDropTargetId,
      imageAssets,
      objectElementsZoomDependency,
      room,
      selectedId,
      selectedIdsSet,
      selectionMode,
      worldObjects,
    ],
  )

  return (
    <div
      className={`board-root ${isImageDropTarget ? 'is-image-drop-target' : ''}`}
      ref={rootRef}
      onContextMenu={(event) => event.preventDefault()}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div
        className="board-canvas"
        ref={hostRef}
        onPointerDown={handleRootPointerDown}
      >
        <div className="board-backdrop" />
        <div className="board-grid" ref={boardGridRef} style={boardGridStyle} />
        <div className="board-world" ref={boardWorldRef} style={boardWorldStyle}>
          <div className="board-objects">{objectElements}</div>
        </div>
      </div>
      {isImageDropTarget ? (
        <div className="board-drop-overlay">Drop image to create board</div>
      ) : null}
      {dropImageError ? (
        <div className="board-drop-error" role="status">{dropImageError}</div>
      ) : null}
      {lassoPath.length > 1 ? (
        <svg
          className="lasso-overlay"
          viewBox={`0 0 ${viewportSize.width} ${viewportSize.height}`}
          preserveAspectRatio="none"
        >
          <path d={`M ${lassoPath.map((point) => `${point.x} ${point.y}`).join(' L ')} Z`} />
        </svg>
      ) : null}
      {quickActions.length > 0 && quickActionsPosition ? (
        <div
          ref={quickActionsRef}
          className="quick-actions"
          data-board-ui="quick-actions"
          style={quickActionsPosition}
        >
          {quickActions.map((action) => (
            <button
              key={action.id}
              type="button"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={action.onClick}
              className={action.icon ? 'quick-action-icon' : undefined}
              aria-label={action.label}
              title={action.label}
            >
              {action.icon === 'flip'
                ? <FlipQuickActionIcon />
                : action.icon === 'more'
                  ? <MoreQuickActionIcon />
                  : action.text ?? action.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
