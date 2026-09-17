import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { forwardRef, useImperativeHandle } from 'react'
import { AgentChatView } from '@/components/AgentChatView'

const sentMessages: string[] = []
let switchedMode: string | null = null
let setSessionInteractionModeResult = true
const toastedAlerts: Array<{ tone: string; title: string; description?: string }> = []

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
    agentCapabilitiesOpen: false,
    toggleScheduler: () => {},
    toggleAgentCapabilities: () => {},
    closeScheduler: () => {},
    closeAgentCapabilities: () => {},
  }),
}))
mock.module('@/stores/useToastStore', () => ({
  useToastStore: (selector: (s: { push: (t: { tone: string; title: string; description?: string }) => void }) => unknown) => selector({
    push: (t: { tone: string; title: string; description?: string }) => { toastedAlerts.push(t) },
  }),
}))
mock.module('@/components/CodingSidebar', () => ({ CodingSidebar: () => null }))
mock.module('@/components/AgentChatView/AgentChatPanels', () => ({ AgentChatPanels: () => null }))
mock.module('@/components/AgentChatView/AgentChatHeader', () => ({ AgentChatHeader: () => null }))
mock.module('@/components/CodingWorkspacePanel', () => ({ CodingWorkspacePanel: () => null }))
mock.module('@/components/CodingFileViewerPanel', () => ({ CodingFileViewerPanel: () => null }))
mock.module('@/components/FloatingInputComposer', () => ({
  FloatingInputComposer: forwardRef<
    Record<string, (...args: never[]) => void>,
    { onSubmit: (content: string, files?: File[], mentions?: string[]) => void | Promise<void> }
  >(function FloatingInputComposerMock(_props, ref) {
    useImperativeHandle(ref, () => ({
      focus: () => {},
      setValue: () => {},
      appendValue: () => {},
      insertText: () => {},
      setFiles: () => {},
      addFiles: () => {},
      restoreLastSubmission: () => {},
    }))
    return <div data-testid="composer" />
  }),
}))
mock.module('@/components/AgentView', () => ({
  AgentView: ({ onStartImplementing, isSwitchingInteractionMode }: { onStartImplementing?: () => void; isSwitchingInteractionMode?: boolean }) => (
    <div>
      {onStartImplementing && (
        <button onClick={onStartImplementing} disabled={isSwitchingInteractionMode} data-testid="start-implementing-btn">
          Approve
        </button>
      )}
    </div>
  ),
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
    setSessionInteractionMode: async (mode: string) => {
      switchedMode = mode
      return setSessionInteractionModeResult
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
    isAgentWorking: false,
    isContinuing: false,
    sessionId: 'test-session',
    sessionTitle: null,
    sessionModel: null,
    sessionThinkingLevel: null,
    sessionFastMode: false,
    sessionInteractionMode: 'plan',
    leadName: 'lead',
    isConnected: false,
    error: 'Simulated failure',
    _workspace: '/repo/from-store',
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
  sentMessages.length = 0
  switchedMode = null
  setSessionInteractionModeResult = true
  toastedAlerts.length = 0
})

describe('AgentChatView plan approve action', () => {
  it('switches to code mode and sends "Approve, proceed." when approve is clicked', async () => {
    render(<AgentChatView sessionId="test-session" workspace="/repo/project" />)

    const btn = screen.getByTestId('start-implementing-btn')
    expect(btn).toBeTruthy()

    fireEvent.click(btn)

    await waitFor(() => {
      expect(switchedMode).toBe('code')
      expect(sentMessages).toEqual(['Approve, proceed.'])
    })
  })

  it('does not send message and pushes toast when setSessionInteractionMode fails', async () => {
    setSessionInteractionModeResult = false
    render(<AgentChatView sessionId="test-session" workspace="/repo/project" />)

    const btn = screen.getByTestId('start-implementing-btn')
    expect(btn).toBeTruthy()

    fireEvent.click(btn)

    await waitFor(() => {
      expect(switchedMode).toBe('code')
      expect(sentMessages).toEqual([])
      expect(toastedAlerts.length).toBe(1)
      expect(toastedAlerts[0].title).toBe('Could not switch to Code mode')
      expect(toastedAlerts[0].description).toBe('Simulated failure')
    })
  })

  it('falls back to store._workspace when workspace prop is null', async () => {
    render(<AgentChatView sessionId="test-session" workspace={null} />)

    const btn = screen.getByTestId('start-implementing-btn')
    expect(btn).toBeTruthy()

    fireEvent.click(btn)

    await waitFor(() => {
      expect(switchedMode).toBe('code')
      expect(sentMessages).toEqual(['Approve, proceed.'])
    })
  })
})
