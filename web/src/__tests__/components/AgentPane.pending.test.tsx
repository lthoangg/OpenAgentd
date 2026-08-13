import { describe, it, expect, afterEach, mock } from "bun:test"
import { render, screen, cleanup } from "@testing-library/react"
import { AgentPane } from "@/components/AgentPane"
import type { AgentStream } from "@/stores/useTeamStore"
import type { ContentBlock } from "@/api/types"

afterEach(cleanup)

// Mock lucide-react icons to avoid SVG issues in Happy DOM
mock.module("lucide-react", () => new Proxy({}, { get: () => () => null }))

// ── helpers ──────────────────────────────────────────────────────────────────

function makeTextBlock(id: string, content: string): ContentBlock {
  return { id, type: "text", content }
}

function makeUserBlock(id: string, content: string, extra?: Record<string, unknown>): ContentBlock {
  return { id, type: "user", content, extra }
}

function makeThinkingBlock(id: string, content: string): ContentBlock {
  return { id, type: "thinking", content }
}

function makeStream(overrides: Partial<AgentStream> = {}): AgentStream {
  return {
    blocks: [],
    currentBlocks: [],
    currentText: "",
    currentThinking: "",
    status: "idle",
    usage: {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cachedTokens: 0,
    },
    model: null,
    lastError: null,
    ...overrides,
  }
}

function renderPanel(stream: AgentStream) {
  return render(<AgentPane name="researcher" stream={stream} isLead={false} />)
}

// ── tests ────────────────────────────────────────────────────────────────────

