/**
 * PhoneStack: the phone's two-level navigation stack. Reduced motion snaps
 * the spring, so each test reads the resting state without waiting frames.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react'

mock.module('@/hooks/useReducedMotion', () => ({ useReducedMotion: () => true }))

const { PhoneStack, EDGE_ZONE } = await import('@/components/phone/PhoneStack')
const { handleBackPress, _resetBackHandlersForTests } = await import('@/lib/back-button')

function layers() {
  return {
    root: document.querySelector('[data-phone-stack-root]') as HTMLElement,
    page: document.querySelector('[data-phone-stack-page]') as HTMLElement,
  }
}

/** A touch event at a chosen time: the stack reads the finger's speed from ``timeStamp``. */
function touch(kind: 'touchStart' | 'touchMove' | 'touchEnd', el: HTMLElement, touches: Array<{ clientX: number; clientY: number }>, t: number) {
  const event = createEvent[kind](el, { touches })
  Object.defineProperty(event, 'timeStamp', { value: t })
  fireEvent(el, event)
}

function swipe(from: number, to: number, { y = 0, steps = 6, ms = 40 } = {}) {
  const { page } = layers()
  let t = 1000
  touch('touchStart', page, [{ clientX: from, clientY: 300 }], t)
  for (let i = 1; i <= steps; i++) {
    t += ms
    const x = from + ((to - from) * i) / steps
    touch('touchMove', page, [{ clientX: x, clientY: 300 + (y * i) / steps }], t)
  }
  touch('touchEnd', page, [], t + ms)
}

beforeEach(() => {
  _resetBackHandlersForTests()
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
})
afterEach(cleanup)

describe('PhoneStack', () => {
  it('shows the root and keeps the page inert and hidden until one is pushed', () => {
    render(<PhoneStack root={<p>Sessions</p>} page={<p>Chat</p>} pushed={false} onBack={() => {}} />)
    const { root, page } = layers()
    expect(root.inert).toBe(false)
    expect(page.inert).toBe(true)
    expect(page.className).toContain('invisible')
    expect(screen.getByText('Chat')).toBeTruthy()
  })

  it('pushes the page over the root, and keeps both mounted', () => {
    const { rerender } = render(<PhoneStack root={<p>Sessions</p>} page={<p>Chat</p>} pushed={false} onBack={() => {}} />)
    rerender(<PhoneStack root={<p>Sessions</p>} page={<p>Chat</p>} pushed onBack={() => {}} />)
    const { root, page } = layers()
    expect(page.inert).toBe(false)
    expect(page.className).not.toContain('invisible')
    expect(root.inert).toBe(true)
    expect(screen.getByText('Sessions')).toBeTruthy()
  })

  it('pops on a swipe from the left edge past a third of the width', () => {
    const onBack = mock(() => {})
    render(<PhoneStack root={<p>Sessions</p>} page={<p>Chat</p>} pushed onBack={onBack} />)
    swipe(EDGE_ZONE - 10, 220, { ms: 60 })
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('pops on a short flick, but springs back from a slow short drag', () => {
    const onBack = mock(() => {})
    render(<PhoneStack root={<p>Sessions</p>} page={<p>Chat</p>} pushed onBack={onBack} />)
    swipe(10, 90, { ms: 60 })
    expect(onBack).not.toHaveBeenCalled()
    expect(layers().page.style.translate).toBe('')
    swipe(10, 90, { steps: 4, ms: 8 })
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('ignores a swipe that starts away from the edge, or a vertical one', () => {
    const onBack = mock(() => {})
    render(<PhoneStack root={<p>Sessions</p>} page={<p>Chat</p>} pushed onBack={onBack} />)
    swipe(EDGE_ZONE + 40, 330)
    swipe(10, 30, { y: 200 })
    expect(onBack).not.toHaveBeenCalled()
  })

  it('does not pop while back is off (a sheet is up)', () => {
    const onBack = mock(() => {})
    render(<PhoneStack root={<p>Sessions</p>} page={<p>Chat</p>} pushed backEnabled={false} onBack={onBack} />)
    swipe(10, 300)
    expect(handleBackPress(true)).toBe('history')
    expect(onBack).not.toHaveBeenCalled()
  })

  it('pops on Android Back while a page is pushed, and leaves Back alone at the root', () => {
    const onBack = mock(() => {})
    const { rerender } = render(<PhoneStack root={<p>Sessions</p>} page={<p>Chat</p>} pushed onBack={onBack} />)
    expect(handleBackPress(true)).toBe('handler')
    expect(onBack).toHaveBeenCalledTimes(1)
    rerender(<PhoneStack root={<p>Sessions</p>} page={<p>Chat</p>} pushed={false} onBack={onBack} />)
    expect(handleBackPress(false)).toBe('background')
  })
})
