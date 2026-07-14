import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import App from '@/App'

const TEST_BACKEND_URL = 'http://10.0.2.2:8000'

let statusPayload: { base_url: string; token?: string | null; external?: boolean; sidecar_running?: boolean } | null = { base_url: TEST_BACKEND_URL }
interface BackendReadyEvent {
  payload: { base_url: string; token?: string | null }
}

let backendReadyListener: ((event: BackendReadyEvent) => void) | null = null
let resolveSecureKey: (() => void) | null = null
let routerMounted = false

function useFakeTimers() {
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  const realDateNow = Date.now
  let now = 0
  let sequence = 0
  const timers = new Map<number, { callback: () => void; due: number }>()

  globalThis.setTimeout = ((callback: TimerHandler, delay?: number) => {
    const id = ++sequence
    timers.set(id, { callback: callback as () => void, due: now + (delay ?? 0) })
    return id as unknown as ReturnType<typeof setTimeout>
  }) as unknown as typeof setTimeout
  globalThis.clearTimeout = ((id: number) => { timers.delete(id) }) as typeof clearTimeout
  Date.now = () => now

  return {
    tick(ms: number) {
      now += ms
      for (const [id, timer] of [...timers]) {
        if (timer.due <= now) {
          timers.delete(id)
          timer.callback()
        }
      }
    },
    restore() {
      globalThis.setTimeout = realSetTimeout
      globalThis.clearTimeout = realClearTimeout
      Date.now = realDateNow
    },
  }
}

const invokeMock = mock(async (...args: unknown[]) => {
  const command = String(args[0])
  if (command === 'app_backend_status') return statusPayload
  if (command === 'secure_get_access_key') {
    await new Promise<void>((resolve) => { resolveSecureKey = resolve })
    return 'secure-key'
  }
  throw new Error(`unexpected command: ${command}`)
})

mock.module('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}))

// The broadcast `listen()` from `@tauri-apps/api/event` must NOT be used for
// `backend-ready` — it registers with `target: { kind: 'Any' }`, which every
// window's emit matches regardless of which window Rust targeted. Only
// `getCurrentWebviewWindow().listen(...)` (window-scoped target) should
// receive it. This mock intentionally does not wire `backend-ready` through
// the broadcast `listen`, so a regression back to the broadcast API would
// leave `backendReadyListener` unset and fail the readiness test below.
const listenMock = mock(() => {
  return Promise.resolve(() => {})
})

const windowListenMock = mock((...args: unknown[]) => {
  const event = String(args[0])
  const callback = args[1] as ((event: BackendReadyEvent) => void) | undefined
  if (event === 'backend-ready' && callback) backendReadyListener = callback
  return Promise.resolve(() => {
    backendReadyListener = null
  })
})

mock.module('@tauri-apps/api/event', () => ({
  listen: listenMock,
}))

mock.module('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({ listen: windowListenMock }),
}))

mock.module('@tanstack/react-router', () => ({
  RouterProvider: () => { routerMounted = true; return null },
}))

mock.module('@/components/UpdateCard', () => ({
  UpdateCard: () => null,
}))

mock.module('@/components/AppBackendDialog', () => ({
  AppBackendDialog: ({ open }: { open: boolean }) => open ? <div role="dialog">Server chooser</div> : null,
}))

mock.module('@/hooks/use-platform', () => ({
  getPlatform: () => ({ isTauri: true, os: 'macos', isMacOverlay: true }),
}))

beforeEach(() => {
  delete window.__OAD_API_BASE_URL__
  delete window.__OAD_TOKEN__
  statusPayload = { base_url: TEST_BACKEND_URL, sidecar_running: true, external: false }
  backendReadyListener = null
  resolveSecureKey = null
  routerMounted = false
  invokeMock.mockClear()
})

afterEach(() => {
  cleanup()
  delete window.__OAD_API_BASE_URL__
  delete window.__OAD_TOKEN__
})

