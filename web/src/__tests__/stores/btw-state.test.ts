import { describe, expect, it } from 'bun:test'
import { IllegalTransition } from '@/lib/machine'
import { btwAnswerMachine, streamingAnswer, type BtwAnswerEvent, type BtwLive } from '@/stores/btw-state'

const STREAMING = streamingAnswer('which file?')
const DONE: BtwLive = { kind: 'done', id: 'q', question: 'q', text: 'a' }
const STOPPED: BtwLive = { kind: 'stopped', id: 'q', question: 'q', text: 'a' }
const FAILED: BtwLive = { kind: 'error', id: 'q', question: 'q', text: 'a', error: 'boom' }
const EVENTS: BtwAnswerEvent[] = [
  { type: 'start', id: 'q' },
  { type: 'delta', text: 'x' },
  { type: 'done', answer: 'all' },
  { type: 'ended', status: 'error', message: 'm', answer: 'p' },
  { type: 'failed', message: 'm' },
  { type: 'stop' },
]

describe('btw answer', () => {
  it('rejects every move the table does not list', () => {
    const listed = new Set(btwAnswerMachine.moves().map(([s, e]) => `${s}/${e}`))
    let rejected = 0
    for (const state of [STREAMING, DONE, STOPPED, FAILED]) {
      for (const event of EVENTS) {
        if (listed.has(`${state.kind}/${event.type}`)) continue
        expect(() => btwAnswerMachine.transition(state, event)).toThrow(IllegalTransition)
        rejected++
      }
    }
    // A delta, a done, an end or a restart after the answer ended.
    expect(rejected).toBe(12)
  })

  it('keeps an ended answer as it ended through a late stop or a broken stream', () => {
    for (const ended of [DONE, STOPPED, FAILED]) {
      expect(btwAnswerMachine.transition(ended, { type: 'stop' })).toBe(ended)
      expect(btwAnswerMachine.transition(ended, { type: 'failed', message: 'socket' })).toBe(ended)
    }
  })

  it('ends once, with what was written so far', () => {
    const typed = btwAnswerMachine.transition(btwAnswerMachine.transition(STREAMING, { type: 'start', id: 'q' }), { type: 'delta', text: 'Par' })
    expect(btwAnswerMachine.transition(typed, { type: 'ended', status: 'stopped', message: 'Stopped.', answer: 'Par' }))
      .toEqual({ kind: 'stopped', id: 'q', question: 'which file?', text: 'Par' })
    expect(btwAnswerMachine.transition(typed, { type: 'stop' })).toEqual({ kind: 'stopped', id: 'q', question: 'which file?', text: 'Par' })
  })
})
