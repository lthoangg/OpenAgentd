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
// Header markup is `<span title="…">verb <span>arg</span></span>`.
// These helpers find the header span by its `title` attribute (which mirrors
// the full text) and assert the argument is rendered without italics.

/** Find the header span via its title tooltip (matches the full header text). */
function getHeader(fullText: string): HTMLElement {
  // Linear scan by attribute — Happy DOM rejects some CSS.escape outputs
  // (e.g. escaped spaces/quotes), so avoid attribute selectors entirely.
  const candidates = document.querySelectorAll("[title]")
  for (const node of Array.from(candidates)) {
    if (node instanceof HTMLElement && node.getAttribute("title") === fullText) {
      return node
    }
  }
  throw new Error(`Header with title="${fullText}" not found`)
}

/** Assert the argument portion is present without italic markup. */
function expectPlainArg(header: HTMLElement, arg: string) {
  expect(header.querySelector("em")).toBeNull()
  expect(header.textContent).toContain(arg)
}

// ---------------------------------------------------------------------------
// Header / status rendering
// ---------------------------------------------------------------------------

describe("ToolCall — header", () => {
  it("shows tool name when no custom display config", () => {
    render(<ToolCall name="custom_tool" args='{"path":"src/main.py"}' done={false} />)
    expect(screen.getByText("Custom Tool")).toBeTruthy()
  })

  it("shows only the tool name when no args", () => {
    render(<ToolCall name="read" />)
    expect(screen.getByText("Read")).toBeTruthy()
    expect(screen.queryByText("pending")).toBeNull()
  })

  it("shows the basename for a Windows file path", () => {
    const args = JSON.stringify({ path: String.raw`C:\repo\src\main.py` })
    render(<ToolCall name="read" args={args} done={false} />)
    expect(getHeader("main.py")).toBeTruthy()
  })

  it("shows running state when args are set and result is not done", () => {
    render(<ToolCall name="read" args='{"path":"x"}' done={false} />)
    expect(screen.queryByText("pending")).toBeNull()
    // Running state: no pending badge, no result section until expanded details exist
    const btn = screen.getByRole("button")
    expect(btn).toBeTruthy()
  })

  it("shows success state when done without failed result", () => {
    render(<ToolCall name="read" args='{"path":"x"}' done={true} />)
    expect(screen.queryByText("pending")).toBeNull()
    // Success state: no pending badge
    const btn = screen.getByRole("button")
    expect(btn).toBeTruthy()
  })

  it("displays persisted duration_ms when done", () => {
    render(<ToolCall name="read" args='{"path":"x"}' done={true} durationMs={1234} />)
    expect(screen.getByText("1.2s")).toBeTruthy()
  })

  it("displays long durations as minutes and seconds", () => {
    render(<ToolCall name="read" args='{"path":"x"}' done={true} durationMs={93_000} />)
    expect(screen.getByText("1m 33s")).toBeTruthy()
  })

  it("displays realtime elapsed counting while running", async () => {
    render(<ToolCall name="read" args='{"path":"x"}' done={false} startedAt={Date.now() - 1500} />)
    await waitFor(() => {
      expect(screen.getByText(/1\.[5-9]s|2\.0s/)).toBeTruthy()
    })
  })
})

// ---------------------------------------------------------------------------
// Custom tool display — shell
// ---------------------------------------------------------------------------

describe("ToolCall — shell display", () => {
  it("replaces tool name with plain description when present", () => {
    const args = JSON.stringify({ command: "npm test", description: "Run unit tests" })
    render(<ToolCall name="shell" args={args} done={false} />)
    const header = getHeader("Run unit tests")
    expectPlainArg(header, "Run unit tests")
    expect(screen.queryByText("shell")).toBeNull()
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

  it("falls back to tool name when shell has no description", () => {
    const args = JSON.stringify({ command: "ls" })
    render(<ToolCall name="shell" args={args} done={false} />)
    expect(screen.getByText("Shell")).toBeTruthy()
  })

  it("falls back to tool name when shell description is empty", () => {
    const args = JSON.stringify({ command: "ls", description: "" })
    render(<ToolCall name="shell" args={args} done={false} />)
    expect(screen.getByText("Shell")).toBeTruthy()
  })

  it("auto-expands live output before the final result arrives", () => {
    const args = JSON.stringify({ command: "echo hi" })
    render(<ToolCall name="shell" args={args} done={false} liveOutput={"hi\n"} />)

    expect(screen.getByText("terminal")).toBeTruthy()
    // "hi" may be wrapped in a token span — query the pre's full textContent
    const pre = document.querySelector("pre")
    expect(pre).toBeTruthy()
    expect(pre!.textContent).toContain("hi")
  })

  it("does not keep auto-expanded state after final result replaces live output", () => {
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

  it("renders the latest live shell tail and scrolls on each update", () => {
    const args = JSON.stringify({ command: "printf live" })
    const { rerender } = render(
      <ToolCall name="shell" args={args} done={false} liveOutput={"line-1\n"} />,
    )
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
// Custom tool display — web_search
// ---------------------------------------------------------------------------

describe("ToolCall — web_search display", () => {
  it("shows conversational header with query", () => {
    const args = JSON.stringify({ query: "latest python release" })
    render(<ToolCall name="web_search" args={args} done={false} />)
    const header = getHeader('"latest python release"')
    expectPlainArg(header, '"latest python release"')
    expect(screen.queryByText("web_search")).toBeNull()
  })

  it("hides redundant query args already shown in the header", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ query: "react hooks guide" })
    render(<ToolCall name="web_search" args={args} done={false} />)
    await user.click(screen.getByRole("button"))
    expect(screen.queryByText("arguments")).toBeNull()
    expect(screen.queryByText(/"query"/)).toBeNull()
  })
})

describe("ToolCall — diff stats", () => {
  it("renders read results with write/edit-style file chrome", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ path: "src/main.py", offset: 12, limit: 9 })

    render(<ToolCall name="read" args={args} done={true} result={"[12-20/100]\nprint('hello')\nprint('bye')"} />)

    expect(screen.getByRole("button", { name: "Expand read details" })).toBeTruthy()
    expect(screen.queryByText("result")).toBeNull()

    await user.click(screen.getByRole("button", { name: "Expand read details" }))

    expect(screen.getByRole("button", { name: "Collapse read result" })).toBeTruthy()
    expect(screen.getByText("lines 12-20 of 100")).toBeTruthy()
    expect(screen.getByLabelText("Copy read result")).toBeTruthy()
    expect(screen.getByText("12")).toBeTruthy()
    expect(screen.getByText("13")).toBeTruthy()
    expect(screen.getByText("print('hello')")).toBeTruthy()
    expect(screen.getByText("print('bye')")).toBeTruthy()
    expect(screen.queryByText(/\[12-20\/100\]/)).toBeNull()
  })

  it("collapses the whole read result when clicking the read file header", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ path: "src/main.py" })

    render(<ToolCall name="read" args={args} done={true} result="file content" />)

    await user.click(screen.getByRole("button", { name: "Expand read details" }))
    expect(screen.getByRole("button", { name: "Collapse read result" })).toBeTruthy()

    await user.click(screen.getByRole("button", { name: "Collapse read result" }))

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Expand read details" })).toBeTruthy()
    })
  })

  it("copies read content from the file header copy button", async () => {
    let copiedText = ""
    const user = userEvent.setup()
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: async (text: string) => { copiedText = text } },
      configurable: true,
      writable: true,
    })
    const args = JSON.stringify({ path: "src/main.py" })

    render(<ToolCall name="read" args={args} done={true} result={"[1-2/2]\nhello\nworld"} />)

    await user.click(screen.getByRole("button", { name: "Expand read details" }))
    await user.click(screen.getByLabelText("Copy read result"))

    await waitFor(() => expect(copiedText).toBe("hello\nworld"))
  })

})