describe('App backend bootstrap', () => {
  it('waits for an external backend credential before mounting the router', async () => {
    statusPayload = { base_url: TEST_BACKEND_URL, external: true, sidecar_running: false }
    render(<App />)

    await waitFor(() => expect(resolveSecureKey).not.toBeNull())
    expect(routerMounted).toBe(false)
    await act(async () => resolveSecureKey?.())
    await waitFor(() => expect(routerMounted).toBe(true))
  })

  it('hydrates the active mobile app backend URL on app startup', async () => {
    render(<App />)

    await waitFor(() => {
      expect(window.__OAD_API_BASE_URL__).toBe(TEST_BACKEND_URL)
    })
  })

  it('hydrates the desktop token after a force reload page load', async () => {
    statusPayload = { base_url: TEST_BACKEND_URL, token: 'desktop-token', sidecar_running: true, external: false }

    render(<App />)

    await waitFor(() => {
      expect(window.__OAD_API_BASE_URL__).toBe(TEST_BACKEND_URL)
      expect(window.__OAD_TOKEN__).toBe('desktop-token')
    })
  })

  it('clears a stale bundled token before activating an external backend', async () => {
    window.__OAD_TOKEN__ = 'stale-bundled-token'
    statusPayload = { base_url: 'http://192.168.1.20:4082', external: true, sidecar_running: false }

    render(<App />)

    await waitFor(() => {
      expect(window.__OAD_API_BASE_URL__).toBe('http://192.168.1.20:4082')
      expect(window.__OAD_TOKEN__).toBeUndefined()
    })
  })

  it('leaves the default web API base URL when no app backend is configured', async () => {
    statusPayload = null

    render(<App />)

    await waitFor(() => expect(invokeMock).toHaveBeenCalled())
    expect(window.__OAD_API_BASE_URL__).toBeUndefined()
  })

  it('hydrates the backend URL when desktop reports readiness after the window opens', async () => {
    statusPayload = { base_url: '', sidecar_running: false, external: false }

    render(<App />)

    await waitFor(() => expect(invokeMock).toHaveBeenCalled())
    expect(window.__OAD_API_BASE_URL__).toBeUndefined()

    backendReadyListener?.({ payload: { base_url: TEST_BACKEND_URL, token: 'ready-token' } })

    await waitFor(() => {
      expect(window.__OAD_API_BASE_URL__).toBe(TEST_BACKEND_URL)
      expect(window.__OAD_TOKEN__).toBe('ready-token')
    })
  })

  it('listens for backend-ready on this window only, never via the app-wide broadcast listener', async () => {
    // Regression guard for the two-window bug: switching window B's backend
    // must not affect window A. `getCurrentWebviewWindow().listen(...)`
    // registers a window-scoped target that Tauri's event filter respects;
    // the generic `listen()` from `@tauri-apps/api/event` registers
    // `target: { kind: 'Any' }` and would receive every window's emit.
    render(<App />)

    await waitFor(() => expect(backendReadyListener).not.toBeNull())
    expect(listenMock).not.toHaveBeenCalledWith('backend-ready', expect.anything())
  })

  it('does not finish bootstrap for bundled desktop mode until the sidecar is running', async () => {
    statusPayload = { base_url: TEST_BACKEND_URL, sidecar_running: false, external: false }

    render(<App />)

    await waitFor(() => expect(invokeMock).toHaveBeenCalled())
    expect(document.querySelector('[aria-label="Loading OpenAgentd"]')).toBeTruthy()
    expect(window.__OAD_API_BASE_URL__).toBeUndefined()

    statusPayload = { base_url: TEST_BACKEND_URL, sidecar_running: true, external: false, token: 'desktop-token' }

    await waitFor(() => {
      expect(window.__OAD_API_BASE_URL__).toBe(TEST_BACKEND_URL)
      expect(window.__OAD_TOKEN__).toBe('desktop-token')
    })
  })

  it('allows external desktop backends to bootstrap without waiting for a sidecar', async () => {
    statusPayload = { base_url: 'http://192.168.1.20:4082', sidecar_running: false, external: true }

    render(<App />)

    await waitFor(() => {
      expect(window.__OAD_API_BASE_URL__).toBe('http://192.168.1.20:4082')
    })
  })

  it('offers recovery after the bundled sidecar exceeds the eager splash timeout', async () => {
    const timers = useFakeTimers()
    statusPayload = { base_url: TEST_BACKEND_URL, sidecar_running: false, external: false }

    render(<App />)
    await act(async () => { await Promise.resolve() })
    expect(invokeMock).toHaveBeenCalled()
    await act(async () => { timers.tick(15_000) })

    expect(screen.getByText('OpenAgentd is taking longer than usual to start.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Choose Server' })).toBeTruthy()
    timers.restore()
  })

  it('retries bootstrap and opens server selection from recovery', async () => {
    const timers = useFakeTimers()
    statusPayload = { base_url: TEST_BACKEND_URL, sidecar_running: false, external: false }
    render(<App />)
    await act(async () => { await Promise.resolve() })
    expect(invokeMock).toHaveBeenCalled()
    await act(async () => { timers.tick(15_000) })

    fireEvent.click(screen.getByRole('button', { name: 'Choose Server' }))
    expect(screen.getByRole('dialog').textContent).toBe('Server chooser')

    statusPayload = { base_url: TEST_BACKEND_URL, sidecar_running: true, external: false }
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(window.__OAD_API_BASE_URL__).toBe(TEST_BACKEND_URL)
    timers.restore()
  })
})
