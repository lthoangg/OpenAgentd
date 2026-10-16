/**
 * Tests for ``components/AgentChatView/useAgentCommands.ts`` — the
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
 *   - Commands call their shell handler directly rather than
 *     synthesizing a keydown.
 *   - The list is *built each render* — re-running the hook with new
 *     inputs returns the new commands (no stale closures).
 */
import { describe, it, expect, afterEach, mock } from "bun:test"
import { act, renderHook, cleanup } from "@testing-library/react"
import { useAgentCommands } from "@/components/AgentChatView/useAgentCommands"
import { useSettingsStore } from "@/stores/useSettingsStore"
import { useUIStore } from "@/stores/useUIStore"
import { useDisplayPrefsStore } from "@/stores/useDisplayPrefsStore"
import { THEME_STORAGE_KEY } from "@/lib/theme"
import type { Command } from "@/components/CommandPalette"

afterEach(cleanup)

/** Build a fully-populated args object with sensible defaults. */
function makeArgs(overrides: Partial<Parameters<typeof useAgentCommands>[0]> = {}) {
  const noop = () => {}
  return {
    toggleAgentCapabilities: noop,
    toggleTasks: noop,
    toggleScheduler: noop,
    handleWorkspaceFiles: noop,
    handleSidebarToggle: noop,
    handleOpenTerminal: noop,
    handleNewSession: noop,
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
describe("useAgentCommands — shortcut labels", () => {
  it("documented shortcuts are present with their platform-formatted labels", () => {
    const { result } = renderHook(() => useAgentCommands(makeArgs()))
    expect(byId(result.current, "new-chat").shortcut).toBe("Ctrl+N")
    expect(byId(result.current, "agent-info").shortcut).toBe("Ctrl+Shift+A")
    expect(byId(result.current, "todos").shortcut).toBe("Ctrl+T")
    expect(byId(result.current, "workspace-files").shortcut).toBe("Ctrl+D")
    expect(byId(result.current, "scheduled-tasks").shortcut).toBeUndefined()
    expect(byId(result.current, "collapse-sidebar").shortcut).toBe("Ctrl+B")
    expect(byId(result.current, "go-settings").shortcut).toBe("Ctrl+,")
    expect(byId(result.current, "new-chat").label).toBe("New Session")
    expect(result.current.find((c) => c.id === "go-home")).toBeUndefined()
  })

  it("lists Maximize Review Dock only when a dock handler is provided", () => {
    const noDock = renderHook(() => useAgentCommands(makeArgs()))
    expect(noDock.result.current.find((c) => c.id === "maximize-dock")).toBeUndefined()

    const toggle = mock(() => {})
    const withDock = renderHook(() => useAgentCommands(makeArgs({ handleToggleDockMaximized: toggle })))
    const cmd = byId(withDock.result.current, "maximize-dock")
    expect(cmd.shortcut).toBe("Ctrl+Shift+D")
    cmd.action()
    expect(toggle).toHaveBeenCalledTimes(1)
  })

  it("Task List runs the shared tasks toggle (dock tab or popover)", () => {
    const toggleTasks = mock(() => {})
    const { result } = renderHook(() => useAgentCommands(makeArgs({ toggleTasks })))
    byId(result.current, "todos").action()
    expect(toggleTasks).toHaveBeenCalledTimes(1)
  })

  it("lists Open Plan only while the session has a plan", () => {
    const noPlan = renderHook(() => useAgentCommands(makeArgs()))
    expect(noPlan.result.current.find((c) => c.id === "open-plan")).toBeUndefined()

    const handleOpenPlan = mock(() => {})
    const withPlan = renderHook(() => useAgentCommands(makeArgs({ handleOpenPlan })))
    const cmd = byId(withPlan.result.current, "open-plan")
    expect(cmd.label).toBe("Open Plan")
    expect(cmd.description).toBe("View or edit this session's plan")
    cmd.action()
    expect(handleOpenPlan).toHaveBeenCalledTimes(1)
  })

  it("says when the plan is waiting for review", () => {
    const { result } = renderHook(() => useAgentCommands(makeArgs({ handleOpenPlan: () => {}, planAwaitingReview: true })))
    expect(byId(result.current, "open-plan").description).toMatch(/^Waiting for your review/)
  })

  it("names Ctrl+D Toggle Review Dock and lists Open Git only for project workspaces", () => {
    const noGit = renderHook(() => useAgentCommands(makeArgs()))
    expect(byId(noGit.result.current, "workspace-files").label).toBe("Toggle Review Dock")
    expect(noGit.result.current.find((c) => c.id === "open-git")).toBeUndefined()

    const handleOpenGit = mock(() => {})
    const withGit = renderHook(() => useAgentCommands(makeArgs({ handleOpenGit })))
    const cmd = byId(withGit.result.current, "open-git")
    expect(cmd.label).toBe("Open Git")
    expect(cmd.shortcut).toBe("Ctrl+Shift+G")
    cmd.action()
    expect(handleOpenGit).toHaveBeenCalledTimes(1)
  })
})

// ════════════════════════════════════════════════════════════════════════════
//  Direct handlers — no synthetic key events
// ════════════════════════════════════════════════════════════════════════════
describe("useAgentCommands — direct handlers", () => {
  it("scheduled-tasks runs the shell's scheduler toggle without a key event", () => {
    const toggleScheduler = mock(() => {})
    const { result } = renderHook(() => useAgentCommands(makeArgs({ toggleScheduler })))
    const captured: KeyboardEvent[] = []
    const handler = (e: Event) => captured.push(e as KeyboardEvent)
    document.addEventListener("keydown", handler)
    try {
      byId(result.current, "scheduled-tasks").action()
    } finally {
      document.removeEventListener("keydown", handler)
    }
    expect(toggleScheduler).toHaveBeenCalledTimes(1)
    expect(captured).toHaveLength(0)
  })

  it("collapse-sidebar does not dispatch a synthetic event", () => {
    const { result } = renderHook(() => useAgentCommands(makeArgs()))
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
//  Reload Window — desktop only (⌘R has no accelerator there)
// ════════════════════════════════════════════════════════════════════════════
describe("useAgentCommands — reload-window", () => {
  const tauriWindow = window as unknown as { __TAURI_INTERNALS__?: unknown }
  afterEach(() => { delete tauriWindow.__TAURI_INTERNALS__ })

  it("is absent in the browser, which has its own reload", () => {
    const { result } = renderHook(() => useAgentCommands(makeArgs()))
    expect(result.current.find((c) => c.id === "reload-window")).toBeUndefined()
  })

  it("is listed inside the desktop app", () => {
    tauriWindow.__TAURI_INTERNALS__ = {}
    const { result } = renderHook(() => useAgentCommands(makeArgs()))
    const cmd = byId(result.current, "reload-window")
    expect(cmd.label).toBe("Reload Window")
    expect(cmd.shortcut).toBeUndefined()
  })
})

// ════════════════════════════════════════════════════════════════════════════
//  Open Terminal command
// ════════════════════════════════════════════════════════════════════════════
describe("useAgentCommands — open-terminal", () => {
  it("appears with Ctrl+Shift+` shortcut when a handler is provided", () => {
    const handleOpenTerminal = mock(() => {})
    const { result } = renderHook(() =>
      useAgentCommands(makeArgs({ handleOpenTerminal })),
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
describe("useAgentCommands — navigation", () => {
  it("go-settings opens the Settings modal at the agents section", () => {
    const openSettings = mock(() => {})
    useSettingsStore.setState({ openSettings })

    const { result } = renderHook(() => useAgentCommands(makeArgs()))
    byId(result.current, "go-settings").action()
    expect(openSettings).toHaveBeenCalledWith("agents")
  })

  it("go-telemetry opens the telemetry overlay", () => {
    const { result } = renderHook(() => useAgentCommands(makeArgs()))
    byId(result.current, "go-telemetry").action()
    expect(useUIStore.getState().telemetryOpen).toBe(true)
    useUIStore.getState().closeTelemetry()
  })

  it("offers each theme and applies the one chosen", () => {
    const { result } = renderHook(() => useAgentCommands(makeArgs()))
    expect(["theme-system", "theme-light", "theme-dark"].map((id) => byId(result.current, id).label))
      .toEqual(["Theme: System", "Theme: Light", "Theme: Dark"])

    byId(result.current, "theme-dark").action()
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark")
    expect(document.documentElement.classList.contains("dark")).toBe(true)
    localStorage.removeItem(THEME_STORAGE_KEY)
  })

  it("toggles reader mode, saying which mode it is in", () => {
    const { result } = renderHook(() => useAgentCommands(makeArgs()))
    const toggle = () => byId(result.current, "toggle-reader-mode")
    expect(toggle().label).toBe("Toggle Reader Mode")
    expect(toggle().description).toMatch(/^Fold each turn/)

    act(() => toggle().action())
    expect(useDisplayPrefsStore.getState().transcriptStyle).toBe("reader")
    expect(toggle().description).toMatch(/^Reader mode is on/)

    act(() => toggle().action())
    expect(useDisplayPrefsStore.getState().transcriptStyle).toBe("detailed")
  })
})
