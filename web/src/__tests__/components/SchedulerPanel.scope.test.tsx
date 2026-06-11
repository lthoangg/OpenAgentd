import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SchedulerPanel } from '@/components/SchedulerPanel'
import type { ScheduledTaskResponse } from '@/api/types'
import '@testing-library/jest-dom'

let isMobile = false
let platformOs: string | null = null

mock.module('@/hooks/use-mobile', () => ({
  useIsMobile: () => isMobile,
}))

mock.module('@/hooks/use-platform', () => ({
  usePlatform: () => ({ isTauri: Boolean(platformOs), os: platformOs, isMacOverlay: platformOs === 'macos' }),
}))

let originalFetch: typeof fetch | undefined

function task(overrides: Partial<ScheduledTaskResponse>): ScheduledTaskResponse {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    name: overrides.name ?? 'Task',
    mode: overrides.mode ?? 'normal',
    workspace: overrides.workspace ?? null,
    schedule_type: 'every',
    at_datetime: null,
    every_seconds: 3600,
    cron_expression: null,
    timezone: 'UTC',
    prompt: 'Do the thing',
    session_id: null,
    enabled: true,
    status: 'pending',
    run_count: 0,
    last_run_at: null,
    last_error: null,
    next_fire_at: null,
    created_at: '2026-05-25T00:00:00Z',
    updated_at: '2026-05-25T00:00:00Z',
    ...overrides,
  }
}

function renderPanel(tasks: ScheduledTaskResponse[], props: Partial<React.ComponentProps<typeof SchedulerPanel>> = {}) {
  globalThis.fetch = mock(async (...args: unknown[]) => {
    const input = args[0] as RequestInfo | URL
    const url = typeof input === 'string' ? input : input.toString()
    if (url.includes('/api/scheduler/tasks')) {
      return new Response(JSON.stringify({ tasks }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response('{}', { status: 200 })
  }) as unknown as typeof fetch

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  })

  return render(
    <QueryClientProvider client={queryClient}>
      <SchedulerPanel open={true} onClose={() => {}} {...props} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  originalFetch = globalThis.fetch
  isMobile = false
  platformOs = null
})

afterEach(() => {
  if (originalFetch) globalThis.fetch = originalFetch
})

describe('SchedulerPanel — task visibility', () => {
  it('shows normal and coding tasks in normal mode', async () => {
    renderPanel([
      task({ name: 'Normal reminder', mode: 'normal' }),
      task({ name: 'Coding reminder', mode: 'coding', workspace: '/repo/app' }),
    ])

    await waitFor(() => {
      expect(screen.getByText('Normal reminder')).toBeInTheDocument()
      expect(screen.getByText('Coding reminder')).toBeInTheDocument()
    })

    expect(screen.getByText('normal')).toBeInTheDocument()
    expect(screen.getByText('coding · app')).toBeInTheDocument()
    expect(screen.getByText('All scheduled tasks')).toBeInTheDocument()
  })

  it('shows normal and all coding workspace tasks in coding mode', async () => {
    renderPanel([
      task({ name: 'Normal reminder', mode: 'normal' }),
      task({ name: 'App reminder', mode: 'coding', workspace: '/repo/app' }),
      task({ name: 'Api reminder', mode: 'coding', workspace: '/repo/api' }),
    ], { contextMode: 'coding', contextWorkspace: '/repo/app' })

    await waitFor(() => {
      expect(screen.getByText('Normal reminder')).toBeInTheDocument()
      expect(screen.getByText('App reminder')).toBeInTheDocument()
      expect(screen.getByText('Api reminder')).toBeInTheDocument()
    })

    expect(screen.getByText('normal')).toBeInTheDocument()
    expect(screen.getByText('coding · app')).toBeInTheDocument()
    expect(screen.getByText('coding · api')).toBeInTheDocument()
    expect(screen.getByText('All scheduled tasks')).toBeInTheDocument()
  })

  it('selects a task row from the keyboard without nesting action buttons', async () => {
    const user = userEvent.setup()
    renderPanel([task({ name: 'Keyboard reminder' })])

    const row = await screen.findByRole('button', { name: /Keyboard reminder/i })
    expect(row.tagName).toBe('DIV')
    row.focus()
    await user.keyboard('{Enter}')

    expect(await screen.findByRole('heading', { name: 'Keyboard reminder' })).toBeInTheDocument()
  })

  it('cancels mobile task long-press actions when the row unmounts', async () => {
    isMobile = true
    platformOs = 'ios'
    const view = renderPanel([task({ name: 'Mobile reminder' })])

    const row = await screen.findByRole('button', { name: /Mobile reminder/i })
    fireEvent.pointerDown(row, {
      pointerType: 'touch',
      clientX: 40,
      clientY: 40,
    })
    view.unmount()

    await new Promise((resolve) => window.setTimeout(resolve, 650))
    expect(screen.queryByLabelText('Actions for Mobile reminder')).not.toBeInTheDocument()
  })
})
