import { useEffect, useMemo, useRef } from 'react'
import { useState } from 'react'
import { Application, Assets, Cache, Container, FederatedPointerEvent, Graphics, Rectangle, Sprite, Text, Texture } from 'pixi.js'
import { Viewport } from 'pixi-viewport'
import { BOARD_WORLD_SIZE, DEFAULT_CARD_SIZE, type CameraState, type Id, type RoomDoc, type Transform2D } from '../model/types'
import { canSeeCardFace, getRootPlane, getTransform, isCard, isDeck } from '../model/room'

interface BoardViewProps {
  room: RoomDoc
  roomUrl: string
  selectedId?: Id
  currentPlayerId?: string
  canEdit: boolean
  initialCamera: CameraState
  onCameraChange: (camera: CameraState) => void
  onSelect: (id?: Id) => void
  onCommitTransform: (id: Id, transform: Partial<Transform2D>) => void
  onDropObjectToDeck: (objectId: Id, deckId: Id) => void
  onBringCardToFront: (cardId: Id) => void
  onLiftTopCardFromDeck: (deckId: Id) => Id | undefined
  onFlipCard: (cardId: Id) => void
  onFlipDeck: (deckId: Id) => void
  onDrawDeck: (deckId: Id) => void
  onShuffleDeck: (deckId: Id) => void
  onDeleteObject: (objectId: Id) => void
}

interface RenderedObject {
  container: Container
  width: number
  height: number
  transform: Transform2D
}

