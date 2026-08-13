/**
 * useTeamStore — async method tests + uncovered SSE event handlers
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
const mockPostTeamChat = mock(() =>
  Promise.resolve({ status: "ok", session_id: "team-sid" })
) as any
const mockCancelQueuedTeamMessage = mock(() => Promise.resolve()) as any
const mockPostTeamCommand = mock(() =>
  Promise.resolve({ status: "accepted", session_id: "team-sid", command: "continue" })
) as any
const mockTeamStream = mock(
  (_sid: any, _cbs: any, _signal?: any) => {}
) as any
const mockTeamStatus = mock(() =>
  Promise.resolve({
    team: "team",
    lead: { name: "lead", model: "gpt-4", state: "idle" },
    members: [{ name: "worker", model: "claude-3", state: "idle" }],
  })
) as any
const mockTeamHistory = mock(() =>
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
  postTeamChat: mockPostTeamChat,
  cancelQueuedTeamMessage: mockCancelQueuedTeamMessage,
  postTeamCommand: mockPostTeamCommand,
  teamStream: mockTeamStream,
  teamStatus: mockTeamStatus,
  teamHistory: mockTeamHistory,
  // Stubs for other exports
  postChat: mock(() => Promise.resolve({ session_id: "chat-sid" })) as any,
  streamChat: mock(() => {}) as any,
  getChatAgent: mock(() => Promise.resolve({})) as any,
  getAgent: mock(() => Promise.resolve({})) as any,
  getSession: mock(() => Promise.resolve({ id: "s", messages: [] })) as any,
  listSessions: mock(() => Promise.resolve([])) as any,
  deleteSession: mock(() => Promise.resolve()) as any,
  listTeamAgents: mock(() => Promise.resolve({ agents: [] })) as any,
  listTeamSessions: mock(() => Promise.resolve([])) as any,
  deleteTeamSession: mock(() => Promise.resolve()) as any,
  health: mock(() => Promise.resolve({ status: "ok" })) as any,
}));
(mock as any).module("@/lib/desktop-notifications", () => ({
  sendDesktopNotification: mockSendDesktopNotification,
}))
/* eslint-enable @typescript-eslint/no-explicit-any */

// ── Store import (AFTER mock.module) ──────────────────────────────────────────

import { useTeamStore, isAwaitingRestartOutput } from "@/stores/useTeamStore"
import type { ContentBlock } from "@/api/types"

// ── Helpers ───────────────────────────────────────────────────────────────────

const INITIAL_STATE = {
  agentStreams: {},
  activeAgent: null,
  leadName: null,
  agentNames: [],
  liveAgentNames: null,
  sidebarOpen: false,
  sessionId: null,
  _sessionSettingsDirty: false,
  _sessionSettingsVersion: 0,
  isTeamWorking: false,
  isContinuing: false,
  isConnected: false,
  error: null,
  _pendingMessages: [] as import('@/stores/useTeamStore').PendingMessage[],
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
  useTeamStore.setState(INITIAL_STATE)
  mockPostTeamChat.mockReset()
  mockCancelQueuedTeamMessage.mockReset()
  mockPostTeamCommand.mockReset()
  mockTeamStream.mockReset()
  mockTeamStatus.mockReset()
  mockTeamHistory.mockReset()
  mockSendDesktopNotification.mockReset()

  // Restore sensible defaults
  mockPostTeamChat.mockImplementation(() =>
    Promise.resolve({ status: "ok", session_id: "team-sid" })
  )
  mockCancelQueuedTeamMessage.mockImplementation(() => Promise.resolve())
  mockPostTeamCommand.mockImplementation(() =>
    Promise.resolve({ status: "accepted", session_id: "team-sid", command: "continue" })
  )
  mockTeamStream.mockImplementation(() => {})
  mockTeamStatus.mockImplementation(() =>
    Promise.resolve({
      team: "team",
      lead: { name: "lead", model: "gpt-4", state: "idle" },
      members: [{ name: "worker", model: "claude-3", state: "idle" }],
    })
  )
  mockTeamHistory.mockImplementation(() =>
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
    useTeamStore.setState({ sidebarOpen: false })
    useTeamStore.getState().toggleSidebar()
    expect(useTeamStore.getState().sidebarOpen).toBe(true)
  })

  it("toggles sidebarOpen from true to false", () => {
    useTeamStore.setState({ sidebarOpen: true })
    useTeamStore.getState().toggleSidebar()
    expect(useTeamStore.getState().sidebarOpen).toBe(false)
  })

  it("can toggle multiple times", () => {
    useTeamStore.setState({ sidebarOpen: false })
    useTeamStore.getState().toggleSidebar()
    useTeamStore.getState().toggleSidebar()
    useTeamStore.getState().toggleSidebar()
    expect(useTeamStore.getState().sidebarOpen).toBe(true)
  })
})

// ── continueTeam ──────────────────────────────────────────────────────────────

describe("continueTeam", () => {
  it("posts the continue command for the active session", async () => {
    useTeamStore.setState({ sessionId: "team-sid" })

    await useTeamStore.getState().continueTeam()

    expect(mockPostTeamCommand).toHaveBeenCalledWith("continue", "team-sid")
  })

  it("marks the active turn as a continuation while waiting", async () => {
    let resolveCommand!: () => void
    mockPostTeamCommand.mockImplementation(() => new Promise((resolve) => {
      resolveCommand = () => resolve({ status: "accepted", session_id: "team-sid", command: "continue" })
    }))
    useTeamStore.setState({ sessionId: "team-sid" })

    const promise = useTeamStore.getState().continueTeam()
    expect(useTeamStore.getState().isContinuing).toBe(true)

    resolveCommand()
    await promise
  })

  it("shows the pending dots while the continued turn spins up", async () => {
    // /continue restarts the turn with no new user message, so the optimistic
    // user block that normally drives the dots never exists, and currentBlocks
    // still holds the turn being continued.
    let resolveCommand!: () => void
    mockPostTeamCommand.mockImplementation(() => new Promise((resolve) => {
      resolveCommand = () => resolve({ status: "accepted", session_id: "team-sid", command: "continue" })
    }))
    useTeamStore.setState({
      sessionId: "team-sid",
      leadName: "lead",
      agentStreams: { lead: makeStream({}) },
    } as never)

    const promise = useTeamStore.getState().continueTeam()
    expect(isAwaitingRestartOutput(useTeamStore.getState().agentStreams.lead)).toBe(true)

    resolveCommand()
    await promise
  })

  it("clears continuation state when the command fails", async () => {
    mockPostTeamCommand.mockImplementation(() => Promise.reject(new Error("last message is not assistant")))
    useTeamStore.setState({ sessionId: "team-sid" })

    await useTeamStore.getState().continueTeam()

    expect(useTeamStore.getState().isContinuing).toBe(false)
  })

  it("connects the stream after the command is accepted", async () => {
    useTeamStore.setState({ sessionId: "team-sid" })

    await useTeamStore.getState().continueTeam()

    expect(mockTeamStream).toHaveBeenCalledTimes(1)
  })

  it("sets an error when there is no active session", async () => {
    await useTeamStore.getState().continueTeam()

    expect(useTeamStore.getState().error).toBe("No active session to continue")
    expect(mockPostTeamCommand).not.toHaveBeenCalled()
  })

  it("sets error and stops working when the command fails", async () => {
    mockPostTeamCommand.mockImplementation(() => Promise.reject(new Error("last message is not assistant")))
    useTeamStore.setState({ sessionId: "team-sid" })

    await useTeamStore.getState().continueTeam()

    expect(useTeamStore.getState().error).toBe("last message is not assistant")
    expect(useTeamStore.getState().isTeamWorking).toBe(false)
    expect(mockTeamStream).not.toHaveBeenCalled()
  })
})

// ── _handleSSEEvent: inbox ────────────────────────────────────────────────────

describe("_handleSSEEvent: inbox", () => {
  it("pushes a user block with from_agent extra data", () => {
    useTeamStore.getState()._handleSSEEvent("inbox", {
      agent: "worker",
      content: "Here is my analysis",
      from_agent: "lead",
    })

    const stream = useTeamStore.getState().agentStreams["worker"]
    expect(stream).toBeDefined()
    expect(stream.currentBlocks).toHaveLength(1)

    const block = stream.currentBlocks[0]
    expect(block.type).toBe("user")
    expect(block.content).toBe("Here is my analysis")
    expect(block.extra).toEqual({ from_agent: "lead" })
  })

  it("creates the agent stream if it does not exist", () => {
    useTeamStore.getState()._handleSSEEvent("inbox", {
      agent: "new-agent",
      content: "message",
      from_agent: "lead",
    })

    expect(useTeamStore.getState().agentStreams["new-agent"]).toBeDefined()
  })

  it("sets a timestamp on the inbox block", () => {
    const before = new Date()
    useTeamStore.getState()._handleSSEEvent("inbox", {
      agent: "worker",
      content: "msg",
      from_agent: "lead",
    })
    const after = new Date()

    const block = useTeamStore.getState().agentStreams["worker"].currentBlocks[0]
    expect(block.timestamp).toBeInstanceOf(Date)
    expect(block.timestamp!.getTime()).toBeGreaterThanOrEqual(before.getTime())
    expect(block.timestamp!.getTime()).toBeLessThanOrEqual(after.getTime())
  })

  it("handles single from_agent", () => {
    useTeamStore.getState()._handleSSEEvent("inbox", {
      agent: "worker",
      content: "message from lead",
      from_agent: "lead",
    })

    const block = useTeamStore.getState().agentStreams["worker"].currentBlocks[0]
    expect(block.extra).toEqual({ from_agent: "lead" })
  })

  it("appends to existing currentBlocks", () => {
    useTeamStore.setState({
      agentStreams: {
        worker: makeStream({
          currentBlocks: [{ id: "existing", type: "text" as const, content: "existing" }],
        }),
      },
    })

    useTeamStore.getState()._handleSSEEvent("inbox", {
      agent: "worker",
      content: "inbox msg",
      from_agent: "lead",
    })

    expect(useTeamStore.getState().agentStreams["worker"].currentBlocks).toHaveLength(2)
  })
})

// ── _handleSSEEvent: error ────────────────────────────────────────────────────

