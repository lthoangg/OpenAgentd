import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import { forwardRef, useImperativeHandle } from 'react'
import { AgentChatView } from '@/components/AgentChatView'

let agentsLoading = false
const setValueMock = mock(() => {})
const setFilesMock = mock(() => {})

mock.module('@tanstack/react-router', () => ({
  useNavigate: () => mock(() => Promise.resolve()),
}))

mock.module('@tanstack/react-query', () => ({
  useQueryClient: () => ({}),
  useQuery: () => ({ data: undefined, isLoading: false }),
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
}))
mock.module('@/queries', () => ({
  useProvidersQuery: () => ({ data: { providers: [] } }),
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
    agentCapabilitiesOpen: false,
    toggleScheduler: () => {},
    toggleAgentCapabilities: () => {},
    closeScheduler: () => {},
    closeAgentCapabilities: () => {},
  }),
}))
mock.module('@/stores/useToastStore', () => ({ useToastStore: () => ({ push: () => {} }) }))
mock.module('@/stores/cache-invalidation-bridge', () => ({ prependSession: () => {}, prependWorkspaceSession: () => {} }))
mock.module('@/api/client', () => ({
  listCodingWorkspaceFiles: async () => [],
  renderCommand: async () => ({ content: '' }),
  renderSnippet: async () => ({ content: '' }),
  resolveApiUrl: () => null,
  resolveSession: async () => ({ id: 'new-session', created: true }),
}))
mock.module('@/utils/workspace', () => ({ saveLastWorkspace: () => {}, workspaceLabel: (workspace: string) => workspace, sameWorkspacePath: (a: string, b: string) => a === b, getChatWorkspaceEntry: () => null, setChatWorkspaceEntry: () => {} }))
mock.module('@/lib/tray', () => ({ setTraySession: () => {} }))
mock.module('@/components/AgentView', () => ({ AgentView: () => <div data-testid="transcript" /> }))
mock.module('@/components/WorkspaceInfoCard', () => ({ WorkspaceInfoCard: () => null, RecentSessionsList: () => null }))
mock.module('@/components/Sidebar', () => ({ Sidebar: () => null }))
mock.module('@/components/WorkspacePanel', () => ({ WorkspacePanel: () => null }))
mock.module('@/components/AgentChatView/AgentChatHeader', () => ({ AgentChatHeader: () => null }))
mock.module('@/components/AgentChatView/AgentChatPanels', () => ({ AgentChatPanels: () => null }))
mock.module('@/components/AgentChatView/useAgentCommands', () => ({ useAgentCommands: () => [] }))
mock.module('@/components/AgentChatView/usePaletteSwitchCommands', () => ({ usePaletteSwitchCommands: () => [] }))
mock.module('@/components/FloatingInputComposer', () => ({
  FloatingInputComposer: forwardRef<
    { setValue: (value: string) => void; setFiles: (files: File[]) => void },
    { disabled?: boolean }
  >(function FloatingInputComposerMock({ disabled }, ref) {
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
  useAgentStore.setState({ sessionId: null, _workspace: null })
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
})
