/** Settings → Sessions, History: how many days local traces are kept. */
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

import { SettingsPartsPage } from '@/components/settings/SettingsPartsPage'
import { useHistoryPart } from '@/components/settings/pages/settings.telemetry'

/** The History part alone, in the shell the Sessions page gives it. */
function TelemetrySettingsPage() {
  return <SettingsPartsPage title="Sessions" description="Names, summaries, goals and history." parts={[useHistoryPart()]} />
}
import { ToastStack } from '@/components/ToastStack'
import { useToastStore } from '@/stores/useToastStore'

const server = setupServer()
let originalFetch: typeof fetch | undefined

const TELEMETRY = { retention_days: 90, default_retention_days: 90, max_retention_days: 3650 }
const TELEMETRY_URL = 'http://localhost/api/settings/telemetry'

beforeEach(() => {
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
  if (originalFetch) globalThis.fetch = originalFetch
  originalFetch = undefined
  server.close()
})

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}><TelemetrySettingsPage /><ToastStack /></QueryClientProvider>)
}

describe('Sessions settings: History', () => {
  it('is headed History on the Sessions page, and says so after a save', async () => {
    server.use(
      http.get(TELEMETRY_URL, () => HttpResponse.json(TELEMETRY)),
      http.put(TELEMETRY_URL, async ({ request }) => HttpResponse.json({ ...TELEMETRY, ...((await request.json()) as object) })),
    )
    renderPage()

    expect(await screen.findByRole('heading', { level: 1, name: 'Sessions' })).toBeTruthy()
    expect(await screen.findByRole('heading', { name: 'History' })).toBeTruthy()
    expect(screen.queryByText('Retention')).toBeNull()
    const input = await screen.findByLabelText('Days to keep usage history') as HTMLInputElement
    await waitFor(() => expect(input.value).toBe('90'))
    // Longer than the saved window, so nothing is deleted and no confirmation is asked.
    fireEvent.change(input, { target: { value: '120' } })
    fireEvent.click(await screen.findByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(useToastStore.getState().toasts.map((t) => t.title)).toContain('Usage history setting saved'))
  })

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

    const input = await screen.findByLabelText('Days to keep usage history') as HTMLInputElement
    await waitFor(() => expect(input.value).toBe('90'))
    fireEvent.change(input, { target: { value: '30' } })
    fireEvent.click(await screen.findByRole('button', { name: /^save$/i }))

    // A shorter window deletes history, so it asks first and saves nothing yet.
    expect(await screen.findByText('Delete history older than 30 days?')).toBeTruthy()
    expect(bodies).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'Delete and save' }))

    await waitFor(() => expect(bodies).toEqual([{ retention_days: 30 }]))
  })

  it('does not take 0 in the days field: forever is the switch', async () => {
    let puts = 0
    server.use(
      http.get(TELEMETRY_URL, () => HttpResponse.json(TELEMETRY)),
      http.put(TELEMETRY_URL, () => {
        puts += 1
        return HttpResponse.json(TELEMETRY)
      }),
    )
    renderPage()

    const input = await screen.findByLabelText('Days to keep usage history') as HTMLInputElement
    await waitFor(() => expect(input.value).toBe('90'))
    fireEvent.change(input, { target: { value: '0' } })

    // The field stays, with the 0 in it and why it cannot be saved.
    expect((screen.getByLabelText('Days to keep usage history') as HTMLInputElement).value).toBe('0')
    expect((await screen.findAllByText(/whole number from 1 to 3650/i)).length).toBeGreaterThan(0)
    expect(screen.getByRole('switch', { name: 'Keep usage history forever' }).getAttribute('aria-checked')).toBe('false')
    expect((screen.getByRole('button', { name: /^save$/i }) as HTMLButtonElement).disabled).toBe(true)
    expect(puts).toBe(0)
  })

  it('keeps everything from the forever switch, which folds the days row away, and turning it off restores the default', async () => {
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

    const input = await screen.findByLabelText('Days to keep usage history') as HTMLInputElement
    await waitFor(() => expect(input.value).toBe('90'))
    const keep = screen.getByRole('switch', { name: 'Keep usage history forever' })
    expect(keep.getAttribute('aria-checked')).toBe('false')

    fireEvent.click(keep)
    expect(screen.getByRole('switch', { name: 'Keep usage history forever' }).getAttribute('aria-checked')).toBe('true')
    // A row that cannot be used takes no room.
    expect(screen.queryByLabelText('Days to keep usage history')).toBeNull()

    fireEvent.click(screen.getByRole('switch', { name: 'Keep usage history forever' }))
    expect((screen.getByLabelText('Days to keep usage history') as HTMLInputElement).value).toBe('90')

    fireEvent.click(screen.getByRole('switch', { name: 'Keep usage history forever' }))
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

    const input = await screen.findByLabelText('Days to keep usage history') as HTMLInputElement
    await waitFor(() => expect(input.value).toBe('90'))
    fireEvent.change(input, { target: { value } })
    expect((await screen.findAllByText(/whole number from 1 to 3650/i)).length).toBeGreaterThan(0)
    const save = screen.getByRole('button', { name: /^save$/i }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.click(save)
    expect(puts).toBe(0)
  })
})
