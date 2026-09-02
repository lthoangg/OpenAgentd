import { describe, it, expect, beforeEach } from "bun:test"
import { useAgentStore } from "@/stores/useAgentStore"

/**
 * Coding-mode workspace invalidation.
 *
 * When ``_workspace`` is set (coding mode), file-mutating ``tool_end``
 * events emit a ``coding_workspace`` invalidation keyed by the absolute
 * workspace path instead of a session-scoped ``workspace_files`` event.
 * The bridge then refreshes the files/diff/status queries on the
 * Coding Workspace Sidebar.
 *
 * ``shell`` / ``patch`` / ``generate_image`` always invalidate the
 * workspace regardless of args.
 */

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

function resetStore(overrides: Partial<ReturnType<typeof useAgentStore.getState>> = {}) {
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
    cacheInvalidations: [],
    _workspace: null,
    ...overrides,
  })
}

describe("useAgentStore — coding_workspace invalidation", () => {
  beforeEach(() => resetStore())

  it("emits coding_workspace event when `shell` runs in coding mode (no path arg required)", () => {
    resetStore({ sessionId: "sess-c2", _workspace: "/tmp/proj" })
    primeBlock("claude", "shell", "tc-2", { command: "mkdir build && touch build/out" })
    useAgentStore.getState()._handleSSEEvent("tool_end", {
      name: "shell",
      agent: "claude",
      tool_call_id: "tc-2",
      result: "exit 0",
    })
    expect(useAgentStore.getState().cacheInvalidations).toEqual([
      { kind: "coding_workspace", workspace: "/tmp/proj" },
    ])
  })

  it.each(["generate_image", "generate_video"] as const)(
    "emits broad coding_workspace event when `%s` finishes in coding mode (no extractable path)",
    (toolName) => {
      // The multimodal generators don't surface deterministic output
      // paths in their args. All fall back to broad invalidation.
      resetStore({ sessionId: "sess-c3", _workspace: "/tmp/proj" })
      primeBlock("claude", toolName, `tc-${toolName}`, { foo: "bar" })
      useAgentStore.getState()._handleSSEEvent("tool_end", {
        name: toolName,
        agent: "claude",
        tool_call_id: `tc-${toolName}`,
        result: "ok",
      })
      expect(useAgentStore.getState().cacheInvalidations).toEqual([
        { kind: "coding_workspace", workspace: "/tmp/proj" },
      ])
    },
  )

  it("extracts paths from a `patch` envelope and emits a scoped event", () => {
    resetStore({ sessionId: "sess-c-patch", _workspace: "/tmp/proj" })
    const envelope = [
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "@@",
      "-foo",
      "+bar",
      "*** Add File: src/b.ts",
      "+hello",
      "*** Delete File: src/old.ts",
      "*** End Patch",
    ].join("\n")
    primeBlock("claude", "patch", "tc-p", { patch_text: envelope })
    useAgentStore.getState()._handleSSEEvent("tool_end", {
      name: "patch",
      agent: "claude",
      tool_call_id: "tc-p",
      result: "Patch applied successfully. Updated paths:\nsrc/a.ts\nsrc/b.ts\nsrc/old.ts",
    })
    expect(useAgentStore.getState().cacheInvalidations).toEqual([
      {
        kind: "coding_workspace_paths",
        workspace: "/tmp/proj",
        paths: ["src/a.ts", "src/b.ts", "src/old.ts"],
      },
    ])
  })

  it("falls back to workspace_files (session-scoped) when _workspace is unset", () => {
    resetStore({ sessionId: "sess-n1", _workspace: null })
    const envelope = ["*** Begin Patch", "*** Add File: out.txt", "+hi", "*** End Patch"].join(
      "\n",
    )
    primeBlock("claude", "patch", "tc-n1", { patch_text: envelope })
    useAgentStore.getState()._handleSSEEvent("tool_end", {
      name: "patch",
      agent: "claude",
      tool_call_id: "tc-n1",
      result: "Patch applied successfully. Updated paths:\nout.txt",
    })
    expect(useAgentStore.getState().cacheInvalidations).toEqual([
      { kind: "workspace_files", sessionId: "sess-n1" },
    ])
  })

  it("queues one scoped event per patch across a burst (each carries its own path)", () => {
    resetStore({ sessionId: "sess-c6", _workspace: "/tmp/proj" })
    const state = useAgentStore.getState()
    for (let i = 0; i < 3; i++) {
      const tcid = `tc-burst-${i}`
      const envelope = [
        "*** Begin Patch",
        `*** Add File: f${i}.txt`,
        "+x",
        "*** End Patch",
      ].join("\n")
      primeBlock("claude", "patch", tcid, { patch_text: envelope })
      state._handleSSEEvent("tool_end", {
        name: "patch",
        agent: "claude",
        tool_call_id: tcid,
        result: `Patch applied successfully. Updated paths:\nf${i}.txt`,
      })
    }
    expect(useAgentStore.getState().cacheInvalidations).toEqual([
      { kind: "coding_workspace_paths", workspace: "/tmp/proj", paths: ["f0.txt"] },
      { kind: "coding_workspace_paths", workspace: "/tmp/proj", paths: ["f1.txt"] },
      { kind: "coding_workspace_paths", workspace: "/tmp/proj", paths: ["f2.txt"] },
    ])
  })

  it("falls back to broad coding_workspace when patch args are unparseable", () => {
    // Streaming tool_start may deliver partial JSON — args never
    // fully resolve. The reducer must NOT emit a half-baked path
    // list; it falls back to whole-repo invalidation in that case.
    resetStore({ sessionId: "sess-c-bad", _workspace: "/tmp/proj" })
    primeBlock("claude", "patch", "tc-bad", { patch_text: "*** Begin Patch (incomplete" })
    useAgentStore.getState()._handleSSEEvent("tool_end", {
      name: "patch",
      agent: "claude",
      tool_call_id: "tc-bad",
      result: "boom",
    })
    expect(useAgentStore.getState().cacheInvalidations).toEqual([
      { kind: "coding_workspace", workspace: "/tmp/proj" },
    ])
  })

})
