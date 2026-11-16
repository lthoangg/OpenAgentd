/**
 * The chat's side of the Preview tab, as the Review panel and the composer
 * see it: the agent (or a tool card) opening a page opens the panel on it,
 * and a design-feedback chip removed from the composer goes back to its
 * Preview tab's comments, opening that tab.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, render, screen } from '@testing-library/react'
import { forwardRef, useImperativeHandle } from 'react'
import type React from 'react'
import { AgentChatView } from '@/components/AgentChatView'
import { useReturnedFeedbackStore } from '@/stores/useReturnedFeedbackStore'
import { OPEN_PREVIEW_EVENT } from '@/components/Preview/preview-events'
import { previewsAvailable } from '@/api/preview'
import type { DesignFeedback } from '@/lib/design-feedback'

let composerProps: { onDesignFeedbackRemoved?: (feedback: DesignFeedback) => void } = {}

const centerWidth = 1200
mock.module('@/hooks/use-element-width', () => ({
  useElementWidthSelect: <T,>(_ref: unknown, select: (width: number) => T) => select(centerWidth),
  useElementWidth: () => centerWidth,
}))

const setValueMock = mock(() => {})
const setFilesMock = mock(() => {})
const addFilesMock = mock(() => {})

mock.module('@tanstack/react-router', () => ({
  useNavigate: () => mock(() => Promise.resolve()),
}))

mock.module('@tanstack/react-query', () => ({
  QueryClient: class {},
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
  useGoalControls: () => undefined,
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
mock.module('@/components/AgentView', () => ({ AgentView: () => <button type="button">Transcript content</button> }))
mock.module('@/components/WorkspaceInfoCard', () => ({ WorkspaceInfoCard: () => null, RecentSessionsList: () => null, ChatNote: () => null }))
mock.module('@/components/Sidebar', () => ({ Sidebar: () => null }))
mock.module('@/components/WorkspacePanel', () => ({
  WorkspacePanel: ({ open, previewRequest }: { open: boolean; previewRequest: { target: { kind: string; url?: string; path?: string }; key: number; focusOnly?: boolean } | null }) => (
    <aside data-testid="coding-workspace-panel" data-open={open ? '' : undefined}>
      {previewRequest ? `${previewRequest.target.url ?? previewRequest.target.path}${previewRequest.focusOnly ? ' (focus only)' : ''}` : 'no preview'}
    </aside>
  ),
}))
mock.module('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="presence-boundary">{children}</div>
  ),
}))
mock.module('@/components/AgentChatView/AgentChatHeader', () => ({
  AgentChatHeader: ({ onWorkspaceFiles }: { onWorkspaceFiles: () => void }) => (
    <button type="button" onClick={onWorkspaceFiles}>Toggle workspace panel</button>
  ),
}))
mock.module('@/components/AgentChatView/AgentChatPanels', () => ({ AgentChatPanels: () => null }))
mock.module('@/components/AgentChatView/useAgentCommands', () => ({ useAgentCommands: () => [] }))
mock.module('@/components/AgentChatView/usePaletteSwitchCommands', () => ({ usePaletteSwitchCommands: () => [] }))
mock.module('@/components/composer/Composer', () => ({
  Composer: forwardRef<
    { setValue: (value: string) => void; setFiles: (files: File[]) => void; addFiles: (files: File[]) => void },
    unknown
  >(function ComposerMock(props, ref) {
    composerProps = props as { onDesignFeedbackRemoved?: (feedback: DesignFeedback) => void }
    useImperativeHandle(ref, () => ({
      setValue: setValueMock,
      setFiles: setFilesMock,
      addFiles: addFilesMock,
    }))
    return <textarea aria-label="Message input" />
  }),
}))

mock.module('@/stores/useAgentStore', () => {
  const state = {
    connectStream: () => null,
    loadAgentStatus: async () => {},
    loadSession: async () => {},
    sendMessage: async () => {},
    beginResolvedSession: () => {},
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
    sessionId: 'test-session',
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
        setState: (partial: Partial<typeof state>) => Object.assign(state, partial),
      },
    ),
  }
})

afterEach(() => {
  cleanup()
  act(() => { useReturnedFeedbackStore.setState({ items: [] }) })
})

const feedback: DesignFeedback = { where: 'http://localhost:5173/pricing', device: 'Desktop', items: [] }

describe('AgentChatView and the Preview tab', () => {
  it('runs where previews can be reached', () => {
    expect(previewsAvailable()).toBe(true)
  })

  it('opens the Review panel on a page the agent opens', async () => {
    render(<AgentChatView sessionId="test-session" workspace="/repo/project" />)
    expect(screen.queryByTestId('coding-workspace-panel')).toBeNull()
    act(() => {
      window.dispatchEvent(new CustomEvent(OPEN_PREVIEW_EVENT, { detail: { kind: 'url', url: 'http://localhost:3000/' } }))
    })
    const panel = await screen.findByTestId('coding-workspace-panel')
    expect(panel.hasAttribute('data-open')).toBe(true)
    expect(panel.textContent).toBe('http://localhost:3000/')
  })

  it('ignores an open request that names no page', async () => {
    render(<AgentChatView sessionId="test-session" workspace="/repo/project" />)
    act(() => {
      window.dispatchEvent(new CustomEvent(OPEN_PREVIEW_EVENT, { detail: { kind: 'nothing' } }))
    })
    expect(screen.queryByTestId('coding-workspace-panel')).toBeNull()
  })

  it('gives a removed feedback chip back to its Preview tab and shows that tab', async () => {
    render(<AgentChatView sessionId="test-session" workspace="/repo/project" />)
    act(() => { composerProps.onDesignFeedbackRemoved?.(feedback) })
    expect(useReturnedFeedbackStore.getState().items).toEqual([{ workspace: '/repo/project', feedback }])
    const panel = await screen.findByTestId('coding-workspace-panel')
    expect(panel.textContent).toBe('http://localhost:5173/pricing (focus only)')
  })
})
