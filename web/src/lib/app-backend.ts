export interface SavedAppServer {
  base_url: string
  name?: string | null
}

export interface AppBackendStatus {
  base_url: string
  token?: string | null
  mode?: 'bundled' | 'external'
  sidecar_running: boolean
  /** Desktop bundled-sidecar spawn/handshake is already in progress. */
  backend_starting?: boolean
  /** The last bundled-sidecar startup attempt failed. */
  backend_failed?: boolean
  external: boolean
  supports_bundled: boolean
  servers: SavedAppServer[]
}

function hostFromBaseUrl(value: string): string {
  try {
    const url = new URL(value.includes('://') ? value : `http://${value}`)
    return url.hostname || 'backend'
  } catch {
    return 'backend'
  }
}

function normalizeServerOrigin(value: string): string {
  return value.trim().replace(/\/+$/, '').replace(/\/api$/i, '')
}

/**
 * Short status-bar label for the connected backend.
 * Bundled sidecar → ``builtin``. Named saved server → its name.
 * Otherwise the host only — never a path, token, or full URL.
 */
export function formatBackendConnectionLabel(
  status: AppBackendStatus | null,
  fallbackBaseUrl: string,
): string {
  if (!status) {
    const fallback = fallbackBaseUrl.trim()
    if (!fallback || fallback === '/api' || fallback.endsWith('://api')) return 'builtin'
    return hostFromBaseUrl(fallback)
  }
  if (status.mode === 'bundled' || (!status.external && status.mode !== 'external')) {
    return 'builtin'
  }
  const current = normalizeServerOrigin(status.base_url)
  const named = status.servers.find((server) => normalizeServerOrigin(server.base_url) === current)
  const name = named?.name?.trim()
  if (name) return name
  return hostFromBaseUrl(status.base_url)
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

export async function stopBundledAppBackend(): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('app_stop_bundled_backend')
}

export async function getBundledBackendLogPath(): Promise<string | null> {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    return await invoke<string>('backend_logs_path')
  } catch {
    return null
  }
}
