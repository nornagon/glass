import {
  useDocHandle,
  useDocument,
  type AutomergeUrl,
} from '@automerge/react'
import { startTransition, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { BoardView } from '../board/BoardView'
import { syncTurnBadge } from './badge'
import { isRoomEphemeralMessage } from '../model/ephemeral'
import {
  clearJoinedPlayerId,
  loadJoinedPlayerId,
  loadCameraState,
  loadRoomTemplates,
  saveCameraState,
  saveJoinedPlayerId,
  saveRoomHistoryEntry,
  saveRoomTemplate,
} from '../model/local'
import {
  addCardToDeck,
  bringObjectToFront,
  canSeeCardFace,
  createBoardOnPlane,
  createCardOnPlane,
  createDeckOnPlane,
  createDeckFromSpriteSheetOnPlane,
  createPlayerId,
  deleteObject,
  drawFromDeck,
  flipBoard,
  flipDeck,
  duplicateObject,
  flipCard,
  formatRoomTitle,
  getRootPlane,
  isBoard,
  isCard,
  isDeck,
  liftTopCardFromDeck,
  mergeDeckIntoDeck,
  renameOrAddPlayer,
  sendObjectBackward,
  setTurnPlayer,
  shuffleDeck,
  bringObjectForward,
  moveObject,
  removePlayer,
} from '../model/room'
import type { Board, CameraState, Card, GameObject, Id, RoomDoc, SpriteSpec, Transform2D } from '../model/types'
import { DEFAULT_BOARD_SIZE, DEFAULT_CARD_SIZE } from '../model/types'

const DEFAULT_CAMERA: CameraState = {
  centerX: 0,
  centerY: 0,
  zoom: 1,
}

const REMOTE_DRAG_STALE_MS = 5000

interface RemoteDragSession {
  clientId: string
  objectId: Id
  transform: Transform2D
  updatedAt: number
  ending: boolean
}

function createClientId() {
  return globalThis.crypto?.randomUUID?.() ?? `glass-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function sameTransform(a: Transform2D | undefined, b: Transform2D | undefined) {
  if (!a || !b) {
    return a === b
  }

  return a.x === b.x && a.y === b.y && a.rotation === b.rotation
}

function sameTransformMap(a: Record<Id, Transform2D>, b: Record<Id, Transform2D>) {
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) {
    return false
  }

  return aKeys.every((key) => sameTransform(a[key], b[key]))
}

function dragTransformsByObject(sessions: Map<string, RemoteDragSession>) {
  const transforms: Record<Id, Transform2D> = {}
  const latestByObject = new Map<Id, number>()
  for (const session of sessions.values()) {
    const previousUpdatedAt = latestByObject.get(session.objectId) ?? Number.NEGATIVE_INFINITY
    if (session.updatedAt >= previousUpdatedAt) {
      latestByObject.set(session.objectId, session.updatedAt)
      transforms[session.objectId] = session.transform
    }
  }
  return transforms
}

function remoteDragSessionKey(clientId: string, objectId: Id) {
  return `${clientId}:${objectId}`
}
function nextSpawnTransform(camera: CameraState, offset: number) {
  return {
    x: camera.centerX + offset * 26,
    y: camera.centerY + offset * 18,
    rotation: 0,
  }
}

function normalizeMetaDraft(draft: string) {
  const parsed = JSON.parse(draft) as Record<string, string | number | boolean>
  return parsed
}

function loadImageDimensions(url: string) {
  return new Promise<{ width: number; height: number }>((resolve, reject) => {
    const image = new Image()
    image.crossOrigin = 'anonymous'
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
    image.src = url
  })
}

function cardSizeForAspect(aspect: number) {
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : DEFAULT_CARD_SIZE.width / DEFAULT_CARD_SIZE.height
  const targetArea = DEFAULT_CARD_SIZE.width * DEFAULT_CARD_SIZE.height
  return {
    width: Math.max(48, Math.round(Math.sqrt(targetArea * safeAspect))),
    height: Math.max(48, Math.round(Math.sqrt(targetArea / safeAspect))),
  }
}

async function resolveSpriteAspectRatio(spec: SpriteSpec) {
  if (spec.kind !== 'image-url' || !spec.url) {
    return undefined
  }

  const dimensions = await loadImageDimensions(spec.url)
  const cropWidth = spec.crop?.width ?? 1
  const cropHeight = spec.crop?.height ?? 1
  const aspect = (dimensions.width * cropWidth) / (dimensions.height * cropHeight)
  return Number.isFinite(aspect) && aspect > 0 ? aspect : undefined
}

async function resolveBoardResizeAspectRatio(board: Board) {
  const faceAspect = await resolveSpriteAspectRatio(board.face).catch(() => undefined)
  if (faceAspect) {
    return faceAspect
  }

  const metaAspect = typeof board.meta.aspectRatio === 'number' && board.meta.aspectRatio > 0
    ? board.meta.aspectRatio
    : undefined
  if (metaAspect) {
    return metaAspect
  }

  if (board.size.width > 0 && board.size.height > 0) {
    return board.size.width / board.size.height
  }

  return DEFAULT_BOARD_SIZE.width / DEFAULT_BOARD_SIZE.height
}

function updateSpriteCrop(value: SpriteSpec, partial: Partial<NonNullable<SpriteSpec['crop']>>): SpriteSpec {
  return {
    ...value,
    crop: {
      x: value.crop?.x ?? 0,
      y: value.crop?.y ?? 0,
      width: value.crop?.width ?? 1,
      height: value.crop?.height ?? 1,
      ...partial,
    },
  }
}

interface SheetDeckDraft {
  name: string
  faceUrl: string
  faceRows: string
  faceCols: string
  faceCount: string
  backUrl: string
  backRows: string
  backCols: string
  backCount: string
}

interface BoardDraft {
  name: string
  faceUrl: string
  backUrl: string
}

type RightPanelMode = 'turn' | 'selection'
type CreationMode = 'board' | 'deck-sheet'
type SelectionMode = 'normal' | 'group'

function defaultSheetDeckDraft(): SheetDeckDraft {
  return {
    name: '',
    faceUrl: '',
    faceRows: '4',
    faceCols: '13',
    faceCount: '',
    backUrl: '',
    backRows: '1',
    backCols: '1',
    backCount: '',
  }
}

function defaultBoardDraft(): BoardDraft {
  return {
    name: '',
    faceUrl: '',
    backUrl: '',
  }
}

function parsePositiveInteger(value: string) {
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

function resolveSheetCount(countText: string, rows: number, cols: number) {
  const trimmed = countText.trim()
  if (!trimmed) {
    return rows * cols
  }
  return parsePositiveInteger(trimmed)
}

function SpriteEditor({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string
  value: SpriteSpec
  disabled: boolean
  onChange: (next: SpriteSpec) => void
}) {
  return (
    <section className="inspector-group">
      <h4>{label}</h4>
      <label className="field">
        <span>Kind</span>
        <select
          disabled={disabled}
          value={value.kind}
          onChange={(event) =>
            onChange({
              ...value,
              kind: event.target.value as SpriteSpec['kind'],
            })
          }
        >
          <option value="label">Label</option>
          <option value="image-url">Image URL</option>
        </select>
      </label>
      {value.kind === 'image-url' ? (
        <>
          <label className="field">
            <span>URL</span>
            <input
              disabled={disabled}
              type="url"
              value={value.url ?? ''}
              onChange={(event) =>
                onChange({
                  ...value,
                  url: event.target.value,
                })
              }
              placeholder="https://example.com/card.png"
            />
          </label>
          <label className="field">
            <span>Fit</span>
            <select
              disabled={disabled}
              value={value.fit ?? 'cover'}
              onChange={(event) =>
                onChange({
                  ...value,
                  fit: event.target.value as NonNullable<SpriteSpec['fit']>,
                })
              }
            >
              <option value="cover">Cover Card</option>
              <option value="contain">Contain Inside Border</option>
            </select>
          </label>
          <div className="field-row">
            <label className="field">
              <span>Crop X</span>
              <input
                disabled={disabled}
                type="number"
                step="0.001"
                min="0"
                max="1"
                value={value.crop?.x ?? 0}
                onChange={(event) =>
                  onChange(
                    updateSpriteCrop(value, {
                      x: Number.parseFloat(event.target.value) || 0,
                    }),
                  )
                }
              />
            </label>
            <label className="field">
              <span>Crop Y</span>
              <input
                disabled={disabled}
                type="number"
                step="0.001"
                min="0"
                max="1"
                value={value.crop?.y ?? 0}
                onChange={(event) =>
                  onChange(
                    updateSpriteCrop(value, {
                      y: Number.parseFloat(event.target.value) || 0,
                    }),
                  )
                }
              />
            </label>
          </div>
          <div className="field-row">
            <label className="field">
              <span>Crop W</span>
              <input
                disabled={disabled}
                type="number"
                step="0.001"
                min="0.001"
                max="1"
                value={value.crop?.width ?? 1}
                onChange={(event) =>
                  onChange(
                    updateSpriteCrop(value, {
                      width: Math.max(0.001, Number.parseFloat(event.target.value) || 1),
                    }),
                  )
                }
              />
            </label>
            <label className="field">
              <span>Crop H</span>
              <input
                disabled={disabled}
                type="number"
                step="0.001"
                min="0.001"
                max="1"
                value={value.crop?.height ?? 1}
                onChange={(event) =>
                  onChange(
                    updateSpriteCrop(value, {
                      height: Math.max(0.001, Number.parseFloat(event.target.value) || 1),
                    }),
                  )
                }
              />
            </label>
          </div>
        </>
      ) : (
        <label className="field">
          <span>Label</span>
          <input
            disabled={disabled}
            value={value.label ?? ''}
            onChange={(event) =>
              onChange({
                ...value,
                label: event.target.value,
              })
            }
          />
        </label>
      )}
      <div className="field-row">
        <label className="field">
          <span>Background</span>
          <input
            disabled={disabled}
            type="color"
            value={value.bg ?? '#f8efe1'}
            onChange={(event) =>
              onChange({
                ...value,
                bg: event.target.value,
              })
            }
          />
        </label>
        <label className="field">
          <span>Foreground</span>
          <input
            disabled={disabled}
            type="color"
            value={value.fg ?? '#20262b'}
            onChange={(event) =>
              onChange({
                ...value,
                fg: event.target.value,
              })
            }
          />
        </label>
      </div>
    </section>
  )
}

function MetaEditor({
  object,
  disabled,
  onCommit,
}: {
  object: GameObject
  disabled: boolean
  onCommit: (next: Record<string, string | number | boolean>) => void
}) {
  const [draft, setDraft] = useState(() => JSON.stringify(object.meta, null, 2))
  const [error, setError] = useState('')

  return (
    <section className="inspector-group">
      <h4>Metadata</h4>
      <textarea
        className="meta-editor"
        disabled={disabled}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      <div className="button-row">
        <button
          disabled={disabled}
          onClick={() => {
            try {
              onCommit(normalizeMetaDraft(draft))
              setError('')
            } catch {
              setError('Metadata must be valid JSON with string/number/boolean values.')
            }
          }}
        >
          Apply Metadata
        </button>
      </div>
      {error ? <p className="inline-error">{error}</p> : null}
    </section>
  )
}

function BoardSizeEditor({
  width,
  height,
  disabled,
  onCommitWidth,
  onCommitHeight,
}: {
  width: number
  height: number
  disabled: boolean
  onCommitWidth: (width: number) => void | Promise<void>
  onCommitHeight: (height: number) => void | Promise<void>
}) {
  const [widthDraft, setWidthDraft] = useState(() => String(width))
  const [heightDraft, setHeightDraft] = useState(() => String(height))

  useEffect(() => {
    setWidthDraft(String(width))
  }, [width])

  useEffect(() => {
    setHeightDraft(String(height))
  }, [height])

  function commitWidth() {
    const nextWidth = Math.max(48, Number.parseInt(widthDraft, 10) || width)
    void onCommitWidth(nextWidth)
  }

  function commitHeight() {
    const nextHeight = Math.max(48, Number.parseInt(heightDraft, 10) || height)
    void onCommitHeight(nextHeight)
  }

  return (
    <>
      <div className="field-row">
        <label className="field">
          <span>Width</span>
          <input
            disabled={disabled}
            type="number"
            min="48"
            step="1"
            value={widthDraft}
            onChange={(event) => setWidthDraft(event.target.value)}
            onBlur={commitWidth}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.currentTarget.blur()
              }
            }}
          />
        </label>
        <label className="field">
          <span>Height</span>
          <input
            disabled={disabled}
            type="number"
            min="48"
            step="1"
            value={heightDraft}
            onChange={(event) => setHeightDraft(event.target.value)}
            onBlur={commitHeight}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.currentTarget.blur()
              }
            }}
          />
        </label>
      </div>
      <p className="field-note">Aspect ratio is locked while resizing boards.</p>
    </>
  )
}

export function RoomScreen({ roomUrl }: { roomUrl: AutomergeUrl }) {
  return <RoomScreenInner key={roomUrl} roomUrl={roomUrl} />
}

function RoomScreenInner({ roomUrl }: { roomUrl: AutomergeUrl }) {
  const [room, changeRoom] = useDocument<RoomDoc>(roomUrl, { suspense: true })
  const roomHandle = useDocHandle<RoomDoc>(roomUrl, { suspense: true })
  const [selectedId, setSelectedId] = useState<string>()
  const [selectionMode, setSelectionMode] = useState<SelectionMode>('normal')
  const [groupSelectionIds, setGroupSelectionIds] = useState<string[]>([])
  const [groupPrimaryId, setGroupPrimaryId] = useState<string>()
  const [isLassoMode, setIsLassoMode] = useState(false)
  const [joinedPlayerId, setJoinedPlayerId] = useState<string | undefined>(() => loadJoinedPlayerId(roomUrl))
  const [isRoomPanelOpen, setIsRoomPanelOpen] = useState(false)
  const [rightPanelMode, setRightPanelMode] = useState<RightPanelMode | undefined>()
  const [isAddMenuOpen, setIsAddMenuOpen] = useState(false)
  const [creationMode, setCreationMode] = useState<CreationMode | undefined>()
  const [camera, setCamera] = useState<CameraState>(() => loadCameraState(roomUrl) ?? DEFAULT_CAMERA)
  const [allowSelectLocked, setAllowSelectLocked] = useState(false)
  const [boardDraft, setBoardDraft] = useState<BoardDraft>(() => defaultBoardDraft())
  const [boardDraftError, setBoardDraftError] = useState('')
  const [sheetDeckDraft, setSheetDeckDraft] = useState<SheetDeckDraft>(() => defaultSheetDeckDraft())
  const [sheetDeckError, setSheetDeckError] = useState('')
  const [ephemeralTransforms, setEphemeralTransforms] = useState<Record<Id, Transform2D>>({})
  const spawnCountRef = useRef(0)
  const clientIdRef = useRef(createClientId())
  const remoteDragSessionsRef = useRef(new Map<string, RemoteDragSession>())
  const remoteDragExpiryRef = useRef(new Map<string, number>())
  const localDragPreviewRef = useRef<Record<Id, Transform2D>>({})
  const localDragPreviewFrameRef = useRef<number | undefined>(undefined)
  const selectedObject = selectionMode === 'normal' && selectedId ? room.objects[selectedId] : undefined
  const boardSelectedIds = selectionMode === 'group' ? groupSelectionIds : selectedId ? [selectedId] : []
  const boardPrimarySelectedId = selectionMode === 'group' ? groupPrimaryId : selectedObject?.id
  const visibleRightPanelMode =
    rightPanelMode === 'selection'
      ? selectionMode === 'normal' && selectedObject
        ? rightPanelMode
        : undefined
      : rightPanelMode
  const currentPlayer = joinedPlayerId ? room.players[joinedPlayerId] : undefined
  const canEdit = Boolean(currentPlayer)
  const roomTitle = formatRoomTitle(room)
  const linkedTemplate = room.sourceTemplateId ? loadRoomTemplates().find((template) => template.id === room.sourceTemplateId) : undefined
  const isGroupSelectionMode = selectionMode === 'group'

  const syncEphemeralTransforms = useEffectEvent(() => {
    const next = dragTransformsByObject(remoteDragSessionsRef.current)
    startTransition(() => {
      setEphemeralTransforms((current) => (sameTransformMap(current, next) ? current : next))
    })
  })

  const clearRemoteDragExpiry = useEffectEvent((sessionKey: string) => {
    const timeoutId = remoteDragExpiryRef.current.get(sessionKey)
    if (timeoutId === undefined) {
      return
    }
    window.clearTimeout(timeoutId)
    remoteDragExpiryRef.current.delete(sessionKey)
  })

  const removeRemoteDragSession = useEffectEvent((sessionKey: string) => {
    clearRemoteDragExpiry(sessionKey)
    if (remoteDragSessionsRef.current.delete(sessionKey)) {
      syncEphemeralTransforms()
    }
  })

  const scheduleRemoteDragExpiry = useEffectEvent((sessionKey: string) => {
    clearRemoteDragExpiry(sessionKey)
    const timeoutId = window.setTimeout(() => {
      remoteDragExpiryRef.current.delete(sessionKey)
      if (remoteDragSessionsRef.current.delete(sessionKey)) {
        syncEphemeralTransforms()
      }
    }, REMOTE_DRAG_STALE_MS)
    remoteDragExpiryRef.current.set(sessionKey, timeoutId)
  })

  function flushLocalDragPreview() {
    const pendingEntries = Object.entries(localDragPreviewRef.current)
    if (pendingEntries.length === 0) {
      return
    }

    for (const [objectId, transform] of pendingEntries) {
      roomHandle.broadcast({
        kind: 'drag-preview',
        clientId: clientIdRef.current,
        objectId,
        transform,
      })
    }
  }

  function previewTransform(objectId: Id, transform: Transform2D) {
    localDragPreviewRef.current = {
      ...localDragPreviewRef.current,
      [objectId]: transform,
    }
    if (localDragPreviewFrameRef.current !== undefined) {
      return
    }

    localDragPreviewFrameRef.current = window.requestAnimationFrame(() => {
      localDragPreviewFrameRef.current = undefined
      flushLocalDragPreview()
    })
  }

  function clearPreviewTransform(objectId: Id) {
    delete localDragPreviewRef.current[objectId]
    roomHandle.broadcast({
      kind: 'drag-preview-end',
      clientId: clientIdRef.current,
      objectId,
    })
  }

  useEffect(() => {
    const clientId = clientIdRef.current
    const remoteDragSessions = remoteDragSessionsRef.current
    const remoteDragExpiries = remoteDragExpiryRef.current

    const handleIncomingMessage = (event: { message: unknown }) => {
      const message = event.message
      if (!isRoomEphemeralMessage(message) || message.clientId === clientId) {
        return
      }

      if (message.kind === 'drag-preview') {
        const updatedAt = Date.now()
        const sessionKey = remoteDragSessionKey(message.clientId, message.objectId)
        remoteDragSessions.set(sessionKey, {
          clientId: message.clientId,
          objectId: message.objectId,
          transform: message.transform,
          updatedAt,
          ending: false,
        })
        scheduleRemoteDragExpiry(sessionKey)
        syncEphemeralTransforms()
        return
      }

      const sessionKey = remoteDragSessionKey(message.clientId, message.objectId)
      const existing = remoteDragSessions.get(sessionKey)
      if (!existing) {
        removeRemoteDragSession(sessionKey)
        return
      }

      remoteDragSessions.set(sessionKey, {
        ...existing,
        updatedAt: Date.now(),
        ending: true,
      })
      scheduleRemoteDragExpiry(sessionKey)
      syncEphemeralTransforms()
    }

    roomHandle.on('ephemeral-message', handleIncomingMessage)
    return () => {
      roomHandle.removeListener('ephemeral-message', handleIncomingMessage)

      if (localDragPreviewFrameRef.current !== undefined) {
        window.cancelAnimationFrame(localDragPreviewFrameRef.current)
        localDragPreviewFrameRef.current = undefined
      }

      const pendingPreview = Object.keys(localDragPreviewRef.current)
      localDragPreviewRef.current = {}
      if (pendingPreview.length > 0) {
        for (const objectId of pendingPreview) {
        roomHandle.broadcast({
          kind: 'drag-preview-end',
          clientId,
          objectId,
        })
      }
      }

      for (const timeoutId of remoteDragExpiries.values()) {
        window.clearTimeout(timeoutId)
      }
      remoteDragExpiries.clear()
      remoteDragSessions.clear()
    }
  }, [roomHandle])

  useEffect(() => {
    let changed = false
    const root = getRootPlane(room)
    for (const [sessionKey, session] of remoteDragSessionsRef.current) {
      const object = room.objects[session.objectId]
      if (!object || object.parentId !== room.rootId) {
        clearRemoteDragExpiry(sessionKey)
        remoteDragSessionsRef.current.delete(sessionKey)
        changed = true
        continue
      }

      const persistedTransform = root.childTransforms[session.objectId]
      if (session.ending && sameTransform(persistedTransform, session.transform)) {
        clearRemoteDragExpiry(sessionKey)
        remoteDragSessionsRef.current.delete(sessionKey)
        changed = true
      }
    }

    if (changed) {
      syncEphemeralTransforms()
    }
  }, [room, room.rootId])

  useEffect(() => {
    const entry = {
      roomUrl,
      title: roomTitle,
      lastOpenedAt: Date.now(),
      lastKnownTurnPlayerId: room.turnPlayerId,
      lastKnownPlayerName: currentPlayer?.name,
    }
    saveRoomHistoryEntry(entry)
  }, [currentPlayer?.name, room.turnPlayerId, roomTitle, roomUrl])

  useEffect(() => {
    const isMyTurn = Boolean(joinedPlayerId && room.turnPlayerId === joinedPlayerId)
    void syncTurnBadge(isMyTurn)

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void syncTurnBadge(isMyTurn)
      }
    }

    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [joinedPlayerId, room.turnPlayerId])

  const playerList = useMemo(
    () =>
      room.playerOrder
        .map((playerId) => room.players[playerId])
        .filter((player): player is NonNullable<typeof player> => Boolean(player)),
    [room.playerOrder, room.players],
  )

  useEffect(() => {
    if (selectionMode !== 'group') {
      return
    }

    const nextIds = groupSelectionIds.filter((id) => {
      const object = room.objects[id]
      return Boolean(object && (object.type === 'card' || object.type === 'deck'))
    })

    if (nextIds.length === groupSelectionIds.length) {
      return
    }

    if (nextIds.length === 0) {
      setSelectionMode('normal')
      setGroupSelectionIds([])
      setGroupPrimaryId(undefined)
      setSelectedId(undefined)
      setIsLassoMode(false)
      setRightPanelMode((mode) => (mode === 'selection' ? undefined : mode))
      return
    }

    setGroupSelectionIds(nextIds)
    setGroupPrimaryId((current) => (current && nextIds.includes(current) ? current : nextIds[nextIds.length - 1]))
  }, [groupSelectionIds, room.objects, selectionMode])

  useEffect(() => {
    if (selectionMode === 'normal' && selectedId && !room.objects[selectedId]) {
      setSelectedId(undefined)
      setRightPanelMode((mode) => (mode === 'selection' ? undefined : mode))
    }
  }, [room.objects, selectedId, selectionMode])

  function mutate(change: (draft: RoomDoc) => void) {
    if (!canEdit) {
      return
    }
    changeRoom(change)
  }

  function toggleRoomPanel() {
    setIsRoomPanelOpen((current) => {
      const next = !current
      setIsAddMenuOpen(false)
      if (next) {
        setRightPanelMode(undefined)
      }
      return next
    })
  }

  function toggleTurnPanel() {
    setRightPanelMode((current) => {
      const next = current === 'turn' ? undefined : 'turn'
      setIsAddMenuOpen(false)
      if (next) {
        setIsRoomPanelOpen(false)
      }
      return next
    })
  }

  function updateSelection(nextId?: string) {
    setSelectionMode('normal')
    setGroupSelectionIds([])
    setGroupPrimaryId(undefined)
    setIsLassoMode(false)
    setSelectedId(nextId)
    if (!nextId) {
      setRightPanelMode((current) => (current === 'selection' ? undefined : current))
    }
  }

  function enterGroupSelectionMode() {
    const seedId =
      selectedId && room.objects[selectedId] && (room.objects[selectedId].type === 'card' || room.objects[selectedId].type === 'deck')
        ? selectedId
        : undefined
    setSelectionMode('group')
    setGroupSelectionIds(seedId ? [seedId] : [])
    setGroupPrimaryId(seedId)
    setIsLassoMode(false)
    setIsAddMenuOpen(false)
    setRightPanelMode((current) => (current === 'selection' ? undefined : current))
  }

  function exitGroupSelectionMode() {
    setSelectionMode('normal')
    setGroupSelectionIds([])
    setGroupPrimaryId(undefined)
    setIsLassoMode(false)
    setSelectedId(undefined)
  }

  function toggleGroupSelection(id: string) {
    const object = room.objects[id]
    if (!object || (object.type !== 'card' && object.type !== 'deck')) {
      return
    }

    setGroupSelectionIds((current) => {
      const exists = current.includes(id)
      const next = exists ? current.filter((candidateId) => candidateId !== id) : [...current, id]

      if (next.length === 0) {
        setSelectionMode('normal')
        setGroupPrimaryId(undefined)
        setSelectedId(undefined)
        setIsLassoMode(false)
        setRightPanelMode((mode) => (mode === 'selection' ? undefined : mode))
        return []
      }

      setGroupPrimaryId((currentPrimary) => {
        if (!exists) {
          return id
        }
        if (currentPrimary === id) {
          return next[next.length - 1]
        }
        return currentPrimary && next.includes(currentPrimary) ? currentPrimary : next[next.length - 1]
      })
      return next
    })
  }

  function addToGroupSelection(ids: string[]) {
    const validIds = ids.filter((id) => {
      const object = room.objects[id]
      return Boolean(object && (object.type === 'card' || object.type === 'deck'))
    })
    if (validIds.length === 0) {
      setIsLassoMode(false)
      return
    }

    setSelectionMode('group')
    setGroupSelectionIds((current) => {
      const next = [...new Set([...current, ...validIds])]
      setGroupPrimaryId((currentPrimary) => currentPrimary ?? next[next.length - 1])
      return next
    })
    setIsLassoMode(false)
  }

  function openSelectionPanel() {
    if (selectionMode === 'normal' && selectedObject) {
      setIsRoomPanelOpen(false)
      setIsAddMenuOpen(false)
      setRightPanelMode('selection')
    }
  }

  function closeRoomPanel() {
    setIsRoomPanelOpen(false)
  }

  function closeTurnPanel() {
    setRightPanelMode((current) => (current === 'turn' ? undefined : current))
  }

  function closeRightPanel() {
    setRightPanelMode(undefined)
  }

  function toggleAddMenu() {
    setIsAddMenuOpen((current) => {
      const next = !current
      if (next) {
        setIsRoomPanelOpen(false)
        setRightPanelMode(undefined)
      }
      return next
    })
  }

  function openCreationFlow(mode: CreationMode) {
    setIsAddMenuOpen(false)
    setBoardDraftError('')
    setSheetDeckError('')
    setCreationMode(mode)
  }

  function closeCreationFlow() {
    setCreationMode(undefined)
    setBoardDraftError('')
    setSheetDeckError('')
  }

  function returnToLobby() {
    window.location.hash = ''
  }

  function saveCurrentRoomAsTemplate() {
    const nextTitle = window.prompt('Save room as template', roomTitle)?.trim()
    if (!nextTitle) {
      return
    }

    const nextTemplate = saveRoomTemplate({
      title: nextTitle,
      room,
    })
    if (nextTemplate) {
      mutate((draft) => {
        draft.sourceTemplateId = nextTemplate.id
      })
    }
  }

  function updateLinkedTemplate() {
    if (!linkedTemplate) {
      return
    }

    const confirmed = window.confirm(`Update template "${linkedTemplate.title}" from the current room?`)
    if (!confirmed) {
      return
    }

    saveRoomTemplate({
      id: linkedTemplate.id,
      title: linkedTemplate.title,
      room,
    })
  }

  function joinRoom() {
    const playerId = createPlayerId()
    changeRoom((draft) => {
      renameOrAddPlayer(draft, playerId)
    })
    saveJoinedPlayerId(roomUrl, playerId)
    setJoinedPlayerId(playerId)
  }

  function removePlayerFromRoom(playerId: string) {
    const player = room.players[playerId]
    if (!player) {
      return
    }

    const isSelf = joinedPlayerId === playerId
    const confirmed = window.confirm(
      isSelf ? `Leave this room as "${player.name}"?` : `Remove "${player.name}" from this room?`,
    )
    if (!confirmed) {
      return
    }

    changeRoom((draft) => {
      removePlayer(draft, playerId)
    })

    if (isSelf) {
      clearJoinedPlayerId(roomUrl)
      setJoinedPlayerId(undefined)
    }
  }

  function createCardHere() {
    const offset = spawnCountRef.current++
    mutate((draft) => {
      createCardOnPlane(draft, draft.rootId, nextSpawnTransform(camera, offset))
    })
    setIsAddMenuOpen(false)
  }

  function createDeckHere() {
    const offset = spawnCountRef.current++
    mutate((draft) => {
      createDeckOnPlane(draft, draft.rootId, nextSpawnTransform(camera, offset))
    })
    setIsAddMenuOpen(false)
  }

  function createBoardHere() {
    const offset = spawnCountRef.current++
    let createdBoardId: string | undefined
    mutate((draft) => {
      createdBoardId = createBoardOnPlane(draft, draft.rootId, nextSpawnTransform(camera, offset))
    })

    if (createdBoardId) {
      updateSelection(createdBoardId)
      setRightPanelMode('selection')
      setCreationMode(undefined)
    }
    setIsAddMenuOpen(false)
  }

  async function createBoardFromImage() {
    const faceUrl = boardDraft.faceUrl.trim()
    if (!faceUrl) {
      setBoardDraftError('A board image URL is required.')
      return
    }

    let size: { width: number; height: number } = { ...DEFAULT_BOARD_SIZE }
    try {
      const dimensions = await loadImageDimensions(faceUrl)
      size = {
        width: Math.max(160, Math.round(dimensions.width)),
        height: Math.max(160, Math.round(dimensions.height)),
      }
    } catch {
      setBoardDraftError('Could not load the board image to determine board size.')
      return
    }

    const offset = spawnCountRef.current++
    let createdBoardId: string | undefined
    mutate((draft) => {
      createdBoardId = createBoardOnPlane(
        draft,
        draft.rootId,
        nextSpawnTransform(camera, offset),
        boardDraft.name.trim() || undefined,
      )

      if (!createdBoardId) {
        return
      }

      const createdBoard = draft.objects[createdBoardId]
      if (!isBoard(createdBoard)) {
        return
      }

      createdBoard.size = size
      createdBoard.meta.aspectRatio = size.width / size.height
      createdBoard.face = {
        kind: 'image-url',
        url: faceUrl,
        fit: 'cover',
      }

      const backUrl = boardDraft.backUrl.trim()
      if (backUrl) {
        createdBoard.back = {
          kind: 'image-url',
          url: backUrl,
          fit: 'cover',
        }
      }
    })

    if (!createdBoardId) {
      setBoardDraftError('Could not create the board from that image.')
      return
    }

    setBoardDraft(defaultBoardDraft())
    setBoardDraftError('')
    updateSelection(createdBoardId)
    setRightPanelMode('selection')
    setCreationMode(undefined)
  }

  async function createDeckFromSheet() {
    const faceUrl = sheetDeckDraft.faceUrl.trim()
    if (!faceUrl) {
      setSheetDeckError('A face sprite sheet URL is required.')
      return
    }

    const faceRows = parsePositiveInteger(sheetDeckDraft.faceRows)
    const faceCols = parsePositiveInteger(sheetDeckDraft.faceCols)
    if (!faceRows || !faceCols) {
      setSheetDeckError('Face rows and columns must be positive whole numbers.')
      return
    }

    const faceCount = resolveSheetCount(sheetDeckDraft.faceCount, faceRows, faceCols)
    if (!faceCount) {
      setSheetDeckError('Face card count must be a positive whole number.')
      return
    }

    const backUrl = sheetDeckDraft.backUrl.trim()
    let backRows: number | undefined
    let backCols: number | undefined
    let backCount: number | undefined

    if (backUrl) {
      backRows = parsePositiveInteger(sheetDeckDraft.backRows)
      backCols = parsePositiveInteger(sheetDeckDraft.backCols)
      if (!backRows || !backCols) {
        setSheetDeckError('Back rows and columns must be positive whole numbers.')
        return
      }

      backCount = resolveSheetCount(sheetDeckDraft.backCount, backRows, backCols)
      if (!backCount) {
        setSheetDeckError('Back card count must be a positive whole number.')
        return
      }
    }

    let cardSize: { width: number; height: number } = { ...DEFAULT_CARD_SIZE }
    try {
      const dimensions = await loadImageDimensions(faceUrl)
      const cellAspect = (dimensions.width / faceCols) / (dimensions.height / faceRows)
      cardSize = cardSizeForAspect(cellAspect)
    } catch {
      setSheetDeckError('Could not load the face sheet to determine card aspect ratio.')
      return
    }

    const offset = spawnCountRef.current++
    let createdDeckId: string | undefined
    mutate((draft) => {
      createdDeckId = createDeckFromSpriteSheetOnPlane(
        draft,
        draft.rootId,
        nextSpawnTransform(camera, offset),
        {
          name: sheetDeckDraft.name.trim() || undefined,
          faces: {
            url: faceUrl,
            rows: faceRows,
            cols: faceCols,
            count: faceCount,
          },
          cardSize,
          backs: backUrl && backRows && backCols && backCount
            ? {
                url: backUrl,
                rows: backRows,
                cols: backCols,
                count: backCount,
              }
            : undefined,
        },
      )
    })

    if (!createdDeckId) {
      setSheetDeckError('Could not create a deck from that sheet configuration.')
      return
    }

    updateSelection(createdDeckId)
    setSheetDeckError('')
    setSheetDeckDraft(defaultSheetDeckDraft())
    setRightPanelMode('selection')
    setCreationMode(undefined)
  }

  const turnPlayer = room.turnPlayerId ? room.players[room.turnPlayerId] : undefined
  const isTurnPanelOpen = rightPanelMode === 'turn'
  const isMyTurn = Boolean(currentPlayer && turnPlayer && currentPlayer.id === turnPlayer.id)
  const facePreviewCount = useMemo(() => {
    const rows = parsePositiveInteger(sheetDeckDraft.faceRows)
    const cols = parsePositiveInteger(sheetDeckDraft.faceCols)
    if (!rows || !cols) {
      return undefined
    }
    return resolveSheetCount(sheetDeckDraft.faceCount, rows, cols)
  }, [sheetDeckDraft.faceCols, sheetDeckDraft.faceCount, sheetDeckDraft.faceRows])
  const backPreviewCount = useMemo(() => {
    if (!sheetDeckDraft.backUrl.trim()) {
      return undefined
    }
    const rows = parsePositiveInteger(sheetDeckDraft.backRows)
    const cols = parsePositiveInteger(sheetDeckDraft.backCols)
    if (!rows || !cols) {
      return undefined
    }
    return resolveSheetCount(sheetDeckDraft.backCount, rows, cols)
  }, [
    sheetDeckDraft.backCols,
    sheetDeckDraft.backCount,
    sheetDeckDraft.backRows,
    sheetDeckDraft.backUrl,
  ])

  return (
    <div className="app-shell">
      <main className="board-shell">
        <BoardView
          key={roomUrl}
          room={room}
          roomUrl={roomUrl}
          ephemeralTransforms={ephemeralTransforms}
          selectionMode={selectionMode}
          selectedId={boardPrimarySelectedId}
          selectedIds={boardSelectedIds}
          lassoMode={isLassoMode}
          currentPlayerId={currentPlayer?.id}
          canEdit={canEdit}
          allowSelectLocked={allowSelectLocked}
          initialCamera={camera}
          onCameraChange={(next) => {
            setCamera(next)
            saveCameraState(roomUrl, next)
          }}
          onSelect={updateSelection}
          onToggleGroupSelection={toggleGroupSelection}
          onAddToGroupSelection={addToGroupSelection}
          onCommitTransform={(objectId, transform) =>
            mutate((draft) => {
              moveObject(draft, objectId, transform)
            })
          }
          onPreviewTransform={previewTransform}
          onClearPreviewTransform={clearPreviewTransform}
          onBringCardToFront={(cardId) =>
            mutate((draft) => {
              bringObjectToFront(draft, cardId)
            })
          }
          onDropObjectToDeck={(objectId, deckId) => {
            const droppedObject = room.objects[objectId]
            mutate((draft) => {
              if (droppedObject?.type === 'card') {
                addCardToDeck(draft, objectId, deckId)
                return
              }
              if (droppedObject?.type === 'deck') {
                mergeDeckIntoDeck(draft, objectId, deckId)
              }
            })
            if (droppedObject?.type === 'deck' && selectedId === objectId) {
              updateSelection(deckId)
            }
          }}
          onLiftTopCardFromDeck={(deckId) => {
            let liftedCardId: string | undefined
            mutate((draft) => {
              liftedCardId = liftTopCardFromDeck(draft, deckId)
            })
            if (liftedCardId) {
              updateSelection(liftedCardId)
            }
            return liftedCardId
          }}
          onFlipCard={(cardId) =>
            mutate((draft) => {
              flipCard(draft, cardId)
            })
          }
          onFlipBoard={(boardId) =>
            mutate((draft) => {
              flipBoard(draft, boardId)
            })
          }
          onFlipDeck={(deckId) =>
            mutate((draft) => {
              flipDeck(draft, deckId)
            })
          }
          onDrawDeck={(deckId) =>
            mutate((draft) => {
              drawFromDeck(draft, deckId)
            })
          }
          onShuffleDeck={(deckId) =>
            mutate((draft) => {
              shuffleDeck(draft, deckId)
            })
          }
          onOpenSelectionPanel={openSelectionPanel}
        />
      </main>

      <div className="overlay-layer">
        <header className="topbar">
          {!isRoomPanelOpen ? (
            <button className="topbar-title topbar-title-button" onClick={toggleRoomPanel}>
              <h1>{roomTitle}</h1>
            </button>
          ) : null}
          <div className="topbar-status">
            {!currentPlayer && !isTurnPanelOpen ? (
              <button className="topbar-action-button" onClick={joinRoom}>
                Join Room
              </button>
            ) : null}
            {!isTurnPanelOpen ? (
              <button
                aria-label={`Turn: ${turnPlayer?.name ?? 'Unset'}`}
                className={`turn-pill-button ${isMyTurn ? 'is-self-turn' : ''}`}
                onClick={toggleTurnPanel}
                title={turnPlayer?.name ? `Turn: ${turnPlayer.name}` : 'Open turn panel'}
              >
                <strong>{turnPlayer?.name ?? 'No Turn Set'}</strong>
              </button>
            ) : null}
          </div>
        </header>

        {isRoomPanelOpen ? (
          <div className="modal-scrim" onClick={closeRoomPanel}>
            <aside aria-modal="true" className="room-panel" role="dialog" onClick={(event) => event.stopPropagation()}>
              <section className="room-panel-card">
                <div className="room-panel-header">
                  {canEdit ? (
                    <textarea
                      aria-label="Room name"
                      className="drawer-title-input"
                      placeholder="Untitled Table"
                      rows={1}
                      spellCheck={false}
                      wrap="off"
                      value={getRootPlane(room).name}
                      onChange={(event) =>
                        mutate((draft) => {
                          getRootPlane(draft).name = event.target.value.replaceAll('\n', ' ')
                        })
                      }
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          event.currentTarget.blur()
                        }
                      }}
                    />
                  ) : (
                    <h2 className="room-panel-title">{roomTitle}</h2>
                  )}
                  <button aria-label="Close room panel" className="panel-close" onClick={closeRoomPanel} title="Close room panel" />
                </div>

                <section className="inspector-group">
                  <h4>Templates</h4>
                  {linkedTemplate ? (
                    <div className="stats-card">
                      <span>Current Template</span>
                      <strong>{linkedTemplate.title}</strong>
                    </div>
                  ) : null}
                  <div className="action-grid">
                    <button onClick={saveCurrentRoomAsTemplate}>Save As Template</button>
                    {linkedTemplate ? <button onClick={updateLinkedTemplate}>Update Template</button> : null}
                  </div>
                </section>

                <section className="inspector-group">
                  <h4>Interaction</h4>
                  <label className="toggle-row room-toggle-card">
                    <span>Select Locked Objects</span>
                    <input
                      type="checkbox"
                      checked={allowSelectLocked}
                      onChange={(event) => setAllowSelectLocked(event.target.checked)}
                    />
                  </label>
                </section>

                <div className="panel-footer-action">
                  <button onClick={returnToLobby}>Return To Lobby</button>
                </div>
              </section>
            </aside>
          </div>
        ) : null}

        {isTurnPanelOpen ? (
          <div className="modal-scrim" onClick={closeTurnPanel}>
            <aside aria-modal="true" className="turn-panel" role="dialog" onClick={(event) => event.stopPropagation()}>
              <section className="turn-panel-card">
                <div className="turn-panel-header">
                  {currentPlayer ? (
                    <textarea
                      aria-label="Your player name"
                      className="drawer-title-input"
                      placeholder="Player Name"
                      rows={1}
                      spellCheck={false}
                      wrap="off"
                      value={currentPlayer.name}
                      onChange={(event) =>
                        mutate((draft) => {
                          const player = draft.players[currentPlayer.id]
                          if (player) {
                            player.name = event.target.value.replaceAll('\n', ' ')
                          }
                        })
                      }
                      onBlur={(event) =>
                        mutate((draft) => {
                          const player = draft.players[currentPlayer.id]
                          if (player) {
                            const trimmed = event.target.value.trim()
                            const fallbackIndex = Math.max(0, draft.playerOrder.indexOf(currentPlayer.id))
                            player.name = trimmed || `Player ${fallbackIndex + 1}`
                          }
                        })
                      }
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          event.currentTarget.blur()
                        }
                      }}
                    />
                  ) : (
                    <div className="turn-panel-join-copy">
                      <h2 className="turn-panel-title">Join This Room</h2>
                      <p className="field-note">Join to take turns and edit the table.</p>
                    </div>
                  )}
                  <button aria-label="Close turn panel" className="panel-close" onClick={closeTurnPanel} title="Close turn panel" />
                </div>
                {!currentPlayer ? (
                  <div className="button-row">
                    <button onClick={joinRoom}>Join Room</button>
                  </div>
                ) : null}

                <section className="inspector-group">
                  <h4>Players</h4>
                  <div className="player-list room-player-list">
                    {playerList.map((player) => (
                      <div className={`player-card ${player.id === room.turnPlayerId ? 'active-turn' : ''}`} key={player.id}>
                        <div className="player-card-copy">
                          <strong>{player.name}</strong>
                          <small>
                            {player.id === room.turnPlayerId
                              ? 'Current turn'
                              : player.id === currentPlayer?.id
                                ? 'You'
                                : 'Waiting'}
                          </small>
                        </div>
                        <div className="player-card-actions">
                          {player.id === room.turnPlayerId ? (
                            <span className="player-card-status">Active</span>
                          ) : (
                            <button className="player-card-action" disabled={!canEdit} onClick={() => mutate((draft) => setTurnPlayer(draft, player.id))}>
                              Make Active
                            </button>
                          )}
                          <button className="player-card-action" disabled={!canEdit} onClick={() => removePlayerFromRoom(player.id)}>
                            {player.id === currentPlayer?.id ? 'Leave' : 'Remove'}
                          </button>
                        </div>
                      </div>
                    ))}
                    {playerList.length === 0 ? <p className="empty-copy">Nobody has joined this room yet.</p> : null}
                  </div>
                </section>
              </section>
            </aside>
          </div>
        ) : null}

        {visibleRightPanelMode === 'selection' && selectedObject ? (
          <aside className="inspector inspector-right">
            <section className="inspector-section">
              <div className="inspector-toolbar">
                <div>
                  <p className="eyebrow">{selectedObject.type}</p>
                  <h2>{selectedObject.name}</h2>
                </div>
                <button aria-label="Close panel" className="panel-close" onClick={closeRightPanel} title="Close panel" />
              </div>

              <div className="button-row">
                <button disabled={!canEdit} onClick={() => mutate((draft) => bringObjectForward(draft, selectedObject.id))}>
                  Forward
                </button>
                <button disabled={!canEdit} onClick={() => mutate((draft) => sendObjectBackward(draft, selectedObject.id))}>
                  Back
                </button>
                <button
                  disabled={!canEdit}
                  onClick={() =>
                    mutate((draft) => {
                      const duplicateId = duplicateObject(draft, selectedObject.id)
                      if (duplicateId) {
                        updateSelection(duplicateId)
                      }
                    })
                  }
                >
                  Duplicate
                </button>
              </div>

              <label className="field">
                <span>Name</span>
                <input
                  disabled={!canEdit}
                  value={selectedObject.name}
                  onChange={(event) =>
                    mutate((draft) => {
                      draft.objects[selectedObject.id].name = event.target.value
                    })
                  }
                />
              </label>

              <label className="toggle-row">
                <span>Locked</span>
                <input
                  disabled={!canEdit}
                  type="checkbox"
                  checked={selectedObject.locked}
                  onChange={(event) =>
                    mutate((draft) => {
                      draft.objects[selectedObject.id].locked = event.target.checked
                    })
                  }
                />
              </label>

              {isCard(selectedObject) ? (
                <>
                  <div className="button-row">
                    <button disabled={!canEdit} onClick={() => mutate((draft) => flipCard(draft, selectedObject.id))}>
                      {selectedObject.meta.faceUp === false ? 'Show Face' : 'Show Back'}
                    </button>
                    <button
                      disabled={!canEdit}
                      onClick={() =>
                        mutate((draft) => {
                          ;(draft.objects[selectedObject.id] as Card).visibility = true
                        })
                      }
                    >
                      Reveal To All
                    </button>
                  </div>

                  <label className="field">
                    <span>Visibility</span>
                    <select
                      disabled={!canEdit}
                      value={selectedObject.visibility === true ? 'all' : 'limited'}
                      onChange={(event) =>
                        mutate((draft) => {
                          ;(draft.objects[selectedObject.id] as Card).visibility =
                            event.target.value === 'all' ? true : currentPlayer ? [currentPlayer.id] : []
                        })
                      }
                    >
                      <option value="all">Everyone sees the face</option>
                      <option value="limited">Only selected players see the face</option>
                    </select>
                  </label>

                  {selectedObject.visibility !== true ? (
                    <div className="player-visibility-list">
                      {playerList.map((player) => {
                        const checked = selectedObject.visibility !== true && selectedObject.visibility.includes(player.id)
                        return (
                          <label className="toggle-row" key={player.id}>
                            <span>{player.name}</span>
                            <input
                              disabled={!canEdit}
                              type="checkbox"
                              checked={checked}
                              onChange={() =>
                                mutate((draft) => {
                                  const card = draft.objects[selectedObject.id] as Card
                                  const current = card.visibility === true ? [] : [...card.visibility]
                                  card.visibility = checked
                                    ? current.filter((playerId) => playerId !== player.id)
                                    : [...current, player.id]
                                })
                              }
                            />
                          </label>
                        )
                      })}
                    </div>
                  ) : null}

                  <div className="preview-note">
                    Normal view: {canSeeCardFace(selectedObject, currentPlayer?.id) ? 'face visible' : 'back only'}
                  </div>

                  <SpriteEditor
                    label="Face"
                    value={selectedObject.face}
                    disabled={!canEdit}
                    onChange={(next) =>
                      mutate((draft) => {
                        ;(draft.objects[selectedObject.id] as Card).face = next
                      })
                    }
                  />
                  <SpriteEditor
                    label="Back"
                    value={selectedObject.back}
                    disabled={!canEdit}
                    onChange={(next) =>
                      mutate((draft) => {
                        ;(draft.objects[selectedObject.id] as Card).back = next
                      })
                    }
                  />
                </>
              ) : null}

              {isDeck(selectedObject) ? (
                <>
                  <div className="stats-card">
                    <span>Cards</span>
                    <strong>{selectedObject.childIds.length}</strong>
                  </div>
                  <div className="button-row">
                    <button disabled={!canEdit} onClick={() => mutate((draft) => flipDeck(draft, selectedObject.id))}>
                      Flip Deck
                    </button>
                    <button disabled={!canEdit} onClick={() => mutate((draft) => shuffleDeck(draft, selectedObject.id))}>
                      Shuffle
                    </button>
                    <button disabled={!canEdit} onClick={() => mutate((draft) => drawFromDeck(draft, selectedObject.id))}>
                      Draw Top Card
                    </button>
                  </div>
                </>
              ) : null}

              {isBoard(selectedObject) ? (
                <>
                  <div className="button-row">
                    <button disabled={!canEdit} onClick={() => mutate((draft) => flipBoard(draft, selectedObject.id))}>
                      {selectedObject.meta.faceUp === false ? 'Show Face' : 'Show Back'}
                    </button>
                  </div>

                  <BoardSizeEditor
                    width={selectedObject.size.width}
                    height={selectedObject.size.height}
                    disabled={!canEdit}
                    onCommitWidth={async (width) => {
                      const board = room.objects[selectedObject.id]
                      if (!isBoard(board)) {
                        return
                      }

                      const aspectRatio = await resolveBoardResizeAspectRatio(board)
                      mutate((draft) => {
                        const nextBoard = draft.objects[selectedObject.id]
                        if (isBoard(nextBoard)) {
                          nextBoard.size.width = width
                          nextBoard.size.height = Math.max(48, Math.round(width / aspectRatio))
                        }
                      })
                    }}
                    onCommitHeight={async (height) => {
                      const board = room.objects[selectedObject.id]
                      if (!isBoard(board)) {
                        return
                      }

                      const aspectRatio = await resolveBoardResizeAspectRatio(board)
                      mutate((draft) => {
                        const nextBoard = draft.objects[selectedObject.id]
                        if (isBoard(nextBoard)) {
                          nextBoard.size.width = Math.max(48, Math.round(height * aspectRatio))
                          nextBoard.size.height = height
                        }
                      })
                    }}
                  />

                  <SpriteEditor
                    label="Face"
                    value={selectedObject.face}
                    disabled={!canEdit}
                    onChange={(next) =>
                      mutate((draft) => {
                        const board = draft.objects[selectedObject.id]
                        if (isBoard(board)) {
                          board.face = next
                        }
                      })
                    }
                  />
                  <SpriteEditor
                    label="Back"
                    value={selectedObject.back}
                    disabled={!canEdit}
                    onChange={(next) =>
                      mutate((draft) => {
                        const board = draft.objects[selectedObject.id]
                        if (isBoard(board)) {
                          board.back = next
                        }
                      })
                    }
                  />
                </>
              ) : null}

              <MetaEditor
                key={`${selectedObject.id}:${JSON.stringify(selectedObject.meta)}`}
                object={selectedObject}
                disabled={!canEdit}
                onCommit={(meta) =>
                  mutate((draft) => {
                    draft.objects[selectedObject.id].meta = meta
                  })
                }
              />

              <div className="button-row">
                <button
                  className="danger"
                  disabled={!canEdit}
                  onClick={() =>
                    mutate((draft) => {
                      deleteObject(draft, selectedObject.id)
                      updateSelection(undefined)
                    })
                  }
                >
                  Delete
                </button>
              </div>
            </section>
          </aside>
        ) : null}

        {canEdit ? (
          isGroupSelectionMode ? (
            <div className="creation-dock selection-dock">
              <div className="selection-tray">
                <strong>{groupSelectionIds.length} selected</strong>
                <div className="selection-tray-actions">
                  <button
                    className={`selection-tool-button ${isLassoMode ? 'active' : ''}`}
                    onClick={() => setIsLassoMode((current) => !current)}
                  >
                    Lasso
                  </button>
                  <button
                    aria-label="Exit selection mode"
                    className="selection-tool-button selection-close-button"
                    onClick={exitGroupSelectionMode}
                    title="Exit selection mode"
                  >
                    ×
                  </button>
                </div>
              </div>
            </div>
          ) : isAddMenuOpen ? (
            <div className="modal-scrim" onClick={() => setIsAddMenuOpen(false)}>
              <div className="creation-dock" onClick={(event) => event.stopPropagation()}>
                <section aria-modal="true" className="creation-menu" role="dialog">
                  <div className="section-copy">
                    <h4>Add To Table</h4>
                    <p className="field-note">Quick create on the board or open an import flow.</p>
                  </div>

                  <section className="creation-menu-section">
                    <h4>Quick Create</h4>
                    <div className="action-grid">
                      <button onClick={createCardHere}>Card</button>
                      <button onClick={createDeckHere}>Deck</button>
                      <button onClick={createBoardHere}>Board</button>
                    </div>
                  </section>

                  <section className="creation-menu-section">
                    <h4>Imports</h4>
                    <div className="action-grid">
                      <button onClick={() => openCreationFlow('board')}>Board From Image</button>
                      <button onClick={() => openCreationFlow('deck-sheet')}>Deck From Sheet</button>
                    </div>
                  </section>
                </section>

                <button
                  aria-label="Close add menu"
                  className="add-button active"
                  onClick={toggleAddMenu}
                  title="Close add menu"
                >
                  <span aria-hidden="true" className="add-button-glyph">+</span>
                </button>
                <button className="dock-mode-button" onClick={enterGroupSelectionMode}>
                  Select
                </button>
              </div>
            </div>
          ) : (
            <div className="creation-dock dock-row">
              <button
                aria-label="Open add menu"
                className="add-button"
                onClick={toggleAddMenu}
                title="Open add menu"
              >
                <span aria-hidden="true" className="add-button-glyph">+</span>
              </button>
              <button className="dock-mode-button" onClick={enterGroupSelectionMode}>
                Select
              </button>
            </div>
          )
        ) : null}

        {creationMode ? (
          <div className="modal-scrim">
            <section className="modal-card">
              <div className="inspector-toolbar">
                <div>
                  <p className="eyebrow">Create</p>
                  <h2>{creationMode === 'board' ? 'Board From Image' : 'Deck From Sprite Sheet'}</h2>
                </div>
                <button aria-label="Close creation flow" className="panel-close" onClick={closeCreationFlow} title="Close creation flow" />
              </div>

              {creationMode === 'board' ? (
                <div className="creation-flow">
                  <label className="field">
                    <span>Board Name</span>
                    <input
                      disabled={!canEdit}
                      value={boardDraft.name}
                      onChange={(event) =>
                        setBoardDraft((current) => ({
                          ...current,
                          name: event.target.value,
                        }))
                      }
                      placeholder="Board"
                    />
                  </label>

                  <label className="field">
                    <span>Face Image URL</span>
                    <input
                      disabled={!canEdit}
                      type="url"
                      value={boardDraft.faceUrl}
                      onChange={(event) =>
                        setBoardDraft((current) => ({
                          ...current,
                          faceUrl: event.target.value,
                        }))
                      }
                      placeholder="https://example.com/board.png"
                    />
                  </label>

                  <label className="field">
                    <span>Back Image URL</span>
                    <input
                      disabled={!canEdit}
                      type="url"
                      value={boardDraft.backUrl}
                      onChange={(event) =>
                        setBoardDraft((current) => ({
                          ...current,
                          backUrl: event.target.value,
                        }))
                      }
                      placeholder="Optional"
                    />
                  </label>

                  <p className="field-note">
                    The board size is derived from the face image aspect ratio and starts locked by default.
                  </p>

                  <div className="button-row">
                    <button disabled={!canEdit} onClick={() => void createBoardFromImage()}>
                      Create Board From Image
                    </button>
                    <button disabled={!canEdit} onClick={createBoardHere}>
                      Blank Board
                    </button>
                  </div>
                  {boardDraftError ? <p className="inline-error">{boardDraftError}</p> : null}
                </div>
              ) : (
                <div className="creation-flow">
                  <label className="field">
                    <span>Deck Name</span>
                    <input
                      disabled={!canEdit}
                      value={sheetDeckDraft.name}
                      onChange={(event) =>
                        setSheetDeckDraft((current) => ({
                          ...current,
                          name: event.target.value,
                        }))
                      }
                      placeholder="Imported Deck"
                    />
                  </label>

                  <label className="field">
                    <span>Face Sheet URL</span>
                    <input
                      disabled={!canEdit}
                      type="url"
                      value={sheetDeckDraft.faceUrl}
                      onChange={(event) =>
                        setSheetDeckDraft((current) => ({
                          ...current,
                          faceUrl: event.target.value,
                        }))
                      }
                      placeholder="https://example.com/cards.png"
                    />
                  </label>

                  <div className="sheet-grid">
                    <label className="field">
                      <span>Rows</span>
                      <input
                        disabled={!canEdit}
                        inputMode="numeric"
                        value={sheetDeckDraft.faceRows}
                        onChange={(event) =>
                          setSheetDeckDraft((current) => ({
                            ...current,
                            faceRows: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <label className="field">
                      <span>Cols</span>
                      <input
                        disabled={!canEdit}
                        inputMode="numeric"
                        value={sheetDeckDraft.faceCols}
                        onChange={(event) =>
                          setSheetDeckDraft((current) => ({
                            ...current,
                            faceCols: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <label className="field">
                      <span>Cards</span>
                      <input
                        disabled={!canEdit}
                        inputMode="numeric"
                        value={sheetDeckDraft.faceCount}
                        onChange={(event) =>
                          setSheetDeckDraft((current) => ({
                            ...current,
                            faceCount: event.target.value,
                          }))
                        }
                        placeholder={facePreviewCount ? String(facePreviewCount) : 'auto'}
                      />
                    </label>
                  </div>
                  <p className="field-note">
                    Faces fill left to right, top to bottom. Blank card count defaults to rows × cols.
                  </p>

                  <label className="field">
                    <span>Back Sheet URL</span>
                    <input
                      disabled={!canEdit}
                      type="url"
                      value={sheetDeckDraft.backUrl}
                      onChange={(event) =>
                        setSheetDeckDraft((current) => ({
                          ...current,
                          backUrl: event.target.value,
                        }))
                      }
                      placeholder="Optional"
                    />
                  </label>

                  <div className="sheet-grid">
                    <label className="field">
                      <span>Rows</span>
                      <input
                        disabled={!canEdit}
                        inputMode="numeric"
                        value={sheetDeckDraft.backRows}
                        onChange={(event) =>
                          setSheetDeckDraft((current) => ({
                            ...current,
                            backRows: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <label className="field">
                      <span>Cols</span>
                      <input
                        disabled={!canEdit}
                        inputMode="numeric"
                        value={sheetDeckDraft.backCols}
                        onChange={(event) =>
                          setSheetDeckDraft((current) => ({
                            ...current,
                            backCols: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <label className="field">
                      <span>Backs</span>
                      <input
                        disabled={!canEdit}
                        inputMode="numeric"
                        value={sheetDeckDraft.backCount}
                        onChange={(event) =>
                          setSheetDeckDraft((current) => ({
                            ...current,
                            backCount: event.target.value,
                          }))
                        }
                        placeholder={backPreviewCount ? String(backPreviewCount) : 'auto'}
                      />
                    </label>
                  </div>
                  <p className="field-note">
                    If there are fewer backs than faces, the backs cycle through the deck.
                  </p>

                  <div className="button-row">
                    <button disabled={!canEdit} onClick={() => void createDeckFromSheet()}>
                      Create Deck From Sheet
                    </button>
                  </div>
                  {sheetDeckError ? <p className="inline-error">{sheetDeckError}</p> : null}
                </div>
              )}
            </section>
          </div>
        ) : null}
      </div>
    </div>
  )
}
