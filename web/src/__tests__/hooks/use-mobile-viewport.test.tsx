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

  it('tracks offsetTop on scroll for the pinned/scrolled case', () => {
    const vv = installVisualViewport(800, 0)
    renderHook(() => useMobileViewportGuards())
    vv.offsetTop = 24
    vv.emit('scroll')
    expect(document.documentElement.style.getPropertyValue('--app-vt')).toBe('24px')
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
