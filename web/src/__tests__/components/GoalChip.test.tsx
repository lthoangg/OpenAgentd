import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { useState } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { setApiBaseUrl } from '@/api/base-url'
import type { SessionGoal } from '@/api/types'
import { GoalChip } from '@/components/GoalChip'
import { queryKeys } from '@/queries/keys'
import { useGoalUiStore } from '@/stores/useGoalUiStore'

const originalFetch = globalThis.fetch

function makeGoal(overrides: Partial<SessionGoal> = {}): SessionGoal {
  return {
    id: 'g1',
    session_id: 's1',
    objective: 'All web tests pass and tsc -b is clean.',
    status: 'active',
    pause_reason: null,
    detail: null,
    max_turns: 50,
    token_budget: null,
    turns_used: 6,
    tokens_used: 412_000,
    active_seconds: 750,
    rejected_claims: 0,
    created_at: '2026-10-24T00:00:00Z',
    updated_at: '2026-10-24T00:10:00Z',
    ended_at: null,
    ...overrides,
  }
}

let openState: boolean[] = []

function Harness({ running = false }: { running?: boolean }) {
  const [open, setOpen] = useState(false)
  openState.push(open)
  return <GoalChip sessionId="s1" running={running} waitingForUser={false} planMode={false} open={open} onOpenChange={setOpen} />
}

function renderChip(goal: SessionGoal | null, props: { running?: boolean } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.goal('s1'), { goal })
  render(<QueryClientProvider client={client}><Harness {...props} /></QueryClientProvider>)
  return client
}

beforeEach(() => {
  setApiBaseUrl('')
  useGoalUiStore.setState({ dismissed: [] })
  openState = []
})

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
  window.matchMedia = realMatchMedia
})

const realMatchMedia = window.matchMedia
/** A phone-width viewport for ``useIsMobile``. */
function usePhone() {
  window.matchMedia = ((query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

describe('GoalChip', () => {
  it('shows the running turn and pauses the goal from its popover', async () => {
    const paused = makeGoal({ status: 'paused', pause_reason: 'user' })
    const calls: { url: string; method?: string }[] = []
    const fetchMock = mock(async (input: unknown, init?: unknown) => {
      calls.push({ url: String(input), method: (init as RequestInit | undefined)?.method })
      return new Response(JSON.stringify(paused))
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const user = userEvent.setup()
    renderChip(makeGoal(), { running: true })

    const chip = screen.getByRole('button', { name: /Goal · 7\/50 · 12m 30s/ })
    await user.click(chip)
    expect(screen.getByText('All web tests pass and tsc -b is clean.')).toBeTruthy()
    expect(screen.getByText('7 / 50')).toBeTruthy()
    expect(screen.getByText('412k')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Pause' }))
    await waitFor(() => expect(screen.getByRole('button', { name: /Goal paused · paused by you/ })).toBeTruthy())
    expect(calls).toHaveLength(1)
    expect(calls[0].url.endsWith('/agent/sessions/s1/goal/pause')).toBe(true)
    expect(calls[0].method).toBe('POST')
    expect(screen.getByRole('button', { name: 'Resume' })).toBeTruthy()
    expect(screen.getByText('You paused it.')).toBeTruthy()
  })

  it('says why a goal stopped and what the last check found', async () => {
    const user = userEvent.setup()
    renderChip(makeGoal({ status: 'paused', pause_reason: 'blocked', detail: 'The staging key is missing.' }))
    await user.click(screen.getByRole('button', { name: /Goal blocked/ }))
    expect(screen.getByText('The staging key is missing.')).toBeTruthy()
    // The status badge takes the goal's tone, not the active blue.
    expect(document.querySelector('[data-goal-badge]')?.getAttribute('data-goal-badge')).toBe('blocked')
    cleanup()

    renderChip(makeGoal({ rejected_claims: 1, detail: 'No bun test output is shown.' }))
    await user.click(screen.getByRole('button', { name: /Goal · 6\/50/ }))
    expect(screen.getByText('Not yet: No bun test output is shown.')).toBeTruthy()
    expect(document.querySelector('[data-goal-badge]')?.getAttribute('data-goal-badge')).toBe('active')
  })

  it('sets the objective and the pause detail in mono where the user wrote code', async () => {
    const user = userEvent.setup()
    renderChip(makeGoal({
      objective: 'Make `bun test` pass.',
      status: 'paused',
      pause_reason: 'blocked',
      detail: 'Need `STAGING_KEY` set.',
    }))
    await user.click(screen.getByRole('button', { name: /Goal blocked/ }))

    const panel = document.querySelector('[data-goal-panel]')!
    expect([...panel.querySelectorAll('code')].map((c) => c.textContent)).toEqual(['bun test', 'STAGING_KEY'])
    expect(panel.textContent).not.toContain('`')
  })

  it('hides a cleared goal and an achieved one the user dismissed', async () => {
    renderChip(makeGoal({ status: 'cleared' }))
    expect(document.querySelector('[data-goal-chip]')).toBeNull()
    cleanup()

    const user = userEvent.setup()
    renderChip(makeGoal({ status: 'achieved', detail: 'Both commands pass.' }))
    await user.click(screen.getByRole('button', { name: /Goal achieved/ }))
    expect(screen.getByText('Both commands pass.')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(document.querySelector('[data-goal-chip]')).toBeNull()
    expect(useGoalUiStore.getState().dismissed).toEqual(['g1'])
  })

  it('does not reopen its status for the next goal once the goal it showed is gone', async () => {
    const user = userEvent.setup()
    const client = renderChip(makeGoal())
    await user.click(screen.getByRole('button', { name: /Goal · 6\/50/ }))
    expect(document.querySelector('[data-goal-panel]')).toBeTruthy()

    // Cleared elsewhere (another window, the palette) while it was open.
    client.setQueryData(queryKeys.goal('s1'), { goal: makeGoal({ status: 'cleared' }) })
    await waitFor(() => expect(openState.at(-1)).toBe(false))

    client.setQueryData(queryKeys.goal('s1'), { goal: makeGoal({ id: 'g2', objective: 'Ship the export.' }) })
    await waitFor(() => expect(document.querySelector('[data-goal-chip]')).toBeTruthy())
    expect(openState.at(-1)).toBe(false)
  })

  it('shows the status as a bottom sheet on a phone, with a short chip and a Close action', async () => {
    usePhone()
    const user = userEvent.setup()
    renderChip(makeGoal(), { running: true })

    const chip = screen.getByRole('button', { name: /Goal · 7\/50 · 12m 30s\. Show goal status/ })
    expect(chip.textContent).toBe('7/50')
    await user.click(chip)

    const sheet = screen.getByRole('dialog', { name: 'Goal' })
    expect(sheet.hasAttribute('data-goal-sheet')).toBe(true)
    expect(sheet.querySelector('[data-goal-panel]')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(openState.at(-1)).toBe(false)
    // It plays its exit, then unmounts (``useDeferredUnmount``).
    expect(document.querySelector('[data-goal-sheet]')?.className).toContain('animate-out')
  })
})
