/**
 * Which way the phone reaches an account computer: its saved home-network
 * (LAN) address, or the account's relay through the loopback bridge. The
 * shell opens a computer over whichever answers first; this module keeps
 * the choice right afterwards. Phone only, and loaded on demand by `App.tsx`
 * so it stays out of the startup bundle.
 *
 * - At launch: the computer last opened (`last_account_device`) is opened
 *   again, LAN or account as the shell finds it, unless the app is already on
 *   its bridge. A shell without that field keeps the older rule: a saved LAN
 *   address of an account computer that does not answer opens through the
 *   account.
 * - On resume and on a network change, one re-check at a time:
 *   - on a LAN address of an account computer that fails two checks in a row
 *     (reachable, then key accepted; again 2 s later) → through the account;
 *   - on an account bridge whose computer has a saved LAN address that answers
 *     and accepts its key → back to the LAN, unless a reply is running or the
 *     composer holds text (a switch changes the page's origin, and the typed
 *     text and the running view would go). Then nothing switches and
 *     `useAccountRouteStore` says the home network is available, so the
 *     computer's row offers it.
 *   At most one switch per event.
 *
 * `startAccountRouteWatch` also tells the shell (`cloud_poke`) when the app
 * comes back, goes away, or the network changes.
 */
import { getStoredAccessKey } from '@/api/auth'
import {
  cloudPoke,
  getPhoneCloudDevices,
  getPhoneCloudStatus,
  isPhoneCloudShell,
  isServer,
  type DeviceRow,
  type PhoneCloudStatus,
} from '@/api/phone-cloud'
import { accountComputerTitle, getAppBackendStatus, LAN_COMPUTERS_KEY, normalizeFingerprint, type AppBackendStatus } from '@/lib/app-backend'
import { connectAccountComputer, normalizeServerBaseUrl, reloadForBackendSwitch } from '@/lib/backend-switch'
import { parseLanComputers } from '@/lib/computer-fingerprints'
import { checkServerAuth, pingServer } from '@/lib/server-probe'
import { useAgentStore } from '@/stores/useAgentStore'
import { setLanAvailable } from '@/stores/useAccountRouteStore'
import { openServersScreen } from '@/stores/useServersScreenStore'

/** How long to wait for the shell to restore a stored account at launch. */
const ACCOUNT_RESTORE_WAIT_MS = 3000
const ACCOUNT_RESTORE_POLL_MS = 250
/** The pause between the two checks that must both fail before leaving a LAN address. */
export const LAN_RECHECK_DELAY_MS = 2000
/** Where the composer keeps its unsent text (`useSessionBootstrap`). */
const COMPOSER_DRAFTS_KEY = 'oa.drafts.composer.v1'

export type RouteOutcome = 'switched' | 'failed' | 'offered' | 'skipped'
export type RouteEvent = 'resumed' | 'network_changed'

let launched = false
let busy = false

/** Test seam: a new launch. */
export function resetAccountRoute(): void {
  launched = false
  busy = false
}

/** One re-check (or launch check) at a time; one asked for meanwhile is dropped. */
async function exclusive(run: () => Promise<RouteOutcome>): Promise<RouteOutcome> {
  if (busy) return 'skipped'
  busy = true
  try {
    return await run()
  } catch {
    return 'skipped'
  } finally {
    busy = false
  }
}

function readLanComputers(): Record<string, string> {
  try {
    return parseLanComputers(window.localStorage.getItem(LAN_COMPUTERS_KEY) ?? '')
  } catch {
    return {}
  }
}

/** The fingerprints remembered for this address (an account computer's LAN address). */
function fingerprintsFor(baseUrl: string): Set<string> {
  return new Set(Object.entries(readLanComputers())
    .filter(([, url]) => normalizeServerBaseUrl(url) === baseUrl)
    .map(([fingerprint]) => normalizeFingerprint(fingerprint)))
}

