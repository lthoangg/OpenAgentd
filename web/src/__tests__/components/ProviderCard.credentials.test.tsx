import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ProviderInfo, StoredCredential } from '@/api/client'
import { ProviderCard } from '@/components/settings/pages/settings.providers/ProviderCard'
import { useToastStore } from '@/stores/useToastStore'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

const mockOrder = mock((...args: unknown[]) => Promise.resolve({ provider: 'openai', credentials: [], ids: args[1] }))
const mockDelete = mock((..._args: unknown[]) => Promise.resolve({ ok: true }))
const mockUpdate = mock((...args: unknown[]) => Promise.resolve({ id: args[1], ...(args[2] as object) }))
const mockAdd = mock((...args: unknown[]) => Promise.resolve({ id: 'cred_new', ...(args[1] as object) }))
const modelsOk = () => Promise.resolve({ provider: 'openai', models: ['openai:gpt-5.5'], model_costs: {}, source: 'provider' })
const mockListModels = mock((..._args: unknown[]): Promise<unknown> => modelsOk())
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

// The credentials list (pinned sessions) and a per-account Test go straight to the daemon.
const originalFetch = globalThis.fetch
type FetchCall = { method: string; path: string; body: Record<string, unknown> | null }
let fetchCalls: FetchCall[] = []
let pinned: Record<string, number> = {}
let testReply: () => Response = () => json({ provider: 'openai', models: ['openai:gpt-5.5'], source: 'provider' })
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

function renderCard(provider: ProviderInfo) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <ProviderCard provider={provider} />
    </QueryClientProvider>,
  )
}

function openMore(label: string): string[] {
  fireEvent.click(screen.getByRole('button', { name: `More actions for ${label}` }))
  return screen.getAllByRole('menuitem').map((item) => item.textContent ?? '')
}

function rows(listName: string) {
  return within(screen.getByRole('list', { name: listName })).getAllByRole('listitem')
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

beforeEach(() => {
  for (const m of [mockOrder, mockDelete, mockUpdate, mockAdd, mockListModels, mockDisconnectOauth, mockLoginStream]) m.mockClear()
  mockListModels.mockImplementation(() => modelsOk())
  mockAdd.mockImplementation((...args: unknown[]) => Promise.resolve({ id: 'cred_new', ...(args[1] as object) }))
  useToastStore.setState({ toasts: [] })
  fetchCalls = []
  pinned = {}
  testReply = () => json({ provider: 'openai', models: ['openai:gpt-5.5'], source: 'provider' })
  globalThis.fetch = mock(async (...args: unknown[]) => {
    const init = args[1] as RequestInit | undefined
    const method = init?.method ?? 'GET'
    const path = new URL(String(args[0]), 'http://localhost').pathname
    fetchCalls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null })
    if (method === 'GET' && path.endsWith('/credentials')) {
      return json({ credentials: Object.entries(pinned).map(([id, n]) => ({ id, pinned_sessions: n })) })
    }
    if (method === 'POST' && path.endsWith('/models')) return testReply()
    return json({}, 404)
  }) as unknown as typeof fetch
})

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
})