describe("AgentPane — pending dots indicator", () => {
  it("shows 3 bounce dots when status=idle but currentBlocks has a user block (isPending)", () => {
    const stream = makeStream({
      status: "idle",
      currentBlocks: [makeUserBlock("u1", "Hello")],
    })
    const { container } = renderPanel(stream)
    const dots = container.querySelectorAll(".animate-bounce")
    expect(dots.length).toBe(3)
  })

  it("shows 3 bounce dots when status=working and currentBlocks has only user blocks", () => {
    const stream = makeStream({
      status: "working",
      currentBlocks: [makeUserBlock("u1", "Hello")],
    })
    const { container } = renderPanel(stream)
    const dots = container.querySelectorAll(".animate-bounce")
    expect(dots.length).toBe(3)
  })

  it("does not show bounce dots when status=idle and currentBlocks is empty", () => {
    const stream = makeStream({
      status: "idle",
      currentBlocks: [],
    })
    const { container } = renderPanel(stream)
    const dots = container.querySelectorAll(".animate-bounce")
    expect(dots.length).toBe(0)
  })

  it("does not show bounce dots when status=working and currentBlocks has a text block", () => {
    const stream = makeStream({
      status: "working",
      currentBlocks: [makeTextBlock("b1", "Response text")],
    })
    const { container } = renderPanel(stream)
    const dots = container.querySelectorAll(".animate-bounce")
    expect(dots.length).toBe(0)
  })

  it("does not show bounce dots when status=working with mixed blocks including text", () => {
    const stream = makeStream({
      status: "working",
      currentBlocks: [
        makeUserBlock("u1", "Hello"),
        makeTextBlock("b1", "Response"),
      ],
    })
    const { container } = renderPanel(stream)
    const dots = container.querySelectorAll(".animate-bounce")
    expect(dots.length).toBe(0)
  })

  it("does not show bounce dots when status=working with thinking block only", () => {
    const stream = makeStream({
      status: "working",
      currentBlocks: [makeThinkingBlock("t1", "Thinking...")],
    })
    const { container } = renderPanel(stream)
    const dots = container.querySelectorAll(".animate-bounce")
    expect(dots.length).toBe(0)
  })

  it("does not show bounce dots when status=working with user and thinking blocks", () => {
    const stream = makeStream({
      status: "working",
      currentBlocks: [
        makeUserBlock("u1", "Hello"),
        makeThinkingBlock("t1", "Thinking..."),
      ],
    })
    const { container } = renderPanel(stream)
    const dots = container.querySelectorAll(".animate-bounce")
    expect(dots.length).toBe(0)
  })

  it("does not show 'Working…' text anywhere", () => {
    const stream = makeStream({
      status: "working",
      currentBlocks: [makeUserBlock("u1", "Hello")],
    })
    renderPanel(stream)
    const workingText = screen.queryByText(/Working/)
    expect(workingText).toBeNull()
  })

  it("renders an empty body with no bounce dots when idle with no blocks", () => {
    // The cockpit redesign dropped the 'Waiting…' placeholder copy in
    // favour of a quiet empty pane until the agent emits its first
    // block. This test pins the new contract: the pane mounts cleanly
    // (header + agent name still render, asserted in other cases),
    // there are no bounce dots, and no error surface.
    const stream = makeStream({
      status: "idle",
      currentBlocks: [],
    })
    const { container } = renderPanel(stream)
    expect(container.querySelectorAll(".animate-bounce").length).toBe(0)
    expect(screen.queryByText(/error/i)).toBeNull()
  })

  it("shows agent name in header", () => {
    const stream = makeStream()
    renderPanel(stream)
    const nameEl = screen.getByText("researcher")
    expect(nameEl).toBeTruthy()
  })

  it("does not show bounce dots when status=error", () => {
    const stream = makeStream({
      status: "error",
      currentBlocks: [makeUserBlock("u1", "Hello")],
      lastError: "Something went wrong",
    })
    const { container } = renderPanel(stream)
    const dots = container.querySelectorAll(".animate-bounce")
    expect(dots.length).toBe(0)
  })

  it("shows error message when status=error", () => {
    const stream = makeStream({
      status: "error",
      currentBlocks: [],
      lastError: "API timeout",
    })
    const { container } = renderPanel(stream)
    // Error message appears in the error box at the bottom
    const errorBox = container.querySelector("div[class*='bg-(--color-error-subtle)']")
    expect(errorBox).toBeTruthy()
    expect(errorBox?.textContent).toContain("API timeout")
  })

  it("shows bounce dots when status=idle with user block even if there are finalized blocks", () => {
    const stream = makeStream({
      status: "idle",
      blocks: [makeTextBlock("b1", "Previous response")],
      currentBlocks: [makeUserBlock("u1", "New question")],
    })
    const { container } = renderPanel(stream)
    const dots = container.querySelectorAll(".animate-bounce")
    expect(dots.length).toBe(3)
  })

  it("does not show bounce dots when an idle member has only an inbox message", () => {
    const stream = makeStream({
      status: "idle",
      currentBlocks: [makeUserBlock("u1", "Peer handoff", { from_agent: "lead" })],
    })
    const { container } = renderPanel(stream)
    const dots = container.querySelectorAll(".animate-bounce")
    expect(dots.length).toBe(0)
  })

  it("shows bounce dots while a working member has only an inbox message", () => {
    const stream = makeStream({
      status: "working",
      currentBlocks: [makeUserBlock("u1", "Peer handoff", { from_agent: "lead" })],
    })
    const { container } = renderPanel(stream)
    const dots = container.querySelectorAll(".animate-bounce")
    expect(dots.length).toBe(3)
  })

  // Regression: a whitespace-only thinking/text chunk (e.g. a provider's
  // blank reasoning-section separator, or the very first delta before real
  // content arrives) renders no visible output, but previously still
  // flipped `currentBlocks.every(b => b.type === 'user')` to false and hid
  // the dots — leaving a blank pane with neither dots nor content.
  it("shows bounce dots when the only non-user block is a whitespace-only thinking chunk", () => {
    const stream = makeStream({
      status: "working",
      currentBlocks: [makeUserBlock("u1", "Hi"), makeThinkingBlock("t1", "\n\n")],
    })
    const { container } = renderPanel(stream)
    const dots = container.querySelectorAll(".animate-bounce")
    expect(dots.length).toBe(3)
  })

  it("shows bounce dots when the only non-user block is a whitespace-only text chunk", () => {
    const stream = makeStream({
      status: "working",
      currentBlocks: [makeUserBlock("u1", "Hi"), makeTextBlock("b1", "   ")],
    })
    const { container } = renderPanel(stream)
    const dots = container.querySelectorAll(".animate-bounce")
    expect(dots.length).toBe(3)
  })

  it("shows bounce dots when status=working before the next block arrives", () => {
    const stream = makeStream({
      status: "working",
      blocks: [makeTextBlock("b1", "Previous response")],
      currentBlocks: [],
    })
    const { container } = renderPanel(stream)
    const dots = container.querySelectorAll(".animate-bounce")
    expect(dots.length).toBe(3)
  })
})