describe("ToolCall — file search display", () => {
  it("hides glob args already shown in the header", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ pattern: "web/src/**/*.tsx", directory: "web", match: "name" })
    render(<ToolCall name="glob" args={args} done={false} />)

    expectPlainArg(getHeader("Finding web/src/**/*.tsx in web (by name)"), "web/src/**/*.tsx")
    await user.click(screen.getByRole("button"))
    expect(screen.queryByText("arguments")).toBeNull()
  })

  it("hides grep args already shown in the header", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ pattern: "useEffect", directory: "web/src", include: "*.tsx" })
    render(<ToolCall name="grep" args={args} done={false} />)

    expectPlainArg(getHeader("Searching useEffect in web/src (*.tsx)"), "useEffect")
    await user.click(screen.getByRole("button"))
    expect(screen.queryByText("arguments")).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Custom tool display — web_fetch
// ---------------------------------------------------------------------------

describe("ToolCall — web_fetch display", () => {
  it("shows conversational header with domain and full path", () => {
    const args = JSON.stringify({ url: "https://docs.python.org/3/library/asyncio.html" })
    render(<ToolCall name="web_fetch" args={args} done={false} />)
    const header = getHeader("docs.python.org/3/library/asyncio.html")
    expectPlainArg(header, "docs.python.org/3/library/asyncio.html")
    expect(screen.queryByText("web_fetch")).toBeNull()
  })

  it("strips www from domain but keeps the path", () => {
    const args = JSON.stringify({ url: "https://www.example.com/page" })
    render(<ToolCall name="web_fetch" args={args} done={false} />)
    const header = getHeader("example.com/page")
    expectPlainArg(header, "example.com/page")
  })

  it("keeps the query string", () => {
    const args = JSON.stringify({ url: "https://example.com/search?q=asyncio" })
    render(<ToolCall name="web_fetch" args={args} done={false} />)
    expectPlainArg(getHeader("example.com/search?q=asyncio"), "example.com/search?q=asyncio")
  })

  it("elides a bare trailing slash", () => {
    const args = JSON.stringify({ url: "https://example.com/" })
    render(<ToolCall name="web_fetch" args={args} done={false} />)
    expectPlainArg(getHeader("example.com"), "example.com")
  })

  it("truncates a long path at 60 chars but keeps the full URL in the tooltip", () => {
    const url = "https://www.nytimes.com/2024/03/15/technology/artificial-intelligence-regulation-europe.html"
    render(<ToolCall name="web_fetch" args={JSON.stringify({ url })} done={false} />)
    // Tooltip carries the untruncated location (80 chars, www stripped)…
    const header = getHeader("nytimes.com/2024/03/15/technology/artificial-intelligence-regulation-europe.html")
    // …while the visible text is capped at 60 chars + ellipsis.
    expectPlainArg(header, "nytimes.com/2024/03/15/technology/artificial-intelligence-re…")
    expect(header.textContent).not.toContain("regulation-europe")
  })

  it("truncates a long URL carrying a fragment", () => {
    const url = "https://github.com/lthoangg/openagentd/blob/main/web/src/components/ToolCall/display.tsx#L193"
    render(<ToolCall name="web_fetch" args={JSON.stringify({ url })} done={false} />)
    const header = getHeader("github.com/lthoangg/openagentd/blob/main/web/src/components/ToolCall/display.tsx#L193")
    expectPlainArg(header, "github.com/lthoangg/openagentd/blob/main/web/src/components/…")
  })

  it("does not truncate a long URL that fits within the cap", () => {
    // 59 chars once the scheme is stripped — exercises the boundary below 60.
    const url = "https://example.com/docs/guides/getting-started/installation"
    render(<ToolCall name="web_fetch" args={JSON.stringify({ url })} done={false} />)
    const header = getHeader("example.com/docs/guides/getting-started/installation")
    expectPlainArg(header, "example.com/docs/guides/getting-started/installation")
    expect(header.textContent).not.toContain("…")
  })

  it("hides redundant URL args", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ url: "https://docs.python.org/3/library/asyncio.html" })
    render(<ToolCall name="web_fetch" args={args} done={false} />)
    await user.click(screen.getByRole("button"))
    expect(screen.queryByText("arguments")).toBeNull()
    expect(screen.queryByText("https://docs.python.org/3/library/asyncio.html")).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Custom tool display — memory tools (remember, forget, recall)
// ---------------------------------------------------------------------------

describe("ToolCall — remember display", () => {
  it("shows conversational header", () => {
    const args = JSON.stringify({ items: [{ category: "preference", key: "style", value: "concise" }] })
    render(<ToolCall name="remember" args={args} done={false} />)
    // Header is a plain conversational string — no plain argument.
    const header = getHeader("Saving to memory…")
    expect(header.textContent).toBe("Saving to memory…")
    expect(header.querySelector("em")).toBeNull()
    expect(screen.queryByText("remember")).toBeNull()
  })

  it("shows [category] key: value as args", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ items: [{ category: "preference", key: "style", value: "concise" }] })
    render(<ToolCall name="remember" args={args} done={false} />)
    await user.click(screen.getByRole("button"))
    expect(screen.getByText(/\[preference\] style: concise/)).toBeTruthy()
  })

  it("shows multiple items on separate lines", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ items: [
      { category: "identity", key: "role", value: "Engineer" },
      { category: "preference", key: "style", value: "concise" },
    ]})
    render(<ToolCall name="remember" args={args} done={false} />)
    await user.click(screen.getByRole("button"))
    expect(screen.getByText(/\[identity\] role: Engineer/)).toBeTruthy()
    expect(screen.getByText(/\[preference\] style: concise/)).toBeTruthy()
  })
})

