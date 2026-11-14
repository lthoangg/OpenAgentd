/**
 * A session the server is running must read as running without waiting for a
 * stream frame: the transcript's dots follow the lead's status and the sidebar
 * row follows a `session_running` patch, and until now only a live
 * `agent_status` frame set either. With the stream late (a feed restart, a
 * slow attach) the transcript looked finished while the composer offered
 * Stop, and a follow-up landed in the queue of a session that looked idle.
 *
 * The server's own answers are proof enough: a send it accepted or queued,
 * and a history page that says `running`.
 *
 * IMPORTANT: mock.module() MUST appear before the store import, and this file
 * relies on `bun test --parallel` for per-file module-registry isolation.
 */
import { mock, describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { QueryClient } from '@tanstack/react-query'

/* eslint-disable @typescript-eslint/no-explicit-any */
const QUESTION = {
  id: 'q-1',
  session_id: 'sess-1',
  tool_call_id: 'call-1',
  questions: [{ question: 'Approve?', header: 'Plan', multiple: false, options: [] }],
  created_at: '2026-07-01T00:00:02Z',
}

function history(opts: { running: boolean; withFollowUp?: boolean; question?: boolean }) {
  return {
    lead: {
      id: 'sess-1',
      agent_name: 'lead',
      title: null,
      model: null,
      thinking_level: null,
      created_at: null,
      updated_at: null,
      running: opts.running,
      messages: [
        { id: 'm1', role: 'user', content: 'hello', created_at: '2026-07-01T00:00:00Z' },
        { id: 'a1', role: 'assistant', content: 'hi there', created_at: '2026-07-01T00:00:01Z' },
        ...(opts.withFollowUp
          ? [{ id: 'm-2', role: 'user', content: 'continue', created_at: new Date().toISOString() }]
          : []),
      ],
    },
    members: [],
    has_more: false,
    next_cursor: null,
    pending_question: opts.question ? QUESTION : null,
  }
}

/** One resolver per POST, in the order the sends went out. */
let posts: Array<(value: unknown) => void> = []
const mockPostAgentChat = mock(() => new Promise((resolve) => { posts.push(resolve) })) as any
const mockSessionHistory = mock(() => Promise.resolve(history({ running: false }))) as any
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
const store = () => useAgentStore.getState()
const lead = () => store().agentStreams.lead
const rowPatches = () => store().cacheInvalidations.filter((e) => e.kind === 'session_running')

async function open(page: ReturnType<typeof history>) {
  mockSessionHistory.mockImplementation(() => Promise.resolve(page))
  store().newSession()
  useAgentStore.setState({ leadName: 'lead', liveAgentNames: ['lead'] })
  await store().loadSession('sess-1', '/repo')
}

let warn: ReturnType<typeof spyOn>

beforeEach(async () => {
  posts = []
  mockPostAgentChat.mockClear()
  mockAgentStream.mockClear()
  mockSessionHistory.mockClear()
  warn = spyOn(console, 'warn').mockImplementation(() => {})
  await open(history({ running: false }))
})

afterEach(() => {
  store()._abortController?.abort()
  warn.mockRestore()
})

describe('a session the server is running reads as running before any stream frame', () => {
  it('starts idle, with no stream and no row patch', () => {
    expect(lead().status).toBe('idle')
    expect(store().isAgentWorking).toBe(false)
    expect(rowPatches()).toEqual([])
  })

  it('reads as working once the server accepts a send', async () => {
    const sent = store().sendMessage('continue', undefined, { workspace: '/repo' })
    await flush()
    posts[0]({ status: 'accepted', session_id: 'sess-1', message_id: 'm-2' })
    expect(await sent).toBe(true)

    // No frame has arrived: the stream mock never delivers one.
    expect(lead().status).toBe('working')
    expect(store().isAgentWorking).toBe(true)
    expect(rowPatches()).toEqual([{ kind: 'session_running', sessionId: 'sess-1', running: true }])
  })

  it('reads as working when a reload confirms the turn while the POST is still out', async () => {
    const sent = store().sendMessage('continue', undefined, { workspace: '/repo' })
    await flush()

    // The server saved the message and started the turn; the global signal
    // reloads the session before the POST answers.
    mockSessionHistory.mockImplementation(() => Promise.resolve(history({ running: true, withFollowUp: true })))
    await handleGlobalEvent(new QueryClient(), 'session_turn_started', { session_id: 'sess-1', workspace: '/repo' }, 1, () => 1)

    // The reload committed the bubble, so nothing but the status can show
    // that the turn is open.
    expect(lead().currentBlocks.some((b) => b.type === 'user')).toBe(false)
    expect(lead().blocks.filter((b) => b.type === 'user' && b.content === 'continue')).toHaveLength(1)
    expect(lead().status).toBe('working')
    expect(rowPatches()).toContainEqual({ kind: 'session_running', sessionId: 'sess-1', running: true })

    posts[0]({ status: 'accepted', session_id: 'sess-1', message_id: 'm-2' })
    expect(await sent).toBe(true)
    expect(lead().status).toBe('working')
  })

  it('marks the row running when a session is opened mid-turn', async () => {
    await open(history({ running: true }))

    expect(lead().status).toBe('working')
    expect(rowPatches()).toEqual([{ kind: 'session_running', sessionId: 'sess-1', running: true }])
  })

  it('leaves the row to its question when the session waits on an answer', async () => {
    // A `session_running` patch clears the row's needs-input mark.
    await open(history({ running: true, question: true }))

    expect(lead().status).toBe('waiting_input')
    expect(rowPatches()).toEqual([])
  })

  it('clears a row it marked when a reload says the turn is over', async () => {
    await open(history({ running: true }))

    mockSessionHistory.mockImplementation(() => Promise.resolve(history({ running: false })))
    await store().loadSession('sess-1', '/repo')

    expect(lead().status).toBe('idle')
    expect(rowPatches()).toEqual([
      { kind: 'session_running', sessionId: 'sess-1', running: true },
      { kind: 'session_running', sessionId: 'sess-1', running: false },
    ])
  })

  it('clears the row when the turn ends unheard, with the stream attached and silent', async () => {
    // A window whose event feed is down: it marked the row from the page,
    // attached (which forgets the mark, for the stream to make it again) and
    // hears neither `done` nor the completion event. The reload after the
    // silence check is the only word that the turn is over.
    await open(history({ running: true }))
    store().connectStream()

    mockSessionHistory.mockImplementation(() => Promise.resolve(history({ running: false })))
    await store().loadSession('sess-1', '/repo')

    expect(store().isAgentWorking).toBe(false)
    expect(rowPatches().at(-1)).toEqual({ kind: 'session_running', sessionId: 'sess-1', running: false })
  })

  it('does not touch the row of an idle session opened after a running one', async () => {
    await open(history({ running: true }))
    useAgentStore.setState({ cacheInvalidations: [] })

    mockSessionHistory.mockImplementation(() => Promise.resolve(history({ running: false })))
    await store().loadSession('sess-2', '/repo')

    expect(rowPatches()).toEqual([])
  })
})

describe('a send the server queues behind a turn this client had not seen', () => {
  it('takes the answer as proof the session is running', async () => {
    const sent = store().sendMessage('also this', undefined, { workspace: '/repo' })
    await flush()
    posts[0]({ status: 'queued', session_id: 'sess-1', message_id: 'q-1' })
    expect(await sent).toBe(true)

    expect(store()._pendingMessages.map((m) => m.id)).toEqual(['q-1'])
    expect(lead().currentBlocks).toEqual([])
    expect(lead().status).toBe('working')
    expect(store().isAgentWorking).toBe(true)
    expect(rowPatches()).toEqual([{ kind: 'session_running', sessionId: 'sess-1', running: true }])
    expect(store().isConnected).toBe(true)
    // What this client showed when the message left, for the next report.
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('queued a message this client sent as a new turn (working=false, lead=idle, connected=false)')
  })

  it('steers with the next send instead of dropping the stream again', async () => {
    const first = store().sendMessage('also this', undefined, { workspace: '/repo' })
    await flush()
    posts[0]({ status: 'queued', session_id: 'sess-1', message_id: 'q-1' })
    await first
    const attached = store()._abortController
    expect(mockAgentStream).toHaveBeenCalledTimes(1)

    const second = store().sendMessage('and this', undefined, { workspace: '/repo' })
    await flush()
    posts[1]({ status: 'queued', session_id: 'sess-1', message_id: 'q-2' })
    expect(await second).toBe(true)

    expect(store()._pendingMessages.map((m) => m.id)).toEqual(['q-1', 'q-2'])
    // Compared as a boolean: a failed `toBe` prints the whole controller.
    expect(store()._abortController === attached).toBe(true)
    expect(attached?.signal.aborted).toBe(false)
    expect(mockAgentStream).toHaveBeenCalledTimes(1)
  })

  it('keeps a lead that waits on an answer reading as waiting', async () => {
    await open(history({ running: true, question: true }))

    const sent = store().sendMessage('after that', undefined, { workspace: '/repo', holdUntilTurnEnd: true })
    await flush()
    posts[0]({ status: 'queued', session_id: 'sess-1', message_id: 'q-1' })
    expect(await sent).toBe(true)

    expect(lead().status).toBe('waiting_input')
    expect(rowPatches()).toEqual([])
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('a turn that ended still reads as ended', () => {
  it('goes idle on done and clears the row', async () => {
    const sent = store().sendMessage('continue', undefined, { workspace: '/repo' })
    await flush()
    posts[0]({ status: 'accepted', session_id: 'sess-1', message_id: 'm-2' })
    await sent

    store()._handleSSEEvent('done', {})

    expect(lead().status).toBe('idle')
    expect(store().isAgentWorking).toBe(false)
    expect(rowPatches().at(-1)).toEqual({ kind: 'session_running', sessionId: 'sess-1', running: false })
  })

  it('does not revive a failed lead from a page read before it failed', async () => {
    const sent = store().sendMessage('continue', undefined, { workspace: '/repo' })
    await flush()
    posts[0]({ status: 'accepted', session_id: 'sess-1', message_id: 'm-2' })
    await sent
    store()._handleSSEEvent('agent_status', { agent: 'lead', status: 'error', message: 'boom' })
    expect(lead().status).toBe('error')

    // Read while the turn still ran; lands after the failure.
    mockSessionHistory.mockImplementation(() => Promise.resolve(history({ running: true })))
    await store().loadSession('sess-1', '/repo')

    expect(lead().status).toBe('error')
  })
})
