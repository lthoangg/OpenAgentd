/**
 * Reordered sidebar rows slide from their old place instead of jumping; other
 * updates move nothing and read no layout. happy-dom has no layout, so rows
 * report a fake `offsetTop` / `offsetHeight` from their index and `animate`
 * is recorded.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, render } from '@testing-library/react'
import { useRef } from 'react'
import { useFlipReorder } from '@/hooks/useFlipReorder'

const ROW = 28
const calls: { id: string; keyframes: Keyframe[] }[] = []
let layoutReads = 0
const proto = HTMLElement.prototype as unknown as Record<string, unknown>
const saved = {
  offsetTop: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetTop'),
  offsetHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight'),
  offsetParent: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent'),
  animate: proto.animate,
}

beforeEach(() => {
  calls.length = 0
  layoutReads = 0
  Object.defineProperty(HTMLElement.prototype, 'offsetTop', {
    configurable: true,
    get(this: HTMLElement) {
      layoutReads += 1
      return this.dataset.flipId ? Array.from(this.parentElement!.children).indexOf(this) * ROW : 0
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.dataset.flipId ? ROW : 0
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get(this: HTMLElement) {
      return this.parentElement
    },
  })
  proto.animate = function (this: HTMLElement, keyframes: Keyframe[]) {
    calls.push({ id: this.dataset.flipId ?? '', keyframes })
    return { cancel() {} }
  }
})

afterEach(() => {
  cleanup()
  if (saved.offsetTop) Object.defineProperty(HTMLElement.prototype, 'offsetTop', saved.offsetTop)
  if (saved.offsetHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', saved.offsetHeight)
  if (saved.offsetParent) Object.defineProperty(HTMLElement.prototype, 'offsetParent', saved.offsetParent)
  proto.animate = saved.animate
})

function List({ ids, label = '', header = false }: { ids: string[]; label?: string; header?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useFlipReorder(ref)
  return (
    <div ref={ref}>
      {header && <div>draft</div>}
      {ids.map((id) => <div key={id} data-flip-id={id}>{id}{label}</div>)}
    </div>
  )
}

describe('useFlipReorder', () => {
  it('does not animate the first render or an update that keeps the order', () => {
    const { rerender } = render(<List ids={['a', 'b', 'c']} />)
    rerender(<List ids={['a', 'b', 'c']} label="!" />)
    expect(calls).toEqual([])
  })

  it('slides a row moved to the top and the rows it pushed down', () => {
    const { rerender } = render(<List ids={['a', 'b', 'c']} />)
    rerender(<List ids={['c', 'a', 'b']} />)

    const transforms = Object.fromEntries(calls.map((call) => [call.id, call.keyframes[0].transform]))
    expect(transforms).toEqual({
      c: `translateY(${2 * ROW}px)`,
      a: `translateY(${-ROW}px)`,
      b: `translateY(${-ROW}px)`,
    })
  })

  it('fades in a row that was not listed before', () => {
    const { rerender } = render(<List ids={['a', 'b']} />)
    rerender(<List ids={['n', 'a', 'b']} />)

    expect(calls.find((call) => call.id === 'n')?.keyframes[0]).toEqual({ opacity: 0 })
  })

  it('reads no layout on a commit that keeps the order', () => {
    const { rerender } = render(<List ids={['a', 'b', 'c']} />)
    layoutReads = 0
    rerender(<List ids={['a', 'b', 'c']} label="!" />)
    rerender(<List ids={['a', 'b', 'c']} label="?" />)
    expect(layoutReads).toBe(0)
  })

  it('re-reads positions when the list height changes, so the next slide starts right', () => {
    const observers: ResizeObserverCallback[] = []
    const original = globalThis.ResizeObserver
    globalThis.ResizeObserver = class {
      private readonly callback: ResizeObserverCallback
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback
        observers.push(callback)
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver
    try {
      const { rerender } = render(<List ids={['a', 'b']} />)
      const resize = (height: number) => {
        for (const callback of observers) callback([{ contentRect: { height } } as ResizeObserverEntry], {} as ResizeObserver)
      }
      resize(2 * ROW)
      // A row without an id appears on top: same order, every row one lower.
      rerender(<List ids={['a', 'b']} header />)
      resize(3 * ROW)
      rerender(<List ids={['b', 'a']} header />)

      const transforms = Object.fromEntries(calls.map((call) => [call.id, call.keyframes[0].transform]))
      expect(transforms).toEqual({ b: `translateY(${ROW}px)`, a: `translateY(${-ROW}px)` })
    } finally {
      globalThis.ResizeObserver = original
    }
  })

  it('leaves rows that are off screen before and after alone', () => {
    const ids = 'abcdefghij'.split('')
    // A scroller two rows tall: rows 0 and 1 are on screen.
    const viewport = (el: HTMLDivElement | null) => {
      if (el) Object.defineProperty(el, 'clientHeight', { configurable: true, value: 2 * ROW })
    }
    const Scrolled = ({ order }: { order: string[] }) => (
      <div ref={viewport} style={{ overflowY: 'auto' }}><List ids={order} /></div>
    )
    const { rerender } = render(<Scrolled order={ids} />)
    rerender(<Scrolled order={['j', ...ids.slice(0, 9)]} />)

    // j lands on screen, a stays on it, b leaves it; c..i never show.
    expect(calls.map((call) => call.id).sort()).toEqual(['a', 'b', 'j'])
  })
})
