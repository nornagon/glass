import type { AutomergeUrl } from '@automerge/react'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent as ReactDragEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { resolveImageSource, type ResolvedImageAsset } from '../model/assets'
import { resolvePdfSource, type ResolvedPdfAsset } from '../model/pdfAssets'
import { BOARD_WORLD_SIZE, DEFAULT_CARD_SIZE, type CameraState, type Id, type RoomDoc, type SpriteSpec, type Transform2D } from '../model/types'
import { canSeeCardFace, getPoolDisplaySize, getPoolRemainingTokens, getPoolTokenSize, getRootPlane, getTransform, isBoard, isBoardFaceUp, isBook, isCard, isDeck, isGroupSelectableObject, isPool, isPoolFaceUp } from '../model/room'
import { releasePanVelocity } from './panMomentum'
import { ShuffleIcon } from '../ShuffleIcon'
import {
  bindBoardInputRecorder,
  recordBoardInputRecorderCamera,
  recordBoardInputRecorderSelection,
  recordBoardInputRecorderViewport,
} from '../debug/inputRecorder'
import { usePdfPageImage } from '../pdf/render'

interface BoardViewProps {
  room: RoomDoc
  roomUrl: string
  imageAssets: ReadonlyMap<AutomergeUrl, ResolvedImageAsset>
  pdfAssets: ReadonlyMap<AutomergeUrl, ResolvedPdfAsset>
  dropImportError?: string
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
  onStartDuplicateDrag: (
    objectId: Id,
    groupObjectIds?: Id[],
  ) => { id: Id; startTransform: Transform2D; groupMembers?: Array<{ id: Id; startTransform: Transform2D }> } | undefined
  onInstantiateBoardFromPool: (poolId: Id, transform: Transform2D) => Id | undefined
  onDeleteObject: (objectId: Id) => void
  onLiftTopCardFromDeck: (deckId: Id) => Id | undefined
  onFlipCard: (cardId: Id) => void
  onFlipBoard: (boardId: Id) => void
  onFlipDeck: (deckId: Id) => void
  onDrawDeck: (deckId: Id) => void
  onDropFileAt: (files: File[], point: { x: number; y: number }) => void
  onShuffleDeck: (deckId: Id) => void
  onOpenBook: (bookId: Id) => void
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
  spawnedFromPool?: boolean
  selectOnMove?: boolean
  groupMembers?: Array<{ id: Id; startTransform: Transform2D }>
}

interface PendingTouchPress {
  objectId: Id
  pointerId: number
  startPoint: Point
  startTransform: Transform2D
  dragOutTransform?: Transform2D
  timeoutId: number | null
  moveAction: 'none' | 'deck-drag-out' | 'pool-drag-out'
}

interface TapCandidate {
  id: Id
  pointerId: number
  startPoint: Point
  drag?: {
    startTransform: Transform2D
    groupMembers?: DragState['groupMembers']
  }
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
  icon?: 'flip' | 'more' | 'shuffle' | 'view'
  text?: string
}

type EphemeralTransformMap = Partial<Record<Id, Transform2D>>

const FULL_CROP = { x: 0, y: 0, width: 1, height: 1 } as const
const TAP_GRACE_DISTANCE = 10
const TOUCH_LONG_PRESS_MS = 360
const MIN_ZOOM_SCALE = 0.2
const MAX_ZOOM_SCALE = 2.5
const BOARD_GRID_SPACING = 160
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
const PREPARED_SPRITE_PREWARM_INITIAL_DELAY_MS = 500
const PREPARED_SPRITE_PREWARM_QUIET_MS = 400
const PREPARED_SPRITE_PREWARM_FALLBACK_DELAY_MS = 80
const PREPARED_SPRITE_PREWARM_MIN_IDLE_MS = 12
const PREPARED_SPRITE_PREWARM_MAX_TASKS_PER_IDLE = 2
const SURFACE_SHADOW_ALPHA_THRESHOLD = 250
const ROTATE_HANDLE_TOP_OFFSET_PX = 38

const intrinsicImageSizeCache = new Map<string, Size | null>()
const resolvedSourceImageElementCache = new Map<string, HTMLImageElement>()
const sourceImageElementCache = new Map<string, Promise<HTMLImageElement>>()
const resolvedSourceImageBitmapCache = new Map<string, ImageBitmap>()
const sourceImageBitmapCache = new Map<string, Promise<ImageBitmap>>()
const preparedSpriteSurfaceUrlCache = new Map<string, string | null>()
const preparedSpriteSurfaceRequestCache = new Map<string, Promise<string | null>>()
const opaqueRegionBoundsCache = new Map<string, { x: number; y: number; width: number; height: number } | null>()
const opaqueRegionRequestCache = new Map<string, Promise<{ x: number; y: number; width: number; height: number } | null>>()
const surfaceShadowModeCache = new Map<string, 'box' | 'pixel'>()
const surfaceShadowModeRequestCache = new Map<string, Promise<'box' | 'pixel'>>()

function hashString(value: string) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function seededUnit(seed: number) {
  const value = Math.sin(seed * 12.9898 + seed * seed * 0.00037) * 43758.5453
  return value - Math.floor(value)
}

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

function normalizeSurfaceBackground(spec: SpriteSpec, rounded: boolean) {
  if (spec.kind === 'image-url') {
    return 'transparent'
  }

  return spec.bg ?? (rounded ? '#f8efe1' : '#d8d2c1')
}

function usesAlphaSurfaceSelection(spec: SpriteSpec) {
  return spec.kind === 'image-url'
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

function rotateHandleScreenPoint(
  viewport: Size,
  camera: CameraState,
  transform: Transform2D,
  worldSize: Size,
): Point {
  const screenPoint = logicalToScreen(viewport, camera, {
    x: transform.x,
    y: transform.y,
  })
  const offset = worldSize.height * camera.zoom / 2 + ROTATE_HANDLE_TOP_OFFSET_PX

  return {
    x: screenPoint.x + Math.sin(transform.rotation) * offset,
    y: screenPoint.y - Math.cos(transform.rotation) * offset,
  }
}

function snapScreenCoordinate(value: number) {
  const devicePixelRatio = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1
  return Math.round(value * devicePixelRatio) / devicePixelRatio
}

function viewportSizeFromElement(element: Element): Size {
  const rect = element.getBoundingClientRect()
  return {
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height)),
  }
}

