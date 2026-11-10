/**
 * At launch on the phone: the saved server the app opens is the LAN address
 * of a computer in the signed-in account, and it does not answer (its
 * "Allow devices on your network to connect" is off, or the phone is away
 * from home). Open that computer through the account instead, by itself,
 * once per launch. Nothing for servers that are not account computers;
 * after a failed attempt the Servers screen shows, and nothing retries.
 *
 * Loaded on demand by `App.tsx`, so it stays out of the startup bundle.
 */
import { getPhoneCloudDevices, getPhoneCloudStatus, isServer, type PhoneCloudStatus } from '@/api/phone-cloud'
import { accountComputerTitle, getAppBackendStatus, LAN_COMPUTERS_KEY, normalizeFingerprint } from '@/lib/app-backend'
import { connectAccountComputer, normalizeServerBaseUrl, reloadForBackendSwitch } from '@/lib/backend-switch'
import { pingServer } from '@/lib/server-probe'
import { openServersScreen } from '@/stores/useServersScreenStore'

/** How long to wait for the shell to restore a stored account at launch. */
const ACCOUNT_RESTORE_WAIT_MS = 3000
const ACCOUNT_RESTORE_POLL_MS = 250

export type FallbackOutcome = 'switched' | 'failed' | 'skipped'

let attempted = false

/** Test seam: a new launch. */
export function resetAccountLanFallback(): void {
  attempted = false
}

function lanFingerprintsFor(baseUrl: string): Set<string> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(LAN_COMPUTERS_KEY) ?? '{}')
    if (!parsed || typeof parsed !== 'object') return new Set()
    return new Set(Object.entries(parsed)
      .filter(([, url]) => typeof url === 'string' && normalizeServerBaseUrl(url) === baseUrl)
      .map(([fingerprint]) => normalizeFingerprint(fingerprint)))
  } catch {
    return new Set()
  }
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

/** One attempt per launch; later calls do nothing. */
export async function fallBackToAccountOnce(): Promise<FallbackOutcome> {
  if (attempted) return 'skipped'
  attempted = true
  const status = await getAppBackendStatus()
  if (!status?.base_url || !status.external || status.account_device) return 'skipped'
  const base = normalizeServerBaseUrl(status.base_url)
  const fingerprints = lanFingerprintsFor(base)
  if (fingerprints.size === 0) return 'skipped'
  if (await pingServer(base)) return 'skipped'
  if (!(await connectedAccount())) return 'skipped'
  const devices = await getPhoneCloudDevices().catch(() => [])
  const device = devices.find((d) => !d.me && isServer(d) && fingerprints.has(normalizeFingerprint(d.fingerprint)))
  if (!device) return 'skipped'
  const result = await connectAccountComputer({
    deviceId: device.device_id,
    // Its LAN address just failed: straight to the account.
    lanBaseUrl: null,
    label: accountComputerTitle(device, status.servers),
    currentBaseUrl: base,
  })
  if (!result.ok) {
    openServersScreen()
    return 'failed'
  }
  if (result.reload) reloadForBackendSwitch()
  return 'switched'
}
