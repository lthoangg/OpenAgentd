/**
 * "Queue until done": a held message is sent as a turn of its own once the
 * running turn has ended, and goes back to the composer whenever it should
 * not be sent after all.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'

const haptic = mock((..._args: unknown[]) => {})
mock.module('@/lib/haptics', () => ({ haptic }))

import { useAgentStore } from '@/stores/useAgentStore'
import { createDefaultAgentStream } from '@/stores/useAgentStore/defaults'
import { useHeldMessagesStore } from '@/stores/useHeldMessagesStore'
import { deliverFromComposer, stopTurn, useReleaseHeldMessages } from '@/components/AgentChatView/heldMessages'
import type { InputComposerHandle } from '@/components/InputComposer'

const INITIAL_AGENT_STATE = useAgentStore.getState()
const REAL_FETCH = globalThis.fetch
/** Goal requests the module sends on its own (`POST …/goal/pause`). */
let goalCalls: string[] = []

function fakeComposer() {
  const appended: Array<{ text: string; paragraph?: boolean; mentions?: readonly string[] }> = []
  const added: File[] = []
  const handle: InputComposerHandle = {
    focus: () => {},
    setValue: () => {},
    insertText: () => {},
    setFiles: () => {},
    appendValue: (text, options) => { appended.push({ text, paragraph: options?.paragraph, ...(options?.mentions ? { mentions: options.mentions } : {}) }) },
    addFiles: (files) => { added.push(...files) },
    restoreLastSubmission: () => {},
    addDesignFeedback: () => {},
  }
  return { ref: { current: handle }, appended, added }
}

/** Stands in for the store's send, which marks the agent working before it awaits. */
function sendThatStartsATurn(delivered = true) {
  return mock(async (..._args: unknown[]) => {
    useAgentStore.setState({ isAgentWorking: true })
    return delivered
  })
}

const held = () => useHeldMessagesStore.getState().messages.map((m) => m.content)

beforeEach(() => {
  useHeldMessagesStore.setState({ messages: [] })
  haptic.mockClear()
  goalCalls = []
  globalThis.fetch = mock(async (...args: unknown[]) => {
    const init = args[1] as RequestInit | undefined
    goalCalls.push(`${init?.method ?? 'GET'} ${String(args[0]).replace(/^.*\/api/, '/api')}`)
    return new Response('{}', { status: 404 })
  }) as unknown as typeof fetch
  useAgentStore.setState({
    sessionId: 's1',
    isAgentWorking: true,
    _syncedThrough: '2026-01-01T00:00:00Z',
    leadName: 'lead',
    agentStreams: {},
  })
})

afterEach(() => {
  cleanup()
  globalThis.fetch = REAL_FETCH
  useAgentStore.setState(INITIAL_AGENT_STATE, true)
})

