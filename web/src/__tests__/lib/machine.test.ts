import { afterEach, describe, expect, it, mock } from 'bun:test'
import { defineMachine, IllegalTransition, setStrictMachines } from '@/lib/machine'

type Door = { kind: 'open' } | { kind: 'closed' } | { kind: 'locked'; key: number }
type DoorEvent = { type: 'close' } | { type: 'open' } | { type: 'lock'; key: number } | { type: 'unlock'; key: number }

const door = defineMachine<Door, DoorEvent>('door', {
  open: { close: () => ({ kind: 'closed' }) },
  closed: { open: () => ({ kind: 'open' }), lock: (_, e) => ({ kind: 'locked', key: e.key }) },
  // The wrong key leaves it locked: a listed move that changes nothing.
  locked: { unlock: (s, e) => (e.key === s.key ? { kind: 'closed' } : s) },
})

afterEach(() => setStrictMachines(true))

describe('defineMachine', () => {
  it('makes a listed move, with the event data', () => {
    expect(door.transition({ kind: 'closed' }, { type: 'lock', key: 7 })).toEqual({ kind: 'locked', key: 7 })
  })

  it('throws on an illegal move under test, naming the machine, state and event', () => {
    expect(() => door.transition({ kind: 'open' }, { type: 'lock', key: 1 })).toThrow(new IllegalTransition('door', 'open', 'lock'))
  })

  it('outside tests keeps the state and logs the illegal move', () => {
    setStrictMachines(false)
    const warn = mock(() => {})
    const real = console.warn
    console.warn = warn
    try {
      const open = { kind: 'open' } as const
      expect(door.transition(open, { type: 'lock', key: 1 })).toBe(open)
      expect(warn).toHaveBeenCalledWith('illegal_transition', { machine: 'door', from: 'open', event: 'lock' })
    } finally {
      console.warn = real
    }
  })

  it('says whether a move is allowed, and lists the table', () => {
    expect(door.can({ kind: 'closed' }, { type: 'lock', key: 1 })).toBe(true)
    expect(door.can({ kind: 'open' }, { type: 'lock', key: 1 })).toBe(false)
    expect(door.moves()).toEqual([['open', 'close'], ['closed', 'open'], ['closed', 'lock'], ['locked', 'unlock']])
  })
})
