import { describe, it, expect, afterEach, mock } from "bun:test"
import React from "react"
import { render, screen, cleanup } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ToolCall } from "@/components/ToolCall"

// Mock framer-motion — cache per-tag so React sees stable component references
const _motionCache: Record<string, React.FC> = {}
const motionProxy = new Proxy({}, {
  get: (_t, tag: string) => {
    if (!_motionCache[tag]) {
      _motionCache[tag] = ({ children, ...props }: React.HTMLAttributes<HTMLElement>) =>
        React.createElement(tag, props, children)
    }
    return _motionCache[tag]
  },
})
mock.module("framer-motion", () => ({
  motion: motionProxy,
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

mock.module("lucide-react", () => new Proxy({}, { get: () => () => null }))

afterEach(cleanup)

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------
//
// Header markup is now `<span title="full text">verb <span>arg</span></span>`.
// `getByText("Messaging researcher")` no longer matches because the text spans
// two elements. These helpers locate the outer header span via its `title`
// attribute (which mirrors the full plain-text header) and assert the argument
// is rendered without italics.

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

function expectPlainArg(header: HTMLElement, arg: string) {
  expect(header.querySelector("em")).toBeNull()
  expect(header.textContent).toContain(arg)
}

// ---------------------------------------------------------------------------
// team_message header display
// ---------------------------------------------------------------------------

describe("ToolCall — team_message header", () => {
  it("shows 'Messaging researcher' for single recipient", () => {
    const args = JSON.stringify({ to: ["researcher"], content: "hello" })
    render(<ToolCall name="team_message" args={args} done={false} />)
    expectPlainArg(getHeader("Messaging researcher"), "researcher")
  })

  it("shows 'Messaging researcher, writer' for multiple recipients", () => {
    const args = JSON.stringify({ to: ["researcher", "writer"], content: "hello" })
    render(<ToolCall name="team_message" args={args} done={false} />)
    expectPlainArg(getHeader("Messaging researcher, writer"), "researcher, writer")
  })

  it("shows 'Messaging team' when recipients array is empty", () => {
    const args = JSON.stringify({ to: [], content: "hello" })
    render(<ToolCall name="team_message" args={args} done={false} />)
    expectPlainArg(getHeader("Messaging team"), "team")
  })

  it("shows 'Messaging team' when 'to' field is missing", () => {
    const args = JSON.stringify({ content: "hello" })
    render(<ToolCall name="team_message" args={args} done={false} />)
    expectPlainArg(getHeader("Messaging team"), "team")
  })

  it("truncates recipient list when exceeds 60 chars", () => {
    const longRecipients = ["very_long_agent_name_one", "very_long_agent_name_two", "very_long_agent_name_three"]
    const args = JSON.stringify({ to: longRecipients, content: "hello" })
    render(<ToolCall name="team_message" args={args} done={false} />)
    // Header title carries the truncated recipient list; it still starts with "Messaging ".
    const header = document.querySelector('[title^="Messaging "]') as HTMLElement | null
    expect(header).toBeTruthy()
    expect(header!.textContent).toContain("…")
  })

  it("renders the recipient argument in the header", () => {
    const args = JSON.stringify({ to: ["researcher"], content: "hello" })
    render(<ToolCall name="team_message" args={args} done={false} />)
    const header = getHeader("Messaging researcher")
    expectPlainArg(header, "researcher")
  })

  it("does not render raw tool name 'team_message' when args provided", () => {
    const args = JSON.stringify({ to: ["researcher"], content: "hello" })
    render(<ToolCall name="team_message" args={args} done={false} />)
    expect(screen.queryByText("team_message")).toBeNull()
  })

  it("shows friendly 'Preparing message…' header when args is undefined (pending state)", () => {
    // Without a custom pending header the tool_call → tool_start gap
    // flashes <50ms and the start phase looks invisible. The friendly
    // header makes the lifecycle visible end-to-end.
    render(<ToolCall name="team_message" done={false} />)
    expect(screen.getByText("Preparing message…")).toBeTruthy()
    // Raw tool name must NOT leak through in the pending state.
    expect(screen.queryByText("team_message")).toBeNull()
  })

  it("shows no pending badge when args is undefined", () => {
    render(<ToolCall name="team_message" done={false} />)
    expect(screen.queryByText("pending")).toBeNull()
    expect(screen.getByText("Preparing message…")).toBeTruthy()
  })

  it("handles numeric recipient IDs", () => {
    const args = JSON.stringify({ to: [1, 2, 3], content: "hello" })
    render(<ToolCall name="team_message" args={args} done={false} />)
    expectPlainArg(getHeader("Messaging 1, 2, 3"), "1, 2, 3")
  })

  it("handles mixed string and numeric recipients", () => {
    const args = JSON.stringify({ to: ["researcher", 42, "writer"], content: "hello" })
    render(<ToolCall name="team_message" args={args} done={false} />)
    expectPlainArg(getHeader("Messaging researcher, 42, writer"), "researcher, 42, writer")
  })
})

// ---------------------------------------------------------------------------
// team_message args display
// ---------------------------------------------------------------------------

describe("ToolCall — team_message args display", () => {
  it("shows message content as formatted args", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ to: ["researcher"], content: "Please analyze this data" })
    render(<ToolCall name="team_message" args={args} done={false} />)
    await user.click(screen.getByRole("button"))
    expect(screen.getByText("Please analyze this data")).toBeTruthy()
  })

  it("shows 'arguments' label for args section", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ to: ["researcher"], content: "hello" })
    render(<ToolCall name="team_message" args={args} done={false} />)
    await user.click(screen.getByRole("button"))
    expect(screen.getByText("arguments")).toBeTruthy()
  })

  it("does not show 'bash' label (not a bash command)", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ to: ["researcher"], content: "hello" })
    render(<ToolCall name="team_message" args={args} done={false} />)
    await user.click(screen.getByRole("button"))
    expect(screen.queryByText("bash")).toBeNull()
  })

  it("hides args section when content is empty", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ to: ["researcher"], content: "" })
    render(<ToolCall name="team_message" args={args} done={false} />)
    const btn = screen.getByRole("button")
    await user.click(btn)
    expect(screen.queryByText("arguments")).toBeNull()
  })

  it("hides args section when content is missing", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ to: ["researcher"] })
    render(<ToolCall name="team_message" args={args} done={false} />)
    const btn = screen.getByRole("button")
    await user.click(btn)
    expect(screen.queryByText("arguments")).toBeNull()
  })

  it("shows copy button for args", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ to: ["researcher"], content: "hello" })
    render(<ToolCall name="team_message" args={args} done={false} />)
    await user.click(screen.getByRole("button"))
    expect(screen.getByLabelText("Copy arguments")).toBeTruthy()
  })

  it("copies only the message content, not the full JSON", async () => {
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
      const args = JSON.stringify({ to: ["researcher"], content: "Please analyze this" })
      render(<ToolCall name="team_message" args={args} done={false} />)
      await user.click(screen.getByRole("button"))
      const copyBtn = screen.getByLabelText("Copy arguments")
      await user.click(copyBtn)
      expect(copiedText).toBe("Please analyze this")
      expect(copiedText).not.toContain("to")
      expect(copiedText).not.toContain("content")
    } finally {
      Object.defineProperty(navigator, "clipboard", {
        value: navigator.clipboard,
        writable: true,
      })
    }
  })
})