describe("ToolCall — forget display", () => {
  it("shows conversational header", () => {
    const args = JSON.stringify({ items: [{ category: "preference", key: "style" }] })
    render(<ToolCall name="forget" args={args} done={false} />)
    const header = getHeader("Removing from memory…")
    expect(header.textContent).toBe("Removing from memory…")
    expect(header.querySelector("em")).toBeNull()
    expect(screen.queryByText("forget")).toBeNull()
  })

  it("shows category: key as args", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ items: [{ category: "preference", key: "style" }] })
    render(<ToolCall name="forget" args={args} done={false} />)
    await user.click(screen.getByRole("button"))
    expect(screen.getByText("preference: style")).toBeTruthy()
  })

  it("shows just category when no key", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ items: [{ category: "preference" }] })
    render(<ToolCall name="forget" args={args} done={false} />)
    await user.click(screen.getByRole("button"))
    expect(screen.getByText("preference")).toBeTruthy()
  })
})

describe("ToolCall — recall display", () => {
  it("shows friendly pending header when no args", () => {
    // Pending header keeps the start phase visible across the
    // tool_call → tool_start gap (which is typically <50ms).
    render(<ToolCall name="recall" done={false} />)
    expect(screen.getByText("Checking memory…")).toBeTruthy()
    expect(screen.queryByText("recall")).toBeNull()
  })

  it("shows conversational header with args", () => {
    const args = JSON.stringify({ category: "preference" })
    render(<ToolCall name="recall" args={args} done={false} />)
    const header = getHeader("Checking memory…")
    expect(header.textContent).toBe("Checking memory…")
    expect(header.querySelector("em")).toBeNull()
  })

  it("shows category filter as args when provided", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ category: "preference" })
    render(<ToolCall name="recall" args={args} done={true} />)
    await user.click(screen.getByRole("button"))
    expect(screen.getByText("preference")).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// Default display — uncustomised tools show name + JSON
// ---------------------------------------------------------------------------

describe("ToolCall — default display", () => {
  it("shows tool name for uncustomised tools", () => {
    render(<ToolCall name="custom_tool" args='{"path":"x","value":"test"}' done={false} />)
    expect(screen.getByText("Custom Tool")).toBeTruthy()
  })

  it("shows pretty-printed JSON args", async () => {
    const user = userEvent.setup()
    render(<ToolCall name="custom_tool" args='{"path":"src/main.py"}' done={false} />)
    await user.click(screen.getByRole("button"))
    expect(screen.getByText(/path/)).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// Expand / collapse
// ---------------------------------------------------------------------------

describe("ToolCall — expand/collapse", () => {
  it("is not expandable when no details", async () => {
    const user = userEvent.setup()
    render(<ToolCall name="date" />)
    const btn = screen.getByRole("button")
    await user.click(btn)
    expect(screen.queryByText("arguments")).toBeNull()
  })

  it("expands to show args on click", async () => {
    const user = userEvent.setup()
    render(<ToolCall name="custom_tool" args='{"path":"hello.txt"}' done={false} />)
    await user.click(screen.getByRole("button"))
    expect(screen.getByText("arguments")).toBeTruthy()
    expect(screen.getByText(/path/)).toBeTruthy()
  })

  it("collapses on second click", async () => {
    const user = userEvent.setup()
    render(<ToolCall name="custom_tool" args='{"path":"hi.txt"}' done={false} />)
    const btn = screen.getByRole("button")
    await user.click(btn)
    expect(btn.getAttribute("aria-expanded")).toBe("true")
    await user.click(btn)
    expect(btn.getAttribute("aria-expanded")).toBe("false")
  })

  it("aria-expanded starts false", () => {
    render(<ToolCall name="custom_tool" args='{"path":"hi.txt"}' />)
    expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe("false")
  })

  it("shows result section when done+result, after expand", async () => {
    const user = userEvent.setup()
    render(
      <ToolCall
        name="custom_tool"
        args='{"path":"hi.txt"}'
        done={true}
        result="file content here"
      />
    )
    await user.click(screen.getByRole("button"))
    expect(screen.getByText("result")).toBeTruthy()
    expect(screen.getByText("file content here")).toBeTruthy()
  })

  it("shows both args and result sections together", async () => {
    const user = userEvent.setup()
    render(
      <ToolCall
        name="custom_tool"
        args='{"path":"hi.txt"}'
        done={true}
        result="some result"
      />
    )
    await user.click(screen.getByRole("button"))
    expect(screen.getByText("arguments")).toBeTruthy()
    expect(screen.getByText("result")).toBeTruthy()
  })

  it("collapses from a standard result section header", async () => {
    const user = userEvent.setup()
    render(<ToolCall name="date" args="{}" done result="2026-07-19" />)

    await user.click(screen.getByRole("button", { name: "Expand date details" }))
    await user.click(screen.getByText("result"))

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Expand date details" })).toBeTruthy()
    })
  })
})

// ---------------------------------------------------------------------------
// Args formatting
// ---------------------------------------------------------------------------

describe("ToolCall — args formatting", () => {
  it("pretty-prints valid JSON args for unknown tools", async () => {
    const user = userEvent.setup()
    render(<ToolCall name="custom_tool" args='{"name":"test","value":42}' done={false} />)
    await user.click(screen.getByRole("button"))
    expect(screen.getByText(/name/)).toBeTruthy()
  })

  it("shows raw string when args are not JSON", async () => {
    const user = userEvent.setup()
    render(<ToolCall name="custom_tool" args="not valid json" done={false} />)
    await user.click(screen.getByRole("button"))
    expect(screen.getByText("not valid json")).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// team_message display (header + body-only args)
// ---------------------------------------------------------------------------

describe("ToolCall — team_message display", () => {
  it("shows message body in args section, not raw JSON", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ content: "hello world", to: ["worker_agent"] })
    render(<ToolCall name="team_message" args={args} done={false} />)
    await user.click(screen.getByRole("button"))
    expect(screen.getByText("hello world")).toBeTruthy()
    expect(screen.queryByText(/"content"/)).toBeNull()
    expect(screen.queryByText(/"to"/)).toBeNull()
  })

  it("shows Messaging header with recipient name", () => {
    const args = JSON.stringify({ content: "task details", to: ["researcher"] })
    render(<ToolCall name="team_message" args={args} done={false} />)
    expectPlainArg(getHeader("Messaging researcher"), "researcher")
  })

  it("shows Messaging team when to is empty", () => {
    const args = JSON.stringify({ content: "broadcast", to: [] })
    render(<ToolCall name="team_message" args={args} done={false} />)
    expectPlainArg(getHeader("Messaging team"), "team")
  })
})

// ---------------------------------------------------------------------------
// team_manage display
// ---------------------------------------------------------------------------

describe("ToolCall — team_manage display", () => {
  it("shows roster action in the header and members as args", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ action: "spawn", members: ["executor", "explorer"] })
    render(<ToolCall name="team_manage" args={args} done={false} />)

    expectPlainArg(getHeader("Spawning executor, explorer"), "executor, explorer")
    await user.click(screen.getByRole("button"))
    expect(screen.getAllByText(/executor/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/explorer/).length).toBeGreaterThan(0)
    expect(screen.queryByText(/"members"/)).toBeNull()
  })

  it("renders grouped roster results", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ action: "dismiss", members: ["executor#1"] })
    render(
      <ToolCall
        name="team_manage"
        args={args}
        done={true}
        result="Dismissed: executor#1. Errors: explorer#2: not live."
      />,
    )

    await user.click(screen.getByRole("button"))
    expect(screen.getByText("Dismissed")).toBeTruthy()
    expect(screen.getAllByText("executor#1").length).toBeGreaterThan(0)
    expect(screen.getByText("Errors")).toBeTruthy()
  })

  it("renders list layout for Spawnable blueprints and cleans up Available lists", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ action: "list" })
    render(
      <ToolCall
        name="team_manage"
        args={args}
        done={true}
        result="Live: lead, coder#1. Spawnable blueprints: coder — Code specialist, writer. Available: ['coder', 'writer']."
      />,
    )

    await user.click(screen.getByRole("button"))
    expect(screen.getByText("Live")).toBeTruthy()
    expect(screen.getByText("lead, coder#1")).toBeTruthy()

    expect(screen.getByText("Spawnable blueprints")).toBeTruthy()
    expect(screen.getByText("coder — Code specialist")).toBeTruthy()
    expect(screen.getByText("writer")).toBeTruthy()

    expect(screen.getByText("Available")).toBeTruthy()
    expect(screen.getByText("coder, writer")).toBeTruthy()
  })

  it("hides dismiss arguments when there is no result", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ action: "dismiss", members: ["executor#1"] })
    render(<ToolCall name="team_manage" args={args} done={false} />)

    expectPlainArg(getHeader("Dismissing executor#1"), "executor#1")
    await user.click(screen.getByRole("button"))
    expect(screen.queryByText("arguments")).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Custom tool display — skill