/** The saved LAN server that is this computer, normalized; null when none is remembered and saved. */
function savedLanUrl(fingerprint: string, status: AppBackendStatus): string | null {
  const remembered = readLanComputers()[normalizeFingerprint(fingerprint)]
  if (!remembered) return null
  const url = normalizeServerBaseUrl(remembered)
  return status.servers.some((server) => normalizeServerBaseUrl(server.base_url) === url) ? url : null
}

/** The address answers and accepts the key stored for it. */
async function lanUsable(baseUrl: string): Promise<boolean> {
  if (!(await pingServer(baseUrl))) return false
  const key = (await getStoredAccessKey(baseUrl).catch(() => undefined)) ?? ''
  return checkServerAuth(baseUrl, key)
}

/** A reply is running or on its way (a message queued): the view of it would go with a reload. */
function replyRunning(): boolean {
  const state = useAgentStore.getState()
  return state.isAgentWorking || state._pendingMessages.length > 0
}

/**
 * Text typed and not sent. The composer keeps its draft per session in
 * `localStorage` (which is per origin, so a switch would leave it behind);
 * a box being typed in right now counts too.
 */
function composerHasText(): boolean {
  const focused = document.activeElement
  if ((focused instanceof HTMLTextAreaElement || focused instanceof HTMLInputElement) && focused.value.trim()) return true
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(COMPOSER_DRAFTS_KEY) ?? '[]')
    if (!Array.isArray(parsed)) return false
    return parsed.some((pair) => {
      const draft: unknown = Array.isArray(pair) ? pair[1] : null
      const value = (draft as { value?: unknown } | null)?.value
      return typeof value === 'string' && value.trim() !== ''
    })
  } catch {
    return false
  }
}

async function connectedAccount(wait: boolean): Promise<boolean> {
  const deadline = Date.now() + (wait ? ACCOUNT_RESTORE_WAIT_MS : 0)
  for (;;) {
    const status: PhoneCloudStatus | null = await getPhoneCloudStatus().catch(() => null)
    if (status?.state === 'connected') return true
    // Signing in, closing, … are not a stored account being restored.
    if (status && status.state !== 'guest') return false
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, ACCOUNT_RESTORE_POLL_MS))
  }
}

async function devices(): Promise<DeviceRow[]> {
  return (await getPhoneCloudDevices().catch(() => [])).filter((device) => !device.me && isServer(device))
}

/** Switch to a computer and reload when the origin changed; `failed` when it cannot be opened. */
async function openComputer(
  device: { device_id: string; kind: string | null; fingerprint: string },
  lanBaseUrl: string | null,
  status: AppBackendStatus,
  base: string,
): Promise<{ outcome: RouteOutcome; via: 'lan' | 'account' | null }> {
  const result = await connectAccountComputer({
    deviceId: device.device_id,
    lanBaseUrl,
    label: accountComputerTitle(device, status.servers),
    currentBaseUrl: base,
  })
  if (!result.ok) return { outcome: 'failed', via: null }
  if (result.reload) reloadForBackendSwitch()
  return { outcome: result.reload ? 'switched' : 'skipped', via: result.via }
}

async function runLaunch(): Promise<RouteOutcome> {
  const status = await getAppBackendStatus()
  if (!status?.base_url || !status.external) return 'skipped'
  const base = normalizeServerBaseUrl(status.base_url)
  const last = status.last_account_device
  if (last) {
    if (status.account_device?.device_id === last) return 'skipped'
    if (!(await connectedAccount(true))) return 'skipped'
    const device = (await devices()).find((d) => d.device_id === last)
    if (!device) return 'skipped'
    const lan = savedLanUrl(device.fingerprint, status)
    // Already on its home network, and it answers: nothing to switch.
    if (lan && lan === base && await lanUsable(lan)) return 'skipped'
    const opened = await openComputer(device, lan, status, base)
    if (opened.outcome === 'failed') openServersScreen()
    return opened.outcome
  }
  // A shell without `last_account_device`: a LAN address of an account
  // computer that does not answer opens through the account.
  if (status.account_device) return 'skipped'
  const fingerprints = fingerprintsFor(base)
  if (fingerprints.size === 0) return 'skipped'
  if (await pingServer(base)) return 'skipped'
  if (!(await connectedAccount(true))) return 'skipped'
  const device = (await devices()).find((d) => fingerprints.has(normalizeFingerprint(d.fingerprint)))
  if (!device) return 'skipped'
  // Its LAN address just failed: straight to the account.
  const opened = await openComputer(device, null, status, base)
  if (opened.outcome === 'failed') openServersScreen()
  return opened.outcome
}

