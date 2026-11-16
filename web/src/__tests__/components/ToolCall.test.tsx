import { describe, it, expect, afterEach, beforeEach } from "bun:test"
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ToolCall } from "@/components/ToolCall"
import { APP_EVENTS } from "@/lib/app-events"

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
// Header / status rendering
// ---------------------------------------------------------------------------

describe("ToolCall — header", () => {
  it("shows tool name when no custom display config", () => {
    render(<ToolCall name="custom_tool" args='{"path":"src/main.py"}' done={false} />)
    const name = screen.getByText("custom_tool")
    expect(name.className).toContain("font-mono")
    expect(screen.queryByText("Custom Tool")).toBeNull()
  })

  it("shows only the tool name when no args", () => {
    render(<ToolCall name="read" />)
    expect(screen.getByText("read")).toBeTruthy()
    expect(screen.queryByText("Read")).toBeNull()
    expect(screen.queryByText("pending")).toBeNull()
  })

  it("shows the basename for a Windows file path", () => {
    const args = JSON.stringify({ path: String.raw`C:\repo\src\main.py` })
    render(<ToolCall name="read" args={args} done={false} />)
    // The row shows the basename; its tooltip carries the full path.
    expect(getHeader(`read: ${String.raw`C:\repo\src\main.py`}`)).toBeTruthy()
    expect(screen.getByText("main.py")).toBeTruthy()
  })

  it("shows running state when args are set and result is not done", () => {
    render(<ToolCall name="read" args='{"path":"x"}' done={false} />)
    expect(screen.queryByText("pending")).toBeNull()
    // Running state: no pending badge, no result section until expanded details exist
    const btn = screen.getByRole("button")
    expect(btn).toBeTruthy()
    // Running reads "running…" (no summary yet), with no coloured dot or pulse
    expect(btn.querySelector("[data-running-dot]")).toBeNull()
    expect(btn.querySelector(".oa-breathe")).toBeNull()
    expect(btn.textContent).toContain("running…")
  })

  it("shows success state when done without failed result", () => {
    render(<ToolCall name="read" args='{"path":"x"}' done={true} />)
    expect(screen.queryByText("pending")).toBeNull()
    // Success state: no pending badge
    const btn = screen.getByRole("button")
    expect(btn).toBeTruthy()
    expect(btn.querySelector("[data-running-dot]")).toBeNull()
    expect(btn.textContent).not.toContain("running…")
  })

  it("displays persisted duration_ms when done", () => {
    render(<ToolCall name="read" args='{"path":"x"}' done={true} durationMs={1234} />)
    expect(screen.getByText("1.2 s")).toBeTruthy()
  })

  it("displays long durations as minutes and seconds", () => {
    render(<ToolCall name="read" args='{"path":"x"}' done={true} durationMs={93_000} />)
    expect(screen.getByText("1m 33s")).toBeTruthy()
  })

  it("displays realtime elapsed counting while running", async () => {
    render(<ToolCall name="read" args='{"path":"x"}' done={false} startedAt={Date.now() - 1500} />)
    await waitFor(() => {
      expect(screen.getByText(/1\.[5-9] s|2\.0 s/)).toBeTruthy()
    })
  })
})

// ---------------------------------------------------------------------------
// Custom tool display — web_search
// ---------------------------------------------------------------------------

