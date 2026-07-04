/**
 * TerminalSettingsPage — Settings → Terminal font override.
 *
 * The dynamic part of "support any Nerd Font the user has installed": the
 * user types the exact font name, we check it with the Font Loading API
 * and show a live available/unavailable badge, and saving pushes the
 * change to every live terminal via `useTerminalStore.syncFont` (no
 * restart needed).
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

let storedFont: string | null = null
let fontAvailable: boolean | null = true
const syncFont = mock(((_font: string | null) => {}) as (...args: unknown[]) => unknown)

mock.module('@/lib/terminal-font', () => ({
  readStoredTerminalFont: () => storedFont,
  setStoredTerminalFont: mock(((font: string | null) => {
    storedFont = font?.trim() ? font.trim() : null
  }) as (...args: unknown[]) => unknown),
  isFontAvailable: mock(() => fontAvailable),
  buildTerminalFontFamily: (font: string | null) =>
    font ? `"${font}", "MesloLGS NF"` : '"MesloLGS NF"',
}))

mock.module('@/stores/useTerminalStore', () => ({
  useTerminalStore: { getState: () => ({ syncFont }) },
}))

import { TerminalSettingsPage } from '@/routes/settings.terminal'

beforeEach(() => {
  storedFont = null
  fontAvailable = true
  syncFont.mockClear()
})
afterEach(cleanup)

describe('TerminalSettingsPage', () => {
  it('starts blank when no custom font is stored', () => {
    render(<TerminalSettingsPage />)
    expect(screen.getByLabelText(/font/i)).toHaveProperty('value', '')
  })

  it('pre-fills the input with the previously saved font', () => {
    storedFont = 'MesloLGS NF'
    render(<TerminalSettingsPage />)
    expect(screen.getByLabelText(/font/i)).toHaveProperty('value', 'MesloLGS NF')
  })

  it('shows an "available" badge when the typed font resolves', async () => {
    fontAvailable = true
    render(<TerminalSettingsPage />)
    await userEvent.type(screen.getByLabelText(/font/i), 'MesloLGS NF')
    await waitFor(() => expect(screen.getByText(/available/i)).toBeTruthy())
  })

  it('shows a "not found" badge when the typed font does not resolve', async () => {
    fontAvailable = false
    render(<TerminalSettingsPage />)
    await userEvent.type(screen.getByLabelText(/font/i), 'Nonexistent Font')
    await waitFor(() => expect(screen.getByText(/not found/i)).toBeTruthy())
  })

  it('saving persists the font and pushes it to every live terminal', async () => {
    render(<TerminalSettingsPage />)
    await userEvent.type(screen.getByLabelText(/font/i), 'Hack Nerd Font')
    await userEvent.click(screen.getByRole('button', { name: /save/i }))
    expect(storedFont).toBe('Hack Nerd Font')
    expect(syncFont).toHaveBeenCalledWith('Hack Nerd Font')
  })

  it('clearing the field and saving resets to the default guess stack', async () => {
    storedFont = 'MesloLGS NF'
    render(<TerminalSettingsPage />)
    const input = screen.getByLabelText(/font/i)
    await userEvent.clear(input)
    await userEvent.click(screen.getByRole('button', { name: /save/i }))
    expect(storedFont).toBeNull()
    expect(syncFont).toHaveBeenCalledWith(null)
  })
})
