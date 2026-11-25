/**
 * How a shell call reads: its header, terminal label and $ prefix, the
 * highlighted command, and its output as it streams and finishes.
 */
import { describe, it, expect, afterEach, beforeEach } from "bun:test"
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ToolCall } from "@/components/ToolCall"

afterEach(cleanup)

// Mock clipboard — not available in Happy DOM
beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: () => Promise.resolve() },
    configurable: true,
    writable: true,
  })
})

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------
//
// The row is `<MetaRow title="<tool name>: <target>">` — the real tool name
// in mono, then the target. These helpers find the row by its `title`
// attribute (`name: headerTitle`, or just `name` when there is no target)
// and assert the argument is rendered without italics.

/** Find the row via its whole label (`${name}: ${headerTitle}`). */
function getHeader(fullText: string): HTMLElement {
  // Linear scan by attribute — Happy DOM rejects some CSS.escape outputs
  // (e.g. escaped spaces/quotes), so avoid attribute selectors entirely.
  const candidates = document.querySelectorAll("[data-tool-label]")
  for (const node of Array.from(candidates)) {
    if (node instanceof HTMLElement && node.getAttribute("data-tool-label") === fullText) {
      return node
    }
  }
  throw new Error(`Header with data-tool-label="${fullText}" not found`)
}

/** Assert the argument portion is present without italic markup. */
function expectPlainArg(header: HTMLElement, arg: string) {
  expect(header.querySelector("em")).toBeNull()
  expect(header.textContent).toContain(arg)
}

// ---------------------------------------------------------------------------
// Custom tool display — shell
// ---------------------------------------------------------------------------

