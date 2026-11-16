/**
 * Switching servers shows "Switching to …" from the moment a server is
 * picked: through the reload onto the new server, or until a failure, which
 * closes the screen and hands the error back to where the user started.
 * Every entry point (Settings, the dialog, the palette) goes through these
 * helpers, so the palette's handlers are driven here too.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

let bundledStart: Deferred<null> | null = null
/** Holds `app_use_external_backend` (the commit point) while set. */
let externalUse: Deferred<void> | null = null
/** Holds `cloud_open_computer` (opening a computer through its link) while set. */
let computerOpen: Deferred<void> | null = null
const invoked: Array<{ command: string; args?: Record<string, unknown> }> = []
const BRIDGE = 'http://127.0.0.1:6111'
let status = {
  base_url: 'http://127.0.0.1:5999',
  mode: 'external',
  sidecar_running: false,
  external: true,
  supports_bundled: true,
  servers: [{ base_url: 'http://127.0.0.1:4082', name: 'Home Mac' }],
}

mock.module('@tauri-apps/api/core', () => ({
  invoke: async (command: string, args?: { baseUrl?: string; deviceId?: string }) => {
    invoked.push({ command, args })
    if (command === 'app_backend_status') return status
    if (command === 'app_use_external_backend') {
      await externalUse?.promise
      return { ...status, base_url: args?.baseUrl ?? status.base_url }
    }
    if (command === 'cloud_open_computer') {
      await computerOpen?.promise
      return {
        status: { ...status, base_url: BRIDGE, account_device: { device_id: args?.deviceId, fingerprint: '3F9A 21C4', kind: 'macos' } },
        via: 'account',
      }
    }
    if (command === 'app_use_bundled_backend') {
      await bundledStart?.promise
      return null
    }
    return null
  },
}))

import { BackendSwitchScreen } from '@/components/BackendSwitchScreen'
import { usePaletteServerCommands } from '@/components/AgentChatView/usePaletteServerCommands'
import { connectAccountComputer, connectBundledBackend, connectExternalBackend, returnFromBackendSwitch } from '@/lib/backend-switch'
import { queryKeys } from '@/queries/keys'
import { cancelBackendSwitch, pendingBackendSwitch, useBackendSwitchStore } from '@/stores/useBackendSwitchStore'
import { useToastStore } from '@/stores/useToastStore'

const originalFetch = globalThis.fetch
const originalReload = window.location.reload
let gate: Deferred<void> | null = null
let reachable = true

