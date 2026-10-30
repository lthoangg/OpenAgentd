/**
 * Settings → General → Desktop pet.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { DEFAULT_PET_SETTINGS, type PetSettings } from '@/pet/state'

let stored: PetSettings = DEFAULT_PET_SETTINGS
let patches: Partial<PetSettings>[] = []
let failWrite = false
let onExternalChange: ((settings: PetSettings) => void) | undefined

mock.module('@/lib/pet-setting', () => ({
  PET_SETTINGS_EVENT: 'pet-settings-changed',
  DEFAULT_PET_SETTINGS,
  supportsPet: () => true,
  readPetSettings: async () => stored,
  updatePetSettings: async (patch: Partial<PetSettings>) => {
    patches.push(patch)
    if (failWrite) throw new Error('Could not save the setting.')
    stored = { ...stored, ...patch }
    return stored
  },
  listenPetSettings: async (onChange: (settings: PetSettings) => void) => {
    onExternalChange = onChange
    return () => {
      onExternalChange = undefined
    }
  },
}))

const { PetSettingsSection } = await import('@/components/settings/PetSettingsSection')

const toggle = (name: string) => screen.findByRole('switch', { name })

beforeEach(() => {
  stored = DEFAULT_PET_SETTINGS
  patches = []
  failWrite = false
  onExternalChange = undefined
})
afterEach(cleanup)

describe('PetSettingsSection', () => {
  it('is off by default, with its options waiting behind the switch', async () => {
    render(<PetSettingsSection />)
    expect(await toggle('Show a desktop pet')).toHaveAttribute('aria-checked', 'false')
    expect(await toggle('Show notifications in its bubble')).toBeDisabled()
    expect(await toggle('Show pet while OpenAgentd is in front')).toBeDisabled()
    expect(screen.getByRole('radio', { name: 'Playful' })).toBeDisabled()
  })

  it('offers no full-screen switch: the pet always steps aside for full-screen apps', async () => {
    stored = { ...DEFAULT_PET_SETTINGS, enabled: true }
    render(<PetSettingsSection />)
    await toggle('Show pet while OpenAgentd is in front')
    expect(screen.queryByRole('switch', { name: /full-screen/i })).toBeNull()
  })

  it('turns the pet on and saves only that', async () => {
    render(<PetSettingsSection />)
    fireEvent.click(await toggle('Show a desktop pet'))
    await waitFor(() => expect(patches).toEqual([{ enabled: true }]))
    expect(await toggle('Show notifications in its bubble')).not.toBeDisabled()
    expect(await toggle('Show notifications in its bubble')).toHaveAttribute('aria-checked', 'true')
  })

  it('saves each option as it changes', async () => {
    stored = { ...DEFAULT_PET_SETTINGS, enabled: true }
    render(<PetSettingsSection />)
    fireEvent.click(await screen.findByRole('radio', { name: 'Blue' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Duck' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Large' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Chaotic' }))
    fireEvent.click(await toggle('Show pet while OpenAgentd is in front'))
    fireEvent.click(await toggle('Climb on windows'))
    fireEvent.click(await toggle('Finished replies'))
    await waitFor(() =>
      expect(patches).toEqual([
        { colour: 'blue' },
        { character: 'duck' },
        { size: 'large' },
        { movement: 'chaotic' },
        { showWhenFrontmost: true },
        { climb: false },
        { bubbleKinds: { inputNeeded: true, assistantDone: false, reminderFired: true } },
      ]),
    )
  })

  it('greys out the kinds while bubbles are off', async () => {
    stored = { ...DEFAULT_PET_SETTINGS, enabled: true, bubbles: false }
    render(<PetSettingsSection />)
    expect(await toggle('Questions')).toBeDisabled()
    expect(await toggle('Reminders')).toBeDisabled()
  })

  it('follows a change made from the tray', async () => {
    render(<PetSettingsSection />)
    const main = await toggle('Show a desktop pet')
    await waitFor(() => expect(onExternalChange).toBeDefined())
    act(() => onExternalChange?.({ ...DEFAULT_PET_SETTINGS, enabled: true }))
    await waitFor(() => expect(main).toHaveAttribute('aria-checked', 'true'))
  })

  it('puts the switch back and says why when saving fails', async () => {
    failWrite = true
    render(<PetSettingsSection />)
    const main = await toggle('Show a desktop pet')
    fireEvent.click(main)
    await waitFor(() => expect(main).toHaveAttribute('aria-checked', 'false'))
    expect(screen.getByText('Could not save the setting.')).toBeInTheDocument()
  })
})
