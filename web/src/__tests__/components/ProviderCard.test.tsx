import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ProviderInfo } from '@/api/client'
import { ProviderCard } from '@/components/settings/pages/settings.providers/ProviderCard'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

const mockDisconnectOauthProvider = mock(() => Promise.resolve({ ok: true, provider: 'copilot' }))
mock.module('@/api/client', () => ({
  disconnectOauthProvider: mockDisconnectOauthProvider,
  listProviders: () => Promise.resolve({ providers: [] }),
  getProviderUsage: () => Promise.reject(new Error('no usage')),
  configureDefaultModel: () => Promise.resolve({ agents_updated: 0 }),
}))

function renderComponent(provider: ProviderInfo) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <ProviderCard provider={provider} />
    </QueryClientProvider>,
  )
}

describe('ProviderCard — OAuth disconnect and reconnect', () => {
  afterEach(cleanup)

  const connectedOAuthProvider: ProviderInfo = {
    id: 'copilot',
    label: 'GitHub Copilot',
    description: 'Use your Copilot subscription.',
    kind: 'oauth',
    credentials: [],
    saved_credentials: {},
    env_var: '',
    env_vars: [],
    oauth_command: 'openagentd auth copilot',
    docs_url: '',
    is_configured: true,
    is_saved: true,
    is_reachable: true,
    cached_models: ['copilot:gpt-4.1'],
    visible_models: ['copilot:gpt-4.1'],
    is_disconnected: false,
    supports_fast_mode: false,
    public_access: false,
  }

  const unconfiguredOAuthProvider: ProviderInfo = {
    ...connectedOAuthProvider,
    is_configured: false,
    is_saved: false,
    is_reachable: null,
  }

  it('renders Hide, Reconnect, and Disconnect buttons when OAuth is connected', () => {
    renderComponent(connectedOAuthProvider)
    expect(screen.getByText('Hide')).toBeDefined()
    expect(screen.getByText('Reconnect')).toBeDefined()
    expect(screen.getByText('Disconnect')).toBeDefined()
  })

  it('renders Connect button when OAuth is not connected', () => {
    renderComponent(unconfiguredOAuthProvider)
    expect(screen.getByText('Connect')).toBeDefined()
    expect(screen.queryByText('Reconnect')).toBeNull()
  })
})
