import { describe, it, expect, beforeEach } from "bun:test"
import { useTeamStore } from "@/stores/useTeamStore"

/**
 * Scheduler invalidation is driven by tool_end events whose tool is in
 * SCHEDULER_MUTATING_TOOLS (currently just 'schedule_task').
 *
 * When a scheduler-mutating tool completes, the SSE reducer pushes a
 * ``{ kind: 'scheduler' }`` event onto ``cacheInvalidations``.  The
 * React-side bridge in the coding route translates that into a
 * ``queryClient.invalidateQueries({ queryKey: scheduler.list() })``
 * call (covered by the bridge tests in
 * ``team-cache-bridge.test.tsx``).
 *
 * This test suite verifies the store-level behaviour:
 * 1. Event fires for schedule_task tool_end events
 * 2. Event does NOT fire for non-scheduler tools
 * 3. Workspace events are independent of scheduler events
 * 4. Multiple scheduler mutations queue multiple events
 */

/**
 * Helper to prime a tool block by firing tool_call and tool_start events.
 * This creates the block that tool_end will later complete.
 */
function primeBlock(
  agent: string,
  toolName: string,
  toolCallId: string,
  args: Record<string, unknown>,
) {
  const state = useTeamStore.getState()
  state._handleSSEEvent("tool_call", { name: toolName, agent, tool_call_id: toolCallId })
  state._handleSSEEvent("tool_start", {
    name: toolName,
    agent,
    tool_call_id: toolCallId,
    arguments: JSON.stringify(args),
  })
}

