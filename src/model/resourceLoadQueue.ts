let resourceLoadTail: Promise<void> = Promise.resolve()

export function enqueueResourceLoad<T>(load: () => Promise<T>): Promise<T> {
  const queuedLoad = resourceLoadTail.then(load, load)
  resourceLoadTail = queuedLoad.then(
    () => undefined,
    () => undefined,
  )
  return queuedLoad
}
