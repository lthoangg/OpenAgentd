/**
 * On desktop the connection banner also offers a way back (desktop mockup
 * 12.2): Retry checks now, and the desktop app can start (or switch to) its
 * built-in server. A phone keeps its one action, Change server.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const refetch = mock(() => Promise.resolve())
let status: Record<string, unknown> = {}
let isPhone = false
mock.module('@/hooks/use-is-phone', () => ({ useIsPhone: () => isPhone }))
mock.module('@/queries/useHealthQuery', () => ({
  useHealthQuery: () => ({ isSuccess: false, isError: true, isPending: false, refetch }),
  useBackendStatusQuery: () => ({ data: status }),
}))
const connectBundledBackend = mock(async () => ({ ok: true, status: null, reload: false }))
mock.module('@/lib/backend-switch', () => ({ connectBundledBackend }))
mock.module('@/components/AppBackendDialog', () => ({ AppBackendDialog: () => null }))

const { ConnectionBanner } = await import('@/components/ConnectionBanner')

const BUNDLED = { mode: 'bundled', base_url: 'http://127.0.0.1:4082', sidecar_running: false, external: false, supports_bundled: true, servers: [] }

beforeEach(() => {
  isPhone = false
  status = BUNDLED
  refetch.mockClear()
  connectBundledBackend.mockClear()
})
afterEach(cleanup)

describe('ConnectionBanner on desktop', () => {
  it('checks again at once from Retry', () => {
    render(<ConnectionBanner />)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(refetch).toHaveBeenCalledTimes(1)
  })

  it('starts the built-in server when it is not running', async () => {
    render(<ConnectionBanner />)
    fireEvent.click(screen.getByRole('button', { name: 'Start built-in server' }))
    await waitFor(() => expect(connectBundledBackend).toHaveBeenCalledTimes(1))
  })

  it('offers the built-in server when a remote one is down', () => {
    status = { ...BUNDLED, mode: 'external', base_url: 'http://192.168.1.20:8000', external: true, sidecar_running: false }
    render(<ConnectionBanner />)
    expect(screen.getByRole('button', { name: 'Use built-in server' })).toBeTruthy()
  })

  it('only retries a built-in server that is already running', () => {
    status = { ...BUNDLED, sidecar_running: true }
    render(<ConnectionBanner />)
    expect(screen.queryByRole('button', { name: /built-in server/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
  })

  it('offers nothing built-in outside the desktop app', () => {
    status = { ...BUNDLED, supports_bundled: false }
    render(<ConnectionBanner />)
    expect(screen.queryByRole('button', { name: /built-in server/ })).toBeNull()
  })

  it('keeps a phone to one action', () => {
    isPhone = true
    render(<ConnectionBanner />)
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(['Change server'])
  })
})
