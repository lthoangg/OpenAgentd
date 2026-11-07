/**
 * When "Jump to latest" shows: while the reader is away from the end and the
 * transcript is not following. Folds (tool rows, reader folds) move the view
 * themselves as they open and close; that never reads as the reader leaving
 * the end, and a fold that sets the reader down on the end takes the chip away.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { _resetScrollMemoryForTests, useAutoFollowScroll } from '@/hooks/useAutoFollowScroll'
import { useStickyFold } from '@/hooks/useStickyFold'
import { useFakeTimers } from '../fake-timers'

let hook: ReturnType<typeof useAutoFollowScroll> | null = null
let observers: ResizeObserverCallback[] = []
const originalResizeObserver = globalThis.ResizeObserver
const originalMatchMedia = window.matchMedia

/** A fold whose header pins while it is open, as a tool row or a reader fold does. */
function Fold() {
  const { open, setOpen, close, anchorRef } = useStickyFold()
  return (
    <>
      <button ref={anchorRef} type="button" onClick={(event) => (open ? close(event.currentTarget) : setOpen(true))}>fold</button>
      {open && <div>steps</div>}
    </>
  )
}

function Harness() {
  hook = useAutoFollowScroll({ totalLen: 1, isEmpty: false })
  return (
    <div ref={hook.scrollRef} style={{ overflowY: 'auto' }}>
      <div ref={hook.contentRef}><Fold /></div>
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
  window.matchMedia = originalMatchMedia
})

function rect(top: number, height: number): DOMRect {
  return { x: 0, y: top, top, left: 0, right: 600, width: 600, bottom: top + height, height, toJSON: () => ({}) } as DOMRect
}

const observe = () => act(() => { for (const callback of observers) callback([], {} as ResizeObserver) })
const scrollEvent = (el: HTMLElement) => act(() => { el.dispatchEvent(new Event('scroll')) })
const chip = () => hook!.showScrollBtn

/** A 3000px transcript in a 600px view that the browser clamps to its end, followed at that end. */
function setup() {
  render(<Harness />)
  const el = hook!.scrollRef.current!
  const box = { scrollHeight: 3000, clientHeight: 600, scrollTop: 2400 }
  const clamp = () => { box.scrollTop = Math.min(box.scrollTop, Math.max(0, box.scrollHeight - box.clientHeight)) }
  Object.defineProperties(el, {
    scrollHeight: { configurable: true, get: () => box.scrollHeight },
    clientHeight: { configurable: true, get: () => box.clientHeight },
    scrollTop: { configurable: true, get: () => box.scrollTop, set: (value: number) => { box.scrollTop = value; clamp() } },
  })
  hook!.contentRef.current!.getBoundingClientRect = () => rect(0, box.scrollHeight)
  const glides: ScrollToOptions[] = []
  el.scrollTo = ((options: ScrollToOptions) => { glides.push(options) }) as typeof el.scrollTo
  observe()
  scrollEvent(el)
  const header = el.querySelector('button')!
  return {
    el,
    box,
    glides,
    /** The transcript is laid out at a new height; the browser clamps the view if it is past the end. */
    relayout(scrollHeight: number) {
      box.scrollHeight = scrollHeight
      clamp()
    },
    /** Open the fold, then close it from its header: pressed at ``pressedTop``, it sits at ``closedTop`` once unpinned. */
    openAndClose(pressedTop: number, closedTop: number) {
      act(() => header.click())
      const tops = [pressedTop, closedTop]
      header.getBoundingClientRect = () => rect(tops.shift() ?? closedTop, 20)
      act(() => header.click())
    },
  }
}

