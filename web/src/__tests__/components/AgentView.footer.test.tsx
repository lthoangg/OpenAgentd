import { describe, it, expect, afterEach, mock } from "bun:test"
import { fireEvent, render, screen, cleanup } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { AgentView } from "@/components/AgentView"
import { useTeamStore } from "@/stores/useTeamStore"
import type { ContentBlock } from "@/api/types"

afterEach(() => {
  cleanup()
  useTeamStore.setState({ sessionId: null, _pendingMessages: [] })
})

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

function makeToolBlock(id: string, toolName: string): ContentBlock {
  return { id, type: "tool", content: "", toolName, toolDone: true }
}

function makeCompactionBlock(id: string, content: string): ContentBlock {
  return { id, type: "compaction", content }
}

function renderStream(props: Partial<React.ComponentProps<typeof AgentView>> = {}) {
  return render(
    <AgentView
      blocks={props.blocks ?? []}
      currentBlocks={props.currentBlocks ?? []}
      isWorking={props.isWorking ?? false}
      onContinue={props.onContinue}
    />
  )
}

// ── tests ────────────────────────────────────────────────────────────────────

describe("AgentView — message windowing", () => {
  it("renders recent turns first and lets users reveal older turns", async () => {
    const user = userEvent.setup()
    const blocks = Array.from({ length: 85 }, (_, i) => makeUserBlock(`u${i}`, `message ${i}`))

    renderStream({ blocks })

    expect(screen.queryByText("message 0")).toBeNull()
    expect(screen.getByText("message 84")).toBeTruthy()
    const showEarlier = screen.getByRole("button", { name: /show 5 earlier turns/i })
    expect(showEarlier.textContent).toContain("5 hidden")

    await user.click(showEarlier)

    expect(screen.getByText("message 0")).toBeTruthy()
    expect(screen.queryByRole("button", { name: /earlier turns/i })).toBeNull()
  })

  it("reveals older local turns when scrolling to the top", () => {
    const blocks = Array.from({ length: 85 }, (_, i) => makeUserBlock(`u${i}`, `message ${i}`))
    const { container } = renderStream({ blocks })

    expect(screen.queryByText("message 0")).toBeNull()

    const scroller = container.querySelector(".overflow-y-auto") as HTMLDivElement
    Object.defineProperty(scroller, "scrollTop", { configurable: true, value: 0, writable: true })
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 2000 })
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 600 })

    fireEvent.scroll(scroller)

    expect(screen.getByText("message 0")).toBeTruthy()
  })

  it("renders a large thread window without mounting older hidden turns", () => {
    const blocks = Array.from({ length: 160 }, (_, i) => [
      makeUserBlock(`u${i}`, `question ${i}`),
      makeTextBlock(`a${i}`, `answer ${i}`),
    ]).flat()

    renderStream({ blocks })

    expect(screen.queryByText("question 0")).toBeNull()
    expect(screen.queryByText("answer 0")).toBeNull()
    expect(screen.getByText("question 159")).toBeTruthy()
    expect(screen.getByText("answer 159")).toBeTruthy()
    expect(screen.getByRole("button", { name: /show 80 earlier turns/i })).toBeTruthy()
  })
})

