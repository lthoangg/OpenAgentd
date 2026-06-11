/**
 * Tests for ``components/TeamChatView/useTeamCommands.ts`` — the
 * command-palette command list factory.
 *
 * The hook returns *pure data* (a Command[] array) derived from
 * inputs, so we exercise it through a tiny test harness that calls
 * the hook and exposes the result to assertions.
 *
 * Invariants we verify:
 *
 *   - Every shortcut is rendered as a literal ``Ctrl+X`` string
 *     (no platform-specific glyphs, no ⌘/Cmd anywhere). This is the
 *     contract documented in ``hooks/useKeyboardShortcuts.ts``.
 *   - ``dispatchCtrlKey(key)``-style commands actually dispatch a
 *     keydown event with ``ctrlKey: true`` and ``metaKey: false``,
 *     so the global shortcut handler (which checks
 *     ``e.ctrlKey && !e.metaKey``) fires.
 *   - ``mode === 'coding'`` swaps the sidebar / workspace commands.
 *   - Per-agent ``View`` commands include each agent.
 *   - The list is *built each render* — re-running the hook with new
 *     inputs returns the new commands (no stale closures).
 */
import { describe, it, expect, afterEach, mock } from "bun:test"
import { renderHook, cleanup } from "@testing-library/react"
import { useTeamCommands } from "@/components/TeamChatView/useTeamCommands"
import type { Command } from "@/components/CommandPalette"
import type { ViewMode } from "@/components/TeamChatView/types"

afterEach(cleanup)

/** Build a fully-populated args object with sensible defaults. */
function makeArgs(overrides: Partial<Parameters<typeof useTeamCommands>[0]> = {}) {
  const noop = () => {}
  return {
    viewMode: "agent" as ViewMode,
    cycleViewMode: noop,
    setViewMode: noop,
    toggleAgentCapabilities: noop,
    setShowTodos: noop,
    handleWorkspaceFiles: noop,
    handleCodingSidebarToggle: noop,
    mode: "normal" as const,
    handleNewSession: noop,
    handleDreamRun: noop,
    agentNames: [] as string[],
    leadName: null,
    cycleActiveAgent: noop,
    setActiveAgent: noop,
    // navigate is only called inside action lambdas; tests that need
    // it pass their own spy.
    navigate: mock(() => Promise.resolve()) as unknown as Parameters<
      typeof useTeamCommands
    >[0]["navigate"],
    ...overrides,
  }
}

/** Find a command by ``id`` or throw. */
function byId(cmds: Command[], id: string): Command {
  const cmd = cmds.find((c) => c.id === id)
  if (!cmd) throw new Error(`Command not found: ${id}. Available: ${cmds.map((c) => c.id).join(", ")}`)
  return cmd
}

// ════════════════════════════════════════════════════════════════════════════
//  Shortcut strings — Ctrl+X literals only
// ════════════════════════════════════════════════════════════════════════════
describe("useTeamCommands — shortcut labels", () => {
  it("all shortcut strings start with literal 'Ctrl+'", () => {
    const { result } = renderHook(() => useTeamCommands(makeArgs()))
    for (const cmd of result.current) {
      if (!cmd.shortcut) continue
      expect(cmd.shortcut).toMatch(/^Ctrl\+/)
    }
  })

  it("no shortcut uses ⌘ or 'Cmd' (Ctrl-everywhere policy)", () => {
    const { result } = renderHook(() => useTeamCommands(makeArgs()))
    for (const cmd of result.current) {
      if (!cmd.shortcut) continue
      expect(cmd.shortcut).not.toContain("⌘")
      expect(cmd.shortcut.toLowerCase()).not.toContain("cmd")
      expect(cmd.shortcut.toLowerCase()).not.toContain("meta")
      expect(cmd.shortcut).not.toContain("Mod+")
    }
  })

  it("documented shortcuts are present with their literal labels", () => {
    const { result } = renderHook(() => useTeamCommands(makeArgs()))
    expect(byId(result.current, "new-chat").shortcut).toBe("Ctrl+N")
    expect(byId(result.current, "toggle-view").shortcut).toBe("Ctrl+V")
    expect(byId(result.current, "agent-info").shortcut).toBe("Ctrl+A")
    expect(byId(result.current, "todos").shortcut).toBe("Ctrl+T")
    expect(byId(result.current, "workspace-files").shortcut).toBe("Ctrl+F")
    expect(byId(result.current, "wiki").shortcut).toBe("Ctrl+M")
    expect(byId(result.current, "scheduled-tasks").shortcut).toBe("Ctrl+S")
    expect(byId(result.current, "collapse-sidebar").shortcut).toBe("Ctrl+B")
  })
})