describe("ToolCall — web_search display", () => {
  it("shows conversational header with query", () => {
    const args = JSON.stringify({ query: "latest python release" })
    render(<ToolCall name="web_search" args={args} done={false} />)
    const header = getHeader('web_search: "latest python release"')
    expectPlainArg(header, '"latest python release"')
    expect(screen.getByText("web_search")).toBeTruthy()
  })

  it("hides redundant query args already shown in the header", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ query: "react hooks guide" })
    render(<ToolCall name="web_search" args={args} done result="1. A guide" />)
    await user.click(screen.getByRole("button"))
    expect(screen.queryByText("arguments")).toBeNull()
    expect(screen.queryByText(/"query"/)).toBeNull()
  })

  it("has nothing to expand while a web_search has no result yet", () => {
    const args = JSON.stringify({ query: "react hooks guide" })
    render(<ToolCall name="web_search" args={args} done={false} />)
    const row = screen.getByLabelText("web_search (no details)")
    expect(row.tagName).toBe("DIV")
    expect(screen.queryByRole("button")).toBeNull()
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
    expect(screen.getByText("Lines 12–20 of 100")).toBeTruthy()
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

    expectPlainArg(getHeader("glob: web/src/**/*.tsx in web (by name)"), "web/src/**/*.tsx")
    // No args, no result: nothing to open, so the row is not a button
    expect(screen.queryByRole("button")).toBeNull()
    await user.click(screen.getByLabelText("glob (no details)"))
    expect(screen.queryByText("arguments")).toBeNull()
  })

  it("hides grep args already shown in the header", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ pattern: "useEffect", directory: "web/src", include: "*.tsx" })
    render(<ToolCall name="grep" args={args} done={false} />)

    expectPlainArg(getHeader('grep: "useEffect" in web/src (*.tsx)'), '"useEffect" in web/src (*.tsx)')
    expect(screen.queryByRole("button")).toBeNull()
    await user.click(screen.getByLabelText("grep (no details)"))
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
    const header = getHeader("web_fetch: docs.python.org/3/library/asyncio.html")
    expectPlainArg(header, "docs.python.org/3/library/asyncio.html")
    expect(screen.getByText("web_fetch")).toBeTruthy()
  })

  it("strips www from domain but keeps the path", () => {
    const args = JSON.stringify({ url: "https://www.example.com/page" })
    render(<ToolCall name="web_fetch" args={args} done={false} />)
    const header = getHeader("web_fetch: example.com/page")
    expectPlainArg(header, "example.com/page")
  })

  it("keeps the query string", () => {
    const args = JSON.stringify({ url: "https://example.com/search?q=asyncio" })
    render(<ToolCall name="web_fetch" args={args} done={false} />)
    expectPlainArg(getHeader("web_fetch: example.com/search?q=asyncio"), "example.com/search?q=asyncio")
  })

  it("elides a bare trailing slash", () => {
    const args = JSON.stringify({ url: "https://example.com/" })
    render(<ToolCall name="web_fetch" args={args} done={false} />)
    expectPlainArg(getHeader("web_fetch: example.com"), "example.com")
  })

  it("truncates a long path at 60 chars and shows the whole URL once the row opens", () => {
    const url = "https://www.nytimes.com/2024/03/15/technology/artificial-intelligence-regulation-europe.html"
    render(<ToolCall name="web_fetch" args={JSON.stringify({ url })} done={false} />)
    const header = getHeader("web_fetch: nytimes.com/2024/03/15/technology/artificial-intelligence-regulation-europe.html")
    expect(header.hasAttribute("title")).toBe(false)
    // The row's text is capped at 60 chars + ellipsis…
    expectPlainArg(header, "nytimes.com/2024/03/15/technology/artificial-intelligence-re…")
    expect(screen.getByText("nytimes.com/2024/03/15/technology/artificial-intelligence-re…")).toBeTruthy()
    expect(header.textContent).not.toContain("regulation-europe")
    // …and the open row shows the URL whole, as fetched.
    fireEvent.click(screen.getByRole("button", { name: "Expand web_fetch details" }))
    expect(screen.getByText(url)).toBeTruthy()
  })

  it("truncates a long URL carrying a fragment", () => {
    const url = "https://github.com/lthoangg/openagentd/blob/main/web/src/components/ToolCall/display.tsx#L193"
    render(<ToolCall name="web_fetch" args={JSON.stringify({ url })} done={false} />)
    const header = getHeader("web_fetch: github.com/lthoangg/openagentd/blob/main/web/src/components/ToolCall/display.tsx#L193")
    expectPlainArg(header, "github.com/lthoangg/openagentd/blob/main/web/src/components/…")
    expect(screen.getByText("github.com/lthoangg/openagentd/blob/main/web/src/components/…")).toBeTruthy()
  })

  it("does not truncate a long URL that fits within the cap", () => {
    // 59 chars once the scheme is stripped — exercises the boundary below 60.
    const url = "https://example.com/docs/guides/getting-started/installation"
    render(<ToolCall name="web_fetch" args={JSON.stringify({ url })} done={false} />)
    const header = getHeader("web_fetch: example.com/docs/guides/getting-started/installation")
    expectPlainArg(header, "example.com/docs/guides/getting-started/installation")
    // Nothing cut, so nothing for the details to add: the running row has none.
    expect(header.hasAttribute("title")).toBe(false)
    expect(screen.queryByRole("button", { name: "Expand web_fetch details" })).toBeNull()
    // The target span is the whole URL, uncut (the row's own "running…" is a separate span)
    const target = screen.getByText("example.com/docs/guides/getting-started/installation")
    expect(target.textContent).not.toContain("…")
  })

  it("hides redundant URL args", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ url: "https://docs.python.org/3/library/asyncio.html" })
    render(<ToolCall name="web_fetch" args={args} done result="# Asyncio" />)
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
    // The target is the saved key; the real tool name leads the row.
    const header = getHeader('remember: "style"')
    expectPlainArg(header, '"style"')
    expect(screen.getByText("remember")).toBeTruthy()
    expect(header.textContent).not.toContain("Saving")
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
    const header = getHeader('forget: "preference: style"')
    expectPlainArg(header, '"preference: style"')
    expect(screen.getByText("forget")).toBeTruthy()
    expect(header.textContent).not.toContain("Removing")
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
  it("shows just the tool name when no args", () => {
    // The tool_call → tool_start gap (typically <50ms) shows the real name only.
    render(<ToolCall name="recall" done={false} />)
    expect(screen.getByText("recall")).toBeTruthy()
    expect(screen.queryByText("Checking memory…")).toBeNull()
  })

  it("shows the filter as the target when args are present", () => {
    const args = JSON.stringify({ category: "preference" })
    render(<ToolCall name="recall" args={args} done={false} />)
    const header = getHeader('recall: "preference"')
    expectPlainArg(header, '"preference"')
    expect(screen.getByText("recall")).toBeTruthy()
    expect(header.textContent).not.toContain("Checking memory")
  })

  it("shows no target when recall has no filter", () => {
    render(<ToolCall name="recall" args="{}" done={false} />)
    expect(getHeader("recall")).toBeTruthy()
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
    expect(screen.getByText("custom_tool")).toBeTruthy()
    expect(screen.queryByText("Custom Tool")).toBeNull()
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
    // A row with nothing to open is a plain div, not an empty Tab stop
    const row = screen.getByLabelText("date (no details)")
    expect(row.tagName).toBe("DIV")
    expect(screen.queryByRole("button")).toBeNull()
    expect(row.hasAttribute("aria-expanded")).toBe(false)
    await user.click(row)
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
// Custom tool display — skill
// ---------------------------------------------------------------------------

describe("ToolCall — skill display", () => {
  it("shows conversational header with skill name", () => {
    const args = JSON.stringify({ skill_name: "web-design-guidelines" })
    render(<ToolCall name="skill" args={args} done={false} />)
    expectPlainArg(getHeader("skill: web-design-guidelines"), "web-design-guidelines")
    expect(screen.getByText("skill")).toBeTruthy()
  })

  it("hides args section (formattedArgs is null)", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ skill_name: "backend-testing" })
    render(<ToolCall name="skill" args={args} done={false} />)
    // No args section and no result: nothing to open, so not a button
    expect(screen.queryByRole("button")).toBeNull()
    await user.click(screen.getByLabelText("skill (no details)"))
    expect(screen.queryByText("arguments")).toBeNull()
  })

  it("shows just the tool name when no skill_name", () => {
    const args = JSON.stringify({})
    render(<ToolCall name="skill" args={args} done={false} />)
    expect(getHeader("skill")).toBeTruthy()
    expect(screen.getByText("skill")).toBeTruthy()
    expect(screen.queryByText("Skill")).toBeNull()
  })

  it("shows just the tool name when skill_name is empty string", () => {
    const args = JSON.stringify({ skill_name: "" })
    render(<ToolCall name="skill" args={args} done={false} />)
    expect(getHeader("skill")).toBeTruthy()
    expect(screen.getByText("skill")).toBeTruthy()
    expect(screen.queryByText("Skill")).toBeNull()
  })

  it("shows just the tool name when skill_name is whitespace", () => {
    const args = JSON.stringify({ skill_name: "   " })
    render(<ToolCall name="skill" args={args} done={false} />)
    expect(getHeader("skill")).toBeTruthy()
    expect(screen.getByText("skill")).toBeTruthy()
    expect(screen.queryByText("Skill")).toBeNull()
  })

  it("is not expandable (no details to show)", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ skill_name: "react-component" })
    render(<ToolCall name="skill" args={args} done={false} />)
    const row = screen.getByLabelText("skill (no details)")
    expect(row.tagName).toBe("DIV")
    // Verify clicking does not expand
    await user.click(row)
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

    expectPlainArg(getHeader('todo_manage: add "Audit backend tools"'), 'add "Audit backend tools"')
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

    expectPlainArg(getHeader("todo_manage: 2 actions"), "2 actions")
    await user.click(screen.getByRole("button"))
    expect(screen.getByText(/update task_1: status=completed/)).toBeTruthy()
    expect(screen.getByText(/claim task_2/)).toBeTruthy()
    expect(screen.queryByText(/"task_id"/)).toBeNull()
  })

  it("hides redundant read args", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ actions: [{ action: "read" }] })
    render(<ToolCall name="todo_manage" args={args} done={false} />)

    expect(getHeader("todo_manage: list")).toBeTruthy()
    // Nothing to open for a bare read: a plain row, not a button
    expect(screen.queryByRole("button")).toBeNull()
    await user.click(screen.getByLabelText("todo_manage (no details)"))
    expect(screen.queryByText("arguments")).toBeNull()
  })

  it("shows concise clear summary", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ actions: [{ action: "clear", status: "finished" }] })
    render(<ToolCall name="todo_manage" args={args} done={false} />)

    expect(getHeader("todo_manage: clear finished")).toBeTruthy()
    // A clear carries no args to show, so the row has nothing to open
    expect(screen.queryByRole("button")).toBeNull()
    await user.click(screen.getByLabelText("todo_manage (no details)"))
    expect(screen.queryByText("arguments")).toBeNull()
  })

  it("reads a bare clear as clearing every todo", () => {
    const args = JSON.stringify({ actions: [{ action: "clear" }] })
    render(<ToolCall name="todo_manage" args={args} done={false} />)

    expect(getHeader("todo_manage: clear all")).toBeTruthy()
  })
})

