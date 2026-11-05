/**
 * BottomSheet detents: medium (half the screen) and large (92%), dragged
 * between from the handle or the content, closed by a pull past 120px below
 * the lowest, and fitted to content shorter than medium.
 *
 * happy-dom has no layout, so the content's height and the viewport's are
 * stubbed (800px: medium 400, large 736), and the clock is the test's own, so
 * a drag has no release speed unless it is given one (``gapMs``).
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { ComponentProps } from 'react'

let reducedMotion = false
mock.module('@/hooks/useReducedMotion', () => ({ useReducedMotion: () => reducedMotion }))

import { BottomSheet } from '@/components/ui/bottom-sheet'
import { SHEET_CLOSE_DISTANCE } from '@/components/ui/_sheet'

const VIEWPORT = 800
const MEDIUM = 400
const LARGE = 736
/** The handle (24px); the sheet adds nothing else around its content here. */
const HANDLE = 24

let contentHeight = 1000
let now = 0
let frames: Array<(at: number) => void> = []
const realNow = performance.now
const realRaf = globalThis.requestAnimationFrame
const realCancel = globalThis.cancelAnimationFrame
const realOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
const realInnerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight')

beforeEach(() => {
  contentHeight = 1000
  reducedMotion = false
  now = 0
  frames = []
  Object.defineProperty(window, 'innerHeight', { value: VIEWPORT, configurable: true, writable: true })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      if (this.hasAttribute('data-sheet-content')) return contentHeight
      if (this.hasAttribute('data-sheet-handle')) return HANDLE
      return 0
    },
  })
  performance.now = () => now
  globalThis.requestAnimationFrame = ((callback: (at: number) => void) => frames.push(callback)) as typeof requestAnimationFrame
  globalThis.cancelAnimationFrame = (() => { frames = [] }) as typeof cancelAnimationFrame
})

afterEach(() => {
  cleanup()
  performance.now = realNow
  globalThis.requestAnimationFrame = realRaf
  globalThis.cancelAnimationFrame = realCancel
  if (realOffsetHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', realOffsetHeight)
  if (realInnerHeight) Object.defineProperty(window, 'innerHeight', realInnerHeight)
})

/** Run the spring frames until everything has come to rest. */
function settle() {
  act(() => {
    let at = 0
    while (frames.length && at < 5000) {
      const queued = frames
      frames = []
      at += 16
      for (const callback of queued) callback(at)
    }
  })
}

type Props = Partial<ComponentProps<typeof BottomSheet>>
const sheetEl = () => document.querySelector<HTMLElement>('[data-bottom-sheet]')!
const bodyEl = () => document.querySelector<HTMLElement>('[data-sheet-body]')!
const handleEl = () => document.querySelector<HTMLElement>('[data-sheet-handle]')!
const contentEl = () => document.querySelector<HTMLElement>('[data-testid="content"]')!
const heightOf = () => sheetEl().style.height
const scrimOpacity = () => document.querySelector<HTMLElement>('[data-sheet-scrim]')!.style.opacity

function renderSheet(props: Props = {}) {
  const onClose = mock(() => {})
  const sheet = (next: Props = {}) => (
    <BottomSheet open onClose={onClose} label="Model and thinking" detents={['medium', 'large']} {...props} {...next}>
      <div data-testid="content">rows</div>
    </BottomSheet>
  )
  const view = render(sheet())
  return { onClose, rerender: (next: Props = {}) => view.rerender(sheet(next)) }
}

/**
 * A one-finger touch through ``ys`` starting on ``target``. ``gapMs`` between
 * samples sets the release speed (0: none). ``end: false`` holds the finger.
 */
function touch(target: Element, ys: number[], { gapMs = 0, end = true }: { gapMs?: number; end?: boolean } = {}): TouchEvent[] {
  const at = (y: number) => [{ clientX: 100, clientY: y, target } as unknown as Touch]
  const moves: TouchEvent[] = []
  act(() => {
    target.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true, touches: at(ys[0]) }))
    for (const y of ys.slice(1)) {
      now += gapMs
      const move = new TouchEvent('touchmove', { bubbles: true, cancelable: true, touches: at(y) })
      target.dispatchEvent(move)
      moves.push(move)
    }
    if (end) target.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true, touches: [] }))
  })
  return moves
}

function dragHandle(ys: number[], { gapMs = 0 } = {}) {
  const handle = handleEl()
  act(() => {
    fireEvent.pointerDown(handle, { pointerId: 1, isPrimary: true, clientY: ys[0] })
    for (const y of ys.slice(1)) {
      now += gapMs
      fireEvent.pointerMove(handle, { pointerId: 1, isPrimary: true, clientY: y })
    }
    fireEvent.pointerUp(handle, { pointerId: 1, isPrimary: true, clientY: ys[ys.length - 1] })
  })
}

