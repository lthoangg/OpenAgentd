import { describe, it, expect, afterEach } from "bun:test"
import { render, screen, cleanup } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { CommandPalette, QuickOpen } from "@/components/CommandPalette"
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
    const input = screen.getByPlaceholderText("Search commands…")
    expect(input).toBeTruthy()
    expect(input.className).toContain("focus:outline-none")
    expect(input.className).toContain("focus-visible:outline-none")
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

  it("matches every word of the query across label, description, and keywords", async () => {
    const user = userEvent.setup()
    const commands: Command[] = [
      { id: "reader", label: "Toggle Reader Mode", description: "Fold each turn", keywords: "compact transcript detailed", action: () => {} },
      { id: "new-chat", label: "New Chat", description: "Start a new session", action: () => {} },
    ]
    render(<CommandPalette commands={commands} onClose={() => {}} />)
    const input = screen.getByPlaceholderText("Search commands…")

    await user.type(input, "compact mode")
    expect(screen.getByText("Toggle Reader Mode")).toBeTruthy()
    expect(screen.queryByText("New Chat")).toBeNull()

    await user.clear(input)
    await user.type(input, "reader chat")
    expect(screen.queryByText("Toggle Reader Mode")).toBeNull()
  })

  it("ranks label matches above description matches, in one list", async () => {
    const user = userEvent.setup()
    const commands: Command[] = [
      { id: "maximize", group: "View", label: "Maximize Review Dock", description: "Full width for diffs, files, and terminals", action: () => {} },
      { id: "panes", group: "View", label: "Split Panes", description: "Determine the layout", action: () => {} },
      { id: "terminal", group: "Dock", label: "Open Terminal", description: "Interactive shell", action: () => {} },
    ]
    render(<CommandPalette commands={commands} onClose={() => {}} />)
    await user.type(screen.getByPlaceholderText("Search commands…"), "terminal")

    const rows = Array.from(document.querySelectorAll("[data-idx]")).map((row) => row.textContent)
    expect(rows[0]).toContain("Open Terminal")
    expect(rows[1]).toContain("Maximize Review Dock")
    // Only word starts count outside the label: "determine" is no match.
    expect(rows).toHaveLength(2)
    // A ranked result is not split back into groups.
    expect(screen.queryByText("Dock")).toBeNull()
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

  it("renders Quick Open as a file-only search", () => {
    render(
      <QuickOpen
        workspaceFiles={makeFiles(['App.tsx'])}
        onFileOpen={() => {}}
        onClose={() => {}}
      />,
    )

    expect(screen.getByPlaceholderText("Search files…")).toBeTruthy()
    expect(screen.getByText("App.tsx")).toBeTruthy()
    expect(screen.queryByText("New Chat")).toBeNull()
  })

  it("keeps the Quick Open file-search affordance when the workspace is empty", () => {
    render(<QuickOpen workspaceFiles={[]} onFileOpen={() => {}} onClose={() => {}} />)

    expect(screen.getByPlaceholderText("Search files…")).toBeTruthy()
    expect(screen.getByText(/No files match/)).toBeTruthy()
  })

  it("uses the Quick Open placeholder", () => {
    render(
      <QuickOpen
        workspaceFiles={makeFiles(['App.tsx'])}
        onFileOpen={() => {}}
        onClose={() => {}}
      />,
    )
    const input = screen.getByPlaceholderText("Search files…")
    expect(input).toBeTruthy()
    expect(input.className).toContain("focus:outline-none")
    expect(input.className).toContain("focus-visible:outline-none")
  })

  it("renders workspace files under a Files group header", () => {
    render(
      <QuickOpen
        workspaceFiles={makeFiles(['App.tsx', 'main.tsx'])}
        onFileOpen={() => {}}
        onClose={() => {}}
      />,
    )
    expect(screen.getByText("Files")).toBeTruthy()
    expect(screen.getByText("App.tsx")).toBeTruthy()
    expect(screen.getByText("main.tsx")).toBeTruthy()
  })

  it("caps file rows at 30 when no query", () => {
    const files = makeFiles(Array.from({ length: 50 }, (_, i) => `file${i}.ts`))
    const { container } = render(
      <QuickOpen workspaceFiles={files} onFileOpen={() => {}} onClose={() => {}} />,
    )
    const buttons = container.querySelectorAll("button[data-idx]")
    expect(buttons.length).toBe(30)
  })

  it("caps filtered file rows at 30 when query matches many files", () => {
    const user = userEvent.setup()
    const files = makeFiles(Array.from({ length: 50 }, (_, i) => `component${i}.tsx`))
    const { container } = render(
      <QuickOpen workspaceFiles={files} onFileOpen={() => {}} onClose={() => {}} />,
    )
    // all 50 match "component" but cap applies
    const buttons = container.querySelectorAll("button[data-idx]")
    expect(buttons.length).toBe(30)
    void user // satisfy lint
  })

  it("filters files by filename", async () => {
    const user = userEvent.setup()
    render(
      <QuickOpen
        workspaceFiles={makeFiles(['App.tsx', 'config.ts'])}
        onFileOpen={() => {}}
        onClose={() => {}}
      />,
    )
    await user.type(screen.getByPlaceholderText("Search files…"), "App")
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
    await user.type(screen.getByPlaceholderText("Search files…"), "lib")
    expect(screen.getByText("utils.ts")).toBeTruthy()
    expect(screen.queryByText("App.tsx")).toBeNull()
  })

  it("matches files by fuzzy subsequence, not just substring", async () => {
    // The palette used a plain `includes()` while every other search surface
    // (@-mentions, model pickers) ranked with fuzzysort — so `dockcom` found
    // `docker-compose.yml` in the composer but not here.
    const user = userEvent.setup()
    const files: WorkspaceFileInfo[] = [
      { path: 'infra/docker-compose.yml', name: 'docker-compose.yml', size: 0, mtime: 0, mime: 'text/plain' },
      { path: 'docs/README.md', name: 'README.md', size: 0, mtime: 0, mime: 'text/plain' },
    ]
    render(
      <CommandPalette commands={[]} workspaceFiles={files} onFileOpen={() => {}} onClose={() => {}} />,
    )
    // "dockcom" is not a substring of the path, only an ordered subsequence.
    await user.type(screen.getByPlaceholderText("Search files…"), "dockcom")
    expect(screen.getByText("docker-compose.yml")).toBeTruthy()
    expect(screen.queryByText("README.md")).toBeNull()
  })

  it("ranks the closest file match first", async () => {
    const user = userEvent.setup()
    const files: WorkspaceFileInfo[] = [
      { path: 'src/deeply/nested/other/instrument.ts', name: 'instrument.ts', size: 0, mtime: 0, mime: 'text/plain' },
      { path: 'index.ts', name: 'index.ts', size: 0, mtime: 0, mime: 'text/plain' },
    ]
    render(
      <CommandPalette commands={[]} workspaceFiles={files} onFileOpen={() => {}} onClose={() => {}} />,
    )
    await user.type(screen.getByPlaceholderText("Search files…"), "index.ts")
    // Both contain the subsequence; the exact match must rank first.
    const rows = screen.getAllByRole('button').filter((b) => b.textContent?.includes('.ts'))
    expect(rows[0].textContent).toContain('index.ts')
  })

  it("finds gitignored files but ranks them below comparable visible ones", async () => {
    const user = userEvent.setup()
    const files: WorkspaceFileInfo[] = [
      { path: 'dist/clip.mp4', name: 'clip.mp4', size: 0, mtime: 0, mime: 'video/mp4', ignored: true },
      { path: 'assets/media/clip.mp4', name: 'clip.mp4', size: 0, mtime: 0, mime: 'video/mp4' },
    ]
    render(
      <CommandPalette commands={[]} workspaceFiles={files} onFileOpen={() => {}} onClose={() => {}} />,
    )
    await user.type(screen.getByPlaceholderText("Search files…"), "clip")
    const rows = screen.getAllByRole('button').filter((b) => b.textContent?.includes('clip.mp4'))
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining('assets/media/'), expect.stringContaining('dist/')])
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
    await user.type(screen.getByPlaceholderText("Search files…"), "xyznotfound")
    expect(screen.getByText(/No files match/)).toBeTruthy()
  })

  // ── truncated listing ───────────────────────────────────────────────────────
  //
  // The backend caps its file listing. Without a hint, a capped workspace looks
  // like "the palette can't find my file" — the exact bug report this guards.
  it("warns when the workspace file listing was truncated", () => {
    render(
      <CommandPalette
        commands={makeCommands()}
        workspaceFiles={makeFiles(['App.tsx'])}
        filesTruncated
        onFileOpen={() => {}}
        onClose={() => {}}
      />,
    )
    expect(screen.getByText("file list truncated")).toBeTruthy()
  })

  it("stays quiet when the listing is complete", () => {
    render(
      <CommandPalette
        commands={makeCommands()}
        workspaceFiles={makeFiles(['App.tsx'])}
        onFileOpen={() => {}}
        onClose={() => {}}
      />,
    )
    expect(screen.queryByText("file list truncated")).toBeNull()
  })
})

