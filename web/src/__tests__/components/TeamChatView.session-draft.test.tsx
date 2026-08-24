import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render } from '@testing-library/react'
import { forwardRef, useEffect, useImperativeHandle } from 'react'
import { TeamChatView } from '@/components/TeamChatView'

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
  QueryClientProvider: ({ children }: { children: unknown }) => children,
}))

mock.module('@/queries/useTodosQuery', () => ({ useTodosQuery: () => ({ data: { todos: [] } }) }))
mock.module('@/queries', () => ({
  useProvidersQuery: () => ({ data: { providers: [] } }),
}))
mock.module('@/queries/useCommandsQuery', () => ({ useCommandsQuery: () => ({ data: { commands: [] } }) }))
mock.module('@/queries/useSnippetsQuery', () => ({ useSnippetsQuery: () => ({ data: { snippets: [] } }) }))
mock.module('@/queries/useAgentsQuery', () => ({
  useTeamAgentsQuery: () => ({ data: { agents: [{ is_lead: true, capabilities: undefined }] }, isLoading: false }),
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
  resolveTeamSession: async () => ({ id: 'new-session', created: true }),
}))
mock.module('@/utils/workspace', () => ({ saveLastCodingWorkspace: () => {}, workspaceLabel: (workspace: string) => workspace }))
mock.module('@/lib/tray', () => ({ setTraySession: () => {} }))
mock.module('@/components/AgentView', () => ({ AgentView: () => null }))
mock.module('@/components/WorkspaceInfoCard', () => ({ WorkspaceInfoCard: () => null }))
mock.module('@/components/CodingSidebar', () => ({ CodingSidebar: () => null }))
mock.module('@/components/CodingWorkspacePanel', () => ({ CodingWorkspacePanel: () => null }))
mock.module('@/components/CodingFileViewerPanel', () => ({ CodingFileViewerPanel: () => null }))
mock.module('@/components/Sidebar', () => ({ Sidebar: () => null }))
mock.module('@/components/TeamChatView/SplitGrid', () => ({ SplitGrid: () => null }))
mock.module('@/components/TeamChatView/TeamChatHeader', () => ({ TeamChatHeader: () => null }))
mock.module('@/components/TeamChatView/TeamChatPanels', () => ({ TeamChatPanels: () => null }))
mock.module('@/components/TeamChatView/AgentTabs', () => ({ AgentTabs: () => null }))
mock.module('@/components/TeamChatView/useTeamCommands', () => ({ useTeamCommands: () => [] }))
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

mock.module('@/stores/useTeamStore', () => {
  const state = {
    connectStream: () => null,
    loadTeamStatus: async () => {},
    loadSession: async () => {},
    sendMessage: async () => {},
    beginResolvedSession: (sessionId: string | null) => { state.sessionId = sessionId },
    isEmptyIdleSession: () => false,
    consumeResolvedSessionReady: () => false,
    setActiveAgent: () => {},
    setSessionModelSettings: () => {},
    setupRequired: null,
    dismissSetupRequired: () => {},
    activeAgent: 'lead',
    agentStreams: { lead: { blocks: [], currentBlocks: [], status: 'idle', lastError: null, revertedCount: 0, revertedMessages: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 } } },
    agentNames: ['lead'],
    isTeamWorking: false,
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
    useTeamStore: Object.assign(
      (selector: (draft: typeof state) => unknown) => selector(state),
      {
        getState: () => state,
        setState: (partial: Partial<typeof state>) => Object.assign(state, partial),
      },
    ),
  }
})

afterEach(cleanup)

beforeEach(() => {
  setValueMock.mockClear()
  setFilesMock.mockClear()
  latestOnValueChange = undefined
  latestOnSlashCommand = undefined
})

describe('TeamChatView session drafts', () => {
  it('clears the draft of a session after /new so it does not reappear on switch-back', () => {
    // Regression: handleNewSession called beginResolvedSession(null) which set
    // store.sessionId=null before the onValueChange('') effect could fire.
    // handleDraftValueChange bailed early on !currentSessionId, leaving the
    // '/new' draft stored for the originating session. Switching back restored it.
    const { rerender } = render(<TeamChatView sessionId="session-a" workspace="/repo/project" />)

    // User types '/new' — draft is saved for session-a
    latestOnValueChange?.('/new')

    // User executes the /new slash command. InputComposer calls executeSlashCommand
    // which: 1) calls setValue('') (InputComposer local), 2) calls onSlashCommand('new').
    // handleNewSession immediately calls beginResolvedSession(null) → sessionId=null.
    // The onValueChange('') from setValue('') fires AFTER this (useEffect timing).
    latestOnSlashCommand?.('new')

    // Now simulate the deferred onValueChange('') that InputComposer fires via useEffect.
    // By this point store.sessionId is null because beginResolvedSession ran first.
    latestOnValueChange?.('')

    // Navigate to new session (what handleNewSession does after resolveTeamSession)
    rerender(<TeamChatView sessionId="new-session" workspace="/repo/project" />)

    // Switch back to session-a — draft must be gone, not '/new'
    rerender(<TeamChatView sessionId="session-a" workspace="/repo/project" />)
    expect(setValueMock).toHaveBeenLastCalledWith('')
  })

  it('restores the unsent draft when switching back to a previous session', () => {
    const { rerender } = render(<TeamChatView sessionId="session-a" workspace="/repo/project" />)

    expect(setValueMock).toHaveBeenLastCalledWith('')
    latestOnValueChange?.('draft for a')

    rerender(<TeamChatView sessionId="session-b" workspace="/repo/project" />)
    expect(setValueMock).toHaveBeenLastCalledWith('')
    latestOnValueChange?.('draft for b')

    rerender(<TeamChatView sessionId="session-a" workspace="/repo/project" />)
    expect(setValueMock).toHaveBeenLastCalledWith('draft for a')
  })
})
