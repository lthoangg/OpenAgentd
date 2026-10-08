import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, render, screen } from '@testing-library/react'
import { forwardRef, useImperativeHandle } from 'react'
import { useAgentStore } from '@/stores/useAgentStore'
import { useTranscriptFollowStore } from '@/stores/useTranscriptFollowStore'
import type { ContentBlock } from '@/api/types'

// lucide-react is deliberately NOT mocked here. Bun validates every static
// named import in the tree against the mock's own keys, so an explicit icon map
// fails the moment any component in this (large) tree adopts another icon —
// which surfaces as an unrelated module-resolution error rather than a test
// failure. The real icons render fine and cost nothing measurable.
mock.module('@tanstack/react-router', () => ({ useNavigate: () => () => Promise.resolve() }))
mock.module('@tanstack/react-query', () => ({
  useQueryClient: () => ({}),
  useQuery: () => ({ data: undefined, isLoading: false }),
  QueryClientProvider: ({ children }: { children: unknown }) => children,
}))
mock.module('@/queries/useTodosQuery', () => ({ useTodosQuery: () => ({ data: { todos: [] } }) }))
mock.module('@/queries/useSessionPlanQuery', () => ({
  useSessionPlanQuery: () => ({ data: { plan: null } }),
  useClearSessionPlanMutation: () => ({ mutate: () => {} }),
}))
mock.module('@/queries', () => ({ useProvidersQuery: () => ({ data: { providers: [] } }) }))
mock.module('@/queries/useAgentsQuery', () => ({
  useAgentsQuery: () => ({ data: { agents: [{ name: 'code' }] }, isLoading: false }),
}))
mock.module('@/queries/useAgentSettingsQueries', () => ({ useRegistryQuery: () => ({ data: { models: [] } }) }))
mock.module('@/queries/useFileRefsQuery', () => ({ useFileRefsQuery: () => ({ refs: [] }) }))
mock.module('@/hooks/use-mobile', () => ({ useIsMobile: () => false }))
mock.module('@/hooks/use-platform', () => ({ usePlatform: () => ({ isMacOverlay: false, os: 'linux' }) }))
mock.module('@/hooks/use-tauri-drag', () => ({ useTauriDrag: () => ({}) }))
mock.module('@/stores/useUIStore', () => ({
  useUIStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    schedulerOpen: false,
    agentCapabilitiesOpen: false,
    paletteOpen: false,
    toggleScheduler: () => {},
    toggleAgentCapabilities: () => {},
    togglePalette: () => {},
    closeScheduler: () => {},
    closeAgentCapabilities: () => {},
    closePalette: () => {},
  }),
}))
mock.module('@/stores/useSettingsStore', () => ({ useSettingsStore: () => () => {} }))
mock.module('@/components/AgentView', () => ({ AgentView: () => null }))
mock.module('@/components/WorkspaceInfoCard', () => ({ WorkspaceInfoCard: () => null }))
mock.module('@/components/Sidebar', () => ({ Sidebar: () => null }))
mock.module('@/components/WorkspacePanel', () => ({ WorkspacePanel: () => null }))
mock.module('@/components/AppFooter', () => ({ AppFooter: () => null }))
mock.module('@/components/AgentChatView/AgentChatPanels', () => ({ AgentChatPanels: () => null }))
mock.module('@/components/AgentChatView/AgentChatHeader', () => ({
  AgentChatHeader: ({
    agentNames,
    headerTokens,
  }: {
    agentNames?: string[]
    headerTokens?: { sessionCostUsd?: number }
  }) => (
    <>
      <div data-testid="header-agents">{(agentNames ?? []).join(',')}</div>
      {headerTokens && <div data-testid="session-cost">{headerTokens.sessionCostUsd}</div>}
    </>
  ),
}))
/** The composer's ``onHistoryRecall``, as the mounted chat view passed it. */
let recall: ((prompt: string | null) => void) | undefined

mock.module('@/components/FloatingInputComposer', () => ({
  FloatingInputComposer: forwardRef<
    { setValue: (value: string) => void; setFiles: (files: File[]) => void },
    { historyPrompts?: string[]; onHistoryRecall?: (prompt: string | null) => void }
  >(function FloatingInputComposerMock({ historyPrompts, onHistoryRecall }, ref) {
    useImperativeHandle(ref, () => ({ setValue: () => {}, setFiles: () => {} }))
    recall = onHistoryRecall
    return <div data-testid="history-prompts">{(historyPrompts ?? []).join(',')}</div>
  }),
}))
mock.module('@/components/AgentChatView/useOverlayState', () => ({
  useOverlayState: () => ({
    mobileSidebarOpen: false,
    setMobileSidebarOpen: () => {},
    showFilesPanel: false,
    setShowFilesPanel: () => {},
    workspacePanel: null,
    setWorkspacePanel: () => {},
    fileViewer: null,
    setFileViewer: () => {},
    fileOpenKey: 0,
    setFileOpenKey: () => {},
    terminalOpenKey: 0,
    handledTerminalOpenKeyRef: { current: 0 },
    sidebarCollapsed: false,
    setSidebarCollapsed: () => {},
    openWorkspaceDialogKey: 0,
    showTodos: false,
    showMobileActions: false,
    handleWorkspaceFiles: () => {},
    handleSidebarToggle: () => {},
    handleOpenWorkspaceDialog: () => {},
    handleFileSelect: () => {},
    handleMentionFileOpen: () => {},
    closeMobileActionsMenu: () => {},
    handleSetShowMobileActions: () => {},
    handleToggleAgentCapabilities: () => {},
    handleToggleScheduler: () => {},
    handleTogglePalette: () => {},
    handleSetShowTodos: () => {},
    handleToggleFilesPanel: () => {},
    handleOpenTerminal: () => {},
    openLeftDrawer: () => {},
    edgeSwipeHandlers: {},
    sidebarDragOffset: null,
    actionsDragOffset: null,
    workspacePanelDragOffset: null,
  }),
}))
mock.module('@/components/AgentChatView/useSessionBootstrap', () => ({
  useSessionBootstrap: () => ({
    handleNewSession: () => {},
    handleDraftValueChange: () => {},
    handleAddFileComment: () => {},
  }),
}))
mock.module('@/components/AgentChatView/useSlashCommands', () => ({
  useSlashCommands: () => ({
    slashCommands: [],
    snippetCommands: [],
    handleSlashCommand: () => {},
    handleSnippetCommand: () => {},
    expandUserCommand: (content: string) => content,
  }),
}))
mock.module('@/components/AgentChatView/useCommandPalette', () => ({
  useCommandPalette: () => ({ paletteCommands: [], paletteWorkspaceFiles: [], handlePaletteFileOpen: () => {} }),
}))
mock.module('@/components/AgentChatView/useDragDrop', () => ({
  useDragDrop: () => ({
    isDraggingFile: false,
    handleDragEnter: () => {},
    handleDragLeave: () => {},
    handleDragOver: () => {},
    handleDrop: () => {},
  }),
}))
mock.module('@/utils/workspace', () => ({ saveLastWorkspace: () => {}, workspaceLabel: (workspace: string) => workspace, sameWorkspacePath: (a: string, b: string) => a === b, getChatWorkspaceEntry: () => null, setChatWorkspaceEntry: () => {} }))