describe("ToolCall — shell display", () => {
  it("shows a background call as started, with its command number, not as output or a failure", () => {
    const args = JSON.stringify({ command: "make verify-v3", background: true, wait: true })
    const result = "[Started in the background: command 3]\nOutput: /data/sessions/s1/commands/3.log\nIts result arrives as a message when it exits."
    render(<ToolCall name="shell" args={args} done result={result} />)
    const row = document.querySelector("[data-tool-label]") as HTMLElement
    expect(row.textContent).toContain("started · command 3")
    // Opened, the status line is not repeated as terminal output.
    fireEvent.click(screen.getByRole("button", { name: "Expand shell details" }))
    expect(document.body.textContent).toContain("Output: /data/sessions/s1/commands/3.log")
    expect(document.body.textContent).not.toContain("[Started in the background")
  })

  it("pins its header while the details are open, so a long result closes from anywhere", () => {
    const args = JSON.stringify({ command: "npm test", description: "Run unit tests" })
    render(<ToolCall name="shell" args={args} done result={"[Succeeded]\nok"} />)
    const toggle = screen.getByRole("button", { name: "Expand shell details" })
    const header = toggle.parentElement as HTMLElement
    expect(header.className).not.toContain("sticky")

    fireEvent.click(toggle)
    expect(header.className).toContain("sticky")

    fireEvent.click(screen.getByRole("button", { name: "Collapse shell details" }))
    expect(header.className).not.toContain("sticky")
  })

  it("shows the description as the target, with the command only in the details", () => {
    const args = JSON.stringify({ command: "npm test", description: "Run unit tests" })
    render(<ToolCall name="shell" args={args} done={false} />)
    const header = getHeader("shell: Run unit tests")
    expectPlainArg(header, "Run unit tests")
    expect(screen.getByText("shell").className).toContain("font-mono")
    // The collapsed row shows only the description: no command, no tooltip.
    expect(screen.queryByText("npm test")).toBeNull()
    expect(header.hasAttribute("title")).toBe(false)
  })

  it("truncates a long multi-line command to one line of 80 chars", () => {
    const command = `echo ${"x".repeat(100)}\necho second`
    render(<ToolCall name="shell" args={JSON.stringify({ command })} done={false} />)
    const oneLine = command.replace(/\s*\n\s*/g, " ")
    expect(getHeader(`shell: ${oneLine}`).hasAttribute("title")).toBe(false)
    expect(screen.getByText(`${oneLine.slice(0, 80)}…`)).toBeTruthy()
  })

  it("gives no tool row a tooltip, cut or not", () => {
    const long = "x".repeat(120)
    const rows: Array<[string, Record<string, unknown>]> = [
      ["read", { path: "src/app.ts" }],
      ["shell", { command: "ls" }],
      ["shell", { command: `echo ${long}`, description: "Echo" }],
      ["web_search", { query: long }],
      ["web_fetch", { url: `https://example.com/${long}` }],
      ["grep", { pattern: long }],
      ["glob", { pattern: long }],
    ]
    for (const [name, args] of rows) {
      const { container, unmount } = render(<ToolCall name={name} args={JSON.stringify(args)} done={false} />)
      expect({ name, titles: Array.from(container.querySelectorAll("[title]")).map((el) => el.getAttribute("title")) }).toEqual({ name, titles: [] })
      unmount()
    }
  })

  it("shows a cut web_fetch URL whole, as fetched, as the open row's first line", async () => {
    const user = userEvent.setup()
    const url = `https://www.example.com/docs/${"section-".repeat(12)}end?q=1`
    render(<ToolCall name="web_fetch" args={JSON.stringify({ url })} done={false} />)
    await user.click(screen.getByRole("button", { name: /^Expand web_fetch details$/ }))
    const details = document.getElementById(screen.getByRole("button", { name: "Collapse arguments" }).getAttribute("aria-controls")!)!
    // The arguments section leads the open row, with the URL as fetched and its Copy.
    expect(details.querySelector("p")!.textContent).toBe(url)
    expect(screen.getByRole("button", { name: "Copy arguments" })).toBeTruthy()
  })

  it("shows a cut search query and grep pattern whole in the open row", async () => {
    const user = userEvent.setup()
    const long = `find ${"words ".repeat(15)}here`
    for (const [name, args] of [["web_search", { query: long }], ["grep", { pattern: long }]] as const) {
      const { unmount } = render(<ToolCall name={name} args={JSON.stringify(args)} done={false} />)
      await user.click(screen.getByRole("button", { name: new RegExp(`^Expand ${name} details$`) }))
      expect(screen.getByText(long)).toBeTruthy()
      unmount()
    }
  })


  it("shows command string as args instead of JSON", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ command: "npm test", description: "Run unit tests" })
    render(<ToolCall name="shell" args={args} done={false} />)
    await user.click(screen.getByRole("button"))
    // The command is now syntax-highlighted and may be split across spans —
    // assert via the <pre>'s full textContent rather than exact text match.
    const pre = document.querySelector("pre")
    expect(pre).toBeTruthy()
    expect(pre!.textContent).toContain("npm test")
    expect(screen.queryByText(/"command"/)).toBeNull()
  })

  it("escapes highlighted shell command HTML", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({
      command: 'printf "<script>window.__pwned = true</script>\\n<img src=x onerror=window.__pwned=true>"',
      description: 'Print payload',
    })
    render(<ToolCall name="shell" args={args} done={false} />)

    await user.click(screen.getByRole("button"))

    await waitFor(() => expect(document.body.textContent).toContain('<script>window.__pwned = true</script>'))
    expect(document.querySelector('script')).toBeNull()
    expect(document.querySelector('img[src="x"]')).toBeNull()
    expect((window as Window & { __pwned?: boolean }).__pwned).toBeUndefined()
    expect(document.body.textContent).toContain('<img src=x onerror=window.__pwned=true>')
  })

  it("shows the tool name and the bare command when shell has no description", () => {
    const args = JSON.stringify({ command: "ls" })
    render(<ToolCall name="shell" args={args} done={false} />)
    expect(screen.getByText("shell")).toBeTruthy()
    expect(screen.getByText("ls")).toBeTruthy()
    expect(getHeader("shell: ls")).toBeTruthy()
    expect(screen.queryByText("Shell")).toBeNull()
  })

  it("shows the tool name and the bare command when shell description is empty", () => {
    const args = JSON.stringify({ command: "ls", description: "" })
    render(<ToolCall name="shell" args={args} done={false} />)
    expect(screen.getByText("shell")).toBeTruthy()
    expect(screen.getByText("ls")).toBeTruthy()
    expect(getHeader("shell: ls")).toBeTruthy()
    expect(screen.queryByText("Shell")).toBeNull()
  })

  it("falls back to the description as the target when shell has no command", () => {
    const args = JSON.stringify({ description: "Run unit tests" })
    render(<ToolCall name="shell" args={args} done={false} />)
    expect(getHeader("shell: Run unit tests")).toBeTruthy()
    expect(screen.getByText("Run unit tests")).toBeTruthy()
  })

  // A streaming tool never opens itself: its details open only on a click.
  it("stays closed while live output streams", () => {
    const args = JSON.stringify({ command: "echo hi" })
    render(<ToolCall name="shell" args={args} done={false} liveOutput={"hi\n"} />)

    const toggle = screen.getAllByRole("button")[0]
    expect(toggle.getAttribute("aria-expanded")).toBe("false")
    expect(toggle.querySelector("svg")?.getAttribute("class") ?? "").not.toContain("rotate-90")
    expect(screen.queryByText("terminal")).toBeNull()
    expect(document.querySelector("pre")).toBeNull()
  })

  it("shows live output once the user opens the row", () => {
    const args = JSON.stringify({ command: "echo hi" })
    render(<ToolCall name="shell" args={args} done={false} liveOutput={"hi\n"} />)
    fireEvent.click(screen.getAllByRole("button")[0])

    expect(screen.getByText("terminal")).toBeTruthy()
    // "hi" may be wrapped in a token span — query the pre's full textContent
    const pre = document.querySelector("pre")
    expect(pre).toBeTruthy()
    expect(pre!.textContent).toContain("hi")
  })

  it("stays closed when the final result replaces live output", () => {
    const args = JSON.stringify({ command: "printf live" })
    const { rerender } = render(
      <ToolCall name="shell" args={args} done={false} liveOutput={"live-output\n"} />,
    )

    rerender(
      <ToolCall
        name="shell"
        args={args}
        done={true}
        liveOutput={"live-output\n"}
        result={"[Succeeded]\n\nfinal-output\n"}
      />,
    )

    expect(screen.getAllByRole("button")[0].getAttribute("aria-expanded")).toBe("false")
  })

  // A row the user opened while it ran stays open on its result.
  it("keeps a row the user opened open after the tool finishes", () => {
    const args = JSON.stringify({ command: "printf live" })
    const { rerender } = render(
      <ToolCall name="shell" args={args} done={false} liveOutput={"live-output\n"} />,
    )
    const toggle = () => screen.getAllByRole("button")[0]
    expect(toggle().getAttribute("aria-expanded")).toBe("false")
    fireEvent.click(toggle())
    expect(toggle().getAttribute("aria-expanded")).toBe("true")

    rerender(
      <ToolCall name="shell" args={args} done liveOutput={"live-output\n"} result={"[Succeeded]\n\nfinal-output\n"} />,
    )
    expect(toggle().getAttribute("aria-expanded")).toBe("true")
    expect(document.querySelector("pre")!.textContent).toContain("final-output")
  })

  it("does not open a finished tool", () => {
    const args = JSON.stringify({ command: "true" })
    render(<ToolCall name="shell" args={args} done result={"[Succeeded]\n"} />)
    expect(screen.getAllByRole("button")[0].getAttribute("aria-expanded")).toBe("false")
  })

  it("renders the latest live shell tail and scrolls on each update", () => {
    const args = JSON.stringify({ command: "printf live" })
    const { rerender } = render(
      <ToolCall name="shell" args={args} done={false} liveOutput={"line-1\n"} />,
    )
    fireEvent.click(screen.getAllByRole("button")[0])
    const pre = document.querySelector("pre") as HTMLPreElement
    let scrollWrites = 0
    Object.defineProperty(pre, "scrollTop", {
      configurable: true,
      get: () => 0,
      set: () => { scrollWrites += 1 },
    })

    rerender(
      <ToolCall name="shell" args={args} done={false} liveOutput={"line-1\nline-2\n"} />,
    )

    expect(pre.textContent).toContain("line-2")
    expect(scrollWrites).toBeGreaterThan(0)
  })

  it("pauses auto-scroll when the user scrolls up in the live output", () => {
    const args = JSON.stringify({ command: "printf live" })
    const { rerender } = render(
      <ToolCall name="shell" args={args} done={false} liveOutput={"line-1\n"} />,
    )
    fireEvent.click(screen.getAllByRole("button")[0])
    const pre = document.querySelector("pre") as HTMLPreElement
    let currentScrollTop = 0
    let scrollWrites = 0
    Object.defineProperty(pre, "scrollHeight", { configurable: true, get: () => 500 })
    Object.defineProperty(pre, "clientHeight", { configurable: true, get: () => 100 })
    Object.defineProperty(pre, "scrollTop", {
      configurable: true,
      get: () => currentScrollTop,
      set: (val: number) => {
        currentScrollTop = val
        scrollWrites += 1
      },
    })

    // Simulate user scrolling up (scrollTop = 50, so distFromBottom = 500 - 50 - 100 = 350 > 30)
    currentScrollTop = 50
    fireEvent.scroll(pre)

    const writesBefore = scrollWrites
    rerender(
      <ToolCall name="shell" args={args} done={false} liveOutput={"line-1\nline-2\n"} />,
    )

    expect(pre.textContent).toContain("line-2")
    // Should NOT force scroll to bottom because user detached
    expect(scrollWrites).toBe(writesBefore)
  })
})

