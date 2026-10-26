import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, render } from '@testing-library/react'
import { _resetScrollMemoryForTests, useScrollMemory } from '@/hooks/useScrollMemory'

function View({ memoryKey }: { memoryKey: string }) {
  const ref = useScrollMemory(memoryKey)
  return <div ref={ref} data-testid="scroller" />
}

/** Content height the fake layout clamps scrollTop to. */
let maxScroll = 10_000
const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTop')
const tops = new WeakMap<Element, number>()

beforeEach(() => {
  _resetScrollMemoryForTests()
  maxScroll = 10_000
  Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
    configurable: true,
    get(this: Element) { return tops.get(this) ?? 0 },
    set(this: Element, value: number) { tops.set(this, Math.max(0, Math.min(value, maxScroll))) },
  })
})

afterEach(() => {
  cleanup()
  if (descriptor) Object.defineProperty(HTMLElement.prototype, 'scrollTop', descriptor)
})

const scroller = (root: HTMLElement) => root.querySelector('[data-testid="scroller"]') as HTMLElement

function scrollTo(el: HTMLElement, top: number) {
  act(() => {
    el.scrollTop = top
    el.dispatchEvent(new Event('scroll'))
  })
}

async function frames(count: number) {
  for (let i = 0; i < count; i++) {
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
    })
  }
}

describe('useScrollMemory', () => {
  it('puts a remounted view back where it was left', () => {
    const first = render(<View memoryKey="plan:s-1" />)
    scrollTo(scroller(first.container), 420)
    first.unmount()

    const again = render(<View memoryKey="plan:s-1" />)
    expect(scroller(again.container).scrollTop).toBe(420)
  })

  it('keeps each key to itself', () => {
    const plan = render(<View memoryKey="plan:s-1" />)
    scrollTo(scroller(plan.container), 420)
    plan.unmount()

    const other = render(<View memoryKey="plan:s-2" />)
    expect(scroller(other.container).scrollTop).toBe(0)
  })

  it('waits for late content to grow tall enough', async () => {
    const first = render(<View memoryKey="file:a.ts" />)
    scrollTo(scroller(first.container), 800)
    first.unmount()

    maxScroll = 0 // still loading
    const again = render(<View memoryKey="file:a.ts" />)
    expect(scroller(again.container).scrollTop).toBe(0)
    maxScroll = 10_000 // loaded
    await frames(2)
    expect(scroller(again.container).scrollTop).toBe(800)
  })

  it('lets the reader take over before late content arrives', async () => {
    const first = render(<View memoryKey="file:a.ts" />)
    scrollTo(scroller(first.container), 800)
    first.unmount()

    maxScroll = 0
    const again = render(<View memoryKey="file:a.ts" />)
    act(() => {
      scroller(again.container).dispatchEvent(new Event('wheel'))
    })
    maxScroll = 10_000
    await frames(2)
    expect(scroller(again.container).scrollTop).toBe(0)
  })

  it('yields to other code that moves the view, such as a reveal', async () => {
    const first = render(<View memoryKey="file:a.ts" />)
    scrollTo(scroller(first.container), 800)
    first.unmount()

    maxScroll = 100
    const again = render(<View memoryKey="file:a.ts" />)
    maxScroll = 10_000
    act(() => {
      scroller(again.container).scrollTop = 50 // a reveal centres line 3
    })
    await frames(2)
    expect(scroller(again.container).scrollTop).toBe(50)
  })
})
