/**
 * Settings → Appearance in the phone apps: each choice is the app's own
 * segmented control, as on every other platform, not the system's picker.
 */
import '@testing-library/jest-dom'

import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const platform = { isTauri: true, os: 'ios', isMacOverlay: false }
mock.module('@/hooks/use-platform', () => ({ getPlatform: () => platform, usePlatform: () => platform }))

const invoke = mock(async (..._args: unknown[]) => null)
mock.module('@tauri-apps/api/core', () => ({ invoke }))

const { useDisplayPrefsStore } = await import('@/stores/useDisplayPrefsStore')
const { GeneralSettingsPage } = await import('@/components/settings/pages/settings.general')

afterEach(() => {
  cleanup()
  invoke.mockClear()
  useDisplayPrefsStore.setState({ textSize: 'default' })
  delete document.documentElement.dataset.textSize
})

describe('Appearance in the phone apps', () => {
  it.each(['ios', 'android'])('picks the text size in the app’s own control on %s', async (os) => {
    platform.os = os
    const user = userEvent.setup()
    render(<GeneralSettingsPage />)

    const group = screen.getByRole('radiogroup', { name: 'Text size' })
    await user.click(screen.getByRole('radio', { name: 'Large' }))

    expect(group).toBeInTheDocument()
    expect(useDisplayPrefsStore.getState().textSize).toBe('large')
    expect(invoke.mock.calls.some(([command]) => command === 'pick_one')).toBe(false)
  })
})
