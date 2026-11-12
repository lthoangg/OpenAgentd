/**
 * A tapped notification opens its session on the server it came from:
 * at once on the server in use, after a switch (and reload) otherwise.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

const realAppBackend = await import('@/lib/app-backend')
let status: unknown = null
mock.module('@/lib/app-backend', () => ({ ...realAppBackend, getAppBackendStatus: async () => status }))

let devices: unknown[] = []
mock.module('@/api/phone-cloud', () => ({ getPhoneCloudDevices: async () => devices }))

type Switch = { ok: true; reload: boolean } | { ok: false; error: string }
let switchResult: Switch = { ok: true, reload: true }
const connectAccountComputer = mock(async (..._args: unknown[]) => switchResult)
const connectExternalBackend = mock(async (..._args: unknown[]) => switchResult)
const reloadForBackendSwitch = mock(() => {})
mock.module('@/lib/backend-switch', () => ({ connectAccountComputer, connectExternalBackend, reloadForBackendSwitch }))

const { openSessionOnServer } = await import('@/lib/open-on-server')
const { takePendingSessionOpen, PENDING_OPEN_EVENT } = await import('@/lib/pending-session-open')
const { useToastStore } = await import('@/stores/useToastStore')
const { useServersScreenStore } = await import('@/stores/useServersScreenStore')

const BRIDGE = 'http://127.0.0.1:5999'
const LAN_A = 'http://192.168.1.20:4082'
const LAN_B = 'http://192.168.1.30:4082'
const MAC = { device_id: 'dev-mac', fingerprint: '3F9A 21C4', signer: false, me: false, kind: 'macos', server: true }
const LINUX = { device_id: 'dev-linux', fingerprint: '9C02 E1B7', signer: false, me: false, kind: 'linux', server: true }

function onServer(baseUrl: string, extra: Record<string, unknown> = {}) {
  return {
    base_url: baseUrl, external: true, sidecar_running: false, supports_bundled: false,
    servers: [{ base_url: LAN_A, name: 'Studio Mac' }, { base_url: LAN_B, name: 'Linux box' }],
    ...extra,
  }
}

let opened = 0
const countOpen = () => { opened += 1 }

beforeEach(() => {
  window.localStorage.clear()
  window.sessionStorage.clear()
  status = onServer(LAN_A)
  devices = [MAC, LINUX]
  switchResult = { ok: true, reload: true }
  connectAccountComputer.mockClear()
  connectExternalBackend.mockClear()
  reloadForBackendSwitch.mockClear()
  useToastStore.setState({ toasts: [] })
  opened = 0
  window.addEventListener(PENDING_OPEN_EVENT, countOpen)
})

afterEach(() => {
  window.removeEventListener(PENDING_OPEN_EVENT, countOpen)
})

describe('openSessionOnServer', () => {
  it('opens at once on the server in use', async () => {
    expect(await openSessionOnServer({ sessionId: 's1', baseUrl: `${LAN_A}/` })).toBe('opened')
    expect(takePendingSessionOpen()).toBe('s1')
    expect(opened).toBe(1)
    expect(connectExternalBackend).not.toHaveBeenCalled()
  })

  it('opens at once when the notification names no server', async () => {
    expect(await openSessionOnServer({ sessionId: 's1' })).toBe('opened')
    expect(takePendingSessionOpen()).toBe('s1')
  })

  it('opens at once on the account computer the app is on', async () => {
    status = onServer(BRIDGE, { account_device: { device_id: 'dev-mac', fingerprint: '3F9A 21C4', kind: 'macos' } })
    expect(await openSessionOnServer({ sessionId: 's1', deviceId: 'dev-mac' })).toBe('opened')
    expect(connectAccountComputer).not.toHaveBeenCalled()
  })

  it('keeps a saved server and an account computer apart, even on one machine', async () => {
    // On the Mac's saved address, a push from the Mac (the account
    // computer) opens it through its link, not over the saved server.
    status = onServer(LAN_A)
    expect(await openSessionOnServer({ sessionId: 's2', deviceId: 'dev-mac' })).toBe('switching')
    expect(connectAccountComputer.mock.calls[0][0]).toEqual({ deviceId: 'dev-mac', label: 'macOS · 3F9A 21C4', currentBaseUrl: LAN_A })
    // On the Mac's bridge, a notification raised on the saved server
    // switches to that saved server.
    status = onServer(BRIDGE, { account_device: { device_id: 'dev-mac', fingerprint: '3F9A 21C4', kind: 'macos' } })
    expect(await openSessionOnServer({ sessionId: 's3', baseUrl: LAN_A })).toBe('switching')
    expect(connectExternalBackend.mock.calls[0][0]).toMatchObject({ baseUrl: LAN_A })
  })

  it('switches to the computer a push came from, then opens the session after the reload', async () => {
    expect(await openSessionOnServer({ sessionId: 's-linux', deviceId: 'dev-linux' })).toBe('switching')
    expect(connectAccountComputer).toHaveBeenCalledTimes(1)
    expect(connectAccountComputer.mock.calls[0][0]).toEqual({ deviceId: 'dev-linux', label: 'Linux · 9C02 E1B7', currentBaseUrl: LAN_A })
    expect(reloadForBackendSwitch).toHaveBeenCalledTimes(1)
    // What the reloaded page reads.
    expect(takePendingSessionOpen()).toBe('s-linux')
  })

  it('switches to the saved server an app notification was raised on', async () => {
    expect(await openSessionOnServer({ sessionId: 's1', baseUrl: LAN_B })).toBe('switching')
    expect(connectExternalBackend.mock.calls[0][0]).toMatchObject({ baseUrl: LAN_B, name: 'Linux box', persist: true, currentBaseUrl: LAN_A })
    expect(takePendingSessionOpen()).toBe('s1')
  })

  it('opens without a reload when the switch lands on the same origin', async () => {
    switchResult = { ok: true, reload: false }
    expect(await openSessionOnServer({ sessionId: 's1', deviceId: 'dev-linux' })).toBe('opened')
    expect(reloadForBackendSwitch).not.toHaveBeenCalled()
    expect(opened).toBe(1)
  })

  it('says why and shows Servers when the computer cannot be reached', async () => {
    switchResult = { ok: false, error: 'This computer is offline, or not signed in to your account.' }
    const before = useServersScreenStore.getState().request
    expect(await openSessionOnServer({ sessionId: 's1', deviceId: 'dev-linux' })).toBe('failed')
    expect(useToastStore.getState().toasts[0]).toMatchObject({ tone: 'error', description: 'This computer is offline, or not signed in to your account.' })
    expect(useServersScreenStore.getState().request).toBe(before + 1)
    expect(takePendingSessionOpen()).toBeNull()
  })

  it('does not switch to a server that is no longer saved', async () => {
    expect(await openSessionOnServer({ sessionId: 's1', baseUrl: 'http://10.0.0.9:4082' })).toBe('failed')
    expect(connectExternalBackend).not.toHaveBeenCalled()
  })

  it('runs one tap at a time', async () => {
    const first = openSessionOnServer({ sessionId: 's1', deviceId: 'dev-linux' })
    const second = openSessionOnServer({ sessionId: 's2', baseUrl: LAN_A })
    await Promise.all([first, second])
    // The second ran after the first switch finished.
    expect(connectAccountComputer).toHaveBeenCalledTimes(1)
  })
})

describe('takePendingSessionOpen', () => {
  it('opens a session once, and not after the switch took too long', async () => {
    const { requestSessionOpen } = await import('@/lib/pending-session-open')
    requestSessionOpen('s1')
    expect(takePendingSessionOpen()).toBe('s1')
    expect(takePendingSessionOpen()).toBeNull()
    requestSessionOpen('s2')
    expect(takePendingSessionOpen(Date.now() + 121_000)).toBeNull()
  })
})
