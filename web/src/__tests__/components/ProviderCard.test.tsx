import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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

function renderComponent(provider: ProviderInfo, props: { defaultExpanded?: boolean } = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <ProviderCard provider={provider} {...props} />
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
    oauth_command: 'agentd auth copilot',
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

  it('renders Hide from pickers, Reconnect, and Sign out… buttons when OAuth is connected', () => {
    renderComponent(connectedOAuthProvider)
    expect(screen.getByRole('button', { name: 'Hide from pickers' })).toBeDefined()
    expect(screen.getByText('Reconnect')).toBeDefined()
    expect(screen.getByText('Sign out…')).toBeDefined()
    expect(screen.queryByText('Disconnect')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Hide' })).toBeNull()
  })

  it('is a collapsible row: label, sign-in subline and a Connected chip in the header button', () => {
    renderComponent(connectedOAuthProvider)
    const header = screen.getByRole('button', { name: /GitHub Copilot/ })
    expect(header.getAttribute('aria-expanded')).toBe('true')
    expect(header.textContent).toContain('Sign-in')
    expect(header.textContent).toContain('1 model')
    const chip = within(header).getByText('Connected').closest('[data-slot="chip"]')
    expect(chip?.getAttribute('data-tone')).toBe('success')
  })

  it('shows the body only while the row is expanded, and the header toggles it', () => {
    renderComponent(connectedOAuthProvider, { defaultExpanded: false })
    const header = screen.getByRole('button', { name: /GitHub Copilot/ })
    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('Reconnect')).toBeNull()
    expect(screen.queryByText('Use your Copilot subscription.')).toBeNull()

    fireEvent.click(header)
    expect(header.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('Reconnect')).toBeDefined()
    expect(screen.getByText('Use your Copilot subscription.')).toBeDefined()

    fireEvent.click(header)
    expect(screen.queryByText('Reconnect')).toBeNull()
  })

  it('labels the chip Not connected for an OAuth provider that is not signed in', () => {
    renderComponent(unconfiguredOAuthProvider)
    const header = screen.getByRole('button', { name: /GitHub Copilot/ })
    expect(within(header).getByText('Not connected').closest('[data-slot="chip"]')?.getAttribute('data-tone')).toBe('neutral')
  })

  it('tests the sign-in with a Test sign-in button, not List models', () => {
    renderComponent(connectedOAuthProvider)
    expect(screen.getByRole('button', { name: 'Test sign-in' })).toBeDefined()
    expect(screen.queryByRole('button', { name: 'List models' })).toBeNull()
  })

  it('asks for confirmation before signing out, and signs out only on confirm', async () => {
    mockDisconnectOauthProvider.mockClear()
    renderComponent(connectedOAuthProvider)
    fireEvent.click(screen.getByRole('button', { name: 'Sign out…' }))

    expect(await screen.findByText('Sign out of GitHub Copilot?')).toBeDefined()
    expect(mockDisconnectOauthProvider).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    await waitFor(() => expect(mockDisconnectOauthProvider).toHaveBeenCalledTimes(1))
    expect(mockDisconnectOauthProvider.mock.calls[0]).toContain('copilot')
  })

  it('keeps the sign-in when the sign out confirmation is cancelled', async () => {
    mockDisconnectOauthProvider.mockClear()
    renderComponent(connectedOAuthProvider)
    fireEvent.click(screen.getByRole('button', { name: 'Sign out…' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))

    // Give a (wrongly) confirming click time to reach the API before asserting it did not
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(mockDisconnectOauthProvider).not.toHaveBeenCalled()
  })

  it('renders Connect button when OAuth is not connected', () => {
    renderComponent(unconfiguredOAuthProvider)
    expect(screen.getByText('Connect')).toBeDefined()
    expect(screen.queryByText('Reconnect')).toBeNull()
  })
})
