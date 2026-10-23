import { describe, expect, it } from 'bun:test'
import type { SessionResponse } from '@/api/types'
import { sessionStatus } from '@/components/Sidebar/SessionStatusMark'

const session = (fields: Partial<SessionResponse> = {}): SessionResponse => ({
  id: 's', title: 's', agent_name: 'lead', created_at: null, updated_at: null, ...fields,
})

describe('sessionStatus', () => {
  it('reads running, not unread, while a subagent still works after the lead turn ended', () => {
    const lead = session({ running: false, subagents: [session({ id: 'c', running: true })] })
    expect(sessionStatus(lead, true)).toBe('running')
  })

  it('reads unread once every subagent is done', () => {
    const lead = session({ running: false, subagents: [session({ id: 'c', running: false })] })
    expect(sessionStatus(lead, true)).toBe('unread')
  })

  it('still puts a question to the user first', () => {
    const lead = session({ running: true, needs_input: true, subagents: [session({ id: 'c', running: true })] })
    expect(sessionStatus(lead, false)).toBe('needs_input')
  })
})
