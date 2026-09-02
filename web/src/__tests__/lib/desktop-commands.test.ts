import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const navigate = mock(() => Promise.resolve())
const router = { navigate } as unknown as import('@tanstack/react-router').AnyRouter

import { openNotificationSession } from '@/lib/desktop-commands'

beforeEach(() => navigate.mockClear())

describe('router coupling', () => {
  it('does not import the router singleton (it would close a cycle through the route tree)', () => {
    // router.ts -> routes/__root.tsx -> desktop-commands -> router.ts, and
    // router.ts -> routes/cockpit.tsx -> AgentChatView -> AppFooter -> router.ts.
    // Both must obtain the router from context instead.
    for (const rel of ['../../lib/desktop-commands.ts', '../../components/AppFooter.tsx']) {
      const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
      expect(src).not.toMatch(/from '@\/router'/)
    }
  })
})

describe('openNotificationSession', () => {
  it('opens the linked coding session from a desktop notification click', () => {
    openNotificationSession({ sessionId: 'session-123', mode: 'coding' }, router)

    expect(navigate).toHaveBeenCalledWith({
      to: '/coding/$sessionId',
      params: { sessionId: 'session-123' },
    })
  })

  it('ignores malformed payloads', () => {
    openNotificationSession({ sessionId: 'session-456', mode: 'coding' }, router)
    openNotificationSession({ sessionId: 42, mode: 'coding' }, router)

    expect(navigate).toHaveBeenCalledTimes(1)
    expect(navigate).toHaveBeenCalledWith({
      to: '/coding/$sessionId',
      params: { sessionId: 'session-456' },
    })
  })
})
