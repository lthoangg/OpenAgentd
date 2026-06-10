export interface SavedAppServer {
  base_url: string
  name?: string | null
}

export interface AppBackendStatus {
  base_url: string
  token?: string | null
  mode?: 'bundled' | 'external'
  sidecar_running: boolean
  external: boolean
  supports_bundled: boolean
  servers: SavedAppServer[]
}

export async function getAppBackendStatus(): Promise<AppBackendStatus | null> {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    return await invoke<AppBackendStatus>('app_backend_status')
  } catch {
    return null
  }
}

export async function saveAppBackendServer(baseUrl: string, name: string): Promise<AppBackendStatus> {
  const { invoke } = await import('@tauri-apps/api/core')
  return await invoke<AppBackendStatus>('app_save_backend_server', { baseUrl, name })
}

export async function removeAppBackendServer(baseUrl: string): Promise<AppBackendStatus> {
  const { invoke } = await import('@tauri-apps/api/core')
  return await invoke<AppBackendStatus>('app_remove_backend_server', { baseUrl })
}

export async function switchToExternalAppBackend(baseUrl: string, name: string, persist: boolean): Promise<AppBackendStatus> {
  const { invoke } = await import('@tauri-apps/api/core')
  return await invoke<AppBackendStatus>('app_use_external_backend', { baseUrl, name, persist })
}

export async function switchToBundledAppBackend(): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('app_use_bundled_backend')
}
