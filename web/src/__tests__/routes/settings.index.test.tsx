/**
 * Tests for Settings → About OpenAgentd.
 *
 * 1. Updates UI — the desktop and mobile shells expose the updater card.
 * 2. Version section — client and server versions, with a skew warning.
 * 3. Header version is the client's, falling back to the server's.
 */

import '@testing-library/jest-dom'

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { queryKeys } from '@/queries'

mock.module('@tanstack/react-router', () => ({
  useNavigate: () => () => {},
}))

let platform: { isTauri: boolean; os: string } = { isTauri: true, os: 'macos' }
let shellVersion: string | undefined = '1.2.3'
const realPlatform = await import('@/hooks/use-platform')
mock.module('@/hooks/use-platform', () => ({
  ...realPlatform,
  getPlatform: () => ({ isMacOverlay: false, isFullscreen: false, ...platform }),
}))
mock.module('@tauri-apps/api/app', () => ({
  getVersion: async () => {
    if (!shellVersion) throw new Error('no shell')
    return shellVersion
  },
}))

const updaterCalls: string[] = []
let checkResult: Record<string, unknown> = { status: 'up_to_date', current_version: '1.2.3' }
mock.module('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string) => {
    updaterCalls.push(cmd)
    if (cmd === 'updater_check') return checkResult
    if (cmd === 'app_backend_status') return { base_url: 'http://10.0.0.2:8000' }
    return undefined
  },
}))

import { AboutSettingsPage } from '@/components/settings/pages/settings.index'

function renderHub(health?: { status: string; version: string; capabilities?: string[] }, seed?: (client: QueryClient) => void) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      mutations: { retry: false },
    },
  })

  if (health) {
    queryClient.setQueryData(queryKeys.health(), health)
  }
  seed?.(queryClient)

  const result = render(
    <QueryClientProvider client={queryClient}>
      <AboutSettingsPage />
    </QueryClientProvider>,
  )

  return {
    ...result,
    unmount: () => { result.unmount(); queryClient.clear() },
  }
}

let originalFetch: typeof fetch | undefined

beforeEach(() => {
  platform = { isTauri: true, os: 'macos' }
  shellVersion = '1.2.3'
  updaterCalls.length = 0
  checkResult = { status: 'up_to_date', current_version: '1.2.3' }
  originalFetch = globalThis.fetch
  globalThis.fetch = (() =>
    Promise.reject(new Error('network disabled in test'))) as typeof fetch
})

afterEach(() => {
  if (originalFetch) globalThis.fetch = originalFetch
  originalFetch = undefined
})

// ── Desktop updates card ──────────────────────────────────────────────────

describe('AboutSettingsPage — desktop updates card', () => {
  it('renders desktop update controls without the old Application update heading', () => {
    renderHub({ status: 'ok', version: '1.2.3' })

    expect(screen.getByText(/^updates$/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /check for updates?/i })).toBeInTheDocument()
    expect(screen.queryByText(/application update/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /^install$/i })).toBeNull()
  })

  it('hides desktop updates in the browser build, where there is no updater', () => {
    platform = { isTauri: false, os: 'macos' }
    renderHub({ status: 'ok', version: '1.2.3' })

    expect(screen.queryByText(/^updates$/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /check for updates?/i })).toBeNull()
  })

  it('shows updates in the Android shell too', () => {
    platform = { isTauri: true, os: 'android' }
    renderHub({ status: 'ok', version: '1.2.3' })
    expect(screen.getByRole('button', { name: /check for updates?/i })).toBeInTheDocument()
  })

  it('has no updates section on iOS (TestFlight and the App Store update it)', () => {
    platform = { isTauri: true, os: 'ios' }
    renderHub({ status: 'ok', version: '1.2.3' })
    expect(screen.queryByRole('button', { name: /check for updates?/i })).toBeNull()
    expect(updaterCalls).not.toContain('updater_check')
  })

  it('says how to update on Linux instead of a check that cannot find a release', () => {
    platform = { isTauri: true, os: 'linux' }
    renderHub({ status: 'ok', version: '1.2.3' })
    expect(screen.queryByRole('button', { name: /check for updates?/i })).toBeNull()
    expect(screen.getByText(/install the newer \.deb/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open releases page' })).toBeInTheDocument()
    expect(updaterCalls).not.toContain('updater_check')
  })

  it('keeps the Linux update line out of every other app', () => {
    for (const os of ['macos', 'windows', 'android', 'ios']) {
      platform = { isTauri: true, os }
      const { unmount } = renderHub({ status: 'ok', version: '1.2.3' })
      expect(screen.queryByText(/install the newer \.deb/i)).toBeNull()
      unmount()
    }
  })

  it('downloads, then asks before installing the APK on Android', async () => {
    platform = { isTauri: true, os: 'android' }
    checkResult = { status: 'available', version: '1.3.0', current_version: '1.2.3', channel: 'apk' }
    renderHub({ status: 'ok', version: '1.2.3' })
    fireEvent.click(screen.getByRole('button', { name: /check for updates?/i }))
    expect(await screen.findByRole('button', { name: /^download$/i })).toBeInTheDocument()
  })
})

// ── Version section ───────────────────────────────────────────────────────

