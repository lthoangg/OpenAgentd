/** Settings → Sessions → Goals: Keep going by default, the turn limit, and the questions opt-in. */
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
import { useGoalsPart } from '@/components/settings/pages/sessions/goals'

/** The Goals part alone, in the shell the Sessions page gives it. */
function GoalsSettingsPage() {
  return <SettingsPartsPage title="Sessions" description="Names, summaries, goals and history." parts={[useGoalsPart()]} />
}

const server = setupServer()
let originalFetch: typeof fetch | undefined

const GOALS = { max_turns: 50, default_max_turns: 50, allow_questions: false, keep_going_default: false }

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

describe('Sessions settings: Goals', () => {
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

    const questions = await screen.findByRole('switch', { name: /allow questions during goals/i })
    await waitFor(() => expect(questions.getAttribute('aria-checked')).toBe('false'))
    fireEvent.click(questions)
    fireEvent.change(screen.getByLabelText('Turns per goal'), { target: { value: '20' } })
    fireEvent.click(await screen.findByRole('button', { name: /^save$/i }))

    await waitFor(() => expect(bodies).toEqual([{ max_turns: 20, allow_questions: true, keep_going_default: false }]))
  })

  it('saves Keep going after approval', async () => {
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

    const keepGoing = await screen.findByRole('switch', { name: 'Keep going after approval' })
    await waitFor(() => expect(keepGoing.getAttribute('aria-checked')).toBe('false'))
    fireEvent.click(keepGoing)
    fireEvent.click(await screen.findByRole('button', { name: /^save$/i }))

    await waitFor(() => expect(bodies).toEqual([{ max_turns: 50, allow_questions: false, keep_going_default: true }]))
  })

  it('offers no token budget: a goal runs until done, blocked or out of turns', async () => {
    server.use(...handlers())
    renderPage()

    await screen.findByLabelText('Turns per goal')
    expect(screen.queryByLabelText(/token budget/i)).toBeNull()
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