beforeEach(() => {
  gate = null
  reachable = true
  bundledStart = null
  externalUse = null
  computerOpen = null
  invoked.length = 0
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
  useBackendSwitchStore.setState({ target: null, committing: false })
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
    // With where it came from, for the startup screen's Back.
    expect(pendingBackendSwitch()).toEqual({
      name: 'Home Mac',
      detail: 'http://127.0.0.1:4082',
      from: { kind: 'server', baseUrl: 'http://127.0.0.1:5999', name: '' },
    })
  })

  it('closes the screen and returns the error when the server does not answer', async () => {
    reachable = false
    render(<BackendSwitchScreen />)

    const result = await act(() => connectHome())

    expect(result.ok).toBe(false)
    expect(screen.queryByRole('status')).toBeNull()
    expect(pendingBackendSwitch()).toBeNull()
  })

  it('shows this computer starting, and closes when no reload is needed', async () => {
    bundledStart = deferred()
    status = { ...status, base_url: 'http://127.0.0.1:5999', mode: 'bundled', external: false, sidecar_running: true }
    render(<BackendSwitchScreen />)
    let switching!: ReturnType<typeof connectBundledBackend>
    act(() => { switching = connectBundledBackend('http://127.0.0.1:5999') })

    expect(screen.getByRole('status', { name: 'Switching to this computer' }).textContent).toContain("Running sessions continue once it's up.")

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

/** Settle every pending promise and timer tick. */
const settle = () => act(() => new Promise((r) => setTimeout(r, 10)))
const shellCalls = (command: string) => invoked.filter((call) => call.command === command)

describe('Back on the switching screen', () => {
  it('ends the screen at once, and the switch changes nothing after it', async () => {
    gate = deferred()
    render(<BackendSwitchScreen />)
    let switching!: ReturnType<typeof connectHome>
    act(() => { switching = connectHome() })

    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.queryByRole('status')).toBeNull()
    expect(pendingBackendSwitch()).toBeNull()

    // The server answers after Back: nothing more happens.
    gate.resolve()
    expect(await act(() => switching)).toEqual({ ok: false, cancelled: true })
    expect(shellCalls('app_use_external_backend')).toHaveLength(0)
    expect(window.__OAD_API_BASE_URL__).toBe('http://127.0.0.1:5999')
    expect(window.location.reload).not.toHaveBeenCalled()
  })

  it('is Escape too', () => {
    gate = deferred()
    render(<BackendSwitchScreen />)
    act(() => { void connectHome() })

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByRole('status')).toBeNull()
    gate.resolve()
  })

  it('goes away at the commit point, where the switch can no longer be called back', async () => {
    externalUse = deferred()
    render(<BackendSwitchScreen />)
    let switching!: ReturnType<typeof connectHome>
    act(() => { switching = connectHome() })
    expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy()

    await settle()
    expect(shellCalls('app_use_external_backend')).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull()
    // Escape does nothing now either.
    expect(cancelBackendSwitch()).toBe(false)

    externalUse.resolve()
    expect(await act(() => switching)).toMatchObject({ ok: true, reload: true })
    expect(window.__OAD_API_BASE_URL__).toBe('http://127.0.0.1:4082')
  })

  it("drops a computer's late opening, and puts the shell back where the page still is", async () => {
    computerOpen = deferred()
    render(<BackendSwitchScreen />)
    let switching!: ReturnType<typeof connectAccountComputer>
    act(() => { switching = connectAccountComputer({ deviceId: 'dev-mac', label: 'Mac', currentBaseUrl: 'http://127.0.0.1:5999' }) })
    await settle()
    expect(shellCalls('cloud_open_computer')).toHaveLength(1)

    // Opening the link is the slow part: Back is still there.
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    computerOpen.resolve()

    expect(await act(() => switching)).toEqual({ ok: false, cancelled: true })
    expect(window.__OAD_API_BASE_URL__).toBe('http://127.0.0.1:5999')
    expect(window.location.reload).not.toHaveBeenCalled()
    // The shell opened it anyway: it is pointed back at the server the page is on.
    await settle()
    expect(shellCalls('app_use_external_backend').map((call) => call.args?.baseUrl)).toEqual(['http://127.0.0.1:5999'])
  })

  it('drops a late failure without an error', async () => {
    gate = deferred()
    reachable = false
    render(<BackendSwitchScreen />)
    let switching!: ReturnType<typeof connectHome>
    act(() => { switching = connectHome() })

    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    gate.resolve()

    expect(await act(() => switching)).toEqual({ ok: false, cancelled: true })
  })

  it('lets another server be picked at once, and the first one answering late leaves it alone', async () => {
    const first = deferred<void>()
    gate = first
    render(<BackendSwitchScreen />)
    let firstSwitch!: ReturnType<typeof connectHome>
    act(() => { firstSwitch = connectHome() })
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))

    gate = null
    bundledStart = deferred()
    let second!: ReturnType<typeof connectBundledBackend>
    status = { ...status, mode: 'bundled', external: false, sidecar_running: true }
    act(() => { second = connectBundledBackend('http://127.0.0.1:5999') })
    expect(screen.getByRole('status', { name: 'Switching to this computer' })).toBeTruthy()

    first.resolve()
    expect(await act(() => firstSwitch)).toEqual({ ok: false, cancelled: true })
    // The late answer neither closed the new switch's screen nor switched.
    expect(screen.getByRole('status', { name: 'Switching to this computer' })).toBeTruthy()
    expect(shellCalls('app_use_external_backend')).toHaveLength(0)

    bundledStart.resolve(null)
    expect(await act(() => second)).toMatchObject({ ok: true })
    expect(shellCalls('app_use_bundled_backend')).toHaveLength(1)
  })

  it('a new switch replaces one under way', async () => {
    const first = deferred<void>()
    gate = first
    let firstSwitch!: ReturnType<typeof connectHome>
    act(() => { firstSwitch = connectHome() })
    gate = null
    const second = await act(() => connectExternalBackend({ baseUrl: 'http://127.0.0.1:4090', name: 'Other', persist: true, currentBaseUrl: 'http://127.0.0.1:5999' }))
    first.resolve()

    expect(second).toMatchObject({ ok: true, reload: true })
    expect(await act(() => firstSwitch)).toEqual({ ok: false, cancelled: true })
    expect(shellCalls('app_use_external_backend').map((call) => call.args?.baseUrl)).toEqual(['http://127.0.0.1:4090'])
  })
})

describe("the startup screen's Back after the reload", () => {
  it('switches back to the server the window came from, and reloads onto it', async () => {
    window.__OAD_API_BASE_URL__ = 'http://127.0.0.1:4082'
    const outcome = await act(() => returnFromBackendSwitch({ kind: 'server', baseUrl: 'http://127.0.0.1:5999', name: 'Studio' }))

    expect(outcome).toBe('switching')
    expect(shellCalls('app_use_external_backend').map((call) => call.args)).toEqual([{ baseUrl: 'http://127.0.0.1:5999', name: 'Studio', persist: true }])
    expect(window.location.reload).toHaveBeenCalledTimes(1)
  })

  it('has nothing to go back to without a known origin', async () => {
    expect(await returnFromBackendSwitch(undefined)).toBe('failed')
    expect(window.location.reload).not.toHaveBeenCalled()
  })
})

describe("the palette's Switch Computer…", () => {
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
    expect(useToastStore.getState().toasts[0]).toMatchObject({ tone: 'error', title: "Couldn't connect to Home Mac" })
  })

  it('shows no error toast for a switch called back with Back that fails late', async () => {
    gate = deferred()
    reachable = false
    render(<BackendSwitchScreen />)
    const home = paletteRows().find((c) => c.label === 'Home Mac')!

    act(() => { void home.action() })
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    gate.resolve()
    await settle()

    expect(screen.queryByRole('status')).toBeNull()
    expect(useToastStore.getState().toasts).toHaveLength(0)
  })
})
