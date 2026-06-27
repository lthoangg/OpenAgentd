/**
 * Tests for the Settings hub landing page (the "About" section in the modal).
 *
 * 1. Desktop updates UI — the hub exposes the desktop updater card.
 * 2. Header version comes from /api/health and degrades gracefully.
 */

import '@testing-library/jest-dom'

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'

import { queryKeys } from '@/queries'

mock.module('@tanstack/react-router', () => ({
  useNavigate: () => () => {},
}))

import { SettingsHubPage } from '@/routes/settings.index'

function renderHub(health?: { status: string; version: string }) {
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
      <SettingsHubPage />
    </QueryClientProvider>,
  )

  return {
    ...result,
    unmount: () => { result.unmount(); queryClient.clear() },
  }
}

let originalFetch: typeof fetch | undefined

beforeEach(() => {
  originalFetch = globalThis.fetch
  globalThis.fetch = (() =>
    Promise.reject(new Error('network disabled in test'))) as typeof fetch
})

afterEach(() => {
  if (originalFetch) globalThis.fetch = originalFetch
  originalFetch = undefined
})

// ── Desktop updates card ──────────────────────────────────────────────────

describe('SettingsHubPage — desktop updates card', () => {
  it('renders desktop update controls without the old Application update heading', () => {
    renderHub({ status: 'ok', version: '1.2.3' })

    expect(screen.getByText(/^updates$/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /check for updates?/i })).toBeInTheDocument()
    expect(screen.queryByText(/application update/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /^install$/i })).toBeNull()
  })
})

// ── Header ────────────────────────────────────────────────────────────────

describe('SettingsHubPage — header', () => {
  it('renders the project name and tagline', () => {
    renderHub({ status: 'ok', version: '1.2.3' })
    expect(screen.getByRole('heading', { name: /about openagentd/i })).toBeInTheDocument()
    expect(screen.getByText(/On-machine AI assistant/i)).toBeInTheDocument()
  })

  it('appends the health version to the tagline when present', () => {
    renderHub({ status: 'ok', version: '1.2.3' })
    expect(screen.getByText(/On-machine AI assistant · v1\.2\.3/)).toBeInTheDocument()
  })

  it('omits the version suffix when health has not loaded yet', () => {
    renderHub() // No health seed.
    expect(screen.getByText(/On-machine AI assistant/i)).toBeInTheDocument()
    expect(screen.queryByText(/On-machine AI assistant ·/)).toBeNull()
  })
})