describe('BottomSheet detents — where it rests', () => {
  it('opens at medium, half the screen', () => {
    renderSheet()
    expect(sheetEl().dataset.detent).toBe('medium')
    expect(heightOf()).toBe(`${MEDIUM}px`)
  })

  it('opens at the detent it is given', () => {
    renderSheet({ initialDetent: 'large' })
    expect(sheetEl().dataset.detent).toBe('large')
    expect(heightOf()).toBe(`${LARGE}px`)
  })

  it('stops at 92% of the screen, not 85%', () => {
    renderSheet()
    expect(sheetEl().className).toContain('max-h-[92dvh]')
    expect(sheetEl().className).not.toContain('85dvh')
  })

  it('has one height by default: the content\'s, as before', () => {
    renderSheet({ detents: undefined })
    expect(sheetEl().dataset.detent).toBe('fit')
    expect(heightOf()).toBe('')
  })

  it('fits content shorter than medium, with nothing to drag between', () => {
    contentHeight = 200
    renderSheet()
    expect(sheetEl().dataset.detent).toBe('fit')
    expect(heightOf()).toBe('')
    // Pulling up has nothing to expand to, and the wheel is left to the content.
    const moves = touch(contentEl(), [500, 450, 300])
    expect(moves.some((move) => move.defaultPrevented)).toBe(false)
    expect(fireEvent.wheel(bodyEl(), { deltaY: 60 })).toBe(true)
    expect(heightOf()).toBe('')
  })

  it('rests no taller than its content between medium and large', () => {
    contentHeight = 500 - HANDLE
    renderSheet()
    expect(heightOf()).toBe(`${MEDIUM}px`)
    touch(contentEl(), [500, 450, 300])
    settle()
    expect(heightOf()).toBe('500px')
  })

  it('keeps its detent while the content changes, and fits once the content is short', () => {
    const { rerender } = renderSheet()
    contentHeight = 1400
    rerender()
    expect(sheetEl().dataset.detent).toBe('medium')
    expect(heightOf()).toBe(`${MEDIUM}px`)
    contentHeight = 200
    rerender()
    expect(sheetEl().dataset.detent).toBe('fit')
    expect(heightOf()).toBe('')
    contentHeight = 1000
    rerender()
    expect(sheetEl().dataset.detent).toBe('medium')
    expect(heightOf()).toBe(`${MEDIUM}px`)
  })

  it('under reduced motion has no drag and opens at the tallest, where all of the content scrolls', () => {
    reducedMotion = true
    const { onClose } = renderSheet()
    expect(sheetEl().dataset.detent).toBe('large')
    expect(heightOf()).toBe(`${LARGE}px`)
    const moves = touch(contentEl(), [300, 310, 700])
    expect(moves.some((move) => move.defaultPrevented)).toBe(false)
    expect(onClose).not.toHaveBeenCalled()
    expect(sheetEl().style.translate).toBe('')
  })
})

describe('BottomSheet detents — moving between them', () => {
  it('follows the finger as it pulls up from medium, and no further than large', () => {
    renderSheet()
    touch(contentEl(), [500, 480, 400], { end: false })
    expect(heightOf()).toBe('500px')
    touch(contentEl(), [900, 800, -400], { end: false })
    expect(heightOf()).toBe(`${LARGE}px`)
  })

  it('expands to large on a pull up from the content, and holds the page still while it does', () => {
    renderSheet()
    const moves = touch(contentEl(), [500, 450, 400, 300])
    expect(moves.every((move) => move.defaultPrevented)).toBe(true)
    settle()
    expect(sheetEl().dataset.detent).toBe('large')
    expect(heightOf()).toBe(`${LARGE}px`)
  })

  it('settles back on medium when a pull up falls nearer to it', () => {
    renderSheet()
    touch(contentEl(), [500, 480, 440])
    settle()
    expect(sheetEl().dataset.detent).toBe('medium')
    expect(heightOf()).toBe(`${MEDIUM}px`)
  })

  it('scrolls first only once it is at its tallest: up on the content then is the content\'s', () => {
    renderSheet()
    touch(contentEl(), [500, 450, 300])
    settle()
    const moves = touch(contentEl(), [500, 450, 300])
    expect(moves.some((move) => move.defaultPrevented)).toBe(false)
    expect(heightOf()).toBe(`${LARGE}px`)
  })

  it('expands on a wheel scroll down at medium, and leaves the wheel alone at large', () => {
    renderSheet()
    expect(fireEvent.wheel(bodyEl(), { deltaY: 60 })).toBe(false)
    settle()
    expect(sheetEl().dataset.detent).toBe('large')
    expect(heightOf()).toBe(`${LARGE}px`)
    expect(fireEvent.wheel(bodyEl(), { deltaY: 60 })).toBe(true)
    // Up never expands.
    cleanup()
    renderSheet()
    expect(fireEvent.wheel(bodyEl(), { deltaY: -60 })).toBe(true)
    expect(heightOf()).toBe(`${MEDIUM}px`)
  })

  it('leaves a scrolled list to scroll: only a sheet with nothing scrolled above is dragged', () => {
    renderSheet()
    bodyEl().scrollTop = 30
    const moves = touch(contentEl(), [500, 450, 300])
    expect(moves.some((move) => move.defaultPrevented)).toBe(false)
    expect(heightOf()).toBe(`${MEDIUM}px`)
  })

  it('moves from the handle too: up to large, down to medium', () => {
    renderSheet()
    dragHandle([500, 400, 300])
    settle()
    expect(sheetEl().dataset.detent).toBe('large')
    expect(heightOf()).toBe(`${LARGE}px`)
    dragHandle([300, 400, 500])
    settle()
    expect(sheetEl().dataset.detent).toBe('medium')
    expect(heightOf()).toBe(`${MEDIUM}px`)
  })

  it('takes a pull down from large to medium, not out of the screen', () => {
    const { onClose } = renderSheet({ initialDetent: 'large' })
    touch(contentEl(), [300, 310, 500])
    settle()
    expect(onClose).not.toHaveBeenCalled()
    expect(sheetEl().dataset.detent).toBe('medium')
    expect(heightOf()).toBe(`${MEDIUM}px`)
  })

  it('moves one detent on a flick, down from large to medium and up from medium to large', () => {
    const { onClose } = renderSheet({ initialDetent: 'large' })
    // 30px in 10ms: 3000px/s, a short pull but a hard flick.
    touch(contentEl(), [300, 310, 340], { gapMs: 10 })
    settle()
    expect(onClose).not.toHaveBeenCalled()
    expect(sheetEl().dataset.detent).toBe('medium')
    touch(contentEl(), [500, 490, 460], { gapMs: 10 })
    settle()
    expect(sheetEl().dataset.detent).toBe('large')
    expect(heightOf()).toBe(`${LARGE}px`)
  })
})

