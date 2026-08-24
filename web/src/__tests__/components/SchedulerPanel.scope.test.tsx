import { describe, expect, it, mock } from 'bun:test'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SchedulerPanel } from '@/components/SchedulerPanel'
import type { ScheduledTaskResponse } from '@/api/types'
import '@testing-library/jest-dom'

function task(name: string, workspace: string): ScheduledTaskResponse {
  return { id: crypto.randomUUID(), slug: name.toLowerCase().replaceAll(' ', '-'), name, workspace, schedule_type: 'every', at_datetime: null, every_seconds: 3600, cron_expression: null, timezone: 'UTC', prompt: 'Do the thing', session_id: null, enabled: true, status: 'pending', run_count: 0, max_runs: null, last_run_at: null, last_error: null, next_fire_at: null, created_at: '2026-05-25T00:00:00Z', updated_at: '2026-05-25T00:00:00Z' }
}

function renderPanel(tasks: ScheduledTaskResponse[]) {
  globalThis.fetch = mock(async () => new Response(JSON.stringify({ tasks }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}><SchedulerPanel open onClose={() => {}} /></QueryClientProvider>)
}

describe('SchedulerPanel — workspace scope', () => {
  it('shows scheduled tasks across coding workspaces', async () => {
    renderPanel([task('App reminder', '/repo/app'), task('Api reminder', '/repo/api')])
    await waitFor(() => {
      expect(screen.getByText('App reminder')).toBeInTheDocument()
      expect(screen.getByText('Api reminder')).toBeInTheDocument()
    })
    expect(screen.getAllByText('app').length).toBeGreaterThan(0)
    expect(screen.getAllByText('api').length).toBeGreaterThan(0)
  })
})
