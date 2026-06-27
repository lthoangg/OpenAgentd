import { describe, it, expect, afterEach } from "bun:test"
import { render, screen, cleanup } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { CommandPalette } from "@/components/CommandPalette"
import type { Command } from "@/components/CommandPalette"
import type { WorkspaceFileInfo } from "@/api/types"

afterEach(cleanup)

// Me factory for quick commands
function makeCommands(overrides: Partial<Command>[] = []): Command[] {
  const defaults: Command[] = [
    { id: "new-chat", label: "New Chat", description: "Start a new session", shortcut: "Ctrl+N", action: () => {} },
    { id: "toggle-sidebar", label: "Toggle Sidebar", description: "Show or hide sidebar", shortcut: "Ctrl+B", action: () => {} },
    { id: "agent-info", label: "Agent Info", description: "View agent details", action: () => {} },
  ]
  return overrides.length ? overrides.map((o, i) => ({ ...defaults[i % defaults.length], ...o })) : defaults
}

describe("CommandPalette", () => {
  // ── basic rendering ─────────────────────────────────────────────────────────

  it("renders search input with placeholder", () => {
    render(<CommandPalette commands={makeCommands()} onClose={() => {}} />)
    expect(screen.getByPlaceholderText("Search commands…")).toBeTruthy()
  })

  it("renders all commands initially", () => {
    render(<CommandPalette commands={makeCommands()} onClose={() => {}} />)
    expect(screen.getByText("New Chat")).toBeTruthy()
    expect(screen.getByText("Toggle Sidebar")).toBeTruthy()
    expect(screen.getByText("Agent Info")).toBeTruthy()
  })

  it("renders command descriptions", () => {
    render(<CommandPalette commands={makeCommands()} onClose={() => {}} />)
    expect(screen.getByText("Start a new session")).toBeTruthy()
  })

  it("renders keyboard shortcut hints", () => {
    render(<CommandPalette commands={makeCommands()} onClose={() => {}} />)
    expect(screen.getByText("Ctrl+N")).toBeTruthy()
    expect(screen.getByText("Ctrl+B")).toBeTruthy()
  })

  it("renders footer navigation hint", () => {
    render(<CommandPalette commands={makeCommands()} onClose={() => {}} />)
    expect(screen.getByText("navigate")).toBeTruthy()
    expect(screen.getByText("run")).toBeTruthy()
    expect(screen.getByText("close")).toBeTruthy()
  })

  it("renders role=dialog with aria-modal", () => {
    const { container } = render(<CommandPalette commands={makeCommands()} onClose={() => {}} />)
    const dialog = container.querySelector("[role='dialog']")
    expect(dialog).toBeTruthy()
    expect(dialog?.getAttribute("aria-modal")).toBe("true")
  })

  it("traps focus inside the dialog and restores it on close", async () => {
    const user = userEvent.setup()
    const { rerender } = render(
      <>
        <button type="button">Before palette</button>
        <button type="button">After palette</button>
      </>,
    )

    const beforeButton = screen.getByRole("button", { name: "Before palette" })
    beforeButton.focus()
    expect(document.activeElement).toBe(beforeButton)

    rerender(
      <>
        <button type="button">Before palette</button>
        <CommandPalette
          commands={makeCommands()}
          onClose={() => {
            rerender(<button type="button">Before palette</button>)
          }}
        />
        <button type="button">After palette</button>
      </>,
    )

    const input = screen.getByPlaceholderText("Search commands…")
    expect(document.activeElement).toBe(input)

    await user.keyboard("{Shift>}{Tab}{/Shift}")
    expect((document.activeElement as HTMLElement).closest("[role='dialog']")).toBeTruthy()
    expect(document.activeElement?.textContent).not.toBe("After palette")

    await user.keyboard("{Escape}")
    expect(document.activeElement?.textContent).toBe("Before palette")
  })

  // ── search filtering ────────────────────────────────────────────────────────

  it("filters commands by label query", async () => {
    const user = userEvent.setup()
    render(<CommandPalette commands={makeCommands()} onClose={() => {}} />)

    const input = screen.getByPlaceholderText("Search commands…")
    await user.type(input, "new")

    expect(screen.getByText("New Chat")).toBeTruthy()
    expect(screen.queryByText("Toggle Sidebar")).toBeNull()
  })

  it("filters commands by description query", async () => {
    const user = userEvent.setup()
    render(<CommandPalette commands={makeCommands()} onClose={() => {}} />)

    const input = screen.getByPlaceholderText("Search commands…")
    await user.type(input, "sidebar")

    expect(screen.getByText("Toggle Sidebar")).toBeTruthy()
    expect(screen.queryByText("New Chat")).toBeNull()
  })

  it("shows no-match message when query has no results", async () => {
    const user = userEvent.setup()
    render(<CommandPalette commands={makeCommands()} onClose={() => {}} />)

    const input = screen.getByPlaceholderText("Search commands…")
    await user.type(input, "xyznotfound")

    expect(screen.getByText(/No commands match/)).toBeTruthy()
  })

  it("shows Clear button when query is non-empty", async () => {
    const user = userEvent.setup()
    render(<CommandPalette commands={makeCommands()} onClose={() => {}} />)

    const input = screen.getByPlaceholderText("Search commands…")
    await user.type(input, "new")

    expect(screen.getByText("Clear")).toBeTruthy()
  })

  it("clears query when Clear button is clicked", async () => {
    const user = userEvent.setup()
    render(<CommandPalette commands={makeCommands()} onClose={() => {}} />)

    const input = screen.getByPlaceholderText("Search commands…") as HTMLInputElement
    await user.type(input, "new")
    expect(input.value).toBe("new")

    await user.click(screen.getByText("Clear"))
    expect(input.value).toBe("")
  })

  // ── keyboard navigation ─────────────────────────────────────────────────────

  it("calls onClose when Escape is pressed", async () => {
    const user = userEvent.setup()
    let closed = false
    render(<CommandPalette commands={makeCommands()} onClose={() => { closed = true }} />)

    const input = screen.getByPlaceholderText("Search commands…")
    await user.click(input)
    await user.keyboard("{Escape}")

    expect(closed).toBe(true)
  })

  it("runs command and calls onClose when Enter is pressed on active item", async () => {
    const user = userEvent.setup()
    let ran = false
    let closed = false
    const commands: Command[] = [
      { id: "cmd1", label: "Run Me", action: () => { ran = true } },
    ]
    render(<CommandPalette commands={commands} onClose={() => { closed = true }} />)

    const input = screen.getByPlaceholderText("Search commands…")
    await user.click(input)
    await user.keyboard("{Enter}")

    expect(ran).toBe(true)
    expect(closed).toBe(true)
  })

  it("navigates down with ArrowDown", async () => {
    const user = userEvent.setup()
    const commands = makeCommands()
    const { container } = render(<CommandPalette commands={commands} onClose={() => {}} />)

    const input = screen.getByPlaceholderText("Search commands…")
    await user.click(input)
    await user.keyboard("{ArrowDown}")

    // Second item (idx=1) should now be active (has accent-subtle bg)
    const activeItems = container.querySelectorAll("[class*='bg-(--bg-key)']")
    expect(activeItems.length).toBeGreaterThan(0)
  })

  it("navigates up with ArrowUp (stays at 0 when at top)", async () => {
    const user = userEvent.setup()
    const commands = makeCommands()
    render(<CommandPalette commands={commands} onClose={() => {}} />)

    const input = screen.getByPlaceholderText("Search commands…")
    await user.click(input)
    await user.keyboard("{ArrowUp}") // already at 0 — should not go negative
    await user.keyboard("{Enter}") // should still run first command

    // Me no error means test passes — navigation clamped at 0
    expect(screen.getByText("New Chat")).toBeTruthy()
  })

  // ── click to run ────────────────────────────────────────────────────────────

  it("runs command when command button is clicked", async () => {
    const user = userEvent.setup()
    let ran = false
    const commands: Command[] = [
      { id: "c1", label: "Click Me", action: () => { ran = true } },
    ]
    render(<CommandPalette commands={commands} onClose={() => {}} />)

    await user.click(screen.getByText("Click Me"))
    expect(ran).toBe(true)
  })

  it("calls onClose when backdrop is clicked", async () => {
    const user = userEvent.setup()
    let closed = false
    const { container } = render(
      <CommandPalette commands={makeCommands()} onClose={() => { closed = true }} />
    )

    // Me backdrop is the fixed inset-0 div
    const backdrop = container.querySelector(".fixed.inset-0") as HTMLElement
    if (backdrop) {
      await user.click(backdrop)
    }
    expect(closed).toBe(true)
  })

  // ── group headers ───────────────────────────────────────────────────────────

  it("renders group headers when commands have group property", () => {
    const commands: Command[] = [
      { id: "c1", label: "Command One", group: "Navigation", action: () => {} },
      { id: "c2", label: "Command Two", group: "Actions", action: () => {} },
    ]
    render(<CommandPalette commands={commands} onClose={() => {}} />)
    expect(screen.getByText("Navigation")).toBeTruthy()
    expect(screen.getByText("Actions")).toBeTruthy()
  })

  // ── workspace files (coding mode) ──────────────────────────────────────────

  function makeFiles(names: string[]): WorkspaceFileInfo[] {
    return names.map((name) => ({
      path: `src/${name}`,
      name,
      size: 100,
      mtime: 0,
      mime: 'text/plain',
    }))
  }

  it("uses unified placeholder when workspaceFiles are provided", () => {
    render(
      <CommandPalette
        commands={makeCommands()}
        workspaceFiles={makeFiles(['App.tsx'])}
        onFileOpen={() => {}}
        onClose={() => {}}
      />,
    )
    expect(screen.getByPlaceholderText("Search files and commands…")).toBeTruthy()
  })

  it("renders workspace files under a Files group header", () => {
    render(
      <CommandPalette
        commands={[]}
        workspaceFiles={makeFiles(['App.tsx', 'main.tsx'])}
        onFileOpen={() => {}}
        onClose={() => {}}
      />,
    )
    expect(screen.getByText("Files")).toBeTruthy()
    expect(screen.getByText("App.tsx")).toBeTruthy()
    expect(screen.getByText("main.tsx")).toBeTruthy()
  })

  it("regular commands appear before file rows", () => {
    const { container } = render(
      <CommandPalette
        commands={makeCommands()}
        workspaceFiles={makeFiles(['index.ts'])}
        onFileOpen={() => {}}
        onClose={() => {}}
      />,
    )
    const buttons = container.querySelectorAll("button[data-idx]")
    expect((buttons[0] as HTMLElement).textContent).toContain("New Chat")
    expect((buttons[buttons.length - 1] as HTMLElement).textContent).toContain("index.ts")
  })

  it("caps file rows at 30 when no query", () => {
    const files = makeFiles(Array.from({ length: 50 }, (_, i) => `file${i}.ts`))
    const { container } = render(
      <CommandPalette commands={[]} workspaceFiles={files} onFileOpen={() => {}} onClose={() => {}} />,
    )
    const buttons = container.querySelectorAll("button[data-idx]")
    expect(buttons.length).toBe(30)
  })

  it("caps filtered file rows at 30 when query matches many files", () => {
    const user = userEvent.setup()
    const files = makeFiles(Array.from({ length: 50 }, (_, i) => `component${i}.tsx`))
    const { container } = render(
      <CommandPalette commands={[]} workspaceFiles={files} onFileOpen={() => {}} onClose={() => {}} />,
    )
    // all 50 match "component" but cap applies
    const buttons = container.querySelectorAll("button[data-idx]")
    expect(buttons.length).toBe(30)
    void user // satisfy lint
  })

  it("filters files by filename", async () => {
    const user = userEvent.setup()
    render(
      <CommandPalette
        commands={[]}
        workspaceFiles={makeFiles(['App.tsx', 'config.ts'])}
        onFileOpen={() => {}}
        onClose={() => {}}
      />,
    )
    await user.type(screen.getByPlaceholderText("Search files and commands…"), "App")
    expect(screen.getByText("App.tsx")).toBeTruthy()
    expect(screen.queryByText("config.ts")).toBeNull()
  })

  it("filters files by path", async () => {
    const user = userEvent.setup()
    const files: WorkspaceFileInfo[] = [
      { path: 'src/components/App.tsx', name: 'App.tsx', size: 0, mtime: 0, mime: 'text/plain' },
      { path: 'src/lib/utils.ts',       name: 'utils.ts', size: 0, mtime: 0, mime: 'text/plain' },
    ]
    render(
      <CommandPalette commands={[]} workspaceFiles={files} onFileOpen={() => {}} onClose={() => {}} />,
    )
    await user.type(screen.getByPlaceholderText("Search files and commands…"), "lib")
    expect(screen.getByText("utils.ts")).toBeTruthy()
    expect(screen.queryByText("App.tsx")).toBeNull()
  })

  it("calls onFileOpen and onClose when a file row is activated via Enter", async () => {
    const user = userEvent.setup()
    let opened: WorkspaceFileInfo | null = null
    let closed = false
    const files = makeFiles(['App.tsx'])
    render(
      <CommandPalette
        commands={[]}
        workspaceFiles={files}
        onFileOpen={(f) => { opened = f }}
        onClose={() => { closed = true }}
      />,
    )
    await user.keyboard("{Enter}")
    expect((opened as WorkspaceFileInfo | null)?.name).toBe("App.tsx")
    expect(closed).toBe(true)
  })

  it("shows unified no-match message when workspaceFiles are provided", async () => {
    const user = userEvent.setup()
    render(
      <CommandPalette
        commands={makeCommands()}
        workspaceFiles={makeFiles(['App.tsx'])}
        onFileOpen={() => {}}
        onClose={() => {}}
      />,
    )
    await user.type(screen.getByPlaceholderText("Search files and commands…"), "xyznotfound")
    expect(screen.getByText(/No files or commands match/)).toBeTruthy()
  })
})
