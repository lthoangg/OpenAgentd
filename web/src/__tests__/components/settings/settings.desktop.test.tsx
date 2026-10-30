/**
 * Settings → Desktop: the macOS notch status settings (moved off General).
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

const { DesktopSettingsPage } = await import('@/components/settings/pages/settings.desktop')
const { GeneralSettingsPage } = await import('@/components/settings/pages/settings.general')

const toggle = (name: string) => screen.findByRole('switch', { name })

beforeEach(() => {
  supported = true
  stored = DEFAULT_ISLAND_SETTINGS
  patches = []
  failWrite = false
})
afterEach(cleanup)

describe('DesktopSettingsPage notch status', () => {
  it('shows the saved settings, with showing in front off by default', async () => {
    render(<DesktopSettingsPage />)
    expect(await toggle('Agent status in the notch')).toHaveAttribute('aria-checked', 'true')
    expect(await toggle('Show while OpenAgentd is in front')).toHaveAttribute('aria-checked', 'false')
    expect(await toggle('Keep finished sessions until opened')).toHaveAttribute('aria-checked', 'true')
    expect(await toggle('Expand on hover')).toHaveAttribute('aria-checked', 'true')
    expect(screen.queryByRole('switch', { name: /nothing is running/ })).toBeNull()
  })

  it('saves only the option that changed', async () => {
    render(<DesktopSettingsPage />)
    fireEvent.click(await toggle('Show while OpenAgentd is in front'))
    await waitFor(() => expect(patches).toEqual([{ showWhenFrontmost: true }]))
    expect(await toggle('Show while OpenAgentd is in front')).toHaveAttribute('aria-checked', 'true')
  })

  it('disables the options while the island is off', async () => {
    stored = { ...DEFAULT_ISLAND_SETTINGS, enabled: false }
    render(<DesktopSettingsPage />)
    expect(await toggle('Expand on hover')).toBeDisabled()
    fireEvent.click(await toggle('Agent status in the notch'))
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Expand on hover' })).not.toBeDisabled())
  })

  it('puts the switch back and says why when saving fails', async () => {
    failWrite = true
    render(<DesktopSettingsPage />)
    const main = await toggle('Agent status in the notch')

    fireEvent.click(main)
    await waitFor(() => expect(main).toHaveAttribute('aria-checked', 'true'))
    expect(screen.getByText('Could not save the setting.')).toBeInTheDocument()
  })

  it('has no notch section outside the macOS app', async () => {
    supported = false
    render(<DesktopSettingsPage />)
    await screen.findByText('Desktop')
    expect(screen.queryByText('Agent status in the notch')).toBeNull()
  })

  it('keeps General to theme and transcript', async () => {
    render(<GeneralSettingsPage />)
    await screen.findByText('Theme')
    expect(screen.queryByText('Agent status in the notch')).toBeNull()
  })

  it('says why the options are off', async () => {
    stored = { ...DEFAULT_ISLAND_SETTINGS, enabled: false }
    render(<DesktopSettingsPage />)
    await toggle('Expand on hover')
    expect(screen.getAllByText('Turn on Agent status to change this.').length).toBe(3)
  })
})
