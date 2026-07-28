import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import App from '@/App'

const TEST_BACKEND_URL = 'http://10.0.2.2:8000'

let statusPayload: { base_url: string; token?: string | null; external?: boolean; sidecar_running?: boolean; supports_bundled?: boolean; backend_starting?: boolean; backend_failed?: boolean } | null = { base_url: TEST_BACKEND_URL }
let resolveBundledRestart: (() => void) | null = null
interface BackendReadyEvent {
  payload: { base_url: string; token?: string | null }
}
interface BackendErrorEvent {
  payload: { message: string }
}

let backendReadyListener: ((event: BackendReadyEvent) => void) | null = null
let backendErrorListener: ((event: BackendErrorEvent) => void) | null = null
let resolveSecureKey: (() => void) | null = null
let routerMounted = false
const preloadConnectedAppMock = mock(() => {})
let clipboardError: Error | null = null
const writeClipboardMock = mock(async () => {
  if (clipboardError) throw clipboardError
})

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
  if (command === 'app_use_bundled_backend') {
    await new Promise<void>((resolve) => { resolveBundledRestart = resolve })
    return null
  }
  if (command === 'backend_logs_path') return '/tmp/openagentd/backend.log'
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
  const callback = args[1] as ((event: BackendReadyEvent | BackendErrorEvent) => void) | undefined
  if (event === 'backend-ready' && callback) {
    backendReadyListener = callback as (event: BackendReadyEvent) => void
  }
  if (event === 'backend-error' && callback) {
    backendErrorListener = callback as (event: BackendErrorEvent) => void
  }
  return Promise.resolve(() => {
    if (event === 'backend-ready') backendReadyListener = null
    if (event === 'backend-error') backendErrorListener = null
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

mock.module('@/lib/connected-app-preload', () => ({
  preloadConnectedApp: preloadConnectedAppMock,
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
  window.localStorage.clear()
  statusPayload = { base_url: TEST_BACKEND_URL, sidecar_running: true, external: false }
  backendReadyListener = null
  backendErrorListener = null
  resolveSecureKey = null
  resolveBundledRestart = null
  routerMounted = false
  preloadConnectedAppMock.mockClear()
  clipboardError = null
  writeClipboardMock.mockClear()
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: writeClipboardMock },
  })
  invokeMock.mockClear()
})

