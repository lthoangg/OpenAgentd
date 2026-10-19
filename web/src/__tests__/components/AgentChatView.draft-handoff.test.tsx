import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, render, screen } from '@testing-library/react'
import { forwardRef } from 'react'
import { AgentChatView } from '@/components/AgentChatView'
import { HANDOFF_ACTIVE_MS } from '@/components/AgentChatView/useDraftHandoff'
import type { ComposerHandoff } from '@/components/FloatingInputComposer'

// What AgentChatView last handed its composer.
let latestCapture: ((snapshot: ComposerHandoff) => void) | undefined
let latestEnterFrom: ComposerHandoff | null | undefined
let latestPlacement: string | undefined

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
mock.module('@/hooks/useReducedMotion', () => ({ useReducedMotion: () => false }))
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
mock.module('@/stores/useToastStore', () => ({ useToastStore: () => ({ push: () => {} }) }))
mock.module('@/stores/cache-invalidation-bridge', () => ({ prependSession: () => {}, prependWorkspaceSession: () => {} }))
mock.module('@/api/client', () => ({
  listCodingWorkspaceFiles: async () => [],
  renderCommand: async () => ({ content: '' }),
  renderSnippet: async () => ({ content: '' }),
  resolveApiUrl: () => null,
  resolveSession: async () => ({ id: 'new-session', created: true }),
}))
mock.module('@/utils/workspace', () => ({
  saveLastWorkspace: () => {},
  workspaceLabel: (workspace: string) => workspace,
  pathBasename: (path: string) => path.split('/').pop() ?? path,
  sameWorkspacePath: (a: string, b: string) => a === b,
  getChatWorkspaceEntry: () => null,
  setChatWorkspaceEntry: () => {},
}))
mock.module('@/lib/tray', () => ({ setTraySession: () => {} }))
mock.module('@/components/AgentView', () => ({ AgentView: () => <div data-testid="transcript" /> }))
mock.module('@/components/WorkspaceInfoCard', () => ({ WorkspaceInfoCard: () => null, RecentSessionsList: () => null }))
mock.module('@/components/Sidebar', () => ({ Sidebar: () => null }))
mock.module('@/components/WorkspacePanel', () => ({ WorkspacePanel: () => null }))
mock.module('@/components/AgentChatView/AgentChatHeader', () => ({ AgentChatHeader: () => null }))
mock.module('@/components/AgentChatView/AgentChatPanels', () => ({ AgentChatPanels: () => null }))
mock.module('@/components/AgentChatView/useAgentCommands', () => ({ useAgentCommands: () => [] }))
mock.module('@/components/AgentChatView/usePaletteSwitchCommands', () => ({ usePaletteSwitchCommands: () => [] }))
mock.module('@/components/FloatingInputComposer', () => ({
  FloatingInputComposer: forwardRef<
    unknown,
    { onHandoffCapture?: (snapshot: ComposerHandoff) => void; enterFrom?: ComposerHandoff | null; placement?: string }
  >(function FloatingInputComposerMock({ onHandoffCapture, enterFrom, placement }, _ref) {
    latestCapture = onHandoffCapture
    latestEnterFrom = enterFrom
    latestPlacement = placement
    return null
  }),
}))

mock.module('@/stores/useAgentStore', () => {
  const listeners = new Set<(next: typeof state, prev: typeof state) => void>()
  const state = {
    connectStream: () => null,
    loadAgentStatus: async () => {},
    loadSession: async () => {},
    sendMessage: async () => {},
    beginResolvedSession: (sessionId: string | null) => { state.sessionId = sessionId },
    newSession: () => { state.sessionId = null },
    isEmptyIdleSession: () => false,
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
    sessionId: null as string | null,
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
        setState: (partial: Partial<typeof state>) => {
          const prev = { ...state }
          Object.assign(state, partial)
          for (const listener of listeners) listener(state, prev)
        },
        subscribe: (listener: (next: typeof state, prev: typeof state) => void) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      },
    ),
  }
})

const { useAgentStore } = await import('@/stores/useAgentStore')

// Deterministic timers (Bun has no jest-style fake timer API); see ToastStack.test.tsx.
function useFakeTimers() {
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  let now = 0
  let sequence = 0
  const timers = new Map<number, { callback: () => void; due: number }>()
  globalThis.setTimeout = ((callback: TimerHandler, delay?: number) => {
    const id = ++sequence
    timers.set(id, { callback: callback as () => void, due: now + (delay ?? 0) })
    return id as unknown as ReturnType<typeof setTimeout>
  }) as unknown as typeof setTimeout
  globalThis.clearTimeout = ((id: number) => { timers.delete(id) }) as typeof clearTimeout
  return {
    tick(ms: number) {
      now += ms
      for (const [id, timer] of [...timers]) {
        if (timer.due <= now) {
          timers.delete(id)
          timer.callback()
        }
      }
    },
    restore() {
      globalThis.setTimeout = realSetTimeout
      globalThis.clearTimeout = realClearTimeout
    },
  }
}

const snapshot: ComposerHandoff = { rect: { left: 280, top: 300, width: 640, height: 96 }, focused: true }
let timers: ReturnType<typeof useFakeTimers> | null = null

afterEach(() => {
  timers?.restore()
  timers = null
  cleanup()
})

beforeEach(() => {
  latestCapture = undefined
  latestEnterFrom = undefined
  latestPlacement = undefined
  useAgentStore.setState({ sessionId: null, isAgentWorking: false })
})

describe('AgentChatView draft → chat hand-off', () => {
  it('glides the composer from the centered screen and fades the hero out over the chat', () => {
    const { rerender } = render(<AgentChatView workspace="/repo/handoff" />)
    expect(screen.getByTestId('new-session-screen')).toBeTruthy()
    expect(latestPlacement).toBe('inline')

    // Submit: the inline composer reports where it sat, then the optimistic
    // send ends the draft.
    latestCapture?.(snapshot)
    timers = useFakeTimers()
    useAgentStore.setState({ isAgentWorking: true })
    rerender(<AgentChatView workspace="/repo/handoff" />)

    expect(latestPlacement).toBe('floating')
    expect(latestEnterFrom).toEqual(snapshot)
    expect(screen.getByTestId('transcript')).toBeTruthy()
    expect(screen.getByTestId('new-session-screen-leaving')).toBeTruthy()
    expect(screen.queryByTestId('new-session-screen')).toBeNull()

    act(() => timers!.tick(HANDOFF_ACTIVE_MS))
    expect(screen.queryByTestId('new-session-screen-leaving')).toBeNull()
    expect(latestEnterFrom).toBeNull()
  })

  it('opens another session from the draft without a hand-off', () => {
    const { rerender } = render(<AgentChatView workspace="/repo/handoff" />)
    latestCapture?.(snapshot)
    useAgentStore.setState({ sessionId: 'other' })
    rerender(<AgentChatView sessionId="other" workspace="/repo/handoff" />)

    expect(screen.queryByTestId('new-session-screen-leaving')).toBeNull()
    expect(latestEnterFrom ?? null).toBeNull()
  })
})
