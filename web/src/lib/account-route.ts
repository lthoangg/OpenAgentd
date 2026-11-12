/**
 * Keeps the phone on the account computer it last used, and tells the
 * shell when the app comes back, goes away, or the network changes. Phone
 * only, and loaded on demand by `App.tsx` so it stays out of the startup
 * bundle.
 *
 * An account computer is reached through its link in the shell (spec 5.5):
 * directly on the home network or through the account's relay. The link
 * moves between the two by itself, under one fixed origin per computer, so
 * nothing here switches routes and nothing reloads. A saved server
 * (address and access key) is a separate thing and is never used for an
 * account computer.
 *
 * - At launch: the computer last opened (`last_account_device`) is opened
 *   again, unless the app is on it already.
 * - On resume and on a network change: `cloud_poke`, so each link checks its
 *   session and tries the direct route again.
 */
import {
  cloudPoke,
  getPhoneCloudDevices,
  getPhoneCloudStatus,
  isPhoneCloudShell,
  isServer,
  type PhoneCloudStatus,
} from '@/api/phone-cloud'
import { accountComputerTitle, getAppBackendStatus } from '@/lib/app-backend'
import { connectAccountComputer, normalizeServerBaseUrl, reloadForBackendSwitch } from '@/lib/backend-switch'
import { openServersScreen } from '@/stores/useServersScreenStore'

/** How long to wait for the shell to restore a stored account at launch. */
const ACCOUNT_RESTORE_WAIT_MS = 3000
const ACCOUNT_RESTORE_POLL_MS = 250

export type RouteOutcome = 'switched' | 'failed' | 'skipped'

let launched = false

/** Test seam: a new launch. */
export function resetAccountRoute(): void {
  launched = false
}

async function connectedAccount(): Promise<boolean> {
  const deadline = Date.now() + ACCOUNT_RESTORE_WAIT_MS
  for (;;) {
    const status: PhoneCloudStatus | null = await getPhoneCloudStatus().catch(() => null)
    if (status?.state === 'connected') return true
    // Signing in, closing, … are not a stored account being restored.
    if (status && status.state !== 'guest') return false
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, ACCOUNT_RESTORE_POLL_MS))
  }
}

async function runLaunch(): Promise<RouteOutcome> {
  const status = await getAppBackendStatus()
  if (!status?.base_url || !status.external) return 'skipped'
  const last = status.last_account_device
  if (!last || status.account_device?.device_id === last) return 'skipped'
  if (!(await connectedAccount())) return 'skipped'
  const devices = await getPhoneCloudDevices().catch(() => [])
  const device = devices.find((d) => !d.me && isServer(d) && d.device_id === last)
  if (!device) return 'skipped'
  const result = await connectAccountComputer({
    deviceId: device.device_id,
    label: accountComputerTitle(device),
    currentBaseUrl: normalizeServerBaseUrl(status.base_url),
  })
  if (!result.ok) {
    openServersScreen()
    return 'failed'
  }
  if (result.reload) reloadForBackendSwitch()
  return result.reload ? 'switched' : 'skipped'
}

/** At launch, once; later calls do nothing. `failed` shows the Servers screen (already opened here). */
export async function checkRouteAtLaunch(): Promise<RouteOutcome> {
  if (launched) return 'skipped'
  launched = true
  try {
    return await runLaunch()
  } catch {
    return 'skipped'
  }
}

/**
 * Phone only: tell the shell when the app comes back, goes away, or the
 * network changes (`cloud_poke`). Each link then checks its session and,
 * on the relay, tries the direct route again. Returns the stop.
 */
export function startAccountRouteWatch(): () => void {
  if (!isPhoneCloudShell()) return () => {}
  const onVisibility = () => {
    cloudPoke(document.visibilityState === 'visible' ? 'resumed' : 'background')
  }
  const onOnline = () => cloudPoke('network_changed')
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('online', onOnline)
  return () => {
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('online', onOnline)
  }
}
