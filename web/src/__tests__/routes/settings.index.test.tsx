/**
 * Tests for the Settings hub landing page (``/settings``).
 *
 * Two contracts guarded here:
 *
 * 1. **Desktop updates UI.** The old PyPI-backed self-update card was removed;
 *    the hub now exposes the desktop updater card for Tauri builds.
 *
 * 2. **Header version comes from ``/api/health``** and degrades gracefully
 *    when health is still loading.
 *
 * 3. **Mobile** mounts nav cards with counts pulled from the per-resource
 *    queries; desktop does not (the sidebar already handles navigation).
 */

import '@testing-library/jest-dom'

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'

import { queryKeys } from '@/queries'

// ── Router mocks ─────────────────────────────────────────────────────────────
//
// The hub uses ``Link`` from tanstack-router. Render it as a plain anchor
// so the test doesn't need a router context.

mock.module('@tanstack/react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode; [k: string]: unknown }) => (
    <a href={to} {...rest}>{children}</a>
  ),
  useLocation: () => ({ pathname: '/settings' }),
  useNavigate: () => () => {},
}))

// Each test toggles this; declared at module level so the mock factory below
// can read it dynamically.
let isMobileFlag = false

mock.module('@/hooks/use-mobile', () => ({
  useIsMobile: () => isMobileFlag,
}))

import { SettingsHubPage } from '@/routes/settings.index'

// ── Render helper ────────────────────────────────────────────────────────────

interface Seed {
  health?: { status: string; version: string }
  agents?: number
  skills?: number
  mcp?: number
  providersConfigured?: number
  providersTotal?: number
  sandboxPatterns?: number
}

function renderHub(seed: Seed = {}) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      mutations: { retry: false },
    },
  })

  if (seed.health) {
    queryClient.setQueryData(queryKeys.health(), seed.health)
  }
  if (seed.agents !== undefined) {
    queryClient.setQueryData(queryKeys.agentFiles.list(), {
      agents: Array.from({ length: seed.agents }, (_, i) => ({ name: `agent-${i}` })),
    })
  }
  if (seed.skills !== undefined) {
    queryClient.setQueryData(queryKeys.skillFiles.list(), {
      skills: Array.from({ length: seed.skills }, (_, i) => ({ name: `skill-${i}` })),
    })
  }
  if (seed.mcp !== undefined) {
    queryClient.setQueryData(queryKeys.mcp.list(), {
      servers: Array.from({ length: seed.mcp }, (_, i) => ({ name: `server-${i}` })),
    })
  }
  if (seed.providersConfigured !== undefined) {
    const total = seed.providersTotal ?? Math.max(seed.providersConfigured, 4)
    queryClient.setQueryData(queryKeys.settings.providers(), {
      providers: Array.from({ length: total }, (_, i) => ({
        id: `p-${i}`,
        is_configured: i < seed.providersConfigured!,
      })),
    })
  }
  if (seed.sandboxPatterns !== undefined) {
    queryClient.setQueryData(queryKeys.settings.sandbox(), {
      denied_patterns: Array.from({ length: seed.sandboxPatterns }, (_, i) => `pat-${i}`),
    })
  }
  const result = render(
    <QueryClientProvider client={queryClient}>
      <SettingsHubPage />
    </QueryClientProvider>,
  )

  return {
    ...result,
    unmount: () => {
      result.unmount()
      queryClient.clear()
    },
  }
}

// ── Hygiene ──────────────────────────────────────────────────────────────────

let originalFetch: typeof fetch | undefined

beforeEach(() => {
  // Prevent any background fetch the page might spontaneously fire (e.g. a
  // query we forgot to seed) from hitting the network and slowing the test.
  originalFetch = globalThis.fetch
  globalThis.fetch = (() =>
    Promise.reject(new Error('network disabled in test'))) as typeof fetch
})

afterEach(() => {
  if (originalFetch) globalThis.fetch = originalFetch
  originalFetch = undefined
  isMobileFlag = false
})

// ── Desktop updates card ────────────────────────────────────────────────────

