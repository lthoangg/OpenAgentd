import { describe, expect, it } from 'bun:test'
import { IllegalTransition } from '@/lib/machine'
import { UPDATE_IDLE, serverUpdateMachine, type ServerUpdateEvent, type ServerUpdatePhase } from '@/stores/server-update-state'

const STATES: ServerUpdatePhase[] = [
  UPDATE_IDLE,
  { kind: 'starting' },
  { kind: 'updating', from: '3.50.0', target: '3.51.0' },
  { kind: 'done', from: '3.50.0', to: '3.51.0' },
  { kind: 'failed', message: 'no' },
]
const EVENTS: ServerUpdateEvent[] = [
  { type: 'start' },
  { type: 'accepted', from: '3.50.0', target: '3.51.0' },
  { type: 'finished', to: '3.51.0' },
  { type: 'failed', message: 'no' },
  { type: 'reset' },
]

describe('server update', () => {
  it('rejects every move the table does not list', () => {
    const listed = new Set(serverUpdateMachine.moves().map(([s, e]) => `${s}/${e}`))
    for (const state of STATES) {
      for (const event of EVENTS) {
        if (listed.has(`${state.kind}/${event.type}`)) continue
        expect(() => serverUpdateMachine.transition(state, event)).toThrow(IllegalTransition)
      }
    }
  })

  it('takes no second start while one runs', () => {
    expect(serverUpdateMachine.can({ kind: 'starting' }, { type: 'start' })).toBe(false)
    expect(serverUpdateMachine.can({ kind: 'updating', from: 'a', target: 'b' }, { type: 'start' })).toBe(false)
    expect(serverUpdateMachine.can({ kind: 'failed', message: 'x' }, { type: 'start' })).toBe(true)
  })

  it('finishes from the version it started on', () => {
    const updating = serverUpdateMachine.transition({ kind: 'starting' }, { type: 'accepted', from: '3.50.0', target: '3.51.0' })
    expect(serverUpdateMachine.transition(updating, { type: 'finished', to: '3.52.0' })).toEqual({ kind: 'done', from: '3.50.0', to: '3.52.0' })
  })
})