/** At launch, once; later calls do nothing. `failed` shows the Servers screen (already opened here). */
export function checkRouteAtLaunch(): Promise<RouteOutcome> {
  if (launched) return Promise.resolve('skipped')
  launched = true
  return exclusive(runLaunch)
}

async function recheckOnLan(status: AppBackendStatus, base: string, delayMs: number): Promise<RouteOutcome> {
  const fingerprints = fingerprintsFor(base)
  if (fingerprints.size === 0) return 'skipped'
  if (await lanUsable(base)) return 'skipped'
  await new Promise((resolve) => setTimeout(resolve, delayMs))
  // The person may have switched meanwhile.
  const again = await getAppBackendStatus()
  if (!again?.base_url || again.account_device || normalizeServerBaseUrl(again.base_url) !== base) return 'skipped'
  if (await lanUsable(base)) return 'skipped'
  if (!(await connectedAccount(false))) return 'skipped'
  const device = (await devices()).find((d) => fingerprints.has(normalizeFingerprint(d.fingerprint)))
  if (!device) return 'skipped'
  return (await openComputer(device, null, status, base)).outcome
}

async function recheckOnBridge(status: AppBackendStatus, base: string): Promise<RouteOutcome> {
  const bridged = status.account_device
  if (!bridged) return 'skipped'
  const deviceId = bridged.device_id
  const lan = savedLanUrl(bridged.fingerprint, status)
  if (!lan) {
    setLanAvailable(deviceId, false)
    return 'skipped'
  }
  if (!(await lanUsable(lan))) {
    setLanAvailable(deviceId, false)
    return 'skipped'
  }
  // Decided after the checks: the person may have started typing meanwhile.
  if (replyRunning() || composerHasText()) {
    setLanAvailable(deviceId, true)
    return 'offered'
  }
  const opened = await openComputer(bridged, lan, status, base)
  if (opened.via === 'lan') setLanAvailable(deviceId, false)
  return opened.outcome
}

/**
 * Re-check the route after the app came back or the network changed. Moves
 * at most once, never overlaps another check, and does nothing while the app
 * is in the background.
 */
export function recheckAccountRoute(
  _event: RouteEvent,
  options: { recheckDelayMs?: number } = {},
): Promise<RouteOutcome> {
  return exclusive(async () => {
    if (document.visibilityState === 'hidden') return 'skipped'
    const status = await getAppBackendStatus()
    if (!status?.base_url || !status.external) return 'skipped'
    const base = normalizeServerBaseUrl(status.base_url)
    return status.account_device
      ? recheckOnBridge(status, base)
      : recheckOnLan(status, base, options.recheckDelayMs ?? LAN_RECHECK_DELAY_MS)
  })
}

/**
 * Phone only: tell the shell when the app comes back, goes away, or the
 * network changes (`cloud_poke`), and re-check the route when it comes back
 * or the network changes. Returns the stop.
 */
export function startAccountRouteWatch(): () => void {
  if (!isPhoneCloudShell()) return () => {}
  const onVisibility = () => {
    if (document.visibilityState === 'visible') {
      cloudPoke('resumed')
      void recheckAccountRoute('resumed')
    } else {
      cloudPoke('background')
    }
  }
  const onOnline = () => {
    cloudPoke('network_changed')
    void recheckAccountRoute('network_changed')
  }
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('online', onOnline)
  return () => {
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('online', onOnline)
  }
}
