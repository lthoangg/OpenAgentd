/**
 * Verifies that the context meter's trigger threshold updates correctly when the
 * session switches from one model to another.
 *
 * The logic under test (in AgentChatView/index.tsx):
 *   - No session model override → use leadAgent.summary_trigger_tokens (from /agent/agents)
 *   - Session model set → look up that model in the registry and use its
 *     summary_trigger_tokens so the meter reflects the active model, not the
 *     agent config model.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render } from '@testing-library/react'
import { forwardRef, useImperativeHandle, type ReactNode } from 'react'

// ── Stable mocks required by AgentChatView ────────────────────────────────────

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
mock.module('@/queries', () => ({ useProvidersQuery: () => ({ data: { providers: [] } }) }))
mock.module('@/queries/useCommandsQuery', () => ({ useCommandsQuery: () => ({ data: { commands: [] } }) }))
mock.module('@/queries/useSnippetsQuery', () => ({ useSnippetsQuery: () => ({ data: { snippets: [] } }) }))
mock.module('@/queries/useFileRefsQuery', () => ({ useFileRefsQuery: () => ({ refs: [] }) }))
mock.module('@/hooks/use-mobile', () => ({ useIsMobile: () => false }))
mock.module('@/hooks/use-platform', () => ({ usePlatform: () => ({ isMacOverlay: false, os: 'linux' }) }))
mock.module('@/hooks/use-tauri-drag', () => ({ useTauriDrag: () => ({}) }))
mock.module('@/hooks/useKeyboardShortcuts', () => ({ useKeyboardShortcuts: () => {} }))
mock.module('@/stores/useToastStore', () => ({ useToastStore: () => ({ push: () => {} }) }))
mock.module('@/stores/cache-invalidation-bridge', () => ({ prependSession: () => {}, prependWorkspaceSession: () => {} }))
mock.module('@/utils/workspace', () => ({ saveLastWorkspace: () => {}, removeWorkspace: () => {}, workspaceLabel: (w: string) => w, sameWorkspacePath: (a: string, b: string) => a === b, getChatWorkspaceEntry: () => null, setChatWorkspaceEntry: () => {} }))
mock.module('@/lib/tray', () => ({ setTraySession: () => {} }))
mock.module('@/components/AgentView', () => ({ AgentView: () => null }))
mock.module('@/components/WorkspaceInfoCard', () => ({ WorkspaceInfoCard: () => null, RecentSessionsList: () => null }))
mock.module('@/components/Sidebar', () => ({ Sidebar: () => null }))
mock.module('@/components/WorkspacePanel', () => ({ WorkspacePanel: () => null }))
mock.module('@/components/AgentChatView/AgentChatPanels', () => ({ AgentChatPanels: () => null }))
mock.module('@/components/AgentChatView/useAgentCommands', () => ({ useAgentCommands: () => [] }))
mock.module('@/components/AgentChatView/usePaletteSwitchCommands', () => ({ usePaletteSwitchCommands: () => [] }))
mock.module('@/api/client', () => ({
  listCodingWorkspaceFiles: async () => [],
  getCodingWorkspaceTree: async () => ({ repositories: [], groups: [] }),
  setCodingWorkspaceVisibility: async () => ({}),
  renderCommand: async () => ({ content: '' }),
  renderSnippet: async () => ({ content: '' }),
  resolveApiUrl: () => null,
  resolveSession: async () => ({ id: 'new-session', created: true }),
}))

// ── Capture the trigger the composer's context meter is given ─────────────────

let capturedTrigger: number | undefined = undefined

mock.module('@/components/AgentChatView/AgentChatHeader', () => ({ AgentChatHeader: () => null }))
mock.module('@/components/composer/ContextMeter', () => ({
  ContextMeter: ({ trigger }: { trigger?: number }) => {
    capturedTrigger = trigger
    return null
  },
}))

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

mock.module('@/components/composer/Composer', () => ({
  Composer: forwardRef<
    { setValue: (value: string) => void; setFiles: (files: File[]) => void },
    { deckEnd?: ReactNode }
  >(function Mock({ deckEnd }, ref) {
    useImperativeHandle(ref, () => ({ setValue: () => {}, setFiles: () => {} }))
    return <>{deckEnd}</>
  }),
}))

// ── Model registry with two models of very different context windows ──────────

const MODEL_A_ID = 'provider:model-a-1m'
const MODEL_B_ID = 'provider:model-b-400k'
const MODEL_A_TRIGGER = 900_000   // 90% of 1M
const MODEL_B_TRIGGER = 360_000   // 90% of 400K

const mockRegistry = {
  models: [
    { id: MODEL_A_ID, summary_trigger_tokens: MODEL_A_TRIGGER },
    { id: MODEL_B_ID, summary_trigger_tokens: MODEL_B_TRIGGER },
  ],
}

mock.module('@/queries/useAgentSettingsQueries', () => ({
  useRegistryQuery: () => ({ data: mockRegistry }),
  useUpdateAgentMutation: () => ({ mutateAsync: async () => ({}), isPending: false }),
  useAgentsQuery: () => ({
    data: {
      agents: [{
        name: 'code',
        model: MODEL_A_ID,
        summary_trigger_tokens: MODEL_A_TRIGGER,  // agent config model = A
        capabilities: undefined,
      }],
    },
    isLoading: false,
  }),
}))
mock.module('@/queries/useAgentsQuery', () => ({
  useAgentsQuery: () => ({
    data: {
      agents: [{
        name: 'code',
        model: MODEL_A_ID,
        summary_trigger_tokens: MODEL_A_TRIGGER,
        capabilities: undefined,
      }],
    },
    isLoading: false,
  }),
}))

// ── Store factory ─────────────────────────────────────────────────────────────

function makeStore(sessionModel: string | null) {
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
    agentStreams: {
      lead: {
        blocks: [{ type: 'user', content: 'hi', extra: {}, attachments: [] }],
        currentBlocks: [],
        status: 'idle',
        lastError: null,
        revertedCount: 0,
        revertedMessages: [],
        // Non-zero usage so headerTokens is defined and trigger is passed through
        usage: { promptTokens: 10_000, completionTokens: 500, totalTokens: 10_500, cachedTokens: 0 },
      },
    },
    agentNames: ['lead'],
    isAgentWorking: false,
    isContinuing: false,
    sessionId: 'test-session',
    sessionTitle: 'Test',
    sessionModel,
    sessionThinkingLevel: null,
    sessionFastMode: false,
    leadName: 'lead',
    isConnected: true,
  }
  return {
    useAgentStore: Object.assign(
      (selector: (draft: typeof state) => unknown) => selector(state),
      { getState: () => state, setState: (p: Partial<typeof state>) => Object.assign(state, p) },
    ),
  }
}

afterEach(() => {
  cleanup()
  capturedTrigger = undefined
})

import { AgentChatView } from '@/components/AgentChatView'

describe('ContextMeter trigger — model switch', () => {
  it('uses the agent config model trigger when no session override', () => {
    mock.module('@/stores/useAgentStore', () => makeStore(null))
    render(<AgentChatView sessionId="test-session" workspace="/repo/project" />)
    expect(capturedTrigger).toBe(MODEL_A_TRIGGER)
  })

  it('uses the session model trigger when the session overrides to model B', () => {
    mock.module('@/stores/useAgentStore', () => makeStore(MODEL_B_ID))
    render(<AgentChatView sessionId="test-session" workspace="/repo/project" />)
    expect(capturedTrigger).toBe(MODEL_B_TRIGGER)
  })

  it('trigger differs between model A and model B', () => {
    expect(MODEL_A_TRIGGER).not.toBe(MODEL_B_TRIGGER)
    expect(MODEL_A_TRIGGER).toBeGreaterThan(MODEL_B_TRIGGER)
  })
})
