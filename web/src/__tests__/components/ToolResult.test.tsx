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
    expect(screen.getByText(/Lines 12.20 of 100/)).toBeTruthy()
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
  /** The Chip wrapping `text`: its tone and whether it carries the live dot. */
  function chipOf(text: string) {
    const chip = screen.getByText(text).closest('[data-slot="chip"]')
    if (!chip) throw new Error(`no chip around "${text}"`)
    return { tone: chip.getAttribute("data-tone"), dot: chip.querySelector('[aria-hidden="true"]') !== null }
  }

  it("renders the process list as structured rows", () => {
    render(
      <ToolResult
        toolName="bg"
        result={"PID     | Status  | Command\n--------|---------|--------\n1234    | running | bun run dev\n5678    | exited (1) | bun test"}
      />,
    )

    expect(screen.getByText("2 background processes")).toBeTruthy()
    // Rows are mono (the pid inherits it from the row)
    expect(screen.getByText("pid 1234").closest("li")?.className).toContain("font-mono")
    expect(screen.getByText("pid 5678")).toBeTruthy()
    expect(screen.queryByText("PID 1234")).toBeNull()
    expect(screen.getByText("bun run dev")).toBeTruthy()
    // Status is a chip: running is info with the live dot, exited is neutral
    expect(chipOf("running")).toEqual({ tone: "info", dot: true })
    expect(chipOf("exited (1)")).toEqual({ tone: "neutral", dot: false })
  })

  it("titles a single-process list in the singular", () => {
    render(
      <ToolResult
        toolName="bg"
        result={"PID     | Status  | Command\n--------|---------|--------\n1234    | running | bun run dev"}
      />,
    )

    expect(screen.getByText("1 background process")).toBeTruthy()
  })

  it("renders a process status with command and buffered-line metadata", () => {
    render(
      <ToolResult
        toolName="bg"
        result={"PID 1234: running\nCommand: bun run dev\nBuffered lines: 18"}
      />,
    )

    expect(screen.getByText("pid 1234").className).toContain("font-mono")
    expect(chipOf("running")).toEqual({ tone: "info", dot: true })
    expect(screen.getByText("bun run dev")).toBeTruthy()
    const detail = screen.getByText("18 new lines")
    expect(detail.className).toContain("font-sans")
    expect(detail.className).toContain("text-(--color-text-muted)")
    expect(screen.queryByText("18 buffered lines")).toBeNull()
  })

  it("reads a single buffered line in the singular", () => {
    render(<ToolResult toolName="bg" result={"PID 1234: running\nCommand: bun run dev\nBuffered lines: 1"} />)

    expect(screen.getByText("1 new line")).toBeTruthy()
  })

  it("keeps captured output in a scrollable terminal block", () => {
    const { container } = render(
      <ToolResult toolName="bg" result={"PID 1234 output:\nfirst line\nsecond line"} />,
    )

    // `pid 1234` with the detail "output" (there is no status to show)
    expect(screen.getByText("pid 1234")).toBeTruthy()
    expect(screen.getByText("output").className).toContain("text-(--color-text-muted)")
    expect(screen.queryByText("PID 1234 output")).toBeNull()
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

    expect(screen.getByText("pid 13601")).toBeTruthy()
    expect(chipOf("still running")).toEqual({ tone: "info", dot: true })
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

    expect(screen.getByText("pid 33315")).toBeTruthy()
    // Anything that is not running / exited / stopped reads as an error chip
    expect(chipOf("not found")).toEqual({ tone: "error", dot: false })
    expect(screen.getByText("known: none")).toBeTruthy()
    expect(screen.queryByText("Known PIDs: none")).toBeNull()
    expect(screen.getByText("No tracked background process with PID 33315. Known PIDs: none.")).toBeTruthy()
    expect(document.querySelector("pre")).toBeNull()
  })

  it("renders an empty process list as a concise empty state", () => {
    render(<ToolResult toolName="bg" result="No background processes running." />)

    // The header carries the whole message; there is no body paragraph
    expect(screen.getByText("No background processes")).toBeTruthy()
    expect(screen.queryByText("No background processes running.")).toBeNull()
    expect(document.querySelector("pre")).toBeNull()
  })

  it("lists the known PIDs as detail when a process is not found", () => {
    render(<ToolResult toolName="bg" result="Error: No tracked background process with PID 7. Known PIDs: 1, 2." />)

    expect(screen.getByText("pid 7")).toBeTruthy()
    expect(screen.getByText("known: 1, 2")).toBeTruthy()
  })

  it("shows a bare error chip when the error names no PID", () => {
    render(<ToolResult toolName="bg" result="Error: Unknown action." />)

    expect(chipOf("error")).toEqual({ tone: "error", dot: false })
    expect(screen.queryByText(/^pid /)).toBeNull()
  })

  it("reads an exited process with captured output as a neutral chip with no output detail", () => {
    render(<ToolResult toolName="bg" result={"PID 9: exited (code 0)\nFinal output:\ndone"} />)

    expect(screen.getByText("pid 9")).toBeTruthy()
    expect(chipOf("exited (code 0)")).toEqual({ tone: "neutral", dot: false })
    // The "output" detail only shows when there is no status
    expect(screen.queryByText("output")).toBeNull()
    expect(screen.getByText(/done/)).toBeTruthy()
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
// LSP Diagnostics renderer
// ---------------------------------------------------------------------------

describe("ToolResult — LSP Diagnostics", () => {
  it("renders clean tool result followed by structured diagnostics", () => {
    const result =
      "Written 125 bytes to src/main.py\n\n[LSP Diagnostics]\n- src/main.py:10:5: error: Expected expression (pyright)\n- src/main.py:15:1: warning: Unused import 'os' (ruff)"

    render(<ToolResult toolName="write" result={result} />)

    // Verify clean tool result
    expect(screen.getByText("Written 125 bytes to src/main.py")).toBeTruthy()

    // Severity in words; only the error line is tinted.
    expect(screen.getByText("Error").closest("div")?.className).toContain("bg-(--color-error-subtle)")
    expect(screen.getByText("Warning").closest("div")?.className).not.toContain("bg-(--color-error-subtle)")

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
    expect(screen.getByText("after task_1")).toBeTruthy()
    expect(screen.queryByText(/deps: /)).toBeNull()
  })

  it("orders task meta as status, priority, agent, dependencies, then the task id", () => {
    render(<ToolResult toolName="todo_manage" result={boardResult} />)
    const meta = screen.getByText("task_2").parentElement as HTMLElement
    expect(Array.from(meta.children).map((node) => node.textContent)).toEqual([
      "pending",
      "medium",
      "executor#2",
      "after task_1",
      "task_2",
    ])
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
    // The outcome names the task's words first, its id trailing
    expect(screen.getByText('claimed "Write a concurrency haiku" · task_1')).toBeTruthy()
    expect(screen.queryByText("claimed task_1")).toBeNull()
    // …and the task card itself still lists the content and the id
    expect(screen.getAllByText(/Write a concurrency haiku/).length).toBe(2)
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

  it("leaves an outcome line unchanged when its task is not in the list", () => {
    render(<ToolResult toolName="todo_manage" result={"claimed task_9\n[task_1] [pending] (low) Other work"} />)
    expect(screen.getByText("claimed task_9")).toBeTruthy()
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

// ---------------------------------------------------------------------------
// Team tools renderer
// ---------------------------------------------------------------------------

describe("ToolResult — team tools", () => {
  it("renders completed subagent output with handle and status", () => {
    const res = JSON.stringify({
      status: "completed",
      member_id: "explorer#1",
      output: "Audit finished: 5 endpoints found.",
    })
    render(<ToolResult toolName="team_spawn" result={res} />)
    // The member id is an outline mono chip; the status is a success chip
    const member = screen.getByText("explorer#1").closest('[data-slot="chip"]')
    expect(member?.className).toContain("font-mono")
    expect(member?.className).toContain("border")
    expect(screen.getByText("completed").closest('[data-slot="chip"]')?.getAttribute("data-tone")).toBe("success")
    expect(screen.getByText(/Audit finished: 5 endpoints found\./)).toBeTruthy()
  })

  it("labels a spawned subagent as running", () => {
    const res = JSON.stringify({ status: "spawned", member_id: "explorer#3" })
    render(<ToolResult toolName="team_spawn" result={res} />)
    const status = screen.getByText("running").closest('[data-slot="chip"]')
    expect(status?.getAttribute("data-tone")).toBe("info")
    expect(screen.queryByText("spawned")).toBeNull()
  })

  it("renders waiting_lead pending question and discrete options", () => {
    const res = JSON.stringify({
      status: "waiting_lead",
      member_id: "explorer#2",
      pending_question: {
        question: "Should I include OAuth routes?",
        options: ["yes", "no"],
      },
    })
    render(<ToolResult toolName="team_send" result={res} />)
    expect(screen.getByText("explorer#2")).toBeTruthy()
    const status = screen.getByText("waiting for main agent").closest('[data-slot="chip"]')
    expect(status?.getAttribute("data-tone")).toBe("warning")
    expect(screen.queryByText("waiting for lead decision")).toBeNull()
    expect(screen.getByText("Question for the main agent")).toBeTruthy()
    expect(screen.queryByText("Clarification needed from lead:")).toBeNull()
    expect(screen.getByText("Should I include OAuth routes?")).toBeTruthy()
    expect(screen.getByText("yes")).toBeTruthy()
    expect(screen.getByText("no")).toBeTruthy()
  })

  it("renders multi-member results for team_wait", () => {
    const res = JSON.stringify({
      status: "completed",
      results: {
        "explorer#1": { status: "completed", output: "Found 3 files" },
        "researcher#1": { status: "completed", output: "Fetched docs" },
      },
    })
    render(<ToolResult toolName="team_wait" result={res} />)
    expect(screen.getByText("explorer#1")).toBeTruthy()
    expect(screen.getByText("researcher#1")).toBeTruthy()
    expect(screen.getByText(/Found 3 files/)).toBeTruthy()
    expect(screen.getByText(/Fetched docs/)).toBeTruthy()
  })

  it("renders roster list for team_list and team_manage", () => {
    const res = JSON.stringify({
      available_profiles: [{ name: "explorer" }],
      live_members: [
        { member_id: "explorer#1", status: "working" },
        { member_id: "researcher#1", status: "completed" },
      ],
    })
    render(<ToolResult toolName="team_manage" result={res} />)
    expect(screen.getByText("Subagents")).toBeTruthy()
    expect(screen.queryByText("Subagent Roster")).toBeNull()
    expect(screen.getByText("explorer#1")).toBeTruthy()
    // Roster statuses are chips; an unknown status keeps its raw text
    expect(screen.getByText("working").closest('[data-slot="chip"]')).toBeTruthy()
    expect(screen.getByText("completed").closest('[data-slot="chip"]')?.getAttribute("data-tone")).toBe("success")
    expect(screen.getByText("researcher#1")).toBeTruthy()
  })
})
