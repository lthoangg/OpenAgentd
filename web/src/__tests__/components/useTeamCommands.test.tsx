/**
 * Tests for ``components/TeamChatView/useTeamCommands.ts`` — the
 * command-palette command list factory.
 *
 * The hook returns *pure data* (a Command[] array) derived from
 * inputs, so we exercise it through a tiny test harness that calls
 * the hook and exposes the result to assertions.
 *
 * Platform note: these tests run under happy-dom, whose ``navigator``
 * resolves to an unrecognised platform (see ``use-platform.ts``), so
 * ``formatShortcut`` takes the non-macOS branch and every shortcut
 * label below is a literal ``Ctrl+X`` (or ``Ctrl+Shift+X``) string.
 *
 * Invariants we verify:
 *
 *   - Shortcut strings match the platform's primary-modifier label.
 *   - ``dispatchShortcutKey(key, os)``-style commands actually dispatch
 *     a keydown event with ``ctrlKey: true`` and ``metaKey: false`` on
 *     this non-mac test platform, so the global shortcut handler (which
 *     uses ``isPrimaryShortcut``) fires.
 *   - ``mode === 'coding'`` swaps the sidebar / workspace commands.
 *   - The list is *built each render* — re-running the hook with new
 *     inputs returns the new commands (no stale closures).
 *   - The view-cycle command no longer carries a dedicated shortcut
 *     (palette-only, per the low-frequency-action redesign).
 */
import { describe, it, expect, afterEach, mock } from "bun:test"
import { renderHook, cleanup } from "@testing-library/react"
import { useTeamCommands } from "@/components/TeamChatView/useTeamCommands"
import { useSettingsStore } from "@/stores/useSettingsStore"
import type { Command } from "@/components/CommandPalette"
import type { ViewMode } from "@/components/TeamChatView/types"

afterEach(cleanup)

/** Build a fully-populated args object with sensible defaults. */
function makeArgs(overrides: Partial<Parameters<typeof useTeamCommands>[0]> = {}) {
  const noop = () => {}
  return {
    viewMode: "agent" as ViewMode,
    cycleViewMode: noop,
    toggleAgentCapabilities: noop,
    setShowTodos: noop,
    handleWorkspaceFiles: noop,
    handleCodingSidebarToggle: noop,
    mode: "normal" as const,
    handleNewSession: noop,
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
//  Shortcut strings — platform-formatted labels
// ════════════════════════════════════════════════════════════════════════════
describe("useTeamCommands — shortcut labels", () => {
  it("documented shortcuts are present with their platform-formatted labels", () => {
    const { result } = renderHook(() => useTeamCommands(makeArgs()))
    expect(byId(result.current, "new-chat").shortcut).toBe("Ctrl+N")
    expect(byId(result.current, "agent-info").shortcut).toBe("Ctrl+Shift+A")
    expect(byId(result.current, "todos").shortcut).toBe("Ctrl+T")
    expect(byId(result.current, "workspace-files").shortcut).toBe("Ctrl+F")
    expect(byId(result.current, "scheduled-tasks").shortcut).toBe("Ctrl+S")
    expect(byId(result.current, "collapse-sidebar").shortcut).toBe("Ctrl+B")
    expect(byId(result.current, "go-settings").shortcut).toBe("Ctrl+,")
  })

  it("toggle-view has no dedicated shortcut (palette-only, low-frequency action)", () => {
    const { result } = renderHook(() => useTeamCommands(makeArgs()))
    expect(byId(result.current, "toggle-view").shortcut).toBeUndefined()
  })
})

// ════════════════════════════════════════════════════════════════════════════
//  dispatchShortcutKey — synthetic event shape
// ════════════════════════════════════════════════════════════════════════════
describe("useTeamCommands — dispatchShortcutKey synthetic events", () => {
  it("collapse-sidebar (normal mode) dispatches a primary-modifier 'b' keydown", () => {
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

  it("scheduled-tasks dispatches a primary-modifier 's' keydown", () => {
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
    // Integration smoke check: on this non-mac test platform the global
    // handler expects ``e.ctrlKey && !e.metaKey`` so our synthetic events
    // must satisfy exactly that predicate.
    const { result } = renderHook(() => useTeamCommands(makeArgs()))
    const captured: KeyboardEvent[] = []
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.metaKey) captured.push(e)
    }
    window.addEventListener("keydown", handler)
    try {
      byId(result.current, "scheduled-tasks").action()
    } finally {
      window.removeEventListener("keydown", handler)
    }
    expect(captured.map((e) => e.key)).toEqual(["s"])
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

  it("coding mode collapse-sidebar uses the dedicated handler (not dispatchShortcutKey)", () => {
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

  it("go-settings opens the Settings modal at the agents section", () => {
    const openSettings = mock(() => {})
    useSettingsStore.setState({ openSettings })

    const { result } = renderHook(() => useTeamCommands(makeArgs()))
    byId(result.current, "go-settings").action()
    expect(openSettings).toHaveBeenCalledWith("agents")
  })
})
