/**
 * Desktop "Network access": lets devices on the LAN connect to the builtin
 * sidecar with an access key. Desktop shell only (Tauri commands in
 * `desktop/src-tauri/src/network_access.rs`).
 */

export interface NetworkAccessStatus {
  /** Saved switch position. */
  enabled: boolean
  /** Saved preferred port (default 4082). */
  requested_port: number
  /** Port actually listening; differs from `requested_port` after a fallback. */
  port: number | null
  fallback: boolean
  listening: boolean
  error: string | null
  lan_urls: string[]
  has_key: boolean
  sidecar_running: boolean
}

export const DEFAULT_NETWORK_ACCESS_PORT = 4082

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const core = await import('@tauri-apps/api/core')
  return await core.invoke<T>(command, args)
}

export function getNetworkAccessStatus(): Promise<NetworkAccessStatus> {
  return invoke<NetworkAccessStatus>('app_network_access_status')
}

export function setNetworkAccess(enabled: boolean, port: number): Promise<NetworkAccessStatus> {
  return invoke<NetworkAccessStatus>('app_set_network_access', { enabled, port })
}

export function getNetworkAccessKey(): Promise<string | null> {
  return invoke<string | null>('app_network_access_key')
}

/** Store `key`, or generate a new random key when `key` is null. */
export function setNetworkAccessKey(key: string | null): Promise<NetworkAccessStatus> {
  return invoke<NetworkAccessStatus>('app_set_network_access_key', { key })
}
