/**
 * The phone answers notification taps from the shell's queue: at launch
 * (a tap that started the app), when the app comes back, and when the shell
 * says a tap arrived. A session tap opens on the computer it came from.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, waitFor } from '@testing-library/react'

const realPlatform = await import('@/hooks/use-platform')
const phone = { isTauri: true, os: 'ios', isMacOverlay: false, isFullscreen: false }
mock.module('@/hooks/use-platform', () => ({ ...realPlatform, getPlatform: () => phone, usePlatform: () => phone }))

let queued: unknown[] = []
mock.module('@tauri-apps/api/core', () => ({
  invoke: async (command: string) => {
    if (command === 'notification_take_taps') {
      const taps = queued
      queued = []
      return taps
    }
    if (command === 'cloud_status') return { state: 'guest', notice: null, supported: true }
    throw new Error(`unexpected command: ${command}`)
  },
}))

let tapped: (() => void) | null = null
mock.module('@tauri-apps/api/event', () => ({
  listen: async (event: string, cb: () => void) => {
    if (event === 'notification-tapped') tapped = cb
    return () => { if (event === 'notification-tapped') tapped = null }
  },
}))

const openSessionOnServer = mock(async (..._args: unknown[]) => 'opened' as const)
mock.module('@/lib/open-on-server', () => ({ openSessionOnServer }))

const { PhoneCloudSync } = await import('@/hooks/use-phone-cloud-sync')
const { rememberNotificationTarget } = await import('@/lib/notification-taps')
const { queryClient } = await import('@/lib/query-client')

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => {
  window.localStorage.clear()
  queued = []
  tapped = null
  openSessionOnServer.mockClear()
  setVisibility('visible')
})

afterEach(() => {
  cleanup()
  queryClient.clear()
})

describe('notification taps on the phone', () => {
  it('opens the session of a push that launched the app, on the computer that sent it', async () => {
    queued = [{ kind: 'session', session: 's-linux', sender: 'dev-linux' }]
    render(<PhoneCloudSync />)
    await waitFor(() => expect(openSessionOnServer).toHaveBeenCalledTimes(1))
    expect(openSessionOnServer.mock.calls[0][0]).toEqual({ sessionId: 's-linux', deviceId: 'dev-linux' })
  })

  it('opens an app notification tapped after a relaunch, from what it remembered', async () => {
    rememberNotificationTarget(42, { sessionId: 's-lan', baseUrl: 'http://192.168.1.30:4082' })
    queued = [{ kind: 'local', id: 42 }, { kind: 'local', id: 7 }]
    render(<PhoneCloudSync />)
    await waitFor(() => expect(openSessionOnServer).toHaveBeenCalledTimes(1))
    expect(openSessionOnServer.mock.calls[0][0]).toEqual({ sessionId: 's-lan', baseUrl: 'http://192.168.1.30:4082' })
  })

  it('answers a tap while the app runs, when the shell says one arrived or the app comes back', async () => {
    render(<PhoneCloudSync />)
    await waitFor(() => expect(tapped).not.toBeNull())
    expect(openSessionOnServer).not.toHaveBeenCalled()

    queued = [{ kind: 'session', session: 's1', sender: 'dev-mac' }]
    tapped?.()
    await waitFor(() => expect(openSessionOnServer).toHaveBeenCalledTimes(1))

    queued = [{ kind: 'session', session: 's2' }]
    setVisibility('hidden')
    setVisibility('visible')
    await waitFor(() => expect(openSessionOnServer).toHaveBeenCalledTimes(2))
    expect(openSessionOnServer.mock.calls[1][0]).toEqual({ sessionId: 's2' })
  })

  it('opens only the newest of several taps, and the same tap reported twice once', async () => {
    queued = [{ kind: 'session', session: 'old', sender: 'dev-mac' }, { kind: 'session', session: 'new', sender: 'dev-mac' }]
    render(<PhoneCloudSync />)
    await waitFor(() => expect(openSessionOnServer).toHaveBeenCalledTimes(1))
    expect(openSessionOnServer.mock.calls[0][0]).toEqual({ sessionId: 'new', deviceId: 'dev-mac' })

    queued = [{ kind: 'session', session: 'new', sender: 'dev-mac' }]
    tapped?.()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(openSessionOnServer).toHaveBeenCalledTimes(1)
  })
})
