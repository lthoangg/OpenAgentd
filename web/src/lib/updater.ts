import { getPlatform } from '@/hooks/use-platform'

export type UpdateStatus = {
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'up_to_date' | 'error'
  version?: string | null
  current_version?: string
  notes?: string | null
  downloaded_bytes?: number | null
  total_bytes?: number | null
  message?: string | null
  /**
   * Android only: `apk` downloads and opens the Android installer. Absent on
   * desktop.
   */
  channel?: 'apk' | null
}

/**
 * Whether this shell updates itself: desktop and Android do. The browser
 * build has no updater, and on iOS TestFlight and the App Store deliver and
 * announce new builds themselves.
 */
export function hasInAppUpdates(): boolean {
  const { isTauri, os } = getPlatform()
  return isTauri && os !== 'ios'
}

export async function checkForUpdates(silent = false): Promise<UpdateStatus> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<UpdateStatus>('updater_check', { request: { silent } })
}

export async function downloadUpdate(): Promise<UpdateStatus> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<UpdateStatus>('updater_download')
}

export type ReleaseNotes = {
  version: string
  url: string
  body: string
}

export async function installUpdate(): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('updater_install')
}

export async function fetchReleaseNotes(version: string): Promise<ReleaseNotes> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<ReleaseNotes>('updater_release_notes', { version })
}