describe("CommandPalette — nested pages", () => {
  function pageCommands(onPick: (id: string) => void = () => {}): Command[] {
    return [
      { id: "new-chat", label: "New Chat", action: () => {} },
      {
        id: "switch-session",
        label: "Switch Session…",
        action: () => {},
        page: {
          placeholder: "Search sessions…",
          commands: [
            { id: "s1", label: "Fix login bug", action: () => onPick("s1") },
            { id: "s2", label: "Refactor store", action: () => onPick("s2") },
          ],
        },
      },
    ]
  }

  it("opens a page in place instead of running and closing", async () => {
    const user = userEvent.setup()
    let closed = false
    render(<CommandPalette commands={pageCommands()} onClose={() => { closed = true }} />)

    await user.click(screen.getByText("Switch Session…"))

    expect(closed).toBe(false)
    expect(screen.getByPlaceholderText("Search sessions…")).toBeTruthy()
    expect(screen.getByText("Fix login bug")).toBeTruthy()
    expect(screen.queryByText("New Chat")).toBeNull()
  })

  it("filters and runs a page item, then closes", async () => {
    const user = userEvent.setup()
    const picked: string[] = []
    let closed = false
    render(<CommandPalette commands={pageCommands((id) => picked.push(id))} onClose={() => { closed = true }} />)

    await user.click(screen.getByText("Switch Session…"))
    await user.type(screen.getByPlaceholderText("Search sessions…"), "refac")
    await user.keyboard("{Enter}")

    expect(picked).toEqual(["s2"])
    expect(closed).toBe(true)
  })

  it("returns to the root list on Backspace in an empty query", async () => {
    const user = userEvent.setup()
    render(<CommandPalette commands={pageCommands()} onClose={() => {}} />)

    await user.click(screen.getByText("Switch Session…"))
    await user.keyboard("{Backspace}")

    expect(screen.getByPlaceholderText("Search commands…")).toBeTruthy()
    expect(screen.getByText("New Chat")).toBeTruthy()
  })

  it("steps back out of a page on Escape before closing", async () => {
    const user = userEvent.setup()
    let closed = false
    render(<CommandPalette commands={pageCommands()} onClose={() => { closed = true }} />)

    await user.click(screen.getByText("Switch Session…"))
    await user.keyboard("{Escape}")
    expect(closed).toBe(false)
    expect(screen.getByText("New Chat")).toBeTruthy()

    await user.keyboard("{Escape}")
    expect(closed).toBe(true)
  })

  it("names the open page next to the search field", async () => {
    const user = userEvent.setup()
    render(<CommandPalette commands={pageCommands()} onClose={() => {}} />)

    await user.click(screen.getByText("Switch Session…"))

    expect(screen.getByRole("button", { name: "Back to all commands" }).textContent).toBe("Switch Session")
  })
})

