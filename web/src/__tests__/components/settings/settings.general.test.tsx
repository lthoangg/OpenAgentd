/**
 * Settings → General: the macOS notch status settings.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { DEFAULT_ISLAND_SETTINGS, type IslandSettings } from '@/island/status'

let supported = true
let stored: IslandSettings = DEFAULT_ISLAND_SETTINGS
let patches: Partial<IslandSettings>[] = []
let failWrite = false

mock.module('@/lib/island-setting', () => ({
  ISLAND_SETTINGS_EVENT: 'island-settings-changed',
  supportsIsland: () => supported,
  readIslandSettings: async () => (supported ? stored : null),
  updateIslandSettings: async (patch: Partial<IslandSettings>) => {
    patches.push(patch)
    if (failWrite) throw new Error('Could not save the setting.')
    stored = { ...stored, ...patch }
    return stored
  },
}))

const { GeneralSettingsPage } = await import('@/components/settings/pages/settings.general')

const toggle = (name: string) => screen.findByRole('switch', { name })

beforeEach(() => {
  supported = true
  stored = DEFAULT_ISLAND_SETTINGS
  patches = []
  failWrite = false
})
afterEach(cleanup)

describe('GeneralSettingsPage notch status', () => {
  it('shows the saved settings, with showing in front off by default', async () => {
    render(<GeneralSettingsPage />)
    expect(await toggle('Agent status in the notch')).toHaveAttribute('aria-checked', 'true')
    expect(await toggle('Show while OpenAgentd is in front')).toHaveAttribute('aria-checked', 'false')
    expect(await toggle('Show when nothing is running')).toHaveAttribute('aria-checked', 'false')
    expect(await toggle('Show when a turn finishes')).toHaveAttribute('aria-checked', 'true')
    expect(await toggle('Expand on hover')).toHaveAttribute('aria-checked', 'true')
  })

  it('saves only the option that changed', async () => {
    render(<GeneralSettingsPage />)
    fireEvent.click(await toggle('Show while OpenAgentd is in front'))
    await waitFor(() => expect(patches).toEqual([{ showWhenFrontmost: true }]))
    expect(await toggle('Show while OpenAgentd is in front')).toHaveAttribute('aria-checked', 'true')
  })

  it('disables the options while the island is off', async () => {
    stored = { ...DEFAULT_ISLAND_SETTINGS, enabled: false }
    render(<GeneralSettingsPage />)
    expect(await toggle('Expand on hover')).toBeDisabled()
    fireEvent.click(await toggle('Agent status in the notch'))
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Expand on hover' })).not.toBeDisabled())
  })

  it('puts the switch back and says why when saving fails', async () => {
    failWrite = true
    render(<GeneralSettingsPage />)
    const main = await toggle('Agent status in the notch')

    fireEvent.click(main)
    await waitFor(() => expect(main).toHaveAttribute('aria-checked', 'true'))
    expect(screen.getByText('Could not save the setting.')).toBeInTheDocument()
  })

  it('has no notch section outside the macOS app', async () => {
    supported = false
    render(<GeneralSettingsPage />)
    await screen.findByText('Theme')
    expect(screen.queryByText('Agent status in the notch')).toBeNull()
  })
})
