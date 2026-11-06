/**
 * On a phone a scheduled task reads its schedule as a sentence and has an
 * on/off switch on the row (mockup J9).
 */
import '@testing-library/jest-dom'
import { afterEach, describe, expect, it, mock } from 'bun:test'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))
mock.module('@/hooks/use-touch-first', () => ({ useTouchFirst: () => true }))
mock.module('@/hooks/use-mobile', () => ({ useIsMobile: () => true, MOBILE_QUERY: '(max-width: 767px)' }))

import { cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ScheduledTaskResponse } from '@/api/types'
import { TaskListItem } from '@/components/SchedulerPanel/TaskListItem'

afterEach(cleanup)

const task: ScheduledTaskResponse = {
  id: 'task-id', slug: 'standup', name: 'Standup', workspace: '/repo/app',
  schedule_type: 'every', at_datetime: null, every_seconds: 180, cron_expression: null, timezone: 'UTC',
  prompt: 'Run', session_id: null, enabled: true, status: 'paused', run_count: 0, max_runs: null,
  last_run_at: null, last_error: null, next_fire_at: null,
  created_at: '2026-07-13T00:00:00Z', updated_at: '2026-07-13T00:00:00Z',
}

describe('TaskListItem on a phone', () => {
  it('reads the schedule in sans and switches the task on and off', () => {
    const client = new QueryClient()
    render(
      <QueryClientProvider client={client}>
        <TaskListItem task={task} isSelected={false} onSelect={() => {}} onDeleted={() => {}} />
      </QueryClientProvider>,
    )
    const label = document.querySelector('[data-schedule-label]')!
    expect(label.textContent).toMatch(/^Every /)
    expect(label.className).not.toContain('font-mono')
    expect(screen.getByRole('switch', { name: 'Standup on' })).not.toBeChecked()
  })
})
