import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { forwardRef, useImperativeHandle } from 'react'
import { AgentChatView } from '@/components/AgentChatView'

let agentsLoading = false
let healthError = false
let workspaceTree: unknown = undefined
const setValueMock = mock(() => {})
const setFilesMock = mock(() => {})
const navigateMock = mock((_options: unknown) => Promise.resolve())

mock.module('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
}))

mock.module('@tanstack/react-query', () => ({
  useQueryClient: () => ({}),
  useQuery: (options: { queryKey?: readonly unknown[] }) => ({
    data: options?.queryKey?.[0] === 'coding-workspace-tree' ? workspaceTree : undefined,
    isLoading: false,
  }),
  useInfiniteQuery: () => ({ data: undefined, isLoading: false }),
  QueryClientProvider: ({ children }: { children: unknown }) => children,
}))

mock.module('@/queries/useTodosQuery', () => ({ useTodosQuery: () => ({ data: { todos: [] } }) }))
mock.module('@/queries/useSessionPlanQuery', () => ({
  useSessionPlanQuery: () => ({ data: { plan: null } }),
  useClearSessionPlanMutation: () => ({ mutate: () => {} }),
}))
mock.module('@/queries/useSessionGoalQuery', () => ({
  useSessionGoalQuery: () => ({ data: undefined }),
  useGoalActionMutation: () => ({ mutate: () => {} }),
  useGoalControls: () => undefined,
}))
mock.module('@/queries', () => ({
  useProvidersQuery: () => ({ data: { providers: [] } }),
  useHealthQuery: () => ({ isSuccess: !healthError, isError: healthError }),
}))
mock.module('@/queries/useCommandsQuery', () => ({ useCommandsQuery: () => ({ data: { commands: [] } }) }))
mock.module('@/queries/useSnippetsQuery', () => ({ useSnippetsQuery: () => ({ data: { snippets: [] } }) }))
mock.module('@/queries/useAgentsQuery', () => ({
  useAgentsQuery: () => agentsLoading
    ? { data: undefined, isLoading: true }
    : { data: { agents: [{ name: 'code', capabilities: undefined }] }, isLoading: false },
}))
mock.module('@/queries/useFileRefsQuery', () => ({ useFileRefsQuery: () => ({ refs: [] }) }))
mock.module('@/hooks/use-mobile', () => ({ useIsMobile: () => false }))
mock.module('@/hooks/use-platform', () => ({ usePlatform: () => ({ isMacOverlay: false, os: 'linux' }) }))
mock.module('@/hooks/use-tauri-drag', () => ({ useTauriDrag: () => ({}) }))
mock.module('@/hooks/useKeyboardShortcuts', () => ({ useKeyboardShortcuts: () => {} }))
mock.module('@/stores/useUIStore', () => ({
  useUIStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    schedulerOpen: false,
    runPickerOpen: false,
    toggleScheduler: () => {},
    toggleRunPicker: () => {},
    closeScheduler: () => {},
    closeRunPicker: () => {},
  }),
}))
mock.module('@/stores/useToastStore', () => ({ useToastStore: () => ({ push: () => {} }) }))
mock.module('@/stores/cache-invalidation-bridge', () => ({ prependSession: () => {}, prependWorkspaceSession: () => {} }))
mock.module('@/api/client', () => ({
  listCodingWorkspaceFiles: async () => [],
  getCodingWorkspaceTree: async () => ({ repositories: [], groups: [] }),
  setCodingWorkspaceVisibility: async () => ({}),
  renderCommand: async () => ({ content: '' }),
  renderSnippet: async () => ({ content: '' }),
  resolveApiUrl: () => null,
  resolveSession: async () => ({ id: 'new-session', created: true }),
}))
mock.module('@/utils/workspace', () => ({ saveLastWorkspace: () => {}, removeWorkspace: () => {}, workspaceLabel: (workspace: string) => workspace, sameWorkspacePath: (a: string, b: string) => a === b, getChatWorkspaceEntry: () => null, setChatWorkspaceEntry: () => {} }))
mock.module('@/lib/tray', () => ({ setTraySession: () => {} }))
mock.module('@/components/AgentView', () => ({
  AgentView: ({ jumpToLatestInComposer }: { jumpToLatestInComposer?: boolean }) => (
    <div data-testid="transcript" data-composer-tray={jumpToLatestInComposer ? '' : undefined} />
  ),
}))
mock.module('@/components/PendingMessageQueue', () => ({ PendingMessageQueue: () => <div data-testid="pending-queue" /> }))
// The transcript (AgentView, mocked here) is the one place that draws the queue.
mock.module('@/components/WorkspaceInfoCard', () => ({ WorkspaceInfoCard: () => null, RecentSessionsList: () => null }))
mock.module('@/components/Sidebar', () => ({ Sidebar: () => null }))
mock.module('@/components/WorkspacePanel', () => ({ WorkspacePanel: () => null }))
// Stands in for the header: its lead button shows exactly when the view passes a handler.
mock.module('@/components/AgentChatView/AgentChatHeader', () => ({
  AgentChatHeader: ({ onOpenLead }: { onOpenLead?: () => void }) => (
    onOpenLead ? <button type="button" aria-label="Open the main agent" onClick={onOpenLead} /> : null
  ),
}))
mock.module('@/components/AgentChatView/AgentChatPanels', () => ({ AgentChatPanels: () => null }))
mock.module('@/components/AgentChatView/useAgentCommands', () => ({ useAgentCommands: () => [] }))
mock.module('@/components/AgentChatView/usePaletteSwitchCommands', () => ({ usePaletteSwitchCommands: () => [] }))
mock.module('@/components/composer/Composer', () => ({
  Composer: forwardRef<
    { setValue: (value: string) => void; setFiles: (files: File[]) => void },
    { disabled?: boolean }
  >(function ComposerMock({ disabled }, ref) {
    useImperativeHandle(ref, () => ({
      setValue: setValueMock,
      setFiles: setFilesMock,
    }))
    return <div data-testid="composer" data-disabled={disabled ? '' : undefined} />
  }),
}))

