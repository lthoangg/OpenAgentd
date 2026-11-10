/**
 * "Queue until done": a held message is queued on the server, which sends it
 * as a turn of its own once the running turn has ended; this client hands it
 * back to the composer whenever it should not be sent after all.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'

const haptic = mock((..._args: unknown[]) => {})
const outcomeHapticFeedback = mock((..._args: unknown[]) => {})
mock.module('@/lib/haptics', () => ({ haptic, outcomeHapticFeedback }))

import { useAgentStore } from '@/stores/useAgentStore'
import { createDefaultAgentStream } from '@/stores/useAgentStore/defaults'
import type { PendingMessage } from '@/stores/useAgentStore'
import {
  decideQueuedAfterFailure,
  deliverFromComposer,
  planComposerDelivery,
  pushStoppedToast,
  stopTurn,
  useReturnQueuedAfterFailure,
} from '@/components/AgentChatView/heldMessages'
import { useToastStore } from '@/stores/useToastStore'
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

/** A message held on the server until the running turn ends, as the store keeps it. */
function heldMessage(id: string, content: string, extra: Partial<PendingMessage> = {}): PendingMessage {
  return { id, sessionId: 's1', content, submittedAt: Number(id.replace(/\D/g, '')) || 10, heldUntilTurnEnd: true, ...extra }
}

/** A cancel the server grants: the chip leaves the queue. */
function cancelThatSucceeds(order?: string[]) {
  return mock(async (...args: unknown[]) => {
    const id = String(args[0])
    order?.push(`cancel ${id}`)
    useAgentStore.setState((s) => ({ _pendingMessages: s._pendingMessages.filter((m) => m.id !== id) }))
    return 'cancelled' as const
  })
}

const queued = () => useAgentStore.getState()._pendingMessages.map((m) => m.content)

