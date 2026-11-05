/**
 * Menu row blink: choosing an item flashes its row off and on (~110ms) before
 * its action runs and the menu closes. Off in the global test setup, on here.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { BLINK_OFF_MS, BLINK_ON_MS, menuBlink } from '@/components/ui/_menu-blink'
import { ContextMenu } from '@/components/ui/context-menu'
import { Dropdown, DropdownItem } from '@/components/ui/dropdown'
import { resetHoverIntent } from '@/hooks/use-hover-intent'
import { useFakeTimers } from '../../fake-timers'

let timers: ReturnType<typeof useFakeTimers>

beforeEach(() => {
  menuBlink.enabled = true
  timers = useFakeTimers()
})
afterEach(() => {
  timers.restore()
  menuBlink.enabled = false
  cleanup()
  resetHoverIntent()
})

describe('menu blink timing', () => {
  it('stays under ~120ms in all', () => {
    expect(BLINK_OFF_MS + BLINK_ON_MS).toBeLessThanOrEqual(120)
  })
})

function Harness({ onRename }: { onRename: () => void }) {
  const [at, setAt] = useState<{ x: number; y: number } | null>({ x: 40, y: 60 })
  return (
    <>
      <button type="button">Opener</button>
      {at && (
        <ContextMenu at={at} label="Actions" onDismiss={() => setAt(null)}>
          <button type="button" role="menuitem" onClick={() => { setAt(null); onRename() }}>Rename</button>
          <button type="button" role="menuitem" disabled>Duplicate</button>
        </ContextMenu>
      )}
    </>
  )
}

describe('ContextMenu item blink', () => {
  it('blinks the row off then on, then runs the action', () => {
    const onRename = mock(() => {})
    render(<Harness onRename={onRename} />)
    const item = screen.getByRole('menuitem', { name: 'Rename' })

    fireEvent.click(item)
    expect(onRename).not.toHaveBeenCalled()
    expect(item.getAttribute('data-blink')).toBe('off')

    act(() => timers.tick(BLINK_OFF_MS))
    expect(item.getAttribute('data-blink')).toBe('on')
    expect(onRename).not.toHaveBeenCalled()

    act(() => timers.tick(BLINK_ON_MS))
    expect(onRename).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('runs the action once even if the row is clicked again mid-blink', () => {
    const onRename = mock(() => {})
    render(<Harness onRename={onRename} />)
    const item = screen.getByRole('menuitem', { name: 'Rename' })
    fireEvent.click(item)
    fireEvent.click(item)
    act(() => timers.tick(BLINK_OFF_MS + BLINK_ON_MS))
    expect(onRename).toHaveBeenCalledTimes(1)
  })

  it('does not blink a disabled row', () => {
    render(<Harness onRename={() => {}} />)
    const item = screen.getByRole('menuitem', { name: 'Duplicate' })
    fireEvent.click(item)
    expect(item.hasAttribute('data-blink')).toBe(false)
  })

  it('skips the blink when reduced motion is asked for', () => {
    const original = window.matchMedia
    window.matchMedia = ((query: string) => ({ matches: query.includes('reduce'), media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia
    try {
      const onRename = mock(() => {})
      render(<Harness onRename={onRename} />)
      fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
      expect(onRename).toHaveBeenCalledTimes(1)
    } finally {
      window.matchMedia = original
    }
  })
})

describe('Dropdown item blink', () => {
  function renderMenu(onSelect: () => void) {
    render(
      <Dropdown trigger="Actions" aria-label="Actions">
        <DropdownItem onSelect={onSelect}>Archive</DropdownItem>
      </Dropdown>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }))
  }

  it('runs a clicked item after the blink, then closes', () => {
    const onSelect = mock(() => {})
    renderMenu(onSelect)
    const item = screen.getByRole('menuitem', { name: 'Archive' })
    fireEvent.click(item)
    expect(onSelect).not.toHaveBeenCalled()
    expect(item.getAttribute('data-blink')).toBe('off')
    expect(screen.getByRole('button', { name: 'Actions' }).getAttribute('aria-expanded')).toBe('true')
    act(() => timers.tick(BLINK_OFF_MS + BLINK_ON_MS))
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Actions' }).getAttribute('aria-expanded')).toBe('false')
  })

  it('blinks for the keyboard too', () => {
    const onSelect = mock(() => {})
    renderMenu(onSelect)
    const opener = screen.getByRole('button', { name: 'Actions' })
    fireEvent.keyDown(opener, { key: 'ArrowDown' })
    fireEvent.keyDown(opener, { key: 'Enter' })
    expect(onSelect).not.toHaveBeenCalled()
    act(() => timers.tick(BLINK_OFF_MS + BLINK_ON_MS))
    expect(onSelect).toHaveBeenCalledTimes(1)
  })
})