mock.module('@/stores/useAgentStore', () => {
  const listeners = new Set<(next: typeof state, prev: typeof state) => void>()
  const state = {
    connectStream: () => null,
    loadAgentStatus: async () => {},
    loadSession: async () => {},
    sendMessage: async () => {},
    beginResolvedSession: (sessionId: string | null) => { state.sessionId = sessionId },
    newSession: () => { state.sessionId = null },
    isEmptyIdleSession: () => false,
    consumeResolvedSessionReady: () => false,
    setActiveAgent: () => {},
    setSessionModelSettings: () => {},
    setupRequired: null,
    dismissSetupRequired: () => {},
    activeAgent: 'code',
    agentStreams: { lead: { blocks: [], currentBlocks: [], status: 'idle', lastError: null, revertedCount: 0, revertedMessages: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 } } },
    agentNames: ['lead'],
    isAgentWorking: false,
    isContinuing: false,
    sessionId: null as string | null,
    parentSessionId: null as string | null,
    sessionTitle: null,
    sessionModel: null,
    sessionThinkingLevel: null,
    sessionFastMode: false,
    leadName: 'lead',
    isConnected: false,
    _workspace: null as string | null,
  }
  return {
    useAgentStore: Object.assign(
      (selector: (draft: typeof state) => unknown) => selector(state),
      {
        getState: () => state,
        setState: (partial: Partial<typeof state>) => {
          const prev = { ...state }
          Object.assign(state, partial)
          for (const listener of listeners) listener(state, prev)
        },
        subscribe: (listener: (next: typeof state, prev: typeof state) => void) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      },
    ),
  }
})

const { useAgentStore } = await import('@/stores/useAgentStore')

afterEach(cleanup)

beforeEach(() => {
  agentsLoading = false
  healthError = false
  workspaceTree = undefined
  navigateMock.mockClear()
  useAgentStore.setState({ sessionId: null, parentSessionId: null, _workspace: null })
})

