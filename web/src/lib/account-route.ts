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
 *   again, unless the app is on it already, also when no server is saved.
 * - On resume and on a network change: `cloud_poke`, so each link checks its
 *   session and tries the direct route again. On resume the shell first
 *   makes its bridges listen again (iOS may take a suspended app's
 *   listening sockets); once it answers, the page checks health at once, and
 *   reloads if the shell had to move the bridge to another port.
 * - When the page starts visible it says `resumed` too: a page that reloaded
 *   (onto a computer, or by itself) said `background` as it unloaded, and
 *   would otherwise leave every link waiting for the app to come back. The
 *   `visibilitychange` of its own unload is not reported as `background`.
 * - On an account computer, a failed health check pokes `user_retry` once
 *   (until health answers again) and checks again.
 */
import {
  cloudPoke,
  cloudPokeAndWait,
  getPhoneCloudDevices,
  getPhoneCloudStatus,
  isPhoneCloudShell,
  isServer,
  type PhoneCloudStatus,
} from '@/api/phone-cloud'
import { accountComputerTitle, getAppBackendStatus } from '@/lib/app-backend'
import { apiBaseUrl } from '@/api/base-url'
import { connectAccountComputer, normalizeServerBaseUrl, reloadForBackendSwitch } from '@/lib/backend-switch'
import { markPageUnloading, pageUnloading, resetPageUnloading } from '@/lib/page-unload'
import { queryClient } from '@/lib/query-client'
import { queryKeys } from '@/queries/keys'
import { openServersScreen } from '@/stores/useServersScreenStore'

/** How long to wait for the shell to restore a stored account at launch. */
const ACCOUNT_RESTORE_WAIT_MS = 3000
const ACCOUNT_RESTORE_POLL_MS = 250

export type RouteOutcome = 'switched' | 'failed' | 'skipped'

let launched = false

/** Test seam: a new launch. */
export function resetAccountRoute(): void {
  launched = false
  resetPageUnloading()
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
  // A phone with only account computers has no server to be on at launch
  // (a bridge is never saved): it opens the last one all the same.
  if (!status?.external) return 'skipped'
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

/** The page's own server origin, when it has one yet (not the default `/api`). */
function pageOrigin(): string | null {
  const base = apiBaseUrl()
  return base.startsWith('http') ? normalizeServerBaseUrl(base) : null
}

/**
 * After the shell answered a `resumed` poke: follow a bridge the shell had
 * to move to another port, else check health now instead of waiting for the
 * next failure to be noticed.
 */
async function followShell(): Promise<void> {
  const status = await getAppBackendStatus().catch(() => null)
  const here = pageOrigin()
  if (status?.base_url && status.external && here && normalizeServerBaseUrl(status.base_url) !== here) {
    reloadForBackendSwitch()
    return
  }
  void queryClient.invalidateQueries({ queryKey: queryKeys.health() })
}

const HEALTH_HASH = JSON.stringify(queryKeys.health())

/**
 * Pokes `user_retry` when health fails on an account computer while the
 * page is visible, then checks again; once per failure, until health answers.
 */
function watchHealthFailures(): () => void {
  let poked = false
  return queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated' || JSON.stringify(event.query.queryKey) !== HEALTH_HASH) return
    if (event.action.type === 'success') {
      poked = false
      return
    }
    if (event.action.type !== 'error' || poked || document.visibilityState !== 'visible') return
    poked = true
    void (async () => {
      const status = await getAppBackendStatus().catch(() => null)
      if (!status?.account_device) {
        poked = false
        return
      }
      await cloudPokeAndWait('user_retry')
      void queryClient.invalidateQueries({ queryKey: queryKeys.health() })
    })()
  })
}

/**
 * Phone only: tell the shell when the app comes back, goes away, or the
 * network changes (`cloud_poke`). Each link then checks its session and,
 * on the relay, tries the direct route again. Returns the stop.
 */
export function startAccountRouteWatch(): () => void {
  if (!isPhoneCloudShell()) return () => {}
  let stopped = false
  const resumed = async () => {
    await cloudPokeAndWait('resumed')
    if (!stopped) await followShell()
  }
  const onVisibility = () => {
    if (document.visibilityState === 'visible') void resumed()
    else if (!pageUnloading()) cloudPoke('background')
  }
  const onPageHide = () => markPageUnloading()
  const onPageShow = (event: PageTransitionEvent) => {
    if (event.persisted) resetPageUnloading()
  }
  const onOnline = () => cloudPoke('network_changed')
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('pagehide', onPageHide)
  window.addEventListener('pageshow', onPageShow)
  window.addEventListener('online', onOnline)
  const unwatchHealth = watchHealthFailures()
  if (document.visibilityState === 'visible') void resumed()
  return () => {
    stopped = true
    unwatchHealth()
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('pagehide', onPageHide)
    window.removeEventListener('pageshow', onPageShow)
    window.removeEventListener('online', onOnline)
  }
}

/**
 * Desktop: tell the built-in server's links to the account's computers when
 * a window comes back or the network changes (`cloud_poke`), so a link
 * that died meanwhile reconnects now. Never "background": the notch keeps
 * showing those computers' sessions. Returns the stop.
 */
export function startDesktopLinkPokes(): () => void {
  const onVisibility = () => {
    if (document.visibilityState === 'visible') cloudPoke('resumed')
  }
  const onOnline = () => cloudPoke('network_changed')
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('online', onOnline)
  return () => {
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('online', onOnline)
  }
}
