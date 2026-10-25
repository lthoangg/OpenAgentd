import { describe, it, expect, beforeEach } from "bun:test"
import { useAgentStore } from "@/stores/useAgentStore"

function primeBlock(
  agent: string,
  toolName: string,
  toolCallId: string,
  args: Record<string, unknown>,
) {
  const state = useAgentStore.getState()
  state._handleSSEEvent("tool_call", { name: toolName, agent, tool_call_id: toolCallId })
  state._handleSSEEvent("tool_start", {
    name: toolName,
    agent,
    tool_call_id: toolCallId,
    arguments: JSON.stringify(args),
  })
}

describe("useAgentStore — renamed tools refresh what they changed", () => {
  beforeEach(() => {
    useAgentStore.setState({
      agentStreams: {},
      leadName: null,
      agentNames: [],
      liveAgentNames: null,
      sidebarOpen: false,
      sessionId: null,
      sessionTitle: null,
      isAgentWorking: false,
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

  // The backend renamed schedule_task → schedule, todo_manage → todo and
  // delegate → team; live turns now stream the new names.
  for (const [name, kind] of [["schedule", "scheduler"], ["todo", "todos"], ["team", "subagents"]] as const) {
    it(`emits a ${kind} event when ${name} completes`, () => {
      useAgentStore.setState({ sessionId: "s-1" })
      primeBlock("lead", name, `tc-${name}`, { action: "list" })
      useAgentStore.getState()._handleSSEEvent("tool_end", { name, agent: "lead", tool_call_id: `tc-${name}`, result: "ok" })
      const events = useAgentStore.getState().cacheInvalidations
      expect(events.some((e) => e.kind === kind)).toBe(true)
    })
  }
})
