/**
 * The session's work as the chat hands it around: its task list to the
 * header and the task panel, its plan to the panel (whose Clear asks the
 * server and says so when that fails), and a live goal to the header's
 * ring and the panel.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { forwardRef, useImperativeHandle } from 'react'
import type React from 'react'
import { AgentChatView } from '@/components/AgentChatView'
import type { SessionGoal } from '@/api/types'

const clears: string[] = []
let clearFails = false
const toasts: Array<{ title: string }> = []
let goal: SessionGoal | null = null

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
mock.module('@/queries/useTodosQuery', () => ({
  useTodosQuery: (sessionId: string | null) => ({ data: { todos: sessionId ? [{ task_id: 't1', content: 'Write the test', status: 'in_progress' }] : [] } }),
}))
mock.module('@/queries/useSessionPlanQuery', () => ({
  useSessionPlanQuery: () => ({ data: { plan: '# Ship it' } }),
  useClearSessionPlanMutation: () => ({
    mutate: (sessionId: string, options: { onError: (err: unknown) => void }) => {
      clears.push(sessionId)
      if (clearFails) options.onError(new Error('disk full'))
    },
  }),
}))
mock.module('@/queries/useSessionGoalQuery', () => ({
  useSessionGoalQuery: () => ({ data: goal ? { goal } : undefined }),
  useGoalActionMutation: () => ({ mutate: () => {} }),
  useGoalControls: () => undefined,
}))
mock.module('@/queries', () => ({ useProvidersQuery: () => ({ data: { providers: [] } }) }))
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
// Selector-aware on purpose: components read this store as
// ``useToastStore((s) => s.push)``, so a mock that ignores the selector hands
// back the state object where a function is expected.
mock.module('@/stores/useToastStore', () => ({
  useToastStore: (selector: (s: { push: (toast: { title: string }) => void }) => unknown) => selector({ push: (toast) => { toasts.push(toast) } }),
}))
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
mock.module('@/components/AgentView', () => ({ AgentView: () => null }))
mock.module('@/components/WorkspaceInfoCard', () => ({ WorkspaceInfoCard: () => null, RecentSessionsList: () => null, ChatNote: () => null }))
mock.module('@/components/Sidebar', () => ({ Sidebar: () => null }))
mock.module('@/components/WorkspacePanel', () => ({ WorkspacePanel: () => null }))
mock.module('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))
mock.module('@/components/AgentChatView/AgentChatHeader', () => ({
  AgentChatHeader: ({ todos, goalState }: { todos: Array<{ content: string }>; goalState: unknown }) => (
    <header data-testid="header">{`tasks: ${todos.map((t) => t.content).join(', ')}; goal: ${goalState ? 'shown' : 'none'}`}</header>
  ),
}))
mock.module('@/components/AgentChatView/AgentChatPanels', () => ({
  AgentChatPanels: ({ todos, plan, goal: panelGoal, onClearPlan }: { todos: unknown[]; plan: string | null; goal: SessionGoal | null; onClearPlan: () => void }) => (
    <section data-testid="panels">
      {`tasks: ${todos.length}; plan: ${plan}; goal: ${panelGoal?.objective ?? 'none'}`}
      <button type="button" onClick={onClearPlan}>Clear plan</button>
    </section>
  ),
}))
mock.module('@/components/AgentChatView/useAgentCommands', () => ({ useAgentCommands: () => [] }))
mock.module('@/components/AgentChatView/usePaletteSwitchCommands', () => ({ usePaletteSwitchCommands: () => [] }))

// Stands in for the composer: a submit button that fires ``onSubmit`` exactly
// as the real bar does, plus the restore entry point under test.
mock.module('@/components/composer/Composer', () => ({
  Composer: forwardRef<
    Record<string, (...args: never[]) => void>,
    { onSubmit: (content: string, files?: File[], mentions?: string[]) => void | Promise<void> }
  >(function ComposerMock({ onSubmit }, ref) {
    useImperativeHandle(ref, () => ({
      focus: () => {},
      setValue: () => {},
      appendValue: () => {},
      insertText: () => {},
      setFiles: () => {},
      addFiles: () => {},
      restoreLastSubmission: () => {},
    }))
    return (
      <button type="button" onClick={() => void onSubmit('hello team')}>
        submit
      </button>
    )
  }),
}))

mock.module('@/stores/useAgentStore', () => {
  const state = {
    connectStream: () => null,
    loadAgentStatus: async () => {},
    loadSession: async () => {},
    sendMessage: async () => true,
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

const activeGoal: SessionGoal = {
  id: 'g1',
  session_id: 'test-session',
  objective: 'Make the suite green',
  status: 'active',
  pause_reason: null,
  detail: null,
  max_turns: 10,

  turns_used: 1,
  tokens_used: 100,
  active_seconds: 30,
  rejected_claims: 0,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  ended_at: null,
}

afterEach(cleanup)
beforeEach(() => {
  clears.length = 0
  toasts.length = 0
  clearFails = false
  goal = null
})

describe("AgentChatView and the session's work", () => {
  it('hands the task list to the header and the panel, and the plan to the panel', () => {
    render(<AgentChatView sessionId="test-session" workspace="/repo/project" />)
    expect(screen.getByTestId('header').textContent).toBe('tasks: Write the test; goal: none')
    expect(screen.getByTestId('panels').textContent).toContain('tasks: 1; plan: # Ship it; goal: none')
  })

  it("clears the session's plan on the server", () => {
    render(<AgentChatView sessionId="test-session" workspace="/repo/project" />)
    fireEvent.click(screen.getByRole('button', { name: 'Clear plan' }))
    expect(clears).toEqual(['test-session'])
    expect(toasts).toEqual([])
  })

  it('says so when the plan could not be cleared', () => {
    clearFails = true
    render(<AgentChatView sessionId="test-session" workspace="/repo/project" />)
    fireEvent.click(screen.getByRole('button', { name: 'Clear plan' }))
    expect(toasts.map((t) => t.title)).toEqual(["Couldn't clear the plan"])
  })

  it('shows a live goal on the header and in the panel', () => {
    goal = activeGoal
    render(<AgentChatView sessionId="test-session" workspace="/repo/project" />)
    expect(screen.getByTestId('header').textContent).toBe('tasks: Write the test; goal: shown')
    expect(screen.getByTestId('panels').textContent).toContain('goal: Make the suite green')
  })
})