describe('SettingsHubPage — desktop updates card', () => {
  it('renders desktop update controls without the old Application update heading', () => {
    renderHub({ health: { status: 'ok', version: '1.2.3' } })

    expect(screen.getByRole('heading', { name: /^updates$/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /check for updates?/i })).toBeInTheDocument()
    expect(screen.queryByText(/application update/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /^install$/i })).toBeNull()
  })
})

// ── Header ──────────────────────────────────────────────────────────────────

describe('SettingsHubPage — header', () => {
  it('renders the project name and tagline', () => {
    renderHub({ health: { status: 'ok', version: '1.2.3' } })
    expect(screen.getByRole('heading', { name: /about openagentd/i })).toBeInTheDocument()
    expect(screen.getByText(/On-machine AI assistant/i)).toBeInTheDocument()
  })

  it('appends the health version to the tagline when present', () => {
    renderHub({ health: { status: 'ok', version: '1.2.3' } })
    expect(screen.getByText(/On-machine AI assistant · v1\.2\.3/)).toBeInTheDocument()
  })

  it('omits the version suffix when health has not loaded yet', () => {
    renderHub() // No health seed.
    expect(screen.getByText(/On-machine AI assistant/i)).toBeInTheDocument()
    // No dot-version after the tagline.
    expect(screen.queryByText(/On-machine AI assistant ·/)).toBeNull()
  })
})

// ── Mobile nav cards ────────────────────────────────────────────────────────

describe('SettingsHubPage — mobile nav', () => {
  it('renders nav cards for every category when on mobile', () => {
    isMobileFlag = true
    renderHub({
      health: { status: 'ok', version: '1.2.3' },
      agents: 3,
      skills: 5,
      mcp: 1,
      providersConfigured: 2,
      providersTotal: 7,
      sandboxPatterns: 4,
    })

    // One <a href="…"> per category, in the documented order.
    const links = screen.getAllByRole('link').map((el) => el.getAttribute('href'))
    expect(links).toEqual(
      expect.arrayContaining([
        '/settings/agents',
        '/settings/skills',
        '/settings/mcp',
        '/settings/providers',
        '/settings/sandbox',
        '/settings/multimodal',
        '/settings/title-generation',
        '/settings/notifications',
      ]),
    )
  })

  it('renders no nav cards on desktop (sidebar handles navigation)', () => {
    isMobileFlag = false
    renderHub({ health: { status: 'ok', version: '1.2.3' }, agents: 3 })

    expect(screen.queryByRole('link')).toBeNull()
  })

  it('uses singular vs plural count labels correctly', () => {
    isMobileFlag = true
    renderHub({
      health: { status: 'ok', version: '1.2.3' },
      agents: 1,
      skills: 5,
      mcp: 1,
      sandboxPatterns: 1,
      providersConfigured: 0,
      providersTotal: 4,
    })

    // Singular: 1 agent / 1 server / 1 pattern.
    expect(screen.getByText(/^1 agent$/)).toBeInTheDocument()
    expect(screen.getByText(/^1 server$/)).toBeInTheDocument()
    expect(screen.getByText(/^1 pattern$/)).toBeInTheDocument()
    // Plural: 5 skills.
    expect(screen.getByText(/^5 skills$/)).toBeInTheDocument()
  })

  it('shows the count for connected providers only', () => {
    isMobileFlag = true
    renderHub({
      health: { status: 'ok', version: '1.2.3' },
      providersConfigured: 2,
      providersTotal: 7,
    })

    // Card label is "<count> connected", not "<count> providers".
    expect(screen.getByText(/^2 connected$/)).toBeInTheDocument()
  })

  it('renders an em-dash when a count query has no data', () => {
    isMobileFlag = true
    // Seed nothing — agentsCount falls back to ``null``, which the card
    // renders as "–" (en dash) per the component contract.
    renderHub({ health: { status: 'ok', version: '1.2.3' } })

    // At least one nav card should show the missing-data placeholder.
    const placeholders = screen.queryAllByText(/^–/)
    expect(placeholders.length).toBeGreaterThan(0)
  })
})