describe('AboutSettingsPage — version section', () => {
  it('shows the client and server versions', async () => {
    shellVersion = '1.2.3'
    renderHub({ status: 'ok', version: '1.2.3' })
    expect(screen.getAllByText('Desktop app').length).toBeGreaterThan(0)
    await waitFor(() => expect(screen.getAllByText('v1.2.3')).toHaveLength(2))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('warns when the server is a minor version behind the app', async () => {
    platform = { isTauri: true, os: 'android' }
    shellVersion = '1.3.0'
    renderHub({ status: 'ok', version: '1.2.9' })
    expect(await screen.findByRole('alert')).toHaveTextContent(/server is older than this app/i)
    expect(screen.getAllByText('Android app').length).toBeGreaterThan(0)
  })

  it('warns when the app is behind the server', async () => {
    shellVersion = '1.2.0'
    renderHub({ status: 'ok', version: '2.0.0' })
    expect(await screen.findByRole('alert')).toHaveTextContent(/app is older than the server/i)
  })

  it('names where an older app gets its update, per platform', async () => {
    const advice: Array<[string, RegExp]> = [
      ['ios', /Update it from TestFlight or the App Store/],
      ['linux', /Install the newer \.deb/],
      ['macos', /Update the app/],
      ['android', /Update the app/],
    ]
    for (const [os, text] of advice) {
      platform = { isTauri: true, os }
      shellVersion = '1.2.0'
      const { unmount } = renderHub({ status: 'ok', version: '2.0.0' })
      expect(await screen.findByRole('alert')).toHaveTextContent(text)
      unmount()
    }
  })

  it('only notes a patch difference', async () => {
    shellVersion = '1.2.4'
    renderHub({ status: 'ok', version: '1.2.3' })
    expect(await screen.findByText(/patch versions differ/i)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('says not connected without a server version', () => {
    renderHub()
    expect(screen.getByText('not connected')).toBeInTheDocument()
  })

  it('offers the server update from another device, and leaves the desktop app’s own server to Updates', async () => {
    const health = { status: 'ok', version: '1.2.3', capabilities: ['api.server_update'] }
    const update = {
      current: '1.2.3', latest: '1.3.0', available: true, can_upgrade: true, method: 'desktop_app', reason: null, check_error: null,
      in_progress: false, release_url: null, log: '', last: null,
    }
    const on = (backend: Record<string, unknown>) => (client: QueryClient) => {
      client.setQueryData(queryKeys.serverUpdate(), update)
      client.setQueryData(queryKeys.backendStatus(), backend)
    }

    // A phone on a computer's desktop app.
    platform = { isTauri: true, os: 'android' }
    const phone = renderHub(health, on({ base_url: 'http://192.168.1.20:4082', external: true, mode: 'external' }))
    expect(await screen.findByRole('button', { name: 'Update to v1.3.0' })).toBeInTheDocument()
    phone.unmount()

    // The desktop app on its own built-in server.
    platform = { isTauri: true, os: 'macos' }
    renderHub(health, on({ base_url: 'http://127.0.0.1:51000', external: false, mode: 'bundled' }))
    expect(await screen.findByText('v1.3.0 is out. This server comes with this app: update the app to update it.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Update to/ })).toBeNull()
  })
})

// ── Header ────────────────────────────────────────────────────────────────

describe('AboutSettingsPage — header', () => {
  it('renders the project name and tagline', () => {
    renderHub({ status: 'ok', version: '1.2.3' })
    expect(screen.getByRole('heading', { name: /about openagentd/i })).toBeInTheDocument()
    expect(screen.getByText(/The coding agent that shows its work/i)).toBeInTheDocument()
  })

  it('appends the app version to the tagline', async () => {
    shellVersion = '1.4.0'
    renderHub({ status: 'ok', version: '1.2.3' })
    expect(await screen.findByText(/The coding agent that shows its work · v1\.4\.0/)).toBeInTheDocument()
  })

  it('falls back to the server version when the app version is unknown', () => {
    platform = { isTauri: false, os: 'macos' }
    renderHub({ status: 'ok', version: '1.2.3' })
    expect(screen.getByText(/The coding agent that shows its work · v1\.2\.3/)).toBeInTheDocument()
  })

  it('omits the version suffix when no version is known yet', () => {
    platform = { isTauri: false, os: 'macos' }
    renderHub() // No health seed.
    expect(screen.getByText(/The coding agent that shows its work/i)).toBeInTheDocument()
    expect(screen.queryByText(/The coding agent that shows its work ·/)).toBeNull()
  })
})

// ── Community & Support ───────────────────────────────────────────────────

describe('AboutSettingsPage — community links', () => {
  it('renders Discord Server and Facebook Group community buttons', () => {
    renderHub({ status: 'ok', version: '1.2.3' })

    expect(screen.getByText(/community and support/i)).toBeInTheDocument()
    expect(screen.getByText(/discord server/i)).toBeInTheDocument()
    expect(screen.getByText(/facebook group/i)).toBeInTheDocument()
  })

  it('opens openagentd.dev from the Website card', () => {
    const openedUrls: string[] = []
    const originalOpen = window.open
    window.open = ((url?: string | URL) => { openedUrls.push(String(url)); return null }) as typeof window.open
    try {
      renderHub({ status: 'ok', version: '1.2.3' })
      fireEvent.click(screen.getByRole('button', { name: /^website/i }))
      expect(openedUrls).toEqual(['https://openagentd.dev'])
    } finally {
      window.open = originalOpen
    }
  })
})
