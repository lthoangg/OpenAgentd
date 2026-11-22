import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { setupServer } from '@/__tests__/msw'

import { ToastStack } from '@/components/ToastStack'
import { useToastStore } from '@/stores/useToastStore'

let desktopMac = false
const cleared = mock(async () => {})
mock.module('@/lib/browser-view', () => ({
  browserViewsAvailable: () => desktopMac,
  clearBrowserProfile: cleared,
}))

import { BrowserSettingsPage } from '@/components/settings/pages/settings.browser'

const server = setupServer()
let originalFetch: typeof fetch | undefined
let saved: unknown[] = []

beforeEach(() => {
  desktopMac = false
  saved = []
  cleared.mockClear()
  useToastStore.setState({ toasts: [] })
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
  useToastStore.setState({ toasts: [] })
  if (originalFetch) globalThis.fetch = originalFetch
  originalFetch = undefined
  server.close()
})

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <BrowserSettingsPage />
      <ToastStack />
    </QueryClientProvider>,
  )
}

const URL_ = 'http://localhost/api/browser/sites'
/** A server that holds `start` and stores what it is sent, naming a pasted address by its host. */
function sites(start: { default: 'ask' | 'allow'; allowed: string[]; blocked: string[] }) {
  let current = start
  server.use(
    http.get(URL_, () => HttpResponse.json(current)),
    http.put(URL_, async ({ request }) => {
      const body = (await request.json()) as typeof start
      saved.push(body)
      if ([...body.allowed, ...body.blocked].some((site) => site.includes(' '))) {
        return HttpResponse.json({ detail: "'not a site' is not a site: write a host such as example.com, or *.example.com for its subdomains." }, { status: 422 })
      }
      const host = (site: string) => site.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '')
      current = { default: body.default, allowed: body.allowed.map(host), blocked: body.blocked.map(host) }
      return HttpResponse.json(current)
    }),
  )
  /** Another window, or the agent's card, changes the rules. */
  return { elsewhere: (next: typeof start) => { current = next } }
}

const section = (title: string) => screen.getByRole('heading', { name: title }).closest('section') as HTMLElement

describe('BrowserSettingsPage', () => {
  it('lists the sites the agent may and may not use', async () => {
    sites({ default: 'ask', allowed: ['threads.net', '*.openagentd.dev'], blocked: ['mybank.example'] })
    renderPage()
    expect(await screen.findByRole('heading', { name: 'Browser' })).toBeTruthy()
    expect(await within(section('Allowed sites')).findByText('threads.net')).toBeTruthy()
    expect(within(section('Allowed sites')).getByText('*.openagentd.dev')).toBeTruthy()
    expect(within(section('Blocked sites')).getByText('mybank.example')).toBeTruthy()
    expect(screen.getByRole('radio', { name: 'Ask for each new site' }).getAttribute('aria-checked')).toBe('true')
  })

  it('says so when a list is empty', async () => {
    sites({ default: 'ask', allowed: [], blocked: [] })
    renderPage()
    expect(await screen.findByText('No allowed sites')).toBeTruthy()
    expect(screen.getByText('No blocked sites')).toBeTruthy()
  })

  it('allows a site at once, as the server names it', async () => {
    sites({ default: 'ask', allowed: [], blocked: ['example.com'] })
    renderPage()
    const input = await screen.findByLabelText('Allow a site')
    fireEvent.change(input, { target: { value: 'https://www.example.com/pricing' } })
    fireEvent.click(within(section('Allowed sites')).getByRole('button', { name: 'Add' }))
    expect(await within(section('Allowed sites')).findByText('example.com')).toBeTruthy()
    // It was blocked: one site is in one list.
    expect(saved).toEqual([{ default: 'ask', allowed: ['https://www.example.com/pricing'], blocked: [] }])
    expect(await screen.findByText('Site allowed')).toBeTruthy()
    expect((input as HTMLInputElement).value).toBe('')
  })

  it('keeps what was typed and says why when it is not a site', async () => {
    sites({ default: 'ask', allowed: [], blocked: [] })
    renderPage()
    const input = await screen.findByLabelText('Block a site')
    fireEvent.change(input, { target: { value: 'not a site' } })
    fireEvent.click(within(section('Blocked sites')).getByRole('button', { name: 'Add' }))
    expect(await within(section('Blocked sites')).findByText(/is not a site/)).toBeTruthy()
    expect((input as HTMLInputElement).value).toBe('not a site')
  })

  it('removes a site and changes the default at once', async () => {
    sites({ default: 'ask', allowed: ['threads.net'], blocked: [] })
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Remove threads.net' }))
    await waitFor(() => expect(saved).toEqual([{ default: 'ask', allowed: [], blocked: [] }]))
    expect(await screen.findByText('No allowed sites')).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: 'Allow all sites' }))
    await waitFor(() => expect(saved[1]).toEqual({ default: 'allow', allowed: [], blocked: [] }))
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Allow all sites' }).getAttribute('aria-checked')).toBe('true'))
  })

  it('keeps a site that was added elsewhere since the page loaded', async () => {
    const server = sites({ default: 'ask', allowed: ['threads.net'], blocked: [] })
    renderPage()
    const remove = await screen.findByRole('button', { name: 'Remove threads.net' })
    server.elsewhere({ default: 'ask', allowed: ['threads.net', 'github.com'], blocked: [] })
    fireEvent.click(remove)
    await waitFor(() => expect(saved).toEqual([{ default: 'ask', allowed: ['github.com'], blocked: [] }]))
    expect(await within(section('Allowed sites')).findByText('github.com')).toBeTruthy()
  })

  it('offers to clear browsing data only where the profile is, and asks first', async () => {
    sites({ default: 'ask', allowed: [], blocked: [] })
    const first = renderPage()
    await screen.findByText('No allowed sites')
    expect(screen.queryByText('Clear browsing data')).toBeNull()
    first.unmount()

    desktopMac = true
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Clear…' }))
    expect(cleared).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByRole('button', { name: 'Clear' }))
    await waitFor(() => expect(cleared).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('Browsing data cleared')).toBeTruthy()
  })
})
