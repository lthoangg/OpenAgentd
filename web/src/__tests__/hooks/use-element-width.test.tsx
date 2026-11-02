import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { useRef } from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'

import { useElementWidth, useElementWidthSelect } from '@/hooks/use-element-width'

let observed: (() => void) | null = null
let width = 1000
// rAF is async in browsers: queue frames and flush them explicitly.
const frames: FrameRequestCallback[] = []
const realResizeObserver = globalThis.ResizeObserver
const realRaf = globalThis.requestAnimationFrame

beforeEach(() => {
  width = 1000
  observed = null
  frames.length = 0
  globalThis.ResizeObserver = class {
    constructor(callback: () => void) { observed = callback }
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => frames.push(callback)) as typeof requestAnimationFrame
})

afterEach(() => {
  cleanup()
  globalThis.ResizeObserver = realResizeObserver
  globalThis.requestAnimationFrame = realRaf
})

function measuredRef(node: HTMLDivElement | null, ref: { current: HTMLDivElement | null }) {
  if (node) node.getBoundingClientRect = () => ({ width }) as DOMRect
  ref.current = node
}

function resizeTo(next: number) {
  width = next
  act(() => {
    observed?.()
    while (frames.length > 0) frames.shift()?.(0)
  })
}

const isNarrow = (w: number) => w < 740

describe('useElementWidthSelect', () => {
  it('re-renders only when the selected value changes', () => {
    let renders = 0
    function Probe() {
      const ref = useRef<HTMLDivElement | null>(null)
      const narrow = useElementWidthSelect(ref, isNarrow)
      renders += 1
      return <div ref={(node) => measuredRef(node, ref)}>{narrow ? 'narrow' : 'wide'}</div>
    }
    render(<Probe />)
    expect(screen.getByText('wide')).toBeTruthy()
    const settled = renders

    resizeTo(900)
    resizeTo(800)
    expect(renders).toBe(settled)

    resizeTo(700)
    expect(screen.getByText('narrow')).toBeTruthy()
    expect(renders).toBe(settled + 1)
  })
})

describe('useElementWidth', () => {
  it('tracks the rounded element width', () => {
    function Probe() {
      const ref = useRef<HTMLDivElement | null>(null)
      const value = useElementWidth(ref)
      return <div ref={(node) => measuredRef(node, ref)}>{value}</div>
    }
    render(<Probe />)
    expect(screen.getByText('1000')).toBeTruthy()

    resizeTo(812.6)
    expect(screen.getByText('813')).toBeTruthy()
  })

  // A neighbour that knows the width is about to change says so in its own
  // commit; a ResizeObserver callback would come a frame or more later.
  it('re-measures at once, without waiting for a frame, when remeasureOn calls back', () => {
    let remeasure: (() => void) | null = null
    const remeasureOn = (_node: HTMLElement, callback: () => void) => {
      remeasure = callback
      return () => { remeasure = null }
    }
    function Probe() {
      const ref = useRef<HTMLDivElement | null>(null)
      const value = useElementWidth(ref, undefined, remeasureOn)
      return <div ref={(node) => measuredRef(node, ref)}>{value}</div>
    }
    const view = render(<Probe />)
    width = 1200

    act(() => remeasure?.())

    expect(frames).toHaveLength(0)
    expect(screen.getByText('1200')).toBeTruthy()
    view.unmount()
    expect(remeasure).toBeNull()
  })
})
