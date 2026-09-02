import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { createRef } from 'react'
import type { RefObject } from 'react'
import { cleanup, render, waitFor } from '@testing-library/react'
import { QueryClient } from '@tanstack/react-query'

// Whether the OS drops background sockets (iOS/Android) decides if a resume
// must reconnect. Toggled per test; defaults to the mobile behaviour.
let suspendsSockets = true
mock.module('@/hooks/use-platform', () => ({
  backgroundSuspendsSockets: () => suspendsSockets,
}))

import { useSessionBootstrap } from '@/components/AgentChatView/useSessionBootstrap'
import type { UseSessionBootstrapArgs } from '@/components/AgentChatView/useSessionBootstrap'
import type { InputComposerHandle } from '@/components/InputComposer'
import { useAgentStore } from '@/stores/useAgentStore'
import { createDefaultAgentStream } from '@/stores/useAgentStore/defaults'

function Harness({
  loadSession,
  connectStream,
  sessionId = 'session-1',
  beginResolvedSession = mock(() => {}),
  inputRef,
  isMobile = true,
}: {
  loadSession: (sessionId: string, workspace?: string | null) => Promise<void>
  connectStream: () => AbortController
  sessionId?: string
  isMobile?: boolean
  beginResolvedSession?: UseSessionBootstrapArgs['beginResolvedSession']
  inputRef?: RefObject<InputComposerHandle | null>
}) {
  useSessionBootstrap({
    sessionId,
    workspace: '/repo/app',
    agentWorkspace: '/repo/app',
    hasCodingWorkspace: true,
    isCodingSessionLoading: false,
    isMobile,
    paletteOpen: false,
    sessionModel: null,
    sessionThinkingLevel: null,
    sessionTitle: null,
    isAgentWorking: true,
    inputRef: inputRef ?? createRef<InputComposerHandle>(),
    navigate: mock(() => {}) as never,
    queryClient: new QueryClient(),
    connectStream,
    loadAgentStatus: mock(async () => {}),
    loadSession,
    beginResolvedSession,
    consumeResolvedSessionReady: mock(() => false),
  })
  return null
}

beforeEach(() => {
  suspendsSockets = true
  useAgentStore.setState({
    sessionId: 'session-1',
    _workspace: null,
    isConnected: true,
    isAgentWorking: true,
    _unloading: false,
    _abortController: null,
  })
})

afterEach(cleanup)

describe('useSessionBootstrap foreground resume', () => {
  it('reconciles history and replaces a stale connected stream after pageshow on mobile', async () => {
    suspendsSockets = true
    const loadSession = mock(async () => {
      useAgentStore.setState({ isAgentWorking: true })
    })
    const connectStream = mock(() => new AbortController())
    render(<Harness loadSession={loadSession} connectStream={connectStream} />)

    await waitFor(() => expect(loadSession).toHaveBeenCalledWith('session-1', '/repo/app'))
    expect(connectStream).toHaveBeenCalledTimes(1)

    loadSession.mockClear()
    connectStream.mockClear()
    useAgentStore.setState({ _workspace: '/repo/app' })

    window.dispatchEvent(new Event('pageshow'))

    await waitFor(() => expect(loadSession).toHaveBeenCalledWith('session-1', '/repo/app'))
    expect(connectStream).toHaveBeenCalledTimes(1)
  })

  it('does NOT abort or replace a live connected stream on visibilitychange on desktop', async () => {
    suspendsSockets = false
    const loadSession = mock(async () => {})
    const connectStream = mock(() => new AbortController())
    render(<Harness loadSession={loadSession} connectStream={connectStream} />)

    await waitFor(() => expect(loadSession).toHaveBeenCalledWith('session-1', '/repo/app'))
    expect(connectStream).toHaveBeenCalledTimes(1)

    loadSession.mockClear()
    connectStream.mockClear()

    useAgentStore.setState({
      sessionId: 'session-1',
      _workspace: null,
      isConnected: true,
      isAgentWorking: true,
    })

    // Simulate returning to the app on desktop
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))

    expect(loadSession).not.toHaveBeenCalled()
    expect(connectStream).not.toHaveBeenCalled()
  })
})

