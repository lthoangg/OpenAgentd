import { mock, describe, it, expect, beforeEach } from "bun:test"

/* eslint-disable @typescript-eslint/no-explicit-any */
const mockPostAgentChat = mock(() =>
  Promise.resolve({ status: "ok", session_id: "team-sid" })
) as any
const mockPostAgentCommand = mock(() =>
  Promise.resolve({ status: "accepted", session_id: "team-sid", command: "undo" })
) as any
const mockTeamStream = mock((_sid: any, _cbs: any, _signal?: any) => {}) as any
const mockAgentStatus = mock(() =>
  Promise.resolve({
    lead: { name: "lead", model: "gpt-4", state: "idle" },
    members: [],
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
/* eslint-enable @typescript-eslint/no-explicit-any */

/* eslint-disable @typescript-eslint/no-explicit-any */
;(mock as any).module("@/api/client", () => ({
  postAgentChat: mockPostAgentChat,
  postAgentCommand: mockPostAgentCommand,
  agentStream: mockTeamStream,
  agentStatus: mockAgentStatus,
  sessionHistory: mockSessionHistory,
  postChat: mock(() => Promise.resolve({ session_id: "chat-sid" })) as any,
  streamChat: mock(() => {}) as any,
  listAgents: mock(() => Promise.resolve({ agents: [] })) as any,
  listSessions: mock(() => Promise.resolve([])) as any,
  deleteSession: mock(() => Promise.resolve()) as any,
}))
/* eslint-enable @typescript-eslint/no-explicit-any */

import { useAgentStore } from "@/stores/useAgentStore"
import { applyRevertBoundary } from "@/stores/useAgentStore/helpers"
import type { AgentStream } from "@/stores/useAgentStore"
import type { ContentBlock } from "@/api/types"

function block(
  id: string,
  type: ContentBlock["type"],
  content: string,
  isoTime: string,
): ContentBlock {
  return { id, type, content, timestamp: new Date(isoTime) }
}

function makeStream(overrides: Partial<AgentStream> = {}): AgentStream {
  return {
    blocks: [],
    currentBlocks: [],
    currentText: "",
    currentThinking: "",
    status: "idle",
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 },
    model: null,
    lastError: null,
    revertedCount: 0,
    revertedMessages: [],
    _revertedSuffix: [],
    ...overrides,
  }
}

function makeMessageResponse(overrides: Record<string, unknown> = {}) {
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

const INITIAL_STATE = {
  agentStreams: {},
  leadName: null,
  agentNames: [],
  liveAgentNames: null,
  sidebarOpen: false,
  sessionId: null,
  sessionTitle: null,
  isAgentWorking: false,
  isContinuing: false,
  isConnected: false,
  error: null,
  setupRequired: null,
  _pendingMessages: [] as import("@/stores/useAgentStore").PendingMessage[],
  _sessionGeneration: 0,
  hasMore: false,
  nextCursor: null,
  _leadRevertTime: null,
  _workspace: null,
  _loadingOlder: false,
  cacheInvalidations: [],
}

beforeEach(() => {
  useAgentStore.setState(INITIAL_STATE)
  mockPostAgentChat.mockReset()
  mockPostAgentCommand.mockReset()
  mockTeamStream.mockReset()
  mockAgentStatus.mockReset()
  mockSessionHistory.mockReset()

  mockAgentStatus.mockImplementation(() =>
    Promise.resolve({
      lead: { name: "lead", model: "gpt-4", state: "idle" },
      members: [],
    }),
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
    }),
  )
  mockPostAgentCommand.mockImplementation(() =>
    Promise.resolve({ status: "accepted", session_id: "team-sid", command: "undo" }),
  )
  mockPostAgentChat.mockImplementation(() =>
    Promise.resolve({ status: "ok", session_id: "team-sid" }),
  )
})

describe("applyRevertBoundary", () => {
  it("is a no-op on an empty stream with null boundary", () => {
    const s = makeStream()
    applyRevertBoundary(s, null)
    expect(s.blocks).toEqual([])
    expect(s._revertedSuffix).toEqual([])
    expect(s.revertedCount).toBe(0)
  })

  it("splits blocks by timestamp — strictly-before-boundary stay visible", () => {
    const t1 = block("b1", "user", "first", "2024-01-01T00:00:00Z")
    const t2 = block("b2", "text", "answer one", "2024-01-01T00:00:01Z")
    const t3 = block("b3", "user", "second", "2024-01-01T00:00:02Z")
    const t4 = block("b4", "text", "answer two", "2024-01-01T00:00:03Z")
    const s = makeStream({ blocks: [t1, t2, t3, t4] })

    applyRevertBoundary(s, new Date("2024-01-01T00:00:02Z").getTime())

    expect(s.blocks.map((b) => b.id)).toEqual(["b1", "b2"])
    expect(s._revertedSuffix?.map((b) => b.id)).toEqual(["b3", "b4"])
  })

  it("treats blocks exactly at the boundary timestamp as reverted", () => {
    const boundaryIso = "2024-01-01T00:00:02Z"
    const same = block("b-at-boundary", "user", "boundary msg", boundaryIso)
    const s = makeStream({ blocks: [same] })
    applyRevertBoundary(s, new Date(boundaryIso).getTime())
    expect(s.blocks).toEqual([])
    expect(s._revertedSuffix).toHaveLength(1)
  })

  it("splits by boundaryId when boundaryTime is null and boundaryId exists in stream", () => {
    const t1 = block("b1", "user", "first", "2024-01-01T00:00:00Z")
    const t2 = block("b2", "user", "second", "2024-01-01T00:00:02Z")
    const t3 = block("b3", "text", "reply", "2024-01-01T00:00:03Z")
    const s = makeStream({ blocks: [t1, t2, t3] })

    applyRevertBoundary(s, null, { boundaryId: "b2" })
    expect(s.blocks.map((b) => b.id)).toEqual(["b1"])
    expect(s._revertedSuffix?.map((b) => b.id)).toEqual(["b2", "b3"])
  })

  it("reverts all loaded blocks when boundaryId is older than loaded messages and boundaryTime is null", () => {
    const t1 = block("b10", "user", "tenth", "2024-01-01T00:00:10Z")
    const t2 = block("b11", "text", "reply", "2024-01-01T00:00:11Z")
    const s = makeStream({ blocks: [t1, t2] })

    applyRevertBoundary(s, null, { boundaryId: "b1" })
    expect(s.blocks).toEqual([])
    expect(s._revertedSuffix?.map((b) => b.id)).toEqual(["b10", "b11"])
  })

  it("recombines blocks + suffix before splitting (idempotent across calls)", () => {
    const t1 = block("b1", "user", "u1", "2024-01-01T00:00:00Z")
    const t2 = block("b2", "user", "u2", "2024-01-01T00:00:02Z")
    const t3 = block("b3", "user", "u3", "2024-01-01T00:00:04Z")
    const s = makeStream({ blocks: [t1, t2, t3] })

    applyRevertBoundary(s, new Date("2024-01-01T00:00:02Z").getTime())
    expect(s.blocks.map((b) => b.id)).toEqual(["b1"])
    expect(s._revertedSuffix?.map((b) => b.id)).toEqual(["b2", "b3"])

    applyRevertBoundary(s, null)
    expect(s.blocks.map((b) => b.id)).toEqual(["b1", "b2", "b3"])
    expect(s._revertedSuffix).toEqual([])
  })

  it("counts user + compaction blocks toward revertedCount", () => {
    const s = makeStream({
      blocks: [
        block("u1", "user", "first", "2024-01-01T00:00:00Z"),
        block("a1", "text", "answer", "2024-01-01T00:00:01Z"),
        block("u2", "user", "second", "2024-01-01T00:00:02Z"),
        block("c1", "compaction", "summary", "2024-01-01T00:00:03Z"),
        block("u3", "user", "third", "2024-01-01T00:00:04Z"),
      ],
    })
    applyRevertBoundary(s, new Date("2024-01-01T00:00:02Z").getTime())
    expect(s.revertedCount).toBe(3)
  })

  // Regression: "/undo reverted more than one message". The backend targets
  // exactly one *direct* user message (``is_undo_target`` skips rows whose
  // ``extra.from_agent`` is another agent), so the notice must not count the
  // member→lead inbox rows that share the reverted suffix.
  it("excludes agent-origin user blocks from revertedCount and the preview", () => {
    const handoff = (
      id: string,
      content: string,
      isoTime: string,
      fromAgent: string,
    ): ContentBlock => ({
      ...block(id, "user", content, isoTime),
      extra: { from_agent: fromAgent },
    })

    const s = makeStream({
      blocks: [
        block("u1", "user", "first", "2024-01-01T00:00:00Z"),
        block("a1", "text", "answer", "2024-01-01T00:00:01Z"),
        block("u2", "user", "second", "2024-01-01T00:00:02Z"),
        handoff("h1", "[lead]: do the thing", "2024-01-01T00:00:03Z", "lead"),
        handoff("h2", "[worker]: done", "2024-01-01T00:00:04Z", "worker"),
        block("a2", "text", "wrap up", "2024-01-01T00:00:05Z"),
      ],
    })

    applyRevertBoundary(s, new Date("2024-01-01T00:00:02Z").getTime(), {
      boundaryId: "u2",
      boundaryContent: "second",
    })

    expect(s.blocks.map((b) => b.id)).toEqual(["u1", "a1"])
    expect(s._revertedSuffix?.map((b) => b.id)).toEqual(["u2", "h1", "h2", "a2"])
    expect(s.revertedCount).toBe(1)
    expect(s.revertedMessages).toEqual([{ role: "user", content: "second" }])
  })

  it("counts a user block whose from_agent is the user itself", () => {
    const s = makeStream({
      blocks: [
        block("u1", "user", "kept", "2024-01-01T00:00:00Z"),
        {
          ...block("u2", "user", "undone", "2024-01-01T00:00:02Z"),
          extra: { from_agent: "user" },
        },
      ],
    })

    applyRevertBoundary(s, new Date("2024-01-01T00:00:02Z").getTime())

    expect(s.revertedCount).toBe(1)
    expect(s.revertedMessages).toEqual([{ role: "user", content: "undone" }])
  })

  it("populates revertedMessages preview with content and compaction label", () => {
    const s = makeStream({
      blocks: [
        block("u1", "user", "kept", "2024-01-01T00:00:00Z"),
        block("u2", "user", "undone-1", "2024-01-01T00:00:02Z"),
        block("c1", "compaction", "ignored body", "2024-01-01T00:00:03Z"),
        block("u3", "user", "undone-2", "2024-01-01T00:00:04Z"),
      ],
    })
    applyRevertBoundary(s, new Date("2024-01-01T00:00:02Z").getTime())
    expect(s.revertedMessages).toEqual([
      { role: "user", content: "undone-1" },
      { role: "user", content: "Session compacted" },
      { role: "user", content: "undone-2" },
    ])
  })

  it("skips empty-content blocks from the preview", () => {
    const s = makeStream({
      blocks: [
        block("u1", "user", "kept", "2024-01-01T00:00:00Z"),
        block("u2", "user", "   ", "2024-01-01T00:00:02Z"),
        block("u3", "user", "real", "2024-01-01T00:00:04Z"),
      ],
    })
    applyRevertBoundary(s, new Date("2024-01-01T00:00:02Z").getTime())
    expect(s.revertedMessages).toEqual([{ role: "user", content: "real" }])
  })

  it("can include in-flight blocks and match the optimistic user by content", () => {
    const s = makeStream({
      blocks: [block("u1", "user", "first", "2024-01-01T00:00:00Z")],
      currentBlocks: [
        // Optimistic client timestamp can be earlier than the server-created
        // undo boundary, especially when the turn is stopped mid-response.
        block("u2", "user", "second", "2024-01-01T00:00:01Z"),
        block("partial", "text", "partial answer", "2024-01-01T00:00:01Z"),
      ],
    })

    applyRevertBoundary(s, new Date("2024-01-01T00:00:02Z").getTime(), {
      includeCurrent: true,
      boundaryContent: "second",
    })

    expect(s.blocks.map((b) => b.id)).toEqual(["u1"])
    expect(s.currentBlocks).toEqual([])
    expect(s._revertedSuffix?.map((b) => b.id)).toEqual(["u2", "partial"])
  })

  it("tightens a timestamp split when the optimistic user predates the boundary", () => {
    const s = makeStream({
      blocks: [
        block("u1", "user", "first", "2024-01-01T00:00:00Z"),
        block("u2", "user", "second", "2024-01-01T00:00:01Z"),
        block("tool", "tool", "", "2024-01-01T00:00:03Z"),
      ],
    })

    applyRevertBoundary(s, new Date("2024-01-01T00:00:02Z").getTime(), {
      boundaryContent: "second",
    })

    expect(s.blocks.map((b) => b.id)).toEqual(["u1"])
    expect(s._revertedSuffix?.map((b) => b.id)).toEqual(["u2", "tool"])
    expect(s.revertedMessages).toEqual([{ role: "user", content: "second" }])
  })

  it("prefers the backend boundary id for in-flight queued messages with client timestamps", () => {
    const s = makeStream({
      blocks: [block("u1", "user", "first", "2024-01-01T00:00:00Z")],
      currentBlocks: [
        block("q1", "user", "queued one", "2024-01-01T00:00:10Z"),
        block("q2", "user", "queued two", "2024-01-01T00:00:10Z"),
        block("partial", "text", "partial answer", "2024-01-01T00:00:10Z"),
      ],
    })

    applyRevertBoundary(s, new Date("2024-01-01T00:00:02Z").getTime(), {
      includeCurrent: true,
      boundaryId: "q2",
      boundaryContent: "queued two",
    })

    expect(s.blocks.map((b) => b.id)).toEqual(["u1", "q1"])
    expect(s._revertedSuffix?.map((b) => b.id)).toEqual(["q2", "partial"])
    expect(s.revertedMessages).toEqual([{ role: "user", content: "queued two" }])
  })

  // The two boundary hints are intentionally asymmetric. These two cases pin
  // that down so it does not get "unified" into a bug: the authoritative
  // server id may widen the visible range, the content heuristic may not.

  it("lets an authoritative boundaryId WIDEN the split past the timestamp guess", () => {
    const s = makeStream({
      blocks: [block("u1", "user", "first", "2024-01-01T00:00:00Z")],
      // Both queued rows carry optimistic client timestamps after the boundary,
      // so the timestamp scan alone would split at q1 and revert it.
      currentBlocks: [
        block("q1", "user", "queued one", "2024-01-01T00:00:10Z"),
        block("q2", "user", "queued two", "2024-01-01T00:00:10Z"),
      ],
    })

    applyRevertBoundary(s, new Date("2024-01-01T00:00:02Z").getTime(), {
      includeCurrent: true,
      boundaryId: "q2",
    })

    // q1 stays visible: the server says the boundary is q2, and it wins.
    expect(s.blocks.map((b) => b.id)).toEqual(["u1", "q1"])
    expect(s._revertedSuffix?.map((b) => b.id)).toEqual(["q2"])
  })

  it("never lets the boundaryContent heuristic WIDEN the split", () => {
    const s = makeStream({
      blocks: [
        block("u1", "user", "repeat", "2024-01-01T00:00:00Z"),
        block("u2", "user", "other", "2024-01-01T00:00:05Z"),
        block("u3", "user", "repeat", "2024-01-01T00:00:06Z"),
      ],
    })

    // Timestamp scan splits at u2 (t=5 >= 4). The newest content match is u3 at
    // index 2 — widening there would resurrect u2, so the split must stay at 1.
    applyRevertBoundary(s, new Date("2024-01-01T00:00:04Z").getTime(), {
      boundaryContent: "repeat",
    })

    expect(s.blocks.map((b) => b.id)).toEqual(["u1"])
    expect(s._revertedSuffix?.map((b) => b.id)).toEqual(["u2", "u3"])
  })

  it("reverts an untimestamped in-flight block that trails the crossing point", () => {
    // Streamed assistant blocks have no timestamp until `done` stamps them.
    // They read as t=0, but the split is positional after the first crossing
    // block, so a trailing partial answer is still reverted.
    const s = makeStream({
      blocks: [block("u1", "user", "first", "2024-01-01T00:00:00Z")],
      currentBlocks: [
        block("u2", "user", "second", "2024-01-01T00:00:05Z"),
        { id: "partial", type: "text", content: "half an answer" },
      ],
    })

    applyRevertBoundary(s, new Date("2024-01-01T00:00:03Z").getTime(), {
      includeCurrent: true,
    })

    expect(s.blocks.map((b) => b.id)).toEqual(["u1"])
    expect(s._revertedSuffix?.map((b) => b.id)).toEqual(["u2", "partial"])
  })

  // ── In-flight scratch state is wiped when includeCurrent=true ────────
  //
  // Regression for the "tokens stream into a ghost message after /undo"
  // bug: applyRevertBoundary only zeroed ``currentBlocks``, so a late
  // SSE ``message``/``thinking`` delta would re-seed via appendText /
  // appendThinking and surface as a new assistant block. The fix also
  // clears currentText/currentThinking and resets status.

  it("clears currentText, currentThinking and status when includeCurrent=true", () => {
    const s = makeStream({
      blocks: [block("u1", "user", "kept", "2024-01-01T00:00:00Z")],
      currentBlocks: [
        block("u2", "user", "in-flight", "2024-01-01T00:00:01Z"),
        block("partial", "text", "half answer...", "2024-01-01T00:00:01Z"),
      ],
      currentText: "half answer...",
      currentThinking: "let me see...",
      status: "working",
    })

    applyRevertBoundary(s, new Date("2024-01-01T00:00:02Z").getTime(), {
      includeCurrent: true,
      boundaryContent: "in-flight",
    })

    expect(s.currentBlocks).toEqual([])
    expect(s.currentText).toBe("")
    expect(s.currentThinking).toBe("")
    expect(s.status).toBe("idle")
  })

  it("does NOT clear currentText/currentThinking/status when includeCurrent is omitted", () => {
    // /redo and loadSession use the non-includeCurrent branch — those
    // callers manage scratch state themselves, so the helper must not
    // overstep and stomp on a still-active stream.
    const s = makeStream({
      blocks: [
        block("u1", "user", "first", "2024-01-01T00:00:00Z"),
        block("u2", "user", "second", "2024-01-01T00:00:02Z"),
      ],
      currentText: "still streaming",
      currentThinking: "still thinking",
      status: "working",
    })

    applyRevertBoundary(s, new Date("2024-01-01T00:00:02Z").getTime())

    expect(s.currentText).toBe("still streaming")
    expect(s.currentThinking).toBe("still thinking")
    expect(s.status).toBe("working")
  })

  it("preserves the ghost-block fix idempotently when includeCurrent=true twice", () => {
    // Double-undo should not regress the cleared scratch state.
    const s = makeStream({
      currentText: "x",
      currentThinking: "y",
      status: "working",
    })
    applyRevertBoundary(s, null, { includeCurrent: true })
    expect(s.currentText).toBe("")
    expect(s.status).toBe("idle")

    s.currentText = "should-not-resurrect"
    s.status = "working"
    applyRevertBoundary(s, null, { includeCurrent: true })
    expect(s.currentText).toBe("")
    expect(s.status).toBe("idle")
  })
})

describe("undoAgent — blocks while team is working (anti-ghost-block guard)", () => {
  it("sets an error and skips the POST when isAgentWorking is true", async () => {
    useAgentStore.setState({
      sessionId: "sess-1",
      leadName: "lead",
      isAgentWorking: true,
      agentStreams: {
        lead: makeStream({
          blocks: [block("u1", "user", "first", "2024-01-01T00:00:00Z")],
          currentBlocks: [
            block("partial", "text", "half answer", "2024-01-01T00:00:01Z"),
          ],
          currentText: "half answer",
          status: "working",
        }),
      },
    })

    const result = await useAgentStore.getState().undoAgent()

    expect(result).toBeUndefined()
    expect(mockPostAgentCommand).not.toHaveBeenCalled()
    const state = useAgentStore.getState()
    expect(state.error).toMatch(/cannot undo while agents are working/i)

    // Stream untouched: no boundary applied, no scratch state cleared.
    const stream = state.agentStreams.lead
    expect(stream.blocks.map((b) => b.id)).toEqual(["u1"])
    expect(stream.currentBlocks.map((b) => b.id)).toEqual(["partial"])
    expect(stream.currentText).toBe("half answer")
    expect(stream.status).toBe("working")
    expect(stream._revertedSuffix).toEqual([])
  })

  it("proceeds normally when isAgentWorking is false", async () => {
    useAgentStore.setState({
      sessionId: "sess-1",
      leadName: "lead",
      isAgentWorking: false,
      agentStreams: {
        lead: makeStream({
          blocks: [
            block("u1", "user", "first", "2024-01-01T00:00:00Z"),
            block("u2", "user", "second", "2024-01-01T00:00:02Z"),
          ],
        }),
      },
    })
    mockPostAgentCommand.mockImplementation(() =>
      Promise.resolve({
        status: "accepted",
        session_id: "sess-1",
        command: "undo",
        message: makeMessageResponse({ created_at: "2024-01-01T00:00:02Z" }),
      }),
    )

    await useAgentStore.getState().undoAgent()

    expect(mockPostAgentCommand).toHaveBeenCalledTimes(1)
    expect(useAgentStore.getState().error).toBeNull()
  })

  it("late SSE text deltas after an (illegally bypassed) undo cannot resurrect a ghost block", async () => {
    // Defence-in-depth: even if the working-guard is bypassed (e.g. a
    // member started streaming AFTER the precondition check but
    // BEFORE the POST round-trip), the reducer hardening in
    // applyRevertBoundary must ensure stray SSE deltas land on a
    // clean slate instead of starting a new ghost assistant block.
    useAgentStore.setState({
      sessionId: "sess-1",
      leadName: "lead",
      isAgentWorking: false, // bypass the guard
      agentStreams: {
        lead: makeStream({
          blocks: [block("u1", "user", "first", "2024-01-01T00:00:00Z")],
          currentBlocks: [
            block("u2-opt", "user", "second", "2024-01-01T00:00:01Z"),
            block("partial", "text", "...", "2024-01-01T00:00:01Z"),
          ],
          currentText: "...",
          status: "working",
        }),
      },
      agentNames: ["lead"],
    })
    mockPostAgentCommand.mockImplementation(() =>
      Promise.resolve({
        status: "accepted",
        session_id: "sess-1",
        command: "undo",
        message: makeMessageResponse({
          id: "u2",
          role: "user",
          content: "second",
          created_at: "2024-01-01T00:00:02Z",
        }),
      }),
    )

    await useAgentStore.getState().undoAgent()

    // Confirm the bug-trigger preconditions: in-flight blocks moved to
    // suffix and scratch state cleared.
    let stream = useAgentStore.getState().agentStreams.lead
    expect(stream.currentBlocks).toEqual([])
    expect(stream.currentText).toBe("")
    expect(stream.status).toBe("idle")

    // Now simulate a late SSE token arriving for the cancelled turn.
    // Pre-fix this would call appendText on currentBlocks and produce
    // a brand-new orphan ``text`` block.
    useAgentStore.getState()._handleSSEEvent("message", {
      agent: "lead",
      text: "stray token after undo",
    })

    stream = useAgentStore.getState().agentStreams.lead
    // The visible (committed) history must NOT have a ghost block.
    expect(stream.blocks.map((b) => b.id)).toEqual(["u1"])
    // A late delta still seeds a fresh currentBlock — that's expected
    // SSE-reducer behaviour — but it starts from an empty baseline,
    // not from leftover partial state. The bug was that the prior
    // PARTIAL block ("...") would be retained and grown; here we
    // assert it's gone.
    const partial = stream.currentBlocks.find((b) => b.id === "partial")
    expect(partial).toBeUndefined()
  })
})

describe("undoAgent — local boundary application", () => {
  it("applies the new boundary locally without calling sessionHistory", async () => {
    useAgentStore.setState({
      sessionId: "sess-1",
      leadName: "lead",
      agentStreams: {
        lead: makeStream({
          blocks: [
            block("u1", "user", "first", "2024-01-01T00:00:00Z"),
            block("a1", "text", "answer one", "2024-01-01T00:00:01Z"),
            block("u2", "user", "second", "2024-01-01T00:00:02Z"),
            block("a2", "text", "answer two", "2024-01-01T00:00:03Z"),
          ],
        }),
      },
    })

    mockPostAgentCommand.mockImplementation(() =>
      Promise.resolve({
        status: "accepted",
        session_id: "sess-1",
        command: "undo",
        message: makeMessageResponse({
          id: "u2-id",
          role: "user",
          content: "second",
          created_at: "2024-01-01T00:00:02Z",
        }),
      }),
    )

    await useAgentStore.getState().undoAgent()

    expect(mockSessionHistory).not.toHaveBeenCalled()
    expect(mockPostAgentCommand).toHaveBeenCalledWith("undo", "sess-1")

    const stream = useAgentStore.getState().agentStreams.lead
    expect(stream.blocks.map((b) => b.id)).toEqual(["u1", "a1"])
    expect(stream._revertedSuffix?.map((b) => b.id)).toEqual(["u2", "a2"])
    expect(useAgentStore.getState()._leadRevertTime).toBe(
      new Date("2024-01-01T00:00:02Z").getTime(),
    )
  })

  it("queues a workspace invalidation event for the post-undo refresh", async () => {
    useAgentStore.setState({
      sessionId: "sess-1",
      leadName: "lead",
      _workspace: "/tmp/proj",
      agentStreams: {
        lead: makeStream({
          blocks: [
            block("u1", "user", "first", "2024-01-01T00:00:00Z"),
            block("u2", "user", "second", "2024-01-01T00:00:02Z"),
          ],
        }),
      },
    })
    mockPostAgentCommand.mockImplementation(() =>
      Promise.resolve({
        status: "accepted",
        session_id: "sess-1",
        command: "undo",
        message: makeMessageResponse({
          created_at: "2024-01-01T00:00:02Z",
        }),
      }),
    )

    await useAgentStore.getState().undoAgent()

    expect(useAgentStore.getState().cacheInvalidations).toEqual([
      { kind: "coding_workspace", workspace: "/tmp/proj" },
    ])
  })

  it("emits a SCOPED coding_workspace_paths event when changed_paths is non-empty", async () => {
    useAgentStore.setState({
      sessionId: "sess-1",
      leadName: "lead",
      _workspace: "/tmp/proj",
      agentStreams: {
        lead: makeStream({
          blocks: [
            block("u1", "user", "first", "2024-01-01T00:00:00Z"),
            block("u2", "user", "second", "2024-01-01T00:00:02Z"),
          ],
        }),
      },
    })
    mockPostAgentCommand.mockImplementation(() =>
      Promise.resolve({
        status: "accepted",
        session_id: "sess-1",
        command: "undo",
        message: makeMessageResponse({ created_at: "2024-01-01T00:00:02Z" }),
        changed_paths: {
          added: ["src/added.ts"],
          modified: ["src/lib/util.ts"],
          removed: ["dist/stale.txt"],
        },
      }),
    )

    await useAgentStore.getState().undoAgent()

    const invalidations = useAgentStore.getState().cacheInvalidations
    expect(invalidations).toHaveLength(1)
    expect(invalidations[0]).toEqual({
      kind: "coding_workspace_paths",
      workspace: "/tmp/proj",
      paths: ["src/added.ts", "src/lib/util.ts", "dist/stale.txt"],
    })
  })

  it("skips invalidation when the server reports empty changed_paths", async () => {
    useAgentStore.setState({
      sessionId: "sess-1",
      leadName: "lead",
      _workspace: "/tmp/proj",
      agentStreams: {
        lead: makeStream({
          blocks: [block("u1", "user", "first", "2024-01-01T00:00:00Z")],
        }),
      },
    })
    mockPostAgentCommand.mockImplementation(() =>
      Promise.resolve({
        status: "accepted",
        session_id: "sess-1",
        command: "undo",
        message: makeMessageResponse({ created_at: "2024-01-01T00:00:00Z" }),
        changed_paths: { added: [], modified: [], removed: [] },
      }),
    )

    await useAgentStore.getState().undoAgent()

    expect(useAgentStore.getState().cacheInvalidations).toEqual([])
  })

  it("accumulates suffix correctly across multiple consecutive undos", async () => {
    useAgentStore.setState({
      sessionId: "sess-1",
      leadName: "lead",
      agentStreams: {
        lead: makeStream({
          blocks: [
            block("u1", "user", "first", "2024-01-01T00:00:00Z"),
            block("a1", "text", "a1", "2024-01-01T00:00:01Z"),
            block("u2", "user", "second", "2024-01-01T00:00:02Z"),
            block("a2", "text", "a2", "2024-01-01T00:00:03Z"),
            block("u3", "user", "third", "2024-01-01T00:00:04Z"),
            block("a3", "text", "a3", "2024-01-01T00:00:05Z"),
          ],
        }),
      },
    })

    mockPostAgentCommand.mockImplementationOnce(() =>
      Promise.resolve({
        status: "accepted",
        session_id: "sess-1",
        command: "undo",
        message: makeMessageResponse({ created_at: "2024-01-01T00:00:04Z" }),
      }),
    )
    await useAgentStore.getState().undoAgent()
    let stream = useAgentStore.getState().agentStreams.lead
    expect(stream.blocks.map((b) => b.id)).toEqual(["u1", "a1", "u2", "a2"])
    expect(stream._revertedSuffix?.map((b) => b.id)).toEqual(["u3", "a3"])

    mockPostAgentCommand.mockImplementationOnce(() =>
      Promise.resolve({
        status: "accepted",
        session_id: "sess-1",
        command: "undo",
        message: makeMessageResponse({ created_at: "2024-01-01T00:00:02Z" }),
      }),
    )
    await useAgentStore.getState().undoAgent()
    stream = useAgentStore.getState().agentStreams.lead
    expect(stream.blocks.map((b) => b.id)).toEqual(["u1", "a1"])
    expect(stream._revertedSuffix?.map((b) => b.id)).toEqual(["u2", "a2", "u3", "a3"])
  })

  it("applies the boundary to every agent stream (lead + members)", async () => {
    useAgentStore.setState({
      sessionId: "sess-1",
      leadName: "lead",
      agentStreams: {
        lead: makeStream({
          blocks: [
            block("L-u1", "user", "1", "2024-01-01T00:00:00Z"),
            block("L-u2", "user", "2", "2024-01-01T00:00:02Z"),
          ],
        }),
        worker: makeStream({
          blocks: [
            block("W-t1", "text", "early", "2024-01-01T00:00:00Z"),
            block("W-t2", "text", "late", "2024-01-01T00:00:03Z"),
          ],
        }),
      },
    })

    mockPostAgentCommand.mockImplementation(() =>
      Promise.resolve({
        status: "accepted",
        session_id: "sess-1",
        command: "undo",
        message: makeMessageResponse({ created_at: "2024-01-01T00:00:02Z" }),
      }),
    )
    await useAgentStore.getState().undoAgent()

    const lead = useAgentStore.getState().agentStreams.lead
    const worker = useAgentStore.getState().agentStreams.worker
    expect(lead.blocks.map((b) => b.id)).toEqual(["L-u1"])
    expect(worker.blocks.map((b) => b.id)).toEqual(["W-t1"])
    expect(worker._revertedSuffix?.map((b) => b.id)).toEqual(["W-t2"])
  })

  it("removes stopped-turn current blocks immediately", async () => {
    useAgentStore.setState({
      sessionId: "sess-1",
      leadName: "lead",
      agentStreams: {
        lead: makeStream({
          blocks: [block("u1", "user", "first", "2024-01-01T00:00:00Z")],
          currentBlocks: [
            block("u2", "user", "second", "2024-01-01T00:00:01Z"),
            block("tool", "tool", "", "2024-01-01T00:00:01Z"),
          ],
        }),
      },
    })
    mockPostAgentCommand.mockImplementation(() =>
      Promise.resolve({
        status: "accepted",
        session_id: "sess-1",
        command: "undo",
        message: makeMessageResponse({
          role: "user",
          content: "second",
          created_at: "2024-01-01T00:00:02Z",
        }),
      }),
    )

    await useAgentStore.getState().undoAgent()

    const stream = useAgentStore.getState().agentStreams.lead
    expect(stream.blocks.map((b) => b.id)).toEqual(["u1"])
    expect(stream.currentBlocks).toEqual([])
    expect(stream._revertedSuffix?.map((b) => b.id)).toEqual(["u2", "tool"])
  })
})

describe("redoAgent — restores ONE undone message step", () => {
  it("advances the boundary by a single step when multiple turns are undone", async () => {
    useAgentStore.setState({
      sessionId: "sess-1",
      leadName: "lead",
      _leadRevertTime: new Date("2024-01-01T00:00:02Z").getTime(),
      agentStreams: {
        lead: makeStream({
          blocks: [block("u1", "user", "first", "2024-01-01T00:00:00Z")],
          _revertedSuffix: [
            block("u2", "user", "second", "2024-01-01T00:00:02Z"),
            block("a2", "text", "a2", "2024-01-01T00:00:03Z"),
            block("u3", "user", "third", "2024-01-01T00:00:04Z"),
            block("a3", "text", "a3", "2024-01-01T00:00:05Z"),
          ],
          revertedCount: 2,
        }),
      },
    })

    mockPostAgentCommand.mockImplementationOnce(() =>
      Promise.resolve({
        status: "accepted",
        session_id: "sess-1",
        command: "redo",
        message: makeMessageResponse({ id: "u3", created_at: "2024-01-01T00:00:04Z" }),
      }),
    )

    const response = await useAgentStore.getState().redoAgent()

    expect(mockPostAgentCommand).toHaveBeenCalledTimes(1)
    expect(response?.message?.id).toBe("u3")

    const stream = useAgentStore.getState().agentStreams.lead
    expect(stream.blocks.map((b) => b.id)).toEqual(["u1", "u2", "a2"])
    expect(stream._revertedSuffix?.map((b) => b.id)).toEqual(["u3", "a3"])
    expect(stream.revertedCount).toBe(1)
    expect(useAgentStore.getState()._leadRevertTime).toBe(
      new Date("2024-01-01T00:00:04Z").getTime(),
    )
  })

  it("clears boundary when redoing the final undone turn", async () => {
    useAgentStore.setState({
      sessionId: "sess-1",
      leadName: "lead",
      _leadRevertTime: new Date("2024-01-01T00:00:02Z").getTime(),
      agentStreams: {
        lead: makeStream({
          blocks: [block("u1", "user", "first", "2024-01-01T00:00:00Z")],
          _revertedSuffix: [
            block("u2", "user", "second", "2024-01-01T00:00:02Z"),
            block("a2", "text", "a2", "2024-01-01T00:00:03Z"),
          ],
          revertedCount: 1,
        }),
      },
    })

    mockPostAgentCommand.mockImplementation(() =>
      Promise.resolve({
        status: "accepted",
        session_id: "sess-1",
        command: "redo",
        message: null,
      }),
    )

    await useAgentStore.getState().redoAgent()

    expect(mockPostAgentCommand).toHaveBeenCalledTimes(1)
    const stream = useAgentStore.getState().agentStreams.lead
    expect(stream.blocks.map((b) => b.id)).toEqual(["u1", "u2", "a2"])
    expect(stream._revertedSuffix).toEqual([])
    expect(stream.revertedCount).toBe(0)
    expect(useAgentStore.getState()._leadRevertTime).toBeNull()
  })

  it("enqueues scoped invalidation for single step changed_paths", async () => {
    useAgentStore.setState({
      sessionId: "sess-1",
      leadName: "lead",
      _workspace: "/tmp/proj",
      _leadRevertTime: new Date("2024-01-01T00:00:02Z").getTime(),
      agentStreams: {
        lead: makeStream({
          blocks: [block("u1", "user", "first", "2024-01-01T00:00:00Z")],
          _revertedSuffix: [
            block("u2", "user", "second", "2024-01-01T00:00:02Z"),
          ],
          revertedCount: 1,
        }),
      },
    })

    mockPostAgentCommand.mockImplementationOnce(() =>
      Promise.resolve({
        status: "accepted",
        session_id: "sess-1",
        command: "redo",
        message: null,
        changed_paths: {
          added: ["restored.ts"],
          modified: [],
          removed: [],
        },
      }),
    )

    await useAgentStore.getState().redoAgent()

    const events = useAgentStore.getState().cacheInvalidations
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      kind: "coding_workspace_paths",
      workspace: "/tmp/proj",
      paths: ["restored.ts"],
    })
  })

  it("does not touch streams when /redo fails on single step", async () => {
    useAgentStore.setState({
      sessionId: "sess-1",
      leadName: "lead",
      agentStreams: {
        lead: makeStream({
          blocks: [block("u1", "user", "first", "2024-01-01T00:00:00Z")],
          _revertedSuffix: [
            block("u2", "user", "second", "2024-01-01T00:00:02Z"),
          ],
        }),
      },
    })
    mockPostAgentCommand.mockImplementation(() =>
      Promise.reject(new Error("network down")),
    )

    await useAgentStore.getState().redoAgent()

    const stream = useAgentStore.getState().agentStreams.lead
    expect(stream.blocks.map((b) => b.id)).toEqual(["u1"])
    expect(stream._revertedSuffix?.map((b) => b.id)).toEqual(["u2"])
    expect(useAgentStore.getState().error).toBe("Failed to redo: network down")
  })

  it("clears local revert state when the server says there is nothing to redo", async () => {
    useAgentStore.setState({
      sessionId: "sess-1",
      leadName: "lead",
      _leadRevertTime: new Date("2024-01-01T00:00:02Z").getTime(),
      agentStreams: {
        lead: makeStream({
          blocks: [block("u1", "user", "first", "2024-01-01T00:00:00Z")],
          _revertedSuffix: [
            block("u2", "user", "second", "2024-01-01T00:00:02Z"),
          ],
          revertedCount: 1,
        }),
      },
    })
    mockPostAgentCommand.mockImplementation(() =>
      Promise.reject(new Error("No undone message to redo.")),
    )

    await useAgentStore.getState().redoAgent()

    const stream = useAgentStore.getState().agentStreams.lead
    expect(stream.blocks.map((b) => b.id)).toEqual(["u1", "u2"])
    expect(stream._revertedSuffix).toEqual([])
    expect(stream.revertedCount).toBe(0)
    expect(useAgentStore.getState()._leadRevertTime).toBeNull()
    expect(useAgentStore.getState().error).toBeNull()
  })
})

