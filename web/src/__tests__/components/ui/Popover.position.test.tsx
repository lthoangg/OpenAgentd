/**
 * A popover places itself before the frame that shows it. It mounts hidden
 * (it must measure itself to know where to go); placed in a passive effect,
 * its state update waited for a scheduler task, and content that focuses a
 * field on the next frame (the run picker's model search) found it still
 * hidden in WebKit, so the focus was lost and typing did nothing.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { act, cleanup, render } from '@testing-library/react'

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

const actEnv = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
let root: Root | null = null
let host: HTMLElement | null = null
let previousActEnv: boolean | undefined

afterEach(() => {
  flushSync(() => root?.unmount())
  host?.remove()
  root = null
  host = null
  actEnv.IS_REACT_ACT_ENVIRONMENT = previousActEnv
})

function Harness({ open }: { open: boolean }) {
  return (
    <Popover open={open}>
      <PopoverTrigger>Open</PopoverTrigger>
      <PopoverContent aria-label="Picker">
        <input aria-label="Search" />
      </PopoverContent>
    </Popover>
  )
}

describe('PopoverContent placement', () => {
  it('is visible as soon as the update that opens it commits, with no scheduler task in between', () => {
    // Real scheduling, not act(): act would flush the deferred work too.
    previousActEnv = actEnv.IS_REACT_ACT_ENVIRONMENT
    actEnv.IS_REACT_ACT_ENVIRONMENT = false
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    flushSync(() => root?.render(<Harness open={false} />))

    flushSync(() => root?.render(<Harness open />))

    const content = document.querySelector<HTMLElement>('[data-slot="popover-content"]')
    expect(content).not.toBeNull()
    expect(content?.style.visibility).toBe('visible')
    const search = document.querySelector<HTMLInputElement>('input[aria-label="Search"]')
    search?.focus()
    expect(document.activeElement).toBe(search)
  })
})

describe('PopoverContent above its trigger', () => {
  const realRect = Element.prototype.getBoundingClientRect
  const realObserver = globalThis.ResizeObserver
  let contentHeight = 300
  const resized: Array<() => void> = []

  afterEach(() => {
    cleanup()
    Element.prototype.getBoundingClientRect = realRect
    globalThis.ResizeObserver = realObserver
    resized.length = 0
    contentHeight = 300
  })

  // A trigger near the bottom of a 768px window (a composer's run chip).
  function renderAbove() {
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const slot = this.getAttribute('data-slot')
      if (slot === 'popover-trigger') return { top: 700, bottom: 728, left: 100, right: 180, width: 80, height: 28 } as DOMRect
      if (slot === 'popover-content') return { top: 0, bottom: contentHeight, left: 0, right: 300, width: 300, height: contentHeight } as DOMRect
      return realRect.call(this)
    }
    globalThis.ResizeObserver = class {
      constructor(callback: () => void) { resized.push(callback) }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver
    render(
      <Popover open>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent side="top" align="start" sideOffset={8} aria-label="Picker">
          <p>rows</p>
        </PopoverContent>
      </Popover>,
    )
    return document.querySelector<HTMLElement>('[data-slot="popover-content"]')!
  }

  // Placed by its top edge, a picker whose list a search shortened was
  // left hanging above the chip, the gap growing with every key.
  it('keeps its bottom edge on the trigger whatever its height', () => {
    const content = renderAbove()

    expect(content.style.top).toBe('692px')
    expect(content.style.translate).toBe('0 -100%')
  })

  it('places itself again when its content resizes, below once it no longer fits above', () => {
    const content = renderAbove()
    contentHeight = 720

    act(() => resized.forEach((callback) => callback()))

    expect(content.style.top).toBe('736px')
    expect(content.style.translate).toBe('')
  })
})
