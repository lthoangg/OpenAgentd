import { describe, expect, it } from 'bun:test'
import type { SessionResponse } from '@/api/types'
import { groupSessionsByDate, groupSessionsByStatus, orderWorkspacePaths } from '@/components/Sidebar.helpers'
import type { CodingWorkspaceTreeRepository } from '@/api/types'

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
    const groups = groupSessionsByDate(sessions, now)
    expect(groups.map((g) => [g.id, g.sessions.map((s) => s.id)])).toEqual([
      ['today', ['today-late', 'today-early']],
      ['yesterday', ['yesterday']],
      ['week', ['week']],
      ['month', ['month', 'month-edge']],
      ['older', ['older', 'no-time']],
    ])
    expect(groups.map((g) => g.label)).toEqual(['Today', 'Yesterday', 'Previous 7 days', 'Previous 30 days', 'Older'])
  })

  it('dates by last activity, not creation, and drops empty groups', () => {
    const touchedToday = session('s', { created_at: local(2026, 10, 1), last_message_at: local(2026, 10, 19, 8) })
    expect(groupSessionsByDate([touchedToday], now).map((g) => g.id)).toEqual(['today'])
    expect(groupSessionsByDate([], now)).toEqual([])
  })

  it('dates activity by the last message, not a later rename', () => {
    const renamed = session('s', { last_message_at: local(2026, 10, 18), updated_at: local(2026, 10, 19, 9) })
    expect(groupSessionsByDate([renamed], now).map((g) => g.id)).toEqual(['yesterday'])
  })

  it('falls back to updated_at (an older server), then the creation time', () => {
    const older = session('s', { updated_at: local(2026, 10, 19, 8) })
    expect(groupSessionsByDate([older], now).map((g) => g.id)).toEqual(['today'])
    const s = session('s', { created_at: local(2026, 10, 18) })
    expect(groupSessionsByDate([s], now).map((g) => g.id)).toEqual(['yesterday'])
  })
})

describe('orderWorkspacePaths', () => {
  const repo = (path: string, groupIds: string[] = [], worktrees: string[] = []) =>
    ({ path, group_ids: groupIds, worktrees: worktrees.map((w) => ({ path: w, name: w })) }) as unknown as CodingWorkspaceTreeRepository
  const at = (path: string, time: string) => session(`${path}@${time}`, { workspace: path, last_message_at: time })

  it('puts grouped repositories first, by group then activity, then the rest by activity', () => {
    const repos = [repo('/a'), repo('/b', ['g2']), repo('/c', ['g1']), repo('/d'), repo('/e', ['g1', 'g2'])]
    const byPath = new Map(repos.map((r) => [r.path, r]))
    const sessions = new Map([
      ['/a', [at('/a', '2026-10-01T00:00:00Z')]],
      ['/b', [at('/b', '2026-10-05T00:00:00Z')]],
      ['/c', [at('/c', '2026-10-02T00:00:00Z')]],
      ['/d', [at('/d', '2026-10-09T00:00:00Z')]],
      ['/e', [at('/e', '2026-10-03T00:00:00Z')]],
    ])
    expect(orderWorkspacePaths(repos.map((r) => r.path), byPath, ['g1', 'g2'], sessions))
      .toEqual(['/e', '/c', '/b', '/d', '/a'])
  })

  it('counts worktree sessions and keeps tree order for repositories with none loaded', () => {
    const repos = [repo('/x'), repo('/y'), repo('/z', [], ['/z-wt'])]
    const byPath = new Map(repos.map((r) => [r.path, r]))
    const sessions = new Map([['/z-wt', [at('/z-wt', '2026-10-09T00:00:00Z')]]])
    expect(orderWorkspacePaths(repos.map((r) => r.path), byPath, [], sessions)).toEqual(['/z', '/x', '/y'])
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
