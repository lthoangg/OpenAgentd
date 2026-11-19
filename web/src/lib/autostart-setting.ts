/**
 * "Open at login" for the desktop app. The operating system holds the
 * state (a login item), so the shell reads and writes it over IPC and
 * nothing is stored in this window.
 */
import { isDesktopShell } from '@/lib/desktop-shell'

/** Whether the app opens at login now; null outside the desktop app or in an app too old to say. */
export async function readAutostart(): Promise<boolean | null> {
  if (!isDesktopShell()) return null
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const enabled = await invoke<unknown>('autostart_enabled')
    return typeof enabled === 'boolean' ? enabled : null
  } catch {
    return null
  }
}

/** Turn it on or off; resolves to what the system says afterwards. Rejects with the system's reason. */
export async function setAutostart(enabled: boolean): Promise<boolean> {
  const { invoke } = await import('@tauri-apps/api/core')
  try {
    return await invoke<boolean>('autostart_set', { enabled })
  } catch (error) {
    // Tauri rejects with a bare string.
    throw error instanceof Error ? error : new Error(String(error))
  }
}
