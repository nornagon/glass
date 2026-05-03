import {
  BroadcastChannelNetworkAdapter,
  IndexedDBStorageAdapter,
  isValidAutomergeUrl,
  Repo,
  type AutomergeUrl,
  WebSocketClientAdapter,
} from '@automerge/react'

const ROOM_HASH_PREFIX = '#room='
const ROOM_HASH_ROOM_KEY = 'room'
const ROOM_HASH_PLAYER_KEY = 'player'
const REPO_STORAGE_NAMESPACE = 'glass'
const REPO_STORAGE_COLLECTION = 'rooms'
const REPO_SYNC_SERVER_URL = 'wss://sync.automerge.org'

export const repo = new Repo({
  network: [
    new BroadcastChannelNetworkAdapter(),
    new WebSocketClientAdapter(REPO_SYNC_SERVER_URL),
  ],
  storage: new IndexedDBStorageAdapter(REPO_STORAGE_NAMESPACE, REPO_STORAGE_COLLECTION),
})

export const resourceRepo = new Repo({
  network: [
    new BroadcastChannelNetworkAdapter(),
    new WebSocketClientAdapter(REPO_SYNC_SERVER_URL),
  ],
})

export function parseRoomUrlFromHash(hash = window.location.hash) {
  const raw = hash.startsWith(ROOM_HASH_PREFIX) ? new URLSearchParams(hash.slice(1)).get(ROOM_HASH_ROOM_KEY) ?? '' : ''
  return isValidAutomergeUrl(raw) ? (raw as AutomergeUrl) : undefined
}

export function roomHash(roomUrl: string) {
  const params = new URLSearchParams()
  params.set(ROOM_HASH_ROOM_KEY, roomUrl)
  return `#${params.toString()}`
}

export function playerIdentityHash(roomUrl: string, playerId: string) {
  const params = new URLSearchParams()
  params.set(ROOM_HASH_ROOM_KEY, roomUrl)
  params.set(ROOM_HASH_PLAYER_KEY, playerId)
  return `#${params.toString()}`
}

export function parsePlayerIdentityFromHash(hash = window.location.hash) {
  if (!hash.startsWith(ROOM_HASH_PREFIX)) {
    return undefined
  }
  return new URLSearchParams(hash.slice(1)).get(ROOM_HASH_PLAYER_KEY)?.trim() || undefined
}

export function parseRoomReference(rawValue: string) {
  const trimmed = rawValue.trim()
  if (!trimmed) {
    return undefined
  }

  if (isValidAutomergeUrl(trimmed)) {
    return trimmed as AutomergeUrl
  }

  if (trimmed.startsWith(ROOM_HASH_PREFIX)) {
    return parseRoomUrlFromHash(trimmed)
  }

  try {
    const url = new URL(trimmed)
    return parseRoomUrlFromHash(url.hash)
  } catch {
    return undefined
  }
}
