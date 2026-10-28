import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test"
import "@testing-library/jest-dom"
import { render, screen, cleanup } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { AgentView } from "@/components/AgentView"
import { useAgentStore } from "@/stores/useAgentStore"
import type { ContentBlock } from "@/api/types"
import { composeWithDesignFeedback, type DesignFeedback } from "@/lib/design-feedback"

// Seed sessionId so AgentView workspace links work
beforeEach(() => {
  useAgentStore.setState({ sessionId: "test-session-123" })
})

afterEach(cleanup)

// ─────────────────────────────────────────────────────────────────────────────
// AgentView UserBubble Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("AgentView — UserBubble collapse feature", () => {
  // ── Short message (≤8 lines) ────────────────────────────────────────────

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

    // ``overflow-clip``, not ``hidden``: a clipping scroller would stop the collapse button pinning.
    const bubble = container.querySelector("div[class*='min-w-0'][class*='max-w-full'][class*='overflow-clip']")
    const text = container.querySelector("p[class*='overflow-wrap:anywhere']")
    expect(bubble).toBeTruthy()
    expect(text).toBeTruthy()
  })

  it("shows full content without collapse button for short message (≤8 lines)", () => {
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

  it("shows full content for exactly 8 lines without collapse button", () => {
    const tenLines = Array.from({ length: 8 }, (_, i) => `line${i + 1}`).join("\n")
    const blocks: ContentBlock[] = [
      {
        id: "1",
        type: "user",
        content: tenLines,
        timestamp: new Date(),
      },
    ]

    render(<AgentView blocks={blocks} currentBlocks={[]} isWorking={false} />)

    // All 8 lines visible, unclipped
    expect(screen.getByText(/line8/)).toBeTruthy()
    expect(document.querySelector("p[data-collapsed]")).toBeNull()

    // No collapse button
    const buttons = screen.queryAllByRole("button")
    const collapseButtons = buttons.filter((btn) => btn.getAttribute("aria-expanded") !== null)
    expect(collapseButtons.length).toBe(0)
  })

  // ── Long message (>8 lines) ─────────────────────────────────────────────

  it("folds a message longer than 8 lines to its first 6", () => {
    const elevenLines = Array.from({ length: 9 }, (_, i) => `line${i + 1}`).join("\n")
    const blocks: ContentBlock[] = [
      {
        id: "1",
        type: "user",
        content: elevenLines,
        timestamp: new Date(),
      },
    ]

    render(<AgentView blocks={blocks} currentBlocks={[]} isWorking={false} />)

    // The text stays in the DOM (copy, find) and is clipped to 6 lines.
    const text = document.querySelector("p[data-collapsed]") as HTMLElement
    expect(text).toBeTruthy()
    expect(text.textContent).toContain("line9")
    expect(text.style.maxHeight).toBe(`${6 * 1.625}em`)

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

    // Wrapped lines count, not newlines.
    expect(document.querySelector("p[data-collapsed]")).toBeTruthy()

    const buttons = screen.queryAllByRole("button")
    const collapseBtn = buttons.find((btn) => btn.getAttribute("aria-expanded") !== null)
    expect(collapseBtn).toBeTruthy()

    await user.click(collapseBtn!)
    expect(document.querySelector("p[data-collapsed]")).toBeNull()
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
    expect(collapseBtn?.getAttribute("aria-label")).toBe("Expand")
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

    // Initially clipped
    expect(document.querySelector("p[data-collapsed]")).toBeTruthy()

    // Click expand button
    const buttons = screen.queryAllByRole("button")
    const collapseBtn = buttons.find((btn) => btn.getAttribute("aria-expanded") !== null)
    await user.click(collapseBtn!)

    // Now unclipped
    expect(document.querySelector("p[data-collapsed]")).toBeNull()
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

    expect(collapseBtn?.getAttribute("aria-label")).toBe("Collapse")
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
    expect(document.querySelector("p[data-collapsed]")).toBeNull()

    // Collapse
    await user.click(collapseBtn!)
    expect(document.querySelector("p[data-collapsed]")).toBeTruthy()
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

  it("still offers copy when the prompt has no timestamp yet", () => {
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

    // Copy does not depend on the metadata row's contents.
    expect(screen.getByLabelText("Copy message")).toBeTruthy()
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
    expect(timeSpan.closest("div")?.className).toContain("opacity-0")

    // Hover over the group
    await user.hover(groupDiv!)

    // Timestamp should now have opacity-100
    expect(timeSpan.closest("div")?.className).toContain("opacity-100")
  })

  it("shows the model from user message metadata in the prompt's hover row", async () => {
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
    expect(modelLabel.closest("div")?.className).toContain("opacity-0")

    await user.hover(container.querySelector("div[class*='group']")!)

    expect(modelLabel.closest("div")?.className).toContain("opacity-100")
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
    expect(timeSpan.closest("div")?.className).toContain("opacity-100")

    // Hover out
    await user.unhover(groupDiv!)
    expect(timeSpan.closest("div")?.className).toContain("opacity-0")
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

  it("positions collapse button at the top right of the user bubble with room for text", () => {
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

    const rail = container.querySelector("div[class*='absolute'][class*='top-1.5'][class*='right-1.5']")
    expect(rail?.querySelector("button[aria-expanded]")).toBeTruthy()
    const text = container.querySelector("p[class*='pr-6']")
    expect(text).toBeTruthy()
  })

  it("keeps the collapse button in view while scrolling through an expanded message", async () => {
    const user = userEvent.setup()
    const longContent = Array.from({ length: 60 }, (_, i) => `line${i + 1}`).join("\n")
    render(<AgentView blocks={[{ id: "1", type: "user", content: longContent }]} currentBlocks={[]} isWorking={false} />)

    const toggle = screen.getByRole("button", { name: "Expand" })
    await user.click(toggle)

    // The button rides a rail as tall as the bubble, pinned to the top of the view.
    const rail = toggle.closest("div[class*='absolute']") as HTMLElement
    expect(rail.className).toContain("bottom-1.5")
    expect(toggle.closest("div[class*='sticky']")).toBeTruthy()
  })

  it("pins an expanded subagent report's header with a minimize button", async () => {
    const user = userEvent.setup()
    const longReport = "Found:\n" + Array.from({ length: 8 }, (_, i) => `- Item ${i + 1}`).join("\n")
    render(<AgentView blocks={[{ id: "r1", type: "user", content: longReport, extra: { from_agent: "explorer#1" } }]} currentBlocks={[]} isWorking={false} />)
    const header = screen.getByText("Subagent report").parentElement as HTMLElement
    expect(header.className).not.toContain("sticky")
    expect(screen.queryByRole("button", { name: "Minimize report" })).toBeNull()

    await user.click(screen.getByRole("button", { name: /Show full report/i }))

    expect(header.className).toContain("sticky")
    await user.click(screen.getByRole("button", { name: "Minimize report" }))
    expect(screen.getByRole("button", { name: /Show full report/i })).toBeTruthy()
    expect(header.className).not.toContain("sticky")
  })

  it("renders incoming subagent message with handle badge and left-aligned container", () => {
    const blocks: ContentBlock[] = [
      {
        id: "sub-msg-1",
        type: "user",
        content: "Here are the 4 verified auth routes in the codebase.",
        extra: { from_agent: "explorer#1" },
        timestamp: new Date(),
      },
    ]

    render(<AgentView blocks={blocks} currentBlocks={[]} isWorking={false} />)
    expect(screen.getByText("explorer#1")).toBeTruthy()
    expect(screen.getByText("Subagent report")).toBeTruthy()
    expect(screen.getByText(/Here are the 4 verified auth routes/)).toBeTruthy()
  })

  it("minimizes long subagent report by default with a Show full report button", async () => {
    const user = userEvent.setup()
    const longReport = "Found following items in repository:\n" + Array.from({ length: 8 }, (_, i) => `- Item ${i + 1}: /src/path/to/module_${i + 1}.py`).join("\n")
    const blocks: ContentBlock[] = [
      {
        id: "sub-msg-long",
        type: "user",
        content: longReport,
        extra: { from_agent: "explorer#1" },
        timestamp: new Date(),
      },
    ]

    const { container } = render(<AgentView blocks={blocks} currentBlocks={[]} isWorking={false} />)

    // Clamped wrapper initially present
    expect(container.querySelector("div[class*='max-h-36'][class*='overflow-hidden']")).toBeTruthy()
    // Bottom preview fade initially present
    expect(container.querySelector("div[class*='pointer-events-none'][class*='inset-x-0'][class*='bottom-0']")).toBeTruthy()

    // Toggle button initially says "Show full report"
    const toggleBtn = screen.getByRole("button", { name: /Show full report/i })
    expect(toggleBtn).toBeTruthy()
    expect(toggleBtn.getAttribute("aria-expanded")).toBe("false")

    // Click expand
    await user.click(toggleBtn)

    // Clamped class and fade are gone
    expect(container.querySelector("div[class*='max-h-36'][class*='overflow-hidden']")).toBeNull()
    expect(container.querySelector("div[class*='pointer-events-none'][class*='inset-x-0'][class*='bottom-0']")).toBeNull()

    // Toggle button now says "Minimize"
    const minimizeBtn = screen.getByRole("button", { name: "Minimize" })
    expect(minimizeBtn).toBeTruthy()
    expect(minimizeBtn.getAttribute("aria-expanded")).toBe("true")

    // Click minimize to collapse again
    await user.click(minimizeBtn)
    expect(screen.getByRole("button", { name: /Show full report/i })).toBeTruthy()
  })

  it("copies subagent report content to clipboard when copy button is clicked", async () => {
    const user = userEvent.setup()
    const content = "Verified report content to copy"
    const clipboardWriteText = mock(() => Promise.resolve())
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: clipboardWriteText },
      writable: true,
    })

    const blocks: ContentBlock[] = [
      {
        id: "sub-msg-copy",
        type: "user",
        content,
        extra: { from_agent: "researcher#1" },
        timestamp: new Date(),
      },
    ]

    render(<AgentView blocks={blocks} currentBlocks={[]} isWorking={false} />)
    const copyBtn = screen.getByLabelText("Copy report")
    expect(copyBtn).toBeTruthy()
    await user.click(copyBtn)
    expect(clipboardWriteText).toHaveBeenCalledWith(content)
  })
})

describe("AgentView — design feedback in user messages", () => {
  const feedback: DesignFeedback = {
    where: "http://localhost:5173/pricing",
    device: "Mobile 390×844",
    items: [
      { n: 1, element: "<button.cta>", text: "Start free", selector: "main > button.cta", source: "@src/Pricing.tsx#L42-L71", html: "<button class=\"cta\">", styles: "", page: null, comment: "Make this larger" },
      { n: 2, element: "<h1>", text: "Plans", selector: "h1", source: null, html: "<h1>", styles: "", page: null, comment: "Warmer tone" },
    ],
  }

  it("shows the block as a card and only the typed text in the bubble", () => {
    const content = composeWithDesignFeedback("Please fix these", [feedback])
    render(<AgentView blocks={[{ id: "u1", type: "user", content }]} currentBlocks={[]} isWorking={false} />)
    expect(screen.getByText("Please fix these")).toBeTruthy()
    const card = screen.getByRole("region", { name: "Design feedback · 2 comments" })
    expect(card.textContent).toContain("localhost:5173/pricing · Mobile 390×844")
    expect(card.textContent).toContain("Make this larger")
    expect(card.textContent).toContain("@src/Pricing.tsx#L42-L71")
    expect(screen.queryByText(/<design-feedback/)).toBeNull()
    // A long block does not make the short typed text collapsible.
    expect(screen.queryByLabelText("Expand")).toBeNull()
  })

  it("renders a feedback-only message without an empty bubble", () => {
    const content = composeWithDesignFeedback("", [feedback])
    const { container } = render(<AgentView blocks={[{ id: "u2", type: "user", content }]} currentBlocks={[]} isWorking={false} />)
    expect(screen.getByRole("region", { name: "Design feedback · 2 comments" })).toBeTruthy()
    expect(container.querySelector(".selectable-text")).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────

// The fold follows the lines on screen: a narrower chat (sidebar or dock
// open) wraps the same prompt to more lines. happy-dom has no layout, so the
// text reports a fake height and the ResizeObserver is driven by hand.
describe("AgentView — UserBubble folds by rendered lines", () => {
  const LINE = 20
  let height = 0
  let width = 400
  let resize: (() => void) | null = null
  let observedTexts = 0
  const realObserver = globalThis.ResizeObserver
  const realComputed = window.getComputedStyle
  const heightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight")
  const widthDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth")

  beforeEach(() => {
    height = 0
    width = 400
    resize = null
    observedTexts = 0
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return this.tagName === "P" ? height : 0
      },
    })
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get(this: Element) {
        return this.tagName === "P" ? width : 0
      },
    })
    window.getComputedStyle = ((el: Element) =>
      el.tagName === "P" ? ({ lineHeight: `${LINE}px` } as CSSStyleDeclaration) : realComputed(el)) as typeof window.getComputedStyle
    const textObservers: (() => void)[] = []
    resize = () => textObservers.forEach((callback) => callback())
    globalThis.ResizeObserver = class {
      callback: (entries: unknown[]) => void
      constructor(callback: (entries: unknown[]) => void) {
        this.callback = callback
      }
      // Only the bubble text's observer is driven; others (scroll follow) stay idle.
      observe(target: Element) {
        if (target.tagName === "P") {
          observedTexts += 1
          textObservers.push(() => this.callback([]))
        }
      }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver
  })

  afterEach(() => {
    if (heightDescriptor) Object.defineProperty(HTMLElement.prototype, "scrollHeight", heightDescriptor)
    if (widthDescriptor) Object.defineProperty(HTMLElement.prototype, "clientWidth", widthDescriptor)
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth
    window.getComputedStyle = realComputed
    globalThis.ResizeObserver = realObserver
  })

  it("folds when the bubble narrows past 8 lines and unfolds when it widens again", async () => {
    const { act } = await import("@testing-library/react")
    height = 5 * LINE
    const prompt = "a fairly long single paragraph prompt that wraps to a few lines in a wide chat and to many more once the sidebar and the dock are both open"
    render(<AgentView blocks={[{ id: "1", type: "user", content: prompt }]} currentBlocks={[]} isWorking={false} />)
    expect(document.querySelector("p[data-collapsed]")).toBeNull()

    height = 11 * LINE
    act(() => resize?.())
    expect(document.querySelector("p[data-collapsed]")).toBeTruthy()

    height = 7 * LINE
    act(() => resize?.())
    expect(document.querySelector("p[data-collapsed]")).toBeNull()
  })

  it("ignores a zero-width reading from a hidden chat column", async () => {
    const { act } = await import("@testing-library/react")
    height = 3 * LINE
    render(<AgentView blocks={[{ id: "1", type: "user", content: "Reply with exactly: purple elephant, then list the three files you changed and say which test covers each of them" }]} currentBlocks={[]} isWorking={false} />)
    expect(observedTexts).toBe(1)

    // Hidden: every character on its own line.
    width = 0
    height = 35 * LINE
    act(() => resize?.())

    expect(document.querySelector("p[data-collapsed]")).toBeNull()
  })

  // Measuring costs a style read, an observer and a second render per bubble;
  // a session opens with many short prompts that could never fold.
  it("does not measure a prompt too short to reach 8 lines in any bubble", () => {
    render(<AgentView blocks={[{ id: "1", type: "user", content: "continue" }, { id: "2", type: "user", content: "yes\nand run the tests" }]} currentBlocks={[]} isWorking={false} />)
    expect(observedTexts).toBe(0)
    expect(document.querySelector("p[data-collapsed]")).toBeNull()
  })
})
