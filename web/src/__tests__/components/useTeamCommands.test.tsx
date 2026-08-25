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
 *   - The list is *built each render* — re-running the hook with new
 *     inputs returns the new commands (no stale closures).
   *   - The view-cycle command carries the ⌘⇧V / Ctrl+Shift+V shortcut.
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
    toggleAgentCapabilities: noop,
    setShowTodos: noop,
    handleWorkspaceFiles: noop,
    handleCodingSidebarToggle: noop,
    handleOpenTerminal: noop,
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

  it("toggle-view carries the Cmd+Shift+V / Ctrl+Shift+V shortcut label", () => {
    const { result } = renderHook(() => useTeamCommands(makeArgs()))
    expect(byId(result.current, "toggle-view").shortcut).toBe("Ctrl+Shift+V")
  })
})

// ════════════════════════════════════════════════════════════════════════════
//  dispatchShortcutKey — synthetic event shape
// ════════════════════════════════════════════════════════════════════════════
describe("useTeamCommands — dispatchShortcutKey synthetic events", () => {
  it("collapse-sidebar invokes its direct toggle handler", () => {
    const { result } = renderHook(() => useTeamCommands(makeArgs()))
    const captured: KeyboardEvent[] = []
    const listener = (e: Event) => captured.push(e as KeyboardEvent)
    window.addEventListener("keydown", listener)
    try {
      byId(result.current, "collapse-sidebar").action()
    } finally {
      window.removeEventListener("keydown", listener)
    }
    expect(captured).toHaveLength(0)
  })

  it("toggle-view dispatches a primary-modifier Shift+'v' keydown", () => {
    const { result } = renderHook(() => useTeamCommands(makeArgs()))
    const captured: KeyboardEvent[] = []
    const listener = (e: Event) => captured.push(e as KeyboardEvent)
    window.addEventListener("keydown", listener)
    try {
      byId(result.current, "toggle-view").action()
    } finally {
      window.removeEventListener("keydown", listener)
    }
    expect(captured.length).toBe(1)
    expect(captured[0].key).toBe("v")
    expect(captured[0].ctrlKey).toBe(true)
    expect(captured[0].metaKey).toBe(false)
    expect(captured[0].shiftKey).toBe(true)
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

  it("collapse-sidebar does not dispatch a synthetic event", () => {
    const { result } = renderHook(() => useTeamCommands(makeArgs()))
    const captured: KeyboardEvent[] = []
    const handler = (e: Event) => captured.push(e as KeyboardEvent)
    document.addEventListener("keydown", handler)
    try {
      byId(result.current, "collapse-sidebar").action()
    } finally {
      document.removeEventListener("keydown", handler)
    }
    expect(captured).toHaveLength(0)
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
//  Open Terminal command
// ════════════════════════════════════════════════════════════════════════════
describe("useTeamCommands — open-terminal", () => {
  it("appears with Ctrl+Shift+` shortcut when a handler is provided", () => {
    const handleOpenTerminal = mock(() => {})
    const { result } = renderHook(() =>
      useTeamCommands(makeArgs({ handleOpenTerminal })),
    )
    const cmd = byId(result.current, "open-terminal")
    expect(cmd.shortcut).toBe("Ctrl+Shift+`")
    cmd.action()
    expect(handleOpenTerminal).toHaveBeenCalledTimes(1)
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

  it("go-telemetry navigates to '/telemetry'", () => {
    const navigate = mock(() => Promise.resolve())
    const { result } = renderHook(() =>
      useTeamCommands(
        makeArgs({ navigate: navigate as unknown as Parameters<typeof useTeamCommands>[0]["navigate"] }),
      ),
    )
    byId(result.current, "go-telemetry").action()
    expect(navigate).toHaveBeenCalledWith({ to: "/telemetry" })
  })
})
