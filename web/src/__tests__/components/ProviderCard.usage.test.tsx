import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import type { ProviderInfo, StoredCredential } from '@/api/client'
import { ProviderCard } from '@/components/settings/pages/settings.providers/ProviderCard'
import { queryKeys } from '@/queries'
import { useToastStore } from '@/stores/useToastStore'

const originalFetch = globalThis.fetch
type Call = { path: string; credential: string | null; method: string; force: string | null }
let calls: Call[] = []
let respond: (call: Call) => Response | Promise<Response> = () => new Response('{}', { status: 404 })

beforeEach(() => {
  calls = []
  globalThis.fetch = mock(async (...args: unknown[]) => {
    const url = new URL(String(args[0]), 'http://localhost')
    const call: Call = {
      path: url.pathname,
      credential: url.searchParams.get('credential_id'),
      method: (args[1] as RequestInit | undefined)?.method ?? 'GET',
      force: url.searchParams.get('force_refresh'),
    }
    calls.push(call)
    return respond(call)
  }) as unknown as typeof fetch
})
afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
})

const usageCalls = () => calls.filter((c) => c.path.endsWith('/usage'))
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const limit = (pct: number, extra: object = {}) => ({ limit_id: 'a', limit_name: 'Session', primary: { used_percent: pct, window_minutes: 300, resets_at: null }, ...extra })

function usageByCredential(map: Record<string, number | Response>) {
  respond = (call) => {
    if (!call.path.endsWith('/usage')) return new Response('{}', { status: 404 })
    const hit = map[call.credential ?? '']
    if (hit instanceof Response) return hit.clone()
    if (typeof hit === 'number') return json({ provider: 'codex', limits: [limit(hit)] })
    return json({ provider: 'codex', limits: [] })
  }
}

function renderCard(provider: ProviderInfo, defaultExpanded = true) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ProviderCard provider={provider} defaultExpanded={defaultExpanded} />
    </QueryClientProvider>,
  )
  return { ...view, queryClient }
}

function cred(overrides: Partial<StoredCredential>): StoredCredential {
  return {
    id: 'cred_a', label: 'Personal', disabled: false, kind: 'oauth', hint: null, settings: {},
    status: 'ready', in_use: false, cooldown_until: null, cooldown_reason: null, ...overrides,
  }
}

const codex: ProviderInfo = {
  id: 'codex', label: 'Codex', description: 'Codex sign-in.', kind: 'oauth', credentials: [], saved_credentials: {},
  env_var: '', env_vars: [], oauth_command: '', docs_url: '', is_configured: true, is_saved: true, is_reachable: true,
  cached_models: [], visible_models: [], is_disconnected: false, supports_fast_mode: false, public_access: false,
  env_pinned: false, supports_multiple_credentials: true, supports_credential_usage: true, supports_usage: true,
  stored_credentials: [cred({ id: 'cred_a', label: 'Personal', in_use: true }), cred({ id: 'cred_b', label: 'Work' })],
}

const rowFor = (label: string) => {
  const row = screen.getByText(label).closest('[role="listitem"]') as HTMLElement | null
  if (!row) throw new Error(`no row for ${label}`)
  return row
}

