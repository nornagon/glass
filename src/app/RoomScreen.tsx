import {
  useDocument,
  type AutomergeUrl,
} from '@automerge/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { BoardView } from '../board/BoardView'
import { syncTurnBadge } from './badge'
import { loadJoinedPlayerId, loadCameraState, loadRoomTemplates, saveCameraState, saveJoinedPlayerId, saveRoomHistoryEntry, saveRoomTemplate } from '../model/local'
import {
  addCardToDeck,
  advanceTurn,
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
} from '../model/room'
import type { CameraState, Card, GameObject, RoomDoc, SpriteSpec } from '../model/types'
import { roomHash } from '../model/repo'
import { DEFAULT_BOARD_SIZE, DEFAULT_CARD_SIZE } from '../model/types'

const DEFAULT_CAMERA: CameraState = {
  centerX: 0,
  centerY: 0,
  zoom: 1,
}

function currentOriginUrl(roomUrl: string) {
  return `${window.location.origin}${window.location.pathname}${roomHash(roomUrl)}`
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

type PanelMode = 'room' | 'selection'
type CreationMode = 'board' | 'deck-sheet'

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

export function RoomScreen({ roomUrl }: { roomUrl: AutomergeUrl }) {
  return <RoomScreenInner key={roomUrl} roomUrl={roomUrl} />
}

function RoomScreenInner({ roomUrl }: { roomUrl: AutomergeUrl }) {
  const [room, changeRoom] = useDocument<RoomDoc>(roomUrl, { suspense: true })
  const [selectedId, setSelectedId] = useState<string>()
  const [joinedPlayerId, setJoinedPlayerId] = useState<string | undefined>(() => loadJoinedPlayerId(roomUrl))
  const [panelMode, setPanelMode] = useState<PanelMode | undefined>()
  const [creationMode, setCreationMode] = useState<CreationMode | undefined>()
  const [camera, setCamera] = useState<CameraState>(() => loadCameraState(roomUrl) ?? DEFAULT_CAMERA)
  const [allowSelectLocked, setAllowSelectLocked] = useState(false)
  const [boardDraft, setBoardDraft] = useState<BoardDraft>(() => defaultBoardDraft())
  const [boardDraftError, setBoardDraftError] = useState('')
  const [sheetDeckDraft, setSheetDeckDraft] = useState<SheetDeckDraft>(() => defaultSheetDeckDraft())
  const [sheetDeckError, setSheetDeckError] = useState('')
  const spawnCountRef = useRef(0)
  const selectedObject = selectedId ? room.objects[selectedId] : undefined
  const boardSelectedId = selectedObject?.id
  const visiblePanelMode = panelMode === 'selection' && !selectedObject ? undefined : panelMode
  const currentPlayer = joinedPlayerId ? room.players[joinedPlayerId] : undefined
  const canEdit = Boolean(currentPlayer)
  const roomTitle = formatRoomTitle(room)
  const linkedTemplate = room.sourceTemplateId ? loadRoomTemplates().find((template) => template.id === room.sourceTemplateId) : undefined

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

  function mutate(change: (draft: RoomDoc) => void) {
    if (!canEdit) {
      return
    }
    changeRoom(change)
  }

  async function copyRoomLink() {
    await navigator.clipboard.writeText(currentOriginUrl(roomUrl))
  }

  function toggleRoomPanel() {
    setPanelMode((current) => (current === 'room' ? undefined : 'room'))
  }

  function openSelectionPanel() {
    if (selectedObject) {
      setPanelMode('selection')
    }
  }

  function closePanel() {
    setPanelMode(undefined)
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

  function renamePlayer() {
    if (!currentPlayer) {
      return
    }
    const next = window.prompt('Rename your player', currentPlayer.name)?.trim()
    if (!next) {
      return
    }
    mutate((draft) => {
      renameOrAddPlayer(draft, currentPlayer.id, next)
    })
  }

  function createCardHere() {
    const offset = spawnCountRef.current++
    mutate((draft) => {
      createCardOnPlane(draft, draft.rootId, nextSpawnTransform(camera, offset))
    })
  }

  function createDeckHere() {
    const offset = spawnCountRef.current++
    mutate((draft) => {
      createDeckOnPlane(draft, draft.rootId, nextSpawnTransform(camera, offset))
    })
  }

  function createBoardHere() {
    const offset = spawnCountRef.current++
    let createdBoardId: string | undefined
    mutate((draft) => {
      createdBoardId = createBoardOnPlane(draft, draft.rootId, nextSpawnTransform(camera, offset))
    })

    if (createdBoardId) {
      setSelectedId(createdBoardId)
      setPanelMode('selection')
      setCreationMode(undefined)
    }
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
    setSelectedId(createdBoardId)
    setPanelMode('selection')
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

    setSelectedId(createdDeckId)
    setSheetDeckError('')
    setSheetDeckDraft(defaultSheetDeckDraft())
    setCreationMode(undefined)
  }

  const turnPlayer = room.turnPlayerId ? room.players[room.turnPlayerId] : undefined
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
          selectedId={boardSelectedId}
          currentPlayerId={currentPlayer?.id}
          canEdit={canEdit}
          allowSelectLocked={allowSelectLocked}
          initialCamera={camera}
          onCameraChange={(next) => {
            setCamera(next)
            saveCameraState(roomUrl, next)
          }}
          onSelect={setSelectedId}
          onCommitTransform={(objectId, transform) =>
            mutate((draft) => {
              moveObject(draft, objectId, transform)
            })
          }
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
              setSelectedId(deckId)
            }
          }}
          onLiftTopCardFromDeck={(deckId) => {
            let liftedCardId: string | undefined
            mutate((draft) => {
              liftedCardId = liftTopCardFromDeck(draft, deckId)
            })
            if (liftedCardId) {
              setSelectedId(liftedCardId)
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
          <button
            className={`topbar-title topbar-title-button ${panelMode === 'room' ? 'active' : ''}`}
            onClick={toggleRoomPanel}
          >
            <p className="eyebrow">Glass Sandbox</p>
            <h1>{roomTitle}</h1>
          </button>
          <div className="topbar-cluster topbar-actions">
            <div className="turn-pill">
              <span>Turn</span>
              <strong>{turnPlayer?.name ?? 'Unset'}</strong>
            </div>
            {currentPlayer ? (
              <button className="join-button active" onClick={renamePlayer}>
                {currentPlayer.name}
              </button>
            ) : (
              <button className="join-button" onClick={joinRoom}>
                Join Room
              </button>
            )}
          </div>
        </header>

        {visiblePanelMode && (visiblePanelMode !== 'selection' || selectedObject) ? (
          <aside className="inspector">
            <section className="inspector-section">
              <div className="inspector-toolbar">
                {visiblePanelMode === 'selection' && selectedObject ? (
                  <div>
                    <p className="eyebrow">{selectedObject.type}</p>
                    <h2>{selectedObject.name}</h2>
                  </div>
                ) : (
                  <div>
                    <p className="eyebrow">Room</p>
                    <h2>{roomTitle}</h2>
                  </div>
                )}
                <button className="panel-close" onClick={closePanel}>
                  Close
                </button>
              </div>

              {visiblePanelMode === 'selection' && selectedObject ? (
                <>
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
                            setSelectedId(duplicateId)
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

                      <div className="field-row">
                        <label className="field">
                          <span>Width</span>
                          <input
                            disabled={!canEdit}
                            type="number"
                            min="48"
                            step="1"
                            value={selectedObject.size.width}
                            onChange={(event) =>
                              mutate((draft) => {
                                const width = Math.max(48, Number.parseInt(event.target.value, 10) || 48)
                                const board = draft.objects[selectedObject.id]
                                if (isBoard(board)) {
                                  board.size.width = width
                                }
                              })
                            }
                          />
                        </label>
                        <label className="field">
                          <span>Height</span>
                          <input
                            disabled={!canEdit}
                            type="number"
                            min="48"
                            step="1"
                            value={selectedObject.size.height}
                            onChange={(event) =>
                              mutate((draft) => {
                                const height = Math.max(48, Number.parseInt(event.target.value, 10) || 48)
                                const board = draft.objects[selectedObject.id]
                                if (isBoard(board)) {
                                  board.size.height = height
                                }
                              })
                            }
                          />
                        </label>
                      </div>

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
                          setSelectedId(undefined)
                        })
                      }
                    >
                      Delete
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className={`presence-pill ${canEdit ? 'active' : ''}`}>
                    {canEdit ? `Editing as ${currentPlayer?.name}` : 'Observe only'}
                  </div>

                  <label className="toggle-row">
                    <span>Select Locked Objects</span>
                    <input
                      type="checkbox"
                      checked={allowSelectLocked}
                      onChange={(event) => setAllowSelectLocked(event.target.checked)}
                    />
                  </label>

                  <div className="button-row">
                    <button onClick={() => void copyRoomLink()}>Share</button>
                    <button onClick={saveCurrentRoomAsTemplate}>Save As New Template</button>
                    {linkedTemplate ? <button onClick={updateLinkedTemplate}>Update Template</button> : null}
                    <button onClick={returnToLobby}>Return To Lobby</button>
                  </div>

                  <label className="field">
                    <span>Table Name</span>
                    <input
                      disabled={!canEdit}
                      value={getRootPlane(room).name}
                      onChange={(event) =>
                        mutate((draft) => {
                          getRootPlane(draft).name = event.target.value
                        })
                      }
                    />
                  </label>

                  <div className="button-row">
                    <button disabled={!canEdit} onClick={createCardHere}>
                      Create Card
                    </button>
                    <button disabled={!canEdit} onClick={createDeckHere}>
                      Create Deck
                    </button>
                    <button disabled={!canEdit} onClick={() => mutate((draft) => advanceTurn(draft))}>
                      Advance Turn
                    </button>
                  </div>

                  <section className="inspector-group">
                    <h4>Create Components</h4>
                    <div className="button-row">
                      <button disabled={!canEdit} onClick={() => setCreationMode('board')}>
                        Board From Image
                      </button>
                      <button disabled={!canEdit} onClick={() => setCreationMode('deck-sheet')}>
                        Deck From Sheet
                      </button>
                    </div>
                  </section>

                  <section className="inspector-group">
                    <h4>Players</h4>
                    <div className="player-list">
                      {playerList.map((player) => (
                        <div className="player-card" key={player.id}>
                          <div>
                            <strong>{player.name}</strong>
                            <small>{player.id === room.turnPlayerId ? 'Current turn' : 'Waiting'}</small>
                          </div>
                          <button disabled={!canEdit} onClick={() => mutate((draft) => setTurnPlayer(draft, player.id))}>
                            Make Active
                          </button>
                        </div>
                      ))}
                      {playerList.length === 0 ? <p className="empty-copy">Nobody has joined this room yet.</p> : null}
                    </div>
                  </section>
                </>
              )}
            </section>
          </aside>
        ) : null}

        {creationMode ? (
          <div className="modal-scrim">
            <section className="modal-card">
              <div className="inspector-toolbar">
                <div>
                  <p className="eyebrow">Create</p>
                  <h2>{creationMode === 'board' ? 'Board From Image' : 'Deck From Sprite Sheet'}</h2>
                </div>
                <button className="panel-close" onClick={closeCreationFlow}>
                  Close
                </button>
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