describe("ToolCall — plan display", () => {
  it("shows a write as the plan Markdown, under the same target before and after it finishes", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ action: "write", content: "# Ship it\n\n1. Write the migration" })
    const { rerender } = render(<ToolCall name="plan" args={args} done={false} />)

    // The target reads the same while the call runs and after it finishes
    expect(getHeader("plan: write")).toBeTruthy()
    rerender(<ToolCall name="plan" args={args} done result="Plan saved as revision 1 (3 lines) at plan.md." />)
    expect(getHeader("plan: write")).toBeTruthy()

    await user.click(screen.getByRole("button", { name: /Expand plan details/ }))
    expect(screen.getByText(/1\. Write the migration/)).toBeTruthy()
    expect(screen.queryByText(/"content"/)).toBeNull()
  })

  it("shows an edit as a -/+ diff with its change count", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ action: "edit", edits: [{ old: "1. Old step", new: "1. New step" }, { old: "2. B", new: "2. C" }] })
    const { container } = render(<ToolCall name="plan" args={args} done result="Plan saved as revision 2 (3 lines) at plan.md." />)

    expect(getHeader("plan: edit · 2 changes")).toBeTruthy()
    await user.click(screen.getByRole("button", { name: /Expand plan details/ }))
    const pre = Array.from(container.querySelectorAll("pre")).find((node) => node.textContent?.includes("Old step"))
    expect(pre?.textContent).toBe("- 1. Old step\n+ 1. New step\n\n- 2. B\n+ 2. C")
  })

  it("reads a running edit by its change count, with no running dot", () => {
    const args = JSON.stringify({ action: "edit", edits: [{ old: "a", new: "b" }] })
    render(<ToolCall name="plan" args={args} done={false} />)
    expect(getHeader("plan: edit · 1 change")).toBeTruthy()
    expect(document.querySelector("[data-running-dot]")).toBeNull()
  })

  it("shows a new plan as its Markdown, under the same target before and after it finishes", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ action: "new", content: "# Next\n\n1. Fresh step" })
    const { rerender } = render(<ToolCall name="plan" args={args} done={false} />)

    expect(getHeader("plan: new")).toBeTruthy()
    rerender(<ToolCall name="plan" args={args} done result="Started a new plan as revision 1 (3 lines) at plan.md." />)
    expect(getHeader("plan: new")).toBeTruthy()
    await user.click(screen.getByRole("button", { name: /Expand plan details/ }))
    expect(screen.getByText(/1\. Fresh step/)).toBeTruthy()
  })

  it("opens a saved plan in the Plan tab, with no link while the call runs", () => {
    const opened: Event[] = []
    const onOpen = (event: Event) => opened.push(event)
    window.addEventListener(APP_EVENTS.openPlan, onOpen)
    const { rerender } = render(<ToolCall name="plan" args='{"action":"write","content":"# Ship' done={false} />)
    expect(screen.queryByRole("button", { name: /plan$/ })).toBeNull()

    rerender(<ToolCall name="plan" args='{"action":"write","content":"# Ship"}' done result="Plan saved as revision 1 (1 lines) at plan.md." />)
    fireEvent.click(screen.getByRole("button", { name: "Open plan" }))
    expect(opened).toHaveLength(1)
    window.removeEventListener(APP_EVENTS.openPlan, onOpen)
  })

  it("offers Open plan once saved, and nothing when the call failed", () => {
    const args = JSON.stringify({ action: "write", content: "# Ship it" })
    const { rerender } = render(<ToolCall name="plan" args={args} done result="Plan saved as revision 1 (1 lines) at plan.md." />)
    expect(screen.getByRole("button", { name: "Open plan" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "View plan" })).toBeNull()

    rerender(<ToolCall name="plan" args={args} done result="Error: The plan is empty." />)
    expect(screen.queryByRole("button", { name: "Open plan" })).toBeNull()
  })

  it("shows a plan call with submit as the review card, like the former submit_plan", () => {
    const args = JSON.stringify({ action: "write", content: "# Ship it", submit: true, summary: "First draft." })
    const { rerender } = render(<ToolCall name="plan" args={args} done result="The user approved plan revision 1." />)
    expect(screen.getByText("Plan review")).toBeTruthy()
    expect(screen.getByText("Approved")).toBeTruthy()
    expect(screen.getByText("First draft.")).toBeTruthy()

    rerender(<ToolCall name="submit_plan" args="{}" done result="The user approved plan revision 1." />)
    expect(screen.getByText("Plan review")).toBeTruthy()
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

    expectPlainArg(getHeader("schedule_task: create daily-standup"), "create daily-standup")
    await user.click(screen.getByRole("button"))
    expect(screen.getByText(/schedule: cron 0 8 \* \* 1-5 \(Asia\/Ho_Chi_Minh\)/)).toBeTruthy()
    expect(screen.getByText(/prompt: Draft the standup summary\./)).toBeTruthy()
    expect(screen.queryByText(/"cron_expression"/)).toBeNull()
  })

  it("hides redundant list args", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ action: "list" })
    render(<ToolCall name="schedule_task" args={args} done={false} />)

    expect(getHeader("schedule_task: list")).toBeTruthy()
    expect(screen.queryByRole("button")).toBeNull()
    await user.click(screen.getByLabelText("schedule_task (no details)"))
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

    expect(getHeader("patch: a.ts, b.ts")).toBeTruthy()
    expect(screen.queryByText("src/a.ts")).toBeNull()
    expect(screen.queryByText("src/b.ts")).toBeNull()
  })

  it("deduplicates repeated basenames in the patch header", () => {
    const args = JSON.stringify({
      patch_text: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** Update File: lib/a.ts\n@@\n-x\n+y\n*** End Patch",
    })

    render(<ToolCall name="patch" args={args} done={false} />)

    expect(getHeader("patch: a.ts")).toBeTruthy()
  })

  it("truncates a long patch file list in the header", () => {
    const sections = Array.from({ length: 12 }, (_, i) => (
      `*** Update File: src/some-longer-file-name-${i}.ts\n@@\n-old\n+new`
    )).join("\n")
    const args = JSON.stringify({
      patch_text: `*** Begin Patch\n${sections}\n*** End Patch`,
    })

    render(<ToolCall name="patch" args={args} done={false} />)

    const title = Array.from(document.querySelectorAll("[data-tool-label]"))
      .map((node) => node.getAttribute("data-tool-label"))
      .find((t) => t?.startsWith("patch: "))
    expect(title).toBeTruthy()
    expect(title!.endsWith("…")).toBe(true)
    expect(title!.length).toBeLessThan(80)
  })

})