// ---------------------------------------------------------------------------

describe("ToolCall — skill display", () => {
  it("shows conversational header with skill name", () => {
    const args = JSON.stringify({ skill_name: "web-design-guidelines" })
    render(<ToolCall name="skill" args={args} done={false} />)
    expectPlainArg(getHeader("web-design-guidelines"), "web-design-guidelines")
    expect(screen.queryByText("skill")).toBeNull()
  })

  it("hides args section (formattedArgs is null)", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ skill_name: "backend-testing" })
    render(<ToolCall name="skill" args={args} done={false} />)
    await user.click(screen.getByRole("button"))
    // Args section should not be rendered
    expect(screen.queryByText("arguments")).toBeNull()
  })

  it("shows fallback header when no skill_name", () => {
    const args = JSON.stringify({})
    render(<ToolCall name="skill" args={args} done={false} />)
    expect(screen.getByText("Skill")).toBeTruthy()
  })

  it("shows fallback header when skill_name is empty string", () => {
    const args = JSON.stringify({ skill_name: "" })
    render(<ToolCall name="skill" args={args} done={false} />)
    expect(screen.getByText("Skill")).toBeTruthy()
  })

  it("shows fallback header when skill_name is whitespace", () => {
    const args = JSON.stringify({ skill_name: "   " })
    render(<ToolCall name="skill" args={args} done={false} />)
    expect(screen.getByText("Skill")).toBeTruthy()
  })

  it("is not expandable (no details to show)", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ skill_name: "react-component" })
    render(<ToolCall name="skill" args={args} done={false} />)
    const btn = screen.getByRole("button")
    // Verify clicking does not expand
    await user.click(btn)
    expect(screen.queryByText("arguments")).toBeNull()
  })

  it("shows the loaded instruction body when result is present", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ skill_name: "guidelines" })
    render(<ToolCall name="skill" args={args} done={true} result="Very long skill instructions" />)

    // Button should be expandable now that result content is available
    await user.click(screen.getByRole("button"))
    expect(screen.getByText("Very long skill instructions")).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// Custom tool display — todo_manage / schedule_task
