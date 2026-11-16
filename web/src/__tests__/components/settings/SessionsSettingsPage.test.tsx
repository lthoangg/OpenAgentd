/** Settings → Sessions: four small pages on one, under one save bar. */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import type { ReactNode } from 'react'

import { setupServer } from '@/__tests__/msw'

mock.module('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => children,
}))

mock.module('@/hooks/use-mobile', () => ({
  useIsMobile: () => false,
}))

import { SessionsSettingsPage } from '@/components/settings/pages/settings.sessions'
import { useToastStore } from '@/stores/useToastStore'

const server = setupServer()
let originalFetch: typeof fetch | undefined

const GOALS = { max_turns: 50, default_max_turns: 50, token_budget: null, allow_questions: false, keep_going_default: false }
const TELEMETRY = { retention_days: 90, default_retention_days: 90, max_retention_days: 3650 }

/** Every PUT the page makes, by resource. */
let saved: string[] = []

function handlers() {
  const put = (name: string, current: object) =>
    http.put(`http://localhost/api/settings/${name}`, async ({ request }) => {
      saved.push(name)
      return HttpResponse.json({ ...current, ...((await request.json()) as object) })
    })
  return [
    http.get('http://localhost/api/settings/title-generation', () => HttpResponse.json({ enabled: true, model: 'codex:gpt-5.5-mini', update_after_compaction: false })),
    http.get('http://localhost/api/settings/summarization', () => HttpResponse.json({ prompt_token_threshold: null })),
    http.get('http://localhost/api/settings/goals', () => HttpResponse.json(GOALS)),
    http.get('http://localhost/api/settings/telemetry', () => HttpResponse.json(TELEMETRY)),
    http.get('http://localhost/api/agents/registry', () => HttpResponse.json({ agents: [], skills: [], tools: [], models: [{ id: 'codex:gpt-5.5-mini' }] })),
    put('title-generation', {}),
    put('summarization', {}),
    put('goals', GOALS),
    put('telemetry', TELEMETRY),
  ]
}

beforeEach(() => {
  saved = []
  useToastStore.setState({ toasts: [] })
  server.listen()
  server.use(...handlers())
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

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}><SessionsSettingsPage /></QueryClientProvider>)
}

describe('Settings → Sessions', () => {
  it('keeps the other parts when one cannot be read, and says which one failed', async () => {
    server.use(http.get('http://localhost/api/settings/goals', () => HttpResponse.json({ detail: 'goals are broken' }, { status: 500 })))
    renderPage()

    expect(await screen.findByText("Couldn't load Goals")).toBeTruthy()
    // Titles, Summaries and History still load and can be changed.
    expect(await screen.findByRole('switch', { name: 'Name sessions automatically' })).toBeTruthy()
    expect(screen.getByRole('switch', { name: 'Keep usage history forever' })).toBeTruthy()
    expect(screen.queryByRole('switch', { name: 'Keep going after approval' })).toBeNull()
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['Titles', 'Summaries', 'Goals', 'History'])
  })

  it('says why Save is off when a summary field is wrong', async () => {
    renderPage()
    fireEvent.click(await screen.findByRole('switch', { name: 'Summarize idle sessions' }))
    fireEvent.change(await screen.findByRole('spinbutton', { name: /Only once it is this full/ }), { target: { value: '150' } })
    expect(await screen.findByText('Fix how full an idle session must be to save.')).toBeTruthy()
  })

  it('holds what were four pages under four headings, in order', async () => {
    renderPage()

    await screen.findByRole('switch', { name: 'Keep going after approval' })
    expect(screen.getByRole('heading', { level: 1, name: 'Sessions' })).toBeTruthy()
    const headings = screen.getAllByRole('heading').map((h) => h.textContent).filter((text) => text !== 'Sessions')
    expect(headings).toEqual(['Titles', 'Summaries', 'Goals', 'History'])
  })

  it('shows no save bar until something changes, then saves only the part that changed', async () => {
    renderPage()

    const keepGoing = await screen.findByRole('switch', { name: 'Keep going after approval' })
    await waitFor(() => expect(keepGoing.getAttribute('aria-checked')).toBe('false'))
    expect(screen.queryByRole('button', { name: /^save$/i })).toBeNull()

    fireEvent.click(keepGoing)
    fireEvent.click(await screen.findByRole('button', { name: /^save$/i }))

    await waitFor(() => expect(saved).toEqual(['goals']))
  })

  it('saves two edited parts with one Save', async () => {
    renderPage()

    const keepGoing = await screen.findByRole('switch', { name: 'Keep going after approval' })
    await waitFor(() => expect(keepGoing.getAttribute('aria-checked')).toBe('false'))
    fireEvent.click(keepGoing)
    fireEvent.click(screen.getByRole('switch', { name: 'Summarize idle sessions' }))
    fireEvent.click(await screen.findByRole('button', { name: /^save$/i }))

    await waitFor(() => expect([...saved].sort()).toEqual(['goals', 'summarization']))
  })

  it('does not let a mistake under one heading block saving another', async () => {
    renderPage()

    const keepGoing = await screen.findByRole('switch', { name: 'Keep going after approval' })
    await waitFor(() => expect(keepGoing.getAttribute('aria-checked')).toBe('false'))
    fireEvent.change(screen.getByLabelText('Summarize when a session reaches'), { target: { value: '0' } })
    expect(await screen.findByText('A whole number of tokens, or empty for Auto.')).toBeTruthy()

    fireEvent.click(keepGoing)
    fireEvent.click(await screen.findByRole('button', { name: /^save$/i }))

    await waitFor(() => expect(saved).toEqual(['goals']))
  })
})
