/**
 * A phone's chat view is a navigation stack: the sidebar is the Sessions
 * screen underneath, the chat (header and all) is pushed over it, and the
 * header's ‹ goes back up to Sessions. Desktop keeps the sidebar beside the
 * chat. The route decides which is on top (routes/cockpit.tsx).
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, fireEvent, screen } from '@testing-library/react'
import { forwardRef, useImperativeHandle } from 'react'
import type React from 'react'
import { AgentChatView } from '@/components/AgentChatView'

let centerWidth = 1200
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
mock.module('@/hooks/use-mobile', () => ({ useIsMobile: () => true }))
mock.module('@/hooks/use-platform', () => ({ usePlatform: () => ({ isMacOverlay: false, os: 'ios' }), getPlatform: () => ({ isMacOverlay: false, os: 'ios' }) }))
mock.module('@/hooks/use-tauri-drag', () => ({ useTauriDrag: () => ({}) }))
mock.module('@/hooks/useKeyboardShortcuts', () => ({ useKeyboardShortcuts: () => {} }))
mock.module('@/stores/useUIStore', () => {
  const ui = {
    schedulerOpen: false,
    runPickerOpen: false,
    toggleScheduler: () => {},
    toggleRunPicker: () => {},
    closeScheduler: () => {},
    closeRunPicker: () => {},
  }
  return {
    useUIStore: Object.assign((selector: (state: Record<string, unknown>) => unknown) => selector(ui), { getState: () => ui }),
  }
})
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
mock.module('@/components/WorkspaceInfoCard', () => ({ WorkspaceInfoCard: () => null, RecentSessionsList: () => null }))
// The sidebar is the Sessions screen on a phone: record how it is asked to render.
mock.module('@/components/Sidebar', () => ({
  Sidebar: ({ page, mobileOpen }: { page?: boolean; mobileOpen?: boolean }) => (
    <nav data-testid="sessions" data-page={String(Boolean(page))} data-open={String(Boolean(mobileOpen))} />
  ),
}))
mock.module('@/components/WorkspacePanel', () => ({
  WorkspacePanel: ({ onClose }: { onClose: () => void }) => (
    <aside data-testid="coding-workspace-panel">
      <button type="button" onClick={onClose}>Close workspace panel</button>
    </aside>
  ),
}))
mock.module('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="presence-boundary">{children}</div>
  ),
}))
mock.module('@/components/AgentChatView/AgentChatHeader', () => ({
  AgentChatHeader: ({ onWorkspaceFiles, onBack }: { onWorkspaceFiles: () => void; onBack?: () => void }) => (
    <header>
      {onBack && <button type="button" onClick={onBack}>Back to Sessions</button>}
      <button type="button" onClick={onWorkspaceFiles}>Toggle workspace panel</button>
    </header>
  ),
}))
mock.module('@/components/AgentChatView/AgentChatPanels', () => ({ AgentChatPanels: () => null }))
mock.module('@/components/AgentChatView/useAgentCommands', () => ({ useAgentCommands: () => [] }))
mock.module('@/components/AgentChatView/usePaletteSwitchCommands', () => ({ usePaletteSwitchCommands: () => [] }))
mock.module('@/components/composer/Composer', () => ({
  Composer: forwardRef<
    { setValue: (value: string) => void; setFiles: (files: File[]) => void; addFiles: (files: File[]) => void },
    unknown
  >(function ComposerMock(_, ref) {
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

afterEach(cleanup)
beforeEach(() => {
  centerWidth = 1200
})

const stack = () => document.querySelector('[data-phone-stack]')
const pageLayer = () => document.querySelector('[data-phone-stack-page]') as HTMLElement
const rootLayer = () => document.querySelector('[data-phone-stack-root]') as HTMLElement

describe('the phone navigation stack', () => {
  it('shows Sessions on top with the chat waiting under it', () => {
    render(<AgentChatView sessionId="test-session" workspace="/repo/project" phoneStack={{ atSessions: true, onBack: () => {} }} />)
    expect(stack()).not.toBeNull()
    const sessions = screen.getByTestId('sessions')
    expect(sessions.dataset.page).toBe('true')
    expect(sessions.dataset.open).toBe('true')
    expect(rootLayer().contains(sessions)).toBe(true)
    expect(pageLayer().hasAttribute('inert')).toBe(true)
  })

  it('pushes the chat over Sessions, whose list is closed to touch', () => {
    render(<AgentChatView sessionId="test-session" workspace="/repo/project" phoneStack={{ atSessions: false, onBack: () => {} }} />)
    expect(pageLayer().hasAttribute('inert')).toBe(false)
    expect(pageLayer().contains(screen.getByRole('textbox', { name: 'Message input' }))).toBe(true)
    expect(screen.getByTestId('sessions', { exact: true }).dataset.open).toBe('false')
  })

  it('goes back up to Sessions from the header', () => {
    const onBack = mock(() => {})
    render(<AgentChatView sessionId="test-session" workspace="/repo/project" phoneStack={{ atSessions: false, onBack }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Back to Sessions' }))
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('keeps the sidebar beside the chat without a stack', () => {
    render(<AgentChatView sessionId="test-session" workspace="/repo/project" />)
    expect(stack()).toBeNull()
    expect(screen.getByTestId('sessions').dataset.page).toBe('false')
    expect(screen.queryByRole('button', { name: 'Back to Sessions' })).toBeNull()
  })
})
