import { describe, expect, it } from 'bun:test'
import type { ScheduledTaskResponse, SessionResponse } from '@/api/types'
import { buildWidgetSnapshot } from '@/lib/widget-snapshot'

const NOW = new Date('2026-10-25T12:00:00Z')

function session(id: string, minutesAgo: number, extra: Partial<SessionResponse> = {}): SessionResponse {
  const at = new Date(NOW.getTime() - minutesAgo * 60_000).toISOString()
  return {
    id,
    title: `Session ${id}`,
    agent_name: 'lead',
    created_at: at,
    updated_at: at,
    last_message_at: at,
    workspace: '/Users/me/projects/openagentd',
    ...extra,
  }
}

function pages(...sessions: SessionResponse[]) {
  return { pages: [{ data: sessions, next_cursor: null, has_more: false }], pageParams: [null] }
}

function task(id: string, extra: Partial<ScheduledTaskResponse> = {}): ScheduledTaskResponse {
  return {
    id,
    slug: id,
    name: `Task ${id}`,
    workspace: '/w',
    schedule_type: 'every',
    at_datetime: null,
    every_seconds: 3600,
    cron_expression: null,
    timezone: 'UTC',
    prompt: 'do it',
    session_id: null,
    max_runs: null,
    enabled: true,
    status: 'active',
    run_count: 0,
    last_run_at: null,
    last_error: null,
    next_fire_at: '2026-10-25T13:00:00Z',
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
    ...extra,
  }
}

describe('buildWidgetSnapshot', () => {
  it('puts sessions that need you first, then working ones, then recent ones', () => {
    const snapshot = buildWidgetSnapshot({
      active: pages(
        session('working', 1, { running: true }),
        session('asking', 30, { running: true, needs_input: true }),
      ),
      recent: pages(session('fresh', 0), session('working', 1), session('older', 90), session('oldest', 900)),
      tasks: [],
      now: NOW,
    })

    expect(snapshot.inbox.map((row) => [row.id, row.state])).toEqual([
      ['asking', 'needs_input'],
      ['working', 'running'],
      ['fresh', 'idle'],
    ])
    expect(snapshot.updatedAt).toBe(NOW.toISOString())
  })

  it('counts a lead whose subagents still work, or with background work, as working', () => {
    const snapshot = buildWidgetSnapshot({
      active: pages(
        session('delegating', 5, { subagents: [session('sub', 5, { running: true, parent_session_id: 'delegating' })] }),
        session('background', 6, { background_work: true }),
      ),
      recent: pages(),
      tasks: undefined,
      now: NOW,
    })

    expect(snapshot.inbox.map((row) => row.state)).toEqual(['running', 'running'])
  })

  it('leaves out subagent rows and sessions without a folder', () => {
    const snapshot = buildWidgetSnapshot({
      active: pages(),
      recent: pages(session('sub', 0, { parent_session_id: 'lead' }), session('nofolder', 1, { workspace: null }), session('lead', 2)),
      tasks: [],
      now: NOW,
    })

    expect(snapshot.inbox.map((row) => row.id)).toEqual(['lead'])
    expect(snapshot.lastSession?.id).toBe('lead')
  })

  it('shows the folder name only and names untitled sessions', () => {
    const snapshot = buildWidgetSnapshot({
      active: pages(),
      recent: pages(session('a', 0, { title: '  ' })),
      tasks: [],
      now: NOW,
    })

    expect(snapshot.lastSession).toEqual({
      id: 'a',
      title: 'Untitled session',
      workspace: 'openagentd',
      state: 'idle',
      lastMessageAt: NOW.toISOString(),
    })
  })

  it('picks the most recently active session as the last session', () => {
    const snapshot = buildWidgetSnapshot({
      active: pages(session('asking', 30, { running: true, needs_input: true })),
      recent: pages(session('older', 60), session('newest', 2)),
      tasks: [],
      now: NOW,
    })

    expect(snapshot.lastSession?.id).toBe('newest')
  })

  it('has no last session and an empty inbox before any session exists', () => {
    const snapshot = buildWidgetSnapshot({ active: undefined, recent: pages(), tasks: [], now: NOW })

    expect(snapshot).toMatchObject({ lastSession: null, inbox: [], nextTask: null })
  })

  it('names the next enabled task and how its last run went', () => {
    const snapshot = buildWidgetSnapshot({
      active: pages(),
      recent: pages(),
      tasks: [
        task('later', { next_fire_at: '2026-10-26T09:00:00Z' }),
        task('paused', { enabled: false, next_fire_at: '2026-10-25T12:05:00Z' }),
        task('soon', { next_fire_at: '2026-10-25T12:30:00Z', last_run_at: '2026-10-25T11:30:00Z', last_error: 'boom' }),
        task('done', { next_fire_at: null }),
      ],
      now: NOW,
    })

    expect(snapshot.nextTask).toEqual({
      id: 'soon',
      name: 'Task soon',
      nextFireAt: '2026-10-25T12:30:00Z',
      lastRunAt: '2026-10-25T11:30:00Z',
      lastRunOk: false,
    })
  })

  it('reports a task that never ran as having no last result', () => {
    const snapshot = buildWidgetSnapshot({ active: pages(), recent: pages(), tasks: [task('fresh')], now: NOW })

    expect(snapshot.nextTask?.lastRunOk).toBeNull()
  })
})
