/**
 * Settings → Appearance: theme, text size and transcript style.
 */
import '@testing-library/jest-dom'

import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { THEME_STORAGE_KEY } from '@/lib/theme'
import { useDisplayPrefsStore } from '@/stores/useDisplayPrefsStore'
import { GeneralSettingsPage } from '@/components/settings/pages/settings.general'

afterEach(() => {
  cleanup()
  localStorage.removeItem(THEME_STORAGE_KEY)
  useDisplayPrefsStore.setState({ transcriptStyle: 'detailed', textSize: 'default' })
  delete document.documentElement.dataset.textSize
})

describe('GeneralSettingsPage — appearance', () => {
  it('renders the page title and its sections', () => {
    render(<GeneralSettingsPage />)
    expect(screen.getByRole('heading', { level: 1, name: 'Appearance' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: 'Look' })).toBeInTheDocument()
  })

  it('sets the text size at once, for the whole app', async () => {
    const user = userEvent.setup()
    render(<GeneralSettingsPage />)

    const size = screen.getByRole('radiogroup', { name: 'Text size' })
    expect(screen.getByRole('radio', { name: 'Default' })).toHaveAttribute('aria-checked', 'true')

    await user.click(screen.getByRole('radio', { name: 'Large' }))

    expect(size.contains(screen.getByRole('radio', { name: 'Large' }))).toBe(true)
    expect(useDisplayPrefsStore.getState().textSize).toBe('large')
    expect(document.documentElement.dataset.textSize).toBe('large')
  })

  it('picks the theme', async () => {
    const user = userEvent.setup()
    render(<GeneralSettingsPage />)

    const theme = screen.getByRole('radiogroup', { name: 'Theme' })
    expect(screen.getByRole('radio', { name: 'System' })).toHaveAttribute('aria-checked', 'true')

    await user.click(screen.getByRole('radio', { name: 'Dark' }))

    expect(theme.contains(screen.getByRole('radio', { name: 'Dark' }))).toBe(true)
    expect(screen.getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('switches the transcript to reader mode', async () => {
    const user = userEvent.setup()
    render(<GeneralSettingsPage />)

    const transcript = screen.getByRole('radiogroup', { name: 'Transcript' })
    const reader = screen.getByRole('radio', { name: 'Reader' })
    expect(transcript.contains(reader)).toBe(true)
    expect(screen.getByRole('radio', { name: 'Detailed' })).toHaveAttribute('aria-checked', 'true')

    await user.click(reader)

    expect(reader).toHaveAttribute('aria-checked', 'true')
    expect(useDisplayPrefsStore.getState().transcriptStyle).toBe('reader')
  })

  it('has no new-session composer setting: the composer is always centered on desktop', () => {
    render(<GeneralSettingsPage />)
    expect(screen.getByRole('radiogroup', { name: 'Transcript' })).toBeTruthy()
    expect(screen.queryByRole('radiogroup', { name: 'New session composer' })).toBeNull()
  })
})