describe("redoAllAgent — restores ALL undone messages back to live tip", () => {
  it("calls /agent/commands with redo-all and clears boundary to tip in one step", async () => {
    useAgentStore.setState({
      sessionId: "sess-1",
      leadName: "lead",
      _leadRevertTime: new Date("2024-01-01T00:00:02Z").getTime(),
      agentStreams: {
        lead: makeStream({
          blocks: [block("u1", "user", "first", "2024-01-01T00:00:00Z")],
          _revertedSuffix: [
            block("u2", "user", "second", "2024-01-01T00:00:02Z"),
            block("a2", "text", "a2", "2024-01-01T00:00:03Z"),
            block("u3", "user", "third", "2024-01-01T00:00:04Z"),
            block("a3", "text", "a3", "2024-01-01T00:00:05Z"),
          ],
          revertedCount: 2,
        }),
      },
    })

    mockPostAgentCommand.mockImplementationOnce(() =>
      Promise.resolve({
        status: "accepted",
        session_id: "sess-1",
        command: "redo-all",
        message: null,
      }),
    )

    await useAgentStore.getState().redoAllAgent()

    expect(mockPostAgentCommand).toHaveBeenCalledTimes(1)
    expect(mockPostAgentCommand).toHaveBeenCalledWith("redo-all", "sess-1")
    expect(mockSessionHistory).not.toHaveBeenCalled()

    const stream = useAgentStore.getState().agentStreams.lead
    expect(stream.blocks.map((b) => b.id)).toEqual([
      "u1",
      "u2",
      "a2",
      "u3",
      "a3",
    ])
    expect(stream._revertedSuffix).toEqual([])
    expect(stream.revertedCount).toBe(0)
    expect(useAgentStore.getState()._leadRevertTime).toBeNull()
  })

  it("enqueues scoped invalidation for changed_paths returned by redo-all", async () => {
    useAgentStore.setState({
      sessionId: "sess-1",
      leadName: "lead",
      _workspace: "/tmp/proj",
      _leadRevertTime: new Date("2024-01-01T00:00:02Z").getTime(),
      agentStreams: {
        lead: makeStream({
          blocks: [block("u1", "user", "first", "2024-01-01T00:00:00Z")],
          _revertedSuffix: [
            block("u2", "user", "second", "2024-01-01T00:00:02Z"),
            block("u3", "user", "third", "2024-01-01T00:00:04Z"),
          ],
          revertedCount: 2,
        }),
      },
    })

    mockPostAgentCommand.mockImplementationOnce(() =>
      Promise.resolve({
        status: "accepted",
        session_id: "sess-1",
        command: "redo-all",
        message: null,
        changed_paths: {
          added: ["new-file.ts"],
          modified: ["shared.ts"],
          removed: ["deleted.ts"],
        },
      }),
    )

    await useAgentStore.getState().redoAllAgent()

    const events = useAgentStore.getState().cacheInvalidations
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe("coding_workspace_paths")
    expect(events[0]).toMatchObject({
      kind: "coding_workspace_paths",
      workspace: "/tmp/proj",
    })
    const paths = (events[0] as { paths: string[] }).paths
    expect([...paths].sort()).toEqual([
      "deleted.ts",
      "new-file.ts",
      "shared.ts",
    ])
  })

  it("falls back to broad coding_workspace when no changed_paths arrive", async () => {
    useAgentStore.setState({
      sessionId: "sess-1",
      leadName: "lead",
      _workspace: "/tmp/proj",
      _leadRevertTime: new Date("2024-01-01T00:00:02Z").getTime(),
      agentStreams: {
        lead: makeStream({
          blocks: [block("u1", "user", "first", "2024-01-01T00:00:00Z")],
          _revertedSuffix: [
            block("u2", "user", "second", "2024-01-01T00:00:02Z"),
          ],
        }),
      },
    })
    mockPostAgentCommand.mockImplementation(() =>
      Promise.resolve({
        status: "accepted",
        session_id: "sess-1",
        command: "redo-all",
        message: null,
      }),
    )

    await useAgentStore.getState().redoAllAgent()

    expect(useAgentStore.getState().cacheInvalidations).toEqual([
      { kind: "coding_workspace", workspace: "/tmp/proj" },
    ])
  })

  it("does not touch streams when redo-all fails", async () => {
    useAgentStore.setState({
      sessionId: "sess-1",
      leadName: "lead",
      agentStreams: {
        lead: makeStream({
          blocks: [block("u1", "user", "first", "2024-01-01T00:00:00Z")],
          _revertedSuffix: [
            block("u2", "user", "second", "2024-01-01T00:00:02Z"),
          ],
        }),
      },
    })
    mockPostAgentCommand.mockImplementation(() =>
      Promise.reject(new Error("network down")),
    )

    await useAgentStore.getState().redoAllAgent()

    const stream = useAgentStore.getState().agentStreams.lead
    expect(stream.blocks.map((b) => b.id)).toEqual(["u1"])
    expect(stream._revertedSuffix?.map((b) => b.id)).toEqual(["u2"])
    expect(useAgentStore.getState().error).toBe("Failed to redo: network down")
  })

  it("clears local revert state when the server says there is nothing to redo", async () => {
    useAgentStore.setState({
      sessionId: "sess-1",
      leadName: "lead",
      _leadRevertTime: new Date("2024-01-01T00:00:02Z").getTime(),
      agentStreams: {
        lead: makeStream({
          blocks: [block("u1", "user", "first", "2024-01-01T00:00:00Z")],
          _revertedSuffix: [
            block("u2", "user", "second", "2024-01-01T00:00:02Z"),
          ],
          revertedCount: 1,
        }),
      },
    })
    mockPostAgentCommand.mockImplementation(() =>
      Promise.reject(new Error("No undone message to redo.")),
    )

    await useAgentStore.getState().redoAllAgent()

    const stream = useAgentStore.getState().agentStreams.lead
    expect(stream.blocks.map((b) => b.id)).toEqual(["u1", "u2"])
    expect(stream._revertedSuffix).toEqual([])
    expect(stream.revertedCount).toBe(0)
    expect(useAgentStore.getState()._leadRevertTime).toBeNull()
    expect(useAgentStore.getState().error).toBeNull()
  })
})

