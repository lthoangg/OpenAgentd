/**
 * Sending a message while a question card is open aborts the session's stream
 * and, with the silent-feed fix, marks it disconnected. A global
 * `session_turn_started` for the new turn can then land while the POST is
 * still in flight and run its own reload and reattach. The two paths must
 * converge: one user bubble, one live stream, the old card closed.
 *
 * IMPORTANT: mock.module() MUST appear before the store import, and this file
 * relies on `bun test --parallel` for per-file module-registry isolation.
 */
import { mock, describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { QueryClient } from '@tanstack/react-query'

/* eslint-disable @typescript-eslint/no-explicit-any */
const QUESTION = {
  id: 'q-1',
  session_id: 'sess-1',
  tool_call_id: 'call-1',
  questions: [{ question: 'Approve?', header: 'Plan', multiple: false, options: [] }],
  created_at: '2026-07-01T00:00:02Z',
}

function history(opts: { withReply: boolean }) {
  return {
    lead: {
      id: 'sess-1',
      agent_name: 'lead',
      title: null,
      model: null,
      thinking_level: null,
      created_at: null,
      updated_at: null,
      running: true,
      messages: [
        { id: 'm1', role: 'user', content: 'make a plan', created_at: '2026-07-01T00:00:00Z' },
        ...(opts.withReply
          ? [{ id: 'm-2', role: 'user', content: 'continue', created_at: new Date().toISOString() }]
          : []),
      ],
    },
    members: [],
    has_more: false,
    next_cursor: null,
    // Sending supersedes the question server-side before the turn starts.
    pending_question: opts.withReply ? null : QUESTION,
  }
}

let resolvePost: (value: unknown) => void = () => {}
const mockPostAgentChat = mock(() => new Promise((resolve) => { resolvePost = resolve })) as any
const mockSessionHistory = mock(() => Promise.resolve(history({ withReply: false }))) as any
const mockAgentStream = mock((_sid: any, _cbs: any, _signal?: any, _options?: any) => {}) as any

;(mock as any).module('@/api/client', () => ({
  sessionHistory: mockSessionHistory,
  sessionHistorySince: mock(() => Promise.resolve({ lead: {}, members: [] })) as any,
  agentStatus: mock(() => Promise.resolve(null)) as any,
  agentStream: mockAgentStream,
  postAgentChat: mockPostAgentChat,
  postAgentCommand: mock(() => Promise.resolve({ status: 'accepted' })) as any,
  cancelQueuedMessage: mock(() => Promise.resolve()) as any,
}))
/* eslint-enable @typescript-eslint/no-explicit-any */

import { useAgentStore } from '@/stores/useAgentStore'
import { handleGlobalEvent } from '@/hooks/use-global-event-stream'

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }

function userBubbles(content: string) {
  const lead = useAgentStore.getState().agentStreams.lead
  return [...lead.blocks, ...lead.currentBlocks].filter((b) => b.type === 'user' && b.content === content)
}

beforeEach(async () => {
  mockPostAgentChat.mockClear()
  mockAgentStream.mockClear()
  mockSessionHistory.mockClear()
  mockSessionHistory.mockImplementation(() => Promise.resolve(history({ withReply: false })))
  useAgentStore.getState().newSession()
  useAgentStore.setState({ leadName: 'lead', liveAgentNames: ['lead'] })
  await useAgentStore.getState().loadSession('sess-1', '/repo')
  useAgentStore.getState().connectStream()
})

afterEach(() => {
  useAgentStore.getState()._abortController?.abort()
})

describe('sendMessage over an open question', () => {
  it('starts from a parked lead with the card open and the stream attached', () => {
    const s = useAgentStore.getState()
    expect(s.pendingQuestion?.id).toBe('q-1')
    expect(s.agentStreams.lead.status).toBe('waiting_input')
    expect(s.isConnected).toBe(true)
  })

  it('shows one bubble when the turn start lands before the POST answers', async () => {
    const sent = useAgentStore.getState().sendMessage('continue', undefined, { workspace: '/repo' })
    await flush()
    expect(useAgentStore.getState().isConnected).toBe(false)

    // The server persisted the message and started the turn; the global
    // signal beats the POST response back to this window.
    mockSessionHistory.mockImplementation(() => Promise.resolve(history({ withReply: true })))
    await handleGlobalEvent(new QueryClient(), 'session_turn_started', { session_id: 'sess-1', workspace: '/repo' }, 1, () => 1)

    resolvePost({ status: 'started', session_id: 'sess-1', message_id: 'm-2' })
    expect(await sent).toBe(true)
    await flush()

    const s = useAgentStore.getState()
    expect(userBubbles('continue')).toHaveLength(1)
    // The reload already took the server's word that the card is closed; its
    // label then comes from the persisted "Superseded" tool result.
    expect(s.pendingQuestion).toBeNull()
    expect(s.isConnected).toBe(true)
    expect(s._abortController?.signal.aborted).toBe(false)
    expect(s.isAgentWorking).toBe(true)
  })

  it('shows one bubble when the POST answers first', async () => {
    const sent = useAgentStore.getState().sendMessage('continue', undefined, { workspace: '/repo' })
    await flush()
    resolvePost({ status: 'started', session_id: 'sess-1', message_id: 'm-2' })
    expect(await sent).toBe(true)

    // Stream is attached again, so the late global signal only arms the watch.
    mockSessionHistory.mockImplementation(() => Promise.resolve(history({ withReply: true })))
    await handleGlobalEvent(new QueryClient(), 'session_turn_started', { session_id: 'sess-1', workspace: '/repo' }, 1, () => 1)
    await flush()

    const s = useAgentStore.getState()
    expect(userBubbles('continue')).toHaveLength(1)
    expect(s.pendingQuestion).toBeNull()
    expect(s.isConnected).toBe(true)
    expect(mockSessionHistory).toHaveBeenCalledTimes(1)
  })
})
