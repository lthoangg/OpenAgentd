import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test"
import "@testing-library/jest-dom"
import { render, screen, cleanup } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { AgentView } from "@/components/AgentView"
import { AgentPane } from "@/components/AgentPane"
import { useTeamStore } from "@/stores/useTeamStore"
import type { ContentBlock } from "@/api/types"
import type { AgentStream } from "@/stores/useTeamStore/types"

// Seed sessionId so AgentView/AgentPane workspace links work
beforeEach(() => {
  useTeamStore.setState({ sessionId: "test-session-123" })
})

afterEach(cleanup)

// ─────────────────────────────────────────────────────────────────────────────
// AgentView UserBubble Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("AgentView — UserBubble collapse feature", () => {
  // ── Short message (≤10 lines) ────────────────────────────────────────────

  it("allows user bubbles to span full width on mobile and caps width from md up", () => {
    const blocks: ContentBlock[] = [
      {
        id: "1",
        type: "user",
        content: "Full-width mobile message",
      },
    ]

    const { container } = render(<AgentView blocks={blocks} currentBlocks={[]} isWorking={false} />)

    const wrapper = container.querySelector("div[class*='max-w-full'][class*='md:max-w-[78%]']")
    expect(wrapper).toBeTruthy()
  })

  it("allows long unbroken user text to wrap inside the bubble", () => {
    const blocks: ContentBlock[] = [
      {
        id: "1",
        type: "user",
        content: "https://example.com/" + "a".repeat(180),
      },
    ]

    const { container } = render(<AgentView blocks={blocks} currentBlocks={[]} isWorking={false} />)

    const bubble = container.querySelector("div[class*='min-w-0'][class*='max-w-full'][class*='overflow-hidden']")
    const text = container.querySelector("p[class*='overflow-wrap:anywhere']")
    expect(bubble).toBeTruthy()
    expect(text).toBeTruthy()
  })

  it("shows full content without collapse button for short message (≤10 lines)", () => {
    const shortContent = "line1\nline2\nline3\nline4\nline5"
    const blocks: ContentBlock[] = [
      {
        id: "1",
        type: "user",
        content: shortContent,
        timestamp: new Date(),
      },
    ]

    render(<AgentView blocks={blocks} currentBlocks={[]} isWorking={false} />)

    // Full content visible
    expect(screen.getByText(/line1/)).toBeTruthy()
    expect(screen.getByText(/line5/)).toBeTruthy()

    // No expand/collapse button
    const buttons = screen.queryAllByRole("button")
    // Filter out scroll-to-bottom button (if any)
    const collapseButtons = buttons.filter((btn) => btn.getAttribute("aria-expanded") !== null)
    expect(collapseButtons.length).toBe(0)
  })

  it("shows full content for exactly 10 lines without collapse button", () => {
    const tenLines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n")
    const blocks: ContentBlock[] = [
      {
        id: "1",
        type: "user",
        content: tenLines,
        timestamp: new Date(),
      },
    ]

    render(<AgentView blocks={blocks} currentBlocks={[]} isWorking={false} />)

    // All 10 lines visible
    expect(screen.getByText(/line1/)).toBeTruthy()
    expect(screen.getByText(/line10/)).toBeTruthy()

    // No collapse button
    const buttons = screen.queryAllByRole("button")
    const collapseButtons = buttons.filter((btn) => btn.getAttribute("aria-expanded") !== null)
    expect(collapseButtons.length).toBe(0)
  })

  // ── Long message (>10 lines) ─────────────────────────────────────────────

  it("shows only first 10 lines with collapse button for long message (>10 lines)", () => {
    const elevenLines = Array.from({ length: 11 }, (_, i) => `line${i + 1}`).join("\n")
    const blocks: ContentBlock[] = [
      {
        id: "1",
        type: "user",
        content: elevenLines,
        timestamp: new Date(),
      },
    ]

    render(<AgentView blocks={blocks} currentBlocks={[]} isWorking={false} />)

    // First 10 lines visible
    expect(screen.getByText(/line1/)).toBeTruthy()
    expect(screen.getByText(/line10/)).toBeTruthy()

    // Line 11 should NOT be visible (collapsed)
    expect(screen.queryByText(/line11/)).toBeNull()

    // Collapse button exists
    const buttons = screen.queryAllByRole("button")
    const collapseButtons = buttons.filter((btn) => btn.getAttribute("aria-expanded") !== null)
    expect(collapseButtons.length).toBe(1)
  })

  it("collapses long single-paragraph messages", async () => {
    const user = userEvent.setup()
    const longContent = `${"word ".repeat(160)}tail-marker`
    const blocks: ContentBlock[] = [
      {
        id: "1",
        type: "user",
        content: longContent,
        timestamp: new Date(),
      },
    ]

    render(<AgentView blocks={blocks} currentBlocks={[]} isWorking={false} />)

    expect(screen.queryByText(/tail-marker/)).toBeNull()

    const buttons = screen.queryAllByRole("button")
    const collapseBtn = buttons.find((btn) => btn.getAttribute("aria-expanded") !== null)
    expect(collapseBtn).toBeTruthy()

    await user.click(collapseBtn!)
    expect(screen.getByText(/tail-marker/)).toBeTruthy()
  })

  it("collapse button has aria-expanded=false initially", () => {
    const longContent = Array.from({ length: 15 }, (_, i) => `line${i + 1}`).join("\n")
    const blocks: ContentBlock[] = [
      {
        id: "1",
        type: "user",
        content: longContent,
        timestamp: new Date(),
      },
    ]

    render(<AgentView blocks={blocks} currentBlocks={[]} isWorking={false} />)

    const buttons = screen.queryAllByRole("button")
    const collapseBtn = buttons.find((btn) => btn.getAttribute("aria-expanded") !== null)
    expect(collapseBtn?.getAttribute("aria-expanded")).toBe("false")
  })

  it("collapse button has title='Expand' when collapsed", () => {
    const longContent = Array.from({ length: 15 }, (_, i) => `line${i + 1}`).join("\n")
    const blocks: ContentBlock[] = [
      {
        id: "1",
        type: "user",
        content: longContent,
        timestamp: new Date(),
      },
    ]

    render(<AgentView blocks={blocks} currentBlocks={[]} isWorking={false} />)

    const buttons = screen.queryAllByRole("button")
    const collapseBtn = buttons.find((btn) => btn.getAttribute("aria-expanded") !== null)
    expect(collapseBtn?.getAttribute("title")).toBe("Expand")
  })

  // ── Expand behavior ──────────────────────────────────────────────────────

  it("expands to show all content when collapse button is clicked", async () => {
    const user = userEvent.setup()
    const longContent = Array.from({ length: 15 }, (_, i) => `line${i + 1}`).join("\n")
    const blocks: ContentBlock[] = [
      {
        id: "1",
        type: "user",
        content: longContent,
        timestamp: new Date(),
      },
    ]

    render(<AgentView blocks={blocks} currentBlocks={[]} isWorking={false} />)

    // Initially, line 15 is not visible
    expect(screen.queryByText(/line15/)).toBeNull()

    // Click expand button
    const buttons = screen.queryAllByRole("button")
    const collapseBtn = buttons.find((btn) => btn.getAttribute("aria-expanded") !== null)
    await user.click(collapseBtn!)

    // Now line 15 is visible
    expect(screen.getByText(/line15/)).toBeTruthy()
  })

  it("changes aria-expanded to true when expanded", async () => {
    const user = userEvent.setup()
    const longContent = Array.from({ length: 15 }, (_, i) => `line${i + 1}`).join("\n")
    const blocks: ContentBlock[] = [
      {
        id: "1",
        type: "user",
        content: longContent,
        timestamp: new Date(),
      },
    ]

    render(<AgentView blocks={blocks} currentBlocks={[]} isWorking={false} />)

    const buttons = screen.queryAllByRole("button")
    const collapseBtn = buttons.find((btn) => btn.getAttribute("aria-expanded") !== null)

    await user.click(collapseBtn!)

    expect(collapseBtn?.getAttribute("aria-expanded")).toBe("true")
  })

  it("changes button title to 'Collapse' when expanded", async () => {
    const user = userEvent.setup()
    const longContent = Array.from({ length: 15 }, (_, i) => `line${i + 1}`).join("\n")
    const blocks: ContentBlock[] = [
      {
        id: "1",
        type: "user",
        content: longContent,
        timestamp: new Date(),
      },
    ]

    render(<AgentView blocks={blocks} currentBlocks={[]} isWorking={false} />)

    const buttons = screen.queryAllByRole("button")
    const collapseBtn = buttons.find((btn) => btn.getAttribute("aria-expanded") !== null)

    await user.click(collapseBtn!)

    expect(collapseBtn?.getAttribute("title")).toBe("Collapse")
  })

  // ── Collapse again ───────────────────────────────────────────────────────

  it("collapses again when button is clicked a second time", async () => {
    const user = userEvent.setup()
    const longContent = Array.from({ length: 15 }, (_, i) => `line${i + 1}`).join("\n")
    const blocks: ContentBlock[] = [
      {
        id: "1",
        type: "user",
        content: longContent,
        timestamp: new Date(),
      },
    ]

    render(<AgentView blocks={blocks} currentBlocks={[]} isWorking={false} />)

    const buttons = screen.queryAllByRole("button")
    const collapseBtn = buttons.find((btn) => btn.getAttribute("aria-expanded") !== null)

    // Expand
    await user.click(collapseBtn!)
    expect(screen.getByText(/line15/)).toBeTruthy()

    // Collapse
    await user.click(collapseBtn!)
    expect(screen.queryByText(/line15/)).toBeNull()
  })

  it("returns to aria-expanded=false when collapsed again", async () => {
    const user = userEvent.setup()
    const longContent = Array.from({ length: 15 }, (_, i) => `line${i + 1}`).join("\n")
    const blocks: ContentBlock[] = [
      {
        id: "1",
        type: "user",
        content: longContent,
        timestamp: new Date(),
      },
    ]

    render(<AgentView blocks={blocks} currentBlocks={[]} isWorking={false} />)

    const buttons = screen.queryAllByRole("button")
    const collapseBtn = buttons.find((btn) => btn.getAttribute("aria-expanded") !== null)

    await user.click(collapseBtn!) // expand
    await user.click(collapseBtn!) // collapse

    expect(collapseBtn?.getAttribute("aria-expanded")).toBe("false")
  })

  // ── Copy button behavior ─────────────────────────────────────────────────

  it("shows copy button when timestamp is provided", () => {
    const content = "Test message"
    const timestamp = new Date()
    const blocks: ContentBlock[] = [
      {
        id: "1",
        type: "user",
        content,
        timestamp,
      },
    ]

    render(<AgentView blocks={blocks} currentBlocks={[]} isWorking={false} />)

    // Copy button should be present (aria-label="Copy message")
    const copyBtn = screen.getByLabelText("Copy message")
    expect(copyBtn).toBeTruthy()
  })

  it("does not show copy button when timestamp is not provided", () => {
    const content = "Test message"
    const blocks: ContentBlock[] = [
      {
        id: "1",
        type: "user",
        content,
        // No timestamp
      },
    ]

    render(<AgentView blocks={blocks} currentBlocks={[]} isWorking={false} />)

    // Copy button should not be present
    const copyBtn = screen.queryByLabelText("Copy message")
    expect(copyBtn).toBeNull()
  })

  it("copies message content to clipboard when copy button is clicked", async () => {
    const user = userEvent.setup()
    const content = "Test message to copy"
    const timestamp = new Date()
    const blocks: ContentBlock[] = [
      {
        id: "1",
        type: "user",
        content,
        timestamp,
      },
    ]

    // Mock clipboard API using defineProperty
    const clipboardWriteText = mock(() => Promise.resolve())
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: clipboardWriteText },
      writable: true,
    })

    render(<AgentView blocks={blocks} currentBlocks={[]} isWorking={false} />)

    const copyBtn = screen.getByLabelText("Copy message")
    await user.click(copyBtn)

    expect(clipboardWriteText).toHaveBeenCalledWith(content)
  })

  // ── Timestamp visibility ─────────────────────────────────────────────────

  it("shows timestamp on mouse hover", async () => {
    const user = userEvent.setup()
    const content = "Test message"
    const timestamp = new Date("2026-04-29T12:00:00Z")
    const blocks: ContentBlock[] = [
      {
        id: "1",
        type: "user",
        content,
        timestamp,
      },
    ]

    const { container } = render(<AgentView blocks={blocks} currentBlocks={[]} isWorking={false} />)

    // Find the outer wrapper (group div)
    const groupDiv = container.querySelector("div[class*='group']")
    expect(groupDiv).toBeTruthy()

    // Find the timestamp span by looking for the time text
    const timeSpan = screen.getByText("12:00")
    expect(timeSpan.parentElement?.className).toContain("opacity-0")

    // Hover over the group
    await user.hover(groupDiv!)

    // Timestamp should now have opacity-100
    expect(timeSpan.parentElement?.className).toContain("opacity-100")
  })

  it("shows the model from user message metadata on hover", async () => {
    const user = userEvent.setup()
    const blocks: ContentBlock[] = [
      {
        id: "1",
        type: "user",
        content: "Test message",
        timestamp: new Date("2026-04-29T12:00:00Z"),
        extra: { model: "openrouter:anthropic/claude-sonnet-4.5" },
      },
    ]

    const { container } = render(<AgentView blocks={blocks} currentBlocks={[]} isWorking={false} />)
    const modelLabel = screen.getByText("claude-sonnet-4.5")
    expect(modelLabel.parentElement?.className).toContain("opacity-0")

    const groupDiv = container.querySelector("div[class*='group']")
    await user.hover(groupDiv!)

    expect(modelLabel.parentElement?.className).toContain("opacity-100")
    expect(modelLabel).toHaveAttribute("title", "openrouter:anthropic/claude-sonnet-4.5")
  })

  it("does not show a model label for legacy user messages without metadata", async () => {
    const user = userEvent.setup()
    const blocks: ContentBlock[] = [
      {
        id: "1",
        type: "user",
        content: "Legacy message",
        timestamp: new Date("2026-04-29T12:00:00Z"),
      },
    ]

    const { container } = render(<AgentView blocks={blocks} currentBlocks={[]} isWorking={false} />)
    const groupDiv = container.querySelector("div[class*='group']")
    await user.hover(groupDiv!)

    expect(screen.queryByText("gpt-4")).toBeNull()
    expect(screen.getByText("12:00")).toBeTruthy()
  })

  it("hides timestamp on mouse leave", async () => {
    const user = userEvent.setup()
    const content = "Test message"
    const timestamp = new Date("2026-04-29T12:00:00Z")
    const blocks: ContentBlock[] = [
      {
        id: "1",
        type: "user",
        content,
        timestamp,
      },
    ]

    const { container } = render(<AgentView blocks={blocks} currentBlocks={[]} isWorking={false} />)

    const groupDiv = container.querySelector("div[class*='group']")
    const timeSpan = screen.getByText("12:00")

    // Hover in
    await user.hover(groupDiv!)
    expect(timeSpan.parentElement?.className).toContain("opacity-100")

    // Hover out
    await user.unhover(groupDiv!)
    expect(timeSpan.parentElement?.className).toContain("opacity-0")
  })

  // ── Gradient fade overlay ────────────────────────────────────────────────

  it("shows gradient fade overlay when message is collapsed", () => {
    const longContent = Array.from({ length: 15 }, (_, i) => `line${i + 1}`).join("\n")
    const blocks: ContentBlock[] = [
      {
        id: "1",
        type: "user",
        content: longContent,
        timestamp: new Date(),
      },
    ]

    const { container } = render(<AgentView blocks={blocks} currentBlocks={[]} isWorking={false} />)

    // Find the gradient fade div (has pointer-events-none and inset-x-0 bottom-0)
    const gradientFade = container.querySelector("div[class*='pointer-events-none'][class*='inset-x-0'][class*='bottom-0']")
    expect(gradientFade).toBeTruthy()
  })

  it("hides gradient fade overlay when message is expanded", async () => {
    const user = userEvent.setup()
    const longContent = Array.from({ length: 15 }, (_, i) => `line${i + 1}`).join("\n")
    const blocks: ContentBlock[] = [
      {
        id: "1",
        type: "user",
        content: longContent,
        timestamp: new Date(),
      },
    ]

    const { container } = render(<AgentView blocks={blocks} currentBlocks={[]} isWorking={false} />)

    // Initially, gradient fade exists
    let gradientFade = container.querySelector("div[class*='pointer-events-none'][class*='inset-x-0'][class*='bottom-0']")
    expect(gradientFade).toBeTruthy()

    // Click expand
    const buttons = screen.queryAllByRole("button")
    const collapseBtn = buttons.find((btn) => btn.getAttribute("aria-expanded") !== null)
    await user.click(collapseBtn!)

    // Gradient fade should be gone (removed from DOM)
    gradientFade = container.querySelector("div[class*='pointer-events-none'][class*='inset-x-0'][class*='bottom-0']")
    expect(gradientFade).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AgentPane UserBubble Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("AgentPane — UserBubble collapse feature", () => {
  const createMockStream = (blocks: ContentBlock[]): AgentStream => ({
    blocks,
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
    model: "gpt-4",
    lastError: null,
  })

  // ── Short message (≤10 lines) ────────────────────────────────────────────

  it("shows full content without collapse button for short message in AgentPane", () => {
    const shortContent = "line1\nline2\nline3\nline4\nline5"
    const blocks: ContentBlock[] = [
      {
        id: "1",
        type: "user",
        content: shortContent,
        timestamp: new Date(),
      },
    ]

    render(
      <AgentPane
        name="TestAgent"
        stream={createMockStream(blocks)}
        isLead={true}
      />
    )

    // Full content visible
    expect(screen.getByText(/line1/)).toBeTruthy()
    expect(screen.getByText(/line5/)).toBeTruthy()

    // No expand/collapse button
    const buttons = screen.queryAllByRole("button")
    const collapseButtons = buttons.filter((btn) => btn.getAttribute("aria-expanded") !== null)
    expect(collapseButtons.length).toBe(0)
  })

  // ── Long message (>10 lines) ─────────────────────────────────────────────

  it("shows only first 10 lines with collapse button for long message in AgentPane", () => {
    const elevenLines = Array.from({ length: 11 }, (_, i) => `line${i + 1}`).join("\n")
    const blocks: ContentBlock[] = [
      {
        id: "1",
        type: "user",
        content: elevenLines,
        timestamp: new Date(),
      },
    ]

    render(
      <AgentPane
        name="TestAgent"
        stream={createMockStream(blocks)}
        isLead={true}
      />
    )

    // First 10 lines visible
    expect(screen.getByText(/line1/)).toBeTruthy()
    expect(screen.getByText(/line10/)).toBeTruthy()

    // Line 11 should NOT be visible (collapsed)
    expect(screen.queryByText(/line11/)).toBeNull()

    // Collapse button exists
    const buttons = screen.queryAllByRole("button")
    const collapseButtons = buttons.filter((btn) => btn.getAttribute("aria-expanded") !== null)
    expect(collapseButtons.length).toBe(1)
  })

  it("collapses long single-paragraph messages in AgentPane", async () => {
    const user = userEvent.setup()
    const longContent = `${"word ".repeat(160)}tail-marker`
    const blocks: ContentBlock[] = [
      {
        id: "1",
        type: "user",
        content: longContent,
        timestamp: new Date(),
      },
    ]

    render(
      <AgentPane
        name="TestAgent"
        stream={createMockStream(blocks)}
        isLead={true}
      />
    )

    expect(screen.queryByText(/tail-marker/)).toBeNull()

    const buttons = screen.queryAllByRole("button")
    const collapseBtn = buttons.find((btn) => btn.getAttribute("aria-expanded") !== null)
    expect(collapseBtn).toBeTruthy()

    await user.click(collapseBtn!)
    expect(screen.getByText(/tail-marker/)).toBeTruthy()
  })

  // ── Expand behavior ──────────────────────────────────────────────────────

  it("expands to show all content when collapse button is clicked in AgentPane", async () => {
    const user = userEvent.setup()
    const longContent = Array.from({ length: 15 }, (_, i) => `line${i + 1}`).join("\n")
    const blocks: ContentBlock[] = [
      {
        id: "1",
        type: "user",
        content: longContent,
        timestamp: new Date(),
      },
    ]

    render(
      <AgentPane
        name="TestAgent"
        stream={createMockStream(blocks)}
        isLead={true}
      />
    )

    // Initially, line 15 is not visible
    expect(screen.queryByText(/line15/)).toBeNull()

    // Click expand button
    const buttons = screen.queryAllByRole("button")
    const collapseBtn = buttons.find((btn) => btn.getAttribute("aria-expanded") !== null)
    await user.click(collapseBtn!)

    // Now line 15 is visible
    expect(screen.getByText(/line15/)).toBeTruthy()
  })

  // ── Collapse again ───────────────────────────────────────────────────────

  it("collapses again when button is clicked a second time in AgentPane", async () => {
    const user = userEvent.setup()
    const longContent = Array.from({ length: 15 }, (_, i) => `line${i + 1}`).join("\n")
    const blocks: ContentBlock[] = [
      {
        id: "1",
        type: "user",
        content: longContent,
        timestamp: new Date(),
      },
    ]

    render(
      <AgentPane
        name="TestAgent"
        stream={createMockStream(blocks)}
        isLead={true}
      />
    )

    const buttons = screen.queryAllByRole("button")
    const collapseBtn = buttons.find((btn) => btn.getAttribute("aria-expanded") !== null)

    // Expand
    await user.click(collapseBtn!)
    expect(screen.getByText(/line15/)).toBeTruthy()

    // Collapse
    await user.click(collapseBtn!)
    expect(screen.queryByText(/line15/)).toBeNull()
  })

  // ── Copy button behavior ─────────────────────────────────────────────────

  it("shows copy button when timestamp is provided in AgentPane", () => {
    const content = "Test message"
    const timestamp = new Date()
    const blocks: ContentBlock[] = [
      {
        id: "1",
        type: "user",
        content,
        timestamp,
      },
    ]

    render(
      <AgentPane
        name="TestAgent"
        stream={createMockStream(blocks)}
        isLead={true}
      />
    )

    const copyBtn = screen.getByLabelText("Copy message")
    expect(copyBtn).toBeTruthy()
  })

  it("does not show copy button when timestamp is not provided in AgentPane", () => {
    const content = "Test message"
    const blocks: ContentBlock[] = [
      {
        id: "1",
        type: "user",
        content,
        // No timestamp
      },
    ]

    render(
      <AgentPane
        name="TestAgent"
        stream={createMockStream(blocks)}
        isLead={true}
      />
    )

    const copyBtn = screen.queryByLabelText("Copy message")
    expect(copyBtn).toBeNull()
  })

  // ── Timestamp visibility ─────────────────────────────────────────────────

  it("shows MCP app artifact as sibling after completed tool block in AgentView", () => {
    const blocks: ContentBlock[] = [
      {
        id: "tool1",
        type: "tool",
        content: "",
        toolName: "mcp_design_excalidraw",
        toolDone: true,
        toolResult: "",
        extra: { mcp_app: { resourceUri: "ui://excalidraw/mcp-app.html", html: "<html><body>mcp app</body></html>" } },
      },
    ]

    const { container } = render(<AgentView blocks={blocks} currentBlocks={[]} isWorking={false} />)

    const toolRow = container.querySelector(".tool-row-enter")
    const iframe = container.querySelector("iframe")
    expect(toolRow).toBeTruthy()
    expect(iframe).toBeTruthy()
    expect(screen.getByText(/ui:\/\/excalidraw\/mcp-app\.html/)).toBeTruthy()
    expect(iframe?.closest(".mt-2")?.previousElementSibling).toBe(toolRow)
  })

  it("does not render MCP app artifact for incomplete tool blocks in AgentView", () => {
    const blocks: ContentBlock[] = [
      {
        id: "tool1",
        type: "tool",
        content: "",
        toolName: "mcp_design_excalidraw",
        toolDone: false,
        toolResult: "",
        extra: { mcp_app: { resourceUri: "ui://excalidraw/mcp-app.html", html: "<html><body>mcp app</body></html>" } },
      },
    ]

    render(<AgentView blocks={blocks} currentBlocks={[]} isWorking={false} />)
    expect(document.querySelector("iframe")).toBeNull()
  })

  it("only renders the latest completed MCP app artifact for the same resource URI in AgentView", () => {
    const blocks: ContentBlock[] = [
      {
        id: "tool1",
        type: "tool",
        content: "",
        toolName: "mcp_excalidraw_create_view",
        toolDone: true,
        toolResult: "first",
        extra: { mcp_app: { resourceUri: "ui://excalidraw/mcp-app.html", html: "<html><body>first app</body></html>" } },
      },
      {
        id: "tool2",
        type: "tool",
        content: "",
        toolName: "mcp_excalidraw_create_view",
        toolDone: true,
        toolResult: "second",
        extra: { mcp_app: { resourceUri: "ui://excalidraw/mcp-app.html", html: "<html><body>second app</body></html>" } },
      },
    ]

    const { container } = render(<AgentView blocks={blocks} currentBlocks={[]} isWorking={false} />)

    const toolRows = container.querySelectorAll(".tool-row-enter")
    const iframe = container.querySelector("iframe")
    expect(container.querySelectorAll("iframe")).toHaveLength(1)
    expect(iframe?.closest(".mt-2")?.previousElementSibling).toBe(toolRows[1])
    expect(screen.getByText(/ui:\/\/excalidraw\/mcp-app\.html/)).toBeTruthy()
  })

  it("keeps older MCP app artifacts visible until a newer same-resource tool block completes in AgentView", () => {
    const blocks: ContentBlock[] = [
      {
        id: "tool1",
        type: "tool",
        content: "",
        toolName: "mcp_excalidraw_create_view",
        toolDone: true,
        toolResult: "first",
        extra: { mcp_app: { resourceUri: "ui://excalidraw/mcp-app.html", html: "<html><body>first app</body></html>" } },
      },
      {
        id: "tool2",
        type: "tool",
        content: "",
        toolName: "mcp_excalidraw_create_view",
        toolDone: false,
        toolResult: "",
        extra: { mcp_app: { resourceUri: "ui://excalidraw/mcp-app.html", html: "<html><body>second app</body></html>" } },
      },
    ]

    const { container } = render(<AgentView blocks={blocks} currentBlocks={[]} isWorking={true} />)

    const toolRows = container.querySelectorAll(".tool-row-enter")
    const iframe = container.querySelector("iframe")
    expect(container.querySelectorAll("iframe")).toHaveLength(1)
    expect(iframe?.closest(".mt-2")?.previousElementSibling).toBe(toolRows[0])
    expect(screen.getByText(/ui:\/\/excalidraw\/mcp-app\.html/)).toBeTruthy()
  })

  it("renders multiple completed MCP app artifacts for different resource URIs in AgentView", () => {
    const blocks: ContentBlock[] = [
      {
        id: "tool1",
        type: "tool",
        content: "",
        toolName: "mcp_chart_create",
        toolDone: true,
        toolResult: "chart",
        extra: { mcp_app: { resourceUri: "ui://charts/app.html", html: "<html><body>chart app</body></html>" } },
      },
      {
        id: "tool2",
        type: "tool",
        content: "",
        toolName: "mcp_excalidraw_create_view",
        toolDone: true,
        toolResult: "diagram",
        extra: { mcp_app: { resourceUri: "ui://excalidraw/mcp-app.html", html: "<html><body>diagram app</body></html>" } },
      },
    ]

    const { container } = render(<AgentView blocks={blocks} currentBlocks={[]} isWorking={false} />)

    expect(container.querySelectorAll("iframe")).toHaveLength(2)
  })

  it("shows MCP app artifact as sibling after completed tool block in AgentPane", () => {
    const stream = createMockStream([
      {
        id: "tool1",
        type: "tool",
        content: "",
        toolName: "mcp_design_excalidraw",
        toolDone: true,
        toolResult: "",
        extra: { mcp_app: { resourceUri: "ui://excalidraw/mcp-app.html", html: "<html><body>mcp app</body></html>" } },
      } as ContentBlock,
    ])

    const { container } = render(<AgentPane name="researcher" stream={stream} isLead={false} />)

    const toolRow = container.querySelector(".tool-row-enter")
    const iframe = container.querySelector("iframe")
    expect(toolRow).toBeTruthy()
    expect(iframe).toBeTruthy()
    expect(screen.getByText(/ui:\/\/excalidraw\/mcp-app\.html/)).toBeTruthy()
    expect(iframe?.closest(".mt-2")?.previousElementSibling).toBe(toolRow)
  })

  it("does not render MCP app artifact for incomplete tool blocks in AgentPane", () => {
    const stream = createMockStream([
      {
        id: "tool1",
        type: "tool",
        content: "",
        toolName: "mcp_design_excalidraw",
        toolDone: false,
        toolResult: "",
        extra: { mcp_app: { resourceUri: "ui://excalidraw/mcp-app.html", html: "<html><body>mcp app</body></html>" } },
      } as ContentBlock,
    ])

    render(<AgentPane name="researcher" stream={stream} isLead={false} />)
    expect(document.querySelector("iframe")).toBeNull()
  })

  it("only renders the latest completed MCP app artifact for the same resource URI in AgentPane", () => {
    const stream = createMockStream([
      {
        id: "tool1",
        type: "tool",
        content: "",
        toolName: "mcp_excalidraw_create_view",
        toolDone: true,
        toolResult: "first",
        extra: { mcp_app: { resourceUri: "ui://excalidraw/mcp-app.html", html: "<html><body>first app</body></html>" } },
      } as ContentBlock,
      {
        id: "tool2",
        type: "tool",
        content: "",
        toolName: "mcp_excalidraw_create_view",
        toolDone: true,
        toolResult: "second",
        extra: { mcp_app: { resourceUri: "ui://excalidraw/mcp-app.html", html: "<html><body>second app</body></html>" } },
      } as ContentBlock,
    ])

    const { container } = render(<AgentPane name="researcher" stream={stream} isLead={false} />)

    const toolRows = container.querySelectorAll(".tool-row-enter")
    const iframe = container.querySelector("iframe")
    expect(container.querySelectorAll("iframe")).toHaveLength(1)
    expect(iframe?.closest(".mt-2")?.previousElementSibling).toBe(toolRows[1])
    expect(screen.getByText(/ui:\/\/excalidraw\/mcp-app\.html/)).toBeTruthy()
  })

  it("keeps older MCP app artifacts visible until a newer same-resource tool block completes in AgentPane", () => {
    const stream = createMockStream([
      {
        id: "tool1",
        type: "tool",
        content: "",
        toolName: "mcp_excalidraw_create_view",
        toolDone: true,
        toolResult: "first",
        extra: { mcp_app: { resourceUri: "ui://excalidraw/mcp-app.html", html: "<html><body>first app</body></html>" } },
      } as ContentBlock,
      {
        id: "tool2",
        type: "tool",
        content: "",
        toolName: "mcp_excalidraw_create_view",
        toolDone: false,
        toolResult: "",
        extra: { mcp_app: { resourceUri: "ui://excalidraw/mcp-app.html", html: "<html><body>second app</body></html>" } },
      } as ContentBlock,
    ])
    stream.status = "working"

    const { container } = render(<AgentPane name="researcher" stream={stream} isLead={false} />)

    const toolRows = container.querySelectorAll(".tool-row-enter")
    const iframe = container.querySelector("iframe")
    expect(container.querySelectorAll("iframe")).toHaveLength(1)
    expect(iframe?.closest(".mt-2")?.previousElementSibling).toBe(toolRows[0])
    expect(screen.getByText(/ui:\/\/excalidraw\/mcp-app\.html/)).toBeTruthy()
  })

  it("renders multiple completed MCP app artifacts for different resource URIs in AgentPane", () => {
    const stream = createMockStream([
      {
        id: "tool1",
        type: "tool",
        content: "",
        toolName: "mcp_chart_create",
        toolDone: true,
        toolResult: "chart",
        extra: { mcp_app: { resourceUri: "ui://charts/app.html", html: "<html><body>chart app</body></html>" } },
      } as ContentBlock,
      {
        id: "tool2",
        type: "tool",
        content: "",
        toolName: "mcp_excalidraw_create_view",
        toolDone: true,
        toolResult: "diagram",
        extra: { mcp_app: { resourceUri: "ui://excalidraw/mcp-app.html", html: "<html><body>diagram app</body></html>" } },
      } as ContentBlock,
    ])

    const { container } = render(<AgentPane name="researcher" stream={stream} isLead={false} />)

    expect(container.querySelectorAll("iframe")).toHaveLength(2)
  })

  it("shows timestamp on mouse hover in AgentPane", async () => {
    const user = userEvent.setup()
    const content = "Test message"
    const timestamp = new Date("2026-04-29T12:00:00Z")
    const blocks: ContentBlock[] = [
      {
        id: "1",
        type: "user",
        content,
        timestamp,
      },
    ]

    const { container } = render(
      <AgentPane
        name="TestAgent"
        stream={createMockStream(blocks)}
        isLead={true}
      />
    )

    // Find the outer wrapper (group div)
    const groupDiv = container.querySelector("div[class*='group']")
    expect(groupDiv).toBeTruthy()

    // Find the timestamp span by looking for the time text
    const timeSpan = screen.getByText("12:00")
    expect(timeSpan.parentElement?.className).toContain("opacity-0")

    // Hover over the group
    await user.hover(groupDiv!)

    // Timestamp should now have opacity-100
    expect(timeSpan.parentElement?.className).toContain("opacity-100")
  })

  // ── Gradient fade overlay ────────────────────────────────────────────────

  it("shows gradient fade overlay when message is collapsed in AgentPane", () => {
    const longContent = Array.from({ length: 15 }, (_, i) => `line${i + 1}`).join("\n")
    const blocks: ContentBlock[] = [
      {
        id: "1",
        type: "user",
        content: longContent,
        timestamp: new Date(),
      },
    ]

    const { container } = render(
      <AgentPane
        name="TestAgent"
        stream={createMockStream(blocks)}
        isLead={true}
      />
    )

    // Find the gradient fade div
    const gradientFade = container.querySelector("div[class*='pointer-events-none'][class*='inset-x-0'][class*='bottom-0']")
    expect(gradientFade).toBeTruthy()
  })

  it("hides gradient fade overlay when message is expanded in AgentPane", async () => {
    const user = userEvent.setup()
    const longContent = Array.from({ length: 15 }, (_, i) => `line${i + 1}`).join("\n")
    const blocks: ContentBlock[] = [
      {
        id: "1",
        type: "user",
        content: longContent,
        timestamp: new Date(),
      },
    ]

    const { container } = render(
      <AgentPane
        name="TestAgent"
        stream={createMockStream(blocks)}
        isLead={true}
      />
    )

    // Initially, gradient fade exists
    let gradientFade = container.querySelector("div[class*='pointer-events-none'][class*='inset-x-0'][class*='bottom-0']")
    expect(gradientFade).toBeTruthy()

    // Click expand
    const buttons = screen.queryAllByRole("button")
    const collapseBtn = buttons.find((btn) => btn.getAttribute("aria-expanded") !== null)
    await user.click(collapseBtn!)

    // Gradient fade should be gone
    gradientFade = container.querySelector("div[class*='pointer-events-none'][class*='inset-x-0'][class*='bottom-0']")
    expect(gradientFade).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// UserBubble — @mention syntax highlighting
// ─────────────────────────────────────────────────────────────────────────────

describe("AgentView — UserBubble @mention highlighting", () => {
  it("colors file mentions blue and folder mentions orange", () => {
    const blocks: ContentBlock[] = [
      {
        id: "1",
        type: "user",
        // ``@src/`` is a folder (trailing slash, picker convention);
        // ``@README.md`` is a file. Both should chip with distinct colors.
        content: "look in @src/ and read @README.md please",
        timestamp: new Date(),
      },
    ]

    render(<AgentView blocks={blocks} currentBlocks={[]} isWorking={false} />)

    const folderSpan = document.querySelector('[data-mention-kind="directory"]')
    const fileSpan = document.querySelector('[data-mention-kind="file"]')

    expect(folderSpan).toBeTruthy()
    expect(fileSpan).toBeTruthy()
    expect(folderSpan!.textContent).toBe("@src/")
    expect(fileSpan!.textContent).toBe("@README.md")
    expect(folderSpan!.className).toContain("--accent-orange-text")
    expect(fileSpan!.className).toContain("--accent-blue-text")
  })

  it("renders prose without mentions as plain text (no spans)", () => {
    const blocks: ContentBlock[] = [
      {
        id: "1",
        type: "user",
        content: "just a regular message with no mentions",
        timestamp: new Date(),
      },
    ]

    render(<AgentView blocks={blocks} currentBlocks={[]} isWorking={false} />)

    expect(document.querySelector("[data-mention-kind]")).toBeNull()
    expect(screen.getByText("just a regular message with no mentions")).toBeTruthy()
  })
})
