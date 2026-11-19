/**
 * Open a session on the server it belongs to: a tapped notification or a
 * link may name a computer other than the one the app is on.
 *
 * - The same server: open it at once.
 * - An account computer (`deviceId`): open that computer through its link
 *   (directly at home, through the account away), as a tap on its row under
 *   "Your computers" does. Its address never enters into it.
 * - A saved server (`baseUrl`): switch to it, as choosing it in Servers does.
 *   A saved server and an account computer are two different things, even
 *   on one machine: neither stands in for the other.
 *
 * A switch reloads the page; the session to open waits in sessionStorage and
 * is opened by the root route once the new server is up. A failure says why
 * and shows the Servers screen, where the person can retry.
 *
 * A tap can also launch the app, before it is on any server: the computer
 * the tap names is opened then, not the one the app was last on (the launch
 * check in `account-route.ts` gives way to it).
 */
import { accountComputerTitle, getAppBackendStatus, type AppBackendStatus } from '@/lib/app-backend'
import type { NotificationTarget } from '@/lib/notification-taps'
import { holdSessionOpen, requestSessionOpen } from '@/lib/pending-session-open'

export type OpenOutcome = 'opened' | 'switching' | 'failed'

function normalize(url: string): string {
  return url.trim().replace(/\/+$/, '').replace(/\/api$/i, '')
}

async function fail(error: string): Promise<OpenOutcome> {
  const [{ useToastStore }, { openServersScreen }] = await Promise.all([
    import('@/stores/useToastStore'),
    import('@/stores/useServersScreenStore'),
  ])
  useToastStore.getState().push({ tone: 'error', title: "Couldn't open that session", description: error })
  openServersScreen()
  return 'failed'
}

/**
 * A link named its server by a token this app no longer knows (a home-screen
 * widget synced before the server was forgotten). The session id means
 * nothing on another server, so nothing is opened: say so and show Servers.
 */
export function sessionServerUnknown(): Promise<OpenOutcome> {
  return fail('This app no longer knows which computer that session is on. Choose the computer, then open the session from its list.')
}

async function afterSwitch(
  sessionId: string,
  result: { ok: true; reload: boolean } | { ok: false; error: string; cancelled?: undefined } | { ok: false; cancelled: true },
): Promise<OpenOutcome> {
  // Back on the switching screen: the person stays where they were, no error.
  if (!result.ok) return result.cancelled ? 'failed' : fail(result.error)
  if (!result.reload) {
    requestSessionOpen(sessionId)
    return 'opened'
  }
  const { reloadForBackendSwitch } = await import('@/lib/backend-switch')
  // The reloaded page opens it; this one is leaving. Kept and reloaded in
  // one step, so nothing on this page runs in between and takes it.
  holdSessionOpen(sessionId)
  reloadForBackendSwitch()
  return 'switching'
}

async function openOnDevice(target: NotificationTarget & { deviceId: string }, status: AppBackendStatus, current: string): Promise<OpenOutcome> {
  if (status.account_device?.device_id === target.deviceId) {
    requestSessionOpen(target.sessionId)
    return 'opened'
  }
  const { getPhoneCloudDevices, phoneAccountConnected } = await import('@/api/phone-cloud')
  // A tap that launched the app comes before the shell has restored the
  // account, and no computer opens until then: the shell answers this once
  // it has. Signed out, it says so.
  await phoneAccountConnected()
  const devices = await getPhoneCloudDevices().catch(() => [])
  const device = devices.find((d) => d.device_id === target.deviceId)
  const { connectAccountComputer } = await import('@/lib/backend-switch')
  const result = await connectAccountComputer({
    deviceId: target.deviceId,
    label: device ? accountComputerTitle(device, status.computer_names) : 'your computer',
    currentBaseUrl: current,
  })
  return afterSwitch(target.sessionId, result)
}

async function openOnServer(target: NotificationTarget & { baseUrl: string }, status: AppBackendStatus, current: string): Promise<OpenOutcome> {
  const baseUrl = normalize(target.baseUrl)
  if (baseUrl === current) {
    requestSessionOpen(target.sessionId)
    return 'opened'
  }
  const saved = status.servers.find((server) => normalize(server.base_url) === baseUrl)
  if (!saved) return fail('That computer is no longer in your list.')
  const { connectExternalBackend } = await import('@/lib/backend-switch')
  const result = await connectExternalBackend({ baseUrl, name: saved.name ?? '', persist: true, currentBaseUrl: current })
  return afterSwitch(target.sessionId, result)
}

let opening: Promise<OpenOutcome> | null = null
/** Opens under way whose target names a server: each may switch to it. */
let choosingServer = 0

/**
 * Whether a tap or link is on its way to a server it names. The launch check
 * (`account-route.ts`) then leaves the choice of server to it, and waits for
 * it before reloading the page: the tap was already read from the shell's
 * queue and a reload under it would lose it.
 */
export function sessionServerOpenInFlight(): boolean {
  return choosingServer > 0
}

/** Resolves once no open is under way: each has opened, started its reload, or failed. */
export async function sessionOpensSettled(): Promise<void> {
  while (opening) await opening.catch(() => undefined)
}

/**
 * Open `target.sessionId` on its server, switching first when needed. One
 * at a time: a tap while a switch is under way waits for it to finish.
 */
export function openSessionOnServer(target: NotificationTarget): Promise<OpenOutcome> {
  const run = async (): Promise<OpenOutcome> => {
    const status = await getAppBackendStatus().catch(() => null)
    if (!status || (!target.deviceId && !target.baseUrl)) {
      requestSessionOpen(target.sessionId)
      return 'opened'
    }
    // Empty when the app is on no server yet (a tap that launched it).
    const current = normalize(status.base_url)
    if (target.deviceId) return openOnDevice({ ...target, deviceId: target.deviceId }, status, current)
    return openOnServer({ ...target, baseUrl: target.baseUrl! }, status, current)
  }
  const next = (opening ?? Promise.resolve<OpenOutcome>('opened')).catch(() => 'failed' as const).then(run)
  opening = next
  const namesServer = Boolean(target.deviceId || target.baseUrl)
  if (namesServer) choosingServer += 1
  void next.finally(() => {
    if (namesServer) choosingServer -= 1
    if (opening === next) opening = null
  })
  return next
}
