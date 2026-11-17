import { describe, expect, it } from 'bun:test'
import { FOLLOWING, followMachine, followsEnd, type FollowEvent, type FollowMode } from '@/hooks/follow-state'
import { IllegalTransition } from '@/lib/machine'

const STATES: FollowMode[] = [{ kind: 'following' }, { kind: 'reading' }, { kind: 'settling' }]
const EVENTS: FollowEvent[] = [{ type: 'follow' }, { type: 'leave' }, { type: 'fold' }]

describe('transcript follow', () => {
  it('lists exactly these moves', () => {
    expect(followMachine.moves()).toEqual([
      ['following', 'follow'],
      ['following', 'leave'],
      ['following', 'fold'],
      ['reading', 'follow'],
      ['reading', 'leave'],
      ['settling', 'follow'],
      ['settling', 'leave'],
    ])
  })

  it('rejects every move the table does not list', () => {
    const listed = new Set(followMachine.moves().map(([s, e]) => `${s}/${e}`))
    for (const state of STATES) {
      for (const event of EVENTS) {
        if (listed.has(`${state.kind}/${event.type}`)) continue
        expect(() => followMachine.transition(state, event)).toThrow(IllegalTransition)
      }
    }
  })

  it('a fold that lands resumes following', () => {
    const settling = followMachine.transition(FOLLOWING, { type: 'fold' })
    expect(settling.kind).toBe('settling')
    expect(followsEnd(settling)).toBe(false)
    expect(followsEnd(followMachine.transition(settling, { type: 'follow' }))).toBe(true)
  })

  it('a reader who scrolls up while a fold closes keeps the view', () => {
    const settling = followMachine.transition(FOLLOWING, { type: 'fold' })
    expect(followMachine.transition(settling, { type: 'leave' }).kind).toBe('reading')
  })
})
