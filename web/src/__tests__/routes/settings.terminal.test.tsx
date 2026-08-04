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
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

let storedFont: string | null = null
let storedFontSize: number = 13
let fontAvailable: boolean | null = true
const syncFont = mock(((_font: string | null) => {}) as (...args: unknown[]) => unknown)
const syncFontSize = mock(((_size: number) => {}) as (...args: unknown[]) => unknown)

mock.module('@/lib/terminal-font', () => ({
  readStoredTerminalFont: () => storedFont,
  setStoredTerminalFont: mock(((font: string | null) => {
    storedFont = font?.trim() ? font.trim() : null
  }) as (...args: unknown[]) => unknown),
  readStoredTerminalFontSize: () => storedFontSize,
  setStoredTerminalFontSize: mock(((size: number) => {
    storedFontSize = size
  }) as (...args: unknown[]) => unknown),
  isFontAvailable: mock(() => fontAvailable),
  buildTerminalFontFamily: (font: string | null) =>
    font ? `"${font}", "MesloLGS NF"` : '"MesloLGS NF"',
  DEFAULT_TERMINAL_FONT_SIZE: 13,
  MIN_TERMINAL_FONT_SIZE: 9,
  MAX_TERMINAL_FONT_SIZE: 24,
}))

mock.module('@/stores/useTerminalStore', () => ({
  useTerminalStore: { getState: () => ({ syncFont, syncFontSize }) },
}))

import { TerminalSettingsPage } from '@/components/settings/pages/settings.terminal'

beforeEach(() => {
  storedFont = null
  storedFontSize = 13
  fontAvailable = true
  syncFont.mockClear()
  syncFontSize.mockClear()
})
afterEach(cleanup)

describe('TerminalSettingsPage', () => {
  it('starts blank when no custom font is stored', () => {
    render(<TerminalSettingsPage />)
    expect(screen.getByLabelText(/font name/i)).toHaveProperty('value', '')
    expect(screen.getByLabelText(/font size/i)).toHaveProperty('value', '13')
  })

  it('pre-fills the input with the previously saved font', () => {
    storedFont = 'MesloLGS NF'
    render(<TerminalSettingsPage />)
    expect(screen.getByLabelText(/font name/i)).toHaveProperty('value', 'MesloLGS NF')
  })

  it('shows an "available" badge when the typed font resolves', async () => {
    fontAvailable = true
    render(<TerminalSettingsPage />)
    await userEvent.type(screen.getByLabelText(/font name/i), 'MesloLGS NF')
    await waitFor(() => expect(screen.getByText(/available/i)).toBeTruthy())
  })

  it('shows a "not found" badge when the typed font does not resolve', async () => {
    fontAvailable = false
    render(<TerminalSettingsPage />)
    await userEvent.type(screen.getByLabelText(/font name/i), 'Nonexistent Font')
    await waitFor(() => expect(screen.getByText(/not found/i)).toBeTruthy())
  })

  it('saving persists the font and font size, pushing them to live terminals', async () => {
    render(<TerminalSettingsPage />)
    await userEvent.type(screen.getByLabelText(/font name/i), 'Hack Nerd Font')
    const sizeInput = screen.getByLabelText(/font size/i)
    fireEvent.change(sizeInput, { target: { value: '15' } })
    await userEvent.click(screen.getByRole('button', { name: /save/i }))
    expect(storedFont).toBe('Hack Nerd Font')
    expect(syncFont).toHaveBeenCalledWith('Hack Nerd Font')
    expect(storedFontSize).toBe(15)
    expect(syncFontSize).toHaveBeenCalledWith(15)
  })

  it('clearing the field and saving resets to the default guess stack', async () => {
    storedFont = 'MesloLGS NF'
    render(<TerminalSettingsPage />)
    const input = screen.getByLabelText(/font name/i)
    await userEvent.clear(input)
    await userEvent.click(screen.getByRole('button', { name: /save/i }))
    expect(storedFont).toBeNull()
    expect(syncFont).toHaveBeenCalledWith(null)
  })
})
