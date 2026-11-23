import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ProviderInfo } from '@/api/client'
import { ProviderCard } from '@/components/settings/pages/settings.models/ProviderCard'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))
const opened: string[] = []
mock.module('@/lib/open-external', () => ({ openExternalUrl: async (url: string) => { opened.push(url) } }))
mock.module('@/api/client', () => ({
  listProviders: () => Promise.resolve({ providers: [] }),
  getProviderUsage: () => Promise.reject(new Error('no usage')),
  configureDefaultModel: () => Promise.resolve({ agents_updated: 0 }),
}))

const dash = 'https://dash.cloudflare.com/?to=/:account/ai/workers-ai'
const cloudflare: ProviderInfo = {
  id: 'cf',
  label: 'Cloudflare',
  description: 'Workers AI models.',
  kind: 'cloud_creds',
  credentials: [
    { name: 'CLOUDFLARE_ACCOUNT_ID', label: 'Account ID', secret: false, required: true, placeholder: '32-character account ID', help: 'Copy Account ID.', help_url: dash },
    { name: 'CLOUDFLARE_API_TOKEN', label: 'API token', secret: true, required: true, placeholder: '••••', help: 'It needs Account → Workers AI → Read.' },
  ],
  saved_credentials: {},
  env_var: '',
  env_vars: ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'],
  oauth_command: '',
  docs_url: '',
  is_configured: false,
  is_saved: false,
  is_reachable: null,
  cached_models: [],
  visible_models: [],
  is_disconnected: false,
  supports_fast_mode: false,
  public_access: false,
}

function renderCard(provider: ProviderInfo) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ProviderCard provider={provider} defaultExpanded />
    </QueryClientProvider>,
  )
}

describe('ProviderCard — cloud credential fields', () => {
  afterEach(cleanup)

  it('describes each field with its help text', () => {
    renderCard(cloudflare)
    const account = screen.getByLabelText('Account ID')
    expect(account.getAttribute('aria-describedby')).toBeTruthy()
    expect(document.getElementById(account.getAttribute('aria-describedby')!)?.textContent).toContain('Copy Account ID.')
    expect(screen.getByText('It needs Account → Workers AI → Read.')).toBeDefined()
  })

  it('opens the help page for a field that has one, and offers no link for one that does not', () => {
    opened.length = 0
    renderCard(cloudflare)
    const links = screen.getAllByRole('button', { name: /^Open where to get the/ })
    expect(links.map((b) => b.textContent)).toEqual(['Open where to get the Account ID'])
    fireEvent.click(links[0])
    expect(opened).toEqual([dash])
  })

  it('shows no help line for a field without help', () => {
    renderCard({ ...cloudflare, credentials: [{ name: 'X', label: 'Region', secret: false, required: true, placeholder: '' }] })
    expect(screen.getByLabelText('Region').getAttribute('aria-describedby')).toBeNull()
    expect(screen.queryByRole('button', { name: /^Open where to get/ })).toBeNull()
  })
})
