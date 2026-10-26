/**
 * Review dock view tabs — the desktop Tasks (⌘T) and Schedule tabs.
 *
 * The shell asks the dock to open a view through a keyed request plus a
 * parent-owned "handled" ref (same contract as terminals), and the dock
 * reports which view tab is focused so a second press can hide the dock.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { gitDiffResponse } from '../git-diff-mock'
import type React from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useGitPanelStore } from '@/stores/useGitPanelStore'
import { _resetTerminalStoreForTests } from '@/stores/useTerminalStore'
import type { ScheduledTaskResponse, SessionPlan, TodoItem } from '@/api/types'
import type { DockView, DockViewRequest } from '@/components/WorkspacePanel/dock-tabs'

// lucide-react stays real: the Schedule tab pulls in the whole scheduler tree.
const WORKSPACE = '/repo/project'

mock.module('@/hooks/useReducedMotion', () => ({ useReducedMotion: () => false }))
mock.module('@/hooks/use-platform', () => ({
  usePlatform: () => ({ isTauri: false, os: 'linux', isMacOverlay: false }),
  getPlatform: () => ({ isTauri: false, os: 'linux', isMacOverlay: false }),
}))
mock.module('framer-motion', () => ({
  motion: {
    aside: ({ children, className, 'aria-label': ariaLabel }: { children: React.ReactNode; className?: string; 'aria-label'?: string }) => (
      <aside className={className} aria-label={ariaLabel}>{children}</aside>
    ),
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
}))

const TASK: ScheduledTaskResponse = {
  id: 'task-1',
  slug: 'nightly-report',
  name: 'Nightly report',
  prompt: 'Summarise the day',
  schedule_type: 'cron',
  cron_expression: '0 21 * * *',
  every_seconds: null,
  at_datetime: null,
  timezone: 'UTC',
  workspace: '/repo/other',
  session_id: null,
  status: 'pending',
  enabled: true,
  run_count: 3,
  max_runs: null,
  last_error: null,
  next_fire_at: null,
  last_fired_at: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
} as unknown as ScheduledTaskResponse

const TODOS: TodoItem[] = [
  { task_id: '1', content: 'Write the migration', status: 'completed' },
  { task_id: '2', content: 'Wire the endpoint and update every caller that reads the legacy field', status: 'in_progress' },
]

beforeEach(() => {
  _resetTerminalStoreForTests()
  useGitPanelStore.setState({ workspaces: {} })
  globalThis.fetch = mock(async (input: unknown) => {
    const url = String(input)
    if (url.includes('/workspace/files/list')) return new Response(JSON.stringify({ workspace: WORKSPACE, truncated: false, files: [] }))
    if (url.includes('/workspace/git-diff')) return gitDiffResponse(url, { workspace: WORKSPACE, is_git_repo: false, diff: '' })
    if (url.includes('/workspace/status')) return new Response(JSON.stringify({ workspace: WORKSPACE }))
    if (url.includes('/scheduler/tasks')) return new Response(JSON.stringify({ tasks: [TASK] }))
    if (url.endsWith('/btw/count')) return new Response(JSON.stringify({ total: 1 }))
    if (url.includes('/btw')) {
      return new Response(JSON.stringify({
        items: [{
          id: 'q1', session_id: 'session-1', question: 'Which file holds the router?', answer: 'It is in `src/router.ts`.',
          status: 'done', error: null, model: null, usage: null, created_at: '', updated_at: '',
        }],
        total: 1,
      }))
    }
    return new Response(JSON.stringify({}), { status: 404 })
  }) as typeof fetch
})
afterEach(cleanup)

interface RenderOptions {
  request?: DockViewRequest | null
  handledRef?: React.RefObject<number>
  todos?: TodoItem[]
  sessionId?: string | null
  plan?: SessionPlan | null
  onActiveViewChange?: (view: DockView | null) => void
}

async function renderPanel(options: RenderOptions = {}) {
  const { WorkspacePanel } = await import('@/components/WorkspacePanel')
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const element = (opts: RenderOptions) => (
    <QueryClientProvider client={queryClient}>
      <WorkspacePanel
        workspace={WORKSPACE}
        open
        viewRequest={opts.request ?? null}
        handledViewRequestKeyRef={opts.handledRef}
        todos={opts.todos ?? TODOS}
        sessionId={opts.sessionId === undefined ? 'session-1' : opts.sessionId}
        plan={opts.plan ?? null}
        onActiveViewChange={opts.onActiveViewChange}
      />
    </QueryClientProvider>
  )
  let view!: ReturnType<typeof render>
  await act(async () => {
    view = render(element(options))
  })
  return { ...view, rerenderWith: (next: RenderOptions) => view.rerender(element({ ...options, ...next })) }
}

describe('Review dock Tasks tab', () => {
  it('opens and focuses the Tasks tab for a tasks request and reports the active view', async () => {
    const reported: (DockView | null)[] = []
    await renderPanel({ request: { view: 'tasks', key: 1 }, onActiveViewChange: (v) => reported.push(v) })

    const tab = await screen.findByRole('button', { name: 'Tasks' })
    expect(tab.getAttribute('aria-current')).toBe('true')
    expect(await screen.findByText('1/2 done')).toBeTruthy()
    // Rows wrap in the dock instead of truncating behind a tooltip.
    const active = screen.getByText(/Wire the endpoint/)
    expect(active.className).toContain('break-words')
    expect(active.className).not.toContain('truncate')
    expect(reported.at(-1)).toBe('tasks')
  })

  it('shows an empty state that explains where tasks come from', async () => {
    await renderPanel({ request: { view: 'tasks', key: 1 }, todos: [] })
    expect(await screen.findByText('No tasks yet')).toBeTruthy()
  })

  it('does not replay a handled request when the dock remounts', async () => {
    const handledRef = { current: 0 }
    const first = await renderPanel({ request: { view: 'tasks', key: 1 }, handledRef })
    await screen.findByRole('button', { name: 'Tasks' })
    expect(handledRef.current).toBe(1)
    first.unmount()

    await renderPanel({ request: { view: 'tasks', key: 1 }, handledRef })
    expect(screen.queryByRole('button', { name: 'Tasks' })).toBeNull()
  })

  it('reports null when the view tab is closed or the dock unmounts', async () => {
    const user = userEvent.setup()
    const reported: (DockView | null)[] = []
    const view = await renderPanel({ request: { view: 'tasks', key: 1 }, onActiveViewChange: (v) => reported.push(v) })
    await screen.findByRole('button', { name: 'Tasks' })

    await user.click(screen.getByRole('button', { name: 'Close Tasks' }))
    expect(screen.queryByRole('button', { name: 'Tasks' })).toBeNull()
    expect(reported.at(-1)).toBeNull()

    view.rerenderWith({ request: { view: 'tasks', key: 2 } })
    await screen.findByRole('button', { name: 'Tasks' })
    expect(reported.at(-1)).toBe('tasks')
    view.unmount()
    expect(reported.at(-1)).toBeNull()
  })
})

describe('Review dock Plan tab', () => {
  const PLAN: SessionPlan = {
    content: '# Ship it\n\n1. Write the migration',
    updated_at: '2026-01-01T00:00:00Z',
    revision: 1,
    approved_revision: null,
    path: `${WORKSPACE}/.agents/plans/ship-it-0000abcd.md`,
    workspace_path: '.agents/plans/ship-it-0000abcd.md',
  }

  it('opens and focuses the Plan tab for a plan request and reports the active view', async () => {
    const reported: (DockView | null)[] = []
    await renderPanel({ request: { view: 'plan', key: 1 }, plan: PLAN, onActiveViewChange: (v) => reported.push(v) })

    const tab = await screen.findByRole('button', { name: 'Session plan' })
    expect(tab.getAttribute('aria-current')).toBe('true')
    expect(await screen.findByText('Write the migration')).toBeTruthy()
    expect(reported.at(-1)).toBe('plan')
  })

  it('shows the empty state before the agent writes a plan', async () => {
    await renderPanel({ request: { view: 'plan', key: 1 } })
    expect(await screen.findByText('No plan yet')).toBeTruthy()
  })
})

describe('Review dock BTW tab', () => {
  it('opens and focuses the side questions tab for a btw request and reports the active view', async () => {
    const reported: (DockView | null)[] = []
    await renderPanel({ request: { view: 'btw', key: 1 }, onActiveViewChange: (v) => reported.push(v) })

    const tab = await screen.findByRole('button', { name: 'BTW side questions' })
    expect(tab.getAttribute('aria-current')).toBe('true')
    expect(await screen.findByText('Which file holds the router?')).toBeTruthy()
    expect(reported.at(-1)).toBe('btw')
  })
})

describe('Review dock Schedule tab', () => {
  it('lists scheduled tasks from every workspace and stacks detail over the list', async () => {
    const user = userEvent.setup()
    await renderPanel({ request: { view: 'schedule', key: 1 } })

    const tab = await screen.findByRole('button', { name: 'Scheduled tasks' })
    expect(tab.getAttribute('aria-current')).toBe('true')
    expect(await screen.findByText('All workspaces')).toBeTruthy()
    await waitFor(() => expect(screen.getByText('Nightly report')).toBeTruthy())

    await user.click(screen.getByText('Nightly report'))
    const back = await screen.findByRole('button', { name: 'Back to task list' })
    // Stacked host: the back arrow replaces the overlay's close control.
    expect(screen.queryByRole('button', { name: 'Close detail' })).toBeNull()
    await user.click(back)
    expect(await screen.findByText('All workspaces')).toBeTruthy()
  })

  it('opens the create form from New task and returns with the back arrow', async () => {
    const user = userEvent.setup()
    await renderPanel({ request: { view: 'schedule', key: 1 } })

    await user.click(await screen.findByRole('button', { name: 'New task' }))
    expect(await screen.findByLabelText('Task title')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Back to task list' }))
    expect(await screen.findByRole('button', { name: 'New task' })).toBeTruthy()
  })

  it('uses container breakpoints so forms fit the dock width', async () => {
    const user = userEvent.setup()
    const { container } = await renderPanel({ request: { view: 'schedule', key: 1 } })

    await user.click(await screen.findByRole('button', { name: 'New task' }))
    await screen.findByLabelText('Task title')
    expect(container.querySelector('.\\@container')).not.toBeNull()
    expect(container.innerHTML).not.toMatch(/\bsm:grid-cols/)
  })
})
