/**
 * useAgentStore — async method tests + uncovered SSE event handlers
 *
 * IMPORTANT: mock.module() MUST appear before any store import so Bun's module
 * registry intercepts the dependency before the store module is evaluated.
 * These tests therefore live in a separate file from the synchronous store tests.
 */

import { mock, describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test"

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

/* eslint-disable @typescript-eslint/no-explicit-any */
const mockPostAgentChat = mock(() =>
  Promise.resolve({ status: "ok", session_id: "team-sid" })
) as any
const mockCancelQueuedTeamMessage = mock(() => Promise.resolve()) as any
const mockPostAgentCommand = mock(() =>
  Promise.resolve({ status: "accepted", session_id: "team-sid", command: "continue" })
) as any
const mockTeamStream = mock(
  (_sid: any, _cbs: any, _signal?: any) => {}
) as any
const mockAgentStatus = mock(() =>
  Promise.resolve({
    lead: { name: "lead", model: "gpt-4", state: "idle" },
    members: [{ name: "worker", model: "claude-3", state: "idle" }],
  })
) as any
const mockSessionHistory = mock(() =>
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
const mockSendDesktopNotification = mock(() => Promise.resolve()) as any
/* eslint-enable @typescript-eslint/no-explicit-any */

/* eslint-disable @typescript-eslint/no-explicit-any */
(mock as any).module("@/api/client", () => ({
  postAgentChat: mockPostAgentChat,
  cancelQueuedMessage: mockCancelQueuedTeamMessage,
  postAgentCommand: mockPostAgentCommand,
  agentStream: mockTeamStream,
  agentStatus: mockAgentStatus,
  sessionHistory: mockSessionHistory,
  // Stubs for other exports
  postChat: mock(() => Promise.resolve({ session_id: "chat-sid" })) as any,
  streamChat: mock(() => {}) as any,
  getChatAgent: mock(() => Promise.resolve({})) as any,
  getAgent: mock(() => Promise.resolve({})) as any,
  getSession: mock(() => Promise.resolve({ id: "s", messages: [] })) as any,
  listSessions: mock(() => Promise.resolve([])) as any,
  deleteSession: mock(() => Promise.resolve()) as any,
  listAgents: mock(() => Promise.resolve({ agents: [] })) as any,
  health: mock(() => Promise.resolve({ status: "ok" })) as any,
}));
(mock as any).module("@/lib/desktop-notifications", () => ({
  sendDesktopNotification: mockSendDesktopNotification,
}))
/* eslint-enable @typescript-eslint/no-explicit-any */

// ── Store import (AFTER mock.module) ──────────────────────────────────────────

import { useAgentStore } from "@/stores/useAgentStore"
import type { ContentBlock } from "@/api/types"

// ── Helpers ───────────────────────────────────────────────────────────────────

const INITIAL_STATE = {
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
  _leadRevertTime: null,
  _workspace: null,
  _loadingOlder: false,
  _resolvedSessionReadyId: null,
  _unloading: false,
  _reconnectTimer: null as ReturnType<typeof setTimeout> | null,
  _reconnectAttempts: 0,
  cacheInvalidations: [],
}

function makeStream(overrides: object = {}) {
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

function makeMessageResponse(overrides: object = {}) {
  return {
    id: "msg-1",
    session_id: "sess-1",
    role: "user",
    content: "hello",
    reasoning_content: null,
    tool_calls: null,
    tool_call_id: null,
    name: null,
    is_summary: false,
    is_hidden: false,
    extra: null,
    created_at: "2024-01-01T00:00:00Z",
    file_message: false,
    attachments: null,
    ...overrides,
  }
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  useAgentStore.setState(INITIAL_STATE)
  mockPostAgentChat.mockReset()
  mockCancelQueuedTeamMessage.mockReset()
  mockPostAgentCommand.mockReset()
  mockTeamStream.mockReset()
  mockAgentStatus.mockReset()
  mockSessionHistory.mockReset()
  mockSendDesktopNotification.mockReset()

  // Restore sensible defaults
  mockPostAgentChat.mockImplementation(() =>
    Promise.resolve({ status: "ok", session_id: "team-sid" })
  )
  mockCancelQueuedTeamMessage.mockImplementation(() => Promise.resolve())
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
})

// ── toggleSidebar ─────────────────────────────────────────────────────────────

describe("toggleSidebar", () => {
  it("toggles sidebarOpen from false to true", () => {
    useAgentStore.setState({ sidebarOpen: false })
    useAgentStore.getState().toggleSidebar()
    expect(useAgentStore.getState().sidebarOpen).toBe(true)
  })

  it("toggles sidebarOpen from true to false", () => {
    useAgentStore.setState({ sidebarOpen: true })
    useAgentStore.getState().toggleSidebar()
    expect(useAgentStore.getState().sidebarOpen).toBe(false)
  })

  it("can toggle multiple times", () => {
    useAgentStore.setState({ sidebarOpen: false })
    useAgentStore.getState().toggleSidebar()
    useAgentStore.getState().toggleSidebar()
    useAgentStore.getState().toggleSidebar()
    expect(useAgentStore.getState().sidebarOpen).toBe(true)
  })
})

// ── _handleSSEEvent: error ────────────────────────────────────────────────────

describe("_handleSSEEvent: error", () => {
  it("sets error message on the store", () => {
    useAgentStore.getState()._handleSSEEvent("error", { message: "Something went wrong" })
    expect(useAgentStore.getState().error).toBe("Something went wrong")
  })

  it("sets isAgentWorking to false", () => {
    useAgentStore.setState({ isAgentWorking: true })
    useAgentStore.getState()._handleSSEEvent("error", { message: "fail" })
    expect(useAgentStore.getState().isAgentWorking).toBe(false)
  })

  it("does not affect agentStreams", () => {
    useAgentStore.setState({
      agentStreams: { lead: makeStream({ status: "working" as const }) },
    })
    useAgentStore.getState()._handleSSEEvent("error", { message: "fail" })
    // agentStreams untouched by error event
    expect(useAgentStore.getState().agentStreams["lead"].status).toBe("working")
  })
})

// ── sendMessage ───────────────────────────────────────────────────────────────

describe("sendMessage", () => {
  it("pushes an optimistic user block into the lead's currentBlocks", async () => {
    useAgentStore.setState({
      leadName: "lead",
      agentStreams: { lead: makeStream() },
    })

    await useAgentStore.getState().sendMessage("hello team", undefined, { workspace: "/repo/app" })

    const leadBlocks = useAgentStore.getState().agentStreams["lead"].currentBlocks
    expect(leadBlocks).toHaveLength(1)
    expect(leadBlocks[0].type).toBe("user")
    expect(leadBlocks[0].content).toBe("hello team")
  })

  it("stamps optimistic user blocks with the lead default model", async () => {
    useAgentStore.setState({
      leadName: "lead",
      sessionModel: null,
      agentStreams: { lead: makeStream({ model: "openai:gpt-5.5" }) },
    })

    await useAgentStore.getState().sendMessage("hello team", undefined, { workspace: "/repo/app" })

    const leadBlocks = useAgentStore.getState().agentStreams["lead"].currentBlocks
    expect(leadBlocks[0].extra?.model).toBe("openai:gpt-5.5")
  })

  it("patches the optimistic user block's id to the server-issued message_id once the POST resolves", async () => {
    // The backend now returns the persisted user message's id even on the
    // immediate (non-queued) send path. Adopting it lets later reconciliation
    // (removePersistedOptimisticUserBlocks) match by id instead of inferring
    // "same message?" from content + a clock-skew time window.
    useAgentStore.setState({ leadName: "lead", agentStreams: { lead: makeStream() } })
    mockPostAgentChat.mockImplementation(() =>
      Promise.resolve({ status: "ok", session_id: "team-sid", message_id: "server-msg-1" })
    )

    await useAgentStore.getState().sendMessage("hello team", undefined, { workspace: "/repo/app" })

    const block = useAgentStore.getState().agentStreams.lead.currentBlocks[0]
    expect(block.id).toBe("server-msg-1")
  })

  it("keeps the optimistic user block's local id when the POST response carries no message_id", async () => {
    useAgentStore.setState({ leadName: "lead", agentStreams: { lead: makeStream() } })
    mockPostAgentChat.mockImplementation(() =>
      Promise.resolve({ status: "ok", session_id: "team-sid" })
    )

    await useAgentStore.getState().sendMessage("hello team", undefined, { workspace: "/repo/app" })

    const block = useAgentStore.getState().agentStreams.lead.currentBlocks[0]
    expect(block.id).toMatch(/^user-/)
  })

  it("sets isAgentWorking=true before the POST resolves", async () => {
    useAgentStore.setState({ leadName: "lead", agentStreams: { lead: makeStream() } })

    let resolvePost!: (v: { status: string; session_id: string }) => void
    mockPostAgentChat.mockImplementation(
      () => new Promise((res) => { resolvePost = res })
    )

    const promise = useAgentStore.getState().sendMessage("hello", undefined, { workspace: "/repo/app" })
    expect(useAgentStore.getState().isAgentWorking).toBe(true)

    resolvePost({ status: "ok", session_id: "team-sid" })
    await promise
  })

  it("calls postAgentChat with the message text", async () => {
    useAgentStore.setState({ leadName: "lead", agentStreams: { lead: makeStream() } })
    await useAgentStore.getState().sendMessage("test message", undefined, { workspace: "/repo/app" })
    expect(mockPostAgentChat).toHaveBeenCalledTimes(1)
    expect(mockPostAgentChat.mock.calls[0][0]).toBe("test message")
  })

  it("calls postAgentChat with interrupt=false when not working", async () => {
    useAgentStore.setState({ leadName: "lead", agentStreams: { lead: makeStream() } })
    await useAgentStore.getState().sendMessage("hello", undefined, { workspace: "/repo/app" })
    expect(mockPostAgentChat.mock.calls[0][2]).toBe(false)
  })

  it("sets sessionId from postAgentChat response", async () => {
    mockPostAgentChat.mockImplementation(() =>
      Promise.resolve({ status: "ok", session_id: "new-team-sid" })
    )
    useAgentStore.setState({ leadName: "lead", agentStreams: { lead: makeStream() } })
    await useAgentStore.getState().sendMessage("hello", undefined, { workspace: "/repo/app" })
    expect(useAgentStore.getState().sessionId).toBe("new-team-sid")
  })

  it("calls connectStream after postAgentChat resolves", async () => {
    useAgentStore.setState({
      leadName: "lead",
      agentStreams: { lead: makeStream() },
      sessionId: "team-sid",
    })
    await useAgentStore.getState().sendMessage("hello", undefined, { workspace: "/repo/app" })
    expect(mockTeamStream).toHaveBeenCalledTimes(1)
  })

  it("sets error and stops working when postAgentChat throws", async () => {
    mockPostAgentChat.mockImplementation(() =>
      Promise.reject(new Error("Network failure"))
    )
    useAgentStore.setState({ leadName: "lead", agentStreams: { lead: makeStream() } })
    await useAgentStore.getState().sendMessage("hello", undefined, { workspace: "/repo/app" })

    const state = useAgentStore.getState()
    expect(state.error).toBe("Network failure")
    expect(state.isAgentWorking).toBe(false)
  })

  it("sets fallback error message for non-Error throws", async () => {
    mockPostAgentChat.mockImplementation(() => Promise.reject("unknown"))
    useAgentStore.setState({ leadName: "lead", agentStreams: { lead: makeStream() } })
    await useAgentStore.getState().sendMessage("hello", undefined, { workspace: "/repo/app" })
    expect(useAgentStore.getState().error).toBe("Failed to send message")
  })

  it("does not call connectStream when postAgentChat throws", async () => {
    mockPostAgentChat.mockImplementation(() => Promise.reject(new Error("fail")))
    useAgentStore.setState({ leadName: "lead", agentStreams: { lead: makeStream() } })
    await useAgentStore.getState().sendMessage("hello", undefined, { workspace: "/repo/app" })
    expect(mockTeamStream).not.toHaveBeenCalled()
  })

  // The composer clears optimistically the moment a message is submitted, so
  // callers need to know whether the send actually landed — otherwise a
  // failed POST silently takes the user's text and attachments with it.
  it("reports success so the caller can keep the cleared composer cleared", async () => {
    useAgentStore.setState({ leadName: "lead", agentStreams: { lead: makeStream() } })

    const delivered = await useAgentStore.getState().sendMessage("hello", undefined, { workspace: "/repo/app" })

    expect(delivered).toBe(true)
  })

  it("reports failure when the POST throws", async () => {
    mockPostAgentChat.mockImplementation(() => Promise.reject(new Error("Network failure")))
    useAgentStore.setState({ leadName: "lead", agentStreams: { lead: makeStream() } })

    const delivered = await useAgentStore.getState().sendMessage("hello", undefined, { workspace: "/repo/app" })

    expect(delivered).toBe(false)
  })

  it("reports failure when queueing a follow-up throws", async () => {
    mockPostAgentChat.mockImplementation(() => Promise.reject(new Error("Network failure")))
    useAgentStore.setState({
      leadName: "lead",
      agentStreams: { lead: makeStream({ status: "working" }) },
    })

    const delivered = await useAgentStore.getState().sendMessage("queued follow-up", undefined, { workspace: "/repo/app" })

    expect(delivered).toBe(false)
  })
})

// ── sendMessage with files ────────────────────────────────────────────────────

describe("sendMessage with files", () => {
  it("creates optimistic image attachments with blob URLs", async () => {
    const originalCreate = URL.createObjectURL
    URL.createObjectURL = mock(() => "blob:http://localhost/img")

    useAgentStore.setState({ leadName: "lead", agentStreams: { lead: makeStream() } })
    const imageFile = new File(["data"], "photo.png", { type: "image/png" })

    await useAgentStore.getState().sendMessage("see this", [imageFile], { workspace: "/repo/app" })

    const block = useAgentStore.getState().agentStreams["lead"].currentBlocks[0]
    expect(block.attachments).toHaveLength(1)
    expect(block.attachments![0].category).toBe("image")
    expect(block.attachments![0].url).toBe("blob:http://localhost/img")
    expect(block.attachments![0].original_name).toBe("photo.png")

    URL.createObjectURL = originalCreate
  })

  it("creates document attachments without blob URLs for non-image files", async () => {
    useAgentStore.setState({ leadName: "lead", agentStreams: { lead: makeStream() } })
    const pdfFile = new File(["data"], "report.pdf", { type: "application/pdf" })

    await useAgentStore.getState().sendMessage("see this", [pdfFile], { workspace: "/repo/app" })

    const block = useAgentStore.getState().agentStreams["lead"].currentBlocks[0]
    expect(block.attachments).toHaveLength(1)
    expect(block.attachments![0].category).toBe("document")
    expect(block.attachments![0].url).toBeUndefined()
  })

  it("passes files to postAgentChat", async () => {
    useAgentStore.setState({ leadName: "lead", agentStreams: { lead: makeStream() } })
    const file = new File(["data"], "doc.txt", { type: "text/plain" })
    await useAgentStore.getState().sendMessage("with file", [file], { workspace: "/repo/app" })
    expect(mockPostAgentChat.mock.calls[0][4]).toEqual([file])
  })
})

// ── sendMessage: queue behaviour (lead-working guard) ────────────────────────

describe("sendMessage: queue behaviour", () => {
  it("persists queued messages through the backend when lead is working", async () => {
    mockPostAgentChat.mockImplementationOnce(() =>
      Promise.resolve({ status: "queued", session_id: "session-a", message_id: "pm-a" }),
    )
    useAgentStore.setState({
      sessionId: "session-a",
      leadName: "lead",
      agentStreams: { lead: makeStream({ status: "working" as const }) },
    })
    await useAgentStore.getState().sendMessage("queued message", undefined, { workspace: "/repo/a" })
    expect(mockPostAgentChat).toHaveBeenCalledTimes(1)
    expect(mockPostAgentChat.mock.calls[0][0]).toBe("queued message")
    expect(mockPostAgentChat.mock.calls[0][1]).toBe("session-a")
    expect(mockPostAgentChat.mock.calls[0][3]).toBe("/repo/a")
    expect(mockPostAgentChat.mock.calls[0][4]).toBeUndefined()
    const pending = useAgentStore.getState()._pendingMessages
    expect(pending).toHaveLength(1)
    expect(pending[0].sessionId).toBe("session-a")
    expect(pending[0].content).toBe("queued message")
  })

  it("queues explicit file attachments while lead is working", async () => {
    // Regression: the backend accepts file uploads on queued messages
    // (f44b0544), but the frontend kept a stale pre-support guard that
    // rejected them with an error — breaking attach-while-streaming on
    // both desktop and mobile.
    mockPostAgentChat.mockImplementationOnce(() =>
      Promise.resolve({ status: "queued", session_id: "session-a", message_id: "pm-file" }),
    )
    const file = new File(["data"], "doc.txt", { type: "text/plain" })
    useAgentStore.setState({
      sessionId: "session-a",
      leadName: "lead",
      agentStreams: { lead: makeStream({ status: "working" as const }) },
    })

    await useAgentStore.getState().sendMessage("queued with file", [file], { workspace: "/repo/app" })

    expect(mockPostAgentChat).toHaveBeenCalledTimes(1)
    expect(mockPostAgentChat.mock.calls[0][4]).toEqual([file])
    const pending = useAgentStore.getState()._pendingMessages
    expect(pending).toHaveLength(1)
    expect(pending[0].id).toBe("pm-file")
    expect(pending[0].content).toBe("queued with file")
    expect(pending[0].files).toEqual([file])
    expect(pending[0].attachments).toEqual([
      { original_name: "doc.txt", media_type: expect.stringMatching(/^text\/plain/), category: "document" },
    ])
    expect(useAgentStore.getState().error).toBeNull()
  })

  it("categorises queued image attachments as images", async () => {
    mockPostAgentChat.mockImplementationOnce(() =>
      Promise.resolve({ status: "queued", session_id: "session-a", message_id: "pm-img" }),
    )
    const image = new File(["data"], "photo.png", { type: "image/png" })
    useAgentStore.setState({
      sessionId: "session-a",
      leadName: "lead",
      agentStreams: { lead: makeStream({ status: "working" as const }) },
    })

    await useAgentStore.getState().sendMessage("queued image", [image], { workspace: "/repo/app" })

    expect(useAgentStore.getState()._pendingMessages[0].attachments).toEqual([
      { original_name: "photo.png", media_type: "image/png", category: "image" },
    ])
  })

  it("treats a queued response without message_id as an error", async () => {
    mockPostAgentChat.mockImplementationOnce(() =>
      Promise.resolve({ status: "queued", session_id: "session-a" }),
    )
    useAgentStore.setState({
      sessionId: "session-a",
      leadName: "lead",
      agentStreams: { lead: makeStream({ status: "working" as const }) },
    })

    await useAgentStore.getState().sendMessage("queued", undefined, { workspace: "/repo/app" })

    expect(useAgentStore.getState()._pendingMessages).toHaveLength(0)
    expect(useAgentStore.getState().error).toBe("Backend did not return a queued message id")
  })

  it("does NOT queue when only members are working (lead is idle)", async () => {
    useAgentStore.setState({
      leadName: "lead",
      agentStreams: {
        lead: makeStream({ status: "idle" as const }),
        worker: makeStream({ status: "working" as const }),
      },
    })
    await useAgentStore.getState().sendMessage("immediate message", undefined, { workspace: "/repo/app" })
    expect(mockPostAgentChat).toHaveBeenCalledTimes(1)
    expect(useAgentStore.getState()._pendingMessages).toHaveLength(0)
  })

  // The client picks its send path from its *own* lead status, but only the
  // backend knows whether the team still owns an active turn
  // (``has_active_user_turn`` covers members the lead delegated to, which the
  // client's lead status does not). The response status is the authoritative
  // answer and both directions of disagreement are routine.
  it("adopts the backend's queue decision when it queues a send the client thought was immediate", async () => {
    mockPostAgentChat.mockImplementationOnce(() =>
      Promise.resolve({ status: "queued", session_id: "session-a", message_id: "srv-1" }),
    )
    useAgentStore.setState({
      sessionId: "session-a",
      leadName: "lead",
      agentStreams: {
        lead: makeStream({ status: "idle" as const }),
        worker: makeStream({ status: "working" as const }),
      },
    })

    await useAgentStore.getState().sendMessage("only show me once", undefined, { workspace: "/repo/app" })

    // Queued messages render from `_pendingMessages`, never as a live block.
    expect(useAgentStore.getState().agentStreams.lead.currentBlocks).toHaveLength(0)
    const pending = useAgentStore.getState()._pendingMessages
    expect(pending).toHaveLength(1)
    expect(pending[0].id).toBe("srv-1")

    // …and when the backend drains the queue the message appears exactly once.
    useAgentStore.getState()._handleSSEEvent("queued_turn_start", {
      agent: "lead",
      message_ids: ["srv-1"],
      messages: [{ id: "srv-1", content: "only show me once" }],
    })
    const userBlocks = useAgentStore
      .getState()
      .agentStreams.lead.currentBlocks.filter((b) => b.type === "user")
    expect(userBlocks).toHaveLength(1)
  })

  it("adopts the backend's dispatch decision when it runs a send the client thought was queued", async () => {
    mockPostAgentChat.mockImplementationOnce(() =>
      Promise.resolve({ status: "accepted", session_id: "session-a", message_id: "srv-2" }),
    )
    useAgentStore.setState({
      sessionId: "session-a",
      leadName: "lead",
      agentStreams: { lead: makeStream({ status: "working" as const }) },
    })

    await useAgentStore.getState().sendMessage("go now", undefined, { workspace: "/repo/app" })

    // Nothing is queued server-side, so no queued chip may linger — the turn
    // is running and only the optimistic block represents it.
    expect(useAgentStore.getState()._pendingMessages).toHaveLength(0)
    const userBlocks = useAgentStore
      .getState()
      .agentStreams.lead.currentBlocks.filter((b) => b.type === "user")
    expect(userBlocks).toHaveLength(1)
    expect(userBlocks[0].id).toBe("srv-2")
    expect(userBlocks[0].content).toBe("go now")
  })

  it("does not leave message in _pendingMessages if queued_turn_start arrives before postAgentChat resolves", async () => {
    let resolvePost: (val: any) => void
    mockPostAgentChat.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePost = resolve
        }),
    )
    useAgentStore.setState({
      sessionId: "session-a",
      leadName: "lead",
      agentStreams: { lead: makeStream({ status: "working" as const }) },
    })

    const sendPromise = useAgentStore
      .getState()
      .sendMessage("in-flight race message", undefined, { workspace: "/repo/app" })

    // Simulate backend processing fast and delivering queued_turn_start via SSE
    useAgentStore.getState()._handleSSEEvent("queued_turn_start", {
      agent: "lead",
      message_ids: ["srv-fast"],
      messages: [{ id: "srv-fast", content: "in-flight race message" }],
    })

    // Now postAgentChat resolves with queued
    resolvePost!({
      status: "queued",
      session_id: "session-a",
      message_id: "srv-fast",
    })
    await sendPromise

    // Because queued_turn_start already arrived, it should not be in _pendingMessages
    expect(useAgentStore.getState()._pendingMessages).toHaveLength(0)
    const userBlocks = useAgentStore
      .getState()
      .agentStreams.lead.currentBlocks.filter((b) => b.type === "user")
    expect(userBlocks).toHaveLength(1)
    expect(userBlocks[0].id).toBe("srv-fast")
  })

  it("does not add optimistic block when message is queued", async () => {
    // The backend answers "queued" whenever it holds the message back; the
    // store keys off that status, not off the local lead state.
    mockPostAgentChat.mockImplementationOnce(() =>
      Promise.resolve({ status: "queued", session_id: "team-sid", message_id: "pm-q" }),
    )
    useAgentStore.setState({
      leadName: "lead",
      agentStreams: { lead: makeStream({ status: "working" as const }) },
    })
    await useAgentStore.getState().sendMessage("queued", undefined, { workspace: "/repo/app" })
    expect(useAgentStore.getState().agentStreams["lead"].currentBlocks).toHaveLength(0)
  })

  it("queues multiple messages in order", async () => {
    let n = 0
    mockPostAgentChat.mockImplementation(() =>
      Promise.resolve({ status: "queued", session_id: "team-sid", message_id: `pm-${++n}` }),
    )
    useAgentStore.setState({
      leadName: "lead",
      agentStreams: { lead: makeStream({ status: "working" as const }) },
    })
    await useAgentStore.getState().sendMessage("first", undefined, { workspace: "/repo/app" })
    await useAgentStore.getState().sendMessage("second", undefined, { workspace: "/repo/app" })
    await useAgentStore.getState().sendMessage("third", undefined, { workspace: "/repo/app" })
    const pending = useAgentStore.getState()._pendingMessages
    expect(pending).toHaveLength(3)
    expect(pending[0].content).toBe("first")
    expect(pending[1].content).toBe("second")
    expect(pending[2].content).toBe("third")
  })

  it("moves queued messages into the lead stream when the backend starts the queued turn", () => {
    useAgentStore.setState({
      sessionId: "session-a",
      leadName: "lead",
      agentStreams: {
        lead: makeStream({ status: "idle" as const }),
      },
      _pendingMessages: [
        { id: "pm-1", sessionId: "session-a", content: "first queued" },
        { id: "pm-2", sessionId: "session-a", content: "second queued" },
      ],
    })

    useAgentStore.getState()._handleSSEEvent("queued_turn_start", { agent: "lead" })

    const blocks = useAgentStore.getState().agentStreams.lead.currentBlocks
    expect(blocks.map((block) => block.content)).toEqual(["first queued", "second queued"])
    expect(useAgentStore.getState().isAgentWorking).toBe(true)
    expect(useAgentStore.getState().agentStreams.lead.status).toBe("working")
    expect(useAgentStore.getState()._pendingMessages).toHaveLength(0)
  })

  it("carries queued attachments onto the spliced user block", () => {
    const attachments = [
      { original_name: "doc.txt", media_type: "text/plain", category: "document" as const },
    ]
    useAgentStore.setState({
      sessionId: "session-a",
      leadName: "lead",
      agentStreams: { lead: makeStream({ status: "idle" as const }) },
      _pendingMessages: [
        { id: "pm-1", sessionId: "session-a", content: "queued with file", attachments },
      ],
    })

    useAgentStore.getState()._handleSSEEvent("queued_turn_start", { agent: "lead" })

    const blocks = useAgentStore.getState().agentStreams.lead.currentBlocks
    expect(blocks).toHaveLength(1)
    expect(blocks[0].attachments).toEqual(attachments)
  })

  it("keeps the frontend streaming when a queued turn starts after undo reset state", () => {
    useAgentStore.setState({
      sessionId: "session-a",
      leadName: "lead",
      isAgentWorking: false,
      agentStreams: {
        lead: makeStream({ status: "idle" as const }),
      },
      _pendingMessages: [
        { id: "pm-1", sessionId: "session-a", content: "queued after undo" },
      ],
      error: "Cannot undo while agents are working — /stop first",
    })

    useAgentStore.getState()._handleSSEEvent("queued_turn_start", { agent: "lead", message_ids: ["pm-1"] })
    useAgentStore.getState()._handleSSEEvent("message", { agent: "lead", text: "continued" })

    const state = useAgentStore.getState()
    expect(state.isAgentWorking).toBe(true)
    expect(state.error).toBeNull()
    expect(state.agentStreams.lead.status).toBe("working")
    expect(state.agentStreams.lead.currentBlocks.map((block) => block.content)).toEqual([
      "queued after undo",
      "continued",
    ])
  })

  it("renders backend-provided loop turn messages while streaming", () => {
    useAgentStore.setState({
      sessionId: "session-a",
      leadName: "lead",
      agentStreams: {
        lead: makeStream({ status: "idle" as const }),
      },
      _pendingMessages: [],
    })

    useAgentStore.getState()._handleSSEEvent("queued_turn_start", {
      agent: "lead",
      message_ids: ["loop-1"],
      messages: [{ id: "loop-1", content: "just say hi" }],
    })
    useAgentStore.getState()._handleSSEEvent("message", { agent: "lead", text: "hi" })

    const blocks = useAgentStore.getState().agentStreams.lead.currentBlocks
    expect(blocks.map((block) => block.content)).toEqual(["just say hi", "hi"])
    expect(useAgentStore.getState().isAgentWorking).toBe(true)
  })

  it("splices queued messages when agent name is openagentd and leadName is unset", () => {
    useAgentStore.setState({
      sessionId: "session-openagentd",
      leadName: null,
      agentStreams: {},
      _pendingMessages: [
        {
          id: "qm-1",
          sessionId: "session-openagentd",
          content: "queued question",
          submittedAt: 1000,
        },
      ],
    })

    useAgentStore.getState()._handleSSEEvent("queued_turn_start", {
      agent: "openagentd",
      message_ids: ["qm-1"],
      messages: [{ id: "qm-1", content: "queued question" }],
    })
    useAgentStore.getState()._handleSSEEvent("message", { agent: "openagentd", text: "answering queued" })

    const state = useAgentStore.getState()
    expect(state.isAgentWorking).toBe(true)
    const stream = state.agentStreams.openagentd
    expect(stream).toBeDefined()
    expect(stream.status).toBe("working")
    expect(stream.currentBlocks.map((b) => b.content)).toEqual(["queued question", "answering queued"])
    expect(state._pendingMessages).toEqual([])
  })

  it("keeps queued messages for a different active session", () => {
    useAgentStore.setState({
      sessionId: "session-b",
      leadName: "lead",
      agentStreams: {
        lead: makeStream({ status: "working" as const }),
      },
      _pendingMessages: [
        { id: "pm-a", sessionId: "session-a", content: "belongs to A" },
      ],
    })

    useAgentStore.getState()._handleSSEEvent("queued_turn_start", { agent: "lead" })

    expect(useAgentStore.getState()._pendingMessages).toEqual([
      { id: "pm-a", sessionId: "session-a", content: "belongs to A" },
    ])
  })

  it("moves queued messages for active session and keeps other sessions queued", () => {
    useAgentStore.setState({
      sessionId: "session-a",
      leadName: "lead",
      agentStreams: {
        lead: makeStream({ status: "working" as const }),
      },
      _pendingMessages: [
        { id: "pm-a1", sessionId: "session-a", content: "first A" },
        { id: "pm-b1", sessionId: "session-b", content: "only B" },
        { id: "pm-a2", sessionId: "session-a", content: "second A" },
      ],
    })

    useAgentStore.getState()._handleSSEEvent("queued_turn_start", { agent: "lead" })

    expect(useAgentStore.getState()._pendingMessages).toEqual([
      { id: "pm-b1", sessionId: "session-b", content: "only B" },
    ])
    expect(useAgentStore.getState().agentStreams.lead.currentBlocks.map((block) => block.content)).toEqual([
      "first A",
      "second A",
    ])
  })

  it("does not move queued messages on replayed lead working status", () => {
    useAgentStore.setState({
      sessionId: "session-a",
      leadName: "lead",
      agentStreams: {
        lead: makeStream({ status: "idle" as const }),
      },
      _pendingMessages: [
        { id: "pm-1", sessionId: "session-a", content: "queued" },
      ],
    })

    useAgentStore.getState()._handleSSEEvent("agent_status", { agent: "lead", status: "working" })
    useAgentStore.getState()._handleSSEEvent("message", { agent: "lead", text: "streaming" })

    expect(useAgentStore.getState()._pendingMessages).toEqual([
      { id: "pm-1", sessionId: "session-a", content: "queued" },
    ])
    expect(useAgentStore.getState().agentStreams.lead.currentBlocks.map((block) => block.content)).toEqual([
      "streaming",
    ])
  })

  it("preserves the backend queue order when pending responses arrived out of order", () => {
    useAgentStore.setState({
      sessionId: "session-a",
      leadName: "lead",
      agentStreams: {
        lead: makeStream({ status: "working" as const }),
      },
      // POST responses can resolve in a different order than their serialized
      // server writes. The event is the authoritative queue order.
      _pendingMessages: [
        { id: "pm-second", sessionId: "session-a", content: "second queued" },
        { id: "pm-first", sessionId: "session-a", content: "first queued" },
      ],
    })

    useAgentStore.getState()._handleSSEEvent("queued_turn_start", {
      agent: "lead",
      message_ids: ["pm-first", "pm-second"],
    })

    expect(useAgentStore.getState().agentStreams.lead.currentBlocks.map((block) => block.content)).toEqual([
      "first queued",
      "second queued",
    ])
  })

  it("keeps message_ids order even when only some ids resolved locally (fallback content interleaved)", () => {
    // pm-b's own POST response has not resolved into _pendingMessages yet
    // (or was submitted from another client), so it can only be recovered
    // from the event's own `messages` payload — while pm-a and pm-c did
    // resolve locally. All three must still render in `message_ids` order.
    useAgentStore.setState({
      sessionId: "session-a",
      leadName: "lead",
      agentStreams: {
        lead: makeStream({ status: "working" as const }),
      },
      _pendingMessages: [
        { id: "pm-a", sessionId: "session-a", content: "a queued" },
        { id: "pm-c", sessionId: "session-a", content: "c queued" },
      ],
    })

    useAgentStore.getState()._handleSSEEvent("queued_turn_start", {
      agent: "lead",
      message_ids: ["pm-a", "pm-b", "pm-c"],
      messages: [
        { id: "pm-a", content: "a queued" },
        { id: "pm-b", content: "b queued" },
        { id: "pm-c", content: "c queued" },
      ],
    })

    expect(useAgentStore.getState().agentStreams.lead.currentBlocks.map((block) => block.content)).toEqual([
      "a queued",
      "b queued",
      "c queued",
    ])
  })

  it("moves only queued ids named by queued_turn_start", () => {
    useAgentStore.setState({
      sessionId: "session-a",
      leadName: "lead",
      agentStreams: {
        lead: makeStream({ status: "working" as const }),
      },
      _pendingMessages: [
        { id: "pm-a1", sessionId: "session-a", content: "first A" },
        { id: "pm-a2", sessionId: "session-a", content: "second A" },
      ],
    })

    useAgentStore.getState()._handleSSEEvent("queued_turn_start", { agent: "lead", message_ids: ["pm-a2"] })

    expect(useAgentStore.getState()._pendingMessages).toEqual([
      { id: "pm-a1", sessionId: "session-a", content: "first A" },
    ])
    expect(useAgentStore.getState().agentStreams.lead.currentBlocks.map((block) => block.content)).toEqual([
      "second A",
    ])
  })

  it("keeps live response durations separate across queued-message injection", () => {
    const originalNow = Date.now
    const times = [1_000, 4_600, 4_700, 7_600]
    Date.now = mock(() => times.shift() ?? 7_600) as typeof Date.now
    try {
      useAgentStore.setState({
        sessionId: "session-a",
        leadName: "lead",
        agentStreams: {
          lead: makeStream({ status: "working" as const, _turnStartedAt: 0 }),
        },
        _pendingMessages: [
          { id: "pm-a1", sessionId: "session-a", content: "queued follow-up", submittedAt: 4_700 },
        ],
      })

      useAgentStore.getState()._handleSSEEvent("message", { agent: "lead", text: "first assistant" })
      useAgentStore.getState()._handleSSEEvent("queued_turn_start", { agent: "lead", message_ids: ["pm-a1"] })
      useAgentStore.getState()._handleSSEEvent("message", { agent: "lead", text: "second assistant" })
      useAgentStore.getState()._handleSSEEvent("done", {})
    } finally {
      Date.now = originalNow
    }

    const blocks = useAgentStore.getState().agentStreams.lead.blocks
    const textBlocks = blocks.filter((block) => block.type === "text")

    expect(textBlocks.map((block) => block.content)).toEqual(["first assistant", "second assistant"])
    expect(textBlocks.map((block) => block.responseDurationMs)).toEqual([4700, 2900])
  })

  it("does not notify when a background process completes through bg", () => {
    useAgentStore.setState({
      sessionId: "session-a",
      leadName: "lead",
      agentStreams: {
        lead: makeStream({ status: "working" as const }),
      },
    })

    useAgentStore.getState()._handleSSEEvent("tool_end", {
      agent: "lead",
      name: "bg",
      result: "PID 123: exited (code 0)\nFinal output:\nok",
    })

    expect(mockSendDesktopNotification).not.toHaveBeenCalled()
  })

  it("does not notify directly from done because backend owns completion notifications", () => {
    useAgentStore.setState({
      sessionId: "session-a",
      leadName: "lead",
      agentStreams: {
        lead: makeStream({ status: "working" as const }),
      },
      isAgentWorking: true,
    })

    useAgentStore.getState()._handleSSEEvent("done", {})

    expect(mockSendDesktopNotification).not.toHaveBeenCalled()
  })

  it("stores backend queued message ids returned while lead is working", async () => {
    mockPostAgentChat.mockImplementationOnce(() =>
      Promise.resolve({ status: "queued", session_id: "session-a", message_id: "message-a" }),
    )
    useAgentStore.setState({
      sessionId: "session-a",
      leadName: "lead",
      agentStreams: { lead: makeStream({ status: "working" as const }) },
    })

    await useAgentStore.getState().sendMessage("queued", undefined, { workspace: "/repo/app" })

    const [pending] = useAgentStore.getState()._pendingMessages
    expect(pending).toMatchObject({ id: "message-a", sessionId: "session-a", content: "queued" })
    expect(typeof pending.submittedAt).toBe("number")
  })

  it("removePendingMessage removes message by id", () => {
    useAgentStore.setState({
      _pendingMessages: [
        { id: "pm-1", content: "first" },
        { id: "pm-2", content: "second" },
        { id: "pm-3", content: "third" },
      ],
    })
    useAgentStore.getState().removePendingMessage("pm-2")
    const pending = useAgentStore.getState()._pendingMessages
    expect(pending).toHaveLength(2)
    expect(pending[0].content).toBe("first")
    expect(pending[1].content).toBe("third")
  })

  it("newSession clears the pending queue", () => {
    useAgentStore.setState({
      leadName: "lead",
      agentStreams: { lead: makeStream() },
      _pendingMessages: [{ id: "pm-1", content: "pending" }],
    })
    useAgentStore.getState().newSession()
    expect(useAgentStore.getState()._pendingMessages).toHaveLength(0)
  })

  it("marks a resolved empty session ready for one route restore skip", () => {
    useAgentStore.setState({
      leadName: "lead",
      agentNames: ["lead"],
      agentStreams: { lead: makeStream() },
    })
    useAgentStore.getState().beginResolvedSession("new-session", {
      workspace: "/repo/project",
      skipInitialRestore: true,
    })

    expect(useAgentStore.getState().consumeResolvedSessionReady("new-session", "/repo/project")).toBe(true)
    expect(useAgentStore.getState()._resolvedSessionReadyId).toBeNull()
    expect(useAgentStore.getState().consumeResolvedSessionReady("new-session", "/repo/project")).toBe(false)
  })

  it("does not mark restored sessions for a route restore skip by default", () => {
    useAgentStore.setState({
      leadName: "lead",
      agentNames: ["lead"],
      agentStreams: { lead: makeStream() },
    })
    useAgentStore.getState().beginResolvedSession("existing-session", {
      workspace: "/repo/project",
    })

    expect(useAgentStore.getState().consumeResolvedSessionReady("existing-session", "/repo/project")).toBe(false)
  })

  it("does not skip restore when the resolved session workspace differs", () => {
    useAgentStore.setState({
      leadName: "lead",
      agentNames: ["lead"],
      agentStreams: { lead: makeStream() },
    })
    useAgentStore.getState().beginResolvedSession("new-session", {
      workspace: "/repo/project",
      skipInitialRestore: true,
    })

    expect(useAgentStore.getState().consumeResolvedSessionReady("new-session", "/repo/other")).toBe(false)
    expect(useAgentStore.getState()._resolvedSessionReadyId).toBe("new-session")
  })

  it("preserves in-flight working state and optimistic user block when beginResolvedSession resolves concurrently after sendMessage in a new session", async () => {
    useAgentStore.setState({
      sessionId: null,
      leadName: "lead",
      agentNames: ["lead"],
      agentStreams: { lead: makeStream() },
    })

    let resolvePost!: (value: unknown) => void
    mockPostAgentChat.mockImplementation(
      () => new Promise((res) => { resolvePost = res })
    )

    // User sends a message when sessionId is null (new session)
    void useAgentStore.getState().sendMessage("message to new session", undefined, { workspace: "/repo/app" })

    expect(useAgentStore.getState().isAgentWorking).toBe(true)
    const stream = useAgentStore.getState().agentStreams["lead"]
    expect(stream.currentBlocks.some((b) => b.type === "user" && b.content === "message to new session")).toBe(true)

    // Concurrent beginResolvedSession resolves for the background session creation
    useAgentStore.getState().beginResolvedSession("new-created-session", {
      workspace: "/repo/app",
      skipInitialRestore: true,
    })

    // Working state and optimistic block must be preserved
    expect(useAgentStore.getState().isAgentWorking).toBe(true)
    expect(useAgentStore.getState().agentStreams["lead"].currentBlocks.some((b) => b.type === "user" && b.content === "message to new session")).toBe(true)

    // When postAgentChat finishes, sessionId is set correctly
    resolvePost({ session_id: "post-created-session" })
    await Promise.resolve()

    expect(useAgentStore.getState().sessionId).toBe("post-created-session")
  })
})

