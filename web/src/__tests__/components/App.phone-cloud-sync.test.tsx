/**
 * A tapped "A device wants to join" must open the approval sheet even
 * before any server answers: the phone may be the account's first device.
 * Before the router is up the app mounts the account sync itself; once it is
 * up only the root route does (so never twice).
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'

const phone = { isTauri: true, os: 'ios', isMacOverlay: false, isFullscreen: false }
const realPlatform = await import('@/hooks/use-platform')
mock.module('@/hooks/use-platform', () => ({ ...realPlatform, getPlatform: () => phone, usePlatform: () => phone }))
mock.module('@/hooks/use-is-phone', () => ({ useIsPhone: () => true }))

let ready = false
mock.module('@/hooks/use-app-backend-bootstrap', () => ({
  useAppBackendBootstrap: () => ({ ready, unavailable: false, failed: false, retrying: false, retry: () => {} }),
}))
mock.module('@/hooks/useConnectLink', () => ({ useConnectLink: () => ({ request: null, clear: () => {} }) }))
mock.module('@/components/AppBackendDialog', () => ({ AppBackendDialog: () => null }))
mock.module('@/components/phone/LazyServersScreen', () => ({ ServersScreen: () => null }))
const realAppBackend = await import('@/lib/app-backend')
mock.module('@/lib/app-backend', () => ({ ...realAppBackend, getAppBackendStatus: async () => null }))
// The root route (which mounts its own sync) is not rendered here.
const realRouter = await import('@tanstack/react-router')
mock.module('@tanstack/react-router', () => ({ ...realRouter, RouterProvider: () => null }))
mock.module('@/hooks/use-phone-cloud-sync', () => ({ PhoneCloudSync: () => <div data-testid="phone-cloud-sync" /> }))
let fallbacks = 0
mock.module('@/lib/account-lan-fallback', () => ({ fallBackToAccountOnce: async () => { fallbacks += 1; return 'skipped' } }))

const { default: App } = await import('@/App')

afterEach(() => {
  cleanup()
})

describe('the account sync on the phone', () => {
  it('runs before any server is connected', async () => {
    ready = false
    render(<App />)
    expect(await screen.findByTestId('phone-cloud-sync')).toBeTruthy()
  })

  it('is left to the root route once the app is up', async () => {
    ready = true
    render(<App />)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(screen.queryByTestId('phone-cloud-sync')).toBeNull()
  })
})

describe('the launch fallback to the account', () => {
  it('is asked for once when the app starts on the phone', async () => {
    fallbacks = 0
    ready = false
    render(<App />)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fallbacks).toBe(1)
  })
})
