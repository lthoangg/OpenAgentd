import { describe, it, expect, afterEach, mock } from "bun:test"
import { act, render, cleanup } from "@testing-library/react"
import { AgentView } from "@/components/AgentView"
import type { ContentBlock } from "@/api/types"

afterEach(cleanup)

mock.module("lucide-react", () => new Proxy({}, { get: () => () => null }))

// ── helpers ───────────────────────────────────────────────────────────────

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
    />,
  )
}

async function waitFrame() {
  await act(async () => {
    await new Promise((r) => requestAnimationFrame(() => r(undefined)))
  })
}

/** Set scroll position and fire a scroll event. dist = how far from bottom. */
async function fireScroll(el: HTMLDivElement, distFromBottom: number) {
  const scrollHeight = 1000
  const clientHeight = 500
  Object.defineProperty(el, "scrollHeight", { value: scrollHeight, configurable: true, writable: true })
  Object.defineProperty(el, "clientHeight", { value: clientHeight, configurable: true, writable: true })
  Object.defineProperty(el, "scrollTop",    { value: scrollHeight - clientHeight - distFromBottom, configurable: true, writable: true })
  await act(async () => { el.dispatchEvent(new Event("scroll", { bubbles: true })) })
  await waitFrame()
}

// ── scroll-button tests ───────────────────────────────────────────────────

describe("AgentView — scroll-to-bottom button", () => {
  it("hidden by default (attached)", () => {
    const { container } = renderStream({ blocks: [makeTextBlock("b1", "Hi")] })
    expect(container.querySelector('button[aria-label="Scroll to bottom"]')).toBeNull()
  })

  it("appears when user scrolls away from bottom", async () => {
    const { container } = renderStream({ blocks: [makeTextBlock("b1", "Hi")] })
    const el = container.querySelector(".overflow-y-auto") as HTMLDivElement
    await fireScroll(el, 200) // 200px above bottom → detach
    expect(container.querySelector('button[aria-label="Scroll to bottom"]')).toBeTruthy()
  })


  it("clicking button sets attached=true and hides button", async () => {
    const { container } = renderStream({ blocks: [makeTextBlock("b1", "Hi")] })
    const el = container.querySelector(".overflow-y-auto") as HTMLDivElement
    await fireScroll(el, 200)

    const btn = container.querySelector('button[aria-label="Scroll to bottom"]') as HTMLButtonElement
    expect(btn).toBeTruthy()

    await act(async () => { btn.click() })
    expect(container.querySelector('button[aria-label="Scroll to bottom"]')).toBeNull()
  })

  it("uses smooth scroll and ignores scroll events during programmatic scroll", async () => {
    const { container } = renderStream({ blocks: [makeTextBlock("b1", "Hi")] })
    const el = container.querySelector(".overflow-y-auto") as HTMLDivElement

    const scrollToMock = mock(() => {})
    el.scrollTo = scrollToMock

    await fireScroll(el, 200)
    expect(container.querySelector('button[aria-label="Scroll to bottom"]')).toBeTruthy()

    const btn = container.querySelector('button[aria-label="Scroll to bottom"]') as HTMLButtonElement
    await act(async () => { btn.click() })

    expect(scrollToMock).toHaveBeenCalledWith({ top: el.scrollHeight, behavior: "smooth" })

    // During the smooth scroll, intermediate scroll events should not detach the view
    await fireScroll(el, 150)
    expect(container.querySelector('button[aria-label="Scroll to bottom"]')).toBeNull()
  })

  it("hides button when user scrolls back to the bottom", async () => {
    const { container } = renderStream({ blocks: [makeTextBlock("b1", "Hi")] })
    const el = container.querySelector(".overflow-y-auto") as HTMLDivElement

    await fireScroll(el, 200) // detach
    expect(container.querySelector('button[aria-label="Scroll to bottom"]')).toBeTruthy()

    await fireScroll(el, 0) // back at bottom → re-attach
    expect(container.querySelector('button[aria-label="Scroll to bottom"]')).toBeNull()
  })

  it("does not detach when keyboard is open (data-keyboard-open attribute)", async () => {
    const { container } = renderStream({ blocks: [makeTextBlock("b1", "Hi")], isWorking: true })
    const el = container.querySelector(".overflow-y-auto") as HTMLDivElement

    // Simulate keyboard open
    document.documentElement.setAttribute("data-keyboard-open", "")
    await fireScroll(el, 200) // would normally detach, but keyboard is open
    document.documentElement.removeAttribute("data-keyboard-open")

    expect(container.querySelector('button[aria-label="Scroll to bottom"]')).toBeNull()
  })

  it("hides stale button when chat resets to empty", async () => {
    const { container, rerender } = renderStream({ blocks: [makeTextBlock("b1", "Hi")] })
    const el = container.querySelector(".overflow-y-auto") as HTMLDivElement
    await fireScroll(el, 200)
    expect(container.querySelector('button[aria-label="Scroll to bottom"]')).toBeTruthy()

    await act(async () => {
      rerender(<AgentView blocks={[]} currentBlocks={[]} isWorking={false} />)
    })
    expect(container.querySelector('button[aria-label="Scroll to bottom"]')).toBeNull()
  })

  it("re-attaches when new user message arrives (regardless of scroll position)", async () => {
    const { container, rerender } = renderStream({
      blocks: [makeTextBlock("b1", "Hello")],
      isWorking: false,
    })
    const el = container.querySelector(".overflow-y-auto") as HTMLDivElement
    await fireScroll(el, 200) // detach
    expect(container.querySelector('button[aria-label="Scroll to bottom"]')).toBeTruthy()

    await act(async () => {
      rerender(
        <AgentView
          blocks={[makeTextBlock("b1", "Hello"), makeUserBlock("u1", "New message")]}
          currentBlocks={[]}
          isWorking={true}
        />,
      )
    })
    await waitFrame()

    expect(container.querySelector('button[aria-label="Scroll to bottom"]')).toBeNull()
  })

  it("re-attaches to stream after clicking scroll-to-bottom: ResizeObserver fires scrollToBottom", async () => {
    const { container, rerender } = renderStream({
      blocks: [makeTextBlock("b1", "First")],
      isWorking: true,
    })
    const el = container.querySelector(".overflow-y-auto") as HTMLDivElement

    // Detach
    await fireScroll(el, 200)
    expect(container.querySelector('button[aria-label="Scroll to bottom"]')).toBeTruthy()

    // Click button — sets attached=true
    const btn = container.querySelector('button[aria-label="Scroll to bottom"]') as HTMLButtonElement
    await act(async () => { btn.click() })
    expect(container.querySelector('button[aria-label="Scroll to bottom"]')).toBeNull()

    // New stream content — ResizeObserver should scroll (attached=true)
    let scrollTopSet = false
    Object.defineProperty(el, "scrollTop", {
      get() { return 0 },
      set() { scrollTopSet = true },
      configurable: true,
    })
    await act(async () => {
      rerender(
        <AgentView
          blocks={[makeTextBlock("b1", "First"), makeTextBlock("b2", "Streamed")]}
          currentBlocks={[]}
          isWorking={true}
        />,
      )
    })
    await waitFrame()
    expect(scrollTopSet).toBe(true)
  })

  it("observes both the inner content and the outer scroll container with ResizeObserver", () => {
    const observeMock = mock(() => {})
    const originalResizeObserver = globalThis.ResizeObserver

    globalThis.ResizeObserver = class {
      observe = observeMock
      unobserve() {}
      disconnect() {}
    } as unknown as typeof globalThis.ResizeObserver

    try {
      const { container } = renderStream({ blocks: [] })
      const el = container.querySelector(".overflow-y-auto") as HTMLDivElement
      const content = container.querySelector(".mx-auto") as HTMLDivElement

      expect(observeMock).toHaveBeenCalledWith(el)
      expect(observeMock).toHaveBeenCalledWith(content)
    } finally {
      globalThis.ResizeObserver = originalResizeObserver
    }
  })
})

