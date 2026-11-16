/**
 * The mocked API client and the store reset shared by the useAgentStore
 * suites that drive its async actions (``./*-slice.test.ts``, ``./sse-*.test.ts``,
 * ``./load-session.test.ts``). Import it before the store.
 *
 * IMPORTANT: mock.module() MUST run before the store module is used, so Bun's
 * module registry intercepts the dependency.
 */

import { mock } from "bun:test"
import { useAgentStore } from "@/stores/useAgentStore"
import type { ContentBlock } from "@/api/types"

// NOTE on isolation: ``mock.module("@/api/client", …)`` below patches
// Bun's global module registry and ``mock.restore()`` does NOT undo
// it — without inter-file isolation the stubbed client would leak
// into ``client.test.ts`` / ``auth.test.ts`` / ``MacTitleBar.test.tsx``
// and break them. We rely on ``bun test --parallel`` (see
// package.json) to run each test file in its own worker process,
// which is the *only* reliable way to scope a ``mock.module`` call
// to one file. If you ever drop ``--parallel``, you'll need to
// restructure these tests to use ``spyOn`` + dependency injection
// instead of a module-level replacement.

// ── Mock @/api/client BEFORE importing the store ──────────────────────────────
// NOTE: Bun mock types require explicit `any` assertions for compatibility

export const mockPostAgentChat = mock(() =>
  Promise.resolve({ status: "ok", session_id: "team-sid" })
) as any
export const mockCancelQueuedAgentMessage = mock(() => Promise.resolve(true)) as any
export const mockPostAgentCommand = mock(() =>
  Promise.resolve({ status: "accepted", session_id: "team-sid", command: "continue" })
) as any
export const mockTeamStream = mock(
  (_sid: any, _cbs: any, _signal?: any) => {}
) as any
export const mockAgentStatus = mock(() =>
  Promise.resolve({
    lead: { name: "lead", model: "gpt-4", state: "idle" },
    members: [{ name: "worker", model: "claude-3", state: "idle" }],
  })
) as any
export const mockSessionHistory = mock(() =>
  Promise.resolve({
    lead: {
      id: "lead-sess",
      agent_name: "lead",
      title: null,
      created_at: null,
      updated_at: null,
      sub_sessions: [],
      messages: [],
    },
    members: [],
    has_more: false,
    next_cursor: null,
  })
) as any
export const mockSendDesktopNotification = mock(() => Promise.resolve()) as any

(mock as any).module("@/api/client", () => ({
  postAgentChat: mockPostAgentChat,
  cancelQueuedMessage: mockCancelQueuedAgentMessage,
  postAgentCommand: mockPostAgentCommand,
  agentStream: mockTeamStream,
  agentStatus: mockAgentStatus,
  sessionHistory: mockSessionHistory,
}));
(mock as any).module("@/lib/desktop-notifications", () => ({
  sendDesktopNotification: mockSendDesktopNotification,
}))

// ── Helpers ───────────────────────────────────────────────────────────────────

export const INITIAL_STATE = {
  agentStreams: {},
  leadName: null,
  agentNames: [],
  liveAgentNames: null,
  sidebarOpen: false,
  sessionId: null,
  _sessionSettingsDirty: false,
  _sessionSettingsVersion: 0,
  isAgentWorking: false,
  isContinuing: false,
  isConnected: false,
  error: null,
  _pendingMessages: [] as import('@/stores/useAgentStore').PendingMessage[],
  _sessionGeneration: 0,
  hasMore: false,
  nextCursor: null,
  isLoadingHistory: false,
  _leadRevertTime: null,
  _workspace: null,
  // Set by connectStream until the first content frame; leaking it between
  // tests turns a later queued_turn_start into an attach replay.
  _attachReplay: false,
  _loadingOlder: false,
  pinnedPrompt: null,
  _resolvedSessionReadyId: null,
  _unloading: false,
  _reconnectTimer: null as ReturnType<typeof setTimeout> | null,
  _reconnectAttempts: 0,
  cacheInvalidations: [],
}

export function makeStream(overrides: object = {}) {
  return {
    blocks: [] as ContentBlock[],
    currentBlocks: [] as ContentBlock[],
    status: "idle" as const,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 },
    model: null,
    lastError: null,
    currentText: "",
    currentThinking: "",
    ...overrides,
  }
}

export function makeMessageResponse(overrides: object = {}) {
  return {
    id: "msg-1",
    role: "user",
    content: "hello",
    reasoning_content: null,
    tool_calls: null,
    tool_call_id: null,
    name: null,
    extra: null,
    created_at: "2024-01-01T00:00:00Z",
    attachments: null,
    ...overrides,
  }
}

// ── Setup ─────────────────────────────────────────────────────────────────────

/** Each suite runs this before every test: `beforeEach(resetAsyncStore)`. */
export function resetAsyncStore() {
  useAgentStore.setState(INITIAL_STATE)
  mockPostAgentChat.mockReset()
  mockCancelQueuedAgentMessage.mockReset()
  mockPostAgentCommand.mockReset()
  mockTeamStream.mockReset()
  mockAgentStatus.mockReset()
  mockSessionHistory.mockReset()
  mockSendDesktopNotification.mockReset()

  // Restore sensible defaults
  mockPostAgentChat.mockImplementation(() =>
    Promise.resolve({ status: "ok", session_id: "team-sid" })
  )
  mockCancelQueuedAgentMessage.mockImplementation(() => Promise.resolve())
  mockPostAgentCommand.mockImplementation(() =>
    Promise.resolve({ status: "accepted", session_id: "team-sid", command: "continue" })
  )
  mockTeamStream.mockImplementation(() => {})
  mockAgentStatus.mockImplementation(() =>
    Promise.resolve({
      lead: { name: "lead", model: "gpt-4", state: "idle" },
      members: [{ name: "worker", model: "claude-3", state: "idle" }],
    })
  )
  mockSessionHistory.mockImplementation(() =>
    Promise.resolve({
      lead: {
        id: "lead-sess",
        agent_name: "lead",
        title: null,
        created_at: null,
        updated_at: null,
        sub_sessions: [],
        messages: [],
      },
      members: [],
      has_more: false,
      next_cursor: null,
    })
  )
  mockSendDesktopNotification.mockImplementation(() => Promise.resolve())
}
