import { queryClient } from '@/lib/query-client'
import { queryKeys } from '@/queries/keys'

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
   * cannot install their own updates. `appstore` and `dev` iOS copies never
   * offer an update: the App Store updates the app itself. Absent on desktop.
   */
  channel?: AppChannel | null
}

export type AppChannel = 'apk' | 'testflight' | 'appstore' | 'dev'

/** Button label for an available update that opens another app (iOS). */
export function openStoreLabel(status: UpdateStatus): string | null {
  if (status.channel === 'testflight') return 'Open TestFlight'
  return null
}

/** The connected server's version, from the health query's cache. */
function serverVersion(): string | undefined {
  return queryClient.getQueryData<{ version?: string }>(queryKeys.health())?.version
}

export async function checkForUpdates(silent = false): Promise<UpdateStatus> {
  const { invoke } = await import('@tauri-apps/api/core')
  // A TestFlight copy learns about a new version from its server.
  return invoke<UpdateStatus>('updater_check', { request: { silent, server_version: serverVersion() } })
}

/** How the mobile app was installed; null on desktop and in a browser. */
export async function appChannel(): Promise<AppChannel | null> {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    return await invoke<AppChannel>('updater_channel')
  } catch {
    return null
  }
}

/** Human name for a channel, shown in Settings → About. */
export function channelLabel(channel: AppChannel | null): string | null {
  if (channel === 'testflight') return 'TestFlight beta'
  if (channel === 'appstore') return 'App Store'
  if (channel === 'dev') return 'Development build'
  return null
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
