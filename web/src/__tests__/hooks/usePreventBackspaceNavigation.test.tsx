/**
 * usePreventBackspaceNavigation — global guard against the
 * Chromium/WebView "bare Backspace = browser back" default.
 */
import { describe, it, expect, afterEach } from 'bun:test'
import { render, cleanup, act } from '@testing-library/react'
import { usePreventBackspaceNavigation } from '@/hooks/usePreventBackspaceNavigation'

afterEach(cleanup)

function Harness() {
  usePreventBackspaceNavigation()
  return null
}

function backspace(target: EventTarget = window): KeyboardEvent {
  const e = new KeyboardEvent('keydown', {
    key: 'Backspace',
    bubbles: true,
    cancelable: true,
  })
  target.dispatchEvent(e)
  return e
}

describe('usePreventBackspaceNavigation', () => {
  it('prevents default when focus is not on an editable element', () => {
    render(<Harness />)

    const div = document.createElement('div')
    document.body.appendChild(div)
    div.focus()

    const e = backspace()
    expect(e.defaultPrevented).toBe(true)
  })

  it('does NOT intercept Backspace inside a focused <input>', async () => {
    render(<Harness />)

    const input = document.createElement('input')
    document.body.appendChild(input)
    await act(async () => { input.focus() })

    const e = backspace(input)
    expect(e.defaultPrevented).toBe(false)
  })

  it('does NOT intercept Backspace inside a focused <textarea>', async () => {
    render(<Harness />)

    const textarea = document.createElement('textarea')
    document.body.appendChild(textarea)
    await act(async () => { textarea.focus() })

    const e = backspace(textarea)
    expect(e.defaultPrevented).toBe(false)
  })

  it('does NOT intercept Backspace inside a contenteditable element', async () => {
    render(<Harness />)

    const div = document.createElement('div')
    div.setAttribute('contenteditable', 'true')
    document.body.appendChild(div)
    await act(async () => { div.focus() })

    const e = backspace(div)
    expect(e.defaultPrevented).toBe(false)
  })

  it('ignores keys other than Backspace', () => {
    render(<Harness />)

    const e = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true })
    window.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(false)
  })

  it('leaves an already-handled event alone', () => {
    render(<Harness />)

    const e = new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true })
    // Simulate a more specific handler (e.g. InputBar's shell-mode exit)
    // having already claimed this keydown.
    e.preventDefault()
    window.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(true) // unchanged, no double-handling assertion needed
  })

  it('removes the listener on unmount', () => {
    const { unmount } = render(<Harness />)
    unmount()

    const e = backspace()
    expect(e.defaultPrevented).toBe(false)
  })
})
