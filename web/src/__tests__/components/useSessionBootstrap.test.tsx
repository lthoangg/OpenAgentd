import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { createRef } from 'react'
import { cleanup, render, waitFor } from '@testing-library/react'
import { QueryClient } from '@tanstack/react-query'
import { useSessionBootstrap } from '@/components/TeamChatView/useSessionBootstrap'
import type { InputBarHandle } from '@/components/InputBar'
import { useTeamStore } from '@/stores/useTeamStore'

function Harness({
  loadSession,
  connectStream,
}: {
  loadSession: (sessionId: string, workspace?: string | null) => Promise<void>
  connectStream: () => AbortController
}) {
  useSessionBootstrap({
    sessionId: 'session-1',
    mode: 'normal',
    workspace: null,
    agentWorkspace: null,
    hasCodingWorkspace: false,
    isCodingSessionLoading: false,
    isMobile: true,
    paletteOpen: false,
    sessionIdState: 'session-1',
    sessionModel: null,
    sessionThinkingLevel: null,
    sessionTitle: null,
    isTeamWorking: true,
    inputRef: createRef<InputBarHandle>(),
    navigate: mock(() => {}) as never,
    queryClient: new QueryClient(),
    connectStream,
    loadTeamStatus: mock(async () => {}),
    loadSession,
    beginResolvedSession: mock(() => {}),
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
