import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

let isTauri = true
let focused = false
let visible = true
let minimized = false
let permissionGranted = true
let permissionResult: 'granted' | 'denied' = 'granted'
let os = 'macos'
let shellResult: boolean | undefined = undefined
const mockRequestPermission = mock(async () => permissionResult)
const mockNotify = mock(async () => shellResult)
/** What the phone's own `cloud_status` command answers; an Error rejects. */
let phoneCloud: unknown = { state: 'guest', notice: null, supported: true }
const mockInvoke = mock(async (...args: unknown[]) => {
  if (args[0] === 'cloud_status') {
    if (phoneCloud instanceof Error) throw phoneCloud
    return phoneCloud
  }
  if (args[0] === 'app_backend_status') return backendStatus
  if (args[0] === 'cloud_push_register') return { status: 'authorized', registration: pushRegistration }
  return (mockNotify as unknown as (...args: unknown[]) => Promise<unknown>)(...args)
})
/** What the phone shell's `app_backend_status` answers (the server in use). */
let backendStatus: unknown = null
/** The APNs registration `cloud_push_register` answers; null: notifications not allowed. */
let pushRegistration: unknown = { provider: 'apns', token: 't', environment: 'production' }
const mockPlay = mock(async () => undefined)
type TapEvent = { actionId?: unknown; notification?: { id?: unknown } }
let actionListener: ((event: TapEvent) => void) | null = null

mock.module('@/hooks/use-platform', () => ({
  getPlatform: () => ({ isTauri, os, isMacOverlay: isTauri && os === 'macos' }),
}))

mock.module('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    isFocused: async () => focused,
    isVisible: async () => visible,
    isMinimized: async () => minimized,
  }),
}))

mock.module('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: async () => permissionGranted,
  requestPermission: mockRequestPermission,
  onAction: async (cb: (event: TapEvent) => void) => {
    actionListener = cb
    return { unregister: async () => { actionListener = null } }
  },
}))

mock.module('@tauri-apps/api/core', () => ({
  invoke: mockInvoke,
}))

import { listenForNotificationTaps, sendDesktopNotification } from '../../lib/desktop-notifications'
import { phoneCloudPushRegister, resetPhonePushRegistration } from '../../api/phone-cloud'

const payload = {
  kind: 'assistant_done' as const,
  sessionId: 'session-123',
  mode: 'coding' as const,
  title: 'Done · openagentd',
  body: 'Fix notification wording',
}

beforeEach(() => {
  window.localStorage.clear()
  isTauri = true
  focused = false
  visible = true
  minimized = false
  permissionGranted = true
  permissionResult = 'granted'
  os = 'macos'
  shellResult = undefined
  actionListener = null
  phoneCloud = { state: 'guest', notice: null, supported: true }
  backendStatus = null
  pushRegistration = { provider: 'apns', token: 't', environment: 'production' }
  resetPhonePushRegistration()
  setVisibility('visible')
  mockRequestPermission.mockClear()
  mockNotify.mockClear()
  mockInvoke.mockClear()
  mockPlay.mockClear()
  globalThis.Audio = mock(() => ({ play: mockPlay })) as unknown as typeof Audio
})

afterEach(() => {
  Date.now = realNow
})

const realNow = Date.now
/** Bun has no fake clock; the module reads `Date.now()`. */
function setNow(iso: string) {
  const at = Date.parse(iso)
  Date.now = () => at
}

/** Sets the page visibility; `dispatch` also fires `visibilitychange`, as iOS does. */
function setVisibility(state: 'visible' | 'hidden', dispatch = false) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  if (dispatch) document.dispatchEvent(new Event('visibilitychange'))
}

const ACCOUNT_PUSH = { state: 'connected', fingerprint: 'AB12 CD34', signer: true }

/** Signed in as a signer, and this launch registered for push. */
async function withAccountPush() {
  phoneCloud = ACCOUNT_PUSH
  expect(await phoneCloudPushRegister(ACCOUNT_PUSH.fingerprint)).toBe(true)
}

