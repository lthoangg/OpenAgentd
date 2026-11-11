export interface SavedAppServer {
  base_url: string
  name?: string | null
  /** Desktop only: watch it in the background (the notch follows it with no window open). */
  enabled?: boolean
}

/** Where the desktop shell's background connection to a followed server stands. */
export type ServerWatchState = 'connecting' | 'connected' | 'reconnecting' | 'key_rejected'

/** The account computer an account bridge reaches (phone shell only). */
export interface AccountBridgeDevice {
  device_id: string
  fingerprint: string
  kind: string | null
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
  /**
   * Phone shell: set while the app is on an account bridge (a loopback
   * origin that relays to this computer of the account). Absent elsewhere.
   */
  account_device?: AccountBridgeDevice | null
  /**
   * Phone shell: the account computer last opened with `cloud_open_computer`
   * (over its LAN address or the account); cleared when the person switches
   * to some other server. Absent from an older shell.
   */
  last_account_device?: string | null
}

/** Where the phone remembers which saved LAN server is which account computer. */
export const LAN_COMPUTERS_KEY = 'openagentd.cloud.lanComputers'

const KIND_LABELS: Record<string, string> = {
  macos: 'macOS',
  linux: 'Linux',
  windows: 'Windows',
  ios: 'iOS',
  android: 'Android',
}

/** "macOS" for `macos`; null when the account does not say or names a kind
 *  outside the API's set (it is self-reported, so free text is never shown). */
export function deviceKindLabel(kind: string | null | undefined): string | null {
  if (!kind) return null
  return Object.hasOwn(KIND_LABELS, kind) ? KIND_LABELS[kind] : null
}

/** "macOS · 3F9A 21C4": what a device is called in lists. */
export function deviceLabel(device: { kind: string | null | undefined; fingerprint: string }): string {
  return [deviceKindLabel(device.kind), device.fingerprint].filter(Boolean).join(' · ')
}

/** `3f9a 21c4` and `3F9A-21C4` are the same fingerprint. */
export const normalizeFingerprint = (fingerprint: string) => fingerprint.replace(/[\s-]+/g, '').toUpperCase()

function readLanComputers(): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(LAN_COMPUTERS_KEY) ?? '{}')
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

/**
 * What an account computer is called: the name the person gave the saved
 * LAN server that is this computer (same remembered fingerprint), else its
 * kind and fingerprint. The Servers row and the connection label agree.
 */
export function accountComputerTitle(
  device: { kind: string | null | undefined; fingerprint: string },
  servers: SavedAppServer[],
  lanComputers: Record<string, unknown> = readLanComputers(),
): string {
  const lan = lanComputers[normalizeFingerprint(device.fingerprint)]
  if (typeof lan === 'string') {
    const url = normalizeServerOrigin(lan)
    const name = servers.find((server) => normalizeServerOrigin(server.base_url) === url)?.name?.trim()
    if (name) return name
  }
  return deviceLabel(device)
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
 * An account bridge (phone) → the computer, as its Servers row calls it.
 * Otherwise the host only — never a path, token, or full URL.
 */
export function formatBackendConnectionLabel(
  status: AppBackendStatus | null,
  fallbackBaseUrl: string,
): string {
  if (!status) {
    const fallback = fallbackBaseUrl.trim()
    if (!fallback || fallback === '/api' || fallback.endsWith('://api')) return 'built-in'
    return hostFromBaseUrl(fallback)
  }
  if (status.mode === 'bundled' || (!status.external && status.mode !== 'external')) {
    return 'built-in'
  }
  if (status.account_device) return accountComputerTitle(status.account_device, status.servers)
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

export async function setAppBackendServerEnabled(baseUrl: string, enabled: boolean): Promise<AppBackendStatus> {
  const { invoke } = await import('@tauri-apps/api/core')
  return await invoke<AppBackendStatus>('app_set_backend_server_enabled', { baseUrl, enabled })
}

/** Background connection state per followed server, by normalised base URL. Empty when unavailable. */
export async function getServerWatchStates(): Promise<Record<string, ServerWatchState>> {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    return await invoke<Record<string, ServerWatchState>>('app_server_watch_states')
  } catch {
    return {}
  }
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
