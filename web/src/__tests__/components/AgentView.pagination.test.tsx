/**
 * AgentView — scroll-to-top pagination tests
 *
 * Covers the two bugs fixed in AgentView:
 *  1. Stale closure: after loadOlderMessages resolves, a subsequent scroll-to-top
 *     must still call loadOlderMessages (not get stuck on showEarlierTurns).
 *  2. Restore unpin: the scroll-position restore must keep pinnedRef=false so
 *     the dimensionsChanged guard does not snap the user back to the bottom.
 *
 * NOTE: mock.module must appear before any store import (Bun module registry).
 */

import { afterEach, describe, expect, it, mock } from "bun:test"
import { act, cleanup, render } from "@testing-library/react"
import type { ContentBlock } from "@/api/types"

// ── Store mock ────────────────────────────────────────────────────────────────

const mockLoadOlderMessages = mock(() => Promise.resolve())

const storeState = {
  sessionId: "sess-1",
  hasMore: false,
  nextCursor: null as string | null,
  _loadingOlder: false,
  _pendingMessages: [] as unknown[],
  loadOlderMessages: mockLoadOlderMessages,
}

mock.module("@/stores/useAgentStore", () => ({
  useAgentStore: Object.assign(
    (selector: (s: typeof storeState) => unknown) => selector(storeState),
    { getState: () => storeState },
  ),
}))

mock.module("lucide-react", () => new Proxy({}, { get: () => () => null }))

// ── Component import (after mocks) ───────────────────────────────────────────

import { AgentView } from "@/components/AgentView"

// ── Helpers ───────────────────────────────────────────────────────────────────

function block(id: string, type: ContentBlock["type"] = "text"): ContentBlock {
  return { id, type, content: `content-${id}` }
}

/** Build N interleaved user+text turns so partitionTurns produces 2N TurnItems. */
function makeTurns(n: number, prefix = ""): ContentBlock[] {
  const out: ContentBlock[] = []
  for (let i = 0; i < n; i++) {
    out.push(block(`${prefix}u${i}`, "user"), block(`${prefix}t${i}`, "text"))
  }
  return out
}

function getScrollEl(container: HTMLElement) {
  return container.querySelector(".overflow-y-auto") as HTMLDivElement
}

function setScrollProps(
  el: HTMLDivElement,
  { scrollTop = 0, scrollHeight = 1000, clientHeight = 500 } = {},
) {
  Object.defineProperty(el, "scrollTop", { value: scrollTop, configurable: true, writable: true })
  Object.defineProperty(el, "scrollHeight", { value: scrollHeight, configurable: true, writable: true })
  Object.defineProperty(el, "clientHeight", { value: clientHeight, configurable: true, writable: true })
}

