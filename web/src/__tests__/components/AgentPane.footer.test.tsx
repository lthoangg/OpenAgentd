import { describe, it, expect, afterEach, mock } from "bun:test"
import { render, screen, cleanup } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { AgentPane } from "@/components/AgentPane"
import type { AgentStream } from "@/stores/useTeamStore"
import type { ContentBlock } from "@/api/types"

afterEach(cleanup)

// Mock lucide-react icons to avoid SVG issues in Happy DOM
mock.module("lucide-react", () => new Proxy({}, { get: () => () => null }))

// ── helpers ──────────────────────────────────────────────────────────────────

function makeTextBlock(id: string, content: string, timestamp?: Date): ContentBlock {
  return { id, type: "text", content, timestamp }
}

function makeUserBlock(id: string, content: string): ContentBlock {
  return { id, type: "user", content }
}

function makeThinkingBlock(id: string, content: string): ContentBlock {
  return { id, type: "thinking", content }
}

function makeToolBlock(id: string, toolName: string, timestamp?: Date): ContentBlock {
  return { id, type: "tool", content: "", toolName, toolDone: true, timestamp }
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
    _completionBase: 0,
    model: null,
    lastError: null,
    ...overrides,
  }
}

function renderPanel(stream: AgentStream) {
  return render(<AgentPane name="researcher" stream={stream} isLead={false} />)
}

// ── tests ────────────────────────────────────────────────────────────────────

