/**
 * A layout change the reader did not make never detaches the transcript.
 * Closing the sidebar with the Review panel open widens the chat for a frame
 * before the panel takes some of that room back: the transcript shrinks (the
 * browser clamps the view to the new end), then grows again before the
 * clamp's scroll event arrives. That clamp is not the reader scrolling up.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, render } from '@testing-library/react'
import { _resetScrollMemoryForTests, useAutoFollowScroll } from '@/hooks/useAutoFollowScroll'

let hook: ReturnType<typeof useAutoFollowScroll> | null = null
let observers: ResizeObserverCallback[] = []
const originalResizeObserver = globalThis.ResizeObserver

function Harness() {
  hook = useAutoFollowScroll({ totalLen: 1, isEmpty: false })
  return (
    <div ref={hook.scrollRef}>
      <div ref={hook.contentRef}>content</div>
    </div>
  )
}

beforeEach(() => {
  observers = []
  globalThis.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) {
      observers.push(callback)
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof globalThis.ResizeObserver
})

afterEach(() => {
  cleanup()
  hook = null
  _resetScrollMemoryForTests()
  globalThis.ResizeObserver = originalResizeObserver
  document.documentElement.removeAttribute('data-keyboard-open')
  document.documentElement.removeAttribute('data-vp-rise')
})

/** A scroller whose view the browser clamps to its end, as a real one does. */
function fakeLayout(el: HTMLDivElement, content: HTMLDivElement) {
  const box = { scrollHeight: 0, clientHeight: 0, scrollTop: 0 }
  const clamp = () => { box.scrollTop = Math.min(box.scrollTop, Math.max(0, box.scrollHeight - box.clientHeight)) }
  Object.defineProperties(el, {
    scrollHeight: { configurable: true, get: () => box.scrollHeight },
    clientHeight: { configurable: true, get: () => box.clientHeight },
    scrollTop: {
      configurable: true,
      get: () => box.scrollTop,
      set: (value: number) => { box.scrollTop = value; clamp() },
    },
  })
  content.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 600, width: 600, bottom: box.scrollHeight, height: box.scrollHeight, toJSON: () => ({}) })
  return {
    box,
    /** Lay out again at a new size; the browser clamps the view if it is past the end. */
    relayout(scrollHeight: number, clientHeight: number) {
      box.scrollHeight = scrollHeight
      box.clientHeight = clientHeight
      clamp()
    },
  }
}

const observe = () => act(() => { for (const callback of observers) callback([], {} as ResizeObserver) })
const scrollEvent = (el: HTMLElement) => act(() => { el.dispatchEvent(new Event('scroll')) })

describe('useAutoFollowScroll and layout changes', () => {
  it('keeps following when the view is clamped by a shrink that is undone before its scroll event', async () => {
    render(<Harness />)
    const el = hook!.scrollRef.current!
    const layout = fakeLayout(el, el.firstElementChild as HTMLDivElement)
    // Sidebar and Review panel open: a narrow chat, followed at its end.
    layout.relayout(1847, 693)
    layout.box.scrollTop = 1154
    await observe()
    await scrollEvent(el)

    // The sidebar closes: for a frame the chat is wide, the transcript
    // shorter, and the browser clamps the view to its new end…
    layout.relayout(1698, 701)
    await observe()
    // …then the panel takes room back before the clamp's scroll event.
    layout.relayout(1775, 701)
    await scrollEvent(el)

    expect(hook!.attachedRef.current).toBe(true)
    expect(hook!.showScrollBtn).toBe(false)
    await observe()
    expect(layout.box.scrollTop).toBe(1775 - 701)
  })

  it('still detaches when the reader scrolls up between layouts', async () => {
    render(<Harness />)
    const el = hook!.scrollRef.current!
    const layout = fakeLayout(el, el.firstElementChild as HTMLDivElement)
    layout.relayout(1847, 693)
    layout.box.scrollTop = 1154
    await observe()
    await scrollEvent(el)

    layout.box.scrollTop = 900
    await scrollEvent(el)

    expect(hook!.attachedRef.current).toBe(false)
    expect(hook!.showScrollBtn).toBe(true)
  })

  // With the keyboard up, a queued steer or the run line grows the composer:
  // the end of the reply must stay above it, not slide under (on-device report).
  it('keeps the end in view when the composer grows while the keyboard is up', async () => {
    render(<Harness />)
    const el = hook!.scrollRef.current!
    const layout = fakeLayout(el, el.firstElementChild as HTMLDivElement)
    layout.relayout(1500, 400)
    layout.box.scrollTop = 1100
    await observe()
    await scrollEvent(el)
    document.documentElement.setAttribute('data-keyboard-open', '')

    layout.relayout(1500, 360)
    await observe()
    expect(layout.box.scrollTop).toBe(1500 - 360)
  })

  it('leaves the keyboard\'s own rise to the settle that follows it', async () => {
    render(<Harness />)
    const el = hook!.scrollRef.current!
    const layout = fakeLayout(el, el.firstElementChild as HTMLDivElement)
    layout.relayout(1500, 700)
    layout.box.scrollTop = 800
    await observe()
    await scrollEvent(el)
    document.documentElement.setAttribute('data-keyboard-open', '')
    document.documentElement.setAttribute('data-vp-rise', '')

    layout.relayout(1500, 400)
    await observe()
    expect(layout.box.scrollTop).toBe(800)
  })
})
