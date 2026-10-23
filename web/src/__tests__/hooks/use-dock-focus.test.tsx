import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import { useRef } from 'react'

import { isFocusStranded, useClaimStrandedFocus, useReturnFocusFromDock } from '@/hooks/use-dock-focus'

afterEach(cleanup)

function ClaimHarness({ active }: { active: boolean }) {
  const tabRef = useRef<HTMLButtonElement>(null)
  useClaimStrandedFocus(active, 'tab', () => tabRef.current)
  return (
    <>
      <main inert>
        <textarea aria-label="Composer" />
      </main>
      <button type="button">Header toggle</button>
      <button type="button" ref={tabRef}>Active tab</button>
    </>
  )
}

describe('isFocusStranded', () => {
  it('is true on <body> and inside an inert subtree, false on a live control', () => {
    render(<ClaimHarness active={false} />)
    ;(document.activeElement as HTMLElement | null)?.blur()
    expect(isFocusStranded()).toBe(true)
    screen.getByRole('textbox', { name: 'Composer' }).focus()
    expect(isFocusStranded()).toBe(true)
    screen.getByRole('button', { name: 'Header toggle' }).focus()
    expect(isFocusStranded()).toBe(false)
  })
})

describe('useClaimStrandedFocus', () => {
  it('moves focus stranded in the covered chat to the target', () => {
    const { rerender } = render(<ClaimHarness active={false} />)
    screen.getByRole('textbox', { name: 'Composer' }).focus()
    rerender(<ClaimHarness active />)
    const tab = screen.getByRole('button', { name: 'Active tab' })
    expect(document.activeElement).toBe(tab)
    // Quiet: the key press that covered the chat did not steer focus here,
    // so the tab draws no ring, fill or tooltip.
    expect(tab.hasAttribute('data-quiet-focus')).toBe(true)
  })

  it('leaves focus alone when it is already on a live control', () => {
    const { rerender } = render(<ClaimHarness active={false} />)
    const toggle = screen.getByRole('button', { name: 'Header toggle' })
    toggle.focus()
    rerender(<ClaimHarness active />)
    expect(document.activeElement).toBe(toggle)
  })
})

function ReturnHarness({ open, covered, enabled = true, onReturn }: {
  open: boolean
  covered: boolean
  enabled?: boolean
  onReturn: () => void
}) {
  const dockRef = useRef<HTMLDivElement>(null)
  useReturnFocusFromDock({ open, covered, enabled, isInDock: (el) => dockRef.current?.contains(el) ?? false, onReturn })
  return (
    <>
      <button type="button">Header toggle</button>
      <div ref={dockRef}>
        <button type="button">Dock tab</button>
      </div>
    </>
  )
}

describe('useReturnFocusFromDock', () => {
  it('returns focus when the dock closes with focus inside it', () => {
    const onReturn = mock(() => {})
    const { rerender } = render(<ReturnHarness open covered={false} onReturn={onReturn} />)
    screen.getByRole('button', { name: 'Dock tab' }).focus()
    rerender(<ReturnHarness open={false} covered={false} onReturn={onReturn} />)
    expect(onReturn).toHaveBeenCalledTimes(1)
  })

  it('keeps focus where the user put it when the dock closes from the header', () => {
    const onReturn = mock(() => {})
    const { rerender } = render(<ReturnHarness open covered={false} onReturn={onReturn} />)
    screen.getByRole('button', { name: 'Header toggle' }).focus()
    rerender(<ReturnHarness open={false} covered={false} onReturn={onReturn} />)
    expect(onReturn).not.toHaveBeenCalled()
  })

  it('leaves focus on <body> alone when a side-by-side dock closes, e.g. ⌘D twice', () => {
    const onReturn = mock(() => {})
    const { rerender } = render(<ReturnHarness open covered={false} onReturn={onReturn} />)
    ;(document.activeElement as HTMLElement | null)?.blur()
    rerender(<ReturnHarness open={false} covered={false} onReturn={onReturn} />)
    expect(onReturn).not.toHaveBeenCalled()
  })

  it('returns focus stranded under a covering dock when it closes', () => {
    const onReturn = mock(() => {})
    const { rerender } = render(<ReturnHarness open covered onReturn={onReturn} />)
    ;(document.activeElement as HTMLElement | null)?.blur()
    rerender(<ReturnHarness open={false} covered={false} onReturn={onReturn} />)
    expect(onReturn).toHaveBeenCalledTimes(1)
  })

  it('only rescues stranded focus when the dock stops covering the chat but stays open', () => {
    const onReturn = mock(() => {})
    const { rerender } = render(<ReturnHarness open covered onReturn={onReturn} />)
    screen.getByRole('button', { name: 'Dock tab' }).focus()
    rerender(<ReturnHarness open covered={false} onReturn={onReturn} />)
    expect(onReturn).not.toHaveBeenCalled()

    rerender(<ReturnHarness open covered onReturn={onReturn} />)
    ;(document.activeElement as HTMLElement | null)?.blur()
    rerender(<ReturnHarness open covered={false} onReturn={onReturn} />)
    expect(onReturn).toHaveBeenCalledTimes(1)
  })

  it('does nothing when disabled (phones use the full-screen sheet)', () => {
    const onReturn = mock(() => {})
    const { rerender } = render(<ReturnHarness open covered={false} enabled={false} onReturn={onReturn} />)
    screen.getByRole('button', { name: 'Dock tab' }).focus()
    rerender(<ReturnHarness open={false} covered={false} enabled={false} onReturn={onReturn} />)
    expect(onReturn).not.toHaveBeenCalled()
  })
})
