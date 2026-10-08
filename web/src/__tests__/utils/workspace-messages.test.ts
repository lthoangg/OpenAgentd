import { describe, expect, it } from 'bun:test'
import { replyFrom, replyLabel, sentFrom } from '@/utils/workspace-messages'

describe('workspace message parsers', () => {
  it('reads sent_from', () => {
    expect(sentFrom({ sent_from: { session_id: 's1', workspace: '/r/app', workspace_name: 'app', session_title: 'Orders', reply: true, hops: 1 } })).toEqual({
      sessionId: 's1',
      workspace: '/r/app',
      workspaceName: 'app',
      sessionTitle: 'Orders',
      reply: true,
    })
    expect(sentFrom({ sent_from: { session_id: 's1', workspace: '/r/app/' } })?.workspaceName).toBe('app')
    expect(sentFrom({ sent_from: { workspace: '/r/app' } })).toBeNull()
    expect(sentFrom(undefined)).toBeNull()
    expect(sentFrom({ sent_from: 'nope' })).toBeNull()
  })

  it('reads reply_from and labels it by status', () => {
    const done = replyFrom({ from_agent: 'infra', reply_from: { session_id: 's2', workspace: '/r/infra', workspace_name: 'infra', status: 'completed' } })
    expect(done).toEqual({ sessionId: 's2', workspace: '/r/infra', workspaceName: 'infra', status: 'completed' })
    expect(replyLabel(done!)).toBe('Workspace reply')
    expect(replyLabel(replyFrom({ reply_from: { session_id: 's2', status: 'error' } })!)).toBe('Workspace update · failed')
    expect(replyLabel(replyFrom({ reply_from: { session_id: 's2', status: 'stopped' } })!)).toBe('Workspace update · stopped')
    expect(replyFrom({ from_agent: 'explorer#1' })).toBeNull()
  })
})
