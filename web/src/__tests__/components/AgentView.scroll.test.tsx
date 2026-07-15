import { describe, it, expect, afterEach, beforeEach, mock } from "bun:test"
import { act, render, cleanup } from "@testing-library/react"
import { AgentView } from "@/components/AgentView"
import type { ContentBlock } from "@/api/types"

afterEach(cleanup)

beforeEach(() => {
  document.documentElement.removeAttribute("data-keyboard-open")
})

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

  if (distFromBottom !== 0 && (!el.scrollTop || el.scrollTop === 0)) {
    // Simulate starting at the bottom first
    Object.defineProperty(el, "scrollTop", { value: scrollHeight - clientHeight, configurable: true, writable: true })
    await act(async () => { el.dispatchEvent(new Event("scroll", { bubbles: true })) })
    await waitFrame()
  }

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


  it("does not detach on trailing scroll events after programmatic smooth scroll ends (due to scroll-up prevention)", async () => {
    const { container } = renderStream({ blocks: [makeTextBlock("b1", "Hi")] })
    const el = container.querySelector(".overflow-y-auto") as HTMLDivElement

    // 1. Detach by scrolling away from bottom
    await fireScroll(el, 200)
    expect(container.querySelector('button[aria-label="Scroll to bottom"]')).toBeTruthy()

    // 2. Click scroll to bottom button to trigger smooth scroll
    const btn = container.querySelector('button[aria-label="Scroll to bottom"]') as HTMLButtonElement
    await act(async () => { btn.click() })

    // Button should be hidden immediately
    expect(container.querySelector('button[aria-label="Scroll to bottom"]')).toBeNull()

    // Wait for the programmatic scroll timeout to finish (500ms)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 600))
    })

    // 3. Fire scroll event moving down (from 300 to 400). Even if it is not at the bottom yet,
    // since it is moving down (not scrolling up), it should NOT detach.
    Object.defineProperty(el, "scrollTop", { value: 400, configurable: true, writable: true })
    await act(async () => { el.dispatchEvent(new Event("scroll", { bubbles: true })) })
    await waitFrame()

    // Still attached and no button
    expect(container.querySelector('button[aria-label="Scroll to bottom"]')).toBeNull()

    // 4. Now fire a scroll event that actually scrolls UP (from 400 to 390)
    // This should detach!
    Object.defineProperty(el, "scrollTop", { value: 390, configurable: true, writable: true })
    await act(async () => { el.dispatchEvent(new Event("scroll", { bubbles: true })) })
    await waitFrame()

    expect(container.querySelector('button[aria-label="Scroll to bottom"]')).toBeTruthy()
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

  // Regression: a provider (e.g. OpenAI /responses reasoning-part boundary,
  // or the very first reasoning delta) can emit a whitespace-only chunk
  // before any real content exists. `appendThinking` still creates a
  // `thinking` block from it, which flips `currentBlocks.every(b => b.type
  // === 'user')` to false — hiding the dots — even though `Thinking`
  // renders no visible sections for blank content. The user is left
  // staring at a blank chat area with no dots and no content.
  it("still shows dots when the only non-user block is a whitespace-only thinking chunk", () => {
    const { container } = renderStream({
      blocks: [],
      currentBlocks: [makeUserBlock("u1", "Hi"), makeThinkingBlock("t1", "\n\n")],
      isWorking: true,
    })
    expect(container.querySelectorAll(".animate-bounce").length).toBe(3)
  })

  it("still shows dots when the only non-user block is a whitespace-only text chunk", () => {
    const { container } = renderStream({
      blocks: [],
      currentBlocks: [makeUserBlock("u1", "Hi"), makeTextBlock("b1", "   ")],
      isWorking: true,
    })
    expect(container.querySelectorAll(".animate-bounce").length).toBe(3)
  })
})
