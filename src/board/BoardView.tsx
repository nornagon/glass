import { useEffect, useMemo, useRef } from 'react'
import { useState } from 'react'
import { Application, Assets, Cache, Container, FederatedPointerEvent, Graphics, PerspectiveMesh, Rectangle, Sprite, Text, Texture } from 'pixi.js'
import { Viewport } from 'pixi-viewport'
import { BOARD_WORLD_SIZE, DEFAULT_CARD_SIZE, type CameraState, type Id, type RoomDoc, type SpriteSpec, type Transform2D } from '../model/types'
import { canSeeCardFace, getRootPlane, getTransform, isBoard, isBoardFaceUp, isCard, isDeck } from '../model/room'

interface BoardViewProps {
  room: RoomDoc
  roomUrl: string
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
  onDropObjectToDeck: (objectId: Id, deckId: Id) => void
  onBringCardToFront: (cardId: Id) => void
  onLiftTopCardFromDeck: (deckId: Id) => Id | undefined
  onFlipCard: (cardId: Id) => void
  onFlipBoard: (boardId: Id) => void
  onFlipDeck: (deckId: Id) => void
  onDrawDeck: (deckId: Id) => void
  onShuffleDeck: (deckId: Id) => void
  onOpenSelectionPanel: () => void
}

function isMovableObjectType(room: RoomDoc, objectId: Id) {
  const object = room.objects[objectId]
  return Boolean(isCard(object) || isDeck(object) || isBoard(object))
}

function isMultiselectObjectType(room: RoomDoc, objectId: Id) {
  const object = room.objects[objectId]
  return Boolean(isCard(object) || isDeck(object))
}

interface RenderedObject {
  container: Container
  width: number
  height: number
  transform: Transform2D
}

interface DragState {
  id: Id
  pointerId: number
  mode: 'move' | 'rotate'
  startPointer: { x: number; y: number }
  startTransform: Transform2D
  currentGlobal: { x: number; y: number }
  moved: boolean
  raisedToFront: boolean
  groupMembers?: Array<{ id: Id; startTransform: Transform2D }>
}

interface PendingDeckPress {
  deckId: Id
  pointerId: number
  startGlobal: { x: number; y: number }
  startWorld: { x: number; y: number }
  startTransform: Transform2D
  timeoutId: number
}

interface TapCandidate {
  id: Id
  pointerId: number
  startPointer: { x: number; y: number }
}

interface BackgroundTapCandidate {
  pointerId: number
  startPointer: { x: number; y: number }
}

interface CardVisualState {
  faceUp: boolean
  faceVisible: boolean
}

interface AuxiliaryTouchState {
  pointers: Map<number, { x: number; y: number }>
}

interface LassoState {
  pointerId: number
  points: Array<{ x: number; y: number }>
}

interface FlipAnimation {
  startedAt: number
  durationMs: number
  fromFaceVisible: boolean
  toFaceVisible: boolean
}

interface QuickAction {
  id: string
  label: string
  onClick: () => void
  icon?: 'flip' | 'more'
  text?: string
}

interface CardFlipPresentation {
  faceVisible: boolean
  angle: number
  offsetY: number
}

interface CardTextureCacheEntry {
  signature: string
  texture: Texture
}

const TAP_GRACE_DISTANCE = 10
const DECK_LONG_PRESS_MS = 360
const MIN_ZOOM_SCALE = 0.2
const MAX_ZOOM_SCALE = 2.5
const PAN_CLAMP_MARGIN = 640
const VIEWPORT_WORLD_SIZE = BOARD_WORLD_SIZE + PAN_CLAMP_MARGIN * 2
const VIEWPORT_WORLD_OFFSET = VIEWPORT_WORLD_SIZE / 2
const FLIP_DURATION_MS = 220
const FLIP_DEBUG_DURATION_MS = 1800

type EphemeralTransformMap = Partial<Record<Id, Transform2D>>

function logicalToViewportPoint(point: { x: number; y: number }) {
  return {
    x: point.x + VIEWPORT_WORLD_OFFSET,
    y: point.y + VIEWPORT_WORLD_OFFSET,
  }
}

function viewportToLogicalPoint(point: { x: number; y: number }) {
  return {
    x: point.x - VIEWPORT_WORLD_OFFSET,
    y: point.y - VIEWPORT_WORLD_OFFSET,
  }
}

function collectCardVisualStates(room: RoomDoc, currentPlayerId: string | undefined) {
  const states = new Map<Id, CardVisualState>()

  for (const [objectId, object] of Object.entries(room.objects)) {
    if (!isCard(object)) {
      continue
    }

    states.set(objectId, {
      faceUp: object.meta.faceUp !== false,
      faceVisible: canSeeCardFace(object, currentPlayerId),
    })
  }

  return states
}