describe('useReleaseHeldMessages', () => {
  it('sends the oldest held message once the turn has ended', () => {
    const sendMessage = sendThatStartsATurn()
    const photo = new File(['x'], 'photo.png', { type: 'image/png' })
    useAgentStore.setState({ sendMessage, sessionModel: 'gpt-5' })
    useHeldMessagesStore.getState().hold({ sessionId: 's1', content: 'first', files: [photo], mentions: ['src/a.ts'] })
    useHeldMessagesStore.getState().hold({ sessionId: 's1', content: 'second' })
    const composer = fakeComposer()

    renderHook(() => useReleaseHeldMessages({ workspace: '/repo', sessionId: 's1', composerRef: composer.ref }))
    expect(sendMessage).not.toHaveBeenCalled()

    act(() => { useAgentStore.setState({ isAgentWorking: false }) })

    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage.mock.calls[0]).toEqual([
      'first',
      [photo],
      { workspace: '/repo', model: 'gpt-5', thinkingLevel: null, fastMode: false, mentions: ['src/a.ts'] },
    ])
    expect(held()).toEqual(['second'])
  })

  it('waits for the session history before trusting an idle agent', () => {
    // A session switch resets the working flag before the server has said
    // whether the turn is still running.
    const sendMessage = sendThatStartsATurn()
    useAgentStore.setState({ sendMessage, isAgentWorking: false, _syncedThrough: null })
    useHeldMessagesStore.getState().hold({ sessionId: 's1', content: 'first' })
    const composer = fakeComposer()

    renderHook(() => useReleaseHeldMessages({ workspace: '/repo', sessionId: 's1', composerRef: composer.ref }))
    expect(sendMessage).not.toHaveBeenCalled()

    act(() => { useAgentStore.setState({ _syncedThrough: '2026-01-01T00:00:00Z' }) })
    expect(sendMessage).toHaveBeenCalledTimes(1)
  })

  it('leaves messages held for another session alone', () => {
    const sendMessage = sendThatStartsATurn()
    useAgentStore.setState({ sendMessage, isAgentWorking: false })
    useHeldMessagesStore.getState().hold({ sessionId: 's2', content: 'elsewhere' })
    const composer = fakeComposer()

    renderHook(() => useReleaseHeldMessages({ workspace: '/repo', sessionId: 's1', composerRef: composer.ref }))

    expect(sendMessage).not.toHaveBeenCalled()
    expect(held()).toEqual(['elsewhere'])
  })

  it('returns a message that could not be sent, and the ones behind it, to the composer', async () => {
    const sendMessage = mock(async (..._args: unknown[]) => false)
    useAgentStore.setState({ sendMessage })
    useHeldMessagesStore.getState().hold({ sessionId: 's1', content: 'first @src/a.ts', mentions: ['src/a.ts'] })
    useHeldMessagesStore.getState().hold({ sessionId: 's1', content: 'second @src/b.ts', mentions: ['src/b.ts', 'src/a.ts'] })
    const composer = fakeComposer()

    renderHook(() => useReleaseHeldMessages({ workspace: '/repo', sessionId: 's1', composerRef: composer.ref }))
    await act(async () => { useAgentStore.setState({ isAgentWorking: false }) })

    expect(sendMessage).toHaveBeenCalledTimes(1)
    // Mentions come back too, so the files are still attached when resent.
    expect(composer.appended).toEqual([{ text: 'first @src/a.ts\n\nsecond @src/b.ts', paragraph: true, mentions: ['src/a.ts', 'src/b.ts'] }])
    expect(held()).toEqual([])
  })

  it('returns held messages to the composer instead of following a failed turn', async () => {
    const sendMessage = sendThatStartsATurn()
    useAgentStore.setState({
      sendMessage,
      agentStreams: { lead: { ...createDefaultAgentStream(), status: 'error' } },
    })
    useHeldMessagesStore.getState().hold({ sessionId: 's1', content: 'then do this' })
    const composer = fakeComposer()

    renderHook(() => useReleaseHeldMessages({ workspace: '/repo', sessionId: 's1', composerRef: composer.ref }))
    await act(async () => { useAgentStore.setState({ isAgentWorking: false }) })

    expect(sendMessage).not.toHaveBeenCalled()
    expect(composer.appended).toEqual([{ text: 'then do this', paragraph: true }])
  })

  // Steers the failed turn never read come back too, ahead of the held
  // messages (that is the order they would have gone out in).
  it('returns unread steers to the composer after a failed turn, ahead of held messages', async () => {
    const steerFile = new File(['z'], 'spec.md', { type: 'text/markdown' })
    const removePendingMessage = mock(async (...args: unknown[]) => {
      const id = String(args[0])
      useAgentStore.setState((s) => ({ _pendingMessages: s._pendingMessages.filter((m) => m.id !== id) }))
      return 'cancelled' as const
    })
    useAgentStore.setState({
      sendMessage: sendThatStartsATurn(),
      removePendingMessage,
      agentStreams: { lead: { ...createDefaultAgentStream(), status: 'error' } },
      _pendingMessages: [
        { id: 'q1', sessionId: 's1', content: 'steer it', submittedAt: 1, files: [steerFile], attachments: [{ original_name: 'spec.md', media_type: 'text/markdown', category: 'document' }] },
        { id: 'q-other', sessionId: 's2', content: 'elsewhere', submittedAt: 2 },
      ],
    })
    useHeldMessagesStore.getState().hold({ sessionId: 's1', content: 'then do this' })
    const composer = fakeComposer()

    renderHook(() => useReleaseHeldMessages({ workspace: '/repo', sessionId: 's1', composerRef: composer.ref }))
    await act(async () => { useAgentStore.setState({ isAgentWorking: false }) })

    expect(removePendingMessage.mock.calls.map((c) => c[0])).toEqual(['q1'])
    expect(composer.appended).toEqual([{ text: 'steer it\n\nthen do this', paragraph: true }])
    expect(composer.added).toEqual([steerFile])
    expect(held()).toEqual([])
  })

  it('returns a failed turn\'s steers when nothing is held', async () => {
    const removePendingMessage = mock(async () => 'cancelled' as const)
    useAgentStore.setState({
      removePendingMessage,
      agentStreams: { lead: { ...createDefaultAgentStream(), status: 'error' } },
      _pendingMessages: [{ id: 'q1', sessionId: 's1', content: 'steer it', submittedAt: 1 }],
    })
    const composer = fakeComposer()

    renderHook(() => useReleaseHeldMessages({ workspace: '/repo', sessionId: 's1', composerRef: composer.ref }))
    await act(async () => { useAgentStore.setState({ isAgentWorking: false }) })

    expect(composer.appended).toEqual([{ text: 'steer it', paragraph: true }])
  })

  // Cancelling deletes a queued message's uploads, and this browser has no
  // copy of files sent from elsewhere: such a steer stays queued and goes out
  // with the next message instead.
  it('leaves a steer queued after a failed turn when its files are not in this browser', async () => {
    const removePendingMessage = mock(async () => 'cancelled' as const)
    useAgentStore.setState({
      removePendingMessage,
      agentStreams: { lead: { ...createDefaultAgentStream(), status: 'error' } },
      _pendingMessages: [{ id: 'q1', sessionId: 's1', content: 'see attached', submittedAt: 1, attachments: [{ original_name: 'a.png', media_type: 'image/png', category: 'image' }] }],
    })
    const composer = fakeComposer()

    renderHook(() => useReleaseHeldMessages({ workspace: '/repo', sessionId: 's1', composerRef: composer.ref }))
    await act(async () => { useAgentStore.setState({ isAgentWorking: false }) })

    expect(removePendingMessage).not.toHaveBeenCalled()
    expect(composer.appended).toEqual([])
  })

  it('does not return a steer the agent read before it could be called off', async () => {
    const removePendingMessage = mock(async () => 'sent' as const)
    useAgentStore.setState({
      removePendingMessage,
      agentStreams: { lead: { ...createDefaultAgentStream(), status: 'error' } },
      _pendingMessages: [{ id: 'q1', sessionId: 's1', content: 'too late', submittedAt: 1 }],
    })
    const composer = fakeComposer()

    renderHook(() => useReleaseHeldMessages({ workspace: '/repo', sessionId: 's1', composerRef: composer.ref }))
    await act(async () => { useAgentStore.setState({ isAgentWorking: false }) })

    expect(composer.appended).toEqual([])
  })
})

