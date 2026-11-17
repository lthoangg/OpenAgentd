/**
 * The open session: the agent roster, leaving a session, and adopting a resolved one.
 *
 * Mocks the API client through ./async-fixture; see there for why.
 */
import { describe, it, expect, beforeEach } from "bun:test"
import { mockPostAgentChat, mockAgentStatus, mockSessionHistory, makeStream, resetAsyncStore } from "./async-fixture"
import { useAgentStore } from "@/stores/useAgentStore"
import { isRunLive } from '@/stores/useAgentStore/run-state'

beforeEach(resetAsyncStore)

describe("newSession and beginResolvedSession", () => {
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

    expect(isRunLive(useAgentStore.getState().sessionRun)).toBe(true)
    const stream = useAgentStore.getState().agentStreams["lead"]
    expect(stream.currentBlocks.some((b) => b.type === "user" && b.content === "message to new session")).toBe(true)

    // Concurrent beginResolvedSession resolves for the background session creation
    useAgentStore.getState().beginResolvedSession("new-created-session", {
      workspace: "/repo/app",
      skipInitialRestore: true,
    })

    // Working state and optimistic block must be preserved
    expect(isRunLive(useAgentStore.getState().sessionRun)).toBe(true)
    expect(useAgentStore.getState().agentStreams["lead"].currentBlocks.some((b) => b.type === "user" && b.content === "message to new session")).toBe(true)

    // When postAgentChat finishes, sessionId is set correctly
    resolvePost({ session_id: "post-created-session" })
    await Promise.resolve()

    expect(useAgentStore.getState().sessionId).toBe("post-created-session")
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

  it("stays quiet when agentStatus fails for a dropped connection", async () => {
    mockAgentStatus.mockImplementation(() => Promise.reject(new TypeError("Load failed")))
    await useAgentStore.getState().loadAgentStatus()
    expect(useAgentStore.getState().error).toBeNull()
  })

  it("sets fallback error for non-Error throws", async () => {
    mockAgentStatus.mockImplementation(() => Promise.reject("unknown"))
    await useAgentStore.getState().loadAgentStatus()
    expect(useAgentStore.getState().error).toBe("Couldn't load agent status")
  })

  it("does nothing when agentStatus returns null", async () => {
    mockAgentStatus.mockImplementation(() => Promise.resolve(null))
    await useAgentStore.getState().loadAgentStatus()
    // No state changes — agentNames stays empty
    expect(useAgentStore.getState().agentNames).toHaveLength(0)
    expect(useAgentStore.getState().leadName).toBeNull()
  })

  it("asks for the session it is given, not the store's previous one", async () => {
    // Switching chats: the store still holds the old session while the new
    // workspace loads. Pairing them once started the old session there.
    useAgentStore.setState({ sessionId: "old-sid" })
    mockAgentStatus.mockClear()
    await useAgentStore.getState().loadAgentStatus("/ws-b", undefined, "new-sid")
    expect(mockAgentStatus).toHaveBeenLastCalledWith("/ws-b", "new-sid")
    await useAgentStore.getState().loadAgentStatus("/ws-b", undefined, null)
    expect(mockAgentStatus).toHaveBeenLastCalledWith("/ws-b", null)
    await useAgentStore.getState().loadAgentStatus("/ws-a")
    expect(mockAgentStatus).toHaveBeenLastCalledWith("/ws-a", "old-sid")
  })

  // The roster names the workspace's lead agent ("code"), never a subagent.
  // Applied to an open subagent session it repointed the view at an empty
  // "code" stream, so the subagent's transcript and live output vanished.
  it("keeps an open subagent session on its own agent", async () => {
    mockSessionHistory.mockImplementation(() =>
      Promise.resolve({
        lead: {
          id: "child-sid",
          agent_name: "worker#1",
          parent_session_id: "lead-sid",
          running: true,
          title: null,
          created_at: null,
          updated_at: null,
          sub_sessions: [],
          messages: [{ id: "m1", role: "user", content: "[Task from Lead]: run the build", created_at: "2026-10-24T15:00:00Z" }],
        },
        members: [],
        has_more: false,
        next_cursor: null,
      })
    )
    mockAgentStatus.mockImplementation(() =>
      Promise.resolve({ lead: { name: "code", model: "gpt-4", state: "idle" }, members: [] })
    )
    await useAgentStore.getState().loadSession("child-sid")
    expect(useAgentStore.getState().leadName).toBe("worker#1")

    await useAgentStore.getState().loadAgentStatus("/ws", undefined, "child-sid")

    const state = useAgentStore.getState()
    expect(state.leadName).toBe("worker#1")
    expect(state.agentStreams["worker#1"].blocks.length).toBeGreaterThan(0)
    expect(state.agentStreams["worker#1"].status).not.toBe("offline")
  })
})
