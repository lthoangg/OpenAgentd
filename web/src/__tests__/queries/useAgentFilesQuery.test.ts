import { afterEach, describe, expect, it, mock } from 'bun:test'
import React from 'react'
import { renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { queryKeys, useRegistryQuery } from '@/queries'
import type { ProvidersListBody } from '@/api/client'

function createWrapper(queryClient: QueryClient) {
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children)
}

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('useRegistryQuery', () => {
  it('keeps the agent registry as app-lifetime metadata', () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ tools: [], skills: [], providers: [], models: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    ) as typeof fetch
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    })

    renderHook(() => useRegistryQuery(), { wrapper: createWrapper(queryClient) })

    const query = queryClient.getQueryCache().find({ queryKey: queryKeys.agentFiles.registry() })
    const options = query?.options as {
      staleTime?: unknown
      gcTime?: unknown
      refetchOnWindowFocus?: unknown
      refetchOnReconnect?: unknown
    }
    expect(options.staleTime).toBe(Infinity)
    expect(options.gcTime).toBe(Infinity)
    expect(options.refetchOnWindowFocus).toBe(false)
    expect(options.refetchOnReconnect).toBe(false)
  })

  it('hydrates placeholder models from cached provider visibility state', async () => {
    globalThis.fetch = mock(async () =>
      new Promise<Response>(() => {
        // Intentionally unresolved: assert placeholder data before registry fetch completes.
      })
    ) as typeof fetch

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    })
    const providers: ProvidersListBody = {
      has_any_configured: true,
      providers: [
        {
          id: 'claude',
          label: 'Claude OAuth',
          description: 'Claude',
          kind: 'oauth',
          credentials: [],
          saved_credentials: {},
          env_var: '',
          env_vars: [],
          oauth_command: '',
          docs_url: '',
          is_configured: true,
          is_saved: true,
          is_reachable: true,
          cached_models: ['claude-sonnet-4-6', 'claude-haiku-4-5'],
          visible_models: ['claude-sonnet-4-6'],
          is_disconnected: false,
          supports_fast_mode: false,
        },
      ],
    }
    queryClient.setQueryData(queryKeys.settings.providers(), providers)

    const { result } = renderHook(() => useRegistryQuery(), {
      wrapper: createWrapper(queryClient),
    })

    expect(result.current.data?.models.map((model) => model.id)).toEqual([
      'claude:claude-sonnet-4-6',
    ])
  })

  it('placeholder model inherits fast_mode=true from a provider that supports it', async () => {
    globalThis.fetch = mock(async () =>
      new Promise<Response>(() => {
        // Intentionally unresolved: assert placeholder data before registry fetch completes.
      })
    ) as typeof fetch

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const providers: ProvidersListBody = {
      has_any_configured: true,
      providers: [
        {
          id: 'openai',
          label: 'OpenAI',
          description: 'OpenAI',
          kind: 'api_key',
          credentials: [],
          saved_credentials: {},
          env_var: 'OPENAI_API_KEY',
          env_vars: [],
          oauth_command: '',
          docs_url: '',
          is_configured: true,
          is_saved: true,
          is_reachable: true,
          cached_models: ['gpt-5'],
          visible_models: [],
          is_disconnected: false,
          supports_fast_mode: true,
        },
      ],
    }
    queryClient.setQueryData(queryKeys.settings.providers(), providers)

    const { result } = renderHook(() => useRegistryQuery(), {
      wrapper: createWrapper(queryClient),
    })

    const model = result.current.data?.models.find((m) => m.id === 'openai:gpt-5')
    expect(model?.fast_mode).toBe(true)
  })

  it('placeholder model inherits fast_mode=false from a provider that does not support it', async () => {
    globalThis.fetch = mock(async () =>
      new Promise<Response>(() => {})
    ) as typeof fetch

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const providers: ProvidersListBody = {
      has_any_configured: true,
      providers: [
        {
          id: 'ollama',
          label: 'Ollama',
          description: 'Ollama local',
          kind: 'local',
          credentials: [],
          saved_credentials: {},
          env_var: '',
          env_vars: [],
          oauth_command: '',
          docs_url: '',
          is_configured: true,
          is_saved: true,
          is_reachable: true,
          cached_models: ['llama3'],
          visible_models: [],
          is_disconnected: false,
          supports_fast_mode: false,
        },
      ],
    }
    queryClient.setQueryData(queryKeys.settings.providers(), providers)

    const { result } = renderHook(() => useRegistryQuery(), {
      wrapper: createWrapper(queryClient),
    })

    const model = result.current.data?.models.find((m) => m.id === 'ollama:llama3')
    expect(model?.fast_mode).toBe(false)
  })
})
