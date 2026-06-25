import { describe, it, expect, beforeEach } from "bun:test"
import { useTeamStore } from "@/stores/useTeamStore"

/**
 * todo_manage tool suppression and todos-event tests.
 *
 * The todo_manage tool is special: it mutates the todo list but we don't want
 * to show tool blocks for it in the UI (it's handled silently in the background).
 *
 * Behavior at the store level:
 * 1. tool_call event for todo_manage → NO block created (early break)
 * 2. tool_start event for todo_manage → NO block created (early break)
 * 3. tool_end event for todo_manage → NO block completion (early break), but
 *    a ``{ kind: 'todos', sessionId }`` event is pushed onto
 *    ``cacheInvalidations`` (when sessionId is set).
 *
 * The React-side bridge in ``routes/cockpit.tsx`` translates that into a
 * ``queryClient.invalidateQueries({ queryKey: todos(sid) })`` call (covered
 * by the bridge tests in ``team-cache-bridge.test.tsx``).
 *
 * This test suite verifies the store-level behaviour:
 * 1. tool_call for todo_manage does NOT create a block
 * 2. tool_call for other tools DOES create a block (regression guard)
 * 3. tool_start for todo_manage does NOT create a block
 * 4. tool_start for other tools DOES create a block (regression guard)
 * 5. tool_end for todo_manage does NOT call completeTool (no block mutation)
 * 6. tool_end for todo_manage DOES emit a todos event with the
 *    correct sessionId
 * 7. tool_end for other tools DOES call completeTool normally (regression
 *    guard) and emits the correct (non-todo) event
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

describe("useTeamStore — todo_manage suppression and event emission", () => {
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

  // ── tool_call suppression ────────────────────────────────────────────────

  describe("tool_call event suppression", () => {
    it("does NOT create a block for todo_manage tool_call", () => {
      useTeamStore.getState()._handleSSEEvent("tool_call", {
        agent: "lead",
        name: "todo_manage",
        tool_call_id: "tc-todo-1",
      })
      const stream = useTeamStore.getState().agentStreams["lead"]
      // When tool_call is suppressed, the stream may not be created at all
      expect(stream).toBeUndefined()
    })

    it("DOES create a block for non-todo tool_call (regression guard)", () => {
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

    it("does NOT create a block for todo_manage even with multiple calls", () => {
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
      expect(stream).toBeUndefined()
    })

    it("suppresses todo_manage but allows other tools in same turn", () => {
      useTeamStore.getState()._handleSSEEvent("tool_call", {
        agent: "lead",
        name: "todo_manage",
        tool_call_id: "tc-todo-1",
      })
      useTeamStore.getState()._handleSSEEvent("tool_call", {
        agent: "lead",
        name: "web_search",
        tool_call_id: "tc-search-1",
      })
      const stream = useTeamStore.getState().agentStreams["lead"]
      expect(stream.currentBlocks).toHaveLength(1)
      expect(stream.currentBlocks[0].toolName).toBe("web_search")
    })
  })

  // ── tool_start suppression ───────────────────────────────────────────────

  describe("tool_start event suppression", () => {
    it("does NOT create a block for todo_manage tool_start", () => {
      useTeamStore.getState()._handleSSEEvent("tool_start", {
        agent: "lead",
        name: "todo_manage",
        tool_call_id: "tc-todo-1",
        arguments: '{"action":"create","title":"Buy milk"}',
      })
      const stream = useTeamStore.getState().agentStreams["lead"]
      // When tool_start is suppressed, the stream may not be created at all
      expect(stream).toBeUndefined()
    })

    it("DOES create a block for non-todo tool_start (regression guard)", () => {
      useTeamStore.getState()._handleSSEEvent("tool_start", {
        agent: "lead",
        name: "web_search",
        tool_call_id: "tc-search-1",
        arguments: '{"q":"test"}',
      })
      const stream = useTeamStore.getState().agentStreams["lead"]
      expect(stream.currentBlocks).toHaveLength(1)
      expect(stream.currentBlocks[0].type).toBe("tool")
      expect(stream.currentBlocks[0].toolName).toBe("web_search")
      expect(stream.currentBlocks[0].toolArgs).toBe('{"q":"test"}')
    })

    it("does NOT create a block for todo_manage even with complex arguments", () => {
      useTeamStore.getState()._handleSSEEvent("tool_start", {
        agent: "lead",
        name: "todo_manage",
        tool_call_id: "tc-todo-1",
        arguments: '{"action":"update","id":"todo-123","title":"Updated","completed":true}',
      })
      const stream = useTeamStore.getState().agentStreams["lead"]
      expect(stream).toBeUndefined()
    })

    it("suppresses todo_manage but allows other tools in same turn", () => {
      useTeamStore.getState()._handleSSEEvent("tool_start", {
        agent: "lead",
        name: "todo_manage",
        tool_call_id: "tc-todo-1",
        arguments: '{"action":"create"}',
      })
      useTeamStore.getState()._handleSSEEvent("tool_start", {
        agent: "lead",
        name: "web_search",
        tool_call_id: "tc-search-1",
        arguments: '{"q":"test"}',
      })
      const stream = useTeamStore.getState().agentStreams["lead"]
      expect(stream.currentBlocks).toHaveLength(1)
      expect(stream.currentBlocks[0].toolName).toBe("web_search")
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

    it("does NOT create a block for todo_manage output", () => {
      useTeamStore.getState()._handleSSEEvent("tool_output_delta", {
        agent: "lead",
        name: "todo_manage",
        tool_call_id: "tc-todo-1",
        text: "hidden",
      })
      expect(useTeamStore.getState().agentStreams["lead"]).toBeUndefined()
    })
  })

  // ── tool_end: no block completion for todo_manage ──────────────────────

  describe("tool_end event: block completion suppression", () => {
    it("does NOT call completeTool for todo_manage (no block state mutation)", () => {
      // Prime a normal tool block first
      primeBlock("lead", "web_search", "tc-search-1", { q: "test" })
      const blocksBefore = useTeamStore.getState().agentStreams["lead"].currentBlocks.length
      expect(blocksBefore).toBe(1)

      // Now fire tool_end for todo_manage — should NOT mutate any blocks
      useTeamStore.getState()._handleSSEEvent("tool_end", {
        agent: "lead",
        name: "todo_manage",
        tool_call_id: "tc-todo-1",
        result: "Todo created",
      })

      // Block count should remain unchanged (no new block, no mutation)
      const blocksAfter = useTeamStore.getState().agentStreams["lead"].currentBlocks.length
      expect(blocksAfter).toBe(blocksBefore)
    })

    it("DOES call completeTool for non-todo tools (regression guard)", () => {
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

  // ── Cross-agent isolation ────────────────────────────────────────────────

  it("isolates todo_manage suppression per agent", () => {
    useTeamStore.getState()._handleSSEEvent("tool_call", {
      agent: "lead",
      name: "todo_manage",
      tool_call_id: "tc-todo-lead",
    })
    useTeamStore.getState()._handleSSEEvent("tool_call", {
      agent: "worker",
      name: "web_search",
      tool_call_id: "tc-search-worker",
    })
    // lead's todo_manage is suppressed, so no stream created
    expect(useTeamStore.getState().agentStreams["lead"]).toBeUndefined()
    // worker's web_search creates a stream with a block
    expect(useTeamStore.getState().agentStreams["worker"].currentBlocks).toHaveLength(1)
  })
})
