/**
 * A server switch that is still under way ends in a reload (or is called
 * off). Until then the app must not start on this page: the router would
 * mount, take the session a tap left for the reloaded page and mark links
 * as handled, and the reload would throw all of it away.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'

const realPlatform = await import('@/hooks/use-platform')
const phone = { isTauri: true, os: 'ios', isMacOverlay: false, isFullscreen: false }
mock.module('@/hooks/use-platform', () => ({ ...realPlatform, getPlatform: () => phone, usePlatform: () => phone }))
mock.module('@/lib/connected-app-preload', () => ({ preloadConnectedApp: () => undefined }))

const BRIDGE = 'http://127.0.0.1:5999'
let statusReads = 0
mock.module('@tauri-apps/api/core', () => ({
  invoke: async (command: string) => {
    if (command === 'app_backend_status') {
      statusReads += 1
      return { base_url: BRIDGE, external: true, sidecar_running: false, supports_bundled: false, servers: [] }
    }
    if (command === 'secure_get_access_key') return null
    throw new Error(`unexpected command: ${command}`)
  },
}))
mock.module('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({ listen: async () => () => {} }),
}))

const { setApiBaseUrl } = await import('@/api/base-url')
const { useAppBackendBootstrap } = await import('@/hooks/use-app-backend-bootstrap')
const { resetAppStart, startAppHere } = await import('@/lib/app-start')
const { beginBackendSwitch, endBackendSwitch, useBackendSwitchStore } = await import('@/stores/useBackendSwitchStore')

beforeEach(() => {
  statusReads = 0
  resetAppStart()
  window.localStorage.clear()
  window.sessionStorage.clear()
  useBackendSwitchStore.setState({ target: null, generation: 0, committing: false })
})

afterEach(() => {
  cleanup()
  setApiBaseUrl('/api')
})

describe('starting the app while a server switch is under way', () => {
  it('waits for the switch: the page is about to reload onto the new server', async () => {
    const switching = beginBackendSwitch({ name: 'studio-mini' })
    const { result } = renderHook(() => useAppBackendBootstrap())
    // The shell already names the new server.
    await waitFor(() => expect(statusReads).toBeGreaterThan(1))
    expect(result.current.ready).toBe(false)

    // Called off or failed (no reload follows): the app starts on what the shell names.
    endBackendSwitch(switching)
    await waitFor(() => expect(result.current.ready).toBe(true))
  })

  it('starts at once when no switch is under way', async () => {
    const { result } = renderHook(() => useAppBackendBootstrap())
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(statusReads).toBe(1)
  })

  it('starts when the switch asks: the app had not started here, so nothing needs a reload', async () => {
    beginBackendSwitch({ name: 'studio-mini' })
    const { result } = renderHook(() => useAppBackendBootstrap())
    await waitFor(() => expect(statusReads).toBeGreaterThan(0))
    expect(result.current.ready).toBe(false)

    let started = false
    await act(async () => { started = await startAppHere() })
    expect(started).toBe(true)
    expect(result.current.ready).toBe(true)
    expect(window.__OAD_API_BASE_URL__).toBe(BRIDGE)
  })

  it('leaves a switch to reload once the app has started on this page', async () => {
    const { result } = renderHook(() => useAppBackendBootstrap())
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(await startAppHere()).toBe(false)
  })
})