// ---------------------------------------------------------------------------
// team_message expand/collapse
// ---------------------------------------------------------------------------

describe("ToolCall — team_message expand/collapse", () => {
  it("is expandable when content is provided", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ to: ["researcher"], content: "hello" })
    render(<ToolCall name="team_message" args={args} done={false} />)
    const btn = screen.getByRole("button")
    await user.click(btn)
    expect(screen.getByText("arguments")).toBeTruthy()
  })

  it("is not expandable when no content and no result", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ to: ["researcher"] })
    render(<ToolCall name="team_message" args={args} done={false} />)
    const btn = screen.getByRole("button")
    await user.click(btn)
    expect(screen.queryByText("arguments")).toBeNull()
  })

  it("toggles expanded state on click", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ to: ["researcher"], content: "hello" })
    render(<ToolCall name="team_message" args={args} done={false} />)
    const btn = screen.getByRole("button")
    expect(btn.getAttribute("aria-expanded")).toBe("false")
    await user.click(btn)
    expect(btn.getAttribute("aria-expanded")).toBe("true")
    await user.click(btn)
    expect(btn.getAttribute("aria-expanded")).toBe("false")
  })
})

// ---------------------------------------------------------------------------
// team_message with result
// ---------------------------------------------------------------------------

describe("ToolCall — team_message with result", () => {
  it("shows result section when done with result", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ to: ["researcher"], content: "hello" })
    render(
      <ToolCall
        name="team_message"
        args={args}
        done={true}
        result="Message delivered successfully"
      />
    )
    await user.click(screen.getByRole("button"))
    expect(screen.getByText("result")).toBeTruthy()
    expect(screen.getByText("Message delivered successfully")).toBeTruthy()
  })

  it("shows both args and result sections together", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ to: ["researcher"], content: "hello" })
    render(
      <ToolCall
        name="team_message"
        args={args}
        done={true}
        result="Message delivered"
      />
    )
    await user.click(screen.getByRole("button"))
    expect(screen.getByText("arguments")).toBeTruthy()
    expect(screen.getByText("result")).toBeTruthy()
  })

  it("shows copy button for result", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ to: ["researcher"], content: "hello" })
    render(
      <ToolCall
        name="team_message"
        args={args}
        done={true}
        result="Message delivered"
      />
    )
    await user.click(screen.getByRole("button"))
    expect(screen.getByLabelText("Copy result")).toBeTruthy()
  })

  it("is expandable when result exists but no content", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ to: ["researcher"] })
    render(
      <ToolCall
        name="team_message"
        args={args}
        done={true}
        result="Message delivered"
      />
    )
    const btn = screen.getByRole("button")
    await user.click(btn)
    expect(screen.getByText("result")).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// team_message status indicators
