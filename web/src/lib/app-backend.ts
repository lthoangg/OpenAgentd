export interface SavedAppServer {
  base_url: string
  name?: string | null
  /** Desktop only: watch it in the background (the notch follows it with no window open). */
  enabled?: boolean
}

/** Where the desktop shell's background connection to a followed server stands. */
export type ServerWatchState = 'connecting' | 'connected' | 'reconnecting' | 'key_rejected'

/** The account computer an account bridge reaches (phone and desktop shells). */
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
   * Set while the window is on an account bridge (a loopback origin that
   * relays to this computer of the account): the phone shell's, or the
   * desktop's built-in server's. Absent elsewhere.
   */
  account_device?: AccountBridgeDevice | null
  /**
   * Phone shell: the account computer last opened with `cloud_open_computer`
   * (over its LAN address or the account); cleared when the person switches
   * to some other server. Absent from an older shell.
   */
  last_account_device?: string | null
  /**
   * What each computer called itself when the app was last on it
   * (`GET /api/server/name`), by account device id, by a saved server's
   * normalised base URL, or under `BUILT_IN_NAME_KEY` for the desktop's own
   * server. Absent from an older shell, and for a computer never connected
   * to. Text a computer says about itself: shown as plain text, never used
   * to decide anything.
   */
  computer_names?: ComputerNames
}

/** Remembered computer names, by `computerNameKey`. */
export type ComputerNames = Record<string, string>

/** The key the desktop's built-in server's name is remembered under. */
export const BUILT_IN_NAME_KEY = 'built-in'

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

/** Hebrew, Arabic and the other right-to-left scripts. */
const RIGHT_TO_LEFT = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/

/**
 * `name · key` on one line. A right-to-left name is set apart (first strong
 * isolate … pop isolate), so the key after it reads in its own order.
 */
function nameWithKey(name: string, fingerprint: string): string {
  return `${RIGHT_TO_LEFT.test(name) ? `\u2068${name}\u2069` : name} · ${fingerprint}`
}

/**
 * An account computer's title: the name it gave for itself, once this app
 * has been on it; until then its kind and fingerprint, from the account.
 * Never a saved server's name, which belongs to a different thing even on
 * the same machine.
 */
export function accountComputerTitle(
  device: { device_id?: string; kind: string | null | undefined; fingerprint: string },
  names?: ComputerNames | null,
): string {
  const name = device.device_id ? names?.[device.device_id]?.trim() : undefined
  return name || deviceLabel(device)
}

/**
 * The titles of a list of devices, by device id: each one's name (else its
 * kind and fingerprint), with the fingerprint added after a name only while
 * two of them share it, so the list never shows the same line twice.
 */
export function deviceTitles(
  devices: Array<{ device_id: string; kind: string | null | undefined; fingerprint: string }>,
  names?: ComputerNames | null,
): Map<string, string> {
  const titled = devices.map((device) => ({ device, title: accountComputerTitle(device, names) }))
  const count = new Map<string, number>()
  for (const { title } of titled) count.set(title.toLowerCase(), (count.get(title.toLowerCase()) ?? 0) + 1)
  return new Map(titled.map(({ device, title }) => {
    const shared = (count.get(title.toLowerCase()) ?? 0) > 1 && !title.includes(device.fingerprint)
    return [device.device_id, shared ? nameWithKey(title, device.fingerprint) : title]
  }))
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
 * A saved server's title: the name you gave it, else the name its computer
 * gave for itself, else its address.
 */
export function savedServerTitle(server: SavedAppServer, names?: ComputerNames | null): string {
  return server.name?.trim() || names?.[normalizeServerOrigin(server.base_url)]?.trim() || server.base_url
}

/**
 * The key the name of the server in use is remembered under: the device id
 * on an account bridge, `BUILT_IN_NAME_KEY` on the desktop's own server,
 * else the server's address. `null` when the app is on no server.
 */
export function computerNameKey(status: AppBackendStatus | null): string | null {
  if (!status) return null
  if (status.mode === 'bundled' || (!status.external && status.mode !== 'external')) return BUILT_IN_NAME_KEY
  if (status.account_device) return status.account_device.device_id
  return normalizeServerOrigin(status.base_url) || null
}

/**
 * Short status-bar label for the connected backend.
 * Bundled sidecar → ``builtin``. Named saved server → its name.
 * An account bridge → the computer, as its Servers row calls it.
 * Otherwise the name the computer gave for itself, else the host only:
 * never a path, token, or full URL.
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
  if (status.account_device) return accountComputerTitle(status.account_device, status.computer_names)
  const current = normalizeServerOrigin(status.base_url)
  const named = status.servers.find((server) => normalizeServerOrigin(server.base_url) === current)
  const name = named?.name?.trim()
  if (name) return name
  return status.computer_names?.[current]?.trim() || hostFromBaseUrl(status.base_url)
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

/**
 * Remember what the computer under `key` (`computerNameKey`) calls itself.
 * `null` from a shell that predates the command, or outside a shell.
 */
export async function rememberComputerName(key: string, name: string): Promise<AppBackendStatus | null> {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    return await invoke<AppBackendStatus>('app_remember_computer_name', { key, name })
  } catch {
    return null
  }
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

/** Desktop: start the built-in server without switching this window to it. */
export async function startBundledAppBackend(): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('app_start_bundled_backend')
}

export async function getBundledBackendLogPath(): Promise<string | null> {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    return await invoke<string>('backend_logs_path')
  } catch {
    return null
  }
}