describe("loadSession — parses all messages and populates _revertedSuffix", () => {
  it("splits visible vs reverted on initial load of an already-reverted session", async () => {
    mockSessionHistory.mockImplementation(() =>
      Promise.resolve({
        lead: {
          id: "lead-sess",
          agent_name: "lead",
          title: null,
          created_at: null,
          updated_at: null,
          sub_sessions: [],
          revert: { message_id: "u2" },
          messages: [
            makeMessageResponse({
              id: "u1",
              role: "user",
              content: "first",
              created_at: "2024-01-01T00:00:00Z",
            }),
            makeMessageResponse({
              id: "a1",
              role: "assistant",
              content: "answer one",
              created_at: "2024-01-01T00:00:01Z",
            }),
            makeMessageResponse({
              id: "u2",
              role: "user",
              content: "second",
              created_at: "2024-01-01T00:00:02Z",
            }),
            makeMessageResponse({
              id: "a2",
              role: "assistant",
              content: "answer two",
              created_at: "2024-01-01T00:00:03Z",
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

    expect(stream.blocks.map((b) => b.content)).toEqual(["first", "answer one"])
    expect(stream._revertedSuffix?.map((b) => b.content)).toEqual([
      "second",
      "answer two",
    ])
    expect(stream.revertedCount).toBe(1)
  })

  it("handles timestamp collision between previous assistant answer and target boundary on loadSession", async () => {
    // When a1 and u2 (boundary target) share the same millisecond timestamp,
    // passing boundaryId ensures a1 stays visible and u2 is reverted.
    const collisionTime = "2024-01-01T00:00:02.000Z"
    mockSessionHistory.mockImplementation(() =>
      Promise.resolve({
        lead: {
          id: "lead-sess",
          agent_name: "lead",
          title: null,
          created_at: null,
          updated_at: null,
          sub_sessions: [],
          revert: { message_id: "u2" },
          messages: [
            makeMessageResponse({
              id: "u1",
              role: "user",
              content: "first",
              created_at: "2024-01-01T00:00:00.000Z",
            }),
            makeMessageResponse({
              id: "a1",
              role: "assistant",
              content: "answer one",
              created_at: collisionTime,
            }),
            makeMessageResponse({
              id: "u2",
              role: "user",
              content: "second",
              created_at: collisionTime,
            }),
            makeMessageResponse({
              id: "a2",
              role: "assistant",
              content: "answer two",
              created_at: "2024-01-01T00:00:03.000Z",
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

    expect(stream.blocks.map((b) => b.content)).toEqual(["first", "answer one"])
    expect(stream._revertedSuffix?.map((b) => b.content)).toEqual([
      "second",
      "answer two",
    ])
    expect(stream.revertedCount).toBe(1)
  })

  it("clears _revertedSuffix when loading a non-reverted session", async () => {
    useAgentStore.setState({
      agentStreams: {
        lead: makeStream({
          _revertedSuffix: [
            block("stale", "user", "from old session", "2023-01-01T00:00:00Z"),
          ],
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
            makeMessageResponse({
              id: "u1",
              role: "user",
              content: "hi",
              created_at: "2024-01-01T00:00:00Z",
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
    expect(stream._revertedSuffix).toEqual([])
    expect(stream.blocks.map((b) => b.id)).toEqual(["u1"])
  })
})

describe("sendMessage — clears _revertedSuffix and boundary", () => {
  it("drops local suffix so a stray /redo cannot resurrect deleted rows", async () => {
    useAgentStore.setState({
      sessionId: "sess-1",
      leadName: "lead",
      _leadRevertTime: new Date("2024-01-01T00:00:02Z").getTime(),
      agentStreams: {
        lead: makeStream({
          blocks: [block("u1", "user", "kept", "2024-01-01T00:00:00Z")],
          _revertedSuffix: [
            block("u2", "user", "to be deleted", "2024-01-01T00:00:02Z"),
          ],
          revertedCount: 1,
        }),
      },
    })

    await useAgentStore.getState().sendMessage("new message", undefined, { workspace: "/repo/app" })

    const stream = useAgentStore.getState().agentStreams.lead
    expect(stream._revertedSuffix).toEqual([])
    expect(stream.revertedCount).toBe(0)
    expect(useAgentStore.getState()._leadRevertTime).toBeNull()
  })
})
