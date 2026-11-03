import { describe, expect, it } from 'bun:test'
import { fromLead, isLeadMessage } from '@/utils/lead-messages'

describe('lead messages', () => {
  it('reads the tag, and strips either prefix from the text', () => {
    expect(fromLead({ from_lead: { session_id: 'lead-1' } }, '[Task from Lead]: Do it.')).toEqual({ sessionId: 'lead-1', content: 'Do it.' })
    expect(fromLead({ from_lead: { session_id: 'lead-1' } }, '[Lead]: Next.')).toEqual({ sessionId: 'lead-1', content: 'Next.' })
  })

  it('keeps the text of a tagged row that has no prefix', () => {
    expect(fromLead({ from_lead: { session_id: 'lead-1' } }, 'Plain.')).toEqual({ sessionId: 'lead-1', content: 'Plain.' })
  })

  it('takes an untagged prefixed row for the lead\'s only when the session has a parent', () => {
    expect(fromLead(undefined, '[Lead]: Next.', 'parent-1')).toEqual({ sessionId: 'parent-1', content: 'Next.' })
    expect(fromLead(undefined, '[Task from Lead]: Go.', 'parent-1')).toEqual({ sessionId: 'parent-1', content: 'Go.' })
    expect(fromLead(undefined, '[Lead]: Next.')).toBeNull()
    expect(fromLead(undefined, '[Lead]: Next.', null)).toBeNull()
  })

  it('ignores ordinary text and a malformed tag', () => {
    expect(fromLead(undefined, 'hello', 'parent-1')).toBeNull()
    expect(fromLead({ from_lead: 'nope' }, 'hello', 'parent-1')).toBeNull()
    expect(fromLead({ from_lead: { session_id: '' } }, 'hello', 'parent-1')).toBeNull()
    expect(fromLead(undefined, 'see [Lead]: inline', 'parent-1')).toBeNull()
  })

  it('tells a lead row from other blocks', () => {
    expect(isLeadMessage({ type: 'user', content: '[Lead]: x' }, 'p')).toBe(true)
    expect(isLeadMessage({ type: 'text', content: '[Lead]: x' }, 'p')).toBe(false)
  })
})