describe('AgentChatView — switching sessions', () => {
  it('keeps the chat and a disabled composer while the next session\'s workspace is looked up', () => {
    useAgentStore.setState({ sessionId: 'session-a', _workspace: '/repo/a' })
    render(<AgentChatView sessionId="session-b" workspace={null} sessionLoading />)

    expect(screen.getByTestId('transcript')).toBeTruthy()
    expect(screen.getByTestId('composer').hasAttribute('data-disabled')).toBe(true)
    expect(screen.queryByText('Opening session…')).toBeNull()
  })

  it('shows the opening screen when there is no chat to keep on screen', () => {
    render(<AgentChatView sessionId="session-b" workspace={null} sessionLoading />)

    expect(screen.getByText('Opening session…')).toBeTruthy()
    expect(screen.queryByTestId('transcript')).toBeNull()
  })

  it('sets the opening screens\' titles as page titles: text-base font-semibold', () => {
    const expectPageTitle = (title: HTMLElement) => {
      expect(title.className.split(' ')).toEqual(expect.arrayContaining(['text-base', 'font-semibold']))
      expect(title.className).not.toMatch(/font-medium|text-sm/)
    }
    const { unmount } = render(<AgentChatView sessionId="session-b" workspace={null} sessionLoading />)
    expectPageTitle(screen.getByText('Opening session…'))
    unmount()

    agentsLoading = true
    render(<AgentChatView workspace="/repo/b" />)
    expectPageTitle(screen.getByText('Opening workspace…'))
  })

  it('keeps the chat while another workspace\'s agents load', () => {
    agentsLoading = true
    useAgentStore.setState({ sessionId: 'session-b', _workspace: '/repo/b' })
    render(<AgentChatView sessionId="session-b" workspace="/repo/b" />)

    expect(screen.getByTestId('transcript')).toBeTruthy()
    expect(screen.getByTestId('composer')).toBeTruthy()
    expect(screen.queryByText('Opening workspace…')).toBeNull()
  })

  it('still shows the opening screen for the first workspace on launch', () => {
    agentsLoading = true
    render(<AgentChatView workspace="/repo/b" />)

    expect(screen.getByText('Opening workspace…')).toBeTruthy()
  })

  it('says the session is not found instead of asking for a workspace', () => {
    render(<AgentChatView sessionId="gone" workspace={null} sessionNotFound />)

    expect(screen.getByText('Session not found')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'New session' })).toBeTruthy()
    expect(screen.queryByText('No workspace attached')).toBeNull()
  })

  // Opened with the server down, nothing could load, so the view knows no
  // workspace. Asking for one sends the user the wrong way.
  it('says the server is unreachable instead of asking for a workspace', () => {
    healthError = true
    render(<AgentChatView sessionId="session-x" workspace={null} />)

    expect(screen.getByText("Can't reach the server")).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
    expect(screen.queryByText('No workspace attached')).toBeNull()
  })

  it('keeps the transcript of a session whose folder is gone, under a banner', () => {
    workspaceTree = { repositories: [{ path: '/repo/gone', name: 'gone', worktrees: [], missing: true }], groups: [] }
    useAgentStore.setState({ sessionId: 'session-g', _workspace: '/repo/gone' })
    render(<AgentChatView sessionId="session-g" workspace="/repo/gone" />)

    expect(screen.getByTestId('transcript')).toBeTruthy()
    expect(screen.getByText(/was moved or deleted/).textContent).toContain('gone was moved or deleted')
    expect(screen.getByRole('button', { name: 'Open workspace…' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Hide from sidebar' })).toBeTruthy()
  })

  it('shows no folder banner while the folder exists', () => {
    workspaceTree = { repositories: [{ path: '/repo/b', name: 'b', worktrees: [] }], groups: [] }
    useAgentStore.setState({ sessionId: 'session-b', _workspace: '/repo/b' })
    render(<AgentChatView sessionId="session-b" workspace="/repo/b" />)

    expect(screen.queryByText(/was moved or deleted/)).toBeNull()
  })

  it("does not hand a main session's message queue to the composer's tray", () => {
    useAgentStore.setState({ sessionId: 'session-b', _workspace: '/repo/b' })
    render(<AgentChatView sessionId="session-b" workspace="/repo/b" />)

    // The queue belongs to the transcript (AgentView), which is mocked here:
    // neither the composer nor the chat shell may draw one.
    expect(screen.getByTestId('composer').querySelector('[data-testid="pending-queue"]')).toBeNull()
    expect(screen.queryByTestId('pending-queue')).toBeNull()
    // The composer still carries the jump-to-latest chip.
    expect(screen.getByTestId('transcript').hasAttribute('data-composer-tray')).toBe(true)
  })

  it("draws no queue of its own for a subagent's session either", () => {
    useAgentStore.setState({ sessionId: 'session-sub', parentSessionId: 'session-main', _workspace: '/repo/b' })
    render(<AgentChatView sessionId="session-sub" workspace="/repo/b" />)

    expect(screen.queryByTestId('composer')).toBeNull()
    expect(screen.queryByTestId('pending-queue')).toBeNull()
    // No tray, so the chip stays in the transcript.
    expect(screen.getByTestId('transcript').hasAttribute('data-composer-tray')).toBe(false)
  })

  it("gives a subagent's header a way back to the lead, the same one the banner takes", () => {
    useAgentStore.setState({ sessionId: 'session-sub', parentSessionId: 'session-main', _workspace: '/repo/b' })
    render(<AgentChatView sessionId="session-sub" workspace="/repo/b" />)

    fireEvent.click(screen.getByRole('button', { name: 'Open the main agent' }))
    expect(navigateMock).toHaveBeenCalledWith({ to: '/$sessionId', params: { sessionId: 'session-main' } })
    navigateMock.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Return to main agent' }))
    expect(navigateMock).toHaveBeenCalledWith({ to: '/$sessionId', params: { sessionId: 'session-main' } })
  })

  it('offers no lead button in a main session', () => {
    useAgentStore.setState({ sessionId: 'session-b', _workspace: '/repo/b' })
    render(<AgentChatView sessionId="session-b" workspace="/repo/b" />)

    expect(screen.queryByRole('button', { name: 'Open the main agent' })).toBeNull()
  })
})