describe('useSessionBootstrap session switch', () => {
  it('drops the previous session live stream when the route switches sessions', async () => {
    useAgentStore.setState({
      sessionId: 'session-1',
      sessionTitle: 'Session one',
      leadName: 'lead',
      agentNames: ['lead'],
      agentStreams: {
        lead: {
          ...createDefaultAgentStream(),
          status: 'working',
          currentText: 'streaming in session one',
          currentBlocks: [{ id: 'b1', type: 'text', content: 'streaming in session one' }],
        },
      },
    })

    // Session history for the target session has not resolved yet — the UI must
    // already be free of session-1's live turn at this point.
    const loadSession = mock(async () => {})
    const connectStream = mock(() => new AbortController())
    render(
      <Harness
        sessionId="session-2"
        loadSession={loadSession}
        connectStream={connectStream}
        beginResolvedSession={useAgentStore.getState().beginResolvedSession}
      />,
    )

    await waitFor(() => expect(loadSession).toHaveBeenCalledWith('session-2', '/repo/app'))
    const state = useAgentStore.getState()
    expect(state.sessionId).toBe('session-2')
    expect(state.isAgentWorking).toBe(false)
    expect(state.sessionTitle).toBeNull()
    expect(state.agentStreams.lead.currentBlocks).toHaveLength(0)
    expect(state.agentStreams.lead.currentText).toBe('')
    expect(state.agentStreams.lead.status).toBe('idle')
  })
})

describe('useSessionBootstrap undo draft-restore', () => {
  // Regression: `revertedMessages` is a *display* preview where every entry
  // (including a reverted `compaction` block) is normalized to
  // `role: 'user'` for RevertNotice's rendering — so `.find(m => m.role ===
  // 'user')` always matches the first entry regardless of its real type. If
  // an undo boundary lands right before a compaction, that first entry is
  // the "Session compacted" placeholder, and the composer must not be
  // pre-filled with it instead of the human's actual undone text.
  it('skips a leading reverted compaction block and restores the real undone user text', async () => {
    const inputRef = createRef<InputComposerHandle>()
    const setValueMock = mock(() => {})
    const setFilesMock = mock(() => {})
    inputRef.current = {
      focus: () => {},
      setValue: setValueMock,
      appendValue: () => {},
      insertText: () => {},
      setFiles: setFilesMock,
      addFiles: () => {},
      restoreLastSubmission: () => {},
    }

    const loadSession = mock(async () => {
      useAgentStore.setState({
        leadName: 'lead',
        agentStreams: {
          lead: {
            ...createDefaultAgentStream(),
            revertedCount: 2,
            revertedMessages: [
              { role: 'user', content: 'Session compacted' },
              { role: 'user', content: 'the real undone message' },
            ],
            _revertedSuffix: [
              { id: 'c1', type: 'compaction', content: 'ignored body' },
              { id: 'u2', type: 'user', content: 'the real undone message' },
            ],
          },
        },
      })
    })
    const connectStream = mock(() => new AbortController())

    // Use a session id distinct from the `beforeEach` seed so the bootstrap
    // effect takes the "switching sessions" branch (which awaits
    // `loadSession` before restoring the draft) instead of bailing out early
    // because the store already thinks it is connected to this session.
    render(
      <Harness
        sessionId="session-2"
        loadSession={loadSession}
        connectStream={connectStream}
        inputRef={inputRef}
        beginResolvedSession={useAgentStore.getState().beginResolvedSession}
      />,
    )

    await waitFor(() => expect(loadSession).toHaveBeenCalledWith('session-2', '/repo/app'))
    await waitFor(() => expect(setValueMock).toHaveBeenCalledWith('the real undone message'))

    expect(setValueMock).toHaveBeenCalledWith('the real undone message')
    expect(setValueMock).not.toHaveBeenCalledWith('Session compacted')
  })
})

describe('useSessionBootstrap remount on screen switch', () => {
  it('loads history and connects stream when mounting for an already-active session', async () => {
    useAgentStore.setState({
      sessionId: 'session-1',
      _workspace: null,
      isConnected: true,
      isAgentWorking: true,
      _unloading: false,
      _abortController: null,
    })

    const loadSession = mock(async () => {})
    const connectStream = mock(() => new AbortController())

    render(
      <Harness
        sessionId="session-1"
        loadSession={loadSession}
        connectStream={connectStream}
      />,
    )

    await waitFor(() => expect(loadSession).toHaveBeenCalledWith('session-1', '/repo/app'))
    expect(connectStream).toHaveBeenCalledTimes(1)
  })
})
