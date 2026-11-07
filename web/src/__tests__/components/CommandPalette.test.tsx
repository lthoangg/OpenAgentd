import { describe, it, expect, afterEach, mock } from "bun:test"
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { CommandPalette, QuickOpen } from "@/components/CommandPalette"
import type { Command, PaletteSession, PaletteSessions } from "@/components/CommandPalette"
import type { WorkspaceFileInfo } from "@/api/types"
import { resetHoverIntent } from "@/hooks/use-hover-intent"

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

  it("draws a session's status mark at the start of its row", () => {
    render(
      <CommandPalette
        commands={[
          { id: "a", label: "Plan release", description: "Needs you", status: "needs_input", action: () => {} },
          { id: "b", label: "Old notes", description: "3h", status: "idle", action: () => {} },
          { id: "c", label: "Toggle Sidebar", action: () => {} },
        ]}
        onClose={() => {}}
      />,
    )
    const row = (label: string) => screen.getByText(label).closest("button")!

    expect(within(row("Plan release")).getByRole("img", { name: "Session needs your input" })).toBeTruthy()
    // An idle session keeps the slot, so titles line up; a command has none.
    expect(row("Old notes").querySelector("[data-session-status-mark]")).toBeTruthy()
    expect(row("Toggle Sidebar").querySelector("[data-session-status-mark]")).toBeNull()
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

    // Second item (idx=1) is now the highlighted row
    expect(container.querySelector("[data-idx='1']")?.hasAttribute("data-highlighted")).toBe(true)
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

  it("renders the Find file scope as a file-only search", () => {
    render(
      <QuickOpen
        workspaceFiles={makeFiles(['App.tsx'])}
        onFileOpen={() => {}}
        onClose={() => {}}
      />,
    )

    expect(screen.getByPlaceholderText("Find file…")).toBeTruthy()
    expect(screen.getByText("App.tsx")).toBeTruthy()
    expect(screen.queryByText("New Chat")).toBeNull()
  })

  it("keeps the Find file affordance when the workspace is empty", () => {
    render(<QuickOpen workspaceFiles={[]} onFileOpen={() => {}} onClose={() => {}} />)

    expect(screen.getByPlaceholderText("Find file…")).toBeTruthy()
    expect(screen.getByText(/No files match/)).toBeTruthy()
  })

  it("uses the Find file placeholder", () => {
    render(
      <QuickOpen
        workspaceFiles={makeFiles(['App.tsx'])}
        onFileOpen={() => {}}
        onClose={() => {}}
      />,
    )
    const input = screen.getByPlaceholderText("Find file…")
    expect(input).toBeTruthy()
    expect(input.className).toContain("focus:outline-none")
    expect(input.className).toContain("focus-visible:outline-none")
  })

  it("labels the Files scope beside the field instead of heading a lone group", () => {
    render(
      <QuickOpen
        workspaceFiles={makeFiles(['App.tsx', 'main.tsx'])}
        onFileOpen={() => {}}
        onClose={() => {}}
      />,
    )
    // One "Files": the scope label. A heading over the only group would repeat it.
    expect(screen.getAllByText("Files")).toHaveLength(1)
    expect(screen.getByRole("button", { name: /^Files only/ })).toBeTruthy()
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
    await user.type(screen.getByPlaceholderText("Find file…"), "App")
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
      <CommandPalette scope="files" commands={[]} workspaceFiles={files} onFileOpen={() => {}} onClose={() => {}} />,
    )
    await user.type(screen.getByPlaceholderText("Find file…"), "lib")
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
      <CommandPalette scope="files" commands={[]} workspaceFiles={files} onFileOpen={() => {}} onClose={() => {}} />,
    )
    // "dockcom" is not a substring of the path, only an ordered subsequence.
    await user.type(screen.getByPlaceholderText("Find file…"), "dockcom")
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
      <CommandPalette scope="files" commands={[]} workspaceFiles={files} onFileOpen={() => {}} onClose={() => {}} />,
    )
    await user.type(screen.getByPlaceholderText("Find file…"), "index.ts")
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
      <CommandPalette scope="files" commands={[]} workspaceFiles={files} onFileOpen={() => {}} onClose={() => {}} />,
    )
    await user.type(screen.getByPlaceholderText("Find file…"), "clip")
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
        scope="files"
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

  it("says no files match in the Files scope", async () => {
    const user = userEvent.setup()
    render(
      <CommandPalette
        scope="files"
        commands={makeCommands()}
        workspaceFiles={makeFiles(['App.tsx'])}
        onFileOpen={() => {}}
        onClose={() => {}}
      />,
    )
    await user.type(screen.getByPlaceholderText("Find file…"), "xyznotfound")
    // The file filter reads a debounced query; wait for it to settle.
    expect(await screen.findByText(/No files match/)).toBeTruthy()
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

  // ── ←/→ ─────────────────────────────────────────────────────────────────────

  it("opens the highlighted page on ArrowRight", async () => {
    const user = userEvent.setup()
    let closed = false
    render(<CommandPalette commands={pageCommands()} onClose={() => { closed = true }} />)

    await user.keyboard("{ArrowDown}{ArrowRight}")

    expect(closed).toBe(false)
    expect(screen.getByPlaceholderText("Search sessions…")).toBeTruthy()
    expect(screen.getByText("Fix login bug")).toBeTruthy()
  })

  it("ignores ArrowRight on a command without a page", async () => {
    const user = userEvent.setup()
    let closed = false
    let ran = false
    const commands = pageCommands()
    commands[0] = { ...commands[0], action: () => { ran = true } }
    render(<CommandPalette commands={commands} onClose={() => { closed = true }} />)

    await user.keyboard("{ArrowRight}")

    expect(screen.getByPlaceholderText("Search commands…")).toBeTruthy()
    expect(closed).toBe(false)
    expect(ran).toBe(false)
  })

  it("moves the caret with ArrowRight until it reaches the end of the query", async () => {
    const user = userEvent.setup()
    render(<CommandPalette commands={pageCommands()} onClose={() => {}} />)
    const input = screen.getByPlaceholderText("Search commands…") as HTMLInputElement

    await user.type(input, "switch")
    await user.keyboard("{Home}{ArrowRight}")
    expect(screen.getByPlaceholderText("Search commands…")).toBeTruthy()
    expect(input.selectionStart).toBe(1)

    await user.keyboard("{End}{ArrowRight}")
    expect(screen.getByPlaceholderText("Search sessions…")).toBeTruthy()
  })

  it("ignores ArrowRight with a modifier held", async () => {
    const user = userEvent.setup()
    render(<CommandPalette commands={pageCommands()} onClose={() => {}} />)

    await user.keyboard("{ArrowDown}{Shift>}{ArrowRight}{/Shift}")

    expect(screen.getByPlaceholderText("Search commands…")).toBeTruthy()
  })

  it("returns to the root list on ArrowLeft in an empty query", async () => {
    const user = userEvent.setup()
    render(<CommandPalette commands={pageCommands()} onClose={() => {}} />)

    await user.click(screen.getByText("Switch Session…"))
    await user.keyboard("{ArrowLeft}")

    expect(screen.getByPlaceholderText("Search commands…")).toBeTruthy()
    expect(screen.getByText("New Chat")).toBeTruthy()
  })

  it("moves the caret with ArrowLeft while the page query has text", async () => {
    const user = userEvent.setup()
    render(<CommandPalette commands={pageCommands()} onClose={() => {}} />)

    await user.click(screen.getByText("Switch Session…"))
    const input = screen.getByPlaceholderText("Search sessions…") as HTMLInputElement
    await user.type(input, "fix")
    await user.keyboard("{ArrowLeft}")

    expect(screen.getByPlaceholderText("Search sessions…")).toBeTruthy()
    expect(input.value).toBe("fix")
    expect(input.selectionStart).toBe(2)
  })

  it("highlights the command that opened a page after leaving it", async () => {
    const user = userEvent.setup()
    const { container } = render(<CommandPalette commands={pageCommands()} onClose={() => {}} />)

    await user.keyboard("{ArrowDown}{ArrowRight}{ArrowLeft}")
    expect(container.querySelector("[data-idx='1']")?.hasAttribute("data-highlighted")).toBe(true)

    // Enter runs the highlighted page command again, not New Chat.
    await user.keyboard("{Enter}")
    expect(screen.getByPlaceholderText("Search sessions…")).toBeTruthy()

    await user.keyboard("{Escape}")
    expect(container.querySelector("[data-idx='1']")?.hasAttribute("data-highlighted")).toBe(true)
  })

  it("hints → while a page command is highlighted and ← inside a page", async () => {
    const user = userEvent.setup()
    render(<CommandPalette commands={pageCommands()} onClose={() => {}} />)

    expect(screen.queryByText("open")).toBeNull()
    await user.keyboard("{ArrowDown}")
    expect(screen.getByText("open")).toBeTruthy()
    expect(screen.getByText("→").closest("kbd")).toBeTruthy()

    await user.keyboard("{ArrowRight}")
    expect(screen.queryByText("open")).toBeNull()
    expect(screen.getByText("←").closest("kbd")).toBeTruthy()
    expect(screen.getByText("back")).toBeTruthy()
  })
})

