/**
 * GoalTabView — the session's `/goal` as a review-dock tab: what the session
 * is doing for it now, its progress and last check, and Pause, Resume and
 * Clear. Without a goal it says how to set one.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { setApiBaseUrl } from '@/api/base-url'
import type { SessionGoal } from '@/api/types'
import { GoalTabView } from '@/components/WorkspacePanel/GoalTabView'
import { queryKeys } from '@/queries/keys'
import { useAgentStore } from '@/stores/useAgentStore'

const originalFetch = globalThis.fetch

function makeGoal(overrides: Partial<SessionGoal> = {}): SessionGoal {
  return {
    id: 'g1',
    session_id: 's1',
    objective: 'All web tests pass and `tsc -b` is clean.',
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

function renderTab(goal: SessionGoal | null, sessionId: string | null = 's1') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.goal('s1'), { goal })
  client.setQueryData(queryKeys.session.subagents('s1'), { available_profiles: [], live_members: [] })
  render(<QueryClientProvider client={client}><GoalTabView sessionId={sessionId} /></QueryClientProvider>)
  return client
}

const now = () => document.querySelector<HTMLElement>('[data-goal-now]')

beforeEach(() => {
  setApiBaseUrl('')
  useAgentStore.setState({
    sessionId: 's1',
    isAgentWorking: false,
    pendingQuestion: null,
    sessionInteractionMode: 'code',
    sessionPendingInteractionMode: null,
    _pendingMessages: [],
  })
})

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
  useAgentStore.setState({ sessionId: null, isAgentWorking: false, _pendingMessages: [] })
})

describe('GoalTabView', () => {
  it('shows the running turn and progress, and pauses the goal', async () => {
    useAgentStore.setState({ isAgentWorking: true })
    const calls: { url: string; method?: string }[] = []
    globalThis.fetch = mock(async (input: unknown, init?: unknown) => {
      calls.push({ url: String(input), method: (init as RequestInit | undefined)?.method })
      return Response.json(makeGoal({ status: 'paused', pause_reason: 'user' }))
    }) as unknown as typeof fetch
    const user = userEvent.setup()
    renderTab(makeGoal())

    expect(now()?.dataset.goalNow).toBe('active')
    expect(now()?.textContent).toBe('Working on turn 7 of 50')
    expect(screen.getByText('7 / 50')).toBeTruthy()
    expect(screen.getByText('412k')).toBeTruthy()
    expect(screen.getByText('12m 30s')).toBeTruthy()
    // Code the user wrote in the objective is set in mono.
    expect(screen.getByRole('region', { name: 'Objective' }).querySelector('code')?.textContent).toBe('tsc -b')

    await user.click(screen.getByRole('button', { name: 'Pause' }))

    await waitFor(() => expect(now()?.textContent).toBe('Paused: paused by you'))
    expect(calls.map((c) => [c.url.replace(/^.*\/api/, '/api'), c.method])).toEqual([['/api/agent/sessions/s1/goal/pause', 'POST']])
    expect(screen.getByRole('button', { name: 'Resume' })).toBeTruthy()
    expect(screen.getByText('You paused it.')).toBeTruthy()
  })

  it('names what the goal waits for in the session', () => {
    useAgentStore.setState({ isAgentWorking: true, pendingQuestion: { kind: 'ask_user', id: 'q1' } as never })
    renderTab(makeGoal())
    expect(now()?.dataset.goalNow).toBe('wait')
    expect(now()?.textContent).toContain('Waiting for your answer')
    cleanup()

    useAgentStore.setState({ isAgentWorking: false, pendingQuestion: null, sessionPendingInteractionMode: 'plan' })
    renderTab(makeGoal())
    expect(now()?.textContent).toContain('Waiting for Code mode')
    cleanup()

    useAgentStore.setState({ isAgentWorking: true, sessionPendingInteractionMode: null, _pendingMessages: [{ id: 'm1', content: 'also fix lint' }] })
    renderTab(makeGoal())
    expect(now()?.textContent).toBe("Working on turn 7 of 501 queued message runs before the goal's next turn.")
  })

  it('waits for working subagents between turns', async () => {
    const client = renderTab(makeGoal())
    client.setQueryData(queryKeys.session.subagents('s1'), {
      available_profiles: [],
      live_members: [{ member_id: 'm', profile: 'explorer', status: 'working', session_id: 'c1', has_pending_question: false }],
    })
    await waitFor(() => expect(now()?.textContent).toContain('Waiting for 1 subagent'))
  })

  it('says why a goal stopped and what the last check found', () => {
    renderTab(makeGoal({ status: 'paused', pause_reason: 'blocked', detail: 'Need `STAGING_KEY` set.' }))
    expect(now()?.dataset.goalNow).toBe('blocked')
    const why = screen.getByRole('region', { name: 'Why it paused' })
    expect(why.querySelector('code')?.textContent).toBe('STAGING_KEY')
    cleanup()

    renderTab(makeGoal({ rejected_claims: 1, detail: 'No bun test output is shown.' }))
    expect(screen.getByRole('region', { name: 'Last check' }).textContent).toContain('Not yet: No bun test output is shown.')
  })

  it('shows an achieved goal in blue with its check, and no actions', () => {
    renderTab(makeGoal({ status: 'achieved', turns_used: 3, detail: 'Both commands pass.' }))
    expect(now()?.dataset.goalNow).toBe('achieved')
    expect(now()?.className).toContain('accent-blue')
    expect(now()?.textContent).toBe('Achieved in 3 turns')
    expect(screen.getByRole('region', { name: 'Check' }).textContent).toContain('Both commands pass.')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('says how to set a goal when there is none', () => {
    renderTab(makeGoal({ status: 'cleared' }))
    expect(screen.getByRole('heading', { name: 'No goal' })).toBeTruthy()
    expect(screen.getByText(/Type \/goal and what done looks like/)).toBeTruthy()
    cleanup()

    renderTab(null, null)
    expect(screen.getByRole('heading', { name: 'No goal' })).toBeTruthy()
  })
})
