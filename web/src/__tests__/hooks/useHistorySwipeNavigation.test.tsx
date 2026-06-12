import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { render } from '@testing-library/react'
import { useHistorySwipeNavigation } from '@/hooks/use-history-swipe-navigation'

let platform = { isTauri: true, os: 'macos', isMacOverlay: true }

mock.module('@/hooks/use-platform', () => ({
  getPlatform: () => platform,
}))

function TestHarness() {
  useHistorySwipeNavigation()
  return <div>gesture area</div>
}

function pointer(type: string, init: PointerEventInit): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    isPrimary: true,
    pointerId: 1,
    pointerType: 'touch',
    ...init,
  })
}

describe('useHistorySwipeNavigation', () => {
  const back = window.history.back
  const forward = window.history.forward

  beforeEach(() => {
    platform = { isTauri: true, os: 'macos', isMacOverlay: true }
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 400 })
    window.history.back = mock(() => undefined) as typeof window.history.back
    window.history.forward = mock(() => undefined) as typeof window.history.forward
  })

  afterEach(() => {
    window.history.back = back
    window.history.forward = forward
  })

  it('goes back after a right swipe from the left edge', () => {
    render(<TestHarness />)

    window.dispatchEvent(pointer('pointerdown', { clientX: 12, clientY: 100 }))
    window.dispatchEvent(pointer('pointermove', { clientX: 120, clientY: 112 }))

    expect(window.history.back).toHaveBeenCalledTimes(1)
    expect(window.history.forward).not.toHaveBeenCalled()
  })

  it('goes forward after a left swipe from the right edge', () => {
    render(<TestHarness />)

    window.dispatchEvent(pointer('pointerdown', { clientX: 390, clientY: 100 }))
    window.dispatchEvent(pointer('pointermove', { clientX: 280, clientY: 95 }))

    expect(window.history.forward).toHaveBeenCalledTimes(1)
    expect(window.history.back).not.toHaveBeenCalled()
  })

  it('ignores non-edge, vertical, editable, and mobile shell gestures', () => {
    const input = document.createElement('input')
    document.body.append(input)
    render(<TestHarness />)

    window.dispatchEvent(pointer('pointerdown', { clientX: 80, clientY: 100 }))
    window.dispatchEvent(pointer('pointermove', { clientX: 200, clientY: 105 }))

    window.dispatchEvent(pointer('pointerdown', { clientX: 12, clientY: 100 }))
    window.dispatchEvent(pointer('pointermove', { clientX: 130, clientY: 220 }))

    input.dispatchEvent(pointer('pointerdown', { clientX: 12, clientY: 100 }))
    window.dispatchEvent(pointer('pointermove', { clientX: 130, clientY: 105 }))

    expect(window.history.back).not.toHaveBeenCalled()
    expect(window.history.forward).not.toHaveBeenCalled()
  })

  it('does not install gestures outside Tauri desktop', () => {
    platform = { isTauri: true, os: 'ios', isMacOverlay: false }
    render(<TestHarness />)

    window.dispatchEvent(pointer('pointerdown', { clientX: 12, clientY: 100 }))
    window.dispatchEvent(pointer('pointermove', { clientX: 120, clientY: 105 }))

    expect(window.history.back).not.toHaveBeenCalled()
  })
})
