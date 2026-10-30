/**
 * Tests for Settings → About OpenAgentd.
 *
 * 1. Desktop updates UI — the hub exposes the desktop updater card.
 * 2. Header version comes from /api/health and degrades gracefully.
 */

import '@testing-library/jest-dom'

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'

import { queryKeys } from '@/queries'

mock.module('@tanstack/react-router', () => ({
  useNavigate: () => () => {},
}))

let desktopShell = true
const realDesktopShell = await import('@/lib/desktop-shell')
mock.module('@/lib/desktop-shell', () => ({ ...realDesktopShell, isDesktopShell: () => desktopShell }))

import { AboutSettingsPage } from '@/components/settings/pages/settings.index'

function renderHub(health?: { status: string; version: string; capabilities?: string[] }) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      mutations: { retry: false },
    },
  })

  if (health) {
    queryClient.setQueryData(queryKeys.health(), health)
  }

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
  desktopShell = true
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
    desktopShell = false
    renderHub({ status: 'ok', version: '1.2.3' })

    expect(screen.queryByText(/^updates$/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /check for updates?/i })).toBeNull()
  })
})

// ── Header ────────────────────────────────────────────────────────────────

describe('AboutSettingsPage — header', () => {
  it('renders the project name and tagline', () => {
    renderHub({ status: 'ok', version: '1.2.3' })
    expect(screen.getByRole('heading', { name: /about openagentd/i })).toBeInTheDocument()
    expect(screen.getByText(/The coding agent that shows its work/i)).toBeInTheDocument()
  })

  it('appends the health version to the tagline when present', () => {
    renderHub({ status: 'ok', version: '1.2.3' })
    expect(screen.getByText(/The coding agent that shows its work · v1\.2\.3/)).toBeInTheDocument()
  })

  it('omits the version suffix when health has not loaded yet', () => {
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
