/**
 * Loading a session's newest history page.
 *
 * Mocks the API client through ./async-fixture; see there for why.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test"
import { mockPostAgentChat, mockTeamStream, mockAgentStatus, mockSessionHistory, makeStream, makeMessageResponse, resetAsyncStore } from "./async-fixture"
import { useAgentStore } from "@/stores/useAgentStore"
import { useToastStore } from "@/stores/useToastStore"
import { runOf, isRunLive } from '@/stores/useAgentStore/run-state'

beforeEach(resetAsyncStore)

// ── loadSession ───────────────────────────────────────────────────────────────

describe("loadSession", () => {
  it("pins the latest prompt when the first page starts after it", async () => {
    mockSessionHistory.mockImplementation(() =>
      Promise.resolve({
        lead: { id: "lead-sess", agent_name: "lead", title: null, created_at: null, updated_at: null, sub_sessions: [], messages: [makeMessageResponse({ id: "a9", role: "assistant", content: "step 900" })] },
        members: [],
        has_more: true,
        next_cursor: "c1",
        latest_prompt: makeMessageResponse({ id: "p1", role: "user", content: "keep going" }),
      })
    )

    await useAgentStore.getState().loadSession("sess-1")

    const pinned = useAgentStore.getState().pinnedPrompt
    expect(pinned).toMatchObject({ id: "p1", type: "user", content: "keep going" })
    expect(useAgentStore.getState().agentStreams.lead.blocks.map((b) => b.content)).toEqual(["step 900"])
  })

  it("drops a pin the new page no longer needs", async () => {
    useAgentStore.setState({ pinnedPrompt: { id: "p0", type: "user", content: "old" } })

    await useAgentStore.getState().loadSession("sess-1")

    expect(useAgentStore.getState().pinnedPrompt).toBeNull()
  })

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
            { id: "u1", role: "user", content: "hi", reasoning_content: null, tool_calls: null, tool_call_id: null, name: null, extra: { service_tier: "fast" }, created_at: null, attachments: null },
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

  // A member's report (or another workspace's reply) is queued for the lead,
  // not written by the user: it is no steer to show, edit, or call off.
  it("leaves queued agent reports out of the pending queue and keeps a workspace prompt's sender", async () => {
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
            makeMessageResponse({ id: "report", role: "user", content: "[Report from explorer#1]: done", kind: "queued", extra: { queue_status: "queued", from_agent: "explorer#1" } }),
            makeMessageResponse({ id: "routed", role: "user", content: "old format", kind: "queued", extra: { queue_status: "queued", routing: { from_agents: ["worker"] } } }),
            makeMessageResponse({ id: "prompt", role: "user", content: "please look", kind: "queued", extra: { queue_status: "queued", sent_from: { workspace_name: "api", workspace: "/api", session_id: "s-api" } } }),
            makeMessageResponse({ id: "held", role: "user", content: "then deploy", kind: "queued", extra: { queue_status: "queued", hold_until_turn_end: true, sent_from: { workspace_name: "api", workspace: "/api", session_id: "s-api" } } }),
            makeMessageResponse({ id: "steer", role: "user", content: "my steer", kind: "queued", extra: { queue_status: "queued" } }),
          ],
        },
        members: [],
        has_more: false,
        next_cursor: null,
      })
    )

    await useAgentStore.getState().loadSession("sess-1")

    const pending = useAgentStore.getState()._pendingMessages
    expect(pending.map((msg) => msg.id)).toEqual(["prompt", "held", "steer"])
    expect(pending[0].sentFromWorkspace).toBe("api")
    expect(pending[0].sentFromSession).toEqual({ sessionId: "s-api", workspace: "/api" })
    expect(pending[2].sentFromSession).toBeUndefined()
    expect(pending.map((msg) => msg.heldUntilTurnEnd)).toEqual([undefined, true, undefined])
  })

  it("shows a queued report the lead reads as that agent's report, not as the user's message", async () => {
    mockSessionHistory.mockImplementationOnce(() =>
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
            makeMessageResponse({ id: "report", role: "user", content: "[Report from explorer#1]: done", kind: "queued", extra: { queue_status: "queued", from_agent: "explorer#1" } }),
          ],
        },
        members: [],
        has_more: false,
        next_cursor: null,
      })
    )
    await useAgentStore.getState().loadSession("sess-1")

    useAgentStore.getState()._handleSSEEvent("queued_turn_start", {
      agent: "lead",
      message_ids: ["report"],
      messages: [{ id: "report", content: "[Report from explorer#1]: done", extra: { from_agent: "explorer#1" } }],
    })

    const block = useAgentStore.getState().agentStreams.lead.currentBlocks.find((b) => b.id === "report")
    expect(block?.extra?.from_agent).toBe("explorer#1")
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

    expect(isRunLive(useAgentStore.getState().sessionRun)).toBe(true)
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

  it("stays quiet when sessionHistory fails for a dropped connection", async () => {
    mockSessionHistory.mockImplementation(() => Promise.reject(new TypeError("Load failed")))
    await useAgentStore.getState().loadSession("sess-1")
    expect(useAgentStore.getState().error).toBeNull()
    expect(useAgentStore.getState().isLoadingHistory).toBe(false)
  })

  it("sets fallback error for non-Error throws", async () => {
    mockSessionHistory.mockImplementation(() => Promise.reject("timeout"))
    await useAgentStore.getState().loadSession("sess-1")
    expect(useAgentStore.getState().error).toBe("Couldn't load session")
  })

  // Coming back to the phone app: the real store and the real toast store,
  // with only the network answers faked.
  describe("returning to the app while the connection comes back", () => {
    const toasts = () => useToastStore.getState().toasts
    const history = (messages: unknown[] = [], running = false) => ({
      lead: { id: "lead-sess", agent_name: "lead", title: null, created_at: null, updated_at: null, sub_sessions: [], messages, running },
      members: [],
      has_more: false,
      next_cursor: null,
    })
    const reply = { id: "m1", role: "assistant", content: "done while away", created_at: "2026-01-01T00:00:00Z" }
    beforeEach(() => useToastStore.setState({ toasts: [] }))
    afterEach(() => useToastStore.setState({ toasts: [] }))

    it("shows no toast for a running turn, and catches up once the connection is back", async () => {
      useAgentStore.setState({ sessionId: "sess-1", sessionRun: runOf(true) })
      let callbacks!: { onError: (err: Error) => void }
      mockTeamStream.mockImplementation((_sid: string, cbs: typeof callbacks) => { callbacks = cbs })
      useAgentStore.getState().connectStream()

      // iOS drops the suspended stream in its own words.
      callbacks.onError(new TypeError("The network connection was lost."))
      // The reload on return goes out before the connection is back.
      mockSessionHistory.mockImplementation(() => Promise.reject(new TypeError("Load failed")))
      await useAgentStore.getState().loadSession("sess-1")
      mockAgentStatus.mockImplementation(() => Promise.reject(new TypeError("Could not connect to the server.")))
      await useAgentStore.getState().loadAgentStatus()
      expect(toasts()).toEqual([])
      expect(useAgentStore.getState().error).toBeNull()
      // Still a running turn, with a reconnect waiting.
      expect(isRunLive(useAgentStore.getState().sessionRun)).toBe(true)
      expect(useAgentStore.getState()._reconnectTimer).not.toBeNull()

      mockSessionHistory.mockImplementation(() => Promise.resolve(history([reply])))
      await useAgentStore.getState().loadSession("sess-1")
      const blocks = useAgentStore.getState().agentStreams.lead.blocks
      expect(blocks.map((b) => b.content)).toContain("done while away")
      expect(toasts()).toEqual([])
    })

    it("shows no toast for an idle chat, and catches up once the connection is back", async () => {
      useAgentStore.setState({ sessionId: "sess-1", sessionRun: runOf(false) })
      mockSessionHistory.mockImplementation(() => Promise.reject(new TypeError("Load failed")))
      await useAgentStore.getState().loadSession("sess-1")
      expect(toasts()).toEqual([])

      mockSessionHistory.mockImplementation(() => Promise.resolve(history([reply])))
      await useAgentStore.getState().loadSession("sess-1")
      expect(useAgentStore.getState().agentStreams.lead.blocks.map((b) => b.content)).toContain("done while away")
      expect(toasts()).toEqual([])
    })

    it("shows no toast while the phone's link to the computer is down", async () => {
      useAgentStore.setState({ sessionId: "sess-1" })
      // The bridge's 503: its own sentence as the message, the status beside it.
      const linkDown = Object.assign(new Error("the link did not come up in time"), { status: 503 })
      mockSessionHistory.mockImplementation(() => Promise.reject(linkDown))
      mockAgentStatus.mockImplementation(() => Promise.reject(linkDown))
      await useAgentStore.getState().loadSession("sess-1")
      await useAgentStore.getState().loadAgentStatus()
      expect(toasts()).toEqual([])
    })

    it("shows no toast with the server off, however often the reload is tried", async () => {
      useAgentStore.setState({ sessionId: "sess-1" })
      mockSessionHistory.mockImplementation(() => Promise.reject(new TypeError("Could not connect to the server.")))
      mockAgentStatus.mockImplementation(() => Promise.reject(new TypeError("Load failed")))
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await useAgentStore.getState().loadSession("sess-1")
        await useAgentStore.getState().loadAgentStatus()
      }
      expect(toasts()).toEqual([])
      expect(useAgentStore.getState().isLoadingHistory).toBe(false)
    })

    it("still reports a failure that is not about the connection", async () => {
      useAgentStore.setState({ sessionId: "sess-1" })
      mockSessionHistory.mockImplementation(() => Promise.reject(Object.assign(new Error("Internal error"), { status: 500 })))
      await useAgentStore.getState().loadSession("sess-1")
      expect(toasts().map((t) => t.description)).toEqual(["Internal error"])
    })

    it("names the server, not the provider, when the user's own action finds no connection", () => {
      useAgentStore.setState({ error: "Load failed" })
      expect(toasts().map((t) => t.title)).toEqual(["Can't reach the server"])
    })
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
    expect(isRunLive(state.sessionRun)).toBe(true)
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
      sessionRun: runOf(true),
      agentStreams: {
        lead: makeStream({ status: "working" as const }),
      },
    })

    // User switches to session B
    await useAgentStore.getState().loadSession("session-b")

    expect(isRunLive(useAgentStore.getState().sessionRun)).toBe(false)
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
      sessionRun: runOf(false),
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
      sessionRun: runOf(false),
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
      sessionRun: runOf(false),
      agentStreams: {},
    })

    await useAgentStore.getState().loadSession("sess-1")

    expect(useAgentStore.getState().agentStreams.lead.usage.estimatedCostUsd).toBe(1.0)
    expect(useAgentStore.getState().agentStreams.worker.usage.estimatedCostUsd).toBe(2.5)
    expect(useAgentStore.getState().agentStreams.worker.usage.completionTokens).toBe(2500)
  })

  it("resets lead agent status to idle when switching away from streaming session", async () => {
    useAgentStore.setState({
      sessionRun: runOf(true),
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
      sessionRun: runOf(true),
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
      sessionRun: runOf(true),
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
      sessionRun: runOf(true),
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
    expect(isRunLive(useAgentStore.getState().sessionRun)).toBe(false)

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
      sessionRun: runOf(true),
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
    expect(isRunLive(state.sessionRun)).toBe(true)
    expect(state.agentStreams.worker?.status).toBe("working")
  })
})
