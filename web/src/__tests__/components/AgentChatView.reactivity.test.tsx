import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, render, screen } from '@testing-library/react'
import { forwardRef, useImperativeHandle } from 'react'
import { useAgentStore } from '@/stores/useAgentStore'
import type { ContentBlock } from '@/api/types'

// lucide-react is deliberately NOT mocked here. Bun validates every static
// named import in the tree against the mock's own keys, so an explicit icon map
// fails the moment any component in this (large) tree adopts another icon —
// which surfaces as an unrelated module-resolution error rather than a test
// failure. The real icons render fine and cost nothing measurable.
mock.module('@tanstack/react-router', () => ({ useNavigate: () => () => Promise.resolve() }))
mock.module('@tanstack/react-query', () => ({ useQueryClient: () => ({}) }))
mock.module('@/queries/useTodosQuery', () => ({ useTodosQuery: () => ({ data: { todos: [] } }) }))
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
mock.module('@/components/CodingSidebar', () => ({ CodingSidebar: () => null }))
mock.module('@/components/CodingWorkspacePanel', () => ({ CodingWorkspacePanel: () => null }))
mock.module('@/components/CodingFileViewerPanel', () => ({ CodingFileViewerPanel: () => null }))
mock.module('@/components/WorkspaceFilesPanel', () => ({ WorkspaceFilesPanel: () => null }))
mock.module('@/components/Sidebar', () => ({ Sidebar: () => null }))
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
mock.module('@/components/FloatingInputComposer', () => ({
  FloatingInputComposer: forwardRef<
    { setValue: (value: string) => void; setFiles: (files: File[]) => void },
    { historyPrompts?: string[] }
  >(function FloatingInputComposerMock({ historyPrompts }, ref) {
    useImperativeHandle(ref, () => ({ setValue: () => {}, setFiles: () => {} }))
    return <div data-testid="history-prompts">{(historyPrompts ?? []).join(',')}</div>
  }),
}))
mock.module('@/components/AgentChatView/useOverlayState', () => ({
  useOverlayState: () => ({
    mobileSidebarOpen: false,
    setMobileSidebarOpen: () => {},
    showFilesPanel: false,
    setShowFilesPanel: () => {},
    codingPanel: null,
    setCodingPanel: () => {},
    codingFileViewer: null,
    setCodingFileViewer: () => {},
    codingFileViewerDetached: false,
    setCodingFileViewerDetached: () => {},
    codingFileOpenKey: 0,
    setCodingFileOpenKey: () => {},
    terminalOpenKey: 0,
    handledTerminalOpenKeyRef: { current: 0 },
    codingSidebarCollapsed: false,
    setCodingSidebarCollapsed: () => {},
    openWorkspaceDialogKey: 0,
    showTodos: false,
    showMobileActions: false,
    handleWorkspaceFiles: () => {},
    handleCodingSidebarToggle: () => {},
    handleOpenWorkspaceDialog: () => {},
    handleCodingFileSelect: () => {},
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
    codingPanelDragOffset: null,
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
mock.module('@/utils/workspace', () => ({ workspaceLabel: (workspace: string) => workspace }))

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
