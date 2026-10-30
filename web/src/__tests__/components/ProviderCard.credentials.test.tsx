import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ProviderInfo, StoredCredential } from '@/api/client'
import { ProviderCard } from '@/components/settings/pages/settings.providers/ProviderCard'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

const mockOrder = mock((...args: unknown[]) => Promise.resolve({ provider: 'openai', credentials: [], ids: args[1] }))
const mockDelete = mock((..._args: unknown[]) => Promise.resolve({ ok: true }))
const mockUpdate = mock((...args: unknown[]) => Promise.resolve({ id: args[1], ...(args[2] as object) }))
const mockAdd = mock((...args: unknown[]) => Promise.resolve({ id: 'cred_new', ...(args[1] as object) }))
const mockListModels = mock((..._args: unknown[]) =>
  Promise.resolve({ provider: 'openai', models: ['openai:gpt-5.5'], model_costs: {}, source: 'provider' }),
)
const mockDisconnectOauth = mock((..._args: unknown[]) => Promise.resolve({ ok: true, provider: 'codex' }))
/** Args: providerId, callbacks, signal, mode, credentialId. */
const mockLoginStream = mock((..._args: unknown[]) => undefined)

mock.module('@/api/client', () => ({
  addProviderCredential: mockAdd,
  deleteProviderCredential: mockDelete,
  updateProviderCredential: mockUpdate,
  orderProviderCredentials: mockOrder,
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

/** Opens a key's "More actions" menu (Try earlier / Try later / Disable …). */
function openMore(label: string) {
  fireEvent.click(screen.getByRole('button', { name: `More actions for ${label}` }))
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

const openai: ProviderInfo = {
  id: 'openai',
  label: 'OpenAI',
  description: 'GPT models.',
  kind: 'api_key',
  credentials: [{ name: 'OPENAI_API_KEY', label: 'API key', placeholder: 'sk-…', secret: true, required: true }],
  saved_credentials: {},
  env_var: 'OPENAI_API_KEY',
  env_vars: ['OPENAI_API_KEY'],
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
  stored_credentials: [
    credential({ id: 'cred_a', label: 'Personal', hint: '…a1b2', in_use: true }),
    credential({
      id: 'cred_b',
      label: 'Work',
      hint: '…c3d4',
      status: 'cooling_down',
      cooldown_reason: 'quota',
      cooldown_until: Math.floor(Date.now() / 1000) + 2 * 3600 + 30,
    }),
  ],
}

const codex: ProviderInfo = {
  ...openai,
  id: 'codex',
  label: 'Codex',
  kind: 'oauth',
  credentials: [],
  env_var: '',
  env_vars: [],
  stored_credentials: [
    credential({ id: 'cred_me', label: 'me@example.com', kind: 'oauth', hint: null, in_use: true }),
    credential({ id: 'cred_team', label: 'team@example.com', kind: 'oauth', hint: null, status: 'needs_reconnect' }),
  ],
}

describe('ProviderCard — several API keys', () => {
  beforeEach(() => {
    for (const m of [mockOrder, mockDelete, mockUpdate, mockAdd, mockListModels, mockDisconnectOauth, mockLoginStream]) m.mockClear()
  })
  afterEach(cleanup)

  it('lists stored keys in priority order with their status', () => {
    renderCard(openai)
    const rows = within(screen.getByRole('list', { name: 'OpenAI keys' })).getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(within(rows[0]).getByText('Personal')).toBeTruthy()
    expect(within(rows[0]).getByText('…a1b2')).toBeTruthy()
    expect(within(rows[0]).getByText('In use')).toBeTruthy()
    expect(within(rows[1]).getByText(/Usage limit reached · resets in 2h/)).toBeTruthy()
  })

  it('never renders a stored secret value', () => {
    const { container } = renderCard(openai)
    expect(container.textContent).not.toContain('sk-')
  })

  it('keeps only Reconnect / Rename / Remove… as visible per-key buttons, the rest in a More menu', () => {
    renderCard(openai)
    const rows = within(screen.getByRole('list', { name: 'OpenAI keys' })).getAllByRole('listitem')
    expect(within(rows[0]).getByRole('button', { name: 'Rename' })).toBeTruthy()
    expect(within(rows[0]).getByRole('button', { name: 'Remove…' })).toBeTruthy()
    expect(within(rows[0]).getByRole('button', { name: 'More actions for Personal' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Move Personal down' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Move Personal up' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Disable' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Usage' })).toBeNull()
  })

  it('shows key statuses as chips', () => {
    renderCard(openai)
    const rows = within(screen.getByRole('list', { name: 'OpenAI keys' })).getAllByRole('listitem')
    expect(within(rows[0]).getByText('In use').closest('[data-slot="chip"]')?.getAttribute('data-tone')).toBe('info')
    expect(within(rows[0]).getByText('Ready').closest('[data-slot="chip"]')?.getAttribute('data-tone')).toBe('success')
    expect(within(rows[1]).getByText(/Usage limit reached/).closest('[data-slot="chip"]')?.getAttribute('data-tone')).toBe('warning')
  })

  it('moves a key down from the More menu, and offers no earlier slot to the first key', async () => {
    renderCard(openai)
    openMore('Personal')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Try later' }))
    await waitFor(() => expect(mockOrder).toHaveBeenCalledTimes(1))
    expect(mockOrder.mock.calls[0]).toEqual(['openai', ['cred_b', 'cred_a']])

    openMore('Personal')
    expect((screen.getByRole('menuitem', { name: 'Try earlier' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('disables a key from the More menu', async () => {
    renderCard(openai)
    openMore('Work')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Disable' }))
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith('openai', 'cred_b', { disabled: true }))
  })

  it('asks for confirmation before removing a key', async () => {
    renderCard(openai)
    const rows = within(screen.getByRole('list', { name: 'OpenAI keys' })).getAllByRole('listitem')
    fireEvent.click(within(rows[1]).getByRole('button', { name: 'Remove…' }))
    expect(mockDelete).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByRole('button', { name: 'Remove key' }))
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith('openai', 'cred_b'))
  })

  it('renames a key', async () => {
    renderCard(openai)
    const rows = within(screen.getByRole('list', { name: 'OpenAI keys' })).getAllByRole('listitem')
    fireEvent.click(within(rows[0]).getByRole('button', { name: 'Rename' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'New name for Personal' }), { target: { value: 'Side project' } })
    fireEvent.click(within(rows[0]).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith('openai', 'cred_a', { label: 'Side project' }))
  })

  it('adds another key after it is verified, without replacing the stored ones', async () => {
    renderCard(openai)
    const add = screen.getByRole('button', { name: 'Add key' }) as HTMLButtonElement
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    fireEvent.change(screen.getByPlaceholderText('Name (e.g. Work)'), { target: { value: 'Backup' } })
    fireEvent.change(screen.getByPlaceholderText('Paste another API key'), { target: { value: 'sk-test-third' } })
    expect(add.disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Test key' }))
    await waitFor(() => expect(add.disabled).toBe(false))
    fireEvent.click(add)
    await waitFor(() => expect(mockAdd).toHaveBeenCalledTimes(1))
    expect(mockAdd.mock.calls[0]).toEqual(['openai', { label: 'Backup', api_key: 'sk-test-third', extra: undefined }])
  })

  it('shows an exported key as a read-only row that pins the provider', () => {
    renderCard({ ...openai, env_pinned: true })
    const rows = within(screen.getByRole('list', { name: 'OpenAI keys' })).getAllByRole('listitem')
    expect(within(rows[0]).getByText('From environment')).toBeTruthy()
    expect(within(rows[0]).getByText('Read-only')).toBeTruthy()
    expect(within(rows[1]).getByText('Standby')).toBeTruthy()
    expect(within(rows[1]).queryByText('In use')).toBeNull()
  })
})

describe('ProviderCard — several OAuth accounts', () => {
  beforeEach(() => {
    mockLoginStream.mockClear()
    mockDisconnectOauth.mockClear()
  })
  afterEach(cleanup)

  it('offers Add account instead of a provider-wide Disconnect', () => {
    renderCard(codex)
    expect(screen.getByRole('button', { name: 'Add account' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Disconnect' })).toBeNull()
    expect(screen.getByText('Reconnect required')).toBeTruthy()
  })

  it('reconnects one account without touching the other', () => {
    renderCard(codex)
    const rows = within(screen.getByRole('list', { name: 'Codex accounts' })).getAllByRole('listitem')
    fireEvent.click(within(rows[1]).getByRole('button', { name: 'Reconnect' }))
    expect(screen.getByText('Reconnect team@example.com')).toBeTruthy()
    expect(mockLoginStream).toHaveBeenCalledTimes(1)
    expect(mockLoginStream.mock.calls[0][0]).toBe('codex')
    expect(mockLoginStream.mock.calls[0][4]).toBe('cred_team')
  })

  it('adds a new account when no account is targeted', () => {
    renderCard(codex)
    fireEvent.click(screen.getByRole('button', { name: 'Add account' }))
    expect(screen.getByText('Add a Codex account')).toBeTruthy()
    expect(mockLoginStream.mock.calls[0][4]).toBeUndefined()
  })

  it('removes only the chosen account', async () => {
    renderCard(codex)
    const rows = within(screen.getByRole('list', { name: 'Codex accounts' })).getAllByRole('listitem')
    fireEvent.click(within(rows[0]).getByRole('button', { name: 'Remove…' }))
    expect(mockDisconnectOauth).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByRole('button', { name: 'Remove account' }))
    await waitFor(() => expect(mockDisconnectOauth).toHaveBeenCalledWith('codex', 'cred_me'))
  })
})
