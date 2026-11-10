/**
 * After the connection drops, the chat stream reattaches on its own, and the
 * global feed's catch-up (`reconcileCurrentSession`) used to reattach it once
 * more a second later. That second attach aborted the first one moments after
 * it replayed the turn, so every recovery opened the stream twice. These tests
 * pin it: a chat stream already delivering since the drop is left alone.
 */
import { mock, describe, it, expect, beforeEach, afterEach } from 'bun:test'

/* eslint-disable @typescript-eslint/no-explicit-any */
const mockAgentStream = mock((_sid: any, _cbs: any, _signal?: any, _options?: any) => {}) as any
;(mock as any).module('@/api/client', () => ({
  agentStream: mockAgentStream,
  sessionHistory: mock(() => Promise.resolve({ lead: null, members: [], has_more: false, next_cursor: null })),
  postAgentChat: mock(() => Promise.resolve({ status: 'ok', session_id: 'sess-1' })),
  postAgentCommand: mock(() => Promise.resolve({})),
  agentStatus: mock(() => Promise.resolve(null)),
}))
mock.module('@/lib/desktop-notifications', () => ({ sendDesktopNotification: mock(async () => ({ status: 'sent', message: 'sent' })) }))
mock.module('@/lib/haptics', () => ({ haptic: () => {}, outcomeHapticFeedback: () => {} }))
/* eslint-enable @typescript-eslint/no-explicit-any */

import { reconcileCurrentSession } from '@/hooks/use-global-event-stream'
import { useAgentStore } from '@/stores/useAgentStore'

type Callbacks = { onEvent: (type: string, data: unknown) => void; onDone?: () => void; onError?: (e: Error) => void }

function linkCallbacks(n: number): Callbacks {
  return mockAgentStream.mock.calls[n][1]
}

/** One replayed frame on link `n`, as an attach delivers first. */
function deliver(n: number) {
  linkCallbacks(n).onEvent('agent_status', { agent: 'lead', status: 'working' })
}

beforeEach(() => {
  mockAgentStream.mockClear()
  useAgentStore.setState({
    sessionId: 'sess-1',
    _workspace: '/repo',
    leadName: 'lead',
    agentNames: ['lead'],
    isAgentWorking: true,
    isConnected: false,
    pendingQuestion: null,
    _abortController: null,
    _sessionGeneration: 1,
    // The history reload keeps the turn running.
    loadSession: mock(async () => { useAgentStore.setState({ isAgentWorking: true }) }),
  })
})

afterEach(() => {
  useAgentStore.getState()._abortController?.abort()
})

describe('reconciling after the connection dropped', () => {
  it('leaves a chat stream that reattached and delivered since the drop', async () => {
    useAgentStore.getState().connectStream()
    deliver(0)
    const droppedAt = Date.now()
    // The chat's own recovery: it reattached and replayed the turn.
    const live = useAgentStore.getState().connectStream()
    deliver(1)

    await reconcileCurrentSession(2, () => 2, droppedAt)

    expect(mockAgentStream).toHaveBeenCalledTimes(2)
    expect(live.signal.aborted).toBe(false)
  })

  it('reattaches a chat stream that has delivered nothing since the drop', async () => {
    useAgentStore.getState().connectStream()
    deliver(0)
    const droppedAt = Date.now() + 1

    await reconcileCurrentSession(2, () => 2, droppedAt)

    expect(mockAgentStream).toHaveBeenCalledTimes(2)
  })

  it('reattaches on the first connection, when there was no drop', async () => {
    useAgentStore.getState().connectStream()
    deliver(0)

    await reconcileCurrentSession(1, () => 1)

    expect(mockAgentStream).toHaveBeenCalledTimes(2)
  })
})