describe("AgentPane — AssistantFooter", () => {
  describe("footer visibility", () => {
    it("does not render footer when status=working even with text blocks", () => {
      const stream = makeStream({
        status: "working",
        blocks: [makeTextBlock("b1", "Hello world")],
      })
      const { container } = renderPanel(stream)
      const footer = container.querySelector(".mt-0\\.5.flex.items-center.gap-1")
      expect(footer).toBeNull()
    })

    it("does not render footer when all blocks are user-type", () => {
      const stream = makeStream({
        status: "idle",
        blocks: [makeUserBlock("u1", "Hello"), makeUserBlock("u2", "World")],
      })
      const { container } = renderPanel(stream)
      const footer = container.querySelector(".mt-0\\.5.flex.items-center.gap-1")
      expect(footer).toBeNull()
    })

    it("does not render footer when blocks is empty", () => {
      const stream = makeStream({
        status: "idle",
        blocks: [],
        currentBlocks: [],
      })
      const { container } = renderPanel(stream)
      const footer = container.querySelector(".mt-0\\.5.flex.items-center.gap-1")
      expect(footer).toBeNull()
    })

    it("does not render footer when there is no text content and no timestamp", () => {
      const stream = makeStream({
        status: "idle",
        blocks: [
          makeThinkingBlock("t1", "Thinking..."),
          makeToolBlock("tool1", "read"),
        ],
      })
      const { container } = renderPanel(stream)
      const footer = container.querySelector(".mt-0\\.5.flex.items-center.gap-1")
      expect(footer).toBeNull()
    })
  })

  describe("copy button", () => {
    it("renders copy button when there is text content", () => {
      const stream = makeStream({
        status: "idle",
        blocks: [makeTextBlock("b1", "Hello world")],
      })
      renderPanel(stream)
      const copyBtn = screen.queryByRole("button", { name: /copy response/i })
      expect(copyBtn).toBeTruthy()
    })

    it("does not render copy button when there is no text content", () => {
      const stream = makeStream({
        status: "idle",
        blocks: [makeThinkingBlock("t1", "Thinking...")],
      })
      renderPanel(stream)
      const copyBtn = screen.queryByRole("button", { name: /copy response/i })
      expect(copyBtn).toBeNull()
    })

    it("copy button has correct aria-label", () => {
      const stream = makeStream({
        status: "idle",
        blocks: [makeTextBlock("b1", "Hello world")],
      })
      renderPanel(stream)
      const copyBtn = screen.getByRole("button", { name: /copy response/i })
      expect(copyBtn.getAttribute("aria-label")).toBe("Copy response")
    })

    it("copy button has correct title attribute", () => {
      const stream = makeStream({
        status: "idle",
        blocks: [makeTextBlock("b1", "Hello world")],
      })
      renderPanel(stream)
      const copyBtn = screen.getByRole("button", { name: /copy response/i })
      expect(copyBtn.getAttribute("title")).toBe("Copy")
    })
  })

  describe("copy functionality", () => {
    it("calls navigator.clipboard.writeText when copy button is clicked", async () => {
      const user = userEvent.setup()
      const writeText = mock(async () => {})
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText },
        configurable: true,
      })

      const stream = makeStream({
        status: "idle",
        blocks: [makeTextBlock("b1", "Hello world")],
      })
      renderPanel(stream)

      const copyBtn = screen.getByRole("button", { name: /copy response/i })
      await user.click(copyBtn)

      expect(writeText).toHaveBeenCalledOnce()
      expect(writeText).toHaveBeenCalledWith("Hello world")
    })

    it("copies text from multiple text blocks joined with newlines", async () => {
      const user = userEvent.setup()
      const writeText = mock(async () => {})
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText },
        configurable: true,
      })

      const stream = makeStream({
        status: "idle",
        blocks: [
          makeUserBlock("u1", "Question"),
          makeTextBlock("b1", "First response"),
          makeTextBlock("b2", "Second response"),
        ],
      })
      renderPanel(stream)

      const copyBtn = screen.getByRole("button", { name: /copy response/i })
      await user.click(copyBtn)

      expect(writeText).toHaveBeenCalledWith("First response\n\nSecond response")
    })

    it("each turn's copy button copies only that turn's text", async () => {
      // Me with per-turn footers, every assistant turn renders its own copy
      // button that scopes to its own text — first turn copies "Old response",
      // second turn copies "New response".
      const user = userEvent.setup()
      const writeText = mock(async () => {})
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText },
        configurable: true,
      })

      const stream = makeStream({
        status: "idle",
        blocks: [
          makeTextBlock("b1", "Old response"),
          makeUserBlock("u1", "New question"),
          makeTextBlock("b2", "New response"),
        ],
      })
      renderPanel(stream)

      const copyBtns = screen.getAllByRole("button", { name: /copy response/i })
      expect(copyBtns).toHaveLength(2)

      await user.click(copyBtns[0])
      expect(writeText).toHaveBeenLastCalledWith("Old response")

      await user.click(copyBtns[1])
      expect(writeText).toHaveBeenLastCalledWith("New response")
    })

    it("strips sleep sentinels from copied text", async () => {
      const user = userEvent.setup()
      const writeText = mock(async () => {})
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText },
        configurable: true,
      })

      const stream = makeStream({
        status: "idle",
        blocks: [
          makeUserBlock("u1", "Question"),
          makeTextBlock("b1", "Response<sleep>"),
        ],
      })
      renderPanel(stream)

      const copyBtn = screen.getByRole("button", { name: /copy response/i })
      await user.click(copyBtn)

      expect(writeText).toHaveBeenCalledWith("Response")
    })
  })

  describe("timestamp rendering", () => {
    it("renders timestamp when last non-user block has a timestamp", () => {
      const date = new Date(2024, 0, 15, 14, 30, 0)
      const stream = makeStream({
        status: "idle",
        blocks: [makeTextBlock("b1", "Hello", date)],
      })
      const { container } = renderPanel(stream)
      const footer = container.querySelector(".mt-0\\.5.flex.items-center.gap-1")
      expect(footer).toBeTruthy()
      const timeEl = footer?.querySelector("span")
      expect(timeEl?.textContent).toMatch(/\d+:\d+/)
    })

    it("uses timestamp from last non-user block even if earlier blocks have timestamps", () => {
      const date1 = new Date(2024, 0, 15, 10, 0, 0)
      const date2 = new Date(2024, 0, 15, 14, 30, 0)
      const stream = makeStream({
        status: "idle",
        blocks: [
          makeTextBlock("b1", "First", date1),
          makeThinkingBlock("t1", "Thinking"),
          makeTextBlock("b2", "Second", date2),
        ],
      })
      const { container } = renderPanel(stream)
      const footer = container.querySelector(".mt-0\\.5.flex.items-center.gap-1")
      expect(footer).toBeTruthy()
      const timeEl = footer?.querySelector("span")
      expect(timeEl?.textContent).toMatch(/\d+:\d+/)
    })

    it("does not render timestamp when no block has a timestamp", () => {
      const stream = makeStream({
        status: "idle",
        blocks: [makeTextBlock("b1", "Hello")],
      })
      const { container } = renderPanel(stream)
      const copyBtn = screen.getByRole("button", { name: /copy response/i })
      expect(copyBtn).toBeTruthy()
      const footer = container.querySelector(".mt-0\\.5.flex.items-center.gap-1")
      const timeSpan = footer?.querySelector("span")
      expect(timeSpan).toBeNull()
    })

    it("renders timestamp from tool block if it's the last non-user block", () => {
      const date = new Date(2024, 0, 15, 14, 30, 0)
      const stream = makeStream({
        status: "idle",
        blocks: [
          makeUserBlock("u1", "Question"),
          makeToolBlock("tool1", "read", date),
        ],
      })
      const { container } = renderPanel(stream)
      const footer = container.querySelector(".mt-0\\.5.flex.items-center.gap-1")
      expect(footer).toBeTruthy()
      const timeEl = footer?.querySelector("span")
      expect(timeEl?.textContent).toMatch(/\d+:\d+/)
    })
  })

  describe("footer with mixed content", () => {
    it("renders footer with both copy button and timestamp", () => {
      const date = new Date(2024, 0, 15, 14, 30, 0)
      const stream = makeStream({
        status: "idle",
        blocks: [
          makeUserBlock("u1", "Question"),
          makeTextBlock("b1", "Response", date),
        ],
      })
      const { container } = renderPanel(stream)
      const footer = container.querySelector(".mt-0\\.5.flex.items-center.gap-1")
      expect(footer).toBeTruthy()
      const copyBtn = screen.getByRole("button", { name: /copy response/i })
      expect(copyBtn).toBeTruthy()
      const timeEl = footer?.querySelector("span")
      expect(timeEl?.textContent).toMatch(/\d+:\d+/)
    })

    it("renders footer with only timestamp when there is no text content", () => {
      const date = new Date(2024, 0, 15, 14, 30, 0)
      const stream = makeStream({
        status: "idle",
        blocks: [
          makeUserBlock("u1", "Question"),
          makeToolBlock("tool1", "read", date),
        ],
      })
      const { container } = renderPanel(stream)
      const copyBtn = screen.queryByRole("button", { name: /copy response/i })
      expect(copyBtn).toBeNull()
      const footer = container.querySelector(".mt-0\\.5.flex.items-center.gap-1")
      expect(footer).toBeTruthy()
      const timeEl = footer?.querySelector("span")
      expect(timeEl?.textContent).toMatch(/\d+:\d+/)
    })
  })

  describe("footer with currentBlocks", () => {
    it("does not render footer when status=working even with text in currentBlocks", () => {
      const stream = makeStream({
        status: "working",
        blocks: [],
        currentBlocks: [makeTextBlock("b1", "Streaming response")],
      })
      const { container } = renderPanel(stream)
      const footer = container.querySelector(".mt-0\\.5.flex.items-center.gap-1")
      expect(footer).toBeNull()
    })

    it("renders footer when status=idle even if turn lives in currentBlocks (not yet flushed)", () => {
      // Me with the per-turn footer model, the agent being idle (status=idle)
      // means the turn is finished — footer should appear regardless of whether
      // the blocks live in `blocks` or `currentBlocks`.
      const date = new Date(2024, 0, 15, 14, 30, 0)
      const stream = makeStream({
        status: "idle",
        blocks: [],
        currentBlocks: [makeTextBlock("b1", "Response", date)],
      })
      renderPanel(stream)
      const copyBtn = screen.getByRole("button", { name: /copy response/i })
      expect(copyBtn).toBeTruthy()
    })

    it("renders footer for previous turn even when next user message is optimistically in currentBlocks", () => {
      // Me regression test for the bug: completing an assistant turn, then sending
      // a new user message must NOT hide the prior turn's copy/time footer.
      const date = new Date(2024, 0, 15, 14, 30, 0)
      const stream = makeStream({
        status: "working",
        blocks: [
          makeUserBlock("u1", "First question"),
          makeTextBlock("b1", "First response", date),
        ],
        currentBlocks: [makeUserBlock("u2", "Second question")],
      })
      renderPanel(stream)
      const copyBtn = screen.getByRole("button", { name: /copy response/i })
      expect(copyBtn).toBeTruthy()
    })

    it("renders footer when status=idle and currentBlocks is empty (turn fully flushed)", () => {
      const date = new Date(2024, 0, 15, 14, 30, 0)
      const stream = makeStream({
        status: "idle",
        blocks: [makeUserBlock("u1", "Question"), makeTextBlock("b1", "Response", date)],
        currentBlocks: [],
      })
      renderPanel(stream)
      const copyBtn = screen.getByRole("button", { name: /copy response/i })
      expect(copyBtn).toBeTruthy()
      const timeEl = screen.queryByText(/\d+:\d+/)
      expect(timeEl).toBeTruthy()
    })
  })

  describe("footer with error status", () => {
    it("renders footer when status=error and there are non-user blocks", () => {
      const stream = makeStream({
        status: "error",
        blocks: [makeTextBlock("b1", "Hello world")],
        lastError: "Something went wrong",
      })
      const { container } = renderPanel(stream)
      const footer = container.querySelector(".mt-0\\.5.flex.items-center.gap-1")
      expect(footer).toBeTruthy()
    })

    it("does not render footer when status=error and all blocks are user-type", () => {
      const stream = makeStream({
        status: "error",
        blocks: [makeUserBlock("u1", "Hello")],
        lastError: "Something went wrong",
      })
      const { container } = renderPanel(stream)
      const footer = container.querySelector(".mt-0\\.5.flex.items-center.gap-1")
      expect(footer).toBeNull()
    })
  })
})