// ════════════════════════════════════════════════════════════════════════════
//  dispatchCtrlKey — synthetic event shape
// ════════════════════════════════════════════════════════════════════════════
describe("useTeamCommands — dispatchCtrlKey synthetic events", () => {
  it("collapse-sidebar (normal mode) dispatches Ctrl+b keydown", () => {
    const { result } = renderHook(() => useTeamCommands(makeArgs()))
    const captured: KeyboardEvent[] = []
    const listener = (e: Event) => captured.push(e as KeyboardEvent)
    window.addEventListener("keydown", listener)
    try {
      byId(result.current, "collapse-sidebar").action()
    } finally {
      window.removeEventListener("keydown", listener)
    }
    expect(captured.length).toBe(1)
    expect(captured[0].key).toBe("b")
    expect(captured[0].ctrlKey).toBe(true)
    expect(captured[0].metaKey).toBe(false)
    expect(captured[0].bubbles).toBe(true)
  })

  it("wiki action dispatches Ctrl+m keydown", () => {
    const { result } = renderHook(() => useTeamCommands(makeArgs()))
    const captured: KeyboardEvent[] = []
    const listener = (e: Event) => captured.push(e as KeyboardEvent)
    window.addEventListener("keydown", listener)
    try {
      byId(result.current, "wiki").action()
    } finally {
      window.removeEventListener("keydown", listener)
    }
    expect(captured.length).toBe(1)
    expect(captured[0].key).toBe("m")
    expect(captured[0].ctrlKey).toBe(true)
    expect(captured[0].metaKey).toBe(false)
  })

  it("scheduled-tasks dispatches Ctrl+s keydown", () => {
    const { result } = renderHook(() => useTeamCommands(makeArgs()))
    const captured: KeyboardEvent[] = []
    const listener = (e: Event) => captured.push(e as KeyboardEvent)
    window.addEventListener("keydown", listener)
    try {
      byId(result.current, "scheduled-tasks").action()
    } finally {
      window.removeEventListener("keydown", listener)
    }
    expect(captured.length).toBe(1)
    expect(captured[0].key).toBe("s")
    expect(captured[0].ctrlKey).toBe(true)
    expect(captured[0].metaKey).toBe(false)
  })

  it("dispatched events would trigger a Ctrl-only useKeyboardShortcuts handler", () => {
    // Integration smoke check: the global handler uses
    // ``e.ctrlKey && !e.metaKey`` so our synthetic events must satisfy
    // exactly that predicate.
    const { result } = renderHook(() => useTeamCommands(makeArgs()))
    const captured: KeyboardEvent[] = []
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.metaKey) captured.push(e)
    }
    window.addEventListener("keydown", handler)
    try {
      byId(result.current, "wiki").action()
      byId(result.current, "scheduled-tasks").action()
    } finally {
      window.removeEventListener("keydown", handler)
    }
    expect(captured.map((e) => e.key)).toEqual(["m", "s"])
  })
})

// ════════════════════════════════════════════════════════════════════════════
//  viewMode-conditional commands
// ════════════════════════════════════════════════════════════════════════════
describe("useTeamCommands — viewMode-gated commands", () => {
  it("toggle-view label reflects current mode (cycle: agent → split)", () => {
    const agent = renderHook(() => useTeamCommands(makeArgs({ viewMode: "agent" })))
    expect(byId(agent.result.current, "toggle-view").label).toBe("Switch to Split View")

    const split = renderHook(() => useTeamCommands(makeArgs({ viewMode: "split" })))
    expect(byId(split.result.current, "toggle-view").label).toBe("Switch to Agent View")
  })
})

// ════════════════════════════════════════════════════════════════════════════
//  mode (normal vs coding) swap
// ════════════════════════════════════════════════════════════════════════════
describe("useTeamCommands — coding mode swap", () => {
  it("normal mode shows 'Toggle Workspace Files' and 'Toggle Sidebar'", () => {
    const { result } = renderHook(() => useTeamCommands(makeArgs({ mode: "normal" })))
    expect(byId(result.current, "workspace-files").label).toBe("Toggle Workspace Files")
    expect(byId(result.current, "collapse-sidebar").label).toBe("Toggle Sidebar")
  })

  it("coding mode shows 'Open Changed & Files' and 'Toggle Coding Sidebar'", () => {
    const { result } = renderHook(() => useTeamCommands(makeArgs({ mode: "coding" })))
    expect(byId(result.current, "workspace-files").label).toBe("Open Changed & Files")
    expect(byId(result.current, "collapse-sidebar").label).toBe("Toggle Coding Sidebar")
  })

  it("coding mode collapse-sidebar uses the dedicated handler (not dispatchCtrlKey)", () => {
    let invoked = 0
    const handleCodingSidebarToggle = () => {
      invoked++
    }
    const { result } = renderHook(() =>
      useTeamCommands(makeArgs({ mode: "coding", handleCodingSidebarToggle })),
    )
    // Action should call the handler directly — NOT dispatch a Ctrl+b
    // event (which would no-op in coding mode where there's no global
    // Ctrl+b sidebar handler bound).
    const captured: KeyboardEvent[] = []
    const listener = (e: Event) => captured.push(e as KeyboardEvent)
    window.addEventListener("keydown", listener)
    try {
      byId(result.current, "collapse-sidebar").action()
    } finally {
      window.removeEventListener("keydown", listener)
    }
    expect(invoked).toBe(1)
    expect(captured.length).toBe(0)
  })

  it("coding mode hides the go-coding navigation command", () => {
    const { result } = renderHook(() => useTeamCommands(makeArgs({ mode: "coding" })))
    expect(result.current.find((c) => c.id === "go-coding")).toBeUndefined()
  })

  it("normal mode includes the go-coding navigation command", () => {
    const { result } = renderHook(() => useTeamCommands(makeArgs({ mode: "normal" })))
    expect(result.current.find((c) => c.id === "go-coding")).toBeDefined()
  })
})