afterEach(() => {
  cleanup()
  delete window.__OAD_API_BASE_URL__
  delete window.__OAD_TOKEN__
  window.localStorage.clear()
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

  it('starts background preloading after the backend is ready', async () => {
    render(<App />)

    await waitFor(() => expect(routerMounted).toBe(true))
    await waitFor(() => expect(preloadConnectedAppMock).toHaveBeenCalledTimes(1))
  })

  it('hydrates and remembers the active mobile app backend URL on app startup', async () => {
    statusPayload = { base_url: TEST_BACKEND_URL, sidecar_running: false, external: true }
    render(<App />)

    await waitFor(() => {
      expect(window.__OAD_API_BASE_URL__).toBe(TEST_BACKEND_URL)
    })
    expect(window.localStorage.getItem('openagentd.activeBackendUrl')).toBe(TEST_BACKEND_URL)
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

  it('shows recovery immediately when the native shell reports a startup error', async () => {
    statusPayload = { base_url: '', sidecar_running: false, external: false, backend_starting: true }
    render(<App />)
    await waitFor(() => expect(backendErrorListener).not.toBeNull())

    await act(async () => {
      backendErrorListener?.({ payload: { message: 'Sidecar handshake failed' } })
    })

    expect(screen.getByText('OpenAgentd could not start its local backend.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
  })

  it('recovers when startup failed before the webview error listener attached', async () => {
    statusPayload = {
      base_url: '',
      sidecar_running: false,
      backend_starting: false,
      backend_failed: true,
      external: false,
      supports_bundled: true,
    }

    render(<App />)

    await waitFor(() => {
      expect(screen.getByText('OpenAgentd could not start its local backend.')).toBeTruthy()
    })
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
  })

  it('keeps waiting through a slow first-run sidecar startup before offering recovery', async () => {
    const timers = useFakeTimers()
    statusPayload = { base_url: TEST_BACKEND_URL, sidecar_running: false, external: false }

    render(<App />)
    await act(async () => { await Promise.resolve() })
    expect(invokeMock).toHaveBeenCalled()
    await act(async () => { timers.tick(15_000) })

    expect(screen.queryByText('OpenAgentd is taking longer than usual to start.')).toBeNull()

    await act(async () => { timers.tick(45_000) })

    expect(screen.getByText('OpenAgentd is taking longer than usual to start.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Choose Server' })).toBeTruthy()
    timers.restore()
  })

  it('copies the backend log path while the sidecar is still unavailable', async () => {
    statusPayload = { base_url: '', sidecar_running: false, external: false, backend_starting: true }
    render(<App />)
    await waitFor(() => expect(backendErrorListener).not.toBeNull())
    await act(async () => {
      backendErrorListener?.({ payload: { message: 'Sidecar handshake failed' } })
    })

    fireEvent.click(screen.getByRole('button', { name: 'Copy Backend Log Path' }))

    await waitFor(() => expect(writeClipboardMock).toHaveBeenCalledWith('/tmp/openagentd/backend.log'))
    expect(screen.getByRole('button', { name: 'Backend Log Path Copied' })).toBeTruthy()
  })

  it('shows the backend log path when clipboard access fails', async () => {
    clipboardError = new Error('clipboard denied')
    statusPayload = { base_url: '', sidecar_running: false, external: false, backend_failed: true }
    render(<App />)
    await waitFor(() => expect(screen.getByText('OpenAgentd could not start its local backend.')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Copy Backend Log Path' }))

    await waitFor(() => expect(screen.getByRole('button', { name: 'Copy Failed' })).toBeTruthy())
    expect(screen.getByText('/tmp/openagentd/backend.log')).toBeTruthy()
  })

  it('does not start a duplicate bundled sidecar while startup is in progress', async () => {
    const timers = useFakeTimers()
    statusPayload = {
      base_url: '',
      sidecar_running: false,
      backend_starting: true,
      external: false,
      supports_bundled: true,
    }
    render(<App />)
    await act(async () => { await Promise.resolve() })
    await act(async () => { timers.tick(60_000) })

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(invokeMock.mock.calls.some((call) => call[0] === 'app_use_bundled_backend')).toBe(false)
    timers.restore()
  })

  it('restarts a failed bundled sidecar from the recovery screen', async () => {
    const timers = useFakeTimers()
    statusPayload = {
      base_url: TEST_BACKEND_URL,
      sidecar_running: false,
      external: false,
      supports_bundled: true,
    }
    render(<App />)
    await act(async () => { await Promise.resolve() })
    await act(async () => { timers.tick(60_000) })

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await act(async () => { await Promise.resolve() })
    expect(invokeMock.mock.calls.some((call) => call[0] === 'app_use_bundled_backend')).toBe(true)
    expect(screen.getByRole('button', { name: 'Restarting…' }).hasAttribute('disabled')).toBe(true)

    statusPayload = { base_url: TEST_BACKEND_URL, sidecar_running: true, external: false }
    await act(async () => { resolveBundledRestart?.(); await Promise.resolve(); await Promise.resolve() })
    expect(window.__OAD_API_BASE_URL__).toBe(TEST_BACKEND_URL)
    timers.restore()
  })

  it('retries bootstrap and opens server selection from recovery', async () => {
    const timers = useFakeTimers()
    statusPayload = { base_url: TEST_BACKEND_URL, sidecar_running: false, external: false }
    render(<App />)
    await act(async () => { await Promise.resolve() })
    expect(invokeMock).toHaveBeenCalled()
    await act(async () => { timers.tick(60_000) })

    fireEvent.click(screen.getByRole('button', { name: 'Choose Server' }))
    expect(screen.getByRole('dialog').textContent).toBe('Server chooser')

    statusPayload = { base_url: TEST_BACKEND_URL, sidecar_running: true, external: false }
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(window.__OAD_API_BASE_URL__).toBe(TEST_BACKEND_URL)
    timers.restore()
  })
})