describe('ProviderCard — several API keys', () => {
  it('lists stored keys in priority order with their status', () => {
    renderCard(openai)
    const list = rows('OpenAI keys')
    expect(list).toHaveLength(2)
    expect(within(list[0]).getByText('Personal')).toBeTruthy()
    expect(within(list[0]).getByText('…a1b2')).toBeTruthy()
    expect(within(list[0]).getByText('In use')).toBeTruthy()
    expect(within(list[1]).getByText(/Usage limit reached · resets in 2h/)).toBeTruthy()
  })

  it('never renders a stored secret value', () => {
    const { container } = renderCard(openai)
    expect(container.textContent).not.toContain('sk-')
  })

  it('heads the list "Tried in this order" and says what that means', () => {
    renderCard(openai)
    expect(screen.getByRole('heading', { name: 'Tried in this order' })).toBeTruthy()
    expect(screen.getByText('When one key hits its limit, the next one is used.')).toBeTruthy()
  })

  it('has no order to name for a single key, or while an exported key is in force', () => {
    const one = renderCard({ ...openai, stored_credentials: [credential({ in_use: true })] })
    expect(screen.queryByRole('heading', { name: 'Tried in this order' })).toBeNull()
    one.unmount()
    renderCard({ ...openai, env_pinned: true })
    expect(screen.queryByRole('heading', { name: 'Tried in this order' })).toBeNull()
  })

  it('tags every row with what it is, in words', () => {
    renderCard(openai)
    for (const row of rows('OpenAI keys')) expect(within(row).getByText('API key')).toBeTruthy()
  })

  it('says under each row what its status means, so nothing hides in a tooltip', () => {
    renderCard({
      ...openai,
      stored_credentials: [
        credential({ id: 'cred_a', label: 'Personal', in_use: true }),
        credential({ id: 'cred_b', label: 'Work' }),
        credential({ id: 'cred_c', label: 'Backup', status: 'cooling_down', cooldown_reason: 'rate_limit', cooldown_until: Math.floor(Date.now() / 1000) + 600 }),
        credential({ id: 'cred_d', label: 'Old', disabled: true, status: 'disabled' }),
      ],
    })
    const list = rows('OpenAI keys')
    expect(within(list[0]).getByText('In use — new messages go to it until it hits its limit.')).toBeTruthy()
    expect(within(list[1]).getByText('Standby — used when the ones above hit their limit.')).toBeTruthy()
    expect(within(list[2]).getByText('Skipped until its limit resets; the next key is used meanwhile.')).toBeTruthy()
    expect(within(list[3]).getByText('Hidden — saved, but not used until you show it.')).toBeTruthy()
    expect(within(list[3]).getByText('Hidden')).toBeTruthy()
    // No native title carries the explanation.
    expect(document.querySelector('[data-credential-id] [title]')).toBeNull()
  })

  it('names the key in use when a row above it is ready too', () => {
    renderCard({
      ...openai,
      stored_credentials: [credential({ id: 'cred_a', label: 'Personal' }), credential({ id: 'cred_b', label: 'Work', in_use: true })],
    })
    expect(within(rows('OpenAI keys')[0]).getByText('Standby — used if the key in use hits its limit.')).toBeTruthy()
  })

  it('shows key statuses as chips', () => {
    renderCard(openai)
    const list = rows('OpenAI keys')
    expect(within(list[0]).getByText('In use').closest('[data-slot="chip"]')?.getAttribute('data-tone')).toBe('info')
    expect(within(list[0]).getByText('Ready').closest('[data-slot="chip"]')?.getAttribute('data-tone')).toBe('success')
    expect(within(list[1]).getByText(/Usage limit reached/).closest('[data-slot="chip"]')?.getAttribute('data-tone')).toBe('warning')
  })

  it('says how many sessions pin a key, and nothing when none do', () => {
    renderCard({
      ...openai,
      stored_credentials: [
        credential({ id: 'cred_a', label: 'Personal', pinned_sessions: 2 }),
        credential({ id: 'cred_b', label: 'Work', pinned_sessions: 1 }),
        credential({ id: 'cred_c', label: 'Spare', pinned_sessions: 0 }),
      ],
    })
    const list = rows('OpenAI keys')
    expect(within(list[0]).getByText('Pinned by 2 sessions')).toBeTruthy()
    expect(within(list[1]).getByText('Pinned by 1 session')).toBeTruthy()
    expect(within(list[2]).queryByText(/Pinned by/)).toBeNull()
  })

  it('reads the pinned counts from the daemon, since the provider list does not carry them', async () => {
    pinned = { cred_a: 0, cred_b: 3 }
    renderCard(openai)
    const list = rows('OpenAI keys')
    expect(await within(list[1]).findByText('Pinned by 3 sessions')).toBeTruthy()
    expect(within(list[0]).queryByText(/Pinned by/)).toBeNull()
    expect(fetchCalls).toContainEqual({ method: 'GET', path: '/api/settings/providers/openai/credentials', body: null })
  })

  it('has one action set for a key, all behind its ⋯ menu', () => {
    renderCard(openai)
    for (const row of rows('OpenAI keys')) {
      for (const name of ['Rename', 'Remove…', 'Remove', 'Hide', 'Test', 'Use first', 'Move down']) {
        expect(within(row).queryByRole('button', { name })).toBeNull()
      }
    }
    expect(openMore('Personal')).toEqual(['Rename', 'Use first', 'Move down', 'Test', 'Hide', 'Remove…'])
  })

  it('offers "Use first" to every key but the first, and "Move down" to every key but the last', () => {
    renderCard(openai)
    openMore('Personal')
    expect((screen.getByRole('menuitem', { name: 'Use first' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('menuitem', { name: 'Move down' }) as HTMLButtonElement).disabled).toBe(false)
    cleanup()

    renderCard(openai)
    openMore('Work')
    expect((screen.getByRole('menuitem', { name: 'Use first' }) as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByRole('menuitem', { name: 'Move down' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('moves a key to the top with "Use first", and says so', async () => {
    renderCard({
      ...openai,
      stored_credentials: [
        credential({ id: 'cred_a', label: 'Personal', in_use: true }),
        credential({ id: 'cred_b', label: 'Work' }),
        credential({ id: 'cred_c', label: 'Backup' }),
      ],
    })
    openMore('Backup')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Use first' }))
    await waitFor(() => expect(mockOrder).toHaveBeenCalledTimes(1))
    expect(mockOrder.mock.calls[0]).toEqual(['openai', ['cred_c', 'cred_a', 'cred_b']])
    await waitFor(() => expect(useToastStore.getState().toasts.map((t) => t.title)).toContain('Backup is now tried first'))
  })

  it('moves a key down one place', async () => {
    renderCard(openai)
    openMore('Personal')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move down' }))
    await waitFor(() => expect(mockOrder).toHaveBeenCalledTimes(1))
    expect(mockOrder.mock.calls[0]).toEqual(['openai', ['cred_b', 'cred_a']])
  })

  it('hides a key from the menu, then shows it again', async () => {
    const view = renderCard(openai)
    openMore('Work')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hide' }))
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith('openai', 'cred_b', { disabled: true }))
    view.unmount()

    renderCard({ ...openai, stored_credentials: [credential({ id: 'cred_a', in_use: true }), credential({ id: 'cred_b', label: 'Work', disabled: true, status: 'disabled' })] })
    const row = rows('OpenAI keys')[1]
    expect(within(row).getByText('Hidden')).toBeTruthy()
    fireEvent.click(within(row).getByRole('button', { name: 'Show' }))
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith('openai', 'cred_b', { disabled: false }))
  })

  it('asks for confirmation before removing a key', async () => {
    renderCard(openai)
    openMore('Work')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove…' }))
    expect(mockDelete).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith('openai', 'cred_b'))
  })

  it('renames a key from the menu', async () => {
    renderCard(openai)
    openMore('Personal')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    const row = rows('OpenAI keys')[0]
    fireEvent.change(screen.getByRole('textbox', { name: 'New name for Personal' }), { target: { value: 'Side project' } })
    fireEvent.click(within(row).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith('openai', 'cred_a', { label: 'Side project' }))
  })

  it('tests one key on its own, and says it is verified', async () => {
    renderCard(openai)
    openMore('Work')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Test' }))
    await waitFor(() => expect(useToastStore.getState().toasts.map((t) => t.title)).toContain('Verified'))
    expect(fetchCalls).toContainEqual({ method: 'POST', path: '/api/settings/providers/openai/models', body: { credential_id: 'cred_b' } })
    expect(useToastStore.getState().toasts.find((t) => t.title === 'Verified')?.description).toContain('Work')
  })

  it('says so when a key does not verify, and shows Checking… while it asks', async () => {
    let finish: (r: Response) => void = () => {}
    testReply = () => new Response(null)
    globalThis.fetch = mock(async (...args: unknown[]) => {
      const method = (args[1] as RequestInit | undefined)?.method ?? 'GET'
      if (method === 'POST') return new Promise<Response>((resolve) => { finish = resolve })
      return json({ credentials: [] })
    }) as unknown as typeof fetch
    renderCard(openai)
    openMore('Work')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Test' }))
    expect(await within(rows('OpenAI keys')[1]).findByText('Checking…')).toBeTruthy()
    finish(json({ provider: 'openai', models: [], source: 'provider' }))
    await waitFor(() => expect(useToastStore.getState().toasts.map((t) => t.title)).toContain('Could not verify'))
    expect(within(rows('OpenAI keys')[1]).queryByText('Checking…')).toBeNull()
  })

  it('shows an exported key as a read-only row that puts the stored ones on standby', () => {
    renderCard({ ...openai, env_pinned: true })
    const list = rows('OpenAI keys')
    expect(within(list[0]).getByText('From environment')).toBeTruthy()
    expect(within(list[0]).getByText('Read-only')).toBeTruthy()
    expect(within(list[1]).getByText('Standby')).toBeTruthy()
    expect(within(list[1]).getByText('Standby — not used while OPENAI_API_KEY is set.')).toBeTruthy()
    expect(within(list[1]).queryByText('In use')).toBeNull()
  })
})

describe('ProviderCard — Save checks the key first', () => {
  const type = (key: string) => fireEvent.change(screen.getByPlaceholderText('Paste another API key'), { target: { value: key } })

  it('is one Save: it has nothing to do until a key is typed, and is never called Add key', () => {
    renderCard(openai)
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByRole('button', { name: 'Add key' })).toBeNull()
    type('sk-test-third')
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('checks the key (Checking…), then stores it (Verified) without a separate Test', async () => {
    let release: (value: unknown) => void = () => {}
    mockListModels.mockImplementation(() => new Promise((resolve) => { release = resolve }))
    let storeKey: (value: { id: string }) => void = () => {}
    mockAdd.mockImplementation(() => new Promise<{ id: string }>((resolve) => { storeKey = resolve }))
    renderCard(openai)
    fireEvent.change(screen.getByPlaceholderText('Name (e.g. Work)'), { target: { value: 'Backup' } })
    type('sk-test-third')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByRole('button', { name: 'Checking…' })).toBeTruthy()
    expect(mockAdd).not.toHaveBeenCalled()
    release({ provider: 'openai', models: ['openai:gpt-5.5'], model_costs: {}, source: 'provider' })

    expect(await screen.findByRole('button', { name: 'Verified' })).toBeTruthy()
    await waitFor(() => expect(mockAdd).toHaveBeenCalledTimes(1))
    expect(mockListModels.mock.calls[0]).toEqual(['openai', { api_key: 'sk-test-third', extra: undefined }])
    expect(mockAdd.mock.calls[0]).toEqual(['openai', { label: 'Backup', api_key: 'sk-test-third', extra: undefined }])
    storeKey({ id: 'cred_new' })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy())
    await waitFor(() => expect(useToastStore.getState().toasts.map((t) => t.title)).toContain('Key added'))
    expect((screen.getByPlaceholderText('Paste another API key') as HTMLInputElement).value).toBe('')
  })

  it('shows why a key failed inline, stores nothing, and offers Retry and Save anyway', async () => {
    mockListModels.mockImplementation(() => Promise.resolve({ provider: 'openai', models: [], source: 'provider' }))
    renderCard(openai)
    type('sk-test-third')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('OpenAI did not answer. Check the key or the address.')
    expect(within(alert).getByRole('button', { name: 'Retry' })).toBeTruthy()
    expect(within(alert).getByRole('button', { name: 'Save anyway' })).toBeTruthy()
    expect(mockAdd).not.toHaveBeenCalled()

    // Retry checks again and, now that it passes, stores it.
    mockListModels.mockImplementation(() => modelsOk())
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(mockAdd).toHaveBeenCalledTimes(1))
    expect(mockListModels).toHaveBeenCalledTimes(2)
  })

  it('lets Save anyway store a key the provider could not be asked about', async () => {
    mockListModels.mockImplementation(() => Promise.reject(new Error('socket hang up')))
    renderCard(openai)
    type('sk-test-third')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('socket hang up')
    fireEvent.click(within(alert).getByRole('button', { name: 'Save anyway' }))
    await waitFor(() => expect(mockAdd).toHaveBeenCalledTimes(1))
    // Only the one check, before the failure; Save anyway does not ask again.
    expect(mockListModels).toHaveBeenCalledTimes(1)
    expect(mockAdd.mock.calls[0]).toEqual(['openai', { label: undefined, api_key: 'sk-test-third', extra: undefined }])
  })

  it('clears the error as soon as the key is edited', async () => {
    mockListModels.mockImplementation(() => Promise.resolve({ provider: 'openai', models: [], source: 'provider' }))
    renderCard(openai)
    type('sk-test-third')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByRole('alert')
    type('sk-test-fourth')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('keeps Test for checking a key without saving it', async () => {
    renderCard(openai)
    type('sk-test-third')
    fireEvent.click(screen.getByRole('button', { name: 'Test' }))
    await waitFor(() => expect(mockListModels).toHaveBeenCalledTimes(1))
    expect(mockAdd).not.toHaveBeenCalled()
    await waitFor(() => expect(useToastStore.getState().toasts.map((t) => t.title)).toContain('Connection verified'))
  })
})

describe('ProviderCard — several OAuth accounts', () => {
  it('offers Add account instead of a provider-wide Disconnect', () => {
    renderCard(codex)
    expect(screen.getByRole('button', { name: 'Add account' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Disconnect' })).toBeNull()
    expect(screen.getByText('Reconnect required')).toBeTruthy()
  })

  it('uses the same row as a key: name, "Signed in", status words, a caption', () => {
    renderCard(codex)
    const list = rows('Codex accounts')
    expect(within(list[0]).getByText('me@example.com')).toBeTruthy()
    expect(within(list[0]).getByText('Signed in')).toBeTruthy()
    expect(within(list[0]).getByText('In use')).toBeTruthy()
    expect(within(list[0]).getByText('In use — new messages go to it until it hits its limit.')).toBeTruthy()
    expect(within(list[1]).getByText('The provider ended this sign-in. It is skipped until you reconnect.')).toBeTruthy()
  })

  it('heads the accounts "Tried in this order" too', () => {
    renderCard(codex)
    expect(screen.getByRole('heading', { name: 'Tried in this order' })).toBeTruthy()
    expect(screen.getByText('When one account hits its limit, the next one is used.')).toBeTruthy()
  })

  it('reconnects one account without touching the other', () => {
    renderCard(codex)
    fireEvent.click(within(rows('Codex accounts')[1]).getByRole('button', { name: 'Reconnect' }))
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

  it('signs out only the chosen account, after asking', async () => {
    renderCard(codex)
    expect(within(rows('Codex accounts')[0]).queryByRole('button', { name: /sign out|remove/i })).toBeNull()
    openMore('me@example.com')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sign out…' }))
    expect(mockDisconnectOauth).not.toHaveBeenCalled()
    expect(await screen.findByText('Sign out of “me@example.com”?')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    await waitFor(() => expect(mockDisconnectOauth).toHaveBeenCalledWith('codex', 'cred_me'))
    await waitFor(() => expect(useToastStore.getState().toasts.map((t) => t.title)).toContain('Signed out'))
  })

  it('has the same action set as a key (Sign out in place of Remove), keeping Reconnect visible when needed', async () => {
    renderCard(codex)
    const list = rows('Codex accounts')
    for (const row of list) {
      for (const name of ['Rename', 'Hide', 'Test', 'Use first', 'Move down']) {
        expect(within(row).queryByRole('button', { name })).toBeNull()
      }
    }
    expect(within(list[0]).queryByRole('button', { name: 'Reconnect' })).toBeNull()
    expect(within(list[1]).getByRole('button', { name: 'Reconnect' })).toBeTruthy()

    expect(openMore('me@example.com')).toEqual(['Rename', 'Use first', 'Move down', 'Test', 'Reconnect', 'Hide', 'Sign out…'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move down' }))
    await waitFor(() => expect(mockOrder).toHaveBeenCalledTimes(1))
    expect(mockOrder.mock.calls[0]).toEqual(['codex', ['cred_team', 'cred_me']])
  })

  it('does not offer to test an account that needs a new sign-in', () => {
    renderCard(codex)
    openMore('team@example.com')
    expect((screen.getByRole('menuitem', { name: 'Test' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('renames from the menu', async () => {
    renderCard(codex)
    openMore('me@example.com')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'New name for me@example.com' }), { target: { value: 'Home' } })
    fireEvent.click(within(rows('Codex accounts')[0]).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith('codex', 'cred_me', { label: 'Home' }))
  })

  it('hides an account from the menu', async () => {
    renderCard(codex)
    openMore('team@example.com')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hide' }))
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith('codex', 'cred_team', { disabled: true }))
  })
})