// ---------------------------------------------------------------------------

describe("ToolCall — todo_manage display", () => {
  it("shows create summary and simplified action args", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({
      actions: [{
        action: "create",
        content: "Audit backend tools",
        status: "pending",
        priority: "high",
        assigned_to: "explorer#1",
        dependencies: ["task_1"],
      }],
    })
    render(<ToolCall name="todo_manage" args={args} done={false} />)

    expectPlainArg(getHeader("Creating todo: Audit backend tools"), "Audit backend tools")
    await user.click(screen.getByRole("button"))
    expect(screen.getByText(/create \[pending\] \(high\).*Audit backend tools/)).toBeTruthy()
    expect(screen.queryByText(/"actions"/)).toBeNull()
  })

  it("summarizes batched todo actions without raw JSON", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({
      actions: [
        { action: "update", task_id: "task_1", status: "completed" },
        { action: "claim", task_id: "task_2" },
      ],
    })
    render(<ToolCall name="todo_manage" args={args} done={false} />)

    expectPlainArg(getHeader("Updating 2 todos…"), "2 todos")
    await user.click(screen.getByRole("button"))
    expect(screen.getByText(/update task_1: status=completed/)).toBeTruthy()
    expect(screen.getByText(/claim task_2/)).toBeTruthy()
    expect(screen.queryByText(/"task_id"/)).toBeNull()
  })

  it("hides redundant read args", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ actions: [{ action: "read" }] })
    render(<ToolCall name="todo_manage" args={args} done={false} />)

    expect(getHeader("Reading todos…")).toBeTruthy()
    await user.click(screen.getByRole("button"))
    expect(screen.queryByText("arguments")).toBeNull()
  })

  it("shows concise clear summary", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ actions: [{ action: "clear", statuses: ["completed"] }] })
    render(<ToolCall name="todo_manage" args={args} done={false} />)

    expect(getHeader("Clearing finished todos…")).toBeTruthy()
    await user.click(screen.getByRole("button"))
  })
})

describe("ToolCall — schedule_task display", () => {
  it("shows create summary and schedule prompt args", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({
      action: "create",
      name: "daily-standup",
      schedule_type: "cron",
      cron_expression: "0 8 * * 1-5",
      timezone: "Asia/Ho_Chi_Minh",
      prompt: "Draft the standup summary.",
    })
    render(<ToolCall name="schedule_task" args={args} done={false} />)

    expectPlainArg(getHeader("Scheduling daily-standup"), "daily-standup")
    await user.click(screen.getByRole("button"))
    expect(screen.getByText(/schedule: cron 0 8 \* \* 1-5 \(Asia\/Ho_Chi_Minh\)/)).toBeTruthy()
    expect(screen.getByText(/prompt: Draft the standup summary\./)).toBeTruthy()
    expect(screen.queryByText(/"cron_expression"/)).toBeNull()
  })

  it("hides redundant list args", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ action: "list" })
    render(<ToolCall name="schedule_task" args={args} done={false} />)

    expect(getHeader("Listing scheduled tasks…")).toBeTruthy()
    await user.click(screen.getByRole("button"))
    expect(screen.queryByText("arguments")).toBeNull()
  })

  it("renders scheduled task lists as a table without internal IDs", async () => {
    const user = userEvent.setup()
    const result = "Scheduled tasks (1):\n  slug=daily-standup | name=Daily standup | schedule=cron '0 8 * * 1-5' (UTC) | status=enabled/pending | runs=2/5 | next=2026-07-20 08:00:00+00:00"

    render(<ToolCall name="schedule_task" args={JSON.stringify({ action: "list" })} done result={result} />)

    await user.click(screen.getByRole("button", { name: "Expand schedule_task details" }))
    expect(screen.getByRole("table")).toBeTruthy()
    expect(screen.queryByText("result")).toBeNull()
    expect(screen.getByText("Daily standup")).toBeTruthy()
    expect(screen.getByText("cron 0 8 * * 1-5 (UTC)")).toBeTruthy()
    expect(screen.queryByText(/id=/)).toBeNull()
  })
})

