import { describe, expect, it } from 'vitest'
import { applyRoomEphemeralMessage, isRoomEphemeralMessage } from './ephemeral'

describe('ephemeral messages', () => {
  it('accepts drag preview end messages with a final transform', () => {
    expect(
      isRoomEphemeralMessage({
        kind: 'drag-preview-end',
        clientId: 'client-a',
        objectId: 'object-a',
        transform: {
          x: 10,
          y: 20,
          rotation: Math.PI / 2,
        },
      }),
    ).toBe(true)
  })

  it('rejects drag preview end messages with an invalid final transform', () => {
    expect(
      isRoomEphemeralMessage({
        kind: 'drag-preview-end',
        clientId: 'client-a',
        objectId: 'object-a',
        transform: {
          x: 10,
          y: 20,
          rotation: Number.NaN,
        },
      }),
    ).toBe(false)
  })

  it('creates an ending remote session from a final drag preview end transform', () => {
    const sessions = new Map()
    const result = applyRoomEphemeralMessage(
      sessions,
      {
        kind: 'drag-preview-end',
        clientId: 'client-a',
        objectId: 'object-a',
        transform: {
          x: 10,
          y: 20,
          rotation: Math.PI / 4,
        },
      },
      123,
    )

    expect(result).toEqual({
      sessionKey: 'client-a:object-a',
      changed: true,
    })
    expect(sessions.get('client-a:object-a')).toEqual({
      clientId: 'client-a',
      objectId: 'object-a',
      transform: {
        x: 10,
        y: 20,
        rotation: Math.PI / 4,
      },
      updatedAt: 123,
      ending: true,
    })
  })

  it('keeps the prior transform when ending a preview without a new final transform', () => {
    const sessions = new Map([
      [
        'client-a:object-a',
        {
          clientId: 'client-a',
          objectId: 'object-a',
          transform: {
            x: 10,
            y: 20,
            rotation: Math.PI / 6,
          },
          updatedAt: 111,
          ending: false,
        },
      ],
    ])

    applyRoomEphemeralMessage(
      sessions,
      {
        kind: 'drag-preview-end',
        clientId: 'client-a',
        objectId: 'object-a',
      },
      222,
    )

    expect(sessions.get('client-a:object-a')).toEqual({
      clientId: 'client-a',
      objectId: 'object-a',
      transform: {
        x: 10,
        y: 20,
        rotation: Math.PI / 6,
      },
      updatedAt: 222,
      ending: true,
    })
  })
})
