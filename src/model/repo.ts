import {
  BroadcastChannelNetworkAdapter,
  IndexedDBStorageAdapter,
  isValidAutomergeUrl,
  Repo,
  type AutomergeUrl,
  WebSocketClientAdapter,
} from '@automerge/react'

const ROOM_HASH_PREFIX = '#room='
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
  const raw = hash.startsWith(ROOM_HASH_PREFIX) ? decodeURIComponent(hash.slice(ROOM_HASH_PREFIX.length)) : ''
  return isValidAutomergeUrl(raw) ? (raw as AutomergeUrl) : undefined
}

export function roomHash(roomUrl: string) {
  return `${ROOM_HASH_PREFIX}${encodeURIComponent(roomUrl)}`
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
