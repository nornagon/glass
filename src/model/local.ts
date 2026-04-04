import type { CameraState, RoomDoc, RoomHistoryEntry, RoomTemplateEntry } from './types'

const ROOM_HISTORY_KEY = 'glass.room-history'
const ROOM_TEMPLATES_KEY = 'glass.room-templates'
const CAMERA_PREFIX = 'glass.camera.'
const PLAYER_PREFIX = 'glass.player.'

function canUseStorage(storage: Storage | undefined) {
  return typeof window !== 'undefined' && storage
}

export function loadRoomHistory() {
  if (!canUseStorage(window.localStorage)) {
    return [] as RoomHistoryEntry[]
  }

  try {
    const raw = window.localStorage.getItem(ROOM_HISTORY_KEY)
    return raw ? (JSON.parse(raw) as RoomHistoryEntry[]) : []
  } catch {
    return []
  }
}

export function saveRoomHistoryEntry(entry: RoomHistoryEntry) {
  if (!canUseStorage(window.localStorage)) {
    return
  }

  const next = [entry, ...loadRoomHistory().filter((room) => room.roomUrl !== entry.roomUrl)]
    .sort((left, right) => right.lastOpenedAt - left.lastOpenedAt)
    .slice(0, 12)

  window.localStorage.setItem(ROOM_HISTORY_KEY, JSON.stringify(next))
}

export function loadRoomTemplates() {
  if (!canUseStorage(window.localStorage)) {
    return [] as RoomTemplateEntry[]
  }

  try {
    const raw = window.localStorage.getItem(ROOM_TEMPLATES_KEY)
    return raw ? (JSON.parse(raw) as RoomTemplateEntry[]) : []
  } catch {
    return []
  }
}

function cloneRoomTemplateSnapshot(room: RoomDoc) {
  const snapshot = JSON.parse(JSON.stringify(room)) as RoomDoc
  snapshot.players = {}
  snapshot.playerOrder = []
  delete snapshot.turnPlayerId
  return snapshot
}

export function saveRoomTemplate(entry: { id?: string; title: string; room: RoomDoc }) {
  if (!canUseStorage(window.localStorage)) {
    return
  }

  const nextRoom = cloneRoomTemplateSnapshot(entry.room)
  const nextEntry: RoomTemplateEntry = {
    id: entry.id ?? `template_${Date.now()}`,
    title: entry.title,
    savedAt: Date.now(),
    room: nextRoom,
  }
  nextEntry.room.sourceTemplateId = nextEntry.id

  const next = [nextEntry, ...loadRoomTemplates().filter((template) => template.id !== nextEntry.id)]
    .sort((left, right) => right.savedAt - left.savedAt)
    .slice(0, 24)

  window.localStorage.setItem(ROOM_TEMPLATES_KEY, JSON.stringify(next))
  return nextEntry
}

export function renameRoomTemplate(templateId: string, title: string) {
  if (!canUseStorage(window.localStorage)) {
    return
  }

  const next = loadRoomTemplates().map((template) =>
    template.id === templateId
      ? {
          ...template,
          title,
          savedAt: Date.now(),
        }
      : template,
  )

  window.localStorage.setItem(ROOM_TEMPLATES_KEY, JSON.stringify(next))
}

export function deleteRoomTemplate(templateId: string) {
  if (!canUseStorage(window.localStorage)) {
    return
  }

  const next = loadRoomTemplates().filter((template) => template.id !== templateId)
  window.localStorage.setItem(ROOM_TEMPLATES_KEY, JSON.stringify(next))
}

export function loadJoinedPlayerId(roomUrl: string) {
  if (!canUseStorage(window.sessionStorage)) {
    return undefined
  }
  return window.sessionStorage.getItem(`${PLAYER_PREFIX}${roomUrl}`) ?? undefined
}

export function saveJoinedPlayerId(roomUrl: string, playerId: string) {
  if (!canUseStorage(window.sessionStorage)) {
    return
  }
  window.sessionStorage.setItem(`${PLAYER_PREFIX}${roomUrl}`, playerId)
}

export function clearJoinedPlayerId(roomUrl: string) {
  if (!canUseStorage(window.sessionStorage)) {
    return
  }
  window.sessionStorage.removeItem(`${PLAYER_PREFIX}${roomUrl}`)
}

export function loadCameraState(roomUrl: string): CameraState | undefined {
  if (!canUseStorage(window.localStorage)) {
    return undefined
  }

  try {
    const raw = window.localStorage.getItem(`${CAMERA_PREFIX}${roomUrl}`)
    return raw ? (JSON.parse(raw) as CameraState) : undefined
  } catch {
    return undefined
  }
}

export function saveCameraState(roomUrl: string, camera: CameraState) {
  if (!canUseStorage(window.localStorage)) {
    return
  }
  window.localStorage.setItem(`${CAMERA_PREFIX}${roomUrl}`, JSON.stringify(camera))
}