interface DragState {
  id: Id
  mode: 'move' | 'rotate'
  startPointer: { x: number; y: number }
  startTransform: Transform2D
  moved: boolean
  raisedToFront: boolean
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

const TAP_GRACE_DISTANCE = 10
const DECK_LONG_PRESS_MS = 360
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

function cardDimensions(room: RoomDoc, objectId: Id) {
  const object = room.objects[objectId]
  if (isCard(object)) {
    return object.size
  }
  return DEFAULT_CARD_SIZE
}

function pointInObjectRect(room: RoomDoc, objectId: Id, point: { x: number; y: number }) {
  const transform = getTransform(room, objectId)
  const object = room.objects[objectId]
  if (!transform || !object) {
    return false
  }

  const { width, height } = cardDimensions(room, objectId)
  const dx = point.x - transform.x
  const dy = point.y - transform.y
  const sin = Math.sin(-transform.rotation)
  const cos = Math.cos(-transform.rotation)
  const localX = dx * cos - dy * sin
  const localY = dx * sin + dy * cos
  return localX >= -width / 2 && localX <= width / 2 && localY >= -height / 2 && localY <= height / 2
}

function findDeckAtPoint(room: RoomDoc, point: { x: number; y: number }, ignoreId?: Id) {
  const root = getRootPlane(room)

  for (let index = root.childOrder.length - 1; index >= 0; index -= 1) {
    const objectId = root.childOrder[index]
    if (objectId === ignoreId) {
      continue
    }
    const object = room.objects[objectId]
    if (isDeck(object) && pointInObjectRect(room, objectId, point)) {
      return objectId
    }
  }

  return undefined
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
  mask
    .roundRect(-contentWidth / 2, -contentHeight / 2, contentWidth, contentHeight, Math.max(8, 18 - inset))
    .fill({ color: '#ffffff' })
  container.addChild(mask)
  sprite.mask = mask
  container.addChild(sprite)
}

function addCardContents(
  container: Container,
  room: RoomDoc,
  objectId: Id,
  currentPlayerId: string | undefined,
  requestRender: () => void,
) {
  const object = room.objects[objectId]
  if (!isCard(object)) {
    return
  }

  const { width, height } = object.size
  const spec = canSeeCardFace(object, currentPlayerId) ? object.face : object.back

  const card = new Graphics()
  card
    .roundRect(-width / 2, -height / 2, width, height, 18)
    .fill({ color: spec.bg ?? '#f8efe1' })
  container.addChild(card)

  if (spec.kind === 'image-url' && spec.url) {
    addSpriteContents(container, spec, width, height, requestRender)
  } else {
    const text = new Text({
      text: spec.label ?? object.name,
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

function addDeckContents(
  container: Container,
  room: RoomDoc,
  objectId: Id,
  currentPlayerId: string | undefined,
  requestRender: () => void,
) {
  const object = room.objects[objectId]
  if (!isDeck(object)) {
    return
  }

  const { width, height } = DEFAULT_CARD_SIZE
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
      addCardContents(stackCardContainer, room, stackCard.id, currentPlayerId, requestRender)
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

  const countBadge = new Graphics()
  countBadge
    .roundRect(width / 2 - 40, height / 2 - 32, 34, 24, 12)
    .fill({ color: '#cc7a42' })
  container.addChild(countBadge)

  const countText = new Text({
    text: String(object.childIds.length),
    style: {
      fontFamily: 'Avenir Next, Trebuchet MS, sans-serif',
      fontSize: 14,
      fill: '#fff8f0',
      fontWeight: '700',
    },
  })
  countText.position.set(width / 2 - 23, height / 2 - 20)
  countText.anchor.set(0.5)
  container.addChild(countText)
}

function clearPendingDeckPress(pendingDeckPressRef: React.MutableRefObject<PendingDeckPress | null>) {
  const pending = pendingDeckPressRef.current
  if (!pending) {
    return
  }
  window.clearTimeout(pending.timeoutId)
  pendingDeckPressRef.current = null
}

function populateViewportScene(
  viewport: Viewport,
  renderedObjects: Map<Id, RenderedObject>,
  room: RoomDoc,
  currentPlayerId: string | undefined,
  selectedId: Id | undefined,
  hoverDeckId: Id | undefined,
  canEdit: boolean,
  onSelect: (id?: Id) => void,
  dragRef: React.MutableRefObject<DragState | null>,
  pendingDeckPressRef: React.MutableRefObject<PendingDeckPress | null>,
  tapCandidateRef: React.MutableRefObject<TapCandidate | null>,
  requestRender: () => void,
) {
  viewport.removeChildren()
  renderedObjects.clear()
  viewport.addChild(boardBackground())

  const root = getRootPlane(room)

  for (const objectId of root.childOrder) {
    const object = room.objects[objectId]
    const transform = root.childTransforms[objectId]
    if (!object || !transform) {
      continue
    }

    const container = new Container()
    container.position.set(transform.x, transform.y)
    container.rotation = transform.rotation
    container.eventMode = 'static'
    container.cursor = canEdit && !object.locked ? 'grab' : 'pointer'

    let width = Number(DEFAULT_CARD_SIZE.width)
    let height = Number(DEFAULT_CARD_SIZE.height)

    if (isCard(object)) {
      width = object.size.width
      height = object.size.height
      addCardContents(container, room, objectId, currentPlayerId, requestRender)
    } else if (isDeck(object)) {
      addDeckContents(container, room, objectId, currentPlayerId, requestRender)
    }

    const hitArea = new Graphics()
    hitArea
      .roundRect(-width / 2, -height / 2, width, height, 18)
      .stroke({
        width: hoverDeckId === objectId ? 5 : selectedId === objectId ? 4 : 0,
        color: hoverDeckId === objectId ? '#ff8d47' : '#ffcb72',
        alpha: hoverDeckId === objectId ? 1 : 0.95,
      })
    container.addChild(hitArea)

    container.hitArea = new Rectangle(-width / 2, -height / 2, width, height)
    container.on('pointerdown', (event) => {
      const isTouchPointer = event.pointerType === 'touch'
      const isMiddleMouse = event.pointerType === 'mouse' && event.button === 1

      if (isMiddleMouse) {
        return
      }

      if (isDeck(object) && canEdit && !object.locked) {
        onSelect(objectId)
        event.stopPropagation()

        tapCandidateRef.current = {
          id: objectId,
          pointerId: event.pointerId,
          startPointer: { x: event.global.x, y: event.global.y },
        }

        clearPendingDeckPress(pendingDeckPressRef)
        const world = viewport.toWorld(event.global)
        const timeoutId = window.setTimeout(() => {
          const pending = pendingDeckPressRef.current
          if (!pending || pending.deckId !== objectId || pending.pointerId !== event.pointerId) {
            return
          }

          dragRef.current = {
            id: objectId,
            mode: 'move',
            startPointer: pending.startWorld,
            startTransform: pending.startTransform,
            moved: false,
            raisedToFront: false,
          }
          tapCandidateRef.current = null
          pendingDeckPressRef.current = null
          viewport.plugins.pause('drag')
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

        if (!canEdit || object.locked || (!isCard(object) && !isDeck(object))) {
          return
        }

        const world = viewport.toWorld(event.global)
        dragRef.current = {
          id: objectId,
          mode: 'move',
          startPointer: { x: world.x, y: world.y },
          startTransform: { ...transform },
          moved: false,
          raisedToFront: false,
        }
        viewport.plugins.pause('drag')
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

      if (!canEdit || object.locked || (!isCard(object) && !isDeck(object))) {
        return
      }

      const world = viewport.toWorld(event.global)
      dragRef.current = {
        id: objectId,
        mode: 'move',
        startPointer: { x: world.x, y: world.y },
        startTransform: { ...transform },
        moved: false,
        raisedToFront: false,
      }
      viewport.plugins.pause('drag')
    })
    container.on('pointerup', (event) => {
      const pendingDeckPress = pendingDeckPressRef.current
      if (pendingDeckPress?.deckId === objectId && pendingDeckPress.pointerId === event.pointerId) {
        clearPendingDeckPress(pendingDeckPressRef)
      }

      if (event.pointerType !== 'touch') {
        return
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
        onSelect(objectId)
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

    if (selectedId === objectId && canEdit && !object.locked) {
      const handle = new Graphics()
      handle
        .circle(0, -height / 2 - 24, 13)
        .fill({ color: '#f7c05e' })
        .stroke({ width: 3, color: '#5a3918' })
      handle.eventMode = 'static'
      handle.cursor = 'grab'
      handle.on('pointerdown', (event) => {
        event.stopPropagation()
        const world = viewport.toWorld(event.global)
        dragRef.current = {
          id: objectId,
          mode: 'rotate',
          startPointer: { x: world.x, y: world.y },
          startTransform: { ...transform },
          moved: false,
          raisedToFront: false,
        }
        viewport.plugins.pause('drag')
      })
      container.addChild(handle)
    }

    viewport.addChild(container)
    renderedObjects.set(objectId, {
      container,
      width,
      height,
      transform: { ...transform },
    })
  }
}

export function BoardView({
  room,
  roomUrl,
  selectedId,
  currentPlayerId,
  canEdit,
  initialCamera,
  onCameraChange,
  onSelect,
  onCommitTransform,
  onDropObjectToDeck,
  onBringCardToFront,
  onLiftTopCardFromDeck,
  onFlipCard,
  onFlipDeck,
  onDrawDeck,
  onShuffleDeck,
  onDeleteObject,
}: BoardViewProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const appRef = useRef<Application | null>(null)
  const viewportRef = useRef<Viewport | null>(null)
  const renderedRef = useRef<Map<Id, RenderedObject>>(new Map())
  const dragRef = useRef<DragState | null>(null)
  const pendingDeckPressRef = useRef<PendingDeckPress | null>(null)
  const tapCandidateRef = useRef<TapCandidate | null>(null)
  const roomRef = useRef(room)
  const selectedIdRef = useRef(selectedId)
  const initialCameraRef = useRef(initialCamera)
  const currentPlayerIdRef = useRef(currentPlayerId)
  const canEditRef = useRef(canEdit)
  const [assetVersion, setAssetVersion] = useState(0)
  const [hoverDeckId, setHoverDeckId] = useState<Id | undefined>()
  const hoverDeckIdRef = useRef<Id | undefined>(hoverDeckId)
  const quickActionsRef = useRef<HTMLDivElement | null>(null)
  const callbacksRef = useRef({
    onCameraChange,
    onCommitTransform,
    onBringCardToFront,
    onDeleteObject,
    onDrawDeck,
    onFlipDeck,
    onLiftTopCardFromDeck,
    onDropObjectToDeck,
    onFlipCard,
    onSelect,
    onShuffleDeck,
  })
  const cameraSnapshot = useRef<string>('')
  const requestRenderRef = useRef(() => {
    setAssetVersion((current) => current + 1)
  })

  roomRef.current = room
  selectedIdRef.current = selectedId
  initialCameraRef.current = initialCamera
  currentPlayerIdRef.current = currentPlayerId
  canEditRef.current = canEdit
  hoverDeckIdRef.current = hoverDeckId
  callbacksRef.current = {
    onCameraChange,
    onCommitTransform,
    onBringCardToFront,
    onDeleteObject,
    onDrawDeck,
    onFlipDeck,
    onLiftTopCardFromDeck,
    onDropObjectToDeck,
    onFlipCard,
    onSelect,
    onShuffleDeck,
  }

  const quickActions = useMemo(() => {
    if (!selectedId) {
      return []
    }
    const object = room.objects[selectedId]
    if (!object || !canEdit || object.locked) {
      return []
    }

    if (object.type === 'card') {
      return [
        { label: 'Flip', onClick: () => onFlipCard(object.id) },
        { label: 'Delete', onClick: () => onDeleteObject(object.id) },
      ]
    }

    if (object.type === 'deck') {
      return [
        { label: 'Flip', onClick: () => onFlipDeck(object.id) },
        { label: 'Draw', onClick: () => onDrawDeck(object.id) },
        { label: 'Shuffle', onClick: () => onShuffleDeck(object.id) },
      ]
    }

    return []
  }, [canEdit, onDeleteObject, onDrawDeck, onFlipCard, onFlipDeck, onShuffleDeck, room.objects, selectedId])

  useEffect(() => {
    let cancelled = false
    const hostElement = hostRef.current
    if (!hostElement) {
      return
    }
    const host: HTMLDivElement = hostElement
    const renderedObjects = renderedRef.current

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
        worldWidth: BOARD_WORLD_SIZE,
        worldHeight: BOARD_WORLD_SIZE,
        passiveWheel: false,
        stopPropagation: true,
      })

      viewport
        .drag({ pressDrag: true })
        .pinch()
        .wheel({ smooth: 6, trackpadPinch: true })
        .decelerate({ friction: 0.92 })
        .clampZoom({ minScale: 0.35, maxScale: 2.5 })

      viewport.forceHitArea = new Rectangle(
        -BOARD_WORLD_SIZE / 2,
        -BOARD_WORLD_SIZE / 2,
        BOARD_WORLD_SIZE,
        BOARD_WORLD_SIZE,
      )
      viewport.eventMode = 'static'
      viewport.on('pointerdown', () => {
        if (!dragRef.current) {
          callbacksRef.current.onSelect(undefined)
        }
      })

      viewport.moveCenter(initialCameraRef.current.centerX, initialCameraRef.current.centerY)
      viewport.setZoom(initialCameraRef.current.zoom, true)

      app.stage.addChild(viewport)

      app.stage.eventMode = 'static'
      app.stage.hitArea = new Rectangle(0, 0, host.clientWidth, host.clientHeight)

      const emitCamera = () => {
        const snapshot = JSON.stringify({
          centerX: Number(viewport.center.x.toFixed(1)),
          centerY: Number(viewport.center.y.toFixed(1)),
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
        const screen = viewport.toScreen({
          x: rendered.container.position.x,
          y: rendered.container.position.y - rendered.height / 2 - 24,
        })
        overlay.style.left = `${screen.x}px`
        overlay.style.top = `${screen.y}px`
        overlay.style.opacity = '1'
      }

      const onPointerMove = (event: FederatedPointerEvent) => {
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
              mode: 'move',
              startPointer: pendingDeckPress.startWorld,
              startTransform: pendingDeckPress.startTransform,
              moved: false,
              raisedToFront: Boolean(liftedCardId),
            }
            viewport.plugins.pause('drag')
          }
        }

        const drag = dragRef.current
        if (!drag) {
          return
        }

        const rendered = renderedRef.current.get(drag.id)
        if (!rendered) {
          return
        }

        const world = viewport.toWorld(event.global)
        const distance = Math.hypot(world.x - drag.startPointer.x, world.y - drag.startPointer.y)
        drag.moved ||= distance > 8

        if (
          drag.mode === 'move' &&
          drag.moved &&
          !drag.raisedToFront &&
          roomRef.current.objects[drag.id]?.type === 'card'
        ) {
          callbacksRef.current.onBringCardToFront(drag.id)
          drag.raisedToFront = true
        }

        if (drag.mode === 'move') {
          const nextX = drag.startTransform.x + (world.x - drag.startPointer.x)
          const nextY = drag.startTransform.y + (world.y - drag.startPointer.y)
          rendered.container.position.set(nextX, nextY)
          rendered.transform = { ...drag.startTransform, x: nextX, y: nextY }

          const liveRoom = roomRef.current
          const draggingObject = liveRoom.objects[drag.id]
          const nextHoverDeckId =
            draggingObject && (draggingObject.type === 'card' || draggingObject.type === 'deck')
              ? findDeckAtPoint(liveRoom, { x: nextX, y: nextY }, drag.id)
              : undefined
          setHoverDeckId((current) => (current === nextHoverDeckId ? current : nextHoverDeckId))
        } else {
          const originX = drag.startTransform.x
          const originY = drag.startTransform.y
          const angle = Math.atan2(world.y - originY, world.x - originX) + Math.PI / 2
          rendered.container.rotation = angle
          rendered.transform = { ...drag.startTransform, rotation: angle }
        }

        updateOverlayPosition()
      }

      const finishDrag = (event: FederatedPointerEvent) => {
        const drag = dragRef.current
        if (!drag) {
          return
        }

        viewport.plugins.resume('drag')
        const rendered = renderedRef.current.get(drag.id)
        dragRef.current = null

        if (!rendered) {
          return
        }

        const world = viewport.toWorld(event.global)
        if (drag.mode === 'move') {
          const nextTransform = {
            x: rendered.container.position.x,
            y: rendered.container.position.y,
            rotation: drag.startTransform.rotation,
          }
          const liveRoom = roomRef.current
          const object = liveRoom.objects[drag.id]
          const targetDeckId =
            object && (object.type === 'card' || object.type === 'deck')
              ? findDeckAtPoint(liveRoom, world, drag.id)
              : undefined

          if (targetDeckId) {
            callbacksRef.current.onDropObjectToDeck(drag.id, targetDeckId)
          } else {
            callbacksRef.current.onCommitTransform(drag.id, nextTransform)
          }
        } else {
          callbacksRef.current.onCommitTransform(drag.id, {
            rotation: rendered.container.rotation,
          })
        }
        setHoverDeckId(undefined)
        updateOverlayPosition()
      }

      app.stage.on('pointermove', onPointerMove)
      app.stage.on('pointerup', finishDrag)
      app.stage.on('pointerupoutside', finishDrag)

      app.ticker.add(() => {
        emitCamera()
        updateOverlayPosition()
      })

      const observer = new ResizeObserver(() => {
        viewport.resize(host.clientWidth, host.clientHeight, BOARD_WORLD_SIZE, BOARD_WORLD_SIZE)
      })
      observer.observe(host)

      appRef.current = app
      viewportRef.current = viewport
      populateViewportScene(
        viewport,
        renderedRef.current,
        roomRef.current,
        currentPlayerIdRef.current,
        selectedIdRef.current,
        hoverDeckIdRef.current,
        canEditRef.current,
        callbacksRef.current.onSelect,
        dragRef,
        pendingDeckPressRef,
        tapCandidateRef,
        requestRenderRef.current,
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
      host.removeEventListener('touchstart', suppressNativeTouch)
      host.removeEventListener('touchmove', suppressNativeTouch)
      host.removeEventListener('contextmenu', suppressNativeTouch)
      host.removeEventListener('selectstart', suppressNativeTouch)
      host.removeEventListener('dragstart', suppressNativeTouch)
      viewportRef.current?.destroy({ children: true })
      appRef.current?.destroy(true, { children: true })
      renderedObjects.clear()
      viewportRef.current = null
      appRef.current = null
      host.textContent = ''
    }
  }, [roomUrl])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) {
      return
    }
    populateViewportScene(
      viewport,
      renderedRef.current,
      room,
      currentPlayerId,
      selectedId,
      hoverDeckId,
      canEdit,
      onSelect,
      dragRef,
      pendingDeckPressRef,
      tapCandidateRef,
      requestRenderRef.current,
    )
  }, [assetVersion, canEdit, currentPlayerId, hoverDeckId, onSelect, room, selectedId])

  return (
    <div className="board-root">
      <div className="board-canvas" ref={hostRef} />
      {quickActions.length > 0 ? (
        <div
          ref={quickActionsRef}
          className="quick-actions"
        >
          {quickActions.map((action) => (
            <button key={action.label} onClick={action.onClick}>
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
