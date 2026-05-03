const MB = 1024 * 1024
const DEFAULT_MOBILE_RESOURCE_MEMORY_BUDGET_BYTES = 500 * MB
const DEFAULT_DESKTOP_RESOURCE_MEMORY_BUDGET_BYTES = 2048 * MB
const DEFAULT_RESOURCE_TASK_ESTIMATE_BYTES = 64 * MB

interface ResourceLoadTask<T> {
  estimatedBytes: number
  load: () => Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

interface ResourceLoadOptions {
  estimatedBytes?: number
}

const pendingTasks: Array<ResourceLoadTask<unknown>> = []
let activeEstimatedBytes = 0
let configuredBudgetBytes: number | undefined

function isLikelyMobileDevice() {
  if (typeof navigator === 'undefined') {
    return false
  }

  const userAgent = navigator.userAgent
  return (
    /Android|iPhone|iPad|iPod|Mobile/i.test(userAgent) ||
    (navigator.maxTouchPoints > 1 && userAgent.includes('Macintosh'))
  )
}

export function defaultResourceMemoryBudgetBytes() {
  if (typeof __RESOURCE_MEMORY_BUDGET_BYTES__ === 'number' && __RESOURCE_MEMORY_BUDGET_BYTES__ > 0) {
    return __RESOURCE_MEMORY_BUDGET_BYTES__
  }

  return isLikelyMobileDevice()
    ? DEFAULT_MOBILE_RESOURCE_MEMORY_BUDGET_BYTES
    : DEFAULT_DESKTOP_RESOURCE_MEMORY_BUDGET_BYTES
}

export function setResourceMemoryBudgetBytesForTesting(nextBudgetBytes: number | undefined) {
  configuredBudgetBytes = nextBudgetBytes
  pumpResourceLoadQueue()
}

export function resourceMemoryBudgetBytes() {
  return configuredBudgetBytes ?? defaultResourceMemoryBudgetBytes()
}

export function estimateRasterMemoryBytes(width: number, height: number, buffers = 4) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return DEFAULT_RESOURCE_TASK_ESTIMATE_BYTES
  }

  return Math.ceil(width * height * 4 * buffers)
}

export function estimateStoredAssetMemoryBytes(sizeBytes: number | undefined, copies = 3) {
  if (!Number.isFinite(sizeBytes) || !sizeBytes || sizeBytes <= 0) {
    return DEFAULT_RESOURCE_TASK_ESTIMATE_BYTES
  }

  return Math.ceil(sizeBytes * copies)
}

export function enqueueResourceLoad<T>(load: () => Promise<T>, options: ResourceLoadOptions = {}): Promise<T> {
  const estimatedBytes = Math.max(1, Math.ceil(options.estimatedBytes ?? DEFAULT_RESOURCE_TASK_ESTIMATE_BYTES))

  return new Promise<T>((resolve, reject) => {
    pendingTasks.push({
      estimatedBytes,
      load,
      resolve: resolve as (value: unknown) => void,
      reject,
    })
    pumpResourceLoadQueue()
  })
}

function pumpResourceLoadQueue() {
  const budgetBytes = Math.max(1, resourceMemoryBudgetBytes())

  for (let index = 0; index < pendingTasks.length; index += 1) {
    const task = pendingTasks[index]
    if (activeEstimatedBytes > 0 && activeEstimatedBytes + task.estimatedBytes > budgetBytes) {
      continue
    }

    pendingTasks.splice(index, 1)
    index -= 1
    activeEstimatedBytes += task.estimatedBytes

    void Promise.resolve()
      .then(task.load)
      .then(task.resolve, task.reject)
      .finally(() => {
        activeEstimatedBytes = Math.max(0, activeEstimatedBytes - task.estimatedBytes)
        pumpResourceLoadQueue()
      })
  }
}