describe("AgentView — AssistantFooter", () => {
  it("renders queued messages below the streaming assistant turn", () => {
    useTeamStore.setState({
      sessionId: "session-a",
      _pendingMessages: [
        { id: "q1", sessionId: "session-a", content: "queued after response" },
      ],
    })

    renderStream({
      blocks: [makeUserBlock("u1", "start")],
      currentBlocks: [makeTextBlock("a1", "streaming response")],
      isWorking: true,
    })

    const response = screen.getByText("streaming response")
    const queued = screen.getByText("queued after response")
    expect(response.compareDocumentPosition(queued) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByRole("button", { name: "Edit queued message" })).toBeTruthy()
  })

  it("collapses long queued messages", async () => {
    const user = userEvent.setup()
    const longQueuedMessage = Array.from({ length: 11 }, (_, i) => `queued line ${i + 1}`).join("\n")
    useTeamStore.setState({
      sessionId: "session-a",
      _pendingMessages: [
        { id: "q1", sessionId: "session-a", content: longQueuedMessage },
      ],
    })

    renderStream({
      blocks: [makeUserBlock("u1", "start")],
      currentBlocks: [makeTextBlock("a1", "streaming response")],
      isWorking: true,
    })

    expect(screen.getByText(/queued line 10/)).toBeTruthy()
    expect(screen.queryByText(/queued line 11/)).toBeNull()

    const collapseButton = screen.getByRole("button", { name: "Expand" })
    expect(collapseButton.getAttribute("aria-expanded")).toBe("false")

    await user.click(collapseButton)

    expect(screen.getByText(/queued line 11/)).toBeTruthy()
    expect(collapseButton.getAttribute("aria-expanded")).toBe("true")
  })

  describe("footer visibility", () => {
    it("does not render footer when isWorking=true even with text blocks", () => {
      const { container } = renderStream({
        blocks: [makeTextBlock("b1", "Hello world")],
        currentBlocks: [],
        isWorking: true,
      })
      const footer = container.querySelector(".mt-1.flex.items-center.gap-1\\.5")
      expect(footer).toBeNull()
    })

    it("does not render footer when all blocks are user-type", () => {
      const { container } = renderStream({
        blocks: [makeUserBlock("u1", "Hello"), makeUserBlock("u2", "World")],
        currentBlocks: [],
        isWorking: false,
      })
      const footer = container.querySelector(".mt-1.flex.items-center.gap-1\\.5")
      expect(footer).toBeNull()
    })

    it("does not render footer when there are no blocks at all", () => {
      const { container } = renderStream({
        blocks: [],
        currentBlocks: [],
        isWorking: false,
      })
      const footer = container.querySelector(".mt-1.flex.items-center.gap-1\\.5")
      expect(footer).toBeNull()
    })

    it("renders the empty state when only compaction markers are visible", () => {
      renderStream({
        blocks: [makeCompactionBlock("c1", "Older context compacted")],
        currentBlocks: [],
        isWorking: false,
      })

      expect(screen.getByText("what’s on your mind?")).toBeTruthy()
      expect(screen.getByText("Older context compacted")).toBeTruthy()
    })

    it("does not render footer when there is no text content and no timestamp", () => {
      const { container } = renderStream({
        blocks: [
          makeThinkingBlock("t1", "Thinking..."),
          makeToolBlock("tool1", "read"),
        ],
        currentBlocks: [],
        isWorking: false,
      })
      const footer = container.querySelector(".mt-1.flex.items-center.gap-1\\.5")
      expect(footer).toBeNull()
    })
  })

  describe("copy button", () => {
    it("renders copy button when there is text content", () => {
      renderStream({
        blocks: [makeTextBlock("b1", "Hello world")],
        currentBlocks: [],
        isWorking: false,
      })
      const copyBtn = screen.queryByRole("button", { name: /copy response/i })
      expect(copyBtn).toBeTruthy()
    })

    it("does not render copy button when there is no text content", () => {
      renderStream({
        blocks: [makeThinkingBlock("t1", "Thinking...")],
        currentBlocks: [],
        isWorking: false,
      })
      const copyBtn = screen.queryByRole("button", { name: /copy response/i })
      expect(copyBtn).toBeNull()
    })

    it("copy button has correct aria-label", () => {
      renderStream({
        blocks: [makeTextBlock("b1", "Hello world")],
        currentBlocks: [],
        isWorking: false,
      })
      const copyBtn = screen.getByRole("button", { name: /copy response/i })
      expect(copyBtn.getAttribute("aria-label")).toBe("Copy response")
    })

    it("copy button has correct title attribute", () => {
      renderStream({
        blocks: [makeTextBlock("b1", "Hello world")],
        currentBlocks: [],
        isWorking: false,
      })
      const copyBtn = screen.getByRole("button", { name: /copy response/i })
      expect(copyBtn.getAttribute("title")).toBe("Copy")
    })
  })

  describe("continue button", () => {
    it("renders continue button for the trailing assistant turn", () => {
      renderStream({
        blocks: [makeTextBlock("b1", "Hello world")],
        currentBlocks: [],
        isWorking: false,
        onContinue: () => {},
      })

      expect(screen.queryByRole("button", { name: /continue response/i })).toBeTruthy()
    })

    it("calls onContinue when clicked", async () => {
      const user = userEvent.setup()
      const onContinue = mock(() => {})

      renderStream({
        blocks: [makeTextBlock("b1", "Hello world")],
        currentBlocks: [],
        isWorking: false,
        onContinue,
      })

      await user.click(screen.getByRole("button", { name: /continue response/i }))

      expect(onContinue).toHaveBeenCalledOnce()
    })

    it("does not render continue button while the turn is streaming", () => {
      renderStream({
        blocks: [makeTextBlock("b1", "Hello world")],
        currentBlocks: [],
        isWorking: true,
        onContinue: () => {},
      })

      expect(screen.queryByRole("button", { name: /continue response/i })).toBeNull()
    })

    it("renders continue button without copy for a tool-only turn", () => {
      renderStream({
        blocks: [makeToolBlock("tool1", "shell")],
        currentBlocks: [],
        isWorking: false,
        onContinue: () => {},
      })

      expect(screen.queryByRole("button", { name: /copy response/i })).toBeNull()
      expect(screen.queryByRole("button", { name: /continue response/i })).toBeTruthy()
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

      renderStream({
        blocks: [makeTextBlock("b1", "Hello world")],
        currentBlocks: [],
        isWorking: false,
      })

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

      renderStream({
        blocks: [
          makeUserBlock("u1", "Question"),
          makeTextBlock("b1", "First response"),
          makeTextBlock("b2", "Second response"),
        ],
        currentBlocks: [],
        isWorking: false,
      })

      const copyBtn = screen.getByRole("button", { name: /copy response/i })
      await user.click(copyBtn)

      expect(writeText).toHaveBeenCalledWith("First response\n\nSecond response")
    })

    it("each turn's copy button copies only that turn's text", async () => {
      // Me with per-turn footers, every assistant turn renders its own copy
      // button scoped to its own text — first turn copies "Old response",
      // second turn copies "New response".
      const user = userEvent.setup()
      const writeText = mock(async () => {})
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText },
        configurable: true,
      })

      renderStream({
        blocks: [
          makeTextBlock("b1", "Old response"),
          makeUserBlock("u1", "New question"),
          makeTextBlock("b2", "New response"),
        ],
        currentBlocks: [],
        isWorking: false,
      })

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

      renderStream({
        blocks: [
          makeUserBlock("u1", "Question"),
          makeTextBlock("b1", "Response<sleep>"),
        ],
        currentBlocks: [],
        isWorking: false,
      })

      const copyBtn = screen.getByRole("button", { name: /copy response/i })
      await user.click(copyBtn)

      expect(writeText).toHaveBeenCalledWith("Response")
    })
  })

  describe("timestamp rendering", () => {
    it("renders timestamp when last non-user block has a timestamp", () => {
      const date = new Date(2024, 0, 15, 14, 30, 0)
      const { container } = renderStream({
        blocks: [makeTextBlock("b1", "Hello", date)],
        currentBlocks: [],
        isWorking: false,
      })
      // Look for the timestamp in the footer specifically
      const footer = container.querySelector(".mt-1.flex.items-center.gap-1\\.5")
      expect(footer).toBeTruthy()
      const timeEl = footer?.querySelector("span")
      expect(timeEl?.textContent).toMatch(/\d+:\d+/)
    })

    it("uses timestamp from last non-user block even if earlier blocks have timestamps", () => {
      const date1 = new Date(2024, 0, 15, 10, 0, 0)
      const date2 = new Date(2024, 0, 15, 14, 30, 0)
      const { container } = renderStream({
        blocks: [
          makeTextBlock("b1", "First", date1),
          makeThinkingBlock("t1", "Thinking"),
          makeTextBlock("b2", "Second", date2),
        ],
        currentBlocks: [],
        isWorking: false,
      })
      // Should render the time from the last block (b2)
      const footer = container.querySelector(".mt-1.flex.items-center.gap-1\\.5")
      expect(footer).toBeTruthy()
      const timeEl = footer?.querySelector("span")
      expect(timeEl?.textContent).toMatch(/\d+:\d+/)
    })

    it("does not render timestamp when no block has a timestamp", () => {
      const { container } = renderStream({
        blocks: [makeTextBlock("b1", "Hello")],
        currentBlocks: [],
        isWorking: false,
      })
      // Should only have the copy button, no time
      const copyBtn = screen.getByRole("button", { name: /copy response/i })
      expect(copyBtn).toBeTruthy()
      // Check that there's no footer with timestamp
      const footer = container.querySelector(".mt-1.flex.items-center.gap-1\\.5")
      const timeSpan = footer?.querySelector("span")
      expect(timeSpan).toBeNull()
    })

    it("renders timestamp from thinking block if it's the last non-user block", () => {
      const { container } = renderStream({
        blocks: [
          makeUserBlock("u1", "Question"),
          makeThinkingBlock("t1", "Thinking", ),
          makeTextBlock("b1", "Response"),
        ],
        currentBlocks: [],
        isWorking: false,
      })
      // The last non-user block is the text block, so it should have a timestamp
      // But since we didn't add one, there should be no timestamp rendered
      const footer = container.querySelector(".mt-1.flex.items-center.gap-1\\.5")
      const timeSpan = footer?.querySelector("span")
      expect(timeSpan).toBeNull()
    })

    it("renders timestamp from tool block if it's the last non-user block", () => {
      const date = new Date(2024, 0, 15, 14, 30, 0)
      const toolBlock: ContentBlock = {
        id: "tool1",
        type: "tool",
        content: "",
        toolName: "read",
        toolDone: true,
        timestamp: date,
      }
      const { container } = renderStream({
        blocks: [
          makeUserBlock("u1", "Question"),
          toolBlock,
        ],
        currentBlocks: [],
        isWorking: false,
      })
      // Footer should render because there's a non-user block with timestamp
      const footer = container.querySelector(".mt-1.flex.items-center.gap-1\\.5")
      expect(footer).toBeTruthy()
      const timeEl = footer?.querySelector("span")
      expect(timeEl?.textContent).toMatch(/\d+:\d+/)
    })
  })

  describe("footer with mixed content", () => {
    it("renders footer with copy button, timestamp, model, and duration", () => {
      const date = new Date(2024, 0, 15, 14, 30, 0)
      const response = makeTextBlock("b1", "Response", date)
      response.extra = { model: "openrouter:anthropic/claude-sonnet-4.5" }
      response.responseDurationMs = 1234
      const { container } = renderStream({
        blocks: [
          makeUserBlock("u1", "Question"),
          response,
        ],
        currentBlocks: [],
        isWorking: false,
      })
      const footer = container.querySelector(".mt-1.flex.items-center.gap-1\\.5")
      expect(footer).toBeTruthy()
      const copyBtn = screen.getByRole("button", { name: /copy response/i })
      expect(copyBtn).toBeTruthy()
      const footerText = footer?.textContent ?? ""
      const modelIndex = footerText.indexOf("claude-sonnet-4.5")
      const timeMatch = footerText.match(/\d+:\d+/)
      const durationIndex = footerText.indexOf("1.2s")
      expect(modelIndex).toBeGreaterThanOrEqual(0)
      expect(timeMatch).not.toBeNull()
      expect(durationIndex).toBeGreaterThanOrEqual(0)
      expect(modelIndex).toBeLessThan(timeMatch?.index ?? -1)
      expect(timeMatch?.index ?? -1).toBeLessThan(durationIndex)
    })

    it("renders footer with only timestamp when there is no text content", () => {
      const date = new Date(2024, 0, 15, 14, 30, 0)
      const toolBlock: ContentBlock = {
        id: "tool1",
        type: "tool",
        content: "",
        toolName: "read",
        toolDone: true,
        timestamp: date,
      }
      const { container } = renderStream({
        blocks: [
          makeUserBlock("u1", "Question"),
          toolBlock,
        ],
        currentBlocks: [],
        isWorking: false,
      })
      const copyBtn = screen.queryByRole("button", { name: /copy response/i })
      expect(copyBtn).toBeNull()
      const footer = container.querySelector(".mt-1.flex.items-center.gap-1\\.5")
      expect(footer).toBeTruthy()
      const timeEl = footer?.querySelector("span")
      expect(timeEl?.textContent).toMatch(/\d+:\d+/)
    })
  })

  describe("footer with currentBlocks", () => {
    it("does not render footer when isWorking=true even with text in currentBlocks", () => {
      const { container } = renderStream({
        blocks: [],
        currentBlocks: [makeTextBlock("b1", "Streaming response")],
        isWorking: true,
      })
      const footer = container.querySelector(".mt-1.flex.items-center.gap-1\\.5")
      expect(footer).toBeNull()
    })

    it("renders footer when isWorking=false even if turn lives in currentBlocks (not yet flushed)", () => {
      // Me with the per-turn footer model, the agent being idle means the turn
      // is finished — footer shows regardless of whether the blocks live in
      // `blocks` or `currentBlocks`.
      const date = new Date(2024, 0, 15, 14, 30, 0)
      renderStream({
        blocks: [],
        currentBlocks: [makeTextBlock("b1", "Response", date)],
        isWorking: false,
      })
      const copyBtn = screen.getByRole("button", { name: /copy response/i })
      expect(copyBtn).toBeTruthy()
    })

    it("renders footer for previous turn even when next user message is optimistically in currentBlocks", () => {
      // Me regression test: a completed assistant turn must keep its copy/time
      // footer when the next user message starts a new turn (the optimistic
      // user bubble is pushed into `currentBlocks` while `isWorking` flips on).
      const date = new Date(2024, 0, 15, 14, 30, 0)
      renderStream({
        blocks: [
          makeUserBlock("u1", "First question"),
          makeTextBlock("b1", "First response", date),
        ],
        currentBlocks: [makeUserBlock("u2", "Second question")],
        isWorking: true,
      })
      const copyBtn = screen.getByRole("button", { name: /copy response/i })
      expect(copyBtn).toBeTruthy()
    })

    it("renders footer when isWorking=false and currentBlocks is empty (turn fully flushed)", () => {
      const date = new Date(2024, 0, 15, 14, 30, 0)
      const { container } = renderStream({
        blocks: [makeUserBlock("u1", "Question"), makeTextBlock("b1", "Response", date)],
        currentBlocks: [],
        isWorking: false,
      })
      const copyBtn = screen.getByRole("button", { name: /copy response/i })
      expect(copyBtn).toBeTruthy()
      const footer = container.querySelector(".mt-1.flex.items-center.gap-1\\.5")
      expect(footer).toBeTruthy()
      const timeEl = footer?.querySelector("span")
      expect(timeEl?.textContent).toMatch(/\d+:\d+/)
    })
  })
})
