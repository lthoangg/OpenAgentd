import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { createRef } from 'react'
import type { RefObject } from 'react'
import { cleanup, render, waitFor } from '@testing-library/react'
import { QueryClient } from '@tanstack/react-query'
import { useSessionBootstrap } from '@/components/TeamChatView/useSessionBootstrap'
import type { UseSessionBootstrapArgs } from '@/components/TeamChatView/useSessionBootstrap'
import type { InputComposerHandle } from '@/components/InputComposer'
import { useTeamStore } from '@/stores/useTeamStore'
import { createDefaultAgentStream } from '@/stores/useTeamStore/defaults'

function Harness({
  loadSession,
  connectStream,
  sessionId = 'session-1',
  beginResolvedSession = mock(() => {}),
  inputRef,
}: {
  loadSession: (sessionId: string, workspace?: string | null) => Promise<void>
  connectStream: () => AbortController
  sessionId?: string
  beginResolvedSession?: UseSessionBootstrapArgs['beginResolvedSession']
  inputRef?: RefObject<InputComposerHandle | null>
}) {
  useSessionBootstrap({
    sessionId,
    mode: 'normal',
    workspace: null,
    agentWorkspace: null,
    hasCodingWorkspace: false,
    isCodingSessionLoading: false,
    isMobile: true,
    paletteOpen: false,
    sessionIdState: sessionId,
    sessionModel: null,
    sessionThinkingLevel: null,
    sessionTitle: null,
    isTeamWorking: true,
    inputRef: inputRef ?? createRef<InputComposerHandle>(),
    navigate: mock(() => {}) as never,
    queryClient: new QueryClient(),
    connectStream,
    loadTeamStatus: mock(async () => {}),
    loadSession,
    beginResolvedSession,
    consumeResolvedSessionReady: mock(() => false),
  })
  return null
}

beforeEach(() => {
  useTeamStore.setState({
    sessionId: 'session-1',
    _workspace: null,
    isConnected: true,
    isTeamWorking: true,
    _unloading: false,
    _abortController: null,
  })
})

afterEach(cleanup)

describe('useSessionBootstrap foreground resume', () => {
  it('reconciles history and replaces a stale connected stream after pageshow', async () => {
    const loadSession = mock(async () => {
      useTeamStore.setState({ isTeamWorking: true })
    })
    const connectStream = mock(() => new AbortController())
    render(<Harness loadSession={loadSession} connectStream={connectStream} />)

    window.dispatchEvent(new Event('pageshow'))

    await waitFor(() => expect(loadSession).toHaveBeenCalledWith('session-1', null))
    expect(connectStream).toHaveBeenCalledTimes(1)
  })
})

describe('useSessionBootstrap session switch', () => {
  it('drops the previous session live stream when the route switches sessions', async () => {
    useTeamStore.setState({
      sessionId: 'session-1',
      sessionTitle: 'Session one',
      leadName: 'lead',
      agentNames: ['lead'],
      activeAgent: 'lead',
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
        beginResolvedSession={useTeamStore.getState().beginResolvedSession}
      />,
    )

    await waitFor(() => expect(loadSession).toHaveBeenCalledWith('session-2', null))
    const state = useTeamStore.getState()
    expect(state.sessionId).toBe('session-2')
    expect(state.isTeamWorking).toBe(false)
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
      useTeamStore.setState({
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
        beginResolvedSession={useTeamStore.getState().beginResolvedSession}
      />,
    )

    await waitFor(() => expect(loadSession).toHaveBeenCalledWith('session-2', null))
    await waitFor(() => expect(setValueMock).toHaveBeenCalledWith('the real undone message'))

    expect(setValueMock).toHaveBeenCalledWith('the real undone message')
    expect(setValueMock).not.toHaveBeenCalledWith('Session compacted')
  })
})
