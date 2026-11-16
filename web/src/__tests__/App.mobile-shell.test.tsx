/**
 * The loading screen and the first-run server dialog render before the
 * router's root route, so the mobile shell's viewport guards (fixed layout,
 * keyboard tracking, no chrome selection) must already be on there.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render } from '@testing-library/react'
import App from '@/App'

mock.module('@/hooks/use-platform', () => ({
  getPlatform: () => ({ isTauri: true, os: 'ios', isMacOverlay: false, isFullscreen: false }),
  usePlatform: () => ({ isTauri: true, os: 'ios', isMacOverlay: false, isFullscreen: false }),
}))

mock.module('@/hooks/use-app-backend-bootstrap', () => ({
  useAppBackendBootstrap: () => ({ ready: false, unavailable: true, failed: false, retrying: false, retry: () => {} }),
}))

mock.module('@/hooks/useConnectLink', () => ({
  useConnectLink: () => ({ request: null, clear: () => {} }),
}))

mock.module('@/components/AppBackendDialog', () => ({
  AppBackendDialog: () => null,
}))

mock.module('@tanstack/react-router', () => ({
  RouterProvider: () => null,
}))

afterEach(() => {
  cleanup()
})

describe('App before the backend is ready', () => {
  it('turns on the mobile shell guards for the loading screen', () => {
    render(<App />)

    expect(document.documentElement.getAttribute('data-mobile-shell')).toBe('ios')
  })

  it('turns them off again when the app unmounts', () => {
    const { unmount } = render(<App />)
    unmount()

    expect(document.documentElement.hasAttribute('data-mobile-shell')).toBe(false)
  })
})