describe('desktop notification worker', () => {
  it('unfocused native send', async () => {
    const result = await sendDesktopNotification(payload)

    expect(result.status).toBe('sent')
    expect(mockNotify).toHaveBeenCalledWith('show_desktop_notification', {
      payload: {
        kind: 'assistant_done',
        sessionId: 'session-123',
        title: 'Done · openagentd',
        body: 'Fix notification wording',
      },
    })
    expect(mockPlay).not.toHaveBeenCalled()
  })

  it('passes the notification id so the shell shows it from one window', async () => {
    shellResult = true
    expect((await sendDesktopNotification({ ...payload, notificationId: 'n-1' })).status).toBe('sent')
    expect(mockNotify).toHaveBeenCalledWith('show_desktop_notification', {
      payload: expect.objectContaining({ notificationId: 'n-1' }),
    })

    // Another window already showed it, or the user is in another app window.
    shellResult = false
    expect((await sendDesktopNotification({ ...payload, notificationId: 'n-1' })).status).toBe('disabled')
  })

  it('focused skip and forced send', async () => {
    focused = true

    expect((await sendDesktopNotification(payload)).status).toBe('disabled')
    expect(mockNotify).not.toHaveBeenCalled()
    expect(mockPlay).not.toHaveBeenCalled()

    expect((await sendDesktopNotification(payload, { force: true })).status).toBe('sent')
    expect(mockNotify).toHaveBeenCalledTimes(1)
    expect(mockPlay).not.toHaveBeenCalled()
  })

  it('mobile plugin send without desktop focus skip or in-app sound', async () => {
    os = 'ios'
    focused = true

    const result = await sendDesktopNotification(payload)

    // The mobile shell has no show_desktop_notification command; it sends
    // through the notification plugin itself.
    expect(result.status).toBe('sent')
    expect(mockNotify).toHaveBeenCalledWith('plugin:notification|notify', {
      options: {
        id: expect.any(Number),
        title: 'Done · openagentd',
        body: 'Fix notification wording',
        group: 'openagentd-assistant_done',
      },
    })
    expect(mockPlay).not.toHaveBeenCalled()
  })

  it('mobile on-screen skip only while the page is visible', async () => {
    os = 'ios'

    // Watching the session that finished: the banner would repeat the screen.
    expect((await sendDesktopNotification(payload, { sessionOnScreen: true })).status).toBe('disabled')
    expect(mockNotify).not.toHaveBeenCalled()

    // Another session, or the app just went to the background: notify.
    expect((await sendDesktopNotification(payload, { sessionOnScreen: false })).status).toBe('sent')
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    expect((await sendDesktopNotification(payload, { sessionOnScreen: true })).status).toBe('sent')
    expect(mockNotify).toHaveBeenCalledTimes(2)
  })

  it('an Android tap opens the notified session, on the server it came from', async () => {
    os = 'android'
    backendStatus = { base_url: 'http://192.168.1.20:4082/', external: true, sidecar_running: false, supports_bundled: false, servers: [] }
    const opened: unknown[] = []
    const stop = await listenForNotificationTaps((target) => opened.push(target))

    await sendDesktopNotification(payload)
    const sent = mockNotify.mock.calls.find((call) => (call as unknown[])[0] === 'plugin:notification|notify')
    const [, args] = sent as unknown as [string, { options: { id: number } }]
    const id = args.options.id

    actionListener?.({ actionId: 'dismiss', notification: { id } })
    actionListener?.({ actionId: 'tap', notification: { id: id + 1 } })
    actionListener?.({ actionId: 'tap', notification: { id } })
    expect(opened).toEqual([{ sessionId: 'session-123', baseUrl: 'http://192.168.1.20:4082' }])

    stop()
    expect(actionListener).toBeNull()
  })

  it('remembers what a notification opens across a reload, with the account computer it was on', async () => {
    os = 'ios'
    backendStatus = { base_url: 'http://127.0.0.1:5999', external: true, sidecar_running: false, supports_bundled: false, servers: [], account_device: { device_id: 'dev-mac', fingerprint: '3F9A', kind: 'macos' } }
    await sendDesktopNotification(payload)
    const sent = mockNotify.mock.calls.find((call) => (call as unknown[])[0] === 'plugin:notification|notify')
    const id = (sent as unknown as [string, { options: { id: number } }])[1].options.id

    // Read back from storage, as a fresh page would.
    const { notificationTarget } = await import('../../lib/notification-taps')
    expect(notificationTarget(id)).toEqual({ sessionId: 'session-123', baseUrl: 'http://127.0.0.1:5999', deviceId: 'dev-mac' })
  })

  it('listens to the plugin only on Android (iOS and desktop taps come from the shell)', async () => {
    for (const platform of ['macos', 'ios']) {
      os = platform
      const stop = await listenForNotificationTaps(() => {})
      expect(actionListener).toBeNull()
      stop()
    }
  })

  describe('iPhone with account push', () => {
    it('leaves Done and Needs you to the push while the app is hidden', async () => {
      os = 'ios'
      await withAccountPush()
      setVisibility('hidden', true)

      expect((await sendDesktopNotification(payload)).status).toBe('disabled')
      const question = { ...payload, kind: 'input_needed' as const, title: 'Needs you · openagentd' }
      expect((await sendDesktopNotification(question, { force: true })).status).toBe('disabled')
      expect(mockNotify).not.toHaveBeenCalled()
    })

    it('skips events handled just after the app comes back, which the push already showed', async () => {
      os = 'ios'
      await withAccountPush()
      setNow('2020-01-01T00:00:00Z')
      setVisibility('hidden', true)
      setVisibility('visible', true)

      setNow('2020-01-01T00:00:02Z')
      expect((await sendDesktopNotification(payload)).status).toBe('disabled')
      expect(mockNotify).not.toHaveBeenCalled()

      setNow('2020-01-01T00:00:04Z')
      expect((await sendDesktopNotification(payload)).status).toBe('sent')
      expect(mockNotify).toHaveBeenCalledTimes(1)
    })

    it('still notifies from the open app, where iOS hides the push', async () => {
      os = 'ios'
      await withAccountPush()

      expect((await sendDesktopNotification(payload, { sessionOnScreen: false })).status).toBe('sent')
      const question = { ...payload, kind: 'input_needed' as const, title: 'Needs you · openagentd' }
      expect((await sendDesktopNotification(question, { force: true })).status).toBe('sent')
      expect(mockNotify).toHaveBeenCalledTimes(2)
    })

    it('keeps kinds the computer does not push', async () => {
      os = 'ios'
      await withAccountPush()
      setVisibility('hidden', true)

      expect((await sendDesktopNotification({ ...payload, kind: 'reminder_fired' })).status).toBe('sent')
      expect(mockNotify).toHaveBeenCalledTimes(1)
    })

    it('skips its own only when push really reaches this phone', async () => {
      os = 'ios'
      setVisibility('hidden', true)
      // Signed in as a signer, but notifications not allowed: no token.
      phoneCloud = ACCOUNT_PUSH
      pushRegistration = null
      expect(await phoneCloudPushRegister(ACCOUNT_PUSH.fingerprint)).toBe(false)
      expect((await sendDesktopNotification(payload)).status).toBe('sent')

      pushRegistration = { provider: 'apns', token: 't', environment: 'production' }
      await withAccountPush()
      expect((await sendDesktopNotification(payload)).status).toBe('disabled')
    })

    it('leaves a replayed Done or question to the push even while the app is open', async () => {
      os = 'ios'
      await withAccountPush()
      expect((await sendDesktopNotification(payload, { replayed: true })).status).toBe('disabled')
      const question = { ...payload, kind: 'input_needed' as const, title: 'Needs you · openagentd' }
      expect((await sendDesktopNotification(question, { force: true, replayed: true })).status).toBe('disabled')
      // Without push it still shows.
      resetPhonePushRegistration()
      expect((await sendDesktopNotification(question, { force: true, replayed: true })).status).toBe('sent')
    })
  })

  it('a hidden phone app without account push still notifies', async () => {
    setVisibility('hidden', true)
    for (const [platform, account] of [
      ['ios', { state: 'guest', notice: null, supported: true }],
      ['ios', { state: 'connected', fingerprint: 'AB12 CD34', signer: false }],
      ['ios', new Error('cloud_status unavailable')],
      ['android', ACCOUNT_PUSH],
    ] as const) {
      os = platform
      phoneCloud = account
      expect((await sendDesktopNotification(payload)).status).toBe('sent')
    }
    expect(mockNotify).toHaveBeenCalledTimes(4)
  })

  it('unsupported runtime', async () => {
    isTauri = false

    const result = await sendDesktopNotification(payload)

    expect(result.status).toBe('unsupported')
    expect(mockNotify).not.toHaveBeenCalled()
  })

  it('permission denied', async () => {
    permissionGranted = false
    permissionResult = 'denied'

    const first = await sendDesktopNotification(payload, { force: true })
    const second = await sendDesktopNotification(payload, { force: true })

    expect(first.status).toBe('permission-denied')
    expect(second.status).toBe('permission-denied')
    expect(mockRequestPermission).toHaveBeenCalledTimes(1)
    expect(mockNotify).not.toHaveBeenCalled()
  })
})
