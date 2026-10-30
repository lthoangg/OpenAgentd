import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'

import { KeyboardShortcutsSheet } from '@/components/KeyboardShortcutsSheet'
import { getPlatform } from '@/hooks/use-platform'
import { _resetKeyboardForTests } from '@/lib/keyboard/dispatcher'
import { useAppShortcut } from '@/lib/keyboard/hooks'
import { useUIStore } from '@/stores/useUIStore'

const MOD = getPlatform().os === 'macos' ? { metaKey: true } : { ctrlKey: true }
const press = (init: KeyboardEventInit) => act(() => {
  (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
})

function Shell() {
  useAppShortcut('shortcutsHelp', () => { useUIStore.getState().toggleShortcutsHelp() })
  return <KeyboardShortcutsSheet />
}

beforeEach(() => useUIStore.getState().closeAll())
afterEach(() => {
  cleanup()
  _resetKeyboardForTests()
})

describe('KeyboardShortcutsSheet', () => {
  it('opens with ⌘/ and lists shortcuts by area', async () => {
    render(<Shell />)
    expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).toBeNull()
    press({ key: '/', ...MOD })
    const sheet = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })
    expect(sheet.textContent).toContain('Review panel')
    expect(sheet.textContent).not.toContain('Review dock')
    expect(screen.getByText('Find file')).toBeTruthy()
    expect(screen.getByText('Close tab')).toBeTruthy()
  })

  it('closes with Escape and with ⌘/ again', async () => {
    render(<Shell />)
    act(() => useUIStore.getState().toggleShortcutsHelp())
    await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })
    press({ key: 'Escape' })
    await waitFor(() => expect(useUIStore.getState().shortcutsHelpOpen).toBe(false))
    act(() => useUIStore.getState().toggleShortcutsHelp())
    await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })
    press({ key: '/', ...MOD })
    expect(useUIStore.getState().shortcutsHelpOpen).toBe(false)
  })

  it('gives way to the palette like the other overlays', () => {
    act(() => useUIStore.getState().toggleShortcutsHelp())
    act(() => useUIStore.getState().togglePalette())
    expect(useUIStore.getState().shortcutsHelpOpen).toBe(false)
    act(() => useUIStore.getState().toggleShortcutsHelp())
    expect(useUIStore.getState().paletteOpen).toBe(false)
  })
})
