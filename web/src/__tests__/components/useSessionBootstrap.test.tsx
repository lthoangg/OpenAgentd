import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { createRef } from 'react'
import type { RefObject } from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'

// Whether the OS drops background sockets (iOS/Android) decides if a resume
// must reconnect. Toggled per test; defaults to the mobile behaviour.
let suspendsSockets = true
mock.module('@/hooks/use-platform', () => ({
  backgroundSuspendsSockets: () => suspendsSockets,
}))

import { useSessionBootstrap } from '@/components/AgentChatView/useSessionBootstrap'
import type { UseSessionBootstrapArgs } from '@/components/AgentChatView/useSessionBootstrap'
import type { InputComposerHandle } from '@/components/InputComposer'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { _resetKeyboardForTests } from '@/lib/keyboard/dispatcher'
import { useAgentStore } from '@/stores/useAgentStore'
import { createDefaultAgentStream } from '@/stores/useAgentStore/defaults'

function Harness({
  loadSession,
  connectStream,
  sessionId = 'session-1',
  workspace = '/repo/app',
  navigate = mock(() => {}),
  beginResolvedSession = mock(() => {}),
  inputRef,
  isMobile = true,
  onResult,
  loadAgentStatus = mock(async () => {}),
}: {
  loadSession: (sessionId: string, workspace?: string | null) => Promise<void>
  connectStream: () => AbortController
  /** ``null`` is a new-session draft (no session yet). */
  sessionId?: string | null
  workspace?: string
  navigate?: (...args: unknown[]) => unknown
  isMobile?: boolean
  beginResolvedSession?: UseSessionBootstrapArgs['beginResolvedSession']
  inputRef?: RefObject<InputComposerHandle | null>
  onResult?: (result: ReturnType<typeof useSessionBootstrap>) => void
  loadAgentStatus?: UseSessionBootstrapArgs['loadAgentStatus']
}) {
  const result = useSessionBootstrap({
    sessionId: sessionId ?? undefined,
    workspace,
    agentWorkspace: workspace,
    hasWorkspace: true,
    isSessionLoading: false,
    isMobile,
    paletteOpen: false,
    sessionTitle: null,
    isAgentWorking: true,
    inputRef: inputRef ?? createRef<InputComposerHandle>(),
    navigate: navigate as never,
    connectStream,
    loadAgentStatus,
    loadSession,
    beginResolvedSession,
    consumeResolvedSessionReady: mock(() => false),
  })
  onResult?.(result)
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

afterEach(() => {
  cleanup()
  _resetKeyboardForTests()
})

describe('useSessionBootstrap type-to-focus', () => {
  function composer(insertText: (text: string) => void): RefObject<InputComposerHandle | null> {
    const inputRef = createRef<InputComposerHandle>()
    inputRef.current = {
      focus: () => {},
      setValue: () => {},
      appendValue: () => {},
      insertText,
      setFiles: () => {},
      addFiles: () => {},
      restoreLastSubmission: () => {},
      addDesignFeedback: () => {},
    }
    return inputRef
  }
  const type = (target: EventTarget, key: string) => {
    act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })) })
  }

  it('sends a letter typed outside any field to the composer', () => {
    const insertText = mock((_text: unknown) => {})
    render(<Harness isMobile={false} loadSession={mock(async () => {})} connectStream={() => new AbortController()} inputRef={composer(insertText)} />)
    type(document.body, 'h')
    expect(insertText).toHaveBeenCalledWith('h')
  })

  it('keeps letters typed in a dialog out of the composer behind it', () => {
    const insertText = mock((_text: unknown) => {})
    render(
      <>
        <Harness isMobile={false} loadSession={mock(async () => {})} connectStream={() => new AbortController()} inputRef={composer(insertText)} />
        <Dialog open onOpenChange={() => {}}>
          <DialogContent><DialogTitle>Delete session?</DialogTitle><button type="button">Cancel</button></DialogContent>
        </Dialog>
      </>,
    )
    type(screen.getByRole('button', { name: 'Cancel' }), 'h')
    expect(insertText).not.toHaveBeenCalled()
  })
})

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

  it('asks for the agent status of the session it switches to', async () => {
    // The store still holds session-1 here. Sending that id with this
    // workspace once started session-1 in the wrong workspace on the server.
    const loadAgentStatus = mock(async () => {})
    render(
      <Harness
        sessionId="session-2"
        loadSession={mock(async () => {})}
        connectStream={mock(() => new AbortController())}
        beginResolvedSession={useAgentStore.getState().beginResolvedSession}
        loadAgentStatus={loadAgentStatus}
      />,
    )
    await waitFor(() => expect(loadAgentStatus).toHaveBeenCalledWith('/repo/app', undefined, 'session-2'))
  })
})

