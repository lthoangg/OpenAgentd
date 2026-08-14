/**
 * Tests for the path denylist settings — API client + page rendering.
 */
import { describe, it, expect, mock } from 'bun:test'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import {
  getDeniedPathsSettings,
  getLspToolsStatus,
  installTypeScriptLsp,
  updateDeniedPathsSettings,
} from '@/api/client'
import { DeniedPathsSettingsPage } from '@/components/settings/pages/settings.denied_paths'

// ── API client ──────────────────────────────────────────────────────────────

describe('getDeniedPathsSettings', () => {
  it('returns the parsed deny-list', async () => {
    const original = globalThis.fetch
    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify({ denied_patterns: ['**/.env'] }), {
          status: 200,
        }),
    )
    try {
      const result = await getDeniedPathsSettings()
      expect(result).toEqual({ denied_patterns: ['**/.env'] })
    } finally {
      globalThis.fetch = original
    }
  })

  it('throws on non-ok response', async () => {
    const original = globalThis.fetch
    globalThis.fetch = mock(async () => new Response(null, { status: 500 }))
    try {
      await getDeniedPathsSettings()
      expect.unreachable('should throw')
    } catch (err) {
      expect(err).toBeInstanceOf(Error)
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('updateDeniedPathsSettings', () => {
  it('PUTs JSON body and returns the response', async () => {
    const captured: { url?: string; init?: RequestInit } = {}
    const original = globalThis.fetch
    globalThis.fetch = mock((async (url: RequestInfo | URL, init?: RequestInit) => {
      captured.url = String(url)
      captured.init = init
      return new Response(JSON.stringify({ denied_patterns: ['**/foo'] }), {
        status: 200,
      })
    }) as (...args: unknown[]) => unknown) as unknown as typeof fetch
    try {
      const result = await updateDeniedPathsSettings({ denied_patterns: ['**/foo'] })
      expect(result.denied_patterns).toEqual(['**/foo'])
      expect(captured.url).toContain('/api/settings/denied-paths')
      expect(captured.init?.method).toBe('PUT')
      expect(JSON.parse(String(captured.init?.body))).toEqual({
        denied_patterns: ['**/foo'],
      })
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('managed LSP settings API', () => {
  it('GETs the managed LSP status', async () => {
    const captured: { url?: string } = {}
    const original = globalThis.fetch
    globalThis.fetch = mock((async (url: RequestInfo | URL) => {
      captured.url = String(url)
      return new Response(
        JSON.stringify({
          downloads_enabled: false,
          python: { ty: true, ruff: false },
          typescript: {
            state: 'installed',
            detail: 'ready',
            language_server_version: '4.1.0',
            typescript_version: '5.9.3',
          },
        }),
        { status: 200 },
      )
    }) as (...args: unknown[]) => unknown) as unknown as typeof fetch

    try {
      const result = await getLspToolsStatus()
      expect(captured.url).toContain('/api/settings/lsp')
      expect(result.typescript.state).toBe('installed')
      expect(result.python.ty).toBe(true)
    } finally {
      globalThis.fetch = original
    }
  })

  it('POSTs only to the managed TypeScript installer endpoint', async () => {
    const captured: { url?: string; init?: RequestInit } = {}
    const original = globalThis.fetch
    globalThis.fetch = mock((async (url: RequestInfo | URL, init?: RequestInit) => {
      captured.url = String(url)
      captured.init = init
      return new Response(
        JSON.stringify({
          downloads_enabled: false,
          python: { ty: true, ruff: false },
          typescript: {
            state: 'downloading',
            detail: 'installing typescript-language-server',
            language_server_version: '4.1.0',
            typescript_version: '5.9.3',
          },
        }),
        { status: 200 },
      )
    }) as (...args: unknown[]) => unknown) as unknown as typeof fetch

    try {
      const result = await installTypeScriptLsp()
      expect(captured.url).toContain('/api/settings/lsp/typescript/install')
      expect(captured.init?.method).toBe('POST')
      expect(result.typescript.state).toBe('downloading')
    } finally {
      globalThis.fetch = original
    }
  })
})

// ── Component ───────────────────────────────────────────────────────────────

function renderWithQueryClient(ui: React.ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  )
}

describe('DeniedPathsSettingsPage', () => {
  it('renders pattern rows from the server', async () => {
    const original = globalThis.fetch
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({ denied_patterns: ['**/.env', 'secrets/**'] }),
          { status: 200 },
        ),
    )
    try {
      renderWithQueryClient(<DeniedPathsSettingsPage />)
      await waitFor(() => {
        expect(screen.getByDisplayValue('**/.env')).toBeTruthy()
        expect(screen.getByDisplayValue('secrets/**')).toBeTruthy()
      })
    } finally {
      globalThis.fetch = original
    }
  })

  it('adds a new empty row when "Add pattern" is clicked', async () => {
    const original = globalThis.fetch
    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify({ denied_patterns: ['**/.env'] }), {
          status: 200,
        }),
    )
    try {
      renderWithQueryClient(<DeniedPathsSettingsPage />)
      await waitFor(() => screen.getByDisplayValue('**/.env'))

      const addBtn = screen.getByText('Add pattern')
      fireEvent.click(addBtn)

      // Should now have 2 pattern inputs (one filled, one empty)
      const inputs = screen.getAllByRole('textbox')
      expect(inputs.length).toBe(2)
    } finally {
      globalThis.fetch = original
    }
  })

  it('shows empty-state when server returns no patterns', async () => {
    const original = globalThis.fetch
    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify({ denied_patterns: [] }), { status: 200 }),
    )
    try {
      renderWithQueryClient(<DeniedPathsSettingsPage />)
      await waitFor(() => {
        expect(screen.getByText('No patterns')).toBeTruthy()
      })
    } finally {
      globalThis.fetch = original
    }
  })
})
