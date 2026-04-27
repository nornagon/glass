import { describe, expect, it } from 'vitest'
import { enqueueResourceLoad } from './resourceLoadQueue'

describe('resource load queue', () => {
  it('runs resource loads one at a time', async () => {
    const events: string[] = []
    let finishFirst: (() => void) | undefined

    const firstLoad = enqueueResourceLoad(
      () =>
        new Promise<string>((resolve) => {
          events.push('first:start')
          finishFirst = () => {
            events.push('first:finish')
            resolve('first')
          }
        }),
    )
    const secondLoad = enqueueResourceLoad(async () => {
      events.push('second:start')
      return 'second'
    })

    await Promise.resolve()
    expect(events).toEqual(['first:start'])

    finishFirst?.()
    await expect(firstLoad).resolves.toBe('first')
    await expect(secondLoad).resolves.toBe('second')
    expect(events).toEqual(['first:start', 'first:finish', 'second:start'])
  })

  it('continues after a failed resource load', async () => {
    const events: string[] = []

    const failedLoad = enqueueResourceLoad(async () => {
      events.push('first:start')
      throw new Error('failed')
    })
    const nextLoad = enqueueResourceLoad(async () => {
      events.push('second:start')
      return 'second'
    })

    await expect(failedLoad).rejects.toThrow('failed')
    await expect(nextLoad).resolves.toBe('second')
    expect(events).toEqual(['first:start', 'second:start'])
  })
})
