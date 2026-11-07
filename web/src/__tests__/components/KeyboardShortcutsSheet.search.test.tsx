/**
 * The shortcuts sheet on desktop (mockup 9.2): a search field, focused as it
 * opens, filters the list by name, key or area, and the groups flow into two
 * columns on a wide window.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

mock.module('@/hooks/use-is-phone', () => ({ useIsPhone: () => false }))

import { KeyboardShortcutsSheet } from '@/components/KeyboardShortcutsSheet'
import { _resetKeyboardForTests } from '@/lib/keyboard/dispatcher'
import { useUIStore } from '@/stores/useUIStore'

beforeEach(() => useUIStore.getState().closeAll())
afterEach(() => {
  cleanup()
  _resetKeyboardForTests()
})

async function openSheet() {
  render(<KeyboardShortcutsSheet />)
  act(() => useUIStore.getState().toggleShortcutsHelp())
  const sheet = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })
  return { sheet, field: within(sheet).getByRole('searchbox', { name: 'Search shortcuts' }) }
}

describe('KeyboardShortcutsSheet — search', () => {
  it('puts focus in the search field as it opens', async () => {
    const { field } = await openSheet()
    await waitFor(() => expect(document.activeElement).toBe(field))
  })

  it('keeps only the shortcuts whose name matches, under their area', async () => {
    const { sheet, field } = await openSheet()
    fireEvent.change(field, { target: { value: 'sidebar' } })

    expect(within(sheet).getByText('Toggle sidebar')).toBeTruthy()
    expect(within(sheet).queryByText('Find file')).toBeNull()
    expect(within(sheet).getByText('App')).toBeTruthy()
  })

  it('finds a shortcut by its key too', async () => {
    const { sheet, field } = await openSheet()
    fireEvent.change(field, { target: { value: 'F6' } })

    expect(within(sheet).getByText('Next and previous area')).toBeTruthy()
    expect(within(sheet).queryByText('Toggle sidebar')).toBeNull()
  })

  it('says so when nothing matches', async () => {
    const { sheet, field } = await openSheet()
    fireEvent.change(field, { target: { value: 'zzz' } })

    expect(within(sheet).getByText('No shortcuts match "zzz"')).toBeTruthy()
  })

  it('flows the areas into two columns on a wide window', async () => {
    const { sheet } = await openSheet()
    const list = sheet.querySelector<HTMLElement>('[data-shortcut-groups]')!

    expect(list.className).toContain('lg:columns-2')
    expect(Array.from(list.children).every((group) => group.className.includes('break-inside-avoid'))).toBe(true)
  })
})
