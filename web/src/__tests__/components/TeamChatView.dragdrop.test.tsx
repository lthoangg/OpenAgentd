import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, fireEvent } from '@testing-library/react'
import { forwardRef, useImperativeHandle } from 'react'
import { TeamChatView } from '@/components/TeamChatView'

const setValueMock = mock(() => {})
const setFilesMock = mock(() => {})
const addFilesMock = mock(() => {})

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
    { setValue: (value: string) => void; setFiles: (files: File[]) => void; addFiles: (files: File[]) => void },
    unknown
  >(function FloatingInputBarMock(_, ref) {
    useImperativeHandle(ref, () => ({
      setValue: setValueMock,
      setFiles: setFilesMock,
      addFiles: addFilesMock,
    }))
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
    sessionId: 'test-session',
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
  addFilesMock.mockClear()
})

describe('TeamChatView drag-and-drop files', () => {
  it('shows and hides overlay on drag events, and adds files on drop', () => {
    const { container, queryByText } = render(<TeamChatView sessionId="test-session" />)

    const mainEl = container.querySelector('#main')
    expect(mainEl).not.toBeNull()
    if (!mainEl) return

    // Initially overlay is not visible
    expect(queryByText('Drop files to attach')).toBeNull()

    // Drag enter with non-files (e.g. text) should NOT show the overlay
    fireEvent.dragEnter(mainEl, {
      dataTransfer: {
        types: ['text/plain'],
      },
    })
    expect(queryByText('Drop files to attach')).toBeNull()

    // Drag enter with files should show the overlay
    fireEvent.dragEnter(mainEl, {
      dataTransfer: {
        types: ['Files'],
      },
    })
    expect(queryByText('Drop files to attach')).not.toBeNull()

    // Drag leave should hide the overlay
    fireEvent.dragLeave(mainEl, {
      dataTransfer: {
        types: ['Files'],
      },
    })
    expect(queryByText('Drop files to attach')).toBeNull()

    // Drag enter again
    fireEvent.dragEnter(mainEl, {
      dataTransfer: {
        types: ['Files'],
      },
    })
    expect(queryByText('Drop files to attach')).not.toBeNull()

    // Drop files
    const file = new File(['hello'], 'hello.txt', { type: 'text/plain' })
    fireEvent.drop(mainEl, {
      dataTransfer: {
        types: ['Files'],
        files: [file],
      },
    })

    // Overlay should be hidden after drop
    expect(queryByText('Drop files to attach')).toBeNull()

    // addFiles should have been called with the file
    expect(addFilesMock).toHaveBeenCalled()
    const calledFiles = addFilesMock.mock.calls[0][0] as File[]
    expect(calledFiles.length).toBe(1)
    expect(calledFiles[0].name).toBe('hello.txt')
  })
})
