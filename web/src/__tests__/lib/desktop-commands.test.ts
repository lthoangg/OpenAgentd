import { beforeEach, describe, expect, it, mock } from 'bun:test'

const navigate = mock(() => Promise.resolve())
mock.module('@/router', () => ({ router: { navigate } }))

import { openNotificationSession } from '@/lib/desktop-commands'

beforeEach(() => navigate.mockClear())

describe('openNotificationSession', () => {
  it('opens the linked coding session from a desktop notification click', () => {
    openNotificationSession({ sessionId: 'session-123', mode: 'coding' })

    expect(navigate).toHaveBeenCalledWith({
      to: '/coding/$sessionId',
      params: { sessionId: 'session-123' },
    })
  })

  it('opens normal sessions in the cockpit and ignores malformed payloads', () => {
    openNotificationSession({ sessionId: 'session-456', mode: 'normal' })
    openNotificationSession({ sessionId: 42, mode: 'coding' })

    expect(navigate).toHaveBeenCalledTimes(1)
    expect(navigate).toHaveBeenCalledWith({
      to: '/cockpit/$sessionId',
      params: { sessionId: 'session-456' },
    })
  })
})
