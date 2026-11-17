import { describe, expect, it } from 'bun:test'
import { DRAFTING, IN_CHAT, handoffMachine, type HandoffEvent, type HandoffState } from '@/components/AgentChatView/handoff-state'
import { IllegalTransition } from '@/lib/machine'

const STATES: HandoffState[] = [DRAFTING, { kind: 'playing', snapshot: null }, IN_CHAT]
const EVENTS: HandoffEvent[] = [{ type: 'leave', play: true, snapshot: null }, { type: 'enter' }, { type: 'settle' }]

describe('draft handoff', () => {
  it('lists exactly these moves', () => {
    expect(handoffMachine.moves()).toEqual([
      ['drafting', 'leave'],
      ['playing', 'settle'],
      ['playing', 'enter'],
      ['chat', 'enter'],
    ])
  })

  it('rejects every move the table does not list', () => {
    const listed = new Set(handoffMachine.moves().map(([s, e]) => `${s}/${e}`))
    for (const state of STATES) {
      for (const event of EVENTS) {
        if (listed.has(`${state.kind}/${event.type}`)) continue
        expect(() => handoffMachine.transition(state, event)).toThrow(IllegalTransition)
      }
    }
  })

  it('plays only a draft left by its first message', () => {
    expect(handoffMachine.transition(DRAFTING, { type: 'leave', play: false, snapshot: null })).toEqual(IN_CHAT)
    expect(handoffMachine.transition(DRAFTING, { type: 'leave', play: true, snapshot: null }).kind).toBe('playing')
  })
})