beforeEach(() => {
  haptic.mockClear()
  outcomeHapticFeedback.mockClear()
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

describe('useReturnQueuedAfterFailure', () => {
  // The server starts held messages itself once the turn ends; this client
  // never sends them, so closing it loses nothing.
  it('sends nothing itself when the turn ends', async () => {
    const sendMessage = sendThatStartsATurn()
    const removePendingMessage = cancelThatSucceeds()
    useAgentStore.setState({ sendMessage, removePendingMessage, _pendingMessages: [heldMessage('h1', 'then do this')] })
    const composer = fakeComposer()

    renderHook(() => useReturnQueuedAfterFailure({ sessionId: 's1', composerRef: composer.ref }))
    await act(async () => { useAgentStore.setState({ isAgentWorking: false }) })

    expect(sendMessage).not.toHaveBeenCalled()
    expect(removePendingMessage).not.toHaveBeenCalled()
    expect(queued()).toEqual(['then do this'])
  })

  it('returns held messages to the composer instead of following a failed turn', async () => {
    const sendMessage = sendThatStartsATurn()
    useAgentStore.setState({
      sendMessage,
      removePendingMessage: cancelThatSucceeds(),
      agentStreams: { lead: { ...createDefaultAgentStream(), status: 'error' } },
      _pendingMessages: [heldMessage('h1', 'then do this @src/a.ts', { mentions: ['src/a.ts'] })],
    })
    const composer = fakeComposer()

    renderHook(() => useReturnQueuedAfterFailure({ sessionId: 's1', composerRef: composer.ref }))
    await act(async () => { useAgentStore.setState({ isAgentWorking: false }) })

    expect(sendMessage).not.toHaveBeenCalled()
    // Mentions come back too, so the files are still attached when resent.
    expect(composer.appended).toEqual([{ text: 'then do this @src/a.ts', paragraph: true, mentions: ['src/a.ts'] }])
    expect(queued()).toEqual([])
  })

  it('waits for the session history before trusting an idle agent', async () => {
    const removePendingMessage = cancelThatSucceeds()
    useAgentStore.setState({
      removePendingMessage,
      isAgentWorking: false,
      _syncedThrough: null,
      agentStreams: { lead: { ...createDefaultAgentStream(), status: 'error' } },
      _pendingMessages: [heldMessage('h1', 'then do this')],
    })
    const composer = fakeComposer()

    renderHook(() => useReturnQueuedAfterFailure({ sessionId: 's1', composerRef: composer.ref }))
    expect(removePendingMessage).not.toHaveBeenCalled()

    await act(async () => { useAgentStore.setState({ _syncedThrough: '2026-01-01T00:00:00Z' }) })
    expect(removePendingMessage).toHaveBeenCalledTimes(1)
  })

  // Steers the failed turn never read come back too, ahead of the held
  // messages (that is the order they would have gone out in).
  it('returns unread steers to the composer after a failed turn, ahead of held messages', async () => {
    const steerFile = new File(['z'], 'spec.md', { type: 'text/markdown' })
    const removePendingMessage = cancelThatSucceeds()
    useAgentStore.setState({
      sendMessage: sendThatStartsATurn(),
      removePendingMessage,
      agentStreams: { lead: { ...createDefaultAgentStream(), status: 'error' } },
      _pendingMessages: [
        heldMessage('h3', 'then do this'),
        { id: 'q1', sessionId: 's1', content: 'steer it', submittedAt: 1, files: [steerFile], attachments: [{ original_name: 'spec.md', media_type: 'text/markdown', category: 'document' }] },
        { id: 'q-other', sessionId: 's2', content: 'elsewhere', submittedAt: 2 },
      ],
    })
    const composer = fakeComposer()

    renderHook(() => useReturnQueuedAfterFailure({ sessionId: 's1', composerRef: composer.ref }))
    await act(async () => { useAgentStore.setState({ isAgentWorking: false }) })

    expect(removePendingMessage.mock.calls.map((c) => c[0])).toEqual(['q1', 'h3'])
    expect(composer.appended).toEqual([{ text: 'steer it\n\nthen do this', paragraph: true }])
    expect(composer.added).toEqual([steerFile])
    expect(queued()).toEqual(['elsewhere'])
  })

  it('returns a failed turn\'s steers', async () => {
    const removePendingMessage = mock(async () => 'cancelled' as const)
    useAgentStore.setState({
      removePendingMessage,
      agentStreams: { lead: { ...createDefaultAgentStream(), status: 'error' } },
      _pendingMessages: [{ id: 'q1', sessionId: 's1', content: 'steer it', submittedAt: 1 }],
    })
    const composer = fakeComposer()

    renderHook(() => useReturnQueuedAfterFailure({ sessionId: 's1', composerRef: composer.ref }))
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

    renderHook(() => useReturnQueuedAfterFailure({ sessionId: 's1', composerRef: composer.ref }))
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

    renderHook(() => useReturnQueuedAfterFailure({ sessionId: 's1', composerRef: composer.ref }))
    await act(async () => { useAgentStore.setState({ isAgentWorking: false }) })

    expect(composer.appended).toEqual([])
  })
})

describe('stopTurn', () => {
  it('calls held messages off and hands them back to the composer before stopping the turn', async () => {
    const order: string[] = []
    const stopAgent = mock(async () => { order.push('stop') })
    const notes = new File(['y'], 'notes.md', { type: 'text/markdown' })
    useAgentStore.setState({
      stopAgent,
      removePendingMessage: cancelThatSucceeds(order),
      _pendingMessages: [
        heldMessage('h1', 'first', { files: [notes], attachments: [{ original_name: 'notes.md', media_type: 'text/markdown', category: 'document' }] }),
        heldMessage('h2', 'elsewhere', { sessionId: 's2' }),
      ],
    })
    const composer = fakeComposer()
    composer.ref.current.appendValue = (text) => { order.push(`restore ${text}`) }

    await stopTurn(composer.ref.current)

    expect(order).toEqual(['cancel h1', 'restore first', 'stop'])
    expect(composer.added).toEqual([notes])
    expect(queued()).toEqual(['elsewhere'])
  })

  // After a reload the held message comes from history with its server id,
  // so Stop still calls it off.
  it('calls off a held message loaded after a reload', async () => {
    const stopAgent = mock(async () => {})
    useAgentStore.setState({ stopAgent, removePendingMessage: cancelThatSucceeds(), _pendingMessages: [heldMessage('h1', 'then deploy')] })
    const composer = fakeComposer()

    await stopTurn(composer.ref.current)

    expect(composer.appended).toEqual([{ text: 'then deploy', paragraph: true }])
    expect(queued()).toEqual([])
  })

  // Stop calls off a steer the agent has not read yet, as it does a held
  // message, instead of leaving it in history unanswered. The cancel goes
  // first: the interrupt would release unread steers into the transcript.
  it('calls off unread steers and held messages before stopping, in the order they were sent', async () => {
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
        heldMessage('h4', 'then this'),
      ],
    })
    const composer = fakeComposer()
    composer.ref.current.appendValue = (text) => { order.push(`restore ${text}`) }

    await stopTurn(composer.ref.current)

    expect(order).toEqual(['cancel q1', 'cancel q2', 'cancel h4', 'restore first steer\n\nsecond steer\n\nthen this', 'stop'])
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
      _pendingMessages: [{ id: 'q1', sessionId: 's1', content: 'too late', submittedAt: 1 }, heldMessage('h2', 'then this')],
    })
    removePendingMessage.mockImplementation(async (...args: unknown[]) => (String(args[0]) === 'q1' ? 'sent' : 'cancelled') as never)
    const composer = fakeComposer()

    await stopTurn(composer.ref.current)

    expect(composer.appended).toEqual([{ text: 'then this', paragraph: true }])
    expect(stopAgent).toHaveBeenCalledTimes(1)
  })
})

