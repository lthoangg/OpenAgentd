import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ScheduledTaskResponse } from '@/api/types'
import { TaskListItem } from '@/components/SchedulerPanel/TaskListItem'
import '@testing-library/jest-dom'

const scheduledTask: ScheduledTaskResponse = {
  id: 'task-id',
  slug: 'daily-standup',
  name: 'Daily standup',
  mode: 'normal',
  workspace: null,
  schedule_type: 'every',
  at_datetime: null,
  every_seconds: 3600,
  cron_expression: null,
  timezone: 'UTC',
  prompt: 'Run standup',
  session_id: null,
  enabled: true,
  status: 'pending',
  run_count: 0,
  max_runs: null,
  last_run_at: null,
  last_error: null,
  next_fire_at: null,
  created_at: '2026-07-13T00:00:00Z',
  updated_at: '2026-07-13T00:00:00Z',
}

let originalFetch: typeof fetch | undefined

beforeEach(() => {
  originalFetch = globalThis.fetch
})

afterEach(() => {
  if (originalFetch) globalThis.fetch = originalFetch
})

describe('TaskListItem', () => {
  it('uses an in-app confirmation dialog before deleting a task', async () => {
    const requests: Array<{ url: string; method: string }> = []
    globalThis.fetch = mock(async (...args: unknown[]) => {
      const input = args[0] as RequestInfo | URL
      const init = args[1] as RequestInit | undefined
      requests.push({
        url: typeof input === 'string' ? input : input.toString(),
        method: init?.method ?? 'GET',
      })
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    })

    render(
      <QueryClientProvider client={queryClient}>
        <TaskListItem
          task={scheduledTask}
          isSelected={false}
          onSelect={() => {}}
          onDeleted={() => {}}
        />
      </QueryClientProvider>,
    )

    fireEvent.click(screen.getByTitle('Delete'))

    expect(screen.getByRole('dialog', { name: 'Delete scheduled task' })).toBeInTheDocument()
    expect(requests).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: 'Delete task permanently' }))

    await waitFor(() => {
      expect(requests).toEqual([
        { url: '/api/scheduler/tasks/daily-standup', method: 'DELETE' },
      ])
    })
  })
})
