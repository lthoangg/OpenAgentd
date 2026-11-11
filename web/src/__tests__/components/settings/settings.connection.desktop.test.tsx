/**
 * Settings → Server in the desktop app: "Your computers" above the servers.
 * The account is the built-in server's, so its calls go through the shell
 * (`desktop_cloud_call`) even while the window shows another computer; the
 * list holds the account's servers but not this computer, with their dots
 * and the one in use marked; Use opens a computer through the shell; and the
 * edges (built-in server stopped, not a client) say so. The shell is faked
 * at `invoke`.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'

const realPlatform = await import('@/hooks/use-platform')
const mac = { isTauri: true, os: 'macos', isMacOverlay: false, isFullscreen: false }
mock.module('@/hooks/use-platform', () => ({ ...realPlatform, getPlatform: () => mac, usePlatform: () => mac }))

type Handler = (args?: Record<string, unknown>) => unknown
let handlers: Record<string, Handler> = {}
let calls: Array<{ command: string; args?: Record<string, unknown> }> = []

mock.module('@tauri-apps/api/core', () => ({
  invoke: async (command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args })
    const handler = handlers[command]
    return handler ? handler(args) : null
  },
}))

const { ConnectionSettingsPage } = await import('@/components/settings/pages/settings.connection')
const { BUILTIN_STOPPED_COMPUTERS, CANNOT_OPEN_COMPUTERS } = await import('@/components/phone/AccountComputers')
const { queryClient } = await import('@/lib/query-client')

import type { CloudDevice, CloudStatus } from '@/api/cloud'
import type { AppBackendStatus } from '@/lib/app-backend'

const BRIDGE = 'http://127.0.0.1:5999'
const BUILTIN = 'http://127.0.0.1:4082'

const CONNECTED: CloudStatus = { state: 'connected', fingerprint: 'AA11 BB22', signer: true, server: true, client: true, relay: { state: 'online' }, sessions: 0 }
const ME: CloudDevice = { device_id: 'dev-me', fingerprint: 'AA11 BB22', signer: true, me: true, kind: 'macos', server: true, client: true, online: true }
const PHONE: CloudDevice = { device_id: 'dev-phone', fingerprint: 'CC33 DD44', signer: true, me: false, kind: 'ios', server: false, client: true, online: null }
const LINUX: CloudDevice = { device_id: 'dev-linux', fingerprint: '9C02 E1B7', signer: false, me: false, kind: 'linux', server: true, client: false, online: true }
const WINDOWS: CloudDevice = { device_id: 'dev-win', fingerprint: '1111 2222', signer: false, me: false, kind: 'windows', server: true, client: true, online: false }

function app(overrides: Partial<AppBackendStatus> = {}): AppBackendStatus {
  return {
    base_url: BUILTIN,
    mode: 'bundled',
    sidecar_running: true,
    external: false,
    supports_bundled: true,
    servers: [],
    ...overrides,
  }
}

/** The window on the Linux computer, through the account. */
const ON_LINUX = app({ base_url: BRIDGE, mode: 'external', external: true, account_device: { device_id: 'dev-linux', fingerprint: '9C02 E1B7', kind: 'linux' } })

let cloudStatus: CloudStatus
let devices: CloudDevice[]
let backend: AppBackendStatus

function shell(extra: Record<string, Handler> = {}) {
  handlers = {
    app_backend_status: () => backend,
    app_server_watch_states: () => ({}),
    secure_get_access_key: () => null,
    desktop_cloud_call: (args) => {
      if (backend.sidecar_running === false) throw 'The built-in server is stopped.'
      const path = args?.path
      const body = path === '/status' ? cloudStatus : path === '/devices' ? devices : null
      return { status: body === null ? 404 : 200, body: JSON.stringify(body ?? { detail: 'Not found' }) }
    },
    ...extra,
  }
}

const originalFetch = globalThis.fetch
const fetched: string[] = []
const originalLocation = window.location
let reloads = 0

beforeEach(() => {
  calls = []
  fetched.length = 0
  reloads = 0
  cloudStatus = CONNECTED
  devices = [ME, PHONE, LINUX, WINDOWS]
  backend = app()
  window.localStorage.clear()
  queryClient.setDefaultOptions({ ...queryClient.getDefaultOptions(), queries: { ...queryClient.getDefaultOptions().queries, retry: false } })
  window.__OAD_API_BASE_URL__ = BRIDGE
  globalThis.fetch = mock(async (input: unknown) => {
    fetched.push(String(input))
    return new Response(null, { status: 204 })
  }) as unknown as typeof fetch
  const { href, origin, protocol, host, hostname, port, pathname, search, hash } = originalLocation
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { href, origin, protocol, host, hostname, port, pathname, search, hash, reload: () => { reloads += 1 }, assign: () => {}, replace: () => {} },
  })
})