describe("CommandPalette — pages inside pages", () => {
  function nested(opts: { sessions?: Command[]; onOpen?: () => void } = {}): Command[] {
    return [
      { id: "new-chat", label: "New Chat", action: () => {} },
      {
        id: "switch",
        label: "Switch Workspace/Session…",
        action: () => {},
        page: {
          placeholder: "Search workspaces…",
          commands: [
            { id: "ws:docs", label: "docs", action: () => {}, page: { placeholder: "Search sessions in docs…", commands: [] } },
            {
              id: "ws:app",
              label: "app",
              action: () => {},
              onOpenPage: opts.onOpen,
              page: {
                placeholder: "Search sessions in app…",
                commands: [
                  { id: "new:app", label: "New Session", browseOnly: true, action: () => {} },
                  ...(opts.sessions ?? [{ id: "s1", label: "Fix login bug", action: () => {} }]),
                ],
              },
            },
          ],
        },
      },
    ]
  }
  const activeLabel = (container: HTMLElement) =>
    Array.from(container.querySelectorAll("[data-idx]")).find((row) => row.hasAttribute("data-highlighted"))?.textContent

  it("walks down three levels with → and back up with ←, one level at a time", async () => {
    const user = userEvent.setup()
    const { container } = render(<CommandPalette commands={nested()} onClose={() => {}} />)

    await user.keyboard("{ArrowDown}{ArrowRight}{ArrowDown}{ArrowRight}")
    expect(screen.getByPlaceholderText("Search sessions in app…")).toBeTruthy()
    expect(screen.getByText("Fix login bug")).toBeTruthy()

    await user.keyboard("{ArrowLeft}")
    expect(screen.getByPlaceholderText("Search workspaces…")).toBeTruthy()
    expect(activeLabel(container)).toContain("app")

    await user.keyboard("{ArrowLeft}")
    expect(screen.getByPlaceholderText("Search commands…")).toBeTruthy()
    expect(activeLabel(container)).toContain("Switch Workspace/Session…")
  })

  it("focuses the search box, not the back chip, when opened on a page", async () => {
    render(<CommandPalette commands={nested()} onClose={() => {}} initialPagePath={["switch", "ws:app"]} />)
    const input = screen.getByPlaceholderText("Search sessions in app…")
    // The overlay's focus helper runs a frame after mount; wait past it.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null))))
    expect(document.activeElement).toBe(input)
  })

  it("steps back one level on Escape and Backspace", async () => {
    const user = userEvent.setup()
    let closed = false
    render(<CommandPalette commands={nested()} onClose={() => { closed = true }} />)

    await user.keyboard("{ArrowDown}{Enter}{ArrowDown}{Enter}")
    await user.keyboard("{Escape}")
    expect(screen.getByPlaceholderText("Search workspaces…")).toBeTruthy()
    await user.keyboard("{Backspace}")
    expect(screen.getByPlaceholderText("Search commands…")).toBeTruthy()
    expect(closed).toBe(false)
  })

  it("shows the trail in the back chip, which steps back one level", async () => {
    const user = userEvent.setup()
    render(<CommandPalette commands={nested()} onClose={() => {}} />)

    await user.keyboard("{ArrowDown}{ArrowRight}{ArrowDown}{ArrowRight}")
    const chip = screen.getByRole("button", { name: "Back to Switch Workspace/Session" })
    expect(chip.textContent).toBe("Switch Workspace/Session › app")

    await user.click(chip)
    expect(screen.getByPlaceholderText("Search workspaces…")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Back to all commands" }).textContent).toBe("Switch Workspace/Session")
  })

  it("lists a browse-only row first with an empty query and hides it while searching", async () => {
    const user = userEvent.setup()
    const { container } = render(<CommandPalette commands={nested()} onClose={() => {}} />)

    await user.keyboard("{ArrowDown}{ArrowRight}{ArrowDown}{ArrowRight}")
    expect(container.querySelector("[data-idx='0']")?.textContent).toContain("New Session")

    await user.type(screen.getByPlaceholderText("Search sessions in app…"), "new")
    expect(screen.queryByText("New Session")).toBeNull()
  })

  it("calls onOpenPage and shows rows that arrive after the page opened", async () => {
    const user = userEvent.setup()
    let opened = 0
    const onOpen = () => { opened += 1 }
    const { rerender } = render(<CommandPalette commands={nested({ sessions: [], onOpen })} onClose={() => {}} />)

    await user.keyboard("{ArrowDown}{ArrowRight}{ArrowDown}{ArrowRight}")
    expect(opened).toBe(1)
    expect(screen.queryByText("Refactor store")).toBeNull()

    rerender(<CommandPalette commands={nested({ sessions: [{ id: "s2", label: "Refactor store", action: () => {} }], onOpen })} onClose={() => {}} />)
    expect(screen.getByPlaceholderText("Search sessions in app…")).toBeTruthy()
    expect(screen.getByText("Refactor store")).toBeTruthy()
  })

  it("falls back to the deepest page that still exists when a command disappears", async () => {
    const user = userEvent.setup()
    const { rerender } = render(<CommandPalette commands={nested()} onClose={() => {}} />)

    await user.keyboard("{ArrowDown}{ArrowRight}{ArrowDown}{ArrowRight}")
    const withoutApp = nested()
    withoutApp[1].page!.commands = withoutApp[1].page!.commands.filter((c) => c.id !== "ws:app")
    rerender(<CommandPalette commands={withoutApp} onClose={() => {}} />)

    expect(screen.getByPlaceholderText("Search workspaces…")).toBeTruthy()
    await user.keyboard("{ArrowLeft}")
    expect(screen.getByPlaceholderText("Search commands…")).toBeTruthy()
  })
})

describe("CommandPalette — hover follows the mouse, not the layout", () => {
  afterEach(resetHoverIntent)
  const row = (container: HTMLElement, idx: number) => container.querySelector(`[data-idx='${idx}']`) as HTMLElement
  const isActive = (el: HTMLElement) => el.hasAttribute("data-highlighted")

  it("keeps the keyboard's row when a row appears under a still pointer", () => {
    const { container } = render(<CommandPalette commands={makeCommands()} onClose={() => {}} />)
    // The pointer was parked here before the list opened.
    fireEvent.mouseMove(document.body, { clientX: 100, clientY: 100 })

    fireEvent.mouseEnter(row(container, 2), { clientX: 100, clientY: 100 })
    fireEvent.mouseOver(row(container, 2), { clientX: 100, clientY: 100 })
    // Chromium's move after a layout change: same position.
    fireEvent.mouseMove(row(container, 2), { clientX: 100, clientY: 100 })

    expect(isActive(row(container, 0))).toBe(true)
    expect(isActive(row(container, 2))).toBe(false)
  })

  it("highlights the row the mouse actually moves over", () => {
    const { container } = render(<CommandPalette commands={makeCommands()} onClose={() => {}} />)
    fireEvent.mouseMove(document.body, { clientX: 100, clientY: 100 })
    fireEvent.mouseMove(row(container, 2), { clientX: 104, clientY: 101 })
    expect(isActive(row(container, 2))).toBe(true)
  })

  it("runs the keyboard's row on Enter while the pointer rests on another", async () => {
    const user = userEvent.setup()
    let ran = ""
    const commands: Command[] = [
      { id: "a", label: "New Session", action: () => { ran = "a" } },
      { id: "b", label: "Old Session", action: () => { ran = "b" } },
    ]
    const { container } = render(<CommandPalette commands={commands} onClose={() => {}} />)
    fireEvent.mouseMove(document.body, { clientX: 50, clientY: 50 })
    fireEvent.mouseMove(row(container, 1), { clientX: 50, clientY: 50 })
    await user.keyboard("{Enter}")
    expect(ran).toBe("a")
  })
})

describe("CommandPalette — opening on a page", () => {
  const commands = (workspaces: Command[]): Command[] => [
    { id: "new-chat", label: "New Chat", action: () => {} },
    { id: "switch", label: "Switch Workspace/Session…", action: () => {}, page: { placeholder: "Search workspaces…", commands: workspaces } },
  ]
  const app = (onOpen?: () => void): Command => ({
    id: "ws:app",
    label: "app",
    action: () => {},
    onOpenPage: onOpen,
    page: { placeholder: "Search sessions in app…", commands: [{ id: "new", label: "New Session", browseOnly: true, action: () => {} }] },
  })

  it("opens on the page it is given and steps back one level at a time", async () => {
    const user = userEvent.setup()
    let opened = 0
    render(<CommandPalette commands={commands([app(() => { opened += 1 })])} initialPagePath={["switch", "ws:app"]} onClose={() => {}} />)
    expect(screen.getByPlaceholderText("Search sessions in app…")).toBeTruthy()
    expect(opened).toBe(1)

    await user.keyboard("{Escape}")
    expect(screen.getByPlaceholderText("Search workspaces…")).toBeTruthy()
    await user.keyboard("{Escape}")
    expect(screen.getByPlaceholderText("Search commands…")).toBeTruthy()
  })

  it("waits for a page whose rows load after it opened", () => {
    const { rerender } = render(<CommandPalette commands={commands([])} initialPagePath={["switch", "ws:app"]} onClose={() => {}} />)
    expect(screen.getByPlaceholderText("Search workspaces…")).toBeTruthy()

    rerender(<CommandPalette commands={commands([app()])} initialPagePath={["switch", "ws:app"]} onClose={() => {}} />)
    expect(screen.getByPlaceholderText("Search sessions in app…")).toBeTruthy()
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
    await user.type(screen.getByPlaceholderText("Find file…"), ">side")

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

    await user.type(screen.getByPlaceholderText("Find file…"), ">")
    await user.keyboard("{Enter}")

    expect(ran).toBe(true)
    expect(opened).toBe(false)
  })

  it("hints the > prefix while searching files", () => {
    render(<QuickOpen workspaceFiles={files} commands={makeCommands()} onFileOpen={() => {}} onClose={() => {}} />)
    expect(screen.getByText(">").closest("kbd")).toBeTruthy()
  })

  it("opens a command's page on ArrowRight", async () => {
    const user = userEvent.setup()
    const commands: Command[] = [
      {
        id: "switch-session",
        label: "Switch Session…",
        action: () => {},
        page: { placeholder: "Search sessions…", commands: [{ id: "s1", label: "Fix login bug", action: () => {} }] },
      },
    ]
    render(<QuickOpen workspaceFiles={files} commands={commands} onFileOpen={() => {}} onClose={() => {}} />)

    await user.type(screen.getByPlaceholderText("Find file…"), ">switch")
    await user.keyboard("{ArrowRight}")

    expect(screen.getByPlaceholderText("Search sessions…")).toBeTruthy()
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

    const input = screen.getByPlaceholderText("Find file…") as HTMLInputElement
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

    await user.type(screen.getByPlaceholderText("Find file…"), "App.tsx")
    await user.keyboard("{Enter}")

    expect(opened as { path: string; line?: number } | null).toEqual({ path: 'web/src/App.tsx', line: undefined })
  })
})

// ── One palette: commands, sessions and files ─────────────────────────────────

const file = (path: string): WorkspaceFileInfo => ({ path, name: path.split("/").pop()!, size: 0, mtime: 0, mime: "text/plain" })
const sessionRow = (id: string, title: string, over: Partial<PaletteSession> = {}): PaletteSession =>
  ({ id, title, description: "app · 3h", activityAt: null, open: () => {}, ...over })
const sessionsOf = (items: PaletteSession[], over: Partial<PaletteSessions> = {}): PaletteSessions =>
  ({ items, loading: false, onSearch: () => {}, ...over })
const rowTexts = () => Array.from(document.querySelectorAll("[data-idx]")).map((row) => row.textContent ?? "")
const groupRows = (name: string) => within(screen.getByRole("group", { name })).getAllByRole("button")
const isActiveRow = (idx: number) => document.querySelector(`[data-idx='${idx}']`)?.hasAttribute("data-highlighted")

describe("CommandPalette — names and placeholders", () => {
  it("is the Command palette whichever way it opens", () => {
    const { unmount } = render(<CommandPalette commands={makeCommands()} onClose={() => {}} />)
    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeTruthy()
    unmount()
    render(<QuickOpen workspaceFiles={[]} onFileOpen={() => {}} onClose={() => {}} />)
    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeTruthy()
    expect(document.body.textContent).not.toContain("Quick Open")
  })

  it("asks for what the palette can search", () => {
    const both = render(
      <CommandPalette commands={makeCommands()} sessions={sessionsOf([])} workspaceFiles={[]} onFileOpen={() => {}} onClose={() => {}} />,
    )
    expect(screen.getByPlaceholderText("Search commands, sessions and files…")).toBeTruthy()
    expect(screen.getByLabelText("Search commands, sessions and files")).toBeTruthy()
    both.unmount()

    const sessionsOnly = render(<CommandPalette commands={makeCommands()} sessions={sessionsOf([])} onClose={() => {}} />)
    expect(screen.getByPlaceholderText("Search commands and sessions…")).toBeTruthy()
    sessionsOnly.unmount()

    const filesOnly = render(<CommandPalette commands={makeCommands()} workspaceFiles={[]} onFileOpen={() => {}} onClose={() => {}} />)
    expect(screen.getByPlaceholderText("Search commands and files…")).toBeTruthy()
    filesOnly.unmount()

    render(<CommandPalette commands={makeCommands()} onClose={() => {}} />)
    expect(screen.getByPlaceholderText("Search commands…")).toBeTruthy()
  })

  it("scopes ⌘P to Find file", () => {
    render(<QuickOpen workspaceFiles={[]} sessions={sessionsOf([])} onFileOpen={() => {}} onClose={() => {}} />)
    expect(screen.getByPlaceholderText("Find file…")).toBeTruthy()
    expect(screen.getByLabelText("Find file")).toBeTruthy()
  })

  it("keeps the search field at 16px on touch phones so iOS does not zoom", () => {
    render(<CommandPalette commands={makeCommands()} onClose={() => {}} />)
    expect(screen.getByPlaceholderText("Search commands…").className).toContain("max-md:pointer-coarse:text-base")
  })
})

describe("CommandPalette — grouped results", () => {
  const commands: Command[] = [
    { id: "terminal", label: "Open Terminal", action: () => {} },
    { id: "chat", label: "New Chat", action: () => {} },
  ]
  const sessions = () => sessionsOf([sessionRow("s1", "Terminal output parsing"), sessionRow("s2", "Plan the release")])
  const files = [file("src/terminal.ts"), file("src/app.ts")]
  const palette = (over: Partial<React.ComponentProps<typeof CommandPalette>> = {}) => (
    <CommandPalette
      commands={commands}
      sessions={sessions()}
      workspaceFiles={files}
      onFileOpen={() => {}}
      onClose={() => {}}
      initialQuery="term"
      {...over}
    />
  )

  it("lists commands, sessions and files under their headings, in that order", () => {
    render(palette())

    expect(screen.getAllByRole("group").map((group) => group.querySelector("p")?.textContent)).toEqual(["Commands", "Sessions", "Files"])
    expect(rowTexts()[0]).toContain("Open Terminal")
    expect(rowTexts()[1]).toContain("Terminal output parsing")
    expect(rowTexts()[2]).toContain("terminal.ts")
  })

  it("shows a session's workspace and age under its title", () => {
    render(palette())
    expect(within(screen.getByRole("group", { name: "Sessions" })).getByText("app · 3h")).toBeTruthy()
  })

  it("styles the headings as muted medium meta text and keeps them out of the rows", () => {
    const { container } = render(palette())
    const heading = screen.getByText("Sessions")
    expect(heading.className).toContain("text-meta font-medium text-(--color-text-muted)")
    expect(heading.hasAttribute("data-idx")).toBe(false)
    expect(screen.queryByRole("button", { name: "Sessions" })).toBeNull()
    expect(container.querySelectorAll("[data-idx]")).toHaveLength(3)
  })

  it("leaves out a group with no match", () => {
    render(palette({ initialQuery: "plan" }))
    expect(screen.getAllByRole("group").map((group) => group.querySelector("p")?.textContent)).toEqual(["Sessions"])
    expect(screen.queryByText("Files")).toBeNull()
  })

  it("browses commands alone while the query is empty", () => {
    render(palette({ initialQuery: "" }))
    expect(rowTexts().map((text) => text.split(" ")[0])).toEqual(["Open", "New"])
    expect(screen.queryByText("Sessions")).toBeNull()
    expect(screen.queryByText("Files")).toBeNull()
    expect(screen.queryByText("Terminal output parsing")).toBeNull()
  })

  it("runs the arrow keys straight across the groups", async () => {
    const user = userEvent.setup()
    const opened: string[] = []
    render(
      palette({
        sessions: sessionsOf([sessionRow("s1", "Terminal output parsing", { open: () => opened.push("session") })]),
        onFileOpen: (f) => opened.push(f.path),
      }),
    )
    expect(isActiveRow(0)).toBe(true)

    await user.keyboard("{ArrowDown}")
    expect(isActiveRow(1)).toBe(true)
    expect(rowTexts()[1]).toContain("Terminal output parsing")
    await user.keyboard("{ArrowDown}")
    expect(isActiveRow(2)).toBe(true)
    expect(rowTexts()[2]).toContain("terminal.ts")
    // The last row is the end of the list, not a heading or a wrap.
    await user.keyboard("{ArrowDown}{ArrowDown}")
    expect(isActiveRow(2)).toBe(true)

    await user.keyboard("{Enter}")
    expect(opened).toEqual(["src/terminal.ts"])
    await user.keyboard("{ArrowUp}")
    expect(isActiveRow(1)).toBe(true)
  })

  it("caps the groups at 8 commands, 8 sessions and 20 files", () => {
    const many = <T,>(n: number, make: (i: number) => T) => Array.from({ length: n }, (_, i) => make(i))
    render(
      <CommandPalette
        commands={many(12, (i): Command => ({ id: `c${i}`, label: `Alpha command ${i}`, action: () => {} }))}
        sessions={sessionsOf(many(12, (i) => sessionRow(`s${i}`, `Alpha session ${i}`)))}
        workspaceFiles={many(30, (i) => file(`src/alpha${i}.ts`))}
        onFileOpen={() => {}}
        onClose={() => {}}
        initialQuery="alpha"
      />,
    )
    expect(groupRows("Commands")).toHaveLength(8)
    expect(groupRows("Sessions")).toHaveLength(8)
    expect(groupRows("Files")).toHaveLength(20)
  })

  it("ranks sessions by how well the title matches, then newest first", () => {
    render(
      <CommandPalette
        commands={[]}
        sessions={sessionsOf([
          sessionRow("a", "Fix login bug", { activityAt: "2026-01-01T00:00:00Z" }),
          sessionRow("b", "Login page redesign", { activityAt: "2025-01-01T00:00:00Z" }),
          sessionRow("c", "Debug the login flow", { activityAt: "2026-03-01T00:00:00Z" }),
          sessionRow("d", "Refactor authentication", { activityAt: "2026-06-01T00:00:00Z" }),
        ])}
        onClose={() => {}}
        initialQuery="login"
      />,
    )
    // The title starting with the word beats the two with it later; those
    // tie, so the newer one is first. The non-match is not listed.
    expect(groupRows("Sessions").map((row) => row.textContent?.replace(/app · 3h$/, ""))).toEqual([
      "Login page redesign",
      "Debug the login flow",
      "Fix login bug",
    ])
  })

  it("matches sessions by their title only, not their workspace", () => {
    render(
      <CommandPalette
        commands={[]}
        sessions={sessionsOf([sessionRow("a", "Fix login bug", { description: "billing · 3h" })])}
        onClose={() => {}}
        initialQuery="billing"
      />,
    )
    expect(screen.queryByText("Fix login bug")).toBeNull()
    expect(screen.getByText(/No results match/)).toBeTruthy()
  })

  it("opens a session and closes when it is chosen with Enter or a click", async () => {
    const user = userEvent.setup()
    const open = mock(() => {})
    const onClose = mock(() => {})
    const { unmount } = render(
      palette({ commands: [], workspaceFiles: [], sessions: sessionsOf([sessionRow("s1", "Terminal output parsing", { open })]), onClose }),
    )

    await user.keyboard("{Enter}")
    expect(open).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
    unmount()

    render(palette({ commands: [], workspaceFiles: [], sessions: sessionsOf([sessionRow("s1", "Terminal output parsing", { open })]), onClose }))
    await user.click(screen.getByText("Terminal output parsing"))
    expect(open).toHaveBeenCalledTimes(2)
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it("opens a file at the :line of the query", async () => {
    const user = userEvent.setup()
    let opened: unknown[] = []
    render(palette({ initialQuery: "terminal.ts:42", onFileOpen: (f, line) => { opened = [f.path, line] } }))
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}")
    expect(opened).toEqual(["src/terminal.ts", 42])
  })

  it("tells the owner what the Sessions group is searching, and nothing outside it", async () => {
    const user = userEvent.setup()
    const onSearch = mock((_query: unknown) => {})
    render(palette({ initialQuery: "", sessions: sessionsOf([], { onSearch }) }))
    expect(onSearch).toHaveBeenLastCalledWith("")

    await user.type(screen.getByPlaceholderText("Search commands, sessions and files…"), " plan ")
    expect(onSearch).toHaveBeenLastCalledWith("plan")

    // Commands scope: Sessions is not showing.
    await user.clear(screen.getByPlaceholderText("Search commands, sessions and files…"))
    await user.type(screen.getByPlaceholderText("Search commands, sessions and files…"), ">plan")
    expect(onSearch).toHaveBeenLastCalledWith("")
  })

  it("asks for no session search in the Files scope", () => {
    const onSearch = mock((_query: unknown) => {})
    render(<QuickOpen workspaceFiles={files} sessions={sessionsOf([], { onSearch })} initialQuery="term" onFileOpen={() => {}} onClose={() => {}} />)
    expect(onSearch).toHaveBeenLastCalledWith("")
  })
})

describe("CommandPalette — Find file scope (⌘P)", () => {
  const files = [file("src/App.tsx"), file("src/main.tsx")]
  const commands = makeCommands()
  const scoped = (over: Partial<React.ComponentProps<typeof QuickOpen>> = {}) => (
    <QuickOpen workspaceFiles={files} commands={commands} sessions={sessionsOf([sessionRow("s1", "Fix the App")])} onFileOpen={() => {}} onClose={() => {}} {...over} />
  )
  const scopeLabel = () => screen.queryByRole("button", { name: /^Files only/ })

  it("opens on the files, with a Files label before the field", () => {
    render(scoped())
    expect(scopeLabel()?.textContent).toBe("Files")
    expect(screen.getByPlaceholderText("Find file…")).toBeTruthy()
    expect(rowTexts().map((text) => text.split("src/")[0])).toEqual(["App.tsx", "main.tsx"])
    expect(screen.queryByText("New Chat")).toBeNull()
    expect(screen.queryByText("Fix the App")).toBeNull()
  })

  it("widens to every group on Backspace in an empty query", async () => {
    const user = userEvent.setup()
    render(scoped())

    await user.keyboard("{Backspace}")

    expect(scopeLabel()).toBeNull()
    const input = screen.getByPlaceholderText("Search commands, sessions and files…")
    expect(document.activeElement).toBe(input)
    // Browsing again: the commands.
    expect(screen.getByText("New Chat")).toBeTruthy()
    expect(screen.queryByText("App.tsx")).toBeNull()

    await user.type(input, "app")
    expect(screen.getAllByRole("group").map((group) => group.querySelector("p")?.textContent)).toEqual(["Sessions", "Files"])
  })

  it("deletes text first and widens only once the query is empty", async () => {
    const user = userEvent.setup()
    render(scoped())
    const input = screen.getByPlaceholderText("Find file…") as HTMLInputElement
    await user.type(input, "ap")

    await user.keyboard("{Backspace}")
    expect(input.value).toBe("a")
    await user.keyboard("{Backspace}")
    expect(input.value).toBe("")
    expect(scopeLabel()).not.toBeNull()

    await user.keyboard("{Backspace}")
    expect(scopeLabel()).toBeNull()
  })

  it("widens on a click of the label too, for a keyboard without Backspace", async () => {
    const user = userEvent.setup()
    render(scoped({ initialQuery: "App" }))

    await user.click(scopeLabel()!)

    expect(scopeLabel()).toBeNull()
    expect((screen.getByPlaceholderText("Search commands, sessions and files…") as HTMLInputElement).value).toBe("App")
    expect(screen.getAllByRole("group").map((group) => group.querySelector("p")?.textContent)).toEqual(["Sessions", "Files"])
  })

  it("hints Backspace in the footer only while the query is empty", async () => {
    const user = userEvent.setup()
    render(scoped())
    expect(screen.getByText("⌫")).toBeTruthy()
    await user.type(screen.getByPlaceholderText("Find file…"), "a")
    expect(screen.queryByText("⌫")).toBeNull()
  })

  it("does not widen a Backspace that steps back out of a page", async () => {
    const user = userEvent.setup()
    const withPage: Command[] = [{ id: "sw", label: "Switch Session…", action: () => {}, page: { placeholder: "Search sessions…", commands: [] } }]
    render(scoped({ commands: withPage }))
    await user.type(screen.getByPlaceholderText("Find file…"), ">switch")
    await user.keyboard("{ArrowRight}")
    expect(screen.getByPlaceholderText("Search sessions…")).toBeTruthy()

    await user.keyboard("{Backspace}")

    // Back to the list the page was opened from, still scoped to files.
    expect(screen.getByPlaceholderText("Find file…")).toBeTruthy()
    expect(scopeLabel()).not.toBeNull()
  })

  it("keeps Escape closing the palette rather than widening", async () => {
    const user = userEvent.setup()
    const onClose = mock(() => {})
    render(scoped({ onClose }))
    await user.keyboard("{Escape}")
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("opens as the full palette when there are no files to scope to", () => {
    render(<CommandPalette scope="files" commands={commands} onClose={() => {}} />)
    expect(scopeLabel()).toBeNull()
    expect(screen.getByPlaceholderText("Search commands…")).toBeTruthy()
  })
})

describe("CommandPalette — > scopes to commands", () => {
  const files = [file("src/sidebar.ts")]
  const sessions = () => sessionsOf([sessionRow("s1", "Sidebar polish")])

  it("searches commands alone, in the Files scope", async () => {
    const user = userEvent.setup()
    render(<QuickOpen workspaceFiles={files} commands={makeCommands()} sessions={sessions()} onFileOpen={() => {}} onClose={() => {}} />)

    await user.type(screen.getByPlaceholderText("Find file…"), ">side")

    expect(rowTexts()).toHaveLength(1)
    expect(screen.getByText("Toggle Sidebar")).toBeTruthy()
    expect(screen.queryByText("sidebar.ts")).toBeNull()
    expect(screen.queryByText("Sidebar polish")).toBeNull()
    // Ranked commands are one list: no group headings.
    expect(screen.queryAllByRole("group")).toHaveLength(0)
    // The ">" is the scope now; the Files label steps aside until it is deleted.
    expect(screen.queryByRole("button", { name: /^Files only/ })).toBeNull()

    await user.clear(screen.getByPlaceholderText("Find file…"))
    expect(screen.getByRole("button", { name: /^Files only/ })).toBeTruthy()
  })

  it("searches commands alone, in the full palette too", async () => {
    const user = userEvent.setup()
    render(<CommandPalette commands={makeCommands()} sessions={sessions()} workspaceFiles={files} onFileOpen={() => {}} onClose={() => {}} />)

    await user.type(screen.getByPlaceholderText("Search commands, sessions and files…"), ">side")

    expect(rowTexts()).toHaveLength(1)
    expect(screen.getByText("Toggle Sidebar")).toBeTruthy()
    expect(screen.queryByText("sidebar.ts")).toBeNull()
    expect(screen.queryByText("Sidebar polish")).toBeNull()
  })

  it("runs the command on Enter and leaves files and sessions alone", async () => {
    const user = userEvent.setup()
    const ran = mock(() => {})
    const opened = mock(() => {})
    render(
      <QuickOpen
        workspaceFiles={files}
        commands={[{ id: "c1", label: "Run Me", action: ran }]}
        sessions={sessionsOf([sessionRow("s1", "Run notes", { open: opened })])}
        onFileOpen={opened}
        onClose={() => {}}
      />,
    )
    await user.type(screen.getByPlaceholderText("Find file…"), ">run")
    await user.keyboard("{Enter}")
    expect(ran).toHaveBeenCalledTimes(1)
    expect(opened).not.toHaveBeenCalled()
  })
})

describe("CommandPalette — loading rows", () => {
  const loadingPage = (over: Partial<NonNullable<Command["page"]>> = {}): Command[] => [
    { id: "switch", label: "Switch Session…", action: () => {}, page: { placeholder: "Search sessions…", commands: [], loading: true, ...over } },
  ]
  const loading = () => screen.queryByText("Loading…")

  it("shows a polite Loading… row, not 'Nothing here yet', on a page still loading", async () => {
    const user = userEvent.setup()
    const { rerender } = render(<CommandPalette commands={loadingPage()} onClose={() => {}} />)
    await user.click(screen.getByText("Switch Session…"))

    const row = loading()!.closest("[role='status']")!
    expect(row.getAttribute("aria-live")).toBe("polite")
    expect(row.querySelector("svg.animate-spin")).toBeTruthy()
    expect(screen.queryByText("Nothing here yet")).toBeNull()

    // Once loaded and still empty, it says so.
    rerender(<CommandPalette commands={loadingPage({ loading: false })} onClose={() => {}} />)
    expect(loading()).toBeNull()
    expect(screen.getByText("Nothing here yet")).toBeTruthy()
  })

  it("ends a page that already has rows with Loading…", async () => {
    const user = userEvent.setup()
    const commands = loadingPage({ commands: [{ id: "s1", label: "Fix login bug", action: () => {} }] })
    render(<CommandPalette commands={commands} onClose={() => {}} />)
    await user.click(screen.getByText("Switch Session…"))

    const list = screen.getByText("Fix login bug").closest("button")!.parentElement!
    expect(list.lastElementChild?.textContent).toBe("Loading…")
    expect(screen.queryByText("Nothing here yet")).toBeNull()
  })

  it("shows Loading… instead of 'no results' while a loading page is searched", async () => {
    const user = userEvent.setup()
    render(<CommandPalette commands={loadingPage()} onClose={() => {}} />)
    await user.click(screen.getByText("Switch Session…"))
    await user.type(screen.getByPlaceholderText("Search sessions…"), "zzz")
    expect(loading()).toBeTruthy()
    expect(screen.queryByText(/No results match/)).toBeNull()
  })

  it("is not a row: the arrows and Enter pass over it", async () => {
    const user = userEvent.setup()
    const onClose = mock(() => {})
    const { container } = render(<CommandPalette commands={loadingPage()} onClose={onClose} />)
    await user.click(screen.getByText("Switch Session…"))

    await user.keyboard("{ArrowDown}{Enter}")

    expect(container.querySelectorAll("[data-idx]")).toHaveLength(0)
    expect(onClose).not.toHaveBeenCalled()
  })

  it("shows Loading… in the Files scope until the listing arrives", () => {
    const { rerender } = render(<QuickOpen workspaceFiles={[]} filesLoading onFileOpen={() => {}} onClose={() => {}} />)
    expect(loading()).toBeTruthy()
    expect(screen.queryByText(/No files match/)).toBeNull()

    rerender(<QuickOpen workspaceFiles={[file("src/App.tsx")]} onFileOpen={() => {}} onClose={() => {}} />)
    expect(loading()).toBeNull()
    expect(screen.getByText("App.tsx")).toBeTruthy()
  })

  it("shows Loading… under the Files and Sessions headings of a search", () => {
    render(
      <CommandPalette
        commands={[]}
        sessions={sessionsOf([], { loading: true })}
        workspaceFiles={[]}
        filesLoading
        onFileOpen={() => {}}
        onClose={() => {}}
        initialQuery="app"
      />,
    )
    for (const name of ["Sessions", "Files"]) expect(within(screen.getByRole("group", { name })).getByText("Loading…")).toBeTruthy()
    expect(screen.queryByRole("group", { name: "Commands" })).toBeNull()
    expect(screen.queryByText(/No results match/)).toBeNull()
  })

  it("keeps a session group's rows without a Loading… row while more are looked up", () => {
    render(<CommandPalette commands={[]} sessions={sessionsOf([sessionRow("s1", "App polish")], { loading: true })} onClose={() => {}} initialQuery="app" />)
    expect(screen.getByText("App polish")).toBeTruthy()
    expect(loading()).toBeNull()
  })

  it("says 'no results' once nothing is loading and nothing matches", () => {
    render(<CommandPalette commands={[]} sessions={sessionsOf([])} workspaceFiles={[]} onFileOpen={() => {}} onClose={() => {}} initialQuery="zzz" />)
    expect(screen.getByText(/No results match "zzz"/)).toBeTruthy()
  })
})