function boardGridSurfaceScreenRect(viewport: Size, camera: CameraState) {
  const size = Math.max(1, BOARD_WORLD_SIZE * camera.zoom)
  const topLeft = logicalToScreen(viewport, camera, {
    x: -BOARD_WORLD_SIZE / 2,
    y: -BOARD_WORLD_SIZE / 2,
  })
  return {
    left: snapScreenCoordinate(topLeft.x),
    top: snapScreenCoordinate(topLeft.y),
    size,
  }
}

function applyBoardGridShadowStyle(boardGridShadow: HTMLDivElement, viewport: Size, camera: CameraState) {
  const { left, top, size } = boardGridSurfaceScreenRect(viewport, camera)
  boardGridShadow.style.left = `${left}px`
  boardGridShadow.style.top = `${top}px`
  boardGridShadow.style.width = `${size}px`
  boardGridShadow.style.height = `${size}px`
}

function drawBoardGridCanvas(canvas: HTMLCanvasElement, viewport: Size, camera: CameraState) {
  const context = canvas.getContext('2d')
  if (!context) {
    return
  }

  const devicePixelRatio = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1
  const pixelWidth = Math.max(1, Math.round(viewport.width * devicePixelRatio))
  const pixelHeight = Math.max(1, Math.round(viewport.height * devicePixelRatio))
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth
    canvas.height = pixelHeight
  }

  context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0)
  context.clearRect(0, 0, viewport.width, viewport.height)

  const { left: snappedLeft, top: snappedTop, size: surfaceScreenSize } = boardGridSurfaceScreenRect(viewport, camera)
  const surfaceRight = snappedLeft + surfaceScreenSize
  const surfaceBottom = snappedTop + surfaceScreenSize

  const visibleLeft = Math.max(0, snappedLeft)
  const visibleTop = Math.max(0, snappedTop)
  const visibleRight = Math.min(viewport.width, surfaceRight)
  const visibleBottom = Math.min(viewport.height, surfaceBottom)
  const visibleWidth = visibleRight - visibleLeft
  const visibleHeight = visibleBottom - visibleTop
  if (visibleWidth <= 0 || visibleHeight <= 0) {
    return
  }

  context.fillStyle = '#1f544f'
  context.fillRect(visibleLeft, visibleTop, visibleWidth, visibleHeight)

  context.fillStyle = 'rgba(45, 108, 100, 0.68)'
  const minWorldX = Math.max(-BOARD_WORLD_SIZE / 2, camera.centerX - viewport.width / (2 * camera.zoom))
  const maxWorldX = Math.min(BOARD_WORLD_SIZE / 2, camera.centerX + viewport.width / (2 * camera.zoom))
  const minWorldY = Math.max(-BOARD_WORLD_SIZE / 2, camera.centerY - viewport.height / (2 * camera.zoom))
  const maxWorldY = Math.min(BOARD_WORLD_SIZE / 2, camera.centerY + viewport.height / (2 * camera.zoom))
  const firstGridX = Math.ceil(minWorldX / BOARD_GRID_SPACING) * BOARD_GRID_SPACING
  const firstGridY = Math.ceil(minWorldY / BOARD_GRID_SPACING) * BOARD_GRID_SPACING

  for (let x = firstGridX; x <= maxWorldX; x += BOARD_GRID_SPACING) {
    const screenX = snapScreenCoordinate(logicalToScreen(viewport, camera, { x, y: 0 }).x)
    if (screenX >= visibleLeft - 1 && screenX <= visibleRight) {
      context.fillRect(screenX, visibleTop, 1, visibleHeight)
    }
  }
  for (let y = firstGridY; y <= maxWorldY; y += BOARD_GRID_SPACING) {
    const screenY = snapScreenCoordinate(logicalToScreen(viewport, camera, { x: 0, y }).y)
    if (screenY >= visibleTop - 1 && screenY <= visibleBottom) {
      context.fillRect(visibleLeft, screenY, visibleWidth, 1)
    }
  }
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
  return Boolean(isCard(object) || isDeck(object) || isBoard(object) || isPool(object) || isBook(object))
}

function isMultiselectObjectType(room: RoomDoc, objectId: Id) {
  return isGroupSelectableObject(room.objects[objectId])
}

