import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, render, screen } from '@testing-library/react'
import { forwardRef, useImperativeHandle, type ReactNode } from 'react'
import { useAgentStore } from '@/stores/useAgentStore'
import { useTranscriptFollowStore } from '@/stores/useTranscriptFollowStore'
import type { ContentBlock } from '@/api/types'
import { queryKeys } from '@/queries/keys'

// lucide-react is deliberately NOT mocked here. Bun validates every static
// named import in the tree against the mock's own keys, so an explicit icon map
// fails the moment any component in this (large) tree adopts another icon —
// which surfaces as an unrelated module-resolution error rather than a test
// failure. The real icons render fine and cost nothing measurable.
mock.module('@tanstack/react-router', () => ({ useNavigate: () => () => Promise.resolve() }))
mock.module('@tanstack/react-query', () => ({
  QueryClient: class {},
  useQueryClient: () => ({}),
  useQuery: () => ({ data: undefined, isLoading: false }),
  useInfiniteQuery: () => ({ data: undefined, isLoading: false }),
  useMutation: () => ({ mutate: () => {} }),
  QueryClientProvider: ({ children }: { children: unknown }) => children,
}))
mock.module('@/queries/useTodosQuery', () => ({ useTodosQuery: () => ({ data: { todos: [] } }) }))
mock.module('@/queries/useSessionPlanQuery', () => ({
  useSessionPlanQuery: () => ({ data: { plan: null } }),
  useClearSessionPlanMutation: () => ({ mutate: () => {} }),
}))
mock.module('@/queries', () => ({ queryKeys, useProvidersQuery: () => ({ data: { providers: [] } }), useHealthQuery: () => ({ isSuccess: true, isError: false }) }))
mock.module('@/queries/useAgentsQuery', () => ({
  useAgentsQuery: () => ({ data: { agents: [{ name: 'code' }] }, isLoading: false }),
}))
mock.module('@/queries/useAgentSettingsQueries', () => ({
  useRegistryQuery: () => ({ data: { models: [] } }),
  useUpdateAgentMutation: () => ({ mutateAsync: async () => ({}), isPending: false }),
}))
mock.module('@/queries/useFileRefsQuery', () => ({ useFileRefsQuery: () => ({ refs: [] }) }))
mock.module('@/hooks/use-mobile', () => ({ useIsMobile: () => false }))
mock.module('@/hooks/use-platform', () => ({ usePlatform: () => ({ isMacOverlay: false, os: 'linux' }) }))
mock.module('@/hooks/use-tauri-drag', () => ({ useTauriDrag: () => ({}) }))
mock.module('@/stores/useUIStore', () => ({
  useUIStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    schedulerOpen: false,
    runPickerOpen: false,
    paletteOpen: false,
    toggleScheduler: () => {},
    toggleRunPicker: () => {},
    togglePalette: () => {},
    closeScheduler: () => {},
    closeRunPicker: () => {},
    closePalette: () => {},
  }),
}))
mock.module('@/stores/useSettingsStore', () => ({ useSettingsStore: () => () => {} }))
mock.module('@/components/AgentView', () => ({ AgentView: () => null }))
mock.module('@/components/WorkspaceInfoCard', () => ({ WorkspaceInfoCard: () => null, RecentSessionsList: () => null }))
mock.module('@/components/Sidebar', () => ({ Sidebar: () => null }))
mock.module('@/components/WorkspacePanel', () => ({ WorkspacePanel: () => null }))
mock.module('@/components/AppFooter', () => ({ AppFooter: () => null }))
mock.module('@/components/AgentChatView/AgentChatPanels', () => ({ AgentChatPanels: () => null }))
mock.module('@/components/AgentChatView/AgentChatHeader', () => ({
  AgentChatHeader: ({ agentNames }: { agentNames?: string[] }) => (
    <div data-testid="header-agents">{(agentNames ?? []).join(',')}</div>
  ),
}))
// The context meter rides in the composer's run deck, on every layout.
mock.module('@/components/composer/ContextMeter', () => ({
  ContextMeter: (props: Record<string, unknown>) => (
    <div data-testid="context-meter" data-props={Object.keys(props).sort().join(',')} />
  ),
}))
/** The composer's ``onHistoryRecall``, as the mounted chat view passed it. */
let recall: ((prompt: string | null) => void) | undefined

mock.module('@/components/composer/Composer', () => ({
  Composer: forwardRef<
    { setValue: (value: string) => void; setFiles: (files: File[]) => void },
    { historyPrompts?: string[]; onHistoryRecall?: (prompt: string | null) => void; deckEnd?: ReactNode; placeholder?: string }
  >(function ComposerMock({ historyPrompts, onHistoryRecall, deckEnd, placeholder }, ref) {
    useImperativeHandle(ref, () => ({ setValue: () => {}, setFiles: () => {} }))
    recall = onHistoryRecall
    return (
      <>
        <div data-testid="history-prompts">{(historyPrompts ?? []).join(',')}</div>
        <div data-testid="composer-placeholder">{placeholder}</div>
        {deckEnd}
      </>
    )
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
    handleWorkspaceFiles: () => {},
    handleSidebarToggle: () => {},
    handleOpenWorkspaceDialog: () => {},
    handleFileSelect: () => {},
    handleMentionFileOpen: () => {},
    handleToggleRunPicker: () => {},
    handleToggleScheduler: () => {},
    handleTogglePalette: () => {},
    handleSetShowTodos: () => {},
    handleToggleFilesPanel: () => {},
    handleOpenTerminal: () => {},
    openLeftDrawer: () => {},
    edgeSwipeHandlers: {},
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
mock.module('@/utils/workspace', () => ({ saveLastWorkspace: () => {}, removeWorkspace: () => {}, workspaceLabel: (workspace: string) => workspace, sameWorkspacePath: (a: string, b: string) => a === b, pathBasename: (path: string) => path.split('/').pop() ?? path, getChatWorkspaceEntry: () => null, setChatWorkspaceEntry: () => {}, isVideoSrc: () => false }))

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

  it('shows the header meter while the team is working, before any usage lands', () => {
    // Usage arrives when the first model call completes, so gating on totals
    // alone hid the meter for the whole first response of a new session.
    useAgentStore.setState((state) => {
      state.isAgentWorking = true
      state.agentStreams.lead.status = 'working'
    })

    render(<AgentChatView sessionId="session-1" workspace="/repo/project" />)

    expect(screen.queryByTestId('context-meter')).not.toBeNull()
  })

  it('shows the header meter even when idle with no usage', () => {
    render(<AgentChatView sessionId="session-1" workspace="/repo/project" />)

    expect(screen.queryByTestId('context-meter')).not.toBeNull()
  })

  it('gives the context meter no cost: spend shows per turn and for the last 24 hours only', () => {
    render(<AgentChatView sessionId="session-1" workspace="/repo/project" />)

    const props = (screen.getByTestId('context-meter').getAttribute('data-props') ?? '').split(',')
    expect(props).toContain('input')
    expect(props).not.toContain('sessionCostUsd')
  })

  it('asks "Ask anything…" in the composer, without repeating the workspace name the screen already shows', () => {
    render(<AgentChatView sessionId="session-1" workspace="/repo/project" />)

    expect(screen.getByTestId('composer-placeholder').textContent).toBe('Ask anything…')
  })
})
