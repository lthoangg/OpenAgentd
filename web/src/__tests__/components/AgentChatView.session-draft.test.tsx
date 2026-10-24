import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render } from '@testing-library/react'
import { forwardRef, useEffect, useImperativeHandle } from 'react'
import { AgentChatView } from '@/components/AgentChatView'

let latestOnValueChange: ((value: string) => void) | undefined
let latestOnSlashCommand: ((id: string) => void) | undefined
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
  useAgentsQuery: () => ({ data: { agents: [{ name: 'code', capabilities: undefined }] }, isLoading: false }),
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
mock.module('@/components/AgentView', () => ({ AgentView: () => null }))
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
    { onValueChange?: (value: string) => void; onSlashCommand?: (id: string) => void }
  >(function FloatingInputComposerMock({ onValueChange, onSlashCommand }, ref) {
    useImperativeHandle(ref, () => ({
      setValue: setValueMock,
      setFiles: setFilesMock,
    }))
    useEffect(() => {
      latestOnValueChange = onValueChange
      latestOnSlashCommand = onSlashCommand
      return () => {
        latestOnValueChange = undefined
        latestOnSlashCommand = undefined
      }
    }, [onValueChange, onSlashCommand])
    return null
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
  setValueMock.mockClear()
  setFilesMock.mockClear()
  latestOnValueChange = undefined
  latestOnSlashCommand = undefined
  useAgentStore.setState({ sessionId: null })
})

describe('AgentChatView session drafts', () => {
  it('clears the draft of a session after /new so it does not reappear on switch-back', () => {
    // Regression: /new forgets the store's session id before the composer's
    // onValueChange('') fires, so the '/new' text was left stored for the
    // originating session and came back on switch-back.
    useAgentStore.setState({ sessionId: 'session-a' })
    const { rerender } = render(<AgentChatView sessionId="session-a" workspace="/repo/project" />)

    // User types '/new' — draft is saved for session-a
    latestOnValueChange?.('/new')

    // User executes the /new slash command. InputComposer calls setValue('')
    // and then onSlashCommand('new'); handleNewSession resets the store
    // (sessionId=null) and opens the draft. The onValueChange('') from
    // setValue('') fires after this (useEffect timing).
    latestOnSlashCommand?.('new')

    // Now simulate the deferred onValueChange('') that InputComposer fires via useEffect.
    latestOnValueChange?.('')

    // A session created later from the draft.
    rerender(<AgentChatView sessionId="new-session" workspace="/repo/project" />)

    // Switch back to session-a — draft must be gone, not '/new'
    rerender(<AgentChatView sessionId="session-a" workspace="/repo/project" />)
    expect(setValueMock).toHaveBeenLastCalledWith('')
  })

  it('keeps a new-session draft per folder across a reload', () => {
    const first = render(<AgentChatView workspace="/repo/draft-reload" />)
    latestOnValueChange?.('half-typed idea')
    first.unmount()

    setValueMock.mockClear()
    render(<AgentChatView workspace="/repo/draft-reload" />)
    expect(setValueMock).toHaveBeenLastCalledWith('half-typed idea')
  })

  it('moves the draft text to the session its first message creates', () => {
    const { rerender } = render(<AgentChatView workspace="/repo/draft-move" />)
    latestOnValueChange?.('follow-up typed while sending')

    // The first POST /agent/chat returns the new id.
    useAgentStore.setState({ sessionId: 'created-from-draft' })
    rerender(<AgentChatView sessionId="created-from-draft" workspace="/repo/draft-move" />)
    expect(setValueMock).toHaveBeenLastCalledWith('follow-up typed while sending')

    // The folder's draft is empty again for the next new session.
    useAgentStore.setState({ sessionId: null })
    setValueMock.mockClear()
    rerender(<AgentChatView workspace="/repo/draft-move" />)
    expect(setValueMock).toHaveBeenLastCalledWith('')
  })

  it('restores the unsent draft when switching back to a previous session', () => {
    const { rerender } = render(<AgentChatView sessionId="session-a" workspace="/repo/project" />)

    expect(setValueMock).toHaveBeenLastCalledWith('')
    latestOnValueChange?.('draft for a')

    rerender(<AgentChatView sessionId="session-b" workspace="/repo/project" />)
    expect(setValueMock).toHaveBeenLastCalledWith('')
    latestOnValueChange?.('draft for b')

    rerender(<AgentChatView sessionId="session-a" workspace="/repo/project" />)
    expect(setValueMock).toHaveBeenLastCalledWith('draft for a')
  })
})
