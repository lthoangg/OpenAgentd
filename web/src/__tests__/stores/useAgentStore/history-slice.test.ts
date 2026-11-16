/**
 * Waiting for history, and paging older history in.
 *
 * Mocks the API client through ./async-fixture; see there for why.
 */
import { describe, it, expect, beforeEach } from "bun:test"
import { mockSessionHistory, makeStream, makeMessageResponse, resetAsyncStore } from "./async-fixture"
import { useAgentStore } from "@/stores/useAgentStore"

beforeEach(resetAsyncStore)

// ── Opening another session: its history is on the way ──────────────────────

describe("isLoadingHistory", () => {
  const emptyHistory = {
    lead: { id: "session-b", agent_name: "lead", title: "B", created_at: null, updated_at: null, sub_sessions: [], messages: [] },
    members: [],
    has_more: false,
    next_cursor: null,
  }

  it("is set from opening another session until its history arrives", async () => {
    let resolveHistory!: (v: unknown) => void
    mockSessionHistory.mockImplementation(() => new Promise((res) => { resolveHistory = res }))
    useAgentStore.setState({ sessionId: "session-a", leadName: "lead", agentStreams: { lead: makeStream() } })

    useAgentStore.getState().beginResolvedSession("session-b", { workspace: "/repo" })
    expect(useAgentStore.getState().isLoadingHistory).toBe(true)

    const loading = useAgentStore.getState().loadSession("session-b", "/repo")
    expect(useAgentStore.getState().isLoadingHistory).toBe(true)
    resolveHistory(emptyHistory)
    await loading

    // An empty session is now known to be empty.
    expect(useAgentStore.getState().isLoadingHistory).toBe(false)
  })

  it("is cleared when the history fails to load", async () => {
    mockSessionHistory.mockImplementation(() => Promise.reject(new Error("offline")))
    useAgentStore.getState().beginResolvedSession("session-b", { workspace: "/repo" })

    await useAgentStore.getState().loadSession("session-b", "/repo")

    expect(useAgentStore.getState().isLoadingHistory).toBe(false)
    expect(useAgentStore.getState().error).toBe("offline")
  })

  it("is never set for a session created here, which has no history to wait for", () => {
    useAgentStore.getState().beginResolvedSession("session-new", { workspace: "/repo", skipInitialRestore: true })
    expect(useAgentStore.getState().isLoadingHistory).toBe(false)
  })

  it("is never set for a draft", () => {
    useAgentStore.getState().beginResolvedSession("session-b", { workspace: "/repo" })
    useAgentStore.getState().newSession()
    expect(useAgentStore.getState().isLoadingHistory).toBe(false)
  })

  it("loads afresh after leaving a session and coming back while its first load was out", async () => {
    const pending: Array<(v: unknown) => void> = []
    mockSessionHistory.mockImplementation(() => new Promise((res) => { pending.push(res) }))

    useAgentStore.getState().beginResolvedSession("session-b", { workspace: "/repo" })
    const first = useAgentStore.getState().loadSession("session-b", "/repo")
    useAgentStore.getState().beginResolvedSession("session-a", { workspace: "/repo" })
    useAgentStore.getState().beginResolvedSession("session-b", { workspace: "/repo" })
    const second = useAgentStore.getState().loadSession("session-b", "/repo")

    // The first answer belongs to a visit that is over, so it cannot count.
    expect(pending).toHaveLength(2)
    pending.forEach((resolve) => resolve(emptyHistory))
    await Promise.all([first, second])
    expect(useAgentStore.getState().isLoadingHistory).toBe(false)
    expect(useAgentStore.getState().sessionTitle).toBe("B")
  })
})

// ── loadOlderMessages ─────────────────────────────────────────────────────────

