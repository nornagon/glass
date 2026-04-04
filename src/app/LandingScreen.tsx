import { useMemo, useState } from 'react'
import type { RoomDoc, RoomTemplateEntry } from '../model/types'
import { deleteRoomTemplate, loadRoomHistory, loadRoomTemplates, renameRoomTemplate, saveJoinedPlayerId } from '../model/local'
import { repo, roomHash, parseRoomReference } from '../model/repo'
import { createPlayerId, createRoomDoc, renameOrAddPlayer } from '../model/room'

type LandingMode = 'root' | 'create' | 'join'

const BUILTIN_ROOM_TEMPLATES = [
  {
    id: 'empty',
    eyebrow: 'Default',
    title: 'Empty Room',
    description: 'Start with a blank table and add cards or decks as you play.',
    create: () => createRoomDoc(),
  },
]

function cloneTemplateRoom(room: RoomDoc) {
  return JSON.parse(JSON.stringify(room)) as RoomDoc
}

function openRoom(roomUrl: string) {
  window.location.hash = roomHash(roomUrl)
}

export function LandingScreen() {
  const [mode, setMode] = useState<LandingMode>('root')
  const [joinValue, setJoinValue] = useState('')
  const [joinError, setJoinError] = useState('')
  const [savedTemplates, setSavedTemplates] = useState<RoomTemplateEntry[]>(() => loadRoomTemplates())
  const [activeTemplateMenuId, setActiveTemplateMenuId] = useState<string>()
  const roomHistory = useMemo(() => loadRoomHistory(), [])

  function refreshTemplates() {
    setSavedTemplates(loadRoomTemplates())
  }

  function createFromTemplate(templateId: string) {
    const builtInTemplate = BUILTIN_ROOM_TEMPLATES.find((entry) => entry.id === templateId)
    const savedTemplate = savedTemplates.find((entry) => entry.id === templateId)

    const template = builtInTemplate
      ? {
          title: builtInTemplate.title,
          create: builtInTemplate.create,
        }
      : savedTemplate
        ? {
            title: savedTemplate.title,
            create: () => cloneTemplateRoom(savedTemplate.room),
          }
        : undefined

    if (!template) {
      return
    }

    const room = template.create()
    if (room.objects[room.rootId]?.type === 'plane') {
      room.objects[room.rootId].name = template.title
    }
    const playerId = createPlayerId()
    renameOrAddPlayer(room, playerId)

    const handle = repo.create<RoomDoc>(room)
    saveJoinedPlayerId(handle.url, playerId)
    openRoom(handle.url)
  }

  function joinFromInput() {
    const roomUrl = parseRoomReference(joinValue)
    if (!roomUrl) {
      setJoinError('Enter a valid room id or shared room link.')
      return
    }

    setJoinError('')
    openRoom(roomUrl)
  }

  function renameTemplate(template: RoomTemplateEntry) {
    const nextTitle = window.prompt('Rename template', template.title)?.trim()
    if (!nextTitle) {
      return
    }

    renameRoomTemplate(template.id, nextTitle)
    refreshTemplates()
    setActiveTemplateMenuId(undefined)
  }

  function removeTemplate(template: RoomTemplateEntry) {
    const confirmed = window.confirm(`Delete template "${template.title}"?`)
    if (!confirmed) {
      return
    }

    deleteRoomTemplate(template.id)
    refreshTemplates()
    setActiveTemplateMenuId(undefined)
  }

  return (
    <main className="landing-shell">
      <section className="landing-hero">
        <p className="eyebrow">Glass Sandbox</p>
        <h1>Tabletop rooms, without setup friction.</h1>
        <p className="landing-copy">
          Create a fresh board, rejoin a room you were already playing in, or paste a shared room id to jump in.
        </p>
      </section>

      {mode === 'root' ? (
        <section className="landing-card landing-choice-grid">
          <button className="landing-choice" onClick={() => setMode('create')}>
            <p className="eyebrow">Start Fresh</p>
            <strong>Create Room</strong>
            <span>Pick a room template and open a new board.</span>
          </button>
          <button className="landing-choice" onClick={() => setMode('join')}>
            <p className="eyebrow">Return Or Paste</p>
            <strong>Join Room</strong>
            <span>See your recent rooms or enter a shared room id.</span>
          </button>
        </section>
      ) : null}

      {mode === 'create' ? (
        <section className="landing-card">
          <div className="landing-section-header">
            <div>
              <p className="eyebrow">Templates</p>
              <h2>Create Room</h2>
            </div>
            <button onClick={() => setMode('root')}>Back</button>
          </div>

          <section className="landing-subsection">
            <div className="landing-section-header compact">
              <div>
                <p className="eyebrow">Built In</p>
                <h3>Starter Templates</h3>
              </div>
            </div>
            <div className="template-list">
              {BUILTIN_ROOM_TEMPLATES.map((template) => (
                <div className="template-card" key={template.id}>
                  <div className="template-card-copy">
                    <p className="eyebrow">{template.eyebrow}</p>
                    <strong>{template.title}</strong>
                    <span>{template.description}</span>
                  </div>
                  <div className="template-card-actions">
                    <button onClick={() => createFromTemplate(template.id)}>Create Room</button>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="landing-subsection">
            <div className="landing-section-header compact">
              <div>
                <p className="eyebrow">Saved</p>
                <h3>Your Templates</h3>
              </div>
            </div>
            <div className="template-list">
              {savedTemplates.map((template) => {
                const objectCount = Object.keys(template.room.objects).length - 1
                const menuOpen = activeTemplateMenuId === template.id
                return (
                  <div className="template-card template-card-saved" key={template.id}>
                    <div className="template-card-copy">
                      <p className="eyebrow">Saved</p>
                      <strong>{template.title}</strong>
                      <span>
                        {objectCount} objects, updated {new Date(template.savedAt).toLocaleDateString()}.
                      </span>
                    </div>
                    <div className="template-card-actions">
                      <button onClick={() => createFromTemplate(template.id)}>Create Room</button>
                      <button
                        className={`template-manage ${menuOpen ? 'active' : ''}`}
                        onClick={() => setActiveTemplateMenuId((current) => (current === template.id ? undefined : template.id))}
                      >
                        ...
                      </button>
                    </div>
                    {menuOpen ? (
                      <div className="template-menu">
                        <button onClick={() => renameTemplate(template)}>Rename</button>
                        <button className="danger" onClick={() => removeTemplate(template)}>
                          Delete
                        </button>
                      </div>
                    ) : null}
                  </div>
                )
              })}
              {savedTemplates.length === 0 ? <p className="empty-copy">No saved templates yet.</p> : null}
            </div>
          </section>
        </section>
      ) : null}

      {mode === 'join' ? (
        <section className="landing-card">
          <div className="landing-section-header">
            <div>
              <p className="eyebrow">Return To Table</p>
              <h2>Join Room</h2>
            </div>
            <button onClick={() => setMode('root')}>Back</button>
          </div>

          <label className="field">
            <span>Room ID Or Link</span>
            <input
              value={joinValue}
              onChange={(event) => {
                setJoinValue(event.target.value)
                if (joinError) {
                  setJoinError('')
                }
              }}
              placeholder="Paste a shared room link or automerge room id"
            />
          </label>
          <div className="button-row">
            <button onClick={joinFromInput}>Join Room</button>
          </div>
          {joinError ? <p className="inline-error">{joinError}</p> : null}

          <section className="landing-subsection">
            <div className="landing-section-header compact">
              <div>
                <p className="eyebrow">History</p>
                <h3>Previously Joined Rooms</h3>
              </div>
            </div>
            <div className="room-list">
              {roomHistory.map((entry) => (
                <button className="room-list-item" key={entry.roomUrl} onClick={() => openRoom(entry.roomUrl)}>
                  <span>{entry.title}</span>
                  <small>{new Date(entry.lastOpenedAt).toLocaleString()}</small>
                </button>
              ))}
              {roomHistory.length === 0 ? <p className="empty-copy">No rooms have been opened on this device yet.</p> : null}
            </div>
          </section>
        </section>
      ) : null}
    </main>
  )
}
