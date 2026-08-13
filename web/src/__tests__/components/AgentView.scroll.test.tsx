import { describe, it, expect, afterEach, beforeEach, mock } from "bun:test"
import { act, render, cleanup } from "@testing-library/react"
import { AgentPane } from "@/components/AgentPane"
import { AgentView } from "@/components/AgentView"
import { useTeamStore } from "@/stores/useTeamStore"
import type { ContentBlock } from "@/api/types"
import type { AgentStream } from "@/stores/useTeamStore"

afterEach(() => {
  cleanup()
  act(() => {
    useTeamStore.setState({ sessionId: null })
  })
})

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

function makeAgentStream(blocks: ContentBlock[]): AgentStream {
  return {
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
    model: null,
    lastError: null,
  }
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

    expect(scrollToMock).toHaveBeenCalledWith({ top: el.scrollHeight - el.clientHeight, behavior: "smooth" })

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

// ── attach-to-stream regressions (desktop + mobile) ───────────────────────

describe("attach-to-stream — session switch", () => {
  it("AgentView re-attaches and scrolls to the bottom when the session changes", async () => {
    act(() => {
      useTeamStore.setState({ sessionId: "session-a" })
    })
    const { container } = renderStream({ blocks: [makeTextBlock("b1", "Hello")] })
    const el = container.querySelector(".overflow-y-auto") as HTMLDivElement

    // Detach in session A (user scrolled up to read).
    await fireScroll(el, 200)
    expect(container.querySelector('button[aria-label="Scroll to bottom"]')).toBeTruthy()

    // Switch to session B — the stale detach must not leak across sessions.
    await act(async () => {
      useTeamStore.setState({ sessionId: "session-b" })
    })
    await waitFrame()

    expect(container.querySelector('button[aria-label="Scroll to bottom"]')).toBeNull()
    expect(el.scrollTop).toBe(500) // scrollHeight 1000 - clientHeight 500
  })

  it("AgentPane re-attaches and scrolls to the bottom when the session changes", async () => {
    act(() => {
      useTeamStore.setState({ sessionId: "session-a" })
    })
    const { container } = render(
      <AgentPane name="researcher" stream={makeAgentStream([makeTextBlock("b1", "Hello")])} isLead={false} />,
    )
    const el = container.querySelector(".overflow-y-auto") as HTMLDivElement

    await fireScroll(el, 200)
    expect(container.querySelector('button[aria-label="Scroll to bottom"]')).toBeTruthy()

    await act(async () => {
      useTeamStore.setState({ sessionId: "session-b" })
    })
    await waitFrame()

    expect(container.querySelector('button[aria-label="Scroll to bottom"]')).toBeNull()
    expect(el.scrollTop).toBe(500)
  })
})

describe("attach-to-stream — smooth scroll no-op fallback (WKWebView)", () => {
  it("falls back to an instant jump when smooth scrollTo silently does nothing", async () => {
    const { container } = renderStream({ blocks: [makeTextBlock("b1", "Hi")] })
    const el = container.querySelector(".overflow-y-auto") as HTMLDivElement

    await fireScroll(el, 200) // detach at scrollTop=300
    const btn = container.querySelector('button[aria-label="Scroll to bottom"]') as HTMLButtonElement
    expect(btn).toBeTruthy()

    // WKWebView can silently no-op scrollTo({behavior:'smooth'}) — the view
    // never moves and no scroll/scrollend events fire.
    el.scrollTo = mock(() => {}) as unknown as typeof el.scrollTo

    await act(async () => { btn.click() })
    expect(el.scrollTop).toBe(300) // smooth scroll did nothing

    // After the programmatic-scroll window closes, the click must still land
    // the user at the bottom.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 600))
    })
    expect(el.scrollTop).toBe(500)
    expect(container.querySelector('button[aria-label="Scroll to bottom"]')).toBeNull()
  })
})

