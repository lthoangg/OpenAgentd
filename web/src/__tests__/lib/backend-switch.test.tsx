/**
 * Switching servers shows "Switching to …" from the moment a server is
 * picked: through the reload onto the new server, or until a failure, which
 * closes the screen and hands the error back to where the user started.
 * Every entry point (Settings, the dialog, the palette) goes through these
 * helpers, so the palette's handlers are driven here too.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, render, renderHook, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

let bundledStart: Deferred<null> | null = null
let status = {
  base_url: 'http://127.0.0.1:5999',
  mode: 'external',
  sidecar_running: false,
  external: true,
  supports_bundled: true,
  servers: [{ base_url: 'http://127.0.0.1:4082', name: 'Home Mac' }],
}

mock.module('@tauri-apps/api/core', () => ({
  invoke: async (command: string, args?: { baseUrl?: string }) => {
    if (command === 'app_backend_status') return status
    if (command === 'app_use_external_backend') return { ...status, base_url: args?.baseUrl ?? status.base_url }
    if (command === 'app_use_bundled_backend') {
      await bundledStart?.promise
      return null
    }
    return null
  },
}))

import { BackendSwitchScreen } from '@/components/BackendSwitchScreen'
import { usePaletteServerCommands } from '@/components/AgentChatView/usePaletteServerCommands'
import { connectBundledBackend, connectExternalBackend } from '@/lib/backend-switch'
import { queryKeys } from '@/queries/keys'
import { pendingBackendSwitch, useBackendSwitchStore } from '@/stores/useBackendSwitchStore'
import { useToastStore } from '@/stores/useToastStore'

const originalFetch = globalThis.fetch
const originalReload = window.location.reload
let gate: Deferred<void> | null = null
let reachable = true

beforeEach(() => {
  gate = null
  reachable = true
  bundledStart = null
  status = { ...status, base_url: 'http://127.0.0.1:5999', mode: 'external', external: true }
  window.__OAD_API_BASE_URL__ = 'http://127.0.0.1:5999'
  window.location.reload = mock(() => {}) as typeof window.location.reload
  const fetchMock = mock(async () => {
    await gate?.promise
    return new Response(null, { status: reachable ? 204 : 503 })
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch
  window.fetch = fetchMock as unknown as typeof window.fetch
})

afterEach(() => {
  cleanup()
  useBackendSwitchStore.setState({ target: null })
  useToastStore.setState({ toasts: [] })
  window.sessionStorage.clear()
  globalThis.fetch = originalFetch
  window.fetch = originalFetch
  window.location.reload = originalReload
  delete window.__OAD_API_BASE_URL__
})

const connectHome = () => connectExternalBackend({ baseUrl: 'http://127.0.0.1:4082', name: 'Home Mac', persist: true, currentBaseUrl: 'http://127.0.0.1:5999' })

describe('switching servers', () => {
  it('says where it is going from the moment a server is picked, and keeps saying it through the reload', async () => {
    gate = deferred()
    render(<BackendSwitchScreen />)
    let switching!: ReturnType<typeof connectHome>
    act(() => { switching = connectHome() })

    const screenEl = screen.getByRole('status', { name: 'Switching to Home Mac' })
    expect(screenEl.textContent).toBe('Switching to Home Mac…http://127.0.0.1:4082')

    gate.resolve()
    const result = await act(() => switching)
    expect(result).toMatchObject({ ok: true, reload: true })
    // The caller reloads now; the startup screen of the next load takes over.
    expect(screen.getByRole('status', { name: 'Switching to Home Mac' })).toBeTruthy()
    expect(pendingBackendSwitch()).toEqual({ name: 'Home Mac', detail: 'http://127.0.0.1:4082' })
  })

  it('closes the screen and returns the error when the server does not answer', async () => {
    reachable = false
    render(<BackendSwitchScreen />)

    const result = await act(() => connectHome())

    expect(result.ok).toBe(false)
    expect(screen.queryByRole('status')).toBeNull()
    expect(pendingBackendSwitch()).toBeNull()
  })

  it('shows the builtin server starting, and closes when no reload is needed', async () => {
    bundledStart = deferred()
    status = { ...status, base_url: 'http://127.0.0.1:5999', mode: 'bundled', external: false, sidecar_running: true }
    render(<BackendSwitchScreen />)
    let switching!: ReturnType<typeof connectBundledBackend>
    act(() => { switching = connectBundledBackend('http://127.0.0.1:5999') })

    expect(screen.getByRole('status', { name: 'Switching to the builtin server' }).textContent).toContain("Running sessions continue once it's up.")

    bundledStart.resolve(null)
    const result = await act(() => switching)
    expect(result).toMatchObject({ ok: true, reload: false })
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('forgets a handoff from a switch that never finished loading', () => {
    window.sessionStorage.setItem('openagentd.backendSwitch', JSON.stringify({ name: 'Home Mac', at: Date.now() - 5 * 60_000 }))
    expect(pendingBackendSwitch()).toBeNull()
  })
})

describe("the palette's Switch Server…", () => {
  function paletteRows() {
    const client = new QueryClient()
    client.setQueryData(queryKeys.backendStatus(), status)
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
    const { result } = renderHook(() => usePaletteServerCommands(), { wrapper })
    return result.current[0].page!.commands
  }

  it('shows the switching screen as soon as a server is chosen, though the palette has closed', () => {
    gate = deferred()
    render(<BackendSwitchScreen />)
    const home = paletteRows().find((c) => c.label === 'Home Mac')!

    act(() => { void home.action() })

    expect(screen.getByRole('status', { name: 'Switching to Home Mac' })).toBeTruthy()
    gate.resolve()
  })

  it('returns to the chat with an error toast when the switch fails', async () => {
    reachable = false
    render(<BackendSwitchScreen />)
    const home = paletteRows().find((c) => c.label === 'Home Mac')!

    act(() => { void home.action() })
    await act(async () => {
      while (useToastStore.getState().toasts.length === 0) await new Promise((r) => setTimeout(r, 5))
    })

    expect(screen.queryByRole('status')).toBeNull()
    expect(useToastStore.getState().toasts[0]).toMatchObject({ tone: 'error', title: 'Could not connect to Home Mac' })
  })
})
