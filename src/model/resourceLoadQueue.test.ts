import { afterEach, describe, expect, it } from 'vitest'
import { enqueueResourceLoad, setResourceMemoryBudgetBytesForTesting } from './resourceLoadQueue'

describe('resource load queue', () => {
  afterEach(() => {
    setResourceMemoryBudgetBytesForTesting(undefined)
  })

  it('runs resource loads one at a time', async () => {
    setResourceMemoryBudgetBytesForTesting(10)
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
    const secondLoad = enqueueResourceLoad(
      async () => {
        events.push('second:start')
        return 'second'
      },
      { estimatedBytes: 10 },
    )

    await Promise.resolve()
    expect(events).toEqual(['first:start'])

    finishFirst?.()
    await expect(firstLoad).resolves.toBe('first')
    await expect(secondLoad).resolves.toBe('second')
    expect(events).toEqual(['first:start', 'first:finish', 'second:start'])
  })

  it('continues after a failed resource load', async () => {
    setResourceMemoryBudgetBytesForTesting(10)
    const events: string[] = []

    const failedLoad = enqueueResourceLoad(
      async () => {
        events.push('first:start')
        throw new Error('failed')
      },
      { estimatedBytes: 10 },
    )
    const nextLoad = enqueueResourceLoad(
      async () => {
        events.push('second:start')
        return 'second'
      },
      { estimatedBytes: 10 },
    )

    await expect(failedLoad).rejects.toThrow('failed')
    await expect(nextLoad).resolves.toBe('second')
    expect(events).toEqual(['first:start', 'second:start'])
  })

  it('runs multiple resource loads when their estimates fit the budget', async () => {
    setResourceMemoryBudgetBytesForTesting(20)
    const events: string[] = []
    let finishFirst: (() => void) | undefined

    const firstLoad = enqueueResourceLoad(
      () =>
        new Promise<string>((resolve) => {
          events.push('first:start')
          finishFirst = () => resolve('first')
        }),
      { estimatedBytes: 10 },
    )
    const secondLoad = enqueueResourceLoad(
      async () => {
        events.push('second:start')
        return 'second'
      },
      { estimatedBytes: 10 },
    )

    await Promise.resolve()
    expect(events).toEqual(['first:start', 'second:start'])

    finishFirst?.()
    await expect(firstLoad).resolves.toBe('first')
    await expect(secondLoad).resolves.toBe('second')
  })
})
