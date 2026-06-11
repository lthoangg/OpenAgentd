import { describe, it, expect, afterEach, mock } from "bun:test"
import { act, render, cleanup } from "@testing-library/react"
import { AgentView } from "@/components/AgentView"
import type { ContentBlock } from "@/api/types"

afterEach(cleanup)

// Mock lucide-react icons to avoid SVG issues in Happy DOM
mock.module("lucide-react", () => new Proxy({}, { get: () => () => null }))

// ── helpers ──────────────────────────────────────────────────────────────────

function makeTextBlock(id: string, content: string): ContentBlock {
  return { id, type: "text", content }
}

function makeUserBlock(id: string, content: string): ContentBlock {
  return { id, type: "user", content }
}

function makeThinkingBlock(id: string, content: string): ContentBlock {
  return { id, type: "thinking", content }
}

function renderStream(props: Partial<React.ComponentProps<typeof AgentView>> = {}) {
  return render(
    <AgentView
      blocks={props.blocks ?? []}
      currentBlocks={props.currentBlocks ?? []}
      isWorking={props.isWorking ?? false}
    />
  )
}

async function waitForScrollUpdate() {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
  })
}

async function dispatchScrollEvent(scrollDiv: HTMLDivElement) {
  await act(async () => {
    scrollDiv.dispatchEvent(new Event("scroll", { bubbles: true }))
  })
  await waitForScrollUpdate()
}

async function dispatchWheelEvent(scrollDiv: HTMLDivElement, deltaY: number) {
  await act(async () => {
    scrollDiv.dispatchEvent(new WheelEvent("wheel", { deltaY, bubbles: true }))
  })
  await waitForScrollUpdate()
}

// ── tests ────────────────────────────────────────────────────────────────────

describe("AgentView — scroll-to-bottom button", () => {
  it("does not render button when content fits (at bottom)", () => {
    const { container } = renderStream({
      blocks: [makeTextBlock("b1", "Hello")],
      currentBlocks: [],
      isWorking: false,
    })
    const btn = container.querySelector('button[aria-label="Scroll to bottom"]')
    expect(btn).toBeNull()
  })

  it("renders button when scroll position is not at bottom", async () => {
    const { container } = renderStream({
      blocks: [makeTextBlock("b1", "Hello world hello world hello world hello world")],
      currentBlocks: [],
      isWorking: false,
    })

    const scrollDiv = container.querySelector(".overflow-y-auto") as HTMLDivElement
    expect(scrollDiv).toBeTruthy()

    // Simulate scroll position not at bottom
    Object.defineProperty(scrollDiv, "scrollHeight", {
      value: 1000,
      configurable: true,
    })
    Object.defineProperty(scrollDiv, "scrollTop", {
      value: 100,
      configurable: true,
    })
    Object.defineProperty(scrollDiv, "clientHeight", {
      value: 500,
      configurable: true,
    })

    // Trigger scroll event (user scroll intent) + wait for rAF
    await dispatchScrollEvent(scrollDiv)

    const btn = container.querySelector('button[aria-label="Scroll to bottom"]')
    expect(btn).toBeTruthy()
  })

  it("button has correct aria-label", async () => {
    const { container } = renderStream({
      blocks: [makeTextBlock("b1", "Hello world hello world hello world hello world")],
      currentBlocks: [],
      isWorking: false,
    })

    const scrollDiv = container.querySelector(".overflow-y-auto") as HTMLDivElement
    Object.defineProperty(scrollDiv, "scrollHeight", {
      value: 1000,
      configurable: true,
    })
    Object.defineProperty(scrollDiv, "scrollTop", {
      value: 100,
      configurable: true,
    })
    Object.defineProperty(scrollDiv, "clientHeight", {
      value: 500,
      configurable: true,
    })

    await dispatchScrollEvent(scrollDiv)

    const btn = container.querySelector('button[aria-label="Scroll to bottom"]')
    expect(btn?.getAttribute("aria-label")).toBe("Scroll to bottom")
  })

  it("clicking button calls scrollTo on container", async () => {
    const { container } = renderStream({
      blocks: [makeTextBlock("b1", "Hello world hello world hello world hello world")],
      currentBlocks: [],
      isWorking: false,
    })

    const scrollDiv = container.querySelector(".overflow-y-auto") as HTMLDivElement
    Object.defineProperty(scrollDiv, "scrollHeight", {
      value: 1000,
      configurable: true,
    })
    Object.defineProperty(scrollDiv, "scrollTop", {
      value: 100,
      configurable: true,
    })
    Object.defineProperty(scrollDiv, "clientHeight", {
      value: 500,
      configurable: true,
    })

    await dispatchScrollEvent(scrollDiv)

    const btn = container.querySelector('button[aria-label="Scroll to bottom"]') as HTMLButtonElement
    expect(btn).toBeTruthy()

    // Button uses smooth scroll → calls scrollTo()
    let scrollToCalled = false
    scrollDiv.scrollTo = (() => { scrollToCalled = true }) as typeof scrollDiv.scrollTo

    await act(async () => {
      btn.click()
    })

    expect(scrollToCalled).toBe(true)
  })

  it("detaches immediately on upward wheel intent near the bottom", async () => {
    const { container } = renderStream({
      blocks: [makeTextBlock("b1", "Hello world hello world hello world hello world")],
      currentBlocks: [],
      isWorking: true,
    })

    const scrollDiv = container.querySelector(".overflow-y-auto") as HTMLDivElement
    Object.defineProperty(scrollDiv, "scrollHeight", {
      value: 1000,
      configurable: true,
    })
    Object.defineProperty(scrollDiv, "scrollTop", {
      value: 470,
      configurable: true,
      writable: true,
    })
    Object.defineProperty(scrollDiv, "clientHeight", {
      value: 500,
      configurable: true,
    })

    await dispatchWheelEvent(scrollDiv, -12)

    const btn = container.querySelector('button[aria-label="Scroll to bottom"]')
    expect(btn).toBeTruthy()
  })

  it("button hides after clicking (scrolls back to bottom)", async () => {
    const { container } = renderStream({
      blocks: [makeTextBlock("b1", "Hello world hello world hello world hello world")],
      currentBlocks: [],
      isWorking: false,
    })

    const scrollDiv = container.querySelector(".overflow-y-auto") as HTMLDivElement
    Object.defineProperty(scrollDiv, "scrollHeight", {
      value: 1000,
      configurable: true,
    })
    Object.defineProperty(scrollDiv, "scrollTop", {
      value: 100,
      configurable: true,
      writable: true,
    })
    Object.defineProperty(scrollDiv, "clientHeight", {
      value: 500,
      configurable: true,
    })

    await dispatchScrollEvent(scrollDiv)

    let btn = container.querySelector('button[aria-label="Scroll to bottom"]')
    expect(btn).toBeTruthy()

    // Simulate scrolling back to bottom after click
    Object.defineProperty(scrollDiv, "scrollTop", {
      value: 500,
      configurable: true,
      writable: true,
    })

    await act(async () => {
      ;(btn as HTMLButtonElement).click()
    })
    await waitForScrollUpdate()

    btn = container.querySelector('button[aria-label="Scroll to bottom"]')
    expect(btn).toBeNull()
  })

  it("hides stale scroll button when the view resets to an empty chat", async () => {
    const { container, rerender } = renderStream({
      blocks: [makeTextBlock("b1", "Hello world hello world hello world hello world")],
      currentBlocks: [],
      isWorking: false,
    })

    const scrollDiv = container.querySelector(".overflow-y-auto") as HTMLDivElement
    Object.defineProperty(scrollDiv, "scrollHeight", {
      value: 1000,
      configurable: true,
    })
    Object.defineProperty(scrollDiv, "scrollTop", {
      value: 100,
      configurable: true,
      writable: true,
    })
    Object.defineProperty(scrollDiv, "clientHeight", {
      value: 500,
      configurable: true,
    })

    await dispatchScrollEvent(scrollDiv)
    expect(container.querySelector('button[aria-label="Scroll to bottom"]')).toBeTruthy()

    await act(async () => {
      rerender(<AgentView blocks={[]} currentBlocks={[]} isWorking={false} />)
    })

    expect(container.querySelector('button[aria-label="Scroll to bottom"]')).toBeNull()
  })
})

