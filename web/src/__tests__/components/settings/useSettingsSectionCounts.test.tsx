import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { setupServer } from '@/__tests__/msw'
import type { ReactNode } from 'react'

import { useSettingsSectionCounts } from '@/components/settings/useVisibleSections'
import { queryKeys } from '@/queries/keys'

const server = setupServer()
let originalFetch: typeof fetch | undefined

beforeEach(() => {
  server.listen()
  originalFetch = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === 'string' && input.startsWith('/')) {
      return originalFetch?.(`http://localhost${input}`, init) ?? Promise.reject(new Error('fetch unavailable'))
    }
    return originalFetch?.(input, init) ?? Promise.reject(new Error('fetch unavailable'))
  }) as typeof fetch
})

afterEach(() => {
  server.resetHandlers()
  if (originalFetch) globalThis.fetch = originalFetch
  originalFetch = undefined
  server.close()
})

function serve(data: { skills: number; connectors: Array<{ state: string }>; rules: number }) {
  server.use(
    http.get('http://localhost/api/skills', () => HttpResponse.json({ skills: Array.from({ length: data.skills }, (_, i) => ({ name: `s${i}` })) })),
    http.get('http://localhost/api/mcp/servers', () => HttpResponse.json({
      servers: data.connectors.map((c, i) => ({ name: `c${i}`, transport: 'http', enabled: true, state: c.state, error: null, tool_names: [], started_at: null })),
    })),
    http.get('http://localhost/api/settings/denied-paths', () => HttpResponse.json({ denied_patterns: Array.from({ length: data.rules }, (_, i) => `**/f${i}`) })),
  )
}

function counts() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  return renderHook(() => useSettingsSectionCounts(), { wrapper })
}

describe('useSettingsSectionCounts', () => {
  it('counts connectors, skills and rules in words', async () => {
    serve({ skills: 4, connectors: [{ state: 'ready' }, { state: 'ready' }], rules: 1 })
    const { result } = counts()
    await waitFor(() => expect(result.current.blocked_files).toBe('1 rule'))
    await waitFor(() => expect(result.current.connectors).toBe('2 connectors'))
    await waitFor(() => expect(result.current.skills).toBe('4 skills'))
  })

  it('says a connector needs sign-in before it counts them', async () => {
    serve({ skills: 0, connectors: [{ state: 'auth_required' }, { state: 'ready' }], rules: 0 })
    const { result } = counts()
    await waitFor(() => expect(result.current.connectors).toBe('1 needs sign-in'))
  })

  it('says nothing beside a section that has none', () => {
    // Seeded, so the answer is there on the first render: null is "none", not "loading".
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    client.setQueryData(queryKeys.skillFiles.list(), { skills: [] })
    client.setQueryData(queryKeys.mcp.list(), { servers: [] })
    client.setQueryData(queryKeys.settings.deniedPaths(), { denied_patterns: [] })
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
    const { result } = renderHook(() => useSettingsSectionCounts(), { wrapper })
    expect(result.current).toEqual({ skills: null, connectors: null, blocked_files: null })
  })
})