function objectDimensions(room: RoomDoc, objectId: Id) {
  const object = room.objects[objectId]
  if (isCard(object) || isBoard(object) || isBook(object)) {
    return object.size
  }
  if (isPool(object)) {
    return getPoolDisplaySize(object)
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

    if (isBoard(draggedObject) && isPool(object) && draggedObject.name === object.name) {
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

function importFilesFromTransfer(dataTransfer: DataTransfer) {
  const importFiles: File[] = []

  for (const item of dataTransfer.items) {
    if (item.kind !== 'file') {
      continue
    }

    const file = item.getAsFile()
    if (file && (file.type.startsWith('image/') || file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'))) {
      importFiles.push(file)
    }
  }

  if (importFiles.length > 0) {
    return importFiles
  }

  return [...dataTransfer.files].filter((file) => {
    return file.type.startsWith('image/') || file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
  })
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
    <svg className="flip-icon" aria-hidden="true" viewBox="0 0 512 512" fill="currentColor">
      {/* Font Awesome Free 7.2.0 by @fontawesome - https://fontawesome.com/license/free */}
      <path d="M470.6 118.6c12.5-12.5 12.5-32.8 0-45.3l-64-64c-9.2-9.2-22.9-11.9-34.9-6.9S352 19.1 352 32l0 32-160 0C86 64 0 150 0 256 0 273.7 14.3 288 32 288s32-14.3 32-32c0-70.7 57.3-128 128-128l160 0 0 32c0 12.9 7.8 24.6 19.8 29.6s25.7 2.2 34.9-6.9l64-64zM41.4 393.4c-12.5 12.5-12.5 32.8 0 45.3l64 64c9.2 9.2 22.9 11.9 34.9 6.9S160 492.9 160 480l0-32 160 0c106 0 192-86 192-192 0-17.7-14.3-32-32-32s-32 14.3-32 32c0 70.7-57.3 128-128 128l-160 0 0-32c0-12.9-7.8-24.6-19.8-29.6s-25.7-2.2-34.9 6.9l-64 64z" />
    </svg>
  )
}

function MoreQuickActionIcon() {
  return (
    <svg className="more-icon" aria-hidden="true" viewBox="0 0 128 512" fill="currentColor">
      {/* Font Awesome Free 7.2.0 by @fontawesome - https://fontawesome.com/license/free */}
      <path d="M64 144a56 56 0 1 1 0-112 56 56 0 1 1 0 112zm0 224c30.9 0 56 25.1 56 56s-25.1 56-56 56-56-25.1-56-56 25.1-56 56-56zm56-112c0 30.9-25.1 56-56 56s-56-25.1-56-56 25.1-56 56-56 56 25.1 56 56z" />
    </svg>
  )
}

function ViewQuickActionIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
      <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
      <circle cx="12" cy="12" r="3" />
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

function surfaceShadowModeCacheKey(
  imageUrl: string,
  crop: ReturnType<typeof normalizeCrop>,
) {
  return [
    imageUrl,
    crop.x.toFixed(4),
    crop.y.toFixed(4),
    crop.width.toFixed(4),
    crop.height.toFixed(4),
  ].join('|')
}

async function analyzeSurfaceShadowMode(
  imageUrl: string,
  crop: ReturnType<typeof normalizeCrop>,
): Promise<'box' | 'pixel'> {
  if (typeof document === 'undefined') {
    return 'pixel'
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
    return 'pixel'
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
  for (let index = 3; index < data.length; index += 4) {
    if (data[index] < SURFACE_SHADOW_ALPHA_THRESHOLD) {
      return 'pixel'
    }
  }

  return 'box'
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

function useBoardSurfaceShadowMode(
  spec: SpriteSpec,
  imageAssets: ReadonlyMap<AutomergeUrl, ResolvedImageAsset>,
  enabled: boolean,
): 'box' | 'pixel' | undefined {
  const imageSource = spec.kind === 'image-url' ? resolveImageSource(spec.url, imageAssets) : undefined
  const imageUrl = imageSource?.renderUrl
  const crop = normalizeCrop(spec.crop)
  const cacheKey = enabled && imageUrl ? surfaceShadowModeCacheKey(imageUrl, crop) : undefined
  const cachedMode = cacheKey ? surfaceShadowModeCache.get(cacheKey) : undefined
  const [loadedMode, setLoadedMode] = useState<{ key: string; mode: 'box' | 'pixel' } | undefined>(
    () => (
      cacheKey && cachedMode
        ? {
            key: cacheKey,
            mode: cachedMode,
          }
        : undefined
    ),
  )

  useEffect(() => {
    if (!enabled || !cacheKey || !imageUrl || cachedMode !== undefined) {
      return
    }

    let cancelled = false
    const request =
      surfaceShadowModeRequestCache.get(cacheKey) ??
      analyzeSurfaceShadowMode(imageUrl, crop)
        .then((mode) => {
          surfaceShadowModeCache.set(cacheKey, mode)
          surfaceShadowModeRequestCache.delete(cacheKey)
          return mode
        })
        .catch(() => {
          surfaceShadowModeCache.set(cacheKey, 'pixel')
          surfaceShadowModeRequestCache.delete(cacheKey)
          return 'pixel'
        })

    surfaceShadowModeRequestCache.set(cacheKey, request)
    void request.then((mode) => {
      if (!cancelled) {
        setLoadedMode({
          key: cacheKey,
          mode,
        })
      }
    })

    return () => {
      cancelled = true
    }
  }, [cacheKey, cachedMode, crop, enabled, imageUrl])

  if (!enabled) {
    return undefined
  }

  if (!imageUrl) {
    return 'box'
  }

  if (cachedMode) {
    return cachedMode
  }

  return loadedMode?.key === cacheKey ? loadedMode?.mode ?? 'pixel' : 'pixel'
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
  shadowMode?: 'box' | 'pixel'
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
  const surfaceBackground = normalizeSurfaceBackground(spec, rounded)

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
  shadowMode,
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
      className={`board-surface-shadow-frame ${rounded ? 'is-rounded' : 'is-square'}${shadowMode ? ` surface-shadow-${shadowMode}` : ''}`}
    >
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

interface PoolObjectProps {
  poolId: Id
  room: RoomDoc
  imageAssets: ReadonlyMap<AutomergeUrl, ResolvedImageAsset>
  interactive: boolean
  onInstantiate: (event: ReactPointerEvent<HTMLDivElement>, poolId: Id) => void
}

function PoolObject({ poolId, room, imageAssets, interactive, onInstantiate }: PoolObjectProps) {
  const pool = room.objects[poolId]
  const visibleSpec: SpriteSpec = isPool(pool) ? (isPoolFaceUp(pool) ? pool.face : pool.back) : { kind: 'label' }
  const shadowMode = useBoardSurfaceShadowMode(visibleSpec, imageAssets, isPool(pool))
  if (!isPool(pool)) {
    return null
  }

  const tokenSize = getPoolTokenSize(pool)
  const remainingTokens = getPoolRemainingTokens(pool)
  const clusterCenterX = 50
  const ringCenterY = 48
  const frontTokenY = 50
  const ringStartAngle = seededUnit(hashString(`${poolId}:ring-angle`)) * Math.PI * 2
  const decorativeCopies = [
    (() => {
      const seed = hashString(`${poolId}:center`)
      return {
        key: `${poolId}:center`,
        x: clusterCenterX,
        y: frontTokenY,
        rotation: (seededUnit(seed + 3) - 0.5) * 0.35,
        zIndex: 1000,
      }
    })(),
    ...Array.from({ length: 6 }, (_, index) => {
      const seed = hashString(`${poolId}:ring:${index}`)
      const stackSeed = hashString(`${poolId}:ring-stack:${index}`)
      const angle = ringStartAngle + index * (Math.PI / 3)
      const radiusX = 18
      const radiusY = 15
      const jitterX = (seededUnit(seed + 1) - 0.5) * 2.8
      const jitterY = (seededUnit(seed + 2) - 0.5) * 2.4
      const x = clusterCenterX + Math.cos(angle) * radiusX + jitterX
      const y = ringCenterY + Math.sin(angle) * radiusY + jitterY
      const rotation = (seededUnit(seed + 3) - 0.5) * 0.4
      return {
        key: `${poolId}:ring:${index}`,
        x,
        y,
        rotation,
        zIndex: 200 + Math.round(seededUnit(stackSeed) * 100),
      }
    }),
  ]
  const maxVisibleCopies = Number.isFinite(remainingTokens)
    ? Math.max(0, Math.min(7, Math.floor(remainingTokens)))
    : decorativeCopies.length
  const hiddenCopies = decorativeCopies.length - maxVisibleCopies
  const hiddenCopyKeys = new Set(
    [...decorativeCopies]
      .sort((a, b) => b.zIndex - a.zIndex)
      .slice(0, hiddenCopies)
      .map((copy) => copy.key),
  )
  const visibleCopies = decorativeCopies.filter((copy) => !hiddenCopyKeys.has(copy.key))
  const remainingLabel = Number.isFinite(remainingTokens) ? String(Math.floor(remainingTokens)) : undefined

  return (
    <div className="board-pool-shell">
      <div className="board-pool-outline" />
      <div className="board-pool-copy-cloud">
        {visibleCopies.map((copy) => (
          <div
            key={copy.key}
            className="board-pool-copy"
            data-board-ui="pool-copy"
            onPointerDown={interactive ? (event) => onInstantiate(event, poolId) : undefined}
            style={{
              left: `${copy.x}%`,
              top: `${copy.y}%`,
              width: `${tokenSize.width}px`,
              height: `${tokenSize.height}px`,
              transform: `translate3d(-50%, -50%, 0) rotate(${copy.rotation}rad)`,
              zIndex: copy.zIndex,
            }}
          >
            <BoardSurface
              spec={visibleSpec}
              fallbackLabel={pool.name}
              size={{
                width: tokenSize.width,
                height: tokenSize.height,
              }}
              imageAssets={imageAssets}
              rounded={false}
              shadowMode={shadowMode}
            />
          </div>
        ))}
      </div>
      {remainingLabel ? <div className="board-pool-count">{remainingLabel}</div> : null}
    </div>
  )
}

interface BoardObjectContentProps {
  objectId: Id
  room: RoomDoc
  currentPlayerId: string | undefined
  imageAssets: ReadonlyMap<AutomergeUrl, ResolvedImageAsset>
  pdfAssets: ReadonlyMap<AutomergeUrl, ResolvedPdfAsset>
  size: Size
  constrainedEffects: boolean
  canInstantiatePool: boolean
  onInstantiatePoolBoard: (event: ReactPointerEvent<HTMLDivElement>, poolId: Id) => void
}

interface BookObjectProps {
  bookId: Id
  room: RoomDoc
  imageAssets: ReadonlyMap<AutomergeUrl, ResolvedImageAsset>
  pdfAssets: ReadonlyMap<AutomergeUrl, ResolvedPdfAsset>
  size: Size
}

function BookObject({ bookId, room, imageAssets, pdfAssets, size }: BookObjectProps) {
  const candidate = room.objects[bookId]
  const book = isBook(candidate) ? candidate : undefined
  const pdfSource = resolvePdfSource(book?.pdfUrl, pdfAssets)
  const { imageUrl, loading, error } = usePdfPageImage(pdfSource?.renderUrl, book?.currentPage ?? 1, size, {
    qualityBoost: 2.5,
    maxDimension: 2048,
  })
  if (!book) {
    return null
  }
  const isImportingPdf = book.meta.importingPdf === true
  const hasImportError = book.meta.pdfImportError === true
  const bookLabel = book.name.trim() || 'PDF'
  const previewSpec: SpriteSpec = imageUrl
    ? {
        kind: 'image-url',
        url: imageUrl,
        fit: 'contain',
        bg: '#f5f0e4',
      }
    : {
        kind: 'label',
        label: isImportingPdf || loading
          ? bookLabel
          : error || hasImportError
            ? 'PDF Error'
            : pdfSource
              ? bookLabel
              : 'Missing PDF',
        bg: '#f5f0e4',
        fg: '#22303a',
      }

  return (
    <div className="board-book-shell">
      <BoardSurface
        spec={previewSpec}
        fallbackLabel={book.name}
        size={size}
        imageAssets={imageAssets}
        rounded={false}
        className="board-book-surface"
      />
      <div className="board-book-page-badge">
        {book.currentPage}/{Math.max(book.currentPage, book.pageCount)}
      </div>
    </div>
  )
}

function BoardObjectContent({
  objectId,
  room,
  currentPlayerId,
  imageAssets,
  pdfAssets,
  size,
  constrainedEffects,
  canInstantiatePool,
  onInstantiatePoolBoard,
}: BoardObjectContentProps) {
  const object = room.objects[objectId]
  const boardShadowMode = useBoardSurfaceShadowMode(
    isBoard(object) ? (isBoardFaceUp(object) ? object.face : object.back) : { kind: 'label' },
    imageAssets,
    isBoard(object),
  )
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
        shadowMode={boardShadowMode}
      />
    )
  }

  if (isPool(object)) {
    return (
      <PoolObject
        poolId={objectId}
        room={room}
        imageAssets={imageAssets}
        interactive={canInstantiatePool}
        onInstantiate={onInstantiatePoolBoard}
      />
    )
  }

  if (isBook(object)) {
    return (
      <BookObject
        bookId={objectId}
        room={room}
        imageAssets={imageAssets}
        pdfAssets={pdfAssets}
        size={size}
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
  if (prevProps.pdfAssets !== nextProps.pdfAssets) {
    return false
  }
  if (prevProps.constrainedEffects !== nextProps.constrainedEffects) {
    return false
  }
  if (prevProps.canInstantiatePool !== nextProps.canInstantiatePool) {
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
  const { imageUrl, crop, fitWidth, fitHeight } = useBoardSurfaceLayout(spec, size, imageAssets, false)
  const dominantRegion = useLargestOpaqueRegion(imageUrl, crop)
  const isAlphaSelection = Boolean(imageUrl && usesAlphaSurfaceSelection(spec))

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
  pdfAssets,
  dropImportError,
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
  onStartDuplicateDrag,
  onInstantiateBoardFromPool,
  onDeleteObject,
  onLiftTopCardFromDeck,
  onFlipCard,
  onFlipBoard,
  onFlipDeck: _onFlipDeck,
  onDrawDeck: _onDrawDeck,
  onDropFileAt,
  onShuffleDeck,
  onOpenBook,
  onOpenSelectionPanel,
}: BoardViewProps) {
  void _onFlipDeck
  void _onDrawDeck

  const rootRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const boardWorldRef = useRef<HTMLDivElement>(null)
  const boardGridShadowRef = useRef<HTMLDivElement>(null)
  const boardGridRef = useRef<HTMLCanvasElement>(null)
  const rotateHandleRef = useRef<HTMLButtonElement>(null)
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
  const pendingTouchPressRef = useRef<PendingTouchPress | null>(null)
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
  const completedPrewarmTaskKeysRef = useRef(new Set<string>())
  const hasActiveAlphaSelectionRef = useRef(false)
  const hasRotateHandleRef = useRef(false)
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

  const clearPendingTouchPress = useCallback(() => {
    const pendingTouchPress = pendingTouchPressRef.current
    if (!pendingTouchPress) {
      return
    }

    if (pendingTouchPress.timeoutId !== null) {
      window.clearTimeout(pendingTouchPress.timeoutId)
    }
    pendingTouchPressRef.current = null
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
    clearPendingTouchPress()
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
  }, [clearPendingTouchPress, onClearPreviewTransform, replacePreviewTransforms])

  const currentTransformForObject = useCallback((objectId: Id) => {
    return displayedTransformForObject(
      roomRef.current,
      objectId,
      ephemeralTransformsRef.current,
      previewTransformsRef.current,
    )
  }, [])

  const applyRotateHandlePosition = useCallback((nextCamera: CameraState) => {
    const rotateHandle = rotateHandleRef.current
    const selectedObject = selectedWorldObjectRef.current
    if (!rotateHandle || !selectedObject || !hasRotateHandleRef.current) {
      return
    }

    const screenPoint = rotateHandleScreenPoint(
      viewportSize,
      nextCamera,
      selectedObject.transform,
      selectedObject.worldSize,
    )
    rotateHandle.style.left = `${screenPoint.x}px`
    rotateHandle.style.top = `${screenPoint.y}px`
  }, [viewportSize])

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
    const boardGridShadow = boardGridShadowRef.current
    const boardGrid = boardGridRef.current
    if (!boardWorld) {
      return
    }

    const { x: translateX, y: translateY } = cameraTranslation(viewportSize, nextCamera)
    boardWorld.style.transform = `translate3d(${translateX}px, ${translateY}px, 0) scale(${nextCamera.zoom})`
    boardWorld.style.setProperty('--board-zoom', `${nextCamera.zoom}`)
    if (boardGridShadow) {
      applyBoardGridShadowStyle(boardGridShadow, viewportSize, nextCamera)
    }
    if (boardGrid) {
      drawBoardGridCanvas(boardGrid, viewportSize, nextCamera)
    }
    applyRotateHandlePosition(nextCamera)
    applyQuickActionsPosition(nextCamera)
  }, [applyQuickActionsPosition, applyRotateHandlePosition, viewportSize])

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
    options?: Pick<DragState, 'spawnedFromPool' | 'selectOnMove' | 'moved'>,
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
      moved: options?.moved ?? false,
      raisedToFront: false,
      spawnedFromPool: options?.spawnedFromPool,
      selectOnMove: options?.selectOnMove,
      groupMembers,
    }
  }, [viewportSize])

  const startDuplicateDrag = useCallback((
    objectId: Id,
    pointerId: number,
    startPoint: Point,
    groupObjectIds?: Id[],
  ) => {
    const duplicateDrag = onStartDuplicateDrag(objectId, groupObjectIds)
    if (!duplicateDrag) {
      return false
    }

    startDrag(
      duplicateDrag.id,
      pointerId,
      'move',
      startPoint,
      duplicateDrag.startTransform,
      undefined,
      duplicateDrag.groupMembers,
    )
    return true
  }, [onStartDuplicateDrag, startDrag])

  const beginPendingTouchPress = useCallback((
    objectId: Id,
    pointerId: number,
    startPoint: Point,
    startTransform: Transform2D,
    moveAction: PendingTouchPress['moveAction'],
    enableLongPressMove = true,
    dragOutTransform?: Transform2D,
  ) => {
    clearPendingTouchPress()
    pendingTouchPressRef.current = {
      objectId,
      pointerId,
      startPoint,
      startTransform,
      dragOutTransform,
      moveAction,
      timeoutId: enableLongPressMove
        ? window.setTimeout(() => {
            const pendingTouchPress = pendingTouchPressRef.current
            if (
              !pendingTouchPress ||
              pendingTouchPress.objectId !== objectId ||
              pendingTouchPress.pointerId !== pointerId
            ) {
              return
            }

            pendingTouchPressRef.current = null
            startDrag(
              objectId,
              pointerId,
              'move',
              pendingTouchPress.startPoint,
              pendingTouchPress.startTransform,
            )
          }, TOUCH_LONG_PRESS_MS)
        : null,
    }
  }, [clearPendingTouchPress, startDrag])

  const armPoolCopyDragOut = useCallback((
    poolId: Id,
    pointerId: number,
    startPoint: Point,
    startTransform: Transform2D,
    enableLongPressMove: boolean,
  ) => {
    const dragOutTransform = {
      x: startTransform.x,
      y: startTransform.y,
      rotation: 0,
    }

    tapCandidateRef.current = {
      id: poolId,
      pointerId,
      startPoint,
    }

    beginPendingTouchPress(
      poolId,
      pointerId,
      startPoint,
      startTransform,
      'pool-drag-out',
      enableLongPressMove,
      dragOutTransform,
    )
  }, [beginPendingTouchPress])

  const transformForElementCenter = useCallback((element: Element) => {
    const rect = element.getBoundingClientRect()
    const localCenter = clientToLocal(
      rootRef.current,
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    )
    if (!localCenter) {
      return undefined
    }

    const worldCenter = screenToLogical(viewportSize, cameraRef.current, localCenter)
    return {
      x: worldCenter.x,
      y: worldCenter.y,
      rotation: 0,
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

  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) {
      return
    }

    const updateViewportSize = (nextViewport: Size) => {
      setViewportSize((current) =>
        current.width === nextViewport.width && current.height === nextViewport.height ? current : nextViewport,
      )
    }

    updateViewportSize(viewportSizeFromElement(host))

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) {
        return
      }

      updateViewportSize({
        width: Math.max(1, Math.round(entry.contentRect.width)),
        height: Math.max(1, Math.round(entry.contentRect.height)),
      })
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

    const seenTaskKeys = new Set<string>()
    const queue = Object.values(room.objects).flatMap((object) => {
      if (!isDeck(object) || object.childIds.length < 2) {
        return []
      }

      const nextCard = room.objects[object.childIds[object.childIds.length - 2]]
      if (!isCard(nextCard)) {
        return []
      }

      const spec = canSeeCardFace(nextCard, currentPlayerId) ? nextCard.face : nextCard.back
      if (spec.kind !== 'image-url' || !spec.url) {
        return []
      }

      const source = resolveImageSource(spec.url, imageAssets)
      const imageUrl = source?.renderUrl
      if (!imageUrl) {
        return []
      }

      const crop = normalizeCrop(spec.crop)
      const taskKey = [
        imageUrl,
        nextCard.size.width,
        nextCard.size.height,
        spec.fit ?? 'cover',
        crop.x.toFixed(4),
        crop.y.toFixed(4),
        crop.width.toFixed(4),
        crop.height.toFixed(4),
      ].join('|')
      if (seenTaskKeys.has(taskKey) || completedPrewarmTaskKeysRef.current.has(taskKey)) {
        return []
      }

      seenTaskKeys.add(taskKey)
      return [{ imageUrl, source, spec, size: nextCard.size, taskKey }]
    })

    if (queue.length === 0) {
      return
    }

    let cancelled = false
    let idleCallbackId: number | undefined
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | undefined
    let nextTaskIndex = 0

    const markTaskComplete = (taskKey: string) => {
      if (cancelled) {
        return
      }

      completedPrewarmTaskKeysRef.current.add(taskKey)
    }

    const runNextTask = async () => {
      const task = queue[nextTaskIndex]
      nextTaskIndex += 1
      if (!task) {
        return
      }

      const intrinsicSize = task.source?.asset?.width && task.source.asset.height
        ? {
          width: task.source.asset.width,
          height: task.source.asset.height,
        }
        : await loadSourceImageElement(task.imageUrl)
          .then((image) => {
            if (image.naturalWidth <= 0 || image.naturalHeight <= 0) {
              return undefined
            }

            const size = {
              width: image.naturalWidth,
              height: image.naturalHeight,
            }
            intrinsicImageSizeCache.set(task.imageUrl, size)
            return size
          })
          .catch(() => undefined)
      if (!intrinsicSize || cancelled) {
        return
      }
      if (prewarmPauseUntilRef.current > performance.now()) {
        nextTaskIndex -= 1
        return
      }

      const crop = normalizeCrop(task.spec.crop)
      const { fitWidth, fitHeight } = computeSurfaceFit(crop, task.size, intrinsicSize, task.spec.fit ?? 'cover')
      await requestPreparedSpriteSurface(
        task.imageUrl,
        crop,
        task.size.width * fitWidth,
        task.size.height * fitHeight,
        intrinsicSize,
      )
      markTaskComplete(task.taskKey)
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

          let tasksRun = 0
          while (
            !cancelled &&
            nextTaskIndex < queue.length &&
            tasksRun < PREPARED_SPRITE_PREWARM_MAX_TASKS_PER_IDLE &&
            prewarmPauseUntilRef.current <= performance.now() &&
            deadline.timeRemaining() >= PREPARED_SPRITE_PREWARM_MIN_IDLE_MS
          ) {
            await runNextTask()
            tasksRun += 1
          }
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
  }, [currentPlayerId, imageAssets, room.objects])

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

      const pendingTouchPress = pendingTouchPressRef.current
      if (!dragRef.current && pendingTouchPress && pendingTouchPress.pointerId === event.pointerId) {
        const pointerDistance = Math.hypot(
          localPoint.x - pendingTouchPress.startPoint.x,
          localPoint.y - pendingTouchPress.startPoint.y,
        )

        if (pointerDistance > TAP_GRACE_DISTANCE) {
          clearPendingTouchPress()

          if (pendingTouchPress.moveAction === 'deck-drag-out') {
            const liftedCardId = onLiftTopCardFromDeck(pendingTouchPress.objectId)
            const dragId = liftedCardId ?? pendingTouchPress.objectId
            if (liftedCardId) {
              onBringObjectToFront(liftedCardId)
              onSelect(liftedCardId)
            }

            startDrag(
              dragId,
              event.pointerId,
              'move',
              pendingTouchPress.startPoint,
              pendingTouchPress.startTransform,
            )
          } else if (pendingTouchPress.moveAction === 'pool-drag-out') {
            const dragOutTransform = pendingTouchPress.dragOutTransform ?? pendingTouchPress.startTransform
            const createdId = onInstantiateBoardFromPool(pendingTouchPress.objectId, dragOutTransform)
            if (createdId) {
              startDrag(createdId, event.pointerId, 'move', pendingTouchPress.startPoint, dragOutTransform, {
                spawnedFromPool: true,
                selectOnMove: true,
                moved: true,
              })
            }
          }
        }

        if (pendingTouchPressRef.current?.pointerId === event.pointerId && pendingTouchPress.moveAction === 'pool-drag-out') {
          return
        }
      }

      const tapCandidate = tapCandidateRef.current
      if (!dragRef.current && tapCandidate?.pointerId === event.pointerId && tapCandidate.drag) {
        const pointerDistance = Math.hypot(
          localPoint.x - tapCandidate.startPoint.x,
          localPoint.y - tapCandidate.startPoint.y,
        )

        if (pointerDistance > TAP_GRACE_DISTANCE) {
          startDrag(
            tapCandidate.id,
            event.pointerId,
            'move',
            tapCandidate.startPoint,
            tapCandidate.drag.startTransform,
            undefined,
            tapCandidate.drag.groupMembers,
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
        if (activeDrag.moved && activeDrag.selectOnMove) {
          activeDrag.selectOnMove = false
          onSelect(activeDrag.id)
        }

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
              draggingObject && (draggingObject.type === 'card' || draggingObject.type === 'deck' || draggingObject.type === 'board')
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
      clearPendingTouchPress()
      const hadCameraPointer = cameraPointersRef.current.has(event.pointerId)
      const shouldStartMomentum =
        hadCameraPointer &&
        cameraPointersRef.current.size === 1 &&
        pointerPanStateRef.current.active

      const localPoint = clientToLocal(rootRef.current, event.clientX, event.clientY)
      if (!localPoint) {
        return
      }

      const releaseVelocity = shouldStartMomentum
        ? releasePanVelocity(
            pointerPanStateRef.current.recentSamples,
            localPoint,
            performance.now() / 1000,
            PAN_MOMENTUM_SAMPLE_WINDOW_SECONDS,
          )
        : pointerPanStateRef.current.lastVelocity

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
          if (activeDrag.spawnedFromPool && !activeDrag.moved) {
            onClearPreviewTransform(activeDrag.id)
            replacePreviewTransforms({})
            onDeleteObject(activeDrag.id)
            return
          }

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
            object && (object.type === 'card' || object.type === 'deck' || object.type === 'board')
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
        if (drag.spawnedFromPool && !drag.moved) {
          onClearPreviewTransform(drag.id)
          onDeleteObject(drag.id)
        } else if (drag.groupMembers && drag.groupMembers.length > 0) {
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

      clearPendingTouchPress()
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
    clearPendingTouchPress,
    beginPendingTouchPress,
    onAddToGroupSelection,
    onBringObjectToFront,
    onClearPreviewTransform,
    onCommitTransform,
    onDeleteObject,
    onDropObjectOntoObject,
    onInstantiateBoardFromPool,
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
      clearPendingTouchPress()
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
    [clearPendingTouchPress, flushPendingCameraUpdate, stopCameraMomentum],
  )

  const quickActions = useMemo<QuickAction[]>(() => {
    if (selectionMode !== 'normal' || !selectedId) {
      return []
    }

    const object = room.objects[selectedId]
    if (!object) {
      return []
    }

    if (object.type === 'card') {
      if (!canEdit) {
        return []
      }
      return [
        { id: 'flip', label: 'Flip', icon: 'flip', onClick: () => onFlipCard(object.id) },
        { id: 'more', label: 'More actions', icon: 'more', onClick: onOpenSelectionPanel },
      ]
    }

    if (object.type === 'deck') {
      if (!canEdit) {
        return []
      }
      return [
        { id: 'shuffle', label: 'Shuffle', icon: 'shuffle', onClick: () => onShuffleDeck(object.id) },
        { id: 'more', label: 'More actions', icon: 'more', onClick: onOpenSelectionPanel },
      ]
    }

    if (object.type === 'board') {
      if (!canEdit) {
        return []
      }
      return [
        { id: 'flip', label: 'Flip', icon: 'flip', onClick: () => onFlipBoard(object.id) },
        { id: 'more', label: 'More actions', icon: 'more', onClick: onOpenSelectionPanel },
      ]
    }

    if (object.type === 'pool') {
      return [
        { id: 'more', label: 'More actions', icon: 'more', onClick: onOpenSelectionPanel },
      ]
    }

    if (object.type === 'book') {
      return [
        { id: 'view', label: 'Open PDF', icon: 'view', onClick: () => onOpenBook(object.id) },
        { id: 'more', label: 'More actions', icon: 'more', onClick: onOpenSelectionPanel },
      ]
    }

    return []
  }, [canEdit, onFlipBoard, onFlipCard, onOpenBook, onOpenSelectionPanel, onShuffleDeck, room.objects, selectedId, selectionMode])
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

  const selectedRotateHandleObject = useMemo(() => {
    if (selectionMode !== 'normal' || !selectedId || !selectedWorldObject || !canEdit) {
      return undefined
    }

    const object = room.objects[selectedId]
    if (!object || object.locked || isPool(object)) {
      return undefined
    }

    return selectedWorldObject
  }, [canEdit, room.objects, selectedId, selectedWorldObject, selectionMode])

  const hasActiveAlphaSelection = useMemo(() => {
    const candidateIds = selectionMode === 'group' ? selectedIds : selectedId ? [selectedId] : []
    return candidateIds.some((objectId) => {
      const object = room.objects[objectId]
      if (!isBoard(object) && !isPool(object)) {
        return false
      }
      const spec = isBoard(object)
        ? (isBoardFaceUp(object) ? object.face : object.back)
        : (isPoolFaceUp(object) ? object.face : object.back)
      return spec.kind === 'image-url' && (spec.bg === undefined || spec.bg === 'transparent')
    })
  }, [room, selectedId, selectedIds, selectionMode])
  hasActiveAlphaSelectionRef.current = hasActiveAlphaSelection

  useLayoutEffect(() => {
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
  const rotateHandlePosition = useMemo(() => {
    if (!selectedRotateHandleObject) {
      return undefined
    }

    const screenPoint = rotateHandleScreenPoint(
      viewportSize,
      cameraRef.current,
      selectedRotateHandleObject.transform,
      selectedRotateHandleObject.worldSize,
    )

    return {
      left: `${screenPoint.x}px`,
      top: `${screenPoint.y}px`,
    }
  }, [selectedRotateHandleObject, viewportSize])
  selectedWorldObjectRef.current = selectedWorldObject
  hasRotateHandleRef.current = Boolean(selectedRotateHandleObject)

  useLayoutEffect(() => {
    applyRotateHandlePosition(cameraRef.current)
    applyQuickActionsPosition(cameraRef.current)
  }, [applyQuickActionsPosition, applyRotateHandlePosition, quickActions.length, selectedRotateHandleObject, selectedWorldObject])

  const boardWorldStyle = useMemo<CSSProperties>(() => {
    return {
      width: '0px',
      height: '0px',
    }
  }, [])

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

    const poolCopyElement = (event.target as HTMLElement | null)?.closest('[data-board-ui="pool-copy"]')
    const startedOnPoolCopy = Boolean(poolCopyElement)

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
      const groupMembers =
        isSelected && canEdit && isMovableObjectType(room, objectId)
          ? selectedIds
              .map((memberId) => {
                const memberTransform = currentTransformForObject(memberId)
                return memberTransform ? { id: memberId, startTransform: { ...memberTransform } } : undefined
              })
              .filter((member): member is { id: Id; startTransform: Transform2D } => Boolean(member))
          : undefined
      tapCandidateRef.current = {
        id: objectId,
        pointerId: event.pointerId,
        startPoint: localPoint,
        drag: groupMembers ? { startTransform: { ...currentTransform }, groupMembers } : undefined,
      }

      if (!isSelected) {
        return
      }

      if (!canEdit || !isMovableObjectType(room, objectId)) {
        return
      }

      if (
        event.altKey &&
        startDuplicateDrag(objectId, event.pointerId, localPoint, selectedIds)
      ) {
        return
      }

      startDrag(
        objectId,
        event.pointerId,
        'move',
        localPoint,
        currentTransform,
        undefined,
        selectedIds
          .map((memberId) => {
            const memberTransform = currentTransformForObject(memberId)
            return memberTransform ? { id: memberId, startTransform: { ...memberTransform } } : undefined
          })
          .filter((member): member is { id: Id; startTransform: Transform2D } => Boolean(member)),
      )
      return
    }

    if (isTouchPointer && isPool(object) && startedOnPoolCopy) {
      event.stopPropagation()

      tapCandidateRef.current = {
        id: objectId,
        pointerId: event.pointerId,
        startPoint: localPoint,
      }

      if (selectedId !== objectId || !canEdit) {
        return
      }

      const poolCopyTransform = poolCopyElement ? transformForElementCenter(poolCopyElement) : undefined
      armPoolCopyDragOut(objectId, event.pointerId, localPoint, poolCopyTransform ?? { ...currentTransform }, true)
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

      if (!isTouchPointer && event.altKey && startDuplicateDrag(objectId, event.pointerId, localPoint)) {
        return
      }

      beginPendingTouchPress(objectId, event.pointerId, localPoint, { ...currentTransform }, 'deck-drag-out')
      return
    }

    if (isTouchPointer && isPool(object)) {
      event.stopPropagation()
      tapCandidateRef.current = {
        id: objectId,
        pointerId: event.pointerId,
        startPoint: localPoint,
      }

      if (selectedId !== objectId || !canEdit || !isMovableObjectType(room, objectId)) {
        return
      }

      beginPendingTouchPress(objectId, event.pointerId, localPoint, { ...currentTransform }, 'none')
      return
    }

    if (!isTouchPointer) {
      event.stopPropagation()
      onSelect(objectId)
      if (!canEdit || !isMovableObjectType(room, objectId)) {
        return
      }

      if (event.altKey && startDuplicateDrag(objectId, event.pointerId, localPoint)) {
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
    armPoolCopyDragOut,
    allowSelectLocked,
    canEdit,
    beginPendingTouchPress,
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
    startDuplicateDrag,
    startDrag,
    stopCameraMomentum,
    transformForElementCenter,
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

  const handlePoolInstantiatePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>, poolId: Id) => {
    if (!canEdit || selectionMode !== 'normal') {
      return
    }

    if (event.pointerType === 'touch') {
      return
    }

    const localPoint = clientToLocal(rootRef.current, event.clientX, event.clientY)
    if (!localPoint) {
      return
    }

    const pool = room.objects[poolId]
    if (!isPool(pool)) {
      return
    }

    event.stopPropagation()
    markPrewarmInteraction()
    stopCameraMomentum()
    resetPointerPanState()
    const copyTransform = transformForElementCenter(event.currentTarget)
    if (!copyTransform) {
      return
    }

    armPoolCopyDragOut(poolId, event.pointerId, localPoint, copyTransform, false)
  }, [
    armPoolCopyDragOut,
    canEdit,
    markPrewarmInteraction,
    resetPointerPanState,
    room,
    selectionMode,
    stopCameraMomentum,
    transformForElementCenter,
  ])

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
    const files = importFilesFromTransfer(event.dataTransfer)
    resetDropTarget()
    if (files.length === 0) {
      return
    }

    const localPoint = clientToLocal(rootRef.current, event.clientX, event.clientY)
    if (!localPoint) {
      return
    }

    onDropFileAt(files, screenToLogical(viewportSize, cameraRef.current, localPoint))
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
        const boardSelectionSpec =
          isBoard(object)
            ? (isBoardFaceUp(object) ? object.face : object.back)
            : undefined
        const usesAlphaBoardSelection = Boolean(
          boardSelectionSpec &&
          usesAlphaSurfaceSelection(boardSelectionSpec),
        )
        const usesCardOutlineSelection = isCard(object) && selectionStrokeWidth > 0
        const usesPoolOutlineSelection = isPool(object) && selectionStrokeWidth > 0
        const worldPosition = transform

        return (
          <div
            key={objectId}
            className={`board-object board-object-${object.type}${isDragging ? ' is-dragging' : ''}${usesCardOutlineSelection ? ' has-card-outline-selection' : ''}${usesPoolOutlineSelection ? ' has-pool-outline-selection' : ''}`}
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
              pdfAssets={pdfAssets}
              size={worldSize}
              constrainedEffects={constrainedEffects}
              canInstantiatePool={canEdit && selectionMode === 'normal'}
              onInstantiatePoolBoard={handlePoolInstantiatePointerDown}
            />
            {selectionStrokeWidth > 0 && !usesCardOutlineSelection && !usesPoolOutlineSelection && (!boardSelectionSpec || !usesAlphaBoardSelection) ? (
              <div
                className={`board-object-selection ${object.type === 'board' || object.type === 'book' ? 'is-square' : 'is-rounded'}`}
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
      handlePoolInstantiatePointerDown,
      hoverDropTargetId,
      imageAssets,
      pdfAssets,
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
        <div className="board-grid-shadow" ref={boardGridShadowRef} aria-hidden="true" />
        <canvas className="board-grid" ref={boardGridRef} aria-hidden="true" />
        <div className="board-world" ref={boardWorldRef} style={boardWorldStyle}>
          <div className="board-objects">{objectElements}</div>
        </div>
      </div>
      {isImageDropTarget ? (
        <div className="board-drop-overlay">Drop image or PDF to import</div>
      ) : null}
      {dropImportError ? (
        <div className="board-drop-error" role="status">{dropImportError}</div>
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
      {selectedId && selectedRotateHandleObject && rotateHandlePosition ? (
        <button
          ref={rotateHandleRef}
          type="button"
          className="board-rotate-handle"
          data-board-ui="rotate-handle"
          style={rotateHandlePosition}
          onPointerDown={(event) => handleRotatePointerDown(event, selectedId)}
          aria-label={`Rotate ${room.objects[selectedId]?.name ?? 'selection'}`}
        />
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
                : action.icon === 'view'
                  ? <ViewQuickActionIcon />
                : action.icon === 'shuffle'
                  ? <ShuffleIcon />
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
