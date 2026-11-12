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
 * is opened by `usePendingSessionOpen` once the new server is up. A failure
 * says why and shows the Servers screen, where the person can retry.
 */
import { accountComputerTitle, getAppBackendStatus, type AppBackendStatus } from '@/lib/app-backend'
import type { NotificationTarget } from '@/lib/notification-taps'
import { requestSessionOpen } from '@/lib/pending-session-open'

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

async function afterSwitch(sessionId: string, result: { ok: true; reload: boolean } | { ok: false; error: string }): Promise<OpenOutcome> {
  if (!result.ok) return fail(result.error)
  requestSessionOpen(sessionId)
  if (!result.reload) return 'opened'
  const { reloadForBackendSwitch } = await import('@/lib/backend-switch')
  reloadForBackendSwitch()
  return 'switching'
}

async function openOnDevice(target: NotificationTarget & { deviceId: string }, status: AppBackendStatus, current: string): Promise<OpenOutcome> {
  if (status.account_device?.device_id === target.deviceId) {
    requestSessionOpen(target.sessionId)
    return 'opened'
  }
  const { getPhoneCloudDevices } = await import('@/api/phone-cloud')
  const devices = await getPhoneCloudDevices().catch(() => [])
  const device = devices.find((d) => d.device_id === target.deviceId)
  const { connectAccountComputer } = await import('@/lib/backend-switch')
  const result = await connectAccountComputer({
    deviceId: target.deviceId,
    label: device ? accountComputerTitle(device) : 'your computer',
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
  if (!saved) return fail('That server is no longer in your list.')
  const { connectExternalBackend } = await import('@/lib/backend-switch')
  const result = await connectExternalBackend({ baseUrl, name: saved.name ?? '', persist: true, currentBaseUrl: current })
  return afterSwitch(target.sessionId, result)
}

let opening: Promise<OpenOutcome> | null = null

/**
 * Open `target.sessionId` on its server, switching first when needed. One
 * at a time: a tap while a switch is under way waits for it to finish.
 */
export function openSessionOnServer(target: NotificationTarget): Promise<OpenOutcome> {
  const run = async (): Promise<OpenOutcome> => {
    const status = await getAppBackendStatus().catch(() => null)
    if (!status?.base_url || (!target.deviceId && !target.baseUrl)) {
      requestSessionOpen(target.sessionId)
      return 'opened'
    }
    const current = normalize(status.base_url)
    if (target.deviceId) return openOnDevice({ ...target, deviceId: target.deviceId }, status, current)
    return openOnServer({ ...target, baseUrl: target.baseUrl! }, status, current)
  }
  const next = (opening ?? Promise.resolve<OpenOutcome>('opened')).catch(() => 'failed' as const).then(run)
  opening = next
  void next.finally(() => { if (opening === next) opening = null })
  return next
}
