/**
 * ``/btw <question>`` from the composer is a side question, never a chat
 * message: it asks in the session and opens its side questions. Without a
 * session, or with attachments, it is refused with a toast and the draft is
 * put back in the composer.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { forwardRef, useImperativeHandle } from 'react'
import type React from 'react'
import { AgentChatView } from '@/components/AgentChatView'
import { useAgentStore } from '@/stores/useAgentStore'
import { useBtwStore } from '@/stores/useBtwStore'
import { runOf } from '@/stores/useAgentStore/run-state'
import { linkOf } from '@/stores/useAgentStore/link-state'

const setValueMock = mock((..._args: unknown[]) => {})
const setFilesMock = mock((..._args: unknown[]) => {})
const toasts: Array<{ title: string }> = []
const sentMessages: string[] = []
let submission: { content: string; files?: File[] } = { content: '' }

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
mock.module('@/components/AgentChatView/AgentChatHeader', () => ({ AgentChatHeader: () => null }))
mock.module('@/components/AgentChatView/AgentChatPanels', () => ({ AgentChatPanels: () => null }))
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
      setValue: setValueMock,
      appendValue: () => {},
      insertText: () => {},
      setFiles: setFilesMock,
      addFiles: () => {},
      restoreLastSubmission: () => {},
    }))
    return (
      <button type="button" onClick={() => void onSubmit(submission.content, submission.files)}>
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
    sendMessage: async (content: string) => {
      sentMessages.push(content)
      return true
    },
    beginResolvedSession: () => {},
    consumeResolvedSessionReady: () => false,
    setActiveAgent: () => {},
    setSessionModelSettings: () => {},
    setupRequired: null,
    dismissSetupRequired: () => {},
    activeAgent: 'code',
    agentStreams: { lead: { blocks: [], currentBlocks: [], status: 'idle', lastError: null, revertedCount: 0, revertedMessages: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 } } },
    agentNames: ['lead'],
    sessionRun: runOf(false),
    questionCard: { kind: 'none' as const },
    isContinuing: false,
    sessionId: 'test-session' as string | null,
    sessionTitle: null,
    sessionModel: null,
    sessionThinkingLevel: null,
    sessionFastMode: false,
    leadName: 'lead',
    streamLink: linkOf(false),
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

const asked: Array<[string, string]> = []
const realAsk = useBtwStore.getState().ask

afterEach(() => {
  cleanup()
  useBtwStore.setState({ ask: realAsk })
  useAgentStore.setState({ sessionId: 'test-session' })
})
beforeEach(() => {
  setValueMock.mockClear()
  setFilesMock.mockClear()
  toasts.length = 0
  sentMessages.length = 0
  asked.length = 0
  useBtwStore.setState({ ask: async (sessionId, question) => { asked.push([sessionId, question]) } })
})

function submit(content: string, files?: File[]) {
  submission = { content, files }
  fireEvent.click(screen.getByText('submit'))
}

describe('AgentChatView /btw from the composer', () => {
  it('asks the side question in the session and sends nothing to the chat', async () => {
    render(<AgentChatView sessionId="test-session" workspace="/repo/project" />)
    submit('/btw why is the build slow?')
    await waitFor(() => expect(asked).toEqual([['test-session', 'why is the build slow?']]))
    expect(sentMessages).toEqual([])
    expect(toasts).toEqual([])
  })

  it('refuses attachments with a toast and puts the question and files back', async () => {
    const file = new File(['x'], 'shot.png', { type: 'image/png' })
    render(<AgentChatView sessionId="test-session" workspace="/repo/project" />)
    submit('/btw what is this?', [file])
    await waitFor(() => expect(setValueMock).toHaveBeenCalledWith('/btw what is this?'))
    expect(setFilesMock).toHaveBeenCalledWith([file])
    expect(toasts.map((t) => t.title)).toEqual(["Side questions can't include attachments"])
    expect(asked).toEqual([])
    expect(sentMessages).toEqual([])
  })

  it('asks for a conversation first while no session is loaded, and puts the question back', async () => {
    useAgentStore.setState({ sessionId: null })
    render(<AgentChatView sessionId="test-session" workspace="/repo/project" />)
    submit('/btw anything?')
    await waitFor(() => expect(setValueMock).toHaveBeenCalledWith('/btw anything?'))
    expect(toasts.map((t) => t.title)).toEqual(['Start a conversation first'])
    expect(asked).toEqual([])
    expect(sentMessages).toEqual([])
  })

  it('sends anything else as a chat message', async () => {
    render(<AgentChatView sessionId="test-session" workspace="/repo/project" />)
    submit('hello team')
    await waitFor(() => expect(sentMessages).toEqual(['hello team']))
    expect(asked).toEqual([])
  })
})
