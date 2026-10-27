/**
 * GoalTabView — the session's goal as a review-dock tab: what the session is
 * doing for it now, the plan it runs, its progress and last check, and Pause,
 * Resume and Clear. Without a goal it says how to start one.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { setApiBaseUrl } from '@/api/base-url'
import type { SessionGoal, SessionPlan, TodoItem } from '@/api/types'
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

const PLAN: SessionPlan = {
  content: '# Export sessions as Markdown\n\n## Done when\n\nAll web tests pass and `tsc -b` is clean.',
  updated_at: '2026-10-24T00:00:00Z',
  revision: 2,
  approved_revision: 2,
  done_when: 'All web tests pass and `tsc -b` is clean.',
}

const TODOS: TodoItem[] = [
  { task_id: 't1', content: 'Export endpoint', status: 'completed' },
  { task_id: 't2', content: 'Download button', status: 'completed' },
  { task_id: 't3', content: 'Attachments as links', status: 'pending' },
  { task_id: 't4', content: 'Docs', status: 'pending' },
]

function renderTab(goal: SessionGoal | null, sessionId: string | null = 's1', extra: { plan?: SessionPlan; todos?: TodoItem[]; onOpenPlan?: () => void } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.goal('s1'), { goal })
  client.setQueryData(queryKeys.session.subagents('s1'), { available_profiles: [], live_members: [] })
  render(<QueryClientProvider client={client}><GoalTabView sessionId={sessionId} {...extra} /></QueryClientProvider>)
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

  it('asks before clearing the goal, and Cancel leaves it alone', async () => {
    const calls: { url: string; method?: string }[] = []
    globalThis.fetch = mock(async (input: unknown, init?: unknown) => {
      calls.push({ url: String(input), method: (init as RequestInit | undefined)?.method })
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch
    const user = userEvent.setup()
    const client = renderTab(makeGoal())

    // Plain DOM queries for the dialog: role queries walk the whole tree.
    const openDialog = () => document.querySelector<HTMLElement>('[role="dialog"]')
    await user.click(screen.getByRole('button', { name: 'Clear goal' }))
    await waitFor(() => expect(openDialog()).not.toBeNull())
    const dialog = openDialog()!
    expect(dialog.textContent).toContain('Clear this goal?')
    expect(calls).toEqual([])

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    // The dialog unmounts once its exit animation has run.
    await act(async () => { await new Promise((r) => setTimeout(r, 400)) })
    expect(openDialog()).toBeNull()
    expect(calls).toEqual([])
    expect(now()?.dataset.goalNow).toBe('active')

    await user.click(screen.getByRole('button', { name: 'Clear goal' }))
    await waitFor(() => expect(openDialog()).not.toBeNull())
    await user.click(within(openDialog()!).getByRole('button', { name: 'Clear goal' }))

    await waitFor(() => expect(calls.map((c) => [c.url.replace(/^.*\/api/, '/api'), c.method])).toEqual([['/api/agent/sessions/s1/goal', 'DELETE']]))
    await waitFor(() => expect(client.getQueryData<{ goal: SessionGoal }>(queryKeys.goal('s1'))?.goal.status).toBe('cleared'))
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

  it('waits for plan approval while a plan review is open', () => {
    useAgentStore.setState({ pendingQuestion: { kind: 'plan_review', id: 'q1' } as never })
    renderTab(makeGoal())
    expect(now()?.dataset.goalNow).toBe('wait')
    expect(now()?.textContent).toContain('Waiting for plan approval')
  })

  it('shows the plan the goal runs as one line, with its status and a link, and the next task', async () => {
    useAgentStore.setState({ isAgentWorking: true })
    const onOpenPlan = mock(() => {})
    const user = userEvent.setup()
    renderTab(makeGoal(), 's1', { plan: PLAN, todos: TODOS, onOpenPlan })

    expect(now()?.textContent).toContain('Next task: Attachments as links')
    const plan = screen.getByRole('region', { name: 'Plan' })
    expect(plan.textContent).toContain('Export sessions as Markdown')
    expect(plan.textContent).toContain('Approved · Running')
    // Task progress lives in the Tasks view, not here.
    expect(plan.textContent).not.toContain('Tasks 2/4')

    await user.click(screen.getByRole('button', { name: 'Open plan' }))
    expect(onOpenPlan).toHaveBeenCalledTimes(1)
  })

  it('reads the plan Done once its goal is achieved', () => {
    renderTab(makeGoal({ status: 'achieved', turns_used: 3 }), 's1', { plan: PLAN, todos: TODOS })
    expect(screen.getByRole('region', { name: 'Plan' }).textContent).toContain('Done')
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

  it('says how to start a goal when there is none', () => {
    renderTab(makeGoal({ status: 'cleared' }))
    expect(screen.getByRole('heading', { name: 'No goal' })).toBeTruthy()
    expect(screen.getByText(/Approve a plan with Keep going until done/)).toBeTruthy()
    cleanup()

    renderTab(null, null)
    expect(screen.getByRole('heading', { name: 'No goal' })).toBeTruthy()
  })

  it('offers Retry when the goal fails to load, instead of saying there is none', async () => {
    let fail = true
    globalThis.fetch = mock(async () => (
      fail ? new Response('down', { status: 500 }) : Response.json({ goal: makeGoal() })
    )) as unknown as typeof fetch
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    client.setQueryData(queryKeys.session.subagents('s1'), { available_profiles: [], live_members: [] })
    const user = userEvent.setup()
    render(<QueryClientProvider client={client}><GoalTabView sessionId="s1" /></QueryClientProvider>)

    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'No goal' })).toBeNull()

    fail = false
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(now()?.dataset.goalNow).toBe('active'))
  })
})