function cardFlipPresentation(
  objectId: Id,
  defaultFaceVisible: boolean,
  flipAnimations: Map<Id, FlipAnimation>,
  now: number,
): CardFlipPresentation {
  const animation = flipAnimations.get(objectId)
  if (!animation) {
    return {
      faceVisible: defaultFaceVisible,
      angle: 0,
      offsetY: 0,
    }
  }

  const elapsed = now - animation.startedAt
  if (elapsed >= animation.durationMs) {
    flipAnimations.delete(objectId)
    return {
      faceVisible: animation.toFaceVisible,
      angle: 0,
      offsetY: 0,
    }
  }

  const progress = elapsed / animation.durationMs
  const depth = Math.sin(progress * Math.PI)
  const turnDirection = animation.toFaceVisible ? 1 : -1
  const halfProgress = progress < 0.5 ? progress / 0.5 : (progress - 0.5) / 0.5
  return {
    faceVisible: progress < 0.5 ? animation.fromFaceVisible : animation.toFaceVisible,
    angle:
      progress < 0.5
        ? turnDirection * halfProgress * (Math.PI / 2)
        : -turnDirection * (1 - halfProgress) * (Math.PI / 2),
    offsetY: -depth * 10,
  }
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

interface TextureAssetEntry {
  texture?: Texture
  status: 'loading' | 'loaded' | 'error'
  listeners: Set<() => void>
}

const textureAssetCache = new Map<string, TextureAssetEntry>()
const croppedTextureCache = new Map<string, Texture>()

function requestTextureAsset(url: string, onReady: () => void) {
  if (Cache.has(url)) {
    return Cache.get<Texture>(url)
  }

  const existing = textureAssetCache.get(url)
  if (existing) {
    if (existing.status === 'loaded') {
      return existing.texture
    }
    if (existing.status === 'loading') {
      existing.listeners.add(onReady)
    }
    return undefined
  }

  const entry: TextureAssetEntry = {
    status: 'loading',
    listeners: new Set([onReady]),
  }

  textureAssetCache.set(url, entry)
  void Assets.load<Texture>({
    alias: url,
    src: url,
    data: {
      crossOrigin: 'anonymous',
    },
  })
    .then((texture) => {
      entry.texture = texture
      entry.status = 'loaded'
      for (const listener of entry.listeners) {
        listener()
      }
      entry.listeners.clear()
    })
    .catch(() => {
      entry.status = 'error'
      entry.listeners.clear()
    })

  return undefined
}

function normalizeCrop(crop?: { x: number; y: number; width: number; height: number }) {
  if (!crop) {
    return undefined
  }

  const x = Math.max(0, Math.min(1, crop.x))
  const y = Math.max(0, Math.min(1, crop.y))
  const width = Math.max(0.001, Math.min(1 - x, crop.width))
  const height = Math.max(0.001, Math.min(1 - y, crop.height))

  if (x === 0 && y === 0 && width === 1 && height === 1) {
    return undefined
  }

  return { x, y, width, height }
}

function textureForSpriteSpec(
  url: string,
  texture: Texture,
  crop?: { x: number; y: number; width: number; height: number },
) {
  const normalizedCrop = normalizeCrop(crop)
  if (!normalizedCrop) {
    return texture
  }

  const cacheKey = `${url}|${normalizedCrop.x},${normalizedCrop.y},${normalizedCrop.width},${normalizedCrop.height}`
  const cached = croppedTextureCache.get(cacheKey)
  if (cached) {
    return cached
  }

  const frame = texture.frame
  const croppedTexture = new Texture({
    source: texture.source,
    frame: new Rectangle(
      frame.x + frame.width * normalizedCrop.x,
      frame.y + frame.height * normalizedCrop.y,
      frame.width * normalizedCrop.width,
      frame.height * normalizedCrop.height,
    ),
  })
  croppedTextureCache.set(cacheKey, croppedTexture)
  return croppedTexture
}

function objectDimensions(room: RoomDoc, objectId: Id) {
  const object = room.objects[objectId]
  if (isCard(object)) {
    return object.size
  }
  if (isBoard(object)) {
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

function transformForObject(room: RoomDoc, objectId: Id, ephemeralTransforms: EphemeralTransformMap) {
  return ephemeralTransforms[objectId] ?? getTransform(room, objectId)
}

function pointInObjectRect(
  room: RoomDoc,
  objectId: Id,
  point: { x: number; y: number },
  ephemeralTransforms: EphemeralTransformMap,
) {
  const transform = transformForObject(room, objectId, ephemeralTransforms)
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

function findDeckAtPoint(
  room: RoomDoc,
  point: { x: number; y: number },
  ephemeralTransforms: EphemeralTransformMap,
  ignoreId?: Id,
) {
  const root = getRootPlane(room)

  for (let index = root.childOrder.length - 1; index >= 0; index -= 1) {
    const objectId = root.childOrder[index]
    if (objectId === ignoreId) {
      continue
    }
    const object = room.objects[objectId]
    if (isDeck(object) && pointInObjectRect(room, objectId, point, ephemeralTransforms)) {
      return objectId
    }
  }

  return undefined
}

function pointInPolygon(point: { x: number; y: number }, polygon: Array<{ x: number; y: number }>) {
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
  viewport: Viewport,
  room: RoomDoc,
  ephemeralTransforms: EphemeralTransformMap,
  polygon: Array<{ x: number; y: number }>,
) {
  const root = getRootPlane(room)
  const selectedIds: Id[] = []

  for (const objectId of root.childOrder) {
    if (!isMultiselectObjectType(room, objectId)) {
      continue
    }

    const transform = transformForObject(room, objectId, ephemeralTransforms)
    if (!transform) {
      continue
    }

    const screenPoint = viewport.toScreen(logicalToViewportPoint({
      x: transform.x,
      y: transform.y,
    }))
    if (pointInPolygon({ x: screenPoint.x, y: screenPoint.y }, polygon)) {
      selectedIds.push(objectId)
    }
  }

  return selectedIds
}

function boardBackground() {
  const grid = new Graphics()
  const span = BOARD_WORLD_SIZE / 2
  const step = 160

  grid
    .rect(-span, -span, BOARD_WORLD_SIZE, BOARD_WORLD_SIZE)
    .fill({ color: '#1f544f' })

  for (let cursor = -span; cursor <= span; cursor += step) {
    grid.moveTo(cursor, -span).lineTo(cursor, span)
    grid.moveTo(-span, cursor).lineTo(span, cursor)
  }
  grid.stroke({ width: 1, color: '#2d6c64', alpha: 0.65 })

  return grid
}

function addSpriteContents(
  container: Container,
  spec: { url?: string; crop?: { x: number; y: number; width: number; height: number }; fit?: 'cover' | 'contain' },
  width: number,
  height: number,
  cornerRadius: number,
  requestRender: () => void,
) {
  if (!spec.url) {
    return
  }

  const texture = requestTextureAsset(spec.url, requestRender)
  if (!texture) {
    return
  }

  const displayTexture = textureForSpriteSpec(spec.url, texture, spec.crop)
  const fit = spec.fit ?? 'cover'
  const inset = fit === 'contain' ? 7 : 0
  const contentWidth = width - inset * 2
  const contentHeight = height - inset * 2
  const sprite = new Sprite(displayTexture)
  sprite.anchor.set(0.5)
  const sourceAspect = displayTexture.width / displayTexture.height
  const targetAspect = contentWidth / contentHeight

  if (fit === 'contain') {
    if (sourceAspect > targetAspect) {
      sprite.width = contentWidth
      sprite.height = sprite.width / sourceAspect
    } else {
      sprite.height = contentHeight
      sprite.width = sprite.height * sourceAspect
    }
  } else {
    if (sourceAspect > targetAspect) {
      sprite.height = contentHeight
      sprite.width = sprite.height * sourceAspect
    } else {
      sprite.width = contentWidth
      sprite.height = sprite.width / sourceAspect
    }
  }

  const mask = new Graphics()
  if (cornerRadius > 0) {
    mask
      .roundRect(-contentWidth / 2, -contentHeight / 2, contentWidth, contentHeight, Math.max(0, cornerRadius - inset))
      .fill({ color: '#ffffff' })
  } else {
    mask
      .rect(-contentWidth / 2, -contentHeight / 2, contentWidth, contentHeight)
      .fill({ color: '#ffffff' })
  }
  container.addChild(mask)
  sprite.mask = mask
  container.addChild(sprite)
}

function addCardSurface(
  container: Container,
  width: number,
  height: number,
  spec: SpriteSpec,
  fallbackLabel: string,
  requestRender: () => void,
) {
  const card = new Graphics()
  card
    .roundRect(-width / 2, -height / 2, width, height, 18)
    .fill({ color: spec.bg ?? '#f8efe1' })
  container.addChild(card)

  if (spec.kind === 'image-url' && spec.url) {
    addSpriteContents(container, spec, width, height, 18, requestRender)
  } else {
    const text = new Text({
      text: spec.label ?? fallbackLabel,
      style: {
        fontFamily: 'Avenir Next, Trebuchet MS, sans-serif',
        fontSize: 18,
        fill: spec.fg ?? '#1d2428',
        align: 'center',
        wordWrap: true,
        wordWrapWidth: width - 28,
      },
    })
    text.anchor.set(0.5)
    container.addChild(text)
  }

  const border = new Graphics()
  border
    .roundRect(-width / 2, -height / 2, width, height, 18)
    .stroke({ width: 2, color: '#2b1b16', alpha: 0.34 })
  container.addChild(border)
}

function spriteSpecTextureState(spec: SpriteSpec) {
  if (spec.kind !== 'image-url' || !spec.url) {
    return 'na'
  }

  if (Cache.has(spec.url) || textureAssetCache.get(spec.url)?.status === 'loaded') {
    return 'ready'
  }

  return textureAssetCache.get(spec.url)?.status ?? 'pending'
}

function cardTextureSignature(width: number, height: number, spec: SpriteSpec, fallbackLabel: string) {
  return JSON.stringify({
    width,
    height,
    fallbackLabel,
    spec,
    textureState: spriteSpecTextureState(spec),
  })
}

function getCardSurfaceTexture(
  renderer: Application['renderer'],
  textureCache: Map<string, CardTextureCacheEntry>,
  cacheKey: string,
  width: number,
  height: number,
  spec: SpriteSpec,
  fallbackLabel: string,
  requestRender: () => void,
) {
  const signature = cardTextureSignature(width, height, spec, fallbackLabel)
  const cached = textureCache.get(cacheKey)
  if (cached && cached.signature === signature) {
    return cached.texture
  }

  cached?.texture.destroy(true)

  const surface = new Container()
  addCardSurface(surface, width, height, spec, fallbackLabel, requestRender)
  const texture = renderer.generateTexture({
    target: surface,
    resolution: renderer.resolution,
    antialias: true,
  })
  surface.destroy({ children: true })
  textureCache.set(cacheKey, { signature, texture })
  return texture
}

function projectCardCorner(x: number, y: number, angle: number, cameraDistance: number) {
  const rotatedX = x * Math.cos(angle)
  const depth = x * Math.sin(angle)
  const perspective = cameraDistance / (cameraDistance - depth)

  return {
    x: rotatedX * perspective,
    y: y * perspective,
  }
}

function addCardContents(
  container: Container,
  renderer: Application['renderer'],
  textureCache: Map<string, CardTextureCacheEntry>,
  room: RoomDoc,
  objectId: Id,
  currentPlayerId: string | undefined,
  requestRender: () => void,
  flipAnimations: Map<Id, FlipAnimation>,
  now: number,
  worldRotation: number,
) {
  const object = room.objects[objectId]
  if (!isCard(object)) {
    return
  }

  const { width, height } = objectDimensions(room, objectId)
  const defaultFaceVisible = canSeeCardFace(object, currentPlayerId)
  const { faceVisible, angle, offsetY } = cardFlipPresentation(
    objectId,
    defaultFaceVisible,
    flipAnimations,
    now,
  )
  const spec = faceVisible ? object.face : object.back
  if (!flipAnimations.has(objectId)) {
    addCardSurface(container, width, height, spec, object.name, requestRender)
    return
  }

  const liftLayer = new Container()
  liftLayer.position.set(offsetY * Math.sin(worldRotation), offsetY * Math.cos(worldRotation))
  container.addChild(liftLayer)

  const texture = getCardSurfaceTexture(
    renderer,
    textureCache,
    `${objectId}:${faceVisible ? 'face' : 'back'}`,
    width,
    height,
    spec,
    object.name,
    requestRender,
  )
  const halfWidth = width / 2
  const halfHeight = height / 2
  const cameraDistance = Math.max(width, height) * 4
  const topLeft = projectCardCorner(-halfWidth, -halfHeight, angle, cameraDistance)
  const topRight = projectCardCorner(halfWidth, -halfHeight, angle, cameraDistance)
  const bottomRight = projectCardCorner(halfWidth, halfHeight, angle, cameraDistance)
  const bottomLeft = projectCardCorner(-halfWidth, halfHeight, angle, cameraDistance)
  const mesh = new PerspectiveMesh({
    texture,
    verticesX: 6,
    verticesY: 6,
  })
  mesh.setCorners(
    topLeft.x,
    topLeft.y,
    topRight.x,
    topRight.y,
    bottomRight.x,
    bottomRight.y,
    bottomLeft.x,
    bottomLeft.y,
  )
  liftLayer.addChild(mesh)
}

function addBoardContents(
  container: Container,
  room: RoomDoc,
  objectId: Id,
  requestRender: () => void,
) {
  const object = room.objects[objectId]
  if (!isBoard(object)) {
    return
  }

  const { width, height } = object.size
  const spec = isBoardFaceUp(object) ? object.face : object.back

  if (spec.kind === 'image-url' && spec.url) {
    addSpriteContents(container, spec, width, height, 0, requestRender)
  } else {
    const board = new Graphics()
    board
      .rect(-width / 2, -height / 2, width, height)
      .fill({ color: spec.bg ?? '#d8d2c1' })
    container.addChild(board)

    const text = new Text({
      text: spec.label ?? object.name,
      style: {
        fontFamily: 'Avenir Next, Trebuchet MS, sans-serif',
        fontSize: Math.max(24, Math.min(width, height) * 0.08),
        fill: spec.fg ?? '#1d2428',
        align: 'center',
        wordWrap: true,
        wordWrapWidth: Math.max(120, width - 48),
      },
    })
    text.anchor.set(0.5)
    container.addChild(text)

    const border = new Graphics()
    border
      .rect(-width / 2, -height / 2, width, height)
      .stroke({ width: 2, color: '#2b1b16', alpha: 0.28 })
    container.addChild(border)
  }
}

function addDeckContents(
  container: Container,
  renderer: Application['renderer'],
  textureCache: Map<string, CardTextureCacheEntry>,
  room: RoomDoc,
  objectId: Id,
  currentPlayerId: string | undefined,
  requestRender: () => void,
  flipAnimations: Map<Id, FlipAnimation>,
  now: number,
  worldRotation: number,
) {
  const object = room.objects[objectId]
  if (!isDeck(object)) {
    return
  }

  const { width, height } = object.size
  const visibleStackCount = Math.min(object.childIds.length, 4)

  if (visibleStackCount === 0) {
    const emptySlot = new Graphics()
    emptySlot
      .roundRect(-width / 2, -height / 2, width, height, 18)
      .fill({ color: '#244c4f', alpha: 0.2 })
      .stroke({ width: 3, color: '#e8d7ba', alpha: 0.46 })
    container.addChild(emptySlot)
  }

  for (let index = 0; index < visibleStackCount; index += 1) {
    const cardId = object.childIds[object.childIds.length - visibleStackCount + index]
    const stackCard = room.objects[cardId]
    const offsetX = index * 4
    const offsetY = index * 3
    const stackCardContainer = new Container()
    stackCardContainer.position.set(offsetX, offsetY)

    if (isCard(stackCard)) {
      addCardContents(
        stackCardContainer,
        renderer,
        textureCache,
        room,
        stackCard.id,
        currentPlayerId,
        requestRender,
        flipAnimations,
        now,
        worldRotation,
      )
    } else {
      const fallback = new Graphics()
      fallback
        .roundRect(-width / 2, -height / 2, width, height, 18)
        .fill({ color: '#f2e3ca' })
        .stroke({ width: 2, color: '#38231a', alpha: 0.28 })
      stackCardContainer.addChild(fallback)

      const label = new Text({
        text: object.name,
        style: {
          fontFamily: 'Avenir Next, Trebuchet MS, sans-serif',
          fontSize: 17,
          fill: '#1c2125',
        },
      })
      label.anchor.set(0.5)
      stackCardContainer.addChild(label)
    }

    container.addChild(stackCardContainer)
  }

}

function clearPendingDeckPress(pendingDeckPressRef: React.MutableRefObject<PendingDeckPress | null>) {
  const pending = pendingDeckPressRef.current
  if (!pending) {
    return
  }
  window.clearTimeout(pending.timeoutId)
  pendingDeckPressRef.current = null
}

function pauseViewportCameraGestures(viewport: Viewport) {
  viewport.plugins.pause('drag')
  viewport.plugins.pause('pinch')
}

function resumeViewportCameraGestures(viewport: Viewport) {
  viewport.plugins.resume('drag')
  viewport.plugins.resume('pinch')
}

function reanchorDragToViewport(
  viewport: Viewport,
  renderedObjects: Map<Id, RenderedObject>,
  dragRef: React.MutableRefObject<DragState | null>,
) {
  const drag = dragRef.current
  if (!drag) {
    return
  }

  const rendered = renderedObjects.get(drag.id)
  if (!rendered) {
    return
  }

  const world = viewportToLogicalPoint(viewport.toWorld(drag.currentGlobal))
  if (drag.mode === 'move') {
    const offsetX = drag.startTransform.x - drag.startPointer.x
    const offsetY = drag.startTransform.y - drag.startPointer.y
    const nextX = world.x + offsetX
    const nextY = world.y + offsetY
    rendered.container.position.set(nextX, nextY)
    rendered.transform = { ...rendered.transform, x: nextX, y: nextY }
  }

  drag.startPointer = { x: world.x, y: world.y }
  drag.startTransform = { ...rendered.transform }
}

function applyAuxiliaryTouchGesture(
  viewport: Viewport,
  event: FederatedPointerEvent,
  auxiliaryTouchRef: React.MutableRefObject<AuxiliaryTouchState>,
  renderedObjects: Map<Id, RenderedObject>,
  dragRef: React.MutableRefObject<DragState | null>,
) {
  const pointers = auxiliaryTouchRef.current.pointers
  const previous = pointers.get(event.pointerId) ?? { x: event.global.x, y: event.global.y }
  pointers.set(event.pointerId, { x: event.global.x, y: event.global.y })

  if (pointers.size === 1) {
    viewport.x += event.global.x - previous.x
    viewport.y += event.global.y - previous.y
    reanchorDragToViewport(viewport, renderedObjects, dragRef)
    return
  }

  const entries = [...pointers.entries()].slice(0, 2)
  if (entries.length < 2) {
    return
  }

  const [firstEntry, secondEntry] = entries
  const [firstPointerId, firstCurrent] = firstEntry
  const [secondPointerId, secondCurrent] = secondEntry
  const firstPrevious = firstPointerId === event.pointerId ? previous : pointers.get(firstPointerId) ?? firstCurrent
  const secondPrevious = secondPointerId === event.pointerId ? previous : pointers.get(secondPointerId) ?? secondCurrent

  const previousCenter = {
    x: (firstPrevious.x + secondPrevious.x) / 2,
    y: (firstPrevious.y + secondPrevious.y) / 2,
  }
  const nextCenter = {
    x: (firstCurrent.x + secondCurrent.x) / 2,
    y: (firstCurrent.y + secondCurrent.y) / 2,
  }
  const previousDistance = Math.hypot(firstPrevious.x - secondPrevious.x, firstPrevious.y - secondPrevious.y)
  const nextDistance = Math.hypot(firstCurrent.x - secondCurrent.x, firstCurrent.y - secondCurrent.y)
  const anchorWorld = viewport.toWorld(previousCenter)

  if (previousDistance > 0 && nextDistance > 0) {
    const nextScale = Math.min(MAX_ZOOM_SCALE, Math.max(MIN_ZOOM_SCALE, viewport.scaled * (nextDistance / previousDistance)))
    viewport.setZoom(nextScale, true)
  }

  const anchorScreen = viewport.toScreen(anchorWorld)
  viewport.x += nextCenter.x - anchorScreen.x
  viewport.y += nextCenter.y - anchorScreen.y
  reanchorDragToViewport(viewport, renderedObjects, dragRef)
}

function populateViewportScene(
  viewport: Viewport,
  renderedObjects: Map<Id, RenderedObject>,
  renderer: Application['renderer'],
  textureCache: Map<string, CardTextureCacheEntry>,
  room: RoomDoc,
  ephemeralTransforms: EphemeralTransformMap,
  currentPlayerId: string | undefined,
  selectionMode: 'normal' | 'group',
  selectedId: Id | undefined,
  selectedIds: Id[],
  lassoMode: boolean,
  hoverDeckId: Id | undefined,
  canEdit: boolean,
  allowSelectLocked: boolean,
  onSelect: (id?: Id) => void,
  onToggleGroupSelection: (id: Id) => void,
  dragRef: React.MutableRefObject<DragState | null>,
  auxiliaryTouchRef: React.MutableRefObject<AuxiliaryTouchState>,
  pendingDeckPressRef: React.MutableRefObject<PendingDeckPress | null>,
  tapCandidateRef: React.MutableRefObject<TapCandidate | null>,
  requestRender: () => void,
  flipAnimations: Map<Id, FlipAnimation>,
  now: number,
) {
  const activeDragId = dragRef.current?.id
  const priorTransforms = new Map<Id, Transform2D>()
  for (const [objectId, rendered] of renderedObjects) {
    priorTransforms.set(objectId, rendered.transform)
  }

  for (const child of viewport.removeChildren()) {
    child.destroy({ children: true })
  }
  renderedObjects.clear()
  const scene = new Container()
  scene.position.set(VIEWPORT_WORLD_OFFSET, VIEWPORT_WORLD_OFFSET)
  viewport.addChild(scene)
  scene.addChild(boardBackground())

  const root = getRootPlane(room)
  const selectedIdsSet = new Set(selectedIds)

  for (const objectId of root.childOrder) {
    const object = room.objects[objectId]
    const baseTransform = ephemeralTransforms[objectId] ?? root.childTransforms[objectId]
    const transform = activeDragId === objectId ? priorTransforms.get(objectId) ?? baseTransform : baseTransform
    if (!object || !transform) {
      continue
    }

    const container = new Container()
    container.position.set(transform.x, transform.y)
    container.rotation = transform.rotation
    container.eventMode = 'static'
    container.cursor =
      canEdit && !object.locked
        ? 'grab'
        : object.locked && allowSelectLocked
          ? 'pointer'
          : 'default'

    let width = Number(DEFAULT_CARD_SIZE.width)
    let height = Number(DEFAULT_CARD_SIZE.height)

    if (isCard(object)) {
      width = object.size.width
      height = object.size.height
      addCardContents(
        container,
        renderer,
        textureCache,
        room,
        objectId,
        currentPlayerId,
        requestRender,
        flipAnimations,
        now,
        transform.rotation,
      )
    } else if (isBoard(object)) {
      width = object.size.width
      height = object.size.height
      addBoardContents(container, room, objectId, requestRender)
    } else if (isDeck(object)) {
      const dimensions = objectDimensions(room, objectId)
      width = dimensions.width
      height = dimensions.height
      addDeckContents(
        container,
        renderer,
        textureCache,
        room,
        objectId,
        currentPlayerId,
        requestRender,
        flipAnimations,
        now,
        transform.rotation,
      )
    }

    const hitArea = new Graphics()
    const hidesSelectionChrome = isCard(object) && flipAnimations.has(objectId)
    if (isBoard(object)) {
      hitArea
        .rect(-width / 2, -height / 2, width, height)
        .stroke({
          width:
            hoverDeckId === objectId
              ? 5
              : selectionMode === 'group'
                ? selectedIdsSet.has(objectId)
                  ? selectedId === objectId
                    ? 5
                    : 4
                  : 0
                : selectedId === objectId
                  ? 4
                  : 0,
          color:
            hoverDeckId === objectId
              ? '#ff8d47'
              : selectionMode === 'group' && selectedId === objectId
                ? '#ffd78a'
                : '#ffcb72',
          alpha: hoverDeckId === objectId ? 1 : 0.95,
        })
    } else {
      hitArea
        .roundRect(-width / 2, -height / 2, width, height, 18)
        .stroke({
          width:
            hidesSelectionChrome
              ? 0
              : hoverDeckId === objectId
                ? 5
                : selectionMode === 'group'
                  ? selectedIdsSet.has(objectId)
                    ? selectedId === objectId
                      ? 5
                      : 4
                    : 0
                  : selectedId === objectId
                    ? 4
                    : 0,
          color:
            hoverDeckId === objectId
              ? '#ff8d47'
              : selectionMode === 'group' && selectedId === objectId
                ? '#ffd78a'
                : '#ffcb72',
          alpha: hoverDeckId === objectId ? 1 : 0.95,
        })
    }
    container.addChild(hitArea)

    const showsRotateHandle =
      selectionMode === 'normal' && selectedId === objectId && canEdit && !object.locked && !hidesSelectionChrome
    const buildGroupDragMembers = () =>
      selectedIds
        .map((memberId) => {
          const memberTransform = transformForObject(room, memberId, ephemeralTransforms)
          return memberTransform ? { id: memberId, startTransform: { ...memberTransform } } : undefined
        })
        .filter((member): member is { id: Id; startTransform: Transform2D } => Boolean(member))

    container.hitArea = {
      contains: (x: number, y: number) => {
        const withinCardBounds = x >= -width / 2 && x <= width / 2 && y >= -height / 2 && y <= height / 2
        if (withinCardBounds) {
          return true
        }

        if (!showsRotateHandle) {
          return false
        }

        return Math.hypot(x, y + height / 2 + 24) <= 13
      },
    }
    container.on('pointerdown', (event) => {
      if (selectionMode === 'group' && lassoMode) {
        return
      }

      const activeDrag = dragRef.current
      if (activeDrag && event.pointerType === 'touch') {
        if (event.pointerId !== activeDrag.pointerId) {
          auxiliaryTouchRef.current.pointers.set(event.pointerId, { x: event.global.x, y: event.global.y })
        }
        event.stopPropagation()
        return
      }

      const isTouchPointer = event.pointerType === 'touch'
      const isMiddleMouse = event.pointerType === 'mouse' && event.button === 1

      if (isMiddleMouse) {
        return
      }

      if (object.locked) {
        if (!allowSelectLocked) {
          return
        }

        tapCandidateRef.current = {
          id: objectId,
          pointerId: event.pointerId,
          startPointer: { x: event.global.x, y: event.global.y },
        }
        return
      }

      if (selectionMode === 'group') {
        if (!isMultiselectObjectType(room, objectId)) {
          return
        }

        const isSelected = selectedIdsSet.has(objectId)
        tapCandidateRef.current = {
          id: objectId,
          pointerId: event.pointerId,
          startPointer: { x: event.global.x, y: event.global.y },
        }

        if (!isSelected) {
          return
        }

        event.stopPropagation()

        if (!canEdit || !isMovableObjectType(room, objectId)) {
          return
        }

        const world = viewportToLogicalPoint(viewport.toWorld(event.global))
        dragRef.current = {
          id: objectId,
          pointerId: event.pointerId,
          mode: 'move',
          startPointer: { x: world.x, y: world.y },
          startTransform: { ...transform },
          currentGlobal: { x: event.global.x, y: event.global.y },
          moved: false,
          raisedToFront: false,
          groupMembers: buildGroupDragMembers(),
        }
        pauseViewportCameraGestures(viewport)
        return
      }

      if (isDeck(object) && canEdit && !object.locked && (!isTouchPointer || selectedId === objectId)) {
        onSelect(objectId)
        event.stopPropagation()

        tapCandidateRef.current = {
          id: objectId,
          pointerId: event.pointerId,
          startPointer: { x: event.global.x, y: event.global.y },
        }

        clearPendingDeckPress(pendingDeckPressRef)
        const world = viewportToLogicalPoint(viewport.toWorld(event.global))
        const timeoutId = window.setTimeout(() => {
          const pending = pendingDeckPressRef.current
          if (!pending || pending.deckId !== objectId || pending.pointerId !== event.pointerId) {
            return
          }

          dragRef.current = {
            id: objectId,
            pointerId: event.pointerId,
            mode: 'move',
            startPointer: pending.startWorld,
            startTransform: pending.startTransform,
            currentGlobal: { x: event.global.x, y: event.global.y },
            moved: false,
            raisedToFront: false,
          }
          tapCandidateRef.current = null
          pendingDeckPressRef.current = null
          pauseViewportCameraGestures(viewport)
        }, DECK_LONG_PRESS_MS)

        pendingDeckPressRef.current = {
          deckId: objectId,
          pointerId: event.pointerId,
          startGlobal: { x: event.global.x, y: event.global.y },
          startWorld: { x: world.x, y: world.y },
          startTransform: { ...transform },
          timeoutId,
        }
        return
      }

      if (!isTouchPointer) {
        onSelect(objectId)
        event.stopPropagation()

        if (!canEdit || object.locked || !isMovableObjectType(room, objectId)) {
          return
        }

        const world = viewportToLogicalPoint(viewport.toWorld(event.global))
        dragRef.current = {
          id: objectId,
          pointerId: event.pointerId,
          mode: 'move',
          startPointer: { x: world.x, y: world.y },
          startTransform: { ...transform },
          currentGlobal: { x: event.global.x, y: event.global.y },
          moved: false,
          raisedToFront: false,
        }
        pauseViewportCameraGestures(viewport)
        return
      }

      tapCandidateRef.current = {
        id: objectId,
        pointerId: event.pointerId,
        startPointer: { x: event.global.x, y: event.global.y },
      }

      if (selectedId !== objectId) {
        return
      }

      event.stopPropagation()

      if (!canEdit || object.locked || !isMovableObjectType(room, objectId)) {
        return
      }

      const world = viewportToLogicalPoint(viewport.toWorld(event.global))
      dragRef.current = {
        id: objectId,
        pointerId: event.pointerId,
        mode: 'move',
        startPointer: { x: world.x, y: world.y },
        startTransform: { ...transform },
        currentGlobal: { x: event.global.x, y: event.global.y },
        moved: false,
        raisedToFront: false,
      }
      pauseViewportCameraGestures(viewport)
    })
    container.on('pointerup', (event) => {
      const pendingDeckPress = pendingDeckPressRef.current
      if (pendingDeckPress?.deckId === objectId && pendingDeckPress.pointerId === event.pointerId) {
        clearPendingDeckPress(pendingDeckPressRef)
      }

      const candidate = tapCandidateRef.current
      if (!candidate || candidate.id !== objectId || candidate.pointerId !== event.pointerId) {
        return
      }

      tapCandidateRef.current = null
      const distance = Math.hypot(
        event.global.x - candidate.startPointer.x,
        event.global.y - candidate.startPointer.y,
      )

      if (distance <= TAP_GRACE_DISTANCE && !dragRef.current) {
        if (selectionMode === 'group') {
          onToggleGroupSelection(objectId)
        } else {
          onSelect(objectId)
        }
      }
    })
    container.on('pointerupoutside', (event) => {
      const pendingDeckPress = pendingDeckPressRef.current
      if (pendingDeckPress?.deckId === objectId && pendingDeckPress.pointerId === event.pointerId) {
        clearPendingDeckPress(pendingDeckPressRef)
      }
      if (tapCandidateRef.current?.id === objectId) {
        tapCandidateRef.current = null
      }
    })

    if (showsRotateHandle) {
      const handle = new Graphics()
      handle
        .circle(0, -height / 2 - 24, 13)
        .fill({ color: '#f7c05e' })
        .stroke({ width: 3, color: '#5a3918' })
      handle.eventMode = 'static'
      handle.cursor = 'grab'
      handle.on('pointerdown', (event) => {
        event.stopPropagation()
        const world = viewportToLogicalPoint(viewport.toWorld(event.global))
        dragRef.current = {
          id: objectId,
          pointerId: event.pointerId,
          mode: 'rotate',
          startPointer: { x: world.x, y: world.y },
          startTransform: { ...transform },
          currentGlobal: { x: event.global.x, y: event.global.y },
          moved: false,
          raisedToFront: false,
        }
        pauseViewportCameraGestures(viewport)
      })
      container.addChild(handle)
    }

    scene.addChild(container)
    renderedObjects.set(objectId, {
      container,
      width,
      height,
      transform: { ...transform },
    })
  }
}

function applyDisplayedTransforms(
  renderedObjects: Map<Id, RenderedObject>,
  room: RoomDoc,
  ephemeralTransforms: EphemeralTransformMap,
  dragRef: React.MutableRefObject<DragState | null>,
) {
  const activeDragIds = new Set(
    dragRef.current?.groupMembers?.map((member) => member.id) ?? (dragRef.current?.id ? [dragRef.current.id] : []),
  )

  for (const [objectId, rendered] of renderedObjects) {
    if (activeDragIds.has(objectId)) {
      continue
    }

    const transform = transformForObject(room, objectId, ephemeralTransforms)
    if (!transform) {
      continue
    }

    rendered.container.position.set(transform.x, transform.y)
    rendered.container.rotation = transform.rotation
    rendered.transform = { ...transform }
  }
}

function syncActiveDragRendering(
  viewport: Viewport,
  renderedObjects: Map<Id, RenderedObject>,
  dragRef: React.MutableRefObject<DragState | null>,
) {
  const drag = dragRef.current
  if (!drag) {
    return
  }

  const rendered = renderedObjects.get(drag.id)
  if (!rendered) {
    return
  }

  const world = viewportToLogicalPoint(viewport.toWorld(drag.currentGlobal))
  if (drag.mode === 'move') {
    const deltaX = world.x - drag.startPointer.x
    const deltaY = world.y - drag.startPointer.y

    if (drag.groupMembers && drag.groupMembers.length > 0) {
      for (const member of drag.groupMembers) {
        const memberRendered = renderedObjects.get(member.id)
        if (!memberRendered) {
          continue
        }

        const nextX = member.startTransform.x + deltaX
        const nextY = member.startTransform.y + deltaY
        memberRendered.container.position.set(nextX, nextY)
        memberRendered.transform = { ...member.startTransform, x: nextX, y: nextY }
      }
      return
    }

    const nextX = drag.startTransform.x + deltaX
    const nextY = drag.startTransform.y + deltaY
    rendered.container.position.set(nextX, nextY)
    rendered.transform = { ...drag.startTransform, x: nextX, y: nextY }
    return
  }

  const angle = Math.atan2(world.y - drag.startTransform.y, world.x - drag.startTransform.x) + Math.PI / 2
  rendered.container.rotation = angle
  rendered.transform = { ...drag.startTransform, rotation: angle }
}

export function BoardView({
  room,
  roomUrl,
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
  onDropObjectToDeck,
  onBringCardToFront,
  onLiftTopCardFromDeck,
  onFlipCard,
  onFlipBoard,
  onFlipDeck,
  onDrawDeck,
  onShuffleDeck,
  onOpenSelectionPanel,
}: BoardViewProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const appRef = useRef<Application | null>(null)
  const viewportRef = useRef<Viewport | null>(null)
  const renderedRef = useRef<Map<Id, RenderedObject>>(new Map())
  const dragRef = useRef<DragState | null>(null)
  const pendingDeckPressRef = useRef<PendingDeckPress | null>(null)
  const tapCandidateRef = useRef<TapCandidate | null>(null)
  const backgroundTapCandidateRef = useRef<BackgroundTapCandidate | null>(null)
  const auxiliaryTouchRef = useRef<AuxiliaryTouchState>({ pointers: new Map() })
  const roomRef = useRef(room)
  const ephemeralTransformsRef = useRef(ephemeralTransforms)
  const selectionModeRef = useRef(selectionMode)
  const selectedIdRef = useRef(selectedId)
  const selectedIdsRef = useRef(selectedIds)
  const lassoModeRef = useRef(lassoMode)
  const initialCameraRef = useRef(initialCamera)
  const currentPlayerIdRef = useRef(currentPlayerId)
  const canEditRef = useRef(canEdit)
  const allowSelectLockedRef = useRef(allowSelectLocked)
  const shiftPressedRef = useRef(false)
  const cardVisualStatesRef = useRef<Map<Id, CardVisualState>>(new Map())
  const flipAnimationsRef = useRef<Map<Id, FlipAnimation>>(new Map())
  const cardTextureCacheRef = useRef<Map<string, CardTextureCacheEntry>>(new Map())
  const redrawSceneRef = useRef(() => {})
  const [hoverDeckId, setHoverDeckId] = useState<Id | undefined>()
  const hoverDeckIdRef = useRef<Id | undefined>(hoverDeckId)
  const quickActionsRef = useRef<HTMLDivElement | null>(null)
  const lassoRef = useRef<LassoState | null>(null)
  const [lassoPath, setLassoPath] = useState<Array<{ x: number; y: number }>>([])
  const callbacksRef = useRef({
    onCameraChange,
    onCommitTransform,
    onPreviewTransform,
    onClearPreviewTransform,
    onBringCardToFront,
    onDrawDeck,
    onFlipDeck,
    onLiftTopCardFromDeck,
    onDropObjectToDeck,
    onFlipCard,
    onFlipBoard,
    onSelect,
    onToggleGroupSelection,
    onAddToGroupSelection,
    onShuffleDeck,
  })
  const cameraSnapshot = useRef<string>('')
  const requestRenderRef = useRef(() => {
    redrawSceneRef.current()
  })

  roomRef.current = room
  ephemeralTransformsRef.current = ephemeralTransforms
  selectionModeRef.current = selectionMode
  selectedIdRef.current = selectedId
  selectedIdsRef.current = selectedIds
  lassoModeRef.current = lassoMode
  initialCameraRef.current = initialCamera
  currentPlayerIdRef.current = currentPlayerId
  canEditRef.current = canEdit
  allowSelectLockedRef.current = allowSelectLocked
  hoverDeckIdRef.current = hoverDeckId
  callbacksRef.current = {
    onCameraChange,
    onCommitTransform,
    onPreviewTransform,
    onClearPreviewTransform,
    onBringCardToFront,
    onDrawDeck,
    onFlipDeck,
    onLiftTopCardFromDeck,
    onDropObjectToDeck,
    onFlipCard,
    onFlipBoard,
    onSelect,
    onToggleGroupSelection,
    onAddToGroupSelection,
    onShuffleDeck,
  }
  redrawSceneRef.current = () => {
    const viewport = viewportRef.current
    const app = appRef.current
    if (!viewport || !app) {
      return
    }

    populateViewportScene(
      viewport,
      renderedRef.current,
      app.renderer,
      cardTextureCacheRef.current,
      roomRef.current,
      ephemeralTransformsRef.current,
      currentPlayerIdRef.current,
      selectionModeRef.current,
      selectedIdRef.current,
      selectedIdsRef.current,
      lassoModeRef.current,
      hoverDeckIdRef.current,
      canEditRef.current,
      allowSelectLockedRef.current,
      callbacksRef.current.onSelect,
      callbacksRef.current.onToggleGroupSelection,
      dragRef,
      auxiliaryTouchRef,
      pendingDeckPressRef,
      tapCandidateRef,
      requestRenderRef.current,
      flipAnimationsRef.current,
      performance.now(),
    )
    syncActiveDragRendering(viewport, renderedRef.current, dragRef)
  }

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
        { id: 'flip', label: 'Flip', icon: 'flip', onClick: () => onFlipDeck(object.id) },
        { id: 'draw', label: 'Draw', onClick: () => onDrawDeck(object.id) },
        { id: 'shuffle', label: 'Shuffle', onClick: () => onShuffleDeck(object.id) },
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
  }, [canEdit, onDrawDeck, onFlipBoard, onFlipCard, onFlipDeck, onOpenSelectionPanel, onShuffleDeck, room.objects, selectedId, selectionMode])

  useEffect(() => {
    const updateShiftState = (event: KeyboardEvent) => {
      shiftPressedRef.current = event.shiftKey
    }

    const clearShiftState = () => {
      shiftPressedRef.current = false
    }

    window.addEventListener('keydown', updateShiftState)
    window.addEventListener('keyup', updateShiftState)
    window.addEventListener('blur', clearShiftState)

    return () => {
      window.removeEventListener('keydown', updateShiftState)
      window.removeEventListener('keyup', updateShiftState)
      window.removeEventListener('blur', clearShiftState)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const hostElement = hostRef.current
    if (!hostElement) {
      return
    }
    const host: HTMLDivElement = hostElement
    const renderedObjects = renderedRef.current
    const cardTextureCache = cardTextureCacheRef.current

    const suppressNativeTouch = (event: Event) => {
      event.preventDefault()
    }

    host.addEventListener('touchstart', suppressNativeTouch, { passive: false })
    host.addEventListener('touchmove', suppressNativeTouch, { passive: false })
    host.addEventListener('contextmenu', suppressNativeTouch)
    host.addEventListener('selectstart', suppressNativeTouch)
    host.addEventListener('dragstart', suppressNativeTouch)

    async function init() {
      const app = new Application()
      await app.init({
        antialias: true,
        autoDensity: true,
        backgroundAlpha: 0,
        preference: 'webgl',
        resizeTo: host,
        resolution: Math.min(window.devicePixelRatio || 1, 2),
      })

      if (cancelled) {
        app.destroy(true)
        return
      }

      host.appendChild(app.canvas)

      const viewport = new Viewport({
        events: app.renderer.events,
        ticker: app.ticker,
        screenWidth: host.clientWidth,
        screenHeight: host.clientHeight,
        worldWidth: VIEWPORT_WORLD_SIZE,
        worldHeight: VIEWPORT_WORLD_SIZE,
        passiveWheel: false,
        stopPropagation: true,
      })

      viewport
        .drag({ pressDrag: true })
        .pinch()
        .wheel({ smooth: 6, trackpadPinch: true })
        .decelerate({ friction: 0.92 })
        .clampZoom({ minScale: MIN_ZOOM_SCALE, maxScale: MAX_ZOOM_SCALE })
        .clamp({
          left: 0,
          top: 0,
          right: VIEWPORT_WORLD_SIZE,
          bottom: VIEWPORT_WORLD_SIZE,
          underflow: 'center',
        })

      viewport.eventMode = 'static'
      viewport.on('pointerdown', (event) => {
        if (selectionModeRef.current === 'group' && lassoModeRef.current && !dragRef.current) {
          lassoRef.current = {
            pointerId: event.pointerId,
            points: [{ x: event.global.x, y: event.global.y }],
          }
          setLassoPath([{ x: event.global.x, y: event.global.y }])
          pauseViewportCameraGestures(viewport)
          return
        }

        if (dragRef.current) {
          if (event.pointerType === 'touch' && event.pointerId !== dragRef.current.pointerId) {
            auxiliaryTouchRef.current.pointers.set(event.pointerId, { x: event.global.x, y: event.global.y })
          }
          return
        }

        if (event.pointerType === 'touch') {
          if (tapCandidateRef.current?.pointerId === event.pointerId) {
            return
          }
          backgroundTapCandidateRef.current = {
            pointerId: event.pointerId,
            startPointer: { x: event.global.x, y: event.global.y },
          }
          return
        }

        if (!dragRef.current && selectionModeRef.current === 'normal') {
          callbacksRef.current.onSelect(undefined)
        }
      })

      viewport.moveCenter(
        logicalToViewportPoint({
          x: initialCameraRef.current.centerX,
          y: initialCameraRef.current.centerY,
        }),
      )
      viewport.setZoom(initialCameraRef.current.zoom, true)

      app.stage.addChild(viewport)

      app.stage.eventMode = 'static'
      app.stage.hitArea = new Rectangle(0, 0, host.clientWidth, host.clientHeight)

      const emitCamera = () => {
        const snapshot = JSON.stringify({
          centerX: Number((viewport.center.x - VIEWPORT_WORLD_OFFSET).toFixed(1)),
          centerY: Number((viewport.center.y - VIEWPORT_WORLD_OFFSET).toFixed(1)),
          zoom: Number(viewport.scaled.toFixed(3)),
        })
        if (snapshot !== cameraSnapshot.current) {
          cameraSnapshot.current = snapshot
          callbacksRef.current.onCameraChange(JSON.parse(snapshot) as CameraState)
        }
      }

      const updateOverlayPosition = () => {
        const overlay = quickActionsRef.current
        if (!overlay) {
          return
        }
        const activeSelectedId = selectedIdRef.current
        if (!activeSelectedId) {
          overlay.style.opacity = '0'
          return
        }
        const rendered = renderedRef.current.get(activeSelectedId)
        if (!rendered) {
          overlay.style.opacity = '0'
          return
        }
        const screen = viewport.toScreen(
          logicalToViewportPoint({
            x: rendered.container.position.x,
            y: rendered.container.position.y - rendered.height / 2 - 24,
          }),
        )
        overlay.style.left = `${screen.x}px`
        overlay.style.top = `${screen.y}px`
        overlay.style.opacity = '1'
      }

      const onPointerMove = (event: FederatedPointerEvent) => {
        const activeLasso = lassoRef.current
        if (activeLasso) {
          if (event.pointerId !== activeLasso.pointerId) {
            return
          }

          const lastPoint = activeLasso.points[activeLasso.points.length - 1]
          if (!lastPoint || Math.hypot(event.global.x - lastPoint.x, event.global.y - lastPoint.y) >= 6) {
            const nextPoints = [...activeLasso.points, { x: event.global.x, y: event.global.y }]
            activeLasso.points = nextPoints
            setLassoPath(nextPoints)
          }
          return
        }

        const pendingDeckPress = pendingDeckPressRef.current
        if (!dragRef.current && pendingDeckPress && pendingDeckPress.pointerId === event.pointerId) {
          const pointerDistance = Math.hypot(
            event.global.x - pendingDeckPress.startGlobal.x,
            event.global.y - pendingDeckPress.startGlobal.y,
          )

          if (pointerDistance > TAP_GRACE_DISTANCE) {
            tapCandidateRef.current = null
          }

          if (pointerDistance > TAP_GRACE_DISTANCE) {
            clearPendingDeckPress(pendingDeckPressRef)

            const liftedCardId = callbacksRef.current.onLiftTopCardFromDeck(pendingDeckPress.deckId)
            const dragId = liftedCardId ?? pendingDeckPress.deckId
            if (liftedCardId) {
              callbacksRef.current.onBringCardToFront(liftedCardId)
              callbacksRef.current.onSelect(liftedCardId)
            }

            dragRef.current = {
              id: dragId,
              pointerId: event.pointerId,
              mode: 'move',
              startPointer: pendingDeckPress.startWorld,
              startTransform: pendingDeckPress.startTransform,
              currentGlobal: { x: event.global.x, y: event.global.y },
              moved: false,
              raisedToFront: Boolean(liftedCardId),
            }
            pauseViewportCameraGestures(viewport)
          }
        }

        const drag = dragRef.current
        if (!drag) {
          return
        }

        if (event.pointerType === 'touch' && event.pointerId !== drag.pointerId) {
          applyAuxiliaryTouchGesture(viewport, event, auxiliaryTouchRef, renderedRef.current, dragRef)
          return
        }

        if (event.pointerId !== drag.pointerId) {
          return
        }

        const rendered = renderedRef.current.get(drag.id)
        if (!rendered) {
          return
        }

        drag.currentGlobal = { x: event.global.x, y: event.global.y }
        const world = viewportToLogicalPoint(viewport.toWorld(event.global))
        const distance = Math.hypot(world.x - drag.startPointer.x, world.y - drag.startPointer.y)
        drag.moved ||= distance > 8

        if (
          drag.mode === 'move' &&
          drag.moved &&
          !drag.raisedToFront &&
          (!drag.groupMembers || drag.groupMembers.length === 0) &&
          roomRef.current.objects[drag.id]?.type === 'card'
        ) {
          callbacksRef.current.onBringCardToFront(drag.id)
          drag.raisedToFront = true
        }

        if (drag.mode === 'move') {
          const deltaX = world.x - drag.startPointer.x
          const deltaY = world.y - drag.startPointer.y

          if (drag.groupMembers && drag.groupMembers.length > 0) {
            for (const member of drag.groupMembers) {
              const memberRendered = renderedRef.current.get(member.id)
              if (!memberRendered) {
                continue
              }

              const nextX = member.startTransform.x + deltaX
              const nextY = member.startTransform.y + deltaY
              memberRendered.container.position.set(nextX, nextY)
              memberRendered.transform = { ...member.startTransform, x: nextX, y: nextY }
            }
            setHoverDeckId(undefined)
          } else {
            const nextX = drag.startTransform.x + deltaX
            const nextY = drag.startTransform.y + deltaY
            rendered.container.position.set(nextX, nextY)
            rendered.transform = { ...drag.startTransform, x: nextX, y: nextY }

            const liveRoom = roomRef.current
            const draggingObject = liveRoom.objects[drag.id]
            const nextHoverDeckId =
              draggingObject && (draggingObject.type === 'card' || draggingObject.type === 'deck')
                ? findDeckAtPoint(liveRoom, { x: nextX, y: nextY }, ephemeralTransformsRef.current, drag.id)
                : undefined
            setHoverDeckId((current) => (current === nextHoverDeckId ? current : nextHoverDeckId))
          }
        } else {
          const originX = drag.startTransform.x
          const originY = drag.startTransform.y
          const angle = Math.atan2(world.y - originY, world.x - originX) + Math.PI / 2
          rendered.container.rotation = angle
          rendered.transform = { ...drag.startTransform, rotation: angle }
        }

        if (drag.groupMembers && drag.groupMembers.length > 0) {
          for (const member of drag.groupMembers) {
            const memberRendered = renderedRef.current.get(member.id)
            if (memberRendered) {
              callbacksRef.current.onPreviewTransform(member.id, memberRendered.transform)
            }
          }
        } else {
          callbacksRef.current.onPreviewTransform(drag.id, rendered.transform)
        }
        updateOverlayPosition()
      }

      const finishDrag = (event: FederatedPointerEvent) => {
        const activeLasso = lassoRef.current
        if (activeLasso) {
          if (event.pointerId !== activeLasso.pointerId) {
            return
          }

          lassoRef.current = null
          resumeViewportCameraGestures(viewport)
          const completedPoints =
            Math.hypot(
              event.global.x - activeLasso.points[activeLasso.points.length - 1].x,
              event.global.y - activeLasso.points[activeLasso.points.length - 1].y,
            ) >= 4
              ? [...activeLasso.points, { x: event.global.x, y: event.global.y }]
              : activeLasso.points
          setLassoPath([])

          if (completedPoints.length >= 3) {
            callbacksRef.current.onAddToGroupSelection(
              objectIdsWithinLasso(viewport, roomRef.current, ephemeralTransformsRef.current, completedPoints),
            )
          }
          return
        }

        const drag = dragRef.current
        if (!drag) {
          const backgroundTapCandidate = backgroundTapCandidateRef.current
          if (
            event.pointerType === 'touch' &&
            backgroundTapCandidate &&
            backgroundTapCandidate.pointerId === event.pointerId
          ) {
            backgroundTapCandidateRef.current = null
            const distance = Math.hypot(
              event.global.x - backgroundTapCandidate.startPointer.x,
              event.global.y - backgroundTapCandidate.startPointer.y,
            )
            if (distance <= TAP_GRACE_DISTANCE && selectionModeRef.current === 'normal') {
              callbacksRef.current.onSelect(undefined)
            }
          }
          return
        }

        if (event.pointerType === 'touch' && event.pointerId !== drag.pointerId) {
          auxiliaryTouchRef.current.pointers.delete(event.pointerId)
          return
        }

        if (event.pointerId !== drag.pointerId) {
          return
        }

        auxiliaryTouchRef.current.pointers.clear()
        resumeViewportCameraGestures(viewport)
        const rendered = renderedRef.current.get(drag.id)

        if (!rendered) {
          dragRef.current = null
          if (drag.groupMembers && drag.groupMembers.length > 0) {
            for (const member of drag.groupMembers) {
              callbacksRef.current.onClearPreviewTransform(member.id)
            }
          } else {
            callbacksRef.current.onClearPreviewTransform(drag.id)
          }
          return
        }

        const world = viewportToLogicalPoint(viewport.toWorld(event.global))
        if (drag.mode === 'move') {
          dragRef.current = null
          if (drag.groupMembers && drag.groupMembers.length > 0) {
            for (const member of drag.groupMembers) {
              const memberRendered = renderedRef.current.get(member.id)
              callbacksRef.current.onClearPreviewTransform(member.id, memberRendered?.transform)
              if (!memberRendered) {
                continue
              }
              callbacksRef.current.onCommitTransform(member.id, {
                x: memberRendered.container.position.x,
                y: memberRendered.container.position.y,
                rotation: member.startTransform.rotation,
              })
            }
          } else {
            const liveRoom = roomRef.current
            const nextTransform = {
              x: rendered.container.position.x,
              y: rendered.container.position.y,
              rotation: drag.startTransform.rotation,
            }
            callbacksRef.current.onClearPreviewTransform(drag.id, nextTransform)
            const object = liveRoom.objects[drag.id]
            const targetDeckId =
              object && (object.type === 'card' || object.type === 'deck')
                ? findDeckAtPoint(liveRoom, world, ephemeralTransformsRef.current, drag.id)
                : undefined

            if (targetDeckId) {
              callbacksRef.current.onDropObjectToDeck(drag.id, targetDeckId)
            } else {
              callbacksRef.current.onCommitTransform(drag.id, nextTransform)
            }
          }
        } else {
          const snappedRotation = snapRotationAngle(rendered.container.rotation)
          rendered.container.rotation = snappedRotation
          rendered.transform = {
            ...rendered.transform,
            rotation: snappedRotation,
          }
          dragRef.current = null
          callbacksRef.current.onClearPreviewTransform(drag.id, rendered.transform)
          callbacksRef.current.onCommitTransform(drag.id, {
            rotation: snappedRotation,
          })
        }
        setHoverDeckId(undefined)
        updateOverlayPosition()
      }

      app.stage.on('pointermove', onPointerMove)
      app.stage.on('pointerup', finishDrag)
      app.stage.on('pointerupoutside', (event) => {
        backgroundTapCandidateRef.current = null
        finishDrag(event)
      })

      app.ticker.add(() => {
        const now = performance.now()
        let needsAnimationFrame = false
        for (const [objectId, animation] of flipAnimationsRef.current) {
          if (now - animation.startedAt >= animation.durationMs) {
            flipAnimationsRef.current.delete(objectId)
            needsAnimationFrame = true
            continue
          }

          if (roomRef.current.objects[objectId]) {
            needsAnimationFrame = true
          }
        }

        if (needsAnimationFrame) {
          redrawSceneRef.current()
        }
        emitCamera()
        updateOverlayPosition()
      })

      const observer = new ResizeObserver(() => {
        viewport.resize(host.clientWidth, host.clientHeight, VIEWPORT_WORLD_SIZE, VIEWPORT_WORLD_SIZE)
      })
      observer.observe(host)

      appRef.current = app
      viewportRef.current = viewport
      populateViewportScene(
        viewport,
        renderedRef.current,
        app.renderer,
        cardTextureCacheRef.current,
        roomRef.current,
        ephemeralTransformsRef.current,
        currentPlayerIdRef.current,
        selectionModeRef.current,
        selectedIdRef.current,
        selectedIdsRef.current,
        lassoModeRef.current,
        hoverDeckIdRef.current,
        canEditRef.current,
        allowSelectLockedRef.current,
        callbacksRef.current.onSelect,
        callbacksRef.current.onToggleGroupSelection,
        dragRef,
        auxiliaryTouchRef,
        pendingDeckPressRef,
        tapCandidateRef,
        requestRenderRef.current,
        flipAnimationsRef.current,
        performance.now(),
      )

      return () => {
        observer.disconnect()
      }
    }

    let cleanup: (() => void) | undefined
    void init().then((dispose) => {
      cleanup = dispose
    })

    return () => {
      cancelled = true
      cleanup?.()
      clearPendingDeckPress(pendingDeckPressRef)
      lassoRef.current = null
      setLassoPath([])
      host.removeEventListener('touchstart', suppressNativeTouch)
      host.removeEventListener('touchmove', suppressNativeTouch)
      host.removeEventListener('contextmenu', suppressNativeTouch)
      host.removeEventListener('selectstart', suppressNativeTouch)
      host.removeEventListener('dragstart', suppressNativeTouch)
      viewportRef.current?.destroy({ children: true })
      appRef.current?.destroy(true, { children: true })
      for (const entry of cardTextureCache.values()) {
        entry.texture.destroy(true)
      }
      cardTextureCache.clear()
      renderedObjects.clear()
      viewportRef.current = null
      appRef.current = null
      host.textContent = ''
    }
  }, [roomUrl])

  useEffect(() => {
    const nextCardVisualStates = collectCardVisualStates(room, currentPlayerId)
    const previousCardVisualStates = cardVisualStatesRef.current
    const now = performance.now()

    for (const [objectId, nextState] of nextCardVisualStates) {
      const previousState = previousCardVisualStates.get(objectId)
      if (!previousState || previousState.faceUp === nextState.faceUp) {
        continue
      }

      const currentPresentation = cardFlipPresentation(
        objectId,
        previousState.faceVisible,
        flipAnimationsRef.current,
        now,
      )
      if (currentPresentation.faceVisible === nextState.faceVisible) {
        continue
      }

      flipAnimationsRef.current.set(objectId, {
        startedAt: now,
        durationMs: shiftPressedRef.current ? FLIP_DEBUG_DURATION_MS : FLIP_DURATION_MS,
        fromFaceVisible: currentPresentation.faceVisible,
        toFaceVisible: nextState.faceVisible,
      })
    }

    for (const objectId of [...flipAnimationsRef.current.keys()]) {
      if (!nextCardVisualStates.has(objectId)) {
        flipAnimationsRef.current.delete(objectId)
      }
    }

    for (const [cacheKey, entry] of cardTextureCacheRef.current) {
      const [cardId] = cacheKey.split(':')
      if (nextCardVisualStates.has(cardId)) {
        continue
      }

      entry.texture.destroy(true)
      cardTextureCacheRef.current.delete(cacheKey)
    }

    cardVisualStatesRef.current = nextCardVisualStates
    redrawSceneRef.current()
  }, [currentPlayerId, room])

  useEffect(() => {
    redrawSceneRef.current()
  }, [allowSelectLocked, canEdit, hoverDeckId, lassoMode, onSelect, selectedId, selectedIds, selectionMode])

  useEffect(() => {
    applyDisplayedTransforms(renderedRef.current, room, ephemeralTransforms, dragRef)
  }, [ephemeralTransforms, room])

  return (
    <div className="board-root">
      <div className="board-canvas" ref={hostRef} />
      {lassoPath.length > 1 ? (
        <svg className="lasso-overlay" viewBox={`0 0 ${hostRef.current?.clientWidth ?? 1} ${hostRef.current?.clientHeight ?? 1}`} preserveAspectRatio="none">
          <path
            d={`M ${lassoPath.map((point) => `${point.x} ${point.y}`).join(' L ')} Z`}
          />
        </svg>
      ) : null}
      {quickActions.length > 0 ? (
        <div
          ref={quickActionsRef}
          className="quick-actions"
        >
          {quickActions.map((action) => (
            <button
              key={action.id}
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
