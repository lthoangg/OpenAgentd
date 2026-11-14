/**
 * The phone's home-screen widgets are emptied when the app lets go of the
 * server whose sessions they show: its rows would open nothing.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test'

const realPlatform = await import('@/hooks/use-platform')
let os = 'ios'
mock.module('@/hooks/use-platform', () => ({ ...realPlatform, getPlatform: () => ({ isTauri: true, os, isMacOverlay: false, isFullscreen: false }) }))

const invoke = mock(async (..._args: unknown[]) => undefined as unknown)
mock.module('@tauri-apps/api/core', () => ({ invoke }))

const { removeAppBackendServer } = await import('@/lib/app-backend')
const { phoneCloudSignOut } = await import('@/api/phone-cloud')

const LAN = 'http://192.168.1.20:4082'
const pushes = () => invoke.mock.calls.filter((call) => call[0] === 'widget_update_snapshot').map((call) => (call[1] as { snapshot: unknown }).snapshot)

beforeEach(() => {
  os = 'ios'
  invoke.mockClear()
  localStorage.clear()
})

describe('letting go of the server the widgets show', () => {
  it('empties the widgets when that saved server is removed', async () => {
    localStorage.setItem('oa-widget-server', JSON.stringify({ baseUrl: LAN }))

    await removeAppBackendServer(LAN)

    expect(pushes()).toEqual([expect.objectContaining({ inbox: [], lastSession: null, nextTask: null })])
  })

  it('empties the widgets when the account whose computer they show signs out', async () => {
    localStorage.setItem('oa-widget-server', JSON.stringify({ baseUrl: 'http://127.0.0.1:5999', deviceId: 'dev-mac' }))

    await phoneCloudSignOut()

    expect(pushes()).toEqual([expect.objectContaining({ inbox: [], lastSession: null, nextTask: null })])
  })

  it('touches no widget on the desktop app, which has none', async () => {
    os = 'macos'
    localStorage.setItem('oa-widget-server', JSON.stringify({ baseUrl: LAN }))

    await removeAppBackendServer(LAN)

    expect(pushes()).toEqual([])
  })
})
