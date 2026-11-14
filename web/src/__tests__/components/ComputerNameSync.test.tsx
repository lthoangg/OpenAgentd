/**
 * The app remembers what the computer it is on calls itself: it reads the
 * name from the server and hands it to the shell, under that computer's
 * key. A name that was read from another server (the app has switched) is
 * never filed under this one.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { AppBackendStatus } from '@/lib/app-backend'

let backend: AppBackendStatus | null
let remembered: Array<{ key: string; name: string }> = []
mock.module('@tauri-apps/api/core', () => ({
  invoke: async (command: string, args?: { key: string; name: string }) => {
    if (command === 'app_backend_status') return backend
    if (command === 'app_remember_computer_name' && args && backend) {
      remembered.push({ key: args.key, name: args.name })
      backend = { ...backend, computer_names: { ...backend.computer_names, [args.key]: args.name } }
      return backend
    }
    return null
  },
}))

const { ComputerNameSync } = await import('@/components/ComputerNameSync')
const { queryKeys } = await import('@/queries/keys')

const BRIDGE = 'http://127.0.0.1:5999'
const MAC = { device_id: 'dev-mac', fingerprint: '3F9A 21C4', kind: 'macos' }
const originalFetch = globalThis.fetch
let client: QueryClient
let served: { name: string | null; default: string | null; custom: boolean }
let asked: string[] = []

function status(overrides: Partial<AppBackendStatus> = {}): AppBackendStatus {
  return { base_url: BRIDGE, mode: 'external', sidecar_running: false, external: true, supports_bundled: false, servers: [], account_device: MAC, ...overrides }
}

function mount(capabilities: string[] = ['api.server_name']) {
  client.setQueryData(queryKeys.health(), { status: 'ok', version: '3.54.0', capabilities })
  return render(<QueryClientProvider client={client}><ComputerNameSync /></QueryClientProvider>)
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchInterval: false } } })
  backend = status()
  remembered = []
  asked = []
  served = { name: 'Work', default: 'studio-mini', custom: true }
  window.__OAD_API_BASE_URL__ = BRIDGE
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input)
    asked.push(url)
    if (url.endsWith('/server/name')) return Response.json(served)
    return new Response(null, { status: 204 })
  }) as unknown as typeof fetch
})
afterEach(() => {
  cleanup()
  client.clear()
  globalThis.fetch = originalFetch
  delete window.__OAD_API_BASE_URL__
})

describe('ComputerNameSync', () => {
  it('remembers the name of the account computer in use, under its device id', async () => {
    mount()
    await waitFor(() => expect(remembered).toEqual([{ key: 'dev-mac', name: 'Work' }]))
    // Everything that reads the app's status sees the name at once.
    await waitFor(() => expect(client.getQueryData<AppBackendStatus>(queryKeys.backendStatus())?.computer_names).toEqual({ 'dev-mac': 'Work' }))
  })

  it('files a saved server under its address and the built-in server under its own key', async () => {
    backend = status({ base_url: 'http://192.168.1.30:4082', account_device: null })
    window.__OAD_API_BASE_URL__ = 'http://192.168.1.30:4082'
    const first = mount()
    await waitFor(() => expect(remembered).toEqual([{ key: 'http://192.168.1.30:4082', name: 'Work' }]))
    first.unmount()
    client.clear()

    remembered = []
    backend = status({ base_url: 'http://127.0.0.1:51000', mode: 'bundled', external: false, sidecar_running: true, supports_bundled: true, account_device: null })
    window.__OAD_API_BASE_URL__ = 'http://127.0.0.1:51000'
    mount()
    await waitFor(() => expect(remembered).toEqual([{ key: 'built-in', name: 'Work' }]))
  })

  it('says nothing to the shell when it already has that name', async () => {
    backend = status({ computer_names: { 'dev-mac': 'Work' } })
    mount()
    await waitFor(() => expect(asked.some((url) => url.endsWith('/server/name'))).toBe(true))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(remembered).toEqual([])
  })

  it('replaces the remembered name once the computer was renamed from another device', async () => {
    backend = status({ computer_names: { 'dev-mac': 'Work', 'dev-mini': 'Personal' } })
    served = { name: 'Studio', default: 'studio-mini', custom: true }
    mount()
    await waitFor(() => expect(remembered).toEqual([{ key: 'dev-mac', name: 'Studio' }]))
    await waitFor(() => expect(client.getQueryData<AppBackendStatus>(queryKeys.backendStatus())?.computer_names).toEqual({ 'dev-mac': 'Studio', 'dev-mini': 'Personal' }))
  })

  it('does not file a name read from one server under another', async () => {
    // The name came from the bridge, but the app has since moved to a saved server.
    backend = status({ base_url: 'http://192.168.1.30:4082', account_device: null })
    mount()
    await waitFor(() => expect(asked.some((url) => url.endsWith('/server/name'))).toBe(true))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(remembered).toEqual([])
  })

  it('asks an older server nothing', async () => {
    mount([])
    await waitFor(() => expect(client.getQueryData(queryKeys.backendStatus())).toBeTruthy())
    expect(asked.filter((url) => url.endsWith('/server/name'))).toEqual([])
    expect(remembered).toEqual([])
  })

  it('leaves the remembered name alone when the computer reports none', async () => {
    served = { name: null, default: null, custom: false }
    backend = status({ computer_names: { 'dev-mac': 'Work' } })
    mount()
    await waitFor(() => expect(asked.some((url) => url.endsWith('/server/name'))).toBe(true))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(remembered).toEqual([])
  })
})
