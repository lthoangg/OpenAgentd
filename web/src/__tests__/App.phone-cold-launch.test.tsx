/**
 * A phone that only uses its account's computers has no server to be on
 * when it launches: the launch check opens the computer last used, through
 * the shell. The app then starts on it on this same page. A reload there
 * loaded the bundle twice, forgot the session the person was in, and threw
 * away the approval sheet a tapped "A device wants to join" had opened.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { useEffect } from 'react'

const realPlatform = await import('@/hooks/use-platform')
const phone = { isTauri: true, os: 'ios', isMacOverlay: false, isFullscreen: false }
mock.module('@/hooks/use-platform', () => ({ ...realPlatform, getPlatform: () => phone, usePlatform: () => phone }))
mock.module('@/hooks/use-is-phone', () => ({ useIsPhone: () => true }))
mock.module('@/hooks/useConnectLink', () => ({ useConnectLink: () => ({ request: null, clear: () => {} }) }))
mock.module('@/components/AppBackendDialog', () => ({ AppBackendDialog: () => null }))
mock.module('@/components/phone/LazyServersScreen', () => ({ ServersScreen: () => <div data-testid="computers-screen" /> }))
mock.module('@/components/Preview/PreviewKeepAlive', () => ({ PreviewKeepAlive: () => null }))
mock.module('@/lib/connected-app-preload', () => ({ preloadConnectedApp: () => undefined }))
// The running app, in place of the router and its routes.
mock.module('@/router', () => ({ router: {} }))
const realRouter = await import('@tanstack/react-router')
mock.module('@tanstack/react-router', () => ({ ...realRouter, RouterProvider: () => <div data-testid="app-running" /> }))

let sheetMounts = 0
mock.module('@/components/phone/ApprovalSheet', () => ({
  ApprovalSheet: ({ row }: { row: { enrollment_id: string } }) => {
    useEffect(() => { sheetMounts += 1 }, [])
    return <div data-testid="approval-sheet">{row.enrollment_id}</div>
  },
}))
const realNotifications = await import('@/lib/desktop-notifications')
mock.module('@/lib/desktop-notifications', () => ({ ...realNotifications, listenForNotificationTaps: async () => () => {} }))

const BRIDGE = 'http://127.0.0.1:5999'
const MAC = { device_id: 'dev-mac', fingerprint: '3F9A 21C4', signer: true, me: false, kind: 'macos', server: true, client: true }
const ME = { device_id: 'dev-me', fingerprint: 'AA11 BB22', signer: true, me: true, kind: 'ios', server: false, client: true }
const noServer = { base_url: '', mode: 'external', sidecar_running: false, external: true, supports_bundled: false, servers: [] as { base_url: string; name: string }[], last_account_device: 'dev-mac' }
const onBridge = { ...noServer, base_url: BRIDGE, account_device: { device_id: 'dev-mac', fingerprint: '3F9A 21C4', kind: 'macos' } }
const LAN = 'http://192.168.1.20:4082'
const onSavedServer = { ...noServer, base_url: LAN, servers: [{ base_url: LAN, name: 'Studio Mac' }] }

/** The shell: where the app is, and the taps it queued. */
let opened = false
/** The server the shell is on before the launch check opens the computer. */
let atLaunch: typeof noServer = noServer
let taps: unknown[] = []
mock.module('@tauri-apps/api/core', () => ({
  invoke: async (command: string) => {
    switch (command) {
      case 'app_backend_status': return opened ? onBridge : atLaunch
      case 'cloud_status': return { state: 'connected', fingerprint: 'AA11 BB22', signer: true }
      case 'cloud_devices': return [ME, MAC]
      case 'cloud_open_computer':
        opened = true
        return { status: onBridge, via: 'account' }
      case 'cloud_pending': return [{ enrollment_id: 'request-1', fingerprint: '9C02 E1B7', country: null, created_at: 1, expires_at: null }]
      case 'notification_take_taps': {
        const queued = taps
        taps = []
        return queued
      }
      case 'cloud_poke':
      case 'cloud_push_register':
      case 'secure_get_access_key':
        return null
      default: throw new Error(`unexpected command: ${command}`)
    }
  },
}))
mock.module('@tauri-apps/api/event', () => ({ listen: async () => () => {} }))
mock.module('@tauri-apps/api/webviewWindow', () => ({ getCurrentWebviewWindow: () => ({ listen: async () => () => {} }) }))

const { default: App } = await import('@/App')
const { setApiBaseUrl } = await import('@/api/base-url')
const { resetAccountRoute } = await import('@/lib/account-route')
const { resetAppStart } = await import('@/lib/app-start')
const { lastRouteStorageKey } = await import('@/lib/route-restore')
const { queryClient } = await import('@/lib/query-client')
const { useBackendSwitchStore } = await import('@/stores/useBackendSwitchStore')

const realLocation = window.location
const originalFetch = globalThis.fetch
let reload = mock(() => {})

beforeEach(() => {
  opened = false
  atLaunch = noServer
  taps = []
  sheetMounts = 0
  resetAccountRoute()
  resetAppStart()
  window.localStorage.clear()
  window.sessionStorage.clear()
  queryClient.clear()
  useBackendSwitchStore.setState({ target: null, generation: 0, committing: false })
  globalThis.fetch = mock(async () => new Response(null, { status: 204 })) as unknown as typeof fetch
  reload = mock(() => {})
  const { href, origin, protocol, host, hostname, port, pathname, search, hash } = realLocation
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { href, origin, protocol, host, hostname, port, pathname, search, hash, reload, assign: () => {}, replace: () => {} },
  })
})

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
  Object.defineProperty(window, 'location', { configurable: true, value: realLocation })
  setApiBaseUrl('/api')
})

/** The launch check opened the last computer, and the page either started the app or asked for a reload. */
async function launched() {
  await waitFor(() => expect(opened).toBe(true))
  await waitFor(() => expect(reload.mock.calls.length + screen.queryAllByTestId('app-running').length).toBeGreaterThan(0))
}

describe('a cold launch on a phone with no server of its own', () => {
  it('starts the app on the computer last used without loading the page again', async () => {
    render(<App />)
    await launched()
    expect(reload).not.toHaveBeenCalled()
    expect(screen.getByTestId('app-running')).toBeTruthy()
    expect(screen.queryByTestId('computers-screen')).toBeNull()
    // The "Switching to …" screen went with the start.
    expect(useBackendSwitchStore.getState().target).toBeNull()
  })

  it('comes back to the session the person was in', async () => {
    window.localStorage.setItem(lastRouteStorageKey(), '/session-before')
    render(<App />)
    await launched()
    expect(window.localStorage.getItem(lastRouteStorageKey())).toBe('/session-before')
  })

  it('keeps the approval sheet a tapped "A device wants to join" opened', async () => {
    taps = [{ kind: 'approval' }]
    render(<App />)
    expect((await screen.findByTestId('approval-sheet')).textContent).toBe('request-1')
    await launched()
    expect(reload).not.toHaveBeenCalled()
    expect(screen.getByTestId('approval-sheet').textContent).toBe('request-1')
    expect(sheetMounts).toBe(1)
  })
})

describe('a launch on a phone that has a saved server too', () => {
  it('reloads onto the computer last used: the app had already started on the saved server', async () => {
    atLaunch = onSavedServer
    render(<App />)
    await screen.findByTestId('app-running')
    await waitFor(() => expect(opened).toBe(true))
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
  })
})
