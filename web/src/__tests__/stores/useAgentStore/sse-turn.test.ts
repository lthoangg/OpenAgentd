/**
 * Where a turn starts and ends on the stream: `queued_turn_start` and `done`.
 *
 * Mocks the API client through ./async-fixture; see there for why.
 */
import { describe, it, expect, beforeEach, mock } from "bun:test"
import { mockSendDesktopNotification, makeStream, resetAsyncStore } from "./async-fixture"
import { useAgentStore } from "@/stores/useAgentStore"
import { runOf, isRunLive } from '@/stores/useAgentStore/run-state'

beforeEach(resetAsyncStore)

describe("queued_turn_start: the steers a turn takes in", () => {
  // Queued messages always carry a server id (the POST returns it and
  // ``queued_turn_start`` lists it), so a steer is matched by id. Matching by
  // text dropped any steer the session had already said once: "yes",
  // "continue".
  it("splices a steer into the turn even when an earlier message had the same text", () => {
    useAgentStore.setState({
      sessionId: "session-a",
      leadName: "lead",
      agentStreams: {
        lead: makeStream({
          status: "working" as const,
          blocks: [{ id: "srv-yes-1", type: "user", content: "yes" }, { id: "a-1", type: "text", content: "ok" }],
        }),
      },
      _pendingMessages: [{ id: "srv-yes-2", sessionId: "session-a", content: "yes", submittedAt: Date.now() }],
    })

    useAgentStore.getState()._handleSSEEvent("queued_turn_start", {
      agent: "lead",
      message_ids: ["srv-yes-2"],
      messages: [{ id: "srv-yes-2", content: "yes" }],
    })

    const lead = useAgentStore.getState().agentStreams.lead
    expect(lead.currentBlocks.filter((b) => b.type === "user").map((b) => b.id)).toEqual(["srv-yes-2"])
    expect(useAgentStore.getState()._pendingMessages).toHaveLength(0)
  })

  it("keeps a second identical steer queued when only the first is read", () => {
    useAgentStore.setState({
      sessionId: "session-a",
      leadName: "lead",
      agentStreams: { lead: makeStream({ status: "working" as const }) },
      _pendingMessages: [
        { id: "q-1", sessionId: "session-a", content: "yes", submittedAt: 1 },
        { id: "q-2", sessionId: "session-a", content: "yes", submittedAt: 2 },
      ],
    })

    useAgentStore.getState()._handleSSEEvent("queued_turn_start", {
      agent: "lead",
      message_ids: ["q-1"],
      messages: [{ id: "q-1", content: "yes" }],
    })

    expect(useAgentStore.getState()._pendingMessages.map((m) => m.id)).toEqual(["q-2"])
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
    expect(isRunLive(useAgentStore.getState().sessionRun)).toBe(true)
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
      sessionRun: runOf(false),
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
    expect(isRunLive(state.sessionRun)).toBe(true)
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
    expect(isRunLive(useAgentStore.getState().sessionRun)).toBe(true)
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
    expect(isRunLive(state.sessionRun)).toBe(true)
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

  // A steer's image: the queued chip has no URL, so the bubble needs the
  // server's. Without it the thumbnail and the viewer stayed blank until a
  // reload.
  it("gives a spliced queued message the server's attachment URLs", () => {
    useAgentStore.setState({
      sessionId: "session-a",
      leadName: "lead",
      agentStreams: { lead: makeStream({ status: "working" as const }) },
      _pendingMessages: [
        {
          id: "pm-img",
          sessionId: "session-a",
          content: "look",
          attachments: [{ original_name: "shot.png", media_type: "image/png", category: "image" }],
        },
      ],
    })

    useAgentStore.getState()._handleSSEEvent("queued_turn_start", {
      agent: "lead",
      message_ids: ["pm-img", "pm-other"],
      messages: [
        {
          id: "pm-img",
          content: "look",
          extra: {
            model: "m",
            attachments: [{
              filename: "shot.png",
              path: "/ws/uploads/shot.png",
              original_name: "shot.png",
              media_type: "image/png",
              category: "image",
              url: "/api/agent/session-a/uploads/shot.png",
            }],
          },
        },
        {
          id: "pm-other",
          content: "from another client",
          extra: { attachments: [{ original_name: "b.png", category: "image", url: "/api/agent/session-a/uploads/b.png" }] },
        },
      ],
    })

    const blocks = useAgentStore.getState().agentStreams.lead.currentBlocks
    expect(blocks.map((b) => b.attachments?.[0]?.url)).toEqual([
      "/api/agent/session-a/uploads/shot.png",
      "/api/agent/session-a/uploads/b.png",
    ])
    // Display shape only, as history serves it.
    expect(blocks[0].attachments?.[0]).not.toHaveProperty("path")
    expect(blocks[0].extra).toEqual({ model: "m" })
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
})

describe("done: notifications", () => {
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

  it("does not notify directly from done because backend owns completion notifications", () => {
    useAgentStore.setState({
      sessionId: "session-a",
      leadName: "lead",
      agentStreams: {
        lead: makeStream({ status: "working" as const }),
      },
      sessionRun: runOf(true),
    })

    useAgentStore.getState()._handleSSEEvent("done", {})

    expect(mockSendDesktopNotification).not.toHaveBeenCalled()
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
      sessionRun: runOf(false),
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
      sessionRun: runOf(false),
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
      sessionRun: runOf(false),
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
      sessionRun: runOf(true),
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
      sessionRun: runOf(true),
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
      sessionRun: runOf(true),
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
      sessionRun: runOf(true),
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
      sessionRun: runOf(true),
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
})
