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
// filesystem list renderers (glob, grep)
// ---------------------------------------------------------------------------

const LIST_TOOLS = ["glob", "grep"] as const

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
    expect(screen.queryByText("file contents")).toBeNull()
    expect(screen.getByText(/const x = 1/)).toBeTruthy()
    expect(screen.getByText(/const y = 2/)).toBeTruthy()
  })

  it("promotes the [start-end/total] range header to a metadata label", () => {
    // The backend read tool prepends "[12-20/100]\n" when offset/limit are
    // active. We surface that as a quiet "lines 12-20 of 100" label so the
    // pre block shows only the actual file content.
    render(<ToolResult toolName="read" result={"[12-20/100]\nconst y = 2"} />)
    expect(screen.getByText(/lines 12.20 of 100/)).toBeTruthy()
    // Raw bracketed header is no longer shown verbatim
    expect(screen.queryByText(/\[12-20\/100\]/)).toBeNull()
  })

  it("uses compact file chrome without diff line markers", () => {
    render(<ToolResult toolName="read" result={"line one\nline two"} />)

    expect(screen.queryByText("+")).toBeNull()
    expect(screen.queryByText("-")).toBeNull()
  })

  it("renders full content as-is when no range header is present", () => {
    render(<ToolResult toolName="read" result={"hello\nworld"} />)
    expect(screen.getByText(/hello/)).toBeTruthy()
    expect(screen.getByText(/world/)).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// Background-process renderer
// ---------------------------------------------------------------------------

describe("ToolResult - bg", () => {
  it("renders the process list as structured rows", () => {
    render(
      <ToolResult
        toolName="bg"
        result={"PID     | Status  | Command\n--------|---------|--------\n1234    | running | bun run dev\n5678    | exited (1) | bun test"}
      />,
    )

    expect(screen.getByText("2 processes")).toBeTruthy()
    expect(screen.getByText("PID 1234")).toBeTruthy()
    expect(screen.getByText("running")).toBeTruthy()
    expect(screen.getByText("bun run dev")).toBeTruthy()
    expect(screen.getByText("exited (1)")).toBeTruthy()
  })

  it("renders a process status with command and buffered-line metadata", () => {
    render(
      <ToolResult
        toolName="bg"
        result={"PID 1234: running\nCommand: bun run dev\nBuffered lines: 18"}
      />,
    )

    expect(screen.getByText("PID 1234")).toBeTruthy()
    expect(screen.getByText("running")).toBeTruthy()
    expect(screen.getByText("bun run dev")).toBeTruthy()
    expect(screen.getByText("18 buffered lines")).toBeTruthy()
  })

  it("keeps captured output in a scrollable terminal block", () => {
    const { container } = render(
      <ToolResult toolName="bg" result={"PID 1234 output:\nfirst line\nsecond line"} />,
    )

    expect(screen.getByText("PID 1234 output")).toBeTruthy()
    expect(screen.getByText(/first line/)).toBeTruthy()
    expect(container.querySelector("pre")?.className).toContain("overflow-y-auto")
  })

  it("renders background tool wait timeout with structured process header and guidance message", () => {
    render(
      <ToolResult
        toolName="bg"
        result={"PID 13601: still running after 120 seconds.\nUse status or output to inspect it, wait again, or stop it."}
      />,
    )

    expect(screen.getByText("PID 13601")).toBeTruthy()
    expect(screen.getByText("still running")).toBeTruthy()
    expect(screen.getByText("after 120 seconds")).toBeTruthy()
    expect(screen.getByText("Use status or output to inspect it, wait again, or stop it.")).toBeTruthy()
    expect(document.querySelector("pre")).toBeNull()
  })

  it("renders background tool error with structured PID header, 'not found' status, and error message", () => {
    render(
      <ToolResult
        toolName="bg"
        result="Error: No tracked background process with PID 33315. Known PIDs: none."
      />,
    )

    expect(screen.getByText("PID 33315")).toBeTruthy()
    expect(screen.getByText("not found")).toBeTruthy()
    expect(screen.getByText("Known PIDs: none")).toBeTruthy()
    expect(screen.getByText("No tracked background process with PID 33315. Known PIDs: none.")).toBeTruthy()
    expect(document.querySelector("pre")).toBeNull()
  })

  it("renders an empty process list as a concise empty state", () => {
    render(<ToolResult toolName="bg" result="No background processes running." />)

    expect(screen.getByText("No background processes running.")).toBeTruthy()
    expect(document.querySelector("pre")).toBeNull()
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

  it("renders error result starting with 'Agent(s) not found'", () => {
    render(<ToolResult toolName="team_message" result="Agent(s) not found: researcher. Available: writer, analyst" />)
    expect(screen.getByText(/Agent\(s\) not found/)).toBeTruthy()
  })

  it("renders error result starting with 'No valid recipients'", () => {
    render(<ToolResult toolName="team_message" result="No valid recipients provided" />)
    expect(screen.getByText(/No valid recipients/)).toBeTruthy()
  })

  it("renders result as a span element", () => {
    render(<ToolResult toolName="team_message" result="Message sent" />)
    const span = screen.getByText("Message sent")
    expect(span.tagName.toLowerCase()).toBe("span")
  })

})

// ---------------------------------------------------------------------------
// LSP Diagnostics renderer
// ---------------------------------------------------------------------------

describe("ToolResult — LSP Diagnostics", () => {
  it("renders clean tool result followed by structured diagnostics", () => {
    const result =
      "Written 125 bytes to src/main.py\n\n[LSP Diagnostics]\n- src/main.py:10:5: error: Expected expression (pyright)\n- src/main.py:15:1: warning: Unused import 'os' (ruff)"

    render(<ToolResult toolName="write" result={result} />)

    // Verify clean tool result
    expect(screen.getByText("Written 125 bytes to src/main.py")).toBeTruthy()

    // Verify diagnostics labels (compact: ERR / WARN)
    expect(screen.getByText("ERR")).toBeTruthy()
    expect(screen.getByText("WARN")).toBeTruthy()

    // Verify diagnostic locations & messages
    expect(screen.getByText("10:5")).toBeTruthy()
    expect(screen.getByText("Expected expression")).toBeTruthy()

    expect(screen.getByText("15:1")).toBeTruthy()
    expect(screen.getByText("Unused import 'os'")).toBeTruthy()
  })

  it("renders the backend cap summary as a '+N more' line", () => {
    const result =
      "Written 1 byte to a.py\n\n[LSP Diagnostics]\n- a.py:1:1: error: bad (ty)\n- …and 12 more in a.py"

    render(<ToolResult toolName="write" result={result} />)

    expect(screen.getByText("bad")).toBeTruthy()
    expect(screen.getByText("+12 more")).toBeTruthy()
  })

  it("filters out diagnostics of other severities if any", () => {
    const result =
      "Written 125 bytes to src/main.py\n\n[LSP Diagnostics]\n- src/main.py:10:5: info: Info message (ruff)"

    const { container } = render(<ToolResult toolName="write" result={result} />)
    const pre = container.querySelector("pre")
    expect(pre?.textContent).toBe(result)
    // Should not show ERR or WARN if there are no errors or warnings
    expect(screen.queryByText("ERR")).toBeNull()
    expect(screen.queryByText("WARN")).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// todo_manage renderer — structured board-state view
// ---------------------------------------------------------------------------

describe("ToolResult — todo_manage", () => {
  const boardResult = [
    "[task_1] [completed] (high) assigned=executor#1 claimed=executor#1 Write a concurrency haiku",
    "    instructions: Create haiku.txt and verify it exists.",
    "    result: Created haiku.txt. Exact text:",
    "Threads weave in tandem",
    "[task_2] [pending] (medium) deps=[task_1] assigned=executor#2 Reverse the haiku",
    "[task_3] [in_progress] (low) claimed=executor#3 Unrelated work",
  ].join("\n")

  it("renders one row per task with its content", () => {
    render(<ToolResult toolName="todo_manage" result={boardResult} />)
    expect(screen.getByText(/Write a concurrency haiku/)).toBeTruthy()
    expect(screen.getByText(/Reverse the haiku/)).toBeTruthy()
    expect(screen.getByText(/Unrelated work/)).toBeTruthy()
  })

  it("shows task ids and status metadata", () => {
    render(<ToolResult toolName="todo_manage" result={boardResult} />)
    expect(screen.getByText("task_1")).toBeTruthy()
    expect(screen.getByText("task_2")).toBeTruthy()
    expect(screen.getByText(/executor#2/)).toBeTruthy()
  })

  it("shows dependency metadata", () => {
    render(<ToolResult toolName="todo_manage" result={boardResult} />)
    expect(screen.getByText(/deps: task_1/)).toBeTruthy()
  })

  it("renders instructions and result sub-lines including continuations", () => {
    render(<ToolResult toolName="todo_manage" result={boardResult} />)
    expect(screen.getByText(/Create haiku\.txt and verify it exists\./)).toBeTruthy()
    expect(screen.getByText(/Threads weave in tandem/)).toBeTruthy()
  })

  it("renders the empty board message", () => {
    render(<ToolResult toolName="todo_manage" result="No todos." />)
    expect(screen.getByText("No todos.")).toBeTruthy()
  })

  it("renders claim result with outcome line and claimed task card", () => {
    const claimResult = [
      "claimed task_1",
      "[task_1] [in_progress] (high) claimed=executor#1 Write a concurrency haiku",
      "    instructions: Create haiku.txt and verify it exists.",
    ].join("\n")

    render(<ToolResult toolName="todo_manage" result={claimResult} />)
    expect(screen.getByText("claimed task_1")).toBeTruthy()
    expect(screen.getByText(/Write a concurrency haiku/)).toBeTruthy()
    expect(screen.getByText("task_1")).toBeTruthy()
    expect(screen.getByText("high")).toBeTruthy()
    expect(screen.getByText(/Create haiku\.txt and verify it exists\./)).toBeTruthy()
  })

  it("renders outcome lines from mutations cleanly", () => {
    const outcomesResult = [
      "created task_1, task_2",
      "cleared 1 completed",
      "blocked task_3: waiting for task_1",
    ].join("\n")

    render(<ToolResult toolName="todo_manage" result={outcomesResult} />)
    expect(screen.getByText("created task_1, task_2")).toBeTruthy()
    expect(screen.getByText("cleared 1 completed")).toBeTruthy()
    expect(screen.getByText("blocked task_3: waiting for task_1")).toBeTruthy()
  })

  it("tolerates trailing newlines and blank lines", () => {
    render(<ToolResult toolName="todo_manage" result={boardResult + "\n\n"} />)
    expect(screen.getByText(/Write a concurrency haiku/)).toBeTruthy()
  })

  it("falls back to generic text for unparseable results", () => {
    render(<ToolResult toolName="todo_manage" result="something unexpected" />)
    expect(screen.getByText("something unexpected")).toBeTruthy()
  })
})
