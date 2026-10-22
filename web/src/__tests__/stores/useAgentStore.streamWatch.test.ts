/**
 * A session's live feed can go quiet with no error: a subscription that never
 * reached the server, or frames that stopped being routed to this window. The
 * chat then showed a spinning tool card, or nothing at all, until a reload.
 * These tests pin the recovery: a feed that should be talking and is not gets
 * the session reloaded and reattached, and after repeated silence the session
 * uses its own direct connection.
 */
import { mock, describe, it, expect, beforeEach, afterEach } from 'bun:test'

/* eslint-disable @typescript-eslint/no-explicit-any */
const mockAgentStream = mock((_sid: any, _cbs: any, _signal?: any, _options?: any) => {}) as any
const mockSessionHistory = mock(() =>
  Promise.resolve({
    lead: { id: 'sess-1', agent_name: 'lead', title: null, created_at: null, updated_at: null, running: true, sub_sessions: [], messages: [] },
    members: [],
    has_more: false,
    next_cursor: null,
  }),
) as any
;(mock as any).module('@/api/client', () => ({
  agentStream: mockAgentStream,
  sessionHistory: mockSessionHistory,
  postAgentChat: mock(() => Promise.resolve({ status: 'ok', session_id: 'sess-1' })),
  postAgentCommand: mock(() => Promise.resolve({})),
  agentStatus: mock(() => Promise.resolve(null)),
}))
/* eslint-enable @typescript-eslint/no-explicit-any */

import { useAgentStore } from '@/stores/useAgentStore'
import { streamWatchClock, STREAM_SILENCE_MS, QUESTION_GRACE_MS } from '@/stores/useAgentStore/stream-slice'

type Callbacks = { onEvent: (type: string, data: unknown) => void; onDone?: () => void; onError?: (e: Error) => void }

let timers: { callback: () => void; ms: number; cleared: boolean }[] = []
const realClock = { ...streamWatchClock }

function fire(ms: number) {
  const due = timers.filter((t) => t.ms === ms && !t.cleared)
  for (const t of due) {
    t.cleared = true
    t.callback()
  }
  return due.length
}

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }

function lastCallbacks(): Callbacks {
  return mockAgentStream.mock.calls.at(-1)[1]
}

beforeEach(() => {
  timers = []
  streamWatchClock.set = (callback, ms) => {
    const timer = { callback, ms, cleared: false }
    timers.push(timer)
    return timer as unknown as ReturnType<typeof setTimeout>
  }
  streamWatchClock.clear = (handle) => {
    if (handle) (handle as unknown as { cleared: boolean }).cleared = true
  }
  mockAgentStream.mockClear()
  mockSessionHistory.mockClear()
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
    _silentStreamAttempts: 0,
    _directStreamSession: null,
  })
})

afterEach(() => {
  Object.assign(streamWatchClock, realClock)
  useAgentStore.getState()._abortController?.abort()
})

describe('stream watch', () => {
  it('reloads the session and reattaches when a working stream delivers nothing', async () => {
    useAgentStore.getState().connectStream()
    expect(fire(STREAM_SILENCE_MS)).toBe(1)
    await flush()

    expect(mockSessionHistory).toHaveBeenCalledTimes(1)
    expect(mockAgentStream).toHaveBeenCalledTimes(2)
  })

  it('leaves a stream alone once it delivers an update', async () => {
    useAgentStore.getState().connectStream()
    lastCallbacks().onEvent('agent_status', { agent: 'lead', status: 'working' })
    fire(STREAM_SILENCE_MS)
    await flush()

    expect(mockSessionHistory).not.toHaveBeenCalled()
    expect(mockAgentStream).toHaveBeenCalledTimes(1)
  })

  it('does not watch a stream when nothing is expected', async () => {
    useAgentStore.setState({ isAgentWorking: false })
    useAgentStore.getState().connectStream()
    expect(fire(STREAM_SILENCE_MS)).toBe(0)
  })

  it('uses a direct connection for the session after two silent attempts', async () => {
    useAgentStore.getState().connectStream()
    fire(STREAM_SILENCE_MS)
    await flush()
    expect(mockAgentStream.mock.calls.at(-1)[3]).toEqual({ direct: false })
    fire(STREAM_SILENCE_MS)
    await flush()

    expect(mockAgentStream).toHaveBeenCalledTimes(3)
    expect(mockAgentStream.mock.calls.at(-1)[3]).toEqual({ direct: true })
  })

  it('watches again when a turn starts on a stream it thought was live', async () => {
    useAgentStore.getState().connectStream()
    lastCallbacks().onEvent('agent_status', { agent: 'lead', status: 'working' })
    useAgentStore.getState().expectStreamActivity()
    fire(STREAM_SILENCE_MS)
    await flush()

    expect(mockSessionHistory).toHaveBeenCalledTimes(1)
    expect(mockAgentStream).toHaveBeenCalledTimes(2)
  })

  it('reloads when a question opened but its card never arrived', async () => {
    useAgentStore.getState().connectStream()
    lastCallbacks().onEvent('agent_status', { agent: 'lead', status: 'working' })
    useAgentStore.getState().expectQuestion('q-1')
    fire(QUESTION_GRACE_MS)
    await flush()

    expect(mockSessionHistory).toHaveBeenCalledTimes(1)
  })

  it('does nothing when the question card arrived', async () => {
    useAgentStore.getState().connectStream()
    useAgentStore.getState().expectQuestion('q-1')
    lastCallbacks().onEvent('question_asked', {
      question_id: 'q-1',
      session_id: 'sess-1',
      tool_call_id: 'call-1',
      questions: [{ question: 'Review plan revision 1.', header: 'Plan review', options: [] }],
      kind: 'plan_review',
      plan_revision: 1,
    })
    fire(QUESTION_GRACE_MS)
    await flush()

    expect(useAgentStore.getState().pendingQuestion?.id).toBe('q-1')
    expect(mockSessionHistory).not.toHaveBeenCalled()
  })
})