// ── stopAgent ────────────────────────────────────────────────────────────────

describe("stopAgent", () => {
  it("reloads immediately after the interrupt without waiting for the trailing done", async () => {
    useAgentStore.setState({
      sessionId: "session-a",
      isAgentWorking: true,
      _workspace: "/repo/a",
    })

    // The reload no longer waits on a timer for the turn to "settle": a
    // belated `done` can no longer duplicate the turn (it recognises that a
    // canonical reload already absorbed it), so Stop stays responsive.
    await useAgentStore.getState().stopAgent()

    expect(mockPostAgentChat).toHaveBeenCalledWith(null, "session-a", true, "/repo/a")
    expect(mockSessionHistory).toHaveBeenCalledWith("session-a")
    expect(useAgentStore.getState()._workspace).toBe("/repo/a")
  })

  it("does not duplicate message A + the agent's turn when Stop is clicked mid-stream", async () => {
    // Reproduces: user sends a message, the agent streams thinking/tool/
    // message blocks, the user clicks Stop. The interrupt POST only *signals*
    // cancellation — the backend keeps running briefly before it actually
    // unwinds, persists the interrupted turn, and emits the trailing `done`
    // SSE event. The post-stop reload must not race that trailing `done`.
    // Live blocks are always stamped from the *client* clock (see the
    // `new Date()` sites in sse-reducer/pending-slice), so they predate the
    // reload's own client-clock `fetchStartedAt`. Server/client skew cannot
    // apply here — it only affects comparisons against persisted server rows.
    const streamedAt = new Date(Date.now() - 1000)
    useAgentStore.setState({
      sessionId: "sess-1",
      isAgentWorking: true,
      leadName: "lead",
      agentNames: ["lead"],
      agentStreams: {
        lead: makeStream({
          status: "working",
          currentBlocks: [
            { id: "u1", type: "user", content: "message A", timestamp: streamedAt },
            { id: "b1", type: "thinking", content: "thinking...", timestamp: streamedAt },
            { id: "b2", type: "tool", content: "tool call", timestamp: streamedAt },
            { id: "b3", type: "text", content: "final answer", timestamp: streamedAt },
          ],
        }),
      },
    })

    mockSessionHistory.mockImplementation(() => Promise.resolve({
      lead: {
        id: "lead-sess",
        agent_name: "lead",
        title: null,
        created_at: null,
        updated_at: null,
        sub_sessions: [],
        messages: [
          makeMessageResponse({ id: "m1", role: "user", content: "message A", created_at: "2024-01-01T00:00:00Z" }),
          makeMessageResponse({ id: "m2", role: "assistant", content: "final answer", created_at: "2024-01-01T00:00:03Z" }),
        ],
      },
      members: [],
      has_more: false,
      next_cursor: null,
    }))

    // The reload runs while the turn is still live client-side, so it
    // replaces `blocks` with the server's canonical (already-persisted) turn
    // while preserving the live `currentBlocks`.
    await useAgentStore.getState().stopAgent()

    // The backend finally finishes cancelling and the trailing `done` event
    // lands — long after the reload. Because the reload already absorbed this
    // exact turn, `done` must drop the now-redundant live blocks rather than
    // append them a second time. No timing window is involved.
    useAgentStore.getState()._handleSSEEvent("done", {})

    const finalBlocks = useAgentStore.getState().agentStreams.lead.blocks
    const userBlocks = finalBlocks.filter((b) => b.type === "user" && b.content === "message A")
    const answerBlocks = finalBlocks.filter((b) => b.content === "final answer")
    expect(userBlocks).toHaveLength(1)
    expect(answerBlocks).toHaveLength(1)
    expect(useAgentStore.getState().agentStreams.lead.currentBlocks).toHaveLength(0)
  })

  it("still commits a brand-new turn that starts while the post-stop reload is in flight", async () => {
    // Guard against over-absorbing: if a *new* turn begins after the history
    // snapshot was taken, its blocks are genuinely absent from that snapshot
    // and `done` must still commit them.
    useAgentStore.setState({
      sessionId: "sess-1",
      isAgentWorking: true,
      leadName: "lead",
      agentNames: ["lead"],
      _pendingMessages: [{ id: "pm-b", sessionId: "sess-1", content: "message B" }],
      _workspace: "/repo/a",
      agentStreams: {
        lead: makeStream({
          status: "working",
          currentBlocks: [
            { id: "b3", type: "text", content: "final answer", timestamp: new Date(Date.now() - 1000) },
          ],
        }),
      },
    })

    mockSessionHistory.mockImplementation(async () => {
      // A queued message is released into a new turn while the fetch is in
      // flight — this content postdates the snapshot below.
      useAgentStore.getState()._handleSSEEvent("queued_turn_start", {
        agent: "lead", message_ids: ["pm-b"],
      })
      useAgentStore.getState()._handleSSEEvent("message", { agent: "lead", text: "answer B" })
      return {
        lead: {
          id: "lead-sess", agent_name: "lead", title: null, created_at: null,
          updated_at: null, sub_sessions: [],
          messages: [
            makeMessageResponse({ id: "m2", role: "assistant", content: "final answer", created_at: "2024-01-01T00:00:03Z" }),
          ],
        },
        members: [], has_more: false, next_cursor: null,
      }
    })

    await useAgentStore.getState().stopAgent()
    useAgentStore.getState()._handleSSEEvent("done", {})

    const finalBlocks = useAgentStore.getState().agentStreams.lead.blocks
    expect(finalBlocks.filter((b) => b.content === "final answer")).toHaveLength(1)
    expect(finalBlocks.filter((b) => b.content === "message B")).toHaveLength(1)
    expect(finalBlocks.filter((b) => b.content === "answer B")).toHaveLength(1)
  })
})

