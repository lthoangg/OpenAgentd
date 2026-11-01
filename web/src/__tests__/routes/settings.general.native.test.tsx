/**
 * Settings → Appearance in the phone apps: each choice opens the system's own
 * picker instead of a segmented control.
 */
import '@testing-library/jest-dom'

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const platform = { isTauri: true, os: 'ios', isMacOverlay: false }
mock.module('@/hooks/use-platform', () => ({ getPlatform: () => platform, usePlatform: () => platform }))

let picked: unknown = 'large'
const invoke = mock(async (..._args: unknown[]) => picked)
mock.module('@tauri-apps/api/core', () => ({ invoke }))

const { useDisplayPrefsStore } = await import('@/stores/useDisplayPrefsStore')
const { GeneralSettingsPage } = await import('@/components/settings/pages/settings.general')

beforeEach(() => {
  picked = 'large'
  invoke.mockClear()
})

afterEach(() => {
  cleanup()
  useDisplayPrefsStore.setState({ textSize: 'default' })
  delete document.documentElement.dataset.textSize
})

describe('Appearance in the phone apps', () => {
  it.each(['ios', 'android'])('picks the text size from the system picker on %s', async (os) => {
    platform.os = os
    const user = userEvent.setup()
    render(<GeneralSettingsPage />)

    expect(screen.queryByRole('radiogroup', { name: 'Text size' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Text size: Default' }))

    await waitFor(() => expect(useDisplayPrefsStore.getState().textSize).toBe('large'))
    expect(invoke.mock.calls[0]).toEqual([
      'pick_one',
      {
        title: 'Text size',
        options: [
          { id: 'compact', label: 'Compact' },
          { id: 'default', label: 'Default' },
          { id: 'large', label: 'Large' },
        ],
        selected: 'default',
      },
    ])
  })

  it('keeps the choice when the picker is dismissed', async () => {
    platform.os = 'ios'
    picked = null
    const user = userEvent.setup()
    render(<GeneralSettingsPage />)

    await user.click(screen.getByRole('button', { name: 'Text size: Default' }))

    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1))
    expect(useDisplayPrefsStore.getState().textSize).toBe('default')
  })
})
