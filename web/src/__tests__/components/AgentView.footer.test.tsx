import { describe, it, expect, afterEach, mock } from "bun:test"
import { fireEvent, render, screen, cleanup, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { AgentView } from "@/components/AgentView"
import { useAgentStore } from "@/stores/useAgentStore"
import { useDisplayPrefsStore } from "@/stores/useDisplayPrefsStore"
import type { ContentBlock } from "@/api/types"
import { TitleTooltipLayer } from '@/components/ui/title-tooltip'
import { formatFullDateTime, formatTime } from '@/utils/format'

afterEach(() => {
  cleanup()
  useAgentStore.setState({ sessionId: null, _pendingMessages: [] })
  useDisplayPrefsStore.setState({ transcriptStyle: "detailed" })
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
      onMentionFileOpen={props.onMentionFileOpen}
      jumpToLatestInComposer={props.jumpToLatestInComposer}
    />
  )
}

// ── tests ────────────────────────────────────────────────────────────────────

describe("AgentView — reader transcript", () => {
  const blocks = [
    makeUserBlock("u1", "Fix it"),
    makeThinkingBlock("t1", "Looking around."),
    { ...makeToolBlock("r1", "read"), toolArgs: '{"path":"src/a.ts"}', toolResult: "x" },
    makeTextBlock("a1", "Fixed."),
  ]

  it("folds a turn's work behind one row when reader mode is on", () => {
    useDisplayPrefsStore.setState({ transcriptStyle: "reader" })
    renderStream({ blocks })

    expect(screen.getByText("Fixed.")).toBeTruthy()
    expect(screen.queryByText("Looking around.")).toBeNull()
    expect(screen.getByRole("button", { name: /^1 read/ }).getAttribute("aria-expanded")).toBe("false")
  })

  it("shows every step in the default detailed transcript", () => {
    renderStream({ blocks })

    // The finished thought shows in full, with no fold row; nothing is grouped.
    expect(screen.getByText("Looking around.")).toBeTruthy()
    expect(screen.queryByRole("button", { name: /^Thought/ })).toBeNull()
    expect(screen.queryByRole("button", { name: /^1 read/ })).toBeNull()
  })

  it("times the running turn from the prompt that started it", () => {
    useDisplayPrefsStore.setState({ transcriptStyle: "reader" })
    renderStream({
      blocks: [{ ...makeUserBlock("u1", "Fix it"), timestamp: new Date(Date.now() - 65_000) }],
      currentBlocks: [
        makeThinkingBlock("t1", "Looking around."),
        { id: "r1", type: "tool", content: "", toolName: "read", toolArgs: '{"path":"src/a.ts"}', toolDone: false },
      ],
      isWorking: true,
    })

    expect(screen.getByRole("button", { name: /^Working · 1m 5s · read/ })).toBeTruthy()
  })

  describe("with a subagent report", () => {
    const delegated = [
      makeUserBlock("u1", "Find the bug"),
      makeToolBlock("d1", "delegate"),
      makeTextBlock("n1", "Waiting on the explorer."),
      { id: "r1", type: "user", content: "The bug is in a.ts.", extra: { from_agent: "explorer#1" } } as ContentBlock,
      makeTextBlock("a1", "Fixed the bug in a.ts."),
    ]

    it("folds the report into the turn's work, under one footer", async () => {
      const user = userEvent.setup()
      useDisplayPrefsStore.setState({ transcriptStyle: "reader" })
      renderStream({ blocks: delegated })

      expect(screen.getByText("Fixed the bug in a.ts.")).toBeTruthy()
      expect(screen.queryByText("The bug is in a.ts.")).toBeNull()
      expect(screen.queryByText("Waiting on the explorer.")).toBeNull()
      expect(screen.getAllByRole("button", { name: /copy response/i })).toHaveLength(1)

      await user.click(screen.getByRole("button", { name: /^1 delegation, 1 report/ }))

      expect(screen.getByText("The bug is in a.ts.")).toBeTruthy()
    })

    it("shows the report in the detailed transcript", () => {
      renderStream({ blocks: delegated })

      expect(screen.getByText("The bug is in a.ts.")).toBeTruthy()
    })

    it("names the report as the running step while the lead picks up after it", () => {
      useDisplayPrefsStore.setState({ transcriptStyle: "reader" })
      renderStream({ blocks: delegated.slice(0, 3), currentBlocks: [delegated[3]], isWorking: true })

      expect(screen.getByRole("button", { name: /^Working · .*Report from explorer#1/ })).toBeTruthy()
      expect(screen.queryByRole("status", { name: "Agent is preparing a response" })).toBeNull()
    })
  })
})

describe("AgentView — mentioned files", () => {
  it("hides mention-generated attachment cards", () => {
    renderStream({
      blocks: [{
        ...makeUserBlock("u1", "Use @Makefile#L4-L6"),
        attachments: [{
          filename: "generated.txt",
          original_name: "Makefile#L4-L6",
          category: "text",
          media_type: "text/plain",
          url: "/api/agent/session/uploads/generated.txt",
          source: "mention",
        }],
      }],
    })

    expect(screen.getByText("@Makefile#L4-L6")).toBeTruthy()
    expect(screen.queryByText("Makefile#L4-L6")).toBeNull()
  })

  it("shows explicit upload attachment cards using stored filename", () => {
    renderStream({
      blocks: [{
        ...makeUserBlock("u1", "Use attached notes"),
        attachments: [{
          filename: "generated.txt",
          original_name: "notes.txt",
          category: "text",
          media_type: "text/plain",
          url: "/api/agent/session/uploads/generated.txt",
        }],
      }],
    })

    expect(screen.getByText("generated.txt")).toBeTruthy()
    expect(screen.queryByText("notes.txt")).toBeNull()
  })

  it("opens a clicked file mention", async () => {
    const user = userEvent.setup()
    const onMentionFileOpen = mock(() => {})

    renderStream({
      blocks: [makeUserBlock("u1", "Please inspect @src/App.tsx before changing it")],
      onMentionFileOpen,
    })

    await user.click(screen.getByRole("button", { name: "@src/App.tsx" }))

    expect(onMentionFileOpen).toHaveBeenCalledWith("src/App.tsx")
  })

  it("hands a ranged mention over with its #L range", async () => {
    const user = userEvent.setup()
    const onMentionFileOpen = mock(() => {})

    renderStream({
      blocks: [makeUserBlock("u1", "Look at @src/App.tsx#L3-L9 first")],
      onMentionFileOpen,
    })

    await user.click(screen.getByRole("button", { name: "@src/App.tsx#L3-L9" }))

    expect(onMentionFileOpen).toHaveBeenCalledWith("src/App.tsx#L3-L9")
  })

  it("does not make folder mentions clickable", () => {
    renderStream({
      blocks: [makeUserBlock("u1", "Check @src/components/ first")],
      onMentionFileOpen: mock(() => {}),
    })

    expect(screen.queryByRole("button", { name: "@src/components/" })).toBeNull()
    expect(screen.getByText("@src/components/")).toBeTruthy()
  })
})

describe("AgentView — message windowing", () => {
  it("renders recent turns first, with no button for the older ones", () => {
    const blocks = Array.from({ length: 85 }, (_, i) => makeUserBlock(`u${i}`, `message ${i}`))

    renderStream({ blocks })

    expect(screen.queryByText("message 0")).toBeNull()
    expect(screen.getByText("message 84")).toBeTruthy()
    // Scrolling to the top reveals them (next test).
    expect(screen.queryByRole("button", { name: /earlier/i })).toBeNull()
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
    expect(screen.getByText("question 120")).toBeTruthy()
    expect(screen.queryByText("question 119")).toBeNull()
  })
})

describe("AgentView — AssistantFooter", () => {
  it("renders queued messages below the streaming assistant turn, faded", () => {
    useAgentStore.setState({
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
    expect((queued.parentElement as HTMLElement).className).toContain("opacity-75")
  })

  it("keeps the queue at the bottom of the transcript when a composer is up", () => {
    useAgentStore.setState({
      sessionId: "session-a",
      _pendingMessages: [
        { id: "q1", sessionId: "session-a", content: "queued after response" },
      ],
    })

    renderStream({
      blocks: [makeUserBlock("u1", "start")],
      currentBlocks: [makeTextBlock("a1", "streaming response")],
      isWorking: true,
      jumpToLatestInComposer: true,
    })

    const response = screen.getByText("streaming response")
    const queued = screen.getByText("queued after response")
    expect(response.compareDocumentPosition(queued) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByRole("button", { name: "Edit queued message" })).toBeTruthy()
  })

  it("puts the queue after the last turn and before the scroll anchor", () => {
    useAgentStore.setState({
      sessionId: "session-a",
      _pendingMessages: [
        { id: "q1", sessionId: "session-a", content: "queued after response" },
      ],
    })

    const { container } = renderStream({
      blocks: [makeUserBlock("u1", "start")],
      currentBlocks: [makeTextBlock("a1", "streaming response")],
      isWorking: true,
    })

    const anchor = container.querySelector("[data-chat-scroll-anchor]") as HTMLElement
    const queued = screen.getByText("queued after response")
    expect(queued.compareDocumentPosition(anchor) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByText("start").compareDocumentPosition(queued) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("collapses long queued messages", async () => {
    const user = userEvent.setup()
    const longQueuedMessage = Array.from({ length: 11 }, (_, i) => `queued line ${i + 1}`).join("\n")
    useAgentStore.setState({
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

      expect(screen.getByText("What's on your mind?")).toBeTruthy()
      expect(screen.getByRole("region", { name: "Earlier messages summarized" })).toBeTruthy()
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

    it("copy button shows a 'Copy' tooltip on hover", async () => {
      const user = userEvent.setup()
      renderStream({
        blocks: [makeTextBlock("b1", "Hello world")],
        currentBlocks: [],
        isWorking: false,
      })
      // The hint is a title, drawn by the app's title layer.
      render(<TitleTooltipLayer />)
      const copyBtn = screen.getByRole("button", { name: /copy response/i })
      await user.hover(copyBtn)
      expect((await screen.findByRole("tooltip")).textContent).toBe("Copy response")
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
    // A turn shows its time once, on the prompt's row; the answer's line keeps
    // the finish time in its details (the popover and the aria summary).
    it("leaves the finish time out of the footer's line; it is in the turn details", () => {
      const date = new Date(2024, 0, 15, 14, 30, 0)
      const block = makeTextBlock("b1", "Hello", date)
      block.responseDurationMs = 1234
      const { container } = renderStream({
        blocks: [block],
        currentBlocks: [],
        isWorking: false,
      })
      const footer = container.querySelector(".mt-1.flex.items-center.gap-1\\.5")
      expect(footer).toBeTruthy()
      const timeEl = Array.from(footer?.querySelectorAll("span") ?? []).find((el) =>
        /\d+:\d+/.test(el.textContent ?? ""),
      )
      expect(timeEl).toBeUndefined()
      expect(screen.getByRole("button", { name: /Turn details/ }).getAttribute("aria-label")).toContain(formatTime(date))
    })

    it("details the time of the last non-user block even if earlier blocks have timestamps", () => {
      const date1 = new Date(2024, 0, 15, 10, 0, 0)
      const date2 = new Date(2024, 0, 15, 14, 30, 0)
      const second = makeTextBlock("b2", "Second", date2)
      second.responseDurationMs = 1234
      renderStream({
        blocks: [
          makeTextBlock("b1", "First", date1),
          makeThinkingBlock("t1", "Thinking"),
          second,
        ],
        currentBlocks: [],
        isWorking: false,
      })
      // The time of the last block (b2) is the one in the details.
      fireEvent.click(screen.getByRole("button", { name: /Turn details/ }))
      expect(screen.getByText("Finished")).toBeTruthy()
      expect(screen.getByText(formatFullDateTime(date2))).toBeTruthy()
      expect(screen.queryByText(formatFullDateTime(date1))).toBeNull()
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
      const timeSpan = Array.from(footer?.querySelectorAll("span") ?? []).find((el) =>
        /\d+:\d+/.test(el.textContent ?? ""),
      )
      expect(timeSpan).toBeUndefined()
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
      const timeSpan = Array.from(footer?.querySelectorAll("span") ?? []).find((el) =>
        /\d+:\d+/.test(el.textContent ?? ""),
      )
      expect(timeSpan).toBeUndefined()
    })

    it("details the time of a tool block when it is the last non-user block", () => {
      const date = new Date(2024, 0, 15, 14, 30, 0)
      const toolBlock: ContentBlock = {
        id: "tool1",
        type: "tool",
        content: "",
        toolName: "read",
        toolDone: true,
        timestamp: date,
        responseDurationMs: 800,
      }
      const { container } = renderStream({
        blocks: [
          makeUserBlock("u1", "Question"),
          toolBlock,
        ],
        currentBlocks: [],
        isWorking: false,
      })
      // The footer renders for its duration; the time is in its details.
      const footer = container.querySelector(".mt-1.flex.items-center.gap-1\\.5")
      expect(footer).toBeTruthy()
      expect(screen.getByRole("button", { name: /Turn details/ }).getAttribute("aria-label")).toContain(formatTime(date))
    })
  })

  describe("footer with mixed content", () => {
    it("renders footer with copy button and duration, and no time or model: the prompt's row and the details have them", () => {
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
      expect(footerText).toContain("1.2 s")
      expect(footerText).not.toContain("claude-sonnet-4.5")
      expect(footerText).not.toMatch(/\d+:\d+/)
      // Both stay in the details.
      const label = screen.getByRole("button", { name: /Turn details/ }).getAttribute("aria-label") ?? ""
      expect(label).toContain("claude-sonnet-4.5")
      expect(label).toContain(formatTime(date))
      // The model is on the prompt's row, once.
      expect(container.querySelectorAll("[data-prompt-model]")).toHaveLength(1)
    })

    it("renders no footer for a turn with only a timestamp and no text content", () => {
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
      expect(container.querySelector(".mt-1.flex.items-center.gap-1\\.5")).toBeNull()
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
    })
  })

  describe("newline handling in response and thinking", () => {
    it("preserves paragraph separation in agent text response", async () => {
      const { container, findByText } = renderStream({
        blocks: [
          makeUserBlock("u1", "Question"),
          makeTextBlock("b1", "Response line one\n\n\n\nResponse line two"),
        ],
        currentBlocks: [],
        isWorking: false,
      })
      const p1 = await findByText("Response line one")
      const p2 = await findByText("Response line two")
      expect(p1.tagName).toBe("P")
      expect(p2.tagName).toBe("P")
      expect(container.textContent).toContain("Response line one")
      expect(container.textContent).toContain("Response line two")
    })

    it("preserves empty lines inside fenced code blocks in agent text response", async () => {
      const codeText = "```python\ndef foo():\n    x = 1\n\n    return x\n```"
      const { container } = renderStream({
        blocks: [
          makeUserBlock("u1", "Question"),
          makeTextBlock("b1", `Prose one\n\n${codeText}\n\nProse two`),
        ],
        currentBlocks: [],
        isWorking: false,
      })
      // Code block content should retain the blank line between `x = 1` and `return x`
      expect(container.textContent).toContain("x = 1\n\n    return x")
    })

    it("preserves double newlines in thinking block as-is", () => {
      const { container } = renderStream({
        blocks: [
          makeUserBlock("u1", "Question"),
          makeThinkingBlock("t1", "Reasoning line one\n\nReasoning line two"),
        ],
        currentBlocks: [],
        isWorking: false,
      })
      expect(container.textContent).toContain("Reasoning line one\n\nReasoning line two")
    })
  })
})

describe("AgentView — footer and a forced compaction", () => {
  const forcedCompaction = (state: "compacting" | "compacted"): ContentBlock => ({
    id: "c1", type: "compaction", content: "Summary.", extra: { state, forced: true },
  })
  const reply = makeTextBlock("a1", "Done.", new Date(2024, 0, 15, 14, 30, 0))

  it("keeps the reply's footer above a /compact divider", () => {
    renderStream({ blocks: [makeUserBlock("u1", "Fix it"), reply, forcedCompaction("compacted")] })

    const copy = screen.getByRole("button", { name: /copy response/i })
    const divider = screen.getByRole("region", { name: "Earlier messages summarized" })
    expect(copy.compareDocumentPosition(divider) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("keeps the reply's footer while the compaction runs", () => {
    renderStream({ blocks: [makeUserBlock("u1", "Fix it"), reply, forcedCompaction("compacting")], isWorking: true })

    expect(screen.getByRole("button", { name: /copy response/i })).toBeTruthy()
    expect(screen.getByRole("region", { name: "Summarizing earlier messages…" })).toBeTruthy()
  })

  it("keeps an auto-compaction inside its run, under the run's one footer", () => {
    renderStream({
      blocks: [makeUserBlock("u1", "Fix it"), makeTextBlock("a0", "Working on it."), makeCompactionBlock("c1", "Summary."), reply],
    })

    const copies = screen.getAllByRole("button", { name: /copy response/i })
    expect(copies).toHaveLength(1)
    const divider = screen.getByRole("region", { name: "Earlier messages summarized" })
    expect(divider.compareDocumentPosition(copies[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

describe("AgentView — footer model label", () => {
  function answer(id: string, model: string): ContentBlock {
    return { id, type: "text", content: `answer ${id}`, extra: { model } }
  }

  it("names each turn's model once, on its prompt, as provider:model", () => {
    const { container } = renderStream({
      blocks: [
        makeUserBlock("u1", "one"),
        answer("a1", "openai:gpt-5"),
        makeUserBlock("u2", "two"),
        answer("a2", "openai:gpt-5"),
        makeUserBlock("u3", "three"),
        answer("a3", "anthropic:claude-opus-4"),
      ],
      currentBlocks: [],
      isWorking: false,
    })

    const labels = [...container.querySelectorAll("[data-prompt-model]")].map((el) => el.textContent)
    expect(labels).toEqual(["openai:gpt-5", "openai:gpt-5", "anthropic:claude-opus-4"])
    expect(container.querySelector("[data-prompt-model]")?.className).toContain("font-mono")
    // The answer's line repeats none of them.
    expect(container.querySelector("[data-turn-model]")).toBeNull()
  })

  it("names the thinking level in each answer's turn details", () => {
    // A duration gives each answer a line, and so its details.
    const leveled = (id: string, model: string, level: string): ContentBlock => ({
      ...answer(id, model),
      responseDurationMs: 1000,
      extra: { model, thinking_level: level },
    })
    const { container } = renderStream({
      blocks: [
        makeUserBlock("u1", "one"),
        leveled("a1", "openai:gpt-5", "high"),
        makeUserBlock("u2", "two"),
        leveled("a2", "openai:gpt-5", "high"),
        makeUserBlock("u3", "three"),
        leveled("a3", "openai:gpt-5", "low"),
        makeUserBlock("u4", "four"),
        { ...answer("a4", "openai:gpt-5"), responseDurationMs: 1000 },
      ],
      currentBlocks: [],
      isWorking: false,
    })

    const labels = [...container.querySelectorAll("[data-prompt-model]")].map((el) => el.textContent)
    expect(labels).toEqual(["openai:gpt-5 · high", "openai:gpt-5 · high", "openai:gpt-5 · low", "openai:gpt-5"])
    const details = screen.getAllByRole("button", { name: /Turn details/ }).map((el) => el.getAttribute("aria-label"))
    expect(details.map((d) => /thinking (\w+)/.exec(d ?? "")?.[1] ?? null)).toEqual(["high", "high", "low", null])
  })

  it("names on each prompt the model and thinking level that answered it", () => {
    const { container } = renderStream({
      blocks: [
        // No model on the prompt itself: the answer's is used.
        makeUserBlock("u1", "one"),
        { id: "a1", type: "text", content: "answer a1", extra: { model: "openai:gpt-5", thinking_level: "high" } },
        // The answer's wins over what the prompt was sent with.
        { ...makeUserBlock("u2", "two"), extra: { model: "openai:gpt-4o" } },
        answer("a2", "anthropic:claude-opus-4"),
        // Not answered yet: the prompt's own model is used.
        { ...makeUserBlock("u3", "three"), extra: { model: "openai:gpt-5", thinking_level: "low" } },
      ],
      currentBlocks: [],
      isWorking: false,
    })

    const labels = [...container.querySelectorAll("[data-prompt-model]")].map((el) => el.textContent)
    expect(labels).toEqual(["openai:gpt-5 · high", "anthropic:claude-opus-4", "openai:gpt-5 · low"])
  })

  // The line had a native title (thinking level) around the model name's own
  // tooltip, so hovering it drew two tooltips over each other.
  it("shows one tooltip for a prompt's model and thinking level", async () => {
    const user = userEvent.setup()
    const { container } = renderStream({
      blocks: [{ ...makeUserBlock("u1", "one"), extra: { model: "openai:gpt-5", thinking_level: "high" } }],
      currentBlocks: [],
      isWorking: false,
    })
    render(<TitleTooltipLayer />)
    const line = container.querySelector("[data-prompt-model]") as HTMLElement
    // One title for the whole line; the model name inside draws none of its own.
    expect(line.getAttribute("title")).toBe("openai:gpt-5 · thinking high")
    expect(line.querySelector("[title]")).toBeNull()
    await user.hover(line.querySelector("[data-model-name]") as HTMLElement)
    const tips = await screen.findAllByRole("tooltip")
    expect(tips).toHaveLength(1)
    expect(tips[0]?.textContent).toBe("openai:gpt-5 · thinking high")
  })
})

// A turn is one prompt and its answer. The prompt's row (model, Edit, Copy,
// time) carries the model, the time and Edit; the answer's line carries
// Copy response, the duration and the cost, so none of the three shows twice.
describe("AgentView — a turn shows its model, time and Edit once", () => {
  const at = (hour: number, minute: number) => new Date(2024, 0, 15, hour, minute, 0)
  const turn = (n: number, promptAt: Date, answerAt: Date): ContentBlock[] => [
    { ...makeUserBlock(`u${n}`, `prompt ${n}`), timestamp: promptAt, extra: { model: "openai:gpt-5" } },
    {
      id: `a${n}`,
      type: "text",
      content: `answer ${n}`,
      timestamp: answerAt,
      responseDurationMs: 1500,
      usage: { outputTokens: 100, costUsd: 0.02 },
      extra: { model: "openai:gpt-5" },
    },
  ]

  it("puts the model, the time and Edit on the prompt's row only", () => {
    const { container } = renderStream({
      blocks: [...turn(1, at(10, 0), at(10, 5)), ...turn(2, at(11, 0), at(11, 5))],
      currentBlocks: [],
      isWorking: false,
    })

    // Model: one per turn, on the prompt; none on the answer's line.
    expect(container.querySelectorAll("[data-prompt-model]")).toHaveLength(2)
    expect(container.querySelectorAll("[data-turn-model]")).toHaveLength(0)
    expect((container.textContent ?? "").split("openai:gpt-5")).toHaveLength(3)
    // Time: the prompt's, once; the answer's finish time is in its details only.
    expect(screen.getAllByText(formatTime(at(10, 0)))).toHaveLength(1)
    expect(screen.getAllByText(formatTime(at(11, 0)))).toHaveLength(1)
    expect(screen.queryByText(formatTime(at(10, 5)))).toBeNull()
    expect(screen.queryByText(formatTime(at(11, 5)))).toBeNull()
    // Edit: one per turn, on the prompt, with one name.
    expect(screen.getAllByRole("button", { name: /Edit prompt/ })).toHaveLength(2)
    for (const group of screen.getAllByRole("group", { name: "Turn actions" })) {
      expect(within(group).queryByRole("button", { name: /Edit/ })).toBeNull()
    }
    // What the answer's line does keep: Copy, the duration and the cost.
    expect(screen.getAllByRole("button", { name: "Copy response" })).toHaveLength(2)
    expect(screen.getAllByText("1.5 s")).toHaveLength(2)
    expect(screen.getAllByText("$0.02")).toHaveLength(2)
  })

  it("names Copy by what it copies: the prompt under the prompt, the response under the answer", () => {
    renderStream({ blocks: turn(1, at(10, 0), at(10, 5)), currentBlocks: [], isWorking: false })

    expect(screen.getAllByRole("button", { name: "Copy prompt" })).toHaveLength(1)
    expect(screen.getAllByRole("button", { name: "Copy response" })).toHaveLength(1)
    expect(screen.queryByRole("button", { name: "Copy message" })).toBeNull()
  })
})