describe("_handleSSEEvent: error", () => {
  it("sets error message on the store", () => {
    useTeamStore.getState()._handleSSEEvent("error", { message: "Something went wrong" })
    expect(useTeamStore.getState().error).toBe("Something went wrong")
  })

  it("sets isTeamWorking to false", () => {
    useTeamStore.setState({ isTeamWorking: true })
    useTeamStore.getState()._handleSSEEvent("error", { message: "fail" })
    expect(useTeamStore.getState().isTeamWorking).toBe(false)
  })

  it("does not affect agentStreams", () => {
    useTeamStore.setState({
      agentStreams: { lead: makeStream({ status: "working" as const }) },
    })
    useTeamStore.getState()._handleSSEEvent("error", { message: "fail" })
    // agentStreams untouched by error event
    expect(useTeamStore.getState().agentStreams["lead"].status).toBe("working")
  })
})

// ── sendMessage ───────────────────────────────────────────────────────────────

describe("sendMessage", () => {
  it("pushes an optimistic user block into the lead's currentBlocks", async () => {
    useTeamStore.setState({
      leadName: "lead",
      agentStreams: { lead: makeStream() },
    })

    await useTeamStore.getState().sendMessage("hello team")

    const leadBlocks = useTeamStore.getState().agentStreams["lead"].currentBlocks
    expect(leadBlocks).toHaveLength(1)
    expect(leadBlocks[0].type).toBe("user")
    expect(leadBlocks[0].content).toBe("hello team")
  })

  it("stamps optimistic user blocks with the lead default model", async () => {
    useTeamStore.setState({
      leadName: "lead",
      sessionModel: null,
      agentStreams: { lead: makeStream({ model: "openai:gpt-5.5" }) },
    })

    await useTeamStore.getState().sendMessage("hello team")

    const leadBlocks = useTeamStore.getState().agentStreams["lead"].currentBlocks
    expect(leadBlocks[0].extra?.model).toBe("openai:gpt-5.5")
  })

  it("patches the optimistic user block's id to the server-issued message_id once the POST resolves", async () => {
    // The backend now returns the persisted user message's id even on the
    // immediate (non-queued) send path. Adopting it lets later reconciliation
    // (removePersistedOptimisticUserBlocks) match by id instead of inferring
    // "same message?" from content + a clock-skew time window.
    useTeamStore.setState({ leadName: "lead", agentStreams: { lead: makeStream() } })
    mockPostTeamChat.mockImplementation(() =>
      Promise.resolve({ status: "ok", session_id: "team-sid", message_id: "server-msg-1" })
    )

    await useTeamStore.getState().sendMessage("hello team")

    const block = useTeamStore.getState().agentStreams.lead.currentBlocks[0]
    expect(block.id).toBe("server-msg-1")
  })

  it("keeps the optimistic user block's local id when the POST response carries no message_id", async () => {
    useTeamStore.setState({ leadName: "lead", agentStreams: { lead: makeStream() } })
    mockPostTeamChat.mockImplementation(() =>
      Promise.resolve({ status: "ok", session_id: "team-sid" })
    )

    await useTeamStore.getState().sendMessage("hello team")

    const block = useTeamStore.getState().agentStreams.lead.currentBlocks[0]
    expect(block.id).toMatch(/^user-/)
  })

  it("sets isTeamWorking=true before the POST resolves", async () => {
    useTeamStore.setState({ leadName: "lead", agentStreams: { lead: makeStream() } })

    let resolvePost!: (v: { status: string; session_id: string }) => void
    mockPostTeamChat.mockImplementation(
      () => new Promise((res) => { resolvePost = res })
    )

    const promise = useTeamStore.getState().sendMessage("hello")
    expect(useTeamStore.getState().isTeamWorking).toBe(true)

    resolvePost({ status: "ok", session_id: "team-sid" })
    await promise
  })

  it("calls postTeamChat with the message text", async () => {
    useTeamStore.setState({ leadName: "lead", agentStreams: { lead: makeStream() } })
    await useTeamStore.getState().sendMessage("test message")
    expect(mockPostTeamChat).toHaveBeenCalledTimes(1)
    expect(mockPostTeamChat.mock.calls[0][0]).toBe("test message")
  })

  it("calls postTeamChat with interrupt=false when not working", async () => {
    useTeamStore.setState({ leadName: "lead", agentStreams: { lead: makeStream() } })
    await useTeamStore.getState().sendMessage("hello")
    expect(mockPostTeamChat.mock.calls[0][2]).toBe(false)
  })

  it("passes shell option and visible bang command to postTeamChat", async () => {
    useTeamStore.setState({ leadName: "lead", agentStreams: { lead: makeStream() } })
    await useTeamStore.getState().sendMessage("!ls -la", undefined, { shell: true })
    expect(mockPostTeamChat.mock.calls[0][0]).toBe("!ls -la")
    expect(mockPostTeamChat.mock.calls[0]).toContain(true)
    const block = useTeamStore.getState().agentStreams.lead.currentBlocks[0]
    expect(block.extra?.kind).toBe("user_shell")
    expect(block.extra?.command).toBe("ls -la")
  })

  it("sets sessionId from postTeamChat response", async () => {
    mockPostTeamChat.mockImplementation(() =>
      Promise.resolve({ status: "ok", session_id: "new-team-sid" })
    )
    useTeamStore.setState({ leadName: "lead", agentStreams: { lead: makeStream() } })
    await useTeamStore.getState().sendMessage("hello")
    expect(useTeamStore.getState().sessionId).toBe("new-team-sid")
  })

  it("calls connectStream after postTeamChat resolves", async () => {
    useTeamStore.setState({
      leadName: "lead",
      agentStreams: { lead: makeStream() },
      sessionId: "team-sid",
    })
    await useTeamStore.getState().sendMessage("hello")
    expect(mockTeamStream).toHaveBeenCalledTimes(1)
  })

  it("sets error and stops working when postTeamChat throws", async () => {
    mockPostTeamChat.mockImplementation(() =>
      Promise.reject(new Error("Network failure"))
    )
    useTeamStore.setState({ leadName: "lead", agentStreams: { lead: makeStream() } })
    await useTeamStore.getState().sendMessage("hello")

    const state = useTeamStore.getState()
    expect(state.error).toBe("Network failure")
    expect(state.isTeamWorking).toBe(false)
  })

  it("sets fallback error message for non-Error throws", async () => {
    mockPostTeamChat.mockImplementation(() => Promise.reject("unknown"))
    useTeamStore.setState({ leadName: "lead", agentStreams: { lead: makeStream() } })
    await useTeamStore.getState().sendMessage("hello")
    expect(useTeamStore.getState().error).toBe("Failed to send message")
  })

  it("does not call connectStream when postTeamChat throws", async () => {
    mockPostTeamChat.mockImplementation(() => Promise.reject(new Error("fail")))
    useTeamStore.setState({ leadName: "lead", agentStreams: { lead: makeStream() } })
    await useTeamStore.getState().sendMessage("hello")
    expect(mockTeamStream).not.toHaveBeenCalled()
  })

  // The composer clears optimistically the moment a message is submitted, so
  // callers need to know whether the send actually landed — otherwise a
  // failed POST silently takes the user's text and attachments with it.
  it("reports success so the caller can keep the cleared composer cleared", async () => {
    useTeamStore.setState({ leadName: "lead", agentStreams: { lead: makeStream() } })

    const delivered = await useTeamStore.getState().sendMessage("hello")

    expect(delivered).toBe(true)
  })

  it("reports failure when the POST throws", async () => {
    mockPostTeamChat.mockImplementation(() => Promise.reject(new Error("Network failure")))
    useTeamStore.setState({ leadName: "lead", agentStreams: { lead: makeStream() } })

    const delivered = await useTeamStore.getState().sendMessage("hello")

    expect(delivered).toBe(false)
  })

  it("reports failure when queueing a follow-up throws", async () => {
    mockPostTeamChat.mockImplementation(() => Promise.reject(new Error("Network failure")))
    useTeamStore.setState({
      leadName: "lead",
      agentStreams: { lead: makeStream({ status: "working" }) },
    })

    const delivered = await useTeamStore.getState().sendMessage("queued follow-up")

    expect(delivered).toBe(false)
  })
})

// ── sendMessage with files ────────────────────────────────────────────────────

describe("sendMessage with files", () => {
  it("creates optimistic image attachments with blob URLs", async () => {
    const originalCreate = URL.createObjectURL
    URL.createObjectURL = mock(() => "blob:http://localhost/img")

    useTeamStore.setState({ leadName: "lead", agentStreams: { lead: makeStream() } })
    const imageFile = new File(["data"], "photo.png", { type: "image/png" })

    await useTeamStore.getState().sendMessage("see this", [imageFile])

    const block = useTeamStore.getState().agentStreams["lead"].currentBlocks[0]
    expect(block.attachments).toHaveLength(1)
    expect(block.attachments![0].category).toBe("image")
    expect(block.attachments![0].url).toBe("blob:http://localhost/img")
    expect(block.attachments![0].original_name).toBe("photo.png")

    URL.createObjectURL = originalCreate
  })

  it("creates document attachments without blob URLs for non-image files", async () => {
    useTeamStore.setState({ leadName: "lead", agentStreams: { lead: makeStream() } })
    const pdfFile = new File(["data"], "report.pdf", { type: "application/pdf" })

    await useTeamStore.getState().sendMessage("see this", [pdfFile])

    const block = useTeamStore.getState().agentStreams["lead"].currentBlocks[0]
    expect(block.attachments).toHaveLength(1)
    expect(block.attachments![0].category).toBe("document")
    expect(block.attachments![0].url).toBeUndefined()
  })

  it("passes files to postTeamChat", async () => {
    useTeamStore.setState({ leadName: "lead", agentStreams: { lead: makeStream() } })
    const file = new File(["data"], "doc.txt", { type: "text/plain" })
    await useTeamStore.getState().sendMessage("with file", [file])
    expect(mockPostTeamChat.mock.calls[0][3]).toEqual([file])
  })
})

// ── sendMessage: queue behaviour (lead-working guard) ────────────────────────

