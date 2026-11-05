/**
 * useHeightGlide — when the content's height changes, the clip glides from
 * the old height to the new one instead of snapping; the first size is
 * taken as is.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, render } from '@testing-library/react'
import { useRef } from 'react'
import { useHeightGlide } from '@/hooks/useHeightGlide'

type Callback = () => void
let observed: Callback[] = []
const OriginalRO = globalThis.ResizeObserver
let calls: Keyframe[][] = []
const originalAnimate = HTMLElement.prototype.animate

beforeEach(() => {
  observed = []
  calls = []
  globalThis.ResizeObserver = class {
    constructor(cb: Callback) { observed.push(cb) }
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  HTMLElement.prototype.animate = function (this: HTMLElement, frames, options) {
    calls.push(frames as Keyframe[])
    return originalAnimate.call(this, frames, options)
  }
})
afterEach(() => {
  globalThis.ResizeObserver = OriginalRO
  HTMLElement.prototype.animate = originalAnimate
  cleanup()
})

let height = 100
function Box() {
  const outer = useRef<HTMLDivElement>(null)
  const inner = useRef<HTMLDivElement>(null)
  useHeightGlide(outer, inner)
  return (
    <div ref={outer}>
      <div
        ref={(el) => {
          inner.current = el
          if (el) Object.defineProperty(el, 'offsetHeight', { configurable: true, get: () => height })
        }}
      />
    </div>
  )
}

describe('useHeightGlide', () => {
  it('takes the first height as is, then glides to the next one', () => {
    height = 100
    render(<Box />)
    observed[0]()
    expect(calls).toHaveLength(0)
    height = 240
    observed[0]()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual([{ height: '100px' }, { height: '240px' }])
  })

  it('does nothing when the height did not change', () => {
    height = 100
    render(<Box />)
    observed[0]()
    observed[0]()
    expect(calls).toHaveLength(0)
  })
})