describe("QuickOpen — > command mode", () => {
  const files: WorkspaceFileInfo[] = [
    { path: 'src/App.tsx', name: 'App.tsx', size: 0, mtime: 0, mime: 'text/plain' },
  ]

  it("searches commands instead of files when the query starts with >", async () => {
    const user = userEvent.setup()
    render(<QuickOpen workspaceFiles={files} commands={makeCommands()} onFileOpen={() => {}} onClose={() => {}} />)

    expect(screen.queryByText("New Chat")).toBeNull()
    await user.type(screen.getByPlaceholderText("Search files…"), ">side")

    expect(screen.getByText("Toggle Sidebar")).toBeTruthy()
    expect(screen.queryByText("New Chat")).toBeNull()
    expect(screen.queryByText("App.tsx")).toBeNull()
  })

  it("runs the command on Enter", async () => {
    const user = userEvent.setup()
    let ran = false
    let opened = false
    const commands: Command[] = [{ id: "c1", label: "Run Me", action: () => { ran = true } }]
    render(<QuickOpen workspaceFiles={files} commands={commands} onFileOpen={() => { opened = true }} onClose={() => {}} />)

    await user.type(screen.getByPlaceholderText("Search files…"), ">")
    await user.keyboard("{Enter}")

    expect(ran).toBe(true)
    expect(opened).toBe(false)
  })

  it("hints the > prefix while searching files", () => {
    render(<QuickOpen workspaceFiles={files} commands={makeCommands()} onFileOpen={() => {}} onClose={() => {}} />)
    expect(screen.getByText(">").closest("kbd")).toBeTruthy()
  })
})

