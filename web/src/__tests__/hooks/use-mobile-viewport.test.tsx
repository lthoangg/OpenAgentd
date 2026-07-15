/**
 * Tests for ``useMobileViewportGuards`` — the single source of truth that
 * binds the mobile app shell to ``window.visualViewport``.
 *
 * The smooth-keyboard behaviour depends on three observable side effects:
 *   1. ``data-mobile-shell`` attribute is set on the mobile shell.
 *   2. ``--app-vh`` / ``--app-vt`` CSS variables mirror the visual viewport
 *      and update on its ``resize``/``scroll`` events.
 *   3. ``data-keyboard-open`` toggles once the keyboard occludes the layout
 *      viewport (so ``pb-safe`` can drop the home-indicator inset).
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { renderHook } from '@testing-library/react'

let platform = { isTauri: true, os: 'ios', isMacOverlay: false }
mock.module('@/hooks/use-platform', () => ({
  getPlatform: () => platform,
  usePlatform: () => platform,
}))

const { useMobileViewportGuards, dismissKeyboard } = await import('@/hooks/use-mobile-viewport')

interface FakeVV {
  height: number
  offsetTop: number
  listeners: Record<string, Array<() => void>>
  addEventListener: (t: string, cb: () => void) => void
  removeEventListener: (t: string, cb: () => void) => void
  emit: (t: string) => void
}

function installVisualViewport(height: number, offsetTop = 0): FakeVV {
  const vv: FakeVV = {
    height,
    offsetTop,
    listeners: {},
    addEventListener(t, cb) {
      ;(this.listeners[t] ??= []).push(cb)
    },
    removeEventListener(t, cb) {
      this.listeners[t] = (this.listeners[t] ?? []).filter((f) => f !== cb)
    },
    emit(t) {
      ;(this.listeners[t] ?? []).forEach((f) => f())
    },
  }
  Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true, writable: true })
  return vv
}

beforeEach(() => {
  platform = { isTauri: true, os: 'ios', isMacOverlay: false }
  Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true, writable: true })
  Object.defineProperty(navigator, 'maxTouchPoints', { value: 5, configurable: true, writable: true })
})

afterEach(() => {
  document.documentElement.removeAttribute('data-mobile-shell')
  document.documentElement.removeAttribute('data-keyboard-open')
  document.documentElement.removeAttribute('data-vp-anim')
  document.documentElement.style.removeProperty('--app-vh')
  document.documentElement.style.removeProperty('--app-vt')
})

describe('useMobileViewportGuards', () => {
  it('marks the mobile shell and seeds the viewport variables', () => {
    installVisualViewport(800, 0)
    const { unmount } = renderHook(() => useMobileViewportGuards())
    const root = document.documentElement
    expect(root.getAttribute('data-mobile-shell')).toBe('ios')
    expect(root.style.getPropertyValue('--app-vh')).toBe('800px')
    expect(root.style.getPropertyValue('--app-vt')).toBe('0px')
    unmount()
    expect(root.getAttribute('data-mobile-shell')).toBeNull()
    expect(root.style.getPropertyValue('--app-vh')).toBe('')
  })

  it('shrinks --app-vh and flags keyboard-open when the keyboard opens', () => {
    const vv = installVisualViewport(800, 0)
    renderHook(() => useMobileViewportGuards())
    const root = document.documentElement
    expect(root.hasAttribute('data-keyboard-open')).toBe(false)

    // Keyboard opens: visible region drops to 460px (340px keyboard).
    vv.height = 460
    vv.emit('resize')
    expect(root.style.getPropertyValue('--app-vh')).toBe('460px')
    expect(root.hasAttribute('data-keyboard-open')).toBe(true)

    // Keyboard closes.
    vv.height = 800
    vv.emit('resize')
    expect(root.style.getPropertyValue('--app-vh')).toBe('800px')
    expect(root.hasAttribute('data-keyboard-open')).toBe(false)
  })

  it('still flags keyboard-open when innerHeight shrinks with the keyboard', () => {
    const vv = installVisualViewport(800, 0)
    renderHook(() => useMobileViewportGuards())
    const root = document.documentElement

    Object.defineProperty(window, 'innerHeight', { value: 460, configurable: true, writable: true })
    vv.height = 460
    vv.emit('resize')

    expect(root.style.getPropertyValue('--app-vh')).toBe('460px')
    expect(root.hasAttribute('data-keyboard-open')).toBe(true)
  })

  it('tracks offsetTop on scroll for the pinned/scrolled case', () => {
    const vv = installVisualViewport(800, 0)
    renderHook(() => useMobileViewportGuards())
    vv.offsetTop = 24
    vv.emit('scroll')
    expect(document.documentElement.style.getPropertyValue('--app-vt')).toBe('24px')
  })

  it('pins the shell immediately when the keyboard opens with a viewport offset', () => {
    const vv = installVisualViewport(800, 0)
    renderHook(() => useMobileViewportGuards())

    // iOS can report offsetTop in the same event that first signals keyboard
    // occlusion. The shell must not follow that offset for one frame.
    vv.height = 460
    vv.offsetTop = 24
    vv.emit('resize')

    expect(document.documentElement.hasAttribute('data-keyboard-open')).toBe(true)
    expect(document.documentElement.style.getPropertyValue('--app-vt')).toBe('0px')
  })

  it('pins the shell at top while the keyboard is open', () => {
    const vv = installVisualViewport(800, 0)
    renderHook(() => useMobileViewportGuards())

    vv.height = 460
    vv.emit('resize')
    vv.offsetTop = 24
    vv.emit('scroll')

    expect(document.documentElement.hasAttribute('data-keyboard-open')).toBe(true)
    expect(document.documentElement.style.getPropertyValue('--app-vt')).toBe('0px')
  })

  it('does not move a containing scroller when its focused control is already visible', () => {
    installVisualViewport(800, 0)
    renderHook(() => useMobileViewportGuards())

    const container = document.createElement('div')
    container.className = 'overflow-y-auto'
    const input = document.createElement('input')
    container.appendChild(input)
    document.body.appendChild(container)

    const scrollTo = mock(() => undefined)
    Object.defineProperty(container, 'scrollTo', { value: scrollTo })
    container.getBoundingClientRect = () => ({ top: 100, bottom: 500 }) as DOMRect
    input.getBoundingClientRect = () => ({ top: 200, bottom: 240 }) as DOMRect

    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = ((callback: TimerHandler) => {
      if (typeof callback === 'function') callback()
      return 0 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout
    try {
      input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    } finally {
      globalThis.setTimeout = originalSetTimeout
      container.remove()
    }

    expect(scrollTo).not.toHaveBeenCalled()
    expect(container.scrollTop).toBe(0)
  })

  it('moves the nearest scroll container when a focused control is obscured', () => {
    installVisualViewport(800, 0)
    renderHook(() => useMobileViewportGuards())

    const container = document.createElement('div')
    container.className = 'overflow-y-auto'
    const input = document.createElement('input')
    container.appendChild(input)
    document.body.appendChild(container)

    container.getBoundingClientRect = () => ({ top: 100, bottom: 500 }) as DOMRect
    input.getBoundingClientRect = () => ({ top: 600, bottom: 640 }) as DOMRect

    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = ((callback: TimerHandler) => {
      if (typeof callback === 'function') callback()
      return 0 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout
    try {
      input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    } finally {
      globalThis.setTimeout = originalSetTimeout
      container.remove()
    }

    expect(container.scrollTop).toBe(480)
  })

  it('dismissKeyboard blurs, snaps to full height, and eases the glide', () => {
    const vv = installVisualViewport(460, 0) // keyboard up
    renderHook(() => useMobileViewportGuards())
    const root = document.documentElement
    vv.emit('resize')
    expect(root.hasAttribute('data-keyboard-open')).toBe(true)

    // Focus an input so dismiss has something to blur.
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    expect(document.activeElement).toBe(input)

    dismissKeyboard()

    expect(document.activeElement).not.toBe(input)
    expect(root.hasAttribute('data-keyboard-open')).toBe(false)
    expect(root.hasAttribute('data-vp-anim')).toBe(true) // transition armed for the glide
    expect(root.style.getPropertyValue('--app-vh')).toBe('800px') // optimistic full height
    expect(root.style.getPropertyValue('--app-vt')).toBe('0px')

    input.remove()
  })

  it('opening the keyboard clears the dismiss transition flag (stays frame-locked)', () => {
    const vv = installVisualViewport(800, 0)
    renderHook(() => useMobileViewportGuards())
    const root = document.documentElement
    root.setAttribute('data-vp-anim', '') // leftover from a prior dismiss

    vv.height = 460 // keyboard opens
    vv.emit('resize')
    expect(root.hasAttribute('data-keyboard-open')).toBe(true)
    expect(root.hasAttribute('data-vp-anim')).toBe(false)
  })

  it('does nothing on a non-touch desktop platform', () => {
    platform = { isTauri: false, os: 'macos', isMacOverlay: false }
    Object.defineProperty(navigator, 'maxTouchPoints', { value: 0, configurable: true, writable: true })
    Object.defineProperty(window, 'visualViewport', { value: undefined, configurable: true, writable: true })
    renderHook(() => useMobileViewportGuards())
    expect(document.documentElement.getAttribute('data-mobile-shell')).toBeNull()
  })
})