// ---------------------------------------------------------------------------
// Recent changes: shell terminal label, $ prefix, formattedArgs copy, empty args
// ---------------------------------------------------------------------------

describe("ToolCall — shell terminal label and formatting", () => {
  it("shows 'terminal' label instead of 'arguments' for shell tool", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ command: "npm test", description: "Run tests" })
    render(<ToolCall name="shell" args={args} done={false} />)
    await user.click(screen.getByRole("button"))
    expect(screen.getByText("terminal")).toBeTruthy()
    expect(screen.queryByText("arguments")).toBeNull()
  })

  it("renders shell command with $ prefix and syntax-highlighted code", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ command: "npm test", description: "Run tests" })
    render(<ToolCall name="shell" args={args} done={false} />)
    await user.click(screen.getByRole("button"))
    // The pre contains $ + highlighted command; textContent collapses spans
    const pre = document.querySelector("pre")
    expect(pre).toBeTruthy()
    expect(pre!.textContent).toContain("$ npm test")
    // The command is wrapped in a <code> for syntax highlighting
    const code = pre!.querySelector("code")
    expect(code).toBeTruthy()
  })

  it("renders completed shell command and output as one terminal block", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ command: "npm test", description: "Run tests" })
    render(
      <ToolCall
        name="shell"
        args={args}
        done={true}
        result={"[Succeeded]\n\nall tests passed\n"}
      />,
    )

    await user.click(screen.getByRole("button"))
    // Highlighted command splits tokens across spans — use textContent
    const pre = document.querySelector("pre")
    expect(pre).toBeTruthy()
    expect(pre!.textContent).toContain("npm test")
    expect(pre!.textContent).toContain("all tests passed")
    expect(screen.getByText("terminal")).toBeTruthy()
    expect(screen.queryByText("result")).toBeNull()
    // The `[Succeeded]` status line is not output, and no exit chip repeats it
    expect(pre!.textContent).not.toContain("[Succeeded]")
    expect(screen.queryByText("exit 0")).toBeNull()
  })

  it("$ prefix is non-selectable (select-none class)", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ command: "ls -la", description: "List files" })
    render(<ToolCall name="shell" args={args} done={false} />)
    await user.click(screen.getByRole("button"))
    // pre textContent contains the full command string even when highlighted
    const pre = document.querySelector("pre")
    expect(pre).toBeTruthy()
    expect(pre!.textContent).toContain("ls")
    const dollarSpan = pre!.querySelector("span.select-none")
    expect(dollarSpan).toBeTruthy()
    expect(dollarSpan!.textContent).toBe("$ ")
  })

  it("copies the terminal command and output, not the full JSON", async () => {
    const user = userEvent.setup()
    let copiedText = ""
    const mockWriteText = async (text: string) => {
      copiedText = text
    }
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: mockWriteText },
      writable: true,
    })

    try {
      const args = JSON.stringify({ command: "npm test", description: "Run tests" })
      render(
        <ToolCall
          name="shell"
          args={args}
          done={true}
          result={"[Succeeded]\n\nall tests passed\n"}
        />,
      )
      await user.click(screen.getByRole("button"))
      const copyBtn = screen.getByLabelText("Copy command and output")
      await user.click(copyBtn)
      expect(copiedText).toBe("npm test\nall tests passed\n")
      expect(copiedText).not.toContain("command")
      expect(copiedText).not.toContain("description")
    } finally {
      // Restore original clipboard
      Object.defineProperty(navigator, "clipboard", {
        value: navigator.clipboard,
        writable: true,
      })
    }
  })
})