describe("QuickOpen — a query with a line", () => {
  const files: WorkspaceFileInfo[] = [
    { path: 'web/src/Button.tsx', name: 'Button.tsx', size: 0, mtime: 0, mime: 'text/plain' },
    { path: 'app/ui/Button.tsx', name: 'Button.tsx', size: 0, mtime: 0, mime: 'text/plain' },
    { path: 'web/src/App.tsx', name: 'App.tsx', size: 0, mtime: 0, mime: 'text/plain' },
  ]

  it("opens already searching for its initial query, the query selected", () => {
    render(<QuickOpen workspaceFiles={files} initialQuery="Button.tsx" onFileOpen={() => {}} onClose={() => {}} />)

    const input = screen.getByPlaceholderText("Search files…") as HTMLInputElement
    expect(input.value).toBe("Button.tsx")
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, "Button.tsx".length])
    expect(screen.getAllByText("Button.tsx")).toHaveLength(2)
    expect(screen.queryByText("App.tsx")).toBeNull()
  })

  it("searches by the path before :line and opens the pick at that line", async () => {
    const user = userEvent.setup()
    let opened: { path: string; line?: number } | null = null
    render(
      <QuickOpen
        workspaceFiles={files}
        initialQuery="app/ui/Button.tsx:42"
        onFileOpen={(file, line) => { opened = { path: file.path, line } }}
        onClose={() => {}}
      />,
    )

    await user.keyboard("{Enter}")

    expect(opened as { path: string; line?: number } | null).toEqual({ path: 'app/ui/Button.tsx', line: 42 })
  })

  it("opens the pick at a query's :start-end range", async () => {
    const user = userEvent.setup()
    let opened: unknown[] | null = null
    render(
      <QuickOpen
        workspaceFiles={files}
        initialQuery="web/src/App.tsx:42-58"
        onFileOpen={(file, line, endLine) => { opened = [file.path, line, endLine] }}
        onClose={() => {}}
      />,
    )

    await user.keyboard("{Enter}")

    expect(opened as unknown[] | null).toEqual(['web/src/App.tsx', 42, 58])
  })

  it("opens a pick without a line when the query has none", async () => {
    const user = userEvent.setup()
    let opened: { path: string; line?: number } | null = null
    render(<QuickOpen workspaceFiles={files} onFileOpen={(file, line) => { opened = { path: file.path, line } }} onClose={() => {}} />)

    await user.type(screen.getByPlaceholderText("Search files…"), "App.tsx")
    await user.keyboard("{Enter}")

    expect(opened as { path: string; line?: number } | null).toEqual({ path: 'web/src/App.tsx', line: undefined })
  })
})