afterEach(() => {
  cleanup()
  queryClient.clear()
  globalThis.fetch = originalFetch
  Object.defineProperty(window, 'location', { configurable: true, value: originalLocation })
  delete window.__OAD_API_BASE_URL__
})

function page() {
  return render(
    <QueryClientProvider client={queryClient}>
      <ConnectionSettingsPage />
    </QueryClientProvider>,
  )
}

const ran = (command: string) => calls.filter((call) => call.command === command)
const rowOf = (name: string) => screen.getByText(name).closest('[data-server-row]') as HTMLElement

describe('Your computers on the desktop', () => {
  it('lists the account’s servers, not this computer, with their status and the one in use', async () => {
    backend = ON_LINUX
    shell()
    page()

    expect(await screen.findByText('Linux · 9C02 E1B7')).toBeTruthy()
    expect(screen.getByText('Windows · 1111 2222')).toBeTruthy()
    expect(screen.queryByText('macOS · AA11 BB22')).toBeNull()
    expect(screen.queryByText('iOS · CC33 DD44')).toBeNull()
    const linux = rowOf('Linux · 9C02 E1B7')
    expect(within(linux).getByText('In use')).toBeTruthy()
    expect(within(linux).getByText('Through your account')).toBeTruthy()
    expect(within(linux).getByRole('button', { name: 'Open sessions on Linux · 9C02 E1B7' })).toBeTruthy()
    const windows = rowOf('Windows · 1111 2222')
    expect(within(windows).getByText('Offline')).toBeTruthy()
    expect(within(windows).getByRole('button', { name: 'Use Windows · 1111 2222' })).toBeTruthy()
    // Above the servers.
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)
    expect(headings.indexOf('Your computers')).toBeLessThan(headings.indexOf('Servers'))
  })

  it('asks the built-in server for the account while the window shows another computer', async () => {
    backend = ON_LINUX
    shell()
    page()
    await screen.findByText('Linux · 9C02 E1B7')

    const paths = ran('desktop_cloud_call').map((call) => call.args?.path)
    expect(paths).toContain('/status')
    expect(paths).toContain('/devices')
    expect(fetched.some((url) => url.includes('/api/cloud/'))).toBe(false)
  })

  it('says Online · through your account for a computer not in use', async () => {
    shell()
    page()
    const linux = await screen.findByText('Linux · 9C02 E1B7')
    expect(within(linux.closest('[data-server-row]') as HTMLElement).getByText('Online · through your account')).toBeTruthy()
  })

  it('opens a computer through the shell and moves the window to it', async () => {
    shell({
      cloud_open_computer: () => ({ status: ON_LINUX, via: 'account' }),
    })
    page()
    fireEvent.click(await screen.findByRole('button', { name: 'Use Linux · 9C02 E1B7' }))

    await waitFor(() => expect(reloads).toBe(1))
    expect(ran('cloud_open_computer')[0].args).toEqual({ deviceId: 'dev-linux', lanBaseUrl: null })
  })

  it('gives the phone’s message when the computer is offline', async () => {
    shell({
      cloud_open_computer: () => { throw 'This computer is offline, or not signed in to your account.' },
    })
    page()
    fireEvent.click(await screen.findByRole('button', { name: 'Use Windows · 1111 2222' }))

    expect(await screen.findByText('This computer is offline, or not signed in to your account.')).toBeTruthy()
    expect(reloads).toBe(0)
  })

  it('says the built-in server is stopped, and starts it', async () => {
    backend = app({ sidecar_running: false })
    shell({ app_start_bundled_backend: () => { backend = app() } })
    page()

    expect(await screen.findByText(BUILTIN_STOPPED_COMPUTERS)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    await waitFor(() => expect(ran('app_start_bundled_backend')).toHaveLength(1))
    expect(await screen.findByText('Linux · 9C02 E1B7')).toBeTruthy()
  })

  it('says a computer signed in without the client role cannot open others', async () => {
    cloudStatus = { ...CONNECTED, client: false } as CloudStatus
    shell()
    page()

    expect(await screen.findByText(CANNOT_OPEN_COMPUTERS)).toBeTruthy()
    expect(ran('desktop_cloud_call').map((call) => call.args?.path)).not.toContain('/devices')
  })

  it('shows nothing of the account to a guest', async () => {
    cloudStatus = { state: 'guest', notice: null }
    shell()
    page()
    await screen.findByText('Servers')
    await waitFor(() => expect(ran('desktop_cloud_call').length).toBeGreaterThan(0))
    expect(screen.queryByText('Your computers')).toBeNull()
  })
})
