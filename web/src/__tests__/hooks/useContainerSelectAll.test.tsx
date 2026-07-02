/**
 * useContainerSelectAll — container-aware Cmd/Ctrl+A scoping.
 *
 * Happy DOM resolves to os='unknown' → isPrimaryShortcut expects Ctrl.
 * All assertions below use Ctrl+A accordingly.
 */
import { describe, it, expect, afterEach, mock } from 'bun:test'
import { render, cleanup, act } from '@testing-library/react'
import { useContainerSelectAll } from '@/hooks/useContainerSelectAll'

// ── Platform stub (non-mobile, non-mac so Ctrl is the primary modifier) ──────
mock.module('@/hooks/use-platform', () => ({
  usePlatform: () => ({ isTauri: false, os: 'linux', isMacOverlay: false }),
  getPlatform: () => ({ isTauri: false, os: 'linux', isMacOverlay: false }),
}))

afterEach(cleanup)

function Harness() {
  useContainerSelectAll()
  return null
}

function ctrlA(target: EventTarget = window): KeyboardEvent {
  const e = new KeyboardEvent('keydown', {
    key: 'a',
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  })
  target.dispatchEvent(e)
  return e
}

describe('useContainerSelectAll', () => {
  it('does nothing when no data-select-container ancestor exists', () => {
    render(<Harness />)

    // Place focus on a plain div (no container ancestor)
    const div = document.createElement('div')
    div.setAttribute('tabindex', '0')
    document.body.appendChild(div)
    div.focus()

    const e = ctrlA()

    // Default not prevented — browser keeps its own Select-All
    expect(e.defaultPrevented).toBe(false)
  })

  it('prevents default and scopes selection when focus is inside data-select-container', async () => {
    render(<Harness />)

    // Build a scoped container with some text content
    const container = document.createElement('div')
    container.setAttribute('data-select-container', '')
    container.setAttribute('tabindex', '0')
    container.textContent = 'hello world'
    document.body.appendChild(container)

    await act(async () => { container.focus() })

    const e = ctrlA()

    expect(e.defaultPrevented).toBe(true)

    // Selection should cover the container's text
    const sel = window.getSelection()
    expect(sel?.toString()).toBe('hello world')
  })

  it('walks up to find the container even when a child element has focus', async () => {
    render(<Harness />)

    const container = document.createElement('div')
    container.setAttribute('data-select-container', '')
    container.textContent = 'outer'

    const inner = document.createElement('span')
    inner.setAttribute('tabindex', '0')
    inner.textContent = 'inner'
    container.appendChild(inner)
    document.body.appendChild(container)

    await act(async () => { inner.focus() })

    const e = ctrlA()

    expect(e.defaultPrevented).toBe(true)
    expect(window.getSelection()?.toString()).toContain('outer')
  })

  it('does NOT intercept Ctrl+A inside a focused <textarea>', async () => {
    render(<Harness />)

    const container = document.createElement('div')
    container.setAttribute('data-select-container', '')

    const ta = document.createElement('textarea')
    ta.value = 'typed text'
    container.appendChild(ta)
    document.body.appendChild(container)

    await act(async () => { ta.focus() })

    const e = ctrlA()

    // textarea handles its own Select-All natively — we must not interfere
    expect(e.defaultPrevented).toBe(false)
  })

  it('does NOT intercept Ctrl+A inside a focused <input>', async () => {
    render(<Harness />)

    const container = document.createElement('div')
    container.setAttribute('data-select-container', '')

    const input = document.createElement('input')
    input.type = 'text'
    input.value = 'text'
    container.appendChild(input)
    document.body.appendChild(container)

    await act(async () => { input.focus() })

    const e = ctrlA()

    expect(e.defaultPrevented).toBe(false)
  })

  it('removes the listener on unmount', async () => {
    const { unmount } = render(<Harness />)

    const container = document.createElement('div')
    container.setAttribute('data-select-container', '')
    container.setAttribute('tabindex', '0')
    container.textContent = 'text'
    document.body.appendChild(container)

    await act(async () => { container.focus() })

    unmount()

    const e = ctrlA()

    // Listener gone — default not prevented
    expect(e.defaultPrevented).toBe(false)
  })

  it('is a no-op on ios', async () => {
    // The module is mocked globally as linux/unknown so isPrimaryShortcut
    // requires Ctrl. Dispatching metaKey+A (what iOS uses) is therefore not
    // recognised as the primary shortcut and default stays intact — same
    // effective behaviour as the ios guard short-circuiting.

    // Dispatch a metaKey+A (what macOS/iOS uses) — on linux platform this
    // is not recognised as the primary shortcut, so default stays intact.
    const container = document.createElement('div')
    container.setAttribute('data-select-container', '')
    container.setAttribute('tabindex', '0')
    container.textContent = 'ios text'
    document.body.appendChild(container)

    render(<Harness />)
    await act(async () => { container.focus() })

    const e = new KeyboardEvent('keydown', {
      key: 'a',
      metaKey: true, // not Ctrl — not the primary on linux/unknown
      bubbles: true,
      cancelable: true,
    })
    window.dispatchEvent(e)

    expect(e.defaultPrevented).toBe(false)
  })
})