// ── connectStream ─────────────────────────────────────────────────────────────

describe("connectStream", () => {
  // Reconnect back-off is timer-driven, so most tests below stub the global
  // timers to run callbacks synchronously. Restore them here rather than at the
  // end of each test: a stub that escapes this file replaces `setTimeout`
  // process-wide, and because Bun runs files sequentially in one process
  // without `--parallel`, every later file that awaits a timer hangs until the
  // 5s test timeout. One forgotten restore is enough, so no test owns its own.
  const REAL_SET_TIMEOUT = globalThis.setTimeout
  const REAL_CLEAR_TIMEOUT = globalThis.clearTimeout

  afterEach(() => {
    globalThis.setTimeout = REAL_SET_TIMEOUT
    globalThis.clearTimeout = REAL_CLEAR_TIMEOUT
  })

  it("calls agentStream with the current sessionId", () => {
    useAgentStore.setState({ sessionId: "stream-sid", isAgentWorking: true })
    useAgentStore.getState().connectStream()
    expect(mockTeamStream).toHaveBeenCalledTimes(1)
    expect(mockTeamStream.mock.calls[0][0]).toBe("stream-sid")
  })

  it("coalesces streaming text deltas into one store update per frame window", () => {
    let scheduled: (() => void) | null = null
    globalThis.setTimeout = ((callback: TimerHandler) => {
      scheduled = callback as () => void
      return 1 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout
    globalThis.clearTimeout = (() => { scheduled = null }) as typeof clearTimeout

    useAgentStore.setState({ sessionId: "stream-sid" })
    let callbacks!: { onEvent: (type: string, data: unknown) => void }
    mockTeamStream.mockImplementation((_sid: string, cbs: typeof callbacks) => { callbacks = cbs })
    useAgentStore.getState().connectStream()

    let notifications = 0
    const unsubscribe = useAgentStore.subscribe(() => { notifications += 1 })
    callbacks.onEvent("message", { agent: "lead", text: "one " })
    callbacks.onEvent("message", { agent: "lead", text: "two " })
    callbacks.onEvent("message", { agent: "lead", text: "three" })

    // Deltas received in the same frame window should not produce one
    // immer snapshot + subscriber notification each.
    expect(notifications).toBe(0)
    expect(scheduled).not.toBeNull()
    ;(scheduled as unknown as () => void)()
    expect(notifications).toBe(1)
    expect(useAgentStore.getState().agentStreams.lead.currentBlocks[0].content).toBe("one two three")

    // A structural event must flush pending text synchronously first, so
    // `done` commits every preceding byte instead of finalising early.
    callbacks.onEvent("message", { agent: "lead", text: " done" })
    callbacks.onEvent("done", {})
    expect(scheduled).toBeNull()
    expect(useAgentStore.getState().agentStreams.lead.currentBlocks).toHaveLength(0)
    expect(useAgentStore.getState().agentStreams.lead.blocks[0].content).toBe("one two three done")
    expect(notifications).toBe(3) // one delta flush + one delta flush + done
    unsubscribe()
  })

  it("sets isConnected=true", () => {
    useAgentStore.setState({ sessionId: "stream-sid" })
    useAgentStore.getState().connectStream()
    expect(useAgentStore.getState().isConnected).toBe(true)
  })

  it("returns an AbortController", () => {
    useAgentStore.setState({ sessionId: "stream-sid" })
    const abort = useAgentStore.getState().connectStream()
    expect(abort).toBeInstanceOf(AbortController)
  })

  it("returns a new AbortController when sessionId is null (no-op)", () => {
    useAgentStore.setState({ sessionId: null })
    const abort = useAgentStore.getState().connectStream()
    expect(abort).toBeInstanceOf(AbortController)
    expect(mockTeamStream).not.toHaveBeenCalled()
  })

  it("aborts previous stream before opening a new one", () => {
    const fakeAbort = new AbortController()
    const abortSpy = spyOn(fakeAbort, "abort")
    useAgentStore.setState({ sessionId: "stream-sid", _abortController: fakeAbort })
    useAgentStore.getState().connectStream()
    expect(abortSpy).toHaveBeenCalledTimes(1)
  })

  it("passes an AbortSignal to agentStream", () => {
    useAgentStore.setState({ sessionId: "stream-sid" })
    useAgentStore.getState().connectStream()
    const signal = mockTeamStream.mock.calls[0][2]
    expect(signal).toBeInstanceOf(AbortSignal)
  })

  it("onError sets error and isConnected=false for non-transport failures", () => {
    useAgentStore.setState({ sessionId: "s1", isAgentWorking: true })
    let callbacks!: { onError: (err: Error) => void }
    mockTeamStream.mockImplementation((_sid: string, cbs: typeof callbacks) => { callbacks = cbs })
    useAgentStore.getState().connectStream()
    callbacks.onError(new Error("SSE parser failed"))
    expect(useAgentStore.getState().error).toBe("SSE parser failed")
    expect(useAgentStore.getState().isConnected).toBe(false)
  })

  it("downgrades iOS transport stream failures while work continues", () => {
    useAgentStore.setState({ sessionId: "s1", isAgentWorking: true })
    let callbacks!: { onError: (err: Error) => void }
    mockTeamStream.mockImplementation((_sid: string, cbs: typeof callbacks) => { callbacks = cbs })
    useAgentStore.getState().connectStream()
    callbacks.onError(new TypeError("Load failed"))
    expect(useAgentStore.getState().error).toBeNull()
    expect(useAgentStore.getState().isConnected).toBe(false)
    expect(useAgentStore.getState().isAgentWorking).toBe(true)
  })

  it("schedules a reconnect after a transient network error while working", () => {
    // Capture the setTimeout callback so we can fire it synchronously.
    let timerCb!: () => void
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    spyOn(globalThis, "setTimeout").mockImplementation((cb: any) => {
      timerCb = cb
      return 0 as unknown as ReturnType<typeof setTimeout>
    })

    useAgentStore.setState({ sessionId: "s1", isAgentWorking: true })
    let callbacks!: { onError: (err: Error) => void }
    // First call captures callbacks; second call (reconnect) just sets isConnected.
    mockTeamStream.mockImplementation((_sid: string, cbs: typeof callbacks) => { callbacks = cbs })
    useAgentStore.getState().connectStream()
    callbacks.onError(new TypeError("Load failed"))

    // Timer scheduled, stream not yet reconnected.
    expect(timerCb).toBeDefined()
    expect(mockTeamStream).toHaveBeenCalledTimes(1)

    // Fire the timer — should reopen the stream.
    timerCb()
    expect(mockTeamStream).toHaveBeenCalledTimes(2)
    expect(useAgentStore.getState().isConnected).toBe(true)

  })

  it("backs off repeated transient reconnects and resets after an event", () => {
    const delays: number[] = []
    const callbacks: Array<() => void> = []
    spyOn(globalThis, "setTimeout").mockImplementation((...args: unknown[]) => {
      const [cb, delay] = args as [() => void, number | undefined]
      callbacks.push(cb)
      delays.push(delay ?? 0)
      return callbacks.length as unknown as ReturnType<typeof setTimeout>
    })

    useAgentStore.setState({ sessionId: "s1", isAgentWorking: true })
    let streamCallbacks!: { onError: (err: Error) => void; onEvent: (type: string, data: unknown) => void }
    mockTeamStream.mockImplementation((_sid: string, cbs: typeof streamCallbacks) => { streamCallbacks = cbs })

    useAgentStore.getState().connectStream()
    streamCallbacks.onError(new TypeError("Load failed"))
    expect(delays[0]).toBe(1_500)
    callbacks.shift()?.()

    streamCallbacks.onError(new TypeError("Load failed"))
    expect(delays[1]).toBe(3_000)
    streamCallbacks.onEvent("message", { text: "recovered", agent: "lead" })
    expect(useAgentStore.getState()._reconnectAttempts).toBe(0)
  })

  it("clears a pending reconnect timer when starting a new session", () => {
    let timerCb!: () => void
    const clearTimeoutSpy = spyOn(globalThis, "clearTimeout")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    spyOn(globalThis, "setTimeout").mockImplementation((cb: any) => {
      timerCb = cb
      return 123 as unknown as ReturnType<typeof setTimeout>
    })

    useAgentStore.setState({ sessionId: "s1", isAgentWorking: true })
    let callbacks!: { onError: (err: Error) => void }
    mockTeamStream.mockImplementation((_sid: string, cbs: typeof callbacks) => { callbacks = cbs })
    useAgentStore.getState().connectStream()
    callbacks.onError(new TypeError("Load failed"))

    expect(useAgentStore.getState()._reconnectTimer).toBe(123)

    useAgentStore.getState().newSession()

    expect(clearTimeoutSpy).toHaveBeenCalledWith(123)
    expect(useAgentStore.getState()._reconnectTimer).toBeNull()

    // Even if the old callback somehow runs, teardown should still prevent reconnect.
    timerCb()
    expect(mockTeamStream).toHaveBeenCalledTimes(1)

  })

  it("does not reconnect from the timer if the session changed", () => {
    let timerCb!: () => void
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    spyOn(globalThis, "setTimeout").mockImplementation((cb: any) => {
      timerCb = cb
      return 0 as unknown as ReturnType<typeof setTimeout>
    })

    useAgentStore.setState({ sessionId: "s1", isAgentWorking: true })
    let callbacks!: { onError: (err: Error) => void }
    mockTeamStream.mockImplementation((_sid: string, cbs: typeof callbacks) => { callbacks = cbs })
    useAgentStore.getState().connectStream()
    callbacks.onError(new TypeError("Load failed"))

    // Navigate away — bumps generation.
    useAgentStore.getState().newSession()

    // Timer fires but the generation guard should prevent reconnect.
    timerCb()
    // agentStream called only once (the original connect), not again.
    expect(mockTeamStream).toHaveBeenCalledTimes(1)

  })

  it("does not reconnect from the timer if already reconnected", () => {
    let timerCb!: () => void
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    spyOn(globalThis, "setTimeout").mockImplementation((cb: any) => {
      timerCb = cb
      return 0 as unknown as ReturnType<typeof setTimeout>
    })

    useAgentStore.setState({ sessionId: "s1", isAgentWorking: true })
    let callbacks!: { onError: (err: Error) => void }
    mockTeamStream.mockImplementation((_sid: string, cbs: typeof callbacks) => { callbacks = cbs })
    useAgentStore.getState().connectStream()
    callbacks.onError(new TypeError("Load failed"))

    // Manually reconnect before the timer fires (e.g. visibilitychange).
    useAgentStore.setState({ isConnected: true })

    timerCb()
    // Still only one agentStream call — isConnected guard prevents the extra one.
    expect(mockTeamStream).toHaveBeenCalledTimes(1)

  })

  it("ignores stream errors while the page is unloading", () => {
    useAgentStore.setState({ sessionId: "s1", isAgentWorking: true, _unloading: true })
    let callbacks!: { onError: (err: Error) => void }
    mockTeamStream.mockImplementation((_sid: string, cbs: typeof callbacks) => { callbacks = cbs })
    useAgentStore.getState().connectStream()
    callbacks.onError(new Error("NetworkError when attempting to fetch resource"))
    expect(useAgentStore.getState().error).toBeNull()
    expect(useAgentStore.getState().isConnected).toBe(true)
  })

  it("ignores backend error events while the page is unloading", () => {
    useAgentStore.setState({ sessionId: "s1", isAgentWorking: true, _unloading: true })
    let callbacks!: { onEvent: (type: string, data: unknown) => void }
    mockTeamStream.mockImplementation((_sid: string, cbs: typeof callbacks) => { callbacks = cbs })
    useAgentStore.getState().connectStream()
    callbacks.onEvent("error", { message: "Error in input stream" })
    expect(useAgentStore.getState().error).toBeNull()
    expect(useAgentStore.getState().isAgentWorking).toBe(true)
  })

  it("onDone sets isConnected=false and patches the session running flag", () => {
    mockTeamStream.mockImplementation(
      (_sid: string, cbs: { onDone?: () => void }) => {
        cbs.onDone?.()
      }
    )
    useAgentStore.setState({ sessionId: "stream-sid" })
    useAgentStore.getState().connectStream()

    expect(useAgentStore.getState().isConnected).toBe(false)
    // Patched in place rather than invalidating the (infinite, sequentially
    // refetched) session list just to clear a running badge.
    expect(useAgentStore.getState().cacheInvalidations).toContainEqual({
      kind: "session_running",
      sessionId: "stream-sid",
      running: false,
    })
  })

  it("onDone reopens the stream immediately when the session is still working", () => {
    // Simulates an idle-keepalive close mid-run: the backend cleanly closes a
    // channel that had been delivering events, while isAgentWorking is true.
    let callCount = 0
    mockTeamStream.mockImplementation(
      (
        _sid: string,
        cbs: {
          onDone?: () => void
          onEvent?: (type: string, data: unknown) => void
        },
      ) => {
        callCount++
        // Only fire onDone on the first call to avoid an infinite loop in the test.
        if (callCount === 1) {
          cbs.onEvent?.("agent_status", { agent: "lead", status: "working" })
          cbs.onDone?.()
        }
      }
    )
    useAgentStore.setState({ sessionId: "stream-sid", isAgentWorking: true })
    useAgentStore.getState().connectStream()

    // Should have opened the stream twice: original + reconnect.
    expect(mockTeamStream).toHaveBeenCalledTimes(2)
    expect(useAgentStore.getState().isConnected).toBe(true)
    // No cache invalidation pushed. The session is still in-flight.
  })

  it("backs off instead of reopening when the stream closed having delivered nothing", () => {
    // A backend holding no turn state for this session returns from `attach`
    // straight away. That is a *clean* close, so it raises no error to reach
    // the backoff in onError — and reopening at once turns a suspended
    // question into a request storm for as long as the card is unanswered.
    let callCount = 0
    mockTeamStream.mockImplementation(
      (_sid: string, cbs: { onDone?: () => void }) => {
        callCount++
        if (callCount === 1) cbs.onDone?.()
      }
    )
    useAgentStore.setState({ sessionId: "stream-sid", isAgentWorking: true })
    useAgentStore.getState().connectStream()

    expect(mockTeamStream).toHaveBeenCalledTimes(1)
    expect(useAgentStore.getState()._reconnectAttempts).toBe(1)
    expect(useAgentStore.getState()._reconnectTimer).not.toBeNull()

    clearTimeout(useAgentStore.getState()._reconnectTimer as ReturnType<typeof setTimeout>)
    useAgentStore.setState({ _reconnectTimer: null, _reconnectAttempts: 0 })
  })

  it("does not reopen a second time when a superseded connection's onDone fires after its own abort", () => {
    // Reproduces "duplicate messages during streaming, fixed only by reload":
    // connection A's underlying `reader.read()` can resolve with `done: true`
    // (server closed the body) in the same tick that something else (e.g. the
    // tab regaining focus) already called `connectStream()` again and aborted
    // A in favor of a fresh connection B. `onError` already guards against
    // this via `abort.signal.aborted`; `onDone` must too, or A's belated
    // "reopen" spawns a second live connection racing B — both then apply
    // every subsequent SSE event, doubling everything until a reload.
    const callbacksByCall: Array<{ onDone?: () => void }> = []
    mockTeamStream.mockImplementation((_sid: string, cbs: { onDone?: () => void }) => {
      callbacksByCall.push(cbs)
    })
    useAgentStore.setState({ sessionId: "stream-sid", isAgentWorking: true })

    useAgentStore.getState().connectStream() // connection A
    const onDoneA = callbacksByCall[0].onDone!
    useAgentStore.getState().connectStream() // something else reconnects — aborts A, opens B
    expect(mockTeamStream).toHaveBeenCalledTimes(2)

    onDoneA() // A's belated, already-superseded "done" fires

    // Must still be exactly 2 (A, B) — not 3. A is aborted and must not reopen.
    expect(mockTeamStream).toHaveBeenCalledTimes(2)
  })

  it("onDone does not reopen the stream when the page is unloading", () => {
    mockTeamStream.mockImplementation(
      (_sid: string, cbs: { onDone?: () => void }) => {
        cbs.onDone?.()
      }
    )
    useAgentStore.setState({ sessionId: "stream-sid", isAgentWorking: true, _unloading: true })
    useAgentStore.getState().connectStream()

    expect(mockTeamStream).toHaveBeenCalledTimes(1)
    expect(useAgentStore.getState().isConnected).toBe(false)
  })

  it("does not reconnect after onDone when queued messages are pending", () => {
    mockTeamStream.mockImplementation(
      (_sid: string, cbs: { onDone?: () => void }) => {
        cbs.onDone?.()
      }
    )
    useAgentStore.setState({
      sessionId: "stream-sid",
      _pendingMessages: [{ id: "pm-1", sessionId: "stream-sid", content: "queued" }],
    })

    useAgentStore.getState().connectStream()

    expect(mockTeamStream).toHaveBeenCalledTimes(1)
    expect(useAgentStore.getState().isConnected).toBe(false)
  })

  it("does not reconnect after onDone when no queued messages are pending", () => {
    mockTeamStream.mockImplementation(
      (_sid: string, cbs: { onDone?: () => void }) => {
        cbs.onDone?.()
      }
    )
    useAgentStore.setState({ sessionId: "stream-sid" })

    useAgentStore.getState().connectStream()

    expect(mockTeamStream).toHaveBeenCalledTimes(1)
    expect(useAgentStore.getState().isConnected).toBe(false)
  })

  it("ignores a stray event delivered by a superseded connection within the same session", () => {
    // Narrower cousin of the onDone race above: connection A's `reader.read()`
    // can have *already resolved* with a chunk the instant before something
    // else reconnects (abort A, open B) for the *same* session — no session
    // or generation change, so that guard alone cannot catch it. B's own
    // attach/replay independently delivers the same content correctly, so
    // dropping A's stray leftover is safe and prevents double-applying it.
    const callbacksByCall: Array<{ onEvent: (type: string, data: unknown) => void }> = []
    mockTeamStream.mockImplementation(
      (_sid: string, cbs: { onEvent: (type: string, data: unknown) => void }) => {
        callbacksByCall.push(cbs)
      }
    )
    useAgentStore.setState({
      sessionId: "session-1",
      leadName: "lead",
      agentNames: ["lead"],
      agentStreams: { lead: makeStream({ status: "working" as const }) },
    })

    useAgentStore.getState().connectStream() // connection A
    const onEventA = callbacksByCall[0].onEvent
    useAgentStore.getState().connectStream() // reconnect — aborts A, opens B (same session)

    // tool_call (unlike message/thinking) applies synchronously with no
    // coalescing timer, so this is observable without advancing fake timers.
    onEventA("tool_call", { agent: "lead", name: "web_search", tool_call_id: "tc-a" })

    expect(useAgentStore.getState().agentStreams.lead.currentBlocks).toHaveLength(0)
  })

  it("ignores stream events after newSession changes generation", () => {
    let onEvent!: (type: string, data: unknown) => void
    let onDone!: () => void
    mockTeamStream.mockImplementation(
      (_sid: string, cbs: { onEvent: (type: string, data: unknown) => void; onDone?: () => void }) => {
        onEvent = cbs.onEvent
        onDone = cbs.onDone ?? (() => {})
      }
    )
    useAgentStore.setState({
      sessionId: "session-1",
      leadName: "lead",
      agentNames: ["lead"],
      agentStreams: { lead: makeStream({ status: "working" as const }) },
    })

    useAgentStore.getState().connectStream()
    useAgentStore.getState().newSession()
    onEvent("message", { agent: "lead", text: "stale token" })
    onDone()

    const state = useAgentStore.getState()
    expect(state.sessionId).toBeNull()
    expect(state.isAgentWorking).toBe(false)
    expect(state.agentStreams.lead.currentBlocks).toHaveLength(0)
  })
})

// ── loadAgentStatus ────────────────────────────────────────────────────────────

describe("loadAgentStatus", () => {
  it("sets leadName from status response", async () => {
    await useAgentStore.getState().loadAgentStatus()
    expect(useAgentStore.getState().leadName).toBe("lead")
  })

  it("sets agentNames including lead and members before a session is active", async () => {
    await useAgentStore.getState().loadAgentStatus()
    expect(useAgentStore.getState().agentNames).toEqual(["lead", "worker"])
  })

  it("sets agentNames including lead and members when a session is active", async () => {
    useAgentStore.setState({ sessionId: "team-sid" })
    await useAgentStore.getState().loadAgentStatus()
    expect(useAgentStore.getState().agentNames).toEqual(["lead", "worker"])
  })

  it("tracks live agents from the status response", async () => {
    useAgentStore.setState({ sessionId: "team-sid" })
    await useAgentStore.getState().loadAgentStatus()
    expect(useAgentStore.getState().liveAgentNames).toEqual(["lead", "worker"])
  })

  it("marks historical members offline when they are absent from the live roster", async () => {
    useAgentStore.setState({
      agentNames: ["lead", "worker"],
      agentStreams: {
        lead: makeStream(),
        worker: makeStream({ status: "idle" }),
      },
    })
    mockAgentStatus.mockImplementation(() =>
      Promise.resolve({
        lead: { name: "lead", model: "gpt-4", state: "idle" },
        members: [],
      })
    )

    await useAgentStore.getState().loadAgentStatus()

    expect(useAgentStore.getState().agentNames).toEqual(["lead", "worker"])
    expect(useAgentStore.getState().agentStreams.worker.status).toBe("offline")
  })

  it("creates agent streams for all agents before a session is active", async () => {
    await useAgentStore.getState().loadAgentStatus()
    const streams = useAgentStore.getState().agentStreams
    expect(streams["lead"]).toBeDefined()
    expect(streams["worker"]).toBeDefined()
  })

  it("creates agent streams for all agents when a session is active", async () => {
    useAgentStore.setState({ sessionId: "team-sid" })
    await useAgentStore.getState().loadAgentStatus()
    const streams = useAgentStore.getState().agentStreams
    expect(streams["lead"]).toBeDefined()
    expect(streams["worker"]).toBeDefined()
  })

  it("sets model on each agent stream before a session is active", async () => {
    await useAgentStore.getState().loadAgentStatus()
    expect(useAgentStore.getState().agentStreams["lead"].model).toBe("gpt-4")
    expect(useAgentStore.getState().agentStreams["worker"].model).toBe("claude-3")
  })

  it("sets model on each agent stream when a session is active", async () => {
    useAgentStore.setState({ sessionId: "team-sid" })
    await useAgentStore.getState().loadAgentStatus()
    expect(useAgentStore.getState().agentStreams["lead"].model).toBe("gpt-4")
    expect(useAgentStore.getState().agentStreams["worker"].model).toBe("claude-3")
  })

  it("does not overwrite existing agent stream data", async () => {
    useAgentStore.setState({
      agentStreams: {
        lead: makeStream({
          blocks: [{ id: "b1", type: "text" as const, content: "existing" }],
        }),
      },
    })
    await useAgentStore.getState().loadAgentStatus()
    // Existing blocks preserved — only model is updated
    expect(useAgentStore.getState().agentStreams["lead"].blocks).toHaveLength(1)
  })

  it("does not revive an offline historical member when session history reloads", async () => {
    useAgentStore.setState({
      agentStreams: {
        worker: makeStream({ status: "offline" }),
      },
    })
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
        members: [{ name: "worker", session_id: "w-sess", messages: [] }],
        has_more: false,
        next_cursor: null,
      })
    )

    await useAgentStore.getState().loadSession("sess-1")

    expect(useAgentStore.getState().agentStreams.worker.status).toBe("offline")
  })

  it("keeps historical members absent from the live roster offline when history reloads", async () => {
    useAgentStore.setState({
      liveAgentNames: ["lead"],
      agentStreams: {
        worker: makeStream({ status: "idle" }),
      },
    })
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
        members: [{ name: "worker", session_id: "w-sess", messages: [] }],
        has_more: false,
        next_cursor: null,
      })
    )

    await useAgentStore.getState().loadSession("sess-1")

    expect(useAgentStore.getState().agentStreams.worker.status).toBe("offline")
  })

  it("sets error when agentStatus throws", async () => {
    mockAgentStatus.mockImplementation(() =>
      Promise.reject(new Error("Status unavailable"))
    )
    await useAgentStore.getState().loadAgentStatus()
    expect(useAgentStore.getState().error).toBe("Status unavailable")
  })

  it("sets fallback error for non-Error throws", async () => {
    mockAgentStatus.mockImplementation(() => Promise.reject("unknown"))
    await useAgentStore.getState().loadAgentStatus()
    expect(useAgentStore.getState().error).toBe("Failed to load agent status")
  })

  it("does nothing when agentStatus returns null", async () => {
    mockAgentStatus.mockImplementation(() => Promise.resolve(null))
    await useAgentStore.getState().loadAgentStatus()
    // No state changes — agentNames stays empty
    expect(useAgentStore.getState().agentNames).toHaveLength(0)
    expect(useAgentStore.getState().leadName).toBeNull()
  })
})

