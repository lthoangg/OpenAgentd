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

function getHeader(fullText: string): HTMLElement {
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
// agent_send header display
// ---------------------------------------------------------------------------

describe("ToolCall — agent_send header", () => {
  it("shows 'Messaging agent session-1' for target session", () => {
    const args = JSON.stringify({ session_id: "session-1", content: "hello" })
    render(<ToolCall name="agent_send" args={args} done={false} />)
    expectPlainArg(getHeader("Messaging agent session-1"), "session-1")
  })

  it("shows 'Messaging agent agent' when session_id is empty", () => {
    const args = JSON.stringify({ session_id: "", content: "hello" })
    render(<ToolCall name="agent_send" args={args} done={false} />)
    expectPlainArg(getHeader("Messaging agent agent"), "agent")
  })

  it("shows 'Messaging agent agent' when 'session_id' field is missing", () => {
    const args = JSON.stringify({ content: "hello" })
    render(<ToolCall name="agent_send" args={args} done={false} />)
    expectPlainArg(getHeader("Messaging agent agent"), "agent")
  })

  it("truncates session_id when exceeds 60 chars", () => {
    const longSessionId = "very_long_session_id_that_exceeds_sixty_characters_in_length_1234567890"
    const args = JSON.stringify({ session_id: longSessionId, content: "hello" })
    render(<ToolCall name="agent_send" args={args} done={false} />)
    const header = document.querySelector('[title^="Messaging agent "]') as HTMLElement | null
    expect(header).toBeTruthy()
    expect(header!.textContent).toContain("…")
  })

  it("renders the session_id argument in the header", () => {
    const args = JSON.stringify({ session_id: "agent-target", content: "hello" })
    render(<ToolCall name="agent_send" args={args} done={false} />)
    const header = getHeader("Messaging agent agent-target")
    expectPlainArg(header, "agent-target")
  })

  it("does not render raw tool name 'agent_send' when args provided", () => {
    const args = JSON.stringify({ session_id: "agent-target", content: "hello" })
    render(<ToolCall name="agent_send" args={args} done={false} />)
    expect(screen.queryByText("agent_send")).toBeNull()
  })

  it("shows friendly 'Preparing message…' header when args is undefined (pending state)", () => {
    render(<ToolCall name="agent_send" done={false} />)
    expect(screen.getByText("Preparing message…")).toBeTruthy()
    expect(screen.queryByText("agent_send")).toBeNull()
  })

  it("shows no pending badge when args is undefined", () => {
    render(<ToolCall name="agent_send" done={false} />)
    expect(screen.queryByText("pending")).toBeNull()
    expect(screen.getByText("Preparing message…")).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// agent_send args display
// ---------------------------------------------------------------------------

describe("ToolCall — agent_send args display", () => {
  it("shows message content as formatted args", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ session_id: "agent-target", content: "Please analyze this data" })
    render(<ToolCall name="agent_send" args={args} done={false} />)
    await user.click(screen.getByRole("button"))
    expect(screen.getByText("Please analyze this data")).toBeTruthy()
  })

  it("shows 'arguments' label for args section", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ session_id: "agent-target", content: "hello" })
    render(<ToolCall name="agent_send" args={args} done={false} />)
    await user.click(screen.getByRole("button"))
    expect(screen.getByText("arguments")).toBeTruthy()
  })

  it("does not show 'bash' label (not a bash command)", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ session_id: "agent-target", content: "hello" })
    render(<ToolCall name="agent_send" args={args} done={false} />)
    await user.click(screen.getByRole("button"))
    expect(screen.queryByText("bash")).toBeNull()
  })

  it("hides args section when content is empty", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ session_id: "agent-target", content: "" })
    render(<ToolCall name="agent_send" args={args} done={false} />)
    const btn = screen.getByRole("button")
    await user.click(btn)
    expect(screen.queryByText("arguments")).toBeNull()
  })

  it("hides args section when content is missing", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ session_id: "agent-target" })
    render(<ToolCall name="agent_send" args={args} done={false} />)
    const btn = screen.getByRole("button")
    await user.click(btn)
    expect(screen.queryByText("arguments")).toBeNull()
  })

  it("shows copy button for args", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ session_id: "agent-target", content: "hello" })
    render(<ToolCall name="agent_send" args={args} done={false} />)
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
      const args = JSON.stringify({ session_id: "agent-target", content: "Please analyze this" })
      render(<ToolCall name="agent_send" args={args} done={false} />)
      await user.click(screen.getByRole("button"))
      const copyBtn = screen.getByLabelText("Copy arguments")
      await user.click(copyBtn)
      expect(copiedText).toBe("Please analyze this")
      expect(copiedText).not.toContain("session_id")
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
// agent_send expand/collapse
// ---------------------------------------------------------------------------

describe("ToolCall — agent_send expand/collapse", () => {
  it("is expandable when content is provided", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ session_id: "agent-target", content: "hello" })
    render(<ToolCall name="agent_send" args={args} done={false} />)
    const btn = screen.getByRole("button")
    await user.click(btn)
    expect(screen.getByText("arguments")).toBeTruthy()
  })

  it("is not expandable when no content and no result", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ session_id: "agent-target" })
    render(<ToolCall name="agent_send" args={args} done={false} />)
    const btn = screen.getByRole("button")
    await user.click(btn)
    expect(screen.queryByText("arguments")).toBeNull()
  })

  it("toggles expanded state on click", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ session_id: "agent-target", content: "hello" })
    render(<ToolCall name="agent_send" args={args} done={false} />)
    const btn = screen.getByRole("button")
    expect(btn.getAttribute("aria-expanded")).toBe("false")
    await user.click(btn)
    expect(btn.getAttribute("aria-expanded")).toBe("true")
    await user.click(btn)
    expect(btn.getAttribute("aria-expanded")).toBe("false")
  })
})

// ---------------------------------------------------------------------------
// agent_send with result
// ---------------------------------------------------------------------------

describe("ToolCall — agent_send with result", () => {
  it("shows result section when done with result", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ session_id: "agent-target", content: "hello" })
    render(
      <ToolCall
        name="agent_send"
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
    const args = JSON.stringify({ session_id: "agent-target", content: "hello" })
    render(
      <ToolCall
        name="agent_send"
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
    const args = JSON.stringify({ session_id: "agent-target", content: "hello" })
    render(
      <ToolCall
        name="agent_send"
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
    const args = JSON.stringify({ session_id: "agent-target" })
    render(
      <ToolCall
        name="agent_send"
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
// agent_send status indicators
// ---------------------------------------------------------------------------

describe("ToolCall — agent_send status indicators", () => {
  it("shows start state without pending badge", () => {
    render(<ToolCall name="agent_send" done={false} />)
    expect(screen.queryByText("pending")).toBeNull()
    expect(screen.getByText("Preparing message…")).toBeTruthy()
  })

  it("shows running indicator when running (args set, not done)", () => {
    const args = JSON.stringify({ session_id: "agent-target", content: "hello" })
    render(<ToolCall name="agent_send" args={args} done={false} />)
    const btn = screen.getByRole("button")
    const header = btn.querySelector("span.animate-pulse")
    expect(header).toBeTruthy()
  })

  it("shows done indicator when done (not pulsing)", () => {
    const args = JSON.stringify({ session_id: "agent-target", content: "hello" })
    render(
      <ToolCall
        name="agent_send"
        args={args}
        done={true}
        result="Message delivered"
      />
    )
    const btn = screen.getByRole("button")
    const header = btn.querySelector("span.animate-pulse")
    expect(header).toBeNull()
  })
})
