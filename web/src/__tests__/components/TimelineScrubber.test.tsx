import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { useRef } from 'react'

import { TimelineScrubber } from '@/components/AgentView/TimelineScrubber'

// happy-dom has no layout: the scroller is 250px tall over 1000px of content,
// the rail 500px tall, and each marked element sits at a fixed content offset.
const TOPS: Record<string, number> = { p1: 0, p2: 300, question: 900 }
let scrollHeight = 1000
let thumbBox = { top: 250, height: 125 }

function box(top: number, height: number): DOMRect {
  return { top, bottom: top + height, height, left: 0, right: 10, width: 10, x: 0, y: top, toJSON: () => ({}) } as DOMRect
}

const original = {
  rect: HTMLElement.prototype.getBoundingClientRect,
  scrollHeight: Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight'),
  clientHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight'),
}

beforeEach(() => {
  scrollHeight = 1000
  thumbBox = { top: 250, height: 125 }
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (this.hasAttribute('data-transcript-scrubber')) return box(0, 500)
    if (this.hasAttribute('data-scrubber-thumb')) return box(thumbBox.top, thumbBox.height)
    const key = this.dataset.promptId ?? (this.hasAttribute('data-question-waiting') ? 'question' : undefined)
    const scroller = this.closest<HTMLElement>('[data-testid="scroller"]')
    const offset = key === undefined ? 0 : TOPS[key]
    return box(offset - (scroller?.scrollTop ?? 0), 10)
  }
  Object.defineProperty(Element.prototype, 'scrollHeight', {
    configurable: true,
    get(this: Element) { return this.getAttribute('data-testid') === 'scroller' ? scrollHeight : 0 },
  })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) { return this.getAttribute('data-testid') === 'scroller' ? 250 : 0 },
  })
})

afterEach(() => {
  cleanup()
  HTMLElement.prototype.getBoundingClientRect = original.rect
  if (original.scrollHeight) Object.defineProperty(Element.prototype, 'scrollHeight', original.scrollHeight)
  if (original.clientHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', original.clientHeight)
})

function Harness({ question = false, scrollTop = 0 }: {
  question?: boolean
  scrollTop?: number
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  return (
    <div>
      <div
        ref={(el) => {
          scrollRef.current = el
          if (el) el.scrollTop = scrollTop
        }}
        data-testid="scroller"
      >
        <div ref={contentRef}>
          <div data-prompt-id="p1" />
          <div data-prompt-id="p2" />
          {question && <div data-question-waiting="" />}
        </div>
      </div>
      <TimelineScrubber scrollRef={scrollRef} contentRef={contentRef} />
    </div>
  )
}

function marks(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>('[data-scrubber-mark]')]
    .map((el) => `${el.dataset.scrubberMark}@${el.style.top}`)
}

function scroller(container: HTMLElement) {
  return container.querySelector<HTMLElement>('[data-testid="scroller"]')!
}

describe('TimelineScrubber', () => {
  it('stays away while the whole transcript fits', () => {
    scrollHeight = 250
    const { container } = render(<Harness />)

    expect(container.querySelector('[data-transcript-scrubber]')).toBeNull()
  })

  it('shows the view as a thumb over the rail', () => {
    const { container } = render(<Harness scrollTop={500} />)

    const thumb = container.querySelector<HTMLElement>('[data-scrubber-thumb]')!
    expect(thumb.style.top).toContain('50%')
    expect(thumb.style.height).toContain('25%')
  })

  it('keeps the thumb as slim as the native scrollbars elsewhere in the app', () => {
    const { container } = render(<Harness scrollTop={500} />)

    const thumb = container.querySelector<HTMLElement>('[data-scrubber-thumb]')!
    expect(thumb.className.split(' ')).toContain('w-[5px]')
    expect(thumb.className).not.toContain('inset-x-')
  })

  it('marks prompts and a waiting question where they sit', () => {
    const { container } = render(<Harness question />)

    expect(marks(container)).toEqual([
      'prompt@calc(min(0%, 100% - 0.25rem))',
      'prompt@calc(min(30%, 100% - 0.25rem))',
      'question@calc(min(90%, 100% - 0.25rem))',
    ])
  })

  it('moves the thumb as the transcript scrolls', () => {
    const { container } = render(<Harness />)

    scroller(container).scrollTop = 250
    fireEvent.scroll(scroller(container))

    expect(container.querySelector<HTMLElement>('[data-scrubber-thumb]')!.style.top).toContain('25%')
  })

  // A streaming answer grows the transcript every frame. Re-measuring every
  // mark (a layout read per prompt, plus a re-render) each time is the cost.
  it('re-measures marks at most once per window while the transcript grows', () => {
    let now = 1_000
    const realNow = performance.now
    const realSetTimeout = globalThis.setTimeout
    const timers: Array<() => void> = []
    performance.now = () => now
    globalThis.setTimeout = ((callback: () => void) => {
      timers.push(callback)
      return timers.length as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout
    try {
      const { container } = render(<Harness />)
      let promptReads = 0
      const measure = HTMLElement.prototype.getBoundingClientRect
      HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
        if (this.dataset.promptId) promptReads += 1
        return measure.call(this)
      }

      for (let i = 1; i <= 10; i++) {
        scrollHeight = 1_000 + i * 10
        now += 16
        fireEvent.scroll(scroller(container))
      }
      expect(promptReads).toBe(0)
      // The thumb still follows every change.
      expect(container.querySelector<HTMLElement>('[data-scrubber-thumb]')!.style.height).toContain('22.73%')

      now += 200
      act(() => { timers.splice(0).forEach((run) => run()) })
      expect(promptReads).toBe(2)
      expect(marks(container)[1]).toBe('prompt@calc(min(27.27%, 100% - 0.25rem))')
    } finally {
      performance.now = realNow
      globalThis.setTimeout = realSetTimeout
    }
  })

  it('drags the thumb with the grab point kept under the pointer', () => {
    const { container } = render(<Harness scrollTop={500} />)
    const rail = container.querySelector<HTMLElement>('[data-transcript-scrubber]')!

    fireEvent.pointerDown(rail, { button: 0, clientY: 300, pointerId: 1 })
    expect(scroller(container).scrollTop).toBe(500)

    fireEvent.pointerMove(rail, { clientY: 400, pointerId: 1 })
    expect(scroller(container).scrollTop).toBe(700)

    fireEvent.pointerUp(rail, { clientY: 400, pointerId: 1 })
    fireEvent.pointerMove(rail, { clientY: 450, pointerId: 1 })
    expect(scroller(container).scrollTop).toBe(700)
  })

  it('centres the view on the pointer when the rail is pressed off the thumb', () => {
    const { container } = render(<Harness scrollTop={500} />)

    fireEvent.pointerDown(container.querySelector('[data-transcript-scrubber]')!, { button: 0, clientY: 100, pointerId: 1 })

    // 100px down a 500px rail, less half the thumb, is 7.5% of 1000px.
    expect(scroller(container).scrollTop).toBe(75)
  })

  it('scrolls the transcript under a wheel, as a scrollbar would', () => {
    const { container } = render(<Harness scrollTop={500} />)

    fireEvent.wheel(container.querySelector('[data-transcript-scrubber]')!, { deltaY: -120 })

    expect(scroller(container).scrollTop).toBe(380)
  })
})