// ════════════════════════════════════════════════════════════════════════════
//  Per-agent commands
// ════════════════════════════════════════════════════════════════════════════
describe("useTeamCommands — per-agent commands", () => {
  it("emits switch-<name> commands for worker agents only", () => {
    const args = makeArgs({
      agentNames: ["alice", "bob", "charlie"],
      leadName: "alice",
    })
    const { result } = renderHook(() => useTeamCommands(args))
    expect(result.current.find((c) => c.id === "switch-alice")).toBeUndefined()
    expect(result.current.find((c) => c.id === "switch-bob")).toBeDefined()
    expect(result.current.find((c) => c.id === "switch-charlie")).toBeDefined()
  })

  it("marks switchable agents as workers", () => {
    const args = makeArgs({
      agentNames: ["alice", "bob"],
      leadName: "alice",
    })
    const { result } = renderHook(() => useTeamCommands(args))
    expect(byId(result.current, "switch-bob").description).toBe("Worker agent")
  })

  it("uses 'View <name>' label in every view mode", () => {
    for (const viewMode of ["agent", "split"] as const) {
      const args = makeArgs({
        viewMode,
        agentNames: ["alice"],
      })
      const { result } = renderHook(() => useTeamCommands(args))
      expect(byId(result.current, "switch-alice").label).toBe("View alice")
      cleanup()
    }
  })

  it("agent-switch action sets view + active agent", () => {
    const setViewMode = mock(() => {}) as unknown as (m: ViewMode) => void
    const setActiveAgent = mock(() => {}) as unknown as (n: string) => void
    const args = makeArgs({
      viewMode: "split",
      agentNames: ["alice"],
      setViewMode,
      setActiveAgent,
    })
    const { result } = renderHook(() => useTeamCommands(args))
    byId(result.current, "switch-alice").action()
    expect(setViewMode).toHaveBeenCalledWith("agent")
    expect(setActiveAgent).toHaveBeenCalledWith("alice")
  })

  it("next/prev call cycleActiveAgent with the right direction", () => {
    const cycle = mock(() => {}) as unknown as (dir: "next" | "prev") => void
    const args = makeArgs({
      viewMode: "agent",
      agentNames: ["alice", "bob"],
      cycleActiveAgent: cycle,
    })
    const { result } = renderHook(() => useTeamCommands(args))
    byId(result.current, "next-agent").action()
    byId(result.current, "prev-agent").action()
    expect(cycle).toHaveBeenCalledTimes(2)
    expect(cycle).toHaveBeenNthCalledWith(1, "next")
    expect(cycle).toHaveBeenNthCalledWith(2, "prev")
  })
})

// ════════════════════════════════════════════════════════════════════════════
//  Navigation commands
// ════════════════════════════════════════════════════════════════════════════
describe("useTeamCommands — navigation", () => {
  it("go-home navigates to '/'", () => {
    const navigate = mock(() => Promise.resolve())
    const { result } = renderHook(() =>
      useTeamCommands(
        makeArgs({ navigate: navigate as unknown as Parameters<typeof useTeamCommands>[0]["navigate"] }),
      ),
    )
    byId(result.current, "go-home").action()
    expect(navigate).toHaveBeenCalledWith({ to: "/" })
  })

  it("go-settings navigates to /settings/agents", () => {
    const navigate = mock(() => Promise.resolve())
    const { result } = renderHook(() =>
      useTeamCommands(
        makeArgs({ navigate: navigate as unknown as Parameters<typeof useTeamCommands>[0]["navigate"] }),
      ),
    )
    byId(result.current, "go-settings").action()
    expect(navigate).toHaveBeenCalledWith({ to: "/settings/agents" })
  })

  it("edit-<agent> commands route to /settings/agents/$name with the right param", () => {
    const navigate = mock(() => Promise.resolve())
    const { result } = renderHook(() =>
      useTeamCommands(
        makeArgs({
          agentNames: ["alice"],
          navigate: navigate as unknown as Parameters<typeof useTeamCommands>[0]["navigate"],
        }),
      ),
    )
    byId(result.current, "edit-alice").action()
    expect(navigate).toHaveBeenCalledWith({
      to: "/settings/agents/$name",
      params: { name: "alice" },
    })
  })
})
