/**
 * useTeamStore — async method tests + uncovered SSE event handlers
 *
 * IMPORTANT: mock.module() MUST appear before any store import so Bun's module
 * registry intercepts the dependency before the store module is evaluated.
 * These tests therefore live in a separate file from the synchronous store tests.
 */

import { mock, describe, it, expect, beforeEach, spyOn } from "bun:test"

// ── Mock @/api/client BEFORE importing the store ──────────────────────────────
// NOTE: Bun mock types require explicit `any` assertions for compatibility

/* eslint-disable @typescript-eslint/no-explicit-any */
const mockPostTeamChat = mock(() =>
  Promise.resolve({ status: "ok", session_id: "team-sid" })
) as any
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
/* eslint-enable @typescript-eslint/no-explicit-any */

/* eslint-disable @typescript-eslint/no-explicit-any */
(mock as any).module("@/api/client", () => ({
  postTeamChat: mockPostTeamChat,
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
}))
/* eslint-enable @typescript-eslint/no-explicit-any */

// ── Store import (AFTER mock.module) ──────────────────────────────────────────

import { useTeamStore } from "@/stores/useTeamStore"
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
  isTeamWorking: false,
  isContinuing: false,
  isConnected: false,
  error: null,
  _pendingMessages: [] as import('@/stores/useTeamStore').PendingMessage[],
  _sessionGeneration: 0,
  hasMore: false,
  nextCursor: null,
  _leadRevertTime: null,
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
    _completionBase: 0,
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
  mockPostTeamCommand.mockReset()
  mockTeamStream.mockReset()
  mockTeamStatus.mockReset()
  mockTeamHistory.mockReset()

  // Restore sensible defaults
  mockPostTeamChat.mockImplementation(() =>
    Promise.resolve({ status: "ok", session_id: "team-sid" })
  )
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
  it("queues message without calling API when lead is working", async () => {
    useTeamStore.setState({
      leadName: "lead",
      agentStreams: { lead: makeStream({ status: "working" as const }) },
    })
    await useTeamStore.getState().sendMessage("queued message")
    expect(mockPostTeamChat).not.toHaveBeenCalled()
    const pending = useTeamStore.getState()._pendingMessages
    expect(pending).toHaveLength(1)
    expect(pending[0].content).toBe("queued message")
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

  it("drains all queued messages in one shot after 'done' event", async () => {
    useTeamStore.setState({
      leadName: "lead",
      agentStreams: {
        lead: makeStream({
          status: "working" as const,
          currentBlocks: [{ id: "b1", type: "text" as const, content: "response" }],
        }),
      },
      _pendingMessages: [
        { id: "pm-1", content: "first queued" },
        { id: "pm-2", content: "second queued" },
      ],
    })
    useTeamStore.getState()._handleSSEEvent("done", {})
    // Drain is async — wait one tick for sendMessage to run
    await new Promise((r) => setTimeout(r, 0))
    // All pending messages combined into a single postTeamChat call
    expect(mockPostTeamChat).toHaveBeenCalledTimes(1)
    expect(mockPostTeamChat.mock.calls[0][0]).toBe("first queued\n\nsecond queued")
    expect(useTeamStore.getState()._pendingMessages).toHaveLength(0)
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
})

// ── connectStream ─────────────────────────────────────────────────────────────

describe("connectStream", () => {
  it("calls teamStream with the current sessionId", () => {
    useTeamStore.setState({ sessionId: "stream-sid", isTeamWorking: true })
    useTeamStore.getState().connectStream()
    expect(mockTeamStream).toHaveBeenCalledTimes(1)
    expect(mockTeamStream.mock.calls[0][0]).toBe("stream-sid")
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

  it("onError sets error and isConnected=false", () => {
    mockTeamStream.mockImplementation(
      (_sid: string, cbs: { onError?: (e: Error) => void }) => {
        cbs.onError?.(new Error("stream error"))
      }
    )
    useTeamStore.setState({ sessionId: "stream-sid", isTeamWorking: true })
    useTeamStore.getState().connectStream()

    expect(useTeamStore.getState().error).toBe("stream error")
    expect(useTeamStore.getState().isConnected).toBe(false)
  })

  it("onDone sets isConnected=false", () => {
    mockTeamStream.mockImplementation(
      (_sid: string, cbs: { onDone?: () => void }) => {
        cbs.onDone?.()
      }
    )
    useTeamStore.setState({ sessionId: "stream-sid" })
    useTeamStore.getState().connectStream()

    expect(useTeamStore.getState().isConnected).toBe(false)
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

  it("sets agentNames to lead only before a session is active", async () => {
    await useTeamStore.getState().loadTeamStatus()
    expect(useTeamStore.getState().agentNames).toEqual(["lead"])
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

  it("creates agent streams for the lead before a session is active", async () => {
    await useTeamStore.getState().loadTeamStatus()
    const streams = useTeamStore.getState().agentStreams
    expect(streams["lead"]).toBeDefined()
    expect(streams["worker"]).toBeUndefined()
  })

  it("creates agent streams for all agents when a session is active", async () => {
    useTeamStore.setState({ sessionId: "team-sid" })
    await useTeamStore.getState().loadTeamStatus()
    const streams = useTeamStore.getState().agentStreams
    expect(streams["lead"]).toBeDefined()
    expect(streams["worker"]).toBeDefined()
  })

  it("sets model on the lead stream before a session is active", async () => {
    await useTeamStore.getState().loadTeamStatus()
    expect(useTeamStore.getState().agentStreams["lead"].model).toBe("gpt-4")
    expect(useTeamStore.getState().agentStreams["worker"]).toBeUndefined()
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
  it("sets sessionId from the argument", async () => {
    await useTeamStore.getState().loadSession("my-team-session")
    expect(useTeamStore.getState().sessionId).toBe("my-team-session")
  })

  it("sets leadName from history response", async () => {
    await useTeamStore.getState().loadSession("sess-1")
    expect(useTeamStore.getState().leadName).toBe("lead")
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