describe('useAutoFollowScroll — folds', () => {
  it('keeps following when a fold closes in place at the end, with no chip', () => {
    const timers = useFakeTimers()
    try {
      const { el, box, relayout, openAndClose } = setup()
      // Opened at the end, the steps pushed the header up to its pinned place
      // at the top; unpinned, it is 800px further up.
      openAndClose(0, -800)
      // The header stays where it was pressed.
      expect(box.scrollTop).toBe(1600)
      scrollEvent(el)
      expect(chip()).toBe(false)

      // The steps fold away under the header; following does not pull it off its place meanwhile.
      relayout(2600)
      observe()
      scrollEvent(el)
      expect(box.scrollTop).toBe(1600)
      expect(chip()).toBe(false)

      // The fold lands with the end in view: the transcript follows on.
      relayout(2200)
      observe()
      scrollEvent(el)
      act(() => timers.tick(400))
      expect(hook!.attachedRef.current).toBe(true)
      expect(el.dataset.follow).toBe('live')
      expect(chip()).toBe(false)
    } finally {
      timers.restore()
    }
  })

  it('leaves a reader who closes a fold reading, the header where they pressed it', () => {
    const { el, box, openAndClose } = setup()
    box.scrollTop = 1500
    scrollEvent(el)
    expect(chip()).toBe(true)

    openAndClose(0, -300)
    expect(box.scrollTop).toBe(1200)
    scrollEvent(el)

    expect(hook!.attachedRef.current).toBe(false)
    expect(chip()).toBe(true)
  })

  it('takes the chip away when a fold closing sets the reader down on the end', () => {
    const { el, box, relayout } = setup()
    box.scrollTop = 2250
    scrollEvent(el)
    expect(chip()).toBe(true)

    // A fold above closes: the browser clamps the view onto the new end.
    relayout(2700)
    scrollEvent(el)

    expect(box.scrollTop).toBe(2100)
    expect(chip()).toBe(false)
    // Not following yet: if the layout grows back, what they read stays put.
    expect(hook!.attachedRef.current).toBe(false)
  })

  it('follows again when the reader scrolls down from the end, which moves nothing', () => {
    const { el, box, relayout } = setup()
    box.scrollTop = 2250
    scrollEvent(el)
    relayout(2700)
    scrollEvent(el)

    // Nothing is below, so the wheel makes no scroll event of its own.
    fireEvent.wheel(el, { deltaY: 100 })

    expect(hook!.attachedRef.current).toBe(true)
    expect(el.dataset.follow).toBe('live')
    expect(chip()).toBe(false)
  })

  it('follows again when the reader presses End at the end', () => {
    const { el, box, relayout } = setup()
    box.scrollTop = 2250
    scrollEvent(el)
    relayout(2700)
    scrollEvent(el)

    act(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })) })

    expect(hook!.attachedRef.current).toBe(true)
  })

  it('brings the chip back when content arrives below a reader sitting at the end', () => {
    const { el, box, relayout } = setup()
    box.scrollTop = 2250
    scrollEvent(el)
    relayout(2700)
    scrollEvent(el)
    expect(chip()).toBe(false)

    relayout(3000)
    observe()

    expect(box.scrollTop).toBe(2100)
    expect(chip()).toBe(true)
  })
})

describe('useAutoFollowScroll — the chip after a jump', () => {
  it('shows when the app takes the view away from the end (a prompt jump)', () => {
    const { el, box } = setup()
    act(() => {
      hook!.attachedRef.current = false
      hook!.syncAnchor()
    })
    box.scrollTop = 900
    scrollEvent(el)

    expect(chip()).toBe(true)
  })

  it('leaves a reader who scrolls against the glide to the end where they scrolled', () => {
    const timers = useFakeTimers()
    try {
      const { el, box, glides } = setup()
      box.scrollTop = 1800
      scrollEvent(el)
      act(() => hook!.jumpToLatest())
      expect(glides).toHaveLength(1)

      // Mid-glide the reader scrolls back up; the browser drops the glide.
      fireEvent.wheel(el, { deltaY: -100 })
      box.scrollTop = 1500
      act(() => { el.dispatchEvent(new Event('scrollend')) })
      act(() => timers.tick(700))

      expect(box.scrollTop).toBe(1500)
      expect(hook!.attachedRef.current).toBe(false)
      expect(chip()).toBe(true)
    } finally {
      timers.restore()
    }
  })
})

describe('useAutoFollowScroll — Jump to latest', () => {
  it('glides from up to two screens away', () => {
    const { el, box, glides } = setup()
    box.scrollTop = 1800
    scrollEvent(el)

    act(() => hook!.jumpToLatest())

    expect(glides).toEqual([{ top: 2400, behavior: 'smooth' }])
  })

  it('from further back cuts to a screen above the end, then glides', () => {
    const { el, box, glides } = setup()
    box.scrollTop = 0
    scrollEvent(el)

    act(() => hook!.jumpToLatest())

    expect(glides).toEqual([{ top: 2400, behavior: 'smooth' }])
    expect(box.scrollTop).toBeGreaterThan(0)
    expect(chip()).toBe(false)
  })

  it('jumps without a glide when the system asks for reduced motion', () => {
    window.matchMedia = ((query: string) => ({ matches: query.includes('reduce'), media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia
    const { el, box, glides } = setup()
    box.scrollTop = 1800
    scrollEvent(el)

    act(() => hook!.jumpToLatest())

    expect(glides).toEqual([])
    expect(box.scrollTop).toBe(2400)
  })
})