const initialState = typeof useAgentStore.getInitialState === 'function'
  ? useAgentStore.getInitialState()
  : useAgentStore.getState()

function userBlock(content: string): ContentBlock {
  return { id: `user:${content}`, type: 'user', content, timestamp: new Date() }
}

beforeEach(() => {
  useAgentStore.setState(initialState, true)
  useAgentStore.setState((state) => {
    state.leadName = 'lead'
    state.agentNames = ['lead', 'worker#1']
    state.liveAgentNames = ['lead', 'worker#1']
    state.sessionId = 'session-1'
    state.agentStreams.lead = {
      ...state.agentStreams.lead,
      blocks: [],
      currentBlocks: [],
      status: 'idle',
      lastError: null,
      revertedCount: 0,
      revertedMessages: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 },
    }
    state.agentStreams['worker#1'] = {
      ...state.agentStreams.lead,
      blocks: [],
      currentBlocks: [],
      status: 'idle',
    }
  })
})

afterEach(cleanup)

const { AgentChatView } = await import('@/components/AgentChatView')

describe('AgentChatView reactive derived state', () => {
  it('updates composer history when finalized lead blocks load without changing the lead name', () => {
    render(<AgentChatView sessionId="session-1" workspace="/repo/project" />)
    expect(screen.getByTestId('history-prompts').textContent).toBe('')

    act(() => {
      useAgentStore.setState((state) => {
        state.agentStreams.lead.blocks = [userBlock('loaded prompt')]
      })
    })

    expect(screen.getByTestId('history-prompts').textContent).toBe('loaded prompt')
  })

  it('shows the prompt the composer recalls, the newest with that text, and the live end on leaving recall', () => {
    const showPrompt = mock((..._args: unknown[]) => {})
    const jumpToLatest = mock(() => {})
    useTranscriptFollowStore.setState({ showPrompt, jumpToLatest })
    useAgentStore.setState((state) => {
      state.agentStreams.lead.blocks = [
        { ...userBlock('fix it'), id: 'older' },
        { id: 'a1', type: 'text', content: 'done' },
        { ...userBlock(' fix it '), id: 'newer' },
      ]
    })
    render(<AgentChatView sessionId="session-1" workspace="/repo/project" />)

    act(() => recall?.('fix it'))
    act(() => recall?.('never sent here'))
    act(() => recall?.(null))

    expect(showPrompt.mock.calls).toEqual([['newer']])
    expect(jumpToLatest).toHaveBeenCalledTimes(1)
    useTranscriptFollowStore.setState({ showPrompt: null, jumpToLatest: null })
  })

  it('sums current session costs exactly and excludes stale agent streams', () => {
    useAgentStore.setState((state) => {
      state.agentStreams.lead.usage = {
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        cachedTokens: 0,
        estimatedCostUsd: 0.0012,
      }
      state.agentStreams['worker#1'].usage = {
        promptTokens: 20,
        completionTokens: 8,
        totalTokens: 28,
        cachedTokens: 0,
        estimatedCostUsd: 0.0023,
      }
      state.agentStreams['stale#1'] = {
        ...state.agentStreams.lead,
        usage: {
          promptTokens: 100,
          completionTokens: 100,
          totalTokens: 200,
          cachedTokens: 0,
          estimatedCostUsd: 1,
        },
      }
    })

    render(<AgentChatView sessionId="session-1" workspace="/repo/project" />)

    expect(screen.getByTestId('session-cost').textContent).toBe('0.0035')
  })

  it('shows the header meter while the team is working, before any usage lands', () => {
    // Usage arrives when the first model call completes, so gating on totals
    // alone hid the meter for the whole first response of a new session.
    useAgentStore.setState((state) => {
      state.isAgentWorking = true
      state.agentStreams.lead.status = 'working'
    })

    render(<AgentChatView sessionId="session-1" workspace="/repo/project" />)

    expect(screen.queryByTestId('session-cost')).not.toBeNull()
  })

  it('shows the header meter even when idle with no usage', () => {
    render(<AgentChatView sessionId="session-1" workspace="/repo/project" />)

    expect(screen.queryByTestId('session-cost')).not.toBeNull()
  })
})