// ── loadSession ───────────────────────────────────────────────────────────────

describe("loadSession", () => {
  it("renders history without waiting for agent status", async () => {
    let resolveStatus!: (value: unknown) => void
    mockAgentStatus.mockImplementation(() => new Promise((resolve) => { resolveStatus = resolve }))
    mockSessionHistory.mockImplementation(() =>
      Promise.resolve({
        lead: {
          id: "lead-sess",
          agent_name: "lead",
          title: null,
          created_at: null,
          updated_at: null,
          sub_sessions: [],
          messages: [makeMessageResponse({ id: "m1", content: "loaded history" })],
        },
        members: [],
        has_more: false,
        next_cursor: null,
      })
    )

    let loadResolved = false
    const loadPromise = useAgentStore.getState().loadSession("sess-1").then(() => {
      loadResolved = true
    })
    // Drain microtasks until `loadSession` resolves (bounded so a real
    // regression — it waiting on `resolveStatus` below — still fails fast
    // instead of hanging). The exact hop count is an implementation detail
    // of the in-flight coalescing wrapper (see `loadSession`), not something
    // this test should hard-code.
    for (let i = 0; i < 10 && !loadResolved; i++) await Promise.resolve()

    expect(loadResolved).toBe(true)
    expect(useAgentStore.getState().agentStreams.lead.blocks[0]?.content).toBe("loaded history")

    resolveStatus(null)
    await loadPromise
  })

  it("keeps model settings changed while history is loading", async () => {
    let resolveHistory!: (value: unknown) => void
    mockSessionHistory.mockImplementation(
      () => new Promise((resolve) => { resolveHistory = resolve })
    )

    const loadPromise = useAgentStore.getState().loadSession("settings-race")
    useAgentStore.getState().setSessionModelSettings("anthropic:claude-sonnet", "high")

    resolveHistory({
      lead: {
        id: "lead-sess",
        agent_name: "lead",
        title: null,
        created_at: null,
        updated_at: null,
        model: "openai:gpt-4o",
        thinking_level: "low",
        sub_sessions: [],
        messages: [],
      },
      members: [],
      has_more: false,
      next_cursor: null,
    })
    await loadPromise

    expect(useAgentStore.getState().sessionModel).toBe("anthropic:claude-sonnet")
    expect(useAgentStore.getState().sessionThinkingLevel).toBe("high")
  })

  it("sets sessionId from the argument", async () => {
    await useAgentStore.getState().loadSession("my-team-session")
    expect(useAgentStore.getState().sessionId).toBe("my-team-session")
  })

  it("coalesces concurrent calls for the same session into a single fetch", async () => {
    // Regression test: a foreground/visibility resume (useSessionBootstrap)
    // and the global event stream's reconcile (useGlobalEventStream) can
    // both react to the same visibilitychange and call loadSession() for the
    // same session back-to-back. Each independent fetch takes its own
    // `liveCountsAtFetch` snapshot of `currentBlocks` — if both run against a
    // live turn, the second snapshot can be taken *after* the first call's
    // resolve already mutated `currentBlocks`, producing an inconsistent
    // drop-prefix calculation that leaves stale live blocks in place to be
    // duplicated by the next SSE replay. Coalescing concurrent calls for the
    // same session into one in-flight fetch removes the race entirely.
    let resolveHistory!: (value: unknown) => void
    mockSessionHistory.mockImplementation(
      () => new Promise((resolve) => { resolveHistory = resolve })
    )

    const callsBefore = mockSessionHistory.mock.calls.length
    const first = useAgentStore.getState().loadSession("race-sess")
    const second = useAgentStore.getState().loadSession("race-sess")

    resolveHistory({
      lead: {
        id: "lead-sess",
        agent_name: "lead",
        title: null,
        created_at: null,
        updated_at: null,
        sub_sessions: [],
        messages: [makeMessageResponse({ id: "m1", content: "loaded once" })],
      },
      members: [],
      has_more: false,
      next_cursor: null,
    })
    await Promise.all([first, second])

    expect(mockSessionHistory.mock.calls.length - callsBefore).toBe(1)
    expect(useAgentStore.getState().agentStreams.lead.blocks).toHaveLength(1)
  })

  it("sets leadName from history response", async () => {
    await useAgentStore.getState().loadSession("sess-1")
    expect(useAgentStore.getState().leadName).toBe("lead")
  })

  it("restores Codex fast mode from the latest user message", async () => {
    mockSessionHistory.mockImplementation(() =>
      Promise.resolve({
        lead: {
          id: "lead-sess",
          agent_name: "lead",
          title: null,
          created_at: null,
          updated_at: null,
          model: "codex:gpt-5.4",
          sub_sessions: [],
          messages: [
            { id: "u1", session_id: "lead-sess", role: "user", content: "hi", reasoning_content: null, tool_calls: null, tool_call_id: null, name: null, is_summary: false, is_hidden: false, extra: { service_tier: "fast" }, created_at: null, attachments: null },
          ],
        },
        members: [],
        has_more: false,
        next_cursor: null,
      })
    )

    await useAgentStore.getState().loadSession("sess-1")

    expect(useAgentStore.getState().sessionFastMode).toBe(true)
  })

  it("falls back to live lead when history has no agent_name", async () => {
    mockSessionHistory.mockImplementation(() =>
      Promise.resolve({
        lead: {
          id: "lead-sess",
          agent_name: null,
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

    await useAgentStore.getState().loadSession("sess-1")
    await Promise.resolve()

    expect(useAgentStore.getState().leadName).toBe("lead")
    expect(useAgentStore.getState().agentNames[0]).toBe("lead")
    expect(useAgentStore.getState().agentStreams.lead).toBeDefined()
  })

  it("populates agentNames with lead and members", async () => {
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
        members: [
          { name: "worker", session_id: "w-sess", messages: [] },
        ],
        has_more: false,
        next_cursor: null,
      })
    )
    await useAgentStore.getState().loadSession("sess-1")
    expect(useAgentStore.getState().agentNames).toEqual(["lead", "worker"])
  })

  it("creates agent streams for lead and members", async () => {
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
        members: [{ name: "worker", session_id: "w-sess", messages: [] }],
        has_more: false,
        next_cursor: null,
      })
    )
    await useAgentStore.getState().loadSession("sess-1")
    expect(useAgentStore.getState().agentStreams["lead"]).toBeDefined()
    expect(useAgentStore.getState().agentStreams["worker"]).toBeDefined()
  })

  it("populates lead blocks from history messages", async () => {
    mockSessionHistory.mockImplementation(() =>
      Promise.resolve({
        lead: {
          id: "lead-sess",
          agent_name: "lead",
          title: null,
          created_at: null,
          updated_at: null,
          sub_sessions: [],
          messages: [
            makeMessageResponse({ id: "m1", role: "user", content: "user msg" }),
          ],
        },
        members: [],
        has_more: false,
        next_cursor: null,
      })
    )
    await useAgentStore.getState().loadSession("sess-1")
    const leadBlocks = useAgentStore.getState().agentStreams["lead"].blocks
    expect(leadBlocks).toHaveLength(1)
    expect(leadBlocks[0].type).toBe("user")
    expect(leadBlocks[0].content).toBe("user msg")
  })

  it("loads queued history messages into the pending queue without rendering them as history blocks", async () => {
    mockSessionHistory.mockImplementationOnce(() =>
      Promise.resolve({
        lead: {
          id: "lead-sess",
          agent_name: "lead",
          title: null,
          created_at: null,
          updated_at: null,
          sub_sessions: [],
          messages: [
            makeMessageResponse({ id: "q1", role: "user", content: "queued", extra: { queue_status: "queued" } }),
            makeMessageResponse({ id: "a1", role: "assistant", content: "response" }),
          ],
        },
        members: [],
        has_more: false,
        next_cursor: null,
      })
    )

    await useAgentStore.getState().loadSession("sess-1")

    expect(useAgentStore.getState()._pendingMessages).toEqual([
      { id: "q1", sessionId: "sess-1", content: "queued", submittedAt: 1704067200000, attachments: undefined },
    ])
    expect(useAgentStore.getState().agentStreams.lead.blocks.map((block) => block.content)).toEqual(["response"])
  })

  it("keeps attachments on queued history messages loaded into the pending queue", async () => {
    const attachments = [
      { original_name: "doc.txt", media_type: "text/plain", category: "text" as const, url: "/api/agent/sess-1/uploads/doc.txt" },
    ]
    mockSessionHistory.mockImplementationOnce(() =>
      Promise.resolve({
        lead: {
          id: "lead-sess",
          agent_name: "lead",
          title: null,
          created_at: null,
          updated_at: null,
          sub_sessions: [],
          messages: [
            makeMessageResponse({ id: "q1", role: "user", content: "queued with file", extra: { queue_status: "queued" }, attachments }),
          ],
        },
        members: [],
        has_more: false,
        next_cursor: null,
      })
    )

    await useAgentStore.getState().loadSession("sess-1")

    expect(useAgentStore.getState()._pendingMessages[0].attachments).toEqual(attachments)
  })

  it("clears currentBlocks for lead after loading", async () => {
    useAgentStore.setState({
      agentStreams: {
        lead: makeStream({
          currentBlocks: [{ id: "live", type: "text" as const, content: "live" }],
        }),
      },
    })
    await useAgentStore.getState().loadSession("sess-1")
    expect(useAgentStore.getState().agentStreams["lead"].currentBlocks).toHaveLength(0)
  })

  it("marks the lead working when loaded session detail is still running", async () => {
    mockSessionHistory.mockImplementation(() =>
      Promise.resolve({
        lead: {
          id: "lead-sess",
          agent_name: "lead",
          title: null,
          created_at: null,
          updated_at: null,
          running: true,
          sub_sessions: [],
          messages: [
            makeMessageResponse({ id: "m1", role: "user", content: "resume task" }),
          ],
        },
        members: [],
        has_more: false,
        next_cursor: null,
      })
    )

    await useAgentStore.getState().loadSession("sess-1")

    expect(useAgentStore.getState().isAgentWorking).toBe(true)
    expect(useAgentStore.getState().agentStreams.lead.status).toBe("working")
  })

  it("clears reverted state from previous session when loading another", async () => {
    // Regression: revertedCount/revertedMessages are keyed by agent name in
    // agentStreams, so without an explicit reset session A's "N messages
    // reverted" banner leaks into session B when both share a lead.
    useAgentStore.setState({
      agentStreams: {
        lead: makeStream({
          revertedCount: 3,
          revertedMessages: [{ role: "user", content: "leak" }],
        }),
      },
    })
    await useAgentStore.getState().loadSession("sess-1")
    const stream = useAgentStore.getState().agentStreams["lead"]
    expect(stream.revertedCount).toBe(0)
    expect(stream.revertedMessages).toEqual([])
  })

  it("sets error when sessionHistory throws", async () => {
    mockSessionHistory.mockImplementation(() =>
      Promise.reject(new Error("History unavailable"))
    )
    await useAgentStore.getState().loadSession("sess-1")
    expect(useAgentStore.getState().error).toBe("History unavailable")
  })

  it("sets fallback error for non-Error throws", async () => {
    mockSessionHistory.mockImplementation(() => Promise.reject("timeout"))
    await useAgentStore.getState().loadSession("sess-1")
    expect(useAgentStore.getState().error).toBe("Failed to load session")
  })

  it("discards result when _sessionGeneration changes (stale load)", async () => {
    // Arrange: delay sessionHistory so we can bump generation mid-flight
    let resolveHistory!: (v: unknown) => void
    mockSessionHistory.mockImplementation(
      () => new Promise((res) => { resolveHistory = res })
    )

    const loadPromise = useAgentStore.getState().loadSession("sess-1")

    // Bump generation — simulates newSession() called while load was in-flight
    useAgentStore.getState().newSession()

    // Resolve the stale history
    resolveHistory({
      lead: {
        id: "lead-sess",
        agent_name: "stale-lead",
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
    await loadPromise

    // Stale result discarded — leadName not set to "stale-lead"
    expect(useAgentStore.getState().leadName).toBeNull()
  })

  it("discards error when _sessionGeneration changes (stale error)", async () => {
    let rejectHistory!: (e: Error) => void
    mockSessionHistory.mockImplementation(
      () => new Promise((_, rej) => { rejectHistory = rej })
    )

    const loadPromise = useAgentStore.getState().loadSession("sess-1")

    // Bump generation
    useAgentStore.getState().newSession()

    rejectHistory(new Error("stale error"))
    await loadPromise

    // Stale error discarded
    expect(useAgentStore.getState().error).toBeNull()
  })

  it("preserves SSE events dispatched AFTER loadSession resolves (reload mid-stream)", async () => {
    // Regression: on page reload mid-turn, AgentChatView awaits loadSession
    // BEFORE opening the SSE stream so the DB reset of currentBlocks cannot
    // race the replay of buffered thinking/message events.
    //
    // If a caller still fires SSE events while loadSession is inflight (the
    // old bug), those events land in currentBlocks and get wiped by the
    // `currentBlocks = []` assignment inside loadSession. The fixed flow
    // guarantees ordering via await — so any subsequent replayed events
    // must survive and flow through to the UI.
    let resolveHistory!: (v: unknown) => void
    mockSessionHistory.mockImplementation(
      () => new Promise((res) => { resolveHistory = res })
    )

    const loadPromise = useAgentStore.getState().loadSession("sess-1")

    resolveHistory({
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
    await loadPromise

    // SSE events arrive ONLY after loadSession has resolved — mirrors the
    // fixed mount effect in AgentChatView.
    useAgentStore.getState()._handleSSEEvent("agent_status", {
      agent: "lead",
      status: "working",
    })
    useAgentStore.getState()._handleSSEEvent("message", {
      agent: "lead",
      text: "replayed token stream",
    })

    const state = useAgentStore.getState()
    expect(state.isAgentWorking).toBe(true)
    expect(state.agentStreams["lead"].status).toBe("working")
    expect(state.agentStreams["lead"].currentBlocks).toHaveLength(1)
    expect(state.agentStreams["lead"].currentBlocks[0].content).toBe(
      "replayed token stream",
    )
  })

  it("revokes blob URLs from lead currentBlocks before replacing", async () => {
    const revokedUrls: string[] = []
    const originalRevoke = URL.revokeObjectURL
    URL.revokeObjectURL = mock((...args: unknown[]) => { revokedUrls.push(args[0] as string) })

    useAgentStore.setState({
      agentStreams: {
        lead: makeStream({
          currentBlocks: [
            {
              id: "b1",
              type: "user" as const,
              content: "old",
              attachments: [{ url: "blob:http://localhost/old-img", category: "image" as const }],
            },
          ],
        }),
      },
    })

    await useAgentStore.getState().loadSession("sess-1")

    expect(revokedUrls).toContain("blob:http://localhost/old-img")
    URL.revokeObjectURL = originalRevoke
  })

  // ── Regression: session-switch streaming indicator persists ───────────────
  // Bug: switching from a streaming session A to an idle session B left
  // isAgentWorking=true and agent status="working", causing "..." to render
  // indefinitely in session B.

  it("resets isAgentWorking to false when loading a session while another was streaming", async () => {
    // Simulate session A mid-stream
    useAgentStore.setState({
      sessionId: "session-a",
      isAgentWorking: true,
      agentStreams: {
        lead: makeStream({ status: "working" as const }),
      },
    })

    // User switches to session B
    await useAgentStore.getState().loadSession("session-b")

    expect(useAgentStore.getState().isAgentWorking).toBe(false)
  })

  it("never reduces estimatedCostUsd or completionTokens on loadSession for the same session", async () => {
    mockSessionHistory.mockImplementation(() =>
      Promise.resolve({
        lead: {
          id: "lead-sess",
          agent_name: "lead",
          title: null,
          created_at: null,
          updated_at: null,
          sub_sessions: [],
          messages: [
            {
              id: "m1",
              role: "assistant",
              content: "hi",
              extra: { usage: { input: 100, output: 20, cost: { estimated_usd: 0.001 } } },
            },
          ],
        },
        members: [],
        has_more: true,
        next_cursor: 1,
      })
    )
    useAgentStore.setState({
      sessionId: "sess-1",
      isAgentWorking: false,
      agentStreams: {
        lead: makeStream({
          usage: {
            promptTokens: 100,
            completionTokens: 80,
            totalTokens: 180,
            cachedTokens: 0,
            estimatedCostUsd: 0.005,
          },
        }),
      },
    })

    await useAgentStore.getState().loadSession("sess-1")

    const usage = useAgentStore.getState().agentStreams.lead.usage
    expect(usage.estimatedCostUsd).toBe(0.005)
    expect(usage.completionTokens).toBe(80)
  })

  // ── Regression: history page truncation undercounts session cost ──────────
  // `sessionHistory` pages the newest 100 rows; a client-side sum over the page
  // misses everything older. The server now returns the authoritative
  // full-session total (`estimated_cost_usd` / `completion_tokens`) and
  // loadSession must prefer it over the page-derived sum.

  it("restores the authoritative full-session cost from the server, not the truncated page", async () => {
    mockSessionHistory.mockImplementation(() =>
      Promise.resolve({
        lead: {
          id: "lead-sess",
          agent_name: "lead",
          title: null,
          created_at: null,
          updated_at: null,
          sub_sessions: [],
          // Only the newest page of a long session — its visible usage is a
          // small slice of the true total.
          estimated_cost_usd: 19.6675,
          completion_tokens: 139633,
          messages: [
            {
              id: "m-newest",
              role: "assistant",
              content: "hi",
              extra: { usage: { input: 100, output: 20, cost: { estimated_usd: 0.001 } } },
            },
          ],
        },
        members: [],
        has_more: true,
        next_cursor: 1,
      })
    )
    useAgentStore.setState({
      sessionId: "sess-1",
      isAgentWorking: false,
      agentStreams: {},
    })

    await useAgentStore.getState().loadSession("sess-1")

    const usage = useAgentStore.getState().agentStreams.lead.usage
    expect(usage.estimatedCostUsd).toBe(19.6675)
    expect(usage.completionTokens).toBe(139633)
    // promptTokens stays page-derived: it describes the latest call.
    expect(usage.promptTokens).toBe(100)
    expect(usage.totalTokens).toBe(100 + 139633)
  })

  it("member streams adopt the authoritative full-session cost on load", async () => {
    mockSessionHistory.mockImplementation(() =>
      Promise.resolve({
        lead: {
          id: "lead-sess",
          agent_name: "lead",
          title: null,
          created_at: null,
          updated_at: null,
          sub_sessions: [],
          estimated_cost_usd: 1.0,
          completion_tokens: 1000,
          messages: [],
        },
        members: [
          {
            name: "worker",
            session_id: "w-sess",
            messages: [],
            estimated_cost_usd: 2.5,
            completion_tokens: 2500,
          },
        ],
        has_more: false,
        next_cursor: null,
      })
    )
    useAgentStore.setState({
      sessionId: "sess-1",
      isAgentWorking: false,
      agentStreams: {},
    })

    await useAgentStore.getState().loadSession("sess-1")

    expect(useAgentStore.getState().agentStreams.lead.usage.estimatedCostUsd).toBe(1.0)
    expect(useAgentStore.getState().agentStreams.worker.usage.estimatedCostUsd).toBe(2.5)
    expect(useAgentStore.getState().agentStreams.worker.usage.completionTokens).toBe(2500)
  })

  it("resets lead agent status to idle when switching away from streaming session", async () => {
    useAgentStore.setState({
      isAgentWorking: true,
      agentStreams: {
        lead: makeStream({ status: "working" as const }),
      },
    })

    await useAgentStore.getState().loadSession("session-b")

    expect(useAgentStore.getState().agentStreams["lead"].status).toBe("idle")
  })

  it("resets member agent status to idle when switching away from streaming session", async () => {
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
        members: [{ name: "worker", session_id: "w-sess", messages: [] }],
        has_more: false,
        next_cursor: null,
      })
    )
    useAgentStore.setState({
      isAgentWorking: true,
      agentStreams: {
        lead: makeStream({ status: "working" as const }),
        worker: makeStream({ status: "working" as const }),
      },
    })

    await useAgentStore.getState().loadSession("session-b")

    expect(useAgentStore.getState().agentStreams["worker"].status).toBe("idle")
  })

  it("clears currentText scratch buffer when switching sessions mid-stream", async () => {
    useAgentStore.setState({
      isAgentWorking: true,
      agentStreams: {
        lead: makeStream({
          status: "working" as const,
          currentText: "partial response...",
        }),
      },
    })

    await useAgentStore.getState().loadSession("session-b")

    expect(useAgentStore.getState().agentStreams["lead"].currentText).toBe("")
  })

  it("clears currentThinking scratch buffer when switching sessions mid-stream", async () => {
    useAgentStore.setState({
      isAgentWorking: true,
      agentStreams: {
        lead: makeStream({
          status: "working" as const,
          currentThinking: "let me reason about...",
        }),
      },
    })

    await useAgentStore.getState().loadSession("session-b")

    expect(useAgentStore.getState().agentStreams["lead"].currentThinking).toBe("")
  })

  it("does not reset isAgentWorking on a stale (generation-gated) loadSession", async () => {
    // If the load is stale, the state mutation is skipped entirely —
    // isAgentWorking should remain whatever the current session set it to.
    let resolveHistory!: (v: unknown) => void
    mockSessionHistory.mockImplementation(
      () => new Promise((res) => { resolveHistory = res })
    )

    const loadPromise = useAgentStore.getState().loadSession("session-b")

    // Switch to a new session (bumps generation) — now the inflight load is stale
    useAgentStore.getState().newSession()
    // New session correctly resets isAgentWorking; don't override that
    expect(useAgentStore.getState().isAgentWorking).toBe(false)

    resolveHistory({
      lead: {
        id: "lead-sess",
        agent_name: "stale-lead",
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
    await loadPromise

    // Stale load did not commit — leadName unchanged from newSession() reset
    expect(useAgentStore.getState().leadName).toBeNull()
  })

  it("preserves a same-session optimistic user bubble from a concurrent send when loadSession resolves without it yet (regression: background reconciliation race)", async () => {
    // Reproduces the "message disappears mid-session, refresh fixes it" bug:
    // a background reconciliation (global 'session_turn_completed' event,
    // foreground resume, etc.) calls loadSession() for the *same* session
    // while the user concurrently sends a new message. If the fetch's
    // snapshot predates that new message, loadSession must not wipe the
    // freshly pushed optimistic user bubble out of currentBlocks — nothing
    // else will ever put it back until a manual refresh.
    useAgentStore.setState({
      sessionId: "sess-1",
      leadName: "lead",
      agentNames: ["lead"],
      agentStreams: { lead: makeStream() },
    })

    let resolveHistory!: (v: unknown) => void
    mockSessionHistory.mockImplementation(
      () => new Promise((res) => { resolveHistory = res })
    )
    // Never resolves within this test — only sendMessage's synchronous
    // optimistic push matters here, not its network round trip.
    mockPostAgentChat.mockImplementation(() => new Promise(() => {}))

    const loadPromise = useAgentStore.getState().loadSession("sess-1")

    // A new message is sent *while the background fetch above is in flight*.
    void useAgentStore.getState().sendMessage("second message", undefined, { workspace: "/repo/app" })
    expect(
      useAgentStore.getState().agentStreams["lead"].currentBlocks.some(
        (b) => b.type === "user" && b.content === "second message",
      ),
    ).toBe(true)

    // The stale fetch resolves with a snapshot that predates "second message".
    resolveHistory({
      lead: {
        id: "lead-sess",
        agent_name: "lead",
        title: null,
        created_at: null,
        updated_at: null,
        sub_sessions: [],
        messages: [makeMessageResponse({ id: "m-1", role: "user", content: "first message" })],
      },
      members: [],
      has_more: false,
      next_cursor: null,
    })
    await loadPromise

    const stream = useAgentStore.getState().agentStreams["lead"]
    const allBlocks = [...stream.blocks, ...stream.currentBlocks]
    expect(allBlocks.some((b) => b.type === "user" && b.content === "second message")).toBe(true)
  })

  it("reconciles an optimistic user bubble already present in history without duplicating it during streaming", async () => {
    useAgentStore.setState({
      sessionId: "sess-1",
      leadName: "lead",
      agentNames: ["lead"],
      agentStreams: { lead: makeStream() },
    })
    mockPostAgentChat.mockImplementation(() =>
      Promise.resolve({ status: "accepted", session_id: "sess-1" }),
    )

    await useAgentStore.getState().sendMessage("only show me once", undefined, { workspace: "/repo/app" })
    useAgentStore.getState()._handleSSEEvent("message", {
      agent: "lead",
      text: "partial response",
    })

    const optimisticUser = useAgentStore.getState().agentStreams.lead.currentBlocks.find(
      (block) => block.type === "user",
    )
    expect(optimisticUser?.timestamp).toBeDefined()

    mockSessionHistory.mockImplementation(() =>
      Promise.resolve({
        lead: {
          id: "lead-sess",
          agent_name: "lead",
          title: null,
          created_at: null,
          updated_at: null,
          sub_sessions: [],
          running: true,
          messages: [
            makeMessageResponse({
              id: "persisted-user-message",
              content: "only show me once",
              created_at: new Date(optimisticUser!.timestamp!.getTime() + 1).toISOString(),
            }),
          ],
        },
        members: [],
        has_more: false,
        next_cursor: null,
      }),
    )

    await useAgentStore.getState().loadSession("sess-1")

    const stream = useAgentStore.getState().agentStreams.lead
    const visibleUserBlocks = [...stream.blocks, ...stream.currentBlocks].filter(
      (block) => block.type === "user" && !block.extra?.from_agent,
    )
    expect(visibleUserBlocks).toHaveLength(1)
    expect(stream.currentBlocks.some((block) => block.type === "text" && block.content === "partial response")).toBe(true)
  })

  it("preserves in-flight live tool calls and streaming text without timestamps when loadSession runs mid-turn", async () => {
    useAgentStore.setState({
      sessionId: "sess-1",
      leadName: "lead",
      agentNames: ["lead"],
      isAgentWorking: true,
      agentStreams: {
        lead: {
          ...makeStream(),
          status: "working",
          currentBlocks: [
            {
              id: "call_1",
              type: "tool",
              content: "",
              toolName: "shell",
              toolArgs: '{"command": "pytest"}',
              toolCallId: "call_1",
              toolDone: false,
            },
            {
              id: "text_1",
              type: "text",
              content: "Running tests...",
            },
          ],
        },
      },
    })

    mockSessionHistory.mockImplementation(() =>
      Promise.resolve({
        lead: {
          id: "lead-sess",
          agent_name: "lead",
          title: null,
          created_at: null,
          updated_at: null,
          sub_sessions: [],
          running: true,
          messages: [
            makeMessageResponse({ id: "m-1", role: "user", content: "run tests" }),
          ],
        },
        members: [],
        has_more: false,
        next_cursor: null,
      }),
    )

    await useAgentStore.getState().loadSession("sess-1")

    const leadStream = useAgentStore.getState().agentStreams["lead"]
    const allBlocks = [...leadStream.blocks, ...leadStream.currentBlocks]
    expect(allBlocks.some((b) => b.type === "tool" && b.toolCallId === "call_1")).toBe(true)
    expect(allBlocks.some((b) => b.type === "text" && b.content === "Running tests...")).toBe(true)
  })
})

// ── loadOlderMessages ─────────────────────────────────────────────────────────

describe("loadOlderMessages", () => {
  it("does nothing when hasMore is false", async () => {
    useAgentStore.setState({ sessionId: "sess-1", hasMore: false, nextCursor: "2024-01-01T00:00:00Z" })
    await useAgentStore.getState().loadOlderMessages()
    expect(mockSessionHistory).not.toHaveBeenCalled()
  })

  it("does nothing when nextCursor is null", async () => {
    useAgentStore.setState({ sessionId: "sess-1", hasMore: true, nextCursor: null })
    await useAgentStore.getState().loadOlderMessages()
    expect(mockSessionHistory).not.toHaveBeenCalled()
  })

  it("does nothing when sessionId is null", async () => {
    useAgentStore.setState({ sessionId: null, hasMore: true, nextCursor: "2024-01-01T00:00:00Z" })
    await useAgentStore.getState().loadOlderMessages()
    expect(mockSessionHistory).not.toHaveBeenCalled()
  })

  it("calls sessionHistory with the current nextCursor", async () => {
    useAgentStore.setState({ sessionId: "sess-1", hasMore: true, nextCursor: "2024-01-01T00:00:00Z", leadName: "lead" })
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
    await useAgentStore.getState().loadOlderMessages()
    expect(mockSessionHistory).toHaveBeenCalledWith("sess-1", "2024-01-01T00:00:00Z")
  })

  it("updates hasMore and nextCursor from the response", async () => {
    useAgentStore.setState({ sessionId: "sess-1", hasMore: true, nextCursor: "2024-02-01T00:00:00Z", leadName: "lead" })
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
        has_more: true,
        next_cursor: "2024-01-01T00:00:00Z",
      })
    )
    await useAgentStore.getState().loadOlderMessages()
    expect(useAgentStore.getState().hasMore).toBe(true)
    expect(useAgentStore.getState().nextCursor).toBe("2024-01-01T00:00:00Z")
  })

  it("prepends older blocks to lead stream", async () => {
    useAgentStore.setState({
      sessionId: "sess-1",
      hasMore: true,
      nextCursor: "2024-02-01T00:00:00Z",
      leadName: "lead",
      agentStreams: {
        lead: makeStream({
          blocks: [{ id: "b2", type: "user" as const, content: "newer" }],
        }),
      },
    })
    mockSessionHistory.mockImplementation(() =>
      Promise.resolve({
        lead: {
          id: "lead-sess",
          agent_name: "lead",
          title: null,
          created_at: null,
          updated_at: null,
          sub_sessions: [],
          messages: [makeMessageResponse({ id: "m-old", role: "user", content: "older" })],
        },
        members: [],
        has_more: false,
        next_cursor: null,
      })
    )
    await useAgentStore.getState().loadOlderMessages()
    const blocks = useAgentStore.getState().agentStreams["lead"].blocks
    expect(blocks).toHaveLength(2)
    expect(blocks[0].content).toBe("older")
    expect(blocks[1].content).toBe("newer")
  })

   // Page-boundary regression: the history cursor cuts at arbitrary rows, so a
  // tool *result* row can land in the first (newest) page while the assistant
  // row carrying the matching tool_call sits in the older page. The result
  // must survive the first parse and attach to the card once the older page
  // is prepended — previously it was silently dropped, leaving the card stuck
  // "running" with its output missing.
  it("attaches a tool result orphaned by the page boundary to its card in the older page", async () => {
    useAgentStore.setState({ leadName: "lead", liveAgentNames: ["lead"] })
    mockSessionHistory.mockImplementation((_sid: string, cursor?: string) => {
      if (!cursor) {
        // Newest page: starts mid-turn with the orphaned tool result.
        return Promise.resolve({
          lead: {
            id: "lead-sess",
            agent_name: "lead",
            title: null,
            created_at: null,
            updated_at: null,
            sub_sessions: [],
            running: false,
            messages: [
              makeMessageResponse({
                id: "m-toolresult",
                role: "tool",
                tool_call_id: "call-split",
                content: "split result",
                extra: { duration_ms: 42 },
                created_at: "2024-03-01T00:00:02Z",
              }),
              makeMessageResponse({
                id: "m-final",
                role: "assistant",
                content: "done!",
                created_at: "2024-03-01T00:00:03Z",
              }),
            ],
          },
          members: [],
          has_more: true,
          next_cursor: "2024-03-01T00:00:02Z",
        })
      }
      // Older page: the assistant row that issued the tool call.
      return Promise.resolve({
        lead: {
          id: "lead-sess",
          agent_name: "lead",
          title: null,
          created_at: null,
          updated_at: null,
          sub_sessions: [],
          messages: [
            makeMessageResponse({
              id: "m-user",
              role: "user",
              content: "run it",
              created_at: "2024-03-01T00:00:00Z",
            }),
            makeMessageResponse({
              id: "m-call",
              role: "assistant",
              content: "",
              tool_calls: [
                { id: "call-split", type: "function", function: { name: "shell", arguments: '{"command":"ls"}' } },
              ],
              created_at: "2024-03-01T00:00:01Z",
            }),
          ],
        },
        members: [],
        has_more: false,
        next_cursor: null,
      })
    })

    await useAgentStore.getState().loadSession("sess-1")
    await useAgentStore.getState().loadOlderMessages()

    const blocks = useAgentStore.getState().agentStreams["lead"].blocks
    const tool = blocks.find((b) => b.type === "tool" && b.toolCallId === "call-split")
    expect(tool).toBeDefined()
    expect(tool?.toolDone).toBe(true)
    expect(tool?.toolResult).toBe("split result")
    expect(tool?.serverDurationMs).toBe(42)
  })

  // The server total is authoritative for the whole session, so older pages
  // must not add their usage on top of it — that would double-count.
  it("does not re-add older-page usage after the server restored the full-session total", async () => {
    useAgentStore.setState({
      sessionId: "sess-1",
      hasMore: true,
      nextCursor: "2024-02-01T00:00:00Z",
      leadName: "lead",
      agentStreams: {
        lead: makeStream({
          usage: {
            promptTokens: 100,
            completionTokens: 139633,
            totalTokens: 139733,
            cachedTokens: 0,
            estimatedCostUsd: 19.6675,
          },
        }),
      },
    })
    mockSessionHistory.mockImplementation(() =>
      Promise.resolve({
        lead: {
          id: "lead-sess",
          agent_name: "lead",
          title: null,
          created_at: null,
          updated_at: null,
          sub_sessions: [],
          messages: [
            {
              id: "m-old",
              role: "assistant",
              content: "old",
              extra: { usage: { input: 1000, output: 500, cost: { estimated_usd: 0.05 } } },
            },
          ],
        },
        members: [],
        has_more: false,
        next_cursor: null,
      })
    )

    await useAgentStore.getState().loadOlderMessages()

    const usage = useAgentStore.getState().agentStreams.lead.usage
    expect(usage.estimatedCostUsd).toBe(19.6675)
    expect(usage.completionTokens).toBe(139633)
    expect(usage.totalTokens).toBe(139733)
  })
})

