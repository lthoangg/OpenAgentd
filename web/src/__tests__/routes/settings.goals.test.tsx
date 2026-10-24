/** Settings → Goals: the `/goal` turn limit, token budget, and the questions opt-in. */
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

import { GoalsSettingsPage } from '@/components/settings/pages/settings.goals'

const server = setupServer()
let originalFetch: typeof fetch | undefined

const GOALS = { max_turns: 50, default_max_turns: 50, token_budget: null, allow_questions: false }

function handlers() {
  return [http.get('http://localhost/api/settings/goals', () => HttpResponse.json(GOALS))]
}

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
  return render(<QueryClientProvider client={queryClient}><GoalsSettingsPage /></QueryClientProvider>)
}

describe('GoalsSettingsPage', () => {
  it('keeps questions off by default and saves the opt-in with a new turn limit', async () => {
    const bodies: unknown[] = []
    server.use(
      ...handlers(),
      http.put('http://localhost/api/settings/goals', async ({ request }) => {
        const body = await request.json()
        bodies.push(body)
        return HttpResponse.json({ ...GOALS, ...(body as object) })
      }),
    )
    renderPage()

    const questions = await screen.findByRole('switch', { name: /let the agent ask me questions during a goal/i })
    await waitFor(() => expect(questions.getAttribute('aria-checked')).toBe('false'))
    fireEvent.click(questions)
    fireEvent.change(screen.getByLabelText('Turns per goal'), { target: { value: '20' } })
    fireEvent.click(await screen.findByRole('button', { name: /^save$/i }))

    await waitFor(() => expect(bodies).toEqual([{ max_turns: 20, token_budget: null, allow_questions: true }]))
  })

  it('sets a default token budget, and empties it to remove the budget', async () => {
    const bodies: unknown[] = []
    let stored: number | null = null
    server.use(
      http.get('http://localhost/api/settings/goals', () => HttpResponse.json({ ...GOALS, token_budget: stored })),
      http.put('http://localhost/api/settings/goals', async ({ request }) => {
        const body = await request.json() as { token_budget: number | null }
        bodies.push(body.token_budget)
        stored = body.token_budget
        return HttpResponse.json({ ...GOALS, ...body })
      }),
    )
    renderPage()

    const budget = await screen.findByLabelText('Token budget per goal') as HTMLInputElement
    expect(budget.value).toBe('')
    fireEvent.change(budget, { target: { value: '2000000' } })
    expect(await screen.findByText(/Now 2M\./)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(bodies).toEqual([2_000_000]))

    await waitFor(() => expect(budget.value).toBe('2000000'))
    fireEvent.change(budget, { target: { value: '' } })
    fireEvent.click(await screen.findByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(bodies).toEqual([2_000_000, null]))
  })

  it('blocks saving a token budget below one', async () => {
    let puts = 0
    server.use(...handlers(), http.put('http://localhost/api/settings/goals', () => {
      puts += 1
      return HttpResponse.json(GOALS)
    }))
    renderPage()

    const budget = await screen.findByLabelText('Token budget per goal')
    fireEvent.change(budget, { target: { value: '0' } })
    expect(await screen.findByText(/whole number of tokens, or empty for no budget/i)).toBeTruthy()
    const save = screen.getByRole('button', { name: /^save$/i }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    expect(puts).toBe(0)
  })

  it('offers no separate check model, so the check keeps the prompt cache', async () => {
    server.use(...handlers())
    renderPage()

    await screen.findByLabelText('Turns per goal')
    expect(screen.queryByLabelText(/check model/i)).toBeNull()
  })

  it.each(['0', '1001'])('blocks saving a turn limit of %s', async (value) => {
    let puts = 0
    server.use(...handlers(), http.put('http://localhost/api/settings/goals', () => {
      puts += 1
      return HttpResponse.json(GOALS)
    }))
    renderPage()

    const input = await screen.findByLabelText('Turns per goal')
    await waitFor(() => expect((input as HTMLInputElement).value).toBe('50'))
    fireEvent.change(input, { target: { value } })
    expect(await screen.findByText(/whole number from 1 to 1000/i)).toBeTruthy()
    const save = screen.getByRole('button', { name: /^save$/i }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.click(save)
    expect(puts).toBe(0)
  })
})