describe('ProviderCard — usage per sign-in profile', () => {
  it('shows usage on every enabled account automatically, with no provider-wide Usage block', async () => {
    usageByCredential({ cred_a: 23, cred_b: 61 })
    renderCard(codex)
    expect(await within(rowFor('Personal')).findByText('23% used')).toBeTruthy()
    expect(await within(rowFor('Work')).findByText('61% used')).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Usage' })).toBeNull()
    expect(screen.queryByText('Usage')).toBeNull()
    expect(screen.queryByText('Show usage')).toBeNull()
    expect(usageCalls().map((c) => c.credential).sort((a, b) => String(a).localeCompare(String(b)))).toEqual(['cred_a', 'cred_b'])
  })

  it('does the same for a single account', async () => {
    usageByCredential({ cred_a: 9 })
    renderCard({ ...codex, stored_credentials: [cred({ id: 'cred_a', label: 'Personal', in_use: true })] })
    expect(await within(rowFor('Personal')).findByText('9% used')).toBeTruthy()
    expect(usageCalls()).toHaveLength(1)
    expect(usageCalls()[0].credential).toBe('cred_a')
  })

  it('does not request usage for disabled or reconnect-required accounts', async () => {
    usageByCredential({ cred_a: 5 })
    renderCard({
      ...codex,
      stored_credentials: [
        cred({ id: 'cred_a', label: 'Personal' }),
        cred({ id: 'cred_b', label: 'Work', disabled: true, status: 'disabled' }),
        cred({ id: 'cred_c', label: 'Old', status: 'needs_reconnect' }),
      ],
    })
    await within(rowFor('Personal')).findByText('5% used')
    await new Promise((r) => setTimeout(r, 30))
    expect(usageCalls().map((c) => c.credential)).toEqual(['cred_a'])
    expect(within(rowFor('Work')).getByRole('button', { name: 'Enable' })).toBeTruthy()
    expect(within(rowFor('Old')).getByRole('button', { name: 'Reconnect' })).toBeTruthy()
  })

  it('requests nothing while the provider is collapsed, and starts when it opens', async () => {
    usageByCredential({ cred_a: 5, cred_b: 6 })
    renderCard(codex, false)
    await new Promise((r) => setTimeout(r, 30))
    expect(usageCalls()).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: /Codex/ }))
    await within(rowFor('Personal')).findByText('5% used')
    expect(usageCalls()).toHaveLength(2)
  })

  it('requests nothing when the provider has no usage', async () => {
    usageByCredential({ cred_a: 5 })
    renderCard({ ...codex, supports_usage: false })
    await new Promise((r) => setTimeout(r, 30))
    expect(usageCalls()).toHaveLength(0)
    expect(screen.getByText('Personal')).toBeTruthy()
  })

  it('shows the plan name in the header when the source reports one, and nothing when it does not', async () => {
    respond = (call) =>
      json({ provider: 'codex', limits: [limit(1, call.credential === 'cred_a' ? { plan_type: 'Max' } : {})] })
    renderCard(codex)
    await within(rowFor('Personal')).findByText('1% used')
    await within(rowFor('Work')).findByText('1% used')
    expect(within(rowFor('Personal')).getByText('Max')).toBeTruthy()
    expect(within(rowFor('Work')).queryByText('Max')).toBeNull()
  })

  it('keeps an exported credential in its own row, apart from stored accounts', async () => {
    respond = (call) => {
      if (!call.path.endsWith('/usage')) return new Response('{}', { status: 404 })
      return json({ provider: 'codex', limits: [limit(call.credential === null ? 77 : 11)] })
    }
    renderCard({ ...codex, env_pinned: true, env_var: 'CODEX_TOKEN', stored_credentials: [cred({ id: 'cred_a', label: 'Personal' })] })
    const env = rowFor('From environment')
    expect(await within(env).findByText('77% used')).toBeTruthy()
    expect(within(env).queryByText('11% used')).toBeNull()
    const stored = rowFor('Personal')
    expect(await within(stored).findByText('11% used')).toBeTruthy()
    expect(within(stored).queryByText('77% used')).toBeNull()
  })

  it('gives a sign-in with no per-account usage one explicit row, not an outer block', async () => {
    usageByCredential({ '': 42 })
    renderCard({ ...codex, stored_credentials: [], supports_credential_usage: false })
    const row = rowFor('Provider sign-in')
    expect(await within(row).findByText('42% used')).toBeTruthy()
    expect(usageCalls()).toHaveLength(1)
    expect(usageCalls()[0].credential).toBeNull()
    expect(screen.queryByRole('region', { name: 'Usage' })).toBeNull()
  })

  it('still shows an older backend’s sign-in (no capability flags) as one row', async () => {
    usageByCredential({ '': 42 })
    const { supports_usage: _a, supports_credential_usage: _b, supports_multiple_credentials: _c, ...legacy } = codex
    renderCard({ ...legacy, id: 'plugin-oauth', label: 'Plugin', stored_credentials: undefined })
    expect(await within(rowFor('Provider sign-in')).findByText('42% used')).toBeTruthy()
  })

  it('keeps API-key usage as the provider-wide block it was', async () => {
    usageByCredential({ '': 3 })
    renderCard({
      ...codex, id: 'openai', label: 'OpenAI', kind: 'api_key', stored_credentials: [], supports_credential_usage: false,
      credentials: [], env_var: 'OPENAI_API_KEY', saved_credentials: {},
    })
    expect(await screen.findByText('3% used')).toBeTruthy()
    expect(screen.getByText('Usage')).toBeTruthy()
    expect(usageCalls()).toHaveLength(1)
  })
})