// ── Ghost-message regression: late SSE after /undo ────────────────────────────
// When a user undoes a message before the backend SSE events (queued_turn_start
// / done) arrive, those late events must NOT re-introduce the reverted user
// block as a ghost message in the chat area.

describe("ghost message regression: queued_turn_start after /undo", () => {
  it("drops a pending user block when _leadRevertTime covers its submittedAt", () => {
    // Simulate: user sent a message at t=1000, undo ran setting revert boundary
    // to t=1000, then queued_turn_start fires (race condition).
    const revertTime = 1000
    useAgentStore.setState({
      sessionId: "session-a",
      leadName: "lead",
      isAgentWorking: false,
      _leadRevertTime: revertTime,
      agentStreams: {
        lead: makeStream({ status: "idle" as const }),
      },
      _pendingMessages: [
        { id: "pm-1", sessionId: "session-a", content: "undone message", submittedAt: revertTime },
      ],
    })

    useAgentStore.getState()._handleSSEEvent("queued_turn_start", { agent: "lead", message_ids: ["pm-1"] })

    const blocks = useAgentStore.getState().agentStreams.lead.currentBlocks
    // The reverted user block must NOT appear
    expect(blocks.filter((b) => b.type === "user")).toHaveLength(0)
  })

  it("keeps user blocks that are strictly before the revert boundary", () => {
    const revertTime = 2000
    useAgentStore.setState({
      sessionId: "session-a",
      leadName: "lead",
      isAgentWorking: false,
      _leadRevertTime: revertTime,
      agentStreams: {
        lead: makeStream({ status: "idle" as const }),
      },
      _pendingMessages: [
        { id: "pm-1", sessionId: "session-a", content: "safe message", submittedAt: 1000 },
        { id: "pm-2", sessionId: "session-a", content: "reverted message", submittedAt: 2000 },
      ],
    })

    useAgentStore.getState()._handleSSEEvent("queued_turn_start", { agent: "lead" })

    const userBlocks = useAgentStore.getState().agentStreams.lead.currentBlocks.filter((b) => b.type === "user")
    expect(userBlocks).toHaveLength(1)
    expect(userBlocks[0].content).toBe("safe message")
  })

  it("allows all user blocks when no revert boundary is active", () => {
    useAgentStore.setState({
      sessionId: "session-a",
      leadName: "lead",
      isAgentWorking: false,
      _leadRevertTime: null,
      agentStreams: {
        lead: makeStream({ status: "idle" as const }),
      },
      _pendingMessages: [
        { id: "pm-1", sessionId: "session-a", content: "hello", submittedAt: 1000 },
      ],
    })

    useAgentStore.getState()._handleSSEEvent("queued_turn_start", { agent: "lead" })

    const userBlocks = useAgentStore.getState().agentStreams.lead.currentBlocks.filter((b) => b.type === "user")
    expect(userBlocks).toHaveLength(1)
    expect(userBlocks[0].content).toBe("hello")
  })
})

