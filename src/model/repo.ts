import {
  BroadcastChannelNetworkAdapter,
  IndexedDBStorageAdapter,
  isValidAutomergeUrl,
  Repo,
  type AutomergeUrl,
  WebSocketClientAdapter,
} from '@automerge/react'
import { createRoomDoc } from './room'

const ROOM_HASH_PREFIX = '#room='

export const repo = new Repo({
  network: [
    new BroadcastChannelNetworkAdapter(),
    new WebSocketClientAdapter('wss://sync.automerge.org'),
  ],
  storage: new IndexedDBStorageAdapter('glass', 'rooms'),
})

export function parseRoomUrlFromHash(hash = window.location.hash) {
  const raw = hash.startsWith(ROOM_HASH_PREFIX) ? decodeURIComponent(hash.slice(ROOM_HASH_PREFIX.length)) : ''
  return isValidAutomergeUrl(raw) ? (raw as AutomergeUrl) : undefined
}

export function roomHash(roomUrl: string) {
  return `${ROOM_HASH_PREFIX}${encodeURIComponent(roomUrl)}`
}

export async function ensureRoomUrl() {
  const existing = parseRoomUrlFromHash()
  if (existing) {
    return existing
  }

  const handle = repo.create(createRoomDoc())
  const url = handle.url as AutomergeUrl
  window.location.hash = roomHash(url)
  return url
}
