/**
 * Switching the app's backend: the steps behind every "Connect" and "Use
 * builtin" button. Settings → Connection (`AppBackendPanel`) and the command
 * palette's Switch Server… both call these, so a switch checks the server and
 * its key, clears the old session state, and shows the "Switching to …"
 * screen (`BackendSwitchScreen`) the same way from either.
 */
import { apiBaseUrl, setApiBaseUrl } from '@/api/base-url'
import { getStoredAccessKey, installDesktopAuth, primeStoredAccessKey, setStoredAccessKey } from '@/api/auth'
import { queryClient } from '@/lib/query-client'
import { forgetRouteForBackendSwitch } from '@/lib/route-restore'
import { checkServerAuth, pingServer } from '@/lib/server-probe'
import { queryKeys } from '@/queries/keys'
import { beginBackendSwitch, endBackendSwitch, type BackendSwitchTarget } from '@/stores/useBackendSwitchStore'
import {
  getAppBackendStatus,
  switchToBundledAppBackend,
  switchToExternalAppBackend,
  type AppBackendStatus,
} from '@/lib/app-backend'

export function normalizeServerBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '')
  return trimmed.endsWith('/api') ? trimmed.slice(0, -4) : trimmed
}

export function validateServerUrl(value: string): string | null {
  if (!value) return 'Enter a server URL first.'
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return 'Enter a full server URL, including http:// or https://.'
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `Unsupported URL scheme: ${parsed.protocol.replace(/:$/, '')}`
  }
  return null
}

export function connectionFailureMessage(baseUrl: string): string {
  try {
    const host = new URL(baseUrl).hostname
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') {
      return 'Server did not respond to /api/health/live. Make sure OpenAgentd is running locally and the port is correct.'
    }
  } catch {
    // validateServerUrl already handles malformed URLs.
  }
  return 'Server did not respond to /api/health/live. Check that OpenAgentd is running with --host 0.0.0.0, this device is on the same network, and the URL uses the backend machine LAN IP.'
}

export async function refreshBackendQueries(): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: queryKeys.health() })
  // ``agents()`` is a prefix of ``agentRegistry(workspace)``, so this covers the
  // shared /agent/agents entry for every workspace after a backend switch.
  await queryClient.invalidateQueries({ queryKey: queryKeys.agents() })
}

/** The origin the app talks to now. */
export function currentBackendOrigin(status: AppBackendStatus | null): string {
  return normalizeServerBaseUrl(status?.base_url || apiBaseUrl().replace(/\/api$/, ''))
}

/** Reload the window onto a new backend, forgetting the route of the old one. */
export function reloadForBackendSwitch(): void {
  forgetRouteForBackendSwitch()
  window.location.reload()
}

/** What the switching screen calls the builtin sidecar. */
export const BUILTIN_SWITCH_TARGET: BackendSwitchTarget = {
  name: 'the builtin server',
  detail: "Running sessions continue once it's up.",
}

function serverLabel(name: string, baseUrl: string): string {
  if (name.trim()) return name.trim()
  try {
    return new URL(baseUrl).host || baseUrl
  } catch {
    return baseUrl
  }
}

/**
 * Show the switching screen while `run` switches. It stays up when the
 * caller is about to reload onto the new server (the startup screen takes
 * over from it), and goes away on a failure, so the error shows where the
 * user started.
 */
async function withSwitchScreen<T extends { ok: true; reload: boolean } | { ok: false; error: string }>(target: BackendSwitchTarget, run: () => Promise<T>): Promise<T> {
  beginBackendSwitch(target)
  const result = await run()
  if (!result.ok || !result.reload) endBackendSwitch()
  return result
}

export type ExternalSwitchResult =
  | { ok: true; status: AppBackendStatus; reload: boolean }
  | { ok: false; error: string }

/**
 * Check a server (reachable, key accepted), then switch this window to it.
 * The caller reloads when `reload` is true (the origin changed).
 */
export async function connectExternalBackend(options: {
  baseUrl: string
  name: string
  persist: boolean
  /** Key typed by the user; else the one stored for the server. */
  accessKey?: string
  /** Origin the app is on now, to tell whether a reload is needed. */
  currentBaseUrl: string
  /** Told whether the ping got an answer. */
  onHealth?: (target: string, online: boolean) => void
}): Promise<ExternalSwitchResult> {
  const target = normalizeServerBaseUrl(options.baseUrl)
  const validationError = validateServerUrl(target)
  if (validationError) return { ok: false, error: validationError }
  return withSwitchScreen({ name: serverLabel(options.name, target), detail: target }, () => switchExternal(target, options))
}

async function switchExternal(target: string, options: Parameters<typeof connectExternalBackend>[0]): Promise<ExternalSwitchResult> {
  try {
    const online = await pingServer(target)
    options.onHealth?.(target, online)
    if (!online) return { ok: false, error: connectionFailureMessage(target) }
    const typedKey = options.accessKey?.trim() ?? ''
    const keyForConnect = typedKey || await getStoredAccessKey(target) || ''
    if (!await checkServerAuth(target, keyForConnect)) {
      return { ok: false, error: 'Server is reachable, but the access key is invalid or missing.' }
    }
    if (typedKey) await setStoredAccessKey(options.accessKey ?? '', target)
    const next = await switchToExternalAppBackend(target, options.name, options.persist)
    await primeStoredAccessKey(next.base_url)
    delete window.__OAD_TOKEN__
    setApiBaseUrl(next.base_url)
    installDesktopAuth()
    const reload = normalizeServerBaseUrl(next.base_url) !== options.currentBaseUrl
    await refreshBackendQueries()
    return { ok: true, status: next, reload }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export type BundledSwitchResult =
  | { ok: true; status: AppBackendStatus | null; reload: boolean }
  | { ok: false; error: string }

/** Switch this window to the builtin sidecar, starting it when needed. */
export async function connectBundledBackend(currentBaseUrl: string): Promise<BundledSwitchResult> {
  return withSwitchScreen(BUILTIN_SWITCH_TARGET, () => switchBundled(currentBaseUrl))
}

async function switchBundled(currentBaseUrl: string): Promise<BundledSwitchResult> {
  try {
    await switchToBundledAppBackend()
    const next = await getAppBackendStatus()
    if (next?.base_url) {
      setApiBaseUrl(next.base_url)
      await primeStoredAccessKey(next.base_url)
      installDesktopAuth()
    }
    await refreshBackendQueries()
    const reload = Boolean(next?.base_url) && normalizeServerBaseUrl(next?.base_url ?? '') !== currentBaseUrl
    return { ok: true, status: next, reload }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