describe('stopTurn', () => {
  it('hands held messages back to the composer before stopping the turn', async () => {
    const order: string[] = []
    const stopAgent = mock(async () => { order.push('stop') })
    useAgentStore.setState({ stopAgent })
    const notes = new File(['y'], 'notes.md', { type: 'text/markdown' })
    useHeldMessagesStore.getState().hold({ sessionId: 's1', content: 'first', files: [notes] })
    useHeldMessagesStore.getState().hold({ sessionId: 's2', content: 'elsewhere' })
    const composer = fakeComposer()
    composer.ref.current.appendValue = (text) => { order.push(`restore ${text}`) }

    await stopTurn(composer.ref.current)

    expect(order).toEqual(['restore first', 'stop'])
    expect(composer.added).toEqual([notes])
    expect(held()).toEqual(['elsewhere'])
  })

  // Stop calls off a steer the agent has not read yet, as it does a held
  // message, instead of leaving it in history unanswered. The cancel goes
  // first: the interrupt would release unread steers into the transcript.
  it('calls off unread steers before stopping and returns them ahead of held messages', async () => {
    const order: string[] = []
    const removePendingMessage = mock(async (...args: unknown[]) => {
      order.push(`cancel ${String(args[0])}`)
      return 'cancelled' as const
    })
    const stopAgent = mock(async () => { order.push('stop') })
    useAgentStore.setState({
      stopAgent,
      removePendingMessage,
      _pendingMessages: [
        { id: 'q2', sessionId: 's1', content: 'second steer', submittedAt: 2 },
        { id: 'q1', sessionId: 's1', content: 'first steer', submittedAt: 1 },
        { id: 'q-other', sessionId: 's2', content: 'elsewhere', submittedAt: 3 },
      ],
    })
    useHeldMessagesStore.getState().hold({ sessionId: 's1', content: 'then this' })
    const composer = fakeComposer()
    composer.ref.current.appendValue = (text) => { order.push(`restore ${text}`) }

    await stopTurn(composer.ref.current)

    expect(order).toEqual(['cancel q1', 'cancel q2', 'restore first steer\n\nsecond steer\n\nthen this', 'stop'])
    expect(held()).toEqual([])
  })

  // A prompt another workspace's agent sent is not the user's to take back:
  // cancelling it would delete that agent's request and paste it into the
  // composer as if the user had written it.
  it('leaves a message another workspace sent queued when stopping', async () => {
    const removePendingMessage = mock(async () => 'cancelled' as const)
    const stopAgent = mock(async () => {})
    useAgentStore.setState({
      stopAgent,
      removePendingMessage,
      _pendingMessages: [
        { id: 'q-ws', sessionId: 's1', content: 'please look', submittedAt: 1, sentFromWorkspace: 'api' },
        { id: 'q-mine', sessionId: 's1', content: 'my steer', submittedAt: 2 },
      ],
    })
    const composer = fakeComposer()

    await stopTurn(composer.ref.current)

    expect(removePendingMessage.mock.calls.map((call) => (call as unknown[])[0])).toEqual(['q-mine'])
    expect(composer.appended).toEqual([{ text: 'my steer', paragraph: true }])
  })

  it('leaves a steer the agent read during the stop where it is', async () => {
    const removePendingMessage = mock(async () => 'sent' as const)
    const stopAgent = mock(async () => {})
    useAgentStore.setState({
      stopAgent,
      removePendingMessage,
      _pendingMessages: [{ id: 'q1', sessionId: 's1', content: 'too late', submittedAt: 1 }],
    })
    useHeldMessagesStore.getState().hold({ sessionId: 's1', content: 'then this' })
    const composer = fakeComposer()

    await stopTurn(composer.ref.current)

    expect(composer.appended).toEqual([{ text: 'then this', paragraph: true }])
    expect(stopAgent).toHaveBeenCalledTimes(1)
  })
})