async function scrollTo(el: HTMLDivElement, scrollTop: number) {
  await act(async () => {
    Object.defineProperty(el, "scrollTop", { value: scrollTop, configurable: true, writable: true })
    el.dispatchEvent(new Event("scroll", { bubbles: true }))
    await new Promise((r) => requestAnimationFrame(r))
  })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

afterEach(() => {
  cleanup()
  mockLoadOlderMessages.mockClear()
  storeState.hasMore = false
  storeState.nextCursor = null
  storeState._loadingOlder = false
  document.documentElement.removeAttribute("data-keyboard-open")
})

describe("AgentView — scroll-to-top pagination", () => {
  it("does not call loadOlderMessages when hasMore is false", async () => {
    storeState.hasMore = false
    const { container } = render(
      <AgentView blocks={[block("b1")]} currentBlocks={[]} isWorking={false} />,
    )
    const el = getScrollEl(container)
    setScrollProps(el, { scrollTop: 0, scrollHeight: 1000, clientHeight: 500 })
    await scrollTo(el, 0)
    expect(mockLoadOlderMessages).not.toHaveBeenCalled()
  })

  it("calls loadOlderMessages when scrollTop is within threshold and hasMore is true", async () => {
    storeState.hasMore = true
    storeState.nextCursor = "cursor-1"
    const { container } = render(
      <AgentView blocks={[block("b1")]} currentBlocks={[]} isWorking={false} />,
    )
    const el = getScrollEl(container)
    setScrollProps(el, { scrollTop: 0, scrollHeight: 1000, clientHeight: 500 })
    await scrollTo(el, 0)
    expect(mockLoadOlderMessages).toHaveBeenCalledTimes(1)
  })

  it("loads older messages at the top while the mobile keyboard is open", async () => {
    storeState.hasMore = true
    storeState.nextCursor = "cursor-1"
    document.documentElement.setAttribute("data-keyboard-open", "")
    const { container } = render(
      <AgentView blocks={[block("b1")]} currentBlocks={[]} isWorking={false} />,
    )
    const el = getScrollEl(container)
    setScrollProps(el, { scrollTop: 500, scrollHeight: 1000, clientHeight: 400 })
    await scrollTo(el, 0)
    expect(mockLoadOlderMessages).toHaveBeenCalledTimes(1)
  })

  it("does not call loadOlderMessages when scrollTop is beyond the threshold", async () => {
    storeState.hasMore = true
    storeState.nextCursor = "cursor-1"
    const { container } = render(
      <AgentView blocks={[block("b1")]} currentBlocks={[]} isWorking={false} />,
    )
    const el = getScrollEl(container)
    setScrollProps(el, { scrollTop: 400, scrollHeight: 1000, clientHeight: 500 })
    await scrollTo(el, 400)
    expect(mockLoadOlderMessages).not.toHaveBeenCalled()
  })

  it("shows hidden turns button when local turns exceed render window", async () => {
    // 90 turns = 180 blocks (user+text pairs) → hiddenTurnCount > 0 with INITIAL=80
    const manyBlocks = makeTurns(90)
    const { container } = render(
      <AgentView blocks={manyBlocks} currentBlocks={[]} isWorking={false} />,
    )
    const btn = container.querySelector("button[aria-label*='earlier']")
    expect(btn).not.toBeNull()
  })

  it("calls showEarlierTurns (not loadOlderMessages) when hiddenTurnCount > 0", async () => {
    storeState.hasMore = true
    storeState.nextCursor = "cursor-1"
    const manyBlocks = makeTurns(90)
    const { container } = render(
      <AgentView blocks={manyBlocks} currentBlocks={[]} isWorking={false} />,
    )
    const el = getScrollEl(container)
    setScrollProps(el, { scrollTop: 0, scrollHeight: 5000, clientHeight: 500 })
    await scrollTo(el, 0)
    // loadOlderMessages must NOT fire — local hidden turns should be shown first
    expect(mockLoadOlderMessages).not.toHaveBeenCalled()
    // The hidden-turns button should still (or now) be present
    const btn = container.querySelector("button[aria-label*='earlier']")
    expect(btn).not.toBeNull()
  })

  it("calls loadOlderMessages after all local hidden turns are revealed (stale-closure regression)", async () => {
    storeState.hasMore = true
    storeState.nextCursor = "cursor-1"

    // makeTurns(n) produces 2n TurnItems (one user + one assistant per iteration).
    // INITIAL_RENDERED_TURNS=80 so we need ≤40 turns to keep hiddenTurnCount=0 initially.
    const blocks = makeTurns(30) // 60 TurnItems — all within the 80-item window
    const { container, rerender } = render(
      <AgentView blocks={blocks} currentBlocks={[]} isWorking={false} />,
    )
    const el = getScrollEl(container)
    setScrollProps(el, { scrollTop: 0, scrollHeight: 5000, clientHeight: 500 })

    // First scroll: hiddenTurnCount=0 → loadOlderMessages fires
    await scrollTo(el, 0)
    expect(mockLoadOlderMessages).toHaveBeenCalledTimes(1)
    mockLoadOlderMessages.mockClear()

    // Simulate server returning 50 older turns (prepended): TurnItems grows to 160 → hiddenTurnCount=80
    const olderBlocks = makeTurns(50, "old-")
    await act(async () => {
      rerender(<AgentView blocks={[...olderBlocks, ...blocks]} currentBlocks={[]} isWorking={false} />)
    })

    // Scroll to top: hiddenTurnCount=80 → showEarlierTurns fires (NOT loadOlderMessages)
    setScrollProps(el, { scrollTop: 0, scrollHeight: 6000, clientHeight: 500 })
    await scrollTo(el, 0)
    expect(mockLoadOlderMessages).not.toHaveBeenCalled()

    // renderedTurnCount expanded to 160; hiddenTurnCount back to 0.
    // Scroll to top again → loadOlderMessages must fire (stale-closure regression test).
    await scrollTo(el, 0)
    expect(mockLoadOlderMessages).toHaveBeenCalledTimes(1)
  })

  it("does not snap back to bottom after scroll-position restore (unpin regression)", async () => {
    storeState.hasMore = true
    storeState.nextCursor = "cursor-1"

    // Resolve immediately so we can observe the post-restore state synchronously
    mockLoadOlderMessages.mockImplementation(() => Promise.resolve())

    const { container } = render(
      <AgentView blocks={[block("b1")]} currentBlocks={[]} isWorking={false} />,
    )
    const el = getScrollEl(container)

    // Simulate user scrolled to top (detached from bottom via wheel)
    await act(async () => {
      el.dispatchEvent(new WheelEvent("wheel", { deltaY: -10, bubbles: true }))
    })
    // Simulate starting at the bottom first so that scrolling to 0 is detected as scroll-up
    setScrollProps(el, { scrollTop: 1500, scrollHeight: 2000, clientHeight: 500 })
    await scrollTo(el, 1500)

    setScrollProps(el, { scrollTop: 0, scrollHeight: 2000, clientHeight: 500 })
    await scrollTo(el, 0)
    expect(mockLoadOlderMessages).toHaveBeenCalledTimes(1)

    // Simulate older messages being prepended: scrollHeight grows
    await act(async () => {
      Object.defineProperty(el, "scrollHeight", { value: 4000, configurable: true, writable: true })
      // Trigger the restore (blocks.length change) by dispatching a scroll at restored position
      Object.defineProperty(el, "scrollTop", { value: 2000, configurable: true, writable: true })
      el.dispatchEvent(new Event("scroll", { bubbles: true }))
      await new Promise((r) => requestAnimationFrame(r))
    })

    // The scroll-to-bottom button should be visible — user is mid-page, NOT snapped to bottom
    const btn = container.querySelector('button[aria-label="Scroll to bottom"]')
    expect(btn).not.toBeNull()
  })
})
