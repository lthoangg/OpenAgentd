/** Settings → Server: the switch for direct sessions with the account's devices. */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { setupServer } from '@/__tests__/msw'

import type { CloudStatus } from '@/api/cloud'
import { DirectSessionsCard, directFirewallNote } from '@/components/DirectSessionsCard'

const server = setupServer()
let originalFetch: typeof fetch | undefined
const STATUS_URL = 'http://localhost/api/cloud/status'
const SETTING_URL = 'http://localhost/api/cloud/direct/setting'

const connected = (server_: boolean): CloudStatus => ({
  state: 'connected', fingerprint: 'AB12', signer: true, server: server_, client: true, relay: { state: 'online' }, sessions: 0,
})

beforeEach(() => {
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
  cleanup()
  server.resetHandlers()
  if (originalFetch) globalThis.fetch = originalFetch
  originalFetch = undefined
  server.close()
})

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><DirectSessionsCard /></QueryClientProvider>)
}

describe('DirectSessionsCard', () => {
  it('is on by default for a server of the account and names the port', async () => {
    server.use(
      http.get(STATUS_URL, () => HttpResponse.json(connected(true))),
      http.get(SETTING_URL, () => HttpResponse.json({ on: true, port: 4181 })),
    )
    renderCard()
    const toggle = await screen.findByRole('switch', { name: /connect directly on this network/i })
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'))
    expect(screen.getByText(/Listening on port 4181/)).toBeTruthy()
    expect(screen.queryByText(/access key/i)).toBeNull()
  })

  it('turns direct sessions off through the local route', async () => {
    let posted: unknown = null
    server.use(
      http.get(STATUS_URL, () => HttpResponse.json(connected(true))),
      http.get(SETTING_URL, () => HttpResponse.json({ on: true, port: 4181 })),
      http.post(SETTING_URL, async ({ request }) => {
        posted = await request.json()
        return HttpResponse.json({ on: false, port: null })
      }),
    )
    renderCard()
    const toggle = await screen.findByRole('switch', { name: /connect directly/i })
    await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false))
    await userEvent.click(toggle)
    await waitFor(() => expect(posted).toEqual({ on: false }))
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'))
    expect(screen.getByText('Your devices connect through your account.')).toBeTruthy()
  })

  it('is not shown on a computer that is not a server of the account', async () => {
    let asked = false
    server.use(
      http.get(STATUS_URL, () => HttpResponse.json(connected(false))),
      http.get(SETTING_URL, () => { asked = true; return HttpResponse.json({ on: true, port: 4181 }) }),
    )
    const { container } = renderCard()
    await act(async () => { await new Promise((r) => setTimeout(r, 50)) })
    expect(container.textContent).toBe('')
    expect(asked).toBe(false)
  })

  it('mentions the one-time OS prompt on macOS and Windows only', () => {
    expect(directFirewallNote('macos')).toContain('macOS asks once')
    expect(directFirewallNote('windows')).toContain('private networks')
    expect(directFirewallNote('linux')).toBeNull()
  })
})
