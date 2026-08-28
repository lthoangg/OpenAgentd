/**
 * A failed send must hand the draft back to the composer. The composer clears
 * optimistically on submit, so without this wiring the message and its
 * attachments are destroyed by any network/validation failure.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { forwardRef, useImperativeHandle } from 'react'
import type React from 'react'
import { TeamChatView } from '@/components/TeamChatView'

const restoreLastSubmissionMock = mock(() => {})
let sendSucceeds = true
const sentMessages: string[] = []

mock.module('@tanstack/react-router', () => ({
  useNavigate: () => mock(() => Promise.resolve()),
}))
mock.module('@tanstack/react-query', () => ({
  useQueryClient: () => ({}),
  useQuery: () => ({ data: undefined, isLoading: false }),
  QueryClientProvider: ({ children }: { children: unknown }) => children,
}))
mock.module('@/queries/useTodosQuery', () => ({ useTodosQuery: () => ({ data: { todos: [] } }) }))
mock.module('@/queries', () => ({ useProvidersQuery: () => ({ data: { providers: [] } }) }))
mock.module('@/queries/useCommandsQuery', () => ({ useCommandsQuery: () => ({ data: { commands: [] } }) }))
mock.module('@/queries/useSnippetsQuery', () => ({ useSnippetsQuery: () => ({ data: { snippets: [] } }) }))
mock.module('@/queries/useAgentsQuery', () => ({
  useTeamAgentsQuery: () => ({ data: { agents: [{ capabilities: undefined }] }, isLoading: false }),
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
// Selector-aware on purpose: components read this store as
// ``useToastStore((s) => s.push)``, so a mock that ignores the selector hands
// back the state object where a function is expected.
mock.module('@/stores/useToastStore', () => ({
  useToastStore: (selector: (s: { push: () => void }) => unknown) => selector({ push: () => {} }),
}))
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
mock.module('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))
mock.module('@/components/CodingFileViewerPanel', () => ({ CodingFileViewerPanel: () => null }))
mock.module('@/components/Sidebar', () => ({ Sidebar: () => null }))
mock.module('@/components/TeamChatView/TeamChatHeader', () => ({ TeamChatHeader: () => null }))
mock.module('@/components/TeamChatView/TeamChatPanels', () => ({ TeamChatPanels: () => null }))
mock.module('@/components/TeamChatView/useTeamCommands', () => ({ useTeamCommands: () => [] }))

// Stands in for the composer: a submit button that fires ``onSubmit`` exactly
// as the real bar does, plus the restore entry point under test.
mock.module('@/components/FloatingInputComposer', () => ({
  FloatingInputComposer: forwardRef<
    Record<string, (...args: never[]) => void>,
    { onSubmit: (content: string, files?: File[], mentions?: string[]) => void | Promise<void> }
  >(function FloatingInputComposerMock({ onSubmit }, ref) {
    useImperativeHandle(ref, () => ({
      focus: () => {},
      setValue: () => {},
      appendValue: () => {},
      insertText: () => {},
      setFiles: () => {},
      addFiles: () => {},
      restoreLastSubmission: restoreLastSubmissionMock,
    }))
    return (
      <button type="button" onClick={() => void onSubmit('hello team')}>
        submit
      </button>
    )
  }),
}))

mock.module('@/stores/useTeamStore', () => {
  const state = {
    connectStream: () => null,
    loadTeamStatus: async () => {},
    loadSession: async () => {},
    sendMessage: async (content: string) => {
      sentMessages.push(content)
      return sendSucceeds
    },
    beginResolvedSession: () => {},
    consumeResolvedSessionReady: () => false,
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
  restoreLastSubmissionMock.mockClear()
  sentMessages.length = 0
  sendSucceeds = true
})

describe('TeamChatView send failure', () => {
  it('restores the draft when the send is rejected', async () => {
    sendSucceeds = false
    render(<TeamChatView sessionId="test-session" workspace="/repo/project" />)

    fireEvent.click(screen.getByText('submit'))

    await waitFor(() => expect(restoreLastSubmissionMock).toHaveBeenCalledTimes(1))
  })

  it('leaves the cleared composer alone when the send succeeds', async () => {
    sendSucceeds = true
    render(<TeamChatView sessionId="test-session" workspace="/repo/project" />)

    fireEvent.click(screen.getByText('submit'))

    await waitFor(() => expect(sentMessages).toEqual(['hello team']))
    expect(restoreLastSubmissionMock).not.toHaveBeenCalled()
  })
})
