import { describe, expect, it } from 'bun:test'
import type { SessionResponse } from '@/api/types'
import { groupSessionsByDate, groupSessionsByStatus } from '@/components/Sidebar.helpers'

const session = (id: string, fields: Partial<SessionResponse> = {}): SessionResponse => ({
  id,
  title: id,
  agent_name: 'lead',
  created_at: null,
  updated_at: null,
  ...fields,
})

/** Local wall-clock time, so the test holds in any timezone. */
const local = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min).toISOString()

describe('groupSessionsByDate', () => {
  const now = new Date(2026, 9, 19, 9, 30)

  it('buckets by local midnight and keeps the input order inside a group', () => {
    const sessions = [
      session('today-late', { last_message_at: local(2026, 10, 19, 9, 0) }),
      session('today-early', { last_message_at: local(2026, 10, 19, 0, 0) }),
      session('yesterday', { last_message_at: local(2026, 10, 18, 23, 59) }),
      session('week', { last_message_at: local(2026, 10, 12, 0, 0) }),
      session('month', { last_message_at: local(2026, 10, 11, 23, 0) }),
      session('month-edge', { last_message_at: local(2026, 9, 19, 0, 0) }),
      session('older', { last_message_at: local(2026, 9, 18, 23, 59) }),
      session('no-time'),
    ]
    const groups = groupSessionsByDate(sessions, 'activity', now)
    expect(groups.map((g) => [g.id, g.sessions.map((s) => s.id)])).toEqual([
      ['today', ['today-late', 'today-early']],
      ['yesterday', ['yesterday']],
      ['week', ['week']],
      ['month', ['month', 'month-edge']],
      ['older', ['older', 'no-time']],
    ])
    expect(groups.map((g) => g.label)).toEqual(['Today', 'Yesterday', 'Previous 7 days', 'Previous 30 days', 'Older'])
  })

  it('reads the creation time when sorting by created, and drops empty groups', () => {
    const touchedToday = session('s', { created_at: local(2026, 10, 1), last_message_at: local(2026, 10, 19, 8) })
    expect(groupSessionsByDate([touchedToday], 'created', now).map((g) => g.id)).toEqual(['month'])
    expect(groupSessionsByDate([touchedToday], 'activity', now).map((g) => g.id)).toEqual(['today'])
    expect(groupSessionsByDate([], 'activity', now)).toEqual([])
  })

  it('dates activity by the last message, not a later rename', () => {
    const renamed = session('s', { last_message_at: local(2026, 10, 18), updated_at: local(2026, 10, 19, 9) })
    expect(groupSessionsByDate([renamed], 'activity', now).map((g) => g.id)).toEqual(['yesterday'])
  })

  it('falls back to updated_at (an older server), then the creation time', () => {
    const older = session('s', { updated_at: local(2026, 10, 19, 8) })
    expect(groupSessionsByDate([older], 'activity', now).map((g) => g.id)).toEqual(['today'])
    const s = session('s', { created_at: local(2026, 10, 18) })
    expect(groupSessionsByDate([s], 'activity', now).map((g) => g.id)).toEqual(['yesterday'])
  })
})

describe('groupSessionsByStatus', () => {
  it('puts waiting sessions first, then working ones, then the rest without repeats', () => {
    const waiting = session('waiting', { running: true, needs_input: true })
    const working = session('working', { running: true })
    const idle = session('idle')
    const groups = groupSessionsByStatus([working, idle, waiting], [waiting, working])
    expect(groups.map((g) => [g.label, g.sessions.map((s) => s.id)])).toEqual([
      ['Needs you', ['waiting']],
      ['Working', ['working']],
      ['Recent', ['idle']],
    ])
  })

  it('hides empty groups', () => {
    expect(groupSessionsByStatus([session('idle')], []).map((g) => g.id)).toEqual(['recent'])
    expect(groupSessionsByStatus([], [])).toEqual([])
  })
})
