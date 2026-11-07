export type UpdateStatus = {
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'up_to_date' | 'error'
  version?: string | null
  current_version?: string
  notes?: string | null
  downloaded_bytes?: number | null
  total_bytes?: number | null
  message?: string | null
  /**
   * Mobile only: how the update is installed. `apk` downloads and opens the
   * Android installer; `testflight` opens TestFlight, because iOS apps
   * cannot install their own updates; `sidestore` marks a SideStore copy,
   * which is sent to the TestFlight download page. Absent on desktop.
   */
  channel?: 'apk' | 'testflight' | 'sidestore' | null
}

/** Button label for an available update that opens another app (iOS). */
export function openStoreLabel(status: UpdateStatus): string | null {
  if (status.channel === 'testflight') return 'Open TestFlight'
  if (status.channel === 'sidestore') return 'Get it on TestFlight'
  return null
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