// ---------------------------------------------------------------------------
// Custom tool display — bg
// ---------------------------------------------------------------------------

describe("ToolCall — bg display", () => {
  // The row leads with the real tool name `bg`, then `<action> pid <n>`
  // (or just the action, or just `list`), worded the same running or done.

  it("shows 'list' after the tool name for action=list", () => {
    const args = JSON.stringify({ action: "list" })
    render(<ToolCall name="bg" args={args} done={false} />)
    const header = getHeader("bg: list")
    expect(header.querySelector("em")).toBeNull()
    expect(screen.getByText("bg").className).toContain("font-mono")
    expect(screen.getByText("list")).toBeTruthy()
    expect(header.textContent).not.toContain("Listing")
  })

  it("shows '<action> pid <n>' for action=status with pid", () => {
    const args = JSON.stringify({ action: "status", pid: 1234 })
    render(<ToolCall name="bg" args={args} done={false} />)
    expectPlainArg(getHeader("bg: status pid 1234"), "status pid 1234")
  })

  it("shows just the action for action=status without pid", () => {
    const args = JSON.stringify({ action: "status" })
    render(<ToolCall name="bg" args={args} done={false} />)
    const header = getHeader("bg: status")
    expect(header.querySelector("em")).toBeNull()
    expect(screen.getByText("status")).toBeTruthy()
  })

  it("shows '<action> pid <n>' for action=output with pid", () => {
    const args = JSON.stringify({ action: "output", pid: 5678 })
    render(<ToolCall name="bg" args={args} done={false} />)
    expectPlainArg(getHeader("bg: output pid 5678"), "output pid 5678")
  })

  it("shows just the action for action=output without pid", () => {
    const args = JSON.stringify({ action: "output" })
    render(<ToolCall name="bg" args={args} done={false} />)
    const header = getHeader("bg: output")
    expect(header.querySelector("em")).toBeNull()
    expect(screen.getByText("output")).toBeTruthy()
  })

  // `wait` was removed from the bg tool (it duplicated foreground shell while
  // capping at 300s). Stored transcripts still contain it, so the generic
  // fallback has to stay readable rather than render blank.
  it("keeps the retired wait action readable as '<action> pid <n>'", () => {
    const args = JSON.stringify({ action: "wait", pid: 2468 })
    render(<ToolCall name="bg" args={args} done={false} />)
    expectPlainArg(getHeader("bg: wait pid 2468"), "wait pid 2468")
  })

  it("shows '<action> pid <n>' for action=stop with pid", () => {
    const args = JSON.stringify({ action: "stop", pid: 9999 })
    render(<ToolCall name="bg" args={args} done={false} />)
    expectPlainArg(getHeader("bg: stop pid 9999"), "stop pid 9999")
  })

  it("shows just the action for action=stop without pid", () => {
    const args = JSON.stringify({ action: "stop" })
    render(<ToolCall name="bg" args={args} done={false} />)
    const header = getHeader("bg: stop")
    expect(header.querySelector("em")).toBeNull()
    expect(screen.getByText("stop")).toBeTruthy()
  })

  it("shows just the pid when there is no action", () => {
    const args = JSON.stringify({ pid: 1234 })
    render(<ToolCall name="bg" args={args} done={false} />)
    const header = getHeader("bg: pid 1234")
    expect(header.querySelector("em")).toBeNull()
    expect(screen.getByText("pid 1234")).toBeTruthy()
  })

  it("shows only the tool name when action is empty", () => {
    const args = JSON.stringify({ action: "" })
    render(<ToolCall name="bg" args={args} done={false} />)
    const header = getHeader("bg")
    expect(header.querySelector("em")).toBeNull()
    expect(screen.getByText("bg")).toBeTruthy()
  })

  it("shows only the tool name when action is whitespace", () => {
    const args = JSON.stringify({ action: "   " })
    render(<ToolCall name="bg" args={args} done={false} />)
    const header = getHeader("bg")
    expect(header.querySelector("em")).toBeNull()
    expect(screen.getByText("bg")).toBeTruthy()
  })

  it("hides args section (formattedArgs is null)", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ action: "list" })
    render(<ToolCall name="bg" args={args} done={false} />)
    // Args section is not rendered and there is nothing to open: not a button
    expect(screen.queryByRole("button")).toBeNull()
    await user.click(screen.getByLabelText("bg (no details)"))
    expect(screen.queryByText("arguments")).toBeNull()
  })

  it("handles action case-insensitively", () => {
    const args = JSON.stringify({ action: "LIST" })
    render(<ToolCall name="bg" args={args} done={false} />)
    expect(getHeader("bg: list")).toBeTruthy()
  })

  it("handles mixed case action", () => {
    const args = JSON.stringify({ action: "Status", pid: 42 })
    render(<ToolCall name="bg" args={args} done={false} />)
    expectPlainArg(getHeader("bg: status pid 42"), "status pid 42")
  })

  it("is not expandable (no details to show)", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ action: "list" })
    render(<ToolCall name="bg" args={args} done={false} />)
    const row = screen.getByLabelText("bg (no details)")
    expect(row.tagName).toBe("DIV")
    expect(screen.queryByRole("button")).toBeNull()
    // Verify clicking does not expand
    await user.click(row)
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

