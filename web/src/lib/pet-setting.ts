/**
 * The desktop pet's settings. The desktop shell owns them (it runs the pet
 * and its event feed), so they are read and written over IPC rather than
 * stored in this window.
 */
import { getPlatform } from '@/hooks/use-platform'
import { DEFAULT_PET_SETTINGS, type PetSettings } from '@/pet/state'

export type { PetSettings }
export { DEFAULT_PET_SETTINGS }

export const PET_SETTINGS_EVENT = 'pet-settings-changed'

/** The pet lives in the macOS and Windows desktop apps. */
export function supportsPet(): boolean {
  const platform = getPlatform()
  return platform.isTauri && (platform.os === 'macos' || platform.os === 'windows')
}

function isPetSettings(value: unknown): value is PetSettings {
  return typeof value === 'object' && value !== null && typeof (value as PetSettings).enabled === 'boolean'
}

/** The current settings, or null where there is no pet or the shell can't say. */
export async function readPetSettings(): Promise<PetSettings | null> {
  if (!supportsPet()) return null
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const settings = await invoke<unknown>('pet_settings')
    return isPetSettings(settings) ? { ...DEFAULT_PET_SETTINGS, ...settings } : null
  } catch {
    return null
  }
}

/** Change some settings; resolves to all of them as saved. */
export async function updatePetSettings(patch: Partial<Omit<PetSettings, 'position'>>): Promise<PetSettings> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<PetSettings>('pet_update_settings', { patch })
}

/** Follow changes made elsewhere (the tray, another window). Resolves to an unsubscribe. */
export async function listenPetSettings(onChange: (settings: PetSettings) => void): Promise<() => void> {
  if (!supportsPet()) return () => {}
  try {
    const { listen } = await import('@tauri-apps/api/event')
    return await listen<unknown>(PET_SETTINGS_EVENT, (event) => {
      if (isPetSettings(event.payload)) onChange({ ...DEFAULT_PET_SETTINGS, ...event.payload })
    })
  } catch {
    return () => {}
  }
}