// ---------------------------------------------------------------------------
// Shell syntax highlighting — ShellCommand tokenises the command string with
// the shared highlighter.  Tokens end up as <span class="th-token th-*">
// children inside a <code> element; the pre's textContent stays intact for
// copy.
// ---------------------------------------------------------------------------

describe("ToolCall — shell syntax highlighting", () => {
  it("wraps the command in a <code> element for syntax highlighting", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ command: "git status", description: "Check status" })
    render(<ToolCall name="shell" args={args} done={false} />)
    await user.click(screen.getByRole("button"))
    const code = document.querySelector("pre code")
    expect(code).toBeTruthy()
    expect(code!.textContent).toContain("git status")
  })

  it("pre textContent still contains the full command for copy purposes", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ command: "bun run build --minify", description: "Build" })
    render(<ToolCall name="shell" args={args} done={false} />)
    await user.click(screen.getByRole("button"))
    const pre = document.querySelector("pre")
    expect(pre!.textContent).toContain("bun run build --minify")
  })

  it("tokenises shell keywords into keyword spans", async () => {
    const user = userEvent.setup()
    // "export" is a recognised shell keyword
    const args = JSON.stringify({ command: "export NODE_ENV=production", description: "Set env" })
    render(<ToolCall name="shell" args={args} done={false} />)
    await user.click(screen.getByRole("button"))
    const keyword = document.querySelector("pre code .th-keyword")
    expect(keyword).toBeTruthy()
    expect(keyword!.textContent).toBe("export")
  })

  it("tokenises quoted strings into string spans", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ command: 'echo "hello world"', description: "Echo" })
    render(<ToolCall name="shell" args={args} done={false} />)
    await user.click(screen.getByRole("button"))
    const str = document.querySelector("pre code .th-string")
    expect(str).toBeTruthy()
    expect(str!.textContent).toContain("hello world")
  })

  it("falls back gracefully and still renders when command is an empty string", () => {
    // formattedArgs is falsy → isShellTerminal is false; no terminal block rendered
    const args = JSON.stringify({ command: "", description: "Empty" })
    render(<ToolCall name="shell" args={args} done={false} />)
    // No expand button — nothing to show; the row falls back to the description
    expect(screen.queryByRole("button")).toBeNull()
    expect(screen.getByLabelText("shell (no details)")).toBeTruthy()
    expect(screen.getByText("Empty")).toBeTruthy()
    expect(document.querySelector("pre")).toBeNull()
  })
})
