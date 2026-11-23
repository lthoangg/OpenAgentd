import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, renderHook } from '@testing-library/react'

import { useTerminalAutoFocus } from '@/components/Terminal/use-terminal-autofocus'

function fakeTerm() {
  return { focused: 0, focus() { this.focused += 1 } }
}

function composer() {
  const textarea = document.createElement('textarea')
  document.body.appendChild(textarea)
  textarea.focus()
  return textarea
}

afterEach(cleanup)

describe('useTerminalAutoFocus', () => {
  it('focuses the terminal once when the tab is opened', () => {
    const rootRef = { current: document.createElement('div') }
    const term = fakeTerm()
    const { rerender } = renderHook(({ t }) => useTerminalAutoFocus(t, rootRef), { initialProps: { t: term } })
    expect(term.focused).toBe(1)
    // Status changes re-render the view with the same terminal: no new focus.
    rerender({ t: term })
    rerender({ t: term })
    expect(term.focused).toBe(1)
  })

  it('opens the tab on top of the composer: the user asked for the terminal', () => {
    composer()
    const term = fakeTerm()
    renderHook(() => useTerminalAutoFocus(term, { current: document.createElement('div') }))
    expect(term.focused).toBe(1)
  })

  it('focuses a terminal that arrives after the tab opened over the composer', () => {
    // The xterm handle is built after the view mounts: opening the tab still
    // means the user asked for the terminal, though the composer holds focus.
    composer()
    const term = fakeTerm()
    const root = document.createElement('div')
    const { rerender } = renderHook(({ t }) => useTerminalAutoFocus(t, { current: root }), { initialProps: { t: null as ReturnType<typeof fakeTerm> | null } })
    rerender({ t: term })
    expect(term.focused).toBe(1)
  })

  it('focuses a late terminal even when focus returns to the composer by itself', () => {
    // e.g. the command palette closing hands focus back to the composer.
    const term = fakeTerm()
    const root = document.createElement('div')
    const { rerender } = renderHook(({ t }) => useTerminalAutoFocus(t, { current: root }), { initialProps: { t: null as ReturnType<typeof fakeTerm> | null } })
    composer()
    rerender({ t: term })
    expect(term.focused).toBe(1)
  })

  it('does not steal focus when the user clicks elsewhere while the terminal loads', () => {
    const term = fakeTerm()
    const root = document.createElement('div')
    document.body.appendChild(root)
    const { rerender } = renderHook(({ t }) => useTerminalAutoFocus(t, { current: root }), { initialProps: { t: null as ReturnType<typeof fakeTerm> | null } })
    const textarea = composer()
    textarea.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    rerender({ t: term })
    expect(term.focused).toBe(0)
  })

  it('takes focus on a late arrival when the click was inside the terminal', () => {
    const term = fakeTerm()
    const root = document.createElement('div')
    document.body.appendChild(root)
    const { rerender } = renderHook(({ t }) => useTerminalAutoFocus(t, { current: root }), { initialProps: { t: null as ReturnType<typeof fakeTerm> | null } })
    composer()
    root.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    rerender({ t: term })
    expect(term.focused).toBe(1)
  })

  it('does not steal focus when a reconnect swaps in a new terminal', () => {
    const root = document.createElement('div')
    const first = fakeTerm()
    const second = fakeTerm()
    const { rerender } = renderHook(({ t }) => useTerminalAutoFocus(t, { current: root }), { initialProps: { t: first } })
    composer()
    rerender({ t: second })
    expect(first.focused).toBe(1)
    expect(second.focused).toBe(0)
  })

  it('focuses a late terminal when nothing else holds focus', () => {
    const term = fakeTerm()
    const root = document.createElement('div')
    const { rerender } = renderHook(({ t }) => useTerminalAutoFocus(t, { current: root }), { initialProps: { t: null as ReturnType<typeof fakeTerm> | null } })
    rerender({ t: term })
    expect(term.focused).toBe(1)
  })
})