describe("ToolCall — concise tool labels", () => {
  it("summarizes patch arguments with comma-separated file names", () => {
    const args = JSON.stringify({
      patch_text: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** Add File: src/b.ts\n+hello\n*** End Patch",
    })

    render(<ToolCall name="patch" args={args} done={false} />)

    expect(getHeader("Patch: a.ts, b.ts")).toBeTruthy()
    expect(screen.queryByText("src/a.ts")).toBeNull()
    expect(screen.queryByText("src/b.ts")).toBeNull()
  })

  it("deduplicates repeated basenames in the patch header", () => {
    const args = JSON.stringify({
      patch_text: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** Update File: lib/a.ts\n@@\n-x\n+y\n*** End Patch",
    })

    render(<ToolCall name="patch" args={args} done={false} />)

    expect(getHeader("Patch: a.ts")).toBeTruthy()
  })

  it("truncates a long patch file list in the header", () => {
    const sections = Array.from({ length: 12 }, (_, i) => (
      `*** Update File: src/some-longer-file-name-${i}.ts\n@@\n-old\n+new`
    )).join("\n")
    const args = JSON.stringify({
      patch_text: `*** Begin Patch\n${sections}\n*** End Patch`,
    })

    render(<ToolCall name="patch" args={args} done={false} />)

    const title = Array.from(document.querySelectorAll("[title]"))
      .map((node) => node.getAttribute("title"))
      .find((t) => t?.startsWith("Patch: "))
    expect(title).toBeTruthy()
    expect(title!.endsWith("…")).toBe(true)
    expect(title!.length).toBeLessThan(80)
  })

  it("describes a agent roster list without implying a mutation", () => {
    render(<ToolCall name="team_manage" args={JSON.stringify({ action: "list", members: [] })} done={false} />)

    expect(getHeader("Listing agent roster…")).toBeTruthy()
    expect(screen.queryByText("Managing agent roster…")).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Custom tool display — bg
// ---------------------------------------------------------------------------

describe("ToolCall — bg display", () => {
  // Plain-string headers (no decorated argument):
  //   Listing background processes…
  //   Checking process status…
  //   Reading process output…
  //   Stopping process…
  //   Managing background process…
  // PID-bearing headers include the pid as plain text.

  it("shows 'Listing background processes…' for action=list", () => {
    const args = JSON.stringify({ action: "list" })
    render(<ToolCall name="bg" args={args} done={false} />)
    const header = getHeader("Listing background processes…")
    expect(header.textContent).toBe("Listing background processes…")
    expect(header.querySelector("em")).toBeNull()
    expect(screen.queryByText("bg")).toBeNull()
  })

  it("shows 'Checking process {pid}…' for action=status with pid", () => {
    const args = JSON.stringify({ action: "status", pid: 1234 })
    render(<ToolCall name="bg" args={args} done={false} />)
    expectPlainArg(getHeader("Checking process 1234…"), "1234")
  })

  it("shows 'Checking process status…' for action=status without pid", () => {
    const args = JSON.stringify({ action: "status" })
    render(<ToolCall name="bg" args={args} done={false} />)
    const header = getHeader("Checking process status…")
    expect(header.textContent).toBe("Checking process status…")
    expect(header.querySelector("em")).toBeNull()
  })

  it("shows 'Reading output of process {pid}…' for action=output with pid", () => {
    const args = JSON.stringify({ action: "output", pid: 5678 })
    render(<ToolCall name="bg" args={args} done={false} />)
    expectPlainArg(getHeader("Reading output of process 5678…"), "5678")
  })

  it("shows 'Reading process output…' for action=output without pid", () => {
    const args = JSON.stringify({ action: "output" })
    render(<ToolCall name="bg" args={args} done={false} />)
    const header = getHeader("Reading process output…")
    expect(header.textContent).toBe("Reading process output…")
    expect(header.querySelector("em")).toBeNull()
  })

  // `wait` was removed from the bg tool (it duplicated foreground shell while
  // capping at 300s). Stored transcripts still contain it, so the generic
  // fallback has to stay readable rather than render blank.
  it("falls back to a generic header for the retired wait action", () => {
    const args = JSON.stringify({ action: "wait", pid: 2468 })
    render(<ToolCall name="bg" args={args} done={false} />)
    expectPlainArg(getHeader("bg: wait"), "wait")
  })

  it("shows 'Stopping process {pid}…' for action=stop with pid", () => {
    const args = JSON.stringify({ action: "stop", pid: 9999 })
    render(<ToolCall name="bg" args={args} done={false} />)
    expectPlainArg(getHeader("Stopping process 9999…"), "9999")
  })

  it("shows 'Stopping process…' for action=stop without pid", () => {
    const args = JSON.stringify({ action: "stop" })
    render(<ToolCall name="bg" args={args} done={false} />)
    const header = getHeader("Stopping process…")
    expect(header.textContent).toBe("Stopping process…")
    expect(header.querySelector("em")).toBeNull()
  })

  it("shows 'Managing background process…' when no action", () => {
    const args = JSON.stringify({ pid: 1234 })
    render(<ToolCall name="bg" args={args} done={false} />)
    const header = getHeader("Managing background process…")
    expect(header.textContent).toBe("Managing background process…")
    expect(header.querySelector("em")).toBeNull()
  })

  it("shows 'Managing background process…' when action is empty", () => {
    const args = JSON.stringify({ action: "" })
    render(<ToolCall name="bg" args={args} done={false} />)
    const header = getHeader("Managing background process…")
    expect(header.textContent).toBe("Managing background process…")
    expect(header.querySelector("em")).toBeNull()
  })

  it("shows 'Managing background process…' when action is whitespace", () => {
    const args = JSON.stringify({ action: "   " })
    render(<ToolCall name="bg" args={args} done={false} />)
    const header = getHeader("Managing background process…")
    expect(header.textContent).toBe("Managing background process…")
    expect(header.querySelector("em")).toBeNull()
  })

  it("hides args section (formattedArgs is null)", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ action: "list" })
    render(<ToolCall name="bg" args={args} done={false} />)
    await user.click(screen.getByRole("button"))
    // Args section should not be rendered
    expect(screen.queryByText("arguments")).toBeNull()
  })

  it("handles action case-insensitively", () => {
    const args = JSON.stringify({ action: "LIST" })
    render(<ToolCall name="bg" args={args} done={false} />)
    // Header is a plain string (no argument), located via title attribute.
    expect(getHeader("Listing background processes…")).toBeTruthy()
  })

  it("handles mixed case action", () => {
    const args = JSON.stringify({ action: "Status", pid: 42 })
    render(<ToolCall name="bg" args={args} done={false} />)
    // Pid is plain in status headers.
    expectPlainArg(getHeader("Checking process 42…"), "42")
  })

  it("is not expandable (no details to show)", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ action: "list" })
    render(<ToolCall name="bg" args={args} done={false} />)
    const btn = screen.getByRole("button")
    // Verify clicking does not expand
    await user.click(btn)
    expect(screen.queryByText("arguments")).toBeNull()
  })

  it("shows bg output without a generic result section", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ action: "output", pid: 123 })
    render(
      <ToolCall
        name="bg"
        args={args}
        done={true}
        result="process output here"
      />
    )
    await user.click(screen.getByRole("button"))
    expect(screen.queryByText("result")).toBeNull()
    expect(screen.getByText("process output here")).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// Copy buttons
