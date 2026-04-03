import {
  useDocument,
  useRepo,
  type AutomergeUrl,
} from '@automerge/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { BoardView } from '../board/BoardView'
import { syncTurnBadge } from './badge'
import { loadRoomHistory, loadJoinedPlayerId, loadCameraState, saveCameraState, saveJoinedPlayerId, saveRoomHistoryEntry } from '../model/local'
import {
  addCardToDeck,
  advanceTurn,
  canSeeCardFace,
  createCardOnPlane,
  createDeckOnPlane,
  createPlayerId,
  createRoomDoc,
  deleteObject,
  drawFromDeck,
  duplicateObject,
  flipCard,
  formatRoomTitle,
  getRootPlane,
  isCard,
  isDeck,
  renameOrAddPlayer,
  rootPlaneLabel,
  sendObjectBackward,
  setTurnPlayer,
  shuffleDeck,
  bringObjectForward,
  moveObject,
} from '../model/room'
import type { CameraState, Card, GameObject, RoomDoc, SpriteSpec } from '../model/types'
import { roomHash } from '../model/repo'

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
  const repo = useRepo()
  const [room, changeRoom] = useDocument<RoomDoc>(roomUrl, { suspense: true })
  const [selectedId, setSelectedId] = useState<string>()
  const [joinedPlayerId, setJoinedPlayerId] = useState<string | undefined>(() => loadJoinedPlayerId(roomUrl))
  const [showRooms, setShowRooms] = useState(false)
  const [camera, setCamera] = useState<CameraState>(() => loadCameraState(roomUrl) ?? DEFAULT_CAMERA)
  const spawnCountRef = useRef(0)
  const selectedObject = selectedId ? room.objects[selectedId] : undefined
  const currentPlayer = joinedPlayerId ? room.players[joinedPlayerId] : undefined
  const canEdit = Boolean(currentPlayer)
  const roomTitle = formatRoomTitle(room)
  const roomHistory = loadRoomHistory()

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

  function createNewRoom() {
    const handle = repo.create<RoomDoc>(createRoomDoc())
    window.location.hash = roomHash(handle.url)
  }

  async function copyRoomLink() {
    await navigator.clipboard.writeText(currentOriginUrl(roomUrl))
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

  const turnPlayer = room.turnPlayerId ? room.players[room.turnPlayerId] : undefined

  return (
    <div className="app-shell">
      <main className="board-shell">
        <BoardView
          key={roomUrl}
          room={room}
          roomUrl={roomUrl}
          selectedId={selectedObject?.id}
          currentPlayerId={currentPlayer?.id}
          canEdit={canEdit}
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
          onDropCardToDeck={(cardId, deckId) =>
            mutate((draft) => {
              addCardToDeck(draft, cardId, deckId)
            })
          }
          onFlipCard={(cardId) =>
            mutate((draft) => {
              flipCard(draft, cardId)
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
          onDeleteObject={(objectId) =>
            mutate((draft) => {
              deleteObject(draft, objectId)
              if (selectedId === objectId) {
                setSelectedId(undefined)
              }
            })
          }
        />
      </main>

      <div className="overlay-layer">
        <header className="topbar">
          <div className="topbar-cluster">
            <button onClick={createNewRoom}>New Room</button>
            <button onClick={() => void copyRoomLink()}>Share</button>
            <button onClick={() => setShowRooms((current) => !current)}>
              {showRooms ? 'Board' : 'Rooms'}
            </button>
          </div>
          <div className="topbar-title">
            <p className="eyebrow">Glass Sandbox</p>
            <h1>{roomTitle}</h1>
          </div>
          <div className="topbar-cluster align-end">
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

        <aside className="inspector">
          {showRooms ? (
            <section className="inspector-section">
              <div className="section-header">
                <div>
                  <p className="eyebrow">Recent Rooms</p>
                  <h2>Room Index</h2>
                </div>
              </div>
              <div className="room-list">
                {roomHistory.map((entry) => (
                  <button
                    className={`room-list-item ${entry.roomUrl === roomUrl ? 'current' : ''}`}
                    key={entry.roomUrl}
                    onClick={() => {
                      window.location.hash = roomHash(entry.roomUrl)
                    }}
                  >
                    <span>{entry.title}</span>
                    <small>{new Date(entry.lastOpenedAt).toLocaleString()}</small>
                  </button>
                ))}
              </div>
            </section>
          ) : selectedObject ? (
            <section className="inspector-section">
              <div className="section-header">
                <div>
                  <p className="eyebrow">{selectedObject.type}</p>
                  <h2>{selectedObject.name}</h2>
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
                          setSelectedId(duplicateId)
                        }
                      })
                    }
                  >
                    Duplicate
                  </button>
                </div>
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
                    <button disabled={!canEdit} onClick={() => mutate((draft) => shuffleDeck(draft, selectedObject.id))}>
                      Shuffle
                    </button>
                    <button disabled={!canEdit} onClick={() => mutate((draft) => drawFromDeck(draft, selectedObject.id))}>
                      Draw Top Card
                    </button>
                  </div>
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
            </section>
          ) : (
            <section className="inspector-section">
              <div className="section-header">
                <div>
                  <p className="eyebrow">Room</p>
                  <h2>{roomTitle}</h2>
                </div>
                <div className={`presence-pill ${canEdit ? 'active' : ''}`}>
                  {canEdit ? `Editing as ${currentPlayer?.name}` : 'Observe only'}
                </div>
              </div>

              <label className="field">
                <span>Table Name</span>
                <input
                  disabled={!canEdit}
                  value={rootPlaneLabel(room)}
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

              <section className="inspector-group">
                <h4>Selection Help</h4>
                <ul className="hint-list">
                  <li>Drag the empty table to pan. Pinch or wheel to zoom.</li>
                  <li>Tap a card or deck to inspect it.</li>
                  <li>Drag cards onto decks to stack them.</li>
                  <li>Hidden faces are honor-system only and still editable here.</li>
                </ul>
              </section>
            </section>
          )}
        </aside>
      </div>
    </div>
  )
}
