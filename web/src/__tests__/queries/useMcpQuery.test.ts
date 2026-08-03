import { describe, it, expect } from 'bun:test'
import React from 'react'
import { renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  useMcpServersQuery,
  useMcpServerQuery,
  useCreateMcpServerMutation,
  useUpdateMcpServerMutation,
  useDeleteMcpServerMutation,
  useRestartMcpServerMutation,
  mcpPollInterval,
  MCP_STARTING_POLL_MS,
} from '@/queries/useMcpQuery'
import type { ServerStatus } from '@/api/client'

// ── Query client wrapper ─────────────────────────────────────────────────────

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  })
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children)
}

// ── useMcpServersQuery ───────────────────────────────────────────────────────

describe('useMcpServersQuery', () => {
  it('returns a query hook with expected properties', () => {
    const { result } = renderHook(() => useMcpServersQuery(), { wrapper: createWrapper() })
    expect(result.current).toBeTruthy()
    expect(typeof result.current.isLoading).toBe('boolean')
    expect(typeof result.current.isError).toBe('boolean')
    expect(typeof result.current.isSuccess).toBe('boolean')
  })

  it('has status properties for query state', () => {
    const { result } = renderHook(() => useMcpServersQuery(), { wrapper: createWrapper() })
    expect('data' in result.current).toBe(true)
    expect('error' in result.current).toBe(true)
  })

  it('is configured with staleTime', () => {
    const { result } = renderHook(() => useMcpServersQuery(), { wrapper: createWrapper() })
    expect(result.current).toBeTruthy()
  })
})

// ── mcpPollInterval ──────────────────────────────────────────────────────────

describe('mcpPollInterval', () => {
  const srv = (over: Partial<ServerStatus> & { name: string }): ServerStatus => ({
    transport: 'stdio',
    enabled: true,
    state: 'ready',
    error: null,
    tool_names: [],
    started_at: null,
    config: null,
    ...over,
  })

  it('polls while an enabled server is still starting', () => {
    expect(mcpPollInterval([srv({ name: 'a', state: 'starting' })])).toBe(MCP_STARTING_POLL_MS)
  })

  it('stops polling once every server has settled', () => {
    expect(
      mcpPollInterval([srv({ name: 'a', state: 'ready' }), srv({ name: 'b', state: 'error' })]),
    ).toBe(false)
  })

  it('does not poll for a disabled server stuck in starting', () => {
    expect(mcpPollInterval([srv({ name: 'a', state: 'starting', enabled: false })])).toBe(false)
  })

  it('does not poll before any data has arrived', () => {
    expect(mcpPollInterval(undefined)).toBe(false)
  })
})

// ── useMcpServerQuery ────────────────────────────────────────────────────────

describe('useMcpServerQuery', () => {
  it('returns a query hook with expected properties', () => {
    const { result } = renderHook(() => useMcpServerQuery('filesystem'), {
      wrapper: createWrapper(),
    })
    expect(result.current).toBeTruthy()
    expect(typeof result.current.isLoading).toBe('boolean')
    expect(typeof result.current.isError).toBe('boolean')
  })

  it('has status properties for query state', () => {
    const { result } = renderHook(() => useMcpServerQuery('filesystem'), {
      wrapper: createWrapper(),
    })
    expect('data' in result.current).toBe(true)
    expect('error' in result.current).toBe(true)
  })

  it('is disabled when name is null', () => {
    const { result } = renderHook(() => useMcpServerQuery(null), { wrapper: createWrapper() })
    expect(result.current.isLoading).toBe(false)
  })

  it('is disabled when name is undefined', () => {
    const { result } = renderHook(() => useMcpServerQuery(undefined), {
      wrapper: createWrapper(),
    })
    expect(result.current.isLoading).toBe(false)
  })
})

// ── useCreateMcpServerMutation ───────────────────────────────────────────────

describe('useCreateMcpServerMutation', () => {
  it('returns a mutation hook with expected properties', () => {
    const { result } = renderHook(() => useCreateMcpServerMutation(), {
      wrapper: createWrapper(),
    })
    expect(result.current).toBeTruthy()
    expect(typeof result.current.mutate).toBe('function')
    expect(typeof result.current.mutateAsync).toBe('function')
    expect(typeof result.current.isPending).toBe('boolean')
    expect(typeof result.current.isError).toBe('boolean')
  })

  it('invalidates all mcp queries on success', () => {
    const { result } = renderHook(() => useCreateMcpServerMutation(), {
      wrapper: createWrapper(),
    })
    expect(result.current).toBeTruthy()
  })
})

// ── useUpdateMcpServerMutation ───────────────────────────────────────────────

describe('useUpdateMcpServerMutation', () => {
  it('returns a mutation hook with expected properties', () => {
    const { result } = renderHook(() => useUpdateMcpServerMutation(), {
      wrapper: createWrapper(),
    })
    expect(result.current).toBeTruthy()
    expect(typeof result.current.mutate).toBe('function')
    expect(typeof result.current.mutateAsync).toBe('function')
    expect(typeof result.current.isPending).toBe('boolean')
  })

  it('invalidates all mcp queries and detail query on success', () => {
    const { result } = renderHook(() => useUpdateMcpServerMutation(), {
      wrapper: createWrapper(),
    })
    expect(result.current).toBeTruthy()
  })
})

// ── useDeleteMcpServerMutation ───────────────────────────────────────────────

describe('useDeleteMcpServerMutation', () => {
  it('returns a mutation hook with expected properties', () => {
    const { result } = renderHook(() => useDeleteMcpServerMutation(), {
      wrapper: createWrapper(),
    })
    expect(result.current).toBeTruthy()
    expect(typeof result.current.mutate).toBe('function')
    expect(typeof result.current.mutateAsync).toBe('function')
    expect(typeof result.current.isPending).toBe('boolean')
  })

  it('invalidates all mcp queries on success', () => {
    const { result } = renderHook(() => useDeleteMcpServerMutation(), {
      wrapper: createWrapper(),
    })
    expect(result.current).toBeTruthy()
  })
})

// ── useRestartMcpServerMutation ──────────────────────────────────────────────

describe('useRestartMcpServerMutation', () => {
  it('returns a mutation hook with expected properties', () => {
    const { result } = renderHook(() => useRestartMcpServerMutation(), {
      wrapper: createWrapper(),
    })
    expect(result.current).toBeTruthy()
    expect(typeof result.current.mutate).toBe('function')
    expect(typeof result.current.mutateAsync).toBe('function')
    expect(typeof result.current.isPending).toBe('boolean')
  })

  it('invalidates the detail query on success', () => {
    const { result } = renderHook(() => useRestartMcpServerMutation(), {
      wrapper: createWrapper(),
    })
    expect(result.current).toBeTruthy()
  })
})
