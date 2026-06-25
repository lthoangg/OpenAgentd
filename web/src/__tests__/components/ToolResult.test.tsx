import { describe, it, expect, afterEach } from "bun:test"
import { render, screen, cleanup } from "@testing-library/react"
import { ToolResult } from "@/components/ToolResult"

afterEach(cleanup)

// ---------------------------------------------------------------------------
// web_search renderer
// ---------------------------------------------------------------------------

describe("ToolResult — web_search", () => {
  const searchResult = JSON.stringify([
    { title: "Python Docs", href: "https://docs.python.org/3/", body: "Official Python documentation." },
    { title: "Real Python", href: "https://realpython.com/", body: "Tutorials and articles for Python developers." },
  ])

  it("renders each result title as a link", () => {
    render(<ToolResult toolName="web_search" result={searchResult} />)
    const link = screen.getByText("Python Docs")
    expect(link.tagName.toLowerCase()).toBe("a")
    expect((link as HTMLAnchorElement).href).toContain("docs.python.org")
  })

  it("opens links in a new tab", () => {
    render(<ToolResult toolName="web_search" result={searchResult} />)
    const link = screen.getByText("Python Docs") as HTMLAnchorElement
    expect(link.target).toBe("_blank")
    expect(link.rel).toContain("noopener")
  })

  it("renders stripped hostname pill for each result", () => {
    render(<ToolResult toolName="web_search" result={searchResult} />)
    // www. stripped → docs.python.org
    expect(screen.getByText("docs.python.org")).toBeTruthy()
    expect(screen.getByText("realpython.com")).toBeTruthy()
  })

  it("renders snippet body text (truncated to 200 chars)", () => {
    render(<ToolResult toolName="web_search" result={searchResult} />)
    expect(screen.getByText(/Official Python documentation/)).toBeTruthy()
  })

  it("truncates long body to 200 chars with ellipsis", () => {
    const longBody = "x".repeat(250)
    const result = JSON.stringify([{ title: "Long", href: "https://example.com", body: longBody }])
    render(<ToolResult toolName="web_search" result={result} />)
    const el = screen.getByText(/x+…/)
    expect(el.textContent?.length).toBeLessThanOrEqual(202) // 200 + "…"
  })

  it("uses href field for the link", () => {
    render(<ToolResult toolName="web_search" result={searchResult} />)
    const link = screen.getByText("Real Python") as HTMLAnchorElement
    expect(link.href).toContain("realpython.com")
  })

  it("falls back to url field when href is absent", () => {
    const result = JSON.stringify([{ title: "Alt", url: "https://alt.example.com", body: "alt body" }])
    render(<ToolResult toolName="web_search" result={result} />)
    const link = screen.getByText("Alt") as HTMLAnchorElement
    expect(link.href).toContain("alt.example.com")
  })

  it("renders multiple results", () => {
    render(<ToolResult toolName="web_search" result={searchResult} />)
    expect(screen.getByText("Python Docs")).toBeTruthy()
    expect(screen.getByText("Real Python")).toBeTruthy()
  })

  it("falls back to GenericResult for non-JSON input", () => {
    render(<ToolResult toolName="web_search" result="plain text result" />)
    expect(screen.getByText("plain text result")).toBeTruthy()
  })

  it("falls back to GenericResult for empty array", () => {
    render(<ToolResult toolName="web_search" result="[]" />)
    // GenericResult renders the raw "[]" string
    expect(screen.getByText("[]")).toBeTruthy()
  })

  it("handles single-object result (non-array)", () => {
    const single = JSON.stringify({ title: "Single", href: "https://single.com", body: "one result" })
    render(<ToolResult toolName="web_search" result={single} />)
    expect(screen.getByText("Single")).toBeTruthy()
    expect(screen.getByText(/one result/)).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// shell renderer
// ---------------------------------------------------------------------------

describe("ToolResult — shell", () => {
  it("shows [Succeeded] status in green", () => {
    render(<ToolResult toolName="shell" result={"[Succeeded]\n\nhello world"} />)
    const status = screen.getByText(/\[Succeeded\]/)
    expect(status.className).toContain("color-success")
  })

  it("shows [Failed] status in the error color", () => {
    render(<ToolResult toolName="shell" result={"[Failed — exit code 1]\n\nerror output"} />)
    const status = screen.getByText(/\[Failed/)
    expect(status.className).toContain("color-error")
  })

  it("renders stdout body text", () => {
    render(<ToolResult toolName="shell" result={"[Succeeded]\n\nhello world"} />)
    expect(screen.getByText(/hello world/)).toBeTruthy()
  })

  it("renders nothing extra when no body after status line", () => {
    render(<ToolResult toolName="shell" result="[Succeeded]" />)
    expect(screen.getByText(/\[Succeeded\]/)).toBeTruthy()
    // No pre block for empty body
    const pres = document.querySelectorAll("pre")
    expect(pres.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// filesystem list renderers (ls, glob, grep)
// ---------------------------------------------------------------------------

const LIST_TOOLS = ["ls", "glob", "grep"] as const

describe("ToolResult — file list tools", () => {
  LIST_TOOLS.forEach((toolName) => {
    it(`${toolName}: renders entry count`, () => {
      const result = "src/foo.ts\nsrc/bar.ts\nsrc/baz.ts"
      render(<ToolResult toolName={toolName} result={result} />)
      // newline-split produces 3 entries
      expect(screen.getByText(/3 entries/)).toBeTruthy()
      cleanup()
    })

    it(`${toolName}: renders each path`, () => {
      const result = "src/foo.ts\nsrc/bar.ts"
      render(<ToolResult toolName={toolName} result={result} />)
      expect(screen.getByText("src/foo.ts")).toBeTruthy()
      expect(screen.getByText("src/bar.ts")).toBeTruthy()
      cleanup()
    })

    it(`${toolName}: uses singular 'entry' for a single result`, () => {
      render(<ToolResult toolName={toolName} result="src/only.ts" />)
      expect(screen.getByText(/1 entry/)).toBeTruthy()
      cleanup()
    })
  })

  it("parses JSON array result", () => {
    const result = JSON.stringify(["a/b.ts", "c/d.ts"])
    render(<ToolResult toolName="ls" result={result} />)
    expect(screen.getByText("a/b.ts")).toBeTruthy()
    expect(screen.getByText("c/d.ts")).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// read renderer
// ---------------------------------------------------------------------------

describe("ToolResult — read", () => {
  it("renders file content as the primary output", () => {
    render(<ToolResult toolName="read" result="const x = 1" />)
    expect(screen.getByText(/const x = 1/)).toBeTruthy()
  })

  it("renders multi-line file content in a compact pre block", () => {
    render(<ToolResult toolName="read" result={"const x = 1\nconst y = 2"} />)
    expect(screen.getByText("read")).toBeTruthy()
    expect(screen.getByText("file contents")).toBeTruthy()
    expect(screen.getByText(/const x = 1/)).toBeTruthy()
    expect(screen.getByText(/const y = 2/)).toBeTruthy()
  })

  it("promotes the [start-end/total] range header to a metadata label", () => {
    // The backend read tool prepends "[12-20/100]\n" when offset/limit are
    // active. We surface that as a quiet "lines 12–20 of 100" label so the
    // pre block shows only the actual file content.
    render(<ToolResult toolName="read" result={"[12-20/100]\nconst y = 2"} />)
    expect(screen.getByText(/lines 12.20 of 100/)).toBeTruthy()
    // Raw bracketed header is no longer shown verbatim
    expect(screen.queryByText(/\[12-20\/100\]/)).toBeNull()
  })

  it("uses compact file chrome without diff line markers", () => {
    const { container } = render(<ToolResult toolName="read" result={"line one\nline two"} />)

    expect(container.querySelector("div[class*='bg-(--bg-key)']")).toBeTruthy()
    expect(container.querySelector("div[class*='border-(--color-border)']")).toBeTruthy()
    expect(screen.queryByText("+")).toBeNull()
    expect(screen.queryByText("-")).toBeNull()
  })

  it("keeps scrolling on the read content instead of a sticky nested header", () => {
    const { container } = render(<ToolResult toolName="read" result="line one" />)

    const header = screen.getByText("read").parentElement
    const body = container.querySelector("pre")
    expect(header?.className).not.toContain("sticky")
    expect(body?.className).toContain("max-h-[calc(10*1.55em)]")
    expect(body?.className).toContain("overflow-auto")
  })

  it("renders full content as-is when no range header is present", () => {
    render(<ToolResult toolName="read" result={"hello\nworld"} />)
    expect(screen.getByText(/hello/)).toBeTruthy()
    expect(screen.getByText(/world/)).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// GenericResult fallback
// ---------------------------------------------------------------------------

describe("ToolResult — GenericResult fallback", () => {
  it("pretty-prints valid JSON for web_fetch", () => {
    const json = JSON.stringify({ status: "ok", data: [1, 2, 3] })
    render(<ToolResult toolName="web_fetch" result={json} />)
    // Pretty-printed → "status" key visible
    expect(screen.getByText(/"status"/)).toBeTruthy()
  })

  it("renders plain text as-is for unknown tool", () => {
    render(<ToolResult toolName="date" result="2026-04-09" />)
    expect(screen.getByText("2026-04-09")).toBeTruthy()
  })

  it("renders write result as plain text", () => {
    render(<ToolResult toolName="write" result="File written successfully." />)
    expect(screen.getByText("File written successfully.")).toBeTruthy()
  })

  it("renders edit result", () => {
    render(<ToolResult toolName="edit" result="3 changes applied." />)
    expect(screen.getByText("3 changes applied.")).toBeTruthy()
  })

  it("truncates very large generic results for display", () => {
    const result = `start-${"x".repeat(20_000)}-end`
    render(<ToolResult toolName="web_fetch" result={result} />)

    expect(screen.getByText(/display truncated/)).toBeTruthy()
    expect(screen.getByText(/start-/)).toBeTruthy()
    expect(screen.getByText(/-end/)).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// team_message renderer
// ---------------------------------------------------------------------------

describe("ToolResult — team_message", () => {
  it("renders success result text content", () => {
    render(<ToolResult toolName="team_message" result="Message sent to researcher" />)
    expect(screen.getByText("Message sent to researcher")).toBeTruthy()
  })

  it("renders success result in the standard body text color", () => {
    render(<ToolResult toolName="team_message" result="Message delivered" />)
    const span = screen.getByText("Message delivered")
    // Team messages are plain content notes, not a success state — they
    // use the same muted body color as other result text.
    expect(span.className).toContain("color-text-2")
  })

  it("renders error result starting with 'Agent(s) not found'", () => {
    render(<ToolResult toolName="team_message" result="Agent(s) not found: researcher. Available: writer, analyst" />)
    expect(screen.getByText(/Agent\(s\) not found/)).toBeTruthy()
  })

  it("renders 'Agent(s) not found' error in the error color", () => {
    render(<ToolResult toolName="team_message" result="Agent(s) not found: foo. Available: bar" />)
    const span = screen.getByText(/Agent\(s\) not found/)
    expect(span.className).toContain("color-error")
  })

  it("renders error result starting with 'No valid recipients'", () => {
    render(<ToolResult toolName="team_message" result="No valid recipients provided" />)
    expect(screen.getByText(/No valid recipients/)).toBeTruthy()
  })

  it("renders 'No valid recipients' error in the error color", () => {
    render(<ToolResult toolName="team_message" result="No valid recipients in the team" />)
    const span = screen.getByText(/No valid recipients/)
    expect(span.className).toContain("color-error")
  })

  it("renders result as a span element", () => {
    render(<ToolResult toolName="team_message" result="Message sent" />)
    const span = screen.getByText("Message sent")
    expect(span.tagName.toLowerCase()).toBe("span")
  })

  it("uses monospace font for result", () => {
    render(<ToolResult toolName="team_message" result="Message sent" />)
    const span = screen.getByText("Message sent")
    expect(span.className).toContain("font-mono")
  })

  it("uses small text size for result", () => {
    render(<ToolResult toolName="team_message" result="Message sent" />)
    const span = screen.getByText("Message sent")
    expect(span.className).toContain("text-[11px]")
  })
})
