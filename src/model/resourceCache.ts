interface CachedResourceRecord {
  url: string
  version: number
  kind: string
  name: string
  mimeType: string
  bytes: Uint8Array
  sizeBytes: number
  contentHash?: string
  width?: number
  height?: number
  createdAt: number
}

interface PersistedResourceRecord extends Omit<CachedResourceRecord, 'bytes'> {
  bytes: ArrayBuffer
}

const RESOURCE_CACHE_DB_NAME = 'glass-resource-cache'
const RESOURCE_CACHE_DB_VERSION = 1
const RESOURCE_CACHE_STORE_NAME = 'resources'

function canUseIndexedDb() {
  return typeof indexedDB !== 'undefined'
}

function openResourceCacheDb(): Promise<IDBDatabase | undefined> {
  if (!canUseIndexedDb()) {
    return Promise.resolve(undefined)
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(RESOURCE_CACHE_DB_NAME, RESOURCE_CACHE_DB_VERSION)

    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(RESOURCE_CACHE_STORE_NAME)) {
        database.createObjectStore(RESOURCE_CACHE_STORE_NAME, { keyPath: 'url' })
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Failed to open resource cache'))
  })
}

function serializeCachedResourceRecord(record: CachedResourceRecord): PersistedResourceRecord {
  return {
    ...record,
    bytes: record.bytes.slice().buffer,
  }
}

function deserializeCachedResourceRecord(record: PersistedResourceRecord): CachedResourceRecord {
  return {
    ...record,
    bytes: new Uint8Array(record.bytes),
  }
}

export interface PersistableResourceDoc {
  version: number
  kind: string
  name: string
  mimeType: string
  bytes: Uint8Array
  sizeBytes: number
  contentHash?: string
  width?: number
  height?: number
  createdAt: number
}

export async function loadCachedResourceDoc(url: string): Promise<PersistableResourceDoc | undefined> {
  const database = await openResourceCacheDb().catch(() => undefined)
  if (!database) {
    return undefined
  }

  try {
    return await new Promise<PersistableResourceDoc | undefined>((resolve, reject) => {
      const transaction = database.transaction(RESOURCE_CACHE_STORE_NAME, 'readonly')
      const store = transaction.objectStore(RESOURCE_CACHE_STORE_NAME)
      const request = store.get(url)

      request.onsuccess = () => {
        const record = request.result as PersistedResourceRecord | undefined
        resolve(record ? deserializeCachedResourceRecord(record) : undefined)
      }
      request.onerror = () => reject(request.error ?? new Error('Failed to read resource cache'))
    })
  } finally {
    database.close()
  }
}

export async function saveCachedResourceDoc(url: string, doc: PersistableResourceDoc) {
  const database = await openResourceCacheDb().catch(() => undefined)
  if (!database) {
    return
  }

  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(RESOURCE_CACHE_STORE_NAME, 'readwrite')
      const store = transaction.objectStore(RESOURCE_CACHE_STORE_NAME)
      store.put(serializeCachedResourceRecord({
        url,
        ...doc,
      }))

      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error ?? new Error('Failed to write resource cache'))
      transaction.onabort = () => reject(transaction.error ?? new Error('Resource cache write aborted'))
    })
  } finally {
    database.close()
  }
}