describe("loadOlderMessages", () => {
  const olderPage = (ids: string[]) => ({
    lead: { id: "lead-sess", agent_name: "lead", title: null, created_at: null, updated_at: null, sub_sessions: [], messages: ids.map((id) => makeMessageResponse({ id, role: id.startsWith("p") ? "user" : "assistant", content: id })) },
    members: [],
    has_more: true,
    next_cursor: "c-older",
  })

  it("keeps the pinned prompt until the page holding it lands", async () => {
    useAgentStore.setState({
      sessionId: "sess-1",
      hasMore: true,
      nextCursor: "c1",
      leadName: "lead",
      pinnedPrompt: { id: "p1", type: "user", content: "keep going" },
      agentStreams: { lead: makeStream({ blocks: [{ id: "a9", type: "text" as const, content: "step 900" }] }) },
    })
    mockSessionHistory.mockImplementation(() => Promise.resolve(olderPage(["a5", "a6"])))
    await useAgentStore.getState().loadOlderMessages()
    expect(useAgentStore.getState().pinnedPrompt?.id).toBe("p1")

    mockSessionHistory.mockImplementation(() => Promise.resolve(olderPage(["a0", "p1", "a1"])))
    await useAgentStore.getState().loadOlderMessages()
    expect(useAgentStore.getState().pinnedPrompt).toBeNull()
    expect(useAgentStore.getState().agentStreams.lead.blocks.map((b) => b.id)).toContain("p1")
  })

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

// ── loadOlderUntilPrompt ──────────────────────────────────────────────────────

describe("loadOlderUntilPrompt", () => {
  const page = (messages: ReturnType<typeof makeMessageResponse>[], nextCursor: string | null) => ({
    lead: { id: "lead-sess", agent_name: "lead", title: null, created_at: null, updated_at: null, sub_sessions: [], messages },
    members: [],
    has_more: nextCursor !== null,
    next_cursor: nextCursor,
  })

  function seed() {
    useAgentStore.setState({
      sessionId: "sess-1",
      hasMore: true,
      nextCursor: "c0",
      leadName: "lead",
      agentStreams: { lead: makeStream({ blocks: [{ id: "newest", type: "user" as const, content: "newest prompt" }] }) },
    })
  }

  it("fetches pages until one holds a prompt, then prepends them all in one update", async () => {
    seed()
    const pages: Record<string, ReturnType<typeof page>> = {
      c0: page([makeMessageResponse({ id: "a2", role: "assistant", content: "end of a long answer" })], "c1"),
      c1: page([
        makeMessageResponse({ id: "report", role: "user", content: "a report", extra: { from_agent: "explorer" } }),
        makeMessageResponse({ id: "a1", role: "assistant", content: "more of it" }),
      ], "c2"),
      c2: page([
        makeMessageResponse({ id: "p1", role: "user", content: "older prompt" }),
        makeMessageResponse({ id: "a0", role: "assistant", content: "its answer" }),
      ], "c3"),
    }
    mockSessionHistory.mockImplementation((_id: string, cursor: string) => Promise.resolve(pages[cursor]))
    let updates = 0
    const unsubscribe = useAgentStore.subscribe((state, previous) => {
      if (state.agentStreams.lead.blocks !== previous.agentStreams.lead.blocks) updates += 1
    })

    const found = await useAgentStore.getState().loadOlderUntilPrompt()
    unsubscribe()

    expect(found).toBe(true)
    expect(mockSessionHistory.mock.calls.map((call: unknown[]) => call[1])).toEqual(["c0", "c1", "c2"])
    expect(updates).toBe(1)
    expect(useAgentStore.getState().agentStreams.lead.blocks.map((b) => b.id)).toEqual(
      expect.arrayContaining(["p1", "report", "newest"]),
    )
    const ids = useAgentStore.getState().agentStreams.lead.blocks.map((b) => b.id)
    expect(ids.indexOf("p1")).toBeLessThan(ids.indexOf("report"))
    expect(ids.at(-1)).toBe("newest")
    expect(useAgentStore.getState().nextCursor).toBe("c3")
    expect(useAgentStore.getState()._loadingOlder).toBe(false)
  })

  it("stops after the page limit, or when history runs out, without a prompt", async () => {
    seed()
    let n = 0
    mockSessionHistory.mockImplementation(() => {
      n += 1
      return Promise.resolve(page([makeMessageResponse({ id: `a${n}`, role: "assistant", content: "answer" })], `c${n}`))
    })

    expect(await useAgentStore.getState().loadOlderUntilPrompt(3)).toBe(false)
    expect(mockSessionHistory).toHaveBeenCalledTimes(3)

    mockSessionHistory.mockReset()
    mockSessionHistory.mockImplementation(() => Promise.resolve(page([], null)))
    expect(await useAgentStore.getState().loadOlderUntilPrompt()).toBe(false)
    expect(mockSessionHistory).toHaveBeenCalledTimes(1)
    expect(useAgentStore.getState().hasMore).toBe(false)
  })

  it("passes a goal's own turns and stops at the prompt the user wrote", async () => {
    seed()
    const goalTurn = { goal_turn: { id: "g1", turn: 2, max_turns: 50, why: "unclaimed" } }
    const pages: Record<string, ReturnType<typeof page>> = {
      c0: page([makeMessageResponse({ id: "turn2", role: "user", content: "<goal_reminder turn=\"2\">", extra: goalTurn })], "c1"),
      c1: page([makeMessageResponse({ id: "prompt", role: "user", content: "tests pass" })], "c2"),
    }
    mockSessionHistory.mockImplementation((_id: string, cursor: string) => Promise.resolve(pages[cursor]))

    expect(await useAgentStore.getState().loadOlderUntilPrompt()).toBe(true)
    expect(mockSessionHistory.mock.calls.map((call: unknown[]) => call[1])).toEqual(["c0", "c1"])
  })

  it("drops the pages when the session changes while they load", async () => {
    seed()
    mockSessionHistory.mockImplementation(async () => {
      useAgentStore.setState((state) => ({ _sessionGeneration: (state._sessionGeneration ?? 0) + 1 }))
      return page([makeMessageResponse({ id: "p1", role: "user", content: "older prompt" })], null)
    })

    expect(await useAgentStore.getState().loadOlderUntilPrompt()).toBe(false)
    expect(useAgentStore.getState().agentStreams.lead.blocks.map((b) => b.id)).toEqual(["newest"])
  })
})