describe('deliverFromComposer', () => {
  it('holds a message for the end of the running turn', async () => {
    const sendMessage = sendThatStartsATurn()
    useAgentStore.setState({ sendMessage })
    const composer = fakeComposer()

    await deliverFromComposer('/repo', composer.ref.current, { content: 'then run the tests', mentions: ['a.ts'] }, 'after-turn')

    expect(sendMessage).not.toHaveBeenCalled()
    const [message] = useHeldMessagesStore.getState().messages
    expect([message.sessionId, message.content, message.mentions]).toEqual(['s1', 'then run the tests', ['a.ts']])
  })

  it('sends straight away when there is no turn to wait for', async () => {
    const sendMessage = sendThatStartsATurn()
    useAgentStore.setState({ sendMessage, isAgentWorking: false })
    const composer = fakeComposer()

    await deliverFromComposer('/repo', composer.ref.current, { content: 'hello' }, 'after-turn')

    expect(sendMessage.mock.calls[0][0]).toBe('hello')
    expect(held()).toEqual([])
  })

  it('stops the running turn before sending in its place', async () => {
    const order: string[] = []
    useAgentStore.setState({
      stopAgent: mock(async () => { order.push('stop') }),
      sendMessage: mock(async (...args: unknown[]) => { order.push(`send ${String(args[0])}`); return true }),
    })
    const composer = fakeComposer()

    await deliverFromComposer('/repo', composer.ref.current, { content: 'do this instead' }, 'interrupt')

    expect(order).toEqual(['stop', 'send do this instead'])
  })

  it('keeps the goal on Stop & send, but not on a plain Stop', async () => {
    const stopAgent = mock(async (..._args: unknown[]) => {})
    useAgentStore.setState({ stopAgent, sendMessage: mock(async () => true) })
    const composer = fakeComposer()

    await deliverFromComposer('/repo', composer.ref.current, { content: 'also this' }, 'interrupt')
    await stopTurn(composer.ref.current)

    expect(stopAgent.mock.calls.map((call) => call[0])).toEqual([{ keepGoal: true }, undefined])
    expect(goalCalls).toEqual([])
  })

  it('pauses the goal when the message of a Stop & send never lands', async () => {
    useAgentStore.setState({ stopAgent: mock(async () => {}), sendMessage: mock(async () => false) })
    const composer = fakeComposer()

    await deliverFromComposer('/repo', composer.ref.current, { content: 'also this' }, 'interrupt')
    await Promise.resolve()

    expect(goalCalls).toEqual(['POST /api/agent/sessions/s1/goal/pause'])
  })

  it('hands held messages back after the replacement, once a failed draft has restored itself', async () => {
    const order: string[] = []
    useAgentStore.setState({
      stopAgent: mock(async () => { order.push('stop') }),
      sendMessage: mock(async () => { order.push('send'); return false }),
    })
    useHeldMessagesStore.getState().hold({ sessionId: 's1', content: 'later' })
    const composer = fakeComposer()
    composer.ref.current.restoreLastSubmission = () => { order.push('restore draft') }
    composer.ref.current.appendValue = (text) => { order.push(`return ${text}`) }

    await deliverFromComposer('/repo', composer.ref.current, { content: 'do this instead' }, 'interrupt')

    expect(order).toEqual(['stop', 'send', 'restore draft', 'return later'])
    expect(held()).toEqual([])
  })

  // On a phone a light tap confirms the message left the composer, whether it
  // goes now or waits for the turn.
  it('taps once as a message leaves the composer', async () => {
    useAgentStore.setState({ sendMessage: sendThatStartsATurn(), isAgentWorking: false })
    const composer = fakeComposer()

    await deliverFromComposer('/repo', composer.ref.current, { content: 'hello' }, 'steer')
    await deliverFromComposer('/repo', composer.ref.current, { content: 'later' }, 'after-turn')

    expect(haptic.mock.calls).toEqual([['tick'], ['tick']])
  })
})