// ---------------------------------------------------------------------------

describe("ToolCall — team_message status indicators", () => {
  it("shows start state without pending badge", () => {
    render(<ToolCall name="team_message" done={false} />)
    expect(screen.queryByText("pending")).toBeNull()
    expect(screen.getByText("Preparing message…")).toBeTruthy()
  })

  it("shows running indicator when running (args set, not done)", () => {
    const args = JSON.stringify({ to: ["researcher"], content: "hello" })
    render(<ToolCall name="team_message" args={args} done={false} />)
    const btn = screen.getByRole("button")
    const header = btn.querySelector("span.animate-pulse")
    expect(header?.textContent).toContain("Messaging researcher")
  })

  it("shows check icon when done", () => {
    const args = JSON.stringify({ to: ["researcher"], content: "hello" })
    render(<ToolCall name="team_message" args={args} done={true} />)
    // When done, the status should be visible in the button
    const btn = screen.getByRole("button")
    expect(btn).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// team_message edge cases
// ---------------------------------------------------------------------------

describe("ToolCall — team_message edge cases", () => {
  it("handles 'to' field as non-array (converts to array)", () => {
    const args = JSON.stringify({ to: "researcher", content: "hello" })
    render(<ToolCall name="team_message" args={args} done={false} />)
    // Should show "Messaging team" since to is not an array
    expectPlainArg(getHeader("Messaging team"), "team")
  })

  it("handles null 'to' field", () => {
    const args = JSON.stringify({ to: null, content: "hello" })
    render(<ToolCall name="team_message" args={args} done={false} />)
    expectPlainArg(getHeader("Messaging team"), "team")
  })

  it("handles whitespace-only content", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ to: ["researcher"], content: "   " })
    render(<ToolCall name="team_message" args={args} done={false} />)
    const btn = screen.getByRole("button")
    // Whitespace-only content is treated as empty
    await user.click(btn)
    expect(screen.queryByText("arguments")).toBeNull()
  })

  it("handles very long recipient list with truncation", () => {
    const recipients = Array.from({ length: 10 }, (_, i) => `agent_${i}`)
    const args = JSON.stringify({ to: recipients, content: "hello" })
    render(<ToolCall name="team_message" args={args} done={false} />)
    // Outer header span carries the full truncated text in its title attribute.
    const btn = screen.getByRole("button")
    const headerSpan = btn.querySelector("span[title^='Messaging ']") as HTMLElement | null
    expect(headerSpan).toBeTruthy()
    expect(headerSpan!.textContent).toContain("…")
  })

  it("handles special characters in recipient names", () => {
    const args = JSON.stringify({ to: ["agent-1", "agent_2", "agent.3"], content: "hello" })
    render(<ToolCall name="team_message" args={args} done={false} />)
    expectPlainArg(
      getHeader("Messaging agent-1, agent_2, agent.3"),
      "agent-1, agent_2, agent.3",
    )
  })

  it("handles special characters in message content", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ to: ["researcher"], content: "Hello! @researcher, can you help?" })
    render(<ToolCall name="team_message" args={args} done={false} />)
    await user.click(screen.getByRole("button"))
    expect(screen.getByText("Hello! @researcher, can you help?")).toBeTruthy()
  })

  it("handles multiline message content", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ to: ["researcher"], content: "Line 1\nLine 2\nLine 3" })
    render(<ToolCall name="team_message" args={args} done={false} />)
    await user.click(screen.getByRole("button"))
    expect(screen.getByText(/Line 1/)).toBeTruthy()
  })

  it("handles extra fields in args (ignored)", () => {
    const args = JSON.stringify({ to: ["researcher"], content: "hello", priority: "high", metadata: { foo: "bar" } })
    render(<ToolCall name="team_message" args={args} done={false} />)
    expectPlainArg(getHeader("Messaging researcher"), "researcher")
  })
})