describe('deliverFromComposer', () => {
  it('offers Resume after a Stop, which sends "Continue"', async () => {
    const sendMessage = sendThatStartsATurn()
    useAgentStore.setState({ sendMessage, isAgentWorking: false })
    useToastStore.setState({ toasts: [] })
    pushStoppedToast('/repo', () => fakeComposer().ref.current)

    const toast = useToastStore.getState().toasts[0]
    expect(toast.title).toBe('Stopped')
    expect(toast.action?.label).toBe('Resume')
    toast.action?.onAction()
    await Promise.resolve()
    expect(sendMessage.mock.calls[0][0]).toBe('Continue')
  })

  // Held on the server, so it still goes out if this client closes or reloads.
  it('sends a message the server holds for the end of the running turn', async () => {
    const sendMessage = sendThatStartsATurn()
    useAgentStore.setState({ sendMessage, sessionModel: 'gpt-5' })
    const composer = fakeComposer()

    await deliverFromComposer('/repo', composer.ref.current, { content: 'then run the tests', mentions: ['a.ts'] }, 'after-turn')

    expect(sendMessage.mock.calls).toEqual([[
      'then run the tests',
      undefined,
      { workspace: '/repo', model: 'gpt-5', thinkingLevel: null, fastMode: false, mentions: ['a.ts'], holdUntilTurnEnd: true },
    ]])
  })

  it('gives a held message back to the composer when the server never took it', async () => {
    let restored = 0
    useAgentStore.setState({ sendMessage: mock(async () => false) })
    const composer = fakeComposer()
    composer.ref.current.restoreLastSubmission = () => { restored += 1 }

    await deliverFromComposer('/repo', composer.ref.current, { content: 'later' }, 'after-turn')

    expect(restored).toBe(1)
  })

  it('sends straight away when there is no turn to wait for', async () => {
    const sendMessage = sendThatStartsATurn()
    useAgentStore.setState({ sendMessage, isAgentWorking: false })
    const composer = fakeComposer()

    await deliverFromComposer('/repo', composer.ref.current, { content: 'hello' }, 'after-turn')

    expect(sendMessage.mock.calls[0][0]).toBe('hello')
    expect((sendMessage.mock.calls[0] as unknown[])[2]).not.toHaveProperty('holdUntilTurnEnd')
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

  // Unread steers go along with the stop as context; held messages come back.
  it('hands held messages back after the replacement, once a failed draft has restored itself', async () => {
    const order: string[] = []
    useAgentStore.setState({
      stopAgent: mock(async () => { order.push('stop') }),
      sendMessage: mock(async () => { order.push('send'); return false }),
      removePendingMessage: cancelThatSucceeds(order),
      _pendingMessages: [{ id: 'q1', sessionId: 's1', content: 'a steer', submittedAt: 1 }, heldMessage('h2', 'later')],
    })
    const composer = fakeComposer()
    composer.ref.current.restoreLastSubmission = () => { order.push('restore draft') }
    composer.ref.current.appendValue = (text) => { order.push(`return ${text}`) }

    await deliverFromComposer('/repo', composer.ref.current, { content: 'do this instead' }, 'interrupt')

    expect(order).toEqual(['cancel h2', 'stop', 'send', 'restore draft', 'return later'])
    expect(queued()).toEqual(['a steer'])
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

  // A send that never lands is felt as an error, as a failed git action is.
  it('buzzes an error when the message never lands, and not when it does', async () => {
    const composer = fakeComposer()
    useAgentStore.setState({ sendMessage: sendThatStartsATurn(true), isAgentWorking: false })
    await deliverFromComposer('/repo', composer.ref.current, { content: 'fine' }, 'steer')
    expect(outcomeHapticFeedback).not.toHaveBeenCalled()

    useAgentStore.setState({ sendMessage: mock(async () => false), isAgentWorking: false })
    await deliverFromComposer('/repo', composer.ref.current, { content: 'broken' }, 'steer')
    expect(outcomeHapticFeedback.mock.calls).toEqual([['error']])
  })
})

describe('planComposerDelivery', () => {
  it.each([
    [true, 's1', 'after-turn', { kind: 'hold', sessionId: 's1' }],
    [true, 's1', 'interrupt', { kind: 'stop_then_send' }],
    [true, 's1', 'steer', { kind: 'send' }],
    [false, 's1', 'after-turn', { kind: 'send' }],
    [false, 's1', 'interrupt', { kind: 'send' }],
    [true, null, 'after-turn', { kind: 'send' }],
    [true, null, 'interrupt', { kind: 'stop_then_send' }],
  ] as const)('working=%p session=%p %s -> %o', (working, sessionId, delivery, expected) => {
    expect(planComposerDelivery({ working, sessionId, delivery })).toEqual(expected)
  })
})

describe('decideQueuedAfterFailure', () => {
  const failed = { hasTarget: true, idle: true, returning: false, turnFailed: true, queuedCount: 1 }

  it('returns queued messages after a failed turn', () => {
    expect(decideQueuedAfterFailure(failed)).toEqual({ kind: 'return_to_composer' })
  })

  it('waits on a turn that ended well: the server sends held messages itself', () => {
    expect(decideQueuedAfterFailure({ ...failed, turnFailed: false })).toEqual({ kind: 'wait' })
  })

  it('waits without a session, while a turn may run, mid-return, or with nothing queued', () => {
    expect(decideQueuedAfterFailure({ ...failed, hasTarget: false })).toEqual({ kind: 'wait' })
    expect(decideQueuedAfterFailure({ ...failed, idle: false })).toEqual({ kind: 'wait' })
    expect(decideQueuedAfterFailure({ ...failed, returning: true })).toEqual({ kind: 'wait' })
    expect(decideQueuedAfterFailure({ ...failed, queuedCount: 0 })).toEqual({ kind: 'wait' })
  })
})
