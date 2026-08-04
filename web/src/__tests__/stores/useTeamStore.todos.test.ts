import { describe, it, expect, beforeEach } from "bun:test"
import { useTeamStore } from "@/stores/useTeamStore"

/**
 * todo_manage tool rendering and todos-event tests.
 *
 * The todo board is the team's coordination backbone: board mutations wake
 * agents and carry delegation briefs / results, so todo_manage tool calls are
 * rendered in the transcript like any other tool (they used to be
 * suppressed).
 *
 * Behavior at the store level:
 * 1. tool_call / tool_start for todo_manage → block created (same as any tool)
 * 2. tool_end for todo_manage → block completed with the board-state result
 * 3. tool_end for todo_manage ALSO pushes ``{ kind: 'todos', sessionId }``
 *    onto ``cacheInvalidations`` (when sessionId is set) so the TodosPopover
 *    query refreshes.
 *
 * The React-side bridge translates the invalidation into a
 * ``queryClient.invalidateQueries({ queryKey: todos(sid) })`` call (covered
 * by the cache-invalidation-bridge tests).
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

describe("useTeamStore — todo_manage rendering and event emission", () => {
  beforeEach(() => {
    useTeamStore.setState({
      agentStreams: {},
      activeAgent: null,
      leadName: null,
      agentNames: [],
      liveAgentNames: null,
      sidebarOpen: false,
      sessionId: "sess-123",
      sessionTitle: null,
      isTeamWorking: false,
      isConnected: false,
      error: null,
      _pendingMessages: [],
      _sessionGeneration: 0,
      cacheInvalidations: [],
    })
  })

  // ── tool_call rendering ──────────────────────────────────────────────────

  describe("tool_call event rendering", () => {
    it("creates a block for todo_manage tool_call (board mutations are visible)", () => {
      useTeamStore.getState()._handleSSEEvent("tool_call", {
        agent: "lead",
        name: "todo_manage",
        tool_call_id: "tc-todo-1",
      })
      const stream = useTeamStore.getState().agentStreams["lead"]
      expect(stream.currentBlocks).toHaveLength(1)
      expect(stream.currentBlocks[0].type).toBe("tool")
      expect(stream.currentBlocks[0].toolName).toBe("todo_manage")
    })

    it("creates a block for non-todo tool_call (regression guard)", () => {
      useTeamStore.getState()._handleSSEEvent("tool_call", {
        agent: "lead",
        name: "web_search",
        tool_call_id: "tc-search-1",
      })
      const stream = useTeamStore.getState().agentStreams["lead"]
      expect(stream.currentBlocks).toHaveLength(1)
      expect(stream.currentBlocks[0].type).toBe("tool")
      expect(stream.currentBlocks[0].toolName).toBe("web_search")
    })

    it("creates one block per todo_manage call", () => {
      useTeamStore.getState()._handleSSEEvent("tool_call", {
        agent: "lead",
        name: "todo_manage",
        tool_call_id: "tc-todo-1",
      })
      useTeamStore.getState()._handleSSEEvent("tool_call", {
        agent: "lead",
        name: "todo_manage",
        tool_call_id: "tc-todo-2",
      })
      const stream = useTeamStore.getState().agentStreams["lead"]
      expect(stream.currentBlocks).toHaveLength(2)
      expect(stream.currentBlocks.every((b) => b.toolName === "todo_manage")).toBe(true)
    })
  })

  // ── tool_start rendering ─────────────────────────────────────────────────

  describe("tool_start event rendering", () => {
    it("creates a block with args for todo_manage tool_start", () => {
      useTeamStore.getState()._handleSSEEvent("tool_start", {
        agent: "lead",
        name: "todo_manage",
        tool_call_id: "tc-todo-1",
        arguments: '{"actions":[{"action":"create","content":"Buy milk"}]}',
      })
      const stream = useTeamStore.getState().agentStreams["lead"]
      expect(stream.currentBlocks).toHaveLength(1)
      expect(stream.currentBlocks[0].type).toBe("tool")
      expect(stream.currentBlocks[0].toolName).toBe("todo_manage")
      expect(stream.currentBlocks[0].toolArgs).toBe(
        '{"actions":[{"action":"create","content":"Buy milk"}]}',
      )
    })

    it("renders todo_manage alongside other tools in the same turn", () => {
      useTeamStore.getState()._handleSSEEvent("tool_start", {
        agent: "lead",
        name: "todo_manage",
        tool_call_id: "tc-todo-1",
        arguments: '{"actions":[{"action":"read"}]}',
      })
      useTeamStore.getState()._handleSSEEvent("tool_start", {
        agent: "lead",
        name: "web_search",
        tool_call_id: "tc-search-1",
        arguments: '{"q":"test"}',
      })
      const stream = useTeamStore.getState().agentStreams["lead"]
      expect(stream.currentBlocks).toHaveLength(2)
      expect(stream.currentBlocks.map((b) => b.toolName)).toEqual([
        "todo_manage",
        "web_search",
      ])
    })
  })

  // ── tool_output_delta: live tool output ──────────────────────────────────

  describe("tool_output_delta event", () => {
    it("appends live output to a matching tool block", () => {
      primeBlock("lead", "shell", "tc-shell-1", { command: "echo hi" })

      useTeamStore.getState()._handleSSEEvent("tool_output_delta", {
        agent: "lead",
        name: "shell",
        tool_call_id: "tc-shell-1",
        text: "hello\n",
      })
      useTeamStore.getState()._handleSSEEvent("tool_output_delta", {
        agent: "lead",
        name: "shell",
        tool_call_id: "tc-shell-1",
        text: "world\n",
      })

      const block = useTeamStore.getState().agentStreams["lead"].currentBlocks[0]
      expect(block.toolOutput).toBe("hello\nworld\n")
    })

    it("routes todo_manage output to its live block", () => {
      primeBlock("lead", "todo_manage", "tc-todo-1", {
        actions: [{ action: "read" }],
      })
      useTeamStore.getState()._handleSSEEvent("tool_output_delta", {
        agent: "lead",
        name: "todo_manage",
        tool_call_id: "tc-todo-1",
        text: "streamed",
      })
      const block = useTeamStore.getState().agentStreams["lead"].currentBlocks[0]
      expect(block.toolOutput).toBe("streamed")
    })
  })

  // ── tool_end: block completion ───────────────────────────────────────────

  describe("tool_end event: block completion", () => {
    it("completes the todo_manage block with the board-state result", () => {
      primeBlock("lead", "todo_manage", "tc-todo-1", {
        actions: [{ action: "claim", task_id: "task_1" }],
      })
      const block = useTeamStore.getState().agentStreams["lead"].currentBlocks[0]
      expect(block.toolDone).toBe(false)

      useTeamStore.getState()._handleSSEEvent("tool_end", {
        agent: "lead",
        name: "todo_manage",
        tool_call_id: "tc-todo-1",
        result: "[task_1] [in_progress] (high) claimed=lead Do the thing",
      })

      const updatedBlock = useTeamStore.getState().agentStreams["lead"].currentBlocks[0]
      expect(updatedBlock.toolDone).toBe(true)
      expect(updatedBlock.toolResult).toBe(
        "[task_1] [in_progress] (high) claimed=lead Do the thing",
      )
    })

    it("completes non-todo tools normally (regression guard)", () => {
      primeBlock("lead", "web_search", "tc-search-1", { q: "test" })
      const block = useTeamStore.getState().agentStreams["lead"].currentBlocks[0]
      expect(block.toolDone).toBe(false)

      useTeamStore.getState()._handleSSEEvent("tool_end", {
        agent: "lead",
        name: "web_search",
        tool_call_id: "tc-search-1",
        result: "search results here",
      })

      const updatedBlock = useTeamStore.getState().agentStreams["lead"].currentBlocks[0]
      expect(updatedBlock.toolDone).toBe(true)
      expect(updatedBlock.toolResult).toBe("search results here")
    })
  })

  // ── tool_end: todos event for todo_manage ──────────────────────

  describe("tool_end event: todos event emission", () => {
    it("emits todos event when tool_end fires with name: 'todo_manage'", () => {
      useTeamStore.getState()._handleSSEEvent("tool_end", {
        agent: "lead",
        name: "todo_manage",
        tool_call_id: "tc-todo-1",
        result: "Todo created",
      })
      expect(useTeamStore.getState().cacheInvalidations).toEqual([
        { kind: "todos", sessionId: "sess-123" },
      ])
    })

    it("uses the correct sessionId from store state", () => {
      useTeamStore.setState({ sessionId: "sess-custom-456" })
      useTeamStore.getState()._handleSSEEvent("tool_end", {
        agent: "lead",
        name: "todo_manage",
        tool_call_id: "tc-todo-1",
        result: "Todo updated",
      })
      expect(useTeamStore.getState().cacheInvalidations).toEqual([
        { kind: "todos", sessionId: "sess-custom-456" },
      ])
    })

    it("does NOT emit todos when sessionId is null", () => {
      useTeamStore.setState({ sessionId: null })
      useTeamStore.getState()._handleSSEEvent("tool_end", {
        agent: "lead",
        name: "todo_manage",
        tool_call_id: "tc-todo-1",
        result: "Todo created",
      })
      expect(useTeamStore.getState().cacheInvalidations).toEqual([])
    })

    it("queues one event per todo_manage mutation in sequence", () => {
      useTeamStore.getState()._handleSSEEvent("tool_end", {
        agent: "lead",
        name: "todo_manage",
        tool_call_id: "tc-todo-1",
        result: "Todo 1 created",
      })
      useTeamStore.getState()._handleSSEEvent("tool_end", {
        agent: "lead",
        name: "todo_manage",
        tool_call_id: "tc-todo-2",
        result: "Todo 2 updated",
      })
      expect(useTeamStore.getState().cacheInvalidations).toEqual([
        { kind: "todos", sessionId: "sess-123" },
        { kind: "todos", sessionId: "sess-123" },
      ])
    })

    it("emits NOTHING when tool_end fires with a non-todo tool (no path match)", () => {
      primeBlock("lead", "web_search", "tc-search-1", { q: "test" })
      useTeamStore.getState()._handleSSEEvent("tool_end", {
        agent: "lead",
        name: "web_search",
        tool_call_id: "tc-search-1",
        result: "search results",
      })
      expect(useTeamStore.getState().cacheInvalidations).toEqual([])
    })

    it("emits scheduler event (not todos) for schedule_task", () => {
      primeBlock("lead", "schedule_task", "tc-sched-1", { task: "daily_standup" })
      useTeamStore.getState()._handleSSEEvent("tool_end", {
        agent: "lead",
        name: "schedule_task",
        tool_call_id: "tc-sched-1",
        result: "Task scheduled",
      })
      // schedule_task emits scheduler, not todos
      expect(useTeamStore.getState().cacheInvalidations).toEqual([{ kind: "scheduler" }])
    })
  })
})