// ---------------------------------------------------------------------------

describe("ToolCall — copy buttons", () => {
  it("shows copy button for args after expand", async () => {
    const user = userEvent.setup()
    render(<ToolCall name="custom_tool" args='{"path":"hi.txt"}' done={false} />)
    await user.click(screen.getByRole("button"))
    expect(screen.getByLabelText("Copy arguments")).toBeTruthy()
  })

  it("shows copy button for result after expand", async () => {
    const user = userEvent.setup()
    render(
      <ToolCall name="custom_tool" args='{"path":"hi.txt"}' done={true} result="some result" />
    )
    await user.click(screen.getByRole("button"))
    expect(screen.getByLabelText("Copy result")).toBeTruthy()
  })

  it("args copy button icon turns to check on click", async () => {
    const user = userEvent.setup()
    render(<ToolCall name="custom_tool" args='{"path":"hi.txt"}' done={true} />)
    await user.click(screen.getByRole("button"))
    const copyBtn = screen.getByLabelText("Copy arguments")
    await user.click(copyBtn)
    // After clicking, button still exists (didn't error out)
    await waitFor(() => expect(screen.getByLabelText("Copy arguments")).toBeTruthy())
  })

  it("result copy button icon turns to check on click", async () => {
    const user = userEvent.setup()
    render(
      <ToolCall name="custom_tool" args='{"path":"hi.txt"}' done={true} result="some result" />
    )
    await user.click(screen.getByRole("button"))
    const copyBtn = screen.getByLabelText("Copy result")
    await user.click(copyBtn)
    await waitFor(() => expect(screen.getByLabelText("Copy result")).toBeTruthy())
  })

  it("args and result copy buttons are independent", async () => {
    const user = userEvent.setup()
    render(
      <ToolCall name="custom_tool" args='{"path":"hi.txt"}' done={true} result="some result" />
    )
    await user.click(screen.getByRole("button"))
    const argsCopy = screen.getByLabelText("Copy arguments")
    await user.click(argsCopy)
    // Both buttons remain accessible after clicking one
    await waitFor(() => {
      expect(screen.getByLabelText("Copy arguments")).toBeTruthy()
      expect(screen.getByLabelText("Copy result")).toBeTruthy()
    })
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
      const copyBtn = screen.getByLabelText("Copy arguments")
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
    // No expand button — nothing to show
    const btn = screen.getByRole("button")
    expect(btn).toBeTruthy()
  })
})

describe("ToolCall — copy formattedArgs instead of raw JSON", () => {
  it("does not show a copy button for hidden web_search args", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ query: "python async", other: "ignored" })
    render(<ToolCall name="web_search" args={args} done={false} />)
    await user.click(screen.getByRole("button"))
    expect(screen.queryByLabelText("Copy arguments")).toBeNull()
  })

  it("does not show a copy button for hidden web_fetch args", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ url: "https://example.com", timeout: 30 })
    render(<ToolCall name="web_fetch" args={args} done={false} />)
    await user.click(screen.getByRole("button"))
    expect(screen.queryByLabelText("Copy arguments")).toBeNull()
  })

  it("copies formattedArgs for remember (formatted items)", async () => {
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
      const args = JSON.stringify({
        items: [
          { category: "identity", key: "role", value: "Engineer" },
          { category: "preference", key: "style", value: "concise" },
        ],
      })
      render(<ToolCall name="remember" args={args} done={false} />)
      await user.click(screen.getByRole("button"))
      const copyBtn = screen.getByLabelText("Copy arguments")
      await user.click(copyBtn)
      expect(copiedText).toContain("[identity] role: Engineer")
      expect(copiedText).toContain("[preference] style: concise")
      expect(copiedText).not.toContain("items")
      expect(copiedText).not.toContain("category")
    } finally {
      Object.defineProperty(navigator, "clipboard", {
        value: navigator.clipboard,
        writable: true,
      })
    }
  })

  it("copies formattedArgs for recall (filter string)", async () => {
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
      const args = JSON.stringify({ category: "preference", key: "style" })
      render(<ToolCall name="recall" args={args} done={false} />)
      await user.click(screen.getByRole("button"))
      const copyBtn = screen.getByLabelText("Copy arguments")
      await user.click(copyBtn)
      expect(copiedText).toBe("preference: style")
      expect(copiedText).not.toContain("category")
      expect(copiedText).not.toContain("key")
    } finally {
      Object.defineProperty(navigator, "clipboard", {
        value: navigator.clipboard,
        writable: true,
      })
    }
  })

  it("copies formattedArgs for forget (formatted items)", async () => {
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
      const args = JSON.stringify({
        items: [
          { category: "preference", key: "style" },
          { category: "identity" },
        ],
      })
      render(<ToolCall name="forget" args={args} done={false} />)
      await user.click(screen.getByRole("button"))
      const copyBtn = screen.getByLabelText("Copy arguments")
      await user.click(copyBtn)
      expect(copiedText).toContain("preference: style")
      expect(copiedText).toContain("identity")
      expect(copiedText).not.toContain("items")
    } finally {
      Object.defineProperty(navigator, "clipboard", {
        value: navigator.clipboard,
        writable: true,
      })
    }
  })

  it("copies full JSON for tools without custom formatting", async () => {
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
      const args = JSON.stringify({ path: "src/main.py", offset: 10, limit: 20 })
      render(<ToolCall name="custom_tool" args={args} done={false} />)
      await user.click(screen.getByRole("button"))
      const copyBtn = screen.getByLabelText("Copy arguments")
      await user.click(copyBtn)
      // For custom_tool, formattedArgs is the full JSON, so it should copy the JSON
      expect(copiedText).toContain("path")
      expect(copiedText).toContain("src/main.py")
    } finally {
      Object.defineProperty(navigator, "clipboard", {
        value: navigator.clipboard,
        writable: true,
      })
    }
  })
})

