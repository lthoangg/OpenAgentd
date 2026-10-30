/** Settings → Telemetry: how many days local traces and metrics are kept. */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { setupServer } from '@/__tests__/msw'
import type { ReactNode } from 'react'

mock.module('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => children,
}))

mock.module('@/hooks/use-mobile', () => ({
  useIsMobile: () => false,
}))

import { TelemetrySettingsPage } from '@/components/settings/pages/settings.telemetry'

const server = setupServer()
let originalFetch: typeof fetch | undefined

const TELEMETRY = { retention_days: 90, default_retention_days: 90, max_retention_days: 3650 }
const TELEMETRY_URL = 'http://localhost/api/settings/telemetry'

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
  server.resetHandlers()
  if (originalFetch) globalThis.fetch = originalFetch
  originalFetch = undefined
  server.close()
})

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}><TelemetrySettingsPage /></QueryClientProvider>)
}

describe('TelemetrySettingsPage', () => {
  it('shows the stored retention and saves a new number of days', async () => {
    const bodies: unknown[] = []
    server.use(
      http.get(TELEMETRY_URL, () => HttpResponse.json(TELEMETRY)),
      http.put(TELEMETRY_URL, async ({ request }) => {
        const body = await request.json()
        bodies.push(body)
        return HttpResponse.json({ ...TELEMETRY, ...(body as object) })
      }),
    )
    renderPage()

    const input = await screen.findByLabelText('Days to keep traces and metrics') as HTMLInputElement
    await waitFor(() => expect(input.value).toBe('90'))
    fireEvent.change(input, { target: { value: '30' } })
    fireEvent.click(await screen.findByRole('button', { name: /^save$/i }))

    // A shorter window deletes history, so it asks first and saves nothing yet.
    expect(await screen.findByText('Delete history older than 30 days?')).toBeTruthy()
    expect(bodies).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'Delete and save' }))

    await waitFor(() => expect(bodies).toEqual([{ retention_days: 30 }]))
  })

  it('saves 0 to keep telemetry forever', async () => {
    const bodies: unknown[] = []
    server.use(
      http.get(TELEMETRY_URL, () => HttpResponse.json(TELEMETRY)),
      http.put(TELEMETRY_URL, async ({ request }) => {
        const body = await request.json()
        bodies.push(body)
        return HttpResponse.json({ ...TELEMETRY, ...(body as object) })
      }),
    )
    renderPage()

    const input = await screen.findByLabelText('Days to keep traces and metrics') as HTMLInputElement
    await waitFor(() => expect(input.value).toBe('90'))
    fireEvent.change(input, { target: { value: '0' } })
    expect(await screen.findByText(/everything is kept/i)).toBeTruthy()
    fireEvent.click(await screen.findByRole('button', { name: /^save$/i }))

    await waitFor(() => expect(bodies).toEqual([{ retention_days: 0 }]))
  })

  it('keeps everything from the Keep forever switch, and turning it off restores the default', async () => {
    const bodies: unknown[] = []
    server.use(
      http.get(TELEMETRY_URL, () => HttpResponse.json(TELEMETRY)),
      http.put(TELEMETRY_URL, async ({ request }) => {
        const body = await request.json()
        bodies.push(body)
        return HttpResponse.json({ ...TELEMETRY, ...(body as object) })
      }),
    )
    renderPage()

    const input = await screen.findByLabelText('Days to keep traces and metrics') as HTMLInputElement
    await waitFor(() => expect(input.value).toBe('90'))
    const keep = screen.getByRole('switch', { name: 'Keep forever' })
    expect(keep.getAttribute('aria-checked')).toBe('false')

    fireEvent.click(keep)
    expect(screen.getByRole('switch', { name: 'Keep forever' }).getAttribute('aria-checked')).toBe('true')
    expect(input.disabled).toBe(true)

    fireEvent.click(screen.getByRole('switch', { name: 'Keep forever' }))
    expect(input.disabled).toBe(false)
    expect(input.value).toBe('90')

    fireEvent.click(screen.getByRole('switch', { name: 'Keep forever' }))
    fireEvent.click(await screen.findByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(bodies).toEqual([{ retention_days: 0 }]))
  })

  it.each(['-1', '3651'])('blocks saving %s days', async (value) => {
    let puts = 0
    server.use(
      http.get(TELEMETRY_URL, () => HttpResponse.json(TELEMETRY)),
      http.put(TELEMETRY_URL, () => {
        puts += 1
        return HttpResponse.json(TELEMETRY)
      }),
    )
    renderPage()

    const input = await screen.findByLabelText('Days to keep traces and metrics') as HTMLInputElement
    await waitFor(() => expect(input.value).toBe('90'))
    fireEvent.change(input, { target: { value } })
    expect((await screen.findAllByText(/whole number from 0 to 3650/i)).length).toBeGreaterThan(0)
    const save = screen.getByRole('button', { name: /^save$/i }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.click(save)
    expect(puts).toBe(0)
  })
})
