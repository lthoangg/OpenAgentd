import { beforeEach, describe, expect, it, mock } from 'bun:test'

let isTauri = true
let focused = false
let visible = true
let minimized = false
let permissionGranted = true
let permissionResult: 'granted' | 'denied' = 'granted'
let os = 'macos'
const mockRequestPermission = mock(async () => permissionResult)
const mockNotify = mock(async () => undefined)
const mockPlay = mock(async () => undefined)

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
}))

mock.module('@tauri-apps/api/core', () => ({
  invoke: mockNotify,
}))

import { sendDesktopNotification } from '../../lib/desktop-notifications'

const payload = {
  kind: 'assistant_done' as const,
  sessionId: 'session-123',
  mode: 'coding' as const,
  title: 'Session completed - openagentd',
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
  mockRequestPermission.mockClear()
  mockNotify.mockClear()
  mockPlay.mockClear()
  globalThis.Audio = mock(() => ({ play: mockPlay })) as unknown as typeof Audio
})

describe('desktop notification worker', () => {
  it('unfocused native send', async () => {
    const result = await sendDesktopNotification(payload)

    expect(result.status).toBe('sent')
    expect(mockNotify).toHaveBeenCalledWith('show_desktop_notification', {
      payload: {
        kind: 'assistant_done',
        sessionId: 'session-123',
        title: 'Session completed - openagentd',
        body: 'Fix notification wording',
      },
    })
    expect(mockPlay).not.toHaveBeenCalled()
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

  it('sends on mobile native app without desktop focus skip or in-app sound', async () => {
    os = 'ios'
    focused = true

    const result = await sendDesktopNotification(payload)

    expect(result.status).toBe('sent')
    expect(mockNotify).toHaveBeenCalledTimes(1)
    expect(mockPlay).not.toHaveBeenCalled()
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