describe('BottomSheet detents — closing', () => {
  it('follows the finger below medium at the elastic rate, and springs back under the distance', () => {
    const { onClose } = renderSheet()
    touch(contentEl(), [300, 310, 400], { end: false })
    // 100px of finger below the lowest detent: 60px of sheet, the scrim that much clearer.
    expect(sheetEl().style.translate).toBe('0 60px')
    expect(heightOf()).toBe(`${MEDIUM}px`)
    expect(Number(scrimOpacity())).toBeCloseTo(1 - 60 / 300, 6)
    act(() => { contentEl().dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: [] })) })
    expect(onClose).not.toHaveBeenCalled()
    settle()
    expect(sheetEl().style.translate).toBe('')
    expect(scrimOpacity()).toBe('')
  })

  it(`closes past ${SHEET_CLOSE_DISTANCE}px below the lowest detent, and not at ${SHEET_CLOSE_DISTANCE}`, () => {
    const { onClose } = renderSheet()
    touch(contentEl(), [300, 310, 300 + SHEET_CLOSE_DISTANCE])
    settle()
    expect(onClose).not.toHaveBeenCalled()
    touch(contentEl(), [300, 310, 300 + SHEET_CLOSE_DISTANCE + 1])
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('counts the distance from the lowest detent: from large, medium and then 120px more', () => {
    const { onClose } = renderSheet({ initialDetent: 'large' })
    // large → medium is 336px of finger; 120 beyond that is not yet enough.
    touch(contentEl(), [100, 110, 100 + (LARGE - MEDIUM) + SHEET_CLOSE_DISTANCE])
    settle()
    expect(onClose).not.toHaveBeenCalled()
    expect(sheetEl().dataset.detent).toBe('medium')
    touch(contentEl(), [100, 110, 100 + (LARGE - MEDIUM) + SHEET_CLOSE_DISTANCE + 1], { end: true })
    // From medium that is far past 120px: closes.
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on a flick down from the lowest detent, however short the pull', () => {
    const { onClose } = renderSheet()
    touch(contentEl(), [300, 310, 340], { gapMs: 10 })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes from a handle drag past the distance, on the same pull as the content', () => {
    const { onClose } = renderSheet()
    const handle = handleEl()
    fireEvent.pointerDown(handle, { pointerId: 1, isPrimary: true, clientY: 100 })
    fireEvent.pointerMove(handle, { pointerId: 1, isPrimary: true, clientY: 150 })
    expect(sheetEl().style.translate).toBe('0 30px')
    fireEvent.pointerMove(handle, { pointerId: 1, isPrimary: true, clientY: 100 + SHEET_CLOSE_DISTANCE + 1 })
    fireEvent.pointerUp(handle, { pointerId: 1, isPrimary: true, clientY: 100 + SHEET_CLOSE_DISTANCE + 1 })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes a single-detent sheet on the same distance', () => {
    contentHeight = 200
    const { onClose } = renderSheet()
    touch(contentEl(), [300, 310, 300 + SHEET_CLOSE_DISTANCE])
    settle()
    expect(onClose).not.toHaveBeenCalled()
    touch(contentEl(), [300, 310, 300 + SHEET_CLOSE_DISTANCE + 1])
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('springs home on a cancelled touch, to the detent it was at', () => {
    const { onClose } = renderSheet()
    touch(contentEl(), [500, 480, 440], { end: false })
    expect(heightOf()).toBe('460px')
    act(() => { contentEl().dispatchEvent(new TouchEvent('touchcancel', { bubbles: true, touches: [] })) })
    settle()
    expect(onClose).not.toHaveBeenCalled()
    expect(heightOf()).toBe(`${MEDIUM}px`)
  })
})