describe("AgentView — bounce dots indicator", () => {
  it("does not show bounce dots when isWorking=false and no blocks", () => {
    const { container } = renderStream({
      blocks: [],
      currentBlocks: [],
      isWorking: false,
    })
    const dots = container.querySelectorAll(".animate-bounce")
    expect(dots.length).toBe(0)
  })

  it("does not show bounce dots when isWorking=true with no blocks", () => {
    // Regression: `[].every()` returns true, so the working branch of the
    // dots condition must require a non-empty currentBlocks list. Without
    // that guard the dots stuck around after `done` flushed the buffer
    // whenever a stale `working` status briefly survived (the symptom
    // observed after a multi-agent team turn finished).
    const { container } = renderStream({
      blocks: [],
      currentBlocks: [],
      isWorking: true,
    })
    const dots = container.querySelectorAll(".animate-bounce")
    expect(dots.length).toBe(0)
  })

  it("shows bounce dots when isWorking=true with only user-type currentBlocks", () => {
    const { container } = renderStream({
      blocks: [],
      currentBlocks: [makeUserBlock("u1", "Hello")],
      isWorking: true,
    })
    const dots = container.querySelectorAll(".animate-bounce")
    expect(dots.length).toBe(3)
  })

  it("does not show bounce dots when isWorking=true with a text block in currentBlocks", () => {
    const { container } = renderStream({
      blocks: [],
      currentBlocks: [makeTextBlock("b1", "Response text")],
      isWorking: true,
    })
    const dots = container.querySelectorAll(".animate-bounce")
    expect(dots.length).toBe(0)
  })

  it("does not show bounce dots when isWorking=true with mixed blocks including text", () => {
    const { container } = renderStream({
      blocks: [],
      currentBlocks: [
        makeUserBlock("u1", "Hello"),
        makeTextBlock("b1", "Response"),
      ],
      isWorking: true,
    })
    const dots = container.querySelectorAll(".animate-bounce")
    expect(dots.length).toBe(0)
  })

  it("does not show bounce dots when isWorking=true with thinking block only", () => {
    const { container } = renderStream({
      blocks: [],
      currentBlocks: [makeThinkingBlock("t1", "Thinking...")],
      isWorking: true,
    })
    const dots = container.querySelectorAll(".animate-bounce")
    expect(dots.length).toBe(0)
  })

  it("does not show bounce dots when isWorking=true with user and thinking blocks", () => {
    const { container } = renderStream({
      blocks: [],
      currentBlocks: [
        makeUserBlock("u1", "Hello"),
        makeThinkingBlock("t1", "Thinking..."),
      ],
      isWorking: true,
    })
    const dots = container.querySelectorAll(".animate-bounce")
    expect(dots.length).toBe(0)
  })
})
