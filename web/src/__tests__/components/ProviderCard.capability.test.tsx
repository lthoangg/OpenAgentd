import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ProviderInfo, StoredCredential } from '@/api/client'
import { ProviderCard } from '@/components/settings/pages/settings.providers/ProviderCard'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

const mockAdd = mock((...args: unknown[]) => Promise.resolve({ id: 'cred_new', ...(args[1] as object) }))
const mockSave = mock((..._args: unknown[]) => Promise.resolve({ saved: true }))
const mockListModels = mock((..._args: unknown[]) =>
  Promise.resolve({ provider: 'plug', models: ['plug:m1'], model_costs: {}, source: 'provider' }),
)
const mockDisconnectOauth = mock((..._args: unknown[]) => Promise.resolve({ ok: true, provider: 'plug' }))
/** Args: providerId, callbacks, signal, mode, credentialId. */
const mockLoginStream = mock((..._args: unknown[]) => undefined)

mock.module('@/api/client', () => ({
  addProviderCredential: mockAdd,
  saveProvider: mockSave,
  listProviderModels: mockListModels,
  disconnectOauthProvider: mockDisconnectOauth,
  oauthLoginStream: mockLoginStream,
  listProviders: () => Promise.resolve({ providers: [] }),
  getProviderUsage: () => Promise.reject(new Error('no usage')),
  configureDefaultModel: () => Promise.resolve({ agents_updated: 0 }),
}))

function renderCard(provider: ProviderInfo) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <ProviderCard provider={provider} />
    </QueryClientProvider>,
  )
}

function credential(overrides: Partial<StoredCredential>): StoredCredential {
  return {
    id: 'cred_a',
    label: 'Personal',
    disabled: false,
    kind: 'api_key',
    hint: '…a1b2',
    settings: {},
    status: 'ready',
    in_use: false,
    cooldown_until: null,
    cooldown_reason: null,
    ...overrides,
  }
}

const base: ProviderInfo = {
  id: 'plugkey',
  label: 'PlugKey',
  description: 'A plugin provider.',
  kind: 'api_key',
  credentials: [],
  saved_credentials: {},
  env_var: 'PLUG_API_KEY',
  env_vars: ['PLUG_API_KEY'],
  oauth_command: '',
  docs_url: '',
  is_configured: true,
  is_saved: true,
  is_reachable: true,
  cached_models: [],
  visible_models: [],
  is_disconnected: false,
  supports_fast_mode: false,
  public_access: false,
  env_pinned: false,
  stored_credentials: [credential({ id: 'cred_a', label: 'Personal', in_use: true })],
}

const pluginKey: ProviderInfo = base
const pluginOauth: ProviderInfo = {
  ...base,
  id: 'plugoauth',
  label: 'PlugOauth',
  kind: 'oauth',
  env_var: '',
  env_vars: [],
  stored_credentials: [
    credential({ id: 'cred_me', label: 'me@example.com', kind: 'oauth', hint: null, in_use: true }),
    credential({ id: 'cred_team', label: 'team@example.com', kind: 'oauth', hint: null, status: 'needs_reconnect' }),
  ],
}

describe('ProviderCard — multi-credential capability', () => {
  beforeEach(() => {
    for (const m of [mockAdd, mockSave, mockListModels, mockDisconnectOauth, mockLoginStream]) m.mockClear()
  })
  afterEach(cleanup)

  it('keeps the single-key form for an api-key plugin that did not opt in', async () => {
    renderCard({ ...pluginKey, supports_multiple_credentials: false })
    expect(screen.queryByRole('list', { name: 'PlugKey keys' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Add key' })).toBeNull()
    expect(screen.queryByPlaceholderText('Name (e.g. Work)')).toBeNull()
    fireEvent.change(screen.getByPlaceholderText('Enter a new key to replace current key'), { target: { value: 'sk-test-only' } })
    fireEvent.click(screen.getByRole('button', { name: 'List models' }))
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement
    await waitFor(() => expect(save.disabled).toBe(false))
    fireEvent.click(save)
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1))
    expect(mockSave.mock.calls[0][0]).toBe('plugkey')
    expect(mockAdd).not.toHaveBeenCalled()
  })

  it('lists keys and adds another one for an api-key plugin that opted in', async () => {
    renderCard({ ...pluginKey, supports_multiple_credentials: true })
    expect(screen.getByRole('list', { name: 'PlugKey keys' })).toBeTruthy()
    fireEvent.change(screen.getByPlaceholderText('Paste another API key'), { target: { value: 'sk-test-more' } })
    fireEvent.click(screen.getByRole('button', { name: 'List models' }))
    const add = screen.getByRole('button', { name: 'Add key' }) as HTMLButtonElement
    await waitFor(() => expect(add.disabled).toBe(false))
    fireEvent.click(add)
    await waitFor(() => expect(mockAdd).toHaveBeenCalledTimes(1))
    expect(mockAdd.mock.calls[0][0]).toBe('plugkey')
    expect(mockSave).not.toHaveBeenCalled()
  })

  it('keeps the previous behaviour when an older backend omits the flag', () => {
    renderCard(pluginKey)
    expect(screen.getByRole('list', { name: 'PlugKey keys' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add key' })).toBeTruthy()
  })

  it('reconnects a non-opted-in oauth plugin as one connection, never with an account', () => {
    renderCard({ ...pluginOauth, supports_multiple_credentials: false })
    expect(screen.queryByRole('list', { name: 'PlugOauth accounts' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Add account' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    expect(screen.getByText('Connect PlugOauth')).toBeTruthy()
    expect(mockLoginStream).toHaveBeenCalledTimes(1)
    expect(mockLoginStream.mock.calls[0][4]).toBeUndefined()
  })

  it('offers accounts for an oauth plugin that opted in', () => {
    renderCard({ ...pluginOauth, supports_multiple_credentials: true })
    expect(screen.getByRole('button', { name: 'Add account' })).toBeTruthy()
    const rows = within(screen.getByRole('list', { name: 'PlugOauth accounts' })).getAllByRole('listitem')
    fireEvent.click(within(rows[1]).getByRole('button', { name: 'Reconnect' }))
    expect(mockLoginStream.mock.calls[0][4]).toBe('cred_team')
  })

  it('adds an account without targeting one when opted in', () => {
    renderCard({ ...pluginOauth, supports_multiple_credentials: true })
    fireEvent.click(screen.getByRole('button', { name: 'Add account' }))
    expect(screen.getByText('Add a PlugOauth account')).toBeTruthy()
    expect(mockLoginStream.mock.calls[0][4]).toBeUndefined()
  })

  it('shows per-account Usage only when the backend says the provider has it', () => {
    const { unmount } = renderCard({ ...pluginOauth, id: 'codex', supports_multiple_credentials: true, supports_credential_usage: false })
    expect(screen.queryByRole('button', { name: 'Usage' })).toBeNull()
    unmount()
    renderCard({ ...pluginOauth, supports_multiple_credentials: true, supports_credential_usage: true })
    expect(screen.getAllByRole('button', { name: 'Usage' }).length).toBeGreaterThan(0)
  })

  it('falls back to the built-in usage set when the flag is missing', () => {
    const { unmount } = renderCard({ ...pluginOauth, id: 'codex' })
    expect(screen.getAllByRole('button', { name: 'Usage' }).length).toBeGreaterThan(0)
    unmount()
    renderCard(pluginOauth)
    expect(screen.queryByRole('button', { name: 'Usage' })).toBeNull()
  })
})
