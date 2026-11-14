/**
 * The phone's Servers screen when the server in use has a newer release it
 * can install: "Update to vX" sits under that row (a saved server, or a
 * computer of the account), and under no other. The screen is rendered bare,
 * as App.tsx shows it before the router and its QueryClientProvider exist.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ServerUpdateStatus } from '@/api/client/server-update'
import type { AppBackendStatus } from '@/lib/app-backend'

const realPlatform = await import('@/hooks/use-platform')
const phone = { isTauri: true, os: 'android', isMacOverlay: false, isFullscreen: false }
mock.module('@/hooks/use-platform', () => ({ ...realPlatform, getPlatform: () => phone, usePlatform: () => phone }))

let update: ServerUpdateStatus | undefined
mock.module('@/queries/useServerUpdateQuery', () => ({
  useServerUpdateQuery: () => ({ data: update }),
  SERVER_UPDATE_CAPABILITY: 'api.server_update',
}))

let backend: AppBackendStatus
let devices: unknown[] = []
mock.module('@tauri-apps/api/core', () => ({
  invoke: async (command: string) => {
    if (command === 'app_backend_status') return backend
    if (command === 'app_server_watch_states') return {}
    if (command === 'cloud_status') return devices.length ? { state: 'connected', fingerprint: 'AA11 BB22', signer: true } : { state: 'guest', notice: null, supported: true }
    if (command === 'cloud_devices') return devices
    if (command === 'cloud_pending') return []
    if (command === 'cloud_link_route') return { route: 'lan' }
    return null
  },
}))

const { ServersScreen } = await import('@/components/phone/ServersScreen')
const { useServerUpdateStore } = await import('@/stores/useServerUpdateStore')
const { queryClient } = await import('@/lib/query-client')
const { queryKeys } = await import('@/queries/keys')

const MAC_MINI = 'http://192.168.1.20:4082'
const NAS = 'http://192.168.1.30:4082'
const BRIDGE = 'http://127.0.0.1:5999'
const start = mock(async () => {})
const originalFetch = globalThis.fetch
let fetched: string[] = []

beforeEach(() => {
  start.mockClear()
  devices = []
  update = {
    current: '3.53.1', latest: '3.54.0', available: true, can_upgrade: true, method: 'desktop_app', reason: null, check_error: null,
    in_progress: false, release_url: null, log: '', last: null,
  }
  backend = {
    base_url: MAC_MINI, mode: 'external', sidecar_running: false, external: true, supports_bundled: false,
    servers: [{ base_url: MAC_MINI, name: 'Mac mini' }, { base_url: NAS, name: 'Office NAS' }],
  }
  window.__OAD_API_BASE_URL__ = MAC_MINI
  useServerUpdateStore.setState({ phase: { kind: 'idle' }, start })
  // What the running app already knows about the server in use.
  queryClient.setQueryData(queryKeys.health(), { status: 'ok', version: '3.53.1', capabilities: ['api.server_update'] })
  fetched = []
  globalThis.fetch = (async (input: unknown) => { fetched.push(String(input)); return new Response(null, { status: 204 }) }) as unknown as typeof fetch
})
afterEach(() => {
  cleanup()
  queryClient.clear()
  globalThis.fetch = originalFetch
  delete window.__OAD_API_BASE_URL__
})

const rowOf = (name: string) => screen.getByText(name).closest('[data-server-row]') as HTMLElement

describe('Update the server from its row', () => {
  it('offers the update under the saved server in use, and under no other', async () => {
    render(<ServersScreen active onOpenSessions={() => {}} />)
    const button = await screen.findByRole('button', { name: 'Update to v3.54.0' })
    expect(screen.getAllByRole('button', { name: /Update to/ })).toHaveLength(1)
    const block = button.closest('[data-server-update-on-row]') as HTMLElement
    expect(block.previousElementSibling).toBe(rowOf('Mac mini'))
    expect(block.textContent).toContain('Updates OpenAgentd on that computer and restarts it.')
    // One row: the list's hairline (the row's bottom edge) is dropped above the update.
    expect(rowOf('Mac mini').className).toContain('has-[+[data-server-update-on-row]]:border-b-0!')

    fireEvent.click(button)
    expect(start).toHaveBeenCalledTimes(1)
  })

  it('offers it under the account computer in use', async () => {
    devices = [
      { device_id: 'dev-me', fingerprint: 'AA11 BB22', signer: true, me: true, kind: 'android', server: false, client: true, online: null },
      { device_id: 'dev-mac', fingerprint: '3F9A 21C4', signer: true, me: false, kind: 'macos', server: true, client: true, online: true },
    ]
    backend = { ...backend, base_url: BRIDGE, account_device: { device_id: 'dev-mac', fingerprint: '3F9A 21C4', kind: 'macos' } }
    window.__OAD_API_BASE_URL__ = BRIDGE
    render(<ServersScreen active onOpenSessions={() => {}} />)
    const button = await screen.findByRole('button', { name: 'Update to v3.54.0' })
    expect(screen.getAllByRole('button', { name: /Update to/ })).toHaveLength(1)
    const block = button.closest('[data-server-update-on-row]') as HTMLElement
    expect(block.previousElementSibling).toBe(rowOf('macOS · 3F9A 21C4'))
  })

  it('asks a server nothing before the app knows it: no row, no health request', async () => {
    queryClient.clear()
    render(<ServersScreen active onOpenSessions={() => {}} />)
    await screen.findByText('Mac mini')
    expect(document.querySelector('[data-server-update-on-row]')).toBeNull()
    expect(fetched.filter((url) => url.includes('/health/ready'))).toEqual([])
  })

  it('adds nothing to the rows of a server that is up to date', async () => {
    update = { ...update!, current: '3.54.0', available: false }
    render(<ServersScreen active onOpenSessions={() => {}} />)
    await screen.findByText('Mac mini')
    expect(document.querySelector('[data-server-update-on-row]')).toBeNull()
  })
})