describe("useTeamStore — scheduler invalidation", () => {
  beforeEach(() => {
    useTeamStore.setState({
      agentStreams: {},
      activeAgent: null,
      leadName: null,
      agentNames: [],
      liveAgentNames: null,
      sidebarOpen: false,
      sessionId: null,
      sessionTitle: null,
      isTeamWorking: false,
      isConnected: false,
      error: null,
      _pendingMessages: [],
      _sessionGeneration: 0,
      // Must reset ``_workspace`` here — the coding-workspace test
      // suite (run before this in alphabetical order) sets it to a
      // path, and a leaked value would re-route this suite's
      // ``workspace_files`` assertions to ``coding_workspace`` events.
      _workspace: null,
      cacheInvalidations: [],
    })
  })

  // ── Happy path: schedule_task invalidates scheduler.list() ────────────────

  it("emits scheduler event when tool_end fires with name: 'schedule_task'", () => {
    primeBlock("claude", "schedule_task", "tc-1", { task: "daily_standup", time: "09:00" })
    useTeamStore.getState()._handleSSEEvent("tool_end", {
      name: "schedule_task",
      agent: "claude",
      tool_call_id: "tc-1",
      result: "Task scheduled successfully",
    })
    expect(useTeamStore.getState().cacheInvalidations).toEqual([{ kind: "scheduler" }])
  })

  it("emits scheduler event for schedule_task with action: 'create'", () => {
    primeBlock("claude", "schedule_task", "tc-2", {
      action: "create",
      task_name: "weekly_review",
      schedule: "0 9 * * 1",
    })
    useTeamStore.getState()._handleSSEEvent("tool_end", {
      name: "schedule_task",
      agent: "claude",
      tool_call_id: "tc-2",
      result: "Created scheduled task",
    })
    expect(useTeamStore.getState().cacheInvalidations).toEqual([{ kind: "scheduler" }])
  })

  it("emits scheduler event for schedule_task with action: 'update'", () => {
    primeBlock("claude", "schedule_task", "tc-3", {
      action: "update",
      slug: "task-123",
      schedule: "0 10 * * 1",
    })
    useTeamStore.getState()._handleSSEEvent("tool_end", {
      name: "schedule_task",
      agent: "claude",
      tool_call_id: "tc-3",
      result: "Updated scheduled task",
    })
    expect(useTeamStore.getState().cacheInvalidations).toEqual([{ kind: "scheduler" }])
  })

  it("emits scheduler event for schedule_task with action: 'delete'", () => {
    primeBlock("claude", "schedule_task", "tc-4", {
      action: "delete",
      slug: "task-456",
    })
    useTeamStore.getState()._handleSSEEvent("tool_end", {
      name: "schedule_task",
      agent: "claude",
      tool_call_id: "tc-4",
      result: "Deleted scheduled task",
    })
    expect(useTeamStore.getState().cacheInvalidations).toEqual([{ kind: "scheduler" }])
  })

  // ── Non-scheduler tools do NOT emit ──────────────────────────────────────

  it("emits NOTHING when tool_end fires with name: 'write' (filesystem tool, no session)", () => {
    primeBlock("claude", "write", "tc-5", { path: "notes/scratch.md", content: "..." })
    useTeamStore.getState()._handleSSEEvent("tool_end", {
      name: "write",
      agent: "claude",
      tool_call_id: "tc-5",
      result: "Written 12 bytes",
    })
    expect(useTeamStore.getState().cacheInvalidations).toEqual([])
  })

  it("emits NOTHING when tool_end fires with name: 'read'", () => {
    primeBlock("claude", "read", "tc-6", { path: "notes/file.md" })
    useTeamStore.getState()._handleSSEEvent("tool_end", {
      name: "read",
      agent: "claude",
      tool_call_id: "tc-6",
      result: "file contents",
    })
    expect(useTeamStore.getState().cacheInvalidations).toEqual([])
  })

  it("emits NOTHING when tool_end fires with name: 'web_search'", () => {
    primeBlock("claude", "web_search", "tc-7", { query: "latest news" })
    useTeamStore.getState()._handleSSEEvent("tool_end", {
      name: "web_search",
      agent: "claude",
      tool_call_id: "tc-7",
      result: "search results",
    })
    expect(useTeamStore.getState().cacheInvalidations).toEqual([])
  })

  it("emits NOTHING when tool_end fires with name: 'grep'", () => {
    primeBlock("claude", "grep", "tc-8", { pattern: "foo", directory: "wiki" })
    useTeamStore.getState()._handleSSEEvent("tool_end", {
      name: "grep",
      agent: "claude",
      tool_call_id: "tc-8",
      result: "no matches",
    })
    expect(useTeamStore.getState().cacheInvalidations).toEqual([])
  })

  it("emits NOTHING when tool_end fires with name: 'ls'", () => {
    primeBlock("claude", "ls", "tc-9", { path: "wiki" })
    useTeamStore.getState()._handleSSEEvent("tool_end", {
      name: "ls",
      agent: "claude",
      tool_call_id: "tc-9",
      result: "file listing",
    })
    expect(useTeamStore.getState().cacheInvalidations).toEqual([])
  })

  // ── Multiple mutations ───────────────────────────────────────────────────

  it("queues one event per schedule_task call across multiple calls", () => {
    const state = useTeamStore.getState()
    for (let i = 0; i < 3; i++) {
      const tcid = `tc-multi-${i}`
      primeBlock("claude", "schedule_task", tcid, { task: `task-${i}` })
      state._handleSSEEvent("tool_end", {
        name: "schedule_task",
        agent: "claude",
        tool_call_id: tcid,
        result: "ok",
      })
    }
    expect(useTeamStore.getState().cacheInvalidations).toEqual([
      { kind: "scheduler" },
      { kind: "scheduler" },
      { kind: "scheduler" },
    ])
  })

  it("queues one event per schedule_task call across different agents", () => {
    const state = useTeamStore.getState()
    for (let i = 0; i < 2; i++) {
      const agent = i === 0 ? "claude" : "gpt4"
      const tcid = `tc-agent-${i}`
      primeBlock(agent, "schedule_task", tcid, { task: `task-${i}` })
      state._handleSSEEvent("tool_end", {
        name: "schedule_task",
        agent,
        tool_call_id: tcid,
        result: "ok",
      })
    }
    expect(useTeamStore.getState().cacheInvalidations).toEqual([
      { kind: "scheduler" },
      { kind: "scheduler" },
    ])
  })

  // ── Independence of event branches ───────────────────────────────────────

  it("workspace and scheduler events are independent (patch to workspace)", () => {
    useTeamStore.setState({ sessionId: "sid-123" })
    primeBlock("claude", "patch", "tc-12", { patch_text: "*** Begin Patch\n*** Update File: notes/scratch.md\n@@\n-old\n+new\n*** End Patch" })
    useTeamStore.getState()._handleSSEEvent("tool_end", {
      name: "patch",
      agent: "claude",
      tool_call_id: "tc-12",
      result: "Patched",
    })
    // Workspace event only — no scheduler event
    expect(useTeamStore.getState().cacheInvalidations).toEqual([
      { kind: "workspace_files", sessionId: "sid-123" },
    ])
  })

  it("scheduler event fires independently of memory event", () => {
    primeBlock("claude", "schedule_task", "tc-13", { task: "test" })
    useTeamStore.getState()._handleSSEEvent("tool_end", {
      name: "schedule_task",
      agent: "claude",
      tool_call_id: "tc-13",
      result: "ok",
    })
    // Scheduler event only — no memory event
    expect(useTeamStore.getState().cacheInvalidations).toEqual([{ kind: "scheduler" }])
  })

  // ── Tool block state is still updated ────────────────────────────────────

  it("still updates the tool block state on tool_end even when emitting scheduler event", () => {
    primeBlock("claude", "schedule_task", "tc-14", { task: "test" })
    useTeamStore.getState()._handleSSEEvent("tool_end", {
      name: "schedule_task",
      agent: "claude",
      tool_call_id: "tc-14",
      result: "Task scheduled",
    })

    const agentStream = useTeamStore.getState().agentStreams["claude"]
    expect(agentStream).toBeDefined()
    const block = agentStream.currentBlocks.find((b) => b.toolCallId === "tc-14")
    expect(block).toBeDefined()
    expect(block!.toolDone).toBe(true)
    expect(block!.toolResult).toBe("Task scheduled")
    expect(useTeamStore.getState().cacheInvalidations).toEqual([{ kind: "scheduler" }])
  })

  // ── Edge cases ───────────────────────────────────────────────────────────

  it("emits scheduler event for schedule_task with minimal arguments", () => {
    primeBlock("claude", "schedule_task", "tc-15", {})
    useTeamStore.getState()._handleSSEEvent("tool_end", {
      name: "schedule_task",
      agent: "claude",
      tool_call_id: "tc-15",
      result: "ok",
    })
    expect(useTeamStore.getState().cacheInvalidations).toEqual([{ kind: "scheduler" }])
  })

  it("emits scheduler event for schedule_task with complex nested arguments", () => {
    primeBlock("claude", "schedule_task", "tc-16", {
      action: "create",
      task: {
        name: "complex_task",
        config: {
          schedule: "0 9 * * *",
          timezone: "UTC",
          retry: { max_attempts: 3, backoff: "exponential" },
        },
      },
    })
    useTeamStore.getState()._handleSSEEvent("tool_end", {
      name: "schedule_task",
      agent: "claude",
      tool_call_id: "tc-16",
      result: "ok",
    })
    expect(useTeamStore.getState().cacheInvalidations).toEqual([{ kind: "scheduler" }])
  })

  it("emits scheduler event for schedule_task with empty result string", () => {
    primeBlock("claude", "schedule_task", "tc-17", { task: "test" })
    useTeamStore.getState()._handleSSEEvent("tool_end", {
      name: "schedule_task",
      agent: "claude",
      tool_call_id: "tc-17",
      result: "",
    })
    expect(useTeamStore.getState().cacheInvalidations).toEqual([{ kind: "scheduler" }])
  })

  it("emits scheduler event for schedule_task with undefined result", () => {
    primeBlock("claude", "schedule_task", "tc-18", { task: "test" })
    useTeamStore.getState()._handleSSEEvent("tool_end", {
      name: "schedule_task",
      agent: "claude",
      tool_call_id: "tc-18",
      // result is undefined
    })
    expect(useTeamStore.getState().cacheInvalidations).toEqual([{ kind: "scheduler" }])
  })

  it("emits scheduler event for schedule_task without tool_call_id (matches by toolName)", () => {
    const state = useTeamStore.getState()
    state._handleSSEEvent("tool_call", { name: "schedule_task", agent: "claude" })
    state._handleSSEEvent("tool_start", {
      name: "schedule_task",
      agent: "claude",
      arguments: JSON.stringify({ task: "test" }),
    })
    state._handleSSEEvent("tool_end", {
      name: "schedule_task",
      agent: "claude",
      result: "ok",
    })
    expect(useTeamStore.getState().cacheInvalidations).toEqual([{ kind: "scheduler" }])
  })

  it("emits scheduler event even if the tool block was not primed (orphan tool_end)", () => {
    useTeamStore.getState()._handleSSEEvent("tool_end", {
      name: "schedule_task",
      agent: "claude",
      tool_call_id: "tc-orphan",
      result: "ok",
    })
    expect(useTeamStore.getState().cacheInvalidations).toEqual([{ kind: "scheduler" }])
  })

  it("emits scheduler event even if agent stream doesn't exist yet", () => {
    useTeamStore.getState()._handleSSEEvent("tool_end", {
      name: "schedule_task",
      agent: "unknown_agent",
      tool_call_id: "tc-new",
      result: "ok",
    })
    expect(useTeamStore.getState().cacheInvalidations).toEqual([{ kind: "scheduler" }])
  })

  // ── Interaction with other SSE events ────────────────────────────────────

  it("scheduler event is queued after agent_status changes", () => {
    useTeamStore.setState({ sessionId: "sid-19" })
    primeBlock("claude", "schedule_task", "tc-19", { task: "test" })
    useTeamStore.getState()._handleSSEEvent("agent_status", {
      agent: "claude",
      status: "working",
    })
    useTeamStore.getState()._handleSSEEvent("tool_end", {
      name: "schedule_task",
      agent: "claude",
      tool_call_id: "tc-19",
      result: "ok",
    })
    expect(useTeamStore.getState().cacheInvalidations).toEqual([
      { kind: "session_running", sessionId: "sid-19", running: true },
      { kind: "scheduler" },
    ])
  })

  it("scheduler event is queued before done event (and survives the done)", () => {
    useTeamStore.setState({ sessionId: "sid-20" })
    primeBlock("claude", "schedule_task", "tc-20", { task: "test" })
    useTeamStore.getState()._handleSSEEvent("tool_end", {
      name: "schedule_task",
      agent: "claude",
      tool_call_id: "tc-20",
      result: "ok",
    })
    useTeamStore.getState()._handleSSEEvent("done", {})
    // Event was queued during tool_end; done() does not clear the queue
    // (only newSession() and the bridge drain do). done also queues a
    // running-flag patch so running indicators clear.
    expect(useTeamStore.getState().cacheInvalidations).toEqual([
      { kind: "scheduler" },
      { kind: "session_running", sessionId: "sid-20", running: false },
    ])
  })
})
