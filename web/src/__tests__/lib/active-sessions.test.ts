import { describe, expect, it } from 'bun:test'
import type { SessionResponse } from '@/api/types'
import { needsYouSessions, sessionWorking, sessionsSpending } from '@/lib/active-sessions'

function session(overrides: Partial<SessionResponse>): SessionResponse {
  return { id: 's', title: null, agent_name: 'lead', created_at: null, updated_at: null, workspace: '/w', ...overrides }
}

describe('needsYouSessions', () => {
  it('keeps only top-level sessions waiting on the user', () => {
    const rows = [
      session({ id: 'ask', running: true, needs_input: true }),
      // An older server ignores ``active`` and sends a normal page.
      session({ id: 'busy', running: true }),
      session({ id: 'idle' }),
      session({ id: 'child', needs_input: true, parent_session_id: 'lead' }),
    ]

    const kept = needsYouSessions({ pages: [{ data: rows, next_cursor: null, has_more: false }], pageParams: [null] })

    expect(kept.map((s) => s.id)).toEqual(['ask'])
  })

  it('is empty before the list loads', () => {
    expect(needsYouSessions(undefined)).toEqual([])
  })
})

describe('sessionWorking', () => {
  it('counts a lead whose turn ended while a subagent still works', () => {
    expect(sessionWorking(session({ running: true }))).toBe(true)
    expect(sessionWorking(session({ running: false, subagents: [session({ id: 'c', running: true })] }))).toBe(true)
  })

  it('does not count subagents that finished or wait on their lead', () => {
    const done = session({ id: 'done', running: false })
    const asking = session({ id: 'asking', running: true, needs_input: true })
    expect(sessionWorking(session({ running: false, subagents: [done, asking] }))).toBe(false)
    expect(sessionWorking(session({}))).toBe(false)
  })
})

describe('sessionsSpending', () => {
  const page = (rows: SessionResponse[]) => ({ pages: [{ data: rows, next_cursor: null, has_more: false }], pageParams: [null] })

  it('counts a subagent working under an idle lead', () => {
    expect(sessionsSpending(page([session({ running: false, subagents: [session({ id: 'c', running: true })] })]))).toBe(true)
  })

  it('does not count sessions waiting on the user or a lead', () => {
    const asking = session({ id: 'c', running: true, needs_input: true })
    expect(sessionsSpending(page([session({ running: true, needs_input: true, subagents: [asking] })]))).toBe(false)
  })
})