describe("sendMessage: queue behaviour", () => {
  it("persists queued messages through the backend when lead is working", async () => {
    mockPostTeamChat.mockImplementationOnce(() =>
      Promise.resolve({ status: "queued", session_id: "session-a", message_id: "pm-a" }),
    )
    useTeamStore.setState({
      sessionId: "session-a",
      leadName: "lead",
      agentStreams: { lead: makeStream({ status: "working" as const }) },
    })
    await useTeamStore.getState().sendMessage("queued message", undefined, { mode: "coding", workspace: "/repo/a" })
    expect(mockPostTeamChat).toHaveBeenCalledTimes(1)
    expect(mockPostTeamChat.mock.calls[0][0]).toBe("queued message")
    expect(mockPostTeamChat.mock.calls[0][1]).toBe("session-a")
    expect(mockPostTeamChat.mock.calls[0][4]).toBe("coding")
    expect(mockPostTeamChat.mock.calls[0][5]).toBe("/repo/a")
    const pending = useTeamStore.getState()._pendingMessages
    expect(pending).toHaveLength(1)
    expect(pending[0].sessionId).toBe("session-a")
    expect(pending[0].content).toBe("queued message")
  })

  it("queues explicit file attachments while lead is working", async () => {
    // Regression: the backend accepts file uploads on queued messages
    // (f44b0544), but the frontend kept a stale pre-support guard that
    // rejected them with an error — breaking attach-while-streaming on
    // both desktop and mobile.
    mockPostTeamChat.mockImplementationOnce(() =>
      Promise.resolve({ status: "queued", session_id: "session-a", message_id: "pm-file" }),
    )
    const file = new File(["data"], "doc.txt", { type: "text/plain" })
    useTeamStore.setState({
      sessionId: "session-a",
      leadName: "lead",
      agentStreams: { lead: makeStream({ status: "working" as const }) },
    })

    await useTeamStore.getState().sendMessage("queued with file", [file])

    expect(mockPostTeamChat).toHaveBeenCalledTimes(1)
    expect(mockPostTeamChat.mock.calls[0][3]).toEqual([file])
    const pending = useTeamStore.getState()._pendingMessages
    expect(pending).toHaveLength(1)
    expect(pending[0].id).toBe("pm-file")
    expect(pending[0].content).toBe("queued with file")
    expect(pending[0].files).toEqual([file])
    expect(pending[0].attachments).toEqual([
      { original_name: "doc.txt", media_type: expect.stringMatching(/^text\/plain/), category: "document" },
    ])
    expect(useTeamStore.getState().error).toBeNull()
  })

  it("categorises queued image attachments as images", async () => {
    mockPostTeamChat.mockImplementationOnce(() =>
      Promise.resolve({ status: "queued", session_id: "session-a", message_id: "pm-img" }),
    )
    const image = new File(["data"], "photo.png", { type: "image/png" })
    useTeamStore.setState({
      sessionId: "session-a",
      leadName: "lead",
      agentStreams: { lead: makeStream({ status: "working" as const }) },
    })

    await useTeamStore.getState().sendMessage("queued image", [image])

    expect(useTeamStore.getState()._pendingMessages[0].attachments).toEqual([
      { original_name: "photo.png", media_type: "image/png", category: "image" },
    ])
  })

  it("treats a queued response without message_id as an error", async () => {
    mockPostTeamChat.mockImplementationOnce(() =>
      Promise.resolve({ status: "queued", session_id: "session-a" }),
    )
    useTeamStore.setState({
      sessionId: "session-a",
      leadName: "lead",
      agentStreams: { lead: makeStream({ status: "working" as const }) },
    })

    await useTeamStore.getState().sendMessage("queued")

    expect(useTeamStore.getState()._pendingMessages).toHaveLength(0)
    expect(useTeamStore.getState().error).toBe("Backend did not return a queued message id")
  })

  it("does NOT queue when only members are working (lead is idle)", async () => {
    useTeamStore.setState({
      leadName: "lead",
      agentStreams: {
        lead: makeStream({ status: "idle" as const }),
        worker: makeStream({ status: "working" as const }),
      },
    })
    await useTeamStore.getState().sendMessage("immediate message")
    expect(mockPostTeamChat).toHaveBeenCalledTimes(1)
    expect(useTeamStore.getState()._pendingMessages).toHaveLength(0)
  })

  it("does not add optimistic block when message is queued", async () => {
    useTeamStore.setState({
      leadName: "lead",
      agentStreams: { lead: makeStream({ status: "working" as const }) },
    })
    await useTeamStore.getState().sendMessage("queued")
    expect(useTeamStore.getState().agentStreams["lead"].currentBlocks).toHaveLength(0)
  })

  it("queues multiple messages in order", async () => {
    useTeamStore.setState({
      leadName: "lead",
      agentStreams: { lead: makeStream({ status: "working" as const }) },
    })
    await useTeamStore.getState().sendMessage("first")
    await useTeamStore.getState().sendMessage("second")
    await useTeamStore.getState().sendMessage("third")
    const pending = useTeamStore.getState()._pendingMessages
    expect(pending).toHaveLength(3)
    expect(pending[0].content).toBe("first")
    expect(pending[1].content).toBe("second")
    expect(pending[2].content).toBe("third")
  })

  it("moves queued messages into the lead stream when the backend starts the queued turn", () => {
    useTeamStore.setState({
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

    useTeamStore.getState()._handleSSEEvent("queued_turn_start", { agent: "lead" })

    const blocks = useTeamStore.getState().agentStreams.lead.currentBlocks
    expect(blocks.map((block) => block.content)).toEqual(["first queued", "second queued"])
    expect(useTeamStore.getState().isTeamWorking).toBe(true)
    expect(useTeamStore.getState().agentStreams.lead.status).toBe("working")
    expect(useTeamStore.getState()._pendingMessages).toHaveLength(0)
  })

  it("carries queued attachments onto the spliced user block", () => {
    const attachments = [
      { original_name: "doc.txt", media_type: "text/plain", category: "document" as const },
    ]
    useTeamStore.setState({
      sessionId: "session-a",
      leadName: "lead",
      agentStreams: { lead: makeStream({ status: "idle" as const }) },
      _pendingMessages: [
        { id: "pm-1", sessionId: "session-a", content: "queued with file", attachments },
      ],
    })

    useTeamStore.getState()._handleSSEEvent("queued_turn_start", { agent: "lead" })

    const blocks = useTeamStore.getState().agentStreams.lead.currentBlocks
    expect(blocks).toHaveLength(1)
    expect(blocks[0].attachments).toEqual(attachments)
  })

  it("keeps the frontend streaming when a queued turn starts after undo reset state", () => {
    useTeamStore.setState({
      sessionId: "session-a",
      leadName: "lead",
      isTeamWorking: false,
      agentStreams: {
        lead: makeStream({ status: "idle" as const }),
      },
      _pendingMessages: [
        { id: "pm-1", sessionId: "session-a", content: "queued after undo" },
      ],
      error: "Cannot undo while agents are working — /stop first",
    })

    useTeamStore.getState()._handleSSEEvent("queued_turn_start", { agent: "lead", message_ids: ["pm-1"] })
    useTeamStore.getState()._handleSSEEvent("message", { agent: "lead", text: "continued" })

    const state = useTeamStore.getState()
    expect(state.isTeamWorking).toBe(true)
    expect(state.error).toBeNull()
    expect(state.agentStreams.lead.status).toBe("working")
    expect(state.agentStreams.lead.currentBlocks.map((block) => block.content)).toEqual([
      "queued after undo",
      "continued",
    ])
  })

  it("renders backend-provided loop turn messages while streaming", () => {
    useTeamStore.setState({
      sessionId: "session-a",
      leadName: "lead",
      agentStreams: {
        lead: makeStream({ status: "idle" as const }),
      },
      _pendingMessages: [],
    })

    useTeamStore.getState()._handleSSEEvent("queued_turn_start", {
      agent: "lead",
      message_ids: ["loop-1"],
      messages: [{ id: "loop-1", content: "just say hi" }],
    })
    useTeamStore.getState()._handleSSEEvent("message", { agent: "lead", text: "hi" })

    const blocks = useTeamStore.getState().agentStreams.lead.currentBlocks
    expect(blocks.map((block) => block.content)).toEqual(["just say hi", "hi"])
    expect(useTeamStore.getState().isTeamWorking).toBe(true)
  })

  it("keeps queued messages for a different active session", () => {
    useTeamStore.setState({
      sessionId: "session-b",
      leadName: "lead",
      agentStreams: {
        lead: makeStream({ status: "working" as const }),
      },
      _pendingMessages: [
        { id: "pm-a", sessionId: "session-a", content: "belongs to A" },
      ],
    })

    useTeamStore.getState()._handleSSEEvent("queued_turn_start", { agent: "lead" })

    expect(useTeamStore.getState()._pendingMessages).toEqual([
      { id: "pm-a", sessionId: "session-a", content: "belongs to A" },
    ])
  })

  it("moves queued messages for active session and keeps other sessions queued", () => {
    useTeamStore.setState({
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

    useTeamStore.getState()._handleSSEEvent("queued_turn_start", { agent: "lead" })

    expect(useTeamStore.getState()._pendingMessages).toEqual([
      { id: "pm-b1", sessionId: "session-b", content: "only B" },
    ])
    expect(useTeamStore.getState().agentStreams.lead.currentBlocks.map((block) => block.content)).toEqual([
      "first A",
      "second A",
    ])
  })

  it("does not move queued messages on replayed lead working status", () => {
    useTeamStore.setState({
      sessionId: "session-a",
      leadName: "lead",
      agentStreams: {
        lead: makeStream({ status: "idle" as const }),
      },
      _pendingMessages: [
        { id: "pm-1", sessionId: "session-a", content: "queued" },
      ],
    })

    useTeamStore.getState()._handleSSEEvent("agent_status", { agent: "lead", status: "working" })
    useTeamStore.getState()._handleSSEEvent("message", { agent: "lead", text: "streaming" })

    expect(useTeamStore.getState()._pendingMessages).toEqual([
      { id: "pm-1", sessionId: "session-a", content: "queued" },
    ])
    expect(useTeamStore.getState().agentStreams.lead.currentBlocks.map((block) => block.content)).toEqual([
      "streaming",
    ])
  })

  it("preserves the backend queue order when pending responses arrived out of order", () => {
    useTeamStore.setState({
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

    useTeamStore.getState()._handleSSEEvent("queued_turn_start", {
      agent: "lead",
      message_ids: ["pm-first", "pm-second"],
    })

    expect(useTeamStore.getState().agentStreams.lead.currentBlocks.map((block) => block.content)).toEqual([
      "first queued",
      "second queued",
    ])
  })

  it("keeps message_ids order even when only some ids resolved locally (fallback content interleaved)", () => {
    // pm-b's own POST response has not resolved into _pendingMessages yet
    // (or was submitted from another client), so it can only be recovered
    // from the event's own `messages` payload — while pm-a and pm-c did
    // resolve locally. All three must still render in `message_ids` order.
    useTeamStore.setState({
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

    useTeamStore.getState()._handleSSEEvent("queued_turn_start", {
      agent: "lead",
      message_ids: ["pm-a", "pm-b", "pm-c"],
      messages: [
        { id: "pm-a", content: "a queued" },
        { id: "pm-b", content: "b queued" },
        { id: "pm-c", content: "c queued" },
      ],
    })

    expect(useTeamStore.getState().agentStreams.lead.currentBlocks.map((block) => block.content)).toEqual([
      "a queued",
      "b queued",
      "c queued",
    ])
  })

  it("moves only queued ids named by queued_turn_start", () => {
    useTeamStore.setState({
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

    useTeamStore.getState()._handleSSEEvent("queued_turn_start", { agent: "lead", message_ids: ["pm-a2"] })

    expect(useTeamStore.getState()._pendingMessages).toEqual([
      { id: "pm-a1", sessionId: "session-a", content: "first A" },
    ])
    expect(useTeamStore.getState().agentStreams.lead.currentBlocks.map((block) => block.content)).toEqual([
      "second A",
    ])
  })

  it("keeps live response durations separate across queued-message injection", () => {
    const originalNow = Date.now
    const times = [1_000, 4_600, 4_700, 7_600]
    Date.now = mock(() => times.shift() ?? 7_600) as typeof Date.now
    try {
      useTeamStore.setState({
        sessionId: "session-a",
        leadName: "lead",
        agentStreams: {
          lead: makeStream({ status: "working" as const, _turnStartedAt: 0 }),
        },
        _pendingMessages: [
          { id: "pm-a1", sessionId: "session-a", content: "queued follow-up", submittedAt: 4_700 },
        ],
      })

      useTeamStore.getState()._handleSSEEvent("message", { agent: "lead", text: "first assistant" })
      useTeamStore.getState()._handleSSEEvent("queued_turn_start", { agent: "lead", message_ids: ["pm-a1"] })
      useTeamStore.getState()._handleSSEEvent("message", { agent: "lead", text: "second assistant" })
      useTeamStore.getState()._handleSSEEvent("done", {})
    } finally {
      Date.now = originalNow
    }

    const blocks = useTeamStore.getState().agentStreams.lead.blocks
    const textBlocks = blocks.filter((block) => block.type === "text")

    expect(textBlocks.map((block) => block.content)).toEqual(["first assistant", "second assistant"])
    expect(textBlocks.map((block) => block.responseDurationMs)).toEqual([4700, 2900])
  })

  it("does not notify when a background process completes through bg", () => {
    useTeamStore.setState({
      sessionId: "session-a",
      leadName: "lead",
      agentStreams: {
        lead: makeStream({ status: "working" as const }),
      },
    })

    useTeamStore.getState()._handleSSEEvent("tool_end", {
      agent: "lead",
      name: "bg",
      result: "PID 123: exited (code 0)\nFinal output:\nok",
    })

    expect(mockSendDesktopNotification).not.toHaveBeenCalled()
  })

  it("does not notify directly from done because backend owns completion notifications", () => {
    useTeamStore.setState({
      sessionId: "session-a",
      leadName: "lead",
      agentStreams: {
        lead: makeStream({ status: "working" as const }),
      },
      isTeamWorking: true,
    })

    useTeamStore.getState()._handleSSEEvent("done", {})

    expect(mockSendDesktopNotification).not.toHaveBeenCalled()
  })

  it("stores backend queued message ids returned while lead is working", async () => {
    mockPostTeamChat.mockImplementationOnce(() =>
      Promise.resolve({ status: "queued", session_id: "session-a", message_id: "message-a" }),
    )
    useTeamStore.setState({
      sessionId: "session-a",
      leadName: "lead",
      agentStreams: { lead: makeStream({ status: "working" as const }) },
    })

    await useTeamStore.getState().sendMessage("queued")

    const [pending] = useTeamStore.getState()._pendingMessages
    expect(pending).toMatchObject({ id: "message-a", sessionId: "session-a", content: "queued" })
    expect(typeof pending.submittedAt).toBe("number")
  })

  it("removePendingMessage removes message by id", () => {
    useTeamStore.setState({
      _pendingMessages: [
        { id: "pm-1", content: "first" },
        { id: "pm-2", content: "second" },
        { id: "pm-3", content: "third" },
      ],
    })
    useTeamStore.getState().removePendingMessage("pm-2")
    const pending = useTeamStore.getState()._pendingMessages
    expect(pending).toHaveLength(2)
    expect(pending[0].content).toBe("first")
    expect(pending[1].content).toBe("third")
  })

  it("newSession clears the pending queue", () => {
    useTeamStore.setState({
      leadName: "lead",
      agentStreams: { lead: makeStream() },
      _pendingMessages: [{ id: "pm-1", content: "pending" }],
    })
    useTeamStore.getState().newSession()
    expect(useTeamStore.getState()._pendingMessages).toHaveLength(0)
  })

  it("marks a resolved empty session ready for one route restore skip", () => {
    useTeamStore.setState({
      leadName: "lead",
      agentNames: ["lead"],
      agentStreams: { lead: makeStream() },
    })
    useTeamStore.getState().beginResolvedSession("new-session", {
      mode: "coding",
      workspace: "/repo/project",
      skipInitialRestore: true,
    })

    expect(useTeamStore.getState().consumeResolvedSessionReady("new-session", "/repo/project")).toBe(true)
    expect(useTeamStore.getState()._resolvedSessionReadyId).toBeNull()
    expect(useTeamStore.getState().consumeResolvedSessionReady("new-session", "/repo/project")).toBe(false)
  })

  it("does not mark restored sessions for a route restore skip by default", () => {
    useTeamStore.setState({
      leadName: "lead",
      agentNames: ["lead"],
      agentStreams: { lead: makeStream() },
    })
    useTeamStore.getState().beginResolvedSession("existing-session", {
      mode: "coding",
      workspace: "/repo/project",
    })

    expect(useTeamStore.getState().consumeResolvedSessionReady("existing-session", "/repo/project")).toBe(false)
  })

  it("does not skip restore when the resolved session workspace differs", () => {
    useTeamStore.setState({
      leadName: "lead",
      agentNames: ["lead"],
      agentStreams: { lead: makeStream() },
    })
    useTeamStore.getState().beginResolvedSession("new-session", {
      mode: "coding",
      workspace: "/repo/project",
      skipInitialRestore: true,
    })

    expect(useTeamStore.getState().consumeResolvedSessionReady("new-session", "/repo/other")).toBe(false)
    expect(useTeamStore.getState()._resolvedSessionReadyId).toBe("new-session")
  })

  it("preserves in-flight working state and optimistic user block when beginResolvedSession resolves concurrently after sendMessage in a new session", async () => {
    useTeamStore.setState({
      sessionId: null,
      leadName: "lead",
      agentNames: ["lead"],
      agentStreams: { lead: makeStream() },
    })

    let resolvePost!: (value: unknown) => void
    mockPostTeamChat.mockImplementation(
      () => new Promise((res) => { resolvePost = res })
    )

    // User sends a message when sessionId is null (new session)
    void useTeamStore.getState().sendMessage("message to new session")

    expect(useTeamStore.getState().isTeamWorking).toBe(true)
    const stream = useTeamStore.getState().agentStreams["lead"]
    expect(stream.currentBlocks.some((b) => b.type === "user" && b.content === "message to new session")).toBe(true)

    // Concurrent beginResolvedSession resolves for the background session creation
    useTeamStore.getState().beginResolvedSession("new-created-session", {
      skipInitialRestore: true,
    })

    // Working state and optimistic block must be preserved
    expect(useTeamStore.getState().isTeamWorking).toBe(true)
    expect(useTeamStore.getState().agentStreams["lead"].currentBlocks.some((b) => b.type === "user" && b.content === "message to new session")).toBe(true)

    // When postTeamChat finishes, sessionId is set correctly
    resolvePost({ session_id: "post-created-session" })
    await Promise.resolve()

    expect(useTeamStore.getState().sessionId).toBe("post-created-session")
  })
})

// ── stopTeam ─────────────────────────────────────────────────────────────────

describe("stopTeam", () => {
  it("reloads immediately after the interrupt without waiting for the trailing done", async () => {
    useTeamStore.setState({
      sessionId: "session-a",
      isTeamWorking: true,
      _workspace: "/repo/a",
    })

    // The reload no longer waits on a timer for the turn to "settle": a
    // belated `done` can no longer duplicate the turn (it recognises that a
    // canonical reload already absorbed it), so Stop stays responsive.
    await useTeamStore.getState().stopTeam()

    expect(mockPostTeamChat).toHaveBeenCalledWith(null, "session-a", true)
    expect(mockTeamHistory).toHaveBeenCalledWith("session-a")
    expect(useTeamStore.getState()._workspace).toBe("/repo/a")
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
    useTeamStore.setState({
      sessionId: "sess-1",
      isTeamWorking: true,
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

    mockTeamHistory.mockImplementation(() => Promise.resolve({
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
    await useTeamStore.getState().stopTeam()

    // The backend finally finishes cancelling and the trailing `done` event
    // lands — long after the reload. Because the reload already absorbed this
    // exact turn, `done` must drop the now-redundant live blocks rather than
    // append them a second time. No timing window is involved.
    useTeamStore.getState()._handleSSEEvent("done", {})

    const finalBlocks = useTeamStore.getState().agentStreams.lead.blocks
    const userBlocks = finalBlocks.filter((b) => b.type === "user" && b.content === "message A")
    const answerBlocks = finalBlocks.filter((b) => b.content === "final answer")
    expect(userBlocks).toHaveLength(1)
    expect(answerBlocks).toHaveLength(1)
    expect(useTeamStore.getState().agentStreams.lead.currentBlocks).toHaveLength(0)
  })

  it("still commits a brand-new turn that starts while the post-stop reload is in flight", async () => {
    // Guard against over-absorbing: if a *new* turn begins after the history
    // snapshot was taken, its blocks are genuinely absent from that snapshot
    // and `done` must still commit them.
    useTeamStore.setState({
      sessionId: "sess-1",
      isTeamWorking: true,
      leadName: "lead",
      agentNames: ["lead"],
      _pendingMessages: [{ id: "pm-b", sessionId: "sess-1", content: "message B" }],
      agentStreams: {
        lead: makeStream({
          status: "working",
          currentBlocks: [
            { id: "b3", type: "text", content: "final answer", timestamp: new Date(Date.now() - 1000) },
          ],
        }),
      },
    })

    mockTeamHistory.mockImplementation(async () => {
      // A queued message is released into a new turn while the fetch is in
      // flight — this content postdates the snapshot below.
      useTeamStore.getState()._handleSSEEvent("queued_turn_start", {
        agent: "lead", message_ids: ["pm-b"],
      })
      useTeamStore.getState()._handleSSEEvent("message", { agent: "lead", text: "answer B" })
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

    await useTeamStore.getState().stopTeam()
    useTeamStore.getState()._handleSSEEvent("done", {})

    const finalBlocks = useTeamStore.getState().agentStreams.lead.blocks
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

  it("calls teamStream with the current sessionId", () => {
    useTeamStore.setState({ sessionId: "stream-sid", isTeamWorking: true })
    useTeamStore.getState().connectStream()
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

    useTeamStore.setState({ sessionId: "stream-sid" })
    let callbacks!: { onEvent: (type: string, data: unknown) => void }
    mockTeamStream.mockImplementation((_sid: string, cbs: typeof callbacks) => { callbacks = cbs })
    useTeamStore.getState().connectStream()

    let notifications = 0
    const unsubscribe = useTeamStore.subscribe(() => { notifications += 1 })
    callbacks.onEvent("message", { agent: "lead", text: "one " })
    callbacks.onEvent("message", { agent: "lead", text: "two " })
    callbacks.onEvent("message", { agent: "lead", text: "three" })

    // Deltas received in the same frame window should not produce one
    // immer snapshot + subscriber notification each.
    expect(notifications).toBe(0)
    expect(scheduled).not.toBeNull()
    ;(scheduled as unknown as () => void)()
    expect(notifications).toBe(1)
    expect(useTeamStore.getState().agentStreams.lead.currentBlocks[0].content).toBe("one two three")

    // A structural event must flush pending text synchronously first, so
    // `done` commits every preceding byte instead of finalising early.
    callbacks.onEvent("message", { agent: "lead", text: " done" })
    callbacks.onEvent("done", {})
    expect(scheduled).toBeNull()
    expect(useTeamStore.getState().agentStreams.lead.currentBlocks).toHaveLength(0)
    expect(useTeamStore.getState().agentStreams.lead.blocks[0].content).toBe("one two three done")
    expect(notifications).toBe(3) // one delta flush + one delta flush + done
    unsubscribe()
  })

  it("sets isConnected=true", () => {
    useTeamStore.setState({ sessionId: "stream-sid" })
    useTeamStore.getState().connectStream()
    expect(useTeamStore.getState().isConnected).toBe(true)
  })

  it("returns an AbortController", () => {
    useTeamStore.setState({ sessionId: "stream-sid" })
    const abort = useTeamStore.getState().connectStream()
    expect(abort).toBeInstanceOf(AbortController)
  })

  it("returns a new AbortController when sessionId is null (no-op)", () => {
    useTeamStore.setState({ sessionId: null })
    const abort = useTeamStore.getState().connectStream()
    expect(abort).toBeInstanceOf(AbortController)
    expect(mockTeamStream).not.toHaveBeenCalled()
  })

  it("aborts previous stream before opening a new one", () => {
    const fakeAbort = new AbortController()
    const abortSpy = spyOn(fakeAbort, "abort")
    useTeamStore.setState({ sessionId: "stream-sid", _abortController: fakeAbort })
    useTeamStore.getState().connectStream()
    expect(abortSpy).toHaveBeenCalledTimes(1)
  })

  it("passes an AbortSignal to teamStream", () => {
    useTeamStore.setState({ sessionId: "stream-sid" })
    useTeamStore.getState().connectStream()
    const signal = mockTeamStream.mock.calls[0][2]
    expect(signal).toBeInstanceOf(AbortSignal)
  })

  it("onError sets error and isConnected=false for non-transport failures", () => {
    useTeamStore.setState({ sessionId: "s1", isTeamWorking: true })
    let callbacks!: { onError: (err: Error) => void }
    mockTeamStream.mockImplementation((_sid: string, cbs: typeof callbacks) => { callbacks = cbs })
    useTeamStore.getState().connectStream()
    callbacks.onError(new Error("SSE parser failed"))
    expect(useTeamStore.getState().error).toBe("SSE parser failed")
    expect(useTeamStore.getState().isConnected).toBe(false)
  })

  it("downgrades iOS transport stream failures while work continues", () => {
    useTeamStore.setState({ sessionId: "s1", isTeamWorking: true })
    let callbacks!: { onError: (err: Error) => void }
    mockTeamStream.mockImplementation((_sid: string, cbs: typeof callbacks) => { callbacks = cbs })
    useTeamStore.getState().connectStream()
    callbacks.onError(new TypeError("Load failed"))
    expect(useTeamStore.getState().error).toBeNull()
    expect(useTeamStore.getState().isConnected).toBe(false)
    expect(useTeamStore.getState().isTeamWorking).toBe(true)
  })

  it("schedules a reconnect after a transient network error while working", () => {
    // Capture the setTimeout callback so we can fire it synchronously.
    let timerCb!: () => void
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    spyOn(globalThis, "setTimeout").mockImplementation((cb: any) => {
      timerCb = cb
      return 0 as unknown as ReturnType<typeof setTimeout>
    })

    useTeamStore.setState({ sessionId: "s1", isTeamWorking: true })
    let callbacks!: { onError: (err: Error) => void }
    // First call captures callbacks; second call (reconnect) just sets isConnected.
    mockTeamStream.mockImplementation((_sid: string, cbs: typeof callbacks) => { callbacks = cbs })
    useTeamStore.getState().connectStream()
    callbacks.onError(new TypeError("Load failed"))

    // Timer scheduled, stream not yet reconnected.
    expect(timerCb).toBeDefined()
    expect(mockTeamStream).toHaveBeenCalledTimes(1)

    // Fire the timer — should reopen the stream.
    timerCb()
    expect(mockTeamStream).toHaveBeenCalledTimes(2)
    expect(useTeamStore.getState().isConnected).toBe(true)

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

    useTeamStore.setState({ sessionId: "s1", isTeamWorking: true })
    let streamCallbacks!: { onError: (err: Error) => void; onEvent: (type: string, data: unknown) => void }
    mockTeamStream.mockImplementation((_sid: string, cbs: typeof streamCallbacks) => { streamCallbacks = cbs })

    useTeamStore.getState().connectStream()
    streamCallbacks.onError(new TypeError("Load failed"))
    expect(delays[0]).toBe(1_500)
    callbacks.shift()?.()

    streamCallbacks.onError(new TypeError("Load failed"))
    expect(delays[1]).toBe(3_000)
    streamCallbacks.onEvent("message", { text: "recovered", agent: "lead" })
    expect(useTeamStore.getState()._reconnectAttempts).toBe(0)
  })

  it("clears a pending reconnect timer when starting a new session", () => {
    let timerCb!: () => void
    const clearTimeoutSpy = spyOn(globalThis, "clearTimeout")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    spyOn(globalThis, "setTimeout").mockImplementation((cb: any) => {
      timerCb = cb
      return 123 as unknown as ReturnType<typeof setTimeout>
    })

    useTeamStore.setState({ sessionId: "s1", isTeamWorking: true })
    let callbacks!: { onError: (err: Error) => void }
    mockTeamStream.mockImplementation((_sid: string, cbs: typeof callbacks) => { callbacks = cbs })
    useTeamStore.getState().connectStream()
    callbacks.onError(new TypeError("Load failed"))

    expect(useTeamStore.getState()._reconnectTimer).toBe(123)

    useTeamStore.getState().newSession()

    expect(clearTimeoutSpy).toHaveBeenCalledWith(123)
    expect(useTeamStore.getState()._reconnectTimer).toBeNull()

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

    useTeamStore.setState({ sessionId: "s1", isTeamWorking: true })
    let callbacks!: { onError: (err: Error) => void }
    mockTeamStream.mockImplementation((_sid: string, cbs: typeof callbacks) => { callbacks = cbs })
    useTeamStore.getState().connectStream()
    callbacks.onError(new TypeError("Load failed"))

    // Navigate away — bumps generation.
    useTeamStore.getState().newSession()

    // Timer fires but the generation guard should prevent reconnect.
    timerCb()
    // teamStream called only once (the original connect), not again.
    expect(mockTeamStream).toHaveBeenCalledTimes(1)

  })

  it("does not reconnect from the timer if already reconnected", () => {
    let timerCb!: () => void
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    spyOn(globalThis, "setTimeout").mockImplementation((cb: any) => {
      timerCb = cb
      return 0 as unknown as ReturnType<typeof setTimeout>
    })

    useTeamStore.setState({ sessionId: "s1", isTeamWorking: true })
    let callbacks!: { onError: (err: Error) => void }
    mockTeamStream.mockImplementation((_sid: string, cbs: typeof callbacks) => { callbacks = cbs })
    useTeamStore.getState().connectStream()
    callbacks.onError(new TypeError("Load failed"))

    // Manually reconnect before the timer fires (e.g. visibilitychange).
    useTeamStore.setState({ isConnected: true })

    timerCb()
    // Still only one teamStream call — isConnected guard prevents the extra one.
    expect(mockTeamStream).toHaveBeenCalledTimes(1)

  })

  it("ignores stream errors while the page is unloading", () => {
    useTeamStore.setState({ sessionId: "s1", isTeamWorking: true, _unloading: true })
    let callbacks!: { onError: (err: Error) => void }
    mockTeamStream.mockImplementation((_sid: string, cbs: typeof callbacks) => { callbacks = cbs })
    useTeamStore.getState().connectStream()
    callbacks.onError(new Error("NetworkError when attempting to fetch resource"))
    expect(useTeamStore.getState().error).toBeNull()
    expect(useTeamStore.getState().isConnected).toBe(true)
  })

  it("ignores backend error events while the page is unloading", () => {
    useTeamStore.setState({ sessionId: "s1", isTeamWorking: true, _unloading: true })
    let callbacks!: { onEvent: (type: string, data: unknown) => void }
    mockTeamStream.mockImplementation((_sid: string, cbs: typeof callbacks) => { callbacks = cbs })
    useTeamStore.getState().connectStream()
    callbacks.onEvent("error", { message: "Error in input stream" })
    expect(useTeamStore.getState().error).toBeNull()
    expect(useTeamStore.getState().isTeamWorking).toBe(true)
  })

  it("onDone sets isConnected=false and patches the session running flag", () => {
    mockTeamStream.mockImplementation(
      (_sid: string, cbs: { onDone?: () => void }) => {
        cbs.onDone?.()
      }
    )
    useTeamStore.setState({ sessionId: "stream-sid" })
    useTeamStore.getState().connectStream()

    expect(useTeamStore.getState().isConnected).toBe(false)
    // Patched in place rather than invalidating the (infinite, sequentially
    // refetched) session list just to clear a running badge.
    expect(useTeamStore.getState().cacheInvalidations).toContainEqual({
      kind: "session_running",
      sessionId: "stream-sid",
      running: false,
    })
  })

  it("onDone reopens the stream immediately when the session is still working", () => {
    // Simulates an idle-keepalive close mid-run: the backend cleanly closes a
    // channel that had been delivering events, while isTeamWorking is true.
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
    useTeamStore.setState({ sessionId: "stream-sid", isTeamWorking: true })
    useTeamStore.getState().connectStream()

    // Should have opened the stream twice: original + reconnect.
    expect(mockTeamStream).toHaveBeenCalledTimes(2)
    expect(useTeamStore.getState().isConnected).toBe(true)
    // No cache invalidation pushed — session is still in-flight.
    expect(useTeamStore.getState().cacheInvalidations).not.toContainEqual({ kind: "team_sessions" })
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
    useTeamStore.setState({ sessionId: "stream-sid", isTeamWorking: true })
    useTeamStore.getState().connectStream()

    expect(mockTeamStream).toHaveBeenCalledTimes(1)
    expect(useTeamStore.getState()._reconnectAttempts).toBe(1)
    expect(useTeamStore.getState()._reconnectTimer).not.toBeNull()

    clearTimeout(useTeamStore.getState()._reconnectTimer as ReturnType<typeof setTimeout>)
    useTeamStore.setState({ _reconnectTimer: null, _reconnectAttempts: 0 })
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
    useTeamStore.setState({ sessionId: "stream-sid", isTeamWorking: true })

    useTeamStore.getState().connectStream() // connection A
    const onDoneA = callbacksByCall[0].onDone!
    useTeamStore.getState().connectStream() // something else reconnects — aborts A, opens B
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
    useTeamStore.setState({ sessionId: "stream-sid", isTeamWorking: true, _unloading: true })
    useTeamStore.getState().connectStream()

    expect(mockTeamStream).toHaveBeenCalledTimes(1)
    expect(useTeamStore.getState().isConnected).toBe(false)
  })

  it("does not reconnect after onDone when queued messages are pending", () => {
    mockTeamStream.mockImplementation(
      (_sid: string, cbs: { onDone?: () => void }) => {
        cbs.onDone?.()
      }
    )
    useTeamStore.setState({
      sessionId: "stream-sid",
      _pendingMessages: [{ id: "pm-1", sessionId: "stream-sid", content: "queued" }],
    })

    useTeamStore.getState().connectStream()

    expect(mockTeamStream).toHaveBeenCalledTimes(1)
    expect(useTeamStore.getState().isConnected).toBe(false)
  })

  it("does not reconnect after onDone when no queued messages are pending", () => {
    mockTeamStream.mockImplementation(
      (_sid: string, cbs: { onDone?: () => void }) => {
        cbs.onDone?.()
      }
    )
    useTeamStore.setState({ sessionId: "stream-sid" })

    useTeamStore.getState().connectStream()

    expect(mockTeamStream).toHaveBeenCalledTimes(1)
    expect(useTeamStore.getState().isConnected).toBe(false)
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
    useTeamStore.setState({
      sessionId: "session-1",
      leadName: "lead",
      agentNames: ["lead"],
      agentStreams: { lead: makeStream({ status: "working" as const }) },
    })

    useTeamStore.getState().connectStream() // connection A
    const onEventA = callbacksByCall[0].onEvent
    useTeamStore.getState().connectStream() // reconnect — aborts A, opens B (same session)

    // tool_call (unlike message/thinking) applies synchronously with no
    // coalescing timer, so this is observable without advancing fake timers.
    onEventA("tool_call", { agent: "lead", name: "web_search", tool_call_id: "tc-a" })

    expect(useTeamStore.getState().agentStreams.lead.currentBlocks).toHaveLength(0)
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
    useTeamStore.setState({
      sessionId: "session-1",
      leadName: "lead",
      agentNames: ["lead"],
      agentStreams: { lead: makeStream({ status: "working" as const }) },
    })

    useTeamStore.getState().connectStream()
    useTeamStore.getState().newSession()
    onEvent("message", { agent: "lead", text: "stale token" })
    onDone()

    const state = useTeamStore.getState()
    expect(state.sessionId).toBeNull()
    expect(state.isTeamWorking).toBe(false)
    expect(state.agentStreams.lead.currentBlocks).toHaveLength(0)
  })
})

// ── loadTeamStatus ────────────────────────────────────────────────────────────

describe("loadTeamStatus", () => {
  it("sets leadName from status response", async () => {
    await useTeamStore.getState().loadTeamStatus()
    expect(useTeamStore.getState().leadName).toBe("lead")
  })

  it("sets agentNames including lead and members before a session is active", async () => {
    await useTeamStore.getState().loadTeamStatus()
    expect(useTeamStore.getState().agentNames).toEqual(["lead", "worker"])
  })

  it("sets agentNames including lead and members when a session is active", async () => {
    useTeamStore.setState({ sessionId: "team-sid" })
    await useTeamStore.getState().loadTeamStatus()
    expect(useTeamStore.getState().agentNames).toEqual(["lead", "worker"])
  })

  it("tracks live agents from the status response", async () => {
    useTeamStore.setState({ sessionId: "team-sid" })
    await useTeamStore.getState().loadTeamStatus()
    expect(useTeamStore.getState().liveAgentNames).toEqual(["lead", "worker"])
  })

  it("marks historical members offline when they are absent from the live roster", async () => {
    useTeamStore.setState({
      agentNames: ["lead", "worker"],
      agentStreams: {
        lead: makeStream(),
        worker: makeStream({ status: "idle" }),
      },
    })
    mockTeamStatus.mockImplementation(() =>
      Promise.resolve({
        team: "team",
        lead: { name: "lead", model: "gpt-4", state: "idle" },
        members: [],
      })
    )

    await useTeamStore.getState().loadTeamStatus()

    expect(useTeamStore.getState().agentNames).toEqual(["lead", "worker"])
    expect(useTeamStore.getState().agentStreams.worker.status).toBe("offline")
  })

  it("creates agent streams for all agents before a session is active", async () => {
    await useTeamStore.getState().loadTeamStatus()
    const streams = useTeamStore.getState().agentStreams
    expect(streams["lead"]).toBeDefined()
    expect(streams["worker"]).toBeDefined()
  })

  it("creates agent streams for all agents when a session is active", async () => {
    useTeamStore.setState({ sessionId: "team-sid" })
    await useTeamStore.getState().loadTeamStatus()
    const streams = useTeamStore.getState().agentStreams
    expect(streams["lead"]).toBeDefined()
    expect(streams["worker"]).toBeDefined()
  })

  it("sets model on each agent stream before a session is active", async () => {
    await useTeamStore.getState().loadTeamStatus()
    expect(useTeamStore.getState().agentStreams["lead"].model).toBe("gpt-4")
    expect(useTeamStore.getState().agentStreams["worker"].model).toBe("claude-3")
  })

  it("sets model on each agent stream when a session is active", async () => {
    useTeamStore.setState({ sessionId: "team-sid" })
    await useTeamStore.getState().loadTeamStatus()
    expect(useTeamStore.getState().agentStreams["lead"].model).toBe("gpt-4")
    expect(useTeamStore.getState().agentStreams["worker"].model).toBe("claude-3")
  })

  it("sets activeAgent to first agent when none is set", async () => {
    await useTeamStore.getState().loadTeamStatus()
    expect(useTeamStore.getState().activeAgent).toBe("lead")
  })

  it("does not override activeAgent if already set", async () => {
    useTeamStore.setState({ activeAgent: "worker" })
    await useTeamStore.getState().loadTeamStatus()
    expect(useTeamStore.getState().activeAgent).toBe("worker")
  })

  it("does not overwrite existing agent stream data", async () => {
    useTeamStore.setState({
      agentStreams: {
        lead: makeStream({
          blocks: [{ id: "b1", type: "text" as const, content: "existing" }],
        }),
      },
    })
    await useTeamStore.getState().loadTeamStatus()
    // Existing blocks preserved — only model is updated
    expect(useTeamStore.getState().agentStreams["lead"].blocks).toHaveLength(1)
  })

  it("does not revive an offline historical member when session history reloads", async () => {
    useTeamStore.setState({
      agentStreams: {
        worker: makeStream({ status: "offline" }),
      },
    })
    mockTeamHistory.mockImplementation(() =>
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

    await useTeamStore.getState().loadSession("sess-1")

    expect(useTeamStore.getState().agentStreams.worker.status).toBe("offline")
  })

  it("keeps historical members absent from the live roster offline when history reloads", async () => {
    useTeamStore.setState({
      liveAgentNames: ["lead"],
      agentStreams: {
        worker: makeStream({ status: "idle" }),
      },
    })
    mockTeamHistory.mockImplementation(() =>
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

    await useTeamStore.getState().loadSession("sess-1")

    expect(useTeamStore.getState().agentStreams.worker.status).toBe("offline")
  })

  it("sets error when teamStatus throws", async () => {
    mockTeamStatus.mockImplementation(() =>
      Promise.reject(new Error("Status unavailable"))
    )
    await useTeamStore.getState().loadTeamStatus()
    expect(useTeamStore.getState().error).toBe("Status unavailable")
  })

  it("sets fallback error for non-Error throws", async () => {
    mockTeamStatus.mockImplementation(() => Promise.reject("unknown"))
    await useTeamStore.getState().loadTeamStatus()
    expect(useTeamStore.getState().error).toBe("Failed to load team status")
  })

  it("does nothing when teamStatus returns null", async () => {
    mockTeamStatus.mockImplementation(() => Promise.resolve(null))
    await useTeamStore.getState().loadTeamStatus()
    // No state changes — agentNames stays empty
    expect(useTeamStore.getState().agentNames).toHaveLength(0)
    expect(useTeamStore.getState().leadName).toBeNull()
  })
})

// ── loadSession ───────────────────────────────────────────────────────────────

describe("loadSession", () => {
  it("renders history without waiting for team status", async () => {
    let resolveStatus!: (value: unknown) => void
    mockTeamStatus.mockImplementation(() => new Promise((resolve) => { resolveStatus = resolve }))
    mockTeamHistory.mockImplementation(() =>
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
    const loadPromise = useTeamStore.getState().loadSession("sess-1").then(() => {
      loadResolved = true
    })
    // Drain microtasks until `loadSession` resolves (bounded so a real
    // regression — it waiting on `resolveStatus` below — still fails fast
    // instead of hanging). The exact hop count is an implementation detail
    // of the in-flight coalescing wrapper (see `loadSession`), not something
    // this test should hard-code.
    for (let i = 0; i < 10 && !loadResolved; i++) await Promise.resolve()

    expect(loadResolved).toBe(true)
    expect(useTeamStore.getState().agentStreams.lead.blocks[0]?.content).toBe("loaded history")

    resolveStatus(null)
    await loadPromise
  })

  it("keeps model settings changed while history is loading", async () => {
    let resolveHistory!: (value: unknown) => void
    mockTeamHistory.mockImplementation(
      () => new Promise((resolve) => { resolveHistory = resolve })
    )

    const loadPromise = useTeamStore.getState().loadSession("settings-race")
    useTeamStore.getState().setSessionModelSettings("anthropic:claude-sonnet", "high")

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

    expect(useTeamStore.getState().sessionModel).toBe("anthropic:claude-sonnet")
    expect(useTeamStore.getState().sessionThinkingLevel).toBe("high")
  })

  it("sets sessionId from the argument", async () => {
    await useTeamStore.getState().loadSession("my-team-session")
    expect(useTeamStore.getState().sessionId).toBe("my-team-session")
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
    mockTeamHistory.mockImplementation(
      () => new Promise((resolve) => { resolveHistory = resolve })
    )

    const callsBefore = mockTeamHistory.mock.calls.length
    const first = useTeamStore.getState().loadSession("race-sess")
    const second = useTeamStore.getState().loadSession("race-sess")

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

    expect(mockTeamHistory.mock.calls.length - callsBefore).toBe(1)
    expect(useTeamStore.getState().agentStreams.lead.blocks).toHaveLength(1)
  })

  it("sets leadName from history response", async () => {
    await useTeamStore.getState().loadSession("sess-1")
    expect(useTeamStore.getState().leadName).toBe("lead")
  })

  it("restores Codex fast mode from the latest user message", async () => {
    mockTeamHistory.mockImplementation(() =>
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

    await useTeamStore.getState().loadSession("sess-1")

    expect(useTeamStore.getState().sessionFastMode).toBe(true)
  })

  it("falls back to live lead when history has no agent_name", async () => {
    mockTeamHistory.mockImplementation(() =>
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

    await useTeamStore.getState().loadSession("sess-1")
    await Promise.resolve()

    expect(useTeamStore.getState().leadName).toBe("lead")
    expect(useTeamStore.getState().activeAgent).toBe("lead")
    expect(useTeamStore.getState().agentNames[0]).toBe("lead")
    expect(useTeamStore.getState().agentStreams.lead).toBeDefined()
  })

  it("populates agentNames with lead and members", async () => {
    mockTeamHistory.mockImplementation(() =>
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
    await useTeamStore.getState().loadSession("sess-1")
    expect(useTeamStore.getState().agentNames).toEqual(["lead", "worker"])
  })

  it("creates agent streams for lead and members", async () => {
    mockTeamHistory.mockImplementation(() =>
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
    await useTeamStore.getState().loadSession("sess-1")
    expect(useTeamStore.getState().agentStreams["lead"]).toBeDefined()
    expect(useTeamStore.getState().agentStreams["worker"]).toBeDefined()
  })

  it("populates lead blocks from history messages", async () => {
    mockTeamHistory.mockImplementation(() =>
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
    await useTeamStore.getState().loadSession("sess-1")
    const leadBlocks = useTeamStore.getState().agentStreams["lead"].blocks
    expect(leadBlocks).toHaveLength(1)
    expect(leadBlocks[0].type).toBe("user")
    expect(leadBlocks[0].content).toBe("user msg")
  })

  it("loads queued history messages into the pending queue without rendering them as history blocks", async () => {
    mockTeamHistory.mockImplementationOnce(() =>
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

    await useTeamStore.getState().loadSession("sess-1")

    expect(useTeamStore.getState()._pendingMessages).toEqual([
      { id: "q1", sessionId: "sess-1", content: "queued", submittedAt: 1704067200000, attachments: undefined },
    ])
    expect(useTeamStore.getState().agentStreams.lead.blocks.map((block) => block.content)).toEqual(["response"])
  })

  it("keeps attachments on queued history messages loaded into the pending queue", async () => {
    const attachments = [
      { original_name: "doc.txt", media_type: "text/plain", category: "text" as const, url: "/api/team/sess-1/uploads/doc.txt" },
    ]
    mockTeamHistory.mockImplementationOnce(() =>
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

    await useTeamStore.getState().loadSession("sess-1")

    expect(useTeamStore.getState()._pendingMessages[0].attachments).toEqual(attachments)
  })

  it("clears currentBlocks for lead after loading", async () => {
    useTeamStore.setState({
      agentStreams: {
        lead: makeStream({
          currentBlocks: [{ id: "live", type: "text" as const, content: "live" }],
        }),
      },
    })
    await useTeamStore.getState().loadSession("sess-1")
    expect(useTeamStore.getState().agentStreams["lead"].currentBlocks).toHaveLength(0)
  })

  it("marks the lead working when loaded session detail is still running", async () => {
    mockTeamHistory.mockImplementation(() =>
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

    await useTeamStore.getState().loadSession("sess-1")

    expect(useTeamStore.getState().isTeamWorking).toBe(true)
    expect(useTeamStore.getState().agentStreams.lead.status).toBe("working")
  })

  it("sets activeAgent to lead when no activeAgent is set", async () => {
    await useTeamStore.getState().loadSession("sess-1")
    expect(useTeamStore.getState().activeAgent).toBe("lead")
  })

  it("clears reverted state from previous session when loading another", async () => {
    // Regression: revertedCount/revertedMessages are keyed by agent name in
    // agentStreams, so without an explicit reset session A's "N messages
    // reverted" banner leaks into session B when both share a lead.
    useTeamStore.setState({
      agentStreams: {
        lead: makeStream({
          revertedCount: 3,
          revertedMessages: [{ role: "user", content: "leak" }],
        }),
      },
    })
    await useTeamStore.getState().loadSession("sess-1")
    const stream = useTeamStore.getState().agentStreams["lead"]
    expect(stream.revertedCount).toBe(0)
    expect(stream.revertedMessages).toEqual([])
  })

  it("sets error when teamHistory throws", async () => {
    mockTeamHistory.mockImplementation(() =>
      Promise.reject(new Error("History unavailable"))
    )
    await useTeamStore.getState().loadSession("sess-1")
    expect(useTeamStore.getState().error).toBe("History unavailable")
  })

  it("sets fallback error for non-Error throws", async () => {
    mockTeamHistory.mockImplementation(() => Promise.reject("timeout"))
    await useTeamStore.getState().loadSession("sess-1")
    expect(useTeamStore.getState().error).toBe("Failed to load session")
  })

  it("discards result when _sessionGeneration changes (stale load)", async () => {
    // Arrange: delay teamHistory so we can bump generation mid-flight
    let resolveHistory!: (v: unknown) => void
    mockTeamHistory.mockImplementation(
      () => new Promise((res) => { resolveHistory = res })
    )

    const loadPromise = useTeamStore.getState().loadSession("sess-1")

    // Bump generation — simulates newSession() called while load was in-flight
    useTeamStore.getState().newSession()

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
    expect(useTeamStore.getState().leadName).toBeNull()
  })

  it("discards error when _sessionGeneration changes (stale error)", async () => {
    let rejectHistory!: (e: Error) => void
    mockTeamHistory.mockImplementation(
      () => new Promise((_, rej) => { rejectHistory = rej })
    )

    const loadPromise = useTeamStore.getState().loadSession("sess-1")

    // Bump generation
    useTeamStore.getState().newSession()

    rejectHistory(new Error("stale error"))
    await loadPromise

    // Stale error discarded
    expect(useTeamStore.getState().error).toBeNull()
  })

  it("preserves SSE events dispatched AFTER loadSession resolves (reload mid-stream)", async () => {
    // Regression: on page reload mid-turn, TeamChatView awaits loadSession
    // BEFORE opening the SSE stream so the DB reset of currentBlocks cannot
    // race the replay of buffered thinking/message events.
    //
    // If a caller still fires SSE events while loadSession is inflight (the
    // old bug), those events land in currentBlocks and get wiped by the
    // `currentBlocks = []` assignment inside loadSession. The fixed flow
    // guarantees ordering via await — so any subsequent replayed events
    // must survive and flow through to the UI.
    let resolveHistory!: (v: unknown) => void
    mockTeamHistory.mockImplementation(
      () => new Promise((res) => { resolveHistory = res })
    )

    const loadPromise = useTeamStore.getState().loadSession("sess-1")

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
    // fixed mount effect in TeamChatView.
    useTeamStore.getState()._handleSSEEvent("agent_status", {
      agent: "lead",
      status: "working",
    })
    useTeamStore.getState()._handleSSEEvent("message", {
      agent: "lead",
      text: "replayed token stream",
    })

    const state = useTeamStore.getState()
    expect(state.isTeamWorking).toBe(true)
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

    useTeamStore.setState({
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

    await useTeamStore.getState().loadSession("sess-1")

    expect(revokedUrls).toContain("blob:http://localhost/old-img")
    URL.revokeObjectURL = originalRevoke
  })

  // ── Regression: session-switch streaming indicator persists ───────────────
  // Bug: switching from a streaming session A to an idle session B left
  // isTeamWorking=true and agent status="working", causing "..." to render
  // indefinitely in session B.

  it("resets isTeamWorking to false when loading a session while another was streaming", async () => {
    // Simulate session A mid-stream
    useTeamStore.setState({
      sessionId: "session-a",
      isTeamWorking: true,
      agentStreams: {
        lead: makeStream({ status: "working" as const }),
      },
    })

    // User switches to session B
    await useTeamStore.getState().loadSession("session-b")

    expect(useTeamStore.getState().isTeamWorking).toBe(false)
  })

  it("resets lead agent status to idle when switching away from streaming session", async () => {
    useTeamStore.setState({
      isTeamWorking: true,
      agentStreams: {
        lead: makeStream({ status: "working" as const }),
      },
    })

    await useTeamStore.getState().loadSession("session-b")

    expect(useTeamStore.getState().agentStreams["lead"].status).toBe("idle")
  })

  it("resets member agent status to idle when switching away from streaming session", async () => {
    mockTeamHistory.mockImplementation(() =>
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
    useTeamStore.setState({
      isTeamWorking: true,
      agentStreams: {
        lead: makeStream({ status: "working" as const }),
        worker: makeStream({ status: "working" as const }),
      },
    })

    await useTeamStore.getState().loadSession("session-b")

    expect(useTeamStore.getState().agentStreams["worker"].status).toBe("idle")
  })

  it("clears currentText scratch buffer when switching sessions mid-stream", async () => {
    useTeamStore.setState({
      isTeamWorking: true,
      agentStreams: {
        lead: makeStream({
          status: "working" as const,
          currentText: "partial response...",
        }),
      },
    })

    await useTeamStore.getState().loadSession("session-b")

    expect(useTeamStore.getState().agentStreams["lead"].currentText).toBe("")
  })

  it("clears currentThinking scratch buffer when switching sessions mid-stream", async () => {
    useTeamStore.setState({
      isTeamWorking: true,
      agentStreams: {
        lead: makeStream({
          status: "working" as const,
          currentThinking: "let me reason about...",
        }),
      },
    })

    await useTeamStore.getState().loadSession("session-b")

    expect(useTeamStore.getState().agentStreams["lead"].currentThinking).toBe("")
  })

  it("does not reset isTeamWorking on a stale (generation-gated) loadSession", async () => {
    // If the load is stale, the state mutation is skipped entirely —
    // isTeamWorking should remain whatever the current session set it to.
    let resolveHistory!: (v: unknown) => void
    mockTeamHistory.mockImplementation(
      () => new Promise((res) => { resolveHistory = res })
    )

    const loadPromise = useTeamStore.getState().loadSession("session-b")

    // Switch to a new session (bumps generation) — now the inflight load is stale
    useTeamStore.getState().newSession()
    // New session correctly resets isTeamWorking; don't override that
    expect(useTeamStore.getState().isTeamWorking).toBe(false)

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
    expect(useTeamStore.getState().leadName).toBeNull()
  })

  it("preserves a same-session optimistic user bubble from a concurrent send when loadSession resolves without it yet (regression: background reconciliation race)", async () => {
    // Reproduces the "message disappears mid-session, refresh fixes it" bug:
    // a background reconciliation (global 'session_turn_completed' event,
    // foreground resume, etc.) calls loadSession() for the *same* session
    // while the user concurrently sends a new message. If the fetch's
    // snapshot predates that new message, loadSession must not wipe the
    // freshly pushed optimistic user bubble out of currentBlocks — nothing
    // else will ever put it back until a manual refresh.
    useTeamStore.setState({
      sessionId: "sess-1",
      leadName: "lead",
      agentNames: ["lead"],
      agentStreams: { lead: makeStream() },
    })

    let resolveHistory!: (v: unknown) => void
    mockTeamHistory.mockImplementation(
      () => new Promise((res) => { resolveHistory = res })
    )
    // Never resolves within this test — only sendMessage's synchronous
    // optimistic push matters here, not its network round trip.
    mockPostTeamChat.mockImplementation(() => new Promise(() => {}))

    const loadPromise = useTeamStore.getState().loadSession("sess-1")

    // A new message is sent *while the background fetch above is in flight*.
    void useTeamStore.getState().sendMessage("second message")
    expect(
      useTeamStore.getState().agentStreams["lead"].currentBlocks.some(
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

    const stream = useTeamStore.getState().agentStreams["lead"]
    const allBlocks = [...stream.blocks, ...stream.currentBlocks]
    expect(allBlocks.some((b) => b.type === "user" && b.content === "second message")).toBe(true)
  })

  it("reconciles an optimistic user bubble already present in history without duplicating it during streaming", async () => {
    useTeamStore.setState({
      sessionId: "sess-1",
      leadName: "lead",
      agentNames: ["lead"],
      agentStreams: { lead: makeStream() },
    })
    mockPostTeamChat.mockImplementation(() =>
      Promise.resolve({ status: "accepted", session_id: "sess-1" }),
    )

    await useTeamStore.getState().sendMessage("only show me once")
    useTeamStore.getState()._handleSSEEvent("message", {
      agent: "lead",
      text: "partial response",
    })

    const optimisticUser = useTeamStore.getState().agentStreams.lead.currentBlocks.find(
      (block) => block.type === "user",
    )
    expect(optimisticUser?.timestamp).toBeDefined()

    mockTeamHistory.mockImplementation(() =>
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

    await useTeamStore.getState().loadSession("sess-1")

    const stream = useTeamStore.getState().agentStreams.lead
    const visibleUserBlocks = [...stream.blocks, ...stream.currentBlocks].filter(
      (block) => block.type === "user" && !block.extra?.from_agent,
    )
    expect(visibleUserBlocks).toHaveLength(1)
    expect(stream.currentBlocks.some((block) => block.type === "text" && block.content === "partial response")).toBe(true)
  })
})

// ── loadOlderMessages ─────────────────────────────────────────────────────────

describe("loadOlderMessages", () => {
  it("does nothing when hasMore is false", async () => {
    useTeamStore.setState({ sessionId: "sess-1", hasMore: false, nextCursor: "2024-01-01T00:00:00Z" })
    await useTeamStore.getState().loadOlderMessages()
    expect(mockTeamHistory).not.toHaveBeenCalled()
  })

  it("does nothing when nextCursor is null", async () => {
    useTeamStore.setState({ sessionId: "sess-1", hasMore: true, nextCursor: null })
    await useTeamStore.getState().loadOlderMessages()
    expect(mockTeamHistory).not.toHaveBeenCalled()
  })

  it("does nothing when sessionId is null", async () => {
    useTeamStore.setState({ sessionId: null, hasMore: true, nextCursor: "2024-01-01T00:00:00Z" })
    await useTeamStore.getState().loadOlderMessages()
    expect(mockTeamHistory).not.toHaveBeenCalled()
  })

  it("calls teamHistory with the current nextCursor", async () => {
    useTeamStore.setState({ sessionId: "sess-1", hasMore: true, nextCursor: "2024-01-01T00:00:00Z", leadName: "lead" })
    mockTeamHistory.mockImplementation(() =>
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
    await useTeamStore.getState().loadOlderMessages()
    expect(mockTeamHistory).toHaveBeenCalledWith("sess-1", "2024-01-01T00:00:00Z")
  })

  it("updates hasMore and nextCursor from the response", async () => {
    useTeamStore.setState({ sessionId: "sess-1", hasMore: true, nextCursor: "2024-02-01T00:00:00Z", leadName: "lead" })
    mockTeamHistory.mockImplementation(() =>
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
    await useTeamStore.getState().loadOlderMessages()
    expect(useTeamStore.getState().hasMore).toBe(true)
    expect(useTeamStore.getState().nextCursor).toBe("2024-01-01T00:00:00Z")
  })

  it("prepends older blocks to lead stream", async () => {
    useTeamStore.setState({
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
    mockTeamHistory.mockImplementation(() =>
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
    await useTeamStore.getState().loadOlderMessages()
    const blocks = useTeamStore.getState().agentStreams["lead"].blocks
    expect(blocks).toHaveLength(2)
    expect(blocks[0].content).toBe("older")
    expect(blocks[1].content).toBe("newer")
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
    useTeamStore.setState({
      sessionId: "session-a",
      leadName: "lead",
      isTeamWorking: false,
      _leadRevertTime: revertTime,
      agentStreams: {
        lead: makeStream({ status: "idle" as const }),
      },
      _pendingMessages: [
        { id: "pm-1", sessionId: "session-a", content: "undone message", submittedAt: revertTime },
      ],
    })

    useTeamStore.getState()._handleSSEEvent("queued_turn_start", { agent: "lead", message_ids: ["pm-1"] })

    const blocks = useTeamStore.getState().agentStreams.lead.currentBlocks
    // The reverted user block must NOT appear
    expect(blocks.filter((b) => b.type === "user")).toHaveLength(0)
  })

  it("keeps user blocks that are strictly before the revert boundary", () => {
    const revertTime = 2000
    useTeamStore.setState({
      sessionId: "session-a",
      leadName: "lead",
      isTeamWorking: false,
      _leadRevertTime: revertTime,
      agentStreams: {
        lead: makeStream({ status: "idle" as const }),
      },
      _pendingMessages: [
        { id: "pm-1", sessionId: "session-a", content: "safe message", submittedAt: 1000 },
        { id: "pm-2", sessionId: "session-a", content: "reverted message", submittedAt: 2000 },
      ],
    })

    useTeamStore.getState()._handleSSEEvent("queued_turn_start", { agent: "lead" })

    const userBlocks = useTeamStore.getState().agentStreams.lead.currentBlocks.filter((b) => b.type === "user")
    expect(userBlocks).toHaveLength(1)
    expect(userBlocks[0].content).toBe("safe message")
  })

  it("allows all user blocks when no revert boundary is active", () => {
    useTeamStore.setState({
      sessionId: "session-a",
      leadName: "lead",
      isTeamWorking: false,
      _leadRevertTime: null,
      agentStreams: {
        lead: makeStream({ status: "idle" as const }),
      },
      _pendingMessages: [
        { id: "pm-1", sessionId: "session-a", content: "hello", submittedAt: 1000 },
      ],
    })

    useTeamStore.getState()._handleSSEEvent("queued_turn_start", { agent: "lead" })

    const userBlocks = useTeamStore.getState().agentStreams.lead.currentBlocks.filter((b) => b.type === "user")
    expect(userBlocks).toHaveLength(1)
    expect(userBlocks[0].content).toBe("hello")
  })
})

describe("ghost message regression: done event after /undo", () => {
  it("does not commit reverted blocks from currentBlocks when done fires", () => {
    const revertTime = new Date("2024-01-01T00:00:02Z").getTime()
    useTeamStore.setState({
      sessionId: "session-a",
      leadName: "lead",
      isTeamWorking: true,
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

    useTeamStore.getState()._handleSSEEvent("done", {})

    const blocks = useTeamStore.getState().agentStreams.lead.blocks
    // Only "kept" should survive — the reverted user block and its
    // assistant response are both at/after the boundary.
    expect(blocks.map((b) => b.id)).toEqual(["u1"])
    expect(useTeamStore.getState().agentStreams.lead.currentBlocks).toEqual([])
  })

  it("commits blocks before the revert boundary and drops those at/after", () => {
    const revertTime = new Date("2024-01-01T00:00:02Z").getTime()
    useTeamStore.setState({
      sessionId: "session-a",
      leadName: "lead",
      isTeamWorking: true,
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

    useTeamStore.getState()._handleSSEEvent("done", {})

    const blocks = useTeamStore.getState().agentStreams.lead.blocks
    expect(blocks.map((b) => b.id)).toEqual(["u1", "a1"])
  })

  it("commits all blocks normally when no revert boundary is set", () => {
    useTeamStore.setState({
      sessionId: "session-a",
      leadName: "lead",
      isTeamWorking: true,
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

    useTeamStore.getState()._handleSSEEvent("done", {})

    const blocks = useTeamStore.getState().agentStreams.lead.blocks
    expect(blocks.map((b) => b.id)).toEqual(["u1", "a1"])
  })
})
