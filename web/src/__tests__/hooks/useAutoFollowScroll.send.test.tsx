/**
 * Sending returns the transcript to its end: a glide when the reader was a
 * short way up, a jump from further back. While that glide (or Jump to
 * latest) runs, a streamed delta does not cut it short with an instant
 * write; it lands on the new end when the glide finishes.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, render } from '@testing-library/react'
import { _resetScrollMemoryForTests, useAutoFollowScroll } from '@/hooks/useAutoFollowScroll'
import { useFakeTimers } from '../fake-timers'

let hook: ReturnType<typeof useAutoFollowScroll> | null = null
const originalResizeObserver = globalThis.ResizeObserver

function Harness({ totalLen, isUserMessage, lastContent }: { totalLen: number; isUserMessage: boolean; lastContent: string }) {
  hook = useAutoFollowScroll({ totalLen, isUserMessage, lastContent, isEmpty: false })
  return (
    <div ref={hook.scrollRef}>
      <div ref={hook.contentRef}>content</div>
    </div>
  )
}

beforeEach(() => {
  globalThis.ResizeObserver = class {
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
})

function fakeScroller(el: HTMLDivElement) {
  const box = { scrollHeight: 3000, clientHeight: 600, scrollTop: 0 }
  const glides: ScrollToOptions[] = []
  Object.defineProperties(el, {
    scrollHeight: { configurable: true, get: () => box.scrollHeight },
    clientHeight: { configurable: true, get: () => box.clientHeight },
    scrollTop: { configurable: true, get: () => box.scrollTop, set: (v: number) => { box.scrollTop = v } },
  })
  el.scrollTo = ((options: ScrollToOptions) => { glides.push(options) }) as typeof el.scrollTo
  return { box, glides }
}

function setup(scrollTop: number) {
  const view = render(<Harness totalLen={1} isUserMessage={false} lastContent="a" />)
  const el = hook!.scrollRef.current!
  const scroller = fakeScroller(el)
  scroller.box.scrollTop = scrollTop
  hook!.attachedRef.current = false
  return { ...view, el, ...scroller }
}

describe('useAutoFollowScroll — sending', () => {
  it('glides to the end when the reader was a screen up', () => {
    const { rerender, glides, box } = setup(1800)
    rerender(<Harness totalLen={2} isUserMessage lastContent="hi" />)
    expect(glides).toEqual([{ top: 2400, behavior: 'smooth' }])
    expect(box.scrollTop).toBe(1800)
  })

  it('jumps when the reader was far back', () => {
    const { rerender, glides, box } = setup(0)
    rerender(<Harness totalLen={2} isUserMessage lastContent="hi" />)
    expect(glides).toEqual([])
    expect(box.scrollTop).toBe(2400)
  })

  it('lets a glide run while deltas stream in, then lands on the new end', () => {
    // Hold the glide's fallback timer: a slow parallel run must not end it.
    const timers = useFakeTimers()
    const { rerender, glides, box, el } = setup(1800)
    rerender(<Harness totalLen={2} isUserMessage lastContent="hi" />)
    expect(glides).toHaveLength(1)

    box.scrollHeight = 3200
    rerender(<Harness totalLen={3} isUserMessage={false} lastContent="hello" />)
    expect(box.scrollTop).toBe(1800)

    act(() => { el.dispatchEvent(new Event('scrollend')) })
    timers.restore()
    expect(box.scrollTop).toBe(2600)
  })
})
