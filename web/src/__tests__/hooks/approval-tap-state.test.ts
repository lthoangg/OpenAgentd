import { describe, expect, it } from 'bun:test'
import type { PendingRow } from '@/api/phone-cloud'
import { NO_TAP, approvalTapMachine, type ApprovalTap, type ApprovalTapEvent } from '@/hooks/approval-tap-state'
import { IllegalTransition } from '@/lib/machine'

const ROW = { id: 'r1' } as unknown as PendingRow
const STATES: ApprovalTap[] = [NO_TAP, { kind: 'tapped' }, { kind: 'reviewing', row: ROW }]
const EVENTS: ApprovalTapEvent[] = [{ type: 'tap' }, { type: 'drop' }, { type: 'found', row: ROW }, { type: 'close' }]

describe('join approval', () => {
  it('rejects every move the table does not list', () => {
    const listed = new Set(approvalTapMachine.moves().map(([s, e]) => `${s}/${e}`))
    let rejected = 0
    for (const state of STATES) {
      for (const event of EVENTS) {
        if (listed.has(`${state.kind}/${event.type}`)) continue
        expect(() => approvalTapMachine.transition(state, event)).toThrow(IllegalTransition)
        rejected++
      }
    }
    expect(rejected).toBe(6)
  })

  it('opens no sheet for a tap that was dropped', () => {
    const dropped = approvalTapMachine.transition(approvalTapMachine.transition(NO_TAP, { type: 'tap' }), { type: 'drop' })
    expect(dropped).toEqual(NO_TAP)
    expect(() => approvalTapMachine.transition(dropped, { type: 'found', row: ROW })).toThrow(IllegalTransition)
  })

  it('keeps the open sheet on its request through another tap', () => {
    const reviewing: ApprovalTap = { kind: 'reviewing', row: ROW }
    expect(approvalTapMachine.transition(reviewing, { type: 'tap' })).toBe(reviewing)
  })
})
