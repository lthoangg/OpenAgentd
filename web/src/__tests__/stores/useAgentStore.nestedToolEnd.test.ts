import { describe, it, expect, beforeEach } from "bun:test"
import { useAgentStore } from "@/stores/useAgentStore"
import { runOf } from '@/stores/useAgentStore/run-state'
import { linkOf } from '@/stores/useAgentStore/link-state'

/**
 * A ``script`` runs its tool calls without cards of their own; each one
 * that ends sends ``nested_tool_end``. The panels a direct call refreshes
 * (files, Git, todos, schedules) refresh the same way.
 */

function resetStore(overrides: Partial<ReturnType<typeof useAgentStore.getState>> = {}) {
  useAgentStore.setState({
    agentStreams: {},
    leadName: null,
    agentNames: [],
    liveAgentNames: null,
    sidebarOpen: false,
    sessionId: null,
    sessionTitle: null,
    sessionRun: runOf(false),
    streamLink: linkOf(false),
    error: null,
    _pendingMessages: [],
    _sessionGeneration: 0,
    cacheInvalidations: [],
    _workspace: null,
    ...overrides,
  })
}

function startScript(agent = "lead", id = "s1") {
  const state = useAgentStore.getState()
  state._handleSSEEvent("tool_call", { name: "script", agent, tool_call_id: id })
  state._handleSSEEvent("tool_start", { name: "script", agent, tool_call_id: id, arguments: '{"code":"…"}' })
}

function nestedEnd(name: string, args: Record<string, unknown>, id = "s1.1") {
  useAgentStore.getState()._handleSSEEvent("nested_tool_end", {
    agent: "lead",
    tool_call_id: id,
    name,
    arguments: JSON.stringify(args),
    metadata: {},
  })
}

function toolBlocks() {
  return useAgentStore.getState().agentStreams.lead.currentBlocks.filter((b) => b.type === "tool")
}

describe("useAgentStore — nested_tool_end (calls inside a script)", () => {
  beforeEach(() => resetStore())

  it("refreshes the paths a nested patch changed", () => {
    resetStore({ sessionId: "sess-1", _workspace: "/tmp/proj" })
    startScript()
    const envelope = ["*** Begin Patch", "*** Update File: src/a.ts", "@@", "-a", "+b", "*** End Patch"].join("\n")
    nestedEnd("patch", { patch_text: envelope })
    expect(useAgentStore.getState().cacheInvalidations).toEqual([
      { kind: "coding_workspace_paths", workspace: "/tmp/proj", paths: ["src/a.ts"] },
    ])
  })

  it("refreshes the whole workspace after a nested shell", () => {
    resetStore({ sessionId: "sess-1", _workspace: "/tmp/proj" })
    startScript()
    nestedEnd("shell", { command: "touch x" })
    expect(useAgentStore.getState().cacheInvalidations).toEqual([{ kind: "coding_workspace", workspace: "/tmp/proj" }])
  })

  it("refreshes the todo board after a nested todo", () => {
    resetStore({ sessionId: "sess-1" })
    startScript()
    nestedEnd("todo", { actions: [{ action: "create", content: "x" }] })
    expect(useAgentStore.getState().cacheInvalidations).toEqual([{ kind: "todos", sessionId: "sess-1" }])
  })

  it("refreshes the schedule list after a nested schedule", () => {
    resetStore({ sessionId: "sess-1" })
    startScript()
    nestedEnd("schedule", { action: "list" })
    expect(useAgentStore.getState().cacheInvalidations).toEqual([{ kind: "scheduler" }])
  })

  it("refreshes nothing after a read-only nested call", () => {
    resetStore({ sessionId: "sess-1", _workspace: "/tmp/proj" })
    startScript()
    nestedEnd("grep", { pattern: "TODO" })
    expect(useAgentStore.getState().cacheInvalidations).toEqual([])
  })

  it("leaves the script as the only card, still running", () => {
    resetStore({ sessionId: "sess-1", _workspace: "/tmp/proj" })
    startScript()
    nestedEnd("todo", { actions: [] }, "s1.1")
    nestedEnd("shell", { command: "ls" }, "s1.2")
    const tools = toolBlocks()
    expect(tools.map((b) => [b.toolName, b.toolDone ?? false])).toEqual([["script", false]])
  })
})