describe("ToolCall — empty args {} show no args section", () => {
  it("hides args section when args is empty object", async () => {
    const user = userEvent.setup()
    render(<ToolCall name="custom_tool" args="{}" done={false} />)
    const btn = screen.getByRole("button")
    await user.click(btn)
    // No args section should appear
    expect(screen.queryByText("arguments")).toBeNull()
  })

  it("shows tool name when args is empty object", () => {
    render(<ToolCall name="custom_tool" args="{}" done={false} />)
    expect(screen.getByText("Custom Tool")).toBeTruthy()
  })

  it("shows result section even when args is empty", async () => {
    const user = userEvent.setup()
    render(
      <ToolCall name="custom_tool" args="{}" done={true} result="some output" />
    )
    const btn = screen.getByRole("button")
    // Should be expandable because result exists
    await user.click(btn)
    expect(screen.getByText("result")).toBeTruthy()
  })

  it("shows failed result content when a completed tool failed", async () => {
    const user = userEvent.setup()
    render(
      <ToolCall
        name="shell"
        args={JSON.stringify({ command: "pytest" })}
        done={true}
        result="[Failed — exit code 1]\n\nAssertionError"
      />,
    )

    await user.click(screen.getByRole("button"))
    expect(screen.getByText(/Failed/)).toBeTruthy()
    expect(screen.getByText(/AssertionError/)).toBeTruthy()
  })

  it("date tool with no args shows no args section", async () => {
    const user = userEvent.setup()
    render(<ToolCall name="date" done={false} />)
    const btn = screen.getByRole("button")
    await user.click(btn)
    expect(screen.queryByText("arguments")).toBeNull()
  })

  it("date tool with empty args shows no args section", async () => {
    const user = userEvent.setup()
    render(<ToolCall name="date" args="{}" done={false} />)
    const btn = screen.getByRole("button")
    await user.click(btn)
    expect(screen.queryByText("arguments")).toBeNull()
  })
})

describe("ToolCall — getToolDisplay called before copy handlers", () => {
  it("formattedArgs is available in copy handler for shell", async () => {
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
      const args = JSON.stringify({ command: "echo hello", description: "Print hello" })
      render(<ToolCall name="shell" args={args} done={false} />)
      await user.click(screen.getByRole("button"))
      const copyBtn = screen.getByLabelText("Copy arguments")
      await user.click(copyBtn)
      // If getToolDisplay was called before copy handler, formattedArgs is in scope
      expect(copiedText).toBe("echo hello")
    } finally {
      Object.defineProperty(navigator, "clipboard", {
        value: navigator.clipboard,
        writable: true,
      })
    }
  })

  it("does not expose hidden web_search args to the copy handler", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ query: "typescript generics" })
    render(<ToolCall name="web_search" args={args} done={false} />)
    await user.click(screen.getByRole("button"))
    expect(screen.queryByLabelText("Copy arguments")).toBeNull()
  })

  it("does not expose hidden web_fetch args to the copy handler", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ url: "https://docs.python.org" })
    render(<ToolCall name="web_fetch" args={args} done={false} />)
    await user.click(screen.getByRole("button"))
    expect(screen.queryByLabelText("Copy arguments")).toBeNull()
  })

  it("formattedArgs is available in copy handler for remember", async () => {
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
      const args = JSON.stringify({
        items: [{ category: "test", key: "key1", value: "val1" }],
      })
      render(<ToolCall name="remember" args={args} done={false} />)
      await user.click(screen.getByRole("button"))
      const copyBtn = screen.getByLabelText("Copy arguments")
      await user.click(copyBtn)
      expect(copiedText).toContain("[test] key1: val1")
    } finally {
      Object.defineProperty(navigator, "clipboard", {
        value: navigator.clipboard,
        writable: true,
      })
    }
  })

  it("displays nested JSON strings inside arguments as pretty-printed JSON and applies max-height classes", async () => {
    const user = userEvent.setup()
    const nestedInput = JSON.stringify([
      { action: "create", content: "Implement tests" }
    ])
    const args = JSON.stringify({
      filePath: "designs/forms.pen",
      input: nestedInput,
    })

    render(<ToolCall name="custom_tool" args={args} done={false} />)

    // Expand the details panel
    await user.click(screen.getByRole("button"))

    // Find the arguments pre element
    const preEl = screen.getByText((content, element) => {
      return element?.tagName.toLowerCase() === "pre" && content.includes("designs/forms.pen")
    })

    expect(preEl).toBeDefined()
    // Verify that the nested JSON string was parsed and rendered as a real JSON structure
    expect(preEl.textContent).toContain('"action": "create"')
    expect(preEl.textContent).toContain('"content": "Implement tests"')
    expect(preEl.textContent).not.toContain('\\"') // Ensure it's not escaped
  })
})

describe("ToolCall with incomplete JSON args (streaming)", () => {
  it("extracts and displays file name for read tool immediately", () => {
    render(<ToolCall name="read" args='{"path": "src/components/ToolResult.tsx' done={false} />)
    expect(screen.getByText("ToolResult.tsx")).toBeTruthy()
  })

  it("extracts and displays query for web_search immediately", () => {
    render(<ToolCall name="web_search" args='{"query": "how to build a react' done={false} />)
    expect(screen.getByText(/"how to build a react"/)).toBeTruthy()
  })

  it("renders diff view and displays path for patch tool immediately when streaming", async () => {
    const user = userEvent.setup()
    const partialArgs = '{"patch_text": "*** Begin Patch\\n*** Update File: src/components/ToolResult.tsx\\n@@ -1,1 +1,2 @@\\n hello\\n+world'
    render(<ToolCall name="patch" args={partialArgs} done={false} />)
    expect(getHeader("Patch: ToolResult.tsx")).toBeTruthy()
    await user.click(screen.getByRole("button"))
    expect(screen.getAllByText("src/components/ToolResult.tsx").length).toBeGreaterThan(0)
  })
})
