import { describe, it, expect, afterEach, mock } from "bun:test"
import { fireEvent, render, screen, cleanup } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { AgentView } from "@/components/AgentView"
import { useAgentStore } from "@/stores/useAgentStore"
import { useDisplayPrefsStore } from "@/stores/useDisplayPrefsStore"
import type { ContentBlock } from "@/api/types"

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

    expect(screen.getByText("Looking around.")).toBeTruthy()
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

    expect(screen.getByRole("button", { name: /^Working · 1m 5s · Read/ })).toBeTruthy()
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
  it("renders queued messages below the streaming assistant turn", () => {
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

      expect(screen.getByText("what’s on your mind?")).toBeTruthy()
      expect(screen.getByRole("region", { name: "Session compacted" })).toBeTruthy()
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
      const copyBtn = screen.getByRole("button", { name: /copy response/i })
      await user.hover(copyBtn)
      expect((await screen.findByRole("tooltip")).textContent).toBe("Copy")
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
      const timeEl = Array.from(footer?.querySelectorAll("span") ?? []).find((el) =>
        /\d+:\d+/.test(el.textContent ?? ""),
      )
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
      const timeEl = Array.from(footer?.querySelectorAll("span") ?? []).find((el) =>
        /\d+:\d+/.test(el.textContent ?? ""),
      )
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
      const timeEl = Array.from(footer?.querySelectorAll("span") ?? []).find((el) =>
        /\d+:\d+/.test(el.textContent ?? ""),
      )
      expect(timeEl?.textContent).toMatch(/\d+:\d+/)
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
    const divider = screen.getByRole("region", { name: "Session compacted" })
    expect(copy.compareDocumentPosition(divider) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("keeps the reply's footer while the compaction runs", () => {
    renderStream({ blocks: [makeUserBlock("u1", "Fix it"), reply, forcedCompaction("compacting")], isWorking: true })

    expect(screen.getByRole("button", { name: /copy response/i })).toBeTruthy()
    expect(screen.getByRole("region", { name: "Session compacting" })).toBeTruthy()
  })

  it("keeps an auto-compaction inside its run, under the run's one footer", () => {
    renderStream({
      blocks: [makeUserBlock("u1", "Fix it"), makeTextBlock("a0", "Working on it."), makeCompactionBlock("c1", "Summary."), reply],
    })

    const copies = screen.getAllByRole("button", { name: /copy response/i })
    expect(copies).toHaveLength(1)
    const divider = screen.getByRole("region", { name: "Session compacted" })
    expect(divider.compareDocumentPosition(copies[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

describe("AgentView — footer model label", () => {
  function answer(id: string, model: string): ContentBlock {
    return { id, type: "text", content: `answer ${id}`, extra: { model } }
  }

  it("names the model on every answer", () => {
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

    const labels = [...container.querySelectorAll("[data-turn-model]")].map((el) => el.textContent)
    expect(labels).toEqual(["gpt-5", "gpt-5", "claude-opus-4"])
  })

  it("names the thinking level beside the model on every answer that ran with one", () => {
    const leveled = (id: string, model: string, level: string): ContentBlock => ({
      ...answer(id, model),
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
        answer("a4", "openai:gpt-5"),
      ],
      currentBlocks: [],
      isWorking: false,
    })

    const labels = [...container.querySelectorAll("[data-turn-model]")].map((el) => el.textContent)
    expect(labels).toEqual(["gpt-5 · high", "gpt-5 · high", "gpt-5 · low", "gpt-5"])
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
    expect(labels).toEqual(["gpt-5 · high", "claude-opus-4", "gpt-5 · low"])
  })
})