describe('useSessionBootstrap undo draft-restore', () => {
  // Regression: `revertedMessages` is a *display* preview where every entry
  // (including a reverted `compaction` block) is normalized to
  // `role: 'user'` for RevertNotice's rendering — so `.find(m => m.role ===
  // 'user')` always matches the first entry regardless of its real type. If
  // an undo boundary lands right before a compaction, that first entry is
  // the "Earlier messages summarized" placeholder, and the composer must not be
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
      addDesignFeedback: () => {},
    }

    const loadSession = mock(async () => {
      useAgentStore.setState({
        leadName: 'lead',
        agentStreams: {
          lead: {
            ...createDefaultAgentStream(),
            revertedCount: 2,
            revertedMessages: [
              { role: 'user', content: 'Earlier messages summarized' },
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
    expect(setValueMock).not.toHaveBeenCalledWith('Earlier messages summarized')
  })
})

describe('useSessionBootstrap remount on screen switch', () => {
  it('adds a file line comment to the composer as a real mention', async () => {
    const inputRef = createRef<InputComposerHandle>()
    const appendValue = mock((..._args: unknown[]) => {})
    inputRef.current = {
      focus: () => {},
      setValue: () => {},
      appendValue,
      insertText: () => {},
      setFiles: () => {},
      addFiles: () => {},
      restoreLastSubmission: () => {},
      addDesignFeedback: () => {},
    }
    let result: ReturnType<typeof useSessionBootstrap> | null = null
    render(
      <Harness
        loadSession={mock(async () => {})}
        connectStream={mock(() => new AbortController())}
        inputRef={inputRef}
        onResult={(r) => { result = r }}
      />,
    )
    result!.handleAddFileComment('src/a.ts', 3, 5)
    expect(appendValue).toHaveBeenCalledWith('@src/a.ts#L3-L5 ', { mentions: ['src/a.ts#L3-L5'] })
  })

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

  it('does not abort or clobber an active stream connected externally', async () => {
    const externalController = new AbortController()
    useAgentStore.setState({
      sessionId: 'session-1',
      _workspace: '/repo/app',
      isConnected: true,
      isAgentWorking: true,
      _unloading: false,
      _abortController: externalController,
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

    expect(loadSession).not.toHaveBeenCalled()
    expect(connectStream).not.toHaveBeenCalled()
    expect(externalController.signal.aborted).toBe(false)
  })

  it('adopts active store._abortController across renders even if previous controller was aborted', async () => {
    const deadController = new AbortController()
    deadController.abort()
    const liveController = new AbortController()

    useAgentStore.setState({
      sessionId: 'session-1',
      _workspace: '/repo/app',
      isConnected: true,
      isAgentWorking: true,
      _unloading: false,
      _abortController: liveController,
    })

    const loadSession = mock(async () => {})
    const connectStream = mock(() => new AbortController())

    const { rerender } = render(
      <Harness
        sessionId="session-1"
        loadSession={loadSession}
        connectStream={connectStream}
      />,
    )

    expect(loadSession).not.toHaveBeenCalled()
    expect(connectStream).not.toHaveBeenCalled()
    expect(liveController.signal.aborted).toBe(false)

    rerender(
      <Harness
        sessionId="session-1"
        loadSession={loadSession}
        connectStream={connectStream}
      />,
    )

    expect(loadSession).not.toHaveBeenCalled()
    expect(connectStream).not.toHaveBeenCalled()
    expect(liveController.signal.aborted).toBe(false)
  })
})

describe('useSessionBootstrap new-session draft', () => {
  const resolveCalls: unknown[] = []
  const originalFetch = globalThis.fetch

  function composerRef(setValue: (value: string) => void = () => {}): RefObject<InputComposerHandle | null> {
    const inputRef = createRef<InputComposerHandle>()
    inputRef.current = {
      focus: () => {},
      setValue,
      appendValue: () => {},
      insertText: () => {},
      setFiles: () => {},
      addFiles: () => {},
      restoreLastSubmission: () => {},
      addDesignFeedback: () => {},
    }
    return inputRef
  }

  beforeEach(() => {
    resolveCalls.length = 0
    globalThis.fetch = mock(async (input: unknown) => {
      resolveCalls.push(input)
      return new Response('{}')
    }) as unknown as typeof fetch
    localStorage.removeItem('oa.drafts.composer.v1')
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('opens a draft for the workspace without creating a session', () => {
    useAgentStore.setState({ sessionId: 'session-1', isAgentWorking: false, isConnected: false })
    const navigate = mock((..._args: unknown[]) => {})
    let result: ReturnType<typeof useSessionBootstrap> | null = null
    render(
      <Harness
        loadSession={mock(async () => {
          useAgentStore.setState({
            leadName: 'lead',
            agentNames: ['lead'],
            agentStreams: { lead: { ...createDefaultAgentStream(), blocks: [{ id: 'u1', type: 'user', content: 'hi' }] } },
          })
        })}
        connectStream={mock(() => new AbortController())}
        navigate={navigate}
        inputRef={composerRef()}
        onResult={(r) => { result = r }}
      />,
    )
    act(() => { result!.handleNewSession() })
    expect(navigate).toHaveBeenCalledWith({ to: '/', search: { workspace: '/repo/app' }, replace: false })
    expect(useAgentStore.getState().sessionId).toBeNull()
    expect(useAgentStore.getState()._workspace).toBe('/repo/app')
    // No session is resolved or created up front.
    expect(resolveCalls.some((call) => String(call).includes('/sessions/resolve'))).toBe(false)
  })

  it('does nothing on an empty draft of the same workspace', () => {
    useAgentStore.setState({ sessionId: null, isAgentWorking: false })
    const navigate = mock((..._args: unknown[]) => {})
    let result: ReturnType<typeof useSessionBootstrap> | null = null
    render(
      <Harness
        sessionId={null}
        loadSession={mock(async () => {})}
        connectStream={mock(() => new AbortController())}
        navigate={navigate}
        inputRef={composerRef()}
        onResult={(r) => { result = r }}
      />,
    )
    act(() => { result!.handleNewSession() })
    expect(navigate).not.toHaveBeenCalled()
  })

  it('keeps unsent draft text per folder and hands it to the session the first message creates', () => {
    useAgentStore.setState({ sessionId: null, isAgentWorking: false })
    const setValue = mock((..._args: unknown[]) => {})
    let result: ReturnType<typeof useSessionBootstrap> | null = null
    const { rerender } = render(
      <Harness
        sessionId={null}
        loadSession={mock(async () => {})}
        connectStream={mock(() => new AbortController())}
        inputRef={composerRef(setValue)}
        onResult={(r) => { result = r }}
      />,
    )
    // Writes are debounced; a page hide flushes them.
    const stored = () => {
      window.dispatchEvent(new Event('pagehide'))
      return JSON.parse(localStorage.getItem('oa.drafts.composer.v1') ?? '[]') as Array<[string, { value: string }]>
    }
    act(() => { result!.handleDraftValueChange('half a thought') })
    expect(stored()).toContainEqual(['draft:/repo/app', { value: 'half a thought' }])

    // Another folder: the typed text comes along.
    rerender(
      <Harness
        sessionId={null}
        workspace="/repo/other"
        loadSession={mock(async () => {})}
        connectStream={mock(() => new AbortController())}
        inputRef={composerRef(setValue)}
        onResult={(r) => { result = r }}
      />,
    )
    expect(stored()).toContainEqual(['draft:/repo/other', { value: 'half a thought' }])
    expect(stored().some(([key]) => key === 'draft:/repo/app')).toBe(false)

    // The first message creates the session: the draft moves to its id.
    act(() => { useAgentStore.setState({ sessionId: 'new-session' }) })
    expect(stored()).toContainEqual(['new-session', { value: 'half a thought' }])
    expect(stored().some(([key]) => key === 'draft:/repo/other')).toBe(false)
  })
})