describe("attach-to-stream — AgentPane mounted empty", () => {
  it("starts observing content that appears after an empty mount", async () => {
    const originalResizeObserver = globalThis.ResizeObserver
    const resizeObservers: Array<{ targets: Element[] }> = []

    globalThis.ResizeObserver = class {
      private readonly entry: (typeof resizeObservers)[number]
      constructor() {
        this.entry = { targets: [] }
        resizeObservers.push(this.entry)
      }
      observe(target: Element) {
        this.entry.targets.push(target)
      }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof globalThis.ResizeObserver

    try {
      // Pane mounts with zero blocks — the content div does not exist yet.
      const { container, rerender } = render(
        <AgentPane name="researcher" stream={makeAgentStream([])} isLead={false} />,
      )
      const el = container.querySelector(".overflow-y-auto") as HTMLDivElement
      expect(el.querySelector(".space-y-3")).toBeNull()

      // First blocks arrive (agent starts streaming).
      await act(async () => {
        rerender(
          <AgentPane name="researcher" stream={makeAgentStream([makeTextBlock("b1", "Hi")])} isLead={false} />,
        )
      })

      const content = el.querySelector(".space-y-3") as HTMLDivElement
      expect(content).toBeTruthy()
      // The auto-follow ResizeObserver must observe the late-mounted content.
      expect(resizeObservers.some((o) => o.targets.includes(content))).toBe(true)
    } finally {
      globalThis.ResizeObserver = originalResizeObserver
    }
  })
})

describe("chat layout resize", () => {
  for (const [name, viewportWidth, renderChat] of [
    ["AgentView on desktop", 1440, () => renderStream({ blocks: [makeTextBlock("b1", "Hi")] })],
    ["AgentView on mobile", 390, () => renderStream({ blocks: [makeTextBlock("b1", "Hi")] })],
    ["AgentPane in desktop split view", 1440, () => render(<AgentPane name="researcher" stream={makeAgentStream([makeTextBlock("b1", "Hi")])} isLead={false} />)],
  ] as const) {
    it(`${name} stays attached when collapsing content lowers the scroll range`, async () => {
      const originalResizeObserver = globalThis.ResizeObserver
      const originalInnerWidth = window.innerWidth
      const resizeObservers: Array<{
        callback: ResizeObserverCallback
        targets: Element[]
      }> = []

      globalThis.ResizeObserver = class {
        private readonly entry: (typeof resizeObservers)[number]

        constructor(callback: ResizeObserverCallback) {
          this.entry = { callback, targets: [] }
          resizeObservers.push(this.entry)
        }
        observe(target: Element) {
          this.entry.targets.push(target)
        }
        unobserve() {}
        disconnect() {}
      } as unknown as typeof globalThis.ResizeObserver

      try {
        Object.defineProperty(window, "innerWidth", { configurable: true, value: viewportWidth })
        const { container } = renderChat()
        const el = container.querySelector(".overflow-y-auto") as HTMLDivElement
        const content = name.startsWith("AgentView")
          ? container.querySelector(".mx-auto") as HTMLDivElement
          : el.firstElementChild as HTMLDivElement
        let scrollHeight = 1200
        const clientHeight = 500
        let scrollTop = 0
        let requestedScrollTop = 0
        let contentHeight = 1200

        Object.defineProperties(el, {
          scrollHeight: { configurable: true, get: () => scrollHeight },
          clientHeight: { configurable: true, get: () => clientHeight },
          scrollTop: {
            configurable: true,
            get: () => scrollTop,
            set: (value: number) => {
              requestedScrollTop = value
              scrollTop = Math.min(value, Math.max(0, scrollHeight - clientHeight))
            },
          },
        })
        content.getBoundingClientRect = () => ({
          x: 0,
          y: 0,
          width: 800,
          height: contentHeight,
          top: 0,
          right: 800,
          bottom: contentHeight,
          left: 0,
          toJSON: () => ({}),
        })
        const observer = resizeObservers.find((entry) => entry.targets.includes(content))
        expect(observer).toBeTruthy()

        await act(async () => {
          observer?.callback([{ target: content } as unknown as ResizeObserverEntry], {} as ResizeObserver)
          el.dispatchEvent(new Event("scroll"))
        })
        expect(scrollTop).toBe(700)
        expect(requestedScrollTop).toBe(700)

        scrollHeight = 900
        contentHeight = 900
        await act(async () => {
          observer?.callback([{ target: content } as unknown as ResizeObserverEntry], {} as ResizeObserver)
          el.dispatchEvent(new Event("scroll"))
        })

        expect(scrollTop).toBe(400)
        expect(requestedScrollTop).toBe(400)
        expect(container.querySelector('button[aria-label="Scroll to bottom"]')).toBeNull()
      } finally {
        globalThis.ResizeObserver = originalResizeObserver
        Object.defineProperty(window, "innerWidth", { configurable: true, value: originalInnerWidth })
      }
    })
  }
})

// ── bounce dots ───────────────────────────────────────────────────────────

describe("AgentView — bounce dots indicator", () => {
  it("no dots when isWorking=false and no blocks", () => {
    const { container } = renderStream({ blocks: [], currentBlocks: [], isWorking: false })
    expect(container.querySelectorAll(".animate-bounce").length).toBe(0)
  })

  it("shows 3 dots when isWorking=true before the first block arrives", () => {
    const { container } = renderStream({ blocks: [], currentBlocks: [], isWorking: true })
    expect(container.querySelectorAll(".animate-bounce").length).toBe(3)
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

// ── user scroll intent (wheel / touch) during stream growth ───────────────
//
// Regression: during heavy stream growth (e.g. a shell tool result flushing a
// large output block) the auto-follow ResizeObserver rewrites scrollTop back
// to the bottom BEFORE the scroll listener runs. The listener reads
// el.scrollTop live at dispatch time, so it never observes the user's upward
// movement and never detaches — the user cannot scroll up until the stream
// pauses. The wheel/touch events are the only reliable signal of user intent.

async function fireWheel(el: HTMLDivElement, deltaY: number) {
  await act(async () => {
    const ev = new Event("wheel", { bubbles: true })
    Object.defineProperty(ev, "deltaY", { value: deltaY })
    el.dispatchEvent(ev)
  })
  await waitFrame()
}

async function fireTouch(el: HTMLDivElement, type: "touchstart" | "touchmove", clientY: number) {
  await act(async () => {
    const ev = new Event(type, { bubbles: true })
    Object.defineProperty(ev, "touches", { value: [{ clientY }] })
    el.dispatchEvent(ev)
  })
  await waitFrame()
}

describe("attach-to-stream — wheel/touch detach during stream growth", () => {
  it("AgentView detaches on wheel-up even when scroll events never observe an upward scrollTop", async () => {
    const { container } = renderStream({ blocks: [makeTextBlock("b1", "Hi")], isWorking: true })
    const el = container.querySelector(".overflow-y-auto") as HTMLDivElement
    await fireScroll(el, 0) // establish scrollable metrics, at bottom, attached

    // The RO snaps scrollTop back to bottom before any scroll event is seen —
    // the wheel event is the only observable signal of the user's gesture.
    await fireWheel(el, -50)
    expect(container.querySelector('button[aria-label="Scroll to bottom"]')).toBeTruthy()
  })

  it("does not re-attach at the bottom while the wheel gesture is still in flight", async () => {
    const { container } = renderStream({ blocks: [makeTextBlock("b1", "Hi")], isWorking: true })
    const el = container.querySelector(".overflow-y-auto") as HTMLDivElement
    await fireScroll(el, 0)

    await fireWheel(el, -50)
    expect(container.querySelector('button[aria-label="Scroll to bottom"]')).toBeTruthy()

    // A small trackpad delta leaves the view within SCROLL_THRESHOLD of the
    // bottom (or the RO already snapped it back): the resulting scroll event
    // must NOT re-attach while the user's upward gesture is recent.
    await fireScroll(el, 0)
    expect(container.querySelector('button[aria-label="Scroll to bottom"]')).toBeTruthy()
  })

  it("re-attaches at the bottom once the gesture window has passed", async () => {
    const { container } = renderStream({ blocks: [makeTextBlock("b1", "Hi")], isWorking: true })
    const el = container.querySelector(".overflow-y-auto") as HTMLDivElement
    await fireScroll(el, 0)

    await fireWheel(el, -50)
    expect(container.querySelector('button[aria-label="Scroll to bottom"]')).toBeTruthy()

    await act(async () => { await new Promise((r) => setTimeout(r, 400)) })
    await fireScroll(el, 0) // user scrolled back to the bottom, gesture over
    expect(container.querySelector('button[aria-label="Scroll to bottom"]')).toBeNull()
  })

  it("does not detach on wheel-down", async () => {
    const { container } = renderStream({ blocks: [makeTextBlock("b1", "Hi")], isWorking: true })
    const el = container.querySelector(".overflow-y-auto") as HTMLDivElement
    await fireScroll(el, 0)

    await fireWheel(el, 50)
    expect(container.querySelector('button[aria-label="Scroll to bottom"]')).toBeNull()
  })

  it("does not detach on wheel-up when the pane cannot scroll", async () => {
    const { container } = renderStream({ blocks: [makeTextBlock("b1", "Hi")], isWorking: true })
    const el = container.querySelector(".overflow-y-auto") as HTMLDivElement
    // default happy-dom metrics: scrollHeight = clientHeight = 0 → not scrollable

    await fireWheel(el, -50)
    expect(container.querySelector('button[aria-label="Scroll to bottom"]')).toBeNull()
  })

  it("detaches when a touch drag moves the finger downward (scrolling up)", async () => {
    const { container } = renderStream({ blocks: [makeTextBlock("b1", "Hi")], isWorking: true })
    const el = container.querySelector(".overflow-y-auto") as HTMLDivElement
    await fireScroll(el, 0)

    await fireTouch(el, "touchstart", 200)
    await fireTouch(el, "touchmove", 260)
    expect(container.querySelector('button[aria-label="Scroll to bottom"]')).toBeTruthy()
  })

  it("does not detach when a touch drag moves the finger upward (scrolling down)", async () => {
    const { container } = renderStream({ blocks: [makeTextBlock("b1", "Hi")], isWorking: true })
    const el = container.querySelector(".overflow-y-auto") as HTMLDivElement
    await fireScroll(el, 0)

    await fireTouch(el, "touchstart", 260)
    await fireTouch(el, "touchmove", 200)
    expect(container.querySelector('button[aria-label="Scroll to bottom"]')).toBeNull()
  })

  it("AgentPane detaches on wheel-up even when scroll events never observe an upward scrollTop", async () => {
    const { container } = render(
      <AgentPane name="researcher" stream={makeAgentStream([makeTextBlock("b1", "Hi")])} isLead={false} />,
    )
    const el = container.querySelector(".overflow-y-auto") as HTMLDivElement
    await fireScroll(el, 0)

    await fireWheel(el, -50)
    expect(container.querySelector('button[aria-label="Scroll to bottom"]')).toBeTruthy()
  })
})
