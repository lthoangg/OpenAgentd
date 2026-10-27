/**
 * A reader scrolled up in the transcript keeps their place when the turn
 * ends. The end-of-turn sync can rebuild the finished turn (folds the reader
 * opened close again), so the content shrinks and the browser clamps the
 * scroll position to the new bottom. That clamp is not the reader scrolling
 * down, so it must not turn bottom-following back on.
 */
import { describe, it, expect, afterEach, mock } from "bun:test"
import { act, render, cleanup } from "@testing-library/react"
import { AgentView } from "@/components/AgentView"
import { useAgentStore } from "@/stores/useAgentStore"
import type { ContentBlock } from "@/api/types"

mock.module("lucide-react", () => new Proxy({}, { get: () => () => null }))

afterEach(() => {
  cleanup()
  act(() => {
    useAgentStore.setState({ sessionId: null })
  })
})

function makeUserBlock(id: string, content: string): ContentBlock {
  return { id, type: "user", content }
}
function makeTextBlock(id: string, content: string): ContentBlock {
  return { id, type: "text", content }
}

async function waitFrame() {
  await act(async () => {
    await new Promise((r) => requestAnimationFrame(() => r(undefined)))
  })
}

interface FakeObserver {
  callback: ResizeObserverCallback
  targets: Element[]
}

describe("AgentView — a finishing turn leaves a scrolled-up reader alone", () => {
  it("does not re-follow the bottom when the turn-end rebuild clamps the scroll", async () => {
    const originalResizeObserver = globalThis.ResizeObserver
    const observers: FakeObserver[] = []
    globalThis.ResizeObserver = class {
      private readonly entry: FakeObserver
      constructor(callback: ResizeObserverCallback) {
        this.entry = { callback, targets: [] }
        observers.push(this.entry)
      }
      observe(target: Element) {
        this.entry.targets.push(target)
      }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof globalThis.ResizeObserver

    try {
      const { container, rerender } = render(
        <AgentView
          blocks={[makeUserBlock("u1", "Explain the build")]}
          currentBlocks={[makeTextBlock("block-live-1", "A long answer")]}
          isWorking={true}
        />,
      )
      const el = container.querySelector(".overflow-y-auto") as HTMLDivElement
      const content = container.querySelector(".mx-auto") as HTMLDivElement

      // A scroller that clamps like a browser does.
      let scrollHeight = 3000
      const clientHeight = 500
      let scrollTop = 2500
      Object.defineProperties(el, {
        scrollHeight: { configurable: true, get: () => scrollHeight },
        clientHeight: { configurable: true, get: () => clientHeight },
        scrollTop: {
          configurable: true,
          get: () => scrollTop,
          set: (value: number) => {
            scrollTop = Math.min(Math.max(0, value), Math.max(0, scrollHeight - clientHeight))
          },
        },
      })
      content.getBoundingClientRect = () =>
        ({ x: 0, y: 0, top: 0, left: 0, right: 800, width: 800, height: scrollHeight, bottom: scrollHeight, toJSON: () => ({}) }) as DOMRect
      const anchor = container.querySelector("[data-chat-scroll-anchor]")!
      const follow = observers.find((entry) => entry.targets.includes(anchor))!
      const layoutChanged = async () => {
        await act(async () => {
          follow.callback([{ target: content } as unknown as ResizeObserverEntry], {} as ResizeObserver)
        })
      }
      const scrolled = async () => {
        await act(async () => {
          el.dispatchEvent(new Event("scroll"))
        })
        await waitFrame()
      }

      // At the bottom, following.
      await scrolled()

      // The reader scrolls up to read the answer.
      await act(async () => {
        el.dispatchEvent(new WheelEvent("wheel", { deltaY: -120 }))
      })
      scrollTop = 1800
      await scrolled()
      expect(el.dataset.follow).toBe("reading")
      // Long after the gesture.
      await act(async () => {
        await new Promise((r) => setTimeout(r, 300))
      })

      // The turn ends: the sync swaps in the server's copy of the turn, the
      // rebuilt turn is shorter, and the browser clamps the position.
      await act(async () => {
        rerender(
          <AgentView
            blocks={[makeUserBlock("u1", "Explain the build"), makeTextBlock("m2:text", "A long answer")]}
            currentBlocks={[]}
            isWorking={false}
          />,
        )
      })
      scrollHeight = 2000
      scrollTop = Math.min(scrollTop, scrollHeight - clientHeight)
      await scrolled()
      await layoutChanged()

      // Late layout (an image, a highlight) grows the content again.
      scrollHeight = 2600
      await layoutChanged()

      expect(el.dataset.follow).toBe("reading")
      expect(scrollTop).toBe(1500)
      expect(container.querySelector('button[aria-label="Scroll to bottom"]')).toBeTruthy()
    } finally {
      globalThis.ResizeObserver = originalResizeObserver
    }
  })
})