// ── bounce dots ───────────────────────────────────────────────────────────

describe("AgentView — bounce dots indicator", () => {
  it("no dots when isWorking=false and no blocks", () => {
    const { container } = renderStream({ blocks: [], currentBlocks: [], isWorking: false })
    expect(container.querySelectorAll(".animate-bounce").length).toBe(0)
  })

  it("no dots when isWorking=true with no blocks", () => {
    const { container } = renderStream({ blocks: [], currentBlocks: [], isWorking: true })
    expect(container.querySelectorAll(".animate-bounce").length).toBe(0)
  })

  it("shows 3 dots when isWorking=true with only user currentBlocks", () => {
    const { container } = renderStream({
      blocks: [],
      currentBlocks: [makeUserBlock("u1", "Hello")],
      isWorking: true,
    })
    expect(container.querySelectorAll(".animate-bounce").length).toBe(3)
  })

  it("no dots when isWorking=true with a text block in currentBlocks", () => {
    const { container } = renderStream({
      blocks: [],
      currentBlocks: [makeTextBlock("b1", "Response")],
      isWorking: true,
    })
    expect(container.querySelectorAll(".animate-bounce").length).toBe(0)
  })

  it("no dots when isWorking=true with mixed blocks including text", () => {
    const { container } = renderStream({
      blocks: [],
      currentBlocks: [makeUserBlock("u1", "Hi"), makeTextBlock("b1", "Response")],
      isWorking: true,
    })
    expect(container.querySelectorAll(".animate-bounce").length).toBe(0)
  })

  it("no dots when isWorking=true with thinking block only", () => {
    const { container } = renderStream({
      blocks: [],
      currentBlocks: [makeThinkingBlock("t1", "Thinking...")],
      isWorking: true,
    })
    expect(container.querySelectorAll(".animate-bounce").length).toBe(0)
  })

  it("no dots when isWorking=true with user and thinking blocks", () => {
    const { container } = renderStream({
      blocks: [],
      currentBlocks: [makeUserBlock("u1", "Hi"), makeThinkingBlock("t1", "Thinking...")],
      isWorking: true,
    })
    expect(container.querySelectorAll(".animate-bounce").length).toBe(0)
  })
})
