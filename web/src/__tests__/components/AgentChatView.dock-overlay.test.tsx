/**
 * The Review panel over a narrow chat (centre under 740 px) covers the
 * transcript but stops above the composer, so a message can be written
 * beside the diff: the transcript goes inert, the composer stays usable.
 * Maximized, it covers both. Wide enough, it covers nothing.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, render, fireEvent, screen } from '@testing-library/react'
import { forwardRef, useImperativeHandle } from 'react'
import type React from 'react'
import { AgentChatView } from '@/components/AgentChatView'
import { useLayoutStore } from '@/stores/useLayoutStore'

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
mock.module('@/hooks/use-mobile', () => ({ useIsMobile: () => false }))
mock.module('@/hooks/use-platform', () => ({ usePlatform: () => ({ isMacOverlay: false, os: 'linux' }) }))
mock.module('@/hooks/use-tauri-drag', () => ({ useTauriDrag: () => ({}) }))
mock.module('@/hooks/useKeyboardShortcuts', () => ({ useKeyboardShortcuts: () => {} }))
mock.module('@/stores/useUIStore', () => ({
  useUIStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    schedulerOpen: false,
    runPickerOpen: false,
    toggleScheduler: () => {},
    toggleRunPicker: () => {},
    closeScheduler: () => {},
    closeRunPicker: () => {},
  }),
}))
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
mock.module('@/components/Sidebar', () => ({ Sidebar: () => null }))
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

afterEach(() => {
  cleanup()
  act(() => { useLayoutStore.setState({ dockMaximized: false }) })
})
beforeEach(() => {
  centerWidth = 1200
})

async function openDock() {
  render(<AgentChatView sessionId="test-session" workspace="/repo/project" />)
  fireEvent.click(screen.getByRole('button', { name: 'Toggle workspace panel' }))
  await screen.findByTestId('coding-workspace-panel')
}

const transcriptInert = () => screen.getByRole('button', { name: 'Transcript content', hidden: true }).closest('[inert]') !== null
const composerInert = () => screen.getByRole('textbox', { name: 'Message input', hidden: true }).closest('[inert]') !== null

describe('Review panel over the chat', () => {
  it('leaves transcript and composer alone beside a wide chat', async () => {
    await openDock()
    expect(transcriptInert()).toBe(false)
    expect(composerInert()).toBe(false)
  })

  it('covers only the transcript over a narrow chat; the composer stays usable', async () => {
    centerWidth = 600
    await openDock()
    expect(transcriptInert()).toBe(true)
    expect(composerInert()).toBe(false)
  })

  it('covers the whole chat when maximized', async () => {
    centerWidth = 600
    await openDock()
    await act(async () => { useLayoutStore.setState({ dockMaximized: true }) })
    expect(transcriptInert()).toBe(true)
    expect(composerInert()).toBe(true)
  })
})
