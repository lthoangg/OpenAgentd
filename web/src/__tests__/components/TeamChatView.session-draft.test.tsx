import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render } from '@testing-library/react'
import { forwardRef, useEffect, useImperativeHandle } from 'react'
import { TeamChatView } from '@/components/TeamChatView'

let latestOnValueChange: ((value: string) => void) | undefined
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
mock.module('@/components/FloatingInputBar', () => ({
  FloatingInputBar: forwardRef<
    { setValue: (value: string) => void; setFiles: (files: File[]) => void },
    { onValueChange?: (value: string) => void }
  >(function FloatingInputBarMock({ onValueChange }, ref) {
    useImperativeHandle(ref, () => ({
      setValue: setValueMock,
      setFiles: setFilesMock,
    }))
    useEffect(() => {
      latestOnValueChange = onValueChange
      return () => {
        latestOnValueChange = undefined
      }
    }, [onValueChange])
    return null
  }),
}))

mock.module('@/stores/useTeamStore', () => {
  const state = {
    connectStream: () => null,
    loadTeamStatus: async () => {},
    loadSession: async () => {},
    sendMessage: async () => {},
    continueTeam: async () => {},
    beginResolvedSession: () => {},
    consumeResolvedSessionReady: () => false,
    cycleActiveAgent: () => {},
    setActiveAgent: () => {},
    setSessionModelSettings: () => {},
    setupRequired: null,
    dismissSetupRequired: () => {},
    activeAgent: 'lead',
    agentStreams: { lead: { blocks: [], currentBlocks: [], status: 'idle', lastError: null, revertedCount: 0, revertedMessages: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 } } },
    agentNames: ['lead'],
    isTeamWorking: false,
    isContinuing: false,
    sessionId: null,
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
})

describe('TeamChatView session drafts', () => {
  it('restores the unsent draft when switching back to a previous session', () => {
    const { rerender } = render(<TeamChatView sessionId="session-a" />)

    expect(setValueMock).toHaveBeenLastCalledWith('')
    latestOnValueChange?.('draft for a')

    rerender(<TeamChatView sessionId="session-b" />)
    expect(setValueMock).toHaveBeenLastCalledWith('')
    latestOnValueChange?.('draft for b')

    rerender(<TeamChatView sessionId="session-a" />)
    expect(setValueMock).toHaveBeenLastCalledWith('draft for a')
  })
})
