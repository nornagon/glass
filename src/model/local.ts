import type { CameraState, RoomHistoryEntry } from './types'

const ROOM_HISTORY_KEY = 'glass.room-history'
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