describe('ProviderCard — usage states', () => {
  const retryIn = (s: number) => Date.now() / 1000 + s
  const rateLimited = (s: number, lastGood: object | null) =>
    json({ detail: { code: 'usage_rate_limited', message: 'Usage is rate-limited.', retry_at: retryIn(s), retry_after: s, last_good: lastGood } }, 429)
  const one = { ...codex, stored_credentials: [cred({ id: 'cred_a', label: 'Personal', in_use: true })] }

  it('shows a countdown and the stale snapshot with its original time on a 429', async () => {
    const updated = Math.floor(Date.now() / 1000) - 240
    usageByCredential({ cred_a: rateLimited(188, { provider: 'codex', stale: true, updated_at: updated, limits: [limit(40)] }) })
    renderCard(one)
    const row = rowFor('Personal')
    expect(await within(row).findByText('Usage is rate-limited')).toBeTruthy()
    expect(within(row).getByText(/Retry in 3m \d\ds/)).toBeTruthy()
    expect(within(row).getByText('40% used')).toBeTruthy()
    expect(within(row).getByText('Last updated 4m ago')).toBeTruthy()
    expect(within(row).queryByText(/^Updated/)).toBeNull()
    expect((within(row).getByRole('button', { name: /Refresh usage/ }) as HTMLButtonElement).disabled).toBe(true)
    // Not an auth problem, and not a quota problem.
    expect(within(row).queryByText('Reconnect required')).toBeNull()
    expect(within(row).queryByText(/limit reached/i)).toBeNull()
    expect(within(row).getByText('Updates paused until retry time')).toBeTruthy()
  })

  it('says there is no snapshot yet (and that quota is not exhausted) when a 429 has none', async () => {
    usageByCredential({ cred_a: rateLimited(188, null) })
    renderCard(one)
    const row = rowFor('Personal')
    expect(await within(row).findByText('Usage is rate-limited')).toBeTruthy()
    expect(within(row).getByText('No usage snapshot yet.')).toBeTruthy()
    expect(within(row).getByText(/does not mean the account is out of quota/)).toBeTruthy()
    expect(within(row).queryByRole('progressbar')).toBeNull()
  })

  it('keeps the numbers on screen when a later refresh fails for a transient reason', async () => {
    let n = 0
    respond = () => (++n === 1 ? json({ provider: 'codex', limits: [limit(33)] }) : json({ detail: { code: 'usage_unavailable', message: 'Usage is unavailable.' } }, 502))
    renderCard(one)
    const row = rowFor('Personal')
    await within(row).findByText('33% used')
    fireEvent.click(within(row).getByRole('button', { name: /Refresh usage/ }))
    expect(await within(row).findByText('Could not refresh usage')).toBeTruthy()
    expect(within(row).getByText('33% used')).toBeTruthy()
    expect(within(row).getByText(/Last updated/)).toBeTruthy()
  })

  it('asks to reconnect on a credentials error instead of showing stale numbers', async () => {
    usageByCredential({
      cred_a: json({ detail: { code: 'usage_credentials', message: 'Sign-in needs attention.', last_good: { provider: 'codex', updated_at: 5, limits: [limit(40)] } } }, 401),
    })
    renderCard(one)
    const row = rowFor('Personal')
    expect(await within(row).findByText('Sign-in needs attention')).toBeTruthy()
    expect(within(row).getByRole('button', { name: 'Reconnect' })).toBeTruthy()
    expect(within(row).queryByText('40% used')).toBeNull()
    // Nothing more to ask until the account is signed in again.
    expect((within(row).getByRole('button', { name: /Refresh usage/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('forces a fresh read only when the Refresh button is pressed', async () => {
    respond = () => json({ provider: 'codex', limits: [limit(33)] })
    renderCard(one)
    const row = rowFor('Personal')
    await within(row).findByText('33% used')
    expect(usageCalls().map((c) => c.force)).toEqual([null])
    fireEvent.click(within(row).getByRole('button', { name: /Refresh usage/ }))
    await waitFor(() => expect(usageCalls()).toHaveLength(2))
    expect(usageCalls()[1].force).toBe('true')
    expect(usageCalls()[1].credential).toBe('cred_a')
  })

  it('shows a short unavailable state when there never was data', async () => {
    usageByCredential({ cred_a: json({ detail: { code: 'usage_unavailable', message: 'Usage is unavailable.' } }, 502) })
    renderCard(one)
    expect(await within(rowFor('Personal')).findByText('Usage is unavailable right now.')).toBeTruthy()
  })

  it('does not show numbers older than 30 minutes once a refresh has failed', async () => {
    const old = Math.floor(Date.now() / 1000) - 40 * 60
    usageByCredential({ cred_a: rateLimited(188, { provider: 'codex', stale: true, updated_at: old, limits: [limit(40)] }) })
    renderCard(one)
    const row = rowFor('Personal')
    expect(await within(row).findByText('Usage is rate-limited')).toBeTruthy()
    expect(within(row).queryByText('40% used')).toBeNull()
    expect(within(row).getByText('No usage snapshot yet.')).toBeTruthy()
  })

  it('does not refetch usage when the provider list is refreshed or cancelled', async () => {
    respond = (call) => (call.path.endsWith('/usage') ? json({ provider: 'codex', limits: [limit(10)] }) : json({}))
    const { queryClient } = renderCard(codex)
    await within(rowFor('Personal')).findByText('10% used')
    await within(rowFor('Work')).findByText('10% used')
    expect(usageCalls()).toHaveLength(2)
    await queryClient.cancelQueries({ queryKey: queryKeys.settings.providers() })
    await queryClient.invalidateQueries({ queryKey: queryKeys.settings.providers() })
    await new Promise((r) => setTimeout(r, 50))
    expect(usageCalls()).toHaveLength(2)
  })

  it('does not refetch any usage after a rename', async () => {
    respond = (call) => (call.path.endsWith('/usage') ? json({ provider: 'codex', limits: [limit(10)] }) : json({}))
    renderCard(codex)
    await within(rowFor('Personal')).findByText('10% used')
    await within(rowFor('Work')).findByText('10% used')
    fireEvent.click(screen.getByRole('button', { name: 'Manage Personal' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'New name for Personal' }), { target: { value: 'Home' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true))
    await new Promise((r) => setTimeout(r, 80))
    expect(usageCalls()).toHaveLength(2)
  })

  it('does not refetch any usage after reordering', async () => {
    respond = (call) => (call.path.endsWith('/usage') ? json({ provider: 'codex', limits: [limit(10)] }) : json({}))
    renderCard(codex)
    await within(rowFor('Personal')).findByText('10% used')
    await within(rowFor('Work')).findByText('10% used')
    fireEvent.click(screen.getByRole('button', { name: 'Manage Personal' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Try later' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true))
    await new Promise((r) => setTimeout(r, 80))
    expect(usageCalls()).toHaveLength(2)
  })

  it('says a failed reset failed in fixed words, never with the server’s text', async () => {
    useToastStore.setState({ toasts: [] })
    respond = (call) => {
      if (call.path.endsWith('/reset')) return json({ detail: { message: 'upstream said: secret-internal-detail' } }, 500)
      return json({ provider: 'codex', limits: [limit(100, { reset_credits_available: 1 })] })
    }
    renderCard(one)
    const row = rowFor('Personal')
    await within(row).findByText('100% used')
    fireEvent.click(within(row).getByRole('button', { name: 'Redeem reset' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Redeem reset' }))
    await waitFor(() => expect(useToastStore.getState().toasts.length).toBeGreaterThan(0))
    const toast = useToastStore.getState().toasts[0]
    expect(toast.title).toBe('Reset failed')
    expect(JSON.stringify(toast)).not.toContain('secret-internal-detail')
  })

  it('renders a loading state first', () => {
    respond = () => new Promise<Response>(() => undefined)
    renderCard(one)
    expect(within(rowFor('Personal')).getByRole('status').textContent).toContain('Loading usage')
  })

  it('sends a usage reset for the account whose usage it is', async () => {
    respond = (call) => {
      if (call.path.endsWith('/reset')) return json({ provider: 'codex', limits: [limit(0)] })
      return json({ provider: 'codex', limits: [limit(100, { reset_credits_available: 1 })] })
    }
    renderCard({ ...codex, stored_credentials: [cred({ id: 'cred_a', label: 'Personal' }), cred({ id: 'cred_b', label: 'Work' })] })
    const row = rowFor('Work')
    await within(row).findByText('100% used')
    fireEvent.click(within(row).getByRole('button', { name: 'Redeem reset' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Redeem reset' }))
    await waitFor(() => expect(calls.some((c) => c.path.endsWith('/reset'))).toBe(true))
    const reset = calls.filter((c) => c.path.endsWith('/reset'))
    expect(reset).toHaveLength(1)
    expect(reset[0]).toMatchObject({ credential: 'cred_b', method: 'POST' })
  })
})
