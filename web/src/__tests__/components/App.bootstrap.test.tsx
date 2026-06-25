import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, waitFor } from '@testing-library/react'
import App from '@/App'

const TEST_BACKEND_URL = 'http://10.0.2.2:8000'

let statusPayload: { base_url: string; token?: string | null; external?: boolean; sidecar_running?: boolean } | null = { base_url: TEST_BACKEND_URL }
interface BackendReadyEvent {
  payload: { base_url: string; token?: string | null }
}

let backendReadyListener: ((event: BackendReadyEvent) => void) | null = null

const invokeMock = mock(async (...args: unknown[]) => {
  const command = String(args[0])
  if (command === 'app_backend_status') return statusPayload
  throw new Error(`unexpected command: ${command}`)
})

mock.module('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}))

const listenMock = mock((...args: unknown[]) => {
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

mock.module('@tanstack/react-router', () => ({
  RouterProvider: () => null,
}))

mock.module('@/components/UpdateCard', () => ({
  UpdateCard: () => null,
}))

mock.module('@/hooks/use-platform', () => ({
  getPlatform: () => ({ isTauri: true, os: 'macos', isMacOverlay: true }),
}))

beforeEach(() => {
  delete window.__OAD_API_BASE_URL__
  delete window.__OAD_TOKEN__
  statusPayload = { base_url: TEST_BACKEND_URL, sidecar_running: true, external: false }
  backendReadyListener = null
  invokeMock.mockClear()
})

afterEach(() => {
  cleanup()
  delete window.__OAD_API_BASE_URL__
  delete window.__OAD_TOKEN__
})

describe('App backend bootstrap', () => {
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

  it('does not finish bootstrap for bundled desktop mode until the sidecar is running', async () => {
    statusPayload = { base_url: TEST_BACKEND_URL, sidecar_running: false, external: false }

    const { queryByText } = render(<App />)

    await waitFor(() => expect(invokeMock).toHaveBeenCalled())
    expect(queryByText('Loading OpenAgentd...')).toBeTruthy()
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
})