describe("ToolCall — empty args {} show no args section", () => {
  it("hides args section when args is empty object", async () => {
    const user = userEvent.setup()
    render(<ToolCall name="custom_tool" args="{}" done={false} />)
    // Nothing to show: a plain row, not a button
    expect(screen.queryByRole("button")).toBeNull()
    await user.click(screen.getByLabelText("custom_tool (no details)"))
    // No args section should appear
    expect(screen.queryByText("arguments")).toBeNull()
  })

  it("shows tool name when args is empty object", () => {
    render(<ToolCall name="custom_tool" args="{}" done={false} />)
    expect(screen.getByText("custom_tool")).toBeTruthy()
    expect(screen.queryByText("Custom Tool")).toBeNull()
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
        result={"[Failed — exit code 1]\n\nAssertionError"}
      />,
    )

    // Collapsed: no exit chip; the agent handles the failure
    expect(screen.queryByText("exit 1")).toBeNull()

    await user.click(screen.getByRole("button"))
    // Expanded: the status line is gone from the output, its body is kept
    const pre = document.querySelector("pre")
    expect(pre!.textContent).toContain("AssertionError")
    expect(pre!.textContent).not.toContain("Failed")
    expect(screen.queryByText(/\[Failed/)).toBeNull()
  })

  it("date tool with no args shows no args section", async () => {
    const user = userEvent.setup()
    render(<ToolCall name="date" done={false} />)
    expect(screen.queryByRole("button")).toBeNull()
    await user.click(screen.getByLabelText("date (no details)"))
    expect(screen.queryByText("arguments")).toBeNull()
  })

  it("date tool with empty args shows no args section", async () => {
    const user = userEvent.setup()
    render(<ToolCall name="date" args="{}" done={false} />)
    expect(screen.queryByRole("button")).toBeNull()
    await user.click(screen.getByLabelText("date (no details)"))
    expect(screen.queryByText("arguments")).toBeNull()
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
    expect(getHeader("patch: ToolResult.tsx")).toBeTruthy()
    await user.click(screen.getByRole("button"))
    expect(screen.getAllByText("src/components/ToolResult.tsx").length).toBeGreaterThan(0)
  })
})
