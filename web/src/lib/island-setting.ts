/**
 * The macOS notch island's settings. The desktop shell owns them (it runs
 * the island and its event feed), so they are read and written over IPC
 * rather than stored in this window.
 */
import { useEffect } from 'react'
import { getPlatform } from '@/hooks/use-platform'
import type { IslandSettings } from '@/island/status'

export type { IslandSettings }

export const ISLAND_SETTINGS_EVENT = 'island-settings-changed'

/** Only the macOS desktop app has a notch island. */
export function supportsIsland(): boolean {
  const platform = getPlatform()
  return platform.isTauri && platform.os === 'macos'
}

/** The current settings, or null where there is no island or the shell can't say. */
export async function readIslandSettings(): Promise<IslandSettings | null> {
  if (!supportsIsland()) return null
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const settings = await invoke<IslandSettings | null>('island_settings')
    return settings && typeof settings.enabled === 'boolean' ? settings : null
  } catch {
    return null
  }
}

/** Change some settings; resolves to all of them as saved. */
export async function updateIslandSettings(patch: Partial<IslandSettings>): Promise<IslandSettings> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<IslandSettings>('island_update_settings', { patch })
}

/**
 * Tell the shell which session this window shows. The island keeps a
 * finished session as unread until it is on screen in the focused window;
 * the shell knows which window has focus, so this only reports changes.
 */
export function useReportShownSession(sessionId: string | null | undefined): void {
  useEffect(() => {
    if (!supportsIsland()) return
    void import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke('island_viewing', { sessionId: sessionId ?? null }))
      .catch(() => {})
  }, [sessionId])
}