describe("ghost message regression: done event after /undo", () => {
  it("does not commit reverted blocks from currentBlocks when done fires", () => {
    const revertTime = new Date("2024-01-01T00:00:02Z").getTime()
    useAgentStore.setState({
      sessionId: "session-a",
      leadName: "lead",
      isAgentWorking: true,
      _leadRevertTime: revertTime,
      agentStreams: {
        lead: makeStream({
          status: "working" as const,
          blocks: [
            { id: "u1", type: "user", content: "kept", timestamp: new Date("2024-01-01T00:00:00Z") },
          ],
          currentBlocks: [
            // This is the reverted user message that slipped through
            { id: "u2", type: "user", content: "reverted", timestamp: new Date("2024-01-01T00:00:02Z") },
            // And an assistant response to it
            { id: "a1", type: "text", content: "response", timestamp: new Date("2024-01-01T00:00:03Z") },
          ],
        }),
      },
    })

    useAgentStore.getState()._handleSSEEvent("done", {})

    const blocks = useAgentStore.getState().agentStreams.lead.blocks
    // Only "kept" should survive — the reverted user block and its
    // assistant response are both at/after the boundary.
    expect(blocks.map((b) => b.id)).toEqual(["u1"])
    expect(useAgentStore.getState().agentStreams.lead.currentBlocks).toEqual([])
  })

  it("commits blocks before the revert boundary and drops those at/after", () => {
    const revertTime = new Date("2024-01-01T00:00:02Z").getTime()
    useAgentStore.setState({
      sessionId: "session-a",
      leadName: "lead",
      isAgentWorking: true,
      _leadRevertTime: revertTime,
      agentStreams: {
        lead: makeStream({
          status: "working" as const,
          blocks: [],
          currentBlocks: [
            { id: "u1", type: "user", content: "first", timestamp: new Date("2024-01-01T00:00:00Z") },
            { id: "a1", type: "text", content: "ok", timestamp: new Date("2024-01-01T00:00:01Z") },
            { id: "u2", type: "user", content: "reverted", timestamp: new Date("2024-01-01T00:00:02Z") },
            { id: "a2", type: "text", content: "ghost", timestamp: new Date("2024-01-01T00:00:03Z") },
          ],
        }),
      },
    })

    useAgentStore.getState()._handleSSEEvent("done", {})

    const blocks = useAgentStore.getState().agentStreams.lead.blocks
    expect(blocks.map((b) => b.id)).toEqual(["u1", "a1"])
  })

  it("commits all blocks normally when no revert boundary is set", () => {
    useAgentStore.setState({
      sessionId: "session-a",
      leadName: "lead",
      isAgentWorking: true,
      _leadRevertTime: null,
      agentStreams: {
        lead: makeStream({
          status: "working" as const,
          blocks: [],
          currentBlocks: [
            { id: "u1", type: "user", content: "hello", timestamp: new Date("2024-01-01T00:00:00Z") },
            { id: "a1", type: "text", content: "hi", timestamp: new Date("2024-01-01T00:00:01Z") },
          ],
        }),
      },
    })

    useAgentStore.getState()._handleSSEEvent("done", {})

    const blocks = useAgentStore.getState().agentStreams.lead.blocks
    expect(blocks.map((b) => b.id)).toEqual(["u1", "a1"])
  })

  it("does not duplicate an optimistic user block in currentBlocks when queued_turn_start arrives", () => {
    useAgentStore.setState({
      sessionId: "session-a",
      leadName: "lead",
      isAgentWorking: true,
      agentStreams: {
        lead: makeStream({
          status: "working" as const,
          blocks: [],
          currentBlocks: [
            { id: "user-172345678", type: "user", content: "hello world", timestamp: new Date("2024-01-01T00:00:00Z") },
          ],
        }),
      },
    })

    useAgentStore.getState()._handleSSEEvent("queued_turn_start", {
      agent: "lead",
      message_ids: ["msg-server-1"],
      messages: [{ id: "msg-server-1", content: "hello world" }],
    })

    const currentBlocks = useAgentStore.getState().agentStreams.lead.currentBlocks
    expect(currentBlocks).toHaveLength(1)
    expect(currentBlocks[0].id).toBe("msg-server-1")
    expect(currentBlocks[0].content).toBe("hello world")
  })

  it("does not duplicate a user block in currentBlocks if server message_id was already updated", () => {
    useAgentStore.setState({
      sessionId: "session-a",
      leadName: "lead",
      isAgentWorking: true,
      agentStreams: {
        lead: makeStream({
          status: "working" as const,
          blocks: [],
          currentBlocks: [
            { id: "msg-server-1", type: "user", content: "hello world", timestamp: new Date("2024-01-01T00:00:00Z") },
          ],
        }),
      },
    })

    useAgentStore.getState()._handleSSEEvent("queued_turn_start", {
      agent: "lead",
      message_ids: ["msg-server-1"],
      messages: [{ id: "msg-server-1", content: "hello world" }],
    })

    const currentBlocks = useAgentStore.getState().agentStreams.lead.currentBlocks
    expect(currentBlocks).toHaveLength(1)
    expect(currentBlocks[0].id).toBe("msg-server-1")
  })

  it("restores running state for members on loadSession and keeps isAgentWorking=true", async () => {
    mockSessionHistory.mockResolvedValueOnce({
      lead: {
        id: "sess-running",
        title: "Test",
        agent_name: "lead",
        running: false,
        messages: [],
      },
      members: [
        {
          name: "worker",
          session_id: "worker-sess",
          messages: [],
          running: true,
        },
      ],
      has_more: false,
      next_cursor: null,
    })

    await useAgentStore.getState().loadSession("sess-running")

    const state = useAgentStore.getState()
    expect(state.isAgentWorking).toBe(true)
    expect(state.agentStreams.worker?.status).toBe("working")
  })
})
